import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { masterConfigSchema, type EscalationSession, type WorkerProfile } from '../src/master.js';
import { daemonSummary, emptyDaemonState, failoverKey, loopAttention, runCycle, type DaemonEffects } from '../src/master-daemon.js';
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

test('unit:launches-off-cycle — a launch body that throws after its started entry settles that entry failed, and the next cycle retries without a restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-launch-settles-'));
  try {
    const token = join(directory, 'coordinator.token'); await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const credential = join(directory, 'worker.token'); await writeFile(credential, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const item = work('GY-901');
    const key = `dispatch:${item.id}:${item.epoch}`;
    const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: cli, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
      masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [profile('worker-1', credential)] });
    let dispatches = 0;
    const effects: DaemonEffects = {
      agents: () => [], credentials: async entries => Object.fromEntries(entries.map(entry => [entry.name, { available: true, reason: null }])),
      snapshot: async () => ({ work: [item], now: iso(0) }),
      closeSession: () => {},
      dispatch: async () => { dispatches += 1; },
      requestProof: () => {}, merge: async () => ({}), observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
      recordDeployment: async () => {}, requestSmoke: () => {},
      // The cursor refuses writes while the dispatch's started entry stands: the launch body then
      // throws after recording it, the way a failing store throws any body past its own settling.
      persist: async current => { if (current.actions[key]?.state === 'started') throw new Error('the cursor refused the write'); },
    };
    const state = emptyDaemonState(master), launcher = new Launcher();
    await runCycle(master, state, effects, Date.now, launcher);
    await launcher.idle();
    assert.equal(state.actions[key]?.state, 'failed', 'the thrown launch settles its own started entry failed, not left started until a restart reconciles it');
    assert.match(state.actions[key]!.detail, /settled failed/);
    assert.equal(state.actions[`isolated:dispatch:${item.id}`]?.state, 'failed', 'the isolated failure is recorded as before');
    assert.equal(dispatches, 0, 'the body threw before it could dispatch');
    // A failed entry is a retryable failure, so the next cycle launches again; a stale started
    // entry would have held the item back until a restart reconciled it.
    await runCycle(master, state, effects, Date.now, launcher);
    await launcher.idle();
    assert.equal(state.actions[key]!.attempts, 2, 'the next cycle attempted the dispatch again');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:launches-off-cycle — an escalation-handler relaunch is handed to the launcher beside the cycle, and its failover settles when it lands', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-escalation-launch-'));
  try {
    const token = join(directory, 'coordinator.token'); await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const credential = join(directory, 'worker.token'); await writeFile(credential, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const item = { ...work('GY-902'), stage: 'backlog', ready: false } as Work;
    const launchedAt = iso(-hour);
    const session: EscalationSession = { agentName: 'gy-esc-old', pane: 'pane-gy-esc-old', work: item.key, trigger: 'lease-loss', kind: 'claude', account: null, runtime: 'claude', launchedAt, session: null, waiting: null };
    const herdrAgents = [{ name: 'gy-esc-old', pane_id: 'pane-gy-esc-old', agent_status: 'idle' }];
    const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: cli, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
      masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [profile('worker-1', credential)] });
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ends: { resolution: string; waiting: unknown }[] = [], relaunches: string[] = [], held: string[] = [];
    const effects: DaemonEffects = {
      agents: () => herdrAgents, credentials: async entries => Object.fromEntries(entries.map(entry => [entry.name, { available: true, reason: null }])),
      herdr: async () => ({ agents: herdrAgents, available: true }),
      snapshot: async () => ({ work: [item], now: iso(0) }),
      closeSession: () => {},
      dispatch: async () => {},
      sessionOutput: () => "  ⎿ You've hit your usage limit\n",
      reportCapacity: async () => item,
      escalationSessions: async () => [session],
      holdAccount: async name => { held.push(name); },
      endEscalation: async (ended, resolution, waiting) => { ends.push({ resolution, waiting }); },
      // The relaunch is the slow part — a pane and a session registration — and the gate holds it
      // past the cycle that hands it over, the way a real Herdr holds a burst of launches.
      relaunchEscalation: async () => { await gate; relaunches.push(session.trigger); return { agentName: 'gy-esc-next', account: 'env-b' }; },
      requestProof: () => {}, merge: async () => ({}), observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
      recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    };
    const state = emptyDaemonState(master), launcher = new Launcher(1);
    const key = failoverKey('escalation-handler', item, `lease-loss:${launchedAt}`);
    const first = await runCycle(master, state, effects, Date.now, launcher);
    assert.equal(launcher.pending, 1, 'the cycle handed the relaunch over and moved on; it did not wait on it in the close step');
    assert.equal(relaunches.length, 0, 'the gated relaunch has not landed');
    assert.equal(held.length > 0, true, 'the exhausted handler\'s account was held in the cycle, as before');
    assert.equal(ends.length, 1, 'the spent handler was ended in the launch body');
    assert.equal(state.actions[key]?.state, 'started', 'its failover stands started while the launch is in flight');
    release();
    await launcher.idle();
    assert.deepEqual(relaunches, ['lease-loss']);
    assert.equal(state.actions[key]?.state, 'done', JSON.stringify(state.actions[key]));
    assert.match(state.actions[key]!.detail, /relaunched as gy-esc-next on env-b/);
    assert.equal(first.actions.filter(action => action.kind === 'failover' && action.state === 'done').length, 0, 'the cycle that handed it over reported nothing yet');
    // The next cycle reports what the launch did.
    const second = await runCycle(master, state, effects, Date.now, launcher);
    await launcher.idle();
    assert.ok(second.actions.some(action => action.kind === 'failover' && action.state === 'done' && /relaunched as gy-esc-next/.test(action.detail)), JSON.stringify(second.actions));
    assert.equal(relaunches.length, 1, 'the settled failover is not launched again');
  } finally { await rm(directory, { recursive: true, force: true }); }
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
