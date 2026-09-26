import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Observation, Work } from '../src/model.js';
import { dismissedReviewIds } from '../src/github.js';
import { openReviewConflict, reconcileReviewConflict } from '../src/model/review-conflict.js';
import { trackFaults, type FaultRecord } from '../src/model/fault-classes.js';
import { mergeBaseDismissal, mergeBaseDismissalAttention } from '../src/merge-base-ancestry.js';

// GY-486: three review-convergence faults in 24 hours, each counted where no second review event
// happened. The test is named for the proof it produces: manual:fault-class-review-convergence.
//
// - review-conflict on GY-100 (PR #116, head e9a5521c608c): the reviewer App's approval was
//   dismissed by GitHub and the merge broker re-posted it through the same App. GitHub reports one
//   review per identity, so the observation showed only the re-post; the dismissed original stayed
//   standing in the verdict record and the re-post was read as a second verdict for the request.
// - merge-base-dismissed on GY-288, twice: one dismissal (review #5324672415 of 1f1bc8b91d78)
//   stood while the base branch advanced from 0e2108cf789d to ab8fdf6cf47e. The attention line
//   names the base tip, and the fault record kept the letters of a commit hash as wording, so the
//   same standing fault was opened as a new instance.

const sha40 = (prefix: string) => prefix.padEnd(40, '0');
const reviewer = 'graphyard-reviewer[bot]';
const at = (minute: number) => new Date(Date.parse('2026-09-23T21:50:00.000Z') + minute * 60_000);

function gy100(): Work {
  const candidate = { sha: sha40('e9a5521c608c'), baseSha: sha40('b6a984ffc36a'), pr: 116, branch: 'graphyard/gy-100-1', author: 'implementer' };
  const observation: Observation = { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], at: at(0).toISOString(),
    prState: 'open', draft: false, baseTip: candidate.baseSha, baseTipContained: true };
  return { id: 'work-100', key: 'GY-100', title: 'Queue carry', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Carry', proofs: ['unit:x'] }], policy: { checks: [], review: true, reviewProvider: 'github' }, stage: 'merge', revision: 9, policyRevision: 2,
    createdAt: at(0).toISOString(), updatedAt: at(0).toISOString(), stageEnteredAt: at(0).toISOString(), ready: true, epoch: 1, lease: null, workspaces: [], candidate,
    submission: { epoch: 1, pr: 116 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null, gates: [], violations: [],
    autoDispatch: { review: { id: '4177d8bcaee33119be12a468eb5d813c', kind: 'review', sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 2, requestedAt: at(0).toISOString() }, history: [], producers: [] } } as unknown as Work;
}
/** What github.ts observes from a pull request's full review list: each identity's latest review, and every dismissed one. */
function observe(work: Work, list: { id: number; state: string; submitted_at: string }[], minute: number, base = false) {
  const latest = new Map<string, (typeof list)[number]>();
  for (const review of list) latest.set(reviewer, review);
  work.observation = { ...work.observation!, at: at(minute).toISOString(),
    reviews: [...latest.values()].map(review => ({ id: review.id, reviewer, sha: work.candidate!.sha, state: review.state, submittedAt: review.submitted_at })),
    // The base read only each identity's latest review: it recorded no list of dismissed ones.
    ...(base ? {} : { dismissedReviewIds: dismissedReviewIds(list) }) };
  return reconcileReviewConflict(work, at(minute));
}

test('manual:fault-class-review-convergence — GY-100: an approval GitHub dismissed and the reviewer App re-posted is one verdict, not a conflict', () => {
  const original = { id: 5297208889, state: 'APPROVED', submitted_at: '2026-09-23T21:51:24Z' };
  const repost = { id: 5297255395, state: 'APPROVED', submitted_at: '2026-09-23T21:55:54Z' };
  // The reviewer session's approval is observed.
  for (const run of ['base', 'candidate'] as const) {
    const item = gy100();
    assert.deepEqual(observe(item, [original], 2), []);
    // GitHub dismisses it for a merge-base change and the merge broker re-posts it before the next
    // observation: the list now holds the dismissed original and the re-post, and each identity's
    // latest review is the re-post alone.
    const list = [{ ...original, state: 'DISMISSED' }, repost];
    if (run === 'base') {
      // The original's dismissal is never seen, and the re-post is taken for a second verdict.
      assert.deepEqual(observe(item, list, 6, true).map(entry => entry.event), ['review.conflicted'], 'the base raises the conflict');
      assert.deepEqual(openReviewConflict(item)!.verdicts.map(verdict => verdict.id), [original.id, repost.id]);
      continue;
    }
    assert.deepEqual(observe(item, list, 6), [], 'no conflict against the candidate');
    assert.equal(openReviewConflict(item), null);
    assert.deepEqual(item.reviewVerdicts!.verdicts.map(verdict => [verdict.id, !!verdict.dismissed]), [[original.id, true], [repost.id, false]]);
    // The re-posted approval reaches the gates as the one standing verdict.
    assert.deepEqual(item.observation!.reviews.map(review => [review.id, review.state]), [[repost.id, 'APPROVED']]);
  }
});

test('manual:fault-class-review-convergence — GY-100: a second verdict for the request that no dismissal withdrew still conflicts', () => {
  const item = gy100();
  observe(item, [{ id: 11, state: 'APPROVED', submitted_at: '2026-09-23T21:51:24Z' }], 2);
  const transitions = observe(item, [{ id: 11, state: 'APPROVED', submitted_at: '2026-09-23T21:51:24Z' }, { id: 12, state: 'CHANGES_REQUESTED', submitted_at: '2026-09-23T21:52:00Z' }], 3);
  assert.deepEqual(transitions.map(entry => entry.event), ['review.conflicted']);
  assert.deepEqual(openReviewConflict(item)!.verdicts.map(verdict => verdict.id), [11, 12]);
  assert.deepEqual(item.observation!.reviews, [], 'neither verdict reaches the gates');
});

function gy288(baseTip: string): Work {
  const head = '1f1bc8b91d78'.padEnd(40, 'a'), boundBase = 'b6a984ffc36a'.padEnd(40, 'a');
  const candidate = { sha: head, baseSha: boundBase, pr: 288, branch: 'graphyard/gy-288-1', author: 'implementer' };
  return { key: 'GY-288', candidate, observation: { candidate, checks: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: [], at: '2026-09-26T05:05:00.000Z',
    baseTip, baseTipAncestor: false, baseTipContained: false,
    reviews: [{ id: 5324672415, reviewer, sha: head, state: 'DISMISSED', submittedAt: '2026-09-26T04:40:00Z', dismissal: { mergeBase: true, verdict: 'approved', at: '2026-09-26T05:03:19Z', commit: null } }] } } as unknown as Work;
}

test('manual:fault-class-review-convergence — GY-288: one standing merge-base dismissal is one fault while the base branch advances under it', () => {
  const line = (tip: string) => {
    const work = gy288(tip.padEnd(40, 'a'));
    return { kind: 'merge-base-dismissed' as const, faultClass: 'review-convergence' as const, subject: 'GY-288', text: mergeBaseDismissalAttention('GY-288', mergeBaseDismissal(work)!) };
  };
  const first = line('0e2108cf789d'), second = line('ab8fdf6cf47e');
  // The two lines the loop read differ only in the base branch tip they name.
  assert.match(first.text, /base branch tip 0e2108cf789d/);
  assert.match(second.text, /base branch tip ab8fdf6cf47e/);
  assert.notEqual(first.text, second.text);
  const record: FaultRecord = { instances: [], open: {}, failing: {} };
  assert.equal(trackFaults(record, [first], '2026-09-26T05:05:55.157Z').length, 1);
  assert.equal(trackFaults(record, [second], '2026-09-26T05:11:49.761Z').length, 0, 'the advance opens no second instance');
  assert.equal(record.instances.length, 1);
  assert.equal(record.instances[0].lastSeenAt, '2026-09-26T05:11:49.761Z');
  assert.match(record.instances[0].text, /ab8fdf6cf47e/, 'the standing instance carries the latest wording');
  // A dismissal that ended and happens again is a new instance, as before.
  trackFaults(record, [], '2026-09-26T05:20:00.000Z');
  assert.equal(trackFaults(record, [second], '2026-09-26T05:30:00.000Z').length, 1);
  // Only commit hashes are dropped: a different fault on the subject is still its own instance.
  const other = { ...second, text: second.text.replace('for a merge-base change', 'for a changed verdict') };
  assert.equal(trackFaults(record, [second, other], '2026-09-26T05:31:00.000Z').length, 1);
});
