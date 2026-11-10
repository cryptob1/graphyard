import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onboardingWorkRequest } from '../src/model/onboarding-work.js';

test('unit:onboarding-item-proofs-producible — the onboarding item binds its first e2e case and needs no proof that adds a file', () => {
  const request = onboardingWorkRequest('a'.repeat(40), ['test'], 'served-head');
  assert.deepEqual(request.criteria[0]!.proofs, ['e2e:served-head']);
  assert.equal((request as any).closedQuestions, undefined);
  assert.equal(request.policy.review, true);
});
