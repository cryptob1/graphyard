import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

interface Renewal { lease: { epoch: number; expiresAt: string } | null; updatedAt: string }

export interface Containment {
  command: string;
  args: string[];
  signal: (signal: NodeJS.Signals) => void;
  empty: () => boolean;
}

export function systemdContainment(command: string, args: string[], run: typeof execFileSync = execFileSync): Containment {
  run('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' });
  const unit = `graphyard-watch-${process.pid}-${randomUUID()}.scope`;
  return {
    command: 'systemd-run',
    args: ['--user', '--scope', '--quiet', `--unit=${unit}`, '--', command, ...args],
    signal: signal => { run('systemctl', ['--user', 'kill', '--kill-whom=all', `--signal=${signal}`, unit], { stdio: 'ignore' }); },
    empty: () => {
      const query = ['--user', 'show', '--property=LoadState', '--property=ActiveState', unit];
      const unloaded = (output: unknown) => String(output ?? '').split(/\r?\n/).some(line => line.trim() === 'LoadState=not-found');
      try {
        const properties = String(run('systemctl', query, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
        if (unloaded(properties)) return true;
        const state = properties.split(/\r?\n/).find(line => line.startsWith('ActiveState='))?.slice('ActiveState='.length);
        return state === 'inactive' || state === 'failed';
      } catch (error) {
        // A transient scope may be unloaded between process exit and verification.
        // Only systemd's structured LoadState can turn a failed query into success;
        // transport, manager and all other query failures remain unverifiable.
        if (unloaded((error as { stdout?: unknown }).stdout)) return true;
        throw error;
      }
    },
  };
}

export type ProcessRecord = { ppid: number; identity: string };

export function captureTrackedRoot(rootPid: number, supervisedPids: Map<number, string>, root: ProcessRecord | null) {
  if (root) supervisedPids.set(rootPid, root.identity);
}

export function linuxProcessRecord(stat: string): ProcessRecord | null {
  const end = stat.lastIndexOf(') ');
  if (end < 0) return null;
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  const ppid = Number(fields[1]), starttime = fields[19];
  return Number.isSafeInteger(ppid) && ppid >= 0 && /^\d+$/.test(starttime ?? '') ? { ppid, identity: starttime } : null;
}

function processTable(): Map<number, ProcessRecord> {
  const records = new Map<number, ProcessRecord>();
  if (process.platform !== 'linux') return records;
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const record = linuxProcessRecord(readFileSync(`/proc/${name}/stat`, 'utf8'));
        if (record) records.set(Number(name), record);
      } catch {}
    }
  } catch {}
  return records;
}

function processRecord(pid: number): ProcessRecord | null {
  try { return linuxProcessRecord(readFileSync(`/proc/${pid}/stat`, 'utf8')); }
  catch { return null; }
}

export function signalTrackedProcesses(rootPid: number, supervisedPids: Map<number, string>, rows: Map<number, ProcessRecord>, signal: NodeJS.Signals, kill: (pid: number, signal: NodeJS.Signals) => void = process.kill) {
  const pending = [...supervisedPids.keys()];
  while (pending.length) {
    const parent = pending.shift()!;
    if (rows.get(parent)?.identity !== supervisedPids.get(parent)) {
      supervisedPids.delete(parent);
      continue;
    }
    for (const [pid, record] of rows) if (record.ppid === parent && !supervisedPids.has(pid)) {
      supervisedPids.set(pid, record.identity); pending.push(pid);
    }
  }
  for (const [pid, identity] of [...supervisedPids].reverse()) {
    if (rows.get(pid)?.identity !== identity) { supervisedPids.delete(pid); continue; }
    try { kill(pid, signal); } catch {}
  }
}

/**
 * What a supervisor watches besides its lease: the session it was launched in.
 *
 * A supervisor exists to run one agent under one lease. When the agent is gone the supervisor has
 * nothing left to supervise, and a heartbeat it keeps sending is worse than no heartbeat at all —
 * it keeps the item owned by a worker that cannot act, so nothing lapses and no replacement is
 * dispatched. `visible` reports Herdr's view of this session and `surrender` ends the attempt on
 * the record before the supervisor exits.
 */
export interface SupervisedSession {
  /** Herdr's view of this session: `true` still reported, `false` gone, `null` not observable. */
  visible?: () => boolean | null;
  /** Records the cause on the assignment and releases the lease. */
  surrender?: (cause: string) => Promise<void>;
}

const processAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: string }).code === 'EPERM'; } };

/**
 * Whether Herdr still reports the pane this supervisor was launched in.
 *
 * Herdr puts the pane id in the session's own environment, so the identity is exact rather than
 * inferred from a working directory an agent may leave. A query that fails answers `null`: an
 * unreachable Herdr is a signal that could not be collected, never an absence.
 */
export function herdrSessionProbe(env: NodeJS.ProcessEnv = process.env, run: (command: string, args: string[]) => string = (command, args) => String(execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }))): () => boolean | null {
  const pane = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== '1' || !pane) return () => null;
  return () => {
    try {
      const parsed = JSON.parse(run('herdr', ['agent', 'list']));
      const agents = (parsed?.result ?? parsed)?.agents;
      return Array.isArray(agents) ? agents.some((agent: { pane_id?: string }) => agent?.pane_id === pane) : null;
    } catch { return null; }
  };
}

async function postAssignment(url: string, token: string, path: string, body: unknown) {
  const response = await fetch(`${url.replace(/\/+$/, '')}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} refused: ${text.slice(0, 200)}`);
}

/**
 * The worker protocol a supervisor follows when its session is gone: record the cause on the
 * assignment, withdraw that report, then release the lease.
 *
 * The blocked report is the one free-text entry a worker writes to the append-only ledger, and
 * the one Graphyard already reads back as the explanation for an attempt that ended early, so it
 * is where the cause belongs. It is withdrawn in the same breath because a standing blocker would
 * leave the freed item waiting for somebody to clear a condition that is already over: the event
 * keeps the cause, and the release ends the attempt as released rather than as a silent lapse.
 *
 * The assignment comes from this supervisor's own `watch KEY EPOCH --` command line and its
 * credential from its own environment, so no caller has to supply either; a supervisor that can
 * read neither surrenders nothing and simply stops.
 */
export function assignmentSurrender(epoch: number, argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env, post = postAssignment) {
  const assignment = watchAssignment(argv);
  const url = env.GRAPHYARD_URL, token = env.GRAPHYARD_TOKEN;
  if (!assignment || Number(assignment.epoch) !== epoch || !url || !token) return undefined;
  return async (cause: string) => {
    const reason = `Watch supervisor ended attempt ${epoch}: ${cause}`.slice(0, 2000);
    await post(url, token, `work/${assignment.key}/blocked`, { epoch, reason });
    await post(url, token, `work/${assignment.key}/blocked`, { epoch, reason: null });
    await post(url, token, `work/${assignment.key}/release`, { epoch });
  };
}

// The deadline uses elapsed local time and server-reported duration, not synchronized clocks.
export async function supervise(command: string, args: string[], epoch: number, renew: () => Promise<Renewal>, options: { intervalMs?: number; graceMs?: number; shutdownPollMs?: number; shutdownTimeoutMs?: number; detached?: boolean; containment?: Containment; platform?: NodeJS.Platform; session?: SupervisedSession; quarantine?: { establish: () => Promise<unknown>; revalidate?: () => Promise<unknown>; acknowledge?: () => Promise<unknown>; settle: () => Promise<unknown> } } = {}) {
  let deadline = 0;
  async function heartbeat() {
    const started = performance.now();
    const result = await renew();
    const duration = Date.parse(result.lease?.expiresAt ?? '') - Date.parse(result.updatedAt);
    if (result.lease?.epoch !== epoch || !Number.isFinite(duration) || duration <= 0) throw new Error('Invalid lease renewal');
    deadline = started + duration;
    if (deadline <= performance.now()) throw new Error('Lease expired during renewal');
  }
  await heartbeat();
  const env = { ...process.env };
  for (const key of ['GRAPHYARD_PRINCIPALS', 'DATABASE_URL', 'GITHUB_PRIVATE_KEY', 'GITHUB_PRIVATE_KEY_FILE', 'GITHUB_WEBHOOK_SECRET']) delete env[key];
  const platform = options.platform ?? process.platform;
  const detached = options.detached ?? platform !== 'win32';
  if (!detached && platform !== 'linux' && !options.containment) throw new Error(`Foreground worker supervision requires durable containment and is not supported on ${platform}`);
  const containment = options.containment ?? (!detached && platform === 'linux' ? systemdContainment(command, args) : undefined);
  if (containment && !options.quarantine) throw new Error('Foreground worker supervision requires a durable Graphyard containment quarantine');
  const sessionVisible = options.session?.visible ?? herdrSessionProbe();
  const surrender = options.session?.surrender ?? assignmentSurrender(epoch);
  return new Promise<number>((resolve, reject) => {
    let child: ReturnType<typeof spawn> | undefined;
    let stopping = false, pending = false, prelaunchInterrupted = false, finished = false;
    let sessionSeen = false, scopeSeen = false;
    const supervisedPids = new Map<number, string>();
    let containmentFailure: unknown;
    let expiry: ReturnType<typeof setTimeout>;
    let timer: ReturnType<typeof setInterval>;
    const finish = (error: unknown, code?: number) => {
      if (finished) return;
      finished = true;
      process.off('SIGTERM', interrupted); process.off('SIGINT', interrupted);
      if (error) reject(error); else resolve(code!);
    };
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child?.pid) return;
      if (containment) {
        try { containment.signal(signal); return; }
        catch (error) { containmentFailure ??= error; }
      }
      if (detached && platform !== 'win32') { try { process.kill(-child.pid, signal); } catch {} return; }
      if (platform === 'win32') { try { child.kill(signal); } catch {} return; }
      const rows = processTable();
      signalTrackedProcesses(child.pid, supervisedPids, rows, signal);
    };
    const interrupted = () => {
      if (!child) { prelaunchInterrupted = true; return; }
      stop(1);
    };
    function stop(code: number) {
      if (stopping) return;
      stopping = true; clearInterval(timer); clearTimeout(expiry);
      signalGroup('SIGTERM');
      // Keep this timer referenced even if the group leader exits first.
      setTimeout(async () => {
        signalGroup('SIGKILL');
        if (containment) {
          let empty = false, lastVerificationFailure: unknown;
          const shutdownDeadline = performance.now() + (options.shutdownTimeoutMs ?? 2000);
          do {
            try { if (containment.empty()) { empty = true; break; } }
            catch (error) { lastVerificationFailure = error; }
            const remaining = shutdownDeadline - performance.now();
            if (remaining <= 0) break;
            await delay(Math.min(options.shutdownPollMs ?? 50, remaining));
          } while (performance.now() < shutdownDeadline);
          containmentFailure ??= lastVerificationFailure;
          if (!empty) { finish(new Error(`Worker containment shutdown could not be verified${containmentFailure instanceof Error ? `: ${containmentFailure.message}` : ''}`)); return; }
          try { await options.quarantine!.settle(); }
          catch (error) { finish(new Error(`Worker containment shutdown was verified but its Graphyard quarantine could not be settled: ${error instanceof Error ? error.message : String(error)}`)); return; }
        }
        finish(null, code);
      }, options.graceMs ?? 5000);
    }
    const armDeadline = () => { clearTimeout(expiry); expiry = setTimeout(() => stop(1), Math.max(0, deadline - performance.now())); };
    /**
     * Why there is nothing left to supervise, or null while the agent is still there.
     *
     * The child's own exit event is the ordinary path; this is the check that does not depend on
     * it, because a supervisor that never receives it is exactly the failure this answers. An
     * absence counts only once presence was observed: a scope that has not activated yet, or a
     * session Herdr has not registered yet, must never read as a session that has ended.
     */
    const orphaned = (): string | null => {
      if (!child?.pid) return null;
      if (!processAlive(child.pid)) return `the agent process (pid ${child.pid}) has exited`;
      if (containment) {
        let empty: boolean | null = null;
        try { empty = containment.empty(); } catch { empty = null; }
        if (empty === false) scopeSeen = true;
        else if (empty === true && scopeSeen) return 'the worker containment scope holds no process, so the agent has exited';
      }
      const visible = sessionVisible();
      if (visible === true) sessionSeen = true;
      else if (visible === false && sessionSeen) return 'Herdr no longer reports this agent session';
      return null;
    };
    // The lease outlives several of these checks, so an orphaned supervisor is found, surrenders
    // its assignment and stops well inside one lease period.
    const surrenderAssignment = async (cause: string) => {
      if (!surrender) return;
      try { await surrender(cause); }
      catch (error) { console.error(`Graphyard could not release the lease after the worker session ended: ${error instanceof Error ? error.message : String(error)}`); }
    };
    process.on('SIGTERM', interrupted); process.on('SIGINT', interrupted);
    void (async () => {
      try {
        if (containment) await options.quarantine!.establish();
        if (containment && options.quarantine!.revalidate) {
          try { await options.quarantine!.revalidate(); }
          catch (error) {
            if ((error as { settleAllowed?: boolean }).settleAllowed) {
              try { await options.quarantine!.settle(); }
              catch (settlementError) { throw new Error(`Fresh Graphyard state refused worker launch and its unlaunched quarantine could not be settled: ${settlementError instanceof Error ? settlementError.message : String(settlementError)}`); }
            }
            throw error;
          }
        }
        if (prelaunchInterrupted) {
          if (containment) {
            try { await options.quarantine!.settle(); }
            catch (error) { finish(new Error(`Worker launch was interrupted after its Graphyard quarantine was established, but the quarantine could not be settled: ${error instanceof Error ? error.message : String(error)}`)); return; }
          }
          finish(null, 1);
          return;
        }
        // Acknowledgement is durable launch authority. Rework cannot clear its
        // quarantine while this live lease (and response) may still reach us.
        if (containment && options.quarantine!.acknowledge) {
          await options.quarantine!.acknowledge();
        }
        if (prelaunchInterrupted) {
          if (containment) await options.quarantine!.settle();
          finish(null, 1); return;
        }
        child = spawn(containment?.command ?? command, containment?.args ?? args, { stdio: 'inherit', detached, env });
        // Never learn the fallback root from a later /proc snapshot: after this
        // child exits its numeric PID can identify an unrelated replacement.
        // Cache the kernel identity immediately after spawn, or leave fallback
        // traversal empty when the short-lived launcher is already gone.
        if (containment && !detached && platform === 'linux' && child.pid) {
          captureTrackedRoot(child.pid, supervisedPids, processRecord(child.pid));
        }
        child.on('error', error => { console.error(error.message); stop(1); });
        child.on('exit', code => stop(code ?? 1));
        timer = setInterval(async () => {
          if (pending || stopping) return;
          pending = true;
          try {
            const cause = orphaned();
            if (cause) {
              clearInterval(timer);
              console.error(`Graphyard worker supervision has nothing left to supervise: ${cause}. Releasing the lease and stopping.`);
              await surrenderAssignment(cause);
              stop(1);
              return;
            }
            await heartbeat(); if (!stopping) armDeadline();
          }
          catch { console.error('Graphyard lease cannot be renewed. Stopping worker.'); stop(1); }
          finally { pending = false; }
        }, options.intervalMs ?? 25_000);
        armDeadline();
      } catch (error) { finish(error); }
    })();
  });
}

export interface SupervisorProbeTarget { key: string; epoch: number; workspacePath: string }
export interface SupervisorProbeDeps {
  platform?: NodeJS.Platform;
  uid?: number;
  listProcesses?: () => string[];
  readCommand?: (pid: number) => string;
  processOwner?: (pid: number) => number;
  readCwd?: (pid: number) => string;
  readParent?: (pid: number) => number;
  readCgroup?: (controlGroup: string) => string;
  resolvePath?: (path: string) => string;
  run?: (command: string, args: string[]) => string;
}

/**
 * The assignment a supervisor names in its own command line: `watch KEY EPOCH -- command`.
 *
 * This is only ever used to attribute a live process to a *different* assignment, so it
 * demands the exact invocation shape rather than a loose match: an ordinary command that
 * happens to carry a `watch` argument must never excuse a process from the fence.
 */
export function watchAssignment(argv: string[]): { key: string; epoch: string } | null {
  const index = argv.indexOf('watch');
  if (index < 0) return null;
  const [key, epoch, separator] = argv.slice(index + 1, index + 4);
  return /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(key ?? '') && /^\d+$/.test(epoch ?? '') && separator === '--' ? { key, epoch } : null;
}

const vanished = (error: unknown) => ['ENOENT', 'ESRCH'].includes((error as { code?: string }).code ?? '');
const detail = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 200);
export const scopePattern = /^graphyard-watch-[A-Za-z0-9:@._-]+\.scope$/;
const liveScope = ['active', 'activating', 'deactivating', 'reloading'];

/**
 * Observe, on the registered host, whether a contained worker is still running.
 *
 * This reports what it could see and what it could not: a signal it failed to collect is
 * never the same as an absence. Command lines identify a supervisor regardless of its
 * owner; working directories and containment scopes are readable only for the probing
 * user's own processes and user manager, which is the boundary local dispatch uses.
 */
export function probeSupervisorAbsence(target: SupervisorProbeTarget, deps: SupervisorProbeDeps = {}) {
  const platform = deps.platform ?? process.platform;
  const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid()! : 0);
  const processes: { pid: number; evidence: 'command' | 'workspace' }[] = [];
  const scopes: { unit: string; activeState: string; processes: number[]; attributed: number[] }[] = [];
  const unverifiable: string[] = [];
  let inaccessible = 0;
  const record = () => ({ method: 'linux-proc-systemd' as const, platform: String(platform), uid, workspacePath: target.workspacePath, processes, scopes, inaccessible, unverifiable });
  if (platform !== 'linux') {
    unverifiable.push(`Supervisor absence requires Linux process and systemd scope inspection; this host reports ${platform}`);
    return record();
  }
  const listProcesses = deps.listProcesses ?? (() => readdirSync('/proc'));
  const readCommand = deps.readCommand ?? ((pid: number) => readFileSync(`/proc/${pid}/cmdline`, 'utf8'));
  const processOwner = deps.processOwner ?? ((pid: number) => statSync(`/proc/${pid}`).uid);
  const readCwd = deps.readCwd ?? ((pid: number) => readlinkSync(`/proc/${pid}/cwd`));
  // Parentage, like the command line, is world-readable, so ancestry can be followed
  // across owners; a supervisor's containment scope holds only its own descendants.
  const readParent = deps.readParent ?? ((pid: number) => {
    const status = linuxProcessRecord(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    if (!status) throw new Error(`Process ${pid} reported an unreadable status line`);
    return status.ppid;
  });
  const readCgroup = deps.readCgroup ?? ((controlGroup: string) => readFileSync(join('/sys/fs/cgroup', controlGroup, 'cgroup.procs'), 'utf8'));
  const run = deps.run ?? ((command: string, args: string[]) => String(execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 })));
  const resolvePath = deps.resolvePath ?? ((path: string) => { try { return realpathSync(path); } catch { return path; } });
  const workspace = resolvePath(target.workspacePath);
  // The kernel separates command-line arguments with NUL, and an argument may itself
  // contain spaces: only that boundary reconstructs the argv a supervisor was given.
  const commandArgv = (pid: number) => readCommand(pid).split('\0').filter(Boolean);
  // A working directory is readable for this user's ordinary processes and withheld for
  // privileged ones, so an unreadable answer is 'not inspectable', never 'not the worker'.
  const workspaceMember = (pid: number): 'inside' | 'outside' | 'gone' | 'unreadable' => {
    try { const cwd = readCwd(pid); return cwd === workspace || cwd.startsWith(`${workspace}/`) ? 'inside' : 'outside'; }
    catch (error) { return vanished(error) ? 'gone' : 'unreadable'; }
  };
  // Matching the fenced assignment blocks settlement, so it stays deliberately loose.
  const supervisesTarget = (argv: string[]) => argv.includes('watch') && argv.includes(target.key) && argv.includes(String(target.epoch));
  /**
   * Which assignment a live process belongs to, read from the supervisor it descends from.
   *
   * A contained worker is a descendant of the supervisor that created its scope, and both
   * parentage and command lines are readable for every process. Only reaching a supervisor
   * of a different work key or epoch attributes a process elsewhere: a broken chain, an
   * orphan reparented away from its dead supervisor, or a process this user cannot follow
   * is 'unresolved', which fences rather than excuses.
   */
  const assignmentOf = (pid: number): 'target' | 'other' | 'unresolved' => {
    const seen = new Set<number>();
    for (let current = pid; current > 1 && !seen.has(current); ) {
      seen.add(current);
      let argv: string[];
      try { argv = commandArgv(current); }
      catch { return 'unresolved'; }
      if (supervisesTarget(argv)) return 'target';
      const assignment = watchAssignment(argv);
      if (assignment) return assignment.key === target.key && assignment.epoch === String(target.epoch) ? 'target' : 'other';
      let parent: number;
      try { parent = readParent(current); }
      catch { return 'unresolved'; }
      if (!Number.isSafeInteger(parent) || parent <= 0) return 'unresolved';
      current = parent;
    }
    return 'unresolved';
  };
  let pids: number[] = [];
  try { pids = listProcesses().filter(name => /^\d+$/.test(name)).map(Number); }
  catch (error) { unverifiable.push(`Host process table could not be read: ${detail(error)}`); }
  for (const pid of pids) {
    let argv: string[];
    try { argv = commandArgv(pid); }
    catch (error) { if (!vanished(error)) unverifiable.push(`Command line of process ${pid} could not be read: ${detail(error)}`); continue; }
    // The supervisor is identified by its own command line, which every user can read.
    if (supervisesTarget(argv)) { processes.push({ pid, evidence: 'command' }); continue; }
    let owner: number;
    try { owner = processOwner(pid); }
    catch (error) { if (!vanished(error)) unverifiable.push(`Owner of process ${pid} could not be read: ${detail(error)}`); continue; }
    // Another user's descendants are outside this sweep; local dispatch runs the worker as
    // the coordinator's user, and the containment scope below covers the contained tree.
    if (owner !== uid) continue;
    const membership = workspaceMember(pid);
    if (membership === 'inside') processes.push({ pid, evidence: 'workspace' });
    if (membership === 'unreadable') inaccessible++;
  }
  try { run('systemctl', ['--user', 'show-environment']); }
  catch (error) {
    unverifiable.push(`systemd user manager is unavailable, so containment scopes cannot be queried: ${detail(error)}`);
    return record();
  }
  let units: string[] = [];
  try {
    units = [...new Set(run('systemctl', ['--user', 'list-units', '--all', '--plain', '--no-legend', '--type=scope', 'graphyard-watch-*.scope'])
      .split(/\r?\n/).map(line => line.trim().replace(/^[^A-Za-z0-9]+/, '').split(/\s+/)[0]).filter(unit => scopePattern.test(unit)))];
  } catch (error) { unverifiable.push(`Containment scope query failed: ${detail(error)}`); return record(); }
  for (const unit of units) {
    try {
      const properties = run('systemctl', ['--user', 'show', '--property=LoadState', '--property=ActiveState', '--property=ControlGroup', unit]).split(/\r?\n/);
      const property = (name: string) => properties.find(line => line.startsWith(`${name}=`))?.slice(name.length + 1).trim() ?? '';
      const activeState = property('ActiveState'), controlGroup = property('ControlGroup');
      if (!activeState) { unverifiable.push(`systemd reported no state for containment scope ${unit}`); continue; }
      if (property('LoadState') === 'not-found' || !liveScope.includes(activeState)) { scopes.push({ unit, activeState, processes: [], attributed: [] }); continue; }
      if (!controlGroup) { unverifiable.push(`Containment scope ${unit} is ${activeState} without a readable control group`); continue; }
      let members: number[];
      try { members = readCgroup(controlGroup).split(/\s+/).filter(value => /^\d+$/.test(value)).map(Number); }
      catch (error) { if (!vanished(error)) throw error; members = []; }
      // A scope name carries the supervisor's PID, not the work key, so it cannot say whose
      // assignment a live scope is. Every member it still holds therefore fences this one
      // unless that member is positively attributed to a different live assignment: a
      // working directory outside the workspace is not proof of belonging elsewhere.
      const held: number[] = [], attributed: number[] = [];
      for (const pid of members) {
        const membership = workspaceMember(pid);
        if (membership === 'gone') continue;
        if (membership !== 'inside' && assignmentOf(pid) === 'other') attributed.push(pid);
        else held.push(pid);
      }
      scopes.push({ unit, activeState, processes: held, attributed });
    } catch (error) { unverifiable.push(`Containment scope ${unit} could not be inspected: ${detail(error)}`); }
  }
  return record();
}
