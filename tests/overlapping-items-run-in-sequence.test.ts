import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from './helpers/warm-postgres.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { emptyDaemonState, type DaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import type { Principal, Work } from '../src/model.js';
import { coordinationViewHeader } from '../src/server/work-view.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model/repository-policy.js';

setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// 2026-11-04: refactor items editing the same core files ran in parallel and every merge sent the
// heads queued behind it back to conflict (GY-3019: 108 attempts). A file an item declares in
// plannedFiles now holds its release and dispatch while another item on it is in flight —
// claimed, or submitted through review and merge — and it goes once that item lands.

const repository = 'owner/overlap-sequence';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const loopId = 'graphyard-master-overlap-operator';
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const workers: Principal[] = ['a', 'b', 'c', 'd'].map(name => ({ id: `worker-${name}`, role: 'worker', sessionKind: 'ai' }));
const credentials = [operator, coordinator, ...workers].map(principal => ({ ...principal, token: `overlap-${principal.id}-${'x'.repeat(32)}` }));
const token = (id: string) => credentials.find(credential => credential.id === id)!.token;
let agentToken: string;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const call = async (bearer: string, method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${url}/api/${path}`, {
    method, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (bearer: string, method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const result = await call(bearer, method, path, body, headers);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const file = (title: string, plannedFiles?: string[]) => ok(token(operator.id), 'POST', 'work', {
  title, type: 'chore', priority: 1, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:overlapping-items-run-in-sequence', 'e2e:fixture'] }],
  policy: { checks: ['test'], review: true }, ...(plannedFiles ? { plannedFiles } : {}),
}) as Promise<Work>;
const update = (id: string, patch: Record<string, unknown>) => store.pool.query('UPDATE work_items SET document = document || $1::jsonb WHERE id = $2', [JSON.stringify(patch), id]);

const profile = (name: string, principal: string): WorkerProfile =>
  ({ name, principal, agentName: `agent-${name}`, mode: 'launch', kind: 'claude', credentialFile: `/srv/credentials/${name}.token`, agentArgs: [], approvals: 'auto', environment: {} } as WorkerProfile);
const masterConfig = (): MasterConfig => masterConfigSchema.parse({
  version: 1, url, credentialFile: '/outside/coordinator.token', cliPath: '/outside/bin/graphyard.mjs',
  repository, baseBranch: 'main', githubAppId: 1234, hostId: 'loop-host', masterAgentName: 'graphyard-master-overlap', autoMerge: true, mergeMethod: 'merge',
  operatorAgent: { id: loopId, credentialFile: '/outside/operator-agent.token' },
  workers: workers.map((worker, index) => profile(`p${index}`, worker.id)),
});

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 3101;
  database = new EmbeddedPostgres({
    databaseDir: await temporaryDirectory('overlap-sequence-db'), user: 'graphyard', password: 'testing-only', port, persistent: false,
    onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'],
  });
  await database.initialise(); await database.start(); await database.createDatabase('overlap_sequence');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/overlap_sequence`);
  await store.init();
  engine = new Engine(store, 300, repository);
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  agentToken = `loop-agent-${randomUUID()}`;
  await ok(token(operator.id), 'POST', 'operator-agents', { id: loopId, displayName: 'Master loop', capabilities: [],
    scope: { repositories: [repository], workItems: ['*'] }, token: agentToken, reason: 'the loop applies its decisions under its own identity' });
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('integration:overlapping-items-run-in-sequence — of two backlog items declaring the same file only one is released and dispatched while it is in flight (claimed or submitted), the other goes once it lands, and items on other files or declaring none run beside them', async () => {
  const first = await file('Refactor engine A', ['src/engine.ts']);
  const second = await file('Refactor engine B', ['src/engine.ts', 'src/release.ts']);
  const other = await file('Refactor close', ['src/server/close.ts']);
  const undeclared = await file('Declares nothing');
  assert.deepEqual(first.plannedFiles, ['src/engine.ts']);
  const revised = await ok(token(operator.id), 'POST', `work/${second.id}/requirements`, {
    expectedPolicyRevision: second.policyRevision, reason: 'Keep the declared overlap through requirement changes',
    criteria: second.criteria, dependencies: [], exclusiveResources: [], plannedFiles: ['src/engine.ts', 'src/release.ts'],
  });
  assert.deepEqual(revised.plannedFiles, ['src/engine.ts', 'src/release.ts']);

  const herdr = { agents: [] as HerdrAgent[] };
  const config = masterConfig();
  const released: string[] = [], claims: string[] = [];
  const effects: DaemonEffects = {
    agents: () => herdr.agents,
    herdr: () => ({ agents: herdr.agents, available: true }),
    credentials: async () => Object.fromEntries(config.workers.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => {
      const snapshot = await ok(token(coordinator.id), 'GET', 'work-snapshot', undefined, { [coordinationViewHeader]: 'coordination' });
      return { work: snapshot.work as Work[], now: snapshot.now };
    },
    closeSession: () => {},
    release: async (item, reason) => {
      released.push(item.key);
      return ok(agentToken, 'POST', `work/${item.id}/ready`, { expectedRevision: item.revision, reason });
    },
    dispatch: async (item, chosen) => {
      const claimed = await ok(token(chosen.principal), 'POST', `work/${item.id}/claim`, {}) as Work;
      herdr.agents = [...herdr.agents, { name: chosen.agentName, pane_id: `pane-${item.key}`, agent: 'claude', agent_status: 'working' }];
      claims.push(item.key);
      return { pane: `pane-${item.key}`, epoch: claimed.epoch };
    },
    persist: async () => {},
  };
  const state: DaemonState = emptyDaemonState(config);

  await runCycle(config, state, effects);
  assert.deepEqual(released, [first.key, other.key, undeclared.key], 'the second item on src/engine.ts stays in the backlog; the rest are released together');
  assert.deepEqual(new Set(claims), new Set([first.key, other.key, undeclared.key]), 'non-overlapping items are dispatched in parallel');

  await update(second.id, { ready: true });
  const refusedClaim = await call(token(workers[3].id), 'POST', `work/${second.id}/claim`, {});
  assert.equal(refusedClaim.status, 409);
  assert.match(JSON.stringify(refusedClaim.body), /Exclusive resources held/);
  await update(second.id, { ready: false });

  // The first item submits: its lease ends, and its standing submission through review and merge still holds the file.
  await update(first.id, { lease: null, stage: 'review', submission: { epoch: 1, pr: 1 } });
  await runCycle(config, state, effects);
  assert.deepEqual(released, [first.key, other.key, undeclared.key], 'a submitted item past build still holds its file');

  await update(second.id, { ready: true });
  const submittedConflict = await call(token(workers[3].id), 'POST', `work/${second.id}/claim`, {});
  assert.equal(submittedConflict.status, 409);
  assert.match(JSON.stringify(submittedConflict.body), /Exclusive resources held/);
  await update(second.id, { ready: false });

  // It lands: the second item is released and dispatched.
  await update(first.id, { stage: 'done', submission: null });
  herdr.agents = herdr.agents.filter(agent => agent.pane_id !== `pane-${first.key}`);
  await runCycle(config, state, effects);
  assert.deepEqual(released.at(-1), second.key, 'the second item goes once the first lands');
  assert.equal(claims.at(-1), second.key);
});

test('unit:overlapping-items-run-in-sequence — two released items declaring the same file, neither in flight, dispatch one at a time in one cycle', async () => {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const ready = (key: string, plannedFiles: string[]) => ({
    id: `id-${key}`, key, title: key, description: '', type: 'chore', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:x'] }],
    policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 0, lease: null,
    workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], plannedFiles,
  }) as unknown as Work;
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/c.token', cliPath: '/outside/bin/graphyard.mjs', repository, baseBranch: 'main', githubAppId: 1234,
    hostId: 'h', masterAgentName: 'graphyard-master-unit', autoMerge: true, mergeMethod: 'merge', workers: [profile('one', 'w1'), profile('two', 'w2'), profile('three', 'w3')] });
  const log: string[] = [];
  const effects: DaemonEffects = {
    agents: () => [], credentials: async () => Object.fromEntries(config.workers.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: [ready('GY-1', ['src/engine.ts']), ready('GY-2', ['src/engine.ts']), ready('GY-3', ['src/release.ts'])], now: new Date().toISOString() }),
    closeSession: () => {}, dispatch: async item => { log.push(item.key); }, persist: async () => {},
  };
  await runCycle(config, emptyDaemonState(config), effects);
  assert.deepEqual(log.sort(), ['GY-1', 'GY-3']);
});
