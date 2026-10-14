// Concern: cycle step 4c++++ — a goal's requested case change (GY-1805) is put to an independent approver by the loop, like every other decision;
// the verdict is applied as case-change-approve or case-change-refuse, and a change the approver does not answer stays requested and is asked again next cycle.
import { z } from 'zod';
import { capacityRefusal } from '../fleet.js';
import type { Goal } from '../model/goal.js';
import type { CaseChangeRequest } from '../model/goal-plan.js';
import type { AcceptanceRun } from './acceptance.js';
import { detailChanged } from './decisions.js';
import { record } from './effects.js';
import { type DaemonAction, message } from './state.js';
import { RefusedResponse } from '../model/refusal.js';
import type { Cycle } from './cycle.js';
import { carriedIsolate, stepCallCarried, withinStepBudget } from './step-budget.js';

export type { CaseChangeRequest };
// The approver role's existing judgement tool carries the verdict (src/daemon/acceptance.ts judgementPayloadSchema, integrations/pi): the goal key, approve or refuse, and the reason.
const acceptanceJudgeRole = 'acceptance-judge', acceptanceJudgementTool = 'graphyard_acceptance_judgement';
export const caseChangeJudgementSchema = z.object({ goal: z.string().min(1).max(40), verdict: z.enum(['approve', 'refuse']), reason: z.string().trim().min(1).max(2000) }).strict();
export type CaseChangeJudgement = z.infer<typeof caseChangeJudgementSchema>;

/** A finished run kept until its verdict is applied; `deferred` names the full role no run started on. */
interface Pending { judgement: CaseChangeJudgement | null; runs: string[]; deferred?: string }
const live = new Map<string, Promise<void>>();
const pending = new Map<string, Pending>();
export async function caseChangesSettled() { await Promise.all([...live.values()]); }
export function clearCaseChanges() { live.clear(); pending.clear(); }
const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

export function caseChangePrompt(config: { repository: string }, change: CaseChangeRequest) {
  const input = { goal: change.goal, caseChange: change.id, item: change.work, cases: change.cases, reason: change.reason, requestedBy: change.requestedBy, requestedAt: change.requestedAt };
  return `You are the independent approver of a protected-case change for ${config.repository}. You did not request it and you did not implement ${change.work}. `
    + 'A required customer case is protected: it may change only to correct a defect in the case itself, never to make the implementation pass by weakening what the customer checks. '
    + 'This session is read-only: never edit, commit, push, claim or decide anything, and never ask anyone anything. '
    + `Read the cases in this checkout (e2e/cases/${change.cases.map(id => `${id}.json`).join(', ')}) and the reason below. Approve only when the reason names a defect in the case itself and the change leaves every outcome still proved; otherwise refuse, naming what the request lacks. `
    + `Call the ${acceptanceJudgementTool} tool exactly once with goal "${change.goal}", verdict "approve" or "refuse", and your reason. Stop after the call.\n\n`
    + `The case change, as JSON:\n${clip(JSON.stringify(input), 20_000)}`;
}

/** One headless run, primary then fallback, on the approver role's accounts; a role at its concurrency defers the change instead of starting a fallback. */
async function judge(cycle: Cycle, change: CaseChangeRequest): Promise<Pending> {
  const acceptance = cycle.effects.acceptance, runs: string[] = [];
  if (!acceptance) return { judgement: null, runs: ['this loop has no approver runner'] };
  const goal = { key: change.goal, id: change.goalId } as Goal;
  for (const attempt of ['primary', 'fallback'] as const) {
    let chosen: AcceptanceRun;
    try { chosen = await acceptance.runner('judge', attempt, goal); } catch (error) {
      const full = capacityRefusal(error);
      if (full) return { judgement: null, runs, deferred: `${full}: ${clip(message(error), 300)}` };
      runs.push(`no ${attempt} runner: ${message(error)}`); continue;
    }
    const run = chosen.runner.start(caseChangePrompt(cycle.config, change), { cwd: acceptance.cwd, env: { GRAPHYARD_PI_ROLE: acceptanceJudgeRole }, tool: acceptanceJudgementTool, timeoutMs: acceptance.settings.timeoutMinutes * 60_000,
      validate: payload => { const parsed = caseChangeJudgementSchema.parse(payload); if (parsed.goal !== change.goal) throw new Error(`the answer names ${parsed.goal}, not ${change.goal}`); return parsed; } });
    const result = await run.result();
    await Promise.resolve(chosen.release?.(`the ${attempt} judgement of ${change.goal} case change ${change.id} ended`)).catch(() => {});
    if (result.ok) return { judgement: result.payload, runs };
    runs.push(`${chosen.model} ${result.failure.reason}: ${clip(result.failure.detail, 300)}`);
    if (result.failure.reason === 'cancelled') break;
  }
  return { judgement: null, runs };
}

/**
 * The case-change step: each requested change is launched once to an approver run (never twice while one is in flight), its verdict kept until it is
 * applied (so a failed post retries without another run), and a run that answers nothing, or past the decision bound, leaves the change requested
 * for the next cycle. The control plane keeps the independence rules: the approver identity is neither the requester nor an implementer of the item.
 */
export const caseChangeStep = (cycle: Cycle, outerLeft: () => number = () => Number.POSITIVE_INFINITY) => cycle.effects.caseChanges && cycle.effects.judgeCaseChange && outerLeft() > 0
  ? withinStepBudget(cycle, 'decisions', ['caseChanges', 'judgeCaseChange'], caseChangeStepWithin) : Promise.resolve();
async function caseChangeStepWithin(cycle: Cycle, budgetLeft: () => number | null) {
  const { state, effects, now, performed } = cycle;
  const isolate = carriedIsolate(cycle, 'decisions');
  const note = async (change: CaseChangeRequest, outcome: DaemonAction['state'], detail: string) => {
    const key = `case-change:${change.id}`;
    if (!detailChanged(state.actions[key], clip(detail, 1000))) return;
    performed.push(await record(state, key, { kind: 'decision', work: change.work, principal: null, state: outcome, detail: clip(detail, 1000), attempts: (state.actions[key]?.attempts ?? 0) + (outcome === 'failed' ? 1 : 0), cycle: state.cycle }, now(), effects.persist));
  };
  const changes = await isolate('decision', null, 'the requested case changes', () => effects.caseChanges!());
  const standing = new Set((changes ?? []).map(change => change.id));
  for (const id of [...pending.keys()]) if (!standing.has(id)) pending.delete(id); // judged meanwhile (by hand, or already applied): nothing left to post
  for (const change of changes ?? []) if (budgetLeft() !== 0) await isolate('decision', null, `${change.goal}'s case change ${change.id}`, async () => {
    const name = `${change.goal}'s case change ${change.id} (${change.cases.join(', ')} for ${change.work})`, result = pending.get(change.id);
    if (result?.judgement) {
      try { await effects.judgeCaseChange!(change, result.judgement); }
      catch (error) {
        if (stepCallCarried(error)) throw error;
        // Already judged (409): the verdict stands, once.
        if (error instanceof RefusedResponse && error.status === 409) { pending.delete(change.id); return note(change, 'done', `${name} was already judged; nothing is posted again`); }
        return note(change, 'failed', `The approver's ${result.judgement.verdict} of ${name} could not be recorded: ${message(error)}; it is posted again next cycle`);
      }
      pending.delete(change.id);
      return note(change, 'done', `The approver ${result.judgement.verdict === 'approve' ? 'approved' : 'refused'} ${name}: ${clip(result.judgement.reason, 600)}`);
    }
    if (result) {
      pending.delete(change.id);
      return note(change, result.deferred ? 'waiting' : 'failed', result.deferred
        ? `The approver role is at its registry capacity (${result.deferred}); ${name} stays requested and is put to an approver next cycle`
        : `The approver returned no judgement on ${name}: ${result.runs.join('; ')}; it stays requested and is put to an approver again next cycle`);
    }
    if (live.has(change.id)) return;
    live.set(change.id, judge(cycle, change).catch(error => ({ judgement: null, runs: [message(error)] } as Pending)).then(done => { pending.set(change.id, done); }).finally(() => live.delete(change.id)));
    await note(change, 'done', `Launched an independent approver for ${name}, requested by ${change.requestedBy}`);
  });
}
