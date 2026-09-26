import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { Store } from '../src/store.js';
import { approverAgentCapabilities, masterOperatorCapabilities } from '../src/master.js';

// GY-642: an approver judging an attestation, rework or resolve decision reads the evidence the
// decision rests on — the events ledger and the work snapshot. The grant is a read only: every
// mutation the approver could not make before stays refused, and nothing it attempts is recorded.
const repository = 'owner/ledger-read';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const credentials = [{ ...operator, token: `ledger-operator-${'x'.repeat(32)}` }];
const master = { id: 'master-operator', token: `master-operator-${'m'.repeat(32)}`, capabilities: [...masterOperatorCapabilities] };
const approver = { id: 'approver-agent', token: `approver-agent-${'a'.repeat(32)}`, capabilities: [...approverAgentCapabilities] };
let database: EmbeddedPostgres, store: Store, http: ReturnType<typeof server>, url: string;

const call = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 642;
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-approver-ledger-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('ledger_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/ledger_test`); await store.init();
  const engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  for (const agent of [master, approver]) {
    const provisioned = await call(credentials[0].token, 'POST', 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Onboarding provisions agent identities' });
    assert.equal(provisioned.status, 200, JSON.stringify(provisioned.body));
  }
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('unit:approver-reads-ledger — an approver principal reads the whole events ledger, one item\'s events and the work snapshot with 200, and every mutation it could not make before is still refused and records nothing', async () => {
  const created = await call(master.token, 'POST', 'work', { title: 'Measured', plannedFiles: ['src/measured.ts'], criteria: [{ id: 'AC-1', text: 'Measured from the ledger', proofs: ['unit:measured'] }], reason: 'Operator goal: approvers verify measurements' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const work = created.body as Work;

  // The reads an approver needs to rerun a measurement itself.
  const ledger = await call(approver.token, 'GET', 'events');
  assert.equal(ledger.status, 200, JSON.stringify(ledger.body));
  assert.ok(Array.isArray(ledger.body) && ledger.body.some((event: any) => event.work_id === work.id), 'the whole ledger includes the item\'s events');
  const history = await call(approver.token, 'GET', 'events?view=history&limit=5');
  assert.equal(history.status, 200, JSON.stringify(history.body));
  const perItem = await call(approver.token, 'GET', `events?work=${work.id}`);
  assert.equal(perItem.status, 200, JSON.stringify(perItem.body));
  assert.ok(perItem.body.length > 0 && perItem.body.every((event: any) => event.work_id === work.id));
  for (const path of ['work-snapshot', 'work', `work/${work.key}`]) assert.equal((await call(approver.token, 'GET', path)).status, 200, path);

  // The grant is the approver's alone: an operator agent without decision:approve still names its item.
  const unscoped = await call(master.token, 'GET', 'events');
  assert.equal(unscoped.status, 403, JSON.stringify(unscoped.body));
  assert.match(unscoped.body.error, /require a scoped work item/);

  // No write was added: every mutation below was refused before the grant and still is.
  const baseline = await call(credentials[0].token, 'GET', `work/${work.key}`);
  const revision = baseline.body.revision as number;
  const mutations: [string, unknown][] = [
    ['work', { title: 'Approver-created', plannedFiles: ['src/x.ts'], criteria: [{ id: 'AC-1', text: 'x', proofs: ['unit:x'] }], reason: 'An approver never creates work' }],
    [`work/${work.key}/ready`, { expectedRevision: revision, reason: 'An approver never releases' }],
    [`work/${work.key}/block`, { expectedRevision: revision, reason: 'An approver never blocks' }],
    [`work/${work.key}/requirements`, { expectedRevision: revision, criteria: [{ id: 'AC-2', text: 'y', proofs: ['unit:y'] }], reason: 'An approver never adds requirements' }],
    [`work/${work.key}/decide`, { action: 'release', input: { expectedRevision: revision }, reason: 'An approver never requests' }],
    [`work/${work.key}/close`, { reason: 'An approver never closes' }],
    [`work/${work.key}/park`, { kind: 'goals-and-priorities', needed: 'x', reason: 'An approver never parks' }],
    ['assignments/claim', { work: work.id }],
    ['actions/claim', {}],
    ['operator-agents', { id: 'minted', displayName: 'minted', capabilities: ['decision:approve'], scope: { repositories: [repository], workItems: ['*'] }, token: `minted-${'z'.repeat(32)}`, reason: 'An approver never mints identities' }],
    [`operator-agents/${approver.id}/configure`, { expectedRevision: 1, capabilities: ['decision:approve', 'intent:create'], scope: { repositories: [repository], workItems: ['*'] }, reason: 'An approver never widens itself' }],
    ['intake', { title: 'x' }],
    ['merge-queue', {}],
    ['validation/result', {}],
    ['direct-merges/on', { reason: 'x' }],
  ];
  for (const [path, body] of mutations) {
    const refused = await call(approver.token, 'POST', path, body);
    assert.ok(refused.status >= 400 && refused.status < 500, `${path} answered ${refused.status}: ${JSON.stringify(refused.body)}`);
  }
  const after = await call(credentials[0].token, 'GET', 'events');
  assert.equal(after.status, 200);
  assert.deepEqual(after.body.filter((event: any) => event.actor === approver.id), [], 'the approver recorded nothing');
  const unchanged = await call(credentials[0].token, 'GET', `work/${work.key}`);
  assert.equal(unchanged.body.revision, baseline.body.revision);
  assert.equal(unchanged.body.ready, false);
});
