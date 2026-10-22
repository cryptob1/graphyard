// Concern: the owner marker on a temporary directory (GY-421), which the merge writer's preview
// and trial write on their own checkouts and read back to judge whether a leftover one's owner is
// gone. A live owner keeps its directory; a dead owner's directory goes whatever its age; an
// ownerless directory goes once it is older than `tmpReclaimMinAgeMs` and no live process holds it open.

import { existsSync, readFileSync, readlinkSync, type Dirent } from 'node:fs';
import { lstat, readdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** How old an ownerless directory must be before it is removed. */
export const tmpReclaimMinAgeMs = 6 * 3_600_000;
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

/** The owner marker a marked directory carries, as a sibling file. */
export interface TempOwner { pid: number; startedAt: number | null; pidNamespace: string | null; at: string }
/**
 * The PID namespace `procRoot`'s own process runs in (`pid:[4026531836]`, the target of
 * `self/ns/pid`), or null when it cannot be read (not Linux, or a fabricated table without one). A
 * pid means something only in the namespace it was taken in (GY-1370), so a writer records which
 * one its pid names and a reader answers a pid lookup only from the marker's own.
 */
export const processPidNamespace = (procRoot = '/proc'): string | null => {
  try { return readlinkSync(join(procRoot, 'self', 'ns', 'pid')); } catch { return null; }
};
export const readTempOwner = async (directory: string): Promise<TempOwner | null> => {
  const marker = tempOwnerMarker(directory);
  // Most candidates carry no marker at all: a stat beats the read's exception on a scan of thousands.
  if (!existsSync(marker)) return null;
  try {
    const parsed = JSON.parse(await readFile(marker, 'utf8')) as Partial<TempOwner>;
    return typeof parsed?.pid === 'number' ? { ...parsed, startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : null, pidNamespace: typeof parsed.pidNamespace === 'string' ? parsed.pidNamespace : null, at: typeof parsed.at === 'string' ? parsed.at : '' } as TempOwner : null;
  } catch { return null; }
};
/** Mark `directory` as owned by this process, so a later reader knows whose exit frees it. */
export const writeTempOwner = async (directory: string, now = Date.now()): Promise<TempOwner> => {
  const owner: TempOwner = { pid: process.pid, startedAt: processStartTicks(process.pid), pidNamespace: processPidNamespace(), at: new Date(now).toISOString() };
  await writeFile(tempOwnerMarker(directory), `${JSON.stringify(owner)}\n`);
  return owner;
};
/**
 * Whether this reader may judge `owner` by a pid lookup at all: only from the namespace the marker
 * was taken in (GY-1896). A marker from another PID namespace names a pid this reader cannot see or
 * mismatches with one of its own, and one recorded before namespaces were kept could have been
 * written by any sandbox on the host, so neither is judged from this reader's table. A reader that
 * cannot read a namespace (a fabricated /proc) judges only markers that recorded none, the shape
 * every pre-namespace marker has. Without /proc (macOS and the like) there are no namespaces and
 * the signal-0 probe decides.
 */
export const tempOwnerJudgeable = (owner: TempOwner, procRoot = '/proc'): boolean =>
  !existsSync(procRoot) || processPidNamespace(procRoot) === owner.pidNamespace;
/**
 * Whether the process that owns a marked directory is no longer running, pid reuse included. A
 * marker this reader cannot judge by pid — another PID namespace's, GY-1896 — is never reported
 * gone here: its pid is absent from this reader's table whether its writer lives or not. Its
 * directory is judged as an ownerless one is, by age and live holders.
 */
export function tempOwnerGone(owner: TempOwner, procRoot = '/proc'): boolean {
  if (!existsSync(procRoot)) {
    // No /proc (macOS and the like): a signal-0 probe is the check, and EPERM means another user's live process.
    try { process.kill(owner.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  }
  if (!tempOwnerJudgeable(owner, procRoot)) return false;
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
 * The entries directly under `root` that some held path lies in or names: reduced once per sweep, so
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
 * The merge writer's preview sweep judges an unjudgeable marker's checkout tree by it too (GY-1896).
 */
export async function treeLastWritten(path: string, own: number): Promise<number> {
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
