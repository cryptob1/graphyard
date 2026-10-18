// Concern: the coordinator checkout's standing writers (GY-1658) — finding the processes working in it and freezing them, fail-closed, for `master checkout-restore`.
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
 * One whose read is refused EACCES — a non-dumpable process (sd-pam, a password manager, a daemon
 * that dropped privileges) denying this user its /proc links — is recorded as skipped instead (GY-1672):
 * such processes stand permanently on a desktop host, so refusing on them left the restore no way to
 * complete. checkoutWriterScan returns them beside the writers, and the restore names them.
 * A kernel thread (PF_KTHREAD in its stat flags, seen when the scan runs as root) has no cwd and is
 * never a writer. Whatever its state, read again after the failed cwd read — never taken from before
 * it — a process whose own cwd read failed is judged by its live sibling threads (judgeByThreads,
 * GY-1680 review): a thread whose cwd reads inside the checkout makes it a writer, EACCES on the leader
 * or not; a zombie leader (its main thread called pthread_exit) is gone only when no thread lives; and a
 * live leader is skipped only when every read, its own and its live threads', was refused EACCES. One
 * whose state cannot be read either is unverifiable, never dropped, unless /proc/PID is gone with it.
 */
export function checkoutWriterProcesses(root: string, self = process.pid, proc = '/proc', uid = process.getuid?.() ?? null): number[] {
  return checkoutWriterScan(root, self, proc, uid).writers;
}
/** checkoutWriterProcesses with the processes it skipped because their cwd read was refused EACCES. */
export function checkoutWriterScan(root: string, self = process.pid, proc = '/proc', uid = process.getuid?.() ?? null): { writers: number[]; skipped: UnverifiableProcess[] } {
  const { writers, unverifiable, skipped } = checkoutProcessScan(root, self, proc, uid);
  if (unverifiable.length) throw new Error(`the working directory of ${unverifiable.slice(0, 8).map(entry => `pid ${entry.pid} (${entry.error})`).join(', ')} cannot be read, so whether it writes in the checkout cannot be verified and nothing was restored`);
  return { writers, skipped };
}
/** A process of this user whose working directory could not be read, with the read error. */
export interface UnverifiableProcess { pid: number; error: string }
/** The kernel's per-task flag for a kernel thread (include/linux/sched.h), field 9 of /proc/PID/stat: it has no user cwd and writes no checkout. */
const PF_KTHREAD = 0x00200000;
/** The loop's managed sessions run in `graphyard-watch-…` scopes (src/supervisor.ts). */
const managedScope = /\/graphyard-watch-[A-Za-z0-9:@._-]+\.scope(?:\/|$)/m;
/**
 * checkoutWriterProcesses's scan: the writers it finds, and the processes of this user (`uid`; null
 * when the platform has none, so every owner counts) whose working directory could not be read and
 * which are not provably outside the checkout — `skipped` when every read was refused EACCES,
 * `unverifiable` for any other failure, a state that cannot be read included.
 */
export function checkoutProcessScan(root: string, self = process.pid, proc = '/proc', uid = process.getuid?.() ?? null): { writers: number[]; unverifiable: UnverifiableProcess[]; skipped: UnverifiableProcess[] } {
  let base: string;
  try { base = realpathSync(resolve(root)); }
  catch (error) { throw new Error(`the checkout's canonical path cannot be read (${error instanceof Error ? error.message : String(error)}), so its writers cannot be found and nothing was restored`); }
  const managed = `${base}${sep}.graphyard`;
  const working = (cwd: string | null) => !!cwd && (cwd === base || cwd.startsWith(`${base}${sep}`)) && cwd !== managed && !cwd.startsWith(`${managed}${sep}`);
  const table = new Map<number, { ppid: number; cwd: string | null; error: string | null; denied: boolean }>();
  let entries: string[];
  try { entries = readdirSync(proc).filter(name => /^\d+$/.test(name)); }
  catch (error) { throw new Error(`the processes working in the checkout cannot be enumerated from ${proc} (${error instanceof Error ? error.message : String(error)}), so nothing was restored`); }
  if (!entries.length) throw new Error(`the processes working in the checkout cannot be enumerated: ${proc} lists no process, so nothing was restored`);
  for (const name of entries) {
    try {
      const stat = readFileSync(join(proc, name, 'stat'), 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      let cwd: string | null = null, error: string | null = null, denied = false;
      try { cwd = readlinkSync(join(proc, name, 'cwd')); }
      catch (failure) {
        // Another user's is not ours to judge; one gone or a kernel thread writes nothing. Its state is
        // read again after the failed read, never taken from before it: one that exited in between can
        // keep /proc/PID as a zombie, and the earlier live state would misjudge it. Ours, it is judged
        // by its live threads (judgeByThreads); one whose state cannot be read either is unverifiable
        // (GY-1680 review), never dropped as not ours, unless /proc/PID is gone with it.
        let owner: number | null = null; try { owner = statSync(join(proc, name)).uid; } catch { /* gone */ }
        if (owner !== null && (uid === null || owner === uid)) {
          let now: string | null = null; try { now = readFileSync(join(proc, name, 'stat'), 'utf8'); } catch { /* gone, or its state unreadable */ }
          const reason = failure instanceof Error ? failure.message : String(failure);
          if (now === null) { if (existsSync(join(proc, name))) error = `${reason}; its state cannot be read either`; }
          else {
            const fields = now.slice(now.lastIndexOf(')') + 2).split(' ');
            const state = fields[0] ?? null, flags = Number(fields[6]);
            const kernelThread = Number.isFinite(flags) && (flags & PF_KTHREAD) !== 0;
            if (!kernelThread) ({ cwd, error, denied } = judgeByThreads(proc, name, failure, state === 'Z' || state === 'X', working));
          }
        }
      }
      table.set(Number(name), { ppid, cwd, error, denied });
    } catch { /* exited while read */ }
  }
  const spared = new Set<number>();
  for (let pid = self; pid > 1 && !spared.has(pid); pid = table.get(pid)?.ppid ?? 0) spared.add(pid);
  const unmanaged = (cwd: string | null) => !cwd || (cwd !== managed && !cwd.startsWith(`${managed}${sep}`));
  const writers = new Set([...table].filter(([pid, entry]) => !spared.has(pid) && working(entry.cwd)).map(([pid]) => pid));
  for (let grown = true; grown;) {
    grown = false;
    for (const [pid, entry] of table) if (!writers.has(pid) && !spared.has(pid) && writers.has(entry.ppid) && unmanaged(entry.cwd)) { writers.add(pid); grown = true; }
  }
  const outside = (pid: number) => { try { return managedScope.test(readFileSync(join(proc, String(pid), 'cgroup'), 'utf8')); } catch { return false; } };
  const unreadable = [...table].filter(([pid, entry]) => entry.error !== null && !spared.has(pid) && !outside(pid)).sort(([a], [b]) => a - b);
  const listed = (denied: boolean) => unreadable.filter(([, entry]) => entry.denied === denied).map(([pid, entry]) => ({ pid, error: entry.error! }));
  return { writers: [...writers].sort((a, b) => a - b), unverifiable: listed(false), skipped: listed(true) };
}
/**
 * A process of this user whose own cwd read failed (`failure`), judged by its live sibling threads at
 * /proc/PID/task/TID: every live thread is inspected (GY-1680 review) — a zombie thread-group leader
 * whose main thread called pthread_exit still writes through such a thread (GY-1663), and a live
 * leader whose own link is refused may still show one — and any thread whose cwd is inside the
 * checkout (`inside`) makes the process a writer, never skipped, even when an earlier readable
 * thread lies outside. Threads may hold distinct working directories (a clone without CLONE_FS), so
 * a thread reading outside proves nothing about another: a live thread whose cwd cannot be read
 * beside one that reads outside leaves the process unverifiable (GY-1680 review), never outside and
 * never skipped, and so does the live leader's own failed read (GY-1680 review): its working
 * directory is a thread's too, unjudged, so a live leader with a sibling that reads outside is
 * unverifiable whatever refused the leader's read, and the restore refuses. Only a zombie leader
 * (`leaderGone`, its own thread exited with no cwd) is judged by its live siblings alone: every
 * live thread's cwd read and none inside is outside. No live thread: a zombie leader is gone, a
 * live one stands on its own read — skipped when that was refused EACCES (GY-1672), unverifiable
 * otherwise. Live threads none of whose cwd reads: a live leader is skipped only when every read,
 * its own and its live threads', was refused EACCES, the non-dumpable daemon GY-1672 names; a
 * zombie leader's, or any other failure, or a task list that cannot be read, is unverifiable, and
 * the restore refuses. A thread whose cwd read fails ENOENT after its own stat read succeeded is
 * none of these: a live task's cwd link never fails ENOENT — a deleted working directory still
 * reads, naming itself "(deleted)", and a permission refusal is EACCES — so the link's absence
 * between the two reads is the thread's exit, judged like the stat-read failure beside it (GY-2016:
 * a busy host's process churn otherwise turned that race into restore refusals that passed only on
 * rerun). An exited thread contributes no judgment of its own: when no live thread's read judged
 * anything, the leader's own failed read stands as if no thread had lived (GY-2016 rework), never a
 * clean verdict assembled from reads that read nothing.
 */
function judgeByThreads(proc: string, name: string, failure: unknown, leaderGone: boolean, inside: (cwd: string) => boolean): { cwd: string | null; error: string | null; denied: boolean } {
  const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
  const refused = (error: unknown) => (error as NodeJS.ErrnoException).code === 'EACCES';
  const reason = describe(failure);
  const own = { cwd: null, error: reason, denied: refused(failure) }, gone = { cwd: null, error: null, denied: false };
  let tasks: string[];
  try { tasks = readdirSync(join(proc, name, 'task')).filter(tid => /^\d+$/.test(tid) && tid !== name); }
  catch (listing) {
    // No task list: the process is gone with it — or, still listed under /proc while live, stands on its own read.
    if ((listing as NodeJS.ErrnoException).code === 'ENOENT') return leaderGone || !existsSync(join(proc, name)) ? gone : own;
    return { cwd: null, error: `${reason}; its threads cannot be listed (${describe(listing)})`, denied: false };
  }
  let error: string | null = null, denied = refused(failure), live = false, outside: { tid: string; cwd: string } | null = null;
  for (const tid of tasks) {
    let stat: string; try { stat = readFileSync(join(proc, name, 'task', tid, 'stat'), 'utf8'); } catch { continue; /* exited */ }
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
    if (state === 'Z' || state === 'X') continue;
    live = true;
    try {
      const cwd = readlinkSync(join(proc, name, 'task', tid, 'cwd'));
      if (inside(cwd)) return { cwd, error: null, denied: false };
      outside ??= { tid, cwd };
    } catch (thread) {
      // ENOENT here is the thread's exit between its stat read above and this read, never a refusal:
      // a live task's cwd link does not fail ENOENT — a deleted working directory still reads, naming
      // itself "(deleted)", and a permission refusal is EACCES — so the thread is gone and judged
      // nothing, like the stat-read failure beside it; every other failure stays fail-closed
      // (GY-2016: the race otherwise made the process unverifiable and the restore refuse, a rerun's
      // lottery on a host whose suites churn processes constantly).
      if ((thread as NodeJS.ErrnoException).code === 'ENOENT') continue;
      error ??= `${reason}; its live thread ${tid}'s cwd cannot be read either (${describe(thread)})`; if (!refused(thread)) denied = false;
    }
  }
  // No live thread judged anything — none lived at its stat read, or every one exited between its
  // stat read and its ENOENT cwd read (GY-2016) — leaves the leader's own failed read to stand, the
  // `!live` verdict: a zombie leader is gone; a live one is skipped only when its own read was
  // refused EACCES (GY-1672), unverifiable otherwise. An exited thread writes nothing, but it proves
  // nothing either: a live leader whose own read failed is never read as fully judged clean by reads
  // that judged nothing (GY-2016 rework: that verdict dropped the process from every list — neither
  // the skip nor the refusal the contract names).
  if (!live || (error === null && outside === null)) return leaderGone ? gone : own;
  // Outside only when fully judged: every live thread's cwd read and none inside — the leader's own
  // included, so only a zombie leader's siblings can settle it. A live leader whose own read failed, or
  // a thread that could not be read, beside an outside one may be inside, so the process is
  // unverifiable — EACCES or not, never the skip GY-1672 delivers for a process every read of which was
  // refused (GY-1680 review).
  if (outside && error === null && leaderGone) return { cwd: outside.cwd, error: null, denied: false };
  if (outside) return { cwd: null, error: `${error ?? `${reason}; its own working directory is unjudged`}, while its live thread ${outside.tid}'s reads outside the checkout`, denied: false };
  return { cwd: null, error, denied: denied && !leaderGone };
}
const gone = (state: string | null) => state === null || state === 'Z' || state === 'X';
const stoppedState = (state: string | null) => state === 'T' || state === 't';
const stateLetter = (stat: string) => stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) || null;
/**
 * A process's state letter from /proc (R, S, D, T, t, Z, …), or null when it is gone. A zombie
 * thread-group leader whose sibling threads still run (judgeByThreads) is judged by those threads, never
 * as gone (GY-1663 review): a live thread not yet stopped gives its own state, and when every live
 * thread shows stopped the group is stopped (T). SIGSTOP sent to the leader's pid stops the whole group.
 */
export function processStateOf(pid: number, proc = '/proc'): string | null {
  let state: string | null;
  try { state = stateLetter(readFileSync(join(proc, String(pid), 'stat'), 'utf8')); } catch { return null; }
  if (state !== 'Z') return state;
  let tasks: string[];
  try { tasks = readdirSync(join(proc, String(pid), 'task')).filter(tid => /^\d+$/.test(tid) && tid !== String(pid)); } catch { return state; }
  let stopped = false;
  for (const tid of tasks) {
    let thread: string | null; try { thread = stateLetter(readFileSync(join(proc, String(pid), 'task', tid, 'stat'), 'utf8')); } catch { continue; /* exited */ }
    if (thread === null || thread === 'Z' || thread === 'X') continue;
    if (!stoppedState(thread)) return thread;
    stopped = true;
  }
  return stopped ? 'T' : state;
}
export interface WriterFreezeDeps {
  signal?: (pid: number, name: NodeJS.Signals) => void;
  /** The process's state letter, null when it is gone (processStateOf). */
  state?: (pid: number) => string | null;
  /** The checkout's standing writers (checkoutWriterScan), or just their pids. */
  scan?: (root: string) => number[] | { writers: number[]; skipped: UnverifiableProcess[] };
  /** How long a stopped writer may take to show stopped, and how often it is read. */
  settleMs?: number; pollMs?: number;
  /** The freeze ledger (frozenWritersLedger): where each writer this freeze stops is recorded before its SIGSTOP, so a process that ends this one continues them (continueFrozenWriters). */
  ledger?: string;
}
/** The freeze ledger's kind; a ledger of another kind is not read. */
export const frozenWritersLedgerKind = 'graphyard-checkout-restore-frozen/1';
/** What a freeze records of the writers it stopped: the checkout, the freezing process, and every pid it sent SIGSTOP, each recorded before the signal. */
export interface FrozenWritersLedger { kind: typeof frozenWritersLedgerKind; root: string; pid: number; at: string; stopped: number[] }
/** Writes the ledger whole (a temporary file renamed over it), private to this user. */
function writeFrozenWritersLedger(file: string, ledger: FrozenWritersLedger) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(ledger), { mode: 0o600 });
  renameSync(temporary, file);
}
/** The ledger at `file`, or null when there is none or it is not a ledger. */
export function readFrozenWritersLedger(file: string): FrozenWritersLedger | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<FrozenWritersLedger>;
    if (parsed.kind !== frozenWritersLedgerKind || typeof parsed.root !== 'string' || typeof parsed.pid !== 'number' || !Array.isArray(parsed.stopped)) return null;
    return { kind: frozenWritersLedgerKind, root: parsed.root, pid: parsed.pid, at: typeof parsed.at === 'string' ? parsed.at : '', stopped: parsed.stopped.filter((pid): pid is number => Number.isInteger(pid) && pid > 0) };
  } catch { return null; }
}
/**
 * Continue (SIGCONT) the writers a freeze ledger names that still show stopped, and remove the ledger
 * (GY-1680 review): the freeze's own thaw runs in a `finally`, which a process ended by a signal — the
 * loop's timeout on the snapshot's CLI, a SIGKILL — never reaches, and a retry would find those writers
 * already stopped and treat them as quiet, never continuing them. The ledger is written before each
 * SIGSTOP, so whoever outlives the freezer can finish its thaw: a pid that no longer shows stopped
 * (gone, or already continued) is left alone. Null when there is no ledger; otherwise the pids
 * continued and the pids left alone.
 */
export function continueFrozenWriters(file: string, deps: Pick<WriterFreezeDeps, 'signal' | 'state'> = {}): { root: string; pid: number; continued: number[]; left: number[] } | null {
  const ledger = readFrozenWritersLedger(file);
  if (!ledger) { try { unlinkSync(file); } catch { /* none */ } return null; }
  const signal = deps.signal ?? ((pid, name) => process.kill(pid, name)), state = deps.state ?? (pid => processStateOf(pid));
  const continued: number[] = [], left: number[] = [];
  for (const pid of [...new Set(ledger.stopped)]) {
    if (!stoppedState(state(pid))) { left.push(pid); continue; }
    try { signal(pid, 'SIGCONT'); continued.push(pid); } catch { left.push(pid); }
  }
  try { unlinkSync(file); } catch { /* already removed */ }
  return { root: ledger.root, pid: ledger.pid, continued, left };
}
/**
 * Stop the checkout's standing writers (SIGSTOP), verify each one stopped, and return what continues
 * them (SIGCONT): they keep every byte of their state, and none of them can write between the
 * snapshot and the reset. The freeze fails closed (GY-1658 review): a writer that cannot be
 * signalled, or does not show stopped within `settleMs`, throws before anything is touched, with
 * every process this attempt stopped continued again. The writers are read again after each round, so
 * one forked during the freeze is stopped too. A writer already stopped (by job control or a
 * debugger) is quiescent as it stands: it is neither signalled nor continued after. The processes the
 * scans skipped (their cwd read refused EACCES, GY-1672) are returned in `skipped`, neither stopped nor continued.
 * With `ledger`, every pid is recorded there before its SIGSTOP and the ledger removed by the thaw, so
 * a process that ends this one mid-freeze leaves what it stopped for continueFrozenWriters (GY-1680 review).
 */
export async function freezeCheckoutWriters(root: string, deps: WriterFreezeDeps = {}): Promise<{ pids: number[]; stopped: number[]; skipped: UnverifiableProcess[]; thaw: () => void }> {
  const signal = deps.signal ?? ((pid, name) => process.kill(pid, name)), state = deps.state ?? (pid => processStateOf(pid)), scanned = deps.scan ?? (directory => checkoutWriterScan(directory));
  const skipped = new Map<number, UnverifiableProcess>();
  const scan = (directory: string) => {
    const result = scanned(directory);
    if (Array.isArray(result)) return result;
    for (const entry of result.skipped) if (!skipped.has(entry.pid)) skipped.set(entry.pid, entry);
    return result.writers;
  };
  const settleMs = deps.settleMs ?? 5_000, pollMs = deps.pollMs ?? 20;
  const stopped: number[] = [], quiet = new Set<number>(), seen = new Set<number>();
  const record = () => { if (deps.ledger) writeFrozenWritersLedger(deps.ledger, { kind: frozenWritersLedgerKind, root, pid: process.pid, at: new Date().toISOString(), stopped: [...stopped] }); };
  const thaw = () => {
    for (const pid of stopped) { try { signal(pid, 'SIGCONT'); } catch { /* gone */ } }
    if (deps.ledger) { try { unlinkSync(deps.ledger); } catch { /* never written, or already removed */ } }
  };
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
        // Recorded before it is signalled: a freezer ended between the two leaves a running pid in the
        // ledger, which continueFrozenWriters leaves alone; the other order would leave a stopped one unrecorded.
        stopped.push(pid); record();
        try { signal(pid, 'SIGSTOP'); }
        catch (error) {
          stopped.pop(); record();
          if (gone(state(pid))) continue;
          throw new Error(`the checkout's writer pid ${pid} could not be stopped (${error instanceof Error ? error.message : String(error)}), so nothing was restored`);
        }
        signalled.push(pid);
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
  return { pids: [...quiet].sort((a, b) => a - b), stopped, skipped: [...skipped.values()].sort((a, b) => a.pid - b.pid), thaw };
}
