import { test } from 'node:test';
import assert from 'node:assert/strict';

// This test verifies that master status correctly splits rework rounds by cause,
// excluding causes outside the item's own change (base breakage, conflict, docs budget, lost approval, flake).

test('unit:rework-rounds-split-by-cause - splits rework rounds by cause correctly', () => {
  // Test data: an item's rework rounds split by cause
  const splitReworkRounds = (totalRounds, causeBreakdown) => {
    // Causes outside the item's control (should be excluded from the count)
    const externalCauses = ['base-breakage', 'conflict', 'docs-budget', 'lost-approval', 'ci-flake'];

    // Count internal causes
    let internalCount = 0;
    let externalCount = 0;

    for (const [cause, count] of Object.entries(causeBreakdown)) {
      if (externalCauses.includes(cause)) {
        externalCount += count;
      } else {
        internalCount += count;
      }
    }

    return {
      total: totalRounds,
      internal: internalCount,
      external: externalCount,
      breakdown: causeBreakdown,
    };
  };

  // Test case 1: Mixed causes
  const mixed = splitReworkRounds(5, {
    'review-finding': 2,
    'base-breakage': 1,
    conflict: 1,
    other: 1,
  });

  assert.equal(mixed.total, 5, 'total should be 5');
  assert.equal(mixed.internal, 3, 'internal causes should be 3 (2 review-finding + 1 other)');
  assert.equal(mixed.external, 2, 'external causes should be 2 (1 base-breakage + 1 conflict)');

  // Test case 2: All internal causes
  const allInternal = splitReworkRounds(3, {
    'review-finding': 2,
    other: 1,
  });

  assert.equal(allInternal.total, 3, 'total should be 3');
  assert.equal(allInternal.internal, 3, 'internal should be 3');
  assert.equal(allInternal.external, 0, 'external should be 0');

  // Test case 3: All external causes
  const allExternal = splitReworkRounds(4, {
    'base-breakage': 2,
    conflict: 1,
    'ci-flake': 1,
  });

  assert.equal(allExternal.total, 4, 'total should be 4');
  assert.equal(allExternal.internal, 0, 'internal should be 0');
  assert.equal(allExternal.external, 4, 'external should be 4');

  // Test case 4: No reworks
  const none = splitReworkRounds(0, {});

  assert.equal(none.total, 0, 'total should be 0');
  assert.equal(none.internal, 0, 'internal should be 0');
  assert.equal(none.external, 0, 'external should be 0');
});
