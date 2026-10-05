import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import * as mergeQueue from '../src/merge-queue.js';
import * as githubModule from '../src/github.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { evaluate, retiredQueueFields, type Principal, type Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1236. GitHub merges each passing candidate directly, so Graphyard's own merge queue — its
// speculative tips, batches, parallel-tip window, ejections and branch restores — is gone. An item
// stored with the queue's fields still loads, and no document is written with them again.

const root = new URL('../', import.meta.url);

test('unit:merge-queue-removed — src/model/queue.ts is deleted and no queue, tip, batch, ejection or restore code remains in merge-queue.ts, github.ts or the engine', async () => {
  assert.equal(existsSync(new URL('src/model/queue.ts', root)), false, 'src/model/queue.ts is deleted');
  for (const name of ['queueRef', 'predictQueue', 'queuePlacement', 'queueOrder', 'nextQueueSequence', 'tipValidation', 'tipReplacesHead', 'treeIdenticalPrediction', 'keptTipCarry',
    'decideIdentityCarry', 'ejectionReason', 'ejectingCheck', 'ejectedCheckLift', 'standingMergeRefusal', 'ejectedTipRestore', 'pendingRestore', 'currentRestore', 'branchContamination',
    'restoringAfterEjection', 'staleSpeculativeTip', 'predecessorWait', 'speculativeConflict', 'batchStep', 'planMergeBatch', 'runMergeBatches', 'describeMergeBatches', 'queueBatch',
    'describeTipWindow', 'tipWindowStatus', 'windowBatchView', 'mergeQueueInsights', 'nextQueueEntries', 'defaultMergeBatchSize', 'defaultParallelTips', 'queueSequencingReason'])
    assert.equal(name in mergeQueue, false, `merge-queue.ts no longer exports ${name}`);
  for (const name of ['queuedAhead', 'mergeBandQueueDepth', 'mergeBatchSizeRefreshMs']) assert.equal(name in githubModule, false, `github.ts no longer exports ${name}`);
  for (const method of ['publishSpeculativeTip', 'restoreBranch', 'ownReviewedHead', 'tipDocs'])
    assert.equal(method in githubModule.GitHub.prototype, false, `GitHub.${method} is deleted`);
  for (const method of ['bindSpeculativeTip', 'ejectFromQueue', 'bindBranchRestore', 'loadMergeBatchSize', 'loadParallelTips'])
    assert.equal(method in Engine.prototype, false, `Engine.${method} is deleted`);
  // Nothing in the control plane reads or writes a queue entry, a tip or an ejection any more.
  const sources = async (directory: URL): Promise<string[]> => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory()
    ? sources(new URL(`${entry.name}/`, directory)) : Promise.resolve(entry.name.endsWith('.ts') ? [new URL(entry.name, directory).pathname] : [])))).flat();
  for (const file of await sources(new URL('src/', root))) {
    const text = await readFile(file, 'utf8');
    assert.doesNotMatch(text, /\bwork\.(queue|queueEjection|queueHistory|queueSequence)\b/, `${file} reads no merge-queue field of a work item`);
    assert.doesNotMatch(text, /refs\/graphyard\/queue\/\$\{/, `${file} publishes no speculative tip ref`);
  }
});

test('unit:merge-queue-removed — evaluation returns no queue fields, whatever the stored item carried', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  const legacy = { id: randomUUID(), key: 'GY-9', title: 'Queued before GY-1236', ready: true, dependencies: [], priority: 2, plannedFiles: ['src/a.ts'], criteria: [],
    policy: { review: true, checks: ['test'] }, policyRevision: 1, submission: null, candidate: null, observation: null, lease: null, workspaces: [], evidence: [], gates: [], violations: [],
    stage: 'ready', stageEnteredAt: now.toISOString(), reworkRequested: false, scenarioRequirements: [], blocker: null,
    queue: { sequence: 3, enqueuedAt: now.toISOString(), policyRevision: 1, speculation: null }, queueSequence: 3,
    queueEjection: { at: now.toISOString(), sequence: 2, reason: 'Required CI check test did not pass on speculative tip abc', sha: null, policyRevision: 1 },
    queueHistory: [{ at: now.toISOString(), event: 'enqueued', sequence: 3 }] } as unknown as Work;
  const result = evaluate(legacy, [legacy], now, [15368]);
  assert.deepEqual(Object.keys(result).sort(), ['gates', 'lane', 'speedTarget', 'stage', 'violations']);
  for (const field of retiredQueueFields) assert.equal(field in result, false, `evaluate returns no ${field}`);
});

let database: EmbeddedPostgres, store: Store, engine: Engine;
const operator: Principal = { id: 'operator', role: 'admin' };
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1236;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('merge-queue-removed'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [operator];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

test('unit:merge-queue-removed — an item stored with queue, queueHistory and queueEjection still loads, and its next write carries none of them', async () => {
  let work = await engine.execute(operator, 'create', null, { title: 'Queued before GY-1236', plannedFiles: ['src/a.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:a'] }] }, randomUUID());
  const fieldsOf = async (id: string) => (await store.pool.query(`SELECT ${retiredQueueFields.map(field => `document ? '${field}' AS "${field}"`).join(', ')} FROM work_items WHERE id=$1`, [id])).rows[0] as Record<string, boolean>;
  assert.deepEqual(await fieldsOf(work.id), { queue: false, queueSequence: false, queueEjection: false, queueHistory: false }, 'a new item is written without them');
  // The document as a release with the merge queue stored it.
  const at = new Date().toISOString();
  await store.pool.query(`UPDATE work_items SET document = document || $2::jsonb WHERE id=$1`, [work.id, JSON.stringify({
    queue: { sequence: 4, enqueuedAt: at, policyRevision: 1, speculation: { ref: 'refs/graphyard/queue/gy-1', tip: 'a'.repeat(40), base: 'b'.repeat(40), baseTree: 'c'.repeat(40), predecessors: [], policyRevision: 1, publishedAt: at } },
    queueSequence: 4, queueEjection: { at, sequence: 3, reason: 'Pull request was closed without merging', sha: null, policyRevision: 1 },
    queueHistory: [{ at, event: 'enqueued', sequence: 4 }, { at, event: 'ejected', sequence: 3, reason: 'Pull request was closed without merging' }] })]);
  assert.deepEqual(await fieldsOf(work.id), { queue: true, queueSequence: true, queueEjection: true, queueHistory: true });
  // It loads, as one item and in the fleet.
  const loaded = await store.workItem(work.id) as Work & Record<string, unknown>;
  assert.equal(loaded.key, work.key);
  assert.equal((loaded.queue as { sequence: number }).sequence, 4, 'the stored fields are read as they are');
  assert.ok((await store.list()).some(item => item.id === work.id));
  // A command's write drops them.
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  for (const field of retiredQueueFields) assert.equal(field in work, false, `the written item carries no ${field}`);
  assert.deepEqual(await fieldsOf(work.id), { queue: false, queueSequence: false, queueEjection: false, queueHistory: false }, 'and neither does its stored document');

  // The reconciliation tick drops them from a document no command touches, and writes none back.
  await store.pool.query(`UPDATE work_items SET document = document || $2::jsonb WHERE id=$1`, [work.id, JSON.stringify({ queue: null, queueSequence: 0, queueHistory: [] })]);
  await engine.reconcile();
  assert.deepEqual(await fieldsOf(work.id), { queue: false, queueSequence: false, queueEjection: false, queueHistory: false });
  const events = (await store.pool.query(`SELECT kind FROM events WHERE work_id=$1 AND (kind LIKE 'queue.%' OR kind LIKE 'branch.%')`, [work.id])).rows;
  assert.deepEqual(events, [], 'no queue or branch-restore event is recorded');
});
