import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CONTAINED_EVENT, PENDING_EVENT, ProductionWatch, startProductionWatch } from '../src/production-watch.js';
import { startReconciliation } from '../src/server/main.js';
import { GitHub } from '../src/github.js';
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
  return { store: { pool, list: async () => work } as unknown as Store, events, reads };
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
  assert.deepEqual(report.ahead, { by: 7, head: null, commits: [] }, 'only the count is read from the answer');
  // The containment compare the adapter makes is the one-commit form too.
  assert.ok(requests.filter(path => path.startsWith('/compare/')).every(path => new URL(path, 'https://api.github.com').searchParams.get('per_page') === '1'), requests.join(', '));
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
