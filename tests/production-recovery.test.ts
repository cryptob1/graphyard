import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProductionWatch, railwayProvider, REDEPLOY_COOLDOWN_MS, type DeploymentProvider, type ProviderDeployment } from '../src/production-watch.js';
import { buildIdentity } from '../src/protocol-version.js';
import { productionSummary } from '../src/master/attention.js';
import { claimContainmentFrom, readThroughputMeasurement, recordThroughputMeasurement, throughputClaim, throughputClaimVisibility, verifyThroughput, type DeployedRelease } from '../src/throughput.js';
import { daemonEffects, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';
import type { Store } from '../src/store.js';
// @ts-expect-error Dependency-free measurement script, for the conformance check.
import { claimContainment } from '../scripts/measure-throughput.mjs';

/**
 * GY-393: the deployment fault class recurred three times in a day because the product only
 * observed its own deployment faults. A stalled rollout drifted for ever (main 8, then 16 commits
 * ahead of production), and the delivered throughput claim's post-deploy measurement was a command
 * routed to a master session no master session was running to take. These tests name each instance
 * and show the candidate handling the case itself: the watch re-triggers the provider deploy when
 * production lags with no attempt in flight, and the loop records the measurement itself, so the
 * instances cannot recur.
 */

const sha = (index: number) => index.toString(16).padStart(40, '0');
const T0 = Date.parse('2026-09-26T12:00:00Z');
const RELEASE = sha(0xa4);        // the base branch tip, not yet served
const OLD_RELEASE = sha(0x50);    // what production serves while the drift stands
const minute = 60_000;
const cooldown = REDEPLOY_COOLDOWN_MS;

/** The ledger and work items the watch reads, in memory: only the queries the watch issues. */
function memoryStore(work: Work[]) {
  const events: { seq: number; work_id: string | null; kind: string; payload: any }[] = [];
  const pool = { async query(sql: string, params: any[] = []) {
    if (sql.startsWith('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL')) { events.push({ seq: events.length + 1, work_id: null, kind: params[1], payload: JSON.parse(params[2]) }); return { rows: [] }; }
    if (sql.startsWith('INSERT INTO events')) { events.push({ seq: events.length + 1, work_id: params[0], kind: params[2], payload: JSON.parse(params[3]) }); return { rows: [] }; }
    const limit = Number(sql.match(/LIMIT (\d+)/)?.[1] ?? Infinity);
    if (sql.includes('kind IN ($1,$2)')) return { rows: events.filter(row => row.kind === params[0] || row.kind === params[1]).reverse().slice(0, limit) };
    if (sql.includes('kind=$1')) return { rows: events.filter(row => row.kind === params[0]).reverse().slice(0, limit) };
    throw new Error(`unexpected query ${sql}`);
  } };
  return { store: { pool, list: async () => work } as unknown as Store, events };
}

/** Deliveries merged after OLD_RELEASE and before RELEASE, old enough to be past the grace period. */
function delivered(count: number): Work[] {
  return Array.from({ length: count }, (_, index) => ({ id: `work-${index + 1}`, key: `GY-${index + 1}`, stage: 'done',
    delivery: { mergedAt: new Date(T0 - 30 * minute + index * minute).toISOString(), mergeSha: sha(0xa1 + index), authorizationRevision: 1 } }) as unknown as Work);
}

/** GitHub over a linear base branch: OLD_RELEASE < sha(0xa1..) < RELEASE. */
const linearGitHub = (tip: number) => ({
  request: async (path: string) => {
    const [, from, to] = path.match(/^\/compare\/([0-9a-f]{40})\.\.\.([^?]+)/)!;
    const a = parseInt(from, 16), b = to === 'main' ? tip : parseInt(to, 16);
    return { status: b > a ? 'ahead' : b === a ? 'identical' : 'behind', ahead_by: Math.max(0, b - a) };
  },
  contains: async (base: string, head: string) => parseInt(base, 16) <= parseInt(head, 16),
  aheadBy: async (base: string) => Math.max(0, tip - parseInt(base, 16)),
});

/** A provider whose deployment list the test edits in place; `calls` counts the redeploys it was asked for. */
function moveableProvider(redeploy?: DeploymentProvider['redeploy']): { provider: DeploymentProvider; deployments: ProviderDeployment[]; calls: () => number } {
  const deployments: ProviderDeployment[] = [{ id: 'd-old', status: 'success', providerStatus: 'SUCCESS', commit: OLD_RELEASE, branch: 'main', createdAt: new Date(T0 - 40 * minute).toISOString(), updatedAt: null, url: null }];
  const provider: DeploymentProvider = { name: 'railway', description: 'stub', list: async () => deployments };
  let calls = 0;
  if (redeploy) provider.redeploy = async () => { calls++; return redeploy(); };
  return { provider, deployments, calls: () => calls };
}

test('unit:production-drift-recovers — the watch asks the provider to deploy when main is ahead with no attempt in flight, at most once per cooldown, and the drift line ends once production serves', async () => {
  const work = delivered(3);
  const { store, events } = memoryStore(work);
  const github = linearGitHub(parseInt(RELEASE, 16));
  let clock = T0;
  const grace = 5 * minute;

  // The instances, reproduced against the base behaviour: a provider that only answers `list`
  // leaves the drift standing with its master-routed remedy and open incidents, however long the
  // loop keeps cycling — that is how main grew 8, then 16, commits ahead of production.
  const observeOnly: DeploymentProvider = { name: 'railway', description: 'stub', list: async () => [{ id: 'd-old', status: 'success', providerStatus: 'SUCCESS', commit: OLD_RELEASE, branch: 'main', createdAt: new Date(T0 - 40 * minute).toISOString(), updatedAt: null, url: null }] };
  const base = new ProductionWatch(store, { provider: observeOnly, github, build: buildIdentity({}), baseBranch: 'main', graceMs: grace, now: () => clock });
  let report = await base.tick(true);
  clock += minute;
  report = await base.tick(true);
  assert.ok(report.ahead!.by > 0, 'main really is ahead of what production serves');
  assert.match(report.attention.join('\n'), /main is \d+ commits? ahead of production/);
  assert.equal(report.incidents.length, 3, 'every delivery past the grace period is an open missing-deployment incident');

  // The candidate: a provider that can deploy on request is asked, and the pass says so.
  const moved = moveableProvider(async () => ({ id: 'd-new' }));
  const watch = new ProductionWatch(store, { provider: moved.provider, github, build: buildIdentity({}), baseBranch: 'main', graceMs: grace, now: () => clock });
  report = await watch.tick(true);
  assert.equal(moved.calls(), 1, 'production is behind with only an old successful attempt, so the watch triggers the deploy');
  assert.equal(report.redeploy!.trigger, 'railway deployment d-new');
  assert.match(productionSummary(report).summary ?? '', /main is \d+ commits? ahead of production/);

  // Within the cooldown the watch never stacks a second trigger, however far main runs ahead.
  clock += 10 * minute;
  report = await watch.tick(true);
  assert.equal(moved.calls(), 1, `the cooldown (${cooldown / minute} min) holds`);
  assert.equal(report.redeploy, null);
  assert.equal(report.redeployError, null);

  // An attempt in flight is never stacked on: with the cooldown cleared, a building provider is left alone.
  clock += cooldown;
  moved.deployments.unshift({ id: 'd-new', status: 'building', providerStatus: 'BUILDING', commit: RELEASE, branch: 'main', createdAt: new Date(clock - minute).toISOString(), updatedAt: null, url: null });
  report = await watch.tick(true);
  assert.equal(moved.calls(), 1, 'no second trigger while the provider is already building');
  assert.equal(report.redeploy, null);
  moved.deployments.shift();

  // Once production serves the base branch tip the drift line and the incidents end: the
  // instances do not recur while the product keeps the release current.
  moved.deployments[0].commit = RELEASE;
  clock += minute;
  report = await watch.tick(true);
  assert.equal(moved.calls(), 1);
  assert.equal(report.ahead!.by, 0);
  assert.equal(report.incidents.length, 0, 'the recoveries are recorded against the incidents');
  assert.deepEqual(report.attention, []);
  assert.ok(events.some(event => event.kind === 'delivery.deployment-recovered'));

  // A provider that refuses the trigger is reported on the pass, never thrown, and asked again
  // only after the cooldown — a deploy loop must not spin on a refusing provider.
  moved.deployments[0].commit = OLD_RELEASE;
  const refusing = moveableProvider(async () => { throw new Error('needs approval'); });
  const second = new ProductionWatch(store, { provider: refusing.provider, github, build: buildIdentity({}), baseBranch: 'main', graceMs: grace, now: () => clock });
  report = await second.tick(true);
  assert.equal(refusing.calls(), 1);
  assert.match(report.redeployError!, /railway refused the redeploy: needs approval/);
  assert.equal(report.error, null);
  clock += minute;
  report = await second.tick(true);
  assert.equal(refusing.calls(), 1, 'the refusing provider is not asked again inside the cooldown');
  assert.equal(report.redeployError, null, 'no error stands from a trigger this pass did not make');
});

test('unit:production-drift-holds-when-not-behind — the watch triggers nothing while production serves the tip, whatever the provider attempts', async () => {
  const work = delivered(1);
  const { store } = memoryStore(work);
  const clock = T0;
  for (const status of ['building', 'deploying', 'queued', 'failed', 'crashed', 'removed', 'skipped', 'unknown'] as const) {
    const probe = moveableProvider(async () => ({ id: null }));
    probe.deployments[0].status = status;
    const upToDate = new ProductionWatch(store, { provider: probe.provider, github: linearGitHub(1), build: buildIdentity({ commit: sha(1) }), baseBranch: 'main', graceMs: minute, now: () => clock });
    const report = await upToDate.tick(true);
    assert.equal(probe.calls(), 0, `${status} with production current triggers nothing`);
    assert.equal(report.redeploy, null);
  }
});

test('unit:railway-redeploy — the provider asks Railway to deploy the branch\'s latest commit, not the stale one it holds, and reports refusals as errors, never as success', async () => {
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  const fetcher = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return { ok: true, json: async () => ({ data: { serviceInstanceDeploy: true } }) };
  }) as unknown as typeof fetch;
  const provider = railwayProvider({ RAILWAY_API_TOKEN: 'account-token', RAILWAY_SERVICE_ID: 'svc-1', RAILWAY_ENVIRONMENT_ID: 'env-1' }, fetcher)!;
  assert.deepEqual(await provider.redeploy!(), { id: null }, 'the mutation answers a Boolean, never a deployment id');
  assert.equal(calls.length, 1);
  // Without latestCommit Railway redeploys the commit the service already holds — the stale one in a
  // stalled auto-deploy — so the drift would stand; the mutation must ask for the branch's newest commit.
  assert.match(calls[0].body.query, /serviceInstanceDeploy\(serviceId: \$serviceId, environmentId: \$environmentId, latestCommit: true\)/);
  assert.deepEqual(calls[0].body.variables, { serviceId: 'svc-1', environmentId: 'env-1' });
  assert.equal(calls[0].headers.Authorization, 'Bearer account-token', 'an account token authenticates the mutation');

  const project = railwayProvider({ RAILWAY_TOKEN: 'project-token', RAILWAY_SERVICE_ID: 'svc-1', RAILWAY_ENVIRONMENT_ID: 'env-1' }, fetcher)!;
  await project.redeploy!();
  assert.equal(calls[1].headers['Project-Access-Token'], 'project-token', 'a project token authenticates the mutation too');

  const refused = railwayProvider({ RAILWAY_API_TOKEN: 't', RAILWAY_SERVICE_ID: 's', RAILWAY_ENVIRONMENT_ID: 'e' }, (async () => ({ ok: true, json: async () => ({ errors: [{ message: 'permission denied' }] }) })) as unknown as typeof fetch)!;
  await assert.rejects(refused.redeploy!(), /Railway API refused the redeploy: permission denied/);
  const failing = railwayProvider({ RAILWAY_API_TOKEN: 't', RAILWAY_SERVICE_ID: 's', RAILWAY_ENVIRONMENT_ID: 'e' }, (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch)!;
  await assert.rejects(failing.redeploy!(), /Railway API answered 5/);
  const unaccepted = railwayProvider({ RAILWAY_API_TOKEN: 't', RAILWAY_SERVICE_ID: 's', RAILWAY_ENVIRONMENT_ID: 'e' }, (async () => ({ ok: true, json: async () => ({ data: { serviceInstanceDeploy: false } }) })) as unknown as typeof fetch)!;
  await assert.rejects(unaccepted.redeploy!(), /did not accept the deploy of the latest commit/);
  assert.equal(railwayProvider({ RAILWAY_SERVICE_ID: 's', RAILWAY_ENVIRONMENT_ID: 'e' }), null, 'without a token the provider stays observe-only');
});

test('unit:throughput-measured-by-the-loop — reproduce: the delivered claim\'s measurement is a master command nobody is running to take; candidate: the cycle takes it itself, so the instance cannot recur', async () => {
  // Reproduction: with no measurement recorded, the attention names the exact instance this item
  // stands for, routed to a master session with the script command as the remedy.
  const never = throughputClaimVisibility(null, { revision: RELEASE, version: '1.0.0' }, 3);
  assert.match(never.reason, /no post-deploy measurement has ever been recorded under \.graphyard\/measurements\/throughput/);
  assert.equal(never.attention!.role, 'master');
  assert.match(never.command, /measure-throughput\.mjs --record/);

  // Candidate: one cycle of the loop, with the delivered claim and an observed release.
  const root = await mkdtemp(join(tmpdir(), 'graphyard-recovery-root-'));
  const { directory, token } = await privateDirectory();
  try {
    const master = config(token);
    const claim: Work = deliveredWork({ id: 'claim', key: throughputClaim.item, mergeSha: sha(0x87) });
    const routine: Work = deliveredWork({ id: 'routine', key: 'GY-50', mergeSha: sha(0x50) });
    const work = [claim, routine];
    let clock = T0;
    const measurements: string[] = [];
    const effects = stubEffects({
      snapshot: async () => ({ work, now: new Date(clock).toISOString() }),
      observeDeployment: async deliveredItems => ({ source: 'endpoint', sha: RELEASE, at: new Date(clock).toISOString(), reason: null, deployed: deliveredItems.map(item => item.key), pending: [] }),
      measureThroughput: async ({ work: items, now, sha: observed }) => {
        assert.equal(observed, RELEASE, 'the measurement binds to the release the observation saw serving');
        const report = verifyThroughput(items, Date.parse(now), { claimKey: throughputClaim.item, deployed: release({ observedAt: now }) });
        const file = await recordThroughputMeasurement(root, report);
        measurements.push(file);
        return { revision: RELEASE, verdict: report.verdict, file, reason: report.reason };
      },
    });
    const state = emptyDaemonState(master);
    await runCycle(master, state, effects, () => clock);

    // The measurement is recorded, on the cursor and in the file the report reads.
    assert.equal(measurements.length, 1);
    assert.equal(state.throughput!.revision, RELEASE);
    assert.equal(state.throughput!.file, measurements[0]);
    const recorded = await readThroughputMeasurement(root);
    assert.ok(recorded, 'the loop-taken measurement is readable exactly as a manual one');
    assert.equal(recorded!.report.deployed.revision, RELEASE);

    // The instance can no longer recur: against the release now serving, the claim's visibility is
    // judged from a recorded measurement — verified here, or a shortfall said in its own words —
    // never again "no post-deploy measurement has ever been recorded".
    const judged = throughputClaimVisibility(recorded, { revision: RELEASE, version: '1.0.0' }, work.length);
    assert.equal(judged.verdict, recorded!.report.verdict);
    assert.doesNotMatch(judged.reason, /no post-deploy measurement has ever been recorded/);
    assert.doesNotMatch(judged.reason, /the last measurement was taken against/);
    assert.match(judged.reason, /0 of the 10 deliveries the claim is judged over/, 'a two-delivery window says honestly what it lacks');

    // One measurement per release: the next cycle does not measure the same release again.
    clock += minute;
    await runCycle(master, state, effects, () => clock);
    assert.equal(measurements.length, 1);

    // A failed measurement retries on the cycle backoff, and stops after its bound with the
    // attention standing for a master or an operator — never spinning.
    const failing = stubEffects({
      snapshot: async () => ({ work, now: new Date(clock).toISOString() }),
      observeDeployment: async deliveredItems => ({ source: 'endpoint', sha: sha(0xff), at: new Date(clock).toISOString(), reason: null, deployed: deliveredItems.map(item => item.key), pending: [] }),
      measureThroughput: async () => { throw new Error('status read timed out'); },
    });
    const fresh = emptyDaemonState(master);
    for (let cycle = 0; cycle < 5; cycle++) { await runCycle(master, fresh, failing, () => clock); clock += minute; }
    const attempts = Object.entries(fresh.actions).filter(([key]) => key.startsWith('measurement:throughput:'));
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0][1].attempts, 3, 'three attempts, then the loop stops measuring this release');
    assert.equal(attempts[0][1].state, 'failed');
    assert.equal(fresh.throughput, null, 'a failed measurement is never recorded as taken');

    // A new release measures again: the claim stays verified against what is serving, not what was.
    let secondReleaseCalls = 0;
    const next = stubEffects({
      snapshot: async () => ({ work, now: new Date(clock).toISOString() }),
      observeDeployment: async () => ({ source: 'github-deployment', sha: sha(0x101), at: new Date(clock).toISOString(), reason: null, deployed: work.map(item => item.key), pending: [] }),
      measureThroughput: async ({ sha: observed }) => { secondReleaseCalls++; return { revision: observed, verdict: 'verified' as const, file: 'x.json', reason: `verified against ${observed.slice(0, 12)}` }; },
    });
    await runCycle(master, emptyDaemonState(master), next, () => clock);
    assert.equal(secondReleaseCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test('unit:loop-measurement-wiring — daemonEffects.measureThroughput reads the release from the control plane, asks this checkout for the claim\'s containment, and records what master status reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-measure-root-'));
  const { directory, token } = await privateDirectory();
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'loop@example.com']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'loop']);
    await writeFile(join(root, 'claim.txt'), 'the claim merge\n');
    execFileSync('git', ['-C', root, 'add', 'claim.txt']);
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'claim merge']);
    const claimSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
    await writeFile(join(root, 'claim.txt'), 'a later release carrying it\n');
    execFileSync('git', ['-C', root, 'add', 'claim.txt']);
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'release']);
    const releaseSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();

    const config = configWith(token, 'https://graphyard.example');
    let status: any = { now: new Date(T0).toISOString(), release: { version: '1.2.3', revision: releaseSha } };
    const fetcher = (async (url: any) => {
      assert.equal(String(url), 'https://graphyard.example/api/status');
      return { ok: true, json: async () => status };
    }) as unknown as typeof fetch;
    const claim: Work = deliveredWork({ id: 'claim', key: throughputClaim.item, mergeSha: claimSha });
    const routine: Work = deliveredWork({ id: 'routine', key: 'GY-51', mergeSha: sha(0x51) });
    const effects = daemonEffects(root, config, {
      snapshot: async () => ({ work: [claim, routine], now: new Date(T0).toISOString() }),
      mutate: async () => ({}),
      executor: (() => { throw new Error('no merge in this exercise'); }) as any,
      fetcher,
    });
    const measured = await effects.measureThroughput!({ work: [claim, routine], now: new Date(T0).toISOString(), sha: releaseSha });
    assert.equal(measured.revision, releaseSha);
    const recorded = await readThroughputMeasurement(root);
    assert.ok(recorded);
    assert.equal(recorded!.file, measured.file);
    assert.equal(recorded!.report.deployed.revision, releaseSha);
    assert.equal(recorded!.report.deployed.version, '1.2.3');
    assert.equal(recorded!.report.deployed.origin, 'https://graphyard.example');
    assert.equal(recorded!.report.deployed.containsClaim, true, 'the ancestry is asked of this checkout and it answers');
    assert.equal(recorded!.report.window.basis, 'merge-instant', 'the claim carries no deployment observation, so the weaker window basis is named honestly');

    // A release that moved between the observation and the measurement refuses, so the cursor can
    // never bind a measurement to a release it did not measure.
    status = { now: new Date(T0).toISOString(), release: { version: '1.2.4', revision: sha(0x222) } };
    await assert.rejects(effects.measureThroughput!({ work: [claim], now: new Date(T0).toISOString(), sha: releaseSha }), /not the .* this cycle observed/);

    // The daemon path and the measurement script answer containment identically over the same inputs.
    const cases: { revision: string | null; mergeSha: string; exit: number | null; stderr?: string }[] = [
      { revision: releaseSha, mergeSha: claimSha, exit: null },
      { revision: releaseSha, mergeSha: sha(0x999), exit: 1 },
      { revision: releaseSha, mergeSha: sha(0x999), exit: 128, stderr: 'bad object' },
      { revision: 'unknown', mergeSha: claimSha, exit: null },
    ];
    for (const { revision, mergeSha, exit, stderr } of cases) {
      const mine = await claimContainmentFrom({ revision, mergeSha, claim: 'GY-87', repository: root }, async (): Promise<string> => {
        if (exit) throw Object.assign(new Error(`git exited ${exit}`), { status: exit, stderr: stderr ?? '' });
        return '';
      });
      const script = claimContainment({ revision, mergeSha, claim: 'GY-87', repository: root }, () => ({ status: exit ?? 0, stderr: stderr ? `${stderr}\n` : '' }));
      assert.equal(mine.contains, script.contains, `containment of ${mergeSha.slice(0, 6)} in ${revision?.slice(0, 6)} agrees with the script`);
      assert.equal(mine.reason, script.reason);
    }
    // And the real checkout answers the real question: the claim merge is inside the release, and
    // the release is not inside the claim — a descendant asked in reverse is genuinely not contained.
    assert.deepEqual(await claimContainmentFrom({ revision: releaseSha, mergeSha: claimSha, claim: 'GY-87', repository: root },
      (command, args) => execFileSync(command, args, { encoding: 'utf8' })), { contains: true, reason: null });
    const reversed = await claimContainmentFrom({ revision: claimSha, mergeSha: releaseSha, claim: 'GY-87', repository: root },
      (command, args) => execFileSync(command, args, { encoding: 'utf8' }));
    assert.equal(reversed.contains, false, 'a descendant asked as an ancestor is reported as not contained, not as unknown');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

// --- fixtures -------------------------------------------------------------

async function privateDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-recovery-'));
  const token = join(directory, 'coordinator.token');
  await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  return { directory, token };
}

function config(credentialFile: string): MasterConfig {
  return configWith(credentialFile, 'https://graphyard.example');
}
function configWith(credentialFile: string, url: string): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url, credentialFile, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
}

function deliveredWork({ id, key, mergeSha }: { id: string; key: string; mergeSha: string }): Work {
  return {
    id, key, title: `Delivered ${key}`, description: '', type: 'chore', priority: 2, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: [] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'done', revision: 9, policyRevision: 1, createdAt: new Date(T0 - 4 * hour).toISOString(), updatedAt: new Date(T0 - minute).toISOString(),
    stageEnteredAt: new Date(T0 - minute).toISOString(), ready: true, epoch: 1, lease: null,
    workspaces: [{ epoch: 1, host: 'machine-a', path: '/tmp/w', branch: `graphyard/${key.toLowerCase()}-1` }] as any,
    candidate: null, submission: { epoch: 1, pr: 500 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: null, blocker: null, gates: [], violations: [],
    delivery: { mergedAt: new Date(T0 - 30 * minute).toISOString(), mergedAtRepository: new Date(T0 - 30 * minute).toISOString(), mergeSha, authorizationRevision: 1 },
    implementers: ['worker-principal'],
  } as unknown as Work;
}

const hour = 60 * minute;
const release = (overrides: Partial<DeployedRelease> = {}): DeployedRelease =>
  ({ revision: RELEASE, version: '1.0.0', origin: 'https://graphyard.example', observedAt: new Date(T0).toISOString(), containsClaim: true, reason: null, ...overrides });

function stubEffects(overrides: Partial<DaemonEffects> = {}): DaemonEffects {
  return {
    agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: [], now: new Date(T0).toISOString() }),
    closeSession: () => {},
    dispatch: async () => ({}),
    requestProof: () => {},
    merge: async () => ({ result: 'merge requested' }),
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: new Date(T0).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => ({}),
    requestSmoke: () => {},
    persist: async () => {},
    ...overrides,
  };
}
