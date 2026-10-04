import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { GitHub, processJob } from '../src/github.js';
import { SpeculativeConflict } from '../src/model/refusal.js';
import { landingRefreshNeeded, mergeParallelTipsEvent, predictQueue, queueRef, validatedQueueEntry, type QueuePlacement, type QueueSpeculation } from '../src/merge-queue.js';
import { carriedApproval, evidenceBindsCandidate, type Observation, type Principal, type TipMerge, type Work } from '../src/model.js';
import { evaluateLandability } from '../src/model/landability.js';
import { neededDecision } from '../src/daemon/decisions.js';
import { cycleFaults, emptyDaemonState } from '../src/master-daemon.js';
import { restoreWaitBoundMs } from '../src/daemon/faults.js';
import { masterConfigSchema } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1131: the queue verifies and refreshes waiting entries when work lands behind them, instead
// of conflict-ejecting them at their turn. Each test is named for the proof it produces. The
// scenarios run the real reconciliation job (processJob) against Postgres with the real
// GitHub.refreshWaitingEntry and publishSpeculativeTip over a stubbed GitHub API, so what the
// tests read is what the engine persisted, never an in-memory copy.

const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const treeOf = (sha: string) => sha40(`7${sha.slice(0, 2)}`);
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const producer: Principal = { id: 'ci-runner', role: 'producer', proofs: ['unit:queue', 'integration:docs'] };
let database: EmbeddedPostgres, store: Store, engine: Engine;
let pr = 900;
before(async () => {
  const port = Number(process.env.GRAPHYARD_LANDING_REFRESH_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1131);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('landing-refresh'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.controlPlaneAppId = 1234;
  // The producer is a known principal, so no item stands on an unauthorized proof.
  engine.principals = [operator, worker, coordinator, producer];
  // One tip validated at a time: every entry behind the head waits unverified until its turn,
  // which is exactly the wait a landing refresh answers.
  await store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', ['operator', mergeParallelTipsEvent, JSON.stringify({ parallelTips: 1 })]);
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
const input = { plannedFiles: ['src/queue.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:queue', 'integration:docs'] }] };
async function submitted(title: string) {
  let work = await engine.execute(operator, 'create', null, { ...input, title }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/landing/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-1` }, randomUUID());
  return engine.execute(worker, 'submit', work.id, { epoch: 1, pr: ++pr }, randomUUID());
}
function observed(work: Work, candidate: { sha: string; baseSha: string }, extra: Partial<Observation> = {}): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { ...candidate, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [{ id: 41, reviewer: 'graphyard-reviewer[bot]', sha: candidate.sha, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: treeOf(candidate.baseSha), baseTipContained: true,
    files: ['src/queue.ts', 'tests/queue.test.ts'], scopeFiles: [], at: new Date().toISOString(), ...extra };
}
/** A candidate approved and proven on its own head, each proof declaring its scope: queued once evaluated. */
async function validated(work: Work, candidate: { sha: string; baseSha: string }) {
  let current = await engine.observe(work.id, work.revision, observed(work, candidate));
  current = await engine.execute(producer, 'evidence', current.id, { proof: 'unit:queue', sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 1, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 }, scopeFiles: ['src/queue.ts', 'tests/'] }, randomUUID());
  return engine.execute(producer, 'evidence', current.id, { proof: 'integration:docs', sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 1, result: 'pass', executed: 2, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 }, scopeFiles: ['docs/'] }, randomUUID());
}
async function onlyJob(work: Work) {
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [work.id]);
}
async function clearQueue() { await store.pool.query("UPDATE work_items SET document=document-'queue' WHERE document->>'stage'<>'done'"); }
async function mergeHead(work: Work, candidate: { sha: string; baseSha: string }, mergeSha: string) {
  const current = await reload(work);
  const committed = await engine.requestEnqueue(coordinator, current.id, { enqueue: true, expectedRevision: current.revision, sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: current.policyRevision }, randomUUID());
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  return engine.observe(current.id, committed.revision, observed(current, candidate, { merged: true, mergeSha, mergedAt }));
}

/**
 * The GitHub side: a real GitHub adapter whose API calls are stubbed. `heads` is each pull
 * request's branch head as GitHub holds it; `conflicts` names the keys whose merge conflicts.
 */
function remote(state: { baseTip: string; landed: string[] | null; heads: Map<number, string>; conflicts: Set<string>; tips: Map<string, string> }) {
  const merges: { key: string; head: string; base: string; message: string }[] = [], pushes: { branch: string; sha: string }[] = [], refs: { ref: string; sha: string }[] = [], listed: { from: string; to: string }[] = [];
  const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 1, privateKey: 'unused' });
  const api = github as any;
  api.request = async (path: string) => {
    const pull = path.match(/^\/pulls\/(\d+)$/);
    if (pull) return { number: Number(pull[1]), head: { sha: state.heads.get(Number(pull[1])), ref: `branch-${pull[1]}` }, base: { ref: 'main' }, state: 'open', draft: false, user: { login: 'implementer' } };
    if (path.startsWith('/commits/')) return { sha: path.slice(9), commit: { message: 'worker change' }, author: { login: 'implementer' }, parents: [{ sha: sha40('99') }] };
    throw new Error(`unexpected request ${path}`);
  };
  api.pages = async () => [];
  api.controlPlaneLogin = async () => 'graphyard[bot]';
  api.baseBranch = async () => ({ tip: state.baseTip, tree: treeOf(state.baseTip) });
  api.commitTree = async (sha: string) => treeOf(sha);
  api.changedFiles = async (from: string, to: string) => { listed.push({ from, to }); return state.landed; };
  api.mergeOnScratch = async (key: string, head: string, base: string, message: string) => {
    merges.push({ key, head, base, message });
    if (state.conflicts.has(key)) throw new SpeculativeConflict(`Speculative merge of ${base.slice(0, 12)} into graphyard-merge-check/${key.toLowerCase()} conflicts in src/queue.ts`);
    return state.tips.get(key)!;
  };
  api.updateBranch = async (branch: string, sha: string) => { pushes.push({ branch, sha }); };
  api.publishRef = async (ref: string, sha: string) => { refs.push({ ref, sha }); };
  // GitHub's account of the merge: authored by the App over exactly the reviewed head and the
  // landed tip, with the entry's own diff unchanged (the same patch-id on both sides).
  api.describeMerge = async (from: string, tip: string, _bound: string, base: string): Promise<TipMerge> =>
    ({ from, parents: [from, base], author: 'graphyard[bot]', authoredByApp: true, conflicts: false, baseChanges: state.landed, diff: { reviewed: sha40('5a'), tip: sha40('5a') } });
  return { github, merges, pushes, refs, listed };
}
/** The reconciliation adapter: observation from `observe`, the landing refresh from the real adapter, nothing published for a head. */
function adapter(real: GitHub, observe: (work: Work) => Observation) {
  const headTips: string[] = [];
  return { headTips, github: {
    observe: async (work: Work) => observe(work),
    refreshWaitingEntry: real.refreshWaitingEntry.bind(real),
    // The head's own tip, as the real publisher builds it: the App's merge of the entry's reviewed
    // head onto the base tip, its own diff unchanged.
    publishSpeculativeTip: async (work: Work, placement: QueuePlacement): Promise<QueueSpeculation> => {
      headTips.push(work.key);
      const speculation = work.queue?.speculation, candidate = work.candidate!;
      const reviewedHead = speculation?.tip === candidate.sha ? speculation.reviewedHead ?? candidate.sha : candidate.sha;
      const tip = sha40(`e${reviewedHead.slice(0, 2)}`), base = placement.predictedBase!;
      return { ref: queueRef(work.key), tip, base, baseTree: treeOf(base), predecessors: placement.predecessors, policyRevision: work.policyRevision, publishedAt: new Date().toISOString(), reviewedHead, trigger: 'queue-head',
        merge: { from: reviewedHead, parents: [reviewedHead, base], author: 'graphyard[bot]', authoredByApp: true, conflicts: false, baseChanges: ['docs/landed.md'], diff: { reviewed: sha40('5a'), tip: sha40('5a') } } };
    },
    requestCodex: async () => { throw new Error('no review request expected'); },
    publish: async () => {},
  } as unknown as GitHub };
}

/** Three queued entries on main1: A heads the queue, B and C wait behind it; main then moves to main2 under all three. */
async function queueOfThree(tag: string) {
  await clearQueue();
  const main1 = sha40(`${tag}1`), main2 = sha40(`${tag}2`);
  const heads = { a: sha40(`${tag}a`), b: sha40(`${tag}b`), c: sha40(`${tag}c`) };
  let a = await submitted(`Landing head ${tag}`), b = await submitted(`Landing waiting ${tag}`), c = await submitted(`Landing last ${tag}`);
  a = await validated(a, { sha: heads.a, baseSha: main1 }); b = await validated(b, { sha: heads.b, baseSha: main1 }); c = await validated(c, { sha: heads.c, baseSha: main1 });
  const tips = new Map([[b.key, sha40(`${tag}d`)], [c.key, sha40(`${tag}e`)]]);
  const state = { baseTip: main2, landed: ['src/queue.ts', 'docs/landed.md'] as string[] | null, heads: new Map([[a.submission!.pr, heads.a], [b.submission!.pr, heads.b], [c.submission!.pr, heads.c]]), conflicts: new Set<string>(), tips };
  const api = remote(state);
  // Every entry's observation reads the moved base tip; the head stays the worker's until a tip replaces it.
  const at = new Map([[a.id, heads.a], [b.id, heads.b], [c.id, heads.c]]);
  // A head GitHub shows at the entry's published tip is bound to the base that tip was built on.
  const observe = (work: Work) => {
    const sha = at.get(work.id)!, speculation = work.queue?.speculation;
    const baseSha = speculation?.tip === sha ? speculation.base : work.candidate!.sha === sha ? work.candidate!.baseSha : main2;
    return observed(work, { sha, baseSha }, { baseTip: state.baseTip, baseTree: treeOf(state.baseTip) });
  };
  const run = async (work: Work) => { await onlyJob(work); const job = adapter(api.github, observe); await processJob(engine, job.github); return job; };
  /** The queue head publishes its tip on the base tip, is observed on it, and lands as `mergeSha`. */
  const land = async (work: Work, mergeSha: string) => {
    const turn = await run(work);
    at.set(work.id, (await reload(work)).queue!.speculation!.tip);
    await run(work);
    const current = await reload(work);
    const merged = await mergeHead(current, { sha: current.candidate!.sha, baseSha: current.candidate!.baseSha }, mergeSha);
    state.baseTip = mergeSha;
    return { turn, merged };
  };
  return { a, b, c, main1, main2, heads, tips, state, api, at, run, land };
}

test('unit:landing-test-merges-overlapping-queued-entries — every waiting entry whose reviewed files the landing changed is test-merged onto the landed tip; the head whose turn came is not', async () => {
  const q = await queueOfThree('1');
  for (const work of [q.a, q.b, q.c]) assert.ok((await reload(work)).queue, `${work.key} is queued`);
  assert.deepEqual(predictQueue(await store.list(), Date.now()).map(placement => [placement.key, placement.position]), [[q.a.key, 0], [q.b.key, 1], [q.c.key, 2]]);
  await q.run(q.a); await q.run(q.b); await q.run(q.c);
  assert.deepEqual(q.api.merges.map(merge => [merge.key, merge.head, merge.base]), [[q.b.key, q.heads.b, q.main2], [q.c.key, q.heads.c, q.main2]],
    'B and C were merged onto the landed tip, A (the head, whose own tip validates it) was not');
  assert.deepEqual(q.api.listed, [{ from: q.main1, to: q.main2 }, { from: q.main1, to: q.main2 }], 'the landed diff was listed from each entry\'s bound base');
  assert.equal((await reload(q.a)).queue!.landingRefresh ?? null, null);
});

test('unit:refresh-skips-entries-outside-landed-diff — an entry none of whose reviewed files the landing changed is recorded skipped, and nothing is merged or written', async () => {
  const q = await queueOfThree('2');
  q.state.landed = ['docs/unrelated.md', 'src/other.ts'];
  await q.run(q.b);
  assert.deepEqual(q.api.merges, [], 'no test merge for a disjoint landing');
  assert.deepEqual([q.api.pushes, q.api.refs], [[], []]);
  const b = await reload(q.b);
  assert.deepEqual([b.queue!.landingRefresh?.outcome, b.queue!.landingRefresh?.landing, b.queue!.landingRefresh?.overlap], ['skipped', q.main2, []]);
  assert.equal(b.candidate!.sha, q.heads.b, 'the head is untouched');
  assert.equal(b.queue!.sequence, q.b.queue!.sequence, 'the entry keeps its place');
  // A landed diff GitHub cannot list is no ground to skip: the entry is merged instead.
  const unlisted = await queueOfThree('3');
  unlisted.state.landed = null;
  await unlisted.run(unlisted.b);
  assert.deepEqual(unlisted.api.merges.map(merge => merge.key), [unlisted.b.key]);
});

test('unit:refresh-bounded-once-per-entry-per-landing — an entry is examined once per landing, whatever its next observations read', async () => {
  const q = await queueOfThree('4');
  await q.run(q.b);
  assert.equal(q.api.merges.length, 1);
  // GitHub still reports the worker's head (the push not yet visible): the landing is on record, nothing repeats.
  await q.run(q.b);
  // The refreshed tip observed on the landed base: nothing is owed either.
  q.at.set(q.b.id, q.tips.get(q.b.key)!);
  await q.run(q.b); await q.run(q.b);
  assert.equal(q.api.merges.length, 1, 'one test merge for one landing');
  assert.equal(q.api.listed.length, 1, 'the landed diff was listed once');
  // A skip is bounded the same way.
  const skipped = await queueOfThree('5');
  skipped.state.landed = ['docs/unrelated.md'];
  await skipped.run(skipped.c); await skipped.run(skipped.c);
  assert.deepEqual([skipped.api.listed.length, skipped.api.merges.length], [1, 0]);
  // The next landing is examined afresh, its diff listed from the landing last verified.
  const main3 = sha40('5f');
  skipped.state.baseTip = main3; skipped.state.landed = ['src/queue.ts'];
  await skipped.run(skipped.c);
  assert.deepEqual(skipped.api.listed.at(-1), { from: skipped.main2, to: main3 });
  assert.deepEqual(skipped.api.merges.map(merge => [merge.key, merge.base]), [[skipped.c.key, main3]]);
  // The pure rule: a landing already on record is never owed again.
  const c = await reload(skipped.c);
  assert.equal(landingRefreshNeeded(c, await store.list(), Date.now(), 1), null);
});

test('unit:clean-refresh-publishes-entry-tip — a clean merge is published as the entry\'s speculative tip and persisted on its record', async () => {
  const q = await queueOfThree('6');
  await q.run(q.b);
  const tip = q.tips.get(q.b.key)!;
  assert.deepEqual(q.api.pushes, [{ branch: `branch-${q.b.submission!.pr}`, sha: tip }]);
  assert.deepEqual(q.api.refs, [{ ref: queueRef(q.b.key), sha: tip }]);
  assert.match(q.api.merges[0].message, new RegExp(`^Graphyard speculative tip for ${q.b.key} behind main`), 'the tip is a speculative tip, not a [skip ci] merge check');
  const b = await reload(q.b);
  const speculation = b.queue!.speculation!;
  assert.deepEqual([speculation.tip, speculation.base, speculation.trigger, speculation.reviewedHead, speculation.predecessors], [tip, q.main2, 'landing-refresh', q.heads.b, []]);
  assert.deepEqual([speculation.landing?.outcome, speculation.landing?.landing, speculation.landing?.overlap], ['refreshed', q.main2, ['src/queue.ts']]);
  const events = (await store.events(b.id)).filter(event => event.kind === 'queue.predicted');
  assert.equal(events.length, 1, 'the publication is in the ledger');
});

test('unit:refreshed-entry-keeps-approval-and-proofs — the refreshed tip carries the approval and every proof, and the entry keeps its queue position', async () => {
  const q = await queueOfThree('7');
  await q.run(q.b);
  const tip = q.tips.get(q.b.key)!;
  q.at.set(q.b.id, tip);
  await q.run(q.b);
  const b = await reload(q.b);
  assert.deepEqual(b.candidate && [b.candidate.sha, b.candidate.baseSha], [tip, q.main2], 'the next observation binds the tip on the landed base');
  const carry = b.queue!.speculation!.carry!;
  assert.equal(carry.approval.carried, true, carry.approval.reason);
  assert.deepEqual(carry.evidence.map(entry => [entry.proof, entry.carried]), [['unit:queue', true], ['integration:docs', true]]);
  assert.equal(carriedApproval(b)?.reviewer, 'graphyard-reviewer[bot]');
  assert.ok(b.evidence.every(entry => evidenceBindsCandidate(b, entry)), 'every proof binds the tip');
  assert.ok(b.gates.filter(gate => gate.name !== 'merge').every(gate => gate.passed), b.gates.flatMap(gate => gate.reasons).join('; '));
  assert.equal(b.queue!.sequence, q.b.queue!.sequence, 'same queue sequence');
  assert.equal(predictQueue(await store.list(), Date.now()).find(placement => placement.id === b.id)!.position, 1, 'same queue position');
});

test('unit:refresh-push-is-single-head-binding — the branch moves once, only from the exact head the job bound, and only while the job still owns the entry', async () => {
  const q = await queueOfThree('8');
  // A worker push GitHub shows that the record does not: nothing is written, and the job retries.
  q.state.heads.set(q.b.submission!.pr, sha40('8f'));
  await q.run(q.b);
  assert.deepEqual([q.api.merges.length, q.api.pushes.length, q.api.refs.length], [0, 0, 0], 'a changed head is never overwritten');
  assert.equal((await reload(q.b)).queue!.speculation ?? null, null);
  // The job lost ownership before the write: the guard refuses and nothing is pushed.
  q.state.heads.set(q.b.submission!.pr, q.heads.b);
  const b = await reload(q.b);
  const fenced = q.api.github.refreshWaitingEntry(b, landingRefreshNeeded(b, await store.list(), Date.now(), 1)!, async () => { throw new Error('Work or job ownership changed before publication; retry'); });
  await assert.rejects(fenced, /ownership changed/);
  assert.deepEqual([q.api.pushes.length, q.api.refs.length], [0, 0]);
  // Bound and owned: exactly one push of the branch, to the tip.
  await q.run(q.b);
  assert.deepEqual(q.api.pushes, [{ branch: `branch-${q.b.submission!.pr}`, sha: q.tips.get(q.b.key)! }]);
  // One push per own head: the next landing finds the head already a Graphyard tip, and verifies
  // its reviewed head by the GY-375 test merge alone ([skip ci], scratch only), pushing nothing.
  q.at.set(q.b.id, q.tips.get(q.b.key)!);
  await q.run(q.b);
  const main3 = sha40('8e');
  q.state.baseTip = main3;
  await q.run(q.b);
  assert.deepEqual(q.api.merges.map(merge => [merge.head, merge.base, /\[skip ci\]$/.test(merge.message)]), [[q.heads.b, q.main2, false], [q.heads.b, main3, true]]);
  assert.equal(q.api.pushes.length, 1, 'still the one push');
  const verified = await reload(q.b);
  assert.deepEqual([verified.queue!.landingRefresh?.outcome, verified.queue!.landingRefresh?.landing], ['verified', main3]);
  assert.equal(verified.candidate!.sha, q.tips.get(q.b.key));
});

test('unit:confirmed-conflict-yields-head-at-landing — a conflict confirmed at the landing moves the entry to the back and the next entry takes its place', async () => {
  const q = await queueOfThree('9');
  q.state.conflicts.add(q.b.key);
  await q.run(q.b);
  assert.deepEqual([q.api.pushes, q.api.refs], [[], []], 'a conflict writes nothing');
  let b = await reload(q.b);
  const c = await reload(q.c);
  assert.ok(b.queue!.sequence > c.queue!.sequence, 'B moved behind C');
  assert.deepEqual(b.queueHistory!.at(-1) && [b.queueHistory!.at(-1)!.event, b.queueHistory!.at(-1)!.tip], ['requeued', q.main2]);
  // The rework is asked for now, not at B's turn.
  const decision = neededDecision(b, { reviewRoundCap: 3 } as any);
  assert.equal(decision?.action, 'rework');
  // C is now directly behind A; B is passed over.
  const placements = predictQueue(await store.list(), Date.now());
  assert.equal(placements.find(entry => entry.id === c.id)!.position, 1, 'C takes B\'s place');
  assert.deepEqual(placements.find(entry => entry.id === b.id)!.passedOver ?? [], [], 'B is behind every validated entry');
  // The job was requeued; its next run evaluates B as the build gate refusing the conflict, and examines nothing again.
  await q.run(q.b);
  b = await reload(q.b);
  assert.equal(b.stage, 'build');
  assert.equal(q.api.merges.length, 1);
});

test('unit:early-rework-names-conflict-and-base — the rework requested at the landing names the conflict and the landed tip that caused it', async () => {
  const q = await queueOfThree('a');
  q.state.conflicts.add(q.c.key);
  await q.run(q.c);
  const c = await reload(q.c);
  const conflict = c.baseRefresh!.conflict!;
  assert.match(conflict, new RegExp(`Candidate ${q.heads.c.slice(0, 12)} cannot be brought onto base branch tip ${q.main2.slice(0, 12)} without resolving a conflict`));
  assert.match(conflict, /conflicts in src\/queue\.ts/);
  assert.match(conflict, new RegExp(`Found when ${q.main2.slice(0, 12)} landed on src/queue\\.ts, before this entry's turn`));
  assert.deepEqual([c.baseRefresh!.from.sha, c.baseRefresh!.base, c.baseRefresh!.head], [q.heads.c, q.main2, null]);
  assert.deepEqual([c.queue!.landingRefresh?.outcome, c.queue!.landingRefresh?.landing], ['conflict', q.main2]);
  const decision = neededDecision(c, { reviewRoundCap: 3 } as any)!;
  assert.equal(decision.action, 'rework');
  assert.ok(decision.reason.includes(conflict), decision.reason);
  assert.equal(decision.binding, `${q.heads.c}:conflict`);
  assert.equal((await store.events(c.id)).filter(event => event.kind === 'queue.landing-conflict').length, 1);
});

test('unit:conflicting-entry-never-heads-the-queue — an entry whose landing merge conflicts is passed over, and heads nothing when the head lands', async () => {
  const q = await queueOfThree('b');
  q.state.conflicts.add(q.b.key);
  await q.run(q.b);
  let b = await reload(q.b);
  // Even before its gates are evaluated again, the recorded conflict passes it over.
  assert.equal(b.stage, 'merge');
  assert.equal(validatedQueueEntry(b), false);
  await q.run(q.b);
  // The head lands; C, not B, is the next head.
  assert.equal((await q.land(q.a, sha40('bf'))).merged.stage, 'done');
  const all = await store.list();
  const placements = predictQueue(all, Date.now());
  const head = placements.find(entry => entry.position === 0 && validatedQueueEntry(all.find(item => item.id === entry.id)!));
  assert.equal(head?.key, q.c.key);
  b = await reload(q.b);
  assert.equal(validatedQueueEntry(b), false, 'B never heads the queue while it conflicts');
});

test('unit:refreshed-entry-lands-without-ejection — an entry refreshed at the landing reaches its turn mergeable and lands with no base-conflict ejection', async () => {
  const q = await queueOfThree('c');
  await q.run(q.b);
  const tip = q.tips.get(q.b.key)!;
  q.at.set(q.b.id, tip);
  await q.run(q.b);
  // The head lands; B's turn comes with its refreshed tip, holding the landed work already.
  assert.equal((await q.land(q.a, sha40('cf'))).merged.stage, 'done');
  let b = await reload(q.b);
  assert.ok(b.queue, 'B is still queued');
  assert.equal(predictQueue(await store.list(), Date.now()).find(entry => entry.id === b.id)!.position, 0, 'B heads the queue');
  const { turn, merged } = await q.land(q.b, sha40('ce'));
  assert.deepEqual(turn.headTips, [q.b.key], 'B publishes as the head, on its refreshed tip');
  assert.equal(merged.stage, 'done', 'B lands');
  b = await reload(q.b);
  assert.equal(b.queueEjection ?? null, null, 'never ejected');
  assert.equal(b.baseRefresh?.conflict ?? null, null, 'no base conflict');
  assert.equal(q.api.merges.length, 1, 'the one merge was the landing refresh');
  assert.ok(!(b.queueHistory ?? []).some(entry => entry.event === 'ejected'));
});

test('unit:landability-holds-conflicting-entry — landability refuses an entry whose landing merge conflicts and never presents it as landable', async () => {
  const q = await queueOfThree('d');
  q.state.conflicts.add(q.b.key);
  await q.run(q.b);
  const all = await store.list();
  const b = all.find(item => item.id === q.b.id)!;
  const verdict = evaluateLandability(b, all, new Date());
  assert.equal(verdict.verdict, 'refused');
  assert.ok(verdict.verdict === 'refused' && verdict.reasons.some(reason => reason.gate === 'build' && /cannot be brought onto base branch tip/.test(reason.reason)), JSON.stringify(verdict));
  // The clean neighbour is landable.
  const c = all.find(item => item.id === q.c.id)!;
  const cv = evaluateLandability(c, all, new Date());
  assert.equal(cv.verdict, 'landable', JSON.stringify(cv));
});

/** The base-conflict faults the master loop's fault classes count this cycle, read from the records the engine persisted. */
async function baseConflictFaults(now = Date.now()) {
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/outside/graphyard.mjs',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master', autoMerge: true, mergeMethod: 'merge', workers: [] });
  return cycleFaults(emptyDaemonState(config), await store.list(), now, { config }).filter(fault => fault.kind === 'base-conflict').map(fault => fault.subject);
}

test('unit:base-conflict-class-quiet-after-refresh — an entry refreshed at the landing never raises the base-conflict fault class on its way to landing, and a conflict is observed at the landing, never at the entry\'s turn', async () => {
  // Clean: B is refreshed at the landing behind it, then heads the queue and lands. The loop's
  // base-conflict class, read from the persisted records after every step, never names it.
  const q = await queueOfThree('e');
  const seen: string[][] = [];
  await q.run(q.b); seen.push(await baseConflictFaults());
  const refreshed = await reload(q.b);
  assert.deepEqual([refreshed.queue!.speculation?.trigger, refreshed.queue!.speculation?.base], ['landing-refresh', q.main2], 'B was refreshed onto the landed tip, before its turn');
  q.at.set(q.b.id, q.tips.get(q.b.key)!);
  await q.run(q.b); seen.push(await baseConflictFaults());
  await q.land(q.a, sha40('ef')); seen.push(await baseConflictFaults());
  const { merged } = await q.land(q.b, sha40('ee')); seen.push(await baseConflictFaults());
  assert.equal(merged.stage, 'done', 'B lands on its refreshed tip');
  assert.deepEqual(seen.map(subjects => subjects.filter(subject => subject === q.b.key)), [[], [], [], []], 'the base-conflict class stays quiet for the refreshed entry at every step');
  // Not weakened: a conflict the landing confirms is observed by the class at once, while the
  // entry still waits behind the head, and it is the only entry the class names.
  const conflicted = await queueOfThree('f');
  conflicted.state.conflicts.add(conflicted.b.key);
  assert.deepEqual((await baseConflictFaults()).filter(subject => [conflicted.b.key, conflicted.c.key].includes(subject)), [], 'nothing stands before the landing is verified');
  await conflicted.run(conflicted.b); await conflicted.run(conflicted.c);
  const b = await reload(conflicted.b);
  assert.notEqual(predictQueue(await store.list(), Date.now()).find(entry => entry.id === b.id)?.position, 0, 'B has not reached its turn');
  assert.equal(b.baseRefresh?.trigger, 'conflict confirmed', 'the landing confirmed the conflict while B waits');
  // GY-1129: the class holds a confirmed conflict back while its owed rework is in motion
  // (baseConflictInMotion), so read it once that grace has passed: it names B and only B.
  const lapsed = Date.parse(b.baseRefresh!.at) + restoreWaitBoundMs + 1_000;
  assert.deepEqual((await baseConflictFaults(lapsed)).filter(subject => [conflicted.a.key, conflicted.b.key, conflicted.c.key].includes(subject)), [conflicted.b.key],
    'the conflict is observed at the landing, on B alone; C, refreshed cleanly, stays quiet');
});
