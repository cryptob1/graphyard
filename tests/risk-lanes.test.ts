import { test } from 'node:test';
import assert from 'node:assert/strict';
import { determineLane, laneSpeedTargets, type Lane } from '../src/model/policy.js';
import { evaluate, laneRequirements } from '../src/model/gates.js';
import type { Observation, Work } from '../src/model/work.js';

// GY-883: risk lanes. The ceremony an item runs is decided by the risk of what it changes:
// low lands once its criteria are proven, its required CI checks are green and one approving
// review stands, medium adds the change's producer-run proofs, high adds manual attestations.
// The lane never removes a proof the item's criteria name — no lane weakens a task's
// requirements — and rework approval is required in every lane. The lane is decided by the
// shipped path policy in src/model/policy.ts and rides the one landability verdict in
// src/model/gates.ts.

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
const acceptance = (work: Work) => verdict(work).gates.find(gate => gate.name === 'acceptance')!;

// AC-1: the shipped path policy assigns every item a lane: high for migrations/schema,
// auth/credentials, the public API and the repository's installation and deployment surfaces;
// low for test-only, docs-only and single-module changes; medium for the rest.
test('unit:risk-lane-assigned — the shipped path policy classifies high-risk paths as high', () => {
  assert.equal(determineLane(['migrations/schema/001_initial.sql']), 'high');
  assert.equal(determineLane(['auth/credentials/oauth.ts']), 'high');
  assert.equal(determineLane(['deploy/install/setup.sh']), 'high');
  assert.equal(determineLane(['src/server/routes/work.ts']), 'high', 'the public API is high-risk');
  assert.equal(determineLane(['src/install/secrets.ts']), 'high', 'the installation surface is high-risk');
  assert.equal(determineLane(['deploy/helm/graphyard/templates/secret.yaml']), 'high', 'the deployment tree is high-risk');
  assert.equal(determineLane(['Dockerfile']), 'high', 'the image build is high-risk');
  assert.equal(determineLane(['compose.yaml']), 'high', 'the compose deployment is high-risk');
  // One high-risk path is enough, whatever else changed beside it.
  assert.equal(determineLane(['docs/notes.md', 'tests/x.test.ts', 'migrations/schema/002_add.sql']), 'high');
  // A high-risk path is never lowered by the single-module or docs rules.
  assert.equal(determineLane(['src/install/secrets.ts', 'src/install/limits.ts']), 'high');
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

test('unit:risk-lane-assigned — everything else is medium, and an unknown change defaults to medium', () => {
  assert.equal(determineLane(['src/model/policy.ts', 'src/cli/main.ts']), 'medium');
  assert.equal(determineLane(['src/model/gates.ts', 'tests/risk-lanes.test.ts', 'docs/glossary.md']), 'medium');
  assert.equal(determineLane(['src/a.ts', 'src/b.ts']), 'medium', 'sharing only src/ is not one module');
  // The shared prefix stops at the first divergent segment: a shared basename is not a shared module.
  assert.equal(determineLane(['src/model/index.ts', 'src/cli/index.ts']), 'medium', 'src/model/ and src/cli/ are two modules despite the shared tail');
  assert.equal(determineLane(['src/a/run.ts', 'src/b/run.ts', 'src/c/run.ts']), 'medium', 'every file sharing a basename is still three modules');
  assert.equal(determineLane(['package.json']), 'medium');
  assert.equal(determineLane([]), 'medium');
  assert.equal(determineLane(['src/model/policy.ts', 'deploy/install/setup.sh']), 'high', 'high wins over the single-module rule');
});

// AC-2: each lane's required set — the ceremony the lane itself adds beside an item's authored
// criteria. No lane removes a proof the criteria name, so every lane keeps rework approval: the
// two-party decision invariant never varies.
test('unit:lane-sets-required-gates — the shipped required set of each lane', () => {
  assert.deepEqual(laneRequirements('low'), { producerProofs: false, manualAttestations: false, reworkApprover: true });
  assert.deepEqual(laneRequirements('medium'), { producerProofs: true, manualAttestations: false, reworkApprover: true });
  assert.deepEqual(laneRequirements('high'), { producerProofs: true, manualAttestations: true, reworkApprover: true });
});

test('unit:lane-sets-required-gates — a criterion-named proof is required in every lane, low included', () => {
  for (const [paths, lane] of [[['src/model/policy.ts'], 'low'], [['src/model/a.ts', 'src/cli/b.ts'], 'medium'], [['auth/credentials/a.ts'], 'high']] as [string[], Lane][]) {
    const work = item(paths);
    const result = verdict(work);
    assert.equal(result.lane, lane);
    const gate = acceptance(work);
    assert.equal(gate.passed, false, `${lane} never waives a criterion-named proof`);
    assert.equal(gate.reasons.some(reason => reason.includes('unit:core-flow')), true, `${lane} requires the criterion's producer-run proof`);
    assert.equal(gate.reasons.some(reason => reason.includes('manual:safety-attestation')), true, `${lane} requires the criterion's attestation`);
  }
});

test('unit:lane-sets-required-gates — an e2e proof stays required in every lane', () => {
  for (const [paths, lane] of [[['tests/x.test.ts'], 'low'], [['src/model/a.ts', 'src/cli/b.ts'], 'medium'], [['auth/credentials/a.ts'], 'high']] as [string[], Lane][]) {
    const gate = acceptance(item(paths, ['e2e:user-journey']));
    assert.equal(gate.reasons.some(reason => reason.includes('e2e:user-journey')), true, `${lane} keeps e2e proofs required`);
  }
});

test('unit:lane-sets-required-gates — a bootstrap obligation inherited from an earlier delivery is never lane-waived', () => {
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
  const gate = result.gates.find(gate => gate.name === 'acceptance')!;
  assert.equal(result.lane, 'low');
  assert.equal(gate.reasons.some(reason => reason.includes('Bootstrap obligation inherited') && reason.includes('unit:deferred-contract')), true,
    `the inherited obligation stands in the low lane too: ${gate.reasons.join('; ')}`);
});

// AC-3: lanes are inputs to the single landability verdict, not separate required-check sets; the
// verdict takes the item's lane and reports it with the lane's speed target. What the lane must
// never take out of the verdict is a criterion-named proof: the required facts are the criteria's
// in every lane.
test('unit:lanes-feed-verdict — the one verdict requires the criteria in every lane and rides the lane\'s target', () => {
  for (const [paths, lane] of [
    [['tests/only.test.ts'], 'low'],
    [['src/model/a.ts', 'src/cli/b.ts'], 'medium'],
    [['deploy/install/a.sh'], 'high'],
  ] as [string[], Lane][]) {
    const work = item(paths);
    const result = verdict(work);
    assert.equal(result.lane, lane);
    assert.equal(result.speedTarget, laneSpeedTargets[lane], `${lane} reports its own speed target beside the lane`);
    const gate = result.gates.find(gate => gate.name === 'acceptance')!;
    assert.equal(gate.passed, false, `${lane}: the verdict still requires the criteria's facts`);
    assert.equal(gate.reasons.some(reason => reason.includes('unit:core-flow')), true, `${lane}: producer proof required`);
    assert.equal(gate.reasons.some(reason => reason.includes('manual:safety-attestation')), true, `${lane}: attestation required`);
  }
});

test('unit:lanes-feed-verdict — the verdict reads the observed diff, and an unobserved change stays medium', () => {
  const work = item(['src/model/policy.ts'], ['unit:core-flow', 'manual:safety-attestation'], ['migrations/schema/003.sql']);
  assert.equal(verdict(work).lane, 'low', 'the observed diff decides the lane');
  work.observation = null;
  assert.equal(verdict(work).lane, 'medium', 'with no observation, the change is unknown and proofs stay required');
  const empty = item([], ['unit:core-flow']);
  assert.equal(verdict(empty).lane, 'medium', 'an observed empty diff is also unknown, and its proofs stay required');
  assert.equal(acceptance(empty).passed, false, 'an unknown lane does not waive proofs');
});

test('unit:lanes-feed-verdict — the per-lane speed targets are shipped and reported with the lane', () => {
  assert.deepEqual(laneSpeedTargets, { low: 30 * 60_000, medium: 60 * 60_000, high: 4 * 60 * 60_000 });
  assert.ok(laneSpeedTargets.low < laneSpeedTargets.medium && laneSpeedTargets.medium < laneSpeedTargets.high);
  for (const [paths, lane] of [[['tests/a.test.ts'], 'low'], [['src/model/a.ts', 'src/cli/b.ts'], 'medium'], [['migrations/schema/004.sql'], 'high']] as [string[], Lane][]) {
    const result = verdict(item(paths));
    assert.equal(result.lane, lane);
    assert.equal(result.speedTarget, laneSpeedTargets[lane], `${lane} reports its own speed target`);
    assert.ok(result.speedTarget > 0);
  }
});
