import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from './helpers/warm-postgres.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Observation, Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

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

let database: EmbeddedPostgres, store: Store, engine: Engine;
const queries: string[] = [];
before(async () => {
  // Stay inside the runner's reserved 200-port window, so concurrent trials cannot collide.
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 197;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('merge-ledger-delivery'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`);
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
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

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
