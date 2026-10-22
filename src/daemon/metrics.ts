// Concern: measurement — stage percentiles, actionable subjects and item latency.
import { type Work, currentEvidence } from '../model.js';
import { pendingBaseRefresh } from '../model/base-refresh.js';
import { stalledItems } from '../model/action-account.js';
import { type MasterConfig, assertDispatchable } from '../master.js';
import { type DaemonActionKind, type DaemonState, type CycleMetrics } from './state.js';
import { type ItemClock, itemClockSchema, type LatencySample, latencySampleSchema } from './latency-clock.js';
import { isHotfix, wipHoldWording } from '../model/dispatch.js';
import { mergeableCandidate, neededRework } from './rework.js';
import { boundDetail } from './text.js';



export function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted.length ? Math.max(0, Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)])) : 0;
  return { count: sorted.length, p50Ms: at(50), p90Ms: at(90) };
}

/**
 * How the coordination cycle keeps to its configured interval, from the durations the daemon
 * records for its retained cycles: the last one, the p95, and every cycle that overran. A cycle
 * longer than its interval means the loop is falling behind the work it shepherds.
 */
export function cycleBudget(state: Pick<DaemonState, 'metrics'>, intervalMs: number) {
  const metrics = state.metrics;
  const last = metrics.at(-1) ?? null;
  const durations = metrics.map(metric => metric.durationMs).sort((a, b) => a - b);
  const p95Ms = durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)] : null;
  const overruns = metrics.filter(metric => metric.durationMs > intervalMs);
  const describe = (m: CycleMetrics) => ({ cycle: m.cycle, at: m.at, durationMs: m.durationMs, childWaitMs: m.childWaitMs ?? null, workMs: m.workMs ?? null });
  return {
    intervalMs, measured: metrics.length, lastCycle: last ? describe(last) : null,
    withinInterval: last ? last.durationMs <= intervalMs : null, p95Ms, overruns: overruns.length,
    lastOverrun: overruns.length ? describe(overruns.at(-1)!) : null,
  };
}

/**
 * Stage dwell for work still in flight and delivered lead time (creation to merge: done = merged,
 * GY-1981). Both come from the snapshot the cycle already read, so the measurement cannot disagree
 * with the state the cycle acted on.
 */
export function stageMetrics(work: Work[], now: number) {
  const stages: Record<string, ReturnType<typeof percentiles>> = {};
  const open = work.filter(item => item.stage !== 'done');
  for (const stage of [...new Set(open.map(item => item.stage))].sort()) {
    stages[stage] = percentiles(open.filter(item => item.stage === stage).map(item => now - Date.parse(item.stageEnteredAt)).filter(Number.isFinite));
  }
  const delivered = work.filter(item => item.stage === 'done' && item.delivery);
  const lead = percentiles(delivered.map(item => Date.parse(item.delivery!.mergedAt) - Date.parse(item.createdAt)).filter(value => Number.isFinite(value) && value >= 0));
  return { stages, lead };
}

export function missingProofs(work: Work, now: Date) {
  const proofs = [...new Set(work.criteria.flatMap(criterion => criterion.proofs))];
  return proofs.filter(proof => {
    const evidence = currentEvidence(work, proof, now);
    return !evidence || evidence.result !== 'pass' || evidence.executed < 1 || evidence.skipped > 0;
  });
}

// ---- What the loop could act on ------------------------------------------------------------
/*
 * A cycle that reports "0 actions" says nothing about whether it had anything to do. Every cycle
 * therefore records both halves: the subjects it could act on, and the actions it took. The
 * subjects feed the master session's wake (one wake per changed subject, by digest) and the
 * cycle's `actionable` count; whether the whole pipeline has gone still is the progress
 * watchdog's judgement (progressAttention in ./liveness.ts), not a per-subject wait.
 */
export interface ActionableSubject { key: string; kind: DaemonActionKind; work: string | null; detail: string }
export function actionableSubjects(config: Pick<MasterConfig, 'autoMerge' | 'run'>, work: Work[], now: number,
  context: { baseFailed?: Map<string, Set<string>>;
    /** GY-1890: the dispatch step stopped on a saturated fleet — no launch profile free by its own `saturatedFleet` decision — so a claimable item's wait is the fleet's slot capacity, not a dispatch wait. */ fleetHeld?: boolean;
    /** GY-2097: the dispatch step held a claimable item under the in-flight cap — `maxInFlight` items are being built or waiting to merge — so its wait is the cap's capacity, not a dispatch wait. */ wipHeld?: boolean;
    /** GY-1890: whether an item's own launch is in flight; its slot is allocated, so its wait is that launch, never the fleet's capacity. */ launching?: (item: Work) => boolean } = {}): ActionableSubject[] {
  const subjects: ActionableSubject[] = [];
  // A subject's detail is bounded to 500 characters: the master session wakes once per changed
  // detail (its digest), so a refusal or proof list quoted here is cut to fit.
  const add = (kind: DaemonActionKind, item: Work | null, detail: string) => subjects.push({ key: `${kind}:${item?.key ?? 'pipeline'}`, kind, work: item?.key ?? null, detail: boundDetail(detail, 500) });
  // An open item the control plane names no action for and nothing is moving. The loop cannot
  // clear it — that is what makes it a subject rather than an action: named here, it is absent
  // from no measure the loop keeps, which is how an item used to hold a failing gate for hours
  // with nobody told (GY-106). The master session is woken once per changed detail, and the
  // progress watchdog (./liveness.ts) judges whether the whole pipeline has gone still.
  const stalled = new Map(stalledItems(work, new Date(now), 0).map(entry => [entry.key, entry]));
  for (const item of work) {
    // A rework the loop owes is a subject until it is applied.
    const rework = neededRework(item);
    if (rework) add('judgement', item, `${item.key} returns to a worker: ${rework.reason}`);
    if (item.stage === 'done') continue;
    const stall = stalled.get(item.key);
    if (stall) add('attention', item, `${item.key} holds its ${stall.gate ?? 'unevaluated'} gate with no action, no dependency and no recorded human need: ${stall.refusal ?? stall.detail}`);
    // GY-1890: with no launch profile free the wait on a claimable item is the fleet's slot
    // capacity, so it is a capacity subject, not a dispatch one: the loop cannot end it by acting.
    // An item whose own launch is in flight already holds its slot: it waits on that launch, not the fleet.
    // GY-2097: the same reading for an item the in-flight cap holds — only a merge frees a slot, so
    // the wait is the cap's capacity; a "Hotfix: …" item starts whatever the count and keeps the
    // loop's own dispatch subject while it waits for a profile.
    try { assertDispatchable(item, work, new Date(now).toISOString()); const launching = !!context.launching?.(item), fleetHeld = context.fleetHeld && !launching, wipHeld = !launching && context.wipHeld && !isHotfix(item); add(wipHeld || fleetHeld ? 'capacity' : 'dispatch', item, wipHeld ? `${item.key} ${wipHoldWording.held}` : fleetHeld ? `${item.key} is claimable but no worker profile is free; it starts when one frees` : `${item.key} is claimable and waiting for a worker`); } catch { /* not claimable: not actionable */ }
    if (pendingBaseRefresh(item)) add('refresh', item, `${item.key} conflicts with the moved base and is waiting for the control plane to try bringing its candidate onto it`);
    // No head is owed a proof the loop asks for: CI runs the unit tests, UAT the end-to-end ones,
    // and the control plane requests no producer (GY-1266, GY-1235). A mergeable candidate is not
    // the loop's either: GitHub merges it on its branch protection.
  }
  return subjects;
}

// ---- Latency the loop is judged on ---------------------------------------------------------
/*
 * Four budgets, all measured from what the loop itself observed cycle by cycle, so no figure can
 * disagree with the state the loop acted on: ready work reaching a worker, a first push arriving,
 * a mergeable candidate merging, and a standing verdict reaching a rework request.
 */
export const latencyTargets = {
  readyToClaimP90Ms: 120_000, readyToFirstPushP90Ms: 900_000,
  approvalToMergeP90Ms: 600_000, mergeableToMergeMs: 300_000, verdictToReworkMs: 300_000,
  minimumDeliveries: 10,
} as const;

/** Bring one item's clock in line with the snapshot, and return the delivery sample it completed. */
export function observeItemClock(state: DaemonState, work: Work, now: number): LatencySample | null {
  const at = new Date(now).toISOString();
  const time = (value: string | null | undefined) => { const parsed = value ? Date.parse(value) : Number.NaN; return Number.isFinite(parsed) ? parsed : null; };
  // A delivery is sampled once, from the clock the loop held while the item was open, and sampling
  // drops that clock. A delivered item with no clock is therefore history — delivered before this
  // loop watched it, or already sampled — and measuring it again would start its clocks at this
  // cycle and bury every real passage under a zero per delivered item per cycle.
  if (work.stage === 'done' && !state.clocks[work.id]) return null;
  const clock: ItemClock = state.clocks[work.id] ?? itemClockSchema.parse({ key: work.key, epoch: work.epoch });
  state.clocks[work.id] = clock;
  clock.key = work.key;
  const claimable = (() => { try { assertDispatchable(work, [work], at); return true; } catch { return !work.lease && work.ready && !work.blocker && (!work.submission || work.reworkRequested); } })();
  // A rework round is a fresh wait for a worker, so the claim, push and approval clocks start over
  // the moment the item becomes claimable again — and that moment is this cycle, not whenever the
  // stage last changed: a verdict or a conflict lands before the round it needs is approved, and
  // charging the worker for the decision in between would measure the wrong thing.
  if (claimable && (clock.claimedAt || clock.pushedAt || clock.epoch !== work.epoch)) Object.assign(clock, { readyAt: at, claimedAt: null, startedAt: null, pushedAt: null, approvedAt: null, mergeableAt: null });
  clock.epoch = work.epoch;
  // The first attempt's wait starts when the item was released, which may predate this loop.
  if (!clock.readyAt && claimable) clock.readyAt = new Date(time(work.stageEnteredAt) ?? now).toISOString();
  // Graphyard's own claim time, which outlives the lease: an attempt that claimed, pushed and
  // submitted between two cycles still measured its wait, because the assignment recorded it.
  const assignment = work.lastAssignment?.epoch === work.epoch ? work.lastAssignment : work.lease ? { claimedAt: undefined } : null;
  if (!clock.claimedAt && assignment) clock.claimedAt = new Date(time(assignment.claimedAt) ?? now).toISOString();
  // The session start the engine stamped at the epoch's first renewal (GY-1499); never guessed.
  const startedAt = work.lastAssignment?.epoch === work.epoch ? time(work.lastAssignment.startedAt) : null;
  if (!clock.startedAt && startedAt !== null) clock.startedAt = new Date(startedAt).toISOString();
  const readyMs = time(clock.readyAt);
  if (!clock.pushedAt && work.candidate) {
    // The provider's own creation time when it belongs to this attempt; otherwise the first cycle
    // that saw the head, which is the earliest this loop can honestly claim to have observed it.
    const observed = [work.candidate.createdAt, work.observation?.at].map(time).find(value => value !== null && (readyMs === null || value >= readyMs));
    clock.pushedAt = new Date(observed ?? now).toISOString();
  }
  // An approval is a review gate that passed. An item with no review gate was never approved, so
  // it measures no approval→merge passage rather than one that starts at its first push.
  if (!clock.approvedAt && work.submission && !work.reworkRequested && work.gates.find(gate => gate.name === 'review')?.passed === true && work.gates.find(gate => gate.name === 'build')?.passed) clock.approvedAt = at;
  if (!clock.mergeableAt && mergeableCandidate(work)) clock.mergeableAt = at;
  if (work.stage !== 'done') return null;
  const mergedAt = time(work.delivery?.mergedAtRepository ?? work.delivery?.mergedAt) ?? now;
  const since = (value: string | null) => { const start = time(value); return start === null ? null : Math.max(0, Math.round(mergedAt - start)); };
  const between = (from: string | null, to: string | null) => { const start = time(from), end = time(to); return start === null || end === null ? null : Math.max(0, Math.round(end - start)); };
  delete state.clocks[work.id];
  return latencySampleSchema.parse({ work: work.key, at: new Date(mergedAt).toISOString(),
    readyToClaimMs: between(clock.readyAt, clock.claimedAt), readyToPushMs: between(clock.readyAt, clock.pushedAt),
    claimToStartMs: between(clock.claimedAt, clock.startedAt), startToPushMs: between(clock.startedAt, clock.pushedAt),
    approvalToMergeMs: since(clock.approvedAt), mergeableToMergeMs: since(clock.mergeableAt) });
}

export interface LatencyBudget {
  target: typeof latencyTargets; deliveries: number;
  readyToClaim: ReturnType<typeof percentiles>; readyToFirstPush: ReturnType<typeof percentiles>;
  /** Ready→first push split at the session start: claim→start (launch) and start→first push (the agent's work). */
  launchOverhead: ReturnType<typeof percentiles>; working: ReturnType<typeof percentiles>;
  approvalToMerge: ReturnType<typeof percentiles>;
  mergeDwell: { count: number; worstMs: number; breaches: { work: string; ms: number }[] };
  reworkRequest: { count: number; worstMs: number; breaches: { work: string; ms: number }[] };
  met: boolean | null; reasons: string[];
}

/**
 * The four budgets over the samples the cursor holds. `met` is null while fewer than ten
 * deliveries are measured — the population the p90 targets are stated for — and the per-candidate
 * bounds (mergeable→merge, verdict→rework) are judged on every sample, however few.
 */
export function latencyBudget(samples: LatencySample[]): LatencyBudget {
  const value = (key: keyof LatencySample) => samples.map(sample => sample[key]).filter((entry): entry is number => typeof entry === 'number');
  const deliveries = samples.filter(sample => sample.mergeableToMergeMs !== null || sample.approvalToMergeMs !== null).length;
  const bound = (key: 'mergeableToMergeMs' | 'verdictToReworkMs', limit: number) => {
    const measured = samples.filter(sample => typeof sample[key] === 'number');
    return { count: measured.length, worstMs: measured.reduce((worst, sample) => Math.max(worst, sample[key] as number), 0),
      breaches: measured.filter(sample => (sample[key] as number) > limit).map(sample => ({ work: sample.work, ms: sample[key] as number })) };
  };
  const readyToClaim = percentiles(value('readyToClaimMs')), readyToFirstPush = percentiles(value('readyToPushMs')), approvalToMerge = percentiles(value('approvalToMergeMs'));
  const launchOverhead = percentiles(value('claimToStartMs')), working = percentiles(value('startToPushMs'));
  const mergeDwell = bound('mergeableToMergeMs', latencyTargets.mergeableToMergeMs), reworkRequest = bound('verdictToReworkMs', latencyTargets.verdictToReworkMs);
  const minutes = (ms: number) => `${Math.round(ms / 6000) / 10} min`;
  const reasons = [
    ...(readyToClaim.count && readyToClaim.p90Ms > latencyTargets.readyToClaimP90Ms ? [`ready→claim p90 ${minutes(readyToClaim.p90Ms)} exceeds ${minutes(latencyTargets.readyToClaimP90Ms)}`] : []),
    ...(readyToFirstPush.count && readyToFirstPush.p90Ms > latencyTargets.readyToFirstPushP90Ms ? [`ready→first push p90 ${minutes(readyToFirstPush.p90Ms)} exceeds ${minutes(latencyTargets.readyToFirstPushP90Ms)} (launch overhead p90 ${launchOverhead.count ? minutes(launchOverhead.p90Ms) : 'unmeasured'}, working p90 ${working.count ? minutes(working.p90Ms) : 'unmeasured'})`] : []),
    ...(approvalToMerge.count && approvalToMerge.p90Ms > latencyTargets.approvalToMergeP90Ms ? [`approval→merge p90 ${minutes(approvalToMerge.p90Ms)} exceeds ${minutes(latencyTargets.approvalToMergeP90Ms)}`] : []),
    ...mergeDwell.breaches.map(breach => `${breach.work} stayed mergeable for ${minutes(breach.ms)}, past the ${minutes(latencyTargets.mergeableToMergeMs)} bound`),
    ...reworkRequest.breaches.map(breach => `${breach.work} carried a standing verdict for ${minutes(breach.ms)} before rework was requested, past the ${minutes(latencyTargets.verdictToReworkMs)} bound`),
  ];
  const enough = deliveries >= latencyTargets.minimumDeliveries;
  return { target: latencyTargets, deliveries, readyToClaim, readyToFirstPush, launchOverhead, working, approvalToMerge, mergeDwell, reworkRequest,
    met: reasons.length ? false : enough ? true : null,
    reasons: reasons.length ? reasons : enough ? [] : [`${deliveries} deliver${deliveries === 1 ? 'y' : 'ies'} measured; the p90 targets are judged over at least ${latencyTargets.minimumDeliveries}`] };
}
