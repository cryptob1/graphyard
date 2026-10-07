// Concern: the worker bound (GY-1460) — an attempt holding its lease past the no-submission bound, read from the item's own record.
import { isClosed } from './closure.js';
import type { Candidate, Work } from './work.js';
import type {} from '../pipeline-speed.js'; // the timeline's `Work.pipeline`

/**
 * GY-1460: the worker bound. An attempt holding its lease this long without a submission is a
 * stalled-gate fault whatever its lease does: a live session renews the lease every cycle, so the
 * lapse-to-containment path that watches lapsed leases and dead sessions never sees it, and a
 * renewed lease alone must never extend the bound silently.
 */
export const workerSubmissionBoundMs = 60 * 60_000;
/** One further bound with still no submission and no progress: the loop stops renewing the lease, ending the attempt through the reclaim path, which returns the item. */
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
  /** The newest submission-progress observation since the claim, if any: when present, older than the cadence. */
  progressAt: string | null;
  /** Past `workerReclaimBoundMs`: the loop stops renewing the lease. */
  reclaim: boolean;
}
const minutes = (ms: number) => Math.floor(ms / 60_000);
/** When the attempt holding `epoch` was claimed, from the assignment or the pipeline timeline. */
function attemptClaimedAt(work: Work, epoch: number): string | null {
  const attempts = work.pipeline?.attempts ?? [];
  const claimed = (work.lastAssignment?.epoch === epoch ? work.lastAssignment.claimedAt : null) ?? attempts.find(attempt => attempt.epoch === epoch)?.claimedAt ?? null;
  return claimed && Number.isFinite(Date.parse(claimed)) ? claimed : null;
}
/**
 * When the loop first observed the candidate's current head (GY-1460): set by the observation
 * write only when the pull request or its head differs from the one recorded, so a routine poll of
 * an unchanged pull request never reads as a push.
 */
export interface HeadObserved { pr: number; sha: string; at: string }
declare module './work.js' { interface Work { headObserved?: HeadObserved } }
export function observeHead(work: Work, candidate: Pick<Candidate, 'pr' | 'sha'>, at: string) {
  if (work.headObserved?.pr !== candidate.pr || work.headObserved.sha !== candidate.sha) work.headObserved = { pr: candidate.pr, sha: candidate.sha, at };
}
/**
 * The newest observation that the attempt is getting its submission out, made since it was claimed:
 * a pull request or head on the attempt's own branch first observed during the attempt, or the
 * attempt's session bound to a new commit. Only a change counts, never a refresh of an unchanged
 * reading: a rework attempt reuses the linked pull request's branch, which every poll observes
 * again, and the loop rewrites a live session's handle on its observation cadence. A session merely
 * observed `working` is not progress either — that observation is what kept the lease renewed.
 */
export function submissionProgressAt(work: Work, epoch: number, owner: string, claimedAt: string): string | null {
  const branch = work.workspaces.find(workspace => workspace.epoch === epoch && workspace.owner === owner)?.branch ?? null;
  const head = work.headObserved, candidate = work.candidate ?? work.observation?.candidate;
  const readings = [
    branch && head && candidate?.branch === branch && candidate.pr === head.pr && candidate.sha === head.sha ? head.at : null,
    ...(work.sessions ?? []).filter(handle => handle.kind === 'implementation' && handle.principal === owner && handle.head && (handle.epoch === epoch || handle.id === `${owner}:${epoch}`)).map(handle => handle.headAt),
  ].filter((at): at is string => !!at && Number.isFinite(Date.parse(at)) && Date.parse(at) >= Date.parse(claimedAt));
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
  // A lease that lapsed inside the bound was never held past it: the lapse and containment path owns that attempt.
  if (Date.parse(lease.expiresAt) - Date.parse(claimedAt) <= workerSubmissionBoundMs) return null;
  const progressAt = submissionProgressAt(work, lease.epoch, lease.owner, claimedAt);
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
    : attempt.live ? `; past the ${minutes(workerReclaimBoundMs)}-minute bound the loop ends the attempt and stops its supervisor, returning ${attempt.key} to the queue with its worktree kept`
      : `; past the ${minutes(workerReclaimBoundMs)}-minute bound the lease lapsed unrenewed, and the reclaim returns ${attempt.key} to the queue with its worktree kept`;
  return `${held} (${renewal})${reclaim}`;
}
