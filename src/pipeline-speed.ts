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
  /** Present once the timeline was reconstructed from the ledger for an item that predates it. */
  backfill?: TimelineBackfill;
}
/**
 * What a reconstruction read. `retained` is false when the item's own creation event is no longer
 * in the ledger, so the timeline starts mid-life and its figures are a floor, not a measurement.
 * `truncated` is true only while a reconstruction is unfinished: one pass reads a bounded number
 * of rows, records where the replay stood (`resume`) and is continued from `toEvent` by the next,
 * so a ledger of any length is read to its end and the timeline is written once it has been.
 */
export interface TimelineBackfill {
  at: string; source: 'ledger'; events: number; fromEvent: string | null; toEvent: string | null;
  retained: boolean; truncated: boolean;
  /** Bounded passes this reconstruction has taken so far. */
  passes?: number;
  /** The replay as the last pass left it; present only while `truncated`. */
  resume?: ReplayState;
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

/**
 * One ledger row as a reconstruction reads it. `payload.work` is never the whole embedded
 * document: the replay reads `updatedAt`, `lease` and `submission` from it and nothing else, so
 * the backfill projects exactly those paths in SQL (`ledgerReplayColumns`) and a test or a caller
 * holding a full event row may pass that instead.
 */
export interface LedgerEntry { seq: number | string; kind: string; payload: any; created_at: Date | string }
const instant = (value: Date | string) => value instanceof Date ? value : new Date(value);

/**
 * The columns a reconstruction selects: the three document paths and four detail fields the
 * replay reads, never `payload` itself. Every event embeds the whole work document, so a row read
 * whole is a document; read this way it is a few hundred bytes whatever the item has grown to.
 */
export const ledgerReplayColumns = `seq, kind, created_at, (payload->'work') IS NOT NULL OR (payload->'delta') IS NOT NULL AS has_work,
  COALESCE(payload->'work'->>'updatedAt', payload->'delta'->>'updatedAt') AS updated_at, COALESCE(payload->'work'->'lease', payload->'delta'->'lease') AS lease, COALESCE(payload->'work'->'submission', payload->'delta'->'submission') AS submission,
  payload->'details'->>'at' AS detail_at, payload->'details'->'epoch' AS detail_epoch, payload->'details'->'pr' AS detail_pr,
  COALESCE(payload->'details'->>'reason','') <> '' AS detail_reason`;
/** A projected row (`ledgerReplayColumns`) in the shape the replay reads. */
export function ledgerEntry(row: any): LedgerEntry {
  const lease = row.lease && typeof row.lease === 'object' ? { epoch: row.lease.epoch, owner: row.lease.owner, expiresAt: row.lease.expiresAt } : null;
  const number = (value: unknown) => typeof value === 'number' ? value : undefined;
  return { seq: row.seq, kind: row.kind, created_at: row.created_at, payload: {
    ...(row.has_work ? { work: { updatedAt: row.updated_at ?? undefined, lease, submission: row.submission ?? null } } : {}),
    details: { at: row.detail_at ?? undefined, epoch: number(row.detail_epoch), pr: number(row.detail_pr), reason: row.detail_reason ? true : undefined } } };
}

/** Where a replay stands between two reads: small, serialisable, and enough to continue from the next row. */
export interface ReplayState {
  timeline: PipelineTimeline;
  lease: { epoch: number; owner: string; expiresAt: string } | null;
  submission: { epoch: number; pr: number } | null;
}

/**
 * Rebuild an item's timeline from its own history, one row at a time.
 *
 * Every lifecycle command wrote the work document it produced into the append-only ledger, so an
 * item that predates the timeline still carries one — unread. This replays those rows through the
 * very functions the engine calls, in ledger order, so a reconstruction and a live timeline are
 * the same arithmetic over the same facts, and a delivery that happened before the timeline
 * shipped is measured rather than reported as unmeasured forever.
 *
 * The replay holds no rows: `apply` folds one into a state a few hundred bytes wide, so a ledger
 * of any length is read a page at a time, and `state()` is what a bounded pass records to be
 * continued from the row after the last one it read.
 *
 * A lease that vanished between two consecutive documents lapsed at its own deadline, exactly as
 * reconciliation would have recorded it. A requirements revision that kept the lease was a live
 * scope widening, which is not a hand-off.
 */
export function timelineReplay(resume?: ReplayState | null) {
  const from = resume ? structuredClone(resume) : null;
  const shadow = { pipeline: from?.timeline ?? emptyTimeline(), lease: from?.lease ?? null, submission: from?.submission ?? null } as unknown as Work;
  const apply = (event: LedgerEntry) => {
    // A delta row (store/snapshot-delta.ts) carries the three fields the replay reads; one written
    // before deltas carried `submission` changed nothing but clocks.
    const delta = event.payload?.delta;
    const snapshot: Work | undefined = event.payload?.work ?? (delta ? { updatedAt: delta.updatedAt, lease: delta.lease ?? null, submission: delta.submission ?? null } as unknown as Work : undefined);
    const details = event.payload?.details ?? {};
    // The instant the command decided, not the instant its row reached the table: a saved
    // document stamps `updatedAt` from the transaction clock, and a raw ledger entry carries its
    // own `at`. Both are what the live timeline used, so a reconstruction reproduces it exactly.
    const at = instant(snapshot?.updatedAt ?? details.at ?? event.created_at);
    const held = shadow.lease;
    if (event.kind === 'claim') {
      if (held) endLapsedAttempt(shadow, held, at);
      if (snapshot?.lease) { shadow.lease = snapshot.lease; beginAttempt(shadow, snapshot.lease, at); }
    } else if (event.kind === 'submit') {
      shadow.submission = snapshot?.submission ?? { epoch: details.epoch ?? held?.epoch ?? 0, pr: details.pr ?? 0 };
      recordSubmission(shadow, details.epoch ?? shadow.submission!.epoch, at);
      shadow.lease = null;
    } else if (event.kind === 'release') {
      endAttempt(shadow, details.epoch ?? held?.epoch ?? 0, 'released', at);
      shadow.lease = null;
    } else if (event.kind === 'rework') {
      recordRework(shadow, at);
      shadow.lease = null;
    } else if (event.kind === 'blocked') {
      if (details.reason) recordIntervention(shadow, 'blocked');
    } else if (event.kind === 'requirements') {
      // The revision that kept its lease widened planned files for the attempt under way: it
      // hands nothing to anybody. Every other revision ends the attempt and is a hand-off.
      const widening = !!(held && snapshot?.lease && snapshot.lease.epoch === held.epoch);
      if (!widening) {
        if (held) endLapsedAttempt(shadow, held, at);
        recordIntervention(shadow, 'requirements');
        shadow.lease = null;
      }
    }
    // A `lease.expired` row needs no case of its own: the command that wrote it records the end
    // itself (`rework`), or the document it wrote next no longer carries the lease, which the
    // snapshot comparison below closes at the lease's own deadline exactly as reconciliation does.
    if (snapshot) {
      if (shadow.lease && (!snapshot.lease || snapshot.lease.epoch !== shadow.lease.epoch)) endLapsedAttempt(shadow, shadow.lease, at);
      shadow.lease = snapshot.lease ?? null;
      if (snapshot.submission) shadow.submission = snapshot.submission;
    }
  };
  const state = (): ReplayState => structuredClone({
    timeline: shadow.pipeline!,
    lease: shadow.lease ? { epoch: shadow.lease.epoch, owner: shadow.lease.owner, expiresAt: shadow.lease.expiresAt } : null,
    submission: shadow.submission ? { epoch: shadow.submission.epoch, pr: shadow.submission.pr } : null,
  });
  return { apply, state, timeline: () => shadow.pipeline! };
}
/** The whole replay over rows already in hand. */
export function reconstructTimeline(events: LedgerEntry[]): PipelineTimeline {
  const replay = timelineReplay();
  for (const event of events) replay.apply(event);
  return replay.timeline();
}

const earliest = (a: string | null | undefined, b: string | null | undefined) => !a ? b ?? null : !b ? a : Date.parse(b) < Date.parse(a) ? b : a;
const latest = (a: string | null | undefined, b: string | null | undefined) => !a ? b ?? null : !b ? a : Date.parse(b) > Date.parse(a) ? b : a;
/**
 * The timeline to keep for an item whose ledger was just replayed to its end.
 *
 * An attempt a lifecycle command recorded as it happened stands as recorded. But a live timeline
 * is only as old as the timeline itself: an item that submitted before it shipped and was reworked
 * after carries the later attempts and the *resubmission* as its first, which understates
 * execution and submit-to-merge. So the two are united rather than one chosen: attempts by epoch
 * (the live record of an epoch wins), the earliest first submission, the latest resubmission, and
 * counts that a reconstruction can raise but never lower.
 */
export function mergeTimeline(live: PipelineTimeline | undefined | null, reconstructed: PipelineTimeline, backfill: TimelineBackfill): PipelineTimeline {
  const attempts = new Map<number, PipelineAttempt>();
  for (const attempt of reconstructed.attempts) attempts.set(attempt.epoch, attempt);
  for (const attempt of live?.attempts ?? []) attempts.set(attempt.epoch, attempt);
  return {
    attempts: [...attempts.values()].sort((a, b) => a.epoch - b.epoch || Date.parse(a.claimedAt) - Date.parse(b.claimedAt)),
    submittedAt: earliest(live?.submittedAt, reconstructed.submittedAt),
    resubmittedAt: latest(live?.resubmittedAt, reconstructed.resubmittedAt),
    reworkRounds: Math.max(live?.reworkRounds ?? 0, reconstructed.reworkRounds),
    interventions: {
      blocked: Math.max(live?.interventions?.blocked ?? 0, reconstructed.interventions.blocked),
      requirements: Math.max(live?.interventions?.requirements ?? 0, reconstructed.interventions.requirements),
    },
    backfill,
  };
}

/**
 * Why a delivery is not measured. `awaiting-backfill` is the only one that resolves itself: the
 * item's history is still in the ledger and the reconstruction has not reached it, or has not
 * finished reading it, yet.
 */
export type SpeedCoverage = 'measured' | 'awaiting-backfill' | 'events-pruned' | 'no-submission';

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
  /** Why this item is or is not measured, so an unmeasured delivery is explained rather than absent. */
  coverage: SpeedCoverage;
  /** What a reconstruction read for this item, when one ran. */
  backfill: TimelineBackfill | null;
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
  const backfill = timeline?.backfill ?? null;
  // Why an item is not measured: the reconstruction has not reached it or has not finished
  // reading it, its ledger no longer reaches its creation, or the history genuinely records no
  // submission — which is only ever said of a ledger that was read to its end.
  const coverage: SpeedCoverage = backfill?.truncated || (!backfill && !timeline?.attempts.length) ? 'awaiting-backfill'
    : backfill && !backfill.retained ? 'events-pruned' : 'no-submission';
  const unmeasured: PipelineSpeed = { attempts: timeline?.attempts.length ?? 0, reworkRounds, interventions, executionMs: null, waitMs: null, openMs: null, submittedAt, mergedAt,
    submitToMergeMs: null, sinceSubmitMs: null, routine: reworkRounds <= 1 && !interventions.blocked && !interventions.requirements, measured: false, coverage, backfill };
  if (!timeline?.attempts.length) return unmeasured;
  const claimedAt = Math.min(...timeline.attempts.map(attempt => time(attempt.claimedAt)!).filter(Number.isFinite));
  const executionMs = timeline.attempts.reduce((total, attempt) => total + Math.max(0, Math.min(time(attempt.endedAt) ?? end, end) - (time(attempt.claimedAt) ?? end)), 0);
  const openMs = Math.max(0, end - claimedAt);
  return { ...unmeasured, executionMs, waitMs: Math.max(0, openMs - executionMs), openMs,
    submitToMergeMs: submitted !== null && mergedAt ? Math.max(0, end - submitted) : null,
    sinceSubmitMs: submitted !== null && !mergedAt ? Math.max(0, now - submitted) : null,
    measured: true, coverage: submitted !== null ? 'measured' : coverage };
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
  items: { key: string; mergedAt: string; submitToMergeMs: number; executionMs: number | null; waitMs: number | null;
    reworkRounds: number; interventions: PipelineTimeline['interventions']; routine: boolean }[];
  /**
   * Why every delivery in the window is or is not measured. Once a reconstruction has reached an
   * item whose ledger rows are retained, it is measured; what is left is named, with the reason.
   */
  coverage: { delivered: number; measured: number; awaitingBackfill: number; eventsPruned: number; noSubmission: number;
    items: { key: string; mergedAt: string; coverage: SpeedCoverage }[]; complete: boolean; statement: string };
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
  // Every delivery in the window, measured or not, with the reason it is not. A window that
  // reports nothing unmeasured has nothing left to reconstruct.
  const unmeasuredEntries = delivered.filter(({ speed }) => speed.submitToMergeMs === null)
    .sort((a, b) => a.mergedAt! - b.mergedAt!)
    .map(({ item, speed }) => ({ key: item.key, mergedAt: speed.mergedAt!, coverage: speed.coverage }));
  const counted = (coverage: SpeedCoverage) => unmeasuredEntries.filter(entry => entry.coverage === coverage).length;
  const coverage = { delivered: delivered.length, measured: measured.length,
    awaitingBackfill: counted('awaiting-backfill'), eventsPruned: counted('events-pruned'), noSubmission: counted('no-submission'),
    items: unmeasuredEntries, complete: unmeasuredEntries.length === 0,
    statement: unmeasuredEntries.length
      ? `${measured.length} of ${delivered.length} deliveries in this window are measured; ${unmeasuredEntries.length} are not (${counted('awaiting-backfill')} awaiting the ledger reconstruction, ${counted('events-pruned')} whose events are no longer retained, ${counted('no-submission')} the ledger records no submission for): ${unmeasuredEntries.map(entry => `${entry.key} (${entry.coverage})`).join(', ')}.`
      : `Every one of the ${delivered.length} deliveries in this window is measured from its own timeline.` };
  return { target: speedTarget, measured: measured.length, unmeasured: delivered.length - measured.length, submitToMerge,
    routine: { count: routine.length, submitToMerge: routineSubmitToMerge },
    reworkRounds: { median: rank(rounds, 50), p90: rank(rounds, 90), distribution },
    interventions: { items: intervened.length, blocked: measured.reduce((total, { speed }) => total + speed.interventions.blocked, 0), requirements: measured.reduce((total, { speed }) => total + speed.interventions.requirements, 0) },
    execution: { totalMs, waitTotalMs, share: totalMs + waitTotalMs ? Number((totalMs / (totalMs + waitTotalMs)).toFixed(4)) : null },
    met, reason, coverage,
    // Execution versus wait, rework rounds and hand-offs per delivered item, not only in aggregate.
    items: measured.map(({ item, speed }) => ({ key: item.key, mergedAt: speed.mergedAt!, submitToMergeMs: speed.submitToMergeMs!,
      executionMs: speed.executionMs, waitMs: speed.waitMs, reworkRounds: speed.reworkRounds, interventions: speed.interventions, routine: speed.routine })) };
}
const minutes = (ms: number) => `${Math.round(ms / 6000) / 10} min`;
