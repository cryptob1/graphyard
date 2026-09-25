import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import {
  activeEngineers, classifyIntake, defaultDelegationLimits, delegationLimits, delegationSnapshot, enforceLeadCapacity, humanOnlyIntakeOrigins, implementerIdentities,
  leadMay, leadPermittedActions, leadRulingActions, mergeOrder, producerIndependenceRefusal, recordIntake, recordLeadRuling,
  routineIntakeOrigins, sessionKind, slices, validateDelegationPrincipals,
} from '../src/delegation.js';
import { assertMergeCandidate, currentMergeCandidates } from '../src/master.js';
import { queueRef, type QueueSpeculation } from '../src/merge-queue.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { sliceIds, standingEscalations, type Observation, type Principal, type SliceId, type Work } from '../src/model.js';
import { Store } from '../src/store.js';

// Each test is named for the proof it produces, so acceptance evidence maps to
// one executed case per required proof.
const admin: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human', displayName: 'Operator' };
const lead: Principal = { id: 'product-lead', role: 'slice-lead', slice: 'product', sessionKind: 'ai', displayName: 'Pine' };
const replacementProductLead: Principal = { id: 'replacement-product-lead', role: 'slice-lead', slice: 'product', sessionKind: 'ai', displayName: 'Cedar' };
const infraLead: Principal = { id: 'infra-lead', role: 'slice-lead', slice: 'infrastructure', sessionKind: 'ai' };
const docsLead: Principal = { id: 'docs-lead', role: 'slice-lead', slice: 'docs-experience', sessionKind: 'ai' };
const workerA: Principal = { id: 'engineer-a', role: 'worker', sessionKind: 'ai' };
const workerB: Principal = { id: 'engineer-b', role: 'worker', sessionKind: 'ai' };
const workerC: Principal = { id: 'engineer-c', role: 'worker', sessionKind: 'ai' };
const reviewer: Principal = { id: 'proof-runner', role: 'producer', proofs: ['unit:works', 'manual:audit'], sessionKind: 'ai', displayName: 'Rowan' };
const coordinator: Principal = { id: 'merge-broker', role: 'coordinator', sessionKind: 'ai' };
// Admin credentials whose declared session kind is not human: the role alone must
// never unlock a human-only intake origin.
const aiAdmin: Principal = { id: 'automation-admin', role: 'admin', sessionKind: 'ai', displayName: 'Automation' };
const undeclaredAdmin: Principal = { id: 'legacy-admin', role: 'admin' };
const roster = [admin, lead, infraLead, docsLead, workerA, workerB, workerC, reviewer, coordinator, aiAdmin, undeclaredAdmin];
const head = 'a'.repeat(40), base = 'b'.repeat(40), redone = 'c'.repeat(40);
let database: EmbeddedPostgres, store: Store, engine: Engine;
let http: ReturnType<typeof server>, url: string;
const credentials = roster.map(principal => ({ ...principal, token: `delegation-${principal.id}-${'x'.repeat(32)}` }));
let pr = 500;
const id = () => randomUUID();
const input = (title: string, slice?: SliceId) => ({ title, ...(slice ? { slice } : {}), plannedFiles: [`src/${title}.ts`], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }] });
const proof = (overrides: Record<string, unknown> = {}) => ({ proof: 'unit:works', sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 4, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 }, ...overrides });
function observation(work: Work, sha = head): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { sha, baseSha: base, pr: work.submission!.pr, branch: work.workspaces.at(-1)!.branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'independent-reviewer', sha, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, files: ['src/delegation.ts'], scopeFiles: [], at: new Date().toISOString() };
}
// Drive an item to an observed candidate. Submission ends the lease, so later tests
// in the same slice are not blocked by a stale active engineer.
async function candidate(actor: Principal, title: string, slice?: SliceId) {
  let work = await engine.execute(admin, 'create', null, input(title, slice), id());
  work = await engine.execute(admin, 'ready', work.id, {}, id());
  work = await engine.execute(actor, 'claim', work.id, {}, id());
  work = await engine.execute(actor, 'workspace', work.id, { epoch: work.epoch, host: 'delegation-host', path: `/tmp/delegation/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, id());
  work = await engine.execute(actor, 'submit', work.id, { epoch: work.epoch, pr: ++pr }, id());
  assert.equal(work.lease, null, 'complete ends the implementation lease');
  return engine.observe(work.id, work.revision, observation(work));
}
const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
// The merge queue is global and strictly ordered, so a scenario that needs merge
// authority has to hold its head. Earlier scenarios in this shared store leave
// their proven candidates queued; returning those to their workers frees the slot
// without touching any history.
async function queueHeadFor(work: Work) {
  for (const item of await store.list())
    if (item.queue && item.id !== work.id && item.stage !== 'done')
      await engine.execute(admin, 'rework', item.id, { reason: 'Scenario complete; release the merge queue slot', previousWorkerStopped: true }, id());
}
// A proven candidate with Graphyard's queue tip published for it: merge
// authorization requires a published speculative tip, so delegation refusals are
// exercised against the same merge-ready state the broker really sees.
// Publication itself belongs to the merge-queue scenarios.
async function publish(work: Work, sha = head) {
  await queueHeadFor(work);
  const item = await engine.observe(work.id, (await reload(work)).revision, observation(work, sha));
  const speculation: QueueSpeculation = { ref: queueRef(item.key), tip: item.candidate!.sha, base: item.candidate!.baseSha,
    baseTree: 'e'.repeat(40), predecessors: [], policyRevision: item.policyRevision, publishedAt: new Date().toISOString() };
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{queue,speculation}',$2::jsonb) WHERE id=$1", [item.id, JSON.stringify(speculation)]);
  return engine.observe(item.id, (await reload(item)).revision, observation(item, sha));
}
async function proven(work: Work, sha = head) {
  const observed = await engine.observe(work.id, (await reload(work)).revision, observation(work, sha));
  return publish(await engine.execute(reviewer, 'evidence', observed.id, proof({ sha }), id()), sha);
}

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 10;
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-delegation-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('delegation_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/delegation_test`); await store.init();
  engine = new Engine(store); engine.principals = roster;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('unit:slice-model — formal slices are first-class objects with data-driven session kinds', () => {
  assert.deepEqual(slices.map(s => s.id), ['product', 'infrastructure', 'docs-experience']);
  assert.deepEqual([...sliceIds], slices.map(s => s.id));
  assert.deepEqual(slices.map(s => s.name), ['Product', 'Infrastructure', 'Docs/experience']);
  // Session kind is read from the credential, never inferred from a role.
  assert.equal(sessionKind(admin), 'human');
  assert.equal(sessionKind(lead), 'ai');
  assert.equal(sessionKind({ id: 'unlabelled', role: 'worker' } as Principal), 'undeclared');
  assert.equal(sessionKind(undefined), 'undeclared');
  const snapshot = delegationSnapshot(roster, [], Date.now());
  assert.deepEqual(snapshot.slices.map(s => s.id), ['product', 'infrastructure', 'docs-experience']);
  assert.deepEqual(snapshot.limits, defaultDelegationLimits);
  assert.deepEqual(snapshot.slices.find(s => s.id === 'product')!.lead, { id: 'product-lead', displayName: 'Pine', role: 'slice-lead', sessionKind: 'ai' });
  assert.deepEqual(snapshot.reviewers, [{ id: 'proof-runner', displayName: 'Rowan', role: 'producer', sessionKind: 'ai' }]);
  for (const slice of snapshot.slices) { assert.deepEqual(slice.workers, []); assert.deepEqual(slice.bottlenecks, []); }
  // Every rendered identity carries a kind, so an unlabelled session cannot read as human.
  const unlabelled = delegationSnapshot([{ id: 'ghost-lead', role: 'slice-lead', slice: 'product' } as Principal, { id: 'ghost-proof', role: 'producer' } as Principal], [], Date.now());
  assert.equal(unlabelled.slices.find(s => s.id === 'product')!.lead!.sessionKind, 'undeclared');
  assert.equal(unlabelled.reviewers[0].sessionKind, 'undeclared');
});

test('integration:slice-lead-principals — distinct AI lead credentials and server-enforced per-lead concurrency', async () => {
  const configured = [{ ...admin, token: 'o'.repeat(32) }, { ...lead, token: 'p'.repeat(32) }, { ...infraLead, token: 'i'.repeat(32) }, { ...docsLead, token: 'd'.repeat(32) }, { ...reviewer, token: 'r'.repeat(32) }];
  validateDelegationPrincipals(configured);
  assert.throws(() => validateDelegationPrincipals([...configured, { id: 'extra', role: 'slice-lead', slice: 'product', sessionKind: 'ai', token: 'e'.repeat(32) }]), /limit exceeded/);
  assert.throws(() => validateDelegationPrincipals([{ id: 'human-lead', role: 'slice-lead', slice: 'product', sessionKind: 'human' }, reviewer]), /AI sessions/);
  assert.throws(() => validateDelegationPrincipals([{ id: 'unsliced-lead', role: 'slice-lead', sessionKind: 'ai' }, reviewer]), /formal slice/);
  assert.throws(() => validateDelegationPrincipals([lead, { ...lead, id: 'second-product-lead' }, reviewer]), /product already has a lead/);
  // A shared bearer token is not a distinct credential.
  assert.throws(() => validateDelegationPrincipals([{ ...lead, token: 's'.repeat(32) }, { ...infraLead, token: 's'.repeat(32) }, { ...reviewer, token: 'r'.repeat(32) }]), /distinct principals and credentials/);
  // Concurrency is decided by the server from live leases, not asserted by a client.
  const items: Work[] = [];
  for (const name of ['concurrency-one', 'concurrency-two', 'concurrency-three']) {
    let item = await engine.execute(admin, 'create', null, input(name, 'product'), id());
    items.push(await engine.execute(admin, 'ready', item.id, {}, id()));
  }
  await engine.execute(workerA, 'claim', items[0].id, {}, id());
  await engine.execute(workerB, 'claim', items[1].id, {}, id());
  await assert.rejects(engine.execute(workerC, 'claim', items[2].id, {}, id()), /Engineer limit for product exceeded: 2\/2/);
  const snapshot = delegationSnapshot(roster, await store.list(), Date.now());
  const product = snapshot.slices.find(s => s.id === 'product')!;
  assert.deepEqual(product.workers.map(w => w.id).sort(), ['engineer-a', 'engineer-b']);
  assert.ok(product.workers.every(w => w.sessionKind === 'ai'));
  for (const item of items.slice(0, 2)) await engine.execute(item.id === items[0].id ? workerA : workerB, 'release', item.id, { epoch: 1 }, id());
  // Capacity counts engineers, not leases: one worker holding two items in the
  // slice is two worker rows but a single occupied seat under the lead.
  const seats: Work[] = [];
  for (const name of ['seat-one', 'seat-two', 'seat-three', 'seat-four']) {
    const created = await engine.execute(admin, 'create', null, input(name, 'docs-experience'), id());
    seats.push(await engine.execute(admin, 'ready', created.id, {}, id()));
  }
  await engine.execute(workerA, 'claim', seats[0].id, {}, id());
  await engine.execute(workerA, 'claim', seats[1].id, {}, id());
  const docs = delegationSnapshot(roster, await store.list(), Date.now()).slices.find(s => s.id === 'docs-experience')!;
  assert.deepEqual(docs.engineers.map(engineer => engineer.id), ['engineer-a']);
  assert.deepEqual(docs.workers.map(worker => worker.id), ['engineer-a', 'engineer-a']);
  assert.ok(docs.engineers.every(engineer => engineer.sessionKind === 'ai'));
  // A second distinct engineer still fits the two-seat default; a third is refused.
  await engine.execute(workerB, 'claim', seats[2].id, {}, id());
  await assert.rejects(engine.execute(workerC, 'claim', seats[3].id, {}, id()), /Engineer limit for docs-experience exceeded: 2\/2/);
  for (const [index, actor] of [workerA, workerA, workerB].entries())
    await engine.execute(actor, 'release', seats[index].id, { epoch: seats[index].epoch + 1 }, id());
});

test('unit:lead-authority-boundaries — coordination is permitted, implementation and proof are not', () => {
  for (const action of leadRulingActions) assert.equal(leadMay(action), true, action);
  assert.deepEqual([...leadPermittedActions], ['coordinate', ...leadRulingActions]);
  for (const action of ['create', 'claim', 'heartbeat', 'release', 'workspace', 'submit', 'blocked', 'evidence', 'ready', 'unblock', 'requirements', 'reviewpolicy', 'rereview', 'rework', 'settle', 'merge', 'implement'])
    assert.equal(leadMay(action), false, action);
  // Lead authority disqualifies an identity from producing evidence at all.
  const work = { id: 'w', key: 'GY-7', slice: 'product', workspaces: [], lease: null } as unknown as Work;
  assert.match(producerIndependenceRefusal({ ...lead, role: 'producer', proofs: ['unit:works'] }, work, roster)!, /slice-lead authority/);
  assert.match(producerIndependenceRefusal({ id: 'product-proofs', role: 'producer', slice: 'product', proofs: ['unit:works'] }, work, [])!, /independent of that slice/);
  assert.equal(producerIndependenceRefusal(reviewer, work, roster), null);
});

test('integration:lead-enforcement — violating lead actions are refused server-side and recorded', async () => {
  let item = await engine.execute(admin, 'create', null, input('lead-enforcement', 'product'), id());
  item = await engine.execute(admin, 'ready', item.id, {}, id());
  for (const [command, body] of [['claim', {}], ['evidence', proof()], ['ready', {}], ['submit', { epoch: 1, pr: 1 }],
    ['requirements', { expectedPolicyRevision: 1, reason: 'lead rewrite', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], dependencies: [], plannedFiles: [], exclusiveResources: [] }]] as const)
    await assert.rejects(engine.execute(lead, command as never, item.id, body, id()), /Slice leads cannot perform lifecycle mutations/, command);
  await assert.rejects(engine.requestEnqueue(lead, item.id, { enqueue: true, expectedRevision: item.revision, sha: head, baseSha: base, policyRevision: 1 }, id()), /Coordinator permission/);
  // A lead identity that also holds producer credentials cannot self-prove its slice.
  const leadProducer: Principal = { ...lead, role: 'producer', proofs: ['unit:works'] };
  await assert.rejects(engine.execute(leadProducer, 'evidence', item.id, proof(), id()), /slice-lead authority/);
  // Nor can a producer bound to the item's slice.
  await assert.rejects(engine.execute({ id: 'product-proofs', role: 'producer', slice: 'product', proofs: ['unit:works'] }, 'evidence', item.id, proof(), id()), /independent of that slice/);
  // Over HTTP the refusal is recorded against the item it targeted.
  const response = await fetch(`${url}/api/work/${item.id}/claim`, { method: 'POST',
    headers: { Authorization: `Bearer ${credentials.find(c => c.id === lead.id)!.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': id() }, body: '{}' });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /Slice leads cannot perform lifecycle mutations/);
  const refusal = (await store.events(item.id)).find(event => event.kind === 'lead.action.refused');
  assert.equal(refusal.actor, lead.id);
  assert.equal(refusal.payload.attemptedAction, 'claim');
  assert.equal(refusal.payload.slice, 'product');
  assert.equal(refusal.payload.targetKey, item.key);
  assert.equal(refusal.payload.targetSlice, 'product');
  assert.equal((await reload(item)).lease, null);
  // A forbidden request aimed at another slice is still recorded, but the target
  // slice's own ledger and aggregate stay untouched.
  const foreign = await engine.execute(admin, 'create', null, input('lead-enforcement-foreign', 'infrastructure'), id());
  const ledgerBefore = (await store.events(foreign.id)).length;
  const crossed = await fetch(`${url}/api/work/${foreign.id}/claim`, { method: 'POST',
    headers: { Authorization: `Bearer ${credentials.find(c => c.id === lead.id)!.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': id() }, body: '{}' });
  assert.equal(crossed.status, 403);
  assert.equal((await store.events(foreign.id)).length, ledgerBefore, 'a lead cannot append to another slice ledger');
  assert.equal((await reload(foreign)).revision, foreign.revision);
  const unscoped = (await store.events()).find(event => event.kind === 'lead.action.refused' && event.payload.targetKey === foreign.key);
  assert.equal(unscoped.work_id, null, 'the attempt is history, not a mutation of the target item');
  assert.equal(unscoped.actor, lead.id);
  assert.equal(unscoped.payload.attemptedAction, 'claim');
  assert.equal(unscoped.payload.slice, 'product');
  assert.equal(unscoped.payload.targetSlice, 'infrastructure');
  assert.match(unscoped.payload.reason, /targets another slice/);
  // The merge route matches above the generic work route. Routing order decides
  // which handler answers a forbidden request; it must never decide whether the
  // attempt reaches the ledger, so each one records its own refusal.
  const asLead = (path: string, payload: unknown) => fetch(`${url}${path}`, { method: 'POST',
    headers: { Authorization: `Bearer ${credentials.find(c => c.id === lead.id)!.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': id() }, body: JSON.stringify(payload) });
  for (const [route, payload] of [
    ['merge-acquire', { enqueue: true, expectedRevision: item.revision, sha: head, baseSha: base, policyRevision: 1 }],
  ] as const) {
    const refused = await asLead(`/api/work/${item.id}/${route}`, payload);
    assert.equal(refused.status, 403, route);
    assert.match((await refused.json()).error, /Slice leads cannot perform lifecycle mutations/, route);
    const recorded = (await store.events(item.id)).filter(event => event.kind === 'lead.action.refused' && event.payload.attemptedAction === route);
    assert.equal(recorded.length, 1, `${route} is refused and recorded exactly once`);
    assert.equal(recorded[0].actor, lead.id);
    assert.equal(recorded[0].payload.slice, 'product');
    assert.equal(recorded[0].payload.targetKey, item.key);
    assert.equal(recorded[0].payload.targetSlice, 'product');
  }
  assert.equal((await reload(item)).mergeExecution ?? null, null, 'no refused merge call left execution state behind');
  // Creating work names no existing item, so there is no ledger to append to.
  // The attempt is still history: it is recorded unscoped, with a null target.
  const creation = await asLead('/api/work', input('lead-creates-work', 'product'));
  assert.equal(creation.status, 403);
  assert.match((await creation.json()).error, /Slice leads cannot perform lifecycle mutations/);
  assert.equal((await store.list()).some(work => work.title === 'lead-creates-work'), false, 'the refused creation never reaches the backlog');
  const attempted = (await store.events()).filter(event => event.kind === 'lead.action.refused' && event.payload.attemptedAction === 'create');
  assert.equal(attempted.length, 1);
  assert.equal(attempted[0].work_id, null, 'a creation refusal belongs to no work item ledger');
  assert.equal(attempted[0].actor, lead.id);
  assert.equal(attempted[0].payload.slice, 'product');
  assert.equal(attempted[0].payload.targetKey, null);
  assert.equal(attempted[0].payload.targetSlice, null);
  assert.match(attempted[0].payload.reason, /exceeds slice-lead authority/);

  // A blocking ruling is durable delivery state, not advice: it revokes merge
  // authorization in its own transaction and the broker refuses independently.
  let ready = await candidate(workerA, 'lead-blocks-delivery', 'product');
  ready = await proven(ready);
  assert.equal(ready.stage, 'merge');
  assert.ok(ready.mergeAuthorization);
  const observedAt = ready.observation!.at;
  assert.deepEqual(currentMergeCandidates([ready], observedAt).map(w => w.key), [ready.key]);
  const sentBack = (await recordLeadRuling(store, lead, ready.id, { action: 'send-back', ruleId: 'rules/plan-v1#coverage', reason: 'Negative coverage is missing' }, id())).work;
  assert.equal(sentBack.leadHold!.action, 'send-back');
  assert.equal(sentBack.leadHold!.ruleId, 'rules/plan-v1#coverage');
  assert.equal(sentBack.leadHold!.leadId, lead.id);
  assert.equal(sentBack.leadHold!.slice, 'product');
  assert.equal(sentBack.mergeAuthorization, null, 'the ruling transaction revokes merge authorization');
  assert.equal(sentBack.gates.find(gate => gate.name === 'merge')!.passed, false);
  assert.match(sentBack.gates.find(gate => gate.name === 'merge')!.reasons.join(' '), /delivery is blocked until the authorized recovery/);
  assert.deepEqual(currentMergeCandidates([sentBack], observedAt), [], 'the guarded broker cannot select a sent-back item');
  assert.throws(() => assertMergeCandidate(sentBack, observedAt), /all-gates-passing merge authorization/);
  assert.equal((await reload(ready)).mergeAuthorization, null);
  // Re-evaluation never quietly reissues authorization while the hold stands.
  let held = await reload(ready);
  held = await engine.observe(ready.id, held.revision, observation(held));
  assert.equal(held.mergeAuthorization, null);
  assert.equal(held.leadHold!.action, 'send-back');
  await engine.reconcile();
  held = await reload(ready);
  assert.equal(held.mergeAuthorization, null);
  assert.equal(held.leadHold!.action, 'send-back');
  // No further ruling clears a send-back, and the broker refuses to acquire past it.
  for (const action of ['approve-plan', 'classify-failure', 'request-rerun'] as const)
    await recordLeadRuling(store, lead, ready.id, { action, ruleId: 'rules/plan-v1#retry', reason: `Attempted ${action}` }, id());
  held = await reload(ready);
  assert.equal(held.leadHold!.action, 'send-back', 'only the operator rework lifecycle clears a send-back');
  await assert.rejects(engine.requestEnqueue(coordinator, ready.id, { enqueue: true, expectedRevision: held.revision, sha: head, baseSha: base, policyRevision: 1 }, id()), /Merge authorization is no longer current/);
  await assert.rejects(engine.execute(lead, 'rework', ready.id, { reason: 'Clearing my own hold', previousWorkerStopped: true }, id()), /Slice leads cannot perform lifecycle mutations/);
  // The held item is reported as a slice bottleneck naming the ruling.
  const blocked = delegationSnapshot(roster, await store.list(), Date.now()).slices.find(s => s.id === 'product')!;
  assert.match(blocked.bottlenecks.find(bottleneck => bottleneck.key === held.key)!.reason, /delivery is blocked until the authorized recovery/);
  // The authorized recovery reopens implementation; delivery becomes selectable
  // again only after the redone work is observed.
  held = await engine.execute(admin, 'rework', ready.id, { reason: 'Send-back accepted; reopening implementation', previousWorkerStopped: true }, id());
  assert.equal(held.leadHold ?? null, null);
  assert.equal(held.gates.find(gate => gate.name === 'build')!.passed, false);
  assert.equal(held.mergeAuthorization, null);
  held = await engine.execute(workerA, 'claim', ready.id, {}, id());
  held = await engine.execute(workerA, 'workspace', ready.id, { epoch: held.epoch, host: 'delegation-host', path: `/tmp/delegation/${ready.id}-redo`, branch: held.workspaces[0].branch }, id());
  held = await engine.execute(workerA, 'submit', ready.id, { epoch: held.epoch, pr: held.submission!.pr }, id());
  // The redone implementation is a new commit, and it is proved afresh: a
  // candidate ejected from the merge queue never re-enters on the same head.
  held = await proven(held, redone);
  assert.equal(held.stage, 'merge');
  assert.ok(held.mergeAuthorization, 'authorization is reissued only after the authorized recovery');
  assert.deepEqual(currentMergeCandidates([held], held.observation!.at).map(w => w.key), [held.key]);
  assert.equal(held.lease, null, 'resubmission ended the rework lease');

  // A plan rejection blocks the same way and is superseded by the lead's own
  // approval of the revised plan, which is the one lead-side recovery.
  let planned = await candidate(workerB, 'lead-plan-rejection', 'product');
  planned = await proven(planned);
  assert.ok(planned.mergeAuthorization);
  planned = (await recordLeadRuling(store, lead, planned.id, { action: 'reject-plan', ruleId: 'rules/plan-v1#scope', reason: 'Plan exceeds the written scope' }, id())).work;
  assert.equal(planned.leadHold!.action, 'reject-plan');
  assert.equal(planned.mergeAuthorization, null);
  assert.deepEqual(currentMergeCandidates([planned], planned.observation!.at), []);
  // A replacement lead for the same slice cannot take ownership of or clear
  // the originating lead's rejection, including by issuing an equal-rank hold.
  planned = (await recordLeadRuling(store, replacementProductLead, planned.id, { action: 'reject-plan', ruleId: 'rules/plan-v1#replacement', reason: 'Replacement lead review' }, id())).work;
  assert.equal(planned.leadHold!.leadId, lead.id);
  planned = (await recordLeadRuling(store, replacementProductLead, planned.id, { action: 'approve-plan', ruleId: 'rules/plan-v1#approval', reason: 'Replacement lead approves' }, id())).work;
  assert.equal(planned.leadHold!.leadId, lead.id);
  // Operator rework is mapped only to send-back and cannot bypass the lead's
  // retained authority over a reject-plan hold.
  planned = await engine.execute(admin, 'rework', planned.id, { reason: 'Implementation redo does not approve the plan', previousWorkerStopped: true }, id());
  assert.equal(planned.leadHold!.action, 'reject-plan');
  assert.equal(planned.leadHold!.leadId, lead.id);
  planned = (await recordLeadRuling(store, lead, planned.id, { action: 'approve-plan', ruleId: 'rules/plan-v1#approval', reason: 'Revised plan is inside scope', supersedes: planned.leadHold!.rulingId }, id())).work;
  assert.equal(planned.leadHold ?? null, null);
  assert.equal(planned.gates.find(gate => gate.name === 'build')!.passed, false, 'plan approval does not revive the previous implementation attempt');
  assert.equal(planned.mergeAuthorization, null);
  planned = await engine.execute(workerB, 'claim', planned.id, {}, id());
  planned = await engine.execute(workerB, 'workspace', planned.id, { epoch: planned.epoch, host: 'delegation-host', path: `/tmp/delegation/${planned.id}-revised-plan`, branch: planned.workspaces[0].branch }, id());
  planned = await engine.execute(workerB, 'submit', planned.id, { epoch: planned.epoch, pr: planned.submission!.pr }, id());
  // The revised implementation is a new commit, proved afresh, because reopening
  // implementation ejected the previous head from the merge queue.
  planned = await proven(planned, redone);
  assert.ok(planned.mergeAuthorization, 'authorization returns only through a full gate evaluation');
  assert.deepEqual(currentMergeCandidates([planned], planned.observation!.at).map(w => w.key), [planned.key]);
  assert.equal(planned.lease, null, 'resubmission ended the rework lease');

  // Holds are ranked and never weakened: a send-back raised over a plan rejection
  // survives both a later rejection and a later approval.
  const ranked = await engine.execute(admin, 'create', null, input('lead-hold-rank', 'product'), id());
  const rule = { ruleId: 'rules/plan-v1#scope', reason: 'Scope ruling' };
  assert.equal((await recordLeadRuling(store, lead, ranked.id, { action: 'reject-plan', ...rule }, id())).work.leadHold!.action, 'reject-plan');
  assert.equal((await recordLeadRuling(store, lead, ranked.id, { action: 'send-back', ...rule }, id())).work.leadHold!.action, 'send-back');
  assert.equal((await recordLeadRuling(store, lead, ranked.id, { action: 'reject-plan', ...rule }, id())).work.leadHold!.action, 'send-back');
  assert.equal((await recordLeadRuling(store, lead, ranked.id, { action: 'approve-plan', ...rule }, id())).work.leadHold!.action, 'send-back');
  assert.equal((await reload(ranked)).leadHold!.action, 'send-back');

  // An approval clears only the rejection it names. A delayed approval prepared
  // against an earlier rejection cannot clear a newer one it never saw, and an
  // unbound approval never lets a standing rejection fall away silently.
  const bound = await engine.execute(admin, 'create', null, input('lead-hold-binding', 'product'), id());
  const first = (await recordLeadRuling(store, lead, bound.id, { action: 'reject-plan', ...rule }, id())).work.leadHold!.rulingId;
  assert.equal((await recordLeadRuling(store, lead, bound.id, { action: 'approve-plan', ...rule, supersedes: first }, id())).work.leadHold ?? null, null);
  const second = (await recordLeadRuling(store, lead, bound.id, { action: 'reject-plan', ...rule }, id())).work.leadHold!.rulingId;
  assert.notEqual(second, first);
  await assert.rejects(recordLeadRuling(store, lead, bound.id, { action: 'approve-plan', ...rule, supersedes: first }, id()), new RegExp(`Standing plan rejection is ruling ${second}`));
  await assert.rejects(recordLeadRuling(store, lead, bound.id, { action: 'approve-plan', ...rule }, id()), /must name the ruling it supersedes/);
  await assert.rejects(recordLeadRuling(store, lead, bound.id, { action: 'approve-plan', ...rule, supersedes: randomUUID() }, id()), new RegExp(`Standing plan rejection is ruling ${second}`));
  assert.equal((await reload(bound)).leadHold!.rulingId, second, 'a refused approval leaves the standing rejection untouched');
  // Only naming the standing rejection clears it, and only for its own lead.
  await assert.rejects(recordLeadRuling(store, replacementProductLead, bound.id, { action: 'approve-plan', ...rule, supersedes: second }, id()), /No plan rejection of this lead stands to supersede/);
  assert.equal((await recordLeadRuling(store, lead, bound.id, { action: 'approve-plan', ...rule, supersedes: second }, id())).work.leadHold ?? null, null);
  // Only an approval supersedes a rejection, and any ruling may pin the revision it read.
  await assert.rejects(recordLeadRuling(store, lead, bound.id, { action: 'send-back', ...rule, supersedes: second }, id()), /Only an approve-plan ruling supersedes a standing plan rejection/);
  await assert.rejects(recordLeadRuling(store, lead, bound.id, { action: 'classify-failure', ...rule, expectedRevision: 1 }, id()), /Task revision changed; reload before ruling/);
});

test('integration:ownership-and-delivery-invariants — Graphyard owns leases, worktrees, and the only merge path', async () => {
  let item = await engine.execute(admin, 'create', null, input('ownership', 'infrastructure'), id());
  item = await engine.execute(admin, 'ready', item.id, {}, id());
  item = await engine.execute(workerA, 'claim', item.id, {}, id());
  // Exactly one owner, and only the current epoch acts.
  await assert.rejects(engine.execute(workerB, 'claim', item.id, {}, id()), /already has an active owner/);
  await assert.rejects(engine.execute(workerA, 'heartbeat', item.id, { epoch: item.epoch + 1 }, id()), /superseded/);
  const workspace = { epoch: item.epoch, host: 'ownership-host', path: '/tmp/delegation/ownership', branch: 'graphyard/ownership' };
  item = await engine.execute(workerA, 'workspace', item.id, workspace, id());
  // Exactly one registered worktree per assignment, exclusive across the fleet.
  await assert.rejects(engine.execute(workerA, 'workspace', item.id, { ...workspace, path: '/tmp/delegation/second', branch: 'graphyard/ownership-second' }, id()), /already has a workspace/);
  let other = await engine.execute(admin, 'create', null, input('ownership-peer', 'infrastructure'), id());
  other = await engine.execute(admin, 'ready', other.id, {}, id());
  other = await engine.execute(workerB, 'claim', other.id, {}, id());
  await assert.rejects(engine.execute(workerB, 'workspace', other.id, { ...workspace, epoch: other.epoch }, id()), /reserved or overlaps/);
  item = await engine.execute(workerA, 'submit', item.id, { epoch: item.epoch, pr: ++pr }, id());
  item = await engine.observe(item.id, item.revision, observation(item));
  // Delivery stays behind the guarded broker: gates refuse, and only a coordinator may acquire.
  assert.equal(item.gates.find(gate => gate.name === 'acceptance')!.passed, false);
  await assert.rejects(engine.requestEnqueue(workerA, item.id, { enqueue: true, expectedRevision: item.revision, sha: head, baseSha: base, policyRevision: 1 }, id()), /Coordinator permission/);
  await assert.rejects(engine.requestEnqueue(coordinator, item.id, { enqueue: true, expectedRevision: item.revision, sha: head, baseSha: base, policyRevision: 1 }, id()), /authorization/i);
  // Control-plane truth never depends on the session runtime.
  for (const module of ['model.ts', 'engine.ts', 'store.ts', 'delegation.ts', 'server.ts'])
    assert.doesNotMatch(await readFile(new URL(`../src/${module}`, import.meta.url), 'utf8'), /herdr/i, module);
  assert.equal(item.lease, null, 'submission ended the lease');
  await engine.execute(workerB, 'release', other.id, { epoch: other.epoch }, id());

  // The binding is per claimed item, not per worker: one engineer may hold more
  // than one item in a slice, each bound to exactly that engineer and exactly one
  // registered worktree, while occupying a single seat under the slice lead.
  const token = credentials.find(c => c.id === workerA.id)!.token;
  const held: Work[] = [];
  for (const name of ['seat-first', 'seat-second']) {
    const created = await engine.execute(admin, 'create', null, input(name, 'infrastructure'), id());
    held.push(await engine.execute(admin, 'ready', created.id, {}, id()));
  }
  held[0] = await engine.execute(workerA, 'claim', held[0].id, {}, id());
  // The second claim by the same engineer is accepted by the server, not merely by a client.
  const second = await fetch(`${url}/api/work/${held[1].id}/claim`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': id() }, body: '{}' });
  assert.equal(second.status, 200, await second.text());
  held[1] = await reload(held[1]);
  for (const work of held) {
    assert.equal(work.lease!.owner, workerA.id);
    assert.equal(work.lastAssignment!.owner, workerA.id);
    assert.deepEqual(implementerIdentities(work), [workerA.id]);
  }
  assert.deepEqual([...activeEngineers(await store.list(), 'infrastructure', Date.now())], [workerA.id], 'two claimed items, one seat');
  const infrastructure = delegationSnapshot(roster, await store.list(), Date.now()).slices.find(s => s.id === 'infrastructure')!;
  assert.deepEqual(infrastructure.engineers.map(engineer => engineer.id), [workerA.id]);
  assert.deepEqual(infrastructure.workers.map(worker => [worker.key, worker.id]), held.map(work => [work.key, workerA.id]));
  // Each item still gets exactly one worktree of its own: the same engineer cannot
  // point a second item at the worktree already registered for the first.
  const first = { epoch: held[0].epoch, host: 'ownership-host', path: '/tmp/delegation/seat-first', branch: 'graphyard/seat-first' };
  held[0] = await engine.execute(workerA, 'workspace', held[0].id, first, id());
  await assert.rejects(engine.execute(workerA, 'workspace', held[1].id, { ...first, epoch: held[1].epoch }, id()), /reserved or overlaps/);
  await assert.rejects(engine.execute(workerA, 'workspace', held[1].id, { ...first, epoch: held[1].epoch, path: '/tmp/delegation/seat-first/nested', branch: 'graphyard/seat-second' }, id()), /reserved or overlaps/);
  held[1] = await engine.execute(workerA, 'workspace', held[1].id, { epoch: held[1].epoch, host: 'ownership-host', path: '/tmp/delegation/seat-second', branch: 'graphyard/seat-second' }, id());
  for (const work of held) {
    assert.equal(work.workspaces.length, 1);
    assert.equal(work.workspaces[0].owner, workerA.id);
    assert.equal(work.workspaces[0].epoch, work.epoch);
  }
  // Only the item's own assignment renews its lease: a peer worker, the wrong
  // epoch, and the engineer's other item are all refused.
  await assert.rejects(engine.execute(workerB, 'heartbeat', held[0].id, { epoch: held[0].epoch }, id()), /superseded/);
  await assert.rejects(engine.execute(workerA, 'heartbeat', held[0].id, { epoch: held[1].epoch + 1 }, id()), /superseded/);
  for (const work of held) await engine.execute(workerA, 'release', work.id, { epoch: work.epoch }, id());

  // Watch supervision is what keeps an assignment alive: an assignment whose
  // supervisor stops renewing loses ownership on the server's clock, the loss is
  // recorded as an escalation no worker can clear, and the item is reassignable.
  const brief = new Engine(store, [15368], 0); brief.principals = roster;
  let unattended = await engine.execute(admin, 'create', null, input('ownership-unattended', 'infrastructure'), id());
  unattended = await engine.execute(admin, 'ready', unattended.id, {}, id());
  unattended = await brief.execute(workerA, 'claim', unattended.id, {}, id());
  await assert.rejects(engine.execute(workerA, 'heartbeat', unattended.id, { epoch: unattended.epoch }, id()), /expired/);
  await brief.reconcile();
  unattended = await reload(unattended);
  assert.equal(unattended.lease, null);
  assert.deepEqual(standingEscalations(unattended).map(entry => entry.trigger), ['lease-loss']);
  assert.deepEqual(unattended.lastAssignment && { owner: unattended.lastAssignment.owner, epoch: unattended.lastAssignment.epoch }, { owner: workerA.id, epoch: 1 });
  await assert.rejects(engine.execute(workerA, 'resolve', unattended.id, { trigger: 'lease-loss', reason: 'I am back', expectedRevision: unattended.revision }, id()), /Operator permission required/);
  unattended = await engine.execute(workerB, 'claim', unattended.id, {}, id());
  assert.equal(unattended.lease!.owner, workerB.id);
  assert.equal(unattended.epoch, 2);
  assert.deepEqual(implementerIdentities(unattended), [workerA.id, workerB.id]);
  await engine.execute(workerB, 'release', unattended.id, { epoch: unattended.epoch }, id());
});

test('integration:exact-candidate-validation — trusted evidence binds the exact candidate and an independent producer', async () => {
  let item = await candidate(workerA, 'exact-candidate', 'docs-experience');
  const acceptance = (work: Work) => work.gates.find(gate => gate.name === 'acceptance')!.passed;
  // Same proof, wrong candidate or policy: never acceptance evidence.
  for (const mismatch of [{ sha: 'c'.repeat(40) }, { baseSha: 'd'.repeat(40) }, { policyRevision: 2 }, { executed: 0 }, { skipped: 1 }, { result: 'fail' }]) {
    item = await engine.execute(reviewer, 'evidence', item.id, proof(mismatch), id());
    assert.equal(acceptance(item), false, JSON.stringify(mismatch));
  }
  // The implementer holding producer credentials is refused, in this epoch and after rework.
  await assert.rejects(engine.execute({ ...workerA, role: 'producer', proofs: ['unit:works'] }, 'evidence', item.id, proof(), id()), /distinct from its implementers/);
  assert.deepEqual(implementerIdentities(item), ['engineer-a']);
  item = await engine.execute(admin, 'rework', item.id, { reason: 'Reassigned to a second engineer', previousWorkerStopped: true }, id());
  item = await engine.execute(workerB, 'claim', item.id, {}, id());
  item = await engine.execute(workerB, 'workspace', item.id, { epoch: item.epoch, host: 'delegation-host', path: `/tmp/delegation/${item.id}-rework`, branch: item.workspaces[0].branch }, id());
  item = await engine.execute(workerB, 'submit', item.id, { epoch: item.epoch, pr: item.submission!.pr }, id());
  assert.deepEqual(implementerIdentities(item).sort(), ['engineer-a', 'engineer-b']);
  // A prior epoch's implementer remains disqualified even though it is no longer the current assignment.
  await assert.rejects(engine.execute({ ...workerA, role: 'producer', proofs: ['unit:works'] }, 'evidence', item.id, proof(), id()), /distinct from its implementers/);
  await assert.rejects(engine.execute({ ...workerB, role: 'producer', proofs: ['unit:works'] }, 'evidence', item.id, proof(), id()), /distinct from its implementers/);
  item = await engine.observe(item.id, item.revision, observation(item));
  item = await engine.execute(reviewer, 'evidence', item.id, proof(), id());
  const accepted = item.evidence.at(-1)!;
  assert.equal(accepted.trusted, true);
  assert.equal(accepted.producer, reviewer.id);
  assert.ok(!implementerIdentities(item).includes(accepted.producer));
  assert.equal(accepted.sha, item.candidate!.sha);
  assert.equal(accepted.baseSha, item.candidate!.baseSha);
  assert.equal(accepted.policyRevision, item.policyRevision);
  assert.ok(accepted.executed > 0 && accepted.skipped === 0);
  assert.equal(acceptance(item), true);
  assert.equal(item.lease, null, 'resubmission ended the rework lease');
  // Over HTTP, a producer credential co-located with an implementation session is
  // refused and the attempt is recorded rather than silently downgraded.
  let coLocated = await engine.execute(admin, 'create', null, input('co-located-producer', 'docs-experience'), id());
  coLocated = await engine.execute(admin, 'ready', coLocated.id, {}, id());
  coLocated = await engine.execute({ id: reviewer.id, role: 'worker' }, 'claim', coLocated.id, {}, id());
  const response = await fetch(`${url}/api/work/${coLocated.id}/evidence`, { method: 'POST',
    headers: { Authorization: `Bearer ${credentials.find(c => c.id === reviewer.id)!.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': id() },
    body: JSON.stringify(proof()) });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /distinct from its implementers/);
  const recorded = (await store.events(coLocated.id)).find(event => event.kind === 'evidence.producer.refused');
  assert.equal(recorded.actor, reviewer.id);
  assert.equal(recorded.payload.proof, 'unit:works');
  assert.match(recorded.payload.reason, /distinct from its implementers/);
  assert.deepEqual((await reload(coLocated)).evidence, []);
  await engine.execute({ id: reviewer.id, role: 'worker' }, 'release', coLocated.id, { epoch: coLocated.epoch }, id());

  // Independence is a standing property, re-decided on every evaluation: trusted
  // evidence stops being applicable the moment its producer joins the append-only
  // implementer set, and the recorded evidence row itself is never rewritten.
  let revoked = await candidate(workerC, 'independence-revoked', 'infrastructure');
  revoked = await proven(revoked);
  assert.equal(acceptance(revoked), true);
  assert.ok(revoked.mergeAuthorization);
  assert.deepEqual(currentMergeCandidates([revoked], revoked.observation!.at).map(w => w.key), [revoked.key]);
  const evidenceBefore = structuredClone(revoked.evidence);
  const producerWorker: Principal = { id: reviewer.id, role: 'worker' };
  revoked = await engine.execute(admin, 'rework', revoked.id, { reason: 'Producer takes over the implementation', previousWorkerStopped: true }, id());
  revoked = await engine.execute(producerWorker, 'claim', revoked.id, {}, id());
  assert.ok(implementerIdentities(revoked).includes(reviewer.id));
  assert.equal(acceptance(revoked), false, 'acceptance recomputes independence against the current implementer set');
  assert.match(revoked.gates.find(gate => gate.name === 'acceptance')!.reasons.join(' '), new RegExp(`Trusted unit:works evidence from ${reviewer.id} is no longer independent`));
  assert.equal(revoked.mergeAuthorization, null, 'merge authorization is revoked by the same evaluation');
  assert.deepEqual(revoked.evidence, evidenceBefore, 'history is recomputed against, never mutated');
  // Resubmitting the unchanged candidate does not revive the superseded evidence.
  revoked = await engine.execute(producerWorker, 'workspace', revoked.id, { epoch: revoked.epoch, host: 'delegation-host', path: `/tmp/delegation/${revoked.id}-producer`, branch: revoked.workspaces[0].branch }, id());
  revoked = await engine.execute(producerWorker, 'submit', revoked.id, { epoch: revoked.epoch, pr: revoked.submission!.pr }, id());
  revoked = await engine.observe(revoked.id, revoked.revision, observation(revoked));
  assert.equal(revoked.candidate!.sha, head, 'the candidate head is unchanged');
  assert.equal(acceptance(revoked), false);
  assert.equal(revoked.mergeAuthorization, null);
  assert.notEqual(revoked.stage, 'merge');
  assert.deepEqual(currentMergeCandidates([revoked], revoked.observation!.at), [], 'the guarded broker refuses it independently');
  assert.throws(() => assertMergeCandidate(revoked, revoked.observation!.at), /all-gates-passing merge authorization/);
  // Re-proving it requires a producer still independent of every implementer.
  await assert.rejects(engine.execute({ ...reviewer, role: 'producer', proofs: ['unit:works'] }, 'evidence', revoked.id, proof(), id()), /distinct from its implementers/);
  revoked = await engine.execute({ id: 'second-proof-runner', role: 'producer', proofs: ['unit:works'], sessionKind: 'ai' }, 'evidence', revoked.id, proof(), id());
  assert.equal(revoked.candidate!.sha, head, 'the candidate head is still unchanged');
  assert.equal(acceptance(revoked), true, 'a still-independent producer restores acceptance without any new commit');
  assert.equal(revoked.gates.find(gate => gate.name === 'acceptance')!.reasons.join(' '), '');
  // Delivery itself waits for a new candidate: reopening implementation ejected
  // this head from the merge queue, and an ejected head never re-enters.
  assert.match(revoked.gates.find(gate => gate.name === 'merge')!.reasons.join(' '), /Ejected from the merge queue/);
  assert.deepEqual(currentMergeCandidates([revoked], revoked.observation!.at), []);
  assert.equal(revoked.lease, null, 'resubmission ended the rework lease');
});

test('unit:intake-classification — routine and human-only origins are explicitly separated', () => {
  for (const origin of routineIntakeOrigins) assert.equal(classifyIntake(origin), 'routine', origin);
  for (const origin of humanOnlyIntakeOrigins) assert.equal(classifyIntake(origin), 'human-only', origin);
  assert.deepEqual([...routineIntakeOrigins], ['explicit-feedback', 'defect', 'unfinished-dependency', 'verification-finding']);
  for (const origin of ['goal', 'priority', 'policy-change', 'requirement-change', 'evidence-definition-change', 'waiver', 'exceptional-promotion', 'destructive-promotion', 'ambiguity-resolution'])
    assert.ok(humanOnlyIntakeOrigins.includes(origin as typeof humanOnlyIntakeOrigins[number]), origin);
  assert.equal(classifyIntake('invented-origin'), 'unknown');
});

test('integration:intake-authority-routing — routine intake is autonomous, human-only intake is refused for AI', async () => {
  for (const origin of routineIntakeOrigins) {
    const item = await recordIntake(store, lead, { origin, title: `Routine ${origin}`, description: 'Observed during delivery' }, id());
    assert.equal(item.state, 'backlog');
    assert.equal(item.submittedBy, lead.id);
  }
  for (const origin of humanOnlyIntakeOrigins)
    await assert.rejects(recordIntake(store, lead, { origin, title: `AI ${origin}`, description: '' }, id()), new RegExp(`${origin} intake is human-only`));
  for (const origin of humanOnlyIntakeOrigins) {
    const item = await recordIntake(store, admin, { origin, title: `Human ${origin}`, description: '' }, id());
    assert.equal(item.state, 'backlog');
  }
  // The admin role alone is not a human operator: a human-only origin requires a
  // declared human session, so an AI-declared or unlabelled admin is refused.
  for (const origin of humanOnlyIntakeOrigins) {
    await assert.rejects(recordIntake(store, aiAdmin, { origin, title: `AI admin ${origin}`, description: '' }, id()),
      new RegExp(`${origin} intake requires a declared human session; automation-admin is ai`));
    await assert.rejects(recordIntake(store, undeclaredAdmin, { origin, title: `Undeclared admin ${origin}`, description: '' }, id()),
      new RegExp(`${origin} intake requires a declared human session; legacy-admin is undeclared`));
  }
  assert.equal((await store.pool.query('SELECT 1 FROM intake_items WHERE title LIKE $1', ['AI admin %'])).rowCount, 0);
  assert.equal((await store.pool.query('SELECT 1 FROM intake_items WHERE title LIKE $1', ['Undeclared admin %'])).rowCount, 0);
  assert.equal((await store.events()).filter(event => event.kind === 'intake.created' && /^(AI|Undeclared) admin /.test(event.payload.intake.title)).length, 0);
  // Routine intake is untouched for those same credentials, so existing operator
  // automation and the single-agent bootstrap path keep working unchanged.
  for (const actor of [aiAdmin, undeclaredAdmin]) {
    const routine = await recordIntake(store, actor, { origin: 'verification-finding', title: `Routine from ${actor.id}`, description: '' }, id());
    assert.equal(routine.state, 'backlog');
    assert.equal(routine.submittedBy, actor.id);
  }
  // Over HTTP a real AI-declared admin credential is refused the same way.
  const aiIntake = await fetch(`${url}/api/intake`, { method: 'POST',
    headers: { Authorization: `Bearer ${credentials.find(c => c.id === aiAdmin.id)!.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': id() },
    body: JSON.stringify({ origin: 'waiver', title: 'AI waiver over HTTP', description: '' }) });
  assert.equal(aiIntake.status, 403);
  assert.match((await aiIntake.json()).error, /waiver intake requires a declared human session/);
  const humanIntake = await fetch(`${url}/api/intake`, { method: 'POST',
    headers: { Authorization: `Bearer ${credentials.find(c => c.id === admin.id)!.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': id() },
    body: JSON.stringify({ origin: 'waiver', title: 'Human waiver over HTTP', description: '' }) });
  assert.equal(humanIntake.status, 200);
  assert.equal((await humanIntake.json()).origin, 'waiver');
  await assert.rejects(recordIntake(store, workerA, { origin: 'defect', title: 'Worker intake', description: '' }, id()), /Intake permission required/);
  await assert.rejects(recordIntake(store, reviewer, { origin: 'defect', title: 'Producer intake', description: '' }, id()), /Intake permission required/);
  const rows = await store.pool.query('SELECT origin FROM intake_items');
  assert.ok(rows.rowCount! >= routineIntakeOrigins.length + humanOnlyIntakeOrigins.length);
  // A retried intake is the same intake: immutable backlog entries and their
  // history must not be duplicated by a lost response.
  const intakeKey = id(), intakeBody = { origin: 'defect', title: 'Retried defect', description: 'Observed twice' } as const;
  const countIntake = async () => (await store.pool.query('SELECT 1 FROM intake_items WHERE title=$1', [intakeBody.title])).rowCount;
  const created = await recordIntake(store, lead, intakeBody, intakeKey);
  const replayed = await recordIntake(store, lead, intakeBody, intakeKey);
  assert.equal(replayed.id, created.id);
  assert.equal(await countIntake(), 1);
  assert.equal((await store.events()).filter(event => event.kind === 'intake.created' && event.payload.intake.id === created.id).length, 1);
  await assert.rejects(recordIntake(store, lead, { ...intakeBody, description: 'Changed' }, intakeKey), /Idempotency key reused with different input/);
  await assert.rejects(recordIntake(store, lead, intakeBody, ''), /Idempotency-Key is required/);
  // A cited source is authorized, not merely looked up: a lead may only cite its own slice.
  const ownSlice = await engine.execute(admin, 'create', null, input('intake-source-product', 'product'), id());
  const otherSlice = await engine.execute(admin, 'create', null, input('intake-source-infra', 'infrastructure'), id());
  const cited = await recordIntake(store, lead, { origin: 'verification-finding', title: 'Cited own slice', description: '', sourceWorkId: ownSlice.id }, id());
  assert.equal(cited.sourceWorkId, ownSlice.id);
  await assert.rejects(recordIntake(store, lead, { origin: 'verification-finding', title: 'Cited another slice', description: '', sourceWorkId: otherSlice.id }, id()), /only their own slice/);
  assert.equal((await store.pool.query('SELECT 1 FROM intake_items WHERE source_work_id=$1', [otherSlice.id])).rowCount, 0);
  assert.equal((await store.events(otherSlice.id)).filter(event => event.kind === 'intake.created').length, 0);

  // Scoped operator agents: a second control plane bound to a repository, so
  // operator-agent scope is live on the delegation and intake routes.
  const scopedEngine = new Engine(store, [15368], 120, 'owner/delegation'); scopedEngine.principals = roster;
  const scopedHttp = server(scopedEngine, credentials);
  await new Promise<void>(resolve => scopedHttp.listen(0, '127.0.0.1', resolve));
  const scopedUrl = `http://127.0.0.1:${(scopedHttp.address() as { port: number }).port}`;
  try {
    const adminToken = credentials.find(c => c.id === admin.id)!.token;
    const agentToken = `scoped-operator-${'z'.repeat(32)}`;
    let inScope = await scopedEngine.execute(admin, 'create', null, input('scoped-visible', 'product'), id());
    inScope = await scopedEngine.execute(admin, 'ready', inScope.id, {}, id());
    inScope = await scopedEngine.execute(workerA, 'claim', inScope.id, {}, id());
    let outOfScope = await scopedEngine.execute(admin, 'create', null, input('scoped-hidden', 'infrastructure'), id());
    outOfScope = await scopedEngine.execute(admin, 'ready', outOfScope.id, {}, id());
    outOfScope = await scopedEngine.execute(workerB, 'claim', outOfScope.id, {}, id());
    const setup = { id: `intake-agent-${randomUUID()}`, displayName: 'Intake agent', capabilities: ['intent:create'],
      scope: { repositories: ['owner/delegation'], workItems: [inScope.id] }, token: agentToken, reason: 'Human enabled scoped intake' };
    const registered = await fetch(`${scopedUrl}/api/operator-agents`, { method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': id() }, body: JSON.stringify(setup) });
    assert.equal(registered.status, 200);
    const asAgent = (path: string) => fetch(`${scopedUrl}/api/${path}`, { headers: { Authorization: `Bearer ${agentToken}` } });
    // Delegation reads are filtered by the same scope rule as every other read.
    const delegation: any = await (await asAgent('delegation')).json();
    const product = delegation.slices.find((slice: any) => slice.id === 'product');
    const infrastructure = delegation.slices.find((slice: any) => slice.id === 'infrastructure');
    assert.deepEqual(product.workers.map((worker: any) => worker.key), [inScope.key]);
    assert.deepEqual(infrastructure.workers, [], 'out-of-scope owners must not be disclosed');
    assert.deepEqual(infrastructure.engineers, []);
    assert.ok(!delegation.slices.some((slice: any) => slice.bottlenecks.some((bottleneck: any) => bottleneck.key === outOfScope.key)));
    assert.equal(JSON.stringify(delegation).includes(outOfScope.key), false);
    assert.equal(JSON.stringify(delegation).includes(workerB.id), false);
    // /api/status embeds the same snapshot and must filter it identically.
    const status: any = await (await asAgent('status')).json();
    assert.equal(JSON.stringify(status.delegation).includes(outOfScope.key), false);
    assert.equal(JSON.stringify(status.delegation).includes(workerB.id), false);
    // An unscoped admin still sees both.
    const full: any = await (await fetch(`${scopedUrl}/api/delegation`, { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    assert.ok(JSON.stringify(full).includes(outOfScope.key));
    // Citing out-of-scope work is refused, and appends nothing to its history.
    const intake = (value: unknown) => fetch(`${scopedUrl}/api/intake`, { method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': id() }, body: JSON.stringify(value) });
    const refused = await intake({ origin: 'defect', title: 'Out-of-scope citation', description: '', sourceWorkId: outOfScope.id });
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error, /outside this operator-agent scope/);
    assert.equal((await store.pool.query('SELECT 1 FROM intake_items WHERE source_work_id=$1', [outOfScope.id])).rowCount, 0);
    assert.equal((await store.events(outOfScope.id)).filter(event => event.kind === 'intake.created').length, 0);
    const permitted = await intake({ origin: 'defect', title: 'In-scope citation', description: '', sourceWorkId: inScope.id });
    assert.equal(permitted.status, 200);
    assert.equal((await permitted.json()).sourceWorkId, inScope.id);
  } finally {
    scopedHttp.close();
    await engine.execute(workerA, 'release', (await store.list()).find(w => w.title === 'scoped-visible')!.id, { epoch: 1 }, id());
    await engine.execute(workerB, 'release', (await store.list()).find(w => w.title === 'scoped-hidden')!.id, { epoch: 1 }, id());
  }
});

test('integration:lead-ruling-history — rulings cite a rule and a reason and cannot be rewritten', async () => {
  let item = await engine.execute(admin, 'create', null, input('ruling-history', 'product'), id());
  await assert.rejects(recordLeadRuling(store, lead, item.id, { action: 'approve-plan', ruleId: '', reason: 'looks good' }, id()));
  await assert.rejects(recordLeadRuling(store, lead, item.id, { action: 'approve-plan', ruleId: 'rules/plan-v1#approval', reason: '' }, id()));
  await assert.rejects(recordLeadRuling(store, lead, item.id, { action: 'approve-plan', ruleId: 'rules/plan-v1#approval' } as never, id()));
  await assert.rejects(recordLeadRuling(store, lead, item.id, { action: 'escalate', ruleId: 'rules/safety-v2#escalate', reason: 'Unreviewed credential change' }, id()), /trigger/);
  await assert.rejects(recordLeadRuling(store, lead, item.id, { action: 'send-back', ruleId: 'rules/plan-v1#scope', reason: 'Out of scope', trigger: 'security-concern' }, id()), /trigger/);
  const approved = await recordLeadRuling(store, lead, item.id, { action: 'approve-plan', ruleId: 'rules/plan-v1#approval', reason: 'Plan satisfies the written scope' }, id());
  assert.equal(approved.ruling.leadId, lead.id);
  assert.equal(approved.ruling.slice, 'product');
  const rows = await store.pool.query('SELECT * FROM lead_rulings WHERE work_id=$1 ORDER BY created_at', [item.id]);
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].rule_id, 'rules/plan-v1#approval');
  assert.equal(rows.rows[0].reason, 'Plan satisfies the written scope');
  await assert.rejects(store.pool.query('UPDATE lead_rulings SET reason=$2 WHERE id=$1', [rows.rows[0].id, 'rewritten']), /append-only/);
  await assert.rejects(store.pool.query('DELETE FROM lead_rulings WHERE id=$1', [rows.rows[0].id]), /append-only/);
  await recordLeadRuling(store, lead, item.id, { action: 'classify-failure', ruleId: 'rules/failure-v1#flaky', reason: 'Runner timeout, not a defect' }, id());
  assert.equal((await store.pool.query('SELECT 1 FROM lead_rulings WHERE work_id=$1', [item.id])).rowCount, 2);
  const history = await store.events(item.id);
  assert.ok(history.some(event => event.kind === 'lead.approve-plan' && event.payload.details.ruleId === 'rules/plan-v1#approval'));
  // A lead rules only inside its own slice.
  let elsewhere = await engine.execute(admin, 'create', null, input('ruling-other-slice', 'infrastructure'), id());
  await assert.rejects(recordLeadRuling(store, lead, elsewhere.id, { action: 'send-back', ruleId: 'rules/plan-v1#scope', reason: 'Wrong slice' }, id()), /own slice/);
  // A retried ruling is the same ruling: a lost response must not duplicate
  // immutable history, and the key cannot be replayed with different input.
  const retryKey = id(), retryBody = { action: 'request-rerun', ruleId: 'rules/failure-v1#rerun', reason: 'Re-run the flaky suite once' } as const;
  const rulingsBefore = (await store.pool.query('SELECT 1 FROM lead_rulings WHERE work_id=$1', [item.id])).rowCount;
  const eventsBefore = (await store.events(item.id)).length;
  const firstTry = await recordLeadRuling(store, lead, item.id, retryBody, retryKey);
  const replay = await recordLeadRuling(store, lead, item.id, retryBody, retryKey);
  assert.equal(replay.ruling.id, firstTry.ruling.id);
  assert.equal(replay.work.revision, firstTry.work.revision);
  assert.equal((await store.pool.query('SELECT 1 FROM lead_rulings WHERE work_id=$1', [item.id])).rowCount, rulingsBefore! + 1);
  assert.equal((await store.events(item.id)).length, eventsBefore + 1);
  await assert.rejects(recordLeadRuling(store, lead, item.id, { ...retryBody, reason: 'Different reason' }, retryKey), /Idempotency key reused with different input/);
  await assert.rejects(recordLeadRuling(store, lead, item.id, retryBody, ''), /Idempotency-Key is required/);
  // Delivered work is an immutable snapshot: a ruling can neither bump its
  // revision nor attach escalation state to it.
  let delivered = await engine.execute(admin, 'create', null, input('ruling-delivered', 'product'), id());
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{stage}',to_jsonb('done'::text)) WHERE id=$1", [delivered.id]);
  const deliveredRevision = (await reload(delivered)).revision;
  await assert.rejects(recordLeadRuling(store, lead, delivered.id, { action: 'escalate', ruleId: 'rules/safety-v2#late', reason: 'Found after delivery', trigger: 'security-concern' }, id()), /Delivered work is immutable/);
  delivered = await reload(delivered);
  assert.equal(delivered.revision, deliveredRevision);
  assert.equal(delivered.escalation ?? null, null);
  assert.equal((await store.pool.query('SELECT 1 FROM lead_rulings WHERE work_id=$1', [delivered.id])).rowCount, 0);
});

test('unit:dynamic-merge-ordering — order follows dependencies and current conflicts, not registration order', () => {
  const work = (key: string, overrides: Partial<Work> = {}) => ({ id: key, key, stage: 'merge', priority: 2, dependencies: [], plannedFiles: [], workspaces: [], evidence: [], criteria: [], scenarioRequirements: [], gates: [], violations: [], lease: null, submission: null, ready: true, ...overrides }) as unknown as Work;
  const dependency = work('GY-2', { stage: 'done' });
  const laterReady = work('GY-9', { dependencies: [dependency.id], priority: 0 });
  const conflicted = work('GY-1', { plannedFiles: ['src/shared/'] });
  const peer = work('GY-3', { plannedFiles: ['src/shared/file.ts'], stage: 'build', lease: { owner: 'x', epoch: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() } });
  const registration = [conflicted, dependency, peer, laterReady];
  const order = mergeOrder(registration);
  assert.equal(order[0], 'GY-9');
  assert.ok(order.indexOf('GY-1') > order.indexOf('GY-9'));
  assert.notDeepEqual(order, registration.filter(w => w.stage !== 'done').map(w => w.key));
  // Unfinished dependencies sort last however early the item was registered.
  const blocked = work('GY-4', { dependencies: ['GY-5'], priority: 0 });
  const blocker = work('GY-5', { stage: 'build' });
  assert.equal(mergeOrder([blocked, blocker, laterReady, dependency]).at(-1), 'GY-4');
  // The guarded broker's batch uses that dynamic order, not the snapshot order.
  const observedAt = new Date().toISOString();
  const mergeable = (key: string, overrides: Partial<Work> = {}) => work(key, {
    candidate: { sha: head, baseSha: base, pr: 1, branch: `graphyard/${key}`, author: 'implementer' },
    mergeAuthorization: { sha: head, baseSha: base, policyRevision: 1, at: observedAt }, policyRevision: 1,
    observation: { at: observedAt } as Observation, ...overrides,
  } as Partial<Work>);
  const first = mergeable('GY-11', { plannedFiles: ['src/shared/'] });
  const second = mergeable('GY-12', { priority: 0 });
  assert.deepEqual(currentMergeCandidates([first, second, peer], observedAt).map(item => item.key), ['GY-12', 'GY-11']);
});

test('integration:automatic-escalation — every trigger escalates and no lead can suppress it', async () => {
  // Lease loss.
  const brief = new Engine(store, [15368], 0); brief.principals = roster;
  let lost = await engine.execute(admin, 'create', null, input('escalation-lease', 'product'), id());
  lost = await engine.execute(admin, 'ready', lost.id, {}, id());
  lost = await brief.execute(workerA, 'claim', lost.id, {}, id());
  await brief.reconcile();
  lost = await reload(lost);
  assert.equal(lost.lease, null);
  assert.equal(lost.escalation!.trigger, 'lease-loss');
  assert.match(lost.escalation!.reason, /engineer-a/);
  assert.equal(lost.escalation!.actor, 'graphyard');
  // Evidence policy conflict.
  let conflict = await candidate(workerA, 'escalation-policy', 'product');
  conflict = await engine.execute(reviewer, 'evidence', conflict.id, proof({ policyRevision: 2 }), id());
  assert.equal(conflict.escalation!.trigger, 'evidence-policy-conflict');
  assert.match(conflict.escalation!.reason, /policy v2 conflicts with current policy v1/);
  // Security concern, raised by a lead ruling that must name its trigger.
  let concern = await engine.execute(admin, 'create', null, input('escalation-security', 'product'), id());
  const ruled = await recordLeadRuling(store, lead, concern.id, { action: 'escalate', ruleId: 'rules/safety-v2#credential', reason: 'Unreviewed credential change', trigger: 'security-concern' }, id());
  assert.equal(ruled.work.escalation!.trigger, 'security-concern');
  // A lead cannot overwrite, replace, or silence a standing escalation, and a
  // later distinct trigger never disappears behind the one already standing.
  await recordLeadRuling(store, lead, concern.id, { action: 'escalate', ruleId: 'rules/safety-v2#credential', reason: 'Reclassified as routine', trigger: 'lease-loss' }, id());
  await recordLeadRuling(store, lead, concern.id, { action: 'classify-failure', ruleId: 'rules/failure-v1#flaky', reason: 'Runner timeout' }, id());
  concern = await reload(concern);
  assert.equal(concern.escalation!.trigger, 'security-concern');
  assert.equal(concern.escalation!.reason, 'Unreviewed credential change');
  assert.deepEqual(concern.escalations!.map(entry => entry.trigger), ['security-concern', 'lease-loss'], 'each distinct trigger stands until it is resolved on its own');
  // A repeat of a trigger that already stands is history, not a second incident.
  await recordLeadRuling(store, lead, concern.id, { action: 'escalate', ruleId: 'rules/safety-v2#credential', reason: 'Same concern again', trigger: 'security-concern' }, id());
  concern = await reload(concern);
  assert.deepEqual(concern.escalations!.map(entry => entry.trigger), ['security-concern', 'lease-loss']);
  // Resolving one concern leaves every other standing one refusing delivery.
  const mergeReasons = () => concern.gates.find(gate => gate.name === 'merge')!.reasons.join(' ');
  assert.match(mergeReasons(), /Unresolved security-concern escalation/);
  assert.match(mergeReasons(), /Unresolved lease-loss escalation/);
  concern = await engine.execute(admin, 'resolve', concern.id, { trigger: 'security-concern', reason: 'Credential change reviewed', expectedRevision: concern.revision }, id());
  assert.deepEqual(concern.escalations!.map(entry => entry.trigger), ['lease-loss'], 'resolving one concern never silently drops another');
  assert.equal(concern.escalation!.trigger, 'lease-loss');
  assert.doesNotMatch(mergeReasons(), /Unresolved security-concern escalation/);
  assert.match(mergeReasons(), /Unresolved lease-loss escalation/);
  concern = await engine.execute(admin, 'resolve', concern.id, { trigger: 'lease-loss', reason: 'Replacement worker assigned', expectedRevision: concern.revision }, id());
  assert.deepEqual(concern.escalations, []);
  assert.equal(concern.escalation, null);
  // Suspected requirement weakening, detected from the revision itself.
  let weakened = await engine.execute(admin, 'create', null, { ...input('escalation-weakening', 'product'), criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works', 'integration:works'] }, { id: 'AC-2', text: 'Stays safe', proofs: ['unit:safety'] }] }, id());
  weakened = await engine.execute(admin, 'requirements', weakened.id, { expectedPolicyRevision: 1, reason: 'Narrowing the contract', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], dependencies: [], plannedFiles: [], exclusiveResources: [] }, id());
  assert.equal(weakened.escalation!.trigger, 'requirement-weakening');
  assert.match(weakened.escalation!.reason, /AC-2/);
  assert.match(weakened.escalation!.reason, /AC-1/);
  assert.equal(weakened.escalation!.actor, admin.id);
  // An escalated item is reported as a slice bottleneck with its reason.
  const product = delegationSnapshot(roster, await store.list(), Date.now()).slices.find(s => s.id === 'product')!;
  assert.ok(product.bottlenecks.some(bottleneck => bottleneck.key === concern.key));
  assert.ok(product.bottlenecks.every(bottleneck => !!bottleneck.reason));
  // A replacement claim is itself the proof of lease loss, so the escalation is
  // recorded in the same transaction that overwrites the expired lease.
  const expiring = new Engine(store, [15368], 0); expiring.principals = roster;
  let replaced = await engine.execute(admin, 'create', null, input('escalation-replacement', 'infrastructure'), id());
  replaced = await engine.execute(admin, 'ready', replaced.id, {}, id());
  replaced = await expiring.execute(workerA, 'claim', replaced.id, {}, id());
  const lostEpoch = replaced.epoch;
  replaced = await engine.execute(workerB, 'claim', replaced.id, {}, id());
  assert.equal(replaced.lease!.owner, workerB.id, 'the replacement claim still succeeds');
  assert.equal(replaced.escalation!.trigger, 'lease-loss');
  assert.match(replaced.escalation!.reason, new RegExp(`${workerA.id} lost lease epoch ${lostEpoch}`));
  assert.equal(replaced.escalation!.actor, 'graphyard');
  await engine.execute(workerB, 'release', replaced.id, { epoch: replaced.epoch }, id());

  // Operator rework discards whatever unfinished assignment still stood, and that
  // is the last moment its end is visible: reconciliation only ever sees an
  // expired lease, and the replacement claim guards on a lease this path has
  // already cleared. The admin's own stopped-worker attestation explains that end,
  // so it is recorded as `lease.expired` history rather than as a vanished worker.
  let stranded = await engine.execute(admin, 'create', null, input('escalation-rework-lease', 'infrastructure'), id());
  stranded = await engine.execute(admin, 'ready', stranded.id, {}, id());
  stranded = await engine.execute(workerA, 'claim', stranded.id, {}, id());
  const strandedEpoch = stranded.epoch;
  stranded = await engine.execute(workerA, 'workspace', stranded.id, { epoch: strandedEpoch, host: 'delegation-host', path: `/tmp/delegation/${stranded.id}`, branch: `graphyard/${stranded.key.toLowerCase()}-${strandedEpoch}` }, id());
  assert.ok(stranded.lease, 'the stopped worker never released the lease it was implementing under');
  stranded = await engine.execute(admin, 'rework', stranded.id, { reason: 'Worker session was closed before it submitted', previousWorkerStopped: true }, id());
  assert.equal(stranded.lease, null);
  assert.deepEqual(standingEscalations(stranded), [], 'a lease the attesting admin discarded is not a lost worker');
  assert.equal(stranded.lastAssignment!.owner, workerA.id, 'the discarded assignment is still attributable');
  const discarded = (await store.events(stranded.id)).filter(event => event.kind === 'lease.expired');
  assert.deepEqual(discarded.map(event => [event.payload.details.epoch, event.payload.details.cause, event.payload.details.attestation.source, event.payload.details.attestation.actor]), [[strandedEpoch, 'stopped-by-attestation', 'rework', admin.id]]);
  // Reconciliation has no expired lease left to notice.
  await engine.reconcile();
  stranded = await reload(stranded);
  assert.deepEqual(standingEscalations(stranded), []);
  // The replacement engineer claims the reopened item; a lead still cannot resolve the
  // standing incident on the replaced item, and the admin can.
  stranded = await engine.execute(workerB, 'claim', stranded.id, {}, id());
  assert.equal(stranded.lease!.owner, workerB.id);
  replaced = await reload(replaced);
  await assert.rejects(engine.execute(lead, 'resolve', replaced.id, { trigger: 'lease-loss', reason: 'Reassigned already', expectedRevision: replaced.revision }, id()), /Slice leads cannot perform lifecycle mutations/);
  replaced = await engine.execute(admin, 'resolve', replaced.id, { trigger: 'lease-loss', reason: 'Replacement engineer assigned and verified', expectedRevision: replaced.revision }, id());
  assert.deepEqual(replaced.escalations, []);
  await engine.execute(workerB, 'release', stranded.id, { epoch: stranded.epoch }, id());
  // Rework that discards no assignment raises nothing: the incident is the lost
  // lease, not the reassignment that follows it.
  let reopened = await engine.execute(admin, 'create', null, input('escalation-rework-unleased', 'infrastructure'), id());
  reopened = await engine.execute(admin, 'ready', reopened.id, {}, id());
  reopened = await engine.execute(admin, 'rework', reopened.id, { reason: 'Reopened before anyone claimed it', previousWorkerStopped: true }, id());
  assert.equal(reopened.escalation ?? null, null);
  assert.deepEqual(reopened.escalations ?? [], []);
  // A submitted attempt is one of those: `submit` ended its lease, so a worker
  // session closed after completing leaves nothing for rework to discard.
  let completed = await candidate(workerA, 'escalation-rework-submitted', 'infrastructure');
  assert.equal(completed.lease, null);
  completed = await engine.execute(admin, 'rework', completed.id, { reason: 'Worker session was closed after submission', previousWorkerStopped: true }, id());
  assert.deepEqual(completed.escalations ?? [], [], 'post-submission rework is not an incident');
  assert.equal(completed.lastAssignment!.owner, workerA.id, 'the completed attempt is still attributable');

  // An unresolved escalation refuses delivery, even for an otherwise merge-ready
  // candidate, and only a human operator can resolve it.
  let ready = await candidate(workerB, 'escalation-blocks-merge', 'product');
  ready = await proven(ready);
  assert.equal(ready.stage, 'merge');
  assert.ok(ready.mergeAuthorization);
  const observedAt = ready.observation!.at;
  assert.deepEqual(currentMergeCandidates([ready], observedAt).map(item => item.key), [ready.key]);
  const escalated = (await recordLeadRuling(store, lead, ready.id, { action: 'escalate', ruleId: 'rules/safety-v2#supply-chain', reason: 'Unreviewed dependency change', trigger: 'security-concern' }, id())).work;
  assert.equal(escalated.mergeAuthorization, null, 'merge authorization is invalidated in the escalating transaction');
  assert.equal(escalated.gates.find(gate => gate.name === 'merge')!.passed, false);
  assert.match(escalated.gates.find(gate => gate.name === 'merge')!.reasons.join(' '), /Unresolved security-concern escalation/);
  assert.deepEqual(currentMergeCandidates([escalated], observedAt), [], 'the guarded broker cannot select an escalated item');
  assert.equal(await reload(ready).then(item => item.mergeAuthorization), null);
  // Nobody but the operator resolves it, and never a stale or mismatched trigger.
  await assert.rejects(engine.execute(workerA, 'resolve', ready.id, { trigger: 'security-concern', reason: 'Clearing the block', expectedRevision: escalated.revision }, id()), /Operator permission required/);
  await assert.rejects(engine.execute(lead, 'resolve', ready.id, { trigger: 'security-concern', reason: 'Clearing my own escalation', expectedRevision: escalated.revision }, id()), /Slice leads cannot perform lifecycle mutations/);
  await assert.rejects(engine.execute(reviewer, 'resolve', ready.id, { trigger: 'security-concern', reason: 'Clearing the block', expectedRevision: escalated.revision }, id()), /Operator permission required/);
  // An admin credential that declares `ai`, or declares nothing, is not a human
  // operator: the escalation it would clear refuses its own automated delivery.
  await assert.rejects(engine.execute(aiAdmin, 'resolve', ready.id, { trigger: 'security-concern', reason: 'Automated clearance', expectedRevision: escalated.revision }, id()), /requires a declared human session; automation-admin is ai/);
  await assert.rejects(engine.execute(undeclaredAdmin, 'resolve', ready.id, { trigger: 'security-concern', reason: 'Unlabelled clearance', expectedRevision: escalated.revision }, id()), /requires a declared human session; legacy-admin is undeclared/);
  await assert.rejects(engine.execute(admin, 'resolve', ready.id, { trigger: 'lease-loss', reason: 'Wrong standing trigger', expectedRevision: escalated.revision }, id()), /Standing escalations are security-concern/);
  // The revision is required, so a stale client cannot clear a later incident
  // that happens to share a trigger.
  await assert.rejects(engine.execute(admin, 'resolve', ready.id, { trigger: 'security-concern', reason: 'Stale read' }, id()), /expectedRevision/);
  await assert.rejects(engine.execute(admin, 'resolve', ready.id, { trigger: 'security-concern', reason: 'Stale read', expectedRevision: escalated.revision - 1 }, id()), /Task revision changed; reload before resolving/);
  let resolved = await engine.execute(admin, 'resolve', ready.id, { trigger: 'security-concern', reason: 'Dependency change reviewed and accepted', expectedRevision: escalated.revision }, id());
  assert.equal(resolved.escalation, null);
  assert.equal(resolved.gates.find(gate => gate.name === 'merge')!.passed, true);
  assert.ok(resolved.mergeAuthorization, 'authorization is reissued only after the human resolution');
  assert.deepEqual(currentMergeCandidates([resolved], resolved.observation!.at).map(item => item.key), [resolved.key]);
  await assert.rejects(engine.execute(admin, 'resolve', ready.id, { trigger: 'security-concern', reason: 'Again', expectedRevision: resolved.revision }, id()), /no escalation to resolve/);
  // A concern raised after the merge was requested must still stop the delivery it refuses.
  // GitHub merges; the ruling withdraws the authorization in its own transaction, so the
  // standing request no longer binds an authorized head and GitHub is told to dequeue it.
  let pending = await candidate(workerB, 'escalation-withdraws-requested-merge', 'product');
  pending = await proven(pending);
  await engine.requestEnqueue(coordinator, pending.id, { enqueue: true, expectedRevision: pending.revision, sha: head, baseSha: base, policyRevision: pending.policyRevision }, id());
  const heldBack = (await recordLeadRuling(store, lead, pending.id, { action: 'send-back', ruleId: 'rules/plan-v1#scope', reason: 'Out of agreed scope' }, id())).work;
  assert.equal(heldBack.mergeAuthorization, null, 'a blocking ruling withdraws the authorization in its own transaction');
  assert.equal(heldBack.mergeExecution ?? null, null, 'no merge execution exists to fence');
  const fenced = (await recordLeadRuling(store, lead, pending.id, { action: 'escalate', ruleId: 'rules/safety-v2#supply-chain', reason: 'Dependency review reopened', trigger: 'security-concern' }, id())).work;
  assert.equal(fenced.mergeAuthorization, null);
  assert.deepEqual(currentMergeCandidates([fenced], fenced.observation!.at), [], 'the withdrawn item is never selected again');
  await assert.rejects(engine.requestEnqueue(coordinator, pending.id, { enqueue: true, expectedRevision: fenced.revision, sha: head, baseSha: base, policyRevision: fenced.policyRevision }, id()), /Merge authorization is no longer current/);

  // The resolution itself is append-only history with its audit reason.
  const audit = (await store.events(ready.id)).find(event => event.kind === 'resolve');
  assert.equal(audit.actor, admin.id);
  assert.equal(audit.payload.details.reason, 'Dependency change reviewed and accepted');
  assert.equal(audit.payload.details.trigger, 'security-concern');
});

test('unit:delegation-limits — configured capacity is server-enforced and refused with an explicit reason', () => {
  assert.deepEqual(defaultDelegationLimits, { maxLeads: 3, maxEngineersPerLead: 2, minReviewers: 1, maxReviewers: 2 });
  assert.deepEqual(delegationLimits({}), defaultDelegationLimits);
  assert.deepEqual(delegationLimits({ GRAPHYARD_MAX_SLICE_LEADS: '2', GRAPHYARD_MAX_ENGINEERS_PER_LEAD: '5', GRAPHYARD_MIN_REVIEWERS: '2', GRAPHYARD_MAX_REVIEWERS: '4' }),
    { maxLeads: 2, maxEngineersPerLead: 5, minReviewers: 2, maxReviewers: 4 });
  for (const value of ['0', '-1', '1.5', 'many', '']) assert.throws(() => delegationLimits({ GRAPHYARD_MAX_SLICE_LEADS: value }), /GRAPHYARD_MAX_SLICE_LEADS must be a positive integer/);
  assert.throws(() => delegationLimits({ GRAPHYARD_MIN_REVIEWERS: '3', GRAPHYARD_MAX_REVIEWERS: '2' }), /Reviewer minimum cannot exceed maximum/);
  assert.throws(() => validateDelegationPrincipals([lead, infraLead, docsLead, { id: 'fourth-lead', role: 'slice-lead', slice: 'product', sessionKind: 'ai' }, reviewer]), /Slice lead limit exceeded: 4\/3/);
  assert.throws(() => validateDelegationPrincipals([lead, reviewer, { ...reviewer, id: 'second-proof' }, { ...reviewer, id: 'third-proof' }]), /Independent review\/proof agent limit exceeded: 3\/2/);
  assert.throws(() => validateDelegationPrincipals([lead, { ...reviewer, id: lead.id }]), /cannot also hold slice-lead authority/);
  assert.throws(() => validateDelegationPrincipals([lead, { ...reviewer, slice: 'product' }]), /must remain independent of every slice/);
  assert.throws(() => validateDelegationPrincipals([lead]), /requires at least 1 independent review\/proof agent/);
  // The lead-facing capacity check counts the same seats the claim path does.
  const held = (key: string, owner: string, slice: SliceId) => ({ key, slice, lease: { owner, epoch: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() } }) as unknown as Work;
  const twoItemsOneEngineer = [held('GY-101', 'engineer-a', 'product'), held('GY-102', 'engineer-a', 'product')];
  enforceLeadCapacity(lead, twoItemsOneEngineer, Date.now(), defaultDelegationLimits);
  assert.deepEqual([...activeEngineers(twoItemsOneEngineer, 'product', Date.now())], ['engineer-a']);
  assert.throws(() => enforceLeadCapacity(lead, [...twoItemsOneEngineer, held('GY-103', 'engineer-b', 'product')], Date.now(), defaultDelegationLimits), /Engineer limit for product exceeded: 2\/2/);
  // Expired leases free the seat they held.
  assert.deepEqual([...activeEngineers(twoItemsOneEngineer, 'product', Date.now() + 120_000)], []);
  // Two leads and one reviewer remain inside the shared-reviewer defaults.
  validateDelegationPrincipals([admin, lead, infraLead, reviewer]);
  validateDelegationPrincipals([admin, lead, reviewer, { ...reviewer, id: 'second-proof' }]);
});

test('integration:bootstrap-compatibility — the single-agent bootstrap flow is unchanged', async () => {
  // A bootstrap roster has no slice leads, no slices, and needs no producer to start.
  validateDelegationPrincipals([admin, workerA]);
  validateDelegationPrincipals([{ ...admin, token: 'o'.repeat(32) }, { ...workerA, token: 'w'.repeat(32) }]);
  const bootstrap = new Engine(store); bootstrap.principals = [admin, workerA, workerB, workerC, reviewer];
  let item = await bootstrap.execute(admin, 'create', null, input('bootstrap-flow'), id());
  assert.equal(item.slice, undefined);
  item = await bootstrap.execute(admin, 'ready', item.id, {}, id());
  item = await bootstrap.execute(workerA, 'claim', item.id, {}, id());
  item = await bootstrap.execute(workerA, 'workspace', item.id, { epoch: item.epoch, host: 'bootstrap-host', path: '/tmp/delegation/bootstrap', branch: 'graphyard/bootstrap' }, id());
  item = await bootstrap.execute(workerA, 'submit', item.id, { epoch: item.epoch, pr: ++pr }, id());
  // The worker's own assertion is recorded, never trusted.
  item = await bootstrap.execute(workerA, 'evidence', item.id, proof(), id());
  assert.equal(item.evidence.at(-1)!.trusted, false);
  assert.equal(item.gates.find(gate => gate.name === 'acceptance')!.passed, false);
  item = await bootstrap.observe(item.id, item.revision, observation(item));
  item = await bootstrap.execute(reviewer, 'evidence', item.id, proof(), id());
  assert.equal(item.evidence.at(-1)!.trusted, true);
  assert.equal(item.gates.find(gate => gate.name === 'acceptance')!.passed, true);
  assert.equal(item.stage, 'merge');
  // Unsliced work is never constrained by per-lead engineer capacity.
  const peers: Work[] = [];
  for (const [index, actor] of [workerB, workerC, admin].entries()) {
    let peer = await bootstrap.execute(admin, 'create', null, input(`bootstrap-peer-${index}`), id());
    peer = await bootstrap.execute(admin, 'ready', peer.id, {}, id());
    peers.push(await bootstrap.execute(actor, 'claim', peer.id, {}, id()));
  }
  assert.equal(peers.length, 3);
  assert.ok(peers.every(peer => peer.lease));
  // A bootstrap operator with no declared session kind still files routine intake.
  const bootstrapIntake = await recordIntake(store, undeclaredAdmin, { origin: 'defect', title: 'Bootstrap defect', description: '' }, id());
  assert.equal(bootstrapIntake.state, 'backlog');
  await assert.rejects(recordIntake(store, undeclaredAdmin, { origin: 'goal', title: 'Bootstrap goal', description: '' }, id()), /declared human session/);
  const snapshot = delegationSnapshot([admin, workerA], await store.list(), Date.now());
  assert.deepEqual(snapshot.slices.map(slice => slice.lead), [null, null, null]);
  assert.deepEqual(snapshot.reviewers, []);
  for (const [index, actor] of [workerB, workerC, admin].entries()) await bootstrap.execute(actor, 'release', peers[index].id, { epoch: peers[index].epoch }, id());
  assert.equal((await reload(item)).lease, null, 'the submitted attempt holds no lease to release');
});
