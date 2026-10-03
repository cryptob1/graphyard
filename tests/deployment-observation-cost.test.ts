import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cycleCost, daemonSummary, deploymentListingPages, deploymentPageSize, emptyDaemonState, loopAttention, loopLiveness, maxDeploymentRequests, observeDeployment, runCycle, type ContainmentRetention, type CycleSteps, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, masterSettingsFromArgs, type MasterConfig, type MasterRun } from '../src/master.js';
import type { Work } from '../src/model.js';
import { deploymentStep } from '../src/daemon/cycle-delivery.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { ChildRun } from '../src/child-runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

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

/** GitHub's deployment listing: each record carries its node id, which the status read asks by. */
const listing = (records: object[]) => JSON.stringify(records.map(record => ({ node_id: `DE_${(record as { id: number }).id}`, ...record })));
/** The deployment ids a batched GraphQL status read asks about, or null when the request is another one. */
const statusRead = (args: string[]) => args[1] === 'graphql' ? (JSON.parse(/nodes\(ids: (\[[^\]]*\])/.exec(args[3])![1]) as string[]).map(id => Number(id.slice(3))) : null;
/** GitHub's answer to that read; a null state is a node GitHub did not return. */
const statusAnswer = (ids: number[], state: (id: number) => string | null) => JSON.stringify({ data: { nodes: ids.map(id => { const value = state(id); return value === null ? null : { databaseId: id, latestStatus: { state: value.toUpperCase() } }; }) } });

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
      if (args[1].includes('/deployments?')) return listing([{ id: 9, sha: release, ref: 'main', environment: 'production' }]);
      const asked = statusRead(args);
      if (asked) return statusAnswer(asked, () => 'success');
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
    assert.equal(github.length, 2, 'one deployment listing and one status read, whatever the delivery history holds');
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
      if (args[1].includes('/deployments?')) return listing([{ id: 9, sha: release, ref: 'main', environment: 'production' }]);
      const asked = statusRead(args);
      if (asked) return statusAnswer(asked, () => 'success');
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

test('unit:deployment-source-is-a-release — the observation takes the newest successful base-branch release, never the CI reporting environment, another branch, or another environment\'s deployment of a base-branch commit', async () => {
  const fixture = await deliveredHistory(3);
  try {
    await writeFile(fixture.token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const [old, , release] = fixture.shas;
    // As GitHub listed them on 2026-09-24: Railway records its release with the commit SHA as ref;
    // CI proof reporting records deployments on branches and on main; neither is a release.
    const listed = [
      { id: 1, sha: 'b'.repeat(40), ref: 'graphyard/gy-9-1', environment: 'graphyard-reporting' },
      // Newer staging and preview deployments of the base branch, by commit and by branch name:
      // on main, but not what production serves.
      { id: 5, sha: release, ref: 'main', environment: 'graphyard / staging' },
      { id: 4, sha: release, ref: release, environment: 'graphyard / staging' },
      // Another Railway project deployed from the same repository: its environment is named
      // production too, but it is not the managed installation's release.
      { id: 7, sha: release, ref: release, environment: 'staging-copy / production' },
      { id: 2, sha: old, ref: old, environment: 'graphyard / production' },
      { id: 3, sha: old, ref: 'main', environment: 'graphyard-reporting' },
    ];
    const run = (command: string, args: string[]) => {
      if (command === 'git') return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (args[1].includes('/deployments?')) { assert.doesNotMatch(args[1], /ref=/, 'the listing is not filtered by ref'); return listing(listed); }
      const asked = statusRead(args);
      if (asked) return statusAnswer(asked, () => 'success');
      throw new Error(`unexpected GitHub request: ${args.join(' ')}`);
    };
    // The production environment is compared as the provider's whole identity: unconfigured, the
    // default `production` matches none of the Railway records and the reason names the ones seen.
    const unconfigured = await observeDeployment(config(fixture.token), fixture.delivered, run, fetch, () => clock, { root: fixture.checkout });
    assert.equal(unconfigured.source, 'unavailable');
    assert.match(unconfigured.reason!, /deployments to 'staging-copy \/ production', 'graphyard \/ production' are not the 'production' environment — name the one production serves with graphyard master config productionEnvironment=/);
    // The master's own run configuration carries the provider's whole identity; the environment
    // variable is the fallback when it names none.
    const configured = await observeDeployment(config(fixture.token, { run: { productionEnvironment: 'graphyard / production' } }), fixture.delivered, run, fetch, () => clock, { root: fixture.checkout });
    assert.equal(configured.sha, old, 'the configured production environment is the one read');
    assert.deepEqual(masterSettingsFromArgs(['productionEnvironment=graphyard / production']), { productionEnvironment: 'graphyard / production' }, 'the master sets it with master config');
    process.env.GRAPHYARD_PRODUCTION_ENVIRONMENT = 'graphyard / production';
    const observation = await observeDeployment(config(fixture.token), fixture.delivered, run, fetch, () => clock, { root: fixture.checkout });
    assert.equal(observation.source, 'github-deployment');
    assert.equal(observation.sha, old, 'the production release, not the newer staging records of main, another project\'s production, or the reporting record on main');
    // A production deployment that names the base branch is a release like one naming its commit.
    const byBranch = { id: 6, sha: release, ref: 'main', environment: 'graphyard / production' };
    listed.unshift(byBranch);
    assert.equal((await observeDeployment(config(fixture.token), fixture.delivered, run, fetch, () => clock, { root: fixture.checkout })).sha, release);
    listed.shift();
    listed[4] = { id: 2, sha: release, ref: release, environment: 'graphyard / production' };
    const current = await observeDeployment(config(fixture.token), fixture.delivered, run, fetch, () => clock, { root: fixture.checkout });
    assert.equal(current.sha, release);
    assert.deepEqual(current.pending, []);
    // A SHA-ref deployment of a commit that is not on the base branch is not a release.
    listed[4] = { id: 2, sha: 'c'.repeat(40), ref: 'c'.repeat(40), environment: 'graphyard / production' };
    const offBranch = await observeDeployment(config(fixture.token), fixture.delivered, run, fetch, () => clock, { root: fixture.checkout });
    assert.equal(offBranch.source, 'unavailable', 'nothing on the list is a release of the base branch');
  } finally { delete process.env.GRAPHYARD_PRODUCTION_ENVIRONMENT; await rm(fixture.directory, { recursive: true, force: true }); }
});

test('unit:deployment-source-is-a-release — failed attempts never hide the release behind them; past the listing bound or an unreadable status, no release is asserted, the last one observed neither', async () => {
  const fixture = await deliveredHistory(3);
  try {
    await writeFile(fixture.token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const [old, rollback, release] = fixture.shas;
    // 25 failed attempts of the newest commit, then a successful rollback to an older release, then
    // the release the loop last observed: once more failed attempts than a per-attempt status read
    // bound (20) hid the rollback, and live deliveries stayed pending behind them.
    const failed = (count: number) => Array.from({ length: count }, (_, index) => ({ id: 10_000 + index, sha: release, ref: release, environment: 'graphyard / production' }));
    let listed = [...failed(25),
      { id: 3, sha: rollback, ref: rollback, environment: 'graphyard / production' },
      { id: 2, sha: old, ref: old, environment: 'graphyard / production' }];
    const reads: number[][] = [];
    let unreadable: number | null = null, broken = false;
    const run = (command: string, args: string[]) => {
      if (command === 'git') return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const page = /\/deployments\?(?:environment=[^&]*&)?per_page=(\d+)&page=(\d+)$/.exec(args[1]);
      if (page) { const size = Number(page[1]), number = Number(page[2]); return listing(listed.slice((number - 1) * size, number * size)); }
      const asked = statusRead(args);
      if (asked) {
        reads.push(asked);
        if (broken) throw new Error('HTTP 502');
        return statusAnswer(asked, id => id === unreadable ? null : [2, 3].includes(id) ? 'success' : 'failure');
      }
      throw new Error(`unexpected GitHub request: ${args.join(' ')}`);
    };
    const configured = config(fixture.token, { run: { productionEnvironment: 'graphyard / production' } });
    const retained = { release: old, settled: { 'GY-1': old } };
    const observe = () => observeDeployment(configured, fixture.delivered, run, fetch, () => clock, { root: fixture.checkout, retained });
    const served = await observe();
    assert.equal(served.source, 'github-deployment');
    assert.equal(served.sha, rollback, 'the successful rollback behind 25 failed attempts is the release, not the retained one');
    assert.deepEqual(served.deployed, ['GY-1', 'GY-2'], 'deliveries the rollback serves are live; the failed attempts\' commit is not');
    assert.equal(reads.length, 1, 'the page\'s statuses are one read, however many attempts failed');
    assert.equal(served.requests, 2);
    // Past the listing bound, what lies beyond is unread, a rollback included: nothing is asserted.
    reads.length = 0;
    listed = [...failed(deploymentListingPages * deploymentPageSize), ...listed.slice(-2)];
    const bounded = await observe();
    assert.equal(bounded.source, 'unavailable', 'the rollback past the bound is unread, so the retained release is not asserted');
    assert.equal(bounded.sha, null);
    assert.deepEqual(bounded.deployed, []);
    assert.match(bounded.reason!, /None of the newest 500 GitHub deployment\(s\) is a successful graphyard \/ production release.*past the 5-page read bound/);
    assert.equal(reads.length, deploymentListingPages);
    assert.equal(bounded.requests, maxDeploymentRequests);
    // An unreadable status may be the newest success: nothing older is taken past it.
    listed = [...failed(25), ...listed.slice(-2)];
    unreadable = 10_001;
    const blind = await observe();
    assert.equal(blind.source, 'unavailable');
    assert.match(blind.reason!, /status of graphyard \/ production deployment 10001 could not be read/);
    // Nor past a status read that failed outright.
    unreadable = null; broken = true;
    const failedRead = await observe();
    assert.equal(failedRead.source, 'unavailable');
    assert.match(failedRead.reason!, /status of graphyard \/ production deployment 10000 could not be read.*HTTP 502/);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('unit:deployment-source-is-a-release — records that are not releases never hide the release behind them: the listing is paged, and only release candidates are asked about', async () => {
  const fixture = await deliveredHistory(3);
  try {
    await writeFile(fixture.token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const release = fixture.shas[2];
    // 130 CI reporting and feature-branch records follow the release, so it sits on the second page.
    const listed = [...Array.from({ length: 130 }, (_, index) => index % 2
      ? { id: 1000 + index, sha: 'b'.repeat(40), ref: `graphyard/gy-${index}-1`, environment: 'graphyard / production' }
      : { id: 1000 + index, sha: release, ref: 'main', environment: 'graphyard-reporting' }),
      { id: 2, sha: release, ref: release, environment: 'graphyard / production' }];
    process.env.GRAPHYARD_PRODUCTION_ENVIRONMENT = 'graphyard / production';
    const pages: number[] = [], statuses: string[] = [];
    const run = (command: string, args: string[]) => {
      if (command === 'git') return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const page = /\/deployments\?(?:environment=[^&]*&)?per_page=(\d+)&page=(\d+)$/.exec(args[1]);
      if (page) { const size = Number(page[1]), number = Number(page[2]); pages.push(number); return listing(listed.slice((number - 1) * size, number * size)); }
      const asked = statusRead(args);
      if (asked) { statuses.push(...asked.map(String)); return statusAnswer(asked, () => 'success'); }
      throw new Error(`unexpected GitHub request: ${args.join(' ')}`);
    };
    const observation = await observeDeployment(config(fixture.token), fixture.delivered, run, fetch, () => clock, { root: fixture.checkout });
    assert.equal(observation.source, 'github-deployment');
    assert.equal(observation.sha, release, 'the release behind 130 non-release records');
    assert.deepEqual(pages, [1, 2]);
    assert.deepEqual(statuses, ['2'], 'no status is read for a record that is not a release');
    assert.equal(observation.requests, 3, 'two listing pages and one status read');
    assert.ok(observation.requests! <= maxDeploymentRequests);
  } finally { delete process.env.GRAPHYARD_PRODUCTION_ENVIRONMENT; await rm(fixture.directory, { recursive: true, force: true }); }
});

/** GitHub's deployment listing as the API pages it, honouring the `environment=` filter unless told to ignore it. */
function pagedListing(records: { id: number; environment: string }[], options: { honourFilter: boolean; listings: string[] }) {
  return (path: string) => {
    const page = /\/deployments\?(?:environment=([^&]*)&)?per_page=(\d+)&page=(\d+)$/.exec(path);
    if (!page) return null;
    options.listings.push(path);
    const environment = page[1] === undefined ? null : decodeURIComponent(page[1]);
    const size = Number(page[2]), number = Number(page[3]);
    const shown = environment !== null && options.honourFilter ? records.filter(record => record.environment === environment) : records;
    return listing(shown.slice((number - 1) * size, number * size));
  };
}

test('unit:deployment-observation-environment-filter — 600 CI reporting deployments newer than production\'s release do not hide it: the observation reads the production environment\'s listing, and the unfiltered listing reproduces the 2026-10-02 refusal', async () => {
  const fixture = await deliveredHistory(3);
  try {
    await writeFile(fixture.token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const release = fixture.shas[2];
    // As on 2026-10-02: the graphyard-reporting environment's per-branch CI records, 100+ an hour,
    // all newer than the successful production release (deployment 6804095387 of 14ebe09097).
    const records = [...Array.from({ length: 600 }, (_, index) => ({ id: 20_000 + index, sha: 'b'.repeat(40), ref: `graphyard/gy-${index}-1`, environment: 'graphyard-reporting' })),
      { id: 6804095387, sha: release, ref: release, environment: 'graphyard / production' }];
    const listings: string[] = [], statuses: number[][] = [];
    const options = { honourFilter: true, listings };
    const page = pagedListing(records, options);
    const run = (command: string, args: string[]) => {
      if (command === 'git') return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const listed = page(args[1]);
      if (listed !== null) return listed;
      const asked = statusRead(args);
      if (asked) { statuses.push(asked); return statusAnswer(asked, () => 'success'); }
      throw new Error(`unexpected GitHub request: ${args.join(' ')}`);
    };
    const configured = config(fixture.token, { run: { productionEnvironment: 'graphyard / production' } });
    const observe = () => observeDeployment(configured, fixture.delivered, run, fetch, () => clock, { root: fixture.checkout });

    const observation = await observe();
    assert.equal(observation.source, 'github-deployment');
    assert.equal(observation.sha, release, 'the production release behind 600 reporting records');
    assert.deepEqual(observation.pending, []);
    assert.deepEqual(listings, ['repos/owner/project/deployments?environment=graphyard%20%2F%20production&per_page=100&page=1'], 'one page of the production environment\'s listing');
    assert.deepEqual(statuses, [[6804095387]]);
    assert.equal(observation.requests, 2);

    // The old code path read the unfiltered listing: a GitHub that ignores the filter serves exactly
    // that, and the observation refuses as master verify-deployment GY-1046 was refused at 08:12.
    listings.length = 0; statuses.length = 0; options.honourFilter = false;
    const unfiltered = await observe();
    assert.equal(unfiltered.source, 'unavailable');
    assert.equal(unfiltered.sha, null);
    assert.deepEqual(unfiltered.deployed, []);
    assert.match(unfiltered.reason!, /^None of the newest 500 GitHub deployment\(s\) is a successful graphyard \/ production release of the managed base branch, and older ones are past the 5-page read bound/);
    assert.equal(listings.length, deploymentListingPages);
    assert.deepEqual(statuses, [], 'no reporting record is ever asked about');

    // The filter is the configured whole identity: unconfigured, the production environment's listing
    // is empty, and one unfiltered page names the Railway environment to configure (a hint only:
    // here the release is within that page).
    listings.length = 0; options.honourFilter = true; records.splice(0, 550);
    const unconfigured = await observeDeployment(config(fixture.token), fixture.delivered, run, fetch, () => clock, { root: fixture.checkout });
    assert.equal(unconfigured.source, 'unavailable');
    assert.match(unconfigured.reason!, /deployments to 'graphyard \/ production' are not the 'production' environment — name the one production serves with graphyard master config productionEnvironment='graphyard \/ production'/);
    assert.deepEqual(listings, ['repos/owner/project/deployments?environment=production&per_page=100&page=1', 'repos/owner/project/deployments?per_page=100&page=1']);
    assert.equal(unconfigured.requests, 2);
    assert.ok(unconfigured.requests! <= maxDeploymentRequests);
    // With nothing named like production anywhere, the reason says the environment records nothing.
    const empty = await observeDeployment(config(fixture.token), fixture.delivered, (command, args) => command === 'git' ? run(command, args) : '[]', fetch, () => clock, { root: fixture.checkout });
    assert.match(empty.reason!, /records no GitHub deployment to the production environment/);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('unit:deployment-observation-inactive-release — the newest production deployment that reached success and was later marked inactive is the served release; one superseded by a newer success, or behind a failed, unreadable or other-branch attempt, stays fail-closed', async () => {
  const fixture = await deliveredHistory(3);
  try {
    await writeFile(fixture.token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const [old, mid, release] = fixture.shas;
    type Status = { latest: string; history: string[] } | null;
    let records: { id: number; sha: string; ref: string; environment: string }[] = [];
    let status: Record<number, Status> = {};
    const run = (command: string, args: string[]) => {
      if (command === 'git') return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const listed = pagedListing(records, { honourFilter: true, listings: [] })(args[1]);
      if (listed !== null) return listed;
      const asked = statusRead(args);
      if (asked) {
        assert.match(args[3], /statuses\(first: \d+\) \{ nodes \{ state \} \}/, 'the read asks for each deployment\'s status history');
        // GitHub lists a deployment's statuses newest first.
        return JSON.stringify({ data: { nodes: asked.map(id => { const value = status[id]; return value ? { databaseId: id, latestStatus: { state: value.latest.toUpperCase() }, statuses: { nodes: value.history.map(state => ({ state: state.toUpperCase() })) } } : null; }) } });
      }
      throw new Error(`unexpected GitHub request: ${args.join(' ')}`);
    };
    const configured = config(fixture.token, { run: { productionEnvironment: 'graphyard / production' } });
    const observe = () => observeDeployment(configured, fixture.delivered, run, fetch, () => clock, { root: fixture.checkout });
    const production = (id: number, sha: string, ref = sha) => ({ id, sha, ref, environment: 'graphyard / production' });
    // Railway's sequence on 2026-10-02: 14ebe09097 success at 08:07, inactive at 08:10, nothing newer.
    const deactivated = { latest: 'inactive', history: ['inactive', 'success', 'in_progress', 'queued'] };

    records = [{ id: 50, sha: 'b'.repeat(40), ref: 'graphyard/gy-1-1', environment: 'graphyard-reporting' }, production(3, release), production(2, mid)];
    status = { 3: deactivated, 2: deactivated };
    const served = await observe();
    assert.equal(served.source, 'github-deployment');
    assert.equal(served.sha, release, 'the newest production deployment, succeeded then marked inactive, is what production serves');
    assert.deepEqual(served.pending, []);
    assert.match(served.reason!, /graphyard \/ production deployment 3 reached success and was later marked inactive with no newer graphyard \/ production deployment/);
    // Today's active success is unchanged and says nothing about inactivity.
    status = { 3: { latest: 'success', history: ['success'] }, 2: deactivated };
    assert.equal((await observe()).reason, null);

    // Superseded: a newer successful production deployment is the release, never the older one.
    records = [production(4, mid), production(3, release)];
    status = { 4: { latest: 'success', history: ['success', 'in_progress'] }, 3: deactivated };
    const superseded = await observe();
    assert.equal(superseded.sha, mid, 'the newer success (here a rollback to an older commit) is served, not the deactivated release');
    assert.deepEqual(superseded.pending, ['GY-3']);
    // The newer one deactivated too: it is still the newest, so it is served, the older one not.
    status[4] = deactivated;
    assert.equal((await observe()).sha, mid);

    // A newer failed attempt: the deactivated release behind it is not asserted.
    records = [production(4, release), production(3, mid), production(2, old)];
    status = { 4: { latest: 'failure', history: ['failure', 'in_progress'] }, 3: deactivated, 2: deactivated };
    const behindFailure = await observe();
    assert.equal(behindFailure.source, 'unavailable');
    assert.deepEqual(behindFailure.deployed, []);
    assert.match(behindFailure.reason!, /No GitHub deployment of the managed base branch to the graphyard \/ production environment reports a successful status/);
    // But an older release still active behind the failed attempt is served, as today.
    status[2] = { latest: 'success', history: ['success'] };
    assert.equal((await observe()).sha, old);

    // A newer attempt whose status is unread: nothing older is taken.
    status = { 3: deactivated, 2: deactivated };
    const unread = await observe();
    assert.equal(unread.source, 'unavailable');
    assert.match(unread.reason!, /status of graphyard \/ production deployment 4 could not be read/);

    // A newer production record that is not a release (another branch): the deactivated release is not asserted.
    records = [production(5, 'c'.repeat(40), 'graphyard/gy-7-1'), production(3, release)];
    status = { 3: deactivated };
    assert.equal((await observe()).source, 'unavailable');

    // Inactive without ever reaching success is never a release.
    records = [production(3, release)];
    status = { 3: { latest: 'inactive', history: ['inactive', 'error'] } };
    assert.equal((await observe()).source, 'unavailable');

    // A newer production record a page earlier counts as newer too.
    records = [...Array.from({ length: deploymentPageSize }, (_, index) => production(10_000 + index, release)), production(3, mid)];
    status = Object.fromEntries(records.map(record => [record.id, record.id === 3 ? deactivated : { latest: 'failure', history: ['failure'] }]));
    const paged = await observe();
    assert.equal(paged.source, 'unavailable', 'the deactivated release on page two is behind 100 newer attempts');
    assert.equal(paged.requests, 4);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

// GY-1106 names these tests for its proof: manual:fault-class-deployment. The master loop filed 3
// deployment faults in 24 hours on 2 October 2026. Every instance shared the same cause:
//
//   - Deployment observation read the GitHub deployments listing without filtering by the configured
//     production environment (repos/:repo/deployments?per_page=100&page=N).
//   - Non-production deployments — in particular, hundreds of CI proof reporting deployments
//     (environment: 'graphyard-reporting') — filled all 5 pages (500 records) of the listing bound.
//   - Although Railway had successfully deployed each merged change to 'graphyard / production', the
//     unfiltered listing window was completely consumed by CI reporting records, hiding the production
//     releases past the 5-page bound.
//   - The observation concluded that none of the newest 500 deployments was a successful release of
//     the managed base branch, marking the observation unavailable and recording action:deployment
//     as a recurring deployment fault on the subject deployment:<mergeSha>.
//
// The candidate filters the GitHub deployment listing by environment (environment=...), so non-production
// deployments never enter the listing window, and the successful production release is observed immediately.
//
// Each instance listed on the item is replayed below from the ledger and GitHub as they stood when
// the loop recorded it. Against the base each subtest fails: the instance reproduces.

interface FaultInstance {
  id: string;
  subject: string;
  sha: string;
  at: string;
  itemKey: string;
  pr: number;
  deploymentId: number;
}

const faultInstances: FaultInstance[] = [
  {
    id: 'action:deployment|deployment:55e693f8de263b78850ca4675357cc5ebb6ed1f5|2026-10-02T06:40:15.237Z',
    subject: 'deployment:55e693f8de263b78850ca4675357cc5ebb6ed1f5',
    sha: '55e693f8de263b78850ca4675357cc5ebb6ed1f5',
    at: '2026-10-02T06:40:15.237Z',
    itemKey: 'GY-468',
    pr: 348,
    deploymentId: 6801787363,
  },
  {
    id: 'action:deployment|deployment:74710c912d97b074ce1cc4b1af338000749c3dfc|2026-10-02T07:25:37.243Z',
    subject: 'deployment:74710c912d97b074ce1cc4b1af338000749c3dfc',
    sha: '74710c912d97b074ce1cc4b1af338000749c3dfc',
    at: '2026-10-02T07:25:37.243Z',
    itemKey: 'GY-966',
    pr: 511,
    deploymentId: 6803222981,
  },
  {
    id: 'action:deployment|deployment:625bd412a391f1114bcfa8200e4b8612462b8b4d|2026-10-02T08:00:02.292Z',
    subject: 'deployment:625bd412a391f1114bcfa8200e4b8612462b8b4d',
    sha: '625bd412a391f1114bcfa8200e4b8612462b8b4d',
    at: '2026-10-02T08:00:02.292Z',
    itemKey: 'GY-1074',
    pr: 541,
    deploymentId: 6803801669,
  },
];

function faultConfig(): MasterConfig {
  return masterConfigSchema.parse({
    version: 1,
    url: 'https://graphyard.example',
    credentialFile: '/outside/coordinator.token',
    cliPath: launcher,
    repository: 'cryptob1/graphyard',
    baseBranch: 'main',
    githubAppId: 1234,
    hostId: 'vishrog',
    masterAgentName: 'graphyard-master',
    autoMerge: true,
    mergeMethod: 'merge',
    workers: [],
    run: {
      productionEnvironment: 'graphyard / production',
    },
  });
}

function faultDeliveredItem(instance: FaultInstance): Work {
  return {
    id: `work-${instance.itemKey}`,
    key: instance.itemKey,
    title: instance.itemKey,
    description: '',
    type: 'feature',
    priority: 1,
    dependencies: [],
    criteria: [],
    policy: { checks: ['test'], review: true },
    plannedFiles: [],
    stage: 'done',
    revision: 1,
    policyRevision: 1,
    createdAt: instance.at,
    updatedAt: instance.at,
    stageEnteredAt: instance.at,
    ready: false,
    epoch: 1,
    lease: null,
    workspaces: [],
    candidate: null,
    submission: { epoch: 1, pr: instance.pr },
    reworkRequested: false,
    scenarioRequirements: [],
    evidence: [],
    observation: null,
    blocker: null,
    gates: [],
    violations: [],
    delivery: { mergedAt: instance.at, mergeSha: instance.sha, authorizationRevision: 1 },
  } as unknown as Work;
}

/**
 * Creates a mock runner representing GitHub and local git at the time of the incident:
 * - Local git confirms the commit is an ancestor of main (mocked for shallow environments).
 * - GitHub deployments listing:
 *     - If filtered by environment ('graphyard / production'): returns the production deployment.
 *     - If unfiltered (base behavior): returns 500 non-production CI reporting deployments across 5 pages.
 * - GitHub status query: returns 'SUCCESS' for the production deployment.
 */
function createIncidentRunner(instance: FaultInstance) {
  const requests: string[] = [];
  const run: ChildRun = async (command: string, args: string[]) => {
    requests.push(`${command} ${args.join(' ')}`);
    if (command === 'git') {
      if (args.includes('fetch')) return '';
      if (args.includes('merge-base')) return '';
      return '';
    }
    if (command === 'gh') {
      // Status read via GraphQL: gh api graphql -f query=...
      if (args[0] === 'api' && args[1] === 'graphql') {
        return JSON.stringify({
          data: {
            nodes: [
              {
                databaseId: instance.deploymentId,
                latestStatus: { state: 'SUCCESS' },
                statuses: { nodes: [{ state: 'SUCCESS' }] },
              },
            ],
          },
        });
      }
      // Deployments listing: gh api repos/.../deployments?...
      const target = args[1] ?? '';
      if (args[0] === 'api' && target.includes('/deployments?')) {
        const isEnvironmentFiltered = target.includes(`environment=${encodeURIComponent('graphyard / production')}`)
          || target.includes('environment=graphyard%20%2F%20production');
        if (isEnvironmentFiltered) {
          // When filtered by environment, GitHub returns only deployments matching the production environment
          return JSON.stringify([
            {
              id: instance.deploymentId,
              node_id: `DE_${instance.deploymentId}`,
              sha: instance.sha,
              ref: instance.sha,
              environment: 'graphyard / production',
            },
          ]);
        }
        // Unfiltered listing (base behavior): 500 non-production CI reporting records fill the 5 pages
        const pageMatch = /[?&]page=(\d+)/.exec(target);
        const page = pageMatch ? Number(pageMatch[1]) : 1;
        return JSON.stringify(
          Array.from({ length: 100 }, (_, index) => ({
            id: 900_000 + (page - 1) * 100 + index,
            node_id: `DE_rep_${page}_${index}`,
            sha: '0'.repeat(40),
            ref: 'main',
            environment: 'graphyard-reporting',
          })),
        );
      }
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
  return { run, requests };
}

test('manual:fault-class-deployment — the item lists 3 instances, and every one is replayed below', () => {
  assert.equal(new Set(faultInstances.map(inst => inst.id)).size, 3);
  assert.deepEqual(faultInstances.map(inst => inst.itemKey), ['GY-468', 'GY-966', 'GY-1074']);
  assert.deepEqual(new Set(faultInstances.map(inst => inst.subject)).size, 3);
});

for (const instance of faultInstances) {
  test(`manual:fault-class-deployment — ${instance.id} does not recur when deployment listing is filtered by environment`, async () => {
    const master = faultConfig();
    const state = emptyDaemonState(master);
    const item = faultDeliveredItem(instance);
    const { run, requests } = createIncidentRunner(instance);

    const performed: any[] = [];
    const cycle: Cycle = {
      config: master,
      state,
      effects: {
        observeDeployment: async (delivered: Work[], retained: any) =>
          observeDeployment(master, delivered, run, fetch, () => Date.parse(instance.at), {
            root: process.cwd(),
            retained,
          }),
        persist: async () => {},
        publishProductionEnvironment: async () => {},
        recordDeployment: async () => {},
      } as any,
      now: () => Date.parse(instance.at),
      snapshot: { work: [item], now: instance.at },
      performed,
      isolate: async (_step: unknown, _work: unknown, _key: unknown, action: () => Promise<unknown>) => action(),
    } as any;

    await deploymentStep(cycle);

    // Against candidate: observation finds the release and verifies the deployed commit
    assert.equal(state.deployment?.source, 'github-deployment');
    assert.equal(state.deployment?.sha, instance.sha);
    assert.deepEqual(state.deployment?.deployed, [instance.itemKey]);
    assert.deepEqual(state.deployment?.pending, []);

    // Against candidate: the deployment action succeeds, raising no fault
    const action = state.actions[instance.subject];
    assert.ok(action, `action ${instance.subject} was recorded`);
    assert.equal(action.state, 'done', 'deployment action completed successfully');
    assert.equal(action.faultClass, undefined, 'no deployment fault is recorded');

    // Verify that the query passed the environment filter
    const listRequests = requests.filter(req => req.includes('/deployments?'));
    assert.ok(listRequests.length >= 1, 'at least one deployments listing request was made');
    for (const req of listRequests) {
      assert.match(req, /environment=/, 'GitHub deployments query is filtered by environment');
    }
  });
}

for (const instance of faultInstances) {
  test(`manual:fault-class-deployment — reproduction against base: ${instance.id} fails when 500 non-production records hide the release`, async () => {
    const master = faultConfig();
    const item = faultDeliveredItem(instance);

    // Simulate base behavior by answering only unfiltered queries with 500 CI reporting records
    let unfilteredPagesRequested = 0;
    const baseRun: ChildRun = async (command: string, args: string[]) => {
      if (command === 'git') {
        if (args.includes('fetch')) return '';
        if (args.includes('merge-base')) return '';
        return '';
      }
      if (command === 'gh') {
        const target = args[1] ?? '';
        if (args[0] === 'api' && target.includes('/deployments?')) {
          unfilteredPagesRequested++;
          const pageMatch = /[?&]page=(\d+)/.exec(target);
          const page = pageMatch ? Number(pageMatch[1]) : 1;
          return JSON.stringify(
            Array.from({ length: 100 }, (_, index) => ({
              id: 900_000 + (page - 1) * 100 + index,
              node_id: `DE_rep_${page}_${index}`,
              sha: '0'.repeat(40),
              ref: 'main',
              environment: 'graphyard-reporting',
            })),
          );
        }
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    };

    // Force unfiltered URL to simulate base code that did not pass environment parameter
    const simulateBaseRunner: ChildRun = async (command, args) => {
      if (command === 'gh' && args[0] === 'api' && args[1]?.includes('/deployments?')) {
        const strippedUrl = args[1].replace(/environment=[^&]*&/, '');
        return baseRun(command, [args[0], strippedUrl, ...args.slice(2)]);
      }
      return baseRun(command, args);
    };

    const observation = await observeDeployment(master, [item], simulateBaseRunner, fetch, () => Date.parse(instance.at), {
      root: process.cwd(),
    });

    // Exactly reproduces the base failure recorded in GY-1106:
    assert.equal(observation.source, 'unavailable');
    assert.equal(observation.sha, null);
    assert.equal(unfilteredPagesRequested, 5, 'base reads all 5 pages looking for the release');
    assert.match(
      observation.reason!,
      /None of the newest 500 GitHub deployment\(s\) is a successful graphyard \/ production release of the managed base branch, and older ones are past the 5-page read bound, so the release production serves is not known/,
      'reproduces the exact fault message recorded on GY-1106',
    );
  });
}

