import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CONTAINED_EVENT, DEPLOYMENT_GRACE_MS, PENDING_EVENT, ProductionWatch, attentionLines, startProductionWatch, type ProductionReport } from '../src/production-watch.js';
// A namespace import, so the GY-1327 cases fail one by one (not the whole file) against a base without these exports.
import * as productionWatch from '../src/production-watch.js';
import { controlPlaneAttention, productionSummary, type ControlPlaneStatus } from '../src/master/attention.js';
import { classifyAttention, statusFaults, trackFaults, type FaultRecord } from '../src/model/fault-classes.js';
import { startReconciliation } from '../src/server/main.js';
import { GitHub, comparePage } from '../src/github.js';
import { events as eventsTable } from '../src/store/tables/work.js';
import { buildIdentity } from '../src/protocol-version.js';
import type { Store } from '../src/store.js';
import type { Work } from '../src/model.js';

// GY-186: production.tick used to compare every delivery again after each deploy, fetch the full
// serving...main compare every minute, and run inside the serial reconciliation tick, holding
// engine.reconcile, the delivery sweep and the job queue for minutes.

const sha = (index: number) => index.toString(16).padStart(40, '0');
const T0 = Date.parse('2026-09-24T12:00:00Z');

/** The ledger and work items the watch reads, in memory: only the queries the watch issues. */
function memoryStore(work: Work[]) {
  const events: { seq: number; work_id: string | null; kind: string; payload: any }[] = [];
  const reads: { sql: string; params: any[] }[] = [];
  const pool = { async query(sql: string, params: any[] = []) {
    if (sql.startsWith('SELECT')) reads.push({ sql, params });
    if (sql.startsWith('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL')) { events.push({ seq: events.length + 1, work_id: null, kind: params[1], payload: JSON.parse(params[2]) }); return { rows: [] }; }
    if (sql.startsWith('INSERT INTO events')) { events.push({ seq: events.length + 1, work_id: params[0], kind: params[2], payload: JSON.parse(params[3]) }); return { rows: [] }; }
    const limit = Number(sql.match(/LIMIT (\d+)/)?.[1] ?? Infinity);
    if (sql.includes('kind IN ($1,$2)')) return { rows: events.filter(row => row.kind === params[0] || row.kind === params[1]).reverse().slice(0, limit) };
    if (sql.includes('kind=$1')) return { rows: events.filter(row => row.kind === params[0]).reverse().slice(0, limit) };
    throw new Error(`unexpected query ${sql}`);
  } };
  return { store: { pool, list: async () => work, fleet: async () => work } as unknown as Store, events, reads };
}
function delivered(count: number): Work[] {
  return Array.from({ length: count }, (_, index) => ({ id: `work-${index + 1}`, key: `GY-${index + 1}`, stage: 'done',
    delivery: { mergedAt: new Date(T0 - (count - index) * 600_000).toISOString(), mergeSha: sha(index + 1), authorizationRevision: 1 } }) as unknown as Work);
}
/** GitHub over a linear base branch sha(0) < sha(1) < … < sha(tip): every compare it answers is counted, nothing is memoized. */
function linearGitHub(tip: number) {
  const compares: string[] = [];
  const request = async (path: string) => {
    compares.push(path);
    const [, from, to] = path.match(/^\/compare\/([0-9a-f]{40})\.\.\.([^?]+)/)!;
    const a = parseInt(from, 16), b = to === 'main' ? tip : parseInt(to, 16);
    return { status: b > a ? 'ahead' : b === a ? 'identical' : 'behind', ahead_by: Math.max(0, b - a) };
  };
  return { compares, request,
    contains: async (base: string, head: string) => { const answer = await request(`/compare/${base}...${head}?per_page=1`); return answer.status === 'ahead' || answer.status === 'identical'; },
    aheadBy: async (base: string, head: string) => (await request(`/compare/${base}...${head}?per_page=1`)).ahead_by };
}
const serving = (commit: string) => ({ name: 'railway', description: 'stub', list: async () => [{ id: `d-${commit.slice(-4)}`, status: 'success' as const, providerStatus: 'SUCCESS', commit, branch: 'main', createdAt: new Date(T0 - 3_600_000).toISOString(), updatedAt: null, url: null }] });
const isAheadBy = (path: string) => path.includes('...main');

test('unit:containment-monotonic — over 150 delivered items a new serving SHA costs at most (pending items + 1) compares, an unchanged one no containment compares, and recorded containment survives a restart', async () => {
  const work = delivered(150);
  const { store, events, reads } = memoryStore(work);
  const github = linearGitHub(150);
  let clock = T0, release = sha(140);
  const provider = { name: 'railway', description: 'stub', list: () => serving(release).list() };
  const options = { provider, github, build: buildIdentity({}), baseBranch: 'main', now: () => clock };
  const watch = new ProductionWatch(store, options);

  // The first pass knows nothing yet: it establishes containment for the history once.
  let report = await watch.tick();
  assert.equal(report.serving, sha(140));
  assert.equal(report.deployed.length, 140); assert.equal(report.pending.length, 10);
  assert.equal(events.filter(event => event.kind === CONTAINED_EVENT).length, 140, 'each delivery inside the release is recorded once');

  // Unchanged serving SHA: no containment compare at all; only the count of how far main is ahead.
  github.compares.length = 0; clock += 61_000;
  report = await watch.tick();
  assert.deepEqual(github.compares.filter(path => !isAheadBy(path)), [], 'an unchanged serving SHA makes no containment compares');
  assert.equal(github.compares.length, 1);
  assert.equal(report.deployed.length, 140); assert.equal(report.pending.length, 10);

  // A new serving SHA: the 140 recorded deliveries are not compared again; each pending one is, once.
  let pending = report.pending.length;
  github.compares.length = 0; clock += 61_000; release = sha(145);
  report = await watch.tick();
  assert.ok(github.compares.length <= pending + 1, `${github.compares.length} compares for ${pending} pending items`);
  assert.equal(report.deployed.length, 145); assert.equal(report.pending.length, 5);
  for (const item of work.slice(0, 140)) assert.ok(!github.compares.some(path => path.includes(item.delivery!.mergeSha)), `${item.key} was recorded contained and is never compared again`);
  assert.equal(events.filter(event => event.kind === CONTAINED_EVENT).length, 145);

  // A restart while production still serves the same commit (a config-only restart, a failed
  // rollout, a crash loop) restores the negative answers too: no containment compare at all.
  github.compares.length = 0; clock += 61_000;
  const sameRelease = new ProductionWatch(store, options);
  report = await sameRelease.tick();
  assert.deepEqual(github.compares.filter(path => !isAheadBy(path)), [], 'a restart at an unchanged serving SHA makes no containment compares');
  assert.equal(report.deployed.length, 145); assert.equal(report.pending.length, 5);
  const pendingRecords = events.filter(event => event.kind === PENDING_EVENT);
  assert.deepEqual(pendingRecords.at(-1)!.payload.workIds, work.slice(145).map(item => item.id).sort(), 'the pending set is recorded with its serving SHA');
  assert.equal(pendingRecords.at(-1)!.payload.serving, sha(145));
  clock += 61_000; await sameRelease.tick();
  assert.equal(events.filter(event => event.kind === PENDING_EVENT).length, pendingRecords.length, 'an unchanged pending set is not recorded again');

  // With no pending record at all (the steady state) the startup lookup must not walk the whole
  // ledger: it is a range on insertion time bounded by the window, answered by events_deployment_pending.
  const pendingRead = reads.findLast(read => read.params[0] === PENDING_EVENT)!;
  assert.match(pendingRead.sql, /created_at >= \$2 ORDER BY created_at DESC/, 'the pending lookup is bounded by insertion time');
  assert.equal(pendingRead.params[1], new Date(clock - 61_000 - 15 * 86_400_000).toISOString(), 'bounded by the watch window');

  // Every deploy restarts the process: the record is the ledger, so a new watch at a new serving
  // SHA still compares only what was pending.
  pending = report.pending.length;
  github.compares.length = 0; clock += 61_000; release = sha(150);
  const restarted = new ProductionWatch(store, options);
  report = await restarted.tick();
  assert.ok(github.compares.length <= pending + 1, `${github.compares.length} compares after a restart for ${pending} pending items`);
  assert.equal(report.deployed.length, 150); assert.deepEqual(report.pending, []);
  github.compares.length = 0; clock += 61_000;
  await restarted.tick();
  assert.deepEqual(github.compares.filter(path => !isAheadBy(path)), []);

  // A restart restores every containment record in the window, however many there are: with more
  // than 5,000 contained deliveries none is compared or recorded again.
  const many = delivered(6_000), ledger = memoryStore(many), wide = linearGitHub(6_000);
  for (const item of many) ledger.events.push({ seq: ledger.events.length + 1, work_id: item.id, kind: CONTAINED_EVENT, payload: { key: item.key, mergeSha: item.delivery!.mergeSha, serving: sha(6_000) } });
  const large = await new ProductionWatch(ledger.store, { provider: serving(sha(6_000)), github: wide, build: buildIdentity({}), baseBranch: 'main', windowMs: 60 * 86_400_000, now: () => T0 }).tick();
  assert.equal(large.deployed.length, 6_000);
  assert.deepEqual(wide.compares.filter(path => !isAheadBy(path)), [], 'no restored delivery is compared again');
  assert.equal(ledger.events.length, 6_000, 'no containment is recorded twice');
});

test('the startup containment reads are answered by partial indexes on their own event kinds, not a scan of the window', () => {
  // load() runs before the server listens, on every restart; each read must touch only its own records.
  assert.ok(eventsTable.ddl.includes(`CREATE INDEX IF NOT EXISTS events_deployment_contained ON events(work_id,seq DESC)\n  WHERE kind='${CONTAINED_EVENT}'`));
  assert.ok(eventsTable.ddl.includes(`CREATE INDEX IF NOT EXISTS events_deployment_pending ON events(created_at DESC,seq DESC)\n  WHERE kind='${PENDING_EVENT}'`));
});

test('unit:ahead-by-minimal — the ahead-by read asks GitHub for the count only: one commit per page, no commit or file lists read', async () => {
  const adapter = new GitHub({ repository: 'owner/project', base: 'main', appId: 1, installationId: 2, privateKey: 'not-used' });
  const requests: string[] = [];
  // As GitHub answers: the counts on every page, the changed-file list only on the first.
  adapter.request = async (path: string) => {
    requests.push(path);
    const page = Number(new URL(path, 'https://api.github.com').searchParams.get('page') ?? 1);
    return { status: 'ahead', ahead_by: 7, total_commits: 7, commits: page <= 7 ? [{ sha: sha(99), commit: { message: 'x' } }] : [], ...(page === 1 ? { files: [{ filename: 'src/a.ts' }] } : {}) };
  };
  const work = delivered(1);
  const { store } = memoryStore(work);
  const watch = new ProductionWatch(store, { provider: serving(sha(40)), github: adapter, build: buildIdentity({}), baseBranch: 'main', now: () => T0 });
  const report = await watch.tick();
  const ahead = requests.filter(path => path.startsWith(`/compare/${sha(40)}...main`));
  assert.equal(ahead.length, 1, 'one ahead-by read per pass');
  const parameters = new URL(ahead[0], 'https://api.github.com').searchParams;
  assert.deepEqual([...parameters.entries()], [['per_page', '1'], ['page', '2']], 'one commit per page, and never the first page, which carries the file list');
  assert.equal(ahead[0], `/compare/${sha(40)}...main?per_page=1&page=2`);
  assert.deepEqual(report.ahead, { by: 7, head: null, commits: [], unservedSince: null, rollingOut: false }, 'only the count is read from the answer; every delivery is served, so no rollout is in flight');
  // The containment compare of two exact SHAs is the shared first page (GY-1272), asked once and kept: no other compare is read.
  assert.deepEqual(requests.filter(path => path.startsWith('/compare/') && path !== ahead[0]), [`/compare/${sha(1)}...${sha(40)}${comparePage}`]);
});

test('unit:production-watch-off-tick — a GitHub fake that never answers holds only the production watch; engine.reconcile keeps running every tick', async () => {
  const hang = () => new Promise<never>(() => {});
  const github = { request: hang, contains: hang, aheadBy: hang };
  const { store } = memoryStore(delivered(3));
  const watch = new ProductionWatch(store, { provider: serving(sha(2)), github, build: buildIdentity({}), baseBranch: 'main' });
  let reconciled = 0;
  const engine = { async reconcile() { reconciled++; } };
  const watching = startProductionWatch(watch, { intervalMs: 10 });
  const reconciliation = startReconciliation(async step => { await step('engine.reconcile', () => engine.reconcile()); }, 20);
  try {
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    await wait(100);
    assert.equal(watch.busy, true, 'the watch pass is stuck on GitHub');
    const before = reconciled;
    await wait(400);
    assert.equal(watch.busy, true, 'still stuck');
    assert.ok(reconciled - before >= 10, `engine.reconcile ran ${reconciled - before} times while the watch hung`);
  } finally { watching.stop(); reconciliation.stop(); }
  // The server's serial tick has no production step: the watch runs only on its own timer.
  const main = await readFile(new URL('../src/server/main.ts', import.meta.url), 'utf8');
  assert.ok(!/production\.tick\(/.test(main), 'src/server/main.ts does not call production.tick inside the reconciliation tick');
  assert.match(main, /startProductionWatch\(production/);
});

// GY-1209: the lag line "main is N commits ahead of production" fired for any ahead-by > 0, so the
// healthy 84–92 s between a merge landing on main and its deployment concluding counted as
// deployment-class attention. These are the three GY-1207 instance states: the serving commit,
// how far main was ahead, and when the merge that put it there landed.
const rollouts = [
  { serving: 'a7f6da24bba0ff8212e17c100c211513fbfc3de7', ahead: 17, mergedAt: '2026-10-04T15:15:54Z', deployedAt: '2026-10-04T15:17:18Z' },
  { serving: '8a0afd8247efeca3993da36ccdeb8acdec2ad6e5', ahead: 6, mergedAt: '2026-10-04T16:21:33Z', deployedAt: '2026-10-04T16:23:05Z' },
  { serving: '7e121476c4839bca4599d150383e0d41fe3b396a', ahead: 3, mergedAt: '2026-10-04T17:59:48Z', deployedAt: '2026-10-04T18:01:14Z' },
];
/** A linear main from `serving`: commits 1..ahead follow it, and the tip is a delivered merge. Every request GitHub answers is counted. */
function rolloutRepository(serving: string, ahead: number) {
  const commits = [serving, ...Array.from({ length: ahead }, (_, index) => (index + 1).toString(16).padStart(40, 'e'))];
  const state = { tip: ahead }, requests: string[] = [];
  const index = (ref: string) => { if (ref === 'main') return state.tip; const found = commits.indexOf(ref); if (found < 0) throw new Error(`unknown commit ${ref}`); return found; };
  const request = async (path: string) => {
    requests.push(path);
    const [, from, to] = path.match(/^\/compare\/([^.]+)\.\.\.([^?]+)/)!;
    const a = index(from), b = index(to);
    return { status: b > a ? 'ahead' : b === a ? 'identical' : 'behind', ahead_by: Math.max(0, b - a) };
  };
  return { commits, state, requests, github: { request,
    contains: async (base: string, head: string) => { const answer = await request(`/compare/${base}...${head}?per_page=1`); return answer.status === 'ahead' || answer.status === 'identical'; },
    aheadBy: async (base: string, head: string) => (await request(`/compare/${base}...${head}?per_page=1`)).ahead_by } };
}
/** A watch serving from its build identity, as this installation runs (provider null). */
function rolloutWatch(rollout: typeof rollouts[number], provider: ConstructorParameters<typeof ProductionWatch>[1]['provider'] = null) {
  const repo = rolloutRepository(rollout.serving, rollout.ahead), mergedAt = Date.parse(rollout.mergedAt);
  const work = [{ id: 'work-tip', key: 'GY-9000', stage: 'done', delivery: { mergedAt: new Date(mergedAt).toISOString(), mergeSha: repo.commits[rollout.ahead], authorizationRevision: 1 } }] as unknown as Work[];
  const { store, events } = memoryStore(work);
  let clock = mergedAt;
  const watch = new ProductionWatch(store, { provider, github: repo.github, build: buildIdentity({ GRAPHYARD_BUILD_SHA: rollout.serving }), baseBranch: 'main', now: () => clock });
  return { watch, repo, events, at: (ms: number) => { clock = mergedAt + ms; } };
}
/** The base's lag line: the same report, read by an attentionLines that knows nothing of a rollout in flight. */
const baseLines = (report: ProductionReport) => attentionLines({ ...report, ahead: report.ahead && { by: report.ahead.by, head: report.ahead.head, commits: report.ahead.commits } });
const lagLine = (rollout: typeof rollouts[number]) => `main is ${rollout.ahead} commits ahead of production (serving ${rollout.serving.slice(0, 12)})`;

for (const [number, rollout] of rollouts.entries()) {
  test(`unit:production-lag-grace-in-flight — GY-1207 instance ${number + 1}: ${rollout.ahead} ahead of ${rollout.serving.slice(0, 12)} inside the merge→deploy window raises the line on the base and not on the candidate`, async () => {
    const { watch, at } = rolloutWatch(rollout);
    // Every pass inside the observed window (the deploy concluded within it) and up to the grace.
    for (const elapsed of [0, 30_000, Date.parse(rollout.deployedAt) - Date.parse(rollout.mergedAt), DEPLOYMENT_GRACE_MS - 1_000]) {
      at(elapsed);
      const report = await watch.tick(true);
      assert.deepEqual(baseLines(report), [lagLine(rollout)], `the base raises the instance line ${elapsed / 1000}s after the merge`);
      assert.deepEqual(report.attention, [], `no lag attention ${elapsed / 1000}s after the merge`);
      assert.equal(report.ahead?.by, rollout.ahead, 'ahead.by is still reported for the operator');
      assert.equal(report.ahead?.rollingOut, true);
      assert.equal(report.ahead?.unservedSince, new Date(Date.parse(rollout.mergedAt)).toISOString());
      const summary = productionSummary(report);
      assert.deepEqual(summary.attention, [], 'master status and the dashboard agree with the watch');
      assert.equal(summary.aheadBy, rollout.ahead);
      assert.equal(summary.rollingOut, true);
      assert.match(summary.summary, new RegExp(`^main is ${rollout.ahead} commits ahead of production; rollout in flight since `));
      assert.deepEqual(report.incidents, []);
    }
  });
}

test('unit:production-lag-grace-in-flight — the grace is the oldest unserved merge\'s: one past it keeps the line even when a newer merge is fresh', async () => {
  const rollout = rollouts[0];
  const repo = rolloutRepository(rollout.serving, rollout.ahead), mergedAt = Date.parse(rollout.mergedAt);
  const work = [8, rollout.ahead].map((index, n) => ({ id: `work-${n}`, key: `GY-${9000 + n}`, stage: 'done', delivery: { mergedAt: new Date(mergedAt - (n ? 0 : 10 * 60_000)).toISOString(), mergeSha: repo.commits[index], authorizationRevision: 1 } })) as unknown as Work[];
  const watch = new ProductionWatch(memoryStore(work).store, { provider: null, github: repo.github, build: buildIdentity({ GRAPHYARD_BUILD_SHA: rollout.serving }), baseBranch: 'main', now: () => mergedAt + 30_000 });
  const report = await watch.tick(true);
  assert.equal(report.ahead?.rollingOut, false);
  assert.match(report.attention[0] ?? '', new RegExp(`^${lagLine(rollout).replace(/[()]/g, '\\$&')}: no deployment of `));
});

test('unit:production-lag-past-grace — a merge unserved past DEPLOYMENT_GRACE_MS still raises the lag line and its failing-deployment reason exactly as today', async () => {
  for (const rollout of rollouts) {
    const { watch, at } = rolloutWatch(rollout);
    at(DEPLOYMENT_GRACE_MS + 60_000);
    const report = await watch.tick(true);
    assert.equal(report.ahead?.rollingOut, false);
    assert.deepEqual(report.attention, baseLines(report), 'the line stands exactly as the base raises it');
    assert.equal(report.attention[0], `${lagLine(rollout)}: ${report.incidents[0].reason}`);
    assert.match(report.incidents[0].reason, /^no deployment of [0-9a-f]{12} was observed within 5 minutes of the merge/);
    assert.deepEqual(statusFaults({ github: {}, production: productionSummary(report) }).filter(fault => fault.faultClass === 'deployment').map(fault => fault.text)[0], report.attention[0]);
  }
  // A failed rollout is a fault at once, grace or not: the provider's failed attempt is the line's reason.
  const rollout = rollouts[1];
  const tip = rolloutRepository(rollout.serving, rollout.ahead).commits[rollout.ahead];
  const provider = { name: 'railway', description: 'stub', list: async () => [
    { id: 'd-failed', status: 'failed' as const, providerStatus: 'FAILED', commit: tip, branch: 'main', createdAt: rollout.mergedAt, updatedAt: null, url: null },
    { id: 'd-serving', status: 'success' as const, providerStatus: 'SUCCESS', commit: rollout.serving, branch: 'main', createdAt: '2026-10-04T15:00:00Z', updatedAt: null, url: null }] };
  const failed = rolloutWatch(rollout, provider);
  failed.at(60_000);
  const report = await failed.watch.tick(true);
  assert.deepEqual(report.attention, baseLines(report));
  assert.match(report.attention[0], new RegExp(`^main is ${rollout.ahead} commits ahead of production \\(serving ${rollout.serving.slice(0, 12)}\\): railway deployment d-failed`));
  // A provider attempt in flight extends the grace only to the incidents' bound; a stall past it stands.
  const stalled = rolloutWatch(rollout, { name: 'railway', description: 'stub', list: async () => [
    { id: 'd-building', status: 'building' as const, providerStatus: 'BUILDING', commit: tip, branch: 'main', createdAt: rollout.mergedAt, updatedAt: null, url: null },
    { id: 'd-serving', status: 'success' as const, providerStatus: 'SUCCESS', commit: rollout.serving, branch: 'main', createdAt: '2026-10-04T15:00:00Z', updatedAt: null, url: null }] });
  stalled.at(DEPLOYMENT_GRACE_MS + 60_000);
  assert.equal((await stalled.watch.tick(true)).ahead?.rollingOut, true, 'a newer attempt still in flight is a rollout');
  stalled.at(3 * DEPLOYMENT_GRACE_MS + 60_000);
  const stall = await stalled.watch.tick(true);
  assert.equal(stall.ahead?.rollingOut, false);
  assert.deepEqual(stall.attention, baseLines(stall));
  assert.match(stall.attention[0], /^main is 6 commits ahead of production/);
});

test('unit:production-lag-grace-without-provider — with provider null the grace is decided from the deliveries\' mergedAt, adding no GitHub request beyond the single aheadBy compare per pass', async () => {
  const rollout = rollouts[2];
  const { watch, repo, at } = rolloutWatch(rollout);
  let report = await watch.tick(true);
  assert.equal(report.provider, null);
  assert.equal(report.servingSource, 'build');
  assert.equal(report.ahead?.rollingOut, true);
  const aheadBy = (path: string) => path.includes('...main');
  assert.equal(repo.requests.filter(aheadBy).length, 1, 'one aheadBy compare');
  assert.equal(repo.requests.length, 2, 'the aheadBy compare and the delivery\'s own containment compare, as the base makes');
  // The steady passes that decide the grace through to its end: one aheadBy compare each, nothing more.
  for (const elapsed of [60_000, 120_000, DEPLOYMENT_GRACE_MS + 1_000]) {
    repo.requests.length = 0; at(elapsed);
    report = await watch.tick(true);
    assert.deepEqual(repo.requests, [`/compare/${rollout.serving}...main?per_page=1`], `${elapsed / 1000}s: only the aheadBy compare`);
  }
  assert.equal(report.ahead?.rollingOut, false, 'past the grace the same reads decide it');
});

test('unit:fault-class-deployment-rollout-grace — the deployment class opens no instance for a rollout inside the grace; a cadence of merges deployed within it opens zero where the base opens one per merge', async () => {
  // classifyAttention over a control-plane status whose production report is inside the grace.
  const { watch, at } = rolloutWatch(rollouts[0]);
  at(60_000);
  const report = await watch.tick(true);
  const status = { production: report } as unknown as ControlPlaneStatus;
  const classified = classifyAttention(controlPlaneAttention(status).attentionItems);
  assert.deepEqual(classified.filter(item => item.kind === 'production' && item.subject === 'installation'), []);
  assert.deepEqual(statusFaults({ github: {}, production: productionSummary(report) }).filter(fault => fault.faultClass === 'deployment'), []);
  const base = classifyAttention(controlPlaneAttention({ production: { ...report, attention: [], ahead: { by: report.ahead!.by, head: null, commits: [] } } } as unknown as ControlPlaneStatus).attentionItems);
  assert.deepEqual(base.filter(item => item.kind === 'production').map(item => [item.subject, item.faultClass, item.text]), [['installation', 'deployment', lagLine(rollouts[0])]], 'the base records the instance');

  // Steady merge traffic: a merge every five minutes, each deployed 90 s later, the watch passing every minute.
  const merges = 12, start = Date.parse('2026-10-04T15:00:00Z');
  const repo = rolloutRepository(sha(0), merges);
  const mergeAt = (index: number) => start + index * 300_000 + 10_000;
  let clock = start;
  const build = { commit: sha(0) as string | null, protocol: buildIdentity({}).protocol, source: 'GRAPHYARD_BUILD_SHA' as const };
  const work = Array.from({ length: merges }, (_, index) => ({ id: `work-${index + 1}`, key: `GY-${9100 + index}`, stage: 'done', delivery: { mergedAt: new Date(mergeAt(index)).toISOString(), mergeSha: repo.commits[index + 1], authorizationRevision: 1 } })) as unknown as Work[];
  const { store } = memoryStore(work);
  (store as any).list = (store as any).fleet = async () => work.filter(item => Date.parse(item.delivery!.mergedAt) <= clock);
  const cadence = new ProductionWatch(store, { provider: null, github: repo.github, build, baseBranch: 'main', now: () => clock });
  const candidateRecord: FaultRecord = { instances: [], open: {}, failing: {} }, baseRecord: FaultRecord = { instances: [], open: {}, failing: {} };
  const deployment = (production: ReturnType<typeof productionSummary>) => statusFaults({ github: {}, production }).filter(fault => fault.faultClass === 'deployment');
  for (clock = start; clock <= start + merges * 300_000; clock += 60_000) {
    const landed = work.filter(item => Date.parse(item.delivery!.mergedAt) <= clock).length;
    repo.state.tip = landed;
    const deployed = work.filter(item => Date.parse(item.delivery!.mergedAt) + 90_000 <= clock).length;
    build.commit = repo.commits[deployed];
    const pass = await cadence.tick(true), at = new Date(clock).toISOString();
    trackFaults(candidateRecord, deployment(productionSummary(pass)), at);
    trackFaults(baseRecord, deployment(productionSummary({ ...pass, ahead: pass.ahead && { by: pass.ahead.by, head: pass.ahead.head, commits: pass.ahead.commits } })), at);
    assert.deepEqual(pass.incidents, []);
  }
  assert.equal(baseRecord.instances.filter(instance => instance.faultClass === 'deployment').length, merges, 'the base opens one deployment instance per merge');
  assert.equal(candidateRecord.instances.filter(instance => instance.faultClass === 'deployment').length, 0, 'the candidate opens none');
});

// GY-1327: without a Railway token every promotion not served within the grace was recorded
// 'missing'. Railway reports each deploy to GitHub as a deployment in 'production' with statuses,
// which the control plane's App credential can read.
/** GitHub over a linear main sha(0) < … < sha(tip) that also answers the deployments API from `deployments`; every request is counted. */
function deploymentsGitHub(tip: number, deployments: { id: number; sha: string; ref?: string; environment?: string; statuses: { state: string; log_url?: string }[] }[]) {
  const base = linearGitHub(tip), requests: string[] = [];
  const request = async (path: string) => {
    requests.push(path);
    const listing = path.match(/^\/deployments\?environment=([^&]+)&/);
    if (listing) return deployments.filter(d => (d.environment ?? 'production') === decodeURIComponent(listing[1])).map(d => ({ id: d.id, sha: d.sha, ref: d.ref ?? 'main', environment: d.environment ?? 'production', created_at: new Date(T0).toISOString() }));
    const statuses = path.match(/^\/deployments\/(\d+)\/statuses/);
    if (statuses) return [...deployments.find(d => d.id === Number(statuses[1]))!.statuses].reverse().map(status => ({ ...status, created_at: new Date(T0).toISOString() }));
    return base.request(path);
  };
  return { requests, github: { request, contains: base.contains, aheadBy: base.aheadBy, config: { repository: 'owner/project' } } };
}
function promotedWatch(github: ReturnType<typeof deploymentsGitHub>['github']) {
  const work = [{ id: 'work-2', key: 'GY-2', stage: 'done', delivery: { mergedAt: new Date(T0).toISOString(), mergeSha: sha(2), authorizationRevision: 1 } }] as unknown as Work[];
  const { store, events } = memoryStore(work);
  let clock = T0;
  const provider = productionWatch.productionProvider({}, github);
  const watch = new ProductionWatch(store, { provider, github, build: buildIdentity({ GRAPHYARD_BUILD_SHA: sha(1) }), baseBranch: 'main', now: () => clock });
  return { watch, events, provider, at: (ms: number) => { clock = T0 + ms; } };
}

test('unit:production-watch-github-deployments — with no Railway token an in-flight GitHub deployment holds the promotion, a failure names its log_url, and a success served records the delivery', async () => {
  // In flight: an in_progress or queued latest status is a rollout, never 'missing', past the grace.
  for (const state of ['in_progress', 'queued']) {
    const { github } = deploymentsGitHub(2, [{ id: 7, sha: sha(2), statuses: [{ state: 'queued' }, ...(state === 'in_progress' ? [{ state }] : [])] }, { id: 6, sha: sha(1), statuses: [{ state: 'success' }] }]);
    const { watch, provider, events, at } = promotedWatch(github);
    assert.equal(provider?.name, 'github');
    at(DEPLOYMENT_GRACE_MS + 60_000);
    const report = await watch.tick(true);
    assert.equal(report.provider, 'github');
    assert.equal(report.serving, sha(1)); assert.equal(report.servingSource, 'provider');
    assert.equal(report.latest?.status, state === 'in_progress' ? 'deploying' : 'queued');
    assert.deepEqual(report.pending, ['GY-2']);
    assert.deepEqual(report.incidents, [], `a ${state} deployment of the promoted sha is held as in flight`);
    assert.equal(events.filter(event => event.kind === 'delivery.deployment-incident').length, 0);
    assert.equal(report.ahead?.rollingOut, true);
  }

  // Failed: a failure or error status is a failed deployment naming the status's log_url.
  for (const state of ['failure', 'error']) {
    const { github } = deploymentsGitHub(2, [{ id: 8, sha: sha(2), statuses: [{ state: 'in_progress' }, { state, log_url: 'https://railway.example/logs/8' }] }, { id: 6, sha: sha(1), statuses: [{ state: 'success' }] }]);
    const { watch, at } = promotedWatch(github);
    at(60_000);
    const report = await watch.tick(true);
    assert.equal(report.incidents.length, 1);
    assert.equal(report.incidents[0].status, 'failed');
    assert.equal(report.incidents[0].provider, 'github');
    assert.equal(report.incidents[0].deploymentId, '8');
    assert.equal(report.incidents[0].reason, `github deployment 8 of ${sha(2).slice(0, 12)} ${state.toUpperCase()} (https://railway.example/logs/8); production still serves ${sha(1).slice(0, 12)}`);
  }

  // Delivered: a success status of the promoted sha makes it what production serves, and a held incident recovers.
  const deployments = [{ id: 9, sha: sha(2), statuses: [{ state: 'in_progress' }] }, { id: 6, sha: sha(1), statuses: [{ state: 'success' }] }];
  const { github, requests } = deploymentsGitHub(2, deployments);
  const { watch, events, at } = promotedWatch(github);
  at(60_000);
  assert.deepEqual((await watch.tick(true)).pending, ['GY-2']);
  deployments[0].statuses.push({ state: 'success' });
  requests.length = 0; at(120_000);
  const report = await watch.tick(true);
  assert.equal(report.serving, sha(2)); assert.equal(report.servingSource, 'provider');
  assert.deepEqual(report.deployed, ['GY-2']); assert.deepEqual(report.pending, []); assert.deepEqual(report.incidents, []);
  assert.equal(events.filter(event => event.kind === CONTAINED_EVENT).length, 1, 'the delivery is recorded deployed');
  assert.deepEqual(requests.filter(path => path.startsWith('/deployments')), ['/deployments?environment=production&per_page=10', '/deployments/9/statuses?per_page=1'], 'a concluded deployment\'s status is not read again');
  // Railway marks a served success inactive minutes later: the concluded status is kept, so production still serves it.
  deployments[0].statuses.push({ state: 'inactive' });
  at(180_000);
  assert.equal((await watch.tick(true)).serving, sha(2));
});

test('unit:production-watch-provider-selection — a Railway token selects the Railway provider as before, none falls back to GitHub deployments, and the missing remedy no longer asks for a Railway token', async () => {
  const github = deploymentsGitHub(2, []).github;
  const railwayEnv = { RAILWAY_SERVICE_ID: 'svc', RAILWAY_ENVIRONMENT_ID: 'env' };
  for (const token of [{ RAILWAY_API_TOKEN: 'account' }, { RAILWAY_TOKEN: 'project' }]) {
    const railway = productionWatch.productionProvider({ ...railwayEnv, ...token }, github);
    assert.equal(railway?.name, 'railway');
    assert.equal(railway?.description, 'Railway service svc, environment env');
    assert.equal(productionWatch.observationLine(railway, { commit: sha(1) }), 'production observation via Railway service svc, environment env');
  }
  const fallback = productionWatch.productionProvider(railwayEnv, github);
  assert.equal(fallback?.name, 'github');
  assert.match(productionWatch.observationLine(fallback, { commit: sha(1) }), /^production observation via GitHub deployments to production of owner\/project$/);
  assert.equal(productionWatch.productionProvider({ GRAPHYARD_PRODUCTION_ENVIRONMENT: 'prod-eu' }, github)?.description, 'GitHub deployments to prod-eu of owner/project');
  assert.equal(productionWatch.productionProvider(railwayEnv, null), null, 'without the GitHub App nothing can be read');
  assert.equal(productionWatch.observationLine(null, { commit: sha(1) }), 'production observation from the build identity only; configure the GitHub App to read GitHub deployments');
  // Server startup selects through productionProvider and logs the line.
  const main = await readFile(new URL('../src/server/main.ts', import.meta.url), 'utf8');
  assert.match(main, /productionProvider\(process\.env, github\)/);
  assert.match(main, /observationLine\(provider, build\)/);

  // The missing-incident remedy, with no provider readable at all.
  const { store } = memoryStore([{ id: 'work-2', key: 'GY-2', stage: 'done', delivery: { mergedAt: new Date(T0).toISOString(), mergeSha: sha(2), authorizationRevision: 1 } }] as unknown as Work[]);
  const watch = new ProductionWatch(store, { provider: null, github: linearGitHub(2), build: buildIdentity({ GRAPHYARD_BUILD_SHA: sha(1) }), baseBranch: 'main', now: () => T0 + DEPLOYMENT_GRACE_MS + 60_000 });
  const report = await watch.tick(true);
  assert.equal(report.incidents[0].status, 'missing');
  assert.doesNotMatch(report.incidents[0].reason, /required|needs? (a )?Railway|so the provider reports/i, 'a Railway token is not presented as required');
  assert.match(report.incidents[0].reason, /\. Configure RAILWAY_API_TOKEN \(or RAILWAY_TOKEN\) or the GitHub App: either one reads a deployment list \(Railway's, or the GitHub deployments Railway reports\) that names the failing deployment$/);
});

/** GY-1420: release/production at sha(2), GitHub's Railway deployment list still on sha(1), and GY-2's delivery carrying `observed` as its recorded deployment. */
async function liveReleaseWatch(observed: Record<string, unknown> | null, attempt: { status: 'success' | 'failed' | 'deploying'; providerStatus: string } | null = null, releaseBranch: string | null = 'release/production') {
  const tip = 2, observedAt = T0 + DEPLOYMENT_GRACE_MS;
  const work = [{ id: 'work-2', key: 'GY-2', stage: 'done', delivery: { mergedAt: new Date(T0).toISOString(), mergeSha: sha(2), authorizationRevision: 1,
    ...(observed ? { deployment: { sha: sha(2), mergeSha: sha(2), source: 'endpoint', observedAt: new Date(observedAt).toISOString(), covers: 'exact', at: new Date(observedAt).toISOString(), observer: 'graphyard-master', ...observed } } : {}) } }] as unknown as Work[];
  const { store, events } = memoryStore(work);
  const request = async (path: string) => {
    if (path.startsWith('/branches/')) return { commit: { sha: sha(tip) } };
    const [, from, to] = path.match(/^\/compare\/([0-9a-f]{40})\.\.\.([^?]+)/)!;
    const a = parseInt(from, 16), b = to === 'main' ? tip : parseInt(decodeURIComponent(to), 16);
    return { status: b > a ? 'ahead' : b === a ? 'identical' : 'behind', ahead_by: Math.max(0, b - a) };
  };
  const compare = (base: string, head: string) => request(`/compare/${base}...${head}`) as Promise<{ status: string; ahead_by: number }>;
  const github = { request, contains: async (base: string, head: string) => ['ahead', 'identical'].includes((await compare(base, head)).status), aheadBy: async (base: string, head: string) => (await compare(base, head)).ahead_by };
  const provider = { name: 'github', description: 'stub', list: async () => [
    ...(attempt ? [{ id: 'd-release', ...attempt, commit: sha(2), branch: null, createdAt: new Date(T0 + 60_000).toISOString(), updatedAt: null, url: null }] : []),
    { id: 'd-stale', status: 'success' as const, providerStatus: 'SUCCESS', commit: sha(1), branch: null, createdAt: new Date(T0 - 3_600_000).toISOString(), updatedAt: null, url: null }] };
  // The first pass sees the promotion before the endpoint is observed; the second is past the grace period.
  let clock = T0;
  const watch = new ProductionWatch(store, { provider, github, build: buildIdentity({}), baseBranch: 'main', releaseBranch, now: () => clock });
  await watch.tick(true);
  clock = observedAt + 60_000;
  return { report: await watch.tick(true), events };
}

test('unit:production-live-release-observation — a fresh endpoint observation of the exact release outranks a stale GitHub deployment status: production serves it and no missing-deployment incident is raised', async () => {
  for (const branch of ['release/production', null]) {
    const { report, events } = await liveReleaseWatch({}, null, branch);
    assert.equal(report.serving, sha(2), 'the endpoint proved the exact release live');
    assert.equal(report.servingSource, 'endpoint');
    assert.deepEqual(report.deployed, ['GY-2']); assert.deepEqual(report.pending, []);
    assert.deepEqual(report.incidents, []);
    assert.equal(events.filter(event => event.kind === 'delivery.deployment-incident').length, 0);
    if (branch) assert.equal(report.release?.unservedSince, null);
    assert.equal(report.ahead?.by, 0);
    assert.deepEqual(report.attention, []);
  }
  // GitHub's status of the release still in flight does not undo what the endpoint proved.
  const deploying = (await liveReleaseWatch({}, { status: 'deploying', providerStatus: 'IN_PROGRESS' })).report;
  assert.equal(deploying.serving, sha(2)); assert.deepEqual(deploying.incidents, []);
});

test('unit:production-live-release-observation — without proof of the exact SHA the stale release stands and the missing or failed deployment is still reported', async () => {
  const unproven: [string, Record<string, unknown> | null][] = [
    ['no endpoint observation', null],
    ['an endpoint serving another commit', { sha: sha(1) }],
    ['an abbreviated SHA', { sha: sha(2).slice(0, 12) }],
    ['a GitHub deployment observation, not the endpoint', { source: 'github-deployment' }],
    ['a stale observation', { observedAt: new Date(T0 - 2 * productionWatch.ENDPOINT_FRESH_MS).toISOString() }],
  ];
  for (const [label, observed] of unproven) {
    const { report } = await liveReleaseWatch(observed);
    assert.equal(report.serving, sha(1), `${label} proves nothing`);
    assert.equal(report.servingSource, 'provider');
    assert.deepEqual(report.incidents.map(incident => [incident.key, incident.status]), [['GY-2', 'missing']], label);
    assert.ok(report.release?.overdue, label);
  }
  // The provider's newest deployment of the observed release failed: it is not running, whatever the endpoint said.
  const { report } = await liveReleaseWatch({}, { status: 'failed', providerStatus: 'FAILURE' });
  assert.equal(report.serving, sha(1));
  assert.deepEqual(report.incidents.map(incident => [incident.key, incident.status]), [['GY-2', 'failed']]);
  // A provider success newer than the observation is the later fact: the observation does not outrank it.
  const observed = [{ delivery: { deployment: { sha: sha(2), source: 'endpoint', observedAt: new Date(T0).toISOString() } } }] as unknown as Work[];
  const success = (at: number) => ({ id: 'd', status: 'success' as const, providerStatus: 'SUCCESS', commit: sha(3), branch: null, createdAt: new Date(at).toISOString(), updatedAt: null, url: null });
  assert.equal(productionWatch.liveEndpointRelease(observed, [success(T0 - 60_000)], success(T0 - 60_000), sha(2), T0 + 60_000), sha(2));
  assert.equal(productionWatch.liveEndpointRelease(observed, [success(T0 + 1_000)], success(T0 + 1_000), sha(2), T0 + 60_000), null);
  assert.equal(productionWatch.liveEndpointRelease(observed, [], undefined, sha(3), T0 + 60_000), null, 'the release tip moved past the observed SHA');
});
