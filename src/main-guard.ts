// Concern: main stays green under GitHub delivery (GY-1250) — a merge that breaks main is reverted
// through a revert pull request the App merges, and its item is reopened for rework.
//
// Under GitHub delivery branch protection does not require a branch to be up to date, so two pull
// requests that each pass CI can break main together: whole-repository limits (docs budgets,
// module line budgets, generated files) are exactly what parallel merges break. CI runs the
// required checks on every push to main. The guard reads them on main's first-parent history and,
// when a merge commit fails a required check that its parent passed, reverts exactly that merge:
// it opens a revert pull request (the merge's inverse merged onto main's tip), merges it as the
// App once the revert's own required checks pass, and reopens the reverted item for a rework round
// naming the failing check and the merge commit.
//
// Branch protection requires an approval from someone other than the last pusher (GY-1291), and the
// App pushed the revert, so its own merge is refused. Before merging, the guard compares the revert
// pull request's diff with the named merge's: only a diff that is exactly its inverse — the same
// files, each adding back exactly the lines the merge removed and removing exactly the lines it
// added — is approved by the independent revert approver App and then merged. Anything else is
// never approved and is abandoned.
//
// The guard never holds anything. A revert gets one attempt: one that conflicts, whose checks fail
// or do not conclude, or that is not the exact inverse is closed and recorded `abandoned`. Within
// that attempt a mechanical refusal of the approval or the merge — GitHub's approval rule, or the
// approver App — is retried (GY-1332): the next tick approves afresh and merges again on the App's
// ruleset bypass, and only after `revertLandingAttempts` refusals is it abandoned as
// `approval-refused`. An abandoned revert is marked `red`: the loop raises its attention line every
// cycle until main's failing required check passes again (cycle-delivery.ts reads main's check runs).
// A merge already reverted or abandoned is never tried again, so the next red main is judged afresh.
//
// A cancelled run is not a failing test (GY-1468): a run whose only non-success conclusions are
// cancelled or timed-out jobs — an infrastructure step stalled past the job timeout, say, and the
// aggregate `test` job failing because its shards were cancelled — names no culprit. Main is
// pending while the guard reruns that run's failed jobs, at most `mainCancelledRerunLimit` times, and
// only a concluded rerun's real failure is reverted. A run still cancelled past the bound is
// recorded on the merge's item as an infrastructure fault naming the run (cause `cancelled`), which
// the loop raises to the master once; it is never reverted. A timed-out job counts as cancelled
// too, so a merge that hangs a test is escalated with the step it stopped in rather than reverted,
// and while main stays pending no later merge is judged.
//
// A failing test may be a flake (GY-1497): before reverting, the guard reruns the culprit run's
// failed jobs once (`mainFailedRerunLimit`), as the PR gate does (GY-516). Main is pending while the
// rerun runs and no later merge is judged. A rerun that passes leaves main green, reverts nothing and
// records a `MainGuardFlake` on the merged item; one that fails again is reverted as before, naming
// the failing check. A rerun GitHub refuses, or that does not conclude within `revertChecksTimeoutMs`,
// counts as the failure. The required check still has to pass on the exact merge commit.
//
// The judgement and the reopen are pure; the GitHub job loop runs the guard with the App's client
// (`guardGitHubMain` in github.ts) and the loop raises the attention (cycle-delivery.ts).
import type { Work } from './model/work.js';
import { recordRework } from './pipeline-speed.js';

declare module './model/work.js' {
  interface Work {
    /** Every revert the main guard made of this item's merges (GY-1250), oldest first; kept across the rework round. */
    mainGuardReverts?: MainGuardRevert[];
    /** The main runs of this item's merges that failed a required check and passed on their one rerun (GY-1497), oldest first, the last `mainGuardFlakesKept`. */
    mainGuardFlakes?: MainGuardFlake[];
  }
}

/** A required check that failed on a merge commit on main and passed when its failed jobs were rerun (GY-1497). */
export interface MainGuardFlake {
  mergeSha: string; check: string;
  /** The check run that failed, and the rerun's check run that passed; null where GitHub gave none. */
  failedRunId: number | null; rerunRunId: number | null;
  at: string;
}
/** How many flakes an item keeps. */
export const mainGuardFlakesKept = 20;
/** Appends flakes to the item's record, keeping the last `mainGuardFlakesKept`. Mutates `work`. */
export function applyMainGuardFlakes(work: Work, flakes: readonly MainGuardFlake[]) {
  work.mainGuardFlakes = [...work.mainGuardFlakes ?? [], ...flakes].slice(-mainGuardFlakesKept);
}

/** One revert of a merge that broke main. */
export interface MainGuardRevert {
  /** The merge commit on main the revert undoes, and the pull request that merged it. */
  mergeSha: string; pr: number | null;
  /** The required checks that failed on the merge commit while its parent passed. */
  failing: string[];
  /** The revert pull request and the exact head the guard built; null when none could be opened. */
  revert: { pr: number; head: string } | null;
  state: 'opened' | 'merged' | 'abandoned';
  /** When the revert was opened (or abandoned before it could be), and when it settled. */
  at: string; settledAt: string | null;
  /** The revert's merge commit on main, once merged. */
  revertSha: string | null;
  /** Once merged, the rework reason the reopened item carries (`mainGuardReason`); once abandoned, why. */
  reason: string | null;
  /** Once abandoned, which kind of failure gave it up (GY-1332); absent on records older than it. */
  cause?: MainGuardAbandonCause;
  /** The mechanical refusals of its approval or merge so far, oldest first; each one is retried until `revertLandingAttempts`. */
  refusals?: string[];
  /** Abandoned while main's required check fails: its attention line is raised every cycle until that check passes on main again. */
  red?: boolean;
  /** Cause `cancelled` (GY-1468): the workflow run that stayed cancelled past the rerun bound, and its last attempt. */
  run?: { id: number; attempt: number | null };
}
/**
 * Why a revert was abandoned: GitHub's approval rule or the approver App refused its approval or
 * merge (`approval-refused`), its own checks failed or did not conclude, it conflicts or could not be
 * opened, it is not the exact inverse, or it was closed or moved under the guard.
 */
export type MainGuardAbandonCause = 'approval-refused' | 'checks-failed' | 'timeout' | 'conflict' | 'not-inverse' | 'closed' | 'head-moved' | 'unopened' | 'cancelled';
/** How many approve-then-merge attempts a revert gets before a mechanical refusal abandons it: the first and two retries. */
export const revertLandingAttempts = 3;

export interface CheckRun { name: string; result: string; appId: number; id?: number }
/**
 * `cancelled` (GY-1468): required checks failed, but every job of the run that did not succeed was
 * cancelled or timed out, so nothing names a failing test; `checkRun` is one cancelled job to rerun
 * the run's failed jobs from (absent when GitHub gave it no id).
 */
export type CommitVerdict = { verdict: 'pass' } | { verdict: 'fail'; failing: string[] } | { verdict: 'pending' } | { verdict: 'cancelled'; failing: string[]; checkRun?: number };
const cancelledConclusions = new Set(['timed_out', 'cancelled']);
const failedConclusions = new Set(['failure', ...cancelledConclusions, 'action_required', 'startup_failure', 'stale']);
const concluded = new Set(['success', 'skipped', 'neutral', ...failedConclusions]);

/**
 * The required checks on one commit, from the CI apps only: `fail` names each required check whose
 * latest run concluded unsuccessfully, `pending` is any required check not concluded yet. A failure
 * is `cancelled` instead when the commit's CI jobs hold a cancelled or timed-out one and no job
 * other than a required check failed outright: a required aggregate whose needs were cancelled
 * fails without any test having failed, and a required check failing on its own fails again on the
 * rerun, which then concludes with nothing cancelled. While any CI job has not concluded, the
 * failure is not judged yet.
 */
export function commitVerdict(checks: CheckRun[], required: readonly string[], ciAppIds: readonly number[]): CommitVerdict {
  const latest = latestRuns(checks, ciAppIds);
  const failing: string[] = []; let pending = !required.length;
  for (const name of required) {
    const run = latest.get(name);
    if (!run || !['success', 'skipped', ...failedConclusions].includes(run.result)) pending = true;
    else if (failedConclusions.has(run.result)) failing.push(name);
  }
  if (!failing.length) return pending ? { verdict: 'pending' } : { verdict: 'pass' };
  const jobs = [...latest.values()], cancelled = jobs.filter(job => cancelledConclusions.has(job.result));
  if (!cancelled.length || jobs.some(job => !required.includes(job.name) && failedConclusions.has(job.result) && !cancelledConclusions.has(job.result))) return { verdict: 'fail', failing };
  if (pending || jobs.some(job => !concluded.has(job.result))) return { verdict: 'pending' };
  const checkRun = cancelled.find(job => job.id !== undefined)?.id;
  return { verdict: 'cancelled', failing, ...(checkRun !== undefined ? { checkRun } : {}) };
}
/** How many times the guard reruns a cancelled run's failed jobs on main before it reports it as an infrastructure fault (as GY-1109's cancelledRerunLimit). */
export const mainCancelledRerunLimit = 3;
/** How many times the guard reruns a failed run's failed jobs on main before it reverts the merge (GY-1497, as GY-516's single rerun at the PR gate). */
export const mainFailedRerunLimit = 1;
/** The latest run of each check from the CI apps. */
function latestRuns(checks: CheckRun[], ciAppIds: readonly number[]) {
  const latest = new Map<string, CheckRun>();
  for (const check of checks) if (ciAppIds.includes(check.appId) && (check.id ?? 0) >= (latest.get(check.name)?.id ?? -1)) latest.set(check.name, check);
  return latest;
}

/** One commit of main's first-parent history, newest first. */
export interface MainCommit { sha: string; parent: string | null }
/**
 * Where main stands, read from its first-parent history newest first:
 * - `green`: the tip passed;
 * - `broken`: `culprit` failed `failing` while its parent passed, and nothing after it passed;
 * - `pending`: the commit after the last green one has not concluded, so no culprit can be named;
 *   `cancelled` when its run concluded only cancelled (GY-1468), naming the checks and a job to rerun;
 *   `rerun` while the guard reruns the failed jobs of a broken merge once before reverting it (GY-1497);
 * - `unknown`: no commit in the history read passed.
 */
export type MainState = { state: 'green' } | { state: 'broken'; culprit: string; parent: string; failing: string[] } | { state: 'pending'; probe: string; cancelled?: { failing: string[]; checkRun?: number }; rerun?: { failing: string[] } } | { state: 'unknown' };
export async function readMain(history: MainCommit[], verdict: (sha: string) => Promise<CommitVerdict>): Promise<MainState> {
  for (let index = 0; index < history.length; index++) {
    if ((await verdict(history[index].sha)).verdict !== 'pass') continue;
    if (index === 0) return { state: 'green' };
    const child = history[index - 1], judged = await verdict(child.sha);
    if (judged.verdict === 'fail') return { state: 'broken', culprit: child.sha, parent: history[index].sha, failing: judged.failing };
    return judged.verdict === 'cancelled' ? { state: 'pending', probe: child.sha, cancelled: { failing: judged.failing, ...(judged.checkRun !== undefined ? { checkRun: judged.checkRun } : {}) } } : { state: 'pending', probe: child.sha };
  }
  return { state: 'unknown' };
}

/** The rework reason the reopened item carries: the failing checks and the merge commit. */
export function mainGuardReason(work: Pick<Work, 'key'>, revert: Pick<MainGuardRevert, 'mergeSha' | 'pr' | 'failing' | 'revert' | 'revertSha'>): string {
  return `${work.key}'s merge ${revert.mergeSha.slice(0, 12)}${revert.pr ? ` (PR #${revert.pr})` : ''} broke main: ${revert.failing.join(', ') || 'the required checks'} failed on that merge commit while its parent passed. It was reverted${revert.revert ? ` by PR #${revert.revert.pr}` : ''}${revert.revertSha ? ` (${revert.revertSha.slice(0, 12)})` : ''}. Fix the failure on a new pull request from the current base`;
}

/**
 * Reopens an item whose merge the guard reverted: the delivery is withdrawn, the item returns to
 * build for a rework round on a fresh pull request (the merged one cannot take new commits), and
 * the revert stays on its record. False when the item no longer holds that delivery. Mutates
 * `work`; the caller evaluates and saves it.
 */
export function reopenReverted(work: Work, revert: MainGuardRevert, now: Date): boolean {
  if (work.stage !== 'done' || work.delivery?.mergeSha !== revert.mergeSha) return false;
  recordRework(work, now);
  work.stage = 'ready'; work.stageEnteredAt = now.toISOString();
  delete work.delivery;
  work.submission = null; work.candidate = null; work.observation = null;
  work.mergeAuthorization = null; work.mergeExecution = null; work.reviewRequest = null;
  work.reworkRequested = false;
  return true;
}

/** Writes one revert step onto the item's record (replacing the step for the same merge); the reopen when it merged. */
export function applyMainGuardRevert(work: Work, revert: MainGuardRevert, now: Date): { reopened: boolean } {
  work.mainGuardReverts = [...(work.mainGuardReverts ?? []).filter(entry => entry.mergeSha !== revert.mergeSha), revert];
  return { reopened: revert.state === 'merged' && reopenReverted(work, revert, now) };
}

/** One file of a diff as GitHub lists it: its status, its path (and the path it was renamed from) and its unified patch. */
export interface FileChange { filename: string; status: string; previousFilename?: string | null; patch?: string | null }
const inverseStatus: Record<string, string> = { added: 'removed', removed: 'added', modified: 'modified', renamed: 'renamed' };
/** GitHub reports a mode-only or content change as `changed` as well as `modified`; both are a modification. */
const statusOf = (change: FileChange) => change.status === 'changed' ? 'modified' : change.status;
/** The removed and added lines of a unified patch, in order; hunk headers and context lines say nothing about what changed. */
function patchLines(patch: string) {
  const removed: string[] = [], added: string[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('-')) removed.push(line.slice(1));
    else if (line.startsWith('+')) added.push(line.slice(1));
  }
  return { removed, added };
}
/**
 * Null when `revert` is exactly the inverse of `merge`, else why not: the same files, a file the
 * merge added removed (and the reverse), a rename renamed back, and each file adding back exactly
 * the lines the merge removed and removing exactly the lines it added, in order. Line numbers and
 * context may differ, since later merges may have moved the lines; the lines changed may not. A
 * file without a patch (binary, or too large for GitHub to show) cannot be compared, so it refuses.
 */
export function revertInverseRefusal(merge: readonly FileChange[], revert: readonly FileChange[]): string | null {
  if (!merge.length) return 'the merge changed no file GitHub lists, so no revert of it can be verified';
  const keyOf = (change: FileChange) => change.filename;
  const reverted = new Map(revert.map(change => [keyOf(change), change]));
  if (reverted.size !== revert.length) return 'the revert lists a file twice';
  const expected = new Set<string>();
  for (const change of merge) {
    // A rename a→b is undone by a rename b→a: the revert's file is the merge's previous name.
    const target = change.status === 'renamed' ? change.previousFilename ?? '' : change.filename;
    expected.add(target);
    const inverse = reverted.get(target);
    if (!inverse) return `the revert does not change ${target}, which the merge changed`;
    if (statusOf(inverse) !== (inverseStatus[statusOf(change)] ?? statusOf(change))) return `the revert's ${target} is ${inverse.status}, not the inverse of the merge's ${change.status}`;
    if (change.status === 'renamed' && inverse.previousFilename !== change.filename) return `the revert renames ${target} from ${inverse.previousFilename ?? 'nowhere'}, not back from ${change.filename}`;
    if (typeof change.patch !== 'string' || typeof inverse.patch !== 'string') {
      if (change.patch == null && inverse.patch == null && change.status === 'renamed') continue;
      return `${target} has no patch to compare (binary or too large), so the revert of it cannot be verified`;
    }
    const forward = patchLines(change.patch), backward = patchLines(inverse.patch);
    if (JSON.stringify(backward.added) !== JSON.stringify(forward.removed) || JSON.stringify(backward.removed) !== JSON.stringify(forward.added)) return `the revert's change to ${target} is not exactly the inverse of the merge's`;
  }
  const extra = revert.find(change => !expected.has(keyOf(change)));
  return extra ? `the revert changes ${extra.filename}, which the merge did not` : null;
}

/** What the guard needs of GitHub and the store; github.ts supplies the App's, tests a fake. */
export interface MainGuardPorts {
  /** The items holding a revert still `opened`, as whole documents. */
  reverting(): Promise<Work[]>;
  /** The item whose delivery is the merge commit `mergeSha`, or that already holds a revert of it; null when no item does. */
  culprit(mergeSha: string): Promise<Work | null>;
  /** Main's first-parent history, newest first. */
  history(): Promise<MainCommit[]>;
  checks(sha: string): Promise<CheckRun[]>;
  /** Opens the revert pull request of exactly `mergeSha` onto main's tip, or says why it cannot (a conflict). */
  openRevert(work: Work, mergeSha: string, reason: string): Promise<{ pr: number; head: string } | { refusal: string }>;
  pull(pr: number): Promise<{ merged: boolean; mergeSha: string | null; open: boolean; mergeable: boolean | null; head: string }>;
  /** The files the merge commit `mergeSha` changed against its first parent. */
  mergeChanges(mergeSha: string): Promise<FileChange[]>;
  /** The files the revert pull request changes against main. */
  revertChanges(pr: number): Promise<FileChange[]>;
  /**
   * Approves the revert at exactly `head` as the independent revert approver App, which branch
   * protection accepts as someone other than the last pusher (GY-1291). `unconfigured` when no
   * approver is registered: the merge is then attempted on the App's own standing (its ruleset bypass).
   */
  approveRevert(pr: number, head: string, body: string): Promise<'approved' | 'unconfigured'>;
  /** Merges the revert as the App, bound to `head`; the merge commit, or null when GitHub has not merged it yet. */
  mergeRevert(work: Work, revert: { pr: number; head: string; failing: string[] }): Promise<string | null>;
  closeRevert(pr: number, reason: string): Promise<void>;
  /**
   * The workflow run of the failed or cancelled job `checkRun` and that job's attempt (GY-1468,
   * GY-1497); absent where the adapter cannot rerun: a cancelled main then stays pending, and a
   * failed one is reverted without a rerun.
   */
  jobRun?(checkRun: number): Promise<{ id: number; attempt: number | null; step?: string | null }>;
  /** Reruns that run's failed and cancelled jobs; `waiting` while GitHub still runs it. */
  rerunFailed?(checkRun: number, run: { id: number; attempt: number | null }): Promise<'requested' | 'waiting'>;
  /** Saves the revert step onto the item (`applyMainGuardRevert`), evaluating it when it reopened. */
  record(work: Work, revert: MainGuardRevert): Promise<void>;
  /** Appends the flakes onto the item (`applyMainGuardFlakes`); absent, they are applied to the snapshot only. */
  recordFlakes?(work: Work, flakes: MainGuardFlake[]): Promise<void>;
}
export interface MainGuardOptions {
  required: readonly string[]; ciAppIds: readonly number[]; now?: Date;
  /** Concluded verdicts by commit, kept across ticks: a concluded check run does not change. */
  verdicts?: Map<string, CommitVerdict>;
  /** How long a revert's own checks may run before it is abandoned. */
  checksTimeoutMs?: number;
  /**
   * The revert heads (`pr@head`) already verified as the exact inverse and approved, kept across
   * ticks: while GitHub's auto-merge has not landed one, the next tick neither re-reads its diffs
   * nor approves it again; a moved head is abandoned before this is consulted.
   */
  approved?: Set<string>;
  /** The cancelled check runs (`sha@checkRun`) already rerun or reported, kept across ticks so each is acted on once. */
  cancelled?: Set<string>;
  /** The broken merges whose failed jobs the guard reruns before reverting (GY-1497), by merge commit, kept across ticks. */
  reruns?: Map<string, MainRerun>;
}
/**
 * One rerun of a broken merge's failed jobs: the checks that failed and the check run of each, the
 * parent that passed, when the guard first decided it (its `revertChecksTimeoutMs` runs from then),
 * whether GitHub took the request yet, and, once it passed, the check run that passed for each.
 */
export interface MainRerun { failing: string[]; failed: Record<string, number | null>; parent: string; at: number; requested: boolean; passed?: Record<string, number | null> }
/** A revert whose own checks have not concluded in this long is closed: the guard never waits on one indefinitely. */
export const revertChecksTimeoutMs = 60 * 60_000;

export interface MainGuardTick { main: MainState; steps: { key: string; mergeSha: string; state: MainGuardRevert['state']; reason: string | null }[]; errors: string[]; flakes: MainGuardFlake[] }
/**
 * One tick of the guard: settles every revert in flight, then reads main and reverts the merge that
 * broke it, once. Each step is independent: a failure of one is reported in `errors`, never holds
 * another, and is read afresh on the next tick.
 */
export async function runMainGuard(ports: MainGuardPorts, options: MainGuardOptions): Promise<MainGuardTick> {
  const now = options.now ?? new Date(), at = now.toISOString(), verdicts = options.verdicts ?? new Map<string, CommitVerdict>();
  const approved = options.approved ?? new Set<string>();
  const tick: MainGuardTick = { main: { state: 'unknown' }, steps: [], errors: [], flakes: [] };
  const reruns = options.reruns ?? new Map<string, MainRerun>(), timeoutMs = options.checksTimeoutMs ?? revertChecksTimeoutMs;
  // A concluded verdict is kept across ticks; a pending one only for this tick, so a commit whose CI
  // is still running is read once per tick, not once per look at it.
  const pending = new Map<string, CommitVerdict>();
  const verdict = async (sha: string) => {
    const known = verdicts.get(sha) ?? pending.get(sha);
    if (known) return known;
    const checks = await ports.checks(sha);
    let read = commitVerdict(checks, options.required, options.ciAppIds);
    // A merge being rerun (GY-1497) is judged only on the rerun: until GitHub shows a newer run of a
    // failing check, the failure read is the one rerun, and main is pending. A passing rerun names
    // the check runs that passed for the flake record.
    const rerun = reruns.get(sha);
    if (rerun?.requested) {
      const latest = latestRuns(checks, options.ciAppIds);
      if (read.verdict === 'fail' && read.failing.every(name => (latest.get(name)?.id ?? null) === (rerun.failed[name] ?? null))) read = { verdict: 'pending' };
      if (read.verdict === 'pass') rerun.passed = Object.fromEntries(rerun.failing.map(name => [name, latest.get(name)?.id ?? null]));
    }
    // A cancelled verdict is not concluded either: the guard reruns it, and the rerun is judged afresh.
    (read.verdict === 'pending' || read.verdict === 'cancelled' || rerun ? pending : verdicts).set(sha, read);
    return read;
  };
  const write = async (work: Work, revert: MainGuardRevert) => {
    await ports.record(work, revert);
    tick.steps.push({ key: work.key, mergeSha: revert.mergeSha, state: revert.state, reason: revert.reason });
  };
  const abandon = async (work: Work, revert: MainGuardRevert, cause: MainGuardAbandonCause, reason: string) => {
    if (revert.revert) await ports.closeRevert(revert.revert.pr, `Closed by Graphyard's main guard after one attempt: ${reason}`).catch(error => tick.errors.push(`closing revert PR #${revert.revert!.pr}: ${message(error)}`));
    await write(work, { ...revert, state: 'abandoned', settledAt: at, reason, cause, red: true });
  };

  // 1. Settle every revert in flight: merged, merged now, or abandoned after its one attempt.
  let reverting: Work[] = [];
  try { reverting = await ports.reverting(); } catch (error) { tick.errors.push(`reading the reverts in flight: ${message(error)}`); }
  for (const work of reverting) for (const revert of (work.mainGuardReverts ?? []).filter(entry => entry.state === 'opened' && entry.revert)) {
    try {
      const { pr, head } = revert.revert!;
      const pull = await ports.pull(pr);
      const merged = async (revertSha: string | null) => write(work, { ...revert, state: 'merged', settledAt: at, revertSha, reason: mainGuardReason(work, { ...revert, revertSha }) });
      if (pull.merged) { await merged(pull.mergeSha); continue; }
      if (!pull.open) { await abandon(work, revert, 'closed', `revert PR #${pr} was closed without merging`); continue; }
      if (pull.mergeable === false) { await abandon(work, revert, 'conflict', `revert PR #${pr} conflicts with main`); continue; }
      if (pull.head !== head) { await abandon(work, revert, 'head-moved', `revert PR #${pr}'s head moved from ${head.slice(0, 12)} to ${pull.head.slice(0, 12)}`); continue; }
      const own = commitVerdict(await ports.checks(head), options.required, options.ciAppIds);
      if (own.verdict === 'fail' || own.verdict === 'cancelled') { await abandon(work, revert, 'checks-failed', `revert PR #${pr}'s own required checks ${own.verdict === 'fail' ? 'failed' : 'were cancelled'}: ${own.failing.join(', ')}`); continue; }
      if (own.verdict === 'pending') {
        if (now.getTime() - Date.parse(revert.at) > (options.checksTimeoutMs ?? revertChecksTimeoutMs)) await abandon(work, revert, 'timeout', `revert PR #${pr}'s required checks did not conclude within ${Math.round((options.checksTimeoutMs ?? revertChecksTimeoutMs) / 60_000)} minutes`);
        continue;
      }
      // Only a revert that is exactly the inverse of the merge it names is approved or merged, and
      // a head is verified and approved once: later ticks only ask GitHub to merge it.
      const approval = `${pr}@${head}`;
      let refusal: string | null = null, unconfigured = false;
      if (!approved.has(approval)) {
        let refused: string | null;
        try { refused = revertInverseRefusal(await ports.mergeChanges(revert.mergeSha), await ports.revertChanges(pr)); }
        catch (error) { refused = `its diff could not be compared with the merge's: ${message(error)}`; }
        if (refused) { await abandon(work, revert, 'not-inverse', `revert PR #${pr} is not exactly the inverse of merge ${revert.mergeSha.slice(0, 12)}, so it is neither approved nor merged: ${refused}`); continue; }
        try {
          unconfigured = await ports.approveRevert(pr, head, `Graphyard's main guard: this revert is exactly the inverse of ${work.key}'s merge ${revert.mergeSha} and its required checks passed at ${head}.`) === 'unconfigured';
          approved.add(approval);
        } catch (error) { refusal = `the revert approver could not approve revert PR #${pr}: ${message(error)}`; }
      }
      // A refused approval still tries the merge on the App's ruleset bypass; a refused merge, or an
      // approval refused while the merge did not land, is retried from a fresh approval next tick.
      let sha: string | null = null;
      try { sha = await ports.mergeRevert(work, { pr, head, failing: revert.failing }); }
      catch (error) {
        // GY-1335: with no revert approver App nobody but the last pusher stands behind the merge, so
        // the refusal names the missing configuration rather than reading as a transient failure.
        refusal = [refusal, `GitHub refused to merge revert PR #${pr}: ${message(error)}`, unconfigured ? `no revert approver App is configured (${revertApproverVariables.join(', ')}), so nobody other than the last pusher approved it` : null].filter(Boolean).join('; ');
      }
      if (sha) { await merged(sha); continue; }
      if (!refusal) continue;
      approved.delete(approval);
      const refusals = [...revert.refusals ?? [], refusal];
      if (refusals.length < revertLandingAttempts) { await write(work, { ...revert, refusals }); continue; }
      await abandon(work, { ...revert, refusals }, 'approval-refused', approvalRefusedReason(revert, refusals));
    } catch (error) { tick.errors.push(`${work.key} revert of ${revert.mergeSha.slice(0, 12)}: ${message(error)}`); }
  }

  // 2. Read main; when a merge broke it, revert exactly that merge, once. With no required check
  //    known there is nothing to judge a commit by, so main is not read at all.
  if (!options.required.length) return tick;
  try {
    tick.main = await readMain(await ports.history(), verdict);
  } catch (error) { tick.errors.push(`reading main: ${message(error)}`); return tick; }
  // A rerun that passed was a flake (GY-1497): main reverts nothing and the item records it. A rerun
  // of a merge main no longer names (a later commit passed above it, or it left the history read) is
  // read once more for its flake and then forgotten, so it is never polled again.
  const current = tick.main.state === 'pending' ? tick.main.probe : tick.main.state === 'broken' ? tick.main.culprit : null;
  for (const [sha, rerun] of reruns) {
    try {
      if ((await verdict(sha)).verdict !== 'pass') { if (sha !== current) reruns.delete(sha); continue; }
      const work = await ports.culprit(sha);
      const flakes = rerun.failing.map(check => ({ mergeSha: sha, check, failedRunId: rerun.failed[check] ?? null, rerunRunId: rerun.passed?.[check] ?? null, at }));
      if (work) await (ports.recordFlakes ? ports.recordFlakes(work, flakes) : applyMainGuardFlakes(work, flakes));
      tick.flakes.push(...flakes);
      reruns.delete(sha);
    } catch (error) { tick.errors.push(`recording the flake on ${sha.slice(0, 12)}: ${message(error)}`); }
  }
  if (tick.main.state === 'pending' && tick.main.cancelled) { await rerunCancelled(ports, tick, tick.main.probe, tick.main.cancelled, options.cancelled ?? new Set(), at); return tick; }
  // A merge whose rerun has not concluded keeps main pending until it does or its time runs out, which counts as the failure.
  const running = tick.main.state === 'pending' ? reruns.get(tick.main.probe) : undefined;
  let timedOut = false;
  if (tick.main.state === 'pending' && running) {
    if (now.getTime() - running.at <= timeoutMs) { tick.main = { ...tick.main, rerun: { failing: running.failing } }; return tick; }
    tick.main = { state: 'broken', culprit: tick.main.probe, parent: running.parent, failing: running.failing }; timedOut = true;
  }
  if (tick.main.state !== 'broken') return tick;
  const broken = tick.main;
  let work: Work | null;
  try { work = await ports.culprit(broken.culprit); } catch (error) { tick.errors.push(`finding the item of ${broken.culprit.slice(0, 12)}: ${message(error)}`); return tick; }
  // A merge already reverted or abandoned is never tried again; a commit no item delivered is not the guard's to revert.
  // A cancelled run reported as an infrastructure fault reverted nothing, so a real failure after it still is.
  if (!work || work.mainGuardReverts?.some(entry => entry.mergeSha === broken.culprit && entry.cause !== 'cancelled') || work.stage !== 'done' || work.delivery?.mergeSha !== broken.culprit) { reruns.delete(broken.culprit); return tick; }
  let note = '';
  try {
    const decided = timedOut ? { pending: false as const, note: `; its rerun did not conclude within ${Math.round(timeoutMs / 60_000)} minutes` } : await rerunFailed(ports, broken, reruns, options, now, timeoutMs);
    if (decided.pending) { verdicts.delete(broken.culprit); tick.main = { state: 'pending', probe: broken.culprit, rerun: { failing: broken.failing } }; return tick; }
    note = decided.note;
  } catch (error) { tick.errors.push(`rerunning main's failed run on ${broken.culprit.slice(0, 12)}: ${message(error)}`); return tick; }
  reruns.delete(broken.culprit);
  const base: MainGuardRevert = { mergeSha: broken.culprit, pr: work.submission?.pr ?? null, failing: broken.failing, revert: null, state: 'opened', at, settledAt: null, revertSha: null, reason: null };
  try {
    const opened = await ports.openRevert(work, broken.culprit, `${work.key}'s merge ${broken.culprit.slice(0, 12)} broke main: ${broken.failing.join(', ')} failed on it while its parent ${broken.parent.slice(0, 12)} passed${note}. Graphyard's main guard reverts it so main is green again; ${work.key} is reopened for a rework round.`);
    if ('refusal' in opened) await write(work, { ...base, state: 'abandoned', settledAt: at, reason: opened.refusal, cause: 'conflict', red: true });
    else await write(work, { ...base, revert: opened });
  } catch (error) {
    // One attempt: a revert that could not be opened is abandoned, never retried.
    await write(work, { ...base, state: 'abandoned', settledAt: at, reason: `the revert could not be opened: ${message(error)}`, cause: 'unopened', red: true }).catch(failure => tick.errors.push(`${work.key}: ${message(failure)}`));
  }
  return tick;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Whether a broken merge is rerun before it is reverted (GY-1497): `pending` while its failed jobs
 * are rerun once, else the revert goes ahead with `note` saying how the rerun ended. A merge whose
 * rerun was requested and failed again, whose job was already rerun (`mainFailedRerunLimit`, read from
 * its attempt, so a restart never reruns it twice), whose rerun GitHub refused or that waited past
 * `timeoutMs`, or that an adapter cannot rerun, is reverted. Only reading the checks may throw.
 */
async function rerunFailed(ports: MainGuardPorts, broken: { culprit: string; parent: string; failing: string[] }, reruns: Map<string, MainRerun>, options: MainGuardOptions, now: Date, timeoutMs: number): Promise<{ pending: true } | { pending: false; note: string }> {
  const known = reruns.get(broken.culprit);
  if (known?.requested) return { pending: false, note: ` and failed again when its failed jobs were rerun` };
  if (!ports.jobRun || !ports.rerunFailed) return { pending: false, note: '' };
  if (known && now.getTime() - known.at > timeoutMs) return { pending: false, note: `; its rerun did not start within ${Math.round(timeoutMs / 60_000)} minutes` };
  const latest = latestRuns(await ports.checks(broken.culprit), options.ciAppIds);
  const failed = Object.fromEntries(broken.failing.map(name => [name, latest.get(name)?.id ?? null]));
  const checkRun = broken.failing.map(name => failed[name]).find(id => id !== null);
  if (checkRun == null) return { pending: false, note: '' };
  try {
    const run = await ports.jobRun(checkRun);
    if (!known && Math.max(0, (run.attempt ?? 1) - 1) >= mainFailedRerunLimit) return { pending: false, note: ` on attempt ${run.attempt} of CI run ${run.id}` };
    const requested = await ports.rerunFailed(checkRun, run) === 'requested';
    reruns.set(broken.culprit, { failing: broken.failing, failed, parent: broken.parent, at: known?.at ?? now.getTime(), requested });
    return { pending: true };
  } catch (error) { return { pending: false, note: `; GitHub refused to rerun its failed jobs (${message(error)})` }; }
}

/**
 * Main's commit `sha` concluded only cancelled (GY-1468): its run's failed jobs are rerun while the
 * cancelled job's attempt is within `mainCancelledRerunLimit` reruns; past it, the run is recorded
 * on the merge's item as an infrastructure fault naming the run and the step its job stopped in
 * (or, with no item, reported in the tick's errors). Nothing is reverted. Each cancelled check run
 * is acted on once: `seen` is keyed on it before GitHub is asked anything, so a reported run costs
 * no request on later ticks, and it is marked only once its rerun was requested or its fault durably
 * recorded, so a failed record is retried on the next tick.
 */
async function rerunCancelled(ports: MainGuardPorts, tick: MainGuardTick, sha: string, cancelled: { failing: string[]; checkRun?: number }, seen: Set<string>, at: string) {
  if (cancelled.checkRun === undefined || !ports.jobRun || !ports.rerunFailed) return;
  const seenKey = `${sha}@${cancelled.checkRun}`;
  if (seen.has(seenKey)) return;
  try {
    const run = await ports.jobRun(cancelled.checkRun);
    const reruns = Math.max(0, (run.attempt ?? 1) - 1);
    if (reruns < mainCancelledRerunLimit) {
      if (await ports.rerunFailed(cancelled.checkRun, run) === 'requested') seen.add(seenKey);
      return;
    }
    const reason = `infrastructure fault: CI run ${run.id} on main's merge ${sha.slice(0, 12)} concluded ${cancelled.failing.join(', ')} only through cancelled or timed-out jobs on attempt ${run.attempt ?? '?'}${run.step ? `, stopped in step "${run.step}"` : ''}, after ${reruns} rerun${reruns === 1 ? '' : 's'}; no test failed, so the merge is not reverted`;
    const work = await ports.culprit(sha);
    if (!work || work.delivery?.mergeSha !== sha) tick.errors.push(`main guard: ${reason}`);
    else if (!work.mainGuardReverts?.some(entry => entry.mergeSha === sha)) {
      await ports.record(work, { mergeSha: sha, pr: work.submission?.pr ?? null, failing: cancelled.failing, revert: null, state: 'abandoned', at, settledAt: at, revertSha: null, reason, cause: 'cancelled', run: { id: run.id, attempt: run.attempt } });
      tick.steps.push({ key: work.key, mergeSha: sha, state: 'abandoned', reason });
    }
    seen.add(seenKey);
  } catch (error) { tick.errors.push(`rerunning main's cancelled run on ${sha.slice(0, 12)}: ${message(error)}`); }
}

/** What main still owes after a revert is abandoned: its failing checks stay red until the next merge to main re-runs CI. */
const staysRed = (failing: readonly string[]) => `main's required check${failing.length === 1 ? '' : 's'} ${failing.join(', ') || 'that failed'} ${failing.length === 1 ? 'stays' : 'stay'} red until the next merge to main re-runs CI`;
/** The abandonment reason of a revert GitHub's approval rule or the approver App refused every attempt to land (GY-1332). */
export function approvalRefusedReason(revert: Pick<MainGuardRevert, 'revert' | 'failing'>, refusals: readonly string[]): string {
  return `GitHub's approval rule refused revert PR #${revert.revert?.pr ?? '?'} on all ${refusals.length} approve-then-merge attempts (last: ${refusals.at(-1) ?? 'no detail'}); ${staysRed(revert.failing)}`;
}
const causeText: Record<MainGuardAbandonCause, string> = {
  'approval-refused': 'approval-rule refusal', 'checks-failed': 'its checks failed', timeout: 'its checks timed out', conflict: 'conflict',
  'not-inverse': 'not the exact inverse', closed: 'closed', 'head-moved': 'head moved', unopened: 'could not be opened', cancelled: 'cancelled run',
};

/**
 * The attention lines the loop raises, one per abandoned revert (cycle-delivery.ts records each
 * under `key`): the merge, the failing checks, the revert PR, why it could not merge (its cause) and
 * that main stays red until the next merge re-runs CI. A `red` line (GY-1332) is raised every cycle
 * while main's `failing` checks have not passed again, then once more as `recovered`; a line of a
 * record older than GY-1332, or with no failing check named, is raised once.
 *
 * `since` keeps "once" true after the loop's cursor retires the line's row (GY-1250 review): the
 * cursor prunes its oldest resolved rows, so a missing row alone cannot tell "never raised" from
 * "raised and pruned". A revert abandoned at or before `since` — the oldest row the cursor still
 * holds, once it holds as many as it keeps — could have been raised and pruned (its row was recorded
 * after it was abandoned), so it is not raised again; one abandoned later is newer than every
 * retained row, so it cannot have been pruned, and is raised once. `since` applies only to a line
 * whose row the cursor no longer `held`s: a red line is re-recorded every cycle, so its row is held
 * and it keeps being raised however many newer rows the cursor fills with (GY-1332 review); a
 * pruned row had stopped, which only recovery does.
 */
export function mainGuardAttention(all: Pick<Work, 'key' | 'mainGuardReverts'>[], since = -Infinity, held: (key: string) => boolean = () => false): { key: string; work: string; text: string; red: string[]; recovered: string }[] {
  return all.flatMap(work => (work.mainGuardReverts ?? []).filter(revert => revert.state === 'abandoned' && (held(`escalation:main-guard:${revert.mergeSha}`) || !(Date.parse(revert.settledAt ?? revert.at) <= since))).map(revert => {
    // A cancelled run (GY-1468) broke nothing: the line is the infrastructure fault, raised once.
    if (revert.cause === 'cancelled') return { key: `escalation:main-guard:${revert.mergeSha}`, work: work.key, red: [], text: `Main guard: ${work.key}'s merge ${revert.mergeSha.slice(0, 12)}${revert.pr ? ` (PR #${revert.pr})` : ''} — ${revert.reason ?? 'its CI run stayed cancelled'}. Fix the CI infrastructure and rerun run ${revert.run?.id ?? '?'}: until a rerun concludes, main stays pending and no later merge is judged; a real failure on that rerun is still reverted.`, recovered: '' };
    const head = `Main guard: ${work.key}'s merge ${revert.mergeSha.slice(0, 12)}${revert.pr ? ` (PR #${revert.pr})` : ''} broke main (${revert.failing.join(', ') || 'required checks failed'}) and could not be reverted automatically${revert.cause ? ` [${causeText[revert.cause]}]` : ''}: ${revert.revert ? `revert PR #${revert.revert.pr}` : 'no revert PR'} — ${revert.reason ?? 'abandoned'}.`;
    const red = revert.red ? revert.failing : [];
    return {
      key: `escalation:main-guard:${revert.mergeSha}`, work: work.key, red,
      text: red.length ? `${head} Main is still red: ${staysRed(red)} (a forward fix, an unrelated merge or a later revert); this line is raised every cycle until it passes.` : `${head} The guard does not retry it and holds nothing; fix main forward with a new item.`,
      recovered: `${head} Main's ${red.join(', ')} passed again; nothing is owed.`,
    };
  }));
}

/** The deployment variables that register the independent revert approver App (GY-1291). */
export const revertApproverVariables = ['GRAPHYARD_REVERT_APPROVER_APP_ID', 'GRAPHYARD_REVERT_APPROVER_INSTALLATION_ID', 'GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY'] as const;
/** What the control plane reports of the main guard on `/api/status` (GY-1335). */
export interface MainGuardReadiness {
  /** The guard runs: GitHub delivery with an App, and required checks to judge main's commits by. */
  armed: boolean; required: string[];
  /** The revert approver App's id, or null when none is configured. */
  revertApprover: number | null;
  /** Why the guard cannot land a revert as configured; null when nothing is owed. */
  attention: string | null;
}
/**
 * Whether the main guard can land a revert (GY-1335). Branch protection on main requires an
 * approval from someone other than the last pusher, and the control-plane App pushes every revert,
 * so without the revert approver App every revert merge is refused ("New changes require approval
 * from someone other than the last pusher") and main stays red until an unrelated merge re-runs
 * CI. That is a configuration fault known before any merge breaks main, so doctor and master
 * status name it while the guard is armed, and stop once the approver is configured.
 */
export function mainGuardReadiness(facts: { github: boolean; required: readonly string[]; revertApprover: number | null }): MainGuardReadiness {
  const armed = facts.github && facts.required.length > 0;
  const attention = armed && facts.revertApprover === null
    ? `The main guard's revert approver is missing: set ${revertApproverVariables.join(', ')} (or _PRIVATE_KEY_FILE) on the control plane to an App other than the control-plane App, e.g. the reviewer App. Main's last-push-approval rule (require_last_push_approval) refuses every revert merge the control-plane App pushed without another's approval, so after a merge that breaks main its required checks (${facts.required.join(', ')}) would stay red until an unrelated merge re-runs CI`
    : null;
  return { armed, required: [...facts.required], revertApprover: facts.revertApprover, attention };
}
