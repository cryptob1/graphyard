import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withDatabase } from './helpers/postgres.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Observation, Principal, Work } from '../src/model.js';

// Every fixture item carries an E2E proof and declares the serve its trial needs.
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });
import { fixtureMergeSha, mergeDelivered, mergeIntent } from './helpers/merge-ledger.js';

/**
 * GY-3005 AC-1: delivery is recorded only by the merge writer's record. The unit:merge-ledger
 * proof records intent, push and reconcile for the item's submitted head through the plane's own
 * merge-record handler and observes the item done with one delivery; and no direct-merge module,
 * route or command remains anywhere under src/ for the record to stand beside.
 */

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'agent-a', role: 'worker', runtime: 'claude' };
const executor: Principal = { id: 'executor-a', role: 'coordinator' };
const head = 'a'.repeat(40), base = 'b'.repeat(40);

let store: Store, engine: Engine;
const queries: string[] = [];
before(async () => {
  // Stay inside the runner's reserved 200-port window, so concurrent trials cannot collide.

  store = await withDatabase('merge-ledger-delivery');
  store.pool.on('connect', client => {
    const target = client as { query: (...args: any[]) => any };
    const query = target.query.bind(client);
    target.query = (...args: any[]) => {
      if (typeof args[0] === 'string') queries.push(args[0]);
      return query(...args);
    };
  });
  await store.init();
  engine = new Engine(store, 120, 'owner/project');
  engine.principals = [operator, worker, executor];
});
after(async () => { if (store) await store.close(); });

let sequence = 0;
async function submitted() {
  let item = await engine.execute(operator, 'create', null, { type: 'chore', title: `Ledger delivery ${++sequence}`, criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['unit:merge-ledger', 'e2e:fixture'] }] }, randomUUID());
  item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
  item = await engine.execute(worker, 'claim', item.id, {}, randomUUID());
  item = await engine.execute(worker, 'workspace', item.id, { epoch: item.epoch, host: 'machine-a', path: `/tmp/merge-ledger/${item.id}`, branch: `graphyard/${item.key.toLowerCase()}-${item.epoch}` }, randomUUID());
  item = await engine.execute(worker, 'submit', item.id, { epoch: item.epoch, pr: Number(item.key.slice(3)) }, randomUUID());
  return item;
}
function observation(item: Work): Observation {
  return {
    clockOffset: { min: 0, max: 0 },
    candidate: { sha: head, baseSha: base, pr: item.submission!.pr, branch: item.workspaces.at(-1)!.branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, files: ['src/app.ts'], scopeFiles: [],
    at: new Date().toISOString(), prState: 'open',
  };
}

test('unit:merge-ledger — the merge writer\'s record is the one delivery: recording intent, push and reconcile for the item\'s submitted head leaves it done with one delivery', async () => {
  // An observed submitted candidate, as the merge writer finds it.
  const created = await submitted();
  let work = await engine.observe(created.id, created.revision, observation(created));
  assert.equal(work.candidate?.sha, head, 'the observed candidate is the head the record names');

  // Even a historical observer reporting a merge cannot deliver outside the writer's ledger.
  work = await engine.observe(work.id, work.revision, { ...observation(work), merged: true, mergeSha: fixtureMergeSha(work), mergedAt: new Date().toISOString() });
  assert.notEqual(work.stage, 'done', 'an observation alone does not deliver');
  assert.equal(work.delivery, undefined);
  assert.deepEqual(work.violations, [], 'observations no longer judge merge authorization');

  // The writer's intent opens the ledger; the item is not delivered by it.
  work = await mergeIntent(engine, work);
  assert.equal(work.mergeLedger?.state, 'intent');
  assert.notEqual(work.stage, 'done', 'an intent does not deliver');

  // The push and the reconciliation deliver it: done, with one delivery.
  work = await mergeDelivered(engine, work);
  assert.equal(work.stage, 'done', 'the reconciliation delivers');
  assert.equal(work.mergeLedger?.state, 'reconciled');
  assert.equal(work.delivery?.mergeSha, fixtureMergeSha(work), 'the delivery names the merge commit the ledger intended');
  assert.equal(work.observation?.merged, true, 'the observation reads merged');
  const delivered = Number((await store.pool.query(`SELECT count(*) AS n FROM events WHERE work_id=$1 AND kind='merge-writer.delivered'`, [work.id])).rows[0].n);
  assert.equal(delivered, 1, 'exactly one delivery is recorded');
  const jobs = Number((await store.pool.query('SELECT count(*) AS n FROM jobs WHERE work_id=$1', [work.id])).rows[0].n);
  assert.equal(jobs, 0, 'nothing retries against the delivery');
});

test('unit:five-step-cycle — reconciliation never reads retired merge windows on cold or repeated passes', async () => {
  const fresh = new Engine(store, 120, 'owner/project');
  queries.length = 0;
  await fresh.reconcile();
  const item = await submitted();
  await fresh.observe(item.id, item.revision, observation(item));
  await fresh.reconcile();
  await fresh.reconcile();
  assert.ok(queries.length > 0, 'the passes reached the database');
  assert.deepEqual(queries.filter(sql => sql.includes('direct-merge')), [], 'no merge-window ledger read');
});

test('unit:revert-survives-reinstall — coordinator revert outcomes append history transactionally without redelivering the item', async () => {
  const { recordMergeEvent } = await import('../src/server/merge-record.js');
  const { mergeRecordKey } = await import('../src/merge-writer/executor.js');
  const created = await submitted();
  let work = await engine.observe(created.id, created.revision, observation(created));
  work = await mergeDelivered(engine, work);
  const services = { engine } as unknown as import('../src/server/routes.js').Services;
  const refused = { kind: 'serve-revert' as const, serve: head, mergeSha: work.delivery!.mergeSha,
    outcome: 'refused' as const, revertSha: null, reason: 'revert trial failed', reland: null,
    failingCase: 'fixture', failingStep: null, failingReason: '404', at: new Date().toISOString() };
  await assert.rejects(recordMergeEvent(services, worker, work.id, refused, randomUUID()), /coordinator identity/);
  await assert.rejects(recordMergeEvent(services, executor, work.id, { ...refused, mergeSha: base }, randomUUID()), /delivered merge/);
  await recordMergeEvent(services, executor, work.id, refused, mergeRecordKey(work, refused));
  assert.equal((await store.workItem(work.id))!.mergeLedger!.serveReverts![0]!.reason, refused.reason);
  const reverted = { ...refused, outcome: 'reverted' as const, revertSha: 'c'.repeat(40), reason: null };
  engine.gitRunner = async () => ({ status: 1, stdout: '', stderr: '' });
  await assert.rejects(recordMergeEvent(services, executor, work.id, reverted, randomUUID()), /must hold/);
  engine.gitRunner = async () => ({ status: 0, stdout: '', stderr: '' });
  await recordMergeEvent(services, executor, work.id, reverted, mergeRecordKey(work, reverted));
  await recordMergeEvent(services, executor, work.id, reverted, mergeRecordKey(work, reverted));
  const reland = { ...reverted, reland: 'GY-9000' };
  await recordMergeEvent(services, executor, work.id, reland, mergeRecordKey(work, reland));
  const stored = (await store.workItem(work.id))!;
  assert.equal(stored.stage, 'done');
  assert.deepEqual(stored.delivery, work.delivery);
  const { kind: _kind, ...expected } = reland;
  assert.deepEqual(stored.mergeLedger!.serveReverts, [expected]);
  const rows = (await store.pool.query("SELECT payload FROM events WHERE work_id=$1 AND kind='merge.serve-revert' ORDER BY seq", [work.id])).rows;
  assert.equal(rows.length, 3, 'refusal, revert, re-land; receipt replay adds no row');
  assert.equal(rows[0].payload.reason, 'revert trial failed');
});
