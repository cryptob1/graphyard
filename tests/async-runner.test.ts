import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ChildProcessError, ChildWaitLedger, childRunner, runChild } from '../src/child-runner.js';
import { cycleCost, daemonSummary, emptyCycleSteps, emptyDaemonState, loopAttention, loopLiveness, runCycle, runDaemon, cycleMetricsSchema, type DaemonEffects } from '../src/master-daemon.js';
import { emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { cycleBudget } from '../src/cli/master-status.js';
import { listHerdrAgents, masterConfigSchema, startAgentSession, type HerdrAgent, type MasterConfig, type MasterRun, type ProducerProfile, type WorkerProfile } from '../src/master.js';
// @ts-expect-error The standalone executor is a dependency-free entry point script.
import { controlPlaneEffects } from '../scripts/graphyard-executor.mjs';
import type { DispatchRequest } from '../src/model/dispatch.js';
import type { Work } from '../src/model.js';

// GY-125. Each test is named for the proof it produces: unit:no-sync-child-processes,
// integration:snapshot-read-unblocked-by-launch and unit:child-wait-attributed.

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
const launcher = join(repository, 'bin/graphyard.mjs');
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();

function config(credentialFile: string, overrides: Partial<Omit<MasterConfig, 'run'>> & { run?: Partial<MasterRun> } = {}): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], ...overrides });
}
function work(overrides: Partial<Work> = {}): Work {
  return {
    id: 'work-1', key: 'GY-125', title: 'Never block the loop on a child', description: '', type: 'bug', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:child-wait-attributed'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'ready', revision: 3, policyRevision: 1,
    createdAt: iso(-3_600_000), updatedAt: iso(0), stageEnteredAt: iso(-3_600_000), ready: true, epoch: 0,
    lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], ...overrides,
  } as Work;
}
function effects(overrides: Partial<DaemonEffects> = {}): DaemonEffects {
  return {
    agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: [], now: iso(0) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    persist: async () => {},
    ...overrides,
  };
}
async function privateDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const token = join(directory, 'coordinator.token');
  await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  return { directory, token };
}

/**
 * A Herdr on PATH whose session start takes thirty seconds — until the test releases it — and
 * whose every other command answers at once. Since GY-121 a launch is `pane run` typing the
 * command line and then `agent get` and `pane read` until the runtime is ready: here `pane run`
 * itself holds for the delay, exactly as `agent start … --timeout 30000` held before it, and the
 * runtime is seen ready the moment it returns. The script is a real child process: what it
 * exercises is the runner, not a stub of it.
 */
async function slowHerdr(directory: string, startDelayMs: number) {
  const release = join(directory, 'release');
  const script = join(directory, 'herdr-stub.mjs');
  await writeFile(script, `
    import { existsSync } from 'node:fs';
    const args = process.argv.slice(2);
    const answer = value => { process.stdout.write(JSON.stringify(value)); };
    if (args[0] === 'pane' && args[1] === 'run') {
      const deadline = Date.now() + ${startDelayMs};
      const wait = () => { if (existsSync(${JSON.stringify(release)}) || Date.now() >= deadline) answer({ result: { ran: true } }); else setTimeout(wait, 25); };
      wait();
    } else if (args[0] === 'pane' && args[1] === 'read') process.stdout.write('claude ready\\n');
    else if (args[0] === 'agent' && args[1] === 'get') answer({ result: { agent: { agent: 'claude', agent_status: 'idle', pane_id: args[2] } } });
    else if (args[0] === 'agent' && args[1] === 'rename') answer({ result: { agent: { agent: 'claude', agent_status: 'idle', name: args[3] } } });
    else if (args[0] === 'agent' && args[1] === 'list') answer({ result: { agents: [{ name: 'someone-else', pane_id: 'pane-9', agent_status: 'working' }] } });
    else if (args[0] === 'tab' && args[1] === 'create') answer({ result: { root_pane: { pane_id: 'pane-1', tab_id: 'tab-1' } } });
    else answer({ result: {} });
  `);
  const executable = join(directory, 'herdr');
  await writeFile(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
  await chmod(executable, 0o755);
  return { path: `${directory}:${process.env.PATH ?? ''}`, release: () => writeFile(release, 'go') };
}

test('unit:no-sync-child-processes — the loop, the dispatcher, the merge broker and every runtime helper they reach run children only through the asynchronous runner; the one synchronous child is the CLI reading its own commit at startup', async () => {
  // The five modules the item names, and the helpers those modules reach at runtime for
  // Herdr, gh, git and systemctl. None may hold a synchronous child call, a blocking sleep, or
  // its own import of node:child_process: the runner is the only way out of the process.
  const loop = ['src/master.ts', 'src/master-daemon.ts', 'src/auto-dispatch.ts', 'src/producer.ts', 'src/reviewer.ts'];
  const reached = ['src/containment-probe.ts', 'src/harness.ts', 'src/install/worktree-root.ts', 'src/cli/master.ts', 'src/cli/master-status.ts'];
  // The dispatcher that runs outside the daemon: the stateless executor claims dispatch rows and
  // launches sessions from its own process, and must renew its claim while a launch is in flight.
  const standalone = ['scripts/graphyard-executor.mjs'];
  // The single allow-listed CLI-startup path: `cliCommit` reads the CLI checkout's own commit for
  // the version-skew guard once, when a `master` command starts, before the loop runs a cycle.
  const allowed = new Map([['src/protocol-version.ts', 'cliCommit reads the CLI checkout commit once at command startup']]);
  const synchronous = /\b(?:execFileSync|spawnSync|execSync)\b|Atomics\.wait\(/;
  const childProcessImport = /from ['"]node:child_process['"]/;
  // Comments are not calls: a doc comment may name execFileSync to say what replaced it.
  const uncommented = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');
  const offenders: string[] = [];
  for (const file of [...loop, ...reached, ...standalone, ...allowed.keys()]) {
    const source = uncommented(await readFile(join(repository, file), 'utf8'));
    const lines = source.split('\n').map((line, index) => ({ line, number: index + 1 })).filter(entry => synchronous.test(entry.line));
    if (allowed.has(file)) { assert.ok(lines.length > 0, `${file} is allow-listed for ${allowed.get(file)}; an allow-list entry nothing uses is removed`); continue; }
    offenders.push(...lines.map(entry => `${file}:${entry.number}: ${entry.line.trim().slice(0, 120)}`));
    if (childProcessImport.test(source)) offenders.push(`${file}: imports node:child_process; children go through src/child-runner.ts`);
  }
  assert.deepEqual(offenders, [], 'no synchronous child process outside the allow-listed CLI-startup path');
  // The runner itself is asynchronous by construction: it spawns and awaits, never blocks.
  const runner = uncommented(await readFile(join(repository, 'src/child-runner.ts'), 'utf8'));
  assert.ok(!synchronous.test(runner), 'the runner holds no synchronous child call');
  assert.match(runner, /import \{ spawn \} from 'node:child_process'/);

  // The runner's contract, on real children: stdout is the value; a non-zero exit rejects with
  // the fields execFileSync's error carried; a child past its bound is killed and says so.
  assert.equal((await runChild(process.execPath, ['-e', "process.stdout.write('answer')"])).trim(), 'answer');
  await assert.rejects(runChild(process.execPath, ['-e', "process.stdout.write('partial'); process.stderr.write('reason'); process.exit(3)"]), (error: unknown) => {
    assert.ok(error instanceof ChildProcessError);
    assert.equal(error.status, 3); assert.equal(error.stdout, 'partial'); assert.equal(error.stderr, 'reason'); assert.equal(error.timedOut, false);
    assert.match(error.message, /^Command failed: .*-e process\.stdout/);
    return true;
  });
  const started = Date.now();
  await assert.rejects(runChild(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 200 }), (error: unknown) => {
    assert.ok(error instanceof ChildProcessError);
    assert.equal(error.timedOut, true); assert.equal(error.signal, 'SIGTERM'); assert.match(error.message, /did not finish within 200ms and was killed/);
    return true;
  });
  assert.ok(Date.now() - started < 5_000, 'a timed-out child is killed at its bound, not waited out');
  await assert.rejects(runChild('graphyard-no-such-command-125', []), (error: unknown) => error instanceof ChildProcessError && /could not be started/.test(error.message));

  // A runner that answers is not enough: a caller that forgets to await one is worse than a
  // synchronous one, because it reads a field off a promise and gets a silent undefined. The
  // standalone executor's effects are held here against stub modules: its Herdr inventory read
  // must resolve to the agents, and to null only when Herdr itself could not be read — a
  // dispatch row it claims is failed outright when the inventory comes back null.
  const inventory: HerdrAgent[] = [{ name: 'producer-a', pane_id: 'pane-1', agent_status: 'idle' } as HerdrAgent];
  const runners: unknown[] = [];
  const stub = (observe: (run: unknown) => Promise<{ agents: HerdrAgent[]; available: boolean; reason: string | null }>) => ({
    master: { observeHerdrAgents: (run: unknown) => { runners.push(run); return observe(run); } }, daemon: {}, reviewer: {}, producer: {},
  });
  const bound = childRunner();
  const context = { root: repository, current: () => config(launcher), run: bound, snapshot: async () => ({ work: [], now: iso(0) }), mutate: async () => ({}), mergeExecutor: { principal: 'coordinator', instance: 'executor-1' } };
  const available = controlPlaneEffects(stub(async () => ({ agents: inventory, available: true, reason: null })), context);
  assert.deepEqual(await available.agents(), inventory, 'the executor reads the Herdr inventory through the asynchronous runner and awaits it');
  assert.deepEqual(runners, [bound], 'and hands that runner to the read rather than running a child of its own');
  const unreadable = controlPlaneEffects(stub(async () => ({ agents: [], available: false, reason: 'Herdr is unavailable' })), context);
  assert.equal(await unreadable.agents(), null, 'an unreadable inventory is null, which fails the row rather than launching against an empty roster');
});

test('integration:snapshot-read-unblocked-by-launch — while the dispatcher waits thirty seconds on a Herdr session start, a cycle beside it reads its snapshot in under two seconds and completes without a failure', async () => {
  const { directory, token } = await privateDirectory('graphyard-unblocked-');
  const herdr = await slowHerdr(directory, 30_000);
  const run = childRunner({ timeoutMs: 60_000, env: { ...process.env, PATH: herdr.path } });
  // A control plane on this host: the snapshot is a real HTTP read with the loop's own bound.
  const server = createServer((request, response) => {
    setTimeout(() => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ work: [], now: new Date().toISOString() })); }, 20);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  const reads: number[] = [];
  const snapshot = async () => {
    const startedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/api/work-snapshot`, { signal: AbortSignal.timeout(8_000) });
    const body = await response.json() as { work: Work[]; now: string };
    reads.push(Date.now() - startedAt);
    return body;
  };
  try {
    const master = config(token, { producers: [{ name: 'producer-a', principal: 'producer-a', agentName: 'producer-a', kind: 'claude', credentialFile: join(directory, 'producer.token'), agentArgs: [], approvals: 'auto', environment: {} } as ProducerProfile] });
    const request: DispatchRequest = { id: 'req-unit', kind: 'producer', sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 1, pr: 125, group: 'unit', proofs: ['unit:child-wait-attributed'], requestedAt: iso(0), reason: 'unit proofs', state: 'requested' };
    const submitted = work({ stage: 'review', epoch: 1, submission: { epoch: 1, pr: 125 }, candidate: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 125, branch: 'graphyard/gy-125-1', author: 'worker' }, autoDispatch: { review: null, producers: [request], history: [] } } as Partial<Work>);
    // The dispatcher's tick launches the producer through the real launch path — the request file
    // written, `herdr pane run` typing the command line — run by the runner against the Herdr
    // above, whose `pane run` does not answer.
    const launches: string[] = [];
    const dispatcher: DispatchEffects = {
      snapshot: async () => ({ work: [submitted], now: iso(0) }),
      agents: () => listHerdrAgents(run),
      credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
      reconcileReviews: async () => ({ reviews: [] }), reconcileProducers: async () => ({ producers: [] }),
      launchReview: async () => { throw new Error('no review in this test'); },
      launchProducer: async (item, req, profile) => { launches.push(`${item.key}:${req.group}:${profile.name}`); return startAgentSession('producer-gy-125-1', 'claude', 'pane-1', [], 'Produce the unit proofs', run, { directory }); },
      persist: async () => {},
    };
    const tickStartedAt = Date.now();
    const tick = runDispatchTick(master, emptyDispatchCursor(master), dispatcher, Date.now, 8_000);
    // The launch is in flight: the stub is waiting on its release, and the cycle now runs beside it.
    await sleep(300);
    assert.deepEqual(launches, ['GY-125:unit:producer-a'], 'the tick reached the launch');
    const state = emptyDaemonState(master), log: string[] = [];
    const result = await runDaemon(master, state, effects({ snapshot, agents: () => listHerdrAgents(run) }), { once: true, intervalMs: 20_000, identity: { pid: process.pid, host: master.hostId }, signals: [], log: line => log.push(line) });
    assert.equal(reads.length, 1, 'the cycle read its snapshot once');
    assert.ok(reads[0] < 2_000, `the snapshot read completed in ${reads[0]}ms while the launch was still waiting`);
    assert.ok(Date.now() - tickStartedAt < 10_000, 'the cycle did not wait for the launch to end');
    assert.equal(result.failed.length, 0, 'the cycle logged no failure');
    assert.equal(result.cycles.length, 1);
    assert.equal(state.failures.consecutive, 0);
    assert.ok(!log.some(line => /failed in the snapshot call|aborted due to timeout/.test(line)), log.join('\n'));
    // The cycle's own Herdr read went through the same runner, beside the stalled launch.
    assert.ok(log.some(line => /cycle 0 complete in \d+ms \(\d+ms waiting on child processes\)/.test(line)), log.join('\n'));
    // Let the launch finish: the tick then records it as launched, exactly as a fast Herdr would.
    await herdr.release();
    const ticked = await tick;
    assert.deepEqual(ticked.launched.map(entry => [entry.kind, entry.work, entry.profile]), [['producer', 'GY-125', 'producer-a']]);
    assert.deepEqual(ticked.refused, []);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('unit:child-wait-attributed — every cycle step reports its own childWaitMs, the cycle its work net of waits, and the liveness bound judges the work: eighty seconds waiting on gh and eighty seconds computing read differently', async () => {
  // The ledger: overlapping children are one wait, not two, and a drain splits a running child
  // between the steps its wait fell into.
  let tick = 0;
  const ledger = new ChildWaitLedger(() => tick);
  const first = ledger.begin(); tick = 100; const second = ledger.begin(); tick = 300; first(); tick = 500; second();
  assert.equal(ledger.drain(), 500, 'two children in flight from 0 to 500 are five hundred milliseconds of waiting, not eight hundred');
  assert.equal(ledger.drain(), 0);
  const third = ledger.begin(); tick = 800;
  assert.equal(ledger.drain(), 300, 'a child still running is charged for the part of its wait inside the window');
  tick = 1_000; third();
  assert.equal(ledger.drain(), 200, 'and the rest of it goes to the next window');
  // On real children through the runner: two concurrent sleeps are one overlapping wait.
  const metered = new ChildWaitLedger();
  const run = childRunner({ ledger: metered });
  await Promise.all([run(process.execPath, ['-e', 'setTimeout(() => {}, 300)']), run(process.execPath, ['-e', 'setTimeout(() => {}, 300)'])]);
  const waited = metered.drain();
  assert.ok(waited >= 250 && waited < 590, `two concurrent 300ms children are one wait of about 300ms, measured ${waited}ms`);

  // A cycle whose dispatch step spent eighty seconds waiting on a child (a launch) and eight
  // hundred milliseconds of its own work: the step says so, and so does the cycle.
  const { directory, token } = await privateDirectory('graphyard-attributed-');
  try {
    const master = config(token, { run: { intervalSeconds: 20 }, workers: [{ name: 'launch', principal: 'worker-a', agentName: 'agent-launch', mode: 'launch', kind: 'codex', credentialFile: token, agentArgs: [], approvals: 'auto', environment: {} } as WorkerProfile] });
    let now = clock, pending = 0;
    const clockNow = () => now;
    const childWaits = () => { const drained = pending; pending = 0; return drained; };
    const state = emptyDaemonState(master);
    const result = await runCycle(master, state, effects({
      snapshot: async () => ({ work: [work()], now: iso(0) }),
      // The launch: eighty seconds on the clock, all but 800ms of it waiting on the runtime.
      dispatch: async () => { now += 80_000; pending += 79_200; },
      // The deployment step: six seconds of the loop's own work, no child at all.
      observeDeployment: async () => { now += 6_000; return { source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }; },
      childWaits,
    }), clockNow);
    const metrics = result.metrics;
    assert.ok(metrics.steps, 'the cycle records its steps');
    assert.deepEqual(metrics.steps!.dispatch, { ms: 80_000, childWaitMs: 79_200 });
    assert.deepEqual(metrics.steps!.deployment, { ms: 6_000, childWaitMs: 0 });
    assert.equal(metrics.durationMs, 86_000); assert.equal(metrics.childWaitMs, 79_200); assert.equal(metrics.workMs, 6_800);
    assert.deepEqual(Object.keys(metrics.steps!), ['observe', 'close', 'decisions', 'dispatch', 'merge', 'deployment']);
    assert.ok(cycleMetricsSchema.safeParse({ ...metrics, steps: undefined, childWaitMs: undefined, workMs: undefined }).success, 'a cursor written before the loop metered its waits still parses');
    assert.deepEqual(emptyCycleSteps().merge, { ms: 0, childWaitMs: 0 });

    // The cost, against a twenty-second interval: the cycle took 86s but worked for 6.8s, so its
    // work fits the interval and the liveness bound; the wait is named with its step.
    const waiting = cycleCost(metrics, 20_000)!;
    assert.deepEqual({ durationMs: waiting.durationMs, childWaitMs: waiting.childWaitMs, workMs: waiting.workMs, withinInterval: waiting.withinInterval, withinLivenessBound: waiting.withinLivenessBound }, { durationMs: 86_000, childWaitMs: 79_200, workMs: 6_800, withinInterval: true, withinLivenessBound: true });
    assert.deepEqual(waiting.longestWait, { step: 'dispatch', childWaitMs: 79_200 });
    assert.deepEqual(waiting.slowest, { step: 'deployment', ms: 6_000, childWaitMs: 0 }, 'the slowest step is judged on its own work, not its wait');
    assert.match(waiting.breakdown, /^6\.8s of its own work and 79\.2s waiting on child processes; deployment 6s, dispatch 80s \(79\.2s waiting\)/);

    // The same eighty seconds computed rather than waited: past the bound, with a step to shorten.
    const computed = cycleMetricsSchema.parse({ ...metrics, childWaitMs: 0, workMs: 86_000, steps: { ...metrics.steps!, dispatch: { ms: 80_000, childWaitMs: 0 } } });
    const busy = cycleCost(computed, 20_000)!;
    assert.deepEqual({ withinInterval: busy.withinInterval, withinLivenessBound: busy.withinLivenessBound, slowest: busy.slowest, longestWait: busy.longestWait }, { withinInterval: false, withinLivenessBound: false, slowest: { step: 'dispatch', ms: 80_000, childWaitMs: 0 }, longestWait: null });

    // Liveness, sixty seconds after each cycle ended with a twenty-second interval (bound 40s):
    // both loops are inside a slow cycle, not stalled — and the waiting one says the time went to
    // children, the computing one names the step to shorten. Only past the cycle's own length
    // plus the bound is either a stall.
    const lock = { id: 'lock', pid: process.pid, host: 'machine-a', startedAt: iso(0), heartbeatAt: iso(86_000) };
    const after = (cost: typeof metrics, lagMs: number) => loopLiveness({ lock, cycle: 1, lastCycleAt: iso(86_000), metrics: [cost] }, clock + 86_000 + lagMs, 20_000, 'machine-a');
    const waitedLiveness = after(metrics, 60_000);
    assert.equal(waitedLiveness.state, 'slow');
    assert.match(waitedLiveness.detail, /inside a slow cycle, not stalled: its own work fits the bound, and the time went to child processes in the dispatch step/);
    const computedLiveness = after(computed, 60_000);
    assert.equal(computedLiveness.state, 'slow');
    assert.match(computedLiveness.detail, /the dispatch step is the one to shorten/);
    assert.equal(after(metrics, 86_000 + 40_000 + 1).state, 'stalled', 'a lag the cycle no longer explains is a stall');
    assert.equal(loopLiveness({ lock, cycle: 1, lastCycleAt: iso(86_000), metrics: [] }, clock + 86_000 + 60_000, 20_000, 'machine-a').state, 'stalled', 'without a measured cycle the bound stands as before');

    // Attention: a loop still cycling is never told to restart; what it is told depends on where
    // the time went. A cycle whose work fits the interval raises nothing extra once it is running again.
    const waitedAttention = loopAttention({ liveness: waitedLiveness });
    assert.equal(waitedAttention.length, 1);
    assert.match(waitedAttention[0].next, /the time went to child processes in the dispatch step \(79s\), so look at what Herdr, gh or git is slow on rather than restarting/);
    const computedAttention = loopAttention({ liveness: computedLiveness });
    assert.match(computedAttention[0].next, /shorten the dispatch step rather than restarting/);
    assert.deepEqual(loopAttention({ liveness: after(metrics, 5_000) }), [], 'a cycle that waited but whose own work fits the interval is not an overrun');
    const overrun = loopAttention({ liveness: after(computed, 5_000) });
    assert.equal(overrun.length, 1);
    assert.match(overrun[0].text, /^Cycle 0 spent 86s on its own work, longer than the 20s interval and past the two-interval liveness bound of 40s \(86s in all, 0s of it waiting on child processes\)/);
    assert.match(overrun[0].text, /The dispatch step is the slowest, at 80s of work/);

    // Where an operator reads it: `master status` carries the cost beside the metrics, and the
    // cycle budget carries each cycle's waits beside its duration.
    const summary = daemonSummary(state, clock + 86_000 + 1_000, 20_000, 'machine-a');
    assert.deepEqual({ childWaitMs: summary.cost?.childWaitMs, workMs: summary.cost?.workMs, longestWait: summary.cost?.longestWait }, { childWaitMs: 79_200, workMs: 6_800, longestWait: { step: 'dispatch', childWaitMs: 79_200 } });
    assert.deepEqual(summary.liveness.cost?.steps?.dispatch, { ms: 80_000, childWaitMs: 79_200 });
    const budget = cycleBudget(state, 20_000);
    assert.deepEqual(budget.lastCycle, { cycle: 0, at: metrics.at, durationMs: 86_000, childWaitMs: 79_200, workMs: 6_800 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
