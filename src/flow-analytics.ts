import type pg from 'pg';
import type { Store } from './store.js';
import { stages, type Stage, type Work } from './model.js';
import { queueSequencingReason } from './merge-queue.js';

// Delivery-flow analytics.
//
// Every number here is derived from Graphyard's append-only event ledger and from
// independently observed provider facts that were durably normalized into flow_facts.
// Nothing is read from a client claim, and no current lifecycle snapshot is treated as
// evidence: the current state itself is read back from the last durable gate fact.
// Upstream retention (GitHub deleting a PR, a provider pruning a deployment) cannot
// erase an already normalized fact. The tables live in src/store/tables/flow.ts.

export const flowWindows = [7, 30, 90] as const;
export type FlowWindow = typeof flowWindows[number];
// Every aggregation is bounded: date range, rows scanned, buckets, drill-down rows and payload size.
export const flowLimits = { batch: 400, batches: 20, scan: 20_000, work: 2000, buckets: 90, drilldown: 200, distinct: 25, deployments: 500, deploymentMerges: 5000, payloadBytes: 4_000_000, remainingProbe: 100_000 };
export const sparseSampleSize = 5;
const day = 86_400_000;
/**
 * The deployment-provider environment whose successful deployments end the production
 * phase. Providers name environments freely, so a staging or preview deployment must never
 * close a phase that is labelled production; the name is configuration, not a guess.
 */
export const defaultProductionEnvironment = 'production';
export function productionEnvironmentFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.GRAPHYARD_PRODUCTION_ENVIRONMENT;
  if (raw === undefined) return defaultProductionEnvironment;
  const value = raw.trim();
  if (!value || value.length > 100) throw new Error('GRAPHYARD_PRODUCTION_ENVIRONMENT must name a deployment-provider environment (1-100 characters)');
  return value;
}

export type FlowSource = 'graphyard' | 'github' | 'ci' | 'evidence' | 'deployment';
export const flowKinds = ['work.created', 'work.released', 'dependencies.changed', 'blocker.set', 'blocker.cleared',
  'lease.claimed', 'lease.released', 'lease.lost', 'rework.requested', 'pr.submitted', 'candidate.observed',
  'review.requested', 'review.submitted', 'review.completed', 'check.observed', 'evidence.recorded',
  'merge.authorized', 'merged', 'delivered', 'stage.changed', 'gates.changed'] as const;
export type FlowKind = typeof flowKinds[number];

export interface FlowFact {
  id?: number; workId: string; workKey: string; kind: FlowKind; observedAt: string; recordedAt: string;
  source: FlowSource; sourceEvent: number; stage: string | null; workType: string; slices: string[];
  details: Record<string, any>; dedupe: string;
}
export interface LedgerEvent { seq: number | string; work_id: string; actor: string; kind: string; payload: any; created_at: Date | string }
export interface ProjectionState {
  created?: boolean; released?: boolean; stage?: string; stageAt?: string; blocker?: string | null;
  leaseEpoch?: number | null; candidateSha?: string; submittedPr?: number; reviewRequest?: number | null;
  reviews?: Record<string, string>; checks?: Record<string, string>; checkRuns?: Record<string, string>; evidence?: string[]; agentReview?: string;
  authorized?: string | null; merged?: boolean; delivered?: boolean; gateKey?: string; dependencies?: string[];
}
export interface DeploymentObservation {
  id: string; provider: string; externalId: string; environment: string; sha: string;
  containedMergeShas: string[]; state: 'succeeded' | 'failed' | 'rolled_back'; startedAt: string; finishedAt: string | null; recordedAt: string; details: Record<string, any>;
}

const pendingCheck = new Set(['queued', 'in_progress', 'pending', 'waiting', 'requested']);
function iso(value: Date | string | null | undefined) { return value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : ''; }
function time(value: string | null | undefined) { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : null; }

// A delivery slice is the top-level area of the repository a work item changes.
// Observed changed files (trusted GitHub observation) win; declared planned scope is a
// labelled intent fallback so pre-PR work is still groupable without inventing facts.
// An item is bounded to `sliceLimit` roots (sorted, so the retained set is deterministic);
// `truncated` reports that bound so a slice filter's coverage can say what it may miss.
export const sliceLimit = 12;
export function workSlices(work: Pick<Work, 'plannedFiles' | 'observation'>): { slices: string[]; provenance: 'observed' | 'declared' | 'unclassified'; truncated: boolean } {
  const roots = (paths: string[]) => [...new Set(paths.map(p => {
    const clean = p.replace(/^\.\//, '').replace(/\*+$/, '');
    return clean.includes('/') ? clean.split('/')[0] : clean ? 'root' : '';
  }).filter(Boolean))].sort();
  const bounded = (all: string[], provenance: 'observed' | 'declared') => ({ slices: all.slice(0, sliceLimit), provenance, truncated: all.length > sliceLimit });
  const observed = roots(work.observation?.files ?? []);
  if (observed.length) return bounded(observed, 'observed');
  const declared = roots(work.plannedFiles ?? []);
  if (declared.length) return bounded(declared, 'declared');
  return { slices: [], provenance: 'unclassified', truncated: false };
}

// Derives normalized facts from one ledger event and advances the per-item projection
// state. Identities are exact (review id, evidence id, commit sha) so replaying the
// ledger is idempotent, and no principal, login, or producer identity is ever stored.
export function deriveFacts(event: LedgerEvent, state: ProjectionState): FlowFact[] {
  const work: Work | undefined = event.payload?.work;
  if (!work?.id || !work.key) return [];
  const recordedAt = iso(event.created_at);
  const sourceEvent = Number(event.seq);
  const { slices } = workSlices(work);
  const facts: FlowFact[] = [];
  const base = { workId: work.id, workKey: work.key, recordedAt, sourceEvent, stage: work.stage ?? null, workType: work.type ?? 'feature', slices };
  const push = (kind: FlowKind, observedAt: string | null | undefined, source: FlowSource, identity: string, details: Record<string, any>) =>
    facts.push({ ...base, kind, source, details, observedAt: time(observedAt) === null ? recordedAt : observedAt!, dedupe: `${kind}:${work.id}:${identity}` });

  if (!state.created) push('work.created', work.createdAt, 'graphyard', 'once', { type: work.type, priority: work.priority, criteria: work.criteria?.length ?? 0, proofs: [...new Set((work.criteria ?? []).flatMap(c => c.proofs))].length });
  if (work.ready && !state.released) push('work.released', recordedAt, 'graphyard', 'once', { priority: work.priority });

  const dependencies = [...(work.dependencies ?? [])].sort();
  if ((state.dependencies ?? []).join(',') !== dependencies.join(',')) push('dependencies.changed', recordedAt, 'graphyard', String(sourceEvent), { dependencies });

  const blocker = work.blocker ?? null;
  if (state.created && blocker !== (state.blocker ?? null)) push(blocker ? 'blocker.set' : 'blocker.cleared', recordedAt, 'graphyard', String(sourceEvent), { reason: blocker ?? state.blocker ?? null });
  else if (!state.created && blocker) push('blocker.set', recordedAt, 'graphyard', String(sourceEvent), { reason: blocker });

  // An expiring lease is closed before its replacement is opened. A claim that follows an
  // expiry at the same recorded instant must never be swallowed by the older loss.
  if (state.leaseEpoch && event.kind !== 'release' && (!work.lease || work.lease.epoch !== state.leaseEpoch))
    push('lease.lost', recordedAt, 'graphyard', String(state.leaseEpoch), { epoch: state.leaseEpoch, reason: event.kind === 'reconciled' ? 'expired' : event.kind });
  if (event.kind === 'claim' && work.lease) push('lease.claimed', recordedAt, 'graphyard', String(work.lease.epoch), { epoch: work.lease.epoch, reassignment: work.lease.epoch > 1 });
  if (event.kind === 'release' && state.leaseEpoch) push('lease.released', recordedAt, 'graphyard', String(state.leaseEpoch), { epoch: state.leaseEpoch });
  if (event.kind === 'rework') push('rework.requested', recordedAt, 'graphyard', String(sourceEvent), { epoch: work.epoch });

  if (event.kind === 'submit' && work.submission) push('pr.submitted', recordedAt, 'graphyard', `${work.submission.pr}:${work.submission.epoch}`, { pr: work.submission.pr, epoch: work.submission.epoch });

  const observation = work.observation;
  if (work.candidate && work.candidate.sha !== state.candidateSha) {
    const createdAt = work.candidate.createdAt;
    push('candidate.observed', recordedAt, 'github', work.candidate.sha, {
      pr: work.candidate.pr, sha: work.candidate.sha, baseSha: work.candidate.baseSha,
      prCreatedAt: time(createdAt) === null ? null : createdAt, timestampSource: time(createdAt) === null ? 'unobserved' : 'github',
      supersedes: state.candidateSha ?? null,
    });
  }
  if (work.reviewRequest && work.reviewRequest.commentId !== state.reviewRequest)
    push('review.requested', work.reviewRequest.createdAt, 'github', String(work.reviewRequest.commentId), { sha: work.reviewRequest.sha, commentId: work.reviewRequest.commentId, timestampSource: 'github' });

  const reviews = { ...(state.reviews ?? {}) };
  for (const review of observation?.reviews ?? []) {
    const key = String(review.id ?? `${review.sha}:${review.state}`);
    if (reviews[key] === review.state) continue;
    reviews[key] = review.state;
    push('review.submitted', review.submittedAt, 'github', `${key}:${review.state}`, {
      reviewState: review.state, sha: review.sha, independent: !!observation && review.reviewer !== observation.candidate.author,
      timestampSource: time(review.submittedAt) === null ? 'graphyard' : 'github',
    });
  }
  const agentReview = observation?.agentReview;
  const agentIdentity = agentReview?.resultId ?? agentReview?.summaryId ?? agentReview?.reactionId;
  const agentKey = agentReview?.completedAt && agentIdentity ? `${agentReview.sha}:${agentIdentity}` : '';
  if (agentReview && agentKey && agentKey !== state.agentReview)
    push('review.completed', agentReview.completedAt, 'github', agentKey, { provider: agentReview.provider, approved: agentReview.approved, sha: agentReview.sha, reason: String(agentReview.reason ?? '').slice(0, 300), timestampSource: time(agentReview.completedAt) === null ? 'graphyard' : 'github' });

  const checks: Record<string, string> = {};
  const checkRuns = { ...(state.checkRuns ?? {}) };
  for (const check of observation?.checks ?? []) {
    const key = `${observation!.candidate.sha}:${check.name}`;
    checks[key] = check.result;
    const observationIdentity = check.id ? `${check.id}:${check.attempt ?? 1}` : `${sourceEvent}`;
    const runKey = `${key}:${observationIdentity}`;
    // A repeated result is still a new retry when GitHub gives it a distinct immutable
    // check-run identity. Legacy projection rows have no checkRuns map, so the first
    // observation after upgrading is deliberately retained rather than guessed away.
    if (checkRuns[runKey] === check.result) continue;
    checkRuns[runKey] = check.result;
    push('check.observed', recordedAt, 'ci', `${key}:${observationIdentity}:${check.result}`, {
      name: check.name, result: check.result, sha: observation!.candidate.sha, appId: check.appId,
      checkRunId: check.id ?? null, attempt: check.attempt ?? null,
      pending: pendingCheck.has(check.result), previous: (state.checks ?? {})[key] ?? null, timestampSource: 'graphyard',
    });
  }

  const seenEvidence = new Set(state.evidence ?? []);
  for (const evidence of work.evidence ?? []) {
    if (seenEvidence.has(evidence.id)) continue;
    seenEvidence.add(evidence.id);
    push('evidence.recorded', evidence.at, 'evidence', evidence.id, {
      proof: evidence.proof, result: evidence.result, trusted: evidence.trusted, executed: evidence.executed,
      skipped: evidence.skipped, sha: evidence.sha, policyRevision: evidence.policyRevision,
      evidenceId: evidence.id, expiresAt: evidence.expiresAt ?? null, validation: evidence.validation ?? null,
    });
  }

  const authorization = work.mergeAuthorization ?? null;
  const authorizationKey = authorization ? `${authorization.sha}:${authorization.at}` : null;
  if (authorization && authorizationKey !== state.authorized)
    push('merge.authorized', authorization.at, 'graphyard', authorizationKey!, { sha: authorization.sha, baseSha: authorization.baseSha, policyRevision: authorization.policyRevision });
  if (observation?.merged && !state.merged)
    push('merged', observation.mergedAt ?? recordedAt, 'github', String(observation.mergeSha ?? observation.candidate.sha), {
      pr: observation.candidate.pr, sha: observation.candidate.sha, mergeSha: observation.mergeSha,
      timestampSource: time(observation.mergedAt) === null ? 'graphyard' : 'github',
    });
  if (work.stage === 'done' && !state.delivered)
    push('delivered', work.delivery?.mergedAt ?? recordedAt, work.delivery?.mergedAt ? 'github' : 'graphyard', 'once', {
      mergeSha: work.delivery?.mergeSha ?? null, pr: work.candidate?.pr ?? null,
      leadTimeMs: time(work.delivery?.mergedAt ?? recordedAt)! - (time(work.createdAt) ?? time(work.delivery?.mergedAt ?? recordedAt)!),
      timestampSource: work.delivery?.mergedAt ? 'github' : 'graphyard',
    });

  if (work.stage !== state.stage) {
    const at = time(work.stageEnteredAt) === null ? recordedAt : work.stageEnteredAt;
    const dwell = state.stageAt ? time(at)! - time(state.stageAt)! : null;
    push('stage.changed', at, 'graphyard', String(sourceEvent), {
      from: state.stage ?? null, to: work.stage, dwellMs: dwell === null || dwell < 0 ? null : dwell,
      clockOrder: dwell !== null && dwell < 0 ? 'inverted' : 'ordered',
    });
  }

  const gates = work.gates ?? [];
  const unmet = gates.filter(g => !g.passed).map(g => g.name);
  const firstUnmet = gates.find(g => !g.passed);
  const dependencyWaiting = (gates.find(g => g.name === 'ready')?.reasons ?? [])
    .flatMap(reason => { const match = /^Dependency (\S+) is unfinished$/.exec(reason); return match ? [match[1]] : []; });
  // The merge queue owns the last hop: a proven candidate holds a queue entry while it waits
  // its turn and its speculative tip. Those sequencing reasons are recorded apart from real
  // merge refusals (protection, mergeability, freshness, escalation, ejection) so the wait
  // classification can tell "queued and ready" from "blocked" without reading live state.
  const queued = !!work.queue;
  const mergeBlockers = (gates.find(g => g.name === 'merge')?.reasons ?? []).filter(reason => !queueSequencingReason(reason)).length;
  // The recorded refusal reasons are part of the identity: a gate that keeps refusing for a
  // different reason (protection, then freshness) is a new durable fact, so refusal history
  // never keeps reporting a reason the evaluator has already replaced.
  const reasons = (firstUnmet?.reasons ?? []).slice(0, 5);
  const gateKey = JSON.stringify([work.stage, unmet, dependencyWaiting, !!work.candidate, blocker, !!work.ready, work.violations?.length ?? 0, queued, mergeBlockers > 0, firstUnmet?.name ?? null, reasons]);
  if (gateKey !== state.gateKey)
    push('gates.changed', recordedAt, 'graphyard', String(sourceEvent), {
      stage: work.stage, unmet, firstUnmet: firstUnmet?.name ?? null, firstUnmetReason: firstUnmet?.reasons[0] ?? null,
      reasons, dependencyWaiting, hasCandidate: !!work.candidate,
      released: !!work.ready, blocker, violations: work.violations?.length ?? 0, pr: work.candidate?.pr ?? null,
      queued, mergeBlockers,
    });

  state.created = true;
  state.released = state.released || !!work.ready;
  state.stage = work.stage; state.stageAt = facts.find(f => f.kind === 'stage.changed')?.observedAt ?? state.stageAt ?? iso(work.createdAt);
  state.blocker = blocker;
  state.leaseEpoch = work.lease?.epoch ?? null;
  state.candidateSha = work.candidate?.sha ?? state.candidateSha;
  state.submittedPr = work.submission?.pr ?? state.submittedPr;
  state.reviewRequest = work.reviewRequest?.commentId ?? null;
  state.reviews = Object.fromEntries(Object.entries(reviews).slice(-200));
  state.checks = Object.keys(checks).length ? checks : state.checks;
  state.checkRuns = Object.fromEntries(Object.entries(checkRuns).slice(-500));
  state.evidence = [...seenEvidence].slice(-300);
  state.agentReview = agentKey || state.agentReview;
  state.authorized = authorizationKey;
  state.merged = state.merged || !!observation?.merged;
  state.delivered = state.delivered || work.stage === 'done';
  state.gateKey = gateKey;
  state.dependencies = dependencies;
  return facts;
}

// Incremental, bounded projection of the ledger into normalized durable facts.
// A second replica skips silently instead of duplicating work; inserts are idempotent.
export async function projectFlow(store: Store, options: { batch?: number; batches?: number } = {}) {
  const batch = Math.min(options.batch ?? flowLimits.batch, flowLimits.batch);
  const rounds = Math.min(options.batches ?? flowLimits.batches, flowLimits.batches);
  let processed = 0, inserted = 0, checkpoint = 0;
  for (let round = 0; round < rounds; round++) {
    const db = await store.pool.connect();
    try {
      await db.query('BEGIN');
      if (!(await db.query('SELECT pg_try_advisory_xact_lock(71490322) AS ok')).rows[0].ok) { await db.query('ROLLBACK'); break; }
      checkpoint = Number((await db.query('SELECT last_event FROM flow_projection WHERE id=1 FOR UPDATE')).rows[0]?.last_event ?? 0);
      const events: LedgerEvent[] = (await db.query('SELECT seq,work_id,actor,kind,payload,created_at FROM events WHERE seq>$1 AND work_id IS NOT NULL ORDER BY seq LIMIT $2', [checkpoint, batch])).rows;
      if (!events.length) { await db.query('COMMIT'); break; }
      const ids = [...new Set(events.map(e => e.work_id))];
      const states = new Map<string, ProjectionState>((await db.query('SELECT work_id,state FROM flow_projection_state WHERE work_id=ANY($1) FOR UPDATE', [ids])).rows.map(r => [r.work_id, r.state]));
      const facts: FlowFact[] = [];
      for (const event of events) {
        const state = states.get(event.work_id) ?? {};
        states.set(event.work_id, state);
        facts.push(...deriveFacts(event, state));
      }
      for (let i = 0; i < facts.length; i += 100) {
        const chunk = facts.slice(i, i + 100);
        const values = chunk.map((_, row) => `(${Array.from({ length: 12 }, (_, column) => `$${row * 12 + column + 1}`).join(',')})`).join(',');
        const parameters = chunk.flatMap(f => [f.workId, f.workKey, f.kind, f.observedAt, f.recordedAt, f.source, f.sourceEvent, f.stage, f.workType, f.slices, JSON.stringify(f.details), f.dedupe]);
        const result = await db.query(`INSERT INTO flow_facts(work_id,work_key,kind,observed_at,recorded_at,source,source_event,stage,work_type,slices,details,dedupe) VALUES ${values} ON CONFLICT (dedupe) DO NOTHING`, parameters);
        inserted += result.rowCount ?? 0;
      }
      for (const [id, state] of states)
        await db.query('INSERT INTO flow_projection_state(work_id,state) VALUES($1,$2) ON CONFLICT(work_id) DO UPDATE SET state=$2', [id, JSON.stringify(state)]);
      checkpoint = Number(events.at(-1)!.seq);
      await db.query('UPDATE flow_projection SET last_event=$1, updated_at=clock_timestamp() WHERE id=1', [checkpoint]);
      await db.query('COMMIT');
      processed += events.length;
      if (events.length < batch) break;
    } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
    finally { db.release(); }
  }
  return { processed, inserted, checkpoint };
}

export interface FlowQuery { days: FlowWindow; type?: string | null; stage?: string | null; slice?: string | null; asOf?: string | null; limit?: number; productionEnvironment?: string }
export interface FlowDataset {
  observedAt: string; from: string; to: string; days: FlowWindow;
  work: Work[]; included: Work[]; facts: FlowFact[]; latest: FlowFact[]; carryIn: FlowFact[]; deployments: DeploymentObservation[];
  mergedForDeployments: FlowFact[]; scanned: number; truncated: boolean; workTruncated: boolean; deploymentsTruncated: boolean; deploymentMergesTruncated: boolean;
  /**
   * The part of the requested window the fact scan actually reached. `readFlow` always sets it;
   * a dataset assembled by hand may leave it out and is then read as fully covered.
   */
  covered?: CoveredWindow;
  projection: { lastEvent: number; updatedAt: string | null; pendingEvents: number; pendingCapped: boolean };
}
/**
 * How much of the requested window a bounded scan covered. The in-window scan reads facts in
 * observation order, so exhausting its row bound truncates the *end* of the window: everything
 * from `from` to `to` was asked for, everything up to `toCovered` was read, and the interval
 * after it was never examined. A report that returned that partial scan while still naming the
 * full window would state a 30-day figure computed from a single day; this says what it covered.
 */
export interface CoveredWindow {
  from: string; to: string; toCovered: string; ms: number; windowMs: number; fraction: number;
  truncated: boolean; uncovered: { from: string; to: string; ms: number } | null;
  /** Facts known to remain past `toCovered`, counted up to a bound of its own. */
  remainingFacts: number | null; remainingCapped: boolean;
  statement: string;
}
/**
 * The disclosure a truncated scan owes its reader: the interval it actually covered, the share of
 * the requested window that is, the interval nobody looked at, and how many facts are known to
 * remain there. `remainingFacts` is itself bounded, so `remainingCapped` says when the true number
 * is at least that many rather than exactly it.
 */
export function coveredWindow(from: string, to: string, lastCovered: string, remaining: number, scanLimit: number, cap = flowLimits.remainingProbe): CoveredWindow {
  const start = time(from) ?? 0, end = time(to) ?? 0;
  const reached = Math.min(Math.max(time(lastCovered) ?? start, start), end);
  const windowMs = Math.max(0, end - start), ms = Math.max(0, reached - start);
  const toCovered = new Date(reached).toISOString();
  const fraction = windowMs ? Number((ms / windowMs).toFixed(4)) : 1;
  const capped = remaining > cap;
  const hours = (value: number) => `${Math.round(value / 360_000) / 10} h`;
  return { from, to, toCovered, ms, windowMs, fraction, truncated: true,
    uncovered: { from: toCovered, to, ms: Math.max(0, end - reached) },
    remainingFacts: Math.min(remaining, cap), remainingCapped: capped,
    statement: `The fact scan reached its ${scanLimit.toLocaleString('en-US')}-row bound: this report is computed from ${from} to ${toCovered} (${hours(ms)} of the requested ${hours(windowMs)}, ${Math.round(fraction * 100)}%), and ${capped ? `at least ${cap.toLocaleString('en-US')}` : remaining.toLocaleString('en-US')} fact(s) between ${toCovered} and ${to} were not examined. Every figure below describes the covered interval only; narrow the window, type or slice filter to cover the rest.` };
}
const fullyCovered = (from: string, to: string): CoveredWindow => ({ from, to, toCovered: to, ms: Math.max(0, (time(to) ?? 0) - (time(from) ?? 0)), windowMs: Math.max(0, (time(to) ?? 0) - (time(from) ?? 0)), fraction: 1, truncated: false, uncovered: null, remainingFacts: null, remainingCapped: false, statement: 'The scan covered the whole requested window.' });
// Facts whose most recent value before the window end is needed to describe the present
// state and to carry an item's timeline into the window.
const carryKinds: FlowKind[] = ['stage.changed', 'gates.changed', 'work.created', 'work.released', 'delivered', 'merged', 'candidate.observed', 'lease.claimed', 'lease.released', 'lease.lost', 'dependencies.changed'];

function rowToFact(row: any): FlowFact {
  return { id: Number(row.id), workId: row.work_id, workKey: row.work_key, kind: row.kind, observedAt: iso(row.observed_at), recordedAt: iso(row.recorded_at), source: row.source, sourceEvent: Number(row.source_event), stage: row.stage, workType: row.work_type, slices: row.slices ?? [], details: row.details ?? {}, dedupe: row.dedupe };
}

// Bounded, indexed reads. Every query is limited by window, by the selected work items,
// and by an explicit row cap whose exhaustion is reported rather than hidden.
export async function readFlow(store: Store, query: FlowQuery): Promise<FlowDataset> {
  const clock = iso((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now);
  const observedAt = query.asOf && time(query.asOf) !== null && time(query.asOf)! <= time(clock)! ? new Date(time(query.asOf)!).toISOString() : clock;
  const to = observedAt, from = new Date(time(observedAt)! - query.days * day).toISOString();
  // One extra work item and one extra deployment probe their own scan bounds, so an
  // exhausted bound is reported as partial coverage instead of silently dropping the
  // newest records.
  const workRows: Work[] = (await store.pool.query('SELECT document FROM work_items ORDER BY number LIMIT $1', [flowLimits.work + 1])).rows.map(r => r.document);
  const workTruncated = workRows.length > flowLimits.work;
  const work: Work[] = workRows.slice(0, flowLimits.work);
  const included = work.filter(item => (!query.type || item.type === query.type) && (!query.slice || workSlices(item).slices.includes(query.slice)));
  const ids = included.map(item => item.id);
  const stateIds = work.map(item => item.id);
  const empty = { observedAt, from, to, days: query.days, work, included, facts: [], latest: [], carryIn: [], deployments: [], mergedForDeployments: [], scanned: 0, truncated: false, workTruncated, deploymentsTruncated: false, deploymentMergesTruncated: false, covered: fullyCovered(from, to) };
  const projectionRow = (await store.pool.query('SELECT last_event,updated_at FROM flow_projection WHERE id=1')).rows[0];
  const lastEvent = Number(projectionRow?.last_event ?? 0);
  // Lag counts exactly the events the projector consumes; ledger entries without a work
  // item are skipped by the projection and must not hold the report permanently stale.
  const pending = (await store.pool.query('SELECT count(*)::int AS pending FROM (SELECT 1 FROM events WHERE seq>$1 AND work_id IS NOT NULL LIMIT 1001) probe', [lastEvent])).rows[0].pending as number;
  const projection = { lastEvent, updatedAt: projectionRow ? iso(projectionRow.updated_at) : null, pendingEvents: Math.min(pending, 1000), pendingCapped: pending > 1000 };
  const scanLimit = Math.min(Math.max(1, query.limit ?? flowLimits.scan), flowLimits.scan);
  const scan = ids.length ? await store.pool.query(
    `SELECT * FROM flow_facts WHERE work_id=ANY($1) AND observed_at>=$2 AND observed_at<$3 ORDER BY observed_at,id LIMIT $4`,
    [ids, from, to, scanLimit + 1]) : { rows: [], rowCount: 0 };
  const truncated = scan.rowCount! > scanLimit;
  const facts = scan.rows.slice(0, scanLimit).map(rowToFact);
  // What an exhausted row bound cost, in window time and in facts left unread, rather than a
  // silent partial window. The remainder is counted from the last covered instant inclusively, so
  // facts sharing that instant are reported as unread rather than assumed returned, and the count
  // is itself bounded and says so.
  const remainingProbe = truncated ? await store.pool.query(
    `SELECT count(*)::int AS remaining FROM (SELECT 1 FROM flow_facts WHERE work_id=ANY($1) AND observed_at>=$2 AND observed_at<$3 LIMIT $4) probe`,
    [ids, facts.at(-1)?.observedAt ?? from, to, flowLimits.remainingProbe + 1]) : null;
  const covered = truncated ? coveredWindow(from, to, facts.at(-1)?.observedAt ?? from, remainingProbe!.rows[0].remaining as number, scanLimit) : fullyCovered(from, to);
  // Current state is read as of the observation instant, inclusively: a fact recorded in
  // the same millisecond as the read clock is the state at that instant, never stale.
  // The in-window scan above stays half-open on `to` as documented.
  // One indexed lookup per bounded work/kind pair avoids scanning an item's lifetime.
  // Latest state covers the bounded repository population so filtered dependency paths
  // can still recognize an out-of-scope dependency that has already been delivered.
  const latest = stateIds.length ? (await store.pool.query(
    `SELECT fact.* FROM unnest($1::uuid[]) selected_work(work_id) CROSS JOIN unnest($2::text[]) selected_kind(kind)
       CROSS JOIN LATERAL (SELECT * FROM flow_facts WHERE flow_facts.work_id=selected_work.work_id AND flow_facts.kind=selected_kind.kind AND observed_at<=$3 ORDER BY observed_at DESC,id DESC LIMIT 1) fact`,
    [stateIds, carryKinds, to])).rows.map(rowToFact) : [];
  const carryIn = ids.length ? (await store.pool.query(
    `SELECT fact.* FROM unnest($1::uuid[]) selected_work(work_id) CROSS JOIN unnest($2::text[]) selected_kind(kind)
       CROSS JOIN LATERAL (SELECT * FROM flow_facts WHERE flow_facts.work_id=selected_work.work_id AND flow_facts.kind=selected_kind.kind AND observed_at<$3 ORDER BY observed_at DESC,id DESC LIMIT 1) fact`,
    [ids, carryKinds, from])).rows.map(rowToFact) : [];
  const deploymentRows = (await store.pool.query(
    `SELECT d.*, COALESCE(array_agg(dm.merge_sha ORDER BY dm.merge_sha) FILTER (WHERE dm.merge_sha IS NOT NULL), '{}') AS contained_merge_shas
       FROM deployment_observations d LEFT JOIN deployment_merge_observations dm ON dm.deployment_id=d.id
      WHERE d.started_at>=$1 AND d.started_at<$2 GROUP BY d.id ORDER BY d.started_at,d.id LIMIT $3`, [from, to, flowLimits.deployments + 1])).rows;
  const deploymentsTruncated = deploymentRows.length > flowLimits.deployments;
  const deployments: DeploymentObservation[] = deploymentRows.slice(0, flowLimits.deployments)
    .map(row => ({ id: row.id, provider: row.provider, externalId: row.external_id, environment: row.environment, sha: row.sha, containedMergeShas: row.contained_merge_shas, state: row.state, startedAt: iso(row.started_at), finishedAt: row.finished_at ? iso(row.finished_at) : null, recordedAt: iso(row.recorded_at), details: row.details ?? {} }));
  const mergeShas = [...new Set(deployments.flatMap(d => d.containedMergeShas))];
  const mergeRows = mergeShas.length
    ? (await store.pool.query(`SELECT * FROM flow_facts WHERE kind='merged' AND details->>'mergeSha'=ANY($1) ORDER BY observed_at,id LIMIT $2`, [mergeShas, flowLimits.deploymentMerges + 1])).rows : [];
  const deploymentMergesTruncated = mergeRows.length > flowLimits.deploymentMerges;
  const mergedForDeployments = mergeRows.slice(0, flowLimits.deploymentMerges).map(rowToFact);
  return { observedAt, from, to, days: query.days, work, included, facts, latest, carryIn, deployments, mergedForDeployments, scanned: facts.length, truncated, workTruncated, deploymentsTruncated, deploymentMergesTruncated, covered, projection };
}

export type WaitCategory = 'delivered' | 'backlog' | 'blocked' | 'dependency' | 'implementation' | 'review' | 'evidence' | 'merge-blocked' | 'merge-ready';
export const waitCategories: { id: WaitCategory; label: string; definition: string }[] = [
  { id: 'backlog', label: 'Not released', definition: 'Recorded intent that an operator has not released for implementation.' },
  { id: 'blocked', label: 'Blocked', definition: 'An explicit blocker was recorded and has not been cleared.' },
  { id: 'dependency', label: 'Dependency-blocked', definition: 'The ready gate refuses because a prerequisite work item is not delivered.' },
  { id: 'implementation', label: 'In implementation', definition: 'Released, unblocked, and no pull-request candidate has been independently observed yet.' },
  { id: 'review', label: 'Waiting on review', definition: 'A candidate is observed and the review gate has not been satisfied for it.' },
  { id: 'evidence', label: 'Waiting on acceptance evidence', definition: 'Review is satisfied and at least one required proof still lacks trusted passing evidence for the candidate.' },
  { id: 'merge-blocked', label: 'Merge blocked', definition: 'Review and acceptance are satisfied but the merge gate refuses for a reason other than queue sequencing: protection, mergeability, observation freshness, an escalation or hold, or ejection from the merge queue.' },
  { id: 'merge-ready', label: 'Merge ready', definition: 'Every other gate passed on the current candidate and the merge has not been observed yet: the item holds a merge-queue entry and is only waiting its turn or its speculative tip, or every gate passed.' },
  { id: 'delivered', label: 'Delivered', definition: 'An authorized merge was independently observed.' },
];
/**
 * A durable gate fact whose candidate is merge ready: no gate refuses, or only the merge gate
 * refuses and solely to sequence a queued entry. Facts recorded before queue fields existed
 * carry neither `queued` nor `mergeBlockers`, so they are merge ready only when no gate refuses.
 */
export function mergeReadyGate(gate: Record<string, any> | undefined): boolean {
  if (!gate || !gate.hasCandidate) return false;
  const unmet: string[] = gate.unmet ?? [];
  if (!unmet.length) return true;
  return unmet.length === 1 && unmet[0] === 'merge' && gate.queued === true && gate.mergeBlockers === 0;
}
/**
 * Merge-ready intervals of one item, from its ordered gate facts. An interval opens at the
 * first gate fact that is merge ready and closes at the next refusing gate fact, at the
 * observed merge, or stays open to the observation time. Gate facts observed at or after the
 * merge describe post-delivery state and never open an interval. Intervals are reported with
 * their real endpoints and then clipped to the window; one that ends before the window (an item
 * merged before it opened) contributes nothing rather than a full-window duration.
 */
export function mergeReadyIntervals(gateFacts: FlowFact[], mergedAt: number | null, from: number, to: number) {
  const ordered = [...gateFacts].sort((a, b) => time(a.observedAt)! - time(b.observedAt)! || (a.id ?? 0) - (b.id ?? 0));
  const intervals: { readyAt: number; endAt: number; closedBy: 'refused' | 'merged' | 'open'; startMs: number; endMs: number; ms: number; inWindow: boolean }[] = [];
  const close = (readyAt: number, endAt: number, closedBy: 'refused' | 'merged' | 'open') => {
    const startMs = Math.max(from, readyAt), endMs = Math.min(to, endAt);
    intervals.push({ readyAt, endAt, closedBy, startMs, endMs, ms: Math.max(0, endMs - startMs), inWindow: endAt > from && readyAt < to && endMs >= startMs });
  };
  let readyAt: number | null = null;
  for (const fact of ordered) {
    const at = time(fact.observedAt)!;
    if (mergedAt !== null && at >= mergedAt) break;
    const ready = mergeReadyGate(fact.details);
    if (ready && readyAt === null) readyAt = at;
    if (!ready && readyAt !== null) { close(readyAt, at, 'refused'); readyAt = null; }
  }
  if (readyAt !== null) close(readyAt, mergedAt ?? to, mergedAt !== null ? 'merged' : 'open');
  return intervals;
}
// Classification is read back from the durable gate fact, never from a live client claim.
export function classifyWait(gate: Record<string, any> | undefined, delivered: boolean): WaitCategory | null {
  if (delivered) return 'delivered';
  if (!gate) return null;
  const unmet: string[] = gate.unmet ?? [];
  if (!gate.released) return 'backlog';
  if (gate.blocker) return 'blocked';
  if ((gate.dependencyWaiting ?? []).length) return 'dependency';
  if (!gate.hasCandidate) return 'implementation';
  if (unmet.includes('review')) return 'review';
  if (unmet.includes('acceptance')) return 'evidence';
  if (mergeReadyGate(gate)) return 'merge-ready';
  return 'merge-blocked';
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = (p / 100) * (sorted.length - 1), low = Math.floor(rank), high = Math.ceil(rank);
  return Math.round(sorted[low] + (sorted[high] - sorted[low]) * (rank - low));
}
// n is always reported next to the statistic, an empty sample is null rather than zero,
// and a small sample is flagged so the reader never mistakes noise for a trend.
export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length, p90 = percentile(sorted, 90);
  return {
    n, averageMs: n ? Math.round(sorted.reduce((sum, value) => sum + value, 0) / n) : null,
    medianMs: percentile(sorted, 50), p75Ms: percentile(sorted, 75), p90Ms: p90,
    minMs: n ? sorted[0] : null, maxMs: n ? sorted[n - 1] : null,
    sparse: n > 0 && n < sparseSampleSize, outliers: p90 === null ? 0 : sorted.filter(value => value > p90 * 3).length,
  };
}
// Counts are not durations; report them without the millisecond suffix.
export function countSummary(values: number[]) {
  const spread = distribution(values);
  return { n: spread.n, average: spread.averageMs, median: spread.medianMs, p90: spread.p90Ms, min: spread.minMs, max: spread.maxMs, sparse: spread.sparse };
}
export const metricDefinitions: Record<string, { label: string; formula: string; sources: string[] }> = {
  stageDwell: { label: 'Stage dwell', formula: 'For each completed stage transition in the window, the interval between entering and leaving that stage. Open stages are excluded and counted separately as work in progress.', sources: ['flow_facts:stage.changed'] },
  wip: { label: 'Work in progress and aging', formula: 'Items whose latest durable stage fact places them in a stage and that have no delivered fact. Age is the observation time minus the time that stage was entered.', sources: ['flow_facts:stage.changed', 'flow_facts:delivered'] },
  cumulativeFlow: { label: 'Cumulative flow', formula: 'At each daily boundary in the window, the number of created, not-yet-delivered items in each stage, reconstructed from stage facts.', sources: ['flow_facts:stage.changed', 'flow_facts:work.created'] },
  throughput: { label: 'Throughput', formula: 'Count of delivered facts per daily bucket. A delivered fact is written only when an authorized merge is independently observed.', sources: ['flow_facts:delivered'] },
  leadTime: { label: 'Lead time', formula: 'Delivered observation time minus the work-created time, per delivered item in the window.', sources: ['flow_facts:work.created', 'flow_facts:delivered'] },
  queueVsActive: { label: 'Queue versus active work time', formula: 'Active time is the union of lease intervals clipped to the window. Queue time is released, undelivered time in the window with no active lease.', sources: ['flow_facts:lease.claimed', 'flow_facts:lease.released', 'flow_facts:lease.lost'] },
  mergeReadyDwell: { label: 'Merge-ready dwell', formula: 'Interval from the gate fact where the candidate became merge ready (no gate refuses, or only merge-queue sequencing remains) to the next refusing gate fact, to the observed merge, or to the observation time for items still merge ready, clipped to the window. Gate facts observed after the merge never open an interval, and an interval that ended before the window is excluded rather than measured.', sources: ['flow_facts:gates.changed', 'flow_facts:merged'] },
  phases: { label: 'Phase durations', formula: 'Per candidate episode (one commit under review), the interval between consecutive milestones. A milestone uses the independently observed provider timestamp when the provider supplies one. The production milestone is the earliest successful deployment of the configured production environment (report.productionEnvironment) that contains the merge commit; a deployment to any other environment never ends the phase.', sources: ['flow_facts:candidate.observed', 'flow_facts:review.submitted', 'flow_facts:review.completed', 'flow_facts:gates.changed', 'flow_facts:merge.authorized', 'flow_facts:merged', 'deployment_observations'] },
  ci: { label: 'CI duration, failure and retry', formula: 'Per check name and commit, the interval between the first pending observation and the first terminal observation. Durations are bounded by Graphyard observation intervals, not by provider start timestamps.', sources: ['flow_facts:check.observed'] },
  evidence: { label: 'Evidence wait, expiry and staleness', formula: 'Wait is review completion to the gate fact where acceptance stops refusing. Expiry counts recorded evidence whose expiry precedes the observation time; staleness counts evidence bound to a superseded commit.', sources: ['flow_facts:evidence.recorded', 'flow_facts:gates.changed'] },
  operations: { label: 'Operational analytics', formula: 'Counts of recorded blockers, gate refusal reasons, review rounds and findings, rework, lease lifecycle, and queue depth sampled at daily boundaries. Aggregates are never keyed by a person.', sources: ['flow_facts:blocker.set', 'flow_facts:gates.changed', 'flow_facts:review.submitted', 'flow_facts:rework.requested', 'flow_facts:lease.claimed'] },
  deployments: { label: 'Deployment frequency, latency, failure and rollback', formula: 'Deployment-provider observations of every environment join their independently observed contained merge SHAs to merged facts. Latency is deployment start minus the latest contained observed merge. Deployment observations are repository-wide, so slice, type and stage filters do not narrow them. Absent observations are reported as unavailable, never as zero.', sources: ['deployment_observations', 'deployment_merge_observations', 'flow_facts:merged'] },
  bottleneck: { label: 'Bottleneck summary', formula: 'Each undelivered item is classified by its latest durable gate fact into exactly one wait category.', sources: ['flow_facts:gates.changed', 'flow_facts:delivered'] },
};

// Blocker aggregates and their drill-down share one bounded reason label.
export const blockerReasonKey = (fact: FlowFact) => String(fact.details.reason ?? '').slice(0, 200) || null;
function bucketStarts(from: number, to: number) {
  const starts: number[] = [];
  for (let at = from; at < to && starts.length < flowLimits.buckets; at += day) starts.push(at);
  return starts;
}
function valueAt(points: { at: number; value: any }[], at: number) {
  let value: any = null;
  for (const point of points) { if (point.at > at) break; value = point.value; }
  return value;
}

/**
 * The earliest successful deployment of the configured production environment that contains
 * the merge commit. A deployment observed only in another environment is named as such so a
 * reader can tell "staging only" from "never deployed" and from "no provider observations".
 */
export function productionDeployment(deployments: DeploymentObservation[], mergeSha: string, productionEnvironment: string) {
  const containing = deployments.filter(entry => entry.state === 'succeeded' && entry.containedMergeShas.includes(mergeSha));
  const deployment = containing.filter(entry => entry.environment === productionEnvironment).sort((a, b) => time(a.startedAt)! - time(b.startedAt)! || a.id.localeCompare(b.id))[0];
  if (deployment) return { deployment, reason: null };
  return { deployment: undefined, reason: !deployments.length ? 'no-deployment-provider-observations-recorded' : containing.length ? 'deployed-only-outside-production-environment' : 'no-production-deployment-observed-for-this-commit' };
}
// Pure aggregation. Given the bounded dataset it always produces the same report.
export function computeFlow(dataset: FlowDataset, query: FlowQuery) {
  const to = time(dataset.to)!, from = time(dataset.from)!;
  // A truncated scan describes less than the window it was asked for; every figure below is over
  // this interval, and the report says so rather than naming the full window.
  const covered = dataset.covered ?? fullyCovered(dataset.from, dataset.to);
  const productionEnvironment = query.productionEnvironment ?? defaultProductionEnvironment;
  const excluded = new Map<string, Set<string>>();
  const exclude = (reason: string, key: string) => { (excluded.get(reason) ?? excluded.set(reason, new Set()).get(reason)!).add(key); };
  const unavailable: { metric: string; reason: string }[] = [];
  const byWork = new Map<string, FlowFact[]>();
  for (const fact of dataset.facts) (byWork.get(fact.workId) ?? byWork.set(fact.workId, []).get(fact.workId)!).push(fact);
  const latest = new Map(dataset.latest.map(fact => [`${fact.workId}:${fact.kind}`, fact]));
  const carry = new Map(dataset.carryIn.map(fact => [`${fact.workId}:${fact.kind}`, fact]));
  const itemFacts = (id: string, kind: FlowKind) => (byWork.get(id) ?? []).filter(fact => fact.kind === kind);

  const scope = dataset.included.filter(item => {
    if (!latest.has(`${item.id}:work.created`)) { exclude('no-durable-history', item.key); return false; }
    return true;
  });
  const delivered = (item: Work) => latest.has(`${item.id}:delivered`);
  const currentStage = (item: Work) => latest.get(`${item.id}:stage.changed`)?.details.to ?? 'backlog';
  // A stage filter selects the current-stage cohort for every item-scoped metric.
  // Stage dwell is the one historical exception: it selects transitions whose
  // `from` stage is the requested stage, while still honoring the other item filters.
  // Repository-wide deployment metrics are intentionally unaffected.
  const stageScope = query.stage ? scope.filter(item => currentStage(item) === query.stage) : scope;
  const scopeIds = new Set(scope.map(item => item.id));
  const scopedIds = new Set(stageScope.map(item => item.id));
  const scopedFacts = dataset.facts.filter(fact => scopedIds.has(fact.workId));

  // Stage dwell: completed transitions only.
  const inverted = dataset.facts.filter(fact => fact.kind === 'stage.changed' && scopeIds.has(fact.workId)
    && (!query.stage || fact.details.from === query.stage) && fact.details.clockOrder === 'inverted');
  for (const fact of inverted) exclude('clock-inverted-transition', fact.workKey);
  const stageDwell = stages.map(stage => {
    const values = dataset.facts.filter(fact => fact.kind === 'stage.changed' && scopeIds.has(fact.workId)
      && (!query.stage || fact.details.from === query.stage) && fact.details.from === stage && typeof fact.details.dwellMs === 'number').map(fact => fact.details.dwellMs as number);
    return { stage, ...distribution(values) };
  });

  // Work in progress and aging, read back from durable stage facts.
  const wip = stages.map(stage => {
    const items = stageScope.filter(item => !delivered(item) && currentStage(item) === stage).map(item => {
      const since = latest.get(`${item.id}:stage.changed`)?.observedAt ?? latest.get(`${item.id}:work.created`)!.observedAt;
      return { key: item.key, id: item.id, since, ageMs: Math.max(0, to - time(since)!) };
    }).sort((a, b) => b.ageMs - a.ageMs);
    return { stage, count: items.length, oldestMs: items[0]?.ageMs ?? null, items: items.slice(0, flowLimits.distinct) };
  });

  // Cumulative flow: one reconstructed sample per daily boundary.
  const starts = bucketStarts(from, to);
  const stagePoints = new Map(stageScope.map(item => {
    const points = [...(carry.get(`${item.id}:stage.changed`) ? [carry.get(`${item.id}:stage.changed`)!] : []), ...itemFacts(item.id, 'stage.changed')]
      .map(fact => ({ at: time(fact.observedAt)!, value: fact.details.to as string }))
      .sort((a, b) => a.at - b.at);
    const created = time(latest.get(`${item.id}:work.created`)!.observedAt)!;
    return [item.id, { created, points, delivered: latest.get(`${item.id}:delivered`) ? time(latest.get(`${item.id}:delivered`)!.observedAt)! : null }];
  }));
  const cumulativeFlow = {
    buckets: starts.map(at => new Date(at).toISOString()),
    truncated: starts.length >= flowLimits.buckets && from + flowLimits.buckets * day < to,
    series: stages.map(stage => ({ stage, counts: starts.map(at => stageScope.filter(item => {
      const entry = stagePoints.get(item.id)!;
      if (entry.created > at || (entry.delivered !== null && entry.delivered <= at && stage !== 'done')) return false;
      return (valueAt(entry.points, at) ?? 'backlog') === stage;
    }).length) })),
  };

  // Throughput and lead time.
  const deliveredFacts = scopedFacts.filter(fact => fact.kind === 'delivered');
  const throughput = starts.map(at => ({ bucket: new Date(at).toISOString(), delivered: deliveredFacts.filter(fact => time(fact.observedAt)! >= at && time(fact.observedAt)! < at + day).length }));
  const leadValues: { key: string; ms: number; at: string }[] = [];
  for (const fact of deliveredFacts) {
    const created = latest.get(`${fact.workId}:work.created`);
    if (!created) { exclude('missing-created-fact', fact.workKey); continue; }
    const ms = time(fact.observedAt)! - time(created.observedAt)!;
    if (ms < 0) { exclude('clock-inverted-lead-time', fact.workKey); continue; }
    leadValues.push({ key: fact.workKey, ms, at: fact.observedAt });
  }
  const leadTime = {
    bands: distribution(leadValues.map(value => value.ms)),
    trend: starts.map(at => {
      const values = leadValues.filter(value => time(value.at)! >= at && time(value.at)! < at + day).map(value => value.ms);
      return { bucket: new Date(at).toISOString(), ...distribution(values) };
    }),
  };
  if (!deliveredFacts.length) unavailable.push({ metric: 'leadTime', reason: 'No delivery was observed in this window.' });

  // Queue time versus active work time, from lease facts.
  const leaseKinds: FlowKind[] = ['lease.claimed', 'lease.released', 'lease.lost'];
  // At one recorded instant a loss or release closes the previous lease before a
  // replacement claim opens the next, so equal-time facts never let an older epoch's
  // loss swallow the replacement's active time.
  const leaseOrder = (a: FlowFact, b: FlowFact) => time(a.observedAt)! - time(b.observedAt)! || (a.kind === 'lease.claimed' ? 1 : 0) - (b.kind === 'lease.claimed' ? 1 : 0);
  let activeTotal = 0, openTotal = 0, idleTotal = 0;
  const leaseRows = stageScope.map(item => {
    const events = [...leaseKinds.flatMap(kind => itemFacts(item.id, kind))].sort(leaseOrder);
    const before = leaseKinds.map(kind => carry.get(`${item.id}:${kind}`)).filter((fact): fact is FlowFact => !!fact).sort(leaseOrder).at(-1);
    let active = before?.kind === 'lease.claimed' ? from : null;
    let activeMs = 0;
    for (const event of events) {
      const at = Math.min(to, Math.max(from, time(event.observedAt)!));
      if (event.kind === 'lease.claimed') { if (active === null) active = at; }
      else if (active !== null) { activeMs += at - active; active = null; }
    }
    if (active !== null) activeMs += to - active;
    const releasedAt = latest.get(`${item.id}:work.released`) ? time(latest.get(`${item.id}:work.released`)!.observedAt)! : null;
    const deliveredAt = latest.get(`${item.id}:delivered`) ? time(latest.get(`${item.id}:delivered`)!.observedAt)! : null;
    const openFrom = Math.max(from, releasedAt ?? to), openTo = Math.min(to, deliveredAt ?? to);
    const openMs = Math.max(0, openTo - openFrom);
    activeTotal += Math.min(activeMs, openMs); openTotal += openMs; idleTotal += Math.max(0, openMs - activeMs);
    return { key: item.key, id: item.id, activeMs: Math.min(activeMs, openMs), queueMs: Math.max(0, openMs - activeMs), openMs };
  });
  const queueVsActive = {
    activeMs: activeTotal, queueMs: idleTotal, openMs: openTotal,
    activeRatio: openTotal ? Number((activeTotal / openTotal).toFixed(4)) : null,
    items: leaseRows.filter(row => row.openMs > 0).sort((a, b) => b.queueMs - a.queueMs).slice(0, flowLimits.distinct),
  };
  if (!openTotal) unavailable.push({ metric: 'queueVsActive', reason: 'No item was released and undelivered during this window.' });

  // Merge-ready dwell.
  const mergeReadyValues: number[] = [];
  const mergeReadyCurrent: { key: string; sinceMs: number }[] = [];
  for (const item of stageScope) {
    const gateFacts = [...(carry.get(`${item.id}:gates.changed`) ? [carry.get(`${item.id}:gates.changed`)!] : []), ...itemFacts(item.id, 'gates.changed')];
    const mergedFact = latest.get(`${item.id}:merged`);
    for (const interval of mergeReadyIntervals(gateFacts, mergedFact ? time(mergedFact.observedAt) : null, from, to)) {
      if (!interval.inWindow) { exclude('merge-ready-dwell-outside-window', item.key); continue; }
      mergeReadyValues.push(interval.ms);
      if (interval.closedBy === 'open') mergeReadyCurrent.push({ key: item.key, sinceMs: to - interval.startMs });
    }
  }
  const mergeReadyDwell = { ...distribution(mergeReadyValues), current: mergeReadyCurrent.sort((a, b) => b.sinceMs - a.sinceMs).slice(0, flowLimits.distinct) };

  // Candidate episodes. One episode is one commit under review; a new candidate supersedes
  // the previous one so a later push never silently extends an earlier measurement.
  interface Episode { key: string; workId: string; sha: string; pr: number | null; startedAt: number; partial: boolean; milestones: Record<string, { at: number | null; source: string; reason?: string }>; facts: FlowFact[] }
  const episodes: Episode[] = [];
  for (const item of stageScope) {
    const carried = carry.get(`${item.id}:candidate.observed`);
    const ordered = [...(carried ? [carried] : []), ...itemFacts(item.id, 'candidate.observed')]
      .sort((a, b) => time(a.recordedAt)! - time(b.recordedAt)!);
    for (let index = 0; index < ordered.length; index++) {
      const candidate = ordered[index];
      const startedAt = time(candidate.recordedAt)!;
      const endsAt = index + 1 < ordered.length ? time(ordered[index + 1].recordedAt)! : Infinity;
      const sha = String(candidate.details.sha ?? '');
      const facts = (byWork.get(item.id) ?? []).filter(fact => { const at = time(fact.recordedAt)!; return at >= startedAt && at < endsAt; });
      const matches = (fact: FlowFact) => !fact.details.sha || fact.details.sha === sha;
      const first = (kind: FlowKind, predicate: (fact: FlowFact) => boolean) => facts.filter(fact => fact.kind === kind && matches(fact) && predicate(fact)).sort((a, b) => time(a.observedAt)! - time(b.observedAt)!)[0];
      const reviewStart = [first('review.requested', () => true), first('review.submitted', () => true)].filter(Boolean).sort((a, b) => time(a!.observedAt)! - time(b!.observedAt)!)[0];
      const approval = [first('review.submitted', fact => fact.details.reviewState === 'APPROVED'), first('review.completed', fact => fact.details.approved === true)]
        .filter(Boolean).sort((a, b) => time(a!.observedAt)! - time(b!.observedAt)!)[0];
      // The acceptance gate stops refusing when the completing evidence is recorded; use that
      // record's own time so the milestone is an observed fact rather than a re-evaluation artefact.
      const gateCleared = facts.filter(fact => fact.kind === 'gates.changed' && fact.details.hasCandidate && !(fact.details.unmet ?? []).includes('acceptance')).sort((a, b) => time(a.observedAt)! - time(b.observedAt)!)[0];
      const evidenceComplete = gateCleared
        ? facts.filter(fact => fact.kind === 'evidence.recorded' && time(fact.observedAt)! <= time(gateCleared.observedAt)!).sort((a, b) => time(a.observedAt)! - time(b.observedAt)!).at(-1) ?? gateCleared
        : undefined;
      const authorized = first('merge.authorized', () => true);
      const merged = first('merged', () => true);
      const mergeSha = merged?.details.mergeSha ?? sha;
      const production = productionDeployment(dataset.deployments, mergeSha, productionEnvironment);
      const partial = startedAt < from;
      const milestone = (fact: FlowFact | undefined, source: string) => fact ? { at: time(fact.observedAt)!, source } : { at: null, source, reason: partial ? 'episode-started-before-window' : 'not-observed' };
      episodes.push({
        key: item.key, workId: item.id, sha, pr: candidate.details.pr ?? null, startedAt, partial, facts,
        milestones: {
          'pr-created': candidate.details.supersedes
            ? { at: startedAt, source: 'graphyard-candidate-observation' }
            : candidate.details.prCreatedAt ? { at: time(candidate.details.prCreatedAt)!, source: 'github' } : { at: null, source: 'github', reason: 'pull-request-creation-time-not-observed' },
          'review-start': milestone(reviewStart, 'github'),
          'review-complete': milestone(approval, 'github'),
          'evidence-complete': milestone(evidenceComplete, 'graphyard'),
          'merge-authorized': milestone(authorized, 'graphyard'),
          merged: milestone(merged, 'github'),
          production: production.deployment ? { at: time(production.deployment.startedAt)!, source: 'deployment-provider' } : { at: null, source: 'deployment-provider', reason: production.reason! },
        },
      });
    }
  }
  const phasePairs: [string, string, string][] = [
    ['pr-created-to-review-start', 'pr-created', 'review-start'],
    ['review-start-to-review-complete', 'review-start', 'review-complete'],
    ['review-complete-to-evidence-complete', 'review-complete', 'evidence-complete'],
    ['evidence-complete-to-merge-authorized', 'evidence-complete', 'merge-authorized'],
    ['merge-authorized-to-merged', 'merge-authorized', 'merged'],
    ['merged-to-production', 'merged', 'production'],
  ];
  const phases = phasePairs.map(([id, startId, endId]) => {
    const values: number[] = [], unknown: Record<string, number> = {};
    const note = (reason: string, key: string) => { unknown[reason] = (unknown[reason] ?? 0) + 1; exclude(`phase:${id}:${reason}`, key); };
    for (const episode of episodes) {
      const start = episode.milestones[startId], end = episode.milestones[endId];
      if (start.at === null) { note(start.reason ?? 'missing-start', episode.key); continue; }
      if (end.at === null) { note(end.reason ?? 'missing-end', episode.key); continue; }
      if (end.at < start.at) { note('clock-inverted', episode.key); continue; }
      values.push(end.at - start.at);
    }
    return { phase: id, from: startId, to: endId, ...distribution(values), unknown };
  });

  // CI duration, failure and retry, bounded by Graphyard observation intervals.
  const ciDurations: number[] = [];
  let ciFailures = 0, ciRetries = 0, ciRuns = 0;
  for (const episode of episodes) {
    const checks = new Map<string, FlowFact[]>();
    for (const fact of episode.facts.filter(fact => fact.kind === 'check.observed'))
      (checks.get(fact.details.name) ?? checks.set(fact.details.name, []).get(fact.details.name)!).push(fact);
    for (const [, observations] of checks) {
      const ordered = observations.sort((a, b) => time(a.observedAt)! - time(b.observedAt)!);
      const terminal = ordered.filter(fact => !fact.details.pending);
      const pending = ordered.find(fact => fact.details.pending);
      ciRuns += terminal.length ? 1 : 0;
      ciRetries += Math.max(0, terminal.length - 1);
      ciFailures += terminal.filter(fact => !['success', 'neutral', 'skipped'].includes(fact.details.result)).length;
      if (pending && terminal.length && time(terminal[0].observedAt)! >= time(pending.observedAt)!) ciDurations.push(time(terminal[0].observedAt)! - time(pending.observedAt)!);
      else if (terminal.length) exclude('ci-start-not-observed', episode.key);
    }
  }
  const ci = { ...distribution(ciDurations), runs: ciRuns, failures: ciFailures, retries: ciRetries, precision: 'Bounded by the Graphyard observation interval; provider check start times are not published to this control plane.' };
  if (!ciRuns) unavailable.push({ metric: 'ci', reason: 'No CI check observation was recorded in this window.' });

  // Evidence wait, expiry and staleness.
  const evidenceFacts = scopedFacts.filter(fact => fact.kind === 'evidence.recorded');
  const evidenceWait = phases.find(phase => phase.phase === 'review-complete-to-evidence-complete')!;
  const evidence = {
    recorded: evidenceFacts.length,
    trusted: evidenceFacts.filter(fact => fact.details.trusted).length,
    failing: evidenceFacts.filter(fact => fact.details.result !== 'pass').length,
    incomplete: evidenceFacts.filter(fact => fact.details.executed < 1 || fact.details.skipped > 0).length,
    expired: evidenceFacts.filter(fact => fact.details.expiresAt && time(fact.details.expiresAt)! < to).length,
    superseded: evidenceFacts.filter(fact => latest.get(`${fact.workId}:candidate.observed`) && fact.details.sha !== latest.get(`${fact.workId}:candidate.observed`)!.details.sha).length,
    wait: { n: evidenceWait.n, medianMs: evidenceWait.medianMs, p90Ms: evidenceWait.p90Ms, sparse: evidenceWait.sparse },
  };
  if (!evidenceFacts.length) unavailable.push({ metric: 'evidence', reason: 'No evidence was recorded in this window.' });

  // Wait-category timeline, sampled at daily boundaries for queue depth.
  const categoryPoints = new Map<string, { at: number; value: WaitCategory | null }[]>();
  for (const item of stageScope) {
    const gateFacts = [...(carry.get(`${item.id}:gates.changed`) ? [carry.get(`${item.id}:gates.changed`)!] : []), ...itemFacts(item.id, 'gates.changed')];
    const points = gateFacts.map(fact => ({ at: time(fact.observedAt)!, value: classifyWait(fact.details, false) }));
    const deliveredFact = latest.get(`${item.id}:delivered`);
    if (deliveredFact) points.push({ at: time(deliveredFact.observedAt)!, value: 'delivered' as WaitCategory });
    categoryPoints.set(item.id, points.sort((a, b) => a.at - b.at));
  }
  const queueDepth = starts.map(at => {
    const counts: Record<string, number> = {};
    for (const item of stageScope) { const value = valueAt(categoryPoints.get(item.id)!, at); if (value) counts[value] = (counts[value] ?? 0) + 1; }
    return { bucket: new Date(at).toISOString(), counts };
  });
  const queueUtilization = [
    { queue: 'reviewer', categories: ['review'], definition: 'Items whose observed candidate still lacks a satisfying review.' },
    { queue: 'proof', categories: ['evidence'], definition: 'Items whose required proofs still lack trusted passing evidence.' },
    { queue: 'operator', categories: ['backlog', 'blocked'], definition: 'Items waiting on an operator decision: unreleased intent or a recorded blocker.' },
    { queue: 'worker', categories: ['implementation'], definition: 'Released, unblocked items with no observed candidate yet.' },
    { queue: 'merge', categories: ['merge-ready'], definition: 'Proven candidates waiting in the merge queue or for the merge itself to be observed.' },
  ].map(queue => {
    const depths = queueDepth.map(sample => queue.categories.reduce((sum, category) => sum + (sample.counts[category] ?? 0), 0));
    return { queue: queue.queue, definition: queue.definition, samples: depths.length, averageDepth: depths.length ? Number((depths.reduce((a, b) => a + b, 0) / depths.length).toFixed(2)) : null, maxDepth: depths.length ? Math.max(...depths) : null };
  });

  // Dependency critical path across undelivered work.
  const dependencies = new Map(dataset.work.map(item => [item.id, (latest.get(`${item.id}:dependencies.changed`)?.details.dependencies ?? []) as string[]]));
  const keyOf = new Map(dataset.work.map(item => [item.id, item.key]));
  const deliveredIds = new Set(dataset.work.filter(item => latest.has(`${item.id}:delivered`)).map(item => item.id));
  const chains = new Map<string, string[]>();
  const chainOf = (id: string, visiting: Set<string>): string[] => {
    if (chains.has(id)) return chains.get(id)!;
    if (visiting.has(id)) return [];
    visiting.add(id);
    let best: string[] = [];
    for (const dependency of dependencies.get(id) ?? []) {
      if (deliveredIds.has(dependency) || !keyOf.has(dependency)) continue;
      const chain = chainOf(dependency, visiting);
      if (chain.length > best.length) best = chain;
    }
    visiting.delete(id);
    const result = [...best, keyOf.get(id) ?? id];
    chains.set(id, result);
    return result;
  };
  const criticalPath = stageScope.filter(item => !deliveredIds.has(item.id)).map(item => chainOf(item.id, new Set())).sort((a, b) => b.length - a.length)[0] ?? [];
  const unblocked = stageScope.filter(item => {
    const gate = latest.get(`${item.id}:gates.changed`)?.details;
    return !deliveredIds.has(item.id) && gate?.released && !gate.blocker && !(gate.dependencyWaiting ?? []).length;
  }).map(item => item.key);

  // Review rounds, findings, rework.
  const reviewFacts = scopedFacts.filter(fact => fact.kind === 'review.submitted');
  const roundsByItem = new Map<string, number>();
  for (const fact of reviewFacts) roundsByItem.set(fact.workKey, (roundsByItem.get(fact.workKey) ?? 0) + 1);
  const withCandidate = stageScope.filter(item => latest.has(`${item.id}:candidate.observed`));
  const reworked = new Set(scopedFacts.filter(fact => fact.kind === 'rework.requested').map(fact => fact.workKey));
  const review = {
    rounds: countSummary([...roundsByItem.values()]),
    findings: reviewFacts.filter(fact => fact.details.reviewState === 'CHANGES_REQUESTED').length,
    approvals: reviewFacts.filter(fact => fact.details.reviewState === 'APPROVED').length,
    independentApprovals: reviewFacts.filter(fact => fact.details.reviewState === 'APPROVED' && fact.details.independent).length,
    agentCompletions: scopedFacts.filter(fact => fact.kind === 'review.completed').length,
    reworkRequests: scopedFacts.filter(fact => fact.kind === 'rework.requested').length,
    reworkRate: withCandidate.length ? Number((reworked.size / withCandidate.length).toFixed(4)) : null,
    candidates: withCandidate.length,
  };
  if (!withCandidate.length) unavailable.push({ metric: 'review', reason: 'No candidate was observed for the selected work.' });

  const leases = {
    claims: scopedFacts.filter(fact => fact.kind === 'lease.claimed').length,
    reassignments: scopedFacts.filter(fact => fact.kind === 'lease.claimed' && fact.details.reassignment).length,
    releases: scopedFacts.filter(fact => fact.kind === 'lease.released').length,
    losses: scopedFacts.filter(fact => fact.kind === 'lease.lost').length,
    expirations: scopedFacts.filter(fact => fact.kind === 'lease.lost' && fact.details.reason === 'expired').length,
    utilizationRatio: queueVsActive.activeRatio, idleCapacityMs: queueVsActive.queueMs,
  };

  const counted = (facts: FlowFact[], value: (fact: FlowFact) => string | null) => {
    const counts = new Map<string, number>();
    for (const fact of facts) { const key = value(fact); if (key) counts.set(key, (counts.get(key) ?? 0) + 1); }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, flowLimits.distinct).map(([reason, count]) => ({ reason, count }));
  };
  const deployedSuccess = dataset.deployments.filter(entry => entry.state === 'succeeded');
  const deploymentLatency: number[] = [];
  for (const [deploymentIndex, entry] of deployedSuccess.entries()) {
    const merged = dataset.mergedForDeployments.filter(fact => entry.containedMergeShas.includes(fact.details.mergeSha));
    const exclusionKey = `deployment-observation-${deploymentIndex + 1}`;
    if (!merged.length) { exclude('deployment-without-observed-merge', exclusionKey); continue; }
    const value = time(entry.startedAt)! - Math.max(...merged.map(fact => time(fact.observedAt)!));
    if (value < 0) exclude('clock-inverted-deployment', exclusionKey); else deploymentLatency.push(value);
  }
  const deployments = {
    observations: dataset.deployments.length,
    environments: [...new Set(dataset.deployments.map(entry => entry.environment))].sort(),
    productionEnvironment,
    productionObservations: dataset.deployments.filter(entry => entry.environment === productionEnvironment).length,
    succeeded: deployedSuccess.length,
    failed: dataset.deployments.filter(entry => entry.state === 'failed').length,
    rollbacks: dataset.deployments.filter(entry => entry.state === 'rolled_back').length,
    perDay: dataset.deployments.length ? Number((dataset.deployments.length / query.days).toFixed(3)) : null,
    failureRate: dataset.deployments.length ? Number((dataset.deployments.filter(entry => entry.state !== 'succeeded').length / dataset.deployments.length).toFixed(4)) : null,
    latency: distribution(deploymentLatency),
    pullRequestsPerDeployment: countSummary(deployedSuccess.map(entry => dataset.mergedForDeployments.filter(fact => entry.containedMergeShas.includes(fact.details.mergeSha)).length).filter(count => count > 0)),
  };
  if (!dataset.deployments.length) unavailable.push({ metric: 'deployments', reason: 'No deployment-provider observation has been recorded for this window. Deployment metrics are unavailable, not zero.' });

  const operations = {
    blockers: counted(scopedFacts.filter(fact => fact.kind === 'blocker.set'), blockerReasonKey),
    refusals: counted(scopedFacts.filter(fact => fact.kind === 'gates.changed'), fact => fact.details.firstUnmetReason ? String(fact.details.firstUnmetReason).slice(0, 200) : null),
    refusalGates: counted(scopedFacts.filter(fact => fact.kind === 'gates.changed'), fact => fact.details.firstUnmet ?? null),
    criticalPath: { length: criticalPath.length, chain: criticalPath.slice(-flowLimits.distinct) },
    unblocked: { count: unblocked.length, items: unblocked.slice(0, flowLimits.distinct) },
    review, leases, queues: queueUtilization, queueDepth, deployments,
  };

  // Bottleneck summary: every undelivered item lands in exactly one category.
  const classified = stageScope.filter(item => !deliveredIds.has(item.id)).map(item => {
    const gate = latest.get(`${item.id}:gates.changed`)?.details;
    if (!gate) exclude('no-durable-gate-fact', item.key);
    return { key: item.key, id: item.id, category: classifyWait(gate, false), since: latest.get(`${item.id}:gates.changed`)?.observedAt ?? null };
  });
  const categories = waitCategories.filter(category => category.id !== 'delivered').map(category => {
    const items = classified.filter(entry => entry.category === category.id)
      .map(entry => ({ key: entry.key, id: entry.id, since: entry.since, waitingMs: entry.since ? Math.max(0, to - time(entry.since)!) : null }))
      .sort((a, b) => (b.waitingMs ?? 0) - (a.waitingMs ?? 0));
    return { ...category, count: items.length, items: items.slice(0, flowLimits.distinct), truncated: items.length > flowLimits.distinct };
  });
  const leading = [...categories].filter(category => category.count > 0).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))[0] ?? null;
  const bottleneck = {
    observedAt: dataset.observedAt,
    scope: { workItems: stageScope.length, undelivered: classified.length, filters: { window: `${query.days}d`, type: query.type ?? null, stage: query.stage ?? null, slice: query.slice ?? null } },
    categories,
    leading: leading ? { category: leading.id, label: leading.label, count: leading.count } : null,
    narrative: leading
      ? `${leading.count} of ${classified.length} undelivered item(s) are ${leading.label.toLowerCase()}. ` + categories.filter(category => category.count > 0).map(category => `${category.count} ${category.label.toLowerCase()}`).join(', ') + '.'
      : 'No undelivered work item is currently recorded in scope.',
    unclassified: classified.filter(entry => !entry.category).map(entry => entry.key),
  };

  const sliceSummary = { observed: 0, declared: 0, unclassified: 0, truncated: 0, limit: sliceLimit };
  for (const item of stageScope) { const classified = workSlices(item); sliceSummary[classified.provenance]++; if (classified.truncated) sliceSummary.truncated++; }
  // A slice filter cannot see roots beyond an item's bound, so items truncated anywhere in
  // the repository are part of the filter's coverage, not only those already selected.
  const slicesTruncatedInRepository = dataset.work.filter(item => workSlices(item).truncated).length;
  const observedTimes = scopedFacts.filter(fact => fact.details.timestampSource === 'github').length;
  const coverage = {
    workItems: stageScope.length, workItemsInRepository: dataset.work.length, selected: dataset.included.length,
    undelivered: stageScope.filter(item => !deliveredIds.has(item.id)).length,
    withObservedCandidate: withCandidate.length,
    facts: dataset.facts.length, scanned: dataset.scanned, scanLimit: Math.min(query.limit ?? flowLimits.scan, flowLimits.scan), truncated: dataset.truncated,
    // What the scan covered of the window it was asked for, and what it never reached.
    covered,
    workItemScanLimit: flowLimits.work, workItemsTruncated: dataset.workTruncated,
    deploymentScanLimit: flowLimits.deployments, deploymentsTruncated: dataset.deploymentsTruncated,
    deploymentMergeScanLimit: flowLimits.deploymentMerges, deploymentMergesTruncated: dataset.deploymentMergesTruncated,
    oldestFact: dataset.facts[0]?.observedAt ?? null, newestFact: dataset.facts.at(-1)?.observedAt ?? null,
    providerTimestamps: observedTimes, controlPlaneTimestamps: scopedFacts.length - observedTimes,
    slices: { ...sliceSummary, truncatedInRepository: slicesTruncatedInRepository },
    // A slice filter over an item whose roots were bounded may have missed that item.
    sliceFilterTruncated: !!query.slice && slicesTruncatedInRepository > 0,
    projection: { ...dataset.projection, stale: dataset.projection.pendingEvents > 0 },
    sparse: dataset.facts.length < sparseSampleSize,
    complete: !dataset.truncated && !dataset.workTruncated && !dataset.deploymentsTruncated && !dataset.deploymentMergesTruncated && dataset.projection.pendingEvents === 0 && !(query.slice && slicesTruncatedInRepository > 0),
  };
  const exclusions = [...excluded].map(([reason, keys]) => ({ reason, count: keys.size, items: [...keys].sort().slice(0, flowLimits.distinct) }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  return {
    generatedAt: dataset.observedAt, timezone: 'UTC', productionEnvironment,
    // The window as asked for, and — when a bound cut the scan short — the interval these figures
    // actually describe, so a partial window is never read as a full one.
    window: { days: query.days, from: dataset.from, to: dataset.to, covered, truncated: covered.truncated,
      boundaries: 'Half-open interval [from, to) in UTC. Daily buckets start at the window start and are labelled by their start instant.' },
    filters: { type: query.type ?? null, stage: query.stage ?? null, slice: query.slice ?? null },
    availableSlices: [...new Set(dataset.work.flatMap(item => workSlices(item).slices))].sort(),
    availableTypes: [...new Set(dataset.work.map(item => item.type))].sort(),
    definitions: metricDefinitions, limits: flowLimits,
    privacy: {
      individualAttribution: 'excluded',
      statement: 'Flow analytics describe observed work, queueing, and capacity. No metric is keyed by a person, and no principal, provider login, or producer identity is stored in a flow fact or returned by this API.',
    },
    coverage, exclusions, unavailable,
    stageDwell, wip, cumulativeFlow, throughput, leadTime, queueVsActive, mergeReadyDwell, phases, ci, evidence, operations, bottleneck,
  };
}
export type FlowReport = ReturnType<typeof computeFlow>;

export interface DrilldownRequest { metric: string; key?: string | null; authorized?: boolean }
const drilldownMetrics = ['bottleneck', 'wip', 'stage-dwell', 'lead-time', 'throughput', 'phase', 'evidence', 'merge-ready', 'deployments', 'review', 'blockers'] as const;
export const drilldownCatalog = drilldownMetrics;

// Bounded drill-down to the exact underlying records behind an aggregate.
export function flowDrilldown(dataset: FlowDataset, report: FlowReport, request: DrilldownRequest) {
  const metric = request.metric, key = request.key ?? null, authorized = request.authorized === true;
  const columns = ['workKey', 'metric', 'bucket', 'observedAt', 'valueMs', 'pullRequest', 'commit', 'detail'];
  const rows: Record<string, string | number | null>[] = [];
  const keyOf = new Map(dataset.work.map(item => [item.id, item.key]));
  const latest = new Map(dataset.latest.map(fact => [`${fact.workId}:${fact.kind}`, fact]));
  const currentStage = (item: Work) => latest.get(`${item.id}:stage.changed`)?.details.to ?? 'backlog';
  const scoped = dataset.included.filter(item => latest.has(`${item.id}:work.created`) && (!report.filters.stage || currentStage(item) === report.filters.stage));
  const scopedIds = new Set(scoped.map(item => item.id));
  const row = (workKey: string, bucket: string | null, observedAt: string | null, valueMs: number | null, pr: number | null, commit: string | null, detail: string) =>
    rows.push({ workKey, metric, bucket, observedAt, valueMs, pullRequest: pr, commit, detail });
  if (metric === 'bottleneck') {
    for (const item of scoped.filter(item => !latest.has(`${item.id}:delivered`))) {
      const gate = latest.get(`${item.id}:gates.changed`), category = classifyWait(gate?.details, false);
      if (key && category !== key) continue;
      const candidate = latest.get(`${item.id}:candidate.observed`), since = gate?.observedAt ?? null;
      row(item.key, category, since, since ? Math.max(0, time(dataset.to)! - time(since)!) : null, candidate?.details.pr ?? null, candidate?.details.sha ?? null,
        String(gate?.details.firstUnmetReason ?? waitCategories.find(entry => entry.id === category)?.definition ?? 'No durable gate fact'));
    }
  } else if (metric === 'wip') {
    for (const item of scoped.filter(item => !latest.has(`${item.id}:delivered`))) {
      const stage = currentStage(item);
      if (key && stage !== key) continue;
      const since = latest.get(`${item.id}:stage.changed`)?.observedAt ?? latest.get(`${item.id}:work.created`)!.observedAt;
      row(item.key, stage, since, Math.max(0, time(dataset.to)! - time(since)!), null, null, `In ${stage}`);
    }
  } else if (metric === 'stage-dwell') {
    const selectedStage = report.filters.stage;
    const baseIds = new Set(dataset.included.filter(item => latest.has(`${item.id}:work.created`)).map(item => item.id));
    for (const fact of dataset.facts.filter(fact => fact.kind === 'stage.changed' && baseIds.has(fact.workId)
      && (!selectedStage || fact.details.from === selectedStage) && (!key || fact.details.from === key) && typeof fact.details.dwellMs === 'number'))
      row(fact.workKey, String(fact.details.from), fact.observedAt, fact.details.dwellMs, null, null, `${fact.details.from} to ${fact.details.to}`);
  } else if (metric === 'lead-time' || metric === 'throughput') {
    // Throughput counts every delivered fact. Lead time applies the aggregate's own
    // predicate, so a delivery without a created fact or with an inverted clock order is
    // absent here exactly as it is excluded there, never emitted as a negative duration.
    for (const fact of dataset.facts.filter(fact => fact.kind === 'delivered' && scopedIds.has(fact.workId))) {
      const created = dataset.latest.find(entry => entry.workId === fact.workId && entry.kind === 'work.created');
      const bucket = new Date(Math.floor((time(fact.observedAt)! - time(dataset.from)!) / day) * day + time(dataset.from)!).toISOString();
      if (key && bucket !== key) continue;
      const leadMs = created ? time(fact.observedAt)! - time(created.observedAt)! : null;
      const measurable = leadMs !== null && leadMs >= 0;
      if (metric === 'lead-time' && !measurable) continue;
      row(fact.workKey, bucket, fact.observedAt, measurable ? leadMs : null, fact.details.pr ?? null, fact.details.mergeSha ?? null,
        measurable ? 'Observed authorized merge' : created ? 'Observed authorized merge; lead time excluded (clock-inverted-lead-time)' : 'Observed authorized merge; lead time excluded (missing-created-fact)');
    }
  } else if (metric === 'phase') {
    const pairs = [
      ['pr-created-to-review-start', 'pr-created', 'review-start'],
      ['review-start-to-review-complete', 'review-start', 'review-complete'],
      ['review-complete-to-evidence-complete', 'review-complete', 'evidence-complete'],
      ['evidence-complete-to-merge-authorized', 'evidence-complete', 'merge-authorized'],
      ['merge-authorized-to-merged', 'merge-authorized', 'merged'],
      ['merged-to-production', 'merged', 'production'],
    ].filter(([phase]) => !key || phase === key);
    for (const item of scoped) {
      const candidates = [...(dataset.carryIn.filter(fact => fact.workId === item.id && fact.kind === 'candidate.observed')),
        ...dataset.facts.filter(fact => fact.workId === item.id && fact.kind === 'candidate.observed')]
        .sort((a, b) => time(a.recordedAt)! - time(b.recordedAt)!);
      for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index], startedAt = time(candidate.recordedAt)!;
        const endsAt = candidates[index + 1] ? time(candidates[index + 1].recordedAt)! : Infinity;
        const sha = String(candidate.details.sha ?? '');
        const facts = dataset.facts.filter(fact => fact.workId === item.id && time(fact.recordedAt)! >= startedAt && time(fact.recordedAt)! < endsAt && (!fact.details.sha || fact.details.sha === sha));
        const first = (kind: FlowKind, predicate: (fact: FlowFact) => boolean = () => true) => facts.filter(fact => fact.kind === kind && predicate(fact)).sort((a, b) => time(a.observedAt)! - time(b.observedAt)!)[0];
        const reviewStart = [first('review.requested'), first('review.submitted')].filter((fact): fact is FlowFact => !!fact).sort((a, b) => time(a.observedAt)! - time(b.observedAt)!)[0];
        const reviewComplete = [first('review.submitted', fact => fact.details.reviewState === 'APPROVED'), first('review.completed', fact => fact.details.approved === true)].filter((fact): fact is FlowFact => !!fact).sort((a, b) => time(a.observedAt)! - time(b.observedAt)!)[0];
        const gateCleared = facts.filter(fact => fact.kind === 'gates.changed' && fact.details.hasCandidate && !(fact.details.unmet ?? []).includes('acceptance')).sort((a, b) => time(a.observedAt)! - time(b.observedAt)!)[0];
        const evidenceComplete = gateCleared ? facts.filter(fact => fact.kind === 'evidence.recorded' && time(fact.observedAt)! <= time(gateCleared.observedAt)!).sort((a, b) => time(a.observedAt)! - time(b.observedAt)!).at(-1) ?? gateCleared : undefined;
        const merged = first('merged');
        const deployment = productionDeployment(dataset.deployments, merged?.details.mergeSha ?? sha, report.productionEnvironment).deployment;
        const milestones: Record<string, number | null> = {
          'pr-created': candidate.details.supersedes ? startedAt : time(candidate.details.prCreatedAt), 'review-start': reviewStart ? time(reviewStart.observedAt) : null,
          'review-complete': reviewComplete ? time(reviewComplete.observedAt) : null, 'evidence-complete': evidenceComplete ? time(evidenceComplete.observedAt) : null,
          'merge-authorized': time(first('merge.authorized')?.observedAt), merged: time(merged?.observedAt), production: time(deployment?.startedAt),
        };
        for (const [phase, startId, endId] of pairs) {
          const start = milestones[startId], end = milestones[endId];
          if (start === null || end === null || end < start) continue;
          row(item.key, phase, new Date(end).toISOString(), end - start, candidate.details.pr ?? null, sha, `${startId} to ${endId}`);
        }
      }
    }
  } else if (metric === 'evidence') {
    for (const fact of dataset.facts.filter(fact => fact.kind === 'evidence.recorded' && scopedIds.has(fact.workId) && (!key || fact.details.proof === key)))
      row(fact.workKey, String(fact.details.proof), fact.observedAt, null, null, fact.details.sha ?? null,
        authorized ? `${fact.details.result}; trusted=${fact.details.trusted}; executed=${fact.details.executed}; skipped=${fact.details.skipped}; evidence=${fact.details.evidenceId}${fact.details.validation ? `; artifactRequest=${fact.details.validation.requestId}` : ''}`
          : `${fact.details.result}; trusted=${fact.details.trusted}; identifiers require an authorized role`);
  } else if (metric === 'merge-ready') {
    for (const item of scoped) {
      const carried = dataset.carryIn.find(fact => fact.workId === item.id && fact.kind === 'gates.changed');
      const gates = [...(carried ? [carried] : []), ...dataset.facts.filter(fact => fact.workId === item.id && fact.kind === 'gates.changed')];
      const merged = latest.get(`${item.id}:merged`);
      for (const interval of mergeReadyIntervals(gates, merged ? time(merged.observedAt) : null, time(dataset.from)!, time(dataset.to)!)) {
        if (!interval.inWindow) continue;
        row(item.key, 'merge-ready', new Date(interval.startMs).toISOString(), interval.ms, interval.closedBy === 'merged' ? merged?.details.pr ?? null : null, interval.closedBy === 'merged' ? merged?.details.mergeSha ?? null : null,
          interval.closedBy === 'refused' ? 'Merge ready until a later gate observation refused' : interval.closedBy === 'merged' ? 'Merge ready until the observed merge' : 'Merge ready (queued or every gate passed); merge not yet observed');
      }
    }
  } else if (metric === 'deployments') {
    for (const entry of dataset.deployments.filter(entry => !key || entry.environment === key)) {
      const merged = dataset.mergedForDeployments.filter(fact => entry.containedMergeShas.includes(fact.details.mergeSha));
      for (const fact of merged.length ? merged : [null])
        row(fact ? keyOf.get(fact.workId) ?? fact.workKey : 'unlinked', entry.environment, entry.startedAt, fact ? time(entry.startedAt)! - time(fact.observedAt)! : null, fact?.details.pr ?? null, authorized ? entry.sha : null,
          authorized ? `${entry.state} via ${entry.provider} ${entry.externalId}` : `${entry.state}; deployment identifiers require an authorized role`);
    }
  } else if (metric === 'review') {
    for (const fact of dataset.facts.filter(fact => fact.kind === 'review.submitted' && scopedIds.has(fact.workId) && (!key || fact.details.reviewState === key)))
      row(fact.workKey, String(fact.details.reviewState), fact.observedAt, null, null, fact.details.sha ?? null, `independent=${fact.details.independent}; timestamp=${fact.details.timestampSource}`);
  } else if (metric === 'blockers') {
    // The aggregate keys on the bounded reason label; the drill-down must match the same label.
    for (const fact of dataset.facts.filter(fact => fact.kind === 'blocker.set' && scopedIds.has(fact.workId) && (!key || blockerReasonKey(fact) === key)))
      row(fact.workKey, blockerReasonKey(fact) ?? 'blocker', fact.observedAt, null, null, null, String(fact.details.reason ?? ''));
  } else {
    return { metric, key, supported: drilldownMetrics, error: `Unknown drill-down metric; choose one of ${drilldownMetrics.join(', ')}`, columns, rows: [], total: 0, truncated: false };
  }
  const order = (value: Record<string, any>) => `${String(value.workKey).replace(/\d+/, match => match.padStart(8, '0'))}|${value.bucket ?? ''}|${value.observedAt ?? ''}|${value.commit ?? ''}|${value.detail}`;
  rows.sort((left, right) => order(left).localeCompare(order(right)));
  return { metric, key, supported: drilldownMetrics, columns, total: rows.length, truncated: rows.length > flowLimits.drilldown, rows: rows.slice(0, flowLimits.drilldown), authorized };
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
// Deterministic export: identical inputs produce identical bytes, and every row set
// carries the definitions, timezone, filters, coverage, exclusions and observation time.
export function flowExport(report: FlowReport, drilldown: ReturnType<typeof flowDrilldown>, format: 'csv' | 'json') {
  const metadata = {
    metric: drilldown.metric, key: drilldown.key ?? null,
    definition: metricDefinitions[drilldown.metric === 'stage-dwell' ? 'stageDwell' : drilldown.metric === 'lead-time' ? 'leadTime' : drilldown.metric === 'merge-ready' ? 'mergeReadyDwell' : drilldown.metric === 'phase' ? 'phases' : drilldown.metric === 'blockers' ? 'operations' : drilldown.metric === 'review' ? 'operations' : drilldown.metric]?.formula ?? 'See the metric definitions in the report.',
    generatedAt: report.generatedAt, timezone: report.timezone, productionEnvironment: report.productionEnvironment,
    window: `${report.window.from}/${report.window.to}`, windowDays: report.window.days, windowBoundaries: report.window.boundaries,
    // An export of a truncated scan carries the interval it really describes, in its own rows.
    windowCovered: `${report.window.covered.from}/${report.window.covered.toCovered}`,
    windowCoveredFraction: report.window.covered.fraction, windowTruncated: report.window.truncated,
    windowCoverage: report.window.covered.statement,
    filterType: report.filters.type, filterStage: report.filters.stage, filterSlice: report.filters.slice,
    coverageWorkItems: report.coverage.workItems, coverageFacts: report.coverage.facts,
    coverageTruncated: report.coverage.truncated, coverageWorkItemsTruncated: report.coverage.workItemsTruncated,
    coverageDeploymentsTruncated: report.coverage.deploymentsTruncated, coverageDeploymentMergesTruncated: report.coverage.deploymentMergesTruncated, coverageComplete: report.coverage.complete,
    projectionPendingEvents: report.coverage.projection.pendingEvents,
    exclusions: report.exclusions.map(entry => `${entry.reason}=${entry.count}`).join('; ') || 'none',
    rows: drilldown.total, rowsReturned: drilldown.rows.length, rowsTruncated: drilldown.truncated,
    identifiersAuthorized: drilldown.authorized === true,
  };
  if (format === 'json') return JSON.stringify({ metadata, columns: drilldown.columns, rows: drilldown.rows }, null, 2);
  const preamble = Object.entries(metadata).map(([name, value]) => `# ${csvCell(name)},${csvCell(value)}`);
  const header = drilldown.columns.join(',');
  const body = drilldown.rows.map(entry => drilldown.columns.map(column => csvCell(entry[column])).join(','));
  return [...preamble, header, ...body].join('\n') + '\n';
}
