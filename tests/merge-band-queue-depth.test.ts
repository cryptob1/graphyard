import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeBandQueueDepth, observationBand, queuedAhead } from '../src/github.js';
import type { Observation, Work } from '../src/model.js';
import type { NextAction } from '../src/model/action-kinds.js';

// 2026-09-25 21:50 PT: 25 entries sat in the merge queue and every one took the merge band's
// 20-second cadence. Each observation cost the server 10-13 s, so the observations fell behind,
// every merge gate read 'GitHub observation missing or older than two minutes', nothing merged,
// and the queue only grew. Only the entries that can land next need that freshness.

const observation = { at: '2026-09-25T12:00:00.000Z', candidate: { sha: 'a'.repeat(40) }, merged: false, prState: 'open', checks: [], reviews: [] } as unknown as Observation;
const entry = (key: string, sequence: number): Work => ({ id: key, key, stage: 'merge', candidate: { sha: 'a'.repeat(40), pr: 1 }, observation,
  gates: [{ name: 'merge', passed: false, reasons: [] }, { name: 'test', passed: true, reasons: [] }], queue: { sequence } } as unknown as Work);
const now = new Date('2026-09-25T12:00:30.000Z');
const merge = { kind: 'merge' } as unknown as NextAction;

test('unit:merge-band-queue-head: only entries near the queue head take the merge band', () => {
  const queue = Array.from({ length: 6 }, (_, index) => entry(`GY-${index + 1}`, 10 + index));
  assert.deepEqual(queue.map(work => queuedAhead(work, queue)), [0, 1, 2, 3, 4, 5]);
  const bands = queue.map(work => observationBand(work, queue, now, merge).band);
  assert.deepEqual(bands, queue.map((_, index) => index < mergeBandQueueDepth ? 'merge' : 'idle'));
  assert.match(observationBand(queue[4], queue, now, merge).reason, /queued behind 4 entries/);

  // Delivered entries no longer count as ahead, so an entry moves up to the merge band as the head lands.
  const landed = queue.map((work, index) => index < 3 ? { ...work, stage: 'done' } as Work : work);
  assert.equal(observationBand(landed[3], landed, now, merge).band, 'merge');
  // An item at the merge gate but not queued keeps the merge band.
  const unqueued = { ...queue[5], queue: null } as unknown as Work;
  assert.equal(observationBand(unqueued, queue, now, merge).band, 'merge');
});
