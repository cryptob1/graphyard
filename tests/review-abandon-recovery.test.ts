import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionRetry } from '../src/producer.js';
import { reviewAbandonHarness } from './helpers/review-abandon.js';

// GY-3428: four items sat in review with no reviewer. Every attempt had died on a broken opencode
// runtime, so the loop stopped relaunching their requests, and `master review` — the documented
// recovery — only re-queued the request the loop had already abandoned.

let harness: Awaited<ReturnType<typeof reviewAbandonHarness>>;
before(async () => { harness = await reviewAbandonHarness('review-abandon-recovery'); });
after(async () => { await harness?.close(); });

test('integration:review-abandon-recovery — master review on an abandoned review request launches a new reviewer session on the next cycle', async () => {
  await harness.configure([{ name: 'healthy', kind: 'muse' }]);
  const work = await harness.insertReviewItem('GY-9601');
  const abandoned = await harness.recordFailures(work, 4, 10 * 60_000, 'silent for 10 minutes: the reviewer session posted no verdict and changed no output');
  const cursor = await harness.cursor();
  const before = await harness.tick(work, cursor);
  assert.deepEqual(before.launched, [], 'the loop launches nothing more for the spent request');
  assert.ok(cursor.abandoned[abandoned.id], 'the loop abandoned the request to the master');

  const reviewed = await harness.masterReview(work) as { requestId: string; previous: string };
  assert.equal(reviewed.previous, abandoned.id);
  const renewed = (await harness.stored(work.id)).autoDispatch!;
  assert.notEqual(renewed.review!.id, abandoned.id, 'master review asks for the review afresh');
  assert.equal(renewed.review!.id, reviewed.requestId);
  assert.equal(renewed.history.at(-1)!.id, abandoned.id);

  const next = await harness.tick(work, cursor);
  assert.deepEqual(next.launched.map(entry => entry.work), ['GY-9601'], JSON.stringify(next));
  assert.equal((await harness.settled(work.key, reviewed.requestId)).verdict?.state, 'APPROVED');
});

test('integration:review-abandon-recovery — sessions whose runtime could not start do not count toward the failure limit', async () => {
  const at = Date.parse('2026-11-16T12:00:00Z'), iso = (ms: number) => new Date(at + ms).toISOString();
  const quick = (index: number, resolution: string) => ({ requestId: 'r', state: 'failed', requestedAt: iso(index * 600_000), closedAt: iso(index * 600_000 + 2_000), resolution });
  const failures = [
    quick(0, 'the reviewer session finished (headless opencode: opencode could not be started: spawn opencode ENOENT) without posting a verdict'),
    quick(1, "the reviewer session finished (headless opencode: opencode exited with code 1: bwrap: Can't create file at /home/x/.config: Read-only file system) without posting a verdict"),
    quick(2, 'the reviewer session finished (headless opencode: opencode exited with code 1: Free usage limit reached) without posting a verdict'),
    quick(3, 'the reviewer session finished (headless opencode: opencode exited with code 1: unknown option --standalone) without posting a verdict'),
  ];
  const retry = sessionRetry(failures, 'r', at + 4 * 600_000);
  assert.deepEqual([retry.exhausted, retry.launch, retry.started], [false, true, 0], JSON.stringify(retry));
  // A session that ran and then failed still counts: four of them spend the request.
  const ran = failures.map(record => ({ ...record, closedAt: new Date(Date.parse(record.requestedAt) + 5 * 60_000).toISOString() }));
  assert.equal(sessionRetry(ran, 'r', at + 4 * 600_000).exhausted, true);

  // Through the loop: four runtime start failures leave the request launching, never abandoned.
  await harness.configure([{ name: 'healthy-2', kind: 'kilo' }]);
  const work = await harness.insertReviewItem('GY-9602');
  const request = await harness.recordFailures(work, 4, 2_000, 'the reviewer session finished (headless opencode: opencode exited with code 1: bwrap: setting up uid map: Permission denied) without posting a verdict');
  const cursor = await harness.cursor();
  const tick = await harness.tick(work, cursor);
  assert.equal(cursor.abandoned[request.id], undefined, JSON.stringify(tick.waiting));
  assert.deepEqual(tick.launched.map(entry => entry.work), ['GY-9602'], JSON.stringify(tick));
});
