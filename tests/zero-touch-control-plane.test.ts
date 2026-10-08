import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { daemonEffects } from '../src/daemon/effects.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { mergeRecordKey, mergeWriterIdle, mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { deployKeySshCommand, type MergePorts, type MergeTrialRun, type runMergeTrial } from '../src/merge-writer/executor.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { appendGoal, applyGoalCommand, type Goal } from '../src/model/goal.js';
import { masterConfigSchema } from '../src/master.js';
import { completionBody } from '../src/cli/complete.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import type { Principal, Work } from '../src/model.js';
import type { UpDependencies, UpEvent } from '../src/up.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1554 (child of GY-1527): `graphyard up --agent --goal FILE --merger control-plane` with no
 * human anywhere. The control plane is real (Postgres, the HTTP server, the engine reading heads
 * from a git checkout of a bare origin, no GitHub App configured); the host's installer, the
 * agent runtimes and the build/test trial are stubbed. The goal `up` submits is planned, a stub
 * worker commits the first planned item and submits it, and the merge writer lands it on the bare
 * origin: main's first parent is the merge commit the item was delivered with. Nothing in the run
 * waits on a person, opens a browser or touches GitHub.
 */
const repository = 'owner/project';
const operatorAgent: Principal = { id: 'graphyard-master-operator', role: 'admin', sessionKind: 'ai' };
const approver: Principal = { id: 'graphyard-approver', role: 'admin', sessionKind: 'ai' };
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const credentials = [operatorAgent, approver, coordinator, worker].map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
const githubDouble = new Proxy({}, { get: (_, name) => { throw new Error(`the zero-touch run called GitHub (${String(name)})`); } });

let pg: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
let fixtureRoot: string, origin: string, checkout: string, worktreeBase: string, baseTip: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function commit(cwd: string, path: string, text: string, message: string) {
  await mkdir(join(cwd, path, '..'), { recursive: true });
  await writeFile(join(cwd, path), text); git(cwd, 'add', '--', path); git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}
async function freePort() {
  const probe = createServer();
  await new Promise<void>(accept => probe.listen(0, '127.0.0.1', accept));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(accept => probe.close(() => accept()));
  return port;
}

before(async () => {
  fixtureRoot = await realpath(await temporaryDirectory('zero-touch'));
  origin = join(fixtureRoot, 'origin.git'); checkout = join(fixtureRoot, 'checkout'); worktreeBase = join(fixtureRoot, 'managed');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  git(checkout, 'config', 'user.email', 't@example.com'); git(checkout, 'config', 'user.name', 'T');
  await commit(checkout, 'README.md', '# Fixture\n', 'base');
  await commit(checkout, 'tests/app.test.ts', "import { test } from 'node:test';\ntest('unit:app-works — the app answers', () => {});\n", 'test');
  git(checkout, 'push', '-q', 'origin', 'main');
  baseTip = git(checkout, 'rev-parse', 'refs/remotes/origin/main');
  const port = await freePort();
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('zero-touch-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('zero_touch_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/zero_touch_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null; engine.directMergeEnvironment = null;
  engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
  // The server as src/server/main.ts starts it without GITHUB_APP_ID: no GitHub at all.
  http = server(engine, credentials, null);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (pg) await pg.stop(); if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });

async function request(principal: Principal, path: string, body?: unknown, key: string = randomUUID(), method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let parsed: any = text; try { parsed = JSON.parse(text); } catch { /* the plane answered text */ }
  if (response.status >= 300) throw new Error(`${method} /api/${path} refused (${response.status}): ${text}`);
  return parsed;
}

/** The host `up` runs on: installer, agent accounts and loop are simulated; the goal and the merger setting reach the real plane. */
function host(checkoutDir: string, events: UpEvent[]) {
  const calls: string[][] = [], ghCalls: string[][] = [], deployKeys: string[] = [];
  let installed = false, accounts = false, loop = false, clock = 0;
  const installDir = join(checkoutDir, 'install-dir');
  const deps: UpDependencies = {
    root: checkoutDir, pollMs: 1, emit: event => { events.push(event); },
    now: () => clock, sleep: async ms => { clock += ms; },
    serverUrl: async () => installed ? url : null,
    masterToken: async () => installed ? token(coordinator) : null,
    operatorToken: async () => token(operatorAgent),
    signIn: async () => null,
    // The checklist reads the real plane's merger and GitHub state; only the fleet and the loop are the host's.
    status: async () => {
      if (!installed) return null;
      const real = await request(operatorAgent, 'status');
      return { ...real, github: real.github, appPermissions: { missing: [] }, reviewerApps: [],
        fleet: accounts ? { roles: [{ role: 'worker', accounts: ['claude-a'] }, { role: 'reviewer', accounts: ['claude-a'] }], accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, smoke: { result: 'pass' } }] } : { roles: [], accounts: [] },
        setup: { protection: 'off', loop } } as any;
    },
    publishOnboarding: async () => null,
    onboardingMerged: async () => true,
    installDirectory: () => installDir,
    ensureDeployKey: async (dir, repo) => { deployKeys.push(`${dir}:${repo}`); return join(dir, 'deploy-key'); },
    setMerger: async (adminToken, requestId) => {
      const response = await fetch(`${url}/api/merger`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': requestId }, body: JSON.stringify({ merger: 'control-plane', reason: 'graphyard up --merger control-plane' }) });
      if (response.status !== 200) throw new Error(`POST /api/merger refused (${response.status}): ${await response.text()}`);
    },
    gh: async args => {
      ghCalls.push(args);
      if (args[0] === 'repo' && args[1] === 'view') return { code: 0, stdout: '{"name":"project"}' };
      return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
    },
    async cli(args, options = {}) {
      calls.push(args);
      if (args[0] === 'install' && args.includes('--plan')) return { code: 0, stdout: JSON.stringify({ installId: 'owner-project', installDirectory: installDir, principals: [{ id: 'owner-project-operator', role: 'admin', sessionKind: 'human' }], preflight: [{ name: 'GitHub CLI', ok: true }], browserApps: [] }) };
      if (args[0] === 'install' && args.includes('--apply')) { installed = true; return { code: 0, stdout: JSON.stringify({ ok: true, installDirectory: installDir, principals: [{ id: 'owner-project-operator', role: 'admin' }] }) }; }
      if (args.join(' ') === 'master registry propose --apply') { accounts = true; return { code: 0, stdout: '{}' }; }
      if (args.join(' ') === 'master restart') { loop = true; return { code: 0, stdout: '{}' }; }
      // `graphyard goal FILE`: the goal record reaches the real plane under the run's request id.
      if (args[0] === 'goal') return { code: 0, stdout: JSON.stringify(await request(operatorAgent, 'goals', JSON.parse(await readFile(args[1]!, 'utf8')), options.env?.GRAPHYARD_REQUEST_ID)) };
      return { code: 0, stdout: '{}' };
    },
  };
  return { deps, calls, ghCalls, deployKeys };
}

test('unit:zero-touch-control-plane — up --agent --goal FILE --merger control-plane against a bare origin and a real control plane reaches a merged first planned item through the merge writer with no human step: no prompt, handoff, browser or App approval, the goal planned and released, the stub worker\'s commit merged onto the bare origin by the deploy-key push', { timeout: 180_000 }, async () => {
  const { runUp, upRequestFromArgs } = await import('../src/up.js');

  // 1. `up`: the whole setup in one command; the plane ends up with the control-plane writer and the goal recorded.
  const directory = await temporaryDirectory('zero-touch-up');
  await writeFile(join(directory, 'goal.md'), 'Customers can be greeted by name when they open the application.\n');
  const events: UpEvent[] = [];
  const world = host(directory, events);
  const result = await runUp(upRequestFromArgs(['--repo', repository, '--provider', 'compose', '--agent', '--merger', 'control-plane', '--goal', 'goal.md']), world.deps);
  assert.equal(result.exitCode, 0, result.next);
  assert.equal(result.prompts, 0, 'up never waited on a person');
  assert.deepEqual(result.handoffs, [], 'no browser or device handoff');
  assert.ok(!events.some(event => event.kind === 'handoff' || event.kind === 'waiting'), 'no handoff or waiting event');
  assert.ok(result.checklist.every(item => item.done), JSON.stringify(result.checklist.filter(item => !item.done)));
  assert.ok(world.calls.filter(args => args[0] === 'install').every(args => args.includes('--no-github-app')), 'no GitHub App is registered');
  assert.deepEqual(world.ghCalls, [['repo', 'view', repository, '--json', 'name']], 'the operator\'s gh login only looked the repository up');
  assert.equal(world.deployKeys.length, 1);
  const status = await request(operatorAgent, 'status');
  assert.equal(status.github, false, 'the plane runs with no GitHub App');
  assert.equal(status.mergeWriter.merger, 'control-plane', 'the plane records the control plane as the merge writer');
  assert.ok(result.goal, 'the goal was submitted');
  const key = result.goal!;

  // 2. The goal, planned and released by the plane (the acceptance pull request and the agents' plan stand in as their stubs would).
  const at = new Date().toISOString();
  const recorded = (await request(operatorAgent, 'goals?open=1')).goals.find((goal: Goal) => goal.key === key) as Goal;
  assert.ok(recorded, `${key} is on the plane`);
  const outcome = `greeting-${recorded.revision}`;
  let goal = applyGoalCommand(recorded, 'draft', { outcomes: [{ id: outcome, title: 'A customer is greeted by name', criteria: ['The greeting names the customer'], case: { id: outcome, title: 'greeting answers', tags: ['api'], target: 'uat', required: true,
    steps: [{ kind: 'http', name: 'read the board', method: 'GET', path: '/api/board', status: 200 }] } }], pr: 1, branch: 'graphyard/greeting-acceptance', head: 'e'.repeat(40) }, { actor: operatorAgent, at });
  goal = applyGoalCommand(goal, 'approve', { reason: 'What a customer asked for' }, { actor: approver, at });
  goal = applyGoalCommand(goal, 'merged', { pr: 1, mergeSha: 'f'.repeat(40) }, { actor: coordinator, at });
  await appendGoal(store.pool, coordinator.id, 'merged', goal, { pr: 1 });
  const planOutcome = goal.acceptance!.outcomes[0]!;
  await request(operatorAgent, `goals/${key}/plan`, { note: 'A greeting module under src/, served by the existing application.', items: [{ ref: 'greeting', title: 'Greet the customer', description: 'Add the greeting module', type: 'feature', priority: 2, outcomes: [planOutcome.id], cases: [planOutcome.case.id],
    criteria: [{ id: 'AC-1', text: 'The greeting module answers', proofs: ['unit:app-works'] }], plannedFiles: ['src/greeting.ts'], dependsOn: [] }] });
  await request(approver, `goals/${key}/plan-approve`, { reason: 'One worker\'s change' });
  const released = await request(operatorAgent, `goals/${key}/release`, {});
  assert.equal(released.items?.length, 1, JSON.stringify(released));
  const first = (await request(coordinator, 'work') as Work[]).find(item => item.key === released.items[0].key)!;
  assert.ok(first, 'the first planned item exists');

  // 3. The stub worker: claims it, commits on its branch in the shared checkout, submits the head.
  const pulled = await engine.pullAssignment(worker, { work: first.id }, randomUUID());
  assert.equal(pulled.assigned?.id, first.id, JSON.stringify(pulled.refused));
  const branch = `graphyard/${first.key.toLowerCase()}-1`, tree = join(checkout, '.graphyard', 'worktrees', `${first.key}-1`);
  git(checkout, 'worktree', 'add', '-q', '-b', branch, tree, baseTip);
  git(tree, 'config', 'user.email', 't@example.com'); git(tree, 'config', 'user.name', 'T');
  const head = await commit(tree, 'src/greeting.ts', 'export const greeting = (name: string) => `Hello, ${name}`;\n', `${first.key}: greet the customer`);
  await engine.execute(worker, 'workspace', first.id, { epoch: 1, host: 'test', path: tree, branch }, randomUUID());
  const submitted = await engine.execute(worker, 'submit', first.id, completionBody(['1', '--head', head], () => head), randomUUID());
  assert.equal(submitted.observation?.source, 'control-plane', 'the plane observed the head itself');

  // 4. The loop: its merge writer lands the head with the deploy-key push; the trial is the stub's.
  const pushes: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const run: ChildRun = (command, args, options) => { if (command === 'git' && args.includes('push')) pushes.push({ args, env: options?.env }); return defaultChildRun(command, args, options); };
  const trial = async (input: Parameters<typeof runMergeTrial>[0]): Promise<MergeTrialRun> => ({ build: 'pass', tests: { passed: input.proofFiles.length, failed: [], files: input.proofFiles.length }, durationMs: 5, logTail: 'ok', files: [...input.proofFiles], proofs: Object.fromEntries(input.proofs.map(proof => [proof, { executed: 1, failed: 0 }])) });
  const deployKeyFile = join(directory, 'install-dir', 'deploy-key');
  const config = masterConfigSchema.parse({ version: 1, url, credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard', repository, baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile, retrials: 3 } } });
  const record: MergePorts['record'] = async (work, event) => request(coordinator, `work/${work.id}/merge-record`, event, mergeRecordKey(work, event));
  const recordedMerger = async () => (await request(coordinator, 'status')).mergeWriter.merger as 'github' | 'control-plane';
  const reads = mergeWriterReads(config, checkout, run, { base: worktreeBase, record, merger: recordedMerger, trial });
  const document = async () => (await store.workDocument(first.id))!;
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [await document()], now: new Date().toISOString() }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, decisions: async () => ({ decisions: [] }), persist: async () => {},
    github: githubDouble, merge: githubDouble, shadow: null, mergeWriter: reads } as unknown as DaemonEffects;
  const state = emptyDaemonState(config);
  await runCycle(config, state, effects, Date.now);
  await mergeWriterIdle(state);
  await runCycle(config, state, effects, Date.now);

  const done = await document();
  assert.equal(done.stage, 'done', JSON.stringify(done.gates));
  const mergeSha = done.delivery!.mergeSha;
  assert.equal(git(origin, 'rev-list', '--first-parent', 'main').split('\n')[0], mergeSha, 'main\'s first parent on the bare origin is the delivered merge commit');
  assert.equal(git(origin, 'rev-parse', `${mergeSha}^1`), baseTip);
  assert.equal(git(origin, 'rev-parse', `${mergeSha}^2`), head);
  assert.match(git(origin, 'show', `${mergeSha}:src/greeting.ts`), /Hello/, 'the worker\'s file is on main');
  assert.equal(pushes.length, 1, 'one push');
  assert.equal(pushes[0]!.env?.GIT_SSH_COMMAND, deployKeySshCommand(deployKeyFile), 'the push used the deploy key `up` placed, and no other credential');
  const kinds = (await store.pool.query("SELECT kind FROM events WHERE work_id=$1 AND kind LIKE 'merge.%' ORDER BY seq", [first.id])).rows.map(row => row.kind as string);
  assert.deepEqual(kinds, ['merge.intent', 'merge.trial', 'merge.pushed', 'merge.reconciled']);
  assert.ok(!(await store.pool.query("SELECT 1 FROM events WHERE work_id=$1 AND kind ILIKE '%github%'", [first.id])).rowCount, 'nothing about the item touched GitHub');
});
