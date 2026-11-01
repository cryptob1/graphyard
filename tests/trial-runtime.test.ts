import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runTrial } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

async function managedRepo(files: Record<string, string>) {
  const root = await temporaryDirectory('trial-runtime-repo', tmpdir());
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
  }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return { root, base: git('rev-parse', 'HEAD') };
}

test('unit:trial-runtime-with-isolated-home — build and repository tests use the running Node installation before host shims that require trusted home configuration', async () => {
  const shims = await temporaryDirectory('trial-host-shims', tmpdir());
  for (const name of ['node', 'npm']) {
    const shim = join(shims, name);
    writeFileSync(shim, '#!/bin/sh\necho "host configuration is not trusted" >&2\nexit 86\n');
    chmodSync(shim, 0o755);
  }
  const environment = { ...process.env, PATH: `${shims}:${process.env.PATH}` };
  assert.throws(() => execFileSync('npm', ['--version'], { env: environment, stdio: 'pipe' }),
    (error: unknown) => (error as { status: number }).status === 86, 'the inherited PATH reproduces the launch failure');
  const repo = await managedRepo({
    'package.json': JSON.stringify({ name: 'fixture', scripts: { build: 'node check.cjs', test: 'node check.cjs' } }),
    'check.cjs': `const assert = require('node:assert/strict');
assert.notEqual(process.env.HOME, ${JSON.stringify(process.env.HOME)});
assert.equal(process.env.XDG_CONFIG_HOME, require('node:path').join(process.env.HOME, '.config'));
console.log('isolated runtime works');\n`,
  });
  const scratch = await temporaryDirectory('trial-runtime-scratch', tmpdir());
  const result = await runTrial({
    root: repo.root, base: await temporaryDirectory('trial-runtime-root', tmpdir()),
    mergeSha: repo.base, changedFiles: ['check.cjs'], timeoutMs: 120_000,
    environment, retries: 0, temporaryRoots: [scratch], checkoutRoots: [scratch],
  });
  assert.equal(result.build, 'pass', result.logTail);
  assert.deepEqual(result.tests, { passed: 1, failed: [], files: 1 }, result.logTail);
  assert.match(result.logTail, /isolated runtime works/);
});

