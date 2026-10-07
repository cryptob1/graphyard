// Concern: the worker bound (GY-1460) — an attempt holding its lease past the no-submission bound, read from the item's own record.
import { isClosed } from './closure.js';
import type { Work } from './work.js';

/**
 * GY-1460: the worker bound. An attempt holding its lease this long without a submission is a
 * stalled-gate fault whatever its lease does: a live session renews the lease every cycle, so the
 * lapse-to-containment path that watches lapsed leases and dead sessions never sees it, and a
 * renewed lease alone must never extend the bound silently.
 */
export const workerSubmissionBoundMs = 60 * 60_000;
/** One further bound with still no submission and no progress: the loop stops renewing the lease, so the normal lapse, containment and reclaim path returns the item. */
export const workerReclaimBoundMs = 2 * workerSubmissionBoundMs;
/** Submission progress counts while it is no older than the session's reporting cadence (sessionObservationFreshMs). */
export const submissionProgressCadenceMs = 15 * 60_000;

export interface UnsubmittedAttempt {
  key: string; epoch: number; owner: string; claimedAt: string;
  /** How far past the worker bound the attempt is. */
  pastBoundMs: number;
  /** The lease's expiry as read: past the bound, the renewal evidence. */
  leaseExpiresAt: string; live: boolean;
  /** What the loop last observed of the attempt's session, when it did. */
  session: { state: string; at: string } | null;
  /** The newest submission-progress observation, older than the cadence, if any. */
  progressAt: string | null;
  /** Past `workerReclaimBoundMs`: the loop stops renewing the lease. */
  reclaim: boolean;
}
const minutes = (ms: number) => Math.floor(ms / 60_000);
/** When the attempt holding `epoch` was claimed, from the assignment or the pipeline timeline. */
function attemptClaimedAt(work: Work, epoch: number): string | null {
  const attempts = (work as Work & { pipeline?: { attempts?: { epoch: number; claimedAt?: string | null }[] } }).pipeline?.attempts ?? [];
  const claimed = (work.lastAssignment?.epoch === epoch ? work.lastAssignment.claimedAt : null) ?? attempts.find(attempt => attempt.epoch === epoch)?.claimedAt ?? null;
  return claimed && Number.isFinite(Date.parse(claimed)) ? claimed : null;
}
/**
 * The newest observation that the attempt is getting its submission out: a pull request observed
 * on the attempt's own branch, or the attempt's session bound to a commit it pushed. A session
 * merely observed `working` is not progress — that observation is what kept the lease renewed.
 */
export function submissionProgressAt(work: Work, epoch: number, owner: string): string | null {
  const branch = work.workspaces.find(workspace => workspace.epoch === epoch && workspace.owner === owner)?.branch ?? null;
  const readings = [
    branch && work.observation && work.observation.candidate?.branch === branch ? work.observation.at : null,
    ...(work.sessions ?? []).filter(handle => handle.kind === 'implementation' && handle.principal === owner && handle.head && (handle.epoch === epoch || handle.id === `${owner}:${epoch}`)).map(handle => handle.updatedAt),
  ].filter((at): at is string => !!at && Number.isFinite(Date.parse(at)));
  return readings.sort().at(-1) ?? null;
}
/**
 * The attempt holding `work`'s lease past the worker bound with no submission, or null (GY-1460).
 * Null inside the bound, once the attempt has submitted (or resubmitted) under its epoch, and while
 * a submission-progress observation is inside the cadence.
 */
export function unsubmittedAttempt(work: Work, now: number): UnsubmittedAttempt | null {
  const lease = work.lease;
  if (!lease || work.stage === 'done' || isClosed(work) || work.submission?.epoch === lease.epoch) return null;
  const claimedAt = attemptClaimedAt(work, lease.epoch);
  if (!claimedAt) return null;
  const pastBoundMs = now - Date.parse(claimedAt) - workerSubmissionBoundMs;
  if (pastBoundMs <= 0) return null;
  const progressAt = submissionProgressAt(work, lease.epoch, lease.owner);
  if (progressAt && now - Date.parse(progressAt) <= submissionProgressCadenceMs) return null;
  const handle = (work.sessions ?? []).find(entry => entry.kind === 'implementation' && entry.id === `${lease.owner}:${lease.epoch}`);
  const observed = handle?.observed && handle.observedAt ? { state: handle.observed, at: handle.observedAt } : handle ? { state: handle.state, at: handle.updatedAt } : null;
  return { key: work.key, epoch: lease.epoch, owner: lease.owner, claimedAt, pastBoundMs, leaseExpiresAt: lease.expiresAt, live: Date.parse(lease.expiresAt) > now,
    session: observed, progressAt, reclaim: now - Date.parse(claimedAt) > workerReclaimBoundMs };
}
/** The fault line for an attempt past the worker bound: key, epoch, minutes past the bound, the renewal evidence and, past the reclaim bound, the reclaim. */
export function unsubmittedAttemptText(attempt: UnsubmittedAttempt): string {
  const held = `${attempt.key} epoch ${attempt.epoch} (${attempt.owner}) has held its lease ${minutes(attempt.pastBoundMs)} minutes past the ${minutes(workerSubmissionBoundMs)}-minute worker bound without a submission`;
  const renewal = `claimed at ${attempt.claimedAt}, lease ${attempt.live ? 'renewed to' : 'lapsed at'} ${attempt.leaseExpiresAt}${attempt.session ? `, session last observed ${attempt.session.state} at ${attempt.session.at}` : ''}${attempt.progressAt ? `, last submission progress at ${attempt.progressAt}` : ', no submission progress observed'}`;
  const reclaim = !attempt.reclaim ? `; past ${minutes(workerReclaimBoundMs)} minutes with no submission the loop stops renewing the lease`
    : attempt.live ? `; past the ${minutes(workerReclaimBoundMs)}-minute reclaim bound, the loop stops renewing the lease (it stops the attempt's supervisor) so the lapse, containment and reclaim path returns ${attempt.key} to the queue with its worktree kept`
      : `; past the ${minutes(workerReclaimBoundMs)}-minute reclaim bound the lease was not renewed and lapsed, and the reclaim and containment settlement return ${attempt.key} to the queue with its worktree kept`;
  return `${held} (${renewal})${reclaim}`;
}
