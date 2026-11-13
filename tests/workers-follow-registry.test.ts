import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { Engine } from '../src/engine.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { workersCommand } from '../src/cli/master-registry.js';
import { runCycle } from '../src/daemon/cycle.js';
import { daemonEffects } from '../src/daemon/effects-production.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { loadMasterConfig, saveWorkerProfile, setupMaster } from '../src/master/config.js';
import { dispatchWork, prepareWorkerLaunch, workerCommand } from '../src/master/dispatch.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { spawnHeadless } from '../src/headless-session.js';
import { liveRuns } from '../src/runner/registry.js';
import type { Principal, Work } from '../src/model.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';

// GY-3285: an install runs as many workers as its registry's worker role allows. The real control
// plane, agent registry, loop cycle, CLI claim/worktree/watch and headless dispatch; the only
// substitute is each runtime's model executable, which waits until released and then commits and
// submits its head under its own lease.
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const worker: Principal = { id: 'worker-a', role: 'worker' };
const token = (principal: Principal) => `${principal.id}-token-${'x'.repeat(32)}`;
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const accounts = ['claude', 'codex', 'muse'];
let store: Store, http: ReturnType<typeof server>, registry: AgentRegistry;
let root: string, scratch: string, bin: string, url: string;
const homes = new Map<string, string>();

before(async () => {
  store = await withDatabase('workers-follow-registry'); await store.init();
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  scratch = await temporaryDirectory('workers-follow-registry', join(process.cwd(), '.graphyard'));
  root = await temporaryDirectory('coordinator', scratch);
  bin = await temporaryDirectory('bin', scratch);
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = gitRunnerFor(root);
  http = server(engine, [coordinator, worker].map(principal => ({ ...principal, token: token(principal) })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main'); git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'Fixture.\n');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const credentials = await temporaryDirectory('credentials', scratch);
  await setupMaster(root, { url, token: token(coordinator), cliPath: launcher, credentialDirectory: credentials, run: { worktreeRoot: await temporaryDirectory('checkouts', scratch) } });
  // The install has ONE worker profile, under one configured worker principal.
  const credentialFile = join(credentials, 'worker-a.token');
  await writeFile(credentialFile, token(worker), { mode: 0o600 });
  await saveWorkerProfile(root, { name: 'launch', principal: worker.id, agentName: 'eng-a', mode: 'launch', kind: 'claude', credentialFile }, async () => ({ actor: worker }));
  // The registry worker role: three accounts at concurrency 2.
  registry = new AgentRegistry(store);
  const hostId = (await loadMasterConfig(root)).hostId, runtimes = [], fleet = [];
  for (const name of accounts) {
    const home = await temporaryDirectory(name, scratch); homes.set(name, home);
    await writeFile(join(home, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'fixture-key' } }));
    await writeFile(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture-key', anthropic: { type: 'api', key: 'fixture-key' } }));
    await writeFile(join(home, 'cli-config.json'), JSON.stringify({ authInfo: { userId: name } }));
    // The model executable: it waits for the fixture's release, then commits and submits its head as the leased worker.
    await writeFile(join(bin, name), `#!${process.execPath}
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const home = process.env.RUNTIME_HOME;
const [, key, epoch] = /complete (GY-\\d+) (\\d+) --head/.exec(process.argv.slice(2).join(' ')) ?? [];
fs.appendFileSync(home + '/starts', key + '\\n');
(async () => {
  while (!fs.existsSync(home + '/release')) await new Promise(resolve => setTimeout(resolve, 20));
  fs.writeFileSync('change.txt', 'done\\n');
  execFileSync('git', ['add', '-A']);
  execFileSync('git', ['-c', 'user.name=w', '-c', 'user.email=w@example.invalid', 'commit', '-qm', 'work']);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await fetch(process.env.GRAPHYARD_URL + '/api/work/' + key + '/submit', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.GRAPHYARD_TOKEN, 'Content-Type': 'application/json', 'Idempotency-Key': key + ':' + epoch }, body: JSON.stringify({ epoch: Number(epoch), head }) });
})();
`, { mode: 0o755 });
    runtimes.push({ name, launch: { kind: name, args: [], headlessArgs: ['one-task', '--prompt', '{request}'], environment: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, homeVariable: 'RUNTIME_HOME', modelFlag: '--model' } });
    fleet.push({ enabled: true, maxSessions: null, name, runtime: name, model: 'fixture', credential: { host: hostId, home } });
  }
  await registry.mutate(coordinator, 'apply', { runtimes, accounts: fleet, models: [{ name: 'fixture', id: 'fixture-model' }], roles: [{ name: 'worker', accounts, concurrency: 2 }], reason: 'three accounts at concurrency 2' }, randomUUID());
  await registry.observe(coordinator, { host: hostId, observations: accounts.map(account => ({ account, quota: { loggedIn: true, state: 'available' }, smoke: { result: 'pass', reason: null } })) }, randomUUID());
});
after(async () => {
  if (http) await new Promise<void>(resolve => { http.closeAllConnections?.(); http.close(() => resolve()); });
  if (store) await store.close();
});

const api = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token(coordinator)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json() as any;
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(result)}`);
  return result;
};
const snapshot = () => api('GET', 'work-snapshot') as Promise<{ work: Work[]; now: string }>;
async function readyItems(from: number) {
  const at = new Date().toISOString();
  for (let n = from; n < from + 6; n++) {
    const work = { id: randomUUID(), key: `GY-${n}`, title: `Item ${n}`, description: 'Write change.txt.', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'change.txt exists', proofs: ['unit:works'] }],
      policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
      ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
      gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [] };
    await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
  }
}
const items = async (from: number) => (await snapshot()).work.filter(item => { const n = Number(item.key.slice(3)); return n >= from && n < from + 6; });

/** One loop cycle: the production registry read, worker-pool growth, credentials, session records and worker listing; the dispatch is the real launcher with its origin fetch answered from the local base. */
async function cycle(state: ReturnType<typeof emptyDaemonState>) {
  const config = await loadMasterConfig(root);
  const mutate = (path: string, data: unknown) => api('POST', path, data);
  const production = daemonEffects(root, () => config, { snapshot, mutate, headless: spawnHeadless });
  const effects: DaemonEffects = {
    snapshot, agents: () => [], herdr: production.herdr, credentials: production.credentials, closeSession: () => {}, recordSession: production.recordSession,
    registry: production.registry, growWorkers: production.growWorkers, persist: async () => {},
    dispatch: (work, profile, _agents, read, launch) => dispatchWork(root, work, profile, { allWork: read.work, observedAt: read.now, headless: spawnHeadless, startupMs: 500,
      prepare: (at, key, name, _run, claimBy, keep, fetched) => prepareWorkerLaunch(at, key, name, (command, args, options) => command === 'git' && args[0] === 'fetch' ? '' : workerCommand(command, args, options), claimBy, keep, fetched),
      capacity: event => mutate(`work/${work.id}/capacity`, event), ...launch }),
  };
  await runCycle(config, state, effects);
  return state;
}
const status = async () => masterStatusReport(root, await loadMasterConfig(root), path => api('GET', path), async () => { throw new Error('no git in the fixture'); });
const workerRuns = () => liveRuns().filter(entry => entry.role === 'worker');
const starts = async () => (await Promise.all(accounts.map(account => readFile(join(homes.get(account)!, 'starts'), 'utf8').catch(() => '')))).flatMap(text => text.split('\n').filter(Boolean));
async function finish(from: number) {
  for (const home of homes.values()) await writeFile(join(home, 'release'), '');
  for (let tries = 0; tries < 1200; tries++) {
    if (!workerRuns().length && (await items(from)).every(item => !item.lease)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  for (const home of homes.values()) await rm(join(home, 'release'));
}

test('e2e:workers-follow-registry — one worker profile and a worker role of 3 accounts at concurrency 2: six ready items run as six concurrent headless workers, each under its own identity; master workers 1 limits it to three', async () => {
  const state = emptyDaemonState(await loadMasterConfig(root));
  await readyItems(9700);
  // A launch that loses a race for the shared Git store costs nothing and is retried on the next cycle, as in the loop.
  for (let cycles = 0; cycles < 6 && workerRuns().length < 6; cycles++) await cycle(state);

  // Six worker sessions at once, each item claimed under a worker identity of its own.
  assert.equal(workerRuns().length, 6, JSON.stringify(Object.values(state.actions).map(action => action.detail)));
  const leased = await items(9700);
  const owners = leased.map(item => item.lease?.owner).sort();
  assert.deepEqual(owners, ['worker-a', 'worker-a-2', 'worker-a-3', 'worker-a-4', 'worker-a-5', 'worker-a-6'], 'each session holds its item under its own worker identity');
  for (let tries = 0; tries < 600 && (await starts()).length < 6; tries++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual((await starts()).sort(), leased.map(item => item.key).sort(), 'six model sessions run at once, one per item');
  assert.equal((await loadMasterConfig(root)).workers.length, 6, 'the loop added the worker profiles');
  assert.equal((await registry.document(coordinator)).sessions.filter(session => session.role === 'worker' && !session.endedAt).length, 6);
  assert.equal((await status()).workers, '6/6', 'master status shows running/allowed');

  // The six sessions each submit their own head and end.
  await finish(9700);
  assert.ok((await items(9700)).every(item => item.submission?.epoch === 1), 'every worker submitted its head');

  // One command lowers the limit: one session per account, three at once.
  const set = await workersCommand(['1'], { read: path => api('GET', path), write: (path, data) => api('POST', path, data) });
  assert.equal(set.allowed, 3);
  await readyItems(9800);
  for (let cycles = 0; cycles < 6 && workerRuns().length < 3; cycles++) await cycle(state);
  assert.equal(workerRuns().length, 3, JSON.stringify(Object.values(state.actions).map(action => action.detail)));
  await cycle(state);
  assert.equal(workerRuns().length, 3, 'a second cycle launches no fourth worker');
  assert.equal((await items(9800)).filter(item => item.lease).length, 3);
  assert.equal((await status()).workers, '3/3');
  await finish(9800);
});
