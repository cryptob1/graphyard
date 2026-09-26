import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignment } from '../src/model/assignment.js';
import { principalSchema } from '../src/server.js';
const now = Date.parse('2030-01-01T00:00:00Z');
const lastAssignment = { owner: 'worker-1', epoch: 1, displayName: 'Atlas', runtime: 'Codex', claimedAt: '2029-12-31T23:00:00Z' };
const lease = { owner: 'worker-1', epoch: 1, expiresAt: '2030-01-01T00:02:00Z' };
test('assignment display distinguishes active and previous work, including expiry without reconciliation', () => {
  const active = assignment({ lease, lastAssignment, workspaces: [] }, now);
  assert.equal(active.text, 'Atlas · Codex'); assert.equal(active.active, true);
  assert.equal(assignment({ lease: null, lastAssignment, workspaces: [] }, now).text, 'Last worked by Atlas · Codex');
  assert.equal(assignment({ lease, lastAssignment, workspaces: [] }, now + 180000).active, false);
  assert.equal(assignment({ lease, lastAssignment, workspaces: [] }, now + 180000).text, 'Last worked by Atlas · Codex');
});
test('legacy tasks fall back to actual owner and never borrow another assignment label', () => {
  assert.equal(assignment({ lease, workspaces: [] }, now).text, 'worker-1');
  assert.equal(assignment({ lease: { ...lease, owner: 'worker-2', epoch: 2 }, lastAssignment, workspaces: [] }, now).text, 'worker-2');
  assert.equal(assignment({ lease: null, workspaces: [{ host: 'a', branch: 'b', path: '/tmp/a', owner: 'worker-1', epoch: 1 }] }, now).text, 'Last worked by worker-1');
  assert.equal(assignment({ lease: null, workspaces: [] }, now).text, 'Unassigned');
});
test('operator identity configuration accepts bounded labels without terminal control characters', () => {
  const base = { id: 'worker-1', role: 'worker', token: 'fixture-'.padEnd(32, 'x') };
  assert.equal(principalSchema.parse([{ ...base, displayName: ' Atlas ', runtime: 'Codex' }])[0].displayName, 'Atlas');
  for (const displayName of ['', 'x'.repeat(101), 'agent\u001b[0m']) assert.equal(principalSchema.safeParse([{ ...base, displayName }]).success, false);
});

 test('assignment status uses the server observation despite a skewed client clock', () => {
  const original = Date.now;
  try {
    for (const offset of [-86400000, 86400000]) {
      Date.now = () => now + offset;
      assert.equal(assignment({ lease, lastAssignment, workspaces: [] }, now).active, true);
      assert.equal(assignment({ lease, lastAssignment, workspaces: [] }, now + 180000).active, false);
    }
  } finally { Date.now = original; }
 });
