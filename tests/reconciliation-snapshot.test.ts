import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine, historicalAuthorizationRefusals, unauthorizedMergeViolation } from '../src/engine.js';
import { server } from '../src/server.js';
import { buildMasterStatus, masterConfigSchema, mergedWithoutAuthorization, type MasterConfig, type MergeExecutor } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { queuePlacement, queueRef, unpublishableEntry, type QueueSpeculation } from '../src/merge-queue.js';
import type { Observation, Principal, Work } from '../src/model.js';

/**
 * GY-94: the record a reconciliation re-checks is the last snapshot that precedes the merge itself,
 * the merge's own consequences never refuse the reconciliation that clears them, a queue entry the
 * merged pull request can never publish has an exit, and a delivery an operator authorized outside
 * the guarded path is recorded as exactly that. Each test is named for the proof it produces and
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
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository, baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project' });
let pg: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
let serial = 0;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 25;
  pg = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-reconciliation-snapshot-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
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

/**
 * A submitted candidate. Proven, it stands at the merge stage with every gate passed; queued, its
 * speculative tip is published on its bound base. Items keep their queue entries unless told
 * otherwise, so several can occupy one queue.
 */
async function candidate(options: { proven?: boolean; queue?: boolean; alone?: boolean } = {}) {
  const { proven = true, queue = true, alone = false } = options;
  const n = ++serial;
  let w = await engine.execute(operator, 'create', null, { title: `Reconciliation ${n}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, id());
  w = await engine.execute(operator, 'ready', w.id, {}, id()); w = await engine.execute(worker, 'claim', w.id, {}, id());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/reconciliation-${n}`, branch: `graphyard/gy-94-${n}` }, id());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: 900 + n }, id());
  if (alone) await store.pool.query("UPDATE work_items SET document=document-'queue' WHERE id<>$1 AND document->>'stage'<>'done'", [w.id]);
  w = await engine.observe(w.id, w.revision, observation(w));
  if (proven) w = await engine.execute(producer, 'evidence', w.id, { proof: 'integration:claim-safety', sha: head(w), baseSha: base, policyRevision: 1, result: 'pass', executed: 3, skipped: 0 }, id());
  w = await engine.observe(w.id, (await reload(w.id)).revision, observation(w));
  if (proven && queue) {
    assert.ok(w.queue, `${w.key} entered the merge queue: ${w.gates.flatMap(gate => gate.reasons).join('; ')}`);
    const placement = queuePlacement(w, await store.list(), Date.now())!;
    if (placement.position === 0) {
      const speculation: QueueSpeculation = { ref: queueRef(w.key), tip: head(w), base, baseTree: '7e'.repeat(20), predecessors: [], policyRevision: w.policyRevision, publishedAt: new Date().toISOString() };
      await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{queue,speculation}',$2::jsonb) WHERE id=$1", [w.id, JSON.stringify(speculation)]);
      w = await engine.observe(w.id, (await reload(w.id)).revision, observation(w));
      assert.equal(w.stage, 'merge'); assert.ok(w.gates.every(gate => gate.passed), w.gates.flatMap(gate => gate.reasons).join('; '));
    }
  }
  return w;
}
const snapshotsReporting = async (workId: string, mergeSha: string) => (await store.pool.query("SELECT created_at, payload->'work' AS work FROM events WHERE work_id=$1 AND payload->'work'->'observation'->>'mergeSha'=$2 ORDER BY seq", [workId, mergeSha])).rows as { created_at: Date; work: Work }[];

test('integration:reconciliation-snapshot-precedes-merge — GY-81 exactly: a whole-second mergedAt, a recorded clock offset and post-merge observations inside the old cutoff window; the reconciliation re-checks the last snapshot that precedes the merge, never one that already reports it, and delivers', async () => {
  const work = await candidate({ alone: true });
  const mergeSha = sha(`merge-${work.key}`);
  // GY-81's ledger: the broker acquired, verified with a bounded clock offset, committed, and the
  // execution was cancelled before the merge cutoff; GitHub then merged the pull request anyway.
  const executor: MergeExecutor = { principal: coordinator.id, instance: `daemon-${randomUUID()}` };
  const offset = { min: 0, max: 2000 };
  const granted = await engine.acquireMerge(coordinator, work.id, { expectedRevision: work.revision, sha: head(work), baseSha: base, policyRevision: work.policyRevision, executor: executor.instance }, id());
  await engine.verifyMerge(coordinator, work.id, { executionId: granted.execution.id, executor: executor.instance }, { ...observation(work), prState: 'open', draft: false, clockOffset: offset }, id());
  await engine.commitMerge(coordinator, work.id, { executionId: granted.execution.id, executor: executor.instance }, id());
  await engine.cancelMerge(coordinator, work.id, { executionId: granted.execution.id, reason: '{"error":"Merge execution was already verified; retry with the original idempotency key"}', executor: executor.instance }, id());
  const preMerge = await reload(work.id);
  assert.ok(preMerge.mergeAuthorization && preMerge.gates.every(gate => gate.passed) && !preMerge.violations.length, 'the record before the merge authorized the candidate');
  // The merge lands in a later whole second than the authorization, as GitHub reports it.
  await delay(1100);
  const merged = await mergedAt(work, mergeSha);
  const providerMergedTime = Date.parse(merged.mergedAt!);
  const oldCutoff = providerMergedTime + 1000 + offset.max;
  let current = await engine.observe(work.id, preMerge.revision, merged);
  assert.equal(current.stage, 'merge'); assert.ok(current.violations.includes(unauthorizedMergeViolation)); assert.equal(current.delivery, undefined);
  current = await engine.observe(work.id, current.revision, { ...merged, at: new Date().toISOString() });
  // The poisoned snapshots: written inside the old window, each already reporting the merge and
  // carrying its consequences — the violation, no authorization, and a merge gate that only
  // reports the queue position the merge left behind.
  const poisoned = await snapshotsReporting(work.id, mergeSha);
  assert.equal(poisoned.length, 2);
  for (const snapshot of poisoned) {
    assert.ok(snapshot.created_at.getTime() < oldCutoff, `post-merge snapshot at ${snapshot.created_at.toISOString()} falls inside the old cutoff window ending ${new Date(oldCutoff).toISOString()}`);
    assert.ok(snapshot.work.observation!.merged); assert.equal(snapshot.work.mergeAuthorization, null);
    assert.ok(snapshot.work.violations.includes(unauthorizedMergeViolation));
    const gate = snapshot.work.gates.find(entry => entry.name === 'merge')!;
    assert.equal(gate.passed, false); assert.match(gate.reasons.join('; '), new RegExp(`Speculative tip on predicted base ${mergeSha.slice(0, 12)} has not been published`));
  }
  // The recovery, requested after the cutoff: the pre-merge snapshot is chosen and the item delivers.
  await waitUntil(oldCutoff);
  const decision = await mergeDecision(current, `Reconcile ${work.key}: GitHub merged ${mergeSha.slice(0, 12)} after the execution was cancelled`);
  const delivered = await engine.observe(work.id, (await reload(work.id)).revision, { ...merged, at: new Date().toISOString() });
  assert.equal(delivered.stage, 'done', delivered.violations.join(' | '));
  assert.deepEqual(delivered.violations, []);
  const delivery = delivered.delivery as NonNullable<Work['delivery']> & { reconciliation: any };
  assert.equal(delivery.mergeSha, mergeSha); assert.equal(delivery.mergedAt, merged.mergedAt);
  assert.equal(delivery.reconciliation.decision, decision);
  assert.equal(delivery.reconciliation.snapshotRevision, preMerge.revision, 'the snapshot re-checked is the last one that precedes the merge');
  assert.equal(delivery.reconciliation.cutoff, new Date(oldCutoff).toISOString(), 'the clock-offset allowance still widens the validity window');
  assert.equal(delivery.authorizationRevision, granted.execution.authorizationRevision);
  // The offset carries the merge onto the repository clock exactly as an authorized delivery is recorded.
  assert.equal(delivery.repositoryClockOffsetMs, offset.min); assert.equal(delivery.mergedAtRepository, new Date(providerMergedTime + offset.min).toISOString());
  const reconciled = await events(work.id, 'merge.reconciled');
  assert.equal(reconciled.length, 1); assert.equal(reconciled[0].payload.details.snapshotRevision, preMerge.revision);
  assert.equal((await events(work.id, 'merge.reconciliation.refused')).length, 0, 'nothing was refused on the way');
});

test('integration:reconciliation-refusal-not-circular — the unauthorized-merge violation a reconciliation clears, an earlier refusal, and a merge gate that only reports queue position after the merge never refuse an otherwise sound reconciliation; every other refusal stands, and the guarded path stays strict', async () => {
  const work = await candidate({ alone: true });
  const mergeSha = sha(`merge-${work.key}`);
  // The merge lands in a later whole second than the authorization, as GitHub reports it.
  await delay(1100);
  const merged = await mergedAt(work, mergeSha);
  const providerMergedTime = Date.parse(merged.mergedAt!);
  const cutoff = providerMergedTime + 1000;
  const all = await store.list();
  const sound = await reload(work.id);
  assert.ok(sound.mergeAuthorization && Date.parse(sound.mergeAuthorization.at) < providerMergedTime);
  const judge = (past: Work, options?: { reconciling?: boolean }) => historicalAuthorizationRefusals(past, all, merged, cutoff, providerMergedTime, options);
  assert.deepEqual(judge(sound, { reconciling: true }), [], 'the real pre-merge record is sound');
  // GY-81's poisoned snapshot, minus the authorization it lost: what the merge itself wrote.
  const poisoned: Work = { ...sound, violations: [unauthorizedMergeViolation, `Reconciliation by decision ${randomUUID()} refused: violation stood: ${unauthorizedMergeViolation}`],
    gates: sound.gates.map(gate => gate.name === 'merge' ? { ...gate, passed: false, reasons: ['Merge queue position 2 of 3: GY-80 is ahead', `Speculative tip on predicted base ${mergeSha.slice(0, 12)} has not been published and validated for this candidate`] } : gate) };
  assert.deepEqual(judge(poisoned, { reconciling: true }), [], 'neither the violation nor the post-merge queue position refuses the reconciliation');
  // The same record judged for the guarded path — an execution's own authorization — is refused for both.
  const strict = judge(poisoned);
  assert.ok(strict.some(reason => reason === `violation stood: ${unauthorizedMergeViolation}`), strict.join(' | '));
  assert.ok(strict.some(reason => reason.startsWith('gate merge had not passed: Merge queue position 2 of 3')), strict.join(' | '));
  // A merge gate refusing for anything but its turn still refuses, and so does any other violation.
  const unmergeable: Work = { ...poisoned, gates: sound.gates.map(gate => gate.name === 'merge' ? { ...gate, passed: false, reasons: ['Pull request is not mergeable against the current base', 'Merge queue position 2 of 3: GY-80 is ahead'] } : gate) };
  assert.deepEqual(judge(unmergeable, { reconciling: true }), ['gate merge had not passed: Pull request is not mergeable against the current base; Merge queue position 2 of 3: GY-80 is ahead']);
  const otherViolation: Work = { ...poisoned, violations: [...poisoned.violations, 'Post-merge checks differ from the recorded authorization; follow-up required'] };
  assert.deepEqual(judge(otherViolation, { reconciling: true }), ['violation stood: Post-merge checks differ from the recorded authorization; follow-up required']);
  const unproven: Work = { ...poisoned, evidence: [] };
  assert.ok(judge(unproven, { reconciling: true }).some(reason => reason.startsWith('required proof integration:claim-safety had no live trusted evidence')));
  // End to end: a merge with no execution at all, whose only pre-merge record is sound, reconciles
  // on the decision although every post-merge observation carries both artifacts.
  let current = await engine.observe(work.id, sound.revision, merged);
  assert.ok(current.violations.includes(unauthorizedMergeViolation));
  const gate = current.gates.find(entry => entry.name === 'merge')!;
  assert.ok(gate.reasons.every(reason => /^Speculative tip on predicted base/.test(reason)) && !gate.passed);
  await waitUntil(cutoff);
  const decision = await mergeDecision(current, `Reconcile ${work.key}: merged outside the guarded path with a sound record`);
  current = await engine.observe(work.id, (await reload(work.id)).revision, { ...merged, at: new Date().toISOString() });
  assert.equal(current.stage, 'done', current.violations.join(' | '));
  assert.equal((current.delivery as any).reconciliation.decision, decision);
  assert.equal((current.delivery as any).reconciliation.snapshotRevision, sound.revision);
});

test('integration:unpublishable-queue-entry-exit — a queued entry whose pull request GitHub merged without authorization can never publish a speculative tip: the loop names the entry, what waits behind it and the decision that resolves it; a refused reconciliation removes the entry without delivering, and the entry behind it predicts against the real base', async () => {
  // GY-81 at the queue head with its tip published, GY-86 queued behind it waiting for that tip.
  const stuck = await candidate({ alone: true });
  const follower = await candidate();
  assert.equal(queuePlacement(follower, await store.list(), Date.now())!.position, 1);
  // The head's last observation before the merge is stale, so its record at the cutoff cannot
  // authorize the merge: the reconciliation will be refused on the record, not on the merge.
  let current = await engine.observe(stuck.id, (await reload(stuck.id)).revision, observation(stuck, { at: new Date(Date.now() - 180_000).toISOString() }));
  assert.ok(current.queue, 'a stale observation does not eject the entry'); assert.equal(current.mergeAuthorization, null);
  const mergeSha = sha(`merge-${stuck.key}`);
  const merged = await mergedAt(stuck, mergeSha);
  const cutoff = Date.parse(merged.mergedAt!) + 1000;
  current = await engine.observe(stuck.id, current.revision, merged);
  let behind = await engine.observe(follower.id, (await reload(follower.id)).revision, observation(follower, { baseTip: mergeSha, baseTree: sha(`tree-${mergeSha}`) }));
  assert.ok(current.violations.includes(unauthorizedMergeViolation)); assert.equal(mergedWithoutAuthorization(current), true);
  assert.deepEqual(unpublishableEntry(current), { sequence: current.queue!.sequence, mergeSha, refusal: null });
  assert.equal(current.queue!.sequence, stuck.queue!.sequence, 'the merged entry holds its place; no observation ejects it');
  assert.match(behind.gates.find(gate => gate.name === 'merge')!.reasons.join('; '), new RegExp(`Waiting for ${stuck.key} to publish its speculative tip`));
  // master status names the condition, what waits behind it, and the decision that resolves it.
  const now = await dbNow();
  let status = buildMasterStatus({ work: await store.list(), now }, [], []);
  let row = status.work.find(entry => entry.key === stuck.key)!;
  assert.deepEqual(row.merged?.queue, { sequence: stuck.queue!.sequence, position: 1, size: 2, unpublishable: true, behind: [follower.key] });
  assert.match(row.attention!, /can never publish a speculative tip because the pull request is already merged/);
  assert.match(row.attention!, new RegExp(`${follower.key} wait behind it`));
  assert.match(row.attention!, /a refused one removes the entry without delivering/);
  assert.match(row.attentionOwner!.next, new RegExp(`^graphyard master decide ${stuck.key} merge REASON, then graphyard master approver ${stuck.key} DECISION`));
  assert.match(row.attentionOwner!.next, /removes the queue entry the merged pull request can never publish, without delivering/);
  assert.equal(status.attentionItems.find(item => item.subject === stuck.key)?.text, row.attention);
  // The durable loop names it too, once, and never offers it to the guarded merge.
  const merges: string[] = [];
  const effects: DaemonEffects = { agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: await store.list(), now }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    merge: async work => { merges.push(work.key); return { result: 'merge requested' }; }, observeDeployment: async () => ({ source: 'unavailable', sha: null, at: now, reason: 'none', deployed: [], pending: [] }), recordDeployment: async () => ({}), requestSmoke: () => {}, persist: async () => {} };
  const cycle = await runCycle(config, emptyDaemonState(config), effects);
  const escalation = cycle.actions.find(action => action.kind === 'escalation' && action.work === stuck.key)!;
  assert.match(escalation.detail, new RegExp(`graphyard master decide ${stuck.key} merge REASON`));
  assert.equal(merges.includes(stuck.key), false);
  // The two-party decision, by the master's agent pair. The record refuses the reconciliation,
  // and that refusal is the entry's exit: nothing is delivered, the entry leaves, the follower moves up.
  await waitUntil(cutoff);
  const decision = await mergeDecision(current, `Judge ${stuck.key}: merged at the queue head outside the guarded path`, masterAgent.token, approverAgent.token);
  current = await engine.observe(stuck.id, (await reload(stuck.id)).revision, { ...merged, at: new Date().toISOString() });
  assert.notEqual(current.stage, 'done'); assert.equal(current.delivery, undefined, 'no merge is claimed');
  const refusal = current.violations.find(entry => entry.startsWith(`Reconciliation by decision ${decision} refused: `))!;
  assert.ok(refusal, current.violations.join(' | ')); assert.match(refusal, /no merge authorization for/); assert.match(refusal, /older than two minutes/);
  assert.equal(current.queue, null, 'the entry left the queue');
  assert.equal(current.queueEjection?.sequence, stuck.queue!.sequence);
  assert.match(current.queueEjection!.reason, new RegExp(`can never publish a speculative tip; reconciliation by decision ${decision} was refused, so the entry leaves the queue undelivered`));
  assert.equal(current.queueHistory!.at(-1)!.event, 'ejected');
  const ejected = await events(stuck.id, 'queue.ejected');
  assert.equal(ejected.length, 1); assert.equal(ejected[0].payload.details.decision, decision); assert.equal(ejected[0].payload.details.sequence, stuck.queue!.sequence);
  assert.equal((await events(stuck.id, 'merge.reconciliation.refused')).length, 1);
  assert.equal(unpublishableEntry(current), null);
  // A later observation re-derives the same record: the violation stands, nothing re-enters the queue.
  current = await engine.observe(stuck.id, current.revision, { ...merged, at: new Date().toISOString() });
  assert.equal(current.queue, null); assert.equal(current.violations.filter(entry => entry.startsWith('Reconciliation by decision ')).length, 1);
  // The follower is the head now, predicting against the real base branch tip.
  behind = await engine.observe(follower.id, (await reload(follower.id)).revision, observation(follower, { baseTip: mergeSha, baseTree: sha(`tree-${mergeSha}`) }));
  const placement = queuePlacement(behind, await store.list(), Date.now())!;
  assert.equal(placement.position, 0); assert.equal(placement.predictedBase, mergeSha); assert.equal(placement.publishable, true);
  assert.doesNotMatch(behind.gates.find(gate => gate.name === 'merge')!.reasons.join('; '), new RegExp(`Waiting for ${stuck.key}`));
  // Status now carries the refusal and the operator's path, and no dead entry.
  status = buildMasterStatus({ work: await store.list(), now: await dbNow() }, [], []);
  row = status.work.find(entry => entry.key === stuck.key)!;
  assert.equal(row.merged?.queue, undefined, 'no dead entry remains on the row'); assert.equal(row.merged?.refusal, refusal);
  assert.match(row.attention!, /the last reconciliation was refused — Reconciliation by decision/);
  assert.match(row.attentionOwner!.next, new RegExp(`cites refused decision ${decision}`));
  assert.equal(status.queue.length, 1); assert.equal(status.queue[0].key, follower.key);
});

test('integration:operator-authorized-delivery — a merge no execution authorized and the record refuses is delivered only on a decision an operator owns: an admin credential on one side, citing the refusal; the delivery states that no execution authorized it, names the operator, both reasons and what the record lacked, and is distinguishable in the ledger and in master status from a reconciled delivery', async () => {
  // GY-92: an unproven candidate the operator merged administratively while the acceptance gate was open.
  const work = await candidate({ proven: false, alone: true });
  assert.equal(work.stage, 'acceptance');
  const mergeSha = sha(`merge-${work.key}`);
  const merged = await mergedAt(work, mergeSha);
  const cutoff = Date.parse(merged.mergedAt!) + 1000;
  let current = await engine.observe(work.id, (await reload(work.id)).revision, merged);
  assert.ok(current.violations.includes(unauthorizedMergeViolation)); assert.equal(current.queue, null);
  await waitUntil(cutoff);
  // The master's agent pair asks for a reconciliation: the record refuses it, with what it lacked.
  const first = await mergeDecision(current, `Reconcile ${work.key} after the administrative merge`, masterAgent.token, approverAgent.token);
  current = await engine.observe(work.id, (await reload(work.id)).revision, { ...merged, at: new Date().toISOString() });
  assert.equal(current.stage, 'acceptance');
  const refusal = current.violations.find(entry => entry.startsWith(`Reconciliation by decision ${first} refused: `))!;
  assert.match(refusal, /gate acceptance had not passed/); assert.match(refusal, /integration:claim-safety had no live trusted evidence/);
  // The same pair citing the refusal is still not an operator: refused again, saying why.
  const pair = await mergeDecision(current, `Operator authorized the administrative merge; overrides ${first}`, masterAgent.token, approverAgent.token);
  current = await engine.observe(work.id, (await reload(work.id)).revision, { ...merged, at: new Date().toISOString() });
  assert.equal(current.stage, 'acceptance'); assert.equal(current.delivery, undefined);
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
  assert.ok(record.unmet.some((entry: string) => /gate acceptance had not passed/.test(entry)), record.unmet.join(' | '));
  assert.match(record.judgement, new RegExp(`^No merge execution authorized merge ${mergeSha.slice(0, 12)} and the record at .* did not either`));
  assert.match(record.judgement, new RegExp(`operator ${operator.id} authorized it outside the guarded path by decision ${decision}, citing refused reconciliation ${first}`));
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
  assert.ok(status.deliveries.reconciled.length >= 1, 'the reconciled deliveries of this run are listed apart');
  for (const entry of status.deliveries.reconciled) { assert.equal(entry.authorization, 'reconciled'); assert.equal('execution' in entry, false); assert.match(entry.judgement, /every required proof was live/); }
  assert.equal(status.counts.operatorAuthorizedDeliveries, 1); assert.equal(status.counts.reconciledDeliveries, status.deliveries.reconciled.length);
  assert.equal(status.work.some(row => row.key === work.key), false, 'a delivered item leaves the open rows');
});
