import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routineDecision } from '../src/master-daemon.js';
import { checkRerunHeld, ejectionReason, requiredCheckRun, tipVerdict, type RequiredCheck } from '../src/merge-queue.js';
import { evaluate } from '../src/model/gates.js';
import type { Work } from '../src/model.js';

// GY-1060: the follow-ups of GY-430's approved review. A protection-only required check is read
// alike by the test gate, ejection, the batch verdict and the window view; a check bound to no app
// prefers the configured CI apps' runs; and a commit-status context counts as its run.

const head = 'a'.repeat(40), base = 'b'.repeat(40), at = '2026-10-01T12:00:00.000Z', now = new Date(at);
const ciAppIds = [15368];
type Check = { name: string; result: string; appId?: number; id?: number; source?: 'status' };
function item(checks: Check[], requiredChecks: { name: string; appId: number | null }[] = [{ name: 'secrets', appId: null }], extra: Partial<Work> = {}): Work {
  const candidate = { sha: head, baseSha: base, pr: 300, branch: 'graphyard/gy-1-1', author: 'worker' };
  return {
    id: 'gy-1', key: 'GY-1', title: 'Required checks', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [], policy: { checks: ['test', 'typecheck'], review: false }, plannedFiles: ['src/'], stage: 'test', revision: 4, policyRevision: 2,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [], candidate,
    submission: { epoch: 1, pr: 300 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [{ name: 'test', passed: false, reasons: [], ciAppIds }], violations: [],
    observation: { candidate, checks: checks.map((check, index) => ({ appId: 15368, id: index + 1, ...check })), reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
      requiredChecks, files: ['src/a.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: base, baseTree: base, baseTipContained: true,
      conversations: { required: false, unresolved: [] } },
    ...extra,
  } as unknown as Work;
}
const testGate = (work: Work) => evaluate(work, [work], now, ciAppIds).gates.find(gate => gate.name === 'test')!;
const passing: Check[] = [{ name: 'test', result: 'success' }, { name: 'typecheck', result: 'success' }];
const published = (checks: Check[]) => item(checks, undefined, { queue: { sequence: 1, sha: head, baseSha: base, policyRevision: 2, enqueuedAt: at,
  speculation: { tip: head, base, baseTree: base, predecessors: [], policyRevision: 2 } } } as unknown as Partial<Work>);

test('unit:required-checks-followups — a check bound to no app prefers the configured CI apps, and a commit status counts as its run', () => {
  const secrets: RequiredCheck = { name: 'secrets', policy: false, appId: null };
  // Another app's failing run beside CI's passing one neither fails nor reworks the candidate.
  const shadowed = item([...passing, { name: 'secrets', result: 'success' }, { name: 'secrets', result: 'failure', appId: 4242 }]);
  assert.equal(requiredCheckRun(secrets, shadowed.observation!.checks, ciAppIds)?.result, 'success');
  assert.equal(testGate(shadowed).passed, true);
  assert.equal(routineDecision(shadowed, { autoMerge: true }, now.getTime()), null);
  // Nor does another app's passing run satisfy it while CI's run failed.
  assert.deepEqual(testGate(item([...passing, { name: 'secrets', result: 'failure' }, { name: 'secrets', result: 'success', appId: 4242 }])).reasons, ['Required check secrets failed on the current candidate']);
  // With no CI app reporting it, any source counts, as GitHub counts it.
  assert.equal(testGate(item([...passing, { name: 'secrets', result: 'success', appId: 4242 }])).passed, true);
  // A commit-status context: success passes, a failure reworks, pending is waited on.
  const status = (result: string) => item([...passing, { name: 'ci/legacy', result, appId: 0, source: 'status' }], [{ name: 'ci/legacy', appId: null }]);
  assert.equal(testGate(status('success')).passed, true);
  assert.deepEqual(testGate(status('failure')).reasons, ['Required check ci/legacy failed on the current candidate']);
  assert.equal(routineDecision(status('failure'), { autoMerge: true }, now.getTime())?.binding, `${head}:ci:ci/legacy`);
  assert.deepEqual(testGate(status('pending')).reasons, ['Required CI check ci/legacy has not passed on the current candidate']);
  // A status never satisfies a policy check: app 0 is no configured CI app.
  assert.equal(testGate(item([{ name: 'test', result: 'success', appId: 0, source: 'status' }, { name: 'typecheck', result: 'success' }], [])).passed, false);
});

test('unit:required-checks-followups — a published tip failing only a protection-only check reads as fail in its verdict, as ejection reads it', () => {
  const failing = published([...passing, { name: 'secrets', result: 'failure' }]);
  assert.deepEqual(tipVerdict(failing, ciAppIds), { result: 'fail', check: 'secrets' });
  assert.match(ejectionReason(failing, ciAppIds) ?? '', /Required CI check secrets did not pass/);
  // Not yet reported: no verdict, not a pass.
  assert.equal(tipVerdict(published(passing), ciAppIds), undefined);
  assert.deepEqual(tipVerdict(published([...passing, { name: 'secrets', result: 'skipped' }]), ciAppIds), { result: 'pass' }, 'GitHub accepts a skipped protection-only check');
});

test('unit:required-checks-followups — a rerun owed on a protection-only check bound to another app holds its failure', () => {
  const work = item([...passing, { name: 'secrets', result: 'failure', appId: 7, id: 41 }], [{ name: 'secrets', appId: 7 }],
    { checkReruns: [{ sha: head, check: 'secrets', failedRunId: 41, state: 'owed' }] } as unknown as Partial<Work>);
  assert.equal(checkRerunHeld(work, 'secrets'), true);
  assert.equal(routineDecision(work, { autoMerge: true }, now.getTime()), null, 'the rework waits for the rerun');
  assert.equal(checkRerunHeld({ ...work, checkReruns: [] } as Work, 'secrets'), false);
});
