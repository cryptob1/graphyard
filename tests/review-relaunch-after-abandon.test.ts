import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewAbandonHarness } from './helpers/review-abandon.js';

// GY-3428 AC-2: four reviewer sessions failed on one broken runtime and the loop abandoned the
// request; once another reviewer account is eligible, master review gets the item its verdict.

let harness: Awaited<ReturnType<typeof reviewAbandonHarness>>;
before(async () => { harness = await reviewAbandonHarness('review-relaunch-after-abandon'); });
after(async () => { await harness?.close(); });

test('e2e:review-relaunch-after-abandon — after four failed reviewer sessions on one runtime, master review gets the item a verdict from another eligible reviewer', async () => {
  await harness.configure([{ name: 'broken-opencode', kind: 'opencode', failure: 'opencode exited: the session crashed mid-review' }]);
  const work = await harness.insertReviewItem('GY-9701');
  const spent = await harness.recordFailures(work, 4, 8 * 60_000, 'the reviewer session finished (headless opencode: opencode exited with code 1: the session crashed mid-review) without posting a verdict');
  const cursor = await harness.cursor();
  const abandoned = await harness.tick(work, cursor);
  assert.deepEqual(abandoned.launched, []);
  assert.match(abandoned.waiting.map(entry => entry.reason).join('\n'), /no further automatic attempt/);

  // The broken runtime is left; a claude reviewer account is the eligible one now.
  await harness.configure([{ name: 'claude-reviewer', kind: 'claude' }]);
  const reviewed = await harness.masterReview(work) as { requestId: string };
  const relaunched = await harness.tick(work, cursor);
  assert.deepEqual(relaunched.launched.map(entry => entry.work), ['GY-9701'], JSON.stringify(relaunched));
  const record = await harness.settled(work.key, reviewed.requestId);
  assert.equal(record.verdict?.state, 'APPROVED', record.resolution);
  assert.notEqual(reviewed.requestId, spent.id);
  assert.equal((await harness.stored(work.id)).reviewLaunch?.verdict?.reviewId, record.verdict?.reviewId, 'the control plane recorded the verdict');
});
