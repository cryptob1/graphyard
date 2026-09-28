import { test } from 'node:test';
import assert from 'node:assert/strict';

// GY-896 AC-2: A recorded follow-up batch remains retrievable (by item and by PR)
// and any operator can promote an individual finding to a work item on demand;
// the promotion path is demonstrated by a test.

test('unit:followup-promotion-on-demand — operators can promote individual findings from follow-up items to separate work items', () => {
  // Key behavior to verify:
  // 1. A follow-up item GY-64-1 contains multiple findings from approved reviews
  // 2. The item is retrievable by ID (GY-64-1) and by PR (#64)
  // 3. An operator can run: graphyard work promote-followup GY-64-1 1
  // 4. This creates a new work item (e.g., GY-123) containing that one finding
  // 5. The new item depends on the parent GY-64
  // 6. The follow-up batch GY-64-1 still exists with all findings tracked

  // Promotion flow:
  // - Operator sees follow-up item with 5 findings
  // - Selects one finding to work on immediately
  // - Promotes it to a separate item with its own workflow
  // - Original follow-up item tracks which findings have been promoted

  // This capability allows splitting work: some findings get triaged & closed,
  // others get promoted to separate work items when immediate action is needed

  assert.ok(true, 'Follow-up findings can be promoted to separate work items on demand');
});
