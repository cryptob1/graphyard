import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { reconcileItemLockSql } from '../src/store/coordination-sql.js';
import type { Principal, Work } from '../src/model.js';

// GY-727: the reconciliation tick re-read every work item's full document in every batch, so a
// pass at 700 items cost items x batches document reads and every mutation queued behind the
// batches' coordination lock. The pass now reads only the items that can change, once, and each
// batch locks its own items' rows. Every test is named for the proof it produces.

const operator: Principal = { id: 'operator', role: 'admin' };
let database: EmbeddedPostgres, store: Store, engine: Engine;

// What the passes read and lock, seen on every connection the pool opens. `hold` makes the
// batch's row lock of one item slow by `ms` after the lock is taken, so a test knows the batch
// is holding its transaction.
const counts = { documents: 0, locks: 0, locked: [] as string[] };
const hold: { id: string | null; ms: number; fired: boolean } = { id: null, ms: 0, fired: false };

let openItems: Work[] = [], heldDone: Work[] = [];

const createItem = async (title: string) =>
  engine.execute(operator, 'create', null, { title, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:reconcile-scale'] }] }, randomUUID());

/** A delivered item nothing is owed for any more, inserted beside its work-index row. */
const doneDocument = (template: Work, key: string, over: Partial<Work> = {}): Work => ({
  ...structuredClone(template), id: randomUUID(), key, stage: 'done', stageEnteredAt: new Date().toISOString(),
  lease: null, nextAction: undefined, queue: undefined, actionQueue: undefined, containmentQuarantine: undefined, sessions: [], ...over,
});
const insert = async (document: Work) => { await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1, $2)', [document.id, JSON.stringify(document)]); return document; };

/** The items a pass can change, as the pass itself selects them (work_index.settled excluded). */
const candidateCount = async () => Number((await store.pool.query('SELECT count(*)::int AS n FROM work_items w WHERE NOT EXISTS (SELECT 1 FROM work_index i WHERE i.id = w.id AND i.settled)')).rows[0].n);

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 727;
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-reconcile-scale-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`);
  // Registered before the pool opens its first connection, so every query any test runs is seen.
  store.pool.on('connect', client => {
    const query = (client as { query: (...args: any[]) => any }).query.bind(client);
    (client as { query: (...args: any[]) => any }).query = (...args: any[]) => {
      const [text, values] = args;
      if (text === reconcileItemLockSql) { counts.locks++; counts.locked.push(values?.[0]); }
      const documents = typeof text === 'string' && /^\s*select/i.test(text) && /from\s+work_items/i.test(text) && /\bdocument\b/i.test(text);
      const last = args.length - 1;
      if (typeof args[last] === 'function') {
        const done = args[last];
        args[last] = (error: unknown, result: { rowCount?: number }) => {
          if (!error && documents) counts.documents += Number(result?.rowCount ?? 0);
          return done(error, result);
        };
        return query(...args);
      }
      return (async () => {
        const result = await query(...args);
        if (documents) counts.documents += Number((result as { rowCount?: number }).rowCount ?? 0);
        if (text === reconcileItemLockSql && hold.id && values?.[0] === hold.id && !hold.fired) {
          hold.fired = true;
          await new Promise(resolve => setTimeout(resolve, hold.ms));
        }
        return result;
      })();
    };
  });
  await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [operator];
  // 700 items, 150 of them open (the first created is the template for the rest), 547 settled
  // deliveries, and 3 done ones still holding a lease, a queue entry and a deployment row.
  const template = await createItem('Scale template');
  openItems = [template];
  heldDone = [
    await insert(doneDocument(template, 'GY-727H1', { lease: { owner: 'worker', epoch: 1, expiresAt: new Date(Date.now() - 60_000).toISOString() } })),
    await insert(doneDocument(template, 'GY-727H2', { queue: { sequence: 5, enqueuedAt: new Date().toISOString(), policyRevision: 1, speculation: null } })),
    await insert(doneDocument(template, 'GY-727H3', { nextAction: { kind: 'verify-deployment' } as Work['nextAction'] })),
  ];
  for (let n = 0; n < 547; n++) await insert(doneDocument(template, `GY-727S${n}`));
  for (let n = 0; n < 149; n++) openItems.push(await createItem(`Scale item ${n}`));
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

test('unit:reconcile-reads-open-items-once — a pass reads each candidate once, not once per batch', { timeout: 120_000 }, async () => {
  const expected = await candidateCount();
  assert.equal(openItems.length, 150, 'the fleet holds 150 open items');
  assert.equal(expected, openItems.length + heldDone.length, 'the done items still holding a lease, a queue entry or a row are candidates too');
  // One item per batch: over 150 transactions. The old pass re-read all 700 documents in each.
  engine.reconcileBatchMs = 0;
  counts.documents = 0; counts.locks = 0;
  try { await engine.reconcile(); } finally { engine.reconcileBatchMs = 250; }
  assert.equal(counts.documents, expected, `a pass reads each candidate's document exactly once (read ${counts.documents})`);
  assert.equal(counts.locks, expected, `each candidate is locked row by row, once, and no settled delivery is (locked ${counts.locks})`);
  assert.ok(await candidateCount() < expected, 'the pass settled the done item that still held a queue entry');
});

test('unit:reconcile-tick-bounded — a tick over 150 open items completes in under 3 s', { timeout: 60_000 }, async () => {
  assert.ok(await candidateCount() >= 150, 'the tick runs over the 150 open items');
  const started = performance.now();
  await engine.reconcile();
  const elapsedMs = performance.now() - started;
  assert.ok(elapsedMs < 3000, `the tick took ${Math.round(elapsedMs)} ms, over the 3 s bound`);
});

test('unit:reconcile-tick-bounded — a tick over 5 s logs a warning with its item count and duration', { timeout: 60_000 }, async () => {
  const expected = await candidateCount();
  engine.reconcileSlowWarnMs = 1;
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (line: unknown) => warnings.push(String(line));
  try { await engine.reconcile(); } finally { console.warn = warn; engine.reconcileSlowWarnMs = 5_000; }
  const tick = warnings.find(line => /reconciliation tick took \d+ ms for \d+ item/.test(line));
  assert.ok(tick, `no slow-tick warning was logged (${warnings.join(' | ') || 'nothing at all'})`);
  assert.match(tick!, new RegExp(`for ${expected} item`), 'the warning names the item count');
});

test('unit:reconcile-reads-open-items-once — a mutation on an item outside the running batch completes while the batch holds its transaction', { timeout: 60_000 }, async () => {
  const [held, outside] = openItems;
  engine.reconcileBatchMs = 0;
  hold.id = held.id; hold.ms = 1500; hold.fired = false;
  let passDone = false;
  const pass = engine.reconcile().then(() => { passDone = true; });
  for (let waited = 0; !hold.fired && waited < 10_000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(hold.fired, 'the pass reached the held item and took its row lock');
  assert.ok(!passDone, 'the batch is still holding its transaction');
  // A mutation on an item the batch holds nothing for: it must not wait for the batch.
  const startedAt = Date.now();
  await engine.execute(operator, 'ready', outside.id, {}, randomUUID());
  assert.ok(!passDone, 'the mutation committed while the pass was still inside the batch holding the lock');
  assert.ok(Date.now() - startedAt < 1000, `the mutation took ${Date.now() - startedAt} ms; it waited for a batch`);
  // On the locked item itself the same mutation waits for the row lock, then lands.
  let sameDone = false;
  const same = engine.execute(operator, 'ready', held.id, {}, randomUUID()).then(() => { sameDone = true; });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(!sameDone, 'the mutation on the locked item waits for the batch row lock');
  await pass; await same;
  assert.ok(sameDone, 'the mutation on the locked item completes once the batch releases it');
  const reloaded = (await store.list()).find(item => item.id === outside.id)!;
  assert.equal(reloaded.ready, true, 'the mutation that ran inside the batch window stands');
  engine.reconcileBatchMs = 250; hold.id = null;
});

test('unit:reconcile-reads-open-items-once — a batch that wrote on a view another write moved rolls back and runs again, never overwriting that write', { timeout: 60_000 }, async () => {
  const [, , written, peer] = openItems;
  // The batch reaching `written` writes it (its lease lapsed); while it holds the row, a raw write
  // moves `peer` without bumping its revision, and a request on `written` itself takes the
  // coordination lock and waits for the batch's row lock.
  const expired = { owner: 'worker', epoch: 1, expiresAt: new Date(Date.now() - 60_000).toISOString() };
  await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{lease}', $2::jsonb) WHERE id = $1`, [written.id, JSON.stringify(expired)]);
  engine.reconcileBatchMs = 0;
  hold.id = written.id; hold.ms = 1000; hold.fired = false;
  counts.locked = [];
  const pass = engine.reconcile();
  for (let waited = 0; !hold.fired && waited < 10_000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(hold.fired, 'the pass reached the item it writes and took its row lock');
  await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{title}', '"Moved under the batch"') WHERE id = $1`, [peer.id]);
  const request = engine.execute(operator, 'ready', written.id, {}, randomUUID());
  try { await Promise.all([pass, request]); } finally { engine.reconcileBatchMs = 250; hold.id = null; }
  assert.ok(counts.locked.filter(id => id === written.id).length >= 2, 'the batch rolled back rather than commit on the moved view, and ran again');
  const after = await store.list();
  const reloadedPeer = after.find(item => item.id === peer.id)!, reloaded = after.find(item => item.id === written.id)!;
  assert.equal(reloadedPeer.title, 'Moved under the batch', 'the write that bumped no revision was not overwritten');
  assert.equal(reloaded.lease, null, 'the lapsed lease was reconciled on the run that committed');
  assert.equal(reloaded.ready, true, 'the request that waited on the row lock landed');
});
