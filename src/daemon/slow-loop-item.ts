// Concern: GY-1775 — a loop slower than its bound across three cycles files its own fix item, naming
// the slowest step and the slowest external call, so a regression is owned by an item rather than
// found by a human reading p50 (GY-1766 was filed by hand after the decisions step held cycles at 121 s).
import { planeWideRefusal } from '../model/blocker-class.js';
import { z } from 'zod';
import type { CallTiming } from '../master/timings.js';
import type { Work } from '../model.js';
import type { DaemonEffects } from './effects.js';
import { cycleTimes, slowCycleMs } from './liveness.js';
import { record } from './preserve.js';
import { readyToRetry } from './sessions.js';
import { type CycleMetrics, type DaemonAction, type DaemonState, message, type SlowLoopState } from './state.js';

/** Consecutive cycles past `slowCycleMs` on one loaded release before the loop files the item. */
export const slowLoopCycles = 3;

/**
 * The source file of each timed step (`timings.step` in src/daemon/cycle.ts), so the filed item
 * names where the time went. The coarse buckets (`cycleBucketSteps`) stand in for a cycle recorded
 * without timings. A step this table does not name is filed by name alone, with no file to plan.
 */
export const stepSourceFiles: Record<string, string> = {
  snapshot: 'src/daemon/cycle.ts', 'follow-up threads': 'src/daemon/cycle.ts', measure: 'src/daemon/cycle.ts', reconcile: 'src/daemon/cycle-resume.ts',
  'merge settings': 'src/daemon/effects.ts', observe: 'src/daemon/effects.ts', credentials: 'src/daemon/effects.ts', setup: 'src/cli/master-setup.ts',
  launches: 'src/daemon/cycle-dispatch.ts', dispatch: 'src/daemon/cycle-dispatch.ts', close: 'src/daemon/cycle-sessions.ts', 'master session': 'src/daemon/cycle-master.ts',
  scope: 'src/daemon/cycle-scope.ts', successors: 'src/daemon/cycle-scope.ts', 'host supervision': 'src/daemon/cycle-host.ts', blockers: 'src/daemon/cycle-blockers.ts',
  reclaim: 'src/daemon/cycle-reclaim.ts', 'base failures': 'src/daemon/cycle-base-failures.ts', flakes: 'src/daemon/cycle-flakes.ts', 'review cap': 'src/daemon/cycle-review-cap.ts',
  decisions: 'src/daemon/cycle-decisions.ts', 'reviews and proofs': 'src/daemon/cycle-delivery.ts', merges: 'src/daemon/cycle-delivery.ts', 'deployment verification': 'src/daemon/cycle-delivery.ts',
  deployment: 'src/daemon/cycle-delivery.ts', merge: 'src/daemon/cycle-delivery.ts', remedies: 'src/daemon/cycle-remedies.ts', 'merge writer': 'src/daemon/cycle-merge-writer.ts',
  'shadow gate': 'src/daemon/cycle-shadow.ts', 'main watch': 'src/daemon/main-watch.ts', faults: 'src/daemon/faults.ts', triage: 'src/daemon/cycle-triage.ts', doctor: 'src/daemon/doctor.ts',
};
export const stepSourceFile = (step: string) => stepSourceFiles[step] ?? null;

const seconds = (ms: number) => `${Math.round(ms / 100) / 10}s`;
const slow = (metrics: Pick<CycleMetrics, 'durationMs'>) => metrics.durationMs > slowCycleMs;
/** The run's record key on the cursor: one row per release and step, so `master status` shows what was filed. */
export const slowLoopActionKey = (release: string, step: string) => `slow-loop:${release.slice(0, 12)}:${step}`;
/** The idempotency key the item is filed under: the release commit and the step, so a retry or a later cycle returns the item already filed. */
export const slowLoopIdempotencyKey = (release: string, step: string) => `slow-loop:${release}:${step}`;
const filedKey = (release: string, step: string) => `${release}:${step}`;

/**
 * Where the window's time went: the step with the most wall time summed over the window's cycles
 * (the timed steps when any cycle recorded them, else the coarse buckets) and the slowest external
 * call any cycle in it recorded.
 */
export function slowLoopWindow(window: readonly CycleMetrics[]) {
  const steps = new Map<string, number>();
  let call: CallTiming | null = null;
  for (const metrics of window) {
    const timed = metrics.timings?.steps.length ? metrics.timings.steps : metrics.steps ? Object.entries(metrics.steps).map(([step, cost]) => ({ step, ms: cost.ms })) : [];
    for (const step of timed) steps.set(step.step, (steps.get(step.step) ?? 0) + step.ms);
    for (const recorded of metrics.timings?.calls ?? []) if (!call || recorded.ms > call.ms) call = recorded;
  }
  const ranked = [...steps].sort((a, b) => b[1] - a[1]);
  const slowest = ranked.length && ranked[0][1] > 0 ? { step: ranked[0][0], ms: ranked[0][1], file: stepSourceFile(ranked[0][0]) } : null;
  return { slowest, call, perCycle: window.map(metrics => ({ cycle: metrics.cycle, durationMs: metrics.durationMs, stepMs: slowest ? (metrics.timings?.steps.find(step => step.step === slowest.step)?.ms ?? (metrics.steps as Record<string, { ms: number }> | undefined)?.[slowest.step]?.ms ?? 0) : 0 })) };
}

/** The item body as the control plane's create command parses it: bounds the pending filing the cursor keeps. */
export const slowLoopItemInputSchema = z.object({
  title: z.string().min(1).max(200), type: z.literal('bug'), priority: z.literal(1),
  description: z.string().min(1).max(20_000),
  criteria: z.array(z.object({ id: z.string().regex(/^AC-\d+$/), text: z.string().min(1).max(2000), proofs: z.array(z.string().min(1).max(100)).min(1).max(20) }).strict()).min(1).max(50),
  plannedFiles: z.array(z.string().min(1).max(500)).max(50).optional(),
  reason: z.string().min(1).max(2000),
}).strict();
export type SlowLoopItemInput = z.infer<typeof slowLoopItemInputSchema>;
/** A filing the control plane never answered, kept on the cursor so the retry asks the original body under the original key. */
export const slowLoopPendingSchema = z.object({
  release: z.string().max(40), step: z.string().max(80), key: z.string().max(200), cycles: z.array(z.number().int().min(0)).min(1).max(slowLoopCycles), at: z.string().max(40), input: slowLoopItemInputSchema,
}).strict();
export type PendingSlowLoop = z.infer<typeof slowLoopPendingSchema>;
/** Filings kept on the cursor, newest by cycle; the bound keeps a release rolled back to from filing again without the cursor growing without end. */
export const retainedSlowLoopFilings = 20;
/** Unanswered asks kept on the cursor, newest by their first ask; more than this many needs a plane down across that many distinct runs. */
export const retainedSlowLoopAsks = 4;

/** The item the loop files for a slow run: the release, the window's percentiles, the slowest step with its file, and the slowest call. */
export function slowLoopItem(release: string, window: readonly CycleMetrics[], cycleTime: ReturnType<typeof cycleTimes>): SlowLoopItemInput {
  const { slowest, call, perCycle } = slowLoopWindow(window);
  const step = slowest?.step ?? 'unrecorded', file = slowest?.file ?? null, short = release.slice(0, 12);
  const cycles = perCycle.map(entry => `cycle ${entry.cycle} ${seconds(entry.durationMs)}${slowest ? ` (${step} ${seconds(entry.stepMs)})` : ''}`).join(', ');
  const usual = cycleTime.p50Ms === null ? 'no cycle completed in the window' : `cycle p50 ${seconds(cycleTime.p50Ms)} and p95 ${seconds(cycleTime.p95Ms ?? cycleTime.p50Ms)} over ${cycleTime.cycles} cycle(s) in the last ${Math.round(cycleTime.windowMs / 60_000)} minutes`;
  const stepLine = slowest ? `The slowest step across those cycles is ${step}${file ? ` (${file})` : ''}, ${seconds(slowest.ms)} in all.` : 'No cycle in the run recorded a step breakdown, so no step is named.';
  const callLine = call ? `The slowest external call recorded was ${call.kind} ${call.name}, ${seconds(call.ms)}${call.step ? ` in the ${call.step} step` : ''}.` : 'No external call of a second or more was recorded.';
  return {
    title: `The master loop is slow on release ${short}: the ${step} step holds cycles past ${seconds(slowCycleMs)}`.slice(0, 200), type: 'bug' as const, priority: 1,
    description: [
      `The master loop filed this item itself (GY-1775): ${window.length} consecutive cycles on the release it loaded, ${release}, each took longer than the ${seconds(slowCycleMs)} cycle bound (${cycles}); ${usual}. Every merge, decision and close in those cycles waited that long.`,
      `${stepLine} ${callLine}`,
      `Shorten the ${step} step${file ? ` in ${file}` : ''} rather than restarting a loop that is still cycling; \`graphyard master status\` shows each cycle's timings under daemon.metrics.timings and the loop's cycle time under daemon.cycleTime. The loop never closes this item: a later slow run on this release and step returns it, and a slow run on another release files its own.`,
    ].join('\n\n'),
    criteria: [{ id: 'AC-1', text: `The ${step} step${file ? ` (${file})` : ''} no longer holds the master loop's cycles past the ${seconds(slowCycleMs)} bound on a release descending from ${short}: the cause of its ${seconds(slowest?.ms ?? 0)} across cycles ${perCycle.map(entry => entry.cycle).join(', ')}${call ? ` (slowest call ${call.kind} ${call.name})` : ''} is removed or bounded, covered by a test that pins the bound`, proofs: ['unit:slow-loop-step-bounded'] }],
    ...(file ? { plannedFiles: [file] } : {}),
    reason: `${window.length} consecutive cycles on release ${short} passed the ${seconds(slowCycleMs)} cycle bound, the ${step} step slowest, and no open item names it`,
  };
}

/** The item filed for `release` and `step`, when the cursor records one. */
export const filedSlowLoopItem = (slowLoop: Pick<SlowLoopState, 'filed'> | null | undefined, release: string | null | undefined, step: string | null | undefined) =>
  release && step ? slowLoop?.filed[filedKey(release, step)] ?? null : null;

/**
 * Reads the run from the retained metrics: the trailing completed cycles past the bound, from the
 * cycle the loaded release was first counted at (a different release starts the run again; the
 * items it filed and the asks it never had answered are kept, so a release rolled back to is one
 * already filed for). The run is read rather than counted up because a cycle's metrics are persisted
 * before this is called: a loop that exits between the two leaves a cycle no count ever saw, and
 * reading the metrics counts it when the next cycle is. Returns the window to file for once the run
 * reaches `slowLoopCycles`, else null.
 */
export function noteSlowCycle(state: Pick<DaemonState, 'metrics' | 'release' | 'slowLoop'>): { release: string; window: CycleMetrics[] } | null {
  const last = state.metrics.at(-1);
  if (!last) return null;
  const release = state.release?.commit ?? null;
  if (state.slowLoop.release !== release) { state.slowLoop.release = release; state.slowLoop.sinceCycle = last.cycle; }
  let consecutive = 0;
  for (let index = state.metrics.length - 1; index >= 0; index -= 1) {
    const metrics = state.metrics[index];
    if (metrics.cycle < state.slowLoop.sinceCycle || !slow(metrics)) break;
    consecutive += 1;
  }
  state.slowLoop.consecutive = consecutive;
  if (!release || consecutive < slowLoopCycles) return null;
  return { release, window: state.metrics.slice(-slowLoopCycles) };
}

/**
 * The next ask for a record the plane has already answered or interrupted waits as the daemon's other
 * retries do (`readyToRetry`): an answered refusal backs off by its attempts rather than being asked
 * again on every slow cycle, and an ask a restart cut off (`started` from an earlier cycle: the loop
 * exited while the POST was in flight, or before the `done` record persisted) is asked again at once.
 */
export function slowLoopAskReady(previous: DaemonAction | undefined, cycle: number) {
  if (previous?.state === 'started') return previous.cycle < cycle;
  return readyToRetry(previous, cycle);
}

/** The oldest entries past a bound, by the order given. */
const beyond = <T>(entries: [string, T][], bound: number, older: (a: T, b: T) => number) => entries.length > bound ? entries.sort((a, b) => older(a[1], b[1])).slice(0, entries.length - bound) : [];

/**
 * Asks the control plane for `pending`: a filing first asked now, or one asked before that the plane
 * never answered. The body goes on the cursor before it is asked, with the `started` record's persist,
 * and is cleared by any answered reply: a retry after a lost reply — the plane did not answer, or
 * the loop exited while the POST was in flight or before the `done` record persisted — asks again
 * with the body as it was first asked, under the same key, and is answered with the item already
 * filed; the control plane fingerprints each Idempotency-Key's parsed body and refuses a key reused
 * with a different one, so a body rebuilt from a later window would be refused without end.
 */
async function askSlowLoopItem(state: DaemonState, effects: Pick<DaemonEffects, 'persist'> & { fileSlowLoopItem: NonNullable<DaemonEffects['fileSlowLoopItem']> }, now: () => number, pending: PendingSlowLoop, again: boolean): Promise<DaemonAction> {
  const { release, step, key, input } = pending, actionKey = slowLoopActionKey(release, step), previous = state.actions[actionKey], short = release.slice(0, 12);
  const attempts = previous?.state === 'done' ? 1 : (previous?.attempts ?? 0) + 1;
  state.slowLoop.pending[filedKey(release, step)] = pending;
  for (const [dropped] of beyond(Object.entries(state.slowLoop.pending).filter(([entry]) => entry !== filedKey(release, step)), retainedSlowLoopAsks - 1, (a, b) => Date.parse(a.at) - Date.parse(b.at))) delete state.slowLoop.pending[dropped];
  await record(state, actionKey, { kind: 'fault', work: null, principal: null, state: 'started',
    detail: again ? `Asking again for the slow master loop item on release ${short} (the ${step} step), with the body it was first asked under at cycle ${pending.cycles.at(-1)}: the control plane never answered`
      : `Filing one item for the slow master loop: ${slowLoopCycles} consecutive cycles past ${seconds(slowCycleMs)} on release ${short}, the ${step} step slowest`,
    attempts, cycle: state.cycle }, now(), effects.persist);
  try {
    const filed = await effects.fileSlowLoopItem(input, key);
    delete state.slowLoop.pending[filedKey(release, step)];
    if (!filed) return record(state, actionKey, { kind: 'fault', work: null, principal: null, state: 'done', detail: `Nothing filed for the slow master loop on release ${short}: the operator-agent identity is not provisioned`, attempts, cycle: state.cycle }, now(), effects.persist);
    state.slowLoop.filed[filedKey(release, step)] = { key: filed.key, step, file: input.plannedFiles?.[0] ?? null, cycle: pending.cycles.at(-1)!, at: new Date(now()).toISOString() };
    for (const [dropped] of beyond(Object.entries(state.slowLoop.filed), retainedSlowLoopFilings, (a, b) => a.cycle - b.cycle)) delete state.slowLoop.filed[dropped];
    return record(state, actionKey, { kind: 'fault', work: filed.key, principal: null, state: 'done', detail: `Filed ${filed.key} for the slow master loop on release ${short}: the ${step} step is the slowest across cycles ${pending.cycles.join(', ')}${again ? ' (the plane answered the ask it never answered before)' : ''}; a later slow run on this release and step returns it`, attempts, cycle: state.cycle }, now(), effects.persist);
  } catch (error) {
    // A control plane that did not answer refused nothing: the body stays pending and a later cycle
    // asks it again under the same key (GY-1344, GY-1345). An answered refusal is not kept: the plane
    // judged it, so a later run, after the backoff, may ask afresh what it then sees.
    const unanswered = planeWideRefusal(error);
    if (!unanswered) delete state.slowLoop.pending[filedKey(release, step)];
    return record(state, actionKey, { kind: 'fault', work: null, principal: null, state: 'failed', detail: `Could not file the item for the slow master loop on release ${short}${unanswered ? ' (the control plane did not answer, so it is asked again on a later cycle)' : ''}: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist, unanswered ? null : undefined);
  }
}

/**
 * After a completed cycle: reads the run and persists it when it moved, then settles each filing the
 * plane never answered whose record is ready (`slowLoopAskReady`) — on any cycle, whatever the run
 * or release now is, each on its own backoff — and files the fix item once the run reaches three slow
 * cycles on one release, as the operator-agent under the release-and-step idempotency key, when that
 * key is neither filed nor still being asked: an unanswered ask for one step never stands in for a
 * run whose slowest step is another. A later slow cycle whose window names the step already filed
 * files nothing and makes no request. Nothing is asked without the operator-agent identity
 * (`fileSlowLoopItem` absent), as the throughput owner does; the run is still read. Returns the last
 * record this cycle wrote, or null.
 */
export async function fileSlowLoopItem(state: DaemonState, effects: Pick<DaemonEffects, 'fileSlowLoopItem' | 'persist'>, now: () => number): Promise<DaemonAction | null> {
  const was = { release: state.slowLoop.release, sinceCycle: state.slowLoop.sinceCycle, consecutive: state.slowLoop.consecutive }, run = noteSlowCycle(state);
  const moved = state.slowLoop.release !== was.release || state.slowLoop.sinceCycle !== was.sinceCycle || state.slowLoop.consecutive !== was.consecutive;
  // The cycle's metrics were persisted before this call; the run is read from them, but the persisted record is what `master status` and the soak read.
  if (moved) { try { await effects.persist(state); } catch { /* the next cycle's write carries the run */ } }
  const file = effects.fileSlowLoopItem;
  if (!file) return null;
  const asking = { persist: effects.persist, fileSlowLoopItem: file };
  let last: DaemonAction | null = null;
  for (const pending of Object.values(state.slowLoop.pending).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    if (!slowLoopAskReady(state.actions[slowLoopActionKey(pending.release, pending.step)], state.cycle)) continue;
    last = await askSlowLoopItem(state, asking, now, pending, true);
  }
  if (!run) return last;
  const { release, window } = run, step = slowLoopWindow(window).slowest?.step ?? 'unrecorded';
  if (filedSlowLoopItem(state.slowLoop, release, step) || state.slowLoop.pending[filedKey(release, step)]) return last;
  const actionKey = slowLoopActionKey(release, step);
  if (!slowLoopAskReady(state.actions[actionKey], state.cycle)) return last;
  const parsed = slowLoopItemInputSchema.safeParse(slowLoopItem(release, window, cycleTimes(state.metrics, now())));
  // A body the create command would refuse is not asked: the record names what the plane would have said.
  if (!parsed.success) return record(state, actionKey, { kind: 'fault', work: null, principal: null, state: 'failed', detail: `Could not file the item for the slow master loop on release ${release.slice(0, 12)}: the body does not parse as the create command reads it: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 500)}`, attempts: (state.actions[actionKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
  return askSlowLoopItem(state, asking, now, { release, step, key: slowLoopIdempotencyKey(release, step), cycles: window.map(metrics => metrics.cycle), at: new Date(now()).toISOString(), input: parsed.data }, false);
}

/**
 * The filed item's key for `release` and the slowest step `step` of cycle `cycle`, for the slow-cycle
 * attention row: the item filed for that step, or — the step one cycle names may differ from the
 * window's — the newest item the run `cycle` belongs to filed. An item an earlier run filed, one a
 * fast cycle ended, concerns that run's step and is not claimed for another.
 */
export const slowLoopItemFor = (slowLoop: SlowLoopState | null | undefined, release: string | null | undefined, step: string | null | undefined, cycle: number | null | undefined): Work['key'] | null => {
  const exact = filedSlowLoopItem(slowLoop, release, step);
  if (exact) return exact.key;
  if (!slowLoop || !release || slowLoop.release !== release || cycle == null) return null;
  const runStart = cycle - slowLoop.consecutive + 1;
  const ofTheRun = Object.entries(slowLoop.filed).filter(([key, entry]) => key.startsWith(`${release}:`) && entry.cycle >= runStart).map(([, entry]) => entry).sort((a, b) => b.cycle - a.cycle);
  return ofTheRun[0]?.key ?? null;
};
