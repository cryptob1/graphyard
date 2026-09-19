import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { standingEscalations, type Observation, type Principal, type Work } from '../src/model.js';
import { approvalConflict, foldDecisions, requiredDecisionCapabilities } from '../src/model/approval.js';
import { Store } from '../src/store.js';

// GY-70: decisions the guides reserved for a human operator are completed by one agent identity
// holding the capability plus an approval from a second, independent agent identity. Each test
// is named for the proof it produces.
const repository = 'owner/autonomy';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const producer: Principal = { id: 'proof-runner', role: 'producer', proofs: ['unit:*'], sessionKind: 'ai' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const roster = [operator, implementer, producer, coordinator];
const credentials = roster.map(principal => ({ ...principal, token: `approval-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
// Agent identities, provisioned through the operator-agent API as onboarding does.
const master = { id: 'master-operator', token: `master-operator-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements', 'decision:resolve', 'decision:attest', 'decision:merge', 'decision:rework', 'decision:grant'] };
const approver = { id: 'approver-agent', token: `approver-agent-${'a'.repeat(32)}`, capabilities: ['decision:approve'] };
const dual = { id: 'dual-agent', token: `dual-agent-${'d'.repeat(32)}`, capabilities: ['intent:ready', 'decision:merge', 'decision:approve'] };
const head = 'a'.repeat(40), base = 'b'.repeat(40);
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
let pr = 700;

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
const decide = (credential: string, work: Work, action: string, input: unknown, reason: string) => call(credential, 'POST', `work/${work.key}/decide`, { action, input, reason });
const approve = (credential: string, work: Work, decision: string, reason: string) => call(credential, 'POST', `work/${work.key}/approve`, { decision, reason });
const events = async (work: Work) => (await store.pool.query('SELECT actor, kind, payload FROM events WHERE work_id=$1 ORDER BY seq', [work.id])).rows;
const input = (title: string) => ({ title, plannedFiles: [`src/${title}.ts`], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }, { id: 'AC-2', text: 'Audited', proofs: ['manual:audit'] }], reason: 'Operator goal: approvals run without a human' });
function observation(work: Work): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: work.submission!.pr, branch: work.workspaces.at(-1)!.branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'independent-reviewer', sha: head, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, files: [`src/${work.title}.ts`], scopeFiles: [], at: new Date().toISOString() };
}
async function created(title: string) {
  return ok(master.token, 'POST', 'work', input(title)) as Promise<Work>;
}
async function candidate(title: string) {
  let work = await created(title);
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(implementer, 'workspace', work.id, { epoch: work.epoch, host: 'approval-host', path: `/tmp/approval/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, randomUUID());
  work = await engine.execute(implementer, 'submit', work.id, { epoch: work.epoch, pr: ++pr }, randomUUID());
  return engine.observe(work.id, work.revision, observation(work));
}

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 40;
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-agent-approval-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('approval_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/approval_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  for (const agent of [master, approver, dual])
    await ok(token(operator), 'POST', 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Onboarding provisions agent identities' });
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('integration:agent-approval-flow — release, unblock, requirement rewrite, escalation, rework, attestation, merge approval and grants complete with two agents and no human', async () => {
  // Releasing work: requested by the master's operator agent, approved by the approver agent.
  let work = await created('release-by-agents');
  let requested = await decide(master.token, work, 'release', { expectedRevision: work.revision }, 'Backlog item is next by priority');
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  assert.equal(requested.body.state, 'requested'); assert.equal(requested.body.requestedBy, master.id);
  assert.equal((await reload(work.id)).ready, false, 'a request alone changes nothing');
  let approved = await approve(approver.token, work, requested.body.id, 'Priority matches the goal list');
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.state, 'applied'); assert.equal(approved.body.approvedBy, approver.id);
  assert.equal((await reload(work.id)).ready, true);
  const ledger = await events(work);
  const kinds = ledger.map(row => row.kind);
  assert.ok(kinds.indexOf('decision.requested') < kinds.indexOf('decision.approved') && kinds.indexOf('decision.approved') < kinds.indexOf('ready') && kinds.indexOf('ready') < kinds.indexOf('decision.applied'));
  const approvalRow = ledger.find(row => row.kind === 'decision.approved')!;
  assert.equal(approvalRow.actor, approver.id); assert.equal(approvalRow.payload.requestedBy, master.id); assert.equal(approvalRow.payload.reason, 'Priority matches the goal list');
  const readyRow = ledger.find(row => row.kind === 'ready')!;
  assert.equal(readyRow.actor, master.id, 'the requester is the actor of the applied mutation');
  assert.match(readyRow.payload.details.reason, new RegExp(`requested by ${master.id}, approved by ${approver.id}`));
  const listed = await ok(master.token, 'GET', `work/${work.key}/decisions`);
  assert.equal(listed.decisions.length, 1); assert.equal(listed.decisions[0].state, 'applied');

  // Unblocking: the worker reports a blocker; two agents clear it.
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(implementer, 'blocked', work.id, { epoch: work.epoch, reason: 'Waiting on an external decision' }, randomUUID());
  requested = await decide(master.token, work, 'unblock', { expectedRevision: work.revision }, 'The external decision was made');
  approved = await approve(approver.token, work, requested.body.id, 'Confirmed the decision is recorded');
  assert.equal(approved.body.state, 'applied', JSON.stringify(approved.body));
  assert.equal((await reload(work.id)).blocker, null);
  work = await engine.execute(implementer, 'release', work.id, { epoch: work.epoch }, randomUUID());

  // A requirement rewrite, which an operator agent alone may never make, applies with approval
  // and still raises the requirement-weakening escalation, which two agents then resolve.
  work = await reload(work.id);
  const rewrite = { expectedPolicyRevision: work.policyRevision, criteria: [{ id: 'AC-1', text: 'Works on every platform', proofs: ['unit:works'] }], dependencies: [], plannedFiles: work.plannedFiles, exclusiveResources: [], producerProofs: [] };
  const alone = await call(master.token, 'POST', `work/${work.key}/requirements`, { ...rewrite, reason: 'Alone' });
  assert.notEqual(alone.status, 200); assert.match(alone.body.error, /cannot weaken or rewrite/, 'the operator agent alone is refused a rewrite');
  requested = await decide(master.token, work, 'requirements', rewrite, 'AC-2 moved to a follow-up item');
  approved = await approve(approver.token, work, requested.body.id, 'Follow-up item carries the audit');
  assert.equal(approved.body.state, 'applied', JSON.stringify(approved.body));
  work = await reload(work.id);
  assert.deepEqual(work.criteria.map(criterion => criterion.text), ['Works on every platform']);
  assert.deepEqual(standingEscalations(work).map(entry => entry.trigger), ['requirement-weakening']);
  requested = await decide(master.token, work, 'resolve', { trigger: 'requirement-weakening', expectedRevision: work.revision }, 'The retired criterion is carried by a follow-up');
  approved = await approve(approver.token, work, requested.body.id, 'Verified the follow-up exists');
  assert.equal(approved.body.state, 'applied', JSON.stringify(approved.body));
  work = await reload(work.id);
  assert.deepEqual(standingEscalations(work), []);
  const resolved = (await events(work)).find(row => row.kind === 'escalation.resolved')!;
  assert.equal(resolved.payload.details.resolvedBy, master.id); assert.equal(resolved.payload.details.approvedBy, approver.id);
  assert.equal(resolved.payload.details.reason, 'The retired criterion is carried by a follow-up');

  // Manual attestation, merge approval with automatic merging off, and rework, on a candidate.
  let item = await candidate('candidate-by-agents');
  const binding = { sha: head, baseSha: base, policyRevision: item.policyRevision };
  requested = await decide(master.token, item, 'attest', { proof: 'manual:audit', ...binding, result: 'pass', executed: 1, skipped: 0 }, 'Audited the diff against the goal');
  approved = await approve(approver.token, item, requested.body.id, 'Re-read the audit notes');
  assert.equal(approved.body.state, 'applied', JSON.stringify(approved.body));
  item = await reload(item.id);
  const attested = item.evidence.find(evidence => evidence.proof === 'manual:audit')!;
  assert.equal(attested.trusted, true); assert.equal(attested.producer, master.id);
  requested = await decide(master.token, item, 'merge', binding, 'All gates pass; automatic merging is off');
  approved = await approve(approver.token, item, requested.body.id, 'Candidate reviewed and proven');
  assert.equal(approved.body.state, 'applied'); assert.match(approved.body.outcome, new RegExp(`Merge of ${head}`));
  requested = await decide(master.token, item, 'rework', { previousWorkerStopped: true }, 'Reviewer finding needs a change');
  approved = await approve(approver.token, item, requested.body.id, 'Finding confirmed');
  assert.equal(approved.body.state, 'applied', JSON.stringify(approved.body));
  assert.equal((await reload(item.id)).reworkRequested, true);

  // Granting proof authority to a producer agent.
  requested = await decide(master.token, item, 'grant', { principal: producer.id, patterns: ['manual:audit'] }, 'Producer runs the audit from now on');
  approved = await approve(approver.token, item, requested.body.id, 'Producer is independent of the item');
  assert.equal(approved.body.state, 'applied', JSON.stringify(approved.body));
  const grant = (await store.pool.query('SELECT document FROM proof_grants WHERE principal_id=$1', [producer.id])).rows[0].document;
  assert.ok(grant.patterns.includes('manual:audit')); assert.equal(grant.lastMutation.actor, master.id);

  // A replayed approval returns its receipt, and a decision is applied once.
  const replay = await fetch(`${url}/api/work/${item.key}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${approver.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'fixed-key' }, body: JSON.stringify({ decision: requested.body.id, reason: 'again' }) });
  assert.equal(replay.status, 409, 'an applied decision cannot be approved again');
});

test('integration:agent-approval-separation — self-approval and conflicted approval are refused, naming the conflict', async () => {
  const item = await candidate('separated-approvals');
  // Evidence from the producer makes it conflicted on merge approval.
  await engine.execute(producer, 'evidence', item.id, { proof: 'unit:works', sha: head, baseSha: base, policyRevision: item.policyRevision, result: 'pass', executed: 3, skipped: 0 }, randomUUID());
  const requested = await decide(dual.token, item, 'merge', { sha: head, baseSha: base, policyRevision: item.policyRevision }, 'Gates pass');
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  // The requester cannot approve its own request, even holding decision:approve.
  const self = await approve(dual.token, item, requested.body.id, 'Looks fine to me');
  assert.equal(self.status, 403); assert.match(self.body.error, /Self-approval refused: dual-agent requested decision/);
  // An identity that held an assignment on the item is conflicted.
  const assigned = await approve(token(implementer), item, requested.body.id, 'I built it');
  assert.equal(assigned.status, 403); assert.match(assigned.body.error, /implementer has held an assignment on GY-\d+/);
  // An identity may not approve a decision resting on its own evidence.
  const ownEvidence = await approve(token(producer), item, requested.body.id, 'My proof passed');
  assert.equal(ownEvidence.status, 403); assert.match(ownEvidence.body.error, /proof-runner produced evidence unit:works .* may not approve its own evidence/);
  // A coordinator — the master's loop identity — never approves.
  const loop = await approve(token(coordinator), item, requested.body.id, 'Loop approves');
  assert.equal(loop.status, 403); assert.match(loop.body.error, /agent identities holding decision:approve; master-loop is a coordinator/);
  // Every refusal is on the ledger with the conflict it named; the decision still stands requested.
  const refusals = (await events(item)).filter(row => row.kind === 'decision.refused');
  assert.deepEqual(refusals.map(row => row.actor), ['dual-agent', 'implementer', 'proof-runner']);
  assert.match(refusals[0].payload.conflict, /Self-approval/);
  const listed = await ok(master.token, 'GET', `work/${item.key}/decisions`);
  assert.equal(listed.decisions[0].state, 'requested'); assert.equal(listed.decisions[0].refusals.length, 3);
  // An independent approver applies it; a second approval is refused as already applied.
  const approved = await approve(approver.token, item, requested.body.id, 'Independent check');
  assert.equal(approved.status, 200, JSON.stringify(approved.body)); assert.equal(approved.body.approvedBy, approver.id);
  const again = await approve(approver.token, item, requested.body.id, 'Twice');
  assert.equal(again.status, 409); assert.match(again.body.error, /already applied/);
  // An attestation approver who produced that proof's evidence is conflicted; the grant target is too.
  const decision = { id: 'd', requestedBy: master.id } as const;
  const work = await reload(item.id);
  assert.match(approvalConflict({ ...decision, action: 'attest', input: { proof: 'unit:works' } }, { id: producer.id }, work)!, /may not approve its own evidence/);
  assert.equal(approvalConflict({ ...decision, action: 'attest', input: { proof: 'manual:audit' } }, { id: producer.id }, work), null);
  assert.match(approvalConflict({ ...decision, action: 'grant', input: { principal: 'approver-agent' } }, { id: approver.id }, work)!, /is the principal this grant would authorize/);
  // A request whose precondition no longer holds is refused before any approval.
  const stale = await decide(master.token, item, 'release', { expectedRevision: 1 }, 'Stale');
  assert.equal(stale.status, 409); assert.match(stale.body.error, /revision changed|Only unreleased backlog work/);
  // A requirements decision that declares a bootstrap deferral also needs policy:bootstrap, as the direct command does.
  const deferral = { id: 'AC-1', text: 'Works', proofs: ['unit:works'], bootstrap: { reason: 'Self-proving change', contractPaths: [`src/${work.title}.ts`] } };
  assert.deepEqual(requiredDecisionCapabilities('requirements', { criteria: [deferral] }, work), ['policy:requirements', 'policy:bootstrap']);
  assert.deepEqual(requiredDecisionCapabilities('requirements', { criteria: work.criteria }, work), ['policy:requirements']);
  const deferred = await decide(master.token, work, 'requirements', { expectedPolicyRevision: work.policyRevision, criteria: [deferral], dependencies: [], plannedFiles: work.plannedFiles, exclusiveResources: [], producerProofs: [] }, 'Defer the proof');
  assert.equal(deferred.status, 403); assert.match(deferred.body.error, /Capability policy:bootstrap is required/);
  // Folding ignores entries for unknown decisions.
  assert.deepEqual(foldDecisions('w', [{ kind: 'decision.approved', actor: 'x', at: '', payload: { id: 'nope' } }]), []);
});
