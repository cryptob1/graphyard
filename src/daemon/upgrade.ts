// Concern: GY-437 — the loop upgrades its own checkout to the merged release, between cycles.
//
// After every merge the coordinator used to be restarted by hand: the loop verified deliveries
// against the deployed release and went on cycling the code it had loaded. The executors already
// record the release they loaded, and `master executors restart` brings the fleet back onto the
// checkout's commit; what was missing is the trigger. Between cycles — never mid-cycle — the loop
// now aligns its checkout with the base branch once the deployment step has verified a delivery
// is served — or, while production cannot be verified, once the checkout already holds code the
// running loop has not loaded (GY-1445) — and when the diff touches code the loop or the
// executors load, it restarts the fleet through `master executors restart` and then re-executes
// itself through the supervisor unit it runs under. A checkout that is dirty or not detached is
// never touched: the refusal is on the cursor, and `master status` names it until it clears.
import { readFileSync } from 'node:fs';
import type { ChildRun } from '../child-runner.js';
import { shortCommit, type ExecutorRestartResult } from '../executor-fleet.js';
import type { MasterConfig } from '../master.js';
import { alignLoopUnit, loopUnitOf } from '../supervisor.js';
import { promotionHolds, promotionWait } from '../master/release-lag.js';
import { storeAction, touchStanding, message, type DaemonState, type UpgradeStallCause } from './state.js';
import { detailChanged } from './decisions.js';

/**
 * Code the loop and the executors load: TypeScript modules and the package manifest. A diff that
 * touches none of this cannot change what a running process executes, so the checkout moves and
 * nothing is restarted.
 */
const loadedPrefixes = ['src/', 'scripts/', 'bin/'], loadedFiles = ['package.json'];
/** The action a failure before any restart attempt is recorded on (GY-1445): never one of the release's attempts. */
export const alignKey = 'upgrade:align';
/**
 * How long the loop waits on executors whose held claims refuse the fleet restart before it
 * re-executes onto the checkout by itself (GY-1473): half the loaded-revision resource's 30-minute
 * bound, so the loop loads the move within the bound even while a claim is held every cycle.
 */
export const fleetWaitMs = 15 * 60_000;
const sameCommit = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));
export function upgradeTouchesCode(paths: readonly string[]): boolean {
  return paths.some(path => loadedFiles.includes(path) || loadedPrefixes.some(prefix => path.startsWith(prefix)));
}

/** The supervisor unit the loop itself runs under, when systemd supervises it: read from the process's own cgroup, like an executor's. */
export const loopUnitPattern = /^graphyard-master(?:[@.-][A-Za-z0-9@._:-]*)?\.service$/;
export function detectLoopSupervisorUnit(options: { cgroup?: string | null } = {}): string | null {
  let cgroup = options.cgroup;
  if (cgroup === undefined) { try { cgroup = readFileSync('/proc/self/cgroup', 'utf8'); } catch { cgroup = null; } }
  const match = cgroup?.match(/\/(graphyard-master[^/\s]*\.service)(?:\/|$)/m);
  return match && loopUnitPattern.test(match[1]) ? match[1] : null;
}

/** How the coordinator checkout stands: its commit, whether HEAD is detached, and whether tracked files differ from the commit. */
export interface CheckoutState { commit: string | null; detached: boolean | null; dirty: boolean | null; branch: string | null }
export async function checkoutState(root: string, run: ChildRun): Promise<CheckoutState> {
  const git = (...args: string[]) => run('git', ['-C', root, ...args]);
  let commit: string | null;
  try { commit = (await git('rev-parse', 'HEAD')).trim() || null; }
  catch { return { commit: null, detached: null, dirty: null, branch: null }; }
  let detached: boolean | null = null, branch: string | null = null;
  try { branch = (await git('symbolic-ref', '-q', 'HEAD')).trim() || null; detached = branch ? false : null; }
  catch (error: any) { if (error?.status === 1) detached = true; }
  let dirty: boolean | null;
  try { dirty = (await git('status', '--porcelain', '--untracked-files=no')).trim().length > 0; } catch { dirty = null; }
  return { commit, detached, dirty, branch };
}

export type SelfUpgradeOutcome =
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'up-to-date'; commit: string }
  /** `forward`: a moved HEAD the recovery found to be merged code descending from the loaded commit, which it could not adopt by itself (GY-1359). */
  | { outcome: 'refused'; reason: string; commit: string | null; forward?: boolean }
  | { outcome: 'failed'; reason: string; forward?: boolean }
  /**
   * The checkout moved and the executor restart it owes waits on the cursor: refused (a claim still
   * held), which the next cycle retries. `self`: the loop still re-executed itself onto the checkout
   * (GY-1473), so what it runs never waits on the fleet's claims.
   */
  | { outcome: 'pending'; reason: string; to: string; self?: boolean }
  | { outcome: 'upgraded'; from: string | null; to: string; code: boolean; executors: ExecutorRestartResult | null; self: boolean };

/** The one line about an outcome, for the loop's log. */
export function describeSelfUpgrade(upgraded: SelfUpgradeOutcome): string {
  if (upgraded.outcome === 'skipped') return `skipped: ${upgraded.reason}`;
  if (upgraded.outcome === 'up-to-date') return `the checkout is current at ${shortCommit(upgraded.commit)}`;
  if (upgraded.outcome === 'refused') return `refused: ${upgraded.reason}`;
  if (upgraded.outcome === 'failed') return `failed: ${upgraded.reason}`;
  if (upgraded.outcome === 'pending') return `pending at ${shortCommit(upgraded.to)}: ${upgraded.reason}${upgraded.self ? '; the loop re-executes itself onto it meanwhile' : ''}`;
  return `checked out ${shortCommit(upgraded.to)}${upgraded.code ? '; loaded code moved' : '; no loaded code moved'}`
    + `${upgraded.executors ? `; executors ${upgraded.executors.result}${upgraded.executors.reason ? ` (${upgraded.executors.reason})` : ''}` : ''}`
    + `${upgraded.self ? '; the loop re-executes itself' : ''}`;
}

/**
 * Whether the awaited `systemctl --no-block restart` ended because the restart it queued began
 * (GY-916). The loop asks systemd to restart the very unit it runs in, so the queued stop signals
 * the unit's whole cgroup — the systemctl child and the loop alike — while the loop still awaits
 * that child. The child then dies on the stop's signal instead of exiting: that is the hand-off
 * succeeding, observable in the journal as Stopping → Stopped → Started in the same second. Both
 * halves are required: the child ended by a stop signal with no exit status and no timeout of its
 * own, and the loop itself received the stop during the wait (`awaitSupervisorRestart` marks it).
 * A child signalled by anything else, a systemctl that exited non-zero (no such unit, no user
 * bus, access denied), or one cut off by its own timeout is a genuine failure and is recorded.
 */
export function restartEndedBySupervisorStop(error: unknown): boolean {
  const ended = error as { signal?: unknown; status?: unknown; timedOut?: unknown; supervisorStop?: unknown } | null;
  return !!ended && typeof ended === 'object' && ended.supervisorStop === true && typeof ended.signal === 'string' && supervisorStopSignals.includes(ended.signal)
    && (ended.status === null || ended.status === undefined) && ended.timedOut !== true;
}
/** The signals a unit's stop delivers to its cgroup: KillSignal, then SIGKILL past TimeoutStopSec. */
const supervisorStopSignals = ['SIGTERM', 'SIGKILL'];
/** How long a signalled child waits for the loop's own stop signal to arrive beside it; both come from one stop. */
export const supervisorStopGraceMs = 2_000;
type SignalHost = Pick<NodeJS.EventEmitter, 'on' | 'removeListener'>;

/**
 * Runs the self-restart while watching for the supervisor's stop to reach this process (GY-916).
 * When the restart child fails on a signal, the stop that killed it reaches the loop in the same
 * instant, so it is awaited for at most `graceMs`; the failure is rethrown marked with whether it
 * came — the mark `restartEndedBySupervisorStop` requires.
 */
export async function awaitSupervisorRestart(restart: () => unknown, host: SignalHost = process, graceMs = supervisorStopGraceMs): Promise<void> {
  let stopped = false, wake: (() => void) | null = null;
  const onStop = () => { stopped = true; wake?.(); };
  host.on('SIGTERM', onStop);
  try { await restart(); }
  catch (error) {
    const signalled = !!error && typeof error === 'object' && typeof (error as { signal?: unknown }).signal === 'string';
    if (signalled && !stopped) await new Promise<void>(resolve => { const timer = setTimeout(resolve, graceMs); wake = () => { clearTimeout(timer); resolve(); }; });
    throw error && typeof error === 'object' ? Object.assign(error, { supervisorStop: stopped }) : error;
  } finally { host.removeListener('SIGTERM', onStop); }
}

/**
 * The running loop's unit brought back to its configuration before it re-executes through it
 * (GY-916): its watchdog window follows run.intervalSeconds. Only the packaged unit name is
 * rewritten, and only when the loop runs under it.
 */
export async function alignRunningLoopUnit(root: string, config: MasterConfig, unit = detectLoopSupervisorUnit()) {
  const own = loopUnitOf(root);
  if (unit !== own) return { wrote: 'none', reason: `this loop does not run under ${own}` };
  return alignLoopUnit({ root, cliPath: config.cliPath, repository: config.repository, intervalSeconds: config.run.intervalSeconds });
}

export interface SelfUpgradeDeps {
  /** The coordinator checkout: fetched, diffed and checked out here. */
  root: string;
  /** Every git command the alignment runs. */
  run: ChildRun;
  /** `master executors restart` against the checked-out tip, for a diff that touches loaded code. */
  restartExecutors?: (to: string) => Promise<ExecutorRestartResult>;
  /** Re-executes the loop through its own supervisor unit; a loop no unit supervises cannot. */
  restartSelf?: () => Promise<void>;
  /**
   * Rewrites the loop's supervisor unit when it no longer matches the running configuration
   * (`alignLoopUnit`), before the loop re-executes itself through it (GY-916).
   */
  alignUnit?: () => Promise<{ wrote: string; reason: string | null }>;
  now?: () => number;
  persist?: (state: DaemonState) => Promise<void>;
}

/**
 * The between-cycles alignment (GY-437). A verified deployment triggers it: the release
 * production serves is the truth the loop aligns with, not every merge that lands. While
 * production cannot be observed at all (GY-1445), a restart already owed — or a checkout that
 * holds code the running loop did not load — is still finished: the checkout is aligned with the
 * base tip and the owed restart attempted each pass, so an observation that never arrives cannot
 * pin the loop to stale code; a checkout an earlier pass already processed from the loaded commit
 * without loaded code is idle, never fetched again. A production observed serving none of the
 * awaited deliveries yet is no such gap: the promotion wait holds. Each pass that cannot complete
 * the restart records one named stall on the cursor (`upgrade.stalled`: its cause and latest
 * attempt); the pass that completes it removes it. Only a restart attempt refreshes the release's
 * action, the owed restart's attempt clock: a failure before one (a fetch, the checkout, a diff)
 * is recorded on `upgrade:align`, and a fetch that fails while a restart is owed onto the commit
 * the checkout holds still attempts it. A dirty or non-detached checkout is refused before
 * anything touches it. The executors are restarted first, through the shipped command whose
 * refusals (a claim in flight, another restart's fence) leave the owed restarts on the cursor for
 * the next cycle to finish; the loop's own re-execution is last, and everything the next process
 * needs to know is on the cursor before it goes. A refusal that has stood `fleetWaitMs` no longer
 * holds the loop (GY-1473): it re-executes onto the checkout alone, and the executor restart stays
 * owed for the process that starts. A loaded-code move production is observed not serving yet is
 * held (GY-1585): the checkout moves, but the executors and the loop restart onto it only once the
 * served release contains it, under the `release-lagged` stall. Nothing here throws: every failure
 * is a recorded action.
 */
export async function performSelfUpgrade(config: MasterConfig, state: DaemonState, deps: SelfUpgradeDeps): Promise<SelfUpgradeOutcome> {
  const now = deps.now ?? Date.now, at = () => new Date(now()).toISOString();
  const git = (...args: string[]) => deps.run('git', ['-C', deps.root, ...args]);
  const persist = async () => { if (deps.persist) await deps.persist(state); };
  const key = `upgrade:${state.deployment?.sha ?? 'none'}`, heldKey = 'upgrade:held';
  const note = async (detail: string, failure: boolean, actionKey = key) => {
    storeAction(state, actionKey, { kind: 'config', work: null, principal: null, state: failure ? 'failed' : 'done', detail, attempts: (state.actions[actionKey]?.attempts ?? 0) + 1, epoch: null, cycle: state.cycle, at: at() });
    await persist();
  };
  /** One named stall while its cause stands: `since` is kept, `at` is the latest attempt (GY-1445). */
  const stall = (cause: UpgradeStallCause, reason: string, prior = state.upgrade.stalled) => {
    const standing = prior?.cause === cause ? prior : null;
    state.upgrade.stalled = { cause, reason: reason.slice(0, 500), since: standing?.since ?? at(), at: at() };
  };
  const unstall = () => { delete state.upgrade.stalled; };
  const failed = async (reason: string, cause?: UpgradeStallCause): Promise<SelfUpgradeOutcome> => { if (cause) stall(cause, reason); await note(reason, true); return { outcome: 'failed', reason }; };
  /**
   * A failure before any restart is attempted (fetch, checkout read, diff, checkout): recorded on
   * its own `upgrade:align` action, never the release's, whose time is the owed restart's latest
   * attempt — an origin outage must not stand in for a restart that never ran (GY-1445).
   */
  const unaligned = async (reason: string, cause?: UpgradeStallCause): Promise<SelfUpgradeOutcome> => { if (cause) stall(cause, reason); await note(reason, true, alignKey); return { outcome: 'failed', reason }; };
  const refused = async (reason: string, commit: string | null, cause: UpgradeStallCause): Promise<SelfUpgradeOutcome> => {
    state.upgrade.refused = { at: at(), reason, commit };
    stall(cause, reason);
    await persist();
    const refusedKey = 'upgrade:refused', detail = `The loop left the coordinator checkout at ${shortCommit(commit)} untouched: ${reason}`;
    if (detailChanged(state.actions[refusedKey], detail)) {
      storeAction(state, refusedKey, { kind: 'config', work: null, principal: null, state: 'failed', detail, attempts: (state.actions[refusedKey]?.attempts ?? 0) + 1, epoch: null, cycle: state.cycle, at: at() });
      await persist();
    } else touchStanding(state, refusedKey, at());
    return { outcome: 'refused', reason, commit };
  };
  /**
   * The supervisor unit re-applied before the loop re-executes through it (GY-916): a unit whose
   * text drifted from the running configuration — a hand-copied example's watchdog window — is
   * rewritten, so the process the restart starts runs under the window the configuration needs.
   * A rewrite is a done action; a refusal is recorded once per distinct reason, never per pass.
   */
  const alignUnit = async () => {
    if (!deps.alignUnit) return;
    const unitKey = 'upgrade:unit';
    const aligned = await deps.alignUnit().catch(error => ({ wrote: 'refused', reason: message(error) }));
    if (aligned.wrote === 'updated' || aligned.wrote === 'created') {
      storeAction(state, unitKey, { kind: 'config', work: null, principal: null, state: 'done', detail: `The loop's supervisor unit no longer matched the running configuration and was rewritten (${aligned.wrote}); the restart that follows starts the loop under it`, attempts: (state.actions[unitKey]?.attempts ?? 0) + 1, epoch: null, cycle: state.cycle, at: at() });
      await persist();
    } else if (aligned.wrote === 'refused') {
      const detail = `The loop's supervisor unit does not match the running configuration and was not rewritten: ${aligned.reason ?? 'the rewrite was refused'}`;
      if (detailChanged(state.actions[unitKey], detail)) {
        storeAction(state, unitKey, { kind: 'config', work: null, principal: null, state: 'failed', detail, attempts: (state.actions[unitKey]?.attempts ?? 0) + 1, epoch: null, cycle: state.cycle, at: at() });
        await persist();
      }
    }
  };
  /**
   * The release production is observed serving, when it does not contain `commit` yet (GY-1585):
   * null while production is unobserved (GY-1445/GY-1464: an unobservable plane never pins the loop
   * on stale code), when the served release is the commit or descends from it, and when git cannot
   * place the two — only a definite "not an ancestor" (exit status 1) holds a restart.
   */
  const lagging = async (commit: string): Promise<string | null> => {
    if (!observed) return null;
    const served = observation!.sha!;
    if (sameCommit(served, commit)) return null;
    try { await git('merge-base', '--is-ancestor', commit, served); return null; }
    catch (error: any) { return error?.status === 1 ? served : null; }
  };
  /**
   * Completes the restarts one alignment owes, with the checkout already at the tip. A held restart
   * (GY-1585) the served release has since moved past aligns no release: the pass after it aligns
   * the checkout with what production serves now, so the loop does not stay on the held commit
   * until a later promotion.
   */
  const finish = async (pending: { from: string | null; to: string; code: boolean }, held = false): Promise<SelfUpgradeOutcome> => {
    const aligned = held && !sameCommit(release, pending.to) ? state.upgrade.alignedRelease : release ?? state.upgrade.alignedRelease;
    if (!pending.code) {
      state.upgrade.pending = null;
      state.upgrade.last = { at: at(), from: pending.from, to: pending.to, code: false, executors: null, self: false };
      state.upgrade.alignedRelease = aligned;
      state.upgrade.refused = null;
      unstall();
      await persist();
      return { outcome: 'upgraded', from: pending.from, to: pending.to, code: false, executors: null, self: false };
    }
    // GY-1585: loaded code restarted before the plane serves it speaks a protocol the serving
    // registry's strict schemas still refuse (400 Invalid input on every launch). While production
    // is observed serving a release that does not contain the move, the restart is held, owed on
    // the cursor under a named stall, and the first pass whose observation serves it completes it.
    // The hold is one `upgrade:held` row whichever release it was observed under, its attempts grown
    // only when what it names changes, its time the latest held pass (the owed restart's attempt clock
    // master status reads), and settled by the pass that lifts it: a standing hold grows nothing, and
    // no waiting row outlives the hold it describes.
    const lag = await lagging(pending.to);
    if (lag) {
      const reason = `restart held: production serves release ${shortCommit(lag)}, which does not contain ${shortCommit(pending.to)} yet; the executors and the loop restart onto ${shortCommit(pending.to)} on the first pass whose deployment observation serves it`;
      state.upgrade.pending = { from: pending.from, to: pending.to, code: true };
      stall('release-lagged', reason);
      const standing = state.actions[heldKey];
      if (standing?.state !== 'waiting' || detailChanged(standing, reason))
        storeAction(state, heldKey, { kind: 'config', work: null, principal: null, state: 'waiting', detail: reason, attempts: (standing?.attempts ?? 0) + 1, epoch: null, cycle: state.cycle, at: at() });
      else standing.at = at();
      await persist();
      return { outcome: 'pending', reason, to: pending.to };
    }
    if (state.actions[heldKey]?.state === 'waiting') {
      const lifted = observed ? `production serves release ${shortCommit(observation!.sha!)}, which contains ${shortCommit(pending.to)}` : 'production is no longer observed, and an unobserved plane never holds the loop on stale code';
      storeAction(state, heldKey, { kind: 'config', work: null, principal: null, state: 'done', detail: `The restart onto ${shortCommit(pending.to)} is no longer held: ${lifted}`, attempts: state.actions[heldKey]!.attempts, epoch: null, cycle: state.cycle, at: at() });
      await persist();
    }
    if (!deps.restartExecutors) return failed('loaded code moved but this loop cannot restart the executors', 'executors-unavailable');
    const executors = await deps.restartExecutors(pending.to).catch(error => ({ result: 'refused' as const, reason: message(error), coordinator: { commit: pending.to }, held: [], restarted: [], unsupervised: [], forgotten: [] }));
    if (executors.result === 'refused') {
      // The designed safety, not a fault (GY-916): a claim still held after the bounded wait. The
      // owed executor restart stays on the cursor as pending, the action is recorded waiting, and
      // the next cycle's pass finds the checkout at the tip and completes it.
      const reason = `the executors were not restarted: ${executors.reason ?? 'the restart was refused'}; the fleet stands down on the moved checkout on its own and the restart is retried next cycle`;
      state.upgrade.pending = { from: pending.from, to: pending.to, code: true };
      stall('executors-refused', reason);
      storeAction(state, key, { kind: 'config', work: null, principal: null, state: 'waiting', detail: reason, attempts: (state.actions[key]?.attempts ?? 0) + 1, epoch: null, cycle: state.cycle, at: at() });
      await persist();
      // The loop waits on the fleet's claims only so long (GY-1473): a busy fleet can hold one across
      // every cycle for hours, so once the refusal has stood `fleetWaitMs` the loop re-executes onto
      // the checkout by itself, the executor restart still owed on the cursor for the process that
      // starts. A loop already running the checkout's revision has nothing to re-execute.
      const waited = now() - Date.parse(state.upgrade.stalled?.since ?? at());
      if (!deps.restartSelf || sameCommit(state.release?.commit, pending.to) || waited < fleetWaitMs) return { outcome: 'pending', reason, to: pending.to };
      await alignUnit();
      try { await deps.restartSelf(); }
      catch (error) {
        if (restartEndedBySupervisorStop(error)) return { outcome: 'pending', reason, to: pending.to, self: true };
        const failure = `${reason}; the loop could not re-execute itself through its supervisor: ${message(error)}`;
        stall('supervisor-unreachable', failure);
        await persist();
        await note(`${failure}; it keeps running ${shortCommit(state.release?.commit ?? null)} until its supervisor restarts it`, true);
        return { outcome: 'failed', reason: failure };
      }
      return { outcome: 'pending', reason, to: pending.to, self: true };
    }
    // A loop that already re-executed onto this revision while the fleet held its claims runs it:
    // only the executors were owed, so it is not restarted again.
    const running = sameCommit(state.release?.commit, pending.to);
    // The cursor is written before the loop re-executes itself: the next process must find the
    // alignment complete, never repeat it. `self` is written true before the call, because the
    // process may not survive it; a failed re-execution writes it back to false.
    state.upgrade.last = { at: at(), from: pending.from, to: pending.to, code: true, executors: `${executors.result}${executors.reason ? `: ${executors.reason}` : ''}`, self: !running && !!deps.restartSelf };
    // The stall is retired before the loop re-executes, as the next process may never see it again;
    // a re-execution that fails restores it with its first attempt kept.
    const prior = state.upgrade.stalled;
    state.upgrade.pending = null;
    state.upgrade.alignedRelease = aligned;
    state.upgrade.refused = null;
    unstall();
    await persist();
    await note(`Checked out base tip ${shortCommit(pending.to)}${pending.from ? ` from ${shortCommit(pending.from)}` : ''}; loaded code moved, the executors were restarted (${executors.result})${executors.reason ? `: ${executors.reason}` : ''}`, false);
    if (running) return { outcome: 'upgraded', from: pending.from, to: pending.to, code: true, executors, self: false };
    if (!deps.restartSelf) return failed('loaded code moved and the executors were restarted, but this loop cannot re-execute itself', 'supervisor-unreachable');
    await alignUnit();
    try { await deps.restartSelf(); }
    catch (error) {
      // The supervisor's own stop ended the awaited child: the restart the loop asked for is under
      // way, so the alignment is complete and nothing failed (GY-916).
      if (restartEndedBySupervisorStop(error)) return { outcome: 'upgraded', from: pending.from, to: pending.to, code: true, executors, self: true };
      state.upgrade.last = { ...state.upgrade.last!, self: false };
      const reason = `the loop could not re-execute itself through its supervisor: ${message(error)}`;
      stall('supervisor-unreachable', reason, prior);
      await persist();
      await note(`${reason}; it keeps running ${shortCommit(state.release?.commit ?? null)} until its supervisor restarts it`, true);
      return { outcome: 'failed', reason };
    }
    // The supervisor has queued the restart; its stop signal ends this process during the wait.
    return { outcome: 'upgraded', from: pending.from, to: pending.to, code: true, executors, self: true };
  };

  // 1. The trigger: a delivery verified served by a release, from the deployment step's
  //    observation. This release already aligned is skipped, unless a restart it owes is pending.
  //    With no verified release (GY-1445) the pass still runs when a restart is owed or the
  //    checkout holds code the running loop did not load; only an idle checkout is skipped: one
  //    holding what the loop loaded, or one a completed pass already moved to without loaded code
  //    (a docs-only alignment restarts nothing, so the loaded commit never catches up with it) from
  //    what the loop loaded. Production observed — serving none of the awaited deliveries yet, or a
  //    release already aligned — leaves the checkout where it stands, but a checkout holding code
  //    the loop did not load still owes the restart onto its own HEAD (GY-1464): a re-execution
  //    that failed or never ended the process, or a move the loop did not make, must not pin the
  //    loop on stale code until the next promotion. Only the promotion wait the loaded-revision
  //    reading excuses holds it: the loop runs the release production serves and the promotion
  //    that would serve the rest is on schedule.
  const observation = state.deployment;
  const observed = !!observation && observation.source !== 'unavailable' && !!observation.sha;
  const release = observed && observation!.deployed.length ? observation!.sha : null;
  const unverified = !observed;
  const loaded = state.release?.commit ?? null;
  /** A move a completed pass already processed from what the loop loaded, touching no loaded code. */
  const processed = (head: string) => { const last = state.upgrade.last; return last?.to === head && last.code === false && last.from === loaded; };
  if (!state.upgrade.pending && (!release || state.upgrade.alignedRelease === release)) {
    const idle = release ? `release ${shortCommit(release)} was already aligned` : 'no delivered item is verified deployed yet';
    const head = loaded ? (await checkoutState(deps.root, deps.run)).commit : null;
    if (!head || head === loaded || processed(head)) return { outcome: 'skipped', reason: idle };
    if (observed) {
      if (promotionHolds(promotionWait(state), loaded, now())) return { outcome: 'skipped', reason: idle };
      // The restart owed onto the checkout's own HEAD, with no fetch and no move.
      let code: boolean;
      try { code = upgradeTouchesCode((await git('diff', '--name-only', `${loaded}..${head}`)).split('\n').map(path => path.trim()).filter(Boolean)); }
      catch (error) { return unaligned(`the diff from ${shortCommit(loaded)} to ${shortCommit(head)} could not be read: ${message(error)}`, 'checkout-failed'); }
      state.upgrade.pending = { from: loaded, to: head, code };
      await persist();
      return finish(state.upgrade.pending);
    }
  }

  // A restart held for the release (GY-1585) completes on the first pass whose observation serves
  // the commit the checkout holds — or on which production is unobserved — before a newer tip is fetched: moving on to a tip the promotion
  // has not served yet would hold it again, and a busy base branch would hold the loop forever.
  // While the release still lags, the pass holds the same target without fetching: advancing it to
  // every newer tip would keep it ahead of each promotion, and the loop would never restart.
  const held = state.upgrade.pending;
  if (held?.code && state.upgrade.stalled?.cause === 'release-lagged' && (await checkoutState(deps.root, deps.run)).commit === held.to) return finish(held, true);

  // 2. The base tip, from a fresh fetch.
  let to: string;
  try {
    await git('fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${config.baseBranch}:refs/remotes/origin/${config.baseBranch}`);
    to = (await git('rev-parse', `refs/remotes/origin/${config.baseBranch}^{commit}`)).trim();
  } catch (error) {
    // A restart already owed onto the commit the checkout holds needs no fetch: it is attempted, so
    // an origin outage never holds the loop on stale code (GY-1445). A newer tip waits for the next
    // pass that can fetch.
    const owed = state.upgrade.pending;
    if (owed && (await checkoutState(deps.root, deps.run)).commit === owed.to) return finish(owed);
    return unaligned(`the base branch could not be fetched: ${message(error)}`, 'fetch-failed');
  }

  // 3. How this checkout stands, before anything touches it.
  const checkout = await checkoutState(deps.root, deps.run);
  if (!checkout.commit) return unaligned(`the coordinator checkout at ${deps.root} could not be read`);
  if (to === checkout.commit) {
    // The checkout already holds the tip: finish what an earlier pass still owes, or align and
    // clear a refusal that no longer describes anything.
    if (state.upgrade.pending) return finish(state.upgrade.pending);
    // The tip itself is code the running loop never loaded: the restart onto it is owed, verified
    // or not (GY-1464), unless a completed pass already processed it without loaded code.
    if (loaded && loaded !== to && !processed(to)) {
      let code: boolean;
      try { code = upgradeTouchesCode((await git('diff', '--name-only', `${loaded}..${to}`)).split('\n').map(path => path.trim()).filter(Boolean)); }
      catch (error) { return unaligned(`the diff from ${shortCommit(loaded)} to ${shortCommit(to)} could not be read: ${message(error)}`, 'checkout-failed'); }
      state.upgrade.pending = { from: loaded, to, code };
      await persist();
      return finish(state.upgrade.pending);
    }
    const cleared = !!state.upgrade.refused;
    state.upgrade.alignedRelease = release ?? state.upgrade.alignedRelease;
    state.upgrade.refused = null;
    unstall();
    await persist();
    if (cleared) await note(`The checkout is current at ${shortCommit(to)}; the earlier refusal is cleared`, false);
    return { outcome: 'up-to-date', commit: to };
  }
  if (checkout.detached !== true) return refused(`HEAD holds ${checkout.branch ?? 'a branch'} instead of standing detached; it is upgraded only as a clean detached checkout of ${config.baseBranch}`, checkout.commit, 'checkout-not-detached');
  if (checkout.dirty === true) return refused('tracked files differ from the commit it holds; it is upgraded only clean', checkout.commit, 'checkout-dirty');

  // 4. What the move would change, then the move itself.
  //    A restart still owed for an earlier move stays owed: a docs-only move on top of a src/ one
  //    leaves the fleet as stale as the src/ move did.
  const owed = state.upgrade.pending?.code === true;
  if (state.upgrade.pending) { state.upgrade.pending = null; await persist(); }
  //    Unverified, what the running loop loaded is the base of the diff: the checkout may already
  //    hold code it never loaded (GY-1445).
  const from = checkout.commit, base = unverified && loaded ? loaded : from;
  let changed: string[], code: boolean;
  try {
    changed = (await git('diff', '--name-only', `${base}..${to}`)).split('\n').map(path => path.trim()).filter(Boolean);
    code = owed || upgradeTouchesCode(changed);
  } catch (error) { return unaligned(`the diff from ${shortCommit(base)} to ${shortCommit(to)} could not be read: ${message(error)}`, 'checkout-failed'); }
  await note(`Checking out base tip ${shortCommit(to)} (from ${shortCommit(from)}): ${changed.length} path(s) changed${code ? ', loaded code among them' : ', none of them loaded code'}`, false);
  try { await git('checkout', '--detach', '--quiet', to); }
  catch (error) { return unaligned(`checking out ${shortCommit(to)} failed: ${message(error)}`, 'checkout-failed'); }
  state.upgrade.pending = { from, to, code };
  await persist();
  return finish({ from, to, code });
}

/**
 * GY-1356: the recovery from a HEAD that moved forward under the running loop. The checkout was
 * moved by something other than the loop's own alignment — a hand `git checkout`, a session whose
 * pane points at it — onto a commit that descends from the one the loop loaded. Standing down there
 * pins the control plane to stale code: no alignment ever runs again and every merged fix stays
 * inert. A clean, detached descendant that is on the freshly fetched base branch — merged code, as
 * an alignment would check out — is adopted as the loop's own move instead: the executors are
 * restarted onto it and the loop re-executes itself through its supervisor, as an alignment does.
 * Anything else — a dirty tree, a branch, a commit the loaded one is not an ancestor of, or one the
 * base branch does not contain (an unmerged feature-branch head) — is refused and stays the drift
 * the guard reports. GY-1359: merged code is adopted only once a verified release serves it, the
 * trigger the self-upgrade waits on too; until then, or when the loop cannot re-execute itself, the
 * outcome is marked `forward` so the guard names a restart onto the checkout's own HEAD, never a
 * rollback to the stale loaded commit. Nothing here throws.
 */
export async function recoverMovedHead(config: MasterConfig, state: DaemonState, from: string, to: string, deps: SelfUpgradeDeps): Promise<SelfUpgradeOutcome> {
  const now = deps.now ?? Date.now, at = () => new Date(now()).toISOString();
  const git = (...args: string[]) => deps.run('git', ['-C', deps.root, ...args]);
  const persist = async () => { if (deps.persist) await deps.persist(state); };
  const key = 'upgrade:recovered';
  const note = async (detail: string, failure: boolean) => {
    if (failure && !detailChanged(state.actions[key], detail)) { touchStanding(state, key, at()); return; }
    storeAction(state, key, { kind: 'config', work: null, principal: null, state: failure ? 'failed' : 'done', detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, epoch: null, cycle: state.cycle, at: at() });
    await persist();
  };
  const checkout = await checkoutState(deps.root, deps.run);
  if (checkout.commit !== to) return { outcome: 'refused', reason: `HEAD reads ${shortCommit(checkout.commit)}, not ${shortCommit(to)}`, commit: checkout.commit };
  if (checkout.detached !== true) return { outcome: 'refused', reason: `HEAD holds ${checkout.branch ?? 'a branch'} instead of standing detached`, commit: to };
  if (checkout.dirty !== false) return { outcome: 'refused', reason: 'tracked files differ from the commit it holds', commit: to };
  try { await git('merge-base', '--is-ancestor', from, to); }
  catch { return { outcome: 'refused', reason: `${shortCommit(to)} does not descend from ${shortCommit(from)}, the commit the loop runs`, commit: to }; }
  // Only reviewed, merged code is adopted: the base branch, fetched as the self-upgrade fetches it, must contain the HEAD.
  const base = `refs/remotes/origin/${config.baseBranch}`;
  try { await git('fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${config.baseBranch}:${base}`); }
  catch (error) { return { outcome: 'failed', reason: `the base branch could not be fetched: ${message(error)}` }; }
  try { await git('merge-base', '--is-ancestor', to, base); }
  catch { return { outcome: 'refused', reason: `${shortCommit(to)} is not on ${config.baseBranch}, so it is not merged code`, commit: to }; }
  const served = state.deployment;
  if (!served || served.source === 'unavailable' || !served.sha || !served.deployed.length)
    return { outcome: 'refused', reason: 'no delivered item is verified deployed yet', commit: to, forward: true };
  try { await git('merge-base', '--is-ancestor', to, served.sha); }
  catch { return { outcome: 'refused', reason: `the verified release ${shortCommit(served.sha)} does not serve it yet`, commit: to, forward: true }; }
  let code: boolean;
  try { code = upgradeTouchesCode((await git('diff', '--name-only', `${from}..${to}`)).split('\n').map(path => path.trim()).filter(Boolean)); }
  catch (error) { return { outcome: 'failed', reason: `the diff from ${shortCommit(from)} to ${shortCommit(to)} could not be read: ${message(error)}`, forward: true }; }
  const moved = `the coordinator checkout's HEAD moved forward from ${shortCommit(from)} to ${shortCommit(to)} under the running loop; the loop adopted it`;
  state.upgrade.refused = null;
  if (!code) {
    state.upgrade.last = { at: at(), from, to, code: false, executors: null, self: false };
    await note(`${moved}; no loaded code moved, so nothing was restarted`, false);
    return { outcome: 'upgraded', from, to, code: false, executors: null, self: false };
  }
  // The executors first; a refusal (a claim still held) leaves their restart owed on the cursor for
  // the next alignment, and the loop itself still moves onto the code the checkout holds.
  let executors: ExecutorRestartResult | null = null;
  if (deps.restartExecutors) {
    executors = await deps.restartExecutors(to).catch(error => ({ result: 'refused' as const, reason: message(error), coordinator: { commit: to }, held: [], restarted: [], unsupervised: [], forgotten: [] }));
    if (executors.result === 'refused') state.upgrade.pending = { from, to, code: true };
  }
  const fleet = executors ? `the executors ${executors.result}${executors.reason ? ` (${executors.reason})` : ''}` : 'this loop cannot restart the executors';
  if (!deps.restartSelf) { await note(`${moved}, but it cannot re-execute itself onto it; ${fleet}`, true); return { outcome: 'failed', reason: 'this loop cannot re-execute itself', forward: true }; }
  state.upgrade.last = { at: at(), from, to, code: true, executors: executors ? `${executors.result}${executors.reason ? `: ${executors.reason}` : ''}` : null, self: true };
  await note(`${moved} and re-executes onto it; ${fleet}`, false);
  await alignRunningUnitQuietly(deps);
  try { await deps.restartSelf(); }
  catch (error) {
    if (restartEndedBySupervisorStop(error)) return { outcome: 'upgraded', from, to, code: true, executors, self: true };
    state.upgrade.last = { ...state.upgrade.last, self: false };
    const reason = `the loop could not re-execute itself through its supervisor: ${message(error)}`;
    await note(`${moved}, but ${reason}; it keeps running ${shortCommit(from)} until its supervisor restarts it`, true);
    return { outcome: 'failed', reason, forward: true };
  }
  return { outcome: 'upgraded', from, to, code: true, executors, self: true };
}
/** The unit re-applied before a recovery's re-execution; its outcome is the alignment's to record. */
async function alignRunningUnitQuietly(deps: SelfUpgradeDeps) { if (deps.alignUnit) await deps.alignUnit().catch(() => {}); }
