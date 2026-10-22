import type { Work } from './model.js';

/**
 * An item's timeline: its attempts, submissions, rework rounds and hand-offs, kept on the work
 * document (`pipeline`) as the lifecycle commands run, so the item page can show them. Nothing
 * here decides a gate. `interventions` counts hand-offs to a master or operator: a blocked report
 * and a requirements revision of an item under way.
 */
export interface PipelineAttempt {
  epoch: number; owner: string; claimedAt: string; endedAt: string | null;
  /** How the attempt ended: the worker submitted, released, let the lease lapse, or was reworked. */
  end: 'submitted' | 'released' | 'expired' | 'reworked' | null;
}
export interface PipelineTimeline {
  attempts: PipelineAttempt[];
  /** First submission: where the submit→merge clock starts. */
  submittedAt: string | null;
  /** Latest submission, which differs from the first after rework. */
  resubmittedAt: string | null;
  /** Rework requested for an item that had already submitted a candidate. */
  reworkRounds: number;
  /** Hand-offs to a master or operator: blocked reports, and requirements revisions of an item under way. */
  interventions: { blocked: number; requirements: number };
}
declare module './model/work.js' {
  interface Work { pipeline?: PipelineTimeline }
  /**
   * The assignment's first lease renewal (GY-1499). The watch supervisor renews once just before it
   * starts the agent, so claim→start is launch overhead and start→first push the agent's own work.
   */
  interface AssignmentIdentity { startedAt?: string }
}

const emptyTimeline = (): PipelineTimeline => ({ attempts: [], submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } });
/** The item's timeline, created on first use; legacy documents gain one at their next lifecycle command. */
export function pipelineTimeline(work: Work): PipelineTimeline {
  work.pipeline ??= emptyTimeline();
  work.pipeline.interventions ??= { blocked: 0, requirements: 0 };
  return work.pipeline;
}

/** A claim opens an attempt; an earlier attempt still open under another epoch is closed as expired first. */
export function beginAttempt(work: Work, attempt: { epoch: number; owner: string }, now: Date) {
  const timeline = pipelineTimeline(work);
  for (const open of timeline.attempts.filter(entry => entry.endedAt === null)) { open.endedAt = now.toISOString(); open.end = 'expired'; }
  timeline.attempts.push({ epoch: attempt.epoch, owner: attempt.owner, claimedAt: now.toISOString(), endedAt: null, end: null });
}
/** Close the attempt of `epoch` if it is still open; a second end for the same attempt is ignored. */
export function endAttempt(work: Work, epoch: number, end: NonNullable<PipelineAttempt['end']>, at: Date | string) {
  const timeline = pipelineTimeline(work);
  const attempt = timeline.attempts.find(entry => entry.epoch === epoch && entry.endedAt === null);
  if (!attempt) return;
  const ended = typeof at === 'string' ? Date.parse(at) : at.getTime();
  attempt.endedAt = new Date(Math.max(Date.parse(attempt.claimedAt), Number.isFinite(ended) ? ended : Date.parse(attempt.claimedAt))).toISOString();
  attempt.end = end;
}
/**
 * A lapsed lease ends its attempt at the lease's own deadline: the worker was entitled to run
 * until then and no later, whichever command notices the lapse first (reconciliation, a
 * replacement claim or a requirements revision). The end never passes the noticing instant, so
 * execution is never counted past `now` even if a caller reaches here with a deadline ahead of it.
 */
export function endLapsedAttempt(work: Work, lease: { epoch: number; expiresAt: string }, now: Date) {
  const deadline = Date.parse(lease.expiresAt);
  endAttempt(work, lease.epoch, 'expired', new Date(Number.isFinite(deadline) ? Math.min(deadline, now.getTime()) : now.getTime()));
}
/**
 * Stamp the assignment's session start at the first lease renewal of its epoch, once: a later
 * renewal never moves it, and a renewal of another epoch never sets it. An assignment carried
 * forward without its claim time (`preserveAssignment`) was not watched from its claim, so its
 * start is not known either and stays unset.
 */
export function recordAssignmentStart(work: Work, epoch: number, now: Date) {
  const assignment = work.lastAssignment;
  if (!assignment || assignment.epoch !== epoch || !assignment.claimedAt || assignment.startedAt) return;
  assignment.startedAt = now.toISOString();
}
export function recordSubmission(work: Work, epoch: number, now: Date) {
  const timeline = pipelineTimeline(work);
  timeline.submittedAt ??= now.toISOString();
  timeline.resubmittedAt = now.toISOString();
  endAttempt(work, epoch, 'submitted', now);
}
/** Rework of a submitted item is a rework round; rework of an unsubmitted one only ends its attempt. */
export function recordRework(work: Work, now: Date) {
  const timeline = pipelineTimeline(work);
  if (work.lease) endAttempt(work, work.lease.epoch, 'reworked', now);
  if (work.submission) timeline.reworkRounds += 1;
}
/** A blocked report is always a hand-off; a requirements revision is one only once somebody has worked on the item. */
export function recordIntervention(work: Work, kind: keyof PipelineTimeline['interventions']) {
  const timeline = pipelineTimeline(work);
  if (kind === 'requirements' && !timeline.attempts.length) return;
  timeline.interventions[kind] += 1;
}
