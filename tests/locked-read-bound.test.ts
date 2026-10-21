import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { advisoryLocks } from '../src/store/locks.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1787: the locked-read full-pass bound is relative — a fixed multiple of the host's trivial-lock
 * baseline plus the batches' budget (tests/locked-read.test.ts, unit:locked-read-relative-bound) —
 * so a slower CI runner cannot fail every head and revert a good merge. This file holds the other
 * half of that change: with a stand-in that holds the lock across the history (one hold per batch
 * whose length grows with the live-item count — the GY-1124/GY-1027 regression the bound exists to
 * catch), the relative bound still fails, and the failure names the measured total and the bound.
 *
 * The ledger here is small on purpose: the failing run's wall time is its measured total, and the
 * bound's batch term is each batch's whole budget, so a run that exceeds the bound costs at least
 * the bound; twenty items keep that under half a minute while still seeding several batches of
 * writes, which is the shape the stand-in holds across.
 */

/** How long one transaction held the coordination lock, by the operation that took it. */
const holds: { label: string; ms: number; locked: boolean }[] = [];
let label = 'other', timing = false;
function timeTransactions() {
  if (timing) return; timing = true;
  const original = store.transaction.bind(store);
  store.transaction = (async (fn: any, options: any) => original(async (db: any, now: Date) => {
    let started = options?.coordinationLock === false ? null as number | null : performance.now();
    const counted = new Proxy(db, { get: (target, property) => property !== 'query' ? Reflect.get(target, property, target) : async (...args: unknown[]) => {
      const result = await (target.query as any)(...args);
      if (started === null && String(args[0]).includes('pg_try_advisory_xact_lock') && result?.rows?.[0]?.ok) started = performance.now();
      if (started === null && args[0] === 'SELECT pg_advisory_xact_lock($1)' && (args[1] as unknown[])?.[0] === advisoryLocks.coordination) started = performance.now();
      return result;
    } });
    try { return await fn(counted, now); } finally { holds.push({ label, ms: started === null ? 0 : performance.now() - started, locked: started !== null }); }
  }, options)) as typeof store.transaction;
}

/** The stand-in (AC-2): while positive, every transaction that holds the coordination lock busy-holds it for the live-item count times this after its work — one hold per batch, growing with the live-item count, as a pass that reads the whole history under the lock in every batch would. */
let holdMsPerLiveItem = 0;
function holdAcrossTheHistory() {
  const original = store.transaction.bind(store);
  store.transaction = (async (fn: any, options: any) => original(async (db: any, now: Date) => {
    let holdsLock = options?.coordinationLock !== false;
    const watched = new Proxy(db, { get: (target, property) => property !== 'query' ? Reflect.get(target, property, target) : async (...args: unknown[]) => {
      const result = await (target.query as any)(...args);
      // A batch opened without the lock holds it from a successful advisory-lock acquisition (the
      // opening pass's own lock, or a planned write's waited one) to its end.
      if (!holdsLock && String(args[0]).includes('pg_advisory_xact_lock')) holdsLock = true;
      return result;
    } });
    const result = await fn(watched, now);
    if (holdsLock && holdMsPerLiveItem > 0) {
      const live = Number((await db.query('SELECT count(*) AS n FROM work_index WHERE settled IS NOT TRUE')).rows[0].n);
      const until = performance.now() + live * holdMsPerLiveItem;
      while (performance.now() < until) { /* one hold across the history: grows with the live-item count */ }
    }
    return result;
  }, options)) as typeof store.transaction;
}

/** The host's baseline, measured exactly as unit:locked-read-relative-bound measures it: the wall time of `count` trivial coordination-lock acquisitions. */
async function trivialLockHold(count: number): Promise<number> {
  label = 'baseline';
  const started = performance.now();
  for (let n = 0; n < count; n++) await store.transaction(async () => {});
  label = 'other';
  return performance.now() - started;
}

const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };

let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  // An offset no other test file takes: two files sharing a port fail in their `before` hook.
  const port = Number(process.env.GRAPHYARD_LOCKED_READ_BOUND_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1787);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('locked-read-bound'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('locked_read_bound');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/locked_read_bound`); await store.init();
  engine = new Engine(store, 120, 'owner/locked'); engine.submissionObserver = null;
  engine.principals = [operator];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

let template: Work;
async function ensureTemplate() {
  template ??= await engine.execute(operator, 'create', null, { title: 'Template', plannedFiles: ['src/template/'], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:bench'] }] }, randomUUID());
}
function open(n: number): Work {
  return { ...structuredClone(template), id: randomUUID(), key: `OPEN-${n}`, title: `Open change ${n}`, description: `What open change ${n} must do. `.repeat(8), plannedFiles: [`src/area-${n % 7}/module-${n}.ts`], ready: n % 2 === 0, stage: 'backlog' } as Work;
}
async function insert(documents: Work[]) {
  for (let from = 0; from < documents.length; from += 50) {
    const slice = documents.slice(from, from + 50);
    await store.pool.query('INSERT INTO work_items(id, document) SELECT (d->>\'id\')::uuid, d FROM jsonb_array_elements($1::jsonb) AS d', [JSON.stringify(slice)]);
  }
}

/** The seeded ledger: enough items for several batches of writes (eight writes yield a batch), few enough for the failing run to cost seconds. */
const OPEN_ITEMS = 20;
/** The stand-in's per-item hold: with the live-item count near the item count, each batch holds the lock live × this, which is the growth the bound must still catch. */
const HOLD_MS_PER_LIVE_ITEM = 40;
/** The full-pass bound's fixed multiple (GY-1787), kept in step with tests/locked-read.test.ts and checked against its source below. */
const PASS_BOUND_MULTIPLE = 3;

test('unit:locked-read-still-catches-regression — with a stand-in that holds the lock across the history (one hold per batch that grows with the live-item count), the relative full-pass bound still fails, naming the measured total and the bound', async () => {
  // The bound this file exercises is unit:locked-read-relative-bound's own, not a weaker local copy:
  // the same fixed multiple, and the same baseline-plus-batch-budget formula, in its source.
  const relativeBound = readFileSync(new URL('./locked-read.test.ts', import.meta.url), 'utf8');
  assert.match(relativeBound, /const PASS_BOUND_MULTIPLE = 3;/, 'the full-pass bound keeps its fixed multiple');
  assert.match(relativeBound, /PASS_BOUND_MULTIPLE \* \w+ \+ \w+\.length \* engine\.reconcileBatchMs/, 'the full-pass bound is the baseline multiple plus the batch budget');

  await ensureTemplate();
  await insert(Array.from({ length: OPEN_ITEMS }, (_, n) => open(n)));
  timeTransactions();
  holdAcrossTheHistory();
  holdMsPerLiveItem = HOLD_MS_PER_LIVE_ITEM;
  label = 'reconcile'; const from = holds.length;
  await engine.reconcile();
  label = 'other'; holdMsPerLiveItem = 0;
  const batches = holds.slice(from).filter(entry => entry.label === 'reconcile');
  const total = batches.reduce((sum, entry) => sum + entry.ms, 0), longest = Math.max(...batches.map(entry => entry.ms));
  const live = Number((await store.pool.query('SELECT count(*) AS n FROM work_index WHERE settled IS NOT TRUE')).rows[0].n);
  const baseline = await trivialLockHold(batches.length);
  const bound = PASS_BOUND_MULTIPLE * baseline + batches.length * engine.reconcileBatchMs;
  console.log(`stand-in pass: ${batches.length} batches, ${total.toFixed(0)} ms of lock hold (longest ${longest.toFixed(0)} ms) against the bound ${bound.toFixed(0)} ms (${live} live items × ${HOLD_MS_PER_LIVE_ITEM} ms held per batch; baseline ${baseline.toFixed(0)} ms for ${batches.length} trivial acquisitions)`);

  // The shape is what the item names: several batches, and one hold per batch whose length grows
  // with the live-item count — every batch that held the lock held it for at least live × the
  // stand-in's per-item hold, on top of its own work.
  assert.ok(batches.length > 3, `${batches.length} batches`);
  assert.ok(batches.some(entry => entry.locked), 'the pass held the coordination lock');
  assert.ok(batches.filter(entry => entry.locked).every(entry => entry.ms >= live * HOLD_MS_PER_LIVE_ITEM), `every holding batch held the lock at least live × the stand-in's hold (${live} × ${HOLD_MS_PER_LIVE_ITEM} ms; longest ${longest.toFixed(0)} ms)`);
  // The regression is caught: the measured total is past the bound, so the full-pass assertion this
  // stands in for (`total < bound`) fails — against the relative bound, on this host, as it would on
  // a fast one. The message names the measured total and the bound, as the full-pass assertion's does.
  assert.ok(total >= bound, `the stand-in held the lock ${total.toFixed(0)} ms over ${batches.length} batches, past the bound ${bound.toFixed(0)} ms (${PASS_BOUND_MULTIPLE} × the ${baseline.toFixed(0)} ms ${batches.length} trivial lock acquisitions took + ${batches.length} × ${engine.reconcileBatchMs} ms batch budget): the relative full-pass bound still fails for a pass that holds the lock across the history`);
});
