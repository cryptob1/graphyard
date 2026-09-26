import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store, appendSave, applyWorkDelta, eventStats, resolvedPayloadSql, snapshotEvery, workDiff, type WorkDelta } from '../src/store.js';
import { Engine, readAttestations } from '../src/engine.js';
import { readInterventionLedger } from '../src/interventions.js';
import { ledgerEntry, ledgerReplayColumns, reconstructTimeline } from '../src/pipeline-speed.js';
import { readEventHistory, parseEventHistoryQuery } from '../src/events-history.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * Every save of every kind is stored as a delta on the item's last full snapshot when the
 * change is small (store/snapshot-delta.ts). These check that any such row reconstructs the
 * document exactly, in JavaScript and in SQL, that full snapshots recur so no row is more than
 * one bounded lookup from its document, that the readers see the documents, and that the
 * ledger's growth by kind is readable.
 */
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker' };
let pg: EmbeddedPostgres, store: Store, engine: Engine;
let serial = 0;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 177;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('event-ledger-delta'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('event_ledger_delta_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/event_ledger_delta_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.submissionObserver = null;
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const raw = async (id: string) => (await store.pool.query('SELECT seq, kind, payload, pg_column_size(payload) AS bytes FROM events WHERE work_id=$1 ORDER BY seq', [id])).rows as { seq: string; kind: string; payload: any; bytes: number }[];
const resolved = async (id: string) => (await store.pool.query(`SELECT seq, kind, ${resolvedPayloadSql()} AS payload FROM events WHERE work_id=$1 ORDER BY seq`, [id])).rows as { seq: string; kind: string; payload: any }[];

/** A work item inserted directly, whose saves the test drives through `appendSave`. */
async function seeded(): Promise<Work> {
  const id = randomUUID(); const n = ++serial;
  const work = { id, key: `GY-D${n}`, title: `Delta ${n}`, stage: 'implementing', revision: 1, updatedAt: new Date().toISOString(), lease: { epoch: 1, owner: 'implementer', expiresAt: new Date().toISOString() },
    submission: null, workspaces: [], plannedFiles: ['src/a.ts'], criteria: [{ id: 'AC-1', text: randomBytes(2000).toString('hex'), proofs: ['integration:x'] }], actionQueue: { actions: [] as any[] }, nested: { a: { b: 1, c: [1, 2, 3] }, gone: true, nothing: null } } as unknown as Work;
  await store.pool.query('INSERT INTO work_items(id, document) VALUES($1,$2)', [id, JSON.stringify(work)]);
  return work;
}
async function saveAs(work: Work, kind: string, details?: unknown) {
  work.revision++; work.updatedAt = new Date().toISOString();
  const db = await store.pool.connect();
  try { await appendSave(db, work, 'graphyard', kind, details); } finally { db.release(); }
  return plain(work);
}

test('unit:delta-any-kind-reconstructs — a save of any kind is a delta that rebuilds the exact document in JavaScript and in SQL, through removals, nulls, array growth and shrinkage', async () => {
  const work: any = await seeded();
  const written: Work[] = [await saveAs(work, 'create')];
  const steps: [string, () => void][] = [
    ['action.claimed', () => { work.actionQueue.actions.push({ id: 'a1', history: [{ event: 'requested' }, { event: 'claimed' }] }); }],
    ['action.failed', () => { work.actionQueue.actions[0].history.push({ event: 'failed', reason: null }); }],
    ['reconciled', () => { delete work.nested.gone; work.nested.a.b = null; }],
    ['dispatch.sent', () => { work.nested.a.c = [9]; work.lease.expiresAt = new Date(Date.now() + 1000).toISOString(); }],
    ['loop.session', () => { work.nested.fresh = { deep: [1, { x: 'y' }] }; work.nested.nothing = 0; }],
    ['github.observed', () => { work.observation = { at: new Date().toISOString(), checks: [{ name: 'test', result: 'success' }] }; }],
    ['action.completed', () => { work.actionQueue.actions = []; work.lease = null; }],
    ['heartbeat', () => { work.submission = { epoch: 1, pr: 7 }; work['odd key/with.dots'] = { '0': 'object key that looks like an index' }; }],
  ];
  for (const [kind, change] of steps) { change(); written.push(await saveAs(work, kind, { step: kind })); }
  const rows = await raw(work.id);
  assert.equal(rows.length, written.length);
  assert.ok(rows[0].payload.work, 'the first save is a full snapshot');
  const deltas = rows.filter(row => row.payload.delta);
  assert.deepEqual(deltas.map(row => row.kind), steps.map(([kind]) => kind), 'every later save, of whatever kind, is a delta');
  const sql = await resolved(work.id);
  rows.forEach((row, index) => {
    const base = row.payload.delta ? rows.find(entry => Number(entry.seq) === row.payload.delta.base)!.payload.work : null;
    if (row.payload.delta) {
      assert.ok(base, 'the delta names a full snapshot');
      assert.deepEqual(applyWorkDelta(base, row.payload.delta as WorkDelta), written[index], `${row.kind} rebuilds in JavaScript`);
      assert.ok(row.bytes * 3 < rows[0].bytes, `${row.kind} delta (${row.bytes} B) is a fraction of the snapshot (${rows[0].bytes} B)`);
    }
    assert.deepEqual(sql[index].payload.work, written[index], `${row.kind} rebuilds in SQL`);
    assert.deepEqual(sql[index].payload.details, index ? { step: row.kind } : undefined);
  });
});

test('unit:delta-diff-roundtrip — the diff and its application agree for arbitrary documents, in JavaScript and in SQL', async () => {
  const item = await seeded();
  const random = (depth: number): any => {
    const pick = Math.floor(Math.random() * (depth > 2 ? 4 : 7));
    if (pick === 0) return null; if (pick === 1) return Math.floor(Math.random() * 5); if (pick === 2) return ['a', 'b', ''][Math.floor(Math.random() * 3)]; if (pick === 3) return Math.random() > 0.5;
    if (pick === 4) return Array.from({ length: Math.floor(Math.random() * 4) }, () => random(depth + 1));
    return Object.fromEntries(Array.from({ length: Math.floor(Math.random() * 4) }, (_, i) => [`k${Math.floor(Math.random() * 5)}${i % 2}`, random(depth + 1)]));
  };
  for (let round = 0; round < 500; round++) {
    const a = { id: 'x', body: random(0) } as unknown as Work, b = { id: 'x', body: random(0), extra: random(1) } as unknown as Work;
    assert.deepEqual(applyWorkDelta(a, { base: 1, revision: 1, updatedAt: '', lease: null, submission: null, ops: workDiff(a, b) }), b);
    assert.deepEqual(workDiff(a, structuredClone(a)), []);
    if (round % 10) continue;
    const base = (await store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4) RETURNING seq', [item.id, 'graphyard', 'fixture', JSON.stringify({ work: a })])).rows[0].seq;
    const delta = { base: Number(base), revision: 1, updatedAt: '', lease: null, submission: null, ops: workDiff(a, b) };
    const sql = (await store.pool.query('SELECT graphyard_event_work($1, $2::jsonb) AS work', [item.id, JSON.stringify({ delta })])).rows[0].work;
    assert.deepEqual(sql, b, `SQL applies ${JSON.stringify(delta.ops)}`);
  }
});

test('unit:delta-chain-bounded — a full snapshot recurs at least every snapshotEvery rows and whenever the delta would be large, so every row is one lookup from its document', async () => {
  const work: any = await seeded();
  await saveAs(work, 'create');
  for (let n = 0; n < snapshotEvery * 2 + 10; n++) { work.lease.expiresAt = new Date(Date.now() + n).toISOString(); await saveAs(work, n % 2 ? 'heartbeat' : 'action.claimed'); }
  let rows = await raw(work.id);
  const position = new Map(rows.map((row, index) => [Number(row.seq), index]));
  const fulls = rows.map((row, index) => row.payload.work ? index : -1).filter(index => index >= 0);
  assert.ok(fulls.length >= 3, `full snapshots recur: at ${fulls.join(', ')}`);
  for (const [index, row] of rows.entries()) {
    if (!row.payload.delta) continue;
    const baseIndex = position.get(row.payload.delta.base)!;
    assert.ok(rows[baseIndex].payload.work, 'a delta is taken against a full snapshot, never another delta');
    assert.ok(index - baseIndex <= snapshotEvery, `row ${index} is within ${snapshotEvery} rows of its base (${baseIndex})`);
  }
  // A change larger than the delta budget writes the whole document.
  work.criteria[0].text = randomBytes(2000).toString('hex');
  await saveAs(work, 'requirements');
  rows = await raw(work.id);
  assert.ok(rows.at(-1)!.payload.work, 'a large change is a full snapshot');
  // A stage change and the first accepted-delivery observation stay whole (the pulse indexes that row).
  work.stage = 'review'; await saveAs(work, 'reconciled');
  work.delivery = { mergedAt: new Date().toISOString(), mergeSha: 'a'.repeat(40), authorizationRevision: 3 }; await saveAs(work, 'merge.operator-authorized');
  await saveAs(work, 'github.observed');
  await saveAs(work, 'github.observed');
  rows = await raw(work.id);
  assert.deepEqual(rows.slice(-4).map(row => !!row.payload.work), [true, true, true, false], 'stage change, delivery change and first delivery observation are full; a later observation is a delta');
  // A cited revision stored as a delta is still found by revision.
  const target = rows.find(row => row.payload.delta)!;
  const cited = (await store.pool.query('SELECT graphyard_work_at_revision($1,$2) AS work', [work.id, String(target.payload.delta.revision)])).rows[0].work;
  assert.equal(cited.revision, target.payload.delta.revision);
  assert.deepEqual(cited, (await resolved(work.id)).find(row => row.seq === target.seq)!.payload.work);
});

test('integration:delta-readers — events history, store.events, attestations, the intervention ledger and the timeline replay read deltas as the documents they stand for', async () => {
  const n = ++serial;
  let w = await engine.execute(operator, 'create', null, { title: `Readers ${n}`, plannedFiles: ['src/'], criteria: [1, 2, 3, 4].map(n => ({ id: `AC-${n}`, text: `Behaves ${randomBytes(900).toString('hex')}`, proofs: ['integration:x'] })) }, randomUUID());
  const records: Work[] = [plain(w)];
  const run = async (actor: Principal, command: Parameters<Engine["execute"]>[1], data: Record<string, unknown>) => { w = await engine.execute(actor, command, w.id, data, randomUUID()); records.push(plain(w)); };
  await run(operator, 'ready', {}); await run(worker, 'claim', {});
  await run(worker, 'workspace', { epoch: 1, host: 'test', path: `/tmp/readers-${n}`, branch: `graphyard/readers-${n}` });
  for (let beat = 0; beat < 3; beat++) await run(worker, 'heartbeat', { epoch: 1 });
  await run(worker, 'blocked', { epoch: 1, reason: 'Waiting on a credential' });
  await run(worker, 'heartbeat', { epoch: 1 });
  const rows = await raw(w.id);
  const deltaKinds = new Set(rows.filter(row => row.payload.delta).map(row => row.kind));
  assert.ok(deltaKinds.has('blocked') && deltaKinds.has('heartbeat') && deltaKinds.has('workspace'), `non-routine kinds are deltas too: ${[...deltaKinds].join(', ')}`);
  const byRevision = new Map(records.map(record => [record.revision, record]));
  // store.events and the events API: every row carries its whole document.
  for (const event of await store.events(w.id)) assert.deepEqual(event.payload.work, byRevision.get(event.payload.work.revision), `${event.kind} reads whole through store.events`);
  const history = await readEventHistory(store.pool, parseEventHistoryQuery(new URLSearchParams({ work: w.id, routine: 'include', order: 'asc' })));
  assert.equal(history.events.length, rows.length);
  for (const event of history.events) { assert.deepEqual(event.payload.work, byRevision.get(event.payload.work.revision)); assert.equal(event.payload.delta, undefined); }
  // Attestations read the epoch the blocked row's document held.
  const attestations = await readAttestations(store.pool, w.id);
  assert.equal(attestations.length, 1); assert.equal(attestations[0].epoch, 1);
  // The intervention ledger reads the stage and blocker from the delta row.
  const ledger = (await readInterventionLedger(store.pool, { workId: w.id })).rows;
  const blocked = ledger.find(row => row.kind === 'blocked')!;
  assert.equal(blocked.work?.blocker, 'Waiting on a credential'); assert.equal(blocked.work?.stage, records.at(-1)!.stage); assert.equal(blocked.stageBefore, records.at(-1)!.stage);
  assert.equal(blocked.at, byRevision.get(Number(rows.find(row => row.kind === 'blocked')!.payload.delta.revision))!.updatedAt);
  // The projected replay and a replay of whole documents agree.
  const projected = (await store.pool.query(`SELECT ${ledgerReplayColumns} FROM events WHERE work_id=$1 ORDER BY seq`, [w.id])).rows.map(ledgerEntry);
  const whole = (await store.pool.query(`SELECT seq, kind, created_at, ${resolvedPayloadSql()} AS payload FROM events WHERE work_id=$1 ORDER BY seq`, [w.id])).rows;
  assert.deepEqual(reconstructTimeline(projected), reconstructTimeline(whole));
  // Append-only holds for delta rows.
  await assert.rejects(store.pool.query("UPDATE events SET payload='{}'::jsonb WHERE work_id=$1 AND payload ? 'delta'", [w.id]), /append-only/);
  await assert.rejects(store.pool.query("DELETE FROM events WHERE work_id=$1 AND payload ? 'delta'", [w.id]), /append-only/);
});

test('integration:event-stats-by-kind — the last hour of the ledger reads as rows, stored bytes and delta rows by kind, from the created_at index', async () => {
  const stats = await eventStats(store.pool);
  const expected = (await store.pool.query("SELECT kind, count(*)::int AS count, sum(pg_column_size(payload))::bigint AS bytes, count(*) FILTER (WHERE payload ? 'delta')::int AS deltas FROM events GROUP BY kind")).rows;
  assert.equal(stats.windowMinutes, 60);
  assert.equal(stats.kinds.length, expected.length);
  for (const row of expected) assert.deepEqual(stats.kinds.find(entry => entry.kind === row.kind), { kind: row.kind, count: row.count, bytes: Number(row.bytes), deltas: row.deltas });
  assert.equal(stats.count, expected.reduce((sum, row) => sum + row.count, 0));
  assert.ok(stats.kinds.find(entry => entry.kind === 'heartbeat')!.deltas > 0);
  const db = await store.pool.connect();
  try {
    await db.query('BEGIN'); await db.query('SET LOCAL enable_seqscan=off');
    const plan = (await db.query("EXPLAIN SELECT kind, count(*) FROM events WHERE created_at > now() - make_interval(mins => 60) GROUP BY kind")).rows.map(row => row['QUERY PLAN']).join('\n');
    assert.match(plan, /events_created/);
  } finally { await db.query('ROLLBACK'); db.release(); }
});
