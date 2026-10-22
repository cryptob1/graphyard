import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neededRework } from '../src/daemon/rework.js';
import type { Work } from '../src/model.js';

// 2026-09-25: GY-245's refreshed head a3b75653db55 failed its required `test` check and nothing
// requested the round, so the loop gained a failed-CI rework ground. GY-2010 removed it: checks were
// GitHub's, a stored result is history, and the merge writer's trial failure now grounds the round.

const head = 'a'.repeat(40), base = 'b'.repeat(40), at = '2026-09-25T13:00:00.000Z';
type Check = { name: string; result: string; attempt?: number };
function item(checks: Check[], extra: Partial<Work> = {}): Work {
  const candidate = { sha: head, baseSha: base, pr: 198, branch: 'graphyard/gy-245-1', author: 'worker' };
  return {
    id: 'gy-245', key: 'GY-245', title: 'Single merger', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [], policy: { checks: ['test', 'typecheck'], review: true }, stage: 'test', revision: 4, policyRevision: 2,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [], candidate,
    submission: { epoch: 1, pr: 198 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [],
    observation: { candidate, checks: checks.map(check => ({ appId: 15368, ...check })), reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
      files: ['src/a.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: base, baseTree: base, baseTipContained: true,
      conversations: { required: true, unresolved: [] } },
    ...extra,
  } as unknown as Work;
}
const decide = (work: Work) => neededRework(work);

test('unit:failed-ci-requests-rework — since GY-2010 a pull-request-era CI check stored as failed on the current head requests no rework: the merge writer\'s trial is the only test, and its refusal grounds the round', () => {
  // Every shape that used to ask for a `<head>:ci:<checks>` round now asks for nothing.
  for (const checks of [
    [{ name: 'test', result: 'failure' }, { name: 'typecheck', result: 'success' }],
    [{ name: 'typecheck', result: 'timed_out' }, { name: 'test', result: 'failure' }],
    [{ name: 'test', result: 'failure', attempt: 1 }, { name: 'test', result: 'failure', attempt: 2 }],
  ] as Check[][]) assert.equal(decide(item(checks)), null, `no rework for ${JSON.stringify(checks)}`);
  // Nor do the shapes that never asked.
  assert.equal(decide(item([{ name: 'test', result: 'pending' }])), null);
  assert.equal(decide(item([{ name: 'test', result: 'success' }, { name: 'typecheck', result: 'success' }])), null);
  assert.equal(decide(item([{ name: 'test', result: 'failure' }], { reworkRequested: true } as Partial<Work>)), null);
});
