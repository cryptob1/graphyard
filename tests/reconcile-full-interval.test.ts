import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1867: the reconciliation's full re-evaluation never runs back to back. The next full pass is
// due no sooner than max(the configured interval, 3× the last full pass's duration), and since
// GY-1898 a fleet face any writer moved no longer brings one on at all: the moved item and the
// items that read it are evaluated on the next tick, and the interval keeps its own schedule. The
// batched evaluation yields to the event loop between items, so timers scheduled while it runs fire
// between them and the evaluation still writes what it wrote.

const operator: Principal = { id: 'operator', role: 'admin' };

let database: EmbeddedPostgres, store: Store, engine: Engine;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1867;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('reconcile-full-interval'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise();
  await database.start();
  await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`);
  await store.init();
  engine = new Engine(store, 120, 'owner/project');
  engine.principals = [operator];
  // Only a reset or the clock makes a pass full here; each test says when it wants the clock to.
  engine.reconcileFullEvaluationMs = 300_000;
});

after(async () => {
  await store?.close();
  await database?.stop();
});

let created = 0;
const create = (extra: Record<string, unknown> = {}) => engine.execute(operator, 'create', null, { title: `Full interval ${++created}`, plannedFiles: [`src/full-interval-${created}.ts`], criteria: [{ id: 'AC-1', text: 'Holds', proofs: ['unit:reconcile-full-interval'] }], ...extra }, randomUUID());
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Quiet passes until one reads nothing, evaluated nothing and is not full, so the next pass starts from a settled view. */
async function settle() {
  for (let n = 0; n < 8; n++) {
    await engine.reconcile();
    if (!engine.lastReconcile.documentsRead && !engine.lastReconcile.evaluated && !engine.lastReconcile.full) return;
  }
  assert.fail(`the view never settled: ${JSON.stringify(engine.lastReconcile)}`);
}
/**
 * Hook the lock-free dry runs: record the items each pass evaluates, busy-hold the event loop for
 * `holdMs` on the first one (the pass then measures that long), and run `arm` there once. With
 * `instant`, the hook replaces the evaluation altogether: every item costs nothing but the yield
 * between items, the regime where a yield that never reaches the loop's timers phase holds it.
 */
function evaluations({ holdMs = 0, arm, instant = false }: { holdMs?: number; arm?: () => void; instant?: boolean } = {}) {
  const internals = engine as unknown as { reconcileItem: (db: unknown, work: Work, all: Work[], now: Date, options?: { dryRun?: boolean }) => Promise<boolean> };
  const original = internals.reconcileItem, evaluated: string[] = [], marks: string[] = [];
  let armed = true;
  internals.reconcileItem = instant
    ? async function (this: Engine, _db, work, _all, _now, options) {
      if (options?.dryRun) { evaluated.push(work.id); marks.push(work.id); if (armed) { armed = false; arm?.(); } }
      return false;
    }
    : async function (this: Engine, db, work, all, now, options) {
      if (options?.dryRun) {
        evaluated.push(work.id); marks.push(work.id);
        if (armed) { armed = false; arm?.(); if (holdMs) { const until = performance.now() + holdMs; while (performance.now() < until) { /* hold the loop */ } } }
      }
      return original.call(this, db, work, all, now, options);
    };
  return { evaluated, marks, restore: () => { internals.reconcileItem = original; } };
}

test('unit:full-evaluation-interval-stretches — the next full pass is due no sooner than max(the interval, 3× the last full pass), and a moved face is decided without one', { timeout: 120_000 }, async () => {
  const parent = await create();
  const fed = await create({ dependencies: [parent.id] });
  await engine.execute(operator, 'ready', parent.id, {}, randomUUID());
  await settle();

  // A full pass the reset brings, slowed to well past a third of the configured interval.
  const interval = 1_000;
  engine.reconcileFullEvaluationMs = interval;
  const slow = evaluations({ holdMs: 800 });
  engine.resetReconcileView();
  const started = performance.now();
  try { await engine.reconcile(); } finally { slow.restore(); }
  const first = engine.reconcileTicks.at(-1)!;
  assert.ok(first.full?.cause === 'view' && first.candidates >= 2, `the reset pass is full: ${JSON.stringify(first.full)}`);
  const stretch = 3 * first.ms;
  assert.ok(stretch > interval, `the slowed pass outlasts a third of the interval (D=${first.ms} ms)`);

  // Straight after it: not full — the pass that just ended does not bring the next one.
  await engine.reconcile();
  assert.equal(engine.lastReconcile.full, false, 'the tick after a full pass is not full');

  // Past the configured interval, inside the stretch: still not full. This is the stretch biting —
  // on the interval alone the clock would bring the whole fleet back here.
  await sleep(started + (interval + stretch) / 2 - performance.now());
  await engine.reconcile();
  assert.equal(engine.lastReconcile.full, false, `not due before max(I, 3D) = ${stretch} ms (D=${first.ms} ms)`);

  // Past the stretch, the clock brings the catch-up again.
  await sleep(started + stretch + 500 - performance.now());
  await engine.reconcile();
  assert.ok(engine.lastReconcile.full, 'the full pass is due once the stretch has passed');
  assert.equal(engine.reconcileTicks.at(-1)!.full?.cause, 'interval');
  await settle();

  // A fleet face a writer outside the commands moved is decided on the next tick without a full
  // pass (GY-1898): the moved item and the items its face feeds are evaluated, and the interval
  // keeps its own schedule.
  engine.reconcileFullEvaluationMs = 300_000;
  const recorder = evaluations();
  try {
    await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{title}', to_jsonb($2::text)) WHERE id = $1`, [parent.id, 'Full interval 1, moved']);
    await engine.reconcile();
    assert.ok(!engine.reconcileTicks.at(-1)!.full, 'the moved face does not make the next tick full');
    assert.deepEqual(engine.reconcileTicks.at(-1)!.faces.map(move => move.key), [parent.key], 'the tick names the moved face');
    const saw = new Set(recorder.evaluated);
    assert.ok(saw.has(parent.id), 'the moved item is evaluated on the next tick');
    assert.ok(saw.has(fed.id), 'the item the moved face feeds is evaluated on the next tick');
  } finally { recorder.restore(); }
});

test('unit:face-move-pass-keeps-the-interval — a pass a moved face drove is not full, so it neither restarts the full-evaluation clock nor stretches it, and no stream of face moves can hold the safety net off', { timeout: 120_000 }, async () => {
  const parent = await create();
  const fed = await create({ dependencies: [parent.id] });
  await settle();

  // A quick full pass the reset brings; the interval is set past three of its lengths, so its deadline is I from when it began.
  engine.reconcileFullEvaluationMs = 300_000;
  engine.resetReconcileView();
  const viewStarted = performance.now();
  await engine.reconcile();
  assert.equal(engine.reconcileTicks.at(-1)!.full?.cause, 'view');
  const interval = Math.max(1_000, 3 * engine.reconcileTicks.at(-1)!.ms + 200);
  engine.reconcileFullEvaluationMs = interval;
  await settle();

  // A face moved outside the commands late in that interval makes the next pass evaluate the moved
  // item and the one its face feeds — slowed here to end past the deadline. It is not full (GY-1898),
  // so the clock keeps the deadline the earlier full pass set and records none of this pass's length.
  await sleep(viewStarted + 0.6 * interval - performance.now());
  await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{title}', to_jsonb($2::text)) WHERE id = $1`, [parent.id, `Face moved ${randomUUID()}`]);
  const slow = evaluations({ holdMs: 0.8 * interval });
  try { await engine.reconcile(); } finally { slow.restore(); }
  const face = engine.reconcileTicks.at(-1)!;
  assert.ok(!face.full, `the moved face does not make the pass full: ${JSON.stringify(face.full)}`);
  assert.deepEqual(face.faces.map(move => move.key), [parent.key]);
  assert.ok(performance.now() > viewStarted + interval, 'the face pass ended past the deadline the earlier full pass set');

  // Straight after it the safety net runs on the schedule the full pass set: a face move moved no deadline.
  await engine.reconcile();
  assert.equal(engine.reconcileTicks.at(-1)!.full?.cause, 'interval', JSON.stringify(engine.reconcileTicks.at(-1)!.full));
  engine.reconcileFullEvaluationMs = 300_000;
  await settle();
});

test('unit:reconcile-yields-between-items — timers scheduled during a batched evaluation fire between items, and the evaluation writes what it wrote', { timeout: 120_000 }, async () => {
  const items: Work[] = [];
  for (let n = 0; n < 40; n++) items.push(await create());
  await engine.execute(operator, 'ready', items[0].id, {}, randomUUID());
  await settle();

  // A derived action dropped outside the commands: the full pass owes the item its write-back, so
  // the yielding evaluation has a result to keep. The readied item is the one whose next action is
  // an action; a backlog item's derivation is only a wait, and rewriting null is no change.
  const broken = items[0];
  await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{nextAction}', 'null') WHERE id = $1`, [broken.id]);

  engine.reconcileFullEvaluationMs = 0;
  // The yielding evaluation, on the real dry runs: the kept view is warm — whole documents, the
  // steady state the server runs in — so every candidate's evaluation awaits no I/O. The pass
  // evaluates every live item once and writes back what the evaluation planned.
  const recorder = evaluations();
  try { await engine.reconcile(); } finally { recorder.restore(); }

  // The evaluation is unchanged: every live item was evaluated once, and the dropped action was written back.
  const live = engine.lastReconcile.live;
  assert.ok(recorder.evaluated.length >= live, `the full pass evaluated every live item (${recorder.evaluated.length} of ${live})`);
  assert.equal(new Set(recorder.evaluated).size, recorder.evaluated.length, 'no item was evaluated twice');
  const stored = (await store.list()).find(entry => entry.id === broken.id)!;
  assert.ok(stored.nextAction, 'the dropped derived action was written back');
  assert.ok(engine.reconcileTicks.at(-1)!.writes >= 1, 'the pass wrote the evaluation it planned');

  // Timers scheduled while the evaluation ran fired between items — both before the last item was
  // evaluated, not after the whole fleet.
  const instant = evaluations({
    instant: true,
    arm: () => { setTimeout(() => instant.marks.push('timer-1'), 1); setTimeout(() => instant.marks.push('timer-2'), 2); },
  });
  try { await engine.reconcile(); } finally { engine.reconcileFullEvaluationMs = 300_000; instant.restore(); }
  await sleep(10); // the probes due nearest the pass's end land before the marks are read
  const marks = instant.marks, lastItemAt = marks.lastIndexOf(instant.evaluated.at(-1)!);
  const first = marks.indexOf('timer-1'), second = marks.indexOf('timer-2');
  assert.ok(first > 0, `the 1 ms timer fired after the evaluation began (${marks.slice(0, 4).join(' | ')})`);
  assert.ok(first < lastItemAt, `the 1 ms timer fired before the last item was evaluated (${marks.join(' | ')})`);
  assert.ok(second > first && second < lastItemAt, `the 2 ms timer fired between the two, before the last item (${marks.join(' | ')})`);

  // And the yield the loop makes between items is one the loop's timers phase runs: a timer due
  // when the yield begins fires before the yield resolves, so timers scheduled while a batched
  // evaluation runs always find the loop between items — whatever each item's evaluation costs.
  let probeFired = false;
  setTimeout(() => { probeFired = true; }, 0);
  await (engine as unknown as { yieldToRenewals(): Promise<void> }).yieldToRenewals();
  assert.ok(probeFired, 'a timer due when the yield began fired before the yield resolved');
});
