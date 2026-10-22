// Concern: the planner role (GY-1418) — a goal whose acceptance pull request merged is planned headless
// into a short architecture note and a dependency-ordered set of work items with file boundaries, its
// items are created and released at once, and the goal is delivered once every item is merged.
import { z } from 'zod';
import type { Goal } from '../model/goal.js';
import { goalPlanSchema, maxPlanRounds, planNoteMaxWords, planRefusals, mergedItem, type GoalPlan } from '../model/goal-plan.js';
import { capacityRefusal, selectFleetSession } from '../fleet.js';
import { heldAwareProbe } from '../master/environments.js';
import { Refusal, RefusedResponse } from '../model/refusal.js';
import { refusedOutright } from './acceptance.js';
import { simplicityParagraph } from '../reviewer.js';
/** A plan the control plane rejects as input (422): it counts as a refused plan round. Authority and state refusals (401, 403, 409) do not, and are posted again in an hour. */
const invalidPlan = (error: unknown) => (error instanceof Refusal || error instanceof RefusedResponse) && error.status === 422;
import type { MasterConfig } from '../master.js';
import { diagnosticianSettings, type DiagnosticianSettings } from '../runner/payloads.js';
import { piRunner } from '../runner/pi.js';
import { registryHeadlessLaunch, registryRunner } from '../runner/roles.js';
import type { Runner } from '../runner/types.js';
import { type DaemonAction, message } from './state.js';
import { record } from './effects.js';
import { detailChanged } from './text.js';
import type { Cycle } from './cycle.js';
import { carriedIsolate, stepCallCarried } from './step-budget.js';

export const plannerRole = 'planner';
export const planTool = 'graphyard_plan';
/** A run that returned nothing (a timeout, an exit, no payload), or a refused plan, is tried again after this long: each try is a paid model run. A payload plan validation refused feeds its reason back and is tried again in planStepRetryMs (GY-1803). */
export const planRetryMs = 60 * 60_000;
/** A step that only talks to the control plane (post, release, deliver) is retried after this long, reusing the run's result. */
export const planStepRetryMs = 10 * 60_000;
/** A released goal's items are read for delivery, and a full role's run deferred, at most this often per goal. */
export const planPollMs = 5 * 60_000;
export const planPayloadSchema = z.object({ goal: z.string().min(1).max(40), summary: z.unknown(), note: z.unknown(), items: z.unknown() }).strict()
  .transform(({ goal, summary, note, items }) => ({ goal, ...goalPlanSchema.parse({ summary, note, items }) }));

export interface PlannerRun { runner: Runner; runtime: string; model: string; release?: (reason: string) => Promise<unknown> }
export interface PlannerEffects {
  settings: Pick<DiagnosticianSettings, 'enabled' | 'model' | 'fallbackModel' | 'timeoutMinutes'>;
  cwd: string;
  goals: () => Promise<Goal[]>;
  /** The plan runs on the planner role's accounts. */
  runner: (attempt: 'primary' | 'fallback', goal: Goal) => Promise<PlannerRun>;
  /** Post the plan as the master's operator-agent identity: its author. */
  plan: (goal: Goal, plan: GoalPlan) => Promise<Goal>;
  /** Record a refused plan on the goal (POST /api/goals/:key/plan-invalid), so it counts toward maxPlanRounds across restarts. */
  invalid: (goal: Goal, reason: string) => Promise<Goal>;
  /** Ask the control plane to create and release the plan's items in dependency order (POST /api/goals/:key/release). */
  release: (goal: Goal) => Promise<Goal>;
  /** Record the goal delivered, naming every item of its plan (POST /api/goals/:key/deliver); the control plane checks each is merged. */
  deliver: (goal: Goal, items: string[], reason: string) => Promise<Goal>;
}

/** A finished run, kept until it is posted; `deferred` names the full role no run started on. */
interface Pending { revision: number; plan?: GoalPlan | null; runs: string[]; deferred?: string; invalid?: string }
const live = new Map<string, Promise<void>>();
const pending = new Map<string, Pending>();
/** When each goal's next try of a step may run: `${goal.id}:${step}`. */
const retryAt = new Map<string, number>();
export async function plansSettled() { await Promise.all([...live.values()]); }
export function clearPlans() { for (const store of [live, pending, retryAt]) store.clear(); }

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
type Note = (goal: Goal, outcome: DaemonAction['state'], detail: string) => Promise<void>;

export function plannerPrompt(config: { repository: string }, goal: Goal) {
  const input = { goal: goal.key, statement: goal.statement, users: goal.users, constraints: goal.constraints, deployTarget: goal.deployTarget,
    outcomes: (goal.acceptance?.outcomes ?? []).map(outcome => ({ id: outcome.id, title: outcome.title, criteria: outcome.criteria, case: outcome.case.id })),
    lastRefusal: goal.planRefusal ? `${goal.planRefusal.by}: ${goal.planRefusal.reason}` : null };
  return `You are the Graphyard planner (architect) for ${config.repository}. The goal below has customer outcomes, each proved by a required uat case that is already merged and protected. Plan how to build it. `
    + 'This session is read-only: never edit, commit, push, claim or decide anything, and never ask anyone anything. Read the repository to learn its stack and module layout. '
    + simplicityParagraph
    + `Then call the ${planTool} tool exactly once with goal "${goal.key}", a summary of at most 3 plain sentences (what the user gets and how it will be built; no file paths, commit shas or internal terms), a note of at most ${planNoteMaxWords} words (stack, module layout, data and deploy approach), and items: `
    + 'each item a ref (lower-case letters, digits and -), a title, a plain one-sentence description a non-engineer understands, a description, the outcome ids it serves, the case ids it must make pass (at least the case of every outcome it serves), '
    + 'criteria (AC-1, AC-2, ... each id once, each with text and unit:, integration: or manual: proofs), and dependsOn naming the refs it must land after. '
    + 'Every outcome is served by at least one item. '
    + 'A criterion observed on the serving release — production, the deployed release, the restarted loop: an outcome no head can show before merge — must name a manual:post-deploy/NAME proof on the item that ships the change (the reviewer judges it on that head\'s pre-merge evidence, and the serving release is checked after), beside at least one criterion with a unit:, integration: or manual: proof a head can show before merge: no item may consist of post-deploy criteria alone. '
    + 'No item plans a change to a required case or e2e/contract.json. Answer any refusal of the last plan. Stop after the call.\n\n'
    + `The goal, as JSON:\n${clip(JSON.stringify(input), 50_000)}`;
}

/** One headless run, primary then fallback, as the acceptance role runs (GY-1417); a registry role at its concurrency defers the goal instead of starting a fallback. */
async function runHeadless<T>(planner: PlannerEffects, goal: Goal, prompt: string, validate: (payload: unknown) => T): Promise<{ payload: T | null; runs: string[]; deferred?: string; invalid?: string }> {
  const runs: string[] = [], reasons: string[] = [];
  let invalid: string | undefined;
  for (const attempt of ['primary', 'fallback'] as const) {
    let chosen: PlannerRun;
    try { chosen = await planner.runner(attempt, goal); } catch (error) {
      const full = capacityRefusal(error);
      if (full) return { payload: null, runs, deferred: `${full}: ${clip(message(error), 300)}` };
      runs.push(`no ${attempt} runner: ${message(error)}`); continue;
    }
    const run = chosen.runner.start(prompt, { cwd: planner.cwd, env: { GRAPHYARD_PI_ROLE: plannerRole }, tool: planTool, timeoutMs: planner.settings.timeoutMinutes * 60_000, validate });
    const result = await run.result();
    await Promise.resolve(chosen.release?.(`the ${attempt} plan of ${goal.key} ended`)).catch(() => {});
    if (result.ok) return { payload: result.payload, runs };
    runs.push(`${chosen.model} ${result.failure.reason}: ${clip(result.failure.detail, 300)}`);
    reasons.push(result.failure.reason);
    // A payload the schema refused is the one failure the next run can answer: its reason is kept for the goal's refusal (GY-1803).
    if (result.failure.reason === 'invalid-payload') invalid = clip(result.failure.detail, 2000);
    if (result.failure.reason === 'cancelled') break;
  }
  // The reason is carried back only when every run failed validation: a run that failed otherwise (a timeout, an exit) says nothing about the payload.
  return { payload: null, runs, ...(reasons.length && reasons.every(reason => reason === 'invalid-payload') ? { invalid } : {}) };
}
const ofGoal = (goal: Goal, parsed: { goal: string }) => { if (parsed.goal !== goal.key) throw new Error(`the answer names ${parsed.goal}, not ${goal.key}`); };
function launch(cycle: Cycle, planner: PlannerEffects, goal: Goal) {
  const run = runHeadless(planner, goal, plannerPrompt(cycle.config, goal), payload => {
    const { goal: named, ...plan } = planPayloadSchema.parse(payload); ofGoal(goal, { goal: named }); return plan;
  }).then(result => ({ revision: goal.revision, plan: result.payload, runs: result.runs, deferred: result.deferred, invalid: result.invalid }));
  live.set(goal.id, run.catch(error => ({ revision: goal.revision, plan: null, runs: [message(error)] }))
    .then(result => { pending.set(goal.id, result); }).finally(() => live.delete(goal.id)));
}
const due = (cycle: Cycle, goal: Goal, step: string) => cycle.clock >= (retryAt.get(`${goal.id}:${step}`) ?? -Infinity);
const later = (cycle: Cycle, goal: Goal, step: string, ms: number) => { retryAt.set(`${goal.id}:${step}`, cycle.clock + ms); };

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
    performed.push(await record(state, key, { kind: 'judgement', work: goal.key, principal: null, state: outcome, detail: clip(detail, 1000), attempts: (state.actions[key]?.attempts ?? 0) + (outcome === 'failed' ? 1 : 0), cycle: state.cycle }, now(), effects.persist));
  };
  const isolate = carriedIsolate(cycle, 'triage'); // GY-1774: a call carried past the step's bound is recorded waiting on its goal, never noted as a failure
  const goals = await isolate('judgement', null, 'the goals being planned', () => planner.goals());
  for (const goal of goals ?? []) {
    if (!goal.merged) continue;
    await isolate('judgement', null, `the plan of ${goal.key}`, async () => {
      const result = pending.get(goal.id);
      if (result && result.revision !== goal.revision) pending.delete(goal.id);
      if (goal.stage === 'planning') return planning(cycle, planner, goal, note);
      if (goal.stage === 'planned') return releasing(cycle, planner, goal, note);
      if (goal.stage === 'delivering') return delivering(cycle, planner, goal, note);
    });
  }
}

function deferred(cycle: Cycle, goal: Goal, result: Pending, note: Note) {
  pending.delete(goal.id); later(cycle, goal, 'plan', planPollMs);
  return note(goal, 'waiting', `The planner is at its registry capacity (${result.deferred}); ${goal.key}'s plan starts no fallback and is launched again in five minutes`);
}

async function planning(cycle: Cycle, planner: PlannerEffects, goal: Goal, note: Note) {
  if ((goal.planDrafts ?? 0) >= maxPlanRounds)
    return note(goal, 'done', `${goal.key} has had ${goal.planDrafts} plans refused (last: ${clip(goal.planRefusal?.reason ?? 'none recorded', 300)}); the loop plans no more and leaves it to the master`);
  const result = pending.get(goal.id);
  if (result && 'plan' in result) {
    if (!result.plan && result.deferred) return deferred(cycle, goal, result, note);
    if (!result.plan) {
      // A payload plan validation refused never reached a post, so nothing said why (GY-1803): the
      // reason is recorded the same way a refused plan is (plan-invalid, so it counts toward
      // maxPlanRounds across restarts), the next prompt carries it as lastRefusal, and the retry
      // waits ten minutes, not the hour a paid run waits.
      if (result.invalid) {
        if (!due(cycle, goal, 'post')) return;
        const reason = `the ${planTool} payload failed validation: ${result.invalid}`;
        try { await planner.invalid(goal, reason); }
        catch (error) { if (stepCallCarried(error)) throw error; later(cycle, goal, 'post', planStepRetryMs); return note(goal, 'failed', `The planner returned no plan for ${goal.key}: ${clip(reason, 300)}, but the refusal could not be recorded: ${message(error)}; it is recorded again in ten minutes`); }
        pending.delete(goal.id); later(cycle, goal, 'plan', planStepRetryMs);
        const last = (goal.planDrafts ?? 0) + 1 >= maxPlanRounds;
        return note(goal, 'failed', `The planner returned no plan for ${goal.key}: ${reason}; ${last ? `that was plan ${maxPlanRounds} of ${maxPlanRounds}, so the loop plans no more and leaves it to the master` : 'it is planned again in ten minutes, answering that'}`);
      }
      pending.delete(goal.id); later(cycle, goal, 'plan', planRetryMs);
      return note(goal, 'failed', `The planner returned no plan for ${goal.key}: ${result.runs.join('; ')}; it is planned again in an hour`);
    }
    // Refused with its reasons, recorded on the goal so it counts toward
    // the plan rounds whatever restarts the loop, and the next run is told why.
    const refuse = async (reason: string) => {
      try { await planner.invalid(goal, reason); }
      catch (error) { if (stepCallCarried(error)) throw error; later(cycle, goal, 'post', planStepRetryMs); return note(goal, 'failed', `The planner's plan for ${goal.key} was refused (${clip(reason, 300)}), but the refusal could not be recorded: ${message(error)}; it is recorded again in ten minutes`); }
      pending.delete(goal.id); later(cycle, goal, 'plan', planRetryMs);
      const last = (goal.planDrafts ?? 0) + 1 >= maxPlanRounds;
      return note(goal, 'failed', `The planner's plan for ${goal.key} was refused: ${reason}; ${last ? `that was plan ${maxPlanRounds} of ${maxPlanRounds}, so the loop plans no more and leaves it to the master` : 'it is planned again in an hour, answering that'}`);
    };
    if (!due(cycle, goal, 'post')) return;
    const refusals = planRefusals(goal, result.plan);
    if (refusals.length) return refuse(refusals.join('; '));
    try { await planner.plan(goal, result.plan); }
    catch (error) { if (stepCallCarried(error)) throw error;
      if (invalidPlan(error)) return refuse(message(error));
      // Refused for authority or state (401, 403, 409), the plan is kept and posted again in an hour: recording it as invalid with the same credential would be refused too.
      if (refusedOutright(error)) { later(cycle, goal, 'post', planRetryMs); return note(goal, 'failed', `The plan for ${goal.key} could not be recorded: ${message(error)}; the control plane refused it outright, so it is posted again in an hour`); }
      later(cycle, goal, 'post', planStepRetryMs); return note(goal, 'failed', `The plan for ${goal.key} could not be recorded: ${message(error)}; it is posted again in ten minutes`);
    }
    pending.delete(goal.id);
    return note(goal, 'done', `Recorded ${goal.key}'s plan: ${result.plan.items.map(item => `${item.ref}${item.dependsOn.length ? ` after ${item.dependsOn.join(', ')}` : ''}`).join('; ')}; its items are released next`);
  }
  if (live.has(goal.id) || !due(cycle, goal, 'plan')) return;
  launch(cycle, planner, goal);
  await note(goal, 'done', `Launched the planner for ${goal.key} (plan ${(goal.planDrafts ?? 0) + 1} of at most ${maxPlanRounds}) on ${planner.settings.model}, falling back to ${planner.settings.fallbackModel}`);
}

/** A recorded plan's items are created and released by the control plane, in dependency order. */
async function releasing(cycle: Cycle, planner: PlannerEffects, goal: Goal, note: Note) {
  if (!due(cycle, goal, 'release')) return;
  let released: Goal;
  try { released = await planner.release(goal); }
  catch (error) { if (stepCallCarried(error)) throw error;
    // Refused outright (401, 403, 409 or 422), asking again in ten minutes is answered the same: it waits the hour a paid run does.
    if (refusedOutright(error)) { later(cycle, goal, 'release', planRetryMs); return note(goal, 'failed', `Could not release ${goal.key}'s plan: ${message(error)}; the control plane refused it outright, so it is asked again in an hour, reusing the items already created`); }
    later(cycle, goal, 'release', planStepRetryMs); return note(goal, 'failed', `Could not release ${goal.key}'s plan: ${message(error)}; it is asked again in ten minutes, reusing the items already created`);
  }
  return note(goal, 'done', `Released ${goal.key}'s plan: ${(released.items ?? []).map(item => item.key).join(', ')}; the dispatcher launches each only after the items it depends on are delivered`);
}

/** Delivered once every item of the plan is merged (GY-1981), read at most once per poll interval. */
async function delivering(cycle: Cycle, planner: PlannerEffects, goal: Goal, note: Note) {
  const items = goal.items ?? [];
  if (!items.length || !due(cycle, goal, 'deliver')) return;
  later(cycle, goal, 'deliver', planPollMs);
  const waiting = items.filter(item => !mergedItem(cycle.snapshot.work.find(work => work.key === item.key)));
  if (waiting.length) return note(goal, 'waiting', `${goal.key} is delivering: ${waiting.map(item => item.key).join(', ')} ${waiting.length === 1 ? 'is' : 'are'} not yet merged`);
  try { await planner.deliver(goal, items.map(item => item.key), `Every item of ${goal.key}'s plan is merged`); }
  catch (error) { if (stepCallCarried(error)) throw error; return note(goal, 'failed', `Could not record ${goal.key} delivered: ${message(error)}; it is asked again in five minutes`); }
  return note(goal, 'done', `${goal.key} is delivered: ${items.map(item => item.key).join(', ')} are merged`);
}

interface Calls {
  fetcher: typeof fetch;
  asCoordinator: (path: string) => Promise<any>;
  asOperatorAgent: (method: 'GET' | 'POST', path: string, body?: unknown, key?: string) => Promise<any>;
}
/**
 * The planner's effects under the live configuration: runners as the acceptance role's (the
 * registry's planner role when an operator defines one, else Pi on `run.diagnostician`'s
 * models), plans posted as the master's operator-agent identity.
 */
export function plannerEffects(config: MasterConfig, root: string, calls: Calls): PlannerEffects {
  const settings = { ...diagnosticianSettings(config.run), enabled: true };

  return {
    settings, cwd: root,
    goals: async () => (await calls.asCoordinator('goals?open=1')).goals,
    runner: async (attempt, goal) => {
      if (attempt === 'primary') {
        const name = plannerRole, principal = config.operatorAgent!.id;
        const fleet = await selectFleetSession(config, name, { name, principal }, await heldAwareProbe(config, { work: goal.key })); // an account held here, or its twin, is spent (GY-1574)
        if (fleet) { const launched = registryHeadlessLaunch(fleet.account); return { runner: registryRunner(fleet.account), runtime: launched.command, model: launched.model, release: fleet.release }; }
      }
      const model = attempt === 'primary' ? settings.model : settings.fallbackModel;
      return { runner: piRunner({ command: settings.command, model }), runtime: 'pi', model };
    },
    plan: (goal, plan) => calls.asOperatorAgent('POST', `goals/${goal.key}/plan`, plan, `planner:${goal.id}:${goal.revision}`),
    invalid: (goal, reason) => calls.asOperatorAgent('POST', `goals/${goal.key}/plan-invalid`, { reason: clip(reason, 2000) }, `planner:${goal.id}:${goal.revision}:invalid`),
    release: goal => calls.asOperatorAgent('POST', `goals/${goal.key}/release`, {}, `planner:${goal.id}:${goal.revision}:release`),
    deliver: (goal, items, reason) => calls.asOperatorAgent('POST', `goals/${goal.key}/deliver`, { items, reason }, `planner:${goal.id}:${goal.revision}:deliver`),
  };
}
