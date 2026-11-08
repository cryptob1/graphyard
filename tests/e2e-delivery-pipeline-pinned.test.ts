import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
// @ts-expect-error the scripts are plain ESM without declarations
import { deliveryFixture, scratchTrial } from '../scripts/e2e-delivery-fixture.mjs';

// GY-3196: the scheduled diagnostics run e2e:delivery-pipeline inside a trial whose network is
// unshared. The case's own scratch trial then ran the secret scan, whose binary is a download, and
// failed before its build. The case's trial must deliver with no network, as the e2e command runs it.
test('unit:e2e-delivery-pipeline-pinned — the delivery case\'s scratch trial passes with no network outside the test runner', { timeout: 180_000 }, async () => {
  const directory = await temporaryDirectory('e2e-delivery-pinned');
  const { root } = await deliveryFixture(directory);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  const baseTip = git('rev-parse', 'HEAD');
  await writeFile(join(root, 'src/store/change.mjs'), 'export const delivered = true;\n');
  git('commit', '-qam', 'Deliver');
  // The children run directly: the scan is the subject here, not the trial's container.
  const run: ChildRun = (command, args, options) => defaultChildRun(command, args, { ...options, wrapper: undefined });
  const trials = join(directory, 'trials');
  await mkdir(trials);
  // The e2e command is no test-runner child, so the trial runs its scan; and it has no network.
  const saved = { context: process.env.NODE_TEST_CONTEXT, lifecycle: process.env.npm_lifecycle_event, fetch: globalThis.fetch };
  delete process.env.NODE_TEST_CONTEXT; delete process.env.npm_lifecycle_event;
  globalThis.fetch = async () => { throw new Error('no network in a diagnostics trial'); };
  try {
    const trial = await scratchTrial(trials)({ root, base: join(directory, 'managed'), mergeSha: git('rev-parse', 'HEAD'), baseTip, changedFiles: ['src/store/change.mjs'],
      proofs: ['unit:scratch-delivery'], proofFiles: [], timeoutMs: 120_000, key: 'GY-1', attribute: false, environment: { PATH: process.env.PATH! }, run, remove: async () => {} });
    assert.equal(trial.build, 'pass', trial.logTail);
    assert.deepEqual(trial.proofs['unit:scratch-delivery'], { executed: 1, failed: 0 }, trial.logTail);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.context !== undefined) process.env.NODE_TEST_CONTEXT = saved.context;
    if (saved.lifecycle !== undefined) process.env.npm_lifecycle_event = saved.lifecycle;
  }
});
