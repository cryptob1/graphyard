import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store, applySnapshotDelta, deltaEventKinds, withLatestDelta, type SnapshotDelta } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { ledgerEntry, ledgerReplayColumns, reconstructTimeline } from '../src/pipeline-speed.js';
import type { Observation, Principal, Work } from '../src/model.js';

/**
 * The event ledger grew by a full work document for every reconciliation pass and every lease
 * renewal. A routine row that changes only a clock is now a delta on the item's last full
 * snapshot; every other kind keeps its full snapshot, and every reader reconstructs the record.
 */
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const base = 'b'.repeat(40);
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
let pg: EmbeddedPostgres, store: Store, engine: Engine;
let serial = 0;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 160;
  pg = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-event-snapshot-delta-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('event_snapshot_delta_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/event_snapshot_delta_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.submissionObserver = null;
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });

const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const rows = async (id: string) => (await store.pool.query('SELECT seq, kind, payload, created_at, pg_column_size(payload) AS bytes FROM events WHERE work_id=$1 ORDER BY seq', [id])).rows as { seq: string; kind: string; payload: any; created_at: Date; bytes: number }[];
const observation = (work: Work, extra: Partial<Observation> = {}): Observation => ({ clockOffset: { min: 0, max: 5 }, candidate: { sha: sha(work.key), baseSha: base, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' },
  checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, baseTip: base, baseTree: '7e'.repeat(20),
  files: ['src/a.ts'], scopeFiles: [], at: new Date().toISOString(), ...extra });

async function submitted() {
  const n = ++serial;
  let w = await engine.execute(operator, 'create', null, { title: `Delta ${n}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:x'] }] }, randomUUID());
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID()); w = await engine.execute(worker, 'claim', w.id, {}, randomUUID());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/delta-${n}`, branch: `graphyard/delta-${n}` }, randomUUID());
  return w;
}

test('unit:routine-observation-delta — a re-observation that changes only its clock appends a small delta on the last full snapshot, and the delta reconstructs the record exactly', async () => {
  let w = await submitted();
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: 700 + serial }, randomUUID());
  w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.observe(w.id, w.revision, observation(w));
  const steady = await reload(w.id);
  const records: Work[] = [steady];
  for (let pass = 0; pass < 3; pass++) {
    w = await engine.observe(w.id, w.revision, observation(w, { clockOffset: { min: pass, max: pass + 4 } }));
    records.push(await reload(w.id));
  }
  const ledger = await rows(w.id);
  const observed = ledger.filter(row => row.kind === 'github.observed');
  const deltas = observed.filter(row => row.payload.delta);
  assert.ok(deltas.length >= 3, `the clock-only passes were stored as deltas: ${observed.map(row => Object.keys(row.payload).join('+')).join(', ')}`);
  for (const row of deltas) {
    assert.equal(row.payload.work, undefined, 'a delta row embeds no work snapshot');
    const baseRow = ledger.find(entry => Number(entry.seq) === row.payload.delta.base)!;
    assert.ok(baseRow?.payload.work, 'the delta names a full snapshot of the same item');
    assert.ok(row.bytes * 4 < baseRow.bytes, `the delta (${row.bytes} B) is a fraction of the snapshot it extends (${baseRow.bytes} B)`);
  }
  // Reconstruction: the base with the delta applied is the document the save wrote.
  const last = deltas.at(-1)!;
  const rebuilt = applySnapshotDelta(ledger.find(entry => Number(entry.seq) === last.payload.delta.base)!.payload.work, last.payload.delta as SnapshotDelta);
  assert.deepEqual(JSON.parse(JSON.stringify(rebuilt)), JSON.parse(JSON.stringify(records.at(-1))));
  // A pass that changes anything else — a new check result — writes the whole document again.
  w = await engine.observe(w.id, w.revision, observation(w, { checks: [{ name: 'test', result: 'failure', appId: 15368 }] }));
  const after = (await rows(w.id)).filter(row => row.kind === 'github.observed').at(-1)!;
  assert.ok(after.payload.work, 'a substantive observation keeps its full snapshot');
  assert.equal(after.payload.work.observation.checks[0].result, 'failure');
});

test('unit:routine-heartbeat-delta — a lease renewal is a delta carrying the renewed lease, and the timeline replay reads the renewed deadline from it', async () => {
  let w = await submitted();
  for (let beat = 0; beat < 3; beat++) w = await engine.execute(worker, 'heartbeat', w.id, { epoch: 1 }, randomUUID());
  const ledger = await rows(w.id);
  const beats = ledger.filter(row => row.kind === 'heartbeat');
  assert.equal(beats.length, 3);
  assert.ok(beats.slice(1).every(row => row.payload.delta && !row.payload.work), `renewals after the first are deltas: ${beats.map(row => Object.keys(row.payload).join('+')).join(', ')}`);
  const latest = await reload(w.id);
  assert.equal(beats.at(-1)!.payload.delta.lease.expiresAt, latest.lease!.expiresAt);
  assert.deepEqual(beats.at(-1)!.payload.details, { epoch: 1 }, 'the command details stay on the row');
  // The projected replay row carries the lease and updatedAt of the delta, exactly as a full row would.
  const projected = (await store.pool.query(`SELECT ${ledgerReplayColumns} FROM events WHERE work_id=$1 ORDER BY seq`, [w.id])).rows.map(ledgerEntry);
  const renewed = projected.find(entry => Number(entry.seq) === Number(beats.at(-1)!.seq))!;
  assert.equal(renewed.payload.work.lease.expiresAt, latest.lease!.expiresAt);
  assert.equal(renewed.payload.work.updatedAt, latest.updatedAt);
  // Replaying the rows whole or projected gives the same timeline.
  assert.deepEqual(reconstructTimeline(projected), reconstructTimeline(ledger.map(row => ({ seq: row.seq, kind: row.kind, payload: row.payload, created_at: row.created_at }))));
});

test('unit:protected-kinds-keep-snapshots — only routine kinds are ever stored as deltas; every lifecycle, decision and lease row keeps the whole document, and the ledger stays append-only', async () => {
  let w = await submitted();
  w = await engine.execute(worker, 'heartbeat', w.id, { epoch: 1 }, randomUUID());
  w = await engine.execute(worker, 'heartbeat', w.id, { epoch: 1 }, randomUUID());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: 800 + serial }, randomUUID());
  w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.observe(w.id, w.revision, observation(w));
  const all = (await store.pool.query("SELECT kind, payload ? 'work' AS full, payload ? 'delta' AS delta FROM events WHERE work_id IS NOT NULL")).rows as { kind: string; full: boolean; delta: boolean }[];
  assert.ok(all.some(row => row.delta), 'the ledger holds delta rows');
  for (const row of all.filter(entry => entry.delta)) assert.ok(deltaEventKinds.includes(row.kind), `${row.kind} is never stored as a delta`);
  for (const kind of ['create', 'ready', 'claim', 'workspace', 'submit']) {
    const kept = all.filter(row => row.kind === kind);
    assert.ok(kept.length && kept.every(row => row.full && !row.delta), `${kind} rows keep their full snapshot`);
  }
  await assert.rejects(store.pool.query("UPDATE events SET payload='{}'::jsonb WHERE work_id=$1", [w.id]), /append-only/);
  await assert.rejects(store.pool.query("DELETE FROM events WHERE work_id=$1 AND payload ? 'delta'", [w.id]), /append-only/);
});

test('unit:historical-record-carries-delta-clock — the record before a cutoff is the last full snapshot with the freshest delta clock before the cutoff, at the full snapshot\'s revision', async () => {
  let w = await submitted();
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: 900 + serial }, randomUUID());
  w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.observe(w.id, w.revision, observation(w));
  const cutoff = new Date(Date.now() + 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  w = await engine.observe(w.id, w.revision, observation(w));
  const ledger = await rows(w.id);
  const deltas = ledger.filter(row => row.payload.delta && row.created_at < cutoff);
  assert.ok(deltas.length >= 1);
  const fullRow = ledger.filter(row => row.payload.work && row.created_at < cutoff).at(-1)!;
  const client = await store.pool.connect();
  try {
    const past = (await withLatestDelta(client, w.id, { seq: fullRow.seq, work: fullRow.payload.work }, cutoff))!;
    assert.equal(past.observation!.at, deltas.at(-1)!.payload.delta.observation.at, 'the observation clock is the freshest before the cutoff, not one after it');
    assert.equal(past.revision, fullRow.payload.work.revision, 'the revision is the full snapshot the ledger holds whole');
    assert.ok(Date.parse(past.observation!.at) > Date.parse(fullRow.payload.work.observation.at));
  } finally { client.release(); }
});
