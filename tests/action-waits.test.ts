import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';
import { runExecutorTick, type ExecutorEffects } from '../src/auto-dispatch.js';
import { controlPlaneHandlers } from '../src/executor.js';
import { actionStall, actionStallRecheckMs, actionWaitRecheckMs, actionWaitError } from '../src/model/action-progress.js';
import { livenessCarry, livenessRetryLimit } from '../src/model/liveness.js';
import { resyncUnobservedPrefix } from '../src/model/action-kinds.js';
import { actionId, claimAction, settleAction, type ActionRow } from '../src/model/actions.js';
import { permissionRequestMark } from '../src/github-permissions.js';

/**
 * GY-948: a named wait is not a failing action. Five stalled-gate faults in 24 hours rode one
 * defect: refusals that name a wait outside the action's own reach — every worker profile at its
 * role's concurrency limit (GY-947, GY-73, GY-806), an observation job held on a permission only
 * the operator can grant (GY-864, GY-515) — settled as failures, drove the identical-reason
 * failure run through the stall threshold and into the escalation ladder, and nothing moved them.
 * Each test is named for the proof it produces: unit:dispatch-capacity-wait and
 * unit:resync-permission-wait reproduce the instances against the base doctrine and show they do
 * not recur against the candidate; the rest pin the edges of the same settlement.
 */

// Far past every real clock: the fixtures hold rows open across minutes of their own timeline,
// and a hold's `heldUntil` must read unexpired against the handler's real `Date.now()`.
const origin = Date.parse('2030-01-01T12:00:00.000Z');
const at = (offsetMs: number) => new Date(origin + offsetMs).toISOString();
const capacityReason = 'role worker is at its concurrency limit (8 of 8 live)';
const binding = 'dispatch:0:implementation';

function item(key: string, overrides: Partial<Work> = {}): Work {
  return {
    id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'bug', priority: 1,
    dependencies: [], criteria: [], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'build', revision: 1, policyRevision: 1,
    createdAt: at(-3_600_000), updatedAt: at(-600_000), stageEnteredAt: at(-600_000),
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null,
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [], containmentQuarantine: null, ...overrides,
  } as unknown as Work;
}

function row(work: Work, kind: ActionRow['kind'], rowBinding = binding): ActionRow {
  return {
    id: actionId(kind, work.id, rowBinding),
    kind, work: work.id, key: work.key,
    inputs: kind === 'dispatch' ? { kind: 'dispatch', target: 'implementation', epoch: 0, priority: 1, plannedFiles: [] } : { kind: 'resync', pr: 864, sha: null, baseSha: null, baseTip: null, observedAt: null },
    gate: 'build', refusal: kind === 'dispatch' ? null : 'Pull request has not been independently observed',
    reason: `${work.key} needs ${kind}`, binding: rowBinding,
    requestedBy: 'graphyard', requestedAt: at(-600_000), state: 'pending', claim: null, attempts: 0, history: [],
  };
}

/** The dispatch action the derivation names while the build gate refuses a dispatch. */
const dispatchAction = (work: Work) => ({
  kind: 'dispatch' as const, work: work.id, key: work.key, gate: 'build', refusal: null,
  reason: `${work.key} is ready and unassigned`, llmRole: null, binding,
  inputs: { kind: 'dispatch' as const, target: 'implementation' as const, epoch: 0, priority: 1, plannedFiles: [] as string[] },
});

/** The resync action the derivation names while the build gate refuses an observation. */
const resyncAction = (work: Work) => ({
  kind: 'resync' as const, work: work.id, key: work.key, gate: 'build', refusal: 'Pull request has not been independently observed',
  reason: `${work.key} is waiting on a fresh reading of its pull request`, llmRole: null, binding: 'resync:build',
  inputs: { kind: 'resync' as const, pr: 864, sha: null, baseSha: null, baseTip: null, observedAt: null },
});

const config = {
  version: 1, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: '/outside/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1, hostId: 'host', masterAgentName: 'm', autoMerge: true, mergeMethod: 'merge' as const,
  workers: [
    { name: 'claude-primary', principal: 'worker-a', agentName: 'work-a', mode: 'launch' as const, kind: 'claude', credentialFile: '/outside/a.token', approvals: 'auto' as const },
    { name: 'opencode-primary', principal: 'worker-b', agentName: 'work-b', mode: 'launch' as const, kind: 'opencode', credentialFile: '/outside/b.token', approvals: 'auto' as const },
  ],
} as unknown as MasterConfig;

/** The executor effects a control-plane handler runs against: claims and settles on the given work. */
function queueEffects(work: Work, clock: { now: number }, handlers: ExecutorEffects['handlers']): ExecutorEffects {
  return {
    claim: async request => {
      const claimed = claimAction([work], { id: request.executor, host: request.host, principal: 'graphyard-master' }, new Date(clock.now), { kinds: request.kinds, leaseMs: 120_000 });
      return { action: claimed ? structuredClone(claimed.row) : null };
    },
    settle: async (action, result, reason) => { settleAction(work, action.id, { executor: action.claim!.executor, principal: 'graphyard-master' }, result, reason, new Date(clock.now)); },
    handlers,
  };
}

/**
 * The base doctrine, reproduced: `attempts` refusals settled the way every refusal used to settle
 * — as failures — with the clock stepped to each backoff the base engine assigned. Returns the
 * instant of the last failure, which is where the derivation that judged the row stood.
 */
function baseRun(work: Work, reason: string, attempts: number, stepMs = 10 * 60_000) {
  let clock = origin;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const claimed = claimAction([work], { id: 'executor-1', host: 'host', principal: 'p' }, new Date(clock), {});
    assert.ok(claimed, `the base row is claimable for attempt ${attempt + 1}`);
    settleAction(work, claimed!.row.id, { executor: 'executor-1', principal: 'p' }, 'failed', reason, new Date(clock));
    clock = Math.max(clock + stepMs, Date.parse(claimed!.row.retryAt ?? '') + 1_000);
  }
  return { lastFailureAt: clock - stepMs };
}

test('unit:dispatch-capacity-wait — a dispatch every worker profile refuses for its role\'s concurrency limit settles as the row\'s named wait: no failure run, no stall, no escalation, and the launch happens on the first pass a slot frees (GY-947, GY-73, GY-806)', async () => {
  const work = item('GY-947');
  work.actionQueue = { actions: [row(work, 'dispatch')], history: [] };
  const clock = { now: origin };

  // The base, reproduced: the same refusals recorded as failures — as every handler refusal once
  // was — build the identical-reason run that stalls at three, and the eighth identical failure
  // is the moment the derivation escalated rather than retried. That is the recorded instance.
  const base = item('GY-947-BASE');
  base.actionQueue = { actions: [row(base, 'dispatch')], history: [] };
  const refusal = `no worker profile can take GY-947-BASE: claude-primary (${capacityReason}); opencode-primary (${capacityReason})`;
  const { lastFailureAt } = baseRun(base, refusal, livenessRetryLimit);
  assert.ok(actionStall(base.actionQueue!.actions[0]), 'base: three identical failures stall the row (the recorded instance)');
  const baseEscalated = livenessCarry(base, { gate: 'build', refusal: null, action: dispatchAction(base), wait: null, defect: null }, [base], new Date(lastFailureAt));
  assert.equal(baseEscalated.action!.kind, 'escalate', 'base: eight identical failures escalate rather than retry — the stalled-action fault');
  assert.equal(baseEscalated.action!.inputs.kind === 'escalate' ? baseEscalated.action!.inputs.trigger : '', 'stalled-action');

  // The candidate: the same handler, the same refusals, every attempt a wait.
  const handlers = controlPlaneHandlers(() => config, {
    snapshot: async () => ({ work: [work], now: at(0) }),
    mutate: async () => { throw new Error('a capacity wait reaches no launch'); },
    agents: () => [],
    // The fleet's answer while the worker role is full: every profile reads unavailable with the
    // registry's own concurrency-limit reason — what inspectProfileAccounts joins onto the
    // credential health the executor reads.
    workerCredentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: false, reason: capacityReason }])),
    producerCredentials: async () => ({}),
    dispatchWorker: async () => { throw new Error('unreached: no profile is healthy'); },
    launchReview: async () => ({}), launchProducer: async () => ({}), merge: async () => ({}), observeDeployment: async () => ({}) as never,
  });
  const effects = queueEffects(work, clock, handlers);
  const identity = { id: 'executor-1', host: 'host' };
  const attempts = livenessRetryLimit + 2;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const step = await runExecutorTick(identity, effects, () => clock.now);
    assert.equal(step.result, 'failed', 'the executor logs each attempt as it does any refusal');
    clock.now += actionWaitRecheckMs;
  }
  const waited = work.actionQueue!.actions[0];
  assert.ok(waited.history.filter(entry => entry.event === 'waited').length >= attempts, 'every attempt settled as a wait');
  assert.deepEqual(waited.history.filter(entry => entry.event === 'failed'), [], 'no attempt was ever recorded as a failure');
  assert.equal(actionStall(waited), null, 'a row of waits never stalls: a slot that may free is not an impossibility');
  assert.equal(waited.stall, undefined);
  assert.equal(Date.parse(waited.retryAt!) - (clock.now - actionWaitRecheckMs), actionWaitRecheckMs, 'the row rechecks on the fixed wait interval, so the relaunch is owed on the first pass one frees');
  assert.match(waited.resolution!, new RegExp(`^GY-947 waits for a worker slot, dispatched again on the first pass one frees: claude-primary \\(${capacityReason.replace(/[()]/g, '\\$&')}\\); opencode-primary`));
  const carried = livenessCarry(work, { gate: 'build', refusal: null, action: dispatchAction(work), wait: null, defect: null }, [work], new Date(clock.now));
  assert.equal(carried.action!.kind, 'dispatch', `past the escalation limit the row still carries the dispatch, not an escalation: ${carried.action!.kind}`);

  // A slot frees: the very next claim dispatches, and the row completes as a dispatch.
  const freedHandlers = controlPlaneHandlers(() => config, {
    snapshot: async () => ({ work: [work], now: at(0) }),
    mutate: async () => ({}),
    agents: () => [],
    workerCredentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    producerCredentials: async () => ({}),
    dispatchWorker: async () => ({ pane: 'pane-1' }),
    launchReview: async () => ({}), launchProducer: async () => ({}), merge: async () => ({}), observeDeployment: async () => ({}) as never,
  });
  const freed = await runExecutorTick(identity, queueEffects(work, clock, freedHandlers), () => clock.now);
  assert.equal(freed.result, 'done');
  assert.match(freed.reason, /dispatched GY-947 to claude-primary/);
  assert.equal(work.actionQueue!.actions[0].result, 'done');
});

test('unit:dispatch-mixed-refusal-stays-a-failure — a refusal naming anything somebody can fix now is a failure, not a wait', async () => {
  const work = item('GY-806');
  work.actionQueue = { actions: [row(work, 'dispatch')], history: [] };
  const clock = { now: origin };
  const mixed = {
    ...config,
    workers: [
      { name: 'claude-primary', principal: 'worker-a', agentName: 'work-a', mode: 'launch' as const, kind: 'claude', credentialFile: '/outside/a.token', approvals: 'auto' as const },
      { name: 'bootstrap-existing', principal: 'worker-b', agentName: 'work-b', mode: 'existing' as const },
    ],
  } as unknown as MasterConfig;
  const handlers = controlPlaneHandlers(() => mixed, {
    snapshot: async () => ({ work: [work], now: at(0) }),
    mutate: async () => ({}),
    agents: () => [],
    // One profile the fleet holds at capacity, one that is observed only: the mix names a
    // configuration the master can fix now, so the refusal stays a failure with its diagnosis.
    workerCredentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: false, reason: capacityReason }])),
    producerCredentials: async () => ({}),
    dispatchWorker: async () => ({}), launchReview: async () => ({}), launchProducer: async () => ({}), merge: async () => ({}), observeDeployment: async () => ({}) as never,
  });
  const step = await runExecutorTick({ id: 'executor-1', host: 'host' }, queueEffects(work, clock, handlers), () => clock.now);
  assert.equal(step.result, 'failed');
  const failed = work.actionQueue!.actions[0];
  assert.ok(failed.history.some(entry => entry.event === 'failed'), 'the mixed refusal is recorded as a failure');
  assert.match(failed.resolution!, /^no worker profile can take GY-806: claude-primary/);
  assert.equal(actionStall(failed), null, 'one failure does not stall; the failure run is the base doctrine and still applies');
});

test('unit:resync-permission-wait — an observation job held on a permission the operator must grant settles as the row\'s named operator wait: no failure run, no stall, and the row completes once the permission is accepted (GY-864, GY-515)', async () => {
  const work = item('GY-864');
  work.actionQueue = { actions: [row(work, 'resync', 'resync:build')], history: [] };
  const clock = { now: origin };
  const heldReason = `App graphyard-cryptob1-graphyard lacks Actions: write, which failed CI reruns needs to rerun failed workflow jobs on the unchanged candidate; ${permissionRequestMark}https://github.com/settings/installations/161493384`;
  const heldJob = { availableAt: at(actionWaitRecheckMs), lockedUntil: null, attempts: 4, error: null, heldUntil: at(30 * 60_000), heldReason };

  // The base, reproduced: the same condition settled the way every unobserved claim used to be —
  // a failure — builds the identical-reason run that stalled these very rows, and the eighth
  // identical failure is the escalation nothing could move.
  const base = item('GY-864-BASE');
  base.actionQueue = { actions: [row(base, 'resync', 'resync:build')], history: [] };
  const baseReason = `GY-864-BASE: ${resyncUnobservedPrefix}; its observation job is held: ${heldReason}; the claim woke it and leaves the row waiting for the observation`;
  const { lastFailureAt } = baseRun(base, baseReason, livenessRetryLimit);
  assert.ok(actionStall(base.actionQueue!.actions[0]), 'base: the held-permission resync stalls on its identical failures (the recorded instance)');
  const baseEscalated = livenessCarry(base, { gate: 'build', refusal: 'Pull request has not been independently observed', action: resyncAction(base), wait: null, defect: null }, [base], new Date(lastFailureAt));
  assert.equal(baseEscalated.action!.kind, 'escalate', 'base: the run is escalated with nothing able to move it');

  // The candidate: the job is held for a permission request, so every claim settles a wait.
  let granted = false;
  const resyncConfig: MasterConfig = { version: 1, url: '', credentialFile: '/outside/master.token', cliPath: '/outside/graphyard.mjs', repository: 'owner/project', baseBranch: 'main', githubAppId: 1, hostId: 'host', masterAgentName: 'm' } as unknown as MasterConfig;
  const handlers = controlPlaneHandlers(() => resyncConfig, {
    snapshot: async () => ({ work: [work], now: at(0) }),
    mutate: async () => ({ work, since: at(0), observed: granted, observedAt: granted ? at(-1_000) : null, job: granted ? { ...heldJob, heldUntil: null, heldReason: null } : heldJob }),
    agents: () => [], workerCredentials: async () => ({}), producerCredentials: async () => ({}),
    dispatchWorker: async () => ({}), launchReview: async () => ({}), launchProducer: async () => ({}), merge: async () => ({}), observeDeployment: async () => ({}) as never,
  });
  const effects = queueEffects(work, clock, handlers);
  const identity = { id: 'executor-1', host: 'host' };
  const attempts = livenessRetryLimit + 2;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const step = await runExecutorTick(identity, effects, () => clock.now);
    assert.equal(step.result, 'failed', 'the executor logs the wait as it logs any refusal');
    clock.now += actionWaitRecheckMs;
  }
  const waited = work.actionQueue!.actions[0];
  assert.ok(waited.history.filter(entry => entry.event === 'waited').length >= attempts, 'every claim settled as a wait');
  assert.deepEqual(waited.history.filter(entry => entry.event === 'failed'), [], 'no claim was ever recorded as a failure');
  assert.equal(actionStall(waited), null, 'a permission only the operator can grant is not an impossibility the row must stall on');
  assert.match(waited.resolution!, new RegExp(`^GY-864: ${resyncUnobservedPrefix}; its observation job is held: .*${permissionRequestMark.trim().replaceAll(' ', '\\s')}[^;]+; the row waits for the operator the hold names$`));
  const carried = livenessCarry(work, { gate: 'build', refusal: 'Pull request has not been independently observed', action: resyncAction(work), wait: null, defect: null }, [work], new Date(clock.now));
  assert.equal(carried.action!.kind, 'resync', 'past the escalation limit the row still carries the resync it is owed');

  // The operator accepts the permission request: the hold lifts, an observation saves, and the
  // very next claim completes the row.
  granted = true;
  const done = await runExecutorTick(identity, effects, () => clock.now);
  assert.equal(done.result, 'done');
  assert.match(done.reason, /^observed GY-864 at /);
  assert.equal(work.actionQueue!.actions[0].result, 'done');
});

test('unit:settle-wait-does-not-join-failure-run — a wait settlement rechecks on the wait interval, joins no failure run, and leaves a run of real failures intact across it', () => {
  const work = item('GY-73');
  const dispatch = row(work, 'dispatch');
  work.actionQueue = { actions: [dispatch], history: [] };
  const reason = 'a real fault';
  // Two real failures, then a wait, then two more real failures, each claim past the backoff the
  // last settlement assigned: the run reads straight through the wait (a wait says nothing about
  // the fault), so the stall doctrine stands.
  const offsets = [0, 10, 20, 30, 40];
  const outcomes = ['failed', 'failed', 'wait', 'failed', 'wait'] as const;
  for (const [index, outcome] of outcomes.entries()) {
    const claimAt = origin + offsets[index] * 60_000;
    const claimed = claimAction([work], { id: 'executor-1', host: 'host', principal: 'p' }, new Date(claimAt), {});
    assert.ok(claimed, `claimable for outcome ${index}`);
    settleAction(work, claimed!.row.id, { executor: 'executor-1', principal: 'p' }, outcome, outcome === 'wait' ? 'GY-73 waits for a worker slot' : reason, new Date(claimAt + 1_000));
  }
  const settled = work.actionQueue!.actions[0];
  const stall = actionStall(settled);
  assert.ok(stall, 'three real failures for one reason stall the row');
  assert.equal(stall!.failures, 3, 'the waits counted toward neither the run nor its break');
  assert.equal(stall!.reason, reason);
  // The last settlement was a wait: the row rechecks on the wait interval, not the stall's
  // widening one — the relaunch on slot-free is owed at the wait's own cadence.
  assert.equal(settled.result, 'wait');
  assert.equal(Date.parse(settled.retryAt!) - (origin + 40 * 60_000 + 1_000), actionWaitRecheckMs);
  assert.equal(settled.state, 'pending', 'a wait leaves the row open');
  assert.equal(settled.claim, null, 'and releases its claim');

  // A wait alone never stalls, whatever its count; each claim lands exactly on the recheck the
  // last wait set, as the executor's own cadence does.
  const waiting = row(work, 'dispatch', 'dispatch:1:implementation');
  work.actionQueue!.actions.push(waiting);
  for (let attempt = 0; attempt < 12; attempt++) {
    const claimed = claimAction([work], { id: 'executor-1', host: 'host', principal: 'p' }, new Date(origin + attempt * actionWaitRecheckMs), {});
    assert.ok(claimed, `the waiting row is claimable on its recheck for attempt ${attempt + 1}`);
    settleAction(work, claimed!.row.id, { executor: 'executor-1', principal: 'p' }, 'wait', 'GY-73 waits for a worker slot', new Date(origin + attempt * actionWaitRecheckMs));
  }
  assert.equal(actionStall(waiting), null, 'twelve waits are twelve rechecks, not a stall');
  const escalated = livenessCarry(work, { gate: 'build', refusal: null, action: dispatchAction(work), wait: null, defect: null }, [work], new Date(origin + 12 * actionWaitRecheckMs));
  assert.equal(escalated.action!.kind, 'dispatch', 'and no escalation is owed for a row that only ever waited');
});

test('unit:action-wait-error-tags-its-settlement — the tag is what runExecutorTick reads, and a plain error never settles a wait', async () => {
  const work = item('GY-73');
  work.actionQueue = { actions: [row(work, 'dispatch')], history: [] };
  const clock = { now: origin };
  const settle: { result: string; reason: string }[] = [];
  const effects: ExecutorEffects = {
    claim: async request => {
      const claimed = claimAction([work], { id: request.executor, host: request.host, principal: 'p' }, new Date(clock.now), { kinds: request.kinds, leaseMs: 120_000 });
      return { action: claimed ? structuredClone(claimed.row) : null };
    },
    settle: async (action, result, reason) => { settle.push({ result, reason }); settleAction(work, action.id, { executor: action.claim!.executor, principal: 'p' }, result, reason, new Date(clock.now)); },
    handlers: { dispatch: async () => { throw actionWaitError('GY-73 waits for a worker slot'); } },
  };
  await runExecutorTick({ id: 'executor-1', host: 'host' }, effects, () => clock.now);
  assert.deepEqual(settle, [{ result: 'wait', reason: 'GY-73 waits for a worker slot' }]);
  clock.now += actionWaitRecheckMs;
  const plain: ExecutorEffects = { ...effects, handlers: { dispatch: async () => { throw new Error('the guarded merge refused'); } } };
  await runExecutorTick({ id: 'executor-1', host: 'host' }, plain, () => clock.now);
  assert.deepEqual(settle[1], { result: 'failed', reason: 'the guarded merge refused' });
});
