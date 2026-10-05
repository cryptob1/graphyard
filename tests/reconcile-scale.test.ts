import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { reconcileItemLockSql, reconcileVersionsSql } from '../src/store/coordination-sql.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-727: the reconciliation tick re-read every work item's full document in every batch, so a
// pass at 700 items cost items x batches document reads and every mutation queued behind the
// batches' coordination lock. The pass now reads only the items that can change, once, and each
// batch locks its own items' rows. Every test is named for the proof it produces.

const operator: Principal = { id: 'operator', role: 'admin' };
let database: EmbeddedPostgres, store: Store, engine: Engine;

// What the passes read and lock, seen on every connection the pool opens. `hold` makes the
// batch's row lock of one item slow by `ms` after the lock is taken, so a test knows the batch
// is holding its transaction.
// `documents` counts whole documents returned; `projected` the compact stand-ins the locked read
// (GY-1027) builds from a document in SQL, returned as text.
const counts = { documents: 0, projected: 0, locks: 0, locked: [] as string[], versioned: 0 };
const countDocuments = (text: string, rows: { document?: unknown }[] = []) => {
  if (!/^\s*select/i.test(text) || !/from\s+work_items/i.test(text)) return;
  if (text.includes('jsonb_to_record')) counts.projected += rows.length;
  else counts.documents += rows.filter(row => row.document && typeof row.document === 'object').length;
};
// `fired` holds the batch once; `times` holds it for that many consecutive locks instead (the
// contention-recovery test arms several attempts of the same batch in a row).
const hold: { id: string | null; ms: number; fired: boolean; times: number } = { id: null, ms: 0, fired: false, times: 0 };

let onLocked: ((id: string) => Promise<void>) | undefined;

let openItems: Work[] = [], heldDone: Work[] = [];

const createItem = async (title: string) =>
  engine.execute(operator, 'create', null, { title, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:reconcile-scale'] }] }, randomUUID());

/** A delivered item nothing is owed for any more, inserted beside its work-index row. */
const doneDocument = (template: Work, key: string, over: Partial<Work> = {}): Work => ({
  ...structuredClone(template), id: randomUUID(), key, stage: 'done', stageEnteredAt: new Date().toISOString(),
  lease: null, nextAction: undefined, actionQueue: undefined, containmentQuarantine: undefined, sessions: [], ...over,
});
const insert = async (document: Work) => { await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1, $2)', [document.id, JSON.stringify(document)]); return document; };

/** The items a pass can change, as the pass itself selects them (work_index.settled excluded). */
const candidateCount = async () => Number((await store.pool.query('SELECT count(*)::int AS n FROM work_items w WHERE NOT EXISTS (SELECT 1 FROM work_index i WHERE i.id = w.id AND i.settled)')).rows[0].n);

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 727;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('reconcile-scale'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`);
  // Registered before the pool opens its first connection, so every query any test runs is seen.
  store.pool.on('connect', client => {
    const query = (client as { query: (...args: any[]) => any }).query.bind(client);
    (client as { query: (...args: any[]) => any }).query = (...args: any[]) => {
      const [text, values] = args;
      if (text === reconcileItemLockSql) { counts.locks++; counts.locked.push(values?.[0]); }
      const last = args.length - 1;
      if (typeof args[last] === 'function') {
        const done = args[last];
        args[last] = (error: unknown, result: { rowCount?: number; rows?: { document?: unknown }[] }) => {
          if (!error && typeof text === 'string') countDocuments(text, result?.rows);
          if (!error && text === reconcileVersionsSql) counts.versioned = Math.max(counts.versioned, Number(result?.rowCount ?? 0));
          return done(error, result);
        };
        return query(...args);
      }
      return (async () => {
        const result = await query(...args);
        if (typeof text === 'string') countDocuments(text, (result as { rows?: { document?: unknown }[] }).rows);
        if (text === reconcileVersionsSql) counts.versioned = Math.max(counts.versioned, Number((result as { rowCount?: number }).rowCount ?? 0));
        if (text === reconcileItemLockSql && onLocked) await onLocked(values[0]);
        if (text === reconcileItemLockSql && hold.id && values?.[0] === hold.id && (!hold.fired || hold.times > 0)) {
          hold.fired = true;
          if (hold.times > 0) hold.times--;
          await new Promise(resolve => setTimeout(resolve, hold.ms));
        }
        return result;
      })();
    };
  });
  await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [operator];
  // These cases exercise the batches of a pass that visits every open item (GY-727); which items a
  // pass evaluates between full passes is tests/incremental-reconcile.test.ts's concern (GY-1124).
  engine.reconcileFullEvaluationMs = 0;
  // 700 items, 150 of them open (the first created is the template for the rest), 547 settled
  // deliveries, and 3 done ones still holding a lease, a legacy queue entry and a deployment row.
  const template = await createItem('Scale template');
  openItems = [template];
  heldDone = [
    await insert(doneDocument(template, 'GY-727H1', { lease: { owner: 'worker', epoch: 1, expiresAt: new Date(Date.now() - 60_000).toISOString() } })),
    // A legacy queue entry a stored document may still carry: the reconciler's write drops it (GY-1236).
    await insert(doneDocument(template, 'GY-727H2', { queue: { sequence: 5, enqueuedAt: new Date().toISOString(), policyRevision: 1, speculation: null } } as Partial<Work>)),
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
  counts.documents = 0; counts.projected = 0; counts.locks = 0; counts.versioned = 0;
  try { await engine.reconcile(); } finally { engine.reconcileBatchMs = 250; }
  assert.equal(counts.documents, expected, `a pass reads each candidate's document whole exactly once (read ${counts.documents})`);
  // The opening read under the lock projects only the candidates its cache has no stand-in for, each once.
  assert.ok(counts.projected <= expected, `the opening read projected ${counts.projected} rows for ${expected} candidates`);
  assert.equal(counts.locks, expected, `each candidate is locked row by row, once, and no settled delivery is (locked ${counts.locks})`);
  assert.ok(counts.versioned > 0 && counts.versioned <= expected, `each batch versions only the pass's candidates, never the settled history (${counts.versioned} rows at most)`);
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

test('unit:reconcile-reads-open-items-once — contention recovery never blocks a mutation outside the recovering batch', { timeout: 60_000 }, async () => {
  // Three contended attempts in a row (a peer moved under each) drive the batch into recovery —
  // the attempt that used to take the coordination lock for its whole evaluation. While that
  // recovery batch holds its transaction, a mutation on an item it holds nothing for must still
  // commit: recovery waits for the fleet, it never blocks it.
  const [written, peer, outside] = [openItems[6], openItems[7], openItems[8]];
  const locksOf = (id: string) => counts.locked.filter(locked => locked === id).length;
  const waitFor = async (condition: () => boolean, what: string) => {
    for (let waited = 0; !condition() && waited < 20_000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(condition(), what);
  };
  const expired = { owner: 'worker', epoch: 1, expiresAt: new Date(Date.now() - 60_000).toISOString() };
  await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{lease}', $2::jsonb) WHERE id = $1`, [written.id, JSON.stringify(expired)]);
  engine.reconcileBatchMs = 0;
  counts.locked = [];
  hold.id = written.id; hold.ms = 200; hold.times = engine.reconcileRetries + 1; hold.fired = false;
  let passDone = false;
  const pass = engine.reconcile().then(() => { passDone = true; });
  let outsideTookMs = 0;
  try {
    // Attempts 1..3: the batch writes `written`, and while it holds the row a raw write moves
    // `peer`, so each attempt rolls back on the moved view.
    for (let attempt = 1; attempt <= engine.reconcileRetries; attempt++) {
      await waitFor(() => locksOf(written.id) >= attempt, `the pass reached the written item on attempt ${attempt} and took its row lock`);
      await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{title}', $2::jsonb) WHERE id = $1`, [peer.id, JSON.stringify(`Moved under recovery attempt ${attempt}`)]);
      if (attempt === engine.reconcileRetries) hold.ms = 1500;
      await waitFor(() => locksOf(written.id) >= attempt + 1, `attempt ${attempt} rolled back on the moved view and ran again`);
    }
    // The recovery attempt: previously the serialized one, holding the coordination lock from its
    // start. It must evaluate without that lock, so the mutation below commits inside its window.
    assert.ok(locksOf(written.id) === engine.reconcileRetries + 1, 'the recovery attempt runs after the contended attempts');
    const mutationStarted = Date.now();
    await engine.execute(operator, 'ready', outside.id, {}, randomUUID());
    outsideTookMs = Date.now() - mutationStarted;
    assert.ok(!passDone, 'the recovery batch is still holding its transaction');
    assert.ok(outsideTookMs < 1000, `the mutation took ${outsideTookMs} ms; contention recovery blocked it`);
    hold.id = null;
    await waitFor(() => locksOf(written.id) >= engine.reconcileRetries + 2, 'the recovery attempt rolled back on the mutation and ran again');
  } finally { engine.reconcileBatchMs = 250; hold.id = null; hold.ms = 0; hold.times = 0; }
  await pass;
  assert.ok(locksOf(written.id) >= engine.reconcileRetries + 2, `the batch ran the contended attempts, the recovery attempt and a final committing one (locked ${locksOf(written.id)})`);
  const after = await store.list();
  assert.equal(after.find(item => item.id === outside.id)!.ready, true, 'the mutation that ran inside the recovery window stands');
  assert.equal(after.find(item => item.id === written.id)!.lease, null, 'the batch committed through recovery and reconciled the lapsed lease');
  assert.equal(after.find(item => item.id === peer.id)!.title, `Moved under recovery attempt ${engine.reconcileRetries}`, 'no recovery attempt overwrote the peer write');
});

test('unit:reconcile-reads-open-items-once — a batch that wrote, then finds a later item moved under it at its row lock, rolls back and runs again', { timeout: 60_000 }, async () => {
  // Adjacent candidates in one batch: the batch writes `written` (its lease lapsed), and while it
  // holds that row a raw write moves `peer`, which the batch reaches next. Rereading `peer` there
  // would refresh the view the commit check compares against, hiding that `written` was evaluated
  // against the old `peer`; the batch must roll back instead.
  const [, , , , written, peer] = openItems;
  const expired = { owner: 'worker', epoch: 1, expiresAt: new Date(Date.now() - 60_000).toISOString() };
  await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{lease}', $2::jsonb) WHERE id = $1`, [written.id, JSON.stringify(expired)]);
  engine.reconcileBatchMs = 60_000;
  hold.id = written.id; hold.ms = 500; hold.fired = false;
  counts.locked = [];
  const pass = engine.reconcile();
  for (let waited = 0; !hold.fired && waited < 10_000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(hold.fired, 'the pass reached the item it writes and took its row lock');
  await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{title}', '"Moved before its row lock"') WHERE id = $1`, [peer.id]);
  try { await pass; } finally { engine.reconcileBatchMs = 250; hold.id = null; }
  assert.ok(counts.locked.filter(id => id === written.id).length >= 2, 'the batch rolled back rather than commit a write evaluated against the old peer, and ran again');
  const after = await store.list();
  assert.equal(after.find(item => item.id === peer.id)!.title, 'Moved before its row lock', 'the raw write on the peer stands');
  assert.equal(after.find(item => item.id === written.id)!.lease, null, 'the lapsed lease was reconciled on the run that committed');
});


test('unit:reconcile-reads-open-items-once — sustained contention defers a batch and lets later items and the next tick progress', { timeout: 60_000 }, async () => {
  const [written, peer, later] = openItems.slice(10, 13);
  const expired = { owner: 'worker', epoch: 1, expiresAt: new Date(Date.now() - 60_000).toISOString() };
  for (const item of [written, later]) await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{lease}', $2::jsonb) WHERE id = $1`, [item.id, JSON.stringify(expired)]);
  engine.reconcileBatchMs = 0;
  let attempts = 0;
  // Move a peer on EVERY attempt, including any retries beyond the cap: an unbounded
  // implementation cannot finish this pass. This does not depend on timer scheduling.
  onLocked = async id => {
    if (id === written.id) {
      attempts++;
      assert.ok(attempts <= engine.reconcileMaxAttempts, 'sustained contention must not retry forever');
      await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{title}', $2::jsonb) WHERE id = $1`, [peer.id, JSON.stringify(`Continuous mutation ${attempts}`)]);
    }
  };
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = line => warnings.push(String(line));
  try { await engine.reconcile(); }
  finally { onLocked = undefined; console.warn = warn; engine.reconcileBatchMs = 250; }
  assert.equal(attempts, engine.reconcileMaxAttempts, 'the contended batch has a finite attempt budget');
  assert.ok(warnings.some(line => new RegExp(`deferred 1 item\\(s\\).*${engine.reconcileMaxAttempts} contended attempts`).test(line)), 'deferral is visible in the server log');
  const after = await store.list();
  assert.ok(after.find(item => item.id === written.id)!.lease, 'the deferred write was rolled back');
  assert.equal(after.find(item => item.id === later.id)!.lease, null, 'later candidates made progress in the same tick');
  assert.equal(after.find(item => item.id === peer.id)!.title, `Continuous mutation ${attempts}`, 'concurrent mutations survive');
  await engine.reconcile();
  assert.equal((await store.list()).find(item => item.id === written.id)!.lease, null, 'the next tick retries and settles the deferred item');
});
