import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { main, refusedBeforeReady } from '../src/server/main.js';
import { Validation } from '../src/validation.js';

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

test('unit:server-listens-before-startup-validation — with startup artifact expiry and the startup validation reconcile each stubbed to take 5 minutes, the server process answers GET /healthz within 10 s of start: http.listen is no longer behind validation.expireArtifacts or validation.reconcile(true)', async () => {
  const origExpire = Validation.prototype.expireArtifacts;
  const origReconcile = Validation.prototype.reconcile;
  try {
    Validation.prototype.expireArtifacts = async () => new Promise<number>(resolve => {
      const timer = setTimeout(() => resolve(0), 300_000);
      if (typeof timer === 'object' && timer && 'unref' in timer) (timer as any).unref();
    });
    Validation.prototype.reconcile = async () => new Promise<void>(resolve => {
      const timer = setTimeout(() => resolve(), 300_000);
      if (typeof timer === 'object' && timer && 'unref' in timer) (timer as any).unref();
    });

    const startedAt = Date.now();
    const instance = await main({ port: 0 });
    try {
      const serverPort = (instance.http.address() as any).port;
      const res = await fetch(`http://127.0.0.1:${serverPort}/healthz`);
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 10_000, `answered GET /healthz within 10 s of start (took ${elapsed} ms)`);
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.equal(body.ok, true);
      assert.equal(body.readiness, false);
      assert.equal(instance.isReady(), false);
    } finally {
      await instance.close();
    }
  } finally {
    Validation.prototype.expireArtifacts = origExpire;
    Validation.prototype.reconcile = origReconcile;
  }
});

test('unit:startup-validation-gates-coordination — until the startup validation reconcile has completed, endpoints whose answer depends on it either wait for it or are refused with a retryable 503 naming startup validation, and GET /healthz reports readiness true once complete', async () => {
  const origExpire = Validation.prototype.expireArtifacts;
  const origReconcile = Validation.prototype.reconcile;
  let resolveExpire!: (value: number) => void;
  let resolveReconcile!: () => void;
  const expirePromise = new Promise<number>(resolve => { resolveExpire = resolve; });
  const reconcilePromise = new Promise<void>(resolve => { resolveReconcile = resolve; });

  try {
    Validation.prototype.expireArtifacts = async () => expirePromise;
    Validation.prototype.reconcile = async function (includeCompleted?: boolean): Promise<void> {
      if (includeCompleted) return reconcilePromise;
      return origReconcile.call(this, includeCompleted);
    };

    const instance = await main({ port: 0 });
    try {
      const serverPort = (instance.http.address() as any).port;
      const baseUrl = `http://127.0.0.1:${serverPort}`;

      // 1. GET /healthz reports liveness throughout with readiness false
      const healthBefore = await fetch(`${baseUrl}/healthz`).then(r => r.json()) as any;
      assert.equal(healthBefore.ok, true);
      assert.equal(healthBefore.readiness, false);
      // A readiness probe asking ?ready is kept off this replica until startup validation completes.
      assert.equal((await fetch(`${baseUrl}/healthz?ready`)).status, 503);
      // Only mutations are refused: a webhook delivery and a lease heartbeat pass, and so do reads.
      assert.equal(refusedBeforeReady('POST', '/api/github/webhook'), false);
      assert.equal(refusedBeforeReady('POST', '/api/work/GY-1/heartbeat'), false);
      assert.equal(refusedBeforeReady('GET', '/api/work/GY-1'), false);
      assert.equal(refusedBeforeReady('POST', '/api/work/GY-1/complete'), true);
      assert.equal(refusedBeforeReady('POST', '/api/actions/0123456789abcdef0123456789abcdef/renew'), true);

      // 2. Coordination mutation is refused with retryable 503 naming startup validation
      const mutationRes = await fetch(`${baseUrl}/api/work`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${'a'.repeat(32)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'Coordination test', plannedFiles: [], criteria: [] }),
      });
      assert.equal(mutationRes.status, 503);
      assert.equal(mutationRes.headers.get('retry-after'), '5');
      const mutationBody = await mutationRes.json() as any;
      assert.equal(mutationBody.retryable, true);
      assert.match(mutationBody.error, /startup validation/i);

      // 3. Delivery gate is refused with retryable 503 naming startup validation
      const deliveryRes = await fetch(`${baseUrl}/api/delivery/select`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${'a'.repeat(32)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      assert.equal(deliveryRes.status, 503);
      assert.equal(deliveryRes.headers.get('retry-after'), '5');
      const deliveryBody = await deliveryRes.json() as any;
      assert.equal(deliveryBody.retryable, true);
      assert.match(deliveryBody.error, /startup validation/i);

      // 4. Now complete startup validation
      resolveExpire(0);
      resolveReconcile();

      // Wait for instance to become ready
      const waitStart = Date.now();
      while (!instance.isReady() && Date.now() - waitStart < 5000) {
        await new Promise(r => setTimeout(r, 20));
      }
      assert.ok(instance.isReady(), 'instance became ready after startup validation completed');

      // 5. GET /healthz reports readiness true
      const healthAfter = await fetch(`${baseUrl}/healthz`).then(r => r.json()) as any;
      assert.equal(healthAfter.ok, true);
      assert.equal(healthAfter.readiness, true);
      assert.equal((await fetch(`${baseUrl}/healthz?ready`)).status, 200);

      // 6. Mutation is no longer refused with 503
      const mutationAfter = await fetch(`${baseUrl}/api/work`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${'a'.repeat(32)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'Coordination test 2', plannedFiles: [], criteria: [] }),
      });
      assert.notEqual(mutationAfter.status, 503);
    } finally {
      await instance.close();
    }
  } finally {
    Validation.prototype.expireArtifacts = origExpire;
    Validation.prototype.reconcile = origReconcile;
  }
});

test('unit:startup-validation-failure-retried — a startup validation failure is logged and retried by the reconciliation tick instead of exiting the process or leaving readiness false forever', async () => {
  const origExpire = Validation.prototype.expireArtifacts;
  const origReconcile = Validation.prototype.reconcile;
  let reconcileAttempts = 0;
  const errorLogs: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    errorLogs.push(args.map(String).join(' '));
    origError(...args);
  };

  try {
    Validation.prototype.expireArtifacts = async () => 0;
    Validation.prototype.reconcile = async function (includeCompleted?: boolean): Promise<void> {
      if (includeCompleted) {
        reconcileAttempts++;
        if (reconcileAttempts === 1) {
          throw new Error('transient startup validation DB error');
        }
      }
      return origReconcile.call(this, includeCompleted);
    };

    const instance = await main({ port: 0 });
    try {
      const serverPort = (instance.http.address() as any).port;
      const baseUrl = `http://127.0.0.1:${serverPort}`;

      // 1. Verify failure was logged
      const logStart = Date.now();
      while (!errorLogs.some(l => /startup validation failed/i.test(l)) && Date.now() - logStart < 3000) {
        await new Promise(r => setTimeout(r, 20));
      }
      assert.ok(errorLogs.some(l => /startup validation failed/i.test(l)), 'startup validation failure was logged');

      // 2. Process did NOT exit, server is still listening
      assert.equal(instance.http.listening, true);

      // 3. Reconciliation tick retried and readiness turned true
      const retryStart = Date.now();
      while (!instance.isReady() && Date.now() - retryStart < 10_000) {
        await new Promise(r => setTimeout(r, 20));
      }
      assert.ok(reconcileAttempts >= 2, `startup validation was retried (attempts: ${reconcileAttempts})`);
      assert.ok(instance.isReady(), 'readiness turned true after tick retry');

      // 4. GET /healthz reports readiness true
      const health = await fetch(`${baseUrl}/healthz`).then(r => r.json()) as any;
      assert.equal(health.ok, true);
      assert.equal(health.readiness, true);
    } finally {
      await instance.close();
    }
  } finally {
    console.error = origError;
    Validation.prototype.expireArtifacts = origExpire;
    Validation.prototype.reconcile = origReconcile;
  }
});

test('close during startup validation stops cleanly without launching background work', async () => {
  const origExpire = Validation.prototype.expireArtifacts;
  const origReconcile = Validation.prototype.reconcile;
  try {
    Validation.prototype.expireArtifacts = async () => new Promise<number>(resolve => setTimeout(() => resolve(0), 5000));
    const instance = await main({ port: 0 });
    assert.equal(instance.isReady(), false);
    await instance.close();
    assert.equal(instance.isReady(), false);
  } finally {
    Validation.prototype.expireArtifacts = origExpire;
    Validation.prototype.reconcile = origReconcile;
  }
});

