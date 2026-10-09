import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Principal } from '../src/model.js';
import type { Observation, Work } from '../src/model/work.js';
import { heldRework, requestDecision } from '../src/server/decisions.js';
import type { Services } from '../src/server/routes.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1579, observed on GY-1522 at 2026-10-08T11:38:06Z: the master requested rework bd40dc45 by hand,
// input { previousWorkerStopped: true } with no binding, on an item that already held applied rework
// 8da1e201 (reworkRequested true since 10:14:41Z; the real hold was an unfinished dependency). An
// approver session was launched only to refuse it: "The request misreads the stall".

const clock = Date.parse('2030-01-01T12:00:00Z');
const shaA = 'a'.repeat(40), shaB = 'c'.repeat(40), base = 'b'.repeat(40);

function item(sha: string, reworkRequested: boolean): Work {
  const candidate = { sha, baseSha: base, pr: 42, branch: 'graphyard/gy-1522-1', author: 'worker' };
  return {
    id: '00000000-0000-4000-8000-000000001522', key: 'GY-1522', title: 'Held rework', description: '', type: 'bug', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true },
    plannedFiles: ['src/loop.ts'], stage: 'review', revision: 5, policyRevision: 1, createdAt: new Date(clock - 3_600_000).toISOString(), updatedAt: new Date(clock).toISOString(),
    stageEnteredAt: new Date(clock - 600_000).toISOString(), ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: 42 },
    candidate, reworkRequested, scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], gates: [],
  } as unknown as Work;
}

/** The decide route over an in-memory ledger, as tests/decision-refusal-scope.test.ts drives it. */
function ledger(work: { current: Work }) {
  const events: { actor: string; kind: string; payload: any; created_at: string }[] = [];
  const receipts = new Map<string, { fingerprint: string; result: unknown }>();
  const db = {
    query: async (sql: string, params: any[] = []) => {
      if (sql.startsWith('SELECT * FROM receipts')) { const row = receipts.get(`${params[0]}:${params[1]}`); return { rows: row ? [row] : [] }; }
      if (sql.startsWith('INSERT INTO receipts')) { receipts.set(`${params[0]}:${params[1]}`, { fingerprint: params[2], result: JSON.parse(params[3]) }); return { rows: [] }; }
      if (sql.startsWith('SELECT document FROM work_items')) return { rows: [{ document: work.current }] };
      if (sql.startsWith('SELECT actor, kind, payload, created_at FROM events')) return { rows: events.filter(event => event.kind.startsWith('decision.')) };
      if (sql.startsWith('SELECT count(*)::int AS count FROM events')) return { rows: [{ count: 0 }] };
      if (sql.startsWith('INSERT INTO events')) { events.push({ actor: params[1], kind: params[2], payload: JSON.parse(params[3]), created_at: new Date(clock + events.length).toISOString() }); return { rows: [] }; }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const services = { repository: 'owner/project', principals: [], engine: { store: { transaction: (body: (db: unknown, now: Date) => unknown) => body(db, new Date(clock)) } } } as unknown as Services;
  return { events, services };
}
const operator: Principal = { id: 'graphyard-master-operator', role: 'admin' } as Principal;

test('unit:decide-route-records-rework-situation — a decide-route rework records the candidate head and base beside its input, and the applied rework it would re-authorize when one stands', async () => {
  const work = { current: item(shaA, false) };
  const { events, services } = ledger(work);
  const first = await requestDecision(services, operator, work.current.id, { action: 'rework', input: { previousWorkerStopped: true }, reason: 'The reviewer requested changes on head A' }, 'key-1');
  assert.deepEqual(events.at(-1)!.payload.situation, { sha: shaA, baseSha: base }, 'the situation of a request with no rework standing');
  assert.deepEqual(first.situation, { sha: shaA, baseSha: base });
  // The approver approves it and it applies: the item holds the rework.
  events.push({ actor: 'graphyard-approver', kind: 'decision.approved', payload: { id: first.id, reason: 'Stands' }, created_at: new Date(clock + 100).toISOString() });
  events.push({ actor: 'graphyard-approver', kind: 'decision.applied', payload: { id: first.id, outcome: 'Rework authorized' }, created_at: new Date(clock + 101).toISOString() });
  // A base refresh carries the head to a new candidate while the rework still holds: new grounds, so a request is recorded, naming the rework it re-authorizes.
  work.current = item(shaB, true);
  assert.equal(heldRework(work.current, [{ ...first, state: 'applied' }])?.id, first.id);
  const second = await requestDecision(services, operator, work.current.id, { action: 'rework', input: { previousWorkerStopped: true, binding: `${shaB}:conflict` }, reason: 'The refreshed head conflicts with its base' }, 'key-2');
  const recorded = events.at(-1)!;
  assert.equal(recorded.kind, 'decision.requested');
  assert.equal(recorded.payload.id, second.id);
  assert.deepEqual(recorded.payload.input, { previousWorkerStopped: true, binding: `${shaB}:conflict` });
  assert.deepEqual(recorded.payload.situation, { sha: shaB, baseSha: base, reauthorizes: first.id }, 'the applied rework it would re-authorize is recorded beside the situation');
  // Once a worker submitted, the rework no longer holds, and nothing is re-authorized.
  assert.equal(heldRework(item(shaB, false), [{ ...first, state: 'applied' }]), null);
});

let teardown: (() => Promise<void>) | null = null;
after(async () => { await teardown?.(); });

test('integration:held-rework-request-refused-mechanically — a rework request on an item that already holds an applied rework for its head is refused naming that decision, and nothing is put to an approver', { timeout: 120_000 }, async () => {
  const repository = 'owner/held-rework';
  const admin: Principal = { id: 'held-operator', role: 'admin', sessionKind: 'human' };
  const implementer: Principal = { id: 'held-implementer', role: 'worker', sessionKind: 'ai' };
  const credentials = [admin, implementer].map(principal => ({ ...principal, token: `held-${principal.id}-${'x'.repeat(32)}` }));
  const master = { id: 'held-master', token: `held-master-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'decision:rework'] };
  const approver = { id: 'held-approver', token: `held-approver-${'a'.repeat(32)}`, capabilities: ['decision:approve'] };
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1579;
  const database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('held-rework'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('held_rework_test');
  const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/held_rework_test`); await store.init();
  const engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  const http = server(engine, credentials);
  teardown = async () => { http.close(); await store.close(); await database.stop(); };
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const send = async (token: string, path: string, body: unknown) => {
    const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const decisions = async (key: string) => (await (await fetch(`${url}/api/work/${key}/decisions`, { headers: { Authorization: `Bearer ${master.token}` } })).json() as { decisions: any[] }).decisions;
  for (const agent of [master, approver]) {
    const provisioned = await send(credentials[0].token, 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Onboarding provisions agent identities' });
    assert.equal(provisioned.status, 200, JSON.stringify(provisioned.body));
  }

  // A submitted high-lane item, observed with a change request on its head.
  const paths = ['src/server/routes/held-rework.ts'];
  const created = await send(master.token, 'work', { title: 'Held rework', plannedFiles: paths, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], reason: 'Held rework fixture' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  let work = await engine.execute(admin, 'ready', created.body.id, {}, randomUUID());
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(implementer, 'workspace', work.id, { epoch: work.epoch, host: 'held-host', path: `/tmp/held/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, randomUUID());
  work = await engine.execute(implementer, 'submit', work.id, { epoch: work.epoch, pr: 1579 }, randomUUID());
  const candidate = { sha: shaA, baseSha: base, pr: 1579, branch: work.workspaces.at(-1)!.branch, author: 'worker' };
  work = await engine.observe(work.id, work.revision, { candidate, checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'graphyard-reviewer[bot]', sha: shaA, state: 'CHANGES_REQUESTED', submittedAt: new Date().toISOString() }],
    merged: false, mergeSha: null, mergeable: true, protected: true, files: paths, at: new Date().toISOString(),
    scopeFiles: paths.map(path => ({ path, status: 'modified' as const, sha: 'e'.repeat(40), additions: 1, deletions: 1, binary: false })) } as unknown as Observation);
  assert.equal(work.lane, 'high');

  // The rework is requested, approved by the independent approver, and applied: the item holds it.
  const requested = await send(master.token, `work/${work.key}/decide`, { action: 'rework', input: { previousWorkerStopped: true }, reason: 'graphyard-reviewer[bot] requested changes on the head' });
  assert.equal(requested.body.state, 'requested', JSON.stringify(requested.body));
  const approved = await send(approver.token, `work/${work.key}/approve`, { decision: requested.body.id, reason: 'The verdict stands on this head' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const holding = (await store.list()).find(entry => entry.id === work.id)! as Work;
  assert.equal(holding.reworkRequested, true, 'the applied rework holds the item');

  // GY-1522's hand request: same head, no binding. Refused at creation, naming the applied decision.
  const again = await send(master.token, `work/${work.key}/decide`, { action: 'rework', input: { previousWorkerStopped: true }, reason: 'The previous worker stopped; send it back to a worker' });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.ok(String(again.body.error).includes(`decision ${requested.body.id} was applied for head ${shaA.slice(0, 12)}`), again.body.error);
  assert.match(again.body.error, /a second rework authorizes nothing/);
  assert.deepEqual(again.body.heldRework, { decision: requested.body.id }, 'the applied decision travels as a field beside the message');
  // A request on other grounds for the same head is held all the same: the item already waits for a worker.
  const grounded = await send(master.token, `work/${work.key}/decide`, { action: 'rework', input: { previousWorkerStopped: true, binding: `${shaA}:verdict:graphyard-reviewer[bot]` }, reason: 'The verdict stands' });
  assert.equal(grounded.status, 409, JSON.stringify(grounded.body));
  assert.deepEqual(grounded.body.heldRework, { decision: requested.body.id });

  // Nothing was recorded, so no request stands for the loop to launch an approver on.
  const ledger = await decisions(work.key);
  assert.deepEqual(ledger.map(entry => [entry.id, entry.state]), [[requested.body.id, 'applied']]);
  assert.equal(ledger.filter(entry => entry.state === 'requested').length, 0, 'no decision awaits an approver');
});
