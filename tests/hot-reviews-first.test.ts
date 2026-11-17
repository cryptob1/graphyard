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

// GY-3437: when hot, reviews and trials launch first. While the host sat at 80-85C new
// implementation sessions took every freed slot, so the reviews and trials that would finish work
// (GY-3418 and GY-3419 waited about 5 h) never started and the heat never drained. Now from 80C
// (the 60 s package average) no new implementation session starts while reviews and trials go on;
// at 85C nothing new starts; below 80C implementation launches again; and with free capacity and
// both kinds ready, the cycle's reviews and trials launch before its workers.
//
// The fixture below is GY-3373's: dispatch waits while the CPU is too hot. On core (24 cores, 18 workers) a sensor read
// 98C with CPU pressure near 20 percent: the trial guard refused every container start at 95C while
// the loop, holding launches only on pressure, kept launching agents. Now the loop reads the hottest
// CPU sensor the trial guard reads, and at that guard's own heat limit (GY-3416: min(85C, crit-3),
// so a laptop at 95-98C against a 102C critical is held too) no worker, reviewer or trial starts,
// one master status line names the temperature, and a running session is untouched. Below the
// halving limit the next cycle launches; where no sensor is readable the check is skipped. Driven
// through the loop's own cycle against a temporary control plane, with an injected /sys/class/hwmon
// tree read by the production reader.

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

test(`${proof} — at 82C a review and a queued trial start while the ready implementation item does not; at 86C none start; below 80C implementation launches again`, async () => {
  const { config, state, readyItem } = await fixture();
  // CPU pressure is low throughout (20 percent): only the heat decides. Each reading is a minute after the last, so the 60 s average is that reading.
  let sensors = await hwmon(86), stat = 0, clock = Date.now();
  const { daemon, seen } = effects(config, { agents: [] }, async () => ({ ...calm(stat += 1000), celsius: await cpuCelsius(sensors) }));

  await runCycle(config, state, daemon, () => clock);
  await mergeWriterIdle(state);
  assert.deepEqual(seen.dispatched, [], 'at 86C no implementation session starts');
  assert.equal(seen.trials, 0, 'at 86C no trial starts');
  assert.deepEqual(seen.ticks, ['launches waiting: CPU 86C'], 'at 86C the reviewer launches wait too');
  assert.equal((await status(config, state)).cpuPressure?.waiting, 'launches waiting: CPU 86C');

  sensors = await hwmon(82);
  clock += 61_000;
  await runCycle(config, state, daemon, () => clock);
  await mergeWriterIdle(state);
  assert.equal(state.cpuPressure?.celsius, 82);
  assert.deepEqual(seen.ticks, ['launches waiting: CPU 86C', undefined], 'at 82C the review launches');
  assert.equal(seen.trials, 1, 'at 82C the queued trial starts');
  assert.deepEqual(seen.dispatched, [], 'at 82C the ready implementation item does not start');
  assert.equal((await status(config, state)).cpuPressure?.waiting, 'implementation launches waiting: CPU 82C; reviews and trials go on', 'master status names the implementation hold');

  sensors = await hwmon(79);
  clock += 61_000;
  await runCycle(config, state, daemon, () => clock);
  await mergeWriterIdle(state);
  assert.deepEqual(seen.dispatched, [readyItem.key], 'below 80C implementation launches again');
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
