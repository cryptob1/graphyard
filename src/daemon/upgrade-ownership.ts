// Concern: GY-1958 — which project the CLI checkout tracks, decided before the self-upgrade
// touches anything, and the pass an install managing another project runs instead: the managed
// repository's base branch may be fetched and checked out only where the checkout belongs to it.
import { realpathSync } from 'node:fs';
import type { ChildRun } from '../child-runner.js';
import { shortCommit } from '../executor-fleet.js';
import type { DaemonState } from './state.js';
import { touchStanding } from './state-cursor.js';
import { detailChanged } from './decisions.js';
import { checkoutState } from './checkout-state.js';
import type { SelfUpgradeOutcome } from './upgrade.js';

/**
 * The origin's identity: its host and path, whatever scheme or scp spelling names them, so one
 * upstream spelled two ways still reads as one. Only the host is case-folded: a path is
 * case-sensitive on a filesystem origin, so two origins differing in path case are two projects.
 */
const originIdentity = (url: string) => {
  const bare = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]*@/, '').replace(/\.git\/?$/, '').replace(/:+/g, '/').replace(/\/{2,}/g, '/');
  // A filesystem origin is all path; a remote one's first segment is its host.
  if (bare.startsWith('/')) return bare;
  const slash = bare.indexOf('/');
  return slash < 0 ? bare.toLowerCase() : `${bare.slice(0, slash).toLowerCase()}${bare.slice(slash)}`;
};

/** The words every external install's refusal starts with: master status renders it as its own attention. */
const externalRefusalLead = 'the managed repository is another project than the coordinator checkout';
/**
 * The standing refusal an external install's pass records (GY-1958): the loop runs no self-upgrade
 * here, and the install upgrades by command. Within the cursor's 500-character bound for a reason.
 */
export const externalUpgradeRefusal = `${externalRefusalLead}, so the loop runs no self-upgrade on this install: it never fetches in or moves the checkout, and the install upgrades by command — the checkout is moved to the Graphyard release it should run, and graphyard up restarts the loop and the executors onto it`;
/** Whether a recorded refusal is the external install's, not a checkout an own-repository install must clear. */
export const isExternalUpgradeRefusal = (reason: string) => reason.startsWith(externalRefusalLead);

/**
 * GY-1958: whether the upgrade's own checkout belongs to the managed repository's project — an
 * install whose self-upgrade may fetch and check out `config.baseBranch`, because that branch name
 * names a base branch of the code the checkout tracks. Judged from what git itself holds, in two
 * probes: one repository serving two checkouts (a linked worktree) shares git's common directory,
 * and two checkouts of one upstream — the fork-or-second-checkout shape — carry the same origin,
 * whatever scheme or scp spelling names it. A managed root that is no repository, holds another
 * origin than the checkout's, or holds none is a different project here: its verified deployments
 * say nothing about this checkout's code, so its base branch is never fetched. A read that fails
 * any other way is taken for the checkout's own, so one failed child never stops an own install's
 * upgrades — the next pass reads it again.
 */
export async function managesOwnCheckout(codeRoot: string, managedRoot: string, run: ChildRun): Promise<boolean> {
  if (codeRoot === managedRoot) return true;
  // A definitive "absent" — git exits 128 for no repository, 2 for no such remote — reads as '',
  // judged on its own terms; any other failed read reads as null, the checkout's own by default.
  const read = async (root: string, args: string[], absent: readonly number[]): Promise<string | null> => {
    try { return (await run('git', ['-C', root, ...args])).trim() || null; }
    catch (error: any) { return absent.includes(error?.status) ? '' : null; }
  };
  const real = (directory: string) => { try { return realpathSync(directory); } catch { return directory; } };
  const [managedCommon, codeCommon] = await Promise.all([
    read(managedRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'], [128]),
    read(codeRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'], [128]),
  ]);
  if (managedCommon === '' || codeCommon === '') return false;
  if (managedCommon !== null && codeCommon !== null && real(codeCommon) === real(managedCommon)) return true;
  const [managedOrigin, codeOrigin] = await Promise.all([
    read(managedRoot, ['remote', 'get-url', 'origin'], [2, 128]),
    read(codeRoot, ['remote', 'get-url', 'origin'], [2, 128]),
  ]);
  if (managedOrigin === '' || codeOrigin === '') return false;
  if (managedOrigin === null || codeOrigin === null) return true;
  return originIdentity(codeOrigin) === originIdentity(managedOrigin);
}

/** The upgrade pass's own steps an external install's pass runs through. */
export interface ExternalInstallSteps {
  at: () => string;
  persist: () => Promise<void>;
  unstall: () => void;
  /** Records the standing refusal: the cursor, and its deduplicated `upgrade:refused` row. */
  refused: (reason: string, commit: string | null) => Promise<SelfUpgradeOutcome>;
  /** Records on `upgrade:align`. */
  note: (detail: string, failure: boolean) => Promise<void>;
  /** Lifts the held-cli pin and returns the units to the checkout's launcher, as a lift does: null once done, else why not. */
  settle: () => Promise<string | null>;
}

/**
 * GY-1958: the pass on an install whose managed repository is another project. `config.baseBranch`
 * names that project's base branch; fetching it in the CLI checkout would pull whatever shares the
 * ref name in the checkout's own origin — Graphyard's unreleased main — and move the checkout onto
 * it, so no alignment runs: the checkout stays where it stands and the pass records that the
 * install upgrades by command. What an earlier loop left owed while it still aligned this install —
 * a restart owed onto a moved checkout, a held snapshot's pin, a stall — is retired first, since
 * the alignment that would meet it never runs here again: the pin is lifted, the units returned to
 * the checkout's launcher and the cursor forgets it; the loop and the executors keep their loaded
 * code until `up` restarts them. A step that fails keeps the record, says why once and is retried
 * next pass. The refusal is written once: a pass finding it standing at the same commit only
 * touches its action row, so the cursor, the row and master status's attention stay as they are.
 */
export async function externalInstallPass(state: DaemonState, codeRoot: string, run: ChildRun, steps: ExternalInstallSteps): Promise<SelfUpgradeOutcome> {
  const owed = state.upgrade.pending, left = state.upgrade.snapshot, stalled = state.upgrade.stalled;
  if (owed || left || stalled) {
    const unsettled = await steps.settle();
    if (unsettled) {
      const detail = `This install's managed repository is another project, so the loop no longer aligns its checkout, but what an earlier alignment left owed could not be retired: ${unsettled}; retried next cycle`;
      if (detailChanged(state.actions['upgrade:align'], detail)) await steps.note(detail, true);
    } else {
      const retired = [owed ? `the restart owed onto ${shortCommit(owed.to)}` : '', left ? `the held snapshot of ${shortCommit(left.commit)} and its pin` : '', stalled ? `the ${stalled.cause} stall` : ''].filter(Boolean).join(', ');
      state.upgrade.pending = null;
      delete state.upgrade.snapshot;
      steps.unstall();
      await steps.persist();
      await steps.note(`Retired ${retired}: this install's managed repository is another project, so the loop no longer aligns its checkout; the loop and the executors keep their loaded code until graphyard up restarts them onto the checkout`, false);
    }
  }
  const standing = await checkoutState(codeRoot, run), prior = state.upgrade.refused;
  if (prior?.reason !== externalUpgradeRefusal || prior.commit !== standing.commit) return steps.refused(externalUpgradeRefusal, standing.commit);
  touchStanding(state, 'upgrade:refused', steps.at());
  return { outcome: 'refused', reason: prior.reason, commit: prior.commit };
}
