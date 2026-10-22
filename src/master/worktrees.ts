// Concern: removing ended attempts' worktrees, managed checkouts and shared installs, and preparing assignment worktrees: the dispatch cycle's one shared base fetch.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { statfs, readdir, lstat, realpath, rm, mkdir, symlink, writeFile, readFile, rename, appendFile, unlink, rmdir, open, cp } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import type { ChildRun } from '../child-runner.js';
import type { Work } from '../model.js';
import { submittedBranchMoved } from '../model/assignment.js';
import { branchHolders, heldBranchRefusal, holderRefusals } from '../worktree-holders.js';
import { type WorktreeRootHealth, worktreeRootConcerns, type FilesystemProbe, type SessionCheckout, type CheckoutKind, worktreeRoot, verifyWorktreeRoot, worktreeRootMinFreeBytes, allocateSessionCheckout, removeSessionCheckout, inspectWorktreeRoot, worktreeRootBudgetBytes } from '../install/worktree-root.js';
import type { MasterConfig, MasterRun } from './profiles.js';
import { assertOutsideWorktrees } from './config.js';
import { agentOwner, type AttentionItem } from './attention.js';

/*
 * Assignment worktrees are the loop's largest consumer of disk: every attempt checks the
 * repository out again. One install is shared by the worktrees that can use it, and the loop
 * removes an attempt's worktree once the attempt ends (`removeAttemptWorktree`).
 */

/** The dependency trees a package manager recreates from the lockfile. */
export const dependencyDirectories = ['node_modules'] as const;
export const lockfiles = ['package-lock.json'] as const;
export const worktreesDirectory = (root: string) => resolve(root, '.graphyard/worktrees');
export const failureText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * A write that failed because there is no room left, said as exactly that. A full volume and an
 * exhausted user quota arrive as an errno on a direct write and as text in a child command's
 * output (`pwd: write error: Disk quota exceeded`); both are the same condition, and reporting
 * it as an unexplained command failure is what sends the next investigation to the wrong place.
 */
export function diskExhaustion(error: unknown): string | null {
  const record = error as { code?: unknown; stderr?: unknown; stdout?: unknown; message?: unknown } | null;
  const code = typeof record?.code === 'string' ? record.code : '';
  if (code === 'ENOSPC') return 'the volume is full (ENOSPC)';
  if (code === 'EDQUOT') return "the host's disk quota is exhausted (EDQUOT)";
  const text = [record?.message, record?.stderr, record?.stdout].filter(value => typeof value === 'string' || Buffer.isBuffer(value)).join('\n');
  if (/no space left on device/i.test(text)) return 'the volume is full (ENOSPC)';
  if (/disk quota exceeded/i.test(text)) return "the host's disk quota is exhausted (EDQUOT)";
  return null;
}
export const reclaimAdvice = 'free space on the volume, then retry; the master loop removes each assignment worktree once its attempt ends';
/** The path a failed write was aimed at: the one the caller names, or the one the system call reported. */
export function exhaustedPath(error: unknown, path?: string): string | null {
  const reported = (error as { path?: unknown; dest?: unknown } | null);
  return path ?? (typeof reported?.path === 'string' ? reported.path : typeof reported?.dest === 'string' ? reported.dest : null);
}
/** Disk exhaustion as one sentence: the condition, the path that could not be written, and the remedy. Null for any other failure. */
export function diskExhaustionMessage(error: unknown, path?: string): string | null {
  const cause = diskExhaustion(error);
  if (!cause) return null;
  const at = exhaustedPath(error, path);
  return `${cause}${at ? ` at ${at}` : ''}: ${reclaimAdvice}`;
}
/** The same failure, named by its cause when the cause is exhausted disk and left alone otherwise. */
export function writeFailure(error: unknown, action: string, path?: string): Error {
  const exhausted = diskExhaustionMessage(error, path);
  if (!exhausted) return error instanceof Error ? error : new Error(String(error));
  return Object.assign(new Error(`${action} failed because ${exhausted}`), { code: (error as { code?: string } | null)?.code ?? 'ENOSPC', cause: error });
}

/** Free space on the volume holding a path, as the kernel reports it to this user. */
export async function freeBytes(path: string): Promise<number | null> {
  try { const info = await statfs(path); return Number(info.bavail) * Number(info.bsize); } catch { return null; }
}

/**
 * Remove an ended attempt's assignment worktree with `git worktree remove`, never forced: Git keeps a
 * tree with uncommitted changes, and the branch it had checked out survives. A shared install linked
 * into the tree is unlinked first, since it is no work of the attempt's. Whether a tree was removed:
 * one already gone, or a path that is not directly inside `worktreesDirectory`, is nothing to do.
 */
export async function removeAttemptWorktree(root: string, path: string, run: ChildRun): Promise<boolean> {
  const target = resolve(path);
  if (dirname(target) !== worktreesDirectory(root) || !existsSync(target)) return false;
  for (const name of dependencyDirectories) if ((await lstat(resolve(target, name)).catch(() => null))?.isSymbolicLink()) await unlink(resolve(target, name));
  await Promise.resolve(run('git', ['-C', root, 'worktree', 'remove', target]));
  return true;
}

/**
 * The managed worktree root's attention items: a root on a tmpfs, a volume below its configured
 * minimum, or a root that has grown to most of its budget, each raised while writes still succeed.
 */
export function worktreeRootAttention(health: WorktreeRootHealth): AttentionItem[] {
  return worktreeRootConcerns(health).map(text => ({ subject: 'disk', text,
    ...agentOwner('master', health.volatile && !health.low && !health.overBudget
      ? 'Set run.worktreeRoot in .graphyard/master.json to an absolute path on durable storage, outside every worktree; master run adopts it on its next cycle'
      : 'Raise run.worktreeRootBudgetGb or move run.worktreeRoot in .graphyard/master.json if the live sessions need more room; each settled session removes its own checkout') }));
}

/**
 * Allocate one session's directory under the managed worktree root. The root is verified on every
 * launch, not only at setup — a volume fills, and a configuration is edited — and the allocated
 * directory is held to the same rule as every other path Graphyard owns: outside every worktree.
 */
export async function allocateManagedCheckout(root: string, config: MasterConfig, kind: CheckoutKind, key: string, sha: string, id: string, probe?: FilesystemProbe): Promise<SessionCheckout> {
  const base = worktreeRoot(root, config);
  await assertOutsideWorktrees(root, base, 'The managed worktree root', { create: true });
  await verifyWorktreeRoot(base, { minFreeBytes: worktreeRootMinFreeBytes(config), probe });
  let checkout: SessionCheckout;
  try { checkout = await allocateSessionCheckout(base, kind, key, sha, id); }
  catch (error) { throw writeFailure(error, `Allocating a ${kind} checkout under the managed worktree root`, base); }
  try { await assertOutsideWorktrees(root, checkout.directory, 'An ephemeral checkout'); }
  catch (error) { await removeSessionCheckout(root, base, checkout.directory).catch(() => {}); throw error; }
  return checkout;
}
/** Remove a settled session's checkout; the reason when it could not be, never a throw. */
export async function settleCheckout(root: string, directory: string | undefined, run?: ChildRun): Promise<string | null> {
  if (!directory) return null;
  try { await removeSessionCheckout(root, dirname(directory), directory, run); return null; }
  catch (error) { return writeFailure(error, 'Removing the ephemeral checkout', directory).message.slice(0, 500); }
}
/** The managed worktree root as `master status` reports it, with the attention it raises. `sessions` are the review and producer records. */
export async function managedRootStatus(root: string, config: MasterConfig, sessions: { state: string; checkout?: string }[], dependencies: Parameters<typeof inspectWorktreeRoot>[3] = {}) {
  const live = sessions.filter(record => record.state === 'pending' && record.checkout).map(record => record.checkout!);
  const health = await inspectWorktreeRoot(worktreeRoot(root, config), { minFreeBytes: worktreeRootMinFreeBytes(config), budgetBytes: worktreeRootBudgetBytes(config) }, live, dependencies);
  return { health, attention: worktreeRootAttention(health) };
}

/**
 * One dependency install, shared by every worktree that can use it. A fresh attempt must start
 * from a clean checkout of its exact head; what it must not do is spend another gigabyte, and the
 * first minutes of its session, on a private copy of dependencies it resolves identically.
 *
 * A worktree created under the repository already resolves the repository's own install by the
 * runtime's ordinary upward lookup, so the right answer there is to install nothing and say so. A
 * worktree outside it gets a mirror instead: a real directory of links, one per installed package,
 * so the repository's `node_modules/` ignore rule still covers it and the checkout stays clean.
 * Either way the install must answer for this exact head — the same lockfile, byte for byte — and a
 * worktree that already has an install of its own is reported and left exactly as it is.
 */
export const sharedInstallMarker = '.graphyard-shared';
export interface SharedDependency { name: string; source: string; how: 'reachable' | 'mirrored' }
export interface SharedDependencies { shared: SharedDependency[]; skipped: { name: string; reason: string }[] }
export async function shareDependencies(root: string, worktree: string): Promise<SharedDependencies> {
  const shared: SharedDependency[] = [], skipped: { name: string; reason: string }[] = [];
  for (const name of dependencyDirectories) {
    const own = resolve(worktree, name);
    if (await lstat(own).catch(() => null)) {
      const mirrored = await sharedInstallSource(own);
      if (mirrored) shared.push({ name, source: mirrored, how: 'mirrored' });
      else skipped.push({ name, reason: `The worktree already has its own ${name}; it is left exactly as it is` });
      continue;
    }
    // What the runtime would resolve from this worktree, before anything is created for it.
    const reachable = await reachableInstall(worktree, name);
    if (reachable) {
      const compatible = await compatibleInstall(dirname(reachable), worktree);
      if (compatible === true) shared.push({ name, source: reachable, how: 'reachable' });
      else skipped.push({ name, reason: compatible });
      continue;
    }
    const source = resolve(root, name);
    if (!(await lstat(source).catch(() => null))?.isDirectory()) { skipped.push({ name, reason: `No shared ${name} install is reachable from ${worktree}` }); continue; }
    const compatible = await compatibleInstall(root, worktree);
    if (compatible !== true) { skipped.push({ name, reason: compatible }); continue; }
    try {
      const entries = await readdir(source);
      await mkdir(own, { recursive: true });
      await Promise.all(entries.map(entry => symlink(resolve(source, entry), resolve(own, entry))));
      // Written last, so a half-made mirror is never mistaken for a complete one.
      await writeFile(resolve(own, sharedInstallMarker), `${source}\n`);
      shared.push({ name, source, how: 'mirrored' });
    } catch (error) {
      // A partial mirror would resolve some imports and fail others, which is worse than none.
      await rm(own, { recursive: true, force: true }).catch(() => {});
      skipped.push({ name, reason: writeFailure(error, `Sharing ${name} into ${worktree}`).message });
    }
  }
  return { shared, skipped };
}
/** The install the runtime resolves from a worktree by its ordinary upward lookup, if any. */
async function reachableInstall(worktree: string, name: string): Promise<string | null> {
  for (let directory = dirname(worktree), parent = dirname(directory); ; directory = parent, parent = dirname(directory)) {
    const candidate = resolve(directory, name);
    if ((await lstat(candidate).catch(() => null))?.isDirectory()) return candidate;
    if (parent === directory) return null;
  }
}
/** The install a worktree's dependency directory mirrors, or null when it is the worktree's own. */
export async function sharedInstallSource(target: string): Promise<string | null> {
  const marker = await readFile(resolve(target, sharedInstallMarker), 'utf8').catch(() => null);
  return marker?.trim() || null;
}
/** An install answers for a head only when that head resolves the same lockfile, byte for byte. */
async function compatibleInstall(installed: string, worktree: string): Promise<true | string> {
  for (const name of lockfiles) {
    const [a, b] = await Promise.all([readFile(resolve(installed, name)).catch(() => null), readFile(resolve(worktree, name)).catch(() => null)]);
    if (!a || !b) return `${name} is missing from ${installed} or from this head, so no existing install can be matched to it`;
    if (createHash('sha256').update(a).digest('hex') !== createHash('sha256').update(b).digest('hex')) return `${name} differs from the install at ${installed}, so this head installs its own dependencies`;
  }
  return true;
}

/*
 * GY-1836: preparing an attempt worktree is host work beside the coordinator; the one network round
 * trip in it — a fetch of the managed base branch — is the dispatcher cycle's to make once. Every
 * preparation of one dispatch snapshot (the loop's cycle, an executor tick) shares the tip of a
 * single fetch and creates its worktree from the coordinator's object store at that tip, and the
 * time each preparation took is recorded beside the other dispatch facts, so `master status` can
 * rank the day's preparations. What branch, base or candidate a worktree holds never changes.
 */
/** The child runner a preparation runs its git through: `workerCommand`'s shape. */
export type PrepareRun = (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: ('ignore' | 'pipe' | 'inherit')[] }) => string | Buffer | Promise<string | Buffer>;
/** How many recent cycles' shared fetches are kept beyond those a queued launch still holds (holdCycleBase). */
export const retainedCycleFetches = 8;
const cycleBaseFetches = new Map<string, { cycle: string; tip: Promise<string> }>();
const cycleHolds = new Map<string, number>();
/** Drops the oldest fetches no queued launch holds until the bound is met; a held cycle's tip is never dropped. */
function trimCycleFetches() {
  let unheld = [...cycleBaseFetches.values()].filter(entry => !cycleHolds.has(entry.cycle)).length;
  for (const [key, entry] of cycleBaseFetches) {
    if (unheld <= retainedCycleFetches) return;
    if (!cycleHolds.has(entry.cycle)) { cycleBaseFetches.delete(key); unheld -= 1; }
  }
}
/**
 * Holds a dispatch cycle's fetched tip for a launch queued on it: the loop's launcher runs launches
 * after the cycle that chose them, cycles later under load, and every launch a cycle queued must
 * prepare from the tip that cycle fetched, never fetch again for a newer one. Taken when the launch
 * is queued and given back, once, by the function it returns when the launch settles; while any
 * launch holds the cycle, the bound never drops its fetch.
 */
export function holdCycleBase(cycle: string): () => void {
  cycleHolds.set(cycle, (cycleHolds.get(cycle) ?? 0) + 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const left = (cycleHolds.get(cycle) ?? 1) - 1;
    if (left > 0) cycleHolds.set(cycle, left); else cycleHolds.delete(cycle);
    trimCycleFetches();
  };
}
/**
 * The tip of `baseBranch` that one fetch of origin holds. A preparation without a cycle fetches
 * for itself, exactly as it always did (a hand dispatch is its own cycle). On a dispatcher's
 * snapshot instant, the cycle's first preparation fetches and the rest await the same promise — one
 * fetch of origin for every worktree that cycle prepares, each created from the object store at
 * that tip, however many cycles later a queued launch prepares (holdCycleBase). A fetch that failed
 * is not kept: the branch it left unheld is fetched once more, by the next preparation that needs
 * it, instead of every launch of the cycle failing on one outage.
 */
export function cycleBaseTip(root: string, baseBranch: string, cycle: string | undefined, run: PrepareRun, env?: NodeJS.ProcessEnv): Promise<string> {
  const fetch = async () => {
    await Promise.resolve(run('git', ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] }));
    const base = String(await Promise.resolve(run('git', ['rev-parse', '--verify', `refs/remotes/origin/${baseBranch}`], { cwd: root, env }))).trim();
    if (!/^[0-9a-f]{40}$/i.test(base)) throw new Error('Worker launcher could not resolve the current managed base branch');
    return base;
  };
  if (!cycle) return fetch();
  const key = `${resolve(root)}\n${baseBranch}\n${cycle}`;
  const held = cycleBaseFetches.get(key);
  if (held) return held.tip;
  const shared: Promise<string> = fetch().catch(error => { if (cycleBaseFetches.get(key)?.tip === shared) cycleBaseFetches.delete(key); throw error; });
  cycleBaseFetches.set(key, { cycle, tip: shared });
  trimCycleFetches();
  return shared;
}

// A stale attempt worktree holding the item's branch (GY-860) is released in ./branch-release.ts;
// these re-export it, so every existing import keeps working.
export { preservedDiffCaptureBytes, registeredReworkHead, releaseHeldBranch, releaseUnderFailure, reserveReleasingHold, workspaceFailure, type PreservedWorktree, type BranchGit } from './branch-release.js';
