// Concern: containment quarantines — their phase against the lease, and verifying a supervisor is gone.
import type { Work } from '../model.js';
import { type ContainmentVerification, containmentGraceMs, containmentAttestation, containmentVerificationSchema, containmentSettlementRefusals } from '../quarantine.js';
import { type SupervisorProbe, probeSupervisorAbsence } from '../containment-probe.js';
import { readdirSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { watchAssignment } from '../supervisor.js';
import { watchSupervisorRunning } from './dispatch-reservation.js';

export interface ContainmentAssessment {
  key: string; id: string; epoch: number; owner: string; at: string;
  host: string | null; workspacePath: string | null;
  /** The exact scope unit and supervisor pid the launch recorded, when the supervisor reported them. */
  scope: { unit: string; pid: number } | null;
  settleable: boolean; refusals: string[]; attestation: string;
  verification: ContainmentVerification | null;
}

export type ContainmentPhase =
  | { state: 'live'; owner: string; epoch: number; expiresAt: string }
  | { state: 'grace'; lapsedAt: string; remainingMs: number }
  | { state: 'lapsed'; lapsedAt: string | null };
/**
 * Where a containment quarantine stands against its worker's lease. Every supervised launch
 * records one, so while its owner still holds the quarantined epoch's lease it is a session at
 * work, not something to act on. Once the lease lapses, the grace window runs from the later of
 * the lease and launch deadlines, and only then can supervisor absence be verified.
 */
export function containmentPhase(work: Work, now: number, graceMs = containmentGraceMs): ContainmentPhase | null {
  const quarantine = work.containmentQuarantine;
  if (!quarantine) return null;
  const lease = work.lease;
  if (lease && lease.owner === quarantine.owner && lease.epoch === quarantine.epoch && Date.parse(lease.expiresAt) > now)
    return { state: 'live', owner: lease.owner, epoch: lease.epoch, expiresAt: lease.expiresAt };
  const deadlines = [lease?.epoch === quarantine.epoch ? lease.expiresAt : undefined, quarantine.leaseExpiresAt, quarantine.launchExpiresAt]
    .map(value => value ? Date.parse(value) : NaN).filter(Number.isFinite);
  if (!deadlines.length) return { state: 'lapsed', lapsedAt: null };
  const lapsed = Math.max(...deadlines), lapsedAt = new Date(lapsed).toISOString();
  return lapsed + graceMs > now ? { state: 'grace', lapsedAt, remainingMs: lapsed + graceMs - now } : { state: 'lapsed', lapsedAt };
}
/** Why a quarantined item cannot be dispatched: in progress by its live owner, or unverified containment. */
export function containmentHold(work: Work, now: number): string | null {
  const phase = containmentPhase(work, now);
  if (!phase) return null;
  if (phase.state === 'live') return `${work.key} is in progress by ${phase.owner} under lease epoch ${phase.epoch} (active until ${phase.expiresAt})`;
  return `Dispatch blocked by unverified worker containment from epoch ${work.containmentQuarantine!.epoch}`;
}

/** Quarantines this coordinator could verify: the registered host is the one it runs on. */
export function containmentQuarantines(work: Work[], hostId: string) {
  return work.filter(item => item.containmentQuarantine
    && item.workspaces.some(workspace => workspace.epoch === item.containmentQuarantine!.epoch && workspace.host === hostId));
}

/** Bound the local clock against the control plane with the read that produced the snapshot. */
export async function snapshotWithClock<T extends { now: string }>(read: () => Promise<T>, clock: () => number = Date.now) {
  const before = clock();
  const snapshot = await read();
  const after = clock();
  const server = Date.parse(snapshot.now);
  const bound = (value: number) => Number.isFinite(server) ? Math.round(value - server) : NaN;
  return { snapshot, clockOffset: { min: bound(before), max: bound(after) } };
}

/**
 * Verify on this host that a quarantined supervisor is gone, and say why not when it cannot.
 * The assessment is a proposal: the control plane re-evaluates the same refusals itself.
 */
export async function verifyContainmentDeath(
  work: Work,
  options: { observedAt: string; hostId: string; clockOffset: { min: number; max: number }; localNow?: Date; probe?: SupervisorProbe },
): Promise<ContainmentAssessment> {
  const quarantine = work.containmentQuarantine!;
  const workspace = work.workspaces.find(item => item.epoch === quarantine?.epoch) ?? null;
  const assessment: ContainmentAssessment = {
    key: work.key, id: work.id, epoch: quarantine?.epoch ?? work.epoch, owner: quarantine?.owner ?? '', at: quarantine?.at ?? '',
    host: workspace?.host ?? null, workspacePath: workspace?.path ?? null, scope: quarantine?.scope ?? null,
    settleable: false, refusals: [], attestation: containmentAttestation(work.key), verification: null,
  };
  if (!quarantine) return { ...assessment, refusals: ['No containment quarantine is recorded for this task'] };
  if (!workspace) return { ...assessment, refusals: [`Epoch ${quarantine.epoch} registered no workspace, so its supervisor has no verifiable host`] };
  if (workspace.host !== options.hostId)
    return { ...assessment, refusals: [`Epoch ${quarantine.epoch} is registered on host ${workspace.host}; automatic verification must run there`] };
  const bounded = (value: number) => Number.isInteger(value) && Math.abs(value) <= 86_400_000;
  if (!bounded(options.clockOffset.min) || !bounded(options.clockOffset.max))
    return { ...assessment, refusals: ['The control-plane clock could not be compared with this host'] };
  // The probe is told the exact scope the launch recorded, so it can hold everything that
  // scope still contains and attribute a neighbour's scope to its own live supervisor.
  const probe = await (options.probe ?? probeSupervisorAbsence)({ key: work.key, epoch: quarantine.epoch, workspacePath: workspace.path, scope: quarantine.scope ?? null });
  const localNow = options.localNow ?? new Date();
  const verification = containmentVerificationSchema.parse({ ...probe, host: options.hostId, observedAt: localNow.toISOString(), clockOffset: options.clockOffset });
  // Judged at the control-plane time of the probe, not of the snapshot the cycle began with: the probe
  // runs late in a cycle that can take tens of seconds, and measuring it against the snapshot's time
  // refused every automatic settlement as "dated after the control-plane clock" (2026-09-26).
  // Local time less the smallest measured offset is the latest control-plane time the probe could have run at.
  const refusals = containmentSettlementRefusals(work, verification, { now: Math.max(Date.parse(options.observedAt), localNow.getTime() - options.clockOffset.min) });
  return { ...assessment, settleable: !refusals.length, refusals, verification };
}
/** Verify every lapsed quarantine this host is responsible for, keyed by work id; a live worker's is not probed. */
export async function assessContainment(work: Work[], options: { hostId: string; observedAt: string; clockOffset: { min: number; max: number }; probe?: SupervisorProbe }) {
  const assessments: Record<string, ContainmentAssessment> = {};
  for (const item of containmentQuarantines(work, options.hostId)) {
    if (containmentPhase(item, Date.parse(options.observedAt))?.state === 'live') continue;
    try { assessments[item.id] = await verifyContainmentDeath(item, options); }
    catch (error) {
      assessments[item.id] = { key: item.key, id: item.id, epoch: item.containmentQuarantine!.epoch, owner: item.containmentQuarantine!.owner, at: item.containmentQuarantine!.at,
        host: options.hostId, workspacePath: item.workspaces.find(workspace => workspace.epoch === item.containmentQuarantine!.epoch)?.path ?? null, scope: item.containmentQuarantine!.scope ?? null,
        settleable: false, refusals: [`Host verification could not be completed: ${error instanceof Error ? error.message : String(error)}`],
        attestation: containmentAttestation(item.key), verification: null };
    }
  }
  return assessments;
}

/** How long a failed launch waits for its supervisor to shut down and settle its quarantine (GY-413). */
export const launchSupervisorStopMs = 30_000;
export interface SupervisorStopDeps { list?: () => string[]; readCommand?: (pid: number) => string; kill?: (pid: number, signal: NodeJS.Signals) => void; boundMs?: number; pollMs?: number }
/**
 * Stops the watch supervisor of `KEY EPOCH` on this host, found by its exact command line, and
 * answers whether it is gone within the bound (GY-413). SIGTERM is the supervisor's own shutdown:
 * it stops what it launched, verifies its scope empty and settles its quarantine before it exits,
 * so the pane it leaves behind can be closed without leaving an unverifiable fence (GY-273).
 */
export async function stopLaunchSupervisor(target: { key: string; epoch: number }, deps: SupervisorStopDeps = {}) {
  const list = deps.list ?? (() => readdirSync('/proc')), readCommand = deps.readCommand ?? ((pid: number) => readFileSync(`/proc/${pid}/cmdline`, 'utf8'));
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal); });
  const matching = () => list().filter(name => /^\d+$/.test(name)).map(Number).filter(pid => {
    try { const assignment = watchAssignment(readCommand(pid).split('\0').filter(Boolean)); return assignment?.key === target.key && assignment.epoch === String(target.epoch); }
    catch { return false; }
  });
  for (const pid of matching()) { try { kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  const deadline = Date.now() + (deps.boundMs ?? launchSupervisorStopMs);
  for (;;) {
    if (!watchSupervisorRunning(target, readCommand, list)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(deps.pollMs ?? 250);
  }
}
