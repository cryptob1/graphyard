import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1777: a slow reconciliation tick says why it evaluated every live item (the keys whose fleet
// face moved and the face fields that moved, or the full-evaluation interval) and the event-loop lag
// it ran under; and a face the tick's own planned writes moved does not make the next pass full,
// while a face a request outside the tick moved still does.

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'worker-1', role: 'worker' };

let database: EmbeddedPostgres, store: Store, engine: Engine;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1777;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('reconcile-tick-cause'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise();
  await database.start();
  await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`);
  await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [operator, worker];
  // Only the clock-driven catch-up is full here; the tests say when they want one.
  engine.reconcileFullEvaluationMs = 300_000;
});

after(async () => {
  await store?.close();
  await database?.stop();
});

let created = 0;
const create = (extra: Record<string, unknown> = {}) => engine.execute(operator, 'create', null, { title: `Cause ${++created}`, plannedFiles: [`src/cause-${created}.ts`], criteria: [{ id: 'AC-1', text: 'Holds', proofs: ['unit:reconcile-tick-cause'] }], ...extra }, randomUUID());
/**
 * Run passes until one is quiet (reads nothing, is not full, writes nothing and evaluates less than
 * the fleet: an item with a standing escalation stays due every pass), so the next pass starts from
 * a settled view.
 */
async function settle() {
  const recorder = recordEvaluations();
  try {
    for (let n = 0; n < 8; n++) {
      recorder.evaluated.length = 0; await engine.reconcile();
      const { documentsRead, full, evaluated, live } = engine.lastReconcile;
      if (!documentsRead && !full && evaluated < live && !engine.reconcileTicks.at(-1)!.writes) return;
    }
    const stuck = (await store.list()).filter(work => recorder.evaluated.includes(work.id)).map(work => `${work.key} ${work.stage} lease ${work.lease?.epoch ?? 'none'} escalations ${JSON.stringify(work.escalations ?? [])} next ${work.nextAction?.kind ?? 'none'}`);
    assert.fail(`the view never settled: ${JSON.stringify(engine.lastReconcile)}; still evaluating ${stuck.join(' | ')}`);
  } finally { recorder.restore(); }
}
/** One pass with the slow-tick bound at zero, returning its warning line and the recorded tick. */
async function slowPass() {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (line: unknown) => warnings.push(String(line));
  engine.reconcileSlowWarnMs = 0;
  try { await engine.reconcile(); } finally { console.warn = warn; engine.reconcileSlowWarnMs = 5_000; }
  const line = warnings.find(entry => /^reconciliation tick took \d+ ms for \d+ item/.test(entry));
  assert.ok(line, `no slow-tick warning was logged (${warnings.join(' | ') || 'nothing at all'})`);
  return { line: line!, tick: engine.reconcileTicks.at(-1)!, ...engine.lastReconcile };
}
/** Record the items the passes evaluate (their lock-free dry runs) until `restore` is called. */
function recordEvaluations() {
  const internals = engine as unknown as { reconcileItem: (db: unknown, work: Work, all: Work[], now: Date, options?: { dryRun?: boolean }) => Promise<boolean> };
  const original = internals.reconcileItem, evaluated: string[] = [];
  let block = 0, during: (() => Promise<void>) | null = null;
  internals.reconcileItem = async function (this: Engine, db, work, all, now, options) {
    if (options?.dryRun) {
      evaluated.push(work.id);
      // Hold the event loop for `block` ms once, on the first evaluation: the lag the tick samples.
      if (block) { const until = performance.now() + block; block = 0; while (performance.now() < until) { /* starve the loop */ } }
      // Run `during` once, on the first evaluation: a writer outside the tick moving a face mid-pass.
      if (during) { const run = during; during = null; await run(); }
    }
    return original.call(this, db, work, all, now, options);
  };
  return { evaluated, blockOnce: (ms: number) => { block = ms; }, duringOnce: (run: () => Promise<void>) => { during = run; }, restore: () => { internals.reconcileItem = original; } };
}

test('unit:slow-tick-names-cause — a tick past the bound names the keys and face fields that made it full, or the interval, and the event-loop lag it ran under', { timeout: 120_000 }, async () => {
  const items: Work[] = [];
  for (let n = 0; n < 8; n++) items.push(await create());
  engine.resetReconcileView();
  const first = await slowPass();
  assert.ok(first.full && first.tick.full?.cause === 'view', 'the first pass is full because the view was empty');
  assert.match(first.line, /every live item evaluated because the kept view was empty/);
  await settle();

  // One request outside the tick moves one face: the warning names that item and the fields that moved.
  await engine.execute(operator, 'ready', items[0].id, {}, randomUUID());
  const one = await slowPass();
  assert.equal(one.evaluated, one.live, 'a face moved by a request makes the pass full');
  assert.equal(one.tick.full?.cause, 'faces');
  assert.deepEqual(one.tick.full?.moved.map(move => move.key), [items[0].key]);
  assert.ok(one.tick.full?.moved[0].fields.includes('ready'), `the moved fields include the one the request changed: ${one.tick.full?.moved[0].fields.join(', ')}`);
  assert.match(one.line, new RegExp(`every live item evaluated because the fleet face of ${items[0].key} \\([^)]*\\bready\\b[^)]*\\) moved`), one.line);
  // A tick shorter than the sampler's 10 ms resolution holds no sample; one that holds samples carries their p50 and max.
  assert.match(one.line, /; (event-loop lag p50 \d+ ms, max \d+ ms over the tick|no event-loop lag sample over the tick)\)/, one.line);
  assert.ok(one.tick.lagMs ? one.tick.lagMs.max >= one.tick.lagMs.p50 && one.line.includes(`p50 ${one.tick.lagMs.p50} ms, max ${one.tick.lagMs.max} ms`) : one.line.includes('no event-loop lag sample'), 'the warning carries the lag the tick recorded');
  await settle();

  // Seven faces moved: every key is named, each with the fields that changed on it.
  for (const item of items.slice(1, 8)) await engine.execute(operator, 'ready', item.id, {}, randomUUID());
  const many = await slowPass();
  assert.equal(many.tick.full?.moved.length, 7);
  const named = items.slice(1, 8).map(item => `${item.key} \\([^)]*\\)`).join(', ');
  assert.match(many.line, new RegExp(`the fleet face of ${named} moved`), many.line);
  for (const item of items.slice(1, 8)) assert.match(many.line, new RegExp(`${item.key} \\([^)]*\\bready\\b[^)]*\\)`), many.line);
  assert.doesNotMatch(many.line, /and \d+ more/, many.line);
  await settle();

  // Nothing moved but the clock: the interval is named, and no key.
  engine.reconcileFullEvaluationMs = 2_000;
  await new Promise(resolve => setTimeout(resolve, 2_100));
  const interval = await slowPass();
  engine.reconcileFullEvaluationMs = 300_000;
  assert.ok(interval.full && interval.tick.full?.cause === 'interval' && interval.tick.full.moved.length === 0, JSON.stringify(interval.tick.full));
  assert.match(interval.line, /every live item evaluated because the full-evaluation interval elapsed; (event-loop lag p50 \d+ ms, max \d+ ms|no event-loop lag sample)/, interval.line);
  assert.doesNotMatch(interval.line, /fleet face of/, 'no face is named when none moved');
  await settle();

  // A pass that starves the loop reads the starvation as lag; one that waits on I/O reads none.
  const recorder = recordEvaluations();
  try {
    await engine.execute(operator, 'ready', items[0].id, {}, randomUUID());
    recorder.blockOnce(200);
    const starved = await slowPass();
    assert.ok(starved.tick.lagMs && starved.tick.lagMs.max >= 150, `a 200 ms hold of the loop shows as lag: ${JSON.stringify(starved.tick.lagMs)}`);
    assert.match(starved.line, new RegExp(`max ${starved.tick.lagMs!.max} ms over the tick`));
  } finally { recorder.restore(); }
  await settle();
  const quiet = await slowPass();
  assert.ok(!quiet.tick.full, 'a quiet pass is not full');
  assert.match(quiet.line, /0 candidate\(s\) whose inputs moved; (event-loop lag p50 \d+ ms, max \d+ ms over the tick|no event-loop lag sample over the tick)/, quiet.line);
  assert.ok(!quiet.tick.lagMs || quiet.tick.lagMs.max < 150, `a quiet pass reads no starvation: ${JSON.stringify(quiet.tick.lagMs)}`);
  await settle();

  // One item moved twice by writers outside the tick: once mid-pass, noted when a planned write's
  // commit reread it, and once more before the next pass opened, read then as a stand-in. The next
  // pass names it once, with the fields of both moves.
  const twice = items[7], retitle = (field: string, value: string) => store.pool.query(`UPDATE work_items SET document = jsonb_set(document, $2::text[], to_jsonb($3::text)) WHERE id = $1`, [twice.id, `{${field}}`, value]);
  const mover = recordEvaluations();
  try {
    // A writer outside the tick drops items[1]'s derived action: the pass is full and writes it back,
    // and that planned write's commit finds items[7] moved mid-pass.
    await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{nextAction}', 'null') WHERE id = $1`, [items[1].id]);
    mover.duringOnce(async () => { await retitle('title', 'Moved mid-pass'); });
    await engine.reconcile();
    assert.ok(engine.reconcileTicks.at(-1)!.writes >= 1, 'the pass wrote the item whose action was dropped');
  } finally { mover.restore(); }
  await retitle('description', 'Moved again before the next pass opened');
  const once = await slowPass();
  assert.equal(once.tick.full?.cause, 'faces', JSON.stringify(once.tick.full));
  const entries = once.tick.full!.moved.filter(move => move.id === twice.id);
  assert.equal(entries.length, 1, `the item moved twice is named once: ${JSON.stringify(once.tick.full!.moved)}`);
  assert.ok(entries[0].fields.includes('title') && entries[0].fields.includes('description'), `its fields are the union of both moves: ${entries[0].fields.join(', ')}`);
  assert.equal(once.line.split(`${twice.key} (`).length - 1, 1, once.line);
  assert.match(once.line, new RegExp(`${twice.key} \\([^)]*\\bdescription\\b[^)]*\\btitle\\b[^)]*\\)`), once.line);
});

test('unit:own-write-no-full-pass — a face the tick\'s own write moved makes the next pass evaluate only its readers; a face a request moved still makes it full', { timeout: 120_000 }, async () => {
  const leased = await create({ exclusiveResources: ['printer'] });
  const dependent = await create({ dependencies: [leased.id] });
  // Readers the engine defines without a reference: one waits on the exclusive resource the leased
  // item holds (`resourceConflicts`), one plans a file in its scope (`fileConflicts`, `landingRegressions`).
  const sharer = await create({ exclusiveResources: ['printer'] });
  const neighbour = await create({ plannedFiles: [...leased.plannedFiles] });
  const others: Work[] = [];
  for (let n = 0; n < 3; n++) others.push(await create());
  await engine.execute(operator, 'ready', leased.id, {}, randomUUID());
  const work = await engine.execute(worker, 'claim', leased.id, {}, randomUUID());
  await settle();

  // The lease lapses by the clock alone: the row moved (its expiry), the face did not, so the pass
  // evaluates that one item; its own write (the lease gone, the loss escalated) then moves the face.
  await store.pool.query("UPDATE work_items SET document = jsonb_set(document, '{lease,expiresAt}', to_jsonb($2::text)) WHERE id = $1", [work.id, new Date(Date.now() - 60_000).toISOString()]);
  const recorder = recordEvaluations();
  try {
    await engine.reconcile();
    assert.deepEqual([...new Set(recorder.evaluated)], [leased.id], 'the pass evaluated the lapsed item alone');
    assert.ok(engine.reconcileTicks.at(-1)!.writes >= 1, 'the pass wrote the lapse');
    const stored = (await store.list()).find(entry => entry.id === work.id)!;
    assert.equal(stored.lease, null, 'the lapse was written');
    recorder.evaluated.length = 0;
    const next = await slowPass();
    assert.ok(!next.full && !next.tick.full, `the pass after an own write is not full: ${next.line}`);
    assert.ok(next.evaluated < next.live, `the pass evaluated ${next.evaluated} of ${next.live} live items`);
    const evaluated = new Set(recorder.evaluated);
    assert.ok(evaluated.has(dependent.id), 'the item that depends on the moved face is evaluated against it');
    assert.ok(evaluated.has(sharer.id), 'the item sharing the exclusive resource the lapsed lease held is evaluated against the release');
    assert.ok(evaluated.has(neighbour.id), 'the item whose planned files overlap the moved item\'s is evaluated against it');
    for (const other of others) assert.ok(!evaluated.has(other.id), `${other.key} reads nothing of the moved face and is not evaluated`);
    assert.match(next.line, /candidate\(s\) whose inputs moved/, 'the warning calls the pass incremental');
    recorder.evaluated.length = 0;
    await settle();

    // A request outside the tick moves a face: the next pass is full, as before.
    await engine.execute(operator, 'ready', others[0].id, {}, randomUUID());
    const full = await slowPass();
    assert.equal(full.evaluated, full.live, 'every live item is evaluated against the face a request moved');
    assert.deepEqual(full.tick.full?.moved.map(move => move.key), [others[0].key]);
    for (const other of others) assert.ok(new Set(recorder.evaluated).has(other.id));
  } finally { recorder.restore(); }
});
