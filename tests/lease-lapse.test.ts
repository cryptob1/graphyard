import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine, readAttestations } from '../src/engine.js';
import { attestationFor, attestationsFromLedger, classifyLeaseLapse, leaseLapseCause, leaseLossAutoSettlement, leaseLossReason, leaseLossSettlementNote, settleableLeaseLoss, standingEscalations, type Attestation, type Escalation, type Principal, type Work } from '../src/model.js';
import { readMasterGuide } from './helpers/master-guide.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Each test is named for the proof it produces, so acceptance evidence maps to
// one executed case per required proof.
const human: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
// Production has no declared-human principal: the master is an admin credential declaring `ai`,
// and the operator-agent admin declares nothing at all.
const master: Principal = { id: 'master-admin', role: 'admin', sessionKind: 'ai' };
const undeclared: Principal = { id: 'production-operator-admin', role: 'admin' };
const worker: Principal = { id: 'engineer-a', role: 'worker', sessionKind: 'ai' };
const replacement: Principal = { id: 'engineer-b', role: 'worker', sessionKind: 'ai' };
let database: EmbeddedPostgres, store: Store, engine: Engine, expiring: Engine;
let pr = 1200;
const id = () => randomUUID();
const input = (title: string) => ({ title, plannedFiles: [`src/${title}.ts`], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }] });
const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
const events = async (work: Work, kind: string) => (await store.events(work.id)).filter(event => event.kind === kind);
const merge = (work: Work) => work.gates.find(gate => gate.name === 'merge')!;
const lost = (owner: string, epoch: number): Escalation => ({ trigger: 'lease-loss', reason: leaseLossReason({ owner, epoch }), at: '2026-09-19T05:20:00.000Z', actor: 'graphyard' });

before(async () => {
  const port = Number(process.env.GRAPHYARD_LEASE_LAPSE_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 14);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('lease-lapse'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [human, master, undeclared, worker, replacement];
  // Leases granted by this engine expire at once, so reconciliation sees the lapse.
  expiring = new Engine(store, [15368], 0, 'owner/project'); expiring.principals = engine.principals;
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

// A claim through the expiring engine has already lapsed by the time a workspace could be
// registered, so that attempt is left without one, as a supervisor that never started leaves it.
async function claimed(title: string, by: Engine = engine, actor: Principal = worker) {
  let work = await engine.execute(human, 'create', null, input(title), id());
  work = await engine.execute(human, 'ready', work.id, {}, id());
  work = await by.execute(actor, 'claim', work.id, {}, id());
  if (by !== engine) return work;
  return engine.execute(actor, 'workspace', work.id, { epoch: work.epoch, host: 'lapse-host', path: `/tmp/lapse/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, id());
}
// Rewrite the stored document the way the earlier deployment left it: the lease still on the
// record past its expiry, or a lease-loss escalation already standing.
async function overwrite(work: Work, mutate: (document: Work) => void) {
  const document = await reload(work); mutate(document);
  await store.pool.query('UPDATE work_items SET document=$2::jsonb WHERE id=$1', [document.id, JSON.stringify(document)]);
  return document;
}
async function standingLoss(work: Work, epoch: number) {
  return overwrite(work, document => {
    const escalation = lost(worker.id, epoch);
    document.escalations = [escalation]; document.escalation = escalation; document.mergeAuthorization = null; document.lease = null;
    const gate = document.gates.find(entry => entry.name === 'merge')!;
    gate.passed = false; gate.reasons.push(`Unresolved lease-loss escalation requires operator resolution: ${escalation.reason}`);
  });
}
const lapse = (work: Work, epoch: number) => overwrite(work, document => { document.lease = { owner: worker.id, epoch, expiresAt: '2000-01-01T00:00:00Z' }; });

test('unit:lease-lapse-classification: a lapse is expected under a submission, a carried blocked report or a stopped-worker attestation for its epoch, and lost otherwise', () => {
  const at = '2026-09-19T05:00:00.000Z';
  // Attestations are read back from the append-only ledger, in the shape the engine writes.
  const ledger = attestationsFromLedger([
    { seq: 3, actor: 'engineer-a', kind: 'blocked', at, details: { epoch: 8, reason: 'plannedFiles cannot cover the item' } },
    { seq: 2, actor: 'human-operator', kind: 'rework', at, details: { reason: 'stopped the worker myself', previousWorkerStopped: true }, workEpoch: 1 },
    { seq: 4, actor: 'engineer-a', kind: 'blocked', at, details: { epoch: 5, reason: 'waiting on a grant' } },
    { seq: 5, actor: 'engineer-a', kind: 'blocked', at, details: { epoch: 5, reason: null } },
    { seq: 6, actor: 'master-admin', kind: 'recover', at, details: { reason: 'delivered; supervisor stopped', previousWorkerStopped: true }, workEpoch: 3 },
    { seq: 7, actor: 'human-operator', kind: 'unblock', at, details: { reason: 'widened plannedFiles' } },
    { seq: 8, actor: 'engineer-a', kind: 'heartbeat', at, details: { epoch: 8 } },
    { seq: 9, actor: 'human-operator', kind: 'rework', at, details: { reason: 'no attestation flag' } , workEpoch: 9 },
  ]);
  assert.deepEqual(ledger.map(item => [item.seq, item.kind, item.source, item.epoch, item.actor]), [
    [2, 'stopped-worker', 'rework', 1, 'human-operator'],
    [3, 'blocked', 'blocked', 8, 'engineer-a'],
    [6, 'stopped-worker', 'recover-containment', 3, 'master-admin'],
  ], 'a withdrawn blocked report, an unblock, a heartbeat and a rework without the attestation are not attestations');
  assert.equal(ledger[1].reason, 'plannedFiles cannot cover the item');
  assert.deepEqual(attestationFor(ledger, 8)?.kind, 'blocked');
  assert.deepEqual(attestationFor(ledger, 8, 'stopped-worker'), null);
  assert.deepEqual(attestationFor(ledger, 5), null, 'the worker withdrew the epoch-5 report');

  const unsubmitted = { submission: null };
  const submitted = { submission: { epoch: 2, pr: 41 } };
  // GY-61's rule stands: the epoch that bound the submission is expected to lapse.
  assert.equal(classifyLeaseLapse(submitted, { epoch: 2 }), 'expired');
  assert.deepEqual(leaseLapseCause(submitted, { epoch: 2 }, ledger), { cause: 'submitted', attestation: null });
  // GY-40 epoch 8 / GY-20 epoch 11: the worker reported blocked and the operator acted.
  assert.equal(classifyLeaseLapse(unsubmitted, { epoch: 8 }, ledger), 'expired');
  assert.deepEqual(leaseLapseCause(unsubmitted, { epoch: 8 }, ledger), { cause: 'blocked-awaiting-operator', attestation: ledger[1] });
  // GY-39 / GY-59 epoch 1: the master stopped the worker itself and said so.
  assert.equal(classifyLeaseLapse(unsubmitted, { epoch: 1 }, ledger), 'expired');
  assert.deepEqual(leaseLapseCause(unsubmitted, { epoch: 1 }, ledger), { cause: 'stopped-by-attestation', attestation: ledger[0] });
  assert.equal(leaseLapseCause(unsubmitted, { epoch: 3 }, ledger)?.cause, 'stopped-by-attestation');
  // A silent lapse: no submission, no carried report, no attestation for that epoch.
  assert.equal(classifyLeaseLapse(unsubmitted, { epoch: 5 }, ledger), 'lost', 'a withdrawn blocked report explains nothing');
  assert.equal(classifyLeaseLapse(unsubmitted, { epoch: 9 }, ledger), 'lost', 'rework without the stopped-worker attestation explains nothing');
  assert.equal(classifyLeaseLapse(unsubmitted, { epoch: 7 }, ledger), 'lost');
  assert.equal(classifyLeaseLapse(unsubmitted, { epoch: 8 }), 'lost', 'without the ledger a lapse is a loss');
  assert.equal(leaseLapseCause(unsubmitted, { epoch: 7 }, ledger), null);
  // The attestation belongs to one epoch: a report for epoch 8 explains nothing about epoch 9.
  assert.equal(classifyLeaseLapse({ submission: { epoch: 8, pr: 1 } }, { epoch: 9 }, ledger), 'lost');

  // Settlement of a standing lease-loss is decided from the record and the ledger together, and
  // only for a concern the control plane raised: a lead-raised one keeps the human rule.
  const settlements = (work: Partial<Work>, attestations: Attestation[] = ledger) => settleableLeaseLoss({ submission: null, escalations: undefined, escalation: undefined, ...work } as Work, attestations).map(entry => ({ epoch: entry.epoch, cause: entry.cause, source: entry.attestation?.source ?? null, note: entry.note }));
  assert.deepEqual(settlements({ escalations: [lost('engineer-a', 8)] }), [{ epoch: 8, cause: 'blocked-awaiting-operator', source: 'blocked', note: `auto-settled: blocked report for epoch 8 explains the lapse (blocked by engineer-a at ${at})` }]);
  assert.deepEqual(settlements({ escalations: [lost('engineer-a', 1)] }), [{ epoch: 1, cause: 'stopped-by-attestation', source: 'rework', note: `auto-settled: stopped-worker attestation for epoch 1 explains the lapse (rework by human-operator at ${at})` }]);
  assert.deepEqual(settlements({ submission: { epoch: 7, pr: 3 }, escalations: [lost('engineer-a', 7)] }, []), [{ epoch: 7, cause: 'submitted', source: null, note: leaseLossAutoSettlement }]);
  assert.deepEqual(settlements({ escalations: [lost('engineer-a', 7)] }), [], 'a silent lapse is never settled automatically');
  assert.deepEqual(settlements({ escalations: [lost('engineer-a', 5)] }), [], 'a withdrawn report settles nothing');
  assert.deepEqual(settlements({ escalations: [{ ...lost('engineer-a', 8), actor: 'product-lead' }] }), [], 'a lead-raised lease-loss keeps the declared-human rule');
  assert.deepEqual(settlements({ escalations: [{ ...lost('engineer-a', 8), trigger: 'security-concern', reason: 'Credential in diff' }] }), []);
  assert.deepEqual(settlements({ escalations: [lost('engineer-a', 8)] }, []), [], 'no ledger, no settlement');
  assert.equal(leaseLossSettlementNote('submitted', null), leaseLossAutoSettlement);
});

test('integration:lease-lapse-no-escalation: a lapse after a blocked report or a stopped-worker attestation is recorded as lease.expired with its cause, and a silent lapse still escalates', async () => {
  // GY-40 epoch 8: the worker reports blocked, its session ends, the lease lapses meanwhile.
  let blocked = await claimed('lapse-after-blocked');
  const blockedEpoch = blocked.epoch;
  blocked = await engine.execute(worker, 'blocked', blocked.id, { epoch: blockedEpoch, reason: 'plannedFiles cannot cover src/server/index.ts' }, id());
  assert.equal(blocked.blocker, 'plannedFiles cannot cover src/server/index.ts');
  assert.deepEqual((await readAttestations(store.pool, blocked.id)).map(item => [item.kind, item.epoch, item.actor, item.reason]), [['blocked', blockedEpoch, worker.id, 'plannedFiles cannot cover src/server/index.ts']]);
  await lapse(blocked, blockedEpoch);
  await engine.reconcile();
  blocked = await reload(blocked);
  assert.equal(blocked.lease, null, 'the lapsed lease is cleared');
  assert.deepEqual(standingEscalations(blocked), [], 'a lapse the blocked report explains raises nothing');
  assert.equal(merge(blocked).reasons.some(reason => /lease-loss/.test(reason)), false);
  const expired = await events(blocked, 'lease.expired');
  assert.equal(expired.length, 1);
  assert.equal(expired[0].actor, 'graphyard');
  assert.deepEqual({ owner: expired[0].payload.details.owner, epoch: expired[0].payload.details.epoch, cause: expired[0].payload.details.cause, submission: expired[0].payload.details.submission },
    { owner: worker.id, epoch: blockedEpoch, cause: 'blocked-awaiting-operator', submission: null });
  assert.deepEqual({ kind: expired[0].payload.details.attestation.kind, source: expired[0].payload.details.attestation.source, actor: expired[0].payload.details.attestation.actor, epoch: expired[0].payload.details.attestation.epoch },
    { kind: 'blocked', source: 'blocked', actor: worker.id, epoch: blockedEpoch }, 'the history entry names the attestation it rests on');
  assert.deepEqual((await events(blocked, 'reconciled')).at(-1)!.payload.details, { ledger: ['lease.expired'] });
  assert.equal(blocked.lastAssignment!.owner, worker.id, 'the attempt stays attributable');
  // The operator clears the blocker afterwards; the classification already happened and stands.
  blocked = await engine.execute(human, 'unblock', blocked.id, { reason: 'Widened plannedFiles', expectedRevision: blocked.revision }, id());
  await engine.reconcile();
  assert.deepEqual(standingEscalations(await reload(blocked)), []);

  // A blocked report the worker withdrew explains nothing: that lapse is a loss.
  let withdrawn = await claimed('lapse-after-withdrawn-block');
  const withdrawnEpoch = withdrawn.epoch;
  await engine.execute(worker, 'blocked', withdrawn.id, { epoch: withdrawnEpoch, reason: 'Need the grant' }, id());
  await engine.execute(worker, 'blocked', withdrawn.id, { epoch: withdrawnEpoch, reason: null }, id());
  await lapse(withdrawn, withdrawnEpoch);
  await engine.reconcile();
  withdrawn = await reload(withdrawn);
  assert.deepEqual(standingEscalations(withdrawn).map(entry => [entry.trigger, entry.actor]), [['lease-loss', 'graphyard']]);
  assert.equal((await events(withdrawn, 'lease.expired')).length, 0);

  // GY-39 / GY-59 epoch 1: the master stopped the worker and attested it with rework while
  // the lease was still live; the discarded lease is history under that attestation.
  let stoppedLive = await claimed('lapse-after-rework-live');
  const liveEpoch = stoppedLive.epoch;
  stoppedLive = await engine.execute(master, 'rework', stoppedLive.id, { reason: 'Stopped the cursor session myself to re-dispatch', previousWorkerStopped: true }, id());
  assert.equal(stoppedLive.lease, null);
  assert.deepEqual(standingEscalations(stoppedLive), []);
  const discarded = await events(stoppedLive, 'lease.expired');
  assert.deepEqual(discarded.map(event => [event.payload.details.epoch, event.payload.details.cause, event.payload.details.attestation.source, event.payload.details.attestation.actor, event.payload.details.attestation.reason]),
    [[liveEpoch, 'stopped-by-attestation', 'rework', master.id, 'Stopped the cursor session myself to re-dispatch']]);
  assert.deepEqual((await readAttestations(store.pool, stoppedLive.id)).map(item => [item.kind, item.source, item.epoch, item.actor]), [['stopped-worker', 'rework', liveEpoch, master.id]]);
  await engine.reconcile();
  assert.deepEqual(standingEscalations(await reload(stoppedLive)), []);

  // A replacement claim over a lapsed lease classifies the lapse the same way reconciliation
  // would: explained by the epoch's blocked report, it is history, not an escalation.
  let replaced = await claimed('lapse-replaced-after-blocked');
  const replacedEpoch = replaced.epoch;
  await engine.execute(worker, 'blocked', replaced.id, { epoch: replacedEpoch, reason: 'Waiting on the operator' }, id());
  await engine.execute(human, 'unblock', replaced.id, { reason: 'Cleared', expectedRevision: (await reload(replaced)).revision }, id());
  await lapse(replaced, replacedEpoch);
  replaced = await engine.execute(replacement, 'claim', replaced.id, {}, id());
  assert.equal(replaced.lease!.owner, replacement.id);
  assert.deepEqual(standingEscalations(replaced), []);
  assert.deepEqual((await events(replaced, 'lease.expired')).map(event => [event.payload.details.epoch, event.payload.details.cause]), [[replacedEpoch, 'blocked-awaiting-operator']]);
  await engine.execute(replacement, 'release', replaced.id, { epoch: replaced.epoch }, id());

  // A silent lapse is still an abandoned assignment: it escalates, refuses the merge gate, and
  // neither reconciliation nor an undeclared admin clears it.
  let vanished = await claimed('lapse-silent', expiring);
  const vanishedEpoch = vanished.epoch;
  await engine.reconcile();
  vanished = await reload(vanished);
  assert.equal(vanished.lease, null);
  assert.deepEqual(standingEscalations(vanished).map(entry => [entry.trigger, entry.reason, entry.actor]), [['lease-loss', `Worker ${worker.id} lost lease epoch ${vanishedEpoch}`, 'graphyard']]);
  assert.match(merge(vanished).reasons.join(' '), /Unresolved lease-loss escalation/);
  assert.equal((await events(vanished, 'lease.expired')).length, 0, 'a vanished worker is an incident, not an expiry');
  await engine.reconcile();
  assert.deepEqual(standingEscalations(await reload(vanished)).map(entry => entry.trigger), ['lease-loss'], 'nothing in the ledger explains it, so nothing settles it');
  await assert.rejects(engine.execute(master, 'resolve', vanished.id, { trigger: 'lease-loss', reason: 'Automation says fine', expectedRevision: vanished.revision }, id()), /requires a declared human session; master-admin is ai/);
  await assert.rejects(engine.execute(master, 'resolve', vanished.id, { trigger: 'lease-loss', reason: 'Citing what is not there', expectedRevision: vanished.revision, attestation: { kind: 'stopped-worker', epoch: vanishedEpoch } }, id()), /The ledger holds no stopped-worker attestation for epoch/);
  await assert.rejects(engine.execute(master, 'resolve', vanished.id, { trigger: 'lease-loss', reason: 'Citing what is not there', expectedRevision: vanished.revision, attestation: { kind: 'blocked', epoch: vanishedEpoch } }, id()), /The ledger holds no blocked report for epoch/);
  assert.deepEqual(standingEscalations(await reload(vanished)).map(entry => entry.trigger), ['lease-loss']);
});

test('integration:lease-loss-admin-settlement: an admin of any session kind resolves a reconcile-raised lease-loss by citing the attestation; human-only triggers stay human-only', async () => {
  // A standing lease-loss the earlier deployment raised for an epoch that had reported blocked.
  let item = await claimed('admin-settles-blocked');
  const epoch = item.epoch;
  await engine.execute(worker, 'blocked', item.id, { epoch, reason: 'plannedFiles cannot cover the item' }, id());
  item = await standingLoss(item, epoch);
  assert.match(merge(item).reasons.join(' '), /Unresolved lease-loss escalation/);
  // The citation is verified: the wrong kind, the wrong epoch, and no citation at all are refused
  // for a session that is not a declared human.
  await assert.rejects(engine.execute(master, 'resolve', item.id, { trigger: 'lease-loss', reason: 'Settling', expectedRevision: item.revision }, id()), /Escalation resolution requires a declared human session; master-admin is ai\. An admin session of any kind may settle only a control-plane-raised lease-loss/);
  await assert.rejects(engine.execute(undeclared, 'resolve', item.id, { trigger: 'lease-loss', reason: 'Settling', expectedRevision: item.revision }, id()), /production-operator-admin is undeclared/);
  await assert.rejects(engine.execute(master, 'resolve', item.id, { trigger: 'lease-loss', reason: 'Settling', expectedRevision: item.revision, attestation: { kind: 'stopped-worker', epoch } }, id()), /The ledger holds no stopped-worker attestation for epoch/);
  await assert.rejects(engine.execute(master, 'resolve', item.id, { trigger: 'lease-loss', reason: 'Settling', expectedRevision: item.revision, attestation: { kind: 'blocked', epoch: epoch + 1 } }, id()), new RegExp(`The standing lease-loss belongs to epoch ${epoch}; cite that epoch's attestation`));
  await assert.rejects(engine.execute(worker, 'resolve', item.id, { trigger: 'lease-loss', reason: 'Settling', expectedRevision: item.revision, attestation: { kind: 'blocked', epoch } }, id()), /Operator permission required/);
  assert.deepEqual(standingEscalations(await reload(item)).map(entry => entry.trigger), ['lease-loss']);
  // The undeclared production admin, citing the blocked report, settles it; the audit entry
  // records who, why and which attestation.
  item = await engine.execute(undeclared, 'resolve', item.id, { trigger: 'lease-loss', reason: 'GY-40 epoch 8 reported blocked; requirements were revised and the item re-dispatched', expectedRevision: item.revision, attestation: { kind: 'blocked', epoch } }, id());
  assert.deepEqual(standingEscalations(item), []);
  assert.equal(merge(item).reasons.some(reason => /lease-loss/.test(reason)), false);
  const resolved = await events(item, 'escalation.resolved');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].actor, undeclared.id);
  assert.deepEqual({ trigger: resolved[0].payload.details.trigger, epoch: resolved[0].payload.details.epoch, resolvedBy: resolved[0].payload.details.resolvedBy, sessionKind: resolved[0].payload.details.sessionKind, reason: resolved[0].payload.details.reason },
    { trigger: 'lease-loss', epoch, resolvedBy: undeclared.id, sessionKind: 'undeclared', reason: 'GY-40 epoch 8 reported blocked; requirements were revised and the item re-dispatched' });
  assert.deepEqual({ kind: resolved[0].payload.details.attestation.kind, source: resolved[0].payload.details.attestation.source, epoch: resolved[0].payload.details.attestation.epoch, actor: resolved[0].payload.details.attestation.actor, reason: resolved[0].payload.details.attestation.reason },
    { kind: 'blocked', source: 'blocked', epoch, actor: worker.id, reason: 'plannedFiles cannot cover the item' });
  assert.deepEqual(resolved[0].payload.details.escalation, lost(worker.id, epoch), 'the settled incident is kept verbatim');
  // The `resolve` event itself carries the citation as the request data.
  assert.deepEqual((await events(item, 'resolve')).at(-1)!.payload.details.attestation, { kind: 'blocked', epoch });

  // The stopped-worker attestation recorded after the lapse — the master stopped the worker,
  // the lease lapsed, and rework attested it afterwards — is citable the same way.
  let stopped = await claimed('admin-settles-stopped', expiring);
  const stoppedEpoch = stopped.epoch;
  await engine.reconcile();
  stopped = await reload(stopped);
  assert.deepEqual(standingEscalations(stopped).map(entry => entry.trigger), ['lease-loss'], 'nothing explained the lapse when it happened');
  stopped = await engine.execute(master, 'rework', stopped.id, { reason: 'Stopped the worker session to re-dispatch under a new profile', previousWorkerStopped: true }, id());
  assert.deepEqual(standingEscalations(stopped).map(entry => entry.trigger), ['lease-loss'], 'rework of a lapsed lease discards nothing and settles nothing by itself');
  stopped = await engine.execute(master, 'resolve', stopped.id, { trigger: 'lease-loss', reason: 'I stopped that worker; see the rework attestation', expectedRevision: stopped.revision, attestation: { kind: 'stopped-worker', epoch: stoppedEpoch } }, id());
  assert.deepEqual(standingEscalations(stopped), []);
  const cited = (await events(stopped, 'escalation.resolved'))[0].payload.details.attestation;
  assert.deepEqual({ kind: cited.kind, source: cited.source, epoch: cited.epoch, actor: cited.actor }, { kind: 'stopped-worker', source: 'rework', epoch: stoppedEpoch, actor: master.id });

  // Human-only triggers keep the declared-human rule whatever is cited: a security concern, a
  // requirement-weakening revision, and a lease-loss a lead raised rather than the control plane.
  let concern = await claimed('admin-cannot-settle-human-only');
  const concernEpoch = concern.epoch;
  await engine.execute(worker, 'blocked', concern.id, { epoch: concernEpoch, reason: 'Blocked' }, id());
  const security: Escalation = { trigger: 'security-concern', reason: 'Credential-shaped string in the diff', at: '2026-09-19T05:21:00.000Z', actor: 'product-lead' };
  const weakening: Escalation = { trigger: 'requirement-weakening', reason: 'Requirement revision retires AC-2', at: '2026-09-19T05:22:00.000Z', actor: human.id };
  const leadRaised: Escalation = { ...lost(worker.id, concernEpoch), actor: 'product-lead' };
  concern = await overwrite(concern, document => { document.escalations = [security, weakening, leadRaised]; document.escalation = security; });
  for (const [trigger, message] of [['security-concern', /Only a lease-loss raised by the control plane is settled by citing an attestation; the standing security-concern was raised by product-lead/], ['requirement-weakening', /the standing requirement-weakening was raised by human-operator/], ['lease-loss', /the standing lease-loss was raised by product-lead/]] as const) {
    await assert.rejects(engine.execute(master, 'resolve', concern.id, { trigger, reason: 'Settling', expectedRevision: concern.revision, attestation: { kind: 'blocked', epoch: concernEpoch } }, id()), message);
    await assert.rejects(engine.execute(master, 'resolve', concern.id, { trigger, reason: 'Settling', expectedRevision: concern.revision }, id()), /requires a declared human session/);
    await assert.rejects(engine.execute(undeclared, 'resolve', concern.id, { trigger, reason: 'Settling', expectedRevision: concern.revision }, id()), /requires a declared human session/);
  }
  await engine.reconcile();
  concern = await reload(concern);
  assert.deepEqual(standingEscalations(concern).map(entry => entry.trigger), ['security-concern', 'requirement-weakening', 'lease-loss'], 'reconciliation settles none of them: the lead-raised lease-loss is not the control plane\'s');
  // The declared human still resolves each, with or without a citation.
  concern = await engine.execute(human, 'resolve', concern.id, { trigger: 'security-concern', reason: 'Reviewed: a test fixture, not a credential', expectedRevision: concern.revision }, id());
  concern = await engine.execute(human, 'resolve', concern.id, { trigger: 'lease-loss', reason: 'Lead concern reviewed; worker was blocked', expectedRevision: concern.revision }, id());
  assert.deepEqual(standingEscalations(concern).map(entry => entry.trigger), ['requirement-weakening']);
  assert.equal((await events(concern, 'escalation.resolved')).length, 2);
  assert.equal((await events(concern, 'escalation.resolved')).every(event => event.payload.details.sessionKind === 'human' && event.payload.details.attestation === null), true);
});

test('integration:lease-loss-backlog-attested: standing reconcile-raised lease-loss escalations whose epoch has a blocked report or a stopped-worker attestation are settled on deploy with an audited note', async () => {
  // GY-40 (epoch 8) and GY-20 (epoch 11): the worker reported blocked, the master revised the
  // requirements, and the lease lapsed meanwhile under the earlier deployment's rule.
  let blockedItem = await claimed('backlog-blocked');
  const blockedEpoch = blockedItem.epoch;
  await engine.execute(worker, 'blocked', blockedItem.id, { epoch: blockedEpoch, reason: 'plannedFiles could not cover the item' }, id());
  blockedItem = await standingLoss(blockedItem, blockedEpoch);
  blockedItem = await engine.execute(human, 'unblock', blockedItem.id, { reason: 'Widened plannedFiles', expectedRevision: blockedItem.revision }, id());
  await engine.execute(human, 'requirements', blockedItem.id, { expectedPolicyRevision: 1, reason: 'Widen plannedFiles', criteria: blockedItem.criteria, dependencies: [], plannedFiles: ['src/', 'tests/'], exclusiveResources: [] }, id());
  blockedItem = await reload(blockedItem);
  assert.deepEqual(standingEscalations(blockedItem).map(entry => entry.trigger), ['lease-loss'], 'the operator actions did not touch the standing incident');
  await engine.reconcile();
  blockedItem = await reload(blockedItem);
  assert.deepEqual(standingEscalations(blockedItem), [], 'settled without a human');
  assert.equal(blockedItem.escalation, null);
  assert.equal(merge(blockedItem).reasons.some(reason => /lease-loss/.test(reason)), false, 'the merge gate no longer refuses on it');
  let settled = await events(blockedItem, 'escalation.auto-settled');
  assert.equal(settled.length, 1);
  assert.equal(settled[0].actor, 'graphyard');
  assert.deepEqual({ trigger: settled[0].payload.details.trigger, epoch: settled[0].payload.details.epoch, cause: settled[0].payload.details.cause, escalation: settled[0].payload.details.escalation },
    { trigger: 'lease-loss', epoch: blockedEpoch, cause: 'blocked-awaiting-operator', escalation: lost(worker.id, blockedEpoch) });
  assert.match(settled[0].payload.details.note, new RegExp(`^auto-settled: blocked report for epoch ${blockedEpoch} explains the lapse \\(blocked by ${worker.id} at `));
  assert.deepEqual({ kind: settled[0].payload.details.attestation.kind, epoch: settled[0].payload.details.attestation.epoch, actor: settled[0].payload.details.attestation.actor, reason: settled[0].payload.details.attestation.reason },
    { kind: 'blocked', epoch: blockedEpoch, actor: worker.id, reason: 'plannedFiles could not cover the item' }, 'the audit entry names the attestation it rests on');
  assert.deepEqual((await events(blockedItem, 'reconciled')).at(-1)!.payload.details, { ledger: ['escalation.auto-settled'] });
  await engine.reconcile();
  assert.equal((await events(blockedItem, 'escalation.auto-settled')).length, 1, 'settlement is recorded once');

  // GY-39 and GY-59 (epoch 1): the master stopped the worker itself, the lease lapsed, and the
  // stopped-worker attestation is in the rework reason.
  let stoppedItem = await claimed('backlog-stopped', expiring);
  const stoppedEpoch = stoppedItem.epoch;
  await engine.reconcile();
  stoppedItem = await reload(stoppedItem);
  assert.deepEqual(standingEscalations(stoppedItem).map(entry => entry.trigger), ['lease-loss']);
  await engine.reconcile();
  assert.deepEqual(standingEscalations(await reload(stoppedItem)).map(entry => entry.trigger), ['lease-loss'], 'until the attestation exists, it stands');
  stoppedItem = await engine.execute(master, 'rework', stoppedItem.id, { reason: 'Master stopped the worker: cursor profile replaced', previousWorkerStopped: true }, id());
  assert.deepEqual(standingEscalations(stoppedItem).map(entry => entry.trigger), ['lease-loss'], 'rework itself clears no escalation');
  await engine.reconcile();
  stoppedItem = await reload(stoppedItem);
  assert.deepEqual(standingEscalations(stoppedItem), []);
  settled = await events(stoppedItem, 'escalation.auto-settled');
  assert.deepEqual({ epoch: settled[0].payload.details.epoch, cause: settled[0].payload.details.cause, source: settled[0].payload.details.attestation.source, actor: settled[0].payload.details.attestation.actor, reason: settled[0].payload.details.attestation.reason },
    { epoch: stoppedEpoch, cause: 'stopped-by-attestation', source: 'rework', actor: master.id, reason: 'Master stopped the worker: cursor profile replaced' });
  assert.match(settled[0].payload.details.note, new RegExp(`^auto-settled: stopped-worker attestation for epoch ${stoppedEpoch} explains the lapse \\(rework by ${master.id} at `));

  // The single-field legacy document shape is settled the same way.
  let legacy = await claimed('backlog-legacy');
  const legacyEpoch = legacy.epoch;
  await engine.execute(worker, 'blocked', legacy.id, { epoch: legacyEpoch, reason: 'Blocked on a grant' }, id());
  legacy = await overwrite(legacy, document => { delete document.escalations; document.escalation = lost(worker.id, legacyEpoch); document.lease = null; });
  await engine.reconcile();
  legacy = await reload(legacy);
  assert.deepEqual(standingEscalations(legacy), []);
  assert.equal((await events(legacy, 'escalation.auto-settled')).length, 1);

  // Every other standing concern stays, and a lease-loss whose epoch has no report or attestation
  // — a worker that vanished — is left for a human, as is one an attestation for another epoch
  // does not explain.
  let mixed = await claimed('backlog-mixed');
  const mixedEpoch = mixed.epoch;
  await engine.execute(worker, 'blocked', mixed.id, { epoch: mixedEpoch, reason: 'Blocked' }, id());
  const security: Escalation = { trigger: 'security-concern', reason: 'Credential-shaped string in the diff', at: '2026-09-19T05:21:00.000Z', actor: 'product-lead' };
  mixed = await overwrite(mixed, document => { document.escalations = [security, lost(worker.id, mixedEpoch)]; document.escalation = security; document.lease = null; });
  await engine.reconcile();
  mixed = await reload(mixed);
  assert.deepEqual(standingEscalations(mixed), [security], 'the security concern still stands and still needs a human');
  assert.match(merge(mixed).reasons.join(' '), /Unresolved security-concern escalation/);
  let genuine = await claimed('backlog-genuine', expiring);
  await engine.reconcile();
  genuine = await reload(genuine);
  assert.deepEqual(standingEscalations(genuine).map(entry => entry.trigger), ['lease-loss']);
  await engine.reconcile();
  assert.deepEqual(standingEscalations(await reload(genuine)).map(entry => entry.trigger), ['lease-loss'], 'never settled automatically: nothing in the ledger explains it');
  assert.equal((await events(genuine, 'escalation.auto-settled')).length, 0);
  let otherEpoch = await claimed('backlog-other-epoch');
  await engine.execute(worker, 'blocked', otherEpoch.id, { epoch: otherEpoch.epoch, reason: 'Blocked' }, id());
  otherEpoch = await overwrite(otherEpoch, document => { document.escalations = [lost(worker.id, document.epoch + 3)]; document.escalation = document.escalations[0]; });
  await engine.reconcile();
  assert.deepEqual(standingEscalations(await reload(otherEpoch)).map(entry => entry.trigger), ['lease-loss']);
  assert.equal((await events(otherEpoch, 'escalation.auto-settled')).length, 0);
});

test('manual:escalation-docs: the delegation, master-agent and lease docs describe the lapse classification and who may settle what', async () => {
  const delegation = await readFile(new URL('../docs/delegation.md', import.meta.url), 'utf8');
  const masterGuide = await readMasterGuide();
  const leases = await readFile(new URL('../docs/protocol/leases.md', import.meta.url), 'utf8');
  // The escalation table names what raises lease-loss and what is history instead.
  assert.match(delegation, /\| `lease-loss` \|[^\n]*no submission, no carried `blocked` report[^\n]*no stopped-worker attestation/);
  assert.match(delegation, /`blocked-awaiting-operator`/);
  assert.match(delegation, /`stopped-by-attestation`/);
  // Who may settle what.
  assert.match(delegation, /### Who may settle what/);
  assert.match(delegation, /--attestation blocked\\?\|stopped-worker/);
  assert.match(delegation, /`security-concern`, `requirement-weakening`[^\n]*lead[^\n]*declared human session/);
  assert.match(delegation, /`escalation\.resolved`/);
  assert.match(delegation, /auto-settled: blocked report for epoch N explains the lapse/);
  assert.match(delegation, /auto-settled: stopped-worker attestation for epoch N explains the lapse/);
  // The master guide tells the master which lapses need nobody and which it can settle itself.
  assert.match(masterGuide, /blocked-awaiting-operator/);
  assert.match(masterGuide, /stopped-by-attestation/);
  assert.match(masterGuide, /resolve GY-N lease-loss --attestation/);
  assert.match(masterGuide, /cmdline and cwd/);
  assert.match(masterGuide, /recorded scope/i);
  // The lease protocol page carries the classification and the scope record.
  assert.match(leases, /blocked-awaiting-operator/);
  assert.match(leases, /stopped-by-attestation/);
  assert.match(leases, /scope unit/);
});
