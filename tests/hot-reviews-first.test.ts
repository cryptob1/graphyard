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
import { cpuCelsius } from '../src/daemon/cpu-pressure.js';
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

// GY-3437 filed the heat tiers (reviews and trials first from 80C, nothing new at 85C); GY-3501
// deleted them: a hot sensor holds no launch at all, because holding workers for heat they do not
// cause left ready work idle for hours while the hot work ran on. What stays is the ordering
// within a cycle: with free capacity and both kinds ready, the reviews and trials that finish work
// launch before its workers — the fixture is GY-3373's hot host (a sensor at 86C with CPU
// pressure near 20 percent), read through the production reader against a temporary control plane.

const proof = 'integration:hot-reviews-first';
const repository = 'owner/hot-reviews-first';
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
const file = async (title: string) => ok(token(operator.id), 'POST', 'work', {
  title, why: 'w', simplest: 's', type: 'chore', priority: 1, criteria: [{ id: 'AC-1', text: 'Works', proofs: [proof, 'e2e:hot-reviews-first'] }], policy: { checks: ['test'], review: true },
}) as Promise<Work>;

before(async () => {
  store = await withDatabase('hot-reviews-first');
  await store.init();
  http = server(new Engine(store, 7200, repository), credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); });

/** The two files the production effect reads, as texts an injected reading controls. */
const pressureText = (avg60: number) => `some avg10=${avg60.toFixed(2)} avg60=${avg60.toFixed(2)} avg300=${avg60.toFixed(2)} total=987654321\nfull avg10=1.00 avg60=1.00 avg300=1.00 total=9876543\n`;
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
  const seen = { dispatched: [] as string[], trials: 0, closed: [] as string[], ticks: [] as (string | undefined)[], order: [] as string[] };
  const ports: MergePorts = {
    baseBranch: 'main', now: () => Date.now(), fetch: async () => tip,
    merge: async head => ({ mergeSha: sha(`merge:${head}`), files: ['src/app.ts'] }),
    trial: async () => { seen.trials += 1; return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 10, logTail: '', files: ['tests/item.test.ts'], proofs: { [proof]: { executed: 1, failed: 0 }, 'e2e:hot-reviews-first': { executed: 1, failed: 0 } } }; },
    push: async () => 'pushed', holds: async () => false, record: async () => {},
  };
  const daemon: DaemonEffects = {
    snapshot: coordinationSnapshot,
    agents: () => herdr.agents, herdr: () => ({ agents: herdr.agents, available: true }),
    credentials: async () => ({ w1: { available: true, reason: null } }),
    closeSession: pane => { seen.closed.push(pane); },
    dispatch: async item => { seen.dispatched.push(item.key); seen.order.push('implementation'); return { pane: 'pane-gy1', epoch: 1 }; },
    cpuPressure: reading,
    dispatchTick: async (_snapshot, held) => { seen.ticks.push(held); if (!held) seen.order.push('review'); },
    mergeWriter: ports as MergeWriterReads,
    // A trial's launch is the merge flight the merge writer persists for it; the container start follows inside the flight.
    persist: async state => { if (state.mergeWriter.inFlights?.length && !seen.order.includes('trial')) seen.order.push('trial'); },
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

/** A ready implementation item, and a submitted head whose review is owed and whose trial is queued. */
async function fixture() {
  await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
  credentialsDirectory = await temporaryDirectory('hot-reviews-first-credentials');
  const config = makeConfig();
  const state = emptyDaemonState(config);
  const readyItem = await file('Ready');
  await ok(token(operator.id), 'POST', `work/${readyItem.id}/ready`, {});
  const submitted = await file('Submitted');
  const candidate = { sha: sha('hot-head'), baseSha: tip, pr: 3, branch: 'graphyard/gy-3-1', author: workerA.id };
  await store.pool.query('UPDATE work_items SET document = document || $1::jsonb WHERE id = $2', [JSON.stringify({
    stage: 'build', ready: true, epoch: 1, submission: { epoch: 1, pr: 3 }, candidate, gates: gates(['ready', 'build', 'review', 'test']),
    observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, baseTip: tip, baseTipContained: true, at: new Date().toISOString() },
  }), submitted.id]);
  return { config, state, readyItem };
}

test(`${proof} — at 86C the worker, the review and the queued trial all launch in one cycle, no waiting line stands, and below 80C the same`, async () => {
  const { config, state, readyItem } = await fixture();
  // CPU pressure is low throughout (20 percent): the heat decides nothing anymore. Each reading is a minute after the last, so the 120 s average is that reading.
  let sensors = await hwmon(86), stat = 0, clock = Date.now();
  const { daemon, seen } = effects(config, { agents: [] }, async () => ({ ...calm(stat += 1000), celsius: await cpuCelsius(sensors) }));

  await runCycle(config, state, daemon, () => clock);
  await mergeWriterIdle(state);
  assert.deepEqual(seen.dispatched, [readyItem.key], 'at 86C the implementation session starts: heat holds no worker');
  assert.equal(seen.trials, 1, 'at 86C the queued trial starts');
  assert.deepEqual(seen.order, ['review', 'trial', 'implementation'], 'the review and the trial launch before the worker, hot or not');
  assert.deepEqual(seen.ticks, [undefined], 'no launch waits at 86C');
  assert.equal(state.cpuPressure?.celsius, 86);
  assert.equal((await status(config, state)).cpuPressure?.waiting, null, 'master status shows no waiting line');

  const readyLater = await file('Ready later');
  await ok(token(operator.id), 'POST', `work/${readyLater.id}/ready`, {});
  sensors = await hwmon(79);
  clock += 61_000;
  await runCycle(config, state, daemon, () => clock);
  await mergeWriterIdle(state);
  assert.deepEqual(seen.dispatched, [readyItem.key, readyLater.key], 'below 80C implementation launches again, exactly the same');
  assert.deepEqual(seen.ticks, [undefined, undefined]);
  assert.equal((await status(config, state)).cpuPressure?.waiting, null);
});

test(`${proof} — with free slots and both kinds ready, the review and the trial launch before the implementation session`, async () => {
  const { config, state, readyItem } = await fixture();
  const sensors = await hwmon(60);
  const { daemon, seen } = effects(config, { agents: [] }, async () => ({ ...calm(1000), celsius: await cpuCelsius(sensors) }));
  await runCycle(config, state, daemon);
  await mergeWriterIdle(state);
  assert.deepEqual(seen.dispatched, [readyItem.key]);
  assert.deepEqual(seen.order, ['review', 'trial', 'implementation'], 'reviews and trials take free capacity first');
});
