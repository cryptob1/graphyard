import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, type Work } from '../src/model.js';
import { mergeRefusalEjectionPrefix, standingMergeRefusal } from '../src/merge-queue.js';
import { optimisticEligibility } from '../src/optimistic-merge.js';

// GY-904: a candidate the guarded merge refused — a rework decision awaited, a carried review to
// refresh — must not land past the optimistic lane because no queue record was ever there to
// eject it. The standing refusal is the gate's own judgement of this exact candidate; it holds
// until the decision resolves or the candidate changes. Each test is named for the boundary it pins.

const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const now = new Date('2026-09-28T09:00:00.000Z'), at = '2026-09-28T08:00:00.000Z';
const ci = 15368;

/** An item every gate but the merge queue passes for: submitted, observed fresh, checked, unreviewed policy, no criteria. */
function item(key: string, extra: Partial<Work> = {}): Work {
  const candidate = { sha: sha40(`a${key.slice(3)}`), baseSha: sha40('b0'), pr: 100 + Number(key.slice(3)), branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' };
  return { id: `id-${key}`, key, title: key, description: '', type: 'chore', priority: 0, dependencies: [], plannedFiles: ['src/feature.ts'], criteria: [],
    policy: { checks: ['test'], review: false }, stage: 'merge', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'machine', path: `/tmp/${key}`, branch: candidate.branch, epoch: 1, owner: 'agent' }], candidate, submission: { epoch: 1, pr: candidate.pr }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, violations: [], gates: [],
    observation: { clockOffset: { min: 0, max: 0 }, candidate, baseTip: sha40('b1'), baseTree: sha40('e1'), checks: [{ name: 'test', result: 'success', appId: ci }], reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null,
      files: ['src/feature.ts'], scopeFiles: [], baseChanges: ['src/unrelated.ts'], at: now.toISOString() },
    ...extra } as unknown as Work;
}
const judge = (work: Work, all: Work[] = [work], optimistic = true) => Object.assign(work, evaluate(work, all, now, [ci], { batchSize: 4, optimistic }));
const mergeGate = (work: Work) => work.gates.find(gate => gate.name === 'merge')!;
const refusal = (work: Work, action: 'rereview' | 'rework', overrides: Record<string, unknown> = {}) =>
  ({ sha: work.candidate!.sha, baseSha: work.candidate!.baseSha, policyRevision: work.policyRevision, reason: 'the pull request changed on GitHub before merge', since: at, at, by: 'graphyard-master', action, ...overrides });

test('unit:optimistic-refusal — a standing rework refusal disables the optimistic lane and holds the candidate out of the queue until the candidate changes', () => {
  const work = item('GY-1');
  work.mergeRefusal = refusal(work, 'rework');
  assert.match(standingMergeRefusal(work)!, /awaits a rework decision/);
  // The lane is refused with the reason the gate gave, though every other condition holds.
  const verdict = optimisticEligibility(work, [work], { enabled: true, gatesPass: true });
  assert.equal(verdict.eligible, false);
  assert.match(!verdict.eligible ? verdict.reasons.join('; ') : '', /The guarded merge refused this candidate and the refusal stands: .*awaits a rework decision/);
  // Evaluation agrees: the candidate joins the queue rather than taking the lane…
  judge(work);
  assert.ok(work.queue, 'a refused candidate never holds the optimistic lane');
  assert.equal(work.optimistic ?? null, null);
  // …and the queue ejects it again on the standing refusal, so the merge gate carries the reason.
  judge(work);
  assert.equal(work.queue, null);
  assert.match(work.queueEjection?.reason ?? '', new RegExp(mergeRefusalEjectionPrefix));
  assert.match(mergeGate(work).reasons.join('; '), new RegExp(mergeRefusalEjectionPrefix));
  // The ejection binding stands for this candidate: further evaluations hold it out, and the
  // next cycle cannot merge it even if GitHub's own refusal has since disappeared.
  judge(work);
  assert.equal(work.queue, null);
  assert.equal(work.optimistic ?? null, null);
  // A new candidate — the rework answered with a new head — is judged afresh, and the lane
  // re-forms for it: the refusal bound the head it named, never the item.
  const next = item('GY-1', { candidate: { ...work.candidate!, sha: sha40('c9') } });
  next.observation = { ...(work.observation as NonNullable<Work['observation']>)!, candidate: next.candidate! };
  assert.equal(standingMergeRefusal(next), null);
  assert.equal(optimisticEligibility(next, [next], { enabled: true, gatesPass: true }).eligible, true, 'a changed candidate is not bound by the refusal that named the old head');
});

test('unit:optimistic-refusal — a rereview refusal holds the lane only while no approval binds, and an answered refusal re-forms it', () => {
  const work = item('GY-2');
  work.mergeRefusal = refusal(work, 'rereview', { approval: { reviewer: 'graphyard-reviewer[bot]', reviewId: 41, originalSha: sha40('a2') } });
  assert.match(standingMergeRefusal(work)!, /a fresh review of it is requested/);
  assert.equal(optimisticEligibility(work, [work], { enabled: true, gatesPass: true }).eligible, false);
  // A fresh approval of the head answers the rereview: the refusal no longer stands and the
  // lane is judged on its own merits again.
  const answered = item('GY-2', { observation: { ...(work.observation as Work['observation'])!, reviews: [{ id: 99, reviewer: 'graphyard-reviewer[bot]', sha: sha40('a2'), state: 'APPROVED' }] } });
  answered.mergeRefusal = refusal(answered, 'rereview', { approval: { reviewer: 'graphyard-reviewer[bot]', reviewId: 41, originalSha: sha40('a2') } });
  assert.equal(standingMergeRefusal(answered), null, 'the answered refusal stands no more');
  const verdict = optimisticEligibility(answered, [answered], { enabled: true, gatesPass: true });
  assert.equal(verdict.eligible, true);
  judge(answered);
  assert.equal(answered.queue, null, 'the answered candidate takes the optimistic lane again, not the queue');
});

test('unit:optimistic-refusal — a refusal of another candidate, and a cleared refusal, never hold the lane', () => {
  const work = item('GY-3');
  // The refusal names the candidate exactly: head, base and policy revision.
  assert.equal(standingMergeRefusal(item('GY-3', { mergeRefusal: refusal(item('GY-3'), 'rework', { sha: sha40('99') }) })), null, 'a refusal of another head does not bind');
  assert.equal(standingMergeRefusal(item('GY-3', { mergeRefusal: refusal(item('GY-3'), 'rework', { baseSha: sha40('98') }) })), null, 'a refusal of another base does not bind');
  assert.equal(standingMergeRefusal(item('GY-3', { mergeRefusal: refusal(item('GY-3'), 'rework', { policyRevision: 2 }) })), null, 'a refusal of another policy does not bind');
  assert.equal(optimisticEligibility(work, [work], { enabled: true, gatesPass: true }).eligible, true, 'a candidate no refusal binds takes the lane');
});
