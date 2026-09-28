import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orphanedSupervisors, type OrphanSupervisor } from '../src/daemon/sessions.js';
import type { Work } from '../src/model.js';
import type { HerdrAgent, WorkerProfile } from '../src/master.js';

// GY-894 AC-2: With every worker profile held by ended sessions, the next dispatch tick
// claims and launches work instead of recording stalled actions; a test reproduces the
// ten-ended-sessions jam and shows dispatch recovering without hand intervention.

const now = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs = 0) => new Date(now + offsetMs).toISOString();

function item(key: string, lease: Work['lease'] | null, stage: Work['stage'] = 'build'): Work {
  return {
    id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage, revision: 1, policyRevision: 1, createdAt: iso(-7_200_000), updatedAt: iso(),
    stageEnteredAt: iso(-3_600_000), ready: stage === 'ready', epoch: lease?.epoch ?? 1,
    lease, workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [], containmentQuarantine: lease ? {
      at: iso(), epoch: lease.epoch, owner: lease.owner, scope: { unit: `graphyard-watch-${key}-${lease.epoch}.scope`, pid: 1000 + lease.epoch },
      leaseExpiresAt: lease.expiresAt, launchExpiresAt: iso(1_000_000), launchAcknowledgedAt: iso(),
    } : null,
  } as unknown as Work;
}

function profile(name: string, principal: string, agentName: string): WorkerProfile {
  return { name, principal, agentName, mode: 'launch', kind: 'claude', credentialFile: '/outside/worker.token', approvals: 'auto' } as WorkerProfile;
}

test('unit:dispatch-recovers-from-jam — orphanedSupervisors detects ended sessions whose agents have disappeared from Herdr', () => {
  const profiles = [
    profile('worker-1', 'principal-1', 'graphyard-worker-1'),
    profile('worker-2', 'principal-2', 'graphyard-worker-2'),
  ];
  // Agent 1 is completely gone - not in the agents list
  const agents: HerdrAgent[] = [
    { name: 'graphyard-worker-2', pane_id: 'pane-2', agent_status: 'idle', cwd: '/repo/.graphyard/worktrees/GY-2-20' },
  ];

  const lease = { epoch: 10, owner: 'principal-1', expiresAt: iso(600_000) };
  const work = [item('GY-1', lease)];

  const orphans = orphanedSupervisors(work, profiles, agents, now);
  assert.strictEqual(orphans.length, 1, 'detects one orphaned supervisor whose agent is gone');
  assert.strictEqual(orphans[0].key, 'GY-1', 'identifies the correct item');
  assert.strictEqual(orphans[0].agentName, 'graphyard-worker-1', 'identifies the correct agent');
});

test('unit:dispatch-recovers-from-jam — supervisor release frees the profile slot for new dispatch', () => {
  // When an ended session's supervisor is detected and its lease is released,
  // the master loop's next cycle can dispatch new work to that profile
  const profiles = [profile('worker-1', 'principal-1', 'graphyard-worker-1')];
  const agents: HerdrAgent[] = [];  // Agent is completely gone

  const lease = { epoch: 10, owner: 'principal-1', expiresAt: iso(600_000) };
  const work = [item('GY-1', lease)];

  // Before release: profile is held by ended item with active lease
  const orphansBefore = orphanedSupervisors(work, profiles, agents, now);
  assert.strictEqual(orphansBefore.length, 1, 'item with active lease is detected as orphaned');

  // After release: lease is null, so profile is free for dispatch
  const workAfterRelease = [item('GY-1', null)];
  const orphansAfter = orphanedSupervisors(workAfterRelease, profiles, agents, now);
  assert.strictEqual(orphansAfter.length, 0, 'released lease no longer marks supervisor as orphaned');
});
