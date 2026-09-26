import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseRefreshNeeded, pendingBaseRefresh, predictQueue, queuePlacement, queueRef, queueSequencingReason } from '../src/merge-queue.js';
import { evaluate, type Evidence, type Observation, type Work } from '../src/model.js';
import { refusalAction } from '../src/model/next-action.js';
import { checkStates, prSteps } from '../src/model/pr-steps.js';

// GY-292: a merge moves main under every open candidate. Only the merge-queue head (through its
// speculative tip) and a candidate that conflicts with the new base are brought onto it; the rest
// keep their head, CI, review, proofs and stage. Each test is named for the proof it produces.

const ciAppIds = [15368];
const commit = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const now = new Date('2026-09-25T09:00:00.000Z');
const main = commit('a0'), moved = commit('a1');

function observation(item: Work, overrides: Partial<Observation> = {}): Observation {
  return {
    candidate: { ...item.candidate! }, checks: [{ name: 'test', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'reviewer', sha: item.candidate!.sha, state: 'APPROVED' }],
    merged: false, mergeSha: null, mergeable: true, protected: true, prState: 'open', draft: false,
    baseTip: item.candidate!.baseSha, baseTree: commit('b0'), baseTipContained: true, files: ['src/engine.ts'], scopeFiles: [], at: now.toISOString(), ...overrides,
  };
}
function evidence(item: Work): Evidence {
  return { id: `e-${item.key}`, proof: 'unit:policy', sha: item.candidate!.sha, baseSha: item.candidate!.baseSha,
    policyRevision: item.policyRevision, producer: 'ci-runner', trusted: true, result: 'pass', executed: 4, skipped: 0, at: now.toISOString() } as Evidence;
}
function work(key: string, head: string, overrides: Partial<Observation> = {}): Work {
  const item = {
    id: key.toLowerCase(), key, title: key, description: '', type: 'feature', priority: 2, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:policy'] }], policy: { checks: ['test'], review: true },
    plannedFiles: ['src/engine.ts'], stage: 'review', revision: 4, policyRevision: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    stageEnteredAt: now.toISOString(), ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'machine', path: `/tmp/${key}`, branch: `graphyard/${key}`, epoch: 1, owner: 'agent' }],
    candidate: { sha: head, baseSha: main, pr: 1, branch: `graphyard/${key}`, author: 'agent' },
    submission: { epoch: 1, pr: 1 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: null, blocker: null, gates: [], violations: [],
  } as unknown as Work;
  item.observation = observation(item, overrides);
  item.evidence = [evidence(item)];
  return item;
}
/** A queued entry whose speculative tip Graphyard published on `main`: the candidate is the tip. */
function queuedTip(item: Work, sequence: number) {
  item.queue = { sequence, enqueuedAt: now.toISOString(), policyRevision: item.policyRevision,
    speculation: { ref: queueRef(item.key), tip: item.candidate!.sha, base: main, baseTree: commit('b0'), predecessors: [], policyRevision: item.policyRevision, publishedAt: now.toISOString() } };
  item.queueSequence = sequence;
  return item;
}
/** The evaluation the engine stores after every observation. */
function evaluated(item: Work, all: Work[]): Work {
  const result = evaluate(item, all, now, ciAppIds);
  return { ...item, stage: result.stage, gates: result.gates, queue: result.queue, queueSequence: result.queueSequence, queueEjection: result.queueEjection, queueHistory: result.queueHistory };
}
const gate = (item: Work, name: string) => item.gates.find(entry => entry.name === name)!;

test('unit:refresh-only-head-and-conflicts — main moving under three candidates rebuilds only the queue head and the conflicting one; the clean one keeps its head, CI, review, proofs and stage', () => {
  // Before the merge: the queue head validated its tip; two others are in review on main.
  let head = queuedTip(work('GY-1', commit('c1')), 1);
  let clean = work('GY-2', commit('c2'), { reviews: [] });
  let conflicting = work('GY-3', commit('c3'), { reviews: [] });
  let all = [head, clean, conflicting];
  [head, clean, conflicting] = all.map(item => evaluated(item, all));
  all = [head, clean, conflicting];
  assert.deepEqual([head.stage, clean.stage, conflicting.stage], ['merge', 'review', 'review']);
  const before = { clean: { candidate: { ...clean.candidate! }, gates: clean.gates.map(entry => [entry.name, entry.passed]), evidence: clean.evidence.map(entry => entry.id) } };

  // Another item merges: main moves to `moved`. Every candidate still holds the base it was built
  // on and is behind the new tip; GitHub reports the second clean and the third conflicting.
  const behind = { baseTip: moved, baseTree: commit('b1'), baseTipContained: false };
  head = { ...head, observation: { ...head.observation!, ...behind } };
  clean = { ...clean, observation: { ...clean.observation!, ...behind } };
  conflicting = { ...conflicting, observation: { ...conflicting.observation!, ...behind, mergeable: false, conflicting: true } };
  all = [head, clean, conflicting];
  [head, clean, conflicting] = all.map(item => evaluated(item, all));
  all = [head, clean, conflicting];

  // The queue head: its tip is republished onto the new main just before it merges.
  assert.equal(baseRefreshNeeded(head), null, 'the queue refreshes its head through the speculative tip');
  const placement = queuePlacement(head, all, now.getTime())!;
  assert.deepEqual([placement.position, placement.predictedBase, placement.current, placement.publishable], [0, moved, false, true]);
  // The conflicting one: the control plane tries the merge, which records the conflict for its worker.
  assert.deepEqual(baseRefreshNeeded(conflicting), { head: commit('c3'), boundBase: main, baseTip: moved });
  // The clean one: nothing is rebuilt, and nothing about it changes.
  assert.equal(baseRefreshNeeded(clean), null);
  assert.equal(pendingBaseRefresh(clean), null);
  assert.equal(queuePlacement(clean, all, now.getTime()), null);
  assert.deepEqual(clean.candidate, before.clean.candidate, 'the clean candidate keeps its head and bound base');
  assert.deepEqual(clean.gates.map(entry => [entry.name, entry.passed]), before.clean.gates, 'its CI, review and proofs stand');
  assert.deepEqual(clean.evidence.map(entry => entry.id), before.clean.evidence);
  assert.equal(clean.stage, 'review', 'the clean candidate stays in its stage');

  const rebuilt = all.filter(item => baseRefreshNeeded(item) || predictQueue(all, now.getTime()).find(entry => entry.id === item.id)?.publishable).map(item => item.key);
  assert.deepEqual(rebuilt, ['GY-1', 'GY-3'], 'only the queue head and the conflicting candidate are refreshed');

  // Mergeability GitHub has not computed yet is not a conflict: the candidate waits for the next reading.
  const unknown = { ...clean, observation: { ...clean.observation!, mergeable: false, conflicting: undefined } };
  assert.equal(baseRefreshNeeded(unknown), null);
});

test('unit:queue-validation-is-merge-substate — the queue head running CI on its combined tip is at merge, validating, never back at test', () => {
  // The queue head's tip was just published on the moved main: CI on it is still running.
  const head = queuedTip(work('GY-1', commit('c1'), { checks: [{ name: 'test', result: 'in_progress', appId: 15368 }] }), 1);
  const validating = evaluated(head, [head]);
  assert.equal(queuePlacement(validating, [validating], now.getTime())!.position, 0);
  assert.equal(validating.stage, 'merge', 'combined-tip CI is a merge-step substate');
  assert.equal(gate(validating, 'test').passed, true, 'the test gate judges the candidate\'s own change');
  const tip = commit('c1').slice(0, 12);
  const reason = `Merge queue is validating speculative tip ${tip}: Required CI check test has not passed on the current candidate`;
  assert.deepEqual(gate(validating, 'merge').reasons, [reason]);
  assert.equal(queueSequencingReason(reason), true);
  assert.equal(refusalAction(validating, 'merge', reason), 'merge', 'the queue making progress, not a refusal anyone acts on');

  // The dashboard shows it at Merge, validating, with the tip's checks.
  const steps = prSteps(validating, now.getTime());
  assert.equal(steps.current, 'merge');
  assert.equal(steps.steps.find(step => step.id === 'test')!.state, 'done');
  assert.equal(steps.label, 'Merging · validating the combined tip · 0 of 1 checks done');
  assert.deepEqual(checkStates(validating, ciAppIds), [{ name: 'test', state: 'running' }]);

  // CI passing on the tip leaves nothing to validate.
  const passed = evaluated({ ...head, observation: { ...head.observation!, checks: [{ name: 'test', result: 'success', appId: 15368 }] } }, [head]);
  assert.deepEqual([passed.stage, gate(passed, 'merge').passed, gate(passed, 'merge').reasons], ['merge', true, []]);

  // CI failing on the tip is an adverse conclusion: the entry is ejected and the test gate refuses as ever.
  const failed = evaluated({ ...head, observation: { ...head.observation!, checks: [{ name: 'test', result: 'failure', appId: 15368 }] } }, [head]);
  assert.equal(failed.queue, null);
  assert.equal(failed.stage, 'test');
  assert.deepEqual(gate(failed, 'test').reasons, ['Required CI check test has not passed on the current candidate']);

  // A candidate outside the queue running CI on its own head is at test: stage comes from its own gates.
  const own = evaluated(work('GY-2', commit('c2'), { checks: [{ name: 'test', result: 'in_progress', appId: 15368 }] }), []);
  assert.equal(own.stage, 'test');
});
