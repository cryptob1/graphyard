import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitUntilAnswered, unansweredSubmit } from '../src/cli/complete.js';

// GY-3330: the bounds of complete's resubmission — the retry itself, its one line per retry, the
// ten-minute bound, and what is never retried. The e2e case (complete-slow-control-plane) proves
// the wire behaviour at the real 120 s bound; these cover the decisions around it without waiting.

const timeoutError = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

test('unit:complete-slow-submit — an unanswered submission is resent with one line per retry, and the answer reports the record', async () => {
  const lines: string[] = [];
  let clock = 0, calls = 0;
  const submitted = await submitUntilAnswered(async () => {
    if (++calls === 1) throw timeoutError();
    if (calls === 2) throw new TypeError('fetch failed');
    return { submission: { epoch: 2, pr: 9 } };
  }, { totalMs: 10 * 60_000, pauseMs: 2_000, now: () => clock, sleep: async ms => { clock += ms; }, report: line => lines.push(line) });
  assert.deepEqual(submitted, { submission: { epoch: 2, pr: 9 } });
  assert.equal(calls, 3, 'a timeout and a connection failure each retried');
  assert.equal(lines.length, 3, 'one line per retry, and one for the answer');
  assert.match(lines[0]!, /has not answered.*again in 2s \(retry 2/);
  assert.match(lines[1]!, /has not answered.*again in 2s \(retry 3/);
  assert.match(lines[2]!, /answered retry 3.*already recorded/);
});

test('unit:complete-slow-submit — the retry stops at its bound, naming that nothing was duplicated', async () => {
  const lines: string[] = [];
  let clock = 0, calls = 0;
  await assert.rejects(submitUntilAnswered(async () => { clock += 60_000; calls++; throw timeoutError(); },
    { totalMs: 10 * 60_000, pauseMs: 2_000, now: () => clock, sleep: async ms => { clock += ms; }, report: line => lines.push(line) }),
    /aborted due to timeout \(complete keeps sending the same head under the same idempotency key for at most 10 minutes; nothing was duplicated/);
  assert.equal(calls, 10, 'the bound admits ten of this loop\'s sixty-second attempts');
});

test('unit:complete-slow-submit — the server\'s own refusal is never retried or reworded', async () => {
  const refusal = Object.assign(new Error('{"error":"Attempt 1 already submitted"}'), { confirmedRefusal: true, status: 409 });
  let calls = 0;
  await assert.rejects(submitUntilAnswered(async () => { calls++; throw refusal; }, { now: () => 0, sleep: async () => {}, report: () => {} }), error => error === refusal);
  assert.equal(calls, 1);
});

test('unit:complete-slow-submit — what counts as unanswered: the request timeout, dropped and refused connections, the api\'s own unreachable wrap; not a refusal, not a pause text', () => {
  assert.equal(unansweredSubmit(timeoutError()), true);
  assert.equal(unansweredSubmit(new DOMException('This operation was aborted', 'AbortError')), true);
  assert.equal(unansweredSubmit(new TypeError('fetch failed')), true);
  assert.equal(unansweredSubmit(new TypeError('terminated')), true);
  assert.equal(unansweredSubmit(new Error('Control plane unreachable at http://127.0.0.1:4310/api/work/id/submit after 60 seconds')), true);
  assert.equal(unansweredSubmit(Object.assign(new Error('{"error":"Attempt 1 already submitted"}'), { confirmedRefusal: true })), false);
  assert.equal(unansweredSubmit(new Error('GitHub requests paused until 2026-11-15T12:00:00.000Z')), false);
  assert.equal(unansweredSubmit('fetch failed'), false);
  assert.equal(unansweredSubmit(null), false);
});
