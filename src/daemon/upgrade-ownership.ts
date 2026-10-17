// Concern: GY-1958 — which project the CLI checkout tracks, decided before the self-upgrade
// touches anything: the managed repository's base branch may be fetched and checked out only where
// the checkout belongs to that repository's project, and this module is the whole of that judgement.
import { realpathSync } from 'node:fs';
import type { ChildRun } from '../child-runner.js';

/** The origin's identity: its host and path, whatever scheme or scp spelling names them, so one upstream spelled two ways still reads as one. */
const originIdentity = (url: string) => url.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^git@/, '').replace(/\.git\/?$/, '').replace(/:+/g, '/').replace(/\/{2,}/g, '/');

/**
 * The standing refusal an external install's pass records (GY-1958). Master status reads it through
 * the upgrade-refusal attention, whose text names the checkout remedy an own-repository install
 * needs; this reason says that here the remedy does not apply, and what upgrades the install
 * instead. Within the cursor's 500-character bound for a refusal reason.
 */
export const externalUpgradeRefusal = 'the managed repository is not the repository the coordinator checkout holds, so the loop runs no self-upgrade on this install: it never fetches in or moves the checkout, and the install upgrades when `graphyard upgrade` runs on it; the checkout remedy this attention names belongs to an own-repository install, never to this one';

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
