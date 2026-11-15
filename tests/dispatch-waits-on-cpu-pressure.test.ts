import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { daemonStatePath, emptyDaemonState, type DaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { mergeWriterIdle, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
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

// GY-3348: dispatch waits while the host CPU is saturated. The loop reads /proc/pressure/cpu before
// launching anything new: while 'some avg60' is above the one ceiling no worker, reviewer or trial
// starts, one status line names the figure, and a session already running is untouched — the
// rexera episode (avg60 94 with heavy steal) had every trial time out into rework instead. Below
// the ceiling the next cycle launches on its own, and where the pressure file is missing (not
// Linux) the check is skipped entirely. Driven through the loop's own cycle against a temporary
// control plane, with the host reading injected exactly as the production effect reads /proc.

const proof = 'integration:dispatch-waits-on-cpu-pressure';
const repository = 'owner/cpu-pressure';
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
  title, type: 'chore', priority: 1, criteria: [{ id: 'AC-1', text: 'Works', proofs: [proof, 'e2e:dispatch-waits-on-cpu-pressure'] }], policy: { checks: ['test'], review: true },
}) as Promise<Work>;

before(async () => {
  store = await withDatabase('dispatch-waits-on-cpu-pressure');
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
function effects(config: MasterConfig, herdr: { agents: HerdrAgent[] }, reading: () => Promise<{ pressure: string; stat: string | null } | null>) {
  const seen = { dispatched: [] as string[], trials: 0, closed: [] as string[], ticks: [] as (string | undefined)[] };
  const ports: MergePorts = {
    baseBranch: 'main', now: () => Date.now(), fetch: async () => tip,
    merge: async head => ({ mergeSha: sha(`merge:${head}`), files: ['src/app.ts'] }),
    trial: async () => { seen.trials += 1; return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 10, logTail: '', files: ['tests/item.test.ts'], proofs: { [proof]: { executed: 1, failed: 0 }, 'e2e:dispatch-waits-on-cpu-pressure': { executed: 1, failed: 0 } } }; },
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
    mergeWriter: ports as MergeWriterReads,
    persist: async () => {},
  };
  return { daemon, seen };
}

/** `graphyard master status` over this fixture's snapshot and daemon state, as the CLI reads it. */
async function status(config: MasterConfig, state: DaemonState) {
  await writeFile(daemonStatePath(config), JSON.stringify(state));
  const root = await temporaryDirectory('cpu-pressure-status');
  execFileSync('git', ['init', '-q', root]);
  const run = async (command: string, args: string[]) =>
    isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [{ name: 'agent-running', pane_id: 'pane-gy2', agent_status: 'working' }] }) : 'Coordinating work.') : `${'b'.repeat(40)}\n`;
  return masterStatusReport(root, config, coordinationSnapshot as () => Promise<any>, run);
}

test(`${proof} — at avg60 90 a ready item gets no launch, no trial and no reviewer or producer session, master status shows one waiting line with the figure, and a session already running is untouched; at avg60 60 the next cycle launches it`, async () => {
  await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
  credentialsDirectory = await temporaryDirectory('cpu-pressure-credentials');
  const config = makeConfig();
  const state = emptyDaemonState(config);
  const herdr = { agents: [{ name: 'agent-running', pane_id: 'pane-gy2', agent: 'claude', agent_status: 'working' }] as HerdrAgent[] };
  // One ready item waiting for its worker, one already running (claimed, its session recorded), one submitted head a trial owes.
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

  let reading: { pressure: string; stat: string | null } | null = { pressure: pressureText(90), stat: statText(0, 50) };
  const { daemon, seen } = effects(config, herdr, () => Promise.resolve(reading));

  // One cycle at avg60 90: nothing new starts, and the saturation is one waiting line with the figure.
  await runCycle(config, state, daemon);
  await mergeWriterIdle(state);
  assert.deepEqual(seen.dispatched, [], 'a saturated CPU launches no worker');
  assert.equal(seen.trials, 0, 'a saturated CPU starts no trial');
  assert.deepEqual(seen.ticks, ['launches waiting: CPU pressure 90 percent'], 'the dispatcher holds its reviewer and producer launches on the same line');
  assert.equal(state.cpuPressure?.avg60, 90, 'the reading is kept on the cursor');
  assert.equal(state.cpuPressure?.steal, null, 'a first reading has no steal delta yet');
  let running = (await reload(runningItem.id)).sessions ?? [];
  assert.equal(running.at(-1)?.state, 'running', 'the session already running is untouched');
  assert.ok(!seen.closed.includes('pane-gy2'), 'its pane is never closed');
  let report = await status(config, state);
  assert.equal(report.cpuPressure?.avg60, 90);
  assert.equal(report.cpuPressure?.steal, null);
  assert.match(report.cpuPressure?.waiting ?? '', /^launches waiting: CPU pressure 90 percent$/, 'master status shows one waiting line with the figure');

  // The next cycle at avg60 60: the worker launches, the trial flies, the hold is gone — and the running session is untouched still.
  reading = { pressure: pressureText(60), stat: statText(990, 60) };
  await runCycle(config, state, daemon);
  await mergeWriterIdle(state);
  assert.deepEqual(seen.dispatched, [readyItem.key], 'the ready item launches the first cycle below the ceiling');
  assert.ok(seen.trials >= 1, 'the submitted head is trialled the first cycle below the ceiling');
  assert.deepEqual(seen.ticks, ['launches waiting: CPU pressure 90 percent', undefined], 'the dispatcher launches again');
  assert.equal(state.cpuPressure?.avg60, 60);
  assert.equal(state.cpuPressure?.steal, 1, 'steal percent is measured between the cycles\' /proc/stat readings (10 of 1000 ticks)');
  running = (await reload(runningItem.id)).sessions ?? [];
  assert.equal(running.at(-1)?.state, 'running', 'the session already running is untouched below the ceiling too');
  assert.ok(!seen.closed.includes('pane-gy2'));
  report = await status(config, state);
  assert.equal(report.cpuPressure?.waiting, null, 'below the ceiling no waiting line stands');
  assert.equal(report.cpuPressure?.avg60, 60);
});

test(`${proof} — a missing pressure file (not Linux) launches normally and holds nothing`, async () => {
  await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
  credentialsDirectory = await temporaryDirectory('cpu-pressure-missing');
  const config = makeConfig();
  const state = emptyDaemonState(config);
  const readyItem = await file('Missing');
  await ok(token(operator.id), 'POST', `work/${readyItem.id}/ready`, {});
  const { daemon, seen } = effects(config, { agents: [] }, () => Promise.resolve(null));
  await runCycle(config, state, daemon);
  await mergeWriterIdle(state);
  assert.deepEqual(seen.dispatched, [readyItem.key], 'the check is skipped where the file is missing');
  assert.deepEqual(seen.ticks, [undefined]);
  assert.equal(state.cpuPressure, null);
  const report = await status(config, state);
  assert.equal(report.cpuPressure, null, 'no figures and no waiting line');
});
