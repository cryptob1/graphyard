// Concern: GY-437 — the loop upgrades its own checkout to the merged release, between cycles.
//
// Between cycles — never mid-cycle — the loop aligns its checkout with the base branch once the
// deployment step has verified a delivery is served — or, while production cannot be verified,
// once the checkout already holds code the running loop has not loaded (GY-1445) — and when the
// diff touches code the loop or the executors load, it restarts the fleet through
// `master executors restart` and re-executes itself through its supervisor unit. A checkout that
// is not detached is never touched: the refusal is on the cursor until it clears. A dirty checkout
// is never touched either, but holds no upgrade back (GY-1773): the loop and the executors
// restart onto a held-cli snapshot of the merged commit, the checkout named on the cursor with
// its dirty paths until it is moved onto that commit and stands clean there.
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildRun } from '../child-runner.js';
import { shortCommit, type ExecutorRestartResult } from '../executor-fleet.js';
import type { MasterConfig } from '../master.js';
import { carryUndeclared } from './state-cursor.js';
import { storeAction, touchStanding, message, type DaemonState, type UpgradeStallCause } from './state.js';
import { detailChanged } from './decisions.js';
import { checkoutState, loopCodeRoot, reconcileLoadedRelease, unquotePath, type CheckoutState } from './checkout-state.js';
import { heldCliSnapshots, heldExecutorEntryOf, holdCliAt, sameCommit } from './held-cli.js';
import { restartEndedBySupervisorStop } from './loop-supervisor.js';
import { externalInstallPass, managesOwnCheckout } from './upgrade-ownership.js';
import { deployTip, deployKey, promotionReading, type DeployPorts } from './continuous-deploy.js';

/**
 * Code the loop and the executors load: TypeScript modules and the package manifest. A diff that
 * touches none of this cannot change what a running process executes, so the checkout moves and
 * nothing is restarted.
 */
const loadedPrefixes = ['src/', 'scripts/', 'bin/'], loadedFiles = ['package.json', 'tsconfig.json'];
/** The action a failure before any restart attempt is recorded on (GY-1445): never one of the release's attempts. */
export const alignKey = 'upgrade:align';
/**
 * How long the loop waits on executors whose held claims refuse the fleet restart before it
 * re-executes onto the checkout by itself (GY-1473): half the loaded-revision resource's 30-minute
 * bound, so the loop loads the move within the bound even while a claim is held every cycle.
 */
export const fleetWaitMs = 15 * 60_000;
export function upgradeTouchesCode(paths: readonly string[]): boolean {
  return paths.some(path => loadedFiles.includes(path) || loadedPrefixes.some(prefix => path.startsWith(prefix)));
}

/**
 * The real paths one line-oriented git listing names, git's C quoting resolved (GY-1790): git
 * quotes a path holding a quote, a backslash, spaces at either end or control bytes, and a reading
 * that keeps the quotes misclassifies it (`"src/x.ts"` is not under `src/`) and records a name no
 * commit holds. The parser is the one `checkoutState` unquotes its porcelain paths with, so both
 * readings agree on the same names.
 */
const listedPaths = (out: string): string[] => out.split('\n').map(path => unquotePath(path.trim())).filter(Boolean);

// The held-cli snapshot pin (GY-1585/GY-1773/GY-1790) and the loop's own supervisor unit (GY-916) are
// modules of their own; this path re-exports them, so every existing import keeps working.
export { heldCliPointer, heldCliSnapshotAt, readHeldCli, holdCliAt, heldLauncherOf, heldExecutorEntryOf, loadedHeldSnapshot, leftBehindCheckoutAttention } from './held-cli.js';
export { loopUnitPattern, detectLoopSupervisorUnit, restartEndedBySupervisorStop, supervisorStopGraceMs, awaitSupervisorRestart, alignRunningLoopUnit } from './loop-supervisor.js';

export { checkoutState, type CheckoutState };
// GY-1958: the project-identification probe re-exported, so every existing import keeps working.
export { externalUpgradeRefusal, isExternalUpgradeRefusal, managesOwnCheckout } from './upgrade-ownership.js';

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
  /** `left` (GY-1773): the restart went onto a held snapshot of `to`; the dirty checkout stays at `left.checkout`. */
  | { outcome: 'upgraded'; from: string | null; to: string; code: boolean; executors: ExecutorRestartResult | null; self: boolean; left?: LeftBehind };
/** The checkout a snapshot restart leaves where it stands (GY-1773): its commit and its dirty tracked paths. */
export interface LeftBehind { checkout: string | null; dirty: string[] }
const nameDirty = (left: LeftBehind) => left.dirty.length ? `: ${left.dirty.slice(0, 8).join(', ')}${left.dirty.length > 8 ? `; and ${left.dirty.length - 8} more` : ''}` : '';

/** The one line about an outcome, for the loop's log. */
export function describeSelfUpgrade(upgraded: SelfUpgradeOutcome): string {
  if (upgraded.outcome === 'skipped') return `skipped: ${upgraded.reason}`;
  if (upgraded.outcome === 'up-to-date') return `the checkout is current at ${shortCommit(upgraded.commit)}`;
  if (upgraded.outcome === 'refused') return `refused: ${upgraded.reason}`;
  if (upgraded.outcome === 'failed') return `failed: ${upgraded.reason}`;
  if (upgraded.outcome === 'pending') return `pending at ${shortCommit(upgraded.to)}: ${upgraded.reason}${upgraded.self ? '; the loop re-executes itself onto it meanwhile' : ''}`;
  return `${upgraded.left ? `restarted onto a held snapshot of ${shortCommit(upgraded.to)}; the coordinator checkout stays dirty at ${shortCommit(upgraded.left.checkout)}` : `checked out ${shortCommit(upgraded.to)}`}${upgraded.code ? '; loaded code moved' : '; no loaded code moved'}`
    + `${upgraded.executors ? `; executors ${upgraded.executors.result}${upgraded.executors.reason ? ` (${upgraded.executors.reason})` : ''}` : ''}`
    + `${upgraded.self ? '; the loop re-executes itself' : ''}`;
}

export interface SelfUpgradeDeps {
  /** The managed repository's root; the checkout fetched, diffed and checked out is the CLI's (`loopCodeRoot`), this root only where no launcher stands apart (GY-1899). */
  root: string;
  /** Every git command the alignment runs. */
  run: ChildRun;
  /** `master executors restart` against the checked-out tip, for a diff that touches loaded code. */
  restartExecutors?: (to: string) => Promise<ExecutorRestartResult>;
  /** Re-executes the loop through its own supervisor unit; a loop no unit supervises cannot. */
  restartSelf?: () => Promise<void>;
  /**
   * Rewrites the loop's supervisor unit when it no longer matches the running configuration
   * (`alignLoopUnit`), before the loop re-executes itself through it (GY-916). `launcherStale`
   * (GY-1790): a refused rewrite left the unit's ExecStart on a launcher other than the one it
   * must start now — the checkout's while a snapshot's pin stands, a snapshot's once it lifts.
   */
  alignUnit?: () => Promise<{ wrote: string; reason: string | null; launcherStale?: boolean }>;
  /** Pins the CLI the checkout's launcher runs to the served release while a restart is held, null lifts it (GY-1585); `holdCliAt` on `root` by default. */
  holdCli?: (commit: string | null) => Promise<void>;
  /**
   * GY-1790: points the supervised executor units' entry at `script` — the held snapshot's
   * scripts/graphyard-executor.mjs while a snapshot restart's pin stands, null for the checkout's —
   * so a slot its unit starts runs the snapshot's entry, never one the checkout holds dirty. The
   * loop's own unit follows the pin through `alignUnit`, whose ExecStart is `heldLauncherOf`.
   */
  alignExecutorUnits?: (script: string | null) => Promise<{ wrote: string; reason: string | null }>;
  /** The file this module was loaded from: under a held snapshot when the launcher pinned `master run` (GY-1585). */
  loadedFrom?: string;
  now?: () => number;
  persist?: (state: DaemonState) => Promise<void>;
  /** GY-1982: the install's continuous deploy ports, or the one line naming why this install has none. */
  deploy?: () => Promise<DeployPorts | string>;
}

/** GY-1982: the continuous deploy and its cursor readings are a module of their own; this path re-exports them, so every existing import keeps working. */
export { deployKey, promotionReading, deployLine } from './continuous-deploy.js';
export type { DeployPorts } from './continuous-deploy.js';

/**
 * The between-cycles alignment (GY-437). A verified deployment triggers it: the release
 * production serves is the truth the loop aligns with, not every merge that lands. While
 * production cannot be observed at all (GY-1445), a restart already owed — or a checkout that
 * holds code the running loop did not load — is still finished: the checkout is aligned with the
 * base tip and the owed restart attempted each pass, so an observation that never arrives cannot
 * pin the loop to stale code; a checkout an earlier pass already processed from the loaded commit
 * without loaded code is idle, never fetched again. Each pass that cannot complete
 * the restart records one named stall on the cursor (`upgrade.stalled`: its cause and latest
 * attempt); the pass that completes it removes it. Only a restart attempt refreshes the release's
 * action, the owed restart's attempt clock: a failure before one (a fetch, the checkout, a diff)
 * is recorded on `upgrade:align`, and a fetch that fails while a restart is owed onto the commit
 * the checkout holds still attempts it. A non-detached checkout is refused before anything
 * touches it; a dirty one is never touched either, but is upgraded by snapshot (GY-1773):
 * the merged commit is checked out under `.graphyard/held-cli/`, the launcher is pinned to it as a
 * held restart pins it, and the executors and the loop restart onto that, the checkout left where
 * it stands and recorded on the cursor (`upgrade.snapshot`) with its dirty paths; the restarts run
 * the launcher held in the snapshot (GY-1790), never launcher files the checkout holds dirty.
 * Moving the checkout onto the commit and cleaning it there lifts the pin. A tip touching no loaded code restarts the loop alone:
 * the snapshot is made and pinned and the loop re-executed onto it, the executors keep running.
 * The executors are restarted first, through the shipped command whose
 * refusals (a claim in flight, another restart's fence) leave the owed restarts on the cursor for
 * the next cycle to finish; the loop's own re-execution is last, and everything the next process
 * needs to know is on the cursor before it goes. A refusal that has stood `fleetWaitMs` no longer
 * holds the loop (GY-1473): it re-executes onto the checkout alone, and the executor restart stays
 * owed for the process that starts. With `deploy` (GY-1982) the base tip is deployed before
 * anything restarts onto it (`deployTip`), and nothing waits on a served-release observation.
 * Nothing here throws: every failure is a recorded action.
 */
export async function performSelfUpgrade(config: MasterConfig, state: DaemonState, deps: SelfUpgradeDeps): Promise<SelfUpgradeOutcome> {
  const now = deps.now ?? Date.now, at = () => new Date(now()).toISOString();
  // GY-1899: the loop's loaded code and this upgrade live in the checkout the running CLI comes
  // from, never the managed repository's root: the root's HEAD names the managed project, and a
  // fetch, diff or checkout there would move the managed project, not the code this process runs.
  const codeRoot = loopCodeRoot(config.cliPath, deps.root);
  const git = (...args: string[]) => deps.run('git', ['-C', codeRoot, ...args]);
  const persist = async () => { if (deps.persist) await deps.persist(state); };
  const key = `upgrade:${state.deployment?.sha ?? 'none'}`;
  const holdCli = deps.holdCli ?? (commit => holdCliAt(codeRoot, deps.run, commit));
  /** GY-1790: the executor units' entry follows the pin — the snapshot's script while it stands, the checkout's when it lifts. No unit is aligned where none is supervised. */
  const alignExecutorUnits = async (script: string | null): Promise<string | null> => {
    if (!deps.alignExecutorUnits) return null;
    const aligned = await deps.alignExecutorUnits(script).catch(error => ({ wrote: 'refused', reason: message(error) }));
    return aligned.wrote === 'refused' ? aligned.reason || 'the executor units were not rewritten' : null;
  };
  // GY-1585: a loop its supervisor restarts while a restart is held runs the held snapshot of the
  // served release, as every command the launcher starts does, but it read its release from the
  // checkout, which holds the move. It is recorded as running the snapshot's commit, so the pass
  // that lifts the hold still re-executes it onto the checkout.
  const snapshot = relative(heldCliSnapshots(codeRoot), deps.loadedFrom ?? fileURLToPath(import.meta.url)).split(sep)[0];
  if (snapshot && snapshot !== '..' && !isAbsolute(snapshot)) {
    const commit = await Promise.resolve(deps.run('git', ['-C', join(heldCliSnapshots(codeRoot), snapshot), 'rev-parse', 'HEAD'])).then(out => out.trim(), () => '');
    if (commit && state.release?.commit !== commit) state.release = carryUndeclared(state.release, { commit, dirty: false });
  } else if (state.release?.commit) {
    // GY-1899: the release the loop records is the CLI checkout's own reading, never the managed
    // repository's HEAD a startup read of the wrong root wrote; the cursor names the checkout the
    // loop runs, which the master-loop check and doctor read.
    const corrected = await reconcileLoadedRelease(codeRoot, state.release, deps.run);
    if (corrected) { state.release = carryUndeclared(state.release, corrected); await persist(); }
  }
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
  const refused = async (reason: string, commit: string | null, cause?: UpgradeStallCause): Promise<SelfUpgradeOutcome> => {
    state.upgrade.refused = { at: at(), reason, commit };
    if (cause) stall(cause, reason);
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
  const alignUnitRecorded = async (): Promise<{ wrote: string; reason: string | null; launcherStale?: boolean }> => {
    if (!deps.alignUnit) return { wrote: 'none', reason: null };
    const unitKey = 'upgrade:unit';
    const aligned = await deps.alignUnit().catch(error => ({ wrote: 'refused', reason: message(error), launcherStale: true }));
    if (aligned.wrote === 'updated' || aligned.wrote === 'created') {
      storeAction(state, unitKey, { kind: 'config', work: null, principal: null, state: 'done', detail: `The loop's supervisor unit no longer matched the running configuration and was rewritten (${aligned.wrote}); the next start runs the loop under it`, attempts: (state.actions[unitKey]?.attempts ?? 0) + 1, epoch: null, cycle: state.cycle, at: at() });
      await persist();
    } else if (aligned.wrote === 'refused') {
      const detail = `The loop's supervisor unit does not match the running configuration and was not rewritten: ${aligned.reason ?? 'the rewrite was refused'}`;
      if (detailChanged(state.actions[unitKey], detail)) {
        storeAction(state, unitKey, { kind: 'config', work: null, principal: null, state: 'failed', detail, attempts: (state.actions[unitKey]?.attempts ?? 0) + 1, epoch: null, cycle: state.cycle, at: at() });
        await persist();
      }
    }
    return aligned;
  };
  const alignUnit = async (): Promise<boolean> => (await alignUnitRecorded()).wrote !== 'refused';
  // GY-1958: an install managing another project runs no alignment — the checkout is never fetched
  // in or moved, what an earlier alignment left owed is retired, and the install upgrades by command.
  const own = await managesOwnCheckout(codeRoot, deps.root, deps.run);
  if (own === null) return { outcome: 'skipped', reason: 'whether the managed repository is the coordinator checkout\'s own project could not be read, so this pass neither aligns nor refuses; retried next cycle' };
  if (!own) return externalInstallPass(state, codeRoot, deps.run, {
    at, persist, unstall, refused, note: (detail, failure) => note(detail, failure, alignKey),
    settle: async () => (await holdCli(null).then(() => null, error => `the held snapshot pin could not be lifted: ${message(error)}`))
      ?? (await alignExecutorUnits(null).then(why => why && `the executor units could not be returned to the checkout's launcher: ${why}`))
      ?? (await alignUnit() ? null : `the loop's supervisor unit could not be returned to the checkout's launcher (upgrade:unit names why)`),
  });
  /**
   * GY-1790: the unit the restart re-executes the loop through, pointed at the launcher it must
   * start before the cursor records the restart as made — the snapshot's while a snapshot restart's
   * pin stands, the checkout's once the pin is lifted — and withheld while it is not: a rewrite
   * refused with the ExecStart still on the other launcher would start the checkout's launcher,
   * dirty or not, under the snapshot's pin, or a snapshot's launcher after the pin is gone. The
   * restart then stays owed on the cursor under `snapshot-failed` (upgrade:unit names why) and the
   * next pass retries the rewrite. A refusal that leaves the launcher as it must be (a drifted
   * watchdog window on a unit that cannot be rewritten) is recorded and holds nothing, as GY-916
   * had it. A call that throws is taken for a stale launcher: what the unit names is unknown.
   */
  const pointLoopUnit = async (to: string, onto: 'snapshot' | 'checkout'): Promise<SelfUpgradeOutcome | null> => {
    const aligned = await alignUnitRecorded();
    if (aligned.wrote !== 'refused' || !aligned.launcherStale) return null;
    return failed(onto === 'snapshot'
      ? `the held snapshot of ${shortCommit(to)} stands and the launcher is pinned to it, but the loop's supervisor unit could not be pointed at the snapshot's launcher (upgrade:unit names why); the restart stays owed and is retried next cycle`
      : `the held snapshot pin is lifted for the restart onto ${shortCommit(to)}, but the loop's supervisor unit still names the snapshot's launcher and could not be returned to the checkout's (upgrade:unit names why); the restart stays owed and is retried next cycle`, 'snapshot-failed');
  };
  /**
   * `left` (GY-1773): the checkout is dirty and stays where it stands, so the restart goes onto a
   * held snapshot of `pending.to` instead: the launcher is pinned to the snapshot before anything
   * restarts, the executors and the loop restart onto it as they would onto the checkout, and the
   * cursor records the checkout left behind. A hold places no pin for it only while the checkout
   * still holds the commit the loop runs: what its launcher starts then speaks the served protocol.
   * A checkout that moved (by hand, onto an unserved commit) and was dirtied is pinned to the served
   * release for the hold like a clean one (GY-1585), or every command it starts would load unserved
   * code against the serving plane. A tip touching no loaded code
   * is the same restart minus the executors: nothing they run changed, so no claim of theirs can
   * hold the alignment, and the loop alone re-executes onto the snapshot. The launcher that boots
   * the restarted loop and every later slot is the one held in the snapshot (GY-1790): the loop
   * unit's ExecStart and the executor units' entry point into the snapshot, with the checkout
   * handed to them in the environment, so launcher files the checkout holds dirty
   * (bin/graphyard.mjs, bin/held-release-hooks.mjs) never boot the loop or a slot. A command started
   * through the checkout's launcher (config.cliPath) still runs its bin/graphyard.mjs, which reads
   * the pin by itself and registers the snapshot's hooks; `leftBehindCheckoutAttention` names a
   * dirty launcher for the operator to return to the commit, and the units go back to the
   * checkout's launcher when the pin lifts.
   */
  const finish = async (pending: { from: string | null; to: string; code: boolean }, left: LeftBehind | null = null): Promise<SelfUpgradeOutcome> => {
    const aligned = release ?? state.upgrade.alignedRelease;
    if (!pending.code && !left) {
      state.upgrade.pending = null;
      state.upgrade.last = { at: at(), from: pending.from, to: pending.to, code: false, executors: null, self: false };
      state.upgrade.alignedRelease = aligned;
      state.upgrade.refused = null;
      unstall();
      await persist();
      return { outcome: 'upgraded', from: pending.from, to: pending.to, code: false, executors: null, self: false };
    }
    if (!pending.code) {
      // GY-1773: from a dirty checkout even a tip touching no loaded code is a restart onto a held
      // snapshot (AC-1 names no docs-only exemption): the snapshot is made, the launcher pinned to
      // it, and the loop re-executed onto it, so the cursor records the merged commit as the release
      // the loop runs while the checkout stands left behind. The executors keep running: nothing
      // they execute changed, so their restart is not owed and a held claim cannot stall this.
      const unmade = await holdCli(pending.to).then(() => null, error => message(error));
      if (unmade !== null) return failed(`the held snapshot of ${shortCommit(pending.to)} could not be made for the restart from the dirty coordinator checkout at ${shortCommit(left!.checkout)}: ${unmade}`, 'snapshot-failed');
      const unpointed = await alignExecutorUnits(heldExecutorEntryOf(codeRoot, pending.to));
      if (unpointed !== null) return failed(`the held snapshot of ${shortCommit(pending.to)} stands and the launcher is pinned to it, but the executor units could not be pointed at the snapshot's launcher: ${unpointed}`, 'snapshot-failed');
      const withheld = await pointLoopUnit(pending.to, 'snapshot');
      if (withheld) return withheld;
      state.upgrade.snapshot = { at: at(), commit: pending.to, checkout: left!.checkout, dirty: left!.dirty.slice(0, 20) };
      state.upgrade.pending = null;
      state.upgrade.last = { at: at(), from: pending.from, to: pending.to, code: false, executors: null, self: !!deps.restartSelf };
      state.upgrade.alignedRelease = aligned;
      state.upgrade.refused = null;
      unstall();
      await persist();
      if (!deps.restartSelf) return failed(`the held snapshot of ${shortCommit(pending.to)} stands and the launcher is pinned to it, but this loop cannot re-execute itself onto it`, 'supervisor-unreachable');
      await note(`Snapshotted base tip ${shortCommit(pending.to)} under .graphyard/held-cli; the coordinator checkout stays dirty at ${shortCommit(left!.checkout)}${nameDirty(left!)}; no loaded code moved, so the executors keep running and the loop re-executes itself onto the snapshot`, false);
      try { await deps.restartSelf(); }
      catch (error) {
        // The supervisor's own stop ended the awaited child: the restart is under way (GY-916).
        if (restartEndedBySupervisorStop(error)) return { outcome: 'upgraded', from: pending.from, to: pending.to, code: false, executors: null, self: true, ...(left ? { left } : {}) };
        state.upgrade.last = { ...state.upgrade.last!, self: false };
        const reason = `the loop could not re-execute itself through its supervisor: ${message(error)}`;
        stall('supervisor-unreachable', reason);
        await persist();
        await note(`${reason}; it keeps running ${shortCommit(state.release?.commit ?? null)} until its supervisor restarts it`, true);
        return { outcome: 'failed', reason };
      }
      return { outcome: 'upgraded', from: pending.from, to: pending.to, code: false, executors: null, self: true, ...(left ? { left } : {}) };
    }
    if (left) {
      const unmade = await holdCli(pending.to).then(() => null, error => message(error));
      if (unmade !== null) return failed(`the held snapshot of ${shortCommit(pending.to)} could not be made for the restart from the dirty coordinator checkout at ${shortCommit(left.checkout)}: ${unmade}`, 'snapshot-failed');
      const unpointed = await alignExecutorUnits(heldExecutorEntryOf(codeRoot, pending.to));
      if (unpointed !== null) return failed(`the held snapshot of ${shortCommit(pending.to)} stands and the launcher is pinned to it, but the executor units could not be pointed at the snapshot's launcher: ${unpointed}`, 'snapshot-failed');
    } else {
      // A pointer that failed to go still pins the launcher to the old snapshot: the checkout stays put.
      const unpinned = await holdCli(null).then(() => null, error => message(error));
      if (unpinned !== null) return failed(`the held snapshot pin could not be lifted before the restart onto ${shortCommit(pending.to)}: ${unpinned}`, 'snapshot-failed');
      // GY-1790: a loop that ran a snapshot restarts from the checkout now, so the executor units
      // return to the checkout's entry before the fleet restarts under them — a reinstall during
      // a held restart (GY-1585) points them into its snapshot too, so they are returned on every
      // lift, a no-op for units already there. The record stays until the loop's own unit is
      // returned as well, below, so a later start never runs a launcher the snapshot cleanup may
      // since have removed.
      const unpointed = await alignExecutorUnits(null);
      if (unpointed !== null) return failed(`the held snapshot pin is lifted for the restart onto ${shortCommit(pending.to)}, but the executor units could not be returned to the checkout's launcher: ${unpointed}`, 'snapshot-failed');
    }
    // The loop's own unit, pointed at the snapshot's launcher before anything restarts and before
    // the cursor says it did (GY-1790): a withheld snapshot restart then costs no fleet restart per
    // retried pass. A restart from the checkout re-applies the unit after the fleet restarts and
    // before the loop re-executes, as GY-916 had it, withheld the same way while the unit still
    // names a snapshot's launcher.
    if (left) {
      const withheld = await pointLoopUnit(pending.to, 'snapshot');
      if (withheld) return withheld;
      state.upgrade.snapshot = { at: at(), commit: pending.to, checkout: left.checkout, dirty: left.dirty.slice(0, 20) };
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
      if (!left) { const withheld = await pointLoopUnit(pending.to, 'checkout'); if (withheld) return withheld; }
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
    if (!left) {
      // The unit returned to the checkout's launcher before the cursor records the restart and the
      // loop re-executes; a lift's record stays until it is, so a later start never runs a
      // launcher the snapshot cleanup may since have removed.
      const withheld = await pointLoopUnit(pending.to, 'checkout');
      if (withheld) return withheld;
      delete state.upgrade.snapshot;
    }
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
    const moved = left ? `Snapshotted base tip ${shortCommit(pending.to)} under .graphyard/held-cli for the loop and the executors; the coordinator checkout stays dirty at ${shortCommit(left.checkout)}${nameDirty(left)}` : `Checked out base tip ${shortCommit(pending.to)}${pending.from ? ` from ${shortCommit(pending.from)}` : ''}`;
    await note(`${moved}; loaded code moved, the executors were restarted (${executors.result})${executors.reason ? `: ${executors.reason}` : ''}`, false);
    const upgraded = (self: boolean): SelfUpgradeOutcome => ({ outcome: 'upgraded', from: pending.from, to: pending.to, code: true, executors, self, ...(left ? { left } : {}) });
    if (running) return upgraded(false);
    if (!deps.restartSelf) return failed('loaded code moved and the executors were restarted, but this loop cannot re-execute itself', 'supervisor-unreachable');
    try { await deps.restartSelf(); }
    catch (error) {
      // The supervisor's own stop ended the awaited child: the restart the loop asked for is under
      // way, so the alignment is complete and nothing failed (GY-916).
      if (restartEndedBySupervisorStop(error)) return upgraded(true);
      state.upgrade.last = { ...state.upgrade.last!, self: false };
      const reason = `the loop could not re-execute itself through its supervisor: ${message(error)}`;
      stall('supervisor-unreachable', reason, prior);
      await persist();
      await note(`${reason}; it keeps running ${shortCommit(state.release?.commit ?? null)} until its supervisor restarts it`, true);
      return { outcome: 'failed', reason };
    }
    // The supervisor has queued the restart; its stop signal ends this process during the wait.
    return upgraded(true);
  };

  /**
   * GY-1773: the checkout was moved onto the commit the loop runs from its held snapshot and stands
   * clean there: the pin is lifted, the launcher runs the checkout again, and nothing restarts — the
   * code is the same. Still dirty at the commit — in any tracked path, loaded code or not, since the
   * checkout guard (GY-857) refuses a process started from any tracked edit, and a lift onto such a
   * tree would stop the next executor and loop start — the pin stays and the cursor names the
   * checkout as it stands now, dirty at the commit itself.
   */
  const lift = async (commit: string, standing: CheckoutState): Promise<SelfUpgradeOutcome> => {
    if (standing.dirty === true) {
      const left = state.upgrade.snapshot!, dirty = standing.dirtyPaths.slice(0, 20);
      if (left.checkout !== commit || left.dirty.join('\n') !== dirty.join('\n')) { state.upgrade.snapshot = { ...left, checkout: commit, dirty }; await persist(); }
      return { outcome: 'skipped', reason: `the checkout holds ${shortCommit(commit)}, the commit the loop runs from its held snapshot, but tracked files are dirty in it (${dirty.slice(0, 8).join(', ')}${dirty.length > 8 ? `; and ${dirty.length - 8} more` : ''}); the pin stays until it is clean` };
    }
    // Whether the checkout is dirty is unknown when git status failed: the pin stays until it reads.
    if (standing.dirty === null) return { outcome: 'skipped', reason: `the checkout holds ${shortCommit(commit)}, the commit the loop runs from its held snapshot, but whether it is dirty could not be read; the pin stays until it is, retried next cycle` };
    // A pointer that failed to go still pins the launcher: the record stays and the next cycle retries.
    const unlifted = await holdCli(null).then(() => null, error => message(error));
    if (unlifted) return { outcome: 'skipped', reason: `the checkout holds ${shortCommit(commit)}, the commit the loop runs from its held snapshot, but the pin could not be lifted: ${unlifted}; retried next cycle` };
    // The pin is lifted, so the units go back to the checkout's launcher (GY-1790): the loop unit's
    // ExecStart follows the absent pin through `alignUnit`, the executor units are pointed back at
    // the checkout's entry. A rewrite that fails keeps the record and retries before it is cleared,
    // so a later start never runs the checkout's launcher while the cursor still holds a snapshot.
    const unpointed = await alignExecutorUnits(null);
    if (unpointed) return { outcome: 'skipped', reason: `the checkout holds ${shortCommit(commit)}, the commit the loop runs from its held snapshot, and the pin is lifted, but the executor units could not be returned to the checkout's launcher: ${unpointed}; retried next cycle` };
    // The loop unit's ExecStart still names the snapshot's launcher until it is rewritten; a refused
    // rewrite keeps the record, so the next pass retries it before the snapshot is forgotten and a
    // later start never runs a launcher the snapshot cleanup may since have removed.
    if (!await alignUnit()) return { outcome: 'skipped', reason: `the checkout holds ${shortCommit(commit)}, the commit the loop runs from its held snapshot, and the pin is lifted, but the loop's supervisor unit could not be returned to the checkout's launcher (upgrade:unit names why); retried next cycle` };
    delete state.upgrade.snapshot;
    state.upgrade.refused = null; unstall(); await persist();
    await note(`The checkout is current at ${shortCommit(commit)}; it was moved onto the commit the loop runs from its held snapshot, so the pin on the snapshot is lifted`, false);
    return { outcome: 'up-to-date', commit };
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
  //    loop on stale code until the next promotion.
  // GY-1982: the install's deploy ports, read once per pass; a provider without them names why and keeps the alignment as it was.
  const ports = deps.deploy ? await deps.deploy() : null, deploying = !!ports && typeof ports !== 'string';
  if (typeof ports === 'string' && state.promotion?.reason !== ports) { state.promotion = promotionReading(state.promotion, at(), { reason: ports }); await persist(); }
  const observation = state.deployment;
  const observed = !!observation && observation.source !== 'unavailable' && !!observation.sha;
  const release = observed && observation!.deployed.length ? observation!.sha : null;
  const unverified = !observed;
  const loaded = state.release?.commit ?? null;
  /** A move a completed pass already processed from what the loop loaded, touching no loaded code. */
  const processed = (head: string) => { const last = state.upgrade.last; return last?.to === head && last.code === false && last.from === loaded; };
  if (!state.upgrade.pending && (!release || state.upgrade.alignedRelease === release)) {
    const idle = release ? `release ${shortCommit(release)} was already aligned` : 'no delivered item is verified deployed yet';
    const standing = loaded ? await checkoutState(codeRoot, deps.run) : null, head = standing?.commit ?? null;
    // GY-1773: the checkout a snapshot restart left where it stood. Moved onto the commit the loop
    // runs from the snapshot, it lifts the pin, with no fetch. Still dirty (or on a branch, or of
    // unreadable status) where it stood, it is no restart target: its HEAD is behind the snapshot by
    // design — and a loop not yet running the snapshot (a re-execution that failed) still owes that
    // restart, onto the snapshot, recorded with the dirty paths as they stand now, never as they
    // stood at the failed attempt. Read clean and detached where it stood, it is moved below as any
    // clean checkout is; a status that could not be read is never taken for clean.
    const left = state.upgrade.snapshot, onSnapshot = !!left && sameCommit(loaded, left.commit);
    if (left && head && onSnapshot && sameCommit(head, left.commit)) return lift(head, standing!);
    // The checkout a snapshot restart left dirty, cleaned by hand where it stood: a clean detached
    // checkout the ordinary alignment below moves and restarts from. A clean detached HEAD anywhere
    // else is a foreign move: the pin stands, and the record it leaves names no dirty path (GY-1790),
    // so standing clean there on a later pass is never taken for that cleaning — the rule holds on
    // every pass, not only the one that saw the move.
    const cleaned = !!left && !!head && head === left.checkout && left.dirty.length > 0 && standing!.dirty === false && standing!.detached === true;
    const stays = !!left && !!head && !cleaned;
    if (stays && !onSnapshot) {
      if (standing!.dirty === null) return { outcome: 'skipped', reason: `the restart onto the held snapshot of ${shortCommit(left!.commit)} is still owed, but whether the coordinator checkout at ${shortCommit(head)} is dirty could not be read; retried next cycle` };
      // The owed restart keeps the alignment's own `code`: a docs-only snapshot whose re-execution
      // failed still owes the loop alone, never a fleet restart nothing the executors run calls for.
      const last = state.upgrade.last;
      state.upgrade.pending = { from: loaded, to: left!.commit, code: last && sameCommit(last.to, left!.commit) ? last.code : true };
      await persist();
      return finish(state.upgrade.pending, { checkout: head, dirty: standing!.dirtyPaths });
    }
    // GY-1790: a checkout moved by hand to another commit while the pin stands keeps the pin and
    // is named as left behind where it now stands — never taken for the pin's lift, which only a
    // checkout moved onto the snapshot's own commit and clean there is.
    if (stays) {
      // A status that could not be read changes nothing on the record: where the checkout stands dirty is unknown.
      if (standing!.dirty !== null && (left!.checkout !== head || left!.dirty.join('\n') !== standing!.dirtyPaths.slice(0, 20).join('\n'))) {
        state.upgrade.snapshot = { ...left!, checkout: head, dirty: standing!.dirtyPaths.slice(0, 20) };
        await persist();
      }
      return { outcome: 'skipped', reason: standing!.dirty === false && standing!.detached === true ? `the coordinator checkout stands clean at ${shortCommit(head)}, moved there by hand while the loop runs its held snapshot of ${shortCommit(left!.commit)}; the pin stands until it is moved onto that commit` : idle };
    }
    // GY-1982: a loop that deploys continuously fetches every pass: the base tip it has not deployed is its trigger.
    if (!deploying && !cleaned && (!head || head === loaded || processed(head))) return { outcome: 'skipped', reason: idle };
    if (!deploying && observed && !cleaned && head) {
      // GY-1790: a status that cannot be read is never taken for clean: the failed read is
      // recorded and the restart is retried on the first pass that can read the checkout.
      if (standing!.dirty === null) return unaligned(`the restart onto ${shortCommit(head)} is owed, but whether the coordinator checkout at ${shortCommit(head)} is dirty could not be read; it is never taken for clean, retried next cycle`, 'checkout-failed');
      // The restart owed onto the checkout's own HEAD, with no fetch and no move.
      let code: boolean;
      try { code = upgradeTouchesCode(listedPaths(await git('diff', '--name-only', `${loaded}..${head}`))); }
      catch (error) { return unaligned(`the diff from ${shortCommit(loaded)} to ${shortCommit(head)} could not be read: ${message(error)}`, 'checkout-failed'); }
      state.upgrade.pending = { from: loaded, to: head, code };
      await persist();
      // GY-1790: the checkout may have been dirtied after the restart onto it was first refused or
      // failed — a retried restart never runs the dirty tree: it goes onto a held snapshot of the
      // commit, the checkout left behind with its dirty paths.
      return standing!.dirty === true ? finish(state.upgrade.pending, { checkout: head, dirty: standing!.dirtyPaths }) : finish(state.upgrade.pending);
    }
  }

  // 2. The base tip, from a fresh fetch.
  let to: string;
  try {
    await git('fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${config.baseBranch}:refs/remotes/origin/${config.baseBranch}`);
    to = (await git('rev-parse', `refs/remotes/origin/${config.baseBranch}^{commit}`)).trim();
  } catch (error) {
    // A restart already owed onto the commit the checkout holds needs no fetch: it is attempted, so
    // an origin outage never holds the loop on stale code (GY-1445). A newer tip waits for the next
    // pass that can fetch.
    const owed = state.upgrade.pending, holding = owed ? await checkoutState(codeRoot, deps.run) : null;
    // GY-1773: a snapshot restart owed from a dirty checkout needs no fetch either: the commit is already held.
    if (owed?.code && holding!.dirty === true) return finish(owed, { checkout: holding!.commit, dirty: holding!.dirtyPaths });
    // GY-1790: an unreadable status is never taken for clean: the owed restart waits, recorded.
    if (owed?.code && holding!.dirty === null) return unaligned(`the restart onto ${shortCommit(owed.to)} is still owed, but whether the coordinator checkout at ${shortCommit(holding!.commit)} is dirty could not be read; it is never taken for clean, retried next cycle`, 'checkout-failed');
    if (owed && holding!.commit === owed.to) return finish(owed);
    return unaligned(`the base branch could not be fetched: ${message(error)}`, 'fetch-failed');
  }
  // GY-2169: an alignment that cannot move the server itself never moves the CLI past the commit
  // the server reports: every worker claim the launcher starts is protocol-checked against that
  // commit (releaseSkew), so a checkout or a held pin moved ahead of it refuses every dispatch with
  // `CLI commit X and server commit Y differ` until production catches up. The served release is an
  // ancestor of the tip — production deploys merged code — so the target falls back to it and the
  // loop tracks the server exactly; a commit the server reports that sits below no tip, or an
  // ancestry that cannot be read, leaves the tip as the target and the pass as it was.
  const served = observed ? observation!.sha! : null;
  if (!deploying && served && !sameCommit(served, to)) {
    try { await git('merge-base', '--is-ancestor', served, to); to = served; }
    catch { /* not an ancestor, or unreadable: the tip stands */ }
  }

  // 3. How this checkout stands, before anything touches it.
  const checkout = await checkoutState(codeRoot, deps.run);
  if (!checkout.commit) return unaligned(`the coordinator checkout at ${codeRoot} could not be read`);
  // GY-1982: continuous deploy, from a clean detached checkout. A tip the install does not run is
  // deployed first; only a deployed (or kept) tip goes on to the alignment and the restarts below.
  let deployedFrom: string | null = null;
  if (ports && typeof ports !== 'string' && checkout.dirty === false && checkout.detached === true) {
    const deployed = await deployTip(state, to, checkout.commit, ports, { git, at, persist, note: (detail, failure) => note(detail, failure, deployKey) });
    if (deployed === 'deployed') deployedFrom = checkout.commit; else if (deployed) return deployed;
    Object.assign(checkout, await checkoutState(codeRoot, deps.run));
  }
  if (to === checkout.commit) {
    // The checkout already holds the tip: finish what an earlier pass still owes, or align and
    // clear a refusal that no longer describes anything.
    // GY-1773: a restart owed onto loaded code is never run from a dirty tree, however the checkout came to hold the tip.
    // GY-1790: a status that cannot be read is never taken for clean either: the owed restart
    // waits, the failed read recorded, rather than finishing from a checkout of unknown dirtiness.
    if (state.upgrade.pending) {
      if (checkout.dirty === null) return unaligned(`the restart onto ${shortCommit(to)} is still owed, but whether the coordinator checkout at ${shortCommit(checkout.commit)} is dirty could not be read; it is never taken for clean, retried next cycle`, 'checkout-failed');
      return checkout.dirty === true ? finish(state.upgrade.pending, { checkout: checkout.commit, dirty: checkout.dirtyPaths }) : finish(state.upgrade.pending);
    }
    // The tip itself is code the running loop never loaded: the restart onto it is owed, verified
    // or not (GY-1464), unless a completed pass already processed it without loaded code; a tip deployed now (GY-1982) always is.
    if ((deployedFrom && !sameCommit(loaded, to)) || (loaded && loaded !== to && !processed(to))) {
      if (checkout.dirty === null) return unaligned(`the restart onto ${shortCommit(to)} is owed, but whether the coordinator checkout at ${shortCommit(checkout.commit)} is dirty could not be read; it is never taken for clean, retried next cycle`, 'checkout-failed');
      let code = !!deployedFrom;
      if (!code) try { code = upgradeTouchesCode(listedPaths(await git('diff', '--name-only', `${loaded}..${to}`))); }
      catch (error) { return unaligned(`the diff from ${shortCommit(loaded)} to ${shortCommit(to)} could not be read: ${message(error)}`, 'checkout-failed'); }
      state.upgrade.pending = { from: loaded ?? deployedFrom, to, code };
      await persist();
      return checkout.dirty === true ? finish(state.upgrade.pending, { checkout: checkout.commit, dirty: checkout.dirtyPaths }) : finish(state.upgrade.pending);
    }
    const cleared = !!state.upgrade.refused;
    state.upgrade.alignedRelease = release ?? state.upgrade.alignedRelease;
    if (state.upgrade.snapshot) return lift(to, checkout);
    state.upgrade.refused = null;
    unstall();
    await persist();
    if (cleared) await note(`The checkout is current at ${shortCommit(to)}; the earlier refusal is cleared`, false);
    return { outcome: 'up-to-date', commit: to };
  }
  if (checkout.dirty === true) {
    // GY-1773: a dirty checkout is never touched — no stash, reset, checkout or clean — and holds
    // nothing back: every newer merged commit, docs only or not, is snapshotted under
    // .graphyard/held-cli and the restarts go onto the snapshot, the checkout left where it stands.
    // The fetch already brought the tip's objects, which the snapshot shares.
    const owed = state.upgrade.pending?.code === true;
    if (state.upgrade.pending) { state.upgrade.pending = null; await persist(); }
    // The diff's base is what runs: the loop already on a held snapshot runs that commit, and the
    // checkout's own HEAD, behind it since it was left there, says nothing about what is loaded — a
    // tip that reverts the snapshot's loaded-code change shares the checkout's tree yet moves the
    // executors' code, and a docs-only tip over a code snapshot moves none of it.
    const runs = !!loaded && (unverified || sameCommit(loaded, state.upgrade.snapshot?.commit));
    const from = checkout.commit, base = runs ? loaded! : from, left: LeftBehind = { checkout: from, dirty: checkout.dirtyPaths };
    let changed: string[], code: boolean;
    try {
      changed = listedPaths(await git('diff', '--name-only', `${base}..${to}`));
      code = owed || upgradeTouchesCode(changed);
    } catch (error) { return unaligned(`the diff from ${shortCommit(base)} to ${shortCommit(to)} could not be read: ${message(error)}`, 'checkout-failed'); }
    if (!code) {
      await note(`Snapshotting base tip ${shortCommit(to)} for the loop: the coordinator checkout is dirty at ${shortCommit(from)}${nameDirty(left)} and stays where it is; ${changed.length} path(s) changed, none of them loaded code`, false);
      state.upgrade.pending = { from, to, code: false };
      await persist();
      return finish({ from, to, code: false }, left);
    }
    await note(`Snapshotting base tip ${shortCommit(to)} for the loop and the executors: the coordinator checkout is dirty at ${shortCommit(from)}${nameDirty(left)} and stays where it is; ${changed.length} path(s) changed, loaded code among them`, false);
    state.upgrade.pending = { from, to, code: true };
    await persist();
    return finish({ from, to, code: true }, left);
  }
  if (checkout.detached !== true) return refused(`HEAD holds ${checkout.branch ?? 'a branch'} instead of standing detached; it is upgraded only as a clean detached checkout of ${config.baseBranch}`, checkout.commit, 'checkout-not-detached');

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
    changed = listedPaths(await git('diff', '--name-only', `${base}..${to}`));
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
  // GY-1899: the moved HEAD a recovery judges and adopts is the CLI checkout's (`loopCodeRoot`), never the managed repository's.
  const codeRoot = loopCodeRoot(config.cliPath, deps.root);
  const git = (...args: string[]) => deps.run('git', ['-C', codeRoot, ...args]);
  const persist = async () => { if (deps.persist) await deps.persist(state); };
  const key = 'upgrade:recovered';
  const note = async (detail: string, failure: boolean) => {
    if (failure && !detailChanged(state.actions[key], detail)) { touchStanding(state, key, at()); return; }
    storeAction(state, key, { kind: 'config', work: null, principal: null, state: failure ? 'failed' : 'done', detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, epoch: null, cycle: state.cycle, at: at() });
    await persist();
  };
  const checkout = await checkoutState(codeRoot, deps.run);
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
  try { code = upgradeTouchesCode(listedPaths(await git('diff', '--name-only', `${from}..${to}`))); }
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
