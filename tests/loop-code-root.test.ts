import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { loopCodeRoot } from '../src/daemon/checkout-state.js';
import { daemonEffects } from '../src/daemon/effects-production.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1899: a managed repository's loop used to read its loaded code through the managed
 * repository's root, which holds the managed project's HEAD, not the code the loop loaded. The
 * loop's loaded-code reading now acts on the checkout the running CLI comes from (the configured
 * cliPath's checkout). Each test is named for the proof it produces: unit:loop-reports-cli-checkout-commit.
 */

// The one instant in the file, handed to the code under test as now: () => now; `new Date(now)`
// derives the observation's stamp from it, and nothing reads the wall clock.
const now = 1_790_000_000_000;
const at = new Date(now).toISOString();
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.com', ...args], { encoding: 'utf8' }).trim();
/** The real child runner the production wiring gets: every git command runs for real, in a fixture. */
const run = (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8' });
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));

const config = (cliPath: string): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath,
  repository: 'owner/managed', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-managed', autoMerge: true, mergeMethod: 'merge', workers: [] });

/**
 * A separate Graphyard checkout with an origin of its own: `main` holds `tip` (one loaded-code
 * commit past `loaded`), and the checkout stands clean and detached at `loaded`, one move behind
 * the tip — what a loop runs between its own alignments. The managed repository can be cloned from
 * `origin` at its own commit, sharing this history (AC-1's fork-or-second-checkout shape).
 */
async function cliCheckout(): Promise<{ checkout: string; loaded: string; tip: string; origin: string }> {
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
  return { checkout, loaded, tip, origin };
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

/** The production startup reading, as run.ts records it at process start: the wiring's own read (`daemonEffects(...).loadedRelease`). */
function startupRelease(managedRoot: string, master: MasterConfig): { commit: string | null; dirty: boolean | null } | null {
  return (daemonEffects(managedRoot, master, { snapshot: async () => ({ work: [], now: at }), mutate: async () => ({}), run }).loadedRelease ?? null) as { commit: string | null; dirty: boolean | null } | null;
}

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
  assert.deepEqual(startupRelease(managed.root, master), { commit: cli.loaded, dirty: false });
  // One directory — the repository and the CLI checkout the same — reads that directory, as today.
  const own = await managedCloneOf(cli.origin, cli.loaded);
  assert.deepEqual(startupRelease(own.root, config(join(own.root, 'bin', 'graphyard.mjs'))), { commit: cli.loaded, dirty: false });
});
