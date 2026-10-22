import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, type Work } from '../src/model.js';
import { mergeQueue } from '../src/merge-writer/executor.js';
import { riskOf } from '../src/model/risk-class.js';
import * as dispatch from '../src/model/dispatch.js';
import * as policy from '../src/model/policy.js';

// GY-2876 AC-1: exactly one merge rule. A head whose delta touches a sensitive path waits for one
// independent approval before the merge writer merges it; any other head merges on its passing trial
// and is reviewed after the merge. No lane, speed target or in-flight cap exists to decide otherwise.

const H = 'a'.repeat(40), B = 'b'.repeat(40), M = 'c'.repeat(40), at = '2031-01-01T00:00:00.000Z', now = new Date(at);

function head(key: string, path: string): Work {
  const candidate = { sha: H, baseSha: B, pr: 1, branch: `graphyard/${key.toLowerCase()}-1`, author: 'graphyard-claude-1' };
  return { id: `id-${key}`, key, title: `Change ${path}`, description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true },
    stage: 'review', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'h', path: `/w/${key}-1`, branch: `graphyard/${key.toLowerCase()}-1`, epoch: 1, owner: 'graphyard-claude-1' }], candidate, submission: { epoch: 1, pr: 1 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [],
    observation: { source: 'control-plane', at, candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
      files: [path], scopeFiles: [{ path, status: 'modified' }], baseTip: B, baseTipContained: true } } as unknown as Work;
}
const judged = (item: Work) => { Object.assign(item, evaluate(item, [item], now)); return item; };
const passed = (item: Work, gate: string) => item.gates.find(entry => entry.name === gate)?.passed;

test('unit:one-merge-rule — a sensitive head waits for one reviewer approval before the merge writer merges it; any other head merges on its trial, with no lane, speed target, cap or approval anywhere', () => {
  const sensitive = judged(head('GY-1', 'package-lock.json')), normal = judged(head('GY-2', 'src/feature.ts'));
  assert.equal(riskOf(sensitive).risk, 'sensitive');
  assert.equal(riskOf(normal).risk, 'normal');

  // The merge writer refuses the sensitive head: its review gate holds until an independent approval.
  assert.equal(passed(sensitive, 'review'), false);
  assert.match(sensitive.gates.find(gate => gate.name === 'review')!.reasons.join('\n'), /package-lock\.json/);
  // The normal head is due on its trial with no approval at all, and owes its review after the merge.
  assert.equal(passed(normal, 'review'), true);
  assert.equal((normal as Work & { postMergeReview?: string }).postMergeReview, 'owed');
  assert.deepEqual(mergeQueue([sensitive, normal], {}, now.getTime()).due.map(item => item.key), ['GY-2']);

  // Its passing trial, pushed and reconciled, is the merge: every gate passes.
  normal.mergeLedger = { key: 'GY-2', state: 'reconciled', head: H, baseTip: B, mergeSha: M, risk: 'normal', intentAt: at, pushedAt: at, observedTip: M, refusal: null, events: 3 } as Work['mergeLedger'];
  judged(normal);
  assert.ok(normal.gates.every(gate => gate.passed), JSON.stringify(normal.gates));

  // One reviewer verdict approving the exact head releases the sensitive one to the same writer.
  sensitive.observation!.reviews = [{ reviewer: 'graphyard-reviewer[bot]', sha: H, state: 'APPROVED', submittedAt: at, source: 'control-plane', id: 7 }] as NonNullable<Work['observation']>['reviews'];
  judged(sensitive);
  assert.equal(passed(sensitive, 'review'), true);
  assert.deepEqual(mergeQueue([sensitive], {}, now.getTime()).due.map(item => item.key), ['GY-1']);

  // No lane, speed target, cap or approval decides either item.
  for (const item of [sensitive, normal]) for (const field of ['lane', 'speedTarget']) assert.equal(field in item, false, `${item.key} carries no ${field}`);
  assert.deepEqual(normal.observation!.reviews, [], 'the normal head merged with no approval');
  for (const name of ['maxInFlight', 'isHotfix', 'wipHoldWording']) assert.equal(name in dispatch, false, `no ${name}`);
  for (const name of ['lanes', 'determineLane', 'laneSpeedTargets', 'laneRequirements', 'itemLane']) assert.equal(name in policy, false, `no ${name}`);
});
