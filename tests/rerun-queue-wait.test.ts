import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { processJob, type GitHub } from '../src/github.js';
import { routineDecision } from '../src/master-daemon.js';
import { checkRerunProbeMs, checkRerunVisibilityMs, classifyRerunRun, queueRef, type QueuePlacement, type QueueSpeculation, type RerunWorkflowRun } from '../src/merge-queue.js';
import type { Observation, Principal, Work } from '../src/model.js';

// GY-1096: with 28 CI runs queued, reruns the control plane requested could not start within 15
// minutes, expired as failures, and the loop owed each item a new head, whose own CI run deepened
// the queue. A rerun whose workflow run is queued or in progress is a wait; one GitHub accepted but
// never created is requested once more. Each test is named for the proof it produces.
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const treeOf = (sha: string) => sha40(`7${sha.slice(0, 2)}`);
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
const producer: Principal = { id: 'ci-runner', role: 'producer', proofs: ['unit:wait'] };
let database: EmbeddedPostgres, store: Store, engine: Engine;
let pr = 1096;
before(async () => {
  const port = Number(process.env.GRAPHYARD_RERUN_WAIT_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1096);
  const databaseDir = await temporaryDirectory('rerun-wait');
  database = new EmbeddedPostgres({ databaseDir, user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.controlPlaneAppId = 1234;
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

type Check = Observation['checks'][number];
const run = (name: string, id: number, result: string): Check => ({ name, result, appId: 15368, id });
const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
const kinds = async (work: Work) => (await store.events(work.id)).map(event => event.kind).reverse().filter(kind => kind.startsWith('check.rerun') || kind === 'queue.ejected');
const gate = (work: Work, name: string) => work.gates.find(entry => entry.name === name)!;
async function clearQueue() { await store.pool.query("UPDATE work_items SET document=document-'queue' WHERE document->>'stage'<>'done'"); }
async function onlyJob(work: Work) {
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [work.id]);
}
/** Moves every clock of the item's rerun records `ms` into the past, as if that long had gone by. */
async function elapse(work: Work, ms: number) {
  const current = await reload(work);
  const back = (value?: string) => value && new Date(Date.parse(value) - ms).toISOString();
  current.checkReruns = current.checkReruns!.map(entry => ({ ...entry, at: back(entry.at)!, ...(entry.probedAt ? { probedAt: back(entry.probedAt) } : {}),
    ...(entry.rerequestedAt ? { rerequestedAt: back(entry.rerequestedAt) } : {}), ...(entry.waiting ? { waiting: { ...entry.waiting, at: back(entry.waiting.at)! } } : {}) }));
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [current.id, JSON.stringify(current)]);
}
async function submitted(title: string) {
  let work = await engine.execute(operator, 'create', null, { title, plannedFiles: ['src/wait.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:wait'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/wait/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-1` }, randomUUID());
  return engine.execute(worker, 'submit', work.id, { epoch: 1, pr: ++pr }, randomUUID());
}
function seen(work: Work, candidate: { sha: string; baseSha: string }, checks: Check[]): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { ...candidate, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' }, checks,
    reviews: [{ id: 41, reviewer: 'graphyard-reviewer[bot]', sha: candidate.sha, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: treeOf(candidate.baseSha), baseTipContained: true,
    files: ['src/wait.ts'], scopeFiles: [], at: new Date().toISOString() };
}
type Rerun = (checkRunId: number) => Promise<{ runId: number; attempt?: number }>;
/** GitHub as the job loop reaches it: `rerun` answers rerun requests and `workflow` the reads of the rerun's workflow run. */
function adapter(candidate: { sha: string; baseSha: string }, checks: Check[], rerun: Rerun, workflow: (runId: number) => Promise<RerunWorkflowRun | null>) {
  const reruns: number[] = [], reads: number[] = [];
  return { reruns, reads, github: {
    observe: async (work: Work) => seen(work, candidate, checks),
    publishSpeculativeTip: async (work: Work, placement: QueuePlacement): Promise<QueueSpeculation> =>
      ({ ref: queueRef(work.key), tip: candidate.sha, base: placement.predictedBase!, baseTree: treeOf(placement.predictedBase!), predecessors: placement.predecessors, policyRevision: work.policyRevision, publishedAt: new Date().toISOString(), merge: null }),
    rerunFailedJobs: async (id: number) => { reruns.push(id); return rerun(id); },
    rerunWorkflowRun: async (id: number) => { reads.push(id); return workflow(id); },
    requestCodex: async () => { throw new Error('no review request expected'); },
    publish: async () => {},
  } as unknown as GitHub };
}
const noRead = async (): Promise<RerunWorkflowRun | null> => { throw new Error('the workflow run is read only past the visibility bound'); };
/** One reconciliation of `work` through the job loop, observing `checks` on its candidate. */
async function reconcile(work: Work, checks: Check[], workflow: (runId: number) => Promise<RerunWorkflowRun | null> = noRead, rerun: Rerun = async () => ({ runId: 9001, attempt: 1 })) {
  await onlyJob(work);
  const github = adapter({ sha: work.candidate!.sha, baseSha: work.candidate!.baseSha }, checks, rerun, workflow);
  await processJob(engine, github.github);
  return { work: await reload(work), reruns: github.reruns, reads: github.reads };
}
const bindings = (work: Work) => ({ sequence: work.queue?.sequence ?? null, tip: work.queue?.speculation?.tip ?? null, review: gate(work, 'review').passed, acceptance: gate(work, 'acceptance').passed, evidence: work.evidence.map(entry => entry.id) });
const workflowRun = (status: string, conclusion: string | null, attempt: number) => async (): Promise<RerunWorkflowRun> => ({ status, conclusion, attempt });

test('unit:queued-rerun-is-a-wait — a requested rerun still queued or in progress after 15 minutes keeps the check pending, named as a runner-queue wait, and owes no new head; only a concluded failing rerun owes one', async () => {
  await clearQueue();
  const head = sha40('a1096'), base = sha40('b1096');
  const failing = [run('test', 11, 'failure'), run('typecheck', 12, 'success')];
  let work = await submitted('Rerun behind a runner queue');
  work = await engine.observe(work.id, work.revision, seen(work, { sha: head, baseSha: base }, [run('test', 1, 'success'), run('typecheck', 2, 'success')]));
  work = await engine.execute(producer, 'evidence', work.id, { proof: 'unit:wait', sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 }, scopeFiles: ['src/wait.ts'] }, randomUUID());
  assert.ok(work.queue, `enqueued: ${work.gates.flatMap(entry => entry.reasons).join('; ')}`);
  let step = await reconcile(work, [run('test', 1, 'success'), run('typecheck', 2, 'success')]);
  assert.equal(step.work.queue?.speculation?.tip, head, 'the tip is published');
  const held = bindings(step.work);

  // The tip's test job fails and its one rerun is accepted; within 15 minutes the workflow run is not read.
  step = await reconcile(step.work, failing);
  assert.deepEqual([step.reruns, step.reads], [[11], []]);
  assert.deepEqual(step.work.checkReruns!.map(entry => [entry.state, entry.runId, entry.attempt]), [['requested', 9001, 1]]);

  // Past 15 minutes no new test run has appeared because the runners are busy: GitHub reports the workflow run queued.
  await elapse(step.work, checkRerunVisibilityMs + 60_000);
  step = await reconcile(step.work, failing, workflowRun('queued', null, 2));
  work = step.work;
  assert.deepEqual([step.reruns, step.reads], [[], [9001]], 'the workflow run is read, and no second rerun is requested');
  assert.deepEqual(work.checkReruns!.map(entry => [entry.state, entry.waiting?.status]), [['requested', 'queued']]);
  assert.deepEqual(bindings(work), held, 'the candidate keeps its position, approval and proofs');
  assert.equal(work.queueEjection ?? null, null);
  assert.equal(gate(work, 'merge').passed, false, 'the tip\'s check is still pending');
  assert.ok(gate(work, 'merge').reasons.some(reason => /required CI check test failed and its failed jobs are rerunning \(workflow run 9001\), waiting for a runner \(its workflow run is queued in the runner queue\); the entry keeps its position/.test(reason)), 'master status names the runner-queue wait on the queue row');
  assert.equal(routineDecision(work, { autoMerge: true }, Date.now()), null, 'no new head is owed while the rerun waits for a runner');
  assert.deepEqual(await kinds(work), ['check.rerun.owed', 'check.rerun.requested', 'check.rerun.waiting']);

  // Read again only after the probe interval; an unchanged wait adds nothing to the ledger.
  step = await reconcile(work, failing, workflowRun('queued', null, 2));
  assert.deepEqual(step.reads, [], 'not read again within the probe interval');
  await elapse(step.work, checkRerunProbeMs);
  step = await reconcile(step.work, failing, workflowRun('queued', null, 2));
  assert.deepEqual(step.reads, [9001]);
  assert.deepEqual(await kinds(step.work), ['check.rerun.owed', 'check.rerun.requested', 'check.rerun.waiting']);

  // Long past every bound, a workflow run that started is still a wait, as long as it has not concluded.
  await elapse(step.work, 4 * checkRerunVisibilityMs);
  step = await reconcile(step.work, failing, workflowRun('in_progress', null, 2));
  work = step.work;
  assert.deepEqual(work.checkReruns!.map(entry => [entry.state, entry.waiting?.status]), [['requested', 'in_progress']]);
  assert.deepEqual(bindings(work), held);
  assert.ok(gate(work, 'merge').reasons.some(reason => /waiting for a runner \(its workflow run is in progress in the runner queue\)/.test(reason)));
  assert.equal(routineDecision(work, { autoMerge: true }, Date.now()), null);

  // The rerun's new check run appears and passes: the entry proceeds on the same tip.
  step = await reconcile(work, [...failing, run('test', 13, 'success')]);
  assert.deepEqual(bindings(step.work), held);
  assert.deepEqual(step.work.checkReruns!.map(entry => [entry.state, entry.rerunId]), [['passed', 13]]);
  assert.ok(step.work.gates.every(entry => entry.passed), step.work.gates.flatMap(entry => entry.reasons).join('; '));

  // A head outside the queue: the rerun concludes failing without its check run yet observed, and only then is a new head owed.
  await clearQueue();
  const other = sha40('a1097');
  work = await submitted('Rerun that fails after its wait');
  work = await engine.observe(work.id, work.revision, seen(work, { sha: other, baseSha: base }, [run('test', 21, 'failure'), run('typecheck', 22, 'success')]));
  step = await reconcile(work, [run('test', 21, 'failure'), run('typecheck', 22, 'success')], noRead, async () => ({ runId: 9002, attempt: 1 }));
  await elapse(step.work, checkRerunVisibilityMs);
  step = await reconcile(step.work, [run('test', 21, 'failure'), run('typecheck', 22, 'success')], workflowRun('waiting', null, 2));
  assert.equal(routineDecision(step.work, { autoMerge: true }, Date.now()), null, 'a waiting rerun owes no new head');
  assert.equal(gate(step.work, 'test').passed, false, 'the check is still pending');
  assert.match(gate(step.work, 'test').reasons[0], /rerun: its failed jobs are rerunning \(workflow run 9002\), waiting for a runner \(its workflow run is waiting in the runner queue\)/);
  await elapse(step.work, checkRerunProbeMs);
  step = await reconcile(step.work, [run('test', 21, 'failure'), run('typecheck', 22, 'success')], workflowRun('completed', 'failure', 2));
  assert.deepEqual(step.work.checkReruns!.map(entry => [entry.state, entry.detail]), [['failed', 'its workflow run concluded failure']]);
  assert.deepEqual(routineDecision(step.work, { autoMerge: true }, Date.now())?.binding, `${other}:ci:test`, 'the concluded failing rerun owes a new head');
  assert.deepEqual(await kinds(step.work), ['check.rerun.owed', 'check.rerun.requested', 'check.rerun.waiting', 'check.rerun.failed']);

  // The classification on its own: only a completed later attempt is the rerun's outcome.
  assert.deepEqual(classifyRerunRun({ attempt: 1 }, { status: 'queued', conclusion: null, attempt: 1 }), { kind: 'waiting', status: 'queued' });
  assert.deepEqual(classifyRerunRun({ attempt: 1 }, { status: 'pending', conclusion: null, attempt: 2 }), { kind: 'waiting', status: 'pending' });
  assert.deepEqual(classifyRerunRun({ attempt: 1 }, { status: 'completed', conclusion: 'timed_out', attempt: 2 }), { kind: 'failed', conclusion: 'timed_out' });
  assert.deepEqual(classifyRerunRun({ attempt: 1 }, { status: 'completed', conclusion: 'success', attempt: 2 }), { kind: 'waiting', status: 'completed' });
});

test('unit:missing-rerun-rerequested — a rerun GitHub accepted but with no run found after 15 minutes is re-requested once before it counts against the candidate', async () => {
  await clearQueue();
  const head = sha40('a1098'), base = sha40('b1098');
  const failing = [run('test', 31, 'failure'), run('typecheck', 32, 'success')];
  let work = await submitted('Rerun GitHub never created');
  work = await engine.observe(work.id, work.revision, seen(work, { sha: head, baseSha: base }, failing));
  let step = await reconcile(work, failing, noRead, async () => ({ runId: 9003, attempt: 1 }));
  assert.deepEqual(step.reruns, [31]);

  // Fifteen minutes on, the workflow run shows no attempt after the failed one: the rerun is requested a second time, and still holds.
  await elapse(step.work, checkRerunVisibilityMs);
  step = await reconcile(step.work, failing, workflowRun('completed', 'failure', 1), async () => ({ runId: 9003, attempt: 1 }));
  work = step.work;
  assert.deepEqual([step.reads, step.reruns], [[9003], [31]], 'read, then re-requested once');
  assert.equal(work.checkReruns![0].state, 'requested');
  assert.ok(work.checkReruns![0].rerequestedAt);
  assert.equal(routineDecision(work, { autoMerge: true }, Date.now()), null, 'the re-requested rerun still owes no new head');
  assert.deepEqual(await kinds(work), ['check.rerun.owed', 'check.rerun.requested', 'check.rerun.rerequested']);

  // Within 15 minutes of the second request the run is not read again.
  step = await reconcile(work, failing, workflowRun('completed', 'failure', 1));
  assert.deepEqual([step.reads, step.reruns], [[], []]);

  // Still no run 15 minutes after the second request: the rerun counts against the candidate, with no third request.
  await elapse(step.work, checkRerunVisibilityMs);
  step = await reconcile(step.work, failing, async () => null);
  work = step.work;
  assert.deepEqual([step.reads, step.reruns], [[9003], []]);
  assert.equal(work.checkReruns![0].state, 'expired');
  assert.match(work.checkReruns![0].detail!, /accepted the rerun twice but no test run was found within 15 minutes of either request/);
  assert.match(gate(work, 'test').reasons[0], /rerun: expired: GitHub accepted the rerun twice/);
  assert.equal(routineDecision(work, { autoMerge: true }, Date.now())?.binding, `${head}:ci:test`);
  assert.deepEqual(await kinds(work), ['check.rerun.owed', 'check.rerun.requested', 'check.rerun.rerequested', 'check.rerun.expired']);

  // A second request GitHub refuses lets the failure stand at once.
  const refusedHead = sha40('a1099');
  work = await submitted('Rerun refused the second time');
  work = await engine.observe(work.id, work.revision, seen(work, { sha: refusedHead, baseSha: base }, failing));
  step = await reconcile(work, failing, noRead, async () => ({ runId: 9004, attempt: 1 }));
  await elapse(step.work, checkRerunVisibilityMs);
  step = await reconcile(step.work, failing, async () => null, async () => { throw new Error('GitHub POST /actions/runs/9004/rerun-failed-jobs failed (403)'); });
  assert.equal(step.work.checkReruns![0].state, 'refused');
  assert.match(step.work.checkReruns![0].detail!, /no test run was found within 15 minutes, and the second request was refused: .*\(403\)/);
  assert.equal(routineDecision(step.work, { autoMerge: true }, Date.now())?.binding, `${refusedHead}:ci:test`);
});
