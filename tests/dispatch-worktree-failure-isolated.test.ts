import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { Engine } from '../src/engine.js';
import { runCycle } from '../src/daemon/cycle.js';
import { daemonEffects } from '../src/daemon/effects-production.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { loadMasterConfig, saveWorkerProfile, setupMaster } from '../src/master/config.js';
import { dispatchWork, prepareWorkerLaunch, workerCommand, worktreeFailure } from '../src/master/dispatch.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { spawnHeadless } from '../src/headless-session.js';
import { liveRuns } from '../src/runner/registry.js';
import type { Principal, Work } from '../src/model.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';

// GY-3475: one item whose worktree git cannot build must not strand the ready items behind it.
// The real control plane, agent registry, loop cycle, CLI claim/worktree/watch and headless
// dispatch; the only substitute is the runtime's model executable, which waits for the fixture's
// release and then commits and submits its head under its own lease.
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const worker: Principal = { id: 'worker-a', role: 'worker' };
const token = (principal: Principal) => `${principal.id}-token-${'x'.repeat(32)}`;
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
let store: Store, http: ReturnType<typeof server>, registry: AgentRegistry;
let root: string, url: string, runtimeHome: string;
// The loop's clock runs `skew` ahead of the control plane's, so a back-off expires without the test waiting it out.
let skew = 0, celsius: number | null = null, pressure: string | null = null;
const saturated = 'some avg10=90.00 avg60=90.00 avg300=90.00 total=1\n';

before(async () => {
  store = await withDatabase('dispatch-worktree-failure-isolated'); await store.init();
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  const scratch = await temporaryDirectory('dispatch-worktree-failure-isolated', join(process.cwd(), '.graphyard'));
  root = await temporaryDirectory('coordinator', scratch);
  const bin = await temporaryDirectory('bin', scratch), home = await temporaryDirectory('home', scratch);
  const engine = new Engine(store, 3600, 'owner/project'); engine.gitRunner = gitRunnerFor(root);
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
  const credentialFile = join(credentials, 'worker-a.token');
  await writeFile(credentialFile, token(worker), { mode: 0o600 });
  await saveWorkerProfile(root, { name: 'launch', principal: worker.id, agentName: 'eng-a', mode: 'launch', kind: 'claude', credentialFile }, async () => ({ actor: worker }));
  await writeFile(join(home, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'fixture-key' } }));
  // The model executable waits for the fixture to release its item, then commits and submits its head as the leased worker.
  await writeFile(join(bin, 'claude'), `#!${process.execPath}
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const [, key, epoch] = /complete (GY-\\d+) (\\d+) --head/.exec(process.argv.slice(2).join(' ')) ?? [];
(async () => {
  while (!fs.existsSync(process.env.RUNTIME_HOME + '/release-' + key)) await new Promise(resolve => setTimeout(resolve, 20));
  fs.writeFileSync('change.txt', 'done\\n');
  execFileSync('git', ['add', '-A']);
  execFileSync('git', ['-c', 'user.name=w', '-c', 'user.email=w@example.invalid', 'commit', '-qm', 'work']);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await fetch(process.env.GRAPHYARD_URL + '/api/work/' + key + '/submit', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.GRAPHYARD_TOKEN, 'Content-Type': 'application/json', 'Idempotency-Key': key + ':' + epoch }, body: JSON.stringify({ epoch: Number(epoch), head }) });
})();
`, { mode: 0o755 });
  runtimeHome = home;
  registry = new AgentRegistry(store);
  const hostId = (await loadMasterConfig(root)).hostId;
  await registry.mutate(coordinator, 'apply', { runtimes: [{ name: 'claude', launch: { kind: 'claude', args: [], headlessArgs: ['one-task', '--prompt', '{request}'], environment: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, homeVariable: 'RUNTIME_HOME', modelFlag: '--model' } }],
    accounts: [{ enabled: true, maxSessions: null, name: 'claude', runtime: 'claude', model: 'fixture', credential: { host: hostId, home } }], models: [{ name: 'fixture', id: 'fixture-model' }], roles: [{ name: 'worker', accounts: ['claude'], concurrency: 2 }], reason: 'one account at concurrency 2' }, randomUUID());
  await registry.observe(coordinator, { host: hostId, observations: [{ account: 'claude', quota: { loggedIn: true, state: 'available' }, smoke: { result: 'pass', reason: null } }] }, randomUUID());
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
const snapshot = async () => { const read = await api('GET', 'work-snapshot') as { work: Work[]; now: string }; return { ...read, now: new Date(Date.parse(read.now) + skew).toISOString() }; };
async function readyItem(key: string, priority: number) {
  const at = new Date().toISOString();
  const work = { id: randomUUID(), key, title: `Item ${key}`, description: 'Write change.txt.', type: 'bug', priority, dependencies: [], criteria: [{ id: 'AC-1', text: 'change.txt exists', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [] };
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
  return work.id;
}
async function cycle(state: ReturnType<typeof emptyDaemonState>) {
  const config = await loadMasterConfig(root);
  const mutate = (path: string, data: unknown) => api('POST', path, data);
  const production = daemonEffects(root, () => config, { snapshot, mutate, headless: spawnHeadless });
  const effects: DaemonEffects = {
    snapshot, agents: () => [], herdr: production.herdr, credentials: production.credentials, closeSession: () => {}, recordSession: production.recordSession,
    cpuPressure: async () => ({ pressure, stat: null, celsius }), registry: production.registry, growWorkers: production.growWorkers, persist: async () => {},
    dispatch: (work, profile, _agents, read, launch) => dispatchWork(root, work, profile, { allWork: read.work, observedAt: read.now, headless: spawnHeadless, startupMs: 500,
      prepare: (at, key, name, _run, claimBy, keep, fetched) => prepareWorkerLaunch(at, key, name, (command, args, options) => command === 'git' && args[0] === 'fetch' ? '' : workerCommand(command, args, options), claimBy, keep, fetched),
      capacity: event => mutate(`work/${work.id}/capacity`, event), ...launch }),
  };
  await runCycle(config, state, effects, () => Date.now() + skew);
  return state;
}

const item = async (key: string) => (await snapshot()).work.find(entry => entry.key === key)!;
const running = () => liveRuns().filter(entry => entry.role === 'worker').map(entry => entry.work).sort();

test('integration:dispatch-worktree-failure-isolated — git refuses the highest-priority item\'s worktree: the next ready item launches in the same cycle, only the failed item backs off with git\'s own error and the CLI that ran it, and it launches on its own once the workspace is repaired', async () => {
  const state = emptyDaemonState(await loadMasterConfig(root));
  const broken = await readyItem('GY-9901', 0);
  await readyItem('GY-9902', 1);
  // Something already sits where GY-9901's worktree goes, so the real `git worktree add` refuses it.
  const occupied = join(root, '.graphyard', 'worktrees', 'GY-9901-1');
  await mkdir(occupied, { recursive: true }); await writeFile(join(occupied, 'left-behind.txt'), 'x\n');
  const attempts = () => state.actions[`dispatch:${broken}:0`]?.attempts ?? 0;

  // Cycle 1: the first item's launch fails in git; the second launches on the free slot in the same cycle.
  await cycle(state);
  assert.equal(state.actions[`dispatch:${broken}:0`].state, 'failed');
  assert.deepEqual(running(), ['GY-9902'], JSON.stringify(Object.values(state.actions).map(action => action.detail)));
  assert.deepEqual([(await item('GY-9901')).epoch, (await item('GY-9901')).lease], [0, null], 'the failed claim is handed back: no lease, and the epoch returns');
  const leased = await item('GY-9902');
  assert.deepEqual([leased.epoch, leased.lease?.owner], [1, 'worker-a-2']);
  // Only the failed item backs off, on the runtime that failed, and its reason is the child's own error.
  assert.deepEqual(Object.keys(state.launchBackoff), [`claude:${broken}`]);
  const { reason } = state.launchBackoff[`claude:${broken}`];
  assert.ok(reason.length <= 500);
  assert.match(reason, /^Worker launch failed: the worktree for GY-9901 epoch 1 could not be created \(CLI /);
  assert.match(reason, /fatal: '.*GY-9901-1' already exists/, 'git\'s own stderr survives the bound');
  // The recorded dispatch failure names the CLI that ran the worktree command: this checkout's launcher, a release by its commit.
  assert.ok(state.actions[`dispatch:${broken}:0`].detail.includes(`could not be created (CLI ${launcher}): Git worktree creation failed: `));
  assert.match(worktreeFailure('GY-1', 2, { stderr: 'fatal: no' }, `/install/.graphyard/cli-releases/${'ab12'.repeat(10)}/bin/graphyard.mjs`), /could not be created \(CLI ab12ab12ab12\): fatal: no$/, 'a released CLI is named by its commit');

  // Inside the back-off the item is not relaunched; once it expires the retry claims again and fails the same way.
  skew += 5_000; await cycle(state);
  assert.equal(attempts(), 1);
  skew += 61_000; await cycle(state);
  assert.equal(attempts(), 2, 'the retry waited for the back-off to expire');
  assert.deepEqual([(await item('GY-9901')).epoch, (await item('GY-9901')).lease], [0, null]);
  assert.ok(Object.keys(state.launchBackoff).every(key => key.endsWith(`:${broken}`)), 'the second failure still backs off this item alone');
  assert.equal(state.launchBackoff[`claude:${broken}`].failures, 2);
  assert.deepEqual([(await item('GY-9902')).epoch, (await item('GY-9902')).lease?.owner], [1, 'worker-a-2'], 'the running attempt keeps its own lease and epoch');

  // A third ready item takes the free slot the next cycle, while the failed one is still backed off.
  await readyItem('GY-9903', 2);
  skew += 5_000; await cycle(state);
  assert.deepEqual(running(), ['GY-9902', 'GY-9903']);

  // The workspace is repaired and the back-off over, but the worker role is full: capacity still holds the launch.
  await rm(occupied, { recursive: true });
  skew += 121_000; await cycle(state);
  assert.deepEqual(running(), ['GY-9902', 'GY-9903']);
  assert.equal((await item('GY-9901')).lease, null);

  // GY-9902 submits its head, which frees a slot; a saturated CPU still holds the launch (GY-3501: heat no longer does).
  await writeFile(join(runtimeHome, 'release-GY-9902'), '');
  for (let tries = 0; tries < 600 && (running().includes('GY-9902') || (await item('GY-9902')).lease); tries++) await new Promise(resolve => setTimeout(resolve, 50));
  const submitted = await item('GY-9902');
  assert.equal(submitted.submission?.epoch, 1);
  pressure = saturated;
  await cycle(state);
  assert.deepEqual(running(), ['GY-9903'], 'no implementation session starts while the CPU is saturated');
  pressure = null;

  // With the slot free and the host cool, the repaired item launches with nobody's help.
  await cycle(state);
  assert.deepEqual(running(), ['GY-9901', 'GY-9903'], JSON.stringify(Object.values(state.actions).map(action => action.detail)));
  assert.deepEqual([(await item('GY-9901')).epoch, !!(await item('GY-9901')).lease], [1, true]);
  // The submitted candidate is as its worker left it: same epoch and head, unleased, its review and proof still owed.
  const after = await item('GY-9902');
  assert.deepEqual([after.epoch, after.lease, after.submission, after.candidate?.sha], [1, null, submitted.submission, submitted.candidate?.sha]);
  assert.ok(after.stage !== 'done' && after.gates.some(gate => ['review', 'acceptance'].includes(gate.name) && !gate.passed), 'review and proof gates are still unpassed');
  // The two running sessions submit and end, so the fixture leaves no process behind.
  for (const key of ['GY-9901', 'GY-9903']) await writeFile(join(runtimeHome, `release-${key}`), '');
  for (let tries = 0; tries < 600 && running().length; tries++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(running(), []);
});
