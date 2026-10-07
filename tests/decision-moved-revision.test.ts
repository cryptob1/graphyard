import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { decisionGroundsChange, Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Principal } from '../src/model.js';
import type { Work } from '../src/model/work.js';
import { approvalConflict } from '../src/model/approval.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1463: a requested decision binds the item revision it was requested at, and a worker's lease
// renewal is itself a revision, about every 12 s. An approver takes minutes, so every decision on a
// leased item settled stale ('Task revision changed; reload and request again'): GY-1460's duplicate
// close went stale four times in a row. An approval now re-checks the decision's grounds against
// the item as it stands: renewals, liveness, observations and session records never stale it; a
// new submission or head, a stage move, a requirements revision, a lease epoch change or another
// applied decision still does, and the stale outcome names which.

let fixture: ReturnType<typeof start> | undefined;
let teardown: (() => Promise<void>) | undefined;
after(async () => { await teardown?.(); });
const plane = () => fixture ??= start();

async function start() {
  const repository = 'owner/moved-revision';
  const operator: Principal = { id: 'moved-operator', role: 'admin', sessionKind: 'human' };
  const implementer: Principal = { id: 'moved-implementer', role: 'worker', sessionKind: 'ai' };
  const credentials = [operator, implementer].map(principal => ({ ...principal, token: `moved-${principal.id}-${'x'.repeat(32)}` }));
  const master = { id: 'moved-master', token: `moved-master-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'intent:unblock'] };
  const approver = { id: 'graphyard-approver-moved', token: `moved-approver-${'a'.repeat(32)}`, capabilities: ['decision:approve', 'intent:create', 'intent:ready', 'intent:unblock'] };
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1463;
  const database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('decision-moved-revision'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('moved_test');
  const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/moved_test`); await store.init();
  const engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  const http = server(engine, credentials);
  teardown = async () => { http.close(); await store.close(); await database.stop(); };
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const send = async (token: string, path: string, body: unknown) => {
    const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const call = async (token: string, path: string, body: unknown) => {
    const result = await send(token, path, body);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  for (const agent of [master, approver])
    await call(credentials[0].token, 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Moved-revision fixture' });
  const decision = async (key: string, id: string) => {
    const response = await fetch(`${url}/api/work/${key}/decisions`, { headers: { Authorization: `Bearer ${master.token}` } });
    return (await response.json() as { decisions: any[] }).decisions.find(entry => entry.id === id);
  };
  const current = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
  const create = (title: string) => call(master.token, 'work', { title, plannedFiles: [`src/moved/${title}.ts`], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], reason: 'Moved-revision fixture' }) as Promise<Work>;
  /** An item a worker holds: released, claimed and given its workspace. */
  const leased = async (title: string) => {
    let work = await create(title);
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
    return engine.execute(implementer, 'workspace', work.id, { epoch: work.epoch, host: 'moved-host', path: `/tmp/moved/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, randomUUID());
  };
  /** The worker's supervisor renews the lease, as it does about every 12 s. */
  const renew = async (work: Work, times: number) => { for (let n = 0; n < times; n++) await engine.execute(implementer, 'heartbeat', work.id, { epoch: work.epoch }, randomUUID()); };
  /** The loop records an approver session on the item: a session record, which moves the revision too. */
  const session = (work: Work, id: string) => call(credentials[0].token, `work/${work.id}/session`, { id: `approver:${id}`, kind: 'coordination', principal: approver.id, role: 'approver',
    runtime: 'claude', host: 'moved-host', subject: `${work.key}: judge decision ${id}`, observed: 'working', observedAt: new Date().toISOString(), missedReports: 0 });
  /** The duplicate close GY-1460's diagnostician requested, bound to the revision it read. */
  const requestClose = async (work: Work, of: Work) => {
    const read = await current(work);
    return call(master.token, `work/${work.key}/decide`, { action: 'close', input: { kind: 'duplicate', ref: of.key, expectedRevision: read.revision }, reason: `${work.key} duplicates ${of.key}` });
  };
  return { engine, store, operator, implementer, master, approver, credentials, send, call, decision, current, create, leased, renew, session, requestClose };
}

test('integration:decision-survives-lease-renewal — a close requested on a leased item applies after the lease renewed many times, and settles stale naming a new submission', { timeout: 180_000 }, async () => {
  const { approver, send, decision, current, create, leased, renew, session, requestClose, engine, implementer } = await plane();
  const original = await create('original');

  // Lease renewals and session records between the request and the approval cannot affect a close's grounds.
  const held = await leased('duplicate');
  const asked = await requestClose(held, original);
  assert.equal(asked.state, 'requested');
  await renew(held, 6); await session(held, asked.id); await renew(held, 3);
  const moved = await current(held);
  assert.ok(moved.revision >= asked.input.expectedRevision + 10, `the revision moved from ${asked.input.expectedRevision} to ${moved.revision}`);
  assert.ok(moved.lease, 'the worker still holds the item');
  const approved = await send(approver.token, `work/${held.key}/approve`, { decision: asked.id, reason: 'Both items build the same change' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.state, 'applied', JSON.stringify(approved.body));
  const closed = await current(held);
  assert.equal(closed.stage, 'done');
  assert.deepEqual([closed.closure?.kind, closed.closure?.ref], ['duplicate', original.key], 'the approval applied exactly the input it judged');
  assert.equal(closed.lease, null, 'the approved close ended the lease');

  // A new submission between the request and the approval moves the grounds: the close settles stale, naming it.
  const submitting = await leased('submitting');
  const second = await requestClose(submitting, original);
  await renew(submitting, 2);
  await engine.execute(implementer, 'submit', submitting.id, { epoch: submitting.epoch, pr: 1463 }, randomUUID());
  const refused = await send(approver.token, `work/${submitting.key}/approve`, { decision: second.id, reason: 'Both items build the same change' });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error, /^A new submission \(pull request #1463, epoch \d+\) since revision \d+ moved the decision's grounds: Task revision changed \(now \d+\); reload and request again; the decision was not applied$/);
  const stale = await decision(submitting.key, second.id);
  assert.equal(stale.state, 'stale');
  assert.match(stale.outcome, /^A new submission \(pull request #1463/);
  assert.equal((await current(submitting)).stage, 'build', 'nothing was closed');
});

test('integration:decision-moved-revision-independence — on a moved revision the requester, an implementer and an evidence producer are still refused, and an approval binds the input it judged', { timeout: 180_000 }, async () => {
  const { master, approver, credentials, send, decision, current, create, leased, renew, requestClose } = await plane();
  const original = await create('independence-original');
  const held = await leased('independence-duplicate');
  const asked = await requestClose(held, original);
  await renew(held, 4);
  assert.ok((await current(held)).revision > asked.input.expectedRevision, 'the revision moved');

  // The requester may never approve its own decision.
  const self = await send(master.token, `work/${held.key}/approve`, { decision: asked.id, reason: 'My own close' });
  assert.equal(self.status, 403);
  assert.match(self.body.error, /^Self-approval refused: moved-master requested decision/);
  // An implementer of the item may never approve a decision about it.
  const implementerToken = credentials.find(entry => entry.id === 'moved-implementer')!.token;
  const own = await send(implementerToken, `work/${held.key}/approve`, { decision: asked.id, reason: 'Close the item I hold' });
  assert.equal(own.status, 403);
  assert.match(own.body.error, /^Conflicted approval refused: moved-implementer has held an assignment on/);
  // Refusals leave the decision requested — neither applied nor stale — for an independent approver.
  assert.equal((await decision(held.key, asked.id)).state, 'requested');
  // An evidence producer may never approve an attestation of its own evidence, whatever the revision.
  const item = await current(held);
  const produced = { ...item, revision: item.revision + 40, evidence: [{ proof: 'unit:works', producer: 'moved-producer' }] } as unknown as Work;
  assert.match(approvalConflict({ id: 'attest-1', action: 'attest', input: { proof: 'unit:works' }, requestedBy: master.id }, { id: 'moved-producer' }, produced) ?? '',
    /^Conflicted approval refused: moved-producer produced evidence unit:works/);

  // The independent approval applies exactly the recorded input: the close names the item it judged, nothing else.
  const approved = await send(approver.token, `work/${held.key}/approve`, { decision: asked.id, reason: 'Both items build the same change' });
  assert.equal(approved.body.state, 'applied', JSON.stringify(approved.body));
  const recorded = await decision(held.key, asked.id);
  assert.deepEqual(recorded.input, asked.input, 'the recorded decision input is unchanged by the rebase');
  assert.deepEqual([(await current(held)).closure?.kind, (await current(held)).closure?.ref], ['duplicate', original.key]);
});

test('unit:decision-grounds-change — renewals, liveness, observations and sessions never move a decision\'s grounds; submissions, heads, stages, requirements and lease epochs do', () => {
  const base = {
    id: 'w', key: 'GY-1', stage: 'build', ready: true, revision: 10, policyRevision: 1, policy: { checks: ['test'], review: true }, criteria: [], plannedFiles: ['src/a.ts'],
    epoch: 1, lease: { owner: 'worker', epoch: 1, expiresAt: '2030-01-01T00:00:00.000Z' }, lastAssignment: { owner: 'worker', epoch: 1 },
    containmentQuarantine: { owner: 'worker', epoch: 1, at: '2030-01-01T00:00:00.000Z', settlementHash: 'h', leaseExpiresAt: '2030-01-01T00:00:00.000Z' },
    submission: null, candidate: null, observation: null, workspaces: [], sessions: [], updatedAt: '2030-01-01T00:00:00.000Z', blocker: null,
  } as unknown as Work;
  const renewed = { ...base, revision: 11, updatedAt: '2030-01-01T00:00:12.000Z', lease: { ...base.lease!, expiresAt: '2030-01-01T00:02:12.000Z', renewalFault: { at: 'x', error: 'y' } },
    containmentQuarantine: { ...base.containmentQuarantine!, leaseExpiresAt: '2030-01-01T00:02:12.000Z', launchAcknowledgedAt: '2030-01-01T00:00:05.000Z' },
    observation: { at: 'now' }, sessions: [{ id: 's' }], workspaces: [{ host: 'h', path: '/p', branch: 'b', epoch: 1, owner: 'worker' }] } as unknown as Work;
  assert.equal(decisionGroundsChange(base, renewed), null);
  assert.match(decisionGroundsChange(base, { ...renewed, submission: { epoch: 1, pr: 7 } }) ?? '', /^a new submission \(pull request #7, epoch 1\)$/);
  assert.match(decisionGroundsChange(base, { ...renewed, candidate: { sha: 'a'.repeat(40) } } as unknown as Work) ?? '', /^a new head \(aaaaaaaaaaaa\)$/);
  assert.match(decisionGroundsChange(base, { ...renewed, stage: 'review' }) ?? '', /^a stage move \(build to review\)$/);
  assert.match(decisionGroundsChange(base, { ...renewed, policyRevision: 2 }) ?? '', /^a requirements or policy revision/);
  assert.match(decisionGroundsChange(base, { ...renewed, plannedFiles: ['src/a.ts', 'src/b.ts'] }) ?? '', /^a requirements or policy revision/);
  assert.match(decisionGroundsChange(base, { ...renewed, epoch: 2, lease: { owner: 'other', epoch: 2, expiresAt: 'x' } }) ?? '', /^a lease epoch change \(epoch 1 to epoch 2\)$/);
  assert.match(decisionGroundsChange(base, { ...renewed, lease: null }) ?? '', /^a lease epoch change \(epoch 1 to no lease\)$/);
  assert.equal(decisionGroundsChange(base, { ...renewed, blocker: { reason: 'stuck' } } as unknown as Work), 'a change to its blocker');
});
