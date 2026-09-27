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
  // Set up a temporary worktree with both planned and unplanned test files
  const { mkdtemp } = await import('node:fs/promises');
  const tmpDir = await mkdtemp('/tmp/test-verify-');
  const workdir = await testWorktree(tmpDir);
  const testDir = join(workdir, 'tests');
  const srcDir = join(workdir, 'src');
  await mkdir(testDir, { recursive: true });
  await mkdir(srcDir, { recursive: true });

  // Create a test file OUTSIDE planned files that fails
  const sandboxTest = join(testDir, 'sandbox.test.ts');
  await writeFile(sandboxTest, `
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('unit:sandbox-test fails outside planned files', () => assert.fail('sandboxed failure'));
`);

  // Create a test file INSIDE planned files that fails
  const plannedTest = join(srcDir, 'main.test.ts');
  await writeFile(plannedTest, `
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('unit:planned-test fails inside planned files', () => assert.fail('planned failure'));
`);

  // Add both files to git
  execFileSync('git', ['-C', workdir, 'add', '.']);
  execFileSync('git', ['-C', workdir, 'commit', '-q', '-m', 'add test files']);

  // Run verify with planned files that include src but not tests
  const record = await verifyWorkingTree(
    {
      key: 'GY-TEST',
      criteria: [
        { id: 'AC-2', proofs: ['unit:sandbox-test'] },
        { id: 'AC-2', proofs: ['unit:planned-test'] }
      ],
      plannedFiles: ['src/main.ts', 'src/main.test.ts']
    },
    workdir
  );

  // The failure in sandbox.test.ts (outside planned files) must be marked leftToCi
  const sandboxFailure = record.ran.find(r => r.proof === 'unit:sandbox-test' && r.result === 'fail');
  assert.ok(sandboxFailure?.leftToCi === true, 'sandbox test failures outside planned files marked leftToCi');

  // The failure in main.test.ts (inside planned files) must NOT be marked leftToCi
  const plannedFailure = record.ran.find(r => r.proof === 'unit:planned-test' && r.result === 'fail');
  assert.ok(plannedFailure?.leftToCi !== true, 'planned test failures not marked leftToCi');

  // Cleanup
  await rm(tmpDir, { recursive: true });
});

test('unit:worker-submits-sandbox-failures-to-ci — the worker harness documents that workers submit when criteria pass and CI is the full suite gate', async () => {
  const harness = await readFile(new URL('../src/master/harness.ts', import.meta.url), 'utf8');

  // Extract the GY-853 section from the harness to verify it contains the complete behavior
  const gy853Match = harness.match(/GY-853:[\s\S]*?(?=\n\s*\*\/)/);
  assert.ok(gy853Match, 'GY-853 section found in harness.ts');
  const gy853Section = gy853Match![0];

  // The GY-853 section should explicitly document all the required behaviors
  assert.match(gy853Section, /Workers submit when their own criteria pass/, 'documents worker submission on criteria pass');
  assert.match(gy853Section, /full test suite is CI['']s gate/, 'documents full suite as CI gate');
  assert.match(gy853Section, /runs the build and tests for.*own criteria/, 'documents running build and tests for criteria');
  assert.match(gy853Section, /graphyard verify/, 'mentions verify command');
  assert.match(gy853Section, /full-suite failures.*outside.*planned files/s, 'documents full-suite failures outside planned files');
  assert.match(gy853Section, /instead of recording a blocker/, 'documents behavior instead of recording blocker');
  assert.match(gy853Section, /left to CI/, 'documents failures left to CI');
  assert.match(gy853Section, /complete/, 'documents complete submission');

  // Verify the section actually describes submission logic
  assert.match(gy853Section, /submit/, 'documents submission behavior');
  assert.match(gy853Section, /naming in the PR/, 'documents PR reporting of failures');
});
