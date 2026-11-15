import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { runCycle } from '../src/daemon/cycle.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { removeAttemptWorktree, worktreesDirectory } from '../src/master/worktrees.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3191: a done item's ended-attempt worktree is removed a day after its last attempt ended, even
// when the attempt left modified and untracked files; an open item's, or a recent one's, is kept.

const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const hour = 60 * 60 * 1000;

test('unit:tests/finished-worktree-removal.test.ts — a done item\'s dirty worktree goes a day after its attempt ended; an open item\'s, or one ended within the day, stays', async () => {
  const root = await temporaryDirectory('finished-worktree');
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'file.txt'), 'base\n');
  git(root, 'add', 'file.txt');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base');
  mkdirSync(worktreesDirectory(root), { recursive: true });
  const now = Date.parse('2030-04-02T12:00:00Z');
  const item = (key: string, stage: string, endedHoursAgo: number) => {
    const path = join(worktreesDirectory(root), `${key}-1`);
    git(root, 'worktree', 'add', '-q', '-b', `graphyard/${key.toLowerCase()}-1`, path);
    writeFileSync(join(path, 'file.txt'), 'modified\n');
    writeFileSync(join(path, 'untracked.txt'), 'new\n');
    const endedAt = new Date(now - endedHoursAgo * hour).toISOString();
    return { id: key, key, stage, lease: null, sessions: [], updatedAt: endedAt, attemptEnd: { epoch: 1, end: 'submitted', endedAt },
      workspaces: [{ host: 'machine-a', epoch: 1, path, owner: 'worker', branch: `graphyard/${key.toLowerCase()}-1` }] };
  };
  const work = [item('GY-1', 'done', 25), item('GY-2', 'build', 25), item('GY-3', 'done', 1)] as unknown as Work[];
  const run = (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' });
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: new Date(now).toISOString() }),
    agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {}, persist: async () => {}, dispatchTick: async () => {},
    removeWorktree: (path, force) => removeAttemptWorktree(root, path, run, force),
  };
  const state = emptyDaemonState(config);
  await runCycle(config, state, effects, () => now, undefined, () => {});
  const [done, open, recent] = work.map(entry => entry.workspaces[0]!.path);
  assert.equal(existsSync(done!), false, 'the done item\'s worktree ended 25 h ago is removed with its uncommitted files');
  assert.equal(existsSync(open!), true, 'an open item\'s worktree is kept');
  assert.equal(existsSync(recent!), true, 'a done item\'s worktree ended within 24 h is kept');
  assert.ok(git(root, 'branch', '--list', 'graphyard/gy-1-1').trim(), 'the removed worktree\'s branch survives');
});

// GY-3341: the loop's snapshot no longer carries settled deliveries, so their leftover worktrees are
// reclaimed from the disk: an old `GY-N-EPOCH` tree of an item the snapshot does not hold goes, a
// young tree stays (the snapshot may simply predate the item that just claimed it), and so does every
// tree of an item the snapshot holds — that item's own pass decides those.
test('unit:tests/finished-worktree-removal.test.ts — a settled delivery\'s leftover worktree is reclaimed from the disk once it is a day old', async () => {
  const root = await temporaryDirectory('settled-worktree');
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'file.txt'), 'base\n');
  git(root, 'add', 'file.txt');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base');
  mkdirSync(worktreesDirectory(root), { recursive: true });
  const now = Date.now();
  const tree = (name: string, changedHoursAgo: number) => {
    const path = join(worktreesDirectory(root), name);
    git(root, 'worktree', 'add', '-q', '-b', `graphyard/${name.toLowerCase()}`, path);
    writeFileSync(join(path, 'untracked.txt'), 'new\n');
    const changedAt = now - changedHoursAgo * hour;
    // The worktree's own mtime is what the loop reads: age it, its changed file and itself.
    execFileSync('touch', ['-d', new Date(changedAt).toISOString(), join(path, 'untracked.txt'), path]);
    return { path, changedAt };
  };
  // The settled delivery the loop's snapshot no longer holds (GY-9, delivered long ago), one changed
  // 25 h ago and one 1 h ago; an open item's tree the snapshot does hold; and a foreign directory.
  const oldSettled = tree('GY-9-1', 25), youngSettled = tree('GY-8-2', 1), open = tree('GY-7-1', 25);
  const foreign = join(worktreesDirectory(root), 'not-graphyard');
  mkdirSync(foreign);
  const openItem = { id: 'GY-7', key: 'GY-7', stage: 'build', lease: null, sessions: [], updatedAt: new Date(now).toISOString(),
    workspaces: [{ host: 'machine-a', epoch: 1, path: open.path, owner: 'worker', branch: 'graphyard/gy-7-1' }] } as unknown as Work;
  const stat = (path: string) => ({ path, changedAt: statSync(path).mtimeMs });
  const effects: DaemonEffects = {
    snapshot: async () => ({ work: [openItem], now: new Date(now).toISOString() }),
    agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {}, persist: async () => {}, dispatchTick: async () => {},
    removeWorktree: (path, force) => removeAttemptWorktree(root, path, (command, args) => execFileSync(command, args, { encoding: 'utf-8', stdio: 'pipe' }), force),
    attemptWorktrees: async () => [stat(oldSettled.path), stat(youngSettled.path), stat(open.path), stat(foreign)],
  };
  const state = emptyDaemonState(config);
  await runCycle(config, state, effects, () => now, undefined, () => {});
  assert.equal(existsSync(oldSettled.path), false, 'the settled delivery\'s day-old worktree is removed from the disk');
  assert.equal(existsSync(youngSettled.path), true, 'a tree changed within the day is left for its own day to pass');
  assert.equal(existsSync(open.path), true, 'an open item\'s tree is the snapshot pass\'s alone, and it keeps it');
  assert.equal(existsSync(foreign), true, 'a directory Graphyard did not name is never touched');
  assert.ok(Object.values(state.actions).some(action => action.kind === 'reclaim' && action.detail.includes('GY-9')), 'the reclaim says which settled item it removed for');
});
