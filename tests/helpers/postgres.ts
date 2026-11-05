import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { after } from 'node:test';
import { appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { Store } from '../../src/store.js';
import { reserveTestPorts } from '../../src/cli/test-isolation.js';
import { copyTemplateCluster } from '../../src/e2e/warm-postgres.js';
import { postgresBinaries, startCluster, type LocalPaths } from '../../src/install/local-runtime.js';
import { tempOwnerMarker } from '../../src/tmp-reclaim.js';
import { temporaryDirectory } from './temp-dirs.js';

/**
 * One disposable cluster: a warm copy of the migrated template (src/e2e/warm-postgres.ts) started
 * through the install's own runner (src/install/local-runtime.ts), never the embedded-postgres
 * class. That package arms a process-wide exit hook on import which ends the process with 0 at
 * `beforeExit`, silencing the failing exit code of any process that starts a cluster — this suite's
 * runner and complete's recheck runner among them.
 */
export async function startPostgres(port?: number, template?: Parameters<typeof copyTemplateCluster>[2]) {
  const reservation = port === undefined ? await reserveTestPorts() : undefined;
  port ??= reservation!.base;
  const databaseDir = await temporaryDirectory('postgres');
  const remove = () => Promise.all([rm(databaseDir, { recursive: true, force: true }), rm(tempOwnerMarker(databaseDir), { force: true })]);
  try {
    await copyTemplateCluster(databaseDir, port, template);
    await appendFile(join(databaseDir, 'postgresql.auto.conf'), 'max_connections = 500\n');
    const cluster = await startCluster({ data: databaseDir } as LocalPaths, port, await postgresBinaries());
    return { url: `postgres://graphyard:testing-only@127.0.0.1:${port}/postgres`,
      stop: async () => { try { await cluster.stop(); } finally { await remove(); reservation?.release(); } } };
  } catch (error) { await remove(); reservation?.release(); throw error; }
}

// Capture the file's root scope: a first call inside a test must not stop the cluster
// in that test's after hook while later tests still need it.
const inFileScope = AsyncLocalStorage.snapshot();
let localCluster: Promise<Awaited<ReturnType<typeof startPostgres>>> | undefined;
async function clusterUrl() {
  if (process.env.GRAPHYARD_TEST_DATABASE_URL) return process.env.GRAPHYARD_TEST_DATABASE_URL;
  // Direct node --test and proof runners own one cluster for this process as well.
  if (!localCluster) {
    localCluster = startPostgres();
    inFileScope(() => after(async () => { await (await localCluster!).stop(); }));
  }
  return (await localCluster).url;
}

/** A fresh empty database. Keep its URL when testing migrations, replicas or child servers. */
export async function databaseUrl(label: string): Promise<string> {
  const url = new URL(await clusterUrl());
  const name = `${label.replace(/[^a-z0-9_]/gi, '_').slice(0, 24)}_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString: url.href });
  await client.connect();
  try { await client.query(`CREATE DATABASE "${name}"`); } finally { await client.end(); }
  url.pathname = `/${name}`;
  return url.href;
}

/** Return a Store on a fresh database; callers initialise it and await store.close() in teardown. */
export async function withDatabase(label: string, options?: ConstructorParameters<typeof Store>[1]): Promise<Store> {
  return new Store(await databaseUrl(label), options);
}

/** Disable only this database, disconnecting its clients without disrupting other files. */
export async function databaseAvailable(connection: string, available: boolean) {
  const url = new URL(connection), name = url.pathname.slice(1);
  url.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  try {
    await admin.query(`ALTER DATABASE "${name}" ALLOW_CONNECTIONS ${available}`);
    if (!available) await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [name]);
  } finally { await admin.end(); }
}
