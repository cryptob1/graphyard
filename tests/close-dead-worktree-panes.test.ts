import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const clock = Date.parse('2030-01-01T00:00:00Z');

test('integration:close-dead-worktree-panes — an exited Graphyard pane in a removed worktree closes within a cycle; the master, foreign and running panes stay open', async () => {
  const directory = await temporaryDirectory('dead-panes');
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const removed = join(directory, '.graphyard/worktrees/GY-1-2'), live = join(directory, '.graphyard/worktrees/GY-3-1');
  await mkdir(live, { recursive: true });
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  const state = emptyDaemonState(config);
  state.master.pane = 'pane-master';
  const handle = (id: string, pane: string) => ({ id, kind: 'implementation', principal: 'worker', epoch: 2, runtime: 'claude', host: 'other-host', pane, subject: 'x', state: 'finished' });
  const work = [{ id: 'w1', key: 'GY-1', stage: 'done', sessions: [handle('worker:2', 'pane-dead'), handle('worker:3', 'pane-running')] }] as unknown as Work[];
  const agents = [
    { pane_id: 'pane-dead', agent: null, agent_status: 'unknown', cwd: `${removed} (deleted)` },
    { pane_id: 'pane-running', agent: 'claude', agent_status: 'working', cwd: `${removed} (deleted)` },
    { pane_id: 'pane-master', agent: null, agent_status: 'unknown', cwd: `${removed} (deleted)` },
    { pane_id: 'pane-foreign', agent: null, agent_status: 'unknown', cwd: `${removed} (deleted)` },
  ];
  const closed: string[] = [];
  const effects: DaemonEffects = {
    agents: () => agents, credentials: async () => ({}), snapshot: async () => ({ work, now: new Date(clock).toISOString() }),
    closeSession: pane => { closed.push(pane); }, dispatch: async () => {}, persist: async () => {}, dispatchTick: async () => {},
  };
  await runCycle(config, state, effects, () => clock);
  assert.deepEqual(closed, ['pane-dead']);

  // A Graphyard pane whose worktree still exists stays open even after its runtime exited.
  closed.length = 0;
  agents.splice(0, agents.length, { pane_id: 'pane-dead', agent: null, agent_status: 'unknown', cwd: live });
  await runCycle(config, state, effects, () => clock);
  assert.deepEqual(closed, []);
});
