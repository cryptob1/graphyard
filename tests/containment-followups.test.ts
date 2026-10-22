import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import { containmentGraceMs as modelGraceMs, containmentPhase } from '../src/model/containment.js';
import { containmentGraceMs as settlementGraceMs } from '../src/quarantine.js';

// GY-1179: follow-ups from the approved review of GY-1151 (PR #636), proof manual:review-followups-triaged.

const clock = Date.parse('2026-10-03T12:00:00.000Z');
const iso = (offset: number) => new Date(clock + offset).toISOString();

function fenced(lease: Work['lease']): Work {
  return {
    id: 'work-GY-9', key: 'GY-9', title: 'GY-9', description: '', type: 'feature', priority: 2, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'The behaviour changes as described', proofs: ['unit:behaviour-changes'] }],
    policy: { checks: ['test'], review: true }, stage: 'implementation', revision: 1, policyRevision: 1,
    createdAt: iso(-3_600_000), updatedAt: iso(-60_000), stageEnteredAt: iso(-60_000), ready: true, epoch: 5, lease,
    workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: null, blocker: null, gates: [], violations: [],
    // The quarantine of epoch 4, lapsed well past the grace window.
    containmentQuarantine: {
      at: iso(-3_600_000), epoch: 4, owner: 'worker-old', leaseExpiresAt: iso(-3_000_000), launchExpiresAt: iso(-3_000_000),
      settlementHash: 'a'.repeat(64), scope: { pid: 12345, unit: 'graphyard-GY-9.scope' },
    },
  } as unknown as Work;
}

// Review finding 1 (GY-1214): the model module owns the window and quarantine.ts re-exports it, so both name one value.
test('manual:review-followups-triaged — settlement shares one containment grace window', () => {
  assert.equal(modelGraceMs, settlementGraceMs);
  assert.equal(containmentPhase(fenced(null), clock)?.state, 'lapsed');
});
