import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { runWorkerVerification } from '../src/merge-writer/worker-verification.js';
import type { Work } from '../src/model.js';

// This is deliberately a real trial: a host without Docker cannot satisfy placement.
test('integration:worker-verification-placement — exact committed head executes in the private trial and a failing proof stays failed', { timeout: 120_000 }, async () => {
  const root = await temporaryDirectory('worker-verification', process.cwd());
  const allocations = await temporaryDirectory('trials', root);
  const repository = await temporaryDirectory('repository', root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repository, '.gitignore'), '.graphyard/\nnode_modules/\n');
  await writeFile(join(repository, 'package.json'), '{"type":"module"}');
  await mkdir(join(repository, 'tests'));
  const source = (fails: boolean) => `
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
test('integration:placed — private container and unnested namespaces', () => {
  assert.equal(existsSync('/etc/graphyard-trial'), true);
  assert.equal(existsSync('/var/run/docker.sock'), false);
  execFileSync('bwrap', ['--unshare-user', '--ro-bind', '/', '/', '--', 'true']);
  assert.equal(${fails}, false, 'deliberate criterion failure');
});`;
  await writeFile(join(repository, 'tests/placed.test.ts'), source(false));
  git('add', '.'); git('commit', '-qm', 'passing head');
  const head = git('rev-parse', 'HEAD');
  const work = { key: 'GY-1', criteria: [{ id: 'AC-1', proofs: ['integration:placed'] }] } as Work;
  // Uncommitted candidate edits must never replace the requested head.
  await writeFile(join(repository, 'tests/placed.test.ts'), source(true));
  const passing = await runWorkerVerification(repository, work, { head, epoch: 1, mode: 'verify' }, 'main', allocations);
  assert.equal(passing.record.head, head);
  assert.equal(passing.record.ran[0].result, 'pass');
  assert.equal(passing.record.ran[0].executed, 1);
  git('add', '.'); git('commit', '-qm', 'failing head');
  const failedHead = git('rev-parse', 'HEAD');
  const failing = await runWorkerVerification(repository, work, { head: failedHead, epoch: 1, mode: 'complete' }, 'main', allocations);
  assert.equal(failing.record.head, failedHead);
  assert.equal(failing.record.ran[0].result, 'fail');
  assert.equal(failing.record.ran[0].failed, 1);
});
