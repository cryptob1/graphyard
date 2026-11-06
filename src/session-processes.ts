import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { argumentPath } from './tmp-reclaim.js';

// What a finished session leaves running (GY-3185): a browser its agent started inside the
// runtime's sandbox was reparented away from the session and outlived the pane and the worktree, at
// 1.3 cores for 37 hours. A session's processes are found by what they name, not by their parent.

export interface StopOptions { procRoot?: string; graceMs?: number }
interface HostProcess { pid: number; ppid: number; identity: string; name: string; state: string; terminal: boolean; startedSeconds: number; paths: string[] }

const attempt = <T>(read: () => T[]): T[] => { try { return read(); } catch { return []; } };

function parseStat(pid: number, stat: string): Omit<HostProcess, 'paths'> | null {
  const open = stat.indexOf('('), close = stat.lastIndexOf(') ');
  if (open < 0 || close < 0) return null;
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  return { pid, name: stat.slice(open + 1, close), state: fields[0], ppid: Number(fields[1]), terminal: fields[4] !== '0', identity: fields[19], startedSeconds: Number(fields[19]) / 100 };
}

/**
 * Every live process with the paths it names: its working directory, the path-valued arguments of
 * its command line, and its mount points, which is where a sandbox's bind mounts show. A path merely
 * mentioned inside a longer argument does not count: a live session's prompt names worktrees.
 */
function hostProcesses(procRoot: string): HostProcess[] {
  return attempt(() => readdirSync(procRoot)).flatMap(name => {
    if (!/^\d+$/.test(name)) return [];
    const base = join(procRoot, name);
    const [found] = attempt(() => [parseStat(Number(name), readFileSync(join(base, 'stat'), 'utf8'))]);
    if (!found || found.state === 'Z') return [];
    return [{ ...found, paths: [
      ...attempt(() => [readlinkSync(join(base, 'cwd')).replace(/ \(deleted\)$/, '')]),
      ...attempt(() => readFileSync(join(base, 'cmdline'), 'utf8').split('\0').flatMap(argument => argumentPath(argument) ?? [])),
      ...attempt(() => readFileSync(join(base, 'mountinfo'), 'utf8').split('\n').flatMap(line => line.split(' ')[4] ?? [])),
    ] }];
  });
}

/** SIGTERM, then SIGKILL after the grace, to `targets` and all their descendants; never this process or its ancestors. Answers what was signalled. */
async function stopTrees(targets: HostProcess[], all: HostProcess[], { procRoot = '/proc', graceMs = 3_000 }: StopOptions): Promise<string[]> {
  const byPid = new Map(all.map(row => [row.pid, row])), own = new Set<number>();
  for (let pid: number | undefined = process.pid; pid; pid = byPid.get(pid)?.ppid) own.add(pid);
  const stopping = new Map(targets.filter(row => !own.has(row.pid)).map(row => [row.pid, row]));
  for (const parent of stopping.values()) for (const row of all) if (row.ppid === parent.pid && !own.has(row.pid)) stopping.set(row.pid, row);
  // The start time tells a process from a later one that took its pid while the grace ran.
  const alive = ({ pid, identity }: HostProcess) => attempt(() => [parseStat(pid, readFileSync(join(procRoot, String(pid), 'stat'), 'utf8'))]).some(now => now?.identity === identity && now.state !== 'Z');
  const signal = (name: NodeJS.Signals) => { for (const row of stopping.values()) if (alive(row)) try { process.kill(row.pid, name); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') stopping.delete(row.pid); } };
  const settled = async (ms: number) => { for (const end = Date.now() + ms; Date.now() < end && [...stopping.values()].some(alive);) await delay(50); };
  signal('SIGTERM');
  await settled(graceMs);
  signal('SIGKILL');
  await settled(1_000);
  return [...stopping.values()].map(row => `${row.name} (${row.pid})`);
}

const spellings = (path: string) => [...new Set([resolve(path), ...attempt(() => [realpathSync(path)])])];

/** Stop every process naming `directory` or a path inside it, with its children, before the directory is reclaimed. */
export function stopProcessesUnder(directory: string, options: StopOptions = {}): Promise<string[]> {
  const names = spellings(directory), all = hostProcesses(options.procRoot ?? '/proc');
  return stopTrees(all.filter(row => row.paths.some(path => names.some(name => path === name || path.startsWith(`${name}/`)))), all, options);
}

/** `path` lies in an entry of `root` that no longer exists. */
const inRemovedEntry = (path: string, root: string) => path.startsWith(`${root}/`) && !existsSync(join(root, path.slice(root.length + 1).split('/')[0]));

/**
 * The sweep, for what no reclaim stopped: every process naming a directory under `roots` that is
 * gone. A process still on a terminal is left to its pane: it may be a master or an operator shell,
 * and the loop's close step owns panes. One younger than `minAgeMs` may be creating that directory.
 */
export function stopOrphansOfRemovedWorktrees(roots: string[], { minAgeMs = 60_000, ...options }: StopOptions & { minAgeMs?: number } = {}): Promise<string[]> {
  const procRoot = options.procRoot ?? '/proc', names = roots.flatMap(spellings), all = hostProcesses(procRoot);
  const [uptime] = attempt(() => [Number.parseFloat(readFileSync(join(procRoot, 'uptime'), 'utf8'))]);
  return stopTrees(all.filter(row => !row.terminal && (uptime ?? 0) - row.startedSeconds >= minAgeMs / 1000
    && row.paths.some(path => names.some(root => inRemovedEntry(path, root)))), all, options);
}
