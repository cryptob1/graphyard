import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import type { Observation, Principal, Work } from '../src/model.js';
import { failedRequiredChecks } from '../src/model/refusal-mapping.js';

// GY-951, second half. A required check that failed on the exact current candidate head owes one
// rerun (GY-516); when that rerun expires, the grounds for a new head are the record's own, and
// the control plane settles the round itself — in the save that would otherwise publish a
// `request-rework` state no executor may run, which stood until a decide-and-approve session
// pair repeated the record's reading and counted as a decision fault each time. The tests are
// named for the proof each produces.

const repository = 'owner/mechanical-rework';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const head = 'c'.repeat(40), base = 'd'.repeat(40);
let database: EmbeddedPostgres, store: Store, engine: Engine;
let pr = 700;

const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const overwrite = async (work: Work, mutate: (document: Work) => void) => {
  const document = await reload(work.id); mutate(document);
  await store.pool.query('UPDATE work_items SET document=$2::jsonb WHERE id=$1', [document.id, JSON.stringify(document)]);
  return document;
};
const events = async (work: Work) => (await store.pool.query('SELECT actor, kind, payload FROM events WHERE work_id=$1 ORDER BY seq', [work.id])).rows;
function observation(failures: { name: string; result: string; id?: number }[]): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr, branch: branch, author: 'implementer' },
    checks: [...failures.map(check => ({ appId: 15368, ...check })), { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'independent-reviewer', sha: head, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, files: ['src/mechanical.ts'], scopeFiles: [], at: new Date().toISOString() };
}
let branch = 'graphyard/gy-mechanical-1', path = '/tmp/mechanical-1';
async function submitted(): Promise<Work> {
  branch = `graphyard/gy-mechanical-${pr + 1}`, path = `/tmp/mechanical-${pr + 1}`;
  let work = await engine.execute(operator, 'create', null, { title: 'mechanical-rework', plannedFiles: ['src/mechanical.ts'],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], policy: { checks: ['test', 'typecheck'], review: true }, reason: 'Operator goal: mechanical rework is settled by the record' }, randomUUID()) as Work;
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(implementer, 'workspace', work.id, { epoch: work.epoch, host: 'mechanical-host', path, branch }, randomUUID());
  work = await engine.execute(implementer, 'submit', work.id, { epoch: work.epoch, pr: ++pr }, randomUUID());
  return work;
}
/** Expire the one rerun the failed check was owed, as a clock the next observation judges. */
const expireRerun = (work: Work) => overwrite(work, document => {
  document.checkReruns = (document.checkReruns ?? []).map(entry => ({ ...entry, at: new Date(Date.now() - 20 * 60_000).toISOString() }));
});

before(async () => {
  const port = Number(process.env.GRAPHYARD_MECHANICAL_REWORK_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 96);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-mechanical-rework-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('mechanical_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/mechanical_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
});
after(async () => { await store?.close(); await database?.stop(); });

test('unit:failed-required-checks — the shared classifier names the checks whose failed run is the change to fix, on the exact current head with no rerun held', () => {
  const candidate = { sha: head, baseSha: base, pr: 1, branch: 'b' };
  const observation: any = { candidate, checks: [{ name: 'test', result: 'failure', id: 101, appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], merged: false, prState: 'open' };
  const work = { submission: { epoch: 1, pr: 1 }, reworkRequested: false, candidate, observation, stage: 'test', policy: { checks: ['test', 'typecheck'] }, gates: [], checkReruns: [] } as any;
  assert.deepEqual(failedRequiredChecks(work), ['test']);
  // A rerun still owed or running holds the failure; a passed run asks for nothing.
  assert.deepEqual(failedRequiredChecks({ ...work, checkReruns: [{ sha: head, check: 'test', failedRunId: 101, state: 'owed', at: new Date().toISOString() }] }), [], 'the owed rerun holds the failure');
  assert.deepEqual(failedRequiredChecks({ ...work, observation: { ...observation, checks: [{ name: 'test', result: 'success', appId: 15368 }] } }), []);
  // A stale run is a re-read's, never rework; an observation of another head names nothing.
  assert.deepEqual(failedRequiredChecks({ ...work, observation: { ...observation, checks: [{ name: 'test', result: 'stale', appId: 15368 }] } }), []);
  assert.deepEqual(failedRequiredChecks({ ...work, observation: { ...observation, candidate: { ...candidate, sha: 'e'.repeat(40) } } }), []);
  assert.deepEqual(failedRequiredChecks({ ...work, reworkRequested: true }), []);
  assert.deepEqual(failedRequiredChecks({ ...work, submission: null }), []);
});

test('integration:mechanical-rework-settled — an expired rerun returns the head to a worker in the save that would have published the owed decision, with no decision requested', async () => {
  let work = await submitted();
  // First reading: the check fails and its one rerun is owed, so the failure is held (GY-516)
  // and nothing is settled: the queue position, approval and proofs the rerun keeps stand.
  work = await engine.observe(work.id, work.revision, observation([{ name: 'test', result: 'failure', id: 101 }]));
  assert.equal(work.reworkRequested, false, 'a failure its rerun still holds is not yet the worker’s');
  assert.equal((await events(work)).some(row => row.kind === 'rework'), false);
  assert.deepEqual((await reload(work.id).then(item => item.checkReruns ?? [])).map(entry => entry.state), ['owed']);
  // The rerun expires: the next observation judges the expiry and settles the round in the very
  // same save — no `request-rework` state is published, and no decision is requested.
  await expireRerun(work);
  work = await engine.observe(work.id, work.revision, observation([{ name: 'test', result: 'failure', id: 101 }]));
  assert.equal(work.reworkRequested, true, 'the expired rerun left the failure the record’s own grounds');
  const history = await events(work);
  const settled = history.find(row => row.kind === 'rework');
  assert.ok(settled, 'the rework round is on the ledger');
  assert.equal(settled!.actor, 'graphyard', 'the control plane settled it from its own record');
  assert.equal(settled!.payload.details.previousWorkerStopped, true, 'the round carries the stopped-worker attestation');
  assert.equal(settled!.payload.details.mechanical, true);
  assert.deepEqual(settled!.payload.details.checks, ['test']);
  assert.equal(history.some(row => row.kind === 'decision.requested'), false, 'no decision round trip stood between the failure and the fresh attempt');
  assert.equal(work.pipeline?.reworkRounds, 1);
  assert.equal(work.lease, null);
  // What the item now needs is the fresh attempt, not the rework that was answered: the saved
  // document never carried the owed-decision state at all.
  assert.equal(work.nextAction?.kind, 'dispatch');
  assert.equal(work.observation!.candidate.sha, head, 'the head and its bindings are unchanged by the settle');
  // A reconcile pass finds the grounds gone: no second round, no duplicate ledger row.
  await engine.reconcile();
  const after = await events(work);
  assert.equal(after.filter(row => row.kind === 'rework').length, 1, 'the settled round is not requested again');
  // A replacement attempt can claim: the rework round is what authorizes reassignment.
  const again = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  assert.equal(again.epoch, work.epoch + 1);
});

test('integration:mechanical-rework-needs-a-spent-rerun — a failure no spent rerun stands behind is not the control plane’s to settle', async () => {
  // With reruns disabled, a failed run cannot be given its second chance, but neither has the
  // record spent one: the failure may yet be cleared by the next reading, so the round stays
  // with the loop's judged decision and nothing is settled on the first failure.
  engine.rerunFailedChecks = 0;
  try {
    let work = await submitted();
    work = await engine.observe(work.id, work.revision, observation([{ name: 'test', result: 'failure', id: 301 }]));
    assert.equal(work.checkReruns ?? null, null, 'no rerun is owed while the setting is zero');
    assert.equal(work.reworkRequested, false, 'the first failure is not the control plane’s own grounds');
    assert.equal(work.nextAction?.kind, 'request-rework', 'the round waits for the loop’s judged decision instead');
    assert.equal((await events(work)).some(row => row.kind === 'rework'), false);
    // Nor is a failure its still-owed or running rerun holds: the rerun's own conclusion decides.
    engine.rerunFailedChecks = 1;
    let held = await submitted();
    held = await engine.observe(held.id, held.revision, observation([{ name: 'test', result: 'failure', id: 311 }]));
    assert.deepEqual((held.checkReruns ?? []).map(entry => entry.state), ['owed']);
    assert.equal(held.reworkRequested, false);
    assert.equal(held.nextAction?.kind, 'resync', 'the failure waits for its rerun');
    assert.equal((await events(held)).some(row => row.kind === 'rework'), false);
  } finally { engine.rerunFailedChecks = 1; }
});

test('integration:mechanical-rework-guards — a live lease or an unsettled fence leaves the round to the two-party decision, and a lapsed lease is discarded with its attestation', async () => {
  // A worker still holding the lease is not attested stopped by anybody: the grounds stay the
  // loop's two-party decision, and the saved state is the request-rework the loop asks from.
  let held = await submitted();
  held = await engine.observe(held.id, held.revision, observation([{ name: 'test', result: 'failure', id: 101 }]));
  await expireRerun(held);
  held = await overwrite(held, document => { document.lease = { owner: implementer.id, epoch: document.epoch, expiresAt: new Date(Date.now() + 60_000).toISOString() }; });
  held = await engine.observe(held.id, held.revision, observation([{ name: 'test', result: 'failure', id: 101 }]));
  assert.equal(held.reworkRequested, false, 'a live lease is not attested stopped by the control plane');
  assert.equal(held.nextAction?.kind, 'request-rework', 'the round waits for the loop’s judged decision instead');
  assert.equal((await events(held)).some(row => row.kind === 'rework'), false);
  // A lapsed lease is the one the control plane attests stopped: the settle discards it with the
  // stopped-worker attestation, so the lapse is explained on the record and no loss is raised.
  let lapsed = await submitted();
  lapsed = await engine.observe(lapsed.id, lapsed.revision, observation([{ name: 'test', result: 'failure', id: 101 }]));
  await expireRerun(lapsed);
  lapsed = await overwrite(lapsed, document => { document.lease = { owner: implementer.id, epoch: document.epoch, expiresAt: '2000-01-01T00:00:00Z' }; });
  lapsed = await engine.observe(lapsed.id, lapsed.revision, observation([{ name: 'test', result: 'failure', id: 101 }]));
  assert.equal(lapsed.reworkRequested, true);
  assert.equal(lapsed.lease, null);
  const settledEvents = await events(lapsed);
  const discarded = settledEvents.find(row => row.kind === 'lease.expired');
  assert.ok(discarded, 'the discarded lease is recorded, never silently dropped');
  assert.equal(discarded!.payload.details.cause, 'stopped-by-attestation');
  assert.equal(discarded!.payload.details.attestation.epoch, lapsed.epoch);
  assert.equal(discarded!.payload.details.attestation.actor, 'graphyard');
});
