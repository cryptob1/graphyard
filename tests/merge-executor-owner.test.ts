import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine, unauthorizedMergeViolation } from '../src/engine.js';
import { server } from '../src/server.js';
import { buildMasterStatus, masterConfigSchema, mergedWithoutAuthorization, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { type Observation, type Principal, type Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-92, as GitHub delivers (GY-1235): an observed merge of a head whose gates had not passed is a
 * violation, held out of done and recoverable only by a two-party decision the history supports.
 * Each test is named for the proof it produces. Every integration test runs the real engine on a
 * disposable Postgres.
 */
const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'ai' };
const approver: Principal = { id: 'approver-agent', role: 'admin', sessionKind: 'ai' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const producer: Principal = { id: 'proof-runner', role: 'producer', proofs: ['integration:claim-safety'] };
const principals = [operator, approver, worker, producer];
const credentials = principals.map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
const head = 'a'.repeat(40), base = 'b'.repeat(40), mergeSha = 'c'.repeat(40);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project' });
let pg: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
let serial = 0;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 22;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('merge-executor'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('merge_executor_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/merge_executor_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (pg) await pg.stop(); });

const id = () => randomUUID();
const reload = async (workId: string) => (await store.list()).find(item => item.id === workId)!;
const events = async (workId: string, kind: string) => (await store.pool.query('SELECT actor, payload, created_at FROM events WHERE work_id=$1 AND kind=$2 ORDER BY seq', [workId, kind])).rows;
const dbNow = async () => ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString();
const observation = (work: Work, extra: Partial<Observation> = {}): Observation => ({ clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' },
  checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }],
  protected: true, mergeable: true, merged: false, mergeSha: null, files: [], scopeFiles: [], at: new Date().toISOString(), ...extra });
/** A merged observation whose provider timestamp is a database-clock instant read just now. */
const merged = async (work: Work) => observation(work, { merged: true, mergeSha, mergedAt: await dbNow() });
const call = async (credential: string, path: string, body: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
  const result = await response.json() as any; assert.equal(response.status, 200, JSON.stringify(result)); return result;
};
/** The two-party merge decision: requested by the operator agent, approved by an independent one. */
async function mergeDecision(work: Work, reason: string) {
  const decision = await call(token(operator), `work/${work.key}/decide`, { action: 'merge', input: { sha: head, baseSha: base, policyRevision: work.policyRevision }, reason });
  return { id: decision.id as string, approve: () => call(token(approver), `work/${work.key}/approve`, { decision: decision.id, reason: `Approved: ${reason}` }) };
}

/** A submitted candidate observed at its head: every gate passes, or with `reviewed` false the review gate does not. */
async function candidate(reviewed = true) {
  const n = ++serial;
  let w = await engine.execute(operator, 'create', null, { title: `Merge executor ${n}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, id());
  w = await engine.execute(operator, 'ready', w.id, {}, id()); w = await engine.execute(worker, 'claim', w.id, {}, id());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/merge-executor-${n}`, branch: `graphyard/gy-92-${n}` }, id());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: 900 + n }, id());
  w = await engine.observe(w.id, w.revision, observation(w, reviewed ? {} : { reviews: [] }));
  if (reviewed) { assert.equal(w.stage, 'merge'); assert.ok(w.gates.every(gate => gate.passed), w.gates.flatMap(gate => gate.reasons).join('; ')); }
  else assert.equal(w.stage, 'review');
  return w;
}

test('integration:merged-without-authorization-recovery — an observed merge of a head whose gates had not passed records the violation, stays out of done, and a two-party merge decision the history refuses is recorded once and delivers nothing; GitHub merging a passing head needs no decision', async () => {
  // GitHub merges a passing head: that merge is the delivery, with no decision and no violation.
  const passing = await candidate();
  await delay(5);
  const delivered = await engine.observe(passing.id, (await reload(passing.id)).revision, await merged(passing));
  assert.equal(delivered.stage, 'done', delivered.violations.join('; ')); assert.deepEqual(delivered.violations, []);
  assert.equal(delivered.delivery?.mergeSha, mergeSha); assert.equal(delivered.delivery?.authorizationRevision, passing.revision);
  assert.equal((await events(passing.id, 'merge.reconciled')).length, 0);

  // GitHub merges a head whose review gate had not passed: the violation, held at the stage its first failing gate names.
  const unreviewed = await candidate(false);
  await delay(5);
  const mergedObservation = { ...await merged(unreviewed), reviews: [] };
  let current = await engine.observe(unreviewed.id, (await reload(unreviewed.id)).revision, mergedObservation);
  assert.notEqual(current.stage, 'done', 'the item stays out of done'); assert.ok(current.violations.includes(unauthorizedMergeViolation)); assert.equal(current.delivery, undefined);
  assert.equal(mergedWithoutAuthorization(current), true);
  // Every later observation re-derives the same verdict from immutable history.
  current = await engine.observe(unreviewed.id, current.revision, mergedObservation);
  assert.notEqual(current.stage, 'done'); assert.deepEqual(current.violations, [unauthorizedMergeViolation]);
  // A decision requested after the merge reconciles only what the history supports: the review gate
  // had not passed on the merged head, so the refusal is recorded once and nothing is delivered.
  const hopeless = await mergeDecision(current, `Reconcile ${current.key}: GitHub merged ${mergeSha.slice(0, 12)} before its review`); await hopeless.approve();
  current = await engine.observe(unreviewed.id, (await reload(unreviewed.id)).revision, { ...mergedObservation, at: new Date().toISOString() });
  assert.notEqual(current.stage, 'done');
  const reason = current.violations.find(entry => entry.startsWith(`Reconciliation by decision ${hopeless.id} refused: `))!;
  assert.ok(reason, current.violations.join(' | ')); assert.match(reason, /gate review had not passed/);
  current = await engine.observe(unreviewed.id, current.revision, { ...mergedObservation, at: new Date().toISOString() });
  assert.equal(current.violations.filter(entry => entry.startsWith('Reconciliation by decision ')).length, 1, 'the refusal is recorded once');
  assert.equal((await events(unreviewed.id, 'merge.reconciliation.refused')).length, 1);
  assert.equal(mergedWithoutAuthorization(current), true);
});

test('unit:stuck-merge-attention — master status names an item held at the merge stage by an observed unauthorized merge as the violation with its recovery command, apart from a candidate GitHub has yet to merge, and the loop names the violation once', async () => {
  const at = new Date().toISOString();
  const shape = (key: string, overrides: Partial<Work>): Work => ({ id: `id-${key}`, key, title: key, description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:x'] }],
    policy: { checks: ['test'], review: true }, stage: 'merge', revision: 12, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: new Date(Date.now() - 7_200_000).toISOString(), ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'h', path: '/w', branch: `graphyard/${key.toLowerCase()}-1`, epoch: 1, owner: 'implementer' }], candidate: { sha: head, baseSha: base, pr: 81, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' },
    submission: { epoch: 1, pr: 81 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [],
    observation: { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: 81, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' }, checks: [], reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, files: [], scopeFiles: [], at },
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] }, { name: 'test', passed: true, reasons: [] }, { name: 'acceptance', passed: true, reasons: [] }, { name: 'merge', passed: false, reasons: ['Queue position 2 of 2: GY-80 lands first'] }], ...overrides } as Work);
  const stuck = shape('GY-81', { violations: [unauthorizedMergeViolation], observation: { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: 81, branch: 'graphyard/gy-81-1', author: 'implementer' }, checks: [], reviews: [], protected: true, mergeable: false, merged: true, mergeSha: mergeSha, mergedAt: '2026-09-20T19:50:22Z', files: [], scopeFiles: [], at },
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] }, { name: 'test', passed: true, reasons: [] }, { name: 'acceptance', passed: true, reasons: [] }, { name: 'merge', passed: true, reasons: [] }] });
  const waiting = shape('GY-82', {});
  const status = buildMasterStatus({ work: [stuck, waiting], now: at }, [], []);
  const row = status.work.find(entry => entry.key === 'GY-81')!;
  assert.match(row.attention!, /GY-81 was merged on GitHub \(cccccccccccc at 2026-09-20T19:50:22Z\) though its gates had not passed on that head: Merge observed without a prior authorization/);
  assert.match(row.attention!, /held at the merge stage; /);
  assert.equal(row.attentionOwner?.role, 'master'); assert.equal(row.attentionOwner?.approvedBy, 'approver');
  assert.match(row.attentionOwner!.next, /^graphyard master decide GY-81 merge REASON, then graphyard master approver GY-81 DECISION/);
  assert.deepEqual(row.merged, { at: '2026-09-20T19:50:22Z', sha: mergeSha, violation: unauthorizedMergeViolation, refusal: null });
  assert.equal(row.mergeable, false);
  const item = status.attentionItems.find(entry => entry.subject === 'GY-81')!;
  assert.equal(item.text, row.attention); assert.equal(item.human, false);
  const other = status.work.find(entry => entry.key === 'GY-82')!;
  assert.equal(other.merged, null); assert.doesNotMatch(other.attention ?? '', /merged on GitHub/);
  assert.equal(status.counts.mergedUnreconciled, 1); assert.equal(status.counts.mergeCandidates, 1);
  // A refused reconciliation is carried into the line, so the master reads why before deciding again.
  const refusedRow = buildMasterStatus({ work: [{ ...stuck, violations: [unauthorizedMergeViolation, 'Reconciliation by decision d1 refused: gate acceptance had not passed: proof missing'] }], now: at }, [], []).work[0];
  assert.match(refusedRow.attention!, /the last reconciliation was refused — Reconciliation by decision d1 refused: gate acceptance had not passed/);
  assert.equal(refusedRow.merged?.refusal, 'Reconciliation by decision d1 refused: gate acceptance had not passed: proof missing');
  // The durable loop names the stuck item once as an escalation; GitHub merges, so nothing is offered a merge.
  const effects: DaemonEffects = { agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [stuck, waiting], now: at }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at, reason: 'none', deployed: [], pending: [] }), recordDeployment: async () => ({}), requestSmoke: () => {}, persist: async () => {} };
  const state = emptyDaemonState(config);
  const cycle = await runCycle(config, state, effects);
  const escalation = cycle.actions.find(action => action.kind === 'escalation' && action.work === 'GY-81')!;
  assert.match(escalation.detail, /merged on GitHub \(cccccccccccc at 2026-09-20T19:50:22Z\) though its gates had not passed on that head/);
  assert.match(escalation.detail, /graphyard master decide GY-81 merge REASON, then graphyard master approver GY-81 DECISION/);
  const again = await runCycle(config, state, effects);
  assert.equal(again.actions.some(action => action.kind === 'escalation' && action.work === 'GY-81'), false, 'the escalation is recorded once');
});
