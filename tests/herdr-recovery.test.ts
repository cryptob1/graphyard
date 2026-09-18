import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine, launchFenceMs } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal } from '../src/model.js';
// @ts-expect-error The trusted runner intentionally uses dependency-free JavaScript outside the candidate source.
import { exercise, requiredCases, requiredFences } from '../scripts/herdr-recovery-contract.mjs';
// @ts-expect-error Dependency-free protected workflow script.
import { contract, contracts } from '../scripts/contracts.mjs';

// Real lease and launch fences are minutes long. The contract reads both from the candidate, so a
// short-fenced deployment exercises the identical recovery path within a test run once this suite
// states the fences its own engine ships; a trusted run always requires the production defaults.
const leaseSeconds = 5, launchFence = 3000;
const shortFences = { leaseMs: leaseSeconds * 1000, launchAuthorityMs: launchFence };
const operator: Principal = { id: 'recovery-operator', role: 'admin' };
const machines = [1, 2].map(n => ({ id: `recovery-machine-${n}`, role: 'worker' as const, token: `test-machine-${n}-${'x'.repeat(32)}` }));
let pg: EmbeddedPostgres; let store: Store; let http: ReturnType<typeof server>; let url: string;
const identities = () => [{ ...operator, token: 'r'.repeat(32) }, ...machines];
before(async () => {
  const port = Number(process.env.GRAPHYARD_RECOVERY_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 2);
  pg = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-recovery-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('recovery_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/recovery_test`); await store.init();
  http = server(new Engine(store, [15368], leaseSeconds, 'owner/project', launchFence), [{ ...operator, token: 'r'.repeat(32) }, ...machines]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (pg) await pg.stop(); });

// Proxy the real server and weaken exactly one refusal, proving each case is not vacuous.
async function withoutRefusal(route: string, body: (weakened: string) => Promise<void>) {
  const forging = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    const upstream = await fetch(`${url}${req.url}`, { method: req.method, body: chunks.length ? Buffer.concat(chunks) : undefined,
      headers: Object.fromEntries(['authorization', 'content-type', 'idempotency-key'].filter(h => req.headers[h]).map(h => [h, String(req.headers[h])])) });
    const payload = await upstream.text();
    res.writeHead(req.url!.endsWith(route) && upstream.status === 409 ? 200 : upstream.status, { 'Content-Type': 'application/json' });
    res.end(payload);
  });
  await new Promise<void>(resolve => forging.listen(0, '127.0.0.1', resolve));
  try { await body(`http://127.0.0.1:${(forging.address() as any).port}`); }
  finally { await new Promise<void>(resolve => forging.close(() => resolve())); }
}

test('two machines recover an expired lease against the real HTTP server and Postgres', async () => {
  const result = await exercise(url, identities(), shortFences);
  assert.deepEqual(result, requiredCases.map((id: string) => ({ id, result: 'pass' })));
});

test('the contract requires the shipped lease and launch-authority safety defaults', async () => {
  // Bind the certified minimums to the defaults this repository actually ships, so lowering a
  // fence in src/engine.ts fails here instead of quietly certifying the shortened deployment.
  assert.deepEqual(requiredFences, { leaseMs: new Engine(store).leaseSeconds * 1000, launchAuthorityMs: launchFenceMs });
  assert.deepEqual(requiredFences, { leaseMs: 120_000, launchAuthorityMs: 120_000 });
  // A candidate whose fences are seconds long cannot produce passing evidence for the real defaults.
  await assert.rejects(exercise(url, identities()), /shorter than the required 120000 ms safety default/);
});

test('a candidate that lets every racing claim win cannot produce passing evidence', async () => {
  await withoutRefusal('/claim', async weakened =>
    assert.rejects(exercise(weakened, identities(), shortFences), /Expected values to be strictly equal/));
});

test('a candidate that recovers containment before its launch fence expires cannot pass', async () => {
  await withoutRefusal('/rework', async weakened =>
    assert.rejects(exercise(weakened, identities(), shortFences), /Unexpected status for/));
});

test('a candidate that lets a superseded owner reset review state cannot pass', async () => {
  await withoutRefusal('/rereview', async weakened =>
    assert.rejects(exercise(weakened, identities(), shortFences), /Unexpected status for/));
});

test('the recovery contract refuses to run without two distinct machine identities', async () => {
  await assert.rejects(exercise(url, [{ ...operator, token: 'r'.repeat(32) }, machines[0]], shortFences));
});

test('the trusted registry selects fixed inventories and rejects unknown proofs', () => {
  assert.equal(contract('integration:herdr-recovery').requiredCases.length, 5);
  assert.deepEqual(contract('integration:claim-safety').requiredCases, contracts['integration:claim-safety'].requiredCases);
  // The refusal states the bootstrap ordering rule: a contract reaches protected main first.
  assert.throws(() => contract('integration:invented'), /Unknown trusted acceptance proof integration:invented\. This protected checkout registers integration:claim-safety, integration:herdr-recovery; merge a contract to main before requiring its proof\./);
  assert.throws(() => contract('toString'), /Unknown trusted acceptance proof/);
  assert.equal(launchFenceMs, 120_000);
});
