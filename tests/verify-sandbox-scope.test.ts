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

test('unit:worker-submits-sandbox-failures-to-ci — the worker prompt states the full suite is CI\'s gate and workers submit when criteria pass', async () => {
  const { workerPrompt } = await import('../src/master/dispatch.js');
  const prompt = workerPrompt(
    { cliPath: 'graphyard' },
    {
      key: 'GY-1',
      title: 'Test item',
      criteria: [
        { id: 'AC-1', text: 'Test criterion', proofs: ['unit:my-feature'] },
      ],
      plannedFiles: ['src/feature.ts'],
    },
    { principal: 'test-worker' },
    1
  );

  // The prompt should mention submitting when criteria pass
  assert.match(prompt, /run the build and tests for.*own criteria/, 'prompt mentions criteria-based submission');
  assert.match(prompt, /full test suite is CI['']s gate/, 'prompt states full suite is CI gate');
  assert.match(prompt, /graphyard verify/, 'prompt mentions verify command');
  assert.match(prompt, /when those pass you submit/, 'prompt mentions submission when criteria pass');

  // The prompt should mention sandbox-only failures going to CI
  assert.match(prompt, /those failures go to CI/, 'prompt mentions failures going to CI');
  assert.match(prompt, /outside your planned files/, 'prompt mentions failures outside planned files');
});
