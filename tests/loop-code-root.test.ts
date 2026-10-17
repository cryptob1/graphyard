import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { deploymentObservationSchema, emptyDaemonState } from '../src/master-daemon.js';
import { checkoutState, loopCodeRoot } from '../src/daemon/checkout-state.js';
import { performSelfUpgrade, recoverMovedHead, type SelfUpgradeDeps } from '../src/daemon/upgrade.js';
import { judgeLoopCode } from '../src/repository-setup.js';
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

const config = (cliPath: string): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath,
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
 * the tip — what a loop runs between its own alignments.
 */
async function cliCheckout(): Promise<{ checkout: string; loaded: string; tip: string }> {
  const seed = await temporaryDirectory('loop-code-root-seed'), origin = await temporaryDirectory('loop-code-root-origin');
  await mkdir(join(seed, 'src'), { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  await writeFile(join(seed, 'src', 'loop.ts'), 'export const version = 0;\n');
  git(seed, 'add', 'src/loop.ts');
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
  return { checkout, loaded, tip };
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
  // The pass runs from the CLI checkout, finds the checkout's own commit there, and corrects the cursor durably.
  assert.equal(outcome.outcome, 'skipped');
  assert.equal(state.release.commit, cli.loaded);
  assert.notEqual(state.release.commit, managed.commit);
  assert.equal(state.release.dirty, false);
  assert.equal(d.calls.persists, 1, 'the corrected release is written to the cursor');
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

test('unit:upgrade-acts-on-cli-checkout-only — the upgrade fetches, diffs and moves the CLI checkout and leaves the managed repository\u2019s HEAD and working tree untouched', async () => {
  const managed = await managedRepository();
  await writeFile(join(managed.root, 'notes.txt'), 'work in progress\n');
  const cli = await cliCheckout();
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
  assert.equal(git(managed.root, 'rev-parse', 'HEAD'), managed.commit);
  assert.ok(existsSync(join(managed.root, 'notes.txt')));
  assert.match(git(managed.root, 'status', '--porcelain'), /notes\.txt/);
  assert.ok(!existsSync(join(managed.root, '.graphyard', 'held-cli.json')), 'no pin or snapshot lands on the managed repository');
  // The move is not a load: the cursor keeps the commit the loop runs until it re-executes.
  assert.equal(state.release.commit, cli.loaded);
  assert.equal(state.upgrade.last?.to, cli.tip);
});

test('unit:upgrade-acts-on-cli-checkout-only — the restarted loop\u2019s cursor is corrected to the CLI checkout\u2019s commit, and up\u2019s master-loop check passes against the commit the loop now reports', async () => {
  const managed = await managedRepository();
  const cli = await cliCheckout();
  const master = config(join(cli.checkout, 'bin', 'graphyard.mjs'));
  const state = emptyDaemonState(master);
  state.release = { commit: cli.loaded, dirty: false };
  state.deployment = deploymentObservationSchema.parse({ source: 'endpoint', sha: cli.tip, at, reason: null, deployed: ['GY-1'], pending: [] });
  assert.equal((await performSelfUpgrade(master, state, deps(managed.root))).outcome, 'upgraded');
  // The restarted process's startup reading recorded the managed repository's HEAD again.
  state.release = { commit: managed.commit, dirty: false };
  const again = await performSelfUpgrade(master, state, deps(managed.root));
  assert.equal(again.outcome, 'skipped');
  assert.equal(state.release.commit, cli.tip, 'the loop reports the checkout it runs, not the managed repository\u2019s HEAD');

  // up's master-loop check (GY-1859) reads exactly this: the unit starts the CLI checkout's
  // launcher, and the cursor records loading the commit that checkout stands at.
  const reading = judgeLoopCode({
    cli: { root: cli.checkout, commit: cli.tip },
    primary: managed.root, primaryCommit: managed.commit,
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
