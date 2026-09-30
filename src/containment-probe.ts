import { defaultChildRun, type ChildRun } from './child-runner.js';
import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { linuxProcessRecord } from './supervisor.js';
import type { ContainmentScope } from './model.js';

/**
 * Host-side verification that a contained worker is gone: the probe `master status` and
 * `master settle-containment` run on the registered host. It supersedes the probe that
 * shipped inside supervisor.ts, adding the exact recorded launch scope, attribution of a
 * neighbouring scope to its own live supervisor, and the command line and working directory
 * of every process still holding the fence.
 */
export interface SupervisorProbeTarget { key: string; epoch: number; workspacePath: string; scope?: ContainmentScope | null }
/** One process the probe found holding the fence, with what the master needs to verify it. */
export interface HeldProcess { pid: number; command: string; cwd: string | null; unit: string | null }
export interface RecordedScopeObservation { unit: string; pid: number; activeState: string }
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
  run?: ChildRun;
}

/**
 * The assignment a supervisor names in its own command line: `watch KEY EPOCH -- command`.
 *
 * This is only ever used to attribute a live process to a *different* assignment, so it
 * demands the exact invocation shape rather than a loose match: an ordinary command that
 * happens to carry a `watch` argument must never excuse a process from the fence.
 */
function watchAssignment(argv: string[]): { key: string; epoch: string } | null {
  const index = argv.indexOf('watch');
  if (index < 0) return null;
  const [key, epoch, separator] = argv.slice(index + 1, index + 4);
  return /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(key ?? '') && /^\d+$/.test(epoch ?? '') && separator === '--' ? { key, epoch } : null;
}

const vanished = (error: unknown) => ['ENOENT', 'ESRCH'].includes((error as { code?: string }).code ?? '');
const detail = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 200);
const scopePattern = /^graphyard-watch-[A-Za-z0-9:@._-]+\.scope$/;
/** The supervisor pid a scope name carries; see systemdContainment. */
export function scopeSupervisorPid(unit: string): number | null {
  const match = /^graphyard-watch-(\d+)-/.exec(unit);
  return match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 0 ? Number(match[1]) : null;
}
const liveScope = ['active', 'activating', 'deactivating', 'reloading'];

/**
 * Observe, on the registered host, whether a contained worker is still running.
 *
 * This reports what it could see and what it could not: a signal it failed to collect is
 * never the same as an absence. Command lines identify a supervisor regardless of its
 * owner; working directories and containment scopes are readable only for the probing
 * user's own processes and user manager, which is the boundary local dispatch uses.
 */
/** What one probe reports; a test's stub may answer synchronously, the host's probe asynchronously. */
export type SupervisorProbeReport = Awaited<ReturnType<typeof probeSupervisorAbsence>>;
export type SupervisorProbe = (target: SupervisorProbeTarget, deps?: SupervisorProbeDeps) => SupervisorProbeReport | Promise<SupervisorProbeReport>;
export async function probeSupervisorAbsence(target: SupervisorProbeTarget, deps: SupervisorProbeDeps = {}) {
  const platform = deps.platform ?? process.platform;
  const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid()! : 0);
  const processes: { pid: number; evidence: 'command' | 'workspace' }[] = [];
  const scopes: { unit: string; activeState: string; processes: number[]; attributed: number[] }[] = [];
  const unverifiable: string[] = [];
  // Every process reported as holding the fence, with its command line and working directory,
  // so the master can verify each one before stopping anything.
  const held: HeldProcess[] = [];
  // How systemd reports the scope this quarantine recorded; not-found once it is unloaded.
  let recordedScope: RecordedScopeObservation | null = target.scope ? { unit: target.scope.unit, pid: target.scope.pid, activeState: 'unqueried' } : null;
  let inaccessible = 0;
  const record = () => ({ method: 'linux-proc-systemd' as const, platform: String(platform), uid, workspacePath: target.workspacePath, processes, scopes, held, recordedScope, inaccessible, unverifiable });
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
  const run = deps.run ?? ((command: string, args: string[]) => defaultChildRun(command, args, { timeoutMs: 15_000 }));
  const resolvePath = deps.resolvePath ?? ((path: string) => { try { return realpathSync(path); } catch { return path; } });
  const workspace = resolvePath(target.workspacePath);
  // The kernel separates command-line arguments with NUL, and an argument may itself
  // contain spaces: only that boundary reconstructs the argv a supervisor was given.
  const commandArgv = (pid: number) => readCommand(pid).split('\0').filter(Boolean);
  const describe = (pid: number, unit: string | null) => {
    // One entry per process: a workspace process later found inside a scope names that scope.
    const known = held.find(entry => entry.pid === pid);
    if (known) { known.unit ??= unit; return; }
    let command = '';
    try { command = commandArgv(pid).join(' ').slice(0, 500); } catch (error) { command = `<${vanished(error) ? 'gone' : 'unreadable'}>`; }
    let cwd: string | null = null;
    try { cwd = readCwd(pid); } catch { cwd = null; }
    held.push({ pid, command, cwd, unit });
  };
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
    if (supervisesTarget(argv)) { processes.push({ pid, evidence: 'command' }); describe(pid, null); continue; }
    let owner: number;
    try { owner = processOwner(pid); }
    catch (error) { if (!vanished(error)) unverifiable.push(`Owner of process ${pid} could not be read: ${detail(error)}`); continue; }
    // Another user's descendants are outside this sweep; local dispatch runs the worker as
    // the coordinator's user, and the containment scope below covers the contained tree.
    if (owner !== uid) continue;
    const membership = workspaceMember(pid);
    if (membership === 'inside') { processes.push({ pid, evidence: 'workspace' }); describe(pid, null); }
    if (membership === 'unreadable') inaccessible++;
  }
  try { await run('systemctl', ['--user', 'show-environment']); }
  catch (error) {
    unverifiable.push(`systemd user manager is unavailable, so containment scopes cannot be queried: ${detail(error)}`);
    return record();
  }
  let units: string[] = [];
  try {
    units = [...new Set(String(await run('systemctl', ['--user', 'list-units', '--all', '--plain', '--no-legend', '--type=scope', 'graphyard-watch-*.scope']))
      .split(/\r?\n/).map(line => line.trim().replace(/^[^A-Za-z0-9]+/, '').split(/\s+/)[0]).filter(unit => scopePattern.test(unit)))];
  } catch (error) { unverifiable.push(`Containment scope query failed: ${detail(error)}`); return record(); }
  // The scope this quarantine recorded is queried even when systemd no longer lists it, so the
  // report says what became of the exact unit the session was launched in.
  if (recordedScope && !units.includes(recordedScope.unit) && scopePattern.test(recordedScope.unit)) units.push(recordedScope.unit);
  /**
   * The assignment a scope itself belongs to, read from the live supervisor whose pid its name
   * carries: that supervisor was created by `watch KEY EPOCH -- …` running from KEY's workspace.
   * A dead or reused pid, a command line that is not a supervisor's, or a supervisor working
   * inside this workspace attributes nothing, so the scope's members are judged one by one.
   */
  const scopeAssignment = (unit: string): 'target' | 'other' | 'unresolved' => {
    if (target.scope?.unit === unit) return 'target';
    const supervisor = scopeSupervisorPid(unit);
    if (supervisor === null) return 'unresolved';
    let argv: string[];
    try { argv = commandArgv(supervisor); } catch { return 'unresolved'; }
    if (supervisesTarget(argv)) return 'target';
    const assignment = watchAssignment(argv);
    if (!assignment) return 'unresolved';
    if (assignment.key === target.key && assignment.epoch === String(target.epoch)) return 'target';
    return workspaceMember(supervisor) === 'outside' ? 'other' : 'unresolved';
  };
  for (const unit of units) {
    try {
      const properties = String(await run('systemctl', ['--user', 'show', '--property=LoadState', '--property=ActiveState', '--property=ControlGroup', unit])).split(/\r?\n/);
      const property = (name: string) => properties.find(line => line.startsWith(`${name}=`))?.slice(name.length + 1).trim() ?? '';
      const activeState = property('ActiveState'), controlGroup = property('ControlGroup');
      const recorded = recordedScope?.unit === unit;
      if (recorded) recordedScope!.activeState = property('LoadState') === 'not-found' ? 'not-found' : activeState || 'unknown';
      // The recorded scope was queried whether or not systemd still lists it; unloaded, it is
      // reported on the record alone rather than as a scope the host holds.
      if (recorded && property('LoadState') === 'not-found') continue;
      if (!activeState) { unverifiable.push(`systemd reported no state for containment scope ${unit}`); continue; }
      if (property('LoadState') === 'not-found' || !liveScope.includes(activeState)) { scopes.push({ unit, activeState, processes: [], attributed: [] }); continue; }
      if (!controlGroup) { unverifiable.push(`Containment scope ${unit} is ${activeState} without a readable control group`); continue; }
      let members: number[];
      try { members = readCgroup(controlGroup).split(/\s+/).filter(value => /^\d+$/.test(value)).map(Number); }
      catch (error) { if (!vanished(error)) throw error; members = []; }
      // The scope this quarantine recorded is this assignment's containment: everything it still
      // holds fences it, whatever the member's working directory or ancestry says. Any other
      // scope's name carries only its supervisor's PID, so a member it still holds fences this
      // one unless the scope's own live supervisor, or the member's ancestry, positively
      // attributes it to a different assignment: a working directory outside the workspace is
      // not proof of belonging elsewhere.
      const owner = scopeAssignment(unit);
      const holding: number[] = [], attributed: number[] = [];
      for (const pid of members) {
        const membership = workspaceMember(pid);
        if (membership === 'gone') continue;
        if (owner !== 'target' && membership !== 'inside' && (owner === 'other' || assignmentOf(pid) === 'other')) attributed.push(pid);
        else { holding.push(pid); describe(pid, unit); }
      }
      scopes.push({ unit, activeState, processes: holding, attributed });
    } catch (error) { unverifiable.push(`Containment scope ${unit} could not be inspected: ${detail(error)}`); }
  }
  return record();
}
