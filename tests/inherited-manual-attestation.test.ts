import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attestationDecision } from '../src/daemon/decisions.js';
import { decisionInputs, decisionPrecondition } from '../src/model/approval.js';
import { attestationExercise } from '../src/master/autonomy.js';
import { exerciseRefusal } from '../src/model/evidence.js';
import type { Evidence, Work } from '../src/model.js';

// GY-917, the P1 follow-up from the review of GY-910 (PR #482): the attestation route an
// unexecuted (`executed = 0`) `manual:` record rides must exist for a proof inherited from a
// bootstrap obligation, not only for a proof a criterion of the item names. The merge queue holds
// its entry for exactly that attestation, so every leg of the route is judged here: the loop's
// request predicate names the inherited obligation, the server's attest precondition accepts a
// proof the ledger requires, and the exercise record the request carries names no criterion —
// which the evidence command resolves against the proof's single attached criterion at apply time.

const head = 'a'.repeat(40), base = 'b'.repeat(40), at = '2026-09-28T00:00:00.000Z';
const MANUAL = 'manual:review-followups-triaged';

function inheritingItem(criteria: Work['criteria'], evidence: Evidence[]): Work {
  const candidate = { sha: head, baseSha: base, pr: 910, branch: 'graphyard/gy-910-1', author: 'worker' };
  return {
    id: 'gy-910', key: 'GY-910', title: 'Inherited follow-up triage', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria, policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'merge', revision: 4, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [], candidate,
    submission: { epoch: 1, pr: 910 }, reworkRequested: false, scenarioRequirements: [], blocker: null, gates: [], violations: [],
    producerProofs: [MANUAL], evidence,
    queue: null, queueSequence: 0, observation: null,
  } as unknown as Work;
}

function deferringItem(): Work {
  const candidate = { sha: '1'.repeat(40), baseSha: '2'.repeat(40), pr: 900, branch: 'graphyard/gy-900-1', author: 'worker' };
  return {
    id: 'gy-900', key: 'GY-900', title: 'The deferring change', description: '', type: 'chore', priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'The harness follow-ups are triaged', proofs: [MANUAL],
      bootstrap: { reason: 'the harness this proof needs is introduced by this change', contractPaths: ['src/'], declaredBy: 'operator', declaredAt: at, policyRevision: 1 } }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['docs/'], stage: 'merge', revision: 2, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [], candidate,
    submission: { epoch: 1, pr: 900 }, reworkRequested: false, scenarioRequirements: [], blocker: null, gates: [], violations: [],
    producerProofs: [], evidence: [], queue: null, queueSequence: 0, observation: null,
  } as unknown as Work;
}

const unexecuted = (): Evidence[] => [
  { id: 'e1', proof: MANUAL, sha: head, baseSha: base, policyRevision: 1, result: 'fail', executed: 0, skipped: 0, producer: 'trusted-producer', trusted: true, at } as Evidence,
];

const local = [{ id: 'AC-1', text: 'The queue tests pass', proofs: ['unit:other'] as string[] }];

test('unit:inherited-manual-attestation-requested — the loop requests the attestation of an inherited unexecuted manual record', () => {
  const all = [deferringItem(), inheritingItem(local, unexecuted())];
  const decision = attestationDecision(all[1]);
  assert.ok(decision, 'the inherited record is answered by an attestation request, not by null');
  assert.equal(decision!.input!.proof, MANUAL);
  assert.match(decision!.reason, /inherited obligation/, 'the reason names the obligation no local criterion names');
  assert.match(decision!.reason, /GY-900 AC-1|inherited/, 'the criterion of the obligation is named for the approver');
  // A locally named proof keeps the reason it always had.
  const named = inheritingItem([{ id: 'AC-2', text: 'The follow-ups are triaged', proofs: [MANUAL] }], unexecuted());
  assert.match(attestationDecision(named)!.reason, /AC-2/, 'the reason names the local criterion when there is one');
});

test('unit:inherited-manual-attest-precondition — the attest precondition accepts a proof the ledger requires and refuses one it cannot see', () => {
  const all = [deferringItem(), inheritingItem(local, unexecuted())];
  const work = all[1];
  const input = decisionInputs.attest.parse({ proof: MANUAL, sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 1, skipped: 0 });
  // Without the ledger the inherited proof is required by nothing, and the precondition says so.
  assert.match(decisionPrecondition('attest', input, work)!, new RegExp(`${MANUAL} is not required by any criterion of GY-910`));
  // With the ledger the bootstrap obligation requires it: the request is accepted.
  assert.equal(decisionPrecondition('attest', input, work, all), null);
  // A proof neither the item nor any obligation requires is still refused.
  const unattached = decisionInputs.attest.parse({ proof: 'manual:inherited-manual-attestation-unattached', sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 1, skipped: 0 });
  assert.match(decisionPrecondition('attest', unattached, work, all)!, /is not required by any criterion/);
});

test('unit:inherited-manual-attest-exercise — the exercise record names no criterion for an inherited proof and still exercises it', () => {
  const all = [deferringItem(), inheritingItem(local, unexecuted())];
  const work = all[1];
  // No local criterion names the proof, so the record names none; the behaviour and the confirming
  // run are what the approver judges.
  const exercise = attestationExercise(work, MANUAL).exercise!;
  assert.deepEqual(Object.keys(exercise).sort(), ['behaviour', 'executed', 'result']);
  assert.equal(exercise.result, 'fail');
  assert.ok(exercise.executed >= 1);
  assert.ok(!('criterion' in exercise), 'no invented criterion id');
  // A locally named proof keeps its criterion in the record, as before.
  const named = inheritingItem([{ id: 'AC-2', text: 'The follow-ups are triaged', proofs: [MANUAL] }], unexecuted());
  assert.equal(attestationExercise(named, MANUAL).exercise?.criterion, 'AC-2');
  // And the unnamed record resolves against the proof's single attached criterion — the inherited
  // obligation's — when the attested pass is applied (GY-135's exercise rule).
  const pass = { proof: MANUAL, result: 'pass' as const, exercise };
  assert.equal(exerciseRefusal(work, all, pass), null, 'the attested pass exercises the inherited criterion');
  // A proof attached to two criteria is still the requester's to name by hand (a local criterion
  // already suppresses the inheritance, so ambiguity here is two local ones).
  const both = [deferringItem(), inheritingItem([{ id: 'AC-2', text: 'Also triaged', proofs: [MANUAL] }, { id: 'AC-3', text: 'Triaged again', proofs: [MANUAL] }], unexecuted())];
  assert.match(exerciseRefusal(both[1], both, pass)!, /does not name which/, 'an ambiguous attachment is not guessed');
});
