import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import type { Principal, Work } from '../src/model.js';
import { coordinationViewHeader } from '../src/server/work-view.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2991: the loop keeps the pipeline full itself: when fewer items are in flight than its
// concurrency, it releases the highest-priority backlog item whose dependencies are done. Driven
// through the loop's dispatch step against a temporary control plane.

const repository = 'owner/pipeline-full';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const loopId = 'graphyard-master-pipeline-operator';
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const workerA: Principal = { id: 'worker-a', role: 'worker', sessionKind: 'ai' };
const workerB: Principal = { id: 'worker-b', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, workerA, workerB].map(principal => ({ ...principal, token: `pipeline-${principal.id}-${'x'.repeat(32)}` }));
const token = (id: string) => credentials.find(credential => credential.id === id)!.token;
/** The loop's own operator-agent credential, issued to the control plane as an installation would. */
let agentToken: string;

let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const call = async (bearer: string, method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${url}/api/${path}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (bearer: string, method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const result = await call(bearer, method, path, body, headers);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const events = async (id: string) => (await store.pool.query('SELECT kind, actor FROM events WHERE work_id=$1', [id])).rows as { kind: string; actor: string }[];
/** One backlog item as the operator filed it, older than every item filed after it. */
const file = async (key: string, overrides: Record<string, unknown> = {}) => ok(token(operator.id), 'POST', 'work', {
  title: `Pipeline ${key}`, type: 'chore', priority: 1, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:loop-releases-backlog-to-concurrency'] }],
  policy: { checks: ['test'], review: true }, ...overrides,
}) as Promise<Work>;
/** The park a worker records: the item waits on a human-only decision, blocked, unclaimed. */
const parkOn = async (id: string) => {
  const request = { id: randomUUID(), kind: 'goals-and-priorities', reason: 'the operator decides when this work runs', needed: 'a scheduling decision for this item',
    requestedBy: workerA.id, epoch: 1, at: new Date().toISOString(), recommendation: 'Hold the item until the operator sets its priority' };
  await store.pool.query(`UPDATE work_items SET document = jsonb_set(jsonb_set(document, '{humanRequest}', $1::jsonb), '{blocker}',
    to_jsonb($2::text)) WHERE id = $3`, [JSON.stringify(request), `Human decision (Goals and priorities): ${request.needed}`, id]);
};
/** Mark the item done, as a merge does, without standing up a delivery. */
const markDone = async (id: string) => {
  await store.pool.query(`UPDATE work_items SET document = jsonb_set(jsonb_set(document, '{stage}', '"done"'::jsonb), '{stageEnteredAt}',
    to_jsonb($1::text)) WHERE id = $2`, [new Date().toISOString(), id]);
};

const profile = (name: string, principal: string): WorkerProfile =>
  ({ name, principal, agentName: `agent-${name}`, mode: 'launch', kind: 'claude', credentialFile: `/srv/credentials/${name}.token`, agentArgs: [], approvals: 'auto', environment: {} } as WorkerProfile);
const masterConfig = (): MasterConfig => masterConfigSchema.parse({
  version: 1, url, credentialFile: '/outside/coordinator.token', cliPath: '/outside/bin/graphyard.mjs',
  repository, baseBranch: 'main', githubAppId: 1234, hostId: 'loop-host', masterAgentName: 'graphyard-master-pipeline', autoMerge: true, mergeMethod: 'merge',
  operatorAgent: { id: loopId, credentialFile: '/outside/operator-agent.token' },
  // Concurrency 2: the pipeline carries two items at once.
  workers: [profile('one', workerA.id), profile('two', workerB.id)],
});

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 2991;
  database = new EmbeddedPostgres({
    databaseDir: await temporaryDirectory('pipeline-full-db'), user: 'graphyard', password: 'testing-only', port, persistent: false,
    onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'],
  });
  await database.initialise(); await database.start(); await database.createDatabase('pipeline_full');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/pipeline_full`);
  await store.init();
  engine = new Engine(store, 300, repository);
  engine.submissionObserver = null; engine.controlPlaneAppId = 1234;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  // The loop's own identity: the operator-agent the master onboarding provisions, with its issued credential.
  agentToken = `loop-agent-${randomUUID()}`;
  await ok(token(operator.id), 'POST', 'operator-agents', { id: loopId, displayName: 'Master loop', capabilities: [],
    scope: { repositories: [repository], workItems: ['*'] }, token: agentToken, reason: 'the loop applies its decisions under its own identity' });
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('unit:loop-releases-backlog-to-concurrency — one cycle at concurrency 2 releases the priority-1 and the independent priority-2 item and leaves the dependent one, the dependent one goes in the first cycle after its dependency is done and a slot is free, and a parked item never releases', async () => {
  await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
  // Priorities 1, 2, 2: the first priority-2 depends on the priority-1 item, so it cannot go while that is unfinished.
  const first = await file('GY-2991A', { priority: 1 });
  const independent = await file('GY-2991B', { priority: 2 });
  const dependent = await file('GY-2991C', { priority: 2, dependencies: [first.id] });
  // A parked item: the highest priority of all, so a broken filter would reach for it first.
  const parked = await file('GY-2991D', { priority: 0 });
  await parkOn(parked.id);

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
    // The loop's own release, exactly as the production effect posts it: the operator-agent identity, the revision it read, the reason.
    release: async (item, reason) => {
      released.push(item.key);
      const posted = await call(agentToken, 'POST', `work/${item.id}/ready`, { expectedRevision: item.revision, reason });
      assert.equal(posted.status, 200, JSON.stringify(posted.body));
      return posted.body;
    },
    dispatch: async (item, chosen) => {
      const worker = chosen.principal === workerA.id ? workerA : workerB;
      const claimed = await ok(token(worker.id), 'POST', `work/${item.id}/claim`, {}) as Work;
      herdr.agents = [...herdr.agents.filter(agent => agent.name !== chosen.agentName), { name: chosen.agentName, pane_id: `pane-${chosen.name}`, agent: 'claude', agent_status: 'working' }];
      claims.push(`${item.key}@${chosen.name}`);
      return { pane: `pane-${chosen.name}`, epoch: claimed.epoch };
    },
    persist: async () => {},
  };

  // One cycle: nothing in flight, concurrency 2 — the priority-1 item and the independent
  // priority-2 item leave the backlog; the dependent one stays; the parked one is untouched.
  const state: DaemonState = emptyDaemonState(config);
  await runCycle(config, state, effects);
  assert.deepEqual(released, [first.key, independent.key], 'priority order, dependencies respected');
  assert.deepEqual(claims, [`${first.key}@one`, `${independent.key}@two`], 'both released items are dispatched the same cycle');
  assert.equal((await reload(dependent.id)).ready, false, 'the dependent item is left in the backlog');
  assert.equal((await reload(parked.id)).ready, false, 'a parked item is never released');
  for (const item of [first, independent]) {
    const ledger = await events(item.id);
    assert.ok(ledger.some(event => event.kind === 'ready' && event.actor === loopId), `ready recorded under the loop's own identity on ${item.key}`);
  }
  assert.ok(!(await events(parked.id)).some(event => event.kind === 'ready'), 'no release for the parked item');
  const decision = Object.entries(state.actions).find(([key]) => key.startsWith(`release:${first.id}:`))?.[1];
  assert.equal(decision?.principal, loopId, 'the release decision carries the loop\'s own identity');
  assert.match(decision?.detail ?? '', /keep the pipeline full/);

  // The dependency is done and a slot is free: the very next cycle releases the dependent item.
  await markDone(first.id);
  await runCycle(config, state, effects);
  assert.deepEqual(released, [first.key, independent.key, dependent.key], 'the dependent item is released in the first cycle after its dependency is done and a slot is free');
  assert.equal((await reload(dependent.id)).ready, true);
  assert.equal((await reload(parked.id)).ready, false, 'the parked item is still not released');
  assert.ok(!(await events(parked.id)).some(event => event.kind === 'ready'));
});
