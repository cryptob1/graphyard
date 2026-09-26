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
import { readdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** How old an ownerless directory must be before the pass removes it. */
export const tmpReclaimMinAgeMs = 6 * 3_600_000;
/** The most directories one pass removes: reclaim is bounded per cycle, whatever the backlog. */
export const tmpReclaimLimitPerCycle = 100;
/** The most wall-clock time one pass spends removing, so a cycle is never stalled by a backlog of large directories. */
export const tmpReclaimWorkMsPerCycle = 150;
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
 * and each of its file descriptors — read from /proc. A directory one of these paths lies inside
 * is in use whatever its marker says: an ownerless Postgres data dir with a surviving postmaster
 * is not waste. On a host without /proc the set is empty and age alone decides.
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
  }));
  return held;
}
const isHeld = (directory: string, held: Set<string>) => {
  for (const path of held) if (path === directory || path.startsWith(`${directory}/`)) return true;
  return false;
};

/** Recursively sum the sizes of the regular files under `path`, following no symlink. */
async function sizeOf(path: string): Promise<number> {
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

export interface TmpReclaimReport {
  at: string;
  scanned: number;
  /** What the pass removed, oldest first, and the bytes that came back with them. */
  removed: { path: string; bytes: number }[];
  bytes: number;
  /** Directories kept: a live owner, an open holder, or past the per-pass bound. */
  kept: number;
  errors: string[];
}
export interface TmpReclaimOptions {
  now?: number;
  /** The directory scanned; the host's temporary directory by default. */
  tmpRoot?: string;
  /** Entry-name prefixes considered; the default is Graphyard's own directories and the tsx cache. */
  prefixes?: readonly string[];
  /** The most directories one pass removes; `tmpReclaimLimitPerCycle` by default. */
  limit?: number;
  /** How old an ownerless, unheld directory must be; `tmpReclaimMinAgeMs` by default. */
  maxAgeMs?: number;
  /** The most wall-clock time the pass spends removing, when set; the loop passes `tmpReclaimWorkMsPerCycle`. */
  workMs?: number;
  /** The live-holder set, when the caller has one; a fresh /proc scan runs when omitted. */
  held?: Set<string>;
}
const defaultCandidate = (name: string) => name.startsWith('graphyard-') || /^tsx-\d+$/.test(name);

/**
 * One bounded pass over the host's temporary directory. A marked directory whose owner still runs
 * is kept whatever its age; one whose owner has exited is removed at once, however young — that is
 * the test runner's sweep of a run that just ended; an unmarked directory is removed only once it
 * is older than `maxAgeMs` and no live process holds it open. The oldest removable directories go
 * first, at most `limit` of them, and every removal is reported with the bytes it freed. Nothing
 * here throws for a directory it cannot read: the error is reported instead.
 */
export async function reclaimTmpDirectories(options: TmpReclaimOptions = {}): Promise<TmpReclaimReport> {
  const now = options.now ?? Date.now(), root = options.tmpRoot ?? tmpdir(), limit = options.limit ?? tmpReclaimLimitPerCycle;
  const maxAgeMs = options.maxAgeMs ?? tmpReclaimMinAgeMs;
  const report: TmpReclaimReport = { at: new Date(now).toISOString(), scanned: 0, removed: [], bytes: 0, kept: 0, errors: [] };
  const match = options.prefixes ? (name: string) => options.prefixes!.some(prefix => name.startsWith(prefix)) : defaultCandidate;
  const dirents = await readdir(root, { withFileTypes: true }).catch(() => [] as Dirent[]);
  const removable: { path: string; mtime: number }[] = [];
  let held: Set<string> | null = options.held ?? null;
  for (const entry of dirents) {
    const path = join(root, entry.name);
    // A marker whose directory is already gone is clutter: take it back, whatever the bound.
    if (entry.name.startsWith('graphyard-') && entry.name.endsWith('.owner') && !existsSync(path.slice(0, -'.owner'.length))) {
      try { await rm(path, { force: true }); } catch { /* the next pass tries again */ }
      continue;
    }
    if (!match(entry.name) || !entry.isDirectory()) continue;
    report.scanned++;
    const owner = await readTempOwner(path);
    if (owner && !tempOwnerGone(owner)) { report.kept++; continue; }
    if (owner) { removable.push({ path, mtime: 0 }); }
    else {
      let info;
      try { info = await stat(path); } catch { continue; }
      if (now - info.mtimeMs < maxAgeMs) { report.kept++; continue; }
      // Only holders under the scanned root can hold a candidate, and on a host with a backlog the
      // raw scan holds thousands of paths elsewhere: reduce it once, then every check is local.
      if (!held) {
        const open = await heldOpenPaths();
        held = new Set([...open].filter(target => target === root || target.startsWith(`${root}/`)));
      }
      if (isHeld(path, held)) { report.kept++; continue; }
      removable.push({ path, mtime: info.mtimeMs });
    }
    // The scan is bounded with the removals: once this pass cannot remove more, another 10,000
    // candidates are the next pass's work, not this cycle's. Order in the directory otherwise.
    if (removable.length >= limit) break;
  }
  // The candidates the bound left unexamined are the next pass's: they are counted as kept, from
  // the dirent list already in hand, so the report still accounts for every candidate exactly once.
  report.kept += Math.max(0, dirents.reduce((total, entry) => total + (match(entry.name) && entry.isDirectory() ? 1 : 0), 0) - report.scanned);
  removable.sort((first, second) => first.mtime - second.mtime);
  // The work bound is real elapsed time, not the caller's clock: a mocked `now` must not change
  // how long a cycle spends taking directories back.
  const deadline = options.workMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + options.workMs;
  for (const { path } of removable.slice(0, limit)) {
    if (Date.now() > deadline) break;
    try {
      const bytes = await sizeOf(path);
      await rm(path, { recursive: true, force: true });
      await rm(tempOwnerMarker(path), { force: true });
      report.removed.push({ path, bytes });
      report.bytes += bytes;
    } catch (error) { report.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  report.kept += Math.max(0, removable.length - report.removed.length);
  return report;
}

/** One line for the loop's reclaim record and `master status`: what a pass gave back. */
export function describeTmpReclaim(removed: number, bytes: number) {
  if (!removed) return null;
  const gb = bytes / 1e9;
  return `freed ${gb >= 0.1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`} from ${removed} stale /tmp director${removed === 1 ? 'y' : 'ies'}`;
}
