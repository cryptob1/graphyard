import type { Work } from './model.js';
import { currentMergeStep, type CurrentMergeStep } from './model/merge-ledger.js';
import { startupFailureBlocker } from './model/plain-status.js';

/**
 * An item's timeline: its attempts, submissions, rework rounds and hand-offs, kept on the work
 * document (`pipeline`) as the lifecycle commands run, so the item page can show them. Nothing
 * here decides a gate. `interventions` counts hand-offs to a master or operator: a blocked report
 * and a requirements revision of an item under way.
 */
export interface PipelineAttempt {
  epoch: number; owner: string; claimedAt: string; endedAt: string | null;
  /** The watch supervisor's release reason, retained with the attempt. */
  cause?: string;
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
  /** GY-2963: the merge trial's current step and elapsed time, attached when the item's head is read in flight; never stored. */
  merge?: PipelineMerge | null;
}
declare module './model/work.js' {
  interface Work { pipeline?: PipelineTimeline }
  /**
   * The assignment's first lease renewal (GY-1499). The watch supervisor renews once just before it
   * starts the agent, so claim→start is launch overhead and start→first push the agent's own work.
   */
  interface AssignmentIdentity { startedAt?: string }
}

/** GY-2963: the merge trial step a read of the item names, with the step's elapsed time. */
export type PipelineMerge = CurrentMergeStep & { stepMs: number };
/**
 * The merge in flight for `work`, as its pipeline reports it (GY-2963): the trial's current step
 * and its elapsed time, `stalled` once no step has advanced within the stall bound. Null when the
 * item's head is not in flight on the merge writer.
 */
export function mergePipeline(work: Pick<Work, 'candidate' | 'mergeLedger'>, now: number): PipelineMerge | null {
  const step = currentMergeStep(work, now);
  return step ? { ...step, stepMs: Math.max(0, now - step.atMs) } : null;
}
/**
 * `status GY-N`'s view of the item: the record with `pipeline.merge` attached when its head is in
 * flight on the merge writer (GY-2963), so the pipeline names the current step and its elapsed
 * time instead of a bare gate refusal.
 */
export function withMergePipeline<T extends Pick<Work, 'candidate' | 'mergeLedger' | 'pipeline'>>(work: T, now = Date.now()): T {
  const merge = mergePipeline(work, now);
  return merge ? { ...work, pipeline: { ...work.pipeline, merge } } : work;
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
export function endAttempt(work: Work, epoch: number, end: NonNullable<PipelineAttempt['end']>, at: Date | string, cause?: string) {
  const timeline = pipelineTimeline(work);
  const attempt = timeline.attempts.find(entry => entry.epoch === epoch && entry.endedAt === null);
  if (!attempt) return;
  const ended = typeof at === 'string' ? Date.parse(at) : at.getTime();
  attempt.endedAt = new Date(Math.max(Date.parse(attempt.claimedAt), Number.isFinite(ended) ? ended : Date.parse(attempt.claimedAt))).toISOString();
  attempt.end = end;
  if (cause) attempt.cause = cause;
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
  stopStartupLoop(work, now);
}

/**
 * GY-3510: three claims in a row that each expired within 5 minutes of claiming mean the workers
 * die at startup, so the item is blocked — dispatch stops — naming the last worker's exit reason.
 * A submitted, released or longer attempt among the last three breaks the run.
 */
function stopStartupLoop(work: Work, now: Date) {
  const last = pipelineTimeline(work).attempts.slice(-3);
  if (work.blocker || last.length < 3 || !last.every(a => a.end === 'expired' && Date.parse(a.endedAt!) - Date.parse(a.claimedAt) <= 5 * 60_000)) return;
  const epoch = last[2]!.epoch;
  const exit = work.sessions?.findLast(s => s.kind === 'implementation' && s.epoch === epoch && s.outcome)?.outcome ?? last[2]!.cause ?? 'the worker exited without a reason';
  work.blocker = startupFailureBlocker + exit.replace(/\s+/g, ' ').trim().slice(0, 300);
  work.blockedAt = now.toISOString();
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

/** GY-3105: delivery speed, computed at query time from the event ledger for the last merged items; nothing is stored. */
export const deliverySpeedStages = ['ready', 'build', 'review', 'test', 'acceptance', 'merge'] as const;
export const deliverySpeedWindow = 50;
export interface SpeedEvent { kind: string; created_at: string; payload?: { work?: { stage?: string } } }
/** `events` is the item's whole ledger, or null when it could not be read. */
export interface MergedItem { key: string; mergedAt: string; attempts: number; events: SpeedEvent[] | null }
export interface Spread { median: number; p90: number; samples: number }

const nearestRank = (sorted: number[], fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
const minutes = (ms: number) => Math.round(ms / 6000) / 10;
/** Median and p90 in minutes of `values` (milliseconds); null when there are none. */
export function spread(values: number[]): Spread | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { median: minutes(nearestRank(sorted, 0.5)), p90: minutes(nearestRank(sorted, 0.9)), samples: sorted.length };
}

/** The item's time from its first `ready` event to its merge, and the time it spent in each stage, from the stage each event's snapshot records. */
export function itemSpeed(item: MergedItem) {
  if (!item.events) return null;
  const merged = Date.parse(item.mergedAt);
  const events = item.events.map(event => ({ at: Date.parse(event.created_at), stage: event.payload?.work?.stage })).sort((a, b) => a.at - b.at);
  const start = item.events.map(event => ({ kind: event.kind, at: Date.parse(event.created_at) })).filter(event => event.kind === 'ready').map(event => event.at).sort((a, b) => a - b)[0];
  if (start === undefined || !Number.isFinite(merged) || merged < start) return null;
  const stages: Record<string, number> = {};
  let stage: string | undefined, since = start;
  for (const event of events.filter(entry => entry.at >= start && entry.at <= merged)) {
    if (stage) stages[stage] = (stages[stage] ?? 0) + event.at - since;
    since = event.at; stage = event.stage ?? stage;
  }
  if (stage) stages[stage] = (stages[stage] ?? 0) + merged - since;
  return { releaseToMerge: merged - start, stages };
}

/** The `master status` delivery-speed section over `merged` (any order; the last 50 by merge time are read) and the open items. */
export function deliverySpeed(merged: MergedItem[], open: Pick<Work, 'key' | 'stage' | 'stageEnteredAt'>[], now: number) {
  const items = [...merged].sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt)).slice(0, deliverySpeedWindow);
  const speeds = items.map(item => ({ item, speed: itemSpeed(item) }));
  const measured = speeds.flatMap(entry => entry.speed ? [entry.speed] : []);
  // Items whose ledger could not be read, or holds no release, are left out of the spreads and named.
  const unmeasured = speeds.filter(entry => !entry.speed).map(entry => entry.item.key);
  const longest = open.filter(item => Number.isFinite(Date.parse(item.stageEnteredAt))).sort((a, b) => Date.parse(a.stageEnteredAt) - Date.parse(b.stageEnteredAt))[0];
  return {
    items: items.length,
    readyToMerge: spread(measured.map(speed => speed.releaseToMerge)),
    stages: Object.fromEntries(deliverySpeedStages.map(stage => [stage, spread(measured.flatMap(speed => stage in speed.stages ? [speed.stages[stage]] : []))])),
    unmeasured,
    attempts: Object.fromEntries(items.map(item => [item.key, item.attempts])),
    longestWait: longest ? { key: longest.key, stage: longest.stage, minutes: minutes(now - Date.parse(longest.stageEnteredAt)) } : null,
  };
}

/**
 * GY-3527: the Work page's speed line, served on /api/status. Median and slowest-tenth minutes
 * from release (the item's first `ready` event) to merge over the last 10 merges, the last merge
 * time, and the open released item released longest ago. `released` maps item id to release time.
 */
export interface PipelineTime {
  median: number | null; p90: number | null; samples: number; lastMergeAt: string | null;
  oldest: { id: string; key: string; title: string; stage: string; releasedAt: string } | null;
}
const mergeTime = (item: Pick<Work, 'delivery' | 'observation'>) => item.delivery?.mergedAt ?? item.observation?.mergedAt ?? null;
type Timed = Pick<Work, 'id' | 'key' | 'title' | 'stage' | 'delivery' | 'observation'>;
const lastMerges = <T extends Timed>(work: T[]) => work.filter(item => item.stage === 'done' && mergeTime(item)).sort((a, b) => Date.parse(mergeTime(b)!) - Date.parse(mergeTime(a)!)).slice(0, 10);
/** The items whose release times the speed line reads: the last 10 merges and every released open item. */
export const pipelineItems = <T extends Timed>(work: T[]) => [...lastMerges(work), ...work.filter(item => !['backlog', 'done'].includes(item.stage))];
export function pipelineTime(work: Timed[], released: Map<string, number>): PipelineTime {
  const merged = lastMerges(work);
  const times = merged.flatMap(item => released.has(item.id) ? [Date.parse(mergeTime(item)!) - released.get(item.id)!] : []).filter(ms => ms >= 0);
  const time = spread(times);
  const open = work.filter(item => !['backlog', 'done'].includes(item.stage) && released.has(item.id)).sort((a, b) => released.get(a.id)! - released.get(b.id)!)[0];
  return { median: time?.median ?? null, p90: time?.p90 ?? null, samples: times.length, lastMergeAt: merged[0] ? mergeTime(merged[0]) : null,
    oldest: open ? { id: open.id, key: open.key, title: open.title, stage: open.stage, releasedAt: new Date(released.get(open.id)!).toISOString() } : null };
}

/** "42 min", "1 h", "2 h 5 min". */
export function plainDuration(minutes: number) {
  const total = Math.max(0, Math.round(minutes)), hours = Math.floor(total / 60), rest = total % 60;
  return hours ? `${hours} h${rest ? ` ${rest} min` : ''}` : `${rest} min`;
}
const stageWords: Record<string, string> = { ready: 'waiting for a worker', build: 'being built', review: 'in review', test: 'in its merge trial', acceptance: 'waiting on proof', merge: 'merging' };

/**
 * The Work page's one sentence: a calm line with the median, the slowest tenth and the last merge;
 * or a warning naming the oldest item in the pipeline, its stage and the one next action, when the
 * last merge is over three times the median old or that item has run past the slowest tenth.
 */
export function pipelineSentence(time: PipelineTime, now: number): { warning: boolean; text: string; open?: string } {
  if (time.median === null || time.p90 === null || !time.lastMergeAt) return { warning: false, text: 'No merges to time yet.' };
  const sinceMerge = (now - Date.parse(time.lastMergeAt)) / 60_000;
  const oldest = time.oldest, age = oldest ? (now - Date.parse(oldest.releasedAt)) / 60_000 : 0;
  const next = oldest ? ` Next: open ${oldest.key} and clear what holds it.` : '';
  if (sinceMerge > 3 * time.median) {
    const named = oldest ? ` Oldest: ${oldest.key} ${oldest.title}, ${stageWords[oldest.stage] ?? oldest.stage}.${next}` : ' Nothing is in the pipeline. Next: release an item.';
    return { warning: true, text: `No merge for ${plainDuration(sinceMerge)}, over three times the usual ${plainDuration(time.median)}.${named}`, ...(oldest ? { open: oldest.id } : {}) };
  }
  if (oldest && age > time.p90) return { warning: true, open: oldest.id,
    text: `${oldest.key} ${oldest.title} has been in the pipeline ${plainDuration(age)}, longer than the slowest tenth (${plainDuration(time.p90)}); it is ${stageWords[oldest.stage] ?? oldest.stage}.${next}` };
  return { warning: false, text: `An item takes ${plainDuration(time.median)} from release to merge (slowest tenth ${plainDuration(time.p90)}). Last merge ${plainDuration(sinceMerge)} ago.` };
}
