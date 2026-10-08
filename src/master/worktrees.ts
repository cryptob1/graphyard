// Concern: disk pressure, worktree dependency reclamation, managed checkouts and shared installs.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { statfs, readdir, lstat, realpath, rm, mkdir, symlink, writeFile, readFile, rename, appendFile, unlink, rmdir, open, cp } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import type { ChildRun } from '../child-runner.js';
import type { Work } from '../model.js';
import { submittedBranchMoved } from '../model/assignment.js';
import { branchHolders, heldBranchRefusal, holderRefusals } from '../worktree-holders.js';
import { reclaimCommand, type CheckoutReclaimReport, type WorktreeRootHealth, worktreeRootConcerns, type FilesystemProbe, type SessionCheckout, type CheckoutKind, worktreeRoot, verifyWorktreeRoot, worktreeRootMinFreeBytes, allocateSessionCheckout, removeSessionCheckout, inspectWorktreeRoot, worktreeRootBudgetBytes } from '../install/worktree-root.js';
import type { MasterConfig, MasterRun } from './profiles.js';
import { assertOutsideWorktrees } from './config.js';
import { agentOwner, type AttentionItem } from './attention.js';

/*
 * Disk is a shared resource of the host, and assignment worktrees are the loop's largest consumer
 * of it: every attempt and every rework checks the repository out again, and a checkout that
 * installs its own dependencies costs about as much as the source it builds. Two halves keep that
 * bounded — one install shared by the worktrees that can use it, and a reclaimer that gives back
 * the installs of finished assignments.
 */

/**
 * The disposable artifacts inside an assignment worktree: dependency trees a package manager
 * recreates from the lockfile. Nothing else is ever removed — not a checkout, not its Git
 * metadata, never a branch, and never one of Graphyard's registered workspace records.
 */
export const dependencyDirectories = ['node_modules'] as const;
export const defaultReclaimIdleHours = 3, defaultDiskThresholdGb = 10;
export const reclaimIdleMs = (config: { run: Pick<MasterRun, 'reclaimIdleHours'> }) => (config.run.reclaimIdleHours ?? defaultReclaimIdleHours) * 3_600_000;
export const diskThresholdBytes = (config: { run: Pick<MasterRun, 'diskThresholdGb'> }) => (config.run.diskThresholdGb ?? defaultDiskThresholdGb) * 1e9;
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
export const reclaimAdvice = `the master loop reclaims the dependency directories of finished assignment worktrees on every cycle while free space is low; lower run.reclaimIdleHours in .graphyard/master.json to make more of them disposable, then retry. ${reclaimCommand} reclaims immediately, ephemeral proof and review checkouts included`;
/** The path a failed write was aimed at: the one the caller names, or the one the system call reported. */
export function exhaustedPath(error: unknown, path?: string): string | null {
  const reported = (error as { path?: unknown; dest?: unknown } | null);
  return path ?? (typeof reported?.path === 'string' ? reported.path : typeof reported?.dest === 'string' ? reported.dest : null);
}
/** Disk exhaustion as one sentence: the condition, the path that could not be written, and the reclaim command. Null for any other failure. */
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

export interface WorktreeDependency { path: string; kind: 'directory' | 'link' }
export interface WorktreeEntry {
  path: string; name: string;
  /** The newest change under the worktree, ignoring the dependency trees an install rewrites. */
  activityAt: number;
  dependencies: WorktreeDependency[];
}
/**
 * The newest change inside a worktree, ignoring the dependency trees themselves. A linked
 * worktree keeps its index and refs in the main repository, so what changes here is the working
 * tree itself: the session's own edits, checkouts and build output, which is exactly the activity
 * the idle bound is about.
 */
export async function worktreeActivity(path: string, now = Date.now()) {
  const names = await readdir(path).catch(() => [] as string[]);
  const targets = [path, ...names.filter(name => !(dependencyDirectories as readonly string[]).includes(name)).map(name => resolve(path, name))];
  const times = await Promise.all(targets.map(target => lstat(target).then(info => info.mtimeMs).catch(() => 0)));
  // A timestamp ahead of the clock must not make a worktree look idle for ever.
  return Math.min(Math.max(0, ...times), now);
}
/** Every assignment worktree on this host and the dependency trees it is holding. */
export async function inventoryWorktrees(root: string, now = Date.now()): Promise<WorktreeEntry[]> {
  const base = worktreesDirectory(root);
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  const worktrees = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
    const path = resolve(base, entry.name);
    const dependencies: WorktreeDependency[] = [];
    for (const name of dependencyDirectories) {
      const info = await lstat(resolve(path, name)).catch(() => null);
      if (info?.isSymbolicLink()) dependencies.push({ path: resolve(path, name), kind: 'link' });
      else if (info?.isDirectory()) dependencies.push({ path: resolve(path, name), kind: 'directory' });
    }
    return { path, name: entry.name, activityAt: await worktreeActivity(path, now), dependencies };
  }));
  return worktrees.sort((a, b) => a.name.localeCompare(b.name));
}

export type ReclaimDisposition = 'live' | 'recent' | 'idle' | 'superseded' | 'delivered';
export interface WorktreeReclaimCandidate {
  path: string; name: string; key: string | null; epoch: number | null; branch: string | null;
  disposition: ReclaimDisposition; disposable: boolean; idleMs: number; detail: string;
  dependencies: WorktreeDependency[];
}
/**
 * Which assignment worktrees hold disposable dependency trees. A worktree whose assignment is
 * finished — delivered, superseded by a later epoch, or untouched beyond the configured age —
 * can install again from its lockfile whenever it is needed; one whose attempt still holds the
 * lease is never touched. The decision is a pure function of the Graphyard snapshot and the
 * filesystem inventory, so the loop and `master status` always answer alike.
 */
export function planWorktreeReclaim(entries: WorktreeEntry[], work: Work[], options: { now: number; idleMs: number }): WorktreeReclaimCandidate[] {
  const minutes = (ms: number) => Math.floor(ms / 60_000);
  return entries.map(entry => {
    const owner = work.find(item => item.workspaces.some(space => resolve(space.path) === entry.path));
    const workspace = owner?.workspaces.find(space => resolve(space.path) === entry.path) ?? null;
    const idleMs = Math.max(0, options.now - entry.activityAt);
    const live = !!owner?.lease && owner.lease.epoch === workspace?.epoch && Date.parse(owner.lease.expiresAt) > options.now;
    const [disposition, detail]: [ReclaimDisposition, string] =
      live ? ['live', `${owner!.key} epoch ${workspace!.epoch} holds the lease until ${owner!.lease!.expiresAt}`]
      : owner && owner.stage === 'done' ? ['delivered', `${owner.key} is delivered; the attempt that used this worktree is finished`]
      : owner && workspace && workspace.epoch < owner.epoch ? ['superseded', `${owner.key} epoch ${workspace.epoch} was superseded by epoch ${owner.epoch}`]
      : idleMs >= options.idleMs ? ['idle', `Untouched for ${minutes(idleMs)} minutes, past the ${minutes(options.idleMs)}-minute idle bound`]
      : ['recent', `${owner ? `${owner.key} ` : 'An unregistered worktree '}changed ${minutes(idleMs)} minutes ago, inside the ${minutes(options.idleMs)}-minute idle bound`];
    return { path: entry.path, name: entry.name, key: owner?.key ?? null, epoch: workspace?.epoch ?? null, branch: workspace?.branch ?? null,
      disposition, disposable: disposition !== 'live' && disposition !== 'recent' && entry.dependencies.length > 0,
      idleMs, detail, dependencies: entry.dependencies };
  });
}
/** The only path the reclaimer may remove: a dependency tree one level inside an assignment worktree. */
function assertDisposable(base: string, target: string) {
  const worktree = dirname(target);
  if (!(dependencyDirectories as readonly string[]).includes(basename(target)) || dirname(worktree) !== base || worktree === base)
    throw new Error(`Refusing to remove ${target}: the reclaimer removes only ${dependencyDirectories.join(', ')} directly inside an assignment worktree`);
}

export interface WorktreeReclaimReport {
  root: string; at: string; applied: boolean; scanned: number; idleMs: number;
  removed: string[]; kept: { path: string; disposition: ReclaimDisposition; detail: string }[];
  freeBefore: number | null; freeAfter: number | null; freedBytes: number; errors: string[];
  /** What the same pass took back under the managed worktree root, when the loop ran it. */
  checkouts?: CheckoutReclaimReport;
  /** The assignment worktrees the same pass removed outright (GY-360), when the loop ran it. */
  trees?: WorktreeRemovalReport;
}
/**
 * Give the host back the dependency trees of finished assignments. The reclaimer removes nothing
 * else: a checkout keeps its files and its Git metadata, a branch keeps every commit it holds —
 * pushed or not — and Graphyard's registered workspace records are never written, so the disk is
 * freed without any assignment losing history the control plane still refers to.
 */
export async function reclaimWorktrees(root: string, work: Work[], options: { idleMs: number; now?: number; apply?: boolean; entries?: WorktreeEntry[] }): Promise<WorktreeReclaimReport> {
  const now = options.now ?? Date.now(), apply = options.apply !== false, base = worktreesDirectory(root);
  const plan = planWorktreeReclaim(options.entries ?? await inventoryWorktrees(root, now), work, { now, idleMs: options.idleMs });
  const freeBefore = await freeBytes(base);
  const removed: string[] = [], errors: string[] = [];
  for (const candidate of plan.filter(entry => entry.disposable)) {
    for (const dependency of candidate.dependencies) {
      try { assertDisposable(base, dependency.path); } catch (error) { errors.push(failureText(error)); continue; }
      if (!apply) { removed.push(dependency.path); continue; }
      try { await rm(dependency.path, { recursive: true, force: true }); removed.push(dependency.path); }
      catch (error) { errors.push(`${dependency.path}: ${writeFailure(error, 'Reclaiming a dependency directory').message}`); }
    }
  }
  const freeAfter = apply ? await freeBytes(base) : freeBefore;
  return { root, at: new Date(now).toISOString(), applied: apply, scanned: plan.length, idleMs: options.idleMs, removed,
    kept: plan.filter(entry => !entry.disposable).map(entry => ({ path: entry.path, disposition: entry.disposition, detail: entry.detail })),
    freeBefore, freeAfter, freedBytes: freeBefore === null || freeAfter === null ? 0 : Math.max(0, freeAfter - freeBefore), errors };
}

/*
 * GY-360: removing the finished worktrees themselves. Taking back a worktree's dependency trees
 * frees disk, but the checkout stays registered with Git, and every Git operation in the
 * repository, like every `master status`, then pays for each one ever created. A worktree whose
 * item is delivered or closed, or whose attempt, review or producer session ended at least the
 * idle bound ago, is removed with `git worktree remove` — never forced — and the registry pruned.
 * The branch it had checked out is a ref of the repository and survives the removal.
 */
export const defaultWorktreeRemovalLimit = 50;
export const worktreeInventoryFile = (root: string) => resolve(root, '.graphyard/worktree-inventory.json');
export const worktreeReclaimAuditFile = (root: string) => resolve(root, '.graphyard/worktree-reclaim.jsonl');
/**
 * A tree the removal pass found dirty or holding unpushed commits, kept until its working tree
 * changes again or the refs that could hold its commits move: `refs` fingerprints the remote copies
 * of its branch, the base branch and the item's candidate head as that pass saw them, so a push re-examines it.
 */
export interface HeldWorktree { path: string; activityAt: number; reason: string; refs?: string;
  /** When a tree Git refused is examined again (GY-1515); a dirty or unpushed hold stands until the tree or its refs change. */
  retryAt?: string }
/**
 * How long a tree Git refused to judge or remove is held before the pass tries it again (GY-1515).
 * On 8 October 2026 one refused `rev-list` was re-run and re-reported as a failed reclaim on every
 * pass of a backlog that ran every cycle: the refusal is now one failure, held like a dirty tree.
 */
export const worktreeRefusalRetryMs = 24 * 60 * 60_000;
/** The inventory the reclaim step last took, so `master status` never walks every tree itself. */
export interface WorktreeInventoryCache { at: string; entries: WorktreeEntry[]; held: HeldWorktree[] }
export interface WorktreeRemoval { path: string; key: string | null; reason: string; head: string | null }
export interface WorktreeRemovalReport {
  at: string; limit: number; removed: WorktreeRemoval[];
  /** Reclaimable trees that were kept: dirty, holding unpushed commits, or refused by Git. */
  kept: { path: string; key: string | null; reason: string }[];
  /** Reclaimable trees this pass left for a later one because of the per-cycle bound. */
  backlog: number;
  /** The kept trees not to examine again until their working tree or the refs they were judged against change. */
  held: HeldWorktree[];
  errors: string[];
  /** The inventory after the pass, the one written to the cache. */
  entries: WorktreeEntry[];
}

export async function readWorktreeInventoryCache(root: string): Promise<WorktreeInventoryCache | null> {
  try {
    const parsed = JSON.parse(await readFile(worktreeInventoryFile(root), 'utf8')) as Partial<WorktreeInventoryCache>;
    return typeof parsed.at === 'string' && Array.isArray(parsed.entries) ? { at: parsed.at, entries: parsed.entries, held: Array.isArray(parsed.held) ? parsed.held : [] } : null;
  } catch { return null; }
}
export async function writeWorktreeInventoryCache(root: string, cache: WorktreeInventoryCache) {
  const file = worktreeInventoryFile(root), temporary = `${file}.${process.pid}.tmp`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(temporary, JSON.stringify(cache));
  await rename(temporary, file);
}
/**
 * The worktree inventory as `master status` reads it: the cache the loop's reclaim step keeps,
 * one file read, whatever the number of trees. Only a host whose loop has never reclaimed walks
 * the directory, once, and leaves the cache behind for the next call. No Git command runs here.
 */
export async function statusWorktreeInventory(root: string, now = Date.now()): Promise<{ entries: WorktreeEntry[]; at: string; cached: boolean }> {
  const cache = await readWorktreeInventoryCache(root);
  if (cache) return { entries: cache.entries, at: cache.at, cached: true };
  const entries = await inventoryWorktrees(root, now), at = new Date(now).toISOString();
  await writeWorktreeInventoryCache(root, { at, entries, held: [] }).catch(() => {});
  return { entries, at, cached: false };
}

/** The attempt epoch a session handle works under: its own, or the one its `principal:epoch` id names. */
function sessionEpoch(handle: { id: string; epoch: number | null }) {
  if (handle.epoch !== null) return handle.epoch;
  const match = /:(\d+)$/.exec(handle.id);
  return match ? Number(match[1]) : null;
}
/**
 * Why a tree may be removed, or null when it may not. A delivered or closed item's tree goes; any
 * other tree only once its attempt, review or producer session ended at least the idle bound ago
 * (an attempt a later epoch superseded has ended too) and the tree has been untouched as long. A
 * live lease or a live session on the tree keeps it, whatever else holds; so does an item parked
 * for a human on this attempt, and a tree no item registers, since no session of it ever ended.
 */
export function worktreeRemovalReason(candidate: WorktreeReclaimCandidate, work: Work[], livePaths: ReadonlySet<string>, idleMs: number, now = Date.now()): string | null {
  if (candidate.disposition === 'live' || livePaths.has(candidate.path)) return null;
  const owner = candidate.key ? work.find(item => item.key === candidate.key) : undefined;
  if (!owner) return null;
  const sessions = (owner.sessions ?? []).filter(handle => (sessionEpoch(handle) ?? candidate.epoch) === candidate.epoch);
  if (sessions.some(handle => handle.state === 'running')) return null;
  if (owner.stage === 'done') return owner.closure ? `${owner.key} is closed` : `${owner.key} is delivered`;
  if (candidate.idleMs < idleMs) return null;
  const minutes = (ms: number) => Math.floor(ms / 60_000);
  if (candidate.disposition === 'superseded') return `${candidate.detail}, and the tree has been untouched for ${minutes(candidate.idleMs)} minutes`;
  if (owner.humanRequest && candidate.epoch === owner.epoch) return null;
  const ended = Math.max(-Infinity, ...sessions.map(handle => Date.parse(handle.endedAt ?? handle.updatedAt)).filter(Number.isFinite));
  if (!Number.isFinite(ended) || now - ended < idleMs) return null;
  return `${owner.key} epoch ${candidate.epoch}'s last session ended ${minutes(now - ended)} minutes ago, past the ${minutes(idleMs)}-minute idle bound; ${candidate.detail}`;
}
/** The worktree paths Git has registered for this repository, as `git worktree list --porcelain` names them. */
async function registeredWorktrees(root: string, run: ChildRun): Promise<Set<string>> {
  const listing = String(await Promise.resolve(run('git', ['-C', root, 'worktree', 'list', '--porcelain'])));
  const paths = listing.split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length));
  return new Set((await Promise.all(paths.map(path => realpath(path).catch(() => resolve(path))))));
}

/**
 * The ref lines a tree's hold depends on: the remote copies of its own branch and the base branch,
 * local or remote. A fetch that moves an unrelated remote branch then leaves the hold standing
 * instead of re-running git status and log on every held tree. A commit pushed only under another
 * branch name is not seen until the tree itself changes, which errs toward keeping the tree. A
 * tree with no recorded branch depends on every ref.
 */
export function relevantRefs(listing: string, branch: string | null, baseBranch?: string): string {
  if (!branch) return listing;
  const names = [branch, ...(baseBranch ? [baseBranch] : [])];
  return listing.split('\n').filter(line => {
    const ref = line.slice(line.indexOf(' ') + 1);
    return (baseBranch && ref === `refs/heads/${baseBranch}`) || (ref.startsWith('refs/remotes/') && names.some(name => ref.endsWith(`/${name}`) && ref.split('/').length === 3 + name.split('/').length));
  }).join('\n');
}
/** What an unregistered directory holds beyond dependency trees and a `.git` pointer file: the work a removal would lose. */
async function orphanContents(path: string): Promise<string[]> {
  const holding: string[] = [];
  for (const name of await readdir(path)) {
    if ((dependencyDirectories as readonly string[]).includes(name)) continue;
    if (name === '.git' && (await lstat(resolve(path, name))).isFile()) continue;
    holding.push(name);
  }
  return holding;
}
/** Remove an orphaned directory that holds nothing but dependency trees and a `.git` pointer; `rmdir` refuses anything left. */
async function removeOrphan(root: string, path: string) {
  const base = worktreesDirectory(root);
  if (dirname(path) !== base) throw new Error(`Refusing to remove ${path}: it is not directly inside ${base}`);
  for (const name of dependencyDirectories) {
    const target = resolve(path, name), info = await lstat(target).catch(() => null);
    if (!info) continue;
    assertDisposable(base, target);
    if (info.isSymbolicLink()) await unlink(target); else await rm(target, { recursive: true, force: true });
  }
  if ((await lstat(resolve(path, '.git')).catch(() => null))?.isFile()) await unlink(resolve(path, '.git'));
  await rmdir(path);
}

/**
 * Remove up to `limit` reclaimable worktrees, oldest first. Each is checked before it goes: a tree
 * with uncommitted changes, or whose HEAD holds commits no remote ref and no base branch has, is
 * reported and kept, and not looked at again until its working tree changes; one Git refuses is
 * reported once and kept until worktreeRefusalRetryMs passes. Git itself refuses a
 * dirty tree without --force, which is never passed. Every removal is appended to the audit log
 * with its path, item, reason and head; `git worktree prune` then drops what the registry still
 * lists for directories that are gone. A delivered or closed item's directory that Git no longer
 * registers is an orphan: it goes when it holds nothing but dependency trees and a `.git` pointer,
 * and is reported with what it holds otherwise.
 */
export async function removeReclaimableWorktrees(root: string, work: Work[], options: { idleMs: number; run: ChildRun; baseBranch?: string; now?: number; limit?: number; livePaths?: Iterable<string>; entries?: WorktreeEntry[] }): Promise<WorktreeRemovalReport> {
  const now = options.now ?? Date.now(), limit = options.limit ?? defaultWorktreeRemovalLimit, at = new Date(now).toISOString();
  const livePaths = new Set([...(options.livePaths ?? [])].map(path => resolve(path)));
  const entries = options.entries ?? await inventoryWorktrees(root, now);
  const previous = (await readWorktreeInventoryCache(root))?.held ?? [];
  const plan = planWorktreeReclaim(entries, work, { now, idleMs: options.idleMs });
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  const reclaimable = plan.map(candidate => ({ candidate, reason: worktreeRemovalReason(candidate, work, livePaths, options.idleMs, now) }))
    .filter((entry): entry is { candidate: WorktreeReclaimCandidate; reason: string } => entry.reason !== null)
    .sort((a, b) => b.candidate.idleMs - a.candidate.idleMs);
  const removed: WorktreeRemoval[] = [], kept: WorktreeRemovalReport['kept'] = [], errors: string[] = [], held: HeldWorktree[] = [];
  const gone = new Set<string>();
  const git = (path: string, args: string[]) => Promise.resolve(options.run('git', ['-C', path, ...args]));
  // Once per pass: which trees Git registers, so `git -C` is never run on a directory it would
  // resolve to an enclosing repository, and where every ref that could hold a tree's commits points.
  let registered: Set<string> | null = null, remoteRefs = '';
  if (reclaimable.length) {
    try {
      registered = await registeredWorktrees(root, options.run);
      remoteRefs = String(await git(root, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/remotes', ...(options.baseBranch ? [`refs/heads/${options.baseBranch}`] : [])]));
    } catch (error) { errors.push(`Listing registered worktrees and remote refs: ${failureText(error).slice(0, 400)}`); }
  }
  const fingerprint = (candidate: WorktreeReclaimCandidate) => createHash('sha256').update(relevantRefs(remoteRefs, candidate.branch, options.baseBranch))
    .update(`\n${(candidate.key && work.find(item => item.key === candidate.key)?.candidate?.sha) ?? ''}`).digest('hex');
  let examined = 0, backlog = 0;
  for (const { candidate, reason } of reclaimable) {
    const activityAt = byPath.get(candidate.path)!.activityAt, refs = fingerprint(candidate);
    const before = previous.find(entry => entry.path === candidate.path && entry.activityAt === activityAt && entry.refs === refs && !(entry.retryAt && Date.parse(entry.retryAt) <= now));
    if (before) { held.push(before); kept.push({ path: candidate.path, key: candidate.key, reason: before.reason }); continue; }
    if (!registered) { kept.push({ path: candidate.path, key: candidate.key, reason: 'Git refused: the registered worktrees could not be listed' }); continue; }
    const unregistered = !registered.has(await realpath(candidate.path).catch(() => candidate.path));
    const finished = unregistered && work.find(item => item.key === candidate.key)?.stage === 'done';
    if (unregistered && !finished) {
      kept.push({ path: candidate.path, key: candidate.key, reason: 'Not a registered Git worktree: its clean state cannot be judged apart from an enclosing repository' });
      continue;
    }
    if (examined >= limit) { backlog += 1; continue; }
    examined += 1;
    if (finished) {
      // A delivered or closed item's directory Git no longer registers: removed only when nothing
      // in it is work — dependency trees and a stale `.git` pointer — and kept, with what it holds, otherwise.
      try {
        const holding = await orphanContents(candidate.path);
        if (holding.length) {
          kept.push({ path: candidate.path, key: candidate.key, reason: `Not a registered Git worktree, and it holds ${holding.length} path(s) that are not dependency trees (${holding.slice(0, 3).join(', ')}); left for an operator to inspect, since Git cannot judge them` });
          continue;
        }
        await removeOrphan(root, candidate.path);
        const removal = { path: candidate.path, key: candidate.key, reason: `${reason}; the directory was no longer a registered Git worktree and held nothing but dependency trees`, head: null };
        removed.push(removal); gone.add(candidate.path);
        await appendFile(worktreeReclaimAuditFile(root), `${JSON.stringify({ at, action: 'orphan-remove', ...removal })}\n`)
          .catch(error => errors.push(`${candidate.path}: removed, but the audit entry could not be written: ${failureText(error)}`));
      } catch (error) {
        kept.push({ path: candidate.path, key: candidate.key, reason: `Orphan removal refused: ${failureText(error).slice(0, 300)}` });
        errors.push(`${candidate.path}: ${writeFailure(error, 'Removing an orphaned worktree directory').message.slice(0, 400)}`);
      }
      continue;
    }
    const keep = (why: string) => { held.push({ path: candidate.path, activityAt, reason: why, refs }); kept.push({ path: candidate.path, key: candidate.key, reason: why }); };
    try {
      // A shared install linked into the tree is untracked to Git (an ignore rule `node_modules/`
      // matches directories only) but is no work of the attempt's: it is unlinked before removal.
      const dirty = String(await git(candidate.path, ['status', '--porcelain', '--untracked-files=normal'])).split('\n')
        .filter(line => line.trim() && !(line.startsWith('?? ') && (dependencyDirectories as readonly string[]).includes(line.slice(3).replace(/\/$/, ''))));
      if (dirty.length) { keep(`Uncommitted changes: ${dirty.length} path(s) differ from HEAD`); continue; }
      const head = String(await git(candidate.path, ['rev-parse', 'HEAD'])).trim() || null;
      const pushed = head !== null && [candidate.key && work.find(item => item.key === candidate.key)?.candidate?.sha].includes(head);
      if (!pushed) {
        const unpushed = String(await git(candidate.path, ['rev-list', '-n', '1', 'HEAD', '--not', '--remotes', ...(options.baseBranch ? [`refs/heads/${options.baseBranch}`] : [])])).trim();
        if (unpushed) { keep(`Unpushed commits: ${unpushed} is on no remote ref${options.baseBranch ? ` and not on ${options.baseBranch}` : ''}`); continue; }
      }
      for (const dependency of byPath.get(candidate.path)!.dependencies.filter(entry => entry.kind === 'link')) {
        assertDisposable(worktreesDirectory(root), dependency.path);
        await unlink(dependency.path);
      }
      await Promise.resolve(options.run('git', ['-C', root, 'worktree', 'remove', candidate.path]));
      const removal = { path: candidate.path, key: candidate.key, reason, head };
      removed.push(removal); gone.add(candidate.path);
      await appendFile(worktreeReclaimAuditFile(root), `${JSON.stringify({ at, action: 'worktree-remove', ...removal })}\n`)
        .catch(error => errors.push(`${candidate.path}: removed, but the audit entry could not be written: ${failureText(error)}`));
    } catch (error) {
      // Reported once, as this pass's failure, then held: Git will refuse the same way on the next
      // pass, and a backlog runs one every cycle. Tried again after the bound, in case the refusal cleared.
      const retryAt = new Date(now + worktreeRefusalRetryMs).toISOString();
      held.push({ path: candidate.path, activityAt, reason: `Git refused: ${failureText(error).slice(0, 300)}; tried again after ${retryAt}`, refs, retryAt });
      kept.push({ path: candidate.path, key: candidate.key, reason: `Git refused: ${failureText(error).slice(0, 300)}` });
      errors.push(`${candidate.path}: ${writeFailure(error, 'Removing a finished worktree').message.slice(0, 400)}`);
    }
  }
  if (removed.length) {
    try { await Promise.resolve(options.run('git', ['-C', root, 'worktree', 'prune'])); }
    catch (error) { errors.push(`git worktree prune: ${failureText(error).slice(0, 400)}`); }
  }
  const remaining = entries.filter(entry => !gone.has(entry.path));
  return { at, limit, removed, kept, backlog, held, errors, entries: remaining };
}

export interface DiskPressure { path: string; freeBytes: number | null; thresholdBytes: number; low: boolean; reclaimable: number; worktrees: number; unavailable: string | null }
/** Free space beside what a reclaim would give back, in the shape `master status` reports it. */
export function diskPressure(path: string, free: number | null, thresholdBytes: number, plan: WorktreeReclaimCandidate[]): DiskPressure {
  return { path, freeBytes: free, thresholdBytes, low: free !== null && free < thresholdBytes,
    reclaimable: plan.filter(entry => entry.disposable).length, worktrees: plan.length,
    unavailable: free === null ? `Free space on ${path} could not be read` : null };
}
const gigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
/**
 * The attention item that has to arrive before the volume fills: how much room is left, how much
 * of it finished worktrees are holding, and the one command that gives it back. It is raised on
 * the configured threshold rather than on the first failed write, so the master acts while
 * writes still succeed.
 */
export function diskPressureAttention(pressure: DiskPressure): AttentionItem[] {
  if (!pressure.low || pressure.freeBytes === null) return [];
  return [{ subject: 'disk', text: `${gigabytes(pressure.freeBytes)} free on ${pressure.path}, below the configured ${gigabytes(pressure.thresholdBytes)} threshold; ${pressure.reclaimable} of ${pressure.worktrees} assignment worktree(s) hold dependency directories a fresh install recreates. Reclaim them before the volume fills`,
    ...agentOwner('master', 'graphyard master run reclaims every cycle while free space is low (daemon.reclaim in master status says what it took back); lower run.reclaimIdleHours in .graphyard/master.json to make more of them disposable, and graphyard master run --once reclaims immediately when no loop is running') }];
}

/**
 * The managed worktree root's attention items: a root on a tmpfs, a volume below its configured
 * minimum, or a root that has grown to most of its budget. Each names the reclaim command, and
 * each is raised while writes still succeed.
 */
export function worktreeRootAttention(health: WorktreeRootHealth): AttentionItem[] {
  return worktreeRootConcerns(health).map(text => ({ subject: 'disk', text,
    ...agentOwner('master', health.volatile && !health.low && !health.overBudget
      ? 'Set run.worktreeRoot in .graphyard/master.json to an absolute path on durable storage, outside every worktree; master run adopts it on its next cycle'
      : `${reclaimCommand} removes every ephemeral checkout no live session owns (graphyard master run does the same on every cycle while space is low); raise run.worktreeRootBudgetGb or move run.worktreeRoot in .graphyard/master.json if the live sessions alone need more room`) }));
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

// ---- Stale attempt worktrees hold the item's branch (GY-860) -------------------------------------

/** What an earlier attempt's worktree held when an allocation released its branch: where it was, what it pointed at, the operation it was mid-way through, and the uncommitted diff it carried. */
export interface PreservedWorktree { path: string; head: string; branchTip: string; op: 'rebase' | 'merge' | 'cherry-pick' | null; refs: string; diff: string; at: string }

/** The git a branch release runs: the asynchronous runner, so a launcher on this loop never blocks on a child. */
export type BranchGit = (cwd: string, ...args: string[]) => Promise<string>;

/** An operation a holder can be stopped inside; the ledger's record names the first three, and the diff's first line names the rest. */
type HolderOperation = NonNullable<PreservedWorktree['op']> | 'revert' | 'merge --squash';

/** The in-progress operation a worktree is stopped inside, or null; each state lives in that worktree's own git dir. */
async function inProgressOperation(git: BranchGit, path: string): Promise<HolderOperation | null> {
  const gitPath = async (name: string) => resolve(path, (await git(path, 'rev-parse', '--git-path', name)).trim());
  if (existsSync(await gitPath('rebase-merge')) || existsSync(await gitPath('rebase-apply'))) return 'rebase';
  if (existsSync(await gitPath('MERGE_HEAD'))) return 'merge';
  if (existsSync(await gitPath('CHERRY_PICK_HEAD'))) return 'cherry-pick';
  if (existsSync(await gitPath('REVERT_HEAD'))) return 'revert';
  // `merge --squash` writes no MERGE_HEAD; its message file is what marks it.
  if (existsSync(await gitPath('SQUASH_MSG'))) return 'merge --squash';
  return null;
}

/** The branch a stopped rebase is rewriting, read from its own state, or empty. */
async function rebaseHeadName(git: BranchGit, path: string): Promise<string> {
  for (const state of ['rebase-merge', 'rebase-apply']) {
    const directory = resolve(path, (await git(path, 'rev-parse', '--git-path', state)).trim());
    if (!existsSync(directory)) continue;
    try { return (await readFile(resolve(directory, 'head-name'), 'utf8')).trim(); } catch { return ''; }
  }
  return '';
}

/** The most `git diff` output a release buffers (GY-1059): far above the ledger's limit, far below the runner's. */
export const preservedDiffCaptureBytes = 1024 * 1024;

/**
 * The holder's uncommitted tracked changes, bounded before they are buffered: a diff larger than
 * the capture limit (or one git cannot produce) is recorded as its stat instead, saying so.
 */
async function trackedDiff(run: ChildRun, path: string): Promise<string> {
  try { return String(await run('git', ['-C', path, 'diff', 'HEAD'], { maxBuffer: preservedDiffCaptureBytes })); }
  catch (error) {
    let stat = '';
    try { stat = String(await run('git', ['-C', path, 'diff', 'HEAD', '--stat=200'], { maxBuffer: preservedDiffCaptureBytes })); } catch {}
    return `-- the full diff could not be captured (${failureText(error).split('\n')[0]}); its stat follows --\n${stat}`;
  }
}

/**
 * Each untracked file by path and content, within `budget` characters: the record alone can then
 * restore it, not only name it. A binary file, a symlink or anything past the budget is named only
 * and returned in `unrecorded` (GY-1215), for whoever cleans the worktree to keep.
 */
async function untrackedContents(git: BranchGit, path: string, budget: number): Promise<{ text: string; unrecorded: string[] }> {
  const paths = (await git(path, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean);
  const sections: string[] = [], unrecorded: string[] = [];
  let used = 0;
  for (const name of paths) {
    const file = resolve(path, name), info = await lstat(file).catch(() => null);
    let section = `-- untracked file ${name} --`, whole = false;
    if (info?.isSymbolicLink()) section = `-- untracked symlink ${name} --`;
    else if (info?.isFile() && used + section.length < budget) {
      const handle = await open(file, 'r');
      try {
        const room = Math.min(info.size, budget - used - section.length - 1);
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(room), 0, room, 0);
        const bytes = buffer.subarray(0, bytesRead), text = bytes.toString('utf8');
        if (bytes.includes(0)) section = `-- untracked binary file ${name} (${info.size} bytes) --`;
        else {
          section += `\n${text}${bytesRead < info.size ? `\n… ${info.size - bytesRead} more bytes not recorded` : ''}`;
          // Bytes that are not UTF-8 do not survive the record either.
          whole = bytesRead === info.size && Buffer.from(text, 'utf8').equals(bytes);
        }
      } finally { await handle.close(); }
    }
    if (!whole) unrecorded.push(name);
    sections.push(section); used += section.length + 1;
  }
  return { text: sections.join('\n'), unrecorded };
}

/** Move the untracked files a record names but does not hold into `aside`, keeping their relative paths (GY-1215); a file that cannot be kept rejects, so the clean that would delete it never runs. */
async function moveAside(path: string, names: string[], aside: string) {
  for (const name of names) {
    const from = resolve(path, name), to = resolve(aside, name);
    if (!await lstat(from).catch(() => null)) continue;
    await mkdir(dirname(to), { recursive: true });
    try { await rename(from, to); }
    catch { await cp(from, to, { recursive: true, verbatimSymlinks: true }); }
  }
}

/** Where a reused path's unrecorded untracked files go (GY-1274): `<common git dir>/graphyard-preserved/<worktree>/<time>`, which outlives the worktree's own git dir; an unresolvable git dir rejects before anything changes. */
async function keptDirectory(run: ChildRun, holderPath: string, at: string): Promise<string> {
  const common = String(await run('git', ['-C', holderPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  if (!common) throw new Error(`Cannot keep the untracked files of ${holderPath}: git named no common git dir for it`);
  return resolve(common, 'graphyard-preserved', basename(holderPath), at.replace(/[:.]/g, '-'));
}

/**
 * Free the item's branch for a new attempt's worktree (GY-860 AC-1). When a session worktree
 * directly under `.graphyard/worktrees` holds it — checked out, or stopped inside a rebase naming
 * it, a merge, a squash merge, a cherry-pick or a revert — its state is captured, the operation
 * ended and its HEAD detached, so `git worktree add` succeeds. Any other checkout is never touched
 * (GY-1059), nor a stopped `git am` (left to the GY-1078 reclaim); the branch ref never moves. A
 * locked record whose directory is gone is unlocked and pruned. The new attempt's own path keeps
 * its worktree, forced back onto the branch and returned with `reused`; its clean deletes only
 * what the record holds in full, moving merely named untracked files aside (GY-1215).
 * `register` receives the captured state (or null) before anything changes, so a refused
 * registration leaves the holder as it was. Probes answer empty on a refusal; a step that changes
 * the holder and fails rejects.
 */
export async function releaseHeldBranch(root: string, branch: string, targetPath: string, run: ChildRun,
  register: (preserved: PreservedWorktree | null) => Promise<unknown> = async () => {}): Promise<{ preserved: PreservedWorktree; reused: boolean } | null> {
  const ref = `refs/heads/${branch}`, sessions = worktreesDirectory(root);
  // Quiet git answers empty on a refusal; the caller decides what a refusal means.
  const quiet = async (...args: string[]) => { try { return await run('git', args); } catch { return ''; } };
  const git: BranchGit = async (cwd, ...args) => quiet('-C', cwd, ...args);
  // Registrations whose directory is gone hold nothing but still refuse a new checkout.
  await quiet('-C', root, 'worktree', 'prune');
  const raw = await git(root, 'worktree', 'list', '--porcelain', '-z');
  if (!raw.trim()) { await register(null); return null; }
  const branchTip = (await git(root, 'rev-parse', '--verify', ref)).trim();
  for (const record of raw.split('\0\0')) {
    const fields = record.split('\0');
    const holderPath = fields.find(field => field.startsWith('worktree '))?.slice('worktree '.length);
    if (!holderPath || resolve(dirname(holderPath)) !== sessions) continue;
    if (!existsSync(holderPath)) {
      // A locked record survives `worktree prune` and still holds the branch it names.
      if (fields.some(field => field === 'locked' || field.startsWith('locked ')) && fields.includes(`branch ${ref}`)) {
        await run('git', ['-C', root, 'worktree', 'unlock', holderPath]);
        await run('git', ['-C', root, 'worktree', 'prune']);
      }
      continue;
    }
    // A stopped `git am` keeps its state in `rebase-apply` too, but `rebase --abort` refuses it:
    // that holder is left to the GY-1078 reclaim the worktree command runs next, which aborts it.
    if (existsSync(resolve(holderPath, (await git(holderPath, 'rev-parse', '--git-path', 'rebase-apply/applying')).trim()))) continue;
    // A rebase detaches the holder's HEAD, so the branch shows neither in the porcelain record
    // nor as HEAD: the rebase's own head-name is what still holds it.
    const op = await inProgressOperation(git, holderPath);
    const headName = op === 'rebase' ? await rebaseHeadName(git, holderPath) : '';
    if (!fields.includes(`branch ${ref}`) && headName !== ref) continue;
    const diffLimit = 100_000, truncated = `\n… truncated to ${diffLimit} characters`;
    const recorded = op === 'rebase' || op === 'merge' || op === 'cherry-pick' ? op : null;
    const tracked = `${op && !recorded ? `-- stopped inside git ${op} --\n` : ''}${await trackedDiff(run, holderPath)}`;
    const reused = resolve(holderPath) === resolve(targetPath), at = new Date().toISOString();
    const aside = reused ? await keptDirectory(run, holderPath, at) : '';
    const keptNote = `\n-- untracked files not recorded in full are kept under ${aside} --`;
    const heading = `${tracked ? '\n' : ''}-- untracked files --\n`;
    // The heading, note and truncation suffix count toward the limit, so a cut never ends a file recorded in full (GY-1274).
    const untracked = await untrackedContents(git, holderPath, diffLimit - tracked.length - heading.length - truncated.length - (reused ? keptNote.length : 0));
    const note = reused && untracked.unrecorded.length ? keptNote : '', room = diffLimit - note.length;
    const fullDiff = tracked + (untracked.text && tracked.length < diffLimit ? `${heading}${untracked.text}` : '');
    const head = (await git(holderPath, 'rev-parse', 'HEAD')).trim(), refs = (await git(holderPath, 'show-ref')).trim().slice(0, 20_000);
    // The suffix and the note count toward the limit, so a truncated diff still fits the ledger's schema.
    const diff = `${fullDiff.length > room ? `${fullDiff.slice(0, room - truncated.length)}${truncated}` : fullDiff}${note}`;
    const preserved: PreservedWorktree = { path: holderPath, head, branchTip, op: recorded, refs, diff, at };
    await register(preserved);
    const letGo = async (args: string[]) => { await run('git', ['-C', holderPath, ...args]); };
    if (op === 'rebase') await letGo(['rebase', '--abort']);
    if (op === 'merge') await letGo(['merge', '--abort']);
    // `--abort` returns a stopped sequence to where it began, which would move the branch back
    // past the commits already made; quitting and resetting the conflicted index ends it where
    // the branch stands. A squash merge has no sequence: its conflicted index is reset.
    if (op === 'cherry-pick' || op === 'revert') await letGo([op, '--quit']);
    if (op && op !== 'rebase' && op !== 'merge') await letGo(['reset', '--merge']);
    if (op === 'merge --squash') await unlink(resolve(holderPath, (await git(holderPath, 'rev-parse', '--git-path', 'SQUASH_MSG')).trim())).catch(() => {});
    if (reused) {
      // The same epoch's own path: what a failed preparation left there is in the record or moved aside, and the session starts clean.
      await moveAside(holderPath, untracked.unrecorded, aside);
      await letGo(['checkout', '--quiet', '--force', branch]);
      await letGo(['clean', '-fd', '--quiet']);
    } else await letGo(['checkout', '--detach', '--quiet']);
    return { preserved, reused };
  }
  await register(null);
  return null;
}

/**
 * Release this attempt's claim as a workspace failure (GY-860 AC-2): the control plane keeps the
 * git message on the item and, while the attempt is still the untouched claim, undoes it, so the
 * epoch returns and no attempt is consumed. A release the server refuses — a lease that lapsed or
 * was superseded while git ran included — returned nothing, so it is never reported as one
 * (GY-1059): the error keeps the original git failure, which names the workspace rather than the
 * profile, and says the epoch is spent.
 */
export async function releaseUnderFailure(mutate: (name: string, data: unknown) => Promise<unknown>, epoch: number, message: string) {
  try { await mutate('release', { epoch, failure: { message: message.slice(0, 2000) } }); }
  catch (releaseError) {
    throw Object.assign(new Error(`Git worktree creation failed: ${message.slice(0, 2000)}. The claim could not be released as a workspace failure (${failureText(releaseError)}), so epoch ${epoch} is spent rather than handed back.`), { cause: releaseError });
  }
}

/** GY-860 AC-2: why a rework workspace may not start from the submitted PR branch, or null when it may. */
export async function submittedBranchRefusal(root: string, branch: string, remoteBranch: string, candidateSha: string | undefined, run: ChildRun): Promise<string | null> {
  try {
    await run('git', ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:${remoteBranch}`], { cwd: root });
    const remoteSha = String(await run('git', ['rev-parse', '--verify', remoteBranch], { cwd: root })).trim();
    return !candidateSha || remoteSha !== candidateSha ? submittedBranchMoved : null;
  } catch (error) { return `Git worktree creation failed while fetching ${branch}: ${failureText(error)}`; }
}

/**
 * GY-860: record the reservation with any earlier attempt's preserved hold on the branch, then
 * release that hold. A holder whose epoch holds a live lease, or an operation outside this item's
 * session worktrees, is never touched (GY-1078): it is named and nothing is reserved; so, on a
 * first attempt, is a checkout outside the session worktrees (GY-1059), which only a rework's
 * reclaim may detach. A deleted worktree's record is skipped: the release prunes it. A refusal, a
 * refused reservation or a failed release is a workspace failure that costs no attempt — except
 * that a reservation refused because another `worktree` run for this epoch made it first leaves
 * that run's reservation and the claim alone (GY-1059), so the run still building keeps both.
 */
export async function reserveReleasingHold(root: string, branch: string, path: string, run: ChildRun, mutate: (name: string, data: unknown) => Promise<unknown>, epoch: number, host: string,
  work: Pick<Work, 'key' | 'lease' | 'submission'>, now: number) {
  const branchExists = await Promise.resolve().then(() => run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: root })).then(() => true, () => false);
  const holders = branchExists ? branchHolders(root, branch, path).filter(holder => !holder.missing) : [];
  const refusals = holderRefusals(root, holders, work, now, { dirty: false });
  if (!work.submission) for (const holder of holders) {
    if (holder.via === 'checkout' && resolve(dirname(holder.path)) !== worktreesDirectory(root)) refusals.push(`${holder.path} (checked out) is outside the session worktrees under ${worktreesDirectory(root)}, and Graphyard detaches only its own session worktrees: check out another branch there`);
  }
  if (refusals.length) {
    const detail = heldBranchRefusal(branch, refusals);
    await releaseUnderFailure(mutate, epoch, detail);
    throw new Error(`Git worktree creation failed: ${detail} The claim was released as a workspace failure, so the attempt costs nothing.`);
  }
  try { return await releaseHeldBranch(root, branch, path, run, preserved => mutate('workspace', { epoch, host, path, branch, ...(preserved ? { preserved } : {}) })); }
  catch (error) {
    const detail = failureText(error);
    if (/This assignment already has a workspace/.test(detail)) throw new Error(`Git worktree creation failed: ${detail}. Another worktree run for ${work.key} epoch ${epoch} reserved it first, so this run leaves that reservation and the claim alone.`);
    await releaseUnderFailure(mutate, epoch, `Reserving ${branch} or releasing an earlier attempt's hold on it failed: ${detail}`);
    throw new Error(`Git worktree creation failed while reserving ${branch} or releasing an earlier attempt's hold on it: ${detail}. The claim was released as a workspace failure, so the attempt costs nothing; repair the host and it redispatches.`);
  }
}

/** GY-860: a worktree the host's git could not build releases the claim with git's message, so the epoch returns; the error says so. */
export async function workspaceFailure(mutate: (name: string, data: unknown) => Promise<unknown>, epoch: number, error: unknown): Promise<never> {
  const detail = failureText(error);
  await releaseUnderFailure(mutate, epoch, detail);
  throw new Error(`Git worktree creation failed: ${detail}. The claim was released as a workspace failure, so the attempt costs nothing; inspect the event and repair the host before it redispatches.`);
}
