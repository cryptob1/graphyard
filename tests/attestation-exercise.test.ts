import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neededRework, proofRework } from '../src/daemon/rework.js';
import { intentInput } from '../src/master/autonomy.js';
import { exerciseRefusal, proofExerciseSchema, type Evidence, type Work } from '../src/model.js';

// GY-523. On 2026-09-26 GY-374's and GY-393's attestations were approved but carried no exercise
// record, so each pass was stored untrusted as unexercised, and the loop answered with rework — the
// wrong remedy. The attestation now carries the exercise record, and an unexercised manual: proof is
// never answered by rework.

const head = 'a'.repeat(40), base = 'b'.repeat(40), at = '2026-09-26T07:00:00.000Z';
const PROOF = 'manual:reproduction-passes';
function item(evidence: Partial<Evidence>[] = [], extra: Partial<Work> = {}): Work {
  const candidate = { sha: head, baseSha: base, pr: 393, branch: 'graphyard/gy-393-1', author: 'worker' };
  return {
    id: 'gy-393', key: 'GY-393', title: 'Attested item', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'The reproduction passes', proofs: [PROOF] }], policy: { checks: ['test'], review: true }, 
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
  const input = intentInput('attest', work, { proof: PROOF }) as any;
  assert.deepEqual(input.exercise && { criterion: input.exercise.criterion, result: input.exercise.result, executed: input.exercise.executed }, { criterion: 'AC-1', result: 'fail', executed: 1 });
  assert.match(input.exercise.behaviour, /candidate base bbbbbbbbbbbb/);
  // The server accepts it, and the attested pass is recorded as exercising its criterion.
  assert.equal(proofExerciseSchema.safeParse(input.exercise).success, true);
  assert.equal(exerciseRefusal(work, [work], input), null);
  // Without it, the very same pass is unexercised: the failure seen on GY-374 and GY-393.
  assert.notEqual(exerciseRefusal(work, [work], { ...input, exercise: undefined }), null);
  // An exercise the requester names explicitly is kept.
  const named = { criterion: 'AC-1', behaviour: 'the fix in claim()', result: 'fail', executed: 3 };
  assert.deepEqual((intentInput('attest', work, { proof: PROOF, exercise: named }) as any).exercise, named);
});

test('unit:attestation-carries-exercise — an unexercised manual proof is never answered by rework', () => {
  const work = item([unexercised]);
  assert.equal(proofRework(work), null);
  assert.equal(neededRework(work), null);
  // A trusted pass recorded since answers the finding: nothing more is asked for.
  assert.equal(neededRework(item([unexercised, { id: 'e2', trusted: true, producer: 'master-operator' }])), null);
  // An unexercised automated proof still returns to the worker.
  const automated = item([{ ...unexercised, proof: 'unit:automated', unexercised: 'unit:automated does not exercise AC-1' }]);
  automated.criteria = [{ id: 'AC-1', text: 'The reproduction passes', proofs: ['unit:automated'] }];
  assert.match(neededRework(automated)?.binding ?? '', /:proof:unexercised:unit:automated$/);
});
