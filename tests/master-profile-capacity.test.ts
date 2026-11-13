import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { Engine } from '../src/engine.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { runCycle } from '../src/daemon/cycle.js';
import { daemonEffects } from '../src/daemon/effects-production.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { loadMasterConfig, saveWorkerProfile, setupMaster } from '../src/master/config.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import type { Principal, Work } from '../src/model.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';

// GY-3292: the loop's worker-pool growth (growWorkerPool, through saveWorkerProfile) wrote a 101st
// profile into .graphyard/master.json whenever the registry allowed more workers than the file holds,
// which made every master command and loop cycle fail, and minted another identity each cycle.
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const worker: Principal = { id: 'worker-a', role: 'worker' };
const token = (principal: Principal) => `${principal.id}-token-${'x'.repeat(32)}`;
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
let store: Store, http: ReturnType<typeof server>, root: string, url: string;
const file = () => join(root, '.graphyard/master.json');
const stored = async () => JSON.parse(await readFile(file(), 'utf8')) as { workers: { name: string; mode: string }[] };
const minted = async () => Number((await store.pool.query('SELECT count(*) FROM worker_identities')).rows[0].count);

before(async () => {
  store = await withDatabase('master-profile-capacity'); await store.init();
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  const scratch = await temporaryDirectory('master-profile-capacity', join(process.cwd(), '.graphyard'));
  root = await temporaryDirectory('coordinator', scratch);
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = gitRunnerFor(root);
  http = server(engine, [coordinator, worker].map(principal => ({ ...principal, token: token(principal) })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main'); git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'Fixture.\n');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  const credentials = await temporaryDirectory('credentials', scratch);
  await setupMaster(root, { url, token: token(coordinator), cliPath: launcher, credentialDirectory: credentials, run: { worktreeRoot: await temporaryDirectory('checkouts', scratch) } });
  // As on the host: hand-configured existing-mode profiles beside the one launch profile the loop copies.
  for (let n = 1; n <= 11; n++) await saveWorkerProfile(root, { name: `existing-${n}`, principal: `existing-${n}`, agentName: `existing-${n}`, mode: 'existing' }, async () => ({}));
  const credentialFile = join(credentials, 'worker-a.token');
  await writeFile(credentialFile, token(worker), { mode: 0o600 });
  await saveWorkerProfile(root, { name: 'claude-primary', principal: worker.id, agentName: 'eng-a', mode: 'launch', kind: 'claude', credentialFile }, async () => ({ actor: worker }));
  // The registry worker role allows 2 × 60 = 120 workers, more than master.json can hold.
  const registry = new AgentRegistry(store);
  const accounts = ['claude', 'codex'];
  await registry.mutate(coordinator, 'apply', {
    runtimes: accounts.map(name => ({ name, launch: { kind: name, args: [], environment: {} } })),
    accounts: accounts.map(name => ({ enabled: true, maxSessions: null, name, runtime: name, model: 'fixture', credential: { host: 'fixture-host', home: '/nonexistent' } })),
    models: [{ name: 'fixture', id: 'fixture-model' }], roles: [{ name: 'worker', accounts, concurrency: 60 }], reason: 'more workers than master.json holds',
  }, randomUUID());
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

/** One loop cycle with the production registry read and worker-pool growth. */
async function cycle(state: ReturnType<typeof emptyDaemonState>) {
  const config = await loadMasterConfig(root);
  const production = daemonEffects(root, () => config, { snapshot, mutate: (path: string, data: unknown) => api('POST', path, data) });
  const effects: DaemonEffects = {
    snapshot, agents: () => [], herdr: production.herdr, credentials: production.credentials, closeSession: () => {}, recordSession: production.recordSession,
    registry: production.registry, growWorkers: production.growWorkers, persist: async () => {},
    dispatch: async () => { throw new Error('no work to dispatch in this fixture'); },
  };
  await runCycle(config, state, effects);
  return state;
}
const status = async () => masterStatusReport(root, await loadMasterConfig(root), path => api('GET', path), async () => { throw new Error('no git in the fixture'); });

test('e2e:master-profile-capacity — a registry allowing more workers than master.json holds grows the pool to 100 profiles and no further; master status and later cycles keep working', async () => {
  const before = (await stored()).workers.map(profile => profile.name);
  const state = emptyDaemonState(await loadMasterConfig(root));
  await cycle(state);
  const grown = (await stored()).workers;
  assert.equal(grown.length, 100, 'the pool stops at the 100 profiles master.json holds');
  assert.deepEqual(grown.slice(0, before.length).map(profile => profile.name), before, 'configured profiles stay as they were');
  assert.equal(grown.at(-1)!.name, 'claude-primary-89');
  assert.equal((await loadMasterConfig(root)).workers.length, 100, 'master.json stays readable');
  const identities = await minted();
  assert.equal(identities, 88, 'one identity per added profile');

  // Later cycles add nothing and mint nothing.
  await cycle(state); await cycle(state);
  assert.equal((await stored()).workers.length, 100);
  assert.equal(await minted(), identities, 'no identity is minted once the pool is full');
  assert.match((await status()).workers, /^0\/120$/, 'master status reads the configuration');
  await assert.rejects(saveWorkerProfile(root, { name: 'one-more', principal: 'one-more', agentName: 'one-more', mode: 'existing' }, async () => ({})), /most worker profiles, 100/);
});

test('e2e:master-profile-capacity — a master.json already grown past the limit loads, and the next cycle neither adds nor mints', async () => {
  const config = await stored();
  config.workers.push({ ...config.workers.at(-1)!, name: 'claude-primary-90' } as never);
  await writeFile(file(), JSON.stringify(config), { mode: 0o600 });
  const identities = await minted();
  const loaded = await loadMasterConfig(root);
  assert.equal(loaded.workers.length, 100);
  assert.equal(loaded.workers.at(-1)!.name, 'claude-primary-89', 'the newest generated spare past the limit is dropped');
  await cycle(emptyDaemonState(loaded));
  assert.equal(await minted(), identities);
  assert.match((await status()).workers, /\/120$/);
});
