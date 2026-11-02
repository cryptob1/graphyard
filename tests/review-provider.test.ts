import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeReviewRequired, policySchema, reviewProviderOf } from '../src/model.js';

test('only the reviewer-session provider is accepted, including by default', () => {
  for (const reviewProvider of ['codex', 'agent'])
    assert.throws(() => policySchema.parse({ reviewProvider }));
  for (const input of [{}, { reviewProvider: 'github' }]) {
    const policy = policySchema.parse(input);
    assert.equal(reviewProviderOf(policy), 'github');
    assert.equal(nativeReviewRequired(policy), true);
  }
});
