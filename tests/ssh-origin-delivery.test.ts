import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Principal, Work } from '../src/model.js';
import type { Goal } from '../src/model/goal.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { mergeRecordKey, mergeWriterIdle, mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { deployKeySshCommand, type MergePorts, type MergeTrialRun, type runMergeTrial } from '../src/merge-writer/executor.js';
import { gitRunnerFor, type GitResult, type GitRunner } from '../src/merge-writer/local-observation.js';
import { acceptanceEffects, acceptanceStep, clearDrafts, draftsSettled, type AcceptanceEffects } from '../src/daemon/acceptance.js';
import { clearPlans, plannerStep, plansSettled, type PlannerEffects } from '../src/daemon/planner.js';
import { masterConfigSchema } from '../src/master.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { diagnosticianSettings } from '../src/runner/payloads.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { RunOptions, RunResult, Runner } from '../src/runner/types.js';
import { cliPath } from '../src/cli/context.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { keylessSshCommand, sshOrigin, type SshOrigin } from './helpers/ssh-origin.js';

/**
 * GY-1932, end to end: a goal delivers on a control-plane-merger install whose SSH origin only the
 * merge writer's deploy key can reach. The origin is a local bare repository behind the
 * tests/helpers/ssh-origin.ts door: it serves git-upload-pack/git-receive-pack only to a caller
 * whose GIT_SSH_COMMAND presents the merge writer's deploy key, refuses every other caller with
 * `Host key verification failed.` and exit 255 as the Snake install's sandboxes observed, and
 * records each caller with whether it presented the key. Everything Graphyard runs itself is real:
 * the control plane (embedded Postgres, the HTTP server, the engine that reads a `complete --head`
 * submission from the coordinator checkout's shared object store), the loop's acceptance, planner
 * and merge-writer steps, and git. Only the agents' model runs are stubbed with fixed drafts,
 * plans and verdicts; nothing touches GitHub.
 *
 * Through one goal: the acceptance change is drafted by the acceptance role, committed in the
 * coordinator checkout for the merge writer, approved by the approver identity, landed by the
 * merge writer's own fetch/merge/push and recorded merged through the real land route — whose own
 * `git fetch` runs with the compose container's SSH (no deploy key, no host key), fails with
 * `Host key verification failed.`, and leaves the judgement to the checkout's origin ref the loop
 * fetches (GY-1922). The approved plan is released; the first item is claimed by a worker whose
 * environment holds no deploy key, committed in its linked worktree of the coordinator checkout
 * (the shared object store), and submitted with the real `graphyard complete GY-N 1 --head` child
 * process (GY-1925: the head form pushes nothing, so a sandbox whose SSH cannot work still
 * completes); the merge writer trial-merges the head, pushes the merge commit through the
 * deploy-key door and records the item done.
 *
 * On origin/main before GY-1922 and GY-1925 this test fails. Before GY-1922 the land route fetched
 * the base from origin unconditionally and refused a landing it could not fetch with a retryable
 * 503, so a server that cannot reach its SSH origin never records the acceptance merged and the
 * planner never plans (this run shows the fixed path: the recorded fetches all fail like the
 * container's, and the landing is recorded all the same). Before GY-1925 `complete` pushed the
 * graphyard/ branch for the `--head` form too, so the worker's submission died in its sandbox's
 * SSH — this test's worker environment presents no deploy key, so that push is a refused, recorded
 * door call and the item is never submitted. Both pre-fix failures were reproduced by the
 * implementer by running this file against that code: at 100a7b90c27f (the parent of GY-1922's
 * merge) the goal sticks at accepted with the landing 503 named above, and at 093d0b56d4 (GY-1922
 * merged, GY-1925 not) `complete GY-1 1 --head` refuses with "pushing the graphyard/ branch
 * failed … Host key verification failed." and no head is ever submitted.
 */
const repository = 'owner/project';
const operatorAgent: Principal = { id: 'graphyard-master-operator', role: 'admin', sessionKind: 'ai' };
const approver: Principal = { id: 'graphyard-approver', role: 'admin', sessionKind: 'ai' };
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const worker: Principal = { id: 'ssh-worker', role: 'worker' };
const credentials = [operatorAgent, approver, coordinator, worker].map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;

let fixture: string, origin: SshOrigin, checkout: string, managed: string, baseTip: string;
let pg: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
let fixturePathBefore: string;
/** The control plane's own reads of origin, as the compose container makes them: every fetch fails on the host key. */
const serverFetches: { args: string[]; status: number | null; stderr: string }[] = [];
/** The pushes the loop's merge writer ran, with the child environment it gave them. */
const pushes: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const freePort = () => new Promise<number>((done, fail) => {
  const probe = createServer().once('error', fail).listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); });
});

async function commit(cwd: string, path: string, text: string, message: string) {
  await mkdir(join(cwd, path, '..'), { recursive: true });
  await writeFile(join(cwd, path), text);
  git(cwd, 'add', '--', path);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

before(async () => {
  fixture = await temporaryDirectory('ssh-origin-delivery');
  origin = await sshOrigin(fixture);
  // Production's deploy-key GIT_SSH_COMMAND names bare `ssh`; the wrapper is that `ssh`, found on PATH.
  fixturePathBefore = process.env.PATH ?? '';
  process.env.PATH = `${origin.bin}:${fixturePathBefore}`;
  // The coordinator checkout: cloned and seeded through the deploy-key door, its own git configured
  // with the deploy key as `core.sshCommand`, so the loop's plain fetch children reach the origin.
  checkout = join(fixture, 'checkout');
  execFileSync('git', ['clone', '-q', origin.url, checkout], { stdio: 'ignore', env: { ...process.env, GIT_SSH_COMMAND: origin.deployKeySshCommand } });
  git(checkout, 'config', 'user.email', 't@example.com');
  git(checkout, 'config', 'user.name', 'T');
  git(checkout, 'config', 'core.sshCommand', origin.deployKeySshCommand);
  await commit(checkout, 'README.md', '# Fixture\n', 'base');
  await commit(checkout, 'tests/app.test.ts', "import { test } from 'node:test';\ntest('unit:app-works — the app answers', () => {});\n", 'test');
  execFileSync('git', ['-C', checkout, 'push', '-q', 'origin', 'main'], { stdio: 'ignore' });
  baseTip = git(checkout, 'rev-parse', 'refs/remotes/origin/main');
  // GY-1899: the managed worktree root stands apart from the checkout the loop serves from.
  managed = join(fixture, 'managed');
  await mkdir(managed, { recursive: true });
  // The compose container's SSH: no deploy key, no known host — it fails before anything is offered
  // to the origin's door, which is why its fetches appear nowhere in the door's record.
  const containerSsh = join(fixture, 'container-ssh');
  await writeFile(containerSsh, '#!/bin/sh\necho "Host key verification failed." >&2\nexit 255\n');
  await chmod(containerSsh, 0o755);
  const containerEnv = { ...process.env, GIT_SSH_COMMAND: containerSsh };
  const port = await freePort();
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('ssh-origin-delivery-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('ssh_origin_delivery');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/ssh_origin_delivery`);
  await store.init();
  engine = new Engine(store, 120, repository);
  engine.submissionObserver = null;
  engine.directMergeEnvironment = null;
  engine.baseBranch = 'main';
  // The server's git, as the container makes it: local object-store reads work, its fetches fail.
  const runner = gitRunnerFor(checkout);
  engine.gitRunner = (async (args, options) => {
    const result = await new Promise<GitResult>(resolve => {
      execFile('git', ['-C', checkout, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: options?.timeoutMs ?? 0, killSignal: 'SIGKILL', env: containerEnv }, (error: any, stdout, stderr) => {
        resolve({ status: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '').trim() });
      });
    });
    if (args[0] === 'fetch') serverFetches.push({ args: [...args], status: result.status, stderr: result.stderr });
    return result;
  }) as GitRunner;
  http = server(engine, credentials, null);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  assert.equal((await request(coordinator, 'status')).mergeWriter.merger, 'control-plane', 'the control plane is the merge writer');
});

after(async () => {
  clearDrafts();
  clearPlans();
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
  if (pg) await pg.stop();
  process.env.PATH = fixturePathBefore;
});

/** Run one child, capturing its output: asynchronous, so the control plane in this process keeps answering while it runs. */
const child = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
  const run = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  run.stdout.on('data', chunk => { stdout += chunk; });
  run.stderr.on('data', chunk => { stderr += chunk; });
  const timer = options.timeoutMs ? setTimeout(() => run.kill('SIGKILL'), options.timeoutMs) : undefined;
  timer?.unref();
  run.once('close', (code, signal) => { if (timer) clearTimeout(timer); resolve({ status: code ?? (signal ? 1 : null), stdout, stderr }); });
  run.once('error', error => { if (timer) clearTimeout(timer); resolve({ status: 1, stdout, stderr: `${stderr}${error.message}` }); });
});

async function request(principal: Principal, path: string, body?: unknown, key: string = randomUUID(), method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  if (response.status >= 300) throw new Error(`${path} refused (${response.status}): ${text}`);
  return JSON.parse(text) as any;
}

/** A stubbed agent runtime: answers its role's one tool with RESPOND's payload, through the run's own validation. */
function stubRuntime(respond: (options: RunOptions<unknown>) => unknown, runs: string[]): Runner {
  return { name: 'stub', start<T>(_prompt: string, options: RunOptions<T>) {
    runs.push(String(options.env?.GRAPHYARD_PI_ROLE ?? options.tool));
    let result: RunResult<T>;
    try { const payload = options.validate(respond(options as RunOptions<unknown>)); result = { ok: true, tool: options.tool, payload, payloads: [payload] }; }
    catch (error) { result = { ok: false, failure: { reason: 'invalid-payload', detail: String(error) }, payloads: [] }; }
    return { id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {}, result: async () => result };
  } };
}

test('unit:ssh-origin-helper — the ssh-origin door serves clone, fetch and push to a caller presenting the deploy key, and refuses a caller with no key and one with an impostor key with `Host key verification failed.` and exit 255, recording every caller and whether it presented the key', { timeout: 120_000 }, async () => {
  assert.equal(origin.deployKeySshCommand, deployKeySshCommand(origin.deployKeyFile), 'the door opens with production\'s own deploy-key GIT_SSH_COMMAND');
  const door = await sshOrigin(await temporaryDirectory('ssh-origin-helper'));
  const env = (sshCommand?: string) => ({ ...process.env, PATH: `${door.bin}:${process.env.PATH}`, ...(sshCommand ? { GIT_SSH_COMMAND: sshCommand } : {}) });
  // A caller presenting the deploy key clones the empty repository through the door, pushes to it, and fetches from it.
  const seed = join(door.repository, '..', 'seed');
  execFileSync('git', ['clone', '-q', door.url, seed], { env: env(door.deployKeySshCommand), stdio: 'ignore' });
  git(seed, 'config', 'user.email', 't@example.com');
  git(seed, 'config', 'user.name', 'T');
  const head = await commit(seed, 'README.md', '# through the door\n', 'base');
  execFileSync('git', ['-C', seed, 'push', '-q', '-u', 'origin', 'main'], { env: env(door.deployKeySshCommand), stdio: 'ignore' });
  execFileSync('git', ['-C', seed, 'fetch', '-q', '--all'], { env: env(door.deployKeySshCommand), stdio: 'ignore' });
  assert.equal(git(door.repository, 'rev-parse', 'refs/heads/main'), head, 'the push landed on the local bare repository the door serves');
  // A caller without any key, and one with an impostor key, are refused exactly as the sandboxes were.
  const keyless = await child('git', ['-C', seed, 'ls-remote', door.url], { env: env(keylessSshCommand), timeoutMs: 60_000 });
  assert.notEqual(keyless.status, 0, 'a caller with no deploy key reads nothing');
  assert.match(keyless.stderr, /Host key verification failed\./, 'the refusal names the host key, as the sandboxes observed');
  assert.match(keyless.stderr, /Could not read from remote repository\./, 'git reports the dead transport');
  const impostor = await child('git', ['-C', seed, 'ls-remote', door.url], { env: env(`ssh -i ${join(door.repository, '..', 'not-the-key')} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`), timeoutMs: 60_000 });
  assert.notEqual(impostor.status, 0, 'a caller with the wrong key reads nothing');
  assert.match(impostor.stderr, /Host key verification failed\./);
  // Every caller is recorded, with whether it presented the deploy key.
  const calls = await door.accesses();
  const served = calls.filter(entry => entry.presented);
  assert.ok(served.length >= 3, `the clone, the push and the fetch went through the door: ${JSON.stringify(calls)}`);
  assert.ok(served.every(entry => entry.outcome === 'served'), 'every credentialed caller was served');
  assert.ok(served.some(entry => entry.service === 'git-upload-pack'), 'reads are served through git-upload-pack');
  assert.ok(served.some(entry => entry.service === 'git-receive-pack'), 'pushes are served through git-receive-pack');
  const refused = calls.filter(entry => !entry.presented);
  assert.deepEqual(refused.map(entry => [entry.service, entry.outcome]), [['git-upload-pack', 'refused'], ['git-upload-pack', 'refused']], 'the keyless and impostor callers are recorded refused');
  assert.ok(refused.every(entry => entry.outcome === 'refused'), 'no keyless caller was served');
});

test('unit:ssh-origin-delivery — on a control-plane-merger install whose SSH origin only the deploy key reaches, a goal\'s acceptance is landed by the merge writer and recorded merged while the plane\'s own fetch fails like the container\'s, its plan is released, the first item is submitted with `complete --head` by a worker with no deploy key, and the merge writer merges it to done, with every recorded door call presenting the deploy key', { timeout: 600_000 }, async () => {
  clearDrafts();
  clearPlans();
  // 1. The goal, recorded as the operator's operator-agent identity posts it.
  const goal = await request(operatorAgent, 'goals', { statement: 'Customers can be greeted by name when they open the application.', users: ['Customers'], constraints: [], deployTarget: 'uat' }) as Goal;

  // 2. The loop over the real control plane: the acceptance and planner roles with stubbed model
  //    runtimes, the merge writer's reads over the coordinator checkout, real git throughout.
  let clock = 1_700_000_000_000;
  const runs: string[] = [];
  const config = masterConfigSchema.parse({ version: 1, url, credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard', repository, baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', workers: [], run: { worktreeRoot: managed, mergeWriter: { deployKeyFile: origin.deployKeyFile, retrials: 2 } } });
  const state = emptyDaemonState(config);
  const greetingCase = { id: 'greeting', title: 'greeting answers', tags: ['api'], target: 'uat', required: true, steps: [{ kind: 'http', name: 'read the greeting', method: 'GET', path: '/greeting.json', status: 200, expect: [{ path: 'greeting', includes: 'Hello' }] }] };
  const run: ChildRun = (command, args, options) => { if (command === 'git' && args.includes('push')) pushes.push({ args, env: options?.env }); return defaultChildRun(command, args, options); };
  const trial = async (input: Parameters<typeof runMergeTrial>[0]): Promise<MergeTrialRun> => ({ build: 'pass', tests: { passed: input.proofFiles.length, failed: [], files: input.proofFiles.length }, durationMs: 5, logTail: 'ok', files: [...input.proofFiles], proofs: Object.fromEntries(input.proofs.map(proof => [proof, { executed: 1, failed: 0 }])) });
  const recordedMerger = async () => (await request(coordinator, 'status')).mergeWriter.merger as 'control-plane';
  const record: MergePorts['record'] = async (work, event) => request(coordinator, `work/${work.id}/merge-record`, event, mergeRecordKey(work, event));
  const reads = mergeWriterReads(config, checkout, run, { base: managed, record, merger: recordedMerger, trial });
  // The advisory budget run would build the fixture merge commit for real; it is not this scenario's
  // concern, and the step treats an absent advisory port as no run.
  const writerReads: typeof reads = { ...reads, advisory: undefined };
  const acceptance: AcceptanceEffects = {
    ...acceptanceEffects(config, checkout, { run, fetcher: fetch, asCoordinator: path => request(coordinator, path), asOperatorAgent: (_method, path, body, key) => request(operatorAgent, path, body, key), merger: recordedMerger, writer: reads }),
    settings: diagnosticianSettings({}),
    goals: async () => (await request(coordinator, 'goals?open=1')).goals,
    runner: async (role, attempt, goalAtHand) => ({ runtime: 'stub', model: attempt, runner: stubRuntime(() => role === 'judge'
      ? { goal: goalAtHand.key, verdict: 'approve', reason: 'The outcome is what a customer asked for and its case checks it' }
      : { goal: goalAtHand.key, outcomes: [{ id: 'greeting', title: 'A customer is greeted by name', criteria: ['The greeting names the customer'], case: greetingCase }] }, runs) }),
    judge: (goalAtHand, judgement) => request(approver, `goals/${goalAtHand.key}/${judgement.verdict}`, { reason: judgement.reason }, `acceptance:${goalAtHand.id}:${goalAtHand.revision}:judged`),
    open: async () => { throw new Error('the control-plane acceptance opened a pull request'); },
    pullRequest: async () => { throw new Error('the control-plane acceptance read a pull request'); },
    land: async () => { throw new Error('the control-plane acceptance asked GitHub to land it'); },
    close: async () => { throw new Error('the control-plane acceptance closed a pull request'); },
  };
  const planner: PlannerEffects = {
    settings: diagnosticianSettings({}), cwd: fixture,
    goals: async () => (await request(coordinator, 'goals?open=1')).goals,
    runner: async (role, attempt, goalAtHand) => ({ runtime: 'stub', model: attempt, runner: stubRuntime(() => role === 'judge'
      ? { goal: goalAtHand.key, verdict: 'approve', reason: 'One small item a worker finishes in one change' }
      : { goal: goalAtHand.key, summary: 'Customers get a greeting. One module serves it. It ships with the app.', note: 'A greeting module under src/, served by the existing application.',
        items: [{ ref: 'greeting', title: 'Greet the customer', plain: 'Customers see a greeting.', description: 'Add the greeting module', type: 'feature', priority: 2,
          outcomes: ['greeting'], cases: ['greeting'],
          criteria: [{ id: 'AC-1', text: 'The greeting module answers', proofs: ['unit:app-works'] }], plannedFiles: ['src/greeting.ts', 'public/greeting.json'], dependsOn: [] }] }, runs) }),
    plan: (goalAtHand, plan) => request(operatorAgent, `goals/${goalAtHand.key}/plan`, plan, `planner:${goalAtHand.id}:${goalAtHand.revision}`),
    invalid: (goalAtHand, reason) => request(operatorAgent, `goals/${goalAtHand.key}/plan-invalid`, { reason }, `planner:${goalAtHand.id}:${goalAtHand.revision}:invalid`),
    judge: (goalAtHand, judgement) => request(approver, `goals/${goalAtHand.key}/plan-${judgement.verdict}`, { reason: judgement.reason }, `planner:${goalAtHand.id}:${goalAtHand.revision}:judged`),
    release: goalAtHand => request(operatorAgent, `goals/${goalAtHand.key}/release`, {}, `planner:${goalAtHand.id}:${goalAtHand.revision}:release`),
    deliver: (goalAtHand, items, reason) => request(operatorAgent, `goals/${goalAtHand.key}/deliver`, { items, reason }, `planner:${goalAtHand.id}:${goalAtHand.revision}:deliver`),
  };
  const isolate = async (_key: string, _input: unknown, _name: string, body: () => Promise<unknown>) => body();
  const acceptanceTick = async () => {
    await acceptanceStep({ config, state, now: () => clock, clock, snapshot: { work: [] as Work[] }, performed: [], isolate, effects: { acceptance, persist: async () => {} } } as unknown as Cycle);
    await draftsSettled();
  };
  const plannerTick = async () => {
    await plannerStep({ config, state, now: () => clock, clock, snapshot: { work: await request(coordinator, 'work') }, performed: [], isolate, effects: { planner, persist: async () => {} } } as unknown as Cycle);
    await plansSettled();
  };

  // 3. The worker: a profile with no deploy key anywhere in its environment. It claims the item
  //    through the real plane, commits in its linked worktree of the coordinator checkout — the
  //    shared object store — and submits with the real `complete --head` child process, whose
  //    environment's SSH names no key (a sandbox whose SSH cannot work).
  const workerTokenFile = join(fixture, 'worker.token');
  await writeFile(workerTokenFile, token(worker), { mode: 0o600 });
  let submittedHead: string | null = null;
  let submitted: Work | null = null;
  const workItems = async () => {
    const ready = ((await request(coordinator, 'work')) as Work[]).find(item => item.stage === 'ready' && !item.lease && !item.submission);
    if (!ready) return;
    runs.push(`worker ${ready.key}`);
    const pulled = await engine.pullAssignment(worker, { work: ready.id }, randomUUID());
    assert.equal((pulled as any).assigned?.id, ready.id, JSON.stringify((pulled as any).refused));
    const branch = `graphyard/${ready.key.toLowerCase()}-1`, tree = join(checkout, '.graphyard', 'worktrees', `${ready.key}-1`);
    git(checkout, 'worktree', 'add', '-q', '-b', branch, tree, 'refs/remotes/origin/main');
    git(tree, 'config', 'user.email', 't@example.com');
    git(tree, 'config', 'user.name', 'T');
    await commit(tree, 'src/greeting.ts', 'export const greeting = (name: string) => `Hello, ${name}`;\n', `${ready.key}: greet the customer`);
    const head = await commit(tree, 'public/greeting.json', '{ "greeting": "Hello, customer" }\n', `${ready.key}: serve the greeting`);
    await engine.execute(worker, 'workspace', ready.id, { epoch: 1, host: 'worker-host', path: tree, branch }, randomUUID());
    // The real CLI, as the worker's session runs it: no deploy key in its environment, and an SSH
    // command that presents none, so any push it attempted is a refused, recorded door call.
    const completed = await child(process.execPath, [cliPath, 'complete', ready.key, '1', '--head', head], {
      cwd: tree, timeoutMs: 120_000,
      env: { ...process.env, GRAPHYARD_URL: url, GRAPHYARD_TOKEN_FILE: workerTokenFile, GRAPHYARD_REPOSITORY_ROOT: tree, GIT_SSH_COMMAND: keylessSshCommand },
    });
    assert.equal(completed.status, 0, `complete ${ready.key} 1 --head failed: ${completed.stderr || completed.stdout}`);
    const receipt = JSON.parse(completed.stdout.trim()) as { observation?: { source?: string } };
    assert.equal(receipt.observation?.source, 'control-plane', 'the plane observed the head itself, from the shared object store');
    submittedHead = head;
    submitted = ((await request(coordinator, 'work')) as Work[]).find(item => item.id === ready.id)!;
  };
  const loopTick = async () => {
    clock += 6 * 60_000;
    await acceptanceTick();
    await plannerTick();
    await workItems();
  };

  let first: Work | undefined;
  for (let ticks = 0; ticks < 40 && !submittedHead; ticks++) {
    await loopTick();
    first = ((await request(coordinator, 'work')) as Work[]).find(item => item.title.startsWith(`${goal.key}: `));
  }
  assert.ok(runs.includes('acceptance'), `the acceptance role ran: ${runs.join(', ')}`);
  assert.ok(runs.includes('planner'), `the planner role ran: ${runs.join(', ')}; actions ${JSON.stringify(state.actions)}`);
  assert.ok(runs.includes('acceptance-judge') && runs.includes('plan-judge'), `both judges ran: ${runs.join(', ')}`);
  const planned = await request(coordinator, `goals/${goal.key}`) as { goal: Goal };
  assert.equal(planned.goal.stage, 'delivering', `the goal is past planning, its plan released: ${planned.goal.stage}`);
  assert.notEqual(planned.goal.acceptance!.author, planned.goal.approval!.by, 'acceptance was approved by an identity that did not draft it');
  assert.notEqual(planned.goal.plan!.author, planned.goal.planApproval!.by, 'the plan was approved by an identity that did not write it');
  assert.ok(submittedHead && submitted, `the worker submitted ${first?.key}; goal stage ${planned.goal.stage}; actions: ${JSON.stringify(state.actions)}; runs: ${runs.join(', ')}`);

  // 4. The merge writer merges the submitted head and pushes it through the deploy-key door.
  const item = submitted! as Work;
  const document = async () => (await store.workDocument(item.id))!;
  const mergeTick = async () => {
    const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
      snapshot: async () => ({ work: [await document()], now: new Date(clock).toISOString() }),
      closeSession: () => {}, dispatch: async () => {},
      observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(clock).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
      recordDeployment: async () => {}, decisions: async () => ({ decisions: [] }), persist: async () => {},
      github: new Proxy({}, { get: (_, name) => { throw new Error(`the delivery called GitHub (${String(name)})`); } }),
      merge: new Proxy({}, { get: (_, name) => { throw new Error(`the delivery called GitHub's merge (${String(name)})`); } }),
      mergeWriter: writerReads } as unknown as DaemonEffects;
    await runCycle(config, state, effects, () => clock);
    await mergeWriterIdle(state);
    await runCycle(config, state, effects, () => clock);
  };
  await mergeTick();

  // 5. The delivery: the item is done, main on the origin holds the merge of the submitted head,
  //    and the goal stands past planning.
  const done = await document();
  assert.equal(done.stage, 'done', JSON.stringify(done.gates));
  const mergeSha = done.delivery!.mergeSha;
  // The bare repository is read directly here only to assert on the landed history; the door's
  // record below is what says how it got there.
  assert.equal(git(origin.repository, 'rev-list', '--first-parent', 'main').split('\n')[0], mergeSha, 'main\'s first parent on the origin is the delivered merge commit');
  const landed = await request(coordinator, `goals/${goal.key}`) as { goal: Goal };
  assert.equal(landed.goal.stage, 'delivering', `the goal stands past planning with its item done: ${landed.goal.stage}`);
  const acceptanceMerge = landed.goal.merged!.mergeSha!;
  assert.ok(acceptanceMerge, `the acceptance change is recorded merged: ${landed.goal.stage}`);
  assert.equal(git(origin.repository, 'rev-parse', `${acceptanceMerge}^1`), baseTip, 'the acceptance change landed on the seeded base');
  assert.ok(git(origin.repository, 'rev-list', '--first-parent', mergeSha).split('\n').includes(acceptanceMerge), 'the item landed on the acceptance change: the fast-forwarded head carries it on its first-parent chain');
  assert.equal(mergeSha, submittedHead, 'the worker\'s head sat on the tip, so main fast-forwarded to the submitted head itself');
  assert.match(git(origin.repository, 'show', `${mergeSha}:src/greeting.ts`), /Hello/, 'the worker\'s file is on the origin\'s main');
  const history = (await request(coordinator, `goals/${goal.key}`)).history as { kind: string }[];
  assert.deepEqual(history.map(entry => entry.kind), ['goal.recorded', 'goal.draft', 'goal.approve', 'goal.merged', 'goal.plan', 'goal.plan-approve', 'goal.released'], 'the goal moved through acceptance, landing, planning and release');

  // 6. The door's record: every remote access it saw presented the merge writer's deploy key.
  const calls = await origin.accesses();
  assert.ok(calls.length >= 4, `the origin saw the delivery's traffic: ${JSON.stringify(calls)}`);
  assert.deepEqual(calls.filter(entry => !entry.presented), [], 'every remote access the origin recorded presented the deploy key: no worker, server or other caller reached it without the key');
  assert.ok(calls.some(entry => entry.service === 'git-upload-pack' && entry.presented), 'the loop fetched through the door');
  assert.deepEqual(calls.filter(entry => entry.service === 'git-receive-pack').map(entry => entry.presented), [true, true, true], 'three pushes went through the door, all with the key: the seeded base, the acceptance change, then the item');
  assert.equal(pushes.length, 2, 'the loop made exactly two push children');
  for (const push of pushes) assert.equal(push.env?.GIT_SSH_COMMAND, deployKeySshCommand(origin.deployKeyFile), 'every push child ran with the deploy key as GIT_SSH_COMMAND and no other credential');

  // 7. GY-1922: the plane's own fetches failed like the compose container's, and the landing was
  //    still recorded — judged from the checkout's origin ref the loop fetches.
  assert.ok(serverFetches.length >= 1, `the land route fetched: ${JSON.stringify(serverFetches)}`);
  for (const fetch of serverFetches) {
    assert.deepEqual(fetch.args, ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'], 'the land route fetches the base from origin');
    assert.notEqual(fetch.status, 0, 'the container\'s fetch fails');
    assert.match(fetch.stderr, /Host key verification failed\./, 'the failure is the container\'s host-key refusal');
  }
  const kinds = (await store.pool.query("SELECT kind FROM events WHERE work_id=$1 AND kind LIKE 'merge.%' ORDER BY seq", [item.id])).rows.map((row: { kind: string }) => row.kind);
  assert.deepEqual(kinds, ['merge.intent', 'merge.trial', 'merge.pushed', 'merge.reconciled'], 'the merge writer recorded the whole delivery on the ledger');
  assert.ok(!(await store.pool.query("SELECT 1 FROM events WHERE work_id=$1 AND kind ILIKE '%github%'", [item.id])).rowCount, 'nothing about the item touched GitHub');
});
