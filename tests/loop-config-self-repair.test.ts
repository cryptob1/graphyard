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
import { runCycle, stepFailureKey, stepFailureThreshold, standingStepFailures } from '../src/daemon/cycle.js';
import { daemonEffects } from '../src/daemon/effects-production.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { emptyDaemonState, writeDaemonState } from '../src/daemon/state.js';
import { loadMasterConfig, saveWorkerProfile, setupMaster } from '../src/master/config.js';
import { MAX_WORKER_PROFILES } from '../src/master/profiles.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { spawnHeadless } from '../src/headless-session.js';
import type { Principal, Work } from '../src/model.js';
import { setupChecklist } from '../src/model/setup-checklist.js';
import { loopPresenceHeader, loopStepFailureHeader } from '../src/model/loop-presence.js';
import { server } from '../src/server.js';
import { coordinationViewHeader } from '../src/server/work-view.js';
import { Store } from '../src/store.js';

// GY-3293: the loop never writes a config it cannot read, and repairs one it cannot load instead
// of failing every cycle. The real control plane, agent registry, loop cycle, config load and
// repair; no item is dispatched, so no runtime executable runs.
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const worker: Principal = { id: 'worker-a', role: 'worker' };
const token = (principal: Principal) => `${principal.id}-token-${'x'.repeat(32)}`;
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
// Eight accounts, so a worker role allowing 128 is 8 × 16 and a pre-GY-3285 total of 16 becomes 2 per account.
const accounts = ['claude-a', 'claude-b', 'codex-a', 'codex-b', 'muse-a', 'muse-b', 'pi-a', 'pi-b'];
let store: Store, http: ReturnType<typeof server>, registry: AgentRegistry;
let root: string, scratch: string, url: string;

before(async () => {
  store = await withDatabase('loop-config-self-repair'); await store.init();
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  scratch = await temporaryDirectory('loop-config-self-repair', join(process.cwd(), '.graphyard'));
  root = await temporaryDirectory('coordinator', scratch);
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = gitRunnerFor(root);
  http = server(engine, [coordinator, worker].map(principal => ({ ...principal, token: token(principal) })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main'); git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'Fixture.\n');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
  const credentials = await temporaryDirectory('credentials', scratch);
  await setupMaster(root, { url, token: token(coordinator), cliPath: launcher, credentialDirectory: credentials, run: { worktreeRoot: await temporaryDirectory('checkouts', scratch) } });
  // The install has ONE worker profile, under one configured worker principal.
  const credentialFile = join(credentials, 'worker-a.token');
  await writeFile(credentialFile, token(worker), { mode: 0o600 });
  await saveWorkerProfile(root, { name: 'launch', principal: worker.id, agentName: 'eng-a', mode: 'launch', kind: 'claude', credentialFile }, async () => ({ actor: worker }));
  // The registry: eight accounts on one runtime, the worker role at concurrency 16 — 128 allowed.
  registry = new AgentRegistry(store);
  const hostId = (await loadMasterConfig(root)).hostId;
  const fleet = accounts.map(name => ({ enabled: true, maxSessions: null, name, runtime: 'claude', model: 'fixture', credential: { host: hostId, home: null } }));
  await registry.mutate(coordinator, 'apply', { runtimes: [{ name: 'claude', launch: { kind: 'claude', args: [], headlessArgs: ['one-task', '--prompt', '{request}'], environment: {}, homeVariable: 'CLAUDE_CONFIG_DIR', modelFlag: '--model' } }],
    accounts: fleet, models: [{ name: 'fixture', id: 'fixture-model' }], roles: [{ name: 'worker', accounts, concurrency: 16 }], reason: 'eight accounts at concurrency 16' }, randomUUID());
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
const snapshot = () => api('GET', 'work-snapshot', undefined, { [coordinationViewHeader]: 'coordination' }) as Promise<{ work: Work[]; now: string }>;

/** One loop cycle over the real config load (repair included), registry read, worker-pool growth, credentials and session records. */
async function cycle(state: ReturnType<typeof emptyDaemonState>, options: { failCloseStep?: boolean } = {}) {
  const config = await loadMasterConfig(root);
  const mutate = (path: string, data: unknown) => api('POST', path, data);
  const production = daemonEffects(root, () => config, { snapshot, mutate, headless: spawnHeadless });
  const effects: DaemonEffects = {
    snapshot, agents: () => [], herdr: production.herdr,
    // Inspecting 100 profiles' credentials takes seconds a cycle; the step-failure cycles need none of them.
    credentials: options.failCloseStep ? async () => ({}) : production.credentials, closeSession: () => {}, recordSession: production.recordSession,
    registry: production.registry, growWorkers: production.growWorkers, dispatch: production.dispatch, persist: async value => { await writeDaemonState(config, value); },
    // A failing volumes read fails the close step identically every cycle, while the rest of the cycle runs.
    diskVolumes: options.failCloseStep ? async () => { throw new Error('cannot read the volumes: fixture'); } : async () => [{ path: root, freeBytes: 1e12 }],
  };
  return await runCycle(config, state, effects);
}

test('a worker role allowing 128 grows the pool only to the schema maximum, and the config still loads', async () => {
  const state = emptyDaemonState(await loadMasterConfig(root));
  await cycle(state);
  await cycle(state);
  const config = await loadMasterConfig(root);
  assert.equal(config.workers.length, MAX_WORKER_PROFILES, JSON.stringify(Object.values(state.actions).map(action => action.detail)));
  assert.ok(config.workers.slice(1).every(profile => profile.minted === true), 'every added profile is marked as the loop\'s own');
  // The registry still allows 128; the pool — what the install can actually run — never passes the schema's bound.
  const fleet = await api('GET', 'agent-registry');
  assert.equal(fleet.roles.find((role: any) => role.role === 'worker').limit, 128);
});

test('an upgrade from a pre-GY-3285 registry converts a total concurrency of 16 over 8 accounts into 2 per account', async () => {
  // The registry exactly as a pre-GY-3285 release wrote it, appended straight to the ledger the
  // way that release appended it: the worker role's concurrency meant a total, and the document
  // carries no per-account marker.
  const insert = async (concurrency: number, reason: string) => {
    const document = structuredClone(await registry.document(coordinator));
    delete (document as unknown as { workerConcurrencyPerAccount?: true }).workerConcurrencyPerAccount;
    const role = { ...document.roles.find(entry => entry.name === 'worker')!, concurrency };
    document.roles = document.roles.map(entry => entry.name === 'worker' ? role : entry);
    document.revision++;
    await store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)',
      [coordinator.id, 'agent-registry.role.set', JSON.stringify({ change: { role, reason }, registry: document })]);
  };
  await insert(16, 'the fleet before per-account concurrency');
  let role = (await registry.document(coordinator)).roles.find(entry => entry.name === 'worker')!;
  assert.equal(role.concurrency, 2, 'sixteen in total over eight accounts is two per account');
  assert.equal(role.accounts.length * role.concurrency, 16, 'the fleet keeps the sixteen workers its operator set');
  // A value GY-3285's own command set already meant per-account, and is kept as it stands.
  await insert(3, 'master workers 3');
  role = (await registry.document(coordinator)).roles.find(entry => entry.name === 'worker')!;
  assert.equal(role.concurrency, 3, JSON.stringify(role));
  // The registry this code writes carries the marker, so the conversion happens once, not per read.
  await registry.mutate(coordinator, 'role.set', { role: { name: 'worker', accounts, concurrency: 3 }, reason: 'master workers 3' }, randomUUID());
  assert.equal((await registry.document(coordinator)).workerConcurrencyPerAccount, true);
});

test('a config with 101 loop-minted profiles is repaired by the next cycle, which then completes', async () => {
  const state = emptyDaemonState(await loadMasterConfig(root));
  // The outage's file: growWorkerPool kept minting past the schema bound until the file would not
  // parse. One more minted profile past the limit, written the way the unvalidated writer wrote it.
  const config = await loadMasterConfig(root);
  const first = config.workers[0]!, last = config.workers.at(-1)!;
  const overflow = { ...last, name: `${first.name}-${config.workers.length + 1}`, principal: `${first.principal}-${config.workers.length + 1}`, agentName: `${first.agentName}-${config.workers.length + 1}`, minted: true };
  const file = join(root, '.graphyard/master.json');
  await writeFile(file, JSON.stringify({ ...config, workers: [...config.workers, overflow] }, null, 2), { mode: 0o600 });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).workers.length, MAX_WORKER_PROFILES + 1, 'the fixture holds 101 profiles');
  const said: string[] = [];
  const stderr = console.error;
  console.error = (...args: unknown[]) => { said.push(args.map(String).join(' ')); };
  try {
    const completed = await cycle(state);
    assert.ok(completed.metrics.steps?.includes('persist'), 'the cycle after the repair completes');
  } finally { console.error = stderr; }
  const repaired = await loadMasterConfig(root);
  assert.equal(repaired.workers.length, MAX_WORKER_PROFILES, 'the loop removed its own newest minted profile until the file loads');
  assert.equal(repaired.workers.at(-1)!.name, last.name, 'the operator\'s profiles and the older minted ones stand');
  assert.ok(said.join('\n').includes(overflow.name), `the repair says what it removed: ${said.join(' ')}`);
});

test(`a step failing identically for ${stepFailureThreshold} cycles shows a Needs you alert`, async () => {
  const state = emptyDaemonState(await loadMasterConfig(root));
  for (let n = 0; n < stepFailureThreshold; n++) await cycle(state, { failCloseStep: true });
  const row = state.actions[stepFailureKey('close')];
  assert.equal(row?.state, 'failed');
  assert.ok(row!.detail.includes('cannot read the volumes: fixture'), row!.detail);
  assert.ok(row!.detail.startsWith(`The loop's close step failed the same way ${stepFailureThreshold} consecutive cycles:`), row!.detail);
  assert.equal(state.stepFailures['close']!.count, stepFailureThreshold);

  // The loop's own coordination read names the standing line, and the dashboard raises it as one
  // Needs you item while it stands — no master session involved.
  const line = standingStepFailures(state)[0]!;
  assert.equal(line, row!.detail);
  await api('GET', 'work-snapshot', undefined, { [loopPresenceHeader]: '20', [loopStepFailureHeader]: encodeURIComponent(line) });
  const status = await api('GET', 'status');
  assert.equal(status.setup.stepFailure, line);
  const item = setupChecklist(status).find(entry => entry.id === 'step-failure')!;
  assert.equal(item.human, true);
  assert.equal(item.done, false);
  assert.ok(item.line.includes('cannot read the volumes: fixture'));

  // The attention line names the error, and the alert clears on the first cycle the step succeeds.
  const report = await masterStatusReport(root, await loadMasterConfig(root), path => api('GET', path), async () => { throw new Error('no git in the fixture'); });
  assert.ok(report.attention.some(entry => entry.text === row!.detail), JSON.stringify(report.attention));
  await cycle(state);
  assert.equal(state.actions[stepFailureKey('close')], undefined, 'the standing line clears with the step');
  await api('GET', 'work-snapshot', undefined, { [loopPresenceHeader]: '20', [loopStepFailureHeader]: 'off' });
  assert.equal((await api('GET', 'status')).setup.stepFailure, null);
});
