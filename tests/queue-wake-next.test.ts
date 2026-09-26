import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextQueueEntries } from '../src/merge-queue.js';

// 2026-09-25: each delivery woke all ~30 queued entries; the server observes one job at a time at
// 10-13 s each, so the new queue head waited behind a five-minute flood of entries that could not land.

test('unit:delivery-wakes-queue-head-only: a delivery wakes the next entries in queue order, not the whole queue', () => {
  const entry = (id: string, sequence: number | null, stage = 'merge') => ({ id, stage, queue: sequence === null ? null : { sequence } });
  const all = [entry('landed', 10), entry('e', 15), entry('b', 12), entry('c', 13), entry('unqueued', null), entry('d', 14), entry('gone', 11, 'done')];
  assert.deepEqual(nextQueueEntries(all, 'landed', 2).map(item => item.id), ['b', 'c']);
  assert.deepEqual(nextQueueEntries(all, 'landed', 10).map(item => item.id), ['b', 'c', 'd', 'e'], 'never the delivered, unqueued or done entries');
  assert.deepEqual(nextQueueEntries([], 'x', 2), []);
});
