import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1898: a fleet face any writer moved — a routine session record, an observation save, a command —
// makes the next reconciliation pass evaluate the moved item and the items whose evaluation reads it
// (`readsFace`: by reference, as a split sibling, through a shared exclusive resource or an
// overlapping path scope), not every live item. Only an empty kept view, a merge-configuration
// change or the full-evaluation interval makes a pass full, and over a scripted sequence of
// external face moves the decisions and writes equal those of evaluating every item each pass.

const operator: Principal = { id: 'operator', role: 'admin' };

let database: EmbeddedPostgres, store: Store, engine: Engine;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1898;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('reconcile-face-readers'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise();
  await database.start();
  await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`);
  await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [operator];
  // Only the clock-driven catch-up is full here; each test says when it wants one.
  engine.reconcileFullEvaluationMs = 300_000;
});

after(async () => {
  await store?.close();
  await database?.stop();
});

let created = 0;
const create = (extra: Record<string, unknown> = {}) => engine.execute(operator, 'create', null, { title: `Face readers ${++created}`, plannedFiles: [`src/face-readers-${created}.ts`], criteria: [{ id: 'AC-1', text: 'Holds', proofs: ['unit:face-move-evaluates-readers-only'] }], ...extra }, randomUUID());
/** A session-record write: the routine API write whose face moves the production report names. */
const sessionWrite = (id: string, n: number, state: 'running' | 'finished' = 'running') =>
  engine.execute(operator, 'session', id, { id: `face-readers-session-${n}`, kind: 'coordination', runtime: 'test-runtime', host: 'test-host', subject: 'GY-1898 face-move driver', state }, randomUUID());
/** Quiet passes until one reads nothing, evaluated nothing and is not full, so the next pass starts from a settled view. */
async function settle() {
  for (let n = 0; n < 8; n++) {
    await engine.reconcile();
    if (!engine.lastReconcile.documentsRead && !engine.lastReconcile.evaluated && !engine.lastReconcile.full) return;
  }
  assert.fail(`the view never settled: ${JSON.stringify(engine.lastReconcile)}`);
}
/** Record the items the passes evaluate (their lock-free dry runs) until `restore` is called. */
function recordEvaluations() {
  const internals = engine as unknown as { reconcileItem: (db: unknown, work: Work, all: Work[], now: Date, options?: { dryRun?: boolean }) => Promise<boolean> };
  const original = internals.reconcileItem, evaluated: string[] = [];
  internals.reconcileItem = async function (this: Engine, db, work, all, now, options) {
    if (options?.dryRun) evaluated.push(work.id);
    return original.call(this, db, work, all, now, options);
  };
  return { evaluated, restore: () => { internals.reconcileItem = original; } };
}

test('unit:face-move-evaluates-readers-only — with 30 live items an API write that moves one item\'s fleet face makes the next pass evaluate that item alone, and every item that reads its face with it', { timeout: 120_000 }, async () => {
  // Thirty independent live items; X is one of them and nothing reads it.
  const fleet: Work[] = [];
  for (let n = 0; n < 30; n++) fleet.push(await create());
  const x = fleet[7];
  await settle();

  const recorder = recordEvaluations();
  try {
    // A session record moves X's fleet face: the next pass evaluates X alone, not every live item.
    await sessionWrite(x.id, 1);
    await engine.reconcile();
    const alone = engine.reconcileTicks.at(-1)!;
    assert.ok(!alone.full, `a moved face no longer makes the pass full: ${JSON.stringify(alone.full)}`);
    assert.deepEqual(alone.faces.map(move => move.key), [x.key]);
    assert.ok(alone.faces[0].fields.includes('sessions'), `the moved fields name the sessions the write changed: ${alone.faces[0].fields.join(', ')}`);
    assert.equal(alone.readers, 1);
    assert.deepEqual([...new Set(recorder.evaluated)], [x.id], `the pass evaluated X alone: ${recorder.evaluated.join(', ')}`);
    recorder.evaluated.length = 0;
    await settle();

    // Readers of X's face, one per way an evaluation reads another item: by reference (a
    // dependency), as a split sibling (a shared parent), through a shared exclusive resource, and
    // through an overlapping path scope. Each is evaluated with X; every item that reads nothing
    // of X is not.
    const parent = await create();
    const byReference = await create({ dependencies: [x.id] });
    const sibling = await create();
    const sharer = await create({ exclusiveResources: ['res:face-readers'] });
    const overlayer = await create({ plannedFiles: [...x.plannedFiles] });
    await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{exclusiveResources}', to_jsonb($2::jsonb)) WHERE id = $1`, [x.id, JSON.stringify(['res:face-readers'])]);
    await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{parent}', to_jsonb($2::text)) WHERE id = $1`, [x.id, parent.id]);
    await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{parent}', to_jsonb($2::text)) WHERE id = $1`, [sibling.id, parent.id]);
    await settle();
    recorder.evaluated.length = 0;

    await sessionWrite(x.id, 2);
    await engine.reconcile();
    const withReaders = engine.reconcileTicks.at(-1)!;
    assert.ok(!withReaders.full, 'the moved face still makes no full pass');
    assert.deepEqual(withReaders.faces.map(move => move.key), [x.key]);
    assert.equal(withReaders.readers, 5, `the tick counts the moved item and its four readers: ${withReaders.readers}`);
    assert.deepEqual([...new Set(recorder.evaluated)], [x.id, byReference.id, sibling.id, sharer.id, overlayer.id],
      `the pass evaluated X and the items that read its face, and nothing else: ${recorder.evaluated.join(', ')}`);
    const readers = new Set(recorder.evaluated);
    for (const other of fleet) if (other.id !== x.id) assert.ok(!readers.has(other.id), `${other.key} reads nothing of X's face and is not evaluated`);
    assert.ok(!readers.has(parent.id), 'the shared parent itself is not evaluated for its child\'s face');
    recorder.evaluated.length = 0;
    await settle();

    // A deletion is a face move too (`gone`): the deleted sibling's reader — the item sharing its
    // parent — is evaluated against the move, and nothing else is. The ledger's append-only guard
    // guards the control plane's own writes; the test stands a row vanishing outside it.
    await store.pool.query('ALTER TABLE events DISABLE TRIGGER immutable_events');
    try { await store.pool.query('DELETE FROM events WHERE work_id = $1', [sibling.id]); }
    finally { await store.pool.query('ALTER TABLE events ENABLE TRIGGER immutable_events'); }
    await store.pool.query('DELETE FROM work_items WHERE id = $1', [sibling.id]);
    await engine.reconcile();
    const gone = engine.reconcileTicks.at(-1)!;
    assert.ok(!gone.full, 'a deletion no more makes the pass full');
    assert.deepEqual(gone.faces.map(move => move.key), [sibling.key]);
    assert.deepEqual(gone.faces[0].fields, ['gone']);
    assert.deepEqual([...new Set(recorder.evaluated)], [x.id], `the deleted sibling's reader alone is evaluated: ${recorder.evaluated.join(', ')}`);
    recorder.evaluated.length = 0;
    await settle();
  } finally { recorder.restore(); }
});

test('unit:face-move-readers-match-full-evaluation — the view, the configuration and the interval still make a pass full, and over a scripted sequence of external face moves the decisions and writes equal evaluating every item each pass', { timeout: 300_000 }, async () => {
  // An empty kept view still makes the pass full, and it still evaluates every live item.
  engine.resetReconcileView();
  await engine.reconcile();
  const view = engine.reconcileTicks.at(-1)!;
  assert.equal(view.full?.cause, 'view');
  assert.equal(view.evaluated, engine.lastReconcile.live, 'the view pass evaluated every live item');
  await settle();

  // A merge-configuration change still makes the pass full.
  const apps = engine.ciAppIds;
  engine.ciAppIds = [...apps, 4242];
  try {
    await engine.reconcile();
    assert.equal(engine.reconcileTicks.at(-1)!.full?.cause, 'configuration', JSON.stringify(engine.reconcileTicks.at(-1)!.full));
  } finally { engine.ciAppIds = apps; }
  await settle();

  // The interval safety net still evaluates every live item: the last full pass is backdated past
  // the interval rather than waited out.
  const clock = engine as unknown as { reconcileFullAt: number };
  clock.reconcileFullAt -= 3_600_000;
  await engine.reconcile();
  const interval = engine.reconcileTicks.at(-1)!;
  assert.equal(interval.full?.cause, 'interval');
  assert.equal(interval.evaluated, engine.lastReconcile.live, 'the interval pass evaluated every live item');
  await settle();

  // The scripted sequence: between passes an external writer moves faces — retitles, the release
  // and session writes the API serves, a re-dependency, an overlapping scope, a dropped resource,
  // a parent's retitle and a deletion. The readers run decides each on the moved item and the
  // items its face feeds, the full evaluation held open the whole time; the reference run
  // evaluates every live item each pass. The outcomes must come out equal.
  const item = async (title: string, extra: Record<string, unknown> = {}) => engine.execute(operator, 'create', null,
    { title, plannedFiles: [`src/${title}.ts`], criteria: [{ id: 'AC-1', text: 'Holds', proofs: ['unit:face-move-readers-match-full-evaluation'] }], ...extra }, randomUUID());
  const script = (x: Work, byReference: Work, sibling: Work, parent: Work, drafter: Work): [string, () => Promise<unknown>][] => [
    // A retitle: the moved item alone; nothing reads a description.
    ['retitle the face item', () => store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{description}', to_jsonb($2::text)) WHERE id = $1`, [x.id, 'moved by an external writer'])],
    // The release command: the stage and the derived dispatch move the face.
    ['release the face item', () => engine.execute(operator, 'ready', x.id, {}, randomUUID())],
    // A session record, then its end: the routine writes production named.
    ['record a session', () => sessionWrite(x.id, 3)],
    ['end the session', () => engine.execute(operator, 'session', x.id, { id: 'face-readers-session-3', kind: 'coordination', runtime: 'test-runtime', host: 'test-host', subject: 'scripted face moves', state: 'finished' }, randomUUID())],
    // The by-reference reader gains a dependency on the draft: its own face moves, and nothing reads it.
    ['re-depend the reader', () => store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{dependencies}', to_jsonb($2::jsonb)) WHERE id = $1`, [byReference.id, JSON.stringify([x.id, drafter.id])])],
    // The sibling takes the face item's planned file: its move reaches that item through the
    // overlapping scope and the shared parent.
    ['overlap the sibling', () => store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{plannedFiles}', to_jsonb($2::jsonb)) WHERE id = $1`, [sibling.id, JSON.stringify(x.plannedFiles)])],
    // The face item drops its exclusive resource: the sharer, a reader of the face as it stood
    // before the move, is reached through the before document.
    ['drop the resource', () => store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{exclusiveResources}', '[]'::jsonb) WHERE id = $1`, [x.id])],
    // The parent is retitled: its children are reached through the mention of its id in their faces.
    ['retitle the parent', () => store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{title}', to_jsonb($2::text)) WHERE id = $1`, [parent.id, 'Script parent moved'])],
    // The draft is deleted: the reader that depends on it is reached through the gone move. The
    // ledger's append-only guard guards the control plane's own writes; the test stands a row
    // vanishing outside it.
    ['delete the draft', async () => {
      await store.pool.query('ALTER TABLE events DISABLE TRIGGER immutable_events');
      try { await store.pool.query('DELETE FROM events WHERE work_id = $1', [drafter.id]); }
      finally { await store.pool.query('ALTER TABLE events ENABLE TRIGGER immutable_events'); }
      await store.pool.query('DELETE FROM work_items WHERE id = $1', [drafter.id]);
    }],
  ];
  const project = async () => {
    // Item keys come from the same sequence both runs restarted, so they match; content hashes and
    // instants do not (fresh item identities), and both are scrubbed.
    const scrub = (value: string) => value.replace(/\d{4}-\d{2}-\d{2}T[\d.:+-]+(Z|\d{2}:\d{2})?/g, '<t>').replace(/[0-9a-f]{32}/g, '<h>');
    return (await store.list()).map(work => scrub(JSON.stringify({
      key: work.key, stage: work.stage, ready: work.ready, epoch: work.epoch ?? null,
      lease: work.lease ? { owner: work.lease.owner, epoch: work.lease.epoch } : null,
      next: work.nextAction ? { kind: work.nextAction.kind, binding: work.nextAction.binding, inputs: work.nextAction.inputs } : null,
      escalations: (work.escalations ?? []).map(entry => entry.trigger).sort(),
      rows: (work.actionQueue?.actions ?? []).map(row => ({ kind: row.kind, state: row.state, claim: row.claim?.executor ?? null, attempts: row.attempts, retry: row.retryAt ? 'set' : null, history: (row.history ?? []).map(entry => entry.event) })),
      retired: (work.actionQueue?.history ?? []).map(row => ({ kind: row.kind, state: row.state })),
      violations: [...work.violations].sort(),
    }))).sort();
  };
  const runScript = async (mode: 'every-pass' | 'readers') => {
    await store.pool.query('TRUNCATE work_items, events, receipts, jobs, plane_liveness RESTART IDENTITY CASCADE');
    engine.resetReconcileView();
    const parent = await item('Script parent');
    const x = await item('Script face', { exclusiveResources: ['res:script'] });
    const byReference = await item('Script reader', { dependencies: [x.id] });
    const sibling = await item('Script sibling');
    const sharer = await item('Script sharer', { exclusiveResources: ['res:script'] });
    const overlayer = await item('Script overlayer', { plannedFiles: [...x.plannedFiles] });
    const drafter = await item('Script draft');
    await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{parent}', to_jsonb($2::text)) WHERE id = $1`, [x.id, parent.id]);
    await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{parent}', to_jsonb($2::text)) WHERE id = $1`, [sibling.id, parent.id]);
    const internals = engine as unknown as { fullEvaluationIntervalMs?: () => number };
    // The readers run isolates the mechanism: the full evaluation is held open for the whole
    // sequence, so the outcomes it reaches are the moved rows' and the face moves', never the
    // safety net's. The first pass still runs full (the view is empty).
    const held = mode === 'readers';
    if (held) internals.fullEvaluationIntervalMs = () => Number.MAX_SAFE_INTEGER;
    engine.reconcileFullEvaluationMs = mode === 'every-pass' ? 0 : 300_000;
    try {
      await engine.reconcile();
      const fulls = [engine.reconcileTicks.at(-1)!.full?.cause ?? ''];
      for (const [, move] of script(x, byReference, sibling, parent, drafter)) { await move(); await engine.reconcile(); fulls.push(engine.reconcileTicks.at(-1)!.full?.cause ?? ''); }
      // Settle at the end, so a write one run planned in a batch the other ran a pass later washes
      // out and the finals are comparable.
      for (let n = 0; n < 6; n++) { await engine.reconcile(); fulls.push(engine.reconcileTicks.at(-1)!.full?.cause ?? ''); }
      // The readers run holds the full evaluation open behind its first pass: the scripted face
      // moves decide incrementally, so the outcomes are the moved rows' and the readers' work,
      // never the safety net's. The reference run full-evaluates every pass.
      if (mode === 'readers') assert.ok(fulls.slice(1).every(cause => !cause), `only the first pass is full in the readers run: ${JSON.stringify(fulls)}`);
      else assert.ok(fulls.every(Boolean), `the reference run full-evaluates every pass: ${JSON.stringify(fulls.slice(0, 4))}`);
    } finally {
      if (held) delete internals.fullEvaluationIntervalMs;
      engine.reconcileFullEvaluationMs = 300_000;
    }
    return project();
  };
  const everyPass = await runScript('every-pass');
  const readers = await runScript('readers');
  assert.deepEqual(readers, everyPass, 'over the scripted sequence the decisions and writes equal evaluating every item each pass');
});
