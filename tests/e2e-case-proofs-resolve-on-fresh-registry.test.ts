import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { caseDirectory, loadCases, parseCase, scenarioDefinition, syncCases } from '../src/e2e/case.js';
import { substitute } from '../src/e2e/runner.js';

// GY-1800 AC-1: GOAL-1's required cases create work whose criteria cite e2e:fixture-static-home
// (and e2e:fixture-compose-app). Nothing registered either, so every release candidate's uat job
// failed at candidate-batches-five step 1 with 409. Revision 1 of each now ships in
// src/scenarios.ts, so create resolves and pins it on a registry holding no such scenario.
// The new exports are imported inside each test: on a tree without them the cases fail as cases.
const shipped = () => import('../src/scenarios.js');
const fixtureStaticHomeScenario = 'fixture-static-home', fixtureComposeAppScenario = 'fixture-compose-app';

const operator: Principal = { id: 'operator', role: 'admin' };
const token = `operator-${'t'.repeat(32)}`;
const root = new URL('..', import.meta.url).pathname;

let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

before(async () => {
  // Offset 28: free in the reserved 200-port window.
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 28;
  database = new EmbeddedPostgres({
    databaseDir: await temporaryDirectory('e2e-case-proofs-fresh-registry'),
    user: 'graphyard', password: 'testing-only', port, persistent: false,
    onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'],
  });
  await database.initialise(); await database.start(); await database.createDatabase('e2e_case_proofs_fresh_registry');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/e2e_case_proofs_fresh_registry`);
  await store.init();
  engine = new Engine(store, [15368], 120, 'owner/fixture-project');
  http = server(engine, [{ ...operator, token }], null);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
  if (database) await database.stop();
});

/** One request as the runner's http step sends it: bearer token, JSON body, an idempotency key per POST. */
const call = async (path: string, data?: unknown) => {
  const response = await fetch(`${url}${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { status: response.status, body: await response.json() as any };
};
const api = async (path: string, data?: unknown, key: string = randomUUID()) => {
  const response = await fetch(`${url}/api/${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const body = await response.json() as any;
  if (!response.ok) throw Object.assign(new Error(body?.error ?? `HTTP ${response.status}`), { status: response.status });
  return body;
};
const rows = async (id: string) => (await store.pool.query('SELECT revision, document FROM scenarios WHERE id=$1 ORDER BY revision', [id])).rows;

test('unit:e2e-case-proofs-resolve-on-fresh-registry — on a registry holding no scenario named fixture-static-home, POST /api/work with proof e2e:fixture-static-home answers 200 and pins the shipped revision 1', async () => {
  const { shippedScenario } = await shipped();
  for (const id of [fixtureStaticHomeScenario, fixtureComposeAppScenario]) {
    assert.equal((await rows(id)).length, 0, `${id}: the registry starts without it`);
    const shipped = shippedScenario(id);
    assert.ok(shipped, `src/scenarios.ts ships ${id}`);
    assert.equal(shipped.revision, 1);
    assert.equal(shipped.environment, 'any', 'a fixture case runs against a preview, never UAT itself');
    assert.equal(shipped.required, false, 'a fixture case never blocks a release by itself');

    const created = await call('/api/work', {
      title: `Change needing ${id}`, type: 'feature', priority: 3, policy: { checks: ['test'], review: true },
      criteria: [{ id: 'AC-1', text: `The fixture shows the change (${id})`, proofs: [`e2e:${id}`] }],
    });
    assert.equal(created.status, 200, `${id}: ${JSON.stringify(created.body)}`);
    const work = created.body as Work;
    assert.deepEqual(work.scenarioRequirements.map(pin => pin.proof), [`e2e:${id}`], 'the pinned scenarioRequirements name the proof');
    assert.equal(work.scenarioRequirements[0].revision, 1);
    assert.equal(work.scenarioRequirements[0].hash, shipped.hash);
    assert.equal(work.scenarioRequirements[0].environment, 'any');

    // Create persisted the shipped revision as a real row with its audit event, as GY-1708 does for capacity-limit-redispatch.
    const persisted = await rows(id);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].revision, 1);
    assert.equal(persisted[0].document.hash, shipped.hash);
    assert.equal(persisted[0].document.createdBy, operator.id);
    assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM events WHERE kind='scenario.defined' AND payload->'scenario'->>'id'=$1", [id])).rows[0].n, 1);
  }
  const names = await shipped();
  assert.equal(names.fixtureStaticHomeScenario, fixtureStaticHomeScenario);
  assert.equal(names.fixtureComposeAppScenario, fixtureComposeAppScenario);
});

test('unit:e2e-case-proofs-resolve-on-fresh-registry — each shipped fixture revision is exactly its case file under e2e/cases/, which e2e sync then reports unchanged', async () => {
  const { fixtureCases, shippedCaseRevision, shippedScenario } = await shipped();
  assert.ok(fixtureCases, 'src/scenarios.ts ships the fixture cases');
  const loaded = await loadCases(root);
  for (const definition of fixtureCases()) {
    const file = `${caseDirectory}/${definition.id}.json`;
    const fromFile = parseCase(file, await readFile(join(root, file), 'utf8'));
    assert.deepEqual(fromFile, definition, `${file} is the shipped definition`);
    assert.deepEqual(scenarioDefinition({ file, definition: fromFile }), scenarioDefinition({ file, definition }));
    assert.equal(shippedCaseRevision(fromFile).hash, shippedScenario(definition.id)!.hash);
    const entry = loaded.find(candidate => candidate.definition.id === definition.id);
    assert.ok(entry, `loadCases lists ${file}`);
    const [synced] = await syncCases(api, [entry]);
    assert.deepEqual(synced, { id: definition.id, revision: 1, change: 'unchanged' }, 'sync on the materialized row publishes nothing');
    assert.equal((await rows(definition.id)).length, 1);
  }
});

test('unit:e2e-case-proofs-resolve-on-fresh-registry — every POST /api/work step of a uat case under e2e/cases/ creates with the status the case expects, candidate-batches-five step 1 first', async () => {
  const cases = (await loadCases(root)).filter(entry => entry.definition.target === 'uat');
  const batches = cases.find(entry => entry.definition.id === 'candidate-batches-five');
  assert.ok(batches, 'GOAL-1 ships candidate-batches-five');
  const first = batches.definition.steps[0];
  assert.ok(first.kind === 'http' && first.name === 'create ready change 1' && first.path === '/api/work' && first.status === 200);
  let creates = 0;
  for (const entry of cases) for (const [index, step] of entry.definition.steps.entries()) {
    if (step.kind !== 'http' || step.method !== 'POST' || step.path !== '/api/work') continue;
    const vars = { case: entry.definition.id, run: `gy-1800-${index}-${randomUUID().slice(0, 8)}`, token };
    let body: unknown;
    try { body = substitute(step.body, vars); } catch { continue; } // a body naming an earlier step's saved value is that step's to supply
    const answer = await call(step.path, body);
    assert.equal(answer.status, step.status, `${entry.file} step ${index + 1} (${step.name ?? 'POST /api/work'}): ${JSON.stringify(answer.body)}`);
    creates++;
  }
  assert.ok(creates >= 10, `the required cases create through the shipped scenarios (${creates} creates)`);
});
