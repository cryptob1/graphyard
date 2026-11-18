import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { runWorkerVerification, verificationStep } from '../src/merge-writer/worker-verification.js';
import { failedRequiredProofs } from '../src/cli/worker-verification.js';
import type { Work } from '../src/model.js';

// GY-3506: GY-3462's verification failed as a bare `Command failed: node … verify.mjs`. Its proof
// hung when run against the base, so verify.mjs ran until the trial container's `timeout` stopped it
// at the deadline: exit status 124, nothing on stderr, and the allocation removed with every trace.

test('integration:worker-verification-error-details — a verification step that fails silently names its exit and keeps its output; the allocation is still removed', { timeout: 180_000 }, async () => {
  const silent = await verificationStep('sh', ['-c', 'echo "verify reached base run of tests/a.test.ts token=ghp_abcdefghijklmnopqrstuvwxyz"; exit 124'], {}, () => {}).then(() => null, error => error as Error);
  assert.match(silent!.message, /exit status 124: the trial container reached its deadline and was stopped/);
  assert.match(silent!.message, /verify reached base run of tests\/a\.test\.ts/);
  assert.doesNotMatch(silent!.message, /ghp_abcdef/, 'the kept output carries no secret');
  const killed = await verificationStep('sh', ['-c', 'kill -9 $$'], {}, () => {}).then(() => null, error => error as Error);
  assert.match(killed!.message, /stopped by SIGKILL/);

  // A real confined verification that fails returns its own words, and normal cleanup remains.
  const root = await temporaryDirectory('verification-error', process.cwd());
  const allocations = await temporaryDirectory('trials', root);
  const repository = await temporaryDirectory('repository', root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repository, 'package.json'), '{"type":"module"}');
  git('add', '.'); git('commit', '-qm', 'head');
  const work = { key: 'GY-1', criteria: [{ id: 'AC-1', proofs: ['integration:absent'] }] } as Work;
  await assert.rejects(runWorkerVerification(repository, work, { head: git('rev-parse', 'HEAD'), epoch: 1, mode: 'verify', preserves: ['integration:unknown'] }, 'main', allocations),
    /--preserves names integration:unknown/);
  assert.deepEqual(await readdir(allocations), [], 'the failed verification still removes its allocation');
});

/** A repository whose proof passes on HEAD and, like GY-3462's, hangs against the base it changes. */
async function hangingOnBase() {
  const root = await temporaryDirectory('verification-hang', process.cwd());
  const allocations = await temporaryDirectory('trials', root);
  const repository = await temporaryDirectory('repository', root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repository, '.gitignore'), '.graphyard/\nnode_modules/\n');
  await writeFile(join(repository, 'package.json'), '{"type":"module"}');
  await mkdir(join(repository, 'src')); await mkdir(join(repository, 'tests'));
  await writeFile(join(repository, 'src/feature.ts'), 'export const ready = false;\n');
  git('add', '.'); git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  await writeFile(join(repository, 'src/feature.ts'), 'export const ready = true;\n');
  await writeFile(join(repository, 'tests/feature.test.ts'), `import { test } from 'node:test';
import { ready } from '../src/feature.ts';
test('integration:feature — ready, else waits forever', async () => {
  if (!ready) await new Promise(() => { setInterval(() => {}, 1000); });
});`);
  await writeFile(join(repository, 'tests/stuck.test.ts'), `import { test } from 'node:test';
test('integration:stuck — never ends', async () => { await new Promise(() => { setInterval(() => {}, 1000); }); });`);
  git('add', '.'); git('commit', '-qm', 'head');
  return { repository, allocations, head: git('rev-parse', 'HEAD') };
}

test('e2e:worker-verification-error-details — a proof that hangs against the base no longer kills the confined verification; one that hangs on HEAD still fails it', { timeout: 420_000 }, async () => {
  const { repository, allocations, head } = await hangingOnBase();
  const work = { key: 'GY-1', criteria: [{ id: 'AC-1', proofs: ['integration:feature'] }] } as Work;
  // A short verification bound stands in for the 55-minute one: before the fix verify.mjs ran past it and failed opaquely.
  const verified = await runWorkerVerification(repository, work, { head, epoch: 1, mode: 'complete' }, 'main', allocations, () => {}, 90_000);
  const [feature] = verified.record.ran;
  assert.equal(feature!.result, 'pass', JSON.stringify(feature));
  assert.equal(feature!.exercise?.result, 'fail', JSON.stringify(feature));
  assert.match(feature!.exercise!.abnormal!, /did not finish within \d+s and was stopped/);
  assert.deepEqual(failedRequiredProofs(verified.record), []);
  assert.deepEqual(await readdir(allocations), []);

  // Successful verification still enforces every required proof: one stopped on HEAD fails.
  const strict = { key: 'GY-1', criteria: [{ id: 'AC-1', proofs: ['integration:feature'] }, { id: 'AC-2', proofs: ['integration:stuck'] }] } as Work;
  const stuck = await runWorkerVerification(repository, strict, { head, epoch: 1, mode: 'verify' }, 'main', allocations, () => {}, 90_000);
  assert.deepEqual(failedRequiredProofs(stuck.record).map(run => [run.proof, run.result]), [['integration:stuck', 'fail']]);
  assert.match(stuck.record.ran.find(run => run.proof === 'integration:stuck')!.abnormal!, /did not finish within/);
});
