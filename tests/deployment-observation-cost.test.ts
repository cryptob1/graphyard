import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cycleCost, daemonSummary, emptyDaemonState, loopAttention, loopLiveness, observeDeployment, runCycle, type ContainmentRetention, type CycleSteps, type DaemonEffects } from '../src/master-daemon.js';
import * as deploymentModule from '../src/daemon/deployment.js';
import { masterConfigSchema, masterSettingsFromArgs, type MasterConfig, type MasterRun } from '../src/master.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * What the loop's deployment step costs. Containment — "does the release production serves contain
 * this delivery's merge commit" — used to be one GitHub compare per delivered item on every cycle,
 * so the cycle grew with the delivery history until it no longer fit its interval. The release is
 * now read from the configured deployment endpoint alone, and containment is never derived twice. The third is the cycle saying where its own time went.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function config(credentialFile: string, overrides: Partial<Omit<MasterConfig, 'run'>> & { run?: Partial<MasterRun> } = {}): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], ...overrides });
}

function delivery(key: string, mergeSha: string, mergedAt: string): Work {
  return {
    id: `id-${key}`, key, title: key, description: '', type: 'feature', priority: 1,
    dependencies: [], criteria: [], policy: { checks: ['test'], review: true }, 
    stage: 'done', revision: 3, policyRevision: 1, createdAt: mergedAt, updatedAt: mergedAt, stageEnteredAt: mergedAt,
    ready: false, epoch: 1, lease: null, workspaces: [], candidate: null, submission: { epoch: 1, pr: 1 },
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [], delivery: { mergedAt, mergeSha, authorizationRevision: 1 },
  } as unknown as Work;
}

/**
 * A real repository with one merge commit per delivery, and a checkout of it that the observation
 * derives ancestry in. Nothing here is mocked: `git merge-base --is-ancestor` answers over the
 * object store exactly as it does on the coordinator host.
 */
async function deliveredHistory(commits: number) {
  const directory = await temporaryDirectory('deployment-cost');
  const origin = join(directory, 'origin'), checkout = join(directory, 'checkout');
  execFileSync('git', ['init', '-q', '-b', 'main', origin]);
  git(origin, 'config', 'user.email', 'loop@graphyard.example');
  git(origin, 'config', 'user.name', 'Graphyard');
  for (let index = 1; index <= commits; index++) git(origin, 'commit', '--allow-empty', '-q', '-m', `GY-${index}: delivered`);
  const shas = git(origin, 'rev-list', '--reverse', 'main').split('\n');
  assert.equal(shas.length, commits);
  execFileSync('git', ['clone', '-q', origin, checkout]);
  const delivered = shas.map((sha, index) => delivery(`GY-${index + 1}`, sha, iso(index * 60_000)));
  return { directory, checkout, shas, delivered, token: join(directory, 'coordinator.token') };
}

test('unit:deployment-check-bounded-requests — deployment observation reads the release from the configured endpoint and derives containment from one base-branch fetch and local ancestry, asking GitHub nothing over 150 delivered items', async () => {
  const fixture = await deliveredHistory(150);
  try {
    await writeFile(fixture.token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const release = fixture.shas[139];
    const calls: string[] = [];
    const run = (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'git') return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      throw new Error(`the observation ran ${command} ${args.join(' ')}, which is not git`);
    };
    const endpoint = config(fixture.token, { run: { intervalSeconds: 20, deploymentUrl: 'https://app.example/version', deploymentShaField: 'build.commit' } });
    const fetcher = (async () => new Response(JSON.stringify({ build: { commit: release.toUpperCase() } }))) as typeof fetch;
    const observation = await observeDeployment(endpoint, fixture.delivered, run, fetcher, () => clock, { root: fixture.checkout });
    assert.equal(observation.source, 'endpoint');
    assert.equal(observation.sha, release);
    assert.equal(observation.deployed.length, 140);
    assert.deepEqual(observation.pending, fixture.delivered.slice(140).map(item => item.key));
    assert.equal(observation.reason, null, 'the base branch was fetched, so nothing was derived from a stale checkout');
    assert.equal(observation.requests, 0);
    assert.equal(calls.filter(entry => !entry.startsWith('git ')).length, 0, 'nothing but git is run');
    assert.equal(calls.filter(entry => entry.includes(' fetch ')).length, 1, 'one fetch of the base branch');
    assert.equal(calls.filter(entry => entry.includes(' merge-base ')).length, 149, 'one ancestry check per delivery; the release\'s own merge needs none');
    assert.equal(observation.derived! + observation.retained!, fixture.delivered.length, 'derived and retained partition the deliveries');

    // Without an endpoint the release is unknown: nothing is read from GitHub and every delivery stays pending.
    const none = await observeDeployment(config(fixture.token), fixture.delivered, run, fetcher, () => clock, { root: fixture.checkout });
    assert.equal(none.source, 'unavailable');
    assert.match(none.reason!, /No deployment endpoint is configured/);
    assert.equal(none.pending.length, 150);
    assert.equal(calls.filter(entry => !entry.startsWith('git ')).length, 0);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('unit:deployment-containment-retained — a delivery the release was shown to serve is not derived again while the deployed SHA holds or advances, and each retained answer keeps the release it was established against', async () => {
  const fixture = await deliveredHistory(150);
  try {
    await writeFile(fixture.token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const master = config(fixture.token, { run: { intervalSeconds: 20, deploymentUrl: 'https://app.example/version', deploymentShaField: 'commit' } });
    const first = fixture.shas[139], advanced = fixture.shas[149];
    let release = first;
    const calls: string[] = [];
    const run = (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'git') return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    };
    const fetcher = (async () => new Response(JSON.stringify({ commit: release }))) as typeof fetch;
    const ancestryFor = (from: number) => calls.slice(from).filter(entry => entry.includes(' merge-base '));
    const observe = (retained: ContainmentRetention | null) => observeDeployment(master, fixture.delivered, run, fetcher, () => clock, { root: fixture.checkout, retained });

    // Cycle one settles 140 deliveries against the release that serves them.
    const one = await observe(null);
    assert.equal(one.derived, 150);
    assert.equal(one.containment!.release, first);
    assert.equal(Object.keys(one.containment!.settled).length, 140);
    assert.equal(one.containment!.settled['GY-1'], first);

    // Cycle two, same deployed SHA: no containment work for anything cycle one settled.
    const beforeTwo = calls.length;
    const two = await observe(one.containment!);
    assert.equal(two.retained, 140, 'every settled delivery is answered from the retained record');
    assert.equal(two.derived, 10, 'only the deliveries the release does not serve yet are looked at again');
    assert.deepEqual(two.deployed, one.deployed);
    assert.deepEqual(two.pending, one.pending);
    const settledMerges = new Set(fixture.delivered.slice(0, 140).map(item => item.delivery!.mergeSha));
    // `git merge-base --is-ancestor MERGE RELEASE`: the merge asked about is the first argument.
    const askedAbout = (entry: string) => entry.split(' --is-ancestor ')[1]?.split(' ')[0];
    assert.equal(ancestryFor(beforeTwo).length, 10, 'ten ancestry checks, one per delivery still pending');
    assert.equal(ancestryFor(beforeTwo).filter(entry => settledMerges.has(askedAbout(entry))).length, 0, 'nothing the first cycle settled is derived again');

    // Cycle three at a release that descends from the retained one: one ancestry check carries the
    // whole retained set, and each entry keeps the release its containment was established against.
    release = advanced;
    const beforeThree = calls.length;
    const three = await observe(two.containment!);
    assert.equal(three.retained, 140);
    assert.equal(three.derived, 10);
    assert.equal(three.deployed.length, 150, 'the advanced release serves everything');
    assert.equal(three.containment!.release, advanced);
    assert.equal(three.containment!.settled['GY-1'], first, 'the release a delivery was first shown to serve is not rewritten by a later one');
    assert.equal(three.containment!.settled['GY-150'], advanced, 'a delivery settled on this release records this release');
    assert.equal(ancestryFor(beforeThree).length, 10, 'one check revalidates the retained set; the rest are the deliveries it did not cover, less the release\'s own merge');

    // A release the retained one does not lead to — a rollback, an unrelated commit — is not
    // allowed to inherit anything: every delivery is derived again.
    release = fixture.shas[129];
    const beforeFour = calls.length;
    const four = await observe(three.containment!);
    assert.equal(four.retained, 0, 'a release that does not descend from the retained one retains nothing');
    assert.equal(four.derived, 150);
    assert.equal(four.deployed.length, 130);
    assert.ok(ancestryFor(beforeFour).length >= 150);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

function cycleEffects(overrides: Partial<DaemonEffects> = {}): DaemonEffects {
  return {
    agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: [], now: iso(0) }),
    closeSession: () => {},
    dispatch: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    persist: async () => {},
    ...overrides,
  };
}

test('integration:cycle-time-attributed — the cycle reports where its time went, and a deployment step that outgrows the interval is named as that step rather than reported as a stalled loop', async () => {
  const directory = await temporaryDirectory('cycle-cost');
  try {
    const token = join(directory, 'coordinator.token');
    await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const master = config(token);
    const intervalMs = master.run.intervalSeconds * 1000;
    assert.equal(intervalMs, 20_000);
    const state = emptyDaemonState(master);
    state.lock = { id: 'lock', pid: process.pid, host: master.hostId, startedAt: iso(0), heartbeatAt: iso(0) };
    // A cycle whose deployment step takes eighty seconds against a twenty-second interval.
    let running = clock;
    const now = () => running;
    const delivered = delivery('GY-1', 'a'.repeat(40), iso(-60_000));
    const result = await runCycle(master, state, cycleEffects({
      snapshot: async () => ({ work: [delivered], now: iso(0) }),
      observeDeployment: async () => { running += 80_000; return { source: 'endpoint', sha: 'a'.repeat(40), at: iso(0), reason: null, deployed: ['GY-1'], pending: [], requests: 0, derived: 0, retained: 1 }; },
    }), now);

    // The breakdown is on the cycle's own measurement, step by step.
    assert.deepEqual(Object.keys(result.metrics.steps!).sort(), ['close', 'decisions', 'deployment', 'dispatch', 'merge', 'observe']);
    assert.deepEqual(result.metrics.steps!.deployment, { ms: 80_000, childWaitMs: 0 });
    assert.equal(result.metrics.durationMs, 80_000);
    assert.equal(result.metrics.steps!.merge.ms, 0);
    assert.equal(result.metrics.workMs, 80_000, 'the deployment step computed: nothing was waiting on a child');

    const cost = cycleCost(result.metrics, intervalMs)!;
    assert.deepEqual(cost.slowest, { step: 'deployment', ms: 80_000, childWaitMs: 0 });
    assert.equal(cost.withinInterval, false);
    assert.equal(cost.withinLivenessBound, false);
    assert.match(cost.breakdown, /waiting on child processes; deployment 80s,/);

    // `master status` reads it from the daemon summary, against the interval it is judged on.
    const summary = daemonSummary(state, running, intervalMs, master.hostId);
    assert.equal(summary.cost!.steps!.deployment.ms, 80_000);
    assert.equal(summary.cost!.durationMs, 80_000);
    assert.equal(summary.cost!.intervalMs, intervalMs);
    assert.equal(summary.metrics!.steps!.deployment.ms, 80_000);

    // A cycle that finished is running, and the cost is still raised, naming the step.
    const attention = loopAttention({ liveness: summary.liveness, cost: summary.cost });
    assert.equal(summary.liveness.state, 'running');
    assert.equal(attention.length, 1);
    assert.equal(attention[0].subject, 'loop');
    assert.match(attention[0].text, /Cycle 0 spent 80s on its own work, longer than the 20s interval/);
    assert.match(attention[0].text, /deployment 80s/);
    assert.match(attention[0].text, /The deployment verification step is the slowest timed step, at 80s/);
    assert.match(attention[0].next, /shorten the deployment verification step rather than restarting a loop that is still cycling/);
    assert.equal(attention[0].human, false);

    // Mid-cycle, past the two-interval liveness bound, the measured cycle explains the silence:
    // the loop is slow at a named step, not stalled, and the remedy is not a restart.
    const midCycle = running + 50_000;
    const slow = loopLiveness(state, midCycle, intervalMs, master.hostId);
    assert.equal(slow.state, 'slow');
    assert.match(slow.detail, /past the two-interval bound of 40s, but cycle 0 took 80s of its own: .*deployment 80s/);
    assert.match(slow.detail, /inside a slow cycle, not stalled; the deployment verification step is the one to shorten/);
    const slowItems = loopAttention({ liveness: slow });
    assert.equal(slowItems.length, 1, 'the slow cycle is one attention item, not a stall and a cost');
    assert.match(slowItems[0].text, /deployment 80s/);
    assert.match(slowItems[0].next, /shorten the deployment verification step/);
    assert.equal(/is stalled/.test(slowItems[0].text), false);

    // Past that cycle's own cost, nothing explains the silence any more: it is a stall again.
    const abandoned = loopLiveness(state, running + 80_000 + 40_001, intervalMs, master.hostId);
    assert.equal(abandoned.state, 'stalled');
    assert.match(abandoned.detail, /is stalled/);

    // A cycle inside its interval raises nothing at all.
    const quick = { ...result.metrics, cycle: 1, durationMs: 4_000, childWaitMs: 0, workMs: 4_000, steps: Object.fromEntries(Object.entries({ observe: 1_000, close: 500, decisions: 500, dispatch: 1_000, merge: 500, deployment: 500 }).map(([step, ms]) => [step, { ms, childWaitMs: 0 }])) as CycleSteps };
    const quickCost = cycleCost(quick, intervalMs)!;
    assert.equal(quickCost.withinInterval, true);
    state.lastCycleAt = new Date(running).toISOString();
    assert.deepEqual(loopAttention({ liveness: loopLiveness({ ...state, metrics: [quick] }, running + 5_000, intervalMs, master.hostId), cost: quickCost }), []);

    // A deployment step whose eighty seconds went waiting on gh or git is named as the step that
    // waited, not as work to shorten: the child-wait meter is drained at the step boundary.
    let waited = 0;
    const waiting = emptyDaemonState(master);
    waiting.lock = state.lock;
    const slowProvider = await runCycle(master, waiting, cycleEffects({
      snapshot: async () => ({ work: [delivered], now: iso(0) }),
      childWaits: () => { const drained = waited; waited = 0; return drained; },
      observeDeployment: async () => { running += 80_000; waited = 80_000; return { source: 'endpoint', sha: 'a'.repeat(40), at: iso(0), reason: null, deployed: ['GY-1'], pending: [], requests: 0, derived: 0, retained: 1 }; },
    }), now);
    assert.deepEqual(slowProvider.metrics.steps!.deployment, { ms: 80_000, childWaitMs: 80_000 });
    const waitingLiveness = loopLiveness(waiting, running + 50_000, intervalMs, master.hostId);
    assert.equal(waitingLiveness.state, 'slow');
    assert.deepEqual(waitingLiveness.cost!.longestWait, { step: 'deployment', childWaitMs: 80_000 });
    const waitingItems = loopAttention({ liveness: waitingLiveness });
    assert.equal(waitingItems.length, 1);
    assert.match(waitingItems[0].text, /the time went to child processes in the deployment step/);
    assert.match(waitingItems[0].next, /in the deployment step \(80s\)/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function drive<T>(running: Promise<T>, stepMs = 500): Promise<T> {
  let settled = false;
  running.then(() => { settled = true; }, () => { settled = true; });
  for (let turns = 0; !settled && turns < 20_000; turns++) { await new Promise(resolve => setImmediate(resolve)); if (!settled) mock.timers.tick(stepMs); }
  return running;
}

test('unit:deployment-step-cycle-budget — a release-landing verification slower than the budget is left in flight and resumed, not polled inline: every cycle fits its interval, one read is in flight, and the delivery is verified served once it lands', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: clock });
  try {
    const master = config('/outside/coordinator.token', { run: { intervalSeconds: 300 } as Partial<MasterRun> });
    const intervalMs = 300_000, budgetMs = deploymentModule.deploymentStepBudgetMs(intervalMs);
    assert.equal(budgetMs, 60_000, 'a fifth of the 300s interval');
    assert.equal(deploymentModule.deploymentStepBudgetMs(20_000), 30_000, 'never under the 30s actionable cadence');
    const state = emptyDaemonState(master);
    const delivered = delivery('GY-1', 'a'.repeat(40), iso(-60_000)), sha = 'a'.repeat(40);
    // The last verified observation, which must stand while the next one is in flight.
    state.deployment = { source: 'endpoint', sha: 'b'.repeat(40), at: iso(-600_000), reason: null, deployed: [], pending: ['GY-1'], requests: 0, derived: 1, retained: 0, containment: null };
    let reads = 0, inFlight = 0, maxInFlight = 0;
    const effects = cycleEffects({
      snapshot: async () => ({ work: [delivered], now: new Date(Date.now()).toISOString() }),
      // Cycle 12624's shape: the observation takes 587.1s to answer.
      observeDeployment: () => { reads++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise(resolve => setTimeout(() => { inFlight--; resolve({ source: 'endpoint', sha, at: new Date(Date.now()).toISOString(), reason: null, deployed: ['GY-1'], pending: [], requests: 0, derived: 1, retained: 0 }); }, 587_100)); },
    });
    const first = await drive(runCycle(master, state, effects, () => Date.now()));
    const cost = cycleCost(first.metrics, intervalMs)!;
    assert.ok(cost.withinInterval && cost.withinLivenessBound, `the cycle fits: ${cost.breakdown}`);
    assert.ok(first.metrics.steps!.deployment.ms <= budgetMs + 1_000, `the step stopped at its budget: ${first.metrics.steps!.deployment.ms}ms`);
    assert.equal(state.deployment!.sha, 'b'.repeat(40), 'the last verified observation stands');
    assert.deepEqual(state.deployment!.pending, ['GY-1']);
    assert.equal(deploymentModule.deploymentReadsPending(state), 1, 'the cut read is kept in flight');
    assert.match(state.actions['deployment:deferred']?.detail ?? '', /spent its 60s budget before the release observation finished, so the last verified observation stands/);
    // Cycles go on at the actionable cadence; none waits on the read again, none starts another.
    for (let cycles = 0; cycles < 30 && deploymentModule.deploymentReadsPending(state); cycles++) {
      mock.timers.tick(30_000);
      const before = Date.now();
      const next = await drive(runCycle(master, state, effects, () => Date.now()));
      assert.ok(Date.now() - before <= 5_000, `a cycle finding the read in flight does not wait on it: ${Date.now() - before}ms`);
      assert.ok(cycleCost(next.metrics, intervalMs)!.withinInterval);
    }
    assert.equal(reads, 1, 'the answer of the read in flight is taken, not read again');
    assert.equal(maxInFlight, 1);
    assert.equal(deploymentModule.deploymentReadsPending(state), 0, 'a taken answer frees its slot');
    // The verification is still correct once it lands: the delivery is verified served.
    assert.equal(state.deployment!.sha, sha);
    assert.deepEqual(state.deployment!.deployed, ['GY-1']);
    assert.match(state.actions['deployment:deferred'].detail, /^The deployment step verified within its budget/);
    // A fast observation answers in the cycle that asked, with nothing deferred.
    mock.timers.tick(30_000);
    const fast = emptyDaemonState(master);
    await drive(runCycle(master, fast, cycleEffects({ snapshot: async () => ({ work: [delivered], now: new Date(Date.now()).toISOString() }),
      observeDeployment: async () => ({ source: 'endpoint', sha, at: new Date(Date.now()).toISOString(), reason: null, deployed: ['GY-1'], pending: [], requests: 0, derived: 1, retained: 0 }) }), () => Date.now()));
    assert.deepEqual(fast.deployment!.deployed, ['GY-1']);
    assert.equal(fast.actions['deployment:deferred'], undefined);
  } finally { mock.timers.reset(); }
});

test('unit:deployment-step-cycle-budget — a failed observation still lands as unavailable in the cycle that asked', async () => {
  const master = config('/outside/coordinator.token');
  const state = emptyDaemonState(master);
  const delivered = delivery('GY-1', 'a'.repeat(40), iso(-60_000));
  await runCycle(master, state, cycleEffects({ snapshot: async () => ({ work: [delivered], now: iso(0) }), observeDeployment: async () => { throw new Error('gh: timed out'); } }), () => clock);
  assert.equal(state.deployment!.source, 'unavailable');
  assert.match(state.deployment!.reason ?? '', /gh: timed out/);
  assert.equal(deploymentModule.deploymentReadsPending(state), 0);
});

// ——— GY-1398: an idle cycle reuses its verified observation and windows the promotion reads ———

const verifiedAt = (at: string, deployed: string[], sha = 'a'.repeat(40)) => ({ source: 'github-deployment' as const, sha, at, reason: null, deployed, pending: [], requests: 2, derived: 0, retained: deployed.length,
  containment: { release: sha, settled: Object.fromEntries(deployed.map(key => [key, sha])) } });

test('unit:deployment-observation-reuse — a verified observation younger than the window that already serves every delivery stands unchanged, and the cycle starts no release read', async () => {
  const master = config('/outside/coordinator.token', { run: { intervalSeconds: 300 } as Partial<MasterRun> });
  assert.equal(deploymentModule.defaultDeploymentReuseMinutes, 15);
  const state = emptyDaemonState(master);
  const delivered = [delivery('GY-1', 'a'.repeat(40), iso(-120_000)), delivery('GY-2', 'b'.repeat(40), iso(-60_000))];
  state.deployment = verifiedAt(iso(-5 * 60_000), ['GY-1', 'GY-2']);
  const before = structuredClone(state.deployment);
  let reads = 0;
  const result = await runCycle(master, state, cycleEffects({ snapshot: async () => ({ work: delivered, now: iso(0) }), observeDeployment: async () => { reads++; throw new Error('the observation must not be read'); } }), () => clock);
  assert.equal(reads, 0, 'no release observation is started: no GitHub deployment call this cycle');
  assert.equal(deploymentModule.deploymentReadsPending(state), 0, 'nothing is left in flight either');
  assert.deepEqual(state.deployment, before, 'state.deployment stands unchanged');
  assert.equal(result.actions.some(action => action.kind === 'deployment'), false, 'nothing is recorded: the answer did not change');
  // Retained containment places a delivery the bounded deployed set no longer lists.
  const retainedOnly = { ...verifiedAt(iso(-60_000), ['GY-2']), containment: { release: 'a'.repeat(40), settled: { 'GY-1': 'c'.repeat(40), 'GY-2': 'a'.repeat(40) } } };
  assert.equal(deploymentModule.reusableDeployment(retainedOnly, delivered, clock, 15 * 60_000), true);
});

test('unit:deployment-observation-reuse-expiry — the reuse expires at the window (15 min by default, run.deploymentReuseMinutes otherwise); an expired window, a delivery missing from the deployed set, a pending delivery or an unavailable observation reads live', async () => {
  const delivered = [delivery('GY-1', 'a'.repeat(40), iso(-120_000))];
  const reads = async (run: Partial<MasterRun>, last: ReturnType<typeof verifiedAt> | Record<string, unknown>, work = delivered) => {
    const master = config('/outside/coordinator.token', { run: { intervalSeconds: 300, ...run } as Partial<MasterRun> });
    const state = emptyDaemonState(master);
    state.deployment = last as typeof state.deployment;
    let count = 0;
    await runCycle(master, state, cycleEffects({ snapshot: async () => ({ work, now: iso(0) }),
      observeDeployment: async () => { count++; return { ...verifiedAt(iso(0), work.map(item => item.key)) }; } }), () => clock);
    return { count, state };
  };
  const window = 15 * 60_000;
  assert.equal((await reads({}, verifiedAt(iso(-window + 1_000), ['GY-1']))).count, 0, 'inside the default window: reused');
  const expired = await reads({}, verifiedAt(iso(-window), ['GY-1']));
  assert.equal(expired.count, 1, 'at the window: read live');
  assert.equal(expired.state.deployment!.at, iso(0), 'and the live answer replaces the expired one');
  assert.equal((await reads({ deploymentReuseMinutes: 5 }, verifiedAt(iso(-6 * 60_000), ['GY-1']))).count, 1, 'a configured 5-minute window expires at 5 minutes');
  assert.equal((await reads({ deploymentReuseMinutes: 30 }, verifiedAt(iso(-20 * 60_000), ['GY-1']))).count, 0, 'a configured 30-minute window still reuses at 20');
  assert.equal((await reads({ deploymentReuseMinutes: 0 }, verifiedAt(iso(-1_000), ['GY-1']))).count, 1, '0 reads live every cycle');
  const landed = [...delivered, delivery('GY-2', 'b'.repeat(40), iso(-10_000))];
  assert.equal((await reads({}, verifiedAt(iso(-60_000), ['GY-1']), landed)).count, 1, 'a delivery missing from the deployed set: read live');
  assert.equal((await reads({}, { ...verifiedAt(iso(-60_000), ['GY-1']), pending: ['GY-0'] })).count, 1, 'a pending delivery: read live');
  assert.equal((await reads({}, { source: 'unavailable', sha: null, at: iso(-60_000), reason: 'gh: timed out', deployed: [], pending: ['GY-1'], containment: null })).count, 1, 'an unavailable observation: read live');
  assert.equal((await reads({}, { ...verifiedAt(iso(-60_000), ['GY-1']), sha: null })).count, 1, 'an observation without a release: read live');
  // The window is a run setting the master may change.
  assert.deepEqual(masterSettingsFromArgs(['deploymentReuseMinutes=5']), { deploymentReuseMinutes: 5 });
  assert.equal(masterConfigSchema.parse({ ...config('/outside/coordinator.token'), run: { deploymentReuseMinutes: 5 } }).run.deploymentReuseMinutes, 5);
});

test('unit:deployment-step-idle-cycle-cost — on a two-cycle replay with an unchanged release the second cycle\'s deployment bucket is under 5s and the whole cycle under 30s, while a cycle whose newest delivery is pending still reads live', async () => {
  const master = config('/outside/coordinator.token', { run: { intervalSeconds: 300 } as Partial<MasterRun> });
  const state = emptyDaemonState(master);
  state.lock = { id: 'lock', pid: process.pid, host: master.hostId, startedAt: iso(0), heartbeatAt: iso(0) };
  let running = clock, observations = 0;
  const now = () => running;
  let work = [delivery('GY-1', 'a'.repeat(40), iso(-120_000)), delivery('GY-2', 'b'.repeat(40), iso(-60_000))];
  // The measured cost of cycle 12874: the listing and GraphQL status read ~9s.
  const effects = cycleEffects({
    snapshot: async () => ({ work, now: new Date(running).toISOString() }),
    observeDeployment: async delivered => { observations++; running += 9_000;
      const deployed = delivered.filter(item => item.key !== 'GY-3').map(item => item.key), pending = delivered.filter(item => item.key === 'GY-3').map(item => item.key);
      return { ...verifiedAt(new Date(running).toISOString(), deployed), pending }; },
  });
  const first = await runCycle(master, state, effects, now);
  assert.equal(observations, 1);
  assert.ok(first.metrics.steps!.deployment.ms >= 9_000, `the first cycle reads live: ${first.metrics.steps!.deployment.ms}ms`);
  running += 300_000;
  const second = await runCycle(master, state, effects, now);
  assert.equal(observations, 1, 'the unchanged release is not read again');
  assert.ok(second.metrics.steps!.deployment.ms < 5_000, `deployment bucket ${second.metrics.steps!.deployment.ms}ms`);
  assert.ok(second.metrics.durationMs < 30_000, `the whole cycle stays under the 30s cycle-p90 bound: ${second.metrics.durationMs}ms`);
  assert.ok(Object.values(second.metrics.steps!).reduce((sum, step) => sum + step.ms, 0) < 30_000);
  // A new delivery the release does not serve yet is read live, and stays read live while pending.
  work = [...work, delivery('GY-3', 'c'.repeat(40), new Date(running).toISOString())];
  running += 300_000;
  await runCycle(master, state, effects, now);
  assert.equal(observations, 2, 'the newest delivery is read live');
  assert.deepEqual(state.deployment!.pending, ['GY-3']);
  running += 300_000;
  await runCycle(master, state, effects, now);
  assert.equal(observations, 3, 'a pending delivery keeps the read live');
});
