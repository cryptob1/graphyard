import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNKNOWN_DURATION, durationMinutes, formatAge, formatDuration } from '../src/model/duration.js';

test('formatDuration renders minutes below one hour', () => {
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(1), '1m');
  assert.equal(formatDuration(45), '45m');
  assert.equal(formatDuration(59), '59m');
});

test('formatDuration renders hours and minutes from 60 minutes through under 48 hours', () => {
  assert.equal(formatDuration(60), '1h');
  assert.equal(formatDuration(61), '1h 1m');
  assert.equal(formatDuration(894), '14h 54m');
  assert.equal(formatDuration(1439), '23h 59m');
  assert.equal(formatDuration(1440), '24h');
  assert.equal(formatDuration(1500), '25h');
  assert.equal(formatDuration(2879), '47h 59m');
});

test('formatDuration renders days and hours at 48 hours and above', () => {
  assert.equal(formatDuration(2880), '2d');
  assert.equal(formatDuration(3060), '2d 3h');
  assert.equal(formatDuration(10080), '7d');
});

test('formatDuration omits zero components in every band', () => {
  assert.equal(formatDuration(120), '2h');
  assert.equal(formatDuration(125), '2h 5m');
  assert.equal(formatDuration(1440), '24h');
  assert.equal(formatDuration(2160), '36h');
  for (const minutes of [60, 120, 1440, 2880, 4320]) assert.ok(!/\b0[dmh]\b/.test(formatDuration(minutes)), `${minutes} must omit zero components: ${formatDuration(minutes)}`);
});

test('formatDuration renders the documented examples deterministically', () => {
  assert.equal(formatDuration(894), '14h 54m');
  assert.equal(formatDuration(3060), '2d 3h');
});

test('formatDuration preserves the unknown state for missing or invalid input', () => {
  assert.equal(formatDuration(null), UNKNOWN_DURATION);
  assert.equal(formatDuration(undefined), UNKNOWN_DURATION);
  assert.equal(formatDuration(Number.NaN), UNKNOWN_DURATION);
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), UNKNOWN_DURATION);
  assert.equal(formatDuration(Number.NEGATIVE_INFINITY), UNKNOWN_DURATION);
  assert.equal(formatDuration('894' as unknown as number), UNKNOWN_DURATION);
  assert.equal(UNKNOWN_DURATION, '—');
});

test('formatDuration can never emit negative or NaN output', () => {
  for (const input of [-1, -60, -1440, -0.5, Number.EPSILON * -100]) {
    const output = formatDuration(input);
    assert.equal(output, '0m');
    assert.ok(!output.includes('NaN'));
    assert.ok(!/-\d/.test(output));
  }
  assert.ok(!formatDuration(Number.NaN).includes('NaN'));
});

test('formatAge derives clamp-safe dwell from timestamps and preserves unknown timestamps', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  assert.equal(formatAge(new Date(now - 894 * 60000).toISOString(), now), '14h 54m');
  assert.equal(formatAge(new Date(now - 3060 * 60000).toISOString(), now), '2d 3h');
  assert.equal(formatAge(new Date(now + 30 * 60000).toISOString(), now), '0m');
  assert.equal(formatAge('not-a-timestamp', now), UNKNOWN_DURATION);
  assert.equal(durationMinutes('not-a-timestamp', now), null);
  assert.equal(durationMinutes(new Date(now - 90 * 60000).toISOString(), now), 90);
  assert.equal(durationMinutes(new Date(now + 90 * 60000).toISOString(), now), 0);
});
