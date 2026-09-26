import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { pruneReceipts, receiptReplayWindowMs } from '../src/store/receipts.js';
import type { Principal } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * Receipts grew without bound: no timestamp, no pruning, and every lease renewal stored a whole
 * work document under a fresh key. A renewal's receipt is now compact, and receipts past the
 * replay window are pruned in bounded runs outside the coordination lock.
 */
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker' };
let pg: EmbeddedPostgres, store: Store, engine: Engine;
let serial = 0;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 171;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('receipt-retention'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('receipt_retention_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/receipt_retention_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.submissionObserver = null;
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });

const receipt = async (actor: string, key: string) => (await store.pool.query('SELECT result, created_at, pg_column_size(result) AS bytes FROM receipts WHERE actor=$1 AND key=$2', [actor, key])).rows[0] as { result: any; created_at: Date | null; bytes: number } | undefined;
const age = (actor: string, key: string, ms: number) => store.pool.query("UPDATE receipts SET created_at = now() - ($3::text||' milliseconds')::interval WHERE actor=$1 AND key=$2", [actor, key, String(ms)]);

async function claimed() {
  const n = ++serial;
  let w = await engine.execute(operator, 'create', null, { title: `Receipts ${n}`, description: 'x'.repeat(4000), plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:x'] }] }, randomUUID());
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID());
  return engine.execute(worker, 'claim', w.id, {}, randomUUID());
}

test('unit:receipt-replay-within-window — a replayed command inside the window answers the result it accepted, and a reused key with different input still refuses', async () => {
  const w = await claimed();
  const key = randomUUID();
  const first = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/receipts-${serial}`, branch: `graphyard/receipts-${serial}` }, key);
  await age(worker.id, key, receiptReplayWindowMs - 60_000);
  assert.equal(await pruneReceipts(store.pool), 0, 'nothing inside the window is pruned');
  const replayed = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/receipts-${serial}`, branch: `graphyard/receipts-${serial}` }, key);
  assert.deepEqual(replayed, JSON.parse(JSON.stringify(first)), 'the replay is the accepted result');
  await assert.rejects(engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: '/tmp/elsewhere', branch: 'graphyard/elsewhere' }, key), /Idempotency key reused with different input/);
});

test('unit:heartbeat-receipt-compact — a renewal answers the whole document once, stores only the lease, and its replay satisfies the supervisor', async () => {
  const w = await claimed();
  const key = randomUUID();
  const renewed = await engine.execute(worker, 'heartbeat', w.id, { epoch: 1 }, key);
  assert.ok(renewed.criteria && renewed.description, 'the first answer is still the full document');
  const stored = (await receipt(worker.id, key))!;
  assert.ok(stored.created_at instanceof Date, 'a new receipt is timestamped');
  assert.equal(stored.result.description, undefined, 'the receipt carries no work document');
  assert.equal(stored.result.criteria, undefined);
  const claim = (await store.pool.query("SELECT pg_column_size(result) AS bytes FROM receipts WHERE actor=$1 AND result->>'stage' IS NOT NULL AND result ? 'criteria' ORDER BY created_at DESC LIMIT 1", [worker.id])).rows[0];
  assert.ok(stored.bytes * 4 < claim.bytes, `the renewal receipt (${stored.bytes} B) is a fraction of a full one (${claim.bytes} B)`);
  const replay = await engine.execute(worker, 'heartbeat', w.id, { epoch: 1 }, key);
  // What the supervisor reads from a renewal (src/supervisor.ts heartbeat()).
  assert.equal(replay.lease!.epoch, 1);
  assert.equal(replay.lease!.expiresAt, renewed.lease!.expiresAt);
  assert.equal(replay.updatedAt, renewed.updatedAt);
  assert.ok(Date.parse(replay.lease!.expiresAt) - Date.parse(replay.updatedAt) > 0);
  assert.deepEqual({ id: replay.id, key: replay.key, revision: replay.revision }, { id: renewed.id, key: renewed.key, revision: renewed.revision });
  await assert.rejects(engine.execute(worker, 'heartbeat', w.id, { epoch: 2 }, key), /Idempotency key reused with different input/);
});

test('unit:receipt-pruning-window — pruning removes only receipts past the window, bounded per run, and leaves the event ledger alone', async () => {
  const w = await claimed();
  const keys = Array.from({ length: 5 }, () => randomUUID());
  for (const key of keys) await engine.execute(worker, 'heartbeat', w.id, { epoch: 1 }, key);
  const events = Number((await store.pool.query('SELECT count(*) AS n FROM events')).rows[0].n);
  for (const key of keys.slice(0, 3)) await age(worker.id, key, receiptReplayWindowMs + 60_000);
  await age(worker.id, keys[3], receiptReplayWindowMs - 60_000);
  assert.equal(await pruneReceipts(store.pool, { limit: 2 }), 2, 'one run deletes at most its limit');
  assert.equal(await pruneReceipts(store.pool, { limit: 2 }), 1, 'the next run takes the rest of the backlog');
  assert.equal(await pruneReceipts(store.pool), 0);
  for (const key of keys.slice(0, 3)) assert.equal(await receipt(worker.id, key), undefined, 'an expired receipt is gone');
  for (const key of keys.slice(3)) assert.ok(await receipt(worker.id, key), 'a receipt inside the window stays');
  assert.equal(Number((await store.pool.query('SELECT count(*) AS n FROM events')).rows[0].n), events, 'no event row is touched');
  // A receipt restored from a backup that predates the column has no age and is pruned.
  await store.pool.query('UPDATE receipts SET created_at=NULL WHERE actor=$1 AND key=$2', [worker.id, keys[4]]);
  assert.equal(await pruneReceipts(store.pool), 1);
  assert.ok(await receipt(worker.id, keys[3]));
  // A pruned key is a new command: past the window a retry executes instead of replaying.
  const again = await engine.execute(worker, 'heartbeat', w.id, { epoch: 1 }, keys[0]);
  assert.equal(again.lease!.epoch, 1);
});
