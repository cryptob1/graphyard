import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { listTestFiles } from '../scripts/ci-tests.mjs';
import { refreshedDurationsPath, runTrial, shardTestFiles, trialShardLanes } from '../src/merge-writer/trial.js';
import { shardRepository } from './helpers/shard-hosts.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3542: graphyard.json points the trial's shard planner at tests/helpers/timing-baseline.json, which
// did not exist, so every file weighed the same and one shard of slow files set the trial's wall time.
// The file is back, measured, and each passing trial saves its own per-file durations for the next plan.

const baselinePath = 'tests/helpers/timing-baseline.json';
const repo = new URL('..', import.meta.url).pathname;
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2; };

test('unit:shard-timing-baseline — the baseline lists measured durations, and shards planned from it are predicted within 2x of each other', async () => {
  const { files: baseline } = JSON.parse(await readFile(join(repo, baselinePath), 'utf8')) as { files: Record<string, number> };
  const tests = listTestFiles();
  assert.ok(Object.keys(baseline).length > 0, 'the baseline lists test files');
  for (const [file, duration] of Object.entries(baseline)) assert.ok(/^tests\/[\w.-]+\.test\.ts$/.test(file) && Number.isFinite(duration) && duration > 0, `${file}: ${duration}`);

  // A file the baseline lacks counts as the median file.
  const fallback = median(Object.values(baseline)), predicted = (shard: string[]) => shard.reduce((sum, file) => sum + (baseline[file] ?? fallback), 0);
  const spread = (shards: string[][]) => Math.max(...shards.map(predicted)) / Math.min(...shards.map(predicted));
  const planned = shardTestFiles(tests, 8, baseline);
  assert.deepEqual(planned.flat().sort(), tests, 'every file runs once');
  assert.ok(spread(planned) < 2, `planned shards differ by ${spread(planned).toFixed(2)}x`);
  // Without the baseline the same files are cut by count, as before, and the slow ones pile up.
  const blind = shardTestFiles(tests, 8);
  assert.ok(Math.max(...blind.map(shard => shard.length)) - Math.min(...blind.map(shard => shard.length)) <= 1, 'cut by file count');
  assert.ok(spread(blind) > spread(planned), `blind shards differ by ${spread(blind).toFixed(2)}x`);
});

test('unit:shard-timing-baseline — without timings the plan is by name and count; a file with no timing weighs the median', () => {
  assert.deepEqual(shardTestFiles(['b', 'a', 'c', 'd', 'e'], 2), [['a', 'c', 'e'], ['b', 'd']]);
  // d has no timing: at the median (300) it joins b; at any default above 500 it would lead its own shard.
  assert.deepEqual(shardTestFiles(['a', 'b', 'c', 'd'], 2, { a: 100, b: 300, c: 500 }), [['c', 'a'], ['b', 'd']]);
});

// Three files a lane; the first of each lane's worth is slow, so a cut by name and count puts every slow file on shard 1.
const cores = 4, lanes = trialShardLanes(cores), slowMs = 600, quickMs = 100;
const files = Array.from({ length: lanes * 3 }, (_, index) => `tests/f${String(index).padStart(2, '0')}.test.ts`);
const runner = `import { readFileSync, appendFileSync } from 'node:fs';
const at = name => process.argv[process.argv.indexOf(name) + 1];
for (const file of readFileSync(at('--files-from'), 'utf8').split('\\n').filter(Boolean)) {
  const started = Date.now();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(file.match(/\\d+/)[0]) % ${lanes} ? ${quickMs} : ${slowMs});
  appendFileSync(at('--durations'), JSON.stringify({ file, passed: true, durationMs: Date.now() - started }) + '\\n');
}
`;

test('unit:shard-timing-baseline e2e:shard-timing-baseline — a passing trial saves its per-file durations, and the next trial reports its slowest shard within 2x of its median shard', { timeout: 120_000 }, async () => {
  const { root, sha } = await shardRepository('shard-timing-repo', files, {
    'graphyard.json': JSON.stringify({ delivery: { mergeGate: { perCandidate: [], preMerge: [{ check: 'test', command: 'node scripts/tests.mjs', source: 'script', reason: 'fixture',
      selection: { command: 'node scripts/select.mjs', pattern: '^tests/[\\w./-]+\\.test\\.ts$', durations: baselinePath } }] } } }),
    'scripts/select.mjs': `console.log(${JSON.stringify(files.join('\n'))});\n`,
    'scripts/tests.mjs': runner,
  });
  // Nothing to install, and the fixture's children run directly rather than in the trial container.
  const run: ChildRun = async (command, args, options) => command === 'npm' ? '' : defaultChildRun(command, args, { ...options, wrapper: [] });
  const trial = async () => {
    const shards: number[] = [];
    const verdict = await runTrial({ root, base: await temporaryDirectory('shard-timing-base'), mergeSha: sha, changedFiles: files, timeoutMs: 90_000, cores, run, retries: 0, remote: { hosts: [] },
      memory: async () => null, environment: { PATH: process.env.PATH! }, onTiming: (step, durationMs) => { if (/^tests: shard \d+/.test(step)) shards.push(durationMs); } });
    assert.deepEqual(verdict.tests, { passed: files.length, failed: [], files: files.length }, verdict.logTail);
    assert.equal(shards.length, lanes);
    return { slowest: Math.max(...shards), median: median(shards) };
  };
  // The repository holds no timings yet: the first trial is cut blind and waits on one slow shard.
  const blind = await trial();
  assert.ok(blind.slowest > 2 * blind.median, `cut blind, the slowest shard took ${blind.slowest} ms against a median of ${blind.median} ms`);
  // Passing, it saved what each file took.
  const saved = JSON.parse(await readFile(refreshedDurationsPath(root, baselinePath), 'utf8')) as { files: Record<string, number> };
  assert.deepEqual(Object.keys(saved.files).sort(), files);
  assert.ok(saved.files[files[0]!]! >= slowMs && saved.files[files[1]!]! < slowMs, JSON.stringify(saved.files));
  // The next trial is planned from them.
  const balanced = await trial();
  assert.ok(balanced.slowest <= 2 * balanced.median, `the slowest shard took ${balanced.slowest} ms against a median of ${balanced.median} ms`);
});
