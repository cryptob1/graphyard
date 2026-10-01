import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import { refusedReworkLiftsMergeRefusal } from '../src/server/decision-refusal.js';
import { standingMergeRefusal } from '../src/merge-queue.js';

// 2026-10-01: after the guarded merge refused a candidate (a `rework` merge refusal, GY-831), the
// loop asked for a rework decision and the independent approver refused it — nothing in the
// candidate needed changing — but nothing lifted the merge refusal, so the entry never re-entered
// the queue (GY-973 waited 14 hours; approval→merge p90 reached 59 hours).
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const item = (refusal: Partial<NonNullable<Work['mergeRefusal']>> | null) => ({
  key: 'GY-9', policyRevision: 3, candidate: { sha: head, baseSha: base },
  mergeRefusal: refusal && { sha: head, baseSha: base, policyRevision: 3, reason: 'awaits authorization', since: '2026-10-01T07:32:36Z', at: '2026-10-01T07:32:36Z', by: 'graphyard', action: 'rework', ...refusal },
}) as unknown as Work;

test('unit:refused-rework-lifts-merge-refusal — a refused rework decision lifts the rework merge refusal of exactly that candidate, so the entry may re-enter the queue', () => {
  const stuck = item({});
  assert.ok(standingMergeRefusal(stuck), 'the rework merge refusal stands before the decision');
  assert.equal(refusedReworkLiftsMergeRefusal(stuck, { action: 'rework' }), true);
  stuck.mergeRefusal = null;
  assert.equal(standingMergeRefusal(stuck), null, 'with the refusal lifted the entry may re-enter');
  // Only a refused rework lifts it, only a rework refusal is lifted, and only for the candidate it named.
  assert.equal(refusedReworkLiftsMergeRefusal(item({}), { action: 'resolve' }), false, 'another action lifts nothing');
  assert.equal(refusedReworkLiftsMergeRefusal(item({ action: 'rereview' }), { action: 'rework' }), false, 'a rereview refusal waits for a fresh approval instead');
  assert.equal(refusedReworkLiftsMergeRefusal(item({ sha: 'c'.repeat(40) }), { action: 'rework' }), false, 'a refusal of an older candidate is not this one');
  assert.equal(refusedReworkLiftsMergeRefusal(item({ baseSha: 'd'.repeat(40) }), { action: 'rework' }), false, 'a refusal against another base is not this one');
  assert.equal(refusedReworkLiftsMergeRefusal(item(null), { action: 'rework' }), false, 'no refusal, nothing to lift');
});
