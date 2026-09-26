import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routineDecision, proofRework, withheldDecision } from '../src/master-daemon.js';
import { neededDecision } from '../src/daemon/decisions.js';
import { decisionInput } from '../src/master/autonomy.js';
import { attestConfirmation, piApproverPrompt } from '../src/runner/roles.js';
import { decisionInputs } from '../src/model/approval.js';
import { exerciseRefusal, type Evidence, type Work } from '../src/model.js';

// GY-523. On 2026-09-26 GY-374's and GY-393's attestations were approved but carried no exercise
// record, so each pass was stored untrusted as unexercised, and the loop answered with rework — the
// wrong remedy, which the GY-393 approver refused. The attestation now carries the exercise record,
// and an unexercised manual: proof is answered by another attestation, never by rework.

const head = 'a'.repeat(40), base = 'b'.repeat(40), at = '2026-09-26T07:00:00.000Z';
const PROOF = 'manual:reproduction-passes';
function item(evidence: Partial<Evidence>[] = [], extra: Partial<Work> = {}): Work {
  const candidate = { sha: head, baseSha: base, pr: 393, branch: 'graphyard/gy-393-1', author: 'worker' };
  return {
    id: 'gy-393', key: 'GY-393', title: 'Attested item', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'The reproduction passes', proofs: [PROOF] }], policy: { checks: ['test'], review: true }, plannedFiles: ['src/'],
    stage: 'acceptance', revision: 4, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [], candidate,
    submission: { epoch: 1, pr: 393 }, reworkRequested: false, scenarioRequirements: [], blocker: null, gates: [], violations: [],
    evidence: evidence.map(entry => ({ id: 'e1', proof: PROOF, sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 1, skipped: 0, producer: 'master-operator', trusted: false, at, ...entry })),
    observation: { candidate, checks: [{ appId: 15368, name: 'test', result: 'success' }], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
      files: ['src/a.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: base, baseTree: base, baseTipContained: true, conversations: { required: true, unresolved: [] } },
    ...extra,
  } as unknown as Work;
}
const unexercised = { unexercised: `${PROOF} does not exercise AC-1: it passed, but no run of it against a tree with the criterion's behaviour removed was recorded` };

test('unit:attestation-carries-exercise — the requested attest input carries an exercise record the control plane trusts', () => {
  const work = item();
  const input = decisionInput('attest', work, { proof: PROOF }) as any;
  assert.deepEqual(input.exercise && { criterion: input.exercise.criterion, result: input.exercise.result, executed: input.exercise.executed }, { criterion: 'AC-1', result: 'fail', executed: 1 });
  assert.match(input.exercise.behaviour, /candidate base bbbbbbbbbbbb/);
  // The server accepts it, and the attested pass is recorded as exercising its criterion.
  assert.equal(decisionInputs.attest.safeParse(input).success, true);
  assert.equal(exerciseRefusal(work, [work], input), null);
  // Without it, the very same pass is unexercised: the failure seen on GY-374 and GY-393.
  assert.notEqual(exerciseRefusal(work, [work], { ...input, exercise: undefined }), null);
  // An exercise the requester names explicitly is kept.
  const named = { criterion: 'AC-1', behaviour: 'the fix in claim()', result: 'fail', executed: 3 };
  assert.deepEqual((decisionInput('attest', work, { proof: PROOF, exercise: named }) as any).exercise, named);
});

test('unit:attestation-carries-exercise — the approver prompt says to confirm the exercise record by running the proof against the candidate base', () => {
  const confirmation = attestConfirmation(base);
  for (const phrase of ['exercise record', 'against the candidate base', base, 'fail', 'refuse'])
    assert.ok(confirmation.includes(phrase), `${phrase} appears in the approver's instruction`);
  assert.ok(piApproverPrompt({ repository: 'owner/project', cliPath: '/bin/graphyard.mjs' }, 'GY-393', 'd1', 'approver').includes(attestConfirmation()));
});

test('unit:attestation-carries-exercise — an unexercised manual proof leads to an attestation request, never to rework', () => {
  const work = item([unexercised]);
  assert.equal(proofRework(work), null);
  const needed = neededDecision(work, { autoMerge: true });
  assert.equal(needed?.action, 'attest');
  assert.deepEqual(needed?.input, { proof: PROOF });
  assert.equal(needed?.binding, `${head}:attest:${PROOF}`);
  assert.match(needed!.reason, /rework is the wrong remedy/);
  assert.match(needed!.reason, /exercise record/);
  // Requested at once, even while a worker's lease is held: an attestation attests nothing about the worker.
  const leased = item([unexercised], { lease: { epoch: 1, owner: 'worker', expiresAt: '2099-01-01T00:00:00.000Z' } } as Partial<Work>);
  assert.equal(routineDecision(leased, { autoMerge: true }, Date.parse(at))?.action, 'attest');
  assert.equal(withheldDecision(leased, { autoMerge: true }, Date.parse(at)), null);
  // The request's input, as the loop posts it, carries the exercise record.
  assert.equal((decisionInput('attest', work, needed!.input!) as any).exercise.result, 'fail');

  // A trusted pass recorded since answers the finding: nothing more is asked for.
  assert.equal(neededDecision(item([unexercised, { id: 'e2', trusted: true, producer: 'master-operator' }]), { autoMerge: true }), null);
  // An unexercised automated proof still returns to the worker.
  const automated = item([{ ...unexercised, proof: 'unit:automated', unexercised: 'unit:automated does not exercise AC-1' }]);
  automated.criteria = [{ id: 'AC-1', text: 'The reproduction passes', proofs: ['unit:automated'] }];
  assert.equal(neededDecision(automated, { autoMerge: true })?.action, 'rework');
});
