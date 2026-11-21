import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { daemonStatePath, emptyDaemonState, type DaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { mergeWriterIdle, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { cpuCelsius } from '../src/daemon/cpu-pressure.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterConfigSchema, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import type { MergePorts } from '../src/merge-writer/executor.js';
import type { Principal, Work } from '../src/model.js';

// The filed fixture owes an E2E proof, like any chore: this change's own case (e2e/cases/heat-limit-laptop.json).
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// GY-3416: a laptop's heat limit. The guard once compared each CPU sensor to its own critical
// minus 3 — 102C on a machine whose critical is 105C — so a host at 95-98C was never throttled: no
// launch waited, the host cooked, and other installs on it asked Graphyard to slow down. Now the
// limit is min(85C, crit-3): the trial cap halves from 5C under it and both restore on their own
// once the reading holds below it. GY-3501: the limit no longer holds launches — a hot sensor
// governs only the trials and checks that make the heat. The reading is the hottest package or
// core sensor, so what master status shows matches the hottest sensor. Driven through the loop's
// own cycle against a temporary control plane, with an injected /sys/class/hwmon tree (the
// operator's laptop: package 95C, core 16 at 96C, critical 105C) read by the production reader.

const proof = 'integration:heat-limit-min';
const repository = 'owner/heat-limit';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const worker: Principal = { id: 'worker-a', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, worker].map(principal => ({ ...principal, token: `heat-${principal.id}-${'x'.repeat(32)}` }));
const token = (id: string) => credentials.find(credential => credential.id === id)!.token;

let store: Store, http: ReturnType<typeof server>, url: string;
const ok = async (bearer: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const parsed = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(parsed));
  return parsed;
};
const coordinationSnapshot = async () => {
  const response = await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: `Bearer ${token(coordinator.id)}`, 'X-Graphyard-View': 'coordination' } });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ work: Work[]; now: string }>;
};

before(async () => {
  store = await withDatabase('heat-limit-min');
  await store.init();
  http = server(new Engine(store, 7200, repository), credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); });

const pressureText = (avg60: number) => `some avg10=${avg60.toFixed(2)} avg60=${avg60.toFixed(2)} avg300=${avg60.toFixed(2)} total=987654321\nfull avg10=1.00 avg60=1.00 avg300=1.00 total=9876543\n`;
const statText = (ticks: number) => `cpu  100 100 100 ${1000 + ticks} 10 10 10 0 0 0\ncpu0 100 100 100 ${1000 + ticks} 10 10 10 0 0 0\n`;
const calm = (stat: number) => ({ pressure: pressureText(20), stat: statText(stat) });

const profile: WorkerProfile = { name: 'w1', principal: worker.id, agentName: 'agent-w1', mode: 'launch', kind: 'claude', credentialFile: '/outside/w1.token', agentArgs: [], environment: {} } as unknown as WorkerProfile;
let credentialsDirectory: string;
const makeConfig = (): MasterConfig => masterConfigSchema.parse({ version: 1, url, credentialFile: join(credentialsDirectory, 'coordinator.token'), cliPath: '/bin/graphyard',
  repository, baseBranch: 'main', githubAppId: 1234, hostId: 'heat-host', masterAgentName: 'graphyard-master-heat', workers: [profile] });

/** A laptop's /sys/class/hwmon: a package and a core sensor (crit 105C) and a hotter non-CPU one the reading ignores. */
async function laptopHwmon() {
  const root = await temporaryDirectory('heat-limit-min-hwmon');
  await mkdir(join(root, 'hwmon0'));
  await writeFile(join(root, 'hwmon0', 'name'), 'coretemp\n');
  await writeFile(join(root, 'hwmon0', 'temp1_crit'), '105000\n');   // Package id 0
  await writeFile(join(root, 'hwmon0', 'temp2_crit'), '105000\n');   // Core 16
  await mkdir(join(root, 'hwmon1'));
  await writeFile(join(root, 'hwmon1', 'name'), 'nvme\n');
  await writeFile(join(root, 'hwmon1', 'temp1_input'), '110000\n');
  await heat(root, 95, 96);
  return root;
}
/** Rewrites the two CPU sensors to `packageC` and `coreC`. */
const heat = async (root: string, packageC: number, coreC: number) => {
  await writeFile(join(root, 'hwmon0', 'temp1_input'), `${packageC * 1000}\n`);
  await writeFile(join(root, 'hwmon0', 'temp2_input'), `${coreC * 1000}\n`);
};

/** `graphyard master status` over this fixture's snapshot and daemon state, as the CLI reads it. */
async function status(config: MasterConfig, state: DaemonState) {
  await writeFile(daemonStatePath(config), JSON.stringify(state));
  const root = await temporaryDirectory('heat-limit-min-status');
  execFileSync('git', ['init', '-q', root]);
  const run = async (command: string, args: string[]) =>
    isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : 'Coordinating work.') : `${'b'.repeat(40)}\n`;
  return masterStatusReport(root, config, coordinationSnapshot as () => Promise<any>, run);
}

test(`${proof} — with crit-105C sensors the limit is 85C: at 96C (the hottest package/core reading) the worker launches with the halved trial cap; at 85C and 81C the cap stays halved; below it sustained, the full cap returns`, async () => {
  credentialsDirectory = await temporaryDirectory('heat-limit-min-credentials');
  const config = makeConfig();
  const state = emptyDaemonState(config);
  const readyItem = await ok(token(operator.id), 'POST', 'work', {
    title: 'Ready', why: 'w', simplest: 's', type: 'chore', priority: 1, criteria: [{ id: 'AC-1', text: 'Works', proofs: [proof, 'e2e:heat-limit-laptop'] }], policy: { checks: ['test'], review: true },
  }) as Work;
  await ok(token(operator.id), 'POST', `work/${readyItem.id}/ready`, {});

  // CPU pressure is low throughout (20 percent): only the heat decides.
  const sensors = await laptopHwmon();
  let stat = 0;
  const ticks: (string | undefined)[] = [];
  const dispatched: string[] = [];
  const ports: MergePorts = {
    baseBranch: 'main', now: () => Date.now(), fetch: async () => 'b'.repeat(40),
    merge: async () => { throw new Error('nothing to merge'); }, trial: async () => { throw new Error('nothing to trial'); },
    push: async () => 'pushed', holds: async () => false, record: async () => {},
  };
  const daemon: DaemonEffects = {
    snapshot: coordinationSnapshot, agents: () => [], herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({ w1: { available: true, reason: null } }),
    closeSession: () => {}, dispatch: async item => { dispatched.push(item.key); return { pane: 'pane-gy1', epoch: 1 }; },
    cpuPressure: async () => ({ ...calm(stat += 1000), celsius: await cpuCelsius(sensors) }),
    dispatchTick: async (_snapshot, held) => { ticks.push(held); },
    mergeWriter: { ...ports, parallel: 4, cores: 24 } as MergeWriterReads,
    persist: async () => {},
  };
  // The guard averages the last 120 s, so each cycle here reads a minute after the last.
  let clock = Date.now();
  const cycle = async () => { clock += 61_000; await runCycle(config, state, daemon, () => clock); await mergeWriterIdle(state); };

  // The operator's reading: package 95C, core 96C — over the 85C limit, under the old 102C one.
  await cycle();
  assert.deepEqual(dispatched, [readyItem.key], 'a CPU at 96C launches the worker: heat holds no launch (GY-3501)');
  assert.deepEqual(ticks, [undefined], 'no waiting line names the temperature');
  assert.equal(state.cpuPressure?.celsius, 96, 'the reading is the hottest package or core sensor; the hotter nvme one is ignored');
  assert.deepEqual(state.cpuPressure?.trialCap, { now: 2, full: 4 }, 'the trial cap is halved at 96C');
  let report = await status(config, state);
  assert.equal(report.cpuPressure?.celsius, 96);
  assert.equal(report.cpuPressure?.waiting, null, 'master status shows the hot reading and no launch held');
  assert.deepEqual(report.cpuPressure?.trialCap, { now: 2, full: 4 }, 'master status shows the halved trial cap');

  // Exactly the limit: 85C against a 105C critical — the old guard's 102C never reached this.
  await heat(sensors, 85, 84);
  await cycle();
  assert.deepEqual(ticks, [undefined, undefined], 'at the limit itself no launch waits either');

  // 81C: the trial cap stays halved until the reading drops under 80C.
  await heat(sensors, 81, 80);
  await cycle();
  assert.deepEqual(dispatched, [readyItem.key], 'the reading changes nothing the launches do');
  assert.deepEqual(ticks.at(-1), undefined, 'no waiting line stands at 81C');
  assert.deepEqual(state.cpuPressure?.trialCap, { now: 2, full: 4 }, 'at 81C the trial cap is half');
  report = await status(config, state);
  assert.equal(report.cpuPressure?.waiting, null);

  // Below it sustained: two cycles at 79C give the full cap back.
  await heat(sensors, 79, 78);
  await cycle();
  await cycle();
  assert.deepEqual(state.cpuPressure?.trialCap, { now: 4, full: 4 }, 'the full cap returns once the reading holds below the limit');
  assert.deepEqual(ticks.slice(-2), [undefined, undefined], 'nothing holds the launches');
  report = await status(config, state);
  assert.deepEqual(report.cpuPressure?.trialCap, { now: 4, full: 4 }, 'master status shows the full cap back');
  assert.equal(report.cpuPressure?.waiting, null);
});
