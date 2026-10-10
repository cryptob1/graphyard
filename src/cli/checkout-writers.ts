// Concern: the coordinator checkout's standing writers (GY-1658) — finding the processes working in it and freezing them, fail-closed, for `master checkout-restore`.
import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * The standing processes working in the checkout at `root` — a process whose working directory is
 * the checkout or inside it, outside the managed `.graphyard` area whose sessions see the checkout
 * read-only — and their descendants outside that area: the suspected writers the dirty-checkout
 * escalation names. This process and its ancestors are never among them. Read from Linux /proc; where
 * the process table cannot be enumerated (another OS, a restricted mount) it throws, never reporting an
 * unverifiable scan as no writers (GY-1658 review). The kernel reports each working directory by its
 * physical path, so the checkout is compared by its canonical path too: a checkout reached through a
 * symlinked ancestor is the same checkout, and one whose canonical path cannot be read throws.
 * A live process of this user whose working directory cannot be read (a non-dumpable one, say) is
 * unverifiable, never absent (GY-1663): it throws, naming the pid and the read error, before anything
 * is stopped or touched — unless it is provably outside the checkout: this process or an ancestor, or
 * one of the loop's managed sessions (a `graphyard-watch-…` scope, which sees the checkout read-only).
 */
export function checkoutWriterProcesses(root: string, self = process.pid, proc = '/proc', uid = process.getuid?.() ?? null): number[] {
  const { writers, unverifiable } = checkoutProcessScan(root, self, proc, uid);
  if (unverifiable.length) throw new Error(`the working directory of ${unverifiable.slice(0, 8).map(entry => `pid ${entry.pid} (${entry.error})`).join(', ')} cannot be read, so whether it writes in the checkout cannot be verified and nothing was restored`);
  return writers;
}
/** A process of this user whose working directory could not be read, with the read error. */
export interface UnverifiableProcess { pid: number; error: string }
/** The loop's managed sessions run in `graphyard-watch-…` scopes (src/supervisor.ts). */
const managedScope = /\/graphyard-watch-[A-Za-z0-9:@._-]+\.scope(?:\/|$)/m;
/**
 * checkoutWriterProcesses's scan: the writers it finds, and the processes of this user (`uid`; null
 * when the platform has none, so every owner counts) whose working directory could not be read and
 * which are not provably outside the checkout.
 */
export function checkoutProcessScan(root: string, self = process.pid, proc = '/proc', uid = process.getuid?.() ?? null): { writers: number[]; unverifiable: UnverifiableProcess[] } {
  let base: string;
  try { base = realpathSync(resolve(root)); }
  catch (error) { throw new Error(`the checkout's canonical path cannot be read (${error instanceof Error ? error.message : String(error)}), so its writers cannot be found and nothing was restored`); }
  const managed = `${base}${sep}.graphyard`;
  const table = new Map<number, { ppid: number; cwd: string | null; error: string | null }>();
  let entries: string[];
  try { entries = readdirSync(proc).filter(name => /^\d+$/.test(name)); }
  catch (error) { throw new Error(`the processes working in the checkout cannot be enumerated from ${proc} (${error instanceof Error ? error.message : String(error)}), so nothing was restored`); }
  if (!entries.length) throw new Error(`the processes working in the checkout cannot be enumerated: ${proc} lists no process, so nothing was restored`);
  for (const name of entries) {
    try {
      const stat = readFileSync(join(proc, name, 'stat'), 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      let cwd: string | null = null, error: string | null = null;
      try { cwd = readlinkSync(join(proc, name, 'cwd')); }
      catch (failure) {
        // Another user's is not ours to judge; one gone or a zombie writes nothing.
        const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
        let owner: number | null = null; try { owner = statSync(join(proc, name)).uid; } catch { /* gone */ }
        if (owner !== null && (uid === null || owner === uid) && state !== 'Z' && state !== 'X') error = failure instanceof Error ? failure.message : String(failure);
      }
      table.set(Number(name), { ppid, cwd, error });
    } catch { /* exited while read */ }
  }
  const spared = new Set<number>();
  for (let pid = self; pid > 1 && !spared.has(pid); pid = table.get(pid)?.ppid ?? 0) spared.add(pid);
  const working = (cwd: string | null) => !!cwd && (cwd === base || cwd.startsWith(`${base}${sep}`)) && cwd !== managed && !cwd.startsWith(`${managed}${sep}`);
  const unmanaged = (cwd: string | null) => !cwd || (cwd !== managed && !cwd.startsWith(`${managed}${sep}`));
  const writers = new Set([...table].filter(([pid, entry]) => !spared.has(pid) && working(entry.cwd)).map(([pid]) => pid));
  for (let grown = true; grown;) {
    grown = false;
    for (const [pid, entry] of table) if (!writers.has(pid) && !spared.has(pid) && writers.has(entry.ppid) && unmanaged(entry.cwd)) { writers.add(pid); grown = true; }
  }
  const outside = (pid: number) => { try { return managedScope.test(readFileSync(join(proc, String(pid), 'cgroup'), 'utf8')); } catch { return false; } };
  const unverifiable = [...table].filter(([pid, entry]) => entry.error !== null && !spared.has(pid) && !outside(pid)).map(([pid, entry]) => ({ pid, error: entry.error! })).sort((a, b) => a.pid - b.pid);
  return { writers: [...writers].sort((a, b) => a - b), unverifiable };
}
/** A process's state letter from /proc (R, S, D, T, t, Z, …), or null when it is gone. */
export function processStateOf(pid: number, proc = '/proc'): string | null {
  try { const stat = readFileSync(join(proc, String(pid), 'stat'), 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) || null; } catch { return null; }
}
const gone = (state: string | null) => state === null || state === 'Z' || state === 'X';
const stoppedState = (state: string | null) => state === 'T' || state === 't';
export interface WriterFreezeDeps {
  signal?: (pid: number, name: NodeJS.Signals) => void;
  /** The process's state letter, null when it is gone (processStateOf). */
  state?: (pid: number) => string | null;
  /** The checkout's standing writers (checkoutWriterProcesses). */
  scan?: (root: string) => number[];
  /** How long a stopped writer may take to show stopped, and how often it is read. */
  settleMs?: number; pollMs?: number;
}
/**
 * Stop the checkout's standing writers (SIGSTOP), verify each one stopped, and return what continues
 * them (SIGCONT): they keep every byte of their state, and none of them can write between the
 * snapshot and the reset. The freeze fails closed (GY-1658 review): a writer that cannot be
 * signalled, or does not show stopped within `settleMs`, throws before anything is touched, with
 * every process this attempt stopped continued again. The writers are read again after each round, so
 * one forked during the freeze is stopped too. A writer already stopped (by job control or a
 * debugger) is quiescent as it stands: it is neither signalled nor continued after.
 */
export async function freezeCheckoutWriters(root: string, deps: WriterFreezeDeps = {}): Promise<{ pids: number[]; stopped: number[]; thaw: () => void }> {
  const signal = deps.signal ?? ((pid, name) => process.kill(pid, name)), state = deps.state ?? (pid => processStateOf(pid)), scan = deps.scan ?? (directory => checkoutWriterProcesses(directory));
  const settleMs = deps.settleMs ?? 5_000, pollMs = deps.pollMs ?? 20;
  const stopped: number[] = [], quiet = new Set<number>(), seen = new Set<number>();
  const thaw = () => { for (const pid of stopped) { try { signal(pid, 'SIGCONT'); } catch { /* gone */ } } };
  try {
    for (let round = 0; ; round++) {
      const fresh = scan(root).filter(pid => !seen.has(pid));
      if (!fresh.length) break;
      if (round >= 8) throw new Error(`the checkout's writers could not be frozen: new processes kept starting in it (${fresh.slice(0, 8).join(', ')})`);
      const signalled: number[] = [];
      for (const pid of fresh) {
        seen.add(pid);
        const before = state(pid);
        if (gone(before)) continue;
        if (stoppedState(before)) { quiet.add(pid); continue; }
        try { signal(pid, 'SIGSTOP'); }
        catch (error) {
          if (gone(state(pid))) continue;
          throw new Error(`the checkout's writer pid ${pid} could not be stopped (${error instanceof Error ? error.message : String(error)}), so nothing was restored`);
        }
        stopped.push(pid); signalled.push(pid);
      }
      for (const deadline = Date.now() + settleMs; ;) {
        const running = signalled.filter(pid => !gone(state(pid)) && !stoppedState(state(pid)));
        if (!running.length) break;
        if (Date.now() >= deadline) throw new Error(`the checkout's writer(s) ${running.join(', ')} did not stop within ${settleMs}ms of SIGSTOP, so nothing was restored`);
        await delay(pollMs);
      }
      for (const pid of signalled) quiet.add(pid);
    }
  } catch (error) { thaw(); throw error; }
  return { pids: [...quiet].sort((a, b) => a - b), stopped, thaw };
}
