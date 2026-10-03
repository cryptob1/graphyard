import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { processJob, type GitHub } from '../src/github.js';
import { routineDecision } from '../src/master-daemon.js';
import { failedCheckRework } from '../src/daemon/decisions.js';
import { batchStep, checkRerunVisibilityMs, classifyRerunRun, ejectedCheckLift, ejectingCheck, latestCheck, queueRef, reconcileCheckReruns, tipVerdict, type QueuePlacement, type QueueSpeculation } from '../src/merge-queue.js';
import { attributeDocsOverflow, docsBudgetProof, ownDocsOverflow, type DocsWordBudget, type DocsWordCount, type TipDocs } from '../src/model/documentation.js';
import type { Observation, Principal, Work } from '../src/model.js';

// GY-1109: GY-967 (PR #513, head 5c54592412a8 on base 7ef4cb702d65) was ejected from the merge queue
// with "Required CI check test did not pass ..., again after one rerun of its failed jobs:
// unit:docs-word-budget failed ... 15643 words, 3643 over the 12000-word budget; pages that grew:
// none". Its failed test run 110730635605 was rerun as workflow run 36972672738, whose attempt 2
// passed; the "failed rerun" recorded was check run 110739678221 of workflow run 36975811723, which
// GitHub cancelled for a higher-priority waiting request, and the 15643 words were the base's own.
// Nothing then moved the green head back into the queue. Each test is named for the proof it produces.
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const treeOf = (sha: string) => sha40(`7${sha.slice(0, 2)}`);
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
const producer: Principal = { id: 'ci-runner', role: 'producer', proofs: ['unit:attribution'] };
let database: EmbeddedPostgres, store: Store, engine: Engine;
let pr = 1300;
before(async () => {
  const port = Number(process.env.GRAPHYARD_EJECTION_ATTRIBUTION_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1109);
  const databaseDir = await temporaryDirectory('ejection-attribution');
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
async function clearQueue() { await store.pool.query("UPDATE work_items SET document=document-'queue' WHERE document->>'stage'<>'done'"); }
async function onlyJob(work: Work) {
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [work.id]);
}
async function submitted(title: string) {
  let work = await engine.execute(operator, 'create', null, { title, plannedFiles: ['src/attribution.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:attribution'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/attribution/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-1` }, randomUUID());
  return engine.execute(worker, 'submit', work.id, { epoch: 1, pr: ++pr }, randomUUID());
}
function seen(work: Work, candidate: { sha: string; baseSha: string }, checks: Check[], docsBudget?: TipDocs): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { ...candidate, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' }, checks,
    reviews: [{ id: 41, reviewer: 'graphyard-reviewer[bot]', sha: candidate.sha, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: treeOf(candidate.baseSha), baseTipContained: true,
    files: ['src/attribution.ts'], scopeFiles: [], at: new Date().toISOString(), ...(docsBudget ? { docsBudget } : {}) };
}
/** GitHub as the job loop reaches it: it observes `checks` on the tip, and reruns the failed jobs of a run as GY-967's workflow run 36972672738. */
function adapter(candidate: { sha: string; baseSha: string }, checks: () => Check[], docsBudget?: TipDocs) {
  const reruns: number[] = [];
  return { reruns, github: {
    observe: async (work: Work) => seen(work, candidate, checks(), docsBudget),
    publishSpeculativeTip: async (work: Work, placement: QueuePlacement): Promise<QueueSpeculation> =>
      ({ ref: queueRef(work.key), tip: candidate.sha, base: placement.predictedBase!, baseTree: treeOf(placement.predictedBase!), predecessors: placement.predecessors, policyRevision: work.policyRevision, publishedAt: new Date().toISOString(), merge: null }),
    rerunFailedJobs: async (id: number) => { reruns.push(id); return { runId: 36972672738, attempt: 1 }; },
    requestCodex: async () => { throw new Error('no review request expected'); },
    publish: async () => {},
  } as unknown as GitHub };
}
const passing = [run('test', 1, 'success'), run('typecheck', 2, 'success')];
/** A head approved and proven, queued, and published as its own speculative tip with every required check passing. */
async function queuedTip(title: string, head: string, base: string) {
  let work = await submitted(title);
  work = await engine.observe(work.id, work.revision, seen(work, { sha: head, baseSha: base }, passing));
  work = await engine.execute(producer, 'evidence', work.id, { proof: 'unit:attribution', sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 }, scopeFiles: ['src/attribution.ts'] }, randomUUID());
  assert.ok(work.queue, `enqueued: ${work.gates.flatMap(entry => entry.reasons).join('; ')}`);
  await reconcile(work, passing);
  work = await reload(work);
  assert.equal(work.queue?.speculation?.tip, head, 'the tip is published');
  return work;
}
/** One reconciliation of `work` through the job loop, observing `checks` (and the docs counts) on its tip. */
async function reconcile(work: Work, checks: Check[], docsBudget?: TipDocs) {
  await onlyJob(work);
  const github = adapter({ sha: work.candidate!.sha, baseSha: work.candidate!.baseSha }, () => checks, docsBudget);
  await processJob(engine, github.github);
  return { work: await reload(work), reruns: github.reruns };
}

// GY-967's run sequence on its tip: test run 110730635605 failed; GitHub's attempt 2 of workflow run
// 36972672738 passed; check run 110739678221 of workflow run 36975811723 was cancelled by GitHub
// ("Canceling since a higher priority waiting request for CI-513 exists") and is the newest by id.
const failedTest = run('test', 110730635605, 'failure');
const cancelledTest = run('test', 110739678221, 'cancelled');
const passedAttempt = run('test', 110739500001, 'success');
const typecheck = run('typecheck', 110730635606, 'success');

test('unit:cancelled-rerun-not-failure — GY-967\'s run 36975811723, cancelled by GitHub, is never recorded as a failed rerun nor ejects or asks for rework; the check is re-read, and the rerun attempt that passed decides', async () => {
  await clearQueue();
  const main = sha40('7ef4cb702d65'), head = sha40('5c54592412a8');
  let work = await queuedTip('Cancelled rerun', head, main);
  const sequence = work.queue!.sequence;

  // The test job fails on the tip: one rerun of its workflow run is requested, and the entry holds.
  let step = await reconcile(work, [failedTest, typecheck]);
  work = step.work;
  assert.deepEqual(step.reruns, [110730635605]);
  assert.deepEqual(work.checkReruns!.map(entry => [entry.failedRunId, entry.state, entry.runId]), [[110730635605, 'requested', 36972672738]]);

  // A cancelled check run newer than the failure appears (GY-967's run 36975811723): it is no verdict.
  step = await reconcile(work, [failedTest, cancelledTest, typecheck]);
  work = step.work;
  assert.equal(work.queue?.sequence, sequence, 'the entry keeps its place');
  assert.equal(work.queueEjection ?? null, null, 'nothing is ejected for a cancelled run');
  assert.deepEqual(work.checkReruns!.map(entry => [entry.failedRunId, entry.state]), [[110730635605, 'requested']], 'the rerun still holds: it is never recorded as failed');
  assert.ok(!(await kinds(work)).includes('check.rerun.failed'), 'no failed rerun on the ledger');
  assert.equal(failedCheckRework(work), null, 'no rework is asked for');
  assert.equal(routineDecision(work, { autoMerge: true }, Date.now()), null, 'the loop decides nothing while the check is re-read');
  assert.equal(ejectingCheck(work, [15368]), null);
  assert.equal(latestCheck([failedTest, cancelledTest])?.id, 110730635605, 'a cancelled run never supersedes one that was not cancelled');

  // The rerun's attempt 2 passed (a check run created before the cancelled one): it decides the check.
  step = await reconcile(work, [failedTest, passedAttempt, cancelledTest, typecheck]);
  work = step.work;
  assert.deepEqual(work.checkReruns!.map(entry => [entry.failedRunId, entry.state, entry.rerunId]), [[110730635605, 'passed', 110739500001]]);
  assert.equal(work.queue?.sequence, sequence, 'still queued at its place, with no new candidate');
  assert.equal(work.candidate!.sha, head);
  assert.ok(gate(work, 'test').passed, gate(work, 'test').reasons.join('; '));
  assert.deepEqual(tipVerdict(work, [15368]), { result: 'pass' });

  // A check whose only run GitHub cancelled is owed a rerun on its own allowance, never a failure;
  // a rerun attempt GitHub cancels is requested again instead of failing.
  const onlyCancelled = { ...work, checkReruns: [], observation: { ...work.observation!, checks: [cancelledTest, typecheck] } } as Work;
  assert.equal(ejectingCheck(onlyCancelled, [15368]), null);
  assert.equal(failedCheckRework(onlyCancelled), null);
  const owed = reconcileCheckReruns(onlyCancelled, [15368], 1, new Date());
  assert.deepEqual(owed.reruns.map(entry => [entry.failedRunId, entry.state, entry.cancelled]), [[110739678221, 'owed', true]]);
  const spent = { ...onlyCancelled, checkReruns: [{ sha: head, check: 'test', failedRunId: 1, state: 'failed' as const, at: new Date().toISOString() }] } as Work;
  assert.equal(reconcileCheckReruns(spent, [15368], 1, new Date()).reruns.at(-1)!.failedRunId, 110739678221, 'a spent failure allowance does not stop the rerun of a cancelled run');
  assert.deepEqual(classifyRerunRun({ attempt: 1 }, { status: 'completed', conclusion: 'cancelled', attempt: 2 }), { kind: 'cancelled', attempt: 2 }, 'a cancelled attempt is classified as cancelled');
  assert.deepEqual(classifyRerunRun({ attempt: 1 }, { status: 'completed', conclusion: 'failure', attempt: 2 }), { kind: 'failed', conclusion: 'failure' }, 'a failed attempt still fails');
});

test('unit:cancelled-rerun-probed-twice — a failure rerun whose attempt is cancelled twice by GitHub keeps holding the candidate, is rerun again on the cancelled allowance without expiring or ejecting, and passes when the next attempt passes', async () => {
  await clearQueue();
  const main = sha40('7ef4cb702d67'), head = sha40('5c54592412c1');
  let work = await queuedTip('Twice cancelled rerun', head, main);
  const sequence = work.queue!.sequence;

  let attemptsRequested: number[] = [];
  let workflowAttempt = 2;
  let workflowConclusion: string | null = 'cancelled';
  const gh = {
    observe: async (w: Work) => seen(w, { sha: head, baseSha: main }, [failedTest, typecheck]),
    publishSpeculativeTip: async (w: Work, placement: QueuePlacement): Promise<QueueSpeculation> =>
      ({ ref: queueRef(w.key), tip: head, base: placement.predictedBase!, baseTree: treeOf(placement.predictedBase!), predecessors: placement.predecessors, policyRevision: w.policyRevision, publishedAt: new Date().toISOString(), merge: null }),
    rerunFailedJobs: async (id: number) => { attemptsRequested.push(id); return { runId: 36972672738, attempt: workflowAttempt - 1 }; },
    rerunWorkflowRun: async (id: number) => ({ status: 'completed', conclusion: workflowConclusion, attempt: workflowAttempt }),
    requestCodex: async () => { throw new Error('no review request expected'); },
    publish: async () => {},
  } as unknown as GitHub;

  await onlyJob(work);
  await processJob(engine, gh);
  work = await reload(work);
  assert.equal(work.queue?.sequence, sequence);
  assert.deepEqual(work.checkReruns!.map(e => [e.failedRunId, e.state]), [[110730635605, 'requested']]);

  const elapseBack = async (ms: number) => {
    const cur = await reload(work);
    const back = (val?: string) => val && new Date(Date.parse(val) - ms).toISOString();
    cur.checkReruns = cur.checkReruns!.map(e => ({
      ...e,
      at: back(e.at)!,
      ...(e.probedAt ? { probedAt: back(e.probedAt) } : {}),
      ...(e.rerequestedAt ? { rerequestedAt: back(e.rerequestedAt) } : {}),
      ...(e.detail ? { detail: e.detail.replace(/cancelled:(\d+):(\S+)/, (_, c, t) => `cancelled:${c}:${back(t)}`) } : {})
    }));
    await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [cur.id, JSON.stringify(cur)]);
    work = await reload(cur);
  };

  await elapseBack(checkRerunVisibilityMs);
  await onlyJob(work);
  await processJob(engine, gh);
  work = await reload(work);

  assert.equal(work.queue?.sequence, sequence, 'keeps place after first cancellation');
  assert.equal(work.queueEjection ?? null, null);
  assert.equal(work.checkReruns![0].state, 'requested');
  assert.equal(work.checkReruns![0].rerequestedAt, undefined, 'vanished-run re-request is not spent');
  assert.match(work.checkReruns![0].detail ?? '', /cancelled:1/);

  workflowAttempt = 3;
  await elapseBack(checkRerunVisibilityMs);
  await onlyJob(work);
  await processJob(engine, gh);
  work = await reload(work);

  assert.equal(work.queue?.sequence, sequence, 'keeps place after second cancellation');
  assert.equal(work.queueEjection ?? null, null, 'never ejected for twice-cancelled rerun');
  assert.equal(work.checkReruns![0].state, 'requested');
  assert.equal(work.checkReruns![0].rerequestedAt, undefined, 'vanished-run re-request is still not spent');
  assert.match(work.checkReruns![0].detail ?? '', /cancelled:2/);

  const passCheck = run('test', 110739500004, 'success');
  const ghPass = {
    ...gh,
    observe: async (w: Work) => seen(w, { sha: head, baseSha: main }, [failedTest, passCheck, typecheck]),
  } as unknown as GitHub;
  await onlyJob(work);
  await processJob(engine, ghPass);
  work = await reload(work);

  assert.equal(work.checkReruns![0].state, 'passed');
  assert.equal(work.queue?.sequence, sequence);
  assert.ok(gate(work, 'test').passed);
});

// GY-967's base 7ef4cb702d65 already carried 15643 budgeted words; its head grew no page.
const budget: DocsWordBudget = { total: 12_000, perPage: 1_200, paths: ['docs/', 'README.md'], documentation: ['docs/', 'README.md', 'AGENTS.md'] };
const inherited: DocsWordCount = Object.fromEntries([...Array.from({ length: 13 }, (_, index) => [`docs/page-${index}.md`, 1_100]), ['README.md', 1_343]]);
const totalOf = (count: DocsWordCount) => Object.values(count).reduce((sum, words) => sum + words, 0);

test('unit:inherited-docs-total-not-attributed — a docs total the base already carries and the candidate did not grow (GY-967: 15643 words on base 7ef4cb702d65, pages that grew: none) is never named in an ejection or rework reason', async () => {
  assert.equal(totalOf(inherited), 15_643);
  const tipDocs = (head: string, pages: DocsWordCount): TipDocs => ({ sha: head, base: inherited, pages, onlyFailure: true, budget });
  // The attribution names nobody for an inherited total, and still names an entry whose change grew a page.
  assert.equal(attributeDocsOverflow(inherited, [{ key: 'GY-967', count: inherited }], budget), null);
  assert.equal(ownDocsOverflow(tipDocs('x', inherited)), false);
  const grown = { ...inherited, 'docs/page-0.md': 1_150 };
  assert.equal(attributeDocsOverflow(inherited, [{ key: 'GY-967', count: grown }], budget)?.member, 'GY-967', 'a page grown over an already-over total is still the entry\'s');
  assert.equal(ownDocsOverflow(tipDocs('x', grown)), true);
  const step = batchStep(['GY-967'], () => ({ result: 'fail', check: docsBudgetProof }), { result: 'pass' }, { base: inherited, count: () => inherited, budget });
  assert.ok(!('reason' in step) || !(step as { reason?: string }).reason, 'the batch plan attributes no docs reason');

  // The live queue: GY-967's sequence on its tip, the failure confirmed by its one rerun, with the
  // base's docs total observed on it. The ejection names the failed check, not the inherited total.
  await clearQueue();
  const main = sha40('7ef4cb702d65'), head = sha40('5c54592412a9');
  let work = await queuedTip('Inherited docs total', head, main);
  const docs = tipDocs(head, inherited);
  work = (await reconcile(work, [failedTest, typecheck], docs)).work;
  assert.notDeepEqual(tipVerdict(work, [15368]), { result: 'fail', check: docsBudgetProof }, 'the tip is not judged as failing the docs budget');
  work = (await reconcile(work, [failedTest, run('test', 110739678300, 'failure'), typecheck], docs)).work;
  assert.equal(work.queue ?? null, null, 'a real second failure still ejects');
  assert.match(work.queueEjection!.reason, /^Required CI check test did not pass on speculative tip 5c54592412a9, again after one rerun of its failed jobs/);
  assert.doesNotMatch(work.queueEjection!.reason, /15643|docs-word-budget|pages that grew/, 'the inherited total is never named');
  assert.doesNotMatch(failedCheckRework(work)?.reason ?? '', /15643|docs-word-budget/);
});

test('unit:ejected-green-head-requeues — an entry ejected for a run GitHub cancelled re-enters the queue at the same head once review, test and acceptance pass on it, with no worker, commit or rework decision, and its merge authorization is re-established', async () => {
  await clearQueue();
  const main = sha40('7ef4cb702d66'), head = sha40('5c54592412b0');
  let work = await queuedTip('Ejected green head', head, main);
  const sequence = work.queue!.sequence, speculation = work.queue!.speculation;
  // GY-967 as it stands: ejected naming the cancelled run 110739678221 as the test check's failure.
  await store.pool.query(`UPDATE work_items SET document=jsonb_set(document-'queue','{queueEjection}',$2::jsonb) WHERE id=$1`, [work.id, JSON.stringify({
    at: new Date().toISOString(), sequence, sha: head, policyRevision: work.policyRevision, conflict: null, family: null,
    reason: `Required CI check test did not pass on speculative tip ${head.slice(0, 12)}, again after one rerun of its failed jobs: unit:docs-word-budget failed: its docs change takes the budgeted documentation (docs/, README.md) to 15643 words, 3643 over the 12000-word budget; pages that grew: none`,
    check: { name: 'test', runId: 110739678221, tip: head, speculation } })]);
  work = await reload(work);
  assert.equal(work.queue ?? null, null);
  const lease = work.lease, reworks = work.pipeline?.reworkRounds ?? 0;

  // Observed again with attempt 2's pass (older than the cancelled run): the same head re-enters at its place.
  work = (await reconcile(work, [failedTest, passedAttempt, cancelledTest, typecheck])).work;
  assert.equal(work.queueEjection ?? null, null, 'the ejection is lifted');
  assert.equal(work.queue?.sequence, sequence, 'at the sequence it held');
  assert.deepEqual(work.queue?.speculation, speculation, 'with the speculative tip it held');
  assert.equal(work.candidate!.sha, head, 'no new commit');
  assert.deepEqual(work.lease, lease, 'no worker is assigned');
  assert.equal(work.reworkRequested, false, 'no rework decision');
  assert.equal(work.pipeline?.reworkRounds ?? 0, reworks);
  const lifted = work.queueHistory!.at(-1)!;
  assert.deepEqual([lifted.event, lifted.check, lifted.runId, lifted.tip], ['lifted', 'test', 110739500001, head]);
  assert.match(lifted.reason!, /^ejection lifted: check test passed \(run 110739500001\) on speculative tip [0-9a-f]{12}; the run it was ejected for \(110739678221\) was cancelled by GitHub, not failed$/);
  assert.ok((await kinds(work)).includes('queue.ejection-lifted'));
  for (const name of ['review', 'test', 'acceptance']) assert.ok(gate(work, name).passed, `${name}: ${gate(work, name).reasons.join('; ')}`);
  assert.ok(work.gates.every(entry => entry.passed), work.gates.flatMap(entry => entry.reasons).join('; '));
  assert.deepEqual(work.mergeAuthorization && { sha: work.mergeAuthorization.sha, baseSha: work.mergeAuthorization.baseSha }, { sha: head, baseSha: main }, 'the merge authorization is re-established on the same head');

  // An ejection for a run that really failed is not lifted by a pass older than it.
  const real = { ...work, queue: null, queueEjection: { at: '', sequence, sha: head, policyRevision: work.policyRevision, conflict: null, reason: 'x', check: { name: 'test', runId: 110739678222, tip: head, speculation } },
    observation: { ...work.observation!, checks: [passedAttempt, run('test', 110739678222, 'failure'), typecheck] } } as unknown as Work;
  assert.equal(ejectedCheckLift(real, [real], [15368]), null);
});
