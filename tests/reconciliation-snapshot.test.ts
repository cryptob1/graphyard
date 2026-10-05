import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { Store, resolvedPayloadSql } from '../src/store.js';
import { Engine, historicalAuthorizationRefusals, unauthorizedMergeViolation } from '../src/engine.js';
import { server } from '../src/server.js';
import { buildMasterStatus } from '../src/master.js';
import type { Observation, Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-94, as GitHub delivers (GY-1235): the record a merge is judged against is the last snapshot
 * that precedes the merge itself, never one that already reports it; the merge's own consequences
 * never refuse the reconciliation that clears them; and a delivery an operator authorized after the
 * record refused it is recorded as exactly that. Each test is named for the proof it produces and
 * runs the real engine on a disposable Postgres.
 */
const repository = 'owner/project';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const approver: Principal = { id: 'approver', role: 'admin', sessionKind: 'ai' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const producer: Principal = { id: 'proof-runner', role: 'producer', proofs: ['integration:claim-safety'] };
const principals = [operator, approver, worker, coordinator, producer];
const credentials = principals.map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
// The master's agent pair, as production provisions it: operator-agent identities, never admins.
const masterAgent = { id: 'master-operator-agent', token: `master-operator-agent-${'m'.repeat(32)}`, capabilities: ['decision:merge', 'decision:attest', 'decision:rework'] };
const approverAgent = { id: 'approver-agent', token: `approver-agent-${'a'.repeat(32)}`, capabilities: ['decision:approve'] };
const base = 'b'.repeat(40);
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
let pg: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
let serial = 0;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 25;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('reconciliation-snapshot'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('reconciliation_snapshot_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/reconciliation_snapshot_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  for (const agent of [masterAgent, approverAgent])
    await call(token(operator), 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Onboarding provisions the master agent pair' });
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (pg) await pg.stop(); });

const id = () => randomUUID();
const reload = async (workId: string) => (await store.list()).find(item => item.id === workId)!;
const events = async (workId: string, kind: string) => (await store.pool.query('SELECT actor, payload, created_at FROM events WHERE work_id=$1 AND kind=$2 ORDER BY seq', [workId, kind])).rows;
const dbNow = async () => ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString();
/** GitHub reports mergedAt to the second: the whole second the database clock is in right now. */
const wholeSecondNow = async () => new Date(Math.floor(Date.parse(await dbNow()) / 1000) * 1000).toISOString().replace('.000Z', 'Z');
const waitUntil = async (instant: number) => { while (Date.parse(await dbNow()) < instant) await delay(25); };
const head = (work: Work) => work.candidate?.sha ?? sha(work.key);
const observation = (work: Work, extra: Partial<Observation> = {}): Observation => ({ clockOffset: { min: 0, max: 0 }, candidate: { sha: head(work), baseSha: base, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' },
  checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'reviewer', sha: head(work), state: 'APPROVED' }],
  protected: true, mergeable: true, merged: false, mergeSha: null, baseTip: base, baseTree: '7e'.repeat(20), files: [], scopeFiles: [], at: new Date().toISOString(), ...extra });
/** A merged observation at a whole-second provider timestamp, with the base branch advanced to the merge commit. */
const mergedAt = async (work: Work, mergeSha: string) => observation(work, { merged: true, mergeable: false, prState: 'closed', mergeSha, mergedAt: await wholeSecondNow(), baseTip: mergeSha, baseTree: sha(`tree-${mergeSha}`) });
const call = async (credential: string, path: string, body: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
  const result = await response.json() as any; assert.equal(response.status, 200, JSON.stringify(result)); return result;
};
/** A two-party merge decision for the observed candidate: requested by one identity, approved by an independent one. */
async function mergeDecision(work: Work, reason: string, requester = token(operator), approvedBy = token(approver)) {
  const decision = await call(requester, `work/${work.key}/decide`, { action: 'merge', input: { sha: head(work), baseSha: base, policyRevision: work.policyRevision }, reason });
  await call(approvedBy, `work/${work.key}/approve`, { decision: decision.id, reason: `Approved: ${reason}` });
  return decision.id as string;
}

/** A submitted candidate observed at its head: approved, it passes every gate; unapproved, its review gate refuses. */
async function candidate(options: { approved?: boolean } = {}) {
  const { approved = true } = options;
  const n = ++serial;
  let w = await engine.execute(operator, 'create', null, { title: `Reconciliation ${n}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, id());
  w = await engine.execute(operator, 'ready', w.id, {}, id()); w = await engine.execute(worker, 'claim', w.id, {}, id());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/reconciliation-${n}`, branch: `graphyard/gy-94-${n}` }, id());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: 900 + n }, id());
  w = await engine.observe(w.id, w.revision, observation(w, approved ? {} : { reviews: [] }));
  if (approved) { assert.equal(w.stage, 'merge'); assert.ok(w.gates.every(gate => gate.passed), w.gates.flatMap(gate => gate.reasons).join('; ')); }
  else assert.equal(w.stage, 'review');
  return w;
}
// Every ledger row whose document already reports the merge, whole or resolved from its delta.
const snapshotsReporting = async (workId: string, mergeSha: string) => (await store.pool.query(`SELECT created_at, whole, payload->'work' AS work FROM (SELECT created_at, payload ? 'work' AS whole, ${resolvedPayloadSql()} AS payload FROM events WHERE work_id=$1 ORDER BY seq) e
  WHERE payload->'work'->'observation'->>'mergeSha'=$2`, [workId, mergeSha])).rows as { created_at: Date; whole: boolean; work: Work }[];

test('integration:reconciliation-snapshot-precedes-merge — GY-81 exactly: a whole-second mergedAt and post-merge observations inside the whole-second cutoff window; the merge is judged against the last snapshot that precedes it, never one that already reports it', async () => {
  // A head whose gates passed: GitHub's merge of it is the delivery, citing the last pre-merge snapshot.
  const passing = await candidate();
  const passingRecord = await reload(passing.id);
  await delay(1100);
  const landed = await engine.observe(passing.id, passingRecord.revision, await mergedAt(passing, sha(`merge-${passing.key}`)));
  assert.equal(landed.stage, 'done', landed.violations.join(' | '));
  assert.equal(landed.delivery!.authorizationRevision, passingRecord.revision, 'the delivery cites the last snapshot that precedes the merge');
  assert.equal('reconciliation' in landed.delivery!, false);

  // A head merged before its review passed. Approvals observed after the merge, inside the
  // whole-second cutoff window, must never stand in for the record before it.
  const work = await candidate({ approved: false });
  const mergeSha = sha(`merge-${work.key}`);
  const preMerge = await reload(work.id);
  assert.equal(preMerge.gates.find(gate => gate.name === 'review')!.passed, false, 'the record before the merge had not passed review');
  // The merge lands in a later whole second than the last pre-merge record, as GitHub reports it,
  // early in that second so the post-merge observations below fall inside its whole-second cutoff window.
  await delay(1100);
  await waitUntil(Math.ceil(Date.parse(await dbNow()) / 1000) * 1000 + 10);
  const merged = { ...await mergedAt(work, mergeSha), reviews: [] };
  const providerMergedTime = Date.parse(merged.mergedAt!);
  const oldCutoff = providerMergedTime + 1000;
  let current = await engine.observe(work.id, preMerge.revision, merged);
  assert.notEqual(current.stage, 'done'); assert.ok(current.violations.includes(unauthorizedMergeViolation)); assert.equal(current.delivery, undefined);
  // GitHub now reports the approval: the post-merge snapshot passes review.
  const approvedAfter = { ...merged, reviews: [{ reviewer: 'reviewer', sha: head(work), state: 'APPROVED' }], at: new Date().toISOString() };
  current = await engine.observe(work.id, current.revision, approvedAfter);
  assert.equal(current.gates.find(gate => gate.name === 'review')!.passed, true, 'the record written after the merge passes review');
  // Read again unchanged: a routine observation, stored as a delta row (store/snapshot-delta.ts, GY-979).
  current = await engine.observe(work.id, current.revision, { ...approvedAfter, at: new Date().toISOString() });
  // The poisoned snapshots: written inside the old window, each already reporting the merge and
  // carrying its consequences — the violation, and an approval that came after it.
  const poisoned = await snapshotsReporting(work.id, mergeSha);
  assert.equal(poisoned.length, 3);
  assert.ok(poisoned.some(snapshot => !snapshot.whole), 'a routine observation stores only what changed and still resolves to a document reporting the merge');
  for (const snapshot of poisoned) {
    assert.ok(snapshot.created_at.getTime() < oldCutoff, `post-merge snapshot at ${snapshot.created_at.toISOString()} falls inside the old cutoff window ending ${new Date(oldCutoff).toISOString()}`);
    assert.ok(snapshot.work.observation!.merged); assert.ok(snapshot.work.violations.includes(unauthorizedMergeViolation));
  }
  assert.ok(poisoned.some(snapshot => snapshot.work.gates.find(gate => gate.name === 'review')!.passed), 'a poisoned snapshot shows the approval');
  // The recovery, requested after the cutoff: the pre-merge snapshot is the one judged, so the
  // decision is refused for the review it lacked, once, and nothing is delivered.
  await waitUntil(oldCutoff);
  const decision = await mergeDecision(current, `Reconcile ${work.key}: GitHub merged ${mergeSha.slice(0, 12)} before its review was observed`);
  current = await engine.observe(work.id, (await reload(work.id)).revision, { ...approvedAfter, at: new Date().toISOString() });
  assert.notEqual(current.stage, 'done'); assert.equal(current.delivery, undefined);
  const refusal = current.violations.find(entry => entry.startsWith(`Reconciliation by decision ${decision} refused: `))!;
  assert.ok(refusal, current.violations.join(' | ')); assert.match(refusal, /gate review had not passed/);
  assert.equal((await events(work.id, 'merge.reconciliation.refused')).length, 1);
  assert.equal((await events(work.id, 'merge.reconciled')).length, 0);
});

test('integration:reconciliation-refusal-not-circular — the unauthorized-merge violation a reconciliation clears, an earlier refusal, and a merge gate that only reports what GitHub answers never refuse an otherwise sound reconciliation; every other refusal stands, and the delivery judgement stays strict', async () => {
  const work = await candidate();
  const mergeSha = sha(`merge-${work.key}`);
  // The merge lands in a later whole second than the last pre-merge record, as GitHub reports it.
  await delay(1100);
  const merged = await mergedAt(work, mergeSha);
  const providerMergedTime = Date.parse(merged.mergedAt!);
  const cutoff = providerMergedTime + 1000;
  const all = await store.list();
  const sound = await reload(work.id);
  assert.equal(sound.mergeAuthorization ?? null, null, 'no merge authorization is recorded (GY-1235)');
  const judge = (past: Work, options?: { reconciling?: boolean }) => historicalAuthorizationRefusals(past, all, merged, cutoff, providerMergedTime, options);
  assert.deepEqual(judge(sound), [], 'the real pre-merge record is sound');
  assert.deepEqual(judge(sound, { reconciling: true }), []);
  // GY-81's poisoned snapshot: what the merge itself wrote.
  const poisoned: Work = { ...sound, violations: [unauthorizedMergeViolation, `Reconciliation by decision ${randomUUID()} refused: violation stood: ${unauthorizedMergeViolation}`],
    gates: sound.gates.map(gate => gate.name === 'merge' ? { ...gate, passed: false, reasons: ['Pull request is not mergeable against the current base'] } : gate) };
  assert.deepEqual(judge(poisoned, { reconciling: true }), [], 'neither the violation nor GitHub\'s post-merge mergeability refuses the reconciliation');
  // The same record judged for a delivery is refused for the violation it carries.
  const strict = judge(poisoned);
  assert.deepEqual(strict, [`violation stood: ${unauthorizedMergeViolation}`, `violation stood: ${poisoned.violations[1]}`]);
  // A merge gate refusing for anything GitHub does not answer still refuses, and so does any other
  // violation and any other gate.
  const held: Work = { ...poisoned, gates: sound.gates.map(gate => gate.name === 'merge' ? { ...gate, passed: false, reasons: ['Pull request is not mergeable against the current base', 'Unresolved lease-loss escalation requires operator resolution'] } : gate) };
  assert.deepEqual(judge(held, { reconciling: true }), ['gate merge had not passed: Unresolved lease-loss escalation requires operator resolution']);
  const otherViolation: Work = { ...poisoned, violations: [...poisoned.violations, 'Post-merge checks differ from the recorded authorization; follow-up required'] };
  assert.deepEqual(judge(otherViolation, { reconciling: true }), ['violation stood: Post-merge checks differ from the recorded authorization; follow-up required']);
  const unreviewed: Work = { ...poisoned, gates: sound.gates.map(gate => gate.name === 'review' ? { ...gate, passed: false, reasons: ['Independent approval of the current commit is required'] } : gate) };
  assert.deepEqual(judge(unreviewed, { reconciling: true }), ['gate review had not passed: Independent approval of the current commit is required']);
  const otherHead: Work = { ...sound, candidate: { ...sound.candidate!, sha: sha('another-head') } };
  assert.match(judge(otherHead).join(' | '), /not the merged head/);
  // Proofs gate nothing: a record without evidence is judged on its gates alone.
  assert.deepEqual(judge({ ...sound, evidence: [] }), []);
  // End to end: GitHub's merge of the sound record is delivered on the merged observation itself,
  // with no decision, although that observation carries GitHub's post-merge mergeability.
  const current = await engine.observe(work.id, sound.revision, merged);
  assert.equal(current.stage, 'done', current.violations.join(' | '));
  assert.deepEqual(current.violations, []);
  assert.equal(current.delivery!.authorizationRevision, sound.revision);
  assert.equal((await events(work.id, 'merge.reconciled')).length, 0, 'no reconciliation was needed');
});

test('integration:operator-authorized-delivery — a merge whose gates had not passed and the record refuses is delivered only on a decision an operator owns: an admin credential on one side, citing the refusal; the delivery states that no execution authorized it, names the operator, both reasons and what the record lacked, and is distinguishable in the ledger and in master status from a reconciled delivery', async () => {
  // GY-92: an unreviewed candidate the operator merged administratively while the review gate was open.
  const work = await candidate({ approved: false });
  const unreviewed = { reviews: [] };
  const mergeSha = sha(`merge-${work.key}`);
  const merged = { ...await mergedAt(work, mergeSha), ...unreviewed };
  const cutoff = Date.parse(merged.mergedAt!) + 1000;
  let current = await engine.observe(work.id, (await reload(work.id)).revision, merged);
  assert.ok(current.violations.includes(unauthorizedMergeViolation));
  await waitUntil(cutoff);
  // The master's agent pair asks for a reconciliation: the record refuses it, with what it lacked.
  const first = await mergeDecision(current, `Reconcile ${work.key} after the administrative merge`, masterAgent.token, approverAgent.token);
  current = await engine.observe(work.id, (await reload(work.id)).revision, { ...merged, at: new Date().toISOString() });
  assert.equal(current.stage, 'review');
  const refusal = current.violations.find(entry => entry.startsWith(`Reconciliation by decision ${first} refused: `))!;
  assert.match(refusal, /gate review had not passed: Independent approval of the current commit is required/);
  // The same pair citing the refusal is still not an operator: refused again, saying why.
  const pair = await mergeDecision(current, `Operator authorized the administrative merge; overrides ${first}`, masterAgent.token, approverAgent.token);
  current = await engine.observe(work.id, (await reload(work.id)).revision, { ...merged, at: new Date().toISOString() });
  assert.equal(current.stage, 'review'); assert.equal(current.delivery, undefined);
  const agentRefusal = current.violations.find(entry => entry.startsWith(`Reconciliation by decision ${pair} refused: `))!;
  assert.match(agentRefusal, new RegExp(`an operator-authorized delivery needs an admin credential as requester or approver; ${masterAgent.id} is operator-agent and ${approverAgent.id} is operator-agent`));
  // A decision that does not cite the refusal is a plain reconciliation attempt, refused on the record.
  const uncited = await mergeDecision(current, 'The operator says this merge is fine', masterAgent.token, token(operator));
  current = await engine.observe(work.id, (await reload(work.id)).revision, { ...merged, at: new Date().toISOString() });
  assert.equal(current.delivery, undefined);
  assert.doesNotMatch(current.violations.find(entry => entry.startsWith(`Reconciliation by decision ${uncited} refused: `))!, /admin credential/);
  assert.equal((await events(work.id, 'merge.reconciliation.refused')).length, 3);
  // The operator's decision: requested by the master's agent, approved with the admin credential,
  // citing the refused reconciliation. The next observation delivers it as operator-authorized.
  const reason = `Operator authorized the administrative merge of ${mergeSha.slice(0, 12)} to unblock the queue, overriding refused reconciliation ${first}`;
  const decision = await mergeDecision(current, reason, masterAgent.token, token(operator));
  const delivered = await engine.observe(work.id, (await reload(work.id)).revision, { ...merged, at: new Date().toISOString() });
  assert.equal(delivered.stage, 'done'); assert.deepEqual(delivered.violations, []);
  const delivery = delivered.delivery as NonNullable<Work['delivery']> & { operatorAuthorization: any; reconciliation?: any };
  assert.equal(delivery.mergeSha, mergeSha); assert.equal(delivery.mergedAt, merged.mergedAt);
  assert.equal(delivery.reconciliation, undefined, 'not a reconciled delivery');
  const record = delivery.operatorAuthorization;
  assert.equal(record.execution, null, 'the delivery states that no execution authorized the merge');
  assert.equal(record.decision, decision); assert.equal(record.operator, operator.id); assert.equal(record.refusedDecision, first);
  assert.equal(record.requestedBy, masterAgent.id); assert.equal(record.approvedBy, operator.id);
  assert.equal(record.reason, reason); assert.match(record.approvalReason, /^Approved: Operator authorized/);
  assert.ok(record.unmet.some((entry: string) => /gate review had not passed/.test(entry)), record.unmet.join(' | '));
  assert.match(record.judgement, new RegExp(`^The gates did not pass for merge ${mergeSha.slice(0, 12)}: the record at .*, the recorded merge cutoff, lacked gate review had not passed`));
  assert.match(record.judgement, new RegExp(`operator ${operator.id} authorized it by decision ${decision}, citing refused reconciliation ${first}`));
  assert.equal(record.violation, unauthorizedMergeViolation);
  assert.equal(delivery.authorizationRevision, record.snapshotRevision);
  // The ledger: one merge.operator-authorized entry under the operator, no merge.reconciled.
  const recorded = await events(work.id, 'merge.operator-authorized');
  assert.equal(recorded.length, 1); assert.equal(recorded[0].actor, operator.id); assert.equal(recorded[0].payload.details.decision, decision); assert.equal(recorded[0].payload.details.mergeSha, mergeSha);
  assert.equal(recorded[0].payload.details.execution, null);
  assert.equal((await events(work.id, 'merge.reconciled')).length, 0);
  // master status lists it apart from reconciled deliveries, and neither is a routine merge.
  const status = buildMasterStatus({ work: await store.list(), now: await dbNow() }, [], []);
  const own = status.deliveries.operatorAuthorized.find(entry => entry.key === work.key)!;
  assert.equal(own.authorization, 'operator'); assert.equal(own.execution, null); assert.equal(own.operator, operator.id); assert.equal(own.decision, decision); assert.equal(own.refusedDecision, first);
  assert.equal(own.mergeSha, mergeSha); assert.equal(own.reason, reason); assert.deepEqual(own.unmet, record.unmet);
  assert.equal(status.deliveries.reconciled.some(entry => entry.key === work.key), false);
  for (const entry of status.deliveries.reconciled) { assert.equal(entry.authorization, 'reconciled'); assert.equal('execution' in entry, false); }
  assert.equal(status.counts.operatorAuthorizedDeliveries, 1); assert.equal(status.counts.reconciledDeliveries, status.deliveries.reconciled.length);
  assert.equal(status.work.some(row => row.key === work.key), false, 'a delivered item leaves the open rows');
});
