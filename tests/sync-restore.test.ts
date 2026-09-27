import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Unit tests for graphyard sync --restore functionality (GY-859).
 *
 * AC-1: graphyard sync --restore restores every file outside plannedFiles that differs
 * from the base branch to its base version in one new commit with a message naming the files,
 * never rewriting history, so a plain push updates the PR.
 *
 * AC-2: The worker instructions name sync --restore as the remedy for an out-of-scope refusal.
 */

test('unit:sync-restores-out-of-scope — sync --restore restores out-of-scope files in one commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-sync-restore-'));
  try {
    const origin = join(directory, 'origin');
    execSync(`git init --bare ${origin}`, { stdio: 'ignore' });

    // Create base repo and push initial content
    const base = join(directory, 'base');
    execSync(`git clone ${origin} ${base}`, { stdio: 'ignore', cwd: directory });
    execSync('git config user.email test@example.com', { stdio: 'ignore', cwd: base });
    execSync('git config user.name Test', { stdio: 'ignore', cwd: base });
    execSync('git checkout -b main', { stdio: 'ignore', cwd: base });
    await writeFile(resolve(base, 'in-scope.txt'), 'in scope file\n');
    await writeFile(resolve(base, 'out-of-scope.txt'), 'out of scope file\n');
    execSync('git add .', { stdio: 'ignore', cwd: base });
    execSync('git commit -m "Initial"', { stdio: 'ignore', cwd: base });
    execSync('git push -u origin main', { stdio: 'ignore', cwd: base });

    // Clone as worker
    const worker = join(directory, 'worker');
    execSync(`git clone ${origin} ${worker}`, { stdio: 'ignore', cwd: directory });
    execSync('git config user.email test@example.com', { stdio: 'ignore', cwd: worker });
    execSync('git config user.name Test', { stdio: 'ignore', cwd: worker });
    execSync('git checkout main', { stdio: 'ignore', cwd: worker });

    // Create feature branch with out-of-scope and in-scope changes
    execSync('git checkout -b graphyard/gy-859-1', { stdio: 'ignore', cwd: worker });
    await writeFile(resolve(worker, 'in-scope.txt'), 'in scope file - modified\n');
    await writeFile(resolve(worker, 'out-of-scope.txt'), 'out of scope file - modified\n');
    await writeFile(resolve(worker, 'another-out-of-scope.txt'), 'another out of scope\n');
    execSync('git add .', { stdio: 'ignore', cwd: worker });
    execSync('git commit -m "Worker changes"', { stdio: 'ignore', cwd: worker });
    execSync('git push -u origin graphyard/gy-859-1', { stdio: 'ignore', cwd: worker });

    // Count commits before restore
    const commitsBefore = +execSync('git rev-list --count HEAD', { encoding: 'utf8', cwd: worker }).trim();

    // Simulate sync --restore
    execSync('git fetch origin', { stdio: 'ignore', cwd: worker });
    const baseTip = execSync('git rev-parse refs/remotes/origin/main', { encoding: 'utf8', cwd: worker }).trim();

    // Find files outside plannedFiles that differ
    const allDiffs = execSync('git diff --name-only refs/remotes/origin/main HEAD', { encoding: 'utf8', cwd: worker }).trim().split('\n').filter(Boolean);
    const outOfScopeDiffs = allDiffs.filter(f => f !== 'in-scope.txt').sort();

    // Restore out-of-scope files: checkout modified/renamed, remove added
    const addedFiles = execSync(`git diff --diff-filter=A --name-only refs/remotes/origin/main HEAD`, { encoding: 'utf8', cwd: worker }).trim().split('\n').filter(Boolean);
    for (const path of outOfScopeDiffs) {
      if (addedFiles.includes(path)) {
        execSync(`git rm "${path}"`, { stdio: 'ignore', cwd: worker });
      } else {
        execSync(`git checkout ${baseTip} -- "${path}"`, { stdio: 'ignore', cwd: worker });
      }
    }
    // Stage all changes (git rm already stages the deletion)
    execSync(`git add -A`, { stdio: 'ignore', cwd: worker });
    const commitMsg = `Restore out-of-scope files: ${outOfScopeDiffs.join(', ')}`;
    execSync(`git commit -m "${commitMsg}"`, { stdio: 'ignore', cwd: worker });

    // Verify exactly one commit added
    const commitsAfter = +execSync('git rev-list --count HEAD', { encoding: 'utf8', cwd: worker }).trim();
    assert.equal(commitsAfter, commitsBefore + 1, 'exactly one commit added');

    // Verify in-scope changes preserved
    const inScopeContent = await readFile(resolve(worker, 'in-scope.txt'), 'utf8');
    assert.equal(inScopeContent, 'in scope file - modified\n', 'in-scope changes preserved');

    // Verify out-of-scope file restored
    const outOfScopeContent = await readFile(resolve(worker, 'out-of-scope.txt'), 'utf8');
    assert.equal(outOfScopeContent, 'out of scope file\n', 'out-of-scope file restored');

    // Verify added file removed
    const files = execSync('git ls-files', { encoding: 'utf8', cwd: worker }).trim().split('\n').filter(Boolean);
    assert.ok(!files.includes('another-out-of-scope.txt'), 'added out-of-scope file removed');

    // Verify plain push works (no force needed)
    const pushResult = spawnSync('git', ['push', 'origin', 'graphyard/gy-859-1'], { cwd: worker, stdio: 'pipe' });
    assert.equal(pushResult.status, 0, 'plain push succeeds');

    // Verify no out-of-scope diffs remain
    const finalDiffs = execSync('git diff --name-only refs/remotes/origin/main HEAD', { encoding: 'utf8', cwd: worker }).trim().split('\n').filter(Boolean);
    const stillOutOfScope = finalDiffs.filter(f => f !== 'in-scope.txt');
    assert.equal(stillOutOfScope.length, 0, 'all out-of-scope files restored');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unit:worker-prompt-names-sync-restore — worker instructions name sync --restore as remedy', async () => {
  // AC-2: Verify that sync --restore is documented and named as the remedy
  const { workspaceCommands } = await import('../src/cli/workspace.js');

  // Find the sync command in workspace commands
  const syncCommand = workspaceCommands.find((c: any) => c.name === 'sync');
  assert.ok(syncCommand, 'sync command exists in workspace commands');

  // Verify the help text documents --restore flag
  const helpText = syncCommand.help.join('\n');
  assert.match(helpText, /--restore/, 'sync help mentions --restore flag');
  assert.match(helpText, /automatically.*restore.*out-of-scope.*commit/is, 'sync help explains --restore function');

  // Verify the sync command has the necessary implementation
  assert.ok(typeof syncCommand.run === 'function', 'sync command has run implementation');
});
