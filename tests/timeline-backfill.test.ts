import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { buildMasterStatus } from '../src/master.js';
import { pipelineSpeed, pipelineSpeedSummary, type PipelineTimeline } from '../src/pipeline-speed.js';
import { backfillPipelineTimelines, catchUpPipelineTimelines, pipelineBackfillState, resetPipelineBackfillState } from '../src/pipeline-backfill.js';

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'worker-a', role: 'worker' };
const tokens = { operator: 'o'.repeat(32), worker: 'w'.repeat(32) };
const sha40 = (seed: string) => seed.repeat(40).slice(0, 40);

let database: EmbeddedPostgres; let store: Store; let engine: Engine;
let http: ReturnType<typeof server>; let url: string;
let pullRequest = 7100;

before(async () => {
  const port = Number(process.env.GRAPHYARD_BACKFILL_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 26);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-backfill-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_backfill');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_backfill`);
  await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  http = server(engine, [{ ...operator, token: tokens.operator }, { ...worker, token: tokens.worker }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
  if (database) await database.stop();
});

const reload = async (id: string): Promise<Work> => (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document;
/** A document written before the per-item timeline existed: history in the ledger, none on the item. */
const stripTimeline = (id: string) => store.pool.query("UPDATE work_items SET document=document-'pipeline' WHERE id=$1", [id]);
const deliver = (id: string, mergedAt: string) => store.pool.query('UPDATE work_items SET document=document||$2::jsonb WHERE id=$1',
  [id, JSON.stringify({ stage: 'done', delivery: { mergedAt, mergedAtRepository: mergedAt, mergeSha: sha40('9'), authorizationRevision: 1 } })]);

/** One reconciliation pass, recording the document as it then stood, as the control plane does. */
const observed = (id: string) => store.pool.query(
  "INSERT INTO events(work_id,actor,kind,payload) SELECT $1,'github','github.observed',jsonb_build_object('work',document,'details','{}'::jsonb) FROM work_items WHERE id=$1", [id]);

async function claimed(title: string) {
  let work = await engine.execute(operator, 'create', null, { title, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Measured', proofs: ['integration:timeline-backfill'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  return engine.execute(worker, 'claim', work.id, {}, randomUUID());
}
/** Two attempts, a hand-off and a rework round, exactly as the engine records them today. */
async function fullLifecycle(title: string) {
  let work = await claimed(title);
  const pr = ++pullRequest;
  work = await engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'machine-a', path: `/tmp/${work.id}-1`, branch: `graphyard/${work.key.toLowerCase()}-1` }, randomUUID());
  work = await engine.execute(worker, 'blocked', work.id, { epoch: work.epoch, reason: 'Waiting on a decision' }, randomUUID());
  work = await engine.execute(operator, 'unblock', work.id, { reason: 'Decided' }, randomUUID());
  work = await engine.execute(worker, 'submit', work.id, { epoch: work.epoch, pr }, randomUUID());
  work = await engine.execute(operator, 'rework', work.id, { reason: 'Reviewer finding', previousWorkerStopped: true }, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'machine-a', path: `/tmp/${work.id}-2`, branch: work.workspaces[0].branch }, randomUUID());
  return engine.execute(worker, 'submit', work.id, { epoch: work.epoch, pr }, randomUUID());
}

test('integration:timeline-backfill — items delivered before the timeline existed get one rebuilt from their own ledger, master status then reports execution versus wait, rework rounds and hand-offs for every delivered item, speed.unmeasured is zero for every item whose events are retained, and an item whose history was pruned is named rather than counted', async () => {
  // Four items: one whose whole life predates the timeline, one whose lease lapsed, one whose
  // ledger no longer reaches back to its creation, and one that keeps the timeline the engine wrote.
  const legacy = await fullLifecycle('Delivered before the timeline existed');
  const lapsedItem = await claimed('Lease lapsed under an old document');
  await engine.execute(worker, 'heartbeat', lapsedItem.id, { epoch: lapsedItem.epoch }, randomUUID());
  // A deadline just after the claim: the attempt ends there, not when reconciliation noticed.
  const deadline = new Date(Date.parse(lapsedItem.pipeline!.attempts[0].claimedAt) + 1).toISOString();
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{lease,expiresAt}',to_jsonb($2::text)) WHERE id=$1", [lapsedItem.id, deadline]);
  await observed(lapsedItem.id);
  await engine.reconcile();
  const live = await fullLifecycle('Timeline kept as the commands ran');

  const mergedAt = new Date(Date.now() + 60_000).toISOString();
  await deliver(legacy.id, mergedAt);
  await deliver(live.id, mergedAt);
  const written = { legacy: (await reload(legacy.id)).pipeline!, lapsed: (await reload(lapsedItem.id)).pipeline!, live: (await reload(live.id)).pipeline! };
  assert.equal(written.legacy.attempts.length, 2);
  assert.deepEqual(written.lapsed.attempts.map(attempt => [attempt.end, attempt.endedAt]), [['expired', deadline]]);

  // An item whose ledger starts mid-life: the document exists, its creation and lifecycle rows do not.
  const pruned: Work = { ...structuredClone(legacy), id: randomUUID(), key: 'GY-pruned', title: 'History no longer retained' };
  delete pruned.pipeline;
  await store.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [pruned.id, JSON.stringify(pruned)]);
  for (let pass = 0; pass < 3; pass++) await observed(pruned.id);
  await deliver(pruned.id, mergedAt);

  // The documents as they stood before the timeline shipped.
  for (const id of [legacy.id, lapsedItem.id]) await stripTimeline(id);
  const untouched = await reload(legacy.id);
  const before = pipelineSpeedSummary(await store.list(), Date.now() + 120_000);
  assert.equal(before.measured, 1, 'only the item whose timeline the engine wrote is measured');
  assert.equal(before.unmeasured, 2);
  assert.deepEqual(before.coverage.items.map(entry => [entry.key, entry.coverage]), [[legacy.key, 'awaiting-backfill'], ['GY-pruned', 'awaiting-backfill']]);
  assert.equal(before.coverage.complete, false);
  assert.match(before.coverage.statement, /awaiting the ledger reconstruction/);

  // The work-snapshot read every speed report is derived from runs the catch-up itself.
  resetPipelineBackfillState();
  const snapshot = await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: `Bearer ${tokens.operator}` } }).then(response => response.json());
  assert.ok(snapshot.work.length >= 4);
  const state = pipelineBackfillState();
  assert.equal(state.lastError, null);
  assert.equal(state.lastRun!.pending, false);
  assert.equal(state.backfilled, snapshot.work.length);
  const status = await fetch(`${url}/api/status`, { headers: { Authorization: `Bearer ${tokens.operator}` } }).then(response => response.json());
  assert.equal(status.pipelineBackfill.lastRun.backfilled, snapshot.work.length);
  assert.equal(status.pipelineBackfill.settled, true);

  // Every reconstructed timeline is the timeline the commands wrote, with the marker that says
  // which ledger rows it was rebuilt from.
  const restored = { legacy: await reload(legacy.id), lapsed: await reload(lapsedItem.id), live: await reload(live.id), pruned: await reload(pruned.id) };
  const withoutMarker = (timeline: PipelineTimeline) => { const { backfill: _backfill, ...rest } = timeline; return rest; };
  assert.deepEqual(withoutMarker(restored.legacy.pipeline!), written.legacy);
  assert.deepEqual(withoutMarker(restored.lapsed.pipeline!), written.lapsed, 'a lapsed lease ends at its own deadline, whatever noticed it');
  assert.deepEqual(withoutMarker(restored.live.pipeline!), written.live, 'a timeline the engine kept is never rewritten by the reconstruction');
  assert.equal(restored.legacy.pipeline!.backfill!.retained, true);
  assert.equal(restored.legacy.pipeline!.backfill!.source, 'ledger');
  assert.equal(restored.legacy.pipeline!.backfill!.truncated, false);
  assert.ok(Number(restored.legacy.pipeline!.backfill!.toEvent) > Number(restored.legacy.pipeline!.backfill!.fromEvent));
  assert.equal(restored.pruned.pipeline!.backfill!.retained, false, 'a ledger that does not reach the item\'s creation is a floor, not a measurement');
  assert.deepEqual(withoutMarker(restored.pruned.pipeline!), { attempts: [], submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } });

  // Nothing but the timeline moved, and the reconstruction is in the ledger like any other mutation.
  const scrub = (item: Work) => JSON.stringify({ ...item, pipeline: null, revision: 0, updatedAt: '' },
    (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  assert.equal(scrub(restored.legacy), scrub(untouched), 'the reconstruction changed the timeline and nothing else');
  assert.equal(restored.legacy.revision, untouched.revision + 1, 'and recorded itself as one write');
  const recorded = (await store.pool.query("SELECT payload->'details' AS details FROM events WHERE work_id=$1 AND kind='pipeline.backfilled'", [legacy.id])).rows;
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].details.attempts, 2);
  assert.equal(recorded[0].details.retained, true);

  // What the measurement now reports: every delivered item whose events are retained is measured,
  // with execution versus wait, rework rounds and hand-offs; the pruned one is named, not counted.
  const now = Date.now() + 120_000;
  const work = await store.list();
  const summary = pipelineSpeedSummary(work, now);
  assert.equal(summary.measured, 2, 'both deliveries whose events are retained are measured');
  assert.equal(summary.unmeasured, 1);
  assert.deepEqual(summary.coverage.items, [{ key: 'GY-pruned', mergedAt, coverage: 'events-pruned' }]);
  assert.equal(summary.coverage.awaitingBackfill, 0, 'no delivery is left waiting for the reconstruction');
  assert.equal(summary.coverage.eventsPruned, 1);
  assert.match(summary.coverage.statement, /whose events are no longer retained/);
  const measured = summary.items.find(entry => entry.key === legacy.key)!;
  assert.ok(measured.executionMs! > 0 && measured.waitMs! >= 0 && measured.submitToMergeMs > 0);
  assert.equal(measured.reworkRounds, 1);
  assert.deepEqual(measured.interventions, { blocked: 1, requirements: 0 });
  assert.equal(measured.routine, false, 'a hand-off and a rework round are reported, not smoothed away');
  for (const delivery of summary.items) assert.equal(delivery.executionMs! + delivery.waitMs! >= 0, true);

  // Master status carries exactly that, per delivered item and in the summary.
  const master = buildMasterStatus({ work, now: new Date(now).toISOString() }, [], [], {}, {}, { pending: [], completed: [] });
  assert.equal(master.speed.unmeasured, 1);
  assert.equal(master.speed.coverage.awaitingBackfill, 0);
  assert.deepEqual(master.speed.items.map(entry => entry.key).sort(), [legacy.key, live.key].sort());
  for (const key of [legacy.key, live.key]) {
    const row = master.speed.items.find(entry => entry.key === key)!;
    assert.ok(typeof row.executionMs === 'number' && typeof row.waitMs === 'number' && typeof row.reworkRounds === 'number' && row.interventions);
  }
  // The item still in flight reports its own execution and wait on its open row.
  const open = master.work.find(row => row.key === lapsedItem.key)!;
  assert.equal(open.speed.measured, true);
  assert.ok(open.speed.executionMs! > 0 && open.speed.waitMs! >= 0);
  assert.equal(pipelineSpeed(restored.pruned, now).coverage, 'events-pruned');

  // Converged: a second catch-up reads nothing and writes nothing, and a forced run finds no item.
  resetPipelineBackfillState();
  const again = await catchUpPipelineTimelines(store);
  assert.deepEqual([again!.scanned, again!.backfilled, again!.pending], [0, 0, false]);
  assert.equal(pipelineBackfillState().settled, true);
  assert.equal(await catchUpPipelineTimelines(store), null, 'a settled catch-up does not query again');
  const revisions = work.map(item => [item.key, item.revision]);
  const third = await backfillPipelineTimelines(store, { items: 25 });
  assert.equal(third.backfilled, 0);
  assert.deepEqual((await store.list()).map(item => [item.key, item.revision]), revisions, 'a converged ledger is never rewritten');

  // The batch is bounded: a run that fills its item bound says more is pending.
  await stripTimeline(legacy.id);
  await store.pool.query("UPDATE work_items SET document=document #- '{pipeline,backfill}' WHERE id=ANY($1::uuid[])", [[legacy.id, lapsedItem.id, live.id]]);
  const bounded = await backfillPipelineTimelines(store, { items: 1 });
  assert.deepEqual([bounded.scanned, bounded.backfilled, bounded.pending], [1, 1, true]);
  assert.equal(bounded.items[0].measured, true);
  const rest = await backfillPipelineTimelines(store, { items: 25 });
  assert.equal(rest.pending, false);
  assert.deepEqual(withoutMarker((await reload(legacy.id)).pipeline!), written.legacy, 'a second reconstruction of the same ledger is the same timeline');
});
