import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import type pg from 'pg';
import { Store, storeStatementTimeoutMs, workDelta } from '../src/store.js';
import { reportPoolConnections, reportStatementTimeoutMs } from '../src/store/report-pool.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Observation, Principal, Work } from '../src/model.js';
import { interventionLedgerKinds, interventionLedgerLimit, readInterventionLedger, type InterventionLedgerRow } from '../src/interventions.js';

/**
 * GY-491. GY-422 bounded the intervention report to its window, but every row of that window still
 * rebuilt its item's document from a delta in SQL, twice — once for the row and once, through a
 * correlated subquery, for the stage before it — so GET /api/interventions still ran into the
 * statement timeout, holding connections the observation jobs needed while it did.
 *
 * This file seeds a ledger the way the store writes it — 200,000 events over 120 days across 3,000
 * items, each save a delta on the item's last full snapshot unless the stage changed or fifty rows
 * passed — and holds the report to its budget over it, with the rows it folds identical to the
 * per-row rebuild it replaces. It then holds every report route to the report pool — each reads
 * through it and takes no coordination connection — saturates that pool, and holds a lease renewal
 * and an observation write to their bounds.
 */

const EVENTS = 200_000, ITEMS = 3_000;
const day = 86_400_000, span = 120 * day;
const coordinator: Principal = { id: 'coordinator-491', role: 'coordinator' };
const operator: Principal = { id: 'operator-491', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'worker-491', role: 'worker', sessionKind: 'ai' };
const tokens = { coordinator: 'r'.repeat(32), operator: 'o'.repeat(32), worker: 'w'.repeat(32) };

let database: EmbeddedPostgres; let store: Store; let engine: Engine; let databaseUrl: string;
let http: ReturnType<typeof server>; let url: string; let seededAt: number;

const uuid = (index: number) => `00000000-0000-4491-8000-${String(index).padStart(12, '0')}`;
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const iso = (ms: number) => new Date(ms).toISOString();

/** The row an item's j-th ledger entry is, and what it does to the item. */
function kindAt(j: number): { kind: string; save: boolean } {
  if (j % 19 === 9) return { kind: 'intervention.recorded', save: false };
  if (j % 17 === 2) return { kind: 'decision.requested', save: false };
  if (j % 23 === 11) return { kind: 'lease.expired', save: false };
  if (j % 7 === 3) return { kind: 'blocked', save: true };
  if (j % 7 === 4) return { kind: 'unblock', save: true };
  if (j % 11 === 5) return { kind: 'scope', save: true };
  if (j % 11 === 6) return { kind: 'requirements', save: true };
  if (j % 13 === 7) return { kind: 'rework', save: true };
  return { kind: j % 2 ? 'heartbeat' : 'github.observed', save: true };
}
/** Items move through the stages at different times, so every window holds rows that moved one. */
const stageAt = (j: number, item: number) => { const phase = (j + item) % 20; return phase < 5 ? 'build' : phase < 12 ? 'review' : phase < 17 ? 'test' : 'build'; };

/** Every ledger row, in ledger order, written as `appendSave` writes it: seq is `j * ITEMS + item`. */
function* ledger(now: number) {
  const docs = new Map<number, Work>(), bases = new Map<number, { seq: number; work: Work; since: number } | null>();
  const perItem = Math.ceil(EVENTS / ITEMS);
  for (let j = 0; j < perItem; j++) for (let item = 1; item <= ITEMS; item++) {
    const seq = j * ITEMS + item;
    if (seq > EVENTS) return;
    const at = iso(now - span + Math.floor((seq / EVENTS) * span) - 30 * 60_000);
    // Each item runs the same schedule from its own offset, so every window holds every kind of row.
    const t = j + item % 37;
    const { kind, save } = kindAt(t), id = uuid(item), key = `GY-${item}`;
    const previous = docs.get(item);
    if (!save) {
      const payload = kind === 'intervention.recorded'
        ? { id: randomUUID(), kind: 'session-nudge', work: { id, key, title: `Item ${key}` }, stage: previous?.stage ?? 'build', blocked: 'a quiet session', since: at, at, resolution: 're-prompted', recordedBy: coordinator.id }
        : kind === 'decision.requested' ? { id: `decision-${seq}`, action: 'rework', reason: 'send it back' } : { details: { epoch: previous?.epoch ?? 1, at } };
      // A row with a top-level `work` is the newest row carrying one, as appendSave's base lookup reads it.
      if (kind === 'intervention.recorded') bases.set(item, { seq, work: payload.work as unknown as Work, since: 0 });
      else if (bases.get(item)) bases.get(item)!.since++;
      yield { seq, work_id: id, actor: coordinator.id, kind, payload, created_at: at };
      continue;
    }
    const stage = stageAt(j, item), epoch = 1 + Math.floor(j / 30);
    const plannedFiles = kind === 'requirements' ? [...(previous?.plannedFiles ?? [`src/item-${item}.ts`]), `src/widened-${t}.ts`] : previous?.plannedFiles ?? [`src/item-${item}.ts`];
    const escalations = t % 29 >= 14 && t % 29 < 20 ? [{ trigger: 'lease-loss', at: iso(now - span + Math.floor(((seq - (t % 29 - 14) * ITEMS) / EVENTS) * span)), reason: 'the lease lapsed', actor: 'graphyard' }] : [];
    const blocker = kind === 'blocked' ? `waiting on vendor ${item % 7}` : kind === 'unblock' || kind === 'rework' ? null : previous?.blocker ?? null;
    const candidate = stage === 'build' ? null : { sha: sha(`${item}-${epoch}`), baseSha: 'b'.repeat(40), pr: 10_000 + item };
    const work = {
      id, key, title: `Item ${key} of the seeded ledger`, description: `What ${key} is for. `.repeat(30), type: 'feature', priority: 2, dependencies: [],
      criteria: [{ id: 'AC-1', text: `The behaviour ${key} asks for holds`, proofs: ['unit:proof-1'] }], policy: { checks: ['test'], review: true }, plannedFiles,
      revision: j + 1, policyRevision: 1, createdAt: iso(now - span), updatedAt: at, stageEnteredAt: at, ready: true, epoch, stage,
      lease: { owner: worker.id, epoch, expiresAt: iso(Date.parse(at) + 120_000) }, blocker, escalations, candidate, submission: candidate ? { epoch, pr: candidate.pr } : null,
      containmentQuarantine: t % 31 === 15 ? { epoch, at } : null, workspaces: [{ host: 'machine-a', path: `/srv/${key}-${epoch}`, epoch, owner: worker.id, branch: `graphyard/${key.toLowerCase()}-${epoch}` }],
      evidence: [], sessions: [], gates: [], violations: [], observation: null, pipeline: { attempts: [], submittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } },
    } as unknown as Work;
    docs.set(item, work);
    const details = kind === 'blocked' ? { reason: blocker, epoch } : kind === 'unblock' ? { reason: 'the vendor answered' } : kind === 'scope' ? { epoch, paths: [`src/asked-${t}.ts`], reason: 'the table lives elsewhere' }
      : kind === 'requirements' ? { reason: 'widened for the ask', plannedFiles } : kind === 'rework' ? { reason: 'rework authorized' } : { pass: seq };
    const base = bases.get(item);
    // appendSave's rule: a delta on the newest whole row when it is recent and the stage is unchanged.
    if (base?.work && base.since < 50 && base.work.stage === work.stage) {
      base.since++;
      yield { seq, work_id: id, actor: worker.id, kind, payload: { delta: workDelta(base.seq, base.work, work), details }, created_at: at };
    } else {
      bases.set(item, { seq, work, since: 0 });
      yield { seq, work_id: id, actor: worker.id, kind, payload: { work, details }, created_at: at };
    }
  }
}

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 491;
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-interventions-scale-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('interventions_scale');
  databaseUrl = `postgres://graphyard:testing-only@127.0.0.1:${port}/interventions_scale`;
  store = new Store(databaseUrl);
  await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.submissionObserver = null;
  http = server(engine, [{ ...coordinator, token: tokens.coordinator }, { ...operator, token: tokens.operator }, { ...worker, token: tokens.worker }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  seededAt = Date.now();
  const latest = new Map<string, Work>();
  let batch: unknown[] = [];
  const flush = async () => {
    if (!batch.length) return;
    await store.pool.query(`INSERT INTO events(seq, work_id, actor, kind, payload, created_at)
      SELECT (r->>'seq')::bigint, (r->>'work_id')::uuid, r->>'actor', r->>'kind', r->'payload', (r->>'created_at')::timestamptz FROM jsonb_array_elements($1::jsonb) AS r`, [JSON.stringify(batch)]);
    batch = [];
  };
  // The items first (the ledger references them), as their last documents; then the ledger.
  const rows = [...ledger(seededAt)];
  for (const row of rows) if ('work' in row.payload && row.kind !== 'intervention.recorded') latest.set(row.work_id, row.payload.work as Work);
  const items = Array.from({ length: ITEMS }, (_, index) => latest.get(uuid(index + 1))!);
  for (let from = 0; from < items.length; from += 500)
    await store.pool.query('INSERT INTO work_items(id, document) SELECT (d->>\'id\')::uuid, d FROM jsonb_array_elements($1::jsonb) AS d', [JSON.stringify(items.slice(from, from + 500))]);
  for (const row of rows) { batch.push(row); if (batch.length >= 4_000) await flush(); }
  await flush();
  await store.pool.query("SELECT setval(pg_get_serial_sequence('events','seq'), (SELECT max(seq) FROM events))");
  await store.pool.query('ANALYZE');
});
after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
  if (database) await database.stop();
});

/** The ledger read GY-491 replaces, verbatim: every row's document and the stage before it rebuilt in SQL, row by row. */
const perRowColumns = `seq, work_id, actor, kind, created_at, doc->>'updatedAt' AS updated_at, payload->'details' AS details,
  CASE WHEN kind LIKE 'decision.%' OR kind IN ('intervention.recorded','judgement.recorded') THEN payload ELSE NULL END AS top,
  CASE WHEN doc IS NOT NULL THEN jsonb_build_object('key', doc->'key', 'stage', doc->'stage', 'title', doc->'title', 'epoch', doc->'epoch', 'blocker', doc->'blocker',
    'plannedFiles', doc->'plannedFiles', 'quarantine', doc->'containmentQuarantine', 'escalations', doc->'escalations', 'candidate', doc->'candidate', 'submission', doc->'submission') ELSE NULL END AS work,
  CASE WHEN work_id IS NULL THEN NULL ELSE (SELECT graphyard_event_work(earlier.work_id, earlier.payload)->>'stage' FROM events earlier WHERE earlier.work_id=ledger.work_id AND earlier.seq<ledger.seq AND (earlier.payload ? 'work' OR earlier.payload ? 'delta') ORDER BY earlier.seq DESC LIMIT 1) END AS stage_before`;
async function perRowLedger(since: string, limit = interventionLedgerLimit): Promise<{ rows: InterventionLedgerRow[]; truncated: boolean }> {
  const client = await store.pool.connect();
  try {
    await client.query('SET statement_timeout = 0');
    const result = await client.query(`SELECT ${perRowColumns} FROM (SELECT *, graphyard_event_work(work_id, payload) AS doc FROM (SELECT * FROM events WHERE kind = ANY($1) AND ($3::uuid IS NULL OR work_id=$3) AND ($4::timestamptz IS NULL OR created_at >= $4::timestamptz) ORDER BY seq DESC LIMIT $2) newest) ledger ORDER BY seq DESC`, [[...interventionLedgerKinds], limit + 1, null, since]);
    const instant = (value: unknown, fallback: string) => { const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN; return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback; };
    return { truncated: result.rows.length > limit, rows: result.rows.slice(0, limit).reverse().map(row => ({ seq: Number(row.seq), workId: row.work_id, actor: row.actor, kind: row.kind, at: instant(row.updated_at, new Date(row.created_at).toISOString()), details: row.details, payload: row.top ?? undefined, work: row.work ?? null, stageBefore: row.stage_before ?? null })) };
  } finally { await client.query('SET statement_timeout = DEFAULT').catch(() => {}); client.release(); }
}

/** A pool whose statements are counted, so a read's statements can be told from its rows. */
function counted(pool: pg.Pool) {
  const statements: string[] = [];
  return { statements, db: { query: ((text: string, values?: unknown[]) => { statements.push(text); return pool.query(text, values); }) as pg.Pool['query'] } };
}

/** The report routes: the interventions ledger, the flow analytics (Insights) and the shipping pulse. */
const reportRoutes = ['interventions?window=7', 'analytics/flow?window=30', 'analytics/flow/drilldown?window=30', 'shipping-pulse'];
/**
 * Records every statement and checkout on the report pool and on the coordination pools until
 * restored. The request's own authentication (the operator-agent credential check) is not the
 * report and is left out.
 */
function poolTraffic() {
  const report: string[] = [], coordination: string[] = [];
  const restores: (() => void)[] = [];
  const watch = (pool: pg.Pool, name: string, into: string[]) => {
    const { query, connect } = pool;
    pool.query = ((...args: unknown[]) => { const text = String(typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text); if (!/FROM operator_agents/.test(text)) into.push(`${name} query ${text.slice(0, 80)}`); return (query as (...a: unknown[]) => unknown).apply(pool, args); }) as pg.Pool['query'];
    // pg's own query checks a client out through connect(callback); only a caller's checkout counts.
    pool.connect = ((...args: unknown[]) => { if (typeof args[0] !== 'function') into.push(`${name} connect`); return (connect as (...a: unknown[]) => unknown).apply(pool, args); }) as pg.Pool['connect'];
    restores.push(() => { pool.query = query; pool.connect = connect; });
  };
  watch(store.reportPool, 'report', report); watch(store.pool, 'coordination', coordination); watch(store.leasePool, 'lease', coordination);
  return { report, coordination, restore: () => restores.forEach(restore => restore()) };
}

async function read(path: string, token = tokens.coordinator) {
  const started = performance.now();
  const response = await fetch(`${url}/api/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await response.text();
  return { status: response.status, ms: performance.now() - started, body: JSON.parse(text) };
}

test('unit:interventions-no-per-row-rebuild — the interventions ledger read rebuilds no document per row: a constant number of set reads and one pass in ledger order, identical to the per-row rebuild it replaces; over 200,000 delta-encoded events and 3,000 items GET /api/interventions?window=7 answers within 2 s and ?window=90 within 5 s', async () => {
  const seeded = (await store.pool.query("SELECT count(*)::int AS events, count(*) FILTER (WHERE payload ? 'delta')::int AS deltas, (SELECT count(*)::int FROM work_items) AS items FROM events")).rows[0];
  assert.equal(seeded.events, EVENTS); assert.equal(seeded.items, ITEMS);
  assert.ok(seeded.deltas > EVENTS / 2, `most saves are stored as deltas: ${seeded.deltas}`);

  for (const days of [7, 90]) {
    const since = iso(seededAt - days * day);
    const { statements, db } = counted(store.reportPool);
    const started = performance.now();
    const { rows, truncated } = await readInterventionLedger(db, { since });
    const elapsed = performance.now() - started;
    // Three set reads whatever the window holds, none of which rebuilds a document in SQL.
    assert.ok(statements.length <= 3, `${statements.length} statements for ${rows.length} rows`);
    for (const statement of statements) assert.doesNotMatch(statement, /graphyard_event_work|graphyard_work_at_revision/, statement);
    assert.ok(rows.length > 1_000, `the ${days}-day window folds ${rows.length} rows`);
    assert.ok(rows.some(row => row.work && row.stageBefore && row.stageBefore !== row.work.stage), 'the window holds rows that moved the stage');
    assert.ok(rows.some(row => row.kind === 'intervention.recorded'), 'the window holds recorded interventions');
    assert.ok(rows.some(row => row.work?.blocker), 'the window holds blocked rows read from deltas');
    assert.ok(rows.some(row => row.work?.escalations?.length), 'the window holds standing escalations');
    // Row for row, what the per-row rebuild read.
    const reference = await perRowLedger(since);
    assert.equal(truncated, reference.truncated);
    assert.equal(rows.length, reference.rows.length);
    for (let index = 0; index < rows.length; index++) assert.deepEqual(rows[index], reference.rows[index], `row ${rows[index].seq} (${rows[index].kind}) reads as the per-row rebuild read it`);
    assert.ok(elapsed < (days === 7 ? 2_000 : 5_000), `the ${days}-day ledger read took ${Math.round(elapsed)}ms`);
  }

  const week = await read('interventions?window=7');
  assert.equal(week.status, 200, JSON.stringify(week.body));
  assert.ok(week.ms < 2_000, `GET /api/interventions?window=7 took ${Math.round(week.ms)}ms over the seeded store`);
  assert.ok(week.body.ledger.rows > 0 && week.body.interventions.length > 0);
  const quarter = await read('interventions?window=90');
  assert.equal(quarter.status, 200, JSON.stringify(quarter.body));
  assert.ok(quarter.ms < 5_000, `GET /api/interventions?window=90 took ${Math.round(quarter.ms)}ms over the seeded store`);
});

test('unit:report-pool-isolated — the report routes run on their own small pool under a shorter statement timeout; with that pool saturated by slow queries, a lease renewal and an observation write still complete within their bounds, and the report waits for its own connections', async () => {
  // Every report route reads through the report pool and takes no coordination connection at all.
  for (const path of reportRoutes) {
    const { report, coordination, restore } = poolTraffic();
    try {
      const answered = await read(path, tokens.operator);
      assert.equal(answered.status, 200, `${path}: ${JSON.stringify(answered.body)}`);
    } finally { restore(); }
    assert.ok(report.length > 0, `GET /api/${path} reads through the report pool`);
    assert.deepEqual(coordination, [], `GET /api/${path} took no coordination connection`);
  }

  // The report pool is smaller than the coordination pool and times out sooner.
  assert.equal(store.reportPool.options.max, reportPoolConnections);
  assert.ok(reportPoolConnections < (store.pool.options.max ?? 0), `${reportPoolConnections} report connections beside ${store.pool.options.max}`);
  assert.ok(reportStatementTimeoutMs < storeStatementTimeoutMs);
  assert.equal(store.reportPool.options.statement_timeout, reportStatementTimeoutMs);
  assert.equal(store.pool.options.statement_timeout, storeStatementTimeoutMs);

  // A claimed item to renew, and a submitted one to observe.
  const key = () => randomUUID();
  const claimed = async (title: string) => {
    let work = await engine.execute(operator, 'create', null, { title, plannedFiles: ['src/isolated.ts'], criteria: [{ id: 'AC-1', text: 'Holds', proofs: ['unit:holds'] }] }, key());
    work = await engine.execute(operator, 'ready', work.id, {}, key());
    work = await engine.execute(worker, 'claim', work.id, {}, key());
    return engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'machine-a', path: `/srv/${work.key}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, key());
  };
  const leased = await claimed('Report pool isolation: lease');
  let work = await claimed('Report pool isolation: observation');
  work = await engine.execute(worker, 'submit', work.id, { epoch: work.epoch, pr: 4_910 }, key());
  const observation = (current: Work): Observation => ({ clockOffset: { min: 0, max: 0 }, candidate: { sha: sha('isolated'), baseSha: 'b'.repeat(40), pr: 4_910, branch: current.workspaces[0].branch, author: worker.id },
    checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null,
    baseTip: 'b'.repeat(40), baseTree: '7e'.repeat(20), files: [], scopeFiles: [], at: new Date().toISOString() } as Observation);

  // Saturate the report pool: every connection runs a slow statement, and more wait behind them.
  const slowSeconds = 6;
  const slow = Array.from({ length: reportPoolConnections + 2 }, () => store.reportPool.query(`SELECT pg_sleep(${slowSeconds})`));
  await sleep(300);
  assert.equal(store.reportPool.totalCount, reportPoolConnections);
  assert.ok(store.reportPool.waitingCount >= 2, `${store.reportPool.waitingCount} report statements wait for a connection`);
  let reportDone = false;
  const report = read('interventions?window=7').then(result => { reportDone = true; return result; });

  // The lease renewal and the observation write do not wait for any of it.
  let started = performance.now();
  const renewed = await engine.execute(worker, 'heartbeat', leased.id, { epoch: leased.epoch }, key());
  const renewalMs = performance.now() - started;
  assert.ok(renewed.revision > leased.revision && Date.parse(renewed.lease!.expiresAt) >= Date.parse(leased.lease!.expiresAt), 'the lease was renewed');
  assert.ok(renewalMs < 2_000, `the lease renewal took ${Math.round(renewalMs)}ms beside a saturated report pool`);
  started = performance.now();
  const observed = await engine.observe(work.id, work.revision, observation(work));
  const observationMs = performance.now() - started;
  assert.equal(observed.observation?.candidate.pr, 4_910);
  assert.ok(observationMs < 3_000, `the observation write took ${Math.round(observationMs)}ms beside a saturated report pool`);
  // The report route is still waiting for the report pool: it never took a coordination connection.
  assert.equal(reportDone, false, 'GET /api/interventions waits for the report pool');
  assert.equal(store.pool.waitingCount, 0);

  await Promise.all(slow);
  const answered = await report;
  assert.equal(answered.status, 200, JSON.stringify(answered.body));

  // The report pool's shorter statement timeout cancels a slow report where a coordination statement would run on.
  const strict = new Store(databaseUrl, { reportStatementTimeoutMs: 300 });
  try {
    await assert.rejects(strict.reportPool.query('SELECT pg_sleep(2)'), /statement timeout/);
    await strict.pool.query('SELECT pg_sleep(0.6)');
  } finally { await strict.close(); }
});
