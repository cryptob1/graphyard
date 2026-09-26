import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { closePool, trackedPool } from '../src/store/pools.js';

// GY-483: pg-pool's end() resolved once it had asked its idle clients to end, not once they had
// closed, so a test that stopped Postgres straight after Store.close() could terminate a live
// client ("terminating connection due to administrator command"), about one CI run in eight.
const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 483;
let directory: string | undefined, database: EmbeddedPostgres | undefined;
after(async () => {
  await database?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('unit:store-close-waits-for-clients — a store with idle clients closes fully before Postgres stops, 50 times over', async () => {
  directory = await mkdtemp(join(tmpdir(), 'graphyard-store-close-'));
  database = new EmbeddedPostgres({ databaseDir: directory, user: 'graphyard', password: 'testing-only', port, persistent: true, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('store_close');
  const url = `postgres://graphyard:testing-only@127.0.0.1:${port}/store_close`;
  const failures: string[] = [], warnings: string[] = [];
  const unhandled = (error: unknown) => { failures.push(String((error as Error)?.message ?? error)); };
  const warn = console.warn;
  process.on('uncaughtException', unhandled); process.on('unhandledRejection', unhandled);
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    for (let round = 0; round < 50; round++) {
      if (round) await database.start();
      const store = new Store(url);
      // Several connections on each pool, all idle by the time close() runs.
      await Promise.all(Array.from({ length: 6 }, () => store.pool.query('SELECT pg_sleep(0.005)')));
      await Promise.all(Array.from({ length: 2 }, () => store.leasePool.query('SELECT 1')));
      assert.ok(store.pool.idleCount >= 2 && store.leasePool.idleCount >= 1, 'the store holds idle clients when it closes');
      await store.close();
      await database.stop();
      // Give a still-open client's socket error its turn to surface before the next round.
      await new Promise(resolve => setImmediate(resolve));
    }
  } finally {
    process.off('uncaughtException', unhandled); process.off('unhandledRejection', unhandled);
    console.warn = warn;
  }
  assert.deepEqual(failures, [], 'no unhandled error escaped a closing store');
  assert.deepEqual(warnings.filter(line => /terminating connection/i.test(line)), [], 'no connection was terminated by the database stopping');
  assert.deepEqual(warnings, [], 'every connection closed well inside the bound');
});

test('unit:store-close-waits-for-clients — closePool resolves only after each client emits end, bounds the wait, and logs shutdown errors', async () => {
  const pool = trackedPool(new pg.Pool({ connectionString: 'postgres://unused@127.0.0.1:1/none' }));
  // A pool whose one client is still checked out: end() cannot close it, so the bound decides.
  const client = Object.assign(new EventEmitter(), { release() {} });
  pool.emit('connect', client as never);
  const logged: string[] = [];
  const started = Date.now();
  let settled = false;
  const closing = closePool(pool, 'main', 150, line => logged.push(line)).then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(settled, false, 'close waits while a client is still open');
  client.emit('error', new Error('terminating connection due to administrator command'));
  pool.emit('error', new Error('Connection terminated unexpectedly'), client as never);
  await closing;
  assert.ok(Date.now() - started >= 140, 'the bound, not end(), released the wait');
  assert.equal(logged.length, 3, logged.join('\n'));
  assert.match(logged[0], /main pool connection error during shutdown: terminating connection/);
  assert.match(logged[1], /main pool connection error during shutdown: Connection terminated unexpectedly/);
  assert.match(logged[2], /main pool: 1 connection\(s\) still open 150 ms after end\(\)/);

  // A client that emits end releases the wait at once.
  const quick = trackedPool(new pg.Pool({ connectionString: 'postgres://unused@127.0.0.1:1/none' }));
  const open = Object.assign(new EventEmitter(), { release() {} });
  quick.emit('connect', open as never);
  const begun = Date.now(), done = closePool(quick, 'lease', 5_000, line => logged.push(line));
  setTimeout(() => open.emit('end'), 20);
  await done;
  assert.ok(Date.now() - begun < 1_000, 'the end event, not the bound, released the wait');
  assert.equal(logged.length, 3, 'a clean close logs nothing');
});
