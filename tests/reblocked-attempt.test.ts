import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Principal, Work } from '../src/model.js';

/**
 * GY-867. An interrupted worker end may carry endsBlocker: the control plane then ends the blocker
 * that attempt recorded along with its lease.
 */
const repository = 'owner/reblocked';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const coordinator: Principal = { id: 'coordinator', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, implementer, coordinator].map(principal => ({ ...principal, token: `reblocked-${principal.id}-${'x'.repeat(32)}` }));
const master = { id: 'master-operator', token: `master-operator-${'m'.repeat(32)}`, capabilities: ['policy:requirements'] };
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
const call = async (credential: string, path: string, body: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const interrupted = (epoch: number, endsBlocker: boolean) => ({ event: 'exhausted', cause: 'interrupted', role: 'worker', epoch, profile: 'alpha', account: null, runtime: 'claude',
  reason: `attempt ${epoch} blocked again after its blocker was cleared`, resetsAt: null, partialWork: { state: 'committed', commit: 'a'.repeat(40), branch: 'graphyard/x', detail: 'kept' }, ...(endsBlocker ? { endsBlocker: true } : {}) });

async function blockedAttempt(title: string) {
  let work = (await call(master.token, 'work', { title, type: 'chore', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], reason: 'Operator goal: reblocked attempts end' })).body as Work;
  work = (await call(master.token, `work/${work.id}/ready`, { expectedRevision: work.revision, reason: 'Ready' })).body as Work;
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  const lease = work.lease!;
  work = await engine.execute(implementer, 'blocked', work.id, { epoch: lease.epoch, reason: 'sandbox /tmp owned by uid 65534' }, randomUUID());
  // Since GY-1008 a blocker ends its attempt at once; an attempt blocked before that still holds
  // its lease, which is the record the loop's reblocked end (GY-867) was made for.
  assert.equal(work.lease, null);
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{lease}',$2::jsonb) WHERE id=$1", [work.id, JSON.stringify(lease)]);
  return reload(work.id);
}

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 881;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('reblocked-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('reblocked_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/reblocked_test`); await store.init();
  engine = new Engine(store, 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const agent = await call(token(operator), 'operator-agents', { id: master.id, displayName: master.id, capabilities: master.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: master.token, reason: 'Onboarding provisions the master operator agent' });
  assert.equal(agent.status, 200, JSON.stringify(agent.body));
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('integration:reblocked-attempt-ends-own-blocker — an interrupted report with endsBlocker ends the lease and the blocker that attempt wrote, and nothing else', async () => {
  // The attempt's own blocker ends with it, and the item is claimable again.
  const own = await blockedAttempt('Own blocker');
  const ended = await call(token(coordinator), `work/${own.id}/capacity`, interrupted(own.epoch, true));
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  let work = await reload(own.id);
  assert.equal(work.lease, null);
  assert.equal(work.blocker, null, 'its own blocker ended with the attempt');
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  assert.equal(work.epoch, own.epoch + 1, 'a new attempt claims the item');

  // Without endsBlocker the blocker stays, exactly as before.
  const plain = await blockedAttempt('Plain interruption');
  assert.equal((await call(token(coordinator), `work/${plain.id}/capacity`, interrupted(plain.epoch, false))).status, 200);
  assert.equal((await reload(plain.id)).blocker, 'sandbox /tmp owned by uid 65534');

  // endsBlocker is refused on anything but an interrupted worker end.
  const refused = await call(token(coordinator), `work/${plain.id}/capacity`, { ...interrupted(plain.epoch, true), cause: 'quota' });
  assert.equal(refused.status, 400);
});
