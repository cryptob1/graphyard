import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';
import { submittedBranchMoved } from '../src/model/assignment.js';
import { submittedBranchRefusal } from '../src/master/worktrees.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1286 names this file, beside tests/loop-faults.test.ts, for its proof: manual:fault-class-loop.
// The instance it replays needs the control plane's own store, so it runs against a real Postgres.
//
// - loop-silence on GY-1234 (2026-10-05T08:35:58.217Z): nothing acted for 31 minutes on a claimable
//   rework. A docs-sync session had pushed its branch, so every dispatch's worktree command refused
//   the rework workspace — the PR branch no longer held the head Graphyard last observed — and
//   released the claim as a workspace failure, six times from 08:08 to 08:35. Each refusal waited
//   for an observation that nothing asked for: the release woke no observation job, so the reading
//   sat in the polled backlog while the dispatch backed off and failed again. The release that
//   carries this refusal now wakes the item's observation job ahead of the backlog, as a webhook does.

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'agent-a', role: 'worker', runtime: 'claude' };
const coordinator: Principal = { id: 'coordinator-a', role: 'coordinator' };
const instance = { id: 'loop-silence|GY-1234|2026-10-05T08:35:58.217Z', kind: 'loop-silence', subject: 'GY-1234' };

let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  // An offset no other file takes: two files sharing a port fail whichever starts second.
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1286;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('dispatch-wake'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.submissionObserver = null;
  engine.principals = [operator, worker, coordinator];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

let sequence = 0;
/** A submitted item sent back for rework and claimed again: the claim a rework dispatch makes. */
async function reworkClaim(): Promise<Work> {
  let item = await engine.execute(operator, 'create', null, { title: `Rework ${++sequence}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }] }, randomUUID());
  item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
  item = await engine.execute(worker, 'claim', item.id, {}, randomUUID());
  item = await engine.execute(worker, 'workspace', item.id, { epoch: item.epoch, host: 'machine-a', path: `/tmp/rework/${item.id}`, branch: `graphyard/${item.key.toLowerCase()}-${item.epoch}` }, randomUUID());
  item = await engine.execute(worker, 'submit', item.id, { epoch: item.epoch, pr: 700 + sequence }, randomUUID());
  item = await engine.execute(operator, 'rework', item.id, { reason: 'conflict with the moved base', previousWorkerStopped: true }, randomUUID());
  return engine.execute(worker, 'claim', item.id, {}, randomUUID());
}
/** The observation job as the queue holds it: due now, and claimed ahead of the polled backlog. */
async function job(work: Work) {
  const row = (await store.pool.query('SELECT available_at <= now() AS due, webhook_at IS NOT NULL AS prioritized FROM jobs WHERE work_id=$1', [work.id])).rows[0];
  return row ? { due: row.due as boolean, prioritized: row.prioritized as boolean } : null;
}
/** The backlog as it stood: the item's job scheduled for later, unprioritized. */
const backlogged = (work: Work) => store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour', webhook_at=NULL WHERE work_id=$1", [work.id]);

test(`manual:fault-class-loop — ${instance.id}: the worktree command's refusal is the one the release recognizes`, async () => {
  // The refusal the six dispatches recorded, produced by the worktree command's own check: the
  // remote PR branch is fetched and no longer holds the observed candidate head.
  const run = (async (_command: string, args: string[]) => args[0] === 'rev-parse' ? `${'d'.repeat(40)}\n` : '') as never;
  const refused = await submittedBranchRefusal('/checkout', 'graphyard/gy-1234-4', 'refs/remotes/origin/graphyard/gy-1234-4', 'a'.repeat(40), run);
  assert.equal(refused, submittedBranchMoved);
  assert.match(refused!, /^Submitted PR branch changed; wait for Graphyard to observe its current head/);
});

test(`manual:fault-class-loop — ${instance.id}: a rework dispatch refused because its PR branch moved wakes the item's observation, prioritized, so the next dispatch is not refused again`, async () => {
  const claimed = await reworkClaim();
  assert.ok(claimed.submission && claimed.reworkRequested, 'a rework claim of a submitted item');
  await backlogged(claimed);
  assert.deepEqual(await job(claimed), { due: false, prioritized: false });
  const released = await engine.execute(worker, 'release', claimed.id, { epoch: claimed.epoch, failure: { message: submittedBranchMoved } }, randomUUID());
  assert.equal(released.lease, null, 'the claim is released as a workspace failure');
  assert.equal(released.epoch, claimed.epoch - 1, 'the attempt costs nothing');
  assert.deepEqual(await job(claimed), { due: true, prioritized: true }, 'the reading the next dispatch needs is asked for at once, ahead of the polled backlog');
});

test(`manual:fault-class-loop — ${instance.id}: any other workspace failure, and an ordinary release, leave the observation job as it was`, async () => {
  const other = await reworkClaim();
  await backlogged(other);
  await engine.execute(worker, 'release', other.id, { epoch: other.epoch, failure: { message: "Git worktree creation failed: fatal: 'graphyard/x' is already used by worktree" } }, randomUUID());
  assert.deepEqual(await job(other), { due: false, prioritized: false }, 'a host-side git failure is no stale observation');
  const plain = await reworkClaim();
  await backlogged(plain);
  await engine.execute(worker, 'release', plain.id, { epoch: plain.epoch }, randomUUID());
  assert.deepEqual(await job(plain), { due: false, prioritized: false });
});

// The loop-cost instance (loop-cost|loop|2026-10-05T08:21:38.779Z) on the server's side: the loop's
// observation wake asks for no reconcile tick, so the route answers once the job is woken.
test('manual:fault-class-loop — loop-cost|loop|2026-10-05T08:21:38.779Z: a resync with wait: false wakes the observation job, prioritized, and waits on no reconcile tick; without it the route still waits', async () => {
  const claimed = await reworkClaim();
  await engine.execute(worker, 'release', claimed.id, { epoch: claimed.epoch }, randomUUID());
  const ticks: string[] = [];
  const reconcile = engine.reconcile.bind(engine);
  engine.reconcile = (async () => { ticks.push('tick'); }) as typeof engine.reconcile;
  try {
    await backlogged(claimed);
    const woken = await engine.resyncWork(coordinator, claimed.id, { prioritized: true, wait: false });
    assert.equal(woken.observationScheduled, true);
    assert.deepEqual(ticks, [], 'no tick is waited on');
    assert.deepEqual(await job(claimed), { due: true, prioritized: true });
    await engine.resyncWork(coordinator, claimed.id, { prioritized: true });
    assert.deepEqual(ticks, ['tick'], 'an executor\'s resync still waits for the tick that serves it');
  } finally { engine.reconcile = reconcile; }
});
