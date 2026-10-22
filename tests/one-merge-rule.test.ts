import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, type Work } from '../src/model.js';
import { mergeOne, mergeQueue, type MergePorts, type MergeRecordEvent } from '../src/merge-writer/executor.js';
import type { MergeLedgerState } from '../src/model/merge-ledger.js';
import { riskOf } from '../src/model/risk-class.js';
import * as dispatch from '../src/model/dispatch.js';
import * as policy from '../src/model/policy.js';

// GY-2876 AC-1: exactly one merge rule. A head whose delta touches a sensitive path waits for one
// independent approval before the merge writer merges it; any other head merges on its passing trial
// and is reviewed after the merge. No lane, speed target, in-flight cap or item setting decides otherwise.

const H = 'a'.repeat(40), B = 'b'.repeat(40), at = '2031-01-01T00:00:00.000Z', now = new Date(at);

function head(key: string, path: string, review = true): Work {
  const candidate = { sha: H, baseSha: B, pr: 1, branch: `graphyard/${key.toLowerCase()}-1`, author: 'graphyard-claude-1' };
  return { id: `id-${key}`, key, title: `Change ${path}`, description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], policy: { checks: ['test'], review },
    stage: 'review', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'h', path: `/w/${key}-1`, branch: `graphyard/${key.toLowerCase()}-1`, epoch: 1, owner: 'graphyard-claude-1' }], candidate, submission: { epoch: 1, pr: 1 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [],
    observation: { source: 'control-plane', at, candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
      files: [path], scopeFiles: [{ path, status: 'modified' }], baseTip: B, baseTipContained: true } } as unknown as Work;
}
const judged = (item: Work) => { Object.assign(item, evaluate(item, [item], now)); return item; };
const passed = (item: Work, gate: string) => item.gates.find(entry => entry.name === gate)?.passed;

/** The merge writer over in-memory git: every trial passes, every push lands on the tip each head was based on, and each record folds into the item's ledger. */
function writer(items: Work[]) {
  const pushed = new Set<string>();
  const ports: MergePorts = {
    baseBranch: 'main', retrials: 0, now: () => now.getTime(),
    fetch: async () => B,
    merge: async (sha, base) => ({ mergeSha: `${sha.slice(0, 20)}${base.slice(0, 20)}`, files: [] }),
    trial: async () => ({ build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: { 'unit:works': { executed: 1, failed: 0 } } }),
    push: async mergeSha => { pushed.add(mergeSha); return 'pushed'; },
    holds: async sha => pushed.has(sha),
    record: async (target, event: MergeRecordEvent) => {
      const item = items.find(entry => entry.key === target.key)!, ledger = item.mergeLedger ?? null;
      const events = (ledger?.events ?? 0) + 1;
      if (event.kind === 'intent') item.mergeLedger = { key: item.key, state: 'intent', head: event.head, baseTip: event.baseTip, mergeSha: event.mergeSha, risk: event.risk, intentAt: event.at, pushedAt: null, observedTip: null, refusal: null, events } as MergeLedgerState;
      else if (event.kind === 'pushed') item.mergeLedger = { ...ledger!, state: 'pushed', pushedAt: event.pushedAt, events };
      else if (event.kind === 'reconciled') item.mergeLedger = { ...ledger!, state: 'reconciled', observedTip: event.observedTip, events };
    },
  };
  /** One merge-writer turn: the head the queue owes a merge, merged. */
  return async () => {
    const ledger = Object.fromEntries(items.flatMap(item => item.mergeLedger ? [[item.key, item.mergeLedger]] : []));
    const next = mergeQueue(items, ledger, now.getTime()).next;
    const item = next && items.find(entry => entry.key === next.key);
    if (!item) return null;
    const outcome = await mergeOne(ports, item);
    judged(item);
    return { key: item.key, outcome: outcome.outcome };
  };
}

test('unit:one-merge-rule — a sensitive head waits for one reviewer approval before the merge writer merges it; any other head merges on its trial, with no lane, speed target, cap or approval anywhere', async () => {
  // review: false is a retired item setting: it no longer waives the rule.
  const sensitive = judged(head('GY-1', 'package-lock.json', false)), normal = judged(head('GY-2', 'src/feature.ts'));
  assert.equal(riskOf(sensitive).risk, 'sensitive');
  assert.equal(riskOf(normal).risk, 'normal');
  const turn = writer([sensitive, normal]);

  // The merge writer refuses the sensitive head: its review gate holds until an independent approval.
  assert.equal(passed(sensitive, 'review'), false);
  assert.match(sensitive.gates.find(gate => gate.name === 'review')!.reasons.join('\n'), /package-lock\.json/);
  // The normal head merges on its trial with no approval at all, and owes its review after the merge.
  assert.equal(passed(normal, 'review'), true);
  assert.equal((normal as Work & { postMergeReview?: string }).postMergeReview, 'owed');
  assert.deepEqual(await turn(), { key: 'GY-2', outcome: 'merged' });
  assert.equal(normal.mergeLedger?.state, 'reconciled');
  assert.ok(normal.gates.every(gate => gate.passed), JSON.stringify(normal.gates));
  assert.deepEqual(normal.observation!.reviews, [], 'the normal head merged with no approval');
  // Nothing else is owed: the sensitive head is not merged.
  assert.equal(await turn(), null);
  assert.equal(sensitive.mergeLedger ?? null, null);

  // One reviewer verdict approving the exact head releases the sensitive one to the same writer.
  sensitive.observation!.reviews = [{ reviewer: 'graphyard-reviewer[bot]', sha: H, state: 'APPROVED', submittedAt: at, source: 'control-plane', id: 7 }] as NonNullable<Work['observation']>['reviews'];
  judged(sensitive);
  assert.equal(passed(sensitive, 'review'), true);
  assert.deepEqual(await turn(), { key: 'GY-1', outcome: 'merged' });
  assert.ok(sensitive.gates.every(gate => gate.passed), JSON.stringify(sensitive.gates));

  // No lane, speed target, cap or approval decides either item.
  for (const item of [sensitive, normal]) for (const field of ['lane', 'speedTarget']) assert.equal(field in item, false, `${item.key} carries no ${field}`);
  for (const name of ['maxInFlight', 'isHotfix', 'wipHoldWording']) assert.equal(name in dispatch, false, `no ${name}`);
  for (const name of ['lanes', 'determineLane', 'laneSpeedTargets', 'laneRequirements', 'itemLane']) assert.equal(name in policy, false, `no ${name}`);
});
