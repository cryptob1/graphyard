import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewerApps, type ReviewerApp } from '../src/model.js';
const registry: ReviewerApp[] = [
  { id: 'claude-reviewer', runtime: 'claude', appId: 55001, botUserId: 55002 },
  { id: 'cursor-reviewer', runtime: 'cursor', appId: 66001, botUserId: 66002 },
];
test('the reviewer registry refuses ambiguous identities and unknown fields', () => {
  assert.deepEqual(parseReviewerApps(undefined), []);
  assert.deepEqual(parseReviewerApps(JSON.stringify(registry)), registry);
  for (const invalid of [
    [registry[0], { ...registry[1], id: 'claude-reviewer' }],
    [registry[0], { ...registry[1], appId: registry[0].appId }],
    [registry[0], { ...registry[1], botUserId: registry[0].botUserId }],
    [{ ...registry[0], secret: 'x' }],
    [{ ...registry[0], appId: 0 }],
  ]) assert.throws(() => parseReviewerApps(JSON.stringify(invalid)));
});
