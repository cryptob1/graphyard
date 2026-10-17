import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { schemaGenerations, schemaVersion } from '../src/release.js';
import { currentSchemaCode, runStartupMigration, schemaGenerationDigest, type SchemaCode } from '../src/store/migration-locks.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1961: the schema generation follows the table definitions, so a release whose definitions are
// older than the ones that migrated the database refuses before any statement runs, instead of
// re-running its older DDL over the newer schema and overwriting the recorded digests.
let postgres: EmbeddedPostgres, port: number;
const url = (database: string) => `postgres://graphyard:testing-only@127.0.0.1:${port}/${database}`;

before(async () => {
  port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1961;
  const scratch = await temporaryDirectory('schema-generation-guard');
  postgres = new EmbeddedPostgres({ databaseDir: join(scratch, 'data'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await postgres.initialise(); await postgres.start();
  await postgres.createDatabase('guard');
});
after(async () => { if (postgres) await postgres.stop(); });

/** The code a later release carries: one table's definition changed, so its generation is one newer. */
const later = (code: SchemaCode, release: string, index: string): SchemaCode => {
  const changed = code.tables.find(table => /^DROP TRIGGER IF EXISTS /m.test(table.ddl))!;
  return { ...code, generation: code.generation + 1, release, tables: code.tables.map(table => table === changed
    ? { ...table, ddl: `${table.ddl}\nCREATE INDEX IF NOT EXISTS ${index} ON ${table.name} ((1));` } : table) };
};

/** Every table, column, index and trigger by identity, and the recorded generations and digests: a re-run DDL rebuilds a trigger and changes its oid. */
const snapshot = async (store: Store) => (await store.pool.query(`SELECT json_build_object(
  'tables', (SELECT json_agg(c.oid::text || ':' || c.relname ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'),
  'columns', (SELECT json_agg(table_name || '.' || column_name || ':' || data_type ORDER BY table_name, column_name) FROM information_schema.columns WHERE table_schema='public'),
  'triggers', (SELECT json_agg(t.oid::text || ':' || t.tgname ORDER BY t.tgname) FROM pg_trigger t WHERE NOT t.tgisinternal),
  'generations', (SELECT json_agg(version || ':' || graphyard_version ORDER BY version) FROM graphyard_schema),
  'digest', obj_description(to_regclass('graphyard_schema'),'pg_class')) AS state`)).rows[0].state;

test('unit:schema-generation-guard — a release whose table definitions are older than the database\'s refuses, naming both generations, and changes nothing; the same or newer definitions start as today', async () => {
  // The lineage records the code's own definitions as its newest generation: a DDL change must append its digest.
  assert.equal(schemaGenerations[schemaVersion], schemaGenerationDigest(), `the table definitions changed: append '${schemaGenerationDigest()}' to schemaGenerations in src/release.ts`);
  assert.equal(new Set(schemaGenerations.filter(Boolean)).size, schemaGenerations.filter(Boolean).length, 'each generation records distinct definitions');
  const current = currentSchemaCode(), newer = later(current, '9.9.9', 'gy1961_newer'), newest = later(newer, '10.0.0', 'gy1961_newest');
  assert.notEqual(schemaGenerationDigest(newer), schemaGenerationDigest(current), 'a changed definition is a different generation');

  const store = new Store(url('guard'));
  try {
    // Same definitions start as today, again and again.
    await store.init(); await store.init();
    assert.equal(await store.schema(), schemaVersion);
    // Code with a newer definition migrates forward over it and records its generation and release.
    await runStartupMigration(store.pool, { code: newer });
    assert.equal(await store.schema(), schemaVersion + 1);
    const migrated = await snapshot(store);
    assert.ok(migrated.generations.includes(`${schemaVersion + 1}:9.9.9`));

    // The older definition refuses before any statement runs, naming both generations and both releases.
    await assert.rejects(store.init(), (error: Error) => {
      assert.match(error.message, new RegExp(`generation ${schemaVersion + 1} \\(migrated by Graphyard 9\\.9\\.9\\) is newer than this release supports \\(generation ${schemaVersion}, Graphyard ${current.release.replace(/\./g, '\\.')}\\)`));
      assert.match(error.message, /instead of re-applying its older table definitions — upgrade to Graphyard 9\.9\.9 or newer/);
      return true;
    });
    assert.deepEqual(await snapshot(store), migrated, 'no table, trigger or digest record changed');

    // The newer definitions still start, untouched; newer still migrates forward as today.
    await runStartupMigration(store.pool, { code: newer });
    assert.deepEqual(await snapshot(store), migrated, 'the release that migrated it starts without re-running its DDL');
    await runStartupMigration(store.pool, { code: newest });
    assert.equal(await store.schema(), schemaVersion + 2);
    const { rows } = await store.pool.query("SELECT indexname FROM pg_indexes WHERE indexname LIKE 'gy1961_%' ORDER BY indexname");
    assert.deepEqual(rows.map(row => row.indexname), ['gy1961_newer', 'gy1961_newest']);
  } finally { await store.close(); }
});
