import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseRefreshNeeded, pendingBaseRefresh, queueSequencingReason } from '../src/merge-queue.js';
import { evaluate, type Evidence, type Observation, type Work } from '../src/model.js';
import { refusalAction } from '../src/model/next-action.js';
import { checkStates, prSteps } from '../src/model/pr-steps.js';

// GY-292: a merge moves main under every open candidate. Only a candidate that conflicts with the
// new base is brought onto it; the rest keep their head, CI, review, proofs and stage. Each test is
// named for the proof it produces.

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
/** The evaluation the engine stores after every observation. */
function evaluated(item: Work, all: Work[]): Work {
  const result = evaluate(item, all, now, ciAppIds);
  return { ...item, stage: result.stage, gates: result.gates, queue: result.queue, queueSequence: result.queueSequence, queueEjection: result.queueEjection, queueHistory: result.queueHistory };
}
const gate = (item: Work, name: string) => item.gates.find(entry => entry.name === name)!;

// GitHub delivery is the only delivery (GY-1235): no candidate enters a Graphyard merge queue, so
// nothing is republished as a speculative tip; GitHub merges each passing head on its own protection.
test('unit:refresh-only-head-and-conflicts — main moving under three candidates rebuilds only the conflicting one; the clean ones keep their head, CI, review, proofs and stage', () => {
  // Before the merge: one candidate passes every gate; two others are in review on main.
  let ready = work('GY-1', commit('c1'));
  let clean = work('GY-2', commit('c2'), { reviews: [] });
  let conflicting = work('GY-3', commit('c3'), { reviews: [] });
  let all = [ready, clean, conflicting];
  [ready, clean, conflicting] = all.map(item => evaluated(item, all));
  all = [ready, clean, conflicting];
  assert.deepEqual([ready.stage, clean.stage, conflicting.stage], ['merge', 'review', 'review']);
  assert.equal(ready.queue, null, 'no candidate is placed in a Graphyard merge queue');
  const snapshot = (item: Work) => ({ candidate: { ...item.candidate! }, gates: item.gates.map(entry => [entry.name, entry.passed]), evidence: item.evidence.map(entry => entry.id), stage: item.stage });
  const before = { ready: snapshot(ready), clean: snapshot(clean) };

  // Another item merges: main moves to `moved`. Every candidate still holds the base it was built
  // on and is behind the new tip; GitHub reports two clean and the third conflicting.
  const behind = { baseTip: moved, baseTree: commit('b1'), baseTipContained: false };
  ready = { ...ready, observation: { ...ready.observation!, ...behind } };
  clean = { ...clean, observation: { ...clean.observation!, ...behind } };
  conflicting = { ...conflicting, observation: { ...conflicting.observation!, ...behind, mergeable: false, conflicting: true } };
  all = [ready, clean, conflicting];
  [ready, clean, conflicting] = all.map(item => evaluated(item, all));
  all = [ready, clean, conflicting];

  // The conflicting one: the control plane tries the merge, which records the conflict for its worker.
  assert.deepEqual(baseRefreshNeeded(conflicting), { head: commit('c3'), boundBase: main, baseTip: moved });
  // The clean ones: nothing is rebuilt, and nothing about them changes.
  for (const [item, recorded] of [[ready, before.ready], [clean, before.clean]] as const) {
    assert.equal(baseRefreshNeeded(item), null, `${item.key}: no refresh`);
    assert.equal(pendingBaseRefresh(item), null);
    assert.deepEqual(snapshot(item), recorded, `${item.key} keeps its head, bound base, CI, review, proofs and stage`);
  }
  const rebuilt = all.filter(item => baseRefreshNeeded(item)).map(item => item.key);
  assert.deepEqual(rebuilt, ['GY-3'], 'only the conflicting candidate is refreshed');

  // Mergeability GitHub has not computed yet is not a conflict: the candidate waits for the next reading.
  const unknown = { ...clean, observation: { ...clean.observation!, mergeable: false, conflicting: undefined } };
  assert.equal(baseRefreshNeeded(unknown), null);
});

test('unit:queue-validation-is-merge-substate — a candidate running CI on its own head is at test, reaches merge once CI passes, and returns to test when it fails; no queue validation substate remains', () => {
  const running = evaluated(work('GY-1', commit('c1'), { checks: [{ name: 'test', result: 'in_progress', appId: 15368 }] }), []);
  assert.equal(running.stage, 'test', 'stage comes from the candidate\'s own gates');
  assert.equal(running.queue, null);
  assert.equal(gate(running, 'merge').reasons.some(reason => queueSequencingReason(reason)), false, 'no queue sequencing reason is ever given');
  assert.equal(prSteps(running, now.getTime()).current, 'test');
  assert.deepEqual(checkStates(running, ciAppIds), [{ name: 'test', state: 'running' }]);

  const passed = evaluated(work('GY-1', commit('c1')), []);
  assert.deepEqual([passed.stage, gate(passed, 'merge').passed, gate(passed, 'merge').reasons], ['merge', true, []]);

  const failed = evaluated(work('GY-1', commit('c1'), { checks: [{ name: 'test', result: 'failure', appId: 15368 }] }), []);
  assert.equal(failed.stage, 'test');
  assert.deepEqual(gate(failed, 'test').reasons, ['Required CI check test has not passed on the current candidate']);
  assert.equal(refusalAction(failed, 'test', gate(failed, 'test').reasons[0]) === 'merge', false, 'a failing check is a refusal someone acts on');
});
