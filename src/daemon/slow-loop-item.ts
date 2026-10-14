// Concern: GY-1775 — a loop slower than its bound across three cycles files its own fix item, naming
// the slowest step and the slowest external call, so a regression is owned by an item rather than
// found by a human reading p50 (GY-1766 was filed by hand after the decisions step held cycles at 121 s).
import { planeWideRefusal } from '../model/blocker-class.js';
import type { CallTiming } from '../master/timings.js';
import type { Work } from '../model.js';
import type { DaemonEffects } from './effects.js';
import { cycleTimes, slowCycleMs } from './liveness.js';
import { record } from './preserve.js';
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

/** The item the loop files for a slow run: the release, the window's percentiles, the slowest step with its file, and the slowest call. */
export function slowLoopItem(release: string, window: readonly CycleMetrics[], cycleTime: ReturnType<typeof cycleTimes>) {
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
export type SlowLoopItemInput = ReturnType<typeof slowLoopItem>;

/** The item filed for `release` and `step`, when the cursor records one. */
export const filedSlowLoopItem = (slowLoop: Pick<SlowLoopState, 'filed'> | null | undefined, release: string | null | undefined, step: string | null | undefined) =>
  release && step ? slowLoop?.filed[filedKey(release, step)] ?? null : null;

/**
 * Counts the completed cycle just recorded against the run: a cycle past the bound on the release
 * the loop loaded extends it, one within the bound ends it, and a different release starts it again
 * (the items filed for other releases are dropped with it). Returns the window to file for once
 * the run reaches `slowLoopCycles`, else null.
 */
export function noteSlowCycle(state: Pick<DaemonState, 'metrics' | 'release' | 'slowLoop'>): { release: string; window: CycleMetrics[] } | null {
  const last = state.metrics.at(-1);
  if (!last) return null;
  const release = state.release?.commit ?? null;
  if (state.slowLoop.release !== release) state.slowLoop = { release, consecutive: 0, filed: {} };
  state.slowLoop.consecutive = slow(last) ? state.slowLoop.consecutive + 1 : 0;
  if (!release || state.slowLoop.consecutive < slowLoopCycles) return null;
  const window = state.metrics.slice(-slowLoopCycles);
  return window.length === slowLoopCycles && window.every(slow) ? { release, window } : null;
}

/**
 * After a completed cycle: files the fix item once the run reaches three slow cycles on one release,
 * as the operator-agent under the release-and-step idempotency key. A later slow cycle whose window
 * names the step already filed files nothing and makes no request; a retry after a lost reply asks
 * again under the same key and is answered with the item already filed. Nothing is filed without the
 * operator-agent identity (`fileSlowLoopItem` absent), as the throughput owner does.
 */
export async function fileSlowLoopItem(state: DaemonState, effects: Pick<DaemonEffects, 'fileSlowLoopItem' | 'persist'>, now: () => number): Promise<DaemonAction | null> {
  const run = noteSlowCycle(state);
  if (!run || !effects.fileSlowLoopItem) return null;
  const { release, window } = run;
  const input = slowLoopItem(release, window, cycleTimes(state.metrics, now())), step = slowLoopWindow(window).slowest?.step ?? 'unrecorded';
  if (filedSlowLoopItem(state.slowLoop, release, step)) return null;
  const key = slowLoopActionKey(release, step), previous = state.actions[key], attempts = previous?.state === 'done' ? 1 : (previous?.attempts ?? 0) + 1;
  await record(state, key, { kind: 'fault', work: null, principal: null, state: 'started', detail: `Filing one item for the slow master loop: ${window.length} consecutive cycles past ${seconds(slowCycleMs)} on release ${release.slice(0, 12)}, the ${step} step slowest`, attempts, cycle: state.cycle }, now(), effects.persist);
  try {
    const filed = await effects.fileSlowLoopItem(input, slowLoopIdempotencyKey(release, step));
    if (!filed) return record(state, key, { kind: 'fault', work: null, principal: null, state: 'done', detail: `Nothing filed for the slow master loop on release ${release.slice(0, 12)}: the operator-agent identity is not provisioned`, attempts, cycle: state.cycle }, now(), effects.persist);
    state.slowLoop.filed[filedKey(release, step)] = { key: filed.key, step, file: input.plannedFiles?.[0] ?? null, cycle: window.at(-1)!.cycle, at: new Date(now()).toISOString() };
    return record(state, key, { kind: 'fault', work: filed.key, principal: null, state: 'done', detail: `Filed ${filed.key} for the slow master loop on release ${release.slice(0, 12)}: the ${step} step is the slowest across cycles ${window.map(metrics => metrics.cycle).join(', ')}; a later slow run on this release and step returns it`, attempts, cycle: state.cycle }, now(), effects.persist);
  } catch (error) {
    // A control plane that did not answer refused nothing: the next slow cycle asks again under the same key (GY-1344, GY-1345).
    const unanswered = planeWideRefusal(error);
    return record(state, key, { kind: 'fault', work: null, principal: null, state: 'failed', detail: `Could not file the item for the slow master loop on release ${release.slice(0, 12)}${unanswered ? ' (the control plane did not answer, so it is filed on a later slow cycle)' : ''}: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist, unanswered ? null : undefined);
  }
}

/** The filed item's key for `release` and the slowest step `step`, for the slow-cycle attention row. */
export const slowLoopItemFor = (slowLoop: SlowLoopState | null | undefined, release: string | null | undefined, step: string | null | undefined): Work['key'] | null => {
  const exact = filedSlowLoopItem(slowLoop, release, step);
  if (exact) return exact.key;
  // The step named by one cycle may differ from the window's; the run's newest item still names the work.
  const forRelease = release ? Object.entries(slowLoop?.filed ?? {}).filter(([key]) => key.startsWith(`${release}:`)).map(([, entry]) => entry).sort((a, b) => b.cycle - a.cycle) : [];
  return forRelease[0]?.key ?? null;
};
