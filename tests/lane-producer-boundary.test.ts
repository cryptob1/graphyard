import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { delegationLimitDrift, validateDelegationPrincipals, defaultDelegationLimits } from '../src/delegation.js';
import type { Principal } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1879 AC-4/AC-5: a producer whose only grant is external-runs:import is held to that lane's
// routes before any effect, reads only its own imports and its own principal, and holds no reviewer
// slot; every other role, and a producer holding proof grants, keeps the access it had.

const REPOSITORY = 'owner/project';
const GRANT = 'external-runs:import';
const lane: Principal = { id: 'huck-engineer', role: 'producer', sessionKind: 'ai', grants: [GRANT] };
const otherLane: Principal = { id: 'huck-engineer-2', role: 'producer', sessionKind: 'ai', grants: [GRANT] };
const ungranted: Principal = { id: 'unit-collector', role: 'producer', proofs: ['unit:*'] };
const proofProducer: Principal = { id: 'proof-producer', role: 'producer', proofs: ['unit:*'], grants: [GRANT] };
const admin: Principal = { id: 'operator', role: 'admin' };
const coordinator: Principal = { id: 'coordinator', role: 'coordinator' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const reader: Principal = { id: 'auditor', role: 'reader' };
const principals = [lane, otherLane, ungranted, proofProducer, admin, coordinator, worker, reader];
const tokens = new Map(principals.map(p => [p.id, `${p.id}-${'t'.repeat(40)}`]));

const sha = 'e'.repeat(40), tagObject = '7'.repeat(40);
const candidate = { id: '20261017T090000Z', sha, cutAt: '2026-10-17T09:00:00.000Z', trigger: 'manual', since: null, items: [] };
const github = {
  config: { repository: REPOSITORY },
  async request(path: string) {
    if (path.startsWith('/git/matching-refs/tags/rc/')) return /page=1(?:&|$)/.test(path) ? [{ ref: `refs/tags/rc/${candidate.id}`, object: { sha: tagObject, type: 'tag' } }] : [];
    if (path === `/git/tags/${tagObject}`) return { object: { sha, type: 'commit' }, message: JSON.stringify(candidate) };
    throw new Error(`unexpected GitHub read ${path}`);
  },
};
let database: EmbeddedPostgres, store: Store, http: ReturnType<typeof server>, url: string, scratch: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1881;
  scratch = await temporaryDirectory('lane-producer');
  database = new EmbeddedPostgres({ databaseDir: join(scratch, 'pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('lane_producer_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/lane_producer_test`); await store.init();
  const engine = new Engine(store, [15368], 120, REPOSITORY);
  http = server(engine, principals.map(entry => ({ ...entry, token: tokens.get(entry.id)! })), github as any);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); if (scratch) await rm(scratch, { recursive: true, force: true }); });

async function call(method: string, path: string, actor: Principal, data?: unknown) {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${tokens.get(actor.id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: method === 'GET' ? undefined : JSON.stringify(data ?? {}) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}
const run = (runId: string) => ({ format: 'graphyard-external-run-v1', producer: 'huck', sha, runId, cases: [{ id: 'login', verdict: 'passed', required: true }] });

/** Every row of every table, so a refusal is shown to have written nothing anywhere. */
async function rows() {
  const tables = (await store.pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`)).rows.map(row => row.table_name as string);
  const counts: Record<string, number> = {};
  for (const table of tables) counts[table] = Number((await store.pool.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n);
  return counts;
}

// The routes the lane is refused, each named by the criterion: mutations, the responder, notes, session registration, notifications, and ledger, event and audit reads.
const refusedRoutes: [string, string, unknown?][] = [
  ['POST', 'delivery/observe-sha', { sha, environment: 'production' }],
  ['POST', 'deployments', { provider: 'railway', sha }],
  ['POST', 'work/GY-1/evidence', { proof: 'unit:anything', passed: true }],
  ['POST', 'work/GY-1/closed-question', { question: 'q' }],
  ['POST', 'work/GY-1/note', { note: 'n' }],
  ['POST', 'agent-registry/observe', { sessions: [] }],
  ['POST', `agent-registry/sessions/${randomUUID()}/end`, {}],
  ['POST', 'delivery/notify', {}],
  ['POST', 'work', { title: 't' }],
  ['POST', `validation/import/${sha}/seal`, { candidate: candidate.id }],
  ['GET', 'events'],
  ['GET', 'events/stats'],
  ['GET', 'work/GY-1'],
  ['GET', 'work/GY-1/decisions'],
  ['GET', 'validation'],
  ['GET', 'proof-grants'],
];
const laneRefusal = /outside the external-runs:import lane of producer/;

test('unit:import-with-grant-allowed — a lane-only producer imports a run through POST /api/validation/import, reads back only the runs it imported itself, and reads its own principal and grant', async () => {
  const imported = await call('POST', 'validation/import', lane, run('lane-run-1'));
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.imported.importedBy, lane.id);
  const own = await call('GET', `validation/import/${sha}`, lane);
  assert.equal(own.status, 200);
  assert.deepEqual(own.body.runs.map((record: { run: { runId: string } }) => record.run.runId), ['lane-run-1']);
  // Another lane producer reads none of it: its own imports at this head are none.
  const other = await call('GET', `validation/import/${sha}`, otherLane);
  assert.equal(other.status, 200);
  assert.deepEqual(other.body.runs, [], 'another importer\'s runs are not visible to a lane-only producer');
  assert.equal(other.body.candidate, null);
  const self = await call('GET', 'principals', lane);
  assert.equal(self.status, 200);
  assert.deepEqual(self.body.principals, [{ id: lane.id, role: 'producer', sessionKind: 'ai', grants: [GRANT], leases: [] }], 'only its own principal and grant');
  // The admin still reads every importer's runs and the whole roster.
  assert.equal((await call('GET', `validation/import/${sha}`, admin)).body.runs.length, 1);
  assert.equal((await call('GET', 'principals', admin)).body.principals.length, principals.length);
});

test('unit:no-grant-import-denied — a producer without external-runs:import is refused the import 403, naming the grant, and nothing is recorded', async () => {
  const before = await rows();
  const refused = await call('POST', 'validation/import', ungranted, run('ungranted-run'));
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /requires the external-runs:import grant; producer unit-collector holds no grant/);
  assert.deepEqual(await rows(), before, 'a refused import writes nothing');
});

test('unit:lane-producer-non-import-mutations-refused-before-effects — every other route answers the lane-only producer 403 naming the lane, and no event or row is written', async () => {
  for (const [method, path, data] of refusedRoutes) {
    const before = await rows();
    const refused = await call(method, path, lane, data);
    assert.equal(refused.status, 403, `${method} /api/${path} is refused: ${JSON.stringify(refused.body)}`);
    assert.match(refused.body.error, laneRefusal, `${method} /api/${path} names the lane`);
    assert.deepEqual(await rows(), before, `${method} /api/${path} writes no event or row`);
  }
});

test('unit:other-principal-roles-retain-intended-behaviour — a producer holding proof grants, and the admin, coordinator, worker and reader roles, are never answered with the lane refusal, and reach the routes they reached before', async () => {
  for (const actor of [proofProducer, ungranted, admin, coordinator, worker, reader])
    for (const [method, path, data] of refusedRoutes) {
      const answer = await call(method, path, actor, data);
      assert.doesNotMatch(String(answer.body?.error ?? ''), laneRefusal, `${actor.id} (${actor.role}) at ${method} /api/${path}`);
    }
  for (const actor of [admin, coordinator, worker, reader]) assert.equal((await call('GET', 'events', actor)).status, 200, `${actor.role} still reads the event ledger`);
  assert.equal((await call('GET', 'validation', proofProducer)).status, 200, 'a proof producer still reads the validation requests');
  // A proof producer still reaches the deployment observation's own authority check, past any lane boundary.
  assert.doesNotMatch(String((await call('POST', 'delivery/observe-sha', proofProducer, {})).body?.error ?? ''), /lane|producer credential is required/);
  // The grant beside proof authority is no lane: that producer still imports.
  const imported = await call('POST', 'validation/import', proofProducer, run('proof-producer-run'));
  assert.notEqual(imported.status, 403, JSON.stringify(imported.body));
});

test('unit:lane-producer-not-a-reviewer-slot — a roster at GRAPHYARD_MAX_REVIEWERS proof producers plus a lane-only producer raises no drift and starts; one more proof producer still raises drift and is refused as added', () => {
  const env = { GRAPHYARD_MAX_REVIEWERS: '2' };
  const second: Principal = { id: 'proof-producer-2', role: 'producer', proofs: ['e2e:*'] };
  const atLimit = [admin, proofProducer, second, lane];
  assert.deepEqual(delegationLimitDrift(atLimit, env), [], 'the lane-only producer holds no reviewer slot');
  assert.deepEqual(validateDelegationPrincipals(atLimit.map(p => ({ ...p })), { ...defaultDelegationLimits, maxReviewers: 2 }).attention, []);
  const third: Principal = { id: 'proof-producer-3', role: 'producer', proofs: ['manual:*'] };
  const over = [...atLimit, third];
  assert.deepEqual(delegationLimitDrift(over, env).map(entry => [entry.variable, entry.required]), [['GRAPHYARD_MAX_REVIEWERS', '3']], 'a third proof producer is over the limit');
  assert.throws(() => validateDelegationPrincipals(over, { ...defaultDelegationLimits, maxReviewers: 2 }, [admin.id, proofProducer.id, second.id, lane.id]), /Independent review\/proof agent limit exceeded: 3\/2; set GRAPHYARD_MAX_REVIEWERS=3 on the deployment before adding proof-producer-3/);
});
