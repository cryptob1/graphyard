import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routineDecision } from '../src/master-daemon.js';
import { checkRerunHeld, requiredCheckRun, type RequiredCheck } from '../src/merge-queue.js';
import type { Work } from '../src/model.js';

// GY-1060: the follow-ups of GY-430's approved review. A protection-only required check is read
// alike by the test gate and the rework rule; a check bound to no app prefers the configured CI
// apps' runs; and a commit-status context counts as its run.

const head = 'a'.repeat(40), base = 'b'.repeat(40), at = '2026-10-01T12:00:00.000Z', now = new Date(at);
const ciAppIds = [15368];
type Check = { name: string; result: string; appId?: number; id?: number; source?: 'status' };
function item(checks: Check[], requiredChecks: { name: string; appId: number | null }[] = [{ name: 'secrets', appId: null }], extra: Partial<Work> = {}): Work {
  const candidate = { sha: head, baseSha: base, pr: 300, branch: 'graphyard/gy-1-1', author: 'worker' };
  return {
    id: 'gy-1', key: 'GY-1', title: 'Required checks', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [], policy: { checks: ['test', 'typecheck'], review: false }, stage: 'test', revision: 4, policyRevision: 2,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [], candidate,
    submission: { epoch: 1, pr: 300 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [{ name: 'test', passed: false, reasons: [], ciAppIds }], violations: [],
    observation: { candidate, checks: checks.map((check, index) => ({ appId: 15368, id: index + 1, ...check })), reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
      requiredChecks, files: ['src/a.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: base, baseTree: base, baseTipContained: true,
      conversations: { required: false, unresolved: [] } },
    ...extra,
  } as unknown as Work;
}
const passing: Check[] = [{ name: 'test', result: 'success' }, { name: 'typecheck', result: 'success' }];

test('unit:required-checks-followups — a check bound to no app prefers the configured CI apps, and a commit status counts as its run, in the rework rule over a pull-request-era observation (the test gate reads only the merge writer, GY-2010)', () => {
  const secrets: RequiredCheck = { name: 'secrets', policy: false, appId: null };
  // Another app's failing run beside CI's passing one does not rework the candidate.
  const shadowed = item([...passing, { name: 'secrets', result: 'success' }, { name: 'secrets', result: 'failure', appId: 4242 }]);
  assert.equal(requiredCheckRun(secrets, shadowed.observation!.checks, ciAppIds)?.result, 'success');
  assert.equal(routineDecision(shadowed, { autoMerge: true }, now.getTime()), null);
  // A commit-status context: nothing asks for a rework.
  const status = (result: string) => item([...passing, { name: 'ci/legacy', result, appId: 0, source: 'status' }], [{ name: 'ci/legacy', appId: null }]);
  // Since GY-2010 no stored check grounds a rework, a failed commit status included.
  assert.equal(routineDecision(status('failure'), { autoMerge: true }, now.getTime()), null);
  assert.equal(routineDecision(status('success'), { autoMerge: true }, now.getTime()), null);
  assert.equal(routineDecision(status('pending'), { autoMerge: true }, now.getTime()), null);
  // Another app's stray run of the context's name never hides its commit status (finding 19).
  const strayed = item([...passing, { name: 'ci/legacy', result: 'queued', appId: 4242 }, { name: 'ci/legacy', result: 'success', appId: 0, source: 'status' }], [{ name: 'ci/legacy', appId: null }]);
  assert.equal(requiredCheckRun({ name: 'ci/legacy', policy: false, appId: null }, strayed.observation!.checks, ciAppIds)?.source, 'status');
});

test('unit:required-checks-followups — a rerun owed on a protection-only check bound to another app holds its failure', () => {
  const work = item([...passing, { name: 'secrets', result: 'failure', appId: 7, id: 41 }], [{ name: 'secrets', appId: 7 }],
    { checkReruns: [{ sha: head, check: 'secrets', failedRunId: 41, state: 'owed' }] } as unknown as Partial<Work>);
  assert.equal(checkRerunHeld(work, 'secrets'), true);
  assert.equal(routineDecision(work, { autoMerge: true }, now.getTime()), null, 'the rework waits for the rerun');
  assert.equal(checkRerunHeld({ ...work, checkReruns: [] } as Work, 'secrets'), false);
});
