import { defaultChildRun, runChild, type ChildRun } from '../child-runner.js';
import { lstat, mkdir, readdir, rm, rmdir, statfs } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

/**
 * The managed worktree root: the one directory on this host under which Graphyard creates every
 * ephemeral checkout — a proof producer's detached worktree of the exact head, and the checkout a
 * reviewer may read surrounding code from. They must sit outside every worktree of the repository
 * (a session that builds inside an assignment worktree would be building someone else's work),
 * and they must sit on durable storage: a temporary directory is a tmpfs on many hosts, so every
 * checkout there is paid for in memory, and its quota is shared with everything else that writes
 * there. The root defaults to the installation's data directory, is named by `run.worktreeRoot`
 * in .graphyard/master.json when the operator wants it on another volume, and is never derived
 * from the system temporary directory.
 */

export const defaultWorktreeRootMinFreeGb = 2, defaultWorktreeRootBudgetGb = 10;
type Environment = Record<string, string | undefined>;
export interface WorktreeRootSettings { repository: string; run?: { worktreeRoot?: string; worktreeRootMinFreeGb?: number; worktreeRootBudgetGb?: number } }

/**
 * Where this installation keeps data that is neither configuration nor a credential. It is never
 * read from XDG_DATA_HOME: an OpenCode session is launched with that variable pointing at its
 * account home, and a root that moved with the caller would not be one root.
 */
export function dataDirectory(environment: Environment = process.env) {
  const configured = environment.GRAPHYARD_DATA_HOME;
  if (configured && !isAbsolute(configured)) throw new Error('GRAPHYARD_DATA_HOME must be an absolute path');
  return resolve(configured || resolve(homedir(), '.local/share/graphyard'));
}
/** Two checkouts of one repository on one host are two installations: each reclaims only its own root. */
export function defaultWorktreeRoot(root: string, repository: string, environment: Environment = process.env) {
  const name = (repository.split('/').at(-1) ?? 'repository').replace(/[^a-zA-Z0-9._-]/g, '-');
  return resolve(dataDirectory(environment), 'worktrees', `${name}-${createHash('sha256').update(resolve(root)).digest('hex').slice(0, 12)}`);
}
export function worktreeRoot(root: string, config: WorktreeRootSettings, environment: Environment = process.env) {
  const configured = config.run?.worktreeRoot;
  if (configured && !isAbsolute(configured)) throw new Error('run.worktreeRoot must be an absolute path');
  return configured ? resolve(configured) : defaultWorktreeRoot(root, config.repository, environment);
}
export const worktreeRootMinFreeBytes = (config: Pick<WorktreeRootSettings, 'run'>) => (config.run?.worktreeRootMinFreeGb ?? defaultWorktreeRootMinFreeGb) * 1e9;
export const worktreeRootBudgetBytes = (config: Pick<WorktreeRootSettings, 'run'>) => (config.run?.worktreeRootBudgetGb ?? defaultWorktreeRootBudgetGb) * 1e9;

/** Filesystems whose contents live in memory and are gone at the next boot. */
const volatileFilesystems: Record<number, string> = { 0x01021994: 'tmpfs', 0x858458f6: 'ramfs' };
export interface FilesystemFacts {
  /** The directory that was measured: the path itself, or its nearest existing ancestor. */
  probed: string;
  /** `tmpfs` or `ramfs` when the volume is memory-backed; null on durable storage. */
  volatile: string | null;
  freeBytes: number | null;
}
export type FilesystemProbe = (path: string) => Promise<FilesystemFacts>;
/**
 * What the kernel says about the volume a path is, or will be, created on. A root that does not
 * exist yet is judged by its nearest existing ancestor, so setup can verify it without creating it.
 */
export const probeFilesystem: FilesystemProbe = async path => {
  for (let probed = resolve(path); ; probed = dirname(probed)) {
    try {
      const info = await statfs(probed);
      return { probed, volatile: volatileFilesystems[Number(info.type)] ?? null, freeBytes: Number(info.bavail) * Number(info.bsize) };
    } catch (error: any) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR' || dirname(probed) === probed) return { probed, volatile: null, freeBytes: null };
    }
  }
};

const gigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
export interface WorktreeRootVerification { path: string; probed: string; freeBytes: number | null; minFreeBytes: number }
/**
 * The preflight `master init` and every session launch run. A tmpfs is refused outright — the
 * root exists so that checkouts stop being paid for in memory — and so is a volume that cannot
 * hold the configured minimum, because a checkout that fails half-way through an install is the
 * failure this root is here to prevent.
 */
export async function verifyWorktreeRoot(path: string, options: { minFreeBytes: number; probe?: FilesystemProbe }): Promise<WorktreeRootVerification> {
  if (!isAbsolute(path)) throw new Error('The managed worktree root must be an absolute path');
  const facts = await (options.probe ?? probeFilesystem)(path);
  if (facts.volatile) throw new Error(`The managed worktree root ${path} is on a ${facts.volatile} (${facts.probed}): every checkout there is held in memory and lost at the next boot. Set run.worktreeRoot in .graphyard/master.json (or GRAPHYARD_DATA_HOME) to a directory on durable storage, then rerun`);
  if (facts.freeBytes !== null && facts.freeBytes < options.minFreeBytes) throw new Error(`The managed worktree root ${path} has ${gigabytes(facts.freeBytes)} free, below the required ${gigabytes(options.minFreeBytes)}. Free space on that volume, point run.worktreeRoot at a larger one, or lower run.worktreeRootMinFreeGb in .graphyard/master.json`);
  return { path, probed: facts.probed, freeBytes: facts.freeBytes, minFreeBytes: options.minFreeBytes };
}

/*
 * One directory per session, named for what it holds and for the session record that owns it:
 * the detached worktree is `checkout` inside it, and whatever else the session writes — evidence
 * files, an install's cache — sits beside that, so removing the directory removes all of it.
 */
// `approval` is a headless approver's own working directory (GY-391): no checkout is made in it.
export const checkoutKinds = ['proof', 'review', 'approval'] as const;
export type CheckoutKind = typeof checkoutKinds[number];
const managedName = /^graphyard-(proof|review|approval)-[a-z0-9][a-z0-9-]{0,39}-[0-9a-f]{7}-[0-9a-f]{8}$/;
export interface SessionCheckout { directory: string; worktree: string }
export const sessionCheckoutName = (kind: CheckoutKind, key: string, sha: string, id: string) => `graphyard-${kind}-${key.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${sha.slice(0, 7).toLowerCase()}-${id.replace(/-/g, '').slice(0, 8).toLowerCase()}`;
export function sessionCheckout(base: string, kind: CheckoutKind, key: string, sha: string, id: string): SessionCheckout {
  const directory = resolve(base, sessionCheckoutName(kind, key, sha, id));
  return { directory, worktree: resolve(directory, 'checkout') };
}
/** The only thing ever removed: a session directory, by its managed name, directly inside the root. */
function assertManaged(base: string, directory: string) {
  if (dirname(resolve(directory)) !== resolve(base) || !managedName.test(basename(directory)))
    throw new Error(`Refusing to remove ${directory}: only a Graphyard session checkout directly inside ${base} is ever removed`);
}
export async function allocateSessionCheckout(base: string, kind: CheckoutKind, key: string, sha: string, id: string): Promise<SessionCheckout> {
  const checkout = sessionCheckout(base, kind, key, sha, id);
  assertManaged(base, checkout.directory);
  await mkdir(base, { recursive: true, mode: 0o700 });
  await mkdir(checkout.directory, { mode: 0o700 });
  return checkout;
}

type Run = ChildRun;
const git = (repository: string): Run => (command, args) => defaultChildRun(command, args, { cwd: repository });
/**
 * Remove one session's checkout: the worktree's registration in the repository, then the whole
 * session directory with its dependency tree and evidence files. Git is asked first so the
 * registration goes with the files; a worktree the session never created, or already removed, is
 * not an error, and the prune afterwards drops whatever registration is left pointing at nothing.
 */
export async function removeSessionCheckout(repository: string, base: string, directory: string, run?: Run) {
  assertManaged(base, directory);
  const execute = run ?? git(repository);
  try { await execute('git', ['-C', repository, 'worktree', 'remove', '--force', resolve(directory, 'checkout')]); } catch { /* never created, or already gone */ }
  await rm(directory, { recursive: true, force: true });
  try { await execute('git', ['-C', repository, 'worktree', 'prune']); } catch { /* a stale registration is harmless and pruned next time */ }
  // An installation with no session leaves nothing behind, not even its empty root.
  await rmdir(base).catch(() => {});
}

/** A directory no record owns is left alone this long: a launch allocates it before it records the session. */
export const orphanGraceMs = 15 * 60_000;
export interface CheckoutReclaimReport { root: string; at: string; scanned: number; removed: string[]; kept: string[]; errors: string[]; freeBytes: number | null; /** Abandoned neighbouring roots that held nothing and were removed. */ swept: string[] }
/**
 * The reclaim pass. A session settles its own checkout, so what is found here was left by a
 * session that died with its master — a crash between the launch and the ledger write, a host
 * that went down mid-proof. Every managed directory no live session record owns is removed.
 */
export async function reclaimSessionCheckouts(repository: string, base: string, live: Iterable<string>, options: { now?: number; graceMs?: number; run?: Run; probe?: FilesystemProbe; failure?: (error: unknown, action: string, path: string) => Error; environment?: Environment } = {}): Promise<CheckoutReclaimReport> {
  const now = options.now ?? Date.now(), grace = options.graceMs ?? orphanGraceMs, owned = new Set([...live].map(path => resolve(path)));
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  const removed: string[] = [], kept: string[] = [], errors: string[] = [];
  let scanned = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !managedName.test(entry.name)) continue;
    const directory = resolve(base, entry.name);
    scanned++;
    if (owned.has(directory)) { kept.push(directory); continue; }
    const info = await lstat(directory).catch(() => null);
    if (!info || now - info.mtimeMs < grace) { kept.push(directory); continue; }
    try { await removeSessionCheckout(repository, base, directory, options.run); removed.push(directory); }
    catch (error) { errors.push(`${directory}: ${(options.failure?.(error, 'Reclaiming an ephemeral checkout', directory) ?? (error instanceof Error ? error : new Error(String(error)))).message}`); }
  }
  return { root: base, at: new Date(now).toISOString(), scanned, removed, kept, errors, freeBytes: (await (options.probe ?? probeFilesystem)(base)).freeBytes,
    swept: await sweepAbandonedRoots(base, { now, graceMs: grace, environment: options.environment }) };
}
/**
 * Default roots are neighbours in the data directory, one per checkout of a repository, and a
 * checkout that was deleted — a scratch clone, a test fixture — never runs another reclaim pass.
 * What it leaves is swept here, and only when it holds nothing: a neighbouring root is removed
 * when every entry in it is an empty session directory past the grace period. Every removal is a
 * plain rmdir, so nothing that contains a file can be lost to it, whoever it belongs to.
 */
export async function sweepAbandonedRoots(base: string, options: { now?: number; graceMs?: number; environment?: Environment } = {}): Promise<string[]> {
  const parent = dirname(resolve(base)), now = options.now ?? Date.now(), grace = options.graceMs ?? orphanGraceMs;
  if (parent !== resolve(dataDirectory(options.environment), 'worktrees')) return [];
  const swept: string[] = [];
  for (const neighbour of await readdir(parent, { withFileTypes: true }).catch(() => [])) {
    const root = resolve(parent, neighbour.name);
    if (!neighbour.isDirectory() || root === resolve(base)) continue;
    const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
    if (!entries) continue;
    const idle = await Promise.all(entries.map(async entry => {
      if (!entry.isDirectory() || !managedName.test(entry.name)) return false;
      const directory = resolve(root, entry.name), info = await lstat(directory).catch(() => null);
      return !!info && now - info.mtimeMs >= grace && (await readdir(directory).catch(() => ['?'])).length === 0;
    }));
    if (!idle.every(Boolean) || now - ((await lstat(root).catch(() => null))?.mtimeMs ?? now) < grace) continue;
    try { for (const entry of entries) await rmdir(resolve(root, entry.name)); await rmdir(root); swept.push(root); } catch { /* something arrived meanwhile: it is not abandoned */ }
  }
  return swept;
}

/** What the root itself holds, as `du` counts it; null when it cannot be measured in time. */
export async function directoryBytes(path: string, timeoutMs = 10_000): Promise<number | null> {
  try {
    const kilobytes = Number.parseInt((await runChild('du', ['-sk', path], { timeoutMs })).split(/\s/)[0] ?? '', 10);
    return Number.isFinite(kilobytes) ? kilobytes * 1024 : null;
  } catch { return null; }
}

export interface WorktreeRootHealth {
  path: string; exists: boolean; volatile: string | null; freeBytes: number | null; minFreeBytes: number;
  usedBytes: number | null; budgetBytes: number; checkouts: number; unowned: number; low: boolean; overBudget: boolean;
}
/** The share of the budget at which `master status` speaks up, while writes still succeed. */
export const worktreeRootBudgetWarning = 0.8;
/**
 * The root as `master status` reports it. Free space is what the kernel reports for the volume; a
 * user quota is invisible there, so the root's own size is also held against a configured budget —
 * the quota case is exactly the one that stopped this host with gigabytes nominally free.
 */
export async function inspectWorktreeRoot(path: string, settings: { minFreeBytes: number; budgetBytes: number }, live: Iterable<string>, dependencies: { probe?: FilesystemProbe; usage?: (path: string) => Promise<number | null> } = {}): Promise<WorktreeRootHealth> {
  const owned = new Set([...live].map(entry => resolve(entry)));
  const entries = (await readdir(path, { withFileTypes: true }).catch(() => null));
  const checkouts = (entries ?? []).filter(entry => entry.isDirectory() && managedName.test(entry.name)).map(entry => resolve(path, entry.name));
  const facts = await (dependencies.probe ?? probeFilesystem)(path);
  const usedBytes = entries === null ? 0 : await (dependencies.usage ?? directoryBytes)(path);
  return { path, exists: entries !== null, volatile: facts.volatile, freeBytes: facts.freeBytes, minFreeBytes: settings.minFreeBytes, usedBytes, budgetBytes: settings.budgetBytes,
    checkouts: checkouts.length, unowned: checkouts.filter(directory => !owned.has(directory)).length,
    low: facts.freeBytes !== null && facts.freeBytes < settings.minFreeBytes,
    overBudget: usedBytes !== null && usedBytes >= settings.budgetBytes * worktreeRootBudgetWarning };
}
/** The command that runs a reclaim pass now, whether or not a loop is running. */
export const reclaimCommand = 'graphyard master run --once';
/** Attention texts for the root; `master status` gives each its owner. Raised on thresholds, never on the first failed write. */
export function worktreeRootConcerns(health: WorktreeRootHealth): string[] {
  const concerns: string[] = [];
  const held = `${health.checkouts} ephemeral checkout(s), ${health.unowned} owned by no live session`;
  if (health.volatile) concerns.push(`The managed worktree root ${health.path} is on a ${health.volatile}: every proof and review checkout is held in memory. Set run.worktreeRoot in .graphyard/master.json to a directory on durable storage`);
  if (health.low && health.freeBytes !== null) concerns.push(`${gigabytes(health.freeBytes)} free on the managed worktree root ${health.path}, below the configured ${gigabytes(health.minFreeBytes)} minimum; it holds ${held}. Reclaim them before the volume fills`);
  if (health.overBudget && health.usedBytes !== null) concerns.push(`The managed worktree root ${health.path} holds ${gigabytes(health.usedBytes)} of its ${gigabytes(health.budgetBytes)} budget (run.worktreeRootBudgetGb) in ${held}. Reclaim them before the quota is exhausted`);
  return concerns;
}
