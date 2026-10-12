// Concern: the quiesce-and-restore act of `master checkout-restore` (GY-1658, GY-1680) — with the checkout's writers frozen, every dirty path saved under a named ref and returned to HEAD, and, for the command's old-HEAD handoff, the clean checkout advanced onto the serving release under the same freeze. The requests, the loop's side and the command side are master-checkout-restore.ts's and checkout-restore-command.ts's.
import { copyFileSync, existsSync, lstatSync, mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ChildProcessError, type ChildRun, defaultChildRun } from '../child-runner.js';
import { freezeCheckoutWriters, type UnverifiableProcess } from './checkout-writers.js';

/** Where restored checkout contents are kept, one ref per restore. */
export const checkoutRestoreRefPrefix = 'refs/graphyard/checkout-restore/';

/**
 * Every path `git status --porcelain -z` names, rename and copy origins included: every non-ignored
 * dirty path — tracked changes and untracked files alike, wherever they lie — which a restore saves
 * and returns to HEAD.
 */
export function statusPaths(status: string): string[] {
  const paths: string[] = [], entries = status.split('\0');
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index], xy = entry.slice(0, 2);
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if ((xy.includes('R') || xy.includes('C')) && xy !== '??') { if (entries[index + 1]) paths.push(entries[index + 1]); index++; }
  }
  return [...new Set(paths)];
}
/** Whether `ancestor` is an ancestor of `descendant` (a commit is its own); null when Git cannot say (a commit the store lacks). */
async function isAncestor(root: string, ancestor: string, descendant: string, run: ChildRun): Promise<boolean | null> {
  try { await run('git', ['-C', root, 'merge-base', '--is-ancestor', ancestor, descendant]); return true; }
  catch (error) { return error instanceof ChildProcessError && error.status === 1 ? false : null; }
}
/**
 * GY-1745: what a diverged HEAD is judged against: `base`, the base branch's ref at origin; `loaded`,
 * the commit the loop runs (null when none is known: nothing is then diverged); `serving`, the release the checkout moves onto
 * (the verified serving release, else the base tip).
 */
export interface DivergeInputs { base: string; loaded: string | null; serving: string }
/**
 * The detached HEAD of a checkout that is diverged (GY-1745): neither an ancestor of the base
 * branch's tip (merged code, which the existing paths adopt) nor a descendant of the commit the loop
 * loaded (a forward move the loop recovers onto). Null for a branch checkout, a HEAD Git cannot
 * judge against the base ref, or a HEAD that takes the existing paths.
 */
export async function divergedHead(root: string, inputs: Pick<DivergeInputs, 'base' | 'loaded'>, run: ChildRun = defaultChildRun): Promise<string | null> {
  try { await run('git', ['-C', root, 'symbolic-ref', '-q', 'HEAD']); return null; }
  catch (error) { if (!(error instanceof ChildProcessError) || error.status !== 1) return null; }
  let head: string;
  try { head = String(await run('git', ['-C', root, 'rev-parse', 'HEAD'])).trim(); } catch { return null; }
  if (!head || await isAncestor(root, head, inputs.base, run) !== false) return null;
  // Without the commit the loop runs there is nothing to call a forward move, so nothing is judged diverged.
  if (!inputs.loaded || await isAncestor(root, inputs.loaded, head, run) !== false) return null;
  return head;
}
const refStamp = (at: Date) => at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * With the checkout's writers frozen (`quiesce`, which throws before anything is touched when it
 * cannot establish that), commit the index as it stands and every non-ignored dirty path (statusPaths:
 * tracked changes, untracked files anywhere, rename origins) onto HEAD — the index as the second
 * parent, the working files as the tree — record the commit under a named ref, then return those
 * paths to HEAD: tracked ones checked out from it, ones HEAD lacks removed. Null when nothing is
 * dirty. Throws, with the ref named when it was already written, when the checkout is still dirty
 * after; the writers this attempt stopped are continued whatever happens. `skipped` names the
 * processes the freeze skipped because their cwd could not be read (EACCES). With `advance` (the
 * command's old-HEAD handoff, review of GY-1680), the clean checkout is then moved onto that commit —
 * `git checkout --detach` — while the writers still stand frozen: a HEAD advance after the thaw would
 * let a writer resume and change the checkout while HEAD and the tracked files move under it. A
 * restore that saved its paths but whose advance fails throws naming the ref, the paths standing at
 * HEAD as returned.
 */
type Quiesced = { thaw: () => void; skipped?: UnverifiableProcess[] };
export type CheckoutQuiesce = (root: string) => Quiesced | Promise<Quiesced>;
export async function restoreCoordinatorCheckout(root: string, reason: string, run: ChildRun = defaultChildRun, at = new Date(), quiesce: CheckoutQuiesce = freezeCheckoutWriters, advance: string | null = null, diverge: DivergeInputs | null = null): Promise<{ ref: string; commit: string; paths: string[]; skipped: UnverifiableProcess[] } | null> {
  return (await restoreCheckoutFrozen(root, reason, run, at, quiesce, advance, diverge)).restored;
}
/**
 * restoreCoordinatorCheckout and, with `diverge` (GY-1745), the diverged-HEAD heal under the same
 * freeze: a detached HEAD that is neither on the base branch nor a descendant of the loaded commit
 * is saved under refs/graphyard/checkout-restore/diverged-STAMP-COMMIT (a ref, so git gc keeps it)
 * and the checkout is detached at `diverge.serving`. Judged after any dirty paths were saved and
 * returned, so the checkout is clean when it moves; skipped for the old-HEAD handoff's `advance`.
 */
export async function restoreCheckoutFrozen(root: string, reason: string, run: ChildRun = defaultChildRun, at = new Date(), quiesce: CheckoutQuiesce = freezeCheckoutWriters, advance: string | null = null, diverge: DivergeInputs | null = null): Promise<{ restored: { ref: string; commit: string; paths: string[]; skipped: UnverifiableProcess[] } | null; diverged: { ref: string; from: string; to: string } | null }> {
  const frozen = await quiesce(root);
  try {
    const restored = await restoreQuiesced(root, reason, run, at);
    if (advance) await advanceQuiesced(root, advance, run, restored);
    const diverged = !advance && diverge ? await healDiverged(root, reason, run, at, diverge, restored) : null;
    return { restored: restored && { ...restored, skipped: frozen.skipped ?? [] }, diverged };
  } finally { frozen.thaw(); }
}
async function healDiverged(root: string, reason: string, run: ChildRun, at: Date, diverge: DivergeInputs, restored: { ref: string; commit: string; paths: string[] } | null) {
  const from = await divergedHead(root, diverge, run);
  if (!from) return null;
  const ref = `${checkoutRestoreRefPrefix}diverged-${refStamp(at)}-${from.slice(0, 12)}`;
  await run('git', ['-C', root, 'update-ref', '-m', `graphyard checkout-restore: diverged HEAD, ${reason.slice(0, 200)}`, ref, from, '']);
  // Only once the ref holds the HEAD is the checkout moved off it.
  await advanceQuiesced(root, diverge.serving, run, restored);
  return { ref, from, to: diverge.serving };
}
/** The clean, still-quiesced checkout moved onto `commit`, detached, and read back as standing there. */
async function advanceQuiesced(root: string, commit: string, run: ChildRun, restored: { ref: string; commit: string; paths: string[] } | null) {
  const saved = restored ? `${restored.paths.length} dirty path(s) were saved under ${restored.ref} (${restored.commit.slice(0, 12)}) and returned to HEAD, but ` : '';
  let head: string;
  try {
    await run('git', ['-C', root, 'checkout', '-q', '--detach', commit]);
    head = String(await run('git', ['-C', root, 'rev-parse', 'HEAD'])).trim();
  } catch (error) { throw new Error(`${saved}the coordinator checkout at ${root} could not be advanced onto ${commit.slice(0, 12)} while its writers stood frozen (${(error instanceof Error ? error.message : String(error)).split('\n')[0]})`); }
  if (head !== commit) throw new Error(`${saved}the coordinator checkout at ${root} stands at ${head.slice(0, 12)} after being advanced onto ${commit.slice(0, 12)} while its writers stood frozen`);
}
async function restoreQuiesced(root: string, reason: string, run: ChildRun, at: Date) {
  const git = async (args: string[], env?: NodeJS.ProcessEnv) => String(await run('git', ['-C', root, '--literal-pathspecs', ...args], env ? { env } : undefined));
  const head = (await git(['rev-parse', 'HEAD'])).trim();
  // Every untracked file by its own path (GY-1658 review): `normal` collapses an untracked directory to
  // `dir/`, which `git add` saves without its ignored descendants while a recursive removal would delete them.
  const status = () => git(['status', '--porcelain', '-z', '--untracked-files=all']);
  const paths = statusPaths(await status());
  if (!paths.length) return null;
  // Only a nested repository is still named as a directory; its history is not the checkout's to save.
  const nested = paths.filter(path => path.endsWith('/'));
  if (nested.length) throw new Error(`the coordinator checkout at ${root} holds untracked nested repositories (${nested.slice(0, 8).join(', ')}), which a restore cannot save, so nothing was restored`);
  // A tracked path HEAD holds as a file but the working tree holds as a directory: checking the file out
  // deletes the whole directory, ignored descendants included, which no ref saves (GY-1658 review).
  const holdsInHead = (path: string) => Promise.resolve(run('git', ['-C', root, 'cat-file', '-e', `${head}:${path}`])).then(() => true, () => false);
  const shadowed: string[] = [];
  for (const path of paths) {
    let directory = false; try { directory = lstatSync(join(root, path)).isDirectory(); } catch { /* absent */ }
    if (!directory || !await holdsInHead(path)) continue;
    const ignored = (await git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', path])).split('\0').filter(Boolean);
    shadowed.push(...ignored);
  }
  if (shadowed.length) throw new Error(`the coordinator checkout at ${root} holds ignored files (${shadowed.slice(0, 8).join(', ')}) in a directory standing where HEAD has a file, which returning that file to HEAD would delete and a restore cannot save, so nothing was restored`);
  const scratch = mkdtempSync(join(tmpdir(), 'graphyard-checkout-restore-'));
  let commit: string;
  try {
    const identity = ['-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@localhost'];
    const message = `graphyard checkout-restore: ${paths.length} dirty path(s) of the coordinator checkout at ${head.slice(0, 12)}\n\n${reason}\n\n${paths.join('\n')}`;
    // The index as it stands, staged versions included, read from a copy so the real one is untouched; an unmerged index refuses here.
    const staged = { ...process.env, GIT_INDEX_FILE: join(scratch, 'staged') }, realIndex = resolve(root, (await git(['rev-parse', '--git-path', 'index'])).trim());
    if (existsSync(realIndex)) copyFileSync(realIndex, staged.GIT_INDEX_FILE); else await git(['read-tree', head], staged);
    const index = (await git([...identity, 'commit-tree', (await git(['write-tree'], staged)).trim(), '-p', head, '-m', `index of ${message}`], staged)).trim();
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
    await git(['read-tree', head], env);
    await git(['add', '-A', '--', ...paths], env);
    commit = (await git([...identity, 'commit-tree', (await git(['write-tree'], env)).trim(), '-p', head, '-p', index, '-m', message], env)).trim();
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  // The stamp and the commit: two restores within one second never collide.
  const ref = `${checkoutRestoreRefPrefix}${refStamp(at)}-${commit.slice(0, 12)}`;
  await git(['update-ref', '-m', `graphyard checkout-restore: ${reason.slice(0, 200)}`, ref, commit, '']);
  // Only once the ref holds them are the paths returned to HEAD.
  const tracked: string[] = [], added: string[] = [];
  const holds = (tree: string, path: string) => Promise.resolve(run('git', ['-C', root, 'cat-file', '-e', `${tree}:${path}`])).then(() => true, () => false);
  for (const path of paths) (await holdsInHead(path) ? tracked : added).push(path);
  // A path is removed only once the saved tree is proven to hold it; one deleted in the working tree is absent from both and already gone.
  const unsaved: string[] = [];
  for (const path of added) if (existsSync(join(root, path)) && !await holds(commit, path)) unsaved.push(path);
  if (unsaved.length) throw new Error(`the restore commit ${commit.slice(0, 12)} under ${ref} does not hold ${unsaved.slice(0, 8).join(', ')}, so nothing was returned to HEAD`);
  // Forced: a path staged differently from both HEAD and its file is already saved in the ref's second parent.
  if (added.length) await git(['rm', '-r', '-q', '-f', '--cached', '--ignore-unmatch', '--', ...added]);
  for (const path of added) await rm(join(root, path), { force: true });
  // The directories those files emptied go too; one still holding anything (an ignored file) stays.
  const parents = [...new Set(added.flatMap(path => path.split('/').slice(0, -1).map((_, depth, parts) => parts.slice(0, depth + 1).join('/'))))];
  for (const directory of parents.sort((a, b) => b.length - a.length)) { try { rmdirSync(join(root, directory)); } catch { /* not empty, or not ours */ } }
  // Tracked paths last: a directory standing where HEAD has a file is empty by now, and the checkout replaces it.
  if (tracked.length) await git(['checkout', head, '--', ...tracked]);
  const after = statusPaths(await status());
  if (after.length) throw new Error(`the coordinator checkout at ${root} is still dirty after its paths were saved under ${ref} (${commit.slice(0, 12)}): ${after.slice(0, 8).join(', ')}`);
  return { ref, commit, paths };
}

/** What a restore act returns: the restore (null when nothing was dirty), the checkout's HEAD after, which code served it, and — when the command's old-HEAD handoff served — the release commit the entry advanced the checkout onto under its freeze, which `head` then is. */
export interface RestoreActOutcome { restored: { ref: string; commit: string; paths: string[]; skipped: UnverifiableProcess[] } | null; head: string | null; /** GY-1745: the diverged HEAD saved under `ref` and the release the checkout was moved onto (`to`). */ diverged?: { ref: string; from: string; to: string } | null; served?: string; release?: string }
/** The quiesce-and-restore of a checkout-restore request (GY-1680), told which standing request it serves: the loop's runs it from the serving release under a grant naming that request (checkout-restore-release.ts). */
export type RestoreAct = (root: string, reason: string, at: Date, request: { file: string; id: string }) => Promise<RestoreActOutcome>;
/** The restore act run by this process's own code: what the serve entry runs in the release snapshot. The loop never runs it on its loaded code (GY-1680). With `advance` (the old-HEAD handoff's grant), the checkout is moved onto that commit under the same freeze, and `head` reports it. */
export const restoreInProcess = (run: ChildRun = defaultChildRun, quiesce?: CheckoutQuiesce, advance: string | null = null, diverge: (() => Promise<DivergeInputs | null>) | null = null): RestoreAct => async (root, reason, at) => {
  const { restored, diverged } = await restoreCheckoutFrozen(root, reason, run, at, quiesce, advance, await diverge?.() ?? null);
  const head = String(await run('git', ['-C', root, 'rev-parse', 'HEAD'])).trim() || null;
  return { restored, head, ...(diverged ? { diverged } : {}) };
};
