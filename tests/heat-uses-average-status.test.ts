import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { cpuCelsius, cpuPressureStep } from '../src/daemon/cpu-pressure.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { daemonStatePath, emptyDaemonState } from '../src/daemon/state.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterConfigSchema } from '../src/master.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// e2e:heat-uses-average (GY-3532): two minutes of loop cycles over a fixture hwmon whose package
// holds 91C leave master status showing the latest sample beside the 120 s mean, and the waiting
// line names the mean and the limit.

test('e2e:heat-uses-average — master status shows the latest CPU sample and the 120 s mean, and the waiting line names the mean', async () => {
  const sensors = await temporaryDirectory('heat-uses-average-hwmon');
  await mkdir(join(sensors, 'hwmon0'));
  await writeFile(join(sensors, 'hwmon0', 'name'), 'coretemp\n');
  await writeFile(join(sensors, 'hwmon0', 'temp1_label'), 'Package id 0\n');
  const credentials = await temporaryDirectory('heat-uses-average');
  const config = masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:9', credentialFile: join(credentials, 'coordinator.token'), cliPath: '/bin/graphyard',
    repository: 'owner/average', baseBranch: 'main', githubAppId: 1234, hostId: 'average-host', masterAgentName: 'graphyard-master-average', workers: [] });
  const state = emptyDaemonState(config), start = Date.parse('2030-01-01T00:00:00Z');
  const effects = { cpuPressure: async () => ({ pressure: 'some avg10=20.00 avg60=20.00 avg300=20.00 total=1\n', stat: null, celsius: await cpuCelsius(sensors) }) } as unknown as DaemonEffects;

  // Two minutes of cycles ten seconds apart, 90-92C, ending on a 92C sample.
  for (let cycle = 0; cycle <= 12; cycle += 1) {
    await writeFile(join(sensors, 'hwmon0', 'temp1_input'), `${(cycle % 2 ? 90 : 92) * 1000}\n`);
    await cpuPressureStep({ state, effects, now: () => start + cycle * 10_000, log: () => {} });
  }

  await writeFile(daemonStatePath(config), JSON.stringify(state));
  const root = await temporaryDirectory('heat-uses-average-root');
  execFileSync('git', ['init', '-q', root]);
  const snapshot = { work: [], now: new Date(start).toISOString() };
  const run = async (command: string, args: string[]) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'b'.repeat(40)}\n`;
  const report = await masterStatusReport(root, config, async path => { if (path === 'work-snapshot') return snapshot; throw Object.assign(new Error('absent'), { status: 404 }); }, run);
  assert.equal(report.cpuPressure?.latestCelsius, 92, 'master status shows the latest sample');
  assert.equal(report.cpuPressure?.meanCelsius, 91, 'and the 120 s mean');
  assert.equal(report.cpuPressure?.waiting, 'launches waiting: CPU averages 91C over 2 min; limit 85C');
});
