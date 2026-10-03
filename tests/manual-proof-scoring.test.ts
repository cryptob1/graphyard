import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluate, type Evidence, type Observation, type Work } from '../src/model.js';
import { automatableOutcomes, producerGroupDecisions, producerManualFailures, evidenceProves } from '../src/model/mechanical-proofs.js';
import { deliveredProof } from '../src/model/bootstrap.js';
import { classifyProofs } from '../src/cli/verify.js';
import { proofOutcome } from '../src/producer.js';
import { nextAction } from '../src/model/next-action.js';
import { neededDecision, proofRework } from '../src/daemon/decisions.js';

// GY-895. The producer prompts already state the manual-proof rule — a manual: proof is judged,
// not counted from titles — but the scorer still applied the unit title rule to it, so a trusted
// manual pass recorded with executed = 0 (a producer that judged the change without running cases
// titled with the proof id, which for a manual proof is every producer) scored as failed: the
// group decision asked for a fresh head nobody requested, the acceptance gate demanded
// "executed > 0" forever, the pass suppressed the unexercised finding that attestationDecision
// answers, and the correct candidate looped on executed = 0 with no route at all. The scoring now
// reads a manual: proof as the attestation it is, while every other family — unit, integration,
// e2e — keeps the title-count rule unchanged; and the routing of a manual record with executed = 0
// stays with the fresh attestation (GY-523, GY-868), never with implementer rework.

const CI_APP = 15368;
const now = new Date('2026-09-28T00:00:00.000Z');
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const at = '2026-09-28T00:00:00.000Z';
const MANUAL = 'manual:review-followups-triaged', UNIT = 'unit:manual-proof-scoring-guard', E2E = 'e2e:checkout';

function evidence(proof: string, entry: Partial<Evidence>): Evidence {
  return { id: 'e1', proof, sha: head, baseSha: base, policyRevision: 1, producer: 'trusted-producer', trusted: true, result: 'pass', executed: 0, skipped: 0, at, ...entry } as Evidence;
}
function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    clockOffset: { min: 0, max: 0 },
    candidate: { sha: head, baseSha: base, pr: 895, branch: 'graphyard/gy-895-1', author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: CI_APP }, { name: 'typecheck', result: 'success', appId: CI_APP }],
    reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }], protected: true, mergeable: true, merged: false, mergeSha: null,
    // GY-883: a public API path keeps the item in the high lane, which still demands the manual proof this test scores.
    files: ['src/server/routes/followups.ts'], scopeFiles: [{ path: 'src/server/routes/followups.ts', status: 'modified' as const, sha: 'f'.repeat(40), additions: 1, deletions: 1, binary: false }], at, prState: 'open', draft: false, baseTip: base, baseTipContained: true,
    conversations: { required: true, unresolved: [] }, ...overrides,
  };
}
/** A submitted, approved item whose criteria name the manual proof and a unit proof, graded by the real evaluator. */
function item(evidenceEntries: Partial<Evidence>[] = [], extra: Partial<Work> = {}): Work {
  const candidate = { sha: head, baseSha: base, pr: 895, branch: 'graphyard/gy-895-1', author: 'implementer' };
  const work = {
    id: '11111111-2222-4333-8444-555555555555', key: 'GY-895', title: 'Manual proof scoring', description: '', type: 'bug', priority: 2, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Review follow-ups are triaged', proofs: [MANUAL] }, { id: 'AC-2', text: 'The suite passes', proofs: [UNIT] }],
    policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: ['src/'], producerProofs: [MANUAL],
    stage: 'acceptance', revision: 5, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true,
    epoch: 1, lease: null, workspaces: [{ host: 'machine-a', path: '/tmp/gy-895', branch: 'graphyard/gy-895-1', epoch: 1, owner: 'agent-a' }],
    implementers: ['agent-a'], lastAssignment: { owner: 'agent-a', epoch: 1 }, candidate, submission: { epoch: 1, pr: 895 },
    evidence: evidenceEntries.map(entry => evidence((entry.proof as string) ?? MANUAL, entry)),
    observation: observation(), gates: [], violations: [], blocker: null, queue: null, queueSequence: 0, queueHistory: [],
    ...extra,
  } as unknown as Work;
  const graded = evaluate(work, [work], now, [CI_APP]);
  return { ...work, stage: graded.stage, gates: graded.gates, violations: graded.violations } as Work;
}
const outcomeOf = (work: Work, proof: string) => automatableOutcomes(work, [work], now).find(entry => entry.proof === proof)!.outcome;
const acceptanceReasons = (work: Work) => work.gates.find(gate => gate.name === 'acceptance')!.reasons;
const binding = { sha: head, baseSha: base, policyRevision: 1 };

test('unit:manual-proof-not-title-counted — a judged manual pass proves its criterion whatever it executed; unit/integration keep the title rule', () => {
  // The pass the title rule used to fail: a producer judged the change and ran no case titled
  // with the proof id, so executed = 0. It is an attestation, and it proves.
  const judged = item([{}, evidence(UNIT, { executed: 3 })]);
  assert.equal(outcomeOf(judged, MANUAL), 'proven', 'the manual pass is proven, never counted from titles');
  assert.deepEqual(producerGroupDecisions(judged, [judged], now).filter(entry => entry.group === 'manual').map(entry => entry.state), ['proven']);
  assert.deepEqual(acceptanceReasons(judged), [], 'the acceptance gate accepts the attested pass');
  assert.equal(proofOutcome(judged, binding, MANUAL), 'pass', 'the producer session settles the proof as passed');
  assert.equal(nextAction(judged, [judged], now)?.kind, 'merge', 'nothing is asked for a correct candidate');

  // The skip rule is not weakened with it: an attested pass with a skipped case proves nothing.
  assert.equal(outcomeOf(item([{ skipped: 1 }, evidence(UNIT, { executed: 3 })], {}), MANUAL), 'failed');
  // A failing manual record still fails, however many cases ran.
  assert.equal(outcomeOf(item([{ result: 'fail' as const, executed: 2 }, evidence(UNIT, { executed: 3 })], {}), MANUAL), 'failed');

  // Unit and integration proofs keep the existing rule unchanged: a pass with no case executed
  // under the proof's title judged nothing.
  assert.equal(outcomeOf(item([{}, evidence(UNIT, { executed: 0 })]), MANUAL), 'proven');
  assert.equal(outcomeOf(item([{}, evidence(UNIT, { executed: 0 })]), UNIT), 'failed');
  assert.deepEqual(acceptanceReasons(item([{}, evidence(UNIT, { executed: 0 })])), [`AC-2: ${UNIT} needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy`]);
  // The gate names the manual proof without the title-count demand it never had.
  assert.deepEqual(acceptanceReasons(item([])), [`AC-1: ${MANUAL} needs trusted passing evidence, with skipped = 0, for this candidate and policy`,
    `AC-2: ${UNIT} needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy`]);
});

test('unit:attested-is-manual-only — the zero-execution exception is the manual family alone; e2e keeps the title rule', () => {
  // The review finding on aa88fee9fb: the exception was written as "not mechanical", which freed
  // every non-mechanical proof — e2e included — from executed > 0. An e2e pass with no case
  // executed judged nothing, and is failed, not proven.
  assert.equal(evidenceProves(E2E, { result: 'pass', executed: 0, skipped: 0 }), false, 'an e2e pass with nothing executed judged nothing');
  assert.equal(evidenceProves(E2E, { result: 'pass', executed: 1, skipped: 0 }), true, 'an e2e pass with a case executed proves');
  assert.equal(evidenceProves(MANUAL, { result: 'pass', executed: 0, skipped: 0 }), true, 'the attestation rule stays with manual:');

  // GY-1101: an e2e proof no longer gates the merge — it runs against the release candidate — so
  // the acceptance gate names none of these, whatever the evidence. The title rule above still
  // decides whether the release candidate's e2e pass proves anything.
  const demanded = item([], { criteria: [{ id: 'AC-1', text: 'Checkout runs end to end', proofs: [E2E] }] });
  assert.deepEqual(acceptanceReasons(demanded), [], 'an e2e proof is not a pre-merge requirement');
  const unjudged = item([evidence(E2E, { executed: 0 })], { criteria: [{ id: 'AC-1', text: 'Checkout runs end to end', proofs: [E2E] }] });
  assert.deepEqual(acceptanceReasons(unjudged), [], 'a zero-executed e2e pass neither gates nor proves before merge');
  assert.equal(evidenceProves(E2E, unjudged.evidence[0]!), false, 'the zero-executed e2e pass still proves nothing');
  const proven = item([evidence(E2E, { executed: 2 })], { criteria: [{ id: 'AC-1', text: 'Checkout runs end to end', proofs: [E2E] }] });
  assert.deepEqual(acceptanceReasons(proven), []);
  assert.equal(evidenceProves(E2E, proven.evidence[0]!), true, 'an e2e pass with cases executed proves the criterion');
});

test('unit:manual-proof-not-title-counted — the verifier names a manual proof outstanding for judgment, and a delivered attested pass discharges a bootstrap obligation', () => {
  // The verifier never counts a manual proof's titles: it cannot run one, and says so.
  const classified = classifyProofs([{ id: 'AC-1', proofs: [MANUAL] }, { id: 'AC-2', proofs: [UNIT] }]);
  assert.deepEqual(classified.runnable.map(entry => entry.proof), [UNIT], 'only the unit proof is runnable here');
  assert.match(classified.outstanding.find(entry => entry.proof === MANUAL)!.reason, /judged by an independent producer, not run here/);

  // A delivered change discharges a deferred proof only through what the same rule reads as a pass.
  const delivered = { ...item([{}, evidence(UNIT, { executed: 3 })]), stage: 'done' } as Work;
  assert.equal(deliveredProof(delivered, MANUAL), true, 'the attested pass discharges whatever it executed');
  assert.equal(deliveredProof({ ...delivered, evidence: [evidence(UNIT, { executed: 0 })] }, UNIT), false, 'a unit pass still needs cases executed');
  assert.equal(deliveredProof({ ...delivered, evidence: [evidence(E2E, { executed: 0 })] }, E2E), false, 'an e2e pass still needs cases executed');
  assert.equal(deliveredProof({ ...delivered, evidence: [evidence(MANUAL, { skipped: 1 })] }, MANUAL), false, 'a skipped manual pass discharges nothing');
});

test('unit:no-rework-on-manual-zero-executed — a manual record with executed = 0 routes to a fresh attestation, never to implementer rework', () => {
  // The only failed evidence is the manual record that judged nothing; the underlying unit proof passed.
  const work = item([{ result: 'fail' as const, executed: 0 }, evidence(UNIT, { executed: 3 })]);
  assert.deepEqual(producerManualFailures(work, [work], now), [], 'an unexecuted record is no failure of the change');
  assert.equal(proofRework(work), null, 'no rework is asked for a proof nothing ran on');
  const needed = neededDecision(work, { autoMerge: true });
  assert.equal(needed?.action, 'attest', 'the loop requests a fresh producer attestation');
  assert.deepEqual(needed?.input, { proof: MANUAL });
  assert.equal(needed?.binding, `${head}:attest:${MANUAL}`);
  assert.match(needed!.reason, /rework is the wrong remedy/);
  assert.notEqual(nextAction(work, [work], now)?.kind, 'request-rework', 'the routing decision never sends this head to a worker');

  // The session that recorded it reports the producer's finding, not a failure of the change.
  assert.equal(proofOutcome(work, binding, MANUAL), 'unexercised');

  // The fresh attestation answers it: the loop records the attested pass with executed = 1.
  const attested = item([{ result: 'fail' as const, executed: 0 }, evidence(UNIT, { executed: 3 }), { id: 'e2', result: 'pass', executed: 1, at: '2026-09-28T01:00:00.000Z' }]);
  assert.equal(neededDecision(attested, { autoMerge: true }), null);
  assert.deepEqual(acceptanceReasons(attested), [], 'the attested pass proves the criterion');
  // A re-judged pass recorded with executed = 0 answers it too (GY-895): the proof is proven.
  assert.equal(neededDecision(item([{ result: 'fail' as const, executed: 0 }, evidence(UNIT, { executed: 3 }), { id: 'e2', result: 'pass', executed: 0, at: '2026-09-28T01:00:00.000Z' }]), { autoMerge: true }), null);

  // The control: a manual record the producer judged with cases executed is a failure of the
  // change (GY-868) and still returns the head to its worker.
  const judged = item([{ result: 'fail' as const, executed: 3 }, evidence(UNIT, { executed: 3 })]);
  assert.equal(producerManualFailures(judged, [judged], now).length, 1);
  assert.match(proofRework(judged)!.reason, new RegExp(MANUAL));
  assert.equal(neededDecision(judged, { autoMerge: true })?.action, 'rework');
});

test('unit:manual-proof-not-title-counted — the guides state the manual pass rule', () => {
  const coordination = readFileSync(fileURLToPath(new URL('../docs/coordination.md', import.meta.url)), 'utf8');
  assert.match(coordination, /judged, not title-counted/);
  assert.match(coordination, /whatever it executed/);
  assert.match(coordination, /`unit:`\/`integration:`\/`e2e:` need `executed > 0`/);
});
