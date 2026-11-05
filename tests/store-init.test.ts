import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { databaseUrl } from './helpers/postgres.js';
import { advisoryLocks, Store } from '../src/store.js';
import { schemaVersion } from '../src/release.js';

// A new release boots while the live replica is mid-coordination: holding the advisory lock
// every coordination transaction takes, with a transaction open on the ledger's tables.

const urls = new Map<string, string>();
const url = (database: string) => urls.get(database)!;

before(async () => {
  for (const name of ['fresh', 'migrated', 'changed', 'pending', 'tables', 'deadline', 'statements', 'watchdog', 'work', 'deadlock', 'retired']) urls.set(name, await databaseUrl('store-init' + '-' + name));
});

test('unit:store-init initialises a fresh schema with an empty work list', async () => {
  const store = new Store(url('fresh'));
  try {
    await store.init();
    assert.equal(await store.schema(), schemaVersion);
    assert.deepEqual(await store.list(), []);
  } finally { await store.close(); }
});

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

test('integration:migration-lock-bounded a release that must migrate fails within its lock timeout naming the migration lock and the generation it tried to reach', async () => {
  const deployed = new Store(url('pending'));
  await deployed.init();
  // Nothing records this release's migration yet, and another release is migrating: it holds the
  // migration lock (GY-203: a migration no longer takes the coordination lock, so the live
  // replica's coordination work does not hold it up).
  await deployed.pool.query('COMMENT ON TABLE graphyard_schema IS NULL');
  const release = await liveReplica('pending', async db => { await db.query('SELECT pg_advisory_xact_lock($1)', [advisoryLocks.migration]); });
  const next = new Store(url('pending'));
  try {
    const boot = await timed(() => next.init({ lockTimeoutMs: 500 }));
    assert.ok(boot.error, 'a migrating release must not start while the lock is held');
    assert.ok(boot.ms < 5000, `startup failed only after ${boot.ms} ms`);
    assert.match(boot.error.message, new RegExp(`Schema migration to generation ${schemaVersion} gave up after 500 ms`));
    assert.match(boot.error.message, new RegExp(`waiting for the migration advisory lock pg_advisory_xact_lock\\(${advisoryLocks.migration}\\)`));
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

test('integration:migration-lock-bounded lock waits share one deadline: a lock released just before its timeout does not restart the budget for the next', async () => {
  const deployed = new Store(url('deadline'));
  await deployed.init();
  await deployed.pool.query('COMMENT ON TABLE graphyard_schema IS NULL');
  // Another migrating release holds the migration lock for most of the budget, while a session
  // keeps a read open on jobs that outlasts it: a per-lock budget would wait on each in turn.
  const coordination = await liveReplica('deadline', async db => { await db.query('SELECT pg_advisory_xact_lock($1)', [advisoryLocks.migration]); });
  const reader = await liveReplica('deadline', async db => { await db.query('SELECT count(*) FROM jobs'); });
  let released: Promise<void> | undefined;
  const handoff = setTimeout(() => { released = coordination(); }, 1200);
  const next = new Store(url('deadline'));
  try {
    const boot = await timed(() => next.init({ lockTimeoutMs: 1500 }));
    assert.ok(boot.error, 'the migration cannot alter jobs while the read is open');
    assert.ok(boot.ms < 2300, `startup failed only after ${boot.ms} ms, past its 1500 ms deadline`);
    assert.match(boot.error.message, new RegExp(`Schema migration to generation ${schemaVersion} gave up after 1500 ms waiting for a lock on table jobs`));
  } finally { clearTimeout(handoff); await (released ?? coordination()); await reader(); await next.close(); await deployed.close(); }
});

test('integration:migration-lock-bounded lock waits inside one table\'s DDL share the deadline: the next statement\'s wait does not start a fresh lock_timeout', async () => {
  const deployed = new Store(url('statements'));
  await deployed.init();
  await deployed.pool.query('COMMENT ON TABLE graphyard_schema IS NULL');
  await deployed.pool.query('COMMENT ON TABLE work_index IS NULL');
  // The index DDL alters work_index, then locks work_items to rebuild the projection.
  const observations = await liveReplica('statements', async db => { await db.query('SELECT count(*) FROM work_index'); });
  const merges = await liveReplica('statements', async db => { await db.query('SELECT count(*) FROM work_items'); });
  let released: Promise<void> | undefined;
  const handoff = setTimeout(() => { released = observations(); }, 1200);
  const next = new Store(url('statements'));
  try {
    const boot = await timed(() => next.init({ lockTimeoutMs: 1500 }));
    assert.ok(boot.error, 'the migration cannot rebuild work_index while the read is open');
    assert.ok(boot.ms < 2300, `startup failed only after ${boot.ms} ms, past its 1500 ms deadline`);
    assert.match(boot.error.message, new RegExp(`Schema migration to generation ${schemaVersion} gave up after 1500 ms waiting for a lock on table work_index`));
  } finally { clearTimeout(handoff); await (released ?? observations()); await merges(); await next.close(); await deployed.close(); }
});

test('integration:migration-lock-bounded a migration whose watchdog loses its connection fails at the deadline instead of waiting without one', async () => {
  const deployed = new Store(url('watchdog'));
  await deployed.init();
  await deployed.pool.query('COMMENT ON TABLE graphyard_schema IS NULL');
  await deployed.pool.query('COMMENT ON TABLE work_index IS NULL');
  // As above, lock_timeout alone lets the second statement's wait outlast the deadline; this
  // time the watchdog that would cancel it has lost its connection before the deadline.
  const observations = await liveReplica('watchdog', async db => { await db.query('SELECT count(*) FROM work_index'); });
  const merges = await liveReplica('watchdog', async db => { await db.query('SELECT count(*) FROM work_items'); });
  let released: Promise<void> | undefined;
  const handoff = setTimeout(() => { released = observations(); }, 1200);
  const cut = setTimeout(() => { void deployed.pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name='graphyard migration watchdog'"); }, 300);
  const next = new Store(url('watchdog'));
  try {
    const boot = await timed(() => next.init({ lockTimeoutMs: 1500 }));
    assert.ok(boot.error, 'the migration cannot continue without its watchdog');
    assert.ok(boot.ms < 2300, `startup failed only after ${boot.ms} ms, past its 1500 ms deadline`);
    assert.match(boot.error.message, new RegExp(`Schema migration to generation ${schemaVersion} lost the connection its lock-wait watchdog needs .* past its 1500 ms deadline`));
    assert.match(boot.error.message, /startup fails instead of outlasting the health check/);
  } finally { clearTimeout(handoff); clearTimeout(cut); await (released ?? observations()); await merges(); await next.close(); }
  // The abandoned migration rolled back, and the next one completes.
  const retry = new Store(url('watchdog'));
  try {
    await retry.init({ lockTimeoutMs: 1500 });
    assert.equal(await retry.schema(), schemaVersion);
  } finally { await retry.close(); await deployed.close(); }
});

test('integration:migration-lock-bounded a migration that cannot reserve its watchdog connection fails by its deadline without taking a lock', async () => {
  // The release's role is at its connection limit once the migration holds its own connection.
  const connection = new URL(await databaseUrl('reserve'));
  const role = connection.pathname.slice(1);
  const admin = new pg.Client({ connectionString: connection.href });
  await admin.connect();
  await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'testing-only'`);
  await admin.query(`ALTER DATABASE "${role}" OWNER TO "${role}"`);
  connection.username = role;
  const store = new Store(connection.href);
  try {
    await store.init();
    await store.pool.query('COMMENT ON TABLE graphyard_schema IS NULL');
    await admin.query(`ALTER ROLE "${role}" CONNECTION LIMIT 1`);
    const boot = await timed(() => store.init({ lockTimeoutMs: 500 }));
    assert.ok(boot.error, 'a migration without a watchdog must not start');
    assert.ok(boot.ms < 2000, `startup failed only after ${boot.ms} ms`);
    assert.match(boot.error.message, new RegExp(`Schema migration to generation ${schemaVersion} could not reserve the connection its lock-wait watchdog needs \\(.*too many connections`));
    const { rows } = await admin.query("SELECT count(*)::int AS locks FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND locktype='advisory'");
    assert.equal(rows[0].locks, 0, 'no migration lock was taken');
    await admin.query(`ALTER ROLE "${role}" CONNECTION LIMIT -1`);
    await store.init({ lockTimeoutMs: 500 });
    assert.equal(await store.schema(), schemaVersion, 'with a connection to spare the migration completes');
  } finally { await store.close(); await admin.end(); }
});

test('integration:migration-lock-bounded the budget bounds lock waits only: a migration whose own work outlasts it completes', async () => {
  // A whole migration of an empty database takes far longer than 1 ms, none of it waiting on a lock.
  const store = new Store(url('work'));
  try {
    const boot = await timed(() => store.init({ lockTimeoutMs: 1 }));
    assert.equal(boot.error, null, `init failed: ${boot.error?.message}`);
    assert.ok(boot.ms > 1, `the migration took only ${boot.ms} ms`);
    assert.equal(await store.schema(), schemaVersion);
  } finally { await store.close(); }
});

test('integration:migration-deadlock-retried a live writer queued behind the migration\'s index build does not fail the deploy with a deadlock', async () => {
  // Production, 2026-09-26: building a new index held a share lock on events; a live transaction that had
  // read events queued its insert behind it; the migration then asked for events exclusively (its
  // append-only trigger) and Postgres refused it as a deadlock. Every deploy under live traffic failed.
  const deployed = new Store(url('deadlock'));
  await deployed.init();
  await deployed.pool.query('DROP INDEX events_work_whole');
  await deployed.pool.query('COMMENT ON TABLE graphyard_schema IS NULL');
  const definition = (await deployed.pool.query("SELECT pg_get_functiondef('graphyard_event_work'::regproc) AS sql")).rows[0].sql;
  const [blocker, live] = [new pg.Client({ connectionString: url('deadlock') }), new pg.Client({ connectionString: url('deadlock') })];
  await blocker.connect(); await live.connect();
  const next = new Store(url('deadlock'));
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  try {
    // Holds the migration between its index build and its exclusive lock on events.
    await blocker.query('BEGIN'); await blocker.query(definition);
    await live.query('BEGIN'); await live.query('SELECT count(*) FROM events');
    const boot = timed(() => next.init({ lockTimeoutMs: 10_000 }));
    await pause(300);
    const insert = live.query("INSERT INTO events(actor, kind, payload) VALUES('live', 'probe', '{}'::jsonb)").catch(() => {});
    await pause(200);
    await blocker.query('ROLLBACK');
    await insert;
    await live.query('ROLLBACK');
    const result = await boot;
    assert.equal(result.error, null, `init failed: ${result.error?.message}`);
    assert.equal(await next.schema(), schemaVersion);
  } finally { await blocker.end(); await live.end(); await next.close(); await deployed.close(); }
});

test('unit:store-init — a previous-generation database retires unused job and index fields and tables while preserving board rows and jobs', async () => {
  const store = new Store(url('retired'));
  try {
    await store.init();
    // Reconstitute the previous generation's retired objects, with rows to migrate.
    await store.pool.query(`
      ALTER TABLE jobs ADD COLUMN refreshed_until timestamptz, ADD COLUMN held_on text,
        ADD COLUMN refusals int NOT NULL DEFAULT 0, ADD COLUMN held_until timestamptz, ADD COLUMN held_reason text;
      ALTER TABLE work_index ADD COLUMN owner text, ADD COLUMN epoch numeric, ADD COLUMN next_action text;
      CREATE TABLE merger_default_pin (id boolean PRIMARY KEY, pinned boolean);
      INSERT INTO merger_default_pin VALUES (true, true);
      CREATE TABLE production_observations (id uuid PRIMARY KEY);
      CREATE TABLE production_observation_merges (observation_id uuid REFERENCES production_observations(id), merge_sha text);
      INSERT INTO production_observations VALUES ('00000000-0000-0000-0000-000000000001');
      INSERT INTO production_observation_merges VALUES ('00000000-0000-0000-0000-000000000001', 'old');
      CREATE INDEX events_delivery_repository_instant ON events(created_at, work_id, seq);
      CREATE INDEX events_delivery_first ON events(work_id, seq);
      INSERT INTO work_items(id, document) VALUES ('00000000-0000-0000-0000-000000000002',
        '{"id":"00000000-0000-0000-0000-000000000002","key":"GY-1","stage":"build","priority":3,"revision":1}');
      INSERT INTO jobs(work_id, held_until, held_reason) VALUES ('00000000-0000-0000-0000-000000000002', now()+interval '1 day', 'retired hold');
      COMMENT ON TABLE work_index IS NULL;
      COMMENT ON TABLE graphyard_schema IS NULL;
    `);
    await store.pool.query('UPDATE graphyard_schema SET version=$1', [schemaVersion - 1]);
    await store.init();
    assert.equal(await store.schema(), schemaVersion);
    const columns = (await store.pool.query("SELECT table_name || '.' || column_name AS name FROM information_schema.columns WHERE table_schema='public'")).rows.map(row => row.name);
    for (const name of ['jobs.refreshed_until', 'jobs.held_on', 'jobs.refusals', 'jobs.held_until', 'jobs.held_reason', 'work_index.owner', 'work_index.epoch', 'work_index.next_action']) assert.ok(!columns.includes(name), name);
    for (const name of ['merger_default_pin', 'production_observations', 'production_observation_merges', 'events_delivery_repository_instant', 'events_delivery_first']) {
      assert.equal((await store.pool.query('SELECT to_regclass($1) AS relation', [name])).rows[0].relation, null, name);
    }
    const board = await store.coordinationSnapshot();
    assert.equal(board.work.length, 1);
    assert.equal(board.work[0].key, 'GY-1');
    assert.equal((await store.pool.query('SELECT key, stage FROM work_index')).rows[0].stage, 'build');
    assert.equal((await store.takeJob())?.work_id, '00000000-0000-0000-0000-000000000002');
    await store.init();
    assert.equal((await store.coordinationSnapshot()).work[0].key, 'GY-1');
  } finally { await store.close(); }
});
