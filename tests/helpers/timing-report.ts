/**
 * Publish the timing assertions a test run recorded (GY-95). Run by the CI `test` job after
 * `npm test`, whatever its outcome: `npx tsx tests/helpers/timing-report.ts [REPORT]`.
 *
 * It writes a table of every measurement to the job summary and emits one annotation per
 * measurement on the job's check run through the workflow-command protocol: a failed budget is an
 * `error` titled `timing assertion`, a kept one a `notice`. Master status reads the failed check's
 * annotations, so an item held on a timing artefact is reported with the measured value against the
 * budget rather than as an unqualified failed check. A run with no report recorded nothing and says so.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { readTimingReport, timingAssertionTitle, timingReportPath, timingSpread, timingSummary, type TimingMeasurement } from './timing.js';

// Workflow commands: `%`, CR and LF are reserved in the data, and `:` and `,` in a property.
const escapeData = (text: string) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (text: string) => escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

/** One workflow command per measurement: the level says whether the budget held, the title fixes the kind. */
export function annotationCommands(measurements: readonly TimingMeasurement[]): string[] {
  return measurements.map(measurement => `::${measurement.withinBudget ? 'notice' : 'error'} title=${escapeProperty(timingAssertionTitle)}::${escapeData(timingSummary(measurement))}`);
}

/** The job-summary table: one row per measurement, and the spread when an assertion reported more than once. */
export function summaryMarkdown(measurements: readonly TimingMeasurement[]): string {
  if (!measurements.length) return `### Timing assertions\n\nNo timing-dependent assertion recorded a measurement in this run.\n`;
  const rows = measurements.map(measurement => `| ${measurement.assertion} | ${measurement.measure} | p${measurement.percentile * 100} | ${Math.round(measurement.measuredMs)}ms | ${measurement.budgetMs}ms | ${measurement.observed.all.length} (+${measurement.discarded.length} warmup) | ${Math.round(measurement.observed.min)} / ${Math.round(measurement.observed.median)} / ${Math.round(measurement.observed.max)} | ${measurement.withinBudget ? 'kept' : '**over budget**'} |`);
  const spread = timingSpread(measurements).filter(entry => entry.runs > 1)
    .map(entry => `| ${entry.assertion} | ${entry.runs} | ${entry.failures} | ${Math.round(entry.measuredMs.min)} / ${Math.round(entry.measuredMs.median)} / ${Math.round(entry.measuredMs.p95)} / ${Math.round(entry.measuredMs.max)} | ${entry.budgetMs}ms | ${Math.round(entry.worstShareOfBudget * 100)}% |`);
  return [`### Timing assertions`, '',
    'Timing-dependent assertions measure the runner as much as the system. A failure here is reported to master status as a timing assertion with its measurement, not as an unqualified failed check.', '',
    '| Assertion | Measures | Statistic | Measured | Budget | Samples | min / median / max | Verdict |', '| --- | --- | --- | --- | --- | --- | --- | --- |', ...rows,
    ...(spread.length ? ['', '| Assertion | Runs | Failures | min / median / p95 / max | Budget | Worst share of budget |', '| --- | --- | --- | --- | --- | --- |', ...spread] : []), ''].join('\n');
}

function main(argv: string[]) {
  const file = argv[0] ?? timingReportPath();
  const measurements = existsSync(file) ? readTimingReport(readFileSync(file, 'utf8')) : [];
  const summary = summaryMarkdown(measurements);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary); else process.stdout.write(summary);
  for (const command of annotationCommands(measurements)) console.log(command);
  const failed = measurements.filter(measurement => !measurement.withinBudget);
  console.log(`${measurements.length} timing assertion(s) recorded in ${file}; ${failed.length} over budget`);
}

if (process.argv[1] && /timing-report\.ts$/.test(process.argv[1])) main(process.argv.slice(2));
