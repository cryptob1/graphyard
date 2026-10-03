import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { save, Store } from '../src/store.js';
import { refusedReworkLiftsMergeRefusal } from '../src/server/decision-refusal.js';
import { standingMergeRefusal } from '../src/merge-queue.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// 2026-10-01: after the guarded merge refused a candidate (a `rework` merge refusal, GY-831), the
// loop asked for a rework decision and the independent approver refused it — nothing in the
// candidate needed changing — but nothing lifted the merge refusal, so the entry never re-entered
// the queue (GY-973 waited 14 hours; approval→merge p90 reached 59 hours).
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const rework = { action: 'rework', input: { binding: `${head}:merge-refused` }, situation: { sha: head, baseSha: base } };
const item = (refusal: Partial<NonNullable<Work['mergeRefusal']>> | null) => ({
  key: 'GY-9', policyRevision: 3, candidate: { sha: head, baseSha: base },
  mergeRefusal: refusal && { sha: head, baseSha: base, policyRevision: 3, reason: 'awaits authorization', since: '2026-10-01T07:32:36Z', at: '2026-10-01T07:32:36Z', by: 'graphyard', action: 'rework', ...refusal },
}) as unknown as Work;

test('unit:refused-rework-lifts-merge-refusal — a refused rework decision lifts the rework merge refusal of exactly that candidate, so the entry may re-enter the queue', () => {
  const stuck = item({});
  assert.ok(standingMergeRefusal(stuck), 'the rework merge refusal stands before the decision');
  assert.equal(refusedReworkLiftsMergeRefusal(stuck, rework), true);
  stuck.mergeRefusal = null;
  assert.equal(standingMergeRefusal(stuck), null, 'with the refusal lifted the entry may re-enter');
  // Only a refused rework lifts it, only a rework refusal is lifted, and only for the candidate it named.
  assert.equal(refusedReworkLiftsMergeRefusal(item({}), { ...rework, action: 'resolve' }), false, 'another action lifts nothing');
  assert.equal(refusedReworkLiftsMergeRefusal(item({}), { action: 'rework', input: { binding: `${head}:ci:test` } }), false, 'a rework on another ground judges nothing of the merge refusal');
  assert.equal(refusedReworkLiftsMergeRefusal(item({}), { action: 'rework' }), false, 'a rework naming no ground lifts nothing');
  assert.equal(refusedReworkLiftsMergeRefusal(item({ action: 'rereview' }), rework), false, 'a rereview refusal waits for a fresh approval instead');
  assert.equal(refusedReworkLiftsMergeRefusal(item({ sha: 'c'.repeat(40) }), rework), false, 'a refusal of an older candidate is not this one');
  assert.equal(refusedReworkLiftsMergeRefusal(item({ baseSha: 'd'.repeat(40) }), rework), false, 'a refusal against another base is not this one');
  assert.equal(refusedReworkLiftsMergeRefusal(item(null), rework), false, 'no refusal, nothing to lift');
  // GY-1073: the approver judged the request's own situation and policy, not whatever hold stands now.
  assert.equal(refusedReworkLiftsMergeRefusal(item({}), { ...rework, situation: { sha: head, baseSha: 'e'.repeat(40) } }), false, 'a rework requested on another base judged another refusal of the same head');
  assert.equal(refusedReworkLiftsMergeRefusal(item({}), { ...rework, situation: null }), false, 'a rework recorded without its situation names no base and lifts nothing');
  assert.equal(refusedReworkLiftsMergeRefusal(item({ policyRevision: 2 }), rework), false, 'a refusal under an older policy revision holds nothing, so nothing is lifted');
});

// GY-1073: the lift runs inside `refuseDecision`'s transaction — the refusal cleared on the stored
// item and `merge.refusal.lifted` written together with `decision.declined` — and the end-to-end
// path honours the same situation and policy-revision matching as the predicate.
const repository = 'owner/refusal-lift';
const operator = { id: 'human-operator', role: 'admin' as const, sessionKind: 'human' as const, token: `lift-operator-${'x'.repeat(32)}` };
const master = { id: 'master-operator', token: `master-operator-${'m'.repeat(32)}`, capabilities: ['intent:create', 'decision:rework'] };
const approver = { id: 'approver-agent', token: `approver-agent-${'a'.repeat(32)}`, capabilities: ['decision:approve'] };
let database: EmbeddedPostgres, store: Store, http: ReturnType<typeof server>, url: string;
const call = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1073;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('refusal-lift'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('refusal_lift');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/refusal_lift`); await store.init();
  const engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, [operator as Principal & { token: string }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  for (const agent of [master, approver]) {
    const provisioned = await call(operator.token, 'POST', 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Onboarding provisions agent identities' });
    assert.equal(provisioned.status, 200, JSON.stringify(provisioned.body));
  }
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

/** An item whose candidate `head` on `base` carries a rework merge refusal, and a rework requested for `situation`. */
async function held(title: string, refusal: { baseSha?: string; policyRevision?: number }, situation: { sha: string; baseSha: string } | null) {
  const created = await call(master.token, 'POST', 'work', { title, plannedFiles: [`src/${title}.ts`], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], reason: 'Operator goal: a refused rework lifts its merge refusal' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const decision = randomUUID();
  await store.transaction(async (db, now) => {
    const work = (await db.query('SELECT document FROM work_items WHERE id=$1 FOR UPDATE', [created.body.id])).rows[0].document as Work;
    const refusedBase = refusal.baseSha ?? base;
    work.candidate = { sha: head, baseSha: refusedBase } as Work['candidate'];
    work.mergeRefusal = { sha: head, baseSha: refusedBase, policyRevision: refusal.policyRevision ?? work.policyRevision, reason: 'awaits authorization', since: now.toISOString(), at: now.toISOString(), by: 'graphyard', action: 'rework' } as Work['mergeRefusal'];
    await save(db, work, 'graphyard', 'test.merge-refused', now, {});
    await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, master.id, 'decision.requested', JSON.stringify({ id: decision, action: 'rework', input: { previousWorkerStopped: true, binding: `${head}:merge-refused` }, reason: 'The guarded merge refused the candidate', ...(situation ? { situation } : {}) })]);
  });
  const refused = await call(approver.token, 'POST', `work/${created.body.key}/approve`, { action: 'refuse', decision, reason: 'The candidate needs no change' });
  assert.equal(refused.status, 200, JSON.stringify(refused.body));
  assert.equal(refused.body.state, 'refused');
  const work = (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [created.body.id])).rows[0].document as Work;
  const events = (await store.pool.query("SELECT kind, payload, xmin::text AS transaction FROM events WHERE work_id=$1 AND kind IN ('decision.declined', 'merge.refusal.lifted') ORDER BY seq", [created.body.id])).rows;
  return { work, events, decision };
}

test('integration:refused-rework-lift-transactional — refusing the rework requested on the merge-refused ground clears the stored refusal and records merge.refusal.lifted in the same transaction as decision.declined; a request for another base or a refusal under an older policy lifts nothing', async () => {
  const lifted = await held('lifted', {}, { sha: head, baseSha: base });
  assert.equal(lifted.work.mergeRefusal, null, 'the stored item no longer carries the refusal');
  assert.equal(standingMergeRefusal(lifted.work), null);
  assert.deepEqual(lifted.events.map(row => row.kind), ['decision.declined', 'merge.refusal.lifted']);
  const [declined, lift] = lifted.events;
  // xmin is the id of the transaction that inserted the row: one id, one transaction.
  assert.equal(lift.transaction, declined.transaction, 'the lift is written in the refusal\'s transaction');
  const cleared = (await store.pool.query('SELECT xmin::text AS transaction FROM work_items WHERE id=$1', [lifted.work.id])).rows[0];
  assert.equal(cleared.transaction, declined.transaction, 'the cleared refusal is saved in that same transaction');
  assert.equal(lift.payload.details.decision, lifted.decision);
  assert.deepEqual({ sha: lift.payload.details.sha, baseSha: lift.payload.details.baseSha, approver: lift.payload.details.approver }, { sha: head, baseSha: base, approver: approver.id });

  // Requested for head H on base B1; the candidate since came back to H on B2 and was refused again.
  const otherBase = await held('other-base', { baseSha: 'f'.repeat(40) }, { sha: head, baseSha: base });
  assert.ok(otherBase.work.mergeRefusal, 'the newer refusal on another base still stands');
  assert.ok(standingMergeRefusal(otherBase.work));
  assert.deepEqual(otherBase.events.map(row => row.kind), ['decision.declined']);

  // A refusal from an older policy revision held nothing: no lift is recorded for it.
  const stale = await held('stale-policy', { policyRevision: 0 }, { sha: head, baseSha: base });
  assert.ok(stale.work.mergeRefusal);
  assert.deepEqual(stale.events.map(row => row.kind), ['decision.declined']);
});
