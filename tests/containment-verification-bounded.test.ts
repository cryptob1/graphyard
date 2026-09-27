import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containmentSettlementRefusals, containmentVerificationSchema, type ContainmentVerification } from '../src/quarantine.js';
import type { Work } from '../src/model.js';

const observedAt = '2030-01-01T12:00:00.000Z';
const at = (offsetMs: number) => new Date(Date.parse(observedAt) + offsetMs).toISOString();
const workspace = { host: 'coordinator-host', path: '/srv/worktrees/GY-74-1', branch: 'graphyard/gy-74-1', epoch: 1, owner: 'worker-a' };

function item(overrides: Partial<Work> = {}): Work {
  return { id: 'id-GY-74', key: 'GY-74', title: 'Item', description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/item.ts'], stage: 'build', revision: 3, policyRevision: 1, createdAt: observedAt, updatedAt: observedAt,
    stageEnteredAt: observedAt, ready: true, epoch: 1, lease: null, workspaces: [workspace], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: null, blocker: null, gates: [], violations: [], ...overrides } as Work;
}

test('unit:verification-survives-large-scope a verification with one scope having more than 200 attributed processes parses, marks truncation, and other quarantines settle normally', async () => {
  // Create a large list of pids (350 > 200 limit)
  const largePidList = Array.from({ length: 350 }, (_, i) => 1000 + i);

  // Create a verification with one large scope and one normal scope
  const verification: ContainmentVerification = {
    method: 'linux-proc-systemd',
    platform: 'linux',
    host: 'coordinator-host',
    uid: 1000,
    workspacePath: workspace.path,
    observedAt,
    clockOffset: { min: 0, max: 1 },
    processes: [],
    scopes: [
      {
        unit: 'graphyard-watch-123-abc.scope',
        activeState: 'active',
        processes: [],
        attributed: largePidList.slice(0, 200),
        attributedCount: largePidList.length,
        truncated: true,
      },
      {
        unit: 'graphyard-watch-456-def.scope',
        activeState: 'inactive',
        processes: [],
        attributed: [],
        truncated: false,
      },
    ],
    held: [],
    recordedScope: null,
    inaccessible: 0,
    unverifiable: [],
  };

  // Assert that the verification parses successfully
  const parsed = containmentVerificationSchema.parse(verification);
  assert.deepEqual(parsed.scopes[0].truncated, true);
  assert.deepEqual(parsed.scopes[0].attributedCount, 350);
  assert.deepEqual(parsed.scopes[0].attributed.length, 200);
  assert.deepEqual(parsed.scopes[1].truncated, false);

  // Now test settlement refusals for the large scope
  const quarantineWithLargeScope = item({
    containmentQuarantine: {
      owner: 'worker-a',
      epoch: 1,
      at: at(-600_000),
      settlementHash: 'a'.repeat(64),
      launchAcknowledgedAt: at(-600_000),
      launchExpiresAt: at(-600_000),
      leaseExpiresAt: at(-600_000),
      scope: { unit: 'graphyard-watch-123-abc.scope', pid: 123 },
    },
  });

  // The truncated scope should prevent settlement because it's unknown if all processes are gone
  const refusals = containmentSettlementRefusals(quarantineWithLargeScope, verification, {
    now: Date.parse(observedAt),
  });
  assert.ok(refusals.some(r => r.includes('more than 200 processes')), 'Large scope should prevent settlement');

  // Now test settlement refusals for another item whose quarantine is in a different scope (the small one)
  // Same epoch and owner as the verification's recorded scope to avoid other refusals
  const quarantineInSmallScope = item({
    id: 'id-GY-75',
    key: 'GY-75',
    lease: null, // Expired lease
    containmentQuarantine: {
      owner: 'worker-a',
      epoch: 1,
      at: at(-600_000),
      settlementHash: 'c'.repeat(64),
      launchAcknowledgedAt: at(-600_000),
      launchExpiresAt: at(-600_000),
      leaseExpiresAt: at(-600_000),
      scope: { unit: 'graphyard-watch-456-def.scope', pid: 456 },
    },
  });

  const refusalsForOtherItem = containmentSettlementRefusals(quarantineInSmallScope, verification, {
    now: Date.parse(observedAt),
  });
  // The other item's quarantine should settle normally despite the large scope in the same verification
  // because the large scope is not its own scope
  assert.ok(!refusalsForOtherItem.some(r => r.includes('more than 200 processes')), 'Truncated scope should not block settlement of other quarantines');
  // Verify that other scopes' truncation does not affect this quarantine's settlement
  const hasLargeScopeRefusal = refusalsForOtherItem.some(r => r.includes('more than 200'));
  assert.ok(!hasLargeScopeRefusal, 'Large scope with 350 processes should not generate refusal for quarantine in different scope');
});
