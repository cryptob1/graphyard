import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Work } from '../src/model.js';
import type { MasterConfig } from '../src/master.js';
import { runExecutor, type ExecutorEffects } from '../src/auto-dispatch.js';
import { controlPlaneHandlers, watchdogEffects } from '../src/executor.js';
import { executorFleetReport, executorRegistrar, readExecutorRegistrations, writeExecutorRegistration, type ExecutorRegistration } from '../src/executor-fleet.js';
import { actionStallThreshold } from '../src/model/action-progress.js';
import { resyncUnobservedPrefix } from '../src/model/action-kinds.js';
import { claimAction, renewClaim, settleAction, type ActionRow } from '../src/model/actions.js';

/**
 * GY-646: after GY-607 a `resync` waited inside its claim for the observation it woke, up to 90s
 * per claim, and an executor that stood down after its checkout moved stopped notifying systemd
 * altogether; the unit's WatchdogSec=180 then aborted it with SIGABRT and a core dump. Each test is
 * named for the proof it produces: unit:resync-never-blocks-executor and
 * unit:executor-watchdog-abort-recorded here, unit:executor-stand-down-exits in
 * tests/executor-supervision.test.ts beside the supervised-unit harness it runs under.
 */

const unusable = async (): Promise<never> => { throw new Error('not reached'); };
const job = { availableAt: null, lockedUntil: null, attempts: 0, error: null, heldUntil: null, heldReason: null };

test('unit:resync-never-blocks-executor — a resync claim wakes the observation job and returns; the row waits (backing off, then stalled after the bounded claims) and completes on a later claim once an observation newer than the first claim exists, while the executor loop notifies the watchdog at least every 30s', async () => {
  // The executor's own clock, driven by the test: each poll is the executor's idle interval, each
  // control-plane request takes two seconds, and any in-handler wait would advance it too.
  let clock = Date.parse('2026-09-26T13:18:00.000Z');
  const now = () => new Date(clock);
  const intervalMs = 5_000, requestMs = 2_000;
  const row: ActionRow = { id: 'c'.repeat(32), kind: 'resync', work: 'work-303', key: 'GY-303', inputs: { kind: 'resync', pr: 303, sha: null, baseSha: null, baseTip: null, observedAt: null }, gate: 'build',
    refusal: 'Pull request has not been independently observed', reason: 'GY-303 needs a fresh provider reading', binding: 'resync:303', requestedBy: 'graphyard', requestedAt: now().toISOString(), state: 'pending', claim: null, attempts: 0, history: [] };
  const work = { id: 'work-303', key: 'GY-303', title: 'Fixture', stage: 'build', actionQueue: { actions: [row], history: [] } } as unknown as Work;

  // The control plane's resync route: it wakes the job and answers at once whether an observation
  // newer than `since` is saved. The observation never arrives until the test saves one.
  let observedAt: string | null = null;
  const requests: { since: string; at: number }[] = [];
  const handlers = controlPlaneHandlers(() => ({}) as MasterConfig, {
    snapshot: async () => ({ work: [work], now: now().toISOString() }),
    mutate: async (path, input) => {
      const body = input as { since: string; wake?: boolean };
      assert.equal(path, 'work/work-303/resync');
      assert.notEqual(body.wake, false, 'every claim wakes the observation job; none only reads');
      clock += requestMs;
      requests.push({ since: body.since, at: clock });
      const observed = !!observedAt && Date.parse(observedAt) > Date.parse(body.since);
      return { work, since: body.since, observedAt, observed, job };
    },
    agents: () => [], workerCredentials: async () => ({}), producerCredentials: async () => ({}),
    dispatchWorker: unusable, launchReview: unusable, launchProducer: unusable, merge: unusable, observeDeployment: unusable,
  });

  const executor = { id: 'graphyard-master@vishrog/1', host: 'vishrog' };
  const base: ExecutorEffects = {
    claim: async request => {
      clock += intervalMs;
      const claimed = claimAction([work], { id: request.executor, host: request.host, principal: 'graphyard-master' }, now(), { kinds: request.kinds, leaseMs: 120_000 });
      return { action: claimed ? structuredClone(claimed.row) : null };
    },
    settle: async (action, result, reason) => { clock += requestMs; return settleAction(work, action.id, { executor: action.claim!.executor, principal: 'graphyard-master' }, result, reason, now()); },
    renew: async action => renewClaim(work, action.id, { executor: action.claim!.executor, principal: 'graphyard-master' }, now()),
    handlers: { resync: handlers.resync! },
  };
  // The watchdog as systemd keeps it: the instant of every keep-alive on the executor's clock.
  const notified: number[] = [clock];
  const effects = watchdogEffects(base, () => notified.push(clock));
  const run = (maxSteps: number) => runExecutor(executor, effects, { intervalMs: 1, now: () => clock, maxSteps });
  const longestGap = () => Math.max(...notified.slice(1).map((at, index) => at - notified[index]));

  // Ten minutes of an observation that never arrives.
  const until = clock + 10 * 60_000;
  const steps = [];
  while (clock < until) steps.push(...(await run(10)).steps);
  const ran = steps.filter(step => step.action);
  assert.ok(ran.length >= actionStallThreshold, `the row was claimed at least ${actionStallThreshold} times (${ran.length})`);
  assert.equal(requests.length, ran.length, 'each claim makes exactly one request of the control plane and waits for nothing');
  assert.ok(ran.every(step => step.result === 'failed'), 'no claim completes without an observation');
  assert.ok(longestGap() <= 30_000, `the watchdog is notified at least every 30s (longest gap ${longestGap() / 1000}s)`);

  // The action is left waiting, not blocking: pending, backing off, and stalled after the bounded run.
  const waiting = work.actionQueue!.actions[0];
  assert.equal(waiting.state, 'pending');
  assert.equal(waiting.claim, null);
  assert.ok(waiting.retryAt && Date.parse(waiting.retryAt) > clock - intervalMs, 'the row waits out a backoff before it is offered again');
  assert.ok(waiting.stall, `after ${actionStallThreshold} unobserved claims the row is stalled rather than retried on a steady beat`);
  assert.match(waiting.stall!.reason, new RegExp(`^GY-303: ${resyncUnobservedPrefix}; its observation job is scheduled and records no error, yet saved no observation; the claim woke it and leaves the row waiting for the observation$`));
  const first = waiting.history.find(entry => entry.event === 'claimed')!.at;
  assert.ok(requests.every(request => request.since === first), 'every claim in the run waits for an observation newer than the claim that first woke the job');

  // The observation lands between two claims — after the first claim, before the next one — and
  // the next claim completes the action on it.
  observedAt = new Date(clock - 1_000).toISOString();
  assert.ok(Date.parse(observedAt) > Date.parse(first));
  const later: Awaited<ReturnType<typeof run>>['steps'] = [];
  while (!later.some(step => step.result === 'done') && clock < until + 60 * 60_000) later.push(...(await run(1)).steps);
  const completed = later.find(step => step.result === 'done');
  assert.ok(completed, 'a later claim completes the row once the observation exists');
  assert.equal(completed!.reason, `observed GY-303 at ${observedAt}, after the claim at ${first}`);
  assert.equal(work.actionQueue!.actions[0].state, 'done');
  assert.ok(longestGap() <= 30_000, `the watchdog is still notified at least every 30s (longest gap ${longestGap() / 1000}s)`);
});

test('unit:executor-watchdog-abort-recorded — an executor whose previous process was killed mid-action records at start which action and item it was running, and master status raises it as an attention item until the process stops', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-executor-abort-'));
  const master = { credentialFile: join(directory, 'coordinator.token'), hostId: 'vishrog' } as MasterConfig;
  const name = 'graphyard-master@vishrog/1', unit = 'graphyard-executor@1.service';
  const input = { name, host: 'vishrog', pid: 4242, principal: 'graphyard-master', kinds: ['resync'], intervalSeconds: 5, root: '/srv/graphyard', release: { commit: 'a'.repeat(40), dirty: false }, supervisor: unit };
  const previous = (overrides: Partial<ExecutorRegistration> = {}): ExecutorRegistration => ({
    version: 1, name, host: 'vishrog', pid: 1289183, principal: 'graphyard-master', kinds: ['resync'], intervalSeconds: 5, root: '/srv/graphyard', release: { commit: 'a'.repeat(40), dirty: false },
    supervisor: { unit, restart: `systemctl --user restart ${unit}` }, state: 'running', standDown: null, startedAt: '2026-09-26T13:00:00.000Z', updatedAt: '2026-09-26T13:18:59.000Z', stoppedAt: null,
    claims: 7, lastClaim: null, inFlight: { id: 'd'.repeat(32), key: 'GY-303', kind: 'resync', since: '2026-09-26T13:18:30.000Z' }, claiming: null, interrupted: null, ...overrides });
  const at = Date.parse('2026-09-26T13:21:47.000Z');
  try {
    // The watchdog aborted the previous process inside a resync of GY-303: its record still says
    // running, still holds the action in flight, and its pid is gone.
    await writeExecutorRegistration(master, previous());
    const restarted = executorRegistrar(master, input, () => at, pid => pid !== 1289183);
    await restarted.started();
    const [record] = await readExecutorRegistrations(master);
    assert.deepEqual(record.interrupted, { id: 'd'.repeat(32), key: 'GY-303', kind: 'resync', since: '2026-09-26T13:18:30.000Z', pid: 1289183, lastSeen: '2026-09-26T13:18:59.000Z', recordedAt: new Date(at).toISOString() });
    assert.equal(record.inFlight, null, 'the new process holds nothing in flight');
    assert.equal(record.pid, 4242);

    const report = executorFleetReport([record], { commit: 'a'.repeat(40) }, { hostId: 'vishrog', alive: () => true });
    const items = report.attention.filter(item => item.subject === 'executors');
    assert.equal(items.length, 1, 'one attention item names the interrupted action');
    assert.match(items[0].text, new RegExp(`^${name.replace('/', '\\/')} on vishrog was killed while running resync for GY-303 \\(action ${'d'.repeat(32)}, claimed 2026-09-26T13:18:30.000Z\\)`));
    assert.match(items[0].text, /pid 1289183, last recorded at 2026-09-26T13:18:59.000Z, ended without settling it or recording itself stopped; under graphyard-executor@1\.service that is its watchdog's abort \(SIGABRT\) or another kill/);
    assert.equal(items[0].next, `journalctl --user -u ${unit}`);
    assert.deepEqual(report.executors[0].interrupted, record.interrupted);

    // Once the process that recorded it stops cleanly, the record and the attention clear.
    await restarted.stopped();
    const [stopped] = await readExecutorRegistrations(master);
    assert.equal(stopped.interrupted, null);
    assert.deepEqual(executorFleetReport([stopped], { commit: 'a'.repeat(40) }, { hostId: 'vishrog', alive: () => false }).attention, []);

    // Nothing is recorded for a previous process that stopped cleanly, or that settled its action,
    // or that is still alive (a second process under the same name is not a restart).
    for (const [label, earlier] of [['stopped', previous({ state: 'stopped', stoppedAt: '2026-09-26T13:19:00.000Z' })], ['settled', previous({ inFlight: null })]] as const) {
      await writeExecutorRegistration(master, earlier);
      const clean = executorRegistrar(master, input, () => at, () => false);
      await clean.started();
      assert.equal(clean.registration.interrupted, null, `a previous process that ${label} left nothing interrupted`);
    }
    await writeExecutorRegistration(master, previous());
    const beside = executorRegistrar(master, input, () => at, () => true);
    await beside.started();
    assert.equal(beside.registration.interrupted, null, 'a previous process that is still alive was not killed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
