import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { processJob, type GitHub } from '../src/github.js';
import { server } from '../src/server.js';
import { daemonEffects, routineDecision } from '../src/master-daemon.js';
import { refusalAction } from '../src/model/refusal-mapping.js';
import { checkRerunVisibilityMs, queueRef, reconcileCheckReruns, rerunFailedChecksEvent, tipVerdict, type QueuePlacement, type QueueSpeculation } from '../src/merge-queue.js';
import { defaultRerunFailedChecks, masterConfigSchema, maxRerunFailedChecks, rerunFailedChecks } from '../src/master/profiles.js';
import type { Observation, Principal, Work } from '../src/model.js';

// GY-516: a single infrastructure flake on a merge-queue tip ejected the validated head and cost the
// whole queue a review, proof and CI round. A failed required check is rerun once on the same sha
// before it counts. Each test is named for the proof it produces.
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const treeOf = (sha: string) => sha40(`7${sha.slice(0, 2)}`);
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
const producer: Principal = { id: 'ci-runner', role: 'producer', proofs: ['unit:flake'] };
let database: EmbeddedPostgres, store: Store, engine: Engine;
let pr = 700;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TIP_FLAKE_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 516);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-tip-flake-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.controlPlaneAppId = 1234;
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

type Check = Observation['checks'][number];
const run = (name: string, id: number, result: string): Check => ({ name, result, appId: 15368, id });
const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
const kinds = async (work: Work) => (await store.events(work.id)).map(event => event.kind).reverse();
const gate = (work: Work, name: string) => work.gates.find(entry => entry.name === name)!;
async function clearQueue() { await store.pool.query("UPDATE work_items SET document=document-'queue' WHERE document->>'stage'<>'done'"); }
async function onlyJob(work: Work) {
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [work.id]);
}
async function submitted(title: string) {
  let work = await engine.execute(operator, 'create', null, { title, plannedFiles: ['src/flake.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:flake'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/flake/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-1` }, randomUUID());
  return engine.execute(worker, 'submit', work.id, { epoch: 1, pr: ++pr }, randomUUID());
}
function seen(work: Work, candidate: { sha: string; baseSha: string }, checks: Check[]): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { ...candidate, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' }, checks,
    reviews: [{ id: 41, reviewer: 'graphyard-reviewer[bot]', sha: candidate.sha, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: treeOf(candidate.baseSha), baseTipContained: true,
    files: ['src/flake.ts'], scopeFiles: [], at: new Date().toISOString() };
}
/** GitHub as the job loop reaches it: it observes `checks()` on the tip and reruns failed jobs as `rerun` answers. */
function adapter(candidate: { sha: string; baseSha: string }, checks: () => Check[], rerun: ((checkRunId: number) => Promise<{ runId: number }>) | null) {
  const reruns: number[] = [];
  return { reruns, github: {
    observe: async (work: Work) => seen(work, candidate, checks()),
    publishSpeculativeTip: async (work: Work, placement: QueuePlacement): Promise<QueueSpeculation> =>
      ({ ref: queueRef(work.key), tip: candidate.sha, base: placement.predictedBase!, baseTree: treeOf(placement.predictedBase!), predecessors: placement.predecessors, policyRevision: work.policyRevision, publishedAt: new Date().toISOString(), merge: null }),
    ...(rerun ? { rerunFailedJobs: async (id: number) => { reruns.push(id); return rerun(id); } } : {}),
    requestCodex: async () => { throw new Error('no review request expected'); },
    publish: async () => {},
  } as unknown as GitHub };
}
/** A head approved and proven, queued, and published as its own speculative tip with every required check passing. */
async function queuedTip(title: string, head: string, base: string) {
  let work = await submitted(title);
  work = await engine.observe(work.id, work.revision, seen(work, { sha: head, baseSha: base }, [run('test', 1, 'success'), run('typecheck', 2, 'success')]));
  work = await engine.execute(producer, 'evidence', work.id, { proof: 'unit:flake', sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 }, scopeFiles: ['src/flake.ts'] }, randomUUID());
  assert.ok(work.queue, `enqueued: ${work.gates.flatMap(entry => entry.reasons).join('; ')}`);
  await onlyJob(work);
  await processJob(engine, adapter({ sha: head, baseSha: base }, () => [run('test', 1, 'success'), run('typecheck', 2, 'success')], null).github);
  work = await reload(work);
  assert.equal(work.queue?.speculation?.tip, head, 'the tip is published');
  assert.ok(work.gates.every(entry => entry.passed), work.gates.flatMap(entry => entry.reasons).join('; '));
  return work;
}
/** One reconciliation of `work` through the job loop, observing `checks` on its tip. */
async function reconcile(work: Work, checks: Check[], rerun: ((id: number) => Promise<{ runId: number }>) | null = async () => ({ runId: 9001 })) {
  await onlyJob(work);
  const github = adapter({ sha: work.candidate!.sha, baseSha: work.candidate!.baseSha }, () => checks, rerun);
  await processJob(engine, github.github);
  return { work: await reload(work), reruns: github.reruns };
}
const bindings = (work: Work) => ({ sequence: work.queue?.sequence ?? null, tip: work.queue?.speculation?.tip ?? null, review: gate(work, 'review').passed, acceptance: gate(work, 'acceptance').passed, evidence: work.evidence.map(entry => entry.id) });

test('unit:tip-flake-rerun-once — a failed required check on a queued tip is rerun once, keeping position, approval and proofs; a pass proceeds to merge, a second failure ejects, never more than one rerun per sha and check', async () => {
  await clearQueue();
  const main = sha40('b1'), head = sha40('a1');
  let work = await queuedTip('Flaky tip', head, main);
  const held = bindings(work);

  // The tip's test job fails on an infrastructure flake: one rerun is requested, outside any transaction, and the entry holds.
  let step = await reconcile(work, [run('test', 11, 'failure'), run('typecheck', 12, 'success')]);
  work = step.work;
  assert.deepEqual(step.reruns, [11], 'GitHub was asked to rerun the failed jobs of that run once');
  assert.deepEqual(bindings(work), held, 'position, tip, approval and proofs are kept while the rerun is pending');
  assert.equal(work.queueEjection ?? null, null);
  assert.deepEqual(work.checkReruns!.map(entry => [entry.sha, entry.check, entry.failedRunId, entry.state, entry.runId]), [[head, 'test', 11, 'requested', 9001]]);
  assert.ok(gate(work, 'merge').reasons.some(reason => /required CI check test failed and its failed jobs are rerunning \(workflow run 9001\); the entry keeps its position/.test(reason)), 'master status reads the pending rerun on the queue row');
  assert.equal(tipVerdict(work, [15368]), undefined, 'a batch waits for the rerun as for a pending run');
  assert.deepEqual((await kinds(work)).filter(kind => kind.startsWith('check.rerun')), ['check.rerun.owed', 'check.rerun.requested'], 'the rerun is in the item\'s history');
  assert.equal(routineDecision(work, { autoMerge: true }, Date.now()), null, 'the loop asks for no rework round while the rerun is pending');

  // Until GitHub shows the rerun, the same failure is seen again: it still holds and is not rerun a second time.
  step = await reconcile(work, [run('test', 11, 'failure'), run('typecheck', 12, 'success')]);
  assert.deepEqual(step.reruns, [], 'no second request for the same failure');
  assert.deepEqual(bindings(step.work), held);
  step = await reconcile(work, [run('test', 11, 'failure'), run('test', 13, 'in_progress'), run('typecheck', 12, 'success')]);
  assert.deepEqual(bindings(step.work), held, 'the rerun running keeps the entry in place');

  // The rerun passes: the entry proceeds to merge on the same tip with every binding it had.
  step = await reconcile(work, [run('test', 11, 'failure'), run('test', 13, 'success'), run('typecheck', 12, 'success')]);
  work = step.work;
  assert.deepEqual(bindings(work), held);
  assert.ok(work.gates.every(entry => entry.passed), work.gates.flatMap(entry => entry.reasons).join('; '));
  assert.equal(work.stage, 'merge');
  assert.ok(work.mergeAuthorization, 'the unchanged tip is authorized to merge');
  assert.deepEqual(work.checkReruns!.map(entry => [entry.state, entry.rerunId]), [['passed', 13]]);
  assert.ok((await kinds(work)).includes('check.rerun.passed'));

  // The one rerun for this sha and check is spent: a further failure ejects as before, with no rerun.
  step = await reconcile(work, [run('test', 11, 'failure'), run('test', 13, 'success'), run('test', 14, 'failure'), run('typecheck', 12, 'success')]);
  assert.deepEqual(step.reruns, []);
  assert.equal(step.work.queue ?? null, null);
  assert.match(step.work.queueEjection!.reason, new RegExp(`^Required CI check test did not pass on speculative tip ${head.slice(0, 12)}`));
});

test('unit:tip-flake-rerun-once — a rerun that fails again ejects the entry, naming the rerun; a refused rerun lets the failure stand at once', async () => {
  await clearQueue();
  const main = sha40('b2'), head = sha40('a2');
  let work = await queuedTip('Broken tip', head, main);
  let step = await reconcile(work, [run('test', 21, 'failure'), run('typecheck', 22, 'success')]);
  assert.deepEqual(step.reruns, [21]);
  assert.ok(step.work.queue);
  step = await reconcile(step.work, [run('test', 21, 'failure'), run('test', 23, 'failure'), run('typecheck', 22, 'success')]);
  work = step.work;
  assert.deepEqual(step.reruns, [], 'the second failure on the same sha is not rerun');
  assert.equal(work.queue ?? null, null, 'the second failure ejects');
  assert.match(work.queueEjection!.reason, /did not pass on speculative tip [0-9a-f]{12}, again after one rerun of its failed jobs/);
  assert.deepEqual(work.checkReruns!.map(entry => [entry.state, entry.failedRunId, entry.rerunId]), [['failed', 21, 23]]);
  assert.deepEqual((await kinds(work)).filter(kind => kind.startsWith('check.rerun') || kind === 'queue.ejected'), ['check.rerun.owed', 'check.rerun.requested', 'check.rerun.failed', 'queue.ejected']);

  // GitHub refusing the rerun (a check that is not an Actions job, a missing permission) is recorded, and the failure ejects.
  await clearQueue();
  const refusedHead = sha40('a3');
  work = await queuedTip('Unrerunnable tip', refusedHead, main);
  step = await reconcile(work, [run('test', 31, 'failure'), run('typecheck', 32, 'success')], async () => { throw new Error('GitHub POST /actions/runs/5/rerun-failed-jobs failed (403)'); });
  assert.deepEqual(step.reruns, [31]);
  assert.equal(step.work.queue ?? null, null);
  assert.match(step.work.queueEjection!.reason, /its rerun was refused: GitHub POST .* failed \(403\)/);
  assert.deepEqual(step.work.checkReruns!.map(entry => entry.state), ['refused']);
});

test('unit:tip-flake-rerun-once — a failed check on a candidate head outside the queue is rerun once before the head is left at test', async () => {
  await clearQueue();
  const main = sha40('b4'), head = sha40('a4');
  let work = await submitted('Flaky head');
  work = await engine.observe(work.id, work.revision, seen(work, { sha: head, baseSha: main }, [run('test', 41, 'failure'), run('typecheck', 42, 'success')]));
  assert.deepEqual(work.checkReruns!.map(entry => [entry.check, entry.state]), [['test', 'owed']]);
  const failing = 'Required CI check test has not passed on the current candidate';
  // Owed and then running, the rerun holds the head: the loop's decision asks for no rework round and
  // the test gate's refusal waits for a reading, so the head is not sent back to its worker.
  assert.equal(routineDecision(work, { autoMerge: true }, Date.now()), null, 'no rework while the rerun is owed');
  assert.equal(refusalAction(work, 'test', failing), 'resync');
  let step = await reconcile(work, [run('test', 41, 'failure'), run('typecheck', 42, 'success')]);
  assert.deepEqual(step.reruns, [41]);
  assert.equal(routineDecision(step.work, { autoMerge: true }, Date.now()), null, 'no rework while the rerun is requested');
  assert.equal(refusalAction(step.work, 'test', failing), 'resync');
  assert.notEqual(step.work.nextAction?.kind, 'request-rework');
  step = await reconcile(step.work, [run('test', 41, 'failure'), run('test', 43, 'failure'), run('typecheck', 42, 'success')]);
  assert.deepEqual(step.reruns, []);
  assert.deepEqual(step.work.checkReruns!.map(entry => entry.state), ['failed']);
  assert.deepEqual(gate(step.work, 'test').reasons, [failing]);
  // The second failure on the same sha is the worker's: the rework round is asked for as before.
  assert.equal(refusalAction(step.work, 'test', failing), 'request-rework');
  assert.deepEqual([routineDecision(step.work, { autoMerge: true }, Date.now())?.action, routineDecision(step.work, { autoMerge: true }, Date.now())?.binding], ['rework', `${head}:ci:test`]);
  // A rerun GitHub accepted but never ran stops holding after the visibility bound.
  const record = { sha: head, check: 'test', failedRunId: 41, state: 'requested' as const, at: new Date(Date.now() - checkRerunVisibilityMs).toISOString() };
  const expired = reconcileCheckReruns({ ...step.work, checkReruns: [record], observation: seen(step.work, { sha: head, baseSha: main }, [run('test', 41, 'failure')]) }, [15368], 1, new Date());
  assert.deepEqual(expired.reruns.map(entry => entry.state), ['expired']);
});

test('unit:tip-flake-rerun-configurable — mergeQueue.rerunFailedChecks defaults to one rerun in every installation, and 0 disables it', async () => {
  assert.equal(defaultRerunFailedChecks, 1);
  assert.equal(rerunFailedChecks(undefined), 1);
  assert.equal(rerunFailedChecks({ mergeQueue: {} }), 1);
  assert.equal(rerunFailedChecks({ mergeQueue: { rerunFailedChecks: 0 } }), 0);
  assert.equal(new Engine(store).rerunFailedChecks, 1, 'the control plane applies the product default');
  const config = { version: 1, url: 'http://127.0.0.1:1', credentialFile: '/tmp/credential', cliPath: '/tmp/cli.mjs', repository: 'owner/project', baseBranch: 'main', githubAppId: 1, hostId: 'machine-a', masterAgentName: 'graphyard-master' };
  assert.equal(masterConfigSchema.parse({ ...config, mergeQueue: { rerunFailedChecks: 0 } }).mergeQueue!.rerunFailedChecks, 0);
  assert.throws(() => masterConfigSchema.parse({ ...config, mergeQueue: { rerunFailedChecks: maxRerunFailedChecks + 1 } }));
  assert.throws(() => masterConfigSchema.parse({ ...config, mergeQueue: { rerunFailedChecks: -1 } }));

  // Disabled end to end: the master publishes `mergeQueue.rerunFailedChecks: 0` from its own config
  // (POST /api/merge-queue), the control plane applies it and keeps it in the installation ledger,
  // and the first failure then ejects exactly as before, with GitHub never asked.
  const tokens = { coordinator: 'm'.repeat(32), worker: 'w'.repeat(32) };
  const http = server(engine, [{ id: 'master', role: 'coordinator', token: tokens.coordinator }, { id: 'worker-a', role: 'worker', token: tokens.worker }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const api = async (path: string, token: string, data: unknown) => {
    const response = await fetch(`${url}/api/${path}`, { method: 'POST', body: JSON.stringify(data), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } });
    return { status: response.status, body: await response.json() };
  };
  let configured: number | undefined = 0;
  const posted: unknown[] = [];
  const effects = daemonEffects(process.cwd(), () => ({ url, run: {}, mergeQueue: { rerunFailedChecks: configured } }) as any, { snapshot: async () => ({ work: [], now: new Date().toISOString() }), executor: {} as any,
    mutate: async (path: string, data: unknown) => { posted.push(data); const response = await api(path, tokens.coordinator, data); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; } });
  try {
    assert.equal((await api('merge-queue', tokens.worker, { rerunFailedChecks: 0 })).status, 403, 'only the master (or an operator) sets it');
    assert.equal((await api('merge-queue', tokens.coordinator, { rerunFailedChecks: maxRerunFailedChecks + 1 })).status, 400);
    assert.equal((await api('merge-queue', tokens.coordinator, {})).status, 400);
    await effects.publishMergeBatchSize!();
    await effects.publishMergeBatchSize!();
    assert.deepEqual(posted, [{ batchSize: 4, rerunFailedChecks: 0 }], 'published once, not every cycle');
    assert.equal(engine.rerunFailedChecks, 0, 'the control plane applies the master\'s setting at once');
    assert.equal(await new Engine(store).loadRerunFailedChecks(), 0, 'a restarted control plane reads it back from the installation ledger');
    await clearQueue();
    const work = await queuedTip('No rerun', sha40('a5'), sha40('b5'));
    const step = await reconcile(work, [run('test', 51, 'failure'), run('typecheck', 52, 'success')]);
    assert.deepEqual(step.reruns, []);
    assert.equal(step.work.queue ?? null, null);
    assert.equal(step.work.queueEjection!.reason, `Required CI check test did not pass on speculative tip ${sha40('a5').slice(0, 12)}`);
    assert.equal(step.work.checkReruns ?? null, null);
    // Removing the setting publishes the product default again.
    configured = undefined;
    await effects.publishMergeBatchSize!();
    assert.deepEqual(posted.at(-1), { batchSize: 4, rerunFailedChecks: 1 });
    assert.equal(await new Engine(store).loadRerunFailedChecks(), 1);
    assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM events WHERE work_id IS NULL AND kind=$1', [rerunFailedChecksEvent])).rows[0].n, 2, 'one ledger entry per change');
  } finally {
    engine.rerunFailedChecks = defaultRerunFailedChecks;
    await new Promise<void>(resolve => http.close(() => resolve()));
  }

  // A higher setting reruns that many times per sha and check.
  const head = sha40('a6'), base = sha40('b6');
  const item = { candidate: { sha: head, baseSha: base }, policy: { checks: ['test'] }, checkReruns: [{ sha: head, check: 'test', failedRunId: 61, state: 'failed' as const, rerunId: 62, at: new Date().toISOString() }],
    observation: { candidate: { sha: head, baseSha: base }, merged: false, checks: [run('test', 61, 'failure'), run('test', 62, 'failure')] } } as unknown as Work;
  assert.deepEqual(reconcileCheckReruns(item, [15368], 1, new Date()).transitions, [], 'one rerun spent at the default');
  assert.deepEqual(reconcileCheckReruns(item, [15368], 2, new Date()).transitions.map(entry => [entry.kind, entry.rerun.failedRunId]), [['check.rerun.owed', 62]]);
});
