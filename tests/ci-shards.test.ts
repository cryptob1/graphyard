import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dependencyMap, listTestFiles, selectAffected, selectForRun, shardFiles } from '../scripts/ci-tests.mjs';
import { nestedFirst, nestedPortGap, nodeTestArgs, runTests } from './helpers/run-tests.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-499: the required `test` check ran the whole suite on one runner in about fifteen minutes, on
// every rework round, base refresh and queue tip. It is now an aggregate over a matrix of shard jobs
// balanced by file count, and a pull request's own run executes only the test files its change
// affects. One case per proof: unit:ci-sharded, unit:affected-tests-selected.

test('unit:ci-sharded — shards balanced by file count, every file on exactly one (GY-2009: Actions ci.yml gate removed; merge writer trial shards tests)', async () => {
  assert.ok(!existsSync(new URL('../.github/workflows/ci.yml', import.meta.url)), 'ci.yml is gone');
  const tests = listTestFiles();
  const shards = shardFiles(tests, 7);
  assert.equal(shards.length, 7);
  assert.deepEqual(shards.flat().sort(), tests, 'every test file runs on exactly one shard');
  const sizes = shards.map(shard => shard.length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `shards hold as near as possible the same number of files: ${sizes.join(', ')}`);
  // Deterministic: the files sorted and dealt round-robin, a repeated file once.
  assert.deepEqual(shardFiles(['b', 'a', 'c', 'd', 'e', 'a'], 2), [['a', 'c', 'e'], ['b', 'd']]);

  // The runner runs one shard of the selection, and nothing at all for an empty one.
  const cwd = await temporaryDirectory('ci-shards');
  await writeFile(join(cwd, 'list.txt'), 'tests/one.test.ts\ntests/two.test.ts\n'); await writeFile(join(cwd, 'none.txt'), '');
  const first = nodeTestArgs(cwd, ['--shard', '1/2', '--files-from', 'list.txt']), second = nodeTestArgs(cwd, ['--shard=2/2', '--files-from', 'list.txt']);
  assert.deepEqual([...first.args, ...second.args].filter(arg => !arg.startsWith('-')).sort(), ['tests/one.test.ts', 'tests/two.test.ts']);
  assert.deepEqual([first.ordered, second.ordered, nodeTestArgs(cwd, ['--shard', '1/2', '--test-only', 'tests/one.test.ts']).ordered], [true, true, false]);
  assert.deepEqual(nodeTestArgs(cwd, ['--shard', '1/1', '--durations', 'd.jsonl', '--files-from', 'list.txt']).args.slice(0, 2), ['--durations', join(cwd, 'd.jsonl')]);
  assert.equal(nodeTestArgs(cwd, ['--shard', '3/3', '--files-from', 'list.txt']).empty, true);
  assert.equal(nodeTestArgs(cwd, ['--files-from', 'none.txt']).empty, true);
  assert.ok(nodeTestArgs(cwd, ['--durations', 'd.jsonl', 'tests/one.test.ts']).args.some(arg => arg.endsWith('file-durations.mjs')));
});

async function fixture(files: Record<string, string>) {
  const root = await temporaryDirectory('affected');
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
  const direct = selectAffected(['src/tmp-reclaim.ts'], map, tests);
  assert.equal(direct.mode, 'affected');
  assert.ok(direct.files.includes('tests/ci-shards.test.ts'), 'imported through tests/helpers/run-tests.ts');
  assert.ok(direct.files.length < tests.length, `${direct.files.length} of ${tests.length}`);
  const own = selectAffected(['tests/ci-shards.test.ts'], map, tests);
  assert.equal(own.mode, 'affected'); assert.ok(own.files.includes('tests/ci-shards.test.ts'), 'a changed test file selects itself');
  assert.equal(selectAffected(['README.missing.md'], map, tests).mode, 'full');
});

test('a test run started inside another test run reserves its ports above the parent\'s window, so a sibling file\'s Postgres keeps its port', async () => {
  assert.deepEqual(nestedFirst({}), {}, 'a top-level run starts at the default base');
  assert.deepEqual(nestedFirst({ GRAPHYARD_TEST_PORT: '15438' }), { first: 15438 + nestedPortGap });
  // This file runs inside the suite's window; a run it starts lands above that window's every offset.
  const parent = Number(process.env.GRAPHYARD_TEST_PORT);
  assert.ok(parent > 0, 'the suite runs under a reserved GRAPHYARD_TEST_PORT');
  const project = await temporaryDirectory('nested-run');
  await mkdir(join(project, 'tests'));
  await writeFile(join(project, 'tests/port.test.ts'), "import { test } from 'node:test';\ntest('reserved', () => {});\n");
  const run = await runTests({ cwd: project, args: ['tests/port.test.ts'], stdio: 'pipe', ports: { span: 20 } });
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.ok(run.base >= parent + nestedPortGap, `nested window ${run.base} lies above the parent's ${parent} and its offsets`);
});
