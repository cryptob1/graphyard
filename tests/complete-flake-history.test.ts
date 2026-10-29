import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2968: what complete's automatic rerun sets aside travels with the submission and lands on the
// item's history in the submission's own transaction — the flaked cases and the base failures,
// each named where the run located it, with the timing the runner gave.

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
let pg: EmbeddedPostgres, store: Store, engine: Engine;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 2968;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('complete-flake-history-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('complete_flake_history');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/complete_flake_history`); await store.init();
  engine = new Engine(store, 120, 'owner/project'); engine.submissionObserver = null; engine.directMergeEnvironment = null;
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });

const flaked = [{ case: 'unit:outside-proof — case A', file: 'tests/flaky.test.ts', line: 59, durationMs: 30000 }];
const baseFailures = [{ case: 'unit:outside-proof — case B', file: 'tests/broken-elsewhere.test.ts', line: 7, durationMs: null }];

async function assigned(title: string, n: number) {
  let w = await engine.execute(operator, 'create', null, { title, type: 'chore', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:outside-proof'] }] }, randomUUID());
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID());
  w = await engine.execute(worker, 'claim', w.id, {}, randomUUID());
  return await engine.execute(worker, 'workspace', w.id, { epoch: w.epoch, host: 'test', path: `/tmp/complete-flake-history-${n}`, branch: `graphyard/complete-flake-history-${n}` }, randomUUID());
}

test('unit:complete-flake-history — a submission carrying the rerun\'s flake and base-failure notes records both on the item\'s history', async () => {
  const w = await assigned('Flake history', 1);
  const submitted = await engine.execute(worker, 'submit', w.id, { epoch: w.epoch, pr: 2968, flaked, baseFailures }, randomUUID());
  assert.equal(submitted.submission!.pr, 2968);
  const rows = (await store.pool.query(`SELECT kind, payload FROM events WHERE work_id=$1 AND kind LIKE 'complete.%' ORDER BY seq`, [w.id])).rows;
  assert.deepEqual(rows.map(row => row.kind), ['complete.flaked', 'complete.base-failure']);
  const details = rows.map(row => (row.payload as { details: { epoch: number; head: string | null; cases: unknown; at: string } }).details);
  assert.deepEqual(details[0]!.cases, flaked);
  assert.deepEqual(details[1]!.cases, baseFailures);
  for (const detail of details) {
    assert.equal(detail.epoch, w.epoch);
    assert.equal(detail.head, null, 'the PR form names no head');
    assert.ok(Number.isFinite(Date.parse(detail.at)), 'the entry carries its instant');
  }
});

test('unit:complete-flake-history — a submission carrying the rerun-unjudged note records it on the item\'s history', async () => {
  const w = await assigned('Unjudged note', 3);
  const note = { note: 'pre-submit rerun could not judge: the rerun of tests/gone.test.ts failed without naming a failing case', output: "Could not find 'tests/gone.test.ts'." };
  await engine.execute(worker, 'submit', w.id, { epoch: w.epoch, pr: 2980, rerunUnjudged: note }, randomUUID());
  const rows = (await store.pool.query(`SELECT payload FROM events WHERE work_id=$1 AND kind='complete.rerun-unjudged'`, [w.id])).rows;
  assert.equal(rows.length, 1);
  const details = (rows[0]!.payload as { details: { epoch: number; head: string | null; note: string; output: string; at: string } }).details;
  assert.equal(details.epoch, w.epoch);
  assert.equal(details.head, null, 'the PR form names no head');
  assert.equal(details.note, note.note);
  assert.equal(details.output, note.output);
  assert.ok(Number.isFinite(Date.parse(details.at)), 'the entry carries its instant');
});

test('unit:complete-flake-history — a submission with no rerun notes records nothing, and an unknown submit field is refused', async () => {
  const w = await assigned('No notes', 2);
  await assert.rejects(engine.execute(worker, 'submit', w.id, { epoch: w.epoch, pr: 2969, stale: true } as never, randomUUID()), /Unrecognized key|Invalid input/);
  const submitted = await engine.execute(worker, 'submit', w.id, { epoch: w.epoch, pr: 2969 }, randomUUID());
  assert.equal(submitted.submission!.pr, 2969);
  const rows = (await store.pool.query(`SELECT kind FROM events WHERE work_id=$1 AND kind LIKE 'complete.%'`, [w.id])).rows;
  assert.deepEqual(rows, []);
});
