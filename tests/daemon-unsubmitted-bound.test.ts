import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// Time-bomb allowance (GY-1694): the 2026-10-07 clock is the explicit now handed to unsubmittedAttempt over fixtures derived from it; the DB tests build stamps relative to Date.now().

// GY-1462: the 60-minute worker no-submission bound, enforced. An attempt that holds its lease past
// the bound with no submission for its epoch is a stalled-gate fault however its lease renews (the
// fault and the loop's end at two bounds are GY-1460's, from the one declaration in
// attempt-bound.ts); ten minutes later the server refuses its renewals as the backstop, so the lease
// lapses into the containment and reclaim machinery, its work is kept on its branch, and the item
// goes to a fresh attempt.
// Each test is named for the proof it produces.

const clock = Date.parse('2026-10-07T15:00:00.000Z');
const iso = (offset: number) => new Date(clock + offset).toISOString();
const minute = 60_000;

/** GY-1457 epoch 1's shape: a renewing lease, a running session, no submission, no candidate, claimed `heldMs` ago. */
function held(heldMs: number, overrides: Partial<Work> = {}): Work {
  return {
    id: 'work-1457', key: 'GY-1457', title: 'GY-1457', description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, stage: 'build', revision: 3, policyRevision: 1,
    createdAt: iso(-heldMs - minute), updatedAt: iso(-10_000), stageEnteredAt: iso(-heldMs), ready: true, epoch: 1,
    lease: { owner: 'graphyard-claude-1', epoch: 1, expiresAt: iso(110_000) },
    lastAssignment: { owner: 'graphyard-claude-1', epoch: 1, claimedAt: iso(-heldMs) },
    workspaces: [{ host: 'machine-a', path: '/srv/worktrees/GY-1457-1', epoch: 1, owner: 'graphyard-claude-1', branch: 'graphyard/gy-1457-1' }],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }], violations: [],
    ...overrides,
  } as unknown as Work;
}
/**
 * The product's bound and its readers, imported when a case runs: against the base, where none is
 * declared, each case fails on its own rather than the file failing to load.
 */
async function bound() {
  const declared = await import('../src/model/attempt-bound.js');
  assert.equal(typeof declared.workerSubmissionBoundMs, 'number', 'the product declares the worker no-submission bound');
  assert.equal(typeof declared.noSubmissionRenewalRefused, 'function', 'the server reads the bound to refuse renewal');
  return declared;
}

test('unit:unsubmitted-attempt-fault — an attempt past the no-submission bound with no submission is named with the item and epoch, however recently its lease renewed', async () => {
  const { workerSubmissionBoundMs, unsubmittedAttempt } = await bound();
  assert.equal(workerSubmissionBoundMs, 60 * minute, 'the bound is 60 minutes');
  // GY-1457 epoch 1: 60 m 11 s held, its lease renewed seconds ago.
  const late = held(60 * minute + 11_000);
  const attempt = unsubmittedAttempt(late, clock);
  assert.ok(attempt, 'the attempt is past the bound');
  assert.equal(attempt.key, 'GY-1457');
  assert.deepEqual([attempt.epoch, attempt.owner, attempt.pastBoundMs], [1, 'graphyard-claude-1', 11_000]);
  assert.equal(attempt.leaseExpiresAt, late.lease!.expiresAt, 'the renewal does not hide it');
  // Inside the bound, no lease, or a claim the record cannot date: no attempt.
  assert.equal(unsubmittedAttempt(held(59 * minute), clock), null);
  assert.equal(unsubmittedAttempt(held(2 * 60 * minute, { lease: null }), clock), null);
  assert.equal(unsubmittedAttempt(held(2 * 60 * minute, { lastAssignment: undefined }), clock), null);
  // The pipeline timeline dates the claim when the assignment does not name the epoch.
  const timeline = { ...held(0, { lastAssignment: undefined }), pipeline: { attempts: [{ epoch: 1, claimedAt: iso(-61 * minute) }] } } as unknown as Work;
  assert.ok(unsubmittedAttempt(timeline, clock));
  // An earlier epoch's candidate is no candidate for this epoch.
  const reworked = held(61 * minute, { epoch: 2, lease: { owner: 'graphyard-claude-1', epoch: 2, expiresAt: iso(110_000) }, lastAssignment: { owner: 'graphyard-claude-1', epoch: 2, claimedAt: iso(-61 * minute) },
    submission: { epoch: 1, pr: 40 } as Work['submission'], candidate: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 40, branch: 'graphyard/gy-1457-1', author: 'graphyard-claude-1' } });
  assert.equal(unsubmittedAttempt(reworked, clock)?.epoch, 2);
});

test('unit:renew-lease-nosubmission-refusal — the server refuses renewal ten minutes past the loop\'s reclaim bound unsubmitted, not before, and not while submission progress is fresh', async () => {
  const { workerReclaimBoundMs, workerSubmissionBoundMs, workerNoSubmissionRefusalMs, noSubmissionRenewalRefused } = await bound();
  assert.equal(workerReclaimBoundMs, 2 * workerSubmissionBoundMs, 'the loop ends the attempt one further bound after the fault');
  assert.equal(workerNoSubmissionRefusalMs, 130 * minute, 'the server refuses its renewals ten minutes later');
  assert.equal(noSubmissionRenewalRefused(held(61 * minute), clock), false, 'one bound past: fault, still renewed');
  assert.equal(noSubmissionRenewalRefused(held(129 * minute), clock), false);
  assert.equal(noSubmissionRenewalRefused(held(130 * minute), clock), true, 'past the backstop: refused');
  // An attempt that pushed a new head within the progress cadence is still at work: renewed.
  const progressing = held(150 * minute, { sessions: [{ id: 'graphyard-claude-1:1', kind: 'implementation', principal: 'graphyard-claude-1', epoch: 1, head: 'c'.repeat(40), headAt: iso(-5 * minute) }] } as unknown as Partial<Work>);
  assert.equal(noSubmissionRenewalRefused(progressing, clock), false, 'fresh submission progress is not refused');
});

test('unit:nosubmission-bound-moot-after-submit — an epoch with a submission is never bounded', async () => {
  const { unsubmittedAttempt, noSubmissionRenewalRefused } = await bound();
  const submitted = held(5 * 60 * minute, { submission: { epoch: 1, pr: 41 } as Work['submission'] });
  assert.equal(unsubmittedAttempt(submitted, clock), null);
  assert.equal(noSubmissionRenewalRefused(submitted, clock), false);
});

// The server side: renewal refused, lapse, reclaim, branch kept.
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'engineer-a', role: 'worker', sessionKind: 'ai' };
const replacement: Principal = { id: 'engineer-b', role: 'worker', sessionKind: 'ai' };
let database: EmbeddedPostgres, store: Store, engine: Engine;
const id = () => randomUUID();
const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
async function overwrite(work: Work, mutate: (document: Work) => void) {
  const document = await reload(work); mutate(document);
  await store.pool.query('UPDATE work_items SET document=$2::jsonb WHERE id=$1', [document.id, JSON.stringify(document)]);
  return document;
}
async function claimed(title: string) {
  let work = await engine.execute(operator, 'create', null, { type: 'chore',  title, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }] }, id());
  work = await engine.execute(operator, 'ready', work.id, {}, id());
  work = await engine.execute(worker, 'claim', work.id, {}, id());
  return engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'machine-a', path: `/srv/worktrees/${work.key}-${work.epoch}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, id());
}
/** Moves the attempt's claim `heldMs` into the past, as an attempt that has held that long reads. */
const age = (work: Work, heldMs: number) => overwrite(work, document => { document.lastAssignment = { ...document.lastAssignment!, claimedAt: new Date(Date.now() - heldMs).toISOString() }; });
const heartbeat = (work: Work, epoch = work.epoch) => engine.execute(worker, 'heartbeat', work.id, { epoch }, id());

before(async () => {
  const port = Number(process.env.GRAPHYARD_UNSUBMITTED_BOUND_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1462);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('unsubmitted-bound'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, 120, 'owner/project');
  engine.principals = [operator, worker, replacement];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

test('integration:unsubmitted-attempt-reclaimed — past two bounds unsubmitted the server refuses renewal, the lease lapses, and the item goes to a fresh attempt', async () => {
  const { unsubmittedAttempt } = await bound();
  let work = await claimed('unsubmitted-reclaimed');
  const epoch = work.epoch;
  // One bound past: the attempt is named, the lease still renews.
  work = await age(work, 61 * minute);
  work = await heartbeat(work);
  assert.equal(work.lease?.epoch, epoch, 'renewed inside the second bound');
  assert.ok(unsubmittedAttempt(work, Date.now()));
  // Past the backstop: refused, as a renewal after submission is (a 409 the supervisor reads as definite).
  await age(work, 130 * minute + minute);
  await assert.rejects(heartbeat(work), (error: Error & { status?: number }) =>
    /is not renewed: no submission in 130 minutes, past the worker no-submission bound/.test(error.message) && error.status === 409);
  // The supervisor stops; the lease runs out. Reconcile ends the attempt on the record.
  await overwrite(work, document => { document.lease = { ...document.lease!, expiresAt: new Date(Date.now() - 1_000).toISOString() }; });
  await engine.reconcile();
  work = await reload(work);
  assert.equal(work.lease, null, 'the lapsed lease is gone');
  // The lapse is recorded as history and ends the attempt.
  const expired = (await store.pool.query(`SELECT payload FROM events WHERE work_id=$1 AND kind='lease.expired'`, [work.id])).rows.map(row => row.payload.details);
  assert.deepEqual(expired.map(details => details.epoch), [epoch], 'the lapse is history');
  // The item is back in the queue: another worker claims a fresh epoch.
  work = await engine.execute(replacement, 'claim', work.id, {}, id());
  assert.equal(work.epoch, epoch + 1);
  assert.equal(work.lease?.owner, replacement.id);
  assert.equal(unsubmittedAttempt(work, Date.now()), null, 'the fresh attempt starts its own clock');
});
