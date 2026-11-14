import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { Engine } from '../src/engine.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { workersCommand } from '../src/cli/master-registry.js';
import { runCycle, workerGrowthKey } from '../src/daemon/cycle.js';
import { daemonEffects } from '../src/daemon/effects-production.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { loadMasterConfig, saveWorkerProfile, setupMaster } from '../src/master/config.js';
import { growWorkerPool, workersAllowed } from '../src/master/worker-pool.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { loopPresenceHeader, loopWorkerGrowthHeader } from '../src/model/loop-presence.js';
import { coordinationViewHeader } from '../src/server/work-view.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import type { Principal, Work } from '../src/model.js';
import { server } from '../src/server.js';
import { sessionNameRefusal } from '../src/session-name.js';
import { Store } from '../src/store.js';
import HumanRequestsPage from '../web/pages/human-requests.js';

// GY-3299: hwd-backend's install (inspecthoa-hwd-backend) allows 13 workers — 13 accounts × concurrency 1 —
// but growWorkerPool named the second profile's session inspecthoa-hwd-backend-claude-1-2, 33 characters,
// which the profile schema refuses, so the pool stayed at one profile and the failure was only a journal line.
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const admin: Principal = { id: 'owner', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'inspecthoa-hwd-backend-claude-1', role: 'worker' };
const token = (principal: Principal) => `${principal.id}-token-${'x'.repeat(32)}`;
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const first = { name: 'claude-1', principal: worker.id, agentName: 'inspecthoa-hwd-backend-claude-1', mode: 'launch' as const, kind: 'claude' as const };
const existing = { name: 'hand-configured', principal: 'hand-configured', agentName: 'hand-configured', mode: 'existing' as const };
let store: Store, engine: Engine, http: ReturnType<typeof server>, root: string, url: string, credentialFile: string;

before(async () => {
  store = await withDatabase('long-install-worker-pool'); await store.init();
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  const scratch = await temporaryDirectory('long-install-worker-pool', join(process.cwd(), '.graphyard'));
  root = await temporaryDirectory('coordinator', scratch);
  engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = gitRunnerFor(root); engine.principals = [admin];
  http = server(engine, [coordinator, admin, worker].map(principal => ({ ...principal, token: token(principal) })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main'); git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'Fixture.\n');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  const credentials = await temporaryDirectory('credentials', scratch);
  await setupMaster(root, { url, token: token(coordinator), cliPath: launcher, credentialDirectory: credentials, run: { worktreeRoot: await temporaryDirectory('checkouts', scratch) } });
  await saveWorkerProfile(root, existing, async () => ({}));
  credentialFile = join(credentials, `${worker.id}.token`);
  await writeFile(credentialFile, token(worker), { mode: 0o600 });
  await saveWorkerProfile(root, { ...first, credentialFile }, async () => ({ actor: worker }));
  // hwd-backend's registry: 13 accounts × concurrency 1 = 13 workers allowed.
  const { hostId } = await loadMasterConfig(root);
  const accounts = Array.from({ length: 13 }, (_, index) => `claude-${index + 1}`);
  await new AgentRegistry(store).mutate(coordinator, 'apply', {
    runtimes: [{ name: 'claude', launch: { kind: 'claude', args: [], environment: {} } }],
    accounts: accounts.map(name => ({ enabled: true, maxSessions: null, name, runtime: 'claude', model: 'fixture', credential: { host: hostId, home: '/nonexistent' } })),
    models: [{ name: 'fixture', id: 'fixture-model' }], roles: [{ name: 'worker', accounts, concurrency: 1 }], reason: 'hwd-backend fleet',
  }, randomUUID());
});
after(async () => {
  if (http) await new Promise<void>(resolve => { http.closeAllConnections?.(); http.close(() => resolve()); });
  if (store) await store.close();
});

const api = async (method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token(coordinator)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json() as any;
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(result)}`);
  return result;
};
const snapshot = () => api('GET', 'work-snapshot') as Promise<{ work: Work[]; now: string }>;
const status = async () => masterStatusReport(root, await loadMasterConfig(root), path => api('GET', path), async () => { throw new Error('no git in the fixture'); });
/** The dashboard's Needs you page after the loop's read carries its standing growth failure, as `master run` sends it. */
async function needsYou(state: ReturnType<typeof emptyDaemonState>) {
  const growth = state.actions[workerGrowthKey]?.state === 'failed' ? encodeURIComponent(state.actions[workerGrowthKey]!.detail) : 'off';
  await api('GET', 'work-snapshot', undefined, { [coordinationViewHeader]: 'coordination', [loopPresenceHeader]: '30', [loopWorkerGrowthHeader]: growth });
  const read = await api('GET', 'status');
  return { growth: read.setup.workerGrowth as string | null, page: renderToStaticMarkup(createElement(HumanRequestsPage, { work: [], status: read, observedAt: Date.now() } as never)) };
}

/** One loop cycle: the production registry read and worker-pool growth, a mint that fails while `failure` is set, and no Herdr. */
async function cycle(state: ReturnType<typeof emptyDaemonState>, failure: string | null, dispatched: { item: string; profile: string }[] = []) {
  const config = await loadMasterConfig(root);
  const production = daemonEffects(root, () => config, { snapshot, mutate: (path: string, data: unknown) => api('POST', path, data) });
  const effects: DaemonEffects = {
    snapshot, agents: () => [], credentials: production.credentials, closeSession: () => {}, recordSession: production.recordSession,
    registry: production.registry, persist: production.persist,
    growWorkers: failure ? (current, allowed) => growWorkerPool(root, current, allowed, async () => { throw new Error(failure); }) : production.growWorkers,
    dispatch: async (item, profile) => {
      dispatched.push({ item: item.key, profile: profile.name });
      await engine.execute({ id: profile.principal, role: 'worker' }, 'claim', item.id, {}, randomUUID());
    },
  };
  await runCycle(config, state, effects);
  return { config, allowed: workersAllowed(config, await production.registry!()) };
}

test('e2e:long-install-worker-pool — base\'s generated name for the second hwd-backend profile is the 33-character one the schema refuses', async () => {
  assert.equal(sessionNameRefusal(`${first.agentName}-2`), 'it is 33 characters, past the 32-character limit');
  await assert.rejects(saveWorkerProfile(root, { ...first, name: 'claude-1-2', principal: `${worker.id}-2`, agentName: `${first.agentName}-2`, credentialFile }, async () => ({})),
    /Herdr cannot launch a session named \\"inspecthoa-hwd-backend-claude-1-2\\": it is 33 characters, past the 32-character limit/);
});

test('e2e:long-install-worker-pool — a growth failure stands in master status and Needs you through a cycle and clears on recovery; the pool grows to 13 valid profiles headless dispatch fills', async () => {
  const configured = (await loadMasterConfig(root)).workers;
  const state = emptyDaemonState(await loadMasterConfig(root));
  const cause = 'the control plane refused worker-identities: injected outage';
  const line = `Could not add worker profiles for the 13 workers the registry worker role allows: 1 of 13 worker profiles exist, 0 running. ${cause}`;

  await cycle(state, cause);
  const raised = (await status()).attention.find(entry => entry.subject === 'worker pool');
  assert.equal(raised?.text, line, 'master status names the cause and the capacity it leaves');
  let shown = await needsYou(state);
  assert.equal(shown.growth, line);
  assert.match(shown.page, /Worker pool cannot grow/);
  assert.ok(shown.page.includes('1 of 13 worker profiles exist, 0 running') && shown.page.includes(cause), 'Needs you shows the cause and the capacity');

  await cycle(state, cause);
  assert.equal(state.actions[workerGrowthKey]?.attempts, 2);
  assert.equal((await status()).attention.find(entry => entry.subject === 'worker pool')?.text, line, 'the failure stands through the next cycle');
  assert.equal((await needsYou(state)).growth, line);

  const { config, allowed } = await cycle(state, null);
  assert.equal(state.actions[workerGrowthKey], undefined, 'recovery clears the standing failure');
  assert.equal((await status()).attention.find(entry => entry.subject === 'worker pool'), undefined);
  shown = await needsYou(state);
  assert.equal(shown.growth, null);
  assert.doesNotMatch(shown.page, /Worker pool cannot grow/);

  // The generated profiles load through the schema, each within Herdr's 32 characters, and unique.
  const loaded = (await loadMasterConfig(root)).workers;
  const launch = loaded.filter(profile => profile.mode === 'launch');
  assert.equal(launch.length, 13);
  assert.deepEqual(launch.slice(1).map(profile => profile.agentName), Array.from({ length: 12 }, (_, index) => `inspecthoa-hwd-backend-claude-${index + 2}`));
  for (const profile of launch) assert.equal(sessionNameRefusal(profile.agentName), null, profile.agentName);
  for (const field of ['name', 'principal', 'agentName'] as const) assert.equal(new Set(loaded.map(profile => profile[field])).size, loaded.length, `${field} is unique`);
  // Existing bindings stay exactly as configured.
  assert.deepEqual(loaded.slice(0, configured.length), configured);
  assert.equal(await readFile(credentialFile, 'utf8'), token(worker));
  // Stable: another cycle adds nothing and renames nothing.
  await cycle(state, null);
  assert.deepEqual((await loadMasterConfig(root)).workers, loaded);

  // master workers, master status and the dispatcher agree on 13 = 13 accounts × concurrency 1.
  assert.equal(allowed, 13);
  assert.equal((await workersCommand([], { read: path => api('GET', path), write: (path, data) => api('POST', path, data) })).allowed, 13);
  assert.equal((await status()).workers, '0/13');
  assert.equal(config.workers.filter(profile => profile.mode === 'launch').length, 13);

  // Headless dispatch, with no Herdr session at all, fills all 13 workers from 14 ready items.
  const criteria = [{ id: 'AC-1', text: 'Worker capacity', proofs: ['e2e:long-install-worker-pool'] }];
  for (let n = 0; n < 14; n++) {
    const item = await engine.execute(admin, 'create', null, { title: `Ready item ${n}`, type: 'chore', criteria }, randomUUID());
    await engine.execute(admin, 'ready', item.id, {}, randomUUID());
  }
  const dispatched: { item: string; profile: string }[] = [];
  await cycle(state, null, dispatched);
  assert.equal(dispatched.length, 13, 'every allowed worker launches');
  assert.deepEqual(new Set(dispatched.map(entry => entry.profile)), new Set(launch.map(profile => profile.name)), 'each to its own profile');
});
