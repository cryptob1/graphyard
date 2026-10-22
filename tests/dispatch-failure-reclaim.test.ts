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
import { branchHolders, reclaimBranchHolders } from '../src/worktree-holders.js';
import type { Work } from '../src/model.js';
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
    response.end(JSON.stringify(request.url === `/api/work/${item.key}` || request.url === `/api/work/${item.id}` ? item : [item]));
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
      if (args[1] === 'unclaim') { released.push(args[3]); return '{}'; }
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
    assert.match(recorded.detail, /^Dispatch of GY-7 to one failed: Worker launch failed: .*fatal: '.*GY-7-3' already exists.*; it is retried next cycle$/);
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
    policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], ...overrides } as Work;
}
/** The loop's effects over one item the control plane holds. */
function loopEffects(work: Work[], dispatch: DaemonEffects['dispatch']) {
  let offsetMs = 0;
  const effects: DaemonEffects = {
    agents: () => [], credentials: async items => Object.fromEntries(items.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: structuredClone(work), now: new Date(Date.now() + offsetMs).toISOString() }),
    closeSession: () => {}, dispatch, persist: async () => {},
  };
  return { effects, clock: () => Date.now() + offsetMs, advance: (ms: number) => { offsetMs += ms; } };
}

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
