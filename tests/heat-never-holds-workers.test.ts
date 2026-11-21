import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { daemonStatePath, emptyDaemonState, type DaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { mergeWriterIdle, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { stallCauses } from '../src/daemon/stall-alarm.js';
import { cpuCelsius, cpuPressureStep } from '../src/daemon/cpu-pressure.js';
import { trialContainerLaunch } from '../src/merge-writer/trial-container.js';
import { trialHotCelsius, trialStartOrder } from '../src/merge-writer/trial-load.js';
import { masterGuide } from '../src/master/guide.js';
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

// GY-3501: a hot CPU sensor never holds new workers. Holding every launch for heat the workers do
// cause left ready work idle for hours on every install while the hot work ran on. Now the launch
// hold reads PSI pressure alone; the heat rule keeps governing only the work that makes the heat —
// the trial cap halves, the trial container guard waits at its own limit, and heavy checks wait as
// before. The master guide names pressure, never heat, as a launch hold.

const proof = 'integration:heat-never-holds-workers';
const repository = 'owner/heat-never-holds';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const workerA: Principal = { id: 'worker-a', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, workerA].map(principal => ({ ...principal, token: `heat-${principal.id}-${'x'.repeat(32)}` }));
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
  title, why: 'w', simplest: 's', type: 'chore', priority: 1, criteria: [{ id: 'AC-1', text: 'Works', proofs: [proof, 'e2e:cpu-heat-never-holds-workers'] }], policy: { checks: ['test'], review: true },
}) as Promise<Work>;

before(async () => {
  store = await withDatabase('heat-never-holds-workers');
  await store.init();
  http = server(new Engine(store, 7200, repository), credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); });

/** The two files the production effect reads, as texts an injected reading controls. */
const pressureText = (avg60: number) => `some avg10=${avg60.toFixed(2)} avg60=${avg60.toFixed(2)} avg300=${avg60.toFixed(2)} total=987654321\nfull avg10=1.00 avg60=1.00 avg300=1.00 total=987654321\n`;
/** /proc/stat's aggregate line with `ticks` of idle time added since the first reading. */
const statText = (ticks: number) => `cpu  100 100 100 ${1000 + ticks} 10 10 10 0 0 0\ncpu0 100 100 100 ${1000 + ticks} 10 10 10 0 0 0\n`;

const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const tip = sha('heat-main-tip');
const gates = (passed: string[]) => ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: passed.includes(name), reasons: passed.includes(name) ? [] : [`${name} refused`] }));
const profile: WorkerProfile = { name: 'w1', principal: workerA.id, agentName: 'agent-w1', mode: 'launch', kind: 'claude', credentialFile: '/outside/w1.token', agentArgs: [], environment: {} } as unknown as WorkerProfile;

let credentialsDirectory: string;
const makeConfig = (): MasterConfig => masterConfigSchema.parse({ version: 1, url, credentialFile: join(credentialsDirectory, 'coordinator.token'), cliPath: '/bin/graphyard',
  repository, baseBranch: 'main', githubAppId: 1234, hostId: 'heat-host', masterAgentName: 'graphyard-master-heat', workers: [profile] });

/** The loop's effects over this control plane, with the host reading injected and every launch counted. */
function effects(config: MasterConfig, herdr: { agents: HerdrAgent[] }, reading: () => Promise<{ pressure: string | null; stat: string | null; celsius: number | null } | null>) {
  const seen = { dispatched: [] as string[], trials: 0, closed: [] as string[], ticks: [] as (string | undefined)[] };
  const ports: MergePorts = {
    baseBranch: 'main', now: () => Date.now(), fetch: async () => tip,
    merge: async head => ({ mergeSha: sha(`merge:${head}`), files: ['src/app.ts'] }),
    trial: async () => { seen.trials += 1; return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 10, logTail: '', files: ['tests/item.test.ts'], proofs: { [proof]: { executed: 1, failed: 0 }, 'e2e:cpu-heat-never-holds-workers': { executed: 1, failed: 0 } } }; },
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
  const root = await temporaryDirectory('heat-never-holds-status');
  execFileSync('git', ['init', '-q', root]);
  const run = async (command: string, args: string[]) =>
    isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : 'Coordinating work.') : `${'b'.repeat(40)}\n`;
  return masterStatusReport(root, config, coordinationSnapshot as () => Promise<any>, run);
}

/** A /sys/class/hwmon tree: a CPU sensor at `celsius` and a hotter non-CPU one the reading ignores. */
async function hwmon(celsius: number | null) {
  const root = await temporaryDirectory('heat-never-holds-hwmon');
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

test(`${proof} — a sensor at 95C with avg60 20 launches the ready item's worker in the first cycle, holds no launch line, and starts the merge trial with its cap halved`, async () => {
  await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
  credentialsDirectory = await temporaryDirectory('heat-never-holds-credentials');
  const config = makeConfig();
  const state = emptyDaemonState(config);
  const readyItem = await file('Ready');
  await ok(token(operator.id), 'POST', `work/${readyItem.id}/ready`, {});
  const submitted = await file('Submitted');
  const candidate = { sha: sha('heat-head'), baseSha: tip, pr: 3, branch: 'graphyard/gy-3-1', author: workerA.id };
  await store.pool.query('UPDATE work_items SET document = document || $1::jsonb WHERE id = $2', [JSON.stringify({
    stage: 'build', ready: true, epoch: 1, submission: { epoch: 1, pr: 3 }, candidate, gates: gates(['ready', 'build', 'review', 'test']),
    observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, baseTip: tip, baseTipContained: true, at: new Date().toISOString() },
  }), submitted.id]);

  // CPU pressure is low throughout (20 percent): before GY-3501 the 95C sensor held every launch.
  const sensors = await hwmon(95);
  const { daemon, seen } = effects(config, { agents: [] }, async () => ({ pressure: pressureText(20), stat: statText(1000), celsius: await cpuCelsius(sensors) }));

  await runCycle(config, state, daemon);
  await mergeWriterIdle(state);
  assert.deepEqual(seen.dispatched, [readyItem.key], 'a CPU at 95C launches the ready item\'s worker');
  assert.deepEqual(seen.ticks, [undefined], 'no launch waits on the temperature');
  assert.equal(state.cpuPressure?.celsius, 95, 'the hottest CPU sensor is still read');
  assert.deepEqual(state.cpuPressure?.trialCap, { now: 2, full: 4 }, 'the merge writer\'s trial cap is halved at 95C');
  assert.ok(seen.trials >= 1, 'the submitted head is trialled while the sensor reads 95C');
  const report = await status(config, state);
  assert.equal(report.cpuPressure?.waiting, null, 'master status shows no launches-waiting line');
  assert.deepEqual(report.cpuPressure?.trialCap, { now: 2, full: 4 }, 'master status shows the halved trial cap');
});

test(`${proof} — avg60 above the ceiling still holds every launch: at 90 percent no worker and no trial starts, and one line names the pressure`, async () => {
  await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
  credentialsDirectory = await temporaryDirectory('heat-never-holds-pressure');
  const config = makeConfig();
  const state = emptyDaemonState(config);
  const readyItem = await file('Ready');
  await ok(token(operator.id), 'POST', `work/${readyItem.id}/ready`, {});
  const submitted = await file('Submitted');
  const candidate = { sha: sha('heat-pressure-head'), baseSha: tip, pr: 4, branch: 'graphyard/gy-4-1', author: workerA.id };
  await store.pool.query('UPDATE work_items SET document = document || $1::jsonb WHERE id = $2', [JSON.stringify({
    stage: 'build', ready: true, epoch: 1, submission: { epoch: 1, pr: 4 }, candidate, gates: gates(['ready', 'build', 'review', 'test']),
    observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, baseTip: tip, baseTipContained: true, at: new Date().toISOString() },
  }), submitted.id]);

  const sensors = await hwmon(95);
  const { daemon, seen } = effects(config, { agents: [] }, async () => ({ pressure: pressureText(90), stat: statText(1000), celsius: await cpuCelsius(sensors) }));
  await runCycle(config, state, daemon);
  await mergeWriterIdle(state);
  assert.deepEqual(seen.dispatched, [], 'a saturated CPU launches no worker');
  assert.equal(seen.trials, 0, 'a saturated CPU starts no trial');
  assert.deepEqual(seen.ticks, ['launches waiting: CPU pressure 90 percent'], 'one waiting line names the pressure');
  const report = await status(config, state);
  assert.match(report.cpuPressure?.waiting ?? '', /^launches waiting: CPU pressure 90 percent$/, 'master status carries the pressure line');
});

test(`${proof} — the trial container guard still waits on its own heat limit until the reading falls`, async () => {
  const base = await temporaryDirectory('heat-never-holds-launcher', process.cwd());
  const bin = join(base, 'bin'), hwmonRoot = join(base, 'hwmon'), log = join(base, 'docker.log'), dir = join(hwmonRoot, 'hwmon0');
  await mkdir(bin); await mkdir(dir, { recursive: true });
  await writeFile(join(bin, 'docker'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\nexit 0\n`);
  await writeFile(join(bin, 'df'), '#!/bin/sh\necho Avail\necho 100000000000\n');
  await chmod(join(bin, 'docker'), 0o755); await chmod(join(bin, 'df'), 0o755);
  await writeFile(join(dir, 'name'), 'coretemp\n');
  await writeFile(join(dir, 'temp1_input'), '95000\n');
  await writeFile(join(dir, 'temp1_crit'), '105000\n');
  const [program, ...words] = trialContainerLaunch({ image: 'graphyard-trial:local', mounts: [[base, '/scratch', false]], network: 'none',
    load: { slots: join(base, 'slots'), cap: 2, order: trialStartOrder.merge, hotCelsius: trialHotCelsius, floorBytes: 30e9, hwmon: hwmonRoot, pressureBoundSeconds: 600 } });
  const child: ChildProcess = spawn(program!, [...words, 'true'], { cwd: base, env: { PATH: `${bin}:/usr/bin:/bin` }, stdio: ['ignore', 'ignore', 'pipe'] });
  let said = '';
  child.stderr!.on('data', chunk => { said += chunk; });
  const started = async () => (await readFile(log, 'utf8').catch(() => '')).includes(' start ');
  try {
    for (let waited = 0; !(await started()) && !said.includes('waiting'); waited += 50) {
      assert.ok(waited < 15_000, 'the launcher either starts or says it waits');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(await started(), false, 'a trial container does not start at 95C');
    assert.match(said, /waiting: a CPU sensor reads 95C, at or over its 85C limit/);
    // The reading falls below the limit: the same start goes ahead with nobody's help.
    await writeFile(join(dir, 'temp1_input'), '84000\n');
    for (let waited = 0; !(await started()); waited += 50) {
      assert.ok(waited < 15_000, 'the launcher starts once the reading falls');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } finally {
    if (child.exitCode === null) { const gone = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM'); await gone; }
    await rm(base, { recursive: true, force: true });
  }
});

test(`${proof} — a hot sensor is no stall cause and no guide hold: the alarm names another cause, and the guide names pressure alone`, async () => {
  const config = makeConfig();
  const state = emptyDaemonState(config);
  const sensors = await hwmon(96);
  await cpuPressureStep({ state, now: () => Date.now(), log: () => {},
    effects: { cpuPressure: async () => ({ pressure: pressureText(20), stat: statText(1000), celsius: await cpuCelsius(sensors) }) } as unknown as DaemonEffects });
  const ready: Work = { id: 'id-GY-1', key: 'GY-1', title: 'Ready', stage: 'ready', ready: true, epoch: 0, revision: 1, policyRevision: 1, priority: 1, type: 'bug',
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['e2e:fixture'] }], dependencies: [], evidence: [], gates: [], workspaces: [], sessions: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as unknown as Work;
  const causes = stallCauses({ now: Date.now(), open: [ready], ready: [ready], freeSlots: 1, holds: [], state, registry: null, serving: null });
  assert.deepEqual(causes, [`${ready.key} has no actor: ready, with no lease and no session`], 'a hot sensor alone names no launch cause');
  assert.doesNotMatch(causes.join(' '), /heat|85C|Celsius|temperature/i, 'heat is not a stall cause');
  assert.doesNotMatch(masterGuide, /launches waiting on heat/, 'the master guide names no heat launch hold');
  assert.match(masterGuide, /launches waiting on pressure/, 'the master guide names the pressure hold');
});
