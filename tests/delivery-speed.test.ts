import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverySpeed } from '../src/pipeline-speed.js';

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const event = (kind: string, minute: number, stage: string) => ({ kind, created_at: at(minute), payload: { work: { stage } } });

test('unit:delivery-speed-metrics — median, p90 and per-stage time from the ledger, attempts and the longest wait', () => {
  const merged = [10, 20, 30].map((length, index) => ({ key: `GY-${index}`, mergedAt: at(length + 5), attempts: index + 1,
    events: [event('create', 0, 'backlog'), event('ready', 5, 'ready'), event('claim', 6, 'build'), event('submit', 5 + length - 2, 'review'), event('merge', 5 + length - 1, 'merge')] }));
  const speed = deliverySpeed(merged, [{ key: 'GY-9', stage: 'review', stageEnteredAt: at(0) }, { key: 'GY-8', stage: 'build', stageEnteredAt: at(60) }], Date.parse(at(120)));
  assert.deepEqual(speed.readyToMerge, { median: 20, p90: 30, samples: 3 });
  assert.deepEqual(speed.stages.build, { median: 17, p90: 27, samples: 3 });
  assert.deepEqual(speed.stages.ready, { median: 1, p90: 1, samples: 3 });
  assert.equal(speed.stages.test, null);
  assert.deepEqual(speed.attempts, { 'GY-2': 3, 'GY-1': 2, 'GY-0': 1 });
  assert.deepEqual(speed.longestWait, { key: 'GY-9', stage: 'review', minutes: 120 });
});
