import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { cpuCelsius, cpuPressureStep } from '../src/daemon/cpu-pressure.js';
import { mergeWriterStep, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { daemonStatePath, emptyDaemonState } from '../src/daemon/state.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterConfigSchema } from '../src/master.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// e2e:heat-guard-ignores-spikes (GY-3426): a core sensor spikes to 99C for one reading whenever
// something starts while the package stays near 61C. A minute of loop cycles over that fixture
// hwmon leaves master status showing the averaged package temperature, the full trial cap and no
// launches waiting — where GY-3416's guard showed "launches waiting: CPU 99C".

test('e2e:heat-guard-ignores-spikes — with a fixture hwmon whose core spikes briefly while the package stays cool, master status shows the averaged package temperature and no launches waiting', async () => {
  const sensors = await temporaryDirectory('heat-guard-spikes-hwmon');
  await mkdir(join(sensors, 'hwmon0'));
  await writeFile(join(sensors, 'hwmon0', 'name'), 'coretemp\n');
  await writeFile(join(sensors, 'hwmon0', 'temp1_label'), 'Package id 0\n');
  await writeFile(join(sensors, 'hwmon0', 'temp2_label'), 'Core 0\n');
  const heat = async (packageC: number, coreC: number) => {
    await writeFile(join(sensors, 'hwmon0', 'temp1_input'), `${packageC * 1000}\n`);
    await writeFile(join(sensors, 'hwmon0', 'temp2_input'), `${coreC * 1000}\n`);
  };

  const credentials = await temporaryDirectory('heat-guard-spikes');
  const config = masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:9', credentialFile: join(credentials, 'coordinator.token'), cliPath: '/bin/graphyard',
    repository: 'owner/spikes', baseBranch: 'main', githubAppId: 1234, hostId: 'spike-host', masterAgentName: 'graphyard-master-spikes', workers: [] });
  const state = emptyDaemonState(config), start = Date.parse('2030-01-01T00:00:00Z');
  let clock = start;
  const now = () => clock, snapshot = { work: [], now: new Date(start).toISOString() };
  const ports = { baseBranch: 'main', now, fetch: async () => 'a'.repeat(40), merge: async () => { throw new Error('nothing to merge'); }, trial: async () => { throw new Error('nothing to trial'); },
    push: async () => 'pushed', holds: async () => false, record: async () => {}, parallel: 4, cores: 24 } as unknown as MergeWriterReads;
  const effects = { cpuPressure: async () => ({ pressure: 'some avg10=20.00 avg60=20.00 avg300=20.00 total=1\n', stat: null, celsius: await cpuCelsius(sensors) }), mergeWriter: ports, persist: async () => {} } as unknown as DaemonEffects;

  // A minute of cycles five seconds apart; the core spikes to 99C on the last one, as a launch does.
  for (let cycle = 0; cycle <= 12; cycle += 1) {
    clock = start + cycle * 5_000;
    await heat(cycle % 2 ? 62 : 60, cycle === 12 ? 99 : 58);
    await cpuPressureStep({ state, effects, now, log: () => {} });
    await mergeWriterStep({ state, effects, now, snapshot: { ...snapshot, now: new Date(clock).toISOString() }, performed: [] } as unknown as Cycle);
  }

  await writeFile(daemonStatePath(config), JSON.stringify(state));
  const root = await temporaryDirectory('heat-guard-spikes-root');
  execFileSync('git', ['init', '-q', root]);
  const run = async (command: string, args: string[]) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'b'.repeat(40)}\n`;
  const report = await masterStatusReport(root, config, async path => { if (path === 'work-snapshot') return snapshot; throw Object.assign(new Error('absent'), { status: 404 }); }, run);
  assert.equal(report.cpuPressure?.celsius, 61, 'master status shows the package sensor averaged over 60 s, not the core\'s 99C spike');
  assert.equal(report.cpuPressure?.waiting, null, 'no launches wait');
  assert.deepEqual(report.cpuPressure?.trialCap, { now: 4, full: 4 }, 'the trial cap stays full');
});
