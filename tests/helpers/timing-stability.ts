/**
 * Run the required check repeatedly against an unchanged tree and record the run-to-run spread of
 * every timing assertion (GY-95, `manual:suite-stability-twenty-runs`):
 *
 *   npx tsx tests/helpers/timing-stability.ts --runs 20 --out .graphyard/timing-stability/<sha>
 *
 * Each run is `npm test` with its own timing report; the summary lists, per timing assertion, the
 * min / median / p95 / max of the reported statistic across runs, the budget, the worst run's share
 * of it and the number of failures, so a future regression is visible against the recorded spread
 * rather than against a single green run. A dirty tree is refused: the spread is only meaningful for
 * one commit. Exit status is non-zero when any run failed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readTimingReport, timingReportVariable, timingSpread, type TimingMeasurement, type TimingSpread } from './timing.js';

export interface StabilityRun { run: number; passed: boolean; durationMs: number; measurements: number; failedTiming: string[] }
export interface StabilitySummary { commit: string; runs: number; passedRuns: number; startedAt: string; finishedAt: string; results: StabilityRun[]; spread: TimingSpread[] }

/** The spread table as Markdown, the form the record is read in. */
export function stabilityMarkdown(summary: StabilitySummary): string {
  const rows = summary.spread.map(entry => `| ${entry.assertion} | ${entry.measure} | p${entry.percentile * 100} | ${entry.runs} | ${entry.failures} | ${Math.round(entry.measuredMs.min)} / ${Math.round(entry.measuredMs.median)} / ${Math.round(entry.measuredMs.p95)} / ${Math.round(entry.measuredMs.max)} | ${entry.budgetMs} | ${Math.round(entry.worstShareOfBudget * 100)}% |`);
  return [`### Timing stability at ${summary.commit}`, '', `${summary.passedRuns} of ${summary.runs} consecutive runs of the required check passed (${summary.startedAt} → ${summary.finishedAt}).`, '',
    '| Assertion | Measures | Statistic | Runs | Failures | min / median / p95 / max (ms) | Budget (ms) | Worst share of budget |', '| --- | --- | --- | --- | --- | --- | --- | --- |', ...rows, ''].join('\n');
}

function argument(argv: string[], name: string, fallback: string): string {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function main(argv: string[]) {
  const root = resolve(new URL('../..', import.meta.url).pathname);
  const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
  const commit = git(['rev-parse', 'HEAD']);
  if (git(['status', '--porcelain'])) { console.error('The tree is dirty; a stability record describes exactly one commit. Commit or discard first.'); process.exit(2); }
  const runs = Number(argument(argv, '--runs', '20'));
  const out = resolve(root, argument(argv, '--out', join('.graphyard', 'timing-stability', commit.slice(0, 12))));
  mkdirSync(out, { recursive: true });
  const startedAt = new Date().toISOString();
  const results: StabilityRun[] = []; const measurements: TimingMeasurement[] = [];
  for (let run = 1; run <= runs; run++) {
    const report = join(out, `run-${String(run).padStart(2, '0')}.jsonl`);
    const started = performance.now();
    const child = spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8', env: { ...process.env, [timingReportVariable]: report }, maxBuffer: 64 * 1024 * 1024 });
    const durationMs = performance.now() - started;
    writeFileSync(join(out, `run-${String(run).padStart(2, '0')}.log`), `${child.stdout ?? ''}\n${child.stderr ?? ''}`);
    const recorded = existsSync(report) ? readTimingReport(readFileSync(report, 'utf8')) : [];
    measurements.push(...recorded);
    const result = { run, passed: child.status === 0, durationMs, measurements: recorded.length, failedTiming: recorded.filter(entry => !entry.withinBudget).map(entry => entry.assertion) };
    results.push(result);
    console.log(`run ${run}/${runs}: ${result.passed ? 'passed' : `FAILED (exit ${child.status})`} in ${Math.round(durationMs / 1000)}s, ${recorded.length} timing assertions${result.failedTiming.length ? `, over budget: ${result.failedTiming.join(', ')}` : ''}`);
  }
  const summary: StabilitySummary = { commit, runs, passedRuns: results.filter(result => result.passed).length, startedAt, finishedAt: new Date().toISOString(), results, spread: timingSpread(measurements) };
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(out, 'summary.md'), stabilityMarkdown(summary));
  process.stdout.write(stabilityMarkdown(summary));
  console.log(`recorded under ${out}`);
  process.exit(summary.passedRuns === runs ? 0 : 1);
}

if (process.argv[1] && /timing-stability\.ts$/.test(process.argv[1])) main(process.argv.slice(2));
