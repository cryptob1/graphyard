import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { containmentVerificationSchema, containmentSettlementRefusals } from '../src/quarantine.js';
import type { Work } from '../src/model.js';

describe('Containment verification with large process lists', () => {
  it('survives and settles a scope with 350 attributed processes', () => {
    // Build a verification with one scope containing 350 attributed processes
    const bigPids = Array.from({ length: 350 }, (_, i) => i + 1);

    const verification = {
      method: 'linux-proc-systemd' as const,
      host: 'testhost',
      uid: 1000,
      platform: 'linux',
      workspacePath: '/home/user/workspace',
      observedAt: new Date().toISOString(),
      clockOffset: { min: -100, max: 100 },
      processes: [],
      scopes: [
        {
          unit: 'graphyard-watch-1234-test.scope',
          activeState: 'active',
          processes: [],
          attributed: bigPids.slice(0, 200),
          attributedCount: 350,
          truncated: true,
        },
        {
          unit: 'graphyard-watch-5678-other.scope',
          activeState: 'active',
          processes: [401, 402],
          attributed: [],
          truncated: false,
        },
      ],
      held: [
        { pid: 401, command: '/bin/bash', cwd: '/home/user/workspace', unit: 'graphyard-watch-5678-other.scope' },
        { pid: 402, command: '/bin/sleep 10', cwd: '/home/user/workspace', unit: 'graphyard-watch-5678-other.scope' },
      ],
      recordedScope: { unit: 'graphyard-watch-1234-test.scope', pid: 1234, activeState: 'active' },
      inaccessible: 0,
      unverifiable: [],
    };

    // Verify it parses
    const parsed = containmentVerificationSchema.parse(verification);
    assert.ok(parsed, 'Verification should parse successfully');

    // Verify the big scope is recorded as truncated and live
    const bigScope = parsed.scopes[0];
    assert.strictEqual(bigScope.truncated, true, 'Big scope should be marked truncated');
    assert.strictEqual(bigScope.attributedCount, 350, 'Big scope should record total count');
    assert.strictEqual(bigScope.attributed.length, 200, 'Big scope should have list truncated to 200');
    assert.strictEqual(bigScope.activeState, 'active', 'Big scope should be active');

    // Create a work item with a containment quarantine for the big scope
    const work: Pick<Work, 'containmentQuarantine' | 'lease' | 'workspaces' | 'sessions'> = {
      containmentQuarantine: {
        owner: 'test-worker',
        epoch: 1,
        at: new Date().toISOString(),
        settlementHash: 'test-hash',
        launchAcknowledgedAt: new Date().toISOString(),
        launchExpiresAt: new Date(Date.now() - 200_000).toISOString(),
        leaseExpiresAt: new Date(Date.now() - 200_000).toISOString(),
        scope: { unit: 'graphyard-watch-1234-test.scope', pid: 1234 },
      },
      lease: null,
      workspaces: [{ epoch: 1, owner: 'test-worker', host: 'testhost', path: '/home/user/workspace', branch: 'test' }],
      sessions: [],
    };

    // Test settlement refusals
    const now = Date.now();
    const refusals = containmentSettlementRefusals(work, parsed, {
      now,
      graceMs: 100_000,
      freshnessMs: 200_000,
      clockToleranceMs: 5_000,
    });

    // The big truncated scope should NOT block settlement
    const blockedByBigScope = refusals.some(r => r.includes('graphyard-watch-1234-test.scope') && r.includes('still holds'));
    assert.strictEqual(blockedByBigScope, false, 'Big truncated scope should not block settlement');

    // But the other scope with processes should block
    const blockedByOtherScope = refusals.some(r => r.includes('graphyard-watch-5678-other.scope') && r.includes('still holds'));
    assert.strictEqual(blockedByOtherScope, true, 'Other scope with processes should block settlement');

    // Settlement should be blocked only because of the other scope's processes
    assert.ok(refusals.length > 0, 'Should have refusals due to other scope');
    assert.ok(refusals.every(r => !r.includes('graphyard-watch-1234-test.scope')), 'No refusals should mention the big truncated scope');
  });
});
