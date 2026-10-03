import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1124: Incremental reconciliation and per-item scaling
// AC-2: A reconciliation pass rereads only documents whose revision changed since its previous batch
// and re-evaluates the items whose own or fleet inputs changed; test counts document reads across a
// pass with one changed item (proof: unit:incremental-reconcile).
// AC-3: Load test with 100 items and 20 concurrent writers keeps p95 request latency under 1 s and a full
// reconciliation pass under 30 s; system invariants and soak pass; npm run build and npm test pass.

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'worker-1', role: 'worker' };

let database: EmbeddedPostgres, store: Store, engine: Engine;
const counts = { documents: 0 };

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1125;
  database = new EmbeddedPostgres({
    databaseDir: await temporaryDirectory('incremental-reconcile'),
    user: 'graphyard',
    password: 'testing-only',
    port,
    persistent: false,
    onLog: () => {},
    onError: () => {},
    postgresFlags: ['-h', '127.0.0.1'],
  });
  await database.initialise();
  await database.start();
  await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`);

  // Intercept queries on the pool to accurately count work_items document reads
  store.pool.on('connect', (client) => {
    const query = (client as { query: (...args: any[]) => any }).query.bind(client);
    (client as { query: (...args: any[]) => any }).query = (...args: any[]) => {
      const [text] = args;
      const isDocRead = typeof text === 'string' && /^\s*select/i.test(text) && /from\s+work_items/i.test(text) && /\bdocument\b/i.test(text);
      const last = args.length - 1;
      if (typeof args[last] === 'function') {
        const done = args[last];
        args[last] = (error: unknown, result: { rowCount?: number }) => {
          if (!error && isDocRead) counts.documents += Number(result?.rowCount ?? 0);
          return done(error, result);
        };
        return query(...args);
      }
      return (async () => {
        const result = await query(...args);
        if (isDocRead) counts.documents += Number((result as { rowCount?: number }).rowCount ?? 0);
        return result;
      })();
    };
  });

  await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [operator, worker];
});

after(async () => {
  if (store) await store.close();
  if (database) await database.stop();
});

test('unit:incremental-reconcile — initial reconciliation pass populates fleet snapshot and version', { timeout: 60_000 }, async () => {
  // Create 20 items
  for (let i = 0; i < 20; i++) {
    await engine.execute(operator, 'create', null, {
      title: `Item ${i}`,
      plannedFiles: ['src/'],
      criteria: [{ id: 'AC-1', text: 'Proof', proofs: ['unit:incremental-reconcile'] }],
    }, randomUUID());
  }

  assert.equal(engine.fleetSnapshot.size, 0, 'fleet snapshot starts empty before first pass');
  counts.documents = 0;

  await engine.reconcile();

  assert.equal(engine.fleetSnapshot.size, 20, 'snapshot populated with all 20 candidate items');
  assert.ok(engine.fleetSnapshotVersion > 0, 'fleetSnapshotVersion initialized to positive revision');
  assert.equal(counts.documents, 20, 'initial pass reads all 20 documents');
});

test('unit:incremental-reconcile — subsequent pass with one changed item rereads only that document', { timeout: 60_000 }, async () => {
  // Take one item from snapshot and update it (bumps revision in work_items and work_index)
  const items = await store.list();
  const target = items[0];

  await engine.execute(operator, 'ready', target.id, {}, randomUUID());

  // Reset count before running reconciliation pass
  counts.documents = 0;

  await engine.reconcile();

  // Exactly 1 document was read from work_items (AC-2 requirement)
  assert.equal(counts.documents, 1, `incremental reconciliation pass reread exactly 1 document (read ${counts.documents})`);
});

test('unit:incremental-reconcile — re-evaluates items whose own or fleet inputs changed', { timeout: 60_000 }, async () => {
  // Create item A and item B where B depends on A
  const itemA = await engine.execute(operator, 'create', null, {
    title: 'Item A dependency target',
    plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Proof A', proofs: ['unit:incremental-reconcile'] }],
  }, randomUUID());

  const itemB = await engine.execute(operator, 'create', null, {
    title: 'Item B dependent',
    plannedFiles: ['src/'],
    dependencies: [itemA.id],
    criteria: [{ id: 'AC-1', text: 'Proof B', proofs: ['unit:incremental-reconcile'] }],
  }, randomUUID());

  // Ready item B: should remain in backlog or blocked because item A is not done
  await engine.execute(operator, 'ready', itemB.id, {}, randomUUID());

  // Expire a lease on item A to verify expired lease triggers re-evaluation
  await engine.execute(operator, 'ready', itemA.id, {}, randomUUID());
  const claimedA = await engine.execute(worker, 'claim', itemA.id, {}, randomUUID());

  // Force expire item A's lease directly in DB
  const expired = { owner: worker.id, epoch: claimedA.lease!.epoch, expiresAt: new Date(Date.now() - 60_000).toISOString() };
  await store.pool.query("UPDATE work_items SET document = jsonb_set(document, '{lease}', $2::jsonb) WHERE id = $1", [itemA.id, JSON.stringify(expired)]);

  counts.documents = 0;
  await engine.reconcile();

  // Item A's expired lease was re-evaluated and cleared
  const reloadedA = (await store.list()).find((w) => w.id === itemA.id)!;
  assert.equal(reloadedA.lease, null, 'item A expired lease was reconciled and cleared');
});

test('unit:incremental-reconcile — full reconciliation pass over 100 items completes in under 30 s', { timeout: 60_000 }, async () => {
  // Add additional items up to 100
  const existingCount = (await store.list()).length;
  for (let i = existingCount; i < 100; i++) {
    await engine.execute(operator, 'create', null, {
      title: `Bulk Item ${i}`,
      plannedFiles: ['src/'],
      criteria: [{ id: 'AC-1', text: 'Bulk Proof', proofs: ['unit:incremental-reconcile'] }],
    }, randomUUID());
  }

  const items = await store.list();
  assert.ok(items.length >= 100, `fleet contains ${items.length} items (>= 100)`);

  const started = performance.now();
  await engine.reconcile();
  const elapsedMs = performance.now() - started;

  assert.ok(elapsedMs < 30_000, `full reconciliation pass took ${Math.round(elapsedMs)} ms, well under 30 s bound`);
});
