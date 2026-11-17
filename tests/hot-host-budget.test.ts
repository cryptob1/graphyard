import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { cpuPressureStep } from '../src/daemon/cpu-pressure.js';
import { mergeWriterStep, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { daemonStatePath, emptyDaemonState } from '../src/daemon/state.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterConfigSchema } from '../src/master.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { encodeLoopCpu, loopCpu } from '../src/model/loop-presence.js';
import { clearRuns, registerRun } from '../src/runner/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3401 (e2e:hot-host-budget): with a hot CPU reading and three sessions running, the loop's
// cycle records the test budget a session launched now gets and the merge writer's trial cap,
// halved while hot; master status shows both, and the loop's coordination read carries them to the
// Workers page (browser-tests/workers-cpu-figures.spec.ts shows them there).

after(() => clearRuns());

test('e2e:hot-host-budget — at 96C with three sessions running, master status shows the per-session test budget and the halved trial cap', async () => {
  clearRuns();
  for (let index = 0; index < 3; index++) registerRun({ name: `running-${index}`, role: 'worker', work: `GY-${index}`, subject: 'running', run: {
    id: `run-${index}`, events: [], onEvent: () => () => {}, cancel: () => {}, result: async () => ({ ok: false as const, failure: { reason: 'no-payload' as const, detail: 'fixture' }, payloads: [] }),
  } as never });
  const credentials = await temporaryDirectory('hot-host-budget');
  const config = masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:9', credentialFile: join(credentials, 'coordinator.token'), cliPath: '/bin/graphyard',
    repository: 'owner/hot-host', baseBranch: 'main', githubAppId: 1234, hostId: 'hot-host', masterAgentName: 'graphyard-master-hot', workers: [] });
  const state = emptyDaemonState(config), now = () => Date.parse('2030-01-01T00:00:00Z'), snapshot = { work: [], now: new Date(now()).toISOString() };
  const ports = { baseBranch: 'main', now, fetch: async () => 'a'.repeat(40), merge: async () => { throw new Error('nothing to merge'); }, trial: async () => { throw new Error('nothing to trial'); },
    push: async () => 'pushed', holds: async () => false, record: async () => {}, parallel: 4, cores: 24 } as unknown as MergeWriterReads;
  const effects = { cpuPressure: async () => ({ pressure: 'some avg10=20.00 avg60=20.00 avg300=20.00 total=1\n', stat: null, celsius: 96 }), mergeWriter: ports, persist: async () => {} } as unknown as DaemonEffects;

  // The loop's close step reads the host, then its merge writer step runs: one cycle.
  await cpuPressureStep({ state, effects, now, log: () => {} });
  await mergeWriterStep({ state, effects, now, snapshot, performed: [] } as unknown as Cycle);
  const budget = Math.max(2, Math.floor(availableParallelism() / 3));

  await writeFile(daemonStatePath(config), JSON.stringify(state));
  const root = await temporaryDirectory('hot-host-budget-root');
  execFileSync('git', ['init', '-q', root]);
  const run = async (command: string, args: string[]) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'b'.repeat(40)}\n`;
  const report = await masterStatusReport(root, config, async path => { if (path === 'work-snapshot') return snapshot; throw Object.assign(new Error('absent'), { status: 404 }); }, run);
  assert.equal(report.cpuPressure?.celsius, 96);
  assert.equal(report.cpuPressure?.testBudget, budget, 'master status shows the test budget a session launched now gets');
  assert.deepEqual(report.cpuPressure?.trialCap, { now: 2, full: 4 }, 'master status shows the trial cap halved while hot');

  // The loop's coordination read carries both to the Workers page.
  const carried = loopCpu(encodeLoopCpu({ avg60: state.cpuPressure!.avg60, steal: state.cpuPressure!.steal, celsius: state.cpuPressure!.celsius, testBudget: state.cpuPressure!.testBudget, trialCap: state.cpuPressure!.trialCap }));
  assert.equal(carried?.testBudget, budget);
  assert.deepEqual(carried?.trialCap, { now: 2, full: 4 });
});
