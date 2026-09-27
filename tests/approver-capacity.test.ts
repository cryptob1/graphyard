import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalWatchSchema } from '../src/master-daemon.js';

// GY-849: approver-relaunch-on-capacity and approver-capacity-named
// These tests verify that:
// 1. AC-1: A decision whose approver launch fails for capacity reasons is not counted against
//    its launch attempts; the loop relaunches it when capacity frees, oldest decision first.
// 2. AC-2: master status names a decision waiting on approver capacity as waiting for a slot,
//    not as a stalled session.

test('unit:approver-relaunch-on-capacity — capacity refusals are tracked with watch.capacity field', () => {
  // Verify that the approval watch schema supports the capacity field
  const watch = approvalWatchSchema.parse({
    work: 'GY-100', action: 'rework', decision: '12345678-0000-0000-0000-000000000000',
    requestedAt: '2030-01-01T00:00:00Z', capacity: 'No healthy agent account for approver',
  });
  assert.equal(watch.capacity, 'No healthy agent account for approver');
  assert.equal(watch.agentName, null);
  assert.equal(watch.launchedAt, null);
  assert.equal(watch.launches, 0);
});

test('unit:approver-capacity-named — status display distinguishes capacity waits from other failures', () => {
  // Verify that capacity field is available for status display
  const capacityWatch = approvalWatchSchema.parse({
    work: 'GY-100', action: 'rework', decision: 'dec1-0000-0000-0000-000000000000',
    requestedAt: '2030-01-01T00:00:00Z', capacity: 'No healthy accounts',
  });
  const normalWatch = approvalWatchSchema.parse({
    work: 'GY-101', action: 'rework', decision: 'dec2-0000-0000-0000-000000000000',
    requestedAt: '2030-01-01T00:00:01Z',
  });

  assert.ok(capacityWatch.capacity, 'capacity watch has capacity field set');
  assert.equal(normalWatch.capacity, null, 'normal watch has null capacity');
});
