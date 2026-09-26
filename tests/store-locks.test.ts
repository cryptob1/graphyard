import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { advisoryLocks, Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { createBackup, restoreBackup } from '../src/backup.js';
import { schemaVersion } from '../src/release.js';
import type { Evidence, Observation, Principal, Work } from '../src/model.js';
import { actionSettleMs } from '../src/model/action-progress.js';
import { queueRef, type QueueSpeculation } from '../src/merge-queue.js';
import { coordinationHistoryLimit, coordinationRecordLimit, coordinationSessionLimit, coordinationSnapshot as trimInProcess, coordinationViewHeader, coordinationWork, deliverySettled, type CoordinationOmissions } from '../src/server/work-view.js';
import { coordinationRecords, coordinationSessions, coordinationTail } from '../src/store/coordination-sql.js';

/**
 * GY-203: migrations and backups take their own advisory locks, and the coordination snapshot is
 * served from a small index kept in the same transaction as every document write.
 *
 * One case per proof: integration:migration-backup-locks-separate (AC-1) and
 * integration:index-matches-documents (AC-2).
 */

let postgres: EmbeddedPostgres, port: number;
const url = (database: string) => `postgres://graphyard:testing-only@127.0.0.1:${port}/${database}`;
const stores: Store[] = [];
const open = async (database: string) => { const store = new Store(url(database)); stores.push(store); await store.init(); return store; };

before(async () => {
  // An offset no other test file takes (see tests/stalled-actions.test.ts).
  port = Number(process.env.GRAPHYARD_STORE_LOCKS_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 203);
  postgres = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-store-locks-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await postgres.initialise(); await postgres.start();
  for (const name of ['locks', 'restored', 'contended', 'lifecycle', 'board']) await postgres.createDatabase(name);
});
after(async () => {
  for (const store of stores) await store.close().catch(() => {});
  if (postgres) await postgres.stop();
});

/** A second connection standing in for the live replica, holding its locks until released. */
async function session(database: string, hold: (db: pg.Client) => Promise<void>) {
  const db = new pg.Client({ connectionString: url(database) });
  await db.connect(); await db.query('BEGIN'); await hold(db);
  return { db, release: async () => { await db.query('ROLLBACK'); await db.end(); } };
}
/** The live replica mid-coordination: the coordination lock held and a document written under it. */
const coordinating = (database: string) => session(database, async db => {
  await db.query('SELECT pg_advisory_xact_lock($1)', [advisoryLocks.coordination]);
  await db.query('UPDATE work_items SET document = document');
});
async function within<T>(ms: number, run: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([run, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not complete within ${ms} ms`)), ms); })]); }
  finally { clearTimeout(timer); }
}
/** Make the next init migrate again, as a release with a new migration does. */
const pendingMigration = (store: Store) => store.pool.query('COMMENT ON TABLE graphyard_schema IS NULL');

test('integration:migration-backup-locks-separate — a migration and a backup proceed while the coordination lock is held, and two migrations still serialize on the migration lock', async () => {
  const ids = Object.values(advisoryLocks);
  assert.equal(new Set(ids).size, ids.length, 'every concern has its own lock id');
  assert.notEqual(advisoryLocks.migration, advisoryLocks.coordination); assert.notEqual(advisoryLocks.backup, advisoryLocks.coordination);

  const live = await open('locks'), id = randomUUID();
  await live.pool.query("INSERT INTO work_items(id, document) VALUES($1, jsonb_build_object('id', $2::text, 'key', 'GY-1', 'stage', 'build'))", [id, id]);

  // A release that must migrate starts while the live replica holds the coordination lock and a
  // written document: it waits on neither.
  await pendingMigration(live);
  const replica = await coordinating('locks');
  const next = new Store(url('locks')); stores.push(next);
  try {
    const started = Date.now();
    await within(5_000, next.init({ lockTimeoutMs: 3_000 }), 'the migration');
    assert.ok(Date.now() - started < 3_000, 'the migration never waited out its lock budget');
    assert.equal(await next.schema(), schemaVersion);

    // A backup reads beside it, and a restore's exclusive backup lock is granted beside it too.
    const backup = await within(5_000, createBackup(live.pool), 'the backup');
    assert.ok(backup.tables.some(table => table.name === 'work_items' && table.rows.length === 1));
    const target = await open('restored');
    const targetReplica = await session('restored', async db => { await db.query('SELECT pg_advisory_xact_lock($1)', [advisoryLocks.coordination]); });
    try {
      const restored = await within(5_000, restoreBackup(target.pool, backup), 'the restore');
      assert.equal(restored.restored.work_items, 1);
      // The index is a cache the restore rebuilt through its trigger, not a table the backup carries.
      assert.equal(backup.tables.some(table => table.name === 'work_index'), false);
      assert.equal(Number((await target.pool.query('SELECT count(*) AS n FROM work_index')).rows[0].n), 1);
    } finally { await targetReplica.release(); }
  } finally { await replica.release(); }

  // Two migrations serialize: while one holds the migration lock, the next waits on exactly that
  // lock, fails within its budget naming it, and completes once it is released.
  await pendingMigration(live);
  const migrating = await session('locks', async db => { await db.query('SELECT pg_advisory_xact_lock($1)', [advisoryLocks.migration]); });
  const blocked = new Store(url('locks')); stores.push(blocked);
  try {
    const refused = await blocked.init({ lockTimeoutMs: 500 }).then(() => null, (error: Error) => error);
    assert.ok(refused, 'a second migration does not run beside the first');
    assert.match(refused.message, new RegExp(`waiting for the migration advisory lock pg_advisory_xact_lock\\(${advisoryLocks.migration}\\)`));
    const waiting = blocked.init({ lockTimeoutMs: 10_000 });
    let observed = false;
    for (let attempt = 0; attempt < 100 && !observed; attempt++) {
      observed = Number((await live.pool.query("SELECT count(*) AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objid=$1", [advisoryLocks.migration])).rows[0].n) === 1;
      if (!observed) await delay(20);
    }
    assert.ok(observed, 'the second migration queues on the migration lock');
    await migrating.release();
    await within(10_000, waiting, 'the queued migration');
    assert.equal(await blocked.schema(), schemaVersion);
  } finally { await migrating.release().catch(() => {}); }
});

test('GY-257 — a restore excludes a write in flight on the target: it waits for it, then refuses a ledger that is no longer empty', async () => {
  const live = await open('locks');
  const backup = await createBackup(live.pool);
  const target = await open('contended'), id = randomUUID();
  // A writer that took no coordination lock opens its write before the restore starts and commits
  // only once the restore is waiting: without the table locks the restore saw an empty ledger,
  // wrote beside it, and both committed.
  const writer = await session('contended', async db => { await db.query('LOCK TABLE work_items IN ROW EXCLUSIVE MODE'); });
  let committed = false;
  try {
    const restoring = restoreBackup(target.pool, backup).then(() => null, (error: Error) => error);
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      waiting = Number((await target.pool.query("SELECT count(*) AS n FROM pg_locks WHERE locktype='relation' AND mode='ExclusiveLock' AND NOT granted AND relation='work_items'::regclass")).rows[0].n) === 1;
      if (!waiting) await delay(20);
    }
    assert.ok(waiting, 'the restore waits for the write in flight');
    await writer.db.query("INSERT INTO work_items(id, document) VALUES($1, jsonb_build_object('id', $2::text, 'key', 'GY-9', 'stage', 'build'))", [id, id]);
    await writer.db.query('COMMIT'); committed = true; await writer.db.end();
    const refused = await within(5_000, restoring, 'the restore');
    assert.ok(refused, 'the restore does not interleave with the write');
    assert.match(refused.message, /Restore requires an empty database: work_items already holds 1 row/);
    assert.deepEqual((await target.pool.query('SELECT id FROM work_items')).rows.map(row => row.id), [id]);
  } finally { if (!committed) await writer.release().catch(() => {}); }
});

// ---- AC-2: the index ------------------------------------------------------------------------

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const number = (value: unknown) => typeof value === 'number' ? value : null;
const time = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;
const noOmissions = (): CoordinationOmissions => ({ evidence: 0, dispatchHistory: 0, queueHistory: 0, actionHistory: 0, sessions: 0 });

/** The index row a document must project to, computed from the document in TypeScript. */
function expectedIndex(work: Work, position: number) {
  const actions = Array.isArray(work.actionQueue?.actions) ? work.actionQueue!.actions : [];
  const due = actions.filter(row => work.stage !== 'done' || row.kind === 'verify-deployment').map(row => {
    const times = [time(row.requestedAt), time(row.retryAt), row.state === 'done' ? time(row.resolvedAt) + actionSettleMs : NaN,
      row.state !== 'pending' && row.claim && typeof row.claim === 'object' ? time(row.claim.expiresAt) : NaN].filter(Number.isFinite);
    return times.length ? Math.max(...times) : 0;
  });
  return {
    number: position, key: work.key ?? null, stage: work.stage ?? null, priority: number(work.priority), owner: work.lease?.owner ?? null,
    epoch: number(work.epoch), revision: number(work.revision), pr: number(work.candidate?.pr),
    pr_state: work.observation?.merged === true ? 'merged' : work.observation?.prState ?? null, next_action: work.nextAction?.kind ?? null,
    due_at: due.length ? new Date(Math.min(...due)).toISOString() : null, settled: deliverySettled(work),
  };
}
const numeric = (value: unknown) => value === null ? null : Number(value);
const stored = (row: any) => ({
  number: Number(row.number), key: row.key, stage: row.stage, priority: numeric(row.priority), owner: row.owner, epoch: numeric(row.epoch),
  revision: numeric(row.revision), pr: numeric(row.pr), pr_state: row.pr_state, next_action: row.next_action,
  due_at: row.due_at ? (row.due_at as Date).toISOString() : null, settled: row.settled,
});

/** Every index row equals what its document projects to, and a settled delivery's summary is its coordination view. */
async function assertIndexMatches(store: Store, label: string) {
  const documents = (await store.pool.query('SELECT id, number, document FROM work_items ORDER BY number')).rows;
  const index = new Map((await store.pool.query('SELECT * FROM work_index')).rows.map(row => [row.id, row]));
  assert.equal(index.size, documents.length, `${label}: one index row per document`);
  for (const { id, number: position, document } of documents) {
    const row = index.get(id);
    assert.ok(row, `${label}: ${document.key} is indexed`);
    assert.deepEqual(stored(row), expectedIndex(document, Number(position)), `${label}: ${document.key}'s index row`);
    if (!row.settled) { assert.equal(row.summary, null, `${label}: a live item keeps no summary`); continue; }
    const fromWhole = noOmissions(), fromSummary = noOmissions();
    assert.deepEqual(plain(coordinationWork(row.summary, fromSummary)), plain(coordinationWork(document, fromWhole)), `${label}: ${document.key}'s summary is its coordination view`);
    for (const key of Object.keys(fromWhole) as (keyof CoordinationOmissions)[]) assert.equal(row.trimmed[key] + fromSummary[key], fromWhole[key], `${label}: ${document.key} counts what its summary left out of ${key}`);
  }
}

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'agent-a', role: 'worker', runtime: 'claude' };
const executor: Principal = { id: 'executor-a', role: 'coordinator' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const ci: Principal = { id: 'ci', role: 'producer', proofs: ['integration:claim-safety'] };
const head = 'a'.repeat(40), base = 'b'.repeat(40);

test('integration:index-matches-documents — the index equals the documents after every mutation, and the coordination snapshot of a 200-item board reads only live documents and is under 1 MB', async () => {
  // The SQL and the TypeScript form of the view keep the same amounts.
  assert.deepEqual([coordinationTail, coordinationRecords, coordinationSessions], [coordinationHistoryLimit, coordinationRecordLimit, coordinationSessionLimit]);
  const store = await open('lifecycle');
  const engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [operator, worker, executor, coordinator, ci];
  const reload = async (item: Work) => (await store.list()).find(entry => entry.id === item.id)!;
  const check = (label: string) => assertIndexMatches(store, label);

  // One item through its whole life, the index checked after each write.
  let w = await engine.execute(operator, 'create', null, { title: 'Indexed', plannedFiles: ['src/indexed.ts'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, randomUUID());
  const other = await engine.execute(operator, 'create', null, { title: 'Bystander', priority: 3, plannedFiles: ['src/other.ts'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, randomUUID());
  await check('created');
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID()); await check('released');
  assert.ok((await store.pool.query('SELECT due_at FROM work_index WHERE id=$1', [w.id])).rows[0].due_at, 'a pending dispatch row is due');
  const claimed = await engine.claimNextAction(executor, { host: 'host-1', kinds: ['dispatch'], work: w.key }, randomUUID());
  assert.ok(claimed.action); await check('action claimed');
  await engine.settleClaimedAction(executor, claimed.action!.id, { result: 'failed', reason: 'no worker free' }, randomUUID()); await check('action failed');
  w = await engine.execute(worker, 'claim', w.id, {}, randomUUID()); await check('leased');
  assert.equal((await store.pool.query('SELECT owner FROM work_index WHERE id=$1', [w.id])).rows[0].owner, worker.id);
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: '/tmp/indexed', branch: 'graphyard/indexed' }, randomUUID());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: 901 }, randomUUID()); await check('submitted');
  const observation = (): Observation => ({ clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: 901, branch: 'graphyard/indexed', author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }],
    protected: true, mergeable: true, merged: false, mergeSha: null, files: [], scopeFiles: [], at: new Date().toISOString(), prState: 'open' });
  w = await engine.observe(w.id, w.revision, observation()); await check('observed');
  w = await engine.execute(ci, 'evidence', w.id, { proof: 'integration:claim-safety', sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 5, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } }, randomUUID());
  await check('evidenced');
  const speculation: QueueSpeculation = { ref: queueRef(w.key), tip: head, base, baseTree: '7e'.repeat(20), predecessors: [], policyRevision: w.policyRevision, publishedAt: new Date().toISOString() };
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{queue,speculation}',$2::jsonb) WHERE id=$1", [w.id, JSON.stringify(speculation)]);
  w = await engine.observe(w.id, (await reload(w)).revision, observation()); await check('queued');
  const committed = await engine.requestEnqueue(coordinator, w.id, { enqueue: true, expectedRevision: (await reload(w)).revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID()); await check('merge committed');
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  w = await engine.observe(w.id, committed.revision, { ...observation(), merged: true, mergedAt, mergeSha: 'e'.repeat(40) });
  assert.equal(w.stage, 'done'); await check('delivered');
  assert.equal((await store.pool.query('SELECT pr_state FROM work_index WHERE id=$1', [w.id])).rows[0].pr_state, 'merged');
  // Writes that bypass the engine are indexed all the same: its deployment verified, then a
  // session running on it, then that session finished.
  await store.pool.query("UPDATE work_items SET document = jsonb_set(document || '{\"nextAction\": null}', '{actionQueue,actions}', '[]') WHERE id=$1", [w.id]);
  await check('deployment verified');
  assert.equal((await store.pool.query('SELECT settled FROM work_index WHERE id=$1', [w.id])).rows[0].settled, true, 'a delivery owing nothing is settled');
  const handle = { id: 'session-1', kind: 'review', role: 'review', state: 'running', agentName: 'review-1', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), outcome: null };
  await store.pool.query("UPDATE work_items SET document = jsonb_set(document, '{sessions}', $2::jsonb) WHERE id=$1", [w.id, JSON.stringify([handle])]);
  await check('session running');
  assert.equal((await store.pool.query('SELECT settled FROM work_index WHERE id=$1', [w.id])).rows[0].settled, false, 'a running session unsettles it');
  await store.pool.query("UPDATE work_items SET document = jsonb_set(document, '{sessions}', $2::jsonb) WHERE id=$1", [w.id, JSON.stringify([{ ...handle, state: 'finished', endedAt: new Date().toISOString() }])]);
  await check('session finished');
  // GY-257: a delivered item still under containment quarantine is not settled, so the coordination
  // view keeps the finished implementation session containment recovery finds its pane from.
  const worked = { id: 'agent-a:1', kind: 'implementation', principal: 'agent-a', epoch: 1, pane: 'w1:p1', state: 'finished', agentName: 'agent-a', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), endedAt: new Date().toISOString(), outcome: null };
  const quarantine = { owner: 'agent-a', epoch: 1, at: new Date().toISOString(), settlementHash: 'f'.repeat(64) };
  await store.pool.query("UPDATE work_items SET document = jsonb_set(jsonb_set(document, '{sessions}', $2::jsonb), '{containmentQuarantine}', $3::jsonb) WHERE id=$1", [w.id, JSON.stringify([worked]), JSON.stringify(quarantine)]);
  await check('quarantined delivery');
  assert.equal((await store.pool.query('SELECT settled FROM work_index WHERE id=$1', [w.id])).rows[0].settled, false, 'a containment quarantine unsettles it');
  const quarantined = (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [w.id])).rows[0].document as Work;
  assert.deepEqual(coordinationWork(quarantined, noOmissions()).sessions?.map(entry => entry.id), ['agent-a:1'], 'the view keeps the quarantined epoch\'s session');
  await store.pool.query("UPDATE work_items SET document = document || '{\"containmentQuarantine\": null}' WHERE id=$1", [w.id]);
  await check('quarantine settled');
  assert.equal((await store.pool.query('SELECT settled FROM work_index WHERE id=$1', [w.id])).rows[0].settled, true, 'settling the quarantine settles the delivery');
  await engine.execute(operator, 'ready', other.id, {}, randomUUID()); await check('bystander released');
  // A rollback leaves the index as it was: it is written in the document's own transaction.
  const before = (await store.pool.query('SELECT revision FROM work_index WHERE id=$1', [other.id])).rows[0].revision;
  await store.transaction(async db => { await db.query("UPDATE work_items SET document = jsonb_set(document, '{revision}', '999') WHERE id=$1", [other.id]); throw new Error('abandoned'); }).catch(() => {});
  assert.equal((await store.pool.query('SELECT revision FROM work_index WHERE id=$1', [other.id])).rows[0].revision, before);
  await check('rolled back');

  // A 200-item board, as production's is shaped: nine in ten delivered, a few items in review or
  // rework, the rest ready or building; every item that has lived carries the history a long-lived
  // item accumulates.
  const board = await open('board');
  const now = new Date();
  for (let index = 0; index < BOARD_ITEMS; index++) {
    const item = boardItem(index, now, index < ACTIVE_ITEMS ? 'active' : index < LIVE_ITEMS ? 'fresh' : 'settled');
    await board.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [item.id, JSON.stringify(item)]);
    await board.pool.query('INSERT INTO jobs(work_id) VALUES($1)', [item.id]);
  }
  await assertIndexMatches(board, 'board');
  assert.equal(Number((await board.pool.query('SELECT count(*) AS n FROM work_index WHERE settled')).rows[0].n), BOARD_ITEMS - LIVE_ITEMS);
  const token = 'c'.repeat(40);
  const http = server(new Engine(board, [15368], 120, 'owner/project'), [{ id: 'coordinator', role: 'coordinator', token }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  try {
    const read = async (headers: Record<string, string> = {}) => {
      const response = await fetch(`http://127.0.0.1:${(http.address() as AddressInfo).port}/api/work-snapshot${Object.keys(headers).length ? '' : '?view=full'}`, { headers: { ...headers, Authorization: `Bearer ${token}` } });
      const text = await response.text(); assert.equal(response.status, 200, text.slice(0, 300));
      return { body: JSON.parse(text), bytes: Buffer.byteLength(text) };
    };
    // The server's own reconciliation may still be evaluating the fixture: compare a coordination
    // read with full reads on either side of it that agree, so all three saw one state.
    const revisions = (body: { work: Work[] }) => body.work.map(item => item.revision).join();
    let view!: { body: any; bytes: number }, seen!: { text: string; rows: any[] }[], full!: { body: any; bytes: number };
    for (let attempt = 0; attempt < 20; attempt++) {
      const before = await read();
      ({ result: view, seen } = await spyQueries(board, () => read({ [coordinationViewHeader]: 'coordination' })));
      full = await read();
      if (revisions(before.body) === revisions(full.body) && revisions(view.body) === revisions(full.body)) break;
      await delay(500);
    }
    assert.equal(view.body.work.length, BOARD_ITEMS);
    assert.ok(view.bytes < 1_000_000, `the coordination snapshot of ${BOARD_ITEMS} items is ${view.bytes} bytes (the full snapshot is ${full.bytes})`);
    // Only the live items' documents were read; every settled delivery came from the index.
    const settled = new Set((await board.pool.query('SELECT id FROM work_index WHERE settled')).rows.map(row => row.id));
    const fromDocuments = seen.filter(entry => /\bFROM work_items\b/.test(entry.text)).flatMap(entry => entry.rows).map(row => row.document?.id).filter(Boolean);
    assert.equal(fromDocuments.length, LIVE_ITEMS, 'the live documents were read');
    assert.deepEqual(fromDocuments.filter(id => settled.has(id)), [], 'no settled delivery\'s document was read');
    // And the view is exactly what the coordination rule makes of the whole documents.
    const expected = plain(trimInProcess(full.body as { work: Work[] }));
    assert.deepEqual(view.body.work, expected.work);
    assert.deepEqual(view.body.omitted, expected.omitted);
    for (const [index, item] of (view.body.work as Work[]).entries()) {
      const whole = full.body.work[index] as Work;
      for (const field of ['id', 'stage', 'gates', 'violations', 'lease', 'candidate', 'submission', 'criteria', 'epoch', 'delivery', 'nextAction', 'queue'] as const) assert.deepEqual(item[field], whole[field], `${item.key} ${field}`);
    }
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); }
});

const BOARD_ITEMS = 200, LIVE_ITEMS = 20, ACTIVE_ITEMS = 5, HEADS = 12;
const sha = (item: number, h: number) => `${item.toString(16).padStart(4, '0')}${h.toString(16).padStart(4, '0')}`.padEnd(40, 'a');

/**
 * One board item: a settled delivery or an active one with the history a long-lived item
 * accumulates (evidence for every head it had, resolved requests, action rows and sessions), or a
 * fresh one released but not yet built.
 */
function boardItem(index: number, now: Date, kind: 'settled' | 'active' | 'fresh'): Work {
  const id = randomUUID(), key = `GY-${index + 1}`, at = now.toISOString(), current = sha(index, HEADS), delivered = kind === 'settled';
  const proofs = ['integration:alpha', 'integration:beta', 'e2e:gamma'];
  if (kind === 'fresh') return {
    id, key, title: `Board item ${key}`, description: 'An item released and waiting for its implementation. '.repeat(10), type: 'feature', priority: index % 3,
    dependencies: [], criteria: proofs.map((proof, n) => ({ id: `AC-${n + 1}`, text: `Criterion ${n + 1} of ${key}`, proofs: [proof] })),
    policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: ['src/server/', 'tests/'], stage: 'ready', revision: 3, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 0, lease: null, workspaces: [], implementers: [], submission: null, candidate: null,
    reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [],
    gates: ['ready', 'build', 'review', 'test', 'acceptance', 'merge'].map(name => ({ name, passed: name === 'ready', reasons: name === 'ready' ? [] : [`${name} is still owed`] })),
    nextAction: { kind: 'dispatch', work: id, key, gate: 'build', refusal: null, reason: `${key} is ready and unassigned`, inputs: { kind: 'dispatch', epoch: 0, target: 'implementation', priority: index % 3, plannedFiles: ['src/server/', 'tests/'] }, llmRole: 'implement', binding: 'dispatch:0' },
    actionQueue: { actions: [{ id: `${key}-dispatch`, kind: 'dispatch', work: id, key, gate: 'build', refusal: null, reason: `${key} is ready and unassigned`, binding: 'dispatch:0', inputs: { kind: 'dispatch', epoch: 0, target: 'implementation', priority: index % 3, plannedFiles: ['src/server/', 'tests/'] }, requestedBy: 'graphyard', requestedAt: at, state: 'pending', claim: null, attempts: 0, history: [{ at, event: 'requested', requester: 'graphyard', executor: null, result: null, reason: 'released' }] }], history: [] },
    autoDispatch: { review: null, producers: [], history: [] }, queue: null,
  } as unknown as Work;
  const evidence: Evidence[] = [];
  for (let h = 1; h <= HEADS; h++) for (const proof of proofs) evidence.push({
    id: randomUUID(), proof, sha: sha(index, h), baseSha: base, policyRevision: 1, producer: 'proof-runner', trusted: true, result: 'pass', executed: 12, skipped: 0, at,
    environment: 'node 24 on the proof runner', url: `https://ci.example/runs/${index}-${h}`, scopeFiles: Array.from({ length: 30 }, (_, file) => `src/module-${file}/component-${index}.ts`),
    artifacts: Array.from({ length: 4 }, (_, n) => ({ kind: 'report', label: `report ${n}`, mediaType: 'application/json', size: 20_000, digest: `sha256:${'d'.repeat(64)}`, availability: 'available', reference: { requestId: randomUUID(), artifactId: randomUUID() } })),
  } as unknown as Evidence);
  const record = (n: number) => ({ at, event: 'failed', requester: 'graphyard', executor: 'executor-a', result: 'failed', reason: `attempt ${n} refused: ${'the condition it names still stands. '.repeat(4)}` });
  const resolvedRows = Array.from({ length: 40 }, (_, n) => ({ id: `${key}-row-${n}`, kind: 'dispatch', work: id, key, state: 'done', result: 'failed', resolvedAt: at, requestedAt: at, attempts: 5, claim: null, history: Array.from({ length: 8 }, (_, r) => record(r)) }));
  const requests = Array.from({ length: 44 }, (_, n) => ({ id: randomUUID(), kind: n % 2 ? 'producer' : 'review', sha: sha(index, (n % (HEADS - 1)) + 1), baseSha: base, policyRevision: 1, pr: index + 1, requestedAt: at, reason: 'submitted head', state: 'cancelled', resolvedAt: at, resolution: 'head changed' }));
  const sessions = Array.from({ length: 30 }, (_, n) => ({ id: `${key}-session-${n}`, kind: 'review', role: 'review', state: 'finished', agentName: `review-${n}`, host: 'host-1', runtime: 'claude', startedAt: at, updatedAt: at, endedAt: at, outcome: `vanished: the runtime has not reported pane ${n} for 61s after its last observed activity`, subject: `${key}: review` }));
  const stage = delivered ? 'done' : (['build', 'review', 'test', 'acceptance', 'merge'] as const)[index % 5];
  return {
    id, key, title: `Board item ${key}`, description: 'An item with the history a long-lived ledger accumulates. '.repeat(10), type: 'feature', priority: index % 3,
    dependencies: [], criteria: proofs.map((proof, n) => ({ id: `AC-${n + 1}`, text: `Criterion ${n + 1} of ${key}`, proofs: [proof] })),
    policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: ['src/server/', 'tests/'], stage, revision: 400, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 2, lease: null, workspaces: [], implementers: ['worker-a'], submission: { epoch: 2, pr: index + 1 },
    candidate: { sha: current, baseSha: base, pr: index + 1, branch: `graphyard/gy-${index + 1}-2`, author: 'worker-a' },
    reworkRequested: false, scenarioRequirements: [], evidence, blocker: null, violations: [],
    observation: { at, candidate: { sha: current, baseSha: base, pr: index + 1 }, files: ['src/server/index.ts'], checks: [], reviews: [], prState: delivered ? 'closed' : 'open', merged: delivered, mergeSha: delivered ? 'f'.repeat(40) : null, mergeable: true, protected: true,
      scopeFiles: Array.from({ length: 200 }, (_, file) => ({ path: `src/generated/file-${file}.ts`, sha: 'e'.repeat(40), status: 'unchanged' })) },
    gates: ['ready', 'build', 'review', 'test', 'acceptance', 'merge'].map(name => ({ name, passed: delivered, reasons: delivered ? [] : [`${name} is still owed`] })),
    queueHistory: Array.from({ length: 40 }, (_, n) => ({ at, event: 'placed', sequence: n })),
    autoDispatch: { review: null, producers: [], history: requests },
    actionQueue: { actions: [], history: resolvedRows },
    sessions, pipeline: { attempts: Array.from({ length: 20 }, (_, n) => ({ attempt: n, startedAt: at, endedAt: at, outcome: 'rework' })) },
    nextAction: delivered ? null : { kind: 'request-review', work: id, key, gate: 'review', refusal: null, reason: 'waiting on review', inputs: { kind: 'request-review' }, llmRole: null, binding: 'review:1' },
    queue: null, ...(delivered ? { delivery: { mergeSha: 'f'.repeat(40), mergedAt: at } } : {}),
  } as unknown as Work;
}

/** Every statement the store's checked-out clients and pool run while `run` does, with the rows each returned. */
async function spyQueries<T>(target: Store, run: () => Promise<T>) {
  const seen: { text: string; rows: any[] }[] = [];
  const record = (original: (...args: any[]) => any) => async (...args: any[]) => {
    const result = await original(...args);
    seen.push({ text: typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '', rows: result?.rows ?? [] });
    return result;
  };
  const pool = target.pool as any, query = pool.query, connect = pool.connect;
  pool.query = record(query.bind(pool));
  const clients: [any, any][] = [];
  pool.connect = (...args: any[]) => {
    if (typeof args[0] === 'function') return connect.apply(pool, args);
    return connect.apply(pool, args).then((client: any) => { clients.push([client, client.query]); client.query = record(client.query.bind(client)); return client; });
  };
  try { return { result: await run(), seen }; }
  finally { pool.query = query; pool.connect = connect; for (const [client, own] of clients) client.query = own; }
}
