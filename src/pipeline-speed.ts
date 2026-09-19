import type { Work } from './model.js';

/**
 * Pipeline speed: how long an item spends being implemented versus waiting, how many rework
 * rounds it took, and how long its submission took to merge. The engine keeps a small timeline
 * on the work document (`pipeline`) as the lifecycle commands run, so the measurement needs no
 * ledger scan: master status reads it per item and the periodic measurement summarizes it over
 * every delivery. Nothing here decides a gate; it is a report of what the ledger already did.
 *
 * The target behind it (GY-54): a routine item's submit→merge p50 at or under 30 minutes and
 * p90 at or under 60 minutes over at least ten deliveries, a median of at most one rework round,
 * and no hand-off to a master or operator between submit and merge except a genuine finding or a
 * human-only decision. `interventions` counts exactly those hand-offs: a blocked report filed
 * after submission and a requirements revision of a submitted item.
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
declare module './model/work.js' { interface Work { pipeline?: PipelineTimeline } }

export const speedTarget = { submitToMergeP50Ms: 30 * 60_000, submitToMergeP90Ms: 60 * 60_000, reworkRoundsMedian: 1, minimumItems: 10 } as const;

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

export interface PipelineSpeed {
  attempts: number; reworkRounds: number; interventions: PipelineTimeline['interventions'];
  /** Time a worker held the item under a lease, summed over attempts; the active attempt counts up to now. */
  executionMs: number | null;
  /** Time the item was open (first claim to merge, or to now) that no worker was executing it. */
  waitMs: number | null;
  openMs: number | null;
  submittedAt: string | null; mergedAt: string | null;
  /** First submission to the accepted merge; null until delivered. */
  submitToMergeMs: number | null;
  /** First submission to now for an item still in flight; null once delivered. */
  sinceSubmitMs: number | null;
  /** No hand-off after submission and at most one rework round. */
  routine: boolean;
  measured: boolean;
}
const time = (value: string | null | undefined) => { const parsed = value ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? parsed : null; };
/** The accepted merge on the repository clock when the delivery carried it there, else the provider's own timestamp. */
export function acceptedMergeAt(work: Work) {
  return work.stage === 'done' && work.delivery ? work.delivery.mergedAtRepository ?? work.delivery.mergedAt : null;
}
export function pipelineSpeed(work: Work, now: number): PipelineSpeed {
  const timeline = work.pipeline;
  const interventions = { blocked: timeline?.interventions?.blocked ?? 0, requirements: timeline?.interventions?.requirements ?? 0 };
  const reworkRounds = timeline?.reworkRounds ?? 0;
  const mergedAt = acceptedMergeAt(work);
  const end = time(mergedAt) ?? now;
  const submittedAt = timeline?.submittedAt ?? null;
  const submitted = time(submittedAt);
  const unmeasured: PipelineSpeed = { attempts: timeline?.attempts.length ?? 0, reworkRounds, interventions, executionMs: null, waitMs: null, openMs: null, submittedAt, mergedAt,
    submitToMergeMs: null, sinceSubmitMs: null, routine: reworkRounds <= 1 && !interventions.blocked && !interventions.requirements, measured: false };
  if (!timeline?.attempts.length) return unmeasured;
  const claimedAt = Math.min(...timeline.attempts.map(attempt => time(attempt.claimedAt)!).filter(Number.isFinite));
  const executionMs = timeline.attempts.reduce((total, attempt) => total + Math.max(0, Math.min(time(attempt.endedAt) ?? end, end) - (time(attempt.claimedAt) ?? end)), 0);
  const openMs = Math.max(0, end - claimedAt);
  return { ...unmeasured, executionMs, waitMs: Math.max(0, openMs - executionMs), openMs,
    submitToMergeMs: submitted !== null && mergedAt ? Math.max(0, end - submitted) : null,
    sinceSubmitMs: submitted !== null && !mergedAt ? Math.max(0, now - submitted) : null, measured: true };
}

export interface Percentiles { count: number; p50Ms: number; p90Ms: number }
/** Nearest-rank percentiles, the same estimator the master's other latency measurements use. */
export function nearestRankPercentiles(values: number[]): Percentiles {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = (percentile: number) => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentile / 100) - 1))]) : 0;
  return { count: sorted.length, p50Ms: at(50), p90Ms: at(90) };
}

export interface PipelineSpeedSummary {
  target: typeof speedTarget;
  /** Deliveries whose timeline recorded a submission: the population every figure below is over. */
  measured: number;
  /** Deliveries without a recorded submission (they predate the timeline); never counted. */
  unmeasured: number;
  submitToMerge: Percentiles;
  routine: { count: number; submitToMerge: Percentiles };
  reworkRounds: { median: number; p90: number; distribution: Record<string, number> };
  interventions: { items: number; blocked: number; requirements: number };
  execution: { totalMs: number; waitTotalMs: number; share: number | null };
  /** Whether the target is met over routine deliveries; null with the reason while too few are measured. */
  met: boolean | null; reason: string | null;
  items: { key: string; mergedAt: string; submitToMergeMs: number; reworkRounds: number; routine: boolean }[];
}
/**
 * The periodic measurement: submit→merge p50/p90 over every delivery with a recorded submission
 * (and over the routine ones, which the target is stated for), rework-round and intervention
 * counts, and execution versus wait over the same deliveries. Deliveries are ordered by merge time
 * so a report can be split before and after a change shipped.
 */
export function pipelineSpeedSummary(work: Work[], now: number, options: { since?: string | null; until?: string | null } = {}): PipelineSpeedSummary {
  const since = time(options.since), until = time(options.until);
  const delivered = work.filter(item => item.stage === 'done' && item.delivery)
    .map(item => ({ item, speed: pipelineSpeed(item, now), mergedAt: time(acceptedMergeAt(item)) }))
    .filter(({ mergedAt }) => mergedAt !== null && (since === null || mergedAt >= since) && (until === null || mergedAt < until));
  const measured = delivered.filter(({ speed }) => speed.submitToMergeMs !== null).sort((a, b) => a.mergedAt! - b.mergedAt!);
  const routine = measured.filter(({ speed }) => speed.routine);
  const rounds = measured.map(({ speed }) => speed.reworkRounds).sort((a, b) => a - b);
  const rank = (values: number[], percentile: number) => values.length ? values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * percentile / 100) - 1))] : 0;
  const distribution: Record<string, number> = {};
  for (const count of rounds) { const bucket = count >= 2 ? '2+' : String(count); distribution[bucket] = (distribution[bucket] ?? 0) + 1; }
  const totalMs = measured.reduce((total, { speed }) => total + (speed.executionMs ?? 0), 0);
  const waitTotalMs = measured.reduce((total, { speed }) => total + (speed.waitMs ?? 0), 0);
  const submitToMerge = nearestRankPercentiles(measured.map(({ speed }) => speed.submitToMergeMs!));
  const routineSubmitToMerge = nearestRankPercentiles(routine.map(({ speed }) => speed.submitToMergeMs!));
  const intervened = measured.filter(({ speed }) => speed.interventions.blocked || speed.interventions.requirements);
  const enough = routine.length >= speedTarget.minimumItems;
  const met = enough ? routineSubmitToMerge.p50Ms <= speedTarget.submitToMergeP50Ms && routineSubmitToMerge.p90Ms <= speedTarget.submitToMergeP90Ms && rank(rounds, 50) <= speedTarget.reworkRoundsMedian : null;
  const reason = !enough ? `${routine.length} routine deliver${routine.length === 1 ? 'y' : 'ies'} measured; the target is judged over at least ${speedTarget.minimumItems}`
    : met ? null : [routineSubmitToMerge.p50Ms > speedTarget.submitToMergeP50Ms ? `submit→merge p50 ${minutes(routineSubmitToMerge.p50Ms)} exceeds ${minutes(speedTarget.submitToMergeP50Ms)}` : null,
      routineSubmitToMerge.p90Ms > speedTarget.submitToMergeP90Ms ? `submit→merge p90 ${minutes(routineSubmitToMerge.p90Ms)} exceeds ${minutes(speedTarget.submitToMergeP90Ms)}` : null,
      rank(rounds, 50) > speedTarget.reworkRoundsMedian ? `median rework rounds ${rank(rounds, 50)} exceeds ${speedTarget.reworkRoundsMedian}` : null].filter(Boolean).join('; ');
  return { target: speedTarget, measured: measured.length, unmeasured: delivered.length - measured.length, submitToMerge,
    routine: { count: routine.length, submitToMerge: routineSubmitToMerge },
    reworkRounds: { median: rank(rounds, 50), p90: rank(rounds, 90), distribution },
    interventions: { items: intervened.length, blocked: measured.reduce((total, { speed }) => total + speed.interventions.blocked, 0), requirements: measured.reduce((total, { speed }) => total + speed.interventions.requirements, 0) },
    execution: { totalMs, waitTotalMs, share: totalMs + waitTotalMs ? Number((totalMs / (totalMs + waitTotalMs)).toFixed(4)) : null },
    met, reason,
    items: measured.map(({ item, speed }) => ({ key: item.key, mergedAt: speed.mergedAt!, submitToMergeMs: speed.submitToMergeMs!, reworkRounds: speed.reworkRounds, routine: speed.routine })) };
}
const minutes = (ms: number) => `${Math.round(ms / 6000) / 10} min`;
