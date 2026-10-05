import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { reconcileRowLockSql, reconcileVersionsSql } from '../src/store/coordination-sql.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-727: the reconciliation tick re-read every work item's full document in every batch, so a
// pass at 700 items cost items x batches document reads and every mutation queued behind the
// batches' coordination lock. The pass now reads only the items that can change, once. Since
// GY-1290 a batch evaluates holding no lock and locks only the rows it writes, under the
// coordination lock. Every test is named for the proof it produces.

const operator: Principal = { id: 'operator', role: 'admin' };
let database: EmbeddedPostgres, store: Store, engine: Engine;

// What the passes read and lock, seen on every connection the pool opens. `hold` makes the
// batch's row lock of one item it writes slow by `ms` after the lock is taken, so a test knows
// the batch is inside its write phase.
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
      if (text === reconcileRowLockSql) { counts.locks++; counts.locked.push(values?.[0]); }
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
        if (text === reconcileRowLockSql && onLocked) await onLocked(values[0]);
        if (text === reconcileRowLockSql && hold.id && values?.[0] === hold.id && (!hold.fired || hold.times > 0)) {
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
  // Evaluation takes no lock (GY-1290): only the rows the pass writes are locked, each once.
  const writes = engine.reconcileTicks.at(-1)!.writes;
  assert.ok(writes > 0 && writes < expected, `the pass wrote some items, not all (${writes} of ${expected})`);
  assert.equal(counts.locks, writes, `only the rows the pass writes are locked, each once (locked ${counts.locks}, wrote ${writes})`);
  assert.equal(new Set(counts.locked).size, counts.locked.length, 'no row is locked twice');
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

/**
 * Hold the batch's lock-free evaluation of `id` until `release` is called (GY-1290); `reached`
 * resolves once the batch is evaluating it. Writes are never held: only the dry run waits.
 */
function holdEvaluation(id: string) {
  const internals = engine as unknown as { reconcileItem: (db: unknown, work: Work, all: Work[], now: Date, options?: { dryRun?: boolean }) => Promise<boolean> };
  const original = internals.reconcileItem;
  let release!: () => void, entered!: () => void, armed = true;
  const released = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
  internals.reconcileItem = async function (this: Engine, db, work, all, now, options) {
    if (armed && options?.dryRun && work.id === id) { armed = false; entered(); await released; }
    return original.call(this, db, work, all, now, options);
  };
  return { reached, release, restore: () => { internals.reconcileItem = original; } };
}
const lapse = async (id: string) => store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{lease}', $2::jsonb) WHERE id = $1`,
  [id, JSON.stringify({ owner: 'worker', epoch: 1, expiresAt: new Date(Date.now() - 60_000).toISOString() })]);

test('unit:reconcile-reads-open-items-once — mutations on any item, the evaluated one included, complete while a batch evaluates', { timeout: 60_000 }, async () => {
  const [held, outside] = openItems;
  engine.reconcileBatchMs = 60_000;
  const evaluation = holdEvaluation(held.id);
  let passDone = false;
  const pass = engine.reconcile().then(() => { passDone = true; });
  try {
    await evaluation.reached;
    // Neither a mutation on another item nor one on the item the batch is evaluating waits for it.
    for (const item of [outside, held]) {
      const startedAt = Date.now();
      await engine.execute(operator, 'ready', item.id, {}, randomUUID());
      assert.ok(!passDone, 'the batch is still evaluating');
      assert.ok(Date.now() - startedAt < 1000, `the mutation on ${item.key} took ${Date.now() - startedAt} ms; it waited for the batch`);
    }
  } finally { evaluation.release(); await pass; evaluation.restore(); engine.reconcileBatchMs = 250; }
  const after = await store.list();
  for (const item of [outside, held]) assert.equal(after.find(entry => entry.id === item.id)!.ready, true, 'the mutation made inside the batch stands');
});

test('unit:reconcile-reads-open-items-once — a batch writes on the fleet as it stands when it writes, never overwriting a write made while it evaluated', { timeout: 60_000 }, async () => {
  const [, , written, peer] = openItems;
  // The batch evaluates `written` (its lease lapsed) and will write it; while it evaluates, a raw
  // write moves `peer` without bumping its revision and a request on `written` itself commits.
  await lapse(written.id);
  engine.reconcileBatchMs = 60_000;
  const evaluation = holdEvaluation(written.id);
  counts.locked = [];
  const pass = engine.reconcile();
  try {
    await evaluation.reached;
    await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{title}', '"Moved under the batch"') WHERE id = $1`, [peer.id]);
    await engine.execute(operator, 'ready', written.id, {}, randomUUID());
  } finally { evaluation.release(); await pass; evaluation.restore(); engine.reconcileBatchMs = 250; }
  assert.equal(counts.locked.filter(id => id === written.id).length, 1, 'the batch locked the row it wrote once, with no rollback and no rerun');
  assert.equal(engine.reconcileTicks.at(-1)!.maxAttempts, 1, 'no batch ran twice');
  const after = await store.list();
  const reloadedPeer = after.find(item => item.id === peer.id)!, reloaded = after.find(item => item.id === written.id)!;
  assert.equal(reloadedPeer.title, 'Moved under the batch', 'the write that bumped no revision was not overwritten');
  assert.equal(reloaded.lease, null, 'the lapsed lease was reconciled');
  assert.equal(reloaded.ready, true, 'the request made while the batch evaluated stands');
});

test('unit:reconcile-reads-open-items-once — a batch waiting for the coordination lock holds no row, and one that cannot take it defers only its writes', { timeout: 60_000 }, async () => {
  const written = openItems[6];
  await lapse(written.id);
  engine.reconcileBatchMs = 60_000; engine.reconcileCommitLockWaitMs = 50;
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (line: unknown) => warnings.push(String(line));
  counts.locked = [];
  // Once the pass has opened and is evaluating, a fleet command takes the coordination lock and
  // holds it for longer than every attempt's wait.
  const evaluation = holdEvaluation(written.id);
  let release!: () => void, taken!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; }), holding = new Promise<void>(resolve => { taken = resolve; });
  let holder: Promise<void> | undefined;
  try {
    const pass = engine.reconcile();
    await evaluation.reached;
    holder = store.transaction(async () => { taken(); await released; });
    await holding;
    evaluation.release();
    // While the batch waits for the lock, a write on the very item it will write needs that item's row: it gets it.
    await new Promise(resolve => setTimeout(resolve, 30));
    const startedAt = Date.now();
    await store.transaction(async db => { await db.query("UPDATE work_items SET document = jsonb_set(document, '{title}', '\"Retitled while the batch waited\"') WHERE id = $1", [written.id]); }, { fleetLock: false, itemLock: written.id });
    assert.ok(Date.now() - startedAt < 1000, `an item write waited ${Date.now() - startedAt} ms on a batch waiting for the coordination lock`);
    await pass;
  } finally { console.warn = warn; evaluation.release(); evaluation.restore(); release(); await holder; engine.reconcileBatchMs = 250; engine.reconcileCommitLockWaitMs = 500; }
  const tick = engine.reconcileTicks.at(-1)!;
  assert.equal(tick.maxAttempts, engine.reconcileMaxAttempts, 'the batch tried the lock on every attempt it has');
  assert.ok(tick.deferred > 0, `its writes were deferred (${JSON.stringify(tick)})`);
  assert.equal(tick.evaluated + tick.deferred, tick.candidates, `every candidate was evaluated or deferred once (${JSON.stringify(tick)})`);
  assert.ok(warnings.some(line => /deferred \d+ item\(s\) after 3 attempts found the coordination lock held/.test(line)), 'the deferral names the held coordination lock');
  assert.deepEqual(counts.locked, [], 'no row was locked by a batch that never took the coordination lock');
  assert.ok((await store.list()).find(item => item.id === written.id)!.lease, 'the deferred write was not made');
  await engine.reconcile();
  const reloaded = (await store.list()).find(item => item.id === written.id)!;
  assert.equal(reloaded.lease, null, 'the next tick writes the deferred item');
  assert.equal(reloaded.title, 'Retitled while the batch waited', 'over the write made while the batch waited');
});

test('unit:reconcile-reads-open-items-once — sustained writes on other items never roll a batch back or defer it', { timeout: 60_000 }, async () => {
  const [written, peer, later] = openItems.slice(10, 13);
  for (const item of [written, later]) await lapse(item.id);
  engine.reconcileBatchMs = 0;
  let moves = 0;
  // A peer moves at every row lock the pass takes: the old batch rolled back on each and deferred.
  onLocked = async () => {
    moves++;
    await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{title}', $2::jsonb) WHERE id = $1`, [peer.id, JSON.stringify(`Continuous mutation ${moves}`)]);
  };
  try { await engine.reconcile(); } finally { onLocked = undefined; engine.reconcileBatchMs = 250; }
  const tick = engine.reconcileTicks.at(-1)!;
  assert.ok(moves >= 2, `the peer moved under ${moves} writes`);
  assert.equal(tick.deferred, 0, `nothing was deferred (${JSON.stringify(tick)})`);
  assert.equal(tick.maxAttempts, 1, 'no batch ran twice');
  const after = await store.list();
  assert.equal(after.find(item => item.id === written.id)!.lease, null, 'the first lapsed lease was reconciled');
  assert.equal(after.find(item => item.id === later.id)!.lease, null, 'and the later one, in the same tick');
  assert.equal(after.find(item => item.id === peer.id)!.title, `Continuous mutation ${moves}`, 'concurrent mutations survive');
});
