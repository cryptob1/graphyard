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

import { existsSync, readFileSync, type Dirent } from 'node:fs';
import { lstat, opendir, readdir, readFile, readlink, realpath, rm, stat, statfs, writeFile } from 'node:fs/promises';
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
 * How long an agent scratch entry must have gone unwritten before the pass removes it: a session
 * can leave its checkout idle for hours between commands, where a test run's temp lives minutes.
 * A directory's age is its newest write anywhere in its tree, and for a linked git worktree its
 * gitdir's too, so a checkout an agent still edits or commits in is never stale.
 */
export const agentScratchMinAgeMs = 24 * 3_600_000;
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
const retryable = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM', 'EMFILE', 'ENFILE']), unfinishedRemovals = new Set<string>();
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
  /** Directories kept: a live owner, an open holder, or past the per-pass bound. */
  kept: number;
  /**
   * Why each kept test temp name was kept (GY-1628), summing to `kept` less what the tsx cache's
   * bound left: younger than its age bound, held open or named by a live process, a live owner's,
   * or past the pass's entry or work bounds. With steps run, the last step's, as `kept` is.
   */
  keptFor?: TmpKeptFor;
  /** This user's tsx cache files the last sweep left, by why: younger than the cache age it applied, or held open by a live process. */
  cacheKept?: { young: number; held: number };
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
/** The reasons a pass kept test temp names, counted per entry (GY-1628). */
export interface TmpKeptFor { young: number; held: number; owner: number; bound: number }
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
  /** The live-holder set, when the caller has one; a fresh /proc scan runs when omitted. */
  held?: Set<string>;
  /** Entries an earlier pass failed to finish removing, retried ahead of their age bound (this process's own set by default), and how long one removal retries. */
  unfinished?: Set<string>; retryMs?: number;
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
  const report: TmpReclaimReport = { at: new Date(now).toISOString(), roots: roots.map(root => root.path), scanned: 0, removed: [], bytes: 0, kept: 0, ...keptCounters(), errors: [] };
  const minAge = options.prefixes
    ? (name: string) => options.prefixes!.some(prefix => name.startsWith(prefix)) ? options.maxAgeMs ?? tmpReclaimMinAgeMs : null
    : (name: string) => { const age = defaultMinAge(name); return age === null ? null : options.maxAgeMs ?? age; };
  // The bounds are the pass's, not each root's: a second root never doubles a cycle's work. The
  // work bound is real elapsed time, not the caller's clock: a mocked `now` must not change how
  // long a cycle spends taking directories back. It bounds removing only, so its clock starts at the
  // pass's first removal: scanning a backlogged /tmp and /proc never spends it before anything goes.
  // A caller's own prefixes never sweep the tsx cache; the default pass ages its files by the cache's bound.
  const cacheAge = options.prefixes ? null : options.maxAgeMs ?? tmpReclaimMinAgeMs;
  const pass: PassState = { now, minAge, cacheAge, limit: options.limit ?? tmpReclaimLimitPerCycle, uid: process.getuid?.(), held: options.held ?? null,
    workMs: options.workMs ?? Number.POSITIVE_INFINITY, started: null, unfinished: options.unfinished ?? unfinishedRemovals, retryMs: options.retryMs ?? tmpReclaimRetryMs };
  for (const path of pass.unfinished) if (!existsSync(path)) pass.unfinished.delete(path);
  const sweep = async (scanned = roots) => {
    for (const { path, real } of scanned) {
      await reclaimRoot(path, real, pass, report);
      await reclaimTsxCaches(path, real, pass, report);
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
    Object.assign(pass, { limit: Math.max(before, step.limit), cacheAge: Math.min(cacheAge ?? step.cacheAgeMs, step.cacheAgeMs), workMs: step.workMs });
    Object.assign(report, { scanned: 0, kept: 0, ...keptCounters() });
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

/** Fresh kept-by-reason counters, for a pass and for each step's sweep. */
const keptCounters = () => ({ keptFor: { young: 0, held: 0, owner: 0, bound: 0 }, cacheKept: { young: 0, held: 0 } });
/** Count one kept test temp name under `reason`, and in `kept`. */
const keep = (report: TmpReclaimReport, reason: keyof TmpKeptFor, count = 1) => { report.kept += count; if (report.keptFor) report.keptFor[reason] += count; };

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

interface PassState { now: number; minAge: (name: string) => number | null; cacheAge: number | null; limit: number; uid: number | undefined; held: Set<string> | null; workMs: number; started: number | null; unfinished: Set<string>; retryMs: number }
/** Remove `path` recursively, retrying while its tree refills or is still being released, for at most `retryMs`. */
async function removeTree(path: string, retryMs: number) {
  const until = Date.now() + retryMs;
  for (;;) {
    try { return await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }); } catch (error) {
      if (!retryable.has((error as NodeJS.ErrnoException).code ?? '') || Date.now() >= until) throw error;
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
  const removable: { path: string; mtime: number }[] = [];
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
    if (!candidate(entry)) continue;
    let info;
    try { info = await lstat(path); } catch { continue; }
    // Another user's entry is theirs to clear: on a sticky /tmp it could not be removed anyway.
    if (uid !== undefined && info.uid !== uid) continue;
    report.scanned++;
    const owner = entry.isDirectory() ? await readTempOwner(path) : null;
    const gone = owner ? tempOwnerGone(owner) : false;
    // A live owner keeps its directory only when its start could be recorded: without it a recycled
    // pid would pass for the dead run's owner for as long as it lives, so such a directory is judged
    // as an ownerless one is — by its age and its live holders.
    if (owner && !gone && owner.startedAt !== null) { keep(report, 'owner'); continue; }
    if (owner && gone) { removable.push({ path, mtime: 0 }); }
    else {
      const maxAgeMs = minAge(entry.name)!;
      // A directory's entries are read only once the directory itself is old: a young one is kept on one stat.
      // An entry an earlier pass began removing is due at once: its half-finished removal is what made it look young (GY-1401).
      let written = pass.unfinished.has(path) ? 0 : now - info.mtimeMs < maxAgeMs || !entry.isDirectory() ? info.mtimeMs : await lastWritten(path, info.mtimeMs);
      if (now - written < maxAgeMs) { keep(report, 'young'); continue; }
      // Only holders under the scanned root can hold a candidate, and on a host with a backlog the
      // raw scan holds thousands of paths elsewhere: reduce it once to the root's entries, then
      // every check is a single lookup.
      // /proc names a holder by its resolved path, so a root reached through a symlink is matched by its realpath.
      // A command line names the path as it was typed, so a root's own spelling is matched as well.
      if (!held) { const all = pass.held ??= await heldOpenPaths(); held = new Set([...heldEntries(real, all), ...(root === real ? [] : heldEntries(root, all))]); }
      if (held.has(join(real, entry.name)) || held.has(join(root, entry.name))) { keep(report, 'held'); continue; }
      // An agent's scratch checkout is judged by its whole tree, read last: only an old, unheld one is walked.
      if (written && entry.isDirectory() && agentScratchPatterns.some(pattern => pattern.test(entry.name))) {
        written = await treeLastWritten(path, written);
        if (now - written < maxAgeMs) { keep(report, 'young'); continue; }
      }
      removable.push({ path, mtime: written });
    }
    // The scan is bounded with the removals: once this pass cannot remove more, another 10,000
    // candidates are the next pass's work, not this cycle's. Order in the directory otherwise.
    if (removable.length >= limit) break;
  }
  // The candidates the bound left unexamined are the next pass's: they are counted as kept, from
  // the dirent list already in hand, so the report still accounts for every candidate exactly once.
  keep(report, 'bound', Math.max(0, dirents.reduce((total, entry) => total + (candidate(entry) ? 1 : 0), 0) - (report.scanned - scannedBefore)));
  removable.sort((first, second) => first.mtime - second.mtime);
  const removedBefore = report.removed.length;
  for (const { path } of removable.slice(0, limit)) {
    const at = Date.now();
    pass.started ??= at;
    if (at > pass.started + pass.workMs) break;
    try {
      const bytes = await sizeOf(path);
      const registration = await worktreeRegistration(path);
      await removeTree(path, pass.retryMs);
      if (registration) await rm(registration, { recursive: true, force: true });
      await rm(tempOwnerMarker(path), { force: true });
      pass.unfinished.delete(path);
      report.removed.push({ path, bytes });
      report.bytes += bytes;
    } catch (error) { pass.unfinished.add(path); report.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  keep(report, 'bound', Math.max(0, removable.length - (report.removed.length - removedBefore)));
}

/** The name of this user's tsx compile cache directory in a temporary directory, or null where there are no uids. */
export const tsxCacheName = (uid = process.getuid?.()) => uid === undefined ? null : `tsx-${uid}`;
/** The regular files under `directory`, recursively, following no symlink: what a cache sweep may take. */
async function cacheFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [] as Dirent[]);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile()) files.push(path);
    else if (entry.isDirectory()) files.push(...await cacheFiles(path));
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
  const limit = pass.limit - report.removed.length, maxAgeMs = pass.cacheAge;
  if (maxAgeMs === null || limit <= 0) return;
  const names = (await readdir(root).catch(() => [] as string[])).filter(name => tsxCachePattern.test(name)).sort();
  const old: { path: string; mtime: number; bytes: number }[] = [];
  for (const name of names) {
    const own = await lstat(join(root, name)).catch(() => null);
    if (!own?.isDirectory() || (pass.uid !== undefined && own.uid !== pass.uid)) continue;
    for (const path of await cacheFiles(join(root, name))) {
      let info;
      try { info = await lstat(path); } catch { continue; }
      if (!info.isFile() || (pass.uid !== undefined && info.uid !== pass.uid)) continue;
      if (pass.now - info.mtimeMs < maxAgeMs) { if (report.cacheKept) report.cacheKept.young++; continue; }
      old.push({ path, mtime: info.mtimeMs, bytes: info.size });
    }
  }
  if (!old.length) return;
  const held = pass.held ??= await heldOpenPaths();
  // /proc names a holder by its resolved path, so a root reached through a symlink is matched by its realpath.
  const removable = old.filter(file => !held.has(join(real, file.path.slice(root.length + 1)))).sort((first, second) => first.mtime - second.mtime);
  if (report.cacheKept) report.cacheKept.held += old.length - removable.length;
  report.kept += Math.max(0, removable.length - limit);
  for (const { path, bytes } of removable.slice(0, limit)) {
    const at = Date.now();
    pass.started ??= at;
    if (at > pass.started + pass.workMs) break;
    try {
      await rm(path, { force: true });
      report.removed.push({ path, bytes });
      report.bytes += bytes;
    } catch (error) { report.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
}

/** One line for the loop's reclaim record and `master status`: what a pass gave back. */
export function describeTmpReclaim(removed: number, bytes: number) {
  if (!removed) return null;
  const gb = bytes / 1e9;
  return `freed ${gb >= 0.1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`} from ${removed} stale /tmp entr${removed === 1 ? 'y' : 'ies'}`;
}
