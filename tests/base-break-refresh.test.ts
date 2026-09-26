import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { CHECK_NAME, GitHub, processJob } from '../src/github.js';
import type { BaseRefresh } from '../src/merge-queue.js';
import { Refusal, type Observation, type Principal, type Work } from '../src/model.js';
import { actionAccount } from '../src/model/next-action.js';
import { buildMasterStatus, masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, failedCheckRework, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { nameBaseBreaks } from '../src/cli/status-attention.js';
import { baseBreakHold, baseBreakRefreshNeeded, describeBaseBreak, failedTestsAnnotation, failedTestsFromLog, judgeBaseBreak, parseFailedTests, wakeOwnObservation, type BaseBreak } from '../src/master/base-break-refresh.js';

// GY-793. On 2026-09-26 main was briefly broken; every candidate whose CI ran in that window failed
// `test` on the one broken test, the approvers refused the rework, and nothing brought them onto
// the fixed main. Each test is named for the proof it produces.

const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const treeOf = (sha: string) => sha40(`7${sha.slice(0, 2)}`);
const broken = 'tests/hotspots.test.ts › unit:hotspot-registry — the former hotspot files stay within their size budgets';
const own = 'tests/queue.test.ts › queue keeps order';

/** The spec reporter's tail for a run that failed `names`, exactly as node --test prints it piped. */
const specLog = (names: string[]) => ['ℹ tests 12', 'ℹ pass 10', `ℹ fail ${names.length}`, '', '✖ failing tests:', '',
  ...names.flatMap((name, index) => { const [file, title] = name.split(' › '); return [`test at ${file}:${40 + index}:1`, `✖ ${title} (12.5ms)`, '  AssertionError [ERR_ASSERTION]: budget', '      at TestContext.<anonymous> (file:///x.ts:1:1)', '']; })].join('\n');
/** The annotation GitHub returns for the CI command the report step prints. */
const annotationOf = (names: string[]) => {
  const command = failedTestsAnnotation(names)!;
  return { message: command.slice(command.indexOf('::', 2) + 2).replace(/%0A/g, '\n').replace(/%0D/g, '\r').replace(/%25/g, '%') };
};

test('unit:base-break-refresh — CI names every failed test on its check run, and only a head whose failures all fail on the base it was built against and pass on the tip is a base breakage', () => {
  // The CI half: the report step reads the suite's log and publishes one annotation naming each failed test.
  assert.deepEqual(failedTestsFromLog(specLog([broken, own])), [broken, own].sort());
  assert.equal(failedTestsFromLog('npm ERR! install failed'), null, 'a run that never reported names no test');
  assert.deepEqual(parseFailedTests([{ message: 'unrelated' }, annotationOf([broken])]), [broken], 'the observation reads the names back');

  const head = sha40('a1'), built = sha40('b1'), tip = sha40('b2');
  const at = '2026-09-26T12:00:00.000Z';
  const reading = (headFailed: string[] | null, builtFailed: string[] | null, tipRun: { conclusion: string | null; failed: string[] | null }) =>
    [{ check: 'test', head: { sha: head, conclusion: 'failure', failed: headFailed }, built: { sha: built, conclusion: builtFailed ? 'failure' : 'success', failed: builtFailed }, tip: { sha: tip, ...tipRun } }];
  // The history: `broken` fails on the base the candidate was built against, and the tip fixed it.
  assert.deepEqual(judgeBaseBreak(['test'], reading([broken], [broken], { conclusion: 'success', failed: null }), at),
    { head, builtOn: built, fixedBy: tip, checks: [{ check: 'test', tests: [broken] }], at });
  // A tip that still fails, but on something else, still fixed this test.
  assert.ok(judgeBaseBreak(['test'], reading([broken], [broken, own], { conclusion: 'failure', failed: [own] }), at));
  // Everything else is the candidate's own, or not known well enough to act on.
  assert.equal(judgeBaseBreak(['test'], reading([broken, own], [broken], { conclusion: 'success', failed: null }), at), null, 'a failure the base does not share is the worker\'s');
  assert.equal(judgeBaseBreak(['test'], reading([broken], [broken], { conclusion: 'failure', failed: [broken] }), at), null, 'a tip that still fails it fixed nothing');
  assert.equal(judgeBaseBreak(['test'], reading([broken], [broken], { conclusion: null, failed: null }), at), null, 'a tip whose run has not completed proves nothing yet');
  assert.equal(judgeBaseBreak(['test'], reading(null, [broken], { conclusion: 'success', failed: null }), at), null, 'a run that named no test is never a base breakage');
  assert.equal(judgeBaseBreak(['test', 'typecheck'], reading([broken], [broken], { conclusion: 'success', failed: null }), at), null, 'every failed required check must be explained');
});

// ---- Provider adapter: the real GitHub client over a fake request surface ----------------------

const PR = 93;
function provider(options: { head: string; built: string; tip: string; runs: Record<string, { id: number; conclusion: string; failed?: string[] }> }) {
  const calls: { path: string; method: string; body: any }[] = [];
  let mergeResult: { sha: string } | 'conflict' | null = null;
  const pr: any = { number: PR, head: { sha: options.head, ref: 'graphyard/gy-93-1', repo: { full_name: 'owner/repo' } },
    base: { sha: options.built, ref: 'main', repo: { full_name: 'owner/repo' } },
    user: { login: 'implementer' }, merged: false, mergeable: true, draft: false, state: 'open', merge_commit_sha: null };
  const github = new GitHub({ repository: 'owner/repo', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used-in-adapter-test' });
  github.controlPlaneLogin = async () => 'graphyard-owner-repo[bot]';
  const run = (sha: string) => options.runs[sha];
  github.request = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (path === '/merges' && method === 'POST') {
      if (mergeResult === 'conflict') throw new Refusal('GitHub POST /merges failed (409)', 502);
      return mergeResult;
    }
    if (method !== 'GET') return { id: 12 };
    if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: options.tip } };
    if (/^\/commits\/[a-f0-9]{40}$/.test(path)) { const sha = path.slice(9); return { sha, commit: { tree: { sha: treeOf(sha) }, author: { email: 'noreply@github.com' } }, parents: [], author: null }; }
    if (path.startsWith('/compare/')) { const [from, to] = path.slice(9).split('?')[0].split('...'); return { status: from === to ? 'identical' : from === options.built && to === options.tip ? 'ahead' : 'diverged', files: [] }; }
    if (path === `/pulls/${PR}`) return structuredClone(pr);
    if (path.includes('/protection')) return { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
    if (path.includes('/reviews')) return [{ id: 41, user: { login: 'graphyard-reviewer[bot]' }, commit_id: options.head, state: 'APPROVED' }];
    if (path.includes('/files')) return [{ filename: 'src/queue.ts', status: 'modified', sha: sha40('cc'), additions: 4, deletions: 1 }];
    const annotations = /^\/check-runs\/(\d+)\/annotations/.exec(path);
    if (annotations) { const found = Object.values(options.runs).find(entry => entry.id === Number(annotations[1])); return found?.failed ? [{ message: 'Process completed with exit code 1.' }, annotationOf(found.failed)] : []; }
    const runs = /^\/commits\/([a-f0-9]{40})\/check-runs/.exec(path);
    if (runs) { const found = run(runs[1]); return { check_runs: found ? [{ id: found.id, name: 'test', status: 'completed', conclusion: found.conclusion, app: { id: 15368 } }] : [] }; }
    throw new Error(`Unexpected request ${path}`);
  };
  const work = { id: 'gy-93', key: 'GY-93', policy: { review: true, checks: ['test'] }, plannedFiles: ['src/queue.ts'],
    submission: { pr: PR, epoch: 1 }, candidate: { sha: options.head, baseSha: options.built, pr: PR, branch: 'graphyard/gy-93-1', author: 'implementer' },
    policyRevision: 1, revision: 3, reworkRequested: false, gates: [], violations: [], evidence: [], observation: null, stage: 'test', blocker: null } as unknown as Work;
  return { github, work, calls, merges: (result: { sha: string } | 'conflict' | null) => { mergeResult = result; } };
}

test('unit:base-break-refresh — the observation reads the breakage from the head, the base it was built against and the tip, and the refresh merges the fixed tip into the candidate\'s own branch', async () => {
  const head = sha40('a1'), built = sha40('b1'), tip = sha40('b2'), refreshed = sha40('a2');
  const f = provider({ head, built, tip, runs: { [head]: { id: 501, conclusion: 'failure', failed: [broken] }, [built]: { id: 502, conclusion: 'failure', failed: [broken] }, [tip]: { id: 503, conclusion: 'success' } } });
  const observation = await f.github.observe(f.work);
  assert.equal(observation.baseTipContained, false);
  assert.deepEqual(observation.baseBreak && { ...observation.baseBreak, at: null }, { head, builtOn: built, fixedBy: tip, checks: [{ check: 'test', tests: [broken] }], at: null });
  const work = { ...f.work, observation, candidate: observation.candidate } as Work;
  assert.ok(baseBreakRefreshNeeded(work));

  f.merges({ sha: refreshed });
  const refresh = await f.github.refreshOntoFixedBase(work, observation.baseBreak!);
  assert.deepEqual([refresh.from, refresh.base, refresh.head, refresh.conflict, refresh.trigger], [{ sha: head, baseSha: built }, tip, refreshed, null, 'base breakage']);
  assert.deepEqual(refresh.baseBreak, observation.baseBreak, 'the refresh records why');
  assert.deepEqual(f.calls.find(call => call.path === '/merges')!.body.base, 'graphyard/gy-93-1', 'the tip is merged into the candidate\'s own branch, as the merge queue does');
  assert.equal(f.calls.find(call => call.path === '/merges')!.body.head, tip);

  // A head that also fails a test of its own is left to its worker: nothing is recorded.
  const mixed = provider({ head, built, tip, runs: { [head]: { id: 601, conclusion: 'failure', failed: [broken, own] }, [built]: { id: 602, conclusion: 'failure', failed: [broken] }, [tip]: { id: 603, conclusion: 'success' } } });
  assert.equal((await mixed.github.observe(mixed.work)).baseBreak, undefined);
});

// ---- Engine integration: a real Postgres, a stubbed provider ----------------------------------

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
const producer: Principal = { id: 'ci-runner', role: 'producer', proofs: ['unit:rebase'] };
let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_BASE_BREAK_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 793);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-base-break-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.controlPlaneAppId = 1234;
  engine.principals = [operator, worker, producer];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const loopConfig = (): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
function loopEffects(work: () => Work[], decided: { action: string; reason: string }[], extra: Partial<DaemonEffects> = {}): DaemonEffects {
  return { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: work(), now: new Date().toISOString(), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async (_work, action, reason) => { decided.push({ action, reason }); return { id: randomUUID() }; },
    decisions: async () => ({ decisions: [] }), approver: async () => ({ agentName: 'graphyard-approver-gy', pane: 'pane-1' }), persist: async () => {}, ...extra };
}

test('unit:base-break-refresh — a candidate whose only failing test also fails on its old base and passes on the new tip is refreshed onto that tip, carrying its approval and proof, and no rework is requested', async () => {
  const main = sha40('11'), fixed = sha40('12'), head = sha40('13'), refreshedHead = sha40('14');
  let work = await engine.execute(operator, 'create', null, { title: 'Held by a base breakage', plannedFiles: ['src/queue.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:rebase'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/base-break/${work.id}`, branch: 'graphyard/gy-1-1' }, randomUUID());
  work = await engine.execute(worker, 'submit', work.id, { epoch: 1, pr: 930 }, randomUUID());
  const found: BaseBreak = { head, builtOn: main, fixedBy: fixed, checks: [{ check: 'test', tests: [broken] }], at: new Date().toISOString() };
  const seen = (item: Work): Observation => ({ clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: main, pr: 930, branch: item.workspaces[0].branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'failure', appId: 15368, id: 501 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [{ id: 41, reviewer: 'graphyard-reviewer[bot]', sha: head, state: 'APPROVED' }], protected: true, mergeable: true, merged: false, mergeSha: null,
    prState: 'open', draft: false, baseTip: fixed, baseTree: treeOf(fixed), baseTipContained: false, files: ['src/queue.ts'], scopeFiles: [], at: new Date().toISOString(), baseBreak: found });
  work = await engine.observe(work.id, work.revision, seen(work));
  work = await engine.execute(producer, 'evidence', work.id, { proof: 'unit:rebase', sha: head, baseSha: main, policyRevision: 1, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 }, scopeFiles: ['src/queue.ts'] }, randomUUID());
  assert.deepEqual(work.gates.find(gate => gate.name === 'test')!.reasons, ['Required CI check test has not passed on the current candidate']);

  // Nobody is asked for a new head: not the rework rule, not the next action, not the loop.
  assert.deepEqual(baseBreakHold(work), found);
  assert.equal(failedCheckRework(work), null, 'the failed check asks for no rework');
  const account = actionAccount(work, [work], new Date());
  assert.equal(account.action, null, 'no request-rework action is named');
  assert.deepEqual([account.wait?.kind, account.wait?.on], ['session', 'graphyard']);
  const decided: { action: string; reason: string }[] = [];
  const snapshot = (await store.workSnapshot()).work;
  await runCycle(loopConfig(), emptyDaemonState(loopConfig()), loopEffects(() => snapshot, decided));
  assert.deepEqual(decided, [], 'the loop requests no rework decision');

  // The observation job brings it onto the fixed tip, the same refresh the merge queue makes.
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [work.id]);
  const refreshed: string[] = [];
  const adapter = { observe: async (item: Work) => seen(item), publish: async () => {},
    refreshCandidateBase: async () => { throw new Error('a clean candidate is not refreshed for a conflict'); },
    refreshOntoFixedBase: async (item: Work, breakage: BaseBreak): Promise<BaseRefresh> => {
      refreshed.push(item.key);
      return { from: { sha: head, baseSha: main }, base: fixed, baseTree: treeOf(fixed), policyRevision: 1, at: new Date().toISOString(), head: refreshedHead, conflict: null,
        merge: { from: head, parents: [head, fixed], author: 'graphyard[bot]', authoredByApp: true, conflicts: false, baseChanges: ['tests/hotspots.test.ts'] }, carry: null, trigger: 'base breakage', baseBreak: breakage };
    },
    requestCodex: async () => { throw new Error('no review request expected'); } } as unknown as GitHub;
  await processJob(engine, adapter);
  assert.deepEqual(refreshed, [work.key]);
  work = await reload(work);
  assert.deepEqual([work.baseRefresh!.trigger, work.baseRefresh!.head, work.baseRefresh!.base], ['base breakage', refreshedHead, fixed]);
  assert.deepEqual(work.baseRefresh!.baseBreak, found, 'the record says why');
  assert.equal(work.baseRefresh!.carry!.approval.carried, true, 'the approval carries as the refresh policy keeps it');
  assert.deepEqual(work.baseRefresh!.carry!.evidence.map(entry => [entry.proof, entry.carried]), [['unit:rebase', true]]);
  const ledger = (await store.events(work.id)).filter(event => event.kind === 'base.refreshed');
  assert.equal(ledger.at(-1)!.payload.details.trigger, 'base breakage');
  assert.equal(work.reworkRequested, false);
  assert.equal(baseBreakRefreshNeeded(work), null, 'the refresh is never repeated for the same head and tip');
});

// ---- AC-2: a decision gated on a fresh observation wakes it --------------------------------------

test('unit:decision-wakes-own-observation — a rework decision waiting on a stale observation wakes the item\'s observation and is requested within one observation, in the same cycle', async () => {
  const reviewed = sha40('c1'), base = sha40('c2');
  const item = (observedAt: string): Work => ({
    id: 'work-42', key: 'GY-42', title: 'Wake your own reading', description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:loop'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/loop.ts'], stage: 'review', revision: 5, policyRevision: 1, createdAt: observedAt, updatedAt: observedAt,
    stageEnteredAt: observedAt, ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: 42 },
    candidate: { sha: reviewed, baseSha: base, pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [],
    observation: { clockOffset: { min: 0, max: 0 }, candidate: { sha: reviewed, baseSha: base, pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' },
      checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'independent-reviewer', sha: reviewed, state: 'CHANGES_REQUESTED' }],
      protected: true, mergeable: true, merged: false, mergeSha: null, files: ['src/loop.ts'], scopeFiles: [], at: observedAt } as Observation,
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }],
  } as Work);
  const now = Date.now();
  const stale = item(new Date(now - 10 * 60_000).toISOString());
  const woken: string[] = [], decided: { action: string; reason: string }[] = [];
  let reading: string | null = null;
  const effects = loopEffects(() => [stale], decided, { observe: async work => { woken.push(work.key); reading = new Date().toISOString(); return item(reading); } });
  await runCycle(loopConfig(), emptyDaemonState(loopConfig()), effects, () => now);
  assert.deepEqual(woken, ['GY-42'], 'the decision step woke the item\'s own observation');
  assert.equal(decided.length, 1, 'the rework was requested in the same cycle, not on the next one');
  assert.equal(decided[0].action, 'rework');
  assert.ok(decided[0].reason.includes(reading!), 'decided from the reading the wake produced');

  // The wake is the same `resync` the executor runs: it returns once a reading newer than the wake lands.
  const bodies: unknown[] = [];
  let polls = 0;
  const fresh = item(new Date().toISOString());
  const landed = await wakeOwnObservation(async body => { bodies.push(body); return ++polls < 3 ? { observed: false } : { observed: true, work: fresh }; }, async () => {}, { pollMs: 1, waitMs: 10 });
  assert.equal(landed, fresh);
  assert.equal((bodies[0] as { wake?: boolean }).wake, undefined, 'the first call wakes the job');
  assert.deepEqual(bodies.slice(1).map(body => (body as { wake?: boolean }).wake), [false, false], 'later calls only read');
  // No reading within the wait: the decision waits as before, naming the stale observation.
  assert.equal(await wakeOwnObservation(async () => ({ observed: false }), async () => {}, { pollMs: 1, waitMs: 3 }), null);
  const unanswered: { action: string; reason: string }[] = [];
  const waited = await runCycle(loopConfig(), emptyDaemonState(loopConfig()), loopEffects(() => [stale], unanswered, { observe: async () => null }), () => now);
  assert.deepEqual(unanswered, []);
  assert.match(waited.actions.find(action => action.work === 'GY-42' && action.kind === 'decision')!.detail, /rework waits for a fresh GitHub observation/);
});

// ---- AC-3: master status names the breakage --------------------------------------------------------

test('unit:base-break-named — master status names a candidate held only by a base breakage with the failing test, the base commit that broke it and the one that fixed it, never as needing a new head', async () => {
  const main = sha40('21'), fixed = sha40('22'), head = sha40('23');
  const found: BaseBreak = { head, builtOn: main, fixedBy: fixed, checks: [{ check: 'test', tests: [broken] }], at: new Date().toISOString() };
  const hours = (count: number) => new Date(Date.now() - count * 3_600_000).toISOString();
  const work = { id: 'work-7', key: 'GY-7', title: 'Held', description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:x'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/x.ts'], stage: 'test', revision: 5, policyRevision: 1, createdAt: hours(4), updatedAt: hours(3), stageEnteredAt: hours(3),
    ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: 7 }, candidate: { sha: head, baseSha: main, pr: 7, branch: 'graphyard/gy-7-1', author: 'worker' },
    reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [],
    observation: { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: main, pr: 7, branch: 'graphyard/gy-7-1', author: 'worker' }, checks: [{ name: 'test', result: 'failure', appId: 15368 }],
      reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, prState: 'open', draft: false, baseTip: fixed, baseTipContained: false, files: ['src/x.ts'], scopeFiles: [], at: new Date().toISOString(), baseBreak: found },
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] }, { name: 'test', passed: false, reasons: ['Required CI check test has not passed on the current candidate'] }],
  } as unknown as Work;
  const status = nameBaseBreaks(buildMasterStatus({ work: [work], now: new Date().toISOString() }, [], []), [work]);
  const row = status.work.find(entry => entry.key === 'GY-7')!;
  for (const text of [row.refusal!.reason, row.attention!]) {
    assert.ok(text.includes(broken), `names the failing test: ${text}`);
    assert.ok(text.includes(`base commit ${main.slice(0, 12)} that broke it`), `names the base commit that broke it: ${text}`);
    assert.ok(text.includes(`base tip ${fixed.slice(0, 12)} that fixed it`), `names the commit that fixed it: ${text}`);
    assert.match(text, /held only by a base-branch breakage/);
    assert.doesNotMatch(text, /needs a new head/);
  }
  assert.equal(row.attentionOwner!.role, 'control plane');
  const item = status.attentionItems.find(entry => entry.subject === 'GY-7');
  if (item) assert.equal(item.text, describeBaseBreak('GY-7', found));
  // The next action says the same, not "needs a new head".
  const account = actionAccount(work, [work], new Date());
  assert.equal(account.wait!.detail, describeBaseBreak('GY-7', found));
  assert.doesNotMatch(account.wait!.detail, /needs a new head/);
});
