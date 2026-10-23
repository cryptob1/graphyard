import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T00:00:00Z');

test('unit:failed-step-logs-and-retries — a loop step that throws is one log line naming the step and the error; the cycle runs its other steps and the step runs again next cycle, with nothing recorded', async () => {
  const directory = await temporaryDirectory('failed-step');
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const state = emptyDaemonState(config);
  let cycle = 0;
  const sweeps = [0, 0], ticks = [0, 0];
  const effects: DaemonEffects = {
    agents: () => [],
    credentials: async () => ({}),
    snapshot: async () => ({ work: [], now: new Date(clock).toISOString() }),
    closeSession: () => {},
    dispatch: async () => {},
    persist: async () => {},
    // The close step ends with the checkout sweep, and the first sweep of all throws.
    sweepCheckouts: async () => { if (++sweeps[cycle] === 1 && cycle === 0) throw new Error('checkout sweep refused'); },
    dispatchTick: async () => { ticks[cycle]++; },
  };
  const lines: string[][] = [[], []];
  for (cycle = 0; cycle < 2; cycle++) await runCycle(config, state, effects, () => clock, undefined, line => lines[cycle].push(line));

  assert.deepEqual(lines[0], ['[graphyard-master] cycle 0: the close step failed and runs again next cycle: checkout sweep refused']);
  assert.equal(ticks[0], 1, 'the steps after the failed one still ran in its cycle');
  assert.equal(sweeps[1], 1, 'the next cycle runs the close step again');
  assert.deepEqual(lines[1], [], 'the step that answered logs nothing');
  assert.equal(state.cycle, 2);
  // Nothing is classified, remedied, blocked, decided or escalated: no record of the failure exists beyond the log line.
  assert.ok(!Object.values(state.actions).some(action => action.detail.includes('checkout sweep refused')), 'no action row records the failure');
  assert.ok(!Object.values(state.actions).some(action => ['blocker', 'judgement', 'attention', 'fault'].includes(action.kind)));
  for (const retired of ['faults', 'doctor', 'stepStalls', 'dispatchFailures']) assert.ok(!(retired in state), `the cursor keeps no ${retired}`);
  assert.equal(state.failures.consecutive, 0, 'a failed step is no failed cycle');
});
