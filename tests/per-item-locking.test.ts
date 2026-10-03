import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { advisoryLocks } from '../src/store/locks.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1124: Writes to different items run in parallel and reconciliation rereads only what changed,
// so the server scales with load instead of serialising on one lock.
// AC-1: Two commands on different items that do not read fleet state run concurrently (neither waits
// for the other's lock), commands that read fleet state still serialise, and no lock-order deadlock
// occurs; test against a real database drives concurrent heartbeats on different items alongside a dispatch.
// AC-3: Load test with 100 items and 20 concurrent writers keeps p95 request latency under 1 s and a full
// reconciliation pass under 30 s.

const operator: Principal = { id: 'operator', role: 'admin' };
const worker1: Principal = { id: 'worker-1', role: 'worker' };
const worker2: Principal = { id: 'worker-2', role: 'worker' };

let database: EmbeddedPostgres, store: Store, engine: Engine;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1124;
  database = new EmbeddedPostgres({
    databaseDir: await temporaryDirectory('per-item-locking'),
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
  await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [operator, worker1, worker2];
});

after(async () => {
  if (store) await store.close();
  if (database) await database.stop();
});

test('unit:per-item-locking — concurrent heartbeats on different items run alongside a dispatch without blocking', { timeout: 60_000 }, async () => {
  // Setup two items, both claimed and leased
  const item1 = await engine.execute(operator, 'create', null, { title: 'Item 1', plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Criterion 1', proofs: ['unit:per-item-locking'] }] }, randomUUID());
  const item2 = await engine.execute(operator, 'create', null, { title: 'Item 2', plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Criterion 2', proofs: ['unit:per-item-locking'] }] }, randomUUID());

  await engine.execute(operator, 'ready', item1.id, {}, randomUUID());
  await engine.execute(operator, 'ready', item2.id, {}, randomUUID());

  const claimed1 = await engine.execute(worker1, 'claim', item1.id, {}, randomUUID());
  const claimed2 = await engine.execute(worker2, 'claim', item2.id, {}, randomUUID());

  assert.equal(claimed1.lease?.owner, 'worker-1');
  assert.equal(claimed2.lease?.owner, 'worker-2');

  // Start a dispatch operation holding the fleet lock for 1000 ms
  let dispatchHolding = false;
  let dispatchDone = false;
  const dispatch = store.transaction(async (db) => {
    dispatchHolding = true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    dispatchDone = true;
  }, { fleetLock: true });

  // Wait until dispatch transaction is holding the fleet lock
  for (let waited = 0; !dispatchHolding && waited < 5_000; waited += 10) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(dispatchHolding, 'dispatch acquired and is holding the fleet lock');
  assert.ok(!dispatchDone, 'dispatch is still in flight');

  // Concurrently execute heartbeats on item1 and item2 while dispatch is holding the fleet lock
  const startHeartbeats = Date.now();
  const [hb1, hb2] = await Promise.all([
    engine.execute(worker1, 'heartbeat', item1.id, { epoch: claimed1.lease!.epoch }, randomUUID()),
    engine.execute(worker2, 'heartbeat', item2.id, { epoch: claimed2.lease!.epoch }, randomUUID()),
  ]);
  const heartbeatDuration = Date.now() - startHeartbeats;

  // Heartbeats took per-item locks and ran concurrently without waiting for dispatch's fleet lock
  assert.ok(heartbeatDuration < 600, `heartbeats completed in ${heartbeatDuration} ms while dispatch held fleet lock for 1000 ms`);
  assert.ok(!dispatchDone, 'heartbeats finished BEFORE dispatch finished');

  assert.ok(Date.parse(hb1.lease!.expiresAt) > Date.parse(claimed1.lease!.expiresAt), 'item 1 lease extended');
  assert.ok(Date.parse(hb2.lease!.expiresAt) > Date.parse(claimed2.lease!.expiresAt), 'item 2 lease extended');

  await dispatch;
  assert.ok(dispatchDone, 'dispatch completed cleanly');
});

test('unit:per-item-locking — commands that read fleet state still serialise on the fleet lock', { timeout: 60_000 }, async () => {
  let firstHolding = false;
  let firstCompletedAt = 0;
  let secondStartedAt = 0;

  const first = store.transaction(async () => {
    firstHolding = true;
    await new Promise((resolve) => setTimeout(resolve, 300));
    firstCompletedAt = Date.now();
  }, { fleetLock: true });

  for (let waited = 0; !firstHolding && waited < 5_000; waited += 10) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const second = store.transaction(async () => {
    secondStartedAt = Date.now();
  }, { fleetLock: true });

  await Promise.all([first, second]);

  assert.ok(secondStartedAt >= firstCompletedAt, `second fleet command waited for first (started at ${secondStartedAt}, first finished at ${firstCompletedAt})`);
});

test('unit:per-item-locking — fixed fleet-then-item acquisition order prevents deadlocks under concurrent load', { timeout: 60_000 }, async () => {
  const itemA = await engine.execute(operator, 'create', null, { title: 'Deadlock item A', plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'OK', proofs: ['unit:per-item-locking'] }] }, randomUUID());
  const itemB = await engine.execute(operator, 'create', null, { title: 'Deadlock item B', plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'OK', proofs: ['unit:per-item-locking'] }] }, randomUUID());

  // Drive concurrent operations mixing fleet lock and per-item locks in varying orders
  const operations = Array.from({ length: 40 }, (_, i) => {
    const item = i % 2 === 0 ? itemA.id : itemB.id;
    const isFleet = i % 3 === 0;
    return store.transaction(async (db) => {
      await new Promise((resolve) => setTimeout(resolve, 5 + (i % 5)));
      return i;
    }, { fleetLock: isFleet, itemLock: item });
  });

  const results = await Promise.all(operations);
  assert.equal(results.length, 40, 'all concurrent mixed operations completed without deadlock');
});

test('unit:per-item-locking — load test with 100 items and 20 concurrent writers keeps p95 latency under 1 s', { timeout: 120_000 }, async () => {
  const items: Work[] = [];
  for (let n = 0; n < 100; n++) {
    const item = await engine.execute(operator, 'create', null, {
      title: `Scale Load Item ${n}`,
      plannedFiles: ['src/'],
      criteria: [{ id: 'AC-1', text: 'Scale Proof', proofs: ['unit:per-item-locking'] }],
    }, randomUUID());
    items.push(item);
  }
  assert.equal(items.length, 100, '100 items created');

  // Ready all items
  for (const item of items) {
    await engine.execute(operator, 'ready', item.id, {}, randomUUID());
  }

  // 20 concurrent workers claiming and heartbeating items
  const workers: Principal[] = Array.from({ length: 20 }, (_, i) => ({ id: `load-worker-${i}`, role: 'worker' }));
  engine.principals = [operator, worker1, worker2, ...workers];

  const latencies: number[] = [];
  const writerTasks = workers.map(async (w, workerIdx) => {
    // Each worker operates on 5 distinct items (20 * 5 = 100 items total)
    const assignedItems = items.slice(workerIdx * 5, workerIdx * 5 + 5);
    for (const item of assignedItems) {
      // Claim item
      const startClaim = performance.now();
      const claimed = await engine.execute(w, 'claim', item.id, {}, randomUUID());
      latencies.push(performance.now() - startClaim);

      // Heartbeat 2 times
      for (let h = 0; h < 2; h++) {
        const startHb = performance.now();
        await engine.execute(w, 'heartbeat', item.id, { epoch: claimed.lease!.epoch }, randomUUID());
        latencies.push(performance.now() - startHb);
      }
    }
  });

  await Promise.all(writerTasks);

  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const p50 = latencies[Math.floor(latencies.length * 0.50)];

  assert.ok(p95 < 1000, `p95 latency was ${Math.round(p95)} ms, expected < 1000 ms (p50: ${Math.round(p50)} ms, samples: ${latencies.length})`);
});
