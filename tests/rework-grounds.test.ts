import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routineDecision } from '../src/master-daemon.js';
import type { Work } from '../src/model.js';

// GY-163, 2026-09-24: a new head arrived with the previous head's Codex threads still open. The
// loop asked for rework at once; the approver refused it as premature, since the reviewer had not
// judged the head. The reviewer then requested changes on that head, and the loop never asked
// again: both requests were keyed on the head alone, and the refusal barred the key.

const head = 'a'.repeat(40), base = 'b'.repeat(40), at = '2026-09-24T06:00:00.000Z';
const thread = (id: string) => ({ id, author: 'chatgpt-codex-connector', path: 'src/a.ts', line: 3, outdated: false });

function item(reviews: { state: string; reviewer: string }[], threads = [thread('PRRT_one'), thread('PRRT_two')]): Work {
  const candidate = { sha: head, baseSha: base, pr: 154, branch: 'graphyard/gy-163-1', author: 'worker' };
  return {
    id: 'gy-163', key: 'GY-163', title: 'Held fixes', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [], policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'review', revision: 4, policyRevision: 2,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 2, lease: null, workspaces: [], candidate,
    submission: { epoch: 2, pr: 154 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [],
    observation: { candidate, checks: [], reviews: reviews.map(review => ({ ...review, sha: head, submittedAt: at })), merged: false, mergeSha: null, mergeable: true, protected: true,
      files: ['src/a.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: base, baseTree: base, baseTipContained: true,
      conversations: { required: true, unresolved: threads } },
  } as unknown as Work;
}
const decide = (work: Work) => routineDecision(work, { autoMerge: true }, Date.parse(at));

test('unit:rework-waits-for-review-and-keys-its-grounds — threads left from an earlier head wait for the current head\'s review, and a verdict on the same head is a separate request', () => {
  // Not yet reviewed: the reviewer judges each open thread first, so no rework is asked for.
  assert.equal(decide(item([])), null, 'rework for threads before the head is reviewed is premature');

  // The reviewer requests changes on that head: a rework keyed on the verdict, not the head alone.
  const verdict = decide(item([{ state: 'CHANGES_REQUESTED', reviewer: 'graphyard-reviewer[bot]' }]));
  assert.equal(verdict?.action, 'rework');
  assert.equal(verdict?.binding, `${head}:verdict:graphyard-reviewer[bot]`);

  // Approved, yet threads remain: rework keyed on exactly those threads.
  const threads = decide(item([{ state: 'APPROVED', reviewer: 'graphyard-reviewer[bot]' }]));
  assert.equal(threads?.action, 'rework');
  assert.equal(threads?.binding, `${head}:threads:PRRT_one,PRRT_two`);
  assert.notEqual(threads?.binding, verdict?.binding, 'a refusal of one ground never bars the other');

  // A different set of threads on the same approved head is a different request.
  const fewer = decide(item([{ state: 'APPROVED', reviewer: 'graphyard-reviewer[bot]' }], [thread('PRRT_two')]));
  assert.equal(fewer?.binding, `${head}:threads:PRRT_two`);
});
