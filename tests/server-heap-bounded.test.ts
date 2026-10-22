import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { Principal } from '../src/model.js';

// GY-975: the production server's heap climbed to its 4 GB limit every ten to fifteen minutes. These
// tests drive the requests every client polls — status, item reads, action claims and the
// agent registry — and assert what the process retains after a full collection stays under a fixed
// bound. The GitHub answer cache that retained it then went with the GitHub client (GY-2010).

setFlagsFromString('--expose-gc');
const collect = runInNewContext('gc') as () => void;
/** Heap in use after full collections, so only what something still references counts. */
const retained = () => { collect(); collect(); return process.memoryUsage().heapUsed; };
const MB = 1024 * 1024;

const repository = 'owner/heap';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const implementer: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const roster = [operator, coordinator, implementer];
const credentials = roster.map(principal => ({ ...principal, token: `heap-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;

let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, scratch: string;
before(async () => {
  const port = Number(process.env.GRAPHYARD_HEAP_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 975);
  scratch = await temporaryDirectory('heap');
  database = new EmbeddedPostgres({ databaseDir: join(scratch, 'pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('heap_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/heap_test`); await store.init();
  engine = new Engine(store, 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials, null);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); await store?.close(); await database?.stop(); });

async function call(principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  assert.equal(response.status, 200, `${method} ${path}: ${text.slice(0, 300)}`);
  return text.length;
}

/** A released item, so the item read and the claim have something to return. */
async function released() {
  const work = await engine.execute(operator, 'create', null, { title: 'heap', description: 'Why heap matters', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }, { id: 'AC-2', text: 'Audited', proofs: ['manual:audit'] }], reason: 'Operator goal' }, randomUUID());
  return engine.execute(operator, 'ready', work.id, { reason: 'Priority one' }, randomUUID());
}

test('unit:server-heap-bounded-under-repeated-requests — repeated status, item, claim and registry requests retain a bounded heap', async () => {
  const work = await released();
  // One polling round: every read a client repeats.
  const round = async () => {
    await Promise.all([
      call(coordinator, 'GET', 'status'), call(operator, 'GET', 'status'),
      call(coordinator, 'GET', `work/${work.key}`),
      call(implementer, 'POST', 'assignments/claim', {}),
      call(coordinator, 'GET', 'agent-registry'),
    ]);
  };
  for (let n = 0; n < 20; n++) await round();
  const baseline = retained();
  const samples: number[] = [];
  for (let block = 0; block < 6; block++) {
    for (let n = 0; n < 50; n++) await round();
    samples.push(retained() - baseline);
  }
  const growth = samples.map(bytes => `${(bytes / MB).toFixed(1)} MB`).join(', ');
  const bound = 64 * MB;
  assert.ok(samples.at(-1)! < bound, `retained heap grew ${growth} over the baseline across 300 rounds; the bound is ${(bound / MB).toFixed(0)} MB`);
  // The heap plateaus: the last 150 rounds retain no more than slack.
  assert.ok(samples.at(-1)! - samples[2] < 32 * MB, `retained heap kept climbing: ${growth}`);
});
