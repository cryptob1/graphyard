// Concern: loop liveness — cycle-failure backoff, loop attention, the progress watchdog and the supervisor's watchdog.
import { type AttentionItem, agentOwner } from '../master.js';
import { type Work } from '../model.js';
import { boundDaemonState, type CycleFailures, type DaemonState, initialPidNamespace, liveProcess, type LoopRelease, message, pidNamespace, type PromotionState } from './state.js';
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
 */
export function loopLiveness(state: Pick<DaemonState, 'lock' | 'cycle' | 'lastCycleAt'> & Partial<Pick<DaemonState, 'failures'>>, now: number, intervalMs: number, hostId?: string, probe: (pid: number, recorded?: string | null) => boolean | null = (pid, recorded) => lockPidProbe(pid, pidNamespace, recorded)): LoopLiveness {
  const lastCycleAt = state.lastCycleAt ? Date.parse(state.lastCycleAt) : Number.NaN;
  const lagMs = Number.isFinite(lastCycleAt) ? Math.max(0, now - lastCycleAt) : null;
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
      detail: `The master loop (pid ${lock.pid} on ${lock.host}) has not completed a cycle ${lagMs === null ? 'at all' : `for ${Math.round(lagMs / 1000)}s`}, past the two-interval bound of ${Math.round(stalledAfterMs / 1000)}s; cycle ${state.cycle} is stalled${unprobed}.` };
  }
  if (backoff) {
    return { state: 'running', lagMs, stalledAfterMs, cycle: state.cycle, lock, restart,
      detail: `Cycle ${backoff.last.cycle} failed ${Math.round(lagMs / 1000)}s ago in ${describeFailingCall(backoff.last)} (${backoff.last.reason}); ${backoff.consecutive} consecutive failure(s), the next cycle is due at ${backoff.last.nextAt}${unprobed}` };
  }
  return { state: 'running', lagMs, stalledAfterMs, cycle: state.cycle, lock, restart, detail: `Cycle ${state.cycle} completed ${Math.round(lagMs / 1000)}s ago${unprobed}` };
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
 * The same effects, with every cursor write fitted to the schema's bounds first (`boundDaemonState`),
 * whoever does the writing. No value any step computes can then fail the write that follows it.
 */
export function boundedPersist(effects: DaemonEffects): DaemonEffects {
  const persist = (state: DaemonState) => effects.persist(boundDaemonState(state));
  return new Proxy(effects, { get: (target, property, receiver) => property === 'persist' ? persist : Reflect.get(target, property, receiver) });
}

/**
 * The loop's own attention, ahead of every work item: a coordinator that is not cycling is why
 * nothing else on the list is moving.
 */
export function loopAttention(report: { liveness: LoopLiveness; /** Retired (GY-1980): always null, ignored. */ silence?: null; failures?: CycleFailures | null }): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (report.liveness.state !== 'running') items.push({ subject: 'loop', text: report.liveness.detail, ...agentOwner('master', report.liveness.restart) });
  // A cycle that keeps failing is retried in-process with backoff; past the bound it names the
  // failing call, because a restart would not clear a read that times out every time.
  const failures = report.failures;
  if (failures?.last && failures.consecutive >= cycleFailureAttentionAfter) items.push({ subject: 'loop',
    text: `The master loop has failed ${failures.consecutive} consecutive cycles, the last (cycle ${failures.last.cycle} at ${failures.last.at}) in ${describeFailingCall(failures.last)}: ${failures.last.reason}. It keeps cycling in-process, waiting ${Math.round(failures.last.delayMs / 1000)}s before the next attempt (due ${failures.last.nextAt}); a restart does not clear this`,
    ...agentOwner('master', `graphyard master status shows daemon.failures with the failing call and its reason; clear what ${describeFailingCall(failures.last)} is refusing on`) });
  return items;
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
export const cycleDelay = (intervalMs: number, actionable: number) => actionable > 0 ? Math.min(intervalMs, actionableIntervalMs) : intervalMs;

// ---- The progress watchdog (GY-1980) --------------------------------------------------------
/** Nothing may go without progress longer than this: one line, never an item. */
export const progressStallMs = 60 * 60_000;
/** A merged change may wait this long past the running release before one line says so. */
export const releaseLagMs = 90 * 60_000;
/** The stages whose items the watchdog counts as open: everything between claim and merge, and ready work. */
const watchdogOpenStages: ReadonlySet<Work['stage']> = new Set(['ready', 'build', 'review', 'test', 'acceptance', 'merge']);
const parseInstant = (value: string | null | undefined): number | null => { const at = value ? Date.parse(value) : Number.NaN; return Number.isFinite(at) ? at : null; };

/** One watchdog line: the open item that has waited longest in its stage. */
const stalledOpenItem = (work: readonly Work[]) =>
  work.flatMap(item => { const at = parseInstant(item.stageEnteredAt); return at === null ? [] : [{ item, at }]; }).sort((a, b) => a.at - b.at)[0] ?? null;

/**
 * The stall watchdog (GY-1980): the one reading a busy-but-frozen pipeline needs, where the
 * per-subject silence record used to sit — a record a retrying loop kept resetting, so nothing
 * ever looked stalled. Both lines are pure judgements over the snapshot and the release reading
 * the cursor already keeps, and persist nothing. Thresholds are the module constants above, not settings.
 *
 * (a) No progress: while any item is open, the latest progress instant is the newest of every
 *     item's `stageEnteredAt`, every delivery's `mergedAt` and the release's `promotedAt`; when
 *     that is older than `progressStallMs`, one line names it and the open item that has waited
 *     longest in its stage.
 * (b) Release lag: the merged items whose `delivery.mergedAt` is later than the release's
 *     `promotedAt` — every merged item when no release reading stands — wait `releaseLagMs` past
 *     their oldest before one line counts them and names that oldest merge. Every merged item
 *     behind the release is progress; none is lag.
 */
export function progressAttention(work: readonly Work[], release: Pick<PromotionState, 'promotedAt'> | null | undefined, now: number): AttentionItem[] {
  const items: AttentionItem[] = [];
  const open = work.filter(item => watchdogOpenStages.has(item.stage));
  const merged = work.flatMap(item => { const at = parseInstant(item.delivery?.mergedAt); return at === null ? [] : [{ key: item.key, at }]; });
  const promotedAt = parseInstant(release?.promotedAt ?? null);
  if (open.length) {
    const progress = [...work.map(item => parseInstant(item.stageEnteredAt)), ...merged.map(entry => entry.at), promotedAt]
      .filter((at): at is number => at !== null);
    const newest = progress.length ? Math.max(...progress) : null;
    const waited = stalledOpenItem(open);
    if (newest !== null && waited && now - newest > progressStallMs)
      items.push({ subject: waited.item.key,
        text: `Nothing has progressed for ${Math.round((now - newest) / 60_000)} minutes (since ${new Date(newest).toISOString()}): ${waited.item.key} has been in ${waited.item.stage} since ${waited.item.stageEnteredAt}`,
        ...agentOwner('master', `graphyard master status names what holds ${waited.item.key} in ${waited.item.stage}; judge and clear that wait — a restart clears only a loop that has stopped cycling, and this one says it has not`) });
  }
  const unreleased = merged.filter(entry => promotedAt === null || entry.at > promotedAt);
  const oldest = unreleased.slice().sort((a, b) => a.at - b.at)[0] ?? null;
  if (oldest && now - oldest.at > releaseLagMs)
    items.push({ subject: 'release',
      text: `${unreleased.length} merged change(s) have not reached the running release for ${Math.round((now - oldest.at) / 60_000)} minutes; the oldest is ${oldest.key} merged at ${new Date(oldest.at).toISOString()}; ${promotedAt === null ? 'no release has been observed' : `the release last moved at ${new Date(promotedAt).toISOString()}`}`,
      ...agentOwner('master', 'graphyard master status shows the continuous deploy under promotion; judge why the release has not moved onto the merged heads and unblock it — the merges themselves are delivered') });
  return items;
}

