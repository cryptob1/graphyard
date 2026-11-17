import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Launcher, runCycle } from '../src/daemon/cycle.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import type { Work } from '../src/model.js';

// GY-3397: removing an ended attempt's worktree (its dependency install included) can outlast the
// close step's timeout; the removal runs beside the cycle, so the close step settles at once.

const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });

test('unit:loop-step-bounded — a slow worktree removal runs beside the cycle: the close step settles, the removal is not started twice, and its outcome is recorded when it ends', async () => {
  const now = Date.parse('2030-04-02T12:00:00Z');
  const path = '/repo/.graphyard/worktrees/GY-1-1';
  const work = [{ id: 'GY-1', key: 'GY-1', stage: 'build', lease: null, sessions: [], updatedAt: new Date(now - 60_000).toISOString(),
    workspaces: [{ host: 'machine-a', epoch: 1, path, owner: 'worker', branch: 'graphyard/gy-1-1' }] }] as unknown as Work[];
  let finish!: () => void;
  const removals: string[] = [];
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: new Date(now).toISOString() }),
    agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {}, persist: async () => {}, dispatchTick: async () => {},
    removeWorktree: target => { removals.push(target); return new Promise<boolean>(resolve => { finish = () => resolve(true); }); },
  };
  const state = emptyDaemonState(config), launcher = new Launcher(), lines: string[] = [];
  const cycle = () => Promise.race([runCycle(config, state, effects, () => now, launcher, line => lines.push(line)),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the cycle waited on the worktree removal')), 2_000).unref())]);
  await cycle();
  assert.deepEqual(removals, [path], 'the removal started');
  assert.ok(!lines.some(line => line.includes('the close step failed')), lines.join('\n'));
  await cycle();
  assert.equal(removals.length, 1, 'a removal still running is not started again');
  finish();
  await launcher.idle();
  assert.equal(state.actions['worktree:GY-1:1']?.state, 'done');
  const next = await cycle();
  assert.ok(next.actions.some(action => action.kind === 'reclaim' && action.detail.includes(path)), 'the settled removal is reported with the next cycle');
  assert.equal(removals.length, 1, 'a removed worktree is not removed again');
});
