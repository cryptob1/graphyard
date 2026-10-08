import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import type { Principal, Work } from '../src/model.js';
import { recordAssignmentStart } from '../src/pipeline-speed.js';
import { latencyBudget, latencyTargets, observeItemClock, type DaemonState } from '../src/master-daemon.js';
import { itemClockSchema, latencySampleSchema, type LatencySample } from '../src/daemon/latency-clock.js';
import * as daemonState from '../src/daemon/state.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1499: ready→first push (p90 25 minutes against 15) could not say whether launching the worker
// or the agent's own work was slow. The engine stamps the session start at the epoch's first lease
// renewal — the watch supervisor renews once just before it starts the agent — and the loop's item
// clock carries it, so a delivery splits ready→first push into launch overhead (claim→start) and
// working time (start→first push), and the budget names both p90s when the target is missed.

let teardown: (() => Promise<void>) | undefined;
after(async () => { await teardown?.(); });

test('unit:assignment-started-at — the first lease renewal of an epoch stamps lastAssignment.startedAt once; later renewals never move it and another epoch never sets it', { timeout: 180_000 }, async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1499;
  const database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('launch-overhead-split'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('launch_split');
  const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/launch_split`); await store.init();
  teardown = async () => { await store.close(); await database.stop(); };
  const engine = new Engine(store, [15368], 120, 'owner/launch-split'); engine.submissionObserver = null;
  const operator: Principal = { id: 'split-operator', role: 'admin', sessionKind: 'human' };
  const worker: Principal = { id: 'split-worker', role: 'worker', sessionKind: 'ai' };
  const run = (actor: Principal, command: string, id: string | null, input: unknown) => engine.execute(actor, command as any, id, input, randomUUID()) as Promise<Work>;
  const current = async (id: string) => (await store.list()).find(item => item.id === id)!;

  let work = await run(operator, 'create', null, { title: 'Split', plannedFiles: ['src/split.ts'], criteria: [{ id: 'AC-1', text: 'Splits', proofs: ['unit:splits'] }], reason: 'GY-1499 fixture' });
  await run(operator, 'ready', work.id, {});
  work = await run(worker, 'claim', work.id, {});
  const claimed = await current(work.id);
  assert.ok(claimed.lastAssignment?.claimedAt, 'the claim records its time');
  assert.equal(claimed.lastAssignment?.startedAt, undefined, 'no session has started at the claim');

  await new Promise(resolve => setTimeout(resolve, 20));
  await run(worker, 'heartbeat', work.id, { epoch: work.epoch });
  const started = (await current(work.id)).lastAssignment!;
  assert.equal(started.epoch, work.epoch);
  assert.ok(started.startedAt, 'the first renewal stamps the session start');
  assert.ok(Date.parse(started.startedAt!) > Date.parse(started.claimedAt!), 'after the claim');

  for (let n = 0; n < 3; n++) { await new Promise(resolve => setTimeout(resolve, 10)); await run(worker, 'heartbeat', work.id, { epoch: work.epoch }); }
  assert.equal((await current(work.id)).lastAssignment!.startedAt, started.startedAt, 'later renewals never move it');

  // A new epoch is a new assignment: its claim carries no start until its own first renewal.
  await run(worker, 'release', work.id, { epoch: work.epoch, cause: 'GY-1499 fixture: second epoch' });
  const second = await run(worker, 'claim', work.id, {});
  assert.equal(second.epoch, work.epoch + 1);
  const reclaimed = await current(work.id);
  assert.equal(reclaimed.lastAssignment!.epoch, second.epoch);
  assert.equal(reclaimed.lastAssignment!.startedAt, undefined, 'the previous epoch\'s start is not carried into the new assignment');
  await run(worker, 'heartbeat', work.id, { epoch: second.epoch });
  const restarted = (await current(work.id)).lastAssignment!;
  assert.ok(restarted.startedAt && Date.parse(restarted.startedAt) > Date.parse(started.startedAt!), 'the new epoch has its own start');

  // The rule itself: a renewal of another epoch never sets the start, and an assignment carried
  // forward without its claim time was not watched from its claim, so its start stays unknown.
  const other = { lastAssignment: { owner: 'w', epoch: 3, claimedAt: '2031-01-01T00:00:00Z' } } as Work;
  recordAssignmentStart(other, 2, new Date('2031-01-01T00:01:00Z'));
  assert.equal(other.lastAssignment!.startedAt, undefined);
  const carried = { lastAssignment: { owner: 'w', epoch: 3 } } as Work;
  recordAssignmentStart(carried, 3, new Date('2031-01-01T00:01:00Z'));
  assert.equal(carried.lastAssignment!.startedAt, undefined);
});

const minute = 60_000;
const T0 = Date.parse('2031-05-01T09:00:00Z');
const iso = (offset: number) => new Date(T0 + offset).toISOString();
/** The loop's cursor as the item clock reads it: its clocks alone. */
const clocks = () => ({ clocks: {} }) as unknown as DaemonState;
/** An item on its way through one attempt, as the coordination snapshot shows it to the loop. */
function item(overrides: Partial<Work>): Work {
  return { id: 'w-1499', key: 'GY-1499', stage: 'build', epoch: 1, ready: true, blocker: null, lease: null, submission: null, reworkRequested: false, candidate: null,
    gates: [], dependencies: [], plannedFiles: ['src/split.ts'], criteria: [], stageEnteredAt: iso(0), ...overrides } as unknown as Work;
}

test('unit:latency-sample-split — the schemas live in src/daemon/latency-clock.ts, the item clock captures the epoch\'s session start, and a delivery records claim→start and start→first push beside ready→first push, each null when an endpoint is unknown', () => {
  // The schemas moved and src/daemon/state.ts uses them from there.
  assert.equal(daemonState.itemClockSchema, itemClockSchema);
  assert.equal(daemonState.latencySampleSchema, latencySampleSchema);
  assert.equal(itemClockSchema.parse({ key: 'GY-1', epoch: 1 }).startedAt, null);
  assert.deepEqual([latencySampleSchema.parse({ work: 'GY-1', at: iso(0) }).claimToStartMs, latencySampleSchema.parse({ work: 'GY-1', at: iso(0) }).startToPushMs], [null, null]);

  const state = clocks();
  const lease = { owner: 'w', epoch: 1, expiresAt: iso(60 * minute) };
  observeItemClock(state, item({}), T0);
  assert.equal(state.clocks['w-1499'].readyAt, iso(0));
  // Claimed one minute after ready; the session started three minutes after the claim.
  observeItemClock(state, item({ lease, lastAssignment: { owner: 'w', epoch: 1, claimedAt: iso(minute) } }), T0 + 2 * minute);
  assert.equal(state.clocks['w-1499'].startedAt, null, 'no start is guessed before the engine records one');
  observeItemClock(state, item({ lease, lastAssignment: { owner: 'w', epoch: 1, claimedAt: iso(minute), startedAt: iso(4 * minute) } }), T0 + 5 * minute);
  assert.equal(state.clocks['w-1499'].startedAt, iso(4 * minute));
  // A start recorded for another epoch is not this attempt's.
  const stale = clocks();
  observeItemClock(stale, item({ epoch: 2, lease: { ...lease, epoch: 2 }, lastAssignment: { owner: 'w', epoch: 1, claimedAt: iso(minute), startedAt: iso(4 * minute) } }), T0 + 5 * minute);
  assert.equal(stale.clocks['w-1499'].startedAt, null);

  // First push sixteen minutes after the start, then delivered.
  const pushed = { lease, lastAssignment: { owner: 'w', epoch: 1, claimedAt: iso(minute), startedAt: iso(4 * minute) }, candidate: { sha: 'a'.repeat(40), createdAt: iso(20 * minute) } } as Partial<Work>;
  observeItemClock(state, item(pushed), T0 + 21 * minute);
  const sample = observeItemClock(state, item({ ...pushed, lease: null, stage: 'done', submission: { epoch: 1, pr: 1499 }, delivery: { mergedAt: iso(40 * minute) } } as Partial<Work>), T0 + 41 * minute)!;
  assert.equal(sample.readyToClaimMs, minute);
  assert.equal(sample.readyToPushMs, 20 * minute);
  assert.equal(sample.claimToStartMs, 3 * minute, 'launch overhead: claim→session start');
  assert.equal(sample.startToPushMs, 16 * minute, 'working time: session start→first push');

  // An attempt whose start the engine never recorded has neither half, and still its ready→first push.
  const unstarted = clocks();
  observeItemClock(unstarted, item({}), T0);
  const bare = { lease, lastAssignment: { owner: 'w', epoch: 1, claimedAt: iso(minute) }, candidate: { sha: 'b'.repeat(40), createdAt: iso(10 * minute) } } as Partial<Work>;
  observeItemClock(unstarted, item(bare), T0 + 11 * minute);
  const unsplit = observeItemClock(unstarted, item({ ...bare, lease: null, stage: 'done', submission: { epoch: 1, pr: 1499 }, delivery: { mergedAt: iso(30 * minute) } } as Partial<Work>), T0 + 31 * minute)!;
  assert.equal(unsplit.readyToPushMs, 10 * minute);
  assert.deepEqual([unsplit.claimToStartMs, unsplit.startToPushMs], [null, null]);
});

test('unit:first-push-breakdown-reported — latencyBudget reports launch overhead and working percentiles, and the ready→first push breach names both p90s while every other reason and the met rule are unchanged', () => {
  const sample = (index: number, fields: Partial<LatencySample>) => latencySampleSchema.parse({ work: `GY-${index}`, at: iso(index * minute), approvalToMergeMs: minute, mergeableToMergeMs: minute, ...fields });
  // Ten deliveries: ready→first push 25 minutes, of which launch 10 and working 14 (claim 1).
  const slow = Array.from({ length: 10 }, (_, index) => sample(index, { readyToClaimMs: minute, readyToPushMs: 25 * minute, claimToStartMs: 10 * minute, startToPushMs: 14 * minute }));
  const budget = latencyBudget(slow);
  assert.deepEqual(budget.launchOverhead, { count: 10, p50Ms: 10 * minute, p90Ms: 10 * minute });
  assert.deepEqual(budget.working, { count: 10, p50Ms: 14 * minute, p90Ms: 14 * minute });
  assert.equal(budget.met, false);
  assert.deepEqual(budget.reasons, ['ready→first push p90 25 min exceeds 15 min (launch overhead p90 10 min, working p90 14 min)']);
  assert.equal(budget.target, latencyTargets);
  assert.equal(latencyTargets.readyToFirstPushP90Ms, 900_000, 'the target is unchanged');

  // A breach over samples recorded before the split names each half as unmeasured.
  const legacy = latencyBudget(slow.map(entry => ({ ...entry, claimToStartMs: null, startToPushMs: null })));
  assert.deepEqual([legacy.launchOverhead.count, legacy.working.count], [0, 0]);
  assert.deepEqual(legacy.reasons, ['ready→first push p90 25 min exceeds 15 min (launch overhead p90 unmeasured, working p90 unmeasured)']);

  // Inside the target: met over ten deliveries, null below ten — the split never decides either.
  const fast = Array.from({ length: 10 }, (_, index) => sample(index, { readyToClaimMs: minute, readyToPushMs: 10 * minute, claimToStartMs: 2 * minute, startToPushMs: 7 * minute }));
  assert.equal(latencyBudget(fast).met, true);
  assert.deepEqual(latencyBudget(fast).reasons, []);
  const few = latencyBudget(fast.slice(0, 3));
  assert.equal(few.met, null);
  assert.deepEqual(few.reasons, ['3 deliveries measured; the p90 targets are judged over at least 10']);

  // Every other reason reads as it did.
  const others = latencyBudget([sample(1, { readyToClaimMs: 5 * minute, approvalToMergeMs: 20 * minute, mergeableToMergeMs: 8 * minute }), sample(2, { verdictToReworkMs: 9 * minute })]);
  assert.deepEqual(others.reasons, [
    'ready→claim p90 5 min exceeds 2 min',
    'approval→merge p90 20 min exceeds 10 min',
    'GY-1 stayed mergeable for 8 min, past the 5 min bound',
    'GY-2 carried a standing verdict for 9 min before rework was requested, past the 5 min bound',
  ]);
});
