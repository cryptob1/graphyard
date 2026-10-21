import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareDateVersions, datedVersionPattern, nextDateVersion } from '../src/release.js';

// GY-1959: every candidate production promotes becomes a dated release on the stable channel.
const day = new Date('2026-10-17T23:59:00Z');

test('unit:release-version — the first promotion of a day takes YYYY.M.D, later ones .1, .2', () => {
  assert.equal(nextDateVersion(day, []), '2026.10.17');
  assert.equal(nextDateVersion(day, ['rc/abc', 'stable', 'v0.1.0', '2026.10.16', '2026.10.16.3']), '2026.10.17');
  assert.equal(nextDateVersion(day, ['2026.10.17']), '2026.10.17.1');
  assert.equal(nextDateVersion(day, ['2026.10.17', '2026.10.17.1']), '2026.10.17.2');
  // Gaps and order do not matter: one past the highest suffix of the day.
  assert.equal(nextDateVersion(day, ['2026.10.17.4', '2026.10.17', '2026.10.17.2']), '2026.10.17.5');
  // Months and days carry no leading zero, and the UTC calendar day decides.
  assert.equal(nextDateVersion(new Date('2026-01-05T00:00:00Z'), ['2026.1.4']), '2026.1.5');
  assert.equal(nextDateVersion(new Date('2026-01-05T00:00:00Z'), ['2026.01.05']), '2026.1.5', 'a zero-padded tag is not a date version');
  for (const version of ['2026.10.17', '2026.10.17.1', '2026.1.5']) assert.match(version, datedVersionPattern);
  for (const other of ['0.1.0x', 'v2026.10.17', '2026.10.17.0', 'stable', 'unreleased abc']) assert.doesNotMatch(other, datedVersionPattern);
  assert.deepEqual(['2026.10.17.1', '2026.9.30', '2026.10.17', '2026.10.17.10', '2026.10.17.2'].sort(compareDateVersions),
    ['2026.9.30', '2026.10.17', '2026.10.17.1', '2026.10.17.2', '2026.10.17.10']);
});
