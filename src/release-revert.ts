// Concern: the related-item revert of a failed release candidate (GY-1526) — which candidate item a failing E2E case implicates, the revert the merge writer lands and the item's record of it.
import type { ReleaseCandidate, UatRecord } from './release-candidate.js';
import { verificationGlobCovers, type VerificationMap } from './model/verification-maps.js';
import type { Work } from './model/work.js';
import { recordRework } from './pipeline-speed.js';

/**
 * A candidate that fails a required E2E case on UAT is not fixed forward alone: the loop reverts
 * the merge of the candidate item the failure most plausibly implicates, trialled and pushed like
 * any merge (the merge writer's intent → trial → push → reconcile, under ledger kind `revert`),
 * records the revert on the item and reopens it for rework. The failing cases map to the release
 * contract's outcomes (e2e/contract.json), the outcomes, cases and case tags to the verification
 * maps (verification/*.md, GY-1495) by file name or Paths, and a selected map's globs to the
 * candidate items whose merge delta they cover. The newest match is reverted; with no match, the
 * newest candidate item is, since the candidate's first failure is most often its latest change.
 * Production stays on the previous release throughout, and the next cut starts after the revert.
 */

declare module './model/work.js' {
  interface Work {
    /** Every revert the loop made of this item's merges for a failed release candidate (GY-1526), oldest first. */
    candidateReverts?: CandidateRevert[];
  }
}

/** One revert of a candidate item's merge: the merge reverted, the revert commit, the candidate and the case and step that failed, and when. */
export interface CandidateRevert { mergeSha: string; revertSha: string; candidate: string; case: string; step: string; at: string }

/** A candidate item with the files its merge changed against its first parent (the merge delta). */
export interface CandidateItemDelta { key: string; mergeSha: string; files: readonly string[] }
/** The release contract's outcomes, and the case definitions' tags where the caller read them (e2e/cases/*.json). */
export interface RevertContract { outcomes: readonly { id: string; cases: readonly string[] }[]; cases?: readonly { id: string; tags?: readonly string[] }[] }
export interface RevertTarget {
  key: string; mergeSha: string; reason: string;
  candidate: string; case: string; step: string;
  /** The verification map whose globs cover the item's merge delta; null for the newest-item fallback. */
  map: string | null;
}

const short = (sha: string) => sha.slice(0, 12);
/** The name a map goes by: `verification/server.md` is `server`. */
const mapStem = (map: Pick<VerificationMap, 'path'>) => map.path.replace(/^.*\//, '').replace(/\.md$/i, '').toLowerCase();
/** The names a Paths glob carries: each segment, a file segment without its extension (`src/board.ts` names `board`). */
const globNames = (glob: string) => glob.split('/').filter(segment => segment && !/^[*.]+$/.test(segment)).flatMap(segment => [segment.toLowerCase(), segment.replace(/\.[^.]+$/, '').toLowerCase()]);

/** The required cases a UAT record's release run failed or found flaky — the ones that block promotion — with the step each failed at. */
export function failingRequiredCases(uat: Pick<UatRecord, 'e2e'>): { case: string; step: string; verdict: string }[] {
  const e2e = uat.e2e;
  if (!e2e) return [];
  const blocking = new Set(e2e.blocking);
  return e2e.cases.filter(entry => entry.required && (blocking.has(entry.case) || entry.verdict === 'failed' || entry.verdict === 'flaky'))
    .map(entry => ({ case: entry.case, step: entry.failingStep?.name ?? 'the run', verdict: entry.verdict }));
}

/**
 * Pure (AC-3): the candidate item to revert for a failed candidate, or null when no required case
 * failed outright (a flaky one never reverts) or the candidate carries no item. The failing cases, the outcomes binding them and the
 * cases' tags name the areas; a map matches when its file name or a segment of its Paths names one
 * of them. The newest candidate item (the candidate lists them newest first) whose merge delta a
 * matched map's globs cover is the target; with none covered, the newest candidate item is.
 */
export function revertTarget(candidate: Pick<ReleaseCandidate, 'id' | 'sha' | 'items'>, uat: Pick<UatRecord, 'e2e'>, items: readonly CandidateItemDelta[], maps: readonly VerificationMap[], contract: RevertContract): RevertTarget | null {
  // A flaky required case stays on the holds and evidence-decision path (release-holds.ts): only an outright failure reverts.
  const failing = failingRequiredCases(uat).filter(entry => entry.verdict === 'failed');
  const first = failing[0];
  if (!first || !candidate.items.length) return null;
  const caseIds = failing.map(entry => entry.case);
  const outcomes = contract.outcomes.filter(outcome => outcome.cases.some(id => caseIds.includes(id))).map(outcome => outcome.id);
  const tags = [...new Set((contract.cases ?? []).filter(entry => caseIds.includes(entry.id)).flatMap(entry => entry.tags ?? []))];
  const names = new Set([...caseIds, ...outcomes, ...tags].map(name => name.toLowerCase()));
  const selected = maps.filter(map => names.has(mapStem(map)) || map.paths.some(glob => globNames(glob).some(name => names.has(name))));
  const deltas = new Map(items.map(item => [item.key, item]));
  const ordered = candidate.items.map(item => ({ key: item.key, mergeSha: item.mergeSha, files: deltas.get(item.key)?.files ?? [] }));
  const failure = `Release candidate ${candidate.id} (${short(candidate.sha)}) failed required E2E case ${first.case} at step "${first.step}"${outcomes.length ? ` (outcome ${outcomes.join(', ')})` : ''}`;
  for (const item of ordered) {
    const map = selected.find(entry => entry.paths.some(glob => item.files.some(file => verificationGlobCovers(glob, file))));
    if (!map) continue;
    const covered = item.files.filter(file => map.paths.some(glob => verificationGlobCovers(glob, file)));
    return { key: item.key, mergeSha: item.mergeSha, candidate: candidate.id, case: first.case, step: first.step, map: map.path,
      reason: `${failure}; verification map ${map.path} matches it and its globs cover ${item.key}'s merge delta (${covered.slice(0, 5).join(', ')}${covered.length > 5 ? ` and ${covered.length - 5} more` : ''}), so ${item.key}'s merge ${short(item.mergeSha)} is reverted` };
  }
  const newest = ordered[0];
  return { key: newest.key, mergeSha: newest.mergeSha, candidate: candidate.id, case: first.case, step: first.step, map: null,
    reason: `${failure}; ${selected.length ? `the matching verification map${selected.length > 1 ? 's' : ''} ${selected.map(map => map.path).join(', ')} cover${selected.length > 1 ? '' : 's'} no candidate item's merge delta` : 'no verification map names the case, its outcome or its tags'}, so the newest candidate item ${newest.key}'s merge ${short(newest.mergeSha)} is reverted` };
}

// ---- The item's record and reopen --------------------------------------------------------------

/** The rework a revert reopens the item with: it names the case and step, the candidate, the merge and its revert. */
export function candidateRevertReason(work: Pick<Work, 'key'>, revert: Pick<CandidateRevert, 'mergeSha' | 'revertSha' | 'candidate' | 'case' | 'step'>) {
  return `${work.key}'s merge ${short(revert.mergeSha)} was reverted (${short(revert.revertSha)}): release candidate ${revert.candidate} failed required E2E case ${revert.case} at step "${revert.step}" on UAT. Production stays on the previous release; fix the failure on a new pull request from the current base`;
}

/**
 * Writes one revert onto the item's record (replacing an entry for the same merge) and reopens the
 * item when it still holds that delivery: the delivery is withdrawn, the item returns to ready for a
 * rework round on a fresh pull request, and the revert stays on its record (AC-4). Mutates `work`;
 * the caller evaluates and saves it. Answers whether it reopened.
 */
export function applyCandidateRevert(work: Work, revert: CandidateRevert, now: Date): { reopened: boolean } {
  work.candidateReverts = [...(work.candidateReverts ?? []).filter(entry => entry.mergeSha !== revert.mergeSha), revert];
  if (work.stage !== 'done' || work.delivery?.mergeSha.toLowerCase() !== revert.mergeSha.toLowerCase()) return { reopened: false };
  recordRework(work, now);
  work.stage = 'ready'; work.stageEnteredAt = now.toISOString();
  delete work.delivery;
  work.submission = null; work.candidate = null; work.observation = null;
  work.mergeAuthorization = null; work.mergeExecution = null; work.reviewRequest = null;
  work.reworkRequested = false;
  return { reopened: true };
}

/** The reverts the main watch classifies as `candidate-revert` (AC-5): every revert commit the items record, by candidate. */
export const candidateRevertsOf = (work: readonly Pick<Work, 'candidateReverts'>[]) =>
  work.flatMap(item => (item.candidateReverts ?? []).map(revert => ({ sha: revert.revertSha, id: revert.candidate })));

// ---- The revert through the merge writer ------------------------------------------------------

/** What `POST /api/work/:id/merge-record` takes for a revert (kind `revert`): one phase of it, with the ledger payload. */
export type RevertRecordEvent = { kind: 'revert'; mergeSha: string; candidate: string; case: string; step: string; at: string } & (
  | { phase: 'intent'; revertSha: string; baseTip: string }
  | { phase: 'trial'; revertSha: string; baseTip: string; build: 'pass' | 'fail'; tests: { passed: number; failed: string[]; files: number }; durationMs: number }
  | { phase: 'pushed'; revertSha: string; pushedAt: string }
  | { phase: 'reconciled'; revertSha: string; observedTip: string }
  | { phase: 'refused'; reason: string });
/** The ledger kind every phase of a revert is recorded under. */
export const revertLedgerKind = 'merge.revert';
/** The idempotency key one recorded phase keeps across retries. */
export const revertRecordKey = (work: Pick<Work, 'id'>, event: RevertRecordEvent) =>
  `revert-record:${work.id}:${event.phase}:${event.mergeSha}:${'revertSha' in event ? event.revertSha : 'refused'}:${'baseTip' in event ? event.baseTip : 'observedTip' in event ? event.observedTip : ''}`;

/** The trial's verdict on the revert commit: the build and the tests the changed files select. */
export interface RevertTrialRun { build: 'pass' | 'fail'; tests: { passed: number; failed: string[]; files: number }; durationMs: number }
/** Everything the revert touches outside the process: git in the coordinator checkout and a trial checkout, the deploy-key push, and the coordinator's ledger. */
export interface RevertPorts {
  baseBranch: string;
  /** How many times a rejected push is re-trialled on the new tip (`run.mergeWriter.retrials`). */
  retrials: number;
  now(): number;
  /** Fetches the base branch; answers its tip. */
  fetch(): Promise<string>;
  /** Whether the base branch's first-parent history holds `sha`, as last fetched. */
  holds(sha: string): Promise<boolean>;
  /** Builds the revert of the merge `mergeSha` on `baseTip` in a trial checkout (`git revert -m 1`): the commit and the files it changes, or the conflicting paths. */
  revert(mergeSha: string, baseTip: string): Promise<{ revertSha: string; files: string[] } | { conflict: string[] }>;
  /** The build and the tests on the revert commit, `files` being what it changes. */
  trial(revertSha: string, files: readonly string[]): Promise<RevertTrialRun>;
  /** The leased push of `revertSha` onto `baseTip`; `rejected` when the tip moved under the lease. */
  push(revertSha: string, baseTip: string): Promise<'pushed' | 'rejected'>;
  /** Records one phase on the coordinator, idempotent under `revertRecordKey`. */
  record(item: Pick<Work, 'id' | 'key'>, event: RevertRecordEvent): Promise<unknown>;
}
export type RevertOutcome =
  | { outcome: 'reverted'; revertSha: string; baseTip: string; observedTip: string; pushes: number }
  | { outcome: 'refused'; reason: string }
  | { outcome: 'requeued'; reason: string; pushes: number };

const revertRefusal = (what: string) => `revert refused: ${what}`;

/**
 * One revert, the merge writer's way (AC-4): the revert commit is built in a trial checkout on the
 * fetched tip, the intent recorded before anything runs, the trial run on the exact revert commit,
 * and the commit pushed with a lease on the tip it was tested on; a push the tip moved under rebuilds
 * and re-trials, at most `retrials` times. A conflict, a failed trial or a merge the base no longer
 * holds is refused naming why, and nothing is pushed. Every phase is recorded under ledger kind
 * `revert`; the reconcile is what records the revert on the item and reopens it (server/merge-record.ts).
 */
export async function revertCandidateItem(ports: RevertPorts, item: Pick<Work, 'id' | 'key'>, target: Pick<RevertTarget, 'mergeSha' | 'candidate' | 'case' | 'step'>): Promise<RevertOutcome> {
  const at = () => new Date(ports.now()).toISOString();
  const common = { kind: 'revert' as const, mergeSha: target.mergeSha.toLowerCase(), candidate: target.candidate, case: target.case, step: target.step };
  const refuse = async (reason: string): Promise<RevertOutcome> => { await ports.record(item, { ...common, phase: 'refused', reason, at: at() }); return { outcome: 'refused', reason }; };
  let pushes = 0;
  for (let attempt = 0; attempt <= ports.retrials; attempt++) {
    const baseTip = await ports.fetch();
    if (!(await ports.holds(common.mergeSha))) return refuse(revertRefusal(`${ports.baseBranch} no longer holds ${short(common.mergeSha)} in its first-parent history`));
    const built = await ports.revert(common.mergeSha, baseTip);
    if ('conflict' in built) return refuse(revertRefusal(`the revert conflicts in ${built.conflict.slice(0, 20).join(', ')}`));
    const { revertSha } = built;
    // The intent first: a crash from here on leaves a recorded intent, never an unexplained push.
    await ports.record(item, { ...common, phase: 'intent', revertSha, baseTip, at: at() });
    const run = await ports.trial(revertSha, built.files);
    await ports.record(item, { ...common, phase: 'trial', revertSha, baseTip, build: run.build, tests: run.tests, durationMs: run.durationMs, at: at() });
    if (run.build === 'fail') return refuse(revertRefusal(`the trial of ${short(revertSha)} failed build step npm run build`));
    if (run.tests.failed.length) return refuse(revertRefusal(`the trial of ${short(revertSha)} failed tests ${run.tests.failed.slice(0, 20).join(', ')}`));
    pushes += 1;
    if (await ports.push(revertSha, baseTip) === 'rejected') continue;
    await ports.record(item, { ...common, phase: 'pushed', revertSha, pushedAt: at(), at: at() });
    const observedTip = await ports.fetch();
    await ports.record(item, { ...common, phase: 'reconciled', revertSha, observedTip, at: at() });
    return { outcome: 'reverted', revertSha, baseTip, observedTip, pushes };
  }
  const reason = revertRefusal(`base moved ${pushes} times`);
  await ports.record(item, { ...common, phase: 'refused', reason, at: at() });
  return { outcome: 'requeued', reason, pushes };
}
