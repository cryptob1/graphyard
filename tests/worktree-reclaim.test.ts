import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { wording } from '../src/model/fault-wording.js';
import { standingDiskLine } from '../src/master/worktree-disk.js';
import { dependencyDirectories, diskExhaustion, diskPressure, diskPressureAttention, diskThresholdBytes, freeBytes, inventoryWorktrees, masterConfigSchema, planWorktreeReclaim, prepareWorkerLaunch, reclaimIdleMs, reclaimWorktrees, removeReclaimableWorktrees, statusWorktreeInventory, writeWorktreeInventoryCache, worktreeReclaimAuditFile, saveWorkerProfile, setupMaster, shareDependencies, sharedInstallSource, workerPrompt, worktreesDirectory, writeFailure, type MasterConfig, type MasterRun, type WorkerProfile } from '../src/master.js';
import { cycleFaults, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { readResources, resourceAttention } from '../src/master-resources.js';
import { trackFaults } from '../src/model/fault-classes.js';
import type { Work } from '../src/model.js';
import { runChild } from '../src/child-runner.js';
import * as worktrees from '../src/master/worktrees.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

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
  const root = await temporaryDirectory('reclaim');
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
/** A finished attempt session on epoch 1 that ended `ago` milliseconds before now. */
function endedSession(ago: number) {
  const endedAt = new Date(Date.now() - ago).toISOString();
  return { id: 'graphyard-worker-1:1', kind: 'implementation', principal: 'graphyard-worker-1', epoch: 1, runtime: 'claude', host: 'vishrog', workspace: null, tab: null, pane: null, agentName: null, role: null, head: null, attach: null, transcript: null, subject: 'attempt', startedAt: endedAt, updatedAt: endedAt, endedAt, state: 'finished', outcome: 'submitted' };
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
    closeSession: () => {}, dispatch: async () => {},
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, persist: async () => {}, ...overrides,
  };
}

test('integration:worktree-reclaim — the loop removes the dependency trees of finished assignments and leaves every checkout, branch and workspace record intact', async () => {
  const root = await host(false), credentials = await temporaryDirectory('reclaim-credentials');
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
  const root = await host(), credentials = await temporaryDirectory('reuse-credentials');
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
    const detached = join(await temporaryDirectory('detached'), 'GY-79-2');
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
    const bare = join(await temporaryDirectory('bare'), 'GY-82-1');
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

  // Inside the recovery band of a standing fault the attention line does not claim the reading is below the threshold.
  const inBand = diskPressure(worktrees, 10_500_000_000, 10_000_000_000, plan, { standing: true });
  assert.equal(inBand.low, true);
  assert.match(diskPressureAttention(inBand)[0].text, /10\.5 GB free on .*, within the recovery band above the configured 10\.0 GB threshold/);
  assert.doesNotMatch(diskPressureAttention(inBand)[0].text, /below the configured/);

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
  const credentials = await temporaryDirectory('pressure');
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
    const finished = endedSession(4 * hour);
    const snapshot = [
      work('GY-90', { stage: 'done', workspaces: [workspace(delivered.path, delivered.branch, 1)] }),
      work('GY-91', { workspaces: [workspace(ended.path, ended.branch, 1)], sessions: [finished] } as Partial<Work>),
      work('GY-92', { lease: { epoch: 1, owner: 'graphyard-worker-1', expiresAt: new Date(Date.now() + hour).toISOString() }, workspaces: [workspace(live.path, live.branch, 1)] }),
      work('GY-93', { workspaces: [workspace(dirty.path, dirty.branch, 1)], sessions: [finished] } as Partial<Work>),
      work('GY-94', { workspaces: [workspace(unpushed.path, unpushed.branch, 1)], sessions: [finished] } as Partial<Work>),
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
      assert.match(entry.reason, entry.key === 'GY-90' ? /GY-90 is delivered/ : /last session ended \d+ minutes ago.*Untouched for \d+ minutes/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:worktree-reclaim-bounded — removal is bounded per cycle and drains a backlog on consecutive cycles; status reads the cached inventory without running git per worktree', async () => {
  const root = await host(false), credentials = await temporaryDirectory('reclaim-bounded'), scratch = await temporaryDirectory('reclaim-git');
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

// GY-382: the follow-ups from GY-360's review. The idle rule is judged by when the tree's last
// session ended, not only by the tree's mtime; a held tree is re-examined once the refs that could
// hold its commits move; and a directory Git does not register is never judged through `git -C`.
test('unit:worktree-removal-follows-session-end — only a tree whose session ended past the idle bound goes; unregistered, sessionless, recently ended and parked trees stay', async () => {
  const root = await host(false);
  try {
    const idleMs = 3 * hour;
    const ended = assignment(root, 'GY-120', 1), stray = assignment(root, 'GY-121', 1), none = assignment(root, 'GY-122', 1);
    const recent = assignment(root, 'GY-123', 1), parked = assignment(root, 'GY-124', 1);
    for (const tree of [ended, stray, none, recent, parked]) await idleFor(tree.path, 4 * hour);
    const snapshot = [
      work('GY-120', { workspaces: [workspace(ended.path, ended.branch, 1)], sessions: [endedSession(4 * hour)] } as Partial<Work>),
      // GY-121 is registered by no item at all.
      work('GY-122', { workspaces: [workspace(none.path, none.branch, 1)] }),
      work('GY-123', { workspaces: [workspace(recent.path, recent.branch, 1)], sessions: [endedSession(hour)] } as Partial<Work>),
      work('GY-124', { workspaces: [workspace(parked.path, parked.branch, 1)], sessions: [endedSession(4 * hour)], humanRequest: { kind: 'goals-and-priorities' } } as unknown as Partial<Work>),
    ];
    const report = await removeReclaimableWorktrees(root, snapshot, { idleMs, run: runChild, baseBranch: 'main' });
    assert.deepEqual(report.removed.map(entry => entry.key), ['GY-120']);
    assert.match(report.removed[0].reason, /GY-120 epoch 1's last session ended \d+ minutes ago, past the 180-minute idle bound/);
    for (const tree of [stray, none, recent, parked]) assert.equal(await exists(join(tree.path, 'source.ts')), true, `${tree.path} was removed`);
    assert.deepEqual(report.errors, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:worktree-held-reexamined-after-push — a tree kept for unpushed commits is judged again once those commits reach a remote or the base branch', async () => {
  const root = await host(false);
  try {
    const idleMs = 3 * hour;
    const tree = assignment(root, 'GY-130', 1);
    await writeFile(join(tree.path, 'source.ts'), 'export const value = 5;\n');
    execFileSync('git', ['commit', '-qam', 'unpushed'], { cwd: tree.path });
    await idleFor(tree.path, 4 * hour);
    const snapshot = [work('GY-130', { workspaces: [workspace(tree.path, tree.branch, 1)], sessions: [endedSession(4 * hour)] } as Partial<Work>)];
    const pass = async () => {
      const report = await removeReclaimableWorktrees(root, snapshot, { idleMs, run: runChild, baseBranch: 'main' });
      await writeWorktreeInventoryCache(root, { at: report.at, entries: report.entries, held: report.held });
      return report;
    };
    const first = await pass();
    assert.match(first.kept[0].reason, /Unpushed commits/);
    assert.equal(first.held.length, 1);
    // Nothing moved: the hold is reused and git is not asked about the tree again.
    const calls: string[][] = [];
    const second = await removeReclaimableWorktrees(root, snapshot, { idleMs, run: (command, args) => { calls.push(args); return runChild(command, args); }, baseBranch: 'main' });
    assert.match(second.kept[0].reason, /Unpushed commits/);
    assert.ok(!calls.some(args => args.includes(tree.path)), 'a held tree was examined again with nothing changed');
    // The commit reaches the base branch without the working tree changing: the tree is judged again, and goes.
    execFileSync('git', ['merge', '-q', '--ff-only', tree.branch], { cwd: root });
    const third = await pass();
    assert.deepEqual(third.removed.map(entry => entry.key), ['GY-130']);
    assert.equal(await exists(tree.path), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:worktree-removal-registered-only — a directory under the worktree root that Git does not register is kept, never judged clean through an enclosing repository', async () => {
  const root = await host(false);
  try {
    const idleMs = 3 * hour;
    const path = join(worktreesDirectory(root), 'GY-140-1');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'notes.txt'), 'not a worktree\n');
    const when = new Date(Date.now() - 4 * hour);
    await utimes(join(path, 'notes.txt'), when, when); await utimes(path, when, when);
    const snapshot = [work('GY-140', { workspaces: [workspace(path, 'graphyard/gy-140-1', 1)], sessions: [endedSession(4 * hour)] } as Partial<Work>)];
    const calls: string[][] = [];
    const report = await removeReclaimableWorktrees(root, snapshot, { idleMs, run: (command, args) => { calls.push(args); return runChild(command, args); }, baseBranch: 'main' });
    assert.deepEqual(report.removed, []);
    assert.match(report.kept[0].reason, /Not a registered Git worktree/);
    assert.ok(!calls.some(args => args[1] === path), 'git ran inside a directory it does not register');
    assert.equal(await readFile(join(path, 'notes.txt'), 'utf8'), 'not a worktree\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// GY-450: the follow-ups from GY-382's review. A hold depends only on the refs that could hold the
// tree's branch, and a delivered item's directory Git no longer registers is reclaimed when nothing
// in it is work.
test('unit:worktree-hold-ignores-unrelated-refs — a fetch that moves an unrelated remote branch leaves a hold standing; the branch reaching its remote re-examines it', async () => {
  const root = await host();
  try {
    const idleMs = 3 * hour;
    const tree = assignment(root, 'GY-150', 1);
    await writeFile(join(tree.path, 'source.ts'), 'export const value = 6;\n');
    execFileSync('git', ['commit', '-qam', 'unpushed'], { cwd: tree.path });
    await idleFor(tree.path, 4 * hour);
    const snapshot = [work('GY-150', { workspaces: [workspace(tree.path, tree.branch, 1)], sessions: [endedSession(4 * hour)] } as Partial<Work>)];
    const calls: string[][] = [];
    const pass = async () => {
      const report = await removeReclaimableWorktrees(root, snapshot, { idleMs, run: (command, args) => { calls.push(args); return runChild(command, args); }, baseBranch: 'main' });
      await writeWorktreeInventoryCache(root, { at: report.at, entries: report.entries, held: report.held });
      return report;
    };
    assert.match((await pass()).kept[0].reason, /Unpushed commits/);
    calls.length = 0;
    execFileSync('git', ['update-ref', 'refs/remotes/origin/unrelated', git(root, 'rev-parse', 'main')], { cwd: root });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/graphyard/gy-150-10', git(root, 'rev-parse', 'main')], { cwd: root });
    const held = await pass();
    assert.match(held.kept[0].reason, /Unpushed commits/);
    assert.ok(!calls.some(args => args.includes(tree.path)), 'an unrelated remote ref re-examined the held tree');
    execFileSync('git', ['update-ref', `refs/remotes/origin/${tree.branch}`, git(tree.path, 'rev-parse', 'HEAD')], { cwd: root });
    assert.deepEqual((await pass()).removed.map(entry => entry.key), ['GY-150']);
    assert.equal(await exists(tree.path), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:worktree-orphan-reclaimed — a delivered item\'s directory Git no longer registers is removed when it holds only dependency trees, and reported when it holds anything else', async () => {
  const root = await host(false);
  try {
    const idleMs = 3 * hour;
    const empty = assignment(root, 'GY-160', 1), held = assignment(root, 'GY-161', 1), open = join(worktreesDirectory(root), 'GY-162-1');
    // Git forgets both: the registry entries go, the directories stay behind with their `.git` pointers.
    for (const tree of [empty, held]) {
      for (const name of ['.gitignore', 'package-lock.json', 'source.ts']) await rm(join(tree.path, name));
      await rm(join(root, '.git', 'worktrees', `${tree.path.split('/').pop()}`), { recursive: true });
    }
    execFileSync('git', ['worktree', 'prune'], { cwd: root });
    await symlink(join(root, 'node_modules'), join(empty.path, 'node_modules'));
    await writeFile(join(held.path, 'notes.txt'), 'leftover\n');
    await mkdir(open, { recursive: true }); await writeFile(join(open, 'notes.txt'), 'in progress\n');
    const snapshot = [
      work('GY-160', { stage: 'done', workspaces: [workspace(empty.path, empty.branch, 1)] }),
      work('GY-161', { stage: 'done', workspaces: [workspace(held.path, held.branch, 1)] }),
      work('GY-162', { workspaces: [workspace(open, 'graphyard/gy-162-1', 1)], sessions: [endedSession(4 * hour)] } as Partial<Work>),
    ];
    const when = new Date(Date.now() - 4 * hour);
    await utimes(join(open, 'notes.txt'), when, when); await idleFor(open, 4 * hour);
    const report = await removeReclaimableWorktrees(root, snapshot, { idleMs, run: runChild, baseBranch: 'main' });
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.removed.map(entry => entry.key), ['GY-160']);
    assert.match(report.removed[0].reason, /GY-160 is delivered; the directory was no longer a registered Git worktree/);
    assert.equal(await exists(empty.path), false);
    assert.equal(await readFile(join(root, 'node_modules', 'pg', 'index.js'), 'utf8'), sharedMarker, 'the shared install behind the link survives');
    const kept = Object.fromEntries(report.kept.map(entry => [entry.key, entry.reason]));
    assert.match(kept['GY-161'], /Not a registered Git worktree, and it holds 1 path\(s\) that are not dependency trees \(notes\.txt\)/);
    assert.match(kept['GY-162'], /Not a registered Git worktree: its clean state cannot be judged/);
    assert.equal(await readFile(join(held.path, 'notes.txt'), 'utf8'), 'leftover\n');
    assert.equal(await readFile(join(open, 'notes.txt'), 'utf8'), 'in progress\n');
    const audit = (await readFile(worktreeReclaimAuditFile(root), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(audit.map(entry => [entry.action, entry.key]), [['orphan-remove', 'GY-160']]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// GY-1515 (manual:fault-class-resources): on 8 October 2026 at 04:11Z the loop's reclaim pass met one
// tree Git refused to judge (`rev-list` on GY-860-1 failed) and recorded the pass as a failed
// `reclaim:trees` action, a resources fault. A refused tree was never remembered as held, so a
// backlog that ran the pass every cycle re-ran the same refused command and recorded a fresh
// failure, one instance per cycle, while nothing about the tree had changed.
test('manual:fault-class-resources — GY-1515 reclaim: a tree Git refuses is one failed pass, then held and kept like a dirty tree while the backlog drains, and tried again after a day without a second fault', async () => {
  const root = await host(false), credentials = await temporaryDirectory('reclaim-refusal');
  try {
    const token = join(credentials, 'coordinator.token'); await writeFile(token, coordinatorToken, { mode: 0o600 });
    // Namespace-read so this file loads on the base, which has no retry bound, and the REPRODUCE assertions below run there.
    const refusalRetryMs = (worktrees as { worktreeRefusalRetryMs?: number }).worktreeRefusalRetryMs ?? 24 * hour;
    // The threshold is set far below any host's free space: this test is about the refusal's one fault, not the volume (GY-1784 found it flapping on a host at its 10 GB default).
    const master = config(token, { worktreeRemovalLimit: 1, diskThresholdGb: 0.1 });
    const refused = assignment(root, 'GY-200', 1), second = assignment(root, 'GY-201', 1), third = assignment(root, 'GY-202', 1);
    await idleFor(refused.path, 6 * hour); await idleFor(second.path, 5 * hour); await idleFor(third.path, 4 * hour);
    const snapshot = [refused, second, third].map((tree, index) => work(`GY-${200 + index}`, { stage: 'done', workspaces: [workspace(tree.path, tree.branch, 1)] }));
    const revLists: string[] = [];
    const run = (command: string, args: string[]) => {
      if (args.includes('rev-list') && args[1] === refused.path) { revLists.push(args.join(' ')); throw new Error(`Command failed: git -C ${refused.path} rev-list -n 1 HEAD --not --remotes refs/heads/main`); }
      return runChild(command, args);
    };
    const passes: Awaited<ReturnType<typeof removeReclaimableWorktrees>>[] = [];
    const reclaim = async (items: Work[], now?: number) => {
      const removal = await removeReclaimableWorktrees(root, items, { idleMs: reclaimIdleMs(master), run, baseBranch: 'main', limit: master.run.worktreeRemovalLimit, now });
      passes.push(removal);
      await writeWorktreeInventoryCache(root, { at: removal.at, entries: removal.entries, held: removal.held });
      return { ...await reclaimWorktrees(root, items, { idleMs: reclaimIdleMs(master), entries: removal.entries }), trees: removal };
    };
    const state = emptyDaemonState(master);
    const resourcesFaults = () => state.faults.instances.filter(entry => entry.faultClass === 'resources').map(entry => entry.kind);
    const treesActions = () => Object.entries(state.actions).filter(([key]) => key.startsWith('reclaim:trees:')).map(([, action]) => action);
    const first = await runCycle(master, state, effects({ snapshot: async () => ({ work: snapshot, now: new Date().toISOString() }), reclaim: items => reclaim(items) }));
    // Pass 1: the oldest tree is examined first, Git refuses it, and the pass is recorded as failed — one fault.
    assert.equal(passes[0].removed.length, 0); assert.equal(passes[0].backlog, 2);
    assert.match(passes[0].errors[0], /GY-200-1: .*rev-list/);
    assert.equal(treesActions().length, 1); assert.equal(treesActions()[0].state, 'failed');
    assert.match(first.actions.find(action => action.kind === 'reclaim')!.detail, /1 could not be removed: .*GY-200-1: .*rev-list/);
    assert.deepEqual(resourcesFaults(), ['action:reclaim'], 'the refusal is one resources fault');
    assert.equal(revLists.length, 1);
    // Pass 2, the next cycle (the backlog drains on consecutive cycles): the refused tree is held and kept, Git is not asked again, and the pass succeeds on the next tree.
    await runCycle(master, state, effects({ snapshot: async () => ({ work: snapshot, now: new Date().toISOString() }), reclaim: items => reclaim(items) }));
    assert.equal(revLists.length, 1, 'REPRODUCE: the base re-ran the refused rev-list on the next pass');
    assert.deepEqual(passes[1].errors, [], 'REPRODUCE: the base reported the same refusal as a new failure');
    assert.deepEqual(passes[1].removed.map(entry => entry.key), ['GY-201']);
    assert.match(passes[1].kept.find(entry => entry.key === 'GY-200')!.reason, /^Git refused: .*rev-list/);
    assert.match(passes[1].held.find(entry => entry.path === refused.path)!.reason, /^Git refused: .*rev-list.*; tried again after \d{4}-/);
    const second2 = treesActions().find(action => action.state === 'done');
    assert.ok(second2, 'REPRODUCE: the base recorded the second pass as failed too');
    assert.match(second2!.detail, /^Removed 1 finished worktree\(s\) with git worktree remove; 1 more are reclaimable and go on the next cycle \(at most 1 per cycle\); 1 kept as dirty, unpushed, unregistered or refused by Git, first .*GY-200-1: Git refused: /);
    assert.deepEqual(resourcesFaults(), ['action:reclaim'], 'REPRODUCE: the base counted a second resources fault for the same standing refusal');
    // Pass 3 drains the backlog with the refused tree still held; a pass a day later tries it again, in case the refusal cleared.
    const third3 = (await reclaim(snapshot)).trees;
    assert.deepEqual(third3.removed.map(entry => entry.key), ['GY-202']); assert.deepEqual(third3.errors, []); assert.equal(revLists.length, 1);
    const retried = (await reclaim(snapshot, Date.now() + refusalRetryMs + 1_000)).trees;
    assert.equal(revLists.length, 2, 'after the retry bound the tree is examined again');
    assert.deepEqual(retried.errors, [], 'a refusal that stands across the retry is held again, never reported as a new failure');
    assert.match(retried.held.find(entry => entry.path === refused.path)!.reason, /^Git refused: .*rev-list.*; tried again after \d{4}-/);
    assert.equal(await exists(refused.path), true, 'the refused tree is never removed');
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); }
});

/*
 * GY-1784: the `disk` line of master status and the loop's derived disk-pressure fault are judged as
 * the registry's worktree-disk reading is (src/master/worktree-disk.ts): answered while the loop's
 * latest pass is current and drained, raised at the exhaustion floor whatever the pass answered, and
 * held inside the recovery band while the line's fault stands. Instants here are relative to the
 * clock this test runs on; no calendar date is constructed.
 */
const reclaimSummary = (at: number, freeBytes: number, overrides: Record<string, unknown> = {}) =>
  ({ at: new Date(at).toISOString(), scanned: 240, removed: 0, kept: 240, freedBytes: 0, freeBytes, errors: [], checkouts: 0, checkoutsOffVolume: 0, rootFreeBytes: null, trees: 0, treeBacklog: 0, ...overrides });

test('unit:disk-pressure-drained-flap — the derived disk-pressure line gets the answered gate and the recovery band the worktree-disk reading has, so the two lines cannot flap between them', async () => {
  const disk = await import('../src/master/worktree-disk.js');
  const credentials = await temporaryDirectory('disk-flap');
  try {
    const token = join(credentials, 'coordinator.token'); await writeFile(token, coordinatorToken, { mode: 0o600 });
    const master = config(token, { diskThresholdGb: 10 }), threshold = diskThresholdBytes(master);
    const state = emptyDaemonState(master);
    let now = Date.now();
    const standing = () => disk.standingDiskLine(state.faults.open, 'disk-pressure');
    /** One cycle's faults step over a reclaim summary recorded `age` ms before it, tracked into the record. */
    const observe = (freeBytes: number, age = 60_000, overrides: Record<string, unknown> = {}) => {
      state.reclaim = reclaimSummary(now - age, freeBytes, overrides) as typeof state.reclaim;
      const lines = cycleFaults(state, [], now, { config: master }).filter(fault => fault.kind === 'disk-pressure');
      const opened = trackFaults(state.faults, lines, new Date(now).toISOString()).map(fault => fault.kind);
      now += 20_000;
      return { lines, opened };
    };
    // Below the line with a current, drained pass: no line, and the registry reading on the same inputs is answered too.
    const answered = observe(9_900_000_000);
    assert.deepEqual(answered.lines, []); assert.equal(standing(), false);
    assert.equal(disk.judgeWorktreeDisk({ freeBytes: 9_900_000_000, thresholdBytes: threshold, pass: disk.worktreePassOf(state.reclaim!) }, now).answered, true);
    // Left anything reclaimable, or stale: the line stands and says why.
    const backlog = observe(9_900_000_000, 60_000, { treeBacklog: 120 });
    assert.deepEqual(backlog.opened, ['disk-pressure']);
    assert.match(backlog.lines[0].text, /^Free space below its configured bound at the last reclaim \([^)]*\)$/, 'the observation is worded the same whatever the reading or the pass says, so one wobble is one instance');
    assert.deepEqual(observe(9_900_000_000, 60_000, { removed: 2 }).lines.map(line => line.kind), ['disk-pressure']);
    assert.deepEqual(observe(9_900_000_000, 60_000, { checkouts: 1 }).lines.map(line => line.kind), ['disk-pressure']);
    assert.deepEqual(observe(9_900_000_000, 60_000, { errors: ['x: Git refused'] }).lines.map(line => line.kind), ['disk-pressure']);
    const stale = observe(9_900_000_000, disk.worktreePassCurrentMs + 1);
    assert.match(stale.lines[0].text, /^Free space below its configured bound at the last reclaim \([^)]*\)$/);
    // The reach and why the reading stands live in the judged detail master status carries, not in the fault's wording.
    assert.match(disk.judgeWorktreeDisk({ freeBytes: 9_900_000_000, thresholdBytes: threshold, pass: disk.worktreePassOf(state.reclaim!), standing: true, reclaimable: 0 }, now).detail!, /found nothing reclaimable .* outside its reach: free host data on the volume, raise run\.diskThresholdGb .*; that pass is past its 30-minute currency bound/);
    assert.equal(state.faults.instances.filter(instance => instance.kind === 'disk-pressure').length, 1, 'the standing line is one instance however its wording moves');
    // Drained and current again while the fault stands: the line holds — a fresh drained pass ends it only past the recovery band (GY-1784 review, AC-4).
    const held = observe(9_900_000_000);
    assert.equal(held.lines.length, 1, 'a standing line is not answered, however fresh the drained pass');
    assert.match(held.lines[0].text, /^Free space below its configured bound/);
    assert.match(disk.judgeWorktreeDisk({ freeBytes: 9_900_000_000, thresholdBytes: threshold, pass: disk.worktreePassOf(state.reclaim!), standing: true, reclaimable: 0 }, now).detail!, /the reading's fault stands, so it holds until free space recovers past the 1\.0 GB band above the 10\.0 GB line, whatever that pass answered/);
    assert.equal(state.faults.instances.filter(instance => instance.kind === 'disk-pressure').length, 1, 'the hold opens no new instance');
    // Recovered past the band while the pass is current and drained: the line ends.
    assert.deepEqual(observe(threshold + disk.diskRecoveryBandBytes(threshold), 60_000).lines, []); assert.equal(standing(), false);
    // The wobble GY-1782 recorded, with a stale pass so the line is raised: 9.98 → 10.24 → 9.95 → 10.33 → 9.9 GB is one instance, not one per crossing.
    const walk = [9_980_000_000, 10_240_000_000, 9_950_000_000, 10_330_000_000, 9_900_000_000].map(free => observe(free, 2 * hour));
    assert.deepEqual(walk.map(step => step.opened), [['disk-pressure'], [], [], [], []]);
    assert.deepEqual(walk.map(step => step.lines.length), [1, 1, 1, 1, 1], 'inside the band the line keeps standing');
    // The wording never moves with the reading (a fault is its wording); what the band says lives in the judged detail.
    assert.match(disk.judgeWorktreeDisk({ freeBytes: 10_240_000_000, thresholdBytes: threshold, pass: disk.worktreePassOf(state.reclaim!), standing: true, reclaimable: 0 }, now).detail!, /within the 1\.0 GB recovery band above the 10\.0 GB line/);
    assert.equal(wording(walk[1].lines[0].text), wording(walk[0].lines[0].text), 'inside the band the derived line is the same fault, not a new one');
    assert.match(walk[0].lines[0].text, /^Free space below its configured bound/);
    // Recovered past the band: the instance ends; the next dip under the line is a new one. Without a standing line the band is not in force.
    assert.deepEqual(observe(threshold + disk.diskRecoveryBandBytes(threshold), 2 * hour).lines, []); assert.equal(standing(), false);
    assert.deepEqual(observe(10_500_000_000, 2 * hour).lines, [], 'above the line with no standing fault, the band does not apply');
    assert.deepEqual(observe(9_990_000_000, 2 * hour).opened, ['disk-pressure']);
    // Recovered once more, so no fault stands: the hard line is all that overrides the answered gate.
    assert.deepEqual(observe(threshold + disk.diskRecoveryBandBytes(threshold), 60_000).lines, []);
    // The hard line: at or below the floor the line is raised though the pass is current and drained.
    const floor = disk.diskExhaustionFloorBytes(threshold);
    assert.equal(observe(floor + 1).lines.length, 0, 'just above the floor the drained pass answers');
    assert.match(observe(floor).lines[0].text, /^Free space below its configured bound/);
    assert.match(disk.judgeWorktreeDisk({ freeBytes: floor, thresholdBytes: threshold, pass: disk.worktreePassOf(state.reclaim!), reclaimable: 0 }, now).detail!, /at or below the 5\.0 GB exhaustion floor, which raises attention whatever that pass answered/);
    // The managed root's own minimum is judged as before, beside the worktree volume.
    assert.equal(observe(40_000_000_000, 60_000, { rootFreeBytes: 1 }).lines.length, 1, 'the managed root below its minimum still raises the line');
  } finally { await rm(credentials, { recursive: true, force: true }); }
});

test('unit:disk-pressure-attention-names-outside-reach — with nothing reclaimable the disk line says the volume\'s remaining holders are outside the loop\'s reach and names the operator\'s choices, never "Reclaim them before the volume fills"', async () => {
  const worktrees = '/home/vish/code/graphyard/.graphyard/worktrees', now = Date.now();
  const held = { path: `${worktrees}/GY-72-1`, name: 'GY-72-1', key: 'GY-72', epoch: 1, branch: 'graphyard/gy-72-1', disposition: 'live' as const, disposable: false, idleMs: 0, detail: 'GY-72 holds the lease', dependencies: [] };
  const plan = Array.from({ length: 239 }, (_, index) => ({ ...held, path: `${worktrees}/GY-${index}-1`, name: `GY-${index}-1`, key: `GY-${index}` }));
  const drained = { at: new Date(now - 2 * hour).toISOString(), removed: 0, trees: 0, treeBacklog: 0, checkouts: 0, errors: 0, freeBytes: 9_800_000_000 };
  // The pass is stale, so the line is raised; it says what holds the volume and what moves the number.
  const stale = diskPressure(worktrees, 9_800_000_000, 10_000_000_000, plan, { pass: drained, now });
  assert.equal(stale.low, true); assert.equal(stale.answered, false); assert.equal(stale.drained, true); assert.equal(stale.reclaimable, 0);
  const [item] = diskPressureAttention(stale);
  assert.equal(item.subject, 'disk'); assert.equal(item.role, 'master');
  assert.match(item.text, /^9\.8 GB free on \/home\/vish\/code\/graphyard\/\.graphyard\/worktrees, below the configured 10\.0 GB threshold; 0 of 239 assignment worktree\(s\) hold dependency directories a fresh install recreates \(/);
  assert.match(item.text, /The volume's remaining holders are outside the loop's reach: free host data on the volume, raise run\.diskThresholdGb in \.graphyard\/master\.json, or move the worktree root \(\.graphyard\/worktrees, and run\.worktreeRoot for the managed checkouts\) to a dedicated volume$/);
  assert.doesNotMatch(item.text, /Reclaim them before the volume fills/);
  assert.match(item.next, /free host data on the volume, raise run\.diskThresholdGb in \.graphyard\/master\.json, or move the worktree root/);
  assert.doesNotMatch(item.next, /lower run\.reclaimIdleHours/);
  // Current and drained: answered — low in master status, with its reading, raising nothing.
  const current = { ...drained, at: new Date(now - 60_000).toISOString() };
  const answered = diskPressure(worktrees, 9_800_000_000, 10_000_000_000, plan, { pass: current, now });
  assert.equal(answered.low, true); assert.equal(answered.answered, true); assert.equal(answered.warnBelow, 10_000_000_000);
  assert.deepEqual(diskPressureAttention(answered), []);
  assert.match(answered.detail!, /found nothing reclaimable .* outside its reach/);
  // A worktree still holding a disposable install: the reclaim text as before, and no answer though the pass is current.
  const disposable = { ...held, path: `${worktrees}/GY-70-1`, name: 'GY-70-1', key: 'GY-70', disposition: 'delivered' as const, disposable: true, idleMs: hour, detail: 'GY-70 is delivered', dependencies: [{ path: `${worktrees}/GY-70-1/node_modules`, kind: 'directory' as const }] };
  const pressed = diskPressure(worktrees, 9_800_000_000, 10_000_000_000, [disposable, ...plan], { pass: current, now });
  assert.equal(pressed.answered, false); assert.equal(pressed.drained, false);
  assert.match(diskPressureAttention(pressed)[0].text, /1 of 240 assignment worktree\(s\) hold dependency directories a fresh install recreates \(.*still has reach \(1 worktrees disposable now\)\)\. Reclaim them before the volume fills$/);
  assert.match(diskPressureAttention(pressed)[0].next, /lower run\.reclaimIdleHours/);
  // No pass recorded and nothing disposable: never "reclaim them"; the line says no pass is recorded.
  const unrecorded = diskPressureAttention(diskPressure(worktrees, 9_800_000_000, 10_000_000_000, plan, { now }))[0];
  assert.match(unrecorded.text, /\(the loop has recorded no worktree-reclaim pass\)\. The volume's remaining holders are outside the loop's reach/);
  // The context is optional: the line reads as before GY-1784 without it, except for the honest text.
  assert.equal(diskPressure(worktrees, 40_000_000_000, 10_000_000_000, plan).low, false);
  // And the registry reading's own attention, with nothing reclaimable, says the same and names the choices.
  const reading = resourceAttention(readResources({ now, reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, revision: null, profiles: { workers: [], reviewers: [], producers: [] },
    disk: { path: worktrees, totalBytes: 1_022_000_000_000, freeBytes: 9_800_000_000, thresholdBytes: 10_000_000_000, pass: drained } }));
  assert.equal(reading.length, 1); assert.equal(reading[0].subject, 'resource:worktree-disk');
  assert.match(reading[0].text, /Coordinator worktree disk is low: 1012\.2 GB used of 1022\.0 GB, 9\.8 GB left — \/home\/vish\/code\/graphyard\/\.graphyard\/worktrees; the loop's latest worktree-reclaim pass at .* found nothing reclaimable \(no disposable dependency directories, reclaimable worktrees or unowned managed checkouts\), so the volume's remaining holders are outside its reach: free host data on the volume, raise run\.diskThresholdGb/);
  assert.doesNotMatch(reading[0].text, /Reclaim them before the volume fills/);
  assert.match(reading[0].next, /free host data on the volume, raise run\.diskThresholdGb, or move the worktree root to a dedicated volume/);
});

test('unit:disk-reach-now — a pass that removed the last disposable material leaves both lines describing nothing reclaimable now, and the managed root fault never stands for the worktree volume', async () => {
  const at = new Date(Date.now() - 60_000).toISOString(), pass = { at, removed: 3, trees: 0, treeBacklog: 0, checkouts: 0, errors: 0, freeBytes: 4_000_000_000 };
  const low = diskPressure('/w', 4_000_000_000, 10_000_000_000, [], { pass });
  assert.equal(low.drained, true, 'nothing is reclaimable now, whatever the pass removed');
  assert.equal(low.answered, false, 'the pass is not a drained pass, so it does not answer');
  const [item] = diskPressureAttention(low);
  assert.match(item.text, /outside the loop's reach/);
  assert.doesNotMatch(item.text, /Reclaim them before the volume fills|still has reach/);
  const backlog = diskPressure('/w', 4_000_000_000, 10_000_000_000, [], { pass: { ...pass, treeBacklog: 2 } });
  assert.equal(backlog.drained, false, 'worktrees waiting on the next cycle are reach');
  // A root-minimum fault on the shared subject is not the worktree volume's fault: it never applies the recovery band.
  const open = (text: string) => ({ [`disk-pressure|disk|${wording(text)}`]: 'x' });
  assert.equal(standingDiskLine(open('Managed worktree root free space is below its minimum at the last reclaim (t)'), 'disk-pressure'), false);
  assert.equal(standingDiskLine(open('Free space below its configured bound at the last reclaim (t)'), 'disk-pressure'), true);
});

test('unit:disk-answer-needs-honest-inputs — a pass dated ahead of the clock, an unreadable inventory and a plan with reach now each leave a low reading raised', async () => {
  const disk = await import('../src/master/worktree-disk.js');
  const { disposableWorktrees } = await import('../src/master-resources.js');
  const credentials = await temporaryDirectory('disk-honest');
  try {
    const token = join(credentials, 'coordinator.token'); await writeFile(token, coordinatorToken, { mode: 0o600 });
    const master = config(token, { diskThresholdGb: 10 }), threshold = diskThresholdBytes(master), now = Date.now(), low = 9_900_000_000;
    // AC-2: a pass stamped after the judging clock has not occurred there, so it is never current.
    const future = reclaimSummary(now + 5 * 60_000, low, {}) as Parameters<typeof disk.worktreePassOf>[0];
    const futureJudged = disk.judgeWorktreeDisk({ freeBytes: low, thresholdBytes: threshold, pass: disk.worktreePassOf(future), reclaimable: 0 }, now);
    assert.equal(futureJudged.current, false); assert.equal(futureJudged.answered, false);
    const past = reclaimSummary(now - 60_000, low, {}) as Parameters<typeof disk.worktreePassOf>[0];
    assert.equal(disk.judgeWorktreeDisk({ freeBytes: low, thresholdBytes: threshold, pass: disk.worktreePassOf(past), reclaimable: 0 }, now).answered, true);
    // AC-2: a worktree directory that exists but cannot be read is a plan nobody knows, not an empty one.
    const root = await temporaryDirectory('disk-honest-root');
    try {
      await mkdir(join(root, '.graphyard'), { recursive: true });
      await writeFile(worktreesDirectory(root), 'not a directory');
      assert.equal(await disposableWorktrees(root, master, { work: [], now }), null);
      await rm(worktreesDirectory(root), { force: true });
      assert.equal(await disposableWorktrees(root, master, { work: [], now }), 0, 'a directory that does not exist yet is an empty plan');
    } finally { await rm(root, { recursive: true, force: true }); }
    // AC-4: the loop's derived line judges the same plan the registry does: a current drained pass does not answer a plan with reach now.
    const state = emptyDaemonState(master);
    state.reclaim = reclaimSummary(now - 60_000, low, {}) as typeof state.reclaim;
    const kinds = (worktreeReclaimable?: number | null) => cycleFaults(state, [], now, { config: master, worktreeReclaimable }).filter(fault => fault.kind === 'disk-pressure').length;
    assert.equal(kinds(0), 0); assert.equal(kinds(2), 1); assert.equal(kinds(null), 1);
  } finally { await rm(credentials, { recursive: true, force: true }); }
});

test('unit:disk-answer-scope — checkouts taken from another filesystem do not count against the worktree volume, a finished tree with no install counts as reach, and an unreadable directory is never cached as an empty inventory', async () => {
  const disk = await import('../src/master/worktree-disk.js');
  const { reclaimSummarySchema } = await import('../src/daemon/state.js');
  // AC-1: a managed root on its own volume freed nothing here: its removed checkouts leave the pass drained for the worktree volume.
  const summary = reclaimSummarySchema.parse({ at: new Date().toISOString(), scanned: 3, removed: 0, kept: 3, freedBytes: 0, freeBytes: 9_900_000_000, checkouts: 2, checkoutsOffVolume: 2 });
  assert.equal(disk.worktreePassOf(summary)!.checkouts, 0);
  assert.equal(disk.worktreePassOf({ ...summary, checkoutsOffVolume: 0 })!.checkouts, 2, 'checkouts on the worktree volume still count');
  assert.equal(disk.worktreePassOf({ ...summary, checkoutsOffVolume: undefined })!.checkouts, 2, 'a cursor from before the field counts them all');
  // AC-2: a delivered tree holding no dependency directory is still removed outright by the next pass.
  const root = await temporaryDirectory('disk-scope');
  try {
    const tree = join(worktrees.worktreesDirectory(root), 'GY-9-1');
    await mkdir(tree, { recursive: true });
    const done = [{ key: 'GY-9', stage: 'done', epoch: 1, workspaces: [{ path: tree, epoch: 1, branch: 'b' }] }] as unknown as Work[];
    const entries = await inventoryWorktrees(root), now = Date.now(), plan = planWorktreeReclaim(entries, done, { now, idleMs: hour });
    assert.equal(plan.filter(entry => entry.disposable).length, 0);
    assert.equal(worktrees.reclaimableNow(plan, entries, done, { idleMs: hour, now }), 1);
    const held = [{ path: tree, activityAt: entries[0].activityAt, reason: 'Uncommitted changes' }];
    assert.equal(worktrees.reclaimableNow(plan, entries, done, { idleMs: hour, now, held }), 0, 'a tree held as dirty is not reach');
    // AC-2: an unreadable worktree directory is reported as such, not as an empty directory.
    await rm(worktrees.worktreesDirectory(root), { recursive: true, force: true });
    assert.equal(await worktrees.worktreesUnreadable(root), false);
    await writeFile(worktrees.worktreesDirectory(root), 'file');
    assert.equal(await worktrees.worktreesUnreadable(root), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
