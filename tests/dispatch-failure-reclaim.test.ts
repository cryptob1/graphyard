import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { defaultChildRun } from '../src/child-runner.js';
import { masterConfigSchema, prepareWorkerLaunch, saveWorkerProfile, setupMaster, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { dispatchFailureBlockAfter, dispatchFailureCause, noteDispatchFailure } from '../src/daemon/dispatch-failures.js';
import { branchHolders, reclaimBranchHolders } from '../src/worktree-holders.js';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1078: GY-859 waited 5.4 hours through about forty failed dispatches because a session worktree
// left in an interactive rebase still held its branch, git lists such a worktree as detached so
// nothing freed it, the failure recorded only the command line, and the loop redispatched it on a
// fresh epoch every cycle.
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x'), workerToken = 'worker-token-'.padEnd(40, 'x');

/** A repository with a GitHub origin, one commit on main and two on the item's branch. */
async function repository(branch: string) {
  const root = await temporaryDirectory('gy-1078-repo');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  git(root, 'remote', 'add', 'origin', 'https://github.com/owner/project.git');
  git(root, 'config', 'user.email', 'test@example.com'); git(root, 'config', 'user.name', 'Test');
  await writeFile(join(root, 'a.txt'), 'one\n'); git(root, 'add', 'a.txt'); git(root, 'commit', '-q', '-m', 'one');
  git(root, 'branch', branch);
  return root;
}
/** A session worktree of the item at `path`, stopped in an interactive rebase of `branch` (an `edit` stop: clean, HEAD detached). */
async function rebasingHolder(root: string, path: string, branch: string) {
  git(root, 'worktree', 'add', '-q', path, branch);
  await writeFile(join(path, 'b.txt'), 'two\n'); git(path, 'add', 'b.txt'); git(path, 'commit', '-q', '-m', 'two');
  execFileSync('git', ['rebase', '-i', 'HEAD~1'], { cwd: path, stdio: 'ignore', env: { ...process.env, GIT_SEQUENCE_EDITOR: 'sed -i 1s/^pick/edit/', GIT_EDITOR: 'true' } });
  assert.match(git(root, 'worktree', 'list', '--porcelain'), new RegExp(`worktree ${path}\\nHEAD [0-9a-f]+\\ndetached`), 'git lists the rebasing worktree as detached');
}

/** The control plane the worktree command talks to: the item, its repository, and the workspace it reserves. */
async function controlPlane(item: Record<string, unknown>) {
  const posted: string[] = [];
  const http = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/status') return response.end(JSON.stringify({ actor: { id: 'worker-a', role: 'worker' }, repository: 'owner/project', now: new Date().toISOString() }));
    if (request.method === 'POST') { posted.push(request.url!); for await (const _chunk of request) { /* drain */ } return response.end(JSON.stringify(item)); }
    response.end(JSON.stringify([item]));
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const env: NodeJS.ProcessEnv & { GRAPHYARD_URL: string } = { ...process.env, GRAPHYARD_URL: `http://127.0.0.1:${(http.address() as { port: number }).port}`, GRAPHYARD_TOKEN: workerToken, GRAPHYARD_HOST_ID: 'machine-a' };
  delete env.GRAPHYARD_TOKEN_FILE; delete env.GRAPHYARD_REQUEST_ID;
  return { env, posted, close: () => new Promise<void>(resolve => http.close(() => resolve())) };
}
const item = (lease: { epoch: number; live: boolean }) => ({ id: 'item-7', key: 'GY-7', epoch: 3, submission: null, candidate: null, workspaces: [],
  lease: { owner: 'worker-a', epoch: lease.epoch, expiresAt: new Date(Date.now() + (lease.live ? 600_000 : -600_000)).toISOString() } });

test('unit:worktree-reclaims-rebasing-holder — an abandoned session worktree stuck mid-rebase of the branch is released and the new worktree created; one under a live lease is named and left alone', async () => {
  const branch = 'graphyard/gy-7-3';
  const root = await repository(branch);
  const sessions = join(root, '.graphyard', 'worktrees'), holder = join(sessions, 'GY-7-2'), target = join(sessions, 'GY-7-3');
  await mkdir(sessions, { recursive: true });
  try {
    await rebasingHolder(root, holder, branch);
    assert.deepEqual(branchHolders(root, branch, target).map(entry => [entry.path, entry.via, entry.key, entry.epoch]), [[holder, 'rebase', 'GY-7', 2]], 'the holder is found from its admin directory');
    const tip = git(root, 'rev-parse', branch);

    // The holder's own epoch holds a live lease: never touched, and named.
    let plane = await controlPlane(item({ epoch: 2, live: true }));
    try {
      const refused = await run(process.execPath, [launcher, 'worktree', 'GY-7', '3'], { cwd: root, env: plane.env }).then(() => null, error => error as { stderr: string });
      assert.ok(refused, 'the command fails');
      assert.match(refused!.stderr, new RegExp(`${holder} \\(rebase in progress\\) belongs to GY-7 epoch 2, which holds a live lease`));
      assert.ok(existsSync(join(git(holder, 'rev-parse', '--absolute-git-dir'), 'rebase-merge')), 'the live attempt keeps its rebase');
      assert.ok(!existsSync(target));
      assert.ok(plane.posted.some(path => path.endsWith('/release')) && !plane.posted.some(path => path.endsWith('/workspace')), 'the claim is released as a workspace failure before anything is reserved');
    } finally { await plane.close(); }

    // Abandoned, with uncommitted work beside it: GY-860 records that work with the reservation,
    // ends the rebase and detaches the holder, and the new worktree is created on the branch.
    await writeFile(join(holder, 'scratch.txt'), 'unsaved\n');
    plane = await controlPlane(item({ epoch: 3, live: true }));
    try {
      const { stdout } = await run(process.execPath, [launcher, 'worktree', 'GY-7', '3'], { cwd: root, env: plane.env });
      const printed = JSON.parse(stdout);
      assert.equal(printed.path, target); assert.equal(printed.branch, branch);
      assert.ok(existsSync(join(holder, 'scratch.txt')), 'the uncommitted work stays where it was');
      assert.ok(!existsSync(join(git(holder, 'rev-parse', '--absolute-git-dir'), 'rebase-merge')), 'the rebase is over');
      assert.equal(git(target, 'symbolic-ref', '--short', 'HEAD'), branch, 'the new worktree is on the item branch');
      assert.equal(git(root, 'rev-parse', branch), tip, 'the branch ref never moved');
      assert.equal(git(target, 'log', '-1', '--format=%s'), 'two', 'the branch keeps the commit the abandoned session made');
      assert.ok(plane.posted.some(path => path.endsWith('/workspace')), 'the workspace was reserved');
    } finally { await plane.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:worktree-failure-names-git-error — a failing git worktree add reports git\'s stderr, and the loop\'s recorded dispatch failure carries it', async () => {
  const branch = 'graphyard/gy-7-3';
  const root = await repository(branch);
  const target = join(root, '.graphyard', 'worktrees', 'GY-7-3');
  // Something already sits where the worktree goes: git refuses with its own reason.
  await mkdir(target, { recursive: true }); await writeFile(join(target, 'left-behind.txt'), 'x\n');
  const credentials = await temporaryDirectory('gy-1078-credentials');
  const plane = await controlPlane(item({ epoch: 3, live: true }));
  try {
    const refused = await run(process.execPath, [launcher, 'worktree', 'GY-7', '3'], { cwd: root, env: plane.env }).then(() => null, error => error as { stderr: string });
    assert.match(refused!.stderr, /Git worktree creation failed: git worktree add .*GY-7-3 graphyard\/gy-7-3 failed \(exit \d+\): .*fatal: '.*GY-7-3' already exists/);

    // The launcher captures that stderr instead of passing it to its own terminal.
    const credential = join(credentials, 'worker.token'); await writeFile(credential, workerToken, { mode: 0o600 });
    await setupMaster(root, { url: plane.env.GRAPHYARD_URL, token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials },
      (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
    await saveWorkerProfile(root, { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: credential }, async () => ({ actor: { id: 'worker-a', role: 'worker' } }));
    const released: string[] = [];
    const failure = await prepareWorkerLaunch(root, 'GY-7', 'launch', (command, args, options) => {
      if (command === 'git') return args[0] === 'rev-parse' ? `${'c'.repeat(40)}\n` : '';
      if (args[1] === 'claim') return JSON.stringify({ epoch: 3, lease: { owner: 'worker-a' } });
      if (args[1] === 'release') { released.push(args[3]); return '{}'; }
      // The real worktree command, run with exactly the streams the launcher asked for.
      return defaultChildRun(command, args.slice(0, 4), { cwd: options?.cwd, env: plane.env, stdout: options?.stdio?.[1] === 'inherit' ? 'inherit' : 'capture', stderr: options?.stdio?.[2] === 'inherit' ? 'inherit' : 'capture' });
    }).then(() => null, error => error as Error);
    assert.match(failure!.message, /^Worker launch failed: the worktree for GY-7 epoch 3 could not be created: Git worktree creation failed: .*fatal: '.*GY-7-3' already exists/);
    assert.deepEqual(released, ['3'], 'the claimed epoch is released');

    // The loop records that failure with git's words in it.
    const config = loopConfig(credential);
    const state = emptyDaemonState(config);
    const effects = loopEffects([ready()], async () => { throw failure; });
    await runCycle(config, state, effects.effects, () => effects.clock());
    const recorded = state.actions['dispatch:item-7:0'];
    assert.equal(recorded.state, 'failed');
    assert.match(recorded.detail, /^Dispatch of GY-7 to one failed: Worker launch failed: .*fatal: '.*GY-7-3' already exists.* \(failure 1 of 3 with this cause\)$/);
  } finally { await plane.close(); await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); }
});

test('an attached git am holder is found as an am rather than a checkout, reclaimed on a first attempt, and the launcher carries what was reclaimed into its result', async () => {
  const branch = 'graphyard/gy-7-3';
  const root = await repository(branch);
  const sessions = join(root, '.graphyard', 'worktrees'), holder = join(sessions, 'GY-7-2'), target = join(sessions, 'GY-7-3');
  const credentials = await temporaryDirectory('gy-1078-credentials');
  await mkdir(sessions, { recursive: true });
  // A patch against a.txt that no longer applies on the branch: `git am` stops with HEAD still on it.
  git(root, 'checkout', '-q', '-b', 'patch-source'); await writeFile(join(root, 'a.txt'), 'patched\n'); git(root, 'commit', '-q', '-am', 'patched');
  const patch = join(root, 'change.patch'); await writeFile(patch, git(root, 'format-patch', '-1', '--stdout') + '\n');
  git(root, 'checkout', '-q', 'main');
  git(root, 'worktree', 'add', '-q', holder, branch);
  await writeFile(join(holder, 'a.txt'), 'diverged\n'); git(holder, 'commit', '-q', '-am', 'diverged');
  assert.throws(() => git(holder, 'am', patch));
  assert.match(git(root, 'worktree', 'list', '--porcelain'), new RegExp(`worktree ${holder}\\nHEAD [0-9a-f]+\\nbranch refs/heads/${branch}`), 'git still lists the am holder on the branch');
  const plane = await controlPlane(item({ epoch: 3, live: true }));
  try {
    assert.deepEqual(branchHolders(root, branch, target).map(entry => [entry.path, entry.via]), [[holder, 'am']], 'its applying marker tells it from a checkout');
    const credential = join(credentials, 'worker.token'); await writeFile(credential, workerToken, { mode: 0o600 });
    await setupMaster(root, { url: plane.env.GRAPHYARD_URL, token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials },
      (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
    await saveWorkerProfile(root, { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: credential }, async () => ({ actor: { id: 'worker-a', role: 'worker' } }));
    const prepared = await prepareWorkerLaunch(root, 'GY-7', 'launch', (command, args, options) => {
      if (command === 'git') return args[0] === 'rev-parse' ? `${git(root, 'rev-parse', 'main')}\n` : '';
      if (args[1] === 'claim') return JSON.stringify({ epoch: 3, lease: { owner: 'worker-a' } });
      return defaultChildRun(command, args.slice(0, 4), { cwd: options?.cwd, env: plane.env, stdout: options?.stdio?.[1] === 'inherit' ? 'inherit' : 'capture', stderr: options?.stdio?.[2] === 'inherit' ? 'inherit' : 'capture' });
    });
    assert.equal(prepared.path, target);
    assert.deepEqual(prepared.reclaimed, [`${holder}: aborted the am and removed the worktree`], 'a launch that succeeds still reports what it reclaimed');
    assert.ok(!existsSync(holder));
    assert.equal(git(target, 'log', '-1', '--format=%s'), 'diverged', 'the branch keeps the abandoned session\'s commit');
  } finally { await plane.close(); await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); }
});

const launchProfile = (name: string, credentialFile: string): WorkerProfile => ({ name, principal: `${name}-principal`, agentName: `agent-${name}`, mode: 'launch', kind: 'codex', credentialFile, agentArgs: [], approvals: 'auto', environment: {} });
const loopConfig = (credentialFile: string): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main',
  githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: ['one', 'two', 'three'].map(name => launchProfile(name, credentialFile)) });
function ready(overrides: Partial<Work> = {}): Work {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return { id: 'item-7', key: 'GY-7', title: 'GY-7', description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:x'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'ready', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], ...overrides } as Work;
}
/** The loop's effects over one item the control plane holds; `blockDispatch` writes the blocker the way the `dispatchblock` command does. */
function loopEffects(work: Work[], dispatch: DaemonEffects['dispatch']) {
  let offsetMs = 0;
  const blocked: string[] = [];
  const effects: DaemonEffects = {
    agents: () => [], credentials: async items => Object.fromEntries(items.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: structuredClone(work), now: new Date(Date.now() + offsetMs).toISOString() }),
    closeSession: () => {}, dispatch, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    blockDispatch: async (target, reason) => { blocked.push(reason); work.find(entry => entry.id === target.id)!.blocker = reason; },
  };
  return { effects, blocked, clock: () => Date.now() + offsetMs, advance: (ms: number) => { offsetMs += ms; } };
}

test('unit:repeated-dispatch-failure-blocks — after three consecutive dispatch failures with one cause the loop records a blocker naming it and dispatches the item no further until it clears', async () => {
  const directory = await temporaryDirectory('gy-1078-loop');
  try {
    const credential = join(directory, 'coordinator.token'); await writeFile(credential, coordinatorToken, { mode: 0o600 });
    const config = loopConfig(credential), state = emptyDaemonState(config);
    const items = [ready()];
    let attempts = 0, failing = true;
    // Each attempt claims a fresh epoch and releases it, as the launcher does, and fails on the
    // same held branch: the epoch, its path and the command line differ, the cause does not.
    const loop = loopEffects(items, async target => {
      attempts++;
      const epoch = ++items[0].epoch;
      if (!failing) return { pane: null, reclaimed: ['/repo/.graphyard/worktrees/GY-7-2: aborted the rebase and removed the worktree'] };
      const error = Object.assign(new Error(`Command failed: node cli worktree GY-7 ${epoch} ${'c'.repeat(40)}\nGit worktree creation failed: git worktree add /repo/.graphyard/worktrees/GY-7-${epoch} graphyard/gy-7-1 failed (exit 128): fatal: 'graphyard/gy-7-1' is already used by worktree at '/repo/.graphyard/worktrees/GY-7-2'`), { target });
      throw new Error(`Worker launch failed: the worktree for GY-7 epoch ${epoch} could not be created: ${error.message.split('\n')[1]}`);
    });
    const cycle = async () => { await runCycle(config, state, loop.effects, loop.clock); loop.advance(15 * 60_000); };

    for (let n = 1; n <= dispatchFailureBlockAfter; n++) {
      await cycle();
      assert.equal(attempts, n, `cycle ${n} dispatches once`);
      if (n < dispatchFailureBlockAfter) assert.equal(state.dispatchFailures['item-7'].count, n, 'the run counts across epochs');
    }
    assert.equal(loop.blocked.length, 1, 'the third identical failure records the blocker');
    assert.match(loop.blocked[0], /^Dispatch failed 3 consecutive times with the same cause since .*, so the master loop stopped redispatching GY-7: Worker launch failed: the worktree for GY-7 epoch N could not be created: .*fatal: 'graphyard\/gy-7-N' is already used by worktree at '\/repo\/\.graphyard\/worktrees\/GY-7-N'/);
    assert.equal(items[0].blocker, loop.blocked[0]);
    assert.equal(state.dispatchFailures['item-7'], undefined, 'the run is retired once the blocker is recorded');
    const escalation = Object.entries(state.actions).find(([key]) => key.startsWith('escalation:dispatch-failures:item-7:'))![1];
    assert.equal(escalation.state, 'done'); assert.match(escalation.detail, /^Recorded the blocker on GY-7: Dispatch failed 3 consecutive times/);

    for (let n = 0; n < 3; n++) await cycle();
    assert.equal(attempts, dispatchFailureBlockAfter, 'a blocked item is dispatched no further');

    // The operator clears the blocker once the cause is fixed: the next cycle dispatches it, and it lands.
    items[0].blocker = null; failing = false;
    await cycle();
    assert.equal(attempts, dispatchFailureBlockAfter + 1, 'dispatch resumes once the blocker clears');
    assert.match(Object.values(state.actions).find(action => action.kind === 'dispatch' && action.state === 'done')?.detail ?? '', /; freed its branch by reclaiming \/repo\/\.graphyard\/worktrees\/GY-7-2: aborted the rebase and removed the worktree$/, 'the dispatch record names what the launch reclaimed');
    assert.equal(state.dispatchFailures['item-7'], undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a changed cause starts a new run, and the run outlives the epochs its failures spent', () => {
  const failure = (epoch: number, holder: string) => `Command failed: node cli worktree GY-859 ${epoch} ${'a'.repeat(40)}\nfatal: 'graphyard/gy-859-1' is already used by worktree at '/r/.graphyard/worktrees/GY-859-${holder}' (epoch ${epoch})`;
  assert.equal(dispatchFailureCause({ key: 'GY-859' }, failure(113, '2')), dispatchFailureCause({ key: 'GY-859' }, failure(154, '2')));
  assert.equal(dispatchFailureCause({ key: 'GY-859' }, 'no worker profile can take GY-859'), 'no worker profile can take GY-859');
  assert.notEqual(dispatchFailureCause({ key: 'GY-859' }, failure(113, '2')), dispatchFailureCause({ key: 'GY-859' }, 'fatal: not a git repository'));
});

test('a repeated failure that spent no epoch, refused before any claim, never reaches the bound', () => {
  const state = { dispatchFailures: {} } as Parameters<typeof noteDispatchFailure>[0];
  const work = { id: 'item-7', key: 'GY-7', epoch: 4 };
  for (let n = 0; n < 5; n++) noteDispatchFailure(state, work, 'Dispatch blocked by exclusive resources: db held by GY-8', new Date(n * 60_000).toISOString());
  assert.equal(state.dispatchFailures['item-7'].count, 1, 'the snapshot epoch never moved, so the run stays at its first failure');
  for (const epoch of [5, 6]) noteDispatchFailure(state, { ...work, epoch }, 'Dispatch blocked by exclusive resources: db held by GY-8', new Date().toISOString());
  assert.equal(state.dispatchFailures['item-7'].count, dispatchFailureBlockAfter, 'failures that each followed a spent epoch count');
});

// GY-1082: follow-ups from the review of GY-1078.

/** A session worktree of GY-7 at `.graphyard/worktrees/GY-7-EPOCH` on `branch`, with one commit of its own. */
async function sessionHolder(root: string, epoch: number, branch: string) {
  const path = join(root, '.graphyard', 'worktrees', `GY-7-${epoch}`);
  await mkdir(join(root, '.graphyard', 'worktrees'), { recursive: true });
  git(root, 'worktree', 'add', '-q', path, branch);
  await writeFile(join(path, `epoch-${epoch}.txt`), 'work\n'); git(path, 'add', '.'); git(path, 'commit', '-q', '-m', `epoch ${epoch}`);
  return path;
}
const abandoned = { key: 'GY-7', lease: null };

test('a bisect holder is reset without an unsupported flag, and a holder with ignored files is detached rather than removed so they survive', async () => {
  const branch = 'graphyard/gy-7-3';
  const root = await repository(branch);
  try {
    const target = join(root, '.graphyard', 'worktrees', 'GY-7-3');
    const bisecting = await sessionHolder(root, 1, branch);
    git(bisecting, 'bisect', 'start'); git(bisecting, 'bisect', 'bad'); git(bisecting, 'bisect', 'good', 'HEAD~1');
    assert.deepEqual(branchHolders(root, branch, target).map(entry => entry.via), ['bisect']);
    const [bisect] = reclaimBranchHolders(root, branch, target, abandoned, Date.now(), { checkouts: false });
    assert.equal(bisect.action, 'aborted the bisect and removed the worktree');
    assert.ok(!existsSync(bisecting));

    const rebasing = join(root, '.graphyard', 'worktrees', 'GY-7-2');
    await rebasingHolder(root, rebasing, branch);
    await mkdir(join(root, '.git', 'info'), { recursive: true }); await writeFile(join(root, '.git', 'info', 'exclude'), 'secret.env\n');
    await writeFile(join(rebasing, 'secret.env'), 'TOKEN=local-only\n');
    const [kept] = reclaimBranchHolders(root, branch, target, abandoned, Date.now(), { checkouts: false });
    assert.match(kept.action, /^aborted the rebase and detached its HEAD \(it holds ignored files, which removing it would delete\)$/);
    assert.ok(existsSync(join(rebasing, 'secret.env')), 'the ignored file survives');
    assert.deepEqual(branchHolders(root, branch, target), [], 'the branch is free');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a rework reclaim keeps the aborted holder\'s unpushed tip under a ref before the branch is reset', async () => {
  const branch = 'graphyard/gy-7-1';
  const root = await repository(branch);
  try {
    const holder = join(root, '.graphyard', 'worktrees', 'GY-7-2'), target = join(root, '.graphyard', 'worktrees', 'GY-7-3');
    await mkdir(join(root, '.graphyard', 'worktrees'), { recursive: true });
    git(root, 'update-ref', `refs/remotes/origin/${branch}`, branch);
    await rebasingHolder(root, holder, branch);
    const [reclaimed] = reclaimBranchHolders(root, branch, target, abandoned, Date.now(), { checkouts: true });
    const tip = git(root, 'rev-parse', branch);
    assert.equal(git(root, 'log', '-1', '--format=%s', tip), 'two', 'the abort left the branch on the abandoned commit');
    assert.equal(reclaimed.action, `aborted the rebase, kept its tip ${tip.slice(0, 12)} as refs/graphyard/reclaimed/GY-7-2 and removed the worktree`);
    git(root, 'branch', '-f', branch, `refs/remotes/origin/${branch}`);
    assert.equal(git(root, 'rev-parse', 'refs/graphyard/reclaimed/GY-7-2'), tip, 'the commit is still referenced after the reset');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the record of a deleted session worktree is removed on a first attempt, and an ordinary checkout is judged like an operation: a dirty one is named, a clean one detached, and one outside the sessions keeps the rework path\'s detach', async () => {
  const branch = 'graphyard/gy-7-3';
  const root = await repository(branch);
  try {
    const target = join(root, '.graphyard', 'worktrees', 'GY-7-3');
    const deleted = await sessionHolder(root, 1, branch);
    await rm(deleted, { recursive: true, force: true });
    assert.deepEqual(branchHolders(root, branch, target).map(entry => [entry.via, entry.missing]), [['checkout', true]]);
    const [pruned] = reclaimBranchHolders(root, branch, target, abandoned, Date.now(), { checkouts: false });
    assert.equal(pruned.action, 'removed the record of the deleted worktree');
    git(root, 'worktree', 'add', '-q', target, branch);
    git(root, 'worktree', 'remove', target);

    const checkout = await sessionHolder(root, 2, branch);
    await writeFile(join(checkout, 'a.txt'), 'unsaved\n');
    assert.throws(() => reclaimBranchHolders(root, branch, target, abandoned, Date.now(), { checkouts: true }), new RegExp(`${checkout} \\(checked out\\) has uncommitted changes`));
    assert.equal(git(checkout, 'symbolic-ref', '--short', 'HEAD'), branch, 'the dirty checkout is left on the branch');
    git(checkout, 'checkout', '--', 'a.txt');
    await writeFile(join(checkout, 'scratch.txt'), 'scratch\n');
    const [detached] = reclaimBranchHolders(root, branch, target, abandoned, Date.now(), { checkouts: true });
    assert.equal(detached.action, 'detached its HEAD', 'an untracked file, which a detach cannot touch, does not hold the checkout');
    assert.ok(existsSync(join(checkout, 'scratch.txt')));

    const foreign = join(root, '..', `${root.split('/').at(-1)}-foreign`);
    git(root, 'worktree', 'add', '-q', foreign, branch);
    try {
      await writeFile(join(foreign, 'a.txt'), 'unsaved\n');
      assert.throws(() => reclaimBranchHolders(root, branch, target, abandoned, Date.now(), { checkouts: true }), new RegExp(`${foreign} \\(checked out\\) has uncommitted changes`));
      assert.equal(git(foreign, 'symbolic-ref', '--short', 'HEAD'), branch, 'the dirty foreign checkout is left on the branch');
      git(foreign, 'checkout', '--', 'a.txt');
      const [earlier] = reclaimBranchHolders(root, branch, target, abandoned, Date.now(), { checkouts: true });
      assert.equal(earlier.action, 'detached its HEAD', 'a clean earlier checkout outside the sessions is detached, as the rework path always did');
      assert.throws(() => git(foreign, 'symbolic-ref', '--short', 'HEAD'));
    } finally { git(root, 'worktree', 'remove', '--force', foreign); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failure run is retired when the snapshot shows the item blocked, claimed by another dispatcher, or past an epoch this loop did not spend', async () => {
  const directory = await temporaryDirectory('gy-1082-loop');
  try {
    const credential = join(directory, 'coordinator.token'); await writeFile(credential, coordinatorToken, { mode: 0o600 });
    const config = loopConfig(credential);
    const run = (epoch: number, count: number) => ({ key: 'GY-7', cause: 'Worker launch failed: fatal: held', count, epoch, firstAt: new Date().toISOString(), lastAt: new Date().toISOString() });
    const cases: [string, Partial<Work>, number][] = [
      // The loop recorded the blocker and stopped before forgetting the run: the unblock must not re-record it.
      ['blocked', { epoch: 3, blocker: 'Dispatch failed 3 consecutive times' }, 3],
      ['claimed by another executor', { epoch: 4, lease: { owner: 'executor', epoch: 4, expiresAt: new Date(Date.now() + 600_000).toISOString() } }, 3],
      ['launched by a hand dispatch in between', { epoch: 4 }, 2],
    ];
    for (const [name, overrides, count] of cases) {
      const state = emptyDaemonState(config);
      state.dispatchFailures['item-7'] = run(2, count);
      let dispatched = 0;
      const loop = loopEffects([ready(overrides)], async () => { dispatched++; return { pane: null }; });
      await runCycle(config, state, loop.effects, loop.clock);
      assert.equal(state.dispatchFailures['item-7'], undefined, `${name}: the run is retired`);
      assert.deepEqual(loop.blocked, [], `${name}: no blocker is recorded from the stale run`);
      if (!overrides.blocker && !overrides.lease) assert.equal(dispatched, 1, `${name}: the item is dispatched afresh`);
    }
    // A run the last failure spent the epoch of stands.
    const state = emptyDaemonState(config);
    state.dispatchFailures['item-7'] = run(2, 2);
    const loop = loopEffects([ready({ epoch: 3 })], async () => { throw new Error('Worker launch failed: fatal: held'); });
    await runCycle(config, state, loop.effects, loop.clock);
    assert.equal(loop.blocked.length, 1, 'consecutive failures still reach the bound');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('dispatchblock is refused off a dispatchable stage, over a standing blocker, or without failed attempts on the record, and names the attempts it verified', async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1082;
  const database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('gy-1082-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`);
  try {
    await store.init();
    const human: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' }, worker: Principal = { id: 'engineer-a', role: 'worker', sessionKind: 'ai' }, loop: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
    const engine = new Engine(store, [15368], 120, 'owner/project'); engine.principals = [human, worker, loop];
    const refused = (work: Work, pattern: RegExp) => assert.rejects(engine.execute(loop, 'dispatchblock', work.id, { reason: 'fatal: held' }, randomUUID()), pattern);
    let work = await engine.execute(human, 'create', null, { title: 'held', plannedFiles: ['src/held.ts'], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }] }, randomUUID());
    await refused(work, /not awaiting a dispatch/);
    work = await engine.execute(human, 'ready', work.id, {}, randomUUID());
    await refused(work, /did not each end without a submission/);
    for (let n = 0; n < dispatchFailureBlockAfter; n++) {
      work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
      if (n < dispatchFailureBlockAfter - 1) await refused(work, /is held by engineer-a/);
      work = await engine.execute(worker, 'release', work.id, { epoch: work.epoch }, randomUUID());
    }
    work = await engine.execute(loop, 'dispatchblock', work.id, { reason: 'Dispatch failed 3 consecutive times: fatal: held' }, randomUUID());
    assert.equal(work.blocker, 'Dispatch failed 3 consecutive times: fatal: held [attempts 1, 2, 3 each ended without a submission]');
    await refused(work, /already carries a blocker/);
  } finally { await store.close(); await database.stop(); }
});
