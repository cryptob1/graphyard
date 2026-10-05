import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store, StaleWrite, save } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { definiteRenewalRefusal } from '../src/supervisor.js';
import type { Observation, Principal, Work } from '../src/model.js';
import { Refusal, unknownWorkCode } from '../src/model/refusal.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1124 AC-1: commands on different items that read no fleet state (heartbeats) take only their
// item's lock and run concurrently; commands that read fleet state still serialise on the fleet
// lock, taken before any item lock, so no lock-order deadlock occurs. AC-3: 100 items and 20
// concurrent writers keep p95 request latency under 1 s.

const operator: Principal = { id: 'operator', role: 'admin' };
const workers: Principal[] = Array.from({ length: 22 }, (_, i) => ({ id: `worker-${i}`, role: 'worker' }));

let database: EmbeddedPostgres, store: Store, engine: Engine;
let queryLatencyMs = 0;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 124;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('per-item-locking'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise();
  await database.start();
  await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`);
  // Every statement on every connection waits `queryLatencyMs` first: the round trip to a hosted
  // database, which a local one lacks. Registered before any connection opens; zero unless a test sets it.
  for (const pool of [store.pool, store.leasePool]) pool.on('connect', client => {
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => !queryLatencyMs || typeof args.at(-1) === 'function'
      ? query(...args) : sleep(queryLatencyMs).then(() => query(...args));
  });
  await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [operator, ...workers];
});

after(async () => {
  await store?.close();
  await database?.stop();
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let created = 0;
async function claimed(worker: Principal) {
  const item = await engine.execute(operator, 'create', null, { title: `Locking item ${++created}`, plannedFiles: [`src/locking-${created}.ts`], criteria: [{ id: 'AC-1', text: 'Holds', proofs: ['unit:per-item-locking'] }] }, randomUUID());
  await engine.execute(operator, 'ready', item.id, {}, randomUUID());
  return engine.execute(worker, 'claim', item.id, {}, randomUUID());
}
const heartbeat = (worker: Principal, work: Work) => engine.execute(worker, 'heartbeat', work.id, { epoch: work.lease!.epoch }, randomUUID());
/** Hold a transaction open with the given locks until `release` is called; resolves `held` once the locks are taken. */
function hold(options: Parameters<Store['transaction']>[1]) {
  let release!: () => void, held!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const taken = new Promise<void>(resolve => { held = resolve; });
  const done = store.transaction(async () => { held(); await released; }, options);
  return { taken, release, done };
}
/** 'settled' once `promise` settles, or 'pending' if it has not within `ms`. */
const within = async <T>(promise: Promise<T>, ms: number) => Promise.race([promise.then(() => 'settled' as const), sleep(ms).then(() => 'pending' as const)]);

test('unit:per-item-locking heartbeats on different items run while a dispatch holds the fleet lock, and neither waits for the other', { timeout: 60_000 }, async () => {
  const [one, two] = [await claimed(workers[0]), await claimed(workers[1])];
  // A real claim command on a third item holding the fleet lock: a claim of a fourth item queues behind it.
  const threeItem = await engine.execute(operator, 'create', null, { title: `Locking item ${++created}`, plannedFiles: [`src/locking-${created}.ts`], criteria: [{ id: 'AC-1', text: 'Holds', proofs: ['unit:per-item-locking'] }] }, randomUUID());
  await engine.execute(operator, 'ready', threeItem.id, {}, randomUUID());

  let releaseDispatch!: () => void;
  const dispatchDone = new Promise<void>(resolve => { releaseDispatch = resolve; });
  let dispatchHeld!: () => void;
  const dispatchTaken = new Promise<void>(resolve => { dispatchHeld = resolve; });
  const originalTx = (store as any).transactionOnce.bind(store);
  (store as any).transactionOnce = async (fn: any, options: any) => {
    if (options.itemLock === threeItem.id && options.lane === 'lease') {
      return originalTx(async (db: any, now: any) => {
        dispatchHeld();
        await dispatchDone;
        return fn(db, now);
      }, options);
    }
    return originalTx(fn, options);
  };

  const dispatchClaim = engine.execute(workers[2], 'claim', threeItem.id, {}, randomUUID());
  await dispatchTaken;
  const waitingClaim = claimed(workers[3]);
  const started = performance.now();
  const [renewedOne, renewedTwo] = await Promise.all([heartbeat(workers[0], one), heartbeat(workers[1], two)]);
  assert.ok(performance.now() - started < 1_000, 'both renewals committed while the fleet lock was held');
  assert.ok(Date.parse(renewedOne.lease!.expiresAt) > Date.parse(one.lease!.expiresAt) && Date.parse(renewedTwo.lease!.expiresAt) > Date.parse(two.lease!.expiresAt));
  assert.equal(await within(waitingClaim, 300), 'pending', 'the fleet command still waits for the fleet lock');
  releaseDispatch();
  const claimedThree = await dispatchClaim;
  (store as any).transactionOnce = originalTx;
  assert.equal(claimedThree.lease?.owner, workers[2].id);
  assert.equal((await waitingClaim).lease?.owner, workers[3].id);

  // One item's lock held: the other item's renewal commits at once, this item's waits for it.
  const itemOne = hold({ fleetLock: false, itemLock: one.id });
  await itemOne.taken;
  assert.equal(await within(heartbeat(workers[1], two), 1_000), 'settled', 'a renewal of item two never waits for item one');
  const blocked = heartbeat(workers[0], one);
  assert.equal(await within(blocked, 300), 'pending', 'a renewal of item one waits for its own item lock');
  itemOne.release();
  await itemOne.done;
  await blocked;
});

test('unit:per-item-locking a heartbeat committing between renewClaimedAction read and write is not overwritten', { timeout: 60_000 }, async () => {
  const coordinator: Principal = { id: 'coordinator', role: 'coordinator' };
  engine.principals.push(coordinator);

  const work = await claimed(workers[4]);
  // Place an open action row in work's actionQueue.
  const actionRow = { id: randomUUID(), kind: 'dispatch', target: 'implementation', state: 'claimed', attempts: 1, claim: { executor: 'exec-1', host: 'host-1', principal: coordinator.id, claimedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), renewals: 0 }, history: [] };
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document, '{actionQueue}', jsonb_build_object('actions', jsonb_build_array($2::jsonb))) WHERE id=$1", [work.id, JSON.stringify(actionRow)]);
  const updatedWork = (await store.list()).find(w => w.id === work.id)!;

  const originalActionOwner = (engine as any).actionOwner.bind(engine);
  let intercepted = false;
  let heartbeatCommitted: any = null;
  (engine as any).actionOwner = async (db: any, id: string) => {
    const result = await originalActionOwner(db, id);
    if (!intercepted && result && result.id === work.id) {
      intercepted = true;
      heartbeatCommitted = await heartbeat(workers[4], updatedWork);
    }
    return result;
  };

  try {
    const renewed = await engine.renewClaimedAction(coordinator, actionRow.id, { executor: 'exec-1', leaseSeconds: 30 });
    assert.ok(intercepted, 'heartbeat was committed between read and write');
    assert.ok(heartbeatCommitted, 'heartbeat succeeded');
    assert.equal(renewed.action.claim?.renewals, 1, 'action was renewed');

    const stored = (await store.list()).find(w => w.id === work.id)!;
    assert.equal(stored.lease?.expiresAt, heartbeatCommitted!.lease?.expiresAt, 'heartbeat renewal was preserved');
    assert.equal(stored.actionQueue?.actions[0].claim?.renewals, 1, 'action renewal was preserved');
  } finally {
    (engine as any).actionOwner = originalActionOwner;
  }
});

test('unit:per-item-locking a cancelled rerun asked again while a heartbeat renews the item keeps the renewal', { timeout: 60_000 }, async () => {
  const work = await claimed(workers[5]);
  const failedRunId = 9_001, at = new Date().toISOString();
  const rerun = { sha: 'a'.repeat(40), check: 'test', failedRunId, state: 'requested', at, runId: 7_001, attempt: 1, detail: 'cancelled:0' };
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document, '{checkReruns}', jsonb_build_array($2::jsonb)) WHERE id=$1", [work.id, JSON.stringify(rerun)]);
  const token = randomUUID();
  await store.pool.query("INSERT INTO jobs(work_id, token, locked_until) VALUES($1, $2, now() + interval '90 seconds') ON CONFLICT (work_id) DO UPDATE SET token=$2, locked_until=now() + interval '90 seconds'", [work.id, token]);
  // The heartbeat starts once the probe has read the item and is evaluating it, before it writes.
  const original = engine.evaluate.bind(engine);
  let renewal: Promise<Work> | undefined;
  engine.evaluate = (item: Work, all: Work[], now: Date) => {
    if (item.id === work.id && !renewal) renewal = heartbeat(workers[5], work);
    return original(item, all, now);
  };
  try {
    const recorded = await engine.recordCheckRerunProbe(work.id, token, rerun, { kind: 'recancelled', runId: 7_002, attempt: 2, detail: `cancelled:1:${at}` });
    assert.ok(renewal, 'the heartbeat ran while the probe held the item');
    const renewed = await renewal!;
    assert.equal(recorded.checkReruns![0].runId, 7_002, 'the rerun asked again is recorded');
    const stored = (await store.list()).find(item => item.id === work.id)!;
    assert.equal(stored.lease!.expiresAt, renewed.lease!.expiresAt, 'the renewal survived the rerun write');
    assert.equal(stored.checkReruns![0].runId, 7_002, 'and the rerun write survived the renewal');
    assert.match(stored.checkReruns![0].detail ?? '', /^cancelled:1:/);
  } finally {
    engine.evaluate = original;
  }
});

test('unit:per-item-locking commands that read fleet state still serialise on the fleet lock', { timeout: 60_000 }, async () => {
  const holder = hold({ fleetLock: true });
  await holder.taken;
  const ready = engine.execute(operator, 'create', null, { title: 'Serialised', plannedFiles: ['src/serialised.ts'], criteria: [{ id: 'AC-1', text: 'Holds', proofs: ['unit:per-item-locking'] }] }, randomUUID());
  assert.equal(await within(ready, 300), 'pending', 'a create reads the fleet and waits for the fleet lock');
  const reconcile = engine.reconcile();
  assert.equal(await within(reconcile, 300), 'pending', 'reconciliation opens under the fleet lock too');
  holder.release();
  await holder.done;
  await Promise.all([ready, reconcile]);
});

test('unit:per-item-locking a fleet command that read an item before a renewal committed never overwrites the renewal', { timeout: 60_000 }, async () => {
  const work = await claimed(workers[3]);
  let attempts = 0, renewed: Work | undefined;
  await store.transaction(async db => {
    attempts++;
    const stale: Work = (await db.query('SELECT document FROM work_items WHERE id=$1', [work.id])).rows[0].document;
    // The first attempt reads, then a renewal of the same item commits under its item lock alone.
    if (attempts === 1) renewed = await heartbeat(workers[3], work);
    stale.title = `${stale.title} (retitled)`;
    await save(db, stale, operator.id, 'test.retitle', new Date());
  });
  assert.equal(attempts, 2, 'the stale write was refused and the transaction ran again on the current document');
  const stored = (await store.list()).find(item => item.id === work.id)!;
  assert.equal(stored.lease!.expiresAt, renewed!.lease!.expiresAt, 'the renewal survived the fleet command');
  assert.match(stored.title, /\(retitled\)$/);
  // Without the retry the refusal surfaces.
  await assert.rejects(store.transaction(async db => {
    const stale: Work = (await db.query('SELECT document FROM work_items WHERE id=$1', [work.id])).rows[0].document;
    await heartbeat(workers[3], stored);
    await save(db, stale, operator.id, 'test.retitle', new Date());
  }, { retryStaleWrites: false }), StaleWrite);
});

test('unit:per-item-locking a renewal of an unknown item is the definite work-not-found refusal', { timeout: 60_000 }, async () => {
  const refusal = await heartbeat(workers[4], { id: randomUUID(), lease: { owner: workers[4].id, epoch: 1, expiresAt: new Date().toISOString() } } as Work).catch(error => error);
  assert.ok(refusal instanceof Refusal, String(refusal));
  // The supervisor stops at once on exactly this answer (GY-448), rather than retrying until its lease runs out.
  assert.equal(refusal.status, 404);
  assert.equal(refusal.details?.code, unknownWorkCode);
  assert.equal(definiteRenewalRefusal({ status: 404, confirmedRefusal: true, body: { error: refusal.message, ...refusal.details } }), true);
});

test('unit:per-item-locking mixed fleet and item locks under concurrent load never deadlock', { timeout: 60_000 }, async () => {
  const items = await Promise.all(workers.slice(5, 10).map(claimed));
  const operations: Promise<unknown>[] = [];
  for (let round = 0; round < 6; round++) {
    items.forEach((work, i) => operations.push(heartbeat(workers[5 + i], work)));
    // Fleet commands (fleet lock, then the item's) and item-only transactions on the same items.
    items.forEach((work, i) => operations.push(store.transaction(async db => { await db.query('SELECT 1 FROM work_items WHERE id=$1 FOR UPDATE', [work.id]); await sleep(2); }, { fleetLock: i % 2 === 0, itemLock: work.id })));
    operations.push(engine.execute(operator, 'create', null, { title: `Mixed ${round}`, plannedFiles: [`src/mixed-${round}.ts`], criteria: [{ id: 'AC-1', text: 'Holds', proofs: ['unit:per-item-locking'] }] }, randomUUID()));
    operations.push(engine.reconcile());
  }
  assert.equal(await within(Promise.all(operations), 30_000), 'settled', 'every operation committed');
});


const headSha = 'a'.repeat(40), baseSha = 'b'.repeat(40);
/** An item submitted for review, whose observation job saves a fresh provider observation every poll. */
async function submittedItem(worker: Principal) {
  let item = await claimed(worker);
  item = await engine.execute(worker, 'workspace', item.id, { epoch: item.epoch, host: 'machine-a', path: `/tmp/locking/${item.id}`, branch: `graphyard/${item.key.toLowerCase()}-${item.epoch}` }, randomUUID());
  return engine.execute(worker, 'submit', item.id, { epoch: item.epoch, pr: Number(item.key.slice(3)) }, randomUUID());
}
const providerObservation = (item: Work): Observation => ({
  clockOffset: { min: 0, max: 0 },
  candidate: { sha: headSha, baseSha, pr: item.submission!.pr, branch: item.workspaces.at(-1)!.branch, author: 'implementer' },
  checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
  reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, files: [`src/locking-${item.key}.ts`], scopeFiles: [],
  at: new Date().toISOString(), prState: 'open', draft: false, baseTip: baseSha, baseTree: 'c'.repeat(40), baseTipContained: true,
});
/** One observation job's save, as the observation worker makes it: read the item, observe, save over the revision read. */
async function observeOnce(id: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const read = (await store.workItem(id))!;
    try { return await engine.observe(id, read.revision, providerObservation(read)); }
    catch (error) { if (!/changed while GitHub was being observed/.test((error as Error).message)) throw error; }
  }
}
/** Hold the reconciliation batch's lock-free evaluation of `id` (GY-1290) until `release`; `reached` resolves once it is there. */
function holdEvaluation(id: string) {
  const internals = engine as unknown as { reconcileItem: (db: unknown, work: Work, all: Work[], now: Date, options?: { dryRun?: boolean }) => Promise<boolean> };
  const original = internals.reconcileItem;
  let release!: () => void, entered!: () => void, armed = true;
  const released = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
  internals.reconcileItem = async function (this: Engine, db, work, all, now, options) {
    if (armed && options?.dryRun && work.id === id) { armed = false; entered(); await released; }
    return original.call(this, db, work, all, now, options);
  };
  return { reached, release, restore: () => { internals.reconcileItem = original; } };
}
/** Hold the reconciliation batch's write of `id` (GY-1290), before its transaction starts, until `release`; `reached` resolves once it is there. */
function holdWrite(id: string) {
  const internals = engine as unknown as { reconcileWrite: (plan: { id: string }, ...rest: unknown[]) => Promise<unknown> };
  const original = internals.reconcileWrite;
  let release!: () => void, entered!: () => void, armed = true;
  const released = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
  internals.reconcileWrite = async function (this: Engine, plan, ...rest) {
    if (armed && plan.id === id) { armed = false; entered(); await released; }
    return original.call(this, plan, ...rest);
  };
  return { reached, release, restore: () => { internals.reconcileWrite = original; } };
}

// GY-1290 AC-1: production's ticks took 22-53 s for 28 items and deferred some. Measured here, the
// contention came from observation saves: each holds the coordination lock across its whole
// evaluation, and moves the item it saves. A batch held its items' row locks while it raced them
// for that lock at its commit with a 200 ms wait, and rolled back whenever any item moved; three
// attempts and it deferred. Lease renewals (adopted) and snapshot reads (no lock) never contended.
test('unit:reconcile-uncontended-under-load 30 items reconciled beside lease renewals, observation saves and snapshot reads at production rates: every tick within 5000 ms, none deferred', { timeout: 300_000 }, async () => {
  const fleet = Array.from({ length: 30 }, (_, i) => ({ ...workers[i % workers.length], id: `fleet-${i}` }));
  engine.principals = [operator, ...workers, ...fleet];
  // Half the fleet is building under a live lease, half is submitted and observed, as production's 28 were.
  const leased = await Promise.all(fleet.slice(0, 15).map(claimed));
  const observed = await Promise.all(fleet.slice(15).map(submittedItem));
  engine.resetReconcileView();
  await engine.reconcile();
  const ticksBefore = engine.reconcileTicks.length, ticks: number[] = [], failures: string[] = [];
  const until = performance.now() + 20_000;
  const loop = async (everyMs: number, run: () => Promise<unknown>, what: string) => {
    await sleep(Math.random() * everyMs);
    while (performance.now() < until) {
      const started = performance.now();
      await run().catch(error => { failures.push(`${what}: ${(error as Error).message}`); });
      await sleep(Math.max(0, everyMs - (performance.now() - started)));
    }
  };
  queryLatencyMs = 5;
  try {
    // Each at or above production's rate: a supervisor renews every 25 s (here 5 s), an observation
    // job saves each submitted item every 20 s (here 3 s), the master loop and the status routes read
    // the coordination snapshot (here every 250 ms), and the server ticks every 2 s. Each second an
    // attempt's lease lapses on a submitted item, so the ticks have writes to make as production's did.
    await Promise.all([
      ...leased.map((work, i) => loop(5_000, () => heartbeat(fleet[i], work), 'renewal')),
      ...observed.map(work => loop(3_000, () => observeOnce(work.id), 'observation')),
      loop(250, () => store.coordinationSnapshot(), 'snapshot'),
      loop(1_000, () => store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{lease}', $2::jsonb) WHERE id = $1`,
        [observed[Math.floor(Math.random() * observed.length)].id, JSON.stringify({ owner: 'gone-worker', epoch: 1, expiresAt: new Date(Date.now() - 1000).toISOString() })]), 'lapse'),
      loop(2_000, async () => { const started = performance.now(); await engine.reconcile(); ticks.push(performance.now() - started); }, 'tick'),
    ]);
  } finally { queryLatencyMs = 0; }
  const recorded = engine.reconcileTicks.slice(ticksBefore);
  assert.deepEqual(failures, [], 'every renewal, observation, snapshot read and tick succeeded');
  assert.ok(ticks.length >= 8, `the server ticked ${ticks.length} times`);
  assert.ok(recorded.every(tick => tick.candidates >= 30), 'every tick reconciled the 30 items');
  assert.ok(recorded.reduce((sum, tick) => sum + tick.writes, 0) >= 5, `the ticks wrote (${JSON.stringify(recorded)})`);
  assert.ok(Math.max(...ticks) < 5_000, `the slowest tick took ${Math.round(Math.max(...ticks))} ms (${ticks.map(Math.round).join(', ')})`);
  assert.equal(recorded.reduce((sum, tick) => sum + tick.deferred, 0), 0, `no tick deferred an item (${JSON.stringify(recorded)})`);
});

// GY-1290 AC-2: three workers lost their leases while reconciliation contended.
test('unit:renewal-independent-of-reconcile a lease renewal completes within 1000 ms while a reconciliation batch is held open on its item, in its evaluation and in its writes', { timeout: 60_000 }, async () => {
  const worker = { ...workers[0], id: 'renewal-worker' }, laterWorker = { ...workers[1], id: 'renewal-worker-later' };
  engine.principals = [...engine.principals, worker, laterWorker];
  const work = await claimed(worker);
  // Its gates cleared, the item's next evaluation writes it: the batch evaluates it and then writes it.
  const unevaluated = async (id = work.id) => store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{gates}', '[]'::jsonb) WHERE id = $1`, [id]);
  const renewWithin = async (what: string, by = worker, item = work) => {
    const started = performance.now();
    const renewed = await heartbeat(by, item);
    assert.ok(performance.now() - started < 1_000, `${what}: the renewal took ${Math.round(performance.now() - started)} ms`);
    return renewed;
  };
  engine.reconcileBatchMs = 60_000;
  try {
    // Held open while it evaluates the item.
    await unevaluated();
    let evaluation = holdEvaluation(work.id);
    let pass = engine.reconcile();
    await evaluation.reached;
    let renewed = await renewWithin('while the batch evaluates the item');
    evaluation.release(); await pass; evaluation.restore();
    let stored = (await store.workItem(work.id))!;
    assert.equal(stored.lease!.expiresAt, renewed.lease!.expiresAt, 'the batch wrote over the renewal, not instead of it');
    assert.ok(stored.gates.length > 0, 'and wrote the evaluation it held');

    // Held open waiting for the coordination lock to write the item, which a fleet command holds.
    await unevaluated();
    evaluation = holdEvaluation(work.id);
    pass = engine.reconcile();
    await evaluation.reached;
    const holder = hold({ fleetLock: true });
    await holder.taken;
    evaluation.release();
    await sleep(50);
    renewed = await renewWithin('while the batch waits for the coordination lock to write the item');
    holder.release(); await holder.done; await pass; evaluation.restore();
    stored = (await store.workItem(work.id))!;
    assert.equal(stored.lease!.expiresAt, renewed.lease!.expiresAt, 'the renewal stands');
    assert.ok(stored.gates.length > 0, 'and the batch wrote its evaluation');

    // Held open in its writes: the batch has written the first item and holds the write of the next.
    const later = await claimed(laterWorker);
    await unevaluated(); await unevaluated(later.id);
    engine.reconcileBatchWrites = 100;
    const writing = holdWrite(later.id);
    pass = engine.reconcile();
    await writing.reached;
    assert.ok((await store.workItem(work.id))!.gates.length > 0, 'the batch wrote the first item before it reached the next');
    renewed = await renewWithin('on an item the batch has already written');
    const renewedLater = await renewWithin('on an item the batch has planned to write next', laterWorker, later);
    writing.release(); await pass; writing.restore();
    stored = (await store.workItem(work.id))!;
    assert.equal(stored.lease!.expiresAt, renewed.lease!.expiresAt, 'the renewal of the written item stands');
    const storedLater = (await store.workItem(later.id))!;
    assert.equal(storedLater.lease!.expiresAt, renewedLater.lease!.expiresAt, 'the batch wrote the next item over its renewal, not instead of it');
    assert.ok(storedLater.gates.length > 0, 'and wrote its evaluation');
  } finally { engine.reconcileBatchMs = 250; engine.reconcileBatchWrites = 8; }
});

test('unit:per-item-locking 100 items and 20 concurrent writers keep p95 request latency under 1 s', { timeout: 300_000 }, async () => {
  const writers = workers.slice(0, 20).map((worker, i) => ({ ...worker, id: `load-${i}` }));
  engine.principals = [operator, ...workers, ...writers];
  const items: Work[] = [];
  for (let n = 0; n < 100; n++) {
    const item = await engine.execute(operator, 'create', null, { title: `Load ${n}`, plannedFiles: [`src/load-${n}.ts`], criteria: [{ id: 'AC-1', text: 'Holds', proofs: ['unit:per-item-locking'] }] }, randomUUID());
    items.push(await engine.execute(operator, 'ready', item.id, {}, randomUUID()));
  }
  const latencies: number[] = [];
  const timed = async <T>(run: () => Promise<T>) => { const started = performance.now(); const result = await run(); latencies.push(performance.now() - started); return result; };
  let writing = true;
  // Reconciliation runs beside the writers, as the server's tick does.
  const ticking = (async () => { while (writing) { await engine.reconcile(); await sleep(50); } })();
  await Promise.all(writers.map(async (writer, w) => {
    for (const item of items.slice(w * 5, w * 5 + 5)) {
      const work = await timed(() => engine.execute(writer, 'claim', item.id, {}, randomUUID()));
      for (let beat = 0; beat < 4; beat++) await timed(() => heartbeat(writer, work));
    }
  }));
  writing = false;
  await ticking;
  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  assert.ok(p95 < 1_000, `p95 ${Math.round(p95)} ms over ${latencies.length} requests (p50 ${Math.round(latencies[Math.floor(latencies.length / 2)])} ms)`);
  engine.resetReconcileView();
  const started = performance.now();
  await engine.reconcile();
  const elapsed = performance.now() - started;
  assert.ok(engine.lastReconcile.full && engine.lastReconcile.live >= 100, 'a full pass over every live item');
  assert.ok(elapsed < 30_000, `a full reconciliation pass took ${Math.round(elapsed)} ms`);
});
