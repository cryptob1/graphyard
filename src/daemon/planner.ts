// Concern: the planner role (GY-1418) — a goal whose acceptance pull request merged is planned headless
// into a short architecture note and a dependency-ordered set of work items with file boundaries, the
// plan is judged headless by the approver identity (never its author), and only then are its items
// created and released; the goal is delivered once every item is done and production serves it.
import { z } from 'zod';
import type { Goal } from '../model/goal.js';
import { goalPlanSchema, maxPlanRounds, planNoteMaxWords, planRefusals, type GoalPlan } from '../model/goal-plan.js';
import { deliveryState } from '../model/delivery.js';
import type { Work } from '../model/work.js';
import { agentToken } from '../master/autonomy.js';
import { capacityRefusal, selectFleetSession } from '../fleet.js';
import { Refusal, RefusedResponse } from '../model/refusal.js';
import type { MasterConfig } from '../master.js';
import { diagnosticianSettings, type DiagnosticianSettings } from '../runner/payloads.js';
import { piRunner } from '../runner/pi.js';
import { registryHeadlessLaunch, registryRunner } from '../runner/roles.js';
import type { Runner } from '../runner/types.js';
import { type DaemonAction, message } from './state.js';
import { record } from './effects.js';
import { detailChanged } from './decisions.js';
import type { Cycle } from './cycle.js';

export const plannerRole = 'planner';
export const planTool = 'graphyard_plan';
/** The judgement run's Pi role and tool: the approver identity's verdict on one plan. */
export const planJudgeRole = 'plan-judge';
export const planJudgementTool = 'graphyard_plan_judgement';
/** A run that returned nothing, or a plan refused before approval, is tried again after this long: each try is a paid model run. */
export const planRetryMs = 60 * 60_000;
/** A step that only talks to the control plane (post, release, deliver) is retried after this long, reusing the run's result. */
export const planStepRetryMs = 10 * 60_000;
/** A released goal's items are read for delivery, and a full role's run deferred, at most this often per goal. */
export const planPollMs = 5 * 60_000;
export const planPayloadSchema = z.object({ goal: z.string().min(1).max(40), note: z.unknown(), items: z.unknown() }).strict()
  .transform(({ goal, note, items }) => ({ goal, ...goalPlanSchema.parse({ note, items }) }));
export const planJudgementSchema = z.object({ goal: z.string().min(1).max(40), verdict: z.enum(['approve', 'refuse']), reason: z.string().trim().min(1).max(2000) }).strict();
export type PlanJudgement = z.infer<typeof planJudgementSchema>;

export interface PlannerRun { runner: Runner; runtime: string; model: string; release?: (reason: string) => Promise<unknown> }
export interface PlannerEffects {
  settings: Pick<DiagnosticianSettings, 'enabled' | 'model' | 'fallbackModel' | 'timeoutMinutes'>;
  cwd: string;
  goals: () => Promise<Goal[]>;
  /** The plan runs on the planner role's accounts; the judgement on the approver role's. */
  runner: (role: 'plan' | 'judge', attempt: 'primary' | 'fallback', goal: Goal) => Promise<PlannerRun>;
  /** Post the plan as the master's operator-agent identity: its author. */
  plan: (goal: Goal, plan: GoalPlan) => Promise<Goal>;
  /** Post the verdict as the approver identity, which never authored a plan. */
  judge: (goal: Goal, judgement: PlanJudgement) => Promise<Goal>;
  /** Ask the control plane to create and release the approved plan's items in dependency order (POST /api/goals/:key/release). */
  release: (goal: Goal) => Promise<Goal>;
  /** Record the goal delivered, naming every item of its plan (POST /api/goals/:key/deliver); the control plane checks each is done and served. */
  deliver: (goal: Goal, items: string[], reason: string) => Promise<Goal>;
}

/** A finished run, kept until it is posted; `deferred` names the full role no run started on. */
interface Pending { revision: number; plan?: GoalPlan | null; judgement?: PlanJudgement | null; runs: string[]; deferred?: string }
const live = new Map<string, Promise<void>>();
const pending = new Map<string, Pending>();
/** When each goal's next try of a step may run: `${goal.id}:${step}`. */
const retryAt = new Map<string, number>();
/** The last plan refused before approval, per goal, so the next run answers it. */
const refusedPlans = new Map<string, string>();
export async function plansSettled() { await Promise.all([...live.values()]); }
export function clearPlans() { for (const store of [live, pending, retryAt, refusedPlans]) store.clear(); }

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
type Note = (goal: Goal, outcome: DaemonAction['state'], detail: string) => Promise<void>;

export function plannerPrompt(config: { repository: string }, goal: Goal, lastRefusal: string | null) {
  const input = { goal: goal.key, statement: goal.statement, users: goal.users, constraints: goal.constraints, deployTarget: goal.deployTarget,
    outcomes: (goal.acceptance?.outcomes ?? []).map(outcome => ({ id: outcome.id, title: outcome.title, criteria: outcome.criteria, case: outcome.case.id })),
    lastRefusal: lastRefusal ?? (goal.planRefusal ? `${goal.planRefusal.by}: ${goal.planRefusal.reason}` : null) };
  return `You are the Graphyard planner (architect) for ${config.repository}. The goal below has approved customer outcomes, each proved by a required uat case that is already merged and protected. Plan how to build it. `
    + 'This session is read-only: never edit, commit, push, claim or decide anything, and never ask anyone anything. Read the repository to learn its stack and module layout. '
    + `Then call the ${planTool} tool exactly once with goal "${goal.key}", a note of at most ${planNoteMaxWords} words (stack, module layout, data and deploy approach), and items: `
    + 'each item a ref (lower-case letters, digits and -), a title, a description, the outcome ids it serves, the case ids it must make pass (at least the case of every outcome it serves), '
    + 'criteria (AC-1, AC-2, ... each with text and unit:, integration: or manual: proofs), the plannedFiles it changes, and dependsOn naming the refs it must land after. '
    + 'Every outcome is served by at least one item. Items that may run in parallel (neither depends on the other) share no planned file: make one depend on the other or split the files. '
    + 'No item plans a change to a required case or e2e/contract.json. Answer any refusal of the last plan. Stop after the call.\n\n'
    + `The goal, as JSON:\n${clip(JSON.stringify(input), 50_000)}`;
}

export function planJudgementPrompt(config: { repository: string }, goal: Goal) {
  const input = { goal: goal.key, statement: goal.statement, constraints: goal.constraints, deployTarget: goal.deployTarget,
    outcomes: (goal.acceptance?.outcomes ?? []).map(outcome => ({ id: outcome.id, title: outcome.title, case: outcome.case.id })), author: goal.plan!.author, note: goal.plan!.note, items: goal.plan!.items };
  return `You are the independent approver of a plan for ${config.repository}. You did not write it. Judge whether it delivers the goal's approved outcomes sensibly before any item is created. `
    + 'This session is read-only: never edit, commit, push, claim or decide anything, and never ask anyone anything. '
    + 'Approve only when the architecture note fits the repository and the goal\'s constraints, every item is small enough for one worker, its criteria and proofs show its cases pass, and the dependencies order the work so parallel items never collide. Otherwise refuse, naming what the next plan must change. '
    + `Call the ${planJudgementTool} tool exactly once with goal "${goal.key}", verdict "approve" or "refuse", and your reason. Stop after the call.\n\n`
    + `The goal and its plan, as JSON:\n${clip(JSON.stringify(input), 80_000)}`;
}

/** One headless run, primary then fallback, as the acceptance role runs (GY-1417); a registry role at its concurrency defers the goal instead of starting a fallback. */
async function runHeadless<T>(planner: PlannerEffects, role: 'plan' | 'judge', goal: Goal, prompt: string, validate: (payload: unknown) => T): Promise<{ payload: T | null; runs: string[]; deferred?: string }> {
  const runs: string[] = [];
  const [env, tool] = role === 'plan' ? [plannerRole, planTool] : [planJudgeRole, planJudgementTool];
  for (const attempt of ['primary', 'fallback'] as const) {
    let chosen: PlannerRun;
    try { chosen = await planner.runner(role, attempt, goal); } catch (error) {
      const full = capacityRefusal(error);
      if (full) return { payload: null, runs, deferred: `${full}: ${clip(message(error), 300)}` };
      runs.push(`no ${attempt} runner: ${message(error)}`); continue;
    }
    const run = chosen.runner.start(prompt, { cwd: planner.cwd, env: { GRAPHYARD_PI_ROLE: env }, tool, timeoutMs: planner.settings.timeoutMinutes * 60_000, validate });
    const result = await run.result();
    await Promise.resolve(chosen.release?.(`the ${attempt} ${role === 'plan' ? 'plan' : 'plan judgement'} of ${goal.key} ended`)).catch(() => {});
    if (result.ok) return { payload: result.payload, runs };
    runs.push(`${chosen.model} ${result.failure.reason}: ${clip(result.failure.detail, 300)}`);
    if (result.failure.reason === 'cancelled') break;
  }
  return { payload: null, runs };
}
const ofGoal = (goal: Goal, parsed: { goal: string }) => { if (parsed.goal !== goal.key) throw new Error(`the answer names ${parsed.goal}, not ${goal.key}`); };
function launch(cycle: Cycle, planner: PlannerEffects, goal: Goal, role: 'plan' | 'judge') {
  const run = role === 'plan'
    ? runHeadless(planner, role, goal, plannerPrompt(cycle.config, goal, refusedPlans.get(goal.id) ?? null), payload => {
      const { goal: named, ...plan } = planPayloadSchema.parse(payload); ofGoal(goal, { goal: named }); return plan;
    }).then(result => ({ revision: goal.revision, plan: result.payload, runs: result.runs, deferred: result.deferred }))
    : runHeadless(planner, role, goal, planJudgementPrompt(cycle.config, goal), payload => { const parsed = planJudgementSchema.parse(payload); ofGoal(goal, parsed); return parsed; })
      .then(result => ({ revision: goal.revision, judgement: result.payload, runs: result.runs, deferred: result.deferred }));
  live.set(goal.id, run.catch(error => ({ revision: goal.revision, [role === 'plan' ? 'plan' : 'judgement']: null, runs: [message(error)] }))
    .then(result => { pending.set(goal.id, result); }).finally(() => live.delete(goal.id)));
}
const due = (cycle: Cycle, goal: Goal, step: string) => cycle.clock >= (retryAt.get(`${goal.id}:${step}`) ?? -Infinity);
const later = (cycle: Cycle, goal: Goal, step: string, ms: number) => { retryAt.set(`${goal.id}:${step}`, cycle.clock + ms); };
const refusedOutright = (error: unknown) => (error instanceof Refusal || error instanceof RefusedResponse) && error.status === 422;
/** An item delivers its goal once it is done and production serves it, as the control plane's deliver route judges it. */
export const servedInProduction = (work: Work | undefined) => !!work && work.stage === 'done' && ['delivered', 'smoke-passed'].includes(deliveryState(work) ?? '');

/**
 * One loop step over every goal past its acceptance (GY-1418). Each goal moves at most one
 * transition a cycle; a run's result is kept until it is posted, so a failed post retries without
 * another model run. The planner runs only for a goal whose acceptance pull request merged: before
 * that the goal is the acceptance role's (src/daemon/acceptance.ts).
 */
export async function plannerStep(cycle: Cycle) {
  const { state, effects, now, performed } = cycle;
  const planner = effects.planner;
  if (!planner?.settings.enabled) return;
  const note: Note = async (goal, outcome, detail) => {
    const key = `planner:${goal.id}`;
    if (!detailChanged(state.actions[key], clip(detail, 1000))) return;
    performed.push(await record(state, key, { kind: 'decision', work: goal.key, principal: null, state: outcome, detail: clip(detail, 1000), attempts: (state.actions[key]?.attempts ?? 0) + (outcome === 'failed' ? 1 : 0), cycle: state.cycle }, now(), effects.persist));
  };
  const goals = await cycle.isolate('decision', null, 'the goals being planned', () => planner.goals());
  for (const goal of goals ?? []) {
    if (!goal.merged) continue;
    await cycle.isolate('decision', null, `the plan of ${goal.key}`, async () => {
      const result = pending.get(goal.id);
      if (result && result.revision !== goal.revision) pending.delete(goal.id);
      if (goal.stage === 'planning') return planning(cycle, planner, goal, note);
      if (goal.stage === 'plan-review') return reviewing(cycle, planner, goal, note);
      if (goal.stage === 'planned') return releasing(cycle, planner, goal, note);
      if (goal.stage === 'delivering') return delivering(cycle, planner, goal, note);
    });
  }
}

function deferred(cycle: Cycle, goal: Goal, result: Pending, step: 'plan' | 'judge', note: Note) {
  pending.delete(goal.id); later(cycle, goal, step, planPollMs);
  return note(goal, 'waiting', `The ${step === 'plan' ? 'planner' : 'approver'} is at its registry capacity (${result.deferred}); ${goal.key}'s ${step === 'plan' ? 'plan' : 'plan judgement'} starts no fallback and is launched again in five minutes`);
}

async function planning(cycle: Cycle, planner: PlannerEffects, goal: Goal, note: Note) {
  if ((goal.planDrafts ?? 0) >= maxPlanRounds)
    return note(goal, 'done', `${goal.key} has had ${goal.planDrafts} plans refused (last: ${clip(goal.planRefusal?.reason ?? 'none recorded', 300)}); the loop plans no more and leaves it to the master`);
  const result = pending.get(goal.id);
  if (result && 'plan' in result) {
    if (!result.plan && result.deferred) return deferred(cycle, goal, result, 'plan', note);
    if (!result.plan) {
      pending.delete(goal.id); later(cycle, goal, 'plan', planRetryMs);
      return note(goal, 'failed', `The planner returned no plan for ${goal.key}: ${result.runs.join('; ')}; it is planned again in an hour`);
    }
    // Refused with its reasons before any approver sees it; the next run is told why.
    const refusals = planRefusals(goal, result.plan);
    const refuse = (reason: string) => {
      pending.delete(goal.id); later(cycle, goal, 'plan', planRetryMs); refusedPlans.set(goal.id, reason);
      return note(goal, 'failed', `The planner's plan for ${goal.key} was refused before approval: ${reason}; it is planned again in an hour, answering that`);
    };
    if (refusals.length) return refuse(refusals.join('; '));
    if (!due(cycle, goal, 'post')) return;
    try { await planner.plan(goal, result.plan); }
    catch (error) {
      if (refusedOutright(error)) return refuse(message(error));
      later(cycle, goal, 'post', planStepRetryMs); return note(goal, 'failed', `The plan for ${goal.key} could not be recorded: ${message(error)}; it is posted again in ten minutes`);
    }
    pending.delete(goal.id); refusedPlans.delete(goal.id);
    return note(goal, 'done', `Recorded ${goal.key}'s plan: ${result.plan.items.map(item => `${item.ref}${item.dependsOn.length ? ` after ${item.dependsOn.join(', ')}` : ''}`).join('; ')}; it awaits an approver other than its author`);
  }
  if (live.has(goal.id) || !due(cycle, goal, 'plan')) return;
  launch(cycle, planner, goal, 'plan');
  await note(goal, 'done', `Launched the planner for ${goal.key} (plan ${(goal.planDrafts ?? 0) + 1} of at most ${maxPlanRounds}) on ${planner.settings.model}, falling back to ${planner.settings.fallbackModel}`);
}

async function reviewing(cycle: Cycle, planner: PlannerEffects, goal: Goal, note: Note) {
  const result = pending.get(goal.id);
  if (result && 'judgement' in result) {
    if (!result.judgement && result.deferred) return deferred(cycle, goal, result, 'judge', note);
    if (!result.judgement) {
      pending.delete(goal.id); later(cycle, goal, 'judge', planRetryMs);
      return note(goal, 'failed', `The approver returned no judgement on ${goal.key}'s plan: ${result.runs.join('; ')}; it is judged again in an hour`);
    }
    if (!due(cycle, goal, 'verdict')) return;
    try { await planner.judge(goal, result.judgement); }
    catch (error) { later(cycle, goal, 'verdict', planStepRetryMs); return note(goal, 'failed', `The approver's ${result.judgement.verdict} of ${goal.key}'s plan could not be recorded: ${message(error)}; it is posted again in ten minutes`); }
    pending.delete(goal.id);
    return note(goal, 'done', `The approver ${result.judgement.verdict === 'approve' ? 'approved' : 'refused'} ${goal.key}'s plan: ${clip(result.judgement.reason, 600)}`);
  }
  if (live.has(goal.id) || !due(cycle, goal, 'judge')) return;
  launch(cycle, planner, goal, 'judge');
  await note(goal, 'done', `Launched the approver's judgement of ${goal.key}'s plan, written by ${goal.plan!.author}`);
}

/** An approved plan's items are created and released by the control plane, in dependency order; nothing is created before the approval. */
async function releasing(cycle: Cycle, planner: PlannerEffects, goal: Goal, note: Note) {
  if (!due(cycle, goal, 'release')) return;
  let released: Goal;
  try { released = await planner.release(goal); }
  catch (error) { later(cycle, goal, 'release', planStepRetryMs); return note(goal, 'failed', `Could not release ${goal.key}'s approved plan: ${message(error)}; it is asked again in ten minutes, reusing the items already created`); }
  return note(goal, 'done', `Released ${goal.key}'s approved plan: ${(released.items ?? []).map(item => item.key).join(', ')}; the dispatcher launches each only after the items it depends on are delivered`);
}

/** Delivered once every item of the plan is done and production serves it, read at most once per poll interval. */
async function delivering(cycle: Cycle, planner: PlannerEffects, goal: Goal, note: Note) {
  const items = goal.items ?? [];
  if (!items.length || !due(cycle, goal, 'deliver')) return;
  later(cycle, goal, 'deliver', planPollMs);
  const waiting = items.filter(item => !servedInProduction(cycle.snapshot.work.find(work => work.key === item.key)));
  if (waiting.length) return note(goal, 'waiting', `${goal.key} is delivering: ${waiting.map(item => item.key).join(', ')} ${waiting.length === 1 ? 'is' : 'are'} not yet done and served by production`);
  try { await planner.deliver(goal, items.map(item => item.key), `Every item of ${goal.key}'s plan is done and served by production`); }
  catch (error) { return note(goal, 'failed', `Could not record ${goal.key} delivered: ${message(error)}; it is asked again in five minutes`); }
  return note(goal, 'done', `${goal.key} is delivered: ${items.map(item => item.key).join(', ')} are done and served by production`);
}

interface Calls {
  fetcher: typeof fetch;
  asCoordinator: (path: string) => Promise<any>;
  asOperatorAgent: (method: 'GET' | 'POST', path: string, body?: unknown, key?: string) => Promise<any>;
}
/**
 * The planner's effects under the live configuration: runners as the acceptance role's (the
 * registry's planner or approver role when an operator defines one, else Pi on `run.diagnostician`'s
 * models), plans posted as the master's operator-agent identity and verdicts as the approver
 * identity, so the author of a plan never judges it.
 */
export function plannerEffects(config: MasterConfig, root: string, calls: Calls): PlannerEffects {
  const settings = { ...diagnosticianSettings(config.run), enabled: true };
  const asApprover = async (path: string, body: unknown, key: string) => {
    const response = await calls.fetcher(`${config.url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${await agentToken(root, config, 'approver')}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    if (!response.ok) throw new RefusedResponse(`Graphyard refused ${path} (${response.status}): ${result?.error ?? JSON.stringify(result)}`, response.status, result);
    return result;
  };
  return {
    settings, cwd: root,
    goals: async () => (await calls.asCoordinator('goals?open=1')).goals,
    runner: async (role, attempt, goal) => {
      if (attempt === 'primary') {
        const [name, principal] = role === 'plan' ? [plannerRole, config.operatorAgent!.id] as const : ['approver', config.approver!.id] as const;
        const fleet = await selectFleetSession(config, name, { name, principal }, { work: goal.key });
        if (fleet) { const launched = registryHeadlessLaunch(fleet.account); return { runner: registryRunner(fleet.account), runtime: launched.command, model: launched.model, release: fleet.release }; }
      }
      const model = attempt === 'primary' ? settings.model : settings.fallbackModel;
      return { runner: piRunner({ command: settings.command, model }), runtime: 'pi', model };
    },
    plan: (goal, plan) => calls.asOperatorAgent('POST', `goals/${goal.key}/plan`, plan, `planner:${goal.id}:${goal.revision}`),
    judge: (goal, judgement) => asApprover(`goals/${goal.key}/plan-${judgement.verdict}`, { reason: judgement.reason }, `planner:${goal.id}:${goal.revision}:judged`),
    release: goal => calls.asOperatorAgent('POST', `goals/${goal.key}/release`, {}, `planner:${goal.id}:${goal.revision}:release:${Date.now()}`),
    deliver: (goal, items, reason) => calls.asOperatorAgent('POST', `goals/${goal.key}/deliver`, { items, reason }, `planner:${goal.id}:${goal.revision}:deliver`),
  };
}
