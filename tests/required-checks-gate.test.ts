import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routineDecision } from '../src/master-daemon.js';
import { mergeStallAttention } from '../src/cli/master-status.js';
import { ejectionReason, type GitHubMergeQueueState } from '../src/merge-queue.js';
import { evaluate } from '../src/model/gates.js';
import { refusalAction } from '../src/model/refusal-mapping.js';
import type { Work } from '../src/model.js';

// GY-430. 2026-09-25 19:37 PT: GY-402 (PR #221) passed its policy checks test and typecheck, and
// Graphyard reported it mergeable and "merge waiting" every cycle for over ten minutes, while GitHub
// reported it BLOCKED because the branch-protection required check `secrets` had failed. The gate and
// the failed-CI rework rule read only the policy's checks, so no rework was requested.

const head = 'a'.repeat(40), base = 'b'.repeat(40), at = '2026-09-25T19:37:00.000Z', now = new Date(at);
const ciAppIds = [15368];
type Check = { name: string; result: string; appId?: number; id?: number };
function item(checks: Check[], requiredChecks: { name: string; appId: number | null }[] = [{ name: 'secrets', appId: null }, { name: 'Graphyard / merge', appId: 99 }], extra: Partial<Work> = {}): Work {
  const candidate = { sha: head, baseSha: base, pr: 221, branch: 'graphyard/gy-402-1', author: 'worker' };
  return {
    id: 'gy-402', key: 'GY-402', title: 'Required checks', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [], policy: { checks: ['test', 'typecheck'], review: false }, plannedFiles: ['src/'], stage: 'test', revision: 4, policyRevision: 2,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [{ host: 'h', path: '/w', epoch: 1, owner: 'worker', branch: candidate.branch }], candidate,
    submission: { epoch: 1, pr: 221 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [],
    observation: { candidate, checks: checks.map((check, index) => ({ appId: 15368, id: index + 1, ...check })), reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
      requiredChecks, files: ['src/a.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: base, baseTree: base, baseTipContained: true,
      conversations: { required: false, unresolved: [] } },
    ...extra,
  } as unknown as Work;
}
const testGate = (work: Work) => evaluate(work, [work], now, ciAppIds).gates.find(gate => gate.name === 'test')!;
const passing: Check[] = [{ name: 'test', result: 'success' }, { name: 'typecheck', result: 'success' }];

test('unit:required-checks-gate — a failed branch-protection required check outside the policy refuses the test gate as "Required check secrets failed" and asks for rework as a failed policy check does', () => {
  // The incident: policy checks passed, protection requires `secrets`, and its run failed.
  const failed = item([...passing, { name: 'secrets', result: 'failure', appId: 15368 }]);
  const gate = testGate(failed);
  assert.equal(gate.passed, false, 'not mergeable: the test gate refuses');
  assert.deepEqual(gate.reasons, ['Required check secrets failed on the current candidate']);
  assert.notEqual(evaluate(failed, [failed], now, ciAppIds).stage, 'merge');
  assert.equal(refusalAction(failed, 'test', gate.reasons[0]), 'request-rework');

  const decision = routineDecision(failed, { autoMerge: true }, now.getTime());
  assert.equal(decision?.action, 'rework');
  assert.equal(decision?.binding, `${head}:ci:secrets`);
  assert.match(decision!.reason, /required CI check secrets failed on candidate aaaaaaaaaaaa/);
  // Exactly as a failed policy check: both failing are one request naming both.
  assert.equal(routineDecision(item([{ name: 'test', result: 'failure' }, { name: 'typecheck', result: 'success' }, { name: 'secrets', result: 'failure' }]), { autoMerge: true }, now.getTime())?.binding, `${head}:ci:secrets,test`);

  // Still running: not yet passed, a re-read rather than a rework.
  const running = item([...passing, { name: 'secrets', result: 'in_progress' }]);
  assert.deepEqual(testGate(running).reasons, ['Required CI check secrets has not passed on the current candidate']);
  assert.equal(refusalAction(running, 'test', testGate(running).reasons[0]), 'resync');
  assert.equal(routineDecision(running, { autoMerge: true }, now.getTime()), null);
  // Passed, or passed on a rerun: nothing stands. Graphyard's own merge check is never required of the candidate.
  assert.equal(testGate(item([...passing, { name: 'secrets', result: 'success' }])).passed, true);
  assert.equal(testGate(item([...passing, { name: 'secrets', result: 'failure' }, { name: 'secrets', result: 'success' }])).passed, true);
  assert.equal(routineDecision(item([...passing, { name: 'secrets', result: 'failure' }, { name: 'secrets', result: 'success', attempt: 2 } as Check]), { autoMerge: true }, now.getTime()), null);
  // A check protection binds to another app is judged only from that app's runs.
  assert.deepEqual(testGate(item([...passing, { name: 'secrets', result: 'success', appId: 1 }], [{ name: 'secrets', appId: 2 }])).reasons, ['Required CI check secrets has not passed on the current candidate']);
  // Without protection requiring it, a failed check outside the policy stands in no gate and asks for nothing.
  const unprotected = item([...passing, { name: 'secrets', result: 'failure' }], []);
  assert.equal(testGate(unprotected).passed, true);
  assert.equal(routineDecision(unprotected, { autoMerge: true }, now.getTime()), null);

  // A queued speculative tip whose protection-required check failed leaves the queue.
  const queued = item([...passing, { name: 'secrets', result: 'failure' }], undefined, { queue: { sequence: 1, sha: head, baseSha: base, policyRevision: 2, enqueuedAt: at } } as unknown as Partial<Work>);
  assert.match(ejectionReason(queued, ciAppIds) ?? '', /^Required CI check secrets did not pass on speculative tip aaaaaaaaaaaa/);
});

test('unit:blocked-merge-surfaced — a merge pending under auto-merge for over ten minutes on a BLOCKED head is a merge-stalled attention item naming the failed required check', () => {
  const stalled = (minutes: number, work: Work, overrides: Partial<GitHubMergeQueueState> = {}) => {
    const githubQueue: GitHubMergeQueueState = { pullRequestId: 'PR_kw', head, queue: false, mergeStateStatus: 'BLOCKED', mode: 'auto-merge', entryState: null, position: null, groupHead: null,
      at, refused: null, requestedAt: new Date(now.getTime() - minutes * 60_000).toISOString(), ...overrides };
    const staged = { ...work, stage: 'merge', observation: { ...work.observation!, githubQueue } } as Work;
    return mergeStallAttention({ work: [staged], now: at });
  };
  const failed = item([...passing, { name: 'secrets', result: 'failure' }]);
  const [attention, ...rest] = stalled(11, failed);
  assert.equal(rest.length, 0);
  assert.equal(attention.subject, 'GY-402');
  assert.equal(attention.text, `merge-stalled: GY-402 pull request #221 at aaaaaaaaaaaa has been set to auto-merge for 11 minutes (since ${new Date(now.getTime() - 11 * 60_000).toISOString()}) while GitHub reports mergeStateStatus BLOCKED: required check secrets failed`);

  // Ten minutes is within the bound; a merge queue, another head, or a head GitHub does not report BLOCKED is not this stall.
  assert.deepEqual(stalled(9, failed), []);
  assert.deepEqual(stalled(30, failed, { queue: true, mode: 'queued' }), []);
  assert.deepEqual(stalled(30, failed, { mode: 'none' }), []);
  assert.deepEqual(stalled(30, failed, { head: 'c'.repeat(40) }), []);
  assert.deepEqual(stalled(30, failed, { mergeStateStatus: 'BEHIND' }), []);

  // A required check that has not reported, and a missing review, are named as GitHub's reason.
  assert.match(stalled(11, item(passing))[0].text, /BLOCKED: required check secrets has not passed$/);
  assert.match(stalled(11, item([...passing, { name: 'secrets', result: 'success' }]))[0].text, /BLOCKED: a required approving review is missing$/);
});
