import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTimingRecord, timingRecordVariable, type TimingMeasurement } from './timing.js';
import { failedTestCount, timingSpread, type TimingSpread } from './timing-report.js';

// The stability run behind `manual:suite-stability-twenty-runs`: the required check, run
// consecutively against one unchanged tree, with the run-to-run spread of every timing-dependent
// assertion recorded. A suite whose verdict depends on the runner shows up here as a run that
// failed on the same commit; a future latency regression shows up against the recorded spread.
//
//   npx tsx tests/helpers/timing-stability.ts [--runs 20] [--record FILE] [-- COMMAND ARGS...]
//
// The required check is `npm test`, the default command. It exits non-zero unless every run passed.

export const requiredRuns = 20;
/** Set for the suite while `--record` rewrites the baseline, which cannot be judged by the runs that produce it. */
export const baselineRecordingVariable = 'GRAPHYARD_TIMING_BASELINE_RECORDING';

/**
 * What the required check sets beside `npm test` (.github/workflows/ci.yml), so the stability run
 * measures the check CI runs. Test files start their own Postgres on `GRAPHYARD_TEST_PORT` plus a
 * per-file offset and run in parallel; tests/events-pagination.test.ts and
 * tests/reconciliation-snapshot.test.ts were both given offset 25, so whichever started second
 * failed every test whenever the scheduler overlapped them. The override moves one of them to an
 * offset no test file resolves; tests/timing-stability.test.ts refuses any two files that still
 * share a port, so an offset a later file takes is caught here rather than on a shared runner.
 */
export const testPortBase = 15438;
export function requiredCheckEnvironment(base = Number(process.env.GRAPHYARD_TEST_PORT ?? testPortBase)): Record<string, string> {
  return { GRAPHYARD_EVENTS_TEST_PORT: String(base + 28) };
}

/** The database port every test file resolves, from its own source, under `environment`. */
export function testFilePorts(sources: Record<string, string>, environment: Record<string, string | undefined>, base = testPortBase) {
  const ports: { file: string; port: number }[] = [];
  for (const [file, text] of Object.entries(sources)) {
    const resolved = new Set<number>();
    for (const match of text.matchAll(/(?:process\.env\.(GRAPHYARD_\w+_PORT) \?\? )?Number\(process\.env\.GRAPHYARD_TEST_PORT \?\? 15438\)(?: \+ (\d+))?/g))
      resolved.add(Number((match[1] && environment[match[1]]) || base + Number(match[2] ?? 0)));
    for (const match of text.matchAll(/new EmbeddedPostgres\(\{[^}]*\bport: (\d{4,5})\b/g)) resolved.add(Number(match[1]));
    for (const port of resolved) ports.push({ file, port });
  }
  return ports;
}

export interface StabilityRun { run: number; passed: boolean; exitCode: number | null; durationMs: number; failedTests: number | null; timingFailures: string[] }
export interface StabilityRecord {
  schema: 1; commit: string | null; treeUnchanged: boolean; command: string[]; recordedAt: string;
  environment: { node: string; platform: string; cpus: number; ci: boolean };
  runs: StabilityRun[]; passed: number; consecutivePasses: number; stable: boolean; spread: TimingSpread[];
}

/** The record of a stability run: every run's verdict and the spread of every timing assertion. */
export function stabilityRecord(input: { commit: string | null; treeUnchanged: boolean; command: string[]; runs: StabilityRun[]; timings: TimingMeasurement[][]; required?: number; at?: Date; environment?: StabilityRecord['environment'] }): StabilityRecord {
  let consecutivePasses = 0;
  for (const run of input.runs) { if (!run.passed) break; consecutivePasses++; }
  const required = input.required ?? requiredRuns;
  return { schema: 1, commit: input.commit, treeUnchanged: input.treeUnchanged, command: input.command, recordedAt: (input.at ?? new Date()).toISOString(),
    environment: input.environment ?? { node: process.version, platform: `${process.platform}-${process.arch}`, cpus: cpus().length, ci: !!process.env.CI },
    runs: input.runs, passed: input.runs.filter(run => run.passed).length, consecutivePasses,
    // Stable means the same commit gave the same verdict every time, on a tree nothing changed under.
    stable: input.treeUnchanged && input.runs.length >= required && consecutivePasses === input.runs.length, spread: timingSpread(input.timings) };
}

const git = (args: string[]) => { try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
/** What the tree is: its commit and every uncommitted change, so a run can prove nothing moved. */
const treeState = (ignore: string | null) => ({ commit: git(['rev-parse', 'HEAD']), changes: (git(['status', '--porcelain']) ?? '').split('\n').filter(line => line && (!ignore || !line.endsWith(ignore))).join('\n') });

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2), separator = args.indexOf('--');
  const options = separator < 0 ? args : args.slice(0, separator);
  const command = separator < 0 ? ['npm', 'test'] : args.slice(separator + 1);
  const value = (flag: string) => { const at = options.indexOf(flag); return at < 0 ? null : options[at + 1] ?? null; };
  const runs = Number(value('--runs') ?? requiredRuns), recordFile = value('--record');
  if (!Number.isInteger(runs) || runs < 1 || !command.length) throw new Error('Usage: timing-stability [--runs 20] [--record FILE] [-- COMMAND ARGS...]');
  // The record this run writes is the one change it may make to the tree.
  const written = recordFile ? git(['ls-files', '--full-name', '--', recordFile]) || recordFile : null;
  const before = treeState(written);
  const directory = mkdtempSync(join(tmpdir(), 'graphyard-timing-stability-'));
  const results: StabilityRun[] = [], timings: TimingMeasurement[][] = [];
  try {
    for (let run = 1; run <= runs; run++) {
      const timingFile = join(directory, `run-${run}.jsonl`), started = performance.now();
      const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...requiredCheckEnvironment(), ...process.env, [timingRecordVariable]: timingFile, ...(recordFile ? { [baselineRecordingVariable]: '1' } : {}) } });
      const measured = existsSync(timingFile) ? parseTimingRecord(readFileSync(timingFile, 'utf8')) : [];
      timings.push(measured);
      const entry: StabilityRun = { run, passed: result.status === 0, exitCode: result.status, durationMs: Math.round(performance.now() - started), failedTests: failedTestCount(`${result.stdout ?? ''}\n${result.stderr ?? ''}`), timingFailures: measured.filter(item => !item.passed).map(item => item.name) };
      results.push(entry);
      console.log(`run ${run}/${runs}: ${entry.passed ? 'passed' : `FAILED (exit ${entry.exitCode}, ${entry.failedTests ?? 'unknown'} failed tests${entry.timingFailures.length ? `, timing-dependent: ${entry.timingFailures.join(', ')}` : ''})`} in ${Math.round(entry.durationMs / 1000)}s`);
      if (!entry.passed) writeFileSync(join(directory, `run-${run}.log`), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    }
    const after = treeState(written);
    const record = stabilityRecord({ commit: before.commit, treeUnchanged: before.commit === after.commit && before.changes === '' && after.changes === '', command, runs: results, timings, required: runs });
    const text = `${JSON.stringify(record, null, 2)}\n`;
    if (recordFile) writeFileSync(resolve(recordFile), text); else console.log(text);
    for (const spread of record.spread) console.log(`${spread.name}: ${spread.statistic} ${spread.minMs}–${spread.maxMs}ms over ${spread.runs} runs (median ${spread.medianMs}ms, budget ${spread.comparison} ${spread.budgetMs}ms, ${spread.failures} over budget)`);
    console.log(record.stable ? `Stable: ${record.consecutivePasses} consecutive runs passed on ${record.commit}` : `NOT stable: ${record.passed}/${runs} runs passed on ${record.commit}${record.treeUnchanged ? '' : '; the tree changed or carried uncommitted changes'}; failed run logs are in ${directory}`);
    if (!record.stable) process.exitCode = 1;
  } finally { if (results.every(run => run.passed)) rmSync(directory, { recursive: true, force: true }); }
}
