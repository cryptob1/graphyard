import type { Work } from './model.js';
import { decompositionPayloadSchema, type DecompositionPayload, type DecompositionSettings } from './runner/payloads.js';
import type { Run, Runner } from './runner/types.js';
import { decompositionHold, decompositionRole, decompositionTool, decompositionWanted, type DecompositionEvent } from './decomposition.js';

// ---------------------------------------------------------------------------
// The loop's decomposition step (GY-1126, before research and dispatch in cycle step 4).
//
// Each item dispatch would offer that is over the size bounds and was never dispatched gets one
// Pi session on the research account, recorded as started before it launches. The item is held
// only while that run is within its time limit. The session proposes the children through
// `graphyard_decompose`; the control plane validates and makes the split (src/decomposition.ts).
// A run that fails, times out, keeps the item whole or proposes a split the control plane refuses
// is recorded, and the item is dispatched unchanged on the next cycle: splitting never blocks.
// ---------------------------------------------------------------------------

export interface DecompositionStepAction { work: string; state: 'started' | 'done' | 'failed'; detail: string }
/** How many decomposition sessions one loop process keeps in flight at once, unless `run.decomposition.concurrency` says otherwise. */
export const decompositionConcurrency = 4;
interface LiveDecomposition { run: Run<DecompositionPayload>; settled: Promise<void> }
const live = new Map<string, LiveDecomposition>();
/** Test seam: stop and forget every decomposition run. */
export function clearDecompositionRuns() { for (const entry of live.values()) entry.run.cancel('the decomposition runs were cleared'); live.clear(); }
/** Every run this process has in flight, settled: a test's way to wait for the step's effects. */
export async function decompositionSettled() { await Promise.all([...live.values()].map(entry => entry.settled)); }

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The decomposition session's request: the item, why it is too broad, and the rules its split must keep. */
export function decompositionPrompt(config: { repository: string }, work: Pick<Work, 'key' | 'title' | 'type' | 'description' | 'criteria' | 'plannedFiles' | 'dependencies'>, bounds: string[], settings: Pick<DecompositionSettings, 'timeoutMinutes'>) {
  return `You are the Graphyard decomposition agent for ${config.repository}. ${work.key} (${work.type}): ${work.title} is about to be dispatched to an implementation worker, but it is too broad for one small pull request: ${bounds.join('; ')}. `
    + 'Large pull requests collide in the merge queue and are ejected, so split it into 2 to 10 small child items that can each be built, reviewed and merged on their own. '
    + (work.description ? `Its description: ${clip(work.description, 6000)} ` : '')
    + `Its acceptance criteria: ${work.criteria.map(criterion => `${criterion.id}: ${clip(criterion.text, 1500)}`).join(' ')} `
    + (work.plannedFiles?.length ? `Its planned files: ${work.plannedFiles.join(', ')}. ` : '')
    + 'Read this checkout (the base branch) to see which files each criterion changes. Rules: give every criterion ID to exactly one child (Graphyard copies its text and proofs; you cannot change them); give each child a title, the planned files it changes, inside the parent\'s planned files and strictly narrower than them (name files, not root directories), and in `after` the positions (0-based) of earlier children it must land after because it builds on them. '
    + 'If the criteria cannot be built and merged separately, keep the item whole: submit an empty children list with your reason. '
    + `This session is read-only: do not edit, commit, push, claim work or ask anyone anything. Finish within ${settings.timeoutMinutes} minutes. `
    + `Then call the ${decompositionTool} tool exactly once with reason and children, and stop.`;
}

export interface DecompositionStepInput {
  /** The items dispatch would offer this cycle, in order. */
  items: readonly Work[];
  clock: number;
  settings: DecompositionSettings;
  config: { repository: string };
  /** The checkout the session reads: the loop's own. */
  cwd: string;
  runner: Runner;
  /** The model the runner runs, for the record. */
  model: string;
  /** Records an event on the item through the control plane (POST work/ID/decomposition as the coordinator). */
  record: (work: Work, event: DecompositionEvent) => Promise<unknown>;
}

/**
 * Split the broad items about to be dispatched. The result names every item dispatch must hold
 * this cycle — only those with a run in progress within its bound — and what the step did.
 */
export async function decompositionStep(input: DecompositionStepInput): Promise<{ held: Set<string>; actions: DecompositionStepAction[] }> {
  const held = new Set<string>(), actions: DecompositionStepAction[] = [];
  const limit = input.settings.concurrency ?? decompositionConcurrency;
  for (const work of input.items) {
    if (live.has(work.id)) { held.add(work.id); continue; }
    const record = work.decomposition;
    if (record?.state === 'running') {
      if (decompositionHold(work, input.clock)) { held.add(work.id); continue; }
      // Recorded as running, not running here, past its bound: the loop restarted under it.
      try {
        await input.record(work, { event: 'failed', reason: 'timeout', detail: `No decomposition run finished within ${Math.round(record.timeoutMs / 60_000)} minutes of ${record.startedAt}; it is dispatched whole` });
        actions.push({ work: work.key, state: 'failed', detail: `${work.key}'s decomposition run never finished within its bound; it is dispatched whole` });
      } catch (error) { actions.push({ work: work.key, state: 'failed', detail: `Could not record ${work.key}'s unfinished decomposition run: ${message(error)}` }); }
      continue;
    }
    const bounds = decompositionWanted(work, input.settings);
    if (!bounds) continue;
    if (live.size >= limit) { held.add(work.id); continue; }
    const timeoutMs = input.settings.timeoutMinutes * 60_000;
    try { await input.record(work, { event: 'started', runtime: input.runner.name, model: input.model, timeoutMs, bounds }); }
    catch (error) {
      actions.push({ work: work.key, state: 'failed', detail: `${work.key} was not put to decomposition, so it is dispatched whole: ${message(error)}` });
      continue;
    }
    held.add(work.id);
    const run = input.runner.start(decompositionPrompt(input.config, work, bounds, input.settings), {
      cwd: input.cwd, env: { GRAPHYARD_PI_ROLE: decompositionRole }, tool: decompositionTool, timeoutMs, validate: payload => decompositionPayloadSchema.parse(payload) });
    const settled = run.result().then(async result => {
      // A split the control plane refuses (a dropped criterion, a scope that does not shrink) is that run's failure.
      if (result.ok) {
        try { await input.record(work, { event: 'decided', payload: result.payload }); return; }
        catch (error) { await input.record(work, { event: 'failed', reason: 'refused', detail: clip(`The control plane refused the proposed split: ${message(error)}; it is dispatched whole`, 1000) }); return; }
      }
      await input.record(work, { event: 'failed', reason: result.failure.reason, detail: clip(`${result.failure.detail}; it is dispatched whole`, 1000) });
    }).catch(() => {}).finally(() => { if (live.get(work.id)?.run === run) live.delete(work.id); });
    live.set(work.id, { run, settled });
    actions.push({ work: work.key, state: 'started', detail: `Splitting ${work.key} before dispatch (${bounds.join('; ')}) on ${input.model}, at most ${input.settings.timeoutMinutes} minutes; dispatch waits for the split` });
  }
  return { held, actions };
}
