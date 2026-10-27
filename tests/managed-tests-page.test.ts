import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmbeddedPostgres from 'embedded-postgres';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal } from '../src/model.js';
import { caseDirectory, loadCases, syncCases } from '../src/e2e/case.js';
import { TestsView } from '../web/pages/tests.js';

// GY-2964: a managed repository's Tests page lists that repository's own end-to-end cases, never
// Graphyard's seeded built-in scenarios. The built-in scenario revisions ship in code and are
// materialized only for an install managing Graphyard's own repository (cryptob1/graphyard); an
// install managing another repository registers exactly the cases synced from its e2e/cases/, and
// with none the page shows the empty state that says how to add one.

const game = 'owner/openworld';
const operator: Principal = { id: 'operator', role: 'admin' };
const tokens = new Map([[operator.id, `operator-${'t'.repeat(32)}`]]);

let database: EmbeddedPostgres, gameStore: Store, gameEngine: Engine, gameHttp: ReturnType<typeof server>, gameUrl: string,
  gyStore: Store, gyEngine: Engine, gyHttp: ReturnType<typeof server>, gyUrl: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 3011;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('managed-tests-page'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start();
  await database.createDatabase('managed_tests_game'); await database.createDatabase('managed_tests_graphyard');
  // The managed install: a fixture repository that is not Graphyard's own.
  gameStore = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/managed_tests_game`); await gameStore.init();
  gameEngine = new Engine(gameStore, 120, game);
  gameHttp = server(gameEngine, [{ ...operator, token: tokens.get(operator.id)! }], null);
  await new Promise<void>(resolve => gameHttp.listen(0, '127.0.0.1', resolve));
  gameUrl = `http://127.0.0.1:${(gameHttp.address() as any).port}`;
  // The control plane for Graphyard's own repository.
  gyStore = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/managed_tests_graphyard`); await gyStore.init();
  gyEngine = new Engine(gyStore, 120, 'cryptob1/graphyard');
  gyHttp = server(gyEngine, [{ ...operator, token: tokens.get(operator.id)! }], null);
  await new Promise<void>(resolve => gyHttp.listen(0, '127.0.0.1', resolve));
  gyUrl = `http://127.0.0.1:${(gyHttp.address() as any).port}`;
});
after(async () => {
  for (const http of [gameHttp, gyHttp]) if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  for (const store of [gameStore, gyStore]) if (store) await store.close();
  if (database) await database.stop();
});

/** The CLI's authenticated request helper, against one control plane. */
const apiFor = (url: string) => async (path: string, data?: unknown, key: string = randomUUID()) => {
  const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${tokens.get(operator.id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: data === undefined ? undefined : JSON.stringify(data) });
  const body = await response.json() as any;
  if (!response.ok) throw Object.assign(new Error(body?.error ?? `HTTP ${response.status}`), { status: response.status });
  return body;
};
// Read the bound URLs at call time: the servers listen in `before`.
const gameApi: ReturnType<typeof apiFor> = (path, data, key) => apiFor(gameUrl)(path, data, key);
const gyApi: ReturnType<typeof apiFor> = (path, data, key) => apiFor(gyUrl)(path, data, key);

/** A scratch repository holding the given case files under e2e/cases/. */
async function repository(files: Record<string, unknown>) {
  const dir = await temporaryDirectory('managed-tests-cases');
  await mkdir(join(dir, caseDirectory), { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, caseDirectory, name), JSON.stringify(content, null, 2));
  return dir;
}
const caseFile = (id: string) => ({ id, title: `Case ${id}`, tags: ['api'], target: 'uat', steps: [{ kind: 'http', method: 'GET', path: '/healthz', status: 200 }] });
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const noop = () => {};

test('unit:managed-tests-page-lists-repository-cases-only — a managed repository lists only the cases its own e2e/cases/ synced, never Graphyard\'s built-in scenarios; the Graphyard install still lists them', async () => {
  // The registry listing is the read that materializes shipped revisions; a managed repository ships none.
  assert.deepEqual((await gameApi('scenarios')).map((scenario: any) => scenario.id), [], 'no built-in scenario is registered for the managed repository');
  const empty = await gameApi('tests');
  assert.deepEqual(empty.cases, [], '/api/tests answers no cases before the repository has any');
  const page = text(renderToStaticMarkup(createElement(TestsView, { data: empty, error: '', loading: false, filter: 'all', setFilter: noop, retry: noop, api: async () => ({}), canEdit: false })));
  assert.match(page, /No test cases yet/, 'the empty state, with no fabricated rows');
  assert.match(page, /e2e\/cases\/ID\.json/, 'it names the e2e/cases/ format a case is added as');
  assert.match(page, /graphyard e2e run/, 'it names the command that records a run');
  assert.ok(!page.includes('capacity-limit-redispatch') && !page.includes('fixture-static-home') && !page.includes('fixture-compose-app'), 'no seeded fixture case is named');

  // Two cases under the fixture's e2e/cases/: exactly those two are listed, each with a real timestamp.
  const dir = await repository({ 'cart-total.json': caseFile('cart-total'), 'home-answers.json': caseFile('home-answers') });
  const synced = await syncCases(gameApi, await loadCases(dir));
  assert.deepEqual(synced.map(entry => [entry.id, entry.change]).sort(), [['cart-total', 'created'], ['home-answers', 'created']]);
  const listed = await gameApi('tests');
  assert.deepEqual(listed.cases.map((entry: any) => entry.id).sort(), ['cart-total', 'home-answers'], 'exactly the repository\'s own two cases');
  for (const entry of listed.cases as any[]) {
    assert.ok(Date.parse(entry.changed.at) > 0, `${entry.id}: a synced revision carries a real timestamp, not ${entry.changed.at}`);
    assert.equal(entry.changed.by, 'operator');
  }

  // Graphyard's own repository install still lists the built-in scenarios, each with a real timestamp.
  await gyApi('scenarios');
  const gyTests = await gyApi('tests');
  const ids = (gyTests.cases as any[]).map(entry => entry.id);
  for (const id of ['capacity-limit-redispatch', 'fixture-static-home', 'fixture-compose-app']) assert.ok(ids.includes(id), `the Graphyard repository install lists the built-in ${id}`);
  for (const entry of (gyTests.cases as any[]).filter(({ id }) => ['capacity-limit-redispatch', 'fixture-static-home', 'fixture-compose-app'].includes(id)))
    assert.ok(Date.parse(entry.changed.at) > 0, `a seeded revision carries a real timestamp, not ${entry.changed.at}`);
});
