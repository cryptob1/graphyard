// Concern: the worker bound (GY-1460) — an attempt holding its lease past the no-submission bound, read from the item's own record.
import { isClosed } from './closure.js';
import type { Candidate, Lease, Work } from './work.js'; // the timeline's `Work.pipeline`

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
/** How fresh worktree progress must be to extend the attempt past its bound (GY-2961): the loop records the attempt worktree's new commit or changed files on the session handle, and a stop needs this many minutes without either. */
export const attemptProgressWindowMs = 20 * 60_000;

export interface UnsubmittedAttempt {
  key: string; epoch: number; owner: string; claimedAt: string;
  /** Where the bound runs from: the claim. */
  boundFrom: string;
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
/** When the attempt holding `epoch` was claimed, from the assignment or the pipeline timeline. */
export function attemptClaimedAt(work: Work, epoch: number): string | null {
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
 * The attempt's worktree progress (GY-2961): the newest reading the loop recorded on one of the
 * attempt's session handles since it was claimed — a new commit or changed files in the assigned
 * worktree, observed by the loop that supervises the session.
 */
export function worktreeProgressAt(work: Work, epoch: number, owner: string, claimedAt: string): string | null {
  return (work.sessions ?? [])
    .filter(handle => handle.kind === 'implementation' && handle.principal === owner && (handle.epoch === epoch || handle.id === `${owner}:${epoch}`))
    .map(handle => handle.workTree?.at)
    .filter((at): at is string => !!at && Number.isFinite(Date.parse(at)) && Date.parse(at) >= Date.parse(claimedAt))
    .sort().at(-1) ?? null;
}
/**
 * Whether the attempt shows fresh progress of either kind (GY-2961): a submission observation
 * inside its cadence, or worktree progress inside the window. Either extends the attempt past
 * its no-submission bound; the ceiling still ends it.
 */
export function attemptProgressFresh(work: Work, epoch: number, owner: string, claimedAt: string, now: number): boolean {
  const submitted = submissionProgressAt(work, epoch, owner, claimedAt);
  if (submitted && now - Date.parse(submitted) <= submissionProgressCadenceMs) return true;
  const tree = worktreeProgressAt(work, epoch, owner, claimedAt);
  return !!tree && now - Date.parse(tree) <= attemptProgressWindowMs;
}

/**
 * The attempt holding `work`'s lease past the worker bound with no submission, or null (GY-1460).
 * Null inside the bound, once the attempt has submitted (or resubmitted) under its epoch, and
 * while progress of either kind is fresh (GY-2961).
 */
export function unsubmittedAttempt(work: Work, now: number): UnsubmittedAttempt | null {
  const lease = work.lease;
  if (!lease || work.stage === 'done' || isClosed(work) || work.submission?.epoch === lease.epoch) return null;
  const claimedAt = attemptClaimedAt(work, lease.epoch);
  const boundFrom = claimedAt;
  if (!boundFrom) return null;
  const pastBoundMs = now - Date.parse(boundFrom) - workerSubmissionBoundMs;
  if (pastBoundMs <= 0) return null;
  // A lease that lapsed inside the bound was never held past it: the lapse and containment path owns that attempt.
  if (Date.parse(lease.expiresAt) - Date.parse(boundFrom) <= workerSubmissionBoundMs) return null;
  const progressAt = [submissionProgressAt(work, lease.epoch, lease.owner, claimedAt), worktreeProgressAt(work, lease.epoch, lease.owner, claimedAt)]
    .filter((at): at is string => !!at).sort().at(-1) ?? null;
  if (attemptProgressFresh(work, lease.epoch, lease.owner, claimedAt, now)) return null;
  const handle = (work.sessions ?? []).find(entry => entry.kind === 'implementation' && entry.id === `${lease.owner}:${lease.epoch}`);
  const observed = handle?.observed && handle.observedAt ? { state: handle.observed, at: handle.observedAt } : handle ? { state: handle.state, at: handle.updatedAt } : null;
  return { key: work.key, epoch: lease.epoch, owner: lease.owner, claimedAt, boundFrom, pastBoundMs, leaseExpiresAt: lease.expiresAt, live: Date.parse(lease.expiresAt) > now,
    session: observed, progressAt, reclaim: now - Date.parse(boundFrom) > workerReclaimBoundMs };
}
/**
 * The server's backstop to the worker bound (GY-1462): the loop ends an attempt past
 * `workerReclaimBoundMs` with no submission and no fresh submission progress (GY-1460), and ten
 * minutes later the server refuses its renewals, so with no loop to end it the lease lapses into
 * containment and reclaim. Like every no-submission bound, it derives from `workerSubmissionBoundMs` here.
 */
export const workerNoSubmissionRefusalMs = workerReclaimBoundMs + 10 * 60_000;
/** Whether `work`'s attempt is past the renewal refusal: past the worker bound unsubmitted, with no fresh submission progress, held `workerNoSubmissionRefusalMs` since the bound started. */
export function noSubmissionRenewalRefused(work: Work, now: number): boolean {
  const attempt = unsubmittedAttempt(work, now);
  return !!attempt && now - Date.parse(attempt.boundFrom) >= workerNoSubmissionRefusalMs;
}
/**
 * Whether a lapsed `lease` ran to the no-submission refusal unsubmitted: its last renewal kept it
 * past the point from which the server refuses renewals, with no submission progress inside the
 * cadence at its expiry, so it lapsed on that refusal (renewals come well inside the lease, so a
 * lease expiring past the refusal was renewed up to it).
 */
export function lapsedAtNoSubmissionBound(work: Pick<Work, 'submission'> & Partial<Work>, lease: Pick<Lease, 'epoch'> & Partial<Pick<Lease, 'expiresAt' | 'owner'>>): boolean {
  if (work.submission?.epoch === lease.epoch || !lease.expiresAt || !work.workspaces) return false;
  const assignment = work.lastAssignment?.epoch === lease.epoch ? work.lastAssignment.claimedAt : null;
  const claimedAt = assignment ?? work.pipeline?.attempts?.find(attempt => attempt.epoch === lease.epoch)?.claimedAt ?? null;
  const expiresAt = Date.parse(lease.expiresAt);
  const boundFrom = claimedAt && Number.isFinite(Date.parse(claimedAt)) ? claimedAt : null;
  if (!claimedAt || !boundFrom || expiresAt - Date.parse(boundFrom) < workerNoSubmissionRefusalMs) return false;
  return !attemptProgressFresh(work as Work, lease.epoch, lease.owner ?? '', claimedAt, expiresAt);
}
