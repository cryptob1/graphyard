import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1124 AC-2: a reconciliation pass rereads only the documents whose row changed since the
// previous pass and re-evaluates the items whose own or fleet inputs changed. The documents are
// counted at the database connection, whatever query read them. AC-3: a full pass over 100 items
// stays under 30 s.

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'worker-1', role: 'worker' };

let database: EmbeddedPostgres, store: Store, engine: Engine;
/** Documents of work_items read by any query, counted from the rows each result returned. */
let documentsRead = 0;
const documentQuery = (text: unknown) => typeof text === 'string' && /\bfrom\s+work_items\b/i.test(text) && /\bdocument\b/i.test(text.split(/\bfrom\b/i)[0]) && /^\s*select/i.test(text);

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 125;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('incremental-reconcile'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise();
  await database.start();
  await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`);
  for (const pool of [store.pool, store.leasePool]) pool.on('connect', client => {
    const query = client.query.bind(client) as (...args: unknown[]) => Promise<{ rowCount: number | null }>;
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = async (...args: unknown[]) => {
      const result = await query(...args);
      const text = typeof args[0] === 'object' && args[0] !== null ? (args[0] as { text?: string }).text : args[0];
      if (documentQuery(text)) documentsRead += Number(result?.rowCount ?? 0);
      return result;
    };
  });
  await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [operator, worker];
  // Only the clock-driven catch-up is full here; each test says when it wants one.
  engine.reconcileFullEvaluationMs = 300_000;
});

after(async () => {
  await store?.close();
  await database?.stop();
});

let created = 0;
const create = (extra: Record<string, unknown> = {}) => engine.execute(operator, 'create', null, { title: `Incremental ${++created}`, plannedFiles: [`src/incremental-${created}.ts`], criteria: [{ id: 'AC-1', text: 'Holds', proofs: ['unit:incremental-reconcile'] }], ...extra }, randomUUID());
async function pass() {
  documentsRead = 0;
  await engine.reconcile();
  // The engine's own count of what it read agrees with what reached the database.
  assert.equal(engine.lastReconcile.documentsRead, documentsRead);
  return engine.lastReconcile;
}

test('unit:incremental-reconcile a pass after one heartbeat rereads that one document and evaluates that one item', { timeout: 120_000 }, async () => {
  const items: Work[] = [];
  for (let n = 0; n < 20; n++) items.push(await create());
  await engine.execute(operator, 'ready', items[0].id, {}, randomUUID());
  const work = await engine.execute(worker, 'claim', items[0].id, {}, randomUUID());
  engine.resetReconcileView();
  const first = await pass();
  assert.ok(first.full, 'the first pass of a process is full');
  assert.equal(first.documentsRead, 20, 'it reads every live document once');
  assert.equal(first.evaluated, 20);
  // The first pass's own writes are inputs to the fleet, so the pass after it may evaluate everything again; then it settles.
  let quiet = await pass();
  for (let n = 0; n < 4 && quiet.evaluated; n++) quiet = await pass();
  // Quiet: nothing moved, so nothing is read again and nothing is evaluated.
  assert.deepEqual([quiet.documentsRead, quiet.evaluated, quiet.full], [0, 0, false]);

  await engine.execute(worker, 'heartbeat', work.id, { epoch: work.lease!.epoch }, randomUUID());
  const renewed = await pass();
  assert.equal(renewed.documentsRead, 1, 'only the renewed item is read again');
  assert.equal(renewed.evaluated, 1, 'a renewal moves no other item\'s inputs, so only the renewed item is evaluated');
});

test('unit:incremental-reconcile a change other items read re-evaluates the fleet but still rereads one document', { timeout: 120_000 }, async () => {
  const blocker = await create();
  await create({ dependencies: [blocker.id] });
  for (let n = 0; n < 5 && (await pass()).evaluated; n++);
  await engine.execute(operator, 'ready', blocker.id, {}, randomUUID());
  const moved = await pass();
  assert.equal(moved.documentsRead, 1, 'only the changed item is read again');
  assert.equal(moved.evaluated, moved.live, 'its dependents and the rest of the fleet are evaluated against it');
  assert.ok(moved.live > 2);
});

test('unit:incremental-reconcile a write outside the commands, and a lapsed lease, are reconciled', { timeout: 120_000 }, async () => {
  const item = await create();
  await engine.execute(operator, 'ready', item.id, {}, randomUUID());
  const work = await engine.execute(worker, 'claim', item.id, {}, randomUUID());
  await pass();
  // A raw write that bumps no revision still moves the row's version.
  await store.pool.query("UPDATE work_items SET document = jsonb_set(document, '{lease,expiresAt}', to_jsonb($2::text)) WHERE id = $1", [work.id, new Date(Date.now() - 60_000).toISOString()]);
  const lapsed = await pass();
  assert.equal(lapsed.documentsRead, 1);
  const stored = (await store.list()).find(entry => entry.id === work.id)!;
  assert.equal(stored.lease, null, 'the lapsed lease was reconciled from the reread document');
});

test('unit:incremental-reconcile the clock-driven catch-up and a reset view evaluate every live item', { timeout: 120_000 }, async () => {
  await pass();
  engine.reconcileFullEvaluationMs = 2_000;
  await new Promise(resolve => setTimeout(resolve, 2_100));
  const caughtUp = await pass();
  assert.ok(caughtUp.full && caughtUp.evaluated === caughtUp.live, 'every live item is evaluated once the full-evaluation bound passes');
  assert.equal(caughtUp.documentsRead, 0, 'a catch-up evaluates the kept view without reading documents again');
  engine.reconcileFullEvaluationMs = 300_000;
});

test('unit:incremental-reconcile a full pass over 100 items completes in under 30 s', { timeout: 300_000 }, async () => {
  for (let n = (await store.list()).length; n < 100; n++) await create();
  engine.resetReconcileView();
  const started = performance.now();
  const full = await pass();
  const elapsed = performance.now() - started;
  assert.ok(full.full && full.live >= 100 && full.evaluated === full.live, `evaluated ${full.evaluated} of ${full.live}`);
  assert.ok(elapsed < 30_000, `a full pass took ${Math.round(elapsed)} ms`);
});
