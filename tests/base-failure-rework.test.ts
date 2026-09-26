import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { GitHub, processJob } from '../src/github.js';
import { requestedBaseRefresh, type BaseRefresh } from '../src/merge-queue.js';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { baseFailureAttention } from '../src/daemon/cycle-base-failures.js';
import { type BaseCheck, judgeFailedCheck, parseFailedTests } from '../src/model/base-failure.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Observation, Principal, Work } from '../src/model.js';

// GY-528. 2026-09-26 07:00-07:40Z: integration:instant-exit-classified held a fixed reset time
// against the real clock, so after 07:00Z it failed on main and on every candidate. The loop
// requested rework for nine items in turn, each approver refused it as a failure unrelated to the
// item, and nothing raised the fault against main. After PR #284 repaired main, reruns kept
// failing: a rerun reuses the merge commit the failure was built on. Each test is named for the
// proof it produces.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const minute = 60_000;
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const broken = sha40('b1'), repaired = sha40('b2');
const timeBomb = 'integration:instant-exit-classified — an instant exit is classified';

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [] });
}

/** A submitted candidate built on the broken base whose required `test` check failed in job `job`. */
function candidate(n: number, job: number, observed: { at: number; baseTip?: string; contained?: boolean } = { at: clock }): Work {
  const head = sha40(`a${n}`), pr = 100 + n;
  const observation = {
    clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: broken, pr, branch: `graphyard/gy-${n}-1`, author: 'worker' },
    checks: [{ name: 'test', result: 'failure', appId: 15368, id: job, attempt: 1 }, { name: 'typecheck', result: 'success', appId: 15368, id: job + 1000 }],
    reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, prState: 'open', draft: false,
    baseTip: observed.baseTip ?? broken, baseTree: sha40('7e'), baseTipContained: observed.contained ?? true,
    files: [`src/item-${n}.ts`], scopeFiles: [], at: new Date(observed.at).toISOString(), conversations: { required: true, unresolved: [] },
  } as unknown as Observation;
  return {
    id: `work-${n}`, key: `GY-${n}`, title: `Item ${n}`, description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item'] }], policy: { checks: ['test', 'typecheck'], review: true },
    plannedFiles: [`src/item-${n}.ts`], stage: 'test', revision: 5, policyRevision: 1, createdAt: iso(-4 * 60 * minute), updatedAt: iso(0),
    stageEnteredAt: iso(-30 * minute), ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr },
    candidate: observation.candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null, violations: [],
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'test', passed: false, reasons: ['Required CI check test has not passed on the current candidate'] }],
  } as unknown as Work;
}
const spec = (...tests: string[]) => ['▶ suite', ...tests.map(name => `2030-01-01T11:59:00.1234567Z ✖ ${name} (12.5ms)`), '✔ something that passed (1ms)', 'ℹ fail 1'].join('\n');

/** The world the loop reads outside its coordination transaction, and every effect it asks for. */
interface World {
  work: Work[]; now: number; base: BaseCheck; logs: Record<number, string[]>;
  decided: { key: string; action: string; reason: string }[]; approvers: string[];
  filed: { title: string; description: string; priority: number; key: string }[]; reruns: number[]; refreshes: { key: string; reason: string }[];
}
function world(work: Work[], base: BaseCheck, logs: Record<number, string[]>): World {
  return { work, now: clock, base, logs, decided: [], approvers: [], filed: [], reruns: [], refreshes: [] };
}
function effects(w: World): DaemonEffects {
  return {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: w.work, now: new Date(w.now).toISOString() }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(w.now).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async (work, action, reason) => { w.decided.push({ key: work.key, action, reason }); return { id: randomUUID() }; },
    decisions: async () => ({ decisions: [] }),
    approver: async work => { w.approvers.push(work.key); return { agentName: `graphyard-approver-${work.key.toLowerCase()}`, pane: 'pane-1' }; },
    failedTests: async job => w.logs[job] ?? [],
    baseCheck: async () => w.base,
    rerunJob: async job => { w.reruns.push(job); },
    fileBaseFailure: async (input, key) => { w.filed.push({ title: input.title, description: input.description, priority: input.priority, key }); return { key: `GY-${900 + w.filed.length}` } as Work; },
    refreshCandidate: async (work, reason) => { w.refreshes.push({ key: work.key, reason }); return work; },
    persist: async () => {},
  };
}
const failedBase = (tests: string[]): BaseCheck => ({ check: 'test', baseSha: broken, state: 'failed', jobId: 555, url: 'https://github.com/owner/project/actions/runs/77/job/555', tests });
const passedBase: BaseCheck = { check: 'test', baseSha: repaired, state: 'passed', jobId: 556, url: 'https://github.com/owner/project/actions/runs/78/job/556', tests: null };

test('unit:base-failure-no-rework — a failing test the base head fails too requests no rework and launches no approver; a failure only the candidate has is reworked as before', async () => {
  // The CI log, in the runner's own words: spec and TAP, timestamped as Actions prints them.
  assert.deepEqual(parseFailedTests(spec(timeBomb, 'unit:other — fails')), [timeBomb, 'unit:other — fails']);
  assert.deepEqual(parseFailedTests(['TAP version 13', '    not ok 2 - nested failure', 'not ok 3 - suite', 'not ok 4 - later # TODO', 'ok 5 - fine', '✖ failing tests:'].join('\n')), ['nested failure', 'suite']);
  // The judgement: shared, own, undecidable and pending.
  assert.deepEqual(judgeFailedCheck([timeBomb], failedBase([timeBomb, 'another'])), { kind: 'base', tests: [timeBomb] });
  assert.deepEqual(judgeFailedCheck([timeBomb, 'mine'], failedBase([timeBomb])), { kind: 'own', tests: ['mine'] });
  assert.equal(judgeFailedCheck([timeBomb], passedBase).kind, 'own');
  assert.equal(judgeFailedCheck(null, failedBase([timeBomb])).kind, 'own', 'a failure whose tests cannot be read is reworked as before');
  assert.equal(judgeFailedCheck([timeBomb], { ...failedBase([]), state: 'pending' }).kind, 'pending');

  // GY-1 fails only the time bomb, which the base head fails too; GY-2 fails a test of its own.
  const w = world([candidate(1, 101), candidate(2, 102)], failedBase([timeBomb]), { 101: [timeBomb], 102: ['unit:own-regression — breaks'] });
  const state = emptyDaemonState(config());
  await runCycle(config(), state, effects(w), () => w.now);
  assert.deepEqual(w.decided.map(entry => [entry.key, entry.action]), [['GY-2', 'rework']], 'only the candidate with a failure of its own is sent back');
  assert.match(w.decided[0].reason, /required CI check test failed on candidate/);
  assert.deepEqual(w.approvers, ['GY-2'], 'no approver is launched for the base failure');
  assert.deepEqual(Object.values(state.baseFailures).map(failure => [failure.test, failure.baseSha, failure.blocks.map(block => block.key)]), [[timeBomb, broken, ['GY-1']]]);

  // Against a green base the same failure is the candidate's own, as today.
  const green = world([candidate(1, 101)], passedBase, { 101: [timeBomb] });
  await runCycle(config(), emptyDaemonState(config()), effects(green), () => green.now);
  assert.deepEqual(green.decided.map(entry => [entry.key, entry.action]), [['GY-1', 'rework']]);
  // While the base head's own run is still going, the comparison waits for it rather than asking for a round.
  const pending = world([candidate(1, 101)], { ...failedBase([]), state: 'pending', jobId: null, url: null, tests: null }, { 101: [timeBomb] });
  const waiting = emptyDaemonState(config());
  await runCycle(config(), waiting, effects(pending), () => pending.now);
  assert.deepEqual([pending.decided, pending.approvers], [[], []]);
  assert.match(waiting.actions['wait:base-failure:work-1'].detail, /rework waits for the base head .* to complete its own test run/);
});

/** Run the loop with the base failing the time bomb, then with the base repaired and the candidates observed on it. */
async function repairMain(candidates: number, extraTests: string[] = []) {
  const jobs = Array.from({ length: candidates }, (_, index) => 101 + index);
  const logs = Object.fromEntries(jobs.map(job => [job, [timeBomb, ...extraTests]]));
  const w = world(jobs.map((job, index) => candidate(index + 1, job)), failedBase([timeBomb, ...extraTests]), logs);
  const state = emptyDaemonState(config());
  await runCycle(config(), state, effects(w), () => w.now);
  w.now += minute;
  await runCycle(config(), state, effects(w), () => w.now);
  const standing = baseFailureAttention(Object.values(state.baseFailures), 'main');
  // PR #284 lands: main passes again, and the next observation of each candidate sees the repaired tip it does not contain.
  w.now += 5 * minute; w.base = passedBase;
  w.work = jobs.map((job, index) => candidate(index + 1, job, { at: w.now, baseTip: repaired, contained: false }));
  await runCycle(config(), state, effects(w), () => w.now);
  const cleared = baseFailureAttention(Object.values(state.baseFailures), 'main');
  // Later cycles, before any rerun or refreshed head is observed, repeat nothing and send nothing back.
  for (const _ of [1, 2]) { w.now += minute; await runCycle(config(), state, effects(w), () => w.now); }
  return { w, state, standing, cleared };
}

test('unit:base-failure-raised-once — a base failure blocking three candidates raises one attention item and one P0 item, and once main is green the attention clears and each failed job is rerun once', async () => {
  const { w, state, standing, cleared } = await repairMain(3);
  assert.equal(w.filed.length, 1, 'one item for three blocked candidates, over two cycles');
  const [filed] = w.filed;
  assert.equal(filed.priority, 0, 'P0');
  assert.match(filed.title, new RegExp(timeBomb));
  for (const named of [broken, 'actions/runs/77/job/555', 'GY-1', 'GY-2', 'GY-3']) assert.ok(filed.description.includes(named), `the item names ${named}`);
  assert.match(filed.key, new RegExp(`^base-failure:${broken}:`), 'deduplicated by base head and test name');

  assert.equal(standing.length, 1, 'one attention item while main fails');
  assert.equal(standing[0].subject, 'GY-901');
  assert.equal(standing[0].kind, 'base-failure');
  for (const named of [timeBomb, broken.slice(0, 12), 'actions/runs/77/job/555', 'GY-1, GY-2, GY-3', 'GY-901 (P0)']) assert.ok(standing[0].text.includes(named), `the attention names ${named}`);

  assert.deepEqual(cleared, [], 'the attention clears once main passes');
  assert.deepEqual(w.reruns.sort(), [101, 102, 103], 'each blocked candidate has its failed job rerun, once');
  assert.deepEqual([w.decided, w.approvers], [[], []], 'no rework and no approver at any point');
  assert.deepEqual(state.baseFailures, {}, 'the record retires once every candidate was rerun and refreshed');
});

test('unit:base-failure-refresh-blocked — once main is green each blocked candidate is refreshed onto the repaired base once, and the approval binding survives the refresh', async () => {
  // The loop: three candidates held by two failing tests are each refreshed once, whatever the number of tests or cycles.
  const { w } = await repairMain(3, ['unit:second-casualty — also fails on main']);
  assert.equal(w.filed.length, 2, 'one P0 item per distinct failing test');
  assert.deepEqual(w.refreshes.map(entry => entry.key).sort(), ['GY-1', 'GY-2', 'GY-3'], 'one refresh per blocked candidate');
  assert.match(w.refreshes[0].reason, /a rerun reuses the merge commit the failure was built on, so the repaired base is merged into the branch/);
  assert.deepEqual(w.reruns.sort(), [101, 102, 103], 'and one rerun per failed job');

  // A candidate observed only on the broken tip is not refreshed yet: its observation names no repaired base to merge in.
  const unobserved = world([candidate(1, 101)], failedBase([timeBomb]), { 101: [timeBomb] });
  const state: DaemonState = emptyDaemonState(config());
  await runCycle(config(), state, effects(unobserved), () => unobserved.now);
  unobserved.base = passedBase; unobserved.now += minute;
  await runCycle(config(), state, effects(unobserved), () => unobserved.now);
  assert.deepEqual([unobserved.refreshes, unobserved.decided], [[], []]);
  assert.equal(Object.keys(state.baseFailures).length, 1, 'the cleared record waits for the observation');
  unobserved.work = [candidate(1, 101, { at: unobserved.now + minute, baseTip: repaired, contained: false })]; unobserved.now += 2 * minute;
  await runCycle(config(), state, effects(unobserved), () => unobserved.now);
  assert.deepEqual(unobserved.refreshes.map(entry => entry.key), ['GY-1']);
});

// ---- The control plane: the refresh command, the reconciliation job and the carry ---------------

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const producer: Principal = { id: 'ci-runner', role: 'producer', proofs: ['unit:repair'] };
let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_BASE_FAILURE_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 528);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-base-failure-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.controlPlaneAppId = 1234;
  engine.principals = [operator, worker, coordinator, producer];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const treeOf = (sha: string) => sha40(`7${sha.slice(0, 2)}`);
const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
const gate = (work: Work, name: string) => work.gates.find(entry => entry.name === name)!;
function seen(work: Work, candidate: { sha: string; baseSha: string }, extra: Partial<Observation> = {}): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { ...candidate, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'failure', appId: 15368, id: 101 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [{ id: 41, reviewer: 'graphyard-reviewer[bot]', sha: candidate.sha, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: treeOf(candidate.baseSha), baseTipContained: true,
    files: ['src/repair.ts'], scopeFiles: [], at: new Date().toISOString(), ...extra };
}
/** The real provider refresh over a fake request surface: main sits at `tip`, and every write is recorded. */
function provider(work: Work, tip: string, merged: string) {
  const writes: { method: string; path: string; body: any }[] = [];
  const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used-in-adapter-test' });
  github.controlPlaneLogin = async () => 'graphyard-owner-project[bot]';
  github.request = async (path, method = 'GET', body) => {
    if (method !== 'GET') writes.push({ method, path, body });
    if (path === '/merges') return { sha: merged };
    if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: tip } };
    if (path === `/commits/${merged}`) return { sha: merged, commit: { tree: { sha: treeOf(merged) } }, author: { login: 'graphyard-owner-project[bot]', type: 'Bot' }, parents: [{ sha: work.candidate!.sha }, { sha: tip }] };
    if (/^\/commits\/[a-f0-9]{40}$/.test(path)) return { sha: path.slice(9), commit: { tree: { sha: treeOf(path.slice(9)) } }, parents: [] };
    // The repair touched only the test that failed on main; the candidate's own diff is unchanged by the merge.
    if (path === `/compare/${work.candidate!.baseSha}...${tip}`) return { status: 'ahead', files: [{ filename: 'tests/auto-dispatch.test.ts' }] };
    if (path.startsWith('/compare/')) return { status: 'ahead', files: [{ filename: 'src/repair.ts', patch: '@@ -1 +1 @@\n-old\n+new' }] };
    if (path === `/pulls/${work.submission!.pr}`) return { number: work.submission!.pr, head: { sha: work.candidate!.sha, ref: work.workspaces[0].branch }, base: { ref: 'main' }, state: 'open', draft: false };
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  return { github, writes };
}
function adapter(observation: (work: Work) => Observation, refresh: GitHub) {
  const called: string[] = [];
  return { called, github: {
    observe: async (work: Work) => observation(work),
    refreshCandidateBase: (work: Work, guard: () => Promise<void>) => { called.push('refreshCandidateBase'); return refresh.refreshCandidateBase(work, guard); },
    restoreBranch: async () => { throw new Error('no restore expected'); },
    publishSpeculativeTip: async () => { throw new Error('no tip expected'); },
    requestCodex: async () => { throw new Error('no review request expected'); },
    publish: async () => {},
  } as unknown as GitHub };
}
async function onlyJob(work: Work) {
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [work.id]);
}

test('unit:base-failure-refresh-blocked — the control plane merges the repaired base into a candidate the coordinator names, once, as its own App, and the approval carries onto the refreshed head', async () => {
  const head = sha40('c1'), refreshed = sha40('c2');
  let work = await engine.execute(operator, 'create', null, { title: 'Blocked by main', plannedFiles: ['src/repair.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:repair'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/base-failure/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-1` }, randomUUID());
  work = await engine.execute(worker, 'submit', work.id, { epoch: 1, pr: 528 }, randomUUID());
  work = await engine.observe(work.id, work.revision, seen(work, { sha: head, baseSha: broken }));
  work = await engine.execute(producer, 'evidence', work.id, { proof: 'unit:repair', sha: head, baseSha: broken, policyRevision: 1, result: 'pass', executed: 2, skipped: 0, exercise: { behaviour: 'the repair', result: 'fail', executed: 1 }, scopeFiles: ['src/repair.ts'] }, randomUUID());
  assert.equal(gate(work, 'review').passed, true, 'approved on its own head; only the base failure holds it');

  // Main is repaired; GitHub reports the candidate clean against it, so no conflict would ever refresh it.
  const behind = (item: Work) => seen(item, { sha: head, baseSha: broken }, { baseTip: repaired, baseTree: treeOf(repaired), baseTipContained: false });
  work = await engine.observe(work.id, work.revision, behind(work));
  const reason = 'main passes the time bomb again; a rerun reuses the old merge commit';
  await assert.rejects(engine.execute(worker, 'refresh', work.id, { reason, base: repaired }, randomUUID()), /Coordinator permission required/);
  await assert.rejects(engine.execute(coordinator, 'refresh', work.id, { reason, base: broken }, randomUUID()), /retry once it is observed/);
  work = await engine.execute(coordinator, 'refresh', work.id, { reason, base: repaired }, randomUUID());
  assert.deepEqual([work.baseRefreshRequest?.head, work.baseRefreshRequest?.base, work.baseRefreshRequest?.by], [head, repaired, 'master']);
  assert.ok(requestedBaseRefresh(work));
  await assert.rejects(engine.execute(coordinator, 'refresh', work.id, { reason, base: repaired }, randomUUID()), /already requested/);

  // The reconciliation job merges main into the branch as the control-plane App.
  const main = provider(work, repaired, refreshed);
  await onlyJob(work);
  const job = adapter(behind, main.github);
  await processJob(engine, job.github);
  assert.deepEqual(job.called, ['refreshCandidateBase']);
  assert.deepEqual(main.writes.map(write => [write.method, write.path, write.body?.base, write.body?.head]), [['POST', '/merges', work.workspaces[0].branch, repaired]], 'one merge of the repaired base into the candidate branch, nothing else');
  work = await reload(work);
  assert.deepEqual([work.baseRefresh!.head, work.baseRefresh!.base, work.baseRefresh!.trigger, work.baseRefresh!.requested?.by, work.baseRefreshRequest ?? null], [refreshed, repaired, 'base failure repaired', 'master', null]);
  const carry = (work.baseRefresh as BaseRefresh).carry!;
  assert.equal(carry.approval.carried, true, 'the approval carries under the existing rule');
  assert.equal(carry.to.sha, refreshed);

  // Made once: another pass of the job, and the command again, do nothing.
  await onlyJob(work);
  const again = adapter(behind, main.github);
  await processJob(engine, again.github);
  assert.deepEqual([again.called, main.writes.length], [[], 1]);
  await assert.rejects(engine.execute(coordinator, 'refresh', work.id, { reason, base: repaired }, randomUUID()), /already recorded/);

  // The refreshed head is what binds now, and the approval binding survived: no fresh review round.
  work = await reload(work);
  work = await engine.observe(work.id, work.revision, seen(work, { sha: refreshed, baseSha: repaired }, { reviews: [], checks: [{ name: 'test', result: 'in_progress', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }] }));
  assert.deepEqual([work.candidate!.sha, work.candidate!.baseSha], [refreshed, repaired]);
  assert.equal(gate(work, 'review').passed, true, 'the carried approval binds the refreshed head');
});
