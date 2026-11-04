import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { decisionWork } from '../src/store/decision-read.js';
import { resourceConflicts } from '../src/coordination.js';
import type { Work, Principal } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

let database: EmbeddedPostgres, store: Store, engine: Engine;
const worker: Principal = { id: 'peer-worker', role: 'worker' };
const at = new Date().toISOString();
function item(n: number): Work {
  return { id: randomUUID(), key: `GY-${n}`, title: `Item ${n}`, description: '', type: 'chore', priority: 2,
    dependencies: [], exclusiveResources: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:decision-reads-peers'] }],
    policy: { checks: [], review: false }, stage: 'build', ready: true, epoch: 0, revision: 1, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, scenarioRequirements: [], lease: null, workspaces: [], candidate: null, submission: null,
    reworkRequested: false, evidence: [], observation: null, blocker: null, gates: [], violations: [] } as Work;
}
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 3035;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('decision-peers'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('decision_peers');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/decision_peers`);
  await store.init(); engine = new Engine(store, 120, 'owner/project');
});
after(async () => { await store?.close(); await database?.stop(); });

test('unit:decision-reads-peers — a cold claim, submission and evaluation on 2,000 items read only focus and prerequisite documents under the item lock', async () => {
  const board = Array.from({ length: 2000 }, (_, n) => item(n + 1));
  const [focus, dependency, resource] = board;
  dependency.stage = 'done'; focus.dependencies = [dependency.id];
  focus.exclusiveResources = resource.exclusiveResources = ['deploy'];
  resource.lease = { owner: 'other', epoch: 1, expiresAt: '2000-01-01T00:00:00.000Z' };
  for (let n = 0; n < board.length; n += 100) await store.pool.query(`INSERT INTO work_items(id,document)
    SELECT (d->>'id')::uuid, d FROM jsonb_array_elements($1::jsonb) d`, [JSON.stringify(board.slice(n, n + 100))]);
  const original = store.transaction.bind(store);
  const readIds: string[] = [], locks: unknown[] = [];
  store.transaction = (async (fn: any, options: any) => {
    locks.push(options?.itemLock);
    return original(async (db, now) => {
      const counted = new Proxy(db, { get(target, property) {
        if (property !== 'query') return Reflect.get(target, property, target);
        return async (...args: any[]) => {
          const result = await (target.query as any)(...args);
          for (const row of result.rows) {
            if (row.document) readIds.push(row.document.id);
            // Count the previous reader's SQL-built projections too; a warmed cache cannot hide them.
            if (row.text) readIds.push(JSON.parse(row.text).id);
          }
          return result;
        };
      } });
      return fn(counted, now);
    }, options);
  }) as typeof store.transaction;
  const assertReads = () => {
    assert.deepEqual([...new Set(readIds)].sort(), [focus.id, dependency.id].sort());
    assert.ok(readIds.length <= 4, `${readIds.length} documents read`);
    assert.ok(locks.every(lock => lock === focus.id), 'each decision holds the focus item lock');
    readIds.length = 0; locks.length = 0;
  };
  try {
    const claimed = await engine.execute(worker, 'claim', focus.id, {}, randomUUID());
    assert.equal(claimed.lease?.owner, worker.id); assertReads();
    await store.pool.query(`UPDATE work_items SET document=jsonb_set(document, '{workspaces}', $2::jsonb) WHERE id=$1`, [focus.id,
      JSON.stringify([{ epoch: claimed.epoch, host: 'host', path: '/work/peer-test', branch: 'graphyard/peer-test', owner: worker.id }])]);
    const submitted = await engine.execute(worker, 'submit', focus.id, { epoch: claimed.epoch, pr: 3035 }, randomUUID()); assertReads();
    await engine.observe(focus.id, submitted.revision, {
      candidate: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 3035, branch: 'graphyard/peer-test', author: worker.id },
      checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
      files: [], scopeFiles: [], at, prState: 'open', draft: false,
    }); assertReads();
    await store.transaction(async (db, now) => {
      const peers = await decisionWork(db, [focus.id]);
      engine.evaluate(peers.find(work => work.id === focus.id)!, peers, now);
      assert.equal(peers.length, 3, 'resource holder comes from the index, not its document');
      assert.deepEqual(resourceConflicts(peers[0], peers, now.getTime()), []);
    }, { itemLock: focus.id }); assertReads();
    // A raw update must immediately change the indexed resource holder, without any cache warming.
    await store.pool.query(`UPDATE work_items SET document=jsonb_set(document, '{lease,expiresAt}', to_jsonb($2::text)) WHERE id=$1`, [resource.id, new Date(Date.now() + 60_000).toISOString()]);
    const peers = await decisionWork(store.pool, [focus.id]);
    assert.deepEqual(resourceConflicts(peers[0], peers, Date.now()), [{ resource: 'deploy', key: resource.key }]);
  } finally { store.transaction = original; }
});

test('unit:decision-reads-peers — bootstrap issuers and proof deliveries remain visible without a dependency edge', async () => {
  const issuer = item(2001), focus = item(2002), delivery = item(2003);
  issuer.criteria[0] = { id: 'AC-1', text: 'Deferred contract', proofs: ['unit:deferred-contract'], bootstrap: {
    reason: 'Introduces harness', contractPaths: ['src/contract.ts'], declaredBy: 'operator', declaredAt: at, policyRevision: 1,
  } };
  focus.observation = { files: ['src/contract.ts'] } as Work['observation'];
  delivery.stage = 'done'; delivery.candidate = { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 4000 } as Work['candidate'];
  delivery.evidence = [{ id: randomUUID(), proof: 'unit:deferred-contract', sha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
    policyRevision: 1, producer: 'ci', trusted: true, result: 'pass', executed: 1, skipped: 0, at }];
  for (const work of [issuer, focus]) await store.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [work.id, JSON.stringify(work)]);
  const { inheritedObligations } = await import('../src/model/bootstrap.js');
  let peers = await decisionWork(store.pool, [focus.id]);
  assert.deepEqual(inheritedObligations(focus, peers).map(obligation => obligation.proof), ['unit:deferred-contract']);
  await store.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [delivery.id, JSON.stringify(delivery)]);
  peers = await decisionWork(store.pool, [focus.id]);
  assert.deepEqual(new Set(peers.map(work => work.id)), new Set([focus.id, issuer.id, delivery.id]));
  assert.deepEqual(inheritedObligations(focus, peers), [], 'a proven delivery discharges the obligation');
});

test('unit:decision-reads-peers — unfinished prerequisites and an already-linked PR still refuse decisions', async () => {
  const dependency = item(2004), focus = item(2005), owner = item(2006);
  focus.dependencies = [dependency.id]; owner.submission = { epoch: 1, pr: 5000 };
  for (const work of [dependency, focus, owner]) await store.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [work.id, JSON.stringify(work)]);
  await assert.rejects(engine.execute(worker, 'claim', focus.id, {}, randomUUID()), /Unfinished dependencies/);
  await store.pool.query(`UPDATE work_items SET document=jsonb_set(document, '{stage}', '"done"') WHERE id=$1`, [dependency.id]);
  const claimed = await engine.execute(worker, 'claim', focus.id, {}, randomUUID());
  await store.pool.query(`UPDATE work_items SET document=jsonb_set(document, '{workspaces}', $2::jsonb) WHERE id=$1`, [focus.id,
    JSON.stringify([{ epoch: claimed.epoch, host: 'host', path: '/work/other-test', branch: 'graphyard/other-test', owner: worker.id }])]);
  await assert.rejects(engine.execute(worker, 'submit', focus.id, { epoch: claimed.epoch, pr: 5000 }, randomUUID()), /already linked/);
});
