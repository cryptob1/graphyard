// Concern: GY-437 — the loop upgrades its own checkout to the merged release, between cycles.
//
// After every merge the coordinator used to be restarted by hand: the loop verified deliveries
// against the deployed release and went on cycling the code it had loaded. The executors already
// record the release they loaded, and `master executors restart` brings the fleet back onto the
// checkout's commit; what was missing is the trigger. Between cycles — never mid-cycle — the loop
// now aligns its checkout with the base branch once the deployment step has verified a delivery
// is served, and when the diff touches code the loop or the executors load, it restarts the
// fleet through `master executors restart` and then re-executes itself through the supervisor
// unit it runs under. A checkout that is dirty or not detached is never touched: the refusal is
// on the cursor, and `master status` names it until it clears.
import { readFileSync } from 'node:fs';
import type { ChildRun } from '../child-runner.js';
import { shortCommit, type ExecutorRestartResult } from '../executor-fleet.js';
import type { MasterConfig } from '../master.js';
import { alignLoopUnit, loopUnitName } from '../supervisor.js';
import { storeAction, touchStanding, message, type DaemonState } from './state.js';
import { detailChanged } from './decisions.js';

/**
 * Code the loop and the executors load: TypeScript modules and the package manifest. A diff that
 * touches none of this cannot change what a running process executes, so the checkout moves and
 * nothing is restarted.
 */
const loadedPrefixes = ['src/', 'scripts/', 'bin/'], loadedFiles = ['package.json'];
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
  /** The checkout moved and the restarts it owes wait on the cursor: the executor restart was refused (a claim still held), which the next cycle retries. */
  | { outcome: 'pending'; reason: string; to: string }
  | { outcome: 'upgraded'; from: string | null; to: string; code: boolean; executors: ExecutorRestartResult | null; self: boolean };

/** The one line about an outcome, for the loop's log. */
export function describeSelfUpgrade(upgraded: SelfUpgradeOutcome): string {
  if (upgraded.outcome === 'skipped') return `skipped: ${upgraded.reason}`;
  if (upgraded.outcome === 'up-to-date') return `the checkout is current at ${shortCommit(upgraded.commit)}`;
  if (upgraded.outcome === 'refused') return `refused: ${upgraded.reason}`;
  if (upgraded.outcome === 'failed') return `failed: ${upgraded.reason}`;
  if (upgraded.outcome === 'pending') return `pending at ${shortCommit(upgraded.to)}: ${upgraded.reason}`;
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
  if (unit !== loopUnitName) return { wrote: 'none', reason: `this loop does not run under ${loopUnitName}` };
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
 * The between-cycles alignment (GY-437). Only a verified deployment triggers it: the release
 * production serves is the truth the loop aligns with, not every merge that lands. A dirty or
 * non-detached checkout is refused before anything touches it. The executors are restarted
 * first, through the shipped command whose refusals (a claim in flight, another restart's
 * fence) leave the owed restarts on the cursor for the next cycle to finish; the loop's own
 * re-execution is last, and everything the next process needs to know is on the cursor before
 * it goes. Nothing here throws: every failure is a recorded action.
 */
export async function performSelfUpgrade(config: MasterConfig, state: DaemonState, deps: SelfUpgradeDeps): Promise<SelfUpgradeOutcome> {
  const now = deps.now ?? Date.now, at = () => new Date(now()).toISOString();
  const git = (...args: string[]) => deps.run('git', ['-C', deps.root, ...args]);
  const persist = async () => { if (deps.persist) await deps.persist(state); };
  const key = `upgrade:${state.deployment?.sha ?? 'none'}`;
  const note = async (detail: string, failure: boolean) => {
    storeAction(state, key, { kind: 'config', work: null, principal: null, state: failure ? 'failed' : 'done', detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, epoch: null, cycle: state.cycle, at: at() });
    await persist();
  };
  const failed = async (reason: string): Promise<SelfUpgradeOutcome> => { await note(reason, true); return { outcome: 'failed', reason }; };
  const refused = async (reason: string, commit: string | null): Promise<SelfUpgradeOutcome> => {
    state.upgrade.refused = { at: at(), reason, commit };
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
  /** Completes the restarts one alignment owes, with the checkout already at the tip. */
  const finish = async (pending: { from: string | null; to: string; code: boolean }): Promise<SelfUpgradeOutcome> => {
    const release = state.deployment!.sha!;
    if (!pending.code) {
      state.upgrade.pending = null;
      state.upgrade.last = { at: at(), from: pending.from, to: pending.to, code: false, executors: null, self: false };
      state.upgrade.alignedRelease = release;
      state.upgrade.refused = null;
      await persist();
      return { outcome: 'upgraded', from: pending.from, to: pending.to, code: false, executors: null, self: false };
    }
    if (!deps.restartExecutors) return failed('loaded code moved but this loop cannot restart the executors');
    const executors = await deps.restartExecutors(pending.to).catch(error => ({ result: 'refused' as const, reason: message(error), coordinator: { commit: pending.to }, held: [], restarted: [], unsupervised: [], forgotten: [] }));
    if (executors.result === 'refused') {
      // The designed safety, not a fault (GY-916): a claim still held after the bounded wait. The
      // owed restarts stay on the cursor as pending, the action is recorded waiting, and the next
      // cycle's pass finds the checkout at the tip and completes them.
      const reason = `the executors were not restarted: ${executors.reason ?? 'the restart was refused'}; the fleet stands down on the moved checkout on its own and the restart is retried next cycle`;
      state.upgrade.pending = { from: pending.from, to: pending.to, code: true };
      storeAction(state, key, { kind: 'config', work: null, principal: null, state: 'waiting', detail: reason, attempts: (state.actions[key]?.attempts ?? 0) + 1, epoch: null, cycle: state.cycle, at: at() });
      await persist();
      return { outcome: 'pending', reason, to: pending.to };
    }
    // The cursor is written before the loop re-executes itself: the next process must find the
    // alignment complete, never repeat it. `self` is written true before the call, because the
    // process may not survive it; a failed re-execution writes it back to false.
    state.upgrade.last = { at: at(), from: pending.from, to: pending.to, code: true, executors: `${executors.result}${executors.reason ? `: ${executors.reason}` : ''}`, self: !!deps.restartSelf };
    state.upgrade.pending = null;
    state.upgrade.alignedRelease = release;
    state.upgrade.refused = null;
    await persist();
    await note(`Checked out base tip ${shortCommit(pending.to)}${pending.from ? ` from ${shortCommit(pending.from)}` : ''}; loaded code moved, the executors were restarted (${executors.result})${executors.reason ? `: ${executors.reason}` : ''}`, false);
    if (!deps.restartSelf) return failed('loaded code moved and the executors were restarted, but this loop cannot re-execute itself');
    await alignUnit();
    try { await deps.restartSelf(); }
    catch (error) {
      // The supervisor's own stop ended the awaited child: the restart the loop asked for is under
      // way, so the alignment is complete and nothing failed (GY-916).
      if (restartEndedBySupervisorStop(error)) return { outcome: 'upgraded', from: pending.from, to: pending.to, code: true, executors, self: true };
      state.upgrade.last = { ...state.upgrade.last!, self: false };
      await persist();
      const reason = `the loop could not re-execute itself through its supervisor: ${message(error)}`;
      await note(`${reason}; it keeps running ${shortCommit(state.release?.commit ?? null)} until its supervisor restarts it`, true);
      return { outcome: 'failed', reason };
    }
    // The supervisor has queued the restart; its stop signal ends this process during the wait.
    return { outcome: 'upgraded', from: pending.from, to: pending.to, code: true, executors, self: true };
  };

  // 1. The trigger: a delivery verified served by a release, from the deployment step's
  //    observation. This release already aligned is skipped, unless a restart it owes is pending.
  const observation = state.deployment;
  if (!observation || observation.source === 'unavailable' || !observation.sha || !observation.deployed.length)
    return { outcome: 'skipped', reason: 'no delivered item is verified deployed yet' };
  const release = observation.sha;
  if (state.upgrade.alignedRelease === release && !state.upgrade.pending)
    return { outcome: 'skipped', reason: `release ${shortCommit(release)} was already aligned` };

  // 2. The base tip, from a fresh fetch.
  let to: string;
  try {
    await git('fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${config.baseBranch}:refs/remotes/origin/${config.baseBranch}`);
    to = (await git('rev-parse', `refs/remotes/origin/${config.baseBranch}^{commit}`)).trim();
  } catch (error) { return failed(`the base branch could not be fetched: ${message(error)}`); }

  // 3. How this checkout stands, before anything touches it.
  const checkout = await checkoutState(deps.root, deps.run);
  if (!checkout.commit) return failed(`the coordinator checkout at ${deps.root} could not be read`);
  if (to === checkout.commit) {
    // The checkout already holds the tip: finish what an earlier pass still owes, or align and
    // clear a refusal that no longer describes anything.
    if (state.upgrade.pending) return finish(state.upgrade.pending);
    const cleared = !!state.upgrade.refused;
    state.upgrade.alignedRelease = release;
    state.upgrade.refused = null;
    await persist();
    if (cleared) await note(`The checkout is current at ${shortCommit(to)}; the earlier refusal is cleared`, false);
    return { outcome: 'up-to-date', commit: to };
  }
  if (checkout.detached !== true) return refused(`HEAD holds ${checkout.branch ?? 'a branch'} instead of standing detached; it is upgraded only as a clean detached checkout of ${config.baseBranch}`, checkout.commit);
  if (checkout.dirty === true) return refused('tracked files differ from the commit it holds; it is upgraded only clean', checkout.commit);

  // 4. What the move would change, then the move itself.
  //    A restart still owed for an earlier move stays owed: a docs-only move on top of a src/ one
  //    leaves the fleet as stale as the src/ move did.
  const owed = state.upgrade.pending?.code === true;
  if (state.upgrade.pending) { state.upgrade.pending = null; await persist(); }
  const from = checkout.commit;
  let changed: string[], code: boolean;
  try {
    changed = (await git('diff', '--name-only', `${from}..${to}`)).split('\n').map(path => path.trim()).filter(Boolean);
    code = owed || upgradeTouchesCode(changed);
  } catch (error) { return failed(`the diff from ${shortCommit(from)} to ${shortCommit(to)} could not be read: ${message(error)}`); }
  await note(`Checking out base tip ${shortCommit(to)} (from ${shortCommit(from)}): ${changed.length} path(s) changed${code ? ', loaded code among them' : ', none of them loaded code'}`, false);
  try { await git('checkout', '--detach', '--quiet', to); }
  catch (error) { return failed(`checking out ${shortCommit(to)} failed: ${message(error)}`); }
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
