import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import {
  classifyIntake, defaultDelegationLimits, delegationLimits, delegationSnapshot, humanOnlyIntakeOrigins, implementerIdentities,
  leadMay, leadPermittedActions, leadRulingActions, mergeOrder, producerIndependenceRefusal, recordIntake, recordLeadRuling,
  routineIntakeOrigins, sessionKind, slices, validateDelegationPrincipals,
} from '../src/delegation.js';
import { currentMergeCandidates } from '../src/master.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { sliceIds, type Observation, type Principal, type SliceId, type Work } from '../src/model.js';
import { Store } from '../src/store.js';

// Each test is named for the proof it produces, so acceptance evidence maps to
// one executed case per required proof.
const admin: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human', displayName: 'Operator' };
const lead: Principal = { id: 'product-lead', role: 'slice-lead', slice: 'product', sessionKind: 'ai', displayName: 'Pine' };
const infraLead: Principal = { id: 'infra-lead', role: 'slice-lead', slice: 'infrastructure', sessionKind: 'ai' };
const docsLead: Principal = { id: 'docs-lead', role: 'slice-lead', slice: 'docs-experience', sessionKind: 'ai' };
const workerA: Principal = { id: 'engineer-a', role: 'worker', sessionKind: 'ai' };
const workerB: Principal = { id: 'engineer-b', role: 'worker', sessionKind: 'ai' };
const workerC: Principal = { id: 'engineer-c', role: 'worker', sessionKind: 'ai' };
const reviewer: Principal = { id: 'proof-runner', role: 'producer', proofs: ['unit:works', 'manual:audit'], sessionKind: 'ai', displayName: 'Rowan' };
const coordinator: Principal = { id: 'merge-broker', role: 'coordinator', sessionKind: 'ai' };
const roster = [admin, lead, infraLead, docsLead, workerA, workerB, workerC, reviewer, coordinator];
const head = 'a'.repeat(40), base = 'b'.repeat(40);
let database: EmbeddedPostgres, store: Store, engine: Engine;
let http: ReturnType<typeof server>, url: string;
const credentials = roster.map(principal => ({ ...principal, token: `delegation-${principal.id}-${'x'.repeat(32)}` }));
let pr = 500;
const id = () => randomUUID();
const input = (title: string, slice?: SliceId) => ({ title, ...(slice ? { slice } : {}), plannedFiles: [`src/${title}.ts`], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }] });
const proof = (overrides: Record<string, unknown> = {}) => ({ proof: 'unit:works', sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 4, skipped: 0, ...overrides });
function observation(work: Work): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: work.submission!.pr, branch: work.workspaces.at(-1)!.branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'independent-reviewer', sha: head, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, files: ['src/delegation.ts'], at: new Date().toISOString() };
}
// Drive an item to an observed candidate, then release the lease so later tests
// in the same slice are not blocked by a stale active engineer.
async function candidate(actor: Principal, title: string, slice?: SliceId) {
  let work = await engine.execute(admin, 'create', null, input(title, slice), id());
  work = await engine.execute(admin, 'ready', work.id, {}, id());
  work = await engine.execute(actor, 'claim', work.id, {}, id());
  work = await engine.execute(actor, 'workspace', work.id, { epoch: work.epoch, host: 'delegation-host', path: `/tmp/delegation/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, id());
  work = await engine.execute(actor, 'submit', work.id, { epoch: work.epoch, pr: ++pr }, id());
  work = await engine.observe(work.id, work.revision, observation(work));
  return engine.execute(actor, 'release', work.id, { epoch: work.epoch }, id());
}
const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;

before(async () => {
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-delegation-')), user: 'graphyard', password: 'testing-only', port: 15448, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('delegation_test');
  store = new Store('postgres://graphyard:testing-only@127.0.0.1:15448/delegation_test'); await store.init();
  engine = new Engine(store); engine.roster = roster;
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
  await assert.rejects(engine.acquireMerge(lead, item.id, { expectedRevision: item.revision, sha: head, baseSha: base, policyRevision: 1 }, id()), /Coordinator permission/);
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
  assert.equal((await reload(item)).lease, null);
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
  await assert.rejects(engine.acquireMerge(workerA, item.id, { expectedRevision: item.revision, sha: head, baseSha: base, policyRevision: 1 }, id()), /Coordinator permission/);
  await assert.rejects(engine.acquireMerge(coordinator, item.id, { expectedRevision: item.revision, sha: head, baseSha: base, policyRevision: 1 }, id()), /authorization/i);
  // Control-plane truth never depends on the session runtime.
  for (const module of ['model.ts', 'engine.ts', 'store.ts', 'delegation.ts', 'server.ts'])
    assert.doesNotMatch(await readFile(new URL(`../src/${module}`, import.meta.url), 'utf8'), /herdr/i, module);
  await engine.execute(workerA, 'release', item.id, { epoch: item.epoch }, id());
  await engine.execute(workerB, 'release', other.id, { epoch: other.epoch }, id());
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
  await engine.execute(workerB, 'release', item.id, { epoch: item.epoch }, id());
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
    const item = await recordIntake(store, lead, { origin, title: `Routine ${origin}`, description: 'Observed during delivery' });
    assert.equal(item.state, 'backlog');
    assert.equal(item.submittedBy, lead.id);
  }
  for (const origin of humanOnlyIntakeOrigins)
    await assert.rejects(recordIntake(store, lead, { origin, title: `AI ${origin}`, description: '' }), new RegExp(`${origin} intake is human-only`));
  for (const origin of humanOnlyIntakeOrigins) {
    const item = await recordIntake(store, admin, { origin, title: `Human ${origin}`, description: '' });
    assert.equal(item.state, 'backlog');
  }
  await assert.rejects(recordIntake(store, workerA, { origin: 'defect', title: 'Worker intake', description: '' }), /Intake permission required/);
  await assert.rejects(recordIntake(store, reviewer, { origin: 'defect', title: 'Producer intake', description: '' }), /Intake permission required/);
  const rows = await store.pool.query('SELECT origin FROM intake_items');
  assert.ok(rows.rowCount! >= routineIntakeOrigins.length + humanOnlyIntakeOrigins.length);
});

test('integration:lead-ruling-history — rulings cite a rule and a reason and cannot be rewritten', async () => {
  let item = await engine.execute(admin, 'create', null, input('ruling-history', 'product'), id());
  await assert.rejects(recordLeadRuling(store, lead, item.id, { action: 'approve-plan', ruleId: '', reason: 'looks good' }));
  await assert.rejects(recordLeadRuling(store, lead, item.id, { action: 'approve-plan', ruleId: 'rules/plan-v1#approval', reason: '' }));
  await assert.rejects(recordLeadRuling(store, lead, item.id, { action: 'approve-plan', ruleId: 'rules/plan-v1#approval' } as never));
  await assert.rejects(recordLeadRuling(store, lead, item.id, { action: 'escalate', ruleId: 'rules/safety-v2#escalate', reason: 'Unreviewed credential change' }), /trigger/);
  await assert.rejects(recordLeadRuling(store, lead, item.id, { action: 'send-back', ruleId: 'rules/plan-v1#scope', reason: 'Out of scope', trigger: 'security-concern' }), /trigger/);
  const approved = await recordLeadRuling(store, lead, item.id, { action: 'approve-plan', ruleId: 'rules/plan-v1#approval', reason: 'Plan satisfies the written scope' });
  assert.equal(approved.ruling.leadId, lead.id);
  assert.equal(approved.ruling.slice, 'product');
  const rows = await store.pool.query('SELECT * FROM lead_rulings WHERE work_id=$1 ORDER BY created_at', [item.id]);
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].rule_id, 'rules/plan-v1#approval');
  assert.equal(rows.rows[0].reason, 'Plan satisfies the written scope');
  await assert.rejects(store.pool.query('UPDATE lead_rulings SET reason=$2 WHERE id=$1', [rows.rows[0].id, 'rewritten']), /append-only/);
  await assert.rejects(store.pool.query('DELETE FROM lead_rulings WHERE id=$1', [rows.rows[0].id]), /append-only/);
  await recordLeadRuling(store, lead, item.id, { action: 'classify-failure', ruleId: 'rules/failure-v1#flaky', reason: 'Runner timeout, not a defect' });
  assert.equal((await store.pool.query('SELECT 1 FROM lead_rulings WHERE work_id=$1', [item.id])).rowCount, 2);
  const history = await store.events(item.id);
  assert.ok(history.some(event => event.kind === 'lead.approve-plan' && event.payload.details.ruleId === 'rules/plan-v1#approval'));
  // A lead rules only inside its own slice.
  let elsewhere = await engine.execute(admin, 'create', null, input('ruling-other-slice', 'infrastructure'), id());
  await assert.rejects(recordLeadRuling(store, lead, elsewhere.id, { action: 'send-back', ruleId: 'rules/plan-v1#scope', reason: 'Wrong slice' }), /own slice/);
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
  const brief = new Engine(store, [15368], 0); brief.roster = roster;
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
  const ruled = await recordLeadRuling(store, lead, concern.id, { action: 'escalate', ruleId: 'rules/safety-v2#credential', reason: 'Unreviewed credential change', trigger: 'security-concern' });
  assert.equal(ruled.work.escalation!.trigger, 'security-concern');
  // A lead cannot overwrite, replace, or silence a standing escalation.
  await recordLeadRuling(store, lead, concern.id, { action: 'escalate', ruleId: 'rules/safety-v2#credential', reason: 'Reclassified as routine', trigger: 'lease-loss' });
  await recordLeadRuling(store, lead, concern.id, { action: 'classify-failure', ruleId: 'rules/failure-v1#flaky', reason: 'Runner timeout' });
  concern = await reload(concern);
  assert.equal(concern.escalation!.trigger, 'security-concern');
  assert.equal(concern.escalation!.reason, 'Unreviewed credential change');
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
  // Two leads and one reviewer remain inside the shared-reviewer defaults.
  validateDelegationPrincipals([admin, lead, infraLead, reviewer]);
  validateDelegationPrincipals([admin, lead, reviewer, { ...reviewer, id: 'second-proof' }]);
});

test('integration:bootstrap-compatibility — the single-agent bootstrap flow is unchanged', async () => {
  // A bootstrap roster has no slice leads, no slices, and needs no producer to start.
  validateDelegationPrincipals([admin, workerA]);
  validateDelegationPrincipals([{ ...admin, token: 'o'.repeat(32) }, { ...workerA, token: 'w'.repeat(32) }]);
  const bootstrap = new Engine(store); bootstrap.roster = [admin, workerA, workerB, workerC, reviewer];
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
  const snapshot = delegationSnapshot([admin, workerA], await store.list(), Date.now());
  assert.deepEqual(snapshot.slices.map(slice => slice.lead), [null, null, null]);
  assert.deepEqual(snapshot.reviewers, []);
  for (const [index, actor] of [workerB, workerC, admin].entries()) await bootstrap.execute(actor, 'release', peers[index].id, { epoch: peers[index].epoch }, id());
  await bootstrap.execute(workerA, 'release', item.id, { epoch: item.epoch }, id());
});
