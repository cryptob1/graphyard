import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describeTiming, parseTimingRecord, percentile, type TimingMeasurement } from './timing.js';
import { timingAnnotationMarker, type TimingFailure } from '../../src/cli/timing-failures.js';
import { failedTestsAnnotation, failedTestsFromLog } from '../../src/master/base-break-refresh.js';

// The CI half of a distinguishable timing failure. The required `test` job runs this after the
// suite, whatever the suite's outcome: it reads the run's timing record and publishes, on the
// job's own check run, one annotation per timing-dependent assertion that went over its budget.
// `master status` reads those annotations back, so a red `test` check that failed on the clock
// is reported with the measured value against the budget rather than as an unqualified failure.
// It changes no verdict: the check stays failed and the gate stays refused. The same step names
// every failed test in one annotation, which the base-breakage judgement reads (GY-793).

/** How many tests the run reported failed, from the spec or TAP summary; null when it has none. */
export function failedTestCount(log: string): number | null {
  const counts = [...log.matchAll(/^(?:ℹ|#) fail (\d+)\s*$/gm)];
  return counts.length ? Number(counts.at(-1)![1]) : null;
}

/** Over-budget assertions, each with how many other tests failed beside the timing-dependent ones. */
export function timingFailures(record: TimingMeasurement[], failedTests: number | null): TimingFailure[] {
  const failed = record.filter(entry => !entry.passed);
  const timingTests = new Set(failed.map(entry => entry.test)).size;
  const otherFailures = failedTests === null ? null : Math.max(0, failedTests - timingTests);
  return failed.map(({ name, test, statistic, measuredMs, budgetMs, comparison, samples, warmupDiscarded }) => ({ name, test, statistic, measuredMs, budgetMs, comparison, samples, warmupDiscarded, otherFailures }));
}

// Workflow-command data and property escaping, as the Actions toolkit applies it.
const escapeData = (text: string) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (text: string) => escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

export const timingAnnotationTitle = 'Timing-dependent assertion over budget';
/** The annotation message: a sentence for the pull request, then the record `master status` parses. */
export const annotationMessage = (failure: TimingFailure) => `${describeTiming({ ...failure, passed: false })} in ${failure.test}. ${timingAnnotationMarker}${JSON.stringify(failure)}`;
export const annotationCommand = (failure: TimingFailure) => `::error title=${escapeProperty(timingAnnotationTitle)}::${escapeData(annotationMessage(failure))}`;

export interface TimingSpread { name: string; test: string; statistic: string; budgetMs: number; comparison: '<' | '<='; runs: number; failures: number; minMs: number; medianMs: number; maxMs: number; spreadMs: number; headroomMs: number }

/** Run-to-run spread of every timing assertion over the runs' records, against its budget. */
export function timingSpread(runs: TimingMeasurement[][]): TimingSpread[] {
  const byName = new Map<string, TimingMeasurement[]>();
  for (const entry of runs.flat()) byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry]);
  return [...byName.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, entries]) => {
    const measured = entries.map(entry => entry.measuredMs), latest = entries.at(-1)!;
    const minMs = Math.min(...measured), maxMs = Math.max(...measured);
    return { name, test: latest.test, statistic: latest.statistic, budgetMs: latest.budgetMs, comparison: latest.comparison, runs: entries.length, failures: entries.filter(entry => !entry.passed).length,
      minMs, medianMs: percentile(measured, 0.5), maxMs, spreadMs: Math.round((maxMs - minMs) * 1000) / 1000, headroomMs: Math.round((latest.budgetMs - maxMs) * 1000) / 1000 };
  });
}

/** The recorded spread an unchanged tree produced, committed beside this file by the stability run. */
export const baselineFile = fileURLToPath(new URL('./timing-baseline.json', import.meta.url));
export function readBaseline(file = baselineFile): { spread: TimingSpread[] } | null {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** The step summary: every timing-dependent assertion of the run beside its recorded spread. */
export function timingSummary(record: TimingMeasurement[], failures: TimingFailure[], baseline: { spread: TimingSpread[] } | null) {
  const lines = ['### Timing-dependent assertions', ''];
  if (!record.length) return [...lines, 'The run recorded no timing-dependent assertion.', ''].join('\n');
  lines.push('| Assertion | Test | Measured | Budget | Samples | Recorded spread on an unchanged tree | Verdict |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const entry of record) {
    const known = baseline?.spread.find(spread => spread.name === entry.name);
    lines.push(`| ${entry.name} | ${entry.test} | ${entry.statistic} ${entry.measuredMs}ms | ${entry.comparison} ${entry.budgetMs}ms | ${entry.samples} (${entry.warmupDiscarded} warmup discarded) | ${known ? `${known.minMs}–${known.maxMs}ms over ${known.runs} runs` : 'not recorded'} | ${entry.passed ? 'within budget' : '**over budget**'} |`);
  }
  if (failures.length) lines.push('', failures[0].otherFailures === 0 ? 'Every failed test in this run failed on a timing-dependent assertion: the run measured the runner or a latency regression, not a behavioural defect.'
    : failures[0].otherFailures === null ? 'The run did not report how many tests failed, so other failures cannot be ruled out.'
    : `${failures[0].otherFailures} other test(s) failed beside the timing-dependent ones: this run is not only a timing failure.`);
  return [...lines, ''].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [recordFile, logFile] = process.argv.slice(2);
  if (!recordFile) throw new Error('Usage: timing-report RECORD.jsonl [TEST.log]');
  const record = existsSync(recordFile) ? parseTimingRecord(readFileSync(recordFile, 'utf8')) : [];
  const log = logFile && existsSync(logFile) ? readFileSync(logFile, 'utf8') : null;
  // Every failed test by name, first: the observation compares them with the base branch's own
  // runs to tell a base-branch breakage from the candidate's own failure (GY-793).
  const failedTests = log === null ? null : failedTestsAnnotation(failedTestsFromLog(log) ?? []);
  if (failedTests) console.log(failedTests);
  const failures = timingFailures(record, log === null ? null : failedTestCount(log));
  for (const failure of failures) console.log(annotationCommand(failure));
  const summary = timingSummary(record, failures, readBaseline());
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary); else console.log(summary);
}
