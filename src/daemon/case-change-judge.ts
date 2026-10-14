// Concern: the approver's judgement of a requested case change (GY-1806). A case change lets one item change a
// protected case; it is judged by an approver who is neither its requester nor an implementer of the item.
// Nothing used to route a requested change to one, so the implementer blocked on it and the master ran the
// approval by hand. The loop now launches the approver's headless judgement, as it does for an acceptance draft.
import { acceptanceJudgementTool, judgementPayloadSchema, runHeadless, type AcceptanceEffects, type Judgement } from './acceptance.js';
import type { CaseChange, Goal } from '../model/goal.js';
import { stepCallCarried } from './step-budget.js';
import { message, type DaemonAction } from './state.js';
import type { Cycle } from './cycle.js';

interface Finished { judgement: Judgement | null; runs: string[]; deferred?: string }
const live = new Map<string, Promise<void>>();
const finished = new Map<string, Finished>();
export async function caseChangeJudgementsSettled() { await Promise.all([...live.values()]); }
export function clearCaseChangeJudgements() { for (const store of [live, finished]) store.clear(); }

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
/** The requested changes of a goal, oldest first: each is judged by its own run, so the verdict names its change unambiguously. */
export const requestedCaseChanges = (goal: Goal): CaseChange[] => goal.caseChanges.filter(change => change.state === 'requested');

export function caseChangePrompt(config: { repository: string }, goal: Goal, change: CaseChange) {
  const input = { goal: goal.key, statement: goal.statement, change: { item: change.work, cases: change.cases, reason: change.reason, requestedBy: change.requestedBy, requestedAt: change.requestedAt },
    protectedOutcomes: goal.acceptance?.outcomes.filter(outcome => change.cases.includes(outcome.case.id)).map(outcome => ({ id: outcome.id, title: outcome.title, criteria: outcome.criteria, case: outcome.case })) ?? [] };
  return `You are the independent approver of a protected-case change for ${config.repository}. You did not request it and did not implement ${change.work}. Judge whether ${change.work} may modify the required case(s) it names. `
    + 'This session is read-only: never edit, commit, push, claim or decide anything, and never ask anyone anything. '
    + `Read ${change.work}'s pull request diff (gh pr list --search ${change.work}, gh pr diff) and the cases in e2e/cases/. `
    + 'Approve only when the edit corrects the case so that it states the same customer outcome it always did (a broken step, a wrong field name) and weakens nothing: no step, assertion or requirement removed, no required case made optional, no outcome narrowed. Otherwise refuse, naming what the item must change. '
    + `Call the ${acceptanceJudgementTool} tool exactly once with goal "${goal.key}", verdict "approve" or "refuse", and your reason. Stop after the call.\n\n`
    + `The goal and the change, as JSON:\n${clip(JSON.stringify(input), 50_000)}`;
}

type Note = (goal: Goal, outcome: DaemonAction['state'], detail: string, caught?: unknown) => Promise<void>;

/** One loop step over a goal's requested case changes: each is launched, or its returned verdict posted, in this cycle. */
export async function caseChangeStep(cycle: Cycle, acceptance: AcceptanceEffects, goal: Goal, note: Note) {
  if (!acceptance.judgeCaseChange) return;
  for (const change of requestedCaseChanges(goal)) await changeStep(cycle, acceptance, goal, change, note);
}

async function changeStep(cycle: Cycle, acceptance: AcceptanceEffects, goal: Goal, change: CaseChange, note: Note) {
  // Its own note key, so the goal's acceptance note and this change's never overwrite each other.
  const about = { ...goal, id: `${goal.id}:case-change:${change.id}` } as Goal;
  const result = finished.get(change.id);
  if (result) {
    if (!result.judgement) {
      finished.delete(change.id);
      return note(about, result.deferred ? 'waiting' : 'failed', result.deferred
        ? `The approver is at its registry capacity (${result.deferred}); the judgement of ${change.work}'s case change ${change.id} is launched again next cycle`
        : `The approver returned no judgement on ${change.work}'s case change ${change.id}: ${result.runs.join('; ')}; it is judged again next cycle`);
    }
    try { await acceptance.judgeCaseChange?.(goal, change, result.judgement); }
    catch (error) {
      if (stepCallCarried(error)) throw error;
      return note(about, 'failed', `The approver's ${result.judgement.verdict} of ${change.work}'s case change ${change.id} could not be recorded: ${message(error)}; it is posted again next cycle`, error);
    }
    finished.delete(change.id);
    return note(about, 'done', `The approver ${result.judgement.verdict === 'approve' ? 'approved' : 'refused'} ${change.work}'s case change ${change.id} (${change.cases.join(', ')}): ${clip(result.judgement.reason, 600)}`);
  }
  if (live.has(change.id)) return;
  const run = runHeadless(acceptance, 'judge', goal, caseChangePrompt(cycle.config, goal, change), payload => {
    const parsed = judgementPayloadSchema.parse(payload);
    if (parsed.goal !== goal.key) throw new Error(`the answer names ${parsed.goal}, not ${goal.key}`);
    return parsed;
  }).then(answer => ({ judgement: answer.payload, runs: answer.runs, deferred: answer.deferred }));
  live.set(change.id, run.catch(error => ({ judgement: null, runs: [message(error)] } as Finished)).then(answer => { finished.set(change.id, answer); }).finally(() => live.delete(change.id)));
  await note(about, 'done', `Launched the approver's judgement of ${change.work}'s case change ${change.id} (${change.cases.join(', ')}), requested by ${change.requestedBy}`);
}
