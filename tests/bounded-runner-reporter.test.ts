import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// 2026-11-04: the merge trial runs the suite with --test-reporter=tap --test-reporter-destination=stdout;
// the per-file runner (GY-3085) added its own spec reporter, so Node refused every file before it ran
// ("'--test-reporter' must match the number of specified '--test-reporter-destination'").
test('unit:bounded-runner-reporter — the per-file runner runs files when the caller passes its own reporter flags', async () => {
  const directory = await temporaryDirectory('bounded-runner-reporter');
  const file = join(directory, 'one.test.mjs');
  await writeFile(file, "import test from 'node:test';\ntest('passes', () => {});\n");
  const runner = new URL('./helpers/bounded-tests.mjs', import.meta.url).pathname;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', 'tsx', runner, '--test-reporter=tap', '--test-reporter-destination=stdout', '--test-concurrency=1', '--file-timeout=60000', file], { encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT')) });
  assert.doesNotMatch(stdout + stderr, /must match the number of specified/);
  assert.match(stdout, /^ok 1 - passes/m, 'the caller still receives TAP, from which the merge trial counts executed proofs');
});
