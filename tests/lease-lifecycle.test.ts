import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { classifyLeaseLapse, leaseLossAutoSettlement, leaseLossEpoch, leaseLossReason, settleableLeaseLoss, standingEscalations, submittedEpoch, type Escalation, type Principal, type Work } from '../src/model.js';
import { managedInstructions } from '../src/repository-setup.js';

// Each test is named for the proof it produces, so acceptance evidence maps to
// one executed case per required proof.
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'engineer-a', role: 'worker', sessionKind: 'ai' };
const replacement: Principal = { id: 'engineer-b', role: 'worker', sessionKind: 'ai' };
let database: EmbeddedPostgres, store: Store, engine: Engine;
let pr = 900;
const id = () => randomUUID();
const input = (title: string) => ({ title, plannedFiles: [`src/${title}.ts`], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }] });
const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
const events = async (work: Work, kind: string) => (await store.events(work.id)).filter(event => event.kind === kind);
const merge = (work: Work) => work.gates.find(gate => gate.name === 'merge')!;

before(async () => {
  const port = Number(process.env.GRAPHYARD_LEASE_LIFECYCLE_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 13);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-lease-lifecycle-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
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
// submission, or an escalation already stands. Reconciliation must read it as history, not
// as a document this code wrote.
async function overwrite(work: Work, mutate: (document: Work) => void) {
  const document = await reload(work); mutate(document);
  await store.pool.query('UPDATE work_items SET document=$2::jsonb WHERE id=$1', [document.id, JSON.stringify(document)]);
  return document;
}

test('unit:lease-loss-classification: a lapse is expected only under the epoch that bound the submission', () => {
  const unsubmitted = { submission: null };
  const submitted = { submission: { epoch: 2, pr: 41 } };
  assert.equal(classifyLeaseLapse(unsubmitted, { epoch: 1 }), 'lost');
  assert.equal(classifyLeaseLapse(submitted, { epoch: 2 }), 'expired', 'the lease submitted under has done its job');
  assert.equal(classifyLeaseLapse(submitted, { epoch: 3 }), 'lost', 'a later attempt reopened by rework that never resubmitted is abandoned work');
  assert.equal(classifyLeaseLapse(submitted, { epoch: 1 }), 'lost', 'an earlier attempt that never submitted stays lost');
  assert.equal(submittedEpoch(submitted, 2), true); assert.equal(submittedEpoch(unsubmitted, 2), false);
  // The epoch a standing escalation belongs to is read back from the sentence every raising path writes.
  const lost: Escalation = { trigger: 'lease-loss', reason: leaseLossReason({ owner: 'graphyard-claude-2', epoch: 2 }), at: '2026-09-19T05:20:00.000Z', actor: 'graphyard' };
  assert.equal(lost.reason, 'Worker graphyard-claude-2 lost lease epoch 2');
  assert.equal(leaseLossEpoch(lost), 2);
  assert.equal(leaseLossEpoch({ ...lost, trigger: 'security-concern' }), null, 'only lease-loss reasons name an epoch');
  assert.equal(leaseLossEpoch({ ...lost, reason: 'Worker x lost lease epoch 2 and more' }), null, 'a reason this code did not write is not parsed');
  // Settlement is decided from the record alone: the trigger, its epoch and the bound submission.
  const settle = (work: Partial<Work>) => settleableLeaseLoss({ submission: null, escalations: undefined, escalation: undefined, ...work } as Work).map(entry => entry.escalation.reason);
  assert.deepEqual(settle({ submission: { epoch: 2, pr: 41 }, escalations: [lost] }), [lost.reason]);
  assert.deepEqual(settle({ submission: { epoch: 2, pr: 41 }, escalation: lost }), [lost.reason], 'a legacy single-field document is read the same way');
  assert.deepEqual(settle({ submission: { epoch: 3, pr: 41 }, escalations: [lost] }), [], 'the epoch must be the submitted one');
  assert.deepEqual(settle({ submission: null, escalations: [lost] }), [], 'no submission, no settlement');
  assert.deepEqual(settle({ submission: { epoch: 2, pr: 41 }, escalations: [{ ...lost, trigger: 'security-concern', reason: 'Credential in diff' }] }), [], 'other triggers are never settled automatically');
  assert.equal(leaseLossAutoSettlement, 'auto-settled: submitted before expiry');
});

test('integration:lease-release-on-submit: complete ends the lease with the candidate bound, and reconcile records a post-submission lapse without escalating', async () => {
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
  assert.deepEqual(standingEscalations(work), []);
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
  assert.deepEqual(standingEscalations(work), []);
  assert.equal(merge(work).reasons.some(reason => /lease-loss/.test(reason)), false);
  // Submitted work still needs the operator's attestation before anyone else takes it, and
  // rework of an item whose lease already ended discards nothing, so it raises nothing.
  await assert.rejects(engine.execute(replacement, 'claim', work.id, {}, id()), /an operator must request rework before reassignment/);
  work = await engine.execute(operator, 'rework', work.id, { reason: 'Review asked for a second pass', previousWorkerStopped: true }, id());
  assert.deepEqual(standingEscalations(work), [], 'rework after complete discards no assignment');
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
  assert.deepEqual(standingEscalations(legacy), [], 'a lapse after submission raises no lease-loss');
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

  // A lapsed unsubmitted lease is still an abandoned assignment: it escalates, refuses the merge
  // gate, and only a declared human session clears it.
  const expiring = new Engine(store, [15368], 0, 'owner/project'); expiring.principals = engine.principals;
  let abandoned = await engine.execute(operator, 'create', null, input('lease-lapse-before-submit'), id());
  abandoned = await engine.execute(operator, 'ready', abandoned.id, {}, id());
  abandoned = await expiring.execute(worker, 'claim', abandoned.id, {}, id());
  const abandonedEpoch = abandoned.epoch;
  await engine.reconcile();
  abandoned = await reload(abandoned);
  assert.equal(abandoned.lease, null);
  assert.deepEqual(standingEscalations(abandoned).map(entry => [entry.trigger, entry.reason, entry.actor]), [['lease-loss', `Worker ${worker.id} lost lease epoch ${abandonedEpoch}`, 'graphyard']]);
  assert.match(merge(abandoned).reasons.join(' '), /Unresolved lease-loss escalation/);
  assert.equal((await events(abandoned, 'lease.expired')).length, 0, 'an abandoned attempt is an incident, not an expiry');
  await assert.rejects(engine.execute({ ...operator, sessionKind: 'ai' }, 'resolve', abandoned.id, { trigger: 'lease-loss', reason: 'Automation says fine', expectedRevision: abandoned.revision }, id()), /requires a declared human session/);
  await engine.reconcile();
  abandoned = await reload(abandoned);
  assert.deepEqual(standingEscalations(abandoned).map(entry => entry.trigger), ['lease-loss'], 'reconciliation never settles an unsubmitted loss');
  // The replacement claim records the loss it overwrites, and that one stands too.
  let replaced = await engine.execute(operator, 'create', null, input('lease-replacement-claim'), id());
  replaced = await engine.execute(operator, 'ready', replaced.id, {}, id());
  replaced = await expiring.execute(worker, 'claim', replaced.id, {}, id());
  const replacedEpoch = replaced.epoch;
  replaced = await engine.execute(replacement, 'claim', replaced.id, {}, id());
  assert.equal(replaced.lease!.owner, replacement.id);
  assert.deepEqual(standingEscalations(replaced).map(entry => entry.reason), [`Worker ${worker.id} lost lease epoch ${replacedEpoch}`]);
  await engine.reconcile();
  assert.deepEqual(standingEscalations(await reload(replaced)).map(entry => entry.trigger), ['lease-loss']);
  // Rework that discards a live, unsubmitted lease records its end as history under the
  // admin's own stopped-worker attestation, not as a silently vanished worker (GY-62).
  let discarded = await claimed('lease-rework-discards');
  const discardedEpoch = discarded.epoch;
  discarded = await engine.execute(operator, 'rework', discarded.id, { reason: 'Reassigning an unfinished attempt', previousWorkerStopped: true }, id());
  assert.deepEqual(standingEscalations(discarded), []);
  assert.equal(discarded.lease, null);
  const stopped = await events(discarded, 'lease.expired');
  assert.equal(stopped.length, 1);
  assert.deepEqual({ owner: stopped[0].payload.details.owner, epoch: stopped[0].payload.details.epoch, cause: stopped[0].payload.details.cause, attestation: stopped[0].payload.details.attestation.source }, { owner: worker.id, epoch: discardedEpoch, cause: 'stopped-by-attestation', attestation: 'rework' });
  await engine.reconcile();
  assert.deepEqual(standingEscalations(await reload(discarded)), []);
  // The human path itself is unchanged.
  abandoned = await engine.execute(operator, 'resolve', abandoned.id, { trigger: 'lease-loss', reason: 'Replacement assigned and verified', expectedRevision: abandoned.revision }, id());
  assert.deepEqual(standingEscalations(abandoned), []);
});

test('integration:lease-loss-backlog-settlement: standing lease-loss escalations for a submitted epoch are settled by reconcile with an audited note', async () => {
  // Five items reached the merge gate on 2026-09-19 with `Worker X lost lease epoch N` standing
  // after they had submitted under epoch N. Seed that record exactly as the earlier deployment
  // wrote it and let reconciliation settle it.
  let backlog = await claimed('lease-loss-backlog');
  const epoch = backlog.epoch;
  backlog = await engine.execute(worker, 'submit', backlog.id, { epoch, pr: ++pr }, id());
  const standing: Escalation = { trigger: 'lease-loss', reason: `Worker ${worker.id} lost lease epoch ${epoch}`, at: '2026-09-19T05:20:00.000Z', actor: 'graphyard' };
  backlog = await overwrite(backlog, document => {
    document.escalations = [standing]; document.escalation = standing; document.mergeAuthorization = null;
    const gate = document.gates.find(entry => entry.name === 'merge')!;
    gate.passed = false; gate.reasons.push(`Unresolved lease-loss escalation requires operator resolution: ${standing.reason}`);
  });
  assert.match(merge(backlog).reasons.join(' '), /Unresolved lease-loss escalation/);
  await engine.reconcile();
  backlog = await reload(backlog);
  assert.deepEqual(standingEscalations(backlog), [], 'the standing escalation is settled without a human');
  assert.equal(backlog.escalation, null);
  assert.equal(merge(backlog).reasons.some(reason => /lease-loss/.test(reason)), false, 'the merge gate no longer refuses on it');
  const settled = await events(backlog, 'escalation.auto-settled');
  assert.equal(settled.length, 1);
  assert.equal(settled[0].actor, 'graphyard');
  assert.equal(settled[0].payload.details.note, leaseLossAutoSettlement);
  assert.equal(settled[0].payload.details.trigger, 'lease-loss');
  assert.equal(settled[0].payload.details.epoch, epoch);
  assert.deepEqual(settled[0].payload.details.escalation, standing, 'the settled incident is kept verbatim in the audit entry');
  assert.deepEqual(settled[0].payload.details.submission, { epoch, pr });
  assert.deepEqual((await events(backlog, 'reconciled')).at(-1)!.payload.details, { ledger: ['escalation.auto-settled'] });
  await engine.reconcile();
  assert.equal((await events(backlog, 'escalation.auto-settled')).length, 1, 'settlement is recorded once');

  // The single-field legacy document shape is settled the same way.
  let legacy = await claimed('lease-loss-backlog-legacy');
  legacy = await engine.execute(worker, 'submit', legacy.id, { epoch: legacy.epoch, pr: ++pr }, id());
  legacy = await overwrite(legacy, document => { delete document.escalations; document.escalation = { ...standing, reason: `Worker ${worker.id} lost lease epoch ${document.epoch}` }; });
  await engine.reconcile();
  legacy = await reload(legacy);
  assert.deepEqual(standingEscalations(legacy), []);
  assert.equal((await events(legacy, 'escalation.auto-settled')).length, 1);

  // Every other standing concern stays: settlement names one trigger and one epoch.
  let mixed = await claimed('lease-loss-backlog-mixed');
  const mixedEpoch = mixed.epoch;
  mixed = await engine.execute(worker, 'submit', mixed.id, { epoch: mixedEpoch, pr: ++pr }, id());
  const concern: Escalation = { trigger: 'security-concern', reason: 'Credential-shaped string in the diff', at: '2026-09-19T05:21:00.000Z', actor: 'product-lead' };
  mixed = await overwrite(mixed, document => { document.escalations = [concern, { ...standing, reason: `Worker ${worker.id} lost lease epoch ${mixedEpoch}` }]; document.escalation = concern; });
  await engine.reconcile();
  mixed = await reload(mixed);
  assert.deepEqual(standingEscalations(mixed), [concern], 'the security concern still stands and still needs a human');
  assert.match(merge(mixed).reasons.join(' '), /Unresolved security-concern escalation/);
  assert.equal(merge(mixed).reasons.some(reason => /lease-loss/.test(reason)), false);

  // A lease-loss for an epoch that never submitted is genuine and is left for the operator: an
  // attempt reopened by rework and then abandoned, and a legacy record whose epoch never bound.
  let genuine = await claimed('lease-loss-backlog-genuine');
  const submittedEpochOf = genuine.epoch;
  genuine = await engine.execute(worker, 'submit', genuine.id, { epoch: submittedEpochOf, pr: ++pr }, id());
  genuine = await engine.execute(operator, 'rework', genuine.id, { reason: 'Second pass', previousWorkerStopped: true }, id());
  const expiring = new Engine(store, [15368], 0, 'owner/project'); expiring.principals = engine.principals;
  genuine = await expiring.execute(replacement, 'claim', genuine.id, {}, id());
  const reopenedEpoch = genuine.epoch;
  assert.notEqual(reopenedEpoch, submittedEpochOf);
  await engine.reconcile();
  genuine = await reload(genuine);
  assert.deepEqual(standingEscalations(genuine).map(entry => entry.reason), [`Worker ${replacement.id} lost lease epoch ${reopenedEpoch}`], 'the reopened attempt was abandoned unsubmitted');
  await engine.reconcile();
  genuine = await reload(genuine);
  assert.deepEqual(standingEscalations(genuine).map(entry => entry.trigger), ['lease-loss'], 'never settled automatically: its epoch has no bound submission');
  assert.equal((await events(genuine, 'escalation.auto-settled')).length, 0);
  let unbound = await claimed('lease-loss-backlog-unbound');
  unbound = await overwrite(unbound, document => { document.escalations = [{ ...standing, reason: `Worker ${worker.id} lost lease epoch ${document.epoch + 5}` }]; document.escalation = document.escalations[0]; });
  await engine.reconcile();
  assert.deepEqual(standingEscalations(await reload(unbound)).map(entry => entry.trigger), ['lease-loss']);
  assert.equal((await events(unbound, 'escalation.auto-settled')).length, 0);
});

test('manual:lease-lifecycle-docs: the generated worker instructions say complete ends the lease and forbid heartbeating after submission', () => {
  const block = managedInstructions('', 'https://graphyard.example');
  assert.match(block, /`complete GY-N EPOCH PR_NUMBER`[^]*ends your lease in the same transaction/);
  assert.match(block, /do not heartbeat, edit, or push after it/);
  assert.match(block, /the supervisor stops the session; that is the attempt\nending, not lease loss/);
});
