import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
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
  // Set up a temporary worktree with a sandbox-only test file that fails
  const { mkdtemp } = await import('node:fs/promises');
  const tmpDir = await mkdtemp('/tmp/test-verify-');
  const workdir = await testWorktree(tmpDir);
  const testDir = join(workdir, 'tests');
  await mkdir(testDir, { recursive: true });

  // Create a test file outside planned files that fails
  const sandboxTest = join(testDir, 'cli.test.ts');
  await writeFile(sandboxTest, `
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('unit:sandbox-test fails', () => assert.fail('fails outside planned files'));
`);

  // Add this file to git
  execFileSync('git', ['-C', workdir, 'add', '.']);
  execFileSync('git', ['-C', workdir, 'commit', '-q', '-m', 'add sandbox test']);

  // Run verify with criteria pointing to unit:sandbox-test but with no planned files
  // This means all test files are outside planned files, making this a sandbox-only test
  const record = await verifyWorkingTree(
    {
      key: 'GY-TEST',
      criteria: [{ id: 'AC-2', proofs: ['unit:sandbox-test'] }],
      plannedFiles: ['src/main.ts'] // Planned file that has no tests
    },
    workdir
  );

  // The failure in cli.test.ts (which is outside planned files) should be marked as leftToCi
  const sandboxFailure = record.ran.find(r => r.proof === 'unit:sandbox-test' && r.result === 'fail');
  assert.ok(sandboxFailure?.leftToCi === true, 'sandbox-only test failures marked as leftToCi');

  // Cleanup
  await rm(tmpDir, { recursive: true });
});

test('unit:worker-submits-sandbox-failures-to-ci — the worker harness documents that workers submit when criteria pass and CI is the full suite gate', async () => {
  const harness = await readFile(new URL('../src/master/harness.ts', import.meta.url), 'utf8');

  // The harness rules documentation should state the GY-853 criteria
  assert.match(harness, /Workers submit when their own criteria pass/, 'documents worker submission on criteria pass');
  assert.match(harness, /full test suite is CI['']s gate/, 'documents full suite as CI gate');
  assert.match(harness, /runs the build and tests for.*own criteria/, 'documents running build and tests for criteria');
  assert.match(harness, /graphyard verify/, 'mentions verify command');

  // The harness should document sandbox-only failures going to CI
  assert.match(harness, /full-suite failures.*outside.*planned files/s, 'documents full-suite failures outside planned files');
  assert.match(harness, /blocker/, 'mentions blocker instead of recording one');
  assert.match(harness, /left to CI/, 'documents failures left to CI');
});
