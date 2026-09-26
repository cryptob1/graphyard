// Concern: optimistic merge for disjoint changes (GY-500) — land a green candidate at once when
// nothing merged since its base touches its files, then guard the base branch after the fact.
//
// Every queued entry waits its turn for a combined-tip validation (merge-queue.ts). When a
// candidate's changed files are disjoint from every change merged into the base since the base
// its own checks and proofs ran on, a combined-tip run adds little: its own run already tested
// exactly the files it changes against exactly the files around them. Such an entry skips the
// queue and merges head-bound. Main is then validated after the merge: the required suite runs on
// every merge commit (CI's push run), and a failure is traced to the optimistic merge that caused
// it — bisected when several landed since the last green commit — which is reverted head-bound
// through the repair lane's bypass (GY-406) and its item reopened for a rework round.
//
// Everything here is pure. The observation (github.ts) reads the files the base changed; the
// engine records the lane, the post-merge verdicts and the revert; the GitHub job loop runs the
// guard (`guardMain` in github.ts). The same records feed master status and Insights.
import type { Work } from './model/work.js';
import { recordRework } from './pipeline-speed.js';

declare module './model/work.js' {
  interface Observation {
    /**
     * The files the base branch changed from the candidate's bound base to `baseTip`, as GitHub
     * compared them: [] when the base has not moved, null when the comparison was incomplete.
     */
    baseChanges?: string[] | null;
  }
  interface Work {
    /** The optimistic lane the current candidate holds (GY-500), or null: set while it is eligible, kept on its merge. */
    optimistic?: OptimisticLane | null;
    /** Every optimistic merge of this item, oldest first, each with its post-merge verdict and any revert. */
    optimisticMerges?: OptimisticMerge[];
    /** Why a delivered item was reopened for a rework round, when it was: the failure its revert attaches. */
    reopened?: { reason: string; at: string; source: 'optimistic-revert' } | null;
  }
}

/** `mergeQueue.optimistic` when the master config sets nothing: optimistic merge is on by default. */
export const defaultOptimisticMerge = true;
/** The installation-ledger event the control plane reads the published setting back from (beside `merge-queue.batch-size`). */
export const optimisticMergeEvent = 'merge-queue.optimistic';

// ---- Eligibility (AC-1) --------------------------------------------------------------------------

const lockfiles = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'go.sum', 'poetry.lock', 'Gemfile.lock', 'composer.lock']);
/**
 * Shared infrastructure: files whose change can break any test anywhere, so disjointness by file
 * says nothing about them. A change to one never merges optimistically, and neither does anything
 * whose base changed one since its own run.
 */
export const optimisticInfrastructure = ['package.json', 'lockfiles', '.github/', 'tests/helpers/', 'src/model/work.ts', 'schema and migration files'] as const;
export function sharedInfrastructure(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name === 'package.json' || lockfiles.has(name) || path.startsWith('.github/') || path.startsWith('tests/helpers/') || path === 'src/model/work.ts'
    || /(^|\/)migrations?\//i.test(path) || /(^|\/)[^/]*migration[^/]*$/i.test(name) || /^schema([.-][^/]*)?$/i.test(name) || /(^|\/)schemas?\//i.test(path)
    || path.startsWith('src/store/tables/');
}

/** What made an entry eligible, recorded on the item while it holds the optimistic lane and kept on its merge. */
export interface OptimisticLane {
  /** The head the lane binds: the item's own head, never a speculative tip. */
  head: string;
  /** The base its checks and proofs ran on (its bound base). */
  baseSha: string;
  /** The base branch tip the disjointness was judged against. */
  baseTip: string;
  /** The files the candidate changes, and the files the base changed since `baseSha`. */
  files: string[];
  baseChanges: string[];
  policyRevision: number;
  /** When the entry was first found eligible for this head: its time-to-merge starts here. */
  at: string;
}
export type OptimisticEligibility = { eligible: true; lane: Omit<OptimisticLane, 'at'> } | { eligible: false; reasons: string[] };

const listed = (paths: string[]) => paths.length > 6 ? `${paths.slice(0, 6).join(', ')} and ${paths.length - 6} more` : paths.join(', ');

/**
 * Whether an entry may merge optimistically now. Every condition must hold:
 * - optimistic mode is on (`mergeQueue.optimistic`, default on);
 * - every gate passes on the entry's own head (`gatesPass`, which placeInQueue decides) and the
 *   entry is not already in the merge queue — a queued entry keeps its place and its tip;
 * - the observation is of this head, and it lists both the head's files and the files the base
 *   changed since the head's bound base (unknown is never disjoint);
 * - those two sets are disjoint, and neither touches shared infrastructure;
 * - no other item's optimistic merge is in flight on an overlapping file, and main is not red
 *   from an optimistic merge still being traced or reverted.
 */
export function optimisticEligibility(work: Work, all: Work[], input: { enabled: boolean; gatesPass: boolean }): OptimisticEligibility {
  const reasons: string[] = [];
  const candidate = work.candidate, observation = work.observation;
  if (!input.enabled) reasons.push('Optimistic merge is off (mergeQueue.optimistic is false)');
  if (!input.gatesPass) reasons.push('Not every gate passes on its own head');
  if (work.queue) reasons.push('Already in the merge queue');
  if (!candidate || !observation || observation.candidate.sha !== candidate.sha || observation.candidate.baseSha !== candidate.baseSha || observation.merged) {
    reasons.push('No current observation of its own head');
    return { eligible: false, reasons };
  }
  if (work.queueEjection?.sha === candidate.sha) reasons.push(`Ejected from the merge queue at this head: ${work.queueEjection.reason}`);
  // A renamed file changes its old path too.
  const files = [...new Set([...(observation.files ?? []), ...(observation.scopeFiles ?? []).flatMap(file => file.previousPath ? [file.previousPath] : [])])].sort();
  const baseChanges = observation.baseChanges;
  if (!files.length) reasons.push('The files it changes are not known');
  if (!baseChanges || !observation.baseTip) reasons.push(`The files the base changed since ${candidate.baseSha.slice(0, 12)} are not known`);
  else {
    const overlap = files.filter(path => baseChanges.includes(path));
    if (overlap.length) reasons.push(`Its files overlap changes merged since its base ${candidate.baseSha.slice(0, 12)}: ${listed(overlap)}`);
    const infrastructure = baseChanges.filter(sharedInfrastructure);
    if (infrastructure.length) reasons.push(`The base changed shared infrastructure since ${candidate.baseSha.slice(0, 12)}: ${listed(infrastructure)}`);
  }
  const own = files.filter(sharedInfrastructure);
  if (own.length) reasons.push(`It changes shared infrastructure: ${listed(own)}`);
  for (const other of all) {
    if (other.id === work.id || !other.optimistic || other.stage === 'done' || other.observation?.merged) continue;
    const overlap = files.filter(path => other.optimistic!.files.includes(path));
    if (overlap.length) reasons.push(`${other.key} is merging optimistically over the same files: ${listed(overlap)}`);
  }
  const red = mainGuard(all);
  if (red.state !== 'green' && red.state !== 'pending') reasons.push(`Main is red after an optimistic merge (${describeGuard(red)}); optimistic merges wait until it is green`);
  if (reasons.length) return { eligible: false, reasons };
  return { eligible: true, lane: { head: candidate.sha, baseSha: candidate.baseSha, baseTip: observation.baseTip!, files, baseChanges: [...baseChanges!].sort(), policyRevision: work.policyRevision } };
}

/** Whether the item merges on its optimistic lane: the lane binds exactly this authorized head and base. */
export const onOptimisticLane = (work: Pick<Work, 'optimistic'>, authorization: { sha: string; baseSha: string }) =>
  !!work.optimistic && work.optimistic.head === authorization.sha && work.optimistic.baseSha === authorization.baseSha;
/**
 * The merge broker's last check of an optimistic entry before GitHub is asked to merge it, or null
 * when it may: the base branch still stands at the tip its disjointness was judged against. A base
 * that moved since is judged again on the next observation, never assumed disjoint.
 */
export function optimisticLandingRefusal(work: Pick<Work, 'key' | 'optimistic'>, baseTip: string): string | null {
  const lane = work.optimistic;
  if (!lane) return `${work.key} holds no optimistic lane`;
  return baseTip === lane.baseTip ? null : `${work.key}'s optimistic merge was judged disjoint against base tip ${lane.baseTip.slice(0, 12)}, but the base branch is now at ${baseTip.slice(0, 12)}; the next observation judges it again`;
}

/** The lane an eligible entry holds: the recorded one while it still binds the same head, base and policy, else a new one from now. */
export function currentLane(work: Pick<Work, 'optimistic'>, lane: Omit<OptimisticLane, 'at'>, now: Date): OptimisticLane {
  const recorded = work.optimistic;
  return recorded && recorded.head === lane.head && recorded.baseSha === lane.baseSha && recorded.policyRevision === lane.policyRevision ? { ...lane, at: recorded.at } : { ...lane, at: now.toISOString() };
}

// ---- The main guard (AC-2) -----------------------------------------------------------------------

/** The required suite's verdict on one merge commit: every required check passed, one failed, or not all have concluded. */
export type PostMergeVerdict = { verdict: 'pass' } | { verdict: 'fail'; failing: string[] } | { verdict: 'pending' };
const failedConclusions = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
/**
 * The verdict on a merge commit from its check runs: the newest run of each required check from a
 * trusted CI app. A required check that has not reported yet leaves the verdict pending.
 */
export function postMergeVerdict(checks: { name: string; result: string; appId: number; id?: number }[], required: string[], ciAppIds: readonly number[]): PostMergeVerdict {
  const failing: string[] = []; let pending = false;
  for (const name of required) {
    const runs = checks.filter(check => check.name === name && ciAppIds.includes(check.appId));
    const latest = runs.reduce<typeof runs[number] | undefined>((best, check) => !best || (check.id ?? 0) >= (best.id ?? 0) ? check : best, undefined);
    if (!latest || !['success', ...failedConclusions].includes(latest.result)) pending = true;
    else if (latest.result !== 'success') failing.push(`${name} (${latest.result})`);
  }
  return failing.length ? { verdict: 'fail', failing } : pending ? { verdict: 'pending' } : { verdict: 'pass' };
}

/** One optimistic merge of an item, kept on the item across reverts so the counters survive a rework round. */
export interface OptimisticMerge {
  lane: OptimisticLane;
  pr: number; mergeSha: string; mergedAt: string;
  /**
   * The required suite on `mergeSha`, as last read; null until first read. `on` names another
   * commit the verdict is read on instead: the revert of an earlier culprit, when this merge's own
   * commit still held that culprit and so failed for it (see `retestAfterRevert`).
   */
  postMerge: ({ observedAt: string; on?: string } & PostMergeVerdict) | null;
  revert: OptimisticRevert | null;
}
/** The revert of an optimistic merge found to have broken main. */
export interface OptimisticRevert {
  at: string;
  /** Why: the failing checks on the culprit's merge commit, and the commits the bisection examined. */
  failing: string[]; probes: string[];
  /** The other optimistic merges since the last green commit, kept on main. */
  kept: string[];
  /** Where the revert stands: opened as a pull request, merged, or refused (with the reason; a human-free follow-up is filed by the master). */
  state: 'opened' | 'merged' | 'refused';
  pr: number | null; head: string | null; mergeSha: string | null; refusal: string | null;
  /** For a refused revert: the base branch commit whose required suite passed again, which ends the hold on optimistic merges. */
  resolvedBy?: { sha: string; at: string } | null;
}

/** The item's latest optimistic merge, when its current delivery is one. */
export function currentOptimisticMerge(work: Pick<Work, 'stage' | 'delivery' | 'optimisticMerges'>): OptimisticMerge | null {
  const last = work.optimisticMerges?.at(-1);
  return last && work.stage === 'done' && work.delivery?.mergeSha === last.mergeSha && !last.revert ? last : null;
}

export interface GuardMerge { key: string; id: string; mergeSha: string; mergedAt: string; verdict: PostMergeVerdict['verdict']; failing: string[] }
/**
 * Where main stands after the optimistic merges: the unreverted ones from the last green one on,
 * oldest first, and what the guard does next.
 * - `green`: every one of them passed (or there are none);
 * - `pending`: none has failed yet and some have not concluded;
 * - `await`: one failed and the bisection needs the verdict on `probe` before it can name the culprit;
 * - `culprit`: the first failing merge is `culprit`; the others (`kept`) stay on main;
 * - `reverting`: the culprit's revert is open and not merged yet;
 * - `refused`: the culprit could not be reverted cleanly, and main has not passed since.
 */
export type GuardState =
  | { state: 'green'; window: GuardMerge[] }
  | { state: 'pending'; window: GuardMerge[] }
  | { state: 'await'; window: GuardMerge[]; probe: GuardMerge; probes: string[] }
  | { state: 'culprit'; window: GuardMerge[]; culprit: GuardMerge; kept: GuardMerge[]; probes: string[] }
  | { state: 'reverting'; window: GuardMerge[]; culprit: GuardMerge; revert: OptimisticRevert }
  | { state: 'refused'; window: GuardMerge[]; culprit: GuardMerge; revert: OptimisticRevert };

export function mainGuard(all: Pick<Work, 'id' | 'key' | 'stage' | 'delivery' | 'optimisticMerges'>[]): GuardState {
  const reverted = (state: OptimisticRevert['state']) => all.flatMap(work => (work.optimisticMerges ?? []).filter(merge => merge.revert?.state === state && !merge.revert.resolvedBy).map(merge => ({ work, merge })))[0];
  const reverting = reverted('opened'), refused = reverted('refused');
  const merges = all.flatMap(work => {
    const merge = currentOptimisticMerge(work);
    return merge ? [{ key: work.key, id: work.id, mergeSha: merge.mergeSha, mergedAt: merge.mergedAt, verdict: merge.postMerge?.verdict ?? 'pending', failing: merge.postMerge?.verdict === 'fail' ? merge.postMerge.failing : [] }] : [];
  }).sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt) || (a.key < b.key ? -1 : 1));
  // The last green commit: the newest passing merge before the first failure (or the newest of all
  // when none failed). The window starts there — the bisection's known-good bound — and runs to now.
  const firstFail = merges.findIndex(merge => merge.verdict === 'fail');
  const before = firstFail < 0 ? merges : merges.slice(0, firstFail);
  const lastGreen = before.map(merge => merge.verdict).lastIndexOf('pass');
  const window = merges.slice(Math.max(0, lastGreen));
  const held = reverting ?? refused;
  if (held) {
    const merge = held.merge, culprit: GuardMerge = { key: held.work.key, id: held.work.id, mergeSha: merge.mergeSha, mergedAt: merge.mergedAt, verdict: 'fail', failing: merge.revert!.failing };
    return held === reverting ? { state: 'reverting', window, culprit, revert: merge.revert! } : { state: 'refused', window, culprit, revert: merge.revert! };
  }
  if (firstFail < 0) return window.some(merge => merge.verdict === 'pending') ? { state: 'pending', window } : { state: 'green', window };
  const found = bisectCulprit(window);
  if ('probe' in found) return { state: 'await', window, probe: found.probe, probes: found.probes };
  return { state: 'culprit', window, culprit: found.culprit, kept: window.filter(merge => merge !== found.culprit), probes: found.probes };
}

/**
 * The first failing merge of `window` (oldest first; the last green commit precedes it), found by
 * bisection: each probe halves the range between the last commit known green and the first known
 * red. A probe whose verdict is still pending is what the guard waits for; nothing is guessed.
 * Main is assumed to stay red once broken, so a pass at the probe moves the range past it.
 */
export function bisectCulprit(window: GuardMerge[]): { culprit: GuardMerge; probes: string[] } | { probe: GuardMerge; probes: string[] } {
  let low = 0, high = window.findIndex(merge => merge.verdict === 'fail');
  if (high < 0) throw new Error('bisectCulprit needs a failing merge in its window');
  const probes: string[] = [];
  while (low < high) {
    const middle = Math.floor((low + high) / 2), probe = window[middle];
    probes.push(probe.mergeSha);
    if (probe.verdict === 'pending') return { probe, probes };
    if (probe.verdict === 'fail') high = middle; else low = middle + 1;
  }
  return { culprit: window[low], probes };
}

export function describeGuard(guard: GuardState): string {
  switch (guard.state) {
    case 'green': return guard.window.length ? `main is green after ${guard.window.at(-1)!.key}` : 'no optimistic merge is awaiting its post-merge run';
    case 'pending': return `the required suite is running on main after ${guard.window.filter(merge => merge.verdict === 'pending').map(merge => `${merge.key} (${merge.mergeSha.slice(0, 12)})`).join(', ')}`;
    case 'await': return `main failed after an optimistic merge; bisecting ${guard.window.map(merge => merge.key).join(', ')}, waiting for the required suite on ${guard.probe.key}'s merge ${guard.probe.mergeSha.slice(0, 12)}`;
    case 'culprit': return `${guard.culprit.key}'s merge ${guard.culprit.mergeSha.slice(0, 12)} broke main (${guard.culprit.failing.join(', ') || 'required checks failed'})${guard.kept.length ? `; ${guard.kept.map(merge => merge.key).join(', ')} stay${guard.kept.length === 1 ? 's' : ''}` : ''}`;
    case 'reverting': return `reverting ${guard.culprit.key}'s merge ${guard.culprit.mergeSha.slice(0, 12)}${guard.revert.pr ? ` through PR #${guard.revert.pr}` : ''}`;
    case 'refused': return `${guard.culprit.key}'s merge ${guard.culprit.mergeSha.slice(0, 12)} broke main (${guard.culprit.failing.join(', ') || 'required checks failed'}) and cannot be reverted automatically: ${guard.revert.refusal}`;
  }
}

/**
 * The files a revert of `merge` restores, and the refusal when it cannot be a clean, head-bound
 * revert: a file some later merge changed again would lose that change with it. `changedSince` is
 * the files the base changed from the merge commit to the tip the revert is built on (null: unknown).
 */
export function revertRefusal(merge: Pick<OptimisticMerge, 'lane' | 'mergeSha'>, changedSince: string[] | null): string | null {
  if (!changedSince) return `The files main changed since ${merge.mergeSha.slice(0, 12)} could not be listed, so a revert could undo later work`;
  const touched = merge.lane.files.filter(path => changedSince.includes(path));
  return touched.length ? `Later merges changed ${listed(touched)} after ${merge.mergeSha.slice(0, 12)}, so reverting it would undo them too` : null;
}

/** The commit the required suite is read on for this merge: its own merge commit, or the revert it is re-tested on. */
export const verdictCommit = (merge: Pick<OptimisticMerge, 'mergeSha' | 'postMerge'>) => merge.postMerge?.on ?? merge.mergeSha;
/**
 * Writes the required suite's verdict, read on `on` (default: the merge commit itself), onto the
 * item's merge `mergeSha`; false when it is unchanged.
 */
export function applyPostMerge(work: Work, mergeSha: string, verdict: PostMergeVerdict, now: Date, on?: string): boolean {
  const merge = work.optimisticMerges?.find(entry => entry.mergeSha === mergeSha);
  if (!merge) throw new Error(`${work.key} has no optimistic merge ${mergeSha.slice(0, 12)}`);
  const commit = on ?? merge.postMerge?.on;
  const next = { ...verdict, ...(commit && commit !== mergeSha ? { on: commit } : {}) };
  const { observedAt: _, ...previous } = merge.postMerge ?? { observedAt: '' };
  if (merge.postMerge && JSON.stringify(previous) === JSON.stringify(next)) return false;
  merge.postMerge = { ...next, observedAt: now.toISOString() };
  return true;
}
/**
 * The merges to re-test once the culprit's revert landed: every other one in the guard's window
 * that merged after the culprit and has not passed. Their own merge commits held the culprit, so
 * a failure there says nothing about them; the revert commit holds them without it.
 */
export function retestAfterRevert(guard: Extract<GuardState, { state: 'culprit' | 'reverting' }>): GuardMerge[] {
  const after = Date.parse(guard.culprit.mergedAt);
  return guard.window.filter(merge => merge.id !== guard.culprit.id && Date.parse(merge.mergedAt) >= after && merge.verdict !== 'pass');
}
/**
 * Writes one step of the revert of the item's merge `mergeSha`; false when it is unchanged. A
 * merged revert of the item's current delivery reopens it (`reopenReverted`); the caller evaluates.
 */
export function applyRevert(work: Work, mergeSha: string, revert: OptimisticRevert, now: Date): boolean {
  const merge = work.optimisticMerges?.find(entry => entry.mergeSha === mergeSha);
  if (!merge) throw new Error(`${work.key} has no optimistic merge ${mergeSha.slice(0, 12)}`);
  if (merge.revert && JSON.stringify(merge.revert) === JSON.stringify(revert)) return false;
  if (revert.state === 'merged' && work.stage === 'done' && work.delivery?.mergeSha === mergeSha) reopenReverted(work, revert, now);
  else merge.revert = revert;
  return true;
}

/**
 * Reopens an item whose optimistic merge was reverted (AC-2): the merge stays on the item's
 * record with its revert and the failure; the delivery is withdrawn and the item goes back to
 * build for a rework round with that failure attached, on a fresh pull request (the reverted one
 * is merged and cannot take new commits). Mutates `work`; the caller evaluates and saves it.
 */
export function reopenReverted(work: Work, revert: OptimisticRevert, now: Date): void {
  const merge = work.optimisticMerges?.at(-1);
  if (!merge || work.delivery?.mergeSha !== merge.mergeSha) throw new Error(`${work.key}'s current delivery is not its latest optimistic merge`);
  merge.revert = revert;
  // Counted while the submission still stands: a reopened delivery is a rework round.
  recordRework(work, now);
  work.stage = 'ready'; work.stageEnteredAt = now.toISOString();
  delete work.delivery; work.optimistic = null;
  work.submission = null; work.candidate = null; work.observation = null;
  work.mergeAuthorization = null; work.mergeExecution = null; work.reviewRequest = null;
  work.queue = null; work.queueEjection = null;
  work.reworkRequested = false;
  work.reopened = { reason: reworkReason(work, merge, revert), at: now.toISOString(), source: 'optimistic-revert' };
}
export function reworkReason(work: Pick<Work, 'key'>, merge: Pick<OptimisticMerge, 'pr' | 'mergeSha'>, revert: Pick<OptimisticRevert, 'failing' | 'pr' | 'mergeSha' | 'kept'>): string {
  return `${work.key}'s optimistic merge (PR #${merge.pr}, ${merge.mergeSha.slice(0, 12)}) broke main: ${revert.failing.join(', ') || 'the required checks failed'} on its merge commit. It was reverted${revert.pr ? ` by PR #${revert.pr}` : ''}${revert.mergeSha ? ` (${revert.mergeSha.slice(0, 12)})` : ''}${revert.kept.length ? `; ${revert.kept.join(', ')} stayed on main` : ''}. Fix the failure on a new pull request from the current base`;
}

// ---- Metrics (AC-3) ------------------------------------------------------------------------------

export interface LaneTiming { count: number; p50Ms: number | null; p90Ms: number | null }
export interface OptimisticMetrics {
  enabled: boolean;
  /** Optimistic merges ever made, including those reverted since; and how many were reverted. */
  merges: number; reverts: number;
  /** Merges whose post-merge run passed, failed, or is still running. */
  postMerge: { passed: number; failed: number; pending: number };
  /** From ready-to-land (entered the queue, or took the optimistic lane) to merged, for each lane. */
  timeToMerge: { optimistic: LaneTiming; queued: LaneTiming };
  guard: { state: GuardState['state']; detail: string };
}
const percentile = (values: number[], p: number) => values.length ? values[Math.min(values.length - 1, Math.ceil(p * values.length) - 1)] : null;
const timing = (values: number[]): LaneTiming => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return { count: sorted.length, p50Ms: percentile(sorted, 0.5), p90Ms: percentile(sorted, 0.9) }; };

/**
 * The counters master status and Insights report. An optimistic merge's time runs from its lane's
 * `at` to its merge; a queued delivery's from its last `enqueued` history entry to its merge.
 */
export function optimisticMetrics(all: Pick<Work, 'id' | 'key' | 'stage' | 'delivery' | 'optimisticMerges' | 'queueHistory' | 'closure'>[], enabled = defaultOptimisticMerge): OptimisticMetrics {
  const merges = all.flatMap(work => work.optimisticMerges ?? []);
  const optimistic = merges.map(merge => Date.parse(merge.mergedAt) - Date.parse(merge.lane.at));
  const queued = all.flatMap(work => {
    if (work.stage !== 'done' || !work.delivery?.mergedAt || work.closure || currentOptimisticMerge(work)) return [];
    const merged = Date.parse(work.delivery.mergedAt);
    const entered = (work.queueHistory ?? []).filter(entry => entry.event === 'enqueued' && Date.parse(entry.at) <= merged).at(-1);
    return entered ? [merged - Date.parse(entered.at)] : [];
  });
  const guard = mainGuard(all);
  return {
    enabled, merges: merges.length, reverts: merges.filter(merge => merge.revert && merge.revert.state !== 'refused').length,
    postMerge: { passed: merges.filter(merge => merge.postMerge?.verdict === 'pass').length, failed: merges.filter(merge => merge.postMerge?.verdict === 'fail').length,
      pending: merges.filter(merge => !merge.revert && (!merge.postMerge || merge.postMerge.verdict === 'pending')).length },
    timeToMerge: { optimistic: timing(optimistic), queued: timing(queued) },
    guard: { state: guard.state, detail: describeGuard(guard) },
  };
}
