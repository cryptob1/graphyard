import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpuPressureStep, cpuWaiting, implementationWaiting, trialCapNow } from '../src/daemon/cpu-pressure.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { emptyDaemonState, type DaemonState } from '../src/daemon/state.js';
import { heatReading } from '../src/merge-writer/trial-load.js';
import { masterConfigSchema } from '../src/master.js';

// GY-3532: short turbo spikes are normal on a CPU with a 105C limit. The heat rule compares the
// mean of the package samples over the last 120 s (at least 4 of them) with the 85C limit, not the
// latest sample; with fewer than 4 samples the latest still decides. Since GY-3501 the rule halves
// trials and holds no launch.

const config = masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:9', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/heat', baseBranch: 'main', githubAppId: 1234, hostId: 'heat-host', masterAgentName: 'graphyard-master-heat', workers: [] });
const pressure = 'some avg10=20.00 avg60=20.00 avg300=20.00 total=1\n';
const start = Date.parse('2030-01-01T00:00:00Z');

/** One loop cycle every 10 s reading `celsius[i]`; returns the state after the last. */
async function cycles(celsius: number[]): Promise<DaemonState> {
  const state = emptyDaemonState(config);
  for (const [index, value] of celsius.entries()) {
    const effects = { cpuPressure: async () => ({ pressure, stat: null, celsius: value }) } as unknown as DaemonEffects;
    await cpuPressureStep({ state, effects, now: () => start + index * 10_000, log: () => {} });
  }
  return state;
}

test('unit:heat-uses-average — one 95C sample among 58C samples holds nothing; two minutes of 90C halves trials; with fewer than 4 samples the latest sample decides', async () => {
  // A turbo spike as the latest sample among two minutes of 58C.
  let state = await cycles([...Array(12).fill(58), 95]);
  assert.equal(cpuWaiting(state), null, 'one 95C spike holds no launch');
  assert.equal(implementationWaiting(state), null, 'nor any implementation launch');
  assert.equal(trialCapNow(state, 4), 4, 'and sets no trial cap');
  assert.equal(state.cpuPressure?.celsius, 61, 'the heat rule reads the 120 s mean');

  // Two minutes at 90C: the mean is at the limit, so trials halve and no launch waits, exactly as today.
  state = await cycles(Array(13).fill(90));
  assert.equal(cpuWaiting(state), null, 'a 90C mean holds no launch (GY-3501)');
  assert.equal(trialCapNow(state, 4), 2);
  assert.equal(state.cpuPressure!.samples.length, 12, 'samples older than 120 s drop out');

  // Fewer than 4 samples: the latest sample decides, as before.
  state = await cycles([58, 58, 95]);
  assert.equal(cpuWaiting(state), null, 'a 95C sample holds no launch either');
  assert.equal(trialCapNow(state, 4), 2);

  // The strict heavy-job cap reads the same rule.
  assert.deepEqual(heatReading([[0, 58], [1, 58], [2, 58], [3, 95]]), { latest: 95, mean: 67, celsius: 67 });
  assert.deepEqual(heatReading([[0, 58], [1, 95]]), { latest: 95, mean: null, celsius: 95 });
  assert.equal(heatReading([]), null);
});
