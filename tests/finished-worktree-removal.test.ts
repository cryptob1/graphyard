import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
