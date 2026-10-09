import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defaultChildRun } from '../src/child-runner.js';
import { credentialTrialVariable, groupTestFiles, runnerDiagnosticTailLength, runTrial, trialAuthor, trialEnvironment, trialMerge, trialNeedsLog, trialRef, lookupPoisoned, trialLookupEntries, trialCheckoutPrefix, trialCheckoutRoot, trialTemporaryPrefix, trialTemporaryRoot, trialTemporaryRoots, trialTemporaryVariables, trialTestGroupSize, TrialCleanupError, TrialEnvironmentError, TrialRunnerError, TrialTimeoutError, withheldTrialVariables, type RunTrialInput } from '../src/merge-writer/trial.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { shadowErrorKey, shadowIdle, shadowReads, shadowRunnerKey, shadowRunnerRetries } from '../src/daemon/cycle-shadow.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';
import { preMergeTestFiles } from '../scripts/ci-tests.mjs';
import { checkoutKinds } from '../src/install/worktree-root.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { reclaimTmpDirectories, tempOwnerMarker, testTempPatterns, writeTempOwner } from '../src/tmp-reclaim.js';
import type { FilesystemProbe } from '../src/install/worktree-root.js';

// GY-1522: the shadow gate's trial merge — the exact merge commit made in the object store, and its
// build and affected tests run in a detached, credential-free checkout that is always removed.

// Every scratch directory here sits under the host's tmpdir without the `graphyard-` prefix: a trial takes seconds to
// minutes, and a runner sweep by a session in another PID namespace (a confined worker beside this one) would take a
// prefixed directory whose owner it cannot see out from under the running trial. The file's after hook removes them.
const identity = { GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com', GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
const gitFor = (root: string) => async (args: string[], env: Record<string, string> = {}) => String(await defaultChildRun('git', ['-C', root, ...args], { env: { ...process.env, ...identity, ...env } }));
// The install this checkout resolves, wherever it sits above it.
const installedModules = resolve(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), '..');
const start = Date.parse('2030-03-01T00:00:00Z'), iso = (at: number) => new Date(at).toISOString();
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });

async function repository(files: Record<string, string>) {
  const root = await temporaryDirectory('trial-merge-repo', tmpdir());
  gitIn(root, 'init', '-q', '-b', 'main');
  const write = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  for (const [path, content] of Object.entries(files)) write(path, content);
  gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', 'base');
  const base = gitIn(root, 'rev-parse', 'HEAD');
  /** A branch off base with the given files, left as a commit (no branch ref survives, so refs/heads holds main only). */
  const commitOnBase = (files: Record<string, string>, message: string) => {
    gitIn(root, 'checkout', '-q', '--detach', base);
    for (const [path, content] of Object.entries(files)) write(path, content);
    gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', message);
    const sha = gitIn(root, 'rev-parse', 'HEAD');
    gitIn(root, 'checkout', '-q', 'main');
    return sha;
  };
  return { root, base, commitOnBase, write };
}

test('unit:trial-merge-exact-commit — trialMerge makes the merge commit of head onto the base tip in the object store: parents [baseTip, head], the merged tree, author graphyard-merge-writer, only refs/graphyard/trial/<head> written, and no worktree, branch or remote touched', async () => {
  const repo = await repository({ 'a.txt': 'one\n', 'b.txt': 'two\n' });
  const baseTip = gitIn(repo.root, 'commit-tree', gitIn(repo.root, 'rev-parse', 'HEAD^{tree}'), '-p', repo.base, '-m', 'main moved');
  gitIn(repo.root, 'reset', '-q', '--hard', baseTip);
  // main moved by editing b.txt; the head edits a.txt from the older base.
  writeFileSync(join(repo.root, 'b.txt'), 'two main\n'); gitIn(repo.root, 'commit', '-q', '-am', 'main edit');
  const tip = gitIn(repo.root, 'rev-parse', 'HEAD');
  const head = repo.commitOnBase({ 'a.txt': 'one head\n' }, 'head edit');
  const before = { heads: gitIn(repo.root, 'for-each-ref', 'refs/heads'), status: gitIn(repo.root, 'status', '--porcelain'), worktrees: gitIn(repo.root, 'worktree', 'list'), remotes: gitIn(repo.root, 'remote') };
  const result = await trialMerge(gitFor(repo.root), { head, baseTip: tip });
  assert.ok('mergeSha' in result, JSON.stringify(result));
  assert.equal(gitIn(repo.root, 'rev-list', '--parents', '-n', '1', result.mergeSha), `${result.mergeSha} ${tip} ${head}`, 'the parents are the base tip, then the head');
  assert.equal(gitIn(repo.root, 'rev-parse', `${result.mergeSha}^{tree}`), result.tree);
  assert.equal(gitIn(repo.root, 'show', `${result.mergeSha}:a.txt`), 'one head', 'the head\'s change is in the merge');
  assert.equal(gitIn(repo.root, 'show', `${result.mergeSha}:b.txt`), 'two main', 'and main\'s');
  assert.equal(gitIn(repo.root, 'log', '-1', '--format=%an', result.mergeSha), trialAuthor);
  assert.equal(gitIn(repo.root, 'rev-parse', trialRef(head)), result.mergeSha, 'the one ref written');
  assert.equal(gitIn(repo.root, 'for-each-ref', '--format=%(refname)', 'refs/graphyard'), trialRef(head));
  assert.deepEqual({ heads: gitIn(repo.root, 'for-each-ref', 'refs/heads'), status: gitIn(repo.root, 'status', '--porcelain'), worktrees: gitIn(repo.root, 'worktree', 'list'), remotes: gitIn(repo.root, 'remote') }, before, 'no branch, worktree, index or remote moved');
  await assert.rejects(trialMerge(gitFor(repo.root), { head: 'main', baseTip: tip }), /full 40-hex/);
});

test('unit:trial-merge-conflict-reported — a head that conflicts with the base tip gives the conflicted paths and writes no commit and no ref', async () => {
  const repo = await repository({ 'a.txt': 'one\n', 'c.txt': 'clean\n' });
  writeFileSync(join(repo.root, 'a.txt'), 'main side\n'); gitIn(repo.root, 'commit', '-q', '-am', 'main edit');
  const tip = gitIn(repo.root, 'rev-parse', 'HEAD');
  const head = repo.commitOnBase({ 'a.txt': 'head side\n', 'd.txt': 'new\n' }, 'head edit');
  const result = await trialMerge(gitFor(repo.root), { head, baseTip: tip });
  assert.deepEqual(result, { conflict: ['a.txt'] });
  assert.equal(gitIn(repo.root, 'for-each-ref', 'refs/graphyard'), '', 'a conflict writes no ref');
  assert.equal(gitIn(repo.root, 'status', '--porcelain'), '');
});

const fixtureFiles = {
  '.gitignore': 'node_modules\n',
  'package.json': JSON.stringify({ name: 'fixture', scripts: { build: 'node build.js' } }),
  'package-lock.json': '{"lockfileVersion":3}\n',
  // With a `kill-build` marker the build child dies on a signal, as a host out of memory ends it.
  'build.js': "const { existsSync } = require('node:fs'); console.log('ENV:' + JSON.stringify({ keys: Object.keys(process.env), global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM, home: process.env.HOME, tmpdir: require('node:os').tmpdir(), tmpEntries: require('node:fs').readdirSync(require('node:os').tmpdir()), tmpVariables: [process.env.TMPDIR, process.env.TMP, process.env.TEMP], cwd: process.cwd() })); require('node:fs').writeFileSync(require('node:path').join(require('node:os').tmpdir(), 'build-scratch'), 'x'); if (existsSync('poison-root')) require('node:fs').writeFileSync(require('node:path').join(require('node:path').dirname(require('node:os').tmpdir()), 'package.json'), '{}'); if (existsSync('stick-tmp')) { const stuck = require('node:path').join(require('node:os').tmpdir(), 'stuck'); require('node:fs').mkdirSync(stuck); require('node:fs').writeFileSync(require('node:path').join(stuck, 'f'), 'x'); require('node:fs').chmodSync(stuck, 0o500); } if (existsSync('break-build')) { console.error('build broke'); process.exit(1); } if (existsSync('kill-build')) { console.error('build killed'); process.kill(process.pid, 'SIGKILL'); }\n",
  // The stand-in for scripts/ci-tests.mjs: `affected` answers the changed test files, or a full selection (every pre-merge
  // file, never a soak) when package.json changed; with a `full-silent` marker it lists nothing for a full selection, as the
  // script did before GY-1522. `select` lists the pre-merge suite, as the real one does outside Actions.
  'scripts/ci-tests.mjs': "import { existsSync, readdirSync } from 'node:fs'; const [command, ...files] = process.argv.slice(2); const suite = () => readdirSync('tests').filter(name => name.endsWith('.test.ts') && !name.startsWith('soak')).sort().map(name => 'tests/' + name);\n"
    + "if (command === 'select') console.log(suite().join('\\n')); else if (files.includes('package.json')) { console.log('full: package.json changes the install'); if (!existsSync('full-silent')) console.log(suite().join('\\n')); } else { console.log('affected: selected'); for (const file of files) if (file.startsWith('tests/')) console.log(file); }\n",
  // The stand-in runner: it runs only the listed files and refuses to run without a list. It writes the real runner's
  // per-file records under --durations (a `bad` file fails), names the tree it ran in (`tree-marker`), and ends as a
  // runner that names no failing test does: with a `crash` file listed it prints every credential-shaped variable it sees and exits 3 after
  // every file passed, with a `killed` file listed a signal ends it. A `partial` file listed writes passing records for
  // every other file, prints a named failure for itself without a completion record, and exits 1 — as a runner that dies
  // mid-group after some files finished (GY-1548).
  'tests/helpers/run-tests.ts': "import { existsSync, readFileSync, writeFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { dirname, join } from 'node:path'; const at = process.argv.indexOf('--files-from'); if (at < 0) { console.error('no --files-from: the runner would run every test file'); process.exit(2); } const files = readFileSync(process.argv[at + 1], 'utf8').split('\\n').filter(Boolean);\n"
    + "console.log('group: ' + files.length + ' file(s)' + (existsSync('tree-marker') ? ' in ' + readFileSync('tree-marker', 'utf8').trim() : ''));\n"
    + "const durations = process.argv.indexOf('--durations');\n"
    + "if (files.some(file => file.includes('partial'))) { const done = files.filter(file => !file.includes('partial')); for (const file of done) console.log('ok - ' + file); const failed = files.find(file => file.includes('partial')); console.log('not ok - ' + failed); console.log('  test at ' + failed + ':1:1'); if (durations >= 0) writeFileSync(process.argv[durations + 1], done.map(file => JSON.stringify({ file, durationMs: 1, passed: true })).join('\\n') + (done.length ? '\\n' : '')); process.exit(1); }\n"
    + "let shadowed = null; for (let dir = tmpdir(); process.env.LOOKUP_ROOT && dir.startsWith(process.env.LOOKUP_ROOT); dir = dirname(dir)) if (existsSync(join(dir, 'node_modules'))) { shadowed = join(dir, 'node_modules'); break; }\n"
    + "const bad = file => file.includes('bad') || (file.includes('lookup') && shadowed !== null);\n"
    + "for (const file of files) console.log((bad(file) ? 'not ok - ' : 'ok - ') + file + (file.includes('lookup') && shadowed ? ' — the upward lookup found ' + shadowed : ''));\n"
    + "if (durations >= 0) writeFileSync(process.argv[durations + 1], files.map(file => JSON.stringify({ file, durationMs: 1, passed: !bad(file) })).join('\\n') + '\\n');\n"
    + "if (files.some(file => file.includes('crash'))) { console.error('the runner process is leaving without a verdict'); console.error('credentials seen: ' + JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name]) => /TOKEN|SECRET|SOCK|AUTH|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIAL/.test(name))))); process.exit(3); }\n"
    + "if (files.some(file => file.includes('killed'))) process.kill(process.pid, 'SIGKILL');\n"
    + "if (files.some(bad)) process.exit(1);\n",
};
const fixture = async () => {
  const repo = await repository(fixtureFiles);
  symlinkSync(installedModules, join(repo.root, 'node_modules'));
  gitIn(repo.root, 'config', 'user.name', 'x');
  return repo;
};
const trialOf = async (repo: Awaited<ReturnType<typeof fixture>>, head: string, changedFiles: string[], environment: NodeJS.ProcessEnv = { PATH: process.env.PATH! }, remove?: RunTrialInput['remove']) => {
  const merged = await trialMerge(gitFor(repo.root), { head, baseTip: repo.base });
  assert.ok('mergeSha' in merged);
  const base = await temporaryDirectory('trial-merge-root', tmpdir());
  const result = await runTrial({ root: repo.root, base, mergeSha: merged.mergeSha, changedFiles, timeoutMs: 120_000, key: 'GY-9', environment, remove });
  return { result, base };
};

test('integration:trial-run-build-and-tests — the merge commit is checked out detached as a trial checkout, npm run build then the affected tests run, the verdict reports build, passed and failed files and the duration, and the checkout is removed pass or fail', async () => {
  assert.ok((checkoutKinds as readonly string[]).includes('trial'));
  const repo = await fixture();
  const good = repo.commitOnBase({ 'src/a.ts': 'export {};\n', 'tests/a.test.ts': 'x\n' }, 'good head');
  const passing = await trialOf(repo, good, ['src/a.ts', 'tests/a.test.ts']);
  assert.equal(passing.result.build, 'pass', passing.result.logTail);
  assert.deepEqual(passing.result.tests, { passed: 1, failed: [], files: 1 }, passing.result.logTail);
  assert.ok(passing.result.durationMs >= 0 && passing.result.logTail.includes('ok - tests/a.test.ts'));
  assert.equal(existsSync(passing.base) ? readdirSync(passing.base).length : 0, 0, 'the trial checkout is removed after a pass');
  assert.equal(gitIn(repo.root, 'worktree', 'list').split('\n').length, 1, 'and its registration with it');

  const failing = repo.commitOnBase({ 'tests/bad.test.ts': 'x\n', 'tests/ok.test.ts': 'x\n' }, 'failing head');
  const failed = await trialOf(repo, failing, ['tests/bad.test.ts', 'tests/ok.test.ts']);
  assert.equal(failed.result.build, 'pass');
  assert.deepEqual(failed.result.tests, { passed: 1, failed: ['tests/bad.test.ts'], files: 2 }, failed.result.logTail);
  assert.equal(existsSync(failed.base) ? readdirSync(failed.base).length : 0, 0, 'and after a test failure');

  const broken = repo.commitOnBase({ 'break-build': '', 'tests/a.test.ts': 'x\n' }, 'breaks the build');
  const noBuild = await trialOf(repo, broken, ['tests/a.test.ts']);
  assert.equal(noBuild.result.build, 'fail');
  assert.deepEqual(noBuild.result.tests, { passed: 0, failed: [], files: 0 }, 'no test runs after a failed build');
  assert.match(noBuild.result.logTail, /build broke/);
  assert.equal(existsSync(noBuild.base) ? readdirSync(noBuild.base).length : 0, 0, 'and after a failed build');
});

test('integration:trial-run-build-and-tests — a full selection runs exactly the pre-merge files ci-tests lists, never the release-candidate suites, and the verdict counts the files that ran; a merge whose own ci-tests lists none for a full selection gets them from `select`', async () => {
  const repo = await fixture();
  const suite = { 'tests/a.test.ts': 'x\n', 'tests/bad.test.ts': 'x\n', 'tests/soak-day.test.ts': 'x\n' };
  const full = repo.commitOnBase({ ...suite, 'package.json': JSON.stringify({ name: 'fixture', version: '2', scripts: { build: 'node build.js' } }) }, 'install change');
  const listed = await trialOf(repo, full, ['package.json', 'tests/a.test.ts']);
  assert.equal(listed.result.build, 'pass', listed.result.logTail);
  assert.deepEqual(listed.result.tests, { passed: 1, failed: ['tests/bad.test.ts'], files: 2 }, listed.result.logTail);
  assert.match(listed.result.logTail, /--files-from/, 'the runner always gets the list');
  assert.ok(!listed.result.logTail.includes('ok - tests/soak-day.test.ts'), `the soak never runs in a trial:\n${listed.result.logTail}`);
  assert.equal(existsSync(listed.base) ? readdirSync(listed.base).length : 0, 0);
  const silent = repo.commitOnBase({ ...suite, 'full-silent': '', 'package.json': JSON.stringify({ name: 'fixture', version: '3', scripts: { build: 'node build.js' } }) }, 'older ci-tests');
  const selected = await trialOf(repo, silent, ['package.json']);
  assert.deepEqual(selected.result.tests, { passed: 1, failed: ['tests/bad.test.ts'], files: 2 }, selected.result.logTail);
  assert.match(selected.result.logTail, /ci-tests\.mjs select/, 'the pre-merge suite comes from `select` when `affected` names no file');
});

test('integration:trial-run-build-and-tests — a trial checkout that cannot be removed is reported: runTrial rejects with TrialCleanupError naming the directory and carrying the verdict it reached, or the failure it met', async () => {
  const repo = await fixture();
  const head = repo.commitOnBase({ 'tests/a.test.ts': 'x\n' }, 'head');
  const stuck: RunTrialInput['remove'] = async () => { throw new Error('EBUSY: the checkout is in use'); };
  await assert.rejects(trialOf(repo, head, ['tests/a.test.ts'], { PATH: process.env.PATH! }, stuck), (error: unknown) =>
    error instanceof TrialCleanupError && /graphyard-trial-gy-9-/.test(error.directory) && /EBUSY/.test(error.message) && /answered build pass, 0 failing/.test(error.message)
    && error.verdict?.build === 'pass' && error.verdict.tests.files === 1);
  const broken = repo.commitOnBase({ 'break-build': '' }, 'breaks the build');
  await assert.rejects(trialOf(repo, broken, [], { PATH: process.env.PATH! }, stuck), (error: unknown) => error instanceof TrialCleanupError && error.verdict?.build === 'fail');
  const run = ((command: string, args: string[], options: unknown) => {
    if (command === 'npm' && args[0] === 'run') throw Object.assign(new Error('killed'), { timedOut: true, stdout: '', stderr: '' });
    return defaultChildRun(command, args, options as never);
  }) as never;
  const merged = await trialMerge(gitFor(repo.root), { head, baseTip: repo.base });
  assert.ok('mergeSha' in merged);
  await assert.rejects(runTrial({ root: repo.root, base: await temporaryDirectory('trial-merge-root', tmpdir()), mergeSha: merged.mergeSha, changedFiles: [], timeoutMs: 120_000, key: 'GY-9', environment: { PATH: process.env.PATH! }, run, remove: stuck }),
    (error: unknown) => error instanceof TrialCleanupError && error.verdict === null && /the trial itself failed: The trial timed out during its build/.test(error.message));
});

/** This repository's own trial: HEAD's tree with tests/ reduced to two fast, Postgres-free files, committed in a shared scratch clone that borrows this checkout's install. */
async function ownRepositoryTrial(keep: readonly string[]) {
  const own = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const scratch = await temporaryDirectory('trial-merge-own', tmpdir());
  const root = join(scratch, 'repo');
  execFileSync('git', ['clone', '-q', '--shared', '--no-checkout', own, root], { stdio: 'ignore' });
  const head = gitIn(root, 'rev-parse', 'HEAD');
  const indexed = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, ...identity, GIT_INDEX_FILE: join(scratch, 'index') } }).trim();
  indexed('read-tree', head);
  const dropped = gitIn(root, 'ls-tree', '--name-only', head, 'tests/').split('\n').filter(path => path.endsWith('.test.ts') && !keep.includes(path));
  execFileSync('git', ['-C', root, 'update-index', '--force-remove', '--stdin'], { input: `${dropped.join('\n')}\n`, env: { ...process.env, ...identity, GIT_INDEX_FILE: join(scratch, 'index') } });
  const mergeSha = gitIn(root, 'commit-tree', indexed('write-tree'), '-p', head, '-m', `Trial of ${keep.join(' and ')}`);
  // The scratch root is the coordinator checkout: its lockfile is the merge's, so the trial borrows its install.
  copyFileSync(join(own, 'package-lock.json'), join(root, 'package-lock.json'));
  symlinkSync(installedModules, join(root, 'node_modules'));
  return { root, base: join(scratch, 'root'), mergeSha, dropped: dropped.length };
}

test('unit:trial-credential-free-runner-exits-zero — this repository\'s own two-file fast selection, built and run by the real runner in a credential-free scratch checkout through runTrial\'s environment (GH_CONFIG_DIR, GH_TOKEN, GITHUB_TOKEN, SSH_AUTH_SOCK, GIT_SSH_COMMAND and every GRAPHYARD_*/HERDR_* variable removed, GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null), records no failed file and a runner exit code of 0 (GY-1549)', async () => {
  const keep = ['tests/readme.test.ts', 'tests/stable-json.test.ts'];
  const trial = await ownRepositoryTrial(keep);
  assert.ok(trial.dropped > 100, `the scratch tree keeps only the two files (${trial.dropped} dropped)`);
  const planted: NodeJS.ProcessEnv = { ...process.env, GH_CONFIG_DIR: '/nowhere/gh', GH_TOKEN: 'gh-secret', GITHUB_TOKEN: 'github-secret', SSH_AUTH_SOCK: '/nowhere/agent.sock', GIT_SSH_COMMAND: 'ssh -i /nowhere/key', GRAPHYARD_TOKEN: 'graphyard-secret', HERDR_PANE_ID: 'p1', GIT_CONFIG_GLOBAL: '/nowhere/.gitconfig' };
  const environment = trialEnvironment(planted);
  for (const name of [...withheldTrialVariables, 'GRAPHYARD_TOKEN', 'GRAPHYARD_TEST_PORT', 'HERDR_PANE_ID']) assert.ok(!(name in environment), `${name} is withheld from the trial`);
  assert.deepEqual([environment.GIT_CONFIG_NOSYSTEM, environment.GIT_CONFIG_GLOBAL], ['1', '/dev/null']);
  // The runner changed, so the selection is the full pre-merge suite of the scratch tree: exactly the two files.
  const result = await runTrial({ root: trial.root, base: trial.base, mergeSha: trial.mergeSha, changedFiles: ['tests/helpers/run-tests.ts'], timeoutMs: 10 * 60_000, key: 'GY-1549', environment: planted });
  assert.equal(result.build, 'pass', result.logTail);
  assert.deepEqual(result.tests, { passed: 2, failed: [], files: 2 }, result.logTail);
  assert.equal(result.runnerExit, 0, result.logTail);
  assert.match(result.logTail, /run-tests\.ts --files-from/, 'the real runner ran the listed files');
  assert.equal(existsSync(trial.base) ? readdirSync(trial.base).length : 0, 0, 'the trial checkout is removed');
});

test('unit:trial-run-credential-free — the trial child sees none of GH_CONFIG_DIR, GH_TOKEN, GITHUB_TOKEN, SSH_AUTH_SOCK, GIT_SSH_COMMAND, the host\'s TMPDIR, AWS_SECRET_ACCESS_KEY, NPM_TOKEN or any GRAPHYARD_*/HERDR_* variable, and git\'s global configuration is off', async () => {
  const planted: NodeJS.ProcessEnv = { PATH: process.env.PATH!, HOME: '/home/me', GH_CONFIG_DIR: '/home/me/.config/gh', GH_TOKEN: 'gh-secret', GITHUB_TOKEN: 'github-secret', SSH_AUTH_SOCK: '/run/agent.sock', GIT_SSH_COMMAND: 'ssh -i key',
    XDG_RUNTIME_DIR: '/run/user/1000', TMPDIR: '/var/tmp', TMP: '/var/tmp', TEMP: '/var/tmp', AWS_SECRET_ACCESS_KEY: 'aws-secret-key', NPM_TOKEN: 'npm-secret-token',
    GRAPHYARD_TOKEN: 'graphyard-secret', GRAPHYARD_URL: 'https://example.test', GRAPHYARD_TIMING_RECORD: '/tmp/record', HERDR_PANE_ID: 'p1', HERDR_SOCKET_PATH: '/run/herdr.sock', GIT_CONFIG_GLOBAL: '/home/me/.gitconfig', KEPT: 'yes' };
  const withheld = [...withheldTrialVariables, 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN', 'GRAPHYARD_TOKEN', 'GRAPHYARD_URL', 'GRAPHYARD_TIMING_RECORD', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH'];
  const environment = trialEnvironment(planted);
  for (const name of withheld) assert.ok(!(name in environment), `${name} is withheld`);
  assert.ok(credentialTrialVariable('AWS_SECRET_ACCESS_KEY') && credentialTrialVariable('NPM_TOKEN') && credentialTrialVariable('GH_TOKEN'));
  assert.ok(!credentialTrialVariable('PATH') && !credentialTrialVariable('KEPT') && !credentialTrialVariable('HOME'));
  assert.deepEqual([environment.KEPT, environment.XDG_RUNTIME_DIR, environment.HOME], ['yes', '/run/user/1000', '/home/me'], 'everything else, the home among it, stays');
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(environment.GIT_CONFIG_GLOBAL, '/dev/null');
  // And the child that runs the build sees exactly that, under the platform's temporary directory.
  const repo = await fixture();
  const head = repo.commitOnBase({ 'src/a.ts': 'export {};\n' }, 'head');
  const { result } = await trialOf(repo, head, ['src/a.ts'], planted);
  const seen = JSON.parse(/ENV:(.*)/.exec(result.logTail)![1]!) as { keys: string[]; global: string; nosystem: string; home: string; tmpdir: string };
  // TMPDIR, TMP and TEMP reach the child only as the trial's own directory (GY-1565), never the host's value.
  for (const name of withheld.filter(name => !['TMPDIR', 'TMP', 'TEMP'].includes(name))) assert.ok(!seen.keys.includes(name), `the child saw ${name}`);
  assert.ok(seen.keys.includes('KEPT'));
  assert.deepEqual([seen.global, seen.nosystem], ['/dev/null', '1']);
  assert.equal(seen.home, '/home/me', 'the home stays');
  assert.notEqual(seen.tmpdir, '/var/tmp', 'the host\'s TMPDIR is withheld (GY-1549); the trial\'s own replaces it (GY-1565)');
});

test('unit:trial-tmpdir-isolated — the trial child gets a fresh, empty, short temporary directory made for the trial in the first of /tmp and the coordinator\'s tmpdir that no stray node_modules, .git or package.json sits in or above, the filesystem root included (else its session directory), never the host\'s TMPDIR, so a fixture\'s upward lookup cannot resolve one; a root that gains one during the trial makes it no verdict; its checkout goes beside it only on durable storage with room; the directories are removed with the checkout, pass or fail, a removal that fails names its directory and drops its owner marker, and one a crashed trial left behind is taken back by the bounded tmp reclaim (GY-1565)', async () => {
  assert.deepEqual(trialTemporaryRoots('/var/tmp'), ['/tmp', '/var/tmp'], 'the roots the loop\'s tmp reclaim scans');
  assert.deepEqual(trialTemporaryRoots('/tmp'), ['/tmp']);
  assert.deepEqual([...trialLookupEntries], ['node_modules', '.git', 'package.json']);
  assert.deepEqual(trialTemporaryVariables('/var/tmp/gy-tx'), { TMPDIR: '/var/tmp/gy-tx', TMP: '/var/tmp/gy-tx', TEMP: '/var/tmp/gy-tx' });
  assert.ok(testTempPatterns.some(pattern => pattern.test(`${trialTemporaryPrefix}x`)) && testTempPatterns.some(pattern => pattern.test(`${trialCheckoutPrefix}x`)), 'the trial\'s directories carry names the tmp reclaim takes');
  // The filesystem root is inspected too: a container\'s /node_modules poisons /tmp and /var/tmp alike.
  for (const entry of trialLookupEntries) assert.equal(lookupPoisoned('/var/tmp', path => path === `/${entry}`), true, `a /${entry} poisons every candidate`);
  assert.equal(lookupPoisoned('/var/tmp', () => false), false);
  // The host's shared tmp, poisoned as vishrog's /tmp was: a dependency cache with no lockfile and an empty .git.
  const shared = await temporaryDirectory('trial-shared-tmp', tmpdir());
  mkdirSync(join(shared, 'node_modules', '.vite'), { recursive: true }); mkdirSync(join(shared, '.git'));
  const clean = await temporaryDirectory('trial-clean-tmp', tmpdir());
  for (const entry of trialLookupEntries) {
    const poisoned = await temporaryDirectory(`trial-poisoned-${entry.replace('.', '')}`, tmpdir());
    if (entry === 'package.json') writeFileSync(join(poisoned, entry), '{}\n'); else mkdirSync(join(poisoned, entry));
    mkdirSync(join(poisoned, 'a', 'b'), { recursive: true });
    assert.equal(lookupPoisoned(join(poisoned, 'a', 'b')), true, `a ${entry} above the directory poisons it`);
  }
  assert.equal(trialTemporaryRoot('/session', [join(clean, 'missing'), shared]), '/session', 'no clean root: the session directory');
  // The clean candidate is clean unless the host's own tmp above it is poisoned, as vishrog's is: then the session directory.
  const usable = !lookupPoisoned(clean);
  assert.equal(trialTemporaryRoot('/session', [shared, clean]), usable ? clean : '/session');
  // The checkout goes only where the managed worktree root\'s guard would let it: never a tmpfs, never a volume short of room.
  const durable: FilesystemProbe = async path => ({ probed: path, volatile: null, freeBytes: null });
  const memory: FilesystemProbe = async path => ({ probed: path, volatile: path === clean ? 'tmpfs' : null, freeBytes: null });
  const full: FilesystemProbe = async path => ({ probed: path, volatile: null, freeBytes: path === clean ? 1e6 : 1e12 });
  const tmpfs: FilesystemProbe = async path => ({ probed: path, volatile: 'tmpfs', freeBytes: null });
  assert.equal(await trialCheckoutRoot([clean, shared], 2e9, durable), clean);
  assert.equal(await trialCheckoutRoot([clean, shared], 2e9, memory), shared, 'a tmpfs is passed over');
  assert.equal(await trialCheckoutRoot([clean, shared], 2e9, full), shared, 'so is a volume below the minimum free');
  assert.equal(await trialCheckoutRoot([clean], 2e9, memory), null, 'none: the checkout stays in the managed session directory');
  const host: NodeJS.ProcessEnv = { PATH: process.env.PATH!, TMPDIR: shared, TMP: shared, TEMP: shared };
  const repo = await fixture();
  const seen = (logTail: string) => JSON.parse(/ENV:(.*)/.exec(logTail)![1]!) as { tmpdir: string; tmpEntries: string[]; tmpVariables: string[]; cwd: string };
  const trial = async (files: Record<string, string>, changed: string[], label: string, options: Partial<RunTrialInput> = {}) => {
    const head = repo.commitOnBase(files, label);
    const merged = await trialMerge(gitFor(repo.root), { head, baseTip: repo.base });
    assert.ok('mergeSha' in merged);
    const base = await temporaryDirectory('trial-merge-root', tmpdir());
    return { base, run: () => runTrial({ root: repo.root, base, mergeSha: merged.mergeSha, changedFiles: changed, timeoutMs: 120_000, key: 'GY-9', environment: host, temporaryRoots: [shared, clean], probe: durable, ...options }) };
  };
  const directories: string[] = [];
  for (const [files, changed, outcome, probe] of [
    [{ 'tests/a.test.ts': 'x\n' }, ['tests/a.test.ts'], 'pass', durable],
    [{ 'tests/bad.test.ts': 'x\n' }, ['tests/bad.test.ts'], 'test failure', durable],
    [{ 'break-build': '', 'tests/a.test.ts': 'x\n' }, ['tests/a.test.ts'], 'failed build', durable],
    [{ 'tests/a.test.ts': 'x\n', 'memory.txt': '\n' }, ['tests/a.test.ts'], 'pass with a memory-backed tmp', tmpfs],
  ] as const) {
    const { base, run } = await trial(files, [...changed], outcome, { probe });
    const result = await run();
    const child = seen(result.logTail);
    assert.ok(!child.tmpdir.startsWith(`${shared}/`), `the ${outcome} trial never runs in the poisoned tmp`);
    assert.ok(child.tmpdir.startsWith(usable ? `${clean}/${trialTemporaryPrefix}` : `${base}/`), `its tmpdir is made for it in the clean root: ${child.tmpdir}`);
    assert.deepEqual(child.tmpVariables, [child.tmpdir, child.tmpdir, child.tmpdir], 'TMPDIR, TMP and TEMP all name it');
    // Its checkout is short beside it on durable storage, as CI's is, so no launch line the suite types outgrows its bound; else the session's own.
    const near = probe === durable ? `${shared}/${trialCheckoutPrefix}` : `${base}/`;
    assert.ok(child.cwd.startsWith(near) && child.cwd.endsWith('/checkout'), `its checkout is made in ${near}: ${child.cwd}`);
    // npm, which runs the build, keeps node's compile cache in the tmpdir it is given; nothing else is there.
    assert.deepEqual(child.tmpEntries.filter(entry => entry !== 'node-compile-cache'), [], 'it is empty when the suite starts: no node_modules, no .git');
    assert.equal(existsSync(child.tmpdir), false, `it is removed with the checkout after a ${outcome}`);
    assert.equal(existsSync(tempOwnerMarker(child.tmpdir)), false, `its owner marker goes with it after a ${outcome}`);
    assert.equal(existsSync(child.cwd), false, `the checkout goes with it after a ${outcome}`);
    assert.equal(existsSync(base) ? readdirSync(base).length : 0, 0);
    directories.push(child.tmpdir);
  }
  assert.equal(new Set(directories).size, directories.length, 'every trial gets a fresh directory');
  assert.deepEqual(readdirSync(shared).sort(), ['.git', 'node_modules'], 'the host\'s tmp is left as it was');
  assert.deepEqual(readdirSync(clean), [], 'and nothing of the trials is left in the clean root');
  if (usable) {
    // A root that gains a package.json while the trial runs may have shadowed its lookups: no verdict, every directory removed.
    const poisoning = await trial({ 'tests/a.test.ts': 'x\n', 'poison-root': '' }, ['tests/a.test.ts'], 'poisons its root');
    await assert.rejects(poisoning.run(), (error: unknown) => error instanceof TrialEnvironmentError && error.root === clean && /gained a node_modules, \.git or package\.json/.test(error.message));
    assert.deepEqual(readdirSync(clean), ['package.json'], 'its directories are removed all the same');
    rmSync(join(clean, 'package.json'));
  }
  if (usable && process.getuid?.() !== 0) {
    // A temporary directory that will not go is named, and loses its owner marker, so the tmp reclaim takes it once it ages.
    const sticking = await trial({ 'tests/a.test.ts': 'x\n', 'stick-tmp': '' }, ['tests/a.test.ts'], 'sticks in its tmp');
    let left = '';
    await assert.rejects(sticking.run(), (error: unknown) => {
      left = error instanceof TrialCleanupError ? error.directory : '';
      return error instanceof TrialCleanupError && error.verdict?.build === 'pass' && left.startsWith(`${clean}/${trialTemporaryPrefix}`) && error.message.includes(left);
    });
    assert.equal(existsSync(left), true);
    assert.equal(existsSync(tempOwnerMarker(left)), false, 'no live owner marker keeps it');
    chmodSync(join(left, 'stuck'), 0o700); rmSync(left, { recursive: true });
    assert.equal(existsSync(sticking.base) ? readdirSync(sticking.base).length : 0, 0, 'the session directory still goes');
  }
  // A merge writer that crashed mid-trial never ran the cleanup: its directories, marked with an owner that is gone, are
  // taken by the loop's bounded tmp reclaim in the root it scans; a running trial's, marked by this live process, is kept.
  const crashed = join(clean, `${trialTemporaryPrefix}crashed`), running = join(clean, `${trialTemporaryPrefix}running`), crashedCheckout = join(clean, `${trialCheckoutPrefix}crashed`);
  mkdirSync(join(crashedCheckout, 'checkout', 'tests'), { recursive: true });
  for (const directory of [crashed, running]) mkdirSync(join(directory, 'graphyard-pg-data'), { recursive: true });
  for (const directory of [crashed, crashedCheckout]) writeFileSync(tempOwnerMarker(directory), `${JSON.stringify({ pid: process.pid, startedAt: -1, at: new Date().toISOString() })}\n`);
  await writeTempOwner(running);
  const report = await reclaimTmpDirectories({ tmpRoots: [clean], held: new Set() });
  assert.deepEqual(report.removed.map(entry => entry.path).sort(), [crashedCheckout, crashed].sort(), JSON.stringify(report));
  assert.deepEqual(readdirSync(clean).sort(), [`${trialTemporaryPrefix}running`, `${trialTemporaryPrefix}running.owner`], 'the running trial\'s directory stays');
});

test('integration:shadow-trial-stable-green — three consecutive trials of one head, on a host whose shared tmp holds a stray node_modules, pass every time: a test whose upward lookup from its tmpdir would resolve that node_modules (as tests/worktree-reclaim.test.ts did on vishrog) runs under the trial\'s own tmpdir and never sees it, while the shared tmp stays dirty (GY-1565)', async () => {
  // The host: its shared tmp poisoned as vishrog's /tmp is, a persistent tmp beside it, and the managed worktree root.
  const host = await temporaryDirectory('trial-stable-host', tmpdir());
  const shared = join(host, 'tmp'), persistent = join(host, 'var-tmp');
  mkdirSync(join(shared, 'node_modules', '.vite'), { recursive: true }); mkdirSync(join(shared, '.git')); mkdirSync(persistent);
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH!, TMPDIR: shared, TMP: shared, TEMP: shared, LOOKUP_ROOT: host };
  const repo = await fixture();
  const head = repo.commitOnBase({ 'src/a.ts': 'export {};\n', 'tests/lookup.test.ts': 'x\n', 'tests/ok.test.ts': 'x\n' }, 'one submitted head');
  const merged = await trialMerge(gitFor(repo.root), { head, baseTip: repo.base });
  assert.ok('mergeSha' in merged);
  // The stand-in lookup does detect the contamination: run as the trial ran before GY-1565, with the host's shared tmp as
  // the platform's own, it fails as the GY-1535 trials did.
  const list = join(host, 'lookup.txt'); writeFileSync(list, 'tests/lookup.test.ts\n');
  assert.throws(() => execFileSync('node', ['tests/helpers/run-tests.ts', '--files-from', list], { cwd: repo.root, env: { ...trialEnvironment(environment), TMPDIR: shared }, encoding: 'utf8', stdio: 'pipe' }),
    (error: { stdout?: string }) => /not ok - tests\/lookup\.test\.ts — the upward lookup found .*\/tmp\/node_modules/.test(String(error.stdout)), 'under the shared tmp the lookup resolves the stray node_modules');
  for (const attempt of [1, 2, 3]) {
    const base = join(host, `worktrees-${attempt}`);
    const result = await runTrial({ root: repo.root, base, mergeSha: merged.mergeSha, changedFiles: ['tests/lookup.test.ts', 'tests/ok.test.ts'], timeoutMs: 120_000, key: 'GY-1535', environment, temporaryRoots: [shared, persistent] });
    assert.equal(result.build, 'pass', result.logTail);
    assert.deepEqual(result.tests, { passed: 2, failed: [], files: 2 }, `trial ${attempt} has no shadow-only-fail from the contamination: ${result.logTail}`);
    assert.equal(result.runnerExit, 0);
    assert.doesNotMatch(result.logTail, /the upward lookup found/);
  }
  assert.deepEqual(readdirSync(shared).sort(), ['.git', 'node_modules'], 'the shared tmp stays dirty throughout');
});

test('integration:trial-run-build-and-tests — a merge that changes the lockfile installs its own dependencies with npm ci, and one that leaves it alone reuses the coordinator\'s install', async () => {
  const repo = await fixture();
  const same = repo.commitOnBase({ 'src/a.ts': 'export {};\n' }, 'no dependency change');
  const changed = repo.commitOnBase({ 'package-lock.json': '{"lockfileVersion":3,"packages":{"x":{}}}\n' }, 'new lockfile');
  const commands: string[] = [];
  const run = ((command: string, args: string[], options: { cwd?: string }) => {
    commands.push(`${command} ${args[0]}`);
    if (command === 'npm' && args[0] === 'ci') { assert.ok(!existsSync(join(options.cwd!, 'node_modules')), 'npm ci installs into a checkout holding no borrowed install'); return 'installed'; }
    return defaultChildRun(command, args, options as never);
  }) as never;
  for (const head of [same, changed]) {
    const merged = await trialMerge(gitFor(repo.root), { head, baseTip: repo.base });
    assert.ok('mergeSha' in merged);
    const base = await temporaryDirectory('trial-merge-root', tmpdir());
    const result = await runTrial({ root: repo.root, base, mergeSha: merged.mergeSha, changedFiles: [], timeoutMs: 120_000, key: 'GY-9', environment: { PATH: process.env.PATH! }, run });
    assert.equal(result.build, 'pass', result.logTail);
  }
  assert.equal(commands.filter(command => command === 'npm ci').length, 1, 'only the changed lockfile installs');
});

test('integration:trial-run-build-and-tests — a trial that outruns its time budget is no verdict: runTrial rejects with TrialTimeoutError naming the phase, and the checkout is still removed', async () => {
  const repo = await fixture();
  const head = repo.commitOnBase({ 'src/a.ts': 'export {};\n' }, 'slow head');
  const merged = await trialMerge(gitFor(repo.root), { head, baseTip: repo.base });
  assert.ok('mergeSha' in merged);
  const base = await temporaryDirectory('trial-merge-root', tmpdir());
  // The build child is killed at the deadline, as the child runner reports it.
  const run = ((command: string, args: string[], options: unknown) => {
    if (command === 'npm' && args[0] === 'run') throw Object.assign(new Error('npm run build did not finish within 1000ms and was killed'), { timedOut: true, stdout: 'building…', stderr: '' });
    return defaultChildRun(command, args, options as never);
  }) as never;
  await assert.rejects(runTrial({ root: repo.root, base, mergeSha: merged.mergeSha, changedFiles: ['src/a.ts'], timeoutMs: 120_000, key: 'GY-9', environment: { PATH: process.env.PATH! }, run }),
    (error: unknown) => error instanceof TrialTimeoutError && error.phase === 'build' && /timed out during its build/.test(error.message) && error.logTail.includes('building…'));
  assert.equal(existsSync(base) ? readdirSync(base).length : 0, 0, 'the trial checkout is removed after a timeout');
  assert.equal(gitIn(repo.root, 'worktree', 'list').split('\n').length, 1);
  // A deadline that passed while a child ran to completion ends the trial the same way.
  let clock = 0;
  const slow = ((command: string, args: string[], options: unknown) => { if (command === 'npm' && args[0] === 'run') clock += 200_000; return defaultChildRun(command, args, options as never); }) as never;
  await assert.rejects(runTrial({ root: repo.root, base, mergeSha: merged.mergeSha, changedFiles: ['src/a.ts'], timeoutMs: 120_000, key: 'GY-9', environment: { PATH: process.env.PATH! }, run: slow, now: () => clock }),
    (error: unknown) => error instanceof TrialTimeoutError && error.phase === 'build' && error.durationMs === 200_000);
  assert.equal(existsSync(base) ? readdirSync(base).length : 0, 0);
});

// ——— GY-1548: a runner exit that names no failing test is a runner failure, never a failing verdict; the selection runs in bounded groups. ———
const mergeOf = async (repo: Awaited<ReturnType<typeof fixture>>, head: string) => { const merged = await trialMerge(gitFor(repo.root), { head, baseTip: repo.base }); assert.ok('mergeSha' in merged); return merged.mergeSha; };
const planted: NodeJS.ProcessEnv = { PATH: process.env.PATH!, GH_TOKEN: 'gh-secret-token', GITHUB_TOKEN: 'github-secret-token', GRAPHYARD_TOKEN: 'graphyard-secret-token', SSH_AUTH_SOCK: '/nowhere/agent.sock', AWS_SECRET_ACCESS_KEY: 'aws-secret-access-key', NPM_TOKEN: 'npm-registry-token' };
const secrets = ['gh-secret-token', 'github-secret-token', 'graphyard-secret-token', '/nowhere/agent.sock', 'aws-secret-access-key', 'npm-registry-token'];

test('integration:shadow-trial-failure-diagnostics — a runner that exits non-zero naming a failing file is a failing verdict with the exit, the group and the files; one that exits non-zero or on a signal naming none (every record passed) rejects with TrialRunnerError carrying the phase, status or signal, the group\'s files and how many finished, a bounded credential-free output tail and the trial merge sha, as does a build a signal ended; a partial-record run that prints a named failure is still a failing verdict; and the loop records a runner exit against head, base tip and merge sha, retried twice then given up under one attention line, never as a verdict', async () => {
  const repo = await fixture();
  // A named failing test file: the merge's, so a failing verdict, with how the runner ended beside it.
  const named = repo.commitOnBase({ 'tests/bad.test.ts': 'x\n', 'tests/ok.test.ts': 'x\n' }, 'named failure');
  const verdict = await runTrial({ root: repo.root, base: await temporaryDirectory('trial-merge-root', tmpdir()), mergeSha: await mergeOf(repo, named), changedFiles: ['tests/bad.test.ts', 'tests/ok.test.ts'], timeoutMs: 120_000, key: 'GY-9', environment: planted });
  assert.deepEqual([verdict.build, verdict.tests, verdict.runnerExit], ['pass', { passed: 1, failed: ['tests/bad.test.ts'], files: 2 }, 1], verdict.logTail);
  assert.deepEqual(verdict.groups, [{ files: ['tests/bad.test.ts', 'tests/ok.test.ts'], status: 1, signal: null, failed: ['tests/bad.test.ts'] }], 'the group record names the failing file and the exit status');
  assert.ok(trialNeedsLog(verdict));
  // A partial-record run: one file finished (passing record), another printed a named failure without a completion record — still the merge's failing verdict, never a runner retry.
  const partial = repo.commitOnBase({ 'tests/ok.test.ts': 'x\n', 'tests/partial.test.ts': 'x\n' }, 'partial records');
  const partialVerdict = await runTrial({ root: repo.root, base: await temporaryDirectory('trial-merge-root', tmpdir()), mergeSha: await mergeOf(repo, partial), changedFiles: ['tests/ok.test.ts', 'tests/partial.test.ts'], timeoutMs: 120_000, key: 'GY-9', environment: planted });
  assert.deepEqual([partialVerdict.build, partialVerdict.tests, partialVerdict.runnerExit], ['pass', { passed: 1, failed: ['tests/partial.test.ts'], files: 2 }, 1], partialVerdict.logTail);
  assert.deepEqual(partialVerdict.groups, [{ files: ['tests/ok.test.ts', 'tests/partial.test.ts'], status: 1, signal: null, failed: ['tests/partial.test.ts'] }], 'the log names the failing file when records do not');
  // A runner that exits 3 after every file passed, records and all: no test is named, so no verdict; the record says how it ended and holds no credential.
  const crashed = repo.commitOnBase({ 'tests/crash.test.ts': 'x\n', 'tests/ok.test.ts': 'x\n' }, 'runner exit');
  const crashedMerge = await mergeOf(repo, crashed), crashedBase = await temporaryDirectory('trial-merge-root', tmpdir());
  await assert.rejects(runTrial({ root: repo.root, base: crashedBase, mergeSha: crashedMerge, changedFiles: ['tests/crash.test.ts', 'tests/ok.test.ts'], timeoutMs: 120_000, key: 'GY-9', environment: planted }), (error: unknown) => {
    assert.ok(error instanceof TrialRunnerError, String(error));
    assert.deepEqual([error.phase, error.status, error.signal, error.files, error.finished, error.mergeSha], ['tests', 3, null, ['tests/crash.test.ts', 'tests/ok.test.ts'], 2, crashedMerge]);
    assert.match(error.message, /tests runner exited \(status 3\) naming no failing test; 2 of its 2 file\(s\) finished/);
    assert.ok(error.outputTail.length <= runnerDiagnosticTailLength && error.outputTail.includes('the runner process is leaving without a verdict') && error.outputTail.includes('[exit status 3]'), error.outputTail);
    assert.ok(error.outputTail.includes('credentials seen: {'), 'the child printed every credential-shaped variable it saw into the tail');
    for (const secret of secrets) assert.ok(!error.outputTail.includes(secret) && !error.message.includes(secret), `the record carries ${secret}`);
    assert.ok(error.durationMs >= 0);
    return true;
  });
  assert.equal(existsSync(crashedBase) ? readdirSync(crashedBase).length : 0, 0, 'the trial checkout is removed after a runner failure');
  // A signal that ends the runner, as the output cap or the OOM killer does, is the same: the signal is recorded, not a status.
  const killed = repo.commitOnBase({ 'tests/killed.test.ts': 'x\n' }, 'runner killed');
  await assert.rejects(runTrial({ root: repo.root, base: await temporaryDirectory('trial-merge-root', tmpdir()), mergeSha: await mergeOf(repo, killed), changedFiles: ['tests/killed.test.ts'], timeoutMs: 120_000, key: 'GY-9', environment: planted }),
    (error: unknown) => error instanceof TrialRunnerError && error.phase === 'tests' && error.status === null && error.signal === 'SIGKILL' && error.outputTail.includes('[exit signal SIGKILL]') && error.files.length === 1);
  // A build child a signal ended measures the host too; npm often reports that as status 137 with no signal field — still a runner failure. One that exits non-zero without a signal is still the merge's failed build.
  const buildKilled = repo.commitOnBase({ 'kill-build': '', 'tests/ok.test.ts': 'x\n' }, 'build killed');
  await assert.rejects(runTrial({ root: repo.root, base: await temporaryDirectory('trial-merge-root', tmpdir()), mergeSha: await mergeOf(repo, buildKilled), changedFiles: ['tests/ok.test.ts'], timeoutMs: 120_000, key: 'GY-9', environment: planted }),
    (error: unknown) => error instanceof TrialRunnerError && error.phase === 'build' && error.signal === 'SIGKILL' && error.files.length === 0 && error.outputTail.includes('build killed'));
  const npmReportsKill = ((command: string, args: string[], options: unknown) => {
    if (command === 'npm' && args[0] === 'run') throw Object.assign(new Error('Command failed: npm run build'), { status: 137, signal: null, stdout: '', stderr: 'build killed\n' });
    return defaultChildRun(command, args, options as never);
  }) as never;
  await assert.rejects(runTrial({ root: repo.root, base: await temporaryDirectory('trial-merge-root', tmpdir()), mergeSha: await mergeOf(repo, buildKilled), changedFiles: ['tests/ok.test.ts'], timeoutMs: 120_000, key: 'GY-9', environment: planted, run: npmReportsKill }),
    (error: unknown) => error instanceof TrialRunnerError && error.phase === 'build' && error.signal === 'SIGKILL' && error.status === null && error.outputTail.includes('build killed'));
  const buildBroken = repo.commitOnBase({ 'break-build': '', 'tests/ok.test.ts': 'x\n' }, 'build broken');
  assert.equal((await runTrial({ root: repo.root, base: await temporaryDirectory('trial-merge-root', tmpdir()), mergeSha: await mergeOf(repo, buildBroken), changedFiles: ['tests/ok.test.ts'], timeoutMs: 120_000, key: 'GY-9', environment: planted })).build, 'fail');

  // The loop's record of the runner exit, through the shadow step over this repository: against head, base tip and trial merge sha, with the exit and the tail.
  const run = ((command: string, args: string[], options: unknown) => command === 'git' && args[2] === 'fetch' ? '' : defaultChildRun(command, args, options as never)) as never;
  const reads = shadowReads(config, repo.root, run, { base: await temporaryDirectory('trial-merge-root', tmpdir()), record: async () => { assert.fail('a runner failure records no verdict'); } });
  const work = [{ id: 'w1', key: 'GY-1548', description: '', type: 'bug', priority: 1, dependencies: [], criteria: [], policy: { checks: ['test'], review: true }, plannedFiles: [], revision: 1, policyRevision: 1,
    createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(start), ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: 1 }, candidate: { sha: crashed, baseSha: repo.base, pr: 1, branch: 'graphyard/gy-1548-1', author: 'w' },
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], gates: [], stage: 'build' }] as unknown as Work[];
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), snapshot: async () => ({ work, now: iso(start) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(start), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, decisions: async () => ({ decisions: [] }), persist: async () => {}, github: {}, merge: {}, shadow: reads } as unknown as DaemonEffects;
  const state = emptyDaemonState(config), now = () => start;
  const attention: string[] = [];
  for (let cycle = 0; cycle < 5; cycle++) { attention.push(...(await runCycle(config, state, effects, now)).actions.filter(action => action.detail.startsWith('Shadow merge gate runner failure:')).map(action => action.detail)); await shadowIdle(state); }
  const record = state.actions[shadowRunnerKey(crashed, repo.base)];
  assert.ok(record, 'the diagnostic record is keyed by head and base tip');
  // The loop made its own trial merge of the head (the trial ref holds the newest); the record names that commit.
  const loopMerge = gitIn(repo.root, 'rev-parse', trialRef(crashed));
  assert.equal(record.state, 'failed');
  assert.equal(record.attempts, shadowRunnerRetries, 'tried again once, then given up');
  for (const named of [crashed, repo.base, loopMerge, 'tests runner exited (status 3)', '2 of the group\'s 2 file(s) finished', 'tests/crash.test.ts', 'given up against this tip', 'the runner process is leaving without a verdict', '[exit status 3]']) assert.ok(record.detail.includes(named), `the record names ${named}:\n${record.detail}`);
  assert.ok(record.detail.length <= 2000);
  assert.deepEqual(state.shadow, [], 'no verdict, so no shadow-only-fail can follow');
  assert.equal(attention.length, 1, `one attention line, once: ${attention.join(' / ')}`);
  assert.match(attention[0]!, /^Shadow merge gate runner failure: GY-1548 head [0-9a-f]{40} on [0-9a-f]{40} ended 2 trials with its tests runner exiting \(status 3\) and no failing test named/);
  assert.ok(!state.actions[shadowErrorKey(crashed, repo.base)], 'a runner failure is not a trial error');
});

test('integration:shadow-trial-bounded-test-groups — the selection runs in groups of at most trialTestGroupSize files, each its own runner process over the exact trial merge tree, every file once and in order; a failing group names its files, whether a record names the failing test or the runner exited naming none; and the real pre-merge suite never fits one group', async () => {
  const repo = await fixture();
  const suite = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`tests/t${index}.test.ts`, 'x\n']));
  const files = Object.keys(suite).sort();
  // Eight passing files in groups of three: three runner processes, each in the merge's tree (the head adds the marker), together exactly the selection.
  const head = repo.commitOnBase({ ...suite, 'tree-marker': 'merge-of-head\n' }, 'eight files');
  const base = await temporaryDirectory('trial-merge-root', tmpdir());
  const result = await runTrial({ root: repo.root, base, mergeSha: await mergeOf(repo, head), changedFiles: files, timeoutMs: 120_000, key: 'GY-9', environment: { PATH: process.env.PATH! }, groupSize: 3 });
  assert.deepEqual(result.tests, { passed: 8, failed: [], files: 8 }, result.logTail);
  assert.deepEqual(result.groups?.map(group => group.files), [files.slice(0, 3), files.slice(3, 6), files.slice(6)], 'every file runs once, in the selection\'s order, at most three to a process');
  assert.equal(result.logTail.match(/run-tests\.ts --files-from \S+tests-\d\.txt --durations \S+tests-\d\.jsonl/g)?.length, 3, 'three runner processes, each with its own list and records');
  assert.equal(result.logTail.match(/^group: \d file\(s\) in merge-of-head$/gm)?.length, 3, `every group ran the trial merge tree:\n${result.logTail}`);
  assert.deepEqual([result.runnerExit, result.groups?.every(group => group.status === 0 && group.signal === null)], [0, true]);
  assert.equal(existsSync(base) ? readdirSync(base).length : 0, 0, 'the checkout is removed');
  // A failing test in the second group: the verdict names the file, and the group record says which process failed.
  const named = repo.commitOnBase({ ...suite, 'tests/t4bad.test.ts': 'x\n' }, 'one failing file');
  const namedFiles = [...files, 'tests/t4bad.test.ts'].sort();
  const failing = await runTrial({ root: repo.root, base, mergeSha: await mergeOf(repo, named), changedFiles: namedFiles, timeoutMs: 120_000, key: 'GY-9', environment: { PATH: process.env.PATH! }, groupSize: 3 });
  assert.deepEqual([failing.tests, failing.runnerExit], [{ passed: 8, failed: ['tests/t4bad.test.ts'], files: 9 }, 1]);
  assert.deepEqual(failing.groups?.map(group => [group.files.length, group.status, group.failed]), [[3, 0, []], [3, 1, ['tests/t4bad.test.ts']], [3, 0, []]], 'the failing group is the one holding the file');
  // A runner exit naming no test in the second group, with a named failure in the third: the named failure is the verdict, the exit rides along in the group record.
  const mixed = repo.commitOnBase({ ...suite, 'tests/t4crash.test.ts': 'x\n', 'tests/t9bad.test.ts': 'x\n' }, 'a crash and a failure');
  const mixedFiles = [...files, 'tests/t4crash.test.ts', 'tests/t9bad.test.ts'].sort();
  const both = await runTrial({ root: repo.root, base, mergeSha: await mergeOf(repo, mixed), changedFiles: mixedFiles, timeoutMs: 120_000, key: 'GY-9', environment: { PATH: process.env.PATH! }, groupSize: 3 });
  assert.deepEqual(both.tests.failed, ['tests/t9bad.test.ts'], 'a named failing test stays the verdict');
  assert.deepEqual(both.groups?.map(group => [group.status, group.failed]), [[0, []], [3, []], [0, []], [1, ['tests/t9bad.test.ts']]], both.logTail);
  // The same exit with no failing test named anywhere: a runner failure naming exactly the group's files.
  const crashOnly = repo.commitOnBase({ ...suite, 'tests/crash.test.ts': 'x\n' }, 'a crash');
  const crashFiles = [...files, 'tests/crash.test.ts'].sort();
  await assert.rejects(runTrial({ root: repo.root, base, mergeSha: await mergeOf(repo, crashOnly), changedFiles: crashFiles, timeoutMs: 120_000, key: 'GY-9', environment: { PATH: process.env.PATH! }, groupSize: 3 }),
    (error: unknown) => error instanceof TrialRunnerError && error.status === 3 && error.files.length === 3 && error.files.includes('tests/crash.test.ts') && error.finished === 3);
  // The bound itself: this repository's pre-merge suite, as scripts/ci-tests.mjs selects it, never runs in one process.
  const suiteFiles = preMergeTestFiles();
  const groups = groupTestFiles(suiteFiles);
  assert.ok(suiteFiles.length > 400 && groups.length >= Math.ceil(suiteFiles.length / trialTestGroupSize) && groups.length > 1, `${suiteFiles.length} files run in ${groups.length} groups`);
  assert.ok(groups.every(group => group.length <= trialTestGroupSize && group.length > 0));
  assert.deepEqual(groups.flat(), suiteFiles, 'every selected file, once, in order');
  assert.deepEqual([groupTestFiles([]), groupTestFiles(['a'], 0)], [[], [['a']]], 'an empty selection has no group; a bound under one is one');
  assert.equal(trialTestGroupSize, 40);
});
