import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Evidence, Observation, Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { atomicPrivateWrite, masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { exhaustedProofKey, type ExhaustedProof } from '../src/daemon/decisions.js';
import { sessionRetryLimit } from '../src/producer.js';
import { dispatchFailureAttention, emptyDispatchCursor, extractProducerAccountsOrRuntimes, isUnactedProducerAttempt, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';

// GY-1153: Producer attempts that never started (runtime quota, trust prompt, busy profiles)
// send a correct candidate back to a worker as a rework.
// AC-1: unit:never-started-producers-request-no-rework
// AC-2: unit:acted-producer-failure-still-reworks

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), B = sha40('b1');
const at = '2026-10-03T11:27:00.000Z';
const clock = Date.parse(at);
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();

function observation(candidate: { sha: string; baseSha: string }, extra: Partial<Observation> = {}): Observation {
  return { candidate: { ...candidate, pr: 1127, branch: 'graphyard/gy-1127-1', author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: sha40('7b'), baseTipContained: true, ...extra };
}

function work(overrides: Partial<Work> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 1127, branch: 'graphyard/gy-1127-1', author: 'implementer' };
  return { id: 'work-1127', key: 'GY-1127', title: 'Producer runtime exhaustion', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Producer runtime notice', proofs: ['unit:never-started-producers-request-no-rework'] }],
    policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1,
    lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 1127 }, reworkRequested: false, scenarioRequirements: [], evidence: [] as Evidence[],
    observation: observation(candidate), blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [], ...overrides } as Work;
}

const requested = (proof: string) => {
  const item = work({ criteria: [{ id: 'AC-1', text: 'Criteria', proofs: [proof] }] });
  reconcileAutoDispatch(item, [item], new Date(clock));
  return item;
};

function masterConfig(credentialFile: string, producers: MasterConfig['producers'] = []): MasterConfig {
  return masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, workers: [],
    producers: producers.length ? producers : [{ name: 'agy', principal: 'proof-runner', agentName: 'produce-agy', kind: 'agy', credentialFile: join(credentialFile, '..', 'agy.token') }],
  });
}

function dispatchEffects(items: () => Work[], log: string[], producers: any[]): DispatchEffects {
  return {
    snapshot: async () => ({ work: items(), now: new Date(clock).toISOString() }),
    agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    reconcileReviews: async () => ({ reviews: [] }),
    reconcileProducers: async () => ({ producers }),
    launchReview: async () => {},
    launchProducer: async (item, request, profile) => { log.push(`producer:${item.key}:${request.group}:${profile.name}`); producers.push({ requestId: request.id, state: 'pending', requestedAt: iso(0), profile: profile.name, agentName: profile.agentName }); },
    persist: async () => {},
  };
}

function decisionLoop(items: () => Work[], decided: { action: string; reason: string }[], approvers: string[], exhausted: () => ExhaustedProof[]): DaemonEffects {
  return {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: items(), now: iso(1_000), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(1_000), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    exhaustedProofs: async () => exhausted(),
    decide: async (_work: Work, action: string, reason: string) => { decided.push({ action, reason }); return { id: '5d8a8b9e-0000-4000-8000-000000001153' }; },
    decisions: async () => ({ decisions: decided.map(entry => ({ id: '5d8a8b9e-0000-4000-8000-000000001153', action: entry.action, state: 'requested', input: {}, approvedBy: null })) }),
    approver: async (_work: Work, decision: string) => { approvers.push(decision); return { agentName: 'graphyard-approver-gy-1153', pane: 'pane-approver' }; },
    persist: async () => {},
  } as unknown as DaemonEffects;
}

test('unit:never-started-producers-request-no-rework — replays GY-1127\'s three never-started attempts and asserts no rework is requested and the request is relaunched on a healthy account', async () => {
  const root = await temporaryDirectory('exhausted-proof-runtime-unstarted');
  try {
    const token = join(root, 'coordinator.token');
    await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const agyToken = join(root, 'agy.token');
    await writeFile(agyToken, 'agy-token-'.padEnd(40, 'x'), { mode: 0o600 });

    const config = masterConfig(token);
    const item = requested('unit:never-started-producers-request-no-rework');
    const unit = item.autoDispatch!.producers.find(request => request.group === 'unit')!;
    assert.ok(unit, 'unit proof group is requested');

    // Replay GY-1127's three never-started producer attempts
    const failed = [1, 2, 3].map(attempt => ({
      requestId: unit.id,
      state: 'failed',
      attempt,
      profile: 'agy',
      requestedAt: iso(-7_200_000 + attempt * 60_000),
      closedAt: iso(-3_600_000 + attempt * 60_000),
      resolution: 'never started: the session took up neither its request nor the re-prompt',
    }));

    const log: string[] = [], cursor = emptyDispatchCursor(config);
    await runDispatchTick(config, cursor, dispatchEffects(() => [item], log, failed), () => clock);
    assert.ok(!log.some(entry => entry.includes(':unit:')), 'no fourth run launched on exhausted agy');

    const abandoned = cursor.abandoned[unit.id];
    assert.ok(abandoned, 'unit request is abandoned in cursor');
    assert.equal(abandoned?.group, 'unit');

    // Attention item names the attempts, the runtime/account, and raises producer-runtime attention
    const [attention] = dispatchFailureAttention({ abandoned: [{ requestId: unit.id, ...abandoned }] });
    assert.ok(attention, 'attention item is raised');
    assert.match(attention.text, /never started/);
    assert.match(attention.text, /agy/);
    assert.match(attention.text + ' ' + attention.next, /producer-runtime/);
    assert.match(attention.next, /relaunches the request once an eligible producer account exists/);

    // Replay in decision loop: assert no rework is requested
    const entry: ExhaustedProof = {
      requestId: unit.id,
      work: abandoned.work,
      sha: abandoned.sha,
      group: abandoned.group ?? null,
      proofs: abandoned.proofs ?? [],
      attempts: abandoned.attempts,
      reason: abandoned.reason,
    };
    const submitted = work({
      key: 'GY-1127',
      candidate: { sha: H, baseSha: B, pr: 1127, branch: 'graphyard/gy-1127-1', author: 'implementer' },
      observation: observation({ sha: H, baseSha: B }, { at: iso(0) }),
    });
    const decided: { action: string; reason: string }[] = [], approvers: string[] = [];
    const loopConfig = masterConfigSchema.parse({ ...config, autoMerge: true, workers: [] });
    const state = emptyDaemonState(loopConfig);
    const effects = decisionLoop(() => [submitted], decided, approvers, () => [entry]);

    await runCycle(loopConfig, state, effects, () => clock + 1_000);
    await runCycle(loopConfig, state, effects, () => clock + 2_000);
    assert.equal(decided.length, 0, 'no rework is requested when every producer attempt never started');

    // Relaunch the request once an eligible producer account exists
    const healthyToken = join(root, 'claude-healthy.token');
    await writeFile(healthyToken, 'token-claude-'.padEnd(40, 'x'), { mode: 0o600 });
    const configWithHealthy = masterConfigSchema.parse({
      ...config,
      producers: [
        ...config.producers,
        { name: 'claude-healthy', principal: 'proof-runner', agentName: 'produce-claude', kind: 'claude', credentialFile: healthyToken },
      ],
    });

    const relaunchLog: string[] = [];
    await runDispatchTick(configWithHealthy, cursor, dispatchEffects(() => [item], relaunchLog, failed), () => clock + 3_000);
    assert.deepEqual(relaunchLog.filter(entry => entry.includes(':unit:')), ['producer:GY-1127:unit:claude-healthy'], 'request is relaunched on a healthy account');
    assert.equal(cursor.abandoned[unit.id], undefined, 'cursor abandoned entry cleared on relaunch');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unit:acted-producer-failure-still-reworks — a head whose producer attempts include at least one session that acted and failed to produce evidence still gets the GY-496 rework', async () => {
  const root = await temporaryDirectory('exhausted-proof-runtime-acted');
  try {
    const token = join(root, 'coordinator.token');
    await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const agyToken = join(root, 'agy.token');
    await writeFile(agyToken, 'agy-token-'.padEnd(40, 'x'), { mode: 0o600 });

    const config = masterConfig(token);
    const item = requested('unit:acted-producer-failure-still-reworks');
    const unit = item.autoDispatch!.producers.find(request => request.group === 'unit')!;
    assert.ok(unit, 'unit proof group is requested');

    // Attempts include at least one session that acted and failed to produce evidence
    const failedWithActed = [
      {
        requestId: unit.id,
        state: 'failed',
        attempt: 1,
        profile: 'agy',
        requestedAt: iso(-7_200_000),
        closedAt: iso(-3_600_000),
        resolution: 'never started: the session took up neither its request nor the re-prompt',
      },
      {
        requestId: unit.id,
        state: 'failed',
        attempt: 2,
        profile: 'agy',
        requestedAt: iso(-7_100_000),
        closedAt: iso(-3_500_000),
        resolution: 'never started: the session took up neither its request nor the re-prompt',
      },
      {
        requestId: unit.id,
        state: 'failed',
        attempt: 3,
        profile: 'agy',
        requestedAt: iso(-7_000_000),
        closedAt: iso(-3_400_000),
        resolution: 'the headless run ended (no-payload: run 3 found no test named unit:tmp-reclaim) without trusted evidence for unit:tmp-reclaim (missing)',
      },
      {
        requestId: unit.id,
        state: 'failed',
        attempt: 4,
        profile: 'agy',
        requestedAt: iso(-6_900_000),
        closedAt: iso(-3_300_000),
        resolution: 'never started: the session took up neither its request nor the re-prompt',
      },
    ];

    const log: string[] = [], cursor = emptyDispatchCursor(config);
    await runDispatchTick(config, cursor, dispatchEffects(() => [item], log, failedWithActed), () => clock);

    const abandoned = cursor.abandoned[unit.id];
    assert.ok(abandoned, 'request is abandoned in cursor');

    const [attention] = dispatchFailureAttention({ abandoned: [{ requestId: unit.id, ...abandoned }] });
    assert.match(attention.next, /requests a rework decision for GY-1127 on its next cycle/);

    const entry: ExhaustedProof = {
      requestId: unit.id,
      work: abandoned.work,
      sha: abandoned.sha,
      group: abandoned.group ?? null,
      proofs: abandoned.proofs ?? [],
      attempts: abandoned.attempts,
      reason: abandoned.reason,
    };
    const submitted = work({
      key: 'GY-1127',
      candidate: { sha: H, baseSha: B, pr: 1127, branch: 'graphyard/gy-1127-1', author: 'implementer' },
      observation: observation({ sha: H, baseSha: B }, { at: iso(0) }),
    });
    const decided: { action: string; reason: string }[] = [], approvers: string[] = [];
    const loopConfig = masterConfigSchema.parse({ ...config, autoMerge: true, workers: [] });
    const state = emptyDaemonState(loopConfig);
    const effects = decisionLoop(() => [submitted], decided, approvers, () => [entry]);

    await runCycle(loopConfig, state, effects, () => clock + 1_000);
    assert.equal(decided.length, 0, 'the rework waits one cycle after the escalation');

    await runCycle(loopConfig, state, effects, () => clock + 2_000);
    assert.equal(decided.length, 1, 'rework decision is requested when an attempt acted and failed');
    assert.equal(decided[0].action, 'rework');
    assert.match(decided[0].reason, /ended without trusted evidence/);
    assert.equal(approvers.length, 1, 'independent approver launched');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GY-1153 review follow-ups — a sole profile keeps its unstarted retries, mid-run limits still count as acted, and the attention names only profiles', async () => {
  const root = await temporaryDirectory('exhausted-proof-runtime-followups');
  try {
    const token = join(root, 'coordinator.token');
    await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    await writeFile(join(root, 'agy.token'), 'agy-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const config = masterConfig(token);
    const item = requested('unit:never-started-producers-request-no-rework');
    const unit = item.autoDispatch!.producers.find(request => request.group === 'unit')!;

    // One never-started attempt on the only producer profile: the request is not spent, so the next
    // attempt launches on that same profile rather than waiting on it as busy.
    const once = [{ requestId: unit.id, state: 'failed', attempt: 1, profile: 'agy', requestedAt: iso(-3_600_000), closedAt: iso(-3_000_000),
      resolution: 'never started: the session took up neither its request nor the re-prompt' }];
    const log: string[] = [], cursor = emptyDispatchCursor(config);
    await runDispatchTick(config, cursor, dispatchEffects(() => [item], log, once), () => clock);
    assert.deepEqual(log.filter(entry => entry.includes(':unit:')), ['producer:GY-1127:unit:agy'], 'the sole profile retries an unstarted attempt');
    assert.equal(cursor.abandoned[unit.id], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  // A session that acted and quoted a quota or rate limit in its last words acted.
  assert.equal(isUnactedProducerAttempt('the headless run ended (exit: rate limit reached, quota exceeded) without trusted evidence for unit:a (missing)'), false);
  assert.equal(isUnactedProducerAttempt('attempt 2 on agy: failed — the headless run ended (exit: provider limit notice) without trusted evidence for unit:a (missing)'), false);
  assert.equal(isUnactedProducerAttempt('attempt 1 on agy: failed — never started: the session left Herdr without acting on its request'), true);
  assert.equal(isUnactedProducerAttempt('the headless run could not start: spawn agy ENOENT'), true);
  // The attention names the profiles the attempts ran on, never words lifted from a resolution.
  assert.deepEqual(extractProducerAccountsOrRuntimes([
    'attempt 1 on agy: failed — never started: profile is busy in the claude runtime',
    'attempt 2 on claude-b: failed — never started: account exhausted',
    'attempt 3 on agy: failed — never started',
  ]), ['agy', 'claude-b']);
});
