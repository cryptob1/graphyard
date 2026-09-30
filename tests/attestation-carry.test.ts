import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyThroughEngine, type DecisionRecord } from '../src/server/decisions.js';
import { currentEvidence, decideCarry, evaluate, requiredProofs, type Evidence, type Observation, type Principal, type TipMerge, type Work } from '../src/model.js';

// GY-615. On 2026-09-26 GY-486, the merge-queue head, held an approved attestation of a manual:
// proof. Every Graphyard-authored tip of that head asked for a new attestation, and the head waited
// in acceptance meanwhile. An attested record now carries across a Graphyard-authored refresh or
// speculative tip of the same author head exactly when the item's own diff kept its patch-id under
// the same policy revision, and never over a changed patch. Each test is named for its proof.

const sha = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const A = sha('a1'), M = sha('b1'), B = sha('a2'), M2 = sha('b2'), C = sha('a3'), D = sha('a4');
const now = new Date('2026-09-26T12:30:00.000Z'), at = now.toISOString();
const PROOF = 'manual:fault-class-review-convergence', PATCH = sha('9a'), OTHER = sha('9b');
const ciAppIds = [15368];

function observation(candidate: Work['candidate'], reviews: Observation['reviews']): Observation {
  return { candidate: { ...candidate! }, checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews, merged: false, mergeSha: null, mergeable: true, protected: true,
    prState: 'open', draft: false, baseTip: candidate!.baseSha, baseTree: sha('7e'), baseTipContained: true, files: ['src/engine.ts'], scopeFiles: [], at } as Observation;
}
/** GY-486's shape: one manual: criterion, reviewed and attested on head A over base M. */
function item(): Work {
  const candidate = { sha: A, baseSha: M, pr: 289, branch: 'graphyard/gy-486-1', author: 'worker' };
  return {
    id: 'gy-486', key: 'GY-486', title: 'Attested item', description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Review converges', proofs: [PROOF] }], policy: { checks: ['test'], review: true }, plannedFiles: ['src/'],
    stage: 'acceptance', revision: 9, policyRevision: 2, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'machine', path: '/tmp/gy-486', branch: 'graphyard/gy-486-1', epoch: 1, owner: 'worker' }], implementers: ['worker'], candidate,
    submission: { epoch: 1, pr: 289 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [],
    observation: observation(candidate, [{ reviewer: 'reviewer', sha: A, state: 'APPROVED' }]),
  } as unknown as Work;
}
/** The record an approved attest decision applies: the exercise record it carried, and the decision. */
const attested = (work: Work): Evidence => ({ id: 'ev-attest', proof: PROOF, sha: A, baseSha: M, policyRevision: work.policyRevision, producer: 'master-operator', trusted: true,
  result: 'pass', executed: 1, skipped: 0, at, exercise: { criterion: 'AC-1', behaviour: `the whole change: ${PROOF} run against the candidate base`, result: 'fail', executed: 1 },
  attestation: { decision: 'd-4994f0b0', requestedBy: 'master-operator', approvedBy: 'approver' } });
const merge = (to: string, diff: TipMerge['diff'], baseChanges: string[] = ['src/server/routes/github.ts']): TipMerge =>
  ({ from: A, parents: [A, M2], author: 'graphyard-owner-repo[bot]', authoredByApp: true, conflicts: false, baseChanges, diff });
/** What bindBaseRefresh records: the carry decided from the head as it stands, then the refreshed candidate. */
function refreshed(work: Work, to: string, tip: TipMerge): Work {
  const carry = decideCarry({ from: { sha: A, baseSha: M }, to: { sha: to, baseSha: M2 }, policyRevision: work.policyRevision, at, merge: tip,
    predecessor: { key: null, validated: true }, reviewedFiles: work.observation!.files, approval: { provider: 'github', reviewer: 'reviewer', sha: A },
    proofs: requiredProofs(work, [work]).map(proof => ({ proof, evidence: currentEvidence(work, proof, now) })), app: 'control-plane' });
  const candidate = { ...work.candidate!, sha: to, baseSha: M2 };
  return { ...work, candidate, observation: observation(candidate, []), baseRefresh: { from: { sha: A, baseSha: M }, base: M2, baseTree: sha('7f'), policyRevision: work.policyRevision, at, head: to, conflict: null, merge: tip, carry } } as Work;
}
const gates = (work: Work) => Object.fromEntries(evaluate(work, [work], now, ciAppIds).gates.map(gate => [gate.name, gate]));

test('unit:attestation-carried-on-refresh — an attested manual proof carries to a Graphyard-authored refresh of the same patch, and never over a changed patch or head', () => {
  const onA = item();
  onA.evidence = [attested(onA)];
  assert.equal(gates(onA).acceptance.passed, true, JSON.stringify(gates(onA).acceptance.reasons));

  // B: Graphyard merged the moved base into A; the item's own diff kept its patch-id.
  const onB = refreshed(onA, B, merge(B, { reviewed: PATCH, tip: PATCH }));
  const carried = onB.baseRefresh!.carry!.evidence.find(entry => entry.proof === PROOF)!;
  assert.equal(carried.carried, true, carried.reason);
  assert.match(carried.reason, /attest decision d-4994f0b0, approved by approver\) carried to [0-9a-f]{12}: diff unchanged \(patch-id [0-9a-f]{12}\)/);
  assert.equal(gates(onB).acceptance.passed, true, JSON.stringify(gates(onB).acceptance.reasons));
  assert.equal(gates(onB).review.passed, true, 'the approval carries by the same rule');
  // The record carried is the attested one itself, exercise record and decision included.
  const bound = currentEvidence(onB, PROOF, now)!;
  assert.equal(bound.id, 'ev-attest');
  assert.deepEqual([bound.exercise?.result, bound.attestation?.decision, bound.unexercised], ['fail', 'd-4994f0b0', undefined]);

  // C: a Graphyard-authored refresh whose patch changed refuses, even over a base that changed
  // no file the files rule would otherwise have let a scopeless record carry across.
  for (const baseChanges of [['src/server/routes/github.ts'], []]) {
    const onC = refreshed(onA, C, merge(C, { reviewed: PATCH, tip: OTHER }, baseChanges));
    const refused = onC.baseRefresh!.carry!.evidence.find(entry => entry.proof === PROOF)!;
    assert.equal(refused.carried, false, `base changed ${baseChanges.length} files`);
    assert.match(refused.reason, /carries only across an unchanged patch-id of the item's own diff, which changed; a fresh attestation for [0-9a-f]{12} is required/);
    assert.match(refused.reason, /patch-id [0-9a-f]{12} became [0-9a-f]{12}/);
    const acceptance = gates(onC).acceptance;
    assert.equal(acceptance.passed, false);
    assert.match(acceptance.reasons.join('\n'), new RegExp(`AC-1: ${PROOF} needs trusted passing evidence`));
  }
  // Without a comparable diff the patch is not shown unchanged, so nothing attested carries either.
  const unread = refreshed(onA, C, merge(C, { reviewed: PATCH, tip: null }, []));
  assert.match(unread.baseRefresh!.carry!.evidence[0].reason, /which could not be compared/);
  assert.equal(gates(unread).acceptance.passed, false);

  // D: the author pushed a new head. No Graphyard-authored decision covers it, so nothing carries.
  const onD = { ...onB, candidate: { ...onB.candidate!, sha: D }, observation: observation({ ...onB.candidate!, sha: D }, []) } as Work;
  assert.equal(currentEvidence(onD, PROOF, now), undefined);
  assert.equal(gates(onD).acceptance.passed, false);
  // And a policy revision moved since the carry was decided: neither the record nor the carry applies.
  assert.equal(gates({ ...onB, policyRevision: 3 } as Work).acceptance.passed, false);
});

test('unit:attestation-carried-on-refresh — an approved attest decision names itself on the evidence it records', async () => {
  const calls: unknown[][] = [];
  const services = { engine: { execute: async (...args: unknown[]) => { calls.push(args); return {}; } } } as any;
  const decision = { id: 'd-4994f0b0', action: 'attest', workId: 'gy-486', requestedBy: 'master-operator', reason: 'Attest the review convergence',
    input: { proof: PROOF, sha: A, baseSha: M, policyRevision: 2, result: 'pass', executed: 1, skipped: 0 } } as unknown as DecisionRecord;
  await applyThroughEngine(services, decision, { id: 'approver', role: 'operator-agent' } as Principal, 'ran it against base and candidate');
  assert.equal(calls.length, 1);
  const [actor, command, , input, key, context] = calls[0] as [Principal, string, string, unknown, string, { attestation?: unknown }];
  assert.deepEqual([actor.id, command, key], ['master-operator', 'evidence', 'decision:d-4994f0b0']);
  assert.deepEqual(input, decision.input, 'the decision input is recorded as it was approved');
  assert.deepEqual(context.attestation, { decision: 'd-4994f0b0', requestedBy: 'master-operator', approvedBy: 'approver' });
});
