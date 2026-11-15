// Concern: loop liveness — cycle-failure backoff and the supervisor's watchdog.
import { boundDaemonState, type CycleFailures, type DaemonState, initialPidNamespace, liveProcess, message, pidNamespace } from './state.js';
import type { DaemonEffects } from './effects.js';

// ---- The loop's own liveness ---------------------------------------------------------------
export type LoopState = 'running' | 'stalled' | 'absent';
export interface LoopLiveness { state: LoopState; lagMs: number | null; stalledAfterMs: number; cycle: number; lock: DaemonState['lock']; detail: string; restart: string }

/**
 * Whether this reader can probe the lock's pid at all: a pid means something only in the PID
 * namespace it was taken in (GY-1370), and a sandbox with a namespace of its own sees no host
 * process. A lock that recorded no namespace was taken on the host, so only the host's initial
 * namespace probes it. Without /proc (macOS) there are no PID namespaces, so every reader probes.
 */
export function pidProbeable(lock: Pick<NonNullable<DaemonState['lock']>, 'pidNamespace'>, readerNamespace: string | null) {
  if (lock.pidNamespace) return readerNamespace === lock.pidNamespace;
  return readerNamespace === null || readerNamespace === initialPidNamespace;
}

/**
 * Whether the lock's process is alive as this reader can tell: true when it sees it, false when it
 * can probe the lock's namespace and does not, and null when it cannot probe it (a confined agent
 * session, GY-1369), where a pid it cannot see says nothing about the host.
 */
export function lockPidProbe(pid: number, namespace: () => string | null = pidNamespace, recorded?: string | null): boolean | null {
  return pidProbeable({ pidNamespace: recorded }, namespace()) ? liveProcess(pid) : null;
}

/** The probe's earlier name, kept for existing importers. */
export const hostPidProbe = lockPidProbe;

/**
 * Whether the loop is cycling, from its own cursor. Nothing else in the installation notices a
 * coordinator that stopped: the work simply stops moving. Two intervals without a completed cycle
 * is a stall, and no lock at all — or a lock whose process is gone on this host — is an absence. A reader that
 * cannot probe the pid (outside the lock's PID namespace) judges by the stall bound alone and says so.
 *
 * The lock's heartbeat (GY-3341), written as a cycle's steps settle, is progress inside a cycle: a
 * slow but progressing cycle is running however long its steps take, and only a loop with neither a
 * completed cycle nor progress inside one for the bound is stalled.
 */
export function loopLiveness(state: Pick<DaemonState, 'lock' | 'cycle' | 'lastCycleAt'> & Partial<Pick<DaemonState, 'failures'>>, now: number, intervalMs: number, hostId?: string, probe: (pid: number, recorded?: string | null) => boolean | null = (pid, recorded) => lockPidProbe(pid, pidNamespace, recorded)): LoopLiveness {
  const lastCycleAt = state.lastCycleAt ? Date.parse(state.lastCycleAt) : Number.NaN;
  const heartbeatAt = state.lock?.heartbeatAt ? Date.parse(state.lock.heartbeatAt) : Number.NaN;
  // Progress is the later of the two: a cycle that completed, or the heartbeat a long cycle's steps keep fresh.
  const progressedAt = [lastCycleAt, heartbeatAt].filter(Number.isFinite).reduce((latest, at) => Math.max(latest, at), -Number.MAX_VALUE);
  const lagMs = Number.isFinite(progressedAt) ? Math.max(0, now - progressedAt) : null;
  const inCycle = Number.isFinite(heartbeatAt) && (!Number.isFinite(lastCycleAt) || heartbeatAt > lastCycleAt);
  // A loop backing off from failed cycles is waiting on purpose, not hung: its bound is two
  // intervals past the retry it announced, so the backoff never reads as a stall to restart.
  const backoff = backingOff(state.failures, now);
  const stalledAfterMs = 2 * intervalMs + (backoff ? Math.max(0, backoff.dueAt - lastCycleAt) : 0);
  const restart = 'graphyard master restart (a supervised deployment restarts it on its own: systemctl --user restart graphyard-master)';
  const lock = state.lock;
  const alive = !!lock && !!hostId && lock.host === hostId ? probe(lock.pid, lock.pidNamespace) : true;
  const gone = alive === false;
  const unprobed = alive === null ? `; pid ${lock!.pid} could not be probed from this PID namespace (the lock was taken in ${lock!.pidNamespace ?? 'the host\'s initial one'}), so the cycle lag alone judges the loop` : '';
  if (!lock || gone) {
    return { state: 'absent', lagMs, stalledAfterMs, cycle: state.cycle, lock, restart,
      detail: gone ? `No master loop is running: the cursor's lock (pid ${lock!.pid} on ${lock!.host}) names a process that is gone, last cycle ${state.lastCycleAt ?? 'never'}. Nothing is dispatching, deciding or merging until it is restarted.`
        : `No master loop holds this repository${state.lastCycleAt ? `; the last cycle was at ${state.lastCycleAt}` : ' and none has ever cycled'}. Nothing is dispatching, deciding or merging until it is started.` };
  }
  if (lagMs === null || lagMs > stalledAfterMs) {
    return { state: 'stalled', lagMs, stalledAfterMs, cycle: state.cycle, lock, restart,
      detail: `The master loop (pid ${lock.pid} on ${lock.host}) has not completed a cycle ${lagMs === null ? 'at all' : `or shown progress for ${Math.round(lagMs / 1000)}s`}, past the two-interval bound of ${Math.round(stalledAfterMs / 1000)}s; cycle ${state.cycle} is stalled${unprobed}.` };
  }
  if (backoff) {
    return { state: 'running', lagMs, stalledAfterMs, cycle: state.cycle, lock, restart,
      detail: `Cycle ${backoff.last.cycle} failed ${Math.round(lagMs / 1000)}s ago in ${describeFailingCall(backoff.last)} (${backoff.last.reason}); ${backoff.consecutive} consecutive failure(s), the next cycle is due at ${backoff.last.nextAt}${unprobed}` };
  }
  return { state: 'running', lagMs, stalledAfterMs, cycle: state.cycle, lock, restart, detail: inCycle
    ? `Cycle ${state.cycle} is in progress, its last step settled ${Math.round(lagMs / 1000)}s ago${unprobed}`
    : `Cycle ${state.cycle} completed ${Math.round(lagMs / 1000)}s ago${unprobed}` };
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
 * The same effects, with every call that settles feeding the loop's heartbeat (GY-3341): a step of
 * many effects holds the supervisor's window open effect by effect — an object-valued effect (the
 * merge writer's reads) wraps its own calls the same way — so only work that truly stops, stops
 * telling the supervisor it is alive.
 */
export function markedEffects(effects: DaemonEffects, mark: () => void): DaemonEffects {
  const marked = (value: Function): Function => function (this: unknown, ...args: unknown[]) {
    let result: unknown;
    try { result = value.apply(this, args); } catch (error) { mark(); throw error; }
    if (result instanceof Promise) return result.finally(() => mark());
    mark();
    return result;
  } as Function;
  const markedObject = (target: object): object => new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      return typeof value === 'function' ? marked(value) : value;
    },
  });
  return new Proxy(effects, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'notify') return value;
      if (value !== null && typeof value === 'object') return markedObject(value as object);
      return typeof value === 'function' ? marked(value) : value;
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

/** The loop's keep-alive to its supervisor, fed on progress (GY-3341). */
export interface LoopHeartbeat {
  /** Records progress — a step settled, an effect answered, a cycle completed — and sends the keep-alive one is due. */
  mark(): void;
  /** Stops the heartbeat; the loop is stopping or restarting. */
  stop(): void;
}

/**
 * GY-3341: the supervisor's keep-alive, sent on progress rather than once per cycle. A slow host
 * made cycles that still progressed outlast the watchdog window, and systemd killed a healthy loop
 * mid-cycle. Every progress mark — each step that settles, each effect that answers, each cycle
 * that completes — sends the keep-alive when one is due (never more than one per third of the
 * window), and a timer holds the window open between marks while the last one is fresh. A loop
 * that makes no progress for the whole window sends nothing, so the supervisor restarts exactly
 * the loop that hung. Without a supervisor the heartbeat records progress for the cursor alone.
 */
export function loopHeartbeat(notify: () => void | Promise<void>, windowMs: number | null, options: { now?: () => number; log?: (line: string) => void } = {}): LoopHeartbeat {
  const now = options.now ?? Date.now;
  const nudgeMs = windowMs === null ? Number.POSITIVE_INFINITY : Math.max(250, Math.floor(windowMs / 3));
  let lastProgress = now(), lastBeat = Number.NaN;
  let timer: NodeJS.Timeout | undefined;
  const beat = () => {
    const at = now();
    if (Number.isFinite(lastBeat) && at - lastBeat < nudgeMs) return;
    lastBeat = at;
    void Promise.resolve(notify()).catch(error => options.log?.(`[graphyard-master] supervisor notification failed: ${message(error)}`));
  };
  if (windowMs !== null) {
    timer = setInterval(() => { if (now() - lastProgress <= windowMs) beat(); }, nudgeMs);
    timer.unref?.();
  }
  return {
    mark() { lastProgress = now(); beat(); },
    stop() { if (timer) clearInterval(timer); },
  };
}

/** The responsive interval a failed cycle's backoff starts from when the configured interval is longer. */
export const actionableIntervalMs = 30_000;
