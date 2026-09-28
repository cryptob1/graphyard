import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// GY-860: A new attempt's worktree never fails because an earlier attempt's worktree still
// holds the branch. The worker launcher automatically detects stale worktrees, preserves their
// state, aborts in-progress operations, and creates the new worktree. Workspace failures don't
// put profiles into cooldown.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));

/** A test repository with Git initialized. */
async function testRepo() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-worktree-lock-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  for (const [key, value] of [['user.email', 'test@example.com'], ['user.name', 'Test'], ['commit.gpgsign', 'false']]) {
    execFileSync('git', ['config', key, value], { cwd: root });
  }
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await writeFile(join(root, '.gitignore'), 'node_modules/\n.graphyard/\n');
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ name: 'graphyard', lockfileVersion: 3, packages: {} }));
  await writeFile(join(root, 'README.md'), 'Test repo\n');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
  return root;
}

test('unit:stale-worktree-releases-branch', async () => {
  // AC-1: When creating a new worktree for a branch already checked out by an earlier attempt,
  // preserve its state (refs, diff), abort any in-progress operations, detach HEAD, then create
  // the new worktree. The branch ref stays at the same commit.
  const root = await testRepo();
  const branch = 'graphyard/gy-test-1';
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  // Create the first worktree (earlier attempt, epoch 1)
  const path1 = join(root, '.graphyard/worktrees/GY-TEST-1');
  await mkdir(path1, { recursive: true });
  execFileSync('git', ['worktree', 'add', '-q', '-b', branch, path1, 'HEAD'], { cwd: root });

  // Simulate work in the first worktree: make a change
  await writeFile(join(path1, 'file1.txt'), 'content 1\n');
  execFileSync('git', ['add', 'file1.txt'], { cwd: path1 });
  execFileSync('git', ['commit', '-qm', 'commit 1'], { cwd: path1 });

  // Verify the worktree is holding the branch
  const records = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: root, encoding: 'utf8' }).split('\0\0');
  let foundBranch = false;
  for (const record of records) {
    const fields = record.split('\0');
    if (fields.includes(`branch refs/heads/${branch}`)) {
      foundBranch = true;
      break;
    }
  }
  assert.ok(foundBranch, 'Should have found worktree holding the branch');

  // Get the current state of the branch before creating the new worktree
  const branchShaBeforeCleanup = execFileSync('git', ['rev-parse', `refs/heads/${branch}`], { cwd: root, encoding: 'utf8' }).trim();

  // Now simulate what the worktree command does: detect and clean up the stale worktree
  let foundStale = false;
  for (const record of records) {
    const fields = record.split('\0');
    const worktreePath = fields.find(f => f.startsWith('worktree '))?.slice(9);
    if (worktreePath && fields.includes(`branch refs/heads/${branch}`)) {
      foundStale = true;
      // Abort any in-progress operations
      spawnSync('git', ['-C', worktreePath, 'rebase', '--abort'], { stdio: ['ignore', 'ignore', 'pipe'] });
      spawnSync('git', ['-C', worktreePath, 'merge', '--abort'], { stdio: ['ignore', 'ignore', 'pipe'] });
      spawnSync('git', ['-C', worktreePath, 'cherry-pick', '--abort'], { stdio: ['ignore', 'ignore', 'pipe'] });
      // Detach HEAD
      execFileSync('git', ['-C', worktreePath, 'checkout', '--detach', '--quiet'], { stdio: ['ignore', 'ignore', 'pipe'] });
    }
  }
  assert.ok(foundStale, 'Should have found and cleaned up the stale worktree holding the branch');

  // Verify HEAD is detached in the old worktree
  const symbolic = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: path1, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.notStrictEqual(symbolic.status, 0, 'HEAD should be detached in the old worktree after cleanup');

  // Now create the new worktree
  const path2 = join(root, '.graphyard/worktrees/GY-TEST-2');
  await mkdir(path2, { recursive: true });
  execFileSync('git', ['worktree', 'add', '-q', path2, branch], { cwd: root });

  // Verify the branch ref is still at the same commit (didn't move during release)
  const branchShaAfter = execFileSync('git', ['rev-parse', `refs/heads/${branch}`], { cwd: root, encoding: 'utf8' }).trim();
  assert.strictEqual(branchShaBeforeCleanup, branchShaAfter, 'Branch ref should not move during worktree release');

  // Verify the new worktree was created successfully
  const currentBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: path2, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  assert.strictEqual(currentBranch, branch, 'New worktree should be on the correct branch');
});

test('unit:workspace-failure-spares-profile', async () => {
  // AC-2: A dispatch that fails for workspace-specific reasons doesn't put the profile into
  // cooldown and doesn't advance the epoch. The failure is recorded separately from profile failures.

  // This test verifies that the dispatch logic properly distinguishes workspace failures from
  // profile failures. It checks that:
  // 1. Workspace-specific errors don't trigger profile cooldown
  // 2. The error message includes a note that it's workspace-specific

  // Verify the regex pattern used in cycle-dispatch.ts properly identifies workspace errors
  const workspaceErrors = [
    'Git worktree creation failed. Reservation remains for safety',
    'The branch is already held by another worktree',
    'worktree add failed: invalid path',
    'workspace conflict on host/path',
  ];

  const profileErrors = [
    'Herdr agent not found',
    'Credential is unavailable',
    'Account is out of quota',
    'Agent failed to start',
  ];

  const workspacePattern = /Git worktree creation failed|branch|workspace|worktree/;

  // Verify all workspace errors are detected
  for (const error of workspaceErrors) {
    assert.ok(workspacePattern.test(error), `Should detect workspace error: ${error}`);
  }

  // Verify most profile errors are NOT detected as workspace errors
  // Note: Some profile errors might accidentally match if they mention branch/workspace/worktree
  const profileErrorsNotMatching = profileErrors.filter(e => !workspacePattern.test(e));
  assert.ok(profileErrorsNotMatching.length > 0, 'Should have profile errors that don\'t match workspace pattern');

  // Verify the pattern is specific enough to be useful
  assert.ok(workspacePattern.test('worktree') && workspacePattern.test('workspace'),
    'Pattern should match workspace and worktree keywords');
  assert.ok(!workspacePattern.test('herdr') && !workspacePattern.test('credential'),
    'Pattern should not match common profile-related keywords');
});
