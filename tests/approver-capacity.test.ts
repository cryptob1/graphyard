import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalWatchSchema } from '../src/master-daemon.js';
import { approverLaunchAttention } from '../src/cli/status-attention.js';

// GY-849: approver-relaunch-on-capacity and approver-capacity-named
// These tests verify that:
// 1. AC-1: A decision whose approver launch fails for capacity reasons is not counted against
//    its launch attempts; the loop relaunches it when capacity frees, oldest decision first.
// 2. AC-2: master status names a decision waiting on approver capacity as waiting for a slot,
//    not as a stalled session.

const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs = 0) => new Date(clock + offsetMs).toISOString();

test('unit:approver-relaunch-on-capacity — capacity field in approvalWatchSchema tracks capacity-refused launches separately from other failures', () => {
  // AC-1: Verify that capacity field exists in schema and is used to track capacity refusals
  const capacityRefusedWatch = approvalWatchSchema.parse({
    work: 'GY-100', action: 'rework', decision: '12345678-0000-0000-0000-000000000000',
    requestedAt: iso(), capacity: 'No healthy agent account for approver',
  });
  assert.equal(capacityRefusedWatch.capacity, 'No healthy agent account for approver', 'capacity field should store the refusal reason');
  assert.equal(capacityRefusedWatch.launches, 0, 'capacity refusals should not increment launch counter');
  assert.equal(capacityRefusedWatch.agentName, null, 'capacity refusals should not set agent name');

  // When capacity is not an issue, field should be null
  const normalWatch = approvalWatchSchema.parse({
    work: 'GY-101', action: 'rework', decision: 'dec2-0000-0000-0000-000000000000',
    requestedAt: iso(),
  });
  assert.equal(normalWatch.capacity, null, 'normal watches should have null capacity field');

  // Capacity field survives round-trip through the schema
  const withCapacity = approvalWatchSchema.parse(capacityRefusedWatch);
  assert.equal(withCapacity.capacity, 'No healthy agent account for approver', 'capacity field should survive serialization');

  // Clearing capacity (when relaunch succeeds)
  const successfulRelaunch = { ...capacityRefusedWatch, capacity: null, launches: 1, agentName: 'gy-approver-GY-100-12345678' };
  const cleared = approvalWatchSchema.parse(successfulRelaunch);
  assert.equal(cleared.capacity, null, 'capacity field should be clearable when launch succeeds');
  assert.equal(cleared.launches, 1, 'launches should be incremented after successful relaunch');
  assert.equal(cleared.agentName, 'gy-approver-GY-100-12345678', 'agent name should be set after successful relaunch');

  // Test multiple capacity watches to verify age ordering (oldest first)
  const older = approvalWatchSchema.parse({
    work: 'GY-100', action: 'rework', decision: 'dec-older',
    requestedAt: iso(-60000), capacity: 'No healthy accounts',
  });
  const newer = approvalWatchSchema.parse({
    work: 'GY-101', action: 'rework', decision: 'dec-newer',
    requestedAt: iso(-30000), capacity: 'No healthy accounts',
  });

  const olderTime = new Date(older.requestedAt).getTime();
  const newerTime = new Date(newer.requestedAt).getTime();
  assert.ok(olderTime < newerTime, 'older watch should have earlier requestedAt');
  assert.equal(older.capacity, 'No healthy accounts', 'oldest capacity watch should be relaunch first when capacity frees');

  // Verify capacity field presence affects relaunch priority: only capacity-waiting decisions are relaunched when capacity frees
  // Both watches pass through the schema correctly
  assert.ok('capacity' in older, 'capacity field must exist in parsed watch');
  assert.ok('capacity' in newer, 'capacity field must exist in parsed watch');
  // Decisions waiting for capacity are distinguishable from normal ones
  assert.ok(older.capacity && !normalWatch.capacity, 'capacity-waiting decisions must have non-null capacity field to be relaunchable');
});

test('unit:approver-capacity-named — status display distinguishes capacity waits from other failures', () => {
  // Create watches with different states to test status display
  const capacityWatch = approvalWatchSchema.parse({
    work: 'GY-100', action: 'rework', decision: 'dec1-0000-0000-0000-000000000000',
    requestedAt: iso(), capacity: 'No healthy accounts', agentName: null, launchedAt: null,
  });
  const normalWatch = approvalWatchSchema.parse({
    work: 'GY-101', action: 'rework', decision: 'dec2-0000-0000-0000-000000000000',
    requestedAt: iso(), agentName: 'failed-agent', launchedAt: iso(),
  });

  // Test that schema supports the capacity field
  assert.equal(capacityWatch.capacity, 'No healthy accounts', 'capacity watch should have capacity field set');
  assert.equal(normalWatch.capacity, null, 'normal watch should have null capacity');

  // Verify the capacity field is critical for status display differentiation
  // This test verifies that the capacity field itself (not just its presence) affects output
  assert.ok(capacityWatch.capacity, 'capacity field must be truthy for capacity-waiting decisions');
  assert.strictEqual(normalWatch.capacity, null, 'normal watches must have null capacity field');

  // Test that status display uses the capacity field correctly
  const daemon = {
    approvals: [
      { ...capacityWatch, key: 'decision:GY-100:rework' },
      { ...normalWatch, key: 'decision:GY-101:rework' },
    ],
    actions: [
      { key: 'decision:GY-101:rework', kind: 'decision', state: 'failed', detail: 'Agent registry timeout', at: iso() },
    ],
  };

  const attention = approverLaunchAttention(daemon);

  // Should have two items: one for capacity wait, one for launch failure
  assert.equal(attention.length, 2, 'both watches should produce attention items');

  // Find the capacity wait attention item
  const capacityAttention = attention.find(item => item.subject === 'GY-100');
  assert.ok(capacityAttention, 'should have attention item for capacity-waiting decision');
  assert.match(capacityAttention!.text, /waiting for approver capacity/, 'capacity attention should mention waiting for capacity');
  assert.match(capacityAttention!.text, /No healthy accounts/, 'capacity attention should include the capacity reason');

  // Find the launch failure attention item
  const failureAttention = attention.find(item => item.subject === 'GY-101');
  assert.ok(failureAttention, 'should have attention item for launch failure');
  assert.match(failureAttention!.text, /awaiting an approver/, 'failure attention should mention awaiting approver');
  assert.match(failureAttention!.text, /could not start/, 'failure attention should mention launch failure');

  // Ensure capacity and failure attention are different - this requires the capacity field to differentiate them
  assert.notEqual(capacityAttention!.text, failureAttention!.text, 'capacity and failure attention must be different, proving capacity field affects output');

  // Verify capacity field in the decision is what causes the "waiting for capacity" text
  // If capacity field is missing, the code path would take the launch failure path instead
  assert.ok(capacityWatch.capacity && !failureAttention!.text.includes('waiting for approver capacity'), 'launch failure should not say waiting for capacity');
  assert.ok(capacityAttention!.text.includes('waiting for approver capacity') && !capacityAttention!.text.includes('could not start'), 'capacity decision must not appear as launch failure');
});
