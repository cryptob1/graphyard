import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { ContainmentScope, Work, Workspace } from './model.js';

export class PrelaunchContainmentError extends Error {
  constructor(message: string, public readonly settleAllowed: boolean) { super(message); }
}

export function revalidateContainment(
  snapshot: { now: string; work: Work[] },
  expected: { workId: string; principal: string; epoch: number; settlementHash: string; exclusiveResources: string[]; workspace: Workspace },
) {
  const work = snapshot.work.find(item => item.id === expected.workId);
  if (!work) throw new PrelaunchContainmentError('Fresh Graphyard snapshot no longer contains the work item', false);
  const quarantineOwned = work.containmentQuarantine?.owner === expected.principal
    && work.containmentQuarantine.epoch === expected.epoch
    && work.containmentQuarantine.settlementHash === expected.settlementHash;
  const snapshotTime = Date.parse(snapshot.now);
  const leaseLive = work.lease?.owner === expected.principal && work.lease.epoch === expected.epoch
    && Number.isFinite(snapshotTime) && Date.parse(work.lease.expiresAt) > snapshotTime;
  const authorized = quarantineOwned && leaseLive;
  const workspace = work.workspaces.find(item => item.epoch === expected.epoch);
  const workspaceExact = !!workspace && workspace.owner === expected.workspace.owner && workspace.host === expected.workspace.host
    && workspace.path === expected.workspace.path && workspace.branch === expected.workspace.branch;
  const resourcesExact = JSON.stringify(work.exclusiveResources ?? []) === JSON.stringify(expected.exclusiveResources);
  if (!authorized || !workspaceExact || !resourcesExact)
    throw new PrelaunchContainmentError('Fresh Graphyard snapshot does not authorize this contained worker launch', authorized);
  return work;
}

export function containmentCredentials() {
  const settlementToken = randomBytes(32).toString('hex');
  const settlementHash = createHash('sha256').update(settlementToken).digest('hex');
  const requestId = randomUUID();
  return { settlementToken, settlementHash, requestId };
}

export function isConfirmedCoordinationRefusal(status: number, body: unknown) {
  if (status < 400 || status >= 500 || status === 408 || status === 429 || !body || typeof body !== 'object') return false;
  const error = (body as { error?: unknown }).error;
  return typeof error === 'string' && error.length > 0
    || !!error && typeof error === 'object'
      && typeof (error as { code?: unknown }).code === 'string' && (error as { code: string }).code.length > 0
      && typeof (error as { message?: unknown }).message === 'string' && (error as { message: string }).message.length > 0;
}

export async function establishContainment(
  mutate: (requestId: string) => Promise<any>,
  expected: { epoch: number; settlementHash: string; exclusiveResources: string[]; requestId: string; scope?: ContainmentScope },
  options: { attempts?: number; retryMs?: number } = {},
) {
  const attempts = options.attempts ?? 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await mutate(expected.requestId);
      const quarantine = result?.containmentQuarantine;
      if (quarantine?.epoch !== expected.epoch || quarantine?.settlementHash !== expected.settlementHash
        || JSON.stringify(result?.exclusiveResources ?? []) !== JSON.stringify(expected.exclusiveResources)
        // The record must name the exact scope this supervisor launches into, or settlement
        // could later attribute a neighbour's scope to this assignment.
        || (expected.scope && (quarantine?.scope?.unit !== expected.scope.unit || quarantine?.scope?.pid !== expected.scope.pid)))
        throw new Error('Graphyard returned a mismatched containment quarantine');
      return result;
    } catch (error) {
      if ((error as any)?.confirmedRefusal) throw error;
      lastError = error;
      if (attempt < attempts) await delay(options.retryMs ?? 100);
    }
  }
  throw new Error(`Graphyard could not confirm containment quarantine establishment after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export async function acknowledgeContainment(
  mutate: (requestId: string) => Promise<any>,
  expected: { principal: string; epoch: number; settlementHash: string; exclusiveResources: string[]; requestId: string },
  options: { attempts?: number; retryMs?: number; monotonicNow?: () => number } = {},
) {
  const attempts = options.attempts ?? 3;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const started = monotonicNow();
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await mutate(expected.requestId);
      const quarantine = result?.containmentQuarantine;
      if (result?.lease?.owner !== expected.principal || result?.lease?.epoch !== expected.epoch
        || quarantine?.epoch !== expected.epoch || quarantine?.settlementHash !== expected.settlementHash
        || typeof quarantine?.launchAcknowledgedAt !== 'string'
        || typeof quarantine?.launchExpiresAt !== 'string'
        || typeof result?.lease?.expiresAt !== 'string'
        || JSON.stringify(result?.exclusiveResources ?? []) !== JSON.stringify(expected.exclusiveResources))
        throw new Error('Graphyard returned a mismatched containment launch acknowledgement');
      const authorityMs = Date.parse(quarantine.launchExpiresAt) - Date.parse(result.updatedAt);
      const leaseMs = Date.parse(result.lease.expiresAt) - Date.parse(result.updatedAt);
      const elapsedMs = monotonicNow() - started;
      if (!Number.isFinite(authorityMs) || authorityMs <= 0 || elapsedMs >= authorityMs)
        throw new PrelaunchContainmentError('Graphyard launch authority expired before its acknowledgement response arrived', false);
      if (!Number.isFinite(leaseMs) || leaseMs <= 0 || elapsedMs >= leaseMs)
        throw new PrelaunchContainmentError('Graphyard worker lease expired before its acknowledgement response arrived', false);
      return result;
    } catch (error) {
      if ((error as any)?.confirmedRefusal) throw error;
      lastError = error;
      if (attempt < attempts) await delay(options.retryMs ?? 100);
    }
  }
  throw new Error(`Graphyard could not confirm containment launch acknowledgement after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export async function settleContainment(
  mutate: (requestId: string, body: Readonly<{ epoch: number; settlementToken: string }>) => Promise<any>,
  expected: { epoch: number; settlementToken: string; settlementHash: string; exclusiveResources: string[]; requestId: string },
  options: { attempts?: number; retryMs?: number } = {},
) {
  if (createHash('sha256').update(expected.settlementToken).digest('hex') !== expected.settlementHash)
    throw new Error('Containment settlement capability does not match the established quarantine');
  const body = Object.freeze({ epoch: expected.epoch, settlementToken: expected.settlementToken });
  const attempts = options.attempts ?? 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await mutate(expected.requestId, body);
      if (result?.epoch !== expected.epoch || result?.containmentQuarantine != null
        || JSON.stringify(result?.exclusiveResources ?? []) !== JSON.stringify(expected.exclusiveResources))
        throw new Error('Graphyard returned a mismatched containment settlement');
      return result;
    } catch (error) {
      if ((error as any)?.confirmedRefusal) throw error;
      lastError = error;
      if (attempt < attempts) await delay(options.retryMs ?? 100);
    }
  }
  throw new Error(`Graphyard could not confirm containment settlement after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/**
 * Automatic settlement of a containment quarantine after verified supervisor death.
 *
 * The containment model is unchanged: a quarantine is a fence that only proof can lower.
 * Capability settlement proves the supervisor itself observed its containment empty.
 * This path proves the same thing from the outside, on the registered host, and refuses
 * on every unverifiable signal instead of assuming death. What cannot be proven still
 * requires the operator attestation path.
 */
/** Both the worker lease and the launch authority must have been expired this long. */
export const containmentGraceMs = 120_000;
/** A host verification older than this is no longer evidence about the present. */
export const containmentProbeFreshnessMs = 120_000;
/** Automatic settlement joins two clocks; they must demonstrably agree within this bound. */
export const containmentClockToleranceMs = 5_000;

export const containmentVerificationSchema = z.object({
  method: z.literal('linux-proc-systemd'),
  host: z.string().trim().min(1).max(200),
  uid: z.number().int().min(0),
  platform: z.string().trim().min(1).max(40),
  workspacePath: z.string().startsWith('/').max(1000),
  observedAt: z.iso.datetime(),
  /** Local clock minus control-plane clock, bounded by the read that produced it. */
  clockOffset: z.object({ min: z.number().int().min(-86_400_000).max(86_400_000), max: z.number().int().min(-86_400_000).max(86_400_000) }).strict(),
  processes: z.array(z.object({ pid: z.number().int().positive(), evidence: z.enum(['command', 'workspace']) }).strict()).max(200),
  scopes: z.array(z.object({
    unit: z.string().min(1).max(200), activeState: z.string().min(1).max(40),
    /** Members a live scope still holds that were not attributed to another assignment. */
    processes: z.array(z.number().int().positive()).max(200),
    /** Members that descend from a live supervisor of a different work key or epoch. */
    attributed: z.array(z.number().int().positive()).max(200).default([]),
  }).strict()).max(50),
  /**
   * Every process reported above as holding the fence — a surviving supervisor or workspace
   * process, or a member a live scope still holds — with its command line and working
   * directory (null when unreadable) and the scope it was found in, so the master can verify
   * each one before stopping anything.
   */
  held: z.array(z.object({ pid: z.number().int().positive(), command: z.string().max(500), cwd: z.string().max(1000).nullable(), unit: z.string().max(200).nullable(),
    /** How many live processes name this one as their parent; absent from a probe before GY-189. */
    children: z.number().int().min(0).optional(),
    /** Whether its standard input is a terminal; absent when fd 0 could not be read, and from a probe before GY-189. */
    stdinTerminal: z.boolean().optional(),
    /** Its parent's command line, bounded; absent when it could not be read, and from a probe before GY-413. */
    parent: z.string().max(500).optional(),
    /** Its parent's pid; absent when the process table could not be read, and from a probe before GY-418. */
    parentPid: z.number().int().positive().optional() }).strict()).max(400).default([]),
  /** The scope the quarantine recorded at launch and how systemd reports it now. */
  recordedScope: z.object({ unit: z.string().min(1).max(200), pid: z.number().int().positive(), activeState: z.string().min(1).max(40) }).strict().nullable().default(null),
  /**
   * The recorded implementation session's Herdr pane as Herdr reports it: the pid of the pane's
   * own shell and the terminal's foreground process group (null when Herdr named none). Absent
   * when the pane is gone or could not be read, and from a probe before GY-189.
   */
  paneShell: z.object({ pane: z.string().min(1).max(200), pid: z.number().int().positive(), foregroundGroup: z.number().int().positive().nullable() }).strict().nullable().optional(),
  /**
   * The pid of the process holding Herdr's listening API socket, found among the parents of the
   * held shells whose parent claims to be `herdr server` (GY-418). Absent when none holds it or
   * it could not be read, and from a probe before GY-418; either way no shell is excused as a pane's.
   */
  herdrServer: z.number().int().positive().optional(),
  /** Privileged host processes outside every containment scope that withheld inspection. */
  inaccessible: z.number().int().min(0),
  unverifiable: z.array(z.string().min(1).max(500)).max(50),
}).strict();
export type ContainmentVerification = z.infer<typeof containmentVerificationSchema>;

export const containmentAttestation = (key: string) =>
  `Confirm the previous worker is stopped and use the operator attestation path: rework ${key} --previous-worker-stopped REASON, or recover-containment ${key} --previous-worker-stopped REASON once the work is delivered`;

/** What the master must read before stopping anything: the process's command line and cwd. */
export function heldDetail(verification: Pick<ContainmentVerification, 'held'>, pid: number) {
  const found = verification.held.find(entry => entry.pid === pid);
  return found ? `; pid ${pid} cmdline "${found.command}" cwd ${found.cwd ?? '<unreadable>'}` : '';
}
/** How systemd reports a scope whose supervisor and every process it held have ended. */
export const endedScopeStates = ['not-found', 'inactive', 'failed', 'dead'];
const interactiveShells = ['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh'];
/** Long options that only make a shell interactive or skip its startup files; none takes a value. */
const interactiveLongFlags = ['--login', '--interactive', '--noprofile', '--norc'];
/**
 * An interactive shell by its command line: a shell binary (a login shell's `-bash` too) given
 * only allowlisted flags — short `-i`/`-l` in any cluster, or a long flag above — so it runs no
 * command, script, stdin script or chosen startup file (`--rcfile x`, `--init-file=x`) of its own.
 */
export function isInteractiveShell(command: string) {
  const [binary, ...args] = command.trim().split(/\s+/);
  const name = (binary ?? '').split('/').pop()!.replace(/^-/, '');
  return interactiveShells.includes(name) && args.every(arg => /^-[il]+$/.test(arg) || interactiveLongFlags.includes(arg));
}
/** The Herdr pane of the quarantined epoch's implementation session, as the session ledger recorded it. */
export function recordedPane(work: Pick<Work, 'containmentQuarantine' | 'sessions'>) {
  const quarantine = work.containmentQuarantine;
  if (!quarantine) return null;
  return (work.sessions ?? []).find(entry => entry.kind === 'implementation' && entry.principal === quarantine.owner
    && (entry.epoch === quarantine.epoch || entry.id === `${quarantine.owner}:${quarantine.epoch}`) && entry.pane)?.pane ?? null;
}
/** What `herdr pane process-info --pane PANE` reports about the pane's own shell, or null when it names none. */
export function paneShellReport(pane: string, result: unknown): NonNullable<ContainmentVerification['paneShell']> | null {
  const info = (result as { process_info?: { pane_id?: unknown; shell_pid?: unknown; foreground_process_group_id?: unknown } } | null)?.process_info;
  const positive = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  if (!info || info.pane_id !== pane || !positive(info.shell_pid)) return null;
  return { pane, pid: info.shell_pid as number, foregroundGroup: positive(info.foreground_process_group_id) ? info.foreground_process_group_id as number : null };
}
export interface ProcessTableDeps { listProcesses?: () => string[]; readParent?: (pid: number) => number; readStdin?: (pid: number) => string; readCommand?: (pid: number) => string;
  /** The kernel's table of unix sockets, as /proc/net/unix lists it. */
  readUnixSockets?: () => string;
  /** What each open descriptor of a process links to, as /proc/PID/fd lists it. */
  readDescriptors?: (pid: number) => string[] }
/** Herdr's own server by its command line: the `herdr` binary run as `herdr server`, the parent of every pane's shell. */
export function isHerdrServer(command: string | undefined) {
  const [binary, subcommand] = (command ?? '').trim().split(/\s+/);
  return (binary ?? '').split('/').pop() === 'herdr' && subcommand === 'server';
}
/**
 * Which of `candidates` is Herdr's actual server (GY-418): the process holding the listening unix
 * socket bound at `socket`, the path `herdr status server` reports. A command line is the
 * process's own to write, so `herdr server` in argv alone proves nothing; the listening socket
 * can be held by only the server that bound it, and Herdr opens it close-on-exec, so no pane's
 * process inherits it. Null when no candidate holds it or either table cannot be read.
 */
export function herdrServerPid(socket: string, candidates: number[], deps: ProcessTableDeps = {}) {
  const readUnixSockets = deps.readUnixSockets ?? (() => readFileSync('/proc/net/unix', 'utf8'));
  const readDescriptors = deps.readDescriptors ?? ((pid: number) => readdirSync(`/proc/${pid}/fd`).map(fd => { try { return readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { return ''; } }));
  // Num RefCount Protocol Flags Type St Inode Path: a listener has __SO_ACCEPTCON (0x10000) set and state 01.
  const listening = new Set<string>();
  try {
    for (const line of readUnixSockets().split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 8 || fields.slice(7).join(' ') !== socket) continue;
      if ((Number.parseInt(fields[3], 16) & 0x10000) && fields[5] === '01' && /^\d+$/.test(fields[6])) listening.add(`socket:[${fields[6]}]`);
    }
  } catch { return null; }
  if (!listening.size) return null;
  for (const pid of new Set(candidates)) {
    try { if (readDescriptors(pid).some(link => listening.has(link))) return pid; } catch { /* a candidate that cannot be read is not proven the server */ }
  }
  return null;
}
/** A terminal device a shell reads its prompt from: a pseudo-terminal or a console tty. */
const terminalDevice = /^\/dev\/(pts\/\d+|tty[A-Za-z]*\d+)$/;
/**
 * Counts, on the probing host, the live children of every process a verification reports holding
 * the fence, and records whether its standard input is a terminal, so settlement can tell an idle
 * pane shell from a shell still running something, including one executing a script redirected
 * into it (`bash < script` names no argument). The whole process table must be read: a parent
 * that could not be read leaves every count out, which settlement reads as 'not proven idle'.
 * An fd 0 that cannot be read is left out too, again 'not proven idle'.
 */
export function countHeldChildren<T extends { held: { pid: number }[] }>(verification: T, deps: ProcessTableDeps = {}): Omit<T, 'held'> & { held: (T['held'][number] & { children?: number; stdinTerminal?: boolean; parent?: string; parentPid?: number })[] } {
  if (!verification.held.length) return verification;
  const listProcesses = deps.listProcesses ?? (() => readdirSync('/proc'));
  // The parent is the second field after the command name, which may itself hold spaces or ')'.
  const readParent = deps.readParent ?? ((pid: number) => {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'), parent = Number(stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[1]);
    if (!stat.includes(') ') || !Number.isSafeInteger(parent)) throw new Error(`Process ${pid} reported an unreadable status line`);
    return parent;
  });
  const readStdin = deps.readStdin ?? ((pid: number) => readlinkSync(`/proc/${pid}/fd/0`));
  const readCommand = deps.readCommand ?? ((pid: number) => readFileSync(`/proc/${pid}/cmdline`, 'utf8'));
  const stdinTerminal = (pid: number) => { try { return { stdinTerminal: terminalDevice.test(readStdin(pid)) }; } catch { return {}; } };
  // The parent's command line tells a Herdr pane's own shell (a child of `herdr server`) apart (GY-413).
  const parentCommand = (pid: number) => {
    const parent = parents.get(pid);
    if (parent === undefined) return {};
    try { return { parent: readCommand(parent).split('\0').filter(Boolean).join(' ').slice(0, 500), ...parent > 0 ? { parentPid: parent } : {} }; } catch { return {}; }
  };
  const parents = new Map<number, number>();
  try {
    for (const pid of listProcesses().filter(name => /^\d+$/.test(name)).map(Number)) {
      try { parents.set(pid, readParent(pid)); }
      catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as { code?: string }).code ?? '')) return verification; }
    }
  } catch { return verification; }
  const all = [...parents.values()];
  return { ...verification, held: verification.held.map(entry => ({ ...entry, children: all.filter(parent => parent === entry.pid).length, ...stdinTerminal(entry.pid), ...parentCommand(entry.pid) })) };
}
/**
 * The loop's host probe, annotated for GY-189: each held process's children and stdin, and, when
 * something still holds the fence, what Herdr reports for the recorded session's pane shell. A
 * pane Herdr cannot read is left out, which settlement reads as 'not proven idle'.
 */
export async function annotatePaneShell<T extends { held: { pid: number; command: string; cwd: string | null; unit: string | null }[] }>(verification: T, work: Pick<Work, 'containmentQuarantine' | 'sessions'> | undefined, readPane: (pane: string) => Promise<unknown>, deps?: ProcessTableDeps,
  listPanes?: () => Promise<unknown>, readServerStatus?: () => Promise<unknown>) {
  const report = countHeldChildren(verification, deps);
  if (!report.held.length) return report;
  // GY-418: a shell's parent is Herdr's server only when it holds Herdr's API socket; argv reading
  // `herdr server` alone is something any workspace process can make its own.
  const claimed = report.held.filter(entry => entry.unit === null && entry.children === 0 && isInteractiveShell(entry.command) && isHerdrServer(entry.parent) && entry.parentPid !== undefined);
  const socket = claimed.length && readServerStatus ? await readServerStatus().then(status => (status as { socket?: unknown } | null)?.socket, () => null) : null;
  const server = typeof socket === 'string' && socket.startsWith('/') ? herdrServerPid(socket, claimed.map(entry => entry.parentPid!), deps) : null;
  const served = server === null ? report : { ...report, herdrServer: server };
  const pane = work ? recordedPane(work) : null;
  const recorded = pane ? await readPane(pane).then(result => paneShellReport(pane, result), () => null) : null;
  if (recorded && report.held.some(entry => entry.pid === recorded.pid)) return { ...served, paneShell: recorded };
  // GY-413: a failed launch may leave its pane unrecorded, or the ledger may name another one. An
  // idle interactive shell whose parent is Herdr's server is looked up in Herdr's own inventory:
  // the pane Herdr names as that pid's shell is the pane, never a coordinate the worker wrote.
  const candidates = server === null ? [] : claimed.filter(entry => entry.parentPid === server);
  if (candidates.length && listPanes) {
    const listed = await listPanes().catch(() => null) as { panes?: { pane_id?: unknown; cwd?: unknown }[] } | null;
    for (const entry of Array.isArray(listed?.panes) ? listed.panes : []) {
      if (typeof entry?.pane_id !== 'string' || (typeof entry.cwd === 'string' && !candidates.some(candidate => candidate.cwd === entry.cwd))) continue;
      const shell = await readPane(entry.pane_id).then(result => paneShellReport(entry.pane_id as string, result), () => null);
      if (shell && candidates.some(candidate => candidate.pid === shell.pid)) return { ...served, paneShell: shell };
    }
  }
  return recorded ? { ...served, paneShell: recorded } : served;
}
/**
 * The launch pane's own shell, left in the worktree after `watch` exited (GY-189): the process
 * Herdr reports as the shell of the recorded implementation session's pane, holding its
 * terminal's foreground (no job runs in front of it), matched only by its working directory,
 * outside every containment scope, an interactive shell reading its terminal with no child
 * processes, while systemd reports the recorded supervisor scope ended. The worker ran inside
 * that scope and the pane's shell never did, so with the scope gone and nothing running under the
 * shell there is no worker left for it to be. Any other shell in the worktree, a shell with a
 * child or a foreground job, a shell reading anything but a terminal, a shell a live scope holds,
 * a probe that did not count children, read its stdin or read the pane, or a quarantine without a
 * recorded scope still holds the fence.
 */
function idlePaneShell(work: Pick<Work, 'containmentQuarantine' | 'sessions'>, verification: ContainmentVerification, process: ContainmentVerification['processes'][number]) {
  const quarantine = work.containmentQuarantine;
  if (process.evidence !== 'workspace' || !quarantine) return false;
  const shell = verification.paneShell;
  if (!shell || shell.pid !== process.pid || shell.foregroundGroup !== process.pid) return false;
  const found = verification.held.find(entry => entry.pid === process.pid);
  if (!found || found.unit !== null || found.children !== 0 || found.stdinTerminal !== true || !isInteractiveShell(found.command)
    || verification.scopes.some(scope => scope.processes.includes(process.pid) || scope.attributed.includes(process.pid))) return false;
  const recorded = verification.recordedScope;
  const scopeEnded = !!quarantine.scope && recorded?.unit === quarantine.scope.unit && recorded.pid === quarantine.scope.pid && endedScopeStates.includes(recorded.activeState);
  // GY-189: the recorded session's pane, beside the recorded scope that ended.
  if (scopeEnded && shell.pane === recordedPane(work)) return true;
  // GY-413: the shell Herdr itself names as a pane's, a child of `herdr server` — the process
  // holding Herdr's API socket (GY-418), not merely one whose argv says so — with nothing under
  // it — no supervisor, no runtime — while no supervisor of the assignment runs and the recorded
  // scope, if the launch got as far as one, has ended: the pane a launch left when its runtime
  // never started. Only the supervisor, the runtime or the runtime's descendants are the worker.
  return isHerdrServer(found.parent) && found.parentPid !== undefined && found.parentPid === verification.herdrServer && (scopeEnded || !quarantine.scope) && !verification.processes.some(entry => entry.evidence === 'command');
}
/**
 * The pane the loop may close once its worker's supervisor ended (GY-189): the recorded session's
 * pane only when the host probe established that Herdr's shell for it is the idle shell sitting in
 * this item's worktree, the one settlement excuses. The recorded pane is a coordinate the worker
 * itself can write, so it alone never names a pane to close.
 */
export function closablePane(work: Pick<Work, 'containmentQuarantine' | 'sessions'>, verification: ContainmentVerification) {
  const shell = verification.paneShell;
  const process = shell ? verification.processes.find(entry => entry.pid === shell.pid) : undefined;
  return shell && process && idlePaneShell(work, verification, process) ? shell.pane : null;
}
/**
 * Pure refusal evaluation, shared by the verifying coordinator and the control plane.
 * Every check states what it could not prove; an empty result is the only authorization.
 */
export function containmentSettlementRefusals(
  work: Pick<Work, 'containmentQuarantine' | 'lease' | 'workspaces' | 'sessions'>,
  verification: ContainmentVerification,
  options: { now: number; graceMs?: number; freshnessMs?: number; clockToleranceMs?: number },
): string[] {
  const grace = options.graceMs ?? containmentGraceMs;
  const freshness = options.freshnessMs ?? containmentProbeFreshnessMs;
  const tolerance = options.clockToleranceMs ?? containmentClockToleranceMs;
  const now = options.now;
  const quarantine = work.containmentQuarantine;
  if (!quarantine) return ['No containment quarantine is recorded for this task'];
  const refusals: string[] = [];
  const seconds = (value: number) => Math.round(value / 1000);
  const workspace = work.workspaces.find(item => item.epoch === quarantine.epoch);
  if (!workspace) refusals.push(`Epoch ${quarantine.epoch} registered no workspace, so its supervisor has no verifiable host`);
  else {
    if (workspace.host !== verification.host) refusals.push(`Verification ran on host ${verification.host}; epoch ${quarantine.epoch} is registered on ${workspace.host}`);
    if (workspace.path !== verification.workspacePath) refusals.push(`Verification inspected ${verification.workspacePath}; epoch ${quarantine.epoch} is registered at ${workspace.path}`);
  }
  if (verification.platform !== 'linux') refusals.push(`Supervisor absence was not established by Linux process and scope inspection; the host reports ${verification.platform}`);
  if (work.lease && work.lease.epoch !== quarantine.epoch) refusals.push(`A lease for epoch ${work.lease.epoch} supersedes quarantined epoch ${quarantine.epoch}`);
  // Reconciliation clears an expired lease, so the live record is only sometimes present.
  // The quarantine retains its own deadline; the later of the two is the fence, and a
  // quarantine that records neither cannot prove its grace window has passed at all.
  if (work.lease && !Number.isFinite(Date.parse(work.lease.expiresAt))) refusals.push(`Worker lease for epoch ${work.lease.epoch} carries no readable expiry`);
  const deadlines = [work.lease?.expiresAt, quarantine.leaseExpiresAt].map(value => value ? Date.parse(value) : NaN).filter(Number.isFinite);
  const leaseExpiry = deadlines.length ? Math.max(...deadlines) : null;
  if (leaseExpiry === null) refusals.push(`Quarantined epoch ${quarantine.epoch} records no worker-lease deadline, so its ${seconds(grace)}s grace window cannot be established`);
  else if (!(leaseExpiry + grace <= now)) refusals.push(`Worker lease for epoch ${quarantine.epoch} has not been expired for the required ${seconds(grace)}s grace window`);
  const launchExpiry = quarantine.launchExpiresAt ? Date.parse(quarantine.launchExpiresAt) : null;
  if (launchExpiry !== null && !(launchExpiry + grace <= now)) refusals.push(`Launch authority for epoch ${quarantine.epoch} has not been expired for the required ${seconds(grace)}s grace window`);
  const observed = Date.parse(verification.observedAt);
  if (!Number.isFinite(observed)) refusals.push('Host verification carries no readable observation time');
  else if (observed > now + tolerance) refusals.push('Host verification is dated after the control-plane clock; clocks disagree');
  else if (now - observed > freshness) refusals.push(`Host verification is older than ${seconds(freshness)}s; verify the host again`);
  const { min, max } = verification.clockOffset;
  if (max < min) refusals.push('Host verification reported inconsistent clock bounds');
  else if (max - min > tolerance) refusals.push(`Verifying host could not bound its clock against the control plane within ${tolerance}ms`);
  else if (min > tolerance || max < -tolerance) refusals.push(`Verifying host clock differs from the control plane by more than ${tolerance}ms; clocks disagree`);
  // The verification must have looked for the exact scope the launch recorded, so a probe run
  // against a different record cannot settle this one.
  if (quarantine.scope && (verification.recordedScope?.unit !== quarantine.scope.unit || verification.recordedScope?.pid !== quarantine.scope.pid))
    refusals.push(`Host verification did not inspect recorded containment scope ${quarantine.scope.unit} (supervisor pid ${quarantine.scope.pid}) of epoch ${quarantine.epoch}`);
  for (const failure of verification.unverifiable) refusals.push(`Host verification was incomplete: ${failure}`);
  for (const process of verification.processes) {
    if (idlePaneShell(work, verification, process)) continue;
    refusals.push(`Process ${process.pid} of the contained worker is still present on ${verification.host} (matched by ${process.evidence === 'command' ? 'supervisor command line' : 'assigned workspace'})${heldDetail(verification, process.pid)}`);
  }
  for (const scope of verification.scopes.filter(entry => entry.processes.length))
    refusals.push(`Containment scope ${scope.unit}${quarantine.scope?.unit === scope.unit ? ` (the scope epoch ${quarantine.epoch} was launched in)` : ''} is ${scope.activeState} and still holds ${scope.processes.length} process(es) that are not attributed to another assignment${scope.processes.map(pid => heldDetail(verification, pid)).join('')}`);
  return refusals;
}
