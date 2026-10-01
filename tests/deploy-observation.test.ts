import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { DEPLOYMENT_GRACE_MS, INCIDENT_EVENT, ProductionWatch, RECOVERY_EVENT, attentionLines, railwayProvider, type DeploymentProvider, type ProviderDeployment } from '../src/production-watch.js';
import { buildIdentity } from '../src/protocol-version.js';
import { buildMasterStatus, controlPlaneAttention, mergeToProductionMs, productionSummary } from '../src/master.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-59 AC-3: after a merge, a failed or missing provider deployment of the merged commit
// becomes a delivery incident within five minutes, master status reports how far main is
// ahead of production with the failing reason, and recovery is recorded when it serves.

let database: EmbeddedPostgres, store: Store;
before(async () => {
  const port = Number(process.env.GRAPHYARD_DEPLOY_OBSERVATION_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 12);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('deploy-observation'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('deploy_observation_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/deploy_observation_test`); await store.init();
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const GOOD = sha('a'), MERGE_ONE = sha('1'), MERGE_TWO = sha('2'), MERGE_THREE = sha('3');
const T0 = Date.parse('2026-09-19T00:00:00Z');
let clock = T0;
async function delivered(key: string, mergeSha: string, mergedAt: number) {
  const id = randomUUID();
  const work = { id, key, title: `Delivered ${key}`, stage: 'done', revision: 3, policyRevision: 1, criteria: [], evidence: [], gates: [], violations: [], dependencies: [], workspaces: [], implementers: [], plannedFiles: [], queueHistory: [], priority: 0, createdAt: new Date(mergedAt - 3_600_000).toISOString(), updatedAt: new Date(mergedAt).toISOString(), stageEnteredAt: new Date(mergedAt).toISOString(), policy: { checks: [], review: false }, delivery: { mergedAt: new Date(mergedAt).toISOString(), mergeSha, authorizationRevision: 2 } };
  await store.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [id, work]);
  return work as unknown as Work;
}
const railway = (deployments: ProviderDeployment[]): DeploymentProvider & { calls: number } => ({ name: 'railway', description: 'stub', calls: 0, async list() { this.calls++; return deployments; } });
const deployment = (id: string, status: ProviderDeployment['status'], providerStatus: string, commit: string | null, createdAt: number): ProviderDeployment => ({ id, status, providerStatus, commit, branch: 'main', createdAt: new Date(createdAt).toISOString(), updatedAt: null, url: `https://railway.app/deployments/${id}` });
/** A GitHub stub that knows the base branch history: GOOD < MERGE_ONE < MERGE_TWO < MERGE_THREE. */
const history = [GOOD, MERGE_ONE, MERGE_TWO, MERGE_THREE];
const github = { requests: [] as string[], async request(path: string) {
  this.requests.push(path);
  const [, from, to] = path.match(/^\/compare\/([^.]+)\.\.\.(.+)$/)!;
  const a = history.indexOf(from), b = to === 'main' ? history.length - 1 : history.indexOf(to);
  if (a < 0 || b < 0) throw new Error(`unknown commit ${from} or ${to}`);
  return { status: b > a ? 'ahead' : b === a ? 'identical' : 'behind', ahead_by: Math.max(0, b - a), commits: history.slice(a + 1, b + 1).map(s => ({ sha: s, commit: { message: `Merge ${s.slice(0, 4)}` } })) };
} };
const events = async (workId: string) => (await store.pool.query('SELECT kind, payload FROM events WHERE work_id=$1 AND kind IN ($2,$3) ORDER BY seq', [workId, INCIDENT_EVENT, RECOVERY_EVENT])).rows;

test('integration:deploy-observation — a failed provider deployment of a merged commit is a delivery incident within five minutes, main is reported ahead of production, and a later successful deployment records recovery', async () => {
  const one = await delivered('GY-201', MERGE_ONE, T0 - 60_000);
  const serving = [deployment('d-good', 'success', 'SUCCESS', GOOD, T0 - 3_600_000)];
  const provider = railway([deployment('d-one', 'failed', 'FAILED', MERGE_ONE, T0 - 30_000), ...serving]);
  const watch = new ProductionWatch(store, { provider, github, build: buildIdentity({ RAILWAY_GIT_COMMIT_SHA: GOOD }), baseBranch: 'main', now: () => clock });
  // Within the grace period, a provider FAILED status is already an incident: the reason is the provider's.
  clock = T0;
  let report = await watch.tick();
  assert.equal(report.serving, GOOD); assert.equal(report.servingSource, 'provider');
  assert.equal(report.ahead?.by, 3);
  assert.deepEqual(report.pending, ['GY-201']);
  assert.equal(report.incidents.length, 1);
  assert.equal(report.incidents[0].status, 'failed'); assert.equal(report.incidents[0].deploymentId, 'd-one');
  assert.match(report.incidents[0].reason, /railway deployment d-one of 111111111111 FAILED \(https:\/\/railway.app\/deployments\/d-one\); production still serves aaaaaaaaaaaa/);
  assert.match(report.attention[0], /^main is 3 commits ahead of production \(serving aaaaaaaaaaaa\): railway deployment d-one .* FAILED/);
  // The incident is in the append-only ledger, on the delivered item, once.
  let ledger = await events(one.id);
  assert.equal(ledger.length, 1); assert.equal(ledger[0].kind, INCIDENT_EVENT); assert.equal(ledger[0].payload.incident.key, 'GY-201');
  // Polling is bounded: a second call inside the poll interval reads nothing and re-records nothing.
  clock = T0 + 10_000; await watch.tick();
  assert.equal(provider.calls, 1); assert.equal((await events(one.id)).length, 1);
  // A minute later the same failure stands: no duplicate incident.
  clock = T0 + 61_000; report = await watch.tick();
  assert.equal(provider.calls, 2); assert.equal((await events(one.id)).length, 1); assert.equal(report.incidents.length, 1);

  // The control plane reports it, and master status raises it as installation attention.
  const engine = new Engine(store, [15368], 120, 'owner/project');
  const http = server(engine, [{ id: 'operator', role: 'admin', token: 'o'.repeat(40) }], null, undefined, { production: watch });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  try {
    const status = await (await fetch(`http://127.0.0.1:${(http.address() as any).port}/api/status`, { headers: { Authorization: `Bearer ${'o'.repeat(40)}` } })).json() as any;
    assert.equal(status.production.serving, GOOD); assert.equal(status.production.incidents[0].key, 'GY-201');
    const installation = controlPlaneAttention(status);
    assert.match(installation.attention[0], /^main is 3 commits ahead of production/);
    assert.equal(installation.production?.summary, 'main is 3 commits ahead of production');
    assert.equal(installation.production?.latestDeployment?.status, 'FAILED');
    const master = buildMasterStatus({ work: [one], now: new Date(clock).toISOString() }, [], [], {}, {}, { pending: [], completed: [] }, 'main', status);
    assert.equal(master.counts.attention, master.controlPlane.attention.length);
    assert.match(master.controlPlane.attention[0], /ahead of production/);
    assert.deepEqual(master.latency.mergeToProduction, { count: 0, p50Ms: 0, p90Ms: 0 });
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); }

  // The provider then serves a commit containing the merge: the incident is recovered, once.
  provider.list = async () => [deployment('d-two', 'success', 'SUCCESS', MERGE_TWO, T0 + 100_000), deployment('d-one', 'failed', 'FAILED', MERGE_ONE, T0 - 30_000), ...serving];
  clock = T0 + 130_000; report = await watch.tick();
  assert.equal(report.serving, MERGE_TWO); assert.deepEqual(report.deployed, ['GY-201']); assert.deepEqual(report.incidents, []);
  assert.equal(report.ahead?.by, 1); assert.deepEqual(report.attention, ['main is 1 commit ahead of production (serving 222222222222)']);
  ledger = await events(one.id);
  assert.deepEqual(ledger.map(row => row.kind), [INCIDENT_EVENT, RECOVERY_EVENT]);
  assert.equal(ledger[1].payload.incidentId, ledger[0].payload.incident.id);
  clock = T0 + 200_000; await watch.tick();
  assert.equal((await events(one.id)).length, 2);
});

test('integration:deploy-observation — a merged commit with no deployment at all is a missing-deployment incident after the grace period, and the ledger restores open incidents on restart', async () => {
  const three = await delivered('GY-203', MERGE_THREE, T0 + 300_000);
  // No provider token: the watch falls back to the build identity of this process, which is behind.
  const watch = new ProductionWatch(store, { provider: null, github, build: buildIdentity({ GRAPHYARD_BUILD_SHA: MERGE_TWO }), baseBranch: 'main', now: () => clock });
  clock = T0 + 300_000 + DEPLOYMENT_GRACE_MS - 1_000;
  let report = await watch.tick();
  assert.equal(report.servingSource, 'build');
  assert.deepEqual(report.pending, ['GY-203']); assert.deepEqual(report.incidents, [], 'inside the grace period nothing is missing yet');
  assert.equal((await events(three.id)).length, 0);
  clock = T0 + 300_000 + DEPLOYMENT_GRACE_MS + 60_000;
  report = await watch.tick();
  assert.equal(report.incidents.length, 1); assert.equal(report.incidents[0].status, 'missing');
  assert.match(report.incidents[0].reason, /no deployment of 333333333333 was observed within 5 minutes of the merge; production serves 222222222222, which does not contain it\. Configure RAILWAY_API_TOKEN/);
  assert.match(report.attention[0], /^main is 1 commit ahead of production \(serving 222222222222\): no deployment of 333333333333/);
  assert.equal((await events(three.id)).length, 1);
  // A new process reads the open incident back from the ledger instead of raising it again.
  const restarted = new ProductionWatch(store, { provider: null, github, build: buildIdentity({ GRAPHYARD_BUILD_SHA: MERGE_TWO }), baseBranch: 'main', now: () => clock });
  await restarted.load();
  assert.equal(restarted.status().incidents[0].key, 'GY-203');
  clock += 120_000; await restarted.tick();
  assert.equal((await events(three.id)).length, 1, 'the restarted watch did not re-record the standing incident');
  // Provider unavailability is reported, never thrown, and does not invent incidents.
  const broken = new ProductionWatch(store, { provider: { name: 'railway', description: 'stub', list: async () => { throw new Error('502 from Railway'); } }, github, build: buildIdentity({ GRAPHYARD_BUILD_SHA: MERGE_THREE }), baseBranch: 'main', now: () => clock });
  const degraded = await broken.tick();
  assert.equal(degraded.error, 'railway deployment list is unavailable: 502 from Railway');
  assert.equal(degraded.serving, MERGE_THREE); assert.deepEqual(degraded.incidents.filter(i => i.key === 'GY-203'), []);
  assert.ok(degraded.attention.includes(degraded.error!));
});

test('integration:deploy-observation — the Railway provider reads the deployment list for the linked service and the master summary carries merge-to-production latency', async () => {
  const requests: any[] = [];
  const fetcher = (async (url: string, init: any) => { requests.push({ url, init }); return { ok: true, status: 200, json: async () => ({ data: { deployments: { edges: [
    { node: { id: 'dep-1', status: 'CRASHED', createdAt: '2026-09-19T00:10:00Z', updatedAt: null, url: 'https://x', meta: { commitHash: MERGE_ONE.toUpperCase(), branch: 'main' } } },
    { node: { id: 'dep-0', status: 'SUCCESS', createdAt: '2026-09-19T00:00:00Z', meta: { commitHash: GOOD, branch: 'main' } } },
    { node: { id: 'dep-x', status: 'SUCCESS', createdAt: '2026-09-19T00:05:00Z', meta: { commitHash: 'not-a-sha' } } },
  ] } } }) }; }) as unknown as typeof fetch;
  assert.equal(railwayProvider({}, fetcher), null, 'no token means no provider');
  assert.equal(railwayProvider({ RAILWAY_API_TOKEN: 't', RAILWAY_SERVICE_ID: 's' }, fetcher), null, 'the environment id is required');
  const provider = railwayProvider({ RAILWAY_API_TOKEN: 'account-token', RAILWAY_SERVICE_ID: 'svc', RAILWAY_ENVIRONMENT_ID: 'env', RAILWAY_PROJECT_ID: 'prj' }, fetcher)!;
  assert.equal(provider.description, 'Railway service svc, environment env');
  const listed = await provider.list();
  assert.equal(requests[0].url, 'https://backboard.railway.com/graphql/v2');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer account-token');
  assert.deepEqual(JSON.parse(requests[0].init.body).variables, { input: { serviceId: 'svc', environmentId: 'env', projectId: 'prj' }, first: 25 });
  assert.deepEqual(listed.map(d => [d.id, d.status, d.providerStatus, d.commit]), [['dep-1', 'crashed', 'CRASHED', MERGE_ONE], ['dep-0', 'success', 'SUCCESS', GOOD], ['dep-x', 'success', 'SUCCESS', null]]);
  const projectScoped = railwayProvider({ RAILWAY_TOKEN: 'project-token', RAILWAY_SERVICE_ID: 'svc', RAILWAY_ENVIRONMENT_ID: 'env', GRAPHYARD_RAILWAY_API: 'https://stub.example/graphql' }, fetcher)!;
  await projectScoped.list();
  assert.equal(requests[1].url, 'https://stub.example/graphql'); assert.equal(requests[1].init.headers['Project-Access-Token'], 'project-token');
  const refused = railwayProvider({ RAILWAY_API_TOKEN: 't', RAILWAY_SERVICE_ID: 's', RAILWAY_ENVIRONMENT_ID: 'e' }, (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch)!;
  await assert.rejects(refused.list(), /Railway API answered 401/);

  // Merge-to-production latency reads the observed deployment against the repository merge instant.
  const work = { stage: 'done', delivery: { mergedAt: '2026-09-19T00:00:10Z', mergedAtRepository: '2026-09-19T00:00:00Z', mergeSha: MERGE_ONE, authorizationRevision: 1, deployment: { sha: MERGE_ONE, mergeSha: MERGE_ONE, source: 'endpoint', observedAt: '2026-09-19T00:04:00Z', covers: 'exact', at: '2026-09-19T00:04:01Z', observer: 'master' } } } as unknown as Work;
  assert.equal(mergeToProductionMs(work), 240_000);
  assert.equal(mergeToProductionMs({ ...work, delivery: { ...work.delivery, deployment: undefined } } as Work), null);
  const status = buildMasterStatus({ work: [{ ...work, key: 'GY-1', title: 't', createdAt: '2026-09-18T00:00:00Z', stageEnteredAt: '2026-09-19T00:00:00Z', gates: [], policy: { checks: [], review: false }, workspaces: [], queueHistory: [], dependencies: [], criteria: [], evidence: [], violations: [] } as unknown as Work], now: '2026-09-19T01:00:00Z' }, [], [], {}, {}, { pending: [], completed: [] }, 'main');
  assert.deepEqual(status.latency.mergeToProduction, { count: 1, p50Ms: 240_000, p90Ms: 240_000 });
  // The summary lines an operator reads, with and without a provider reason.
  assert.deepEqual(attentionLines({ ahead: { by: 0, head: null, commits: [] }, aheadError: null, serving: GOOD, incidents: [], error: null, latest: null, provider: 'railway' }), []);
  assert.equal(productionSummary({ ahead: { by: 0, head: null, commits: [] }, serving: GOOD }).summary, 'production serves the base branch tip');
  assert.equal(productionSummary({ aheadError: 'Base branch comparison needs the GitHub App' }).summary, 'Base branch comparison needs the GitHub App');
});
