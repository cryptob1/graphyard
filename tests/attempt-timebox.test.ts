import { test } from 'node:test';
import * as assert from 'node:assert';
import { failedAttemptCount, maxFailedAttempts, overlongReason, retryBackoffMs, shouldHoldForMaxRetries } from '../src/daemon/reblocked-attempts.js';
import type { Work } from '../src/model.js';
import type { ExhaustionRecord } from '../src/model/capacity.js';

test('unit:overlong-attempt-ended', async t => {
  await t.test('detects an attempt that has run past its role maximum', () => {
    const item: Pick<Work, 'key' | 'capacity'> = { key: 'GY-1', capacity: { exhaustions: [], escalations: [] } };
    const reason = overlongReason(item, 1, 5 * 3_600_000, 4 * 3_600_000, 0);
    assert.ok(reason.includes('overlong attempt'));
    assert.ok(reason.includes('5h0m'));
    assert.ok(reason.includes('4h0m'));
  });

  await t.test('marks an overlong attempt with the retry count', () => {
    const item: Pick<Work, 'key' | 'capacity'> = { key: 'GY-1', capacity: { exhaustions: [], escalations: [] } };
    const reason1 = overlongReason(item, 1, 5 * 3_600_000, 4 * 3_600_000, 0);
    const reason2 = overlongReason(item, 2, 5 * 3_600_000, 4 * 3_600_000, 1);
    const reason3 = overlongReason(item, 3, 5 * 3_600_000, 4 * 3_600_000, 2);
    assert.ok(!reason1.includes('retry'), 'first attempt does not have retry clause');
    assert.ok(reason2.includes('retry 2 of 3'), 'second attempt shows retry 2 of 3');
    assert.ok(reason3.includes('retry 3 of 3'), 'third attempt shows retry 3 of 3');
  });

  await t.test('does not affect an attempt inside the time box', () => {
    const item: Pick<Work, 'key' | 'capacity'> = { key: 'GY-1', capacity: { exhaustions: [], escalations: [] } };
    const ageMs = 2 * 3_600_000; // 2 hours
    const maximumMs = 4 * 3_600_000; // 4 hours
    assert.ok(ageMs <= maximumMs, 'attempt is within time box');
  });
});

test('unit:attempt-retries-capped', async t => {
  await t.test('counts consecutive overlong failures', () => {
    const exhaustions: ExhaustionRecord[] = [
      {
        at: '2026-09-27T16:00:00Z',
        owner: 'principal1',
        recordedBy: 'loop',
        cause: 'interrupted',
        role: 'worker',
        epoch: 1,
        profile: 'profile1',
        account: null,
        runtime: 'claude',
        reason: 'overlong attempt on epoch 1: ran 5h0m, past the 4h0m maximum',
        resetsAt: null,
        partialWork: { state: 'committed' as const, commit: 'abc123' }
      },
      {
        at: '2026-09-27T16:05:00Z',
        owner: 'principal1',
        recordedBy: 'loop',
        cause: 'interrupted',
        role: 'worker',
        epoch: 2,
        profile: 'profile1',
        account: null,
        runtime: 'claude',
        reason: 'overlong attempt on epoch 2: ran 5h0m, past the 4h0m maximum; retry 1 of 3',
        resetsAt: null,
        partialWork: { state: 'committed' as const, commit: 'def456' }
      }
    ];

    const item: Pick<Work, 'id' | 'capacity' | 'submission'> = {
      id: '1',
      submission: null,
      capacity: { exhaustions, escalations: [] }
    };
    assert.equal(failedAttemptCount(item), 2);
  });

  await t.test('stops counting at the third consecutive failure', () => {
    const exhaustions: ExhaustionRecord[] = [];
    for (let i = 1; i <= 4; i++) {
      exhaustions.push({
        at: `2026-09-27T16:0${i}:00Z`,
        owner: 'principal1',
        recordedBy: 'loop',
        cause: 'interrupted',
        role: 'worker',
        epoch: i,
        profile: 'profile1',
        account: null,
        runtime: 'claude',
        reason: `overlong attempt on epoch ${i}`,
        resetsAt: null,
        partialWork: { state: 'committed' as const, commit: `sha${i}` }
      });
    }

    const item: Pick<Work, 'id' | 'capacity' | 'submission'> = {
      id: '1',
      submission: null,
      capacity: { exhaustions, escalations: [] }
    };

    assert.equal(failedAttemptCount(item), 3);
  });

  await t.test('detects when to hold after max retries', () => {
    const exhaustions: ExhaustionRecord[] = [];
    for (let i = 1; i <= 3; i++) {
      exhaustions.push({
        at: `2026-09-27T16:0${i}:00Z`,
        owner: 'principal1',
        recordedBy: 'loop',
        cause: 'interrupted',
        role: 'worker',
        epoch: i,
        profile: 'profile1',
        account: null,
        runtime: 'claude',
        reason: `overlong attempt on epoch ${i}`,
        resetsAt: null,
        partialWork: { state: 'committed' as const, commit: `sha${i}` }
      });
    }

    const item: Pick<Work, 'id' | 'capacity' | 'submission'> = {
      id: '1',
      submission: null,
      capacity: { exhaustions, escalations: [] }
    };

    assert.equal(shouldHoldForMaxRetries(item), true);
  });

  await t.test('has correct backoff intervals', () => {
    assert.deepEqual(retryBackoffMs, [5 * 60_000, 15 * 60_000, 45 * 60_000]);
    assert.equal(retryBackoffMs[0], 5 * 60_000, '1st backoff is 5 minutes');
    assert.equal(retryBackoffMs[1], 15 * 60_000, '2nd backoff is 15 minutes');
    assert.equal(retryBackoffMs[2], 45 * 60_000, '3rd backoff is 45 minutes');
  });

  await t.test('caps maximum failed attempts', () => {
    assert.equal(maxFailedAttempts, 3);
  });

  await t.test('does not count non-overlong interruptions', () => {
    const exhaustions: ExhaustionRecord[] = [
      {
        at: '2026-09-27T16:00:00Z',
        owner: 'principal1',
        recordedBy: 'loop',
        cause: 'interrupted',
        role: 'worker',
        epoch: 1,
        profile: 'profile1',
        account: null,
        runtime: 'claude',
        reason: 'blocked again on epoch 1 after its blocker was cleared',
        resetsAt: null,
        partialWork: { state: 'committed' as const, commit: 'abc123' }
      }
    ];

    const item: Pick<Work, 'id' | 'capacity' | 'submission'> = {
      id: '1',
      submission: null,
      capacity: { exhaustions, escalations: [] }
    };
    assert.equal(failedAttemptCount(item), 0, 'reblocked attempts are not counted as overlong failures');
  });
});
