import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { deploymentObservationSchema, emptyDaemonState, runDaemon, writeDaemonState, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import * as upgrade from '../src/daemon/upgrade.js';
import type { SelfUpgradeDeps, SelfUpgradeOutcome } from '../src/daemon/upgrade.js';
import { coordinatorCheckoutGuard } from '../src/daemon/run.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import type { CoordinatorCheckout } from '../src/master/profiles.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// The module's exports are read through its namespace: on a base without them (the exercise with
// the change reverted) each test fails as a test case rather than at link time.
const { describeSelfUpgrade, heldCliPointer, heldCliSnapshotAt, leftBehindCheckoutAttention, loadedHeldSnapshot, performSelfUpgrade, readHeldCli } = upgrade;

/**
 * GY-1773: a dirty operator checkout never refuses the loop's self-upgrade. performSelfUpgrade used
 * to refuse it (`checkout-dirty`), and the loop's checkout guard skipped the upgrade before that, so
 * an operator editing in the coordinator checkout left the loop on stale code until a
 * checkout-restore. The snapshot a held restart already uses (holdCliAt) needs no clean checkout:
 * the merged commit is checked out under .graphyard/held-cli, the launcher is pinned to it, the
 * executors and the loop restart onto it, and the checkout — never touched — is recorded as left
 * behind with its dirty paths. Real repositories and the shipped git throughout; the fleet and the
 * supervisor are recorded fakes. Each test is named for the proof it produces:
 * unit:dirty-checkout-upgrades-by-snapshot and unit:snapshot-pin-reported-and-lifted.
 */

const clock = Date.parse('2030-01-01T12:00:00.000Z');
const iso = (offsetMs = 0) => new Date(clock + offsetMs).toISOString();
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = async (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const verified = (sha: string): DaemonState['deployment'] => deploymentObservationSchema.parse({ source: 'endpoint', sha, at: iso(), reason: null, deployed: ['GY-1'], pending: [] });
const restarted = (to: string) => ({ result: 'restarted' as const, reason: null, coordinator: { commit: to }, held: [], restarted: [], unsupervised: [], forgotten: [] });
const status = (root: string) => execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trimEnd();

/**
 * An origin holding release A and the merged tip B (touching loaded code, or docs only), and the
 * coordinator checkout: a clone of it detached at A, with the shipped launcher beside it so what the
 * pin does to spawned commands is observable, and a master configuration whose cursor lives in its
 * own directory.
 */
async function world(label: string, tipTouches: 'code' | 'docs' = 'code') {
  const origin = await temporaryDirectory(`${label}-origin`);
  const cli = (release: string) => `import { z } from 'zod';\nexport const release: string = '${release}';\nconsole.log(JSON.stringify({ release, argv: process.argv[1], schema: typeof z }));\n`;
  await mkdir(join(origin, 'src', 'daemon'), { recursive: true });
  await writeFile(join(origin, 'src', 'cli.ts'), cli('A'));
  await writeFile(join(origin, 'src', 'daemon', 'state.ts'), "export const upgradeStallCauses = ['checkout-failed', 'release-lagged', 'snapshot-failed'] as const;\n");
  await writeFile(join(origin, 'package.json'), '{ "type": "module" }\n');
  await writeFile(join(origin, 'README.md'), 'release A\n');
  await writeFile(join(origin, 'docs.md'), 'docs for A\n');
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'add', '.');
  git(origin, 'commit', '-q', '-m', 'release A');
  const loaded = git(origin, 'rev-parse', 'HEAD');
  if (tipTouches === 'code') await writeFile(join(origin, 'src', 'cli.ts'), cli('B'));
  else await writeFile(join(origin, 'docs.md'), 'docs for B\n');
  git(origin, 'commit', '-q', '-am', 'release B');
  const tip = git(origin, 'rev-parse', 'HEAD');
  const root = await temporaryDirectory(`${label}-checkout`);
  execFileSync('git', ['clone', '-q', origin, root], { stdio: 'ignore' });
  git(root, 'checkout', '-q', '--detach', loaded);
  await mkdir(join(root, 'bin'));
  for (const file of ['graphyard.mjs', 'held-release-hooks.mjs']) await writeFile(join(root, 'bin', file), await readFile(fileURLToPath(new URL(`../bin/${file}`, import.meta.url))));
  await symlink(fileURLToPath(import.meta.resolve('tsx')).replace(/\/node_modules\/.*$/, '/node_modules'), join(root, 'node_modules'), 'dir');
  const directory = await temporaryDirectory(`${label}-credentials`);
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: join(root, 'bin', 'graphyard.mjs'),
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const launch = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [join(root, 'bin', 'graphyard.mjs'), ...args], { encoding: 'utf8' })) as { release: string; argv: string; schema: string };
  return { origin, root, directory, loaded, tip, master, launch };
}

/** The upgrade's dependencies: the real checkout and git, a recorded fleet restart and self re-execution, the fixed clock. */
function recording(root: string) {
  const calls = { executors: [] as string[], self: 0 };
  const deps = (extra: Partial<SelfUpgradeDeps> = {}): SelfUpgradeDeps => ({ root, run,
    restartExecutors: async to => { calls.executors.push(to); return restarted(to); },
    restartSelf: async () => { calls.self += 1; }, persist: async () => {}, now: () => clock, ...extra });
  return { calls, deps };
}

/** The operator's edit: one tracked file B does not touch, so a later move onto B carries it. */
async function dirtied(root: string) {
  await writeFile(join(root, 'README.md'), 'release A, edited by the operator\n');
  assert.equal(status(root), ' M README.md');
  return ' M README.md';
}

/** The snapshot upgrade from a dirty checkout at A onto B, verified served, as the loop at A performs it. */
async function snapshotUpgrade(w: Awaited<ReturnType<typeof world>>) {
  const before = await dirtied(w.root);
  const state = emptyDaemonState(w.master);
  state.release = { commit: w.loaded, dirty: true };
  state.deployment = verified(w.tip);
  const { calls, deps } = recording(w.root);
  const upgraded = await performSelfUpgrade(w.master, state, deps());
  return { before, state, calls, deps, upgraded, snapshot: heldCliSnapshotAt(w.root, w.tip) };
}

test('unit:dirty-checkout-upgrades-by-snapshot — with a dirty checkout and a newer merged commit the loop restarts onto a held-cli snapshot of that commit with the launcher pinned to it, the checkout\'s tracked files and HEAD unchanged and the cursor naming the checkout left behind with its dirty paths; a clean detached checkout is moved as before with no pin written', async () => {
  const w = await world('dirty-snapshot');
  const { root, loaded, tip, master } = w;
  const { before, state, calls, deps, upgraded, snapshot } = await snapshotUpgrade(w);

  // The outcome: a restart onto the snapshot, naming the checkout it left behind.
  assert.deepEqual(upgraded, { outcome: 'upgraded', from: loaded, to: tip, code: true, executors: restarted(tip), self: true, left: { checkout: loaded, dirty: ['README.md'] } });
  assert.match(describeSelfUpgrade(upgraded), /^restarted onto a held snapshot of [0-9a-f]{12}; the coordinator checkout stays dirty at [0-9a-f]{12}; loaded code moved; executors restarted; the loop re-executes itself$/);
  // The checkout: never touched — HEAD where it stood, the operator's edit intact, nothing stashed or reset.
  assert.equal(git(root, 'rev-parse', 'HEAD'), loaded, 'HEAD is unchanged');
  assert.equal(status(root), before, 'the tracked files are unchanged');
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'release A, edited by the operator\n');
  assert.equal(git(root, 'rev-parse', 'refs/remotes/origin/main'), tip, 'the base branch was fetched');
  // The snapshot: B checked out under .graphyard/held-cli, the launcher pinned to it as a held restart pins it.
  assert.equal(git(snapshot, 'rev-parse', 'HEAD'), tip, 'the snapshot holds the merged commit');
  assert.equal(status(snapshot), '', 'and is clean');
  assert.deepEqual(JSON.parse(await readFile(heldCliPointer(root), 'utf8')), { commit: tip, root: snapshot, loop: true });
  assert.equal(readHeldCli(root), tip);
  assert.equal(w.launch('watch', 'GY-1', '1').release, 'B', 'a command the checkout\'s launcher spawns loads the snapshot');
  assert.deepEqual(w.launch('master', 'run'), { release: 'B', argv: join(root, 'src', 'cli.ts'), schema: 'object' }, 'and so does the loop its supervisor restarts, with the checkout\'s entry as its argv and the checkout\'s dependencies');
  // The restarts: the executors onto exactly B, then the loop itself.
  assert.deepEqual(calls, { executors: [tip], self: 1 });
  // The cursor: the alignment complete, the checkout left behind recorded with its dirty paths, nothing refused or stalled.
  assert.deepEqual(state.upgrade, { alignedRelease: tip, pending: null, last: { at: iso(), from: loaded, to: tip, code: true, executors: 'restarted', self: true }, refused: null,
    snapshot: { at: iso(), commit: tip, checkout: loaded, dirty: ['README.md'] } });
  assert.equal(state.actions['upgrade:refused'], undefined, 'no refusal is recorded');
  const done = Object.values(state.actions).find(action => action.state === 'done' && action.detail.startsWith('Snapshotted base tip'));
  assert.match(done!.detail, /^Snapshotted base tip [0-9a-f]{12} under \.graphyard\/held-cli for the loop and the executors; the coordinator checkout stays dirty at [0-9a-f]{12}: README\.md; loaded code moved, the executors were restarted \(restarted\)$/);

  // The restarted loop: the launcher loaded it from the snapshot, but its startup read the release
  // from the checkout, dirty at A. The first pass records the snapshot's commit as what it runs,
  // and the checkout left behind is no restart target: nothing restarts, nothing is fetched again.
  state.release = { commit: loaded, dirty: true };
  const restartedLoop = deps({ loadedFrom: join(snapshot, 'src', 'daemon', 'upgrade.ts') });
  assert.deepEqual(await performSelfUpgrade(master, state, restartedLoop), { outcome: 'skipped', reason: `release ${tip.slice(0, 12)} was already aligned` });
  assert.deepEqual(state.release, { commit: tip, dirty: false }, 'the loop is recorded as running the snapshot\'s commit');
  assert.deepEqual(calls, { executors: [tip], self: 1 }, 'nothing restarts again');
  assert.equal(git(root, 'rev-parse', 'HEAD'), loaded);
  assert.equal(loadedHeldSnapshot(root, join(snapshot, 'src', 'daemon', 'upgrade.ts')), tip, 'the guard reads the snapshot this process was loaded from');
  assert.equal(loadedHeldSnapshot(root, join(root, 'src', 'daemon', 'upgrade.ts')), null, 'and nothing for a process loaded from the checkout');
  // A loop that never re-executed (its restart failed) still owes the restart onto the snapshot, not onto the checkout's HEAD.
  state.release = { commit: loaded, dirty: true };
  const owed = await performSelfUpgrade(master, state, deps({ loadedFrom: join(root, 'src', 'daemon', 'upgrade.ts') }));
  assert.deepEqual({ outcome: owed.outcome, to: 'to' in owed && owed.to, self: 'self' in owed && owed.self }, { outcome: 'upgraded', to: tip, self: true });
  assert.deepEqual(calls, { executors: [tip, tip], self: 2 });
  assert.equal(git(root, 'rev-parse', 'HEAD'), loaded, 'the checkout is still where it stood');

  // A clean detached checkout: moved exactly as before, and no pin is written for it.
  const clean = await world('clean-move');
  const cleanState = emptyDaemonState(clean.master);
  cleanState.release = { commit: clean.loaded, dirty: false };
  cleanState.deployment = verified(clean.tip);
  const moving = recording(clean.root);
  const moved = await performSelfUpgrade(clean.master, cleanState, moving.deps());
  assert.deepEqual({ outcome: moved.outcome, to: 'to' in moved && moved.to, code: 'code' in moved && moved.code, self: 'self' in moved && moved.self, left: 'left' in moved }, { outcome: 'upgraded', to: clean.tip, code: true, self: true, left: false });
  assert.equal(git(clean.root, 'rev-parse', 'HEAD'), clean.tip, 'the checkout moved onto the tip');
  assert.equal(existsSync(heldCliPointer(clean.root)), false, 'no pin is written');
  assert.equal(cleanState.upgrade.snapshot, undefined);
  assert.deepEqual(moving.calls, { executors: [clean.tip], self: 1 });
  assert.equal(clean.launch('watch', 'GY-1', '1').release, 'B', 'the launcher runs the moved checkout');

  // A dirty checkout and a tip touching no loaded code: nothing restarts, nothing is pinned, and the checkout stays.
  const docs = await world('dirty-docs', 'docs');
  await dirtied(docs.root);
  const docsState = emptyDaemonState(docs.master);
  docsState.release = { commit: docs.loaded, dirty: true };
  docsState.deployment = verified(docs.tip);
  const quiet = recording(docs.root);
  assert.deepEqual(await performSelfUpgrade(docs.master, docsState, quiet.deps()), { outcome: 'upgraded', from: docs.loaded, to: docs.tip, code: false, executors: null, self: false });
  assert.deepEqual(quiet.calls, { executors: [], self: 0 });
  assert.equal(git(docs.root, 'rev-parse', 'HEAD'), docs.loaded);
  assert.equal(existsSync(heldCliPointer(docs.root)), false);
  assert.equal(docsState.upgrade.snapshot, undefined);
  assert.equal(docsState.upgrade.alignedRelease, docs.tip);

  // Production still serving A: the restart is held as a move's would be, but no pin is placed (the
  // checkout has not moved), and the pass whose observation serves B completes it onto the snapshot.
  const lagged = await world('dirty-lagged');
  await dirtied(lagged.root);
  const laggedState = emptyDaemonState(lagged.master);
  laggedState.release = { commit: lagged.loaded, dirty: true };
  laggedState.deployment = verified(lagged.loaded);
  const holding = recording(lagged.root);
  const held = await performSelfUpgrade(lagged.master, laggedState, holding.deps());
  assert.equal(held.outcome, 'pending');
  assert.match(held.outcome === 'pending' ? held.reason : '', /^restart held: production serves release [0-9a-f]{12}, which does not contain [0-9a-f]{12} yet; the executors and the loop restart onto [0-9a-f]{12} \(a held snapshot of it: the coordinator checkout is dirty at [0-9a-f]{12} and stays where it is\) on the first pass whose deployment observation serves it$/);
  assert.equal(existsSync(heldCliPointer(lagged.root)), false, 'a hold from a dirty checkout pins nothing');
  assert.deepEqual([laggedState.upgrade.pending, laggedState.upgrade.stalled?.cause, holding.calls], [{ from: lagged.loaded, to: lagged.tip, code: true }, 'release-lagged', { executors: [], self: 0 }]);
  assert.equal(git(lagged.root, 'rev-parse', 'HEAD'), lagged.loaded);
  laggedState.deployment = verified(lagged.tip);
  const completed = await performSelfUpgrade(lagged.master, laggedState, holding.deps({ now: () => clock + 60_000 }));
  assert.deepEqual({ outcome: completed.outcome, left: 'left' in completed && completed.left }, { outcome: 'upgraded', left: { checkout: lagged.loaded, dirty: ['README.md'] } });
  assert.equal(readHeldCli(lagged.root), lagged.tip);
  assert.deepEqual(holding.calls, { executors: [lagged.tip], self: 1 });
  assert.equal(laggedState.actions['upgrade:held']?.state, 'done');
  assert.equal(git(lagged.root, 'rev-parse', 'HEAD'), lagged.loaded, 'the checkout is still where it stood');
  assert.equal(status(lagged.root), ' M README.md');
});

test('unit:snapshot-pin-reported-and-lifted — master status reports the loop\'s release as the snapshot\'s commit and names the checkout as left behind while the pin stands; moving the checkout onto that commit lifts the pin; the loop\'s guard lets a snapshot loop cycle beside the dirty checkout and no longer skips the upgrade for it', async () => {
  const w = await world('status');
  const { root, loaded, tip, master } = w;
  const { state, calls, deps, snapshot } = await snapshotUpgrade(w);
  // The restarted loop's first pass, as above: the cursor master status reads.
  state.release = { commit: loaded, dirty: true };
  const restartedLoop = deps({ loadedFrom: join(snapshot, 'src', 'daemon', 'upgrade.ts') });
  assert.equal((await performSelfUpgrade(master, state, restartedLoop)).outcome, 'skipped');
  state.lock = { id: 'lock', pid: process.pid, host: master.hostId, startedAt: iso(-60_000), heartbeatAt: iso() };
  await writeDaemonState(master, state);
  const masterApi = async (path: string) => path === 'work-snapshot' ? { work: [], now: iso() } : { decisions: [] };
  const report = await masterStatusReport(root, master, masterApi, { actor: { id: 'coordinator-1' } }, { commit: loaded });

  // The loop's release is the snapshot's commit, in the daemon summary and the lag report alike.
  assert.deepEqual((report.daemon as { release?: unknown }).release, { commit: tip, dirty: false });
  assert.equal(report.releaseLag.components.find(row => row.component === 'loop')!.release.commit, tip);
  assert.deepEqual((report.daemon as { upgrade?: { snapshot?: unknown } }).upgrade?.snapshot, { at: iso(), commit: tip, checkout: loaded, dirty: ['README.md'] });
  // The checkout is named as left behind, with its dirty paths and the move that lifts the pin.
  const named = report.attentionItems.filter(item => item.subject === 'upgrade');
  assert.equal(named.length, 1);
  assert.match(named[0].text, new RegExp(`^The loop and the executors run ${tip.slice(0, 12)} from its held snapshot under .*/\\.graphyard/held-cli, not from the coordinator checkout, which stood dirty at ${loaded.slice(0, 12)} \\(dirty: README\\.md\\) when the self-upgrade ran at ${iso()} and was left where it stands`));
  assert.equal(named[0].role, 'master');
  assert.ok(named[0].next.includes(`git -C ${root} checkout --detach ${tip}`), 'the remedy is the move that lifts the pin');
  assert.ok(!report.attentionItems.some(item => /left the coordinator checkout .* untouched/.test(item.text)), 'no refusal is reported');
  // Named only while the pin stands at that commit.
  assert.deepEqual(leftBehindCheckoutAttention(state.upgrade.snapshot, null, root), []);
  assert.deepEqual(leftBehindCheckoutAttention(state.upgrade.snapshot, 'f'.repeat(40), root), []);
  assert.equal(leftBehindCheckoutAttention(state.upgrade.snapshot, tip.slice(0, 12), root).length, 1);

  // Moving the checkout onto the snapshot's commit — the operator's edit carried along, the tree
  // still dirty — lifts the pin: the launcher runs the checkout again, and nothing is named.
  git(root, 'checkout', '-q', '--detach', tip);
  assert.equal(status(root), ' M README.md', 'the move carried the edit; the tree is still dirty');
  const lifted = await performSelfUpgrade(master, state, deps({ loadedFrom: join(snapshot, 'src', 'daemon', 'upgrade.ts'), now: () => clock + 60_000 }));
  assert.deepEqual(lifted, { outcome: 'up-to-date', commit: tip });
  assert.equal(existsSync(heldCliPointer(root)), false, 'the pin is lifted');
  assert.equal(readHeldCli(root), null);
  assert.equal(state.upgrade.snapshot, undefined, 'the checkout is no longer recorded as left behind');
  assert.deepEqual(calls, { executors: [tip], self: 1 }, 'nothing restarts: the checkout holds the commit the loop runs');
  assert.match(Object.values(state.actions).find(action => action.detail.startsWith('The checkout is current'))!.detail, /moved onto the commit the loop runs from its held snapshot, so the pin on the snapshot is lifted$/);
  assert.equal(w.launch('watch', 'GY-1', '1').release, 'B');
  await writeDaemonState(master, state);
  const after = await masterStatusReport(root, master, masterApi, { actor: { id: 'coordinator-1' } }, { commit: tip });
  assert.deepEqual(after.attentionItems.filter(item => item.subject === 'upgrade'), []);
  assert.deepEqual((after.daemon as { release?: unknown }).release, { commit: tip, dirty: false });

  // The loop's checkout guard (src/daemon/run.ts). A loop loaded from the checkout is still refused
  // at startup by a dirty tree — its modules came from it — but between cycles the dirty tree no
  // longer skips the self-upgrade, which snapshots. A loop loaded from the held snapshot runs none
  // of the dirty tree's code: it is not refused at startup, its cursor records the snapshot's
  // commit, the escalation still names the tree, and a HEAD moved onto the snapshot's commit is the
  // pin's lift, never drift; a HEAD moved anywhere else still is.
  const dirtyTree: CoordinatorCheckout = { root, commit: loaded, modified: ['README.md'], untracked: [] };
  const guardFor = (runsSnapshot: string | null, read: () => CoordinatorCheckout, logs: string[]) => {
    const guardState = emptyDaemonState(master);
    const upgrades: DaemonState[] = [];
    const guard = coordinatorCheckoutGuard({ state: () => guardState, read: async () => read(), agents: async () => [], snapshot: async () => ({ work: [], now: iso() }),
      persist: async () => {}, now: () => clock, log: line => logs.push(line), applies: () => true, runsSnapshot: () => runsSnapshot });
    const selfUpgrade = async (current: DaemonState): Promise<SelfUpgradeOutcome> => { upgrades.push(current); return { outcome: 'skipped', reason: 'recorded' }; };
    return { guard, guardState, upgrades, selfUpgrade };
  };
  let tree = dirtyTree;
  const logs: string[] = [];
  const checkoutLoaded = guardFor(null, () => tree, logs);
  assert.match((await checkoutLoaded.guard.start(loaded)) ?? '', /refuses to start, self-upgrade or restart/, 'a loop whose modules came from the dirty tree is refused at startup');
  const escalated = checkoutLoaded.guardState.actions['escalation:dirty-checkout'];
  assert.equal(escalated?.state, 'failed');
  assert.match(escalated!.detail, /The self-upgrade is not held by it: a merged release restarts the loop and the executors onto a held snapshot of it, the checkout left where it stands\.$/);
  const between = await checkoutLoaded.guard.betweenCycles(checkoutLoaded.selfUpgrade);
  assert.ok(between.refusal, 'the dirty tree is still escalated');
  assert.equal(checkoutLoaded.upgrades.length, 1, 'but the self-upgrade runs');
  const snapshotLoaded = guardFor(tip, () => tree, logs);
  assert.equal(await snapshotLoaded.guard.start(loaded), null, 'a loop loaded from the snapshot is not refused by the dirty tree');
  assert.match(snapshotLoaded.guardState.actions['escalation:dirty-checkout']!.detail, new RegExp(`This loop runs the held snapshot of ${tip.slice(0, 12)}, not the checkout, and cycles from it; master status names the checkout left behind under upgrade\\.$`));
  assert.ok(logs.some(line => line.includes(`this loop runs the held snapshot of ${tip.slice(0, 12)} and cycles from it`)));
  const beside = await snapshotLoaded.guard.betweenCycles(snapshotLoaded.selfUpgrade);
  assert.deepEqual([beside.upgraded?.outcome, snapshotLoaded.upgrades.length], ['skipped', 1], 'the self-upgrade runs beside the dirty tree');
  assert.match(beside.refusal ?? '', /refuses to start, self-upgrade or restart/, 'which is still escalated');
  tree = { ...dirtyTree, commit: tip };
  const onto = await snapshotLoaded.guard.betweenCycles(snapshotLoaded.selfUpgrade);
  assert.doesNotMatch(onto.refusal ?? '', /HEAD moved/, 'a HEAD moved onto the snapshot\'s commit is no drift');
  assert.equal(snapshotLoaded.upgrades.length, 2, 'the upgrade runs and lifts the pin');
  tree = { root, commit: 'c'.repeat(40), modified: [], untracked: [] };
  const elsewhere = await snapshotLoaded.guard.betweenCycles(snapshotLoaded.selfUpgrade);
  assert.match(elsewhere.refusal ?? '', /HEAD moved from/, 'a HEAD moved anywhere else is drift');
  assert.equal(snapshotLoaded.upgrades.length, 2, 'and drift still skips the upgrade');
  tree = { root, commit: tip, modified: [], untracked: [] };
  assert.equal((await snapshotLoaded.guard.betweenCycles(snapshotLoaded.selfUpgrade)).refusal, null, 'a clean checkout at the commit the loop runs refuses nothing');
  assert.equal(snapshotLoaded.guardState.actions['escalation:dirty-checkout']!.state, 'done', 'and settles the escalation');

  // Wired through runDaemon: the snapshot's commit is the release the process records, and a dirty
  // checkout beside a snapshot loop lets it cycle; beside a checkout-loaded loop it still does not.
  const effects = (upgrades: { count: number }): DaemonEffects => ({
    agents: () => [], credentials: async () => ({}), workerCredentials: async () => ({}), producerCredentials: async () => ({}),
    mutate: async () => ({}), dispatchWorker: async () => ({}), launchReview: async () => ({}), launchProducer: async () => ({}), merge: async () => ({}),
    snapshot: async () => ({ work: [], now: iso() }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: iso(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {}, loadedRelease: { commit: loaded, dirty: true },
    selfUpgrade: async () => { upgrades.count += 1; return { outcome: 'skipped', reason: 'recorded' }; },
  } as unknown as DaemonEffects);
  const options = (loadedSnapshot: string | null) => ({ once: true, intervalMs: 5, identity: { pid: process.pid, host: master.hostId }, signals: [] as NodeJS.Signals[], log: () => {}, checkout: () => dirtyTree, loadedSnapshot: () => loadedSnapshot });
  const pinnedUpgrades = { count: 0 }, pinnedState = emptyDaemonState(master);
  const pinned = await runDaemon(master, pinnedState, effects(pinnedUpgrades), options(tip));
  assert.equal(pinned.cycles.length, 1, 'a snapshot loop cycles beside the dirty checkout');
  assert.deepEqual(pinnedState.release, { commit: tip, dirty: false }, 'and records the snapshot\'s commit as its release');
  assert.equal(pinnedUpgrades.count, 1, 'the between-cycles self-upgrade ran');
  const refusedUpgrades = { count: 0 }, refusedState = emptyDaemonState(master);
  const refused = await runDaemon(master, refusedState, effects(refusedUpgrades), options(null));
  assert.deepEqual([refused.cycles.length, refusedUpgrades.count, refusedState.release], [0, 0, { commit: loaded, dirty: true }], 'a loop loaded from the dirty checkout still cycles nothing');
});
