import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine, unauthorizedMergeViolation } from '../src/engine.js';
import { server } from '../src/server.js';
import { assertMergeCandidate, buildMasterStatus, masterConfigSchema, mergeExecutionOwner, mergeExecutor, mergedWithoutAuthorization, stepAlreadyPerformed, type MasterConfig, type MergeExecutor } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { queueRef, type QueueSpeculation } from '../src/merge-queue.js';
import { Refusal, type Observation, type Principal, type Work } from '../src/model.js';

/**
 * GY-92: a merge execution is owned by the executor instance that acquired it, a losing executor
 * stands down without cancelling, and an observed merge no execution authorized is recoverable by
 * a two-party decision. Each test is named for the proof it produces. Every integration test runs
 * the real engine on a disposable Postgres; GitHub is a stub that answers the broker's `gh` calls.
 */
const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'ai' };
const approver: Principal = { id: 'approver-agent', role: 'admin', sessionKind: 'ai' };
const worker: Principal = { id: 'implementer', role: 'worker' };
// The one coordinator credential both executors run under: the durable loop and `master merge`.
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const producer: Principal = { id: 'proof-runner', role: 'producer', proofs: ['integration:claim-safety'] };
const principals = [operator, approver, worker, coordinator, producer];
const credentials = principals.map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
const head = 'a'.repeat(40), base = 'b'.repeat(40), mergeSha = 'c'.repeat(40);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const validProtection = { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: 'Graphyard / merge', app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project' });
let pg: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
let serial = 0;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 22;
  pg = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-merge-executor-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
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

/** A candidate at the merge stage with every gate passed and its queue tip published: what the broker acquires. */
async function candidate(proven = true) {
  const n = ++serial;
  let w = await engine.execute(operator, 'create', null, { title: `Merge executor ${n}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, id());
  w = await engine.execute(operator, 'ready', w.id, {}, id()); w = await engine.execute(worker, 'claim', w.id, {}, id());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/merge-executor-${n}`, branch: `graphyard/gy-92-${n}` }, id());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: 900 + n }, id());
  // One item at a time is under test; the rest never occupy the queue ahead of it.
  await store.pool.query("UPDATE work_items SET document=document-'queue' WHERE id<>$1 AND document->>'stage'<>'done'", [w.id]);
  w = await engine.observe(w.id, w.revision, observation(w));
  if (proven) w = await engine.execute(producer, 'evidence', w.id, { proof: 'integration:claim-safety', sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } }, id());
  const speculation: QueueSpeculation = { ref: queueRef(w.key), tip: head, base, baseTree: '7e'.repeat(20), predecessors: [], policyRevision: w.policyRevision, publishedAt: new Date().toISOString() };
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{queue,speculation}',$2::jsonb) WHERE id=$1", [w.id, JSON.stringify(speculation)]);
  w = await engine.observe(w.id, (await reload(w.id)).revision, observation(w));
  if (proven) { assert.equal(w.stage, 'merge'); assert.ok(w.gates.every(gate => gate.passed), w.gates.flatMap(gate => gate.reasons).join('; ')); }
  return w;
}
/**
 * The broker's transport, in process: every path `mergeExecutor` posts maps onto the engine call
 * the server route makes, and every refusal comes back the way the CLI transport reports one —
 * a confirmed refusal carrying the server's error document.
 */
const transport = (actor: Principal) => async (path: string, data: any, key: string = randomUUID()) => {
  const match = /^work\/([^/]+)\/merge-(acquire|cancel|verify|commit)$/.exec(path);
  if (!match) throw new Error(`Unexpected mutation ${path}`);
  const [, workId, step] = match;
  try {
    if (step === 'acquire') return await engine.acquireMerge(actor, workId, data, key);
    if (step === 'cancel') return await engine.cancelMerge(actor, workId, data, key);
    if (step === 'commit') return await engine.commitMerge(actor, workId, data, key);
    const replay = await engine.replayMergeVerification(actor, workId, data, key); if (replay) return replay;
    return await engine.verifyMerge(actor, workId, data, { ...observation(await reload(workId)), prState: 'open', draft: false, clockOffset: { min: -1000, max: 0 } }, key);
  } catch (error) {
    if (error instanceof Refusal) throw Object.assign(new Error(JSON.stringify({ error: error.message })), { confirmedRefusal: error.status >= 400 && error.status < 500 });
    throw error;
  }
};
/** GitHub as the broker sees it through `gh`: an open pull request at the candidate head on a base at its bound tip, protected, and a merge that succeeds. */
const github = (calls: string[][] = []) => (_command: string, args: string[]) => {
  calls.push(args);
  if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefOid: head, baseRefName: 'main', state: 'OPEN', isDraft: false });
  if (args[1]?.includes('/git/ref/heads/')) return JSON.stringify({ ref: 'refs/heads/main', object: { type: 'commit', sha: base } });
  if (args.includes('--include')) return `Date: ${new Date().toUTCString()}\n\n{}`;
  if (args[1] === '--method') return JSON.stringify({ merged: true, sha: mergeSha });
  return JSON.stringify(validProtection);
};
const snapshot = async () => ({ work: await store.list(), now: await dbNow() });
/** The durable loop's effects, with the guarded merge wired to one executor instance exactly as `master run` wires it. */
function daemon(executor: MergeExecutor, calls: string[][] = [], mutate = transport(coordinator)): DaemonEffects & { merges: string[] } {
  const merges: string[] = [];
  const guarded = mergeExecutor(config, snapshot, mutate, executor, randomUUID(), github(calls));
  return { merges, agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), snapshot, closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    merge: async item => { merges.push(item.key); return guarded(item); },
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'none', deployed: [], pending: [] }), recordDeployment: async () => ({}), requestSmoke: () => {}, persist: async () => {} };
}

test('integration:merge-executor-instance-owner — the daemon loop and an interactive merge race one candidate under one coordinator credential: exactly one acquires, the other stands down without cancelling, and the execution reaches its own terminal state', async () => {
  const work = await candidate();
  const loop: MergeExecutor = { principal: coordinator.id, instance: `daemon-${randomUUID()}` };
  const interactive: MergeExecutor = { principal: coordinator.id, instance: randomUUID() };
  assert.notEqual(mergeExecutionOwner(loop), mergeExecutionOwner(interactive));
  assert.ok(mergeExecutionOwner(loop).startsWith(`${coordinator.id}#`), 'the owner names the principal and the instance');
  // The interleaving that cost GY-81 its delivery: the loop acquires the execution, and while it
  // holds it — before its verification — the interactive merge reads the record and judges it.
  let release!: () => void; const acquired = new Promise<void>(resolve => { release = resolve; });
  let proceed!: () => void; const judged = new Promise<void>(resolve => { proceed = resolve; });
  const loopCalls: string[][] = [];
  const effects = daemon(loop, loopCalls, async (path, data, key) => {
    if (path.endsWith('/merge-verify')) await judged;
    const result = await transport(coordinator)(path, data, key);
    if (path.endsWith('/merge-acquire')) release();
    return result;
  });
  const cycle = runCycle(config, emptyDaemonState(config), effects);
  await acquired;
  const interactiveMerge = mergeExecutor(config, snapshot, transport(coordinator), interactive, randomUUID(), github());
  await assert.rejects(interactiveMerge(await reload(work.id)), /merge execution .* is held by graphyard-master#daemon-.* this executor stands down without cancelling it/, 'the interactive executor does not resume or cancel an execution another instance holds');
  proceed();
  const performed = await cycle;
  assert.deepEqual(effects.merges, [work.key], 'the loop invoked the guarded merge for the candidate');
  const loopMerge = performed.actions.find(action => action.kind === 'merge')!;
  assert.equal(loopMerge.state, 'done', loopMerge.detail); assert.match(loopMerge.detail, /merge requested/);
  const acquiredEvents = await events(work.id, 'merge.execution.acquired');
  assert.equal(acquiredEvents.length, 1, 'exactly one executor acquired');
  assert.equal(acquiredEvents[0].payload.details.owner, mergeExecutionOwner(loop), 'the execution is owned by the loop instance, not by the principal');
  assert.equal((await events(work.id, 'merge.execution.cancelled')).length, 0, 'the losing executor cancelled nothing');
  assert.equal((await events(work.id, 'merge.execution.committed')).length, 1);
  assert.equal(loopCalls.filter(args => args[1] === '--method').length, 1, 'the provider merge was called exactly once');
  // The execution is the loop instance's alone: neither the bare principal nor another instance can cancel it.
  const held = await reload(work.id); const execution = held.mergeExecution!;
  assert.equal(execution.owner, mergeExecutionOwner(loop)); assert.ok(execution.committingAt);
  await assert.rejects(engine.cancelMerge(coordinator, work.id, { executionId: execution.id, reason: 'Interactive executor gives up' , executor: interactive.instance }, id()), /owned by another coordinator executor instance/);
  await assert.rejects(engine.cancelMerge(coordinator, work.id, { executionId: execution.id, reason: 'A principal-only caller' }, id()), /owned by another coordinator executor instance/);
  await assert.rejects(engine.commitMerge(coordinator, work.id, { executionId: execution.id, executor: interactive.instance }, id()), /owned by another coordinator executor instance/);
  assert.throws(() => assertMergeCandidate(held, new Date().toISOString(), mergeExecutionOwner(interactive)), /stands down without cancelling/);
  assert.throws(() => assertMergeCandidate(held, new Date().toISOString(), coordinator.id), /stands down without cancelling/, 'the principal alone never resumes an instance-owned execution');
  // The execution reaches its terminal state: GitHub's merge, observed, delivers the item on that execution.
  await delay(5);
  const delivered = await engine.observe(work.id, held.revision, await merged(work));
  assert.equal(delivered.stage, 'done'); assert.equal(delivered.mergeExecution, null);
  assert.equal(delivered.delivery?.authorizationRevision, execution.authorizationRevision);
  assert.equal(delivered.violations.length, 0);
});

test('integration:losing-executor-stands-down — a confirmed already-verified or already-committed refusal makes the executor stand down and leave the execution intact; no merge.execution.cancelled follows', async () => {
  assert.equal(stepAlreadyPerformed(Object.assign(new Error('{"error":"Merge execution was already verified; retry with the original idempotency key"}'), { confirmedRefusal: true })), true);
  assert.equal(stepAlreadyPerformed(Object.assign(new Error('{"error":"Merge execution was already committed; retry with the original idempotency key"}'), { confirmedRefusal: true })), true);
  assert.equal(stepAlreadyPerformed(new Error('Merge execution was already verified')), false, 'an unconfirmed failure is not a performed step');
  assert.equal(stepAlreadyPerformed(Object.assign(new Error('{"error":"GitHub gates changed during merge execution"}'), { confirmedRefusal: true })), false);
  // Already verified: the first executor verified; a second attempt reads a record that predates
  // the verification and asks to verify again with its own key. The refusal is the engine's, the
  // execution stays exactly as the first executor left it, and nothing is cancelled.
  const first = await candidate();
  const executor: MergeExecutor = { principal: coordinator.id, instance: `daemon-${randomUUID()}` };
  const granted = await engine.acquireMerge(coordinator, first.id, { expectedRevision: first.revision, sha: head, baseSha: base, policyRevision: first.policyRevision, executor: executor.instance }, id());
  const verified = await engine.verifyMerge(coordinator, first.id, { executionId: granted.execution.id, executor: executor.instance }, { ...observation(first), prState: 'open', draft: false }, id());
  const stale = { ...(await reload(first.id)), mergeExecution: granted.execution };
  const staleSnapshot = async () => ({ work: [stale], now: await dbNow() });
  const attempt = mergeExecutor(config, staleSnapshot, transport(coordinator), executor, randomUUID(), github());
  await assert.rejects(attempt(stale), /already verified.*stands down and leaves the execution intact/s);
  const afterVerify = await reload(first.id);
  assert.equal(afterVerify.mergeExecution?.id, granted.execution.id, 'the execution is intact');
  assert.equal(afterVerify.mergeExecution?.verifiedAt, verified.verifiedAt);
  assert.equal((await events(first.id, 'merge.execution.cancelled')).length, 0, 'no merge.execution.cancelled follows an already-verified refusal');
  // Already committed: the first executor committed to the provider; a stale attempt resumes the
  // recorded verification and asks to commit. It stands down before any provider call.
  const committed = await engine.commitMerge(coordinator, first.id, { executionId: granted.execution.id, executor: executor.instance }, id());
  const staleVerified = { ...(await reload(first.id)), mergeExecution: { ...afterVerify.mergeExecution!, committingAt: undefined } };
  const calls: string[][] = [];
  const later = mergeExecutor(config, async () => ({ work: [staleVerified], now: await dbNow() }), transport(coordinator), executor, randomUUID(), github(calls));
  await assert.rejects(later(staleVerified), /already committed.*stands down and leaves the execution intact/s);
  assert.equal(calls.filter(args => args[1] === '--method').length, 0, 'no provider merge from the executor that stood down');
  const afterCommit = await reload(first.id);
  assert.equal(afterCommit.mergeExecution?.committingAt, committed.committingAt, 'the committed execution is intact');
  assert.equal((await events(first.id, 'merge.execution.cancelled')).length, 0, 'no merge.execution.cancelled follows an already-committed refusal');
  // The owner finishes: the observed merge delivers on the execution the loser left alone.
  await delay(5);
  const delivered = await engine.observe(first.id, afterCommit.revision, await merged(first));
  assert.equal(delivered.stage, 'done'); assert.equal(delivered.delivery?.authorizationRevision, granted.execution.authorizationRevision);
});

test('integration:merged-without-authorization-recovery — an observed merge whose execution was cancelled records the violation, stays out of done, and reaches done only through a two-party merge decision re-checked at the merge cutoff, with authorizationRevision and evidenceAsOf from the historical snapshot', async () => {
  // GY-81's ledger: acquired, verified, committed, cancelled before the merge cutoff, then merged.
  const work = await candidate();
  const executor: MergeExecutor = { principal: coordinator.id, instance: `daemon-${randomUUID()}` };
  const granted = await engine.acquireMerge(coordinator, work.id, { expectedRevision: work.revision, sha: head, baseSha: base, policyRevision: work.policyRevision, executor: executor.instance }, id());
  await engine.verifyMerge(coordinator, work.id, { executionId: granted.execution.id, executor: executor.instance }, { ...observation(work), prState: 'open', draft: false }, id());
  await engine.commitMerge(coordinator, work.id, { executionId: granted.execution.id, executor: executor.instance }, id());
  await engine.cancelMerge(coordinator, work.id, { executionId: granted.execution.id, reason: '{"error":"Merge execution was already verified; retry with the original idempotency key"}', executor: executor.instance }, id());
  await delay(5);
  const mergedObservation = await merged(work);
  let current = await engine.observe(work.id, (await reload(work.id)).revision, mergedObservation);
  assert.equal(current.stage, 'merge', 'the item stays out of done'); assert.ok(current.violations.includes(unauthorizedMergeViolation)); assert.equal(current.delivery, undefined);
  assert.equal(mergedWithoutAuthorization(current), true);
  // Every later observation re-derives the same verdict from immutable history.
  current = await engine.observe(work.id, current.revision, mergedObservation);
  assert.equal(current.stage, 'merge'); assert.deepEqual(current.violations, [unauthorizedMergeViolation]);
  // A merge decision requested before the merge is not a judgement of it: an item merged under a
  // pre-merge approval stays a violation.
  const early = await candidate();
  const earlyDecision = await mergeDecision(early, 'Pre-merge approval');
  await earlyDecision.approve();
  await delay(5);
  let earlyState = await engine.observe(early.id, (await reload(early.id)).revision, await merged(early));
  assert.equal(earlyState.stage, 'merge'); assert.ok(earlyState.violations.includes(unauthorizedMergeViolation), 'a decision requested before the merge reconciles nothing');
  // The recovery: request the decision now, after the merge. Requested alone it changes nothing.
  const decision = await mergeDecision(current, `Reconcile ${current.key}: GitHub merged ${mergeSha.slice(0, 12)} after the execution was cancelled by a second executor`);
  current = await engine.observe(work.id, (await reload(work.id)).revision, mergedObservation);
  assert.equal(current.stage, 'merge', 'a requested but unapproved decision does not deliver');
  assert.deepEqual(current.violations, [unauthorizedMergeViolation]);
  // Approved by the independent approver, the next observation re-checks the record at the cutoff and delivers.
  await decision.approve();
  const delivered = await engine.observe(work.id, current.revision, mergedObservation);
  assert.equal(delivered.stage, 'done'); assert.equal(delivered.mergeExecution, null);
  assert.deepEqual(delivered.violations, [], 'the reconciled violation leaves the record; the ledger keeps it');
  const delivery = delivered.delivery as NonNullable<Work['delivery']> & { reconciliation: any };
  assert.equal(delivery.mergeSha, mergeSha); assert.equal(delivery.mergedAt, mergedObservation.mergedAt);
  assert.equal(delivery.authorizationRevision, granted.execution.authorizationRevision, 'authorizationRevision comes from the historical execution, not the observation that delivered');
  assert.ok(delivery.authorizationRevision < delivered.revision - 2);
  // The merge instant on the repository clock, the instant the historical evidence was judged at: a
  // millisecond timestamp under a zero offset makes the cutoff the merge instant plus one, so the
  // evidence instant is the merge instant itself, and it precedes the execution's expiry.
  assert.equal(delivery.evidenceAsOf, mergedObservation.mergedAt);
  assert.ok(Date.parse(delivery.evidenceAsOf!) < Date.parse(granted.execution.expiresAt));
  assert.equal(delivery.reconciliation.decision, decision.id);
  assert.equal(delivery.reconciliation.requestedBy, operator.id); assert.equal(delivery.reconciliation.approvedBy, approver.id);
  assert.match(delivery.reconciliation.reason, /Reconcile/); assert.match(delivery.reconciliation.approvalReason, /Approved/);
  assert.match(delivery.reconciliation.judgement, /every required proof was live/);
  assert.deepEqual(delivery.reconciliation.proofs, ['integration:claim-safety']); assert.equal(delivery.reconciliation.violation, unauthorizedMergeViolation);
  const reconciled = await events(work.id, 'merge.reconciled');
  assert.equal(reconciled.length, 1); assert.equal(reconciled[0].actor, operator.id); assert.equal(reconciled[0].payload.details.decision, decision.id); assert.equal(reconciled[0].payload.details.evidenceAsOf, delivery.evidenceAsOf);
  // A later decision on the early item, requested after its merge, recovers it the same way.
  const lateDecision = await mergeDecision(earlyState, 'Reconcile after the merge'); await lateDecision.approve();
  earlyState = await engine.observe(early.id, (await reload(early.id)).revision, { ...earlyState.observation!, at: new Date().toISOString() });
  assert.equal(earlyState.stage, 'done'); assert.equal((earlyState.delivery as any).reconciliation.decision, lateDecision.id);
  // A merge the history refuses — no proof was ever live, so the acceptance gate never passed —
  // is not reconciled by any decision: the item records why, once, and stays where it is.
  const unproven = await candidate(false);
  await delay(5);
  let refused = await engine.observe(unproven.id, (await reload(unproven.id)).revision, await merged(unproven));
  assert.ok(refused.violations.includes(unauthorizedMergeViolation));
  const hopeless = await mergeDecision(refused, 'Try to reconcile an unproven merge'); await hopeless.approve();
  refused = await engine.observe(unproven.id, (await reload(unproven.id)).revision, { ...refused.observation!, at: new Date().toISOString() });
  assert.equal(refused.stage, 'acceptance', 'the stage still reads from the first failing gate');
  const reason = refused.violations.find(entry => entry.startsWith(`Reconciliation by decision ${hopeless.id} refused: `))!;
  assert.ok(reason, refused.violations.join(' | ')); assert.match(reason, /gate acceptance had not passed/); assert.match(reason, /integration:claim-safety had no live trusted evidence/);
  refused = await engine.observe(unproven.id, refused.revision, { ...refused.observation!, at: new Date().toISOString() });
  assert.equal(refused.violations.filter(entry => entry.startsWith('Reconciliation by decision ')).length, 1, 'the refusal is recorded once');
  assert.equal((await events(unproven.id, 'merge.reconciliation.refused')).length, 1);
  assert.equal(mergedWithoutAuthorization(refused), true);
});

test('unit:stuck-merge-attention — master status names an item held at the merge stage by an observed unauthorized merge as the violation with its recovery command, apart from a candidate waiting for its queue tip, and the loop asks the guarded merge for the waiting candidate only', async () => {
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
  assert.match(row.attention!, /GY-81 was merged on GitHub \(cccccccccccc at 2026-09-20T19:50:22Z\) without a valid merge execution: Merge observed without a prior authorization/);
  assert.match(row.attention!, /held at the merge stage, not waiting for its queue tip/);
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
  // The durable loop: the stuck item is named once as an escalation and never offered to the
  // guarded merge; the waiting candidate is offered as before.
  const merges: string[] = [];
  const effects: DaemonEffects = { agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [stuck, waiting], now: at }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    merge: async work => { merges.push(work.key); return { result: 'merge requested' }; }, observeDeployment: async () => ({ source: 'unavailable', sha: null, at, reason: 'none', deployed: [], pending: [] }), recordDeployment: async () => ({}), requestSmoke: () => {}, persist: async () => {} };
  const state = emptyDaemonState(config);
  const cycle = await runCycle(config, state, effects);
  assert.deepEqual(merges, ['GY-82']);
  const escalation = cycle.actions.find(action => action.kind === 'escalation' && action.work === 'GY-81')!;
  assert.match(escalation.detail, /merged on GitHub \(cccccccccccc at 2026-09-20T19:50:22Z\) without a valid merge execution/);
  assert.match(escalation.detail, /graphyard master decide GY-81 merge REASON, then graphyard master approver GY-81 DECISION/);
  const again = await runCycle(config, state, effects);
  assert.equal(merges.includes('GY-81'), false, 'the stuck item is never offered to the guarded merge');
  assert.equal(again.actions.some(action => action.kind === 'escalation' && action.work === 'GY-81'), false, 'the escalation is recorded once');
});
