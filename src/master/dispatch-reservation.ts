// Runtime liveness and launch history; session reservations live only in the registry.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Work } from '../model.js';
import { watchAssignment } from '../supervisor.js';
import type { WorkerProfile } from './profiles.js';
import type { HerdrAgent } from './herdr.js';
export class DispatchReservedError extends Error {
  readonly dispatchReserved = true;
  constructor(readonly resource: 'profile' | 'work', readonly subject: string, message: string) { super(message); }
}
export const dispatchReserved = (error: unknown): error is DispatchReservedError => (error as { dispatchReserved?: boolean } | null)?.dispatchReserved === true;
export const dispatchReservationDirectory = (root: string) => resolve(root, '.graphyard/dispatch');
export const dispatchedFile = (root: string, key: string) => resolve(dispatchReservationDirectory(root), `dispatched-${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
export const profileLaunchedFile = (root: string, profile: string) => resolve(dispatchReservationDirectory(root), `launched-${profile.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
/**
 * Whether this host runs the watch supervisor of `KEY EPOCH`, read from the process table by the
 * supervisor's exact command line. A host whose table cannot be read answers true: a pane that may
 * hold a running supervisor is not closed.
 */
export function watchSupervisorRunning(target: { key: string; epoch: number }, readCommand: (pid: number) => string = pid => readFileSync(`/proc/${pid}/cmdline`, 'utf8'), list: () => string[] = () => readdirSync('/proc')): boolean {
  let pids: string[];
  try { pids = list().filter(name => /^\d+$/.test(name)); } catch { return true; }
  return pids.some(pid => {
    try { const assignment = watchAssignment(readCommand(Number(pid)).split('\0').filter(Boolean)); return assignment?.key === target.key && assignment.epoch === String(target.epoch); }
    catch { return false; }
  });
}

/** The Herdr states of a launched session whose runtime sits at its prompt with nothing in hand. */
export const finishedAgentStates: readonly string[] = ['idle', 'done'];
type AssignmentView = Pick<Work, 'key' | 'stage' | 'lease'> & { sessions?: { pane?: string | null }[] | null };
/** The live assignment that still owns a launch profile's agent: a lease its principal holds, or one whose session records its pane. */
export function agentAssignment(profile: Pick<WorkerProfile, 'principal'>, agent: Pick<HerdrAgent, 'pane_id'>, work: readonly AssignmentView[], now: number) {
  return work.find(item => item.stage !== 'done' && !!item.lease && Date.parse(item.lease.expiresAt) > now
    && (item.lease.owner === profile.principal || (!!agent.pane_id && (item.sessions ?? []).some(session => session.pane === agent.pane_id)))) ?? null;
}
/**
 * GY-1322. Whether the Herdr agent holding a launch profile's name is a finished session a dispatch
 * bounded-closes and launches over, exactly as it launches on a profile with no agent: Herdr reports
 * it idle or done, it has a pane to close, and no live assignment in the snapshot owns it. When the
 * whole fleet drained, every profile's name was held this way and every dispatch was refused.
 * A working, blocked or unclassified agent, or one a live lease still owns, is never reclaimed.
 */
export function reclaimableAgent(profile: Pick<WorkerProfile, 'mode' | 'principal'>, agent: HerdrAgent | undefined, work: readonly AssignmentView[], now: number): agent is HerdrAgent {
  return profile.mode === 'launch' && !!agent?.pane_id && finishedAgentStates.includes(agent.agent_status ?? '') && !agentAssignment(profile, agent, work, now);
}
