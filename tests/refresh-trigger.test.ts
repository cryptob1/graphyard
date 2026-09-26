import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { GitHub, processJob } from '../src/github.js';
import { baseRefreshNeeded, ejectedTipRestore, pendingBaseRefresh, pendingRestore, staleMergeability } from '../src/merge-queue.js';
import { behindBaseHold } from '../src/model/behind-base.js';
import { neededDecision, syncConflict } from '../src/daemon/decisions.js';
import { Refusal, type Observation, type Principal, type Work } from '../src/model.js';

// GY-375. After GY-292 an unqueued candidate is refreshed only when GitHub reports it conflicting
// with the moved base — but GitHub's reading is recomputed lazily, and clean candidates were
// refreshed on a stale `mergeable: false`, losing their review and proofs on every merge to main.
// Each test is named for the proof it produces.
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const treeOf = (sha: string) => sha40(`7${sha.slice(0, 2)}`);

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
const producer: Principal = { id: 'ci-runner', role: 'producer', proofs: ['unit:trigger', 'integration:trigger'] };
let database: EmbeddedPostgres, store: Store, engine: Engine;
let pullRequest = 900;
before(async () => {
  const port = Number(process.env.GRAPHYARD_REFRESH_TRIGGER_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 375);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-refresh-trigger-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.controlPlaneAppId = 1234;
  engine.principals = [operator, worker, producer];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const definition = { plannedFiles: ['src/queue.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:trigger', 'integration:trigger'] }] };
const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
const events = async (work: Work, kind: string) => (await store.events(work.id)).filter(event => event.kind === kind);
const gate = (work: Work, name: string) => work.gates.find(entry => entry.name === name)!;
const stages = ['backlog', 'ready', 'build', 'review', 'test', 'acceptance', 'merge', 'done'];

async function submitted(title: string) {
  let work = await engine.execute(operator, 'create', null, { ...definition, title }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/trigger/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-1` }, randomUUID());
  return engine.execute(worker, 'submit', work.id, { epoch: 1, pr: ++pullRequest }, randomUUID());
}
/** One observation of a candidate, approved on its own head, with a required check still running so it never enters the queue. */
function seen(work: Work, candidate: { sha: string; baseSha: string }, extra: Partial<Observation> = {}): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { ...candidate, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'in_progress', appId: 15368 }],
    reviews: [{ id: 41, reviewer: 'graphyard-reviewer[bot]', sha: candidate.sha, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: treeOf(candidate.baseSha), baseTipContained: true,
    files: ['src/queue.ts'], scopeFiles: [], at: new Date().toISOString(), ...extra };
}
/** An approved candidate with trusted, scoped evidence for every required proof. */
async function validated(work: Work, candidate: { sha: string; baseSha: string }) {
  let observed = await engine.observe(work.id, work.revision, seen(work, candidate));
  for (const proof of ['unit:trigger', 'integration:trigger'])
    observed = await engine.execute(producer, 'evidence', observed.id, { proof, sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 1, result: 'pass', executed: 2, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 }, scopeFiles: ['src/queue.ts'] }, randomUUID());
  return observed;
}
async function onlyJob(work: Work) {
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [work.id]);
}
async function patch(work: Work, fields: Partial<Work>) {
  const current = await reload(work);
  await store.pool.query('UPDATE work_items SET document=$2::jsonb WHERE id=$1', [current.id, JSON.stringify({ ...current, ...fields })]);
  return reload(work);
}

/**
 * The real provider refresh over a fake request surface: the base branch sits at `tip`, and a
 * merge onto any branch is clean or conflicts as `merge` says. Every write is recorded.
 */
function provider(work: Work, tip: string, merge: 'clean' | 'conflict') {
  const writes: string[] = [];
  const github = new GitHub({ repository: 'owner/repo', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used-in-adapter-test' });
  github.request = async (path, method = 'GET') => {
    if (method !== 'GET') writes.push(`${method} ${path}`);
    if (path === '/merges') {
      if (merge === 'conflict') throw new Refusal('GitHub POST /merges failed (409)', 502);
      return { sha: sha40('ee') };
    }
    if (method !== 'GET') return { id: 12 };
    if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: tip } };
    if (/^\/commits\/[a-f0-9]{40}$/.test(path)) return { sha: path.slice(9), commit: { tree: { sha: treeOf(path.slice(9)) } }, parents: [] };
    if (path === `/pulls/${work.submission!.pr}`) return { number: work.submission!.pr, head: { sha: work.candidate!.sha, ref: work.workspaces[0].branch }, base: { ref: 'main' }, state: 'open', draft: false };
    throw new Error(`Unexpected request ${path}`);
  };
  return { github, writes };
}
/** The reconciliation job's adapter: observes `observation`; every branch-writing path refuses, except the real refresh when `refresh` is given. */
function adapter(observation: (work: Work) => Observation, refresh?: GitHub) {
  const called: string[] = [];
  const refuse = (name: string) => async (work: Work) => { called.push(name); throw new Error(`${work.key} must not reach ${name}`); };
  return { called, github: {
    observe: async (work: Work) => observation(work),
    refreshCandidateBase: refresh ? (work: Work, guard: () => Promise<void>) => { called.push('refreshCandidateBase'); return refresh.refreshCandidateBase(work, guard); } : refuse('refreshCandidateBase'),
    restoreBranch: refuse('restoreBranch'),
    publishSpeculativeTip: refuse('publishSpeculativeTip'),
    mergeBranch: refuse('mergeBranch'),
    updateBranch: refuse('updateBranch'),
    requestCodex: refuse('requestCodex'),
    publish: async () => {},
  } as unknown as GitHub };
}
const snapshot = (work: Work) => ({ head: work.candidate!.sha, baseSha: work.candidate!.baseSha, review: gate(work, 'review').passed,
  acceptance: gate(work, 'acceptance').passed, evidence: work.evidence.map(entry => entry.id).sort(), refreshed: work.baseRefresh?.head !== undefined && work.baseRefresh.head !== work.candidate!.sha, carry: work.baseRefresh?.carry ?? null });

test('unit:clean-candidate-not-refreshed — GitHub reporting a clean unqueued candidate conflicting is checked with a test merge: a clean one is recorded as a stale reading and keeps everything; a confirmed conflict is refreshed and reworked', async () => {
  const main = sha40('a1'), moved = sha40('a2'), head = sha40('a3');
  let work = await validated(await submitted('Stale mergeability'), { sha: head, baseSha: main });
  assert.equal(gate(work, 'review').passed, true); assert.equal(gate(work, 'acceptance').passed, true);
  const before = snapshot(work), stage = work.stage;

  // Main moves; GitHub's first reading after it says the head conflicts. It does not.
  const conflicting = (item: Work) => seen(item, { sha: head, baseSha: main }, { baseTip: moved, baseTree: treeOf(moved), baseTipContained: false, mergeable: false, conflicting: true });
  work = await engine.observe(work.id, work.revision, conflicting(work));
  assert.deepEqual(baseRefreshNeeded(work), { head, boundBase: main, baseTip: moved }, 'GitHub reading alone asks for a confirmation');
  const clean = provider(work, moved, 'clean');
  await onlyJob(work);
  const job = adapter(conflicting, clean.github);
  await processJob(engine, job.github);
  assert.deepEqual(job.called, ['refreshCandidateBase'], 'the confirmation is the only branch work the job did');
  assert.deepEqual(clean.writes, ['PATCH /git/refs/heads/graphyard-merge-check/' + work.key.toLowerCase(), 'POST /merges', 'DELETE /git/refs/heads/graphyard-merge-check/' + work.key.toLowerCase()],
    'the test merge ran on a scratch branch that was deleted; the candidate branch was never written');

  work = await reload(work);
  assert.deepEqual(snapshot(work), before, 'no refresh: the head, its bound base, the review and every proof are unchanged');
  assert.equal(work.stage, stage, 'the stage does not move');
  const stale = staleMergeability(work)!;
  assert.deepEqual([stale.head, stale.base, stale.policyRevision], [head, moved, work.policyRevision], 'the stale reading is recorded for this head and tip');
  assert.match(stale.reading, /test merge of the two is clean; the reading is stale and nothing was refreshed/);
  assert.deepEqual([work.baseRefresh!.head, work.baseRefresh!.conflict, work.baseRefresh!.trigger], [head, null, undefined], 'the record names the unchanged head: no refresh, no conflict');
  assert.deepEqual([work.observation!.conflicting, work.observation!.mergeable], [false, true], 'the stored observation has the stale conflict disproved');
  assert.deepEqual(work.observation!.disproved, { mergeable: false, conflicting: true, reading: stale.reading }, 'GitHub\'s raw reading is kept beside the disproved one (GY-390)');
  // GitHub keeps repeating the stale reading: every later observation of the same pair is stored disproved.
  work = await engine.observe(work.id, work.revision, conflicting(work));
  assert.equal(work.observation!.conflicting, false);
  assert.deepEqual(work.observation!.disproved, { mergeable: false, conflicting: true, reading: stale.reading }, 'a repeated stale reading keeps GitHub\'s raw fields too');
  assert.equal((await events(work, 'base.stale-mergeability')).length, 1);
  assert.deepEqual([(await events(work, 'base.refreshed')).length, (await events(work, 'base.conflict')).length], [0, 0]);
  // Nothing downstream acts on the stale reading either: no second refresh, no sync, no review hold.
  assert.equal(baseRefreshNeeded(work), null);
  assert.equal(pendingBaseRefresh(work), null);
  assert.equal(syncConflict(work), null, 'no sync rework is asked for a conflict that is not there');
  assert.equal(behindBaseHold(work), null, 'the head stays reviewable');
  assert.notEqual(neededDecision(work, { autoMerge: false })?.action, 'rework');
  // A second pass of the job on the same reading repeats nothing.
  await onlyJob(work);
  const again = adapter(conflicting);
  await processJob(engine, again.github);
  assert.deepEqual(again.called, []);

  // A real conflict: the same reading on a head whose test merge does conflict.
  const conflictHead = sha40('b3');
  let other = await validated(await submitted('Real conflict'), { sha: conflictHead, baseSha: main });
  const real = (item: Work) => seen(item, { sha: conflictHead, baseSha: main }, { baseTip: moved, baseTree: treeOf(moved), baseTipContained: false, mergeable: false, conflicting: true });
  other = await engine.observe(other.id, other.revision, real(other));
  const conflict = provider(other, moved, 'conflict');
  await onlyJob(other);
  const refreshing = adapter(real, conflict.github);
  await processJob(engine, refreshing.github);
  assert.deepEqual(refreshing.called, ['refreshCandidateBase']);
  assert.ok(conflict.writes.every(write => write === 'POST /merges' || write.includes('graphyard-merge-check/')), 'a confirmed conflict writes nothing to the candidate branch');
  other = await reload(other);
  assert.equal(other.baseRefresh!.stale ?? null, null);
  assert.equal(other.baseRefresh!.trigger, 'conflict confirmed', 'the refresh records its trigger');
  assert.match(other.baseRefresh!.conflict!, new RegExp(`Candidate ${conflictHead.slice(0, 12)} cannot be brought onto base branch tip ${moved.slice(0, 12)}`));
  const [recorded] = await events(other, 'base.conflict');
  assert.equal((recorded.payload as any).details.trigger, 'conflict confirmed');
  // The rework: the conflict returns the candidate to a worker.
  assert.equal(gate(other, 'build').passed, false);
  assert.equal(neededDecision(other, { autoMerge: false })?.action, 'rework');
});

test('unit:no-other-refresh-path — reconcile, the landing check and ejection re-entry leave a clean unqueued candidate behind a moved base as it is, even when GitHub reports it conflicting', async () => {
  const main = sha40('c1'), head = sha40('c3');
  let work = await validated(await submitted('No other path'), { sha: head, baseSha: main });
  const before = snapshot(work), stage = work.stage;
  const behind = (tip: string, extra: Partial<Observation> = {}) => (item: Work) => seen(item, { sha: head, baseSha: main }, { baseTip: tip, baseTree: treeOf(tip), baseTipContained: false, ...extra });
  const settled = async (path: string) => {
    work = await reload(work);
    assert.deepEqual(snapshot(work), before, `${path}: head, review and proofs are unchanged`);
    assert.ok(stages.indexOf(work.stage) >= stages.indexOf(stage), `${path}: the stage does not move backwards (${stage} → ${work.stage})`);
    assert.deepEqual([baseRefreshNeeded(work), pendingRestore(work), ejectedTipRestore(work, await store.list()), syncConflict(work)], [null, null, null, null], `${path}: nothing owes a refresh`);
    assert.equal(behindBaseHold(work), null, `${path}: the head stays reviewable`);
    assert.notEqual(neededDecision(work, { autoMerge: false })?.action, 'rework', `${path}: no rework is asked for`);
    assert.deepEqual([(await events(work, 'base.refreshed')).length, (await events(work, 'base.conflict')).length], [0, 0], `${path}: no refresh or conflict was recorded`);
  };
  // GitHub reads the candidate mergeable: nothing is even confirmed.
  const unchanged = async (path: string, observation: (item: Work) => Observation) => {
    await onlyJob(work);
    const job = adapter(observation);
    await processJob(engine, job.github);
    assert.deepEqual(job.called, [], `${path}: no refresh, restore, merge or republish`);
    await settled(path);
  };
  // GitHub reads the candidate conflicting with a tip it merges onto cleanly — the stale
  // `mergeable: false` right after main moves (GY-274, GY-349). The only branch work is the
  // confirmation's test merge on a scratch branch; the candidate's own branch is never written.
  const stale = async (path: string, tip: string, observation: (item: Work) => Observation) => {
    const clean = provider(work, tip, 'clean');
    await onlyJob(work);
    const job = adapter(observation, clean.github);
    await processJob(engine, job.github);
    assert.ok(job.called.every(name => name === 'refreshCandidateBase'), `${path}: no restore, merge or republish (${job.called.join(', ')})`);
    assert.ok(clean.writes.every(write => write.includes('graphyard-merge-check/') || write === 'POST /merges'), `${path}: only the scratch branch is written (${clean.writes.join(', ')})`);
    work = await reload(work);
    assert.equal(work.observation!.conflicting, false, `${path}: the stale conflict is stored disproved`);
    assert.equal(staleMergeability(work)?.base, tip, `${path}: the stale reading is recorded for the new tip`);
    await settled(`${path} (stale conflict reading)`);
    // GitHub keeps repeating the reading: the next pass confirms nothing again and changes nothing.
    await onlyJob(work);
    const again = adapter(observation);
    await processJob(engine, again.github);
    assert.deepEqual(again.called, [], `${path}: a repeated stale reading is not confirmed again`);
    work = await reload(work);
    assert.equal(work.observation!.conflicting, false, `${path}: the repeated stale conflict is stored disproved`);
    await settled(`${path} (repeated stale conflict reading)`);
  };
  const conflicting = { mergeable: false, conflicting: true };

  // Reconcile: the observation job on a clean candidate behind the moved base.
  await unchanged('reconcile', behind(sha40('d1')));
  await stale('reconcile', sha40('d2'), behind(sha40('d2'), conflicting));
  // Landing check: the landing comparison against the moved tip lists base changes, but no other
  // item's commits and nothing this head drops.
  const landing = (tip: string) => ({ landing: { base: tip, files: [], carried: [], foreign: [], examined: [] } });
  await unchanged('landing check', behind(sha40('d3'), landing(sha40('d3'))));
  await stale('landing check', sha40('d4'), behind(sha40('d4'), { ...landing(sha40('d4')), ...conflicting }));
  // Ejection re-entry (GY-321): the candidate was ejected for a predecessor conflict, the
  // predecessor is gone, and the same head re-enters rather than being rebuilt onto the base.
  work = await patch(work, { queueEjection: { at: new Date().toISOString(), sequence: 1, reason: `Speculative merge of ${head.slice(0, 12)} into graphyard/gy-x conflicts and cannot be resolved by Graphyard`, sha: head, policyRevision: work.policyRevision, predecessors: ['GY-9999'] },
    queueHistory: [{ at: new Date().toISOString(), event: 'predicted', sequence: 1, tip: sha40('c4'), predecessors: ['GY-9999'], from: head }] });
  await unchanged('ejection re-entry', behind(sha40('d5')));
  await stale('ejection re-entry', sha40('d6'), behind(sha40('d6'), conflicting));
});
