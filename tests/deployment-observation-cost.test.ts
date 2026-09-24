import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cycleCost, daemonSummary, emptyDaemonState, loopAttention, loopLiveness, maxDeploymentRequests, observeDeployment, runCycle, type ContainmentRetention, type CycleSteps, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig, type MasterRun } from '../src/master.js';
import type { Work } from '../src/model.js';

/**
 * What the loop's deployment step costs. Containment — "does the release production serves contain
 * this delivery's merge commit" — used to be one GitHub compare per delivered item on every cycle,
 * so the cycle grew with the delivery history until it no longer fit its interval. These are the
 * two readings that keep it bounded: the GitHub requests one observation makes, and the containment
 * it does not derive twice. The third is the cycle saying where its own time went.
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
    dependencies: [], criteria: [], policy: { checks: ['test'], review: true }, plannedFiles: [],
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
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-deployment-cost-'));
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

test('unit:deployment-check-bounded-requests — deployment observation derives containment from one base-branch fetch and local ancestry, so its GitHub requests stay under a documented constant over 150 delivered items', async () => {
  const fixture = await deliveredHistory(150);
  try {
    await writeFile(fixture.token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const master = config(fixture.token);
    const release = fixture.shas[139];
    const calls: string[] = [];
    const run = (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'git') return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (command !== 'gh') throw new Error(`the observation ran ${command}, which is neither git nor the GitHub CLI`);
      if (args[1].includes('/deployments?')) return JSON.stringify([{ id: 9, sha: release }]);
      if (args[1].includes('/deployments/9/statuses')) return JSON.stringify([{ state: 'success' }]);
      throw new Error(`unexpected GitHub request: ${args.join(' ')}`);
    };

    const observation = await observeDeployment(master, fixture.delivered, run, fetch, () => clock, { root: fixture.checkout });
    assert.equal(observation.source, 'github-deployment');
    assert.equal(observation.sha, release);
    // The answer itself is unchanged: every merge the release contains is deployed, the rest pending.
    assert.equal(observation.deployed.length, 140);
    assert.equal(observation.pending.length, 10);
    assert.deepEqual(observation.pending, fixture.delivered.slice(140).map(item => item.key));
    assert.equal(observation.reason, null, 'the base branch was fetched, so nothing was derived from a stale checkout');

    const github = calls.filter(entry => entry.startsWith('gh '));
    assert.equal(github.length, 2, 'one deployment listing and one status listing, whatever the delivery history holds');
    assert.equal(observation.requests, github.length, 'the observation reports what it cost');
    assert.ok(observation.requests! <= maxDeploymentRequests, `${observation.requests} GitHub requests is within the documented bound of ${maxDeploymentRequests}`);
    assert.equal(github.filter(entry => entry.includes('/compare/')).length, 0, 'containment is no longer a compare per delivered item');
    assert.equal(calls.filter(entry => entry.includes(' fetch ')).length, 1, 'one fetch of the base branch');
    assert.equal(calls.filter(entry => entry.includes(' merge-base ')).length, 149, 'containment is derived locally, one ancestry check per delivery this loop has not settled; the release\'s own merge needs none');
    assert.equal(observation.derived, 150, 'every delivery was derived this pass');
    assert.equal(observation.retained, 0, 'nothing was retained before the first observation');
    assert.equal(observation.derived! + observation.retained!, fixture.delivered.length, 'derived and retained partition the deliveries');

    // The bound is independent of the history: three hundred deliveries cost the same two requests.
    const doubled = [...fixture.delivered, ...fixture.delivered.map((item, index) => delivery(`GY-${151 + index}`, item.delivery!.mergeSha, iso(index * 60_000)))];
    const second = await observeDeployment(master, doubled, run, fetch, () => clock, { root: fixture.checkout });
    assert.equal(second.requests, 2, 'twice the deliveries, the same GitHub cost');
    assert.ok(second.requests! <= maxDeploymentRequests);

    // A configured deployment endpoint reaches GitHub not at all.
    const endpoint = config(fixture.token, { run: { intervalSeconds: 20, deploymentUrl: 'https://app.example/version', deploymentShaField: 'build.commit' } });
    const fetcher = (async () => new Response(JSON.stringify({ build: { commit: release.toUpperCase() } }))) as typeof fetch;
    const fromEndpoint = await observeDeployment(endpoint, fixture.delivered, run, fetcher, () => clock, { root: fixture.checkout });
    assert.equal(fromEndpoint.sha, release);
    assert.equal(fromEndpoint.requests, 0, 'an endpoint that reports the release costs no GitHub request at all');
    assert.equal(fromEndpoint.deployed.length, 140);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('unit:deployment-containment-retained — a delivery the release was shown to serve is not derived again while the deployed SHA holds or advances, and each retained answer keeps the release it was established against', async () => {
  const fixture = await deliveredHistory(150);
  try {
    await writeFile(fixture.token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const master = config(fixture.token);
    const first = fixture.shas[139], advanced = fixture.shas[149];
    let release = first;
    const calls: string[] = [];
    const run = (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'git') return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (args[1].includes('/deployments?')) return JSON.stringify([{ id: 9, sha: release }]);
      if (args[1].includes('/deployments/9/statuses')) return JSON.stringify([{ state: 'success' }]);
      throw new Error(`unexpected GitHub request: ${args.join(' ')}`);
    };
    const ancestryFor = (from: number) => calls.slice(from).filter(entry => entry.includes(' merge-base '));
    const observe = (retained: ContainmentRetention | null) => observeDeployment(master, fixture.delivered, run, fetch, () => clock, { root: fixture.checkout, retained });

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
    requestProof: () => {},
    merge: async () => ({ result: 'merge requested' }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
    ...overrides,
  };
}

test('integration:cycle-time-attributed — the cycle reports where its time went, and a deployment step that outgrows the interval is named as that step rather than reported as a stalled loop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-cycle-cost-'));
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
    assert.match(attention[0].text, /The deployment step is the slowest, at 80s of work/);
    assert.match(attention[0].next, /shorten the deployment step rather than restarting a loop that is still cycling/);
    assert.equal(attention[0].human, false);

    // Mid-cycle, past the two-interval liveness bound, the measured cycle explains the silence:
    // the loop is slow at a named step, not stalled, and the remedy is not a restart.
    const midCycle = running + 50_000;
    const slow = loopLiveness(state, midCycle, intervalMs, master.hostId);
    assert.equal(slow.state, 'slow');
    assert.match(slow.detail, /past the two-interval bound of 40s, but cycle 0 took 80s of its own: .*deployment 80s/);
    assert.match(slow.detail, /inside a slow cycle, not stalled; the deployment step is the one to shorten/);
    const slowItems = loopAttention({ liveness: slow });
    assert.equal(slowItems.length, 1, 'the slow cycle is one attention item, not a stall and a cost');
    assert.match(slowItems[0].text, /deployment 80s/);
    assert.match(slowItems[0].next, /shorten the deployment step/);
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

test('unit:deployment-source-is-a-release — the observation takes the newest successful base-branch release, never the CI reporting environment or another branch', async () => {
  const fixture = await deliveredHistory(3);
  try {
    await writeFile(fixture.token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const [old, , release] = fixture.shas;
    // As GitHub listed them on 2026-09-24: Railway records its release with the commit SHA as ref;
    // CI proof reporting records deployments on branches and on main; neither is a release.
    const listed = [
      { id: 1, sha: 'b'.repeat(40), ref: 'graphyard/gy-9-1', environment: 'graphyard-reporting' },
      { id: 2, sha: release, ref: release, environment: 'graphyard / production' },
      { id: 3, sha: old, ref: 'main', environment: 'graphyard-reporting' },
    ];
    const run = (command: string, args: string[]) => {
      if (command === 'git') return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (args[1].includes('/deployments?')) { assert.doesNotMatch(args[1], /ref=/, 'the listing is not filtered by ref'); return JSON.stringify(listed); }
      if (/\/deployments\/\d+\/statuses/.test(args[1])) return JSON.stringify([{ state: 'success' }]);
      throw new Error(`unexpected GitHub request: ${args.join(' ')}`);
    };
    const observation = await observeDeployment(config(fixture.token), fixture.delivered, run, fetch, () => clock, { root: fixture.checkout });
    assert.equal(observation.source, 'github-deployment');
    assert.equal(observation.sha, release, 'the Railway release, not the reporting record on main');
    assert.deepEqual(observation.pending, []);
    // A SHA-ref deployment of a commit that is not on the base branch is not a release.
    listed[1] = { id: 2, sha: 'c'.repeat(40), ref: 'c'.repeat(40), environment: 'graphyard / production' };
    const offBranch = await observeDeployment(config(fixture.token), fixture.delivered, run, fetch, () => clock, { root: fixture.checkout });
    assert.equal(offBranch.source, 'unavailable', 'nothing on the list is a release of the base branch');
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
