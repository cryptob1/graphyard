import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEPLOYMENT_GRACE_MS, ProductionWatch } from '../src/production-watch.js';
import { productionSummary } from '../src/master/attention.js';
import { buildIdentity } from '../src/protocol-version.js';
import type { Store } from '../src/store.js';
import type { Work } from '../src/model.js';

// GY-1424: on 2026-10-07 production already served release/production's e8b8ee9c9bd2 (/healthz
// commit, a successful Railway deployment, verify-deployment recording exact coverage), yet the
// watch kept reporting 3f241a69a0b3 because it took `serving` from the provider's newest successful
// GitHub deployment record over the running build. A running build that contains the provider's
// record is what production serves; a running build older than the record leaves the record standing.

const sha = (index: number) => index.toString(16).padStart(40, '0');
const T0 = Date.parse('2026-10-07T04:45:00Z');

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
  return { store: { pool, list: async () => work, fleet: async () => work } as unknown as Store, events };
}

/**
 * A linear history sha(0) < sha(1) < … < sha(main): the provider's newest successful record is of
 * `recorded`, the running build reports `built`, and release/production (when given) stands at `tip`
 * with the delivery merged at `merged`.
 */
function watchOf({ recorded, built, tip, merged, main = 4 }: { recorded: number; built: number; tip: number | null; merged: number; main?: number }) {
  const work = [{ id: 'work-1', key: 'GY-1400', stage: 'done', delivery: { mergedAt: new Date(T0).toISOString(), mergeSha: sha(merged), authorizationRevision: 1 } }] as unknown as Work[];
  const { store, events } = memoryStore(work);
  const compares: string[] = [];
  const compare = (base: string, head: string) => {
    compares.push(`${base}...${head}`);
    const a = parseInt(base, 16), b = head === 'main' ? main : parseInt(decodeURIComponent(head), 16);
    return { status: b > a ? 'ahead' : b === a ? 'identical' : 'behind', ahead_by: Math.max(0, b - a) };
  };
  const request = async (path: string) => {
    if (path.startsWith('/branches/')) { if (tip === null) throw Object.assign(new Error('failed (404)'), { status: 404 }); return { commit: { sha: sha(tip) } }; }
    const [, from, to] = path.match(/^\/compare\/([0-9a-f]{40})\.\.\.([^?]+)/)!;
    return compare(from, to);
  };
  const github = { request, contains: async (base: string, head: string) => ['ahead', 'identical'].includes(compare(base, head).status), aheadBy: async (base: string, head: string) => compare(base, head).ahead_by };
  const provider = { name: 'github', description: 'stub', list: async () => [
    { id: 'd-recorded', status: 'success' as const, providerStatus: 'SUCCESS', commit: sha(recorded), branch: null, createdAt: new Date(T0 - 3_600_000).toISOString(), updatedAt: null, url: null }] };
  let clock = T0;
  const watch = new ProductionWatch(store, { provider, github, build: buildIdentity({ GRAPHYARD_BUILD_SHA: sha(built) }), baseBranch: 'main', releaseBranch: 'release/production', now: () => clock });
  return { watch, events, compares, at: (ms: number) => { clock = T0 + ms; } };
}

test('unit:production-watch-build-commit-serving — a running build that contains the provider\'s record is served (servingSource build): no release-ahead attention, no deployment incident; a build older than the record leaves the record serving', async () => {
  // The GY-1424 instance: release/production at sha(3), the build serving sha(3), GitHub's record still of sha(1).
  {
    const { watch, events, at } = watchOf({ recorded: 1, built: 3, tip: 3, merged: 3 });
    await watch.tick(true);
    at(DEPLOYMENT_GRACE_MS + 60_000);
    const report = await watch.tick(true);
    assert.equal(report.serving, sha(3), 'the running build outranks the lagging provider record');
    assert.equal(report.servingSource, 'build');
    assert.deepEqual(report.incidents, []);
    assert.equal(events.filter(event => event.kind === 'delivery.deployment-incident').length, 0);
    assert.deepEqual(report.deployed, ['GY-1400']);
    assert.deepEqual(report.attention, [], 'no release-ahead attention');
    assert.deepEqual(productionSummary(report).attention, [], 'master status raises nothing either');
  }
  // A build past the record but short of the promoted tip still reports the build: production serves
  // sha(2), not the record's sha(1), and the release-ahead line names the commit actually served.
  {
    const { watch, at } = watchOf({ recorded: 1, built: 2, tip: 3, merged: 3 });
    await watch.tick(true);
    at(DEPLOYMENT_GRACE_MS + 60_000);
    const report = await watch.tick(true);
    assert.equal(report.serving, sha(2));
    assert.equal(report.servingSource, 'build');
    assert.deepEqual(report.incidents.map(incident => incident.status), ['missing'], 'the promoted merge is genuinely unserved');
    assert.match(report.incidents[0].reason, new RegExp(`production serves ${sha(2).slice(0, 12)}`));
  }
  // No release branch: the build containing the record is served and main is measured from the build.
  {
    const { watch, at } = watchOf({ recorded: 1, built: 4, tip: null, merged: 4 });
    await watch.tick(true);
    at(DEPLOYMENT_GRACE_MS + 60_000);
    const report = await watch.tick(true);
    assert.equal(report.serving, sha(4)); assert.equal(report.servingSource, 'build');
    assert.equal(report.ahead?.by, 0);
    assert.deepEqual(report.incidents, []); assert.deepEqual(report.attention, []);
  }
  // A running build older than the provider's record: the record stands as serving.
  {
    const { watch, at } = watchOf({ recorded: 3, built: 1, tip: 3, merged: 3 });
    await watch.tick(true);
    at(DEPLOYMENT_GRACE_MS + 60_000);
    const report = await watch.tick(true);
    assert.equal(report.serving, sha(3), 'the provider commit is still reported');
    assert.equal(report.servingSource, 'provider');
    assert.deepEqual(report.incidents, []);
  }
  // An unmoved build/record pair is compared once, not on every pass.
  {
    const { watch, compares, at } = watchOf({ recorded: 1, built: 4, tip: null, merged: 4 });
    await watch.tick(true);
    const first = compares.filter(pair => pair === `${sha(1)}...${sha(4)}`).length;
    at(60_000); await watch.tick(true);
    at(120_000); await watch.tick(true);
    assert.equal(compares.filter(pair => pair === `${sha(1)}...${sha(4)}`).length, first, 'the containment of the record in the build is memoized');
  }
});
