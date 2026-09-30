import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { GitHub, processJob } from '../src/github.js';
import { ejectedTipRestore, pendingBaseRefresh, restoringAfterEjectionPrefix } from '../src/merge-queue.js';
import { neededDecision } from '../src/daemon/decisions.js';
import { branchReport, buildMasterStatus } from '../src/master/status.js';
import { Refusal, type Observation, type Principal, type Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-854. An ejection restore rebuilt onto a recorded base, claimed success for a result GitHub
// never showed, and the loop logged the same done line forever while the pull request still
// pointed at the ejected tip. Each test is named for the proof it produces.
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const treeOf = (sha: string) => sha40(`7${sha.slice(0, 2)}`);

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
let database: EmbeddedPostgres, store: Store, engine: Engine;
let pullRequest = 700;
before(async () => {
  const port = Number(process.env.GRAPHYARD_EJECTION_RESTORE_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 780);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('ejection-restore'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.controlPlaneAppId = 1234;
  engine.principals = [operator, worker];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const definition = { plannedFiles: ['src/queue.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:ejection'] }] };
const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
const events = async (work: Work, kind: string) => (await store.events(work.id)).filter(event => event.kind === kind);
const gate = (work: Work, name: string) => work.gates.find(entry => entry.name === name)!;

async function released(title: string) {
  let work = await engine.execute(operator, 'create', null, { ...definition, title }, randomUUID());
  return engine.execute(operator, 'ready', work.id, {}, randomUUID());
}
/** A predecessor of the ejected tip that never landed: it is what makes the tip contaminated. */
async function predecessor() {
  const work = await released('Predecessor that never landed');
  return (await store.list()).find(item => item.id === work.id)!;
}
async function submitted(title: string) {
  let work = await released(title);
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/restore/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-1` }, randomUUID());
  return engine.execute(worker, 'submit', work.id, { epoch: 1, pr: ++pullRequest }, randomUUID());
}
/** A submitted candidate at a tip the queue ejected behind `ahead`, bound to a base it no longer contains. */
async function ejected(title: string, ahead: Work) {
  const work = await submitted(title);
  const at = new Date().toISOString(), contaminated = sha40('a1'), own = sha40('a0');
  return { work: await patch(work, {
      candidate: { sha: contaminated, baseSha: sha40('b1'), pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' },
      queueEjection: { at, sequence: 4, reason: `Required CI check test did not pass on speculative tip ${contaminated}`, sha: contaminated, policyRevision: work.policyRevision, predecessors: [ahead.key] },
      queueHistory: [{ at, event: 'predicted' as const, sequence: 4, tip: contaminated, predecessors: [ahead.key], from: own }] }), contaminated, own };
}
async function patch(work: Work, fields: Partial<Work>) {
  await store.pool.query('UPDATE work_items SET document=$2::jsonb WHERE id=$1', [work.id, JSON.stringify({ ...work, ...fields })]);
  return reload(work);
}
/** One observation of the ejected tip, with the base branch tip where main actually is now. */
function seen(work: Work, contaminated: string, baseTip: string, extra: Partial<Observation> = {}): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { sha: contaminated, baseSha: work.candidate!.baseSha, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [], protected: true, mergeable: true,
    merged: false, mergeSha: null, prState: 'open', draft: false, baseTip, baseTree: treeOf(baseTip), baseTipContained: false,
    files: [], scopeFiles: [], landing: { base: baseTip, files: [], carried: [], foreign: [], examined: [] }, at: new Date().toISOString(), ...extra };
}
async function onlyJob(work: Work) {
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [work.id]);
}
/**
 * The real provider restore over a fake request surface: the base branch sits at `tip`, the pull
 * request's branch shows `readback` after every write, and a merge onto any branch is clean,
 * refused (branch protection), or conflicts. Every write is recorded with its body.
 */
function provider(work: Work, options: { tip: string; readback: () => string; merge?: 'clean' | 'refused' | 'conflict' }) {
  const writes: { path: string; method: string; body: any }[] = [];
  const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used-in-adapter-test' });
  github.controlPlaneLogin = async () => 'graphyard-owner-project[bot]';
  const branchPath = `/git/ref/heads/${work.workspaces[0].branch.split('/').map(encodeURIComponent).join('/')}`;
  github.request = async (path: string, method = 'GET', body?: unknown) => {
    if (method !== 'GET') writes.push({ path, method, body });
    if (path === '/merges') {
      if (options.merge === 'conflict') throw new Refusal('GitHub POST /merges failed (409)', 502);
      if (options.merge === 'refused') throw new Refusal('GitHub POST /merges failed (403)', 502);
      return { sha: sha40('ee') };
    }
    if (method !== 'GET') return { id: 12 };
    if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: options.tip } };
    if (path === branchPath) return { ref: `refs/heads/${work.workspaces[0].branch}`, object: { type: 'commit', sha: options.readback() } };
    if (/^\/commits\/[a-f0-9]{40}$/.test(path)) {
      const sha = path.slice(9);
      return { sha, commit: { tree: { sha: treeOf(sha) }, author: { email: 'noreply@github.com' } }, parents: [{ sha: work.baseRefresh?.restore?.own ?? sha40('a0') }, { sha: options.tip }], author: { login: 'graphyard-owner-project[bot]', type: 'Bot' } };
    }
    if (path.startsWith('/compare/')) return { status: 'ahead', files: [] };
    if (path === `/pulls/${work.submission!.pr}`) return { number: work.submission!.pr, head: { sha: work.candidate!.sha, ref: work.workspaces[0].branch }, base: { ref: 'main' }, state: 'open', draft: false };
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  return { github, writes };
}
/** The reconciliation job's adapter: observes `observation`; every branch path is refused except the real restore when `restore` is given. */
function adapter(observation: (work: Work) => Observation, restore?: GitHub) {
  const called: string[] = [];
  const refuse = (name: string) => async (work: Work) => { called.push(name); throw new Error(`${work.key} must not reach ${name}`); };
  return { called, github: {
    observe: async (work: Work) => observation(work),
    refreshCandidateBase: refuse('refreshCandidateBase'),
    restoreBranch: restore ? (work: Work, request: Parameters<GitHub['restoreBranch']>[1], guard: () => Promise<void>) => { called.push('restoreBranch'); return restore.restoreBranch(work, request, guard); } : refuse('restoreBranch'),
    publishSpeculativeTip: refuse('publishSpeculativeTip'),
    mergeBranch: refuse('mergeBranch'),
    updateBranch: refuse('updateBranch'),
    requestCodex: refuse('requestCodex'),
    publish: async () => {},
  } as unknown as GitHub };
}

test('unit:ejection-restore-current-tip — an ejection restore merges the reviewed head onto the base tip read at the restore, never the recorded base, and is recorded done only when GitHub shows the branch at the restored commit', async () => {
  const ahead = await predecessor();
  const stale = sha40('b1'), moved = sha40('b2');
  let { work, contaminated, own } = await ejected('Restores onto the current tip', ahead);
  assert.equal(work.candidate!.baseSha, stale, 'the recorded base is the stale one the tip has since left');
  const observation = (item: Work) => seen(item, contaminated, moved);
  work = await engine.observe(work.id, work.revision, observation(work));
  assert.match(gate(work, 'build').reasons.join(' '), new RegExp(`^${restoringAfterEjectionPrefix}`), 'the tree gates hold while the restore is owed');

  // Attempt 1: GitHub accepts the writes but keeps showing the branch at the ejected tip — the
  // result the restore used to claim as done. It is a failure now, with the read-back as evidence.
  const silent = provider(work, { tip: moved, readback: () => contaminated });
  await onlyJob(work);
  const first = adapter(observation, silent.github);
  await processJob(engine, first.github);
  assert.deepEqual(first.called, ['restoreBranch'], 'the restore is the only branch work the job did');
  const merge = silent.writes.find(write => write.path === '/merges')!;
  assert.equal(merge.body.head, moved, 'the merge asked for the tip read at the restore');
  assert.notEqual(merge.body.head, stale, 'the recorded base was never used');
  work = await reload(work);
  const failed = work.baseRefresh!;
  assert.deepEqual([failed.restore!.outcome, failed.head, failed.base], ['unpublished', null, moved]);
  assert.equal(failed.restore!.attempts, 1);
  assert.equal(failed.restore!.escalated ?? null, null, 'a first failure is not yet a repeat');
  assert.equal(failed.restore!.failureKind, 'read-back mismatch');
  assert.ok(failed.restore!.failure!.includes(`wrote the restored commit ${sha40('ee').slice(0, 12)}`), failed.restore!.failure ?? '');
  assert.ok(failed.restore!.failure!.includes(`shows the branch at ${contaminated.slice(0, 12)}`), failed.restore!.failure ?? '');
  assert.deepEqual([(await events(work, 'branch.restored')).length, (await events(work, 'branch.restore-unpublished')).length], [0, 1]);
  assert.equal(pendingBaseRefresh(work), null, 'no refresh is built on the contaminated head while the restore is unfinished');
  assert.match(gate(work, 'build').reasons.join(' '), new RegExp(`^${restoringAfterEjectionPrefix}`), 'the head is still held, and nobody is asked to change it');

  // Attempt 2, the one retry: GitHub now shows the branch at the restored commit — done.
  const honest = provider(work, { tip: moved, readback: () => sha40('ee') });
  await onlyJob(work);
  const second = adapter(observation, honest.github);
  await processJob(engine, second.github);
  assert.deepEqual(second.called, ['restoreBranch']);
  work = await reload(work);
  const done = work.baseRefresh!;
  assert.deepEqual([done.restore!.outcome, done.head, done.base], ['restored', sha40('ee'), moved]);
  assert.equal(done.restore!.own, own);
  assert.equal(done.restore!.attempts, 2);
  assert.equal(done.restore!.escalated ?? null, null, 'a different result is no repeat of the first');
  assert.equal((await events(work, 'branch.restored')).length, 1);
  assert.equal(ejectedTipRestore(work, await store.list()), null, 'nothing more is owed');
});

test('unit:ejection-restore-no-silent-repeat — a restore that produces the same failed result twice without the candidate changing is escalated with its reason instead of repeating, and master status names it', async () => {
  const ahead = await predecessor();
  const moved = sha40('b3');
  let { work, contaminated } = await ejected('No silent repeat', ahead);
  const observation = (item: Work) => seen(item, contaminated, moved);
  work = await engine.observe(work.id, work.revision, observation(work));

  // Attempt 1: branch protection refuses the merge — recorded as the failure it is.
  const protection = provider(work, { tip: moved, readback: () => contaminated, merge: 'refused' });
  await onlyJob(work);
  await processJob(engine, adapter(observation, protection.github).github);
  work = await reload(work);
  const firstFailure = work.baseRefresh!.restore!;
  assert.deepEqual([firstFailure.outcome, firstFailure.attempts], ['unpublished', 1]);
  assert.equal(firstFailure.failureKind, 'merge refused');
  assert.ok(firstFailure.failure!.includes('was merged into it: GitHub POST /merges failed (403)'), firstFailure.failure ?? '');
  assert.equal(firstFailure.escalated ?? null, null);

  // The loop owes exactly one retry, carrying the record of the attempt before it.
  const retry = ejectedTipRestore(work, await store.list());
  assert.ok(retry, 'the failed restore is retried once');
  assert.equal(retry!.previous?.outcome, 'unpublished');
  assert.equal(retry!.previous?.attempts, 1);
  assert.equal(retry!.previous?.failureKind, 'merge refused');

  // Attempt 2: the same refusal again, with the base tip moved since — the refusal's text quotes
  // the tip, so the two texts differ; the result is the same (branch protection refused the merge,
  // the candidate never changed), and that is what the record escalates on, never the text.
  const movedAgain = sha40('b4');
  const protectionAgain = provider(work, { tip: movedAgain, readback: () => contaminated, merge: 'refused' });
  await onlyJob(work);
  await processJob(engine, adapter(observation, protectionAgain.github).github);
  work = await reload(work);
  const escalated = work.baseRefresh!.restore!;
  assert.deepEqual([escalated.outcome, escalated.attempts], ['unpublished', 2]);
  assert.equal(escalated.failureKind, 'merge refused', 'the stable kind of both failures');
  assert.notEqual(escalated.failure, firstFailure.failure, 'the refusal texts differ, each quoting the tip of its own attempt');
  assert.ok(firstFailure.failure!.includes(moved.slice(0, 12)), firstFailure.failure ?? '');
  assert.ok(escalated.failure!.includes(movedAgain.slice(0, 12)), escalated.failure ?? '');
  assert.match(escalated.escalated!, /failed twice without the candidate changing/);
  assert.ok(escalated.escalated!.includes('stops repeating'), escalated.escalated ?? '');
  assert.equal(ejectedTipRestore(work, await store.list()), null, 'no third attempt is offered');
  assert.equal(pendingBaseRefresh(work), null, 'and no refresh is built on the contaminated head either');

  // The item is held, not sent anywhere: the build gate names the escalation and no rework is asked for.
  const reasons = gate(work, 'build').reasons.join(' ');
  assert.match(reasons, new RegExp(`^${restoringAfterEjectionPrefix}`));
  assert.match(reasons, /stopped repeating/);
  assert.ok(reasons.includes(escalated.failure!), reasons);
  assert.equal(neededDecision(work, { autoMerge: true }), null, 'the escalation is the master\'s to answer, not a worker round');

  // master status names it, with the next command, and the branch report carries the same facts.
  const status = buildMasterStatus(await store.workSnapshot(), [], []);
  const row = status.work.find(entry => entry.key === work.key)!;
  assert.match(row.attention!, /stopped repeating/);
  assert.ok(row.attention!.includes(escalated.failure!), row.attention ?? '');
  assert.match(row.attentionOwner!.next, /graphyard master repair/);
  assert.ok(status.attentionItems.some(item => item.subject === work.key && /stopped repeating/.test(item.text)), 'the escalation is on the attention list');
  const line = branchReport(status.work).contaminated.find(entry => entry.key === work.key)!;
  assert.match(line.line, /not on the branch/);
  assert.match(line.line, /escalated: it stops repeating/);
  assert.ok(line.line.includes(escalated.failure!), line.line);
});

test('unit:ejection-restore-no-silent-repeat — a second failure of a different kind still escalates: the bound is two attempts per contaminated head, never two matching results', async () => {
  const ahead = await predecessor();
  const moved = sha40('b5');
  let { work, contaminated } = await ejected('Alternating failures', ahead);
  const observation = (item: Work) => seen(item, contaminated, moved);
  work = await engine.observe(work.id, work.revision, observation(work));

  // Attempt 1: branch protection refuses the merge.
  await onlyJob(work);
  await processJob(engine, adapter(observation, provider(work, { tip: moved, readback: () => contaminated, merge: 'refused' }).github).github);
  work = await reload(work);
  const firstFailure = work.baseRefresh!.restore!;
  assert.deepEqual([firstFailure.outcome, firstFailure.failureKind, firstFailure.attempts, firstFailure.escalated ?? null], ['unpublished', 'merge refused', 1, null]);

  // Attempt 2: the merge now goes through but GitHub never shows it — a different kind of failure.
  await onlyJob(work);
  const second = provider(work, { tip: moved, readback: () => contaminated });
  await processJob(engine, adapter(observation, second.github).github);
  work = await reload(work);
  const escalated = work.baseRefresh!.restore!;
  assert.deepEqual([escalated.outcome, escalated.failureKind, escalated.attempts], ['unpublished', 'read-back mismatch', 2]);
  assert.ok(escalated.escalated, 'the second failure escalates though its kind differs from the first');
  assert.ok(escalated.escalated!.includes('merge refused, then read-back mismatch'), escalated.escalated!);
  assert.ok(escalated.escalated!.includes(firstFailure.failure!) && escalated.escalated!.includes(escalated.failure!), 'both reasons are named');
  assert.equal(ejectedTipRestore(work, await store.list()), null, 'no third attempt is offered');

  // Another reconciliation writes nothing to the branch: the escalation holds the item.
  await onlyJob(work);
  const third = provider(work, { tip: sha40('b6'), readback: () => contaminated, merge: 'refused' });
  const job = adapter(observation, third.github);
  await processJob(engine, job.github);
  assert.deepEqual([job.called, third.writes], [[], []], 'no restore runs and no branch write is made after the escalation');
  assert.equal((await reload(work)).baseRefresh!.restore!.attempts, 2);
});
