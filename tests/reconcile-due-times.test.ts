import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine, configuredReconcileFullMs } from '../src/engine.js';
import { standingEscalations, type Principal, type Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1873: reconciliation wakes each item at the moment only the clock can change it. Every
// evaluation leaves the earliest instant at which its outcome could change with no write in the
// reconciliation view; each pass evaluates the items whose instant has passed beside the items
// whose inputs moved; the full evaluation's default interval is 300 s and it stays the safety net.
//
// The clock these tests simulate is the database's: every transaction hands its work `now`, and a
// shift slides over that hand-off, so a simulated hour costs seconds. Every instant here is
// derived from that clock by arithmetic — the file reads no wall clock and constructs no calendar
// date.

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'agent-a', role: 'worker', runtime: 'claude' };
const executor: Principal = { id: 'executor-a', role: 'coordinator' };

let database: EmbeddedPostgres, store: Store, engine: Engine;
/** The slide applied to every transaction's `now`: the simulated time the fleet is living at. */
let shiftMs = 0;
/** The simulated instant the current scenario was seeded at, for bounds placed relative to it. */
let baseMs = 0;

before(async () => {
  // An offset no other file takes, inside the window the suite reserves: test files run side by
  // side, and two that share a port fail whichever starts its Postgres second, in its `before`
  // hook, with no reason given.
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 33;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('reconcile-due-times'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise();
  await database.start();
  await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`);
  await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [operator, worker, executor];
  const realTransaction = store.transaction.bind(store);
  store.transaction = ((fn: (db: never, now: Date) => Promise<never>, options?: never) =>
    realTransaction((db, now) => fn(db as never, new Date(now.getTime() + shiftMs) as never), options)) as typeof store.transaction;
});

after(async () => {
  await store?.close();
  await database?.stop();
});

const nowMs = async () => { let at = 0; await store.transaction(async (_db, now) => { at = now.getTime(); }); return at; };
/** Quiet passes until one reads nothing, evaluated nothing and is not full, so the view is settled. */
async function settle() {
  for (let n = 0; n < 10; n++) {
    await engine.reconcile();
    if (!engine.lastReconcile.documentsRead && !engine.lastReconcile.evaluated && !engine.lastReconcile.full) return;
  }
  assert.fail(`the view never settled: ${JSON.stringify(engine.lastReconcile)}`);
}
/** Record the items each pass's lock-free evaluations look at, without changing what they do. */
function evaluations() {
  const hooked = engine as unknown as { reconcileItem?: (...args: unknown[]) => Promise<unknown> };
  const original = Object.getPrototypeOf(engine).reconcileItem as (...args: unknown[]) => Promise<unknown>;
  const evaluated: string[] = [];
  hooked.reconcileItem = function (this: unknown, db: unknown, work: Work, all: Work[], now: Date, options?: { dryRun?: boolean }) {
    if (options?.dryRun) evaluated.push(work.id);
    return original.call(this, db, work, all, now, options);
  } as unknown as (...args: unknown[]) => Promise<unknown>;
  return { evaluated, restore: () => { delete hooked.reconcileItem; } };
}

test('unit:reconcile-full-ms-default-and-bounds — the default configuration full-evaluates no more often than every 300 s, and GRAPHYARD_RECONCILE_FULL_MS still overrides it within its bounds', () => {
  const environment = process.env.GRAPHYARD_RECONCILE_FULL_MS;
  try {
    delete process.env.GRAPHYARD_RECONCILE_FULL_MS;
    assert.equal(configuredReconcileFullMs(), 300_000, 'the default full-evaluation interval is 300 s');
    assert.equal(configuredReconcileFullMs('5000'), 5000, 'the environment overrides inside the bounds');
    assert.equal(configuredReconcileFullMs('2000'), 2000, 'the floor stands');
    assert.equal(configuredReconcileFullMs('300000'), 300000, 'the ceiling stands');
    assert.equal(configuredReconcileFullMs('1999'), 300_000, 'below the floor the default stands');
    assert.equal(configuredReconcileFullMs('300001'), 300_000, 'past the ceiling the default stands');
    assert.equal(configuredReconcileFullMs('soon'), 300_000, 'a non-number takes the default');
    process.env.GRAPHYARD_RECONCILE_FULL_MS = '7000';
    assert.equal(configuredReconcileFullMs(), 7000, 'the environment is still read');
  } finally {
    if (environment === undefined) delete process.env.GRAPHYARD_RECONCILE_FULL_MS;
    else process.env.GRAPHYARD_RECONCILE_FULL_MS = environment;
  }
});

test('unit:reconcile-evaluates-item-when-due — a lease expiring at T wakes its item at the first pass at or after T and no pass before it, and an item with no time-bounded input is never evaluated as due', { timeout: 120_000 }, async () => {
  const id = () => randomUUID();
  const create = (title: string, extra: Record<string, unknown> = {}) => engine.execute(operator, 'create', null,
    { title, criteria: [{ id: 'AC-1', text: 'Holds', proofs: ['unit:reconcile-evaluates-item-when-due'] }], ...extra }, id());
  const leased = await create('Due leased');
  await engine.execute(operator, 'ready', leased.id, {}, id());
  await engine.execute(worker, 'claim', leased.id, {}, id());
  // A child waiting on the leased item: its own document names no instant, so its wake is the
  // parent's write, never a due of its own.
  const child = await create('Due child', { dependencies: [leased.id] });
  await engine.execute(operator, 'ready', child.id, {}, id());
  const expiresAt = Date.parse((await store.list()).find(entry => entry.id === leased.id)!.lease!.expiresAt);
  baseMs = await nowMs();
  engine.reconcileFullEvaluationMs = 300_000;
  await settle();
  const recorded = evaluations();
  try {
    // Between the full evaluations: a pass before the expiry evaluates nothing at all.
    shiftMs = expiresAt - baseMs - 60_000;
    await engine.reconcile();
    assert.equal(engine.lastReconcile.full, false, 'the pass before the expiry is not full');
    assert.deepEqual(recorded.evaluated, [] as string[], `nothing is due and nothing moved before the expiry: ${JSON.stringify(engine.lastReconcile)}`);
    assert.equal(engine.reconcileTicks.at(-1)!.due, 0, 'no item was evaluated because it was due');
    // The first pass at or after the expiry wakes exactly the lapsed item.
    shiftMs = expiresAt - baseMs + 5_000;
    await engine.reconcile();
    assert.deepEqual(recorded.evaluated, [leased.id], `the lapsed item is evaluated, and nothing beside it: ${JSON.stringify(recorded.evaluated)}`);
    assert.equal(engine.reconcileTicks.at(-1)!.due, 1, 'the tick counts the item the clock woke');
    assert.equal((await store.list()).find(entry => entry.id === leased.id)!.lease, null, 'the lapse was reconciled');
    // The child held no due of its own: the parent's write is what reaches it, on the next pass.
    // (The lapsed parent is evaluated beside it every pass now — its standing lease-loss — which
    // is the behavior this item leaves unchanged.)
    recorded.evaluated.length = 0;
    await engine.reconcile();
    assert.ok(recorded.evaluated.includes(child.id), `the dependency's write wakes the child: ${JSON.stringify(recorded.evaluated)}`);
    assert.equal(engine.reconcileTicks.at(-1)!.due, 0, 'the child was not woken by a due of its own');
    // Past the lease-loss settle bound the standing escalation settles and the record comes to
    // rest. The full evaluation the 300 s interval brings may land in the tail and wake the fleet
    // once; what the criterion holds is what the earlier passes named: nothing was evaluated
    // before the expiry, the lapsed item was, and no pass counted a due beyond its own.
    shiftMs += 6 * 60_000;
    await settle();
    const afterSettle = (await store.list()).find(entry => entry.id === leased.id)!;
    assert.deepEqual(standingEscalations(afterSettle).map(entry => entry.trigger), [], 'the standing lease-loss settled');
  } finally { recorded.restore(); }
});

test('unit:reconcile-due-times-match-full-evaluation — the default full pass is due no sooner than 300 s, and over a simulated hour with no writes the due-driven outcomes equal the every-item-every-pass outcomes', { timeout: 600_000 }, async () => {
  const id = () => randomUUID();
  // The default interval, on the engine: no full pass inside 300 s of the last one, then the
  // safety net. The fleet is the settled one the previous test left; nothing writes here.
  engine.reconcileFullEvaluationMs = configuredReconcileFullMs();
  engine.resetReconcileView();
  await engine.reconcile();
  assert.equal(engine.reconcileTicks.at(-1)!.full?.cause, 'view', 'the reset pass is full');
  const viewAt = shiftMs;
  for (const seconds of [60, 120, 180, 240, 290]) {
    shiftMs = viewAt + seconds * 1000;
    await engine.reconcile();
    assert.equal(engine.lastReconcile.full, false, `no full pass ${seconds} s after the last one`);
  }
  shiftMs = viewAt + 310 * 1000;
  await engine.reconcile();
  assert.equal(engine.reconcileTicks.at(-1)!.full?.cause, 'interval', 'past 300 s the safety net runs');

  // A fleet whose every clock-driven change lands inside the hour: a lease lapsing, a dependency
  // waiting on it, a backlog item, a row whose claim lapses, one whose settle window closes, one
  // on a retry backoff, an escalated stall lifting, and a deferral window opening.
  const seedHourFleet = async () => {
    const create = async (title: string, extra: Record<string, unknown> = {}) => {
      const item = await engine.execute(operator, 'create', null,
        { title, criteria: [{ id: 'AC-1', text: 'Holds', proofs: ['unit:reconcile-due-times-match-full-evaluation'] }], ...extra }, id());
      await engine.execute(operator, 'ready', item.id, {}, id());
      return item as Work;
    };
    const leased = await create('Hour leased');
    await engine.execute(worker, 'claim', leased.id, {}, id());
    const child = await create('Hour child', { dependencies: [leased.id] });
    // A backlog item nobody released: its wait runs a day out, so nothing about it is due in the hour.
    await engine.execute(operator, 'create', null,
      { title: 'Hour draft', criteria: [{ id: 'AC-1', text: 'Holds', proofs: ['unit:reconcile-due-times-match-full-evaluation'] }] }, id());
    const rowClaim = await create('Hour row claim'), rowDone = await create('Hour row done'), rowRetry = await create('Hour row retry');
    const stalled = await create('Hour stalled'), windowed = await create('Hour window');
    const claimRow = async (item: Work) => (await engine.claimNextAction(executor, { executor: 'exec-1', host: 'hour-host', leaseSeconds: 300, work: item.id }, id())).action!;
    await claimRow(rowClaim);
    const doneRow = await claimRow(rowDone);
    await engine.settleClaimedAction(executor, doneRow.id, { executor: 'exec-1', result: 'done', reason: 'seeded completion for the due-times hour' }, id());
    const retryRow = await claimRow(rowRetry);
    await engine.settleClaimedAction(executor, retryRow.id, { executor: 'exec-1', result: 'failed', reason: 'seeded failure for the due-times hour' }, id());
    // The deferral window: the reading the windowed item owes can first exist at +20 min.
    await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{observationWindow}', $2::jsonb) WHERE id = $1`,
      [windowed.id, JSON.stringify({ notBefore: new Date(baseMs + 20 * 60_000).toISOString(), basis: 'criterion-window', detail: 'seeded for the due-times hour' })]);
    // The stalled item's dispatch row: eight failures for one unchanged reason, the last at +9 min,
    // so the escalation lifts back to the plain dispatch at +39 min.
    const item = (await store.list()).find(entry => entry.id === stalled.id)!;
    const row = item.actionQueue!.actions.find(entry => entry.kind === 'dispatch')!;
    row.attempts = 8;
    row.history = Array.from({ length: 8 }, (_unused, index) => ({
      at: new Date(baseMs + 9 * 60_000 - (7 - index) * 1000).toISOString(),
      event: 'failed' as const, requester: 'graphyard', executor: 'exec-1', result: 'failed', reason: 'seeded stall for the due-times hour' }));
    await store.pool.query('UPDATE work_items SET document = $2::jsonb WHERE id = $1', [stalled.id, JSON.stringify(item)]);
  };
  // The outcomes a run left, with every volatile instant scrubbed: stage, next action, lease,
  // queue rows and their history, escalations, violations.
  const project = async () => {
    // Item keys come from the same sequence both runs restarted, so they match; content hashes and
    // instants do not (fresh item identities, fresh base time), and both are scrubbed.
    const scrub = (value: string) => value.replace(/\d{4}-\d{2}-\d{2}T[\d.:+-]+(Z|\d{2}:\d{2})?/g, '<t>').replace(/[0-9a-f]{32}/g, '<h>');
    return (await store.list()).map(work => scrub(JSON.stringify({
      key: work.key, stage: work.stage, ready: work.ready, epoch: work.epoch ?? null,
      lease: work.lease ? { owner: work.lease.owner, epoch: work.lease.epoch } : null,
      next: work.nextAction ? { kind: work.nextAction.kind, binding: work.nextAction.binding, inputs: work.nextAction.inputs } : null,
      escalations: standingEscalations(work).map(entry => entry.trigger).sort(),
      rows: (work.actionQueue?.actions ?? []).map(row => ({ kind: row.kind, state: row.state, claim: row.claim?.executor ?? null, attempts: row.attempts, retry: row.retryAt ? 'set' : null, history: (row.history ?? []).map(entry => entry.event) })),
      retired: (work.actionQueue?.history ?? []).map(row => ({ kind: row.kind, state: row.state })),
      violations: [...work.violations].sort(),
    }))).sort();
  };
  const runHour = async (mode: 'every-pass' | 'due') => {
    await store.pool.query('TRUNCATE work_items, events, receipts, jobs, plane_liveness RESTART IDENTITY CASCADE');
    engine.resetReconcileView();
    shiftMs = 0;
    baseMs = await nowMs();
    await seedHourFleet();
    // The due run isolates the mechanism: the full evaluation is held open for the whole hour, so
    // the outcomes it reaches are the dues' work and the face moves', never the safety net's.
    const internals = engine as unknown as { fullEvaluationIntervalMs?: () => number };
    const held = mode === 'due';
    if (held) internals.fullEvaluationIntervalMs = () => Number.MAX_SAFE_INTEGER;
    engine.reconcileFullEvaluationMs = mode === 'every-pass' ? 0 : 300_000;
    let evaluatedTotal = 0;
    const fulls: string[] = [];
    try {
      const record = () => { const tick = engine.reconcileTicks.at(-1)!; evaluatedTotal += tick.evaluated; fulls.push(tick.full ? tick.full.cause : ''); };
      await engine.reconcile(); record();
      for (let step = 0; step < 70; step++) {
        shiftMs = (step + 1) * 60_000;
        await engine.reconcile(); record();
      }
      // Settle at the final instant, so a write one run planned in a batch the other ran a pass
      // later washes out and the finals are comparable.
      for (let n = 0; n < 6; n++) { await engine.reconcile(); record(); }
    } finally { if (held) delete internals.fullEvaluationIntervalMs; }
    return { final: await project(), evaluatedTotal, fulls };
  };
  const everyPass = await runHour('every-pass');
  const due = await runHour('due');
  assert.ok(everyPass.fulls.every(Boolean), `the reference run full-evaluates every pass: ${JSON.stringify(everyPass.fulls.slice(0, 4))}`);
  assert.equal(due.fulls.filter(Boolean).length, 1, `the due run holds the full evaluation open behind its first pass: ${JSON.stringify(due.fulls.filter(Boolean))}`);
  assert.ok(due.evaluatedTotal < everyPass.evaluatedTotal, `the due run wakes fewer items (${due.evaluatedTotal} of ${everyPass.evaluatedTotal}), so the comparison is not vacuous`);
  assert.deepEqual(due.final, everyPass.final, 'after the simulated hour the outcomes equal evaluating every item every pass');
});

test('unit:reconcile-due-evidence-expiry — an evidence record expiring before every other bound is the instant the evaluation records, since the gate stops counting it then with no write', { timeout: 120_000 }, async () => {
  const work = await engine.execute(operator, 'create', null,
    { title: 'Due evidence', criteria: [{ id: 'AC-1', text: 'Holds', proofs: ['unit:reconcile-due-evidence-expiry'] }] }, randomUUID());
  const at = new Date(await nowMs()), expiresAt = new Date(at.getTime() + 1_000).toISOString();
  const all = await store.list(), copy = structuredClone(all.find(entry => entry.id === work.id)!);
  const without = engine.evaluate(structuredClone(copy), all, at);
  assert.ok(without === null || without > at.getTime() + 1_000, `no other bound of the fixture falls within the second: ${without}`);
  copy.evidence = [...copy.evidence, { proof: 'unit:reconcile-due-evidence-expiry', trusted: false, expiresAt } as unknown as Work['evidence'][number]];
  assert.equal(engine.evaluate(copy, all, at), Date.parse(expiresAt), 'the evidence expiry is the earliest instant the outcome can change');
});

test('unit:reconcile-due-held-gates — a mechanical review hold lapsing at its round window and a running split lapsing at its limit and grace are the instants the evaluation records, since the review gate and dispatch move then with no write', { timeout: 120_000 }, async () => {
  const { mechanicalRoundStartMs } = await import('../src/mechanical-findings.js');
  const { decompositionHoldGraceMs } = await import('../src/decomposition.js');
  const work = await engine.execute(operator, 'create', null,
    { title: 'Due holds', criteria: [{ id: 'AC-1', text: 'Holds', proofs: ['unit:reconcile-due-held-gates'] }] }, randomUUID());
  const at = new Date(await nowMs()), all = await store.list(), base = all.find(entry => entry.id === work.id)!;
  const without = engine.evaluate(structuredClone(base), all, at);
  assert.ok(without === null || without > at.getTime() + 1_000, `no other bound of the fixture falls within the second: ${without}`);
  // An approval naming mechanical findings, submitted a second short of its round window.
  const head = 'b'.repeat(40), submittedAt = new Date(at.getTime() - mechanicalRoundStartMs + 1_000).toISOString();
  const candidate = { sha: head, baseSha: 'c'.repeat(40), pr: 9001, branch: 'graphyard/due-holds', author: 'implementer' };
  const held = { ...structuredClone(base), stage: 'review', candidate, submission: { epoch: base.epoch, pr: 9001 }, policy: { ...base.policy, review: true, reviewProvider: 'github' },
    observation: { candidate, reviews: [{ reviewer: 'reviewer[bot]', sha: head, state: 'APPROVED', id: 77, submittedAt, mechanical: 1 }], checks: [], merged: false, prState: 'open', draft: false, at: submittedAt } } as unknown as Work;
  assert.equal(engine.evaluate(held, all, at), Date.parse(submittedAt) + mechanicalRoundStartMs, 'the mechanical hold\'s round window is the earliest instant the outcome can change');
  // A split recorded running, a second short of its limit and grace.
  const splitting = structuredClone(base);
  splitting.decomposition = { state: 'running', startedAt: new Date(at.getTime() - decompositionHoldGraceMs).toISOString(), endedAt: null, runtime: 'claude', model: 'm', timeoutMs: 1_000, bounds: ['opted in'], reason: null } as unknown as Work['decomposition'];
  assert.equal(engine.evaluate(splitting, all, at), at.getTime() + 1_000, 'the running split\'s hold end is the earliest instant the outcome can change');
});
