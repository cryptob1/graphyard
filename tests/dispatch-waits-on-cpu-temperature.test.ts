import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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
import { cpuCelsius, trialHalfCelsius } from '../src/daemon/cpu-pressure.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterConfigSchema, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import type { MergePorts } from '../src/merge-writer/executor.js';
import type { Principal, Work } from '../src/model.js';

// Every filed fixture owes an E2E proof (its criterion names this change's own case) and the serve
// declaration its trial needs.
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// GY-3501: a hot CPU sensor never holds a launch. GY-3373's episode — on core (24 cores, 18
// workers) a sensor read 98C with CPU pressure near 20 percent — once made the loop hold every
// launch at the trial guard's own heat limit (GY-3416: min(85C, crit-3)), so ready work idled for
// hours while the hot work ran on. Now the launch hold reads PSI pressure alone; the sensor keeps
// governing only the work that makes the heat: the merge writer's trial cap halves (from 5C under
// the limit) and a trial container waits at its own limit (tests/heat-never-holds-workers.test.ts
// shows the guard). So at 99C, with pressure low, a ready item launches in the first cycle, its
// submitted head is trialled with the cap halved, no waiting line stands, and a running session is
// untouched; below the halving limit the full cap returns. Where no sensor is readable the check
// is skipped. Driven through the loop's own cycle against a temporary control plane, with an
// injected /sys/class/hwmon tree read by the production reader.

const proof = 'integration:dispatch-waits-on-cpu-temperature';
const repository = 'owner/cpu-temperature';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const workerA: Principal = { id: 'worker-a', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, workerA].map(principal => ({ ...principal, token: `cpu-${principal.id}-${'x'.repeat(32)}` }));
const token = (id: string) => credentials.find(credential => credential.id === id)!.token;

let store: Store, http: ReturnType<typeof server>, url: string;
const call = async (bearer: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (bearer: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const result = await call(bearer, method, path, body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const coordinationSnapshot = async () => {
  const response = await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: `Bearer ${token(coordinator.id)}`, 'X-Graphyard-View': 'coordination' } });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ work: Work[]; now: string }>;
};
const reload = async (id: string) => (await coordinationSnapshot()).work.find(item => item.id === id)!;
const file = async (title: string) => ok(token(operator.id), 'POST', 'work', {
  title, why: 'w', simplest: 's', type: 'chore', priority: 1, criteria: [{ id: 'AC-1', text: 'Works', proofs: [proof, 'e2e:dispatch-waits-on-cpu-temperature'] }], policy: { checks: ['test'], review: true },
}) as Promise<Work>;

before(async () => {
  store = await withDatabase('dispatch-waits-on-cpu-temperature');
  await store.init();
  http = server(new Engine(store, 7200, repository), credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); });

/** The two files the production effect reads, as texts an injected reading controls. */
const pressureText = (avg60: number) => `some avg10=${avg60.toFixed(2)} avg60=${avg60.toFixed(2)} avg300=${avg60.toFixed(2)} total=987654321\nfull avg10=1.00 avg60=1.00 avg300=1.00 total=987654321\n`;
/** /proc/stat's aggregate line with `ticks` of idle time added since the first reading and a steal counter of `steal`. */
const statText = (ticks: number, steal: number) => `cpu  100 100 100 ${1000 + ticks} 10 10 10 ${steal} 0 0\ncpu0 100 100 100 ${1000 + ticks} 10 10 10 ${steal} 0 0\n`;

const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const tip = sha('cpu-main-tip');
const gates = (passed: string[]) => ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: passed.includes(name), reasons: passed.includes(name) ? [] : [`${name} refused`] }));
const profile: WorkerProfile = { name: 'w1', principal: workerA.id, agentName: 'agent-w1', mode: 'launch', kind: 'claude', credentialFile: '/outside/w1.token', agentArgs: [], environment: {} } as unknown as WorkerProfile;

let credentialsDirectory: string;
const makeConfig = (): MasterConfig => masterConfigSchema.parse({ version: 1, url, credentialFile: join(credentialsDirectory, 'coordinator.token'), cliPath: '/bin/graphyard',
  repository, baseBranch: 'main', githubAppId: 1234, hostId: 'cpu-host', masterAgentName: 'graphyard-master-cpu', workers: [profile] });

/** The loop's effects over this control plane, with the host reading injected and every launch counted. */
function effects(config: MasterConfig, herdr: { agents: HerdrAgent[] }, reading: () => Promise<{ pressure: string | null; stat: string | null; celsius: number | null } | null>) {
  const seen = { dispatched: [] as string[], trials: 0, closed: [] as string[], ticks: [] as (string | undefined)[] };
  const ports: MergePorts = {
    baseBranch: 'main', now: () => Date.now(), fetch: async () => tip,
    merge: async head => ({ mergeSha: sha(`merge:${head}`), files: ['src/app.ts'] }),
    trial: async () => { seen.trials += 1; return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 10, logTail: '', files: ['tests/item.test.ts'], proofs: { [proof]: { executed: 1, failed: 0 }, 'e2e:dispatch-waits-on-cpu-temperature': { executed: 1, failed: 0 } } }; },
    push: async () => 'pushed', holds: async () => false, record: async () => {},
  };
  const daemon: DaemonEffects = {
    snapshot: coordinationSnapshot,
    agents: () => herdr.agents, herdr: () => ({ agents: herdr.agents, available: true }),
    credentials: async () => ({ w1: { available: true, reason: null } }),
    closeSession: pane => { seen.closed.push(pane); },
    dispatch: async item => { seen.dispatched.push(item.key); return { pane: 'pane-gy1', epoch: 1 }; },
    cpuPressure: reading,
    dispatchTick: async (_snapshot, held) => { seen.ticks.push(held); },
    mergeWriter: { ...ports, parallel: 4, cores: 24 } as MergeWriterReads,
    persist: async () => {},
  };
  return { daemon, seen };
}

/** `graphyard master status` over this fixture's snapshot and daemon state, as the CLI reads it. */
async function status(config: MasterConfig, state: DaemonState) {
  await writeFile(daemonStatePath(config), JSON.stringify(state));
  const root = await temporaryDirectory('cpu-temperature-status');
  execFileSync('git', ['init', '-q', root]);
  const run = async (command: string, args: string[]) =>
    isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [{ name: 'agent-running', pane_id: 'pane-gy2', agent_status: 'working' }] }) : 'Coordinating work.') : `${'b'.repeat(40)}\n`;
  return masterStatusReport(root, config, coordinationSnapshot as () => Promise<any>, run);
}

/** A /sys/class/hwmon tree: a CPU sensor at `celsius` and a hotter non-CPU one the reading ignores. */
async function hwmon(celsius: number | null) {
  const root = await temporaryDirectory('cpu-temperature-hwmon');
  if (celsius !== null) {
    await mkdir(join(root, 'hwmon0'));
    await writeFile(join(root, 'hwmon0', 'name'), 'k10temp\n');
    await writeFile(join(root, 'hwmon0', 'temp1_input'), `${celsius * 1000}\n`);
    await writeFile(join(root, 'hwmon0', 'temp2_input'), `${(celsius - 10) * 1000}\n`);
  }
  await mkdir(join(root, 'hwmon1'));
  await writeFile(join(root, 'hwmon1', 'name'), 'nvme\n');
  await writeFile(join(root, 'hwmon1', 'temp1_input'), '110000\n');
  return root;
}
const calm = (stat: number) => ({ pressure: pressureText(20), stat: statText(stat, 0) });

test(`${proof} — at 99C a ready item launches and its head is trialled with the cap halved, no waiting line stands and a running session is untouched; below the halving limit the full cap returns`, async () => {
  await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
  credentialsDirectory = await temporaryDirectory('cpu-temperature-credentials');
  const config = makeConfig();
  const state = emptyDaemonState(config);
  const herdr = { agents: [{ name: 'agent-running', pane_id: 'pane-gy2', agent: 'claude', agent_status: 'working' }] as HerdrAgent[] };
  const readyItem = await file('Ready');
  await ok(token(operator.id), 'POST', `work/${readyItem.id}/ready`, {});
  const runningItem = await file('Running');
  await ok(token(operator.id), 'POST', `work/${runningItem.id}/ready`, {});
  const claimed = await ok(token(workerA.id), 'POST', `work/${runningItem.id}/claim`, {}) as Work;
  await ok(token(workerA.id), 'POST', `work/${runningItem.id}/session`, { id: `${workerA.id}:${claimed.epoch}`, kind: 'implementation', principal: workerA.id, epoch: claimed.epoch,
    runtime: 'claude', host: config.hostId, pane: 'pane-gy2', agentName: 'agent-running', attach: 'herdr pane attach pane-gy2', subject: 'GY Running: already running', state: 'running' });
  const submitted = await file('Submitted');
  const candidate = { sha: sha('cpu-head'), baseSha: tip, pr: 3, branch: 'graphyard/gy-3-1', author: workerA.id };
  await store.pool.query('UPDATE work_items SET document = document || $1::jsonb WHERE id = $2', [JSON.stringify({
    stage: 'build', ready: true, epoch: 1, submission: { epoch: 1, pr: 3 }, candidate, gates: gates(['ready', 'build', 'review', 'test']),
    observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, baseTip: tip, baseTipContained: true, at: new Date().toISOString() },
  }), submitted.id]);

  // CPU pressure is low throughout (20 percent): the 99C sensor once held every launch; now it holds none.
  // The guard averages the last 120 s, so each reading here is a minute after the last.
  let sensors = await hwmon(99), stat = 0, clock = Date.now();
  const { daemon, seen } = effects(config, herdr, async () => ({ ...calm(stat += 1000), celsius: await cpuCelsius(sensors) }));

  await runCycle(config, state, daemon, () => clock);
  await mergeWriterIdle(state);
  assert.deepEqual(seen.dispatched, [readyItem.key], 'a CPU at 99C launches the ready item');
  assert.ok(seen.trials >= 1, 'a CPU at 99C still trials the submitted head');
  assert.deepEqual(seen.ticks, [undefined], 'no launch waits on the temperature');
  assert.equal(state.cpuPressure?.celsius, 99, 'the hottest CPU sensor is read; a hotter non-CPU sensor is not');
  assert.deepEqual(state.cpuPressure?.trialCap, { now: 2, full: 4 }, 'the merge writer\'s trial cap is halved at 99C');
  let running = (await reload(runningItem.id)).sessions ?? [];
  assert.equal(running.at(-1)?.state, 'running', 'the session already running is untouched');
  assert.ok(!seen.closed.includes('pane-gy2'), 'its pane is never closed');
  let report = await status(config, state);
  assert.equal(report.cpuPressure?.celsius, 99, 'master status carries the hottest sensor');
  assert.equal(report.cpuPressure?.avg60, 20);
  assert.equal(report.cpuPressure?.waiting, null, 'master status shows no waiting line for heat');
  assert.deepEqual(report.cpuPressure?.trialCap, { now: 2, full: 4 }, 'master status shows the halved trial cap');

  sensors = await hwmon(trialHalfCelsius - 1);
  clock += 61_000;
  await runCycle(config, state, daemon, () => clock);
  await mergeWriterIdle(state);
  assert.deepEqual(seen.ticks, [undefined, undefined], 'nothing holds the launches below the limit either');
  assert.deepEqual(state.cpuPressure?.trialCap, { now: 4, full: 4 }, `the full trial cap returns at ${trialHalfCelsius - 1}C`);
  running = (await reload(runningItem.id)).sessions ?? [];
  assert.equal(running.at(-1)?.state, 'running', 'the session already running is untouched once cool too');
  report = await status(config, state);
  assert.equal(report.cpuPressure?.celsius, trialHalfCelsius - 1);
  assert.equal(report.cpuPressure?.waiting, null, 'no waiting line stands');
  assert.deepEqual(report.cpuPressure?.trialCap, { now: 4, full: 4 }, 'master status shows the full cap back');
});

test(`${proof} — with no readable CPU sensor launches proceed`, async () => {
  await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
  credentialsDirectory = await temporaryDirectory('cpu-temperature-missing');
  const config = makeConfig();
  const state = emptyDaemonState(config);
  const readyItem = await file('No sensor');
  await ok(token(operator.id), 'POST', `work/${readyItem.id}/ready`, {});
  const sensors = await hwmon(null);
  const { daemon, seen } = effects(config, { agents: [] }, async () => ({ ...calm(1000), celsius: await cpuCelsius(sensors) }));
  await runCycle(config, state, daemon);
  await mergeWriterIdle(state);
  assert.deepEqual(seen.dispatched, [readyItem.key], 'the check is skipped where no CPU sensor is readable');
  assert.deepEqual(seen.ticks, [undefined]);
  assert.equal(state.cpuPressure?.celsius, null);
  const report = await status(config, state);
  assert.equal(report.cpuPressure?.celsius, null, 'no temperature and no waiting line');
  assert.equal(report.cpuPressure?.waiting, null);
});
