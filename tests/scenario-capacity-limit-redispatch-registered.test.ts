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

// GY-1708 AC-3: the capacity-limit-redispatch e2e case registers as a scenario revision so create
// accepts e2e:capacity-limit-redispatch (the fault-class filing the loop previously refused).

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

test('unit:scenario-capacity-limit-redispatch-registered — the shipped e2e case syncs to a scenario revision and create accepts e2e:capacity-limit-redispatch', async () => {
  const id = 'capacity-limit-redispatch';
  const scenarios = await import('../src/scenarios.js') as { capacityLimitRedispatchScenario?: string };
  assert.equal(scenarios.capacityLimitRedispatchScenario, id, 'src/scenarios.ts exports the scenario id filings cite');
  const file = join(root, caseDirectory, `${id}.json`);
  assert.ok(existsSync(file), `e2e/cases/${id}.json must be shipped so e2e sync can register a revision`);
  const definition = parseCase(`e2e/cases/${id}.json`, await readFile(file, 'utf8'));
  assert.equal(definition.id, id);
  assert.equal(definition.required, false, 'the case is optional: it registers the scenario, it does not block releases');
  assert.equal(definition.target, 'any');

  const shipped = (await loadCases(root)).find(entry => entry.definition.id === id);
  assert.ok(shipped, 'loadCases includes the shipped capacity-limit-redispatch case');
  const [synced] = await syncCases(api, [shipped!]);
  assert.equal(synced.id, id);
  assert.equal(synced.change, 'created');
  assert.equal(synced.revision, 1);

  const registry = await api('scenarios') as { id: string; revision: number; testPath: string; runner: string }[];
  const revision = registry.find(entry => entry.id === id && entry.revision === 1);
  assert.ok(revision, 'src/scenarios.ts holds revision 1 after e2e sync');
  assert.equal(revision.testPath, `e2e/cases/${id}.json`);
  assert.equal(revision.runner, 'graphyard-e2e');
  assert.equal(scenarioDefinition(shipped!).id, id);

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
});
