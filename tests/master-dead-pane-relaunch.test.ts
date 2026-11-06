import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDaemonState, masterSummary } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const clock = Date.parse('2026-10-24T07:00:00Z');
const MASTER = 'graphyard-master-project';

test('unit:tests/master-dead-pane-relaunch.test.ts — a master pane reported as a bare shell on two consecutive cycles ends the session and relaunches; one miss does not', async () => {
  const directory = await temporaryDirectory('master-dead-pane');
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: `${directory}/coordinator.token`, cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: MASTER, workers: [] });
  const state = emptyDaemonState(config);
  state.master = { ...state.master, agentName: MASTER, pane: 'pM', runtime: 'claude', account: 'a', session: 'session-a', startedAt: new Date(clock - 3_600_000).toISOString() };
  let agents: { name: string; pane_id: string; agent: string | null; agent_status: string }[] = [{ name: MASTER, pane_id: 'pM', agent: null, agent_status: 'unknown' }];
  const closed: string[] = [], ended: string[] = [], launched: string[] = [];
  const effects: DaemonEffects = {
    snapshot: async () => ({ work: [], now: new Date(clock).toISOString() }),
    agents: () => agents, herdr: () => ({ agents, available: true }),
    credentials: async () => ({}),
    closeSession: pane => { closed.push(pane); },
    dispatch: async () => { throw new Error('no dispatch'); },
    sessionScreen: async () => '$ ',
    masterSession: {
      launch: async () => { launched.push('x'); return { agentName: MASTER, pane: 'pN', runtime: 'claude', account: 'a', session: 'session-b' }; },
      end: async session => { ended.push(session); },
    },
    persist: async () => {},
  };
  assert.equal(masterSummary(state.master, clock, agents[0]).state, 'no agent', 'status never reports a bare shell as working');
  await runCycle(config, state, effects, () => clock);
  assert.deepEqual([closed, ended, launched.length], [[], [], 0], 'one miss changes nothing');
  agents = [{ name: MASTER, pane_id: 'pM', agent: 'claude', agent_status: 'working' }];
  await runCycle(config, state, effects, () => clock);
  assert.equal(state.master.misses, 0, 'a seen agent clears the miss');
  agents = [{ name: MASTER, pane_id: 'pM', agent: null, agent_status: 'unknown' }];
  await runCycle(config, state, effects, () => clock);
  assert.equal(launched.length, 0, 'misses must be consecutive');
  await runCycle(config, state, effects, () => clock);
  assert.deepEqual(closed, ['pM']);
  assert.deepEqual(ended, ['session-a']);
  assert.equal(launched.length, 1, 'the second consecutive miss relaunches');
});
