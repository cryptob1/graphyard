import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store, save } from '../src/store.js';
import { Engine, sameBesideBookkeeping } from '../src/engine.js';
import type { Observation, Principal, Work } from '../src/model.js';
import type { ActionRow } from '../src/model/actions.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-607: an executor claiming an item's `resync` row saved the item, so the GitHub observation
 * taken meanwhile failed its revision check and was discarded; the item stayed stale, the next
 * action was `resync` again, and the executor claimed it again — a livelock between the action and
 * the observation it waits for.
 *
 * unit:action-claim-keeps-observation — claiming, renewing and settling a row between an
 * observation's read and its save leaves the observation saved; any other change still refuses it.
 * unit:waked-observation-survives-loop-bookkeeping — GY-1257: the loop's own per-cycle writes (a
 * session it reports, the next action and gates each save re-derives or raises)
 * between a woken observation's read and its save leave the observation saved; a change to the
 * submitted work still refuses it.
 * unit:observation-saved-on-revision-change — GY-1310: any save between an observation's read and
 * its save that leaves everything the observation was derived from unchanged (here a retitle and a
 * priority change, neither bookkeeping) leaves the observation saved; a moved submission, candidate, observation, policy or workspace still refuses it.
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
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('claim-observation'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, 120, 'owner/project');
  engine.principals = [operator, worker, executor];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const reload = async (id: string) => (await store.list()).find(entry => entry.id === id)!;
const resyncRow = (item: Work) => item.actionQueue!.actions.find(row => row.kind === 'resync')!;

let sequence = 0;
async function submitted() {
  let item = await engine.execute(operator, 'create', null, { title: `Resync ${++sequence}`, criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }] }, randomUUID());
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

test('unit:waked-observation-survives-loop-bookkeeping — the loop\'s own bookkeeping saved between an observation\'s read and its save does not discard the observation', async () => {
  const item = await submitted();
  // The observation job reads the item...
  const read = await reload(item.id);
  // ...the loop records the approver session it launched for the item, twice (launch, then its report)...
  const handle = { id: `approver:${randomUUID()}`, kind: 'coordination', runtime: 'claude', host: 'machine-a', role: 'approver', subject: `${item.key}: judge a rework decision`, state: 'running' };
  await engine.execute(executor, 'session', item.id, handle, randomUUID());
  await engine.execute(executor, 'session', item.id, { ...handle, observed: 'working', observedAt: new Date().toISOString() }, randomUUID());
  const moved = await reload(item.id);
  assert.ok(moved.revision > read.revision, 'the loop\'s session writes saved the item');
  // ...and the observation the loop woke is saved, not rescheduled as "Task changed while GitHub was being observed; retry".
  const taken = observation(read);
  const observed = await engine.observe(item.id, read.revision, taken);
  assert.equal(observed.observation?.at, taken.at, 'the woken observation lands');
  assert.ok((await reload(item.id)).sessions?.some(entry => entry.id === handle.id), 'the session the loop wrote meanwhile is kept');

  // Next action and gates are bookkeeping too; the submitted work is not.
  const bookkeeping = { ...moved, revision: moved.revision + 1, nextAction: null, gates: [] } as unknown as Work;
  assert.ok(sameBesideBookkeeping(moved, bookkeeping), 'next action, gates and attention are the loop\'s bookkeeping');
  assert.ok(!sameBesideBookkeeping(moved, { ...moved, submission: { epoch: moved.submission!.epoch, pr: moved.submission!.pr + 1 } }), 'a moved submission is not');
  assert.ok(!sameBesideBookkeeping(moved, { ...moved, candidate: { ...moved.candidate!, sha: 'f'.repeat(40) } } as Work), 'a moved candidate is not');
  // Any change to the work itself still refuses: the observation saved above moved the item.
  await assert.rejects(engine.observe(item.id, read.revision, observation(read)), /Task changed while GitHub was being observed; retry/);
});

test('unit:observation-saved-on-revision-change — a save that moved nothing the observation read leaves the poll saved, newer than the resync claimed meanwhile', async () => {
  // Imported here, so a checkout without the module fails this case rather than the whole file.
  const { sameObservationInputs } = await import('../src/model/observation-save.js');
  const item = await submitted();
  await store.pool.query("UPDATE jobs SET available_at=now() + interval '1 hour' WHERE work_id=$1", [item.id]);
  // The observation job reads the item...
  const read = await reload(item.id);
  // ...an executor claims the item's resync row, and another writer saves the item twice with
  // changes that are not the loop's bookkeeping and that the observation never read.
  const claimed = await claimResync(item.id);
  for (const change of [(work: Work) => { work.title = `${work.title} (retitled)`; }, (work: Work) => { work.priority = 0; }]) await store.transaction(async db => {
    const current: Work = (await db.query('SELECT document FROM work_items WHERE id=$1 FOR UPDATE', [item.id])).rows[0].document;
    change(current);
    await save(db, current, operator.id, 'test.unrelated', new Date());
  });
  const moved = await reload(item.id);
  assert.ok(moved.revision > read.revision + 1, 'the claim and the unrelated writes saved the item');
  assert.ok(!sameBesideBookkeeping(read, moved), 'the moves are not bookkeeping: before GY-1310 the poll was discarded');
  // ...and the poll that read the item before them is saved, not rescheduled.
  const taken = observation(read);
  const observed = await engine.observe(item.id, read.revision, taken);
  assert.equal(observed.observation?.at, taken.at, 'the observation is saved');
  const after = await reload(item.id);
  assert.equal(after.title, moved.title, 'the unrelated write is kept, not overwritten by the read');
  assert.equal(after.priority, 0);
  assert.ok(Date.parse(taken.at) > Date.parse(claimed.claim!.claimedAt), 'the saved observation is newer than the claim made meanwhile');

  // What the observation was derived from still refuses it when it moved.
  const inputs: [string, (work: Work) => void][] = [
    ['submission', work => { work.submission = { ...work.submission!, pr: work.submission!.pr + 1 }; }],
    ['candidate', work => { work.candidate = { ...work.candidate!, sha: 'f'.repeat(40) }; }],
    ['observation', work => { work.observation = { ...work.observation!, at: new Date(Date.parse(work.observation!.at) + 1).toISOString() }; }],
    ['policy', work => { work.policyRevision += 1; }],
    ['workspace', work => { work.workspaces = [...work.workspaces, { ...work.workspaces.at(-1)!, branch: 'graphyard/other' }]; }],
  ];
  for (const [name, change] of inputs) { const next = structuredClone(after); change(next); assert.ok(!sameObservationInputs(after, next), `a moved ${name} refuses the observation`); }
  const unrelated = structuredClone(after); unrelated.title = 'retitled again'; unrelated.priority = 3; unrelated.sessions = [];
  assert.ok(sameObservationInputs(after, unrelated), 'a title, priority or session move does not');
  // The saved observation itself moved the item, so the same read is refused now.
  await assert.rejects(engine.observe(item.id, read.revision, observation(read)), /Task changed while GitHub was being observed; retry/);
});
