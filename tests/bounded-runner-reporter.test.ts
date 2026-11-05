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

test('unit:bounded-runner-receipt-deadline — the twenty-run receipt gets its declared budget while ordinary files remain bounded', async () => {
  const directory = await temporaryDirectory('bounded-runner-receipt-deadline');
  const receipt = join(directory, 'slow-tick-repeat-receipt.test.ts');
  const ordinary = join(directory, 'ordinary.test.ts');
  const source = "import test from 'node:test';\ntest('runs past the short default', async () => { await new Promise(resolve => setTimeout(resolve, 200)); });\n";
  await writeFile(receipt, source);
  await writeFile(ordinary, source);
  const runner = new URL('./helpers/bounded-tests.mjs', import.meta.url).pathname;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT'));
  const args = [runner, '--test-reporter=tap', '--test-concurrency=1', '--file-timeout=100'];
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, [...args, receipt], { env });
  assert.match(stdout, /^ok 1 - runs past the short default/m);
  await assert.rejects(run(process.execPath, [...args, ordinary], { env }), (error: any) => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /test file timed out after 100ms/);
    return true;
  });
});
