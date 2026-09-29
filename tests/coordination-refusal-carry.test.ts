import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { coordinationSnapshot as trimInProcess } from '../src/server/work-view.js';
import { queueRef } from '../src/merge-queue.js';
import type { Evidence, Observation, Principal, Work } from '../src/model.js';

// GY-904: when `mergerefused` ejects a queued tip the queue record goes with it, so
// `mergeRefusal.carry` is the only binding its carried proofs still have. The coordination
// snapshot's SQL relevance projection must collect carried evidence from it beside
// `queue.speculation.carry` and `baseRefresh.carry`, or the SQL-trimmed snapshot drops the
// records before the daemon sees them and every carried proof reads as missing. Exercised here
// against the real Store, with evidence bound to the replaced head only: it binds the candidate
// by the carry alone, never by an exact head match, so the projection is what keeps it.

const sha40 = (label: string) => label.replace(/[^0-9a-f]/g, '0').padEnd(40, 'f').slice(0, 40);
const at = '2026-09-28T08:00:00.000Z';
const replacedHead = sha40('a1'), replacedBase = sha40('b1'), tipSha = sha40('d1'), tipBase = sha40('c1');

let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_REFUSAL_CARRY_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1002);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-refusal-carry-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.controlPlaneAppId = 1234;
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;

test('integration:refusal-carry-survives-snapshot — evidence a merge refusal carried binds the candidate in the real Store coordination snapshot, beside the queue and base-refresh carries', async () => {
  let work = await engine.execute(operator, 'create', null, { title: 'Refusal carry', plannedFiles: ['src/queue.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:queue'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/carry/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-1` }, randomUUID());
  work = await engine.execute(worker, 'submit', work.id, { epoch: 1, pr: 801 }, randomUUID());
  work = await engine.observe(work.id, work.revision, {
    clockOffset: { min: 0, max: 0 }, candidate: { sha: tipSha, baseSha: tipBase, pr: 801, branch: work.workspaces[0].branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [], protected: true, mergeable: true,
    merged: false, mergeSha: null, prState: 'open', draft: false, baseTip: tipBase, baseTree: sha40('7c1'), baseTipContained: true,
    files: ['src/queue.ts'], scopeFiles: [], at: new Date().toISOString(),
  } as Observation);

  // The bindings the queue left behind when it published its Graphyard-authored tip: trusted
  // evidence on the replaced head, carried to the tip by the carry decision publication recorded.
  const evidence: Evidence = { id: 'ev-carried', proof: 'unit:queue', sha: replacedHead, baseSha: replacedBase, policyRevision: work.policyRevision, producer: 'ci-runner', trusted: true, result: 'pass', executed: 3, skipped: 0, at };
  const carry = { from: { sha: replacedHead, baseSha: replacedBase }, to: { sha: tipSha, baseSha: tipBase }, policyRevision: work.policyRevision, at,
    predecessor: 'base branch', changedFiles: [], reviewedFiles: ['src/queue.ts'],
    approval: { carried: true, provider: 'github', reviewer: 'graphyard-reviewer[bot]', sha: replacedHead, reviewId: 41, originalSha: replacedHead, reason: 'carried to the tip: diff unchanged' },
    evidence: [{ proof: 'unit:queue', carried: true, evidenceId: evidence.id, producer: evidence.producer, reason: `evidence ${evidence.id} carried to ${tipSha.slice(0, 12)}: diff unchanged` }] };
  await store.pool.query(`UPDATE work_items SET document=jsonb_set(document,'{evidence}',$2::jsonb) WHERE id=$1`, [work.id, JSON.stringify([evidence])]);
  await store.pool.query(`UPDATE work_items SET document=jsonb_set(document,'{queue}',$2::jsonb) WHERE id=$1`, [work.id,
    JSON.stringify({ sequence: 1, enqueuedAt: at, policyRevision: work.policyRevision, speculation: { ref: queueRef(work.key), tip: tipSha, base: tipBase, baseTree: sha40('7c1'), predecessors: [], policyRevision: work.policyRevision, publishedAt: at, carry } })]);

  // The guarded merge refuses the candidate: the control plane keeps the carry decision on the
  // refusal and the queue record is ejected with its tip — mergeRefusal.carry is what binds now.
  await engine.execute(coordinator, 'mergerefused', work.id, { sha: tipSha, baseSha: tipBase, policyRevision: work.policyRevision, reason: 'the carried approval could not be re-posted' }, randomUUID());
  work = await reload(work);
  assert.equal(work.queue, null, 'the refused entry leaves the queue, its tip record with it');
  assert.equal(work.mergeRefusal?.carry?.evidence[0]?.evidenceId, evidence.id, 'the refusal keeps the carry decision');
  // The record binds the tip by the carry alone: its own head is the replaced one, never the tip.
  assert.notEqual(evidence.sha, work.candidate!.sha);
  const binds = (document: Work) => document.evidence.some(entry => entry.id === evidence.id);
  assert.equal(binds(work), true, 'the document keeps the carried record');

  // The SQL-trimmed coordination snapshot keeps the record the refusal carried, exactly as the
  // in-process rule does — before the fix the projection read the two live carries only and the
  // SQL view dropped what the daemon still reads as binding.
  const whole = await store.workSnapshot();
  const snapshot = await store.coordinationSnapshot();
  const trimmed = snapshot.work.find(item => item.id === work.id)!;
  assert.ok(binds(trimmed), 'the coordination snapshot keeps evidence the merge refusal carried');
  assert.ok(trimmed.mergeRefusal?.carry, 'the refusal and its carry decision travel in the snapshot');
  assert.ok(binds(trimInProcess(whole).work.find(item => item.id === work.id)!), 'the in-process rule keeps the same record');
  assert.deepEqual(
    trimInProcess(whole).work.find(item => item.id === work.id)!.evidence.filter(entry => entry.id === evidence.id),
    trimmed.evidence.filter(entry => entry.id === evidence.id), 'the SQL view and the in-process rule keep the same carried record');
});
