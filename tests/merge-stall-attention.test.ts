import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeStallAttention, stalledItemAttention } from '../src/cli/status-attention.js';
import type { GitHubMergeQueueState } from '../src/merge-queue.js';
import type { Observation, Work } from '../src/model.js';

// GY-344: GY-245 sat "merge waiting" for over ten minutes on an UNSTABLE head that GitHub would
// merge, with no refusal recorded, and nothing in master status said so. A merge pending more than
// five minutes on a head GitHub reports mergeable is now named, with its pull request, merge state
// and the request's age.

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const now = Date.parse('2026-09-25T19:30:00.000Z');

function work(minutes: number, overrides: Partial<GitHubMergeQueueState> = {}, item: Partial<Work> = {}): Work {
  const candidate = { sha: head, baseSha: base, pr: 198, branch: 'graphyard/gy-245-1', author: 'worker' };
  const githubQueue: GitHubMergeQueueState = { pullRequestId: 'PR_kw', head, queue: false, mergeStateStatus: 'UNSTABLE', mode: 'auto-merge', entryState: null, position: null, groupHead: null,
    at: new Date(now).toISOString(), refused: null, requestedAt: new Date(now - minutes * 60_000).toISOString(), ...overrides };
  return { id: 'work-245', key: 'GY-245', title: 'Pending merge', stage: 'merge', candidate,
    observation: { at: new Date(now).toISOString(), candidate, merged: false, githubQueue } as unknown as Observation, ...item } as Work;
}
const attention = (items: Work[]) => mergeStallAttention({ work: items, now: new Date(now).toISOString() });

test('unit:merge-stall-surfaced — a merge pending six minutes on an UNSTABLE head is a merge-stalled attention item naming the pull request, its merge state and the request\'s age; four minutes is not', () => {
  const [item, ...rest] = attention([work(6)]);
  assert.equal(rest.length, 0);
  assert.equal(item.subject, 'GY-245');
  assert.match(item.text, /^merge-stalled: GY-245 pull request #198 at aaaaaaaaaaaa has been requested for merge for 6 minutes/);
  assert.match(item.text, /mergeStateStatus UNSTABLE/);
  assert.match(item.text, /no refusal is recorded/);
  assert.equal((item as any).role, 'master');
  assert.deepEqual(attention([work(4)]), [], 'four minutes is within the bound');
  // master status raises it with the stalled items, so it is visible within one cycle.
  assert.ok(stalledItemAttention({ work: [work(6)], now: new Date(now).toISOString() }).some(entry => entry.text.startsWith('merge-stalled: GY-245')));

  for (const mergeStateStatus of ['CLEAN', 'HAS_HOOKS']) assert.equal(attention([work(6, { mergeStateStatus })]).length, 1, mergeStateStatus);
  // Not mergeable, refused, queued, another head, no current request, or merged: not a stall.
  for (const mergeStateStatus of ['BLOCKED', 'BEHIND', 'DIRTY', 'UNKNOWN', null]) assert.deepEqual(attention([work(60, { mergeStateStatus })]), [], String(mergeStateStatus));
  assert.deepEqual(attention([work(60, { refused: { reason: 'GitHub refused to enqueue GY-245: no', head, mode: 'none', at: new Date(now).toISOString() } })]), []);
  assert.deepEqual(attention([work(60, { queue: true })]), []);
  assert.deepEqual(attention([work(60, { head: 'c'.repeat(40) })]), []);
  assert.deepEqual(attention([work(60, { requestedAt: null })]), []);
  assert.deepEqual(attention([work(60, {}, { stage: 'done' })]), []);
});
