import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Observation, Principal, Work } from '../src/model.js';
import type { ActionRow } from '../src/model/actions.js';
import { resyncUnobservedPrefix } from '../src/model/action-kinds.js';
import { controlPlaneHandlers } from '../src/executor.js';
import type { MasterConfig } from '../src/master.js';
import { stalledActionAttention } from '../src/cli/master-status.js';

/**
 * GY-607: an executor claiming an item's `resync` row saved the item, so the GitHub observation
 * taken meanwhile failed its revision check and was discarded; the item stayed stale, the next
 * action was `resync` again, and the executor claimed it again — a livelock between the action and
 * the observation it waits for.
 *
 * unit:action-claim-keeps-observation — claiming, renewing and settling a row between an
 * observation's read and its save leaves the observation saved; any other change still refuses it.
 * unit:resync-completes-on-fresh-observation — a `resync` completes only once an observation newer
 * than its claim is saved, never on a re-read that saves nothing, and three claims in a row without
 * one raise an attention item naming the item and its observation job's condition.
 */

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'agent-a', role: 'worker', runtime: 'claude' };
const executor: Principal = { id: 'executor-a', role: 'coordinator' };
const PROOF = 'unit:resync-fixture';
const head = 'a'.repeat(40), base = 'b'.repeat(40);

let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  // An offset no other file takes: two files sharing a port fail whichever starts second.
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 137;
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-claim-observation-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [operator, worker, executor];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const reload = async (id: string) => (await store.list()).find(entry => entry.id === id)!;
const resyncRow = (item: Work) => item.actionQueue!.actions.find(row => row.kind === 'resync')!;

let sequence = 0;
async function submitted() {
  let item = await engine.execute(operator, 'create', null, { title: `Resync ${++sequence}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }] }, randomUUID());
  item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
  item = await engine.execute(worker, 'claim', item.id, {}, randomUUID());
  item = await engine.execute(worker, 'workspace', item.id, { epoch: item.epoch, host: 'machine-a', path: `/tmp/resync/${item.id}`, branch: `graphyard/${item.key.toLowerCase()}-${item.epoch}` }, randomUUID());
  item = await engine.execute(worker, 'submit', item.id, { epoch: item.epoch, pr: Number(item.key.slice(3)) }, randomUUID());
  assert.equal(item.nextAction?.kind, 'resync', 'a submitted candidate nobody has observed owes a resync');
  return item;
}
function observation(item: Work): Observation {
  return {
    clockOffset: { min: 0, max: 0 },
    candidate: { sha: head, baseSha: base, pr: item.submission!.pr, branch: item.workspaces.at(-1)!.branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, files: ['src/loop.ts'], scopeFiles: [],
    at: new Date().toISOString(), prState: 'open', draft: false, baseTip: base, baseTree: 'c'.repeat(40), baseTipContained: true,
  };
}
const claimResync = async (id: string) => (await engine.claimNextAction(executor, { host: 'host-1', kinds: ['resync'], work: id }, randomUUID())).action!;
const settle = (row: ActionRow, result: 'done' | 'failed', reason: string) => engine.settleClaimedAction(executor, row.id, { result, reason }, randomUUID());
/** The handlers Graphyard ships, over the engine instead of HTTP. */
function handlers() {
  const unusable = async (): Promise<never> => { throw new Error('not reached'); };
  // A resync reads no launch configuration.
  return controlPlaneHandlers(() => ({}) as MasterConfig, {
    snapshot: async () => ({ work: await store.list(), now: new Date().toISOString() }),
    mutate: async (path, body) => { const [, id, command] = path.split('/'); assert.equal(command, 'resync'); return engine.resyncWork(executor, id, body); },
    agents: () => [], workerCredentials: async () => ({}), producerCredentials: async () => ({}),
    dispatchWorker: unusable, launchReview: unusable, launchProducer: unusable, merge: unusable, observeDeployment: unusable,
  });
}

test('unit:action-claim-keeps-observation — an action claimed, renewed and settled between an observation\'s read and its save does not discard the observation', async () => {
  const item = await submitted();
  // The observer reads the item...
  const read = await reload(item.id);
  // ...an executor claims the item's resync row, renews it and fails it, each a save of the item...
  const claimed = await claimResync(item.id);
  assert.equal(claimed.kind, 'resync');
  await engine.renewClaimedAction(executor, claimed.id, {});
  await settle(claimed, 'failed', 'a failure recorded while GitHub was being observed');
  const moved = await reload(item.id);
  assert.ok(moved.revision > read.revision, 'the claim and the settlement saved the item');
  // ...and the observation taken on the read is still saved.
  const taken = observation(read);
  const observed = await engine.observe(item.id, read.revision, taken);
  assert.equal(observed.observation?.at, taken.at, 'the observation is saved');
  assert.equal((await reload(item.id)).observation?.at, taken.at);
  assert.equal(resyncRow(moved).attempts, 1);
  const after = await reload(item.id);
  assert.ok([...after.actionQueue!.actions, ...after.actionQueue!.history].some(row => row.id === claimed.id && row.attempts === 1 && row.history.some(entry => entry.event === 'failed')),
    'the action state written meanwhile is kept, not overwritten by the read');

  // Any change beside action bookkeeping still refuses: the observation saved above moved the item.
  await assert.rejects(engine.observe(item.id, read.revision, observation(read)), /Task changed while GitHub was being observed; retry/);
});

test('unit:resync-completes-on-fresh-observation — a resync completes only on an observation newer than its claim, and three unobserved claims raise attention naming the item and its observation job', async () => {
  // Satisfied by the observation it woke, even though its own claim saved the item after the read.
  const item = await submitted();
  await store.pool.query("UPDATE jobs SET available_at=now() + interval '1 hour' WHERE work_id=$1", [item.id]);
  const read = await reload(item.id);
  const claimed = await claimResync(item.id);
  const run = handlers();
  // The claim wakes the job and returns at once (GY-646): nothing is observed yet, so the row is
  // left waiting rather than the executor waiting inside it.
  const waiting = await Promise.resolve(run.resync!(claimed, { id: executor.id, host: 'host-1' })).then(() => null, (error: Error) => error.message);
  const job = (await store.pool.query('SELECT available_at FROM jobs WHERE work_id=$1', [item.id])).rows[0];
  assert.ok(new Date(job.available_at).getTime() <= Date.now(), 'the resync woke the item\'s observation job');
  assert.match(waiting ?? '', new RegExp(`^${item.key}: ${resyncUnobservedPrefix}; `), 'the claim does not complete on its own re-read');
  await settle(claimed, 'failed', waiting!);
  // The observation the claim woke is saved after it; a later claim of the row — carrying the
  // unobserved attempt in its history — completes on it, measured from the claim that woke the job.
  const observedBy = (await engine.observe(item.id, read.revision, observation(read))).observation!.at;
  const failed = resyncRow(await reload(item.id)) ?? claimed;
  const later = new Date(Date.parse(observedBy) + 1_000).toISOString();
  const again: ActionRow = { ...failed, state: 'claimed', claim: { ...claimed.claim!, claimedAt: later }, history: [...failed.history, { at: later, event: 'claimed', requester: 'graphyard', executor: executor.id, result: null, reason: 'attempt 2' }] };
  const done = await run.resync!(again, { id: executor.id, host: 'host-1' }) as string;
  assert.match(done, new RegExp(`observed ${item.key} at ${observedBy}, after the claim at ${claimed.claim!.claimedAt}`));

  // A re-read that saves nothing never satisfies it: every claim fails, naming the job's condition.
  const stale = await submitted();
  const idle = handlers();
  let row: ActionRow | undefined;
  for (let claim = 1; claim <= 3; claim++) {
    // The row's backoff is not under test: it is due again at once.
    await store.pool.query("UPDATE work_items SET document=document #- '{actionQueue,actions,0,retryAt}' WHERE id=$1", [stale.id]);
    row = await claimResync(stale.id);
    assert.equal(row.attempts, claim);
    const refused = await Promise.resolve(idle.resync!(row, { id: executor.id, host: 'host-1' })).then(() => null, (error: Error) => error.message);
    assert.ok(refused, `claim ${claim} is not completed by a re-read that saved nothing`);
    assert.match(refused!, new RegExp(`^${stale.key}: ${resyncUnobservedPrefix}; its observation job is scheduled and records no error, yet saved no observation; the claim woke it and leaves the row waiting for the observation$`));
    await settle(row, 'failed', refused!);
    const snapshot = { work: await store.list(), now: new Date().toISOString() };
    const raised = stalledActionAttention(snapshot).filter(entry => entry.subject === stale.key);
    if (claim < 3) { assert.deepEqual(raised, [], `no attention after ${claim} unobserved claim(s)`); continue; }
    assert.equal(raised.length, 1, 'three unobserved claims raise one attention item');
    assert.match(raised[0].text, new RegExp(`^${stale.key}'s resync action is stalled`));
    assert.match(raised[0].text, /its observation job is scheduled and records no error, yet saved no observation/);
  }
  assert.equal((await reload(stale.id)).observation ?? null, null, 'nothing was observed');
});
