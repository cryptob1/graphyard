import type { Work } from './work.js';
import type { SessionHandle } from './sessions.js';

/**
 * Whether a session's launch is still under way, split from `session-state.ts` — the loop's report —
 * by concern: the report leaves a handle these predicates name alone rather than ending or losing it.
 * A session is registered before its runtime starts, so a fresh handle is left alone through
 * `sessionLaunchGraceMs`.
 */
export const sessionLaunchGraceMs = 3 * 60_000;
/** The epoch a worker handle was registered for: its own, or the `PRINCIPAL:EPOCH` its id names. */
export const handleEpoch = (handle: Pick<SessionHandle, 'id' | 'epoch'>) => handle.epoch ?? Number(/:(\d+)$/.exec(handle.id)?.[1]);
/**
 * GY-1287: a worker handle its launcher has not yet given a pane or name, whose attempt's lease
 * stands under the handle's principal, is a launch still preparing — the launch renews that lease
 * until its supervisor's first heartbeat, and the supervisor after — never a vanished session.
 * On 5 October 2026 GY-1235's launch took longer than the launch grace, and the report closed its
 * handle as lost while the worker it was starting went on to hold and renew the lease.
 */
export function launchHeldByLease(work: Pick<Work, 'lease'>, handle: Pick<SessionHandle, 'id' | 'kind' | 'principal' | 'epoch' | 'pane' | 'agentName' | 'state' | 'observed'>, clock: number) {
  const lease = work.lease;
  return handle.kind === 'implementation' && handle.state === 'running' && !handle.observed && !handle.pane && !handle.agentName
    && !!lease && !!handle.principal && lease.owner === handle.principal && handleEpoch(handle) === lease.epoch && Date.parse(lease.expiresAt) > clock;
}
/**
 * GY-1571. A worker handle registered for an attempt the item has not claimed yet. The launcher
 * registers `PRINCIPAL:EPOCH` for the item's next epoch before its claim, so a report reading a
 * snapshot taken between the two sees an attempt holding no lease. On 9 October 2026 that report
 * ended GY-1528's, GY-1566's and GY-1565's fresh worker handles within seconds of registration
 * ("attempt N ... holds no lease"); the claim then landed, and the next observation read the live
 * lease's handle as "Assigned worker session is ended" — three session-liveness faults for three
 * launches that went on to start and submit.
 */
export function unclaimedLaunch(work: Pick<Work, 'epoch' | 'lease'>, handle: Pick<SessionHandle, 'id' | 'kind' | 'epoch'>) {
  if (handle.kind !== 'implementation' || typeof work.epoch !== 'number') return false;
  const epoch = handleEpoch(handle);
  return Number.isFinite(epoch) && epoch > work.epoch && !(work.lease && work.lease.epoch >= epoch);
}
/** A handle nothing has observed yet whose launch is still under way: inside the launch grace, or held by its attempt's lease. */
export function launchingSession(work: Pick<Work, 'lease'>, handle: Pick<SessionHandle, 'id' | 'kind' | 'principal' | 'epoch' | 'pane' | 'agentName' | 'state' | 'observed' | 'startedAt'>, clock: number, grace = sessionLaunchGraceMs) {
  if (handle.state !== 'running' || handle.observed) return false;
  const started = Date.parse(handle.startedAt);
  return (Number.isFinite(started) && clock - started < grace) || launchHeldByLease(work, handle, clock);
}
