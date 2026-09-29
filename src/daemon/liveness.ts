// Concern: loop liveness — cycle cost, cycle-failure backoff, loop attention and the watchdog.
import { type AttentionItem, agentOwner } from '../master.js';
import { classified, noteFault } from '../model/fault-classes.js';
import { boundDaemonState, type CycleFailures, type CycleMetrics, type CycleStepName, type CycleSteps, type DaemonState, liveProcess, message, type StepCost } from './state.js';
import type { LatencyBudget, SilenceReport } from './metrics.js';
import type { DaemonEffects } from './effects.js';
import { slowestSteps } from '../master/timings.js';

// ---- The loop's own liveness ---------------------------------------------------------------
export type LoopState = 'running' | 'slow' | 'stalled' | 'absent';
export interface LoopLiveness { state: LoopState; lagMs: number | null; stalledAfterMs: number; cycle: number; lock: DaemonState['lock']; detail: string; restart: string; cost: CycleCost | null }

/**
 * What the last measured cycle cost, against the cadence it is judged on. A cycle is the loop's
 * whole clock: while one runs nothing else coordinates, so a cycle longer than the interval is the
 * interval, and a cycle past the two-interval liveness bound is indistinguishable from a stopped
 * loop unless the measurement says otherwise. The bound is compared against the cycle's own work
 * (`workMs`), never against what it spent waiting on children: a cycle that waited eighty seconds
 * on gh is a slow provider, and one that computed for eighty seconds is a slow loop — only the
 * second has a step to shorten, which `slowest` names.
 */
export interface CycleCost {
  cycle: number; at: string; durationMs: number; childWaitMs: number; workMs: number; intervalMs: number; stalledAfterMs: number;
  steps: CycleSteps | null;
  /** The step with the most of its own work, when any step worked at all. */
  slowest: { step: CycleStepName; ms: number; childWaitMs: number } | null;
  /** The step that waited longest on children, when any step waited at all. */
  longestWait: { step: CycleStepName; childWaitMs: number } | null;
  /** Both judged on `workMs`: the loop's own time, net of its child waits. */
  withinInterval: boolean; withinLivenessBound: boolean;
  /** The step breakdown as an operator sentence, longest first, each step's wait beside it. */
  breakdown: string;
  /** The cycle's three slowest timed steps by wall time (GY-616), slowest first. */
  slowestSteps: { step: string; ms: number }[];
}
/** A cycle whose wall time passes this raises a liveness attention naming its three slowest steps (GY-616). */
export const slowCycleMs = 60_000;
/** The window `master status` reports the cycle-time percentiles over (GY-616). */
export const cycleTimeWindowMs = 30 * 60_000;
const seconds = (ms: number) => `${Math.round(ms / 100) / 10}s`;
export function cycleCost(metrics: CycleMetrics | null | undefined, intervalMs: number): CycleCost | null {
  if (!metrics) return null;
  const steps = metrics.steps ?? null;
  const childWaitMs = metrics.childWaitMs ?? (steps ? Object.values(steps).reduce((total, step) => total + step.childWaitMs, 0) : 0);
  const workMs = metrics.workMs ?? Math.max(0, metrics.durationMs - childWaitMs);
  const ordered = steps ? (Object.entries(steps) as [CycleStepName, StepCost][]).sort((a, b) => (b[1].ms - b[1].childWaitMs) - (a[1].ms - a[1].childWaitMs)) : [];
  const slowest = ordered.length && ordered[0][1].ms - ordered[0][1].childWaitMs > 0 ? { step: ordered[0][0], ms: ordered[0][1].ms - ordered[0][1].childWaitMs, childWaitMs: ordered[0][1].childWaitMs } : null;
  const waits = ordered.filter(([, cost]) => cost.childWaitMs > 0).sort((a, b) => b[1].childWaitMs - a[1].childWaitMs);
  const longestWait = waits.length ? { step: waits[0][0], childWaitMs: waits[0][1].childWaitMs } : null;
  // The timed steps name what ran (`dispatch`, `merges`, `close`); the coarse buckets are the fallback for a cycle recorded before them.
  const slowestTimed = metrics.timings?.steps.length ? slowestSteps(metrics.timings, 3) : ordered.slice(0, 3).map(([step, cost]) => ({ step, ms: cost.ms }));
  return { cycle: metrics.cycle, at: metrics.at, durationMs: metrics.durationMs, childWaitMs, workMs, intervalMs, stalledAfterMs: 2 * intervalMs, steps, slowest, longestWait, slowestSteps: slowestTimed.map(step => ({ step: step.step, ms: step.ms })),
    withinInterval: workMs <= intervalMs, withinLivenessBound: workMs <= 2 * intervalMs,
    breakdown: ordered.length
      ? `${seconds(workMs)} of its own work and ${seconds(childWaitMs)} waiting on child processes; ${ordered.map(([step, cost]) => `${step} ${seconds(cost.ms)}${cost.childWaitMs ? ` (${seconds(cost.childWaitMs)} waiting)` : ''}`).join(', ')}`
      : 'no step breakdown was recorded for this cycle' };
}

/**
 * The median and 95th-percentile cycle wall time over the last 30 minutes (GY-616), from the cycles
 * the cursor keeps: what `master status` shows beside the last cycle, so one slow cycle reads
 * against the loop's usual cadence. Null percentiles when no cycle completed in the window.
 */
export function cycleTimes(metrics: Pick<CycleMetrics, 'at' | 'durationMs'>[], now: number, windowMs = cycleTimeWindowMs) {
  const durations = metrics.filter(entry => { const at = Date.parse(entry.at); return Number.isFinite(at) && at >= now - windowMs && at <= now; }).map(entry => entry.durationMs).sort((a, b) => a - b);
  const rank = (p: number) => durations.length ? durations[Math.min(durations.length - 1, Math.ceil(p * durations.length) - 1)] : null;
  return { windowMs, cycles: durations.length, p50Ms: rank(0.5), p95Ms: rank(0.95) };
}

/**
 * Whether the loop is cycling, from its own cursor. Nothing else in the installation notices a
 * coordinator that stopped: the work simply stops moving. Two intervals without a completed cycle
 * is a stall, and no lock at all — or a lock whose process is gone on this host — is an absence.
 * A measured cycle that itself accounts for the lag is `slow`, not stalled: the loop is inside a
 * long cycle, and the cost says whether that cycle is computing (a step to shorten) or waiting on
 * a child (a provider to look at), so nobody restarts a loop that is still cycling.
 */
export function loopLiveness(state: Pick<DaemonState, 'lock' | 'cycle' | 'lastCycleAt'> & Partial<Pick<DaemonState, 'failures' | 'metrics'>>, now: number, intervalMs: number, hostId?: string): LoopLiveness {
  const cost = cycleCost(state.metrics?.at(-1) ?? null, intervalMs);
  const lastCycleAt = state.lastCycleAt ? Date.parse(state.lastCycleAt) : Number.NaN;
  const lagMs = Number.isFinite(lastCycleAt) ? Math.max(0, now - lastCycleAt) : null;
  // A loop backing off from failed cycles is waiting on purpose, not hung: its bound is two
  // intervals past the retry it announced, so the backoff never reads as a stall to restart.
  const backoff = backingOff(state.failures, now);
  const stalledAfterMs = 2 * intervalMs + (backoff ? Math.max(0, backoff.dueAt - lastCycleAt) : 0);
  const restart = 'graphyard master restart (a supervised deployment restarts it on its own: systemctl --user restart graphyard-master)';
  const lock = state.lock;
  const gone = !!lock && !!hostId && lock.host === hostId && !liveProcess(lock.pid);
  if (!lock || gone) {
    return { state: 'absent', lagMs, stalledAfterMs, cycle: state.cycle, lock, restart, cost,
      detail: gone ? `No master loop is running: the cursor's lock (pid ${lock!.pid} on ${lock!.host}) names a process that is gone, last cycle ${state.lastCycleAt ?? 'never'}. Nothing is dispatching, deciding or merging until it is restarted.`
        : `No master loop holds this repository${state.lastCycleAt ? `; the last cycle was at ${state.lastCycleAt}` : ' and none has ever cycled'}. Nothing is dispatching, deciding or merging until it is started.` };
  }
  if (lagMs === null || lagMs > stalledAfterMs) {
    // The last measured cycle explains the lag while the lag is no longer than that cycle plus the
    // bound: the loop is inside another cycle like it. Past that, nothing explains the silence.
    const slow = cost && lagMs !== null && cost.durationMs > stalledAfterMs && lagMs <= cost.durationMs + stalledAfterMs;
    if (slow) return { state: 'slow', lagMs, stalledAfterMs, cycle: state.cycle, lock, restart, cost,
      detail: `The master loop (pid ${lock.pid} on ${lock.host}) has not completed a cycle for ${Math.round(lagMs / 1000)}s, past the two-interval bound of ${Math.round(stalledAfterMs / 1000)}s, but cycle ${cost.cycle} took ${Math.round(cost.durationMs / 1000)}s of its own: ${cost.breakdown}. The loop is inside a slow cycle, not stalled${cost.withinLivenessBound ? `: its own work fits the bound, and the time went to child processes${cost.longestWait ? ` in the ${cost.longestWait.step} step` : ''}` : cost.slowest ? `; the ${cost.slowest.step} step is the one to shorten` : ''}.` };
    return { state: 'stalled', lagMs, stalledAfterMs, cycle: state.cycle, lock, restart, cost,
      detail: `The master loop (pid ${lock.pid} on ${lock.host}) has not completed a cycle ${lagMs === null ? 'at all' : `for ${Math.round(lagMs / 1000)}s`}, past the two-interval bound of ${Math.round(stalledAfterMs / 1000)}s; cycle ${state.cycle} is stalled.` };
  }
  if (backoff) {
    return { state: 'running', lagMs, stalledAfterMs, cycle: state.cycle, lock, restart, cost,
      detail: `Cycle ${backoff.last.cycle} failed ${Math.round(lagMs / 1000)}s ago in ${describeFailingCall(backoff.last)} (${backoff.last.reason}); ${backoff.consecutive} consecutive failure(s), the next cycle is due at ${backoff.last.nextAt}` };
  }
  return { state: 'running', lagMs, stalledAfterMs, cycle: state.cycle, lock, restart, cost, detail: `Cycle ${state.cycle} completed ${Math.round(lagMs / 1000)}s ago` };
}

// ---- A cycle that fails (GY-119) -----------------------------------------------------------
/** Consecutive failed cycles after which `master status` raises an attention item naming the failing call. */
export const cycleFailureAttentionAfter = 3;
/** The backoff ceiling: the delay before the next cycle doubles from its start up to five minutes. */
export const cycleFailureCeilingMs = 300_000;
/**
 * How long to wait after a failed cycle, from `startMs`: the first failure waits that long, and each
 * consecutive failure doubles it, to the ceiling or `startMs` itself when that is longer. Under a
 * supervisor with a watchdog the ceiling is halved against the window (`cycleFailureCeiling`), so a
 * loop backing off is never mistaken for one that hung. The loop starts from `cycleFailureStart`.
 */
export const cycleFailureDelay = (consecutive: number, startMs: number, ceilingMs = cycleFailureCeilingMs) =>
  Math.min(startMs * 2 ** Math.max(0, consecutive - 1), Math.max(startMs, ceilingMs));
/**
 * Where the loop's failure backoff starts: the interval, or the responsive interval a cycle with
 * something actionable returns in when that is shorter (GY-187). A healthy loop is back in 30
 * seconds whenever there is work, so one transient failure must not cost it a five-minute idle
 * interval: with a 300 s interval the failures wait 30, 60, 120 s and on to the ceiling.
 */
export const cycleFailureStart = (intervalMs: number) => Math.min(intervalMs, actionableIntervalMs);
export const cycleFailureCeiling = (watchdogWindowMs: number | null) => watchdogWindowMs ? Math.min(cycleFailureCeilingMs, Math.floor(watchdogWindowMs / 2)) : cycleFailureCeilingMs;
export const describeFailingCall = (failure: Pick<NonNullable<CycleFailures['last']>, 'phase' | 'call'>) =>
  failure.phase === 'reload' ? 'the configuration reload' : failure.call ? `the ${failure.call} call` : 'the cycle itself';
/** The failed-cycle wait the loop is in, if any: the last failure with its retry still ahead (allowing one interval of slack). */
function backingOff(failures: CycleFailures | undefined, now: number) {
  const last = failures?.last;
  if (!failures || !last || failures.consecutive === 0) return null;
  const dueAt = Date.parse(last.nextAt);
  return Number.isFinite(dueAt) ? { last, consecutive: failures.consecutive, dueAt } : null;
}

/**
 * Records a rejection that escaped the cycle (or the configuration reload before it) as a failed
 * cycle: the counter advances, the failure and its cause are kept on the cursor, and the delay
 * before the next cycle is chosen from the consecutive count. The loop itself keeps cycling.
 */
export async function noteCycleFailure(state: DaemonState, error: unknown, phase: 'cycle' | 'reload', options: { now: number; intervalMs: number; ceilingMs?: number; persist: DaemonEffects['persist'] }) {
  const call = phase === 'reload' ? 'reload' : failingCall(error);
  const consecutive = state.failures.consecutive + 1;
  const delayMs = cycleFailureDelay(consecutive, cycleFailureStart(options.intervalMs), options.ceilingMs);
  const at = new Date(options.now).toISOString();
  const last = { cycle: state.cycle, at, phase, call, reason: message(error).slice(0, 1000), delayMs, nextAt: new Date(options.now + delayMs).toISOString() };
  state.failures = { ...state.failures, consecutive, total: state.failures.total + 1, last };
  // A run of failures reaching the attention bound is one loop fault instance (GY-173), not one per retry.
  if (consecutive === cycleFailureAttentionAfter) noteFault(state.faults, { ...classified('loop-failures'), subject: 'loop', text: `${consecutive} consecutive failed cycles, the last in ${describeFailingCall(last)}: ${last.reason}` }, at);
  // The cycle ended, failed, and the loop is alive: the counter and the heartbeat both say so.
  state.cycle += 1;
  state.lastCycleAt = at;
  if (state.lock) state.lock = { ...state.lock, heartbeatAt: at };
  try { await options.persist(state); } catch { /* a cursor that cannot be written is the next cycle's failure, not this one's */ }
  return last;
}
/** A completed cycle ends the run of failures; the total stays. */
export function noteCycleSuccess(state: DaemonState) {
  const recovered = state.failures.consecutive;
  if (recovered) state.failures = { ...state.failures, consecutive: 0 };
  return recovered;
}
/** Records an unhandled rejection or uncaught exception the process caught and survived. */
export function noteUnhandled(state: DaemonState, error: unknown, origin: 'unhandledRejection' | 'uncaughtException', now: number) {
  const entry = { at: new Date(now).toISOString(), origin, reason: message(error).slice(0, 1000), cycle: state.cycle };
  state.failures = { ...state.failures, unhandled: state.failures.unhandled + 1, lastUnhandled: entry };
  return entry;
}
const callTag = Symbol.for('graphyard.daemonCall');
const failingCall = (error: unknown) => { const call = (error as { [callTag]?: unknown } | null)?.[callTag]; return typeof call === 'string' ? call : null; };
/**
 * The same effects, with every rejection or throw tagged with the name of the effect it escaped
 * from, so a failed cycle can say which call failed — `snapshot`, `credentials`, `merge` — rather
 * than only what the runtime said about it. The tag is a symbol on the error; nothing else changes.
 */
export function namedEffects(effects: DaemonEffects): DaemonEffects {
  const tag = (error: unknown, name: string) => { if (error && typeof error === 'object' && !(callTag in error)) Object.defineProperty(error, callTag, { value: name, enumerable: false }); return error; };
  return new Proxy(effects, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      return (...args: unknown[]) => {
        let result: unknown;
        try { result = value.apply(target, args); } catch (error) { throw tag(error, property); }
        return result instanceof Promise ? result.catch(error => { throw tag(error, property); }) : result;
      };
    },
  });
}

/**
 * The same effects, with every cursor write fitted to the schema's bounds first (`boundDaemonState`),
 * whoever does the writing. No value any step computes can then fail the write that follows it.
 */
export function boundedPersist(effects: DaemonEffects): DaemonEffects {
  const persist = (state: DaemonState) => effects.persist(boundDaemonState(state));
  return new Proxy(effects, { get: (target, property, receiver) => property === 'persist' ? persist : Reflect.get(target, property, receiver) });
}

/**
 * The loop's own attention, ahead of every work item: a coordinator that is not cycling is why
 * nothing else on the list is moving. A breached silence bound or latency budget follows it.
 */
export function loopAttention(report: { liveness: LoopLiveness; silence?: SilenceReport | null; budget?: LatencyBudget | null; failures?: CycleFailures | null; cost?: CycleCost | null }): AttentionItem[] {
  const items: AttentionItem[] = [];
  const cost = report.cost ?? report.liveness.cost;
  // What to do about a long cycle depends on where its time went: a step that computed too long
  // is shortened; one that waited on a child is a provider or a runtime to look at, and since
  // GY-125 that wait blocks nothing else in the process. Neither is a restart.
  const shorten = cost?.withinLivenessBound && cost.longestWait
    ? `graphyard master status shows the last cycle's step breakdown under daemon.cost; the time went to child processes in the ${cost.longestWait.step} step (${Math.round(cost.longestWait.childWaitMs / 1000)}s), so look at what Herdr, gh or git is slow on rather than restarting a loop that is still cycling`
    : cost?.slowest ? `graphyard master status shows the last cycle's step breakdown under daemon.cost; shorten the ${cost.slowest.step} step rather than restarting a loop that is still cycling`
      : 'graphyard master status shows the last cycle under daemon.cost';
  if (report.liveness.state !== 'running') items.push({ subject: 'loop', text: report.liveness.detail, ...agentOwner('master', report.liveness.state === 'slow' ? shorten : report.liveness.restart), ...classified('loop-liveness') });
  // A cycle whose own work does not fit its interval is raised whatever the lag says: the loop
  // looks healthy the instant a long cycle ends, and the cost is the only reading that names
  // what took the time. A cycle that merely waited is reported net: its work fit, and the wait is
  // in the breakdown for anyone reading it.
  if (cost && !cost.withinInterval && report.liveness.state !== 'slow' && report.liveness.state !== 'absent') {
    items.push({ subject: 'loop', text: `Cycle ${cost.cycle} spent ${Math.round(cost.workMs / 1000)}s on its own work, longer than the ${Math.round(cost.intervalMs / 1000)}s interval${cost.withinLivenessBound ? '' : ` and past the two-interval liveness bound of ${Math.round(cost.stalledAfterMs / 1000)}s`} (${Math.round(cost.durationMs / 1000)}s in all, ${Math.round(cost.childWaitMs / 1000)}s of it waiting on child processes): ${cost.breakdown}${cost.slowest ? `. The ${cost.slowest.step} step is the slowest, at ${Math.round(cost.slowest.ms / 1000)}s of work` : ''}`, ...agentOwner('master', shorten), ...classified('loop-cost') });
  }
  // A cycle that keeps failing is retried in-process with backoff; past the bound it names the
  // failing call, because a restart would not clear a read that times out every time.
  const failures = report.failures;
  if (failures?.last && failures.consecutive >= cycleFailureAttentionAfter) items.push({ subject: 'loop',
    text: `The master loop has failed ${failures.consecutive} consecutive cycles, the last (cycle ${failures.last.cycle} at ${failures.last.at}) in ${describeFailingCall(failures.last)}: ${failures.last.reason}. It keeps cycling in-process, waiting ${Math.round(failures.last.delayMs / 1000)}s before the next attempt (due ${failures.last.nextAt}); a restart does not clear this`,
    ...agentOwner('master', `graphyard master status shows daemon.failures with the failing call and its reason; clear what ${describeFailingCall(failures.last)} is refusing on`), ...classified('loop-failures') });
  const silence = report.silence;
  if (silence?.breached && silence.longest) items.push({ subject: silence.longest.work ?? 'loop', text: `Nothing has acted on ${silence.longest.detail} for ${Math.round(silence.longest.idleMs / 60_000)} minutes, past the ${Math.round(silence.budgetMs / 60_000)}-minute bound, while ${silence.actionable} subject(s) were actionable`,
    ...agentOwner('master', `graphyard master status shows the cycle's actions under daemon.actions; ${report.liveness.state === 'running' ? 'clear what is refusing the action' : report.liveness.state === 'slow' ? shorten : report.liveness.restart}`), ...classified('loop-silence') });
  if (report.budget?.met === false) items.push({ subject: 'loop', text: `The unattended delivery budget is not met: ${report.budget.reasons.join('; ')}`,
    ...agentOwner('master', 'graphyard master status shows daemon.budget with every measured passage; clear what is holding the breached step'), ...classified('delivery-budget') });
  return items;
}

/**
 * A cycle longer than a minute (GY-616), whatever its time divided into: the cost lines above judge
 * the loop's own work net of its child waits, which is right for "shorten a step or look at a
 * provider", but every merge, decision and close in a cycle waits for the whole of it, waiting
 * included. This liveness attention names the cycle's wall time and its three slowest steps, so a
 * burst of launches or a slow provider holding the delivery steps back is seen, not read as work.
 */
export function slowCycleAttention(report: { liveness: Pick<LoopLiveness, 'state'>; cost?: CycleCost | null; cycleTime?: ReturnType<typeof cycleTimes> | null }): AttentionItem[] {
  const cost = report.cost;
  if (!cost || cost.durationMs <= slowCycleMs || report.liveness.state === 'absent') return [];
  const usual = report.cycleTime?.p50Ms != null ? ` (p50 ${seconds(report.cycleTime.p50Ms)}, p95 ${seconds(report.cycleTime.p95Ms ?? report.cycleTime.p50Ms)} over the last ${Math.round(report.cycleTime.windowMs / 60_000)} minutes)` : '';
  return [{ subject: 'loop', text: `Cycle ${cost.cycle} took ${seconds(cost.durationMs)}, past the ${seconds(slowCycleMs)} cycle bound${usual}, and every merge, decision and close in it waited that long; slowest steps: ${cost.slowestSteps.map(step => `${step.step} ${seconds(step.ms)}`).join(', ') || 'none recorded'}`,
    ...agentOwner('master', `graphyard master status shows the cycle's timings under daemon.metrics.timings and the loop's cycle time under daemon.cycleTime; shorten the ${cost.slowestSteps[0]?.step ?? 'slowest'} step rather than restarting a loop that is still cycling`), ...classified('loop-liveness') }];
}

/**
 * The supervisor's watchdog, when the loop runs under one. A cycle that hangs leaves the process
 * alive and the pipeline silent, which no `Restart=` setting notices; a keep-alive per cycle turns
 * a stalled cycle into a supervised restart. A window shorter than two intervals would restart a
 * healthy loop instead, so that is refused by name rather than obeyed.
 */
export function watchdogPlan(environment: Record<string, string | undefined>, intervalMs: number) {
  if (!environment.NOTIFY_SOCKET) return { supervised: false, windowMs: null as number | null, refusal: null as string | null };
  const microseconds = Number(environment.WATCHDOG_USEC);
  const windowMs = Number.isFinite(microseconds) && microseconds > 0 ? Math.round(microseconds / 1000) : null;
  const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;
  return { supervised: true, windowMs,
    refusal: windowMs !== null && windowMs <= 2 * intervalMs
      ? `The supervisor's watchdog window (${seconds(windowMs)}) is not longer than two cycle intervals (${seconds(2 * intervalMs)}); raise WatchdogSec or shorten run.intervalSeconds, or the supervisor will restart a healthy loop mid-cycle`
      : null };
}

/**
 * How long to wait before the next cycle. A configured interval is the idle cadence, not a bound
 * on how long claimable work may sit: while anything is actionable the loop comes back inside the
 * responsive window, so a long interval cannot push ready work past its dispatch budget.
 */
export const actionableIntervalMs = 30_000;
export const cycleDelay = (intervalMs: number, report: Pick<SilenceReport, 'actionable'> | null) =>
  report && report.actionable > 0 ? Math.min(intervalMs, actionableIntervalMs) : intervalMs;
