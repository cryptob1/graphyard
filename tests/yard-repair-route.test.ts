import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSchema } from '../src/model-boundary/work.js';
import { dispatchSort } from '../src/model/coordination.js';
import { mergeQueue } from '../src/model/merge-queue.js';
import { needsSpecCheck, specCheckRefusal } from '../src/model/spec-check.js';
import type { Work } from '../src/model.js';

// GY-3102: a yard-repair item takes its own route past a broken pipeline.

const item = (key: string, extra: Record<string, unknown> = {}) => ({
  key, id: key, title: key, type: 'feature', priority: 2, createdAt: '2026-01-01T00:00:00Z', stageEnteredAt: '2026-01-01T00:00:00Z', ...extra,
}) as unknown as Work;

test('unit:yard-repair-route create accepts yardRepair', () => {
  const parsed = createSchema.parse({ title: 'Fix', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:x'] }], yardRepair: true });
  assert.equal(parsed.yardRepair, true);
});

test('unit:yard-repair-route skips the spec-check hold', () => {
  assert.equal(needsSpecCheck(item('GY-1')), true);
  assert.ok(specCheckRefusal(item('GY-1')));
  assert.equal(needsSpecCheck(item('GY-2', { yardRepair: true })), false);
  assert.equal(specCheckRefusal(item('GY-2', { yardRepair: true })), null);
});

test('unit:yard-repair-route sorts first in dispatchSort', () => {
  const sorted = dispatchSort([item('GY-1', { priority: 0 }), item('GY-2', { priority: 4, yardRepair: true })]);
  assert.deepEqual(sorted.map(entry => entry.key), ['GY-2', 'GY-1']);
});

test('unit:yard-repair-route merges first, oldest first', () => {
  const owed = (key: string, createdAt: string, extra: Record<string, unknown> = {}) => item(key, {
    createdAt, stage: 'review', submission: {}, candidate: { sha: key.padEnd(40, '0') }, observation: { source: 'control-plane' },
    gates: [{ name: 'build', passed: true }, { name: 'review', passed: true }], ...extra,
  });
  const queue = mergeQueue([
    owed('GY-1', '2026-01-01T00:00:00Z', { priority: 0 }),
    owed('GY-3', '2026-01-03T00:00:00Z', { yardRepair: true }),
    owed('GY-2', '2026-01-02T00:00:00Z', { yardRepair: true }),
  ], {}, Date.parse('2026-02-01T00:00:00Z'));
  assert.deepEqual(queue.queue.map(entry => entry.key), ['GY-2', 'GY-3', 'GY-1']);
});
