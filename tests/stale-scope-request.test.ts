import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine, scopeRequestEndedReason } from '../src/engine.js';
import { livenessOf } from '../src/model/liveness.js';
import { scopeRefusalBlocker } from '../src/model/scope.js';
import type { Principal, Work } from '../src/model.js';

/**
 * GY-597: a scope request belongs to the attempt (epoch) that filed it. On 2026-09-26 GY-402's
 * epoch 7 asked for a file the widening rule refused; the attempt then ended and a rework was
 * applied, and hours later the item still carried the epoch-7 refusal as its ready-gate blocker,
 * the loop still reported it "owed a scope decision", and `master unblock` left it in place, so
 * the reworked item could not be dispatched. Each test is named for the proof it produces:
 * unit:scope-request-ends-with-attempt and unit:unblock-closes-stale-scope-request.
 */

const human: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'engineer-a', role: 'worker', runtime: 'cursor', sessionKind: 'ai' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };

let database: EmbeddedPostgres, store: Store, engine: Engine;
const id = () => randomUUID();
const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
const events = async (work: Work, kind: string) => (await store.events(work.id)).filter(event => event.kind === kind);
const ready = (work: Work) => work.gates.find(gate => gate.name === 'ready')!;

before(async () => {
  // An offset no other test file takes: two files sharing a port fail in their `before` hook.
  const port = Number(process.env.GRAPHYARD_STALE_SCOPE_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 36);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-stale-scope-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.submissionObserver = null;
  engine.principals = [human, worker, coordinator];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

/** Rewrite the stored document the way an earlier history left it, without replaying that history. */
async function overwrite(work: Work, mutate: (document: Work) => void) {
  const document = await reload(work); mutate(document);
  await store.pool.query('UPDATE work_items SET document=$2::jsonb WHERE id=$1', [document.id, JSON.stringify(document)]);
  return document;
}

let sequence = 0;
/**
 * An item claimed at `epoch` whose scope request for a file nothing implies has been refused by
 * the widening rule: the refusal is the item's blocker, exactly as GY-402's epoch 7 stood.
 */
async function refusedAt(epoch: number) {
  const scope = `src/stale-scope-${++sequence}/`;
  let work = await engine.execute(human, 'create', null, { title: `Stale scope ${sequence}`, plannedFiles: [scope], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:stale-scope'] }] }, id());
  work = await engine.execute(human, 'ready', work.id, {}, id());
  await overwrite(work, document => { document.epoch = epoch - 1; });
  work = await engine.execute(worker, 'claim', work.id, {}, id());
  assert.equal(work.epoch, epoch);
  work = await engine.execute(worker, 'workspace', work.id, { epoch, host: 'scope-host', path: `/tmp/stale-scope/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${epoch}` }, id());
  work = await engine.execute(worker, 'scope', work.id, { epoch, paths: ['tests/auto-dispatch.test.ts'], reason: 'The dispatch test fails on this branch' }, id());
  work = await engine.execute(coordinator, 'autoscope', work.id, { epoch }, id());
  assert.equal(work.scopeRequest!.decision!.state, 'refused');
  assert.ok(work.blocker!.startsWith(scopeRefusalBlocker));
  assert.ok(ready(work).reasons.some(reason => reason.startsWith(scopeRefusalBlocker)), 'the refusal holds the ready gate while its attempt is live');
  return work;
}

/** The request is closed with its reason, and nothing about it holds or escalates the item any more. */
async function assertClosed(work: Work, epoch: number, by: string) {
  assert.equal(work.scopeRequest ?? null, null, 'the ended attempt\'s request is no longer open');
  assert.equal(scopeRequestEndedReason, 'attempt ended');
  assert.equal(work.blocker, null, 'the refusal it wrote no longer blocks the item');
  assert.equal(ready(work).passed, true, JSON.stringify(ready(work).reasons));
  assert.ok(!ready(work).reasons.some(reason => reason.startsWith(scopeRefusalBlocker)));
  const liveness = livenessOf(work, await store.list(), new Date());
  assert.ok(!JSON.stringify(liveness).includes('owed a scope decision'), 'no scope-decision attention is owed');
  assert.notEqual(liveness.violation?.class, 'refused-scope');
  assert.ok(!(work.nextAction?.reason ?? '').includes('owed a scope decision'));
  const [closed] = await events(work, 'scope.closed');
  assert.ok(closed, 'the closure is in the item\'s history');
  const { details } = closed.payload;
  assert.deepEqual({ epoch: details.epoch, reason: details.reason, by: details.by, decision: details.decision, paths: details.paths }, { epoch, reason: scopeRequestEndedReason, by, decision: 'refused', paths: ['tests/auto-dispatch.test.ts'] });
  assert.match(details.refusal, /outside what this item's own criteria/);
}

test('unit:scope-request-ends-with-attempt — a refused request from epoch 7 is closed when that attempt ends, and epoch 8 is dispatched with no scope refusal', async () => {
  // A rework decision applied to the attempt that asked: GY-402's case.
  let work = await refusedAt(7);
  work = await engine.execute(human, 'rework', work.id, { reason: 'Main fixed the failing test; redo on the new base', previousWorkerStopped: true }, id());
  await assertClosed(work, 7, 'rework');
  assert.equal(work.nextAction?.kind, 'dispatch', `the reworked item is dispatchable: ${JSON.stringify(work.nextAction)}`);
  work = await engine.execute(worker, 'claim', work.id, {}, id());
  assert.equal(work.epoch, 8, 'the next attempt claims the item');
  assert.equal(work.scopeRequest ?? null, null);
  assert.ok(!ready(work).reasons.some(reason => reason.startsWith(scopeRefusalBlocker)), 'epoch 8 carries no scope refusal');

  // A lease that lapses under the request: reconciliation ends the attempt and closes the ask.
  let lapsed = await refusedAt(7);
  await overwrite(lapsed, document => { document.lease = { ...document.lease!, expiresAt: new Date(Date.now() - 1000).toISOString() }; });
  await engine.reconcile();
  lapsed = await reload(lapsed);
  await assertClosed(lapsed, 7, 'lease.expired');

  // The worker releasing its lease, and a submission, end the attempt the same way.
  let released = await refusedAt(7);
  released = await engine.execute(worker, 'release', released.id, { epoch: 7 }, id());
  await assertClosed(released, 7, 'release');
  let submitted = await refusedAt(7);
  submitted = await engine.execute(worker, 'submit', submitted.id, { epoch: 7, pr: 597_001 }, id());
  assert.equal(submitted.scopeRequest ?? null, null);
  assert.equal(submitted.blocker, null);
  assert.equal((await events(submitted, 'scope.closed'))[0].payload.details.by, 'submit');

  // A live attempt keeps its request: only an ended one is closed.
  const live = await refusedAt(7);
  const renewed = await engine.execute(worker, 'heartbeat', live.id, { epoch: 7 }, id());
  assert.equal(renewed.scopeRequest!.epoch, 7);
  assert.ok(renewed.blocker!.startsWith(scopeRefusalBlocker));
});

test('unit:unblock-closes-stale-scope-request — `master unblock` closes a refused scope request whose attempt has ended, naming it in the history', async () => {
  // The state GY-402 was found in: the attempt ended long ago, and the refusal still stands.
  let work = await refusedAt(7);
  work = await overwrite(work, document => { document.lease = null; });
  assert.equal(work.scopeRequest!.decision!.state, 'refused');
  work = await engine.execute(human, 'unblock', work.id, { reason: 'The refused request belongs to an attempt that ended', expectedRevision: work.revision }, id());
  await assertClosed(work, 7, 'unblock');
  const [unblock] = await events(work, 'unblock');
  assert.deepEqual({ epoch: unblock.payload.details.closedScopeRequest.epoch, paths: unblock.payload.details.closedScopeRequest.paths, reason: unblock.payload.details.closedScopeRequest.reason },
    { epoch: 7, paths: ['tests/auto-dispatch.test.ts'], reason: 'attempt ended' }, 'the unblock names the request it closed');
  work = await engine.execute(worker, 'claim', work.id, {}, id());
  assert.equal(work.epoch, 8);

  // Unblocking an item whose asking attempt is still live leaves that attempt's request open.
  let live = await refusedAt(7);
  live = await engine.execute(human, 'unblock', live.id, { reason: 'Cleared while the worker works', expectedRevision: live.revision }, id());
  assert.equal(live.scopeRequest!.epoch, 7);
  assert.equal((await events(live, 'unblock'))[0].payload.details.closedScopeRequest, undefined);
});
