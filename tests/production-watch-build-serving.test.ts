import { test } from 'node:test';
import assert from 'node:assert/strict';
import EmbeddedPostgres from 'embedded-postgres';
import { DEPLOYMENT_GRACE_MS, ENDPOINT_FRESH_MS, productionProvider, ProductionWatch } from '../src/production-watch.js';
import { buildIdentity } from '../src/protocol-version.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store, type Store as StoreType } from '../src/store.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// What production serves is observed from the deploy record and the watch alone: a fresh endpoint
// observation of the exact release outranks the provider's newest successful deployment, which
// outranks the running build. Containment is equality alone — there is no ancestry comparison —
// so a delivery is deployed only when production serves its exact merge, and a merge the serving
// commit does not name stays pending, never a missing incident. The production-environment ledger
// record the master once published is no longer read for any of this (GY-3006).

const sha = (index: number) => index.toString(16).padStart(40, '0');
const T0 = Date.parse('2026-10-07T04:45:00Z');

test('unit:production-watch-build-serving — the configured Railway adapter supplies serving state, and without its credentials the build supplies it without external reads', async () => {
  const requests: { url: string; headers: Headers; body: any }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return Response.json({ data: { deployments: { edges: [{ node: {
      id: 'railway-live', status: 'SUCCESS', createdAt: new Date(T0).toISOString(),
      meta: { commitHash: sha(4), branch: 'main' },
    } }] } } });
  };
  const env = { RAILWAY_SERVICE_ID: 'service', RAILWAY_ENVIRONMENT_ID: 'environment' };
  const observe = async (provider: ReturnType<typeof productionProvider>) => {
    const { store } = memoryStore([]);
    return new ProductionWatch(store, { provider, build: buildIdentity({ GRAPHYARD_BUILD_SHA: sha(1) }), baseBranch: 'main', now: () => T0 }).tick(true);
  };
  const unconfigured = productionProvider(env, fetcher);
  assert.equal(unconfigured, null);
  const fallback = await observe(unconfigured);
  assert.equal(fallback.serving, sha(1));
  assert.equal(fallback.servingSource, 'build');
  assert.equal(requests.length, 0, 'no deployment API is read without a configured provider');

  const report = await observe(productionProvider({ ...env, RAILWAY_TOKEN: 'fixture-project-token' }, fetcher));
  assert.equal(report.serving, sha(4));
  assert.equal(report.servingSource, 'provider');
  assert.equal(report.provider, 'railway');
  assert.equal(report.error, null);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://backboard.railway.com/graphql/v2');
  assert.equal(requests[0].headers.get('Project-Access-Token'), 'fixture-project-token');
  assert.deepEqual(requests[0].body.variables.input, { serviceId: 'service', environmentId: 'environment' });
});

/** The ledger queries the watch issues, in memory. */
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
  return { store: { pool, list: async () => work, fleet: async () => work } as unknown as StoreType, events };
}

const deployment = (id: string, status: 'success' | 'failed' | 'building', commit: string | null, ageMs = 3_600_000) =>
  ({ id, status, providerStatus: status.toUpperCase(), commit, branch: null, createdAt: new Date(T0 - ageMs).toISOString(), updatedAt: null, url: null });

/** A watch whose provider lists `deployments` and whose build reports `built`, over delivered `work`. */
function watchOf({ built, work = [], deployments = [] as ReturnType<typeof deployment>[], now = T0 }: { built: number | null; work?: Work[]; deployments?: ReturnType<typeof deployment>[]; now?: number }) {
  const { store, events } = memoryStore(work);
  const provider = deployments.length || built === null ? { name: 'railway', description: 'stub', list: async () => deployments } : null;
  const watch = new ProductionWatch(store, { provider, build: buildIdentity(built === null ? {} : { GRAPHYARD_BUILD_SHA: sha(built) }), baseBranch: 'main', now: () => now });
  return { watch, events };
}

test('unit:production-watch-build-serving — the watch observes the serving commit from the deploy record and the build alone, containment is equality, and no production-environment ledger value is read', { timeout: 120_000 }, async () => {
  // Over /api/status: the watch's newest successful deployment is what production serves, and the
  // production environment the status names is this process's configuration — not the ledger
  // record `POST /api/production-environment` used to write (the route is gone, the read with it).
  {
    const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 3006;
    const database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('production-watch-serving'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
    await database.initialise(); await database.start(); await database.createDatabase('production_watch_serving_test');
    const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/production_watch_serving_test`); await store.init();
    const deployments = [deployment('d-live', 'success', sha(4))];
    const { watch } = watchOf({ built: 1, deployments });
    await watch.tick(true);
    const admin: Principal = { id: 'serving-admin', role: 'admin', sessionKind: 'human' };
    const credential = { ...admin, token: `serving-admin-${'s'.repeat(32)}` };
    const engine = new Engine(store, 120, 'owner/history'); engine.submissionObserver = null;
    const http = server(engine, [credential], null, { production: watch });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    try {
      assert.equal((await store.pool.query("SELECT count(*)::int AS count FROM events WHERE kind='production.environment'")).rows[0].count, 0);
      const readStatus = async (serving = sha(4), source = 'provider') => {
        const response = await fetch(`http://127.0.0.1:${(http.address() as { port: number }).port}/api/status`, { headers: { Authorization: `Bearer ${credential.token}` } });
        assert.equal(response.status, 200);
        const status = await response.json() as { production: { serving: string | null; servingSource: string | null; observedAt: string | null }; productionEnvironment: string };
        assert.equal(status.production.serving, serving, 'the watch records what production serves in status');
        assert.equal(status.production.servingSource, source);
        assert.ok(status.production.observedAt, 'the watch reports when it last looked');
        assert.equal(status.productionEnvironment, 'production', 'status names the process configuration, not the ledger value');
        assert.notEqual(status.productionEnvironment, 'legacy-production');
      };
      await readStatus();
      const removedRoute = await fetch(`http://127.0.0.1:${(http.address() as { port: number }).port}/api/production-environment`, {
        method: 'POST', headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ environment: 'legacy-production' }),
      });
      assert.equal(removedRoute.status, 404, 'the retired environment publication route is not served');
      assert.equal((await store.pool.query("SELECT count(*)::int AS count FROM events WHERE kind='production.environment'")).rows[0].count, 0, 'the retired route writes no environment ledger value');
      // An old installation may retain the ledger value the deleted route once wrote.
      // Status must work both without that record and with a conflicting historical value.
      await store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', ['graphyard', 'production.environment', JSON.stringify({ environment: 'legacy-production' })]);
      await store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', ['graphyard', 'release.candidate.promotion', JSON.stringify({
        candidate: 'legacy-candidate', promotion: { environment: 'production', releaseId: 'legacy-release', sourceSha: sha(2), artifact: 'sha256:legacy', at: new Date(T0).toISOString(), by: 'graphyard' },
      })]);
      await readStatus();
      const delivery = await fetch(`http://127.0.0.1:${(http.address() as { port: number }).port}/api/delivery`, { headers: { Authorization: `Bearer ${credential.token}` } });
      assert.equal(delivery.status, 200);
      assert.deepEqual((await delivery.json()).environments, [], 'historical candidate promotions do not manufacture delivery environments or expected releases');
      // Losing the provider record falls back to the running build, even with conflicting history.
      deployments.length = 0;
      await watch.tick(true);
      await readStatus(sha(1), 'build');
    } finally {
      await new Promise<void>(resolve => http.close(() => resolve()));
      await store.close(); await database.stop();
    }
  }
  // The provider's newest successful deployment outranks the running build: no ancestry is
  // compared, so a record older than the build still stands as what production serves.
  {
    const { watch } = watchOf({ built: 3, deployments: [deployment('d-recorded', 'success', sha(1))] });
    const report = await watch.tick(true);
    assert.equal(report.serving, sha(1));
    assert.equal(report.servingSource, 'provider');
  }
  // With no provider record the build identity serves: /healthz's commit is what the deployment reports.
  {
    const { watch } = watchOf({ built: 4 });
    const report = await watch.tick(true);
    assert.equal(report.serving, sha(4));
    assert.equal(report.servingSource, 'build');
  }
  // A fresh endpoint observation of the exact release outranks both, while it is fresh.
  {
    const work = [{ id: 'work-1', key: 'GY-1400', stage: 'done', delivery: { mergedAt: new Date(T0).toISOString(), mergeSha: sha(2), deployment: { sha: sha(2), mergeSha: sha(2), source: 'endpoint', observedAt: new Date(T0).toISOString(), covers: 'exact', at: new Date(T0).toISOString(), observer: 'master' }, authorizationRevision: 1 } }] as unknown as Work[];
    const { watch, events } = watchOf({ built: 1, work, deployments: [deployment('d-old', 'success', sha(1))] });
    const report = await watch.tick(true);
    assert.equal(report.serving, sha(2), 'the endpoint observation outranks the lagging provider record');
    assert.equal(report.servingSource, 'endpoint');
    // The exact merge production serves is deployed; the containment is on the record.
    assert.deepEqual(report.deployed, ['GY-1400']);
    assert.equal(events.filter(event => event.kind === 'delivery.deployment-contained').length, 1);
    assert.deepEqual(report.pending, []);
  }
  // A delivered merge the serving commit does not name exactly stays pending: without ancestry
  // comparison nothing calls it missing, and no incident is raised for it.
  {
    const work = [{ id: 'work-1', key: 'GY-1400', stage: 'done', delivery: { mergedAt: new Date(T0).toISOString(), mergeSha: sha(2), authorizationRevision: 1 } }] as unknown as Work[];
    const { watch, events } = watchOf({ built: 3, work, deployments: [deployment('d-live', 'success', sha(3))], now: T0 + DEPLOYMENT_GRACE_MS * 10 });
    const report = await watch.tick(true);
    assert.deepEqual(report.pending, ['GY-1400']);
    assert.deepEqual(report.deployed, []);
    assert.deepEqual(report.incidents, []);
    assert.equal(events.filter(event => event.kind === 'delivery.deployment-incident').length, 0);
  }
  // A failed provider attempt for the merge is the incident the watch records; what the provider
  // reported stands beside what production still serves.
  {
    const work = [{ id: 'work-1', key: 'GY-1400', stage: 'done', delivery: { mergedAt: new Date(T0).toISOString(), mergeSha: sha(2), authorizationRevision: 1 } }] as unknown as Work[];
    const { watch } = watchOf({ built: 1, work, deployments: [deployment('d-live', 'success', sha(1)), deployment('d-fail', 'failed', sha(2))] });
    const report = await watch.tick(true);
    assert.deepEqual(report.incidents.map(incident => incident.status), ['failed']);
    assert.match(report.incidents[0].reason, new RegExp(`railway deployment d-fail of ${sha(2).slice(0, 12)} FAILED`));
    assert.match(report.incidents[0].reason, new RegExp(`production still serves ${sha(1).slice(0, 12)}`));
  }
  // A past endpoint observation is stale: the provider's answer stands again.
  {
    const work = [{ id: 'work-1', key: 'GY-1400', stage: 'done', delivery: { mergedAt: new Date(T0 - ENDPOINT_FRESH_MS * 2).toISOString(), mergeSha: sha(2), deployment: { sha: sha(2), mergeSha: sha(2), source: 'endpoint', observedAt: new Date(T0 - ENDPOINT_FRESH_MS * 2).toISOString(), covers: 'exact', at: new Date(T0).toISOString(), observer: 'master' }, authorizationRevision: 1 } }] as unknown as Work[];
    const { watch } = watchOf({ built: 1, work, deployments: [deployment('d-live', 'success', sha(1))] });
    const report = await watch.tick(true);
    assert.equal(report.serving, sha(1));
    assert.equal(report.servingSource, 'provider');
  }
});

// GY-1424's instance, restated for the watch without ancestry comparisons: the build no longer
// outranks a provider record it contains — equality is all the watch can prove — and the record
// stands until the provider's own list catches up or an endpoint observation names the release.
