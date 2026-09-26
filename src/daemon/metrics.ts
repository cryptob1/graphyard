// Concern: measurement — stage percentiles, the scope-decision budget, silence and item latency.
import { type Work, productionLatencyMs, postDeployMs, deliveryState, currentEvidence, deploySmokeRequired } from '../model.js';
import { routableScopeRequest, scopeDecisionSample, scopeDecisionBudgetMs, scopeBlockedBudgetMs, redecidableScopeRefusal } from '../model/scope.js';
import { pendingBaseRefresh } from '../merge-queue.js';
import { standingCapacity } from '../model/capacity.js';
import { stalledItems } from '../model/action-account.js';
import { type MasterConfig, type ContainmentAssessment, assertDispatchable, containmentPhase } from '../master.js';
import { type DaemonAction, type DaemonActionKind, type DaemonState, type CycleMetrics, type ItemClock, itemClockSchema, type LatencySample, latencySampleSchema, type ScopeMeasurement } from './state.js';
import { decisionKey } from './reconcile.js';
import { boundDetail, mergeableCandidate, namePaths, routineDecision, standingVerdict, withheldDecision } from './decisions.js';

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
 * How the loop is keeping the promise a scope request rests on: request-to-decision percentiles
 * over the decisions it has taken, every request still undecided with how long it has waited, and
 * the breaches of the two bounds — p90 within five minutes once ten requests have been decided,
 * and nothing left undecided for longer than fifteen. A breach means workers are waiting on the
 * loop, so it is escalated with the numbers rather than left in the metrics.
 */
export function scopeBudget(work: Work[], decisions: ScopeMeasurement[], now: number, routes = false) {
  const measured = percentiles(decisions.map(entry => entry.waitedMs));
  // A rule refusal the loop puts to the approver (`routes`, GY-176) is not the worker's answer: the
  // request stays open, and its wait counts, until the approver approves or refuses it.
  const open = work.flatMap(item => {
    const request = item.scopeRequest;
    const routed = routes && request?.decision?.decidedBy === 'graphyard' && !!routableScopeRequest(item, now);
    return request && (!request.decision || routed) ? [{ key: item.key, epoch: request.epoch, waitedMs: Math.max(0, now - Date.parse(request.at)), routed }] : [];
  }).sort((a, b) => b.waitedMs - a.waitedMs);
  // One id per breach, not per wording: the numbers in the detail move every cycle, and an
  // escalation that changed key each time would read as a new incident every twenty seconds.
  const breaches = [
    ...(measured.count >= scopeDecisionSample && measured.p90Ms > scopeDecisionBudgetMs
      ? [{ id: 'p90', detail: `Scope decisions are too slow: p90 is ${Math.round(measured.p90Ms / 1000)}s over the last ${measured.count} requests, above the ${scopeDecisionBudgetMs / 60_000}-minute budget` }] : []),
    ...open.filter(entry => entry.waitedMs > scopeBlockedBudgetMs)
      .map(entry => ({ id: `blocked:${entry.key}:${entry.epoch}`,
        detail: `${entry.key} has been blocked on its scope request for ${Math.round(entry.waitedMs / 60_000)} minutes, above the ${scopeBlockedBudgetMs / 60_000}-minute bound; ${entry.routed
          ? `its requirements decision is with the independent approver: read it with graphyard master decisions ${entry.key}` : `decide it with graphyard master scope ${entry.key} REASON`}` })),
  ];
  return { ...measured, open, longestOpenMs: open[0]?.waitedMs ?? 0, breaches, withinBudget: !breaches.length };
}

/**
 * Stage dwell for work still in flight, delivered lead time, and the post-deploy flow: time to the
 * observed deployment and time from merge to the smoke verdict, with failures counted. All of it
 * comes from the snapshot the cycle already read, so the measurement cannot disagree with the
 * state the cycle acted on.
 */
export function stageMetrics(work: Work[], now: number) {
  const stages: Record<string, ReturnType<typeof percentiles>> = {};
  const open = work.filter(item => item.stage !== 'done');
  for (const stage of [...new Set(open.map(item => item.stage))].sort()) {
    stages[stage] = percentiles(open.filter(item => item.stage === stage).map(item => now - Date.parse(item.stageEnteredAt)).filter(Number.isFinite));
  }
  const delivered = work.filter(item => item.stage === 'done' && item.delivery);
  const lead = percentiles(delivered.map(item => Date.parse(item.delivery!.mergedAt) - Date.parse(item.createdAt)).filter(value => Number.isFinite(value) && value >= 0));
  const production = percentiles(delivered.map(item => productionLatencyMs(item)).filter((value): value is number => value !== null));
  const postDeploy = percentiles(delivered.map(item => postDeployMs(item, now)).filter((value): value is number => value !== null));
  const postDeployFailures = delivered.filter(item => deliveryState(item) === 'delivered-with-failure').length;
  return { stages, lead, production, postDeploy, postDeployFailures };
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
 * therefore records both halves: the subjects it could act on, and the actions it took. A subject
 * the cycle acts on has its clock reset; one that goes without any action accumulates, and the
 * longest such wait is what `master status` reports and what the 20-minute bound is judged on.
 */
export const silenceBudgetMs = 1_200_000;
export interface ActionableSubject { key: string; kind: DaemonActionKind; work: string | null; detail: string }
export function actionableSubjects(config: Pick<MasterConfig, 'autoMerge' | 'run'>, work: Work[], now: number,
  context: { assessments?: Record<string, ContainmentAssessment>; approvals?: DaemonState['approvals']; baseFailed?: Map<string, Set<string>> } = {}): ActionableSubject[] {
  const subjects: ActionableSubject[] = [];
  // The silence record keeps each detail to 500 characters; a refusal or proof list quoted here is cut to fit.
  const add = (kind: DaemonActionKind, item: Work | null, detail: string) => subjects.push({ key: `${kind}:${item?.key ?? 'pipeline'}`, kind, work: item?.key ?? null, detail: boundDetail(detail, 500) });
  // An open item the control plane names no action for and nothing is moving. The loop cannot
  // clear it — that is what makes it a subject rather than an action: counted here, its wait
  // accumulates against the silence bound instead of being absent from every measure the loop
  // keeps, which is how an item used to hold a failing gate for hours with nobody told (GY-106).
  const stalled = new Map(stalledItems(work, new Date(now), 0).map(entry => [entry.key, entry]));
  for (const item of work) {
    // A routine decision is the one subject a delivered item can still raise: containment recovery.
    // It stays a subject until it is applied. A decision sitting with an approver is the pipeline
    // waiting on its own agent, and counting that as nothing to act on is how a dead approver used
    // to make an item disappear from the one measure built to notice it.
    const decision = routineDecision(item, config, now, context.assessments?.[item.id], context.baseFailed?.get(item.id));
    const watch = decision ? context.approvals?.[decisionKey(item, decision)] : undefined;
    // A decision waiting for an approver account to reset is the one capacity line, not a stall per item (GY-182).
    if (decision && !watch?.settledAt && !(watch && standingCapacity(item, 'approver').length)) add('decision', item, !watch ? `${item.key} needs a ${decision.action} decision requested and approved`
      : watch.exhaustedAt ? `${item.key}'s ${decision.action} decision ${watch.decision} is unjudged after ${watch.launches} approver session(s)`
        : `${item.key}'s ${decision.action} decision ${watch.decision} is requested and waiting for approver session ${watch.agentName ?? '(not launched)'} to judge it`);
    const withheld = decision ? null : withheldDecision(item, config, now, context.assessments?.[item.id]);
    if (withheld) add('decision', item, withheld.reason.slice(0, 500));
    if (item.stage === 'done') continue;
    const stall = stalled.get(item.key);
    if (stall) add('escalation', item, `${item.key} holds its ${stall.gate ?? 'unevaluated'} gate with no action, no dependency and no recorded human need: ${stall.refusal ?? stall.detail}`);
    try { assertDispatchable(item, work, new Date(now).toISOString()); add('dispatch', item, `${item.key} is claimable and waiting for a worker`); } catch { /* not claimable: not actionable */ }
    const request = item.scopeRequest;
    if (request && (!request.decision || redecidableScopeRefusal(item)) && item.lease && item.lease.epoch === request.epoch && Date.parse(item.lease.expiresAt) > now)
      add('scope', item, boundDetail(`${item.key}: ${request.requestedBy} is waiting for a decision on ${namePaths(request.paths, 300)}`, 500));
    if (item.containmentQuarantine && containmentPhase(item, now)?.state === 'lapsed') add('settle', item, `${item.key} holds a lapsed containment quarantine from epoch ${item.containmentQuarantine.epoch}`);
    if (config.autoMerge && mergeableCandidate(item)) add('merge', item, `${item.key} is mergeable: every gate passes for ${item.candidate!.sha.slice(0, 12)}`);
    if (pendingBaseRefresh(item)) add('refresh', item, `${item.key} conflicts with the moved base and is waiting for the control plane to try bringing its candidate onto it`);
    // The same heads step 5 shepherds: one a verdict stands against is going back to a worker,
    // so nothing asks for its proofs and nothing is waiting on them.
    if (item.submission && item.candidate && !item.reworkRequested && !standingVerdict(item) && config.run.proofWorkflow) {
      const outstanding = missingProofs(item, new Date(now)).filter(proof => !proof.startsWith('manual:'));
      if (outstanding.length) add('proof', item, `${item.key} is missing trusted evidence for ${outstanding.join(', ')}`);
    }
  }
  for (const item of work.filter(entry => entry.stage === 'done' && entry.delivery && deploySmokeRequired(entry.policy))) {
    const outcome = deliveryState(item);
    if (!item.delivery!.deployment) add('deployment', item, `${item.key} is merged and waiting for the deployment that serves it to be observed`);
    else if (outcome === 'awaiting-smoke') add('smoke', item, `${item.key} is deployed at ${item.delivery!.deployment.sha.slice(0, 12)} and waiting for its smoke proof`);
  }
  return subjects;
}

export interface SilenceEntry { key: string; kind: string; work: string | null; detail: string; since: string; idleMs: number }
export interface SilenceReport { actionable: number; longestIdleMs: number; longest: SilenceEntry | null; budgetMs: number; breached: boolean; lastActionAt: string | null; subjects: SilenceEntry[] }
/** Fold this cycle's actionable inventory and its actions into the silence record. */
export function trackSilence(state: DaemonState, subjects: ActionableSubject[], performed: DaemonAction[], now: number): SilenceReport {
  const record = state.silence, at = new Date(now).toISOString();
  // Only an action that succeeded is the loop acting on a subject. A request refused every time it
  // is retried — a revoked credential, a standing 409 — moves nothing, and a wait that restarted
  // on each refusal would never reach the bound that puts it in front of someone.
  const acted = new Set(performed.filter(action => action.state === 'done').map(action => `${action.kind}:${action.work ?? 'pipeline'}`));
  const live = new Map(subjects.map(subject => [subject.key, subject]));
  for (const key of Object.keys(record.subjects)) if (!live.has(key)) delete record.subjects[key];
  for (const [key, subject] of live) {
    const previous = record.subjects[key];
    // First sight, or an action for this exact subject: the wait starts again from now.
    if (!previous || acted.has(key)) record.subjects[key] = { since: at, work: subject.work, kind: subject.kind, detail: subject.detail };
    else record.subjects[key] = { ...previous, detail: subject.detail };
  }
  if (performed.length) record.lastActionAt = at;
  return silenceReport(record, now);
}
export function silenceReport(record: DaemonState['silence'], now: number): SilenceReport {
  const subjects: SilenceEntry[] = Object.entries(record.subjects)
    .map(([key, entry]) => ({ key, kind: entry.kind, work: entry.work, detail: entry.detail, since: entry.since, idleMs: Math.max(0, now - Date.parse(entry.since)) }))
    .sort((a, b) => b.idleMs - a.idleMs);
  const longestIdleMs = subjects[0]?.idleMs ?? 0;
  return { actionable: subjects.length, longestIdleMs, longest: subjects[0] ?? null, budgetMs: silenceBudgetMs, breached: longestIdleMs > silenceBudgetMs, lastActionAt: record.lastActionAt, subjects: subjects.slice(0, 20) };
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
  if (claimable && (clock.claimedAt || clock.pushedAt || clock.epoch !== work.epoch)) Object.assign(clock, { readyAt: at, claimedAt: null, pushedAt: null, approvedAt: null, mergeableAt: null });
  clock.epoch = work.epoch;
  // The first attempt's wait starts when the item was released, which may predate this loop.
  if (!clock.readyAt && claimable) clock.readyAt = new Date(time(work.stageEnteredAt) ?? now).toISOString();
  // Graphyard's own claim time, which outlives the lease: an attempt that claimed, pushed and
  // submitted between two cycles still measured its wait, because the assignment recorded it.
  const assignment = work.lastAssignment?.epoch === work.epoch ? work.lastAssignment : work.lease ? { claimedAt: undefined } : null;
  if (!clock.claimedAt && assignment) clock.claimedAt = new Date(time(assignment.claimedAt) ?? now).toISOString();
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
  delete state.clocks[work.id];
  return latencySampleSchema.parse({ work: work.key, at: new Date(mergedAt).toISOString(),
    readyToClaimMs: clock.readyAt && clock.claimedAt ? Math.max(0, Math.round(Date.parse(clock.claimedAt) - Date.parse(clock.readyAt))) : null,
    readyToPushMs: clock.readyAt && clock.pushedAt ? Math.max(0, Math.round(Date.parse(clock.pushedAt) - Date.parse(clock.readyAt))) : null,
    approvalToMergeMs: since(clock.approvedAt), mergeableToMergeMs: since(clock.mergeableAt) });
}

export interface LatencyBudget {
  target: typeof latencyTargets; deliveries: number;
  readyToClaim: ReturnType<typeof percentiles>; readyToFirstPush: ReturnType<typeof percentiles>; approvalToMerge: ReturnType<typeof percentiles>;
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
  const mergeDwell = bound('mergeableToMergeMs', latencyTargets.mergeableToMergeMs), reworkRequest = bound('verdictToReworkMs', latencyTargets.verdictToReworkMs);
  const minutes = (ms: number) => `${Math.round(ms / 6000) / 10} min`;
  const reasons = [
    ...(readyToClaim.count && readyToClaim.p90Ms > latencyTargets.readyToClaimP90Ms ? [`ready→claim p90 ${minutes(readyToClaim.p90Ms)} exceeds ${minutes(latencyTargets.readyToClaimP90Ms)}`] : []),
    ...(readyToFirstPush.count && readyToFirstPush.p90Ms > latencyTargets.readyToFirstPushP90Ms ? [`ready→first push p90 ${minutes(readyToFirstPush.p90Ms)} exceeds ${minutes(latencyTargets.readyToFirstPushP90Ms)}`] : []),
    ...(approvalToMerge.count && approvalToMerge.p90Ms > latencyTargets.approvalToMergeP90Ms ? [`approval→merge p90 ${minutes(approvalToMerge.p90Ms)} exceeds ${minutes(latencyTargets.approvalToMergeP90Ms)}`] : []),
    ...mergeDwell.breaches.map(breach => `${breach.work} stayed mergeable for ${minutes(breach.ms)}, past the ${minutes(latencyTargets.mergeableToMergeMs)} bound`),
    ...reworkRequest.breaches.map(breach => `${breach.work} carried a standing verdict for ${minutes(breach.ms)} before rework was requested, past the ${minutes(latencyTargets.verdictToReworkMs)} bound`),
  ];
  const enough = deliveries >= latencyTargets.minimumDeliveries;
  return { target: latencyTargets, deliveries, readyToClaim, readyToFirstPush, approvalToMerge, mergeDwell, reworkRequest,
    met: reasons.length ? false : enough ? true : null,
    reasons: reasons.length ? reasons : enough ? [] : [`${deliveries} deliver${deliveries === 1 ? 'y' : 'ies'} measured; the p90 targets are judged over at least ${latencyTargets.minimumDeliveries}`] };
}
