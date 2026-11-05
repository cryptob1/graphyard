import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { runTests } from './helpers/run-tests.js';
import { testPortEnvironment } from '../src/cli/test-isolation.js';

test('unit:test-postgres-helper — equal labels allocate isolated databases and Store.close closes every client', async () => {
  const [first, second] = await Promise.all([withDatabase('same-label'), withDatabase('same-label')]);
  try {
    await first.init(); await second.init();
    await first.pool.query('CREATE TABLE isolated(value int)');
    assert.equal((await second.pool.query("SELECT to_regclass('isolated') AS table")).rows[0].table, null);
    const identity = async (store: typeof first) => (await store.pool.query('SELECT system_identifier FROM pg_control_system()')).rows[0].system_identifier;
    assert.equal(await identity(first), await identity(second));
    assert.notEqual(first.pool.options.connectionString, second.pool.options.connectionString);
    await first.leasePool.query('SELECT 1');
  } finally { await first.close(); await second.close(); }
  const client = new pg.Client({ connectionString: first.pool.options.connectionString });
  await client.connect();
  try {
    assert.equal((await client.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()')).rows[0].n, 0);
  } finally { await client.end(); }
});

test('unit:test-postgres-helper — concurrent test files share one runner cluster, and the runner stops it', async () => {
  const root = await temporaryDirectory('shared-postgres-run');
  const helper = new URL('./helpers/postgres.ts', import.meta.url).href;
  for (const name of ['first', 'second']) await writeFile(join(root, `${name}.test.ts`), `
    import { test } from 'node:test';
    import { writeFile } from 'node:fs/promises';
    import { withDatabase } from ${JSON.stringify(helper)};
    test('database', async () => {
      const store = await withDatabase('same-label');
      try {
        const identity = (await store.pool.query('SELECT system_identifier FROM pg_control_system()')).rows[0];
        await writeFile(${JSON.stringify(join(root, `${name}.json`))}, JSON.stringify({ ...identity, url: store.pool.options.connectionString }));
      } finally { await store.close(); }
    });
  `);
  const result = await runTests({ cwd: root, args: ['--test-concurrency=2', 'first.test.ts', 'second.test.ts'], stdio: 'pipe' });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const [first, second] = await Promise.all(['first', 'second'].map(async name => JSON.parse(await readFile(join(root, `${name}.json`), 'utf8'))));
  assert.equal(first.system_identifier, second.system_identifier);
  assert.notEqual(first.url, second.url);
  assert.equal(Number(new URL(first.url).port), result.base, 'uses the runner reservation');
  const client = new pg.Client({ connectionString: first.url, connectionTimeoutMillis: 1000 });
  try { await assert.rejects(client.connect(), /ECONNREFUSED/); } finally { await client.end(); }
});

test('unit:test-postgres-helper — cluster construction stays in the helper and fixtures have no Postgres port overrides', async () => {
  assert.deepEqual(testPortEnvironment(15438), { GRAPHYARD_TEST_PORT: '15438' }, 'no per-file port overrides reach the suite');
  const root = new URL('.', import.meta.url);
  for (const file of await readdir(root, { recursive: true })) {
    if (!file.endsWith('.ts') || file === 'helpers/postgres.ts') continue;
    const source = await readFile(new URL(file, root), 'utf8');
    assert.ok(!source.includes(['Embedded', 'Postgres'].join('')), `${file} constructs its own cluster`);
    assert.doesNotMatch(source, /process\.env\.GRAPHYARD_\w+_TEST_PORT/, file);
    assert.doesNotMatch(source, /Number\(process\.env\.GRAPHYARD_TEST_PORT[^;\n]*\)\s*\+\s*\d/, file);
  }
});
