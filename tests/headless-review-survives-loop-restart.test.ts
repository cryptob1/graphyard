import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { reconcileAutoDispatch } from '../src/model-boundary/dispatch.js';
import { liveReviewRequest } from '../src/model/dispatch.js';
import { assertReviewCandidate } from '../src/reviewer.js';
import type { Work } from '../src/model.js';

// GY-3162: every release the loop restarts onto is a merge to main, and the control plane observes a
// candidate against the base tip, so each restart arrived with the candidate's base moved. Review and
// product requests bound that tip, so each was cancelled and its session ended as "no longer
// reports session …: its review request was cancelled", then relaunched from scratch. A request binds
// the head and policy revision: the session in flight keeps running and its verdict is recorded.

const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const head = sha('head');

const observed = (baseSha: string, policyRevision = 2): Work => {
  const candidate = { sha: head, baseSha, pr: 0, branch: 'graphyard/gy-9-1', author: 'worker' };
  return {
    id: 'w9', key: 'GY-9', type: 'feature', stage: 'build', epoch: 1, lease: null, policyRevision, reworkRequested: false, submission: { epoch: 1, pr: 0 }, candidate,
    policy: { checks: ['test'], review: true }, criteria: [{ id: 'AC-1', text: 'works', proofs: ['e2e:create-work-item'] }], evidence: [],
    observation: { source: 'control-plane', candidate, files: ['web/app.ts'], checks: [], merged: false, mergeSha: null, mergeable: true, protected: false,
      baseTip: baseSha, mergeBase: sha('merge-base'), baseTipContained: false, at: '2030-01-01T00:00:00.000Z', reviews: [] },
    gates: ['ready', 'build', 'review'].map(name => ({ name, passed: name !== 'review', reasons: [] })),
  } as unknown as Work;
};
/** The loop restarts onto the release a merge to main produced: the candidate is re-observed against the new tip. */
const releaseLanded = (work: Work, tip: string): Work => {
  const candidate = { ...work.candidate!, baseSha: tip };
  return { ...work, candidate, observation: { ...work.observation!, candidate, baseTip: tip } } as Work;
};

test('unit:headless-review-survives-loop-restart — review and product requests in flight stay open across restarts onto new releases, so their sessions are not cancelled and relaunched', () => {
  let work = observed(sha('tip-0'));
  const opened = reconcileAutoDispatch(work, [work], new Date('2030-01-01T00:01:00.000Z'));
  assert.deepEqual(opened.map(t => `${t.event}:${t.request.kind}`), ['dispatch.requested:review', 'dispatch.requested:product']);
  const review = work.autoDispatch!.review!, product = work.autoDispatch!.product!;
  for (const release of [1, 2, 3, 4]) {
    work = releaseLanded(work, sha(`tip-${release}`));
    const transitions = reconcileAutoDispatch(work, [work], new Date(`2030-01-01T00:0${release + 1}:00.000Z`));
    assert.deepEqual(transitions, [], `release ${release} neither cancels nor reopens a request`);
    assert.equal(work.autoDispatch!.review!.id, review.id, 'the same review request stands');
    assert.equal(work.autoDispatch!.product!.id, product.id, 'the same product request stands');
    assert.equal(liveReviewRequest(work)?.id, review.id, 'the session answering it is still that request\'s');
    assert.doesNotThrow(() => assertReviewCandidate(work, '2030-01-01T00:10:00.000Z', review), 'a launch for the standing request is not refused as superseded');
  }
});

test('unit:headless-review-survives-loop-restart — a new head or a policy revision still cancels the request', () => {
  const work = observed(sha('tip-0'));
  reconcileAutoDispatch(work, [work], new Date('2030-01-01T00:01:00.000Z'));
  const revised = { ...work, policyRevision: 3 } as Work;
  const cancelled = reconcileAutoDispatch(revised, [revised], new Date('2030-01-01T00:02:00.000Z')).filter(t => t.event === 'dispatch.cancelled');
  assert.deepEqual(cancelled.map(t => t.request.resolution), ['policy revision changed from 2 to 3', 'policy revision changed from 2 to 3']);
  const candidate = { ...work.candidate!, sha: sha('head-2') };
  const resubmitted = { ...work, autoDispatch: revised.autoDispatch, candidate, observation: { ...work.observation!, candidate } } as Work;
  assert.throws(() => assertReviewCandidate(resubmitted, '2030-01-01T00:10:00.000Z', { sha: head, baseSha: work.candidate!.baseSha, policyRevision: 2 }), /superseded/);
});
