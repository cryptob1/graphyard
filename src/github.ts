import { ReconciliationRetry, Refusal, SpeculativeConflict, requireCurrent } from './model.js';
import { createHash, createSign, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { observeCodex } from './codex-review.js';
import { observeAgentReview } from './agent-review.js';
import { readFile } from 'node:fs/promises';
import type { Engine } from './engine.js';
import { behindBaseHold, mechanicalHold } from './model/dispatch.js';
import { CHECK_NAME, carriedApproval, demand, nativeReviewRequired, parseReviewerApps, reviewerProfileFor, reviewProviderOf, type Observation, type ReviewerApp, type ReviewerProfile, type ScopeFile, type TipMerge, type Work, type ReviewRequest } from './model.js';
import { inPlannedScope } from './regression-guard.js';
import type { GitHubCacheStore } from './github-cache.js';
import { nextAction } from './model/next-action.js';
import { foldDecisions } from './model/approval.js';
import { normalMergeState, repairAudit, repairAuditEvent, repairLaneVerdict, type RepairAudit, type RepairLaneVerdict } from './master/repair-lane.js';
import { currentOptimisticMerge, describeGuard, mainGuard, postMergeVerdict, retestAfterRevert, revertRefusal, verdictCommit, type GuardState, type OptimisticMerge, type OptimisticRevert } from './optimistic-merge.js';
export { CHECK_NAME };
import { alreadyMergeableRefusal, approvalOfHead, baseRefreshNeeded, dismissedVerdict, enqueueRequestCurrent, mergeableNow, ejectedTipRestore, heldBase, mergeAuthorized, mergeBaseDismissalPattern, mergeQueueAction, ownHeads, pendingRestore, predictQueue, queuePlacement, queueRef, mergeCheckBranch, treeIdenticalPrediction, type GitHubMergeQueueState, type HeadForcePush, type MergeEnqueueRequest, type MergeQueueAction, type BaseRefresh, type BranchRestore, type CarriedCandidate, type ForeignCandidate, type LandingCheck, type ObservedApproval, type QueuePlacement, type QueueSpeculation, type RevertedDelivery, type ReviewDismissal, type ReviewThread } from './merge-queue.js';
import { blockedFeatures, controlPlanePermissions, describeShortfall, permissionShortfalls, requiredPermissions, type PermissionFeature, type PermissionLevel, type PermissionShortfall } from './github-permissions.js';
import { agentOwner, type AttentionItem } from './master/attention.js';
import type { IntegrationJob } from './coordination.js';

/** Out-of-scope paths compared against the base tip per observation; the rest are refused as uncompared. */
export const scopeLookupBudget = 200;
/**
 * GitHub's compare endpoint reports changed files on its first page only and stops at this many,
 * so a list this long may be truncated: it is treated as incomplete and nothing is carried.
 */
export const compareFileCap = 300;
/** Re-requests of a pull request GitHub answered with `mergeable: null`, `mergeabilityRetryMs` apart: at most 10 seconds (GY-548). */
export const mergeabilityRetries = 3, mergeabilityRetryIntervalMs = 3_000;
/** One file of a GitHub compare, as far as a patch-id reads it. */
export interface CompareFile { filename?: unknown; previous_filename?: unknown; status?: unknown; patch?: unknown; changes?: unknown; sha?: unknown }
/**
 * The patch-id of a change as GitHub's compare lists it (GY-330): a hash of every file's path,
 * rename source, status and textual patch, with hunk line numbers removed as `git patch-id`
 * removes them. Unlike `git patch-id`, whitespace inside a line counts: a change to indentation
 * (YAML, Python, Makefiles) or to a string literal is a different change; only a line ending's
 * carriage return and trailing whitespace are ignored. The same change applied to a base that
 * moved elsewhere — even in another hunk of the same file — has the same patch-id; any edit to the
 * change itself gives another.
 * A file GitHub gives no textual patch for (binary, or too large) is compared by the blob it
 * leaves (GY-384): the same path, status and resulting blob SHA is the same change to that file.
 * That is stricter than a patch — a base that edited another part of an oversized file changes
 * its blob — but never looser, and a binary file the base also changed conflicts, which is never
 * carried. Null when the list is not the whole change: truncated at compareFileCap (the files past
 * the cap are unknown, so no partial comparison can show them unchanged), or a patchless file with
 * no blob SHA, apart from a pure rename, which has nothing to give.
 */
export function patchId(files: CompareFile[] | null | undefined): string | null {
  if (!Array.isArray(files) || files.length >= compareFileCap) return null;
  const parts: string[] = [];
  for (const file of files) {
    if (typeof file?.filename !== 'string') return null;
    const renamed = file.status === 'renamed' && (file.changes ?? 0) === 0;
    const blob = typeof file.sha === 'string' && /^[0-9a-f]{40,64}$/.test(file.sha) ? file.sha : null;
    if (typeof file.patch !== 'string' && !renamed && !blob) return null;
    const body = typeof file.patch === 'string' ? file.patch.split('\n').map(line => line.startsWith('@@') ? '@@' : line.replace(/\s+$/, '')).join('\n') : blob ? `\u0002blob ${blob}` : '';
    parts.push(`${typeof file.previous_filename === 'string' ? file.previous_filename : file.filename}\u0000${file.filename}\u0000${String(file.status ?? '')}\u0000${body}`);
  }
  return createHash('sha1').update(parts.sort().join('\u0001')).digest('hex');
}
const reviewThreadsQuery = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id isResolved isOutdated path line originalLine comments(first: 1) { nodes { author { login __typename } url } } }
  } } }
}`;
/**
 * The App's request budget, and what Graphyard is allowed to spend it on.
 *
 * GitHub gives an installation a fixed number of requests an hour and reports what is left of it
 * on every response. Observation used to ignore that entirely: every open candidate was observed
 * again twenty seconds after its last observation, whatever state it was in, and one observation
 * costs on the order of ten requests. Twenty candidates spent the hour in about forty minutes, and
 * the remaining twenty were a blackout in which every gate read stale — including the merge gate of
 * a candidate that had nothing left to prove.
 *
 * So the budget is read from every response and three rules spend it:
 *
 * - **Cadence by state** (`observationBand`). What an observation can change decides how often one
 *   is made. A candidate at the merge gate is observed every 20 seconds, because its freshness is
 *   exactly what the merge executor spends. A candidate whose next action is a dispatch, a rework
 *   or an escalation is observed every five minutes, because nothing on GitHub can move it.
 *   Everything else sits between, and a candidate that came back unchanged settles to the
 *   steady-state interval: two minutes at least, stretched so the whole fleet's steady-state
 *   polling stays inside `steadyStateShare` of the hourly limit (`steadyStateInterval`).
 * - **The merge-path reserve** (`reserveDecision`). Below `mergePathReserve` requests remaining,
 *   non-merge observations are rescheduled past the reset rather than spent. The merge path,
 *   webhook wakes and merge verification keep what is left. The reading expires with its reset:
 *   once the reset has passed, the budget is unknown until a spent request reads the fresh
 *   headers, and an unknown budget never defers, so the observation that follows a reset (or a
 *   pause) is made rather than held on the count from before it.
 * - **Conditional reads.** Every read carries its ETag and GitHub charges nothing for the 304 it
 *   answers with, so observing an unchanged candidate costs at most a couple of charged requests.
 *
 * The webhook is the mechanism and polling is the safety net: a woken job never yields, whatever
 * cadence its state earned and whatever is left of the budget.
 */
/** How far back the spend rate is measured. */
export const budgetWindowMs = 10 * 60_000;
/** How far back the per-kind spend a pause incident reports is measured. */
export const budgetLedgerMs = 60 * 60_000;
/**
 * Requests held back for the merge path: the observations, the verification read and the merge
 * itself that a landing candidate needs, plus the webhook wakes that arrive while the budget is
 * low. Below it, every other observation waits for the reset. `GRAPHYARD_GITHUB_RESERVE` sizes it
 * for an installation with a different limit.
 */
export const mergePathReserve = (() => {
  const configured = Number(process.env.GRAPHYARD_GITHUB_RESERVE);
  return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : 500;
})();
/**
 * The share of the hourly limit steady-state observation polling may spend. The rest is headroom
 * for the merge path, for webhook wakes, and for the master session's own reads.
 */
export const steadyStateShare = 0.4;
/**
 * What the bound is computed from before GitHub has said otherwise: the smallest hourly limit an
 * installation gets, and roughly what one full observation costs in requests.
 */
export const defaultHourlyLimit = 5000, assumedObservationRequests = 10;
/**
 * The steady-state poll interval the fleet can afford: never under the steady cadence, and
 * stretched so that every open candidate polling at it for an hour costs at most the steady-state
 * share of the limit. Every request is counted, a conditional read GitHub answered with a free
 * 304 included, so the bound holds even where a 304 is charged; one hour is the ceiling, since
 * the budget itself resets by then.
 */
export function steadyStateInterval(openCandidates: number, meanRequests: number | null, limit: number | null) {
  const perObservation = meanRequests && meanRequests > 0 ? meanRequests : assumedObservationRequests;
  const share = Math.max(1, (limit ?? defaultHourlyLimit) * steadyStateShare);
  // One round of the fleet costs this much; the hour holds the round already made plus one more
  // per interval, and all of them together must fit the share.
  const round = Math.max(1, openCandidates) * perObservation;
  const affordable = share > round ? Math.ceil(round * 3600_000 / (share - round)) : 3600_000;
  return Math.min(3600_000, Math.max(observationCadenceMs.steady, affordable));
}
/**
 * The observation throughput one process has been achieving (GY-492), read from the durations of
 * the jobs it completed in `windowMs`: how many it finished a minute, and how long the typical
 * and the slowest tenth took. This is the number a stalled queue argues with: workers at twice
 * the fleet's arrival rate keep the head fresh, and `master status` reports the lag past it.
 */
export function observationThroughput(durations: { at: number; ms: number }[], now: number, windowMs = budgetWindowMs) {
  const recent = durations.filter(entry => now - entry.at <= windowMs);
  const sorted = recent.map(entry => entry.ms).sort((a, b) => a - b);
  const quantile = (fraction: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] : null;
  return { windowMs, count: recent.length, jobsPerMinute: Math.round(recent.length / (windowMs / 60_000) * 100) / 100,
    medianDurationMs: quantile(0.5), p90DurationMs: quantile(0.9) };
}
/**
 * The observation schedule, by what an observation of an item in that state can change.
 *
 * - `merge` — at the merge gate with every other gate passing. The merge executor refuses an
 *   observation older than two minutes and spends most of that on its own critical path, so this
 *   candidate is observed every 20 seconds. It is never in steady state: it is the moment of
 *   landing, and its cadence is paid for out of the merge-path reserve rather than the
 *   steady-state share.
 * - `active` — waiting on something GitHub can still deliver: a check, a review, a base refresh.
 * - `steady` — `active`, and the last observation came back with its head, base tip, check state
 *   and review state unchanged. The webhook wakes it the moment any of that moves. An unchanged
 *   `idle` candidate keeps the `idle` band and its five-minute floor, but is stretched by the same
 *   fleet bound when that is longer.
 * - `idle` — the next action is a dispatch, a rework or an escalation. Nothing on GitHub can move
 *   it, so polling is pure safety net.
 */
export const observationCadenceMs = { merge: 20_000, active: 60_000, steady: 120_000, idle: 300_000 } as const;
export type CadenceBand = keyof typeof observationCadenceMs;

/** The endpoint family a path spends on, for the per-kind spend a pause incident reports. */
const requestKinds: [RegExp, string][] = [
  [/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/files/, 'pull-files'],
  [/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews/, 'pull-reviews'],
  [/^\/repos\/[^/]+\/[^/]+\/pulls(\/|\?|$)/, 'pulls'],
  [/^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/check-runs/, 'check-runs'],
  [/^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/pulls/, 'commit-pulls'],
  [/^\/repos\/[^/]+\/[^/]+\/check-runs/, 'check-publication'],
  [/^\/repos\/[^/]+\/[^/]+\/compare\//, 'compare'],
  [/^\/repos\/[^/]+\/[^/]+\/contents\//, 'contents'],
  [/^\/repos\/[^/]+\/[^/]+\/git\//, 'git-refs'],
  [/^\/repos\/[^/]+\/[^/]+\/commits/, 'commits'],
  [/^\/repos\/[^/]+\/[^/]+\/branches\/.+\/protection/, 'protection'],
  [/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments/, 'comments'],
  [/^\/repos\/[^/]+\/[^/]+\/merges/, 'merges'],
  [/^\/installation\/repositories/, 'installation'],
  [/^\/app(\/|$)/, 'app'],
  [/^\/rate_limit/, 'rate-limit'],
];
export const requestKind = (path: string) => requestKinds.find(([pattern]) => pattern.test(path))?.[1] ?? 'other';

/** The live budget, the rate it is being spent at, and what the control plane is doing about it. */
export interface GitHubBudget {
  /** The installation's hourly limit and what is left of it, as the last response reported them. */
  limit: number | null; remaining: number | null; used: number | null;
  resetAt: string | null; observedAt: string | null;
  /** Requests that cost budget in the last `windowMs`, and that rate per minute. */
  windowMs: number; spentInWindow: number; perMinute: number;
  /** When the current rate reaches zero, and whether that lands before the reset. */
  projectedExhaustionAt: string | null; exhaustsBeforeReset: boolean;
  /**
   * The reset of a reading that has expired: it has passed, GitHub has replenished the budget,
   * and the count the last response reported is no longer what is left, so `remaining`, `used`
   * and `resetAt` read unknown until the next installation response refreshes them.
   */
  expiredResetAt: string | null;
  /** The merge-path reserve and whether the budget has fallen below it. */
  reserve: number; belowReserve: boolean;
  /** The steady-state share of the hourly limit, the request count it works out to, and the interval that keeps the fleet inside it. */
  steadyStateShare: number; steadyStateBudget: number | null;
  steadyState: { openCandidates: number; meanRequests: number; intervalMs: number };
  /** The pause in force, when a refusal stopped every request until the reset. */
  paused: { since: string; until: string; reason: string } | null;
  /** What the last hour was spent on, which is what a pause incident names. */
  lastHour: { requests: number; byKind: { kind: string; requests: number }[] };
  /** The schedule in force, and what each observation cost the job that made it. */
  cadence: Record<CadenceBand, number>;
  /** The throughput the observation workers have been achieving (GY-492), from the job durations of the last window. */
  throughput: ReturnType<typeof observationThroughput>;
  observations: { count: number; meanRequests: number | null; meanUncached: number | null;
    jobs: { work: string; at: string; requests: number; uncached: number; band: CadenceBand; cadenceMs: number }[] };
  /** Observations the reserve is holding back, until when and why. */
  deferrals: { work: string; until: string; reason: string }[];
  /** The shared pace the observation workers start jobs at (GY-567): tier, requests per minute, spacing, estimate in flight. */
  pace: ReturnType<ObservationPacer['report']>;
  /** Every installation token's own budget, reset and projection at that reset (GY-690). */
  tokens: TokenBudgetReport[];
}

/**
 * The state an observation is compared on: head, base tip, check state and review state. Two
 * observations with the same fingerprint told the control plane the same thing, which is what
 * makes the second one — and the next one — worth making less often.
 */
export function observationFingerprint(observation: Observation | null | undefined): string | null {
  if (!observation) return null;
  return JSON.stringify({
    sha: observation.candidate.sha, baseSha: observation.candidate.baseSha, baseTip: observation.baseTip,
    prState: observation.prState, draft: observation.draft, merged: observation.merged, mergeable: observation.mergeable, conflicting: observation.conflicting || undefined, mergeabilityUnknown: observation.mergeabilityUnknown || undefined,
    checks: observation.checks.map(check => [check.name, check.result, check.appId, check.id ?? null, check.attempt ?? null]),
    reviews: observation.reviews.map(review => [review.id, review.reviewer, review.sha, review.state]),
    agentReview: observation.agentReview ? [observation.agentReview.sha, observation.agentReview.approved, observation.agentReview.reason ?? null] : null,
  });
}

/** Entries within this many places of the merge-queue head are observed on the merge band. */
export const mergeBandQueueDepth = 2;
/** How many live merge-queue entries are ahead of this one (0 at the head, or when it is not queued). */
export function queuedAhead(work: Pick<Work, 'id' | 'queue'>, all: readonly Pick<Work, 'id' | 'queue' | 'stage'>[]) {
  const sequence = work.queue?.sequence;
  if (sequence === undefined || sequence === null) return 0;
  return all.filter(other => other.id !== work.id && other.stage !== 'done' && other.queue && other.queue.sequence < sequence).length;
}
/**
 * What an observation of this item could still change, from the item's state alone. `nextAction`
 * is the classification the whole control plane already uses for what an item needs next, so the
 * cadence follows it rather than inventing a second reading of the same state.
 */
export function observationBand(work: Work, all: Work[], now: Date, next = nextAction(work, all, now)): { band: Exclude<CadenceBand, 'steady'>; reason: string; fresh?: true } {
  const open = !!work.candidate && !!work.observation && !work.observation.merged && work.observation.prState === 'open';
  if (next?.kind === 'merge' || open && work.gates.every(gate => gate.name === 'merge' || gate.passed)) {
    // Only the entries that can merge next need the merge band's 20-second freshness. On
    // 2026-09-25 25 queued items all took it; each observation cost the server 10-13 s, the
    // observations fell behind, and every entry's merge gate read 'GitHub observation missing or
    // older than two minutes', so nothing merged and the queue only grew. An entry further back
    // cannot land before those ahead of it, so it is observed on the idle band until it nears the head.
    const ahead = queuedAhead(work, all);
    if (ahead >= mergeBandQueueDepth)
      return { band: 'idle', reason: `${work.key} is queued behind ${ahead} entries; it cannot land before them, so it is observed on the idle band until it is within ${mergeBandQueueDepth} of the head` };
    return { band: 'merge', reason: `${work.key} is at the merge gate with every other gate passing; the merge executor spends its observation's freshness` };
  }
  // The loop requests a rework only from an observation under two minutes old (master-daemon.ts
  // reworkObservationWait, GY-144). Polled on the idle or steady band — never less than two
  // minutes apart — the decision nearly always met a stale one: on 2026-09-25 GY-173, GY-177 and
  // GY-182 sat ejected from the merge queue for over an hour, "rework waits for a fresh GitHub
  // observation" every cycle. So such an item is observed at the active cadence, never stretched.
  if (next?.kind === 'request-rework')
    return { band: 'active', fresh: true, reason: `${work.key} needs a new head, and the loop requests that round only from an observation under two minutes old, so it is observed at the active cadence` };
  if (!next || next.kind === 'dispatch' || next.kind === 'escalate')
    return { band: 'idle', reason: `${work.key} needs ${next ? `a ${next.kind}` : 'nothing an observation can supply'}; nothing on GitHub can move it, so the webhook wakes it and polling is the safety net` };
  return { band: 'active', reason: `${work.key} needs ${next.kind}; GitHub can still change what it is waiting for` };
}

/**
 * When to observe this item again. `previous` is the observation the one just recorded replaced:
 * every non-merge candidate that came back saying exactly what it said last time is subject to
 * the fleet's steady-state bound, because the webhook is what will tell Graphyard that it moved.
 * Active candidates use the `steady` band; idle candidates retain their idle band and five-minute
 * floor so something GitHub cannot move is never polled more often than an active candidate.
 */
export function observationCadence(work: Work, all: Work[], now: Date, previous?: Observation | null, steadyMs: number = observationCadenceMs.steady, next = nextAction(work, all, now)): { band: CadenceBand; ms: number; reason: string } {
  const state = observationBand(work, all, now, next);
  if (state.band !== 'merge' && !state.fresh && previous && observationFingerprint(previous) === observationFingerprint(work.observation)) {
    const band = state.band === 'active' ? 'steady' : state.band;
    return { band, ms: Math.max(observationCadenceMs[band], steadyMs),
      reason: `${work.key} came back with its head, base tip, check state and review state unchanged; polling settles to the steady-state interval and the webhook wakes it the moment any of that moves` };
  }
  return { band: state.band, ms: observationCadenceMs[state.band], reason: state.reason };
}
/** The open candidates the steady-state bound is sized for: submitted, observed open, not delivered. */
export const openCandidates = (all: Work[]) => all.filter(work => work.stage !== 'done' && !!work.submission && !!work.observation && !work.observation.merged && work.observation.prState !== 'closed').length;

/**
 * Whether this observation may spend from a budget that has fallen below the merge-path reserve.
 * A merge-gate candidate and a job the webhook woke always may; everything else is rescheduled
 * past the reset with the reason, rather than spending the requests the merge path is owed.
 */
export function reserveDecision(band: CadenceBand, budget: Pick<GitHubBudget, 'remaining' | 'resetAt' | 'reserve'>, woken: boolean, now: Date): { until: string; reason: string } | null {
  if (band === 'merge' || woken) return null;
  if (budget.remaining === null || budget.remaining >= budget.reserve) return null;
  // A deferred observation makes no request, so nothing but a spent request refreshes the
  // reading. A reading whose reset has passed (or reports none) says nothing about the budget now
  // in force: deferring on it would hold every non-merge observation past a reset that has
  // already happened, for as long as no merge-gate candidate or webhook wake read fresh headers.
  // The reserve is held only against a count that is still in force; past its reset the
  // observation is spent, and the headers it comes back with decide the next one.
  const reset = budget.resetAt ? Date.parse(budget.resetAt) : NaN;
  if (!Number.isFinite(reset) || reset <= now.getTime()) return null;
  const until = new Date(reset + 2000).toISOString();
  return { until, reason: `GitHub budget is below the ${budget.reserve}-request merge-path reserve (${budget.remaining} remaining, reset ${budget.resetAt}); this ${band}-cadence observation is rescheduled to ${until} rather than spent, so the merge path, webhook wakes and merge verification keep the reserve` };
}
/**
 * Pacing the aggregate spend (GY-567). The reserve above gates each job on what is left, but not
 * how fast the workers together spend it: on 2026-09-26 four workers spent ~600 requests a minute,
 * drained the hour in half of it and the queue head read stale for the other half. So every worker
 * waits for one shared pace before it claims a job: the budget above the reserve, less what jobs
 * in flight are expected to spend, spread evenly over the time to the reset. Jobs start at most
 * one per `estimate / rate`, so the spend above the reserve reaches zero at the reset and never
 * before it, whatever the concurrency; a small burst (`paceBurstShare`) lets a backlog drain first. A job the spendable budget cannot afford waits for a reset
 * under a minute away (cheaper than the reserve); further off, it is paced from the reserve
 * itself, where `reserveDecision` lets only the merge path and webhook wakes spend.
 */
export const paceResetWaitMs = 60_000;
/**
 * The burst the pace allows on top of its rate: up to this share of the spendable budget may be
 * spent back to back (a backlog drained after a deploy), after which starts are spaced again. The
 * rate is recomputed from what is left, so a burst is paid for by the spacing after it.
 */
export const paceBurstShare = 0.1;
export type PaceTier = 'unpaced' | 'spendable' | 'reserve' | 'reset';
/** The rate jobs may start at (requests per millisecond), or when the next may start if none can. */
export function observationPace(budget: { remaining: number | null; resetAt: number | null; reserve: number; otherRate?: number }, inFlight: number, estimate: number, now: number): { tier: PaceTier; rate: number | null; until?: number; burst?: number } {
  // An unknown budget (none read yet, or its reset has passed) is never held against: the first
  // response after a reset is what reads the new one.
  if (budget.remaining === null || budget.resetAt === null || budget.resetAt <= now) return { tier: 'unpaced', rate: null };
  const toReset = Math.max(1, budget.resetAt - now), cost = Math.max(1, estimate);
  // What everyone else will spend on this token before its reset (GY-690): review and producer
  // launches, merges, protection reads, the submission observer. It is not the workers' to spend.
  const others = Math.max(0, budget.otherRate ?? 0) * toReset;
  const spendable = budget.remaining - budget.reserve - inFlight - others;
  if (spendable > cost) return { tier: 'spendable', rate: spendable / toReset, burst: spendable * paceBurstShare };
  const reserve = budget.remaining - inFlight - others;
  if (toReset <= paceResetWaitMs || reserve < cost) return { tier: 'reset', rate: 0, until: budget.resetAt + 1000 };
  return { tier: 'reserve', rate: reserve / toReset };
}
/**
 * The one pace every observation worker of a process shares. `start` either takes the next slot
 * (and counts the job's estimate in flight) or says how long to wait; `settle` returns the slot
 * with what the job actually charged, so a deferral that spent nothing gives its time back and a
 * costly job pushes the next start out by what it overspent.
 */
export class ObservationPacer {
  private nextAt = 0;
  inFlight = 0;
  last: { tier: PaceTier; rate: number | null; estimate: number } = { tier: 'unpaced', rate: null, estimate: assumedObservationRequests };
  start(budget: Parameters<typeof observationPace>[0], estimate: number, now: number): { wait: number; settle?: undefined } | { wait: 0; settle: (charged?: number, at?: number) => void } {
    const pace = observationPace(budget, this.inFlight, estimate, now);
    this.last = { tier: pace.tier, rate: pace.rate, estimate };
    if (pace.until !== undefined) return { wait: Math.max(1, pace.until - now) };
    // A token bucket: idle time banks up to the burst, and each start spends one spacing of it.
    const credit = pace.rate && pace.burst ? pace.burst / pace.rate : 0;
    const from = Math.max(this.nextAt, now - credit);
    if (from > now) return { wait: from - now };
    // An unpaced start (no reading yet) spends no credit: the bucket is full when the first reading lands.
    if (pace.rate) this.nextAt = from + estimate / pace.rate;
    this.inFlight += estimate;
    let settled = false;
    return { wait: 0, settle: (charged = estimate, at = now) => {
      if (settled) return; settled = true;
      this.inFlight = Math.max(0, this.inFlight - estimate);
      if (pace.rate) this.nextAt += (charged - estimate) / pace.rate;
    } };
  }
  /** The pace in force, per minute, for the status an operator reads. */
  report() {
    const perMinute = this.last.rate === null ? null : Math.round(this.last.rate * 60_000 * 100) / 100;
    return { tier: this.last.tier, perMinute, intervalMs: this.last.rate ? Math.round(this.last.estimate / this.last.rate) : this.last.rate === 0 ? null : 0, inFlight: this.inFlight, estimate: this.last.estimate };
  }
}
/** A token's name in the budget ledger and in `master status`: a digest, never the token itself. */
export const tokenIdentity = (token: string) => createHash('sha256').update(token).digest('hex').slice(0, 12);
/** One response's reading of a token's budget: what is left, the limit, and when it resets. */
export interface TokenReading { limit: number | null; remaining: number; used: number | null; resetAt: number | null; at: number }
/** One token's budget as `master status` reports it (GY-690). */
export interface TokenBudgetReport {
  token: string; current: boolean; limit: number | null; remaining: number; resetAt: string | null; observedAt: string;
  /** What the token has been spending a minute over the window, by everyone, and the part of it made outside the observation pace. */
  perMinute: number; otherPerMinute: number;
  /** What is left at the reset if that spend continues, and whether that is below the merge-path reserve. */
  projectedAtReset: number | null; belowReserveAtReset: boolean;
  pace: ReturnType<ObservationPacer['report']>;
}
/**
 * Every installation token's own budget (GY-690). On 2026-09-26 the pace held the budget one
 * token reported while two tokens with different resets were spending, and review launches,
 * merges, protection reads and the submission observer spent 100+ requests a minute outside it:
 * the hour fell to 94 remaining before its reset. So every request is charged to the token that
 * made it, each token keeps its own reading, reset and pace, and a token's spend rate is read from
 * its own `x-ratelimit-remaining` series, which counts every caller of that budget, this process's
 * or not. What the paced observation jobs did not spend of it is what `observationPace` holds back
 * for the others until the reset. `githubFromEnv` shares one ledger across the process, so the
 * engine's submission observer and the server's workers read the same account.
 */
export class TokenBudgets {
  private entries = new Map<string, { reading: TokenReading | null; readings: TokenReading[]; charges: { at: number; paced: boolean }[]; pacer: ObservationPacer }>();
  private entry(token: string) {
    let entry = this.entries.get(token);
    if (!entry) this.entries.set(token, entry = { reading: null, readings: [], charges: [], pacer: new ObservationPacer() });
    return entry;
  }
  /** Record one response's reading. Responses to concurrent requests arrive out of order; within one reset the budget only falls. */
  read(token: string, reading: TokenReading) {
    const entry = this.entry(token), previous = entry.reading;
    const same = previous && previous.resetAt === reading.resetAt;
    entry.reading = same && previous.remaining < reading.remaining ? { ...reading, remaining: previous.remaining } : reading;
    entry.readings = [...entry.readings.filter(entry => reading.at - entry.at <= budgetWindowMs), entry.reading].slice(-4096);
  }
  /** Charge one request that cost budget to the token that made it; `paced` when a paced observation job made it. */
  charge(token: string, at: number, paced: boolean) {
    const entry = this.entry(token);
    entry.charges.push({ at, paced });
    if (entry.charges.length > 8192 || entry.charges.length % 256 === 0) entry.charges = entry.charges.filter(charge => at - charge.at <= budgetWindowMs);
  }
  /** The token's reading while it is in force: past its reset the budget is unknown until a response reads it again. */
  reading(token: string, now: number) {
    const reading = this.entries.get(token)?.reading ?? null;
    return reading && (reading.resetAt === null || reading.resetAt > now) ? reading : null;
  }
  pacer(token: string) { return this.entry(token).pacer; }
  /**
   * Requests a millisecond the token has been spending over the window: in all, and outside the
   * paced observation jobs. From the header series when it spans a minute of one reset, since it
   * counts every caller; from this process's own charges until then.
   */
  rates(token: string, now: number): { total: number; other: number } {
    const entry = this.entries.get(token);
    if (!entry) return { total: 0, other: 0 };
    const charges = entry.charges.filter(charge => now - charge.at <= budgetWindowMs);
    const latest = entry.reading;
    const series = latest ? entry.readings.filter(reading => reading.resetAt === latest.resetAt && now - reading.at <= budgetWindowMs) : [];
    const first = series[0], last = series[series.length - 1];
    if (first && last && last.at - first.at >= 60_000) {
      const span = last.at - first.at, between = charges.filter(charge => charge.at > first.at && charge.at <= last.at);
      const drop = Math.max(0, first.remaining - last.remaining), paced = between.filter(charge => charge.paced).length;
      return { total: drop / span, other: Math.max(drop - paced, between.length - paced) / span };
    }
    if (!charges.length) return { total: 0, other: 0 };
    const span = Math.min(budgetWindowMs, Math.max(60_000, now - charges[0].at));
    return { total: charges.length / span, other: charges.filter(charge => !charge.paced).length / span };
  }
  /** Take the next paced observation slot on this token, holding back what the others will spend by its reset. */
  pace(token: string, estimate: number, now: number, reserve: number, fallback?: { remaining: number | null; resetAt: number | null }) {
    const reading = this.reading(token, now);
    const budget = reading ? { remaining: reading.remaining, resetAt: reading.resetAt } : fallback ?? { remaining: null, resetAt: null };
    return this.pacer(token).start({ ...budget, reserve, otherRate: this.rates(token, now).other }, estimate, now);
  }
  /** Every token with a reading in force: remaining, reset, spend rate and what is projected to be left at the reset. */
  report(now: number, reserve: number, current?: string): TokenBudgetReport[] {
    for (const [token, entry] of this.entries)
      if (!this.reading(token, now) && entry.pacer.inFlight === 0 && !entry.charges.some(charge => now - charge.at <= budgetWindowMs)) this.entries.delete(token);
    return [...this.entries].flatMap(([token, entry]) => {
      const reading = this.reading(token, now);
      if (!reading) return [];
      const rates = this.rates(token, now);
      const projected = reading.resetAt === null ? null : Math.max(0, Math.round(reading.remaining - rates.total * Math.max(0, reading.resetAt - now)));
      return [{ token, current: token === current, limit: reading.limit, remaining: reading.remaining,
        resetAt: reading.resetAt === null ? null : new Date(reading.resetAt).toISOString(), observedAt: new Date(reading.at).toISOString(),
        perMinute: Math.round(rates.total * 60_000 * 100) / 100, otherPerMinute: Math.round(rates.other * 60_000 * 100) / 100,
        projectedAtReset: projected, belowReserveAtReset: projected !== null && projected < reserve, pace: entry.pacer.report() }];
    }).sort((a, b) => Number(b.current) - Number(a.current) || a.token.localeCompare(b.token));
  }
}
/** The one ledger every GitHub client of this process charges (see `TokenBudgets`). */
export const processTokenBudgets = new TokenBudgets();
/**
 * Whether the budget is tight (GY-567): below the reserve, projected to run out before the reset,
 * or paced under the steady-state share per minute. Then idle observations are left to webhooks
 * and conditional reads, and the claim order puts sessions that are running ahead of the rest.
 */
export function budgetTight(budget: Pick<GitHubBudget, 'belowReserve' | 'exhaustsBeforeReset' | 'steadyStateBudget' | 'pace'> | null | undefined) {
  if (!budget) return false;
  const steadyPerMinute = (budget.steadyStateBudget ?? defaultHourlyLimit * steadyStateShare) / 60;
  return budget.belowReserve || budget.exhaustsBeforeReset || budget.pace.perMinute !== null && budget.pace.perMinute < steadyPerMinute;
}
/**
 * Under a tight budget an idle observation (nothing GitHub can move) that no webhook woke is not
 * polled: it waits for the reset or its next webhook delivery, whichever comes first.
 */
export function tightBudgetDecision(band: CadenceBand, budget: Pick<GitHubBudget, 'belowReserve' | 'exhaustsBeforeReset' | 'steadyStateBudget' | 'pace' | 'resetAt'> | null | undefined, woken: boolean, now: Date): { until: string; reason: string } | null {
  if (band !== 'idle' || woken || !budgetTight(budget)) return null;
  const reset = budget!.resetAt ? Date.parse(budget!.resetAt) : NaN;
  const until = new Date(Number.isFinite(reset) && reset > now.getTime() ? reset + 2000 : now.getTime() + observationCadenceMs.idle).toISOString();
  return { until, reason: `GitHub budget is tight (paced at ${budget!.pace.perMinute ?? '?'}/min, reset ${budget!.resetAt ?? 'unknown'}); this idle observation is left to webhook wakes and conditional reads until ${until}` };
}
/** The id of every review on a pull request GitHub reports as dismissed, from its full review list. */
export function dismissedReviewIds(reviews: readonly { id?: unknown; state?: unknown }[]): number[] {
  return reviews.flatMap(review => review.state === 'DISMISSED' && Number.isSafeInteger(review.id) && (review.id as number) > 0 ? [review.id as number] : []);
}
export interface GitHubConfig { repository: string; base: string; appId: number; installationId: number; privateKey: string; reviewerApps?: ReviewerApp[] }
/**
 * A 401 or a non-rate-limit 403. Retrying it does not help: the credentials or the installed
 * permissions have to change. It is classified apart from rate limiting so it never pauses the
 * whole client, and the job that hit it is held after a bounded number of attempts.
 */
export class GitHubPermissionRefusal extends Refusal {
  constructor(message: string, public kind: 'authentication' | 'permission', status = 502) { super(message, status); }
}
/** What the installed App can do, compared with what Graphyard declares it needs. */
export interface AppPermissionReport {
  appId: number; installationId: number; app: string; account: string | null; installationUrl: string;
  observedAt: string; verifiedAt: string | null; error: string | null; suspended: boolean;
  required: Record<string, PermissionLevel>; granted: Record<string, string> | null;
  missing: PermissionShortfall[]; blockedFeatures: PermissionFeature[]; attention: string[];
}
/**
 * The installation a hold was decided against: identity, suspension and the granted levels of
 * the last verified reading. A hold is released when a passing preflight reports a different
 * fingerprint, never because the same installation was read again. Null until a reading exists.
 */
export function installationFingerprint(report: AppPermissionReport | null): string | null {
  if (!report?.granted) return null;
  const granted = Object.fromEntries(Object.entries(report.granted).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({ appId: report.appId, installationId: report.installationId, suspended: report.suspended, granted });
}
/** App-level endpoints authenticate with a short JWT signed by the App private key. */
export function appJwt(appId: number, privateKey: string, now = Date.now()) {
  const issued = Math.floor(now / 1000);
  const encode = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: issued - 60, exp: issued + 540, iss: String(appId) })}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url')}`;
}
const mergeQueueQuery = `query($owner: String!, $name: String!, $number: Int!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    mergeQueue(branch: $branch) { id }
    pullRequest(number: $number) { id headRefOid mergeStateStatus isInMergeQueue autoMergeRequest { enabledAt } mergeQueueEntry { state position headCommit { oid } } }
  }
}`;
const enqueueMutation = `mutation($id: ID!, $head: GitObjectID!) { enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head }) { mergeQueueEntry { id } } }`;
const dequeueMutation = `mutation($id: ID!) { dequeuePullRequest(input: { id: $id }) { mergeQueueEntry { id } } }`;
const autoMergeMutation = `mutation($id: ID!, $head: GitObjectID!, $method: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, expectedHeadOid: $head, mergeMethod: $method }) { pullRequest { id } } }`;
/** An immediate merge bound to the exact head, for a pull request GitHub reports mergeable now (no queue); branch protection still applies. */
const headBoundMergeMutation = `mutation($id: ID!, $head: GitObjectID!, $method: PullRequestMergeMethod!) { mergePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head, mergeMethod: $method }) { pullRequest { id } } }`;
const disableAutoMergeMutation = `mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { pullRequest { id } } }`;
/** The merge method auto-merge uses where the base branch has no queue; a queue's own ruleset sets its method. */
const autoMergeMethod = () => (['MERGE', 'SQUASH', 'REBASE'] as const).find(method => method === process.env.GITHUB_MERGE_METHOD?.toUpperCase()) ?? 'MERGE';
export const installationSettingsUrl = (installationId: number) => `https://github.com/settings/installations/${installationId}`;
export class GitHub {
  /** The wait between re-requests of a pull request whose mergeability GitHub has not computed yet. */
  mergeabilityRetryMs: number = mergeabilityRetryIntervalMs;
  private token = '';
  private expires = 0;
  private permissions: Record<string, string> = {};
  private blockedUntil = 0;
  private rateFailures = 0;
  private authentication?: Promise<void>;
  private cache = new Map<string, { etag: string; value: any }>();
  private ancestry = new Map<string, boolean>();
  private usage = { since: Date.now(), total: 0, notModified: 0, byKind: new Map<string, number>(), remaining: null as string | null, reset: null as string | null, token: '' };
  /** Once a minute, logs what the App spent: requests, free 304s, the costliest endpoints, and GitHub's own remaining budget of the token that last answered. */
  private meter(method: string, path: string, response: Response, token = '') {
    const u = this.usage;
    u.token = token || u.token;
    u.total++; if (response.status === 304) u.notModified++;
    const kind = `${method} ${path.replace(/^\/repos\/[^/]+\/[^/]+/, '').replace(/\?.*$/, '').replace(/[a-f0-9]{40}/g, ':sha').replace(/\/\d+/g, '/:n').replace(/^\/contents\/.*/, '/contents/:path').replace(/^\/compare\/.*/, '/compare/:range')}`;
    u.byKind.set(kind, (u.byKind.get(kind) ?? 0) + 1);
    u.remaining = response.headers.get('x-ratelimit-remaining') ?? u.remaining; u.reset = response.headers.get('x-ratelimit-reset') ?? u.reset;
    if (Date.now() - u.since < 60_000) return;
    const top = [...u.byKind.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k}=${n}`).join(', ');
    console.log(`GitHub usage ${Math.round((Date.now() - u.since) / 1000)}s: ${u.total} requests, ${u.notModified} not-modified (free); remaining ${u.remaining} until ${u.reset ? new Date(Number(u.reset) * 1000).toISOString() : '?'}${u.token ? ` (token ${u.token})` : ''}; top ${top}`);
    this.usage = { since: Date.now(), total: 0, notModified: 0, byKind: new Map(), remaining: u.remaining, reset: u.reset, token: u.token };
  }
  private blobs = new Map<string, string | null>();
  private histories = new Map<string, Set<string> | null>();
  /** Files changed between two pinned commits (GY-500); immutable, so each pair is compared once. */
  private baseChangeLists = new Map<string, string[] | null>();
  /** The persisted cold layer under the four maps above (src/github-cache.ts), when attached. */
  private persisted: GitHubCacheStore | null = null;
  private warming: Promise<void> | null = null;
  /** Load the persisted caches into the maps and write new entries behind. Resolves once loaded; never rejects. */
  attachCache(store: GitHubCacheStore) {
    this.persisted = store;
    const warming = store.load({ etag: this.cache, ancestry: this.ancestry, blob: this.blobs, history: this.histories },
      { etag: etagCacheEntries, ancestry: ancestryEntries, blob: ancestryEntries, history: historyEntries }).then(() => { if (this.warming === warming) this.warming = null; });
    this.warming = warming;
    return warming;
  }
  /** A request made while the persisted cache is still loading waits for it, at most two seconds. */
  private async warm() {
    if (!this.warming) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.warming, new Promise<void>(resolve => { timer = setTimeout(resolve, 2_000); timer.unref?.(); })]);
    clearTimeout(timer);
  }
  private preflightState: AppPermissionReport | null = null;
  private preflightDueAt = 0;
  private appSlug: string | null = null;
  // A rejected App credential is retried once a minute, not once per queued job: every request
  // needs the token, so this is the whole bound on credential-refusal traffic.
  private authenticationRefusal: { until: number; error: GitHubPermissionRefusal } | null = null;
  /** How often the installed permissions are re-read when nothing has gone wrong. */
  preflightIntervalMs = 5 * 60_000;
  // ---- The request budget (see `GitHubBudget` above) ----------------------------------------
  /** The limit, what is left of it and when it resets, as the last installation response said. */
  private rate: { limit: number | null; remaining: number | null; used: number | null; resetAt: number | null; observedAt: number | null } = { limit: null, remaining: null, used: null, resetAt: null, observedAt: null };
  /** Every request that cost budget in the last hour, with the endpoint family it spent on. */
  private charges: { at: number; kind: string }[] = [];
  /** What each item's last observation cost, against the job that made it. */
  private costs = new Map<string, { at: number; requests: number; uncached: number; band: CadenceBand; cadenceMs: number }>();
  /** The same costs as a fleet sample, for the mean an operator reads. */
  private samples: { at: number; requests: number; uncached: number }[] = [];
  /** Observations the reserve is holding back, until when and why. */
  private deferred = new Map<string, { until: string; reason: string }>();
  /** How long each completed observation job took, for the throughput report (GY-492). */
  private jobDurations: { at: number; ms: number }[] = [];
  private pausedSince = 0;
  private pauseReason = '';
  /** The open candidates the last reconciliation pass counted, which sizes the steady-state bound. */
  private fleet = 0;
  /** Counts the requests one measured stretch of work makes, and the ones that cost budget. */
  private readonly requestMeter = new AsyncLocalStorage<{ requests: number; uncached: number }>();
  /**
   * @param budgets Every token's budget and pace (GY-690): observation workers pace on the current
   * token's, and every request is charged to the token that made it. `githubFromEnv` passes the
   * process's one ledger.
   */
  constructor(public config: GitHubConfig, private readonly budgets: TokenBudgets = new TokenBudgets()) {}
  private backoff(response?: Response, context = 'a request') {
    const retry = Number(response?.headers.get('retry-after'));
    const reset = Number(response?.headers.get('x-ratelimit-reset')) * 1000;
    const before = this.blockedUntil;
    // One pause is one incident (GY-117): the first refusal that raised it is what it is dated from,
    // and every job that runs into it afterwards reports the same instant rather than a new one.
    if (before <= Date.now()) { this.pausedSince = Date.now(); this.pauseReason = `GitHub answered ${response?.status ?? 'a rate-limit refusal'} for ${context} with ${response?.headers.get('x-ratelimit-remaining') ?? 'no'} requests remaining`; }
    // An exhausted primary budget names its own reset: wait exactly that long. Doubling on each of the
    // refusals already in flight pushed the pause up to an hour past the reset.
    if (response?.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset) && reset > Date.now()) { this.blockedUntil = Math.max(this.blockedUntil, reset); return; }
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + Math.min(3600_000, 60_000 * 2 ** Math.min(this.rateFailures++, 6)), Number.isFinite(retry) && retry > 0 ? Date.now() + retry * 1000 : 0);
  }
  /**
   * What one provider response says about the budget. A 304 costs nothing — GitHub does not charge
   * a conditional read it answers from the caller's own ETag — so it is counted as a request made
   * and not as budget spent, which is the whole reason an unchanged candidate is cheap to observe.
   * Only installation requests report the budget this class is spending; App-level calls
   * (`/app`, token refresh) are counted as requests against a different allowance.
   */
  private record(path: string, response: Response, tracked: boolean, now = Date.now(), charged = true, token: string | null = null) {
    const resource = response.headers.get('x-ratelimit-resource');
    const number = (name: string) => { const value = Number(response.headers.get(name)); return Number.isFinite(value) ? value : null; };
    const remaining = number('x-ratelimit-remaining');
    const core = tracked && remaining !== null && (!resource || resource === 'core');
    if (core) {
      const reset = number('x-ratelimit-reset');
      this.rate = { limit: number('x-ratelimit-limit') ?? this.rate.limit, remaining, used: number('x-ratelimit-used') ?? this.rate.used,
        resetAt: reset === null ? this.rate.resetAt : reset * 1000, observedAt: now };
      // The reading belongs to the token that made the request, not to whichever token answered last (GY-690).
      if (token !== null) this.budgets.read(token, { limit: this.rate.limit, remaining, used: this.rate.used, resetAt: reset === null ? null : reset * 1000, at: now });
    }
    const meter = this.requestMeter.getStore();
    if (meter) { meter.requests++; if (response.status !== 304) meter.uncached++; }
    // A 304 costs nothing, and the refusal that announces an exhausted budget did not spend it.
    if (response.status === 304 || !charged || response.status === 429 || response.status === 403 && remaining === 0) return;
    // A measured stretch is an observation job the pace started; every other request is spend the pace must leave room for.
    if (tracked && token !== null) this.budgets.charge(token, now, !!meter);
    this.charges.push({ at: now, kind: requestKind(path) });
    if (this.charges.length > 8192) this.charges = this.charges.filter(charge => now - charge.at <= budgetLedgerMs);
  }
  /** Run `fn` counting the requests it makes and the ones that actually cost budget. */
  async measured<T>(fn: () => Promise<T>): Promise<{ value: T; requests: number; uncached: number }> {
    const meter = { requests: 0, uncached: 0 };
    const value = await this.requestMeter.run(meter, fn);
    return { value, requests: meter.requests, uncached: meter.uncached };
  }
  /** Record what one item's observation cost, against the job that made it. */
  recordObservation(work: string, cost: { requests: number; uncached: number; band: CadenceBand; cadenceMs: number }, now = Date.now()) {
    this.costs.set(work, { at: now, ...cost });
    // A long-lived process observes far more items than it holds open; the ledger keeps the
    // most recent so it stays a reading of the fleet rather than of its whole history.
    if (this.costs.size > 500) for (const [key] of [...this.costs].sort((a, b) => a[1].at - b[1].at).slice(0, this.costs.size - 500)) this.costs.delete(key);
    this.samples = [...this.samples, { at: now, requests: cost.requests, uncached: cost.uncached }].filter(sample => now - sample.at <= budgetLedgerMs);
    this.deferred.delete(work);
  }
  /** Record an observation the reserve held back, so the deferral is readable as a decision. */
  recordDeferral(work: string, deferral: { until: string; reason: string }) { this.deferred.set(work, deferral); }
  /** Record how long one claimed observation job took, however it ended (GY-492). */
  recordJobDuration(ms: number, now = Date.now()) {
    this.jobDurations = [...this.jobDurations, { at: now, ms: Math.max(0, Math.floor(ms)) }].filter(entry => now - entry.at <= budgetLedgerMs);
    if (this.jobDurations.length > 512) this.jobDurations = this.jobDurations.slice(this.jobDurations.length - 512);
  }
  /**
   * Wait for the shared pace before claiming an observation job (GY-567): `wait` is how long to
   * sleep before asking again, or a started slot whose `settle` takes what the job charged.
   */
  paceObservation(now = Date.now()) {
    const expired = this.rate.resetAt !== null && this.rate.resetAt <= now;
    const charged = this.samples.filter(sample => now - sample.at <= budgetLedgerMs).map(sample => sample.uncached);
    const estimate = charged.length ? Math.max(1, charged.reduce((total, value) => total + value, 0) / charged.length) : assumedObservationRequests;
    // The pace is the current token's (GY-690): its own reading and reset, less what every caller
    // outside the observation workers is spending on it. Before that token has a reading of its
    // own, the client's last reading stands in.
    return this.budgets.pace(tokenIdentity(this.token), estimate, now, mergePathReserve, { remaining: expired ? null : this.rate.remaining, resetAt: expired ? null : this.rate.resetAt });
  }
  /** The open candidates the steady-state bound is sized for, as the last pass counted them. */
  noteFleet(openCandidates: number) { this.fleet = Math.max(0, Math.floor(openCandidates)); }
  /** The steady-state poll interval the fleet can afford right now (see `steadyStateInterval`). */
  steadyStateMs(now = Date.now()) { const budget = this.budget(now); return budget.steadyState.intervalMs; }
  /**
   * The App's settings page, where its webhook URL, secret and recent deliveries live. The slug
   * is known once the preflight has read the installation; before that the App list is named.
   * An App owned by an organization lives under that organization's settings instead.
   */
  webhookSettingsUrl() {
    const slug = this.preflightState?.verifiedAt && this.preflightState.app !== String(this.config.appId) ? this.preflightState.app : this.appSlug;
    return slug ? `https://github.com/settings/apps/${encodeURIComponent(slug)}` : 'https://github.com/settings/apps';
  }
  /** The live budget: what is left, how fast it is going, and what the control plane is doing about it. */
  budget(now = Date.now()): GitHubBudget {
    this.charges = this.charges.filter(charge => now - charge.at <= budgetLedgerMs);
    const spentInWindow = this.charges.filter(charge => now - charge.at <= budgetWindowMs).length;
    const perMinute = spentInWindow / (budgetWindowMs / 60_000);
    const { limit, observedAt } = this.rate;
    // The reading expires with its reset. Past it GitHub has replenished the budget and the count
    // the last response reported is not what is left, so it reads unknown until a spent request
    // refreshes it: the reserve never defers on it and no exhaustion is projected from it. After a
    // pause this is what lets the first observation past the reset be made at all, since the 403
    // that raised the pause reported zero remaining.
    const expired = this.rate.resetAt !== null && this.rate.resetAt <= now;
    const remaining = expired ? null : this.rate.remaining;
    const used = expired ? null : this.rate.used;
    const resetAt = expired ? null : this.rate.resetAt;
    const exhaustion = remaining !== null && perMinute > 0 ? now + (remaining / perMinute) * 60_000 : null;
    const counts = new Map<string, number>();
    for (const charge of this.charges) counts.set(charge.kind, (counts.get(charge.kind) ?? 0) + 1);
    const samples = this.samples.filter(sample => now - sample.at <= budgetLedgerMs);
    const mean = (values: number[]) => values.length ? Math.round(values.reduce((total, value) => total + value, 0) / values.length * 100) / 100 : null;
    return {
      limit, remaining, used,
      resetAt: resetAt === null ? null : new Date(resetAt).toISOString(),
      observedAt: observedAt === null ? null : new Date(observedAt).toISOString(),
      windowMs: budgetWindowMs, spentInWindow, perMinute: Math.round(perMinute * 100) / 100,
      projectedExhaustionAt: exhaustion === null ? null : new Date(exhaustion).toISOString(),
      exhaustsBeforeReset: exhaustion !== null && resetAt !== null && exhaustion < resetAt,
      expiredResetAt: expired ? new Date(this.rate.resetAt!).toISOString() : null,
      reserve: mergePathReserve, belowReserve: remaining !== null && remaining < mergePathReserve,
      steadyStateShare, steadyStateBudget: Math.floor((limit ?? defaultHourlyLimit) * steadyStateShare),
      steadyState: { openCandidates: this.fleet, meanRequests: mean(samples.map(sample => sample.requests)) ?? assumedObservationRequests, intervalMs: steadyStateInterval(this.fleet, mean(samples.map(sample => sample.requests)), limit) },
      paused: this.blockedUntil > now ? { since: new Date(this.pausedSince || now).toISOString(), until: new Date(this.blockedUntil).toISOString(),
        reason: this.pauseReason || 'GitHub refused a request for rate limiting' } : null,
      lastHour: { requests: this.charges.length, byKind: [...counts].map(([kind, requests]) => ({ kind, requests })).sort((a, b) => b.requests - a.requests || a.kind.localeCompare(b.kind)) },
      cadence: { ...observationCadenceMs },
      throughput: observationThroughput(this.jobDurations, now),
      observations: { count: samples.length, meanRequests: mean(samples.map(sample => sample.requests)), meanUncached: mean(samples.map(sample => sample.uncached)),
        jobs: [...this.costs].map(([work, cost]) => ({ work, at: new Date(cost.at).toISOString(), requests: cost.requests, uncached: cost.uncached, band: cost.band, cadenceMs: cost.cadenceMs })) },
      deferrals: [...this.deferred].flatMap(([work, entry]) => Date.parse(entry.until) > now ? [{ work, until: entry.until, reason: entry.reason }] : []),
      pace: this.budgets.pacer(tokenIdentity(this.token)).report(),
      tokens: this.budgets.report(now, mergePathReserve, tokenIdentity(this.token)),
    };
  }
  /**
   * Turns a failed response into the right refusal. Only a rate limit pauses the client; an
   * authentication or permission refusal is reported as such, and a permission refusal brings
   * the next permission preflight forward so the operator sees what is actually missing.
   */
  private async refusal(response: Response, context: string): Promise<Refusal | null> {
    if (response.ok) return null;
    let text = '';
    try { text = (await response.text()).slice(0, 2000); } catch { /* The status alone is classified. */ }
    const rateLimited = response.status === 429 || response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || !!response.headers.get('retry-after') || /rate limit/i.test(text));
    if (rateLimited) {
      this.backoff(response, context);
      return new Refusal(`GitHub ${context} failed (${response.status}): rate limited; requests paused until ${new Date(this.blockedUntil).toISOString()}`, 502);
    }
    if (response.status === 401) return new GitHubPermissionRefusal(`GitHub ${context} failed (401): the App credentials were rejected; check GITHUB_APP_ID, GITHUB_INSTALLATION_ID and the private key`, 'authentication');
    if (response.status === 403) {
      this.preflightDueAt = 0;
      return new GitHubPermissionRefusal(`GitHub ${context} failed (403): ${this.permissionHint()}`, 'permission');
    }
    return new Refusal(`GitHub ${context} failed (${response.status})`, 502);
  }
  private permissionHint() {
    const report = this.preflightState;
    if (report?.suspended) return `the App installation is suspended; restore it at ${report.installationUrl}`;
    if (report?.missing.length) return describeShortfall(report.missing[0], report.app, report.installationUrl);
    return `the installed App lacks a permission this request needs; compare its installation at ${report?.installationUrl ?? installationSettingsUrl(this.config.installationId)} with graphyard github-setup --update-permissions`;
  }
  private appHeaders() {
    return { Authorization: `Bearer ${appJwt(this.config.appId, this.config.privateKey)}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  }
  /**
   * Reads the installation's granted permissions with the App JWT and compares them with the
   * declared set. Never throws: an unreadable installation is itself reported, and the last
   * verified reading is retained so a transient outage does not silently lift a hold.
   */
  async preflight(now = Date.now()): Promise<AppPermissionReport> {
    const previous = this.preflightState;
    const required = requiredPermissions(controlPlanePermissions);
    const base = { appId: this.config.appId, installationId: this.config.installationId, app: previous?.app ?? String(this.config.appId), account: previous?.account ?? null,
      installationUrl: previous?.installationUrl ?? installationSettingsUrl(this.config.installationId), observedAt: new Date(now).toISOString(), required };
    try {
      demand(now >= this.blockedUntil, `GitHub requests paused until ${new Date(this.blockedUntil).toISOString()} after a rate limit`, 502);
      const response = await fetch(`https://api.github.com/app/installations/${this.config.installationId}`, { headers: this.appHeaders(), signal: AbortSignal.timeout(15_000) });
      this.record('/app/installations', response, false);
      const refused = await this.refusal(response, 'GET /app/installations');
      if (refused) throw refused;
      const installation: any = await response.json();
      demand(installation && typeof installation === 'object' && installation.permissions && typeof installation.permissions === 'object', 'GitHub returned an installation without permissions', 502);
      const granted: Record<string, string> = Object.fromEntries(Object.entries(installation.permissions).filter(([, level]) => typeof level === 'string')) as Record<string, string>;
      const missing = permissionShortfalls(granted, controlPlanePermissions);
      const app = typeof installation.app_slug === 'string' && installation.app_slug ? installation.app_slug : String(this.config.appId);
      const installationUrl = typeof installation.html_url === 'string' && /^https:\/\/github\.com\//.test(installation.html_url) ? installation.html_url : installationSettingsUrl(this.config.installationId);
      const suspended = !!installation.suspended_at;
      const attention = [...(suspended ? [`App ${app} installation is suspended; restore it at ${installationUrl}`] : []), ...missing.map(shortfall => describeShortfall(shortfall, app, installationUrl))];
      this.preflightState = { ...base, app, account: typeof installation.account?.login === 'string' ? installation.account.login : null, installationUrl, verifiedAt: base.observedAt, error: null, suspended, granted, missing, blockedFeatures: blockedFeatures(missing), attention };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'GitHub App permissions could not be read';
      const retained = previous ? { granted: previous.granted, missing: previous.missing, blockedFeatures: previous.blockedFeatures, suspended: previous.suspended, verifiedAt: previous.verifiedAt } : { granted: null, missing: [], blockedFeatures: [] as PermissionFeature[], suspended: false, verifiedAt: null };
      const attention = [`GitHub App permissions could not be verified${retained.verifiedAt ? ` since ${retained.verifiedAt}` : ''}: ${message}`, ...(previous?.attention.filter(line => !line.startsWith('GitHub App permissions could not be verified')) ?? [])];
      this.preflightState = { ...base, ...retained, error: message, attention };
    }
    this.preflightDueAt = now + this.preflightIntervalMs;
    return this.preflightState;
  }
  /** Runs the periodic preflight when its interval elapsed or a permission refusal brought it forward. */
  async preflightIfDue(now = Date.now()): Promise<AppPermissionReport | null> {
    return now >= this.preflightDueAt ? this.preflight(now) : null;
  }
  permissionReport(): AppPermissionReport | null { return this.preflightState ? structuredClone(this.preflightState) : null; }
  /**
   * The reason a feature must wait, or null when the last preflight found the permissions it
   * needs. Before any preflight nothing is held: a hold is only ever placed on a verified fact.
   */
  permissionShortfall(feature: PermissionFeature): string | null {
    const report = this.preflightState;
    if (!report) return null;
    if (report.suspended) return `App ${report.app} installation is suspended; restore it at ${report.installationUrl}`;
    const shortfall = report.missing.find(entry => entry.features.includes(feature));
    return shortfall ? describeShortfall(shortfall, report.app, report.installationUrl) : null;
  }
  private async refreshToken() {
      const response = await fetch(`https://api.github.com/app/installations/${this.config.installationId}/access_tokens`, {
        method: 'POST', headers: this.appHeaders(), signal: AbortSignal.timeout(15_000),
      });
      this.record('/app/installations/access_tokens', response, false);
      const refused = await this.refusal(response, 'installation authentication');
      if (refused instanceof GitHubPermissionRefusal) this.authenticationRefusal = { until: Date.now() + 60_000, error: refused };
      if (refused) throw refused;
      this.authenticationRefusal = null;
      const result: any = await response.json();
      demand(typeof result.token === 'string' && result.token.length > 0 && Number.isFinite(Date.parse(result.expires_at)) && Date.parse(result.expires_at) > Date.now(), 'Invalid GitHub installation token response', 502);
      this.token = result.token; this.expires = Date.parse(result.expires_at);
      this.permissions = result.permissions && typeof result.permissions === 'object' ? result.permissions : {};
  }
  private async authenticate() {
    demand(Date.now() >= this.blockedUntil, `GitHub requests paused until ${new Date(this.blockedUntil).toISOString()} after a rate/access refusal`, 502);
    if (this.authenticationRefusal && Date.now() < this.authenticationRefusal.until) throw this.authenticationRefusal.error;
    if (this.expires < Date.now() + 60_000) {
      this.authentication ??= this.refreshToken().finally(() => { this.authentication = undefined; });
      await this.authentication;
    }
    demand(Date.now() >= this.blockedUntil, 'GitHub requests paused after a rate/access refusal', 502);
  }
  async reviewPermissions(): Promise<Record<string, string>> {
    try { await this.authenticate(); return { ...this.permissions }; } catch { return {}; }
  }
  async request(path: string, method = 'GET', body?: unknown): Promise<any> {
    return this.apiRequest(`/repos/${this.config.repository}${path}`, method, body);
  }
  private async apiRequest(path: string, method = 'GET', body?: unknown): Promise<any> {
    await this.authenticate();
    if (method === 'GET') await this.warm();
    const cached = method === 'GET' ? this.cache.get(path) : undefined;
    const started = Date.now(), bearer = this.token, token = tokenIdentity(bearer);
    let response: Response;
    try {
      response = await fetch(`https://api.github.com${path}`, {
        method, headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', ...(cached ? { 'If-None-Match': cached.etag } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      console.error(`GitHub ${method} ${path} failed after ${Date.now() - started} ms: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    // A slow request is named so a stalled observation can be traced to the call that held it.
    if (Date.now() - started > 5_000) console.error(`GitHub ${method} ${path} took ${Date.now() - started} ms (${response.status})`);
    this.meter(method, path, response, token);
    this.record(path, response, true, Date.now(), true, token);
    // A 304 costs no rate budget. Refresh the entry's recency so a full observation round stays cached.
    if (response.status === 304 && cached) { this.rateFailures = 0; this.cache.delete(path); this.cache.set(path, cached); this.persisted?.touch('etag', path); return structuredClone(cached.value); }
    const refused = await this.refusal(response, `${method} ${path}`);
    if (refused) throw refused;
    this.rateFailures = 0;
    const value = response.status === 204 ? null : await response.json();
    const etag = response.headers.get('etag');
    if (method === 'GET') {
      this.cache.delete(path);
      if (etag) {
        this.cache.set(path, { etag, value: structuredClone(value) });
        this.persisted?.put('etag', path, value, etag);
        if (this.cache.size > etagCacheEntries) this.cache.delete(this.cache.keys().next().value!);
      }
    }
    return value;
  }
  async reviewRepository(): Promise<{ id: number; fullName: string } | null> {
    // Every status read asks this; the installation's repository changes far more rarely than that.
    if (this.repositoryIdentity && Date.now() - this.repositoryIdentity.at < 10 * 60_000) return this.repositoryIdentity.value;
    const value = await this.readReviewRepository();
    this.repositoryIdentity = { at: Date.now(), value };
    return value;
  }
  private repositoryIdentity: { at: number; value: { id: number; fullName: string } | null } | null = null;
  private async readReviewRepository(): Promise<{ id: number; fullName: string } | null> {
    try {
      // Membership in the token's installation is stronger than public repository readability.
      for (let page = 1; page <= 100; page++) {
        const response = await this.apiRequest(`/installation/repositories?per_page=100&page=${page}`);
        demand(Array.isArray(response.repositories), 'Invalid installation repository inventory', 502);
        const repo = response.repositories.find((r: any) => typeof r.full_name === 'string' && r.full_name.toLowerCase() === this.config.repository.toLowerCase());
        if (repo) return Number.isSafeInteger(repo.id) && repo.id > 0 ? { id: repo.id, fullName: repo.full_name } : null;
        if (response.repositories.length < 100) return null;
      }
    } catch { /* Unknown scope must not advertise dispatch support. */ }
    return null;
  }
  async pages(path: string, field?: string): Promise<any[]> {
    const result: any[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = await this.request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const rows = field ? response[field] : response;
      demand(Array.isArray(rows), 'Unexpected GitHub response', 502);
      result.push(...rows);
      if (rows.length < 100) return result;
    }
    throw new Error('GitHub pagination exceeded safety limit; refusing incomplete evidence');
  }
  async protection(requireNativeReview = false) {
    return (await this.branchProtection(requireNativeReview)).protected;
  }
  /**
   * The managed branch's protection as the gates read it: whether it is the protection Graphyard
   * requires, and whether it requires every review conversation resolved before a merge (GY-139).
   * An unreadable protection is neither.
   */
  async branchProtection(requireNativeReview = false): Promise<{ protected: boolean; conversationResolution: boolean }> {
    try {
      const p = await this.request(`/branches/${encodeURIComponent(this.config.base)}/protection`);
      // `strict` must be off: a queued tip is deliberately behind the base branch, and the merge
      // queue supersedes that setting with a published tip that already contains its validated base.
      const verified = (!requireNativeReview || p.required_pull_request_reviews?.required_approving_review_count >= 1 && p.required_pull_request_reviews?.dismiss_stale_reviews && p.required_pull_request_reviews?.require_last_push_approval) && p.required_status_checks?.strict === false && !!p.enforce_admins?.enabled && !p.allow_force_pushes?.enabled && !p.allow_deletions?.enabled
        && p.required_status_checks.checks?.some((c: any) => c.context === CHECK_NAME && c.app_id === this.config.appId);
      return { protected: !!verified, conversationResolution: p.required_conversation_resolution?.enabled === true };
    } catch { return { protected: false, conversationResolution: false }; }
  }
  /**
   * One GraphQL query as the installation. GitHub answers a failed query with 200 and `errors`,
   * which is refused here; a `RATE_LIMITED` error pauses the client as a REST rate limit does.
   */
  async graphql(query: string, variables: Record<string, unknown>): Promise<any> {
    const response = await this.apiRequest('/graphql', 'POST', { query, variables });
    if (response?.errors?.some((error: any) => error?.type === 'RATE_LIMITED')) {
      this.backoff();
      throw new Refusal(`GitHub POST /graphql failed: rate limited; requests paused until ${new Date(this.blockedUntil).toISOString()}`, 502);
    }
    demand(!response?.errors?.length && response?.data, `GitHub GraphQL query failed: ${response?.errors?.map((error: any) => error?.message).join('; ') || 'no data returned'}`, 502);
    return response.data;
  }
  /**
   * Every unresolved review thread on the pull request, with the author of its first comment and
   * the path and line it is anchored to. REST exposes no resolution state, so this is the one
   * GraphQL read an observation makes, and only while protection still requires conversation
   * resolution: threads block no merge in Graphyard's gate (the reviewer's verdict does).
   */
  async unresolvedThreads(pr: number): Promise<ReviewThread[]> {
    const [owner, name] = this.config.repository.split('/');
    const threads: ReviewThread[] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const data = await this.graphql(reviewThreadsQuery, { owner, name, number: pr, after });
      const connection = data?.repository?.pullRequest?.reviewThreads;
      demand(Array.isArray(connection?.nodes), `GitHub did not list the review threads of pull request #${pr}`, 502);
      for (const thread of connection.nodes) {
        if (thread?.isResolved !== false) continue;
        const comment = thread.comments?.nodes?.[0];
        const line = Number.isSafeInteger(thread.line) ? thread.line : Number.isSafeInteger(thread.originalLine) ? thread.originalLine : null;
        threads.push({ ...(typeof thread.id === 'string' ? { id: thread.id } : {}), author: typeof comment?.author?.login === 'string' ? comment.author.login : 'an unknown author', ...(comment?.author?.__typename === 'Bot' ? { bot: true } : {}), path: typeof thread.path === 'string' ? thread.path : '(no path)', line, outdated: thread.isOutdated === true,
          ...(typeof comment?.url === 'string' ? { url: comment.url } : {}) });
      }
      if (!connection.pageInfo?.hasNextPage) return threads;
      after = connection.pageInfo.endCursor;
    }
    throw new Error('GitHub review thread pagination exceeded safety limit; refusing an incomplete list');
  }
  /**
   * The managed branch's head and its tree, read from `refs/heads/<base>`. A pull request's
   * `base.sha` is GitHub's cached view of the same ref, refreshed only when it recomputes the
   * pull request, and it is never used for the base tip: a binding decided against it was the
   * root cause of approvals dismissed for a merge base that had not actually changed.
   */
  async baseBranch(): Promise<{ tip: string; tree: string }> {
    const ref = await this.request(`/git/ref/heads/${this.config.base.split('/').map(encodeURIComponent).join('/')}`);
    const tip = ref?.object?.sha;
    demand(ref?.object?.type === 'commit' && typeof tip === 'string' && /^[a-f0-9]{40}$/.test(tip), `GitHub did not return a readable head for refs/heads/${this.config.base}`, 502);
    return { tip, tree: await this.commitTree(tip) };
  }
  /** Whether `head` contains `base` by ancestry, as GitHub's compare reports it. Ancestry between two commit SHAs never changes, so it is asked once. */
  async contains(base: string, head: string): Promise<boolean> {
    if (base === head) return true;
    const key = `${base}...${head}`;
    await this.warm();
    const known = /^[a-f0-9]{40}\.\.\.[a-f0-9]{40}$/.test(key) ? this.ancestry.get(key) : undefined;
    if (known !== undefined) { this.persisted?.touch('ancestry', key); return known; }
    const comparison = await this.request(`/compare/${base}...${head}?per_page=1`);
    demand(typeof comparison?.status === 'string', `GitHub did not compare ${base.slice(0, 12)} with ${head.slice(0, 12)}`, 502);
    const contained = comparison.status === 'ahead' || comparison.status === 'identical';
    if (/^[a-f0-9]{40}\.\.\.[a-f0-9]{40}$/.test(key)) {
      this.ancestry.set(key, contained);
      this.persisted?.put('ancestry', key, contained);
      if (this.ancestry.size > ancestryEntries) this.ancestry.delete(this.ancestry.keys().next().value!);
    }
    return contained;
  }
  /**
   * How many commits `head` holds that `base` does not. GitHub puts the changed-file list on the
   * first compare page whatever `per_page` says, so the second one-commit page is asked for: it
   * carries `ahead_by` and neither the file list nor more than one commit.
   */
  async aheadBy(base: string, head: string): Promise<number> {
    const comparison = await this.request(`/compare/${base}...${encodeURIComponent(head)}?per_page=1&page=2`);
    demand(typeof comparison?.ahead_by === 'number', `GitHub did not report how far ${head} is ahead of ${base.slice(0, 12)}`, 502);
    return comparison.ahead_by;
  }
  /**
   * The commits `head` holds that `base` does not, or null when GitHub's list is truncated and
   * ancestry must be asked per commit. Immutable for a pair of SHAs, so asked once.
   */
  async historySince(base: string, head: string): Promise<Set<string> | null> {
    const key = `${base}...${head}`;
    const pinned = /^[a-f0-9]{40}\.\.\.[a-f0-9]{40}$/.test(key);
    if (pinned) await this.warm();
    if (pinned && this.histories.has(key)) { this.persisted?.touch('history', key); return this.histories.get(key)!; }
    const shas = new Set<string>(); let total = 0;
    for (let page = 1; page <= 3; page++) {
      const comparison = await this.request(`/compare/${base}...${head}?per_page=100&page=${page}`);
      // No commit list means no shortcut: containment is then asked per commit, exactly as before.
      if (!Array.isArray(comparison?.commits) || !Number.isSafeInteger(comparison?.total_commits)) return null;
      total = comparison.total_commits;
      for (const commit of comparison.commits) if (typeof commit?.sha === 'string') shas.add(commit.sha);
      if (comparison.commits.length < 100 || shas.size >= total) break;
    }
    const result = shas.size >= total ? shas : null;
    if (pinned) { this.histories.set(key, result); this.persisted?.put('history', key, result); if (this.histories.size > historyEntries) this.histories.delete(this.histories.keys().next().value!); }
    return result;
  }
  /**
   * The pull request once GitHub has computed its mergeability (GY-548). GitHub answers `null`
   * right after the base branch moves and computes it lazily on request, so an open pull request
   * read as `null` is re-requested up to `mergeabilityRetries` times, `mergeabilityRetryMs` apart
   * (at most 10 seconds in all). Observation runs outside any coordination transaction, so the wait
   * holds no lock. A value still unknown after that is kept as unknown, never as not mergeable, and
   * is read again on the next observation.
   */
  private async computedMergeability(pr: any): Promise<any> {
    for (let attempt = 0; attempt < mergeabilityRetries && pr.mergeable === null && pr.state === 'open' && !pr.merged; attempt++) {
      await delay(this.mergeabilityRetryMs);
      pr = await this.request(`/pulls/${pr.number}`);
    }
    return pr;
  }
  /** The base a published speculative tip was built on, when the head is that tip; otherwise null. */
  private speculativeBase(work: Work, headSha: string): string | null {
    const speculation = work.queue?.speculation;
    return speculation && speculation.tip === headSha && speculation.policyRevision === work.policyRevision ? speculation.base : null;
  }
  /**
   * The base a candidate is legitimately bound to, for the guards that run between observations.
   * A published speculative tip carries the base it was built on, and the managed branch advances
   * underneath it while the entries ahead of it land, so the live branch head is not that binding.
   * Neither is it the binding of a candidate whose head Graphyard has not yet brought onto a
   * branch that moved: somebody else's merge did not change the tree this one was reviewed and
   * proved on, so the bound base is held. Deciding that needs an ancestry comparison, so it is
   * decided in `observe` and only re-read here, for exactly the head and branch head it decided
   * on. Every other candidate binds to the live head.
   */
  private boundBase(work: Work, pr: any, branch: { tip: string }): string {
    const speculative = this.speculativeBase(work, pr.head.sha);
    if (speculative) return speculative;
    const observation = work.observation;
    const held = observation && observation.candidate.sha === pr.head.sha && observation.baseTip === branch.tip
      && heldBase(work, pr.head.sha, branch.tip) === observation.candidate.baseSha ? observation.candidate.baseSha : null;
    return held ?? branch.tip;
  }
  /**
   * `peers` is every work item as the caller read it. It is what lets the landing check see other
   * items' unlanded candidates in this head's history, and name the merge that took a delivery
   * off the base branch; without it those two answers are left out, never guessed.
   */
  async observe(work: Work, peers?: Work[]): Promise<Observation> {
    const startedAt = new Date().toISOString();
    const pr = await this.computedMergeability(await this.request(`/pulls/${work.submission!.pr}`));
    demand(pr.base.repo.full_name.toLowerCase() === this.config.repository.toLowerCase() && pr.head.repo?.full_name.toLowerCase() === this.config.repository.toLowerCase(), 'MVP requires same-repository pull requests');
    demand(pr.base.ref === this.config.base, 'Pull request targets an unmanaged branch');
    const [checks, reviews, protection, files, branch] = await Promise.all([
      this.pages(`/commits/${pr.head.sha}/check-runs?filter=all`, 'check_runs'), this.pages(`/pulls/${pr.number}/reviews`), this.branchProtection(nativeReviewRequired(work.policy)), this.pages(`/pulls/${pr.number}/files`), this.baseBranch(),
    ]);
    // Review threads are never a merge blocker in Graphyard's gate: the reviewer reads them itself
    // at launch and judges them in its verdict. The observation spends its one GraphQL read on them
    // only while protection still requires conversation resolution (drift, which GitHub enforces).
    const conversations = { required: protection.conversationResolution, unresolved: protection.conversationResolution && !pr.merged && pr.state === 'open' ? await this.unresolvedThreads(pr.number) : [] };
    const latest = new Map<string, any>();
    for (const r of reviews) if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) latest.set(r.user.login, r);
    // A dismissed review is recorded with GitHub's reason for dismissing it and the head it was
    // given on (GY-127): the review list alone cannot tell a reviewer withdrawing a verdict from
    // GitHub withdrawing an approval because the merge base moved under an unchanged head.
    const dismissals = [...latest.values()].some(r => r.state === 'DISMISSED') ? await this.reviewDismissals(pr.number) : { read: new Map<number, ReviewDismissal>(), unread: null as string | null, forcePushes: [] as HeadForcePush[] };
    const dismissalOf = (id: number): ReviewDismissal | undefined => dismissals.read.get(id) ?? (dismissals.unread ? { reason: null, mergeBase: false, verdict: null, commit: null, at: null, by: null, unread: dismissals.unread } : undefined);
    // A published speculative tip carries its own validated base. The candidate stays bound to
    // that exact commit while the managed branch advances underneath it through queue merges. A
    // head that already contains the branch tip is up to date and binds to it, as it always did.
    // A head that does not holds the base it was bound to while Graphyard brings it onto the new
    // one — but only while the managed branch still contains that commit. A rewind is not an
    // advance: the binding is given up and the candidate rebinds to the live head.
    const speculative = this.speculativeBase(work, pr.head.sha);
    const contained = pr.merged || await this.contains(branch.tip, pr.head.sha);
    const holding = speculative || contained ? null : heldBase(work, pr.head.sha, branch.tip);
    const bound = speculative ?? (holding && await this.contains(holding, branch.tip) ? holding : branch.tip);
    // Out-of-scope files are compared with the bound base: the predicted base already contains
    // every queued predecessor, so their changes on a speculative tip are not this candidate's.
    const scopeFiles = await this.compareScope(work.plannedFiles ?? [], files, bound);
    // The bound base is held while the head is unchanged, so the same comparison is made where
    // the merge would land, on every observation of an open candidate (GY-97). A merged pull
    // request is judged the other way round: whether the base branch still holds what it shipped.
    const budget = { remaining: scopeLookupBudget };
    const landing = pr.merged || pr.state !== 'open' ? undefined : await this.landingCheck(work, pr.head.sha, files, bound, speculative, branch, peers, budget);
    const revertedDelivery = pr.merged && work.stage !== 'done' ? await this.revertedDelivery(work, pr, files, branch, peers, budget) : undefined;
    // What the base changed since the bound base: an optimistic merge (GY-500) needs it disjoint from the head's own files.
    const baseChanges = pr.merged || pr.state !== 'open' ? undefined : await this.baseChangesSince(bound, branch.tip);
    const candidateBase = pr.merged && work.candidate && work.candidate.sha === pr.head.sha ? work.candidate.baseSha : bound;
    // A head contains the base tip by ancestry, or as a published tip whose bound base is the
    // tip's tree-identical predecessor, or as a published tip behind other queue entries, whose
    // chain rests on the base branch by publication; the placement reports whether it still does.
    const speculation = work.queue?.speculation;
    const publishedTip = !!speculation && speculation.tip === pr.head.sha && speculation.policyRevision === work.policyRevision;
    const baseTipContained = contained || publishedTip && (speculation!.baseTree === branch.tree || speculation!.predecessors.length > 0);
    const provider = reviewProviderOf(work.policy);
    const unready = !pr.merged && (pr.state !== 'open' || pr.draft !== false)
      ? pr.draft ? 'Pull request is draft; mark it ready to request code review' : 'Pull request is not open; reopen it to request code review' : null;
    const agentReview = !work.policy.review || provider === 'github' ? undefined
      : provider === 'codex' ? unready
        ? { provider: 'codex' as const, sha: pr.head.sha, approved: false, reason: unready }
        : await observeCodex(this, pr.number, pr.head.sha, reviews, pr.user.id, work.reviewRequest, candidateBase, work.policyRevision, this.config.appId)
      : await this.observeAgent(work, pr, reviews, candidateBase, unready);
    const confirmed = await this.request(`/pulls/${work.submission!.pr}`);
    demand(confirmed.head.sha === pr.head.sha && confirmed.base.sha === pr.base.sha && confirmed.base.ref === pr.base.ref && confirmed.head.ref === pr.head.ref
      && confirmed.state === pr.state && confirmed.draft === pr.draft && confirmed.merged === pr.merged, 'PR changed while collecting evidence; retry');
    return {
      candidate: { sha: pr.head.sha, baseSha: candidateBase, pr: pr.number, branch: pr.head.ref, author: pr.user.login, ...(Number.isFinite(Date.parse(pr.created_at)) ? { createdAt: pr.created_at } : {}) },
      // Canonical oldest-to-newest ordering makes legacy consumers deterministic;
      // gates also compare immutable run IDs rather than trusting response order.
      checks: checks.filter(c => c.name !== CHECK_NAME).sort((a, b) => (a.id ?? 0) - (b.id ?? 0)).map(c => ({ name: c.name, result: c.status === 'completed' ? c.conclusion : c.status, appId: c.app.id,
        ...(Number.isSafeInteger(c.id) ? { id: c.id } : {}), ...(Number.isSafeInteger(c.run_attempt) ? { attempt: c.run_attempt } : {}) })),
      ...(agentReview ? { agentReview } : {}),
      reviewIds: reviews.every(r => Number.isSafeInteger(r.id) && r.id > 0) ? reviews.map(r => r.id) : undefined,
      // Every review GitHub now reports dismissed, not only each identity's latest (GY-486): an
      // approval dismissed and then re-posted by the same identity is hidden behind the re-post in
      // `reviews`, and review-conflict.ts must still read it as withdrawn rather than standing.
      dismissedReviewIds: dismissedReviewIds(reviews),
      reviews: [...latest.values()].map(r => ({ id: r.id, reviewer: r.user.login, sha: r.commit_id, state: r.state, submittedAt: r.submitted_at,
        ...(r.state === 'DISMISSED' && dismissalOf(r.id) ? { dismissal: dismissalOf(r.id)! } : {}) })),
      prState: pr.state, draft: pr.draft, prCreatedAt: pr.created_at, merged: pr.merged, mergeSha: pr.merge_commit_sha, mergedAt: pr.merged_at, mergeable: pr.mergeable === true && !pr.draft && pr.state === 'open', conflicting: pr.mergeable === false && pr.state === 'open',
      ...(pr.mergeable === null && pr.state === 'open' && !pr.merged ? { mergeabilityUnknown: true } : {}),
      protected: protection.protected, conversations, files: files.map(f => f.filename), at: startedAt,
      baseTip: branch.tip, baseTree: branch.tree, baseTipContained, baseTipAncestor: contained, scopeFiles,
      ...(landing ? { landing } : {}), ...(revertedDelivery ? { revertedDelivery } : {}), ...(baseChanges !== undefined ? { baseChanges } : {}),
      ...(dismissals.forcePushes.length ? { headForcePushes: dismissals.forcePushes } : {}),
    };
  }
  /**
   * The commit the candidate would land on, and what landing there would revert (see
   * merge-queue.ts LandingCheck). A tip published behind entries that have not landed lands on
   * its predicted base, which is its bound base; everything else lands on the live branch head.
   * A base that differs from the bound one only by commit, not by tree, needs no second
   * comparison. The answer about carried candidates is reused while the head, the landing commit
   * and every open candidate it was decided against are unchanged.
   */
  private async landingCheck(work: Work, head: string, files: any[], bound: string, speculative: string | null, branch: { tip: string; tree: string }, peers: Work[] | undefined, budget: { remaining: number }): Promise<LandingCheck> {
    const speculation = work.queue?.speculation;
    const predicted = !!speculative && speculative !== branch.tip && speculation!.baseTree !== branch.tree && speculation!.predecessors.length > 0 && await this.contains(branch.tip, speculative);
    const base = predicted ? speculative! : branch.tip;
    const sameTree = base === bound || !!speculative && speculation!.baseTree === branch.tree;
    // The pull request's own diff is taken against the live branch, which does not hold the
    // entries ahead yet: a file one of them adds and this head drops appears in it nowhere. What
    // landing on a predicted base does is that base compared with the head that contains it.
    const landed = predicted ? await this.landingDiff(base, head) : sameTree ? null : files;
    const landing: LandingCheck = { base, ...(landed ? { files: await this.compareScope(work.plannedFiles ?? [], landed, base, budget) } : {}) };
    if (!peers) return landing;
    const open = peers.filter(peer => peer.id !== work.id && peer.stage !== 'done' && !!peer.submission && !!peer.candidate && peer.candidate.sha !== head
      && !!peer.observation && !peer.observation.merged && peer.observation.prState !== 'closed' && peer.observation.candidate.sha === peer.candidate.sha);
    // A peer is in this head's history by its current head, or by the reviewed head under a tip
    // of its own: the tip a queue republishes changes, the reviewed head under it does not.
    landing.examined = open.map(peer => `${peer.key}@${ownHeads(peer).join('+')}`).sort();
    const previous = work.observation && work.observation.candidate.sha === head ? work.observation.landing : undefined;
    if (previous?.carried && previous.foreign && previous.base === base && JSON.stringify(previous.examined) === JSON.stringify(landing.examined) && !previous.carried.some(entry => entry.unverified)) return { ...landing, carried: previous.carried, foreign: previous.foreign };
    const carried: CarriedCandidate[] = [];
    const foreign: ForeignCandidate[] = [];
    // The entries ahead are in a predicted base by construction, so their files standing in this
    // head as they stand there is the ordinary state of a queued tip and says nothing: two entries
    // ahead that both change one file leave it merged in the tip behind them. What such a tip would
    // really take from them is a change to the base it lands on, which `files` compares above —
    // every drop of theirs is a removal or a modification in `base...head`. So they are judged
    // there, and `carried` judges the candidates the landing commit does not hold.
    const ahead = new Set(predicted ? speculation!.predecessors : []);
    // One compare per peer, asked a few at a time: asked in turn they held an observation past the
    // merge window's 25 seconds, so a candidate with many open peers could never be authorized in time.
    // One compare lists what the head adds over the base; a peer head is in the head's history when it
    // is on that list, or else only when the base itself holds it — a question every candidate on the
    // same base shares. Asked per peer against each head, this was ~N² compares per observation round.
    const added = await this.historySince(base, head);
    const containment = await boundedMap(open, peerContainmentConcurrency, async peer => {
      if (ahead.has(peer.key)) return false;
      for (const sha of ownHeads(peer)) {
        if (!added) { if (await this.contains(sha, head)) return true; continue; }
        if (added.has(sha)) return true;
        if (await this.contains(sha, base) && await this.contains(sha, head)) return true;
      }
      return false;
    });
    for (const [index, peer] of open.entries()) {
      if (!containment[index]) continue;
      foreign.push({ key: peer.key, pr: peer.candidate!.pr, head: peer.candidate!.sha });
      const entry: CarriedCandidate = { key: peer.key, pr: peer.candidate!.pr, head: peer.candidate!.sha, dropped: [] };
      for (const file of peer.observation!.scopeFiles ?? []) {
        // A file this item planned is its own to change, whoever else touched it.
        if (inPlannedScope(work.plannedFiles ?? [], file.path)) continue;
        if ((budget.remaining -= 2) < 0) { entry.unverified = true; break; }
        const held = await this.blobAt(file.path, head);
        if (file.status !== 'removed' && held === file.sha) continue;
        // Neither the owner's version nor anything new: exactly what the landing commit holds, so
        // the owner's change is in this head's history and absent from its tree.
        if (held !== await this.blobAt(file.path, base) || file.status === 'removed' && held === null) continue;
        entry.dropped.push({ path: file.path, detail: held === null ? 'the file is absent from this head and from the commit it would land on' : 'the file is held exactly as the commit it would land on holds it' });
      }
      if (entry.dropped.length || entry.unverified) carried.push(entry);
    }
    return { ...landing, carried, foreign };
  }
  /** True when the commit took the path from the content the pull request delivered: one of its parents still holds that exact blob. */
  private async revertsDelivered(commit: string, path: string, files: any[]): Promise<boolean> {
    const delivered = files.find(file => file.filename === path)?.sha;
    const detail = await this.request(`/commits/${commit}`);
    for (const parent of Array.isArray(detail?.parents) ? detail.parents : []) if (typeof parent?.sha === 'string' && await this.blobAt(path, parent.sha) === delivered) return true;
    return false;
  }
  /** The provider's file records for `base...head`; a list at the cap ends with a record nothing was compared for, which the guard refuses. */
  private async landingDiff(base: string, head: string): Promise<any[]> {
    const comparison = await this.request(`/compare/${base}...${head}`);
    demand(Array.isArray(comparison?.files), `GitHub did not list the files changed between ${base.slice(0, 12)} and ${head.slice(0, 12)}`, 502);
    return comparison.files.length < compareFileCap ? comparison.files
      : [...comparison.files, { filename: `(the comparison lists ${compareFileCap} files or more; the rest were not compared)`, status: 'unchanged', additions: 0, deletions: 0, uncompared: true }];
  }
  /**
   * Whether the base branch holds what a merged pull request shipped (GY-97). A file is missing
   * when the branch head holds it exactly as the base held it before the merge — or not at all —
   * rather than as the pull request left it; a file somebody changed afterwards is not. The merge
   * that removed it is found from the branch's own history of the path when the content was once
   * on the branch, accepted only if that commit took the path from the delivered content — a
   * parent of it holds that exact blob — and otherwise among the merged candidates whose head carried this one:
   * the merge that made the provider record this pull request merged. Asked again only when the
   * branch head moves.
   */
  private async revertedDelivery(work: Work, pr: any, files: any[], branch: { tip: string }, peers: Work[] | undefined, budget: { remaining: number }): Promise<RevertedDelivery | undefined> {
    const previous = work.observation && work.observation.candidate.sha === pr.head.sha && work.observation.merged ? work.observation.revertedDelivery : undefined;
    if (previous && previous.base === branch.tip && !previous.partial && (previous.removedBy || !peers)) return previous;
    const missing: RevertedDelivery['files'] = []; let partial = false;
    for (const file of files) {
      if (file.status === 'removed' || typeof file.sha !== 'string') continue;
      if ((budget.remaining -= 2) < 0) { partial = true; break; }
      const held = await this.blobAt(file.filename, branch.tip);
      if (held === file.sha || held !== await this.blobAt(file.filename, pr.base.sha)) continue;
      missing.push({ path: file.filename, detail: held === null ? 'absent from the base branch' : 'held as it was before this merge' });
    }
    if (!missing.length) return undefined;
    const owner = (number: number) => peers?.find(peer => peer.submission?.pr === number)?.key ?? null;
    let removedBy: RevertedDelivery['removedBy'] = null;
    // Naming the merge is naming a work item, so it is asked only by a caller that brought them.
    if (!peers) return { base: branch.tip, files: missing, removedBy: null, ...(partial ? { partial } : {}) };
    const history = await this.request(`/commits?sha=${branch.tip}&path=${encodeURIComponent(missing[0].path)}&per_page=1`);
    const commit = Array.isArray(history) && typeof history[0]?.sha === 'string' ? history[0].sha as string : null;
    if (commit && commit !== pr.head.sha && await this.revertsDelivered(commit, missing[0].path, files)) {
      const pulls = await this.request(`/commits/${commit}/pulls`);
      const merged = Array.isArray(pulls) ? pulls.find((entry: any) => entry?.merged_at && entry.number !== pr.number && entry.base?.ref === this.config.base) : null;
      if (merged) removedBy = { key: owner(merged.number), pr: merged.number, mergeSha: merged.merge_commit_sha ?? null, commit };
    }
    for (const peer of removedBy ? [] : peers ?? []) {
      if (peer.id === work.id || !peer.observation?.merged || !peer.candidate || peer.candidate.sha === pr.head.sha || !await this.contains(pr.head.sha, peer.candidate.sha)) continue;
      removedBy = { key: peer.key, pr: peer.candidate.pr, mergeSha: peer.observation.mergeSha ?? null, commit: null }; break;
    }
    return { base: branch.tip, files: missing, removedBy, ...(partial ? { partial } : {}) };
  }
  /**
   * The provider's PR diff is taken against the merge base. The regression guard needs every
   * file outside the planned scope compared with the commit the candidate is bound to (the base
   * branch tip, or the predicted base of a published speculative tip), so those paths are looked
   * up there by blob identity. Paths beyond the lookup budget stay uncompared, which the guard
   * refuses rather than passes.
   */
  private async compareScope(plannedFiles: string[], files: any[], base: string, budget = { remaining: scopeLookupBudget }): Promise<ScopeFile[]> {
    // Lookups are granted from the budget in file order, exactly as when they ran one at a time,
    // then asked a few at a time: in turn they held a final merge verification past its window.
    const wanted: { entry: ScopeFile; field: 'baseSha' | 'previousBaseSha'; path: string }[] = [];
    const compared: ScopeFile[] = [];
    for (const file of files) {
      const status: ScopeFile['status'] = ['added', 'modified', 'removed', 'renamed', 'copied', 'changed', 'unchanged'].includes(file.status) ? file.status : 'modified';
      const previousPath = typeof file.previous_filename === 'string' && file.previous_filename !== file.filename ? file.previous_filename : undefined;
      const entry: ScopeFile = { path: file.filename, status, ...(previousPath ? { previousPath } : {}),
        sha: status !== 'removed' && typeof file.sha === 'string' && /^[a-f0-9]{40}$/.test(file.sha) ? file.sha : null,
        additions: Number.isSafeInteger(file.additions) ? file.additions : 0, deletions: Number.isSafeInteger(file.deletions) ? file.deletions : 0, binary: typeof file.patch !== 'string' };
      if (!file.uncompared && !inPlannedScope(plannedFiles, entry.path) && budget.remaining-- > 0) wanted.push({ entry, field: 'baseSha', path: entry.path });
      if (previousPath && status === 'renamed' && !inPlannedScope(plannedFiles, previousPath) && budget.remaining-- > 0) wanted.push({ entry, field: 'previousBaseSha', path: previousPath });
      compared.push(entry);
    }
    const found = await boundedMap(wanted, peerContainmentConcurrency, want => this.blobAt(want.path, base));
    wanted.forEach((want, index) => { want.entry[want.field] = found[index]; });
    return compared;
  }
  /** Blob identity of a path at a ref, or null when the ref holds no file there. */
  async blobAt(path: string, ref: string): Promise<string | null> {
    // A path's blob at a commit SHA never changes, so it is asked of GitHub once.
    const pinned = /^[a-f0-9]{40}$/.test(ref) ? `${ref}:${path}` : null;
    if (pinned) await this.warm();
    if (pinned && this.blobs.has(pinned)) { this.persisted?.touch('blob', pinned); return this.blobs.get(pinned)!; }
    const found = await this.readBlob(path, ref);
    if (pinned) { this.blobs.set(pinned, found); this.persisted?.put('blob', pinned, found); if (this.blobs.size > ancestryEntries) this.blobs.delete(this.blobs.keys().next().value!); }
    return found;
  }
  private async readBlob(path: string, ref: string): Promise<string | null> {
    let entry: any;
    try { entry = await this.request(`/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`); }
    catch (error) { if (error instanceof Refusal && /\(404\)/.test(error.message)) return null; throw error; }
    if (Array.isArray(entry) || entry?.type === 'dir') return null;
    demand(typeof entry?.sha === 'string' && /^[a-f0-9]{40}$/.test(entry.sha), `GitHub did not return a readable blob for ${path} at ${ref}`, 502);
    return entry.sha;
  }
  async verify(work: Work, peers?: Work[]): Promise<Observation> {
    const first = await this.observe(work, peers);
    const second = await this.observe(work, peers);
    const gates = (o: Observation) => JSON.stringify({ candidate: o.candidate, checks: o.checks, reviews: o.reviews, agentReview: o.agentReview, protected: o.protected, conversations: o.conversations, merged: o.merged, mergeable: o.mergeable, conflicting: o.conflicting || undefined, mergeabilityUnknown: o.mergeabilityUnknown || undefined, prState: o.prState, draft: o.draft, scopeFiles: o.scopeFiles, landing: o.landing });
    demand(gates(first) === gates(second), 'GitHub gates changed during final verification; retry');
    return second;
  }
  /** Resolve a policy profile to the numeric App identity registered with this control plane. */
  reviewerAppFor(profile: ReviewerProfile | null | undefined): ReviewerApp | undefined {
    if (!profile) return undefined;
    const app = (this.config.reviewerApps ?? []).find(entry => entry.id === profile.reviewerApp && entry.runtime === profile.runtime);
    return app && app.appId !== this.config.appId ? app : undefined;
  }
  private async observeAgent(work: Work, pr: any, reviews: any[], candidateBase: string, unready: string | null) {
    const profile = reviewerProfileFor(work);
    const app = this.reviewerAppFor(profile);
    if (!profile) return { provider: 'agent' as const, sha: pr.head.sha, approved: false,
      reason: 'Every configured reviewer profile is exhausted for this candidate; add reviewer capacity or select another review provider' };
    if (!app) return { provider: 'agent' as const, sha: pr.head.sha, approved: false, profile: profile.name, reviewerApp: profile.reviewerApp,
      reason: `Reviewer App ${profile.reviewerApp} is not registered with this control plane as an independent ${profile.runtime} reviewer identity` };
    if (unready) return { provider: 'agent' as const, sha: pr.head.sha, approved: false, profile: profile.name, reviewerApp: app.id, reason: unready };
    return observeAgentReview(this, pr.number, pr.head.sha, reviews, pr.user.id, work.reviewRequest, candidateBase, work.policyRevision, this.config.appId, profile, app);
  }
  /**
   * A review is requested for any head that merges cleanly against the current base, contained or
   * not: the merge queue integrates and re-tests the combined tip before merging (GY-191). A head
   * behind the base that GitHub does not report mergeable is refused before any write; it goes back
   * to its worker for a sync.
   */
  private reviewable(work: Work) {
    demand(!behindBaseHold(work), `Candidate ${work.candidate?.sha.slice(0, 12)} does not contain the base branch tip ${work.observation?.baseTip?.slice(0, 12)} and does not merge cleanly with it; a review of it would judge a diff the sync will change, so none is requested until it does`);
  }
  async requestAgentReview(work: Work, profile: ReviewerProfile, app: ReviewerApp, beforeWrite: () => Promise<void>): Promise<ReviewRequest> {
    demand(work.candidate && work.policy.review && reviewProviderOf(work.policy) === 'agent', 'Candidate with agent review policy required');
    demand(app.id === profile.reviewerApp && app.runtime === profile.runtime, 'Reviewer profile does not match its registered App identity');
    demand(app.appId !== this.config.appId, 'The Graphyard control-plane App cannot be dispatched as a reviewer');
    demand((work.policy.reviewerProfiles ?? []).some(configured => configured.name === profile.name && configured.reviewerApp === profile.reviewerApp), 'Reviewer profile is not configured on this policy');
    this.reviewable(work);
    const pr = await this.request(`/pulls/${work.candidate.pr}`);
    requireCurrent(pr.head.sha === work.candidate.sha && this.boundBase(work, pr, await this.baseBranch()) === work.candidate.baseSha && pr.state === 'open' && pr.draft === false, 'PR changed before review dispatch; retry');
    demand(pr.user?.id !== app.botUserId, 'Reviewer identity must be independent of the pull request author');
    const marker = randomUUID();
    const body = `${profile.mention ? `${profile.mention} review\n\n` : ''}Graphyard requests an independent code review from reviewer profile \`${profile.name}\` (runtime \`${profile.runtime}\`).

Review head \`${work.candidate.sha}\` against base \`${work.candidate.baseSha}\` and post exactly one verdict comment through the registered reviewer GitHub App \`${app.id}\`, containing one line:

\`<!-- graphyard-verdict:${marker} head:${work.candidate.sha} verdict:approved -->\`

Use \`verdict:changes-requested\` with the findings, or \`verdict:usage-limit\` when the runtime has no remaining quota so Graphyard can fail over to the next configured profile.

<!-- graphyard-review:${marker} provider:agent profile:${profile.name} reviewer-app:${app.id} head:${work.candidate.sha} base:${work.candidate.baseSha} policy:${work.policyRevision} -->`;
    await beforeWrite();
    const comment = await this.request(`/issues/${work.candidate.pr}/comments`, 'POST', { body });
    demand(comment.performed_via_github_app?.id === this.config.appId && comment.user?.type === 'Bot' && comment.body === body && Number.isSafeInteger(comment.id) && Number.isFinite(Date.parse(comment.created_at)), 'Review dispatch did not return an authenticated Graphyard comment', 502);
    return { commentId: comment.id, sha: work.candidate.sha, baseSha: work.candidate.baseSha, policyRevision: work.policyRevision, body,
      createdAt: comment.created_at, provider: 'agent', profile: profile.name, reviewerApp: app.id, marker };
  }
  async requestCodex(work: Work, beforeWrite: () => Promise<void>): Promise<ReviewRequest> {
    demand(work.candidate && work.policy.review && work.policy.reviewProvider === 'codex', 'Candidate with Codex review policy required');
    this.reviewable(work);
    const pr = await this.request(`/pulls/${work.candidate.pr}`);
    requireCurrent(pr.head.sha === work.candidate.sha && this.boundBase(work, pr, await this.baseBranch()) === work.candidate.baseSha && pr.state === 'open' && pr.draft === false, 'PR changed before review dispatch; retry');
    const body = `@codex review\n\n<!-- graphyard-review:${randomUUID()} head:${work.candidate.sha} base:${work.candidate.baseSha} policy:${work.policyRevision} -->`;
    await beforeWrite();
    const comment = await this.request(`/issues/${work.candidate.pr}/comments`, 'POST', { body });
    demand(comment.performed_via_github_app?.id === this.config.appId && comment.user?.type === 'Bot' && comment.body === body && Number.isSafeInteger(comment.id) && Number.isFinite(Date.parse(comment.created_at)), 'Review dispatch did not return an authenticated Graphyard comment', 502);
    return { commentId: comment.id, sha: work.candidate.sha, baseSha: work.candidate.baseSha, policyRevision: work.policyRevision, body, createdAt: comment.created_at };
  }
  /**
   * The published tip's own tree, or undefined when it could not be read. Read after the tip is
   * published and never allowed to fail it: the tree is what lets the entry behind this one tell a
   * prediction that moved only in sha from one that brings content (GY-100), and an entry that
   * cannot be told either way is republished as it was before, which costs a review round rather
   * than a delivery.
   */
  private async tipTree(tip: string): Promise<string | undefined> {
    return this.commitTree(tip).catch(() => undefined);
  }
  /**
   * Why GitHub dismissed each dismissed review of a pull request, from the issue timeline's
   * `review_dismissed` events, keyed by review id. The verdict the dismissed review carried is
   * read from the event too (`dismissed_review.state`): the review list reports a dismissed
   * change request and a dismissed approval with the same `DISMISSED` state, and only the latter
   * is an approval anyone can restore. The timeline's `head_ref_force_pushed` events are read in
   * the same pass (GY-519): with the dismissal's own actor they show whether the control plane's
   * App dismissed its own republication, which is the one dismissal a replaced tip's approval may
   * be restored from. A timeline that cannot be read leaves the dismissal recorded as unread
   * rather than failing the observation: the review gate already refuses a dismissed approval, and
   * nothing is inferred from a reason nobody could read.
   */
  async reviewDismissals(pr: number): Promise<{ read: Map<number, ReviewDismissal>; unread: string | null; forcePushes: HeadForcePush[] }> {
    const read = new Map<number, ReviewDismissal>();
    const forcePushes: HeadForcePush[] = [];
    let login: string | null = null;
    try { login = await this.controlPlaneLogin(); } catch { login = null; }
    const byApp = (actor: unknown) => typeof actor === 'string' && !!login && actor.toLowerCase() === login.toLowerCase();
    try {
      for (const event of await this.pages(`/issues/${pr}/timeline`)) {
        if (event?.event === 'review_dismissed' && Number.isSafeInteger(event?.dismissed_review?.review_id)) {
          const reason = typeof event.dismissed_review.dismissal_message === 'string' ? event.dismissed_review.dismissal_message : null;
          const by = typeof event.actor?.login === 'string' ? event.actor.login : null;
          read.set(event.dismissed_review.review_id, { reason, mergeBase: !!reason && mergeBaseDismissalPattern.test(reason), verdict: dismissedVerdict(event.dismissed_review.state),
            commit: typeof event.dismissed_review.dismissal_commit_id === 'string' ? event.dismissed_review.dismissal_commit_id : null,
            at: typeof event.created_at === 'string' ? event.created_at : null, by, ...(by ? { byApp: byApp(by) } : {}) });
        }
        if (event?.event === 'head_ref_force_pushed') forcePushes.push({ at: typeof event.created_at === 'string' ? event.created_at : null,
          by: typeof event.actor?.login === 'string' ? event.actor.login : null, byApp: byApp(event.actor?.login),
          before: typeof event.before === 'string' ? event.before : null, after: typeof event.after === 'string' ? event.after : null });
      }
    } catch (error) {
      return { read, unread: error instanceof Error ? error.message : 'the pull request timeline could not be read', forcePushes };
    }
    return { read, unread: null, forcePushes };
  }
  /**
   * The item's own reviewed head under a branch head (GY-127): the last commit a worker pushed or
   * the control plane brought onto the base, found by walking first parents through this item's
   * own speculative-tip merges. The record names it for a tip the queue published; the walk reads
   * GitHub's account of each commit for a tip built before the record did, or over a tip. A base
   * refresh or a branch restore is landed content and is kept.
   *
   * A commit is stepped past only when it is provably one of this item's own tips: a tip the
   * queue history recorded, or a commit GitHub attributes to the control-plane App that carries
   * the tip message. A message alone proves nothing — any worker can write it — and a commit the
   * walk stops at is kept, so its content is in every tip built from it. The walk decides what a
   * tip is built from, never what carries onto it: the carry refuses an approval that was not
   * given on the head the walk returned (see Engine.decideTipCarry).
   */
  async ownReviewedHead(work: Work, head: string): Promise<string> {
    const speculation = work.queue?.speculation;
    let sha = speculation?.tip === head ? speculation.reviewedHead ?? speculation.merge?.from ?? head : head;
    const marker = new RegExp(`^Graphyard speculative tip for ${work.key.replace(/[^A-Za-z0-9-]/g, '')} behind `, 'i');
    const recorded = new Map((work.queueHistory ?? []).filter(entry => entry.event === 'predicted' && entry.tip && entry.from && entry.from !== entry.tip).map(entry => [entry.tip!, entry.from!]));
    const login = await this.controlPlaneLogin();
    for (let hops = 0; hops < 25; hops++) {
      const from = recorded.get(sha);
      if (from) { sha = from; continue; }
      const commit = await this.request(`/commits/${sha}`);
      const first = Array.isArray(commit?.parents) ? commit.parents[0]?.sha : undefined;
      if (!marker.test(typeof commit?.commit?.message === 'string' ? commit.commit.message : '') || !appAuthored(commit, login) || typeof first !== 'string' || !/^[a-f0-9]{40}$/.test(first)) return sha;
      sha = first;
    }
    return sha;
  }
  /** Moves a pull-request branch to a commit the control plane chose; the branch is unprotected and the move is deliberate. */
  async updateBranch(branch: string, sha: string) {
    await this.request(`/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, 'PATCH', { sha, force: true });
  }
  async commitTree(sha: string): Promise<string> {
    const commit = await this.request(`/commits/${sha}`);
    const tree = commit?.commit?.tree?.sha;
    demand(typeof tree === 'string' && /^[a-f0-9]{40}$/.test(tree), `GitHub did not return a readable tree for ${sha}`, 502);
    return tree;
  }
  /** The control-plane App's own bot login, the only author a carried tip may have. */
  async controlPlaneLogin(): Promise<string> {
    if (!this.appSlug) {
      const verified = this.preflightState?.verifiedAt ? this.preflightState.app : null;
      this.appSlug = verified && verified !== String(this.config.appId) ? verified : await this.appSlugFromApi();
    }
    return `${this.appSlug}[bot]`;
  }
  private async appSlugFromApi(): Promise<string> {
    const response = await fetch('https://api.github.com/app', { headers: this.appHeaders(), signal: AbortSignal.timeout(15_000) });
    this.record('/app', response, false);
    const refused = await this.refusal(response, 'GET /app');
    if (refused) throw refused;
    const app: any = await response.json();
    demand(typeof app?.slug === 'string' && /^[a-z0-9-]+$/i.test(app.slug), 'GitHub did not return the control-plane App slug', 502);
    return app.slug;
  }
  /**
   * Every path that differs between two commits, including both ends of a rename, or null when
   * the list may be truncated: a carry decided on an incomplete list would be a guess. GitHub
   * paginates the comparison's commits only; the files come on the first page alone and stop at
   * compareFileCap, so a list that reaches the cap cannot be told from a longer one and is refused.
   */
  async changedFiles(from: string, to: string): Promise<string[] | null> {
    if (from === to) return [];
    const comparison = await this.request(`/compare/${from}...${to}`);
    const files = comparison?.files;
    demand(Array.isArray(files), `GitHub did not list the files changed between ${from.slice(0, 12)} and ${to.slice(0, 12)}`, 502);
    if (files.length >= compareFileCap) return null;
    const paths = (listed: any[]) => listed.flatMap((file: any) => [file.filename, ...(typeof file.previous_filename === 'string' ? [file.previous_filename] : [])]).filter((path: unknown): path is string => typeof path === 'string');
    // A comparison lists what `to` changed against the merge base. A predicted base that moved
    // backwards or sideways — the entry between this one and its new base was ejected — has changes
    // on the `from` side too, and a tip rebuilt onto it no longer holds them; both sides are listed.
    if (comparison.status === 'behind' || comparison.status === 'diverged') {
      const reverse = await this.request(`/compare/${to}...${from}`);
      demand(Array.isArray(reverse?.files), `GitHub did not list the files changed between ${to.slice(0, 12)} and ${from.slice(0, 12)}`, 502);
      if (reverse.files.length >= compareFileCap) return null;
      return [...new Set([...paths(files), ...paths(reverse.files)])];
    }
    return [...new Set(paths(files))];
  }
  /**
   * The patch-id of `head`'s own change: GitHub's compare of it against its merge base with
   * `base` (a three-dot compare). Null when there is no change of its own to read, or when GitHub
   * could not list it completely or at all: the carry then falls back to the files rule.
   */
  async diffPatchId(base: string, head: string): Promise<string | null> {
    if (base === head) return null;
    try { return patchId((await this.request(`/compare/${base}...${head}`))?.files); }
    catch { return null; }
  }
  /**
   * How GitHub describes the tip Graphyard's merge produced: parents, author, whether the author is
   * this App, and the change's own diff on each side of the merge (GY-330) — the reviewed head
   * against the base it was bound to, and the tip against the base it was merged onto.
   */
  private async describeMerge(from: string, tip: string, boundBase: string, predictedBase: string): Promise<TipMerge> {
    const commit = await this.request(`/commits/${tip}`);
    const parents = Array.isArray(commit?.parents) ? commit.parents.map((parent: any) => parent?.sha).filter((sha: unknown) => typeof sha === 'string') : [];
    const author = typeof commit?.author?.login === 'string' ? commit.author.login : null;
    const email = typeof commit?.commit?.author?.email === 'string' ? commit.commit.author.email : '';
    const authoredByApp = appAuthored(commit, await this.controlPlaneLogin());
    // The provider merge never resolves a conflict: a conflicting merge is refused with 409 and
    // ejects the entry (see mergeBranch), so a tip that exists was produced without one.
    // A diff neither side of which could be read is left off: the record is what it was before GY-330.
    const diff = { reviewed: await this.diffPatchId(boundBase, from), tip: await this.diffPatchId(predictedBase, tip) };
    return { from, parents, author: author ?? (email || null), authoredByApp, conflicts: false, baseChanges: await this.changedFiles(boundBase, predictedBase), ...(diff.reviewed || diff.tip ? { diff } : {}) };
  }
  /** Returns the new head, or null when the branch already contains the merged commit. */
  async mergeBranch(branch: string, head: string, message: string): Promise<string | null> {
    let result: any;
    try { result = await this.request('/merges', 'POST', { base: branch, head, commit_message: message }); }
    catch (error) {
      if (error instanceof Refusal && /\(409\)/.test(error.message)) throw new SpeculativeConflict(`Speculative merge of ${head.slice(0, 12)} into ${branch} conflicts and cannot be resolved by Graphyard`);
      throw error;
    }
    if (result === null) return null;
    demand(typeof result?.sha === 'string' && /^[a-f0-9]{40}$/.test(result.sha), 'GitHub returned an invalid speculative merge commit', 502);
    return result.sha;
  }
  async publishRef(ref: string, sha: string) {
    try { await this.request(`/git/${ref}`, 'PATCH', { sha, force: true }); }
    catch (error) {
      if (!(error instanceof Refusal) || !/\(404\)|\(422\)/.test(error.message)) throw error;
      await this.request('/git/refs', 'POST', { ref, sha });
    }
  }
  /**
   * Builds the commit the queued candidate will actually land: the predicted base (the base
   * branch plus every entry ahead of it) with this candidate merged in. The result is published
   * under a Graphyard-owned ref and pushed onto the candidate branch, so the PR head, the
   * required checks, the review, and every proof all bind to that one exact commit.
   *
   * Every tip is built from the item's own reviewed head, never from the tip it replaces (GY-127).
   * A tip merged over an earlier tip kept that tip's predecessor in the branch history for good:
   * when the predecessor was ejected, or this entry was, the branch went on carrying commits of an
   * item that had not landed, and no head the worker could push would pass. So a branch whose
   * head is a tip is first moved back to the reviewed head under it, and the predicted base is
   * merged onto that; the tip's parents are exactly the reviewed head and its predicted base, which
   * is also what lets the carry rule in model/carry.ts accept it.
   *
   * A published tip is never republished onto a predicted base whose tree it already lands
   * (GY-100). A tip push replaces the head, so GitHub dismisses its approval and withdraws every
   * verdict bound to it; when the predicted base moved only to a tree-identical commit — an entry
   * ahead republishing its own tip, a queue merge on the base branch — the merge would produce
   * the same tree under a new sha and cost a review round for content nobody changed. The advance
   * is recorded on the speculation instead (`carriedBase`, as the control plane already records a
   * tree-identical base-branch advance) and nothing is written: `predictQueue` binds the tip to
   * that prediction, and the approval, the proofs and the checks stand on the commit they were
   * given for.
   */
  async publishSpeculativeTip(work: Work, placement: QueuePlacement, beforeWrite: () => Promise<void> = async () => {}): Promise<QueueSpeculation> {
    demand(work.candidate && work.queue && placement.predictedBase, 'A queued candidate with a predicted base is required');
    const pr = await this.request(`/pulls/${work.candidate!.pr}`);
    requireCurrent(pr.head.sha === work.candidate!.sha && pr.base.ref === this.config.base && pr.state === 'open' && pr.draft === false,
      'Pull request changed before speculative prediction; retry');
    // A speculative tip always contains the real base tip: the chain of predictions rests on the
    // base-branch commit the observation saw, and the branch must still be that commit or a
    // tree-identical advance of it (an earlier queue merge) when the tip is built.
    const branch = await this.baseBranch();
    requireCurrent(!!placement.base && (branch.tip === placement.base.sha || branch.tree === placement.base.tree), `Base branch ${this.config.base} moved before speculative prediction; retry`);
    const baseTree = await this.commitTree(placement.predictedBase!);
    const ref = queueRef(work.key);
    // Re-binding a published tip to a tree-identical prediction: recorded, never republished.
    // Never for the queue head whose branch lacks the base tip commit itself (GY-145): GitHub would
    // dismiss the approval as a merge-base change on the merge attempt, so it is merged in.
    const tipCarried = treeIdenticalPrediction(work, placement.predictedBase!, baseTree);
    const rebound = tipCarried && (placement.position > 0 || await this.contains(placement.predictedBase!, pr.head.sha)) ? tipCarried : null;
    // The re-bound record keeps its carry (see keptTipCarry) and names the entries now ahead of it.
    if (rebound) return { ...rebound, ...(rebound.tipTree ? {} : { tipTree: await this.tipTree(rebound.tip) }), predecessors: placement.predecessors,
      carriedBase: { sha: placement.predictedBase!, tree: baseTree, at: new Date().toISOString() }, trigger: 'queue-head' };
    const reviewedHead = await this.ownReviewedHead(work, pr.head.sha);
    // The approval of the tip being replaced is read now, before anything is written and outside
    // any coordination transaction (GY-519): the item's stored observation can predate the
    // approval, and republishing without reading it would dismiss a review of the very patch the
    // new tip re-shows. The carry decided at publication carries it exactly as an observed
    // approval, so a head ejection costs the entries behind it no review round.
    const observedApproval = work.policy.review && reviewProviderOf(work.policy) === 'github'
      ? await this.approvalOnHead(work, pr) : null;
    await beforeWrite();
    // The branch is moved by a forced ref update after the head was read above, not compared and
    // swapped in one request. A worker push landing in that window is overwritten; the window is
    // one request wide, the item is queued (a worker push at that point is a new head the queue
    // would eject for anyway), and the next observation reads the branch afresh, so the worker's
    // head is at worst reported as replaced rather than silently kept. Narrow, and accepted.
    if (reviewedHead !== pr.head.sha) await this.updateBranch(pr.head.ref, reviewedHead);
    const merged = await this.mergeBranch(pr.head.ref, placement.predictedBase!, `Graphyard speculative tip for ${work.key} behind ${placement.predecessors.join(', ') || this.config.base}`);
    const tip = merged ?? reviewedHead;
    await this.publishRef(ref, tip);
    // What the merge produced is recorded with the tip, so the binding carry (see model/carry.ts)
    // is decided on GitHub's own account of the commit, never on the fact that a merge was asked for.
    const merge = merged ? await this.describeMerge(reviewedHead, merged, work.candidate!.baseSha, placement.predictedBase!) : null;
    // A reviewed head that already contains its new predicted base is the tip itself, replacing
    // an earlier tip with no commit produced: the carry is then decided on the files that changed
    // between the replaced tip's bound base and the predicted base, listed here from GitHub.
    const baseChanges = merged || tip === work.candidate!.sha ? undefined : await this.changedFiles(work.candidate!.baseSha, placement.predictedBase!);
    return { ref, tip, tipTree: await this.tipTree(tip), base: placement.predictedBase!, baseTree, predecessors: placement.predecessors, policyRevision: work.policyRevision, publishedAt: new Date().toISOString(), merge, reviewedHead, trigger: 'queue-head',
      ...(observedApproval ? { observedApproval } : {}),
      ...(baseChanges !== undefined ? { baseChanges } : {}) };
  }
  /**
   * The approval of the pull request's current head from its reviews as GitHub holds them right
   * now (GY-519): the record's last observation can be older than the approval, and this read is
   * what lets the republication carry it instead of dismissing it. See `approvalOfHead` for the
   * identity rule.
   */
  private async approvalOnHead(work: Work, pr: { number: number; head: { sha: string }; user: { login: string } }): Promise<ObservedApproval | null> {
    try { return approvalOfHead(await this.pages(`/pulls/${pr.number}/reviews`), pr.head.sha, pr.user.login, pr.number, work); }
    catch { return null; }
  }
  /**
   * Restores a pull-request branch that carries another item's unlanded commits (GY-127): moves it
   * back to the item's own reviewed head, then merges the base branch onto it exactly as a base
   * refresh does. The ejection of a queued tip runs this on its own; the coordinator requests it
   * for a branch found contaminated any other way. No worker pushes for it and nobody opens a
   * shell: the control-plane App moves the branch, and the record says what it did and why.
   */
  async restoreBranch(work: Work, restore: { contaminated: string; foreign: string[]; own: string | null; cause: BranchRestore['cause']; requested: BranchRestore['requested']; reason: string }, beforeWrite: () => Promise<void> = async () => {}): Promise<BaseRefresh> {
    const candidate = work.candidate;
    demand(candidate && !work.queue && restore.contaminated === candidate.sha, 'An unqueued candidate whose head is the contaminated one is required');
    const pr = await this.request(`/pulls/${candidate!.pr}`);
    requireCurrent(pr.head.sha === candidate!.sha && pr.base.ref === this.config.base && pr.state === 'open' && pr.draft === false, 'Pull request changed before the branch restore; retry');
    const branch = await this.baseBranch();
    const at = new Date().toISOString();
    const own = restore.own ?? await this.ownReviewedHead(work, pr.head.sha);
    const record = (fields: Partial<BaseRefresh>, outcome: BranchRestore['outcome'], own: string | null): BaseRefresh => ({
      from: { sha: own ?? candidate!.sha, baseSha: candidate!.baseSha }, base: branch.tip, baseTree: branch.tree, policyRevision: work.policyRevision, at,
      head: own ?? candidate!.sha, conflict: null, merge: null, carry: null, trigger: restore.cause === 'repair' ? 'repair' : 'ejection restore', ...fields, restore: { ...restore, own, performedAt: at, outcome } });
    // A head that is not a tip of this item's own has the foreign commits under something a worker
    // pushed, or under nothing the record can name: nothing is moved, and the item says so.
    if (own === pr.head.sha) return record({}, 'unrepairable', null);
    await beforeWrite();
    // The same one-request window as in publishSpeculativeTip: a worker push between the head
    // check above and this forced update is overwritten by the restore. The head being restored
    // is one no worker may push over (a contaminated tip), the record names the head it moved
    // from, and the next observation reads the branch afresh.
    await this.updateBranch(pr.head.ref, own);
    let merged: string | null;
    try { merged = await this.mergeBranch(pr.head.ref, branch.tip, `Graphyard branch restore for ${work.key} onto ${this.config.base}`); }
    catch (error) {
      if (!(error instanceof SpeculativeConflict)) throw error;
      return record({ conflict: `Candidate ${candidate!.sha.slice(0, 12)} was restored to its own reviewed head ${own.slice(0, 12)}, which cannot be brought onto base branch tip ${branch.tip.slice(0, 12)} without resolving a conflict, which is content nobody reviewed or proved: ${error.message}. Run graphyard sync ${work.key}, resolve it and push.` }, 'conflict', own);
    }
    return record({ head: merged ?? own, merge: merged ? await this.describeMerge(own, merged, own, branch.tip) : null }, 'restored', own);
  }
  /**
   * Brings one in-flight candidate onto a base branch that moved under it, without a rework round.
   *
   * Only a candidate GitHub reports conflicting is refreshed (GY-292), and GitHub's reading is
   * confirmed first by a test merge on a scratch branch (GY-375). A clean test merge writes
   * nothing to the candidate's branch and is returned as a stale reading (`stale`), which the
   * engine records in place of a refresh: the candidate keeps its head, review and proofs. A
   * confirmed conflict writes nothing either: the refusal names it, trigger `conflict confirmed`,
   * and the candidate goes back to the worker, exactly as a stale candidate always did.
   */
  async refreshCandidateBase(work: Work, beforeWrite: () => Promise<void> = async () => {}): Promise<BaseRefresh> {
    const candidate = work.candidate;
    demand(candidate && work.observation?.baseTip && !work.queue, 'An unqueued candidate observed behind the base branch is required');
    const pr = await this.request(`/pulls/${candidate!.pr}`);
    requireCurrent(pr.head.sha === candidate!.sha && pr.base.ref === this.config.base && pr.state === 'open' && pr.draft === false,
      'Pull request changed before the base refresh; retry');
    const branch = await this.baseBranch();
    requireCurrent(branch.tip === work.observation!.baseTip, `Base branch ${this.config.base} moved before the base refresh; retry`);
    const from = { sha: candidate!.sha, baseSha: candidate!.baseSha };
    const record = (fields: Partial<BaseRefresh>): BaseRefresh => ({ from, base: branch.tip, baseTree: branch.tree,
      policyRevision: work.policyRevision, at: new Date().toISOString(), head: null, conflict: null, merge: null, carry: null, trigger: 'conflict confirmed', ...fields });
    await beforeWrite();
    // GitHub's `mergeable: false` is not trusted on its own (GY-375): it is recomputed lazily after
    // the base moves and read clean candidates as conflicting, and every refresh they were given
    // dropped their review and proofs. The conflict is confirmed first by a test merge that never
    // touches the candidate's branch; only one that really conflicts goes back to the worker.
    const conflict = await this.testMerge(work.key, candidate!.sha, branch.tip);
    if (!conflict) return record({ head: candidate!.sha, trigger: undefined, stale: { head: candidate!.sha, base: branch.tip, policyRevision: work.policyRevision, at: new Date().toISOString(),
      reading: `GitHub reported ${candidate!.sha.slice(0, 12)} conflicting with base branch tip ${branch.tip.slice(0, 12)}, but a test merge of the two is clean; the reading is stale and nothing was refreshed` } });
    // The confirmed conflict is the refresh's whole outcome: the provider merge onto the branch
    // would be refused the same way, and nothing is written to it.
    return record({ conflict: `Candidate ${candidate!.sha.slice(0, 12)} cannot be brought onto base branch tip ${branch.tip.slice(0, 12)} without resolving a conflict, which is content nobody reviewed or proved: ${conflict}. Run graphyard sync ${work.key}, resolve it and push; the approval and proofs bound to ${candidate!.sha.slice(0, 12)} do not survive the resolution.` });
  }
  /**
   * Whether `head` merges cleanly onto `base`, without writing to any branch a person or a check
   * reads (GY-375): the merge is tried on a scratch branch created at `head` for this one check and
   * deleted afterwards. Returns the conflict, or null when the merge is clean. GitHub has no
   * read-only merge check; `[skip ci]` keeps the scratch merge commit from starting a workflow.
   */
  async testMerge(key: string, head: string, base: string): Promise<string | null> {
    const branch = mergeCheckBranch(key);
    await this.publishRef(`refs/heads/${branch}`, head);
    try {
      await this.mergeBranch(branch, base, `Graphyard merge check for ${key} [skip ci]`);
      return null;
    } catch (error) {
      if (!(error instanceof SpeculativeConflict)) throw error;
      return error.message;
    } finally {
      // A scratch branch left behind by a failed delete is overwritten by the next check.
      await this.request(`/git/refs/heads/${branch}`, 'DELETE').catch(() => {});
    }
  }
  /**
   * The pull request's place in GitHub's merge queue (GY-258): whether the base branch has a queue,
   * whether the pull request is queued or set to auto-merge, and the merge group commit GitHub builds
   * for its entry. One GraphQL read.
   */
  async mergeQueueState(pr: number): Promise<GitHubMergeQueueState> {
    const [owner, name] = this.config.repository.split('/');
    const data = await this.graphql(mergeQueueQuery, { owner, name, number: pr, branch: this.config.base });
    const pull = data?.repository?.pullRequest;
    demand(typeof pull?.id === 'string' && typeof pull?.headRefOid === 'string', `GitHub did not report the merge-queue state of pull request #${pr}`, 502);
    const entry = pull.mergeQueueEntry ?? null;
    return { pullRequestId: pull.id, head: pull.headRefOid, queue: !!data.repository.mergeQueue?.id, mergeStateStatus: typeof pull.mergeStateStatus === 'string' ? pull.mergeStateStatus : null,
      mode: pull.isInMergeQueue || entry ? 'queued' : pull.autoMergeRequest ? 'auto-merge' : 'none',
      entryState: typeof entry?.state === 'string' ? entry.state : null, position: Number.isSafeInteger(entry?.position) ? entry.position : null,
      groupHead: typeof entry?.headCommit?.oid === 'string' ? entry.headCommit.oid : null, at: new Date().toISOString() };
  }
  /**
   * Hand an authorized head to GitHub: into the merge queue; where the base branch has none,
   * auto-merge, or an immediate merge when GitHub already reports the pull request mergeable —
   * CLEAN, UNSTABLE or HAS_HOOKS (it refuses auto-merge on such a pull request, and Graphyard
   * enqueues only once its own required check has passed, so a mergeable pull request is the usual
   * case). `expectedHeadOid` binds every
   * request to exactly that head, so a push in between is refused by GitHub rather than merged, and
   * GitHub still enforces branch protection and every required check. These are the only ways
   * Graphyard ever asks GitHub to merge.
   */
  async enqueuePullRequest(state: GitHubMergeQueueState, sha: string) {
    if (state.queue) return void await this.graphql(enqueueMutation, { id: state.pullRequestId, head: sha });
    const variables = { id: state.pullRequestId, head: sha, method: autoMergeMethod() };
    if (mergeableNow(state)) return void await this.graphql(headBoundMergeMutation, variables);
    try { await this.graphql(autoMergeMutation, variables); }
    catch (error) {
      // The pull request became mergeable (clean, unstable or has_hooks) between the read and the
      // request: merge it, still head-bound.
      if (!alreadyMergeableRefusal.test(error instanceof Error ? error.message : String(error))) throw error;
      await this.graphql(headBoundMergeMutation, variables);
    }
  }
  /** Take a pull request out of GitHub's hands: out of the merge queue, or auto-merge disabled. */
  async dequeuePullRequest(state: GitHubMergeQueueState) {
    if (state.mode === 'queued') await this.graphql(dequeueMutation, { id: state.pullRequestId });
    else if (state.mode === 'auto-merge') await this.graphql(disableAutoMergeMutation, { id: state.pullRequestId });
  }
  /**
   * The repair lane's merge (GY-406), made only once repairLaneVerdict allowed it: the App merges
   * exactly `sha`, head-bound (expectedHeadOid), with the bypass its ruleset grants it in
   * pull-request mode. Classic protection still binds the App, so the head first carries a
   * `Graphyard / merge` verdict that names the repair-lane decision instead of the gates.
   */
  async repairMerge(work: Work, audit: RepairAudit) {
    const state = await this.mergeQueueState(audit.pr);
    requireCurrent(state.head === audit.head, `Pull request #${audit.pr} head moved from ${audit.head.slice(0, 12)} to ${state.head.slice(0, 12)}; the repair lane merges only the approved head`);
    if (state.mode !== 'none') await this.dequeuePullRequest(state);
    const existing = (await this.pages(`/commits/${audit.head}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=latest`, 'check_runs')).find(c => c.app.id === this.config.appId);
    const body = { name: CHECK_NAME, head_sha: audit.head, status: 'completed', conclusion: 'success', external_id: work.id,
      output: { title: 'Repair lane: merge-path repair', summary: `Repair-lane merge of ${work.key} at ${audit.head}, decision ${audit.decision} (requested by ${audit.requestedBy}, approved by ${audit.approver}) for the fault in ${audit.fault}; bypassing a normal guarded merge ${audit.bypassed.state} since ${audit.bypassed.since}` } };
    await this.request(existing ? `/check-runs/${existing.id}` : '/check-runs', existing ? 'PATCH' : 'POST', body);
    await this.graphql(headBoundMergeMutation, { id: state.pullRequestId, head: audit.head, method: autoMergeMethod() });
  }
  /**
   * The files the base branch changed from `base` to `tip` (see changedFiles), or null when they
   * cannot be listed completely. Two pinned commits never change, so each pair is compared once.
   */
  async baseChangesSince(base: string, tip: string): Promise<string[] | null> {
    const key = `${base}...${tip}`;
    if (this.baseChangeLists.has(key)) return this.baseChangeLists.get(key)!;
    const files = await this.changedFiles(base, tip).then(paths => paths ? [...paths].sort() : null, () => null);
    this.baseChangeLists.set(key, files);
    if (this.baseChangeLists.size > historyEntries) this.baseChangeLists.delete(this.baseChangeLists.keys().next().value!);
    return files;
  }
  /** Every check run on a commit, as the gates read a candidate's: what the main guard judges a merge commit by (GY-500). */
  async commitChecks(sha: string): Promise<{ name: string; result: string; appId: number; id?: number }[]> {
    return (await this.pages(`/commits/${sha}/check-runs?filter=all`, 'check_runs')).filter(check => check.name !== CHECK_NAME)
      .map(check => ({ name: check.name, result: check.status === 'completed' ? check.conclusion : check.status, appId: check.app?.id, ...(Number.isSafeInteger(check.id) ? { id: check.id } : {}) }));
  }
  /**
   * Opens the revert of an optimistic merge that broke main (GY-500): one commit on the base
   * branch tip restoring each of the merge's files to its first parent's version (or removing a
   * file the merge added), on a `graphyard-revert/` branch, as a pull request. Refused — nothing
   * written — when a later merge changed one of those files again, since the revert would undo it.
   */
  async openRevert(work: Work, merge: OptimisticMerge, reason: string): Promise<{ pr: number; head: string } | { refusal: string }> {
    const branch = await this.baseBranch();
    const refusal = revertRefusal(merge, await this.changedFiles(merge.mergeSha, branch.tip).catch(() => null));
    if (refusal) return { refusal };
    const parent = (await this.request(`/commits/${merge.mergeSha}`))?.parents?.[0]?.sha;
    demand(typeof parent === 'string' && /^[a-f0-9]{40}$/.test(parent), `GitHub did not return the first parent of ${merge.mergeSha}`, 502);
    // Each file's entry in the parent's tree, walked down from its root tree by the entries' own shas.
    const trees = new Map<string, Map<string, { mode: string; sha: string; type: string }>>();
    const read = async (sha: string) => {
      if (!trees.has(sha)) trees.set(sha, new Map(((await this.request(`/git/trees/${sha}`))?.tree ?? []).map((entry: any) => [entry.path, { mode: entry.mode, sha: entry.sha, type: entry.type }])));
      return trees.get(sha)!;
    };
    const root = await this.commitTree(parent);
    const entryAt = async (path: string) => {
      let tree = root;
      const segments = path.split('/');
      for (const segment of segments.slice(0, -1)) {
        const entry = (await read(tree)).get(segment);
        if (entry?.type !== 'tree') return null;
        tree = entry.sha;
      }
      return (await read(tree)).get(segments.at(-1)!) ?? null;
    };
    const tree = [];
    for (const path of merge.lane.files) {
      const entry = await entryAt(path);
      tree.push(entry && entry.type === 'blob' ? { path, mode: entry.mode, type: 'blob', sha: entry.sha } : { path, mode: '100644', type: 'blob', sha: null });
    }
    const created = await this.request('/git/trees', 'POST', { base_tree: branch.tree, tree });
    const title = `Revert optimistic merge of ${work.key} (${merge.mergeSha.slice(0, 12)})`;
    const commit = await this.request('/git/commits', 'POST', { message: `${title}\n\n${reason}`, tree: created.sha, parents: [branch.tip] });
    demand(typeof commit?.sha === 'string' && /^[a-f0-9]{40}$/.test(commit.sha), 'GitHub returned an invalid revert commit', 502);
    const ref = `graphyard-revert/${work.key.toLowerCase()}-${merge.mergeSha.slice(0, 12)}`;
    await this.publishRef(`refs/heads/${ref}`, commit.sha);
    const existing = (await this.request(`/pulls?state=open&head=${encodeURIComponent(`${this.config.repository.split('/')[0]}:${ref}`)}`)) as any[];
    const pull = existing?.[0] ?? await this.request('/pulls', 'POST', { title, head: ref, base: this.config.base, body: `${reason}\n\nOpened by Graphyard's main guard (GY-500); it merges through the repair lane's bypass, bound to this head.` });
    demand(Number.isSafeInteger(pull?.number), 'GitHub did not open the revert pull request', 502);
    return { pr: pull.number, head: commit.sha };
  }
  /**
   * Lands a revert the main guard opened, exactly at `head`, with the repair lane's bypass (GY-406):
   * the App publishes its `Graphyard / merge` verdict naming the revert and merges head-bound, so
   * main is restored within one CI duration instead of after another queue round. Returns the
   * merge commit once GitHub reports the pull request merged, else null.
   */
  async mergeRevert(work: Work, revert: Pick<OptimisticRevert, 'pr' | 'head' | 'failing'>): Promise<string | null> {
    const pull = await this.request(`/pulls/${revert.pr}`);
    if (pull?.merged) return typeof pull.merge_commit_sha === 'string' ? pull.merge_commit_sha : null;
    const state = await this.mergeQueueState(revert.pr!);
    requireCurrent(state.head === revert.head, `Revert pull request #${revert.pr} head moved from ${revert.head!.slice(0, 12)} to ${state.head.slice(0, 12)}; the guard merges only the head it built`);
    if (state.mode !== 'none') await this.dequeuePullRequest(state);
    const existing = (await this.pages(`/commits/${revert.head}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=latest`, 'check_runs')).find(c => c.app.id === this.config.appId);
    const body = { name: CHECK_NAME, head_sha: revert.head, status: 'completed', conclusion: 'success', external_id: work.id,
      output: { title: 'Main guard: optimistic-merge revert', summary: `Revert of ${work.key}'s optimistic merge at ${revert.head}: ${revert.failing.join(', ') || 'required checks failed'} on main` } };
    await this.request(existing ? `/check-runs/${existing.id}` : '/check-runs', existing ? 'PATCH' : 'POST', body);
    await this.graphql(headBoundMergeMutation, { id: state.pullRequestId, head: revert.head, method: autoMergeMethod() });
    const merged = await this.request(`/pulls/${revert.pr}`);
    return merged?.merged && typeof merged.merge_commit_sha === 'string' ? merged.merge_commit_sha : null;
  }
  /**
   * GitHub's merge queue requires every required check on the merge group commit it builds, not only
   * on the pull request head. The authorized head's verdict is carried to that commit, and only
   * while the head stays authorized: a withdrawn head is dequeued, which discards the group.
   */
  async publishGroupCheck(work: Work, groupHead: string) {
    const existing = (await this.pages(`/commits/${groupHead}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=latest`, 'check_runs')).find(c => c.app.id === this.config.appId);
    if (existing?.status === 'completed' && existing.conclusion === 'success' && existing.external_id === work.id) return;
    const body = { name: CHECK_NAME, head_sha: groupHead, status: 'completed', conclusion: 'success', external_id: work.id,
      output: { title: 'All required gates passed', summary: `Merge group for ${work.key}: candidate ${work.candidate!.sha}; base ${work.candidate!.baseSha}; policy ${work.policyRevision}` } };
    await this.request(existing ? `/check-runs/${existing.id}` : '/check-runs', existing ? 'PATCH' : 'POST', body);
  }
  async publish(work: Work, forcedReason?: string, beforeWrite: () => Promise<void> = async () => {}) {
    if (!work.candidate) return;
    const reasons = [...work.gates.flatMap(g => g.reasons), ...work.violations, ...(forcedReason ? [forcedReason] : [])];
    const existing = (await this.pages(`/commits/${work.candidate.sha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=latest`, 'check_runs')).find(c => c.app.id === this.config.appId);
    const body = { name: CHECK_NAME, head_sha: work.candidate.sha, status: 'completed', conclusion: reasons.length ? 'failure' : 'success', external_id: work.id,
      output: { title: reasons.length ? 'REFUSED' : 'All required gates passed', summary: (reasons.length ? reasons.map(r => `- ${r}`).join('\n') : `Candidate ${work.candidate.sha}; base ${work.candidate.baseSha}; policy ${work.policyRevision}`).slice(0, 60000) } };
    const pr = await this.request(`/pulls/${work.candidate.pr}`);
    if (!reasons.length || !forcedReason) requireCurrent(pr.head.sha === work.candidate.sha && this.boundBase(work, pr, await this.baseBranch()) === work.candidate.baseSha, 'PR changed before check publication; retry');
    if (!reasons.length) requireCurrent(pr.state === 'open' && !pr.draft && pr.base.ref === this.config.base, 'PR is closed, draft, or retargeted; refusing success');
    await beforeWrite();
    if (existing?.status === body.status && existing.conclusion === body.conclusion && existing.external_id === body.external_id
      && existing.output?.title === body.output.title && existing.output?.summary === body.output.summary) return;
    await this.request(existing ? `/check-runs/${existing.id}` : '/check-runs', existing ? 'PATCH' : 'POST', body);
  }
}
/** Whether GitHub attributes a commit to the control-plane App's bot account: by the linked author, or by the App's noreply address. */
function appAuthored(commit: any, login: string): boolean {
  const author = typeof commit?.author?.login === 'string' ? commit.author.login : null;
  const email = typeof commit?.commit?.author?.email === 'string' ? commit.commit.author.email : '';
  return author !== null ? author.toLowerCase() === login.toLowerCase() && commit.author?.type === 'Bot'
    : new RegExp(`^\\d+\\+${login.replace(/[[\]]/g, '\\$&')}@users\\.noreply\\.github\\.com$`, 'i').test(email);
}
/** What gating one item's merge needs from GitHub (GY-258): the check publication and the merge-queue calls. */
export type MergeGateClient = Pick<GitHub, 'publish' | 'mergeQueueState' | 'enqueuePullRequest' | 'dequeuePullRequest' | 'publishGroupCheck'>;
/**
 * Graphyard gates, GitHub merges. The `Graphyard / merge` check is published on the exact head
 * first — success only for a head every gate passes — and then GitHub's queue is brought in line:
 * an authorized head the coordinator asked to merge is enqueued (where the base branch has no queue,
 * auto-merge, or an immediate head-bound merge when GitHub reports it mergeable now), a withdrawn one
 * dequeued, and a queued entry's merge group commit is given the same verdict so the queue can land
 * it. Graphyard never merges past GitHub: branch protection and required checks decide every merge.
 */
export async function gateMerge(github: MergeGateClient, work: Work, request: MergeEnqueueRequest | null, beforeWrite: () => Promise<void> = async () => {}): Promise<{ action: MergeQueueAction; state: GitHubMergeQueueState | null }> {
  demand(work.candidate, `${work.key} has no candidate to gate`);
  // Failure is written before a dequeue, success before an enqueue: GitHub never holds a head for
  // merging whose published verdict says otherwise.
  await github.publish(work, undefined, beforeWrite);
  // The queue step never fails the observation: a withdrawn head already carries a failing required
  // check, which GitHub will not merge, and the next observation retries the queue step.
  let state: GitHubMergeQueueState;
  try { state = await github.mergeQueueState(work.candidate.pr); }
  catch (error) { return { action: { kind: 'hold', reason: `GitHub's merge queue could not be read for ${work.key}: ${error instanceof Error ? error.message : String(error)}` }, state: null }; }
  const action = mergeQueueAction(work, state, request);
  // The current request's time goes on the record, so a merge left pending on a mergeable head is named (GY-344).
  state = { ...state, requestedAt: enqueueRequestCurrent(work, request) ? request!.at : null };
  try {
    if (action.kind === 'dequeue') await github.dequeuePullRequest(state);
    if (action.kind === 'enqueue') { await beforeWrite(); await github.enqueuePullRequest(state, work.candidate.sha); }
    if (action.kind === 'hold' && state.mode === 'queued' && state.groupHead && state.head === work.candidate.sha && mergeAuthorized(work)) await github.publishGroupCheck(work, state.groupHead);
  } catch (error) { return { action: { kind: 'hold', reason: `GitHub refused to ${action.kind} ${work.key}: ${error instanceof Error ? error.message : String(error)}` }, state }; }
  return { action, state };
}
/**
 * The repair lane (GY-406), run for a merge-path repair item after its normal gate step: every
 * condition is judged from the ledger (repairLaneVerdict), and only an allowed head is merged. The
 * audit entry is appended before GitHub is asked, so the delivery it produces is attributed to it;
 * a refused GitHub call is appended as `repair.failed`. A refusal of the lane itself is appended as
 * `repair.refused`, naming the missing condition, once per head and condition.
 * The bypass merge runs behind the job's fencing guard, as gateMerge and publish do (GY-428): a job
 * that lost its lock or whose item moved writes nothing. A retry after a failed GitHub merge reuses
 * the audit entry already appended for the same head and decision instead of appending a second.
 */
export async function repairLaneStep(engine: Pick<Engine, 'store' | 'enqueueRequest'>, github: Pick<GitHub, 'repairMerge'>, work: Work, now = new Date(), beforeWrite: () => Promise<void> = async () => {}): Promise<RepairLaneVerdict> {
  const rows = (await engine.store.pool.query("SELECT actor, kind, payload, created_at FROM events WHERE work_id=$1 AND kind LIKE 'decision.%' ORDER BY seq", [work.id])).rows;
  const decisions = foldDecisions(work.id, rows.map(row => ({ kind: row.kind, actor: row.actor, at: new Date(row.created_at).toISOString(), payload: row.payload })));
  const verdict = repairLaneVerdict(work, decisions, normalMergeState(work, await engine.enqueueRequest(work.id)), now.getTime());
  const record = (kind: string, details: object) => engine.store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', kind, JSON.stringify({ details })]);
  if (!verdict.allowed) {
    // The condition that holds the lane back is on the ledger once per head and condition, so the item says why it waits.
    const last = (await engine.store.pool.query("SELECT payload->'details' AS details FROM events WHERE work_id=$1 AND kind='repair.refused' ORDER BY seq DESC LIMIT 1", [work.id])).rows[0]?.details;
    if (last?.head !== work.candidate?.sha || last?.condition !== verdict.condition) await record('repair.refused', { head: work.candidate?.sha ?? null, condition: verdict.condition, refusal: verdict.refusal, at: now.toISOString() });
    return verdict;
  }
  const recorded = (await engine.store.pool.query(`SELECT payload->'details' AS audit FROM events WHERE work_id=$1 AND kind=$2 AND payload->'details'->>'head'=$3 AND payload->'details'->>'decision'=$4 ORDER BY seq DESC LIMIT 1`,
    [work.id, repairAuditEvent, verdict.sha, verdict.decision.id])).rows[0]?.audit as RepairAudit | undefined;
  await beforeWrite();
  const audit = recorded ?? repairAudit(work, verdict, now.toISOString());
  if (!recorded) await record(repairAuditEvent, audit);
  try { await github.repairMerge(work, audit); }
  catch (error) { await record('repair.failed', { ...audit, error: error instanceof Error ? error.message : String(error) }); throw error; }
  return verdict;
}
/**
 * The main guard (GY-500), run by the job loop every `mainGuardIntervalMs`. After an optimistic
 * merge the required suite runs on the merge commit (CI's run on each push to the base branch);
 * the guard reads its verdict on every optimistic merge commit that has not concluded, and when
 * one failed it traces the culprit among the optimistic merges since the last green commit
 * (mainGuard, bisecting when there are several) and reverts it at once: it opens a revert pull
 * request and lands it head-bound through the repair lane's bypass, which reopens the culprit
 * item for a rework round. Every step is on the ledger: each verdict (`optimistic.post-merge`),
 * each guard state (`optimistic.guard`, once per state, culprit and probe) and each revert step
 * (`optimistic.revert.*`). A revert it cannot make cleanly is recorded as refused, holds further
 * optimistic merges, and is released once the base branch tip passes the required suite again.
 */
export const mainGuardIntervalMs = 30_000;
export async function guardMain(engine: Pick<Engine, 'store' | 'ciAppIds' | 'recordPostMerge' | 'recordOptimisticRevert'>, github: Pick<GitHub, 'commitChecks' | 'openRevert' | 'mergeRevert' | 'baseBranch' | 'permissionShortfall'>, now = new Date()): Promise<GuardState> {
  const required = (work: Work) => work.policy.checks;
  for (const work of await engine.store.list()) {
    const merge = currentOptimisticMerge(work);
    if (!merge || (merge.postMerge && merge.postMerge.verdict !== 'pending')) continue;
    await engine.recordPostMerge(work.id, merge.mergeSha, postMergeVerdict(await github.commitChecks(verdictCommit(merge)), required(work), engine.ciAppIds));
  }
  let all = await engine.store.list();
  let guard = mainGuard(all);
  const recorded = (await engine.store.pool.query("SELECT payload->'details' AS details FROM events WHERE work_id IS NULL AND kind='optimistic.guard' ORDER BY seq DESC LIMIT 1")).rows[0]?.details;
  const summary = { state: guard.state, detail: describeGuard(guard), window: guard.window.map(merge => ({ key: merge.key, mergeSha: merge.mergeSha, verdict: merge.verdict })),
    ...('culprit' in guard ? { culprit: guard.culprit.key, mergeSha: guard.culprit.mergeSha } : {}), ...('probe' in guard ? { probe: guard.probe.mergeSha } : {}), ...('probes' in guard ? { probes: guard.probes } : {}) };
  // Postgres returns jsonb objects with their keys reordered, so the identity is built from values, never serialized objects.
  const identity = (value: any) => JSON.stringify([value?.state ?? null, value?.culprit ?? null, value?.probe ?? null,
    (Array.isArray(value?.window) ? value.window : []).map((merge: any) => [merge?.key, merge?.mergeSha, merge?.verdict])]);
  if (identity(recorded) !== identity(summary) && !(guard.state === 'green' && !recorded)) await engine.store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', ['graphyard', 'optimistic.guard', JSON.stringify({ details: { ...summary, at: now.toISOString() } })]);
  // Writing a revert needs Contents: write; without it the guard keeps reading and waits for the permission.
  if (github.permissionShortfall?.('merge-queue')) return guard;
  if (guard.state === 'culprit') {
    const found = guard, work = all.find(item => item.id === found.culprit.id)!, merge = currentOptimisticMerge(work)!;
    const base = { at: now.toISOString(), failing: found.culprit.failing, probes: found.probes, kept: found.kept.map(entry => entry.key), resolvedBy: null };
    const opened = autoMergeMethod() === 'REBASE' ? { refusal: 'The base branch merges by rebase, which lands several commits per pull request; the guard reverts merge and squash merges only' }
      : await github.openRevert(work, merge, `${describeGuard(found)}. The main guard reverts it so main is green again; ${work.key} is reopened for a rework round.`);
    await engine.recordOptimisticRevert(work.id, merge.mergeSha, 'refusal' in opened
      ? { ...base, state: 'refused', pr: null, head: null, mergeSha: null, refusal: opened.refusal }
      : { ...base, state: 'opened', pr: opened.pr, head: opened.head, mergeSha: null, refusal: null });
    all = await engine.store.list(); guard = mainGuard(all);
  }
  const held = guard;
  if (held.state === 'reverting') {
    const work = all.find(item => item.id === held.culprit.id)!, revert = held.revert;
    const merged = await github.mergeRevert(work, revert);
    if (merged) {
      await engine.recordOptimisticRevert(work.id, held.culprit.mergeSha, { ...revert, state: 'merged', mergeSha: merged });
      // The merges that landed after the culprit failed on commits that held it: each is re-tested on the revert.
      for (const merge of retestAfterRevert(held)) await engine.recordPostMerge(merge.id, merge.mergeSha, { verdict: 'pending' }, merged);
    }
  } else if (held.state === 'refused') {
    // Main is released once its tip passes again, however it was fixed.
    const tip = (await github.baseBranch()).tip;
    const verdict = postMergeVerdict(await github.commitChecks(tip), required(all.find(item => item.id === held.culprit.id)!), engine.ciAppIds);
    if (verdict.verdict === 'pass') await engine.recordOptimisticRevert(held.culprit.id, held.culprit.mergeSha, { ...held.revert, resolvedBy: { sha: tip, at: now.toISOString() } });
  } else return held;
  return mainGuard(await engine.store.list());
}
export async function githubFromEnv() {
  if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_REPOSITORY) return null;
  const privateKey = process.env.GITHUB_PRIVATE_KEY ?? await readFile(process.env.GITHUB_PRIVATE_KEY_FILE!, 'utf8');
  const reviewerApps = parseReviewerApps(process.env.GRAPHYARD_REVIEWER_APPS);
  return new GitHub({ repository: process.env.GITHUB_REPOSITORY, base: process.env.GITHUB_BASE_BRANCH ?? 'main', appId: Number(process.env.GITHUB_APP_ID), installationId: Number(process.env.GITHUB_INSTALLATION_ID), privateKey, reviewerApps }, processTokenBudgets);
}
/**
 * Moves one queued candidate onto the tip it is predicted to land. Entries publish head-first:
 * an entry with no predicted base yet simply waits for the one ahead of it to settle.
 */
async function advanceQueue(engine: Engine, github: GitHub, work: Work, job: { work_id: string; token: string }, guard: (snapshot: Work, success: boolean) => () => Promise<void>, hold: (feature: PermissionFeature) => string | null) {
  const all = await engine.store.list();
  const placement = queuePlacement(work, all.map(item => item.id === work.id ? work : item), Date.now());
  if (!placement || placement.current || !placement.publishable) return { work, published: false, held: null };
  // Publishing a tip writes a merge commit and a ref; without Contents: write the call can
  // only 403. The entry keeps its place and waits for the permission instead of retrying.
  const held = hold('merge-queue');
  if (held) return { work, published: false, held };
  try {
    const speculation = await github.publishSpeculativeTip(work, placement, guard(work, false));
    return { work: await engine.bindSpeculativeTip(work.id, work.revision, speculation, job.token), published: true, held: null };
  } catch (error) {
    if (!(error instanceof SpeculativeConflict)) throw error;
    return { work: await engine.ejectFromQueue(work.id, work.revision, error.message, job.token), published: false, held: null };
  }
}
/**
 * Brings one in-flight candidate onto the base branch tip it no longer contains. The queue owns
 * its own entries, so this is every other submitted candidate: the merge, the record of what it
 * produced, and the binding carry are all the control plane's, and no worker is asked for a round.
 */
async function refreshBase(engine: Engine, github: GitHub, work: Work, job: { work_id: string; token: string }, guard: (snapshot: Work, success: boolean) => () => Promise<void>, hold: (feature: PermissionFeature) => string | null) {
  // The refresh writes a merge commit onto the candidate's branch; without Contents: write the
  // call can only 403. The candidate keeps its held base and waits for the permission instead.
  const held = hold('merge-queue');
  if (held) return { work, published: false, held };
  const refresh = await github.refreshCandidateBase(work, guard(work, false));
  const updated = await engine.bindBaseRefresh(work.id, work.revision, refresh, job.token);
  return { work: updated, published: !!refresh.head && refresh.head !== refresh.from.sha, held: null };
}
/**
 * Restores one branch found carrying another item's unlanded commits, and records what the restore
 * did. The record's own answer decides the restore an ejection owes; a repair the coordinator
 * requested is already on the record and is run from it.
 */
async function restoreBranch(engine: Engine, github: GitHub, work: Work, owed: BranchRestore | ReturnType<typeof ejectedTipRestore>, job: { work_id: string; token: string }, guard: (snapshot: Work, success: boolean) => () => Promise<void>, hold: (feature: PermissionFeature) => string | null) {
  const held = hold('merge-queue');
  if (held) return { work, published: false, held };
  const request = 'cause' in owed! ? owed : { ...owed!, cause: 'ejection' as const, requested: null };
  const refresh = await github.restoreBranch(work, { contaminated: request.contaminated, foreign: request.foreign, own: request.own, cause: request.cause, requested: request.requested, reason: request.reason }, guard(work, false));
  const updated = await engine.bindBranchRestore(work.id, work.revision, refresh, job.token);
  return { work: updated, published: refresh.head !== null && refresh.head !== request.contaminated, held: null };
}
/** A held job waits this long before one bounded re-check, unless a preflight sees the installation change first. */
export const permissionHoldMs = 30 * 60_000;
/**
 * Conditional-request cache size. One observation round reads roughly ten paths per open PR; a cache
 * smaller than a round evicts every entry before its reuse, so no request earns a free 304.
 */
export const etagCacheEntries = 4096;
/** Commit-pair ancestry answers kept; each is immutable, so the bound only limits memory. */
export const ancestryEntries = 16384;
/** Commit-pair histories kept; each is immutable. */
export const historyEntries = 2048;
/** Peer containment compares one observation keeps in flight. */
export const peerContainmentConcurrency = 8;
async function boundedMap<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await run(items[index]); }
  }));
  return results;
}
/**
 * Seconds between observations. Only the merge-queue head needs one under 25 s old to merge; every
 * other item is woken at once by a webhook naming it, so its timer is only a backstop.
 */
export const headObservationSeconds = 20;
export const idleObservationSeconds = 300;
/**
 * How old an observation may be and still serve the merge gate: the freshness the publication
 * guard demands of the record it publishes, and the lag past which `master status` names the
 * queue head as unobserved (GY-492).
 */
export const observationFreshnessMs = 120_000;
/** Consecutive permission refusals a job may retry at the normal cadence before it is held. */
export const permissionRefusalLimit = 3;
/** How often the job loop re-reads the batch size the master published (GY-330). */
export const mergeBatchSizeRefreshMs = 30_000;
const batchSizeRead = new WeakMap<Engine, number>();
const guardRead = new WeakMap<Engine, number>(), guardFailure = new WeakMap<Engine, string>();
/**
 * How far the claim priority reaches into the merge queue (GY-492): the head and the next
 * `max(2, batch size) - 1` entries. The head needs a fresh observation to merge at all; the
 * entries its batch is validated with move only when it does.
 */
export const headClaimBand = (batchSize: number) => Math.max(2, Math.max(1, Math.floor(batchSize)));
/**
 * Whether this item's next action waits on an observation (GY-492): the loop requests a rework
 * round and dispatches a review only from a fresh reading of the pull request, so a job for such
 * an item is claimed ahead of the idle backlog that would otherwise hold it minutes.
 */
export function waitsOnObservation(work: Work, all: Work[], now = new Date()): boolean {
  const kind = nextAction(work, all, now)?.kind;
  return kind === 'request-rework' || kind === 'request-review';
}
/** Whether a session is running on the item now: a worker, reviewer or producer whose result an observation reads. */
export const runningSession = (work: Work) => (work.sessions ?? []).some(session => session.state === 'running' && !session.endedAt);
/** A submitted item the control plane has never read: its first observation is what every later gate waits on. */
export const firstObservationOwed = (work: Work) => !!work.submission && !work.observation && !work.candidate && work.stage !== 'done';
/** When the item's current submission was made: the documentation record's time for that PR, else when its stage was entered. */
const submittedAt = (work: Work) => work.documentation?.submission?.pr === work.submission?.pr && work.documentation?.submission?.at ? work.documentation.submission.at : work.stageEnteredAt;
/**
 * How many of the claim order's leading ids are the merge path — the queue-head band and any merge
 * in flight (GY-567) — which no starved job overtakes.
 */
export function observationHeadCount(all: Work[], batchSize: number, now = Date.now()): number {
  const band = headClaimBand(batchSize);
  const head = new Set(predictQueue(all, now).filter(placement => placement.position < band).map(placement => placement.id));
  for (const work of all) if (mergeAuthorized(work)) head.add(work.id);
  return head.size;
}
/**
 * The order observation jobs are claimed in (GY-492): merge-queue entries within the head band
 * first, in queue position, and any merge in flight (an authorized head GitHub may merge now);
 * then submissions never observed; then items whose next action waits on an observation, then
 * items with a running session, then the rest by available_at — the order `Store.takeJob` falls
 * back to for a job this list does not name. Under a `tight` budget (GY-567) running sessions come
 * straight after the first reads, which stay behind only the merge path whatever the budget.
 * `available_at` still gates every claim: priority reorders due jobs, never makes one due.
 */
export function observationClaimOrder(all: Work[], batchSize: number, now = Date.now(), tight = false): string[] {
  const band = headClaimBand(batchSize);
  const ranked: string[] = [];
  for (const placement of predictQueue(all, now)) {
    if (placement.position < band) ranked.push(placement.id);
  }
  for (const work of all) if (mergeAuthorized(work) && !ranked.includes(work.id)) ranked.push(work.id);
  const open = all.filter(work => work.stage !== 'done' && !ranked.includes(work.id));
  // A submission never observed has no candidate, so no gate, review or proof can start until it
  // is read once. Behind the review-waiting items, which come due again every cycle, one worker
  // never reached it (2026-09-26: eight submitted PRs unread for hours).
  const firstReads = open.filter(firstObservationOwed).map(work => work.id);
  const waiting = open.filter(work => waitsOnObservation(work, all, new Date(now))).map(work => work.id);
  const running = open.filter(runningSession).map(work => work.id);
  return [...new Set([...ranked, ...firstReads, ...(tight ? [running, waiting] : [waiting, running]).flat()])];
}

/** How long a lag is, in the unit a reader reads: a minute and change, or seconds. */
const observationLag = (ms: number) => ms >= 60_000 ? `${Math.floor(ms / 60_000)}m${Math.round(ms % 60_000 / 1000)}s` : `${Math.round(ms / 1000)}s`;

/**
 * Observation throughput and the queue head's observation lag (GY-492), read from what master
 * status already holds: the job durations `/api/status` carries under `githubBudget.throughput`,
 * the jobs in the work snapshot, and the merge queue predicted from it. The head is what merges,
 * and it merges only on an observation under two minutes old, so a head whose observation is
 * missing or older than that is raised as attention naming the head, its lag, and what the
 * workers have actually been achieving.
 */
export function observationThroughputStatus(coordinator: { githubBudget?: ({ throughput?: { jobsPerMinute?: number; medianDurationMs?: number | null; p90DurationMs?: number | null } | null } & Partial<Pick<GitHubBudget, 'remaining' | 'limit' | 'resetAt' | 'perMinute' | 'projectedExhaustionAt' | 'exhaustsBeforeReset' | 'reserve' | 'tokens'>> & { pace?: Partial<GitHubBudget['pace']> | null }) | null } | null | undefined,
  snapshot: { work: Work[]; now: string; jobs?: IntegrationJob[] }, now = Date.parse(snapshot.now)) {
  const throughput = coordinator?.githubBudget?.throughput ?? null;
  const reading = coordinator?.githubBudget ?? null;
  // The budget the workers are paced against (GY-567): what is left, when it resets, the spend
  // rate, the pace allowed, and when the spend rate would exhaust it.
  const budget = reading ? { remaining: reading.remaining ?? null, limit: reading.limit ?? null, resetAt: reading.resetAt ?? null, reserve: reading.reserve ?? null,
    perMinute: reading.perMinute ?? null, pacedPerMinute: reading.pace?.perMinute ?? null, paceTier: reading.pace?.tier ?? null,
    projectedExhaustionAt: reading.projectedExhaustionAt ?? null, exhaustsBeforeReset: !!reading.exhaustsBeforeReset,
    // Each token's own remaining, reset and projection at that reset (GY-690).
    tokens: (reading.tokens ?? []).map(token => ({ token: token.token, current: token.current, remaining: token.remaining, resetAt: token.resetAt, perMinute: token.perMinute, otherPerMinute: token.otherPerMinute, projectedAtReset: token.projectedAtReset, belowReserveAtReset: token.belowReserveAtReset })) } : null;
  const oldestDueJobMs = (snapshot.jobs ?? []).reduce<number | null>((oldest, job) => {
    const locked = job.locked_until !== null && Date.parse(job.locked_until) > now, held = job.held_until != null && Date.parse(job.held_until) > now;
    if (locked || held) return oldest;
    const available = Date.parse(job.available_at);
    return oldest === null ? Math.max(0, now - available) : Math.min(oldest, Math.max(0, now - available));
  }, null);
  const head = predictQueue(snapshot.work, now).find(placement => placement.position === 0) ?? null;
  const headObservation = head ? snapshot.work.find(work => work.id === head.id)?.observation ?? null : null;
  const headObservationAgeMs = head ? headObservation?.at ? Math.max(0, now - Date.parse(headObservation.at)) : null : null;
  // The oldest submission never observed (GY-567): nothing can review or prove it until it is read once.
  const unobserved = snapshot.work.filter(firstObservationOwed).map(work => ({ key: work.key, pr: work.submission!.pr, submittedAt: submittedAt(work) }))
    .sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
  const oldestUnobservedSubmission = unobserved[0] ? { ...unobserved[0], ageMs: Math.max(0, now - Date.parse(unobserved[0].submittedAt)), count: unobserved.length } : null;
  const report = { budget, jobsPerMinute: throughput?.jobsPerMinute ?? null, medianDurationMs: throughput?.medianDurationMs ?? null,
    p90DurationMs: throughput?.p90DurationMs ?? null, oldestDueJobMs, head: head?.key ?? null, headObservationAgeMs, oldestUnobservedSubmission };
  const attention: AttentionItem[] = head && (headObservationAgeMs === null || headObservationAgeMs > observationFreshnessMs)
    ? [{ subject: 'github',
        text: `The merge-queue head ${head.key} has ${headObservationAgeMs === null ? 'no observation at all' : `gone ${observationLag(headObservationAgeMs)} without an observation`} while the merge gate refuses anything older than two minutes${oldestDueJobMs !== null ? `; the oldest due job has waited ${observationLag(oldestDueJobMs)}` : ''}${report.jobsPerMinute !== null ? `, and the server has been observing ${report.jobsPerMinute} job(s)/min (median ${report.medianDurationMs ?? '?'} ms, p90 ${report.p90DurationMs ?? '?'} ms)`: ''}: the queue stalls until its head is observed`,
        ...agentOwner('control plane', 'Nothing to run: the observation workers claim the head ahead of the backlog on their own; if the lag keeps growing, graphyard status (githubBudget.throughput) shows what the workers achieve and the budget allows') }]
    : [];
  return { ...report, attention };
}
/**
 * Claim and run one due observation job. `spent`, when given, is told what the job charged the
 * budget (its non-304 requests), which is what the worker returns its paced slot with (GY-567).
 */
export async function processJob(engine: Engine, github: GitHub, spent?: (charged: number) => void): Promise<boolean> {
  // The batch size is the master's configuration, published to the installation ledger; a
  // restarted server reads it back here before the next evaluation it runs.
  const readAt = batchSizeRead.get(engine);
  if (readAt === undefined || Date.now() - readAt >= mergeBatchSizeRefreshMs) {
    batchSizeRead.set(engine, Date.now());
    await engine.loadMergeBatchSize().catch(() => batchSizeRead.delete(engine));
  }
  // The main guard (GY-500) is the installation's, not a job's: it runs here on its own interval,
  // and a failure of it is recorded and retried on the next interval, never failing a job.
  const guardedAt = guardRead.get(engine);
  if (typeof github.commitChecks === 'function' && (guardedAt === undefined || Date.now() - guardedAt >= mainGuardIntervalMs)) {
    guardRead.set(engine, Date.now());
    await guardMain(engine, github).catch(async error => {
      const message = error instanceof Error ? error.message : String(error);
      if (guardFailure.get(engine) === message) return;
      guardFailure.set(engine, message);
      await engine.store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', ['graphyard', 'optimistic.guard.failed', JSON.stringify({ details: { error: message, at: new Date().toISOString() } })]).catch(() => {});
    });
  }
  // The fleet is read before the claim, so the claim order can name it (GY-492): with a backlog
  // due, the merge-queue head's job is claimed first however recently it became due, instead of
  // waiting behind every older entry for a worker to reach it.
  const all = await engine.store.list();
  const job = await engine.store.takeJob(observationClaimOrder(all, engine.mergeBatchSize, Date.now(), budgetTight(github.budget?.())), observationHeadCount(all, engine.mergeBatchSize));
  if (!job) return false;
  const startedAt = Date.now();
  let work: Work | undefined;
  const guard = (snapshot: Work, success: boolean) => async () => {
    const result = await engine.store.pool.query(`SELECT w.document,clock_timestamp() AS now FROM work_items w JOIN jobs j ON j.work_id=w.id
      WHERE w.id=$1 AND j.token=$2 AND j.locked_until>clock_timestamp()`, [job.work_id, job.token]);
    const row = result.rows[0];
    requireCurrent(row && row.document.revision === snapshot.revision, 'Work or job ownership changed before publication; retry');
    if (success) requireCurrent(snapshot.observation && row.now.getTime() - Date.parse(snapshot.observation.at) < observationFreshnessMs, 'Observation expired before publication; retry');
  };
  // A feature whose permission the last preflight found missing is not attempted: the job is
  // held with the operator-facing reason instead of retrying into a 403. Adapters without a
  // preflight (test doubles) hold nothing.
  const hold = (feature: PermissionFeature) => github.permissionShortfall?.(feature) ?? null;
  // Every hold records the installation it was decided against, so a later preflight releases
  // it only when the installation actually changed (see Store.releaseHeldJobs).
  const heldOn = () => installationFingerprint(github.permissionReport?.() ?? null);
  let held: string | null = null;
  // Whether this run saved an observation (GY-506): every claimed job either saves one or records
  // why it did not — in the job's error, hold or deferral — and the job's consecutive
  // no-observation count is reset or incremented accordingly, whichever way it ends.
  let observed = false;
  // What this job's observation cost and when the next one is due (GY-117). The reserve is decided
  // before the observation, from the state the item starts in; the cadence after it, from the
  // state it produced. The meter counts every request the job makes, the check publication and
  // queue reads included, so the recorded cost is what one cycle of this item really costs.
  // Adapters without a budget (test doubles) schedule at the old twenty-second cadence.
  const schedule: { cadence: { band: CadenceBand; ms: number; reason: string } | null } = { cadence: null };
  const metered = <T>(fn: () => Promise<T>) => github.measured ? github.measured(fn) : fn().then(value => ({ value, requests: 0, uncached: 0 }));
  try {
    work = all.find(w => w.id === job.work_id);
    // `settled` is true when the job already scheduled itself: held, deferred, or requeued onto a
    // freshly published head. The measured cost is recorded either way.
    const { value: settled, requests, uncached } = await metered(async (): Promise<boolean> => {
      if (!work?.submission || work.stage === 'done') return false;
      held = hold('observation');
      if (held) { await engine.store.holdJob(job.work_id, job.token, held, permissionHoldMs, heldOn(), observed); return true; }
      const now = new Date();
      github.noteFleet?.(openCandidates(all));
      // Below the merge-path reserve, an observation that is neither a merge-gate candidate's nor
      // a webhook wake is rescheduled past the reset rather than spent.
      // A paused client spends nothing on any job: the job runs into the pause, keeps the refusal
      // in the ledger, and is rescheduled to the pause's end below, which is the incident's record.
      const budget = github.budget?.(now.getTime());
      const deferral = budget && !budget.paused ? reserveDecision(observationBand(work, all, now).band, budget, !!job.woken, now) : null;
      if (deferral) { github.recordDeferral(work.id, deferral); await engine.store.deferJob(job.work_id, job.token, deferral.until, deferral.reason, observed); return true; }
      // A tight budget leaves idle observations to webhook wakes and conditional reads (GY-567).
      const idle = budget && !budget.paused ? tightBudgetDecision(observationBand(work, all, now).band, budget, !!job.woken, now) : null;
      if (idle) { github.recordDeferral(work.id, idle); await engine.store.deferJob(job.work_id, job.token, idle.until, idle.reason, observed); return true; }
      const previous = work.observation ?? null;
      const observation = await github.observe(work, all);
      work = await engine.observe(work.id, work.revision, observation, job.token);
      observed = true;
      schedule.cadence = observationCadence(work, all.map(item => item.id === work!.id ? work! : item), now, previous, github.steadyStateMs?.(now.getTime()));
      // A branch carrying another item's unlanded commits is restored by the control plane (GY-127):
      // on its own for a tip the queue ejected, on the coordinator's request otherwise. The restored
      // head is a new candidate, so the job requeues onto it before anything else is dispatched.
      const owed = pendingRestore(work) ?? ejectedTipRestore(work, all);
      if (owed) {
        const restored = await restoreBranch(engine, github, work, owed, job, guard, hold);
        work = restored.work; held ??= restored.held;
        if (restored.published) { await engine.store.finishJob(job.work_id, job.token, undefined, true, undefined, observed); return true; }
      }
      // A base branch that moved under this candidate is Graphyard's to absorb, not the worker's.
      // The republished head is what the review, the checks and the proofs then bind to, so the
      // refresh runs before any review is dispatched and the job requeues onto the new head.
      if (baseRefreshNeeded(work)) {
        const refreshed = await refreshBase(engine, github, work, job, guard, hold);
        work = refreshed.work; held ??= refreshed.held;
        if (refreshed.published) { await engine.store.finishJob(job.work_id, job.token, undefined, true, undefined, observed); return true; }
      }
      const provider = reviewProviderOf(work.policy);
      // A head behind the base tip is reviewed when it merges cleanly (GY-191): the queue
      // integrates and re-tests it before merging. One that does not is deferred, and diagnose
      // reports why, until the refresh above republishes it or the worker syncs and pushes.
      // Nor is a head whose unit and integration proofs have not all passed: mechanical
      // verification precedes review for every provider, not only the one a session answers.
      const dispatchable = !observation.merged && observation.prState === 'open' && observation.draft === false && work.policy.review && !behindBaseHold(work)
        && !mechanicalHold(work, all, new Date());
      // A request binds the exact candidate; an approval Graphyard carried onto its own authored
      // tip already stands for that candidate, so no new request is dispatched for it.
      const unbound = (item: Work, profile?: string) => !carriedApproval(item) && (!item.reviewRequest || item.reviewRequest.sha !== item.candidate?.sha
        || item.reviewRequest.baseSha !== item.candidate?.baseSha || item.reviewRequest.policyRevision !== item.policyRevision
        || profile !== undefined && item.reviewRequest.profile !== profile);
      if (dispatchable && provider === 'codex' && unbound(work)) {
        held ??= hold('review-dispatch');
        if (!held) {
          const request = await github.requestCodex(work, guard(work, false));
          work = await engine.bindReviewRequest(work.id, work.revision, request, job.token);
        }
      }
      if (dispatchable && provider === 'agent') {
        let current: Work = work;
        const review = current.observation?.agentReview;
        // Exhaustion of the dispatched profile releases the request so the next profile is selected.
        if (review?.exhausted && review.exhaustion && !unbound(current, review.profile) && review.sha === current.candidate?.sha) {
          current = await engine.failoverReviewRequest(current.id, current.revision, { exhaustion: review.exhaustion, reason: review.reason }, job.token);
        }
        const profile = reviewerProfileFor(current);
        const app = github.reviewerAppFor(profile);
        if (profile && app && unbound(current, profile.name)) {
          held ??= hold('review-dispatch');
          if (!held) {
            const request = await github.requestAgentReview(current, profile, app, guard(current, false));
            current = await engine.bindReviewRequest(current.id, current.revision, request, job.token);
          }
        }
        work = current;
      }
      if (!observation.merged && observation.prState === 'open' && observation.draft === false) {
        const advanced = await advanceQueue(engine, github, work, job, guard, hold);
        work = advanced.work; held ??= advanced.held;
        // A freshly published tip replaces the PR head; the next observation binds the gates to it.
        if (advanced.published) { await engine.store.finishJob(job.work_id, job.token, undefined, true, undefined, observed); return true; }
      }
      if (!observation.merged) {
        const unpublishable = hold('check');
        if (unpublishable) held ??= unpublishable;
        else if (typeof github.mergeQueueState === 'function') {
          // The check and GitHub's queue move together (GY-258): an authorized, requested head is
          // published as passed and handed to GitHub to merge; anything else is failed and taken out.
          const gated = await gateMerge(github, work, await engine.enqueueRequest(work.id), guard(work, work.gates.every(g => g.passed) && !work.violations.length));
          if (gated.state) work = await engine.recordGitHubQueue(work.id, gated.state, gated.action);
        }
        else await github.publish(work, undefined, guard(work, work.gates.every(g => g.passed) && !work.violations.length));
        // A merge-path repair whose normal merge is stalled may take the audited repair lane (GY-406).
        if (work.repair === 'merge-path' && !unpublishable && typeof github.repairMerge === 'function') await repairLaneStep(engine, github, work, new Date(), guard(work, true));
      }
      return false;
    });
    spent?.(uncached);
    // The schedule: the merge-queue head every 20 s and everything else at the 300 s backstop a
    // webhook wake short-circuits; GY-117's fleet bound only ever stretches that backstop for an
    // unchanged candidate, never shortens it.
    // An authorized head GitHub may merge at any moment is observed at the same cadence, so the
    // record before its merge always carries a fresh observation to attribute the delivery from.
    const head = !settled && !held && work?.stage === 'merge' && (mergeAuthorized(work) || queuePlacement(work, await engine.store.list(), Date.now())?.position === 0);
    const cadence = schedule.cadence && (head ? { ...schedule.cadence, band: 'merge' as const, ms: headObservationSeconds * 1000 }
      : { ...schedule.cadence, band: schedule.cadence.band === 'merge' ? 'active' as const : schedule.cadence.band, ms: Math.max(idleObservationSeconds * 1000, schedule.cadence.ms) });
    if (cadence && work) github.recordObservation?.(work.id, { requests, uncached, band: cadence.band, cadenceMs: cadence.ms });
    if (settled) return true;
    if (work?.stage === 'done') await engine.store.pool.query('DELETE FROM jobs WHERE work_id=$1 AND token=$2', [job.work_id, job.token]);
    if (held) await engine.store.holdJob(job.work_id, job.token, held, permissionHoldMs, heldOn(), observed);
    // An item with no submission has nothing to observe: the job says so and is not counted as starved.
    else if (work && !work.submission && work.stage !== 'done') await engine.store.deferJob(job.work_id, job.token, new Date(Date.now() + idleObservationSeconds * 1000).toISOString(), 'no submission to observe', null);
    else await engine.store.finishJob(job.work_id, job.token, undefined, false, cadence?.ms ?? (head ? headObservationSeconds : idleObservationSeconds) * 1000, observed);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'GitHub reconciliation failed';
    // A rate-limit pause is one incident, not a retry every 45 seconds into the same refusal:
    // the job keeps the error and comes back when the pause lifts (a webhook still wakes it).
    const paused = github.budget?.().paused;
    if (paused && error instanceof Refusal && /requests paused/.test(message)) { await engine.store.finishJob(job.work_id, job.token, message, false, Math.max(2000, Date.parse(paused.until) - Date.now() + 1000), observed); return true; }
    const current = (await engine.store.pool.query('SELECT document,clock_timestamp() AS now FROM work_items WHERE id=$1', [job.work_id])).rows[0];
    const latest = current?.document as Work | undefined;
    if (latest?.candidate && latest.stage !== 'done' && !hold('check')) try { await github.publish(latest, 'Reconciliation failed; fresh verification required', guard(latest, false)); } catch { /* Durable retry follows. */ }
    // A head Graphyard could not verify is not left for GitHub to merge (GY-258).
    if (latest?.candidate && latest.stage !== 'done' && !hold('check') && typeof github.mergeQueueState === 'function') try {
      const state = await github.mergeQueueState(latest.candidate.pr);
      if (state.mode !== 'none') await github.dequeuePullRequest(state);
    } catch { /* Durable retry follows. */ }
    // A permission refusal is not transient: after a bounded number of ordinary retries the
    // job is held with the reason, and the next preflight either confirms the shortfall or
    // releases it once the installation changed. A refusal the declaration does not explain
    // (the preflight already passes) therefore stays held for the bounded hold, one attempt
    // per hold, instead of being released into the same 403 by every passing preflight.
    if (error instanceof GitHubPermissionRefusal) { await engine.store.refuseJob(job.work_id, job.token, message, permissionRefusalLimit, permissionHoldMs, heldOn()); return true; }
    const retry = error instanceof ReconciliationRetry;
    // A concurrency retry comes back within seconds and is not an operator error, but a run that
    // saved no observation never ends silent: the reason stands on the job record (GY-506).
    if (retry && !observed) { await engine.store.retryJob(job.work_id, job.token, message, observed); return true; }
    await engine.store.finishJob(job.work_id, job.token, retry ? undefined : message, retry, undefined, observed);
  } finally {
    // The throughput ledger (GY-492): how long the claimed job took, however it ended, so master
    // status can report what the workers actually achieve and name the lag a queue head suffers.
    github.recordJobDuration?.(Date.now() - startedAt);
  }
  return true;
}
