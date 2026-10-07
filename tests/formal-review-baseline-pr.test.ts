import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { Store, save } from '../src/store.js';
import { reopenReverted } from '../src/main-guard.js';
import type { Observation, Principal, Work } from '../src/model.js';

type Review = Observation['reviews'][number];
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1425: GY-1394's first PR #866 merged and was reverted, so the item relanded as PR #887. The
// formal-review baseline still named #866, and exactApproval counts an approval only under a
// baseline of the candidate's own pull request, so no approval on #887 could ever pass the review
// gate until a requirements revision cleared the baseline by hand. Each test is named for its proof.

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
const head = 'a'.repeat(40), base = 'b'.repeat(40);
let database: EmbeddedPostgres; let store: Store; let engine: Engine;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1425;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('formal-review-baseline'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('formal_review_baseline_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/formal_review_baseline_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/baseline'); engine.submissionObserver = null;
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const approval = (id: number): Review => ({ id, reviewer: 'reviewer', sha: head, state: 'APPROVED', submittedAt: new Date().toISOString() });
function observation(w: Work, pr: number, reviews: Review[], reviewIds = reviews.map(review => review.id!)): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr, branch: w.workspaces.at(-1)!.branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews, reviewIds, protected: true, mergeable: true, merged: false, mergeSha: null, files: ['src/claims.ts'], scopeFiles: [], at: new Date().toISOString() };
}
const reviewPassed = (w: Work) => w.gates.find(gate => gate.name === 'review')!.passed;

async function submit(w: Work, pr: number) {
  w = await engine.execute(worker, 'claim', w.id, {}, randomUUID());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: w.epoch, host: 'machine-a', path: `/tmp/${w.id}-${w.epoch}`, branch: `graphyard/${w.key.toLowerCase()}-${w.epoch}` }, randomUUID());
  return engine.execute(worker, 'submit', w.id, { epoch: w.epoch, pr }, randomUUID());
}
/** An item submitted as `first`, whose requirements were revised after an approval of that pull request. */
async function revisedOnFirstPullRequest(first: number) {
  let w = await engine.execute(operator, 'create', null, { title: `baseline-${first}`, plannedFiles: ['src/claims.ts'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:behaves'] }] }, randomUUID());
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID());
  w = await submit(w, first);
  w = await engine.observe(w.id, w.revision, observation(w, first, [approval(100)]));
  w = await engine.execute(operator, 'requirements', w.id, { expectedPolicyRevision: w.policyRevision, reason: 'Revise intent', criteria: [{ ...w.criteria[0], text: 'Behaves as revised' }], dependencies: [], plannedFiles: w.plannedFiles, exclusiveResources: [] }, randomUUID());
  assert.equal(w.formalReviewResetRequired, true); assert.equal(w.formalReviewBaseline, undefined);
  w = await engine.observe(w.id, w.revision, observation(w, first, [approval(100)], [100, 101]));
  assert.deepEqual(w.formalReviewBaseline, { pr: first, policyRevision: w.policyRevision, reviewIds: [100, 101] });
  return w;
}
/**
 * The same item moved to `second`, as GY-1394 was: its first pull request merged, the main guard
 * reverted it and reopened the item (reopenReverted), and a new attempt submitted another pull request.
 */
async function moved(w: Work, second: number) {
  await store.transaction(async db => {
    const current: Work = (await db.query('SELECT document FROM work_items WHERE id=$1 FOR UPDATE', [w.id])).rows[0].document;
    const mergeSha = 'c'.repeat(40);
    current.stage = 'done'; current.delivery = { mergeSha } as Work['delivery'];
    assert.ok(reopenReverted(current, { mergeSha } as Parameters<typeof reopenReverted>[1], new Date()));
    await save(db, current, operator.id, 'test.reverted', new Date());
  });
  w = await submit(w, second);
  assert.notEqual(w.formalReviewBaseline?.pr, second, 'the reopen leaves the old pull request\'s baseline in place');
  return w;
}

test('unit:formal-review-baseline-follows-pr — the baseline is captured again for the new pull request, its first reviews never count, and a later approval there passes with no hand action', async () => {
  let w = await revisedOnFirstPullRequest(866);
  const revision = w.policyRevision;
  w = await moved(w, 887);
  assert.equal(w.policyRevision, revision, 'moving to a new pull request revises nothing');
  // The first observation of #887 already carries an approval: it is the new baseline and never counts.
  w = await engine.observe(w.id, w.revision, observation(w, 887, [approval(200)]));
  assert.deepEqual(w.formalReviewBaseline, { pr: 887, policyRevision: revision, reviewIds: [200] });
  assert.equal(reviewPassed(w), false);
  w = await engine.observe(w.id, w.revision, observation(w, 887, [approval(200)]));
  assert.equal(reviewPassed(w), false, 'a review on the first observation of the new pull request still never counts');
  // An independent approval submitted after that passes the gate, with no requirements revision.
  w = await engine.observe(w.id, w.revision, observation(w, 887, [approval(201)], [200, 201]));
  assert.equal(reviewPassed(w), true);
  assert.equal(w.policyRevision, revision);
  assert.deepEqual(w.formalReviewBaseline!.reviewIds, [200], 'the baseline of the current pull request is not recaptured');
});

test('unit:formal-review-baseline-excludes-prior — a baseline for the current pull request excludes every review it lists, so the approval present before the revision never counts on either pull request', async () => {
  let w = await revisedOnFirstPullRequest(1866);
  // On the first pull request: neither listed identity counts, however often it is observed.
  for (const id of [100, 101]) {
    w = await engine.observe(w.id, w.revision, observation(w, 1866, [approval(id)], [100, 101]));
    assert.equal(reviewPassed(w), false, `review ${id} on #1866`);
  }
  // On the new pull request the pre-revision approval is present on its first observation: it joins the new baseline.
  w = await moved(w, 1887);
  w = await engine.observe(w.id, w.revision, observation(w, 1887, [approval(100)]));
  assert.deepEqual(w.formalReviewBaseline!.reviewIds, [100]);
  assert.equal(reviewPassed(w), false);
  for (const id of [100, undefined]) {
    w = await engine.observe(w.id, w.revision, observation(w, 1887, [{ ...approval(100), id }], [100]));
    assert.equal(reviewPassed(w), false, `review ${id} on #1887`);
  }
  w = await engine.observe(w.id, w.revision, observation(w, 1887, [approval(300)], [100, 300]));
  assert.equal(reviewPassed(w), true);
});
