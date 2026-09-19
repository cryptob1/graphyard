import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { bootstrapObligations, criterionSchema, deliveredProof, evaluate, inheritedObligations, pathScopeContains, pathScopesOverlap, requiredProofs, type Observation, type Principal, type Work } from '../src/model.js';
import { queueRef } from '../src/merge-queue.js';
import { diagnose, obligationLedger, proofPreview } from '../src/coordination.js';

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const harnessProof = 'integration:herdr-recovery';
const contract = 'src/herdr/recovery.ts';
let pg: EmbeddedPostgres, store: Store, engine: Engine;
let serial = 0;
const id = () => randomUUID();

before(async () => {
  const port = Number(process.env.GRAPHYARD_BOOTSTRAP_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 2);
  pg = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-bootstrap-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('bootstrap_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/bootstrap_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.operatorAuthorizer = async (_db, _now, actor) => actor;
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });

const current = async (workId: string) => (await store.list()).find(item => item.id === workId)!;
const all = () => store.list();

function observation(work: Work, overrides: Partial<Observation> = {}): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }], merged: false, mergeSha: null, mergeable: true,
    protected: true, files: [], scopeFiles: [], at: new Date().toISOString(), prState: 'open', draft: false, ...overrides };
}

/** An item taken through claim, workspace, submission and an observed, reviewed, green candidate. */
async function submitted(input: Record<string, unknown>, observe: Partial<Observation> = {}) {
  const n = ++serial;
  let work = await engine.execute(operator, 'create', null, input, id());
  work = await engine.execute(operator, 'ready', work.id, {}, id());
  work = await engine.execute(worker, 'claim', work.id, {}, id());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'test', path: `/tmp/bootstrap-${n}`, branch: `graphyard/bootstrap-${n}` }, id());
  work = await engine.execute(worker, 'submit', work.id, { epoch: work.epoch, pr: 1000 + n }, id());
  return engine.observe(work.id, work.revision, observation(work, observe));
}
const acceptance = (work: Work) => work.gates.find(gate => gate.name === 'acceptance')!;
async function prove(work: Work, proof: string, overrides: Record<string, unknown> = {}) {
  const producer: Principal = { id: `producer-${proof}`, role: 'producer', proofs: [proof] };
  return engine.execute(producer, 'evidence', work.id, { proof, sha: head, baseSha: base, policyRevision: work.policyRevision, result: 'pass', executed: 4, skipped: 0, ...overrides }, id());
}

// ---------------------------------------------------------------------------
// unit:bootstrap-policy-model — pure derivation over work documents.
// ---------------------------------------------------------------------------

const declaration = { reason: 'This change introduces the herdr-recovery harness', contractPaths: [contract], declaredBy: 'operator', declaredAt: '2026-09-18T00:00:00.000Z', policyRevision: 2 };
function fixture(overrides: Partial<Work> = {}): Work {
  const at = new Date().toISOString();
  return { id: 'origin', key: 'GY-2', title: 'Introduce the harness', description: '', type: 'feature', priority: 2, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Recovery is proven', proofs: [harnessProof], bootstrap: { ...declaration } }, { id: 'AC-2', text: 'Supervisor stops cleanly', proofs: ['unit:supervisor-stop'] }],
    plannedFiles: ['src/herdr/'], policy: { checks: ['test'], review: true, reviewProvider: 'github' },
    stage: 'acceptance', revision: 4, policyRevision: 2, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true,
    epoch: 1, lease: null, workspaces: [{ host: 'h', path: '/p', branch: 'graphyard/gy-2-1', epoch: 1, owner: 'implementer' }],
    candidate: { sha: head, baseSha: base, pr: 7, branch: 'graphyard/gy-2-1', author: 'implementer' },
    submission: { epoch: 1, pr: 7 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null,
    gates: [], violations: [],
    observation: { candidate: { sha: head, baseSha: base, pr: 7, branch: 'graphyard/gy-2-1', author: 'implementer' },
      checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }],
      merged: false, mergeSha: null, mergeable: true, protected: true, files: [], scopeFiles: [], at, prState: 'open', draft: false },
    ...overrides } as Work;
}
const trusted = (proof: string, extra: Record<string, unknown> = {}) => ({ id: randomUUID(), proof, sha: head, baseSha: base, policyRevision: 2,
  producer: 'ci', trusted: true, result: 'pass' as const, executed: 3, skipped: 0, at: new Date().toISOString(), ...extra });

test('unit:bootstrap-policy-model defers only the marked criterion and keeps every other gate', () => {
  const work = fixture();
  const deferred = evaluate(work, [work], new Date(), [15368]);
  assert.deepEqual(acceptance({ ...work, gates: deferred.gates } as Work).reasons, ['AC-2: unit:supervisor-stop needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy'],
    'the bootstrap criterion is deferred while every other criterion still demands proof');
  assert.deepEqual(requiredProofs(work, [work]), ['unit:supervisor-stop']);
  assert.equal(deferred.gates.find(gate => gate.name === 'review')!.passed, true);
  assert.equal(deferred.gates.find(gate => gate.name === 'test')!.passed, true);

  const proven = fixture({ evidence: [trusted('unit:supervisor-stop')] });
  assert.deepEqual(evaluate(proven, [proven], new Date(), [15368]).gates.find(gate => gate.name === 'acceptance')!.reasons, []);

  // Review and CI are not weakened by the deferral.
  const unreviewed = fixture({ evidence: [trusted('unit:supervisor-stop')], observation: { ...fixture().observation!, reviews: [], checks: [{ name: 'test', result: 'failure', appId: 15368 }] } });
  const gates = evaluate(unreviewed, [unreviewed], new Date(), [15368]).gates;
  assert.equal(gates.find(gate => gate.name === 'review')!.passed, false);
  assert.equal(gates.find(gate => gate.name === 'test')!.passed, false);
});

test('unit:bootstrap-policy-model records the deferred proof as an obligation on the contract path', () => {
  const work = fixture();
  assert.deepEqual(bootstrapObligations([work]), [{ key: 'GY-2', workId: 'origin', criterionId: 'AC-1', proof: harnessProof, ...declaration }]);

  const next = fixture({ id: 'next', key: 'GY-9', criteria: [{ id: 'AC-1', text: 'Recovery is used', proofs: ['unit:next'] }], plannedFiles: ['src/herdr/recovery.ts'], evidence: [] });
  assert.deepEqual(inheritedObligations(next, [work, next]).map(obligation => obligation.proof), [harnessProof]);
  assert.deepEqual(requiredProofs(next, [work, next]), ['unit:next', harnessProof]);

  const elsewhere = fixture({ id: 'elsewhere', key: 'GY-10', criteria: [{ id: 'AC-1', text: 'Unrelated', proofs: ['unit:elsewhere'] }], plannedFiles: ['src/github.ts'] });
  assert.deepEqual(inheritedObligations(elsewhere, [work, elsewhere]), [], 'work that does not touch the contract inherits nothing');

  // The item that inherits an obligation cannot defer it a second time.
  const renewing = fixture({ id: 'renewing', key: 'GY-11', plannedFiles: ['src/herdr/recovery.ts'],
    criteria: [{ id: 'AC-1', text: 'Recovery is proven later', proofs: [harnessProof], bootstrap: { ...declaration, declaredBy: 'operator-two' } }] });
  assert.deepEqual(inheritedObligations(renewing, [work, renewing]).map(obligation => obligation.proof), [harnessProof]);
  assert.ok(evaluate(renewing, [work, renewing], new Date(), [15368]).gates.find(gate => gate.name === 'acceptance')!
    .reasons.some(reason => reason.startsWith('Bootstrap obligation inherited from GY-2 AC-1')), 'a renewed deferral does not escape the inherited obligation');
});

test('unit:bootstrap-policy-model discharges an obligation only from delivered, trusted, complete evidence', () => {
  const work = fixture();
  const delivered = (evidence: Record<string, unknown>[], overrides: Partial<Work> = {}) => fixture({ id: 'later', key: 'GY-12', stage: 'done',
    criteria: [{ id: 'AC-1', text: 'Recovery is proven', proofs: [harnessProof] }], evidence: evidence as unknown as Work['evidence'], ...overrides });

  for (const [label, evidence] of [['untrusted worker assertion', [trusted(harnessProof, { trusted: false })]],
    ['a failing run', [trusted(harnessProof, { result: 'fail' })]],
    ['a skipped run', [trusted(harnessProof, { skipped: 2 })]],
    ['an empty run', [trusted(harnessProof, { executed: 0 })]],
    ['a superseded candidate', [trusted(harnessProof, { sha: 'c'.repeat(40) })]],
    ['a stale policy revision', [trusted(harnessProof, { policyRevision: 1 })]]] as const) {
    const item = delivered([...evidence]);
    assert.equal(deliveredProof(item, harnessProof), false, `${label} must not discharge the obligation`);
    assert.equal(bootstrapObligations([work, item]).length, 1, `${label} must not discharge the obligation`);
  }
  const undelivered = delivered([trusted(harnessProof)], { stage: 'acceptance' });
  assert.equal(bootstrapObligations([work, undelivered]).length, 1, 'an unmerged change does not discharge the obligation');
  const proven = delivered([trusted(harnessProof)]);
  assert.deepEqual(bootstrapObligations([work, proven]), [], 'a delivered change that ran the harness clears the obligation');
  assert.deepEqual(inheritedObligations(fixture({ id: 'after', key: 'GY-13', plannedFiles: [contract], criteria: [{ id: 'AC-1', text: 'x', proofs: ['unit:after'] }] }), [work, proven]), []);
});

test('unit:bootstrap-policy-model scopes a contract to exact paths and directory prefixes', () => {
  assert.equal(pathScopeContains('src/herdr/', contract), true);
  assert.equal(pathScopeContains('src/herdr/*', contract), true);
  assert.equal(pathScopeContains('src/herdr/**', contract), true);
  assert.equal(pathScopeContains(contract, contract), true);
  assert.equal(pathScopeContains(contract, 'src/herdr/'), false, 'a file scope cannot contain a directory scope');
  assert.equal(pathScopeContains('src/herdrx/', contract), false);
  assert.equal(pathScopeContains('src/', 'src/herdr/'), true);
  assert.equal(pathScopesOverlap(contract, 'src/herdr/'), true);
  assert.equal(pathScopesOverlap('src/github.ts', 'src/herdr/'), false);
});

test('unit:bootstrap-policy-model schema accepts an operator declaration and refuses a forged audit trail', () => {
  const parsed = criterionSchema.parse({ id: 'AC-1', text: 'Recovery is proven', proofs: [harnessProof], bootstrap: { reason: 'Introduces the harness', contractPaths: [contract] } });
  assert.deepEqual(parsed.bootstrap, { reason: 'Introduces the harness', contractPaths: [contract] });
  assert.throws(() => criterionSchema.parse({ id: 'AC-1', text: 'x', proofs: [harnessProof], bootstrap: { reason: 'Introduces the harness', contractPaths: [contract], declaredBy: 'implementer' } }), 'a client cannot submit its own declaredBy');
  assert.throws(() => criterionSchema.parse({ id: 'AC-1', text: 'x', proofs: [harnessProof], bootstrap: { reason: '   ', contractPaths: [contract] } }), 'a bootstrap deferral requires a reason');
  assert.throws(() => criterionSchema.parse({ id: 'AC-1', text: 'x', proofs: [harnessProof], bootstrap: { reason: 'Introduces the harness', contractPaths: [] } }), 'a bootstrap deferral requires a contract');
  assert.throws(() => criterionSchema.parse({ id: 'AC-1', text: 'x', proofs: [harnessProof], bootstrap: { reason: 'Introduces the harness', contractPaths: [contract, contract] } }), 'contract paths must be unique');
});

// ---------------------------------------------------------------------------
// integration:bootstrap-policy-gate — the live acceptance gate over the store.
// ---------------------------------------------------------------------------

test('integration:bootstrap-policy-gate lands a bootstrap candidate on review, CI and its remaining proofs', async () => {
  const work = await submitted({ title: 'Introduce the recovery harness', plannedFiles: ['src/herdr/', 'tests/'],
    criteria: [{ id: 'AC-1', text: 'Recovery is proven', proofs: [harnessProof], bootstrap: { reason: 'This candidate introduces the harness the proof needs', contractPaths: [contract] } },
      { id: 'AC-2', text: 'The supervisor stops cleanly', proofs: ['unit:supervisor-stop'] }] });

  const stamped = work.criteria[0].bootstrap!;
  assert.equal(stamped.declaredBy, 'operator', 'the declaration is attributed to the authenticated operator');
  assert.equal(stamped.policyRevision, 1);
  assert.ok(Date.parse(stamped.declaredAt) > 0, 'the declaration carries a server-stamped time');
  assert.deepEqual(stamped.contractPaths, [contract]);

  assert.deepEqual(acceptance(work).reasons, ['AC-2: unit:supervisor-stop needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy'],
    'the deferred proof is not demanded of this candidate; the remaining criterion still is');

  const proven = await prove(work, 'unit:supervisor-stop');
  assert.deepEqual(acceptance(proven).reasons, [], 'review, CI and the remaining proofs are enough for a bootstrap candidate');
  assert.notEqual(proven.stage, 'acceptance');

  assert.deepEqual(bootstrapObligations(await all()).filter(obligation => obligation.workId === work.id),
    [{ key: work.key, workId: work.id, criterionId: 'AC-1', proof: harnessProof, ...stamped }], 'the deferred proof is recorded as an obligation on the contract path');
  assert.ok(obligationLedger(await all()).some(entry => entry.workId === work.id && entry.proof === harnessProof));
  assert.equal(proofPreview(proven, await all()).find(row => row.proof === harnessProof)!.status, 'deferred');
  assert.ok(diagnose(proven, await all(), Date.now()).some(entry => entry.kind === 'bootstrap-deferred'));

  const history = await store.events(work.id);
  assert.ok(history.some(event => event.kind === 'create' && event.actor === operator.id
    && JSON.stringify(event.payload.details).includes('This candidate introduces the harness the proof needs')), 'the declaration and its reason are in append-only history');
});

test('integration:bootstrap-policy-gate still refuses a bootstrap candidate without review or CI', async () => {
  const work = await submitted({ title: 'Bootstrap without review', plannedFiles: ['src/noreview/'],
    criteria: [{ id: 'AC-1', text: 'Recovery is proven', proofs: ['integration:noreview-harness'], bootstrap: { reason: 'Introduces the harness', contractPaths: ['src/noreview/engine.ts'] } }] },
  { reviews: [], checks: [{ name: 'test', result: 'failure', appId: 15368 }] });
  assert.deepEqual(acceptance(work).reasons, [], 'the only criterion is deferred');
  assert.equal(work.gates.find(gate => gate.name === 'review')!.passed, false);
  assert.equal(work.gates.find(gate => gate.name === 'test')!.passed, false);
  assert.equal(work.stage, 'review', 'a deferred proof never advances a candidate past review and CI');
});

test('integration:bootstrap-policy-gate confines a contract to the declaring item’s planned files', async () => {
  await assert.rejects(engine.execute(operator, 'create', null, { title: 'Contract outside containment', plannedFiles: ['src/herdr/'],
    criteria: [{ id: 'AC-1', text: 'Recovery is proven', proofs: [harnessProof], bootstrap: { reason: 'Introduces the harness', contractPaths: ['src/github.ts'] } }] }, id()),
  /Bootstrap contract paths for AC-1 must lie inside/, 'an operator cannot bind an obligation to a contract this change does not own');
  await assert.rejects(engine.execute(operator, 'create', null, { title: 'Contract wider than containment', plannedFiles: [contract],
    criteria: [{ id: 'AC-1', text: 'Recovery is proven', proofs: [harnessProof], bootstrap: { reason: 'Introduces the harness', contractPaths: ['src/herdr/'] } }] }, id()),
  /Bootstrap contract paths for AC-1 must lie inside/, 'a contract cannot be widened beyond the declared planned files');
});

test('integration:bootstrap-policy-gate refuses to defer an E2E proof whose scenario pin cannot travel', async () => {
  await assert.rejects(engine.execute(operator, 'create', null, { title: 'Defer a scenario proof', plannedFiles: ['src/e2e-defer/'],
    criteria: [{ id: 'AC-1', text: 'The journey works', proofs: ['e2e:some-journey'], bootstrap: { reason: 'Introduces the harness', contractPaths: ['src/e2e-defer/engine.ts'] } }] }, id()),
  /cannot use bootstrap mode: an E2E proof pins a scenario version/, 'an unregistered scenario pin cannot be smuggled into an obligation');
});

test('integration:bootstrap-policy-gate lets an operator declare and withdraw the deferral through a requirement revision', async () => {
  let work = await engine.execute(operator, 'create', null, { title: 'Deferral declared by revision', plannedFiles: ['src/revised/'],
    criteria: [{ id: 'AC-1', text: 'Recovery is proven', proofs: ['integration:revised-harness'] }] }, id());
  const revision = { expectedPolicyRevision: work.policyRevision, reason: 'The harness ships with this change', dependencies: [], plannedFiles: ['src/revised/'], exclusiveResources: [],
    criteria: [{ id: 'AC-1', text: 'Recovery is proven', proofs: ['integration:revised-harness'], bootstrap: { reason: 'Introduces the harness', contractPaths: ['src/revised/engine.ts'] } }] };
  work = await engine.execute(operator, 'requirements', work.id, revision, id());
  assert.equal(work.criteria[0].bootstrap!.declaredBy, 'operator');
  assert.equal(work.criteria[0].bootstrap!.policyRevision, 2);
  const declaredAt = work.criteria[0].bootstrap!.declaredAt;

  work = await engine.execute(operator, 'requirements', work.id, { ...revision, expectedPolicyRevision: work.policyRevision, reason: 'Unrelated clarification' }, id());
  assert.equal(work.criteria[0].bootstrap!.declaredAt, declaredAt, 'an unchanged declaration keeps its original attribution');
  assert.equal(work.criteria[0].bootstrap!.policyRevision, 2);

  work = await engine.execute(operator, 'requirements', work.id, { ...revision, expectedPolicyRevision: work.policyRevision, reason: 'The harness exists on main now',
    criteria: [{ id: 'AC-1', text: 'Recovery is proven', proofs: ['integration:revised-harness'] }] }, id());
  assert.equal(work.criteria[0].bootstrap, undefined, 'withdrawing the deferral restores the ordinary proof requirement');
  assert.deepEqual(bootstrapObligations(await all()).filter(obligation => obligation.workId === work.id), []);
});

// ---------------------------------------------------------------------------
// integration:bootstrap-policy-inheritance — the obligation follows the contract.
// ---------------------------------------------------------------------------

test('integration:bootstrap-policy-inheritance requires the deferred proof of the next change on that contract', async () => {
  const origin = await submitted({ title: 'Introduce the inherited harness', plannedFiles: ['src/inherit/'],
    criteria: [{ id: 'AC-1', text: 'Inheritance is proven', proofs: ['integration:inherit-harness'], bootstrap: { reason: 'Introduces the harness', contractPaths: ['src/inherit/engine.ts'] } }] });
  assert.deepEqual(acceptance(origin).reasons, []);

  const heir = await submitted({ title: 'Change the same contract', plannedFiles: ['src/inherit/engine.ts'],
    criteria: [{ id: 'AC-1', text: 'The change behaves', proofs: ['unit:heir'] }] });
  assert.deepEqual(acceptance(heir).reasons.slice().sort(), [
    'AC-1: unit:heir needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy',
    `Bootstrap obligation inherited from ${origin.key} AC-1: integration:inherit-harness needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy`,
  ].sort(), 'the deferred proof is inherited as a required criterion');
  assert.deepEqual(inheritedObligations(heir, await all()).map(obligation => obligation.proof), ['integration:inherit-harness']);
  assert.ok(diagnose(heir, await all(), Date.now()).some(entry => entry.kind === 'bootstrap-obligation'));

  const partial = await prove(heir, 'unit:heir');
  assert.deepEqual(acceptance(partial).reasons, [`Bootstrap obligation inherited from ${origin.key} AC-1: integration:inherit-harness needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy`],
    'the inheriting change cannot pass acceptance on its own proofs alone');
  const untrusted = await engine.execute(worker, 'evidence', heir.id, { proof: 'integration:inherit-harness', sha: head, baseSha: base, policyRevision: heir.policyRevision, result: 'pass', executed: 4, skipped: 0 }, id());
  assert.equal(acceptance(untrusted).reasons.length, 1, 'a worker assertion does not satisfy an inherited obligation');
  const complete = await prove(heir, 'integration:inherit-harness');
  assert.deepEqual(acceptance(complete).reasons, []);

  const unrelated = await submitted({ title: 'Touch a different file', plannedFiles: ['src/unrelated.ts'],
    criteria: [{ id: 'AC-1', text: 'The change behaves', proofs: ['unit:unrelated'] }] });
  assert.deepEqual(inheritedObligations(unrelated, await all()), [], 'work outside the contract inherits nothing');
});

test('integration:bootstrap-policy-inheritance refuses a second deferral of an inherited obligation', async () => {
  await submitted({ title: 'Introduce the renewable harness', plannedFiles: ['src/renew/'],
    criteria: [{ id: 'AC-1', text: 'Renewal is proven', proofs: ['integration:renew-harness'], bootstrap: { reason: 'Introduces the harness', contractPaths: ['src/renew/engine.ts'] } }] });
  await assert.rejects(engine.execute(operator, 'create', null, { title: 'Defer the inherited proof again', plannedFiles: ['src/renew/engine.ts'],
    criteria: [{ id: 'AC-1', text: 'Renewal is proven later', proofs: ['integration:renew-harness'], bootstrap: { reason: 'Still inconvenient', contractPaths: ['src/renew/engine.ts'] } }] }, id()),
  /is already a bootstrap obligation inherited from/, 'a deferral cannot be renewed by the change that inherits it');

  let heir = await engine.execute(operator, 'create', null, { title: 'Inherit the renewable harness', plannedFiles: ['src/renew/engine.ts'],
    criteria: [{ id: 'AC-1', text: 'Renewal is proven later', proofs: ['integration:renew-harness'] }] }, id());
  await assert.rejects(engine.execute(operator, 'requirements', heir.id, { expectedPolicyRevision: heir.policyRevision, reason: 'Defer it once more', dependencies: [], plannedFiles: ['src/renew/engine.ts'], exclusiveResources: [],
    criteria: [{ id: 'AC-1', text: 'Renewal is proven later', proofs: ['integration:renew-harness'], bootstrap: { reason: 'Still inconvenient', contractPaths: ['src/renew/engine.ts'] } }] }, id()),
  /is already a bootstrap obligation inherited from/, 'a requirement revision cannot renew an inherited deferral either');
  heir = await current(heir.id);
  assert.equal(heir.criteria[0].bootstrap, undefined, 'the refused revision left the requirements unchanged');
});

test('integration:bootstrap-policy-inheritance clears the obligation once a delivered change proves it', async () => {
  const origin = await submitted({ title: 'Introduce the dischargeable harness', plannedFiles: ['src/discharge/'],
    criteria: [{ id: 'AC-1', text: 'Discharge is proven', proofs: ['integration:discharge-harness'], bootstrap: { reason: 'Introduces the harness', contractPaths: ['src/discharge/engine.ts'] } }] });
  const heir = await submitted({ title: 'Prove the dischargeable harness', plannedFiles: ['src/discharge/engine.ts'],
    criteria: [{ id: 'AC-1', text: 'The change behaves', proofs: ['unit:discharge-heir'] }] });
  await prove(heir, 'unit:discharge-heir');
  const proven = await prove(heir, 'integration:discharge-harness');
  assert.deepEqual(acceptance(proven).reasons, []);
  assert.equal(bootstrapObligations(await all()).filter(obligation => obligation.workId === origin.id).length, 1, 'an unmerged proof leaves the obligation standing');

  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{stage}','\"done\"') WHERE id=$1", [heir.id]);
  assert.deepEqual(bootstrapObligations(await all()).filter(obligation => obligation.workId === origin.id), [], 'delivering the proof discharges the obligation');
  const after = await submitted({ title: 'Touch the discharged contract', plannedFiles: ['src/discharge/engine.ts'],
    criteria: [{ id: 'AC-1', text: 'The change behaves', proofs: ['unit:discharge-after'] }] });
  assert.deepEqual(inheritedObligations(after, await all()), [], 'later work does not inherit a discharged obligation');
});

// ---------------------------------------------------------------------------
// Delivery reconciliation. When the in-flight merge execution is gone by the time
// GitHub reports the merge, authorization is re-derived from the event history.
// That fallback must demand exactly what the acceptance gate demanded: a deferred
// proof is excluded, an inherited obligation is not.
// ---------------------------------------------------------------------------

const coordinator: Principal = { id: 'merge-coordinator', role: 'coordinator' };

/** Every candidate lands on one managed branch, so the queue is global: leave only this entry. */
const soleQueueEntry = (workId: string) =>
  store.pool.query("UPDATE work_items SET document=document-'queue' WHERE id<>$1 AND document->>'stage'<>'done'", [workId]);

/** Publish the validated speculative tip the queue head needs before it may merge. */
async function queueHead(work: Work) {
  await soleQueueEntry(work.id);
  const speculation = { ref: queueRef(work.key), tip: work.candidate!.sha, base: work.candidate!.baseSha, baseTree: 'c'.repeat(40),
    predecessors: [], policyRevision: work.policyRevision, publishedAt: new Date().toISOString() };
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{queue,speculation}',$2::jsonb) WHERE id=$1", [work.id, JSON.stringify(speculation)]);
  return engine.observe(work.id, (await current(work.id)).revision, observation(work));
}

/**
 * Deliver the queue head through a verified execution whose live record is then gone, so the
 * merge observation has to fall back to the authorized snapshot in the event history. `between`
 * runs after verification and before GitHub reports the merge.
 */
async function deliverFromHistory(work: Work, between?: () => Promise<unknown>) {
  const ready = await queueHead(work);
  assert.deepEqual(ready.gates.filter(gate => !gate.passed).map(gate => gate.name), [], 'the candidate must be merge-ready before delivery');
  const granted = await engine.acquireMerge(coordinator, ready.id, { expectedRevision: ready.revision, sha: head, baseSha: base, policyRevision: ready.policyRevision }, id());
  const verified = await engine.verifyMerge(coordinator, ready.id, { executionId: granted.execution.id }, { ...observation(ready), prState: 'open', draft: false }, id());
  await delay(5);
  const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString();
  await delay(5);
  if (between) await between();
  // The execution record is gone from the document; only the event history still carries it.
  await store.pool.query("UPDATE work_items SET document=document-'mergeExecution' WHERE id=$1", [work.id]);
  return engine.observe(work.id, verified.revision, { ...observation(ready), merged: true, mergedAt, mergeSha: 'e'.repeat(40) });
}

test('integration:bootstrap-policy-gate reconciles a delivered bootstrap candidate from event history', async () => {
  const work = await submitted({ title: 'Deliver the deferring change', plannedFiles: ['src/deliver/'],
    criteria: [{ id: 'AC-1', text: 'The harness proves itself later', proofs: ['integration:deliver-harness'], bootstrap: { reason: 'Introduces the harness', contractPaths: ['src/deliver/engine.ts'] } },
      { id: 'AC-2', text: 'The change behaves', proofs: ['unit:deliver'] }] });
  assert.deepEqual(acceptance(await prove(work, 'unit:deliver')).reasons, []);

  const delivered = await deliverFromHistory(await current(work.id));
  assert.equal(delivered.stage, 'done', 'a deferred proof has no evidence by design and must not read as an unauthorized merge');
  assert.deepEqual(delivered.violations, []);
  assert.ok(delivered.delivery?.authorizationRevision, 'the delivery records the revision that authorized it');
  assert.deepEqual(bootstrapObligations(await all()).filter(obligation => obligation.workId === work.id).map(obligation => obligation.proof),
    ['integration:deliver-harness'], 'delivering the deferral leaves the obligation standing for the next change on the contract');
});

test('integration:bootstrap-policy-inheritance re-checks an inherited obligation at the merge cutoff', async () => {
  await submitted({ title: 'Introduce the delivered harness', plannedFiles: ['src/cutoff/'],
    criteria: [{ id: 'AC-1', text: 'Cutoff is proven', proofs: ['integration:cutoff-harness'], bootstrap: { reason: 'Introduces the harness', contractPaths: ['src/cutoff/engine.ts'] } }] });
  const heir = await submitted({ title: 'Prove the inherited harness', plannedFiles: ['src/cutoff/engine.ts'],
    criteria: [{ id: 'AC-1', text: 'The change behaves', proofs: ['unit:cutoff-heir'] }] });
  await prove(heir, 'unit:cutoff-heir');
  assert.deepEqual(acceptance(await prove(heir, 'integration:cutoff-harness')).reasons, []);
  const delivered = await deliverFromHistory(await current(heir.id));
  assert.equal(delivered.stage, 'done', 'an heir that ran the inherited proof delivers through the same fallback');
  assert.deepEqual(delivered.violations, []);

  // An obligation declared while a candidate is mid-merge is still binding at reconciliation:
  // the inherited proof is not in the heir's own criteria, so only requiredProofs sees it.
  const late = await submitted({ title: 'Change the unproven contract', plannedFiles: ['src/late/engine.ts'],
    criteria: [{ id: 'AC-1', text: 'The change behaves', proofs: ['unit:late-heir'] }] });
  assert.deepEqual(acceptance(await prove(late, 'unit:late-heir')).reasons, []);
  const refused = await deliverFromHistory(await current(late.id), () => engine.execute(operator, 'create', null,
    { title: 'Introduce the late harness', plannedFiles: ['src/late/'],
      criteria: [{ id: 'AC-1', text: 'Late is proven', proofs: ['integration:late-harness'], bootstrap: { reason: 'Introduces the harness', contractPaths: ['src/late/engine.ts'] } }] }, id()));
  assert.notEqual(refused.stage, 'done', 'an unproven inherited obligation is not an authorized merge');
  assert.ok(refused.violations.includes('Merge observed without a prior authorization for this candidate'));
  assert.deepEqual(requiredProofs(refused, await all()).slice().sort(), ['integration:late-harness', 'unit:late-heir']);
});

// ---------------------------------------------------------------------------
// integration:bootstrap-policy-authority — who may declare the mode.
// ---------------------------------------------------------------------------

const bootstrapCriteria = (slug: string, reason = 'Introduces the harness') =>
  [{ id: 'AC-1', text: 'Authority is proven', proofs: [`integration:${slug}-harness`], bootstrap: { reason, contractPaths: [`src/${slug}/engine.ts`] } }];
const agent = (capabilities: string[]): Principal => ({ id: 'planner', role: 'operator-agent', capabilities: capabilities as Principal['capabilities'], scope: { repositories: ['owner/project'], workItems: ['*'] } });

test('integration:bootstrap-policy-authority keeps bootstrap mode away from workers', async () => {
  const input = { title: 'Worker declares bootstrap', plannedFiles: ['src/worker-authority/'], criteria: bootstrapCriteria('worker-authority') };
  await assert.rejects(engine.execute(worker, 'create', null, input, id()), /Operator permission required/, 'a worker cannot create work in bootstrap mode');

  const work = await submitted({ title: 'Worker revises into bootstrap', plannedFiles: ['src/worker-authority/'],
    criteria: [{ id: 'AC-1', text: 'Authority is proven', proofs: ['integration:worker-authority-harness'] }] });
  await assert.rejects(engine.execute(worker, 'requirements', work.id, { expectedPolicyRevision: work.policyRevision, reason: 'Defer my own proof', dependencies: [], plannedFiles: ['src/worker-authority/'], exclusiveResources: [], criteria: bootstrapCriteria('worker-authority') }, id()),
    /Operator permission required/, 'a worker cannot revise its own criteria into bootstrap mode');
  assert.equal((await current(work.id)).criteria[0].bootstrap, undefined);
  assert.deepEqual(acceptance(await current(work.id)).reasons,
    ['AC-1: integration:worker-authority-harness needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy'],
    'the worker’s own proof requirement stands');
});

test('integration:bootstrap-policy-authority requires the explicit policy:bootstrap capability of an operator agent', async () => {
  const input = { title: 'Agent declares bootstrap', description: '', plannedFiles: ['src/agent-authority/'], criteria: bootstrapCriteria('agent-authority'), reason: 'Harness ships with this change', policy: { checks: ['test'], review: true } };
  await assert.rejects(engine.execute(agent(['intent:create', 'policy:requirements']), 'create', null, input, id()),
    /Capability policy:bootstrap is required/, 'policy:requirements alone does not authorize a deferral');

  const declared = await engine.execute(agent(['intent:create', 'policy:bootstrap']), 'create', null, input, id());
  assert.equal(declared.criteria[0].bootstrap!.declaredBy, 'planner', 'the declaration is attributed to the operator agent, not the request');

  // An agent may still add requirements without the capability, and may withdraw a deferral.
  let work = await engine.execute(operator, 'create', null, { title: 'Agent revises a deferral', plannedFiles: ['src/revised-authority/'], criteria: bootstrapCriteria('revised-authority') }, id());
  const revision = { expectedPolicyRevision: work.policyRevision, reason: 'Scope clarified', dependencies: [], plannedFiles: ['src/revised-authority/'], exclusiveResources: [] };
  await assert.rejects(engine.execute(agent(['policy:requirements']), 'requirements', work.id, { ...revision,
    criteria: bootstrapCriteria('revised-authority', 'A different excuse') }, id()),
  /Capability policy:bootstrap is required/, 'changing a declaration needs the capability');
  work = await engine.execute(agent(['policy:requirements']), 'requirements', work.id, { ...revision, criteria: bootstrapCriteria('revised-authority') }, id());
  assert.equal(work.criteria[0].bootstrap!.declaredBy, 'operator', 'carrying an unchanged declaration forward preserves its original author');
  work = await engine.execute(agent(['policy:requirements']), 'requirements', work.id, { ...revision, expectedPolicyRevision: work.policyRevision,
    criteria: [{ id: 'AC-1', text: 'Authority is proven', proofs: ['integration:revised-authority-harness'] }] }, id());
  assert.equal(work.criteria[0].bootstrap, undefined, 'withdrawing a deferral strengthens the gate and needs no extra capability');
});

test('integration:bootstrap-policy-authority refuses a declaration outside the agent’s repository scope', async () => {
  const outside = { ...agent(['intent:create', 'policy:bootstrap']), scope: { repositories: ['other/project'], workItems: ['*'] } };
  await assert.rejects(engine.execute(outside, 'create', null, { title: 'Out of scope', description: '', plannedFiles: ['src/scoped-authority/'], criteria: bootstrapCriteria('scoped-authority'), reason: 'Harness ships with this change', policy: { checks: ['test'], review: true } }, id()),
    /outside this operator-agent scope/);
});

// ---------------------------------------------------------------------------
// manual:bootstrap-policy-docs-ui — the operator-facing explanation must exist.
// ---------------------------------------------------------------------------

test('manual:bootstrap-policy-docs-ui documents the mode and its audit trail for operators', async () => {
  for (const page of ['docs/protocol.md', 'docs/operations.md']) {
    const text = await readFile(new URL(`../${page}`, import.meta.url), 'utf8');
    assert.match(text, /## Bootstrap/i, `${page} must document bootstrap mode`);
    assert.match(text, /contractPaths/, `${page} must name the contract the obligation binds to`);
    assert.match(text, /policy:bootstrap/, `${page} must state the capability the mode requires`);
  }
  const dashboard = await readFile(new URL('../web/main.tsx', import.meta.url), 'utf8');
  assert.match(dashboard, /Bootstrap obligations/, 'the dashboard lists the outstanding obligations');
  assert.match(dashboard, /ac\.bootstrap\.declaredBy/, 'the dashboard names who declared a deferral and when');
  const editor = await readFile(new URL('../web/requirements.tsx', import.meta.url), 'utf8');
  assert.match(editor, /Bootstrap contract paths/, 'an operator can declare the contract from the dashboard');
});
