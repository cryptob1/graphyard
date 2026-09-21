/**
 * Timing-dependent assertions (GY-95).
 *
 * A latency budget is a property of the system, but what a test measures on a shared runner is the
 * runner as much as the system: a cold connection, a JIT pause, a noisy neighbour. Every assertion
 * on elapsed real time therefore goes through here rather than through a bare `assert.ok`:
 *
 * - warmup reads are taken and discarded before anything is sampled, so connection setup, JIT
 *   warmup and cold query plans are paid outside the measurement;
 * - the sample is large enough that the named percentile is the order statistic it claims, with
 *   observations above it, rather than the second-worst read of a short run;
 * - the measurement is recorded — which assertion, what it measured, against which budget — to a
 *   JSON-lines report the CI job publishes, so a failed run says what it measured and repeated runs
 *   show the spread a future regression is judged against;
 * - a failure names itself as a timing assertion in a fixed form, so master status can tell it
 *   from a behavioural regression instead of reporting an unqualified failed check.
 *
 * The budgets themselves are never touched here: a caller states its budget and this module
 * decides only how it is measured and reported.
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Where the run records its timing assertions; the CI job points it at the runner's temp dir. */
export const timingReportVariable = 'GRAPHYARD_TIMING_REPORT';
/** The marker every timing failure message and CI annotation carries. */
export const timingAssertionTitle = 'timing assertion';

export interface TimingBudget {
  /** The proof-titled assertion this measurement decides, e.g. `integration:work-snapshot-latency`. */
  assertion: string;
  /** What is being timed, in words: `coordination snapshot read`. */
  measure: string;
  /** The budget, unchanged from the property the system depends on. */
  budgetMs: number;
  /** The percentile the budget applies to, in (0, 1]. */
  percentile: number;
  /** Reads taken and discarded before sampling. */
  warmup: number;
  /** Reads sampled; at least `sampleCount(percentile)`. */
  samples: number;
}

export interface TimingMeasurement extends TimingBudget {
  /** The reported order statistic, against `budgetMs`. */
  measuredMs: number;
  withinBudget: boolean;
  /** The sampled distribution, so the spread is recorded and not only the verdict. */
  observed: { min: number; median: number; max: number; all: number[] };
  /** The warmup reads, recorded but never sampled. */
  discarded: number[];
  at: string;
  run: string | null;
}

/**
 * The nearest-rank percentile: the smallest sample at or above which the named share of the sample
 * lies. For `p = 0.95` and 40 samples that is the 38th smallest; it is exact, never interpolated.
 */
export function percentile(samples: readonly number[], p: number): number {
  if (!samples.length) throw new RangeError('A percentile needs at least one sample');
  return [...samples].sort((a, b) => a - b)[percentileRank(samples.length, p) - 1];
}

/** The 1-based rank the nearest-rank percentile reads, for a sample of `count`. */
export function percentileRank(count: number, p: number): number {
  if (!(p > 0 && p <= 1)) throw new RangeError(`A percentile lies in (0, 1]: ${p}`);
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`A sample count is a positive integer: ${count}`);
  return Math.min(count, Math.max(1, Math.ceil(count * p)));
}

/**
 * The smallest sample count at which the nearest-rank percentile leaves at least `above` observations
 * beyond the reported one — so a p95 is decided by the distribution rather than by whichever read
 * happened to be the second slowest. For p95 with two above, that is 40 samples.
 */
export function sampleCount(p: number, above = 2): number {
  for (let count = 1; count < 100_000; count++) if (count - percentileRank(count, p) >= above) return count;
  throw new RangeError(`No practical sample size leaves ${above} observations above p${p * 100}`);
}

const median = (values: readonly number[]) => percentile(values, 0.5);

/**
 * Take the warmup reads, discard them, then sample `budget.samples` reads and report the percentile.
 * `read` performs one timed operation; its result is ignored, and the last one is returned so a
 * caller can go on asserting on what the operation produced. `clock` is the monotonic clock, replaceable
 * so the helper itself can be tested without measuring anything.
 */
export async function measureLatency<T>(budget: TimingBudget, read: () => Promise<T>, clock: () => number = () => performance.now()): Promise<{ measurement: TimingMeasurement; last: T }> {
  const floor = sampleCount(budget.percentile);
  if (budget.samples < floor) throw new RangeError(`${budget.assertion} samples ${budget.samples} reads; p${budget.percentile * 100} needs at least ${floor} to be more than the second-worst observation`);
  const discarded: number[] = []; const all: number[] = [];
  let last!: T;
  for (let index = 0; index < budget.warmup + budget.samples; index++) {
    const started = clock();
    last = await read();
    (index < budget.warmup ? discarded : all).push(clock() - started);
  }
  const measuredMs = percentile(all, budget.percentile);
  const measurement: TimingMeasurement = { ...budget, measuredMs, withinBudget: measuredMs < budget.budgetMs,
    observed: { min: Math.min(...all), median: median(all), max: Math.max(...all), all }, discarded,
    at: new Date().toISOString(), run: runIdentity() };
  return { measurement, last };
}

/**
 * One timed observation judged against a budget — a recovery that must finish inside an interval, a
 * cycle that must fit its schedule. Recorded like a sampled measurement so the run's report names it
 * as timing-dependent too; there is nothing to warm up and nothing to rank, so it is p100 of one.
 */
export function singleObservation(budget: Pick<TimingBudget, 'assertion' | 'measure' | 'budgetMs'>, elapsedMs: number): TimingMeasurement {
  return { ...budget, percentile: 1, warmup: 0, samples: 1, measuredMs: elapsedMs, withinBudget: elapsedMs < budget.budgetMs,
    observed: { min: elapsedMs, median: elapsedMs, max: elapsedMs, all: [elapsedMs] }, discarded: [], at: new Date().toISOString(), run: runIdentity() };
}

const runIdentity = () => process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_RUN_ID}/${process.env.GITHUB_RUN_ATTEMPT ?? 1}` : null;

/** The report file: the variable when set, otherwise one file per repository checkout in the temp dir. */
export function timingReportPath(env: NodeJS.ProcessEnv = process.env): string {
  return env[timingReportVariable] || join(tmpdir(), 'graphyard-timing-report.jsonl');
}

/** Append one measurement to the report. Test files run in separate processes, so each line is one write. */
export function recordTiming(measurement: TimingMeasurement, file = timingReportPath()): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(measurement)}\n`);
}

/** The measurement in one line: what was measured, over how many samples, against which budget. */
export function timingSummary(measurement: TimingMeasurement): string {
  const over = ((measurement.measuredMs - measurement.budgetMs) / measurement.budgetMs) * 100;
  return `${measurement.assertion}: ${measurement.measure} p${measurement.percentile * 100} ${Math.round(measurement.measuredMs)}ms over ${measurement.observed.all.length} samples`
    + ` (${measurement.discarded.length} warmup discarded; min ${Math.round(measurement.observed.min)}ms, median ${Math.round(measurement.observed.median)}ms, max ${Math.round(measurement.observed.max)}ms)`
    + ` against a ${measurement.budgetMs}ms budget${measurement.withinBudget ? '' : `, ${over.toFixed(1)}% over`}`;
}

/** The message a failed timing assertion carries: the fixed title, then the summary. */
export function timingFailureMessage(measurement: TimingMeasurement): string {
  return `${timingAssertionTitle} ${timingSummary(measurement)}`;
}

/**
 * Record the measurement, then assert the budget. The assertion message carries the fixed title so
 * the failure is recognisable as timing-dependent wherever it is read — the TAP stream, the job log,
 * the annotation the CI job publishes from the report.
 */
export function assertWithinBudget(measurement: TimingMeasurement, file?: string): void {
  recordTiming(measurement, file);
  assert.ok(measurement.withinBudget, timingFailureMessage(measurement));
}

/** Parse a report: one measurement per line, blank lines ignored, a malformed line named. */
export function readTimingReport(text: string): TimingMeasurement[] {
  return text.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    try { return JSON.parse(line) as TimingMeasurement; } catch { throw new Error(`Timing report line ${index + 1} is not JSON: ${line.slice(0, 80)}`); }
  });
}

export interface TimingSpread {
  assertion: string; measure: string; budgetMs: number; percentile: number;
  runs: number; failures: number;
  /** The reported statistic across runs. */
  measuredMs: { min: number; median: number; p95: number; max: number };
  /** How much of the budget the worst run used. */
  worstShareOfBudget: number;
}

/**
 * The run-to-run spread of every timing assertion in a set of reports — the record a future
 * regression is visible against: an assertion whose worst run sits at 60% of its budget has room,
 * one at 98% is measuring the runner.
 */
export function timingSpread(measurements: readonly TimingMeasurement[]): TimingSpread[] {
  const groups = new Map<string, TimingMeasurement[]>();
  for (const measurement of measurements) groups.set(measurement.assertion, [...(groups.get(measurement.assertion) ?? []), measurement]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([assertion, runs]) => {
    const values = runs.map(run => run.measuredMs);
    const worst = Math.max(...values);
    const { measure, budgetMs, percentile: p } = runs[runs.length - 1];
    return { assertion, measure, budgetMs, percentile: p, runs: runs.length, failures: runs.filter(run => !run.withinBudget).length,
      measuredMs: { min: Math.min(...values), median: median(values), p95: percentile(values, 0.95), max: worst }, worstShareOfBudget: worst / budgetMs };
  });
}
