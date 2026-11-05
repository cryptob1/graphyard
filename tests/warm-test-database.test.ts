import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { utimes } from 'node:fs/promises';
import pg from 'pg';
import { databaseUrl, startPostgres } from './helpers/postgres.js';
import { reserveTestPorts } from '../src/cli/test-isolation.js';
import { Store } from '../src/store.js';
import { schemaVersion } from '../src/release.js';
import { currentSchemaCode } from '../src/store/migration-locks.js';
import { createMigratedDatabase, templateCluster, warmPassword, warmUser } from '../src/e2e/warm-postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// A test or E2E cluster is a copy of one migrated template cluster per schema digest
// (src/e2e/warm-postgres.ts) instead of a cold initdb, fsync and migration.
let port: number;
const names: Record<string, string> = {};
const url = (at: number, name: string) => `postgres://${warmUser}:${warmPassword}@127.0.0.1:${at}/${names[name] ?? name}`;
before(async () => {
  const allocated = new URL(await databaseUrl('cold'));
  port = Number(allocated.port);
  names.cold = allocated.pathname.slice(1);
});
async function migrated(name: string) {
  names[name] = `warm_${name}_${crypto.randomUUID().replaceAll('-', '')}`;
  await createMigratedDatabase(port, names[name]);
}

async function query<T = any>(at: number, name: string, sql: string): Promise<T[]> {
  const client = new pg.Client(url(at, name)); await client.connect();
  try { return (await client.query(sql)).rows; } finally { await client.end(); }
}
/** Every column, index and trigger, and the recorded generation and digests. */
const schema = async (at: number, name: string) => ({
  columns: await query(at, name, "SELECT table_name, column_name, data_type, column_default, is_nullable FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2"),
  indexes: await query(at, name, "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1"),
  triggers: await query(at, name, "SELECT tgname, tgrelid::regclass::text AS relation FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2"),
  recorded: await query(at, name, "SELECT MAX(version) AS version, obj_description(to_regclass('graphyard_schema'), 'pg_class') AS digest FROM graphyard_schema"),
});

test('integration:warm-test-database — two databases from the warm path are isolated from each other and carry the current schema, exactly what a cold migration builds', async () => {
  await migrated('first'); await migrated('second');
  // The reference: an empty database the cold path migrates.
  const cold = new Store(url(port, 'cold')); await cold.init(); await cold.close();
  const reference = await schema(port, 'cold');
  assert.equal(Number(reference.recorded[0].version), schemaVersion);
  assert.ok(reference.columns.length > 0);
  for (const name of ['first', 'second']) {
    assert.deepEqual(await schema(port, name), reference, `${name} holds the current schema`);
    // Store.init finds the schema recorded and migrates nothing.
    const store = new Store(url(port, name)); await store.init(); await store.close();
    assert.deepEqual(await schema(port, name), reference);
  }
  // What one database writes the other never sees.
  await query(port, 'first', 'CREATE TABLE isolation_probe(id int); INSERT INTO isolation_probe VALUES (1)');
  await query(port, 'first', 'INSERT INTO graphyard_schema(version, graphyard_version) VALUES (100000, \'probe\')');
  assert.equal((await query(port, 'second', "SELECT to_regclass('isolation_probe') AS oid"))[0].oid, null);
  assert.equal(Number((await query(port, 'second', 'SELECT MAX(version) AS version FROM graphyard_schema'))[0].version), schemaVersion);
  // Nor does a database cloned after it: the template is untouched.
  await migrated('third');
  assert.equal((await query(port, 'third', "SELECT to_regclass('isolation_probe') AS oid"))[0].oid, null);
  assert.equal((await query(port, 'first', 'SHOW fsync'))[0].fsync, 'off', 'a throwaway cluster runs with fsync off');
});

test('integration:warm-test-database — the template is rebuilt when the schema generation changes, and the stale one is removed', async () => {
  const root = await temporaryDirectory('warm-templates');
  const reservation = await reserveTestPorts();
  try {
    const current = await templateCluster(reservation.base, { root });
    assert.equal(await templateCluster(reservation.base, { root }), current, 'the same digest reuses its template');
    await utimes(current, new Date(Date.now() - 7_200_000), new Date(Date.now() - 7_200_000));
    const code = currentSchemaCode();
    const next = { ...code, generation: code.generation + 1, tables: [...code.tables, { name: 'warm_probe', ddl: 'CREATE TABLE IF NOT EXISTS warm_probe(id int PRIMARY KEY);' }] };
    const rebuilt = await templateCluster(reservation.base, { root, code: next });
    assert.notEqual(rebuilt, current, 'a new generation builds a new template');
    assert.ok(!existsSync(current), 'the stale template of the old generation is removed');
    // A cluster copied from the rebuilt template clones the new generation's schema.
    const cluster = await startPostgres(reservation.base, { root, code: next });
    try {
      await createMigratedDatabase(reservation.base, 'next');
      assert.notEqual((await query(reservation.base, 'next', "SELECT to_regclass('warm_probe') AS oid"))[0].oid, null);
      assert.equal(Number((await query(reservation.base, 'next', 'SELECT MAX(version) AS version FROM graphyard_schema'))[0].version), schemaVersion + 1);
    } finally { await cluster.stop(); }
  } finally { reservation.release(); }
});
