import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { cpuPressureStep, cpuCelsius } from '../src/daemon/cpu-pressure.js';
import { mergeWriterStep, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { daemonStatePath, emptyDaemonState } from '../src/daemon/state.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterConfigSchema } from '../src/master.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { encodeLoopCpu, loopCpu } from '../src/model/loop-presence.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// e2e:heat-limit-laptop (GY-3416): the operator's laptop read package 95C and core 96C against a
// 105C critical while master status showed 64C and nothing throttled — the guard compared each
// sensor to its own crit-3 (102C). With the limit now min(85C, crit-3), one loop cycle over that
// same fixture reads the hottest package or core sensor and halves the merge writer's trial cap;
// since GY-3501 the reading holds no launch. master status shows both, and the loop's
// coordination read carries them to the Workers page (browser-tests/workers-heat-limit.spec.ts
// shows them there).

test('e2e:heat-limit-laptop — with a fixture hwmon reporting package 95C and core 96C against a 105C critical, master status shows the hottest reading and the halved trial cap, and no launch waits', async () => {
  const sensors = await temporaryDirectory('heat-limit-laptop-hwmon');
  await mkdir(join(sensors, 'hwmon0'));
  await writeFile(join(sensors, 'hwmon0', 'name'), 'coretemp\n');
  await writeFile(join(sensors, 'hwmon0', 'temp1_input'), '95000\n');   // Package id 0
  await writeFile(join(sensors, 'hwmon0', 'temp1_crit'), '105000\n');
  await writeFile(join(sensors, 'hwmon0', 'temp2_input'), '96000\n');   // Core 16
  await writeFile(join(sensors, 'hwmon0', 'temp2_crit'), '105000\n');
  await mkdir(join(sensors, 'hwmon1'));
  await writeFile(join(sensors, 'hwmon1', 'name'), 'nvme\n');
  await writeFile(join(sensors, 'hwmon1', 'temp1_input'), '110000\n');

  const credentials = await temporaryDirectory('heat-limit-laptop');
  const config = masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:9', credentialFile: join(credentials, 'coordinator.token'), cliPath: '/bin/graphyard',
    repository: 'owner/laptop', baseBranch: 'main', githubAppId: 1234, hostId: 'laptop-host', masterAgentName: 'graphyard-master-laptop', workers: [] });
  const state = emptyDaemonState(config), now = () => Date.parse('2030-01-01T00:00:00Z'), snapshot = { work: [], now: new Date(now()).toISOString() };
  const ports = { baseBranch: 'main', now, fetch: async () => 'a'.repeat(40), merge: async () => { throw new Error('nothing to merge'); }, trial: async () => { throw new Error('nothing to trial'); },
    push: async () => 'pushed', holds: async () => false, record: async () => {}, parallel: 4, cores: 24 } as unknown as MergeWriterReads;
  const effects = { cpuPressure: async () => ({ pressure: 'some avg10=20.00 avg60=20.00 avg300=20.00 total=1\n', stat: null, celsius: await cpuCelsius(sensors) }), mergeWriter: ports, persist: async () => {} } as unknown as DaemonEffects;

  // The loop's close step reads the host, then its merge writer step runs: one cycle.
  await cpuPressureStep({ state, effects, now, log: () => {} });
  await mergeWriterStep({ state, effects, now, snapshot, performed: [] } as unknown as Cycle);

  await writeFile(daemonStatePath(config), JSON.stringify(state));
  const root = await temporaryDirectory('heat-limit-laptop-root');
  execFileSync('git', ['init', '-q', root]);
  const run = async (command: string, args: string[]) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'b'.repeat(40)}\n`;
  const report = await masterStatusReport(root, config, async path => { if (path === 'work-snapshot') return snapshot; throw Object.assign(new Error('absent'), { status: 404 }); }, run);
  assert.equal(report.cpuPressure?.celsius, 96, 'the reading is the hottest package or core sensor, not the cooler one master status once showed');
  assert.equal(report.cpuPressure?.waiting, null, 'master status shows no launch held by the heat');
  assert.deepEqual(report.cpuPressure?.trialCap, { now: 2, full: 4 }, 'master status shows the trial cap halved');

  // The loop's coordination read carries both to the Workers page.
  const carried = loopCpu(encodeLoopCpu({ avg60: state.cpuPressure!.avg60, steal: state.cpuPressure!.steal, celsius: state.cpuPressure!.celsius, testBudget: state.cpuPressure!.testBudget, trialCap: state.cpuPressure!.trialCap, waiting: false }));
  assert.equal(carried?.celsius, 96);
  assert.deepEqual(carried?.trialCap, { now: 2, full: 4 });
  assert.equal(carried?.waiting, null, 'the read carries no launches-waiting word');
});

