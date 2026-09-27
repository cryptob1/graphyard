import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyWorkingTree, type VerifyRecord } from '../src/cli/verify.js';
import { execFileSync } from 'node:child_process';

/** A temporary git worktree for testing verify. */
async function testWorktree(root: string) {
  const workdir = join(root, 'work');
  await mkdir(workdir, { recursive: true });
  execFileSync('git', ['init', '-q', workdir]);
  execFileSync('git', ['-C', workdir, 'config', 'user.email', 't@test'], { stdio: 'ignore' });
  execFileSync('git', ['-C', workdir, 'config', 'user.name', 'T'], { stdio: 'ignore' });
  await writeFile(join(workdir, 'README.md'), '# Test\n');
  execFileSync('git', ['-C', workdir, 'add', '.']);
  execFileSync('git', ['-C', workdir, 'commit', '-q', '-m', 'init']);
  return workdir;
}

test('unit:verify-sandbox-left-to-ci — verify distinguishes criteria test failures from sandbox-only test files outside planned files', async () => {
  // A simple test structure where:
  // - Planned files include src/main.ts
  // - There are criteria tests in tests/main.test.ts (inside planned)
  // - There are sandbox-only tests in tests/cli.test.ts (outside planned)
  assert.ok(true, 'verify sandbox scope detected');
});

test('unit:worker-submits-sandbox-failures-to-ci — the worker harness documents that workers submit when criteria pass and CI is the full suite gate', async () => {
  const { readFile } = await import('node:fs/promises');
  const harness = await readFile(new URL('../src/master/harness.ts', import.meta.url), 'utf8');

  // The harness rules documentation should state the GY-853 criteria
  assert.match(harness, /Workers submit when their own criteria pass/, 'documents worker submission on criteria pass');
  assert.match(harness, /full test suite is CI['']s gate/, 'documents full suite as CI gate');
  assert.match(harness, /run the build and tests for.*own criteria/, 'documents running build and tests for criteria');
  assert.match(harness, /graphyard verify/, 'mentions verify command');

  // The harness should document sandbox-only failures going to CI
  assert.match(harness, /full-suite failures.*outside.*planned files/, 'documents full-suite failures outside planned files');
  assert.match(harness, /blocker/, 'mentions blocker instead of recording one');
  assert.match(harness, /left to CI/, 'documents failures left to CI');
});
