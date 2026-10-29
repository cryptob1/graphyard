import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { ownerHoldRefusal } from '../src/model/loop-owned.js';
import { Store } from '../src/store.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2605: an item whose own record reserves its release to the owner (GY-1857's 'Owner hold:') is
// released only by the owner's human admin session; ordinary and loop-owned releases are unchanged.
const repository = 'owner/hold';
const owner: Principal = { id: 'human-owner', role: 'admin', sessionKind: 'human' };
const credentials = [{ ...owner, token: `owner-hold-${'o'.repeat(32)}` }];
const master = { id: 'master-operator', token: `master-operator-${'m'.repeat(32)}`, capabilities: ['policy:requirements'] };
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const call = async (credential: string, path: string, body: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const heldInput = { type: 'chore', title: 'Owner hold: schedule credential isolation when the owner says so', 
  description: 'Deferred by the owner. This item stays in the backlog until the owner releases it.',
  criteria: [{ id: 'AC-1', text: 'The owner decides when the work is scheduled', proofs: ['manual:owner-schedules-credential-isolation'] }], reason: 'Owner deferral' };
const ordinaryInput = { type: 'chore', title: 'Ordinary backlog work', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], reason: 'Next by priority' };
const created = async (input: unknown) => { const result = await call(master.token, 'work', input); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body as Work; };
const release = (credential: string, work: Work) => call(credential, `work/${work.id}/ready`, { expectedRevision: work.revision, reason: 'Release it' });
const fixture = (fields: Partial<Work>) => ({ key: 'GY-1', title: 'Work', description: '', criteria: [], ...fields }) as unknown as Work;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 2605;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('release-owner-hold'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('owner_hold_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/owner_hold_test`); await store.init();
  engine = new Engine(store, 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  for (const agent of [master]) {
    const provisioned = await call(credentials[0].token, 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Onboarding' });
    assert.equal(provisioned.status, 200, JSON.stringify(provisioned.body));
  }
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('unit:release-owner-hold-refused — every recorded form of the hold refuses a non-owner release, naming the hold', () => {
  for (const work of [fixture({ title: 'Owner hold: later' }), fixture({ description: 'It leaves the backlog only when the owner releases it.' }),
    fixture({ criteria: [{ id: 'AC-1', text: 'This stays in the backlog until the owner releases it', proofs: ['unit:x'] }] as Work['criteria'] }),
    fixture({ criteria: [{ id: 'AC-1', text: 'Scheduled', proofs: ['manual:owner-schedules-isolation'] }] as Work['criteria'] })]) {
    assert.match(ownerHoldRefusal(work, { id: 'doctor', role: 'operator-agent' }) ?? '', /owner hold.*doctor may not release it/);
  }
  assert.notEqual(ownerHoldRefusal(fixture({ title: 'Owner hold: later' }), { id: 'agent-admin', role: 'admin', sessionKind: 'ai' }), null, 'an AI admin session is not the owner');
});

test('integration:release-owner-hold-guard — master release of an owner-held item is refused; it stays in the backlog', async () => {
  const work = await created(heldInput);
  const refused = await release(master.token, work);
  assert.equal(refused.status, 409); assert.match(refused.body.error, /owner hold/);
  const after = await reload(work.id);
  assert.equal(after.stage, 'backlog'); assert.equal(after.ready, false); assert.equal(after.epoch, work.epoch);
  assert.deepEqual(after.actionQueue?.actions ?? [], []);
});

test('unit:release-owner-hold-owner-path — the owner\'s own release, or one carrying an owner-recorded answer, applies as today', async () => {
  const work = await created({ ...heldInput, title: 'Owner hold: owner releases it' });
  const released = await release(credentials[0].token, work);
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal((await reload(work.id)).ready, true);
  // GY-2606: once the owner's answer to a human-only request on the item is recorded, the master's release applies too.
  const decided = await created({ ...heldInput, title: 'Owner hold: owner decided it' });
  const answered = [{ id: 'request-1', kind: 'goals-and-priorities', needed: 'Schedule it', reason: 'Owner hold', requestedBy: master.id, at: new Date(0).toISOString(),
    answer: { by: owner.id, at: new Date(0).toISOString(), outcome: 'provided', text: 'Schedule it now', waitedMs: 0 } }];
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{humanRequests}',$2::jsonb) WHERE id=$1", [decided.id, JSON.stringify(answered)]);
  const carried = await reload(decided.id);
  assert.equal(ownerHoldRefusal(carried, { id: master.id, role: 'operator-agent' }), null);
  const releasedByMaster = await release(master.token, carried);
  assert.equal(releasedByMaster.status, 200, JSON.stringify(releasedByMaster.body));
  assert.equal((await reload(decided.id)).ready, true);
  // A declined answer records no decision to release it.
  assert.match(ownerHoldRefusal({ ...carried, humanRequests: [{ ...answered[0], answer: { ...answered[0].answer, outcome: 'declined' } }] } as unknown as Work, { id: master.id, role: 'operator-agent' }) ?? '', /owner hold/);
});

test('unit:release-normal-backlog-applies — an ordinary backlog item still releases', async () => {
  const work = await created(ordinaryInput);
  assert.equal(ownerHoldRefusal(work, { id: master.id, role: 'operator-agent' }), null);
  const released = await release(master.token, work);
  assert.equal(released.status, 200, JSON.stringify(released.body));
  const after = await reload(work.id);
  assert.equal(after.ready, true); assert.equal(after.stage, 'ready');
});

test('unit:release-loop-owned-refused — a loop-owned observation item is still refused as loop-owned', async () => {
  const work = await created({ type: 'chore', title: 'Observe the master checkout on the serving release', criteria: [{ id: 'AC-1', text: 'Checkout restored', proofs: ['manual:checkout-restore-on-serving-release'] }], reason: 'Observe' });
  const refused = await release(master.token, work);
  assert.equal(refused.status, 409); assert.match(refused.body.error, /is loop-owned/); assert.doesNotMatch(refused.body.error, /owner hold/);
  const after = await reload(work.id);
  assert.equal(after.stage, 'backlog'); assert.equal(after.ready, false);
});
