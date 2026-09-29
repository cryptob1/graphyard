import { test } from 'node:test';
import assert from 'node:assert/strict';
import { determineLane, laneDemandsProof, laneSpeedTargets, laneRequirements, type Lane } from '../src/model/policy.js';
import { evaluate } from '../src/model/gates.js';
import { reviewNeed } from '../src/model/dispatch.js';
import { producerGroupDecisions } from '../src/model/mechanical-proofs.js';
import type { Observation, Work } from '../src/model/work.js';

// GY-883: risk lanes. The ceremony an item runs is decided by the risk of what it changes:
// low lands once its criteria are proven, its required CI checks are green and one approving
// review stands, medium adds the change's producer-run proofs, high adds manual attestations.
// The lane only ever adds ceremony beside an item's authored criteria — it never removes a
// proof the criteria name, in any lane: a path heuristic must not weaken a task's requirements,
// so every lane holds the review and dispatches producers for a criterion proof, and rework
// approval is required in every lane. The lane is decided by the shipped path policy in
// src/model/policy.ts from both endpoints of every renamed file, and rides the one landability
// verdict in src/model/gates.ts.

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

// AC-2: each lane's required set — the ceremony the lane itself adds beside an item's authored
// criteria. No lane removes a proof the criteria name, so every lane keeps rework approval: the
// two-party decision invariant never varies.
test('unit:lane-sets-required-gates — the shipped required set of each lane', () => {
  assert.deepEqual(laneRequirements('low'), { producerProofs: false, manualAttestations: false, reworkApprover: true });
  assert.deepEqual(laneRequirements('medium'), { producerProofs: true, manualAttestations: false, reworkApprover: true });
  assert.deepEqual(laneRequirements('high'), { producerProofs: true, manualAttestations: true, reworkApprover: true });
  // The per-family rule the verdict reads for the lane's own demand: unit and integration ride
  // the lane's producerProofs, manual rides its manualAttestations, and no family is lane-added
  // beyond those — the verdict demands every criterion-named proof in every lane whatever this
  // returns.
  for (const [lane, unit, manual] of [
    ['low', false, false], ['medium', true, false], ['high', true, true],
  ] as [Lane, boolean, boolean][]) {
    assert.equal(laneDemandsProof(lane, 'unit:core-flow'), unit, `${lane} ${unit ? 'demands' : 'adds no'} producer-run proofs beside the criteria`);
    assert.equal(laneDemandsProof(lane, 'integration:claim-safety'), unit, `${lane} ${unit ? 'demands' : 'adds no'} integration proofs beside the criteria`);
    assert.equal(laneDemandsProof(lane, 'manual:safety-attestation'), manual, `${lane} ${manual ? 'demands' : 'adds no'} manual attestations beside the criteria`);
    assert.equal(laneDemandsProof(lane, 'e2e:user-journey'), false, `${lane} adds no e2e demand: the family rides the criteria alone`);
  }
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

test('unit:lane-sets-required-gates — the lane adds its own demand beside the criteria, never instead of them', () => {
  const laneAdded = (gate: { reasons: string[] }, proof: string) => gate.reasons.some(reason => reason.includes('lane adds this demand') && reason.includes(proof));
  // A medium item's verdict names its producer-run proofs as the lane's own demand, beside the
  // criterion's; a high item adds its attestations too; a low item's lane adds nothing.
  const medium = acceptance(item(['src/model/a.ts', 'src/cli/b.ts']));
  assert.equal(verdict(item(['src/model/a.ts', 'src/cli/b.ts'])).lane, 'medium');
  assert.equal(laneAdded(medium, 'unit:core-flow'), true, 'medium adds the producer-run proof as its own demand');
  assert.equal(laneAdded(medium, 'manual:safety-attestation'), false, 'medium adds no attestation demand');
  const high = acceptance(item(['auth/credentials/a.ts']));
  assert.equal(verdict(item(['auth/credentials/a.ts'])).lane, 'high');
  assert.equal(laneAdded(high, 'unit:core-flow'), true, 'high adds the producer-run proof as its own demand');
  assert.equal(laneAdded(high, 'manual:safety-attestation'), true, 'high adds the attestation as its own demand too');
  const low = acceptance(item(['src/model/policy.ts']));
  assert.equal(verdict(item(['src/model/policy.ts'])).lane, 'low');
  assert.equal(low.reasons.some(reason => reason.includes('lane adds this demand')), false, 'low adds nothing beside the criteria');
  assert.equal(low.reasons.some(reason => reason.includes('unit:core-flow')), true, 'the criterion demand itself stands in low');
});

test('unit:lane-sets-required-gates — an e2e proof stays required in every lane', () => {
  for (const [paths, lane] of [[['tests/x.test.ts'], 'low'], [['src/model/a.ts', 'src/cli/b.ts'], 'medium'], [['auth/credentials/a.ts'], 'high']] as [string[], Lane][]) {
    const gate = acceptance(item(paths, ['e2e:user-journey']));
    assert.equal(gate.reasons.some(reason => reason.includes('e2e:user-journey')), true, `${lane} keeps e2e proofs required`);
  }
});

test('unit:lane-sets-required-gates — a bootstrap obligation inherited from an earlier delivery stands beside the item\u2019s own criteria in every lane', () => {
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
  assert.equal(gate.reasons.some(reason => reason.includes('unit:core-flow')), true, 'the item\u2019s own criterion proof stands beside it, low lane included');
});

// AC-3: lanes are inputs to the single landability verdict (GY-878), not separate required-check
// sets: the verdict takes the item's lane, adds the lane's ceremony beside the criteria, and
// reports the lane with its speed target.
test('unit:lanes-feed-verdict — the one verdict requires the criteria in every lane, adds the lane\u2019s ceremony, and rides the lane\u2019s target', () => {
  for (const [paths, lane, laneAddedProofs] of [
    [['tests/only.test.ts'], 'low', [] as string[]],
    [['src/model/a.ts', 'src/cli/b.ts'], 'medium', ['unit:core-flow']],
    [['deploy/install/a.sh'], 'high', ['unit:core-flow', 'manual:safety-attestation']],
  ] as [string[], Lane, string[]][]) {
    const work = item(paths);
    const result = verdict(work);
    assert.equal(result.lane, lane);
    assert.equal(result.speedTarget, laneSpeedTargets[lane], `${lane} reports its own speed target beside the lane`);
    const gate = result.gates.find(gate => gate.name === 'acceptance')!;
    // The criteria's facts are required in every lane; the lane adds its own demand for the
    // families it scales beside them, never instead of them.
    for (const proof of ['unit:core-flow', 'manual:safety-attestation'])
      assert.equal(gate.reasons.some(reason => reason.includes(proof)), true, `${lane} requires the criterion-named ${proof}`);
    assert.equal(gate.reasons.some(reason => reason.includes('lane adds this demand') && reason.includes('unit:core-flow')), laneAddedProofs.includes('unit:core-flow'),
      `${lane} ${laneAddedProofs.includes('unit:core-flow') ? 'adds' : 'adds no'} producer-proof demand beside the criteria`);
    assert.equal(gate.reasons.some(reason => reason.includes('lane adds this demand') && reason.includes('manual:safety-attestation')), laneAddedProofs.includes('manual:safety-attestation'),
      `${lane} ${laneAddedProofs.includes('manual:safety-attestation') ? 'adds' : 'adds no'} attestation demand beside the criteria`);
    assert.equal(gate.passed, false, `${lane}: the verdict still requires the criteria's facts`);
  }
});

test('unit:lanes-feed-verdict — every lane holds the review and the producer dispatch for a criterion proof, and a recorded failure returns the head in every lane', () => {
  // The criteria are mandatory in every lane, so an unproven criterion proof holds the review and
  // is dispatched to a producer session in the low lane exactly as in the medium one.
  for (const [paths, lane] of [[['tests/only.test.ts'], 'low'], [['src/model/a.ts', 'src/cli/b.ts'], 'medium']] as [string[], Lane][]) {
    const work = item(paths, ['unit:core-flow']);
    work.observation = { ...observed(paths), reviews: [], prState: 'open' as const, draft: false, baseTip: base, baseTipContained: true };
    assert.equal(verdict(work).lane, lane);
    const review = reviewNeed(work, [work], new Date());
    assert.equal(review.state, 'proofs-pending', `${lane}: review waits for the criterion proof (${review.reason})`);
    const groups = producerGroupDecisions(work, [work], new Date());
    assert.equal(groups.some(group => group.state === 'request'), true, `${lane}: a producer session is asked for the criterion proof`);
  }
  // A recorded failure is never lifted: the head returns to its worker in every lane.
  for (const [paths, lane] of [[['tests/only.test.ts'], 'low'], [['auth/credentials/a.ts'], 'high']] as [string[], Lane][]) {
    const failed = item(paths, ['unit:core-flow']);
    failed.observation = { ...observed(paths), reviews: [], prState: 'open' as const, draft: false, baseTip: base, baseTipContained: true };
    failed.evidence = [{ id: 'e', proof: 'unit:core-flow', sha: head, baseSha: base, policyRevision: 1, producer: 'trusted-producer', trusted: true, result: 'fail', executed: 3, skipped: 0, at: new Date().toISOString() }] as never;
    assert.equal(producerGroupDecisions(failed, [failed], new Date()).some(group => group.state === 'failed'), true, `${lane}: a failed proof refuses dispatch`);
    assert.equal(reviewNeed(failed, [failed], new Date()).state, 'proof-failed', `${lane}: a recorded failure returns the head`);
  }
});

test('unit:lanes-feed-verdict — the verdict reads the observed diff, and an unobserved change stays medium', () => {
  const work = item(['src/model/policy.ts'], ['unit:core-flow', 'manual:safety-attestation'], ['migrations/schema/003.sql']);
  assert.equal(verdict(work).lane, 'low', 'the observed diff decides the lane');
  work.observation = null;
  assert.equal(verdict(work).lane, 'medium', 'with no observation, the change is unknown and its producer proofs stay demanded');
  const empty = item([], ['unit:core-flow']);
  assert.equal(verdict(empty).lane, 'medium', 'an observed empty diff is also unknown, and its producer proofs stay demanded');
  assert.equal(acceptance(empty).passed, false, 'an unknown lane does not lift proofs');
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
