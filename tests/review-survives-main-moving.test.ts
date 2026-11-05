import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { binds } from '../src/model/dispatch.js';
import { exactApproval } from '../src/model/review.js';
import { staleReviewReason } from '../src/reviewer.js';
import { mergeCandidateHold } from '../src/merge-writer/executor.js';
import type { Work } from '../src/model.js';

// GY-3120 AC-4: a review request or approval binds the head and its own diff (the head against its
// merge base), so main moving alone cancels or invalidates neither; a new head or a policy revision
// change asks for a fresh review.

const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const head = sha('head'), mergeBase = sha('merge-base'), tip = sha('tip');

const reviewed = (): Work => {
  const candidate = { sha: head, baseSha: tip, pr: 7, branch: 'graphyard/gy-7-1', author: 'worker' };
  return {
    id: 'w7', key: 'GY-7', type: 'feature', stage: 'build', epoch: 1, lease: null, policyRevision: 3, reworkRequested: false, submission: { epoch: 1, pr: 7 }, candidate,
    policy: { checks: ['test'], review: true }, criteria: [], evidence: [],
    observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], merged: false, mergeSha: null, mergeable: true, protected: false,
      baseTip: tip, mergeBase, baseTipContained: true, at: '2030-01-01T00:00:00.000Z',
      reviews: [{ reviewer: 'reviewer-a', sha: head, state: 'APPROVED', id: 1, submittedAt: '2030-01-01T00:05:00.000Z', body: 'ok', source: 'control-plane', baseSha: mergeBase }] },
    gates: ['ready', 'build', 'review'].map(name => ({ name, passed: true, reasons: [] })),
  } as unknown as Work;
};
/** Main moves: the observation reads a newer base tip the head does not contain; the head and its merge base stand. */
const mainMoved = (work: Work, to: string): Work => ({ ...work, observation: { ...work.observation!, baseTip: to, baseTipContained: false } });

test('unit:review-survives-main-moving — when only main moves, the review request still binds, the approval still stands and the merge writer still lands the head', () => {
  const before = reviewed();
  const request = { sha: head, baseSha: before.candidate!.baseSha, policyRevision: before.policyRevision };
  const record = { key: 'GY-7', sha: head, baseSha: mergeBase, policyRevision: 3 };
  const approval = exactApproval(before);
  assert.ok(approval, 'the head is approved');
  for (const moves of [1, 2, 5]) {
    const after = Array.from({ length: moves }, (_, index) => sha(`tip-${index}`)).reduce(mainMoved, before);
    assert.equal(binds(request, after), true, `the review request is not cancelled after main moved ${moves} times`);
    assert.equal(staleReviewReason(record, [after]), null, 'the reviewer session judging the head\'s own diff is not stale');
    assert.deepEqual(exactApproval(after), approval, 'the approval is not invalidated');
    assert.equal(mergeCandidateHold(after, before), null, 'the merge writer lands the reviewed head');
  }
});

test('unit:review-survives-main-moving — a new head or a policy revision change asks for a fresh review', () => {
  const before = reviewed();
  const request = { sha: head, baseSha: before.candidate!.baseSha, policyRevision: before.policyRevision };
  const record = { key: 'GY-7', sha: head, baseSha: mergeBase, policyRevision: 3 };
  const next = sha('head-2'), candidate = { ...before.candidate!, sha: next };
  const resubmitted = { ...before, candidate, observation: { ...before.observation!, candidate } } as Work;
  assert.equal(binds(request, resubmitted), false, 'a new head cancels the request');
  assert.match(staleReviewReason(record, [resubmitted])!, /^head changed/);
  assert.equal(exactApproval(resubmitted), null, 'an approval of the old head does not carry');
  const revised = { ...before, policyRevision: 4 } as Work;
  assert.equal(binds(request, revised), false, 'a policy revision change cancels the request');
  assert.match(staleReviewReason(record, [revised])!, /^policy revision changed/);
});
