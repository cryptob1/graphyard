import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store, save } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server as controlPlane } from '../src/server.js';
import { evaluate, type Principal, type Work } from '../src/model.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { mergeRecordKey, mergeWriterIdle, mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { daemonSummary } from '../src/daemon/run.js';
import type { MergePorts, MergeTrialRun, runMergeTrial } from '../src/merge-writer/executor.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { completionBody } from '../src/cli/complete.js';
import { createWorktree } from '../src/cli/workspace-worktree.js';
import type { CliContext } from '../src/cli/context.js';
import { masterConfigSchema } from '../src/master.js';
import { reconcileReviews, saveReviewLedger } from '../src/reviewer.js';
import { daemonEffects } from '../src/daemon/effects-production.js';
import { routineDecision } from '../src/daemon/decisions.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// Time-bomb allowance (GY-1694): the 2030-05-01 instant is the loop's injected clock and the explicit
// `now` of evaluate(); new Date() only stamps documents the Postgres half writes and reads back.

// GY-2010. The pull-request-era GitHub API client is gone: App credentials, webhooks, caches and
// the request budget. Gates, status and the merge writer read Graphyard's own records. An item
// stored with PR observations still loads; progression is the merge writer's trial and push.

const root = new URL('../', import.meta.url);
const gone = [
  'src/github.ts',
  'src/github-cache.ts',
  'src/github-response-cache.ts',
  'src/github-charges.ts',
  'src/github-permissions.ts',
  'src/github-setup.ts',
  'src/gh-pause.ts',
  'src/cli/github-budget-attention.ts',
  'src/server/routes/github.ts',
  'src/server/push-credential.ts',
  'src/main-guard.ts',
  'src/cli/onboard.ts',
  'src/model/import-plan.ts',
  'src/tip-cleanup.ts',
] as const;

const sha = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const clock = Date.parse('2030-05-01T00:00:00Z');
const now = new Date(clock), at = now.toISOString();

async function sourceFiles(directory: URL): Promise<string[]> {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory()
    ? sourceFiles(new URL(`${entry.name}/`, directory))
    : Promise.resolve(entry.name.endsWith('.ts') ? [new URL(entry.name, directory).pathname] : [])))).flat();
}

test('unit:github-client-removed — the GitHub API client modules are gone, no src file calls api.github.com or mints an App installation token, and the webhook route answers 404', async () => {
  for (const path of gone) assert.equal(existsSync(new URL(path, root)), false, `${path} is deleted`);

  for (const file of await sourceFiles(new URL('src/', root))) {
    const text = await readFile(file, 'utf8');
    assert.doesNotMatch(text, /api\.github\.com/, `${file} must not call api.github.com`);
    assert.doesNotMatch(text, /\/app\/installations\/[^/\s]+\/access_tokens/, `${file} must not request a GitHub App installation token`);
    assert.doesNotMatch(text, /mintPushToken|installationToken\s*\(/, `${file} must not mint an App installation token`);
    // Delegating the request to a subprocess still calls api.github.com: no file runs `gh api` (an
    // argument list that opens with 'api'), whatever the endpoint, GraphQL included.
    assert.doesNotMatch(text, /\[\s*['"]api['"]\s*,/, `${file} must not call GitHub's API through \`gh api\``);
  }
  const { installRequestFromArgs } = await import('../src/install/index.js');
  assert.throws(() => installRequestFromArgs(['--repo', 'owner/project', '--restore-protection', '--plan']), /Unknown option '--restore-protection'/);
  // A pending pull-request reviewer session from before the control-plane merger settles cancelled
  // on the loop's reconcile pass with no GitHub read, so its request is asked again through the control plane.
  const reviewRoot = await temporaryDirectory('github-client-removed-reviews'), calls: string[] = [];
  const legacy = { id: randomUUID(), key: 'GY-1', pr: 7, sha: sha('a1'), baseSha: sha('b1'), policyRevision: 1, profile: 'claude-reviewer', agentName: 'review-claude-1', pane: 'pane-review',
    sessionDirectory: join(reviewRoot, 'session'), requestedAt: at, tokenExpiresAt: new Date(clock + 3_600_000).toISOString(), state: 'pending' as const };
  await saveReviewLedger(reviewRoot, { version: 1, reviews: [legacy] });
  const run: ChildRun = async (command, args) => { calls.push([command, ...args].join(' ')); return '{}'; };
  const settled = await reconcileReviews(reviewRoot, config(), { run, now: () => now, work: [], agents: [] });
  assert.deepEqual(settled.reviews.map(record => record.state), ['cancelled']);
  assert.match(settled.reviews[0].resolution!, /GitHub pull-request reviews are no longer read/);
  assert.deepEqual(calls.filter(call => call.startsWith('gh ')), [], 'the reconcile pass ran no gh command');
  // The pull-request inventory that read them is no command any more.
  const { commands } = await import('../src/cli/index.js');
  assert.equal(commands.some(command => command.name === 'onboard'), false, 'graphyard onboard is not registered');

  // The live control plane registers no GitHub webhook module: a delivery is refused like any unauthenticated API call, and the paths are unknown to an authenticated caller.
  for (const path of ['github/webhook', 'github/installation']) {
    const unsigned = await fetch(`${url}/api/${path}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-hub-signature-256': 'sha256=00' } });
    assert.equal(unsigned.status, 401, `${path} refuses GitHub's delivery`);
    assert.equal((await request(coordinator, path, {})).status, 404, `${path} answers 404 to an authenticated caller`);
  }
});

const repository = 'owner/project';
const operator: Principal = { id: 'operator', role: 'admin' };
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const credentials = [operator, coordinator, worker].map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** A port the deleted GitHub client or shadow gate would have been: any touch fails the case. */
const trap = (what: string) => new Proxy({}, { get: (_, name) => { if (name === 'then') return undefined; throw new Error(`the loop touched ${what} (${String(name)})`); } });

let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof controlPlane>, url: string;
let fixture: string, origin: string, checkout: string, managed: string, deployKey: string, baseTip: string, head: string, workerPushes: string;
const branch = 'graphyard/gy-1-1';

async function commit(cwd: string, path: string, text: string, message: string) {
  await mkdir(join(cwd, path, '..'), { recursive: true });
  await writeFile(join(cwd, path), text); git(cwd, 'add', '--', path); git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

async function request(principal: Principal, path: string, body?: unknown, key: string = randomUUID()) {
  const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  // The origin holds only the base branch; the worker's head sits in the shared object store alone.
  fixture = await realpath(await temporaryDirectory('github-client-removed-repo'));
  origin = join(fixture, 'origin.git'); checkout = join(fixture, 'checkout'); managed = join(fixture, 'managed'); deployKey = join(fixture, 'deploy-key');
  await writeFile(deployKey, 'not a real key: the origin is a local path\n', { mode: 0o600 });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  git(checkout, 'config', 'user.email', 't@example.com'); git(checkout, 'config', 'user.name', 'T');
  await commit(checkout, 'src/a.ts', 'export const a = 1;\n', 'base');
  await commit(checkout, 'tests/a.test.ts', "import { test } from 'node:test';\ntest('unit:a — a answers', () => {});\n", 'test');
  git(checkout, 'push', '-q', 'origin', 'main');
  baseTip = git(checkout, 'rev-parse', 'refs/remotes/origin/main');
  // Origin serves and accepts the base branch alone: every other ref is hidden from fetch, and a push
  // of one is recorded and rejected, so any worker-ref network operation fails the case that ran it.
  workerPushes = join(fixture, 'worker-ref-pushes');
  await writeFile(join(origin, 'hooks', 'pre-receive'), `#!/bin/sh\nwhile read -r _old _new ref; do\n  case "$ref" in refs/heads/main) ;; *) printf '%s\\n' "$ref" >> ${JSON.stringify(workerPushes)}; exit 1 ;; esac\ndone\n`);
  await chmod(join(origin, 'hooks', 'pre-receive'), 0o755);
  git(origin, 'config', 'uploadpack.hideRefs', 'refs'); git(origin, 'config', '--add', 'uploadpack.hideRefs', '!refs/heads/main');
  const tree = join(checkout, '.graphyard', 'worktrees', 'GY-1-1');
  git(checkout, 'worktree', 'add', '-q', '-b', branch, tree, baseTip);
  git(tree, 'config', 'user.email', 't@example.com'); git(tree, 'config', 'user.name', 'T');
  head = await commit(tree, 'src/a.ts', 'export const a = 2;\n', 'change');

  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 2010;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('github-client-removed'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, 120, repository);
  engine.submissionObserver = null; engine.directMergeEnvironment = null;
  engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
  http = controlPlane(engine, credentials, null);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close(); if (database) await database.stop();
});

const config = () => masterConfigSchema.parse({ version: 1, url, credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard', repository, baseBranch: 'main', githubAppId: 1234,
  hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { worktreeRoot: managed, mergeWriter: { deployKeyFile: deployKey, retrials: 2 } } });
const baseEffects = (work: () => Promise<Work[]>, at: () => number) => ({
  agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
  snapshot: async () => ({ work: await work(), now: new Date(at()).toISOString() }),
  closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
  observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(at()).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
  recordDeployment: async () => {}, requestSmoke: () => {}, decisions: async () => ({ decisions: [] }), persist: async () => {},
  github: trap('the GitHub client'), merge: trap('GitHub\'s merge'), shadow: trap('the shadow gate'),
});

test('unit:pr-era-history-loads — a work item whose history carries pull-request observations, PR numbers and GitHub check results loads and evaluates; it progresses through the merge writer\'s trial and merge with no GitHub request; master status shows no Main guard or GitHub budget line', { timeout: 300_000 }, async () => {
  // Submitted as today's workers submit, then rewritten as a release that still observed GitHub left it.
  let work = await engine.execute(operator, 'create', null, { title: 'PR-era history before GY-2010', plannedFiles: ['src/a.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:a'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'worker-host', path: join(checkout, '.graphyard', 'worktrees', 'GY-1-1'), branch }, randomUUID());
  work = await engine.execute(worker, 'submit', work.id, completionBody(['1', '--head', head], () => head), randomUUID());
  assert.equal(work.candidate?.sha, head);
  // Real run ids, as GitHub recorded them: a red required check whose rerun failed too and whose hold expired.
  const githubChecks = [{ name: 'test', result: 'success', appId: 15368, id: 7000 }, { name: 'typecheck', result: 'failure', appId: 15368, id: 7001, attempt: 1 }, { name: 'typecheck', result: 'failure', appId: 15368, id: 7002, attempt: 2 }];
  await store.transaction(async db => {
    const stored: Work & Record<string, unknown> = (await db.query('SELECT document FROM work_items WHERE id=$1 FOR UPDATE', [work.id])).rows[0].document;
    stored.submission = { ...stored.submission!, pr: 2010 };
    stored.candidate = { ...stored.candidate!, pr: 2010 };
    stored.headObserved = { at, pr: 2010, sha: head };
    stored.observation = { ...stored.observation!, checks: githubChecks, reviews: [{ reviewer: 'alice', sha: head, state: 'CHANGES_REQUESTED' }], prState: 'open', draft: false, mergeable: false, protected: true } as Work['observation'];
    stored.mainGuardReverts = [{ mergeSha: sha('e1'), pr: 1999, state: 'merged', revertSha: sha('e2'), failing: ['test'] }];
    stored.checkReruns = [{ sha: head, check: 'typecheck', failedRunId: 7001, state: 'failed', at: new Date(clock - 86_400_000).toISOString() }];
    await save(db, stored, 'github', 'github.observed', now);
  });

  // It loads, with every pull-request-era field intact, and evaluates on Graphyard's records alone.
  const loaded = await store.workItem(work.id) as Work & Record<string, any>;
  assert.equal(loaded.candidate?.pr, 2010, 'the PR number loads');
  assert.equal(loaded.observation?.prState, 'open');
  assert.deepEqual(loaded.observation?.checks, githubChecks, 'GitHub check results load');
  assert.equal(loaded.mainGuardReverts.length, 1, 'main-guard history loads');
  const history = (await store.pool.query('SELECT kind FROM events WHERE work_id=$1 ORDER BY seq', [work.id])).rows.map((row: { kind: string }) => row.kind);
  assert.ok(history.includes('github.observed'), `the stored history carries the GitHub observation: ${history.join(', ')}`);
  const evaluated = evaluate(loaded, [loaded], now);
  const reasons = (name: string) => evaluated.gates.find(gate => gate.name === name)?.reasons ?? [];
  assert.ok(reasons('test').some(reason => /merge writer has not trialled/.test(reason)), `the test gate waits on the merge writer: ${JSON.stringify(evaluated.gates)}`);
  assert.ok(!reasons('test').some(reason => /typecheck|CI check/.test(reason)), 'a PR-era failed check refuses nothing');
  assert.ok(!reasons('merge').some(reason => /mergeable|GitHub|conversation/.test(reason)), 'PR-era mergeability refuses nothing');

  // The real loop and writer: the trial merge in the object store, the leased push, the ledger
  // records through the plane's own route. GitHub is a trap and no `gh` child may run.
  const children: string[][] = [];
  const run: ChildRun = (command, args, options) => { children.push([command, ...args]); return defaultChildRun(command, args, options); };
  const trials: string[] = [];
  const trial = async (input: Parameters<typeof runMergeTrial>[0]): Promise<MergeTrialRun> => {
    trials.push(input.mergeSha);
    return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 5, logTail: 'ok', files: ['tests/a.test.ts'], proofs: Object.fromEntries(input.proofs.map(proof => [proof, { executed: 1, failed: 0 }])) };
  };
  const record: MergePorts['record'] = async (item, event) => {
    const response = await request(coordinator, `work/${item.id}/merge-record`, event, mergeRecordKey(item, event));
    if (response.status >= 300) throw new Error(`merge-record refused (${response.status}): ${JSON.stringify(response.body)}`);
    return response.body;
  };
  const master = config(), state = emptyDaemonState(master);
  const reads = mergeWriterReads(master, checkout, run, { base: managed, record, merger: async () => 'control-plane', trial });
  const effects = { ...baseEffects(async () => [(await store.workDocument(work.id))!], () => clock), mergeWriter: { ...reads, advisory: undefined } } as unknown as DaemonEffects;
  const realFetch = globalThis.fetch, requested: string[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => { const target = String(input instanceof Request ? input.url : input); requested.push(target); return realFetch(input, init); }) as typeof fetch;
  const actions: string[] = [];
  try {
    // Before the writer runs, the stale checks stand over repeated cycles with the decision effects
    // enabled and the production attention path (effects-production.ts) reading the live plane: the
    // loop requests no rework for them and reads no check run back.
    const credentialFile = join(fixture, 'coordinator.token');
    await writeFile(credentialFile, token(coordinator), { mode: 0o600 });
    const production = daemonEffects(checkout, { ...master, credentialFile }, { snapshot: effects.snapshot, run, fetcher: globalThis.fetch,
      mutate: async () => { throw new Error('nothing to mutate'); }, reportReadBoundMs: 5_000 });
    const decided: { action: string; input?: Record<string, unknown>; reason: string }[] = [];
    const deciding = { ...effects, mergeWriter: undefined, controlPlane: production.controlPlane, reportedAttention: production.reportedAttention,
      decide: async (_: Work, action: string, reason: string, input?: Record<string, unknown>) => { decided.push({ action, reason, input }); return { id: randomUUID() }; },
      approver: async () => ({ agentName: 'approver', pane: null }) } as unknown as DaemonEffects;
    for (let cycle = 0; cycle < 3; cycle++) {
      actions.push(...(await runCycle(master, state, deciding, () => clock + cycle * 3_600_000)).actions.map(action => action.detail));
      const stale = (await store.workDocument(work.id))!;
      // Without the stored change request in front of it too: a failed check alone grounds nothing.
      for (const document of [stale, { ...stale, observation: { ...stale.observation!, reviews: [] } } as Work])
        assert.doesNotMatch(String(routineDecision(document, master, clock + cycle * 3_600_000)?.binding ?? ''), /:ci:/, 'no stored failed check grounds a rework');
    }
    const attention = await production.reportedAttention!([(await store.workDocument(work.id))!], await production.controlPlane!(), { agents: [], approvals: daemonSummary(state, clock, 60_000).approvals, loop: daemonSummary(state, clock, 60_000).liveness, now: at });
    assert.ok(Array.isArray(attention.items), 'the production attention path answered');
    assert.ok(!decided.some(entry => /:ci:/.test(String(entry.input?.binding ?? '')) || /required CI check/i.test(entry.reason)), `no rework for a stored failed check: ${JSON.stringify(decided)}`);
    assert.ok(!JSON.stringify(attention).includes('typecheck failed on'), 'no stored check is reported as a timing failure');
    assert.deepEqual(children.filter(([command]) => command === 'gh'), [], `no gh child ran over the stale-check cycles: ${JSON.stringify(children.filter(([command]) => command === 'gh'))}`);
    assert.ok(!children.some(args => args.some(arg => /check-runs|annotations/.test(arg))), 'no check run was read back');
    for (let cycle = 0; cycle < 3 && (await store.workDocument(work.id))!.stage !== 'done'; cycle++) {
      actions.push(...(await runCycle(master, state, effects, () => clock)).actions.map(action => action.detail));
      await mergeWriterIdle(state);
    }
  } finally { globalThis.fetch = realFetch; }

  const done = (await store.workDocument(work.id))!;
  assert.equal(done.stage, 'done', `the PR-era item is delivered by the merge writer: ${JSON.stringify(done.gates)} ${JSON.stringify(state.mergeWriter.refusals ?? null)}`);
  assert.ok(trials.length >= 1, 'the writer ran its trial');
  assert.equal(git(origin, 'rev-parse', 'refs/heads/main'), done.delivery!.mergeSha, 'origin main is the delivered merge commit');
  assert.equal(git(origin, 'rev-parse', `${done.delivery!.mergeSha}^2`), head, 'whose second parent is the submitted head');
  const kinds = (await store.pool.query("SELECT kind FROM events WHERE work_id=$1 AND kind LIKE 'merge.%' ORDER BY seq", [work.id])).rows.map((row: { kind: string }) => row.kind);
  assert.deepEqual(kinds, ['merge.intent', 'merge.trial', 'merge.pushed', 'merge.reconciled'], 'the merge ledger records the whole delivery');
  assert.deepEqual(requested.filter(target => !target.startsWith(url)), [], 'no request left for anywhere but the control plane');
  assert.deepEqual(children.filter(([command]) => command !== 'git'), [], `no child but git ran: ${JSON.stringify(children.filter(([command]) => command !== 'git'))}`);

  // master status: the loop's lines, its run summary and the plane's status carry no Main guard or GitHub budget line.
  const summary = JSON.stringify(daemonSummary(state, clock, 60_000));
  for (const text of [...actions, summary]) assert.doesNotMatch(text, /Main guard|main guard|GitHub (request )?budget|githubBudget/, `no Main guard or GitHub budget line: ${text.slice(0, 300)}`);
  const status = await request(coordinator, 'status');
  assert.equal(status.status, 200);
  for (const field of ['github', 'githubBudget', 'mainGuard', 'webhooks', 'appPermissions']) assert.equal(field in status.body, false, `/api/status reports no ${field}`);
  assert.equal(status.body.mergeWriter.merger, 'control-plane', 'and reports the merge writer');
  for (const path of ['src/master-status.ts', 'src/cli/master-status.ts', 'src/daemon/cycle-delivery.ts']) assert.doesNotMatch(await readFile(new URL(path, root), 'utf8'), /mainGuardAttention|githubBudgetAttention|github-budget-attention/, `${path} raises no Main guard or GitHub budget line`);
});

/** `worktree GY-N EPOCH` as the launcher runs it from the coordinator checkout, against the live plane as the worker. */
async function worktree(id: string, epoch: number): Promise<{ path: string; branch: string }> {
  const subject = await store.workDocument(id), printed: { path: string; branch: string }[] = [];
  const api = async (path: string, body?: unknown, key?: string) => {
    // The fixture's origin is a local path, so the plane's repository name is left out of the identity check.
    if (path === 'status') return { ...(await request(coordinator, 'status')).body, repository: null };
    const response = await request(worker, path, body, key);
    if (response.status >= 300) throw new Error(`${path} refused (${response.status}): ${JSON.stringify(response.body)}`);
    return response.body;
  };
  const cli = { args: [String(epoch)], api, print: (value: { path: string; branch: string }) => printed.push(value), repositoryRoot: () => checkout, individualHostId: () => 'worker-host' } as unknown as CliContext;
  const previous = process.cwd();
  process.chdir(checkout);
  try { await createWorktree(cli, subject); } finally { process.chdir(previous); }
  return printed[0];
}

test('unit:shadow-gate-removed — the shadow gate is gone: its modules and routes are deleted, the loop runs no shadow trial step and touches no shadow port, and its report leaves the run summary', { timeout: 120_000 }, async () => {
  for (const path of ['src/daemon/cycle-shadow.ts', 'src/merge-writer/shadow.ts', 'src/server/shadow-verdict.ts']) assert.equal(existsSync(new URL(path, root)), false, `${path} is deleted`);
  const master = config(), state = emptyDaemonState(master);
  const children: string[][] = [];
  const run: ChildRun = (command, args, options) => { children.push([command, ...args]); return defaultChildRun(command, args, options); };
  const reads = mergeWriterReads(master, checkout, run, { base: managed, record: async () => { throw new Error('nothing to record'); }, merger: async () => 'control-plane', trial: async () => { throw new Error('nothing to trial'); } });
  // A shadow port that throws on any touch: a cycle that ran the old gate fails here.
  const effects = { ...baseEffects(async () => [], () => clock), mergeWriter: { ...reads, advisory: undefined } } as unknown as DaemonEffects;
  await runCycle(master, state, effects, () => clock);
  await mergeWriterIdle(state);
  const steps = state.metrics.flatMap(metric => metric.timings?.steps.map(entry => entry.step) ?? []);
  assert.ok(steps.includes('merge writer'), `the writer's step ran: ${steps.join(', ')}`);
  assert.ok(!steps.includes('shadow gate'), 'no shadow gate step ran');
  assert.ok(!children.some(args => args.some(arg => arg.startsWith('graphyard/') || arg.includes('refs/heads/graphyard/'))), `no worker branch was fetched: ${JSON.stringify(children)}`);
  assert.equal('shadow' in state, false, 'the cursor keeps no shadow verdicts');
  assert.equal('shadowGate' in daemonSummary(state, clock, 60_000), false, 'the run summary has no shadowGate section');
  for (const path of ['work/anything/shadow-verdict', 'shadow-explanations', 'shadow-disagreements']) {
    const response = await request(coordinator, path, path.endsWith('verdict') ? {} : undefined);
    assert.equal(response.status, 404, `${path} answers 404`);
  }
});
