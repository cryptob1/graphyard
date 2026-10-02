import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { pipelineTimeline } from '../src/pipeline-speed.js';
import { releaseHeldBranch } from '../src/master/worktrees.js';
import { runChild } from '../src/child-runner.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, prepareWorkerLaunch, saveWorkerProfile, setupMaster, type MasterConfig } from '../src/master.js';
import { workerCommand, workspaceDispatchFailure } from '../src/master/dispatch.js';
import { workspaceCommands } from '../src/cli/workspace.js';
import type { CliContext } from '../src/cli/context.js';
import type { Principal, Work } from '../src/model.js';

// Each test is named for the proof it produces (GY-860): unit:stale-worktree-releases-branch
// (AC-1) and unit:workspace-failure-spares-profile (AC-2). AC-1: an earlier attempt's worktree
// that still holds the branch — checked out, or stopped inside a rebase, merge or cherry-pick —
// never fails the next allocation: its state is preserved, the operation is ended, its HEAD is
// detached, and the branch ref never moves. AC-2: a dispatch that fails for a host-side reason
// about the item's own workspace neither advances the attempt epoch nor cools off the profile.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const workerToken = 'worker-token-'.padEnd(40, 'x');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const symbolicRef = (cwd: string) => spawnSync('git', ['-C', cwd, 'symbolic-ref', '-q', 'HEAD'], { stdio: ['ignore', 'ignore', 'pipe'] }).status;

/** A host repository with one file, the way an assignment checkout carries one. */
async function host() {
  const root = await temporaryDirectory('branch-lock');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  for (const [key, value] of [['user.email', 'branch-lock@example.com'], ['user.name', 'Branch Lock Test'], ['commit.gpgsign', 'false']]) execFileSync('git', ['config', key, value], { cwd: root });
  await writeFile(join(root, 'source.ts'), 'export const value = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  return root;
}
/** An assignment worktree on its own branch, exactly as an earlier attempt's launcher creates one. */
function attemptWorktree(root: string, key: string, epoch: number) {
  const path = join(root, '.graphyard', 'worktrees', `${key}-${epoch}`);
  const branch = `graphyard/${key.toLowerCase()}-${epoch}`;
  execFileSync('git', ['worktree', 'add', '-q', '-b', branch, path, 'main'], { cwd: root });
  return { path, branch };
}
const worktreePath = (root: string, key: string, epoch: number) => join(root, '.graphyard', 'worktrees', `${key}-${epoch}`);

test('unit:stale-worktree-releases-branch — a rebase left running in an earlier attempt\'s worktree no longer fails the next allocation: the hold is released with its state preserved and the branch ref never moves', async () => {
  const root = await host();
  try {
    const old = attemptWorktree(root, 'GY-860', 1);
    const branch = old.branch;
    // The attempt committed work on its branch, then a conflicting base commit landed on main and
    // the worker's rebase stopped mid-way — the exact state that failed the GY-807 dispatches.
    await writeFile(join(old.path, 'source.ts'), 'export const value = 2;\n');
    execFileSync('git', ['commit', '-qam', 'attempt work'], { cwd: old.path });
    const heldTip = git(root, 'rev-parse', branch);
    await writeFile(join(root, 'source.ts'), 'export const value = 3;\n');
    execFileSync('git', ['commit', '-qam', 'base moved'], { cwd: root });
    const stopped = spawnSync('git', ['rebase', 'main'], { cwd: old.path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.notEqual(stopped.status, 0, 'the rebase must stop mid-way for this test to mean anything');
    // Uncommitted work beside the conflict, tracked and untracked: the record keeps it all.
    await writeFile(join(old.path, 'note.txt'), 'kept\n');
    execFileSync('git', ['add', 'note.txt'], { cwd: old.path });
    await writeFile(join(old.path, 'scratch.txt'), 'untracked\n');

    // The next allocation releases the hold and records what the old worktree carried.
    const newPath = worktreePath(root, 'GY-860', 2);
    const released = await releaseHeldBranch(root, branch, newPath, runChild);
    assert.ok(released, 'the hold on the branch is found');
    assert.equal(released.reused, false);
    assert.equal(released.preserved.op, 'rebase');
    assert.equal(released.preserved.branchTip, heldTip, 'the record carries the branch commit the attempt held');
    assert.match(released.preserved.head, /^[0-9a-f]{40}$/, 'the holder head is a commit');
    assert.match(released.preserved.diff, /note\.txt/, 'the uncommitted tracked work is in the record');
    assert.match(released.preserved.diff, /scratch\.txt/, 'the untracked work is named in the record');
    assert.match(released.preserved.refs, new RegExp(branch.replace('graphyard/', '')), 'the refs are in the record');
    // The branch ref never moved, and the old worktree is detached with nothing in progress.
    assert.equal(git(root, 'rev-parse', branch), heldTip, 'the branch stays at its prior commit');
    assert.notEqual(symbolicRef(old.path), 0, 'the old worktree\'s HEAD is detached');
    assert.equal(existsSync(gitPath(old.path, 'rebase-merge')), false, 'the rebase is over');
    // The allocation that used to fail now succeeds, on the branch at its prior commit.
    execFileSync('git', ['worktree', 'add', '-q', newPath, branch], { cwd: root });
    assert.equal(git(newPath, 'rev-parse', 'HEAD'), heldTip);

    // The same epoch allocated again finds its own worktree holding the branch: it is kept,
    // re-attached, and reported as reused, so creation is skipped instead of failing.
    const again = await releaseHeldBranch(root, branch, newPath, runChild);
    assert.ok(again);
    assert.equal(again.reused, true);
    assert.equal(git(newPath, 'symbolic-ref', '--short', 'HEAD'), branch, 'the reused worktree is back on the branch');
    assert.equal(git(root, 'rev-parse', branch), heldTip);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:stale-worktree-releases-branch — a stopped merge or cherry-pick holds the branch the same way, and the allocation ends it and detaches the holder', async () => {
  const root = await host();
  try {
    for (const [key, epoch, operation, baseValue] of [['GY-861', 4, 'merge', 4], ['GY-862', 5, 'cherry-pick', 5]] as const) {
      const old = attemptWorktree(root, key, epoch);
      await writeFile(join(old.path, 'source.ts'), 'export const value = 2;\n');
      execFileSync('git', ['commit', '-qam', 'attempt work'], { cwd: old.path });
      // The base branch moves under the attempt with a change of its own, so ending the
      // operation must stop on a real conflict.
      await writeFile(join(root, 'source.ts'), `export const value = ${baseValue};\n`);
      execFileSync('git', ['commit', '-qam', 'base moved again'], { cwd: root });
      const heldTip = git(root, 'rev-parse', old.branch);
      const stopped = spawnSync('git', [operation, 'main'], { cwd: old.path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      assert.notEqual(stopped.status, 0, `${operation} must stop mid-way for this test to mean anything`);
      const newPath = worktreePath(root, key, epoch + 1);
      const released = await releaseHeldBranch(root, old.branch, newPath, runChild);
      assert.ok(released);
      assert.equal(released.reused, false);
      assert.equal(released.preserved.op, operation === 'merge' ? 'merge' : 'cherry-pick');
      assert.equal(released.preserved.branchTip, heldTip);
      assert.equal(git(root, 'rev-parse', old.branch), heldTip, 'the branch ref never moves');
      assert.notEqual(symbolicRef(old.path), 0, 'the old worktree is detached');
      execFileSync('git', ['worktree', 'add', '-q', newPath, old.branch], { cwd: root });
      assert.equal(git(newPath, 'rev-parse', 'HEAD'), heldTip);
    }
    // A cherry-pick sequence stopped on its second pick has already moved the branch by the
    // first: ending it keeps that commit, where aborting would move the branch back.
    const old = attemptWorktree(root, 'GY-864', 1);
    await writeFile(join(old.path, 'source.ts'), 'export const value = 2;\n');
    execFileSync('git', ['commit', '-qam', 'attempt work'], { cwd: old.path });
    await writeFile(join(root, 'other.ts'), 'export const other = 1;\n');
    execFileSync('git', ['add', 'other.ts'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'clean pick'], { cwd: root });
    await writeFile(join(root, 'source.ts'), 'export const value = 7;\n');
    execFileSync('git', ['commit', '-qam', 'conflicting pick'], { cwd: root });
    assert.notEqual(spawnSync('git', ['cherry-pick', 'main~1', 'main'], { cwd: old.path, stdio: 'ignore' }).status, 0, 'the sequence must stop on its second pick');
    const picked = git(root, 'rev-parse', old.branch);
    assert.equal(git(root, 'log', '-1', '--format=%s', old.branch), 'clean pick', 'the first pick is already on the branch');
    const sequence = await releaseHeldBranch(root, old.branch, worktreePath(root, 'GY-864', 2), runChild);
    assert.equal(sequence?.preserved.op, 'cherry-pick');
    assert.equal(git(root, 'rev-parse', old.branch), picked, 'the branch keeps the pick the sequence already committed');
    assert.notEqual(symbolicRef(old.path), 0, 'the old worktree is detached');
    assert.equal(git(old.path, 'status', '--porcelain'), '', 'the stopped pick is ended, its conflict preserved in the record');
  } finally { await rm(root, { recursive: true, force: true }); }
});

/** An earlier attempt's worktree stopped inside a conflicting rebase of its branch. */
async function stoppedRebase(root: string, key: string, epoch: number) {
  const old = attemptWorktree(root, key, epoch);
  await writeFile(join(old.path, 'source.ts'), 'export const value = 2;\n');
  execFileSync('git', ['commit', '-qam', 'attempt work'], { cwd: old.path });
  await writeFile(join(root, 'source.ts'), `export const value = ${epoch + 10};\n`);
  execFileSync('git', ['commit', '-qam', 'base moved'], { cwd: root });
  assert.notEqual(spawnSync('git', ['rebase', 'main'], { cwd: old.path, stdio: 'ignore' }).status, 0, 'the rebase must stop mid-way');
  return old;
}

test('unit:stale-worktree-releases-branch — the preserved state is registered before the holder is touched: a refused registration leaves it as it was, and a failed abort rejects the release', async () => {
  const root = await host();
  try {
    const old = await stoppedRebase(root, 'GY-863', 1);
    // A huge uncommitted diff is kept within the ledger's limit, truncation notice included.
    await writeFile(join(old.path, 'large.txt'), 'x'.repeat(150_000));
    execFileSync('git', ['add', 'large.txt'], { cwd: old.path });
    const refused = releaseHeldBranch(root, old.branch, worktreePath(root, 'GY-863', 2), runChild, async preserved => {
      assert.ok(preserved);
      assert.ok(preserved.diff.length <= 100_000, 'a truncated diff still fits the schema limit');
      assert.match(preserved.diff, /truncated to 100000 characters$/);
      throw new Error('Branch or host/path is already reserved or overlaps a reservation; use a fresh workspace');
    });
    await assert.rejects(refused, /already reserved/);
    assert.equal(existsSync(gitPath(old.path, 'rebase-merge')), true, 'a refused registration leaves the rebase in progress');

    // A step that changes the holder and fails rejects the release instead of reporting it done.
    let registered = 0;
    const failingAbort = async (command: string, args: string[]) => {
      if (args.includes('--abort')) throw new Error('fatal: could not abort the rebase');
      return runChild(command, args);
    };
    await assert.rejects(releaseHeldBranch(root, old.branch, worktreePath(root, 'GY-863', 2), failingAbort, async () => { registered++; }), /could not abort/);
    assert.equal(registered, 1, 'the state was recorded before the failing step');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:workspace-failure-spares-profile — the engine keeps the preserved-attempt record on the item and undoes a workspace-failed claim, so the epoch returns', async () => {
  const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
  const worker: Principal = { id: 'engineer-a', role: 'worker', sessionKind: 'ai' };
  const id = () => randomUUID();
  const input = (title: string) => ({ title, plannedFiles: [`src/${title}.ts`], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }] });
  const claimed = async (actor: Principal = worker) => {
    let work = await engine.execute(operator, 'create', null, input(randomUUID()), id());
    work = await engine.execute(operator, 'ready', work.id, {}, id());
    return engine.execute(actor, 'claim', work.id, {}, id());
  };
  const events = async (work: Work, kind: string) => (await store.pool.query('SELECT kind, payload FROM events WHERE work_id=$1 AND kind=$2 ORDER BY seq', [work.id, kind])).rows as { kind: string; payload: any }[];

  // AC-1's record: the allocation that released a holder keeps its refs and diff on the ledger.
  let held = await claimed();
  held = await engine.execute(worker, 'workspace', held.id, {
    epoch: held.epoch, host: 'lock-host', path: `/tmp/lock/${held.id}`, branch: `graphyard/${held.key.toLowerCase()}-${held.epoch}`,
    preserved: { path: '/tmp/lock/older', head: 'a'.repeat(40), branchTip: 'b'.repeat(40), op: 'rebase', refs: 'refs/heads/main main-tip', diff: 'diff --git a/source.ts b/source.ts\n…', at: new Date().toISOString() },
  }, id());
  assert.equal((await events(held, 'workspace.preserved')).length, 1, 'the preserved-attempt record is on the item');
  assert.deepEqual((await events(held, 'workspace.preserved'))[0].payload.details.diff.includes('source.ts'), true);
  assert.equal(held.workspaces[0] && 'preserved' in held.workspaces[0], false, 'the workspace reservation itself stays clean of the payload');

  // AC-2: a claim whose worktree the host could not create is undone by its release — the epoch
  // returns, the untouched reservation and timeline entry go, the lease is released, the message
  // is kept on the item.
  let item = await claimed();
  const firstEpoch = item.epoch;
  item = await engine.execute(worker, 'workspace', item.id, { epoch: firstEpoch, host: 'lock-host', path: `/tmp/lock/${item.id}`, branch: `graphyard/${item.key.toLowerCase()}-${firstEpoch}` }, id());
  const message = 'Git worktree creation failed: fatal: \'graphyard/x\' is already used by worktree at .graphyard/worktrees/x. The workspace reservation remains for safety';
  item = await engine.execute(worker, 'release', item.id, { epoch: firstEpoch, failure: { message } }, id());
  assert.equal(item.epoch, firstEpoch - 1, 'the attempt epoch returns');
  assert.equal(item.lease, null, 'the claim is released');
  assert.deepEqual(item.workspaces, [], 'the untouched reservation goes with it');
  assert.deepEqual(pipelineTimeline(item).attempts, [], 'no attempt is recorded for a workspace that never existed');
  const failures = await events(item, 'workspace.failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].payload.details.message, message, 'the git message is on the item');
  // The next dispatch claims the same epoch afresh, and the branch is free to allocate again.
  const again = await engine.execute(worker, 'claim', item.id, {}, id());
  assert.equal(again.epoch, firstEpoch, 'the same epoch is claimed again, not the next one');

  // An attempt whose lease was renewed is no longer the untouched claim: a workspace failure it
  // reports is recorded, but its epoch is only ended, never handed back for reuse.
  let renewed = await claimed();
  const renewedEpoch = renewed.epoch;
  await new Promise(resolve => setTimeout(resolve, 5));
  renewed = await engine.execute(worker, 'heartbeat', renewed.id, { epoch: renewedEpoch }, id());
  renewed = await engine.execute(worker, 'release', renewed.id, { epoch: renewedEpoch, failure: { message: 'Git worktree creation failed: late' } }, id());
  assert.equal(renewed.epoch, renewedEpoch, 'a renewed attempt keeps its epoch');
  assert.equal(pipelineTimeline(renewed).attempts.at(-1)?.end, 'released');
  assert.equal((await events(renewed, 'workspace.failed')).length, 1);

  // A release naming another epoch reaches nothing: the live lease is the one it must name.
  let worked = await claimed();
  const workedEpoch = worked.epoch;
  worked = await engine.execute(worker, 'workspace', worked.id, { epoch: workedEpoch, host: 'lock-host', path: `/tmp/lock/${worked.id}`, branch: `graphyard/${worked.key.toLowerCase()}-${workedEpoch}` }, id());
  await engine.execute(worker, 'release', worked.id, { epoch: workedEpoch }, id());
  const next = await engine.execute(worker, 'claim', worked.id, {}, id());
  assert.equal(next.epoch, workedEpoch + 1);
  await assert.rejects(engine.execute(worker, 'release', worked.id, { epoch: workedEpoch, failure: { message: 'stale epoch' } }, id()), /Lease missing, expired, or superseded/);
});

test('unit:workspace-failure-spares-profile — the loop cools off no profile for a workspace failure and keeps the git message on the item\'s record; any other failure still does', async () => {
  const home = await temporaryDirectory('branch-lock-home');
  const config: MasterConfig = masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile: join(home, 'coordinator.token'), cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 4242, hostId: 'lock-host', masterAgentName: 'graphyard-master-lock',
    workers: [{ name: 'builder', principal: 'worker-a', agentName: 'agent-builder', mode: 'launch', kind: 'claude' as const, credentialFile: join(home, 'builder.token') }],
    run: { intervalSeconds: 20 },
  });
  const item = (epoch: number): Work => ({
    id: `id-gy-860-${epoch}`, key: `GY-86${epoch}`, title: `Item ${epoch}`, description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'build', revision: 1, policyRevision: 1, createdAt: '', updatedAt: '', stageEnteredAt: new Date().toISOString(),
    ready: true, epoch, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [],
  } as Work);
  const effectsWith = (failure: () => Promise<never>): DaemonEffects => ({
    agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: [], now: new Date().toISOString() }),
    closeSession: () => {}, dispatch: failure, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
  });
  const cycle = async (effects: DaemonEffects, items: Work[]) => {
    const state = emptyDaemonState(config);
    await runCycle(config, state, { ...effects, snapshot: async () => ({ work: items, now: new Date().toISOString() }) }, () => Date.now());
    return state;
  };

  // A workspace failure: the profile stays healthy and the record names the workspace, not the profile.
  const workspaceBroken = effectsWith(async () => { throw new Error('Git worktree creation failed: fatal: \'graphyard/gy-860-3\' is already used by worktree at .graphyard/worktrees/GY-860-2. The workspace reservation remains for safety'); });
  const spared = await cycle(workspaceBroken, [item(3)]);
  assert.equal(spared.profiles['builder'], undefined, 'no failure cool-off for a workspace failure');
  const kept = spared.actions[`dispatch:${item(3).id}:3`];
  assert.equal(kept.state, 'failed');
  assert.match(kept.detail, /already used by worktree/, 'the git message is on the item\'s record');
  assert.match(kept.detail, /workspace could not be prepared/, 'the record says the workspace, not the profile, failed');
  // The epoch came back, so the next dispatch reuses the same key: it waits out a doubling backoff
  // instead of retrying the same host git state every cycle.
  let launches = 0;
  const counted = effectsWith(async () => { launches++; throw new Error('Git worktree creation failed: fatal: still held'); });
  const retried = { ...spared, cycle: spared.cycle };
  const snapshotOf = { ...counted, snapshot: async () => ({ work: [item(3)], now: new Date().toISOString() }) };
  await runCycle(config, retried, snapshotOf, () => Date.now());
  assert.equal(launches, 0, 'the very next cycle does not retry a workspace failure');
  retried.cycle += 5;
  await runCycle(config, retried, snapshotOf, () => Date.now());
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(launches, 1, 'once the backoff has passed the item is dispatched again');

  // Any other launch failure still puts the profile into its cool-off.
  const credentialGone = effectsWith(async () => { throw new Error('Worker credential is unavailable: the token was refused'); });
  const cooled = await cycle(credentialGone, [item(4)]);
  assert.ok(cooled.profiles['builder']?.cooldownUntil, 'a profile-shaped failure still cools the profile off');
  assert.match(cooled.actions[`dispatch:${item(4).id}:4`].detail, /token was refused/);
  await rm(home, { recursive: true, force: true });
});

test('unit:workspace-failure-spares-profile — the launcher tolerates a claim the worktree command already released as a workspace failure, and wraps only a release that could not reach the server', async () => {
  const root = await temporaryDirectory('branch-lock-launch');
  const credentialDirectory = await temporaryDirectory('branch-lock-credentials');
  const credential = join(credentialDirectory, 'worker.token');
  const calls: string[][] = [];
  const base = 'c'.repeat(40);
  const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    await writeFile(credential, workerToken, { mode: 0o600 });
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory }, coordinatorStatus as typeof fetch);
    await saveWorkerProfile(root, { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: credential }, async () => ({ actor: { id: 'worker-a', role: 'worker' } }));
    const run = (worktreeError?: string, releaseError?: string) => (command: string, args: string[]) => {
      calls.push(args);
      if (command === 'git') return args[0] === 'rev-parse' ? `${base}\n` : '';
      if (args[1] === 'claim') return JSON.stringify({ epoch: 9, lease: { owner: 'worker-a' } });
      if (args[1] === 'worktree' && worktreeError) throw new Error(`Command failed: worktree GY-860 9 main\n${worktreeError}`);
      if (args[1] === 'release' && releaseError) throw new Error(`Command failed: ${launcher} release GY-860 9\n${releaseError}`);
      return JSON.stringify({ path: join(root, 'assigned') });
    };
    // A branch an earlier attempt still holds: the worktree command fails with the git message and
    // has already released the claim as a workspace failure, so the launcher's release is a no-op
    // and the original failure is what propagates.
    const held = 'Git worktree creation failed: fatal: \'graphyard/gy-860-9\' is already used by worktree at .graphyard/worktrees/GY-860-8. The claim was released as a workspace failure, so the attempt costs nothing; inspect the event and repair the host before it redispatches.';
    await assert.rejects(prepareWorkerLaunch(root, 'GY-860', 'launch', run(held, 'Lease missing, expired, or superseded; claim the task again')), /already used by worktree/);
    assert.equal(calls.at(-1)![1], 'release');
    assert.equal(calls.filter(entry => entry[1] === 'release').length, 1, 'one release, tolerated as already done');
    // Through the real child runner: the worktree command runs with the options the launcher
    // passes, and its git message — written to its stderr, as the CLI reports a failure — is in the
    // error the dispatch cycle classifies, so the failure is recognized as the workspace's.
    const real = (command: string, args: string[], options?: Parameters<typeof workerCommand>[2]) => args[1] === 'worktree'
      ? workerCommand(process.execPath, ['-e', 'process.stderr.write(process.env.WORKTREE_FAILURE); process.exit(1)'], { ...options, env: { ...options?.env, WORKTREE_FAILURE: held } })
      : run(undefined, 'Lease missing, expired, or superseded; claim the task again')(command, args);
    const failure = await prepareWorkerLaunch(root, 'GY-860', 'launch', real).then(() => null, (error: unknown) => error);
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /^Command failed: /, 'the real ChildProcessError, not a stub');
    assert.equal(workspaceDispatchFailure(failure.message), true, 'the git message reaches the classifier');
    // A release that genuinely could not reach the server is wrapped, not swallowed.
    await assert.rejects(prepareWorkerLaunch(root, 'GY-860', 'launch', run('checkout failed', 'connect ECONNREFUSED')), /Graphyard could not release epoch 9/);
    // The classifier itself: workspace-shaped, and not.
    assert.equal(workspaceDispatchFailure('Git worktree creation failed: fatal: …'), true);
    assert.equal(workspaceDispatchFailure('Branch or host/path is already reserved or overlaps a reservation; use a fresh workspace'), true);
    assert.equal(workspaceDispatchFailure('Rework must use the already linked PR branch in a fresh workspace'), true);
    assert.equal(workspaceDispatchFailure('Worker credential is unavailable: the token was refused'), false);
    assert.equal(workspaceDispatchFailure('Dispatch blocked by active owner worker-a'), false);
    assert.equal(workspaceDispatchFailure('checkout failed'), false);
    assert.equal(workspaceDispatchFailure('Submitted PR branch changed; wait for Graphyard to observe its current head before creating the rework workspace'), true);
    // The launcher's own missing-path error comes after the worktree command reserved and released
    // nothing as a failure, so it is not claimed to spare the epoch.
    assert.equal(workspaceDispatchFailure('Worker launcher did not receive an assigned workspace'), false);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});

test('unit:workspace-failure-spares-profile — a rework whose PR branch moved or cannot be fetched releases the claim as a workspace failure before anything is reserved', async () => {
  const root = await host();
  const origin = await temporaryDirectory('branch-lock-origin');
  try {
    execFileSync('git', ['clone', '-q', '--bare', root, origin]);
    execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: root });
    const branch = 'graphyard/gy-870-1';
    execFileSync('git', ['--git-dir', origin, 'branch', branch, 'main']);
    const command = workspaceCommands.find(entry => entry.name === 'worktree')!;
    const drive = async (work: Record<string, unknown>) => {
      const calls: Array<[string, unknown]> = [];
      const context = {
        command: 'worktree', id: 'GY-870', args: ['2'], rest: [], base: 'http://graphyard.invalid', connection: null,
        api: async (path: string, data?: unknown) => { calls.push([path, data]); return path === 'status' ? {} : { ok: true }; },
        print: () => {}, individualToken: async () => undefined, individualHostId: () => 'lock-host', activeCliPath: async () => launcher, repositoryRoot: () => root,
      } satisfies CliContext;
      const outcome = await command.run(context, { id: 'work-870', key: 'GY-870', submission: { epoch: 1, pr: 7 }, workspaces: [{ epoch: 1, branch }], ...work }).then(() => null, (error: Error) => error);
      return { calls, outcome };
    };
    // The PR branch moved past the head Graphyard observed.
    const moved = await drive({ candidate: { sha: 'f'.repeat(40) } });
    assert.match(moved.outcome?.message ?? '', /Submitted PR branch changed.*released as a workspace failure/);
    assert.deepEqual(moved.calls.map(([path]) => path), ['status', 'work/work-870/release'], 'the claim is released, and nothing is reserved');
    assert.match((moved.calls[1][1] as { failure: { message: string } }).failure.message, /Submitted PR branch changed/);
    assert.equal((moved.calls[1][1] as { epoch: number }).epoch, 2);
    // The PR branch cannot be fetched at all.
    const missing = await drive({ workspaces: [{ epoch: 1, branch: 'graphyard/gy-870-9' }], candidate: { sha: 'f'.repeat(40) } });
    assert.match(missing.outcome?.message ?? '', /Git worktree creation failed while fetching graphyard\/gy-870-9/);
    assert.deepEqual(missing.calls.map(([path]) => path), ['status', 'work/work-870/release']);
    assert.ok(workspaceDispatchFailure(missing.outcome!.message) && workspaceDispatchFailure(moved.outcome!.message), 'both are workspace failures to the loop');
  } finally { await rm(root, { recursive: true, force: true }); await rm(origin, { recursive: true, force: true }); }
});

/** `git rev-parse --git-path` resolved inside the worktree it was asked in. */
function gitPath(cwd: string, name: string) {
  const printed = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-path', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return resolve(cwd, printed);
}

// The engine tests above run against a temporary real Postgres, isolated from every other file's.
let database: InstanceType<typeof EmbeddedPostgres>, store: Store, engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_BRANCH_LOCK_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 860);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('branch-lock-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`);
  await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.submissionObserver = null;
  engine.principals = [{ id: 'human-operator', role: 'admin', sessionKind: 'human' as const }, { id: 'engineer-a', role: 'worker', sessionKind: 'ai' as const }];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });
