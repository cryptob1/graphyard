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
  /** The failing cause read from `logTail` when the verdict joined the loop's cursor (GY-1564): the cursor drops the log but keeps what it names. */
  cause?: string;
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
    // The ledger's copy of a pair carries the cause the cursor's may lack, and either way the line names it. The ledger reads
    // its cause afresh from the log, so a contamination cause from either copy wins over a cursor's older generic one (GY-1565).
    const pair = shadowDisagreementPair(verdict), causes = [verdict.cause, newest.get(pair)?.cause];
    const cause = causes.find(entry => entry?.startsWith(sharedTmpContamination)) ?? causes.find(Boolean);
    newest.set(pair, cause ? { ...verdict, cause } : verdict);
  }
  return [...newest.values()].filter(verdict => shadowDisagreement(verdict.outcome) && !shadowPairExplained(verdict, explanations)).map(verdict => ({
    subject: 'shadow-gate', text: shadowDisagreementDetail(verdict),
    role: 'master' as const, approvedBy: null, human: false, humanOnly: null, next: `Explain the disagreement on ${verdict.key} before the switch to control-plane merging; nothing is changed`,
  }));
}

/** The longest failing cause a verdict keeps: a few test names and the first error line of each. */
export const trialCauseLength = 400;
// A trial keeps FORCE_COLOR, so the runner's summary may carry ANSI escapes before every line it prints.
const ansiEscape = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/**
 * The line a trial's log tail puts where it cut a failing group's output (GY-1639): what follows may
 * be the middle of a `failing tests:` summary whose heading was cut, so it reopens summary reading.
 */
export const trialCutLine = "… (this group's earlier output was cut)";
const testId = (line: string) => line.replace(/^\s*✖\s*/, '').replace(/\s*\([\d.]+m?s\)\s*$/, '').split(' — ')[0]!.trim();

/**
 * The failing cause a trial's log tail names, or null when it names none (GY-1564): the node test
 * runner's `failing tests:` summaries (each test, its file and its first error line, once; a summary
 * whose heading the tail cut off included), else TAP
 * `not ok` lines, else the first TypeScript error of a failed build. ANSI escapes are stripped first.
 */
export function trialFailureCause(logTail: string | undefined | null): string | null {
  if (!logTail) return null;
  const lines = logTail.replace(ansiEscape, '').split('\n');
  const named: string[] = [];
  // A trial concatenates its groups' output, so the log may carry one summary per failed group: each
  // `failing tests:` heading opens a summary, and an unindented line that is neither a test nor its file closes it.
  // The tail is cut to its last characters, so it may start inside a summary whose heading was cut off:
  // complete entries before any other unindented line are read as that summary's. A failing group's
  // own cut output (`trialCutLine`) is read the same way.
  let inSummary = true, file: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s*✖ failing tests:\s*$/.test(line) || line.trim() === trialCutLine) { inSummary = true; file = null; continue; }
    if (!inSummary || !line.trim()) continue;
    const at = line.match(/^test at (\S+?):\d+:\d+\s*$/);
    if (at) { file = at[1]!; continue; }
    if (!/^\s*✖ /.test(line)) { if (!/^\s/.test(line)) inSummary = false; continue; }
    const error = lines.slice(index + 1).find(next => next.trim() && !/^\s*✖ /.test(next) && !/^test at /.test(next));
    const entry = `${testId(line)}${file ? ` (${file})` : ''}${error && /^\s/.test(error) ? `: ${error.trim().replace(/:$/, '')}` : ''}`;
    if (!named.includes(entry)) named.push(entry);
    file = null;
  }
  if (!named.length) for (const line of lines) { const failed = line.match(/^\s*not ok \d+ - (.+)$/); if (failed) named.push(failed[1]!.trim()); }
  if (!named.length) { const build = lines.find(line => /error TS\d+:/.test(line)); if (build) named.push(build.trim()); }
  if (!named.length) return null;
  const text = named.join('; ');
  return text.length > trialCauseLength ? `${text.slice(0, trialCauseLength - 1)}…` : text;
}

/**
 * The dependency-share signature (GY-1565): one failing deep-equal assertion whose actual side is
 * exactly `[]` and whose expected side is a mirrored node_modules sourced in a fixture directly
 * under the shared /tmp. A stray /tmp/node_modules is what the fixture's upward install lookup found
 * first, so the mirror shared nothing. Only a trial that ran under the host's shared tmp can print
 * it: since GY-1565 a trial's fixtures sit in its own `gy-t*` directory, so a source there is not
 * the signature. The fragments must share one assertion's diff, between its message and its stack.
 */
export function sharedTmpDependencySource(logTail: string): string | null {
  const lines = logTail.replace(ansiEscape, '').split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (!/Expected values to be strictly deep-equal/.test(lines[index]!)) continue;
    const rest = lines.slice(index + 1), end = rest.findIndex(line => /^\s*at /.test(line) || /^\s*✖ /.test(line) || /AssertionError/.test(line));
    const diff = end < 0 ? rest : rest.slice(0, end), actual = diff.filter(line => /^\s*\+ /.test(line) && !/^\s*\+ actual - expected\s*$/.test(line));
    if (actual.length !== 1 || !/^\s*\+ \[\]\s*$/.test(actual[0]!)) continue;
    const source = diff.map(line => /^\s*-\s+source: '(\/tmp\/(?!gy-t)[^/']+\/node_modules)',?\s*$/.exec(line)?.[1]).find(Boolean);
    if (source) return source;
  }
  return null;
}
/** How a cause read from a log with the dependency-share signature begins, so the attention line names the contamination. */
export const sharedTmpContamination = "trial-environment contamination of the host's shared tmp";

/**
 * The cause a failing verdict's record names (GY-1564, GY-1565): the trial-environment contamination
 * when its log tail carries the dependency-share signature, naming the failing test it broke; else the
 * failing cause the log names; null when it names none. It is told as contamination only on a
 * shadow-only-fail's line, where GitHub's CI passed the same merge under a clean tmp: a real
 * mirroring defect fails there too.
 */
export function recordedFailureCause(logTail: string | undefined | null): string | null {
  const failing = trialFailureCause(logTail), source = logTail ? sharedTmpDependencySource(logTail) : null;
  if (!source) return failing;
  const text = `${sharedTmpContamination} (pre-GY-1565): ${failing ?? 'a fixture'} expected a dependency mirror sourced at ${source} and got [], `
    + 'because a stray /tmp/node_modules shadowed it, a trial-environment-only false positive';
  return text.length > trialCauseLength ? `${text.slice(0, trialCauseLength - 1)}…` : text;
}

/** A verdict as the loop's cursor keeps it: without its log, with the cause the log named (GY-1564), read afresh when the log is there. */
export function cursorVerdict<T extends Pick<ShadowVerdict, 'logTail' | 'cause'>>(verdict: T): Omit<T, 'logTail'> {
  const { logTail, ...kept } = verdict;
  const cause = recordedFailureCause(logTail) ?? kept.cause;
  return cause ? { ...kept, cause } : kept;
}

const listed = (files: readonly string[]) => `${files.slice(0, 5).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}`;

/**
 * Why a disagreement stands, from its record alone: the pre-GY-1548 placeholder, the conflict, the
 * build, or the failing files and the cause the log tail named (GY-1564), or the shared-tmp contamination (GY-1565). A shadow-only-fail whose
 * record names no cause says so: that gap is missing evidence, not an explanation.
 */
export function shadowDisagreementCause(verdict: Pick<ShadowVerdict, 'outcome' | 'build' | 'tests'> & Partial<Pick<ShadowVerdict, 'conflict' | 'cause' | 'logTail'>>) {
  if (isPlaceholderVerdict(verdict)) return `the failure is the fabricated-runner-failure placeholder ${placeholderRunnerFailure} (pre-GY-1548: the runner died naming no test while every file passed)`;
  if (verdict.outcome === 'shadow-missed') return 'the shadow trial passed it but the main guard reverted it';
  const cause = recordedFailureCause(verdict.logTail) ?? verdict.cause;
  const failed = verdict.conflict?.length ? `the trial merge conflicted on ${listed(verdict.conflict)}`
    : verdict.build === 'fail' ? 'the trial build failed'
    : verdict.tests.failed.length ? `${verdict.tests.failed.length} of ${verdict.tests.files} test files failed in the trial (${listed(verdict.tests.failed)})` : 'the trial failed';
  return `the shadow trial failed it but GitHub merged it: ${failed}; `
    + (cause?.startsWith(sharedTmpContamination) ? `the failure is ${cause}` : cause ? `the trial log names ${cause}` : 'the record names no failing cause (no log tail recorded, or none it could read), so the cause is missing evidence until the trial log is read');
}

export function shadowDisagreementDetail(verdict: Pick<ShadowVerdict, 'key' | 'head' | 'mergeSha' | 'outcome' | 'build' | 'tests'> & Partial<Pick<ShadowVerdict, 'conflict' | 'cause' | 'logTail'>>) {
  return `Shadow merge gate: ${verdict.key} head ${verdict.head} is ${verdict.outcome} (trial merge ${verdict.mergeSha ?? 'none: it conflicts'}); `
    + `${shadowDisagreementCause(verdict)}. Report only: nothing is changed`;
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
