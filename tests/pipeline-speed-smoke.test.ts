import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trialTimeoutMinutes } from '../src/master/merge-writer-settings.js';

test('the merge trial timeout is a positive whole number of minutes', () => {
  assert.ok(Number.isInteger(trialTimeoutMinutes) && trialTimeoutMinutes > 0);
});
