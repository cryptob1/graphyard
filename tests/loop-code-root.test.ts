import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { daemonSummary, deploymentObservationSchema, emptyDaemonState, writeDaemonState } from '../src/master-daemon.js';
import { checkoutState, loopCodeRoot } from '../src/daemon/checkout-state.js';
import { alignRunningLoopUnit, heldCliPointer, heldCliSnapshotAt, heldExecutorEntryOf, holdCliAt, loadedHeldSnapshot, performSelfUpgrade, readHeldCli, recoverMovedHead, type SelfUpgradeDeps } from '../src/daemon/upgrade.js';
import { daemonEffects } from '../src/daemon/effects-production.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { alignLoopUnit, loopUnitOf, loopUnitText } from '../src/supervisor.js';
import { upDependencies } from '../src/up.js';
import { alignExecutorUnitScript, alignExecutorUnits, installExecutorSupervision, judgeLoopCode, renderExecutorUnit } from '../src/repository-setup.js';
// @ts-expect-error The launcher's resolve hooks are a dependency-free entry point script.
import { heldRelease } from '../bin/held-release-hooks.mjs';
// @ts-expect-error The standalone executor is a dependency-free entry point script.
import { executorRelease, handedCheckout } from '../scripts/graphyard-executor.mjs';
import { installUnitsFile, perInstallUnits } from '../src/install/units.js';
import { writeExecutorRegistration } from '../src/executor-fleet.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1899: a managed repository's loop used to read its loaded code and run its self-upgrade
 * through the managed repository's root — deps.root — which holds the managed project's HEAD, not
 * the code the loop loaded. For Graphyard's own install the repository and the CLI checkout are one
 * directory, so it held there and nowhere else. The loop's loaded-code reading and its upgrade step
 * now act on the checkout the running CLI comes from (the configured cliPath's checkout), and a
 * cursor that names a commit the checkout's repository does not hold — a startup read of the
 * managed repository wrote it — is corrected to the checkout's own standing. Each test is named for
 * the proof it produces: unit:loop-reports-cli-checkout-commit and unit:upgrade-acts-on-cli-checkout-only.
 */

// The one instant in the file, handed to the code under test as now: () => now; `new Date(now)`
// derives the observation's stamp from it, and nothing reads the wall clock.
const now = 1_790_000_000_000;
const at = new Date(now).toISOString();
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.com', ...args], { encoding: 'utf8' }).trim();
/** The real child run the upgrade step gets: every git command it issues runs for real, in a fixture. */
const run = (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8' });
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));

const config = (cliPath: string, credentialDirectory?: string): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(credentialDirectory ?? '/outside', 'coordinator.token'), cliPath,
  repository: 'owner/managed', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-managed', autoMerge: true, mergeMethod: 'merge', workers: [] });

interface Calls { persists: number; self: number; executors: string[] }
const deps = (root: string, calls: Calls = { persists: 0, self: 0, executors: [] }): SelfUpgradeDeps & { calls: Calls } => ({
  root, run, now: () => now,
  persist: async () => { calls.persists += 1; },
  restartExecutors: async to => { calls.executors.push(to); return { result: 'restarted' as const, reason: null, coordinator: { commit: to }, held: [], restarted: [], unsupervised: [], forgotten: [] }; },
  restartSelf: async () => { calls.self += 1; },
  calls,
});

/** The managed repository: its own project, one commit, nothing shared with the CLI checkout's history. */
async function managedRepository(): Promise<{ root: string; commit: string }> {
  const root = await temporaryDirectory('loop-code-root-repo');
  await writeFile(join(root, 'README.md'), 'the managed project\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'the managed project');
  return { root, commit: git(root, 'rev-parse', 'HEAD') };
}

/**
 * A separate Graphyard checkout with an origin of its own: `main` holds `tip` (one loaded-code
 * commit past `loaded`), and the checkout stands clean and detached at `loaded`, one move behind
 * the tip — what a loop runs between its own alignments. `seed` and `origin` stay alive so the
 * day's heads can advance the same history (`advance`); the managed repository can be cloned from
 * `origin` at its own commit, sharing this history (AC-1's fork-or-second-checkout shape).
 */
async function cliCheckout(): Promise<{ checkout: string; loaded: string; tip: string; origin: string; seed: string; advance: (version: number) => Promise<string> }> {
  const seed = await temporaryDirectory('loop-code-root-seed'), origin = await temporaryDirectory('loop-code-root-origin');
  await mkdir(join(seed, 'src'), { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  await writeFile(join(seed, 'src', 'loop.ts'), 'export const version = 0;\n');
  // The launcher's sanity read (`readHeldCli`) takes a snapshot for the CLI's code only when it holds src/cli.ts.
  await writeFile(join(seed, 'src', 'cli.ts'), 'export const cli = true;\n');
  git(seed, 'add', 'src/loop.ts', 'src/cli.ts');
  git(seed, 'commit', '-q', '-m', 'base');
  const loaded = git(seed, 'rev-parse', 'HEAD');
  git(origin, 'init', '-q', '--bare');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  await writeFile(join(seed, 'src', 'loop.ts'), 'export const version = 1;\n');
  git(seed, 'commit', '-q', '-am', 'merged release');
  const tip = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'push', '-q', 'origin', 'main');
  const checkout = await temporaryDirectory('loop-code-root-cli');
  git(checkout, 'init', '-q');
  git(checkout, 'remote', 'add', 'origin', origin);
  git(checkout, 'fetch', '-q', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  git(checkout, 'checkout', '-q', '--detach', loaded);
  const advance = async (version: number) => {
    await writeFile(join(seed, 'src', 'loop.ts'), `export const version = ${version};\n`);
    git(seed, 'commit', '-q', '-am', `merged release ${version}`);
    git(seed, 'push', '-q', 'origin', 'main');
    return git(seed, 'rev-parse', 'HEAD');
  };
  return { checkout, loaded, tip, origin, seed, advance };
}

/** The managed repository sharing the CLI checkout's history: another clone of the same origin, standing at `commit` — a commit the CLI checkout's repository holds. */
async function managedCloneOf(origin: string, commit: string): Promise<{ root: string; head: string }> {
  const root = await temporaryDirectory('loop-code-root-managed');
  git(root, 'init', '-q');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'fetch', '-q', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  git(root, 'checkout', '-q', '--detach', commit);
  // The control-plane configuration a managed repository carries in production, untracked like the real one.
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(join(root, '.graphyard', 'master.json'), '{}\n');
  return { root, head: git(root, 'rev-parse', 'HEAD') };
}

test('unit:loop-reports-cli-checkout-commit — a loop run from a separate CLI checkout reports that checkout\u2019s commit as its loaded release, never the managed repository\u2019s HEAD', async () => {
  const managed = await managedRepository();
  const cli = await cliCheckout();
  const master = config(join(cli.checkout, 'bin', 'graphyard.mjs'));
  const state = emptyDaemonState(master);
  // What the loop's startup reading recorded before this fix: the managed repository's own HEAD.
  state.release = { commit: managed.commit, dirty: false };
  const d = deps(managed.root);
  const outcome = await performSelfUpgrade(master, state, d);
  // GY-1958: the managed repository shares nothing with the CLI checkout's project, so the pass
  // refuses the alignment and names the command upgrade. The cursor correction still runs before
  // that gate: the pass reads the CLI checkout, finds its own commit there, corrects the cursor,
  // records the refusal, and writes all of it durably.
  assert.equal(outcome.outcome, 'refused');
  assert.match(outcome.reason, /graphyard up\b/);
  assert.equal(state.release.commit, cli.loaded);
  assert.notEqual(state.release.commit, managed.commit);
  assert.equal(state.release.dirty, false);
  assert.equal(d.calls.persists, 3, 'the corrected release and the refusal are written to the cursor');
});

test('unit:loop-reports-cli-checkout-commit — with the repository and the CLI checkout in one directory the loop keeps reporting that directory\u2019s commit, and a commit the checkout holds is never rewritten away', async () => {
  // One directory: the recorded release is the directory's own commit and stands.
  const managed = await managedRepository();
  const master = config(join(managed.root, 'bin', 'graphyard.mjs'));
  const state = emptyDaemonState(master);
  state.release = { commit: managed.commit, dirty: false };
  const d = deps(managed.root);
  await performSelfUpgrade(master, state, d);
  assert.equal(state.release.commit, managed.commit);
  assert.equal(d.calls.persists, 0, 'one directory: the reading is today\u2019s, nothing is rewritten');

  // A commit the checkout's repository holds — the loaded commit of a checkout that moved forward
  // under the running loop — is the restart the pass owes (GY-1464), never rewritten away.
  const other = await managedRepository();
  const moved = await cliCheckout();
  git(moved.checkout, 'checkout', '-q', '--detach', moved.tip);
  const movedMaster = config(join(moved.checkout, 'bin', 'graphyard.mjs'));
  const movedState = emptyDaemonState(movedMaster);
  movedState.release = { commit: moved.loaded, dirty: false };
  await performSelfUpgrade(movedMaster, movedState, deps(other.root));
  assert.equal(movedState.release.commit, moved.loaded, 'the loaded commit stands in the checkout\u2019s repository, so the cursor keeps it');
});

test('unit:loop-reports-cli-checkout-commit — loopCodeRoot names the launcher\u2019s checkout, and the suite\u2019s own checkout never becomes a test\u2019s code root', async () => {
  const cli = await cliCheckout();
  assert.equal(loopCodeRoot(join(cli.checkout, 'bin', 'graphyard.mjs'), '/srv/repo'), cli.checkout);
  assert.equal(loopCodeRoot(undefined, '/srv/repo'), '/srv/repo');
  assert.equal(loopCodeRoot(null, '/srv/repo'), '/srv/repo');
  // Under the test runner only a checkout under the temporary directories is judged (the guard's own
  // gate): the launcher this suite itself runs from must never move a test's upgrade onto it.
  assert.equal(loopCodeRoot(launcher, '/srv/repo'), '/srv/repo');
});

test('unit:checkout-guard-never-judges-the-suite-checkout — a suite standing under a temporary directory is still never a test\u2019s code root (GY-2018)', async () => {
  // GY-2018: the merge writer's trial runs this suite from a short checkout on a durable root —
  // /var/tmp here, which the guard's own gate names a temporary directory. At 9bc46db8 that gate
  // judged the suite's own checkout, so every fixture config's launcher resolved to the suite's
  // tree instead of the fixture it injected, and eight proofs across loop-code-root, loop-faults,
  // loop-self-upgrade and executor-supervision failed on the base tip itself. A trial-shaped
  // checkout held to the rule through the seam the fix carries fails there and passes here.
  const trialCheckout = await temporaryDirectory('gy-2018-trial');
  assert.equal(loopCodeRoot(join(trialCheckout, 'bin', 'graphyard.mjs'), '/srv/repo', trialCheckout), '/srv/repo', 'the suite checkout standing under a temporary directory is its own, never a judged one');
  // The process's own working directory is what a bare launcher name resolves to; under the trial
  // that is the trial checkout, and the default seam names it so it is refused here too.
  assert.equal(loopCodeRoot('graphyard', '/srv/repo'), '/srv/repo');
  // The exclusion is the suite's checkout alone: a fixture under a temporary directory is still judged.
  const fixtureCheckout = await temporaryDirectory('gy-2018-fixture');
  assert.equal(loopCodeRoot(join(fixtureCheckout, 'bin', 'graphyard.mjs'), '/srv/repo', trialCheckout), fixtureCheckout);
});

test('unit:upgrade-acts-on-cli-checkout-only — the upgrade fetches, diffs and moves the CLI checkout and leaves the managed repository\u2019s HEAD and working tree untouched', async () => {
  // GY-1958: the managed repository is another clone of the checkout's own origin — the fork shape
  // the upgrade still aligns — so the pass fetches and moves the CLI checkout, and the managed
  // repository's HEAD and working tree stand exactly as found.
  const cli = await cliCheckout();
  const managed = await managedCloneOf(cli.origin, cli.loaded);
  await writeFile(join(managed.root, 'notes.txt'), 'work in progress\n');
  const master = config(join(cli.checkout, 'bin', 'graphyard.mjs'));
  const state = emptyDaemonState(master);
  state.release = { commit: cli.loaded, dirty: false };
  state.deployment = deploymentObservationSchema.parse({ source: 'endpoint', sha: cli.tip, at, reason: null, deployed: ['GY-1'], pending: [] });
  const d = deps(managed.root);
  const outcome = await performSelfUpgrade(master, state, d);
  assert.equal(outcome.outcome, 'upgraded');
  assert.equal(outcome.code, true, 'the merged tip touches loaded code');
  assert.deepEqual(d.calls.executors, [cli.tip], 'the executors restart onto the CLI checkout\u2019s tip');
  assert.equal(d.calls.self, 1, 'the loop re-executes itself onto it');
  // The CLI checkout moved to the merged tip, clean and detached there.
  assert.equal(git(cli.checkout, 'rev-parse', 'HEAD'), cli.tip);
  const standing = await checkoutState(cli.checkout, run);
  assert.equal(standing.detached, true);
  assert.equal(standing.dirty, false);
  // The managed repository's HEAD and working tree are exactly as the pass found them.
  assert.equal(git(managed.root, 'rev-parse', 'HEAD'), managed.head);
  assert.ok(existsSync(join(managed.root, 'notes.txt')));
  assert.match(git(managed.root, 'status', '--porcelain'), /notes\.txt/);
  assert.ok(!existsSync(join(managed.root, '.graphyard', 'held-cli.json')), 'no pin or snapshot lands on the managed repository');
  // The move is not a load: the cursor keeps the commit the loop runs until it re-executes.
  assert.equal(state.release.commit, cli.loaded);
  assert.equal(state.upgrade.last?.to, cli.tip);
});

test('unit:upgrade-acts-on-cli-checkout-only — the restarted loop\u2019s cursor is corrected to the CLI checkout\u2019s commit, and up\u2019s master-loop check passes against the commit the loop now reports', async () => {
  const cli = await cliCheckout();
  const master = config(join(cli.checkout, 'bin', 'graphyard.mjs'));
  const state = emptyDaemonState(master);
  state.release = { commit: cli.loaded, dirty: false };
  state.deployment = deploymentObservationSchema.parse({ source: 'endpoint', sha: cli.tip, at, reason: null, deployed: ['GY-1'], pending: [] });
  // GY-1958: the managed repository is another clone of the checkout's own origin — the fork shape
  // the upgrade still aligns — so the first pass upgrades the checkout as before.
  const managed = await managedCloneOf(cli.origin, cli.loaded);
  assert.equal((await performSelfUpgrade(master, state, deps(managed.root))).outcome, 'upgraded');
  // The clone now stands past what the checkout has fetched: its HEAD is a commit the checkout's
  // repository does not hold, exactly what a startup read of the wrong root writes.
  const newer = await cli.advance(3);
  git(managed.root, 'fetch', '-q', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  git(managed.root, 'checkout', '-q', '--detach', newer);
  // The restarted process's startup reading recorded the managed repository's HEAD again.
  state.release = { commit: newer, dirty: false };
  const again = await performSelfUpgrade(master, state, deps(managed.root));
  assert.equal(again.outcome, 'skipped');
  assert.equal(state.release.commit, cli.tip, 'the loop reports the checkout it runs, not the managed repository\u2019s HEAD');

  // up's master-loop check (GY-1859) reads exactly this: the unit starts the CLI checkout's
  // launcher, and the cursor records loading the commit that checkout stands at.
  const reading = judgeLoopCode({
    cli: { root: cli.checkout, commit: cli.tip },
    primary: managed.root, primaryCommit: newer,
    repository: master.repository,
    loop: { unit: 'graphyard-master-owner-managed.service', path: '/etc/systemd/user/graphyard-master-owner-managed.service', checkout: cli.checkout, launcher: cli.checkout },
    cursor: JSON.stringify({ release: { commit: state.release.commit, dirty: state.release.dirty } }),
    executor: null, fleet: [],
  });
  assert.equal(reading.loopStale, null);
  assert.equal(reading.loopCommit, cli.tip);
});

test('unit:upgrade-acts-on-cli-checkout-only — a moved HEAD on the CLI checkout is recovered onto it, never judged on the managed repository', async () => {
  const managed = await managedRepository();
  await writeFile(join(managed.root, 'notes.txt'), 'work in progress\n');
  const cli = await cliCheckout();
  git(cli.checkout, 'checkout', '-q', '--detach', cli.tip);
  const master = config(join(cli.checkout, 'bin', 'graphyard.mjs'));
  const state = emptyDaemonState(master);
  state.release = { commit: cli.loaded, dirty: false };
  state.deployment = deploymentObservationSchema.parse({ source: 'endpoint', sha: cli.tip, at, reason: null, deployed: ['GY-1'], pending: [] });
  // Judged on the managed repository the recovery refuses (`HEAD reads <managed>, not <tip>`); on
  // the CLI checkout the moved HEAD is merged code the verified release serves, so it is adopted.
  const outcome = await recoverMovedHead(master, state, cli.loaded, cli.tip, deps(managed.root));
  assert.equal(outcome.outcome, 'upgraded');
  assert.equal(state.upgrade.last?.to, cli.tip);
  assert.equal(git(managed.root, 'rev-parse', 'HEAD'), managed.commit);
  assert.ok(existsSync(join(managed.root, 'notes.txt')));
  assert.match(git(managed.root, 'status', '--porcelain'), /notes\.txt/);
});


/**
 * The production startup reading, as run.ts layers it at process start (run.ts:275-287): the
 * wiring's own read (`daemonEffects(...).loadedRelease`, what `readRelease` answers), then, when
 * the loaded modules come from a held snapshot, the snapshot's commit over it. `snapshotFor` is a
 * path inside a held snapshot standing in for the restarted process's own entry — exactly what its
 * `import.meta.url` is.
 */
async function startupRelease(managedRoot: string, master: MasterConfig, snapshotFor?: string): Promise<{ commit: string | null; dirty: boolean | null } | null> {
  const reading = (daemonEffects(managedRoot, master, { snapshot: async () => ({ work: [], now: at }), mutate: async () => ({}), run }).loadedRelease ?? null) as { commit: string | null; dirty: boolean | null } | null;
  const snapshot = snapshotFor ? loadedHeldSnapshot(loopCodeRoot(master.cliPath, managedRoot), join(snapshotFor, 'src', 'daemon', 'upgrade.ts')) : null;
  return snapshot ? { commit: snapshot, dirty: false } : reading;
}

/** A minimal answer to every status read the report makes against the control plane, so only the host reads are real. */
const statusApi = async (path: string) => path === 'work-snapshot' ? { work: [], now: at } : { decisions: [] };

test('unit:loop-reports-cli-checkout-commit — the production startup wiring reads the code checkout, even when the managed repository shares its history at another commit', async () => {
  const cli = await cliCheckout();
  // The managed repository: another clone of the same history, standing at the tip — a commit the
  // CLI checkout's repository holds. This is the fork-or-second-checkout shape the unrelated-history
  // test missed: reconciliation's cat-file answers for it, so the false reading used to stand.
  const managed = await managedCloneOf(cli.origin, cli.tip);
  git(cli.checkout, 'cat-file', '-e', managed.head);
  const master = config(join(cli.checkout, 'bin', 'graphyard.mjs'));
  // Through the production wiring, as run.ts records it at startup (run.ts:276-289): the checkout
  // the CLI runs from is read, and the managed repository's HEAD is never taken for it.
  assert.deepEqual(await startupRelease(managed.root, master), { commit: cli.loaded, dirty: false });
  // One directory — the repository and the CLI checkout the same — reads that directory, as today.
  const own = await managedCloneOf(cli.origin, cli.loaded);
  assert.deepEqual(await startupRelease(own.root, config(join(own.root, 'bin', 'graphyard.mjs'))), { commit: cli.loaded, dirty: false });
  // A loop restarted onto a held snapshot records the snapshot's commit, layered over the same
  // wiring read: the checkout beside it has since moved on, and names nothing the loop loaded.
  git(cli.checkout, 'checkout', '-q', '--detach', cli.tip);
  await holdCliAt(cli.checkout, run, cli.loaded);
  const restarted = await startupRelease(managed.root, master, heldCliSnapshotAt(cli.checkout, cli.loaded));
  assert.deepEqual(restarted, { commit: cli.loaded, dirty: false });
  assert.notEqual(restarted.commit, cli.tip, 'the moved checkout beside the loop is not its release');
});

/** A fake supervisor host for the loop unit, its unit directory under a temporary home (the alignment refuses the real one). */
function unitHost(home: string) {
  return { home, platform: 'linux' as const, temporaryDirectories: [join(home, 'elsewhere')],
    run: (command: string, args: string[]) => (args[1] === 'is-enabled' ? 'enabled' : args[1] === 'is-active' ? 'active' : '') };
}

test('unit:upgrade-acts-on-cli-checkout-only — a dirty-checkout upgrade pins and restarts through the held snapshot under the CLI checkout: the loop unit and the executor units start the snapshot, status names the checkout left behind there, and the lift returns them', async () => {
  const cli = await cliCheckout();
  const tip2 = await cli.advance(2);
  const managed = await managedCloneOf(cli.origin, cli.loaded); // shares the history, stands at its own commit
  const credentials = await temporaryDirectory('loop-code-root-credentials');
  const master = config(join(cli.checkout, 'bin', 'graphyard.mjs'), credentials);
  // The loop unit as master init installed it: the checkout's launcher, no pin.
  const home = await temporaryDirectory('loop-code-root-home');
  const unitDirectory = join(home, '.config', 'systemd', 'user');
  await mkdir(unitDirectory, { recursive: true });
  const unitName = loopUnitOf(managed.root), unitPath = join(unitDirectory, unitName);
  const unitInput = { root: managed.root, cliPath: master.cliPath, repository: master.repository, intervalSeconds: master.run.intervalSeconds };
  await writeFile(unitPath, loopUnitText({ ...unitInput, heldLauncher: null }));
  const host = unitHost(home);
  // The checkout is dirtied in a tracked file: the upgrade never touches it, it snapshots instead.
  await writeFile(join(cli.checkout, 'src', 'loop.ts'), 'export const version = 1; // work in progress\n');
  const state = emptyDaemonState(master);
  state.release = { commit: cli.loaded, dirty: false };
  state.deployment = deploymentObservationSchema.parse({ source: 'endpoint', sha: tip2, at, reason: null, deployed: ['GY-1'], pending: [] });
  const executorEntries: (string | null)[] = [];
  let self = 0;
  const deps: SelfUpgradeDeps = {
    root: managed.root, run, now: () => now,
    persist: async written => writeDaemonState(master, written),
    alignUnit: async () => alignRunningLoopUnit(managed.root, master, unitName, input => alignLoopUnit(input, host)),
    alignExecutorUnits: async script => { executorEntries.push(script); return { wrote: 'updated', reason: null }; },
    restartExecutors: async to => ({ result: 'restarted' as const, reason: null, coordinator: { commit: to }, held: [], restarted: [], unsupervised: [], forgotten: [] }),
    restartSelf: async () => { self += 1; state.release = await startupRelease(managed.root, master, heldCliSnapshotAt(cli.checkout, tip2)); },
  };
  const outcome = await performSelfUpgrade(master, state, deps);
  assert.equal(outcome.outcome, 'upgraded', JSON.stringify(outcome));
  // The pin and the snapshot live under the CLI checkout, where its launcher reads them; the
  // managed repository holds neither, and its HEAD and tracked tree stand exactly as found.
  const snapshot = heldCliSnapshotAt(cli.checkout, tip2);
  assert.equal(readHeldCli(cli.checkout), tip2);
  assert.ok(existsSync(heldCliPointer(cli.checkout)));
  assert.ok(!existsSync(heldCliPointer(managed.root)), 'no pin lands on the managed repository');
  assert.ok(!existsSync(join(managed.root, '.graphyard', 'held-cli')), 'no snapshots land on the managed repository');
  assert.equal(git(managed.root, 'rev-parse', 'HEAD'), managed.head);
  assert.equal(git(managed.root, 'status', '--porcelain', '--untracked-files=no'), '', 'the managed repository’s tracked tree is untouched');
  assert.equal(await readFile(join(snapshot, 'src', 'loop.ts'), 'utf8'), 'export const version = 2;\n', 'the snapshot holds the merged tip’s code');
  // GY-1790 through the real alignment: the loop unit's ExecStart starts the snapshot's launcher,
  // and the executor units were pointed at the snapshot's entry — read from the CLI checkout.
  assert.deepEqual(executorEntries, [join(snapshot, 'scripts', 'graphyard-executor.mjs')]);
  assert.equal(await readFile(unitPath, 'utf8'), loopUnitText({ ...unitInput, codeRoot: cli.checkout, heldLauncher: join(snapshot, 'bin', 'graphyard.mjs') }));
  assert.match(await readFile(unitPath, 'utf8'), new RegExp(`^Environment=GRAPHYARD_CHECKOUT_ROOT=${cli.checkout}$`, 'm'), 'the held launcher is handed the CLI checkout its pin lives in, never the managed root');
  // The restarted process loaded the snapshot, so the cursor records it — never the managed
  // repository's HEAD a startup read of the wrong root would have written.
  assert.deepEqual(state.release, { commit: tip2, dirty: false });
  assert.deepEqual(state.upgrade.snapshot, { at, commit: tip2, checkout: cli.loaded, dirty: ['src/loop.ts'] });
  assert.equal(self, 1, 'one restart for one head');
  // Status visibility (master-status.ts): the left-behind checkout is named with the pin under the
  // CLI checkout, and the lift instruction runs there — never against the managed repository.
  await writeDaemonState(master, state);
  const report = await masterStatusReport(managed.root, master, statusApi, { actor: { id: 'coordinator-1' } }, { commit: tip2 }, { now: () => now });
  const behind = report.attentionItems.filter(item => item.text.includes('/.graphyard/held-cli'));
  assert.equal(behind.length, 1, JSON.stringify(report.attentionItems.map(item => item.text)));
  assert.ok(behind[0]!.text.includes(`${cli.checkout}/.graphyard/held-cli`), behind[0]!.text);
  assert.ok(behind[0]!.next.includes(`git -C ${cli.checkout} status --porcelain`), behind[0]!.next);
  assert.ok(report.attentionItems.every(item => !item.text.includes(`${managed.root}/.graphyard/held-cli`)), 'the managed repository is never named as the pin’s home');

  // The checkout moved onto the commit the loop runs from its snapshot and cleaned there: the next
  // pass lifts the pin, returns both units to the checkout, and restarts nothing.
  git(cli.checkout, 'checkout', '-q', '--', 'src/loop.ts');
  git(cli.checkout, 'checkout', '-q', '--detach', tip2);
  const lifted = await performSelfUpgrade(master, state, deps);
  assert.equal(lifted.outcome, 'up-to-date', JSON.stringify(lifted));
  assert.equal(readHeldCli(cli.checkout), null, 'the pin is lifted');
  assert.ok(!existsSync(heldCliPointer(cli.checkout)));
  assert.deepEqual(executorEntries, [join(snapshot, 'scripts', 'graphyard-executor.mjs'), null], 'the executor units go back to the checkout');
  assert.equal(await readFile(unitPath, 'utf8'), loopUnitText({ ...unitInput, heldLauncher: null }), 'the loop unit goes back to the checkout’s launcher');
  assert.equal(state.upgrade.snapshot, undefined);
  assert.equal(self, 1, 'the lift restarts nothing: the code is the same');
  assert.equal(git(managed.root, 'rev-parse', 'HEAD'), managed.head);
});

test('unit:upgrade-acts-on-cli-checkout-only — a restart held for the served release pins the served release under the CLI checkout and completes onto it when production catches up', async () => {
  const cli = await cliCheckout();
  const tip2 = await cli.advance(2);
  const managed = await managedCloneOf(cli.origin, cli.loaded);
  const master = config(join(cli.checkout, 'bin', 'graphyard.mjs'));
  const state = emptyDaemonState(master);
  state.release = { commit: cli.loaded, dirty: false };
  // Production serves the release the loop already runs, which does not contain the merged tip.
  state.deployment = deploymentObservationSchema.parse({ source: 'endpoint', sha: cli.loaded, at, reason: null, deployed: ['GY-1'], pending: [] });
  const executorEntries: (string | null)[] = [];
  let executors: string[] = [], self = 0;
  const deps: SelfUpgradeDeps = {
    root: managed.root, run, now: () => now, persist: async () => {},
    alignUnit: async () => ({ wrote: 'updated', reason: null }),
    alignExecutorUnits: async script => { executorEntries.push(script); return { wrote: 'updated', reason: null }; },
    restartExecutors: async to => { executors.push(to); return { result: 'restarted' as const, reason: null, coordinator: { commit: to }, held: [], restarted: [], unsupervised: [], forgotten: [] }; },
    restartSelf: async () => { self += 1; state.release = await startupRelease(managed.root, master); },
  };
  const held = await performSelfUpgrade(master, state, deps);
  assert.equal(held.outcome, 'pending', JSON.stringify(held));
  assert.equal(state.upgrade.stalled?.cause, 'release-lagged');
  // The pin holds the SERVED release, under the CLI checkout: the moved checkout's launcher speaks
  // the served protocol until the plane catches up, and the managed repository holds nothing.
  assert.equal(readHeldCli(cli.checkout), cli.loaded);
  assert.ok(!existsSync(heldCliPointer(managed.root)));
  assert.equal(git(cli.checkout, 'rev-parse', 'HEAD'), tip2, 'the checkout moved; only the restart is held');
  assert.equal(git(managed.root, 'rev-parse', 'HEAD'), managed.head);
  assert.equal(state.release.commit, cli.loaded, 'the loop still runs the served release');
  // Production catches up: the held restart completes onto the checkout, the pin lifts, the
  // executor units return, and the loop re-executes onto the commit it now reports.
  state.deployment = deploymentObservationSchema.parse({ source: 'endpoint', sha: tip2, at, reason: null, deployed: ['GY-1'], pending: [] });
  const served = await performSelfUpgrade(master, state, deps);
  assert.equal(served.outcome, 'upgraded', JSON.stringify(served));
  assert.equal(served.code, true);
  assert.equal(readHeldCli(cli.checkout), null, 'the pin is lifted once the plane serves the move');
  assert.deepEqual(executorEntries, [null], 'the executor units return to the checkout’s entry');
  assert.deepEqual(executors, [tip2]);
  assert.equal(self, 1);
  assert.deepEqual(state.release, { commit: tip2, dirty: false }, 'the restarted loop reports the checkout it runs');
  assert.equal(git(managed.root, 'rev-parse', 'HEAD'), managed.head);
});

test('unit:upgrade-acts-on-cli-checkout-only — up lifts the pin from the CLI checkout it stands under, never from the managed repository', async () => {
  const cli = await cliCheckout();
  const managed = await managedCloneOf(cli.origin, cli.loaded);
  const master = config(join(cli.checkout, 'bin', 'graphyard.mjs'));
  // The pin stands under the CLI checkout, the way the upgrade's own hold places it.
  await holdCliAt(cli.checkout, run, cli.loaded);
  assert.equal(readHeldCli(cli.checkout), cli.loaded);
  assert.equal(readHeldCli(managed.root), null, 'the managed repository never holds the pin: lifting through it removes nothing');
  const request = { repository: 'owner/managed', provider: 'compose', agent: false, reviewer: 'claude', master: 'claude', goalFile: null, browserProfile: null } as Parameters<typeof upDependencies>[2];
  const deps = upDependencies(managed.root, join(cli.checkout, 'bin', 'graphyard.mjs'), request, () => {});
  const lifted = await deps.liftLoopPins!(null);
  assert.match(lifted[0] ?? '', /the held snapshot at [0-9a-f]{12}/, JSON.stringify(lifted));
  assert.ok((lifted[0] ?? '').includes(heldCliPointer(cli.checkout)), 'the lift names the pointer it removed, under the CLI checkout');
  assert.equal(readHeldCli(cli.checkout), null, 'up lifted the actual pin');
  assert.ok(!existsSync(heldCliPointer(managed.root)));
  assert.equal(git(managed.root, 'rev-parse', 'HEAD'), managed.head);
});

test('unit:upgrade-acts-on-cli-checkout-only — with no pin the executor template binds the CLI checkout\u2019s entry, not a managed Graphyard checkout\u2019s, and status compares the fleet with the CLI checkout\u2019s commit', async () => {
  const cli = await cliCheckout();
  const managed = await managedCloneOf(cli.origin, cli.tip); // a second Graphyard checkout, at another commit
  for (const root of [cli.checkout, managed.root]) { await mkdir(join(root, 'scripts'), { recursive: true }); await writeFile(join(root, 'scripts', 'graphyard-executor.mjs'), '// entry\n'); }
  // The template as the installer rendered it for the managed repository: its own entry.
  const template = await readFile(fileURLToPath(new URL('../examples/master/graphyard-executor@.service', import.meta.url)), 'utf8');
  const installed = renderExecutorUnit(template, { root: managed.root, node: process.execPath });
  assert.match(installed, new RegExp(`^ExecStart=.* ${managed.root}/scripts/graphyard-executor\\.mjs --slot`, 'm'));
  const units = perInstallUnits('owner/managed');
  await writeFile(join(managed.root, installUnitsFile), `${JSON.stringify(units)}\n`);
  const unitDirectory = join(await temporaryDirectory('loop-code-root-units'), 'systemd-user');
  await mkdir(unitDirectory, { recursive: true });
  const unitFile = join(unitDirectory, units.executorTemplate);
  await writeFile(unitFile, installed);
  const reloads: string[][] = [], systemctl = (args: string[]) => { reloads.push(args); return ''; };
  // The unpinned alignment the upgrade runs before restarting the fleet onto the CLI checkout's commit.
  assert.deepEqual(await alignExecutorUnitScript(managed.root, null, { run: systemctl, unitDirectory, codeRoot: cli.checkout }), { wrote: 'updated', reason: null });
  const bound = await readFile(unitFile, 'utf8');
  assert.match(bound, new RegExp(`^ExecStart=.* ${cli.checkout}/scripts/graphyard-executor\\.mjs --slot %i$`, 'm'), 'a slot starts the CLI checkout\u2019s entry, so it registers the commit the upgrade waits for');
  assert.match(bound, new RegExp(`^WorkingDirectory=${managed.root}$`, 'm'), 'the slot still runs in the managed repository');
  assert.deepEqual(await alignExecutorUnitScript(managed.root, null, { run: systemctl, unitDirectory, codeRoot: cli.checkout }), { wrote: 'unchanged', reason: null }, 'a retry writes nothing');
  assert.deepEqual(await alignExecutorUnitScript(managed.root, null, { run: systemctl, unitDirectory, codeRoot: managed.root }), { wrote: 'updated', reason: null });
  assert.equal(await readFile(unitFile, 'utf8'), installed, 'one directory: the install\u2019s own binding, byte for byte');
  assert.deepEqual(reloads, [['daemon-reload'], ['daemon-reload']]);

  // The daemon's own attention report passes no CLI commit: an executor on the CLI checkout's commit is no split.
  const credentials = await temporaryDirectory('loop-code-root-credentials');
  const master = config(join(cli.checkout, 'bin', 'graphyard.mjs'), credentials);
  const stamp = new Date(now).toISOString();
  await writeExecutorRegistration(master, { version: 1, name: 'exec-1', host: master.hostId, pid: process.pid, principal: 'graphyard-master', kinds: ['resync'], intervalSeconds: 5, root: cli.checkout,
    release: { commit: cli.loaded, dirty: false }, supervisor: null, state: 'running', standDown: null, startedAt: stamp, updatedAt: stamp, stoppedAt: null, claims: 0, lastClaim: null, inFlight: null, claiming: null, interrupted: null });
  const report = await masterStatusReport(managed.root, master, statusApi, { actor: { id: 'coordinator-1' } }, { commit: null }, { now: () => now });
  const split = report.attentionItems.filter(item => item.subject === 'executors' && /a release other than the coordinator/.test(item.text));
  assert.deepEqual(split.map(item => item.text), [], 'the fleet is compared with the CLI checkout\u2019s commit, never the managed repository\u2019s HEAD');
  assert.equal(git(managed.root, 'rev-parse', 'HEAD'), managed.head);
});

/**
 * A Graphyard checkout whose launcher is observable: release A and the merged tip B each commit a
 * src/cli.ts that prints the release it is, beside the shipped bin/graphyard.mjs and
 * bin/held-release-hooks.mjs, so a command started through either launcher says which code it ran.
 * The checkout stands at B with the pin on A — a restart held for the served release — and its
 * node_modules reaches the suite's, which the snapshots under .graphyard/held-cli resolve through.
 */
async function launchableCheckout(): Promise<{ checkout: string; a: string; b: string; launch: (launcher: string, handed: string) => string }> {
  const origin = await temporaryDirectory('loop-code-root-launch-origin');
  const cli = (release: string) => `console.log(JSON.stringify({ release: '${release}' }));\n`;
  await mkdir(join(origin, 'src', 'daemon'), { recursive: true });
  await mkdir(join(origin, 'bin'), { recursive: true });
  await mkdir(join(origin, 'scripts'), { recursive: true });
  for (const file of ['graphyard.mjs', 'held-release-hooks.mjs']) await writeFile(join(origin, 'bin', file), await readFile(fileURLToPath(new URL(`../bin/${file}`, import.meta.url))));
  await writeFile(join(origin, 'scripts', 'graphyard-executor.mjs'), '// entry\n');
  await writeFile(join(origin, 'src', 'cli.ts'), cli('A'));
  await writeFile(join(origin, 'src', 'daemon', 'state.ts'), "export const upgradeStallCauses = ['release-lagged'] as const;\n");
  await writeFile(join(origin, 'package.json'), '{ "type": "module" }\n');
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'add', '.');
  git(origin, 'commit', '-q', '-m', 'release A');
  const a = git(origin, 'rev-parse', 'HEAD');
  await writeFile(join(origin, 'src', 'cli.ts'), cli('B'));
  git(origin, 'commit', '-q', '-am', 'release B');
  const b = git(origin, 'rev-parse', 'HEAD');
  const checkout = await temporaryDirectory('loop-code-root-launch-cli');
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  git(checkout, 'checkout', '-q', '--detach', b);
  await symlink(fileURLToPath(import.meta.resolve('tsx')).replace(/\/node_modules\/.*$/, '/node_modules'), join(checkout, 'node_modules'), 'dir');
  await holdCliAt(checkout, run, a);
  const launch = (launcher: string, handed: string) => (JSON.parse(execFileSync(process.execPath, [launcher, 'watch', 'GY-1', '1'], { encoding: 'utf8', env: { ...process.env, GRAPHYARD_CHECKOUT_ROOT: handed } })) as { release: string }).release;
  return { checkout, a, b, launch };
}
/** The managed repository as an install holds it: its own project, with the control-plane configuration a loop's WorkingDirectory must carry. */
async function configuredManagedRepository() {
  const managed = await managedRepository();
  await mkdir(join(managed.root, '.graphyard'), { recursive: true });
  await writeFile(join(managed.root, '.graphyard', 'master.json'), '{}\n');
  return managed;
}
const handedIn = (unit: string) => unit.match(/^Environment="?GRAPHYARD_CHECKOUT_ROOT=([^"\n]+)"?$/m)?.[1] ?? null;
const startedIn = (unit: string) => unit.match(/^ExecStart=\S+ (\S+)/m)?.[1] ?? null;

test('unit:upgrade-acts-on-cli-checkout-only — a held loop unit hands its launcher the CLI checkout, so a CLI the loop spawns through config.cliPath loads the pinned release, never the checkout’s newer code', async () => {
  const cli = await launchableCheckout();
  const managed = await configuredManagedRepository();
  const master = config(join(cli.checkout, 'bin', 'graphyard.mjs'));
  const home = await temporaryDirectory('loop-code-root-launch-home');
  await mkdir(join(home, '.config', 'systemd', 'user'), { recursive: true });
  const unitName = loopUnitOf(managed.root), unitPath = join(home, '.config', 'systemd', 'user', unitName);
  await writeFile(unitPath, loopUnitText({ root: managed.root, cliPath: master.cliPath, repository: master.repository, intervalSeconds: master.run.intervalSeconds, heldLauncher: null }));
  // The loop's own alignment while the pin stands (production: alignUnit → alignRunningLoopUnit).
  const aligned = await alignRunningLoopUnit(managed.root, master, unitName, input => alignLoopUnit(input, unitHost(home)));
  assert.equal(aligned.wrote, 'updated', JSON.stringify(aligned));
  const unit = await readFile(unitPath, 'utf8');
  assert.equal(startedIn(unit), join(heldCliSnapshotAt(cli.checkout, cli.a), 'bin', 'graphyard.mjs'), 'the unit starts the snapshot’s launcher');
  assert.equal(handedIn(unit), cli.checkout, 'the handed checkout is the CLI checkout, where the pin lives');
  assert.match(unit, new RegExp(`^WorkingDirectory=${managed.root}$`, 'm'), 'the loop still works in the managed repository');
  // The environment the unit hands reaches every CLI the loop spawns through config.cliPath: that
  // launcher finds the pin there and loads the served release A, though the checkout stands at B.
  assert.equal(cli.launch(master.cliPath, handedIn(unit)!), 'A', 'a child CLI under the handed environment runs the held release');
  assert.equal(cli.launch(master.cliPath, managed.root), 'B', 'handed the managed root, the same child would have missed the pin and run the newer code');
  assert.equal(cli.launch(startedIn(unit)!, handedIn(unit)!), 'A', 'the unit’s own start runs the snapshot');
  // Re-aligned with the pin standing nothing changes; master init's install path reads the same checkout.
  assert.equal((await alignRunningLoopUnit(managed.root, master, unitName, input => alignLoopUnit(input, unitHost(home)))).wrote, 'unchanged');
  assert.equal(loopUnitText({ root: managed.root, codeRoot: cli.checkout, cliPath: master.cliPath, repository: master.repository, intervalSeconds: master.run.intervalSeconds, heldLauncher: startedIn(unit) }), unit);
});

test('unit:upgrade-acts-on-cli-checkout-only — held executor units hand their entry the CLI checkout on every alignment path, and a held slot’s current release stays the pin across repeated claims and restarts', async () => {
  const cli = await launchableCheckout();
  const managed = await configuredManagedRepository();
  const template = await readFile(fileURLToPath(new URL('../examples/master/graphyard-executor@.service', import.meta.url)), 'utf8');
  const units = perInstallUnits('owner/managed');
  await writeFile(join(managed.root, installUnitsFile), `${JSON.stringify(units)}\n`);
  const unitDirectory = join(await temporaryDirectory('loop-code-root-launch-units'), 'systemd-user');
  await mkdir(unitDirectory, { recursive: true });
  const unitFile = join(unitDirectory, units.executorTemplate);
  const systemctl = (args: string[]) => (args[0] === 'is-active' ? 'active' : '');
  const entry = heldExecutorEntryOf(cli.checkout)!;
  assert.equal(entry, join(heldCliSnapshotAt(cli.checkout, cli.a), 'scripts', 'graphyard-executor.mjs'));
  /** What a slot started by this unit runs and compares before every claim: its modules' release and the checkout's current one. */
  const slot = (unit: string) => {
    const env = { GRAPHYARD_CHECKOUT_ROOT: handedIn(unit) ?? undefined }, script = startedIn(unit)!;
    const held = heldRelease(handedCheckout(env, pathToFileURL(script).href));
    const moduleRoot = join(script, '..', '..');
    return executorRelease(moduleRoot, held, { readRelease: (root: string) => ({ commit: git(root, 'rev-parse', 'HEAD'), dirty: false }), readCommit: (root: string) => git(root, 'rev-parse', 'HEAD') }, handedIn(unit) ?? moduleRoot);
  };
  // Every path that renders a held executor unit: the upgrade's (alignExecutorUnitScript), up's
  // (alignExecutorUnits, reading the pin itself) and init's (installExecutorSupervision).
  const paths: [string, () => Promise<unknown>][] = [
    ['upgrade', () => alignExecutorUnitScript(managed.root, entry, { run: systemctl, unitDirectory, codeRoot: cli.checkout })],
    ['up', () => alignExecutorUnits(managed.root, { run: systemctl, unitDirectory, heldRoot: cli.checkout })],
    ['init', () => installExecutorSupervision(managed.root, { run: systemctl, unitDirectory, template, node: process.execPath, loop: null, heldRoot: cli.checkout })],
  ];
  for (const [label, align] of paths) {
    await writeFile(unitFile, renderExecutorUnit(template, { root: managed.root, node: process.execPath }));
    await align();
    const unit = await readFile(unitFile, 'utf8');
    assert.equal(startedIn(unit), entry, `${label}: the slot starts the snapshot’s entry`);
    assert.equal(handedIn(unit), cli.checkout, `${label}: the entry is handed the CLI checkout, never the managed root`);
    assert.match(unit, new RegExp(`^WorkingDirectory=${managed.root}$`, 'm'), `${label}: the slot still works in the managed repository`);
    // Repeated claims and restarts: each restart is a fresh slot from the same unit; each claim re-reads the current release.
    for (let restart = 0; restart < 3; restart++) {
      const { release, current } = slot(unit);
      assert.deepEqual(release, { commit: cli.a, dirty: false }, `${label}: the slot loaded the pinned release`);
      for (let claim = 0; claim < 3; claim++) assert.equal(current(), cli.a, `${label}: before every claim the current release is still the pin, so the slot never stands down onto the checkout’s ${cli.b.slice(0, 12)} or the managed HEAD ${managed.commit.slice(0, 12)}`);
    }
  }
  // Handed the managed root, the same held slot would read no pin and compare against the managed HEAD: the stand-down loop the binding prevents.
  assert.notEqual(slot((await readFile(unitFile, 'utf8')).replace(cli.checkout, managed.root)).current(), cli.a);
  assert.equal(git(managed.root, 'rev-parse', 'HEAD'), managed.commit);
});

test('unit:upgrade-acts-on-cli-checkout-only — with no pin up’s executor alignment binds the CLI checkout’s entry, not a managed Graphyard checkout’s, and restarts the slots onto it', async () => {
  const cli = await cliCheckout();
  const managed = await managedCloneOf(cli.origin, cli.tip); // a second Graphyard checkout, at another commit
  for (const root of [cli.checkout, managed.root]) { await mkdir(join(root, 'scripts'), { recursive: true }); await writeFile(join(root, 'scripts', 'graphyard-executor.mjs'), '// entry\n'); }
  const template = await readFile(fileURLToPath(new URL('../examples/master/graphyard-executor@.service', import.meta.url)), 'utf8');
  const units = perInstallUnits('owner/managed');
  await writeFile(join(managed.root, installUnitsFile), `${JSON.stringify(units)}\n`);
  const unitDirectory = join(await temporaryDirectory('loop-code-root-up-units'), 'systemd-user');
  await mkdir(unitDirectory, { recursive: true });
  const unitFile = join(unitDirectory, units.executorTemplate);
  await writeFile(unitFile, renderExecutorUnit(template, { root: managed.root, node: process.execPath }));
  assert.equal(readHeldCli(cli.checkout), null, 'no pin stands');
  const request = { repository: 'owner/managed', provider: 'compose', agent: false, reviewer: 'claude', master: 'claude', goalFile: null, browserProfile: null } as Parameters<typeof upDependencies>[2];
  const deps = upDependencies(managed.root, join(cli.checkout, 'bin', 'graphyard.mjs'), request, () => {});
  const calls: string[][] = [];
  const systemctl = (args: string[]) => { calls.push(args); return ''; };
  // The production wiring forwards the alignment's own options; the test's systemctl and unit directory ride through it.
  const alignExecutors = deps.alignExecutors! as (options: Record<string, unknown>, hostInstall: null) => ReturnType<NonNullable<typeof deps.alignExecutors>>;
  const aligned = await alignExecutors({ run: systemctl, unitDirectory, restart: true }, null);
  assert.equal(aligned.wrote, 'updated', JSON.stringify(aligned));
  const bound = await readFile(unitFile, 'utf8');
  assert.equal(startedIn(bound), join(cli.checkout, 'scripts', 'graphyard-executor.mjs'), 'a slot starts the CLI checkout’s entry: the commit up’s fleet check compares against');
  assert.equal(handedIn(bound), null, 'an unpinned entry runs its own checkout, handed nothing');
  assert.match(bound, new RegExp(`^WorkingDirectory=${managed.root}$`, 'm'));
  assert.ok(calls.some(args => args[0] === 'daemon-reload'), 'the rewrite is reloaded');
  assert.equal((await alignExecutors({ run: systemctl, unitDirectory }, null)).wrote, 'unchanged', 'a rerun finds the binding right');
  assert.equal(git(managed.root, 'rev-parse', 'HEAD'), managed.head);
});
