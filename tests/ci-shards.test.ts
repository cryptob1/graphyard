import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { dependencyMap, listTestFiles, mergeDurations, readDurations, selectAffected, selectForRun, shardFiles, shardImbalance } from '../scripts/ci-tests.mjs';
import { nodeTestArgs } from './helpers/run-tests.js';
import { readWorkflow } from '../src/protection.js';

// GY-499: the required `test` check ran the whole suite on one runner in about fifteen minutes, on
// every rework round, base refresh and queue tip. It is now an aggregate over a matrix of shard jobs
// balanced by recorded per-file durations, and a pull request's own run executes only the test files
// its change affects. One case per proof: unit:ci-sharded, unit:affected-tests-selected.

const workflowJob = (text: string, id: string) => {
  const start = text.indexOf(`\n  ${id}:\n`);
  assert.ok(start >= 0, `ci.yml has a ${id} job`);
  const rest = text.slice(start + 1), end = rest.slice(1).search(/\n {2}[\w-]+:\n/);
  return end < 0 ? rest : rest.slice(0, end + 1);
};

test('unit:ci-sharded — the required test check aggregates a matrix of four duration-balanced shards that finish within 20% of each other, and passes only when every shard passes', async () => {
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  // Branch protection is unchanged: the check it names is still the job `test`, now an aggregate.
  const jobs = readWorkflow(ci).jobs.map(job => job.id);
  for (const id of ['test', 'test-shard', 'test-browser']) assert.ok(jobs.includes(id), `ci.yml defines ${id}`);
  const shard = workflowJob(ci, 'test-shard'), aggregate = workflowJob(ci, 'test');
  assert.match(shard, /matrix:\n\s+shard: \[1, 2, 3, 4\]/, 'four shards by default');
  assert.match(shard, /fail-fast: false/, 'one failing shard does not hide the others');
  assert.match(shard, /SHARD: \$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}/, 'each shard knows its index and the matrix size');
  assert.match(shard, /node scripts\/ci-tests\.mjs select --out "\$RUNNER_TEMP\/selected-tests\.txt"/);
  assert.match(shard, /npm test -- --shard "\$SHARD" --files-from "\$RUNNER_TEMP\/selected-tests\.txt" --durations /);
  assert.match(aggregate, /needs: \[test-shard, test-browser\]/);
  assert.match(aggregate, /if: \$\{\{ !cancelled\(\) \}\}/, 'the aggregate reports a failed shard rather than being skipped with it');
  assert.match(aggregate, /SHARDS: \$\{\{ needs\.test-shard\.result \}\}/);
  assert.match(aggregate, /test "\$SHARDS" = success && test "\$BROWSER" = success/, 'passes only when every shard and the browser suite passed');
  assert.match(aggregate, /timing-report\.ts "\$RUNNER_TEMP\/graphyard-timing\.jsonl" "\$RUNNER_TEMP"\/timing\/test-\*\.log/, 'timing annotations still land on the required check');

  // The recorded durations cover the suite, and the four shards they give finish within 20%.
  const tests = listTestFiles(), durations = readDurations();
  const recorded = tests.filter(file => Number.isFinite(durations[file]));
  assert.ok(recorded.length >= tests.length * 0.9, `tests/helpers/timing-baseline.json records ${recorded.length} of ${tests.length} test files; refresh it with node scripts/ci-tests.mjs durations`);
  const shards = shardFiles(tests, durations, 4);
  assert.equal(shards.length, 4);
  assert.deepEqual(shards.flatMap(entry => entry.files).sort(), tests, 'every test file runs on exactly one shard');
  assert.ok(shardImbalance(shards) <= 0.2, `shards finish within 20% of each other: ${shards.map(entry => Math.round(entry.durationMs / 1000)).join('s, ')}s`);

  // Longest first onto the lightest shard; an unrecorded file weighs the median. Each shard lists its
  // files longest first, the order node:test starts them in, so no long file starts last.
  const split = shardFiles(['a', 'b', 'c', 'd', 'e', 'new'], { a: 50, b: 40, c: 30, d: 20, e: 10 }, 2);
  assert.deepEqual(split.map(entry => entry.files), [['a', 'new', 'e'], ['b', 'c', 'd']]);
  assert.deepEqual(split.map(entry => entry.durationMs), [90, 90]);

  // The runner runs one shard of the selection, and nothing at all for an empty one.
  const cwd = await mkdtemp(join(tmpdir(), 'graphyard-ci-shards-'));
  try {
    await writeFile(join(cwd, 'list.txt'), 'tests/one.test.ts\ntests/two.test.ts\n'); await writeFile(join(cwd, 'none.txt'), '');
    const first = nodeTestArgs(cwd, ['--shard', '1/2', '--files-from', 'list.txt']), second = nodeTestArgs(cwd, ['--shard=2/2', '--files-from', 'list.txt']);
    assert.deepEqual([...first.args, ...second.args].filter(arg => !arg.startsWith('-')).sort(), ['tests/one.test.ts', 'tests/two.test.ts']);
    assert.equal(nodeTestArgs(cwd, ['--shard', '3/3', '--files-from', 'list.txt']).empty, true);
    assert.equal(nodeTestArgs(cwd, ['--files-from', 'none.txt']).empty, true);
    assert.ok(nodeTestArgs(cwd, ['--durations', 'd.jsonl', 'tests/one.test.ts']).args.some(arg => arg.endsWith('file-durations.mjs')));
  } finally { await rm(cwd, { recursive: true, force: true }); }

  // A shard's measured durations refresh the baseline, and the rest of the record is kept.
  const merged = mergeDurations({ schema: 1, files: { 'tests/a.test.ts': 5, 'tests/gone.test.ts': 9 } }, ['{"file":"tests/b.test.ts","durationMs":1234.4,"passed":true}\n'], ['tests/a.test.ts', 'tests/b.test.ts']);
  assert.deepEqual(merged, { schema: 1, files: { 'tests/a.test.ts': 5, 'tests/b.test.ts': 1234 } });
});

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-affected-'));
  for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }
  return root;
}

test('unit:affected-tests-selected — a pull request runs only the tests that reach its changed module transitively, and the full suite when a change is outside the map, the install, the runner or configuration, and on every queue tip and push', async () => {
  const root = await fixture({
    'package.json': '{}', 'tsconfig.json': '{}', 'tests/helpers/shared.ts': 'export const x = 1;\n',
    'src/leaf.ts': 'export const leaf = 1;\n',
    'src/middle.ts': "import { leaf } from './leaf.js';\nexport const middle = leaf + 1;\n",
    'src/other.ts': 'export const other = 2;\n',
    'src/types.ts': 'export interface Shape { size: number }\n',
    'src/unused.ts': 'export const unused = 3;\n',
    'docs/guide.md': '# Guide\n', 'docs/orphan.md': '# Orphan\n',
    'tests/middle.test.ts': "import { middle } from '../src/middle.js';\nvoid middle;\n",
    'tests/other.test.ts': "import { other } from '../src/other.js';\nimport type { Shape } from '../src/types.js';\nvoid other;\n",
    'tests/guide.test.ts': "import { readFile } from 'node:fs/promises';\nawait readFile(new URL('../docs/guide.md', import.meta.url));\n",
  });
  try {
    const tests = listTestFiles(root), map = dependencyMap(root, tests);
    assert.deepEqual(tests, ['tests/guide.test.ts', 'tests/middle.test.ts', 'tests/other.test.ts']);
    // A change to one module selects exactly the tests that import it, transitively.
    assert.deepEqual(selectAffected(['src/leaf.ts'], map, tests), { mode: 'affected', reason: '1 of 3 test files are affected by 1 changed file(s)', files: ['tests/middle.test.ts'] });
    assert.deepEqual(selectAffected(['src/other.ts', 'tests/middle.test.ts'], map, tests).files, ['tests/middle.test.ts', 'tests/other.test.ts']);
    assert.deepEqual(selectAffected(['docs/guide.md'], map, tests).files, ['tests/guide.test.ts'], 'a file a test reads by path is in the map');
    // The full suite, with the reason, for anything the map cannot place.
    const full = (changed: string[]) => { const selection = selectAffected(changed, map, tests); assert.equal(selection.mode, 'full', changed.join(', ')); assert.deepEqual(selection.files, tests); return selection.reason; };
    assert.equal(full(['src/unused.ts']), 'src/unused.ts is not in the dependency map');
    assert.equal(full(['docs/orphan.md']), 'docs/orphan.md is not in the dependency map');
    assert.equal(full(['src/types.ts']), 'src/types.ts is not in the dependency map', 'a type-only import is no runtime dependency');
    for (const changed of ['package.json', 'package-lock.json', 'tests/helpers/shared.ts', 'tsconfig.json', 'vite.config.ts', '.github/workflows/ci.yml', 'scripts/ci-tests.mjs'])
      assert.match(full(['src/leaf.ts', changed]), /changes the install, the test runner or configuration$/, changed);
    assert.equal(selectAffected(null, map, tests).mode, 'full');

    // Only a pull request's own run narrows; merge-queue tips and pushes to main run everything.
    const run = (overrides: Partial<Parameters<typeof selectForRun>[0]>) => selectForRun({ event: 'pull_request', headSubject: 'Add a leaf', queued: false, changed: ['src/leaf.ts'], map, tests, ...overrides });
    assert.deepEqual(run({}).files, ['tests/middle.test.ts']);
    assert.equal(run({ event: 'push' }).mode, 'full');
    assert.equal(run({ headSubject: 'Graphyard speculative tip for GY-7 behind main' }).reason, 'the head is a merge-queue speculative tip');
    assert.equal(run({ queued: true }).reason, 'the head is published as a merge-queue tip');
    assert.equal(run({ queued: null }).mode, 'full', 'unreadable queue refs are treated as a tip');
  } finally { await rm(root, { recursive: true, force: true }); }

  // On this repository: a test that imports a module is selected by a change to it, a module
  // imported only through another is followed, and a change reaching no test runs everything.
  const tests = listTestFiles(), map = dependencyMap(undefined, tests);
  const direct = selectAffected(['src/cli/timing-failures.ts'], map, tests);
  assert.equal(direct.mode, 'affected');
  assert.ok(direct.files.includes('tests/timing-stability.test.ts'), 'imported through tests/helpers/timing-report.ts');
  assert.ok(direct.files.length < tests.length, `${direct.files.length} of ${tests.length}`);
  const own = selectAffected(['tests/ci-shards.test.ts'], map, tests);
  assert.equal(own.mode, 'affected'); assert.ok(own.files.includes('tests/ci-shards.test.ts'), 'a changed test file selects itself');
  assert.equal(selectAffected(['README.missing.md'], map, tests).mode, 'full');
});
