import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { main, refusedBeforeReady } from '../src/server/main.js';
import { Delivery } from '../src/delivery.js';
import { ProductionWatch } from '../src/production-watch.js';

const port = Number(process.env.GRAPHYARD_STARTUP_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1127);
let database: EmbeddedPostgres;
let scratch: string;
let databaseUrl: string;

const credentials = [
  { id: 'admin', role: 'admin', token: 'a'.repeat(32) },
  { id: 'worker', role: 'worker', token: 'w'.repeat(32) },
];

before(async () => {
  scratch = await temporaryDirectory('startup-readiness');
  database = new EmbeddedPostgres({
    databaseDir: join(scratch, 'pg'),
    user: 'graphyard',
    password: 'testing-only',
    port,
    persistent: false,
    onLog: () => {},
    onError: () => {},
    postgresFlags: ['-h', '127.0.0.1'],
  });
  await database.initialise();
  await database.start();
  await database.createDatabase('startup_readiness_test');
  databaseUrl = `postgres://graphyard:testing-only@127.0.0.1:${port}/startup_readiness_test`;
  process.env.DATABASE_URL = databaseUrl;
  process.env.GRAPHYARD_PRINCIPALS = JSON.stringify(credentials);
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  process.env.GITHUB_CI_APP_IDS = '15368';
});

after(async () => {
  await database?.stop();
  if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
});

test('server serves liveness during initialization and gates mutations until production state loads', async () => {
  const original = ProductionWatch.prototype.load;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  ProductionWatch.prototype.load = async () => { await pending; };
  try {
    const instance = await main({ port: 0 });
    try {
      const url = `http://127.0.0.1:${(instance.http.address() as any).port}`;
      assert.equal((await fetch(`${url}/healthz`)).status, 200);
      assert.equal(instance.isReady(), false);
      assert.equal(refusedBeforeReady('POST', '/api/work/GY-1/heartbeat'), false);
      assert.equal(refusedBeforeReady('POST', '/api/work/GY-1/complete'), true);
      assert.equal((await fetch(`${url}/api/work`, { method: 'POST' })).status, 503);
      release();
      for (let i = 0; i < 100 && !instance.isReady(); i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(instance.isReady(), true);
      assert.equal((await fetch(`${url}/healthz?ready`)).status, 200);
    } finally { release(); await instance.close(); }
  } finally { ProductionWatch.prototype.load = original; }
});

 test('unit:server-startup-readiness — routes and the reconciliation tick share the same services', async () => {
  const originalSweep = Delivery.prototype.sweep;
  const deliveries = new Set<Delivery>();
  try {
    Delivery.prototype.sweep = async function (...args) { deliveries.add(this); return originalSweep.apply(this, args); };
    const instance = await main({ port: 0 });
    try {
      assert.equal(instance.validation, instance.http.services.validation);
      assert.equal(instance.http.services.delivery.validation, instance.validation);
      const deadline = Date.now() + 10_000;
      while (!deliveries.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual([...deliveries], [instance.http.services.delivery]);
    } finally { await instance.close(); }
  } finally { Delivery.prototype.sweep = originalSweep; }
});
