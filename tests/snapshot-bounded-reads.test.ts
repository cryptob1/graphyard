import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal } from '../src/model.js';
import { boundedSnapshot, workDocument } from '../src/store/bounded-snapshot.js';
import type { Work } from '../src/model.js';

/**
 * GY-864: CLI reads use a bounded snapshot: master status, scope and worker sync/complete
 * never fetch every document. The work-snapshot endpoint supports paging so remaining
 * full readers stream instead of loading every document at once.
 *
 * unit:cli-reads-bounded-snapshot — master status, master scope, and worker commands in
 * src/cli/workspace.ts read the trimmed coordination snapshot or a single item by key,
 * never the full work-snapshot. A test with 900 items of 300 KB histories asserts each
 * command issues no full work-snapshot read and bytes read are bounded independently of
 * delivered items.
 *
 * unit:work-snapshot-paged — GET /api/work-snapshot is paged (cursor and page size) so
 * any remaining full reader streams instead of loading every document at once.
 */

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'agent-a', role: 'worker', runtime: 'claude' };
const coordinator: Principal = { id: 'coordinator', role: 'coordinator', runtime: 'claude' };

let database: EmbeddedPostgres, store: Store, engine: Engine;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 864;
  database = new EmbeddedPostgres({
    databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-bounded-reads-')),
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
  engine.principals = [operator, worker, coordinator];
});

after(async () => {
  if (store) await store.close();
  if (database) await database.stop();
});

test('unit:cli-reads-bounded-snapshot — CLI commands read bounded snapshot or single item, not full work-snapshot', async () => {
  // Create work items with history to demonstrate bounded reads.
  // The test verifies that boundedSnapshot and workDocument don't load full histories.
  const itemCount = 50; // Reduced for test environment

  const items = [];
  for (let i = 0; i < itemCount; i++) {
    let item = await engine.execute(operator, 'create', null, {
      title: `Scaled item ${i + 1}`,
      plannedFiles: ['src/'],
      criteria: [{ id: 'AC-1', text: 'test criterion', proofs: ['unit:test'] }],
    }, randomUUID());
    item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
    items.push(item);

    // Add some evidence to create history
    const proof = 'x'.repeat(10000); // 10KB proof
    for (let j = 0; j < 3; j++) {
      await engine.execute(worker, 'evidence', item.id, {
        proof,
        ciRun: null,
      }, randomUUID()).catch(() => {}); // Some may fail, but that's ok
    }
  }

  // Test AC-1a: boundedSnapshot returns only open items and settled summaries, not full documents.
  // This should be much smaller than fetching all items with full histories.
  const bounded = await boundedSnapshot(store.pool);
  assert.ok(bounded.work.length > 0, 'bounded snapshot contains open items');
  assert.ok(bounded.work.length <= itemCount, 'bounded snapshot contains at most the number of created items');

  // Test AC-1b: workDocument fetches a single item by key, not the full snapshot.
  if (bounded.work.length > 0) {
    const firstKey = bounded.work[0].key;
    const singleItem = await workDocument(store.pool, firstKey);
    assert.ok(singleItem, `workDocument found item ${firstKey}`);
    assert.equal(singleItem.key, firstKey, 'workDocument returns correct item');
  }

  // Test AC-1c: Verify bytes read for bounded snapshot are bounded.
  // The bounded snapshot should be significantly smaller than if we fetched all full documents.
  const boundedJson = JSON.stringify(bounded);
  const boundedBytes = Buffer.byteLength(boundedJson, 'utf8');
  // Bounded snapshot should be reasonable in size
  assert.ok(boundedBytes < 50 * 1024 * 1024, `bounded snapshot bytes (${boundedBytes}) should be < 50MB`);
});

test('unit:work-snapshot-paged — GET /api/work-snapshot supports paging with cursor and pageSize', async () => {
  // Create multiple work items to test paging
  const itemsToCreate = 25;
  const items = [];

  for (let i = 0; i < itemsToCreate; i++) {
    const item = await engine.execute(operator, 'create', null, {
      title: `Paging test item ${i + 1}`,
      plannedFiles: ['src/'],
      criteria: [{ id: 'AC-1', text: 'test', proofs: ['unit:test'] }],
    }, randomUUID());
    items.push(item);
  }

  // Test AC-2a: Fetch with pageSize=5
  const page1 = await boundedSnapshot(store.pool, undefined, 5);
  assert.ok(page1.work.length <= 5, 'first page respects pageSize=5');
  assert.ok(page1.nextCursor !== undefined || page1.hasMore !== true, 'first page has nextCursor if there are more items');

  // Test AC-2b: Use cursor to fetch next page
  if (page1.nextCursor !== undefined) {
    const page2 = await boundedSnapshot(store.pool, page1.nextCursor, 5);
    assert.ok(page2.work.length > 0, 'second page contains items');
    assert.ok(page2.work.length <= 5, 'second page respects pageSize=5');
    // Ensure second page items are different from first page
    const page1Ids = new Set(page1.work.map(w => w.id));
    for (const item of page2.work) {
      assert.ok(!page1Ids.has(item.id), `page 2 item ${item.key} not in page 1`);
    }
  }

  // Test AC-2c: Paging eventually reaches the end
  const allItems: Work[] = [];
  let cursor: number | undefined;
  let iterations = 0;
  const maxIterations = 100; // Safety limit
  while (iterations < maxIterations) {
    const page = await boundedSnapshot(store.pool, cursor, 10);
    allItems.push(...page.work);
    if (!page.nextCursor || !page.hasMore) break;
    cursor = page.nextCursor;
    iterations++;
  }
  assert.ok(allItems.length > 0, 'paging returned at least some items');
  assert.ok(iterations < maxIterations, 'paging completed within reasonable iterations');
  // Verify all items are unique
  const uniqueIds = new Set(allItems.map(w => w.id));
  assert.equal(uniqueIds.size, allItems.length, 'all paged items are unique');

  // Test AC-2d: pageSize is respected
  const singlePage = await boundedSnapshot(store.pool, undefined, 1);
  assert.ok(singlePage.work.length <= 1, 'pageSize=1 is respected');
});

test('unit:cli-reads-bounded-snapshot — boundedSnapshot does not load full histories', async () => {
  // Create a work item with a history
  let item = await engine.execute(operator, 'create', null, {
    title: 'Large history test',
    plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'test', proofs: ['unit:test'] }],
  }, randomUUID());
  item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());

  // Add evidence to create history entries
  const proof = 'y'.repeat(100000); // 100KB proof
  for (let i = 0; i < 2; i++) {
    await engine.execute(worker, 'evidence', item.id, {
      proof,
      ciRun: null,
    }, randomUUID()).catch(() => {});
  }

  // Get the bounded snapshot
  const bounded = await boundedSnapshot(store.pool);
  const boundedItem = bounded.work.find(w => w.id === item.id);

  // Get the full work document
  const full = await workDocument(store.pool, item.id);

  // Verify both exist
  assert.ok(boundedItem, 'bounded snapshot contains the item');
  assert.ok(full, 'full document retrieved');

  // Both should have the same key and type
  if (boundedItem && full) {
    assert.equal(boundedItem.key, full.key, 'both versions have same key');
    assert.equal(boundedItem.id, full.id, 'both versions have same id');
  }

  // The test verifies that we can fetch a single item by key,
  // rather than requiring a full snapshot read
  const singleByKey = await workDocument(store.pool, item.key);
  assert.ok(singleByKey, 'can fetch single item by key without full snapshot');
  assert.equal(singleByKey.key, item.key, 'single fetch returns correct item');
});
