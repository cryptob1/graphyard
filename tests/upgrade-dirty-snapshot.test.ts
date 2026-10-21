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
 * loop restarts onto it, and the checkout — never touched — is recorded as left
 * behind with its dirty paths. Real repositories and the shipped git throughout; the supervisor is a
 * recorded fake. Each test is named for the proof it produces:
 * unit:dirty-checkout-upgrades-by-snapshot and unit:snapshot-pin-reported-and-lifted.
 */

const clock = Date.parse('2030-01-01T12:00:00.000Z');
const iso = (offsetMs = 0) => new Date(clock + offsetMs).toISOString();
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = async (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const verified = (sha: string): DaemonState['deployment'] => deploymentObservationSchema.parse({ source: 'endpoint', sha, at: iso(), reason: null, deployed: ['GY-1'], pending: [] });
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
  await writeFile(join(origin, 'tsconfig.json'), '{}\n');
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

/** The upgrade's dependencies: the real checkout and git, a recorded self re-execution, the fixed clock. */
function recording(root: string) {
  const calls = { self: 0 };
  const deps = (extra: Partial<SelfUpgradeDeps> = {}): SelfUpgradeDeps => ({ root, run,
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
  assert.deepEqual(upgraded, { outcome: 'upgraded', from: loaded, to: tip, code: true, self: true, left: { checkout: loaded, dirty: ['README.md'] } });
  assert.match(describeSelfUpgrade(upgraded), /^restarted onto a held snapshot of [0-9a-f]{12}; the coordinator checkout stays dirty at [0-9a-f]{12}; loaded code moved; the loop re-executes itself$/);
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
  // The restart: the loop itself, onto B.
  assert.deepEqual(calls, { self: 1 });
  // The cursor: the alignment complete, the checkout left behind recorded with its dirty paths, nothing refused or stalled.
  assert.deepEqual(state.upgrade, { alignedRelease: tip, pending: null, last: { at: iso(), from: loaded, to: tip, code: true, self: true }, refused: null,
    snapshot: { at: iso(), commit: tip, checkout: loaded, dirty: ['README.md'] } });
  assert.equal(state.actions['upgrade:refused'], undefined, 'no refusal is recorded');
  const done = Object.values(state.actions).find(action => action.state === 'done' && action.detail.startsWith('Snapshotted base tip'));
  assert.match(done!.detail, /^Snapshotted base tip [0-9a-f]{12} under \.graphyard\/held-cli for the loop; the coordinator checkout stays dirty at [0-9a-f]{12}: README\.md; loaded code moved$/);

  // The restarted loop: the launcher loaded it from the snapshot, but its startup read the release
  // from the checkout, dirty at A. The first pass records the snapshot's commit as what it runs,
  // and the checkout left behind is no restart target: nothing restarts, nothing is fetched again.
  state.release = { commit: loaded, dirty: true };
  const restartedLoop = deps({ loadedFrom: join(snapshot, 'src', 'daemon', 'upgrade.ts') });
  assert.deepEqual(await performSelfUpgrade(master, state, restartedLoop), { outcome: 'skipped', reason: `release ${tip.slice(0, 12)} was already aligned` });
  assert.deepEqual(state.release, { commit: tip, dirty: false }, 'the loop is recorded as running the snapshot\'s commit');
  assert.deepEqual(calls, { self: 1 }, 'nothing restarts again');
  assert.equal(git(root, 'rev-parse', 'HEAD'), loaded);
  assert.equal(loadedHeldSnapshot(root, join(snapshot, 'src', 'daemon', 'upgrade.ts')), tip, 'the guard reads the snapshot this process was loaded from');
  assert.equal(loadedHeldSnapshot(root, join(root, 'src', 'daemon', 'upgrade.ts')), null, 'and nothing for a process loaded from the checkout');
  // A loop that never re-executed (its restart failed) still owes the restart onto the snapshot, not onto the checkout's HEAD.
  state.release = { commit: loaded, dirty: true };
  const owed = await performSelfUpgrade(master, state, deps({ loadedFrom: join(root, 'src', 'daemon', 'upgrade.ts') }));
  assert.deepEqual({ outcome: owed.outcome, to: 'to' in owed && owed.to, self: 'self' in owed && owed.self }, { outcome: 'upgraded', to: tip, self: true });
  assert.deepEqual(calls, { self: 2 });
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
  assert.deepEqual(moving.calls, { self: 1 });
  assert.equal(clean.launch('watch', 'GY-1', '1').release, 'B', 'the launcher runs the moved checkout');

  // A dirty checkout and a tip touching no loaded code: still a restart onto a held snapshot — the
  // snapshot made, the launcher pinned, the loop re-executed onto it — and the checkout stays where it stands.
  const docs = await world('dirty-docs', 'docs');
  await dirtied(docs.root);
  const docsState = emptyDaemonState(docs.master);
  docsState.release = { commit: docs.loaded, dirty: true };
  docsState.deployment = verified(docs.tip);
  const quiet = recording(docs.root);
  const docsUpgraded = await performSelfUpgrade(docs.master, docsState, quiet.deps());
  assert.deepEqual(docsUpgraded, { outcome: 'upgraded', from: docs.loaded, to: docs.tip, code: false, self: true, left: { checkout: docs.loaded, dirty: ['README.md'] } });
  assert.match(describeSelfUpgrade(docsUpgraded), /^restarted onto a held snapshot of [0-9a-f]{12}; the coordinator checkout stays dirty at [0-9a-f]{12}; no loaded code moved; the loop re-executes itself$/);
  assert.deepEqual(quiet.calls, { self: 1 }, 'the loop alone re-executes: no loaded code moved');
  assert.equal(git(docs.root, 'rev-parse', 'HEAD'), docs.loaded, 'the checkout is unchanged');
  assert.equal(status(docs.root), ' M README.md');
  const docsSnapshot = heldCliSnapshotAt(docs.root, docs.tip);
  assert.equal(git(docsSnapshot, 'rev-parse', 'HEAD'), docs.tip, 'the snapshot holds the merged commit even though it is docs-only');
  assert.deepEqual(JSON.parse(await readFile(heldCliPointer(docs.root), 'utf8')), { commit: docs.tip, root: docsSnapshot, loop: true }, 'the launcher is pinned to it');
  assert.deepEqual(docs.launch('watch', 'GY-1', '1'), { release: 'A', argv: join(docs.root, 'src', 'cli.ts'), schema: 'object' }, 'a command the checkout\'s launcher spawns loads the snapshot\'s modules — release A, the code it already ran — with the checkout\'s entry as its argv');
  assert.deepEqual(docsState.upgrade, { alignedRelease: docs.tip, pending: null, last: { at: iso(), from: docs.loaded, to: docs.tip, code: false, self: true }, refused: null,
    snapshot: { at: iso(), commit: docs.tip, checkout: docs.loaded, dirty: ['README.md'] } });
  // The re-executed loop's first pass: the snapshot's commit is what it runs, and the checkout left
  // behind is no restart target.
  docsState.release = { commit: docs.loaded, dirty: true };
  const docsLoop = quiet.deps({ loadedFrom: join(docsSnapshot, 'src', 'daemon', 'upgrade.ts') });
  assert.deepEqual(await performSelfUpgrade(docs.master, docsState, docsLoop), { outcome: 'skipped', reason: `release ${docs.tip.slice(0, 12)} was already aligned` });
  assert.deepEqual(docsState.release, { commit: docs.tip, dirty: false }, 'the loop is recorded as running the snapshot\'s commit');

  // A second merged head while the checkout still stands dirty where it was left: the snapshot is
  // re-made onto the new tip and the loop re-executed onto it — one snapshot, pin and re-execution
  // per head, the checkout never touched.
  await writeFile(join(docs.origin, 'docs.md'), 'docs for C\n');
  git(docs.origin, 'commit', '-q', '-am', 'release C');
  const secondTip = git(docs.origin, 'rev-parse', 'HEAD');
  docsState.deployment = verified(secondTip);
  const again = await performSelfUpgrade(docs.master, docsState, quiet.deps({ now: () => clock + 60_000 }));
  assert.deepEqual(again, { outcome: 'upgraded', from: docs.loaded, to: secondTip, code: false, self: true, left: { checkout: docs.loaded, dirty: ['README.md'] } });
  assert.deepEqual(quiet.calls, { self: 2 }, 'one re-execution per head');
  const secondSnapshot = heldCliSnapshotAt(docs.root, secondTip);
  assert.equal(git(secondSnapshot, 'rev-parse', 'HEAD'), secondTip);
  assert.deepEqual(JSON.parse(await readFile(heldCliPointer(docs.root), 'utf8')), { commit: secondTip, root: secondSnapshot, loop: true }, 'the pin advanced to the new head\'s snapshot');
  assert.equal(existsSync(docsSnapshot), true, 'the snapshot the pin replaced is kept for processes still loading under it');
  assert.deepEqual(docsState.upgrade.snapshot, { at: iso(60_000), commit: secondTip, checkout: docs.loaded, dirty: ['README.md'] });
  assert.deepEqual(Object.keys(docsState.actions).filter(key => key.startsWith('upgrade:')).length, 2, 'one upgrade action row per head, the cursor bounded by the heads');

  // A docs-only snapshot whose re-execution failed: the next pass still owes the restart onto the
  // snapshot, as the alignment decided.
  const retry = await world('dirty-docs-retry', 'docs');
  await dirtied(retry.root);
  const retryState = emptyDaemonState(retry.master);
  retryState.release = { commit: retry.loaded, dirty: true };
  retryState.deployment = verified(retry.tip);
  const retrying = recording(retry.root);
  const unrestarted = await performSelfUpgrade(retry.master, retryState, retrying.deps({ restartSelf: async () => { throw new Error('the user bus is down'); } }));
  assert.deepEqual({ outcome: unrestarted.outcome, cause: retryState.upgrade.stalled?.cause, self: retryState.upgrade.last?.self, code: retryState.upgrade.last?.code }, { outcome: 'failed', cause: 'supervisor-unreachable', self: false, code: false });
  assert.equal(readHeldCli(retry.root), retry.tip, 'the snapshot stands pinned');
  const retried = await performSelfUpgrade(retry.master, retryState, retrying.deps({ now: () => clock + 60_000 }));
  assert.deepEqual({ outcome: retried.outcome, code: 'code' in retried && retried.code, self: 'self' in retried && retried.self }, { outcome: 'upgraded', code: false, self: true });
  assert.deepEqual(retrying.calls, { self: 1 }, 'the retry re-executes the loop alone: no loaded code moved');
  assert.equal(retryState.upgrade.stalled, undefined);

  // The loop already running a snapshot diffs the next tip from that snapshot, not from the checkout
  // it left behind: the checkout's HEAD says nothing about what is loaded. B moved loaded code, so a
  // docs-only C over it moves none, and a D that reverts B's code —
  // sharing the checkout's src/ tree — moves it.
  const chain = await world('dirty-chain');
  const { state: chainState, calls: chainCalls, deps: chainDeps } = await snapshotUpgrade(chain);
  assert.deepEqual(chainCalls, { self: 1 });
  await writeFile(join(chain.origin, 'docs.md'), 'docs for C\n');
  git(chain.origin, 'commit', '-q', '-am', 'release C: docs only over B');
  const chainC = git(chain.origin, 'rev-parse', 'HEAD');
  chainState.release = { commit: chain.loaded, dirty: true };
  chainState.deployment = verified(chainC);
  const onB = chainDeps({ loadedFrom: join(heldCliSnapshotAt(chain.root, chain.tip), 'src', 'daemon', 'upgrade.ts'), now: () => clock + 60_000 });
  const toC = await performSelfUpgrade(chain.master, chainState, onB);
  assert.deepEqual({ outcome: toC.outcome, to: 'to' in toC && toC.to, code: 'code' in toC && toC.code, left: 'left' in toC && toC.left }, { outcome: 'upgraded', to: chainC, code: false, left: { checkout: chain.loaded, dirty: ['README.md'] } });
  assert.deepEqual(chainCalls, { self: 2 }, 'docs over the running snapshot: the loop alone re-executes');
  assert.equal(readHeldCli(chain.root), chainC);
  await writeFile(join(chain.origin, 'src', 'cli.ts'), await readFile(join(chain.root, 'src', 'cli.ts'), 'utf8'));
  git(chain.origin, 'commit', '-q', '-am', 'release D: revert the loaded-code change of B');
  const chainD = git(chain.origin, 'rev-parse', 'HEAD');
  assert.equal(git(chain.origin, 'diff', '--name-only', `${chain.loaded}..${chainD}`), 'docs.md', 'D shares the checkout\'s src/ tree');
  chainState.release = { commit: chain.loaded, dirty: true };
  chainState.deployment = verified(chainD);
  const onC = chainDeps({ loadedFrom: join(heldCliSnapshotAt(chain.root, chainC), 'src', 'daemon', 'upgrade.ts'), now: () => clock + 120_000 });
  const toD = await performSelfUpgrade(chain.master, chainState, onC);
  assert.deepEqual({ outcome: toD.outcome, to: 'to' in toD && toD.to, code: 'code' in toD && toD.code }, { outcome: 'upgraded', to: chainD, code: true });
  assert.deepEqual(chainCalls, { self: 3 }, 'the revert moves loaded code: the loop restarts onto D');
  assert.equal(readHeldCli(chain.root), chainD);
  assert.equal(git(chain.root, 'rev-parse', 'HEAD'), chain.loaded, 'the checkout never moved');
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
  assert.match(named[0].text, new RegExp(`^The loop runs ${tip.slice(0, 12)} from its held snapshot under .*/\\.graphyard/held-cli, not from the coordinator checkout, which stood dirty at ${loaded.slice(0, 12)} \\(dirty: README\\.md\\) when the self-upgrade ran at ${iso()} and was left where it stands`));
  assert.equal(named[0].role, 'master');
  assert.ok(named[0].next.includes(`git -C ${root} checkout --detach ${tip}`), 'the remedy is the move that lifts the pin');
  assert.ok(!report.attentionItems.some(item => /left the coordinator checkout .* untouched/.test(item.text)), 'no refusal is reported');
  // Named only while the pin stands at that commit.
  assert.deepEqual(leftBehindCheckoutAttention(state.upgrade.snapshot, null, root), []);
  assert.deepEqual(leftBehindCheckoutAttention(state.upgrade.snapshot, 'f'.repeat(40), root), []);
  assert.equal(leftBehindCheckoutAttention(state.upgrade.snapshot, tip.slice(0, 12), root).length, 1);

  // Moving the checkout onto the snapshot's commit — the operator's edit carried along, the tree
  // still dirty — does not lift the pin yet: the checkout guard (GY-857) refuses any process started
  // from a tracked edit, loaded code or not, so a lift onto the dirty tree would stop the next
  // loop start. The pin stays, the cursor names the checkout as it stands now, and
  // master status says what lifts it; cleaned at the commit, the pin lifts, the launcher runs the
  // checkout again, and nothing is named.
  git(root, 'checkout', '-q', '--detach', tip);
  assert.equal(status(root), ' M README.md', 'the move carried the edit; the tree is still dirty');
  const kept = await performSelfUpgrade(master, state, deps({ loadedFrom: join(snapshot, 'src', 'daemon', 'upgrade.ts'), now: () => clock + 30_000 }));
  assert.deepEqual(kept, { outcome: 'skipped', reason: `the checkout holds ${tip.slice(0, 12)}, the commit the loop runs from its held snapshot, but tracked files are dirty in it (README.md); the pin stays until it is clean` });
  assert.equal(readHeldCli(root), tip, 'the pin stays');
  assert.deepEqual(state.upgrade.snapshot, { at: iso(), commit: tip, checkout: tip, dirty: ['README.md'] }, 'the cursor names the checkout as it stands now');
  assert.equal(w.launch('watch', 'GY-1', '1').release, 'B', 'the launcher still loads the snapshot');
  const keptNamed = leftBehindCheckoutAttention(state.upgrade.snapshot, tip, root);
  assert.match(keptNamed[0].text, /not from the coordinator checkout, which holds that commit but is still dirty \(dirty: README\.md\); every command the checkout's launcher starts loads the snapshot while the pin stands\.$/);
  assert.match(keptNamed[0].next, /^Return the checkout's tracked files to the commit, which lifts the pin: git -C .* status --porcelain names them/);
  await writeFile(join(root, 'src', 'cli.ts'), `${await readFile(join(root, 'src', 'cli.ts'), 'utf8')}// edited\n`);
  const keptCode = await performSelfUpgrade(master, state, deps({ loadedFrom: join(snapshot, 'src', 'daemon', 'upgrade.ts'), now: () => clock + 40_000 }));
  assert.deepEqual(keptCode, { outcome: 'skipped', reason: `the checkout holds ${tip.slice(0, 12)}, the commit the loop runs from its held snapshot, but tracked files are dirty in it (README.md, src/cli.ts); the pin stays until it is clean` });
  assert.deepEqual(state.upgrade.snapshot, { at: iso(), commit: tip, checkout: tip, dirty: ['README.md', 'src/cli.ts'] }, 'loaded code edited too: named with the rest');
  git(root, 'checkout', '-q', '--', 'src/cli.ts', 'README.md');
  assert.equal(status(root), '', 'the checkout is clean at the commit');
  // A pointer whose removal fails still pins the launcher: the lift is not reported and retries.
  const stuck = await performSelfUpgrade(master, state, { ...deps({ loadedFrom: join(snapshot, 'src', 'daemon', 'upgrade.ts'), now: () => clock + 50_000 }), holdCli: async () => { throw new Error('EACCES'); } });
  assert.equal(stuck.outcome, 'skipped');
  assert.match((stuck as { reason: string }).reason, /pin could not be lifted: EACCES; retried next cycle$/);
  assert.equal(readHeldCli(root), tip, 'the pin stands');
  assert.ok(state.upgrade.snapshot, 'the snapshot record stays');
  const lifted = await performSelfUpgrade(master, state, deps({ loadedFrom: join(snapshot, 'src', 'daemon', 'upgrade.ts'), now: () => clock + 60_000 }));
  assert.deepEqual(lifted, { outcome: 'up-to-date', commit: tip });
  assert.equal(existsSync(heldCliPointer(root)), false, 'the pin is lifted');
  assert.equal(readHeldCli(root), null);
  assert.equal(state.upgrade.snapshot, undefined, 'the checkout is no longer recorded as left behind');
  assert.deepEqual(calls, { self: 1 }, 'nothing restarts: the checkout holds the commit the loop runs');
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
  assert.match(escalated!.detail, /The self-upgrade is not held by it: a merged release restarts the loop onto a held snapshot of it, the checkout left where it stands\.$/);
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
  assert.equal(snapshotLoaded.upgrades.length, 3, 'but the snapshot loop runs no checkout code, so the upgrade still runs (GY-1773)');
  for (const cycle of [4, 5]) {
    tree = { root, commit: String(cycle).repeat(40), modified: ['README.md'], untracked: [] };
    assert.match((await snapshotLoaded.guard.betweenCycles(snapshotLoaded.selfUpgrade)).refusal ?? '', /refuses to start, self-upgrade or restart|HEAD moved/);
    assert.equal(snapshotLoaded.upgrades.length, cycle, 'a dirty checkout whose HEAD keeps moving never stops later snapshot upgrades');
  }
  const stillCheckoutLoaded = guardFor(null, () => tree, logs);
  await stillCheckoutLoaded.guard.start(loaded);
  // GY-1773: a checkout-loaded loop whose dirty tree's HEAD moved from A to C still runs the self-upgrade, which snapshots.
  tree = { root, commit: 'd'.repeat(40), modified: ['README.md'], untracked: [] };
  const movedDirty = await stillCheckoutLoaded.guard.betweenCycles(stillCheckoutLoaded.selfUpgrade);
  assert.equal(stillCheckoutLoaded.upgrades.length, 1, 'a dirty tree whose HEAD moved never holds the upgrade back');
  assert.ok(movedDirty.refusal, 'and is still escalated');
  assert.equal((await stillCheckoutLoaded.guard.betweenCycles(stillCheckoutLoaded.selfUpgrade)).upgraded?.outcome, 'skipped');
  tree = { root, commit: tip, modified: [], untracked: [] };
  assert.equal((await snapshotLoaded.guard.betweenCycles(snapshotLoaded.selfUpgrade)).refusal, null, 'a clean checkout at the commit the loop runs refuses nothing');
  assert.equal(snapshotLoaded.guardState.actions['escalation:dirty-checkout']!.state, 'done', 'and settles the escalation');

  // Wired through runDaemon: the snapshot's commit is the release the process records, and a dirty
  // checkout beside a snapshot loop lets it cycle; beside a checkout-loaded loop it still does not.
  const effects = (upgrades: { count: number }): DaemonEffects => ({
    agents: () => [], credentials: async () => ({}), workerCredentials: async () => ({}), producerCredentials: async () => ({}),
    mutate: async () => ({}), dispatchWorker: async () => ({}), launchReview: async () => ({}), launchProducer: async () => ({}), merge: async () => ({}),
    snapshot: async () => ({ work: [], now: iso() }), closeSession: () => {}, dispatch: async () => {},
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: iso(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, persist: async () => {}, loadedRelease: { commit: loaded, dirty: true },
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

test('unit:snapshot-pin-survives-dirty-head-move — a dirty checkout whose HEAD moves to another commit while the pin stands is no restart target: the aligned release owes nothing, the loop keeps running the snapshot, and the pin stands', async () => {
  const w = await world('head-move');
  const { root, origin, loaded, tip, master } = w;
  const { state, calls, deps, snapshot } = await snapshotUpgrade(w);
  state.release = { commit: tip, dirty: false };
  const pass = (offset: number) => performSelfUpgrade(master, state, deps({ loadedFrom: join(snapshot, 'src', 'daemon', 'upgrade.ts'), now: () => clock + offset }));
  assert.equal((await pass(1_000)).outcome, 'skipped');
  // The operator's HEAD moves, edit carried, onto a commit that is neither the one they left nor the snapshot's.
  await writeFile(join(origin, 'docs.md'), 'docs for C\n');
  git(origin, 'commit', '-q', '-am', 'release C');
  git(root, 'fetch', '-q', 'origin');
  git(root, 'checkout', '-q', '--detach', git(origin, 'rev-parse', 'HEAD'));
  assert.notEqual(git(root, 'rev-parse', 'HEAD'), loaded);
  assert.equal(status(root), ' M README.md', 'the move carried the edit; the tree is still dirty');
  for (const offset of [2_000, 3_000]) {
    const moved = await pass(offset);
    assert.equal(moved.outcome, 'skipped', JSON.stringify(moved));
  }
  assert.equal(state.upgrade.pending ?? null, null, 'no restart is owed onto the dirty checkout');
  assert.deepEqual(calls, { self: 1 }, 'nothing restarted beyond the snapshot upgrade');
  assert.equal(readHeldCli(root), tip, 'the pin stands');
  assert.equal(w.launch('watch', 'GY-1', '1').release, 'B', 'the launcher still loads the snapshot');
});

test('unit:owed-restart-onto-dirtied-head-snapshots — a restart owed onto loaded code that the checkout already holds is a snapshot restart once the checkout is dirtied, never a restart onto the dirty tree', async () => {
  const w = await world('owed-dirtied');
  const { root, loaded, tip, master } = w;
  git(root, 'fetch', '-q', 'origin');
  git(root, 'checkout', '-q', '--detach', tip);
  await dirtied(root);
  const state = emptyDaemonState(master);
  state.release = { commit: loaded, dirty: false };
  state.deployment = verified(tip);
  state.upgrade.pending = { from: loaded, to: tip, code: true };
  const { calls, deps } = recording(root);
  const done = await performSelfUpgrade(master, state, deps());
  assert.equal(done.outcome, 'upgraded', JSON.stringify(done));
  assert.equal(readHeldCli(root), tip, 'the launcher is pinned to the snapshot');
  assert.equal(state.upgrade.snapshot?.commit, tip);
  assert.equal(w.launch('watch', 'GY-1', '1').release, 'B');
  assert.equal(status(root), ' M README.md', 'the dirty checkout is untouched');
});

test('unit:dirty-checkout-holding-the-tip-snapshots-it — a dirty checkout that already holds the newly deployed commit restarts the loop onto a held snapshot of it, with no pending restart finished onto the dirty tree', async () => {
  const w = await world('holds-tip');
  const { root, loaded, tip, master } = w;
  git(root, 'fetch', '-q', 'origin');
  git(root, 'checkout', '-q', '--detach', tip);
  await dirtied(root);
  const state = emptyDaemonState(master);
  state.release = { commit: loaded, dirty: false };
  state.deployment = verified(tip);
  const { calls, deps } = recording(root);
  const done = await performSelfUpgrade(master, state, deps());
  assert.equal(done.outcome, 'upgraded', JSON.stringify(done));
  assert.equal(readHeldCli(root), tip, 'the launcher is pinned to the snapshot');
  assert.equal(state.upgrade.snapshot?.commit, tip);
  assert.equal(status(root), ' M README.md', 'the dirty checkout is untouched');
});

test('unit:dirty-path-named-with-an-arrow — a modified tracked file whose name contains " -> " is named whole in the dirty paths, and a rename names both the path the commit holds and the path the tree holds', async () => {
  const w = await world('arrow-path');
  const { root } = w;
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'foo -> bar.ts'), 'one\n');
  await writeFile(join(root, 'old name.txt'), 'two\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'files');
  await writeFile(join(root, 'src', 'foo -> bar.ts'), 'edited\n');
  const modified = await upgrade.checkoutState(root, run);
  assert.deepEqual(modified.dirtyPaths, ['src/foo -> bar.ts']);
  git(root, 'checkout', '-q', '--', '.');
  git(root, 'mv', 'old name.txt', 'new name.txt');
  const renamed = await upgrade.checkoutState(root, run);
  assert.deepEqual(renamed.dirtyPaths, ['old name.txt', 'new name.txt'], 'the source the commit holds and the destination the tree holds');
  git(root, 'mv', 'new name.txt', 'new -> name.ts');
  const arrowed = await upgrade.checkoutState(root, run);
  assert.deepEqual(arrowed.dirtyPaths, ['old name.txt', 'new -> name.ts'], 'a destination holding " -> " is named whole');
  // A rename out of a loaded path: the loaded source the tree no longer holds is named, so the
  // loaded-path decisions see it; the arrow in its name is parsed as the pair's.
  git(root, 'mv', 'src/foo -> bar.ts', 'foo.md');
  const out = await upgrade.checkoutState(root, run);
  assert.deepEqual([...out.dirtyPaths].sort(), ['foo.md', 'new -> name.ts', 'old name.txt', 'src/foo -> bar.ts']);
  assert.equal(upgrade.upgradeTouchesCode(out.dirtyPaths.filter(path => path !== 'old name.txt' && path !== 'new -> name.ts')), true, 'the rename out of src/ touches loaded code');
});

test('unit:dirty-launcher-snapshots-foreign-head-and-tsconfig-keep-the-pin — a dirty launcher holds no snapshot restart back and is named on the attention, a clean detached foreign HEAD is no restart target while the pin stands, and a dirty tsconfig.json keeps the pin on a checkout moved onto the snapshot', async () => {
  // The launcher is the bootstrap that reads the pin, and since GY-1790 what the units start is
  // the launcher held in the snapshot, so a dirty one is a dirty checkout like any other — the
  // restart goes onto the snapshot, the checkout and its launcher untouched, and master status
  // names the launcher: the supervised starts never run it, commands through it still do.
  const l = await world('launcher-dirty');
  git(l.root, 'add', 'bin');
  git(l.root, 'commit', '-q', '-m', 'launcher');
  const launched = git(l.root, 'rev-parse', 'HEAD');
  for (const file of ['graphyard.mjs', 'held-release-hooks.mjs']) await writeFile(join(l.root, 'bin', file), `${await readFile(join(l.root, 'bin', file), 'utf8')}// edited by the operator\n`);
  assert.equal(status(l.root), ' M bin/graphyard.mjs\n M bin/held-release-hooks.mjs');
  const state = emptyDaemonState(l.master);
  state.release = { commit: launched, dirty: true };
  state.deployment = verified(l.tip);
  const { calls, deps } = recording(l.root);
  const done = await performSelfUpgrade(l.master, state, deps());
  assert.deepEqual({ outcome: done.outcome, left: 'left' in done && done.left }, { outcome: 'upgraded', left: { checkout: launched, dirty: ['bin/graphyard.mjs', 'bin/held-release-hooks.mjs'] } });
  assert.deepEqual([calls.self, readHeldCli(l.root)], [1, l.tip], 'the loop restarts onto the snapshot, the launcher pinned to it');
  assert.deepEqual([git(l.root, 'rev-parse', 'HEAD'), status(l.root)], [launched, ' M bin/graphyard.mjs\n M bin/held-release-hooks.mjs'], 'the checkout and its launcher are untouched');
  assert.equal(state.upgrade.pending, null, 'nothing stays owed');
  assert.deepEqual(state.upgrade.snapshot, { at: iso(), commit: l.tip, checkout: launched, dirty: ['bin/graphyard.mjs', 'bin/held-release-hooks.mjs'] });
  assert.equal(state.upgrade.stalled, undefined);
  const named = leftBehindCheckoutAttention(state.upgrade.snapshot, l.tip, l.root);
  assert.match(named[0].text, /stood dirty at [0-9a-f]{12} \(dirty: bin\/graphyard\.mjs, bin\/held-release-hooks\.mjs\) when the self-upgrade ran .* The checkout's launcher \(bin\/graphyard\.mjs, bin\/held-release-hooks\.mjs\) is dirty too: the loop starts the launcher held in the snapshot, so its starts never run those edits; every command started through the checkout's launcher still runs its edited bin\/graphyard\.mjs before the pin redirects any module, so return it to the commit first\.$/);
  assert.equal(l.launch('watch', 'GY-1', '1').release, 'B', 'the edited launcher still reads the pin and loads the snapshot');
  // A clean detached HEAD that is neither the snapshot nor the commit the operator left is a foreign move.
  const f = await world('foreign-head');
  const { state: after, calls: fleet, deps: fdeps, snapshot } = await snapshotUpgrade(f);
  after.release = { commit: f.tip, dirty: false };
  await writeFile(join(f.origin, 'docs.md'), 'docs for C\n');
  git(f.origin, 'commit', '-q', '-am', 'release C');
  git(f.root, 'fetch', '-q', 'origin');
  git(f.root, 'checkout', '-q', 'README.md');
  git(f.root, 'checkout', '-q', '--detach', git(f.origin, 'rev-parse', 'HEAD'));
  assert.equal(status(f.root), '');
  const foreign = await performSelfUpgrade(f.master, after, fdeps({ loadedFrom: join(snapshot, 'src', 'daemon', 'upgrade.ts') }));
  assert.equal(foreign.outcome, 'skipped', JSON.stringify(foreign));
  assert.deepEqual([fleet.self, readHeldCli(f.root)], [1, f.tip], 'no restart onto the foreign HEAD; the pin stands');
  // Moved onto the snapshot's commit with tsconfig.json dirty: the launcher would run the edit, so the pin stays.
  const t = await world('tsconfig-dirty');
  const { state: moved, deps: tdeps } = await snapshotUpgrade(t);
  moved.release = { commit: t.tip, dirty: false };
  git(t.root, 'checkout', '-q', '--detach', t.tip);
  await writeFile(join(t.root, 'tsconfig.json'), '{ "compilerOptions": {} }\n');
  const kept = await performSelfUpgrade(t.master, moved, tdeps());
  assert.equal(kept.outcome, 'skipped', JSON.stringify(kept));
  assert.equal(readHeldCli(t.root), t.tip, 'the pin stays');
});

test('unit:unreadable-status-never-lifts-the-pin-or-moves-the-checkout — a checkout left behind whose status cannot be read is neither taken for clean nor moved: the pin stands, nothing restarts, and an owed snapshot restart waits for a readable status', async () => {
  const w = await world('unreadable-status');
  const { root, loaded, tip, master } = w;
  const { state, calls, deps, snapshot } = await snapshotUpgrade(w);
  const unreadable: SelfUpgradeDeps['run'] = async (command, args) => { if (args.includes('status')) throw new Error('fatal: Unable to create index.lock: File exists'); return run(command, args); };
  const onSnapshot = (offset: number, extra: Partial<SelfUpgradeDeps> = {}) => deps({ loadedFrom: join(snapshot, 'src', 'daemon', 'upgrade.ts'), now: () => clock + offset, ...extra });
  // The loop on the snapshot, the checkout still at A and cleaned there: unreadable, it is no move target.
  state.release = { commit: tip, dirty: false };
  git(root, 'checkout', '-q', '--', 'README.md');
  assert.equal(status(root), '', 'the checkout is clean where it stood');
  const unread = await performSelfUpgrade(master, state, onSnapshot(30_000, { run: unreadable }));
  assert.deepEqual(unread, { outcome: 'skipped', reason: `release ${tip.slice(0, 12)} was already aligned` });
  assert.deepEqual([git(root, 'rev-parse', 'HEAD'), readHeldCli(root), calls, state.upgrade.snapshot?.commit], [loaded, tip, { self: 1 }, tip], 'not moved, the pin and the record stand, nothing restarts');
  // Readable again, the clean detached checkout left behind is moved onto the commit, which lifts the pin.
  const moved = await performSelfUpgrade(master, state, onSnapshot(60_000));
  assert.equal(moved.outcome, 'upgraded', JSON.stringify(moved));
  assert.deepEqual([git(root, 'rev-parse', 'HEAD'), readHeldCli(root), state.upgrade.snapshot], [tip, null, undefined], 'moved onto the commit, the pin lifted');
  // A loop not yet on the snapshot (its re-execution failed) owes the restart onto it: with the
  // checkout's status unreadable the restart waits, rather than recording dirty paths it cannot read.
  const owed = await world('unreadable-owed');
  await dirtied(owed.root);
  const owedState = emptyDaemonState(owed.master);
  owedState.release = { commit: owed.loaded, dirty: true };
  owedState.deployment = verified(owed.tip);
  const owing = recording(owed.root);
  assert.equal((await performSelfUpgrade(owed.master, owedState, owing.deps({ restartSelf: async () => { throw new Error('the user bus is down'); } }))).outcome, 'failed');
  assert.equal(readHeldCli(owed.root), owed.tip, 'the snapshot stands pinned');
  const waiting = await performSelfUpgrade(owed.master, owedState, owing.deps({ run: unreadable, now: () => clock + 60_000 }));
  assert.deepEqual(waiting, { outcome: 'skipped', reason: `the restart onto the held snapshot of ${owed.tip.slice(0, 12)} is still owed, but whether the coordinator checkout at ${owed.loaded.slice(0, 12)} is dirty could not be read; retried next cycle` });
  assert.deepEqual([owing.calls, git(owed.root, 'rev-parse', 'HEAD'), readHeldCli(owed.root), owedState.upgrade.snapshot?.dirty], [{ self: 0 }, owed.loaded, owed.tip, ['README.md']]);
  const retried = await performSelfUpgrade(owed.master, owedState, owing.deps({ now: () => clock + 120_000 }));
  assert.deepEqual({ outcome: retried.outcome, self: 'self' in retried && retried.self }, { outcome: 'upgraded', self: true }, 'readable again, the owed restart goes through');
});

test('unit:retried-snapshot-restart-records-the-dirty-paths-as-they-stand — a snapshot restart whose re-execution failed is retried with the checkout\'s dirty paths read now, and the cursor records the checkout left behind as it stood at the successful restart', async () => {
  const w = await world('retry-dirty-paths');
  await dirtied(w.root);
  const state = emptyDaemonState(w.master);
  state.release = { commit: w.loaded, dirty: true };
  state.deployment = verified(w.tip);
  const { calls, deps } = recording(w.root);
  const unrestarted = await performSelfUpgrade(w.master, state, deps({ restartSelf: async () => { throw new Error('the user bus is down'); } }));
  assert.deepEqual({ outcome: unrestarted.outcome, dirty: state.upgrade.snapshot?.dirty }, { outcome: 'failed', dirty: ['README.md'] });
  // Before the retry the operator restores README.md and edits docs.md instead.
  git(w.root, 'checkout', '-q', '--', 'README.md');
  await writeFile(join(w.root, 'docs.md'), 'docs for A, edited by the operator\n');
  assert.equal(status(w.root), ' M docs.md');
  const retried = await performSelfUpgrade(w.master, state, deps({ now: () => clock + 60_000 }));
  assert.deepEqual({ outcome: retried.outcome, left: 'left' in retried && retried.left }, { outcome: 'upgraded', left: { checkout: w.loaded, dirty: ['docs.md'] } });
  assert.deepEqual(state.upgrade.snapshot, { at: iso(60_000), commit: w.tip, checkout: w.loaded, dirty: ['docs.md'] }, 'the dirty paths as they stood at the successful restart, not at the failed one');
  assert.deepEqual(calls, { self: 1 });
  assert.deepEqual(leftBehindCheckoutAttention(state.upgrade.snapshot, w.tip, w.root)[0].text.includes('(dirty: docs.md)'), true);
});

test('unit:rename-out-of-a-loaded-path-keeps-the-pin — a checkout moved onto the snapshot\'s commit with a loaded source renamed away from its path is still dirty: both paths are recorded and the pin stays until the rename is undone', async () => {
  const w = await world('rename-out');
  const { state, deps, snapshot } = await snapshotUpgrade(w);
  state.release = { commit: w.tip, dirty: false };
  git(w.root, 'checkout', '-q', '--', 'README.md');
  git(w.root, 'checkout', '-q', '--detach', w.tip);
  git(w.root, 'mv', 'src/daemon/state.ts', 'state-notes.md');
  const pass = (offset: number) => performSelfUpgrade(w.master, state, deps({ loadedFrom: join(snapshot, 'src', 'daemon', 'upgrade.ts'), now: () => clock + offset }));
  const kept = await pass(30_000);
  assert.deepEqual(kept, { outcome: 'skipped', reason: `the checkout holds ${w.tip.slice(0, 12)}, the commit the loop runs from its held snapshot, but tracked files are dirty in it (src/daemon/state.ts, state-notes.md); the pin stays until it is clean` });
  assert.deepEqual([readHeldCli(w.root), state.upgrade.snapshot?.dirty], [w.tip, ['src/daemon/state.ts', 'state-notes.md']], 'the pin stays; the loaded source the tree no longer holds is named beside its destination');
  git(w.root, 'mv', 'state-notes.md', 'src/daemon/state.ts');
  assert.equal(status(w.root), '');
  assert.deepEqual(await pass(60_000), { outcome: 'up-to-date', commit: w.tip });
  assert.equal(readHeldCli(w.root), null, 'undone, the pin lifts');
});
