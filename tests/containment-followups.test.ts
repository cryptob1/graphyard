import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { cycleFaults, emptyDaemonState } from '../src/master-daemon.js';
import { workFaults } from '../src/model/fault-classes.js';
import { containmentGraceMs as modelGraceMs, containmentPhase } from '../src/model/containment.js';
import { containmentGraceMs as settlementGraceMs } from '../src/quarantine.js';

// GY-1179: follow-ups from the approved review of GY-1151 (PR #636), proof manual:review-followups-triaged.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const config = (): MasterConfig => masterConfigSchema.parse({
  version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
  autoMerge: true, mergeMethod: 'merge', workers: [],
});
const clock = Date.parse('2026-10-03T12:00:00.000Z');
const iso = (offset: number) => new Date(clock + offset).toISOString();

function fenced(lease: Work['lease']): Work {
  return {
    id: 'work-GY-9', key: 'GY-9', title: 'GY-9', description: '', type: 'feature', priority: 2, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'The behaviour changes as described', proofs: ['unit:behaviour-changes'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'implementation', revision: 1, policyRevision: 1,
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

const containment = (work: Work) => ({
  own: workFaults(work, clock).filter(fault => fault.faultClass === 'containment').length,
  cycle: cycleFaults(emptyDaemonState(config()), [work], clock, { config: config() }).filter(fault => fault.kind === 'containment').length,
});

// Review finding 1 (GY-1214): the model module owns the window and quarantine.ts re-exports it, so both name one value.
test('manual:review-followups-triaged — fault counting and settlement share one containment grace window', () => {
  assert.equal(modelGraceMs, settlementGraceMs);
  assert.equal(containmentPhase(fenced(null), clock)?.state, 'lapsed');
});

// Review finding 2: since GY-1151 an old-epoch quarantine past grace, while another owner and epoch hold a
// live lease, is a fault of the item's own record where base read any live lease as no fault. Declined as
// a code change: base already counted the same single containment instance through master status's
// "blocks dispatch" line (containmentPhase reads 'lapsed', and the fence does hold the item), so the loop's
// count is unchanged; the item's own record now agrees with the line it restates.
test('manual:review-followups-triaged — an old-epoch quarantine under a live lease of another owner and epoch is one containment fault, as on base', () => {
  const work = fenced({ owner: 'worker-new', epoch: 5, expiresAt: iso(600_000) } as Work['lease']);
  assert.equal(containmentPhase(work, clock)?.state, 'lapsed');
  assert.deepEqual(containment(work), { own: 1, cycle: 1 });
});

test('manual:review-followups-triaged — the same quarantine without a live lease is one containment fault', () => {
  assert.deepEqual(containment(fenced(null)), { own: 1, cycle: 1 });
  assert.deepEqual(containment(fenced({ owner: 'worker-new', epoch: 5, expiresAt: iso(-600_000) } as Work['lease'])), { own: 1, cycle: 1 });
});
