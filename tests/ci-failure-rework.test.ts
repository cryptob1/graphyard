import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routineDecision } from '../src/master-daemon.js';
import type { Work } from '../src/model.js';

// 2026-09-25: GY-245's worker had completed; a base refresh produced a3b75653db55, whose required
// `test` check failed. The item's next action was `request-rework`, but the loop's decisions had no
// ground for a failed CI check, so nothing requested the round and the item sat in Test for hours.

const head = 'a'.repeat(40), base = 'b'.repeat(40), at = '2026-09-25T13:00:00.000Z';
type Check = { name: string; result: string; attempt?: number };
function item(checks: Check[], extra: Partial<Work> = {}): Work {
  const candidate = { sha: head, baseSha: base, pr: 198, branch: 'graphyard/gy-245-1', author: 'worker' };
  return {
    id: 'gy-245', key: 'GY-245', title: 'Single merger', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [], policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: ['src/'], stage: 'test', revision: 4, policyRevision: 2,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [], candidate,
    submission: { epoch: 1, pr: 198 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [],
    observation: { candidate, checks: checks.map(check => ({ appId: 15368, ...check })), reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
      files: ['src/a.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: base, baseTree: base, baseTipContained: true,
      conversations: { required: true, unresolved: [] } },
    ...extra,
  } as unknown as Work;
}
const decide = (work: Work) => routineDecision(work, { autoMerge: true }, Date.parse(at));

test('unit:failed-ci-requests-rework — a required CI check that failed on the current head asks for a rework round keyed on the head and the failed checks', () => {
  const failed = decide(item([{ name: 'test', result: 'failure' }, { name: 'typecheck', result: 'success' }]));
  assert.equal(failed?.action, 'rework');
  assert.equal(failed?.binding, `${head}:ci:test`);
  assert.match(failed!.reason, /required CI check test failed on candidate aaaaaaaaaaaa/);

  // Both failed: one request naming both.
  assert.equal(decide(item([{ name: 'typecheck', result: 'timed_out' }, { name: 'test', result: 'failure' }]))?.binding, `${head}:ci:test,typecheck`);

  // Still running, passed, or passed on a rerun of the failed attempt: nothing to ask for.
  assert.equal(decide(item([{ name: 'test', result: 'pending' }])), null);
  assert.equal(decide(item([{ name: 'test', result: 'success' }, { name: 'typecheck', result: 'success' }])), null);
  assert.equal(decide(item([{ name: 'test', result: 'failure', attempt: 1 }, { name: 'test', result: 'success', attempt: 2 }])), null);

  // A failed check outside the policy, an observation of another head, or a round already requested asks for nothing.
  assert.equal(decide(item([{ name: 'lint', result: 'failure' }])), null);
  const moved = item([{ name: 'test', result: 'failure' }]);
  moved.observation = { ...moved.observation!, candidate: { ...moved.observation!.candidate, sha: 'c'.repeat(40) } };
  assert.equal(decide(moved), null);
  assert.equal(decide(item([{ name: 'test', result: 'failure' }], { reworkRequested: true } as Partial<Work>)), null);
});
