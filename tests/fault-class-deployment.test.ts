import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProductionWatch } from '../src/production-watch.js';
import { productionSummary } from '../src/master/attention.js';
import { statusFaults } from '../src/model/fault-classes.js';
import { buildIdentity } from '../src/protocol-version.js';
import type { Store } from '../src/store.js';
import type { Work } from '../src/model.js';

// GY-1207 names this file for its proof: manual:fault-class-deployment. The master loop filed 3
// deployment faults in 24 hours, each the bare line "main is N commits ahead of production
// (serving X)". Production does not deploy main: it tracks release/production, which only
// `graphyard release promote` moves, so every merge awaiting the next cut and promotion was counted
// as an unserved deployment. The shared cause is a production watch blind to the release branch.
// Each instance is reproduced against the base (the watch measured against main) and shown not to
// recur once the watch measures production against the release branch it deploys.

const RELEASE = 'release/production';
const T0 = Date.parse('2026-10-04T12:00:00Z');
const instances = [
  { at: '2026-10-04T15:04:11.201Z', ahead: 17, serving: 'a7f6da24bba0ff8212e17c100c211513fbfc3de7' },
  { at: '2026-10-04T16:16:30.838Z', ahead: 6, serving: '8a0afd8247efeca3993da36ccdeb8acdec2ad6e5' },
  { at: '2026-10-04T17:49:04.360Z', ahead: 3, serving: '7e121476c4839bca4599d150383e0d41fe3b396a' },
];

/** The ledger the watch reads and writes, in memory. */
function memoryStore(work: Work[]) {
  const events: { seq: number; work_id: string | null; kind: string; payload: any }[] = [];
  const pool = { async query(sql: string, params: any[] = []) {
    if (sql.startsWith('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL')) { events.push({ seq: events.length + 1, work_id: null, kind: params[1], payload: JSON.parse(params[2]) }); return { rows: [] }; }
    if (sql.startsWith('INSERT INTO events')) { events.push({ seq: events.length + 1, work_id: params[0], kind: params[2], payload: JSON.parse(params[3]) }); return { rows: [] }; }
    if (sql.includes('kind IN ($1,$2)')) return { rows: events.filter(row => row.kind === params[0] || row.kind === params[1]).reverse() };
    if (sql.includes('kind=$1')) return { rows: events.filter(row => row.kind === params[0]).reverse() };
    throw new Error(`unexpected query ${sql}`);
  } };
  return { store: { pool, list: async () => work } as unknown as Store, events };
}

/**
 * A linear main: commit 0 is the serving release, commits 1..ahead are the merges after it.
 * `release` is the index release/production points at, or null for a repository without the branch.
 */
function repository(serving: string, ahead: number) {
  const commits = [serving, ...Array.from({ length: ahead }, (_, index) => (index + 1).toString(16).padStart(40, 'f'))];
  const state = { release: 0 as number | null, failing: false };
  const index = (ref: string) => {
    const decoded = decodeURIComponent(ref);
    if (decoded === 'main') return ahead;
    if (decoded === RELEASE) { if (state.release === null) throw new Error('GitHub answered (404)'); return state.release; }
    const found = commits.indexOf(decoded);
    if (found < 0) throw new Error(`unknown commit ${decoded}`);
    return found;
  };
  const request = async (path: string): Promise<any> => {
    if (state.failing) throw new Error('GitHub answered (502)');
    const branch = path.match(/^\/branches\/(.+)$/);
    if (branch) return { name: decodeURIComponent(branch[1]), commit: { sha: commits[index(branch[1])] } };
    const [, from, to] = path.match(/^\/compare\/([^.]+)\.\.\.([^?]+)/)!;
    const a = index(from), b = index(to);
    return { status: b > a ? 'ahead' : b === a ? 'identical' : 'behind', ahead_by: Math.max(0, b - a) };
  };
  const github = { request,
    contains: async (base: string, head: string) => { const answer = await request(`/compare/${base}...${head}`); return answer.status === 'ahead' || answer.status === 'identical'; },
    aheadBy: async (base: string, head: string) => (await request(`/compare/${base}...${encodeURIComponent(head)}`)).ahead_by };
  return { commits, state, github };
}

/** The deliveries main holds past the serving release, ten seconds apart, the newest ten seconds before the instance. */
function deliveries(commits: string[], at: number): Work[] {
  return commits.slice(1).map((mergeSha, index) => ({ id: `work-${index + 1}`, key: `GY-${2000 + index}`, stage: 'done',
    delivery: { mergedAt: new Date(at - (commits.length - 1 - index) * 10_000).toISOString(), mergeSha, authorizationRevision: 1 } }) as unknown as Work);
}

/** What the loop counts: the deployment-class faults master status reports for production. */
const deploymentFaults = (report: Parameters<typeof productionSummary>[0]) => statusFaults({ github: {}, production: productionSummary(report) }).filter(fault => fault.faultClass === 'deployment');

function setup(instance: typeof instances[number], releaseBranch: string | null) {
  const at = Date.parse(instance.at);
  const repo = repository(instance.serving, instance.ahead);
  const { store, events } = memoryStore(deliveries(repo.commits, at));
  let clock = at;
  const provider = { name: 'railway', description: 'stub', list: async () => [{ id: 'd-serving', status: 'success' as const, providerStatus: 'SUCCESS', commit: instance.serving, branch: releaseBranch ?? 'main', createdAt: new Date(T0).toISOString(), updatedAt: null, url: null }] };
  const watch = new ProductionWatch(store, { provider, github: repo.github, build: buildIdentity({}), baseBranch: 'main', releaseBranch, now: () => clock });
  return { watch, repo, events, advance: (ms: number) => { clock += ms; } };
}

for (const [number, instance] of instances.entries()) {
  const text = `main is ${instance.ahead} commits ahead of production (serving ${instance.serving.slice(0, 12)})`;

  test(`manual:fault-class-deployment — GY-1207 instance ${number + 1} (${instance.at}) reproduces against the base: a watch measured against main counts the merges awaiting a release as a deployment fault`, async () => {
    const { watch, advance } = setup(instance, null);
    let report = await watch.tick(true);
    assert.deepEqual(deploymentFaults(report).map(fault => fault.text), [text], 'the instance line, exactly as the loop recorded it');
    // Past the grace period the base escalates the same pipeline lag into missing-deployment incidents.
    advance(2 * 3_600_000);
    report = await watch.tick(true);
    assert.equal(report.incidents.length, instance.ahead);
    assert.ok(deploymentFaults(report).length > 0);
  });

  test(`manual:fault-class-deployment — GY-1207 instance ${number + 1} (${instance.at}) does not recur against the candidate: merges awaiting the next promotion are pipeline lag, not a fault`, async () => {
    const { watch, events, advance } = setup(instance, RELEASE);
    for (const elapsed of [0, 10 * 60_000, 6 * 3_600_000]) {
      advance(elapsed);
      const report = await watch.tick(true);
      assert.deepEqual(deploymentFaults(report), [], `no deployment fault ${elapsed / 60_000} minutes in`);
      assert.deepEqual(report.attention, []);
      assert.deepEqual(report.incidents, []);
      assert.equal(report.pending.length, instance.ahead, 'each merge stays pending until a release holds it');
      assert.equal(report.ahead?.by, 0, 'production serves the promoted release');
      assert.equal(report.release?.unreleased, instance.ahead, 'the lag behind main is reported, as information');
      assert.match(productionSummary(report).summary, new RegExp(`production serves ${RELEASE}; main is ${instance.ahead} commits ahead of it, awaiting the next release`));
    }
    assert.equal(events.filter(event => event.kind === 'delivery.deployment-incident').length, 0);
  });
}

test('manual:fault-class-deployment — a promoted release production does not serve within the grace period is still a deployment fault, and its deliveries become missing incidents', async () => {
  const instance = instances[0];
  const { watch, repo, advance } = setup(instance, RELEASE);
  await watch.tick(true);
  // `graphyard release promote` moves release/production to the tenth merge; production keeps serving the old release.
  repo.state.release = 10;
  let report = await watch.tick(true);
  assert.deepEqual(deploymentFaults(report), [], 'a fresh promotion has the grace period to deploy');
  assert.equal(report.ahead?.by, 10);
  advance(6 * 60_000);
  report = await watch.tick(true);
  const faults = deploymentFaults(report).map(fault => fault.text);
  assert.match(faults[0], new RegExp(`^${RELEASE} \\(${repo.commits[10].slice(0, 12)}\\) is 10 commits ahead of production \\(serving ${instance.serving.slice(0, 12)}\\) since `));
  assert.equal(report.incidents.length, 10, 'only the merges the promoted release holds are missing');
  assert.ok(report.incidents.every(incident => incident.status === 'missing' && /its promotion to release\/production/.test(incident.reason)));
});

test('manual:fault-class-deployment — a failed provider deployment of the promoted release stays a deployment fault', async () => {
  const instance = instances[2];
  const repo = repository(instance.serving, instance.ahead);
  repo.state.release = 2;
  const at = Date.parse(instance.at);
  const { store } = memoryStore(deliveries(repo.commits, at));
  const provider = { name: 'railway', description: 'stub', list: async () => [
    { id: 'd-failed', status: 'failed' as const, providerStatus: 'FAILED', commit: repo.commits[2], branch: RELEASE, createdAt: new Date(at).toISOString(), updatedAt: null, url: null },
    { id: 'd-serving', status: 'success' as const, providerStatus: 'SUCCESS', commit: instance.serving, branch: RELEASE, createdAt: new Date(T0).toISOString(), updatedAt: null, url: null }] };
  const watch = new ProductionWatch(store, { provider, github: repo.github, build: buildIdentity({}), baseBranch: 'main', releaseBranch: RELEASE, now: () => at });
  const report = await watch.tick(true);
  assert.deepEqual(report.incidents.map(incident => [incident.key, incident.status]), [['GY-2000', 'failed'], ['GY-2001', 'failed']], 'the two released merges failed; the third awaits a release');
  assert.ok(deploymentFaults(report).some(fault => /Production has not deployed GY-2000: railway deployment d-failed/.test(fault.text)));
});

test('manual:fault-class-deployment — without a release branch production is measured against main as before, and an unreadable release branch never falls back to main', async () => {
  const instance = instances[1];
  const missing = setup(instance, RELEASE);
  missing.repo.state.release = null;
  let report = await missing.watch.tick(true);
  assert.equal(report.release, null);
  assert.deepEqual(deploymentFaults(report).map(fault => fault.text), [`main is ${instance.ahead} commits ahead of production (serving ${instance.serving.slice(0, 12)})`]);

  const flaky = setup(instance, RELEASE);
  flaky.repo.state.failing = true;
  flaky.advance(2 * 3_600_000);
  report = await flaky.watch.tick(true);
  assert.deepEqual(report.incidents, [], 'a GitHub failure is not evidence of a missed deployment');
  assert.ok(deploymentFaults(report).every(fault => !/^main is/.test(fault.text)));
});
