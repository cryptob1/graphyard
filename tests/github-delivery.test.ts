import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, type Observation, type Work } from '../src/model.js';
import { mergeAuthorized, mergeQueueAction } from '../src/merge-queue.js';
import { deliveredByGitHub, githubDeliveryGate } from '../src/model/delivery-mode.js';

// GitHub delivery (GRAPHYARD_DELIVERY=github): a candidate whose build, review and required checks
// pass is handed to GitHub auto-merge by the observation that saw it pass. No acceptance proof, no
// merge queue, no observation-age rule and no loop request stand between it and GitHub.

const sha = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const A = sha('a1'), M = sha('b1');
const now = new Date('2026-10-04T12:30:00.000Z');
const ciAppIds = [15368];

function item(observedAt: string): Work {
  const at = now.toISOString(), candidate = { sha: A, baseSha: M, pr: 700, branch: 'graphyard/gy-9-1', author: 'worker' };
  const observation = { candidate: { ...candidate }, checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'reviewer', sha: A, state: 'APPROVED' }],
    merged: false, mergeSha: null, mergeable: true, protected: false, prState: 'open', draft: false, baseTip: M, baseTree: sha('7e'), baseTipContained: true,
    files: ['src/server/routes/work.ts'], scopeFiles: [{ path: 'src/server/routes/work.ts', status: 'modified' as const, sha: sha('f'), additions: 1, deletions: 1, binary: false }], at: observedAt } as Observation;
  return {
    id: 'gy-9', key: 'GY-9', title: 'Item', description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Behaviour holds', proofs: ['manual:never-attested'] }], policy: { checks: ['test'], review: true }, plannedFiles: ['src/'],
    stage: 'merge', revision: 3, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'machine', path: '/tmp/gy-9', branch: 'graphyard/gy-9-1', epoch: 1, owner: 'worker' }], implementers: ['worker'], candidate,
    submission: { epoch: 1, pr: 700 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], observation,
  } as unknown as Work;
}
function evaluated(work: Work): Work {
  const result = evaluate(work, [work], now, ciAppIds);
  return { ...work, stage: result.stage, gates: result.gates, queue: result.queue };
}
const githubState = { pullRequestId: 'PR_x', head: A, queue: false, mergeStateStatus: 'CLEAN', mode: 'none' as const, entryState: null, position: null, groupHead: null, at: now.toISOString() };

function withMode<T>(mode: string | undefined, run: () => T): T {
  const before = process.env.GRAPHYARD_DELIVERY;
  if (mode === undefined) delete process.env.GRAPHYARD_DELIVERY; else process.env.GRAPHYARD_DELIVERY = mode;
  try { return run(); } finally { if (before === undefined) delete process.env.GRAPHYARD_DELIVERY; else process.env.GRAPHYARD_DELIVERY = before; }
}

test('unit:github-delivery-hands-passing-candidate-to-github — CI, review and build passing is enough: GitHub auto-merge is asked with no proof, queue, fresh observation or loop request', () => {
  const stale = new Date(now.getTime() - 10 * 60_000).toISOString();
  const work = withMode('github', () => evaluated(item(stale)));
  assert.equal(work.stage, 'merge');
  assert.ok(deliveredByGitHub(work), 'the item carries the github-delivery marker gate');
  assert.equal(work.gates.find(gate => gate.name === 'acceptance'), undefined, 'no acceptance-proof gate');
  assert.deepEqual(work.gates.filter(gate => !gate.passed).map(gate => gate.name), []);
  assert.equal(work.queue, null);
  assert.ok(mergeAuthorized(work), 'every passing gate is the authorization');
  assert.equal(mergeQueueAction(work, githubState, null, now.getTime()).kind, 'enqueue');
});

test('unit:github-delivery-still-refuses-failing-review — an unapproved candidate is not handed to GitHub', () => {
  const unreviewed = item(now.toISOString());
  unreviewed.observation = { ...unreviewed.observation!, reviews: [] };
  const work = withMode('github', () => evaluated(unreviewed));
  assert.equal(work.stage, 'review');
  assert.equal(mergeAuthorized(work), false);
  assert.equal(mergeQueueAction(work, githubState, null, now.getTime()).kind, 'hold');
});

test('unit:queue-delivery-unchanged-without-mode — without GRAPHYARD_DELIVERY=github the unproven proof gates acceptance and no marker is added', () => {
  const work = withMode(undefined, () => evaluated(item(now.toISOString())));
  assert.equal(deliveredByGitHub(work), false);
  assert.equal(work.gates.some(gate => gate.name === githubDeliveryGate), false);
  assert.equal(work.gates.find(gate => gate.name === 'acceptance')?.passed, false);
  assert.equal(mergeQueueAction(work, githubState, null, now.getTime()).kind, 'hold');
});
