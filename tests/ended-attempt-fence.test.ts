import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDaemonState } from '../src/master-daemon.js';
import { supervise } from '../src/supervisor.js';
import {
  containmentSettlementRefusals,
  containmentVerificationSchema,
  isTransientSettlementRefusal,
  type ContainmentVerification,
} from '../src/quarantine.js';
import { endWorkerAttempt, settleEndedAttemptFence } from '../src/daemon/cycle-resume.js';
import { reclaimStep } from '../src/daemon/cycle-reclaim.js';
import { closeExitedWorkerSessions } from '../src/daemon/cycle-sessions.js';
import type { Work } from '../src/model.js';
import type { WorkerProfile } from '../src/master.js';
import type { Cycle } from '../src/daemon/cycle.js';

const now = Date.parse('2030-01-01T12:00:00.000Z');
const host = 'coordinator-host';
const path = '/srv/graphyard/worktrees/GY-1155-1';

function verification(overrides: Partial<ContainmentVerification> = {}): ContainmentVerification {
  return containmentVerificationSchema.parse({
    method: 'linux-proc-systemd',
    host,
    uid: 1000,
    platform: 'linux',
    workspacePath: path,
    observedAt: new Date(now - 1_000).toISOString(),
    clockOffset: { min: -10, max: 10 },
    recordedScope: { unit: 'graphyard-watch-100.scope', pid: 100, activeState: 'inactive' },
    processes: [],
    scopes: [{ unit: 'graphyard-watch-100.scope', activeState: 'inactive', processes: [] }],
    inaccessible: 0,
    unverifiable: [],
    ...overrides,
  });
}

function quarantinedWork(overrides: Partial<Work> = {}): Work {
  const epoch = overrides.epoch ?? 1;
  return {
    id: 'work-1155',
    key: 'GY-1155',
    title: 'Ending attempt settles fence',
    description: '',
    type: 'bug',
    priority: 1,
    dependencies: [],
    criteria: [],
    policy: { checks: ['test'], review: true },
    plannedFiles: [],
    stage: 'build',
    revision: 1,
    policyRevision: 1,
    createdAt: new Date(now - 3_600_000).toISOString(),
    updatedAt: new Date(now).toISOString(),
    stageEnteredAt: new Date(now - 3_600_000).toISOString(),
    ready: true,
    epoch,
    lease: { owner: 'worker-a', epoch, expiresAt: new Date(now + 60_000).toISOString() },
    lastAssignment: { owner: 'worker-a', epoch, claimedAt: new Date(now - 3_600_000).toISOString() },
    workspaces: [{ host, path, epoch, owner: 'worker-a', branch: `graphyard/gy-1155-${epoch}` }],
    candidate: null,
    submission: null,
    reworkRequested: false,
    scenarioRequirements: [],
    evidence: [],
    observation: null,
    blocker: null,
    gates: [],
    violations: [],
    containmentQuarantine: {
      owner: 'worker-a',
      epoch,
      at: new Date(now - 10_000).toISOString(),
      settlementHash: 'a'.repeat(64),
      launchAcknowledgedAt: new Date(now - 10_000).toISOString(),
      launchExpiresAt: new Date(now + 30_000).toISOString(),
      leaseExpiresAt: new Date(now + 60_000).toISOString(),
      scope: { pid: 100, unit: 'graphyard-watch-100.scope' },
    },
    ...overrides,
  } as Work;
}

const profile: WorkerProfile = {
  name: 'worker-a',
  principal: 'worker-a',
  agentName: 'agent-a',
  mode: 'launch',
  kind: 'claude',
  credentialFile: '/tmp/cred',
  agentArgs: [],
  environment: {},
} as unknown as WorkerProfile;

function createCycle(item: Work, overrides: Partial<Cycle> = {}): { cycle: Cycle; settled: boolean; closedPanes: string[] } {
  const config: any = {
    version: 1,
    url: 'https://graphyard.example',
    credentialFile: '/tmp/cred',
    cliPath: '/bin/graphyard',
    repository: 'owner/project',
    baseBranch: 'main',
    githubAppId: 1,
    hostId: host,
    masterAgentName: 'master',
    autoMerge: true,
    mergeMethod: 'merge',
    workers: [profile],
    run: {
      diskThresholdGb: 10,
      worktreeRootMinFreeGb: 2,
    },
  };
  const state = emptyDaemonState(config);
  let settled = false;
  const closedPanes: string[] = [];
  const effects: any = {
    controlPlaneClock: async () => ({ now: new Date(now).toISOString(), clockOffset: { min: 0, max: 0 }, roundTripMs: 5, source: 'timed' }),
    containment: async () => ({
      [item.id]: {
        settleable: true,
        host,
        scope: item.containmentQuarantine?.scope,
        verification: verification(),
        refusals: [],
      },
    }),
    settleContainment: async (settlingItem: Work) => {
      settled = true;
      settlingItem.containmentQuarantine = null;
    },
    stopSupervisor: async () => {},
    closeSession: async (pane: string) => { closedPanes.push(pane); },
    recordSession: async () => {},
    recordAssignmentBlocker: async () => {},
    persist: async () => {},
    preserveInterruptedAttempt: async () => {},
  };

  const cycle: Cycle = {
    config,
    state,
    effects,
    snapshot: { work: [item], now: new Date(now).toISOString() },
    open: [item],
    agents: [],
    clock: now,
    now: () => now,
    clockOffset: { min: 0, max: 0 },
    performed: [],
    isolate: async (_kind, _item, _key, fn) => fn(),
    launch: () => {},
    ...overrides,
  } as Cycle;

  return { cycle, settled, closedPanes };
}

test('unit:ended-attempt-fence-settled-at-once — ending an attempt settles its quarantine immediately without waiting on grace window', async () => {
  const item = quarantinedWork();
  const { cycle, closedPanes } = createCycle(item);

  // Before ending: quarantine and lease exist
  assert(item.containmentQuarantine !== null);
  assert(item.lease !== null);

  // End the worker attempt (idle with lease)
  const result = await endWorkerAttempt(cycle, item, profile, 1, 'pane-1', 'idle with lease', 'observed idle');
  assert(result.includes('the attempt ended on the record'));
  assert.equal(closedPanes[0], 'pane-1');

  // Quarantine is settled in the same action
  assert.equal(item.containmentQuarantine, null);
  assert.equal(item.lease, null);
  assert.equal(cycle.state.actions[`settle:${item.id}:1`]?.state, 'done');
});

test('unit:ended-attempt-grace-waived-on-loop-record — 120s grace window is waived in containmentSettlementRefusals when loop ended the attempt and supervisor is verified gone', () => {
  // Case A: Loop ended attempt recorded in capacity exhaustions (not lease lapsed)
  const workPreserved = quarantinedWork({
    capacity: {
      exhaustions: [
        { role: 'worker', epoch: 1, reason: 'ended without submitting: idle with lease' } as any,
      ],
      escalations: [],
    },
  });
  assert.deepEqual(containmentSettlementRefusals(workPreserved, verification(), { now }), []);

  // Case B: Loop closed the session as failed
  const workClosedFailed = quarantinedWork({
    sessions: [
      { id: 'worker-a:1', epoch: 1, kind: 'implementation', state: 'finished', outcome: 'closed as failed: credential blocked' } as any,
    ],
  });
  assert.deepEqual(containmentSettlementRefusals(workClosedFailed, verification(), { now }), []);

  // Case C: Loop closed the session (closed by the loop)
  const workClosedLoop = quarantinedWork({
    sessions: [
      { id: 'worker-a:1', epoch: 1, kind: 'implementation', state: 'finished', outcome: 'closed by the loop: pane exited' } as any,
    ],
  });
  assert.deepEqual(containmentSettlementRefusals(workClosedLoop, verification(), { now }), []);

  // Case D: Submitted attempt moved to review
  const workSubmitted = quarantinedWork({
    stage: 'review',
    sessions: [
      { id: 'worker-a:1', epoch: 1, kind: 'implementation', state: 'finished', outcome: 'submitted' } as any,
    ],
  });
  assert.deepEqual(containmentSettlementRefusals(workSubmitted, verification(), { now }), []);
});

test('unit:ended-attempt-grace-still-refuses-unverified — grace window still refuses if supervisor is unverified or lease expired without loop ending it', () => {
  // 1. Natural lease lapse without loop record still enforces grace window
  const workLapsed = quarantinedWork({
    lease: { owner: 'worker-a', epoch: 1, expiresAt: new Date(now - 30_000).toISOString() },
    containmentQuarantine: {
      ...quarantinedWork().containmentQuarantine!,
      leaseExpiresAt: new Date(now - 30_000).toISOString(),
      launchExpiresAt: new Date(now - 30_000).toISOString(),
    },
    capacity: {
      exhaustions: [
        { role: 'worker', epoch: 1, reason: 'lease lapsed' } as any,
      ],
      escalations: [],
    },
  });
  const refusalsLapsed = containmentSettlementRefusals(workLapsed, verification(), { now });
  assert(
    refusalsLapsed.some(r => r.includes('has not been expired for the required 120s grace window')),
    'grace window refusal must be present when attempt was not ended by loop'
  );

  // Base loop-ended work for remaining checks
  const workEnded = quarantinedWork({
    capacity: {
      exhaustions: [
        { role: 'worker', epoch: 1, reason: 'ended without submitting: idle' } as any,
      ],
      escalations: [],
    },
  });

  // 2. Loop ended attempt, but host verification is unverifiable
  const unverifiableHost = verification({ unverifiable: ['/proc inaccessible'] });
  const refusalsUnverifiable = containmentSettlementRefusals(workEnded, unverifiableHost, { now });
  assert(refusalsUnverifiable.some(r => r.includes('grace window')));
  assert(refusalsUnverifiable.some(r => r.includes('Host verification was incomplete: /proc inaccessible')));

  // 3. Loop ended attempt, but a process is still running on the host
  const runningProcessHost = verification({
    processes: [{ pid: 999, evidence: 'workspace' }],
  });
  const refusalsProcess = containmentSettlementRefusals(workEnded, runningProcessHost, { now });
  assert(refusalsProcess.some(r => r.includes('grace window')));
  assert(refusalsProcess.some(r => r.includes('Process 999 of the contained worker is still present')));

  // 4. Loop ended attempt, but recorded scope is still active
  const activeScopeHost = verification({
    recordedScope: { unit: 'graphyard-watch-100.scope', pid: 100, activeState: 'active' },
  });
  const refusalsActiveScope = containmentSettlementRefusals(workEnded, activeScopeHost, { now });
  assert(refusalsActiveScope.some(r => r.includes('grace window')));

  // 5. Mismatching host
  const wrongHost = verification({ host: 'other-machine' });
  const refusalsWrongHost = containmentSettlementRefusals(workEnded, wrongHost, { now });
  assert(refusalsWrongHost.some(r => r.includes('grace window')));
  assert(refusalsWrongHost.some(r => r.includes('Verification ran on host other-machine')));
});

test('unit:supervisor-settle-failure-recorded-and-settled — supervisor records shutdown failure against quarantine and closure path settles standing fence', async () => {
  // Part 1: Supervisor records shutdown verification failure on quarantine
  const unemptiedContainment = {
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    signal: () => {},
    empty: () => false,
  };
  const quarantineWithFailure: any = {
    establish: async () => {},
    settle: async () => {},
  };
  await assert.rejects(
    supervise('ignored', [], 1, async () => ({ lease: { epoch: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() }, updatedAt: new Date().toISOString() }), {
      containment: unemptiedContainment,
      detached: false,
      graceMs: 5,
      shutdownPollMs: 1,
      shutdownTimeoutMs: 10,
      quarantine: quarantineWithFailure,
    }),
    /Worker containment shutdown could not be verified/
  );
  assert(quarantineWithFailure.failure, 'failure was recorded on quarantine');
  assert.equal(quarantineWithFailure.failure.boundMs, 10);
  assert(quarantineWithFailure.failure.held.includes('scope not empty'));

  // Part 2: Supervisor records settle POST refusal on quarantine
  const emptyContainment = {
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    signal: () => {},
    empty: () => true,
  };
  const quarantineRefused: any = {
    establish: async () => {},
    settle: async () => {
      throw new Error('403 Forbidden: settle POST refused');
    },
  };
  await assert.rejects(
    supervise('ignored', [], 1, async () => ({ lease: { epoch: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() }, updatedAt: new Date().toISOString() }), {
      containment: emptyContainment,
      detached: false,
      graceMs: 5,
      shutdownPollMs: 1,
      shutdownTimeoutMs: 10,
      quarantine: quarantineRefused,
    }),
    /quarantine could not be settled: 403 Forbidden/
  );
  assert(quarantineRefused.failure, 'settlement failure was recorded on quarantine');
  assert.equal(quarantineRefused.failure.refusal, '403 Forbidden: settle POST refused');

  // Part 3: Loop closure path settles standing fence on cycle observing submitted attempt
  const submittedWork = quarantinedWork({
    id: 'work-submitted-epoch-16',
    key: 'GY-1027',
    stage: 'review',
    epoch: 16,
    lease: null,
    containmentQuarantine: {
      owner: 'worker-a',
      epoch: 16,
      at: new Date(now - 10_000).toISOString(),
      settlementHash: 'b'.repeat(64),
      launchAcknowledgedAt: new Date(now - 10_000).toISOString(),
      launchExpiresAt: new Date(now + 30_000).toISOString(),
      leaseExpiresAt: new Date(now + 60_000).toISOString(),
      scope: { pid: 500, unit: 'graphyard-watch-500.scope' },
      failure: quarantineRefused.failure,
    } as any,
    sessions: [
      {
        id: 'worker-a:16',
        epoch: 16,
        kind: 'implementation',
        principal: 'worker-a',
        host,
        state: 'finished',
        outcome: 'closed by the loop: submitted',
      } as any,
    ],
  });

  const { cycle } = createCycle(submittedWork);
  await closeExitedWorkerSessions(cycle, { agents: [], available: true });

  assert.equal(submittedWork.containmentQuarantine, null, 'standing quarantine settled on observation cycle');
  assert.equal(cycle.state.actions[`settle:${submittedWork.id}:16`]?.state, 'done');
});

test('unit:transient-settlement-refusal-retries-next-cycle — 5xx or stale verification refusal is retried on the next cycle without readyToRetry backoff', async () => {
  // Test detection of transient refusal causes
  assert.equal(isTransientSettlementRefusal(new Error('502 Bad Gateway: Application failed to respond')), true);
  assert.equal(isTransientSettlementRefusal({ status: 503 }), true);
  assert.equal(isTransientSettlementRefusal(new Error('Host verification is older than 120s; verify the host again')), true);
  assert.equal(isTransientSettlementRefusal(new Error('Process 999 of the contained worker is still present')), false);

  // Setup work with standing quarantine for ended attempt
  const item = quarantinedWork({
    capacity: {
      exhaustions: [
        { role: 'worker', epoch: 1, reason: 'ended without submitting: idle' } as any,
      ],
      escalations: [],
    },
  });

  // Cycle 1 recorded a transient failure with attempts: 4 (would normally require 2^(4-1) = 8 cycles backoff)
  const { cycle } = createCycle(item);
  cycle.state.cycle = 2; // Next cycle
  cycle.state.actions[`settle:${item.id}:1`] = {
    kind: 'settle',
    work: item.key,
    principal: null,
    epoch: 1,
    state: 'failed',
    detail: 'Containment settlement refused for GY-1155 epoch 1: 502 Bad Gateway: Application failed to respond',
    attempts: 4,
    cycle: 1,
    at: new Date(now - 10_000).toISOString(),
  };

  // Reclaim step runs on cycle 2
  await reclaimStep(cycle);

  // Settlement bypassed backoff and succeeded on the next cycle
  assert.equal(item.containmentQuarantine, null);
  assert.equal(cycle.state.actions[`settle:${item.id}:1`]?.state, 'done');

  // Contrast: Non-transient refusal on cycle 2 obeys readyToRetry backoff
  const nonTransientItem = quarantinedWork({
    id: 'work-non-transient',
    capacity: {
      exhaustions: [
        { role: 'worker', epoch: 1, reason: 'ended without submitting: idle' } as any,
      ],
      escalations: [],
    },
  });
  const { cycle: nonTransientCycle } = createCycle(nonTransientItem);
  nonTransientCycle.state.cycle = 2;
  nonTransientCycle.state.actions[`settle:${nonTransientItem.id}:1`] = {
    kind: 'settle',
    work: nonTransientItem.key,
    principal: null,
    epoch: 1,
    state: 'failed',
    detail: 'Containment settlement refused for GY-1155 epoch 1: Process 999 is still present',
    attempts: 4,
    cycle: 1,
    at: new Date(now - 10_000).toISOString(),
  };

  await reclaimStep(nonTransientCycle);
  // Still failed, did not retry on cycle 2
  assert.notEqual(nonTransientItem.containmentQuarantine, null);
  assert.equal(nonTransientCycle.state.actions[`settle:${nonTransientItem.id}:1`]?.state, 'failed');
});
