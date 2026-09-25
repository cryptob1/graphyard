import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { CHECK_NAME, GitHub, processJob } from '../src/github.js';
import { baseRefreshConflict, baseRefreshNeeded, heldBase, pendingBaseRefresh, queueRef, type BaseRefresh, type QueuePlacement, type QueueSpeculation } from '../src/merge-queue.js';
import { Refusal, type Observation, type Principal, type Work } from '../src/model.js';
import { diagnose } from '../src/coordination.js';
import { buildMasterStatus } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import type { MasterConfig } from '../src/master.js';

// Each test is named for the proof it produces, so acceptance evidence maps to one executed
// case per required proof.
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const treeOf = (sha: string) => sha40(`7${sha.slice(0, 2)}`);

// ---- Provider adapter: a fake GitHub over the same request surface the real one uses ----------

const PR = 82;
function provider(options: { head: string; boundBase: string; branchTip: string; branchTree?: string } ) {
  const calls: { path: string; method: string; body: any }[] = [];
  let branchTip = options.branchTip, branchTree = options.branchTree ?? treeOf(options.branchTip);
  let mergeResult: { sha: string } | 'conflict' | null = null;
  let contains: Record<string, boolean> = {};
  let baseChanges: any[] = [];
  let commits: Record<string, any> = {};
  const pr: any = { number: PR, head: { sha: options.head, ref: 'graphyard/gy-82-1', repo: { full_name: 'owner/repo' } },
    base: { sha: options.boundBase, ref: 'main', repo: { full_name: 'owner/repo' } },
    user: { login: 'implementer' }, merged: false, mergeable: true, draft: false, state: 'open', merge_commit_sha: null };
  const github = new GitHub({ repository: 'owner/repo', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used-in-adapter-test' });
  github.controlPlaneLogin = async () => 'graphyard-owner-repo[bot]';
  github.request = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (path === '/merges' && method === 'POST') {
      if (mergeResult === 'conflict') throw new Refusal('GitHub POST /merges failed (409)', 502);
      return mergeResult;
    }
    if (method !== 'GET') return { id: 12 };
    if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: branchTip } };
    if (/^\/commits\/[a-f0-9]{40}$/.test(path)) {
      const sha = path.slice(9);
      return { sha, commit: { tree: { sha: sha === branchTip ? branchTree : treeOf(sha) }, author: { email: 'noreply@github.com' } }, parents: [], author: null, ...(commits[sha] ?? {}) };
    }
    if (path.startsWith('/compare/')) {
      const [from, to] = path.slice(9).split('?')[0].split('...');
      const page = Number(path.match(/[?&]page=(\d+)/)?.[1] ?? 1);
      return { status: from === to ? 'identical' : contains[`${from}...${to}`] ? 'ahead' : 'diverged', files: page === 1 ? baseChanges : [] };
    }
    if (path === `/pulls/${PR}`) return structuredClone(pr);
    if (path.includes('/protection')) return { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
    if (path.includes('/reviews')) return [{ id: 41, user: { login: 'graphyard-reviewer[bot]' }, commit_id: options.head, state: 'APPROVED' }];
    if (path.includes('/files')) return [{ filename: 'src/queue.ts', status: 'modified', sha: sha40('cc'), additions: 4, deletions: 1 }];
    if (path.includes('/check-runs')) return { check_runs: [{ id: 9, name: 'test', status: 'completed', conclusion: 'success', app: { id: 15368 } }] };
    throw new Error(`Unexpected request ${path}`);
  };
  const work = { id: 'gy-82', key: 'GY-82', policy: { review: true, checks: ['test'] }, plannedFiles: ['src/queue.ts'],
    submission: { pr: PR, epoch: 1 }, candidate: { sha: options.head, baseSha: options.boundBase, pr: PR, branch: 'graphyard/gy-82-1', author: 'implementer' },
    policyRevision: 1, revision: 3, reworkRequested: false, gates: [], violations: [], evidence: [], observation: null, stage: 'review' } as unknown as Work;
  return { github, work, calls,
    branch: (tip: string, tree?: string) => { branchTip = tip; branchTree = tree ?? treeOf(tip); },
    merges: (result: { sha: string } | 'conflict' | null) => { mergeResult = result; },
    ancestry: (map: Record<string, boolean>) => { contains = { ...contains, ...map }; },
    changed: (files: string[]) => { baseChanges = files.map(filename => ({ filename })); },
    commit: (sha: string, detail: any) => { commits[sha] = detail; },
    mergeable: (value: boolean | null) => { pr.mergeable = value; } };
}

test('integration:auto-rebase-clean-candidate — a candidate the base branch moved under keeps the base it was bound to; a clean one is left as it is (GY-292), and one GitHub reports conflicting is republished on the new tip as a Graphyard-authored merge when the merge succeeds', async () => {
  const head = sha40('a1'), boundBase = sha40('b1'), movedTo = sha40('b2'), refreshed = sha40('a2');
  const f = provider({ head, boundBase, branchTip: boundBase });
  // Before anything moves the candidate binds the live head, exactly as it always did.
  f.ancestry({ [`${boundBase}...${head}`]: true });
  const settled = await f.github.observe(f.work);
  assert.deepEqual([settled.candidate.baseSha, settled.baseTip, settled.baseTipContained], [boundBase, boundBase, true]);
  assert.equal(baseRefreshNeeded({ ...f.work, observation: settled, candidate: settled.candidate }), null);

  // Somebody else merges. The branch head moves; this candidate's tree did not change, so the
  // approval and proofs bound to it stay bound and no rework round is asked of the worker.
  f.branch(movedTo);
  f.ancestry({ [`${boundBase}...${movedTo}`]: true, [`${movedTo}...${head}`]: false });
  const behind = await f.github.observe(f.work);
  assert.deepEqual([behind.candidate.baseSha, behind.baseTip, behind.baseTipContained], [boundBase, movedTo, false],
    'the bound base is held while the branch head is ahead of it');
  // GitHub reports it merging cleanly with the new tip: nothing is rebuilt (GY-292).
  assert.notEqual(behind.conflicting, true);
  assert.equal(baseRefreshNeeded({ ...f.work, observation: behind, candidate: behind.candidate }), null, 'a clean candidate is not refreshed');

  // GitHub reports a conflict: the control plane tries the merge itself.
  f.mergeable(false);
  const conflicting = await f.github.observe(f.work);
  assert.deepEqual([conflicting.candidate.baseSha, conflicting.conflicting], [boundBase, true]);
  const work = { ...f.work, observation: conflicting, candidate: conflicting.candidate };
  assert.deepEqual(baseRefreshNeeded(work), { head, boundBase, baseTip: movedTo });
  assert.deepEqual(pendingBaseRefresh(work), { baseTip: movedTo, boundBase });

  // The control plane merges the moved base into the candidate's own branch.
  f.merges({ sha: refreshed });
  f.changed(['src/head.ts', 'docs/head.md']);
  f.commit(refreshed, { parents: [{ sha: head }, { sha: movedTo }], author: { login: 'graphyard-owner-repo[bot]', type: 'Bot' } });
  const writes: string[] = [];
  const refresh = await f.github.refreshCandidateBase(work, async () => { writes.push('guarded'); });
  assert.deepEqual(writes, ['guarded'], 'the job lease is re-checked before the provider write');
  assert.deepEqual([refresh.from, refresh.base, refresh.head, refresh.conflict], [{ sha: head, baseSha: boundBase }, movedTo, refreshed, null]);
  assert.deepEqual(refresh.merge, { from: head, parents: [head, movedTo], author: 'graphyard-owner-repo[bot]', authoredByApp: true, conflicts: false, baseChanges: ['src/head.ts', 'docs/head.md'] });
  const merge = f.calls.find(call => call.path === '/merges')!;
  assert.deepEqual(merge.body, { base: 'graphyard/gy-82-1', head: movedTo, commit_message: 'Graphyard base refresh for GY-82 onto main' });
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, 1, 'exactly one provider write: the merge onto the candidate\'s own branch');
});

test('integration:auto-rebase-conflict-guard — a base the control plane cannot merge in cleanly writes nothing, names the conflict, and gives the held base up so nothing carries', async () => {
  const head = sha40('a1'), boundBase = sha40('b1'), movedTo = sha40('b2');
  const f = provider({ head, boundBase, branchTip: movedTo });
  f.ancestry({ [`${boundBase}...${movedTo}`]: true, [`${movedTo}...${head}`]: false });
  f.mergeable(false);
  const behind = await f.github.observe(f.work);
  const work = { ...f.work, observation: behind, candidate: behind.candidate };
  f.merges('conflict');
  const refresh = await f.github.refreshCandidateBase(work);
  assert.equal(refresh.head, null, 'nothing was published');
  assert.match(refresh.conflict!, new RegExp(`Candidate ${head.slice(0, 12)} cannot be brought onto base branch tip ${movedTo.slice(0, 12)} without resolving a conflict`));
  assert.match(refresh.conflict!, /Run graphyard sync GY-82, resolve it and push/);
  assert.equal(f.calls.filter(call => call.method !== 'GET' && call.path !== '/merges').length, 0, 'a conflicting refresh writes nothing else');

  // The held base is a privilege of a candidate Graphyard can still bring forward. A recorded
  // conflict gives it up, so the candidate rebinds to the live head and every binding is
  // invalidated exactly as it was before any of this existed.
  const conflicted = { ...work, baseRefresh: refresh } as Work;
  assert.equal(heldBase(conflicted, head, movedTo), null);
  assert.equal(baseRefreshConflict(conflicted), refresh.conflict);
  assert.equal(baseRefreshNeeded(conflicted), null, 'a refusal is not retried until the head or the base moves');
  assert.equal(pendingBaseRefresh(conflicted), null, 'a conflicting candidate is not "just waiting for a refresh"');
  const rebound = await f.github.observe(conflicted);
  assert.deepEqual([rebound.candidate.baseSha, rebound.baseTipContained], [movedTo, false], 'the candidate is bound to the live head again');

  // A rewound branch is not an advance either: the held base has to still be on the branch.
  const rewound = provider({ head, boundBase, branchTip: sha40('b3') });
  rewound.ancestry({ [`${boundBase}...${sha40('b3')}`]: false, [`${sha40('b3')}...${head}`]: false });
  assert.equal((await rewound.github.observe(rewound.work)).candidate.baseSha, sha40('b3'));
});

// ---- Engine integration: a real Postgres, a stubbed provider ----------------------------------

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const producer: Principal = { id: 'ci-runner', role: 'producer', proofs: ['unit:rebase', 'integration:rebase'] };
let database: EmbeddedPostgres, store: Store, engine: Engine;
let pullRequest = 700;
before(async () => {
  const port = Number(process.env.GRAPHYARD_AUTO_REBASE_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 24);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-auto-rebase-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.controlPlaneAppId = 1234;
  // The producer's environment authority is what makes the required proofs producible; without it
  // every item reports a proof-authority gap and the attention assertions below measure that instead.
  engine.principals = [operator, worker, coordinator, producer];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const definition = { plannedFiles: ['src/queue.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:rebase', 'integration:rebase'] }] };
const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
const events = async (work: Work, kind: string) => (await store.events(work.id)).filter(event => event.kind === kind).reverse();
const gate = (work: Work, name: string) => work.gates.find(entry => entry.name === name)!;

async function submitted(title: string) {
  let work = await engine.execute(operator, 'create', null, { ...definition, title }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/rebase/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-1` }, randomUUID());
  return engine.execute(worker, 'submit', work.id, { epoch: 1, pr: ++pullRequest }, randomUUID());
}
/** One observation of a candidate, approved on its own head; `extra` says what the branch did. */
function seen(work: Work, candidate: { sha: string; baseSha: string }, extra: Partial<Observation> = {}): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { ...candidate, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [{ id: 41, reviewer: 'graphyard-reviewer[bot]', sha: candidate.sha, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: treeOf(candidate.baseSha), baseTipContained: true,
    files: ['src/queue.ts', 'tests/queue.test.ts'], scopeFiles: [], at: new Date().toISOString(), ...extra };
}
/** An approved candidate with trusted, scoped evidence for every required proof. */
async function validated(work: Work, candidate: { sha: string; baseSha: string }, extra: Partial<Observation> = {}) {
  let observed = await engine.observe(work.id, work.revision, seen(work, candidate, extra));
  observed = await engine.execute(producer, 'evidence', observed.id, { proof: 'unit:rebase', sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 1, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 }, scopeFiles: ['src/queue.ts', 'tests/'] }, randomUUID());
  return engine.execute(producer, 'evidence', observed.id, { proof: 'integration:rebase', sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 1, result: 'pass', executed: 2, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 }, scopeFiles: ['docs/'] }, randomUUID());
}
async function onlyJob(work: Work) {
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [work.id]);
}
/** The control-plane adapter the reconciliation job drives: an observation and a base refresh. */
function adapter(observation: (work: Work) => Observation, refresh: ((work: Work) => BaseRefresh) | null,
  speculation: ((work: Work, placement: QueuePlacement) => QueueSpeculation) | null = null) {
  const refreshed: string[] = [], requested: string[] = [], published: string[] = [];
  return { refreshed, requested, published, github: {
    observe: async (work: Work) => observation(work),
    refreshCandidateBase: async (work: Work) => {
      if (!refresh) throw new Error(`${work.key} must not be refreshed`);
      refreshed.push(work.key); return refresh(work);
    },
    publishSpeculativeTip: async (work: Work, placement: QueuePlacement) => {
      if (!speculation) throw new Error(`${work.key} must not publish a speculative tip`);
      published.push(work.key); return speculation(work, placement);
    },
    requestCodex: async (work: Work) => { requested.push(work.candidate!.sha); throw new Error('no review request expected'); },
    publish: async () => {},
  } as unknown as GitHub };
}
/** The queue's own tip for a head that already contains its predicted base. */
const ownTip = (work: Work, placement: QueuePlacement): QueueSpeculation => ({ ref: queueRef(work.key), tip: work.candidate!.sha, base: placement.predictedBase!,
  baseTree: treeOf(placement.predictedBase!), predecessors: placement.predecessors, policyRevision: work.policyRevision, publishedAt: new Date().toISOString(), merge: null });
const refreshRecord = (work: Work, to: { head: string | null; base: string }, overrides: Partial<BaseRefresh> = {}): BaseRefresh => ({
  from: { sha: work.candidate!.sha, baseSha: work.candidate!.baseSha }, base: to.base, baseTree: treeOf(to.base),
  policyRevision: work.policyRevision, at: new Date().toISOString(), head: to.head, conflict: null,
  merge: to.head ? { from: work.candidate!.sha, parents: [work.candidate!.sha, to.base], author: 'graphyard[bot]', authoredByApp: true, conflicts: false, baseChanges: ['src/head.ts'] } : null,
  carry: null, ...overrides });
/** The head lands through the broker exactly as the master does it, and Graphyard observes the merge. */
async function mergeHead(work: Work, candidate: { sha: string; baseSha: string }, mergeSha: string) {
  const current = await reload(work);
  const granted = await engine.acquireMerge(coordinator, current.id, { expectedRevision: current.revision, sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: current.policyRevision }, randomUUID());
  await engine.verifyMerge(coordinator, current.id, { executionId: granted.execution.id }, seen(current, candidate), randomUUID());
  const committed = await engine.commitMerge(coordinator, current.id, { executionId: granted.execution.id }, randomUUID());
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  return engine.observe(current.id, committed.revision, seen(current, candidate, { merged: true, mergeSha, mergedAt }));
}
/** A candidate whose required checks have not all landed: in flight, never queue-eligible. */
const inFlight = (extra: Partial<Observation> = {}): Partial<Observation> => ({ checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'in_progress', appId: 15368 }], ...extra });

/** What GitHub reports for a head that does not merge cleanly with the moved base: the one kind of in-flight candidate a base refresh is for (GY-292). */
const conflicts: Partial<Observation> = { mergeable: false, conflicting: true };

test('integration:auto-rebase-clean-candidate — the reconciliation job leaves a clean stale candidate as it is (GY-292), brings one GitHub reports conflicting onto the new base, carries the approval and every scope-disjoint proof, and the item never leaves its stage', async () => {
  const main = sha40('11'), moved = sha40('12'), head = sha40('13'), refreshedHead = sha40('14');
  let work = await submitted('Clean refresh');
  work = await validated(work, { sha: head, baseSha: main }, inFlight());
  assert.equal(work.stage, 'test'); assert.equal(gate(work, 'review').passed, true); assert.equal(gate(work, 'acceptance').passed, true);
  const before = { evidence: work.evidence.map(entry => entry.id), stage: work.stage };

  // The base branch moves and the candidate still merges cleanly with it: nothing is rebuilt. It
  // keeps its head, its bound base, its approval and its proofs, and its stage (GY-292).
  const clean = (item: Work) => seen(item, { sha: head, baseSha: main }, inFlight({ baseTip: moved, baseTree: treeOf(moved), baseTipContained: false }));
  work = await engine.observe(work.id, work.revision, clean(work));
  assert.deepEqual([work.stage, gate(work, 'review').passed, gate(work, 'acceptance').passed], [before.stage, true, true]);
  assert.equal(pendingBaseRefresh(work), null);
  await onlyJob(work);
  const untouched = adapter(clean, null);
  await processJob(engine, untouched.github);
  assert.deepEqual([untouched.refreshed, untouched.published], [[], []], 'a clean candidate is not refreshed');
  work = await reload(work);
  assert.deepEqual([work.candidate!.sha, work.candidate!.baseSha, work.stage, work.baseRefresh ?? null], [head, main, before.stage, null]);

  // GitHub reports it conflicting with the moved base. The candidate holds the base it was bound
  // to, so nothing is lost while Graphyard tries to bring it forward: master status has nothing to
  // report to anybody about it.
  const stale = (item: Work) => seen(item, { sha: head, baseSha: main }, inFlight({ baseTip: moved, baseTree: treeOf(moved), baseTipContained: false, ...conflicts }));
  work = await engine.observe(work.id, work.revision, stale(work));
  assert.deepEqual([work.stage, gate(work, 'review').passed, gate(work, 'acceptance').passed], [before.stage, true, true]);
  assert.deepEqual(pendingBaseRefresh(work), { baseTip: moved, boundBase: main });

  await onlyJob(work);
  const run = adapter(stale, item => refreshRecord(item, { head: refreshedHead, base: moved }));
  await processJob(engine, run.github);
  assert.deepEqual([run.refreshed, run.requested, run.published], [[work.key], [], []], 'the base was refreshed, and no review or tip was asked for');

  work = await reload(work);
  const carry = work.baseRefresh!.carry!;
  assert.deepEqual([work.baseRefresh!.head, work.baseRefresh!.base, work.baseRefresh!.conflict], [refreshedHead, moved, null]);
  assert.equal(carry.approval.carried, true);
  assert.match(carry.approval.reason, /the base branch changed none of the 2 reviewed files/);
  assert.deepEqual(carry.evidence.map(entry => [entry.proof, entry.carried]), [['unit:rebase', true], ['integration:rebase', true]]);

  // The republished head is what everything binds to now, with no fresh round for any of it.
  work = await engine.observe(work.id, work.revision, seen(work, { sha: refreshedHead, baseSha: moved }, inFlight({ reviews: [] })));
  assert.deepEqual([work.candidate!.sha, work.candidate!.baseSha], [refreshedHead, moved]);
  assert.deepEqual([work.stage, gate(work, 'review').passed, gate(work, 'acceptance').passed, gate(work, 'build').passed], [before.stage, true, true, true]);
  assert.deepEqual(work.evidence.map(entry => entry.id), before.evidence, 'no proof was requested or produced for the move');
  const ledger = await events(work, 'base.refreshed');
  assert.equal(ledger.length, 1);
  assert.deepEqual(ledger[0].payload.details.carry, { approval: 'carried', evidence: { 'unit:rebase': 'carried', 'integration:rebase': 'carried' } });
  const diagnostics = diagnose(work, await store.list(), Date.now());
  assert.equal(diagnostics.filter(entry => entry.kind === 'base-refresh-carried').length, 3);
  assert.equal(diagnostics.some(entry => entry.kind === 'base-refresh-required'), false);
  assert.equal(diagnostics.some(entry => entry.kind === 'base-behind'), false);
});

test('integration:auto-rebase-conflict-guard — a conflicting base returns the item for rework with the conflict named, and a base that touches reviewed files or a proof scope re-requires exactly what it touched', async () => {
  const main = sha40('21'), moved = sha40('22'), head = sha40('23'), refreshedHead = sha40('24');
  let conflicting = await submitted('Conflicting refresh');
  conflicting = await validated(conflicting, { sha: head, baseSha: main }, inFlight());
  const stale = (item: Work) => seen(item, { sha: head, baseSha: main }, inFlight({ baseTip: moved, baseTree: treeOf(moved), baseTipContained: false, ...conflicts }));
  conflicting = await engine.observe(conflicting.id, conflicting.revision, stale(conflicting));
  await onlyJob(conflicting);
  const conflict = `Candidate ${head.slice(0, 12)} cannot be brought onto base branch tip ${moved.slice(0, 12)} without resolving a conflict, which is content nobody reviewed or proved: Speculative merge of ${moved.slice(0, 12)} into graphyard/gy-1 conflicts and cannot be resolved by Graphyard. Run graphyard sync ${conflicting.key}, resolve it and push; the approval and proofs bound to ${head.slice(0, 12)} do not survive the resolution.`;
  await processJob(engine, adapter(stale, item => refreshRecord(item, { head: null, base: moved }, { conflict })).github);
  conflicting = await reload(conflicting);
  assert.equal(conflicting.baseRefresh!.carry, null, 'a refusal decides no carry at all');
  assert.equal(gate(conflicting, 'build').passed, false);
  assert.deepEqual(gate(conflicting, 'build').reasons, [conflict]);
  assert.equal(conflicting.stage, 'build', 'the attempt returns for rework');
  assert.equal(baseRefreshNeeded(conflicting), null, 'the refusal is not retried on the same head and tip');
  assert.match(diagnose(conflicting, await store.list(), Date.now()).find(entry => entry.kind === 'base-conflict')!.message, /without resolving a conflict/);
  const status = buildMasterStatus(await store.workSnapshot(), [], []);
  const row = status.work.find(entry => entry.key === conflicting.key)!;
  assert.equal(row.attention, conflict);
  assert.match(row.attentionOwner!.next, new RegExp(`graphyard master decide ${conflicting.key} rework`));

  // A clean merge whose base touched a reviewed file or a declared proof scope carries only what
  // it may: the rest is required afresh with the reason, exactly as the merge queue decides it.
  const main2 = sha40('25'), moved2 = sha40('26'), head2 = sha40('27');
  let partial = await submitted('Partial carry');
  partial = await validated(partial, { sha: head2, baseSha: main2 }, inFlight());
  const stale2 = (item: Work) => seen(item, { sha: head2, baseSha: main2 }, inFlight({ baseTip: moved2, baseTree: treeOf(moved2), baseTipContained: false, ...conflicts }));
  partial = await engine.observe(partial.id, partial.revision, stale2(partial));
  await onlyJob(partial);
  await processJob(engine, adapter(stale2, item => {
    const record = refreshRecord(item, { head: refreshedHead, base: moved2 });
    return { ...record, merge: { ...record.merge!, baseChanges: ['tests/queue.test.ts', 'docs/queue.md'] } };
  }).github);
  partial = await reload(partial);
  const carry = partial.baseRefresh!.carry!;
  assert.equal(carry.approval.carried, false);
  assert.match(carry.approval.reason, /the base branch changed reviewed files tests\/queue\.test\.ts; a fresh independent approval/);
  assert.deepEqual(carry.evidence.map(entry => [entry.proof, entry.carried]), [['unit:rebase', false], ['integration:rebase', false]]);
  assert.match(carry.evidence[0].reason, /changed tests\/queue\.test\.ts inside the scope of evidence/);
  assert.match(carry.evidence[1].reason, /changed docs\/queue\.md inside the scope of evidence/);
  partial = await engine.observe(partial.id, partial.revision, seen(partial, { sha: refreshedHead, baseSha: moved2 }, inFlight({ reviews: [] })));
  assert.deepEqual([gate(partial, 'review').passed, gate(partial, 'acceptance').passed], [false, false]);
  assert.equal(partial.stage, 'review');
  assert.deepEqual(gate(partial, 'acceptance').reasons, [
    'AC-1: unit:rebase needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy',
    'AC-1: integration:rebase needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy']);
  assert.equal(diagnose(partial, await store.list(), Date.now()).filter(entry => entry.kind === 'base-refresh-required').length, 3);
});

test('integration:loop-acts-on-stale-base — an item that is only waiting for a base refresh is never on the attention list, and the cycle that refreshes it reports the action instead of counting nothing', async () => {
  const main = sha40('31'), moved = sha40('32'), head = sha40('33'), refreshedHead = sha40('34');
  let work = await submitted('Loop acts');
  work = await validated(work, { sha: head, baseSha: main }, inFlight());
  // Dwell past the hour that used to make every stale candidate an attention line.
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{stageEnteredAt}',to_jsonb((now()-interval '3 hours')::text)) WHERE id=$1", [work.id]);
  const stale = (item: Work) => seen(item, { sha: head, baseSha: main }, inFlight({ baseTip: moved, baseTree: treeOf(moved), baseTipContained: false, ...conflicts }));
  work = await engine.observe(work.id, (await reload(work)).revision, stale(work));

  const snapshot = await store.workSnapshot();
  const status = buildMasterStatus(snapshot, [], []);
  const row = status.work.find(entry => entry.key === work.key)!;
  assert.equal(row.attention, null, 'nobody is asked to do anything about a base the control plane is absorbing');
  assert.deepEqual(row.base!.pending, { baseTip: moved, boundBase: main });
  assert.equal(status.attentionItems.some(item => item.subject === work.key), false);

  const config = { url: 'http://localhost', repository: 'owner/repo', workers: [], autoMerge: false, run: {} } as unknown as MasterConfig;
  const acted: string[] = [];
  const effects = (items: Work[]): DaemonEffects => ({
    closeSession: () => {}, dispatch: async () => ({}), requestProof: () => { acted.push('proof'); }, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => ({}), requestSmoke: () => {}, agents: () => [], credentials: async () => ({}),
    snapshot: async () => ({ work: items, now: new Date().toISOString() }), persist: async () => {},
  });
  const state = emptyDaemonState(config);
  const waiting = await runCycle(config, state, effects((await store.workSnapshot()).work));
  const mine = (cycle: Awaited<ReturnType<typeof runCycle>>) => cycle.actions.filter(action => action.kind === 'refresh' && action.work === work.key);
  const pending = mine(waiting)[0];
  assert.ok(pending, `a cycle that can act reports it: ${JSON.stringify(waiting.actions)}`);
  assert.equal(waiting.metrics.actions > 0, true, 'not "0 actions"');
  assert.match(pending.detail, new RegExp(`${work.key}: base branch moved from ${main.slice(0, 12)} to ${moved.slice(0, 12)} and GitHub reports ${head.slice(0, 12)} conflicting with it`));
  assert.match(pending.detail, /No rework round, no review round and no proof round is requested unless that merge conflicts\./);

  // The loop keeps reporting the same wait once, then reports what the refresh actually did.
  const quiet = await runCycle(config, state, effects((await store.workSnapshot()).work));
  assert.equal(mine(quiet).length, 0, 'the same wait is reported once');
  await onlyJob(work);
  await processJob(engine, adapter(stale, item => refreshRecord(item, { head: refreshedHead, base: moved })).github);
  const done = await runCycle(config, state, effects((await store.workSnapshot()).work));
  const acted2 = mine(done)[0];
  assert.equal(acted2.state, 'done');
  assert.match(acted2.detail, new RegExp(`brought ${head.slice(0, 12)} onto base branch tip ${moved.slice(0, 12)} as ${refreshedHead.slice(0, 12)} with no rework round; kept the approval, unit:rebase, integration:rebase`));
});

test('integration:parallel-candidates-survive-merge — merging one of five in-flight candidates forces no rework round, and no rebuild, on the other four: each keeps its head, its stage, its approval and every proof', async () => {
  const main = sha40('41'), mergedSha = sha40('42');
  const heads = ['43', '44', '45', '46', '47'].map(sha40);
  const items: Work[] = [];
  for (const [index, head] of heads.entries()) {
    let item = await submitted(`Parallel ${index + 1}`);
    // The first is ready to land; the other four are still running a required check.
    item = await validated(item, { sha: head, baseSha: main }, index === 0 ? {} : inFlight());
    items.push(item);
  }
  assert.deepEqual(items.map(item => item.stage), ['merge', 'test', 'test', 'test', 'test']);
  const before = items.map(item => ({ key: item.key, stage: item.stage, evidence: item.evidence.map(entry => entry.id), reviewRequests: item.evidence.length }));

  // The first lands: it publishes the tip it will merge as, then goes through the broker.
  await onlyJob(items[0]);
  await processJob(engine, adapter(item => seen(item, { sha: heads[0], baseSha: main }), null, ownTip).github);
  const landed = await mergeHead(items[0], { sha: heads[0], baseSha: main }, mergedSha);
  assert.equal(landed.stage, 'done');

  for (const [index, item] of items.entries()) {
    if (index === 0) continue;
    const stale = (current: Work) => seen(current, { sha: heads[index], baseSha: main }, inFlight({ baseTip: mergedSha, baseTree: treeOf(mergedSha), baseTipContained: false }));
    let current = await engine.observe(item.id, (await reload(item)).revision, stale(await reload(item)));
    // Nothing moved for this candidate: the tree it was reviewed and proved on is unchanged.
    assert.deepEqual([current.stage, current.candidate!.baseSha], [before[index].stage, main], `${item.key} stayed put`);
    assert.deepEqual([gate(current, 'review').passed, gate(current, 'acceptance').passed], [true, true], `${item.key} kept its approval and proofs`);
    assert.equal(pendingBaseRefresh(current), null, `${item.key} merges cleanly, so nothing waits to rebuild it`);

    // Its reconciliation neither refreshes it nor asks for a review: CI does not run again (GY-292).
    await onlyJob(current);
    const run = adapter(stale, null);
    await processJob(engine, run.github);
    assert.deepEqual([run.refreshed, run.requested, run.published], [[], [], []], `${item.key} was neither rebuilt nor re-reviewed`);
    current = await reload(current);
    assert.deepEqual([current.candidate!.sha, current.candidate!.baseSha, current.baseRefresh ?? null], [heads[index], main, null], `${item.key} kept its head`);
    assert.deepEqual([current.stage, gate(current, 'review').passed, gate(current, 'acceptance').passed], [before[index].stage, true, true], `${item.key} is still in its stage`);
    assert.deepEqual(current.evidence.map(entry => entry.id), before[index].evidence, `${item.key} produced no new evidence`);
  }

  const status = buildMasterStatus(await store.workSnapshot(), [], []);
  const rows = status.work.filter(entry => before.slice(1).some(item => item.key === entry.key));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(row => row.attention), [null, null, null, null], 'a merge raises no attention on the candidates it moved the base under');
});
