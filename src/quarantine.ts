import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
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
    children: z.number().int().min(0).optional() }).strict()).max(400).default([]),
  /** The scope the quarantine recorded at launch and how systemd reports it now. */
  recordedScope: z.object({ unit: z.string().min(1).max(200), pid: z.number().int().positive(), activeState: z.string().min(1).max(40) }).strict().nullable().default(null),
  /**
   * The recorded implementation session's Herdr pane as Herdr reports it: the pid of the pane's
   * own shell and the terminal's foreground process group (null when Herdr named none). Absent
   * when the pane is gone or could not be read, and from a probe before GY-189.
   */
  paneShell: z.object({ pane: z.string().min(1).max(200), pid: z.number().int().positive(), foregroundGroup: z.number().int().positive().nullable() }).strict().nullable().optional(),
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
/**
 * An interactive shell by its command line: a shell binary (a login shell's `-bash` too) given
 * only option flags, none of them `-c` or `-s`, so it runs no command, script or stdin script of its own.
 */
export function isInteractiveShell(command: string) {
  const [binary, ...args] = command.trim().split(/\s+/);
  const name = (binary ?? '').split('/').pop()!.replace(/^-/, '');
  return interactiveShells.includes(name) && args.every(arg => /^-/.test(arg) && !/^-[A-Za-z]*[cs]/.test(arg) && arg !== '--' && arg !== '-');
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
export interface ProcessTableDeps { listProcesses?: () => string[]; readParent?: (pid: number) => number }
/**
 * Counts, on the probing host, the live children of every process a verification reports holding
 * the fence, so settlement can tell an idle pane shell from a shell still running something. The
 * whole process table must be read: a parent that could not be read leaves every count out, which
 * settlement reads as 'not proven idle'. Parentage is world-readable, as the probe's ancestry is.
 */
export function countHeldChildren<T extends { held: { pid: number }[] }>(verification: T, deps: ProcessTableDeps = {}): Omit<T, 'held'> & { held: (T['held'][number] & { children?: number })[] } {
  if (!verification.held.length) return verification;
  const listProcesses = deps.listProcesses ?? (() => readdirSync('/proc'));
  // The parent is the second field after the command name, which may itself hold spaces or ')'.
  const readParent = deps.readParent ?? ((pid: number) => {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'), parent = Number(stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[1]);
    if (!stat.includes(') ') || !Number.isSafeInteger(parent)) throw new Error(`Process ${pid} reported an unreadable status line`);
    return parent;
  });
  const parents: number[] = [];
  try {
    for (const pid of listProcesses().filter(name => /^\d+$/.test(name)).map(Number)) {
      try { parents.push(readParent(pid)); }
      catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as { code?: string }).code ?? '')) return verification; }
    }
  } catch { return verification; }
  return { ...verification, held: verification.held.map(entry => ({ ...entry, children: parents.filter(parent => parent === entry.pid).length })) };
}
/**
 * The launch pane's own shell, left in the worktree after `watch` exited (GY-189): the process
 * Herdr reports as the shell of the recorded implementation session's pane, holding its
 * terminal's foreground (no job runs in front of it), matched only by its working directory,
 * outside every containment scope, an interactive shell with no child processes, while systemd
 * reports the recorded supervisor scope ended. The worker ran inside that scope and the pane's
 * shell never did, so with the scope gone and nothing running under the shell there is no
 * worker left for it to be. Any other shell in the worktree, a shell with a child or a
 * foreground job, a shell a live scope holds, a probe that did not count children or read the
 * pane, or a quarantine without a recorded scope still holds the fence.
 */
function paneShell(work: Pick<Work, 'containmentQuarantine' | 'sessions'>, verification: ContainmentVerification, process: ContainmentVerification['processes'][number]) {
  const quarantine = work.containmentQuarantine;
  if (process.evidence !== 'workspace' || !quarantine?.scope) return false;
  const recorded = verification.recordedScope;
  if (recorded?.unit !== quarantine.scope.unit || recorded.pid !== quarantine.scope.pid || !endedScopeStates.includes(recorded.activeState)) return false;
  const shell = verification.paneShell, pane = recordedPane(work);
  if (!shell || !pane || shell.pane !== pane || shell.pid !== process.pid || shell.foregroundGroup !== process.pid) return false;
  const found = verification.held.find(entry => entry.pid === process.pid);
  return !!found && found.unit === null && found.children === 0 && isInteractiveShell(found.command)
    && !verification.scopes.some(scope => scope.processes.includes(process.pid) || scope.attributed.includes(process.pid));
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
    if (paneShell(work, verification, process)) continue;
    refusals.push(`Process ${process.pid} of the contained worker is still present on ${verification.host} (matched by ${process.evidence === 'command' ? 'supervisor command line' : 'assigned workspace'})${heldDetail(verification, process.pid)}`);
  }
  for (const scope of verification.scopes.filter(entry => entry.processes.length))
    refusals.push(`Containment scope ${scope.unit}${quarantine.scope?.unit === scope.unit ? ` (the scope epoch ${quarantine.epoch} was launched in)` : ''} is ${scope.activeState} and still holds ${scope.processes.length} process(es) that are not attributed to another assignment${scope.processes.map(pid => heldDetail(verification, pid)).join('')}`);
  return refusals;
}
