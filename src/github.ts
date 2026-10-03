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
import { LANDABLE_CHECK, landableCarried, landableCheckCurrent, landableCheckRun, type LandableCheckRun } from './landable-check.js';
import { inPlannedScope, threeWayMerge, type LandedCandidate } from './regression-guard.js';
import { changedTestFiles, judgeTimingCompanion, timingBaselineCompanion, timingBaselinePath } from './model/timing-companion.js';
import type { GitHubCacheStore } from './github-cache.js';
import type { GitHubChargeLedger } from './github-charges.js';
import { nextAction } from './model/next-action.js';
import { foldDecisions } from './model/approval.js';
import { normalMergeState, repairAudit, repairAuditEvent, repairLaneVerdict, type RepairAudit, type RepairLaneVerdict } from './master/repair-lane.js';
import { currentOptimisticMerge, describeGuard, mainGuard, postMergeVerdict, retestAfterRevert, revertRefusal, verdictCommit, type GuardState, type OptimisticMerge, type OptimisticRevert } from './optimistic-merge.js';
export { CHECK_NAME, LANDABLE_CHECK };
import { alreadyMergeableRefusal, approvalOfHead, baseRefreshNeeded, failedConclusions as failedCheckConclusions, dismissedVerdict, enqueueRequestCurrent, mergeableNow, ejectedTipRestore, heldBase, mergeAuthorized, mergeBaseDismissalPattern, mergeQueueAction, ownHeads, owedCheckReruns, dueCheckRerunProbes, ciAppIdsOf, classifyRerunRun, checkRerunUnreadableMs, checkRerunVisibilityMs, pendingRestore, predictQueue, queuePlacement, queueRef, mergeCheckBranch, treeIdenticalPrediction, type GitHubMergeQueueState, type HeadForcePush, type MergeEnqueueRequest, type MergeQueueAction, type BaseRefresh, type BranchRestore, type RerunWorkflowRun, type CarriedCandidate, type ForeignCandidate, type LandingCheck, type ObservedApproval, type QueuePlacement, type QueueSpeculation, type RevertedDelivery, type ReviewDismissal, type ReviewThread, type RestoreFailureKind } from './merge-queue.js';
import { blockedFeatures, controlPlanePermissions, describeShortfall, permissionShortfalls, requiredPermissions, type PermissionFeature, type PermissionLevel, type PermissionShortfall } from './github-permissions.js';
import { agentOwner, type AttentionItem } from './master/attention.js';
import { budgetedPage, docsWords, repositoryConfigFile, repositoryDocsBudget, type DocsWordBudget, type DocsWordCount, type TipDocs } from './model/documentation.js';
import type { IntegrationJob } from './coordination.js';
import { BoundedCache, EtagCache, blobContentBytes, blobContentValueBytes, etagCacheEntries } from './github-response-cache.js';
export { etagCacheBytes, etagCacheEntries } from './github-response-cache.js';
import { describePushShortfall, grantedPushPermissions, pushShortfallMarker, type PushPermissionShortfall } from './worker-credential.js';
import { observedReviewBody } from './review-cap.js';

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
/** The endpoint a request spent on, with its SHAs, numbers and ranges generalised: `GET /pulls/:n`, `GET /compare/:range`. */
export const requestEndpoint = (method: string, path: string) => `${method} ${path.replace(/^\/repos\/[^/]+\/[^/]+/, '').replace(/\?.*$/, '').replace(/[a-f0-9]{40}/g, ':sha').replace(/\/\d+/g, '/:n').replace(/^\/contents\/.*/, '/contents/:path').replace(/^\/compare\/.*/, '/compare/:range').replace(/^\/git\/ref\/heads\/.*/, '/git/ref/heads/:branch').replace(/^\/branches\/.*\/protection$/, '/branches/:branch/protection')}`;
/**
 * A GET whose answer never changes (GY-806): a commit read by its SHA, or a compare between two
 * exact SHAs. Such a read is asked of GitHub once and then served from the immutable cache with no
 * request at all — not even a conditional one — for as long as the entry is kept.
 */
export const immutableRead = (path: string) => /^\/repos\/[^/]+\/[^/]+\/(commits\/[a-f0-9]{40}|compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}(\?[^/]*)?)$/.test(path)
  // `contains` keeps the one answer it needs from its `?per_page=1` compare in the ancestry cache already.
  && !/\?per_page=1$/.test(path);
/**
 * One observation cycle (GY-806): every observation that starts within it shares one read of the
 * base branch's ref, instead of each item re-reading it. A push to the base branch (webhook) or a
 * ref this adapter writes itself ends the cycle early; without a webhook the ref is at most one
 * cycle old, the same staleness the polling backstop already allows.
 */
export const baseRefCycleMs = 15_000;
/** How long one read of the base branch's protection is shared; a protection or repository webhook ends it early. */
export const protectionShareMs = 5 * 60_000;
/** The share of one token's hourly limit the recorded workload must stay under once replayed (GY-806). */
export const billableBudgetShare = 0.6;
/** The events that drive an observation at once, ahead of polled jobs (GY-806). */
export const observationEvents = ['pull_request', 'pull_request_review', 'check_run', 'check_suite', 'push'] as const;
/** The events that end the shared protection read. */
export const protectionEvents = ['branch_protection_rule', 'branch_protection_configuration', 'repository_ruleset', 'repository'] as const;
/** How long a webhook wake waits to be claimed before it is dropped from the front of the claim (its job stays due). */
export { webhookWakeTtlMs } from './store/store.js';

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
  /**
   * Billable requests over the last hour against the hourly budget, by endpoint (GY-806):
   * `perHour` is what the last hour charged, `limit` the token's hourly limit (GitHub's default
   * when none was read yet), `share` their ratio, and `target` the share the fleet must stay under.
   * The count is the installation's: every replica sharing the quota (`instances`, this one
   * included) adds its charges through the charge ledger (src/github-charges.ts).
   */
  billable: { perHour: number; limit: number; share: number; target: number; instances: number; byEndpoint: { endpoint: string; requests: number; share: number }[] };
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
    ...(observation.requiredChecks?.length ? { requiredChecks: observation.requiredChecks.map(check => [check.name, check.appId]) } : {}),
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
  // The recorded window is derived by gate evaluation, including tips still awaiting CI.
  // Every in-flight tip needs verdict reads even before its test gate passes.
  if (work.queue?.tips?.length && work.stage !== 'done')
    return { band: 'merge', reason: `${work.key} is validating a tip in the parallel window; its verdict can advance the queue` };
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
/** The installation as the App's own credential reads it, and the permissions the App requests (GY-964). */
export interface InstallationState {
  appId: number; installationId: number; slug: string; account: string | null; accountType: string; installationUrl: string;
  suspended: boolean; permissions: Record<string, string>; app: Record<string, string>;
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
  private cache = new EtagCache();
  private ancestry = new Map<string, boolean>();
  private usage = { since: Date.now(), total: 0, notModified: 0, byKind: new Map<string, number>(), remaining: null as string | null, reset: null as string | null, token: '' };
  /** Once a minute, logs what the App spent: requests, free 304s, the costliest endpoints, and GitHub's own remaining budget of the token that last answered. */
  private meter(method: string, path: string, response: Response, token = '') {
    const u = this.usage;
    u.token = token || u.token;
    u.total++; if (response.status === 304) u.notModified++;
    const kind = requestEndpoint(method, path);
    u.byKind.set(kind, (u.byKind.get(kind) ?? 0) + 1);
    u.remaining = response.headers.get('x-ratelimit-remaining') ?? u.remaining; u.reset = response.headers.get('x-ratelimit-reset') ?? u.reset;
    if (Date.now() - u.since < 60_000) return;
    const top = [...u.byKind.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k}=${n}`).join(', ');
    console.log(`GitHub usage ${Math.round((Date.now() - u.since) / 1000)}s: ${u.total} requests, ${u.notModified} not-modified (free); remaining ${u.remaining} until ${u.reset ? new Date(Number(u.reset) * 1000).toISOString() : '?'}${u.token ? ` (token ${u.token})` : ''}; top ${top}`);
    this.usage = { since: Date.now(), total: 0, notModified: 0, byKind: new Map(), remaining: u.remaining, reset: u.reset, token: u.token };
  }
  private blobs = new Map<string, string | null>();
  private histories = new Map<string, Set<string> | null>();
  /** Settled terminal commit statuses per head commit sha and context name (GY-1060). */
  private terminalStatuses = new Map<string, { name: string; result: string; appId: 0; source: 'status' }>();
  /**
   * Whole responses of immutable reads (`immutableRead`): a commit by SHA, a compare of two exact SHAs
   * (GY-806). Kept as JSON text within a byte bound, as the conditional-request cache is (GY-975): a
   * compare carries every changed file's patch, so an entry count alone does not bound the heap.
   */
  private immutable = new ImmutableCache();
  private immutableReads = new Map<string, Promise<any>>();
  /** The clock the shared per-cycle reads are timed on; a replay drives it. */
  clock: () => number = Date.now;
  /** The base branch's ref, read once per observation cycle and shared by every item's observation (GY-806). */
  private sharedRef: { at: number; read: Promise<{ tip: string; tree: string }> } | null = null;
  /** The base branch's protection, read at most every `protectionShareMs` and shared (GY-806). */
  private sharedProtection = new Map<string, { at: number; read: Promise<any> }>();
  /** How many immutable responses the hot layer keeps; a miss past it is answered by the persisted layer. */
  immutableHotEntries = immutableEntries;
  /** Files changed between two pinned commits (GY-500); immutable, so each pair is compared once. */
  private baseChangeLists = new Map<string, string[] | null>();
  /**
   * Whether the optimistic lane (GY-500) is on, as the published `mergeQueue.optimistic` setting
   * reads it; null until the job loop loads the settings and means the default (on). With the lane
   * off nothing reads the files the base changed since a candidate's bound base, so `observe`
   * spends no compare on them.
   */
  optimisticLaneEnabled: boolean | null = null;
  /** Blob bytes by sha (GY-863's landing merge-result judgement); a blob's content is immutable, so each is asked once. */
  private blobContents = new BoundedCache<Buffer>(ancestryEntries, blobContentBytes, blobContentValueBytes, content => content.length);
  /** The persisted cold layer under the four maps above (src/github-cache.ts), when attached. */
  private persisted: GitHubCacheStore | null = null;
  private warming: Promise<void> | null = null;
  /** Load the persisted caches into the maps and write new entries behind. Resolves once loaded; never rejects. */
  attachCache(store: GitHubCacheStore) {
    this.persisted = store;
    // The cache's database is the one every replica shares, so its charge ledger counts them all (GY-806).
    this.chargeLedger = store.charges;
    const warming = store.load({ etag: this.cache, ancestry: this.ancestry, blob: this.blobs, history: this.histories, immutable: this.immutable },
      { etag: etagCacheEntries, ancestry: ancestryEntries, blob: ancestryEntries, history: historyEntries, immutable: immutableEntries }).then(() => { if (this.warming === warming) this.warming = null; });
    this.warming = warming;
    return warming;
  }
  /** The installation's charges across replicas (src/github-charges.ts), attached with the cache: `budget().billable` counts them all. */
  private chargeLedger: GitHubChargeLedger | null = null;
  attachChargeLedger(ledger: GitHubChargeLedger) { this.chargeLedger = ledger; }
  /** A request made while the persisted cache is still loading waits for it, at most two seconds. */
  private async warm() {
    if (!this.warming) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.warming, new Promise<void>(resolve => { timer = setTimeout(resolve, 2_000); timer.unref?.(); })]);
    clearTimeout(timer);
  }
  private preflightState: AppPermissionReport | null = null;
  /** The wanted worker push permissions the last mint found ungranted (GY-1100); null until a mint. */
  private pushShortfalls: PushPermissionShortfall[] | null = null;
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
  private charges: { at: number; kind: string; endpoint: string }[] = [];
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
   * Only installation REST requests report and charge the budget this class is spending; App-level
   * calls (`/app`, token refresh) and GraphQL are counted as requests against their own allowances.
   */
  private record(path: string, response: Response, tracked: boolean, now = Date.now(), charged = true, token: string | null = null, method = 'GET') {
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
    // The billable ledger is the REST core allowance the limit reads (GY-1052): GraphQL spends its
    // own point budget and App-level calls their own allowance, so neither is charged against it.
    if (!tracked || path === '/graphql' || resource && resource !== 'core') return;
    const charge = { at: now, kind: requestKind(path), endpoint: requestEndpoint(method, path) };
    this.charges.push(charge);
    this.chargeLedger?.charge(now, charge.endpoint, charge.kind);
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
    const counts = new Map<string, number>(), endpoints = new Map<string, number>();
    for (const charge of this.charges) { counts.set(charge.kind, (counts.get(charge.kind) ?? 0) + 1); endpoints.set(charge.endpoint, (endpoints.get(charge.endpoint) ?? 0) + 1); }
    const hourly = limit ?? defaultHourlyLimit, share = (requests: number) => Math.round(requests / hourly * 10_000) / 10_000;
    // The billable report is the installation's (GY-806): every other replica's last hour, as the
    // charge ledger last read it, is added to this process's own charges.
    const fleet = this.chargeLedger?.fleet() ?? { rows: [], instances: 0 };
    const billed = new Map(endpoints);
    for (const row of fleet.rows) billed.set(row.endpoint, (billed.get(row.endpoint) ?? 0) + row.requests);
    const billedTotal = this.charges.length + fleet.rows.reduce((total, row) => total + row.requests, 0);
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
      billable: { perHour: billedTotal, limit: hourly, share: share(billedTotal), target: billableBudgetShare, instances: 1 + fleet.instances,
        byEndpoint: [...billed].map(([endpoint, requests]) => ({ endpoint, requests, share: share(requests) })).sort((a, b) => b.requests - a.requests || a.endpoint.localeCompare(b.endpoint)) },
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
      // A push shortfall a mint met is kept current here, so accepting the permission clears it.
      if (this.pushShortfalls) this.pushShortfalls = grantedPushPermissions(granted).missing;
      const attention = [...(suspended ? [`App ${app} installation is suspended; restore it at ${installationUrl}`] : []), ...missing.map(shortfall => describeShortfall(shortfall, app, installationUrl)),
        ...(this.pushShortfalls ?? []).map(shortfall => describePushShortfall(shortfall, app, installationUrl))];
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
   * The installation and the permissions the App itself requests, read now with the App JWT
   * (GY-964). `master browser app-permissions` and `installation-accept` decide and verify from
   * this, so they run whenever the App sees its installation, whatever scopes the operator's gh
   * token carries. It leaves the preflight schedule and its hold alone.
   */
  async installationState(): Promise<InstallationState> {
    demand(Date.now() >= this.blockedUntil, `GitHub requests paused until ${new Date(this.blockedUntil).toISOString()} after a rate limit`, 502);
    const read = async (path: string, context: string) => {
      const response = await fetch(`https://api.github.com${path}`, { headers: this.appHeaders(), signal: AbortSignal.timeout(15_000) });
      this.record(path.replace(/\/\d+$/, ''), response, false);
      const refused = await this.refusal(response, context);
      if (refused) throw refused;
      return response.json() as Promise<any>;
    };
    const installation = await read(`/app/installations/${this.config.installationId}`, 'GET /app/installations');
    const app = await read('/app', 'GET /app');
    const levels = (value: unknown): Record<string, string> => value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, level]) => typeof level === 'string')) as Record<string, string> : {};
    return {
      appId: this.config.appId, installationId: this.config.installationId,
      slug: typeof installation?.app_slug === 'string' && installation.app_slug ? installation.app_slug : String(app?.slug ?? this.config.appId),
      account: typeof installation?.account?.login === 'string' ? installation.account.login : null,
      accountType: String(installation?.account?.type ?? installation?.target_type ?? 'User'),
      installationUrl: typeof installation?.html_url === 'string' && /^https:\/\/github\.com\//.test(installation.html_url) ? installation.html_url : installationSettingsUrl(this.config.installationId),
      suspended: !!installation?.suspended_at, permissions: levels(installation?.permissions), app: levels(app?.permissions),
    };
  }
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
      this.record('/app/installations/access_tokens', response, false, Date.now(), true, null, 'POST');
      const refused = await this.refusal(response, 'installation authentication');
      if (refused instanceof GitHubPermissionRefusal) this.authenticationRefusal = { until: Date.now() + 60_000, error: refused };
      if (refused) throw refused;
      this.authenticationRefusal = null;
      const result: any = await response.json();
      demand(typeof result.token === 'string' && result.token.length > 0 && Number.isFinite(Date.parse(result.expires_at)) && Date.parse(result.expires_at) > Date.now(), 'Invalid GitHub installation token response', 502);
      this.token = result.token; this.expires = Date.parse(result.expires_at);
      this.permissions = result.permissions && typeof result.permissions === 'object' ? result.permissions : {};
  }
  /**
   * A worker session's push credential (GY-999): an installation token narrowed to this one
   * repository and to the permissions pushing a branch and opening its pull request need. It is
   * never cached here and never the token this client itself uses; GitHub bounds it to an hour.
   * It asks only for the wanted permissions the installation grants (GY-1100): the preflight's
   * verified reading when there is one, else the installation read now. A wanted permission the
   * installation lacks is left out and raised as permission attention instead of failing the mint;
   * a 422 on a preflight reading re-reads the installation once, in case it changed since.
   */
  async mintPushToken(): Promise<{ token: string; expiresAt: string; permissions: Record<string, string> }> {
    demand(Date.now() >= this.blockedUntil, `GitHub requests paused until ${new Date(this.blockedUntil).toISOString()} after a rate/access refusal`, 502);
    const bypass = await this.workerPushBypass();
    demand(!bypass, bypass ?? '', 409);
    const cached = this.preflightState?.verifiedAt ? this.preflightState.granted : null;
    let response = await this.requestPushToken(cached ?? await this.installationGrants());
    if (response.status === 422 && cached) response = await this.requestPushToken(await this.installationGrants());
    const refused = await this.refusal(response, 'worker push credential');
    if (refused) throw refused;
    const result: any = await response.json();
    demand(typeof result?.token === 'string' && result.token.length >= 20 && Number.isFinite(Date.parse(result.expires_at)), 'GitHub returned no worker push token', 502);
    return { token: result.token, expiresAt: new Date(Date.parse(result.expires_at)).toISOString(), permissions: result.permissions && typeof result.permissions === 'object' ? result.permissions : {} };
  }
  /** The installation's granted permissions read now with the App JWT. */
  private async installationGrants(): Promise<Record<string, string>> {
    const response = await fetch(`https://api.github.com/app/installations/${this.config.installationId}`, { headers: this.appHeaders(), signal: AbortSignal.timeout(15_000) });
    this.record('/app/installations', response, false);
    const refused = await this.refusal(response, 'GET /app/installations');
    if (refused) throw refused;
    const installation: any = await response.json();
    demand(installation?.permissions && typeof installation.permissions === 'object', 'GitHub returned an installation without permissions', 502);
    return Object.fromEntries(Object.entries(installation.permissions).filter(([, level]) => typeof level === 'string')) as Record<string, string>;
  }
  private async requestPushToken(granted: Record<string, string>) {
    const { permissions, missing } = grantedPushPermissions(granted);
    demand(permissions.contents === 'write', `The App installation grants no Contents: write, so no worker push credential can be minted; accept it at ${this.preflightState?.installationUrl ?? installationSettingsUrl(this.config.installationId)}`, 502);
    this.pushShortfalls = missing;
    const report = this.preflightState;
    if (report) {
      report.attention = [...report.attention.filter(line => !line.includes(pushShortfallMarker)),
        ...missing.map(shortfall => describePushShortfall(shortfall, report.app, report.installationUrl))];
    }
    const response = await fetch(`https://api.github.com/app/installations/${this.config.installationId}/access_tokens`, {
      method: 'POST', headers: { ...this.appHeaders(), 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ repositories: [this.config.repository.split('/')[1]], permissions }),
    });
    this.record('/app/installations/access_tokens', response, false);
    return response;
  }
  /**
   * Why this App's token may not be handed to a worker, or null (GY-1066). On an organization
   * repository Graphyard's merge-queue ruleset names the control-plane App as its one pull-request
   * bypass actor (src/protection.ts repairBypassActor), and a token of that App with `contents`
   * write can merge a pull request past the queue and the guarded final recheck. So while any merge
   * queue on the base branch lists this App as a bypass actor — or its bypass list cannot be read —
   * no worker credential is minted from it. A user-owned repository has no queue and is unaffected.
   * Graphyard has no separate worker App yet, so such a repository launches no worker at all; the
   * refusal says so, and docs/protocol/leases.md records the limitation. A read GitHub fails
   * transiently is answered 502, to be asked again, not as this refusal.
   */
  async workerPushBypass(): Promise<string | null> {
    const stranded = '; no worker can launch on this repository until workers push as an App the queue does not exempt (docs/protocol/leases.md)';
    const rules = await this.request(`/rules/branches/${this.config.base.split('/').map(encodeURIComponent).join('/')}`);
    demand(Array.isArray(rules), `GitHub did not answer the rules of ${this.config.base}, so no worker push credential is minted`, 502);
    const rulesets = [...new Set(rules.filter((rule: any) => rule?.type === 'merge_queue').map((rule: any) => Number(rule?.ruleset_id)))];
    for (const id of rulesets) {
      let ruleset: any = null;
      if (Number.isSafeInteger(id) && id > 0) {
        try { ruleset = await this.request(`/rulesets/${id}`); }
        catch (error) {
          // Only GitHub's own answer that the ruleset is hidden from this App (403, 404) is a standing
          // fact; a 5xx, a rate limit or a timeout is transient, so the mint is retryable (502), never a policy refusal.
          const status = error instanceof GitHubPermissionRefusal && error.kind === 'permission' ? 403 : Number(/ failed \((\d{3})\)/.exec(error instanceof Error ? error.message : '')?.[1]);
          if (status !== 403 && status !== 404) throw new Refusal(`The merge queue on ${this.config.base} (ruleset ${id}) could not be read now (${error instanceof Error ? error.message : String(error)}), so no worker push credential is minted; ask again`, 502);
        }
      }
      // GitHub answers whether the caller — this installation — may bypass; the actor list is the fallback when it does not.
      const bypass = ruleset?.current_user_can_bypass;
      if (bypass === 'never') continue;
      const actors = ruleset?.bypass_actors;
      if (bypass === 'always' || bypass === 'pull_requests_only') return `App ${this.config.appId} may bypass the merge queue on ${this.config.base} (ruleset ${id}: ${bypass}), so a token of it could merge a worker's own pull request past the queue; no worker push credential is minted from it${stranded}`;
      if (!Array.isArray(actors)) return `The bypass actors of the merge queue on ${this.config.base} (ruleset ${id}) cannot be read, so App ${this.config.appId} may be able to merge past the queue; no worker push credential is minted from it${stranded}`;
      if (actors.some((actor: any) => actor?.actor_type === 'Integration' && Number(actor?.actor_id) === this.config.appId)) return `App ${this.config.appId} is a bypass actor of the merge queue on ${this.config.base} (ruleset ${id}), so a token of it could merge a worker's own pull request past the queue; no worker push credential is minted from it${stranded}`;
    }
    return null;
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
    if (method === 'GET' && immutableRead(path)) return this.immutableRequest(path);
    // A ref this adapter moves itself ends the shared base-ref read (GY-806), a head-bound GraphQL
    // merge included (GY-1052): the next observation reads the new tip. It ends once the write has
    // answered too, so an observation that read the ref while the write was in flight is not shared on.
    const movesRef = method !== 'GET' && (/\/(git\/refs|merges$|pulls\/\d+\/merge$)/.test(path) || path === '/graphql' && (body as { query?: unknown } | undefined)?.query === headBoundMergeMutation);
    if (movesRef) this.sharedRef = null;
    try { return await this.send(path, method, body, true); }
    finally { if (movesRef) this.sharedRef = null; }
  }
  /**
   * A commit by SHA or a compare of two exact SHAs (GY-806): asked of GitHub once, then served from
   * the immutable cache with no request, however many observations ask. Concurrent first reads of
   * the same path share one request. A cached answer needs no token, so it is served through a pause.
   * A miss in the bounded hot layer asks the persisted layer first, so eviction and restarts never
   * make GitHub answer a path still in use twice; every hit marks the persisted row used, so only
   * answers nothing reads any more age out of its bound.
   */
  private async immutableRequest(path: string): Promise<any> {
    await this.warm();
    const hot = this.immutable.get(path);
    if (hot !== undefined) {
      this.immutable.set(path, hot);
      this.persisted?.touch('immutable', path);
      return JSON.parse(hot);
    }
    let reading = this.immutableReads.get(path);
    if (!reading) {
      reading = (async () => {
        // A hot-layer miss asks the persisted layer, which keeps every answer still read, before GitHub.
        if (this.persisted) {
          const stored = await this.persisted.lookup('immutable', path);
          if (stored !== undefined && stored !== null) {
            this.keepImmutable(path, stored);
            this.persisted.touch('immutable', path);
            return stored;
          }
        }
        const value = await this.send(path, 'GET', undefined, false);
        if (value !== null && value !== undefined) {
          this.keepImmutable(path, value);
          this.persisted?.put('immutable', path, value);
        }
        return value;
      })().finally(() => this.immutableReads.delete(path));
      this.immutableReads.set(path, reading);
    }
    return structuredClone(await reading);
  }
  /** Keep an immutable answer in the hot layer as its text, evicting the oldest-used past either bound. */
  private keepImmutable(path: string, value: unknown) {
    this.immutable.set(path, value);
    while (this.immutable.size > this.immutableHotEntries) this.immutable.delete(this.immutable.keys().next().value!);
  }
  /** One request to GitHub. `conditional` uses and keeps the ETag cache; an immutable read needs neither. */
  private async send(path: string, method: string, body: unknown, conditional: boolean): Promise<any> {
    await this.authenticate();
    if (method === 'GET') await this.warm();
    const cached = method === 'GET' && conditional ? this.cache.get(path) : undefined;
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
    this.record(path, response, true, Date.now(), true, token, method);
    // A 304 costs no rate budget. Refresh the entry's recency so a full observation round stays cached.
    if (response.status === 304 && cached) { this.rateFailures = 0; this.cache.keep(path, cached.etag, cached.text); this.persisted?.touch('etag', path); return JSON.parse(cached.text); }
    const refused = await this.refusal(response, `${method} ${path}`);
    if (refused) throw refused;
    this.rateFailures = 0;
    const text = response.status === 204 ? null : await response.text();
    const value = text === null ? null : JSON.parse(text);
    const etag = response.headers.get('etag');
    if (method === 'GET') {
      this.cache.delete(path);
      // The entry keeps the answer's text, not its object graph, within the cache's byte bound (GY-975).
      if (etag && conditional && text !== null) {
        this.cache.keep(path, etag, text);
        this.persisted?.put('etag', path, value, etag);
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
   * An unreadable protection is neither. `shared` takes the observation cycle's read (GY-806); every
   * other caller, a guard before a write included, reads it fresh.
   */
  async branchProtection(requireNativeReview = false, shared = false): Promise<{ protected: boolean; conversationResolution: boolean; requiredChecks: { name: string; appId: number | null }[] }> {
    try {
      const path = `/branches/${encodeURIComponent(this.config.base)}/protection`;
      const p = shared ? await this.sharedProtectionRead(path) : await this.request(path);
      // `strict` must be off: a queued tip is deliberately behind the base branch, and the merge
      // queue supersedes that setting with a published tip that already contains its validated base.
      const verified = (!requireNativeReview || p.required_pull_request_reviews?.required_approving_review_count >= 1 && p.required_pull_request_reviews?.dismiss_stale_reviews && p.required_pull_request_reviews?.require_last_push_approval) && p.required_status_checks?.strict === false && !!p.enforce_admins?.enabled && !p.allow_force_pushes?.enabled && !p.allow_deletions?.enabled
        && p.required_status_checks.checks?.some((c: any) => c.context === CHECK_NAME && c.app_id === this.config.appId);
      const classic = [...(p.required_status_checks?.checks ?? []).map((c: any) => ({ name: c?.context, appId: c?.app_id ?? null })),
        ...(p.required_status_checks?.contexts ?? []).map((name: any) => ({ name, appId: null }))];
      return { protected: !!verified, conversationResolution: p.required_conversation_resolution?.enabled === true, requiredChecks: mergeRequiredChecks(classic) };
    } catch { return { protected: false, conversationResolution: false, requiredChecks: [] }; }
  }
  /**
   * The status checks the base branch's active rulesets require (GY-430), read from GitHub's
   * branch-rules endpoint, which reports every ruleset rule that applies to the branch. An
   * unreadable answer requires nothing extra: the policy's checks still gate.
   */
  private async requiredStatusChecks(shared = false): Promise<{ name: string; appId: number | null }[]> {
    try {
      const path = `/rules/branches/${this.config.base.split('/').map(encodeURIComponent).join('/')}`;
      const rules = shared ? await this.sharedProtectionRead(path) : await this.request(path);
      if (!Array.isArray(rules)) return [];
      return mergeRequiredChecks(rules.filter((rule: any) => rule?.type === 'required_status_checks')
        .flatMap((rule: any) => (rule.parameters?.required_status_checks ?? []).map((check: any) => ({ name: check?.context, appId: check?.integration_id ?? null }))));
    } catch { return []; }
  }
  /**
   * GY-1060. The commit statuses of required contexts no check run reports: a classic protection
   * `contexts` entry or a ruleset check bound to no app is commonly a commit status, which the
   * check-runs read never sees, so the gate would refuse it as not passed forever. They are read
   * only when such a context exists that no configured CI app's run reports (another app's run
   * never hides the status, which `requiredCheckRun` prefers to it), as entries of app 0 marked
   * `status`, which no policy check's trusted CI apps include. Every page of the combined status is
   * read, so a context past the first hundred is still seen. An error state is a failure; a settled
   * terminal status per head is cached to save re-reading; a read error is not swallowed.
   *
   * External CI retries (finding 24): settled terminal statuses are cached per head commit SHA
   * (bounded by ancestryEntries) to satisfy findings 21 & 22 and avoid polling /commits/{sha}/status
   * on every cycle. While external CI can mutate status on an existing SHA upon manual retry,
   * standard Graphyard workflow upon retry is pushing a new commit (or empty commit), which yields a
   * fresh SHA and bypasses the cache; cache churn and process restarts also clear the entry.
   */
  private async requiredStatuses(sha: string, required: { name: string; appId: number | null }[], policy: readonly string[], runs: { name: string; app?: { id?: number } }[], ciAppIds: readonly number[]): Promise<Observation['checks']> {
    const names = new Set(required.filter(check => check.appId === null && check.name !== CHECK_NAME && !policy.includes(check.name)
      && !runs.some(run => run.name === check.name && ciAppIds.includes(run.app?.id as number))).map(check => check.name));
    if (!names.size) return [];
    const missing = [...names].filter(name => !this.terminalStatuses.has(`${sha}:${name}`));
    if (!missing.length) return [...names].map(name => this.terminalStatuses.get(`${sha}:${name}`)!);
    const statuses = await this.pages(`/commits/${sha}/status`, 'statuses');
    const seen = new Set<string>();
    for (const status of statuses) {
      if (typeof status?.context === 'string' && names.has(status.context) && !seen.has(status.context)) {
        seen.add(status.context);
        if (['success', 'failure', 'error'].includes(status.state)) {
          this.terminalStatuses.set(`${sha}:${status.context}`, {
            name: status.context,
            result: status.state === 'error' ? 'failure' : String(status.state),
            appId: 0,
            source: 'status' as const,
          });
          if (this.terminalStatuses.size > ancestryEntries) this.terminalStatuses.delete(this.terminalStatuses.keys().next().value!);
        }
      }
    }
    return [...names].flatMap(name => {
      const cached = this.terminalStatuses.get(`${sha}:${name}`);
      if (cached) return [cached];
      const fresh = statuses.find((s: any) => s?.context === name);
      if (!fresh) return [];
      return [{ name, result: fresh.state === 'error' ? 'failure' : String(fresh.state), appId: 0, source: 'status' as const }];
    });
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
   * root cause of approvals dismissed for a merge base that had not actually changed. Read fresh:
   * a guard before a write compares against the branch as it is now.
   */
  async baseBranch(): Promise<{ tip: string; tree: string }> { return this.readBaseBranch(); }
  /**
   * The base branch as the current observation cycle read it (GY-806): one read per `baseRefCycleMs`
   * shared by every observation, ended early by a base push or a ref this adapter writes. Only
   * observations use it; guards use `baseBranch`.
   */
  async cycleBaseBranch(): Promise<{ tip: string; tree: string }> {
    const now = this.clock();
    if (!this.sharedRef || now - this.sharedRef.at >= baseRefCycleMs || now < this.sharedRef.at) {
      const entry = { at: now, read: this.readBaseBranch() };
      this.sharedRef = entry;
      // A failed read is not shared past its own callers.
      entry.read.catch(() => { if (this.sharedRef === entry) this.sharedRef = null; });
    }
    return { ...await this.sharedRef.read };
  }
  /**
   * A base-branch protection read as GitHub returns it — the branch protection or the branch's
   * rules, keyed by its path — read at most every `protectionShareMs` and shared by every
   * observation (GY-806); a protection, ruleset or repository webhook ends the share early.
   */
  private sharedProtectionRead(path: string): Promise<any> {
    const now = this.clock();
    let entry = this.sharedProtection.get(path);
    if (!entry || now - entry.at >= protectionShareMs || now < entry.at) {
      const fresh = { at: now, read: this.request(path) };
      entry = fresh;
      this.sharedProtection.set(path, fresh);
      fresh.read.catch(() => { if (this.sharedProtection.get(path) === fresh) this.sharedProtection.delete(path); });
    }
    return entry.read.then(value => structuredClone(value));
  }
  /**
   * What a verified webhook delivery means for this adapter's shared reads (GY-806): a push to the
   * base branch ends the shared ref read, and a protection or repository event ends the shared
   * protection read. The wake of the items it names is the job row's (`Store.takeJob`), not this
   * adapter's, so every replica claims them first.
   */
  noteWebhook(event: string, payload: any) {
    const ref = typeof payload?.ref === 'string' ? payload.ref : '';
    if (event === 'push' && ref === `refs/heads/${this.config.base}`) this.sharedRef = null;
    if ((protectionEvents as readonly string[]).includes(event)) this.sharedProtection.clear();
  }
  private async readBaseBranch(): Promise<{ tip: string; tree: string }> {
    const tip = await this.refHead(this.config.base);
    return { tip, tree: await this.commitTree(tip) };
  }
  /**
   * The head commit GitHub shows for a branch ref right now (GY-854). The restore's read-back:
   * a record that claims a restored branch is written only when this answer is the restored
   * commit, so a write GitHub never reflected is a failure with this read as its evidence.
   */
  async refHead(branch: string): Promise<string> {
    const ref = await this.request(`/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
    const tip = ref?.object?.sha;
    demand(ref?.object?.type === 'commit' && typeof tip === 'string' && /^[a-f0-9]{40}$/.test(tip), `GitHub did not return a readable head for refs/heads/${branch}`, 502);
    return tip;
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
  async observe(work: Work, peers?: Work[], shared = true): Promise<Observation> {
    const startedAt = new Date().toISOString();
    const pr = await this.computedMergeability(await this.request(`/pulls/${work.submission!.pr}`));
    demand(pr.base.repo.full_name.toLowerCase() === this.config.repository.toLowerCase() && pr.head.repo?.full_name.toLowerCase() === this.config.repository.toLowerCase(), 'MVP requires same-repository pull requests');
    demand(pr.base.ref === this.config.base, 'Pull request targets an unmanaged branch');
    const [checks, reviews, protection, files, branch, rulesetChecks] = await Promise.all([
      this.pages(`/commits/${pr.head.sha}/check-runs?filter=all`, 'check_runs'), this.pages(`/pulls/${pr.number}/reviews`), this.branchProtection(nativeReviewRequired(work.policy), shared), this.pages(`/pulls/${pr.number}/files`), shared ? this.cycleBaseBranch() : this.baseBranch(),
      this.requiredStatusChecks(shared),
    ]);
    // Review threads are never a merge blocker in Graphyard's gate: the reviewer reads them itself
    // at launch and judges them in its verdict. The observation spends its one GraphQL read on them
    // only while protection still requires conversation resolution (drift, which GitHub enforces).
    const requiredChecks = mergeRequiredChecks([...protection.requiredChecks, ...rulesetChecks]);
    const statuses = pr.state === 'open' && !pr.merged ? await this.requiredStatuses(pr.head.sha, requiredChecks, work.policy.checks, checks, ciAppIdsOf(work)) : [];
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
    // With the published lane off, nothing reads the comparison, so an install that turned the lane
    // off pays no compare per (base, tip) pair per open pull request on every base move.
    const baseChanges = this.optimisticLaneEnabled === false || pr.merged || pr.state !== 'open' ? undefined : await this.baseChangesSince(bound, branch.tip);
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
    // A failing published tip carries its docs counts, from which a budget overflow is attributed (GY-574).
    const docsBudget = publishedTip && !pr.merged && pr.state === 'open' ? await this.tipDocs(work, pr.head.sha, bound, checks) : undefined;
    const confirmed = await this.request(`/pulls/${work.submission!.pr}`);
    demand(confirmed.head.sha === pr.head.sha && confirmed.base.sha === pr.base.sha && confirmed.base.ref === pr.base.ref && confirmed.head.ref === pr.head.ref
      && confirmed.state === pr.state && confirmed.draft === pr.draft && confirmed.merged === pr.merged, 'PR changed while collecting evidence; retry');
    return {
      candidate: { sha: pr.head.sha, baseSha: candidateBase, pr: pr.number, branch: pr.head.ref, author: pr.user.login, ...(Number.isFinite(Date.parse(pr.created_at)) ? { createdAt: pr.created_at } : {}) },
      // Canonical oldest-to-newest ordering makes legacy consumers deterministic;
      // gates also compare immutable run IDs rather than trusting response order.
      checks: checks.filter(c => c.name !== CHECK_NAME && c.name !== LANDABLE_CHECK).sort((a, b) => (a.id ?? 0) - (b.id ?? 0)).map(c => ({ name: c.name, result: c.status === 'completed' ? c.conclusion : c.status, appId: c.app.id,
        ...(Number.isSafeInteger(c.id) ? { id: c.id } : {}), ...(Number.isSafeInteger(c.run_attempt) ? { attempt: c.run_attempt } : {}) })).concat(statuses),
      ...(agentReview ? { agentReview } : {}),
      reviewIds: reviews.every(r => Number.isSafeInteger(r.id) && r.id > 0) ? reviews.map(r => r.id) : undefined,
      // Every review GitHub now reports dismissed, not only each identity's latest (GY-486): an
      // approval dismissed and then re-posted by the same identity is hidden behind the re-post in
      // `reviews`, and review-conflict.ts must still read it as withdrawn rather than standing.
      dismissedReviewIds: dismissedReviewIds(reviews),
      reviews: [...latest.values()].map(r => ({ id: r.id, reviewer: r.user.login, sha: r.commit_id, state: r.state, submittedAt: r.submitted_at,
        ...(r.state === 'CHANGES_REQUESTED' && typeof r.body === 'string' && r.body.trim() ? observedReviewBody(r.body) : {}),
        ...(r.state === 'DISMISSED' && dismissalOf(r.id) ? { dismissal: dismissalOf(r.id)! } : {}) })),
      prState: pr.state, draft: pr.draft, prCreatedAt: pr.created_at, merged: pr.merged, mergeSha: pr.merge_commit_sha, mergedAt: pr.merged_at, mergeable: pr.mergeable === true && !pr.draft && pr.state === 'open', conflicting: pr.mergeable === false && pr.state === 'open',
      ...(pr.mergeable === null && pr.state === 'open' && !pr.merged ? { mergeabilityUnknown: true } : {}),
      protected: protection.protected, requiredChecks, conversations, files: files.map(f => f.filename), at: startedAt,
      baseTip: branch.tip, baseTree: branch.tree, baseTipContained, baseTipAncestor: contained, scopeFiles,
      ...(landing ? { landing } : {}), ...(revertedDelivery ? { revertedDelivery } : {}), ...(baseChanges !== undefined ? { baseChanges } : {}), ...(docsBudget ? { docsBudget } : {}),
      ...(dismissals.forcePushes.length ? { headForcePushes: dismissals.forcePushes } : {}),
    };
  }
  /**
   * The docs word counts of a published queue tip whose required checks failed (GY-574): the tip's
   * own pages and those of the base it was built on, so the batch plan can attribute a docs-budget
   * overflow to the entry that crossed it instead of bisecting to the queue head. Only a failing
   * published tip is counted, and a page's words are read once per blob, so a passing queue costs
   * nothing and a failing tip costs its two trees and the pages it changed. `onlyFailure` is set when
   * no other required check failed; whether the suite's failure is the budget is read from the counts.
   * The budget and the pages it counts are the ones the tip's own graphyard.json configures; a tip
   * whose project keeps no budget carries no record, and its failure is bisected as before.
   */
  async tipDocs(work: Work, head: string, base: string, checks: { id?: number; name: string; status: string; conclusion: string | null }[]): Promise<TipDocs | undefined> {
    const required = new Set(work.policy.checks ?? []);
    const latest = new Map<string, string>();
    for (const check of [...checks].sort((a, b) => (a.id ?? 0) - (b.id ?? 0))) if (required.has(check.name) && check.status === 'completed') latest.set(check.name, check.conclusion ?? '');
    const failed = [...latest.values()].filter(result => failedCheckConclusions.has(result)).length;
    if (!failed) return undefined;
    // The counts only sharpen an ejection: a tip they cannot be read for is bisected as before, never left unobserved.
    try {
      const budget = await this.docsBudgetAt(head);
      if (!budget) return undefined;
      const [pages, before] = await Promise.all([this.docsWordCount(head, budget), this.docsWordCount(base, budget)]);
      return pages && before ? { sha: head, base: before, pages, onlyFailure: failed === 1, budget } : undefined;
    } catch (error) {
      console.error(`GitHub docs word counts for ${work.key} tip ${head.slice(0, 12)} were unreadable; its failure is bisected: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
  /** The files of a commit's tree, read once per commit; null when GitHub truncates the tree. */
  private async docsTree(ref: string): Promise<{ path: string; type: string; sha: string }[] | null> {
    const known = this.docsTrees.get(ref);
    if (known !== undefined) return known;
    const tree = await this.request(`/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    const files = tree?.truncated || !Array.isArray(tree?.tree) ? null : (tree.tree as { path: string; type: string; sha: string }[]).filter(entry => entry.type === 'blob');
    if (/^[a-f0-9]{40}$/.test(ref)) { this.docsTrees.set(ref, files); if (this.docsTrees.size > 64) this.docsTrees.delete(this.docsTrees.keys().next().value!); }
    return files;
  }
  private docsTrees = new Map<string, { path: string; type: string; sha: string }[] | null>();
  private async blobText(sha: string) {
    const blob = await this.request(`/git/blobs/${sha}`);
    return Buffer.from(String(blob?.content ?? ''), blob?.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
  }
  /** The documentation word budget a commit's committed graphyard.json configures; null when it keeps none. */
  async docsBudgetAt(ref: string): Promise<DocsWordBudget | null> {
    const config = (await this.docsTree(ref))?.find(entry => entry.path === repositoryConfigFile);
    if (!config) return null;
    // One configuration version is read once, however many tips carry it.
    if (!this.docsBudgets.has(config.sha)) { this.docsBudgets.set(config.sha, repositoryDocsBudget(await this.blobText(config.sha))); if (this.docsBudgets.size > 64) this.docsBudgets.delete(this.docsBudgets.keys().next().value!); }
    return this.docsBudgets.get(config.sha)!;
  }
  private docsBudgets = new Map<string, DocsWordBudget | null>();
  /** Words per page `budget` counts at a commit, as tests/docs-budget.test.ts counts them; null when GitHub truncates the tree. */
  async docsWordCount(ref: string, budget: DocsWordBudget): Promise<DocsWordCount | null> {
    const key = `${ref}:${JSON.stringify(budget)}`;
    const counted = this.docsCounts.get(key);
    if (counted) return counted;
    const files = await this.docsTree(ref);
    if (!files) return null;
    const pages = files.filter(entry => budgetedPage(entry.path, budget));
    const words = await boundedMap(pages, peerContainmentConcurrency, page => {
      const known = this.docsBlobWords.get(page.sha);
      if (known) return known;
      const reading = this.blobText(page.sha).then(docsWords);
      this.docsBlobWords.set(page.sha, reading);
      reading.catch(() => { if (this.docsBlobWords.get(page.sha) === reading) this.docsBlobWords.delete(page.sha); });
      if (this.docsBlobWords.size > ancestryEntries) this.docsBlobWords.delete(this.docsBlobWords.keys().next().value!);
      return reading;
    });
    const count: DocsWordCount = Object.fromEntries(pages.map((page, index) => [page.path, words[index]]));
    // A commit's pages never change: a tip observed again while it waits is counted once.
    if (/^[a-f0-9]{40}$/.test(ref)) { this.docsCounts.set(key, count); if (this.docsCounts.size > 64) this.docsCounts.delete(this.docsCounts.keys().next().value!); }
    return count;
  }
  private docsCounts = new Map<string, DocsWordCount>();
  /** Words per docs blob, shared while in flight: a blob never changes, so each page version is read from GitHub once. */
  private docsBlobWords = new Map<string, Promise<number>>();
  /**
   * The commit the candidate would land on, and what landing there would revert (see
   * merge-queue.ts LandingCheck). The judgement is the shared `landingCheck` below, over this
   * adapter's answers, so the soak world (tests/helpers/soak-world.ts) exercises the identical
   * code the production observer runs.
   */
  private async landingCheck(work: Work, head: string, files: any[], bound: string, speculative: string | null, branch: { tip: string; tree: string }, peers: Work[] | undefined, budget: { remaining: number }): Promise<LandingCheck> {
    return landingCheck({
      compare: (from, to, query = '') => this.request(`/compare/${from}...${to}${query}`),
      pull: pr => this.request(`/pulls/${pr}`),
      blobAt: (path, ref) => this.blobAt(path, ref),
      blobContent: sha => this.blobContent(sha),
      contains: (base, tip) => this.contains(base, tip),
      historySince: (base, tip) => this.historySince(base, tip),
    }, work, head, files, bound, speculative, branch, peers, budget);
  }
  /** True when the commit took the path from the content the pull request delivered: one of its parents still holds that exact blob. */
  private async revertsDelivered(commit: string, path: string, files: any[]): Promise<boolean> {
    const delivered = files.find(file => file.filename === path)?.sha;
    const detail = await this.request(`/commits/${commit}`);
    for (const parent of Array.isArray(detail?.parents) ? detail.parents : []) if (typeof parent?.sha === 'string' && await this.blobAt(path, parent.sha) === delivered) return true;
    return false;
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
   * refuses rather than passes. The judgement is shared (`compareScopeOf`), so the soak world
   * runs the identical code.
   */
  private async compareScope(plannedFiles: string[], files: any[], base: string, budget = { remaining: scopeLookupBudget }): Promise<ScopeFile[]> {
    return compareScopeOf(this, plannedFiles, files, base, budget);
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
  /** The bytes of a blob by sha (GY-863): the landing check merges the three versions of a contested path. A blob's content never changes, so it is asked of GitHub once. */
  async blobContent(sha: string): Promise<Buffer | null> {
    const known = this.blobContents.get(sha);
    if (known) return known;
    const entry = await this.request(`/git/blobs/${sha}`);
    demand(entry && typeof entry === 'object' && typeof entry.content === 'string', `GitHub did not return the content of blob ${sha.slice(0, 12)}`, 502);
    const content = entry.encoding === 'base64' ? Buffer.from(entry.content, 'base64') : Buffer.from(entry.content, 'utf8');
    this.blobContents.set(sha, content);
    return content;
  }
  /** Two fresh observations that must agree: the final check before a merge shares no cycle read (GY-806). */
  async verify(work: Work, peers?: Work[]): Promise<Observation> {
    const first = await this.observe(work, peers, false);
    const second = await this.observe(work, peers, false);
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
    // The tip is built on the scratch branch and the pull request's branch is moved once, to it
    // (GY-1087). Resetting the branch to the reviewed head and then merging onto it was two pushes:
    // GitHub raised a pull_request event for each, both resolved to the tip, CI's per-PR concurrency
    // cancelled one of the two runs, and when the later-created run was the one cancelled — before
    // any job started — GitHub read the head's required checks as expected for good (GY-1063:
    // "3 of 4 required status checks are expected"), so auto-merge never fired.
    let merged: string | null;
    try { merged = await this.mergeOnScratch(work.key, reviewedHead, placement.predictedBase!, `Graphyard speculative tip for ${work.key} behind ${placement.predecessors.join(', ') || this.config.base}`); }
    catch (error) {
      // A conflicting tip still leaves the branch at the item's own reviewed head, never at the
      // earlier tip and the predecessors it carries.
      if (error instanceof SpeculativeConflict && reviewedHead !== pr.head.sha) await this.updateBranch(pr.head.ref, reviewedHead);
      throw error;
    }
    const tip = merged ?? reviewedHead;
    if (tip !== pr.head.sha) await this.updateBranch(pr.head.ref, tip);
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
   *
   * The base tip is read here, at the restore, from the branch itself — never the base the request
   * or the candidate was recorded with (GY-854). And the restore is recorded done only after a
   * read-back shows GitHub's own branch at the commit the restore produced: a write GitHub does
   * not reflect (a refused push, branch protection, a ref left where it was) is a failure whose
   * reason the record carries, retried once, then escalated instead of a third attempt.
   */
  async restoreBranch(work: Work, restore: { contaminated: string; foreign: string[]; own: string | null; cause: BranchRestore['cause']; requested: BranchRestore['requested']; reason: string; previous?: BranchRestore | null }, beforeWrite: () => Promise<void> = async () => {}): Promise<BaseRefresh> {
    const candidate = work.candidate;
    demand(candidate && !work.queue && restore.contaminated === candidate.sha, 'An unqueued candidate whose head is the contaminated one is required');
    const pr = await this.request(`/pulls/${candidate!.pr}`);
    requireCurrent(pr.head.sha === candidate!.sha && pr.base.ref === this.config.base && pr.state === 'open' && pr.draft === false, 'Pull request changed before the branch restore; retry');
    const branch = await this.baseBranch();
    const at = new Date().toISOString();
    const own = restore.own ?? await this.ownReviewedHead(work, pr.head.sha);
    const previous = restore.previous ?? null;
    const attempts = (previous?.attempts ?? 0) + 1;
    // A second failed attempt with the candidate unchanged since is the repeat GY-854 escalates:
    // the record names it and no further attempt is offered. The bound is the attempt count, never
    // whether the two failures match — a refusal's text quotes the base tip or the produced commit,
    // and its kind can alternate (a refused merge, then a transient read-back failure), so a rule
    // that waits for two identical results would let differing failures repeat without limit.
    const repeated = (kind: RestoreFailureKind | null, failure: string | null): string | null =>
      previous?.failureKind && kind !== null
        ? `the restore failed twice without the candidate changing and stops repeating (${previous.failureKind === kind ? kind : `${previous.failureKind}, then ${kind}`}): ${previous.failure && previous.failure !== failure ? `${previous.failure}; then ${failure}` : failure}`
        : null;
    const record = (fields: Partial<BaseRefresh>, outcome: BranchRestore['outcome'], kind: RestoreFailureKind | null, failure: string | null, ownValue: string | null = own): BaseRefresh => {
      const repeat = repeated(kind, failure);
      return {
      from: { sha: ownValue ?? candidate!.sha, baseSha: candidate!.baseSha }, base: branch.tip, baseTree: branch.tree, policyRevision: work.policyRevision, at,
      head: outcome === 'unpublished' ? null : fields.head ?? ownValue ?? candidate!.sha, conflict: null, merge: null, carry: null,
      trigger: restore.cause === 'repair' ? 'repair' : 'ejection restore', ...fields,
      restore: { contaminated: restore.contaminated, foreign: restore.foreign, own: ownValue, cause: restore.cause, requested: restore.requested, reason: restore.reason, performedAt: at, outcome, attempts,
        ...(failure ? { failure } : {}), ...(kind ? { failureKind: kind } : {}), ...(repeat ? { escalated: repeat } : {}) } };
    };
    // A head that is not a tip of this item's own has the foreign commits under something a worker
    // pushed, or under nothing the record can name: nothing is moved, and the item says so.
    if (own === pr.head.sha) return record({}, 'unrepairable', null, null, null);
    // A write GitHub refuses is recorded as the failure it is, not retried inside the job: the
    // record is what lets a second attempt tell a lasting refusal from a transient one.
    const refused = (kind: RestoreFailureKind, reason: string): BaseRefresh => record({}, 'unpublished', kind, reason);
    await beforeWrite();
    // The restored commit is built on the scratch branch and the pull request's branch is moved
    // once, as a speculative tip is (GY-1087): one push, so one CI run binds to the restored head.
    let merged: string | null, conflict: string | null = null;
    try { merged = await this.mergeOnScratch(work.key, own, branch.tip, `Graphyard branch restore for ${work.key} onto ${this.config.base}`); }
    catch (error) {
      if (error instanceof SpeculativeConflict) { merged = null; conflict = error.message; }
      else if (!(error instanceof Refusal)) throw error;
      else return refused('merge refused', `the restore of ${pr.head.ref} stopped when base branch tip ${branch.tip.slice(0, 12)} was merged into it: ${error.message}`);
    }
    // A conflicting restore still moves the branch to the item's own reviewed head; the merge is the worker's.
    const produced = merged ?? own;
    // The same one-request window as in publishSpeculativeTip: a worker push between the head
    // check above and this forced update is overwritten by the restore. The head being restored
    // is one no worker may push over (a contaminated tip), the record names the head it moved
    // from, and the next observation reads the branch afresh.
    try { await this.updateBranch(pr.head.ref, produced); }
    catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return refused('branch reset refused', `the restore of ${pr.head.ref} stopped when the branch was reset to ${merged ? `the reviewed head ${own.slice(0, 12)} merged onto the base, ${produced.slice(0, 12)}` : `the reviewed head ${own.slice(0, 12)}`}: ${error.message}`);
    }
    if (conflict !== null)
      return record({ conflict: `Candidate ${candidate!.sha.slice(0, 12)} was restored to its own reviewed head ${own.slice(0, 12)}, which cannot be brought onto base branch tip ${branch.tip.slice(0, 12)} without resolving a conflict, which is content nobody reviewed or proved: ${conflict}. Run graphyard sync ${work.key}, resolve it and push.` }, 'conflict', 'conflict', `the reviewed head ${own.slice(0, 12)} cannot be brought onto base branch tip ${branch.tip.slice(0, 12)} without resolving a conflict: ${conflict}`);
    // The restore is done only when GitHub itself shows the branch at the commit it produced
    // (GY-854): a push GitHub does not reflect has happened, and a record that claimed it anyway
    // left the item waiting at a head no observation would ever read.
    let shown: string;
    try { shown = await this.refHead(pr.head.ref); }
    catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return refused('read-back failed', `the restore of ${pr.head.ref} could not be read back after its writes: ${error.message}`);
    }
    if (shown !== produced)
      return refused('read-back mismatch', `the restore of ${pr.head.ref} wrote the restored commit ${produced.slice(0, 12)} but GitHub shows the branch at ${shown.slice(0, 12)}`);
    return record({ head: produced, merge: merged ? await this.describeMerge(own, merged, own, branch.tip) : null }, 'restored', null, null);
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
   * deleted afterwards. Returns the conflict, or null when the merge is clean.
   *
   * GitHub has no read-only merge check. The compare API reports ancestry, never a conflict, and
   * the merges API merges only into a branch, so the scratch ref must live under refs/heads.
   * `[skip ci]` keeps the scratch merge commit from starting a workflow; the branch creation itself
   * is a push that `on: push` workflows and branch rulesets see. A ruleset refusal fails the job
   * with GitHub's refusal, and a failed delete is logged, not hidden (GY-390).
   */
  async testMerge(key: string, head: string, base: string): Promise<string | null> {
    try {
      await this.mergeOnScratch(key, head, base, `Graphyard merge check for ${key} [skip ci]`);
      return null;
    } catch (error) {
      if (!(error instanceof SpeculativeConflict)) throw error;
      return error.message;
    }
  }
  /**
   * Merges `base` onto `head` on the item's scratch branch and returns the merge commit, or null
   * when `head` already contains `base`; a conflict throws SpeculativeConflict. No branch a pull
   * request, a person or a check reads is written (GY-1087): the caller moves the pull request's
   * branch to the result in one push, so GitHub starts one set of workflow runs for the new head.
   */
  async mergeOnScratch(key: string, head: string, base: string, message: string): Promise<string | null> {
    const branch = mergeCheckBranch(key);
    await this.publishRef(`refs/heads/${branch}`, head);
    try { return await this.mergeBranch(branch, base, message); }
    finally {
      // A scratch branch left behind by a failed delete is overwritten by the next merge, but it
      // is visible in the repository until then, so the failure is named.
      await this.request(`/git/refs/heads/${branch}`, 'DELETE').catch(error => console.error(`Graphyard could not delete merge-check branch ${branch}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  /**
   * GitHub's "rerun failed jobs" for the workflow run that produced check run `checkRunId` (GY-516).
   * An Actions check run's id is its job's id, which names the run; only the failed jobs rerun, on
   * the same sha, so the rerun's check run is the one the gates read next.
   */
  async rerunFailedJobs(checkRunId: number): Promise<{ runId: number; attempt?: number }> {
    const job = await this.request(`/actions/jobs/${checkRunId}`);
    demand(Number.isSafeInteger(job?.run_id), `Check run ${checkRunId} is not a GitHub Actions job; it cannot be rerun`);
    await this.request(`/actions/runs/${job.run_id}/rerun-failed-jobs`, 'POST', {});
    return { runId: job.run_id, ...(Number.isSafeInteger(job.run_attempt) ? { attempt: job.run_attempt } : {}) };
  }
  /**
   * The workflow run a rerun was requested on (GY-1096): its status (`queued`, `waiting`,
   * `in_progress`, `completed`, ...), conclusion and current attempt, or null when GitHub has none.
   */
  async rerunWorkflowRun(runId: number): Promise<RerunWorkflowRun | null> {
    let run: any;
    try { run = await this.request(`/actions/runs/${runId}`); }
    catch (error) { if (error instanceof Refusal && /\(404\)/.test(error.message)) return null; throw error; }
    demand(typeof run?.status === 'string', `GitHub did not return a readable workflow run ${runId}`, 502);
    return { status: run.status, conclusion: typeof run.conclusion === 'string' ? run.conclusion : null, attempt: Number.isSafeInteger(run.run_attempt) ? run.run_attempt : null };
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
  async enqueuePullRequest(state: GitHubMergeQueueState, sha: string, mergeNow = false) {
    if (state.queue) return void await this.graphql(enqueueMutation, { id: state.pullRequestId, head: sha });
    const variables = { id: state.pullRequestId, head: sha, method: autoMergeMethod() };
    if (mergeNow || mergeableNow(state)) return void await this.graphql(headBoundMergeMutation, variables);
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
    await this.upsertLandable(landableCarried(work, audit.head, body.output.title, body.output.summary));
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
    return (await this.pages(`/commits/${sha}/check-runs?filter=all`, 'check_runs')).filter(check => check.name !== CHECK_NAME && check.name !== LANDABLE_CHECK)
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
    // A verdict already standing is not republished on every guard tick; the merge request below is.
    if (!(existing?.status === body.status && existing.conclusion === body.conclusion && existing.external_id === body.external_id
      && existing.output?.title === body.output.title && existing.output?.summary === body.output.summary)) {
      await this.request(existing ? `/check-runs/${existing.id}` : '/check-runs', existing ? 'PATCH' : 'POST', body);
    }
    await this.upsertLandable(landableCarried(work, revert.head, body.output.title, body.output.summary));
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
    const summary = `Merge group for ${work.key}: candidate ${work.candidate!.sha}; base ${work.candidate!.baseSha}; policy ${work.policyRevision}`;
    // The group commit carries the authorized head's landability verdict too (GY-887): branch protection requires both.
    await this.upsertLandable(landableCarried(work, groupHead, 'Landable', summary));
    const existing = (await this.pages(`/commits/${groupHead}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=latest`, 'check_runs')).find(c => c.app.id === this.config.appId);
    if (existing?.status === 'completed' && existing.conclusion === 'success' && existing.external_id === work.id) return;
    const body = { name: CHECK_NAME, head_sha: groupHead, status: 'completed', conclusion: 'success', external_id: work.id,
      output: { title: 'All required gates passed', summary } };
    await this.request(existing ? `/check-runs/${existing.id}` : '/check-runs', existing ? 'PATCH' : 'POST', body);
  }
  /**
   * GY-887. Publishes the landability verdict as `graphyard/landable` on the candidate head
   * (landable-check.ts): created on a new head, updated when the verdict or its reasons change, and
   * left alone when the published run already says the same. Success is written only while the pull
   * request still has that head on that base, as `publish` writes its own.
   */
  async publishLandable(work: Work, all: Work[], beforeWrite: (success: boolean) => Promise<void> = async () => {}) {
    const body = landableCheckRun(work, all, new Date());
    if (!body) return;
    const success = body.conclusion === 'success';
    if (success) {
      const pr = await this.request(`/pulls/${work.candidate!.pr}`);
      requireCurrent(pr.head.sha === work.candidate!.sha && this.boundBase(work, pr, await this.baseBranch()) === work.candidate!.baseSha, 'PR changed before the landability check was published; retry');
    }
    await this.upsertLandable(body, () => beforeWrite(success));
  }
  /** Creates or updates this App's `graphyard/landable` run on a head; an identical standing run is not rewritten. */
  async upsertLandable(body: LandableCheckRun, beforeWrite: () => Promise<void> = async () => {}) {
    const existing = (await this.pages(`/commits/${body.head_sha}/check-runs?check_name=${encodeURIComponent(LANDABLE_CHECK)}&filter=latest`, 'check_runs')).find(c => c.name === LANDABLE_CHECK && c.app?.id === this.config.appId);
    if (landableCheckCurrent(existing, body)) return;
    await beforeWrite();
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
/**
 * Required checks by name, deduplicated, without Graphyard's own merge check (GY-430) or its
 * landability verdict (GY-887): the verdict is computed from these, so requiring itself would
 * refuse every candidate forever once protection lists it.
 */
export function mergeRequiredChecks(checks: { name: unknown; appId: unknown }[]): { name: string; appId: number | null }[] {
  const merged = new Map<string, { name: string; appId: number | null }>();
  for (const check of checks) {
    if (typeof check.name !== 'string' || !check.name || check.name === CHECK_NAME || check.name === LANDABLE_CHECK) continue;
    const appId = Number.isSafeInteger(check.appId) ? check.appId as number : null;
    const known = merged.get(check.name);
    // A check some rule binds to no app is satisfied by any source, so the looser binding stands.
    merged.set(check.name, { name: check.name, appId: known && (known.appId === null || known.appId !== appId) ? null : appId });
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The GitHub answers the landing check reads: compare listings, a pull request record, blob
 * identity, ancestry, and the commits one side holds over another. The production adapter
 * answers them from the REST API; the soak world (tests/helpers/soak-world.ts) answers them
 * from its simulated repository, so both run the identical landing judgement.
 */
export interface LandingGitHub {
  /** GitHub's `GET /compare/from...to` answer; `query` is the `?…` search string or empty. */
  compare(from: string, to: string, query?: string): Promise<any>;
  /** GitHub's `GET /pulls/:number` answer, or null when there is no such pull request. */
  pull(pr: number): Promise<any>;
  /** Blob identity of a path at a commit, or null when that commit holds no file there. */
  blobAt(path: string, ref: string): Promise<string | null>;
  /**
   * The bytes of a blob by sha (GY-863), or null when they cannot be had. Optional: the merge-result
   * judgement of the landing check needs the three versions' contents, and a provider view that
   * cannot produce them keeps the conservative blob-identity comparison.
   */
  blobContent?(sha: string): Promise<Buffer | null>;
  /** Whether `head` contains `base` by ancestry. */
  contains(base: string, head: string): Promise<boolean>;
  /** The commits `head` holds that `base` does not, or null when GitHub's list is truncated. */
  historySince(base: string, head: string): Promise<Set<string> | null>;
}
/**
 * The commit the candidate would land on, and what landing there would revert (see
 * merge-queue.ts LandingCheck). A tip published behind entries that have not landed lands on
 * its predicted base, which is its bound base; everything else lands on the live branch head.
 * A base that differs from the bound one only by commit, not by tree, needs no second
 * comparison. The answer about carried candidates is reused while the head, the landing commit
 * and every open candidate it was decided against are unchanged.
 */
export async function landingCheck(github: LandingGitHub, work: Work, head: string, files: any[], bound: string, speculative: string | null, branch: { tip: string; tree: string }, peers: Work[] | undefined, budget: { remaining: number }): Promise<LandingCheck> {
  const speculation = work.queue?.speculation;
  const predicted = !!speculative && speculative !== branch.tip && speculation!.baseTree !== branch.tree && speculation!.predecessors.length > 0 && await github.contains(branch.tip, speculative);
  const base = predicted ? speculative! : branch.tip;
  const sameTree = base === bound || !!speculative && speculation!.baseTree === branch.tree;
  // Use the landing base's merge base with the head, not the two endpoint trees (or a PR
  // file list computed against another base). A path only the base changed is inherited by
  // a three-way merge; it is not this candidate restoring its older copy of that path.
  // Recompute even for an unchanged head: an old observation may contain a false refusal.
  const landed = predicted || !sameTree ? await landingDiff(github, base, head, predicted ? undefined : files) : null;
  const landing: LandingCheck = { base, ...(landed ? { files: await compareScopeOf(github, work.plannedFiles ?? [], landed.files, base, budget) } : {}) };
  if (landed) await decideLandingMerges(github, work.plannedFiles ?? [], landing.files!, landed.mergeBase, budget);
  if (!peers) return landing;
  const open = peers.filter(peer => peer.id !== work.id && peer.stage !== 'done' && !!peer.submission && !!peer.candidate && peer.candidate.sha !== head
    && !!peer.observation && !peer.observation.merged && peer.observation.prState !== 'closed' && peer.observation.candidate.sha === peer.candidate.sha);
  // A peer is in this head's history by its current head, or by the reviewed head under a tip
  // of its own: the tip a queue republishes changes, the reviewed head under it does not.
  landing.examined = open.map(peer => `${peer.key}@${ownHeads(peer).join('+')}`).sort();
  const previous = work.observation && work.observation.candidate.sha === head ? work.observation.landing : undefined;
  // An answer recorded before landed peers were asked about (GY-744) may name one unlanded: it is asked again.
  if (previous?.carried && previous.foreign && previous.landed && previous.base === base && JSON.stringify(previous.examined) === JSON.stringify(landing.examined) && !previous.carried.some(entry => entry.unverified)) return { ...landing, carried: previous.carried, foreign: previous.foreign, landed: previous.landed };
  const carried: CarriedCandidate[] = [];
  const foreign: ForeignCandidate[] = [];
  const onBase: LandedCandidate[] = [];
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
  const added = await github.historySince(base, head);
  const containment = await boundedMap(open, peerContainmentConcurrency, async peer => {
    if (ahead.has(peer.key)) return false;
    for (const sha of ownHeads(peer)) {
      if (!added) { if (await github.contains(sha, head)) return true; continue; }
      if (added.has(sha)) return true;
      if (await github.contains(sha, base) && await github.contains(sha, head)) return true;
    }
    return false;
  });
  for (const [index, peer] of open.entries()) {
    if (!containment[index]) continue;
    // The owning item's record says unlanded; git decides (GY-744).
    const merged = await landedOn(github, peer, branch.tip);
    if (merged) { onBase.push(merged); continue; }
    foreign.push({ key: peer.key, pr: peer.candidate!.pr, head: peer.candidate!.sha });
    const entry: CarriedCandidate = { key: peer.key, pr: peer.candidate!.pr, head: peer.candidate!.sha, dropped: [] };
    for (const file of peer.observation!.scopeFiles ?? []) {
      // A file this item planned is its own to change, whoever else touched it.
      if (inPlannedScope(work.plannedFiles ?? [], file.path)) continue;
      if ((budget.remaining -= 2) < 0) { entry.unverified = true; break; }
      const held = await github.blobAt(file.path, head);
      if (file.status !== 'removed' && held === file.sha) continue;
      // Neither the owner's version nor anything new: exactly what the landing commit holds, so
      // the owner's change is in this head's history and absent from its tree.
      if (held !== await github.blobAt(file.path, base) || file.status === 'removed' && held === null) continue;
      entry.dropped.push({ path: file.path, detail: held === null ? 'the file is absent from this head and from the commit it would land on' : 'the file is held exactly as the commit it would land on holds it' });
    }
    if (entry.dropped.length || entry.unverified) carried.push(entry);
  }
  return { ...landing, carried, foreign, landed: onBase };
}
/**
 * GY-744. Whether a peer's pull request is already on the base branch tip, whatever its item
 * records: one of its own heads is an ancestor of the tip, or GitHub reports it merged with a
 * merge commit the tip holds (a squash or rebase merge leaves the head itself off the branch).
 * The merge commit counts only for a pull request merged at a head its item recorded (GY-756): one
 * force-pushed past the recorded head and merged ships content Graphyard never saw, so the recorded
 * head is not landed by it and its files stay under the guard.
 */
async function landedOn(github: LandingGitHub, peer: Work, tip: string): Promise<LandedCandidate | null> {
  const pr = peer.candidate!.pr, head = peer.candidate!.sha;
  const heads = ownHeads(peer);
  let ancestor = false;
  for (const sha of heads) if (await github.contains(sha, tip)) { ancestor = true; break; }
  const pull = await github.pull(pr);
  const mergeSha = pull?.merged && typeof pull.merge_commit_sha === 'string' && heads.includes(pull.head?.sha) ? pull.merge_commit_sha as string : null;
  if (!ancestor && !(mergeSha && await github.contains(mergeSha, tip))) return null;
  return { key: peer.key, pr, head, mergeSha };
}
/**
 * Only changes the head makes since its merge base with the landing commit can affect the
 * landing tree. Explicitly compare from that ancestor: an endpoint diff also lists the base's
 * own new changes in reverse. A missing merge-base answer retains the conservative comparison;
 * it never licenses dropping a file. A capped list remains unverified, even after filtering.
 */
async function landingDiff(github: Pick<LandingGitHub, 'compare'>, base: string, head: string, fallback?: any[]): Promise<{ mergeBase: string | null; files: any[] }> {
  let comparison = await github.compare(base, head);
  const ancestor = comparison?.merge_base_commit?.sha;
  const mergeBase = typeof ancestor === 'string' && /^[a-f0-9]{40}$/.test(ancestor) && ancestor !== base ? ancestor : null;
  if (mergeBase) comparison = await github.compare(mergeBase, head);
  demand(Array.isArray(comparison?.files), `GitHub did not list the files changed between ${base.slice(0, 12)} and ${head.slice(0, 12)}`, 502);
  // Without ancestry metadata, retain all changes the previous live-base check knew about.
  if (!mergeBase && fallback) comparison = { files: [...new Map([...comparison.files, ...fallback].map(file => [file.filename, file])).values()] };
  return { mergeBase, files: comparison.files.length < compareFileCap ? comparison.files
    : [...comparison.files, { filename: `(the comparison lists ${compareFileCap} files or more; the rest were not compared)`, status: 'unchanged', additions: 0, deletions: 0, uncompared: true }] };
}
/**
 * GY-863. The landing guard judges each examined file by the three-way merge result of the head
 * onto the landing commit, not by the head's blob: a branch carrying an earlier version of a
 * change the commit has since extended merges to exactly what the commit holds, and is not the
 * candidate reverting it. Blob identity settles every file the merge base and the commit hold
 * identically, or the head holds as the commit does; the rest are merged line by line
 * (`threeWayMerge`) from the three blobs' contents, and a clean merge that reproduces the
 * commit's own version is recorded as `mergeSha` for the guard to match against `baseSha`. A
 * conflict, a difference, and anything the budget, the size caps or GitHub leave unanswered all
 * stand as the conservative blob-identity refusal: the judgement only ever clears a file that
 * provably lands as the commit already holds it.
 */
const mergeContentCap = 512 * 1024;
async function decideLandingMerges(github: LandingGitHub, plannedFiles: string[], files: ScopeFile[], mergeBase: string | null, budget: { remaining: number }): Promise<void> {
  if (!mergeBase || !github.blobContent) return;
  for (const file of files) {
    if (inPlannedScope(plannedFiles, file.path) || file.baseSha === undefined || file.baseSha === null || file.sha === null || file.baseSha === file.sha) continue;
    if (budget.remaining < 1) return;
    const ancestor = await github.blobAt(file.path, mergeBase);
    budget.remaining -= 1;
    if (ancestor === null || ancestor === file.baseSha || ancestor === file.sha) continue;
    if (budget.remaining < 3) return;
    budget.remaining -= 3;
    const [baseContent, headContent, landingContent] = await Promise.all([github.blobContent(ancestor), github.blobContent(file.sha), github.blobContent(file.baseSha)]);
    if (!baseContent || !headContent || !landingContent) continue;
    if (baseContent.length > mergeContentCap || headContent.length > mergeContentCap || landingContent.length > mergeContentCap) continue;
    // A NUL byte is git's own binary marker, and a byte-level merge of binary files is not judged here.
    if (baseContent.includes(0) || headContent.includes(0) || landingContent.includes(0)) continue;
    const merged = threeWayMerge(baseContent, landingContent, headContent);
    if (merged.clean && merged.content !== null && merged.content.equals(landingContent)) file.mergeSha = file.baseSha;
    // The baseline lands as the merge result: judged by the lines it adds to what the commit holds (GY-1023).
    else if (merged.clean && merged.content !== null && file.path === timingBaselinePath) file.companion = timingBaselineCompanion(landingContent.toString('utf8'), merged.content.toString('utf8'), changedTestFiles(files));
  }
}
/**
 * The provider's PR diff is taken against the merge base. The regression guard needs every
 * file outside the planned scope compared with the commit the candidate is bound to (the base
 * branch tip, or the predicted base of a published speculative tip), so those paths are looked
 * up there by blob identity. Paths beyond the lookup budget stay uncompared, which the guard
 * refuses rather than passes.
 */
async function compareScopeOf(github: Pick<LandingGitHub, 'blobAt' | 'blobContent'>, plannedFiles: string[], files: any[], base: string, budget = { remaining: scopeLookupBudget }): Promise<ScopeFile[]> {
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
  const found = await boundedMap(wanted, peerContainmentConcurrency, want => github.blobAt(want.path, base));
  wanted.forEach((want, index) => { want.entry[want.field] = found[index]; });
  // The timing baseline is judged by its lines, not its blob (GY-1023): two content reads from the same budget.
  if (github.blobContent && budget.remaining >= 2) {
    const read = github.blobContent.bind(github);
    await judgeTimingCompanion(compared, async sha => { budget.remaining -= 1; const content = await read(sha).catch(() => null); return content && content.length <= mergeContentCap ? content.toString('utf8') : null; }, path => inPlannedScope(plannedFiles, path));
  }
  return compared;
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
    if (action.kind === 'enqueue') { await beforeWrite(); await github.enqueuePullRequest(state, work.candidate.sha, action.mergeNow); }
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
/**
 * One tick with a revert not landed at once (a required merge queue, for example): recorded as its
 * own `optimistic.revert.pending` step instead of the guard republishing and re-requesting in
 * silence every 30 s (GY-518). The first tick records, and it records again only when the revert
 * turns `overdue` — a revert that has now waited longer than the CI duration observed on the
 * culprit's own merge commit, the brief's attention threshold (floored at two guard ticks so a
 * fast suite never flags within the same tick it was observed in).
 */
async function recordRevertPending(engine: Pick<Engine, 'store'>, guard: Extract<GuardState, { state: 'reverting' }>, now: Date): Promise<void> {
  const culprit = (await engine.store.list()).find(item => item.id === guard.culprit.id)?.optimisticMerges?.find(entry => entry.mergeSha === guard.culprit.mergeSha);
  const observedCiMs = culprit?.postMerge?.observedAt ? Math.max(0, Date.parse(culprit.postMerge.observedAt) - Date.parse(guard.culprit.mergedAt)) : null;
  const waitedMs = Math.max(0, now.getTime() - Date.parse(guard.revert.at));
  const details = { key: guard.culprit.key, mergeSha: guard.culprit.mergeSha, pr: guard.revert.pr, head: guard.revert.head,
    waitedMs, thresholdMs: Math.max(observedCiMs ?? 0, 2 * mainGuardIntervalMs), overdue: waitedMs > Math.max(observedCiMs ?? 0, 2 * mainGuardIntervalMs), at: now.toISOString() };
  // Postgres returns jsonb objects with their keys reordered, so the identity is built from values, never serialized objects.
  const last = (await engine.store.pool.query("SELECT payload->'details' AS details FROM events WHERE work_id IS NULL AND kind='optimistic.revert.pending' ORDER BY seq DESC LIMIT 1")).rows[0]?.details;
  if (last && last.key === details.key && last.pr === details.pr && last.head === details.head && last.overdue === details.overdue) return;
  await engine.store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', ['graphyard', 'optimistic.revert.pending', JSON.stringify({ details })]);
}
export async function guardMain(engine: Pick<Engine, 'store' | 'ciAppIds' | 'recordPostMerge' | 'recordOptimisticRevert'>, github: Pick<GitHub, 'commitChecks' | 'openRevert' | 'mergeRevert' | 'baseBranch' | 'permissionShortfall'>, now = new Date()): Promise<GuardState> {
  const required = (work: Work) => work.policy.checks;
  const items = await engine.store.list();
  let wrotePostMerge = false;
  for (const work of items) {
    const merge = currentOptimisticMerge(work);
    if (!merge || (merge.postMerge && merge.postMerge.verdict !== 'pending')) continue;
    await engine.recordPostMerge(work.id, merge.mergeSha, postMergeVerdict(await github.commitChecks(verdictCommit(merge)), required(work), engine.ciAppIds));
    wrotePostMerge = true;
  }
  // Nothing recorded: the reading above is still exactly what the guard judges, so the pass
  // reuses it instead of listing every work item twice per tick.
  let all = wrotePostMerge ? await engine.store.list() : items;
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
    } else await recordRevertPending(engine, held, now);
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
  if (!placement || placement.current || !placement.publishable || engine.parallelTips > 0 && placement.position >= engine.parallelTips) return { work, published: false, held: null };
  // Publishing a tip writes a merge commit and a ref; without Contents: write the call can
  // only 403. The entry keeps its place and waits for the permission instead of retrying.
  const held = hold('merge-queue');
  if (held) return { work, published: false, held };
  try {
    const speculation = await github.publishSpeculativeTip(work, placement, guard(work, false));
    return { work: await engine.bindSpeculativeTip(work.id, work.revision, speculation, job.token), published: true, held: null };
  } catch (error) {
    if (!(error instanceof SpeculativeConflict)) throw error;
    return { work: await engine.ejectFromQueue(work.id, work.revision, error.message, job.token, true), published: false, held: null };
  }
}
/**
 * Answers one in-flight candidate that GitHub reports conflicting with the base branch tip. The
 * queue owns its own entries, so this is every other submitted candidate. Since GY-375 nothing is
 * written to the candidate's branch: a test merge on a scratch branch either disproves GitHub's
 * reading, which is recorded, or confirms the conflict, which goes back to the worker.
 */
async function refreshBase(engine: Engine, github: GitHub, work: Work, job: { work_id: string; token: string }, guard: (snapshot: Work, success: boolean) => () => Promise<void>, hold: (feature: PermissionFeature) => string | null) {
  // The refresh's test merge creates and writes a scratch branch; without Contents: write the
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
  const repair = 'cause' in owed!;
  const request = repair ? owed : { ...owed!, cause: 'ejection' as const, requested: null };
  // A retry of an ejection restore carries the record of the attempt before it, so a second
  // failure escalates, whatever its kind, in the record instead of a third attempt running (GY-854).
  const previous = repair ? null : owed!.previous ?? null;
  const refresh = await github.restoreBranch(work, { contaminated: request.contaminated, foreign: request.foreign, own: request.own, cause: request.cause, requested: request.requested, reason: request.reason, previous }, guard(work, false));
  const updated = await engine.bindBranchRestore(work.id, work.revision, refresh, job.token);
  return { work: updated, published: refresh.head !== null && refresh.head !== request.contaminated, held: null };
}
/** A held job waits this long before one bounded re-check, unless a preflight sees the installation change first. */
export const permissionHoldMs = 30 * 60_000;
/** Commit-pair ancestry answers kept; each is immutable, so the bound only limits memory. */
export const ancestryEntries = 16384;
/** Commit-pair histories kept; each is immutable. */
export const historyEntries = 2048;
/** Whole immutable responses kept (commits by SHA, compares of two SHAs); the oldest-used is evicted past this. */
export const immutableEntries = 4096;
/** The JSON text the immutable hot layer retains in all, and the most one answer may take of it; a larger answer is served from the persisted layer. */
export const immutableBytes = 64 * 1024 * 1024, immutableValueBytes = 8 * 1024 * 1024;
/**
 * The immutable hot layer: JSON text bounded by entries and bytes. `set` takes a parsed answer, as the
 * persisted layer loads it, or text already kept; `get` returns the text, which each caller parses afresh.
 */
class ImmutableCache extends BoundedCache<string> {
  constructor() { super(immutableEntries, immutableBytes, immutableValueBytes, text => 2 * text.length); }
  override set(key: string, value: unknown) { return super.set(key, typeof value === 'string' ? value : JSON.stringify(value)); }
}
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
/**
 * The merge band: the items observed every `headObservationSeconds`, an authorized merge-stage item
 * or the merge-queue head. One definition serves the release's cadence and the poll skip
 * (GY-1052), so a skip never defers an item the release would observe at the merge cadence. It is
 * narrower than the claim band (`max(mergeBatchSize, parallelTips)`), which orders claims only:
 * entries behind the head poll at the active cadence, and a skip defers them no longer than that.
 */
async function inMergeBand(work: Work | undefined, queue: () => Promise<Work[]>, now = Date.now()) {
  if (!work || work.stage !== 'merge') return false;
  if (mergeAuthorized(work)) return true;
  return !!work.queue && queuePlacement(work, await queue(), now)?.position === 0;
}
export const idleObservationSeconds = 300;
/**
 * How old an observation may be and still serve the merge gate: the freshness the publication
 * guard demands of the record it publishes, and the lag past which `master status` names the
 * queue head as unobserved (GY-492).
 */
export const observationFreshnessMs = 120_000;
/** Consecutive permission refusals a job may retry at the normal cadence before it is held. */
export const permissionRefusalLimit = 3;
/** How often the job loop re-reads the merge-queue settings the master published (GY-330, GY-516). */
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
  // A resync is the wait for a fresher reading itself (a first reading has its own tier): unnamed, it was
  // claimed only after every named starved job, and under a paced budget never (2026-09-26: GY-393, GY-430 for 3 h).
  return kind === 'request-rework' || kind === 'request-review' || (kind === 'resync' && !firstObservationOwed(work));
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
export function observationThroughputStatus(coordinator: { githubBudget?: ({ throughput?: { jobsPerMinute?: number; medianDurationMs?: number | null; p90DurationMs?: number | null } | null } & Partial<Pick<GitHubBudget, 'remaining' | 'limit' | 'resetAt' | 'perMinute' | 'projectedExhaustionAt' | 'exhaustsBeforeReset' | 'reserve' | 'tokens' | 'billable'>> & { pace?: Partial<GitHubBudget['pace']> | null }) | null } | null | undefined,
  snapshot: { work: Work[]; now: string; jobs?: IntegrationJob[] }, now = Date.parse(snapshot.now)) {
  const throughput = coordinator?.githubBudget?.throughput ?? null;
  const reading = coordinator?.githubBudget ?? null;
  // The budget the workers are paced against (GY-567): what is left, when it resets, the spend
  // rate, the pace allowed, and when the spend rate would exhaust it.
  const budget = reading ? { remaining: reading.remaining ?? null, limit: reading.limit ?? null, resetAt: reading.resetAt ?? null, reserve: reading.reserve ?? null,
    perMinute: reading.perMinute ?? null, pacedPerMinute: reading.pace?.perMinute ?? null, paceTier: reading.pace?.tier ?? null,
    projectedExhaustionAt: reading.projectedExhaustionAt ?? null, exhaustsBeforeReset: !!reading.exhaustsBeforeReset,
    // Each token's own remaining, reset and projection at that reset (GY-690).
    tokens: (reading.tokens ?? []).map(token => ({ token: token.token, current: token.current, remaining: token.remaining, resetAt: token.resetAt, perMinute: token.perMinute, otherPerMinute: token.otherPerMinute, projectedAtReset: token.projectedAtReset, belowReserveAtReset: token.belowReserveAtReset })),
    // Billable requests over the last hour against the hourly budget, by endpoint (GY-806).
    billable: reading.billable ?? null } : null;
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
  // The batch size, the rerun count (GY-516) and the optimistic exclude globs (GY-503) are the
  // master's configuration, published to the installation ledger; a restarted server reads them
  // back here before the next evaluation it runs.
  const readAt = batchSizeRead.get(engine);
  if (readAt === undefined || Date.now() - readAt >= mergeBatchSizeRefreshMs) {
    batchSizeRead.set(engine, Date.now());
    await Promise.all([engine.loadMergeBatchSize(), engine.loadParallelTips(), engine.loadRerunFailedChecks(), engine.loadOptimisticExclude()]).catch(() => batchSizeRead.delete(engine));
  }
  // The observation spends its base compare only while the published setting keeps the lane on.
  github.optimisticLaneEnabled = engine.optimisticMerge;
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
  // The order above is computed from this pre-claim snapshot (GY-492): queue positions can shift
  // before `takeJob`, so the order can name an entry already out of the band — harmless today,
  // priority being advisory and the publication guard rechecking ownership; re-read after the
  // claim only if claim order ever gains a correctness role.
  const all = await engine.store.list();
  // The band spans the parallel-tip window too (GY-498): every entry validated at once is claimed first.
  // A job an observation webhook made due is claimed ahead of all of it by `takeJob` itself (GY-806).
  const band = Math.max(engine.mergeBatchSize, engine.parallelTips);
  // One instant places the queue for both the claim order and the skip's band (GY-1052), so the two
  // never disagree about an entry whose placement turns on a deadline.
  const placedAt = Date.now();
  const job = await engine.store.takeJob(observationClaimOrder(all, band, placedAt, budgetTight(github.budget?.())), observationHeadCount(all, band));
  if (!job) return false;
  const viaWebhook = job.webhook === true;
  // A poll of an item a webhook-driven observation refreshed within its poll interval is skipped
  // (GY-806): nothing is asked of GitHub, and the job is due again when that interval ends. A job
  // woken by a state change or a webhook is never skipped. The refresh is the job row's, so the
  // replica that claims the poll need not be the one that made the refresh.
  // The band is read again at skip time (GY-1052): an item that entered the merge band since the
  // refresh is observed at the merge cadence, not left until the longer interval the refresh used.
  // A skip re-reads the claimed item after the claim, so an item that entered the band between
  // the pre-claim snapshot and `takeJob` is not deferred for one more interval. The re-read is
  // targeted: the item by its id, and the live queue entries only when its queue position decides.
  const skippable = !job.woken && !viaWebhook && job.refreshed && job.refreshed_until
    && !await inMergeBand(all.find(entry => entry.id === job.work_id), async () => all, placedAt);
  const refreshedUntil = skippable && !await inMergeBand(await engine.store.workItem(job.work_id), () => engine.store.queuedWork(), placedAt)
    ? new Date(job.refreshed_until!).getTime() : null;
  if (refreshedUntil !== null) {
    await engine.store.deferJob(job.work_id, job.token, new Date(refreshedUntil).toISOString(), `poll skipped: a webhook refreshed this item; next poll ${new Date(refreshedUntil).toISOString()}`, null);
    return true;
  }
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
      // A peer git shows landed while its item records it unlanded is delivered now (GY-744).
      await engine.reconcileLanded(observation, all, peer => github.observe(peer, all));
      schedule.cadence = observationCadence(work, all.map(item => item.id === work!.id ? work! : item), now, previous, github.steadyStateMs?.(now.getTime()));
      // A required check that failed on this candidate is rerun once before it counts (GY-516): the
      // observation recorded the rerun as owed, holding the entry's position; GitHub is asked here,
      // outside any transaction, and its answer recorded. A refusal lets the failure stand at once.
      for (const owed of owedCheckReruns(work, engine.ciAppIds)) {
        const rerunHold = hold('check-rerun');
        if (rerunHold) { held ??= rerunHold; break; }
        let outcome: { state: 'requested' | 'refused'; runId?: number; attempt?: number; detail?: string };
        if (typeof github.rerunFailedJobs !== 'function') outcome = { state: 'refused', detail: 'This GitHub adapter cannot rerun failed jobs' };
        else try { const requested = await github.rerunFailedJobs(owed.failedRunId); outcome = { state: 'requested', runId: requested.runId, ...(requested.attempt !== undefined ? { attempt: requested.attempt } : {}) }; }
        catch (error) { outcome = { state: 'refused', detail: error instanceof Error ? error.message.slice(0, 300) : 'GitHub refused the rerun' }; }
        work = await engine.recordCheckRerun(work.id, job.token, owed, outcome);
      }
      // An accepted rerun with no new check run after the visibility bound is asked of GitHub
      // (GY-1096): with runners queued its workflow run waits, and that is a wait, not a failure,
      // so the candidate keeps its position and owes no new head. A rerun not found at all is
      // requested once more; only one that concluded failing, or vanished twice, lets it stand.
      for (const due of dueCheckRerunProbes(work, engine.ciAppIds, new Date())) {
        const rerunHold = hold('check-rerun');
        if (rerunHold) { held ??= rerunHold; break; }
        let found: RerunWorkflowRun | null = null;
        if (typeof github.rerunWorkflowRun === 'function') try { found = await github.rerunWorkflowRun(due.runId!); }
        catch (error) {
          // A read GitHub keeps failing holds for a bounded time only, measured from the last answer.
          const reason = error instanceof Error ? error.message.slice(0, 300) : String(error);
          if (Date.now() - Date.parse(due.probedAt ?? due.rerequestedAt ?? due.at) < checkRerunUnreadableMs) { console.error(`Graphyard could not read workflow run ${due.runId} for the ${due.check} rerun of ${work.key}: ${reason}`); continue; }
          work = await engine.recordCheckRerunProbe(work.id, job.token, due, { kind: 'expired', detail: `GitHub accepted the rerun but no new ${due.check} run appeared and its workflow run could not be read for ${checkRerunUnreadableMs / 60_000} minutes: ${reason}` });
          continue;
        }
        const probe = classifyRerunRun(due, found);
        if (probe.kind !== 'missing') { work = await engine.recordCheckRerunProbe(work.id, job.token, due, probe); continue; }
        if (due.rerequestedAt) {
          work = await engine.recordCheckRerunProbe(work.id, job.token, due, { kind: 'expired', detail: `GitHub accepted the rerun twice but no ${due.check} run was found within ${checkRerunVisibilityMs / 60_000} minutes of either request` });
          continue;
        }
        let outcome: Parameters<Engine['recordCheckRerunProbe']>[3];
        try { const again = await github.rerunFailedJobs(due.failedRunId); outcome = { kind: 'rerequested', runId: again.runId, ...(again.attempt !== undefined ? { attempt: again.attempt } : {}) }; }
        catch (error) { outcome = { kind: 'refused', detail: `GitHub accepted the rerun but no ${due.check} run was found within ${checkRerunVisibilityMs / 60_000} minutes, and the second request was refused: ${error instanceof Error ? error.message.slice(0, 300) : 'no reason given'}` }; }
        work = await engine.recordCheckRerunProbe(work.id, job.token, due, outcome);
      }
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
        // The landability verdict is recomputed from this observation's facts and published as its
        // one required check on the head (GY-887); an unchanged verdict writes nothing.
        if (!unpublishable && typeof github.publishLandable === 'function') {
          const observed = work;
          await github.publishLandable(observed, all.map(item => item.id === observed.id ? observed : item), success => guard(observed, success)());
        }
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
    const head = !settled && !held && await inMergeBand(work, () => engine.store.queuedWork());
    const cadence = schedule.cadence && (head ? { ...schedule.cadence, band: 'merge' as const, ms: headObservationSeconds * 1000 }
      : { ...schedule.cadence, band: schedule.cadence.band === 'merge' ? 'active' as const : schedule.cadence.band, ms: Math.max(idleObservationSeconds * 1000, schedule.cadence.ms) });
    if (cadence && work) github.recordObservation?.(work.id, { requests, uncached, band: cadence.band, cadenceMs: cadence.ms });
    if (viaWebhook && observed && !settled && !held && cadence && work) await engine.store.noteWebhookRefresh(job.work_id, job.token, cadence.ms);
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
