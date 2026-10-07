import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { decisionInput } from '../src/master.js';
import { maxDecisionRequests, uncountedScopeFailure } from '../src/daemon/decisions.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1484: on GY-1480 the independent approver approved two routed scope widenings, and both settled
// failed — "The scope request this widening answers is no longer open" — because the worker's wait
// window ran out (it withdrew) or its attempt ended before the approval applied. An approved widening
// now applies through its decision whatever became of the request it answered, and is recorded on
// the item; a failure of that kind no longer counts toward the loop's stop-requesting threshold.
// One case per proof: integration:approved-scope-widening-applies, unit:failed-widening-not-stale-counted.
const repository = 'owner/approved-scope';
const operator: Principal = { id: 'scope-operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'scope-implementer', role: 'worker', sessionKind: 'ai' };
const coordinator: Principal = { id: 'scope-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, implementer, coordinator].map(principal => ({ ...principal, token: `approved-scope-${principal.id}-${'x'.repeat(32)}` }));
const master = { id: 'scope-master', token: `scope-master-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements'] };
const approver = { id: 'graphyard-approver-graphyard', token: `scope-approver-${'a'.repeat(32)}`, capabilities: ['decision:approve'] };
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const call = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const result = await call(credential, method, path, body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const decisions = async (work: Work) => (await ok(master.token, 'GET', `work/${work.key}/decisions`)).decisions as any[];
const layout = 'src/widget/Layout.tsx', daemon = 'src/daemon/cycle-widget.ts';

async function claimed(title: string) {
  let work = await ok(master.token, 'POST', 'work', { title, plannedFiles: [layout], criteria: [{ id: 'AC-1', text: 'The widget layout renders', proofs: ['unit:layout'] }], reason: 'Approved widening fixture' }) as Work;
  work = await ok(master.token, 'POST', `work/${work.id}/ready`, { expectedRevision: work.revision, reason: 'Ready for the attempt' }) as Work;
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(implementer, 'workspace', work.id, { epoch: work.epoch, host: 'scope-host', path: `/tmp/approved-scope/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, randomUUID());
  return reload(work.id);
}
/** The worker asks for a file no rule implies, the rule refuses it, and the master routes it to the approver as the loop does (scopeRoutineDecision). */
async function routed(title: string, sha?: string | null) {
  const work = await claimed(title);
  await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: [daemon], reason: 'AC-1 needs the research worktree, which only the cycle module creates' });
  const asked = await ok(token(coordinator), 'POST', `work/${work.id}/autoscope`, { epoch: work.epoch }) as Work;
  assert.equal(asked.scopeRequest?.decision?.decidedBy, 'graphyard', 'the widening rule defers it to the approver');
  const request = asked.scopeRequest!;
  const answers = { epoch: request.epoch, at: request.at, ...(sha === undefined ? {} : { sha }) };
  const decision = await ok(master.token, 'POST', `work/${work.id}/decide`, { action: 'requirements', input: decisionInput('requirements', asked, { plannedFiles: [layout, daemon], answers }), reason: `${work.key}: the worker asks for ${daemon}` });
  assert.equal(decision.state, 'requested');
  return { work: asked, request, decision };
}

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1484;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('approved-scope-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('approved_scope_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/approved_scope_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  for (const agent of [master, approver])
    await ok(token(operator), 'POST', 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Approved widening fixture' });
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('integration:approved-scope-widening-applies — an approved widening applies though its scope request closed first, and is recorded on the item', async () => {
  // GY-1480's first failure: the wait window ran out and the request was withdrawn before the approval landed.
  const withdrawn = await routed('Approval after withdrawal');
  await ok(token(implementer), 'POST', `work/${withdrawn.work.id}/scope`, { epoch: withdrawn.work.epoch, paths: [], reason: 'Withdrawn by the worker' });
  assert.equal((await reload(withdrawn.work.id)).scopeRequest, null, 'the request is closed');
  await ok(approver.token, 'POST', `work/${withdrawn.work.id}/approve`, { decision: withdrawn.decision.id, reason: 'Additive and required by AC-1' });
  let item = await reload(withdrawn.work.id);
  const [applied] = await decisions(item);
  assert.equal(applied.state, 'applied', JSON.stringify(applied));
  assert.deepEqual(item.plannedFiles, [layout, daemon], 'the approved widening applied');
  assert.ok(item.lease && item.lease.epoch === withdrawn.work.epoch, 'the attempt keeps its lease');
  assert.deepEqual({ ...item.scopeDecision, at: undefined, waitedMs: undefined }, { state: 'approved', reason: 'Additive and required by AC-1', at: undefined, waitedMs: undefined, decidedBy: approver.id,
    paths: [daemon], requestedBy: master.id, requestedAt: withdrawn.request.at, epoch: withdrawn.request.epoch }, 'the applied widening is recorded as the closed request\'s decision');
  const [revision] = (await store.pool.query(`SELECT payload FROM events WHERE work_id=$1 AND kind='requirements' ORDER BY seq DESC LIMIT 1`, [item.id])).rows;
  assert.deepEqual(revision.payload.details.answeredClosedRequest, { epoch: withdrawn.request.epoch, at: withdrawn.request.at, approver: approver.id }, 'the ledger records the late answer');

  // GY-1480's second failure: the asking attempt ended 28 seconds before the approval.
  const ended = await routed('Approval after the attempt ended');
  await engine.execute(implementer, 'release', ended.work.id, { epoch: ended.work.epoch }, randomUUID());
  item = await reload(ended.work.id);
  assert.equal(item.lease, null);
  assert.equal(item.scopeRequest, null, 'the attempt\'s request closed with it');
  await ok(approver.token, 'POST', `work/${ended.work.id}/approve`, { decision: ended.decision.id, reason: 'Still additive and required' });
  item = await reload(ended.work.id);
  assert.equal((await decisions(item))[0].state, 'applied');
  assert.deepEqual(item.plannedFiles, [layout, daemon]);
  assert.equal(item.scopeDecision?.state, 'approved');
  assert.equal(item.scopeDecision?.requestedBy, implementer.id, 'the carried ask names its worker');
  assert.equal(item.carriedScopeRequest, null, 'the carried ask is answered');

  // A widening grounded on findings read for a head still lapses with its request, and nothing widens outside a decision.
  const grounded = await routed('Finding-grounded widening', null);
  await ok(token(implementer), 'POST', `work/${grounded.work.id}/scope`, { epoch: grounded.work.epoch, paths: [], reason: 'Withdrawn by the worker' });
  await ok(approver.token, 'POST', `work/${grounded.work.id}/approve`, { decision: grounded.decision.id, reason: 'Approved' });
  const [failed] = await decisions(grounded.work);
  assert.equal(failed.state, 'failed');
  assert.match(failed.outcome, /scope request this widening answers is no longer open/);
  assert.deepEqual((await reload(grounded.work.id)).plannedFiles, [layout]);
  const hand = await routed('Hand widening of a closed ask');
  await ok(token(implementer), 'POST', `work/${hand.work.id}/scope`, { epoch: hand.work.epoch, paths: [], reason: 'Withdrawn by the worker' });
  const current = await reload(hand.work.id);
  const direct = await call(master.token, 'POST', `work/${hand.work.id}/requirements`, { ...decisionInput('requirements', current, { plannedFiles: [layout, daemon], answers: { epoch: hand.request.epoch, at: hand.request.at } }), reason: 'not a decision' });
  assert.equal(direct.status, 409, JSON.stringify(direct.body));
  assert.match(direct.body.error, /no longer open/);
});

test('unit:failed-widening-not-stale-counted — a widening that failed only because its request closed is not counted toward the stop threshold while its paths stay unplanned', () => {
  const watch = { action: 'requirements' as const, scope: { epoch: 1, at: '2026-10-07T21:59:33.000Z', requestedBy: 'worker', paths: [daemon] } };
  const closed = { state: 'failed', outcome: 'The scope request this widening answers is no longer open' };
  const lapsed = { state: 'failed', outcome: 'Epoch 1, which asked for this scope, no longer holds the lease' };
  const unplanned = { plannedFiles: [layout] }, planned = { plannedFiles: [layout, 'src/daemon/'] };
  assert.equal(uncountedScopeFailure(watch, closed, unplanned), true, 'the closed request is not counted while the blocker stands');
  assert.equal(uncountedScopeFailure(watch, lapsed, unplanned), true, 'nor is the ended attempt');
  // The loop keeps asking: three such races in a row stay under maxDecisionRequests.
  let requests = 1;
  for (let race = 0; race < maxDecisionRequests + 2; race++) {
    if (uncountedScopeFailure(watch, closed, unplanned)) requests -= 1;
    assert.ok(requests < maxDecisionRequests, `race ${race + 1} does not reach the stop threshold`);
    requests += 1;
  }
  assert.equal(uncountedScopeFailure(watch, closed, planned), false, 'once plannedFiles cover the paths, nothing is left to re-escalate');
  assert.equal(uncountedScopeFailure(watch, { state: 'failed', outcome: 'Policy revision changed (now 3); reload and request again' }, unplanned), false, 'any other failure counts');
  assert.equal(uncountedScopeFailure(watch, { state: 'refused', outcome: 'The scope request this widening answers is no longer open' }, unplanned), false, 'a refusal is a judgement');
  assert.equal(uncountedScopeFailure({ action: 'rework', scope: watch.scope } as never, closed, unplanned), false, 'only a requirements decision');
  assert.equal(uncountedScopeFailure({ action: 'requirements', scope: null }, closed, unplanned), false, 'only one that answers a scope request');
});
