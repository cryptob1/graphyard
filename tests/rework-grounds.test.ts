import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routineDecision } from '../src/master-daemon.js';
import type { Work } from '../src/model.js';

// GY-163, 2026-09-24: a new head arrived with the previous head's review findings still open. The
// loop asked for rework at once; the approver refused it as premature, since the reviewer had not
// judged the head. The reviewer then requested changes on that head, and the loop never asked
// again: both requests were keyed on the head alone, and the refusal barred the key. A rework
// binding therefore names its grounds beside the head.

const head = 'a'.repeat(40), base = 'b'.repeat(40), at = '2026-09-24T06:00:00.000Z';

function item(reviews: { state: string; reviewer: string; submittedAt?: string }[]): Work {
  const candidate = { sha: head, baseSha: base, pr: 154, branch: 'graphyard/gy-163-1', author: 'worker' };
  return {
    id: 'gy-163', key: 'GY-163', title: 'Held fixes', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [], policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'review', revision: 4, policyRevision: 2,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 2, lease: null, workspaces: [], candidate,
    submission: { epoch: 2, pr: 154 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [],
    observation: { candidate, checks: [], reviews: reviews.map(review => ({ submittedAt: at, ...review, sha: head })), merged: false, mergeSha: null, mergeable: true, protected: true,
      files: ['src/a.ts'], scopeFiles: [], at, baseTip: base, baseTree: base, baseTipContained: true },
  } as unknown as Work;
}
const decide = (work: Work) => routineDecision(work, { autoMerge: true }, Date.parse(at));

test('unit:rework-waits-for-review-and-keys-its-grounds — an unreviewed head is not sent back, and a verdict on the head is a request keyed on that verdict', () => {
  // Not yet reviewed: no rework is asked for.
  assert.equal(decide(item([])), null, 'rework before the head is reviewed is premature');
  // The reviewer requests changes on that head: a rework keyed on the verdict, not the head alone.
  const verdict = decide(item([{ state: 'CHANGES_REQUESTED', reviewer: 'graphyard-reviewer[bot]' }]));
  assert.equal(verdict?.action, 'rework');
  assert.equal(verdict?.binding, `${head}:verdict:graphyard-reviewer[bot]`);
  // An approved head owes no rework.
  assert.equal(decide(item([{ state: 'APPROVED', reviewer: 'graphyard-reviewer[bot]' }])), null);
});
