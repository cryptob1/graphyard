// Concern: the /tmp directories Graphyard's own processes leave behind (GY-421).
//
// Test runs create their embedded-Postgres data dirs, worktrees and stores under
// `<tmpdir>/graphyard-*` with `mkdtemp`, and a run that is killed — a failure before the after
// hook, a SIGKILL, a machine restart — leaves them there: by 25 September 2026 the host held
// 11,511 of them (single ones 169–262 MB) plus a 2.9 GB `tsx-1000` cache, the tmpfs filled, and
// workers died on the quota error that produced. Two passes answer this: the test runner sweeps
// the directories of runs whose owning process is gone, and the master loop's reclaim pass removes
// what is old and unheld, bounded per cycle, reporting the bytes freed. Both share this module, so
// the rules — a live owner keeps its directory; a dead owner's directory goes whatever its age; an
// ownerless directory goes once it is older than `tmpReclaimMinAgeMs` and no live process holds it
// open — are written once.
//
// A directory created through the tests' shared helper (tests/helpers/temp-dirs.ts) carries an
// owner marker naming the process that made it, which is what makes "whose owning process is
// gone" checkable rather than guessed from a modification time.

import { existsSync, readFileSync, type Dirent, type Stats } from 'node:fs';
import { chmod, lstat, opendir, readdir, readFile, readlink, realpath, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** How old an ownerless directory must be before the pass removes it: the tsx cache's bound, and the default for a caller's own prefixes. */
export const tmpReclaimMinAgeMs = 6 * 3_600_000;
/**
 * The names test runs leave in the host's temporary directory (GY-1074): the helper's own
 * `graphyard-*` directories and markers, other suites' `gy-*` scratch, `landing-merge-result*` and
 * `native-*` from GitHub fixture runs, embedded Postgres's `pg-password-*` files (written by
 * initdb's caller and left behind when that process is killed mid-init) and Playwright's
 * `playwright_chromiumdev_profile-*` browser profiles. On 1 October 2026 these filled /tmp to
 * three quarters of its inodes within hours and the per-user quota broke every worker shell.
 */
export const testTempPatterns: readonly RegExp[] = [/^graphyard-/, /^gy-/, /^landing-merge-result/, /^native-/, /^pg-password/, /^playwright_chromiumdev_profile/];
/** How old a test temp entry — file or directory — must be before the loop's pass removes it. */
export const testTempMinAgeMs = 2 * 3_600_000;
/**
 * The names agent sessions give their own scratch checkouts and logs in /tmp (GY-1618): a worker
 * on another repository's VOICE-615 item made `/tmp/voice615-base-189-release` and five siblings,
 * each a linked git worktree with its dependencies installed (~70,600 inodes apiece), and left them
 * when it finished. By 9 October 2026 they held ~423,000 of /tmp's 1,048,576 inodes, and the pass,
 * which matched only test temp names, removed none of them while the volume fell to 2% free.
 */
export const agentScratchPatterns: readonly RegExp[] = [/^voice\d+-/];
/**
 * The scratch roots agent runtimes keep in a temporary directory, by name under each scanned root
 * (GY-1655): opencode writes a packet and a review file per session into `/tmp/opencode` and never
 * removes them, ~288,700 entries by 10 October 2026, and Claude Code keeps one directory per
 * project path beside it, `claude-<uid>` with `<uid>` the process uid as tsx's per-uid cache is
 * (GY-1827): every worker worktree got its own, 1,569 of them — 1,540 unwritten for more than a
 * day, 17 GB — by 15 October 2026, and none was removed when its session ended. The pass ages the
 * entries inside each root one by one, by `agentScratchMinAgeMs`, and never removes a root itself.
 */
export const agentRuntimeScratchRoots = (uid = process.getuid?.()): readonly string[] =>
  uid === undefined ? ['opencode'] : ['opencode', `claude-${uid}`];
/**
 * What each removal of the pass was (GY-1655), so status can say which class took /tmp back: a test
 * temp name, a tsx compile cache file, an agent's stale checkout (a linked git worktree or git
 * checkout at the top of a root, whatever its name, or an agent scratch name) or an entry inside a
 * runtime's scratch root.
 */
export type TmpReclaimClass = 'testTemp' | 'tsxCache' | 'agentWorktree' | 'runtimeScratch' | 'packageStore' | 'compileCache';
export const tmpReclaimClassNames: Record<TmpReclaimClass, string> = { testTemp: 'test temp', tsxCache: 'tsx cache', agentWorktree: 'agent worktree', runtimeScratch: 'runtime scratch', packageStore: 'pnpm store', compileCache: 'compile cache' };
/**
 * The classes every pass's record counts, even at 0 (GY-1655). The retention classes GY-1683 added
 * (`packageStore`, `compileCache`) appear in a record once they take an entry, so a record written
 * before them, and a reader of the four base counts, reads as it did.
 */
export const tmpReclaimBaseClasses: readonly TmpReclaimClass[] = ['testTemp', 'tsxCache', 'agentWorktree', 'runtimeScratch'];
/**
 * How long an agent scratch entry must have gone unwritten before the pass removes it: a session
 * can leave its checkout idle for hours between commands, where a test run's temp lives minutes.
 * A directory's age is its newest write anywhere in its tree, and for a linked git worktree its
 * gitdir's too, so a checkout an agent still edits or commits in is never stale.
 */
export const agentScratchMinAgeMs = 24 * 3_600_000;
/**
 * The most entries a runtime scratch root keeps while a scanned root's volume is below its inode
 * headroom (GY-1683): its most recently written ones, by their whole trees. On 10 October 2026 five
 * long-lived opencode sessions kept ~18 full pnpm-workspace worktrees (~28,000 inodes each) warm
 * inside the agent scratch bound under /tmp/opencode — 498,925 entries, 56% of /tmp's used inodes —
 * so the pass, honouring that bound, removed 0 entries for 17 passes while the bound stood. Below
 * headroom the oldest entries past the cap go whatever their age; above it the bound alone decides.
 */
export const runtimeScratchCapEntries = 12;
/**
 * The pnpm per-drive stores a scanned root may hold, by name under it (GY-1683): an install into a
 * checkout under /tmp drags pnpm's store onto the same tmpfs (`/tmp/.pnpm-store`, 52,699 inodes on
 * 10 October 2026, unwritten for two weeks). The pass ages this user's regular files under a store
 * on the root's own volume one by one, by `packageStoreMinAgeMs`: pnpm's hardlinks keep installed
 * node_modules whole, and the store refills on demand. Its directories are never removed.
 */
export const packageStoreNames: readonly string[] = ['.pnpm-store'];
/** How long a package store file must have gone unwritten before the pass removes it. */
export const packageStoreMinAgeMs = 7 * 24 * 3_600_000;
/**
 * Node's module compile cache under a scanned root (GY-1683): one directory per Node version under
 * `node-compile-cache` (5,749 entries on 10 October 2026). A version directory whose newest write
 * is older than the pass's cache age bound goes whole; one written inside it, a version in use, stays,
 * as does the cache root itself.
 */
export const compileCacheName = 'node-compile-cache';
/** The most directories one pass removes, and the most wall-clock time it spends removing: reclaim is bounded per cycle, whatever the backlog. */
export const tmpReclaimLimitPerCycle = 100, tmpReclaimWorkMsPerCycle = 150;
/**
 * The inode headroom a temporary directory's volume must keep: a quarter of its inodes free, the
 * line the tmp-inodes reading warns at (262,144 on the host's 1,048,576-inode /tmp).
 */
export const tmpInodeHeadroom = (totalInodes: number) => Math.ceil(totalInodes / 4);
/**
 * The steps a pass escalates through, in the same run, while a scanned root's volume stays below
 * `tmpInodeHeadroom` (GY-1597). On 9 October 2026 the tsx compile cache grew ~450 entries per five
 * minutes while the base bounds — 100 entries per cycle, cache files older than six hours — removed
 * nothing for an hour. Each step raises the per-cycle cap and the work bound and lowers the age a
 * tsx cache file must reach; the test temp names keep their own age bound, and every other rule of
 * the pass — this user's entries only, only regular files under the cache, never one a live process
 * holds — is the same at every step.
 */
export const tmpReclaimEscalation: readonly { limit: number; cacheAgeMs: number; workMs: number }[] = [
  { limit: 2_000, cacheAgeMs: 3_600_000, workMs: 5_000 },
  { limit: 20_000, cacheAgeMs: 10 * 60_000, workMs: 30_000 },
];
/** The most entries one consumer census walks, across every top-level entry it counts: naming the leaker stays bounded on a host with millions. */
export const tmpConsumersScanBound = 500_000;
/** How many of the largest consumers a census names. */
export const tmpConsumersNamed = 5;
/** How long one entry's removal retries a tree that refills or is still being released (ENOTEMPTY, EBUSY) before the pass reports it and the next retries it (GY-1401). */
export const tmpReclaimRetryMs = 2_000;
const retryable = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM', 'EMFILE', 'ENFILE']), unfinishedRemovals = new Set<string>(), unfinishedRegistrations = new Map<string, string>();
/** The marker naming a directory's owner is a sibling file, `<directory>.owner`, not a file inside it: the dominant use of these directories is an embedded Postgres data dir, and `initdb` refuses any directory that holds so much as a dot file. */
export const tempOwnerMarker = (directory: string) => `${directory}.owner`;

/**
 * The start a live kernel reports for `pid`, in clock ticks since boot, or null when /proc cannot
 * answer (no such process, or no /proc). Comparing it against the start the directory's owner
 * recorded keeps a recycled pid from passing for its predecessor.
 */
export function processStartTicks(pid: number, procRoot = '/proc'): number | null {
  try {
    // Fields 1–2 (pid, comm) precede the rest; comm may hold spaces and ')', so cut at the last one.
    const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
    const start = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    return Number.isFinite(start) ? start : null;
  } catch { return null; }
}

/** The owner marker a directory created through the tests' helper carries, as a sibling file. */
export interface TempOwner { pid: number; startedAt: number | null; at: string }
export const readTempOwner = async (directory: string): Promise<TempOwner | null> => {
  const marker = tempOwnerMarker(directory);
  // Most candidates carry no marker at all: a stat beats the read's exception on a scan of thousands.
  if (!existsSync(marker)) return null;
  try {
    const parsed = JSON.parse(await readFile(marker, 'utf8')) as TempOwner;
    return typeof parsed?.pid === 'number' ? { ...parsed, startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : null } : null;
  } catch { return null; }
};
/** Mark `directory` as owned by this process, so a later pass knows whose exit frees it. */
export const writeTempOwner = async (directory: string, now = Date.now()): Promise<TempOwner> => {
  const owner: TempOwner = { pid: process.pid, startedAt: processStartTicks(process.pid), at: new Date(now).toISOString() };
  await writeFile(tempOwnerMarker(directory), `${JSON.stringify(owner)}\n`);
  return owner;
};
/** Whether the process that owns a marked directory is no longer running, pid reuse included. */
export function tempOwnerGone(owner: TempOwner, procRoot = '/proc'): boolean {
  if (!existsSync(procRoot)) {
    // No /proc (macOS and the like): a signal-0 probe is the check, and EPERM means another user's live process.
    try { process.kill(owner.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  }
  if (!existsSync(join(procRoot, String(owner.pid)))) return true;
  const startedAt = processStartTicks(owner.pid, procRoot);
  return owner.startedAt !== null && startedAt !== null && startedAt !== owner.startedAt;
}

/**
 * The absolute paths every live process on the host holds open — its working directory, its root
 * and each of its file descriptors — or names in its command line, read from /proc. A directory one
 * of these paths lies inside is in use whatever its marker says: an ownerless Postgres data dir with
 * a surviving postmaster is not waste, nor a scratch checkout a running server was started with
 * (`-D /tmp/voice638-189-db`, `--dir=/tmp/...`) while it has no file open there (GY-1618). On a host
 * without /proc the set is empty and age alone decides.
 */
export async function heldOpenPaths(procRoot = '/proc'): Promise<Set<string>> {
  const held = new Set<string>();
  let processes: string[];
  try { processes = await readdir(procRoot); } catch { return held; }
  await Promise.all(processes.filter(name => /^\d+$/.test(name)).map(async pid => {
    const base = join(procRoot, pid);
    const descriptors = await readdir(join(base, 'fd')).catch(() => [] as string[]);
    for (const link of ['cwd', 'root', ...descriptors.map(fd => `fd/${fd}`)]) {
      try {
        const target = await readlink(join(base, link));
        if (target.startsWith('/')) held.add(target);
      } catch { /* the process exited between listing and reading */ }
    }
    const commandLine = await readFile(join(base, 'cmdline'), 'utf8').catch(() => '');
    for (const path of namedPaths(commandLine)) held.add(path);
  }));
  return held;
}
/**
 * The absolute paths a process's NUL-separated command line names. An argument that is a path, or
 * the value of `--opt=/path` or a short `-D/path`, is taken whole, spaces included, since the kernel
 * already split the arguments; a path inside a longer argument such as a shell command is taken up
 * to its first space, which can only name a shorter path and so keeps more, never less.
 */
export const namedPaths = (commandLine: string): string[] => commandLine.split('\0').flatMap(argument => {
  const whole = argument.match(/^(?:--[\w-]+=|-[A-Za-z])?(\/.*)$/s)?.[1];
  return [...whole ? [whole] : [], ...argument.match(/(?<![\w.~:/-])\/[^\s'"`=:,;)]+/g) ?? []];
}).map(path => path.replace(/\/+$/, '')).filter((path, index, all) => path.length > 1 && all.indexOf(path) === index);
/**
 * The entries directly under `root` that some held path lies in or names: reduced once per pass, so
 * each candidate's check is one lookup rather than a scan of every open path on the host.
 */
export function heldEntries(root: string, held: Iterable<string>): Set<string> {
  const entries = new Set<string>();
  for (const path of held) {
    if (!path.startsWith(`${root}/`)) continue;
    const rest = path.slice(root.length + 1), slash = rest.indexOf('/');
    entries.add(join(root, slash < 0 ? rest : rest.slice(0, slash)));
  }
  return entries;
}

/**
 * When a directory was last written: its own mtime, or the newest of its entries' when later. A
 * cache such as tsx's rewrites the files inside it without touching the directory's own mtime, so
 * the directory's alone would call a cache in daily use stale.
 */
async function lastWritten(path: string, own: number): Promise<number> {
  let newest = own;
  const entries = await readdir(path).catch(() => [] as string[]);
  for (const name of entries) {
    try { newest = Math.max(newest, (await lstat(join(path, name))).mtimeMs); } catch { /* removed while reading */ }
  }
  return newest;
}
/**
 * When an agent's scratch directory was last written (GY-1618): the newest mtime anywhere in its
 * tree, following no symlink and staying on its device, and, for a linked git worktree, its gitdir's
 * own entries (HEAD, index, logs), which a commit or checkout there rewrites. An edit deep inside a
 * checkout leaves every top-level mtime alone, so the top level alone could call a checkout in use stale.
 */
async function treeLastWritten(path: string, own: number): Promise<number> {
  let newest = own;
  const device = (await lstat(path).catch(() => null))?.dev;
  const stack = [path];
  while (stack.length) {
    const directory = stack.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [] as Dirent[])) {
      const child = join(directory, entry.name);
      const info = await lstat(child).catch(() => null);
      if (!info) continue;
      newest = Math.max(newest, info.mtimeMs);
      if (info.isDirectory() && info.dev === device) stack.push(child);
    }
  }
  const gitdir = (await readFile(join(path, '.git'), 'utf8').catch(() => '')).match(/^gitdir: (.+)$/m)?.[1]?.trim();
  if (gitdir) newest = Math.max(newest, await lastWritten(gitdir, (await lstat(gitdir).catch(() => null))?.mtimeMs ?? 0));
  return newest;
}
/**
 * The mount points this process's mount table lists (`/proc/self/mountinfo`, field 5, its octal
 * escapes decoded), or null when the table cannot be read on Linux. A bind mount whose source is
 * on the scanned volume keeps the volume's device number, so a device comparison alone cannot see
 * it (Codex review of 519dc64fff); the table names the mount point itself. Off Linux there is no
 * table to consult and the device check stands alone.
 */
export async function mountPoints(table = '/proc/self/mountinfo'): Promise<readonly string[] | null> {
  if (process.platform !== 'linux') return [];
  let text: string;
  try { text = await readFile(table, 'utf8'); } catch { return null; }
  const points: string[] = [];
  for (const line of text.split('\n')) {
    const point = line.split(' ')[4];
    if (point) points.push(point.replace(/\\(\d{3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8))));
  }
  return points;
}
/** The mount points at or under `real`, rebased onto `path` (the same directory as a scan names it), or null when the table cannot be read. */
async function mountsUnder(path: string, real: string, mounts?: readonly string[] | null): Promise<Set<string> | null> {
  const points = mounts === undefined ? await mountPoints() : mounts;
  if (points === null) return null;
  return new Set(points.filter(point => point === real || point.startsWith(`${real}/`)).map(point => path + point.slice(real.length)));
}
/**
 * Whether everything under `path` — every directory, file, link and socket in its tree, following
 * no symlink — is on `device` and nothing in the tree, `path` included, is a mount point. A
 * whole-tree removal unlinks whatever a path reaches, and a filesystem mounted anywhere inside a
 * candidate is another volume's inodes, so a sweep that promises the scanned volume alone removes
 * a tree whole only once this has read it to the end (review of 9c6cbd0fd7, GY-1683). A mount that
 * is a single file is on another device too, which is why every entry is judged, not only the
 * directories the walk would enter. A bind mount from the scanned volume itself reports the same
 * device, so the process's mount table is read as well, and the walk fails closed: a tree whose
 * mount table, path, directory or entry cannot be read is not known to be on the device and stays
 * (Codex review of 519dc64fff). `mounts` is the mount table already read, when a caller has it.
 */
export async function treeOnDevice(path: string, device: number, mounts?: readonly string[] | null): Promise<boolean> {
  let own: Stats;
  try { own = await lstat(path); } catch { return false; }
  if (own.dev !== device) return false;
  // A symlink goes as the link alone, never its target, so the target's mounts are not its concern.
  if (own.isSymbolicLink()) return true;
  let real: string;
  try { real = await realpath(path); } catch { return false; }
  const mounted = await mountsUnder(path, real, mounts);
  if (mounted === null || mounted.size) return false;
  if (!own.isDirectory()) return true;
  const stack = [path];
  while (stack.length) {
    const directory = stack.pop()!;
    let entries: Dirent[];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      const child = join(directory, entry.name);
      let info: Stats;
      try { info = await lstat(child); } catch { return false; }
      if (info.dev !== device) return false;
      if (info.isDirectory()) stack.push(child);
    }
  }
  return true;
}
/** The device of a scanned root, through a symlinked root to the directory it names, or undefined when it cannot be read. */
const rootDevice = async (root: string) => (await stat(root).catch(() => null))?.dev;
/**
 * The repository's registration of a linked git worktree at `path` — `.git/worktrees/<name>`, whose
 * `gitdir` file names this checkout back — or null. Removing the checkout alone leaves it registered,
 * and `git worktree add` at the same path then fails as already registered; git's own prune deletes
 * exactly this directory for a missing checkout, so the pass deletes it with the checkout.
 */
async function worktreeRegistration(path: string): Promise<string | null> {
  const gitdir = (await readFile(join(path, '.git'), 'utf8').catch(() => '')).match(/^gitdir: (.+)$/m)?.[1]?.trim();
  if (!gitdir || !isAbsolute(gitdir)) return null;
  const back = (await readFile(join(gitdir, 'gitdir'), 'utf8').catch(() => '')).trim();
  return back === join(path, '.git') ? gitdir : null;
}
/**
 * Whether `path` is a git checkout an agent left (GY-1655): a linked git worktree, whose `.git` file
 * names a gitdir under a repository's `worktrees/`, or a checkout of its own, whose `.git` is a
 * directory holding HEAD. Agents name their scratch after each repository's items
 * (`feature381-red-0c615`, `bug316-display-sim-194`), so no name list keeps up; what they are does.
 */
async function isGitCheckout(path: string): Promise<boolean> {
  const dotGit = join(path, '.git'), info = await lstat(dotGit).catch(() => null);
  if (info?.isDirectory()) return existsSync(join(dotGit, 'HEAD'));
  if (!info?.isFile()) return false;
  const gitdir = (await readFile(dotGit, 'utf8').catch(() => '')).match(/^gitdir: (.+)$/m)?.[1]?.trim();
  return !!gitdir && /\/worktrees\/[^/]+\/?$/.test(gitdir);
}

/** Recursively sum the sizes of the regular files under `path`, following no symlink. */
async function sizeOf(path: string): Promise<number> {
  const own = await lstat(path).catch(() => null);
  if (own && !own.isDirectory()) return own.size;
  let total = 0;
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = join(path, entry.name);
    try {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) total += await sizeOf(child);
      else total += (await stat(child)).size;
    } catch { /* removed while walking */ }
  }
  return total;
}

/**
 * The temporary directories a test run on this host may write to, each once (GY-1368): this
 * process's own tmpdir and `/tmp`, deduplicated by realpath, in that order. The loop's unit can run
 * with TMPDIR=/var/tmp while the test runs, worker and producer sessions that leak entries write
 * under /tmp, so a pass over the loop's own tmpdir alone removed nothing for a day.
 */
export const hostTmpRoots = (own = tmpdir(), shared = '/tmp'): string[] => [own, shared];
/** `roots` with every path that resolves to an earlier one dropped, each with its realpath; a root that cannot be resolved is its own. */
async function distinctRoots(roots: readonly string[]): Promise<{ path: string; real: string }[]> {
  const distinct: { path: string; real: string }[] = [];
  for (const path of roots) {
    const real = await realpath(path).catch(() => path);
    if (!distinct.some(root => root.real === real)) distinct.push({ path, real });
  }
  return distinct;
}

export interface TmpReclaimReport {
  at: string;
  /** The directories the pass scanned, each once; absent from a report of a pass that never ran. */
  roots?: string[];
  scanned: number;
  /** What the pass removed, oldest first, and the bytes that came back with them. */
  removed: { path: string; bytes: number }[];
  bytes: number;
  /** How many of `removed` each class took (GY-1655): the base classes always, a retention class once it took one; absent from a report of a pass that never ran. */
  classes?: Partial<Record<TmpReclaimClass, number>>;
  /** Directories kept: a live owner, an open holder, or past the per-pass bound. */
  kept: number;
  errors: string[];
  /**
   * The escalation steps the pass ran past its base bounds because a root's volume stayed below its
   * inode headroom (GY-1597), each with what it removed; absent when the bound never stood. With
   * steps run, `scanned` and `kept` are the last step's.
   */
  escalated?: { limit: number; cacheAgeMs: number; removed: number }[];
  /** Whether a scanned root's volume was still below its inode headroom when the pass ended; absent when no volume was measured. */
  boundStands?: boolean;
  /** The largest consumers of the scanned roots, named when the bound still stood at the pass's end: what to stop, since the pass took all it may. */
  consumers?: TmpConsumer[];
  /**
   * Each scanned root's own volume as the pass left it (GY-1602): its inodes, whether it is below
   * its headroom and, when it is, its own top consumers and whether that census stopped at its
   * budget. Absent when no volume was measured.
   */
  pressure?: TmpRootPressure[];
}
/** One scanned root's inodes at the pass's end, measured on that root's own filesystem, with the consumers named while it is below its headroom. */
export interface TmpRootPressure { root: string; totalInodes: number; freeInodes: number; below: boolean; consumers?: TmpConsumer[]; partial?: boolean }
/** One consumer of a temporary directory: a top-level entry, or a family of same-stem siblings, with the entries under it and their owner. */
export interface TmpConsumer { path: string; entries: number; owner: string; capped?: boolean }
export interface TmpReclaimOptions {
  now?: number;
  /** The directory scanned; the host's temporary directory by default. */
  tmpRoot?: string;
  /** The directories scanned, in place of `tmpRoot`: each once by realpath, sharing the pass's bounds (GY-1368). */
  tmpRoots?: readonly string[];
  /** Entry-name prefixes considered, all judged by `maxAgeMs`; the default is `testTempPatterns` (by `testTempMinAgeMs`) and the regular files in this user's tsx caches (by `tmpReclaimMinAgeMs`), which are never taken whole. */
  prefixes?: readonly string[];
  /** The most directories one pass removes; `tmpReclaimLimitPerCycle` by default. */
  limit?: number;
  /** How old an ownerless, unheld entry must be; with `prefixes`, `tmpReclaimMinAgeMs` by default, else each default pattern's own bound. */
  maxAgeMs?: number;
  /** The most wall-clock time the pass spends removing, when set; the loop passes `tmpReclaimWorkMsPerCycle`. */
  workMs?: number;
  /** The steps a pass below its inode headroom escalates through; `tmpReclaimEscalation` by default. */
  escalation?: readonly { limit: number; cacheAgeMs: number; workMs: number }[];
  /** The runtime scratch roots whose entries the default pass ages one by one; `agentRuntimeScratchRoots` by default. */
  runtimeScratchRoots?: readonly string[];
  /** The most entries a runtime scratch root keeps while a scanned root is below its inode headroom (GY-1683); `runtimeScratchCapEntries` by default. */
  runtimeScratchCap?: number;
  /** The live-holder set, when the caller has one; a fresh /proc scan runs when omitted. */
  held?: Set<string>;
  /** The mount table (`mountPoints`), when the caller has one: null for a table that could not be read; this process's own is read when omitted. */
  mounts?: readonly string[] | null;
  /** Entries an earlier pass failed to finish removing, retried ahead of their age bound (this process's own set by default), and how long one removal retries. */
  unfinished?: Set<string>; retryMs?: number;
  /** Linked worktrees' registrations whose removal has not yet succeeded, keyed by registration, naming its checkout: retried by each pass once that checkout is gone (this process's own map by default). */
  registrations?: Map<string, string>;
  /**
   * Measures a root's volume: given, the default pass escalates through `tmpReclaimEscalation`
   * while a root's free inodes stay below `tmpInodeHeadroom`, and names the top consumers when they
   * still do at its end (GY-1597). The loop passes statfs for the host's roots; without it the pass
   * keeps its base bounds.
   */
  volume?: (path: string) => Promise<{ files: number | bigint; ffree: number | bigint }>;
}
/** The age an entry of this name must reach before the default pass removes it whole, or null when the name is not the pass's. */
const defaultMinAge = (name: string) => testTempPatterns.some(pattern => pattern.test(name)) ? testTempMinAgeMs : agentScratchPatterns.some(pattern => pattern.test(name)) ? agentScratchMinAgeMs : null;
/** A tsx compile cache directory's name: never removed whole, only aged file by file (GY-1512). */
const tsxCachePattern = /^tsx-\d+$/;

/**
 * One bounded pass over the host's temporary directory, or each of `tmpRoots` once. Only this user's entries are considered —
 * directories, and plain files such as a `pg-password-*` — whose names the pass matches. A marked
 * directory whose owner still runs is kept whatever its age; one whose owner has exited is removed
 * at once, however young — that is the test runner's sweep of a run that just ended; any other
 * entry is removed only once it is older than its age bound and no live process holds it open. The
 * oldest removable entries go first, at most `limit` of them, and every removal is reported with
 * the bytes it freed. Nothing here throws for an entry it cannot read: the error is reported instead.
 */
export async function reclaimTmpDirectories(options: TmpReclaimOptions = {}): Promise<TmpReclaimReport> {
  const now = options.now ?? Date.now();
  const roots = await distinctRoots(options.tmpRoots ?? [options.tmpRoot ?? tmpdir()]);
  const report: TmpReclaimReport = { at: new Date(now).toISOString(), roots: roots.map(root => root.path), scanned: 0, removed: [], bytes: 0, classes: Object.fromEntries(tmpReclaimBaseClasses.map(kind => [kind, 0])), kept: 0, errors: [] };
  const minAge = options.prefixes
    ? (name: string) => options.prefixes!.some(prefix => name.startsWith(prefix)) ? options.maxAgeMs ?? tmpReclaimMinAgeMs : null
    : (name: string) => { const age = defaultMinAge(name); return age === null ? null : options.maxAgeMs ?? age; };
  // The bounds are the pass's, not each root's: a second root never doubles a cycle's work. The
  // work bound is real elapsed time, not the caller's clock: a mocked `now` must not change how
  // long a cycle spends taking directories back. It bounds removing only, so its clock starts at the
  // pass's first removal: scanning a backlogged /tmp and /proc never spends it before anything goes.
  // A caller's own prefixes never sweep the tsx cache; the default pass ages its files by the cache's bound.
  const cacheAge = options.prefixes ? null : options.maxAgeMs ?? tmpReclaimMinAgeMs;
  // Only the default pass recognises agent scratch by what it is (GY-1655): a caller's own prefixes are all it asked for.
  const agentAge = options.prefixes ? null : options.maxAgeMs ?? agentScratchMinAgeMs;
  const runtimeRoots = options.prefixes ? [] : options.runtimeScratchRoots ?? agentRuntimeScratchRoots();
  // The store and compile cache sweeps are the default pass's too (GY-1683): a caller's own prefixes never reach them.
  const storeAge = options.prefixes ? null : options.maxAgeMs ?? packageStoreMinAgeMs;
  const pass: PassState = { now, minAge, cacheAge, agentAge, storeAge, runtimeRoots, cap: null, written: new Map(), limit: options.limit ?? tmpReclaimLimitPerCycle, uid: process.getuid?.(), held: options.held ?? null, mounts: options.mounts,
    workMs: options.workMs ?? Number.POSITIVE_INFINITY, started: null, unfinished: options.unfinished ?? unfinishedRemovals, retryMs: options.retryMs ?? tmpReclaimRetryMs,
    registrations: options.registrations ?? unfinishedRegistrations };
  for (const path of pass.unfinished) if (!existsSync(path)) pass.unfinished.delete(path);
  // A registration is kept apart from its checkout's path: once the checkout is gone that path is
  // dropped above, and a registration left behind would keep `git worktree add` refusing the path.
  // One whose checkout is still being removed waits for it; its checkout's own retry takes it.
  for (const [registration, checkout] of pass.registrations) {
    if (existsSync(checkout)) continue;
    try { await rm(registration, { recursive: true, force: true }); pass.registrations.delete(registration); }
    catch (error) { report.errors.push(`${registration}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const sweep = async (scanned = roots) => {
    for (const { path, real } of scanned) {
      await reclaimRoot(path, real, pass, report);
      await reclaimTsxCaches(path, real, pass, report);
      await reclaimPackageStores(path, real, pass, report);
      await reclaimCompileCaches(path, real, pass, report);
      await reclaimRuntimeScratch(path, real, pass, report);
    }
  };
  await sweep();
  // A pass that cannot hold the headroom does not silently repeat (GY-1597): while a root's volume
  // stays below it, the same run escalates — a higher cap, a longer work bound, a younger tsx cache
  // age — and, if the bound still stands once every step has run, names what fills the roots.
  const volume = options.prefixes ? undefined : options.volume;
  if (!volume) return report;
  // Which roots are low, not merely whether one is: a healthy TMPDIR on another volume must not
  // spend the escalated cap the low /tmp needs, nor crowd its consumers out of the census.
  // Every root is measured on its own volume, so a low /tmp is seen whatever TMPDIR's volume says (GY-1602).
  let measured: { root: (typeof roots)[number]; inodes: { total: number; free: number } | null }[] = [];
  const low = async () => {
    measured = await Promise.all(roots.map(async root => ({ root, inodes: await inodesOf(root.path, volume) })));
    return measured.filter(entry => entry.inodes && entry.inodes.free < tmpInodeHeadroom(entry.inodes.total)).map(entry => entry.root);
  };
  let lowRoots = await low();
  report.boundStands = lowRoots.length > 0;
  for (const step of options.escalation ?? tmpReclaimEscalation) {
    if (!report.boundStands) break;
    const before = report.removed.length;
    // A step's bounds are the whole pass's, base sweep included: 20,000 per cycle means 20,000, not
    // 20,000 more, and 30 s of removing is counted from the pass's first removal, not the step's.
    // Below headroom each runtime scratch root is also capped to its newest entries (GY-1683): the
    // base sweep, and every pass above headroom, keeps the agent scratch bound alone.
    Object.assign(pass, { limit: Math.max(before, step.limit), cacheAge: Math.min(cacheAge ?? step.cacheAgeMs, step.cacheAgeMs), workMs: step.workMs, cap: options.runtimeScratchCap ?? runtimeScratchCapEntries });
    report.scanned = 0; report.kept = 0;
    await sweep(lowRoots);
    (report.escalated ??= []).push({ limit: step.limit, cacheAgeMs: pass.cacheAge!, removed: report.removed.length - before });
    lowRoots = await low();
    report.boundStands = lowRoots.length > 0;
  }
  // Each low root gets its own census, so one root's consumers never crowd out another's.
  report.pressure = [];
  for (const { root, inodes } of measured) {
    if (!inodes) continue;
    const below = lowRoots.includes(root), census = below ? await tmpCensus(root.path) : null;
    report.pressure.push({ root: root.path, totalInodes: inodes.total, freeInodes: inodes.free, below, ...(census ? { consumers: census.consumers, ...(census.partial ? { partial: true } : {}) } : {}) });
  }
  if (report.boundStands) report.consumers = report.pressure.flatMap(entry => entry.consumers ?? []);
  return report;
}

/** `path`'s volume's inodes, or null for a volume without fixed inodes or one that cannot be read: such a volume is never below its headroom. */
async function inodesOf(path: string, volume: NonNullable<TmpReclaimOptions['volume']>) {
  try {
    const info = await volume(path), total = Number(info.files), free = Number(info.ffree);
    return Number.isFinite(total) && total > 0 && Number.isFinite(free) ? { total, free } : null;
  } catch { return null; }
}

/** The name a uid has in /etc/passwd, or `uid N` when it has none there. */
function ownerNames(passwd = '/etc/passwd') {
  const names = new Map<number, string>();
  try { for (const line of readFileSync(passwd, 'utf8').split('\n')) { const [name, , uid] = line.split(':'); if (name && uid && /^\d+$/.test(uid)) names.set(Number(uid), name); } } catch { /* no passwd: uids stand */ }
  return (uid: number) => names.get(uid) ?? `uid ${uid}`;
}
/** The family a top-level name belongs to: its name without a trailing run-specific part (`graphyard-reclaim-Ab3xYz` → `graphyard-reclaim`), so a leaker's thousands of siblings count as one consumer. */
const consumerStem = (name: string) => name.replace(/([-_.][^-_.]*\d[^-_.]*)+$/, '') || name;
/**
 * The largest consumers of `roots`, every user's entries included (GY-1597): each top-level entry
 * counts itself and every entry under it, siblings of one stem and owner are summed as one family,
 * and the `tmpConsumersNamed` largest are named with their owner. The census — top-level entries and the walk under them — stops at
 * `tmpConsumersScanBound` entries and marks what it could not finish as capped; it reads only, and
 * a directory it may not read, or one on another device than its root, counts as itself.
 */
export async function tmpConsumers(roots: readonly string[], bound = tmpConsumersScanBound): Promise<TmpConsumer[]> {
  return (await tmpCensus(roots, bound)).consumers;
}
/**
 * `tmpConsumers` with whether the census is partial (GY-1602): every top-level entry it reads, and
 * every entry under one, is charged to `bound`, so a root holding more top-level entries than the
 * bound stops at the bound, never stats the rest, and reports itself partial.
 */
export async function tmpCensus(roots: string | readonly string[], bound = tmpConsumersScanBound): Promise<{ consumers: TmpConsumer[]; partial: boolean }> {
  roots = typeof roots === 'string' ? [roots] : roots;
  const owner = ownerNames(), families = new Map<string, { root: string; stem: string; first: string; members: number; entries: number; uid: number; capped: boolean }>();
  let budget = bound;
  // The census stays on the measured volume: a mount under /tmp is another filesystem's inodes, so
  // a directory on another device counts as itself and is not descended.
  const walk = async (path: string, device: number): Promise<{ entries: number; capped: boolean }> => {
    let entries = 0;
    const stack = [path];
    while (stack.length) {
      const directory = stack.pop()!, dirents = await readdir(directory, { withFileTypes: true }).catch(() => [] as Dirent[]);
      for (const entry of dirents) {
        if (budget <= 0) return { entries, capped: true };
        budget--; entries++;
        if (!entry.isDirectory()) continue;
        const child = join(directory, entry.name);
        if ((await lstat(child).catch(() => null))?.dev === device) stack.push(child);
      }
    }
    return { entries, capped: false };
  };
  // Top-level entries count against the same budget, read as a stream: a /tmp of a million flat
  // files is neither materialised nor stat'ed past the bound, and what the census never reached
  // marks every family it names as capped.
  let truncated = false;
  census: for (const root of new Set(roots)) {
    let directory, device;
    try { device = (await stat(root)).dev; directory = await opendir(root); } catch { continue; }
    for await (const entry of directory) {
      if (budget <= 0) { truncated = true; break census; }
      budget--;
      const name = entry.name, path = join(root, name);
      let info;
      try { info = await lstat(path); } catch { continue; }
      const inside = info.isDirectory() && info.dev === device && budget > 0 ? await walk(path, device) : { entries: 0, capped: info.isDirectory() && info.dev === device };
      const stem = consumerStem(name), key = `${root}\0${stem}\0${info.uid}`;
      const family = families.get(key) ?? { root, stem, first: path, members: 0, entries: 0, uid: info.uid, capped: false };
      family.members++; family.entries += 1 + inside.entries; family.capped ||= inside.capped;
      families.set(key, family);
    }
  }
  if (truncated) for (const family of families.values()) family.capped = true;
  const partial = truncated || [...families.values()].some(family => family.capped);
  return { partial, consumers: [...families.values()].sort((first, second) => second.entries - first.entries).slice(0, tmpConsumersNamed)
    .map(family => ({ path: family.members === 1 ? family.first : `${join(family.root, family.stem)}* (${family.members} top-level)`, entries: family.entries, owner: owner(family.uid), ...(family.capped ? { capped: true } : {}) })) };
}

/** `cap`: the runtime scratch cap of the sweep under way, set only below headroom; `written`: each runtime scratch entry's tree write time, read once per pass. */
interface PassState { now: number; minAge: (name: string) => number | null; cacheAge: number | null; agentAge: number | null; storeAge: number | null; runtimeRoots: readonly string[]; cap: number | null; written: Map<string, number>; limit: number; uid: number | undefined; held: Set<string> | null; mounts: readonly string[] | null | undefined; workMs: number; started: number | null; unfinished: Set<string>; retryMs: number; registrations: Map<string, string> }
/** Record one removal of `kind` in `report`. */
function took(report: TmpReclaimReport, kind: TmpReclaimClass, path: string, bytes: number) {
  report.removed.push({ path, bytes });
  report.bytes += bytes;
  if (report.classes) report.classes[kind] = (report.classes[kind] ?? 0) + 1;
}
/**
 * Adds the owner-write bit to every directory under `path` that `uid` owns, following no symlink
 * (GY-1828): a stale entry holding a sandbox repository keeps `.git/worktrees/<name>` mode 0555,
 * and `rm` reports `EACCES: permission denied, unlink` for the first file inside it however often
 * a pass retries — the instance the resources class recorded stayed and every later pass reported
 * the error again. Returns whether any mode was changed, so a retry is worth the tree's read.
 * A directory another user owns is never touched — on a sticky world-writable root it is theirs,
 * and `chmod` would refuse it anyway — and nothing else is: unlinking a file needs no write bit
 * of its own, and a symlink is taken as the link alone.
 */
async function makeOwnerWritable(path: string, uid: number | undefined): Promise<boolean> {
  let changed = false;
  const stack = [path];
  while (stack.length) {
    const directory = stack.pop()!;
    let info: Stats | null = null;
    try { info = await lstat(directory); } catch { continue; }
    if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) continue;
    if (!(info.mode & 0o200)) { try { await chmod(directory, info.mode | 0o200); changed = true; } catch { /* the removal's own error stands when the retry still fails */ } }
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [] as Dirent[])) stack.push(join(directory, entry.name));
  }
  return changed;
}
/**
 * Remove `path` recursively, retrying while its tree refills or is still being released, for at
 * most `retryMs`. A refusal its owner's own read-only directories cause (`EACCES`, or the `EPERM`
 * some filesystems report) makes those directories writable first and retries inside the window,
 * so an entry the pass owns is freed this pass instead of reported for every pass to come
 * (GY-1828); one whose read-only directories are another user's changes nothing and fails as before.
 */
async function removeTree(path: string, retryMs: number, uid: number | undefined) {
  const until = Date.now() + retryMs;
  for (;;) {
    try { return await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      const writable = code === 'EACCES' || code === 'EPERM' ? await makeOwnerWritable(path, uid) : false;
      if ((!retryable.has(code) && !writable) || Date.now() >= until) throw error;
      await new Promise(done => setTimeout(done, 10));
    }
  }
}
/** One root's share of a pass: scanned within what the pass's bounds have left, its outcome added to `report`. */
async function reclaimRoot(root: string, real: string, pass: PassState, report: TmpReclaimReport) {
  const { now, minAge, uid } = pass, limit = Math.max(0, pass.limit - report.removed.length), scannedBefore = report.scanned;
  const dirents = await readdir(root, { withFileTypes: true }).catch(() => [] as Dirent[]);
  // A marker goes with its directory, never as an entry of its own; a symlink is never followed or taken.
  // A tsx cache is never a whole-tree candidate, whatever a caller's prefixes: its sockets and per-cycle bound are the cache sweep's.
  const candidate = (entry: Dirent) => (entry.isDirectory() || entry.isFile()) && !entry.name.endsWith('.owner') && !tsxCachePattern.test(entry.name) && minAge(entry.name) !== null;
  const removable: { path: string; mtime: number; kind: TmpReclaimClass }[] = [];
  let held: Set<string> | null = null;
  for (const entry of dirents) {
    // A root reached after earlier roots spent the pass's limit has none left: it only counts its candidates as kept.
    if (removable.length >= limit) break;
    const path = join(root, entry.name);
    // A marker whose directory is already gone is clutter: take it back, whatever the bound.
    if (entry.name.startsWith('graphyard-') && entry.name.endsWith('.owner') && !existsSync(path.slice(0, -'.owner'.length))) {
      try { await rm(path, { force: true }); } catch { /* the next pass tries again */ }
      continue;
    }
    // A name the pass knows is judged by that name's bound; any other directory of this user's is an
    // agent's stale checkout if it is a git checkout or linked worktree, judged by the agent scratch
    // bound (GY-1655). Only an old one is opened to look: a young directory is kept on one stat.
    let maxAgeMs = candidate(entry) ? minAge(entry.name) : null, kind: TmpReclaimClass = 'testTemp', tree = false;
    if (maxAgeMs !== null && agentScratchPatterns.some(pattern => pattern.test(entry.name))) { kind = 'agentWorktree'; tree = entry.isDirectory(); }
    else if (maxAgeMs === null && !(pass.agentAge !== null && entry.isDirectory() && !entry.name.endsWith('.owner') && !tsxCachePattern.test(entry.name) && !pass.runtimeRoots.includes(entry.name))) continue;
    let info;
    try { info = await lstat(path); } catch { continue; }
    // Another user's entry is theirs to clear: on a sticky /tmp it could not be removed anyway.
    if (uid !== undefined && info.uid !== uid) continue;
    if (maxAgeMs === null) {
      if (now - info.mtimeMs < pass.agentAge! && !pass.unfinished.has(path)) continue;
      // A checkout an earlier pass half removed may have lost its .git already: it is still due.
      if (!pass.unfinished.has(path) && !await isGitCheckout(path)) continue;
      maxAgeMs = pass.agentAge!; kind = 'agentWorktree'; tree = true;
    } else if (kind === 'testTemp' && pass.agentAge !== null && entry.isDirectory() && now - info.mtimeMs >= maxAgeMs && !pass.unfinished.has(path) && await isGitCheckout(path)) {
      // A checkout is an agent's whatever its name: one named like a test temp is judged by the agent
      // bound and its whole tree, not removed two hours after its last top-level write. Only a
      // directory old by its name's bound is opened to look; a younger one is kept on one stat anyway.
      maxAgeMs = Math.max(maxAgeMs, pass.agentAge); kind = 'agentWorktree'; tree = true;
    }
    report.scanned++;
    const owner = entry.isDirectory() ? await readTempOwner(path) : null;
    const gone = owner ? tempOwnerGone(owner) : false;
    // A live owner keeps its directory only when its start could be recorded: without it a recycled
    // pid would pass for the dead run's owner for as long as it lives, so such a directory is judged
    // as an ownerless one is — by its age and its live holders.
    if (owner && !gone && owner.startedAt !== null) { report.kept++; continue; }
    if (owner && gone) { removable.push({ path, mtime: 0, kind }); }
    else {
      // A directory's entries are read only once the directory itself is old: a young one is kept on one stat.
      // An entry an earlier pass began removing is due at once: its half-finished removal is what made it look young (GY-1401).
      let written = pass.unfinished.has(path) ? 0 : now - info.mtimeMs < maxAgeMs || !entry.isDirectory() ? info.mtimeMs : await lastWritten(path, info.mtimeMs);
      if (now - written < maxAgeMs) { report.kept++; continue; }
      // Only holders under the scanned root can hold a candidate, and on a host with a backlog the
      // raw scan holds thousands of paths elsewhere: reduce it once to the root's entries, then
      // every check is a single lookup.
      // /proc names a holder by its resolved path, so a root reached through a symlink is matched by its realpath.
      // A command line names the path as it was typed, so a root's own spelling is matched as well.
      if (!held) { const all = pass.held ??= await heldOpenPaths(); held = new Set([...heldEntries(real, all), ...(root === real ? [] : heldEntries(root, all))]); }
      if (held.has(join(real, entry.name)) || held.has(join(root, entry.name))) { report.kept++; continue; }
      // An agent's scratch checkout is judged by its whole tree, read last: only an old, unheld one is walked.
      if (written && tree) {
        written = await treeLastWritten(path, written);
        if (now - written < maxAgeMs) { report.kept++; continue; }
      }
      removable.push({ path, mtime: written, kind });
    }
    // The scan is bounded with the removals: once this pass cannot remove more, another 10,000
    // candidates are the next pass's work, not this cycle's. Order in the directory otherwise.
    if (removable.length >= limit) break;
  }
  // The candidates the bound left unexamined are the next pass's: they are counted as kept, from
  // the dirent list already in hand, so the report still accounts for every candidate exactly once.
  report.kept += Math.max(0, dirents.reduce((total, entry) => total + (candidate(entry) ? 1 : 0), 0) - (report.scanned - scannedBefore));
  removable.sort((first, second) => first.mtime - second.mtime);
  const removedBefore = report.removed.length;
  for (const { path, kind } of removable.slice(0, limit)) {
    const at = Date.now();
    pass.started ??= at;
    if (at > pass.started + pass.workMs) break;
    try {
      const bytes = await sizeOf(path);
      // The registration is recorded before the tree goes: a removal that fails partway may take the
      // checkout's .git file with it, and a failed registration removal must outlive the checkout's path.
      const registration = await worktreeRegistration(path);
      if (registration) pass.registrations.set(registration, path);
      await removeTree(path, pass.retryMs, pass.uid);
      for (const [pending, checkout] of pass.registrations) if (checkout === path) { await rm(pending, { recursive: true, force: true }); pass.registrations.delete(pending); }
      await rm(tempOwnerMarker(path), { force: true });
      pass.unfinished.delete(path);
      took(report, kind, path, bytes);
    } catch (error) { pass.unfinished.add(path); report.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  report.kept += Math.max(0, removable.length - (report.removed.length - removedBefore));
}

/** The name of this user's tsx compile cache directory in a temporary directory, or null where there are no uids. */
export const tsxCacheName = (uid = process.getuid?.()) => uid === undefined ? null : `tsx-${uid}`;
/**
 * The regular files under `directory`, recursively, following no symlink and never leaving
 * `device`: a directory mounted inside the walk is another filesystem's inodes, so a sweep that
 * promises the scanned volume alone stops at its boundary. What a cache or store sweep may take,
 * each still judged by `agedFileSweepable` on its own stats: a regular file bind-mounted into the
 * walk is on another device too, and no directory check sees it.
 */
async function cacheFiles(directory: string, device: number, mounted: ReadonlySet<string>): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [] as Dirent[]);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    // A mount point is another filesystem's, whatever device it reports: a bind mount from this volume keeps its number (Codex review of 519dc64fff).
    if (mounted.has(path)) continue;
    if (entry.isFile()) files.push(path);
    else if (entry.isDirectory()) {
      const info = await lstat(path).catch(() => null);
      if (info?.dev === device) files.push(...await cacheFiles(path, device, mounted));
    }
  }
  return files;
}
/**
 * One root's tsx compile caches, aged file by file (GY-1512). Test runs write content-hashed compile
 * files into `tsx-<uid>` all day, so a cache in use is never old enough to go whole: on 8 October
 * 2026 it held 89,896 entries, 8,174 of them from the previous 90 minutes. The cache is also never
 * taken whole once it does go quiet, since its sockets belong to tsx and a whole tree would pass
 * the per-cycle bound as one removal. The pass takes this user's regular files in each `tsx-<n>`
 * directory this user owns that are older than the cache's age bound, oldest first, within what
 * the pass's entry and work bounds have left; the directory, its subdirectories and the IPC
 * sockets live tsx processes listen on are never removed, nor a file a live process holds open.
 */
async function reclaimTsxCaches(root: string, real: string, pass: PassState, report: TmpReclaimReport) {
  if (pass.cacheAge === null) return;
  const names = (await readdir(root).catch(() => [] as string[])).filter(name => tsxCachePattern.test(name)).sort();
  await reclaimAgedFiles(root, real, names, pass.cacheAge, 'tsxCache', pass, report);
}
/**
 * One root's pnpm per-drive stores, aged file by file (GY-1683), as the tsx caches are: this user's
 * regular files under each `packageStoreNames` directory this user owns on the root's own volume —
 * a store mounted under the root is another filesystem's inodes, not this one's — older than the
 * store age bound, oldest first, within what the pass's entry and work bounds have left, never one a
 * live process holds open. The store's directories are never removed: pnpm refills them on demand.
 */
async function reclaimPackageStores(root: string, real: string, pass: PassState, report: TmpReclaimReport) {
  if (pass.storeAge === null) return;
  const device = await rootDevice(root), stores: string[] = [];
  for (const name of packageStoreNames) {
    const own = await lstat(join(root, name)).catch(() => null);
    if (own?.isDirectory() && own.dev === device) stores.push(name);
  }
  await reclaimAgedFiles(root, real, stores, pass.storeAge, 'packageStore', pass, report);
}
/**
 * This user's regular files under each of `names` (directories directly under `root`) that this
 * user owns, older than `maxAgeMs`, oldest first, within what the pass's entry and work bounds have
 * left; a file a live process holds open, a socket, a directory, the named directory itself and
 * anything on another device — a filesystem mounted inside it, directory or single file — are never
 * removed. The tsx cache and package store sweeps are this rule with their own bounds.
 */
/**
 * Whether one entry an aged-file walk found may go: this user's regular file, on the swept
 * directory's own device, older than `maxAgeMs`. The device is checked file by file, not only
 * directory by directory (review of 966e92569881): a regular file bind-mounted into an otherwise
 * same-volume store or cache is another filesystem's inode, and the walk's directory check never
 * sees a mount that is a file.
 */
export const agedFileSweepable = (info: Pick<Stats, 'isFile' | 'dev' | 'uid' | 'mtimeMs'>, own: Pick<Stats, 'dev'>, uid: number | undefined, now: number, maxAgeMs: number) =>
  info.isFile() && info.dev === own.dev && (uid === undefined || info.uid === uid) && now - info.mtimeMs >= maxAgeMs;
async function reclaimAgedFiles(root: string, real: string, names: readonly string[], maxAgeMs: number, kind: TmpReclaimClass, pass: PassState, report: TmpReclaimReport) {
  const limit = pass.limit - report.removed.length;
  if (limit <= 0 || !names.length) return;
  const old: { path: string; mtime: number; bytes: number }[] = [];
  for (const name of names) {
    const own = await lstat(join(root, name)).catch(() => null);
    if (!own?.isDirectory() || (pass.uid !== undefined && own.uid !== pass.uid)) continue;
    // A mount inside the directory is never entered and a mounted file never unlinked; a mount table that cannot be read keeps the directory whole this pass.
    const mounted = await mountsUnder(join(root, name), join(real, name), pass.mounts);
    if (mounted === null) { report.errors.push(`${join(root, name)}: the mount table could not be read, so no file of it was aged this pass`); continue; }
    if (mounted.has(join(root, name))) continue;
    for (const path of await cacheFiles(join(root, name), own.dev, mounted)) {
      let info;
      try { info = await lstat(path); } catch { continue; }
      if (!agedFileSweepable(info, own, pass.uid, pass.now, maxAgeMs)) continue;
      old.push({ path, mtime: info.mtimeMs, bytes: info.size });
    }
  }
  if (!old.length) return;
  const held = pass.held ??= await heldOpenPaths();
  // /proc names a holder by its resolved path, so a root reached through a symlink is matched by its realpath.
  const removable = old.filter(file => !held.has(join(real, file.path.slice(root.length + 1))) && !held.has(file.path)).sort((first, second) => first.mtime - second.mtime);
  report.kept += Math.max(0, removable.length - limit);
  for (const { path, bytes } of removable.slice(0, limit)) {
    const at = Date.now();
    pass.started ??= at;
    if (at > pass.started + pass.workMs) break;
    try {
      await rm(path, { force: true });
      took(report, kind, path, bytes);
    } catch (error) { report.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
/**
 * One root's node compile cache, aged version by version (GY-1683): each directory directly under
 * `<root>/node-compile-cache` that this user owns — Node keeps one per version — whose newest write
 * anywhere in its tree is older than the pass's cache age bound, and that no live process holds or
 * names, goes whole, oldest first, within what the pass's entry and work bounds have left. A version
 * written inside the bound is in use and stays; the cache root is never removed. The cache, each
 * version and everything under it must be on the scanned root's own volume: a filesystem mounted
 * there is not this root's inodes and is never entered. A removal that fails partway (the version
 * refilled while it went, or a file in it could not be unlinked) is recorded as unfinished and is
 * due at once on the next pass, whatever the mtime the half-finished removal left on it.
 */
async function reclaimCompileCaches(root: string, real: string, pass: PassState, report: TmpReclaimReport) {
  const maxAgeMs = pass.cacheAge, limit = pass.limit - report.removed.length;
  if (maxAgeMs === null || limit <= 0) return;
  const cache = join(root, compileCacheName), own = await lstat(cache).catch(() => null), device = await rootDevice(root);
  if (device === undefined || !own?.isDirectory() || own.dev !== device || (pass.uid !== undefined && own.uid !== pass.uid)) return;
  const stale: { path: string; mtime: number }[] = [];
  let held: Set<string> | null = null;
  for (const entry of await readdir(cache, { withFileTypes: true }).catch(() => [] as Dirent[])) {
    if (!entry.isDirectory()) continue;
    const path = join(cache, entry.name);
    let info;
    try { info = await lstat(path); } catch { continue; }
    // Another user's version is theirs; one on another device is another volume's.
    if ((pass.uid !== undefined && info.uid !== pass.uid) || info.dev !== device) continue;
    report.scanned++;
    // A version's own mtime is its newest file's creation; a cache file rewritten in place moves only its own, so the tree decides.
    // One an earlier pass began removing is due at once: its half-finished removal is what made it look young.
    const written = pass.unfinished.has(path) ? 0 : pass.now - info.mtimeMs < maxAgeMs ? info.mtimeMs : await treeLastWritten(path, info.mtimeMs);
    if (pass.now - written < maxAgeMs) { report.kept++; continue; }
    if (!held) { const all = pass.held ??= await heldOpenPaths(); held = new Set([...heldEntries(join(real, compileCacheName), all), ...(root === real ? [] : heldEntries(cache, all))]); }
    if (held.has(join(real, compileCacheName, entry.name)) || held.has(path)) { report.kept++; continue; }
    stale.push({ path, mtime: written });
  }
  stale.sort((first, second) => first.mtime - second.mtime);
  report.kept += Math.max(0, stale.length - limit);
  for (const { path } of stale.slice(0, limit)) {
    const at = Date.now();
    pass.started ??= at;
    if (at > pass.started + pass.workMs) break;
    // A version a mount reaches into is read to the end before it goes whole: one it does stays, counted as kept.
    if (!await treeOnDevice(path, device, pass.mounts)) { report.kept++; continue; }
    try {
      const bytes = await sizeOf(path);
      await removeTree(path, pass.retryMs, pass.uid);
      pass.unfinished.delete(path);
      took(report, 'compileCache', path, bytes);
    } catch (error) { pass.unfinished.add(path); report.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
}

/**
 * One root's agent runtime scratch roots, aged entry by entry (GY-1655): each entry directly inside
 * `<root>/<runtime root>` that this user owns, whose newest write in its tree is older than the
 * agent scratch bound and that no live process holds or names, oldest first, within what the pass's
 * entry and work bounds have left. The runtime root itself is never removed: a live session writes
 * its next packet there. Below headroom (`pass.cap` set, GY-1683) the root is also capped: this
 * user's entries are ranked by their newest tree write, the cap's newest are kept, and the rest are
 * due whatever their age — still never one a live process holds or names, which is kept and counted.
 * Every due entry is ranked before the pass's entry bound applies: the bound takes the oldest of
 * them all, never the first in directory order, and counts the rest as kept for the next pass.
 * The runtime root, each entry and everything under it must be on the scanned root's own volume: a
 * filesystem mounted there is not this root's inodes, is never ranked against the cap and never goes.
 */
async function reclaimRuntimeScratch(root: string, real: string, pass: PassState, report: TmpReclaimReport) {
  const maxAgeMs = pass.agentAge;
  if (maxAgeMs === null) return;
  const device = await rootDevice(root);
  if (device === undefined) return;
  for (const name of pass.runtimeRoots) {
    const limit = pass.limit - report.removed.length;
    if (limit <= 0) return;
    const scratch = join(root, name), own = await lstat(scratch).catch(() => null);
    if (!own?.isDirectory() || own.dev !== device || (pass.uid !== undefined && own.uid !== pass.uid)) continue;
    const entries: { path: string; mtime: number; directory: boolean }[] = [];
    for (const entry of await readdir(scratch, { withFileTypes: true }).catch(() => [] as Dirent[])) {
      if (!entry.isDirectory() && !entry.isFile()) continue;
      const path = join(scratch, entry.name);
      let info;
      try { info = await lstat(path); } catch { continue; }
      // Another user's entry is theirs; one on another device is another volume's, and neither counts against the cap.
      if ((pass.uid !== undefined && info.uid !== pass.uid) || info.dev !== device) continue;
      entries.push({ path, mtime: info.mtimeMs, directory: entry.isDirectory() });
    }
    // An entry an earlier pass began removing is due at once: its half-finished removal is what made it look young.
    const written = async (entry: (typeof entries)[number]) => {
      if (pass.unfinished.has(entry.path)) return 0;
      if (!entry.directory) return entry.mtime;
      let time = pass.written.get(entry.path);
      if (time === undefined) pass.written.set(entry.path, time = await treeLastWritten(entry.path, entry.mtime));
      return time;
    };
    // The cap ranks every entry by its tree, read once per pass: a worktree edited deep inside has an old top-level mtime and is among the newest.
    const due = new Set<string>();
    if (pass.cap !== null) {
      const ranked = await Promise.all(entries.map(async entry => ({ path: entry.path, written: await written(entry) })));
      for (const entry of ranked.sort((first, second) => second.written - first.written).slice(pass.cap)) due.add(entry.path);
    }
    const old: { path: string; mtime: number }[] = [];
    let held: Set<string> | null = null;
    for (const entry of entries) {
      const { path } = entry;
      report.scanned++;
      const capped = due.has(path);
      // A young top-level mtime keeps an entry on one stat, unless the cap or an unfinished removal makes it due.
      if (!capped && !pass.unfinished.has(path) && pass.now - entry.mtime < maxAgeMs) { report.kept++; continue; }
      if (!held) { const all = pass.held ??= await heldOpenPaths(); held = new Set([...heldEntries(join(real, name), all), ...(root === real ? [] : heldEntries(scratch, all))]); }
      if (held.has(join(real, name, path.slice(scratch.length + 1))) || held.has(path)) { report.kept++; continue; }
      const time = await written(entry);
      if (!capped && pass.now - time < maxAgeMs) { report.kept++; continue; }
      old.push({ path, mtime: time });
    }
    old.sort((first, second) => first.mtime - second.mtime);
    report.kept += Math.max(0, old.length - limit);
    for (const { path } of old.slice(0, limit)) {
      const at = Date.now();
      pass.started ??= at;
      if (at > pass.started + pass.workMs) { report.kept++; continue; }
      // An entry a mount reaches into is read to the end before it goes whole: one it does stays, counted as kept.
      if (!await treeOnDevice(path, device, pass.mounts)) { report.kept++; continue; }
      try {
        const bytes = await sizeOf(path);
        await removeTree(path, pass.retryMs, pass.uid);
        pass.unfinished.delete(path); pass.written.delete(path);
        took(report, 'runtimeScratch', path, bytes);
      } catch (error) { pass.unfinished.add(path); report.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
}

/** One line for the loop's reclaim record and `master status`: what a pass gave back. */
export function describeTmpReclaim(removed: number, bytes: number) {
  if (!removed) return null;
  const gb = bytes / 1e9;
  return `freed ${gb >= 0.1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`} from ${removed} stale /tmp entr${removed === 1 ? 'y' : 'ies'}`;
}
