import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withDatabase } from './helpers/postgres.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { dispatchable } from '../src/coordination.js';
import { plainStatus } from '../src/model/plain-status.js';
import type { Principal, Work } from '../src/model.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// GY-3510: an item whose workers keep dying at startup stops being dispatched after three
// consecutive short expired claims, with one blocker naming the last worker's exit reason.
const human: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'engineer-a', role: 'worker', sessionKind: 'ai' };
let store: Store, engine: Engine;
const id = () => randomUUID();
const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
const minutes = (n: number) => n * 60_000;

before(async () => {
  store = await withDatabase('expiry-loop-stop'); await store.init();
  engine = new Engine(store, 120, 'owner/project');
  engine.principals = [human, worker];
});
after(async () => { if (store) await store.close(); });

async function filed(title: string) {
  const work = await engine.execute(human, 'create', null, { title, type: 'chore', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works', 'e2e:fixture'] }] }, id());
  return engine.execute(human, 'ready', work.id, {}, id());
}
/**
 * One claim whose worker died `lasted` after claiming: the stored attempt and lease are moved back
 * so the lease lapsed at `lasted` past the claim, and the loop's finished session handle carries
 * the worker's exit reason. Reconciliation then ends the attempt as expired.
 */
async function diedAfter(work: Work, lasted: number, exit: string) {
  const claimed = await engine.execute(worker, 'claim', work.id, {}, id());
  const document = await reload(claimed);
  const claimedAt = new Date(Date.now() - lasted - 1000);
  document.pipeline!.attempts.at(-1)!.claimedAt = claimedAt.toISOString();
  document.lease = { ...document.lease!, expiresAt: new Date(claimedAt.getTime() + lasted).toISOString() };
  document.sessions = [...document.sessions ?? [], { id: `${worker.id}:${claimed.epoch}`, kind: 'implementation', principal: worker.id, epoch: claimed.epoch, runtime: 'claude', host: 'h', workspace: null, tab: null, pane: null, agentName: null, role: 'implementation', head: null,
    attach: null, transcript: null, subject: work.key, startedAt: claimedAt.toISOString(), updatedAt: claimedAt.toISOString(), endedAt: claimedAt.toISOString(), state: 'finished', outcome: exit }];
  await store.pool.query('UPDATE work_items SET document=$2::jsonb WHERE id=$1', [document.id, JSON.stringify(document)]);
  await engine.reconcile();
  return reload(work);
}

test('integration:expiry-loop-stop: three consecutive claims expiring within 5 minutes stop dispatch with one blocker naming the last exit reason', async () => {
  // Two short deaths, then a submitted attempt: the count resets, so two more deaths do not stop it.
  let reset = await filed('reset-by-submission');
  reset = await diedAfter(reset, minutes(2), 'exit 1');
  reset = await diedAfter(reset, minutes(2), 'exit 1');
  // A claim that ended submitted, as `recordSubmission` ends it.
  const submitted = await reload(await engine.execute(worker, 'claim', reset.id, {}, id()));
  Object.assign(submitted.pipeline!.attempts.at(-1)!, { end: 'submitted', endedAt: new Date().toISOString() });
  submitted.lease = null;
  await store.pool.query('UPDATE work_items SET document=$2::jsonb WHERE id=$1', [submitted.id, JSON.stringify(submitted)]);
  reset = await diedAfter(await reload(reset), minutes(2), 'exit 1');
  reset = await diedAfter(reset, minutes(2), 'exit 1');
  assert.equal(reset.blocker, null, 'a submitted claim resets the count');

  // Two short deaths, then one that ran longer than 5 minutes: the count resets.
  let long = await filed('reset-by-long-attempt');
  long = await diedAfter(long, minutes(2), 'exit 1');
  long = await diedAfter(long, minutes(2), 'exit 1');
  long = await diedAfter(long, minutes(6), 'exit 1');
  long = await diedAfter(long, minutes(2), 'exit 1');
  long = await diedAfter(long, minutes(2), 'exit 1');
  assert.equal(long.blocker, null, 'a claim that lasted longer than 5 minutes resets the count');
  assert.equal(dispatchable(long, Date.now()), true);

  // Three short deaths in a row: dispatch stops and one blocker names the last exit reason.
  let dying = await filed('dies-at-startup');
  const other = await filed('unaffected-neighbour');
  dying = await diedAfter(dying, minutes(2), 'the runtime exited: no credentials');
  dying = await diedAfter(dying, minutes(1), 'the runtime exited: no credentials');
  assert.equal(dying.blocker, null, 'two deaths do not stop it');
  dying = await diedAfter(dying, minutes(2), 'claude exited with code 1: Invalid API key');
  assert.equal(dying.blocker, 'Workers keep failing to start: claude exited with code 1: Invalid API key');
  assert.ok(dying.blockedAt, 'the block is timed');
  assert.equal(dispatchable(dying, Date.now()), false, 'dispatch stops for the item');
  await assert.rejects(engine.execute(worker, 'claim', dying.id, {}, id()), /blocker/);
  assert.equal(plainStatus(dying, Date.now()).sentence, 'Stuck: Workers keep failing to start: claude exited with code 1: Invalid API key');
  await engine.reconcile();
  assert.equal((await reload(dying)).blocker, dying.blocker, 'recorded once');

  // Other items are unaffected.
  const neighbour = await reload(other);
  assert.equal(neighbour.blocker, null);
  assert.equal(dispatchable(neighbour, Date.now()), true);
});
