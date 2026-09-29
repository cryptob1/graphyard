import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { buildMasterStatus } from '../src/master.js';
import { closeWork } from '../src/server/close.js';
import { closeRequest } from '../src/cli/master-close.js';
import { isClosed, isDelivered, type Principal, type Work } from '../src/model.js';
import { nextAction } from '../src/model/next-action.js';
import type { Services } from '../src/server/routes.js';
import { homeNumbers } from '../web/home-numbers.js';
import { plainStatus } from '../src/model/plain-status.js';
import ShippedPage from '../web/pages/shipped.js';
import type { Dashboard } from '../web/pages/dashboard.js';

// `graphyard master close`: obsolete, duplicate and superseded items leave every open list and
// every delivered count, in one audited transaction, against a real Postgres and the real routes.
const repository = 'owner/close-work';
const operator: Principal = { id: 'close-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'close-master', role: 'coordinator', sessionKind: 'ai' };
const worker: Principal = { id: 'close-worker', role: 'worker', sessionKind: 'ai' };
const producer: Principal = { id: 'close-producer', role: 'producer', proofs: ['unit:close'] };
const credentials = [operator, coordinator, worker, producer].map(principal => ({ ...principal, token: `close-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const call = async (principal: Principal, path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (principal: Principal, path: string, body?: unknown) => {
  const result = await call(principal, path, body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const events = async (work: Work) => (await store.pool.query('SELECT actor, kind, payload FROM events WHERE work_id=$1 ORDER BY seq', [work.id])).rows as { actor: string; kind: string; payload: any }[];
async function released(title: string): Promise<Work> {
  const work = await ok(operator, 'work', { title, plannedFiles: [`src/${title.replace(/\W+/g, '-')}.ts`], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:close'] }] }) as Work;
  return ok(operator, `work/${work.id}/ready`, {});
}
/** Write a field the control plane would have set, directly, as the fixture for what closing must clear. */
async function patch(work: Work, change: Partial<Work>) {
  const current = await reload(work.id);
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [work.id, JSON.stringify({ ...current, ...change })]);
  return reload(work.id);
}

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 157;
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-close-db-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('close_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/close_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('integration:close-obsolete — a stuck item closed as obsolete is terminal, audited, not delivered and not stuck', async () => {
  const work = await patch(await released('obsolete noise'), { blocker: 'Nobody will ever answer this' });
  const before = await store.workSnapshot();
  const now = Date.parse(before.now);
  assert.equal(homeNumbers(before.work, now).stuck, 1, 'the fixture is on the Stuck list');
  const closed = await ok(coordinator, `work/${work.key}/close`, { kind: 'obsolete', reason: 'Auto-generated noise' }) as Work;
  assert.equal(closed.stage, 'done');
  assert.deepEqual({ ...closed.closure, at: undefined }, { kind: 'obsolete', reason: 'Auto-generated noise', ref: null, by: coordinator.id, at: undefined, from: 'ready' });
  assert.equal(closed.blocker, null);
  assert.ok(isClosed(closed) && !isDelivered(closed));
  const entry = (await events(closed)).find(event => event.kind === 'work.closed')!;
  assert.equal(entry.actor, coordinator.id);
  assert.equal(entry.payload.details.reason, 'Auto-generated noise');
  // Every open list and every delivered count leaves it out; only the closed count names it.
  const snapshot = await store.workSnapshot();
  const numbers = homeNumbers(snapshot.work, Date.parse(snapshot.now));
  assert.deepEqual([numbers.open, numbers.stuck, numbers.shippedThisWeek], [0, 0, 0]);
  assert.equal(plainStatus(closed, Date.now()).tone, 'shipped');
  assert.match(plainStatus(closed, Date.now()).sentence, /^Closed as obsolete: Auto-generated noise/);
  const status = buildMasterStatus({ work: snapshot.work, now: snapshot.now }, [], []);
  assert.equal(status.counts.closed, 1);
  assert.ok(!status.work.some(row => row.key === work.key), 'master status lists it in no active row');
  assert.ok(!status.delivered.some(row => row.key === work.key), 'nor as a delivery');
  assert.deepEqual(status.closed.map(row => [row.key, row.kind]), [[work.key, 'obsolete']]);
  // The dashboard: nothing under Shipped, one row in the closed history below it.
  const page = renderToStaticMarkup(createElement(ShippedPage, { work: snapshot.work, status: null, observedAt: Date.parse(snapshot.now), setSelected: () => {} } as unknown as Dashboard));
  assert.match(page, /Nothing has shipped yet/);
  assert.match(page, new RegExp(`Closed without shipping <span class="count">1</span>.*${work.key}.*obsolete.*Auto-generated noise`));
  assert.equal(nextAction(closed, snapshot.work, new Date()), null, 'nothing is owed on a closed item');
  assert.deepEqual(closed.actionQueue?.actions ?? [], []);
  // Closing is once: a closed item refuses a second closure and every lifecycle command.
  assert.equal((await call(coordinator, `work/${work.key}/close`, { kind: 'obsolete', reason: 'again' })).status, 409);
  assert.equal((await call(worker, `work/${work.id}/claim`, {})).status, 409);
});

test('integration:close-duplicate — a duplicate names an existing other item, and its open review and producer requests are cancelled', async () => {
  const original = await released('the original');
  const copy = await released('the copy');
  for (const [ref, status] of [['GY-99999', 422], [copy.key, 422], ['abc1234', 422]] as const)
    assert.equal((await call(operator, `work/${copy.id}/close`, { kind: 'duplicate', reason: 'Same thing', ref })).status, status, ref);
  assert.equal((await call(operator, `work/${copy.id}/close`, { kind: 'duplicate', reason: 'Same thing' })).status, 400, 'a duplicate without its original is refused');
  const request = { kind: 'review' as const, sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 1, pr: 7, requestedAt: new Date().toISOString(), reason: 'fixture', state: 'requested' as const };
  await patch(copy, { autoDispatch: { review: { ...request, id: 'review-1' }, producers: [{ ...request, id: 'producer-1', kind: 'producer', group: 'unit', proofs: ['unit:close'] }], history: [] } });
  const closed = await ok(operator, `work/${copy.id}/close`, { kind: 'duplicate', reason: 'Same thing', ref: original.key }) as Work;
  assert.deepEqual([closed.closure!.kind, closed.closure!.ref], ['duplicate', original.key]);
  assert.equal(closed.autoDispatch!.review, null); assert.deepEqual(closed.autoDispatch!.producers, []);
  assert.deepEqual(closed.autoDispatch!.history.map(entry => [entry.id, entry.state]), [['review-1', 'cancelled'], ['producer-1', 'cancelled']]);
  assert.deepEqual((await events(closed)).filter(event => event.kind === 'dispatch.cancelled').map(event => event.payload.details.id), ['review-1', 'producer-1']);
  assert.equal((await reload(original.id)).stage, 'ready', 'the original is untouched');
});

test('integration:close-superseded — only a landed commit or a delivered item supersedes', async () => {
  const work = await released('superseded work');
  const open = await released('still open');
  assert.equal((await call(coordinator, `work/${work.id}/close`, { kind: 'superseded', reason: 'Replaced', ref: open.key })).status, 422, 'an undelivered item supersedes nothing');
  assert.equal((await call(coordinator, `work/${work.id}/close`, { kind: 'superseded', reason: 'Replaced', ref: 'not-a-sha' })).status, 422);
  assert.equal((await call(coordinator, `work/${work.id}/close`, { kind: 'superseded', reason: 'Replaced', ref: 'c'.repeat(40) })).status, 503, 'ancestry is never assumed without GitHub');
  // Ancestry as GitHub reports it: the base tip contains the landed commit and not the other one.
  const tip = 'f'.repeat(40), landed = 'd'.repeat(40), unlanded = 'e'.repeat(40);
  const github = { baseBranch: async () => ({ tip, tree: '0'.repeat(40) }), contains: async (base: string, head: string) => head === tip && base === landed };
  const services = { engine, github, repository, principals: [] } as unknown as Services;
  await assert.rejects(closeWork(services, coordinator, work.id, { kind: 'superseded', reason: 'Replaced', ref: unlanded }, randomUUID()), /not an ancestor of the base branch/);
  const closed = await closeWork(services, coordinator, work.id, { kind: 'superseded', reason: 'Replaced by the rewrite', ref: landed }, randomUUID()) as Work;
  assert.deepEqual([closed.closure!.kind, closed.closure!.ref, closed.stage], ['superseded', landed, 'done']);
  // A delivered item supersedes too; a closed one does not, because it delivered nothing.
  assert.equal((await call(coordinator, `work/${open.id}/close`, { kind: 'superseded', reason: 'Replaced', ref: work.key })).status, 422);
  const delivered = await patch(await released('delivered work'), { stage: 'done' });
  assert.equal((await ok(coordinator, `work/${open.id}/close`, { kind: 'superseded', reason: 'Replaced', ref: delivered.key })).closure.ref, delivered.key);
});

test('integration:close-refusals — a live lease refuses, and only the master or an admin may close', async () => {
  const work = await released('leased work');
  const claimed = await ok(worker, `work/${work.id}/claim`, {}) as Work;
  const leased = await call(coordinator, `work/${work.id}/close`, { kind: 'obsolete', reason: 'Not wanted' });
  assert.equal(leased.status, 409); assert.match(JSON.stringify(leased.body), /live worker lease/);
  await ok(worker, `work/${work.id}/release`, { epoch: claimed.epoch });
  for (const principal of [worker, producer]) assert.equal((await call(principal, `work/${work.id}/close`, { kind: 'obsolete', reason: 'Not wanted' })).status, 403, principal.id);
  assert.equal((await ok(operator, `work/${work.id}/close`, { kind: 'obsolete', reason: 'Not wanted' })).stage, 'done');
});

test('integration:close-withdraws-human-request — the parked human-only request is withdrawn and leaves the Needs-you list', async () => {
  const work = await released('parked on a human');
  const claimed = await ok(worker, `work/${work.id}/claim`, {}) as Work;
  await ok(worker, `work/${work.id}/park`, { epoch: claimed.epoch, kind: 'money-or-accounts', reason: 'Needs a paid account', needed: 'A provider account' });
  assert.equal((await ok(operator, 'human-requests')).requests.filter((row: any) => row.work === work.key).length, 1);
  const closed = await ok(coordinator, `work/${work.id}/close`, { kind: 'obsolete', reason: 'No longer wanted' }) as Work;
  assert.equal(closed.humanRequest, null);
  assert.deepEqual([closed.humanRequests!.at(-1)!.answer!.outcome, closed.humanRequests!.at(-1)!.answer!.text], ['withdrawn', 'withdrawn: item closed']);
  assert.equal(closed.blocker, null);
  assert.equal((await ok(operator, 'human-requests')).requests.filter((row: any) => row.work === work.key).length, 0);
  assert.equal((await events(closed)).find(event => event.kind === 'work.closed')!.payload.details.withdrawn, closed.humanRequests!.at(-1)!.id);
});

test('unit:close-cli — master close takes exactly one closure kind', () => {
  assert.deepEqual(closeRequest(['GY-4', 'Same', 'thing', '--duplicate-of', 'GY-2']), { key: 'GY-4', body: { kind: 'duplicate', reason: 'Same thing', ref: 'GY-2' } });
  assert.deepEqual(closeRequest(['GY-4', '--superseded-by', 'abc1234', 'Landed']), { key: 'GY-4', body: { kind: 'superseded', reason: 'Landed', ref: 'abc1234' } });
  assert.deepEqual(closeRequest(['GY-4', 'Noise', '--obsolete']), { key: 'GY-4', body: { kind: 'obsolete', reason: 'Noise' } });
  for (const args of [['GY-4', 'Noise'], ['GY-4', '--obsolete'], ['GY-4', 'x', '--obsolete', '--duplicate-of', 'GY-2']]) assert.throws(() => closeRequest(args), /Use master close/);
});
