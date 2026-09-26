import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { closePool, trackedPool } from '../src/store/pools.js';

// GY-487, follow-ups from the GY-483 review: the close bound must cover pool.end() itself (pg-pool's
// end() never resolves while a client is still checked out), and the shutdown error reporter must be
// installed once per pool, so closing the same pool twice does not stack listeners.
const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 487;

test('unit:store-close-followups — the bound releases a close whose end() never settles, as a leaked checked-out client causes', async () => {
  const pool = trackedPool(new pg.Pool({ connectionString: 'postgres://unused@127.0.0.1:1/none' }));
  // A checked-out client the caller never releases leaves pg-pool's end() pending forever; stand in
  // for that end() directly, since a client emitted on 'connect' never enters the pool's own roster.
  const leaked = Object.assign(new EventEmitter(), { release() {} });
  pool.emit('connect', leaked as never);
  pool.end = (): Promise<void> => new Promise(() => {});
  const logged: string[] = [];
  const started = Date.now();
  await closePool(pool, 'main', 200, line => logged.push(line));
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 190, `the bound, not end(), released the close (took ${elapsed} ms)`);
  assert.ok(elapsed < 2_000, `close returned at the bound, not much later (took ${elapsed} ms)`);
  assert.deepEqual(logged, ['[store] main pool: 1 connection(s) still open 200 ms after end(); continuing shutdown']);
});

test('unit:store-close-followups — closing the same pool twice does not stack listeners', async () => {
  const pool = trackedPool(new pg.Pool({ connectionString: 'postgres://unused@127.0.0.1:1/none' }));
  const client = Object.assign(new EventEmitter(), { release() {} });
  pool.emit('connect', client as never);
  pool.end = (): Promise<void> => Promise.resolve();
  const logged: string[] = [];
  await closePool(pool, 'main', 50, line => logged.push(line));
  const counts = [pool.listenerCount('error'), pool.listenerCount('connect'), client.listenerCount('error')];
  assert.deepEqual(counts, [1, 2, 1], 'one error reporter per pool and client, next to trackedPool\'s connect hook');
  await closePool(pool, 'main', 50, line => logged.push(line));
  assert.deepEqual([pool.listenerCount('error'), pool.listenerCount('connect'), client.listenerCount('error')], counts, 'a second close adds nothing');
  assert.deepEqual(logged, [
    '[store] main pool: 1 connection(s) still open 50 ms after end(); continuing shutdown',
    '[store] main pool: 1 connection(s) still open 50 ms after end(); continuing shutdown',
  ]);
});

test('unit:store-close-followups — a real pool with a never-released client closes at the bound, not never', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-store-close-bound-'));
  const database = new EmbeddedPostgres({ databaseDir: directory, user: 'graphyard', password: 'testing-only', port, persistent: true, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  try {
    await database.initialise(); await database.start(); await database.createDatabase('close_bound');
    const pool = trackedPool(new pg.Pool({ connectionString: `postgres://graphyard:testing-only@127.0.0.1:${port}/close_bound` }));
    const leaked = await pool.connect();
    await leaked.query('SELECT 1');
    const logged: string[] = [];
    const started = Date.now();
    await closePool(pool, 'main', 500, line => logged.push(line));
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 450, `the bound, not the never-settling end(), released the close (took ${elapsed} ms)`);
    assert.ok(elapsed < 3_000, `close returned at the bound (took ${elapsed} ms)`);
    assert.match(logged[0], /main pool: 1 connection\(s\) still open 500 ms after end\(\)/);
    await (leaked as unknown as pg.Client).end();
  } finally {
    await database.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
