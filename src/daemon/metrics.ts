// Concern: measurement — stage percentiles, the scope-decision budget, actionable subjects and item latency.
import { type Work, currentEvidence } from '../model.js';
import { routableScopeRequest, scopeDecisionBinding, scopeDecisionSample, scopeDecisionBudgetMs, scopeBlockedBudgetMs, redecidableScopeRefusal, unplannedPaths } from '../model/scope.js';
import { askIdentity, plannedFilesCovered } from '../model/scope-collapse.js';
import { pendingBaseRefresh } from '../merge-queue.js';
import { standingCapacity } from '../model/capacity.js';
import { stalledItems } from '../model/action-account.js';
import { type MasterConfig, type ContainmentAssessment, assertDispatchable, containmentPhase } from '../master.js';
import { approvalWatchSchema, type ApprovalWatch, type DaemonActionKind, type DaemonState, type CycleMetrics, type ScopeMeasurement, carriedSession } from './state.js';
import { type ItemClock, itemClockSchema, type LatencySample, latencySampleSchema } from './latency-clock.js';
import { decisionKey, scopeOutcomeAnswered } from './reconcile.js';
import { docsSyncHolding } from '../model/docs-sync.js';
import { approvedUnapplied, boundDetail, mergeableCandidate, namePaths, routineDecision, withheldDecision } from './decisions.js';
import type { RoutineDecision } from './decisions.js';

// ---- GY-1702: standing/held requirements waits (marks feed scopeBudget; covering matches engine settle) ----
/** Sorted-set equality for plannedFiles (jsonb order is not kept). */
export const samePlannedFiles = (a: unknown, b: unknown) => {
  if (!Array.isArray(a) || !Array.isArray(b)) return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  if (a.length !== b.length) return false;
  const left = [...a].map(String).sort(), right = [...b].map(String).sort();
  return left.every((path, i) => path === right[i]);
};
/** Standing plannedFiles cover the ask's widening (superset or broader directory). */
export const coveringPlannedFiles = (standing: unknown, needed: unknown) =>
  !Array.isArray(standing) || !Array.isArray(needed) ? samePlannedFiles(standing, needed) : plannedFilesCovered(needed.map(String), standing.map(String));
export const heldWaitMarker = 'held: waiting for the attempt to end';
export const heldScopeAskId = (key: string, epoch: number, at: string) => `${key}:${epoch}:${at}`;
const heldScopeAskMarks = new WeakMap<object, Set<string>>();
export function markHeldScopeAsk(scopeMeasurements: object, key: string, epoch: number, at: string) {
  let set = heldScopeAskMarks.get(scopeMeasurements);
  if (!set) heldScopeAskMarks.set(scopeMeasurements, set = new Set());
  set.add(heldScopeAskId(key, epoch, at));
}
export function clearHeldScopeAsk(scopeMeasurements: object, key: string, epoch: number, at: string) {
  heldScopeAskMarks.get(scopeMeasurements)?.delete(heldScopeAskId(key, epoch, at));
}
export function syncHeldScopeAskMarks(scopeMeasurements: object, approvals: Iterable<{ work: string; action: string; settledAt?: string | null; scope?: { epoch: number; at: string } | null; ended?: string[]; coveringAdopt?: boolean }>) {
  const set = new Set<string>();
  for (const watch of approvals) {
    if (watch.action !== 'requirements' || watch.settledAt || !watch.scope) continue;
    if (!watch.coveringAdopt && !(watch.ended ?? []).some(entry => entry.includes(heldWaitMarker))) continue;
    set.add(heldScopeAskId(watch.work, watch.scope.epoch, watch.scope.at));
  }
  heldScopeAskMarks.set(scopeMeasurements, set);
}
export const isHeldScopeAsk = (scopeMeasurements: object, key: string, epoch: number, at: string) =>
  heldScopeAskMarks.get(scopeMeasurements)?.has(heldScopeAskId(key, epoch, at)) ?? false;
/**
 * GY-1702: quarantined routed asks whose held status could not be read this cycle. The budget must
 * not breach them until a successful history read determines whether a matching hold answers them;
 * a transient cold-start failure must not record escalation:scope-budget:blocked.
 */
const unknownHeldScopeAskMarks = new WeakMap<object, Set<string>>();
export const isUnknownHeldScopeAsk = (scopeMeasurements: object, key: string, epoch: number, at: string) =>
  unknownHeldScopeAskMarks.get(scopeMeasurements)?.has(heldScopeAskId(key, epoch, at)) ?? false;
/** Per-call deadline for cold-start history discovery (matches the decisions step's 10 s bound). */
const discoverHeldReadDeadlineMs = 10_000;
/**
 * GY-1702: before `scopeBudget`, mark a quarantined routed ask that a history-held requirements
 * decision already answers. On a cold start `state.approvals` is empty and the decisions step has
 * not run yet, so sync from watches alone would leave the ask unmarked and falsely breach. A read
 * that fails or misses the deadline marks the ask unknown so the budget preserves it until the
 * held status can be determined (each read is deadline-bounded; it does not hold the cycle).
 */
export async function discoverHeldScopeAskMarks(
  scopeMeasurements: object,
  items: readonly Work[],
  now: number,
  routes: boolean,
  readDecisions: ((item: Work) => Promise<{ decisions: Array<{ action: string; state: string; input?: { plannedFiles?: unknown } | null }> }>) | undefined,
): Promise<void> {
  if (!routes || !readDecisions) { unknownHeldScopeAskMarks.set(scopeMeasurements, new Set()); return; }
  const unknown = new Set<string>(), until = performance.now() + discoverHeldReadDeadlineMs;
  await Promise.all(items.map(async item => {
    const request = item.scopeRequest;
    if (!request || request.decision?.decidedBy !== 'graphyard' || !item.containmentQuarantine) return;
    if (!routableScopeRequest(item, now) || isHeldScopeAsk(scopeMeasurements, item.key, request.epoch, request.at)) return;
    const askId = heldScopeAskId(item.key, request.epoch, request.at);
    let history: Array<{ action: string; state: string; input?: { plannedFiles?: unknown } | null }>;
    try {
      const left = until - performance.now();
      if (left <= 0) { unknown.add(askId); return; }
      const made = readDecisions(item);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('discover held-scope history read deadline')), left); timer.unref?.(); });
      history = (await Promise.race([made, expired]).finally(() => clearTimeout(timer))).decisions;
    } catch { unknown.add(askId); return; }
    const held = history.find(entry => entry.action === 'requirements' && entry.state === 'held');
    if (!held || unplannedPaths((held.input?.plannedFiles as string[] | null) ?? [], request.paths).length) return;
    markHeldScopeAsk(scopeMeasurements, item.key, request.epoch, request.at);
  }));
  unknownHeldScopeAskMarks.set(scopeMeasurements, unknown);
}
type RequirementsAsk = { action: string; scope?: unknown; input?: { plannedFiles?: unknown } | null };
/** A covering standing/held requirements revision is the ask's pending answer (no-answers ok). */
export const standingRequirementsAnswersAsk = (standing: { input?: { plannedFiles?: unknown } | null }, decision: RequirementsAsk) =>
  decision.action === 'requirements' && !!decision.scope && coveringPlannedFiles(standing.input?.plannedFiles, decision.input?.plannedFiles);
export type HeldDecisionLike = { id: string; approvedAt?: string | null; approvedBy?: string | null; outcome?: string | null; input?: { plannedFiles?: unknown } | null };
export function heldWaitScope(held: HeldDecisionLike, decision: RequirementsAsk, candidate: NonNullable<ApprovalWatch['scope']> | null) {
  const scope = candidate && standingRequirementsAnswersAsk(held, { ...decision, scope: candidate }) ? candidate : null;
  return { scope, unmatched: !!candidate && !scope };
}
export function heldWaitDetail(itemKey: string, action: string, held: HeldDecisionLike, why: string, unmatched: boolean) {
  const hold = boundDetail(held.outcome ?? why, 300), by = held.approvedBy ?? 'its approver';
  return unmatched
    ? `${itemKey}'s ${action} decision ${held.id} is approved by ${by} and held (${hold}); it does not widen for this scope ask, so the ask waits until the hold settles and nothing is requested`
    : `${itemKey}'s ${action} decision ${held.id} is approved by ${by} and held (${hold}); the control plane applies it when the attempt ends, so nothing is requested`;
}
export const heldWaitWatch = (itemKey: string, action: string, held: HeldDecisionLike, requestedAt: string, scope: NonNullable<ApprovalWatch['scope']> | null) => ({
  work: itemKey, action, decision: held.id, requestedAt, settledAt: null as null,
  approvedAt: held.approvedAt ?? null, approvedBy: held.approvedBy ?? null, scope, ended: scope ? [heldWaitMarker] : [] as string[],
});
export const approvedResumePendingDetail = (itemKey: string, action: string, decisionId: string, approvedBy: string | null | undefined) =>
  `${itemKey}'s ${action} decision ${decisionId} was approved by ${approvedBy ?? 'its approver'} but the control plane could not apply it yet; the watch stays live and resume is tried again next cycle`;
export const heldDecisionRefusal = (error: unknown) =>
  / was approved by .+ and is held \(/.test(error instanceof Error ? error.message : String(error));
export function heldDecisionNamedIn(error: unknown): string | null {
  return /Decision ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) \([^)]+\) on \S+ was approved by .+ and is held \(/.exec(error instanceof Error ? error.message : String(error))?.[1] ?? null;
}
export const staleRevisionDecideRefusal = (error: unknown) =>
  /Policy revision changed(?: \(now \d+\))?; reload and request again/.test(error instanceof Error ? error.message : String(error));
export const staleRevisionDecideNote = 'the item moved past the revision the loop read';
export const staleRevisionDecideDetail = (detail: string) => detail.includes(staleRevisionDecideNote);


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

/** GY-1701/GY-1702. Live covering-adopt watch names this ask; bound skips only while that watch still stands (cleared when the revision fails). */
export function coveringStandingScopeWatch(item: Pick<Work, 'id' | 'policyRevision' | 'scopeRequest'>, approvals: Record<string, ApprovalWatch>): boolean {
  const request = item.scopeRequest;
  if (!request) return false;
  const watch = approvals[decisionKey(item as Work, { action: 'requirements', binding: scopeDecisionBinding(request) })];
  const identity = askIdentity(request);
  return !!watch?.coveringAdopt && !!watch.scope && watch.scope.at === identity.at && watch.scope.epoch === identity.epoch;
}
/** GY-1701. Standing no-`answers` revision already plans every path of a live scope ask. */
export function standingCoversScopeAsk(standing: { input?: { plannedFiles?: readonly string[] | null; answers?: unknown } | null }, askPaths: readonly string[]): boolean {
  return !standing.input?.answers && askPaths.length > 0 && unplannedPaths(standing.input?.plannedFiles ?? [], askPaths).length === 0;
}
/** GY-1701. Covering-adopt watch; stays unsettled (incl. held) so status keeps the decision until apply/refuse. */
export function coveringScopeAdoptWatch(item: Pick<Work, 'key' | 'scopeRequest'>,
  standing: { id: string; state: string; approvedAt?: string | null; approvedBy?: string | null; input?: { plannedFiles?: readonly string[] | null; answers?: unknown } | null },
  decision: Pick<RoutineDecision, 'action' | 'scope' | 'input'>, stamp: string): ApprovalWatch | null {
  const askPaths = decision.scope?.paths ?? item.scopeRequest?.paths ?? [];
  if (!(decision.input?.answers || decision.scope) || !standingCoversScopeAsk(standing, askPaths)) return null;
  return approvalWatchSchema.parse({ work: item.key, action: decision.action, decision: standing.id, requestedAt: stamp, coveringAdopt: true,
    settledAt: null, approvedAt: standing.approvedAt ?? null, approvedBy: standing.approvedBy ?? null, scope: decision.scope ?? null });
}
export const coveringRevisionGone = /^(refused|withdrawn|stale|failed|superseded)$/;
export function coveringAdoptLeftAskOpen(watch: Pick<ApprovalWatch, 'scope' | 'coveringAdopt'>, item: Work, judged: { state: string; approvedAt?: string | null; refusal?: { at?: string } | null }, clock: number): boolean {
  return !!watch.coveringAdopt && !!watch.scope && coveringRevisionGone.test(judged.state) && scopeOutcomeAnswered(item, watch.scope, judged, clock) !== 'answered';
}
/** GY-1702: drop a covering-adopt watch whose revision failed/vanished so the ask's wait and bound resume before any replacement request (incl. when that request defers or fails). */
export function clearCoveringAdoptIfGone(
  approvals: Record<string, ApprovalWatch>, scopeMeasurements: object, key: string,
  watch: Pick<ApprovalWatch, 'coveringAdopt' | 'scope'>, item: Work,
  judged: { state: string; approvedAt?: string | null; refusal?: { at?: string } | null } | null, clock: number,
): boolean {
  if (!watch.coveringAdopt || !watch.scope) return false;
  if (judged !== null && !coveringAdoptLeftAskOpen(watch, item, judged, clock)) return false;
  clearHeldScopeAsk(scopeMeasurements, item.key, watch.scope.epoch, watch.scope.at);
  delete approvals[key];
  return true;
}
/** GY-1702: live held watch (coveringAdopt when the revision covers the ask); caller marks the bound. */
export function heldAdoptWatch(
  item: Pick<Work, 'key' | 'scopeRequest'>, held: HeldDecisionLike, decision: Pick<RoutineDecision, 'action' | 'scope' | 'input'>,
  carried: ApprovalWatch | null, stamp: string,
): { watch: ApprovalWatch; bound: NonNullable<ApprovalWatch['scope']> | null; unmatched: boolean; clearPrevious: { epoch: number; at: string } | null } {
  const cover = decision.scope
    ? coveringScopeAdoptWatch(item, { id: held.id, state: 'held', approvedAt: held.approvedAt, approvedBy: held.approvedBy, input: held.input as { plannedFiles?: readonly string[] | null; answers?: unknown } | null }, decision, carried?.requestedAt ?? stamp)
    : null;
  const candidate = decision.scope ?? carried?.scope ?? null, { scope, unmatched } = heldWaitScope(held, decision, candidate);
  const clearPrevious = carried?.scope && scope && (carried.scope.at !== scope.at || carried.scope.epoch !== scope.epoch)
    ? { epoch: carried.scope.epoch, at: carried.scope.at } : null;
  const bound = scope ?? cover?.scope ?? null;
  const base = cover
    ? approvalWatchSchema.parse({ ...cover, ended: bound ? [heldWaitMarker] : cover.ended })
    : approvalWatchSchema.parse(heldWaitWatch(item.key, decision.action, held, carried?.requestedAt ?? stamp, scope));
  // Keep the carried registry session (and closeAttempts) until close succeeds — approver concurrency is one.
  const kept = carried ? { ...carriedSession(carried), closeAttempts: carried.closeAttempts } : {};
  return { watch: approvalWatchSchema.parse({ ...base, ...kept, settledAt: null }), bound, unmatched, clearPrevious };
}
/** GY-1702: bind a race-discovered matching ask onto a live held watch; returns the wait detail and whether to mark the bound. */
export function bindHeldSupervisedAsk(watch: ApprovalWatch, judged: HeldDecisionLike & { outcome?: string | null }, decision: Pick<RoutineDecision, 'action' | 'scope' | 'input'>, item: Pick<Work, 'key' | 'scopeRequest'>): { detail: string; mark: boolean } {
  Object.assign(watch, { approvedAt: judged.approvedAt ?? null, approvedBy: judged.approvedBy ?? null });
  if (!watch.scope && decision.scope && standingRequirementsAnswersAsk(judged, decision)) {
    const cover = coveringScopeAdoptWatch(item, { id: judged.id, state: 'held', approvedAt: judged.approvedAt, approvedBy: judged.approvedBy, input: judged.input as { plannedFiles?: readonly string[] | null; answers?: unknown } | null }, decision, watch.requestedAt);
    if (cover) Object.assign(watch, cover); else watch.scope = decision.scope;
  }
  return { detail: heldWaitDetail(item.key, decision.action, { id: watch.decision, approvedBy: judged.approvedBy, outcome: judged.outcome }, 'the item holds a live attempt', !watch.scope && !!decision.scope), mark: !!watch.scope };
}

/**
 * How the loop is keeping the promise a scope request rests on: request-to-decision percentiles
 * over the decisions it has taken, every request still undecided with how long it has waited, and
 * the breaches of the two bounds — p90 within five minutes once ten requests have been decided,
 * and nothing left undecided for longer than fifteen. A breach means workers are waiting on the
 * loop, so it is escalated with the numbers rather than left in the metrics.
 *
 * `approvals` (GY-1701/GY-1702): a live covering-adopt watch excludes the ask from the blocked bound;
 * once that revision fails the watch is cleared so the recorded wait and escalation resume.
 */
export function scopeBudget(work: Work[], decisions: ScopeMeasurement[], now: number, routes = false, approvals?: Record<string, ApprovalWatch>) {
  const measured = percentiles(decisions.map(entry => entry.waitedMs));
  // A rule refusal the loop puts to the approver (`routes`, GY-176) is not the worker's answer: the
  // request stays open, and its wait counts, until the approver approves or refuses it.
  const open = work.flatMap(item => {
    const request = item.scopeRequest;
    // GY-1701: a covering-adopt watch excludes the ask from the blocked bound entirely.
    if (!request || (approvals && coveringStandingScopeWatch(item, approvals))) return [];
    const routed = routes && request.decision?.decidedBy === 'graphyard' && !!routableScopeRequest(item, now);
    // GY-1702: pause when a held decision answers this ask, or its history is still unknown this cycle.
    const heldByQuarantine = routed && !!item.containmentQuarantine
      && (isHeldScopeAsk(decisions, item.key, request.epoch, request.at) || isUnknownHeldScopeAsk(decisions, item.key, request.epoch, request.at));
    return !request.decision || routed ? [{ key: item.key, epoch: request.epoch, waitedMs: Math.max(0, now - Date.parse(request.at)), routed, heldByQuarantine }] : [];
  }).sort((a, b) => b.waitedMs - a.waitedMs);
  // One id per breach, not per wording: the numbers in the detail move every cycle, and an
  // escalation that changed key each time would read as a new incident every twenty seconds.
  const breaches = [
    ...(measured.count >= scopeDecisionSample && measured.p90Ms > scopeDecisionBudgetMs
      ? [{ id: 'p90', detail: `Scope decisions are too slow: p90 is ${Math.round(measured.p90Ms / 1000)}s over the last ${measured.count} requests, above the ${scopeDecisionBudgetMs / 60_000}-minute budget` }] : []),
    ...open.filter(entry => entry.waitedMs > scopeBlockedBudgetMs && !entry.heldByQuarantine)
      .map(entry => ({ id: `blocked:${entry.key}:${entry.epoch}`,
        detail: `${entry.key} has been blocked on its scope request for ${Math.round(entry.waitedMs / 60_000)} minutes, above the ${scopeBlockedBudgetMs / 60_000}-minute bound; ${entry.routed
          ? `its requirements decision is with the independent approver: read it with graphyard master decisions ${entry.key}` : `decide it with graphyard master scope ${entry.key} REASON`}` })),
  ];
  return { ...measured, open, longestOpenMs: open[0]?.waitedMs ?? 0, breaches, withinBudget: !breaches.length };
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
/**
 * GY-1298. The wording of a decision its approver judged but nobody applied: the wait is the apply the
 * loop owes, not an approver's judgement.
 */
export const approvedUnappliedWording = 'is approved but unapplied: approved at';
/**
 * When the watch's decision was approved with no outcome recorded, as the loop last found it once the named session ended (GY-1300),
 * or null. The apply step keeps that finding on the watch; a re-request's new decision carries the entry under the old id, never its own.
 */
export function approvedUnappliedSince(watch: Pick<ApprovalWatch, 'decision' | 'ended'>): string | null {
  const entry = watch.ended.findLast(line => line.includes(`decision ${watch.decision} on `) && line.includes(approvedUnapplied));
  return entry ? entry.slice(entry.indexOf(approvedUnapplied) + approvedUnapplied.length).trim().split(' ')[0] || null : null;
}
export interface ActionableSubject { key: string; kind: DaemonActionKind; work: string | null; detail: string }
export function actionableSubjects(config: Pick<MasterConfig, 'autoMerge' | 'run'>, work: Work[], now: number,
  context: { assessments?: Record<string, ContainmentAssessment>; approvals?: DaemonState['approvals']; baseFailed?: Map<string, Set<string>>; docsSyncs?: DaemonState['docsSyncs'];
    /** GY-1890: the dispatch step stopped on a saturated fleet — no launch profile free by its own `saturatedFleet` decision — so a claimable item's wait is the fleet's slot capacity, not a dispatch wait. */ fleetHeld?: boolean;
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
    // A routine decision is the one subject a delivered item can still raise: containment recovery.
    // It stays a subject until it is applied. A decision sitting with an approver is the pipeline
    // waiting on its own agent, and counting that as nothing to act on is how a dead approver used
    // to make an item disappear from the one measure built to notice it.
    const decision = routineDecision(item, config, now, context.assessments?.[item.id], context.baseFailed?.get(item.id));
    const watch = decision ? context.approvals?.[decisionKey(item, decision)] : undefined;
    // A decision waiting for an approver account to reset is the one capacity line, not a stall per item (GY-182).
    // An approved decision whose application was lost is named for what it is (GY-1300), never as waiting for its approver.
    const unapplied = watch ? approvedUnappliedSince(watch) : null;
    // A conflict rework a docs-sync session holds inside its bound is the step's recorded wait, not a stall (GY-1436).
    const docsHeld = decision?.action === 'rework' && !watch && decision.binding === `${item.candidate?.sha}:conflict` && !!context.docsSyncs && !!docsSyncHolding(context.docsSyncs, item, now);
    if (decision && !docsHeld && !watch?.settledAt && !(watch && standingCapacity(item, 'approver').length)) add('decision', item, !watch ? `${item.key} needs a ${decision.action} decision requested and approved`
      : unapplied ? `${item.key}'s ${decision.action} decision ${watch.decision} is ${approvedUnapplied} ${unapplied}; the loop asks the control plane to apply it`
      : watch.approvedAt ? `${item.key}'s ${decision.action} decision ${watch.decision} ${approvedUnappliedWording} ${watch.approvedAt}${watch.approvedBy ? ` by ${watch.approvedBy}` : ''}; the loop applies it (graphyard master decisions ${item.key})`
      : watch.exhaustedAt ? `${item.key}'s ${decision.action} decision ${watch.decision} is unjudged after ${watch.launches} approver session(s)`
        : `${item.key}'s ${decision.action} decision ${watch.decision} is requested and waiting for approver session ${watch.agentName ?? '(not launched)'} to judge it`);
    const withheld = decision ? null : withheldDecision(item, config, now, context.assessments?.[item.id]);
    if (withheld) add('decision', item, withheld.reason.slice(0, 500));
    if (item.stage === 'done') continue;
    const stall = stalled.get(item.key);
    if (stall) add('escalation', item, `${item.key} holds its ${stall.gate ?? 'unevaluated'} gate with no action, no dependency and no recorded human need: ${stall.refusal ?? stall.detail}`);
    // GY-1890: with no launch profile free the wait on a claimable item is the fleet's slot
    // capacity, so it is a capacity subject, not a dispatch one: the loop cannot end it by acting.
    // An item whose own launch is in flight already holds its slot: it waits on that launch, not the fleet.
    try { assertDispatchable(item, work, new Date(now).toISOString()); const fleetHeld = context.fleetHeld && !context.launching?.(item); add(fleetHeld ? 'capacity' : 'dispatch', item, fleetHeld ? `${item.key} is claimable but no worker profile is free; it starts when one frees` : `${item.key} is claimable and waiting for a worker`); } catch { /* not claimable: not actionable */ }
    const request = item.scopeRequest;
    if (request && (!request.decision || redecidableScopeRefusal(item)) && item.lease && item.lease.epoch === request.epoch && Date.parse(item.lease.expiresAt) > now)
      add('scope', item, boundDetail(`${item.key}: ${request.requestedBy} is waiting for a decision on ${namePaths(request.paths, 300)}`, 500));
    // A lapsed quarantine is the loop's to settle only where this host verified its supervisor gone
    // (GY-426). One it cannot verify — another host's, or a supervisor still holding its scope — is
    // escalated with its refusals and counted under the containment class, a wait no cycle could
    // end (GY-393).
    if (item.containmentQuarantine && containmentPhase(item, now)?.state === 'lapsed' && (!context.assessments || context.assessments[item.id]?.settleable))
      add('settle', item, `${item.key} holds a lapsed containment quarantine from epoch ${item.containmentQuarantine.epoch}`);
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
/** Retired (GY-1980): the progress watchdog replaced the silence record, so this reports nothing; it stands only while src/daemon/doctor.ts still calls it. */
export const silenceReport = (_retired: unknown, _now: number): null => null;

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
