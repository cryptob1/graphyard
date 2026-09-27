import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { Store, migrationDigests, recordedMigrationDigests } from '../src/store.js';
import { migrationBackoffMs, retryLockFailures } from '../src/store/migration-locks.js';
import { schemaVersion } from '../src/release.js';

// GY-773: a deploy migrates under live traffic. The migration records a digest per table and
// touches only the tables whose DDL changed, so the hot tables live traffic writes through are
// never asked for a lock their unchanged DDL does not need; a changed hot table's alter is
// retried with backoff inside the lock budget instead of failing the deploy.
let postgres: EmbeddedPostgres, port: number;
const url = (database: string) => `postgres://graphyard:testing-only@127.0.0.1:${port}/${database}`;

before(async () => {
  port = Number(process.env.GRAPHYARD_MIGRATION_LOAD_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 182);
  const scratch = await mkdtemp(join(tmpdir(), 'graphyard-migration-load-'));
  postgres = new EmbeddedPostgres({ databaseDir: join(scratch, 'data'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await postgres.initialise(); await postgres.start();
  for (const name of ['skips', 'upgrade', 'load']) await postgres.createDatabase(name);
});
after(async () => { if (postgres) await postgres.stop(); });

const digests = migrationDigests();
const recorded = async (store: Store) => recordedMigrationDigests((await store.pool.query("SELECT obj_description(to_regclass('graphyard_schema'),'pg_class') AS comment")).rows[0].comment);
/** A utility statement takes no bind parameters: escape the comment into the statement itself. */
const setComment = (store: Store, value: string) => store.pool.query(`COMMENT ON TABLE graphyard_schema IS '${value.replace(/'/g, "''")}'`);
/** Rewrite one table's recorded digest as stale, as a release whose registry changed that table's DDL would leave it. */
async function markStale(store: Store, table: string) {
  const before = await recorded(store);
  if (!before.tables || !before.migration || !before.prelude) throw new Error('the migration digests were not recorded');
  await setComment(store, JSON.stringify({ migration: before.migration, prelude: before.prelude, tables: { ...before.tables, [table]: 'sha256:changed' } }));
}
/** A live transaction held open across the migration, writing the table the way live traffic does. */
async function liveWriter(database: string, statements: string[]) {
  const db = new pg.Client({ connectionString: url(database) });
  await db.connect();
  await db.query('BEGIN');
  for (const statement of statements) await db.query(statement);
  return {
    db,
    /** The transaction was open and writable the whole time: commit it now and its rows appear. */
    commit: async () => { await db.query('COMMIT'); await db.end(); },
  };
}
async function timed<T>(run: () => Promise<T>) {
  const started = Date.now();
  const result = await run().then(value => ({ value, error: null }), (error: Error) => ({ value: null, error }));
  return { ...result, ms: Date.now() - started };
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('integration:migration-skips-unchanged-tables a migration that re-runs one changed table\'s DDL takes no lock on the unchanged table a live writer holds', async () => {
  const store = new Store(url('skips'));
  await store.init();
  // A release changed only jobs' DDL: its recorded digest no longer matches and the column its
  // DDL adds is gone, so jobs must be altered. receipts' DDL is unchanged since it was recorded.
  await store.pool.query('ALTER TABLE jobs DROP COLUMN generation');
  await markStale(store, 'jobs');
  const before = await recorded(store);
  // The live transaction writes receipts throughout: an ALTER or index build on receipts would
  // queue behind it and fail the lock budget instead of completing.
  const live = await liveWriter('skips', ["INSERT INTO receipts(actor, key, fingerprint, result) VALUES('live', 'order-1', 'fp', '{}'::jsonb)"]);
  const next = new Store(url('skips'));
  try {
    const boot = await timed(() => next.init({ lockTimeoutMs: 30_000 }));
    assert.equal(boot.error, null, `init failed: ${boot.error?.message}`);
    assert.ok(boot.ms < 10_000, `the migration took ${boot.ms} ms, past its lock budget's window, while receipts' writer held the table`);
    const { rows } = await next.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name='jobs' AND column_name='generation'");
    assert.equal(rows.length, 1, "the changed table's DDL still migrates");
    const after = await recorded(next);
    assert.equal(after.tables?.receipts, before.tables?.receipts, "the unchanged table's recorded digest is untouched");
    assert.equal(after.tables?.jobs, digests.tables.jobs, "the changed table's digest is recorded afresh");
    await live.commit();
    const pending = await next.pool.query("SELECT count(*)::int AS n FROM receipts WHERE actor='live'");
    assert.equal(pending.rows[0].n, 1, 'the live writer was never waited on: its transaction stayed open and committed after the migration');
  } finally { await next.close(); await store.close(); }
});

test('integration:migration-skips-unchanged-tables a release recording the first per-table digests asks no work table for a lock', async () => {
  const store = new Store(url('upgrade'));
  await store.init();
  // The deployed release recorded the whole migration's digest alone, as releases before
  // per-table digests did: this release's own startup upgrades that comment, and the upgrade
  // must not touch a work table to do it.
  await setComment(store, digests.migration);
  const live = await liveWriter('upgrade', [
    "INSERT INTO receipts(actor, key, fingerprint, result) VALUES('live', 'order-1', 'fp', '{}'::jsonb)",
    "INSERT INTO events(actor, kind, payload) VALUES('live', 'probe', '{}'::jsonb)",
  ]);
  const next = new Store(url('upgrade'));
  try {
    const boot = await timed(() => next.init({ lockTimeoutMs: 30_000 }));
    assert.equal(boot.error, null, `init failed: ${boot.error?.message}`);
    assert.ok(boot.ms < 3000, `recording the digests took ${boot.ms} ms behind the live writers`);
    const after = await recorded(next);
    assert.deepEqual(after, { migration: digests.migration, prelude: digests.prelude, tables: digests.tables });
    assert.equal(await next.schema(), schemaVersion);
    await live.commit();
  } finally { await next.close(); await store.close(); }
});

test('integration:migration-under-continuous-writes a migration that adds a column to a hot table completes under continuous writers, none waiting past the lock budget', async () => {
  const store = new Store(url('load'));
  await store.init();
  // A release changed receipts' DDL: the column its DDL adds is gone and its recorded digest no
  // longer matches, so the migration alters the hot table for real. events' DDL is unchanged, so
  // its writers are never disturbed at all.
  await store.pool.query('ALTER TABLE receipts DROP COLUMN created_at');
  await markStale(store, 'receipts');
  // Each attempt may wait for its locks this long; the migration's retries share the whole budget.
  const attemptMs = 500, budgetMs = 15_000;
  // A live batch on receipts stays open well past one attempt's budget when the migration starts:
  // the first attempts must time out, roll back and retry, and only a retry after it commits succeeds.
  const batchMs = 2_500;
  // A writer never waits behind the migration past one attempt's lock budget, plus scheduling slack.
  const writerBoundMs = attemptMs + 1_000;
  const clients = [0, 1, 2].map(() => new pg.Client({ connectionString: url('load') }));
  const [receiptsClient, eventsClient, batchClient] = clients;
  for (const client of clients) await client.connect();
  let stopped = false;
  const failures: unknown[] = [];
  const writes = { receipts: [] as number[], events: [] as number[] };
  const write = async (db: pg.Client, statement: (i: number) => string, latencies: number[]) => {
    for (let i = 0; !stopped && i < 100_000; i++) {
      const started = Date.now();
      try { await db.query(statement(i)); latencies.push(Date.now() - started); } catch (error) { failures.push(error); await pause(50); }
      await pause(5);
    }
  };
  await batchClient.query('BEGIN');
  await batchClient.query("INSERT INTO receipts(actor, key, fingerprint, result) VALUES('live', 'batch', 'fp', '{}'::jsonb)");
  const batch = pause(batchMs).then(() => batchClient.query('COMMIT'));
  const running = Promise.all([
    write(receiptsClient, i => `INSERT INTO receipts(actor, key, fingerprint, result) VALUES('live', 'k${i}', 'fp', '{}'::jsonb)`, writes.receipts),
    write(eventsClient, () => "INSERT INTO events(actor, kind, payload) VALUES('live', 'probe', '{}'::jsonb)", writes.events),
  ]);
  const next = new Store(url('load'));
  try {
    const boot = await timed(() => next.init({ lockTimeoutMs: budgetMs, attemptLockTimeoutMs: attemptMs }));
    stopped = true; await running; await batch;
    assert.deepEqual(failures, []);
    assert.equal(boot.error, null, `init failed: ${boot.error?.message}`);
    assert.ok(boot.ms >= batchMs - 200, `the migration completed after ${boot.ms} ms, before the live batch released receipts: it was not held up`);
    assert.ok(boot.ms < budgetMs, `the migration took ${boot.ms} ms, past its ${budgetMs} ms lock budget`);
    assert.equal(await next.schema(), schemaVersion);
    const { rows } = await next.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name='receipts' AND column_name='created_at'");
    assert.equal(rows.length, 1, "the hot table's new column was added under live writes");
    const batched = await next.pool.query("SELECT count(*)::int AS n FROM receipts WHERE key='batch'");
    assert.equal(batched.rows[0].n, 1, 'the live batch committed: the migration waited it out instead of failing the deploy');
    assert.ok(writes.receipts.length > 0 && writes.events.length > 0, 'both writers kept writing throughout');
    for (const [table, latencies] of [['receipts', writes.receipts], ['events', writes.events]] as const)
      assert.ok(Math.max(...latencies) < writerBoundMs, `an ${table} write waited ${Math.max(...latencies)} ms, past the ${attemptMs} ms lock budget of one attempt`);
  } finally {
    stopped = true;
    for (const client of clients) await client.end().catch(() => {});
    await next.close(); await store.close();
  }
});

test('unit:migration-retry-backoff a failed attempt releases its locks, backs off doubling, and retries within the budget; anything else is raised at once', async () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(migrationBackoffMs), [100, 200, 400, 800, 1600, 2000, 2000]);
  let attempts = 0, rollbacks = 0;
  const sleeps: number[] = [];
  await retryLockFailures(
    async () => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      if (attempts === 2) throw Object.assign(new Error('lock timeout expired'), { code: '55P03' });
    },
    () => true,
    async () => { rollbacks++; },
    async attempt => { sleeps.push(migrationBackoffMs(attempt)); },
  );
  assert.equal(attempts, 3, 'the migration ran again after each transient failure');
  assert.equal(rollbacks, 2, 'every failed attempt rolled back, releasing its locks at once');
  assert.deepEqual(sleeps, [100, 200], 'each retry backed off longer than the one before');
  const coded = (code: string) => Object.assign(new Error(`failed with ${code}`), { code });
  await assert.rejects(
    retryLockFailures(async () => { throw coded('23505'); }, () => true, async () => { rollbacks++; }, async () => { sleeps.push(0); }),
    /failed with 23505/,
    'an error live traffic does not cause is never retried',
  );
  await assert.rejects(
    retryLockFailures(async () => { throw coded('40P01'); }, () => false, async () => { rollbacks++; }, async () => { sleeps.push(0); }),
    /failed with 40P01/,
    'past the lock budget the failure is raised instead of retried',
  );
  assert.equal(rollbacks, 2, 'a failure that is not retried leaves nothing to roll back');
});
