import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';
import { defaultWorktreeRoot, sessionCheckout } from '../src/install/worktree-root.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

import { coordinationWork } from '../src/server/work-view.js';
import { pruneDaemonState } from '../src/daemon/state.js';

const clock = Date.parse('2030-01-01T00:00:00Z');

test('integration:close-dead-worktree-panes — an exited Graphyard pane in a removed worktree closes within a cycle; the master, foreign and running panes stay open', async () => {
  const directory = await temporaryDirectory('dead-panes');
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const removed = join(directory, '.graphyard/worktrees/GY-1-2'), live = join(directory, '.graphyard/worktrees/GY-3-1');
  await mkdir(live, { recursive: true });
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  config.run.worktreeRoot = join(directory, 'custom-checkouts');
  const managed = sessionCheckout(defaultWorktreeRoot(directory, config.repository), 'review', 'GY-1', 'a'.repeat(40), 'b'.repeat(32)).worktree;
  const custom = sessionCheckout(config.run.worktreeRoot, 'proof', 'GY-1', 'a'.repeat(40), 'c'.repeat(32)).worktree;
  const state = emptyDaemonState(config);
  state.master.pane = 'pane-master';
  const handle = (id: string, pane: string) => ({ id, kind: 'implementation', principal: 'worker', epoch: 2, runtime: 'claude', host: 'other-host', pane, subject: 'x', state: 'finished' });
  const work = [{ id: 'w1', key: 'GY-1', stage: 'done', sessions: [handle('master:1', 'pane-master'), handle('worker:2', 'pane-dead'), handle('worker:3', 'pane-running'), { ...handle('review:1', 'pane-review'), kind: 'review' }, { ...handle('proof:1', 'pane-proof'), kind: 'proof' }] }] as unknown as Work[];
  const agents = [
    { pane_id: 'pane-review', agent: 'codex', agent_status: 'exited', cwd: `${managed} (deleted)` },
    { pane_id: 'pane-proof', agent: null, agent_status: 'unknown', cwd: custom },
    { pane_id: 'pane-dead', agent: null, agent_status: 'unknown', cwd: `${removed} (deleted)` },
    { pane_id: 'pane-running', agent: 'claude', agent_status: 'working', cwd: `${removed} (deleted)` },
    { pane_id: 'pane-master', agent: null, agent_status: 'unknown', cwd: `${removed} (deleted)` },
    { pane_id: 'pane-foreign', agent: null, agent_status: 'unknown', cwd: `${removed} (deleted)` },
  ];
  // The actual coordination view omits settled sessions; the old launch is also pruned.
  const projected = work.map(item => coordinationWork(item, { evidence: 0, dispatchHistory: 0, queueHistory: 0, actionHistory: 0, sessions: 0 }));
  assert.deepEqual(projected[0].sessions, []);
  for (let index = 0; index <= 500; index++) state.actions[`old:${index}`] = {
    attempts: 1, epoch: null, cycle: 0, kind: 'close', work: null, state: 'done', principal: null,
    at: new Date(clock - 1000 + index).toISOString(), detail: 'old action', pane: index === 0 ? 'pane-dead' : undefined,
  };
  pruneDaemonState(state);
  assert.equal(state.actions['old:0'], undefined);
  let fullReads = 0;
  const closed: string[] = [];
  const effects: DaemonEffects = {
    agents: () => agents, credentials: async () => ({}), snapshot: async () => ({ work: projected, now: new Date(clock).toISOString() }),
    sessionHistory: async item => { fullReads++; assert.equal(item.id, work[0].id); return work[0].sessions!; },
    closeSession: pane => { closed.push(pane); }, dispatch: async () => {}, persist: async () => {}, dispatchTick: async () => {},
  };
  await runCycle(config, state, effects, () => clock);
  assert.deepEqual(closed, ['pane-review', 'pane-proof', 'pane-dead']);
  assert.equal(fullReads, 1, 'one history recovery for the eligible inventory');

  // A Graphyard pane whose worktree still exists stays open even after its runtime exited.
  closed.length = 0;
  agents.splice(0, agents.length, { pane_id: 'pane-dead', agent: null, agent_status: 'unknown', cwd: live });
  await runCycle(config, state, effects, () => clock);
  assert.deepEqual(closed, []);
  assert.equal(fullReads, 1, 'no full history read for an existing worktree');
});
