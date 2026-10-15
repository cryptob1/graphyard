import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Principal, Work } from '../src/model.js';
import { decisionInput } from '../src/master/autonomy.js';
import { assertDispatchable } from '../src/master/dispatch.js';
import { parkedOnHuman, withdrawParkRefusal, type HumanDecisionKind } from '../src/model/human-request.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1815. A goals-and-priorities park whose asked state already held — the operator had done the
// step out of band — stayed on Needs you: only a human answers a park, and closing the item drops
// its work. `master decide GY-N withdraw-park REASON` is the agents' route: a two-party decision,
// citing the observed state, that closes the request as superseded-by-observation and returns the
// item to dispatch. It never answers for the operator: spending, accounts and credentials, and any
// request whose sealed value the operator has not supplied, are refused when it is requested.

const repository = 'owner/withdraw-park';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, worker].map(principal => ({ ...principal, token: `withdraw-park-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
const master = { id: 'graphyard-master-withdraw', token: `graphyard-master-withdraw-${'m'.repeat(32)}`, capabilities: ['decision:resolve', 'decision:rework'] };
const approver = { id: 'graphyard-approver-withdraw', token: `graphyard-approver-withdraw-${'a'.repeat(32)}`, capabilities: ['decision:approve'] };
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const freePort = () => new Promise<number>((resolve, reject) => {
  const probe = createServer(); probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); });
});
before(async () => {
  const port = await freePort();
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('withdraw-park'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('withdraw_park_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/withdraw_park_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  for (const agent of [master, approver])
    await call(token(operator), 'POST', 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Onboarding provisions the master agent pair' }, 200);
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });

async function call(credential: string, method: 'GET' | 'POST', path: string, body: unknown, status: number) {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${text}`);
  return JSON.parse(text) as any;
}
const reload = async (workId: string) => (await store.list()).find(item => item.id === workId)!;

/** A ready item whose worker parked it on a human-only decision of KIND, with the request's own choices when given. */
async function parked(title: string, kind: HumanDecisionKind, extra: Record<string, unknown> = {}): Promise<Work> {
  let work: Work = await engine.execute(operator, 'create', null, { title, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['unit:behaves'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  await call(token(worker), 'POST', `work/${work.key}/park`, { epoch: work.epoch, kind, needed: 'Which of the two dashboards ships first this quarter', reason: 'The ordering of the two dashboards is a priority call',
    ask: 'Choose which dashboard ships first.', recommendation: 'Go ahead as asked', why: 'The billing dashboard is already half built.', ...extra }, 200);
  work = await reload(work.id);
  assert.ok(parkedOnHuman(work), `${title} is parked on the human`);
  return work;
}
/** What `graphyard master decide GY-N withdraw-park REASON` posts: the action, the input the CLI binds to the open request, and the reason. */
const withdrawPark = (work: Work, reason: string) => ({ action: 'withdraw-park', input: decisionInput('withdraw-park', work, {}), reason });

test('unit:human-request-withdraw — an approved withdraw-park closes the open request as superseded-by-observation, recorded with requester, approver and reason, and the item returns to dispatch; it never answers spending, accounts, credentials or an unsupplied sealed value', async () => {
  // AC-1: a goals park whose asked state was observed to hold.
  let work = await parked('Dashboard ordering', 'goals-and-priorities');
  const request = work.humanRequest!;
  assert.throws(() => assertDispatchable(work, [work], new Date().toISOString()), /Dispatch waits on a human-only decision/, 'parked: dispatch waits on the human');
  const observed = 'Observed: the operator merged the billing dashboard first (PR #42) out of band, so the ordering asked for is already decided';
  const requested = await call(master.token, 'POST', `work/${work.key}/decide`, withdrawPark(work, observed), 200);
  assert.equal(requested.state, 'requested', 'requesting changes nothing: the request waits for the independent approver');
  assert.deepEqual(requested.input, { request: request.id }, 'the decision is bound to the one open request');
  assert.ok(parkedOnHuman(await reload(work.id)), 'still parked until approved');
  // The requester never approves its own decision.
  await call(master.token, 'POST', `work/${work.key}/approve`, { decision: requested.id, reason: 'self' }, 403);
  const applied = await call(approver.token, 'POST', `work/${work.key}/approve`, { decision: requested.id, reason: 'Confirmed PR #42 merged; the ordering is settled' }, 200);
  assert.equal(applied.state, 'applied', JSON.stringify(applied));
  assert.match(applied.outcome, /superseded by observation/);

  work = await reload(work.id);
  assert.equal(parkedOnHuman(work), false);
  assert.equal(work.humanRequest, null, 'the request is closed');
  assert.equal(work.blocker, null, 'the park\'s blocker is cleared');
  const closed = work.humanRequests!.at(-1)!;
  assert.equal(closed.id, request.id);
  assert.equal(closed.answer!.outcome, 'superseded-by-observation');
  assert.equal(closed.answer!.by, master.id, 'recorded with its requester');
  assert.equal(closed.answer!.approvedBy, approver.id, 'recorded with its approver');
  assert.equal(closed.answer!.decision, requested.id);
  assert.match(closed.answer!.text, /^superseded-by-observation: Observed: the operator merged the billing dashboard first/, 'recorded with its reason');
  const ledger = (await store.pool.query("SELECT actor, payload FROM events WHERE work_id=$1 AND kind='human.superseded' ORDER BY seq", [work.id])).rows;
  assert.ok(ledger.length >= 1, 'the item\'s history records the withdrawal');
  const entry = ledger.at(-1)!;
  assert.equal(entry.actor, master.id);
  assert.equal(entry.payload.details.approvedBy, approver.id);
  assert.equal(entry.payload.details.reason, observed);
  assert.equal(entry.payload.details.request.answer.outcome, 'superseded-by-observation');
  // Returned to the loop's dispatch: ready, unleased, unblocked and claimable.
  assert.equal(work.ready, true);
  assert.equal(work.lease, null);
  assert.doesNotThrow(() => assertDispatchable(work, [work], new Date().toISOString()), 'the loop may dispatch it again');
  const claimed = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  assert.equal(claimed.lease?.owner, worker.id, 'a worker claims it again');
  // Nothing left to withdraw: a second request is refused.
  const again = await call(master.token, 'POST', `work/${work.key}/decide`, { action: 'withdraw-park', input: { request: request.id }, reason: observed }, 409);
  assert.match(again.error, /has no open human-only request to withdraw/);

  // It never answers on the operator's behalf: spending money or opening accounts, and issuing credentials, are refused at request time.
  for (const [kind, label] of [['money-or-accounts', 'spending money or opening third-party accounts'], ['credentials-for-people', 'issuing credentials to people']] as const) {
    const item = await parked(`Refused ${kind}`, kind, { recommendation: kind === 'money-or-accounts' ? 'Approve with the smallest plan' : 'A fine-grained token scoped to one repository with a short expiry', why: 'It is the least the item needs.' });
    const refused = await call(master.token, 'POST', `work/${item.key}/decide`, withdrawPark(item, 'Observed: the account appears to exist already'), 409);
    assert.equal(refused.error, withdrawParkRefusal(item, { request: item.humanRequest!.id }));
    assert.match(refused.error, new RegExp(`A ${label} request is the operator's to answer, never withdrawn on their behalf`));
    assert.ok(parkedOnHuman(await reload(item.id)), `${kind} stays parked for the human`);
  }

  // A request whose sealed value has not been supplied is refused too, whatever its kind.
  const sealTo = '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----';
  const sealed = await parked('Sealed value', 'goals-and-priorities', { sealTo, recommendation: 'Provide the value', why: 'Only the operator holds it.',
    choices: [{ id: 'provide', label: 'Provide the value', outcome: 'provided', input: 'secret' }, { id: 'decline', label: 'Decline', outcome: 'declined', input: 'none' }] });
  const unsupplied = await call(master.token, 'POST', `work/${sealed.key}/decide`, withdrawPark(sealed, 'Observed: the value seems to be set'), 409);
  assert.match(unsupplied.error, /asks for a sealed value only the operator supplies; it is answered, never withdrawn on observation/);
  assert.ok(parkedOnHuman(await reload(sealed.id)));

  // A decision bound to another request is refused: a later park is never withdrawn by an earlier decision.
  const other = await parked('Another park', 'goals-and-priorities');
  const stale = await call(master.token, 'POST', `work/${other.key}/decide`, { action: 'withdraw-park', input: { request: request.id }, reason: observed }, 409);
  assert.match(stale.error, new RegExp(`open request is ${other.humanRequest!.id}, not ${request.id}`));
});
