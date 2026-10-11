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
import { caseDirectory, loadCases, parseCase, scenarioDefinition } from '../src/e2e/case.js';
import {
  capacityLimitRedispatchRevision,
  capacityLimitRedispatchScenario,
  resolveScenario,
  shippedScenario,
} from '../src/scenarios.js';

// GY-1708 AC-3: capacity-limit-redispatch ships as revision 1 in src/scenarios.ts so create accepts
// e2e:capacity-limit-redispatch without a test-only e2e sync (the loop's own filing path).

const operator: Principal = { id: 'operator', role: 'admin' };
const tokens = new Map([[operator.id, `operator-${'t'.repeat(32)}`]]);
const root = new URL('..', import.meta.url).pathname;

let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1708;
  database = new EmbeddedPostgres({
    databaseDir: await temporaryDirectory('scenario-capacity-redispatch'),
    user: 'graphyard', password: 'testing-only', port, persistent: false,
    onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'],
  });
  await database.initialise(); await database.start(); await database.createDatabase('scenario_capacity_redispatch');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/scenario_capacity_redispatch`);
  await store.init();
  engine = new Engine(store, [15368], 120, 'owner/capacity-redispatch');
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

test('unit:scenario-capacity-limit-redispatch-registered — revision 1 ships in src/scenarios.ts and create accepts e2e:capacity-limit-redispatch without e2e sync', async () => {
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

  // No syncCases: create must succeed from the shipped revision alone (AC-3).
  const before = await api('scenarios') as { id: string; revision: number }[];
  assert.ok(before.some(entry => entry.id === id && entry.revision === 1), 'listing surfaces the shipped revision before sync');
  assert.equal((await store.pool.query('SELECT 1 FROM scenarios WHERE id=$1', [id])).rowCount, 0, 'the table is empty until create persists the shipped revision');

  await assert.rejects(
    api('work', {
      title: 'Unregistered sibling',
      plannedFiles: ['src/scenarios.ts'],
      criteria: [{ id: 'AC-1', text: 'needs a missing scenario', proofs: ['e2e:not-a-registered-scenario'] }],
    }),
    /Register E2E scenario not-a-registered-scenario/,
  );

  const pinned = await api('work', {
    title: 'Pinned to capacity-limit-redispatch',
    plannedFiles: ['src/scenarios.ts'],
    criteria: [{ id: 'AC-1', text: 'capacity-limit-redispatch is registered', proofs: [`e2e:${id}`] }],
  }) as Work;
  assert.equal(pinned.scenarioRequirements.length, 1);
  assert.equal(pinned.scenarioRequirements[0].proof, `e2e:${id}`);
  assert.equal(pinned.scenarioRequirements[0].revision, 1);
  assert.equal(pinned.scenarioRequirements[0].hash, shipped.hash);

  const persisted = await resolveScenario(store.pool, id);
  assert.ok(persisted, 'create persisted the shipped revision into the scenarios table');
  assert.equal(persisted.revision, 1);
  assert.equal(persisted.hash, shipped.hash);
  assert.equal((await store.pool.query('SELECT revision FROM scenarios WHERE id=$1', [id])).rows[0].revision, 1);
});
