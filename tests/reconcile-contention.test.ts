import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { wakeFromWebhook, wakeJob, wakeJobs } from '../src/store/store.js';
import { commitLockWaitMs, reconcileCommitBlockingSql } from '../src/store/coordination-sql.js';
import { advisoryLocks } from '../src/store/locks.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1115: with about 100 open items, production reconciliation ticks took 4-6 minutes. Every
// contended batch rolled back and reran whole up to six times holding its item row locks, each
// resync started a tick of its own, job wakes deadlocked against the batches, and the pool ran
// dry. Every test is named for the proof it produces.

const operator: Principal = { id: 'contention-operator', role: 'admin', sessionKind: 'human' };
const workers: Principal[] = Array.from({ length: 30 }, (_, n) => ({ id: `contention-worker-${n}`, role: 'worker', sessionKind: 'ai' }));
let database: EmbeddedPostgres, store: Store, engine: Engine;
let items: Work[] = [], leased: { work: Work; actor: Principal }[] = [];

const shuffled = <T>(values: T[]) => values.map(value => ({ value, key: Math.random() })).sort((a, b) => a.key - b.key).map(entry => entry.value);
const lapsed = () => ({ owner: 'gone-worker', epoch: 1, expiresAt: new Date(Date.now() - 60_000).toISOString() });
/** Make `ids` hold a lapsed lease, so the next tick writes them, and a submission, so it wakes their jobs too. */
const lapse = async (ids: string[]) => {
  for (const id of ids) await store.pool.query(`UPDATE work_items SET document = jsonb_set(jsonb_set(document, '{lease}', $2::jsonb), '{submission}', $3::jsonb) WHERE id = $1`,
    [id, JSON.stringify(lapsed()), JSON.stringify({ epoch: 1, pr: 4000 + items.findIndex(item => item.id === id) })]);
};

/** Run the fleet's traffic until `stop` resolves: heartbeats, resyncs, webhook wakes and raw moves; every failure is collected. */
async function traffic(stop: Promise<void>, errors: unknown[], { rawMoves = true } = {}) {
  let running = true; void stop.then(() => { running = false; });
  const loop = async (step: () => Promise<unknown>) => { while (running) { try { await step(); } catch (error) { errors.push(error); } await new Promise(resolve => setTimeout(resolve, 5)); } };
  const pick = <T>(values: T[]) => values[Math.floor(Math.random() * values.length)];
  await Promise.all([
    loop(async () => { const { work, actor } = pick(leased); await engine.execute(actor, 'heartbeat', work.id, { epoch: work.epoch }, randomUUID()); }),
    loop(async () => { const { work, actor } = pick(leased); await engine.execute(actor, 'heartbeat', work.id, { epoch: work.epoch }, randomUUID()); }),
    loop(async () => { await engine.resyncWork(operator, pick(items).id, {}); }),
    loop(async () => { await store.transaction(async db => wakeFromWebhook(db, { all: Math.random() < 0.5, prs: [4000 + Math.floor(Math.random() * 100)], shas: [], branches: [] }, true)); }),
    loop(async () => { await store.transaction(async db => { for (const work of shuffled(items).slice(0, 8)) await wakeJob(db, work.id); }); }),
    loop(async () => { await wakeJobs(store.pool, shuffled(items).slice(0, 12).map(work => work.id)); }),
    // A move another item's evaluation reads, on a share of the fleet: what keeps contending batches.
    ...(rawMoves ? [loop(async () => { await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{title}', to_jsonb($2::text)) WHERE id = $1`, [pick(items.slice(60)).id, `Moved ${randomUUID()}`]); })] : []),
  ]);
}

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1115;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('reconcile-contention'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  // A small pool, so a tick that took more than its share would starve requests at once.
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`, { max: 6 });
  await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [operator, ...workers];
  engine.submissionObserver = null;
  for (let n = 0; n < 100; n++) {
    const work = await engine.execute(operator, 'create', null, { title: `Contended item ${n}`, plannedFiles: [`src/contended-${n}.ts`], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:reconcile-contention'] }] }, randomUUID());
    items.push(await engine.execute(operator, 'ready', work.id, {}, randomUUID()));
  }
  for (const [n, actor] of workers.entries()) leased.push({ work: await engine.execute(actor, 'claim', items[n].id, {}, randomUUID()), actor });
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

// Proven at a 20 ms batch, which makes the most batches contend, and at the 250 ms production default (GY-1212).
for (const batchMs of [20, 250]) test(`unit:reconcile-tick-bounded-under-contention — a tick over 100 live items under continuous mutation completes within 30 s, evaluating or deferring every candidate, no batch rerun more than twice (reconcileBatchMs ${batchMs})`, { timeout: 180_000 }, async () => {
  await lapse(items.slice(40, 70).map(work => work.id));
  engine.reconcileBatchMs = batchMs;
  const errors: unknown[] = [];
  let stop!: () => void; const stopped = new Promise<void>(resolve => { stop = resolve; });
  const load = traffic(stopped, errors);
  await new Promise(resolve => setTimeout(resolve, 300));
  const before = engine.reconcileTicks.length;
  const started = performance.now();
  try { await engine.reconcile(); } finally { stop(); await load; engine.reconcileBatchMs = 250; }
  const elapsedMs = performance.now() - started;
  // The resyncs ran ticks of their own; every tick in the window, the measured one included, keeps the bound.
  const ticks = engine.reconcileTicks.slice(before);
  assert.ok(ticks.length >= 1, 'the tick was recorded');
  assert.ok(elapsedMs < 30_000, `the tick took ${Math.round(elapsedMs)} ms under contention, over the 30 s bound`);
  for (const tick of ticks) {
    assert.ok(tick.candidates >= 100, `the tick ran over the whole live fleet (${tick.candidates})`);
    assert.ok(tick.ms < 30_000, `a tick took ${tick.ms} ms, over the 30 s bound`);
    assert.equal(tick.evaluated + tick.deferred, tick.candidates, `every candidate was evaluated or deferred (${JSON.stringify(tick)})`);
    assert.ok(tick.maxAttempts <= 3, `a batch ran ${tick.maxAttempts} attempts: one run and at most two reruns`);
  }
  assert.ok(ticks.some(tick => tick.evaluated > 0), 'the ticks made progress under contention');
  assert.deepEqual(errors.map(String).filter(line => /deadlock|timeout exceeded/.test(line)), [], 'the traffic saw no deadlock and no pool timeout');
  // Deferred items are only deferred: quiet ticks settle every lapsed lease.
  for (let n = 0; n < 5 && (await store.list()).some(work => work.lease?.owner === 'gone-worker'); n++) await engine.reconcile();
  assert.ok(!(await store.list()).some(work => work.lease?.owner === 'gone-worker'), 'every lapsed lease was reconciled once the fleet quieted');
});

test('unit:job-wake-reconcile-no-deadlock — wakeJob, wakeJobs, resync and a reconciliation tick on the same items never deadlock', { timeout: 180_000 }, async () => {
  const errors: unknown[] = [];
  for (let round = 0; round < 6; round++) {
    // Every round the tick writes items whose submissions wake their jobs, while every wake path runs on the same items.
    await lapse(shuffled(items.slice(30)).slice(0, 25).map(work => work.id));
    engine.reconcileBatchMs = round % 2 ? 0 : 50;
    let stop!: () => void; const stopped = new Promise<void>(resolve => { stop = resolve; });
    const load = traffic(stopped, errors, { rawMoves: false });
    try {
      await Promise.all([
        engine.reconcile(),
        ...shuffled(items).slice(0, 10).map(work => engine.resyncWork(operator, work.id, {}).catch(error => { errors.push(error); })),
        ...Array.from({ length: 6 }, () => store.transaction(async db => { for (const work of shuffled(items).slice(0, 20)) await wakeJob(db, work.id); }).catch(error => { errors.push(error); })),
        ...Array.from({ length: 6 }, () => wakeJobs(store.pool, shuffled(items).map(work => work.id)).catch(error => { errors.push(error); })),
      ]);
    } finally { stop(); await load; engine.reconcileBatchMs = 250; }
  }
  const deadlocks = errors.map(String).filter(line => /deadlock detected/.test(line));
  assert.deepEqual(deadlocks, [], `deadlocks across the rounds: ${deadlocks.length}`);
  assert.deepEqual(errors.map(String), [], 'no wake, resync or tick failed');
  const jobs = Number((await store.pool.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n);
  assert.ok(jobs >= 25, `the wakes landed (${jobs} job rows)`);
});

test('unit:reconcile-leaves-pool-headroom — while a tick runs, heartbeats, claims and request transactions get a connection within 1 s', { timeout: 180_000 }, async () => {
  // Slow every item's evaluation, so the tick runs for seconds; ten resyncs arrive while it does.
  const reconcileItem = (engine as unknown as { reconcileItem: (...args: unknown[]) => Promise<boolean> }).reconcileItem.bind(engine);
  (engine as unknown as { reconcileItem: unknown }).reconcileItem = async (...args: unknown[]) => { await new Promise(resolve => setTimeout(resolve, 15)); return reconcileItem(...args); };
  engine.reconcileBatchMs = 50;
  let ticking = true, peakBackground = 0;
  const watch = (async () => { while (ticking) { peakBackground = Math.max(peakBackground, store.background.inUse); await new Promise(resolve => setTimeout(resolve, 2)); } })();
  const extra: Principal = { id: 'contention-headroom', role: 'worker', sessionKind: 'ai' };
  engine.principals = [...engine.principals, extra];
  const free = await engine.execute(operator, 'ready', (await engine.execute(operator, 'create', null, { title: 'Claimed while the tick runs', plannedFiles: ['src/headroom.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:reconcile-contention'] }] }, randomUUID())).id, {}, randomUUID());
  const timings: { what: string; ms: number }[] = [];
  const timed = async (what: string, run: () => Promise<unknown>) => { const started = performance.now(); await run(); timings.push({ what, ms: performance.now() - started }); };
  try {
    const tick = engine.reconcile();
    const resyncs = items.slice(0, 10).map(work => engine.resyncWork(operator, work.id, {}));
    await new Promise(resolve => setTimeout(resolve, 200));
    for (let n = 0; n < 5; n++) {
      const { work, actor } = leased[n];
      await timed('heartbeat', () => engine.execute(actor, 'heartbeat', work.id, { epoch: work.epoch }, randomUUID()));
      await timed('request transaction', () => store.transaction(async db => db.query('SELECT 1')));
      await timed('pool connection', async () => { const client = await store.pool.connect(); client.release(); });
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await timed('claim', () => engine.execute(extra, 'claim', free.id, {}, randomUUID()));
    await Promise.all([tick, ...resyncs]);
  } finally {
    ticking = false; await watch;
    (engine as unknown as { reconcileItem: unknown }).reconcileItem = reconcileItem; engine.reconcileBatchMs = 250;
  }
  assert.ok(engine.reconcileTicks.at(-1)!.ms > 1000, 'the tick ran for over a second while the requests were made');
  for (const timing of timings) assert.ok(timing.ms < 1000, `a ${timing.what} took ${Math.round(timing.ms)} ms while the tick ran`);
  assert.ok(peakBackground <= 1, `reconciliation held ${peakBackground} background connections at once; ten resyncs must share one tick`);
});

test('unit:deferred-wake-refuses-later-jobs-statements — inside a transaction, a read or delete of jobs after a deferred wake is refused, and one before it is not (GY-1212)', async () => {
  const [woken, other] = [items[95].id, items[96].id];
  await store.pool.query('DELETE FROM jobs WHERE work_id = ANY($1::uuid[])', [[woken, other]]);
  // Waking then deleting the same job would have its row reinserted at COMMIT: refused, and nothing commits.
  await assert.rejects(store.transaction(async db => { await wakeJob(db, woken); await db.query('DELETE FROM jobs WHERE work_id=$1', [woken]); }), /ran after this transaction deferred a job wake/);
  await assert.rejects(store.transaction(async db => { await wakeJob(db, woken); await db.query({ text: 'SELECT 1 FROM jobs WHERE work_id=$1', values: [other] }); }), /ran after this transaction deferred a job wake/);
  assert.equal((await store.pool.query('SELECT 1 FROM jobs WHERE work_id = ANY($1::uuid[])', [[woken, other]])).rowCount, 0, 'the refused transactions rolled back their wakes');
  // Job rows touched before any wake, as every current path does, still commit with the wakes.
  await store.transaction(async db => { await db.query('SELECT 1 FROM jobs WHERE work_id=$1', [other]); await db.query('DELETE FROM jobs WHERE work_id=$1', [other]); await wakeJob(db, woken); await db.query('SELECT 1 FROM work_items WHERE id=$1', [woken]); });
  assert.equal((await store.pool.query('SELECT 1 FROM jobs WHERE work_id=$1', [woken])).rowCount, 1, 'the wake landed at COMMIT');
  // The connection went back to the pool with its own query restored.
  await store.transaction(async db => db.query('SELECT 1 FROM jobs WHERE work_id=$1', [woken]));
});

test('unit:resync-survives-tick-failure — a failed reconciliation tick does not reject the resyncs waiting on it (GY-1212)', async () => {
  const internals = engine as unknown as { reconcileTick: () => Promise<void> };
  const reconcileTick = internals.reconcileTick;
  internals.reconcileTick = async () => { await new Promise(resolve => setTimeout(resolve, 20)); throw new Error('tick failed for another item'); };
  try {
    const resyncs = await Promise.all(items.slice(0, 5).map(work => engine.resyncWork(operator, work.id, {})));
    assert.deepEqual(resyncs.map(answer => answer.work.id), items.slice(0, 5).map(work => work.id), 'every resync answered with its own item');
    await assert.rejects(engine.reconcile(), /tick failed for another item/, 'the loop still sees the tick fail');
  } finally { internals.reconcileTick = reconcileTick; }
});

test('unit:commit-lock-wait-under-deadlock-timeout — the commit wait stays under half the server deadlock_timeout (GY-1212)', async () => {
  const row = (await store.pool.query(reconcileCommitBlockingSql, [advisoryLocks.coordination])).rows[0];
  assert.equal(row.blocking, false);
  assert.equal(Number(row.deadlock_ms), 1000, 'the check reads the session deadlock_timeout in milliseconds');
  assert.equal(commitLockWaitMs(200, 1000), 200, 'the production wait is kept under the default deadlock_timeout');
  assert.equal(commitLockWaitMs(200, 300), 150, 'a lowered deadlock_timeout cuts the wait to half of it');
  assert.equal(commitLockWaitMs(200, 1), 1, 'the wait is never below 1 ms');
  assert.equal(commitLockWaitMs(200, Number.NaN), 200, 'an unreadable setting keeps the configured wait');
});

test('unit:deferred-batch-keeps-writer-held-turn — a row a writer held in a batch deferred as contended still gets its end-of-pass turn (GY-1212)', { timeout: 60_000 }, async () => {
  const held = items[80].id;
  await lapse(items.slice(70, 80).map(work => work.id));
  const internals = engine as unknown as { coordinationLockWithin: (...args: unknown[]) => Promise<boolean>; reconcileItem: (db: unknown, work: Work, ...rest: unknown[]) => Promise<boolean> };
  const { coordinationLockWithin, reconcileItem } = internals;
  const holder = await store.pool.connect();
  let holding = true;
  const release = async () => { if (holding) { holding = false; await holder.query('COMMIT'); holder.release(); } };
  const reached: string[] = [];
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM work_items WHERE id=$1 FOR UPDATE', [held]);
    // Every batch that wrote is contended, and deferred on its first attempt; the writer lets go once the first batch is refused.
    internals.coordinationLockWithin = async () => { await release(); return false; };
    internals.reconcileItem = async (db, work, ...rest) => { reached.push(work.id); return reconcileItem.call(engine, db, work, ...rest); };
    engine.reconcileBatchMs = 60_000; engine.reconcileMaxAttempts = 1;
    await engine.reconcile();
  } finally {
    await release();
    internals.coordinationLockWithin = coordinationLockWithin; internals.reconcileItem = reconcileItem;
    engine.reconcileBatchMs = 250; engine.reconcileMaxAttempts = 3;
  }
  const tick = engine.reconcileTicks.at(-1)!;
  assert.ok(tick.deferred > 0, `the contended batch was deferred (${JSON.stringify(tick)})`);
  assert.ok(reached.includes(held), 'the row the writer held was evaluated at the end of the pass');
  assert.equal(tick.evaluated + tick.deferred, tick.candidates, `every candidate was evaluated or deferred exactly once (${JSON.stringify(tick)})`);
  // Quiet ticks settle the lapsed leases the deferred batch left.
  for (let n = 0; n < 5 && (await store.list()).some(work => work.lease?.owner === 'gone-worker'); n++) await engine.reconcile();
});
