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
import { storeAction, message, type DaemonState } from './state.js';
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
  | { outcome: 'refused'; reason: string; commit: string | null }
  | { outcome: 'failed'; reason: string }
  | { outcome: 'upgraded'; from: string | null; to: string; code: boolean; executors: ExecutorRestartResult | null; self: boolean };

/** The one line about an outcome, for the loop's log. */
export function describeSelfUpgrade(upgraded: SelfUpgradeOutcome): string {
  if (upgraded.outcome === 'skipped') return `skipped: ${upgraded.reason}`;
  if (upgraded.outcome === 'up-to-date') return `the checkout is current at ${shortCommit(upgraded.commit)}`;
  if (upgraded.outcome === 'refused') return `refused: ${upgraded.reason}`;
  if (upgraded.outcome === 'failed') return `failed: ${upgraded.reason}`;
  return `checked out ${shortCommit(upgraded.to)}${upgraded.code ? '; loaded code moved' : '; no loaded code moved'}`
    + `${upgraded.executors ? `; executors ${upgraded.executors.result}${upgraded.executors.reason ? ` (${upgraded.executors.reason})` : ''}` : ''}`
    + `${upgraded.self ? '; the loop re-executes itself' : ''}`;
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
    }
    return { outcome: 'refused', reason, commit };
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
      const reason = `the executors were not restarted: ${executors.reason ?? 'the restart was refused'}; the fleet stands down on the moved checkout on its own and the restart is retried next cycle`;
      return failed(reason);
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
    try { await deps.restartSelf(); }
    catch (error) {
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
