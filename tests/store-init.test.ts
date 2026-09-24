import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { schemaVersion } from '../src/release.js';

// A new release boots while the live replica is mid-coordination: holding the advisory lock
// every coordination transaction takes, with a transaction open on the ledger's tables.
let postgres: EmbeddedPostgres, port: number;
const url = (database: string) => `postgres://graphyard:testing-only@127.0.0.1:${port}/${database}`;

before(async () => {
  port = Number(process.env.GRAPHYARD_STORE_INIT_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 181);
  const scratch = await mkdtemp(join(tmpdir(), 'graphyard-store-init-'));
  postgres = new EmbeddedPostgres({ databaseDir: join(scratch, 'data'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await postgres.initialise(); await postgres.start();
  for (const name of ['migrated', 'changed', 'pending', 'tables']) await postgres.createDatabase(name);
});
after(async () => { if (postgres) await postgres.stop(); });

/** A second connection standing in for the live replica, holding its locks until released. */
async function liveReplica(database: string, hold: (db: pg.Client) => Promise<void>) {
  const db = new pg.Client({ connectionString: url(database) });
  await db.connect();
  await db.query('BEGIN');
  await hold(db);
  return async () => { await db.query('ROLLBACK'); await db.end(); };
}
const holdCoordination = async (db: pg.Client) => {
  await db.query('SELECT pg_advisory_xact_lock(71490321)');
  await db.query("INSERT INTO work_items(id, document) VALUES(gen_random_uuid(), '{}'::jsonb)");
  await db.query('UPDATE work_items SET document = document');
};
async function timed<T>(run: () => Promise<T>) {
  const started = Date.now();
  const result = await run().then(value => ({ value, error: null }), (error: Error) => ({ value: null, error }));
  return { ...result, ms: Date.now() - started };
}

test('integration:init-does-not-wait-on-live-replica an already-migrated release starts while the live replica holds the coordination lock and a work_items transaction', async () => {
  const deployed = new Store(url('migrated'));
  await deployed.init();
  const release = await liveReplica('migrated', holdCoordination);
  const next = new Store(url('migrated'));
  try {
    const boot = await timed(() => next.init());
    assert.equal(boot.error, null, `init failed: ${boot.error?.message}`);
    assert.ok(boot.ms < 3000, `init took ${boot.ms} ms behind the live replica's locks`);
    assert.equal(await next.schema(), schemaVersion);
    // Even with a wait budget far past the health window, the up-to-date path never waits.
    const patient = await timed(() => next.init({ lockTimeoutMs: 600_000 }));
    assert.equal(patient.error, null);
    assert.ok(patient.ms < 3000, `init took ${patient.ms} ms`);
  } finally { await release(); await next.close(); await deployed.close(); }
});

test('integration:init-does-not-wait-on-live-replica a release whose migration differs from the recorded one still migrates', async () => {
  const store = new Store(url('changed'));
  try {
    await store.init();
    // A release that changed the DDL without bumping the generation: the recorded digest differs.
    await store.pool.query("COMMENT ON TABLE graphyard_schema IS 'migration sha256:older'");
    await store.pool.query('ALTER TABLE jobs DROP COLUMN generation');
    await store.init();
    const { rows } = await store.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name='jobs' AND column_name='generation'");
    assert.equal(rows.length, 1, 'the migration re-ran and restored the column');
    assert.equal(await store.schema(), schemaVersion);
  } finally { await store.close(); }
});

test('integration:migration-lock-bounded a release that must migrate fails within its lock timeout naming the coordination lock and the generation it tried to reach', async () => {
  const deployed = new Store(url('pending'));
  await deployed.init();
  // The live replica runs the previous release: nothing records this release's migration yet.
  await deployed.pool.query('COMMENT ON TABLE graphyard_schema IS NULL');
  const release = await liveReplica('pending', holdCoordination);
  const next = new Store(url('pending'));
  try {
    const boot = await timed(() => next.init({ lockTimeoutMs: 500 }));
    assert.ok(boot.error, 'a migrating release must not start while the lock is held');
    assert.ok(boot.ms < 5000, `startup failed only after ${boot.ms} ms`);
    assert.match(boot.error.message, new RegExp(`Schema migration to generation ${schemaVersion} gave up after 500 ms`));
    assert.match(boot.error.message, /waiting for the coordination advisory lock pg_advisory_xact_lock\(71490321\)/);
    assert.match(boot.error.message, /startup fails instead of outlasting the health check/);
  } finally { await release(); }
  try {
    await next.init({ lockTimeoutMs: 500 });
    assert.equal(await next.schema(), schemaVersion, 'once the lock is free the migration completes');
  } finally { await next.close(); await deployed.close(); }
});

test('integration:migration-lock-bounded a migration blocked on a table lock names the table it waited on', async () => {
  const deployed = new Store(url('tables'));
  await deployed.init();
  await deployed.pool.query('COMMENT ON TABLE graphyard_schema IS NULL');
  // No coordination lock: a long read on jobs, whose migration alters the table.
  const release = await liveReplica('tables', async db => { await db.query('SELECT count(*) FROM jobs'); });
  const next = new Store(url('tables'));
  try {
    const boot = await timed(() => next.init({ lockTimeoutMs: 500 }));
    assert.ok(boot.error, 'the migration cannot alter jobs while the read is open');
    assert.ok(boot.ms < 5000, `startup failed only after ${boot.ms} ms`);
    assert.match(boot.error.message, new RegExp(`Schema migration to generation ${schemaVersion} gave up after 500 ms waiting for a lock on table jobs`));
  } finally { await release(); await next.close(); await deployed.close(); }
});

test('unit:startup-lock-documented operations.md states how startup takes coordination locks', async () => {
  const page = await readFile(new URL('../docs/operations.md', import.meta.url), 'utf8');
  assert.match(page, /up-to-date release starts without taking coordination locks/);
  assert.match(page, /migrating release fails fast/);
  assert.match(page, /health check/);
});
