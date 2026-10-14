import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store, save } from '../src/store.js';
import { Refusal, type Principal } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import assert from 'node:assert/strict';
import { determineLane, laneRequiresProof, laneSpeedTargets, laneRequirements, reworkNeedsApprover, type Lane } from '../src/model/policy.js';
import { requiredProofs } from '../src/model/bootstrap.js';
import { evaluate } from '../src/model/gates.js';
import { evaluateLandability, landabilityRefusals } from '../src/model/landability.js';
import { reviewNeed } from '../src/model/dispatch.js';
import { producerGroupDecisions } from '../src/model/mechanical-proofs.js';
import type { Observation, Work } from '../src/model/work.js';

// GY-883: risk lanes. The ceremony an item runs is decided by the risk of what it changes: low
// lands with its required CI checks green and one approving review — the producer-run proofs and
// manual attestations its criteria name are not required of it, and its reworks need no approver
// decision; medium adds its producer-run proofs; high keeps the full path, manual attestations and
// rework approval included. An e2e proof and an inherited bootstrap obligation are required in
// every lane. The lane is decided by the shipped path policy in src/model/policy.ts from both
// endpoints of every renamed file, and is an input to the one landability verdict in
// src/model/gates.ts, which decides from it which facts it requires.

const head = 'c'.repeat(40), base = 'd'.repeat(40);

const observed = (paths: string[]): Observation => ({
  candidate: { sha: head, baseSha: base, pr: 7, branch: 'graphyard/gy-1-1', author: 'worker' },
  checks: [{ name: 'test', result: 'success', appId: 15368 }],
  reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }],
  merged: false, mergeSha: null, mergeable: true, protected: true,
  files: paths, at: new Date().toISOString(),
  scopeFiles: paths.map(path => ({ path, status: 'modified' as const, sha: 'a'.repeat(40), additions: 1, deletions: 1, binary: false })),
});

const item = (paths: string[], proofs: string[] = ['unit:core-flow', 'manual:safety-attestation'], planned: string[] = []): Work => ({
  id: 'w', key: 'GY-1', title: 'lane fixture', type: 'feature', description: '', priority: 2,
  dependencies: [], criteria: [{ id: 'AC-1', text: 'The core flow is proven.', proofs }], policy: { checks: ['test'], review: true },
  plannedFiles: planned, stage: 'review', revision: 1, policyRevision: 1, ready: true, epoch: 1, lease: null,
  workspaces: [{ host: 'test', path: '/tmp/fixture', branch: 'graphyard/gy-1-1', epoch: 1, owner: 'worker' }],
  submission: { pr: 7, epoch: 1 }, candidate: { sha: head, baseSha: base, pr: 7, branch: 'graphyard/gy-1-1', author: 'worker' },
  reworkRequested: false, scenarioRequirements: [], evidence: [], observation: observed(paths), blocker: null, gates: [], violations: [],
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stageEnteredAt: new Date().toISOString(),
} as unknown as Work);

const verdict = (work: Work) => evaluate(work, [work], new Date(), [15368]);
/**
 * The landability verdict's acceptance family: the proofs the lane requires. Since GY-1235 it is no
 * merge gate of its own (proofs gate nothing), but the verdict still decides it from the lane.
 */
const acceptance = (work: Work, all: Work[] = [work]) => { const reasons = landabilityRefusals(evaluateLandability(work, all, new Date()), 'acceptance'); return { passed: reasons.length === 0, reasons }; };

// AC-1: the shipped path policy assigns every item a lane: high for migrations/schema,
// auth/credentials, the repository's real schema and authentication surfaces (src/store/,
// db/migrations/, src/server/auth, src/server/principals), the public API and the installation
// and deployment surfaces; low for test-only, docs-only and single-module changes; medium for
// the rest.
test('unit:risk-lane-assigned — the shipped path policy classifies high-risk paths as high', () => {
  assert.equal(determineLane(['migrations/schema/001_initial.sql']), 'high');
  assert.equal(determineLane(['auth/credentials/oauth.ts']), 'high');
  assert.equal(determineLane(['deploy/install/setup.sh']), 'high');
  assert.equal(determineLane(['src/server/routes/work.ts']), 'high', 'the public API is high-risk');
  assert.equal(determineLane(['src/server/index.ts']), 'high', 'the HTTP API assembler that wires the public surface is high-risk');
  assert.equal(determineLane(['src/install/secrets.ts']), 'high', 'the installation surface is high-risk');
  assert.equal(determineLane(['deploy/helm/graphyard/templates/secret.yaml']), 'high', 'the deployment tree is high-risk');
  assert.equal(determineLane(['Dockerfile']), 'high', 'the image build is high-risk');
  assert.equal(determineLane(['compose.yaml']), 'high', 'the compose deployment is high-risk');
  // One high-risk path is enough, whatever else changed beside it.
  assert.equal(determineLane(['docs/notes.md', 'tests/x.test.ts', 'migrations/schema/002_add.sql']), 'high');
  // A high-risk path is never lowered by the single-module or docs rules.
  assert.equal(determineLane(['src/install/secrets.ts', 'src/install/limits.ts']), 'high');
});

test('unit:risk-lane-assigned — the repository\u2019s real schema and authentication surfaces are high-risk', () => {
  assert.equal(determineLane(['src/store/schema.ts']), 'high', 'the database schema registry is high-risk');
  assert.equal(determineLane(['src/store/tables/work.ts']), 'high', 'a schema table is high-risk');
  assert.equal(determineLane(['src/store/tables.ts']), 'high', 'the table registry is high-risk');
  assert.equal(determineLane(['src/server/auth.ts']), 'high', 'authentication is high-risk');
  assert.equal(determineLane(['src/server/principals.ts']), 'high', 'principal identity is high-risk');
  assert.equal(determineLane(['src/server/main.ts']), 'high', 'the server bootstrap that loads credentials is high-risk');
  assert.equal(determineLane(['src/operator-agent.ts']), 'high', 'the operator agent\'s credential handling is high-risk');
  assert.equal(determineLane(['src/proof-grants.ts']), 'high', 'proof-authority grants are high-risk');
  assert.equal(determineLane(['src/store/pools.ts']), 'high', 'the persistence layer around the schema rides with it');
  assert.equal(determineLane(['src/store/tables/work.ts', 'src/store/schema.ts']), 'high', 'not lowered by the single-module rule');
});

test('unit:risk-lane-assigned — test-only, docs-only and single-module changes are low', () => {
  assert.equal(determineLane(['tests/risk-lanes.test.ts']), 'low');
  assert.equal(determineLane(['tests/helpers/a.ts', 'tests/helpers/b.ts']), 'low');
  assert.equal(determineLane(['src/model/policy.test.ts']), 'low');
  assert.equal(determineLane(['docs/how-graphyard-works.md']), 'low');
  assert.equal(determineLane(['docs/glossary.md', 'README.md', 'AGENTS.md']), 'low');
  assert.equal(determineLane(['src/model/policy.ts']), 'low');
  assert.equal(determineLane(['src/model/policy.ts', 'src/model/gates.ts', 'src/model/work.ts']), 'low');
});

test('unit:risk-lane-assigned — everything else is medium, and an unknown change keeps the full high path', () => {
  assert.equal(determineLane(['src/model/policy.ts', 'src/cli/main.ts']), 'medium');
  assert.equal(determineLane(['src/model/gates.ts', 'tests/risk-lanes.test.ts', 'docs/glossary.md']), 'medium');
  assert.equal(determineLane(['src/a.ts', 'src/b.ts']), 'medium', 'sharing only src/ is not one module');
  // The shared prefix stops at the first divergent segment: a shared basename is not a shared module.
  assert.equal(determineLane(['src/model/index.ts', 'src/cli/index.ts']), 'medium', 'src/model/ and src/cli/ are two modules despite the shared tail');
  assert.equal(determineLane(['src/a/run.ts', 'src/b/run.ts', 'src/c/run.ts']), 'medium', 'every file sharing a basename is still three modules');
  assert.equal(determineLane(['package.json']), 'medium');
  assert.equal(determineLane([]), 'high', 'a change the policy cannot see waives nothing');
  assert.equal(determineLane(['src/model/policy.ts', 'deploy/install/setup.sh']), 'high', 'high wins over the single-module rule');
});

test('unit:risk-lane-assigned — a rename is classified from both of its endpoints', () => {
  const work = item(['src/model/secrets.ts']);
  work.observation = {
    ...observed(['src/model/secrets.ts']),
    scopeFiles: [{ path: 'src/model/secrets.ts', previousPath: 'src/install/secrets.ts', status: 'renamed' as const, sha: 'a'.repeat(40), additions: 1, deletions: 1, binary: false }],
  };
  assert.equal(verdict(work).lane, 'high', 'renaming a file out of the installation surface stays high: the source rides beside the destination');
  // And one into a high-risk tree is high from the destination alone.
  const into = item(['src/model/secrets.ts']);
  into.observation = {
    ...observed(['src/model/secrets.ts']),
    scopeFiles: [{ path: 'src/install/secrets.ts', previousPath: 'src/model/secrets.ts', status: 'renamed' as const, sha: 'a'.repeat(40), additions: 1, deletions: 1, binary: false }],
  };
  assert.equal(verdict(into).lane, 'high');
});

// AC-2: each lane's required set.
test('unit:lane-sets-required-gates — the shipped required set of each lane', () => {
  assert.deepEqual(laneRequirements('low'), { producerProofs: false, manualAttestations: false, reworkApprover: false });
  assert.deepEqual(laneRequirements('medium'), { producerProofs: true, manualAttestations: false, reworkApprover: false });
  assert.deepEqual(laneRequirements('high'), { producerProofs: true, manualAttestations: true, reworkApprover: true });
  for (const [lane, producer, manual] of [
    ['low', false, false], ['medium', true, false], ['high', true, true],
  ] as [Lane, boolean, boolean][]) {
    assert.equal(laneRequiresProof(lane, 'unit:core-flow'), producer, `${lane} ${producer ? 'requires' : 'does not require'} producer-run unit proofs`);
    assert.equal(laneRequiresProof(lane, 'integration:claim-safety'), producer, `${lane} ${producer ? 'requires' : 'does not require'} producer-run integration proofs`);
    assert.equal(laneRequiresProof(lane, 'manual:safety-attestation'), manual, `${lane} ${manual ? 'requires' : 'does not require'} manual attestations`);
    assert.equal(laneRequiresProof(lane, 'e2e:user-journey'), true, `${lane} requires e2e proofs`);
  }
});

test('unit:lane-sets-required-gates — a low-lane item is landable on its required CI checks and one approving review', () => {
  const work = item(['src/model/policy.ts']);
  const result = verdict(work);
  assert.equal(result.lane, 'low');
  assert.deepEqual(requiredProofs(work, [work]), [], 'no producer-run proof or manual attestation is required of a low item');
  assert.equal(acceptance(work).passed, true, acceptance(work).reasons.join('; '));
  for (const gate of ['review', 'test']) assert.equal(result.gates.find(entry => entry.name === gate)!.passed, true, `${gate} passes: ${result.gates.find(entry => entry.name === gate)!.reasons.join('; ')}`);
  // The CI checks and the one approving review still gate it.
  const red = item(['src/model/policy.ts']);
  red.observation = { ...observed(['src/model/policy.ts']), checks: [{ name: 'test', result: 'failure', appId: 15368 }] } as Observation;
  assert.equal(verdict(red).gates.find(gate => gate.name === 'test')!.passed, false, 'a red required check refuses a low item');
  const unreviewed = item(['src/model/policy.ts']);
  unreviewed.observation = { ...observed(['src/model/policy.ts']), reviews: [] };
  assert.equal(verdict(unreviewed).gates.find(gate => gate.name === 'review')!.passed, false, 'a low item still needs one approving review');
});

test('unit:lane-sets-required-gates — medium adds its producer proofs, high keeps today’s full path', () => {
  const medium = item(['src/model/a.ts', 'src/cli/b.ts']);
  assert.equal(verdict(medium).lane, 'medium');
  assert.deepEqual(requiredProofs(medium, [medium]), ['unit:core-flow'], 'medium requires the producer-run proof and no attestation');
  assert.deepEqual(acceptance(medium).reasons.map(reason => reason.split(' ')[1]), ['unit:core-flow']);
  const high = item(['auth/credentials/a.ts']);
  assert.equal(verdict(high).lane, 'high');
  assert.deepEqual(requiredProofs(high, [high]), ['unit:core-flow', 'manual:safety-attestation'], 'high requires both');
  assert.deepEqual(acceptance(high).reasons.map(reason => reason.split(' ')[1]), ['unit:core-flow', 'manual:safety-attestation']);
});

test('unit:lane-sets-required-gates — only a high-lane rework needs an approver decision', () => {
  assert.equal(reworkNeedsApprover(item(['tests/only.test.ts'])), false, 'a low rework is applied without an approver');
  assert.equal(reworkNeedsApprover(item(['src/model/a.ts', 'src/cli/b.ts'])), false, 'a medium rework is applied without an approver');
  assert.equal(reworkNeedsApprover(item(['src/server/auth.ts'])), true, 'a high rework waits for its independent approver');
  const unknown = item([]); unknown.observation = null;
  assert.equal(reworkNeedsApprover(unknown), true, 'an unobserved change rides high and keeps its approver');
});

test('unit:lane-sets-required-gates — an e2e proof and an inherited bootstrap obligation are required in every lane', () => {
  for (const [paths, lane] of [[['tests/x.test.ts'], 'low'], [['src/model/a.ts', 'src/cli/b.ts'], 'medium'], [['auth/credentials/a.ts'], 'high']] as [string[], Lane][]) {
    const work = item(paths, ['e2e:user-journey']);
    assert.equal(verdict(work).lane, lane);
    assert.equal(acceptance(work).reasons.some(reason => reason.includes('e2e:user-journey')), true, `${lane} keeps e2e proofs required`);
  }
  const defer = { reason: 'harness ships with this change', contractPaths: ['src/model/policy.ts'], declaredBy: 'operator', declaredAt: new Date().toISOString(), policyRevision: 1 };
  const source = {
    id: 's', key: 'GY-0', title: 'deferral source', type: 'feature', description: '', priority: 2, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'The contract is proven.', proofs: ['unit:deferred-contract'], bootstrap: defer }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/model/policy.ts'], stage: 'done', revision: 1, policyRevision: 1,
    ready: true, epoch: 1, lease: null, workspaces: [], submission: null, candidate: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stageEnteredAt: new Date().toISOString(),
  } as unknown as Work;
  const work = item(['src/model/gates.ts'], ['unit:core-flow'], ['src/model/policy.ts']);
  const result = evaluate(work, [work, source], new Date(), [15368]);
  const gate = acceptance(work, [work, source]);
  assert.equal(result.lane, 'low');
  assert.equal(gate.reasons.some(reason => reason.includes('Bootstrap obligation inherited') && reason.includes('unit:deferred-contract')), true,
    `the inherited obligation stands in the low lane: ${gate.reasons.join('; ')}`);
  assert.equal(gate.reasons.some(reason => reason.includes('unit:core-flow')), false, 'the item’s own producer-run proof is not required in low');
});

// The rework waiver is applied where the decision is requested: a low- or medium-lane rework is
// applied at once, recorded as approved by the risk lane; a high-lane one waits for its approver.
let teardown: (() => Promise<void>) | null = null;
after(async () => { await teardown?.(); });
let fixture: Promise<Awaited<ReturnType<typeof startLanes>>> | null = null;
const lanes = () => fixture ??= startLanes();
async function startLanes() {
  const repository = 'owner/lanes';
  const operator: Principal = { id: 'lane-operator', role: 'admin', sessionKind: 'human' };
  const implementer: Principal = { id: 'lane-implementer', role: 'worker', sessionKind: 'ai' };
  const credentials = [operator, implementer].map(principal => ({ ...principal, token: `lanes-${principal.id}-${'x'.repeat(32)}` }));
  const master = { id: 'lane-master', token: `lane-master-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'decision:rework', 'intent:unblock'] };
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 883;
  const database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('risk-lanes'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('lanes_test');
  const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/lanes_test`); await store.init();
  const engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  const http = server(engine, credentials);
  teardown = async () => { http.close(); await store.close(); await database.stop(); };
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const send = async (token: string, path: string, body: unknown, key: string = randomUUID()) => {
    const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const call = async (token: string, path: string, body: unknown, key?: string) => {
    const result = await send(token, path, body, key);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const decisions = async (key: string) => {
    const response = await fetch(`${url}/api/work/${key}/decisions`, { headers: { Authorization: `Bearer ${master.token}` } });
    return (await response.json() as { decisions: any[] }).decisions;
  };
  await call(credentials[0].token, 'operator-agents', { id: master.id, displayName: master.id, capabilities: master.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: master.token, reason: 'The master requests reworks' });
  let pr = 880;
  const submitted = async (title: string, paths: string[]) => {
    let work = await call(master.token, 'work', { title, plannedFiles: paths, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], reason: 'Lane fixture' }) as Work;
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
    work = await engine.execute(implementer, 'workspace', work.id, { epoch: work.epoch, host: 'lane-host', path: `/tmp/lanes/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, randomUUID());
    work = await engine.execute(implementer, 'submit', work.id, { epoch: work.epoch, pr: ++pr }, randomUUID());
    return engine.observe(work.id, work.revision, { ...observed(paths), candidate: { ...observed(paths).candidate, pr, branch: work.workspaces.at(-1)!.branch } });
  };
  // GY-612's f39aada7: the lane's approval commits, then the application is interrupted before
  // any outcome is recorded (a server fault on the engine call, as a killed request leaves it).
  const interrupted = async (title: string) => {
    const work = await submitted(title, ['src/model/lanes.ts']);
    const execute = engine.execute;
    engine.execute = (async (...args: Parameters<typeof execute>) => {
      if (args[1] === 'rework') { engine.execute = execute; throw new Error('connection terminated while applying the rework'); }
      return execute.apply(engine, args);
    }) as typeof execute;
    const failed = await send(master.token, `work/${work.key}/decide`, { action: 'rework', input: { previousWorkerStopped: true }, reason: 'The reviewer requested changes' });
    engine.execute = execute;
    assert.notEqual(failed.status, 200, 'the interrupted application answers no outcome');
    const [stranded] = await decisions(work.key);
    assert.equal(stranded.state, 'approved', 'the lane\u2019s approval committed');
    assert.equal(stranded.approvedBy, 'graphyard-risk-lane');
    assert.equal((await store.list()).find(item => item.id === work.id)!.reworkRequested, false, 'and nothing was applied');
    return { work, stranded };
  };
  return { engine, store, master, send, call, decisions, submitted, interrupted, implementer: credentials[1] };
}
test('unit:lane-sets-required-gates — a low- or medium-lane rework is applied as it is requested, and a high-lane one waits for its independent approver', { timeout: 120_000 }, async () => {
  const { store, master, call, submitted } = await lanes();
  for (const [title, paths, lane] of [['low-rework', ['src/model/lanes.ts'], 'low'], ['medium-rework', ['src/model/lanes.ts', 'src/cli/lanes.ts'], 'medium']] as [string, string[], Lane][]) {
    const work = await submitted(title, paths);
    assert.equal(work.lane, lane);
    const decision = await call(master.token, `work/${work.key}/decide`, { action: 'rework', input: { previousWorkerStopped: true }, reason: 'The reviewer requested changes' });
    assert.equal(decision.state, 'applied', `${lane}: the rework is applied with no approver decision`);
    assert.equal(decision.approvedBy, 'graphyard-risk-lane', `${lane}: the ledger names the lane as its ground`);
    assert.equal((await store.list()).find(item => item.id === work.id)!.reworkRequested, true);
  }
  const high = await submitted('high-rework', ['src/server/routes/lanes.ts']);
  assert.equal(high.lane, 'high');
  const pending = await call(master.token, `work/${high.key}/decide`, { action: 'rework', input: { previousWorkerStopped: true }, reason: 'The reviewer requested changes' });
  assert.equal(pending.state, 'requested', 'a high-lane rework waits for its independent approver');
  assert.equal((await store.list()).find(item => item.id === high.id)!.reworkRequested, false);
});

// GY-1394: a high-lane rework whose ground the record shows on the exact head — here the control
// plane's own test merge of the candidate onto the moved base conflicted — is applied as it is
// requested too. GitHub's conflict reading alone is no ground (GY-375): on a blocked or draft item,
// or one whose base has not moved, no test merge ever checked it, so that rework waits for its approver.
test('unit:rework-ground-recorded — a high-lane rework the record grounds is applied with no approver decision', { timeout: 120_000 }, async () => {
  const { engine, store, master, call, submitted } = await lanes();
  const tip = 'e'.repeat(40);
  const reread = async (id: string) => (await store.list()).find(item => item.id === id)!;
  const conflicting = async (title: string, paths: string[], extra: Partial<Observation> = {}) => {
    const work = await submitted(title, paths);
    assert.equal(work.lane, 'high');
    return engine.observe(work.id, (await reread(work.id)).revision, { ...observed(paths), candidate: { ...work.candidate! }, conflicting: true, mergeable: false, prState: 'open' as const, baseTip: tip, baseTipContained: false, ...extra });
  };
  // Unchecked readings: a draft, and a base that has not moved.
  for (const [title, extra] of [['unchecked-draft', { draft: true }], ['unchecked-unmoved', { baseTip: base, baseTipContained: true }]] as const) {
    const work = await conflicting(title, [`src/server/routes/${title}.ts`], extra);
    const pending = await call(master.token, `work/${work.key}/decide`, { action: 'rework', input: { previousWorkerStopped: true }, reason: 'GitHub reports a conflict with the base' });
    assert.equal(pending.state, 'requested', `${title}: an unchecked GitHub reading waits for the independent approver`);
    assert.equal((await reread(work.id)).reworkRequested, false);
  }
  // A blocked item's reading is unchecked too: the test merge does not run while it is blocked.
  const blocked = await conflicting('unchecked-blocked', ['src/server/routes/unchecked-blocked.ts']);
  await store.transaction(async db => {
    const current: Work = (await db.query('SELECT document FROM work_items WHERE id=$1 FOR UPDATE', [blocked.id])).rows[0].document;
    current.blocker = 'waiting on a credential';
    await save(db, current, 'lane-operator', 'test.blocked', new Date());
  });
  const held = await call(master.token, `work/${blocked.key}/decide`, { action: 'rework', input: { previousWorkerStopped: true }, reason: 'GitHub reports a conflict with the base' });
  assert.equal(held.state, 'requested', 'a blocked item\u2019s unchecked reading waits for the independent approver');
  // Confirmed: the control plane's test merge onto the moved tip conflicted for this head.
  const work = await conflicting('grounded-rework', ['src/server/routes/grounded.ts']);
  await store.transaction(async db => {
    const current: Work = (await db.query('SELECT document FROM work_items WHERE id=$1 FOR UPDATE', [work.id])).rows[0].document;
    current.baseRefresh = { at: new Date().toISOString(), base: tip, from: { sha: head, baseSha: base }, head: null, carry: null, merge: null, trigger: 'conflict confirmed', policyRevision: current.policyRevision,
      conflict: 'Merge of the base tip conflicts in src/server/routes/grounded.ts', conflictPaths: ['src/server/routes/grounded.ts'] } as unknown as Work['baseRefresh'];
    await save(db, current, 'lane-operator', 'test.base-refresh', new Date());
  });
  const decision = await call(master.token, `work/${work.key}/decide`, { action: 'rework', input: { previousWorkerStopped: true }, reason: 'The base refresh conflicted' });
  assert.equal(decision.state, 'applied', 'the record is the ground: no approver decision is needed');
  assert.equal(decision.approvedBy, 'graphyard-risk-lane');
  assert.match(decision.approvalReason, /candidate .* conflicts with base branch tip eeeeeeeeeeee in the control plane's own test merge, so the record is the rework's ground/);
  assert.equal((await reread(work.id)).reworkRequested, true);
  // The returned head keeps its submission, candidate and conflict until a new head is submitted,
  // but its ground is spent: the retry cap's rework after attempts that never submitted (GY-885)
  // judges those attempts, so it waits for the independent approver. A worker claimed the item since (GY-1579): those attempts are its newer grounds.
  await store.transaction(async db => {
    const current: Work = (await db.query('SELECT document FROM work_items WHERE id=$1 FOR UPDATE', [work.id])).rows[0].document;
    current.lastAssignment = { owner: 'lane-worker', epoch: current.epoch + 1, claimedAt: new Date(Date.now() + 1_000).toISOString() };
    await save(db, current, 'lane-operator', 'test.attempt', new Date());
  });
  const capped = await call(master.token, `work/${work.key}/decide`, { action: 'rework', input: { previousWorkerStopped: true, binding: `overlong-cap:${work.id}:${new Date().toISOString()}` }, reason: 'held: 3 attempts in a row ended without submitting' });
  assert.equal(capped.state, 'requested', 'a returned head\u2019s ground lets no later rework through');
  assert.equal(capped.approvedBy ?? null, null);
});

// GY-1110 AC-1: a lane-approved rework whose application recorded no outcome is resumed by the
// server on the next request for the item, without the original idempotency key, and lands applied.
test('unit:lane-rework-interrupted-resumes — the next request for the item resumes an interrupted lane rework', { timeout: 120_000 }, async () => {
  const { store, master, send, decisions, interrupted } = await lanes();
  const { work, stranded } = await interrupted('interrupted-rework');
  // An unrelated request, under a fresh key: it is refused on its own merits, yet the server
  // resumed the stranded rework before judging it.
  const unrelated = await send(master.token, `work/${work.key}/decide`, { action: 'unblock', input: { expectedRevision: 1 }, reason: 'Nothing to unblock' });
  assert.equal(unrelated.status, 409, JSON.stringify(unrelated.body));
  const [resumed] = await decisions(work.key);
  assert.equal(resumed.id, stranded.id);
  assert.equal(resumed.state, 'applied', 'the stranded rework lands applied');
  assert.equal(resumed.approvedBy, 'graphyard-risk-lane');
  assert.equal((await store.list()).find(item => item.id === work.id)!.reworkRequested, true, 'and the item is sent back for rework');
  // A later request finds nothing left to resume, and the outcome is recorded once.
  await send(master.token, `work/${work.key}/decide`, { action: 'unblock', input: { expectedRevision: 1 }, reason: 'Nothing to unblock' });
  const outcomes = (await decisions(work.key)).filter(entry => entry.id === stranded.id);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].state, 'applied');
});

// GY-1110 AC-2: a new rework request on an item whose standing lane-approved rework is unapplied is
// never refused 'already approved': the standing decision is resumed and answers it, or, when its
// application fails, the new request supersedes it — no human and no database edit.
test('unit:lane-rework-unapplied-not-blocking — a new rework request resumes or supersedes the unapplied standing rework', { timeout: 120_000 }, async () => {
  const { engine, store, master, send, decisions, interrupted } = await lanes();
  const rework = { action: 'rework', input: { previousWorkerStopped: true }, reason: 'The loop requests the rework again' };
  // Resumed: the standing decision applies and is the answer to the new request.
  const { work, stranded } = await interrupted('unapplied-resumed');
  const key = randomUUID();
  const again = await send(master.token, `work/${work.key}/decide`, rework, key);
  assert.equal(again.status, 200, `the new request is not refused: ${JSON.stringify(again.body)}`);
  assert.equal(again.body.id, stranded.id, 'the standing decision answers it');
  assert.equal(again.body.state, 'applied');
  assert.equal((await store.list()).find(item => item.id === work.id)!.reworkRequested, true);
  assert.deepEqual((await send(master.token, `work/${work.key}/decide`, rework, key)).body, again.body, 'its replay answers the same');
  assert.equal((await decisions(work.key)).length, 1, 'no second rework was recorded');
  // Superseded: the standing decision's application is refused now, so it settles failed and the
  // new request is recorded and applied in its place.
  const second = await interrupted('unapplied-superseded');
  const execute = engine.execute;
  engine.execute = (async (...args: Parameters<typeof execute>) => {
    if (args[1] === 'rework') { engine.execute = execute; throw new Refusal('The item moved on before the rework was applied', 409); }
    return execute.apply(engine, args);
  }) as typeof execute;
  const superseding = await send(master.token, `work/${second.work.key}/decide`, rework);
  engine.execute = execute;
  assert.equal(superseding.status, 200, `the new request is not refused: ${JSON.stringify(superseding.body)}`);
  assert.notEqual(superseding.body.id, second.stranded.id, 'a new decision supersedes the standing one');
  assert.equal(superseding.body.state, 'applied');
  const ledger = await decisions(second.work.key);
  assert.equal(ledger.find(entry => entry.id === second.stranded.id)!.state, 'failed', 'the standing decision settled failed');
  assert.equal((await store.list()).find(item => item.id === second.work.id)!.reworkRequested, true);
});

// GY-1265 (review follow-up of GY-1244): resumption is best-effort. An unexpected engine fault while
// resuming a stranded rework leaves it approved for the next request, and the unrelated request that
// triggered the resumption is still judged on its own merits rather than failing with the fault.
test('unit:lane-rework-resume-best-effort — an engine fault during resumption neither fails the triggering request nor settles the rework', { timeout: 120_000 }, async () => {
  const { engine, store, master, send, decisions, interrupted } = await lanes();
  const { work, stranded } = await interrupted('resume-faults');
  const execute = engine.execute;
  engine.execute = (async (...args: Parameters<typeof execute>) => {
    if (args[1] === 'rework') { engine.execute = execute; throw new Error('connection terminated while resuming the rework'); }
    return execute.apply(engine, args);
  }) as typeof execute;
  const unrelated = await send(master.token, `work/${work.key}/decide`, { action: 'unblock', input: { expectedRevision: 1 }, reason: 'Nothing to unblock' });
  const faulted = engine.execute === execute;
  engine.execute = execute;
  assert.equal(faulted, true, 'the resumption reached the engine and faulted');
  assert.equal(unrelated.status, 409, `the unblock is judged on its own merits, not failed by the fault: ${JSON.stringify(unrelated.body)}`);
  const [standing] = await decisions(work.key);
  assert.equal(standing.id, stranded.id);
  assert.equal(standing.state, 'approved', 'the faulted rework stays approved for the next request to resume');
  assert.equal((await store.list()).find(item => item.id === work.id)!.reworkRequested, false, 'and nothing was applied');
  // The next request resumes it.
  await send(master.token, `work/${work.key}/decide`, { action: 'unblock', input: { expectedRevision: 1 }, reason: 'Nothing to unblock' });
  const [resumed] = await decisions(work.key);
  assert.equal(resumed.state, 'applied');
  assert.equal((await store.list()).find(item => item.id === work.id)!.reworkRequested, true);
});

// GY-1265 (review follow-up of GY-1244): a caller without authority for the request it makes is
// refused before the request resumes any stranded rework, so an unauthorised request moves nothing.
test('unit:lane-rework-unauthorised-no-resume — an unauthorised decision request is refused before it resumes a stranded rework', { timeout: 120_000 }, async () => {
  const { store, master, send, decisions, interrupted, implementer } = await lanes();
  const { work, stranded } = await interrupted('unauthorised-resume');
  for (const body of [
    { action: 'unblock', input: { expectedRevision: 1 }, reason: 'Not mine to unblock' },
    { action: 'rework', input: { previousWorkerStopped: true }, reason: 'Not mine to rework' },
  ]) {
    const refused = await send(implementer.token, `work/${work.key}/decide`, body);
    assert.equal(refused.status, 403, `${body.action}: ${JSON.stringify(refused.body)}`);
    const ledger = await decisions(work.key);
    assert.equal(ledger.length, 1, `${body.action}: the refused request recorded nothing`);
    assert.equal(ledger[0].id, stranded.id);
    assert.equal(ledger[0].state, 'approved', `${body.action}: the stranded rework was not resumed by an unauthorised caller`);
    assert.equal((await store.list()).find(item => item.id === work.id)!.reworkRequested, false);
  }
  // An authorised request still resumes it.
  await send(master.token, `work/${work.key}/decide`, { action: 'unblock', input: { expectedRevision: 1 }, reason: 'Nothing to unblock' });
  assert.equal((await decisions(work.key))[0].state, 'applied');
});

// AC-3: lanes are inputs to the single landability verdict (GY-878), not separate required-check
// sets: the verdict takes the item's lane, decides from it which facts it requires, and reports
// the lane with its speed target.
test('unit:lanes-feed-verdict — the lane changes the verdict’s required facts and the verdict reports the lane’s target', () => {
  const required: Record<Lane, string[]> = { low: [], medium: [], high: [] };
  for (const [paths, lane, facts] of [
    [['tests/only.test.ts'], 'low', []],
    [['src/model/a.ts', 'src/cli/b.ts'], 'medium', ['unit:core-flow']],
    [['deploy/install/a.sh'], 'high', ['unit:core-flow', 'manual:safety-attestation']],
  ] as [string[], Lane, string[]][]) {
    // The same item, the same criteria, the same (empty) evidence: only the change's lane differs.
    const work = item(paths);
    const result = verdict(work);
    assert.equal(result.lane, lane);
    assert.equal(result.speedTarget, laneSpeedTargets[lane], `${lane} reports its own speed target beside the lane`);
    const gate = acceptance(work);
    required[lane] = gate.reasons.map(reason => reason.split(' ')[1]);
    assert.deepEqual(required[lane], facts, `${lane}: the verdict requires exactly ${facts.join(', ') || 'no proof'}`);
    assert.equal(gate.passed, facts.length === 0, `${lane}: ${facts.length ? 'refused until its facts are proven' : 'landable on CI and review alone'}`);
  }
  assert.notDeepEqual(required.low, required.medium);
  assert.notDeepEqual(required.medium, required.high);
});

test('unit:lanes-feed-verdict — the producer decision follows the lane’s required facts, and no lane holds the review for proofs', () => {
  const pending = (paths: string[], proofs: string[]) => {
    const work = item(paths, proofs);
    work.observation = { ...observed(paths), reviews: [], prState: 'open' as const, draft: false, baseTip: base, baseTipContained: true };
    return work;
  };
  // Medium and high require the producer-run proof: its group decision asks for it. Since GY-1235
  // CI runs it and the review is never held for it.
  for (const paths of [['src/model/a.ts', 'src/cli/b.ts'], ['auth/credentials/a.ts']]) {
    const work = pending(paths, ['unit:core-flow']);
    assert.notEqual(reviewNeed(work, [work], new Date()).state, 'proofs-pending');
    assert.equal(producerGroupDecisions(work, [work], new Date()).some(group => group.state === 'request'), true);
  }
  // Low does not: no producer session is asked for, and the review is not held for it.
  const low = pending(['tests/only.test.ts'], ['unit:core-flow']);
  assert.equal(verdict(low).lane, 'low');
  assert.notEqual(reviewNeed(low, [low], new Date()).state, 'proofs-pending', 'a low item’s review is not held for a proof it does not need');
  assert.equal(producerGroupDecisions(low, [low], new Date()).some(group => group.state === 'request'), false, 'no producer session is asked for a low item');
});

test('unit:lanes-feed-verdict — the verdict reads the observed diff, and an unobserved change keeps the full high path', () => {
  const work = item(['src/model/policy.ts'], ['unit:core-flow', 'manual:safety-attestation'], ['migrations/schema/003.sql']);
  assert.equal(verdict(work).lane, 'low', 'the observed diff decides the lane');
  work.observation = null;
  assert.equal(verdict(work).lane, 'high', 'with no observation, the change is unknown and nothing is waived');
  const empty = item([], ['unit:core-flow', 'manual:safety-attestation']);
  assert.equal(verdict(empty).lane, 'high', 'an observed empty diff is also unknown');
  assert.deepEqual(requiredProofs(empty, [empty]), ['unit:core-flow', 'manual:safety-attestation'], 'an unknown lane lifts no proof');
});

test('unit:lanes-feed-verdict — the per-lane speed targets are shipped and reported with the lane', () => {
  assert.deepEqual(laneSpeedTargets, { low: 30 * 60_000, medium: 60 * 60_000, high: 4 * 60 * 60_000 });
  assert.ok(laneSpeedTargets.low < laneSpeedTargets.medium && laneSpeedTargets.medium < laneSpeedTargets.high);
  for (const [paths, lane] of [[['tests/a.test.ts'], 'low'], [['src/model/a.ts', 'src/cli/b.ts'], 'medium'], [['migrations/schema/004.sql'], 'high']] as [string[], Lane][]) {
    const result = verdict(item(paths));
    assert.equal(result.lane, lane);
    assert.equal(result.speedTarget, laneSpeedTargets[lane], `${lane} reports its own speed target`);
  }
});
