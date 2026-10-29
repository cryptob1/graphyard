import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';
import { managedInstructions } from '../src/repository-setup.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Each test is named for the proof it produces, so acceptance evidence maps to
// one executed case per required proof.
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'engineer-a', role: 'worker', sessionKind: 'ai' };
const replacement: Principal = { id: 'engineer-b', role: 'worker', sessionKind: 'ai' };
let database: EmbeddedPostgres, store: Store, engine: Engine;
let pr = 900;
const id = () => randomUUID();
const input = (title: string) => ({ title, type: 'chore', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }] });
const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
const events = async (work: Work, kind: string) => (await store.events(work.id)).filter(event => event.kind === kind);
const merge = (work: Work) => work.gates.find(gate => gate.name === 'merge')!;

before(async () => {
  const port = Number(process.env.GRAPHYARD_LEASE_LIFECYCLE_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 13);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('lease-lifecycle'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, 120, 'owner/project');
  engine.principals = [operator, worker, replacement];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

async function claimed(title: string, actor: Principal = worker) {
  let work = await engine.execute(operator, 'create', null, input(title), id());
  work = await engine.execute(operator, 'ready', work.id, {}, id());
  work = await engine.execute(actor, 'claim', work.id, {}, id());
  return engine.execute(actor, 'workspace', work.id, { epoch: work.epoch, host: 'lifecycle-host', path: `/tmp/lifecycle/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, id());
}
// Rewrite the stored document the way an older deployment left it: the lease outlives the
// submission. Reconciliation must read it as history, not as a document this code wrote.
async function overwrite(work: Work, mutate: (document: Work) => void) {
  const document = await reload(work); mutate(document);
  await store.pool.query('UPDATE work_items SET document=$2::jsonb WHERE id=$1', [document.id, JSON.stringify(document)]);
  return document;
}

test('integration:lease-release-on-submit: complete ends the lease with the candidate bound, and reconcile records every lapse as a plain expiry', async () => {
  // Submission and lease release are one transaction: the document, the receipt and the history
  // entry all show the lease gone with the submission bound.
  let work = await claimed('lease-release-on-submit');
  const epoch = work.epoch;
  assert.ok(work.lease, 'the attempt is leased until it submits');
  work = await engine.execute(worker, 'submit', work.id, { epoch, pr: ++pr }, id());
  assert.deepEqual(work.submission, { epoch, pr });
  assert.equal(work.lease, null, 'complete releases the implementation lease');
  assert.equal(work.epoch, epoch, 'the attempt epoch is unchanged');
  assert.deepEqual(work.workspaces.map(w => w.epoch), [epoch], 'the workspace reservation stays recorded');
  assert.equal(work.lastAssignment!.owner, worker.id); assert.equal(work.lastAssignment!.epoch, epoch);
  assert.equal((await reload(work)).lease, null);
  const submitEvent = (await events(work, 'submit')).at(-1)!;
  assert.equal(submitEvent.payload.work.lease, null, 'history records the submission and the release together');
  assert.deepEqual(submitEvent.payload.work.submission, { epoch, pr });
  // Nothing is left to renew: the refusal names the submission rather than a superseded epoch.
  await assert.rejects(engine.execute(worker, 'heartbeat', work.id, { epoch }, id()), new RegExp(`Implementation lease for epoch ${epoch} ended when ${work.key} was submitted; stop heartbeating after complete`));
  await assert.rejects(engine.execute(worker, 'release', work.id, { epoch }, id()), /ended when .* was submitted/);
  await assert.rejects(engine.execute(worker, 'heartbeat', work.id, { epoch: epoch + 1 }, id()), /Lease missing, expired, or superseded/, 'an epoch that never submitted keeps the ordinary refusal');
  // Reconciliation has no lapse to notice, and raises nothing.
  await engine.reconcile();
  work = await reload(work);
  assert.equal(merge(work).reasons.some(reason => /lease-loss/.test(reason)), false);
  // Submitted work still needs the operator's attestation before anyone else takes it, and
  // rework of an item whose lease already ended discards nothing, so it raises nothing.
  await assert.rejects(engine.execute(replacement, 'claim', work.id, {}, id()), /an operator must request rework before reassignment/);
  work = await engine.execute(operator, 'rework', work.id, { reason: 'Review asked for a second pass', previousWorkerStopped: true }, id());
  assert.equal(work.reworkRequested, true);

  // A lease that lapses after submission — an item submitted before complete released leases,
  // or a worker still renewing when it was refused — is history, never an incident.
  let legacy = await claimed('lease-lapse-after-submit');
  const legacyEpoch = legacy.epoch;
  legacy = await engine.execute(worker, 'submit', legacy.id, { epoch: legacyEpoch, pr: ++pr }, id());
  legacy = await overwrite(legacy, document => { document.lease = { owner: worker.id, epoch: legacyEpoch, expiresAt: '2000-01-01T00:00:00Z' }; });
  await engine.reconcile();
  legacy = await reload(legacy);
  assert.equal(legacy.lease, null, 'the lapsed lease is cleared');
  assert.equal(merge(legacy).reasons.some(reason => /lease-loss/.test(reason)), false);
  const expired = await events(legacy, 'lease.expired');
  assert.equal(expired.length, 1, 'the lapse is recorded as a plain lease.expired event');
  assert.equal(expired[0].actor, 'graphyard');
  assert.deepEqual({ owner: expired[0].payload.details.owner, epoch: expired[0].payload.details.epoch, submission: expired[0].payload.details.submission }, { owner: worker.id, epoch: legacyEpoch, submission: { epoch: legacyEpoch, pr } });
  assert.equal(legacy.lastAssignment!.owner, worker.id, 'the attempt stays attributable');
  const reconciled = (await events(legacy, 'reconciled')).at(-1)!;
  assert.deepEqual(reconciled.payload.details, { ledger: ['lease.expired'] });
  await engine.reconcile();
  assert.equal((await events(legacy, 'lease.expired')).length, 1, 'a settled lapse is not recorded twice');

  // A lapsed unsubmitted lease ends the attempt the same way: a plain lease.expired, nothing to resolve.
  const expiring = new Engine(store, 0, 'owner/project'); expiring.principals = engine.principals;
  let abandoned = await engine.execute(operator, 'create', null, input('lease-lapse-before-submit'), id());
  abandoned = await engine.execute(operator, 'ready', abandoned.id, {}, id());
  abandoned = await expiring.execute(worker, 'claim', abandoned.id, {}, id());
  const abandonedEpoch = abandoned.epoch;
  await engine.reconcile();
  abandoned = await reload(abandoned);
  assert.equal(abandoned.lease, null);
  assert.equal(merge(abandoned).reasons.some(reason => /lease-loss/.test(reason)), false, 'nothing refuses the merge gate on it');
  const lapsed = await events(abandoned, 'lease.expired');
  assert.equal(lapsed.length, 1, 'the lapse is recorded as a plain lease.expired event');
  assert.deepEqual({ owner: lapsed[0].payload.details.owner, epoch: lapsed[0].payload.details.epoch }, { owner: worker.id, epoch: abandonedEpoch });
  await engine.reconcile();
  assert.equal((await events(abandoned, 'lease.expired')).length, 1, 'recorded once');
  // A replacement claim over a lapsed lease simply takes the item.
  let replaced = await engine.execute(operator, 'create', null, input('lease-replacement-claim'), id());
  replaced = await engine.execute(operator, 'ready', replaced.id, {}, id());
  replaced = await expiring.execute(worker, 'claim', replaced.id, {}, id());
  const replacedEpoch = replaced.epoch;
  replaced = await engine.execute(replacement, 'claim', replaced.id, {}, id());
  assert.equal(replaced.lease!.owner, replacement.id);
  assert.ok(replaced.epoch > replacedEpoch, 'under a new epoch');
  // Rework that discards a live, unsubmitted lease records its end as history caused by the
  // rework, not as a silently vanished worker (GY-62).
  let discarded = await claimed('lease-rework-discards');
  const discardedEpoch = discarded.epoch;
  discarded = await engine.execute(operator, 'rework', discarded.id, { reason: 'Reassigning an unfinished attempt', previousWorkerStopped: true }, id());
  assert.equal(discarded.lease, null);
  const stopped = await events(discarded, 'lease.expired');
  assert.equal(stopped.length, 1);
  assert.deepEqual({ owner: stopped[0].payload.details.owner, epoch: stopped[0].payload.details.epoch, cause: stopped[0].payload.details.cause }, { owner: worker.id, epoch: discardedEpoch, cause: 'rework' });
});

test('manual:lease-lifecycle-docs: the generated worker instructions say complete ends the lease and forbid heartbeating after submission', () => {
  const block = managedInstructions('');
  assert.match(block, /`complete GY-N EPOCH --head SHA`[^]*ends your lease in the same transaction/);
  assert.match(block, /do not heartbeat or edit after it/);
  assert.match(block, /the supervisor stops the session; that is the attempt ending, not lease\nloss/);
});
