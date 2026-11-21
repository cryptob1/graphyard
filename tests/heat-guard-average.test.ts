import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { cpuCelsius, cpuPressureStep, cpuWaiting, trialCapNow } from '../src/daemon/cpu-pressure.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { emptyDaemonState, type DaemonState } from '../src/daemon/state.js';
import { masterConfigSchema } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3426: since GY-3416 nearly every launch waited ("launches waiting: CPU 98C") because one core
// spikes to 95-100C for a second whenever anything starts, while the host idled at 60C. The guard
// now reads the package sensor (the hottest core only where none exists), averaged over the cycles
// of the last 60 s; the 85C limit and the 80C trial halving stay as GY-3416 set them, and since
// GY-3501 the reading never holds a launch — only the trial cap. Each cycle here reads a real
// fixture hwmon tree through the production reader, ten seconds apart (GY-3532: the window is now 120 s).

const proof = 'integration:heat-guard-average';
const pressure = 'some avg10=20.00 avg60=20.00 avg300=20.00 total=1\n';

/** A coretemp hwmon: a labelled package sensor (unless `packageC` is null) and two cores. */
async function hwmon(root: string, packageC: number | null, cores: [number, number]) {
  await rm(join(root, 'hwmon0'), { recursive: true, force: true });
  await mkdir(join(root, 'hwmon0'), { recursive: true });
  await writeFile(join(root, 'hwmon0', 'name'), 'coretemp\n');
  if (packageC !== null) {
    await writeFile(join(root, 'hwmon0', 'temp1_label'), 'Package id 0\n');
    await writeFile(join(root, 'hwmon0', 'temp1_input'), `${packageC * 1000}\n`);
  }
  for (const [index, celsius] of cores.entries()) {
    await writeFile(join(root, 'hwmon0', `temp${index + 2}_label`), `Core ${index}\n`);
    await writeFile(join(root, 'hwmon0', `temp${index + 2}_input`), `${celsius * 1000}\n`);
  }
}

/** Thirteen cycles over 120 s (GY-3532: the heat window), each reading `at(i)`'s sensors; returns the state after the last. */
async function minute(at: (cycle: number) => [number | null, [number, number]]): Promise<DaemonState> {
  const sensors = await temporaryDirectory('heat-guard-average-hwmon');
  const config = masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:9', credentialFile: join(sensors, 'coordinator.token'), cliPath: '/bin/graphyard',
    repository: 'owner/heat', baseBranch: 'main', githubAppId: 1234, hostId: 'heat-host', masterAgentName: 'graphyard-master-heat', workers: [] });
  const state = emptyDaemonState(config);
  const effects = { cpuPressure: async () => ({ pressure, stat: null, celsius: await cpuCelsius(sensors) }) } as unknown as DaemonEffects;
  for (let cycle = 0; cycle <= 12; cycle += 1) {
    await hwmon(sensors, ...at(cycle));
    await cpuPressureStep({ state, effects, now: () => Date.parse('2030-01-01T00:00:00Z') + cycle * 10_000, log: () => {} });
  }
  return state;
}

test(`${proof} — one core's single 100C sample under a 62C package keeps the full trial cap; a package average at 85C halves trials and holds no launch, at 80C halves them too; with no package sensor the hottest core average decides`, async () => {
  // The operator's host: one core spikes to 100C for one sample while the package holds 62C.
  let state = await minute(cycle => [cycle === 12 ? 63 : 62, [cycle === 12 ? 100 : 60, 58]]);
  assert.equal(state.cpuPressure?.celsius, 62, 'the reading is the package sensor averaged over 120 s, not one core\'s instant spike');
  assert.equal(cpuWaiting(state), null, 'no launch waits');
  assert.equal(trialCapNow(state, 4), 4, 'the trial cap stays full');

  // A package that holds 85C on average over the minute: trials halve, no launch waits (GY-3501).
  state = await minute(cycle => [cycle % 2 ? 84 : 86, [70, 70]]);
  assert.equal(state.cpuPressure?.celsius, 85);
  assert.equal(cpuWaiting(state), null, 'a package average at the limit holds no launch');
  assert.equal(trialCapNow(state, 4), 2);

  // 80C on average: trials halve.
  state = await minute(() => [80, [70, 70]]);
  assert.equal(cpuWaiting(state), null, 'no launch waits');
  assert.equal(trialCapNow(state, 4), 2, 'a package average at 80C halves trials');

  // No package sensor: the hottest core, averaged — one 100C sample among 70C ones halves nothing.
  state = await minute(cycle => [null, [cycle === 6 ? 100 : 70, 65]]);
  assert.equal(state.cpuPressure?.celsius, 73, 'the hottest core average stands in for the package');
  assert.equal(cpuWaiting(state), null);
  assert.equal(trialCapNow(state, 4), 4);
  state = await minute(() => [null, [88, 65]]);
  assert.equal(cpuWaiting(state), null, 'a hot core average holds no launch either');
  assert.equal(trialCapNow(state, 4), 2, 'a hot core average halves trials where no package sensor exists');

  // Readings older than 120 s drop out of the average.
  assert.equal(state.cpuPressure!.samples.length, 12, 'the reading from 120 s ago has dropped out');
});
