import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { coordinatorConfinement, sessionMountNamespaceWorks } from '../src/master/confinement.js';
import { prepareConfinedGitPaths } from '../src/master/launch.js';
import { moveBranchToHead } from '../src/daemon/worker-verification.js';
import { preservedWorkNote, removeAttemptWorktree, worktreesDirectory } from '../src/master/worktrees.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3279 (hwd-backend GY-7): once git packed the graphyard/* refs and removed the emptied
// refs/heads/graphyard directory, no worker could commit; a finished detached head could not be
// submitted; and closing the attempt deleted the only name its commits had.

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' });

test('e2e:packed-refs-worker-commit — with graphyard/* refs packed and refs/heads/graphyard absent a confined worker commits and completes, a detached descendant head moves the branch, and a closed attempt\'s commits on no branch are kept and named to the next attempt', async () => {
  const root = join(await temporaryDirectory('packed-refs-worker'), 'coordinator');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), '.graphyard/\n');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'base');
  mkdirSync(worktreesDirectory(root), { recursive: true });
  const [first, second] = ['GY-7-1', 'GY-7-2'].map(name => join(worktreesDirectory(root), name));
  git(root, 'worktree', 'add', '-q', '-b', 'graphyard/gy-7-1', first!);
  git(root, 'worktree', 'add', '-q', '-b', 'graphyard/gy-7-2', second!);
  git(root, 'pack-refs', '--all');
  const namespace = join(root, '.git', 'refs', 'heads', 'graphyard');
  assert.equal(existsSync(namespace), false, 'the fixture: graphyard/* refs are packed and their directory is gone');

  // The launch, then a merge elsewhere whose pack empties the namespace while the session runs.
  prepareConfinedGitPaths(root);
  const confinement = await coordinatorConfinement({ kind: 'pi', args: [], coordinatorRoot: root, sessionDirectory: first!, platform: 'linux', mountNamespaceWorks: true, bwrap: 'bwrap' });
  git(root, 'branch', 'graphyard/gy-5-1'); git(root, 'pack-refs', '--all');
  assert.equal(existsSync(namespace), true, 'a pack after the launch leaves the branch namespace directory in place');
  assert.equal(git(root, 'fsck', '--no-dangling'), '', 'the repository stays clean to git fsck');

  // A head detached at a descendant of the branch completes: the branch moves to it.
  git(second!, 'checkout', '-q', '--detach');
  git(second!, 'commit', '-q', '--allow-empty', '-m', 'finished detached');
  const detached = git(second!, 'rev-parse', 'HEAD');
  await moveBranchToHead(root, 'graphyard/gy-7-2', detached);
  assert.equal(git(root, 'rev-parse', 'refs/heads/graphyard/gy-7-2'), detached, 'the assigned branch moved to the detached head');
  await assert.rejects(moveBranchToHead(root, 'graphyard/gy-7-1', git(root, 'commit-tree', '-m', 'unrelated', 'HEAD^{tree}')), /descending from it/, 'a head that does not descend from the branch is refused');

  // Commits the closed attempt left on no branch stay reachable, and the next attempt is told where.
  git(second!, 'commit', '-q', '--allow-empty', '-m', 'unsubmitted');
  const unsubmitted = git(second!, 'rev-parse', 'HEAD');
  assert.equal(await removeAttemptWorktree(root, second!, run), true);
  assert.equal(existsSync(second!), false, 'the closed attempt\'s worktree is removed');
  assert.equal(git(root, 'rev-parse', 'refs/graphyard/preserved/GY-7-2'), unsubmitted, 'its unsubmitted commits are kept under the preserved ref');
  assert.match(await preservedWorkNote(root, 'GY-7', run), /refs\/graphyard\/preserved\/GY-7-2/, 'the next attempt\'s prompt names the ref');
  assert.equal(await preservedWorkNote(root, 'GY-8', run), '', 'an item with nothing kept is told nothing');

  // The confined worker commits on its assigned branch and completes with that head.
  if (process.platform !== 'linux') return;
  assert.ok(await sessionMountNamespaceWorks(), 'mount namespaces work on this Linux host');
  const session = spawnSync(confinement!.wrapper[0]!, [...confinement!.wrapper.slice(1, -1), 'git', '-C', first!, '-c', 'user.name=w', '-c', 'user.email=w@t', 'commit', '-q', '--allow-empty', '-m', 'worker change'],
    { encoding: 'utf8', timeout: 240_000, killSignal: 'SIGKILL' });
  assert.equal(session.status, 0, `the confined worker committed on its packed branch: ${session.stderr}`);
  const head = git(first!, 'rev-parse', 'HEAD');
  assert.equal(git(root, 'rev-parse', 'refs/heads/graphyard/gy-7-1'), head, 'the assigned branch holds the worker\'s commit');
  await moveBranchToHead(root, 'graphyard/gy-7-1', head);
});
