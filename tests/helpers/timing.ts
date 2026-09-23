import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';

// Assertions about elapsed real time measure the runner as much as the system. Every one of them
// goes through this module so that (1) a latency figure is a steady-state order statistic rather
// than a warmup read or the second-worst observation, and (2) the run records which assertions
// are timing-dependent and what they measured, so a failure of one is reported as a timing
// failure with its measurement against its budget, never as an unqualified red check.

/** Where a run appends one JSON line per timing assertion; unset, nothing is written. */
export const timingRecordVariable = 'GRAPHYARD_TIMING_RECORD';

/** The 1-based nearest-rank position of the `fraction` percentile among `count` sorted samples. */
export function percentileRank(count: number, fraction: number) {
  assert.ok(Number.isInteger(count) && count > 0, 'a percentile needs at least one sample');
  assert.ok(fraction > 0 && fraction <= 1, 'a percentile fraction lies in (0, 1]');
  return Math.ceil(count * fraction);
}

/** How many observations sit above the reported percentile: the outliers it takes to move it. */
export const observationsAbove = (count: number, fraction: number) => count - percentileRank(count, fraction);

/**
 * The smallest sample count at which `above` observations sit above the `fraction` percentile.
 * Twenty reads leave one above p95, so the "p95" is the second-worst read and a single outlier
 * beside the worst one decides the verdict; a hundred leave five.
 */
export function minimumSamples(fraction: number, above: number) {
  let count = 1;
  while (observationsAbove(count, fraction) < above) count++;
  return count;
}

/** The nearest-rank percentile: the order statistic at `percentileRank`, never an interpolation. */
export function percentile(samples: readonly number[], fraction: number) {
  return [...samples].sort((a, b) => a - b)[percentileRank(samples.length, fraction) - 1];
}

export interface SteadyState { warmup: number[]; samples: number[] }

/**
 * Time `read` in steady state: `warmup` reads are taken first and kept apart, so connection
 * setup, JIT warmup and cold query plans are paid before sampling and never enter `samples`.
 */
export async function steadyState(read: () => Promise<unknown>, options: { warmup: number; samples: number; clock?: () => number }): Promise<SteadyState> {
  const clock = options.clock ?? (() => performance.now());
  const timed = async () => { const started = clock(); await read(); return clock() - started; };
  const warmup: number[] = [], samples: number[] = [];
  for (let run = 0; run < options.warmup; run++) warmup.push(await timed());
  for (let run = 0; run < options.samples; run++) samples.push(await timed());
  return { warmup, samples };
}

export interface TimingMeasurement {
  /** Stable name of the assertion, the key its run-to-run spread is recorded under. */
  name: string;
  /** The test, by its proof name, the assertion belongs to. */
  test: string;
  /** What was measured: `p95`, `elapsed`, `duration`. */
  statistic: string;
  measuredMs: number;
  budgetMs: number;
  comparison: '<' | '<=';
  samples: number;
  warmupDiscarded: number;
  /** How many samples sit above the reported statistic; zero for a single measurement. */
  observationsAbove: number;
  distribution: { minMs: number; medianMs: number; maxMs: number };
  passed: boolean;
  at: string;
}

/** Marks a failure as a timing-dependent assertion, in the message and for `instanceof`. */
export const timingFailureMarker = '[timing-dependent]';
export class TimingAssertionError extends assert.AssertionError {
  constructor(readonly measurement: TimingMeasurement) {
    super({ message: describeTiming(measurement), actual: measurement.measuredMs, expected: measurement.budgetMs, operator: measurement.comparison });
  }
}

export function describeTiming(m: Pick<TimingMeasurement, 'name' | 'statistic' | 'measuredMs' | 'budgetMs' | 'comparison' | 'samples' | 'warmupDiscarded' | 'passed'>) {
  const over = m.passed ? 'within' : 'over';
  return `${timingFailureMarker} ${m.name}: ${m.statistic} measured ${Math.round(m.measuredMs)}ms, ${over} its budget of ${m.comparison} ${m.budgetMs}ms (${m.samples} sample${m.samples === 1 ? '' : 's'}, ${m.warmupDiscarded} warmup discarded)`;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** The measurement a timing assertion records, judged against its budget. */
export function measureTiming(input: { name: string; test: string; statistic: string; budgetMs: number; comparison?: '<' | '<='; samples: readonly number[]; warmup?: readonly number[]; fraction?: number; at?: Date }): TimingMeasurement {
  assert.ok(input.samples.length > 0, `${input.name} measured nothing`);
  const fraction = input.fraction ?? 1, comparison = input.comparison ?? '<';
  const measuredMs = percentile(input.samples, fraction);
  return {
    name: input.name, test: input.test, statistic: input.statistic, measuredMs: round(measuredMs), budgetMs: input.budgetMs, comparison,
    samples: input.samples.length, warmupDiscarded: input.warmup?.length ?? 0, observationsAbove: observationsAbove(input.samples.length, fraction),
    distribution: { minMs: round(Math.min(...input.samples)), medianMs: round(percentile(input.samples, 0.5)), maxMs: round(Math.max(...input.samples)) },
    passed: comparison === '<' ? measuredMs < input.budgetMs : measuredMs <= input.budgetMs, at: (input.at ?? new Date()).toISOString(),
  };
}

/** Append the measurement to the run's timing record, when the run keeps one. */
export function recordTiming(measurement: TimingMeasurement, file = process.env[timingRecordVariable]) {
  // One short line per append: concurrent test processes interleave whole lines, never bytes.
  if (file) appendFileSync(file, `${JSON.stringify(measurement)}\n`);
  return measurement;
}

/**
 * Assert a wall-clock measurement against its budget. The measurement is recorded whether it
 * passes or fails, and a failure is a `TimingAssertionError` naming the measured value against
 * the budget, so nothing downstream has to guess that the red test was about time.
 */
export function assertTiming(input: Parameters<typeof measureTiming>[0], file?: string) {
  const measurement = recordTiming(measureTiming(input), file);
  if (!measurement.passed) throw new TimingAssertionError(measurement);
  return measurement;
}

/** Read a timing record back; a missing file is a run that made no timing assertion. */
export function parseTimingRecord(text: string): TimingMeasurement[] {
  return text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as TimingMeasurement);
}
