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
// The guard never holds anything. A revert gets one attempt: one that conflicts, whose checks fail
// or do not conclude, or that GitHub refuses to merge is closed and recorded `abandoned`, which the
// loop raises as one attention line naming the merge, the failing check and the revert PR. A merge
// already reverted or abandoned is never tried again, so the next red main is judged afresh.
//
// The judgement and the reopen are pure; the GitHub job loop runs the guard with the App's client
// (`guardGitHubMain` in github.ts) and the loop raises the attention (cycle-delivery.ts).
import type { Work } from './model/work.js';
import { recordRework } from './pipeline-speed.js';

declare module './model/work.js' {
  interface Work {
    /** Every revert the main guard made of this item's merges (GY-1250), oldest first; kept across the rework round. */
    mainGuardReverts?: MainGuardRevert[];
  }
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
}

export interface CheckRun { name: string; result: string; appId: number; id?: number }
export type CommitVerdict = { verdict: 'pass' } | { verdict: 'fail'; failing: string[] } | { verdict: 'pending' };
const failedConclusions = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);

/**
 * The required checks on one commit, from the CI apps only: `fail` names each required check whose
 * latest run concluded unsuccessfully, `pending` is any required check not concluded yet.
 */
export function commitVerdict(checks: CheckRun[], required: readonly string[], ciAppIds: readonly number[]): CommitVerdict {
  const failing: string[] = []; let pending = !required.length;
  for (const name of required) {
    const latest = checks.filter(check => check.name === name && ciAppIds.includes(check.appId))
      .reduce<CheckRun | undefined>((best, check) => !best || (check.id ?? 0) >= (best.id ?? 0) ? check : best, undefined);
    if (!latest || !['success', 'skipped', ...failedConclusions].includes(latest.result)) pending = true;
    else if (failedConclusions.has(latest.result)) failing.push(name);
  }
  return failing.length ? { verdict: 'fail', failing } : pending ? { verdict: 'pending' } : { verdict: 'pass' };
}

/** One commit of main's first-parent history, newest first. */
export interface MainCommit { sha: string; parent: string | null }
/**
 * Where main stands, read from its first-parent history newest first:
 * - `green`: the tip passed;
 * - `broken`: `culprit` failed `failing` while its parent passed, and nothing after it passed;
 * - `pending`: the commit after the last green one has not concluded, so no culprit can be named;
 * - `unknown`: no commit in the history read passed.
 */
export type MainState = { state: 'green' } | { state: 'broken'; culprit: string; parent: string; failing: string[] } | { state: 'pending'; probe: string } | { state: 'unknown' };
export async function readMain(history: MainCommit[], verdict: (sha: string) => Promise<CommitVerdict>): Promise<MainState> {
  for (let index = 0; index < history.length; index++) {
    if ((await verdict(history[index].sha)).verdict !== 'pass') continue;
    if (index === 0) return { state: 'green' };
    const child = history[index - 1], judged = await verdict(child.sha);
    return judged.verdict === 'fail' ? { state: 'broken', culprit: child.sha, parent: history[index].sha, failing: judged.failing } : { state: 'pending', probe: child.sha };
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
  work.queue = null; work.queueEjection = null; work.reworkRequested = false;
  return true;
}

/** Writes one revert step onto the item's record (replacing the step for the same merge); the reopen when it merged. */
export function applyMainGuardRevert(work: Work, revert: MainGuardRevert, now: Date): { reopened: boolean } {
  work.mainGuardReverts = [...(work.mainGuardReverts ?? []).filter(entry => entry.mergeSha !== revert.mergeSha), revert];
  return { reopened: revert.state === 'merged' && reopenReverted(work, revert, now) };
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
  /** Merges the revert as the App, bound to `head`; the merge commit, or null when GitHub has not merged it yet. */
  mergeRevert(work: Work, revert: { pr: number; head: string; failing: string[] }): Promise<string | null>;
  closeRevert(pr: number, reason: string): Promise<void>;
  /** Saves the revert step onto the item (`applyMainGuardRevert`), evaluating it when it reopened. */
  record(work: Work, revert: MainGuardRevert): Promise<void>;
}
export interface MainGuardOptions {
  required: readonly string[]; ciAppIds: readonly number[]; now?: Date;
  /** Concluded verdicts by commit, kept across ticks: a concluded check run does not change. */
  verdicts?: Map<string, CommitVerdict>;
  /** How long a revert's own checks may run before it is abandoned. */
  checksTimeoutMs?: number;
}
/** A revert whose own checks have not concluded in this long is closed: the guard never waits on one indefinitely. */
export const revertChecksTimeoutMs = 60 * 60_000;

export interface MainGuardTick { main: MainState; steps: { key: string; mergeSha: string; state: MainGuardRevert['state']; reason: string | null }[]; errors: string[] }
/**
 * One tick of the guard: settles every revert in flight, then reads main and reverts the merge that
 * broke it, once. Each step is independent: a failure of one is reported in `errors`, never holds
 * another, and is read afresh on the next tick.
 */
export async function runMainGuard(ports: MainGuardPorts, options: MainGuardOptions): Promise<MainGuardTick> {
  const now = options.now ?? new Date(), at = now.toISOString(), verdicts = options.verdicts ?? new Map<string, CommitVerdict>();
  const tick: MainGuardTick = { main: { state: 'unknown' }, steps: [], errors: [] };
  const verdict = async (sha: string) => {
    const known = verdicts.get(sha);
    if (known) return known;
    const read = commitVerdict(await ports.checks(sha), options.required, options.ciAppIds);
    if (read.verdict !== 'pending') verdicts.set(sha, read);
    return read;
  };
  const write = async (work: Work, revert: MainGuardRevert) => {
    await ports.record(work, revert);
    tick.steps.push({ key: work.key, mergeSha: revert.mergeSha, state: revert.state, reason: revert.reason });
  };
  const abandon = async (work: Work, revert: MainGuardRevert, reason: string) => {
    if (revert.revert) await ports.closeRevert(revert.revert.pr, `Closed by Graphyard's main guard after one attempt: ${reason}`).catch(error => tick.errors.push(`closing revert PR #${revert.revert!.pr}: ${message(error)}`));
    await write(work, { ...revert, state: 'abandoned', settledAt: at, reason });
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
      if (!pull.open) { await abandon(work, revert, `revert PR #${pr} was closed without merging`); continue; }
      if (pull.mergeable === false) { await abandon(work, revert, `revert PR #${pr} conflicts with main`); continue; }
      if (pull.head !== head) { await abandon(work, revert, `revert PR #${pr}'s head moved from ${head.slice(0, 12)} to ${pull.head.slice(0, 12)}`); continue; }
      const own = commitVerdict(await ports.checks(head), options.required, options.ciAppIds);
      if (own.verdict === 'fail') { await abandon(work, revert, `revert PR #${pr}'s own required checks failed: ${own.failing.join(', ')}`); continue; }
      if (own.verdict === 'pending') {
        if (now.getTime() - Date.parse(revert.at) > (options.checksTimeoutMs ?? revertChecksTimeoutMs)) await abandon(work, revert, `revert PR #${pr}'s required checks did not conclude within ${Math.round((options.checksTimeoutMs ?? revertChecksTimeoutMs) / 60_000)} minutes`);
        continue;
      }
      let sha: string | null;
      try { sha = await ports.mergeRevert(work, { pr, head, failing: revert.failing }); }
      catch (error) { await abandon(work, revert, `GitHub refused to merge revert PR #${pr}: ${message(error)}`); continue; }
      if (sha) await merged(sha);
    } catch (error) { tick.errors.push(`${work.key} revert of ${revert.mergeSha.slice(0, 12)}: ${message(error)}`); }
  }

  // 2. Read main; when a merge broke it, revert exactly that merge, once.
  try {
    tick.main = await readMain(await ports.history(), verdict);
  } catch (error) { tick.errors.push(`reading main: ${message(error)}`); return tick; }
  if (tick.main.state !== 'broken') return tick;
  const broken = tick.main;
  let work: Work | null;
  try { work = await ports.culprit(broken.culprit); } catch (error) { tick.errors.push(`finding the item of ${broken.culprit.slice(0, 12)}: ${message(error)}`); return tick; }
  // A merge already reverted or abandoned is never tried again; a commit no item delivered is not the guard's to revert.
  if (!work || work.mainGuardReverts?.some(entry => entry.mergeSha === broken.culprit) || work.stage !== 'done' || work.delivery?.mergeSha !== broken.culprit) return tick;
  const base: MainGuardRevert = { mergeSha: broken.culprit, pr: work.submission?.pr ?? null, failing: broken.failing, revert: null, state: 'opened', at, settledAt: null, revertSha: null, reason: null };
  try {
    const opened = await ports.openRevert(work, broken.culprit, `${work.key}'s merge ${broken.culprit.slice(0, 12)} broke main: ${broken.failing.join(', ')} failed on it while its parent ${broken.parent.slice(0, 12)} passed. Graphyard's main guard reverts it so main is green again; ${work.key} is reopened for a rework round.`);
    if ('refusal' in opened) await write(work, { ...base, state: 'abandoned', settledAt: at, reason: opened.refusal });
    else await write(work, { ...base, revert: opened });
  } catch (error) {
    // One attempt: a revert that could not be opened is abandoned, never retried.
    await write(work, { ...base, state: 'abandoned', settledAt: at, reason: `the revert could not be opened: ${message(error)}` }).catch(failure => tick.errors.push(`${work.key}: ${message(failure)}`));
  }
  return tick;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * The attention lines the loop raises, one per abandoned revert (cycle-delivery.ts records each
 * once under `key`): the merge, the failing checks, the revert PR and why it could not merge.
 */
export function mainGuardAttention(all: Pick<Work, 'key' | 'mainGuardReverts'>[]): { key: string; work: string; text: string }[] {
  return all.flatMap(work => (work.mainGuardReverts ?? []).filter(revert => revert.state === 'abandoned').map(revert => ({
    key: `escalation:main-guard:${revert.mergeSha}`, work: work.key,
    text: `Main guard: ${work.key}'s merge ${revert.mergeSha.slice(0, 12)}${revert.pr ? ` (PR #${revert.pr})` : ''} broke main (${revert.failing.join(', ') || 'required checks failed'}) and could not be reverted automatically: ${revert.revert ? `revert PR #${revert.revert.pr}` : 'no revert PR'} — ${revert.reason ?? 'abandoned'}. The guard does not retry it and holds nothing; fix main forward with a new item.`,
  })));
}
