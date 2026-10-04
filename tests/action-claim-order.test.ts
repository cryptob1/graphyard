import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import type { Work } from '../src/model.js';
import { actionId, claimable, claimAction, openActions, settleAction, type ActionRow } from '../src/model/actions.js';
import { claimCandidatesParams, claimCandidatesSql } from '../src/model/action-candidates.js';
import type { NextActionKind } from '../src/model/next-action.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1132: executors claimed the oldest open row whatever it was, so on 2026-10-03 a P0 item's
 * resync waited 25 minutes behind 34 dispatch rows, hours old, that failed on every attempt for
 * want of a worker. Claim order is now the item's priority, then rows that unblock a merge, then
 * age — in `openActions` and in the SQL that finds the candidate items alike.
 *
 * One case per proof: unit:claim-order-priority-before-age, unit:failing-dispatch-row-yields-to-others
 * and unit:claim-order-age-within-peers.
 */

const executor = { id: 'executor-a', host: 'host-1', principal: 'executor-a' };
const noWorker = (key: string) => `no worker profile can take ${key}: every healthy profile is reserved by another dispatch`;

let database: EmbeddedPostgres, store: Store;
before(async () => {
  // An offset no other test file takes: two files sharing a port fail whichever starts second.
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1132;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('claim-order'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

let sequence = 0;
/** An item holding one open row of `kind`, requested at `requestedAt`. */
function item(options: { priority: number; stage: Work['stage']; kind: NextActionKind; requestedAt: Date }): Work {
  const id = randomUUID(), key = `GY-${9000 + ++sequence}`;
  const row: ActionRow = {
    id: actionId(options.kind, id, `${options.kind}:0`), kind: options.kind, work: id, key, inputs: {} as ActionRow['inputs'],
    gate: null, refusal: null, reason: `${key} needs ${options.kind}`, binding: `${options.kind}:0`,
    requestedBy: 'graphyard', requestedAt: options.requestedAt.toISOString(), state: 'pending', claim: null, attempts: 0, history: [],
  };
  return { id, key, title: key, priority: options.priority, stage: options.stage, actionQueue: { actions: [row], history: [] } } as unknown as Work;
}
const rowOf = (work: Work) => work.actionQueue!.actions[0];
const fail = (work: Work, reason: string, now: Date) => settleAction(work, rowOf(work).id, { executor: executor.id, principal: executor.principal }, 'failed', reason, now);

/** The candidate items the claim SQL lists for these documents, in its order, at the database clock. */
async function candidates(all: Work[], kinds?: readonly NextActionKind[]) {
  await store.pool.query('DELETE FROM work_items');
  for (const work of all) await store.pool.query('INSERT INTO work_items(id, document) VALUES($1, $2)', [work.id, JSON.stringify(work)]);
  return (await store.pool.query(claimCandidatesSql, claimCandidatesParams(undefined, kinds))).rows.map(row => row.id as string);
}
/**
 * One claim as `Engine.claimNextAction` makes it: the SQL lists the candidate items, only those
 * documents are loaded and claimed from, and the claimed item and every item whose row stepped
 * aside are written back — so a row backing off elsewhere is invisible to the claim.
 */
async function claimThroughCandidates(all: Work[], kinds: readonly NextActionKind[]) {
  const listed = new Set(await candidates(all, kinds));
  const loaded = (await store.pool.query('SELECT document FROM work_items WHERE id = ANY($1::uuid[])', [[...listed]])).rows.map(row => row.document as Work);
  const claimed = claimAction(loaded, executor, new Date(), { kinds });
  for (const saved of claimed ? [claimed.work, ...claimed.yielded] : []) all.splice(all.findIndex(work => work.id === saved.id), 1, saved);
  return claimed;
}
/** The items `openActions` would serve, in order of their first row. */
const servedItems = (all: Work[], now: Date, kinds?: readonly NextActionKind[]) => [...new Set(openActions(all, now, kinds).map(entry => entry.work.id))];

test('unit:claim-order-priority-before-age — a later P0 resync at the merge stage is claimed ahead of 40 older P2 dispatch rows, and the SQL agrees', async () => {
  const now = new Date();
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
  const dispatches = Array.from({ length: 40 }, (_unused, index) => item({ priority: 2, stage: 'ready', kind: 'dispatch', requestedAt: new Date(hoursAgo(30).getTime() + index * 60_000) }));
  const resync = item({ priority: 0, stage: 'merge', kind: 'resync', requestedAt: hoursAgo(1) });
  const all = [...dispatches, resync];
  const kinds: NextActionKind[] = ['dispatch', 'resync'];

  const claimed = claimAction(structuredClone(all), executor, now, { kinds });
  assert.equal(claimed?.row.id, rowOf(resync).id, 'the priority-0 resync row is claimed first, though requested last');

  // The kind order, within one priority: a row that unblocks a merge goes ahead of an older dispatch;
  // a resync on an item not yet at the merge stage unblocks no merge and keeps its age order.
  const olderDispatch = item({ priority: 1, stage: 'ready', kind: 'dispatch', requestedAt: hoursAgo(10) });
  const mergeRow = item({ priority: 1, stage: 'merge', kind: 'merge', requestedAt: hoursAgo(2) });
  const earlyResync = item({ priority: 1, stage: 'test', kind: 'resync', requestedAt: hoursAgo(3) });
  const higherDispatch = item({ priority: 0, stage: 'ready', kind: 'dispatch', requestedAt: hoursAgo(1) });
  const mixed = [olderDispatch, mergeRow, earlyResync, higherDispatch, ...dispatches.slice(0, 3)];
  const expected = [higherDispatch, mergeRow, olderDispatch, earlyResync, ...dispatches.slice(0, 3)].map(work => work.id);
  assert.deepEqual(servedItems(mixed, now), expected, 'priority, then merge-unblocking rows, then the oldest request');

  // The SQL that finds the candidate items lists them in the same order, so the item whose row
  // `claimAction` takes is the first one it names.
  const listed = await candidates(all, kinds);
  assert.equal(listed[0], resync.id, 'the claim SQL lists the P0 resync item first');
  assert.deepEqual(listed, servedItems(all, now, kinds), 'the SQL and openActions agree on the order of all 41 items');
  assert.deepEqual(await candidates(mixed), expected, 'the SQL orders priority, kind and age as openActions does');

  // A row whose requestedAt is malformed counts as oldest in both orders and fails neither.
  const malformed = item({ priority: 2, stage: 'ready', kind: 'dispatch', requestedAt: now });
  rowOf(malformed).requestedAt = 'not a timestamp';
  const withMalformed = [...dispatches.slice(0, 3), malformed];
  assert.deepEqual(servedItems(withMalformed, now)[0], malformed.id, 'openActions places a malformed requestedAt first among its peers');
  assert.deepEqual(await candidates(withMalformed), servedItems(withMalformed, now), 'the SQL lists it in the same place instead of failing');
});

test('unit:failing-dispatch-row-yields-to-others — a dispatch row that failed for want of a worker backs off, and one executor does not take it twice running while another row is claimable', async () => {
  const start = new Date();
  // The failing row is first in every order — highest priority and oldest — so neither priority nor
  // age lets the others ahead of it; only its backoff and the executor's last failure do.
  const failing = item({ priority: 0, stage: 'ready', kind: 'dispatch', requestedAt: new Date(start.getTime() - 7_200_000) });
  const others = Array.from({ length: 2 }, (_unused, index) => item({ priority: 2, stage: 'ready', kind: 'dispatch', requestedAt: new Date(start.getTime() - 3_600_000 + index * 1_000) }));
  const all = [failing, ...others];

  const first = claimAction(all, executor, start, { kinds: ['dispatch'] });
  assert.equal(first?.row.id, rowOf(failing).id, 'the failing row is claimed first');
  fail(failing, noWorker(failing.key), start);

  // It is not claimable until its retryAt, and executors claim the other rows meanwhile.
  const retryAt = new Date(rowOf(failing).retryAt!);
  assert.ok(retryAt.getTime() > start.getTime(), 'the failure set a retryAt');
  const backingOff = new Date(retryAt.getTime() - 1);
  assert.equal(claimable(rowOf(failing), backingOff), false, 'it is not claimable before its retryAt');
  assert.ok(!openActions(all, backingOff).some(entry => entry.row.id === rowOf(failing).id), 'openActions does not offer it before its retryAt');
  assert.equal(claimAction(structuredClone(all), { ...executor, id: 'executor-b', principal: 'executor-b' }, backingOff, { kinds: ['dispatch'] })?.row.id, rowOf(others[0]).id,
    'while it backs off, another executor claims the next row');
  const listed = await candidates(all, ['dispatch']);
  assert.ok(!listed.includes(failing.id), 'the claim SQL does not list an item whose only row is backing off');
  assert.deepEqual(listed, others.map(work => work.id), 'the claim SQL lists the other claimable items');

  // At its retryAt it is claimable again and still first in claim order, yet the executor whose
  // last attempt failed on it takes another claimable row instead of the same failing one.
  assert.equal(claimable(rowOf(failing), retryAt), true, 'it is claimable again at its retryAt');
  assert.equal(openActions(all, retryAt)[0].row.id, rowOf(failing).id, 'it heads the claim order again');
  const second = claimAction(all, executor, retryAt, { kinds: ['dispatch'] });
  assert.ok(second, 'a claimable row exists');
  assert.notEqual(second!.row.id, rowOf(failing).id, 'two consecutive claims by one executor do not return the same failing row while another is claimable');
  assert.equal(second!.row.id, rowOf(others[0]).id, 'the next row in claim order is taken instead');

  // It yields only one turn: once that executor's last attempt is elsewhere, it is taken again.
  fail(others[0], noWorker(others[0].key), retryAt);
  assert.equal(claimAction(all, executor, retryAt, { kinds: ['dispatch'] })?.row.id, rowOf(failing).id, 'the failing row is claimed on the next turn');
  fail(failing, noWorker(failing.key), retryAt);

  // The yield is decided from the row, not from the other rows the claim loaded: driven through
  // the candidate SQL, where a row backing off is never loaded, a P0 resync this executor failed
  // steps aside once and is then taken, not left behind each further row the executor fails.
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  const resync = item({ priority: 0, stage: 'merge', kind: 'resync', requestedAt: minutesAgo(30) });
  const stalled = [0, 1, 2].map(index => item({ priority: 2, stage: 'ready', kind: 'dispatch', requestedAt: minutesAgo(600 - index) }));
  const fleet = [resync, ...stalled];
  const kinds: NextActionKind[] = ['dispatch', 'resync'];
  const backOff = (work: Work) => { rowOf(work).retryAt = new Date(Date.now() + 3_600_000).toISOString(); };
  // Claims through the SQL write back the documents they loaded, as the engine saves them.
  const current = (work: Work) => fleet.find(saved => saved.id === work.id)!;
  assert.equal(claimAction(fleet, executor, minutesAgo(25), { kinds })?.row.id, rowOf(resync).id, 'the P0 resync is claimed first');
  fail(resync, 'the base moved while resyncing', minutesAgo(25));
  assert.equal(claimAction(fleet, executor, minutesAgo(25), { kinds })?.row.id, rowOf(stalled[0]).id, 'while it backs off, the executor takes a dispatch row');
  fail(stalled[0], noWorker(stalled[0].key), minutesAgo(25)); backOff(stalled[0]);
  assert.equal(claimable(rowOf(resync), new Date()), true, 'the resync is back from its backoff');
  const passedOnce = await claimThroughCandidates(fleet, kinds);
  assert.equal(passedOnce?.row.id, rowOf(stalled[1]).id, 'the resync steps aside once for the executor whose attempt on it failed');
  assert.deepEqual(passedOnce!.yielded.map(work => work.id), [resync.id], 'the item whose row stepped aside is saved with the claim');
  fail(current(stalled[1]), noWorker(stalled[1].key), new Date()); backOff(current(stalled[1]));
  const resumed = await claimThroughCandidates(fleet, kinds);
  assert.equal(resumed?.row.id, rowOf(resync).id, 'it is taken on the next claim, ahead of the dispatch row behind it, though the rows the executor failed since are not loaded');
  assert.equal(rowOf(current(resync)).yielded, undefined, 'claiming it clears the mark, so its next failure yields once again');

  // With nothing else claimable, the same executor takes it again rather than idling.
  const alone = [failing];
  const later = new Date(rowOf(failing).retryAt!);
  assert.equal(claimAction(alone, executor, later, { kinds: ['dispatch'] })?.row.id, rowOf(failing).id, 'alone, the failing row is claimed again');
});

test('unit:claim-order-age-within-peers — among rows of equal priority and kind the oldest is claimed first, and a lower-priority row is reached within one pass', async () => {
  const now = new Date();
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  // Created newest first, so neither creation order nor id order can stand in for age.
  const peers = [5, 40, 15, 90, 60].map(minutes => item({ priority: 2, stage: 'ready', kind: 'dispatch', requestedAt: ago(minutes) }));
  const byAge = [...peers].sort((a, b) => Date.parse(rowOf(a).requestedAt) - Date.parse(rowOf(b).requestedAt)).map(work => work.key);

  let clock = now;
  const claimed: string[] = [];
  for (const _peer of peers) {
    const entry = claimAction(peers, executor, clock, { kinds: ['dispatch'] })!;
    claimed.push(entry.work.key);
    fail(entry.work, noWorker(entry.work.key), clock);
    clock = new Date(clock.getTime() + 1_000);
  }
  assert.deepEqual(claimed, byAge, 'peers are claimed oldest request first');
  assert.equal(claimAction(peers, executor, clock, { kinds: ['dispatch'] }), null, 'each peer was claimed once in the pass, then backs off');
  assert.deepEqual(await candidates(peers.map(work => ({ ...work, actionQueue: { actions: [{ ...rowOf(work), state: 'pending', claim: null, retryAt: undefined }], history: [] } }) as unknown as Work)),
    peers.map(work => ({ key: work.key, id: work.id })).sort((a, b) => byAge.indexOf(a.key) - byAge.indexOf(b.key)).map(entry => entry.id), 'the claim SQL lists peers oldest first');

  // A row left open longest, behind higher-priority rows that keep failing: once each of them has
  // been claimed and backs off, it is the next row claimed — it does not wait for them to succeed.
  const ahead = [0, 1, 1].map((priority, index) => item({ priority, stage: 'ready', kind: 'dispatch', requestedAt: ago(10 - index) }));
  const oldest = item({ priority: 2, stage: 'ready', kind: 'dispatch', requestedAt: ago(24 * 60) });
  const all = [oldest, ...ahead];
  clock = now;
  const pass: string[] = [];
  for (let round = 0; round <= ahead.length; round++) {
    const entry = claimAction(all, executor, clock, { kinds: ['dispatch'] })!;
    pass.push(entry.work.key);
    fail(entry.work, noWorker(entry.work.key), clock);
    clock = new Date(clock.getTime() + 1_000);
  }
  assert.deepEqual(pass, [...ahead.map(work => work.key), oldest.key], 'the oldest lower-priority row is claimed within one pass over the rows ahead of it');
});
