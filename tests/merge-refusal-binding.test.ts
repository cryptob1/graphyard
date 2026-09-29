import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { refuseStaleCarry, StaleCarriedApprovalError } from '../src/master/merge.js';
import { queueRef } from '../src/merge-queue.js';
import type { Observation, Principal, Work } from '../src/model.js';

// GY-904: a `mergerefused` report names the review it judged. The control plane answers it only
// while the carried binding is still that review: a newer approval observed between the failed
// re-post (or the loop's snapshot) and the report re-binds the carry, and clearing the refreshed
// binding over a refusal that names another review would race a valid carry into an unnecessary
// review request and queue ejection. The reporter retries and succeeds through the new binding.

const sha40 = (label: string) => label.replace(/[^0-9a-f]/g, '0').padEnd(40, 'f').slice(0, 40);
const at = '2026-09-28T08:00:00.000Z';
const replacedHead = sha40('a1'), replacedBase = sha40('b1'), tipSha = sha40('d1'), tipBase = sha40('c1');

let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_REFUSAL_BIND_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1003);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-refusal-bind-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.controlPlaneAppId = 1234;
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;

/** An item observed at its Graphyard-authored tip, with the carried review `reviewId` still bound. */
async function carried(title: string, reviewId: number) {
  let work = await engine.execute(operator, 'create', null, { title, plannedFiles: ['src/queue.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:queue'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/bind/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-1` }, randomUUID());
  work = await engine.execute(worker, 'submit', work.id, { epoch: 1, pr: 810 + reviewId }, randomUUID());
  work = await engine.observe(work.id, work.revision, {
    clockOffset: { min: 0, max: 0 }, candidate: { sha: tipSha, baseSha: tipBase, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, prState: 'open', draft: false,
    baseTip: tipBase, baseTree: sha40('7c1'), baseTipContained: true, files: ['src/queue.ts'], scopeFiles: [], at: new Date().toISOString(),
  } as Observation);
  const carry = { from: { sha: replacedHead, baseSha: replacedBase }, to: { sha: tipSha, baseSha: tipBase }, policyRevision: work.policyRevision, at,
    predecessor: 'base branch', changedFiles: [], reviewedFiles: ['src/queue.ts'],
    approval: { carried: true, provider: 'github', reviewer: 'graphyard-reviewer[bot]', sha: replacedHead, reviewId, originalSha: replacedHead, reason: 'carried to the tip: diff unchanged' }, evidence: [] };
  await store.pool.query(`UPDATE work_items SET document=jsonb_set(document,'{queue}',$2::jsonb) WHERE id=$1`, [work.id,
    JSON.stringify({ sequence: 1, enqueuedAt: at, policyRevision: work.policyRevision, speculation: { ref: queueRef(work.key), tip: tipSha, base: tipBase, baseTree: sha40('7c1'), predecessors: [], policyRevision: work.policyRevision, publishedAt: at, carry } })]);
  return work;
}
const rejected = (reviewId: number) => ({ reviewer: 'graphyard-reviewer[bot]', reviewId, originalSha: replacedHead });

test('unit:mergerefused-names-the-review — a report naming the review it judged clears exactly that carried approval', async () => {
  let work = await carried('Named review', 41);
  await engine.execute(coordinator, 'mergerefused', work.id, { sha: tipSha, baseSha: tipBase, policyRevision: work.policyRevision, reason: 'the re-post found no approval it may use', rejected: rejected(41) }, randomUUID());
  work = await reload(work);
  assert.equal(work.queue, null, 'the refused entry leaves the queue');
  assert.deepEqual([work.mergeRefusal?.action, work.mergeRefusal?.sha], ['rereview', tipSha]);
  assert.deepEqual(work.mergeRefusal?.approval, rejected(41), 'the refusal names the review it could not re-post');
  assert.equal((work.mergeRefusal?.carry?.approval as { carried: boolean }).carried, false, 'the named approval is the one cleared');
  assert.match((work.mergeRefusal?.carry?.approval as { reason: string }).reason, /the guarded merge could not use the carried approval/);
});

test('unit:mergerefused-names-the-review — a report naming another review is refused, and a binding a newer approval refreshed is left standing', async () => {
  let work = await carried('Refreshed binding', 42);
  // The stale review R1 failed to re-post; while the report travelled, a newer approval of the
  // reviewed head re-bound the carry to R2 (as refreshedCarriedApproval does on an observation).
  await store.pool.query(`UPDATE work_items SET document=jsonb_set(document,'{queue,speculation,carry,approval}','{"carried":true,"provider":"github","reviewer":"graphyard-reviewer[bot]","sha":"${replacedHead}","reviewId":43,"originalSha":"${replacedHead}","reason":"approval of the reviewed head replaces the carried review 41"}'::jsonb) WHERE id=$1`, [work.id]);
  await assert.rejects(engine.execute(coordinator, 'mergerefused', work.id, { sha: tipSha, baseSha: tipBase, policyRevision: work.policyRevision, reason: 'the re-post found no approval it may use', rejected: rejected(41) }, randomUUID()),
    (error: any) => error.status === 409 && /no longer the review this refusal names \(graphyard-reviewer\[bot\] review 41 of/.test(error.message), 'the control plane refuses to clear a binding the refusal does not name');
  work = await reload(work);
  assert.equal(work.mergeRefusal, undefined, 'nothing is recorded over a refusal that names another review');
  const approval = work.queue?.speculation?.carry?.approval as { carried: boolean; reviewId: number };
  assert.deepEqual([approval.carried, approval.reviewId], [true, 43], 'the refreshed binding stands');
  // The reporter reads GitHub afresh on its next attempt: the merge is retried against the new binding.
  await engine.execute(coordinator, 'mergerefused', work.id, { sha: tipSha, baseSha: tipBase, policyRevision: work.policyRevision, reason: 'the re-post found no approval it may use', rejected: { reviewer: 'graphyard-reviewer[bot]', reviewId: 43, originalSha: replacedHead } }, randomUUID());
  work = await reload(work);
  assert.deepEqual([work.mergeRefusal?.action, work.mergeRefusal?.approval?.reviewId], ['rereview', 43], 'a report naming the binding that stands is answered');
  assert.equal((work.mergeRefusal?.carry?.approval as { carried: boolean }).carried, false);
});

test('unit:mergerefused-names-the-review — a report that judged no carried approval is refused while one binds, and records the rework action when none does', async () => {
  let work = await carried('Unpinned report', 44);
  // A report from a snapshot that held no carried approval must not clear one that binds now.
  await assert.rejects(engine.execute(coordinator, 'mergerefused', work.id, { sha: tipSha, baseSha: tipBase, policyRevision: work.policyRevision, reason: 'one reason repeated', rejected: null }, randomUUID()),
    (error: any) => error.status === 409 && /carries an approval this refusal did not judge/.test(error.message));
  work = await reload(work);
  assert.equal(work.mergeRefusal, undefined);
  assert.equal((work.queue?.speculation?.carry?.approval as { carried: boolean }).carried, true, 'the carried approval is untouched');
  // An unpinned report (no `rejected` field) for a candidate with no carried approval records the
  // rework action exactly as before: the ten-minute handler keeps its meaning.
  let plain = await carried('Plain report', 45);
  await store.pool.query(`UPDATE work_items SET document=document-'queue' WHERE id=$1`, [plain.id]);
  await engine.execute(coordinator, 'mergerefused', plain.id, { sha: tipSha, baseSha: tipBase, policyRevision: plain.policyRevision, reason: 'the pull request changed on GitHub before merge', rejected: null }, randomUUID());
  plain = await reload(plain);
  assert.deepEqual([plain.mergeRefusal?.action, plain.mergeRefusal?.sha], ['rework', tipSha]);
  // And a legacy report without the field keeps its shape for an un-carried candidate, too.
  let legacy = await carried('Legacy report', 46);
  await store.pool.query(`UPDATE work_items SET document=document-'queue' WHERE id=$1`, [legacy.id]);
  await engine.execute(coordinator, 'mergerefused', legacy.id, { sha: tipSha, baseSha: tipBase, policyRevision: legacy.policyRevision, reason: 'the pull request changed on GitHub before merge' }, randomUUID());
  legacy = await reload(legacy);
  assert.deepEqual([legacy.mergeRefusal?.action, legacy.mergeRefusal?.sha], ['rework', tipSha]);
});

test('unit:mergerefused-names-the-review — the stale-carry report names the carried approval the re-post was given', async () => {
  const work = await carried('Stale carry report', 47);
  const posted: any[] = [];
  const mutation = async (_path: string, data: unknown) => { posted.push(data); return { ok: true }; };
  const binding = (await reload(work)).queue!.speculation!.carry!.approval as { reviewer: string; reviewId: number; originalSha: string; carried: true; provider: 'github'; sha: string; reason: string };
  await assert.rejects(refuseStaleCarry(await reload(work), new StaleCarriedApprovalError('the approval of the replaced head is no longer on the pull request'), binding, mutation, (item, step) => `${item.id}:${step}`),
    /Graphyard cleared the carried approval: the review gate requests a fresh review of tip/);
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].rejected, { reviewer: 'graphyard-reviewer[bot]', reviewId: 47, originalSha: replacedHead });
  assert.match(posted[0].reason, /the approval of the replaced head is no longer on the pull request/);
});
