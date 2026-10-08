// Concern: the shadow merge gate's pure parts — which head is tried next, how a shadow verdict compares with GitHub's, and the report.
import type { Work } from '../model.js';
import type { AttentionItem } from '../master/attention.js';

export const shadowOutcomes = ['agree-pass', 'agree-fail', 'shadow-only-fail', 'shadow-missed', 'pending'] as const;
export type ShadowOutcome = typeof shadowOutcomes[number];
/** What the shadow gate recorded for one head against one main tip. */
export interface ShadowVerdict {
  key: string; id: string; head: string; baseTip: string; mergeSha: string | null; risk: 'sensitive' | 'normal';
  build: 'pass' | 'fail'; tests: { passed: number; failed: string[]; files: number }; conflict: string[];
  durationMs: number; at: string; outcome: ShadowOutcome;
  /** The merge commit GitHub made of this head, remembered once seen: a reverted item is reopened with its delivery and candidate cleared, and the revert is matched by this commit. */
  delivered?: { mergeSha: string };
  /** The last `trialLogTailLength` characters of the trial's output, kept only when the trial did not pass (the build, a test file, or the runner's exit). The recorded event carries it; the loop's cursor does not. */
  logTail?: string;
}
/** How much of the trial's output a failing verdict records. */
export const trialLogTailLength = 4000;
/** What GitHub's gate did with the head: nothing yet, merged and kept, merged then reverted by the main guard, or failed its required checks. */
export type GithubOutcome = 'pending' | 'merged' | 'reverted' | 'failed';

/** Whether the trial passed: it merged cleanly, built, and every affected test passed. */
export const shadowPassed = (verdict: Pick<ShadowVerdict, 'build' | 'tests' | 'conflict'>) => !verdict.conflict.length && verdict.build === 'pass' && !verdict.tests.failed.length;

/**
 * When the item's current head was handed in. The pipeline timeline's resubmission or submission
 * when the snapshot carries it; the loop's coordination view drops that timeline, so there the
 * moment this very head was first observed (`headObserved`, set when the candidate changed) stands
 * in, then the pull request's creation, then the stage entry.
 */
export function submittedAtOf(item: Pick<Work, 'stageEnteredAt' | 'candidate' | 'headObserved'>): number {
  const pipeline = (item as { pipeline?: { submittedAt?: string | null; resubmittedAt?: string | null } }).pipeline;
  const observed = item.headObserved && item.candidate && item.headObserved.sha.toLowerCase() === item.candidate.sha.toLowerCase() ? item.headObserved.at : null;
  for (const at of [pipeline?.resubmittedAt, pipeline?.submittedAt, observed, item.candidate?.createdAt, item.stageEnteredAt]) if (at && Number.isFinite(Date.parse(at))) return Date.parse(at);
  return 0;
}
/** A head GitHub has already merged (or whose item is done) has no turn left: GitHub's gate decided it first. */
const landed = (item: Pick<Work, 'stage' | 'observation'>) => item.stage === 'done' || !!item.observation?.merged;

/**
 * The heads still owed a trial: submitted (a pull request and a candidate), not yet merged by
 * GitHub, with no verdict for this head against this main tip. Oldest submission first, and only
 * one per cycle.
 */
export function shadowDue(work: readonly Work[], verdicts: readonly Pick<ShadowVerdict, 'head' | 'baseTip'>[], mainTip: string): Work | null {
  const tried = new Set(verdicts.map(verdict => `${verdict.head}:${verdict.baseTip}`));
  const owed = work.filter(item => !landed(item) && item.submission && item.candidate && !tried.has(`${item.candidate.sha.toLowerCase()}:${mainTip.toLowerCase()}`));
  return owed.sort((a, b) => submittedAtOf(a) - submittedAtOf(b) || a.key.localeCompare(b.key))[0] ?? null;
}

/**
 * The merge commit GitHub made of this very head, as the snapshot holds it: a done item's delivery
 * while its candidate is still this head. Only the candidate counts. A head a later one superseded
 * was never merged, whether a worker reworked it or Graphyard refreshed it onto a newer base: the
 * snapshot keeps the refreshed-away head as `baseRefresh.from.sha`, and the delivery is its
 * successor's, not its own.
 */
export const deliveredMerge = (item: Pick<Work, 'stage' | 'candidate' | 'delivery'>, head: string): string | null =>
  item.stage === 'done' && item.delivery && item.candidate?.sha.toLowerCase() === head.toLowerCase() ? item.delivery.mergeSha.toLowerCase() : null;

/**
 * GitHub's side of the comparison for a verdict's head. The head's own merge decides, from the
 * snapshot or as the verdict remembers it (`delivered`): a main-guard revert of exactly that merge
 * commit makes it `reverted`, since a revert the guard opened, merged or abandoned is its judgement
 * that the merge broke main (a record whose cause is a cancelled CI run judged nothing); without
 * one the merge was kept, `merged`. A revert of an earlier delivery of the same item, fixed and
 * redelivered under a new head, says nothing about this head. With no merge of this head, the
 * current candidate's failed required check is `failed`; everything else is still `pending`.
 */
export function githubOutcome(item: Pick<Work, 'stage' | 'candidate' | 'delivery' | 'mainGuardReverts' | 'observation' | 'policy'> | undefined, head: string, delivered?: { mergeSha: string } | null): GithubOutcome {
  if (!item) return 'pending';
  const mergeSha = delivered?.mergeSha.toLowerCase() ?? deliveredMerge(item, head);
  if (mergeSha) return item.mainGuardReverts?.some(revert => revert.mergeSha.toLowerCase() === mergeSha && revert.cause !== 'cancelled') ? 'reverted' : 'merged';
  if (item.candidate?.sha.toLowerCase() !== head.toLowerCase()) return 'pending';
  const observed = item.observation;
  if (observed?.candidate.sha.toLowerCase() !== head.toLowerCase()) return 'pending';
  return observed.checks.some(check => item.policy.checks.includes(check.name) && ['failure', 'timed_out', 'cancelled', 'action_required', 'fail', 'failed'].includes(check.result)) ? 'failed' : 'pending';
}

/**
 * Shadow against GitHub. A pass GitHub merged is `agree-pass`; a pass the main guard reverted is
 * `shadow-missed`; a fail GitHub also failed (checks, or a revert) is `agree-fail`; a fail GitHub
 * merged and kept is `shadow-only-fail`. A pass whose checks failed on GitHub has no merge outcome
 * to judge (the head is reworked and gets a new verdict), so it stays `pending` with the rest.
 */
export function compareVerdicts(shadow: Pick<ShadowVerdict, 'build' | 'tests' | 'conflict'>, github: GithubOutcome): ShadowOutcome {
  if (github === 'pending') return 'pending';
  if (shadowPassed(shadow)) return github === 'merged' ? 'agree-pass' : github === 'reverted' ? 'shadow-missed' : 'pending';
  return github === 'merged' ? 'shadow-only-fail' : 'agree-fail';
}

const percentile = (sorted: readonly number[], fraction: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]! : null;
export interface ShadowReport {
  total: number; counts: Record<ShadowOutcome, number>; p50Ms: number | null; p90Ms: number | null;
  disagreements: { outcome: ShadowOutcome; key: string; head: string; mergeSha: string | null }[];
}
/** Outcomes re-judged against the items still in `work`, each verdict remembering the merge GitHub made of its head once seen; a verdict whose item is not there keeps its recorded outcome. */
export const judgedVerdicts = (verdicts: readonly ShadowVerdict[], work: readonly Work[]): ShadowVerdict[] =>
  verdicts.map(verdict => {
    const item = work.find(candidate => candidate.id === verdict.id || candidate.key === verdict.key);
    if (!item) return verdict;
    const mergeSha = verdict.delivered?.mergeSha ?? deliveredMerge(item, verdict.head), delivered = mergeSha ? { mergeSha } : null;
    return { ...verdict, ...(delivered ? { delivered } : {}), outcome: compareVerdicts(verdict, githubOutcome(item, verdict.head, delivered)) };
  });

/** Counts per outcome, p50 and p90 trial duration, and the newest ten disagreements with item key, head and merge sha. */
export function shadowReport(verdicts: readonly ShadowVerdict[], work: readonly Work[]): ShadowReport {
  const judged = judgedVerdicts(verdicts, work), counts = Object.fromEntries(shadowOutcomes.map(outcome => [outcome, 0])) as Record<ShadowOutcome, number>;
  for (const verdict of judged) counts[verdict.outcome] += 1;
  const durations = judged.map(verdict => verdict.durationMs).sort((a, b) => a - b);
  const disagreements = judged.filter(verdict => verdict.outcome === 'shadow-only-fail' || verdict.outcome === 'shadow-missed')
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 10).map(verdict => ({ outcome: verdict.outcome, key: verdict.key, head: verdict.head, mergeSha: verdict.mergeSha }));
  return { total: judged.length, counts, p50Ms: percentile(durations, 0.5), p90Ms: percentile(durations, 0.9), disagreements };
}

/** A disagreement is a verdict GitHub's gate contradicted: `shadow-only-fail` or `shadow-missed`. */
export const shadowDisagreement = (outcome: ShadowOutcome) => outcome === 'shadow-only-fail' || outcome === 'shadow-missed';

/**
 * The pre-GY-1548 placeholder failing file: the trial wrote this when the runner died naming no
 * test (16 MiB capture overrun) while every selected file had passed. Recognized from the record
 * so those standing disagreements are explainable without re-running a trial (GY-1560).
 */
export const placeholderRunnerFailure = 'tests/helpers/run-tests.ts';
/** Whether a verdict's failure list is exactly the fabricated-runner placeholder with build pass and every file counted as passed. */
export const isPlaceholderVerdict = (verdict: Pick<ShadowVerdict, 'build' | 'tests'>) =>
  verdict.build === 'pass'
  && verdict.tests.failed.length === 1
  && verdict.tests.failed[0] === placeholderRunnerFailure
  && verdict.tests.passed === verdict.tests.files;

/** One explanation of a (key, head, baseTip) disagreement, as the ledger and the status read it. */
export interface ShadowExplanationRef { key: string; head: string; baseTip: string }

/** The most pairs one loop read of `GET /api/shadow-explanations` names; the loop asks in chunks of this size. */
export const shadowExplanationPairsMax = 50;

/** The (work key, head, baseTip) pair an explanation and a standing disagreement share. */
export const shadowDisagreementPair = (entry: Pick<ShadowExplanationRef, 'key' | 'head' | 'baseTip'>) =>
  `${entry.key}:${entry.head.toLowerCase()}:${entry.baseTip.toLowerCase()}`;
/** Whether an explanation stands for this verdict's (key, head, baseTip). */
export const shadowPairExplained = (verdict: Pick<ShadowVerdict, 'key' | 'head' | 'baseTip'>, explanations: readonly ShadowExplanationRef[]) =>
  explanations.some(entry => shadowDisagreementPair(entry) === shadowDisagreementPair(verdict));

/**
 * `master status` attention: one line per standing (key, head, baseTip) disagreement that has no
 * explanation yet (GY-1560). A later head of the same item does not drop an earlier unexplained
 * pair; only an explanation does. Report only until explained.
 */
export function shadowGateAttention(verdicts: readonly ShadowVerdict[], explanations: readonly ShadowExplanationRef[] = []): AttentionItem[] {
  const newest = new Map<string, ShadowVerdict>();
  for (const verdict of [...verdicts].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    newest.set(shadowDisagreementPair(verdict), verdict);
  }
  return [...newest.values()].filter(verdict => shadowDisagreement(verdict.outcome) && !shadowPairExplained(verdict, explanations)).map(verdict => ({
    subject: 'shadow-gate', text: shadowDisagreementDetail(verdict),
    role: 'master' as const, approvedBy: null, human: false, humanOnly: null, next: `Explain the disagreement on ${verdict.key} before the switch to control-plane merging; nothing is changed`,
  }));
}

export function shadowDisagreementDetail(verdict: Pick<ShadowVerdict, 'key' | 'head' | 'mergeSha' | 'outcome' | 'build' | 'tests'>) {
  const cause = isPlaceholderVerdict(verdict)
    ? `the failure is the fabricated-runner-failure placeholder ${placeholderRunnerFailure} (pre-GY-1548: the runner died naming no test while every file passed)`
    : verdict.outcome === 'shadow-missed' ? 'the shadow trial passed it but the main guard reverted it' : 'the shadow trial failed it but GitHub merged it';
  return `Shadow merge gate: ${verdict.key} head ${verdict.head} is ${verdict.outcome} (trial merge ${verdict.mergeSha ?? 'none: it conflicts'}); `
    + `${cause}. Report only: nothing is changed`;
}

/** Counts per outcome plus unexplained vs explained disagreement totals the switch criterion reads (GY-1560). */
export interface ShadowReportWithExplanations extends ShadowReport {
  unexplainedDisagreements: number;
  explainedDisagreements: number;
}

/** The shadowGate report with disagreement counts split by whether an explanation stands. */
export function shadowReportWithExplanations(
  verdicts: readonly ShadowVerdict[],
  work: readonly Work[],
  explanations: readonly ShadowExplanationRef[] = [],
): ShadowReportWithExplanations {
  const report = shadowReport(verdicts, work);
  const judged = judgedVerdicts(verdicts, work).filter(verdict => shadowDisagreement(verdict.outcome));
  let explainedDisagreements = 0, unexplainedDisagreements = 0;
  for (const verdict of judged) {
    if (shadowPairExplained(verdict, explanations)) explainedDisagreements += 1;
    else unexplainedDisagreements += 1;
  }
  return { ...report, unexplainedDisagreements, explainedDisagreements };
}
