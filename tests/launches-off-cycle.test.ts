import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { masterConfigSchema, type WorkerProfile } from '../src/master.js';
import { daemonSummary, emptyDaemonState, loopAttention, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { Launcher, defaultLaunchConcurrency } from '../src/daemon/cycle.js';
import { cycleCost, cycleTimes, loopLiveness, slowCycleAttention, slowCycleMs } from '../src/daemon/liveness.js';
import { type CycleMetrics, emptyCycleSteps } from '../src/daemon/state.js';
import type { Work } from '../src/model.js';

// GY-616: a burst of session launches ran inside the master cycle, one Herdr pane and session
// registration after another, and every merge, decision and close after them waited for the burst.
const cli = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const hour = 3_600_000;

function work(key: string): Work {
  return {
    id: `id-${key}`, key, title: key, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:x'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'ready', revision: 1, policyRevision: 1, createdAt: iso(-4 * hour), updatedAt: iso(0), stageEnteredAt: iso(-4 * hour),
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [],
  } as Work;
}
const profile = (name: string, credentialFile: string): WorkerProfile => ({ name, principal: `${name}-principal`, agentName: `agent-${name}`, mode: 'launch', kind: 'codex', credentialFile, agentArgs: [], approvals: 'auto', environment: {} });

test('unit:launches-off-cycle — the cycle hands 10 five-second launches to the launcher and completes in under 10 s; the launcher runs 3 at a time and all 10 finish, reported to the next cycle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-launches-off-cycle-'));
  try {
    const token = join(directory, 'coordinator.token'); await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const credential = join(directory, 'worker.token'); await writeFile(credential, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const keys = Array.from({ length: 10 }, (_, index) => `GY-${index + 1}`);
    const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: cli, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
      masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: keys.map((_, index) => profile(`worker-${index + 1}`, credential)) });
    assert.equal(master.run.launchConcurrency, undefined, 'master.json sets no concurrency, so the default applies');
    let running = 0, peak = 0;
    const finished: string[] = [];
    const effects: DaemonEffects = {
      agents: () => [], credentials: async items => Object.fromEntries(items.map(item => [item.name, { available: true, reason: null }])),
      snapshot: async () => ({ work: keys.map(work), now: iso(0) }),
      closeSession: () => {},
      // Each launch — a pane and a registered session — takes five seconds.
      dispatch: async item => { running += 1; peak = Math.max(peak, running); await delay(5_000); running -= 1; finished.push(item.key); },
      requestProof: () => {}, merge: async () => ({}), observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
      recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    };
    const state = emptyDaemonState(master), launcher = new Launcher();
    assert.equal(launcher.concurrency, defaultLaunchConcurrency); assert.equal(defaultLaunchConcurrency, 3);

    const started = Date.now();
    const first = await runCycle(master, state, effects, Date.now, launcher);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 10_000, `the cycle completed in ${elapsed}ms without waiting on its launches`);
    assert.ok(first.metrics.durationMs < 10_000);
    assert.equal(finished.length, 0, 'no five-second launch had finished when the cycle ended: it recorded the requests and moved on');
    assert.equal(launcher.pending, 10, 'all 10 launch requests are with the launcher');
    assert.ok(first.metrics.timings!.steps.every(step => step.ms < 5_000), 'no step of the cycle waited on a launch');
    assert.ok(!first.actions.some(action => action.kind === 'dispatch' && action.state === 'done'), 'nothing is reported done before it is');
    // Each launch in flight holds its profile, and the next cycle neither repeats a launch nor
    // reconciles its `started` entry as interrupted.
    const second = await runCycle(master, state, effects, Date.now, launcher);
    assert.ok(!second.actions.some(action => /Resumed/.test(action.detail)), 'a launch in flight is not reconciled as interrupted');
    assert.equal(launcher.pending, 10, 'a launch already in flight is not requested twice');

    await launcher.idle();
    assert.equal(finished.length, 10, 'all 10 launches finished');
    assert.deepEqual([...finished].sort(), [...keys].sort());
    assert.equal(peak, 3, 'the launcher ran at most 3 launches at once');
    assert.ok(Date.now() - started >= 15_000, 'ten 5 s launches, three at a time, take four waves');

    // The next cycle reports what every launch did.
    const third = await runCycle(master, state, effects, Date.now, launcher);
    const reported = third.actions.filter(action => action.kind === 'dispatch' && action.state === 'done').map(action => action.work).sort();
    assert.deepEqual(reported, [...keys].sort(), 'each launch result is reported to the next cycle');
    assert.equal(launcher.drain().length, 0);

    // A concurrency set in master.json is the launcher's.
    const tuned = masterConfigSchema.parse({ ...master, run: { ...master.run, launchConcurrency: 5 } });
    assert.equal(tuned.run.launchConcurrency, 5);
    await runCycle(tuned, emptyDaemonState(tuned), { ...effects, dispatch: async () => {} }, Date.now, launcher);
    assert.equal(launcher.concurrency, 5);
    await launcher.idle();
    assert.throws(() => masterConfigSchema.parse({ ...master, run: { ...master.run, launchConcurrency: 0 } }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:launches-off-cycle — the launcher queues past its concurrency, runs each key once, and a launch that throws settles without holding up the rest', async () => {
  const launcher = new Launcher(2);
  const gates: (() => void)[] = [];
  const order: string[] = [];
  for (const key of ['a', 'b', 'c']) assert.equal(launcher.submit(key, [`profile-${key}`], async sink => {
    order.push(key); await new Promise<void>(resolve => gates.push(resolve));
    sink.push({ kind: 'dispatch', work: key, principal: null, state: 'done', detail: `launched ${key}`, attempts: 1, epoch: null, cycle: 0, at: iso(0) });
  }), true);
  assert.equal(launcher.submit('a', [], async () => {}), false, 'a key in flight is not launched twice');
  await delay(10);
  assert.deepEqual(order, ['a', 'b'], 'two run, the third queues');
  assert.deepEqual([...launcher.held()].sort(), ['profile-a', 'profile-b', 'profile-c'], 'a queued launch already holds its profile');
  gates.shift()!();
  await delay(10);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.deepEqual(launcher.drain().map(action => action.detail), ['launched a']);
  launcher.submit('d', [], async () => { throw new Error('pane refused'); });
  for (const open of gates.splice(0)) open();
  await delay(10); gates.splice(0).forEach(open => open());
  await launcher.idle();
  assert.equal(launcher.pending, 0);
  assert.deepEqual(launcher.drain().map(action => action.detail).sort(), ['launched b', 'launched c']);
});

test('unit:slow-cycle-attention — a 90 s cycle raises a liveness attention naming its three slowest steps, and master status shows the p50/p95 cycle time over the last 30 minutes', () => {
  const now = clock;
  // Only what the cost and the percentiles read: the cycle, its wall time and its timed steps.
  const metric = (cycle: number, agoMs: number, durationMs: number, steps: { step: string; ms: number }[] = []) => ({ cycle, at: iso(-agoMs), durationMs, childWaitMs: 0, workMs: durationMs, steps: emptyCycleSteps(),
    timings: { totalMs: durationMs, steps, calls: [], slowCalls: 0 } }) as unknown as CycleMetrics;
  const slow = metric(40, 1_000, 90_000, [{ step: 'snapshot', ms: 2_000 }, { step: 'dispatch', ms: 41_000 }, { step: 'launches', ms: 30_000 }, { step: 'decisions', ms: 12_000 }, { step: 'merges', ms: 5_000 }]);
  const state = { ...emptyDaemonState(masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/dev/null', cliPath: cli, repository: 'owner/project', baseBranch: 'main', githubAppId: 1, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] })),
    lock: { id: 'loop', pid: process.pid, host: 'machine-a', startedAt: iso(-hour), heartbeatAt: iso(-1_000) }, cycle: 41, lastCycleAt: iso(-1_000),
    metrics: [metric(1, 45 * 60_000, 500_000), ...Array.from({ length: 19 }, (_, index) => metric(index + 20, (20 - index) * 60_000, (index + 1) * 1_000)), slow] };
  // A 90 s cycle, on a two-minute interval: its work fit the interval and the loop is running, so
  // nothing else says the delivery steps in it waited ninety seconds.
  const cost = cycleCost(slow, 120_000)!;
  assert.deepEqual(cost.slowestSteps, [{ step: 'dispatch', ms: 41_000 }, { step: 'launches', ms: 30_000 }, { step: 'decisions', ms: 12_000 }]);
  const liveness = loopLiveness(state, now, 120_000, 'machine-a');
  assert.equal(liveness.state, 'running');
  assert.deepEqual(loopAttention({ liveness, cost }), [], 'the cost lines judge the loop\'s own work, which fit');
  const summary = daemonSummary(state, now, 120_000, 'machine-a');
  const items = slowCycleAttention(summary);
  assert.equal(items.length, 1, 'a cycle past 60 s raises a liveness attention');
  const [attention] = items;
  assert.equal(attention.subject, 'loop'); assert.equal(attention.kind, 'loop-liveness'); assert.equal(attention.role, 'master');
  assert.equal(attention.text, 'Cycle 40 took 90s, past the 60s cycle bound (p50 10s, p95 19s over the last 30 minutes), and every merge, decision and close in it waited that long; slowest steps: dispatch 41s, launches 30s, decisions 12s');
  assert.match(attention.next, /shorten the dispatch step/);
  assert.equal(slowCycleMs, 60_000);

  // A cycle inside the bound raises none of it; nor does a loop that is not running at all.
  assert.deepEqual(slowCycleAttention({ liveness, cost: cycleCost(metric(41, 1_000, 55_000, [{ step: 'dispatch', ms: 50_000 }]), 120_000) }), []);
  assert.deepEqual(slowCycleAttention({ liveness: { state: 'absent' }, cost }), []);

  // p50/p95 over the last 30 minutes: the 45-minute-old 500 s cycle is outside the window.
  const times = cycleTimes(state.metrics, now);
  assert.deepEqual(times, { windowMs: 30 * 60_000, cycles: 20, p50Ms: 10_000, p95Ms: 19_000 });
  assert.deepEqual(summary.cycleTime, times, 'master status shows the cycle-time percentiles under daemon.cycleTime');
  assert.deepEqual(cycleTimes([], now), { windowMs: 30 * 60_000, cycles: 0, p50Ms: null, p95Ms: null });
});
