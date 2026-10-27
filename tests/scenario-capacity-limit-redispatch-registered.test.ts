import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { caseDirectory, loadCases, parseCase, scenarioDefinition, syncCases } from '../src/e2e/case.js';
import {
  capacityLimitRedispatchRevision,
  capacityLimitRedispatchScenario,
  ensureShippedScenarios,
  recordCaseRun,
  resolveScenario,
  scenarios,
  shippedScenario,
} from '../src/scenarios.js';

import { defaultRepositoryPolicy, setRepositoryPolicy } from '../src/model/repository-policy.js';
// GY-2965: the fixtures create items carrying e2e: proofs, so this process declares the serve the trial would use.
setRepositoryPolicy({ ...defaultRepositoryPolicy, e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// GY-1708 AC-3: capacity-limit-redispatch ships as revision 1 in src/scenarios.ts; listing, create
// and run-recording materialize it so filings, e2e sync and case runs work without a prior sync.

const operator: Principal = { id: 'operator', role: 'admin' };
const tokens = new Map([[operator.id, `operator-${'t'.repeat(32)}`]]);
const root = new URL('..', import.meta.url).pathname;

let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 175;
  database = new EmbeddedPostgres({
    databaseDir: await temporaryDirectory('scenario-capacity-redispatch'),
    user: 'graphyard', password: 'testing-only', port, persistent: false,
    onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'],
  });
  await database.initialise(); await database.start(); await database.createDatabase('scenario_capacity_redispatch');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/scenario_capacity_redispatch`);
  await store.init();
  // The shipped scenarios are Graphyard's own repository's cases (GY-2964): this install manages
  // that repository, which is the one whose fresh install materializes them.
  engine = new Engine(store, 120, 'cryptob1/graphyard');
  http = server(engine, [{ ...operator, token: tokens.get(operator.id)! }], null);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
  if (database) await database.stop();
});

const api = async (path: string, data?: unknown, key: string = randomUUID()) => {
  const response = await fetch(`${url}/api/${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${tokens.get(operator.id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const body = await response.json() as any;
  if (!response.ok) throw Object.assign(new Error(body?.error ?? `HTTP ${response.status}`), { status: response.status });
  return body;
};

test('unit:scenario-capacity-limit-redispatch-registered — revision 1 ships in src/scenarios.ts; listing materializes it; create, sync and run-recording work on a fresh install without a prior sync', async () => {
  const id = capacityLimitRedispatchScenario;
  assert.equal(id, 'capacity-limit-redispatch');
  const shipped = shippedScenario(id);
  assert.ok(shipped, 'src/scenarios.ts ships revision 1');
  assert.equal(shipped.revision, 1);
  assert.equal(shipped.runner, 'graphyard-e2e');
  assert.equal(shipped.testPath, `e2e/cases/${id}.json`);
  assert.equal(capacityLimitRedispatchRevision().hash, shipped.hash);

  const file = join(root, caseDirectory, `${id}.json`);
  assert.ok(existsSync(file), `e2e/cases/${id}.json must ship beside the revision`);
  const definition = parseCase(`e2e/cases/${id}.json`, await readFile(file, 'utf8'));
  assert.equal(definition.required, false, 'the case is optional: it never blocks releases');
  assert.equal(definition.target, 'any');
  assert.ok(!definition.steps.some(step => step.kind === 'http' && step.method === 'POST' && step.path === '/api/work'),
    'the case must not create backlog items on every run');
  const fromCase = scenarioDefinition({ file: `e2e/cases/${id}.json`, definition });
  assert.equal(fromCase.id, shipped.id);
  assert.equal(fromCase.title, shipped.title);
  assert.equal(fromCase.purpose, shipped.purpose);
  assert.deepEqual(fromCase.steps, shipped.steps);
  assert.deepEqual(fromCase.expected, shipped.expected);
  assert.equal(fromCase.environment, shipped.environment);
  assert.deepEqual(fromCase.tags, shipped.tags);
  assert.equal(fromCase.required, shipped.required);

  const loaded = (await loadCases(root)).find(entry => entry.definition.id === id);
  assert.ok(loaded, 'loadCases includes the shipped capacity-limit-redispatch case');

  // Fresh install: the table is empty until listing materializes the shipped revision.
  assert.equal((await store.pool.query('SELECT 1 FROM scenarios WHERE id=$1', [id])).rowCount, 0, 'the table starts empty');

  const listed = await api('scenarios') as { id: string; revision: number; hash: string }[];
  assert.ok(listed.some(entry => entry.id === id && entry.revision === 1), 'listing surfaces the shipped revision');
  assert.equal((await store.pool.query('SELECT revision FROM scenarios WHERE id=$1', [id])).rows[0].revision, 1,
    'listing materializes revision 1 into the scenarios table');
  assert.equal((await store.pool.query('SELECT document FROM scenarios WHERE id=$1 AND revision=1', [id])).rows[0].document.hash, shipped.hash);
  const defined = (await store.pool.query(
    "SELECT payload FROM events WHERE kind='scenario.defined' AND payload->'scenario'->>'id'=$1 ORDER BY seq",
    [id],
  )).rows;
  assert.equal(defined.length, 1, 'materializing appends scenario.defined once');
  assert.equal(defined[0].payload.scenario.revision, 1);
  assert.equal(defined[0].payload.scenario.hash, shipped.hash);

  // e2e sync on a fresh install sees the materialized row and reports unchanged — not a virtual
  // GET-only match that would leave the table empty.
  const [synced] = await syncCases(api, [loaded]);
  assert.deepEqual(synced, { id, revision: 1, change: 'unchanged' });
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM scenarios WHERE id=$1', [id])).rows[0].n, 1);

  // Run recording looks up revision 1 in the table (the path that 404'd on a virtual-only registry).
  const run = await recordCaseRun(store, operator, id, {
    revision: 1,
    runId: `capacity-redispatch-${randomUUID()}`,
    baseUrl: url,
    sha: null,
    environment: 'any',
    durationMs: 12,
    outcome: 'pass',
    executed: 2,
    failingStep: null,
  });
  assert.equal(run.scenarioId, id);
  assert.equal(run.scenarioRevision, 1);
  assert.equal(run.result, 'pass');
  assert.equal(run.run.kind, 'e2e');

  await assert.rejects(
    api('work', {
      type: 'chore',
      title: 'Unregistered sibling',
      criteria: [{ id: 'AC-1', text: 'needs a missing scenario', proofs: ['e2e:not-a-registered-scenario'] }],
    }),
    /Register E2E scenario not-a-registered-scenario/,
  );

  const pinned = await api('work', {
    type: 'chore',
    title: 'Pinned to capacity-limit-redispatch',
    criteria: [{ id: 'AC-1', text: 'capacity-limit-redispatch is registered', proofs: [`e2e:${id}`] }],
  }) as Work;
  assert.equal(pinned.scenarioRequirements.length, 1);
  assert.equal(pinned.scenarioRequirements[0].proof, `e2e:${id}`);
  assert.equal(pinned.scenarioRequirements[0].revision, 1);
  assert.equal(pinned.scenarioRequirements[0].hash, shipped.hash);
  assert.equal((await resolveScenario(store.pool, id))!.hash, shipped.hash);

  // An edit after materialization revises with expectedRevision 1 (the fresh-install sync path
  // that used to send expectedRevision 1 against an empty table and get refused).
  const edited = {
    ...loaded,
    definition: { ...loaded.definition, title: `${loaded.definition.title} (edited before next sync)` },
  };
  const [revised] = await syncCases(api, [edited]);
  assert.deepEqual(revised, { id, revision: 2, change: 'revised' });
});

test('unit:scenario-capacity-limit-redispatch-registered — recordCaseRun materializes a shipped revision when the table is still empty', async () => {
  const id = capacityLimitRedispatchScenario;
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 176;
  const database = new EmbeddedPostgres({
    databaseDir: await temporaryDirectory('scenario-capacity-redispatch-record'),
    user: 'graphyard', password: 'testing-only', port, persistent: false,
    onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'],
  });
  await database.initialise(); await database.start(); await database.createDatabase('scenario_capacity_redispatch_record');
  const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/scenario_capacity_redispatch_record`);
  try {
    await store.init();
    assert.equal((await store.pool.query('SELECT 1 FROM scenarios WHERE id=$1', [id])).rowCount, 0);
    const run = await recordCaseRun(store, operator, id, {
      revision: 1,
      runId: `capacity-redispatch-empty-${randomUUID()}`,
      baseUrl: 'http://127.0.0.1:9',
      sha: null,
      environment: 'any',
      durationMs: 1,
      outcome: 'pass',
      executed: 1,
      failingStep: null,
    });
    assert.equal(run.scenarioRevision, 1);
    assert.equal((await store.pool.query('SELECT revision FROM scenarios WHERE id=$1', [id])).rows[0].revision, 1,
      'recordCaseRun materializes revision 1 before looking it up');
    assert.equal((await store.pool.query(
      "SELECT count(*)::int AS n FROM events WHERE kind='scenario.defined' AND payload->'scenario'->>'id'=$1",
      [id],
    )).rows[0].n, 1, 'materializing appends scenario.defined');
  } finally {
    await store.close();
    await database.stop();
  }
});

test('unit:scenario-capacity-limit-redispatch-registered — listing materializes through one transaction: a failed scenario.defined rolls the revision back', async () => {
  const id = capacityLimitRedispatchScenario;
  // Offset 16: free in the reserved 200-port window (177 collides with event-ledger-delta).
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 16;
  const database = new EmbeddedPostgres({
    databaseDir: await temporaryDirectory('scenario-capacity-redispatch-tx'),
    user: 'graphyard', password: 'testing-only', port, persistent: false,
    onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'],
  });
  await database.initialise(); await database.start(); await database.createDatabase('scenario_capacity_redispatch_tx');
  const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/scenario_capacity_redispatch_tx`);
  try {
    await store.init();
    assert.equal((await store.pool.query('SELECT 1 FROM scenarios WHERE id=$1', [id])).rowCount, 0);
    await assert.rejects(
      store.transaction(async db => {
        const original = db.query.bind(db);
        db.query = ((sql: string | { text: string }, params?: unknown[]) => {
          const text = typeof sql === 'string' ? sql : sql.text;
          if (text.startsWith('INSERT INTO events(')) return Promise.reject(new Error('forced scenario.defined failure'));
          return original(sql as string, params);
        }) as typeof db.query;
        await ensureShippedScenarios(db);
      }),
      /forced scenario\.defined failure/,
    );
    assert.equal((await store.pool.query('SELECT 1 FROM scenarios WHERE id=$1', [id])).rowCount, 0,
      'a failed event write must not leave a durable scenario row');
    assert.equal((await store.pool.query(
      "SELECT count(*)::int AS n FROM events WHERE kind='scenario.defined' AND payload->'scenario'->>'id'=$1",
      [id],
    )).rows[0].n, 0, 'the failed append leaves no scenario.defined either');
    // A later listing retries the same path and lands both writes together.
    const listed = await scenarios(store);
    assert.ok(listed.some(entry => entry.id === id && entry.revision === 1));
    assert.equal((await store.pool.query('SELECT revision FROM scenarios WHERE id=$1', [id])).rows[0].revision, 1);
    assert.equal((await store.pool.query(
      "SELECT count(*)::int AS n FROM events WHERE kind='scenario.defined' AND payload->'scenario'->>'id'=$1",
      [id],
    )).rows[0].n, 1);
  } finally {
    await store.close();
    await database.stop();
  }
});
