import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containmentSettlementRefusals, containmentVerificationSchema, containmentProbeFreshnessMs, type ContainmentVerification } from '../src/quarantine.js';
import type { Work } from '../src/model.js';

const observedAt = '2030-01-01T12:00:00.000Z';
const at = (offsetMs: number) => new Date(Date.parse(observedAt) + offsetMs).toISOString();

function workItem(scopeUnit: string, pid: number, overrides: Partial<Work> = {}): Work {
  return {
    id: 'work-id', key: 'GY-test', title: 'Test Item', description: '', type: 'bug', priority: 1,
    dependencies: [], criteria: [], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'build', revision: 1, policyRevision: 1, createdAt: observedAt, updatedAt: observedAt,
    stageEnteredAt: observedAt, ready: true, epoch: 1, lease: null, candidate: null,
    submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: null, blocker: null, gates: [], violations: [],
    workspaces: [{ host: 'test-host', path: '/test', branch: 'test', epoch: 1, owner: 'test-owner' }],
    containmentQuarantine: {
      id: 'quarantine-id', owner: 'test-owner', epoch: 1, at: at(-70_000),
      settlementHash: 'a'.repeat(64), leaseExpiresAt: at(-60_000), launchExpiresAt: at(-60_000),
      launchAcknowledgedAt: at(-70_000),
      scope: { unit: scopeUnit, pid },
    } as any,
    sessions: [] as any,
    ...overrides,
  } as Work;
}

test('unit:verification-survives-large-scope a scope with >200 processes is recorded with truncation markers and allows settlement', async () => {
  // Create a scope with 350 attributed processes. The probe truncates to 200 and records the full count.
  const hugePids = Array.from({ length: 350 }, (_, i) => i + 100);
  const verification: ContainmentVerification = {
    method: 'linux-proc-systemd',
    host: 'test-host',
    uid: 1000,
    platform: 'linux',
    workspacePath: '/test',
    observedAt,
    clockOffset: { min: 0, max: 10 },
    processes: [],
    scopes: [
      {
        unit: 'graphyard-watch-1000-test.scope',
        activeState: 'active',
        processes: [], // Target scope's unattributed processes: empty
        processesCount: undefined,
        attributed: hugePids.slice(0, 200), // First 200 of the 350 attributed
        attributedCount: 350, // Total count indicates truncation
        truncated: true,
      },
      {
        unit: 'other-scope.scope',
        activeState: 'active',
        processes: [],
        attributed: [],
      },
    ],
    held: [],
    recordedScope: { unit: 'graphyard-watch-1000-test.scope', pid: 1000, activeState: 'active' },
    inaccessible: 0,
    unverifiable: [],
  };

  // Verify the schema accepts the truncated scope.
  const parsed = containmentVerificationSchema.parse(verification);
  assert.ok(parsed, 'truncated scope parses as valid verification');
  assert.equal(parsed.scopes[0].truncated, true, 'truncated scope is marked as truncated');
  assert.equal(parsed.scopes[0].attributedCount, 350, 'full attributed count is recorded');
  assert.equal(parsed.scopes[0].attributed.length, 200, 'attributed array is capped at 200');

  // A quarantine with the truncated scope should settle without refusal.
  // Use a time shortly after the observed time to keep the verification fresh.
  const now = Date.parse(observedAt) + 60_000; // 1 minute after observed
  const work = workItem('graphyard-watch-1000-test.scope', 1000);
  const refusals = containmentSettlementRefusals(work, parsed, { now, freshnessMs: containmentProbeFreshnessMs });
  assert.deepEqual(refusals, [], 'truncated scope does not block settlement of its own quarantine');

  // Another item's quarantine in the same verification also settles.
  // Give it its own scope that is NOT the recorded scope (so it doesn't need to match recordedScope).
  const otherWork = workItem('other-scope.scope', 2000, { id: 'other-work', key: 'GY-other' });
  // Update verification to include the other scope as recorded scope for this test.
  const verificationForOther: ContainmentVerification = {
    ...parsed,
    recordedScope: { unit: 'other-scope.scope', pid: 2000, activeState: 'active' },
  };
  const otherRefusals = containmentSettlementRefusals(otherWork, verificationForOther, { now, freshnessMs: containmentProbeFreshnessMs });
  assert.deepEqual(otherRefusals, [], 'other scope quarantine also settles');

  // Verify without truncation marker: two limits kept it small, not a true test of large sizes.
  const smallScope: ContainmentVerification = {
    ...parsed,
    scopes: [{
      ...parsed.scopes[0],
      attributed: hugePids.slice(0, 200),
      attributedCount: undefined, // No truncation marker
      truncated: false,
    }],
  };
  const smallRefusals = containmentSettlementRefusals(work, smallScope, { now, freshnessMs: containmentProbeFreshnessMs });
  assert.deepEqual(smallRefusals, [], 'non-truncated scope also settles');
});
