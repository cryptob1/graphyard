import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/model-boundary/gates.js';
import { type Work } from '../src/model.js';
import { mergeCandidateHold, mergeOne, mergeOpeningHold, mergeQueue, mergeRecordKinds, trialAheadOfReviewPrefix, type MergePorts, type MergeRecordEvent } from '../src/merge-writer/executor.js';
import { foldMergeLedger } from '../src/model-boundary/merge-ledger.js';
import type { MergeLedgerState } from '../src/model/merge-ledger.js';
import { riskOf } from '../src/model-boundary/risk-class.js';
import { resolveRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import * as dispatch from '../src/model/dispatch.js';
import * as policy from '../src/model/policy.js';

// GY-2876 AC-1: exactly one merge rule. A head whose delta touches a sensitive path waits for one
// independent approval before the merge writer merges it; any other head merges on its passing trial
// and is reviewed after the merge. No lane, speed target, in-flight cap or item setting decides
// otherwise. GY-3164: the sensitive head's trial runs beside its review — the approval still gates
// the landing, and the head that trialled ahead of it lands on the kept result once approved.

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

/** The merge writer over in-memory git: every trial passes, every push lands on the tip each head was based on, and each record folds into the item's ledger with the real fold. */
function writer(items: Work[]) {
  const pushed = new Set<string>();
  const trials = new Map<string, number>();
  const events = new Map<string, MergeRecordEvent[]>();
  const fold = (item: Work) => {
    const rows = (events.get(item.key) ?? []).map(event => {
      const { kind: _kind, ...fields } = event as unknown as { kind: string };
      return { kind: mergeRecordKinds[event.kind], work: item.key,
        payload: event.kind === 'intent' ? { key: item.key, ...fields } : event.kind === 'refused' ? { ...fields, kind: 'merge' } : fields };
    });
    return foldMergeLedger(rows)[item.key] ?? null;
  };
  const ports: MergePorts = {
    baseBranch: 'main', now: () => now.getTime(),
    fetch: async () => B,
    merge: async (sha, base) => ({ mergeSha: `${sha.slice(0, 20)}${base.slice(0, 20)}`, files: [] }),
    trial: async (_sha, _files, item) => { trials.set(item.key, (trials.get(item.key) ?? 0) + 1); return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: { 'unit:works': { executed: 1, failed: 0 } } }; },
    push: async mergeSha => { pushed.add(mergeSha); return 'pushed'; },
    holds: async sha => pushed.has(sha),
    // The production wiring (effects-production.ts): the build gate alone opens a flight; both gates land it.
    holdOpening: async selected => mergeOpeningHold(items.find(entry => entry.key === selected.key), selected),
    hold: async selected => mergeCandidateHold(items.find(entry => entry.key === selected.key), selected),
    record: async (target, event: MergeRecordEvent) => {
      events.set(target.key, [...(events.get(target.key) ?? []), event]);
      const item = items.find(entry => entry.key === target.key)!;
      item.mergeLedger = fold(item) as MergeLedgerState | null;
    },
  };
  /** One merge-writer turn: the head the queue owes, merged; the queue is re-read from the folded ledger each turn. */
  return async () => {
    const ledger = Object.fromEntries(items.flatMap(item => item.mergeLedger ? [[item.key, item.mergeLedger]] : []));
    const next = mergeQueue(items, ledger, now.getTime()).next;
    const item = next && items.find(entry => entry.key === next.key);
    if (!item) return null;
    const outcome = await mergeOne(ports, item);
    item.mergeLedger = fold(item) as MergeLedgerState | null;
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

  // The sensitive head trials beside its review (GY-3164): the passing trial is kept for it and
  // nothing lands while the review gate holds — the writer's landing boundary, not the queue, is
  // what waits for the approval.
  assert.equal(passed(sensitive, 'review'), false);
  assert.match(sensitive.gates.find(gate => gate.name === 'review')!.reasons.join('\n'), /package-lock\.json/);
  assert.deepEqual(await turn(), { key: 'GY-1', outcome: 'requeued' });
  assert.equal(sensitive.mergeLedger?.state, 'refused');
  assert.ok(sensitive.mergeLedger!.refusal!.reason.startsWith(trialAheadOfReviewPrefix), sensitive.mergeLedger!.refusal!.reason);
  assert.equal(sensitive.mergeLedger!.trial?.head, H, 'the passing trial is kept for exactly this head');
  assert.equal((sensitive.observation!.reviews ?? []).length, 0, 'the sensitive head has no approval');
  // The normal head merges on its trial with no approval at all, and owes its review after the merge.
  assert.equal(passed(normal, 'review'), true);
  assert.equal((normal as Work & { postMergeReview?: string }).postMergeReview, 'owed');
  assert.deepEqual(await turn(), { key: 'GY-2', outcome: 'merged' });
  assert.equal(normal.mergeLedger?.state, 'reconciled');
  assert.ok(normal.gates.every(gate => gate.passed), JSON.stringify(normal.gates));
  assert.deepEqual(normal.observation!.reviews, [], 'the normal head merged with no approval');
  // Nothing else is owed: the sensitive head holds its kept result until the approval.
  assert.equal(await turn(), null);

  // One reviewer verdict approving the exact head releases the sensitive one to the same writer,
  // which lands it on the kept result without a second trial.
  sensitive.observation!.reviews = [{ reviewer: 'graphyard-reviewer[bot]', sha: H, state: 'APPROVED', submittedAt: at, source: 'control-plane', id: 7 }] as NonNullable<Work['observation']>['reviews'];
  judged(sensitive);
  assert.equal(passed(sensitive, 'review'), true);
  assert.deepEqual(await turn(), { key: 'GY-1', outcome: 'merged' });
  assert.ok(sensitive.gates.every(gate => gate.passed), JSON.stringify(sensitive.gates));

  // No lane, speed target, cap or approval decides either item.
  for (const item of [sensitive, normal]) for (const field of ['lane', 'speedTarget']) assert.equal(field in item, false, `${item.key} carries no ${field}`);
  for (const name of ['maxInFlight', 'isHotfix', 'wipHoldWording']) assert.equal(name in dispatch, false, `no ${name}`);
  for (const name of ['lanes', 'determineLane', 'laneSpeedTargets', 'laneRequirements', 'itemLane']) assert.equal(name in policy, false, `no ${name}`);

  // A deployment's policy value written by the previous installer still parses: its retired `review`
  // section is dropped, and of its `only` entries a lane-only one never counted for review and still does not.
  const upgraded = resolveRepositoryPolicy({ review: { normalChanges: 'post-merge' }, risk: { sensitive: [
    { rule: 'store', glob: 'src/store/' }, { rule: 'auth', glob: 'src/auth.ts', only: 'risk' }, { rule: 'ceremony', glob: 'docs/', only: 'lane' }] } });
  assert.deepEqual(upgraded.risk.sensitive, [{ rule: 'store', glob: 'src/store/' }, { rule: 'auth', glob: 'src/auth.ts' }]);
  assert.equal('review' in upgraded, false);
});
