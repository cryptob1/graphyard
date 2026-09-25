import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dependencyDirectories, diskExhaustion, diskPressure, diskPressureAttention, diskThresholdBytes, freeBytes, inventoryWorktrees, masterConfigSchema, planWorktreeReclaim, prepareWorkerLaunch, reclaimIdleMs, reclaimWorktrees, removeReclaimableWorktrees, statusWorktreeInventory, writeWorktreeInventoryCache, worktreeReclaimAuditFile, saveWorkerProfile, setupMaster, shareDependencies, sharedInstallSource, workerPrompt, worktreesDirectory, writeFailure, type MasterConfig, type MasterRun, type WorkerProfile } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import type { Work } from '../src/model.js';
import { runChild } from '../src/child-runner.js';

// GY-79: worktrees and their dependency trees filled the host's disk mid-cycle. The master loop
// now reclaims the dependency directories of finished assignments on its own, a fresh attempt
// shares one install instead of paying for a private copy, and master status asks for a reclaim
// while writes still succeed. Each test is named for the proof it produces.
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const workerToken = 'worker-token-'.padEnd(40, 'x');
const hour = 3_600_000;
const sharedMarker = 'module.exports = "shared";\n', privateMarker = 'module.exports = "private";\n';
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));

/** A host repository with one dependency install of its own, the way a real checkout carries one. */
async function host(remote = true) {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-reclaim-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  for (const [key, value] of [['user.email', 'reclaim@example.com'], ['user.name', 'Reclaim Test'], ['commit.gpgsign', 'false']]) execFileSync('git', ['config', key, value], { cwd: root });
  if (remote) execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await writeFile(join(root, '.gitignore'), 'node_modules/\n.graphyard/\n');
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ name: 'graphyard', lockfileVersion: 3, packages: {} }, null, 2));
  await writeFile(join(root, 'source.ts'), 'export const value = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: root }); execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  await install(root, sharedMarker);
  return root;
}
async function install(path: string, marker: string) {
  await mkdir(join(path, 'node_modules', 'pg'), { recursive: true });
  await writeFile(join(path, 'node_modules', 'pg', 'index.js'), marker);
}
/** An assignment worktree exactly as the launcher creates one: its own branch, checked out from main. */
function assignment(root: string, key: string, epoch: number) {
  const path = join(worktreesDirectory(root), `${key}-${epoch}`), branch = `graphyard/${key.toLowerCase()}-${epoch}`;
  execFileSync('git', ['worktree', 'add', '-q', '-b', branch, path, 'main'], { cwd: root });
  return { path, branch };
}
/** Backdate a worktree's working tree so the idle bound can be exercised without waiting hours. */
async function idleFor(path: string, ms: number) {
  const when = new Date(Date.now() - ms);
  for (const name of ['.gitignore', 'package-lock.json', 'source.ts', '.git']) await utimes(join(path, name), when, when).catch(() => {});
  await utimes(path, when, when);
}
const git = (path: string, ...args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf8' }).trim();
const exists = (path: string) => lstat(path).then(() => true, () => false);

function work(key: string, overrides: Partial<Work> = {}): Work {
  return { id: `id-${key}`, key, title: `Item ${key}`, description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'build', revision: 1, policyRevision: 1, createdAt: '', updatedAt: '', stageEnteredAt: new Date().toISOString(),
    ready: false, epoch: 1, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], ...overrides } as Work;
}
const workspace = (path: string, branch: string, epoch: number) => ({ host: 'vishrog', path, branch, epoch, owner: 'graphyard-worker-1' });
function config(credentialFile: string, run: Partial<MasterRun> = {}): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'vishrog',
    masterAgentName: 'graphyard-master-project', workers: [], run: { intervalSeconds: 20, ...run } });
}
function effects(overrides: Partial<DaemonEffects> = {}): DaemonEffects {
  return {
    agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: [], now: new Date().toISOString() }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {}, ...overrides,
  };
}

test('integration:worktree-reclaim — the loop removes the dependency trees of finished assignments and leaves every checkout, branch and workspace record intact', async () => {
  const root = await host(false), credentials = await mkdtemp(join(tmpdir(), 'graphyard-reclaim-credentials-'));
  try {
    const token = join(credentials, 'coordinator.token'); await writeFile(token, coordinatorToken, { mode: 0o600 });
    const master = config(token, { reclaimIdleHours: 3 });

    // Five assignments plus one worktree Graphyard has no record of at all.
    const delivered = assignment(root, 'GY-70', 1), superseded = assignment(root, 'GY-71', 1), live = assignment(root, 'GY-72', 1);
    const idle = assignment(root, 'GY-73', 1), recent = assignment(root, 'GY-74', 1), orphan = assignment(root, 'GY-75', 1);
    for (const { path } of [delivered, superseded, live, idle, recent, orphan]) await install(path, privateMarker);
    // The idle assignment holds work nobody has pushed: reclaiming must not cost it a single commit.
    await writeFile(join(idle.path, 'source.ts'), 'export const value = 2;\n');
    execFileSync('git', ['commit', '-qam', 'unpushed work'], { cwd: idle.path });
    const unpushed = git(idle.path, 'rev-parse', 'HEAD');
    assert.equal(git(root, 'rev-parse', idle.branch), unpushed, 'the branch is only on this host');

    // A live lease beats any idleness; everything finished is judged on its own facts.
    for (const { path } of [live, idle, orphan]) await idleFor(path, 4 * hour);
    await idleFor(recent.path, 10 * 60_000);
    const snapshot = [
      work('GY-70', { stage: 'done', workspaces: [workspace(delivered.path, delivered.branch, 1)] }),
      work('GY-71', { epoch: 2, workspaces: [workspace(superseded.path, superseded.branch, 1)] }),
      work('GY-72', { lease: { epoch: 1, owner: 'graphyard-worker-1', expiresAt: new Date(Date.now() + hour).toISOString() }, workspaces: [workspace(live.path, live.branch, 1)] }),
      work('GY-73', { workspaces: [workspace(idle.path, idle.branch, 1)] }),
      work('GY-74', { workspaces: [workspace(recent.path, recent.branch, 1)] }),
    ];
    const recorded = JSON.parse(JSON.stringify(snapshot));

    const plan = planWorktreeReclaim(await inventoryWorktrees(root), snapshot, { now: Date.now(), idleMs: reclaimIdleMs(master) });
    assert.deepEqual(plan.map(entry => [entry.name, entry.disposition, entry.disposable]), [
      ['GY-70-1', 'delivered', true], ['GY-71-1', 'superseded', true], ['GY-72-1', 'live', false],
      ['GY-73-1', 'idle', true], ['GY-74-1', 'recent', false], ['GY-75-1', 'idle', true],
    ]);
    assert.match(plan[2].detail, /holds the lease until/);
    assert.match(plan[3].detail, /Untouched for \d+ minutes, past the 180-minute idle bound/);

    // The loop reclaims on its own: no command is run, no credential is used, nothing is asked.
    const state = emptyDaemonState(master);
    const cycle = await runCycle(master, state, effects({
      snapshot: async () => ({ work: snapshot, now: new Date().toISOString() }),
      reclaim: items => reclaimWorktrees(root, items, { idleMs: reclaimIdleMs(master) }),
    }));
    const reclaimed = cycle.actions.filter(action => action.kind === 'reclaim');
    assert.equal(reclaimed.length, 1, 'one reclaim action per cycle that reclaims');
    assert.match(reclaimed[0].detail, /Reclaimed 4 dependency directories from 6 assignment worktree\(s\)/);
    assert.match(reclaimed[0].detail, /GB recovered/);
    assert.equal(reclaimed[0].state, 'done');
    assert.equal(state.reclaim!.removed, 4); assert.equal(state.reclaim!.kept, 2); assert.deepEqual(state.reclaim!.errors, []);

    // What is gone is exactly the dependency trees of the finished assignments.
    for (const { path } of [delivered, superseded, idle, orphan]) assert.equal(await exists(join(path, 'node_modules')), false, `${path} kept its install`);
    for (const { path } of [live, recent]) assert.equal(await readFile(join(path, 'node_modules', 'pg', 'index.js'), 'utf8'), privateMarker, `${path} lost an install it was still using`);
    assert.equal(await readFile(join(root, 'node_modules', 'pg', 'index.js'), 'utf8'), sharedMarker, "the repository's own install is not an assignment artifact");

    // Nothing else was touched: the checkouts, the unpushed branch, and Graphyard's records.
    for (const { path } of [delivered, superseded, live, idle, recent, orphan]) {
      assert.equal(await readFile(join(path, 'package-lock.json'), 'utf8'), await readFile(join(root, 'package-lock.json'), 'utf8'), `${path} lost its checkout`);
      assert.equal(await exists(join(path, '.git')), true, `${path} lost its Git metadata`);
      assert.equal(git(path, 'status', '--porcelain'), '', `${path} was left dirty`);
    }
    assert.equal(git(idle.path, 'rev-parse', 'HEAD'), unpushed, 'the unpushed commit survived the reclaim');
    assert.equal(git(root, 'rev-parse', idle.branch), unpushed, 'the branch that holds it survived the reclaim');
    assert.equal(await readFile(join(idle.path, 'source.ts'), 'utf8'), 'export const value = 2;\n');
    assert.deepEqual(git(root, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 7, 'every worktree is still registered with Git');
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), recorded, "Graphyard's registered workspace records are unchanged");

    // A second cycle inside the bounded interval does not rescan: scanning the worktree directory
    // is not free, and there is nothing new to find. The thresholds are taken from the space this
    // host actually reported, so the two cases hold on any volume the suite runs on.
    const at = state.reclaim!.at, free = state.reclaim!.freeBytes ?? 0;
    let scans = 0;
    const counted = (items: Work[]) => { scans += 1; return reclaimWorktrees(root, items, { idleMs: reclaimIdleMs(master) }); };
    const cycle2 = { snapshot: async () => ({ work: snapshot, now: new Date().toISOString() }), reclaim: counted };
    await runCycle(config(token, { diskThresholdGb: Math.max(0.1, free / 2e9) }), state, effects(cycle2));
    assert.equal(scans, 0, 'reclamation keeps to its own interval rather than scanning every cycle');
    assert.equal(state.reclaim!.at, at);

    // Unless the host is under pressure: below the configured threshold the cadence gives way and
    // every cycle reclaims, because a filling volume cannot wait ten minutes.
    await runCycle(config(token, { diskThresholdGb: Math.min(10_000, Math.max(0.2, free / 5e8)) }), state, effects(cycle2));
    assert.equal(scans, 1, 'free space below the threshold reclaims on every cycle');
    assert.notEqual(state.reclaim!.at, at);

    // Only a dependency directory inside an assignment worktree is ever removed.
    const report = await reclaimWorktrees(root, snapshot, { idleMs: reclaimIdleMs(master), apply: false });
    assert.deepEqual(report.removed, []); assert.equal(report.applied, false);
    assert.ok(report.kept.some(entry => entry.disposition === 'live'));
    for (const removed of [...report.removed, join(idle.path, 'node_modules')]) {
      assert.ok(removed.startsWith(`${worktreesDirectory(root)}/`) && dependencyDirectories.some(name => removed.endsWith(`/${name}`)));
    }
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); }
});

test('integration:worktree-dependency-reuse — a fresh attempt starts from a clean checkout of its exact head and shares one install instead of paying for a private copy', async () => {
  const root = await host(), credentials = await mkdtemp(join(tmpdir(), 'graphyard-reuse-credentials-'));
  try {
    const credential = join(credentials, 'worker.token'); await writeFile(credential, workerToken, { mode: 0o600 });
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials }, coordinatorStatus as typeof fetch);
    await saveWorkerProfile(root, { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: credential }, async () => ({ actor: { id: 'worker-a', role: 'worker' } }));
    const base = git(root, 'rev-parse', 'HEAD');

    // The launcher prepares the assignment exactly as it does in production: claim, worktree, share.
    let created: { path: string; branch: string } | null = null;
    const prepared = await prepareWorkerLaunch(root, 'GY-79', 'launch', (command, args) => {
      if (command === 'git') return args[0] === 'rev-parse' ? `${base}\n` : '';
      if (args[1] === 'claim') return JSON.stringify({ epoch: 1, lease: { owner: 'worker-a' } });
      created = assignment(root, 'GY-79', 1);
      return JSON.stringify(created);
    });
    const worktree = prepared.path;
    assert.equal(worktree, created!.path);
    // A worktree under the repository already resolves the repository's install, so the honest
    // answer is to create nothing and say the install is there.
    assert.deepEqual(prepared.dependencies!.shared, [{ name: 'node_modules', source: join(root, 'node_modules'), how: 'reachable' }]);
    assert.deepEqual(prepared.dependencies!.skipped, []);
    assert.equal(await exists(join(worktree, 'node_modules')), false, 'nothing is installed or copied into the worktree');
    assert.equal(await readFile(await realpath(join(root, 'node_modules', 'pg', 'index.js')), 'utf8'), sharedMarker);

    // And still a clean checkout of the exact head the attempt was created from.
    assert.equal(git(worktree, 'rev-parse', 'HEAD'), base);
    assert.equal(git(worktree, 'status', '--porcelain'), '', 'sharing never shows up as a change to the head');
    assert.equal(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'graphyard/gy-79-1');

    // The session is told the install is there, so the attempt does not run it again.
    const prompt = workerPrompt({ cliPath: launcher }, { key: 'GY-79', title: 'Reclaim worktrees' }, { principal: 'worker-a' }, 1, prepared.dependencies);
    assert.match(prompt, new RegExp(`needs no dependency install: node_modules already resolves to the install at ${join(root, 'node_modules')}, for this exact lockfile. Do not install dependencies again unless you change the lockfile`));
    assert.doesNotMatch(workerPrompt({ cliPath: launcher }, { key: 'GY-79', title: 'Reclaim worktrees' }, { principal: 'worker-a' }, 1, { shared: [] }), /needs no dependency install/);

    // Asking again is the same answer, never a second attempt at the same worktree.
    assert.deepEqual((await shareDependencies(root, worktree)).shared, prepared.dependencies!.shared);

    // A head that resolves a different lockfile installs its own dependencies: an existing install
    // answers only for the head it was installed for.
    const other = assignment(root, 'GY-80', 1);
    await writeFile(join(other.path, 'package-lock.json'), JSON.stringify({ name: 'graphyard', lockfileVersion: 3, packages: { 'node_modules/pg': { version: '9.0.0' } } }, null, 2));
    const divergent = await shareDependencies(root, other.path);
    assert.deepEqual(divergent.shared, []);
    assert.match(divergent.skipped[0].reason, /package-lock\.json differs from the install at/);
    assert.equal(await exists(join(other.path, 'node_modules')), false);

    // A worktree outside the repository resolves nothing on its own, so it is given a mirror of
    // the one install: a real directory of links, which the ignore rule covers and a reclaim removes.
    const detached = join(await mkdtemp(join(tmpdir(), 'graphyard-detached-')), 'GY-79-2');
    execFileSync('git', ['worktree', 'add', '-q', '--detach', detached, 'main'], { cwd: root });
    const mirrored = await shareDependencies(root, detached);
    assert.deepEqual(mirrored.shared, [{ name: 'node_modules', source: join(root, 'node_modules'), how: 'mirrored' }]);
    assert.equal((await lstat(join(detached, 'node_modules'))).isDirectory(), true, 'the mirror is a real directory, so the repository ignore rule covers it');
    assert.equal((await lstat(join(detached, 'node_modules', 'pg'))).isSymbolicLink(), true);
    assert.equal(await readFile(join(detached, 'node_modules', 'pg', 'index.js'), 'utf8'), sharedMarker);
    assert.equal(await sharedInstallSource(join(detached, 'node_modules')), join(root, 'node_modules'));
    assert.equal(git(detached, 'status', '--porcelain'), '', 'the mirror never shows up as a change to the head');
    assert.deepEqual((await shareDependencies(root, detached)).shared, mirrored.shared, 'a mirror already in place is recognised, never rebuilt');

    // A worktree that has an install of its own is left exactly as it is.
    const owned = assignment(root, 'GY-81', 1);
    await install(owned.path, privateMarker);
    const kept = await shareDependencies(root, owned.path);
    assert.deepEqual(kept.shared, []);
    assert.match(kept.skipped[0].reason, /already has its own node_modules; it is left exactly as it is/);
    assert.equal(await readFile(join(owned.path, 'node_modules', 'pg', 'index.js'), 'utf8'), privateMarker);

    // With no install anywhere there is nothing to share and nothing to fail.
    await rm(join(root, 'node_modules'), { recursive: true, force: true });
    const bare = join(await mkdtemp(join(tmpdir(), 'graphyard-bare-')), 'GY-82-1');
    execFileSync('git', ['worktree', 'add', '-q', '--detach', bare, 'main'], { cwd: root });
    const unshared = await shareDependencies(root, bare);
    assert.deepEqual(unshared.shared, []);
    assert.match(unshared.skipped[0].reason, /No shared node_modules install is reachable from/);
    assert.equal(await exists(join(bare, 'node_modules')), false);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); }
});

test('unit:disk-pressure-attention — master status asks for a reclaim before the volume fills, and a write that failed for want of room is reported as that', async () => {
  const worktrees = '/home/vish/code/graphyard/.graphyard/worktrees';
  const plan = [
    { path: `${worktrees}/GY-70-1`, name: 'GY-70-1', key: 'GY-70', epoch: 1, branch: 'graphyard/gy-70-1', disposition: 'delivered' as const, disposable: true, idleMs: hour, detail: 'GY-70 is delivered', dependencies: [{ path: `${worktrees}/GY-70-1/node_modules`, kind: 'directory' as const }] },
    { path: `${worktrees}/GY-72-1`, name: 'GY-72-1', key: 'GY-72', epoch: 1, branch: 'graphyard/gy-72-1', disposition: 'live' as const, disposable: false, idleMs: 0, detail: 'GY-72 holds the lease', dependencies: [{ path: `${worktrees}/GY-72-1/node_modules`, kind: 'directory' as const }] },
  ];

  // Below the configured threshold the master is told how much room is left, how much of it the
  // finished worktrees hold, and the one command that gives it back.
  const low = diskPressure(worktrees, 4_200_000_000, 10_000_000_000, plan);
  assert.equal(low.low, true); assert.equal(low.reclaimable, 1); assert.equal(low.worktrees, 2); assert.equal(low.unavailable, null);
  const [item] = diskPressureAttention(low);
  assert.equal(item.subject, 'disk');
  assert.match(item.text, /4\.2 GB free on \/home\/vish\/code\/graphyard\/\.graphyard\/worktrees/);
  assert.match(item.text, /below the configured 10\.0 GB threshold/);
  assert.match(item.text, /1 of 2 assignment worktree\(s\) hold dependency directories/);
  assert.match(item.text, /Reclaim them before the volume fills/);
  assert.equal(item.role, 'master'); assert.equal(item.human, false); assert.equal(item.humanOnly, null);
  assert.match(item.next, /graphyard master run reclaims every cycle while free space is low/);
  assert.match(item.next, /lower run\.reclaimIdleHours in \.graphyard\/master\.json/);
  assert.match(item.next, /graphyard master run --once reclaims immediately when no loop is running/);

  // The threshold is what decides, and it is configuration, not a constant.
  assert.deepEqual(diskPressureAttention(diskPressure(worktrees, 40_000_000_000, 10_000_000_000, plan)), []);
  assert.equal(diskPressureAttention(diskPressure(worktrees, 40_000_000_000, 60_000_000_000, plan)).length, 1);
  assert.equal(diskThresholdBytes({ run: {} }), 10_000_000_000);
  assert.equal(diskThresholdBytes({ run: { diskThresholdGb: 50 } }), 50_000_000_000);
  assert.equal(reclaimIdleMs({ run: {} }), 3 * hour);
  assert.equal(reclaimIdleMs({ run: { reclaimIdleHours: 0.5 } }), 0.5 * hour);
  // An unreadable volume is reported as unreadable rather than as room the host may not have.
  const unknown = diskPressure(worktrees, null, 10_000_000_000, plan);
  assert.equal(unknown.low, false); assert.match(unknown.unavailable!, /could not be read/);
  assert.deepEqual(diskPressureAttention(unknown), []);
  assert.equal(typeof await freeBytes(tmpdir()), 'number');

  // A write that failed for want of room says so, whether the kernel reported it or a command did.
  assert.equal(diskExhaustion(Object.assign(new Error('write failed'), { code: 'ENOSPC' })), 'the volume is full (ENOSPC)');
  assert.equal(diskExhaustion(Object.assign(new Error('write failed'), { code: 'EDQUOT' })), "the host's disk quota is exhausted (EDQUOT)");
  assert.equal(diskExhaustion(Object.assign(new Error('Command failed: git status'), { stderr: 'pwd: write error: Disk quota exceeded\n' })), "the host's disk quota is exhausted (EDQUOT)");
  assert.equal(diskExhaustion(new Error('cp: error writing: No space left on device')), 'the volume is full (ENOSPC)');
  assert.equal(diskExhaustion(new Error('connect ECONNREFUSED')), null);
  const unrelated = new Error('connect ECONNREFUSED');
  assert.equal(writeFailure(unrelated, 'Writing the cursor'), unrelated, 'a failure with another cause is left exactly as it is');
  const exhausted = writeFailure(Object.assign(new Error('write failed'), { code: 'EDQUOT' }), 'Writing the master daemon cursor');
  assert.match(exhausted.message, /^Writing the master daemon cursor failed because the host's disk quota is exhausted \(EDQUOT\)/);
  assert.match(exhausted.message, /the master loop reclaims the dependency directories of finished assignment worktrees on every cycle while free space is low/);

  // And the loop says it too: an action that failed because the host is out of room is recorded
  // as that, with the reclaim command, rather than as an unexplained command error.
  const credentials = await mkdtemp(join(tmpdir(), 'graphyard-pressure-'));
  try {
    const token = join(credentials, 'coordinator.token'); await writeFile(token, coordinatorToken, { mode: 0o600 });
    const profile: WorkerProfile = { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: token, agentArgs: [], approvals: 'auto', environment: {} };
    const master = config(token); master.workers = [profile];
    const ready = work('GY-83', { ready: true, stage: 'ready', epoch: 0, gates: [{ name: 'ready', passed: true, reasons: [] }] });
    const state = emptyDaemonState(master);
    const cycle = await runCycle(master, state, effects({
      snapshot: async () => ({ work: [ready], now: new Date().toISOString() }),
      dispatch: async () => { throw Object.assign(new Error("Command failed: git worktree add\npwd: write error: Disk quota exceeded"), { stderr: 'pwd: write error: Disk quota exceeded\n' }); },
    }));
    const failed = cycle.actions.find(action => action.kind === 'dispatch' && action.state === 'failed')!;
    assert.match(failed.detail, /Dispatch of GY-83 to launch failed/);
    assert.match(failed.detail, /Command failed: git worktree add/, 'the command output the master would otherwise chase is kept');
    assert.match(failed.detail, /the host's disk quota is exhausted \(EDQUOT\)/);
    assert.match(failed.detail, /lower run\.reclaimIdleHours/);
  } finally { await rm(credentials, { recursive: true, force: true }); }
});

// GY-360: the finished worktrees themselves are removed, not only their dependency trees, and
// master status reads the inventory the reclaim step cached instead of walking every tree.
test('unit:worktree-reclaim-executes — the reclaim step removes delivered and idle ended worktrees with git worktree remove, audits each, and keeps live, dirty and unpushed ones', async () => {
  const root = await host(false);
  try {
    const idleMs = 3 * hour;
    const delivered = assignment(root, 'GY-90', 1), ended = assignment(root, 'GY-91', 1), live = assignment(root, 'GY-92', 1);
    const dirty = assignment(root, 'GY-93', 1), unpushed = assignment(root, 'GY-94', 1), session = assignment(root, 'GY-95', 1);
    // A dirty tree: an uncommitted edit Git would refuse to drop without --force.
    await writeFile(join(dirty.path, 'source.ts'), 'export const value = 3;\n');
    // An unpushed tree: a commit no remote ref and no base branch holds.
    await writeFile(join(unpushed.path, 'source.ts'), 'export const value = 4;\n');
    execFileSync('git', ['commit', '-qam', 'unpushed'], { cwd: unpushed.path });
    // A shared install linked in is untracked to Git, and still no reason to keep the tree.
    await symlink(join(root, 'node_modules'), join(ended.path, 'node_modules'));
    for (const tree of [ended, live, dirty, unpushed, session]) await idleFor(tree.path, 4 * hour);
    const finished = { id: 'graphyard-worker-1:1', kind: 'implementation', principal: 'graphyard-worker-1', epoch: 1, runtime: 'claude', host: 'vishrog', workspace: null, tab: null, pane: null, agentName: null, role: null, state: 'finished', outcome: 'submitted' };
    const snapshot = [
      work('GY-90', { stage: 'done', workspaces: [workspace(delivered.path, delivered.branch, 1)] }),
      work('GY-91', { workspaces: [workspace(ended.path, ended.branch, 1)], sessions: [finished] } as Partial<Work>),
      work('GY-92', { lease: { epoch: 1, owner: 'graphyard-worker-1', expiresAt: new Date(Date.now() + hour).toISOString() }, workspaces: [workspace(live.path, live.branch, 1)] }),
      work('GY-93', { workspaces: [workspace(dirty.path, dirty.branch, 1)] }),
      work('GY-94', { workspaces: [workspace(unpushed.path, unpushed.branch, 1)] }),
      work('GY-95', { workspaces: [workspace(session.path, session.branch, 1)], sessions: [{ ...finished, state: 'running', outcome: null }] } as Partial<Work>),
    ];
    const heads = Object.fromEntries([delivered, ended].map(tree => [tree.path, git(tree.path, 'rev-parse', 'HEAD')]));
    const calls: string[][] = [];
    const run = (command: string, args: string[]) => { calls.push([command, ...args]); return runChild(command, args); };

    const report = await removeReclaimableWorktrees(root, snapshot, { idleMs, run, baseBranch: 'main' });
    assert.deepEqual(report.removed.map(entry => entry.key).sort(), ['GY-90', 'GY-91']);
    assert.equal(report.backlog, 0); assert.deepEqual(report.errors, []);
    for (const tree of [delivered, ended]) {
      assert.equal(await exists(tree.path), false, `${tree.path} was not removed`);
      assert.equal(await readFile(join(root, 'node_modules', 'pg', 'index.js'), 'utf8'), sharedMarker, 'the shared install behind a link survives');
      assert.ok(git(root, 'rev-parse', '--verify', tree.branch), 'the branch survives its worktree');
    }
    for (const tree of [live, dirty, unpushed, session]) assert.equal(await exists(join(tree.path, 'source.ts')), true, `${tree.path} was removed`);
    assert.equal(await readFile(join(dirty.path, 'source.ts'), 'utf8'), 'export const value = 3;\n', 'the dirty edit survived');
    const listed = git(root, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length));
    assert.equal(listed.length, 5, 'the main checkout and the four kept trees remain registered');
    assert.ok(!listed.includes(delivered.path) && !listed.includes(ended.path));

    // The dirty and the unpushed tree are reported, with why; the live ones are simply not candidates.
    const kept = Object.fromEntries(report.kept.map(entry => [entry.key, entry.reason]));
    assert.match(kept['GY-93'], /Uncommitted changes/);
    assert.match(kept['GY-94'], /Unpushed commits/);
    assert.equal(kept['GY-92'], undefined); assert.equal(kept['GY-95'], undefined);

    // git worktree remove, never --force, then one prune.
    const removals = calls.filter(call => call.includes('remove'));
    assert.equal(removals.length, 2);
    for (const call of removals) assert.ok(!call.includes('--force') && !call.includes('-f'), `forced: ${call.join(' ')}`);
    assert.equal(calls.filter(call => call.includes('prune')).length, 1);

    // One audit entry per removal: path, item, reason and head.
    const audit = (await readFile(worktreeReclaimAuditFile(root), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(audit.length, 2);
    for (const entry of audit) {
      assert.equal(entry.action, 'worktree-remove');
      assert.equal(entry.head, heads[entry.path]);
      assert.ok(['GY-90', 'GY-91'].includes(entry.key));
      assert.match(entry.reason, entry.key === 'GY-90' ? /GY-90 is delivered/ : /Untouched for \d+ minutes/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:worktree-reclaim-bounded — removal is bounded per cycle and drains a backlog on consecutive cycles; status reads the cached inventory without running git per worktree', async () => {
  const root = await host(false), credentials = await mkdtemp(join(tmpdir(), 'graphyard-reclaim-bounded-')), scratch = await mkdtemp(join(tmpdir(), 'graphyard-reclaim-git-'));
  try {
    const token = join(credentials, 'coordinator.token'); await writeFile(token, coordinatorToken, { mode: 0o600 });
    const master = config(token, { worktreeRemovalLimit: 3, diskThresholdGb: 0.1 });
    const trees = Array.from({ length: 7 }, (_, index) => assignment(root, `GY-${100 + index}`, 1));
    const snapshot = trees.map((tree, index) => work(`GY-${100 + index}`, { stage: 'done', workspaces: [workspace(tree.path, tree.branch, 1)] }));
    const perPass: number[] = [];
    const reclaim = async (items: Work[]) => {
      const removal = await removeReclaimableWorktrees(root, items, { idleMs: reclaimIdleMs(master), run: runChild, baseBranch: 'main', limit: master.run.worktreeRemovalLimit });
      perPass.push(removal.removed.length);
      await writeWorktreeInventoryCache(root, { at: removal.at, entries: removal.entries, held: [] });
      return { ...await reclaimWorktrees(root, items, { idleMs: reclaimIdleMs(master), entries: removal.entries }), trees: removal };
    };
    const state = emptyDaemonState(master);
    const first = await runCycle(master, state, effects({ snapshot: async () => ({ work: snapshot, now: new Date().toISOString() }), reclaim }));
    assert.deepEqual(perPass, [3]);
    assert.equal(state.reclaim!.trees, 3); assert.equal(state.reclaim!.treeBacklog, 4);
    assert.match(first.actions.find(action => action.kind === 'reclaim')!.detail, /Removed 3 finished worktree\(s\) with git worktree remove; 4 more are reclaimable and go on the next cycle \(at most 3 per cycle\)/);
    // Inside the ten-minute interval, a backlog still drains on the very next cycles.
    await runCycle(master, state, effects({ snapshot: async () => ({ work: snapshot, now: new Date().toISOString() }), reclaim }));
    await runCycle(master, state, effects({ snapshot: async () => ({ work: snapshot, now: new Date().toISOString() }), reclaim }));
    assert.deepEqual(perPass, [3, 3, 1]);
    assert.equal(state.reclaim!.treeBacklog, 0);
    await runCycle(master, state, effects({ snapshot: async () => ({ work: snapshot, now: new Date().toISOString() }), reclaim }));
    assert.equal(perPass.length, 3, 'with the backlog drained the step keeps to its interval again');
    for (const tree of trees) assert.equal(await exists(tree.path), false);

    // A thousand trees: status reads the cache the reclaim step wrote, in one file read, and no
    // git runs. A git that records every call it receives stands in for the real one on PATH.
    const base = worktreesDirectory(root);
    await Promise.all(Array.from({ length: 1000 }, (_, index) => mkdir(join(base, `GY-${2000 + index}-1`), { recursive: true })));
    const now = Date.now();
    await writeWorktreeInventoryCache(root, { at: new Date(now).toISOString(), held: [],
      entries: await (await import('../src/master.js')).inventoryWorktrees(root, now) });
    const log = join(scratch, 'git-calls.log');
    await writeFile(join(scratch, 'git'), `#!/bin/sh\necho "$@" >> ${log}\nexit 1\n`, { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${scratch}:${path}`;
    let inventory: Awaited<ReturnType<typeof statusWorktreeInventory>>, elapsed: number;
    try {
      const started = performance.now();
      inventory = await statusWorktreeInventory(root);
      planWorktreeReclaim(inventory.entries, snapshot, { now: Date.now(), idleMs: reclaimIdleMs(master) });
      elapsed = performance.now() - started;
    } finally { process.env.PATH = path; }
    assert.equal(inventory.cached, true);
    assert.equal(inventory.entries.length, 1000);
    assert.ok(elapsed < 2000, `the status inventory took ${elapsed} ms for 1,000 worktrees`);
    assert.equal(await exists(log), false, 'the status path ran git');
    // The cache is what status reports, not a fresh walk: a tree gone since the last pass is still listed until the next one.
    await rm(join(base, 'GY-2000-1'), { recursive: true });
    assert.equal((await statusWorktreeInventory(root)).entries.length, 1000);
    // And master status itself goes through the cached inventory, never the walk.
    const source = await readFile(fileURLToPath(new URL('../src/cli/master-status.ts', import.meta.url)), 'utf8');
    assert.match(source, /statusWorktreeInventory\(root\)/);
    assert.doesNotMatch(source, /inventoryWorktrees\(/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); await rm(scratch, { recursive: true, force: true }); }
});
