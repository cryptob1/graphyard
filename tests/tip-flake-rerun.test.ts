import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { GitHub as GitHubClient, RerunPending, processJob, type GitHub } from '../src/github.js';
import { server } from '../src/server.js';
import { daemonEffects, routineDecision } from '../src/master-daemon.js';
import { checkStates } from '../src/model/pr-steps.js';
import { plainReason } from '../src/model/plain-status.js';
import { refusalAction } from '../src/model/refusal-mapping.js';
import { checkRerunVisibilityMs, reconcileCheckReruns, rerunFailedChecksEvent } from '../src/merge-queue.js';
import { defaultRerunFailedChecks, masterConfigSchema, maxRerunFailedChecks, rerunFailedChecks } from '../src/master/profiles.js';
import { evaluate, type Observation, type Principal, type Work } from '../src/model.js';

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
  const databaseDir = await temporaryDirectory('tip-flake');
  database = new EmbeddedPostgres({ databaseDir, user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
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
/** GitHub as the job loop reaches it: it observes `checks()` on the head and reruns failed jobs as `rerun` answers. */
function adapter(candidate: { sha: string; baseSha: string }, checks: () => Check[], rerun: ((checkRunId: number) => Promise<{ runId: number }>) | null) {
  const reruns: number[] = [];
  return { reruns, github: {
    observe: async (work: Work) => seen(work, candidate, checks()),
    ...(rerun ? { rerunFailedJobs: async (id: number) => { reruns.push(id); return rerun(id); } } : {}),
    requestCodex: async () => { throw new Error('no review request expected'); },
    publish: async () => {},
  } as unknown as GitHub };
}
/** One reconciliation of `work` through the job loop, observing `checks` on its head. */
async function reconcile(work: Work, checks: Check[], rerun: ((id: number) => Promise<{ runId: number }>) | null = async () => ({ runId: 9001 })) {
  await onlyJob(work);
  const github = adapter({ sha: work.candidate!.sha, baseSha: work.candidate!.baseSha }, () => checks, rerun);
  await processJob(engine, github.github);
  return { work: await reload(work), reruns: github.reruns };
}

test('unit:tip-flake-rerun-once — a failed check on a candidate head outside the queue is rerun once before the head is left at test', async () => {
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
  assert.deepEqual(gate(step.work, 'test').reasons, [failing + '; rerun: failed again after rerunning its failed jobs']);
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
  // and the first failure then counts at once, with GitHub never asked.
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
  const effects = daemonEffects(process.cwd(), () => ({ url, run: {}, mergeQueue: { rerunFailedChecks: configured } }) as any, { snapshot: async () => ({ work: [], now: new Date().toISOString() }),
    mutate: async (path: string, data: unknown) => { posted.push(data); const response = await api(path, tokens.coordinator, data); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; } });
  try {
    assert.equal((await api('merge-queue', tokens.worker, { rerunFailedChecks: 0 })).status, 403, 'only the master (or an operator) sets it');
    assert.equal((await api('merge-queue', tokens.coordinator, { rerunFailedChecks: maxRerunFailedChecks + 1 })).status, 400);
    assert.equal((await api('merge-queue', tokens.coordinator, {})).status, 400);
    await effects.publishMergeSettings!();
    await effects.publishMergeSettings!();
    assert.deepEqual(posted, [{ rerunFailedChecks: 0 }], 'published once, not every cycle');
    assert.equal(engine.rerunFailedChecks, 0, 'the control plane applies the master\'s setting at once');
    assert.equal(await new Engine(store).loadRerunFailedChecks(), 0, 'a restarted control plane reads it back from the installation ledger');
    let work = await submitted('No rerun');
    work = await engine.observe(work.id, work.revision, seen(work, { sha: sha40('a5'), baseSha: sha40('b5') }, [run('test', 51, 'failure'), run('typecheck', 52, 'success')]));
    const step = await reconcile(work, [run('test', 51, 'failure'), run('typecheck', 52, 'success')]);
    assert.deepEqual(step.reruns, []);
    assert.equal(step.work.checkReruns ?? null, null);
    assert.equal(refusalAction(step.work, 'test', 'Required CI check test has not passed on the current candidate'), 'request-rework', 'the first failure is the worker\'s at once');
    // Removing the setting publishes the product default again.
    configured = undefined;
    await effects.publishMergeSettings!();
    assert.deepEqual(posted.at(-1), { rerunFailedChecks: 1 });
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

test('manual:review-followups-triaged GY-731.1: gate, rerun hold and rework select the same trusted run by ID', async () => {
  const main = sha40('b731'), head = sha40('a731');
  let work = await submitted('Trusted rerun selection');
  const checks = [
    { ...run('test', 101, 'failure'), attempt: 8 },
    run('typecheck', 102, 'success'),
    { ...run('test', 999, 'failure'), appId: 777, attempt: 99 },
  ];
  work = await engine.observe(work.id, work.revision, seen(work, { sha: head, baseSha: main }, checks));
  assert.match(gate(work, 'test').reasons[0], /rerun: one rerun of its failed jobs is owed/);
  assert.equal(checkStates(work, [15368]).find(check => check.name === 'test')?.state, 'failed');
  assert.match(plainReason(gate(work, 'test').reasons[0], 'test').text, /rerun: one rerun.*owed/);
  assert.equal(routineDecision(work, { autoMerge: true }, Date.now()), null);
  assert.equal(refusalAction(work, 'test', gate(work, 'test').reasons[0]), 'resync');
  let step = await reconcile(work, checks);
  assert.deepEqual(step.reruns, [101], 'the unrelated App is never rerun');
  assert.match(gate(step.work, 'test').reasons[0], /rerun: its failed jobs are rerunning \(workflow run 9001\)/);
  assert.equal(routineDecision(step.work, { autoMerge: true }, Date.now()), null);
  // A larger check-run ID wins even when an older run has a higher workflow attempt.
  step = await reconcile(step.work, [...checks, { ...run('test', 103, 'pending'), attempt: 1 }]);
  assert.equal(routineDecision(step.work, { autoMerge: true }, Date.now()), null);
  assert.equal(refusalAction(step.work, 'test', gate(step.work, 'test').reasons[0]), 'resync');
  step = await reconcile(step.work, [...checks, { ...run('test', 103, 'success'), attempt: 1 }]);
  assert.equal(gate(step.work, 'test').passed, true);
  assert.equal(routineDecision(step.work, { autoMerge: true }, Date.now()), null);
});

test('manual:review-followups-triaged GY-731.2: custom and empty CI trust configurations reach downstream rework decisions', async () => {
  const custom = new Engine(store, [777], 120, 'owner/project');
  let work = await submitted('Custom CI rerun selection');
  const candidate = { sha: sha40('a732'), baseSha: sha40('b732') };
  const checks = [{ ...run('test', 10, 'failure'), appId: 777 }, run('test', 999, 'failure'), { ...run('typecheck', 11, 'success'), appId: 777 }];
  work = await custom.observe(work.id, work.revision, seen(work, candidate, checks));
  assert.deepEqual(gate(work, 'test').ciAppIds, [777]);
  assert.equal(routineDecision(work, { autoMerge: true }, Date.now()), null);
  work = await custom.observe(work.id, work.revision, seen(work, candidate, [...checks, { ...run('test', 12, 'failure'), appId: 777 }]));
  assert.equal(refusalAction(work, 'test', gate(work, 'test').reasons[0]), 'request-rework');
  assert.equal(routineDecision(work, { autoMerge: true }, Date.now())?.action, 'rework');
  const empty = new Engine(store, [], 120, 'owner/project');
  work = await empty.observe(work.id, work.revision, seen(work, candidate, checks));
  assert.deepEqual(gate(work, 'test').ciAppIds, []);
  assert.equal(routineDecision(work, { autoMerge: true }, Date.now()), null);
  assert.equal(refusalAction(work, 'test', gate(work, 'test').reasons[0]), 'resync');
});

test('manual:review-followups-triaged GY-731.4: owed reruns expire without a visible run and are never requested twice', async () => {
  let work = await submitted('Lost rerun request');
  const candidate = { sha: sha40('a733'), baseSha: sha40('b733') };
  work = await engine.observe(work.id, work.revision, seen(work, candidate, [run('test', 10, 'failure')]));
  const now = new Date(), at = new Date(now.getTime() - checkRerunVisibilityMs).toISOString();
  work = { ...work, checkReruns: [{ ...work.checkReruns![0], at }] };
  for (const checks of [[run('test', 10, 'failure')], [], [{ ...run('test', 999, 'pending'), appId: 777 }]]) {
    const result = reconcileCheckReruns({ ...work, observation: seen(work, candidate, checks) }, [15368], 1, now);
    assert.deepEqual(result.reruns.map(entry => entry.state), ['expired']);
    assert.deepEqual(result.transitions.map(entry => entry.kind), ['check.rerun.expired']);
    assert.match(result.reruns[0].detail!, /remained owed.*15 minutes/);
    assert.deepEqual(reconcileCheckReruns({ ...work, checkReruns: result.reruns }, [15368], 1, now).transitions, []);
  }
  const visible = reconcileCheckReruns({ ...work, observation: seen(work, candidate, [run('test', 11, 'pending')]) }, [15368], 1, now);
  assert.equal(visible.reruns[0].state, 'requested', 'a visible run may finish past the visibility bound');
});

test('manual:review-followups-triaged GY-731.3: a known missing Actions grant holds the job before calling GitHub', async () => {
  let work = await submitted('Missing rerun permission');
  const candidate = { sha: sha40('a734'), baseSha: sha40('b734') };
  const checks = [run('test', 10, 'failure'), run('typecheck', 11, 'success')];
  work = await engine.observe(work.id, work.revision, seen(work, candidate, checks));
  await onlyJob(work);
  const stub = adapter(candidate, () => checks, async () => ({ runId: 44 }));
  stub.github.permissionShortfall = feature => feature === 'check-rerun' ? 'App lacks Actions: write' : null;
  await processJob(engine, stub.github);
  work = await reload(work);
  assert.deepEqual(stub.reruns, []);
  assert.equal(work.checkReruns![0].state, 'owed');
  assert.match(gate(work, 'test').reasons[0], /rerun: one rerun.*owed/);
});


test('manual:review-followups-triaged GY-731.2b: unqueued terminal rerun outcomes stay visible and classify as rework', async () => {
  let work = await submitted('Rerun outcome visibility');
  const candidate = { sha: sha40('a735'), baseSha: sha40('b735') };
  work = await engine.observe(work.id, work.revision, seen(work, candidate, [run('test', 10, 'failure'), run('typecheck', 11, 'success')]));
  for (const state of ['refused', 'expired', 'failed'] as const) {
    const changed = { ...work, checkReruns: [{ ...work.checkReruns![0], state, detail: 'Provider response\nmore detail' }] };
    Object.assign(changed, evaluate(changed, [changed], new Date(), [15368]));
    const reason = gate(changed, 'test').reasons[0];
    assert.match(reason, new RegExp(`rerun: ${state}`));
    assert.equal(refusalAction(changed, 'test', reason), 'request-rework');
    assert.equal(checkStates(changed, [15368]).find(check => check.name === 'test')?.state, 'failed');
    assert.equal(plainReason(reason, 'test').known, true);
    assert.match(plainReason(reason, 'test').text, new RegExp(`rerun: ${state}`));
  }
});

test('unit:rerun-waits-for-running-workflow GY-1328: a failed job whose workflow run still runs is rerun once the run completes, never refused with 403', async () => {
  // The adapter: rerun-failed-jobs is not asked while the run is in progress (GitHub answers 403 to it).
  const client = new GitHubClient({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used-in-adapter-test' });
  let status = 'in_progress';
  const calls: string[] = [];
  client.request = (async (path: string, method = 'GET') => {
    calls.push(`${method} ${path}`);
    if (path === '/actions/jobs/42') return { id: 42, run_id: 37381434491, run_attempt: 1 };
    if (path === '/actions/runs/37381434491') return { id: 37381434491, status, conclusion: null };
    return {};
  }) as GitHub['request'];
  await assert.rejects(client.rerunFailedJobs(42), (error: unknown) => error instanceof RerunPending && /still in_progress/.test((error as Error).message));
  assert.equal(calls.some(call => call.startsWith('POST')), false, 'no rerun is asked of a running workflow run');
  status = 'completed';
  assert.deepEqual(await client.rerunFailedJobs(42), { runId: 37381434491, attempt: 1 });
  assert.equal(calls.at(-1), 'POST /actions/runs/37381434491/rerun-failed-jobs');
  // GitHub's own 403 message is kept, so a refusal that is not a missing grant says what it is.
  const refused = await (client as any).refusal(new Response(JSON.stringify({ message: 'This workflow is already running' }), { status: 403 }), 'POST /actions/runs/1/rerun-failed-jobs');
  assert.match(refused.message, /failed \(403\) "This workflow is already running": /);

  // The job loop: a pending rerun keeps the entry owed, unrefused, and holds the head; once the run completes it is requested.
  let work = await submitted('Typecheck fails while tests run');
  const candidate = { sha: sha40('a1328'), baseSha: sha40('b1328') };
  const checks = [run('test', 41, 'success'), run('typecheck', 42, 'failure')];
  work = await engine.observe(work.id, work.revision, seen(work, candidate, checks));
  let step = await reconcile(work, checks, async id => { throw new RerunPending(id, 'in_progress'); });
  assert.deepEqual(step.reruns, [42]);
  assert.deepEqual(step.work.checkReruns!.map(entry => [entry.check, entry.state]), [['typecheck', 'owed']]);
  assert.equal(routineDecision(step.work, { autoMerge: true }, Date.now()), null, 'no rework while the run is still running');
  step = await reconcile(step.work, checks, async () => ({ runId: 37381434491 }));
  assert.deepEqual(step.reruns, [42]);
  assert.deepEqual(step.work.checkReruns!.map(entry => [entry.check, entry.state, entry.runId]), [['typecheck', 'requested', 37381434491]]);
});
