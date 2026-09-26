import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNKNOWN_DURATION, durationMinutes, formatAge, formatDuration } from '../src/model/duration.js';

test('exact boundary inputs produce the documented band edges', () => {
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(59), '59m');
  assert.equal(formatDuration(60), '1h');
  assert.equal(formatDuration(61), '1h 1m');
  assert.equal(formatDuration(1439), '23h 59m');
  assert.equal(formatDuration(1440), '24h');
  assert.equal(formatDuration(2879), '47h 59m');
  assert.equal(formatDuration(2880), '2d');
});

test('invalid inputs render the unknown marker without throwing', () => {
  for (const input of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null, undefined, {}, 'x']) {
    assert.equal(formatDuration(input as never), UNKNOWN_DURATION);
  }
});

test('negative inputs clamp to zero minutes instead of emitting negatives', () => {
  assert.equal(formatDuration(-1), '0m');
  assert.equal(formatDuration(-59), '0m');
  assert.equal(formatDuration(-1440), '0m');
});

test('zero components are omitted at exact hour and day multiples', () => {
  assert.equal(formatDuration(60), '1h');
  assert.equal(formatDuration(600), '10h');
  assert.equal(formatDuration(1440), '24h');
  assert.equal(formatDuration(2160), '36h');
  assert.equal(formatDuration(2880), '2d');
  assert.equal(formatDuration(4460), '3d 2h');
});

test('fractional minutes truncate before decomposition instead of rounding', () => {
  assert.equal(formatDuration(59.9), '59m');
  assert.equal(formatDuration(894.9), '14h 54m');
  assert.equal(formatDuration(895), '14h 55m');
  assert.equal(formatDuration(3059.9), '2d 2h');
  assert.equal(formatDuration(0.99), '0m');
});

test('unknown and clear dashboard states stay distinct from durations', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(formatAge('not-a-timestamp', now), UNKNOWN_DURATION);
  assert.equal(durationMinutes('not-a-timestamp', now), null);
  assert.equal(durationMinutes('', now), null);
  assert.equal(formatAge('', now), UNKNOWN_DURATION);
  assert.equal(formatAge('2026-01-01T00:00:00Z', now), '0m');
});

test('future timestamps and clock skew clamp at zero rather than going negative', () => {
  const now = Date.UTC(2026, 0, 1);
  const later = new Date(now + 120 * 60000).toISOString();
  assert.equal(durationMinutes(later, now), 0);
  assert.equal(formatAge(later, now), '0m');
});
