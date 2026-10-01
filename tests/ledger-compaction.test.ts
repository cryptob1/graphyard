import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { Store, save, applyWorkDelta, documentBefore, resolvedPayloadSql, routineSaveKinds, snapshotEvery, type WorkDelta } from '../src/store.js';
import { compactLedger, ledgerCompactedKind, ledgerRetentionMs, configuredLedgerRetentionMs } from '../src/store/compaction.js';
import { DELIVERY_EVENT_PREDICATE } from '../src/store/tables/production.js';
import { Engine } from '../src/engine.js';
import { defaultDatabaseMaxBytes, readDatabaseCapacity } from '../src/master-resources.js';
import { readEventHistory, parseEventHistoryQuery } from '../src/events-history.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * Control-plane storage stays bounded (GY-979): a routine save stores only what changed, never a
 * whole work document, and routine rows past the retention window are compacted in bounded,
 * audited batches without changing what any surviving row reconstructs to.
 */
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker' };
let pg: EmbeddedPostgres, store: Store, engine: Engine;
let serial = 0;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 979;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('ledger-compaction'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('ledger_compaction_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/ledger_compaction_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.submissionObserver = null;
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const routine = new Set<string>(routineSaveKinds);
type Row = { seq: string; work_id: string | null; kind: string; payload: any };
const raw = async (id?: string) => (await store.pool.query('SELECT seq, work_id, kind, payload FROM events WHERE ($1::uuid IS NULL OR work_id=$1) ORDER BY seq', [id ?? null])).rows as Row[];
const resolvedBySeq = async () => new Map((await store.pool.query(`SELECT seq, ${resolvedPayloadSql()} AS payload FROM events WHERE work_id IS NOT NULL ORDER BY seq`)).rows.map(row => [String(row.seq), row.payload.work as Work | null]));
/** Mark the ledger read by the flow projection up to its newest row, as its tick does (flow-analytics.ts). */
const projectFlow = async () => { await store.pool.query('UPDATE flow_projection SET last_event=(SELECT max(seq) FROM events) WHERE id=1'); };
const atRevision = async (id: string, revision: number) => (await store.pool.query('SELECT graphyard_work_at_revision($1,$2) AS work', [id, String(revision)])).rows[0].work as Work | null;

/** A work item inserted directly, whose saves go through the store's own `save`. */
async function seeded(): Promise<Work> {
  const id = randomUUID(); const n = ++serial;
  const work = { id, key: `GY-C${n}`, title: `Compaction ${n}`, type: 'feature', priority: 3, stage: 'build', ready: true, revision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    epoch: 1, lease: { epoch: 1, owner: 'implementer', expiresAt: new Date().toISOString() }, submission: null, workspaces: [], dependencies: [], evidence: [], plannedFiles: ['src/a.ts'],
    criteria: [{ id: 'AC-1', text: randomBytes(1500).toString('hex'), proofs: ['integration:x'] }], actionQueue: { actions: [] as any[] }, gates: [] } as unknown as Work;
  await store.pool.query('INSERT INTO work_items(id, document) VALUES($1,$2)', [id, JSON.stringify(work)]);
  await write(work, 'create');
  return work;
}
async function write(work: Work, kind: string, details?: unknown) {
  const db = await store.pool.connect();
  try { await save(db, work, 'graphyard', kind, new Date(), details); } finally { db.release(); }
  return plain(work);
}
/** A whole routine row as the ledger stored it before GY-979: what compaction must clear. */
async function legacyWhole(work: Work, kind: string) {
  work.revision++; work.updatedAt = new Date().toISOString();
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [work.id, JSON.stringify(work)]);
  await store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', kind, JSON.stringify({ work })]);
  return plain(work);
}

test('unit:routine-events-store-no-snapshot — a routine save stores only what changed, never a whole work document, and every revision and history read reconstructs as before', async () => {
  const work: any = await seeded();
  const written: Work[] = [plain(work)];
  const push = async (kind: string, change: () => void) => { change(); written.push(await write(work, kind, { kind })); };
  // Far past snapshotEvery routine rows, and routine changes far past the delta size budget: still no whole document.
  for (let n = 0; n < snapshotEvery + 20; n++) await push(routineSaveKinds[n % routineSaveKinds.length], () => { work.lease.expiresAt = new Date(Date.now() + n).toISOString(); work.observation = { at: new Date().toISOString(), pass: n }; });
  await push('reconciled', () => { work.criteria[0].text = randomBytes(1500).toString('hex'); });
  await push('github.observed', () => { work.gates = [{ name: 'build', passed: true, reasons: [randomBytes(800).toString('hex')] }]; });
  // Non-routine kinds interleave, and keep the snapshotEvery and size rules.
  await push('dispatch.sent', () => { work.nested = { a: [1, 2, 3] }; });
  await push('requirements', () => { work.criteria[0].text = randomBytes(1500).toString('hex'); });
  await push('heartbeat', () => { work.lease.expiresAt = new Date().toISOString(); });
  await push('blocked', () => { work.blocker = 'Waiting on a credential'; });
  await push('action.claimed', () => { work.actionQueue.actions.push({ id: 'a1', kind: 'resync', state: 'claimed' }); });
  await push('action.failed', () => { work.actionQueue.actions[0].state = 'failed'; delete work.blocker; });
  // A routine save that moves the stage, or an observation that first records a delivery, is a lifecycle row and stays whole.
  await push('reconciled', () => { work.stage = 'review'; });
  await push('github.queue', () => { work.queue = { sequence: 4 }; });
  await push('github.observed', () => { work.delivery = { mergedAt: new Date().toISOString(), mergeSha: 'a'.repeat(40), authorizationRevision: work.revision }; });
  await push('github.observed', () => { work.observation = { at: new Date().toISOString(), merged: true }; });
  await push('session', () => { work.sessions = [{ name: 'worker', state: 'done' }]; });

  const rows = await raw(work.id);
  assert.equal(rows.length, written.length);
  const lifecycle = new Set([0, written.findIndex(doc => doc.stage === 'review'), written.findIndex(doc => doc.delivery)]);
  for (const [index, row] of rows.entries()) {
    if (lifecycle.has(index)) { assert.ok(row.payload.work, `${row.kind} at ${index} is a lifecycle row and stays whole`); continue; }
    if (routine.has(row.kind)) {
      assert.equal(row.payload.work, undefined, `routine ${row.kind} at ${index} stores no whole work document`);
      assert.ok(row.payload.delta?.ops, `routine ${row.kind} at ${index} stores what changed`);
    }
  }
  const byIndex = new Map(rows.map((row, index) => [row.seq, index]));
  // Every revision reconstructs: in JavaScript from its base, in SQL through every reader.
  const sql = await store.pool.query(`SELECT seq, ${resolvedPayloadSql()} AS payload FROM events WHERE work_id=$1 ORDER BY seq`, [work.id]);
  for (const [index, row] of rows.entries()) {
    const expected = written[index];
    if (row.payload.delta) {
      const base = rows.find(entry => Number(entry.seq) === row.payload.delta.base)!;
      assert.ok(base.payload.work, 'a delta names a whole row');
      assert.deepEqual(applyWorkDelta(base.payload.work, row.payload.delta as WorkDelta), expected, `${row.kind} at ${index} rebuilds in JavaScript`);
    }
    assert.deepEqual(sql.rows[index].payload.work, expected, `${row.kind} at ${index} rebuilds in SQL`);
    assert.deepEqual(sql.rows[index].payload.details, index ? { kind: row.kind } : undefined);
    assert.deepEqual(await atRevision(work.id, expected.revision), expected, `revision ${expected.revision} (${row.kind}, ${index - (byIndex.get(String(row.payload.delta?.base)) ?? index)} rows after its base) is found by revision`);
  }
  // Ledger history reads the same documents.
  const history = await readEventHistory(store.pool, parseEventHistoryQuery(new URLSearchParams({ work: work.id, routine: 'include', order: 'asc', limit: '1000' })));
  assert.deepEqual(history.events.map(event => event.payload.work), written);
  for (const event of await store.events(work.id)) assert.deepEqual(event.payload.work, written.find(doc => doc.revision === event.payload.work.revision));
  const client = await store.pool.connect();
  try { assert.deepEqual(await documentBefore(client, work.id, new Date(Date.now() + 60_000), () => true), written.at(-1)); } finally { client.release(); }

  // Through the engine: a worker's renewals past snapshotEvery are never whole.
  let w = await engine.execute(operator, 'create', null, { title: 'Renewals', plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:x'] }] }, randomUUID());
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID()); w = await engine.execute(worker, 'claim', w.id, {}, randomUUID());
  for (let beat = 0; beat < snapshotEvery + 5; beat++) w = await engine.execute(worker, 'heartbeat', w.id, { epoch: 1 }, randomUUID());
  const beats = (await raw(w.id)).filter(row => row.kind === 'heartbeat');
  assert.equal(beats.length, snapshotEvery + 5);
  assert.ok(beats.every(row => !row.payload.work && row.payload.delta), 'no renewal stores a whole document');
  assert.deepEqual((await store.events(w.id))[0].payload.work, plain(w), 'the newest renewal reads as the document');
});

test('unit:ledger-compaction-preserves-reconstruction — compaction removes only routine rows past the window, in bounded audited batches, and every work item reconstructs identically', async () => {
  // Rows old enough to compact, including whole routine rows the ledger stored before GY-979.
  const open: any = await seeded();
  for (let n = 0; n < 6; n++) { open.lease.expiresAt = new Date(Date.now() + n).toISOString(); await write(open, n % 2 ? 'heartbeat' : 'reconciled'); }
  await legacyWhole(open, 'github.observed');                              // whole routine row, base of the rows after it
  for (let n = 0; n < 4; n++) { open.observation = { at: new Date().toISOString(), n }; await write(open, 'github.observed'); }
  await write(open, 'blocked', { reason: 'non-routine delta on the legacy base' });
  await legacyWhole(open, 'heartbeat');                                     // whole routine row nothing references
  await legacyWhole(open, 'heartbeat');
  open.stage = 'review'; await legacyWhole(open, 'reconciled');             // whole routine row that moved the stage
  await legacyWhole(open, 'github.queue');
  for (let n = 0; n < 5; n++) { open.lease.expiresAt = new Date(Date.now() + n).toISOString(); await write(open, 'action.claimed'); }

  const delivered: any = await seeded();
  for (let n = 0; n < 4; n++) { delivered.lease.expiresAt = new Date(Date.now() + n).toISOString(); await write(delivered, 'heartbeat'); }
  const cited = delivered.revision - 1;                                    // a routine row whose revision the delivery cites
  delivered.stage = 'done'; delivered.delivery = { mergedAt: new Date().toISOString(), mergeSha: 'c'.repeat(40), authorizationRevision: cited };
  await legacyWhole(delivered, 'github.observed');                          // the delivery event itself, whole
  for (let n = 0; n < 3; n++) { delivered.observation = { at: new Date().toISOString(), n }; await legacyWhole(delivered, 'github.observed'); }
  await write(delivered, 'session');

  const merging: any = await seeded();                                      // observed merged, not yet done: its record is still judged
  for (let n = 0; n < 3; n++) { merging.observation = { at: new Date().toISOString(), merged: true, n }; await write(merging, 'github.observed'); }

  await sleep(50); const cutoff = Date.now(); await sleep(50);
  // Inside the window.
  for (let n = 0; n < 3; n++) { open.lease.expiresAt = new Date(Date.now() + n).toISOString(); await write(open, 'heartbeat'); }
  await projectFlow();

  const before = await raw();
  const documents = await resolvedBySeq();
  const items = (await store.pool.query('SELECT id, document FROM work_items ORDER BY number')).rows as { id: string; document: Work }[];
  const stageTimeline = (rows: Row[], id: string) => rows.filter(row => row.work_id === id && row.payload.work).map(row => row.payload.work.stage).filter((stage, index, all) => stage !== all[index - 1]);
  const citedBefore = await atRevision(delivered.id, cited);
  assert.ok(citedBefore);

  // The trigger refuses every delete outside compaction, and non-routine kinds inside it.
  await assert.rejects(store.pool.query("DELETE FROM events WHERE work_id=$1 AND kind='heartbeat'", [open.id]), /append-only/);
  const db = await store.pool.connect();
  try {
    await db.query('BEGIN'); await db.query("SET LOCAL graphyard.ledger_compaction = 'on'");
    await assert.rejects(db.query("DELETE FROM events WHERE work_id=$1 AND kind='blocked'", [open.id]), /append-only/);
  } finally { await db.query('ROLLBACK'); db.release(); }

  const batch = 3;
  const result = await compactLedger(store.pool, { retentionMs: Date.now() - cutoff, batch, batches: 100 });
  assert.ok(result.total > 0 && !result.skipped);
  const afterRows = await raw();
  const kept = new Set(afterRows.map(row => row.seq));
  const removed = before.filter(row => !kept.has(row.seq));
  assert.equal(removed.length, result.total);

  // Only routine kinds, only old and projected rows, never a base, a delivery event, a cited revision or a merged-not-done item's row.
  for (const row of removed) assert.ok(routine.has(row.kind), `${row.kind} is routine`);
  for (const row of before.filter(row => !routine.has(row.kind))) assert.ok(kept.has(row.seq), `non-routine ${row.kind} is kept`);
  const bases = new Set(afterRows.filter(row => row.payload.delta).map(row => String(row.payload.delta.base)));
  for (const base of bases) assert.ok(kept.has(base), `delta base ${base} is kept`);
  const deliveries = (await store.pool.query(`SELECT seq FROM events WHERE ${DELIVERY_EVENT_PREDICATE}`)).rows.map(row => String(row.seq));
  assert.ok(deliveries.length && deliveries.every(seq => kept.has(seq)), 'the delivery events are kept');
  assert.deepEqual(await atRevision(delivered.id, cited), citedBefore, 'the revision the delivery cites still reads back');
  assert.ok(before.filter(row => row.work_id === merging.id).every(row => kept.has(row.seq)), 'an item observed merged but not done keeps its record');
  const recent = before.filter(row => row.work_id === open.id && row.kind === 'heartbeat').slice(-3);
  assert.ok(recent.every(row => kept.has(row.seq)), 'rows inside the window are kept');
  assert.ok(removed.some(row => row.payload.work), 'legacy whole routine rows are compacted');
  assert.ok(removed.some(row => row.payload.delta), 'routine deltas are compacted');
  const stageMove = before.find(row => row.work_id === open.id && row.kind === 'reconciled' && row.payload.work?.stage === 'review')!;
  assert.ok(kept.has(stageMove.seq), 'a whole routine row that moved the stage is kept');
  const legacyBase = before.find(row => row.work_id === open.id && row.kind === 'github.observed' && row.payload.work)!;
  assert.ok(kept.has(legacyBase.seq), 'a whole routine row a surviving delta extends is kept');
  assert.ok(before.filter(row => row.work_id === open.id && row.kind === 'heartbeat' && row.payload.work).every(row => !kept.has(row.seq)), 'whole routine rows nothing extends are removed');

  // Every surviving row, every item's newest document, every stage timeline: identical.
  const documentsAfter = await resolvedBySeq();
  for (const [seq, document] of documentsAfter) assert.deepEqual(document, documents.get(seq), `row ${seq} reconstructs as before`);
  for (const item of items) {
    assert.deepEqual((await store.events(item.id))[0].payload.work, item.document, `${item.document.key} reconstructs its current document`);
    assert.deepEqual(stageTimeline(afterRows, item.id), stageTimeline(before, item.id), `${item.document.key} keeps its stage timeline`);
    assert.deepEqual(await atRevision(item.id, item.document.revision), item.document);
  }
  assert.deepEqual((await store.pool.query('SELECT id, document FROM work_items ORDER BY number')).rows, items);

  // Bounded batches, each audited with its counts per kind; the audit totals are what went.
  const audits = afterRows.filter(row => row.kind === ledgerCompactedKind);
  assert.ok(audits.length >= 2, `the work took several batches (${audits.length})`);
  const tally: Record<string, number> = {};
  for (const audit of audits) {
    const details = audit.payload.details;
    assert.equal(audit.work_id, null);
    assert.ok(details.total <= batch * 2, `a batch removes at most ${batch} rows per phase (${details.total})`);
    assert.equal(Object.values(details.removed as Record<string, number>).reduce((sum, n) => sum + n, 0), details.total);
    for (const [kind, n] of Object.entries(details.removed as Record<string, number>)) tally[kind] = (tally[kind] ?? 0) + n;
  }
  const expected: Record<string, number> = {};
  for (const row of removed) expected[row.kind] = (expected[row.kind] ?? 0) + 1;
  assert.deepEqual(tally, expected);
  assert.deepEqual(result.removed, expected);

  // Rows the flow projection has not read are kept whatever their age; the item's newest save always is.
  for (let n = 0; n < 3; n++) { open.lease.expiresAt = new Date(Date.now() + n).toISOString(); await write(open, 'heartbeat'); }
  const unprojected = (await raw(open.id)).slice(-3).map(row => row.seq);
  await compactLedger(store.pool, { retentionMs: 0, batch, batches: 100 });
  const remaining = new Set((await raw()).map(row => row.seq));
  assert.ok(unprojected.every(seq => remaining.has(seq)), 'unprojected rows are kept');
  await projectFlow();
  await compactLedger(store.pool, { retentionMs: 0, batch, batches: 100 });
  const settled = await compactLedger(store.pool, { retentionMs: 0, batch, batches: 100 });
  assert.equal(settled.total, 0, 'a settled ledger compacts nothing further');
  const final = await raw();
  assert.ok(final.filter(row => row.kind === ledgerCompactedKind).length > audits.length, 'audit rows are never compacted');
  for (const item of (await store.pool.query('SELECT id, document FROM work_items ORDER BY number')).rows as { id: string; document: Work }[]) {
    assert.deepEqual((await store.events(item.id))[0].payload.work, item.document, `${item.document.key}'s newest save is its current document`);
    assert.deepEqual(stageTimeline(final, item.id), stageTimeline(before, item.id));
  }

  // The retention window and its configuration.
  assert.equal(ledgerRetentionMs, 14 * 24 * 60 * 60 * 1000);
  assert.equal(configuredLedgerRetentionMs({}), ledgerRetentionMs);
  assert.equal(configuredLedgerRetentionMs({ GRAPHYARD_LEDGER_RETENTION_DAYS: '30' }), 30 * 24 * 60 * 60 * 1000);
  assert.equal(configuredLedgerRetentionMs({ GRAPHYARD_LEDGER_RETENTION_DAYS: '0' }), ledgerRetentionMs, 'less than a day is refused');
});

test('unit:database-bound-reads-volume — the database bound is the configured size, else the database volume\'s own size when the plane can read it, else the advisory default', async () => {
  const path = String((await store.pool.query("SELECT current_setting('data_directory') AS path")).rows[0].path);
  const volume = await statfs(path);
  const measured = await readDatabaseCapacity(store.pool, {});
  assert.equal(measured.bound, Number(volume.blocks) * Number(volume.bsize), 'the bound is the volume holding the data directory');
  assert.equal(measured.advisory, false, 'a measured bound is real, not advisory');
  assert.match(measured.detail!, /size of the database volume/);
  assert.equal((await readDatabaseCapacity(store.pool, { GRAPHYARD_DATABASE_MAX_BYTES: '5000000000' })).bound, 5_000_000_000, 'a configured bound wins');
  const hidden = { query: (sql: string) => sql.includes('data_directory') ? Promise.reject(new Error('must be superuser')) : store.pool.query(sql) };
  const fallback = await readDatabaseCapacity(hidden, {});
  assert.deepEqual([fallback.bound, fallback.advisory], [defaultDatabaseMaxBytes, true], 'a volume the plane cannot see leaves the advisory default');
});
