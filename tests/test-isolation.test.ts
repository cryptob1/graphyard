import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abnormalTestExit, containedInstall, containmentWorks, isolatedTestEnvironment, loaderDigest, passedTestControls, reserveTestPorts, testPortEnvironment, npmCiArgs, npmCiEnvironment, repeatedRequiredTitle } from '../src/cli/test-isolation.js';
import { countProofCases, runProof } from '../src/cli/verify.js';
import { bindEvidence, leaseCommands, testedBinding } from '../src/cli/lease.js';
import { githubPauseReset, pauseRetry, submitThroughPause } from '../src/cli/complete.js';
import { ensureWorktreeDependencies, installMatchesLockfile } from '../src/repository-setup.js';
import { installUnderLease } from '../src/cli/workspace.js';
import { runTests } from './helpers/run-tests.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const repository = new URL('..', import.meta.url);
const scratch = (prefix: string) => temporaryDirectory(`isolation-${prefix}`);
const listen = (port = 0) => new Promise<{ port: number; close(): Promise<void> }>((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve({ port: (server.address() as { port: number }).port, close: () => new Promise(done => server.close(() => done())) }));
});

test('unit:test-isolation strips every GRAPHYARD_* and HERDR_* variable the runner did not set', () => {
  const environment = isolatedTestEnvironment({
    PATH: '/usr/bin', HOME: '/home/someone', NODE_TEST_CONTEXT: 'child-v8',
    GRAPHYARD_TOKEN: 'session-credential', GRAPHYARD_TOKEN_FILE: '/run/credential', GRAPHYARD_URL: 'https://graphyard.example', GRAPHYARD_HOST_ID: 'host',
    GRAPHYARD_REQUEST_ID: 'request', GRAPHYARD_TEST_PORT: '15438', GRAPHYARD_EVENTS_TEST_PORT: '15466', GRAPHYARD_DELEGATION_TEST_PORT: '1',
    HERDR_PANE: 'w1:p1', HERDR_SOCKET: '/run/herdr.sock', HERDR_WORKSPACE: 'w1',
    GRAPHYARD_TIMING_RECORD: '/tmp/timing.jsonl',
  }, testPortEnvironment(21000));
  assert.deepEqual(Object.keys(environment).filter(name => /^(GRAPHYARD|HERDR)_/.test(name)).sort(), ['GRAPHYARD_EVENTS_TEST_PORT', 'GRAPHYARD_TEST_PORT', 'GRAPHYARD_TIMING_RECORD']);
  assert.equal(environment.GRAPHYARD_TEST_PORT, '21000', 'the port is the window the runner reserved, not the one the caller carried');
  assert.equal(environment.GRAPHYARD_EVENTS_TEST_PORT, '21028');
  assert.equal(environment.GRAPHYARD_TIMING_RECORD, '/tmp/timing.jsonl', 'a harness control the caller set on purpose passes');
  assert.equal(environment.PATH, '/usr/bin'); assert.equal(environment.HOME, '/home/someone');
  assert.equal(environment.NODE_TEST_CONTEXT, undefined);
});

test('unit:test-isolation reserves a free port window per run: held and busy windows are skipped, concurrent reservations never share one, a killed holder leaves none behind', async () => {
  const busy = await listen();
  try {
    const options = { first: busy.port, span: 4, last: busy.port + 400 };
    const first = await reserveTestPorts(options);
    assert.ok(first.base > busy.port, 'the window holding a listening port is skipped');
    assert.equal(first.sentinel, first.base + first.span - 1);
    const second = await reserveTestPorts(options);
    assert.ok(second.base >= first.base + first.span, 'a window another live run holds is skipped');
    first.release(); await new Promise(done => setTimeout(done, 50));
    const again = await reserveTestPorts(options);
    assert.equal(again.base, first.base, 'a released window is free again');
    again.release(); second.release(); await new Promise(done => setTimeout(done, 50));

    // Reservations racing for the same windows: the sentinel bind is the kernel's decision, so no
    // two of them take one window, however their probes interleave.
    const racing = await Promise.all(Array.from({ length: 6 }, () => reserveTestPorts(options)));
    assert.equal(new Set(racing.map(entry => entry.base)).size, racing.length, 'each concurrent reservation holds its own window');
    for (const entry of racing) entry.release();
    await new Promise(done => setTimeout(done, 50));

    // A run killed while holding its window leaves nothing behind to reclaim.
    const holder = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `const { reserveTestPorts } = await import(${JSON.stringify(new URL('src/cli/test-isolation.ts', repository).href)}); const held = await reserveTestPorts(${JSON.stringify(options)}); console.log(held.base); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
    const heldBase = await new Promise<number>((resolve, reject) => { holder.stdout!.once('data', chunk => resolve(Number(String(chunk).trim()))); holder.once('exit', code => reject(new Error(`holder exited ${code}`))); });
    assert.equal(heldBase, first.base);
    const beside = await reserveTestPorts(options);
    assert.notEqual(beside.base, heldBase, 'a window held by another process is skipped');
    beside.release();
    await new Promise(done => { holder.once('exit', done); holder.kill('SIGKILL'); });
    const after = await reserveTestPorts(options);
    assert.equal(after.base, heldBase, 'the killed holder\'s window is free at once');
    after.release();
  } finally { await busy.close(); }
});

test('unit:test-isolation two concurrent test runs on one host both pass', async () => {
  const project = await scratch('project');
  try {
    await mkdir(join(project, 'tests'));
    // Stands in for a database-backed test file: it holds base + 7 for a while, as its Postgres
    // would, and fails if it can see the session's credentials.
    await writeFile(join(project, 'tests', 'database.test.ts'), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
test('holds its database port', async () => {
  // Harness controls the caller set on purpose (CI's timing record) pass; nothing else of the session's does.
  const controls = new Set(${JSON.stringify(passedTestControls)});
  assert.deepEqual(Object.keys(process.env).filter(name => /^(GRAPHYARD|HERDR)_/.test(name) && !controls.has(name)).sort(), ['GRAPHYARD_EVENTS_TEST_PORT', 'GRAPHYARD_TEST_PORT']);
  const port = Number(process.env.GRAPHYARD_TEST_PORT) + 7;
  const server = createServer();
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen({ port, host: '127.0.0.1', exclusive: true }, () => ok()); });
  await new Promise(done => setTimeout(done, 1500));
  await new Promise(done => server.close(done));
});
`);
    const environment = { ...process.env, GRAPHYARD_TOKEN: 'session-credential', GRAPHYARD_TOKEN_FILE: '/run/credential', HERDR_PANE: 'w1:p1', GRAPHYARD_TEST_PORT: '15438', GRAPHYARD_TIMING_RECORD: join(project, 'timing.jsonl') };
    const runs = await Promise.all([0, 1].map(() => runTests({ cwd: project, environment, stdio: 'pipe', ports: { span: 20 } })));
    for (const run of runs) assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.notEqual(runs[0].base, runs[1].base, 'each run held its own window');
    assert.ok(runs.every(run => run.environment.GRAPHYARD_TOKEN === undefined && run.environment.HERDR_PANE === undefined));
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('unit:test-isolation npm test and the browser suite start through the isolating runner, and no test file fixes its own Postgres port', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', repository), 'utf8'));
  assert.match(manifest.scripts.test, /tests\/helpers\/run-tests\.ts$/);
  assert.match(manifest.scripts['test:browser'], /tests\/helpers\/run-tests\.ts --browser$/);
  const playwright = await readFile(new URL('playwright.config.ts', repository), 'utf8');
  assert.match(playwright, /process\.env\.GRAPHYARD_BROWSER_PORT/);
  assert.doesNotMatch(playwright, /--port 4319/);
  const fixed: string[] = [];
  for (const name of (await readdir(new URL('tests/', repository))).filter(file => file.endsWith('.test.ts'))) {
    const source = await readFile(new URL(`tests/${name}`, repository), 'utf8');
    if (/new EmbeddedPostgres\(\{[^}]*\bport: \d{4,5}\b/.test(source)) fixed.push(name);
  }
  assert.deepEqual(fixed, [], 'every test Postgres is placed on the reserved GRAPHYARD_TEST_PORT window');
});

test('unit:test-isolation the managed worktree installs dependencies when package-lock.json differs from its node_modules', async () => {
  const root = await scratch('root');
  try {
    const worktree = join(root, '.graphyard', 'worktrees', 'GY-1-1');
    await mkdir(join(root, 'node_modules'), { recursive: true }); await mkdir(worktree, { recursive: true });
    const lock = (version: string) => ({ name: 'app', lockfileVersion: 3, packages: { '': { name: 'app' }, 'node_modules/left-pad': { version, integrity: `sha512-${version}` }, 'node_modules/@esbuild/aix-ppc64': { version: '0.1.0', optional: true, os: ['aix'], cpu: ['ppc64'] } } });
    await writeFile(join(root, 'node_modules', '.package-lock.json'), JSON.stringify({ name: 'app', lockfileVersion: 3, packages: { 'node_modules/left-pad': { version: '1.0.0', integrity: 'sha512-1.0.0' } } }));
    await mkdir(join(root, 'node_modules', 'left-pad'));
    const installs: string[] = [];
    // As npm ci does, the installer leaves the checkout's lockfile as the install's hidden lockfile and a folder for each package this host takes.
    const installer = async (cwd: string) => {
      installs.push(cwd); await mkdir(join(cwd, 'node_modules'), { recursive: true });
      const { packages } = JSON.parse(await readFile(join(cwd, 'package-lock.json'), 'utf8'));
      const taken = Object.fromEntries(Object.entries(packages).filter(([path, entry]) => path && !(entry as { optional?: boolean }).optional));
      await writeFile(join(cwd, 'node_modules', '.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: taken }));
      for (const path of Object.keys(taken)) await mkdir(join(cwd, path), { recursive: true });
    };

    await writeFile(join(worktree, 'package-lock.json'), JSON.stringify(lock('1.0.0')));
    const shared = await ensureWorktreeDependencies(worktree, installer);
    assert.equal(shared.state, 'current', shared.reason);
    assert.equal(shared.install, join(root, 'node_modules'));
    assert.deepEqual(installs, [], 'an install that matches the lockfile is used as it is');
    // npm counts a hidden lockfile only while every package folder it names exists: a removed package under an intact record is reinstalled.
    await rm(join(root, 'node_modules', 'left-pad'), { recursive: true });
    const removed = await ensureWorktreeDependencies(worktree, installer);
    assert.equal(removed.state, 'installed', removed.reason);
    assert.match(removed.reason, /node_modules\/left-pad is recorded in the install's hidden lockfile but its folder .*node_modules\/left-pad is missing/);
    assert.deepEqual(installs, [worktree]);
    await rm(join(worktree, 'node_modules'), { recursive: true }); await mkdir(join(root, 'node_modules', 'left-pad')); installs.length = 0;
    // The check after npm ci exits 0 counts folders too: a hidden lockfile with no packages installed is a failed install.
    await rm(join(root, 'node_modules', 'left-pad'), { recursive: true });
    const hollow = await ensureWorktreeDependencies(worktree, async cwd => { await mkdir(join(cwd, 'node_modules'), { recursive: true }); await writeFile(join(cwd, 'node_modules', '.package-lock.json'), await readFile(join(cwd, 'package-lock.json'))); });
    assert.equal(hollow.state, 'failed', hollow.reason);
    assert.match(hollow.reason, /npm ci exited 0 without installing it: node_modules\/left-pad is recorded .* is missing/);
    await rm(join(worktree, 'node_modules'), { recursive: true }); await mkdir(join(root, 'node_modules', 'left-pad'));
    // An install made with bin-links=false holds every folder but no node_modules/.bin: it is not current, and npm ci reruns.
    const withBin = { name: 'app', lockfileVersion: 3, packages: { '': { name: 'app' }, 'node_modules/left-pad': { version: '1.0.0', integrity: 'sha512-1.0.0', bin: { 'left-pad': 'cli.js' } } } };
    await writeFile(join(worktree, 'package-lock.json'), JSON.stringify(withBin));
    await writeFile(join(root, 'node_modules', '.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/left-pad': withBin.packages['node_modules/left-pad'] } }));
    const linkless = await ensureWorktreeDependencies(worktree, async cwd => { await installer(cwd); await mkdir(join(cwd, 'node_modules', '.bin'), { recursive: true }); await writeFile(join(cwd, 'node_modules', '.bin', 'left-pad'), ''); });
    assert.equal(linkless.state, 'installed', linkless.reason);
    assert.match(linkless.reason, /node_modules\/left-pad declares the executable .*node_modules\/\.bin\/left-pad, which the install never linked/);
    assert.equal((await ensureWorktreeDependencies(worktree, async () => { throw new Error('not reinstalled'); })).state, 'current', 'with its links in place the install is current');
    await rm(join(worktree, 'node_modules', '.bin'), { recursive: true });
    const unlinked = await ensureWorktreeDependencies(worktree, installer);
    assert.equal(unlinked.state, 'failed', 'npm ci exiting 0 without the links is a failed install');
    assert.match(unlinked.reason, /exited 0 without installing it: .*which the install never linked/);
    await rm(join(worktree, 'node_modules'), { recursive: true }); installs.length = 0;
    await writeFile(join(root, 'node_modules', '.package-lock.json'), JSON.stringify({ name: 'app', lockfileVersion: 3, packages: { 'node_modules/left-pad': { version: '1.0.0', integrity: 'sha512-1.0.0' } } }));

    await writeFile(join(worktree, 'package-lock.json'), JSON.stringify(lock('2.0.0')));
    const changed = await ensureWorktreeDependencies(worktree, installer);
    assert.equal(changed.state, 'installed', changed.reason);
    assert.deepEqual(installs, [worktree], 'a changed lockfile is installed in the worktree itself');
    assert.match(changed.reason, /left-pad is installed at 1\.0\.0, package-lock\.json names 2\.0\.0/);

    await rm(join(worktree, 'node_modules'), { recursive: true, force: true });
    const failed = await ensureWorktreeDependencies(worktree, async () => { throw new Error('npm ci exited with 1'); });
    assert.equal(failed.state, 'failed'); assert.match(failed.reason, /npm ci exited with 1/);
    // An npm ci that exits 0 having installed nothing (an inherited dry-run) is a failed install, never reported as installed.
    const dryRun = await ensureWorktreeDependencies(worktree, async () => {});
    assert.equal(dryRun.state, 'failed', dryRun.reason);
    assert.match(dryRun.reason, /npm ci exited 0 without installing it: the install records no hidden lockfile/);

    await mkdir(join(worktree, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(join(worktree, 'node_modules', '.package-lock.json'), JSON.stringify({ packages: { 'node_modules/left-pad': { version: '2.0.0', integrity: 'sha512-2.0.0' } } }));
    assert.equal((await ensureWorktreeDependencies(worktree, installer)).state, 'current', 'the worktree\'s own matching install is kept');
    assert.equal(installs.length, 1);

    // A hidden lockfile an interrupted install left truncated is reinstalled, not thrown on.
    await writeFile(join(worktree, 'node_modules', '.package-lock.json'), '{"packages": {"node_modules/left-');
    const truncated = await ensureWorktreeDependencies(worktree, installer);
    assert.equal(truncated.state, 'installed', truncated.reason);
    assert.match(truncated.reason, /hidden lockfile .* is unreadable/);
    assert.equal(installs.length, 2);
    // The checkout's own unparsable package-lock.json is reported, not thrown, and installs nothing.
    await writeFile(join(worktree, 'package-lock.json'), '{"lockfileVersion": 3,');
    const unparsable = await ensureWorktreeDependencies(worktree, installer);
    assert.equal(unparsable.state, 'failed'); assert.match(unparsable.reason, /package-lock\.json cannot be parsed/);
    assert.equal(installs.length, 2);
    await writeFile(join(worktree, 'package-lock.json'), JSON.stringify(lock('2.0.0')));

    assert.equal(installMatchesLockfile(lock('1.0.0'), { packages: {} }), 'node_modules/left-pad is named by package-lock.json but not installed');
    assert.equal(installMatchesLockfile(lock('1.0.0'), null), 'the install records no hidden lockfile (node_modules/.package-lock.json)');
    // A git or link dependency's identity is its `resolved` or `link`, usually with no integrity: a moved commit at the same version is a mismatch.
    const git = (commit: string) => ({ packages: { 'node_modules/dep': { version: '1.0.0', resolved: `git+ssh://git@github.com/o/dep.git#${commit}` } } });
    assert.equal(installMatchesLockfile(git('aaa'), git('aaa')), true);
    assert.match(String(installMatchesLockfile(git('bbb'), git('aaa'))), /node_modules\/dep is installed from .*#aaa, package-lock.json names .*#bbb/);
    assert.match(String(installMatchesLockfile({ packages: { 'node_modules/dep': { version: '1.0.0', resolved: '../dep', link: true } } }, git('aaa'))), /installed as a package, package-lock.json names a link/);
    // An optional package this host's platform admits must be installed (an omit=optional install or a discarded optional
    // build leaves tsx or embedded Postgres without its binary); one for another platform, or an optional peer, may be absent.
    const platformLock = { packages: { 'node_modules/@esbuild/linux-x64': { version: '0.1.0', optional: true, os: ['linux'], cpu: ['x64'] }, 'node_modules/@esbuild/linux-x64-musl': { version: '0.1.0', optional: true, os: ['linux'], cpu: ['x64'], libc: ['musl'] }, 'node_modules/@esbuild/not-win': { version: '0.1.0', optional: true, os: ['!win32'] }, 'node_modules/peer-extra': { version: '1.0.0', optional: true, peer: true } } };
    const linuxGlibc = { os: 'linux', cpu: 'x64', libc: 'glibc' };
    assert.match(String(installMatchesLockfile(platformLock, { packages: {} }, linuxGlibc)), /@esbuild\/linux-x64 is an optional package for this platform \(linux x64 glibc\) named by package-lock.json but not installed/);
    const heldForLinux = { packages: { 'node_modules/@esbuild/linux-x64': { version: '0.1.0' }, 'node_modules/@esbuild/not-win': { version: '0.1.0' } } };
    assert.equal(installMatchesLockfile(platformLock, heldForLinux, linuxGlibc), true, 'the musl-only package and the optional peer may be absent on glibc');
    assert.match(String(installMatchesLockfile(platformLock, heldForLinux, { os: 'linux', cpu: 'x64', libc: 'musl' })), /linux-x64-musl is an optional package for this platform/);
    assert.equal(installMatchesLockfile(platformLock, { packages: {} }, { os: 'win32', cpu: 'arm64', libc: null }), true, 'nothing in it is for win32 arm64');
    // A lockfileVersion 1 file keeps its inventory in the nested `dependencies` tree; npm's hidden lockfile is v3 with `packages`.
    const v1 = { lockfileVersion: 1, dependencies: {
      'left-pad': { version: '1.0.0', integrity: 'sha512-1.0.0', dependencies: { 'nested': { version: '2.0.0', integrity: 'sha512-n' } } },
      'from-git': { version: 'git+ssh://git@github.com/o/dep.git#aaa', from: 'git+ssh://git@github.com/o/dep.git' },
      'fsevents': { version: '2.3.3', integrity: 'sha512-f', optional: true },
    } };
    const heldV3 = { lockfileVersion: 3, packages: { 'node_modules/left-pad': { version: '1.0.0', integrity: 'sha512-1.0.0' }, 'node_modules/left-pad/node_modules/nested': { version: '2.0.0', integrity: 'sha512-n' }, 'node_modules/from-git': { version: '3.1.0', resolved: 'git+ssh://git@github.com/o/dep.git#aaa' } } };
    assert.equal(installMatchesLockfile(v1, heldV3, linuxGlibc), true, 'a v1 lockfile matches the v3 hidden lockfile npm ci writes for it; its optional records carry no platform, so they may be absent');
    assert.match(String(installMatchesLockfile({ ...v1, dependencies: { ...v1.dependencies, 'left-pad': { ...v1.dependencies['left-pad'], version: '1.1.0' } } }, heldV3, linuxGlibc)), /node_modules\/left-pad is installed at 1\.0\.0, package-lock\.json names 1\.1\.0/);
    assert.match(String(installMatchesLockfile(v1, { packages: { ...heldV3.packages, 'node_modules/stray': { version: '1.0.0' } } }, linuxGlibc)), /node_modules\/stray is installed but package-lock\.json no longer names it/);
    assert.match(String(installMatchesLockfile(v1, { packages: { 'node_modules/left-pad': heldV3.packages['node_modules/left-pad'] } }, linuxGlibc)), /node_modules\/left-pad\/node_modules\/nested is named by package-lock\.json but not installed/);
    // A v1 git, file or tarball record names its source in `version`, usually with no integrity: a source moved to another
    // commit or tarball is a mismatch, whichever spelling npm recorded for the same repository and commit.
    const commit = (c: string) => c.repeat(40);
    const gitLock = (source: string) => ({ lockfileVersion: 1, dependencies: { 'from-git': { version: source } } });
    const gitHeld = { packages: { 'node_modules/from-git': { version: '3.1.0', resolved: `git+ssh://git@github.com/o/dep.git#${commit('a')}` } } };
    assert.equal(installMatchesLockfile(gitLock(`github:o/dep#${commit('a')}`), gitHeld, linuxGlibc), true, 'the same repository and commit in another spelling');
    assert.match(String(installMatchesLockfile(gitLock(`git+ssh://git@github.com/o/dep.git#${commit('b')}`), gitHeld, linuxGlibc)), /node_modules\/from-git is installed from git\+ssh:\/\/git@github\.com\/o\/dep\.git#a{40}, package-lock\.json names git\+ssh:\/\/git@github\.com\/o\/dep\.git#b{40}/);
    assert.match(String(installMatchesLockfile(gitLock('https://registry.example/dep-3.2.0.tgz'), { packages: { 'node_modules/from-git': { version: '3.1.0', resolved: 'https://registry.example/dep-3.1.0.tgz' } } }, linuxGlibc)), /installed from https:\/\/registry\.example\/dep-3\.1\.0\.tgz/);
    assert.match(String(installMatchesLockfile(gitLock(`github:o/dep#${commit('a')}`), { packages: { 'node_modules/from-git': { version: '3.1.0' } } }, linuxGlibc)), /installed from no recorded source/, 'an install that recorded no source cannot be matched, so npm ci reinstalls it');
    // End to end: a checkout with a v1 lockfile is installed once, then reported current, never failed after a good npm ci.
    await rm(join(worktree, 'node_modules'), { recursive: true, force: true }); await writeFile(join(worktree, 'package-lock.json'), JSON.stringify(v1));
    const npmV3 = async (cwd: string) => {
      await mkdir(join(cwd, 'node_modules'), { recursive: true }); await writeFile(join(cwd, 'node_modules', '.package-lock.json'), JSON.stringify(heldV3));
      for (const path of Object.keys(heldV3.packages)) await mkdir(join(cwd, path), { recursive: true });
    };
    const legacy = await ensureWorktreeDependencies(worktree, npmV3);
    assert.equal(legacy.state, 'installed', legacy.reason);
    assert.equal((await ensureWorktreeDependencies(worktree, async () => { throw new Error('not reinstalled'); })).state, 'current');
    await writeFile(join(worktree, 'package-lock.json'), JSON.stringify(lock('2.0.0')));
    // The install always takes the full tree: an inherited production/omit config would skip devDependencies while npm exits 0.
    assert.ok(npmCiArgs.includes('--include=dev'));
    // Optional dependencies too: an .npmrc omit=optional would skip platform packages (esbuild's binary, which tsx loads; @embedded-postgres/*) while npm exits 0, and the lockfile check accepts a missing optional entry.
    assert.ok(npmCiArgs.includes('--include=optional'), 'an .npmrc omit=optional is overridden');
    assert.ok(npmCiArgs.includes('--no-dry-run'), 'a dry-run from an .npmrc is overridden too');
    // So are settings that let npm exit 0 with a matching hidden lockfile but no install scripts run or no .bin links made.
    assert.ok(npmCiArgs.includes('--ignore-scripts=false') && npmCiArgs.includes('--bin-links'), 'ignore-scripts and bin-links=false are overridden');
    // The trusted unit runner installs the candidate through the same contained npm ci, npmCiArgs and all.
    assert.match(await readFile(new URL('scripts/run-unit-acceptance.mjs', repository), 'utf8'), /provisionContainment\(\);\n\s*const install = containedInstall\(candidate\);\n\s*execFileSync\(install\.command, install\.args, \{ cwd: candidate, env: npmCiEnvironment\(\)/, 'the trusted unit runner installs contained, with the full tree');
    const cleared = npmCiEnvironment({ PATH: '/bin', NODE_ENV: 'production', npm_config_omit: 'dev', NPM_CONFIG_PRODUCTION: 'true', npm_config_dry_run: 'true', 'npm_config_dry-run': 'true', npm_config_ignore_scripts: 'true', npm_config_bin_links: 'false' });
    assert.deepEqual(cleared, { PATH: '/bin' });
    // The install runs the checkout's lifecycle scripts outside any sandbox: none of the launcher's credentials reach them.
    assert.deepEqual(npmCiEnvironment({ PATH: '/bin', npm_config_registry: 'https://registry.example/', GRAPHYARD_TOKEN_FILE: '/secret', GRAPHYARD_TOKEN: 't', GRAPHYARD_URL: 'http://plane', HERDR_PANE: 'p', GH_TOKEN: 'g', GITHUB_TOKEN: 'g' }),
      { PATH: '/bin', npm_config_registry: 'https://registry.example/' });

    // Filtering the environment is not containment: npm runs under bubblewrap with the filesystem read-only, its own PID
    // namespace and /proc, the home directory, /tmp and every credential location emptied, and only node, npm, the PATH and
    // ~/.npmrc put back (read-only) and npm's content cache and the worktree writable.
    assert.throws(() => containedInstall(worktree, { PATH: '/usr/bin', HOME: root }, { bwrap: null }), /bubblewrap \(bwrap\) is not installed, and dependencies are never installed without it/);
    const home = join(root, 'home'), outside = join(root, 'secrets'), runtime = join(root, 'runtime');
    await mkdir(join(home, '.config', 'graphyard', 'tokens'), { recursive: true }); await mkdir(join(home, '.ssh')); await mkdir(outside); await mkdir(runtime);
    await writeFile(join(home, '.config', 'graphyard', 'tokens', 'worker.token'), 'secret'); await writeFile(join(outside, 'worker.token'), 'secret');
    await writeFile(join(home, '.ssh', 'id_ed25519'), 'secret'); await writeFile(join(home, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
    // A tool installed under the home directory through a version symlink (mise's node/26 -> 26.10.0), npm linking into its lib.
    // The stub npm is the hostile lifecycle script: it reads credentials, writes outside the worktree, looks at other
    // processes through /proc and leaves a detached process behind to write after the install returned.
    const tool = join(home, '.local', 'share', 'tool'), probe = fileURLToPath(new URL('.containment-probe', repository));
    await mkdir(join(tool, '26.10.0', 'bin'), { recursive: true }); await mkdir(join(tool, '26.10.0', 'lib'), { recursive: true }); await symlink('26.10.0', join(tool, '26'));
    await writeFile(join(tool, '26.10.0', 'lib', 'npm-cli.sh'), [
      '#!/bin/sh',
      `cat "${join(home, '.config', 'graphyard', 'tokens', 'worker.token')}" "${join(outside, 'worker.token')}" "${join(home, '.ssh', 'id_ed25519')}" /proc/${process.pid}/environ /proc/${process.pid}/root/${join(outside, 'worker.token')} > leaked.txt 2>/dev/null`,
      `cat "${join(home, '.npmrc')}" > npmrc.txt`, 'echo "$@" > args.txt',
      `touch "${probe}" 2>/dev/null; ls -d /proc/[0-9]* | wc -l > processes.txt; echo "$TMPDIR" > tmpdir.txt`,
      `setsid sh -c 'sleep 1; echo late > "${join(worktree, 'late.txt')}"' >/dev/null 2>&1 < /dev/null &`, '',
    ].join('\n'));
    await chmod(join(tool, '26.10.0', 'lib', 'npm-cli.sh'), 0o755); await symlink('../lib/npm-cli.sh', join(tool, '26.10.0', 'bin', 'npm'));
    const env = { PATH: `${join(tool, '26', 'bin')}:/usr/bin:/bin`, HOME: home, GRAPHYARD_TOKEN_FILE: join(outside, 'worker.token'), XDG_RUNTIME_DIR: runtime };
    const contained = containedInstall(worktree, env, { bwrap: '/usr/bin/bwrap', node: '/usr/bin/node', uid: 4242 });
    assert.equal(contained.command, '/usr/bin/bwrap');
    const pairs = (flag: string) => contained.args.flatMap((arg, index) => arg === flag ? [contained.args[index + 1]] : []);
    assert.deepEqual(contained.args.slice(0, 11), ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-all', '--share-net', '--die-with-parent', '--new-session'],
      'the filesystem is read-only and every namespace but the network is the install\'s own: its /proc shows only its processes, all killed when it ends');
    assert.ok(!contained.args.includes('--dev-bind'), 'nothing of the host is mounted writable wholesale');
    assert.deepEqual(pairs('--tmpfs'), ['/tmp', home, runtime], '/tmp (the token file\'s directory in it), the home and the runtime directories are emptied');
    assert.ok(contained.args.join(' ').includes('--setenv TMPDIR /tmp'));
    assert.deepEqual(pairs('--symlink'), ['26.10.0'], 'the version symlink on the way to npm is recreated');
    assert.ok(pairs('--ro-bind').includes(join(tool, '26.10.0', 'bin')) && pairs('--ro-bind').includes(join(home, '.npmrc')), 'npm and the registry config are put back, read-only');
    assert.deepEqual(pairs('--bind'), [join(home, '.npm', '_cacache'), worktree], 'only npm\'s content cache and the worktree are writable');
    assert.ok(![...pairs('--ro-bind'), ...pairs('--bind')].some(path => path.startsWith(join(home, '.config')) || path.startsWith(join(home, '.ssh')) || path.startsWith(outside)), 'no credential location is put back');
    assert.deepEqual(contained.args.slice(contained.args.indexOf('--')), ['--', 'npm', ...npmCiArgs]);
    assert.match(await readFile(new URL('src/repository-setup.ts', repository), 'utf8'), /const \{ command, args \} = containedInstall\(cwd\);\n\s*const child = spawn\(command, args,/, 'the worktree install runs contained');
    // Where bubblewrap can unshare those namespaces, the contained install's scripts really are contained.
    if (containmentWorks()) {
      const live = containedInstall(worktree, env, { node: process.execPath });
      try {
        const ran = spawnSync(live.command, live.args, { cwd: worktree, env, encoding: 'utf8' });
        assert.equal(ran.status, 0, ran.stderr);
        assert.equal(await readFile(join(worktree, 'leaked.txt'), 'utf8'), '', 'no token, key or other process\'s environment was readable');
        assert.match(await readFile(join(worktree, 'npmrc.txt'), 'utf8'), /registry=/);
        assert.equal((await readFile(join(worktree, 'args.txt'), 'utf8')).trim(), npmCiArgs.join(' '));
        assert.equal(existsSync(probe), false, 'the script could not write the checkout outside the worktree');
        assert.ok(Number(await readFile(join(worktree, 'processes.txt'), 'utf8')) < 10, 'its /proc lists only the install\'s own processes');
        assert.equal((await readFile(join(worktree, 'tmpdir.txt'), 'utf8')).trim(), '/tmp');
        await new Promise(done => setTimeout(done, 1500));
        assert.equal(existsSync(join(worktree, 'late.txt')), false, 'no process the install started outlived it');
      } finally { await rm(probe, { force: true }); }
      for (const file of ['leaked.txt', 'npmrc.txt', 'args.txt', 'processes.txt', 'tmpdir.txt']) await rm(join(worktree, file));
    }

    // A refused lease heartbeat stops the install and fails the worktree command.
    await rm(join(worktree, 'node_modules'), { recursive: true, force: true });
    let stoppedBy: unknown = null, renewals = 0, started = 0;
    const slow = (cwd: string, signal?: AbortSignal) => new Promise<void>((_, fail) => { started++; signal!.addEventListener('abort', () => { stoppedBy = signal!.reason; fail(new Error('npm ci stopped')); }); });
    await assert.rejects(installUnderLease(worktree, async () => { renewals++; if (renewals > 1) throw new Error('Lease epoch is stale'); }, 'GY-1 epoch 1', { install: slow, intervalMs: 20 }),
      /lease heartbeat for GY-1 epoch 1 was refused while installing dependencies, so the install was stopped: Lease epoch is stale/);
    assert.equal(renewals, 2); assert.equal(started, 1); assert.ok(stoppedBy instanceof Error, 'the installer was told to stop');
    // The lease is renewed before npm starts, not an interval later: a lease that has already lapsed installs nothing.
    let first = 0; started = 0;
    await assert.rejects(installUnderLease(worktree, async () => { first++; throw new Error('Lease epoch is expired'); }, 'GY-1 epoch 1', { install: slow, intervalMs: 60_000 }),
      /lease heartbeat for GY-1 epoch 1 was refused while installing dependencies, so the install was stopped: Lease epoch is expired/);
    assert.equal(first, 1, 'renewed once up front, not after a whole interval'); assert.equal(started, 0, 'npm never started under a refused lease');
    let kept = 0;
    const brief = (cwd: string) => new Promise<void>(done => setTimeout(() => installer(cwd).then(done), 70));
    assert.equal((await installUnderLease(worktree, async () => { kept++; }, 'GY-1 epoch 1', { install: brief, intervalMs: 20 })).state, 'installed');
    assert.ok(kept >= 1, 'accepted heartbeats keep the install going');
    // A heartbeat still in flight when the install finishes is awaited: refused, it fails the call.
    await rm(join(worktree, 'node_modules'), { recursive: true, force: true });
    let late = 0;
    const quick = (cwd: string) => new Promise<void>(done => setTimeout(() => installer(cwd).then(done), 30));
    const refusedLate = () => { late++; return late === 1 ? Promise.resolve() : new Promise((_, fail) => setTimeout(() => fail(new Error('Lease epoch is superseded')), 60)); };
    await assert.rejects(installUnderLease(worktree, refusedLate, 'GY-1 epoch 1', { install: quick, intervalMs: 20 }),
      /lease heartbeat for GY-1 epoch 1 was refused while installing dependencies, so the install was stopped: Lease epoch is superseded/);
    assert.equal(late, 2, 'the up-front renewal, then one at a time: none starts while one is in flight');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:proof-and-cli-self-sufficient runs each proof\'s whole test file and attributes cases by title prefix', async () => {
  const project = await scratch('proof');
  const saved = { token: process.env.GRAPHYARD_TOKEN, herdr: process.env.HERDR_PANE };
  try {
    await mkdir(join(project, 'tests'));
    const marker = join(project, 'ordinary-case-ran');
    await writeFile(join(project, 'tests', 'demo.test.ts'), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
test('unit:demo first case', () => assert.ok(true));
test('unit:demo sees no session credential and a reserved port', () => { assert.equal(process.env.GRAPHYARD_TOKEN, undefined); assert.equal(process.env.HERDR_PANE, undefined); assert.ok(Number(process.env.GRAPHYARD_TEST_PORT) > 0); });
test('unit:demo-other is another proof', () => assert.ok(true));
test('an ordinary case of the same file', () => { writeFileSync(${JSON.stringify(marker)}, 'ran'); });
`);
    process.env.GRAPHYARD_TOKEN = 'session-credential'; process.env.HERDR_PANE = 'w1:p1';
    const run = await runProof(project, 'unit:demo', ['tests/demo.test.ts'], { span: 20 });
    assert.deepEqual(run, { result: 'pass', executed: 2, failed: 0, skipped: 0, files: ['tests/demo.test.ts'] });
    assert.ok(existsSync(marker), 'the file ran whole: its other cases ran too, rather than being reported as skipped');

    // Another case of the file failing is that case's business; a hook or the process failing after
    // the proof's cases printed ok is not, and fails the proof.
    const head = `import { test, after } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('unit:demo first case', () => assert.ok(true));\n`;
    await writeFile(join(project, 'tests', 'other.test.ts'), `${head}test('an ordinary case that fails', () => assert.fail('not the proof'));\n`);
    assert.deepEqual(await runProof(project, 'unit:demo', ['tests/other.test.ts'], { span: 20 }), { result: 'pass', executed: 1, failed: 0, skipped: 0, files: ['tests/other.test.ts'] });
    await writeFile(join(project, 'tests', 'hook.test.ts'), `${head}after(() => { throw new Error('cleanup failed'); });\n`);
    const hooked = await runProof(project, 'unit:demo', ['tests/hook.test.ts'], { span: 20 });
    assert.equal(hooked.result, 'fail'); assert.equal(hooked.executed, 1); assert.equal(hooked.failed, 0);
    assert.match(hooked.abnormal ?? '', /failed as hookFailed, not as a test case/);
    await writeFile(join(project, 'tests', 'late.test.ts'), `${head}setTimeout(() => { process.exitCode = 3; }, 10);\n`);
    assert.match((await runProof(project, 'unit:demo', ['tests/late.test.ts'], { span: 20 })).abnormal ?? '', /after "tests\/late\.test\.ts" failed as testCodeFailure, not as a test case/);

    const yaml = (title: string, fields: string[], indent = '') => [`${indent}not ok 1 - ${title}`, `${indent}  ---`, ...fields.map(field => `${indent}  ${field}`), `${indent}  ...`].join('\n');
    assert.equal(abnormalTestExit('ok 1 - unit:demo first case', 0, null), null);
    assert.equal(abnormalTestExit(yaml('another case', ["type: 'test'", "failureType: 'testCodeFailure'"]), 1, null), null);
    assert.equal(abnormalTestExit([yaml('inner', ["type: 'test'", "failureType: 'testTimeoutFailure'"], '    '), yaml('suite', ["type: 'suite'", "failureType: 'subtestsFailed'"])].join('\n'), 1, null), null);
    assert.match(abnormalTestExit(yaml('tests/a.test.ts', ["type: 'test'", "failureType: 'testCodeFailure'", 'exitCode: 1', 'signal: ~']), 1, null)!, /after "tests\/a\.test\.ts" failed/);
    assert.match(abnormalTestExit(yaml('a case', ["type: 'test'", "failureType: 'hookFailed'"]), 1, null)!, /hookFailed/);
    assert.match(abnormalTestExit('ok 1 - unit:demo first case', 1, null)!, /reported no failing case/);
    assert.match(abnormalTestExit('ok 1 - unit:demo first case', null, 'SIGKILL')!, /stopped by SIGKILL/);
    const runner = await readFile(new URL('scripts/run-unit-acceptance.mjs', repository), 'utf8');
    assert.match(runner, /const abnormal = abnormalTestExit\(run\.stdout \?\? '', run\.status, run\.signal\);\n\s*if \(abnormal\) throw/, 'the trusted unit runner fails a run that did not end normally');

    // A required title must report exactly once: a module the inventory imports can register a later case under it, and its
    // pass must not stand in for the protected case's failure.
    assert.equal(repeatedRequiredTitle(['not ok 1 - unit:demo first case', 'ok 2 - unit:demo other'].join('\n'), ['unit:demo first case']), null);
    assert.match(repeatedRequiredTitle(['not ok 1 - unit:demo first case', '    ok 1 - unit:demo first case', 'ok 2 - unit:demo first case # SKIP'].join('\n'), ['unit:demo first case', 'unit:demo other']) ?? '', /the required case "unit:demo first case" reported 3 verdicts/);
    assert.match(runner, /const repeated = repeatedRequiredTitle\(run\.stdout \?\? '', selected\.requiredCases\.map\(id => selected\.titles\[id\]\)\);\n\s*if \(repeated\) throw/, 'the trusted unit runner fails a required title reported twice');
    // The transpiler loads from the protected harness, never from the tsx the candidate's lockfile installed.
    assert.doesNotMatch(runner, /'--import', 'tsx'/);
    assert.match(runner, /\['--import', transpiler\.href, '--test'/);
    assert.match(runner, /const transpiler = harnessTranspiler\(\);\n\s*provisionContainment\(\);\n\s*const install = containedInstall\(candidate\);/, 'the transpiler is resolved before any candidate code runs');
    assert.match(runner, /try \{ href = import\.meta\.resolve\('tsx'\); \}/);
    // The candidate's install runs contained, and what the transpiler loads is still digested before that install and
    // checked before and after the run; the harness's own fallback install is the hardened one.
    assert.match(runner, /return \{ href, digest: loaderDigest\(href\) \};/);
    assert.match(runner, /assertLoaderUnchanged\(transpiler, 'before the inventory ran'\);\n\s*const run = spawnSync/);
    assert.match(runner, /if \(run\.error\) throw run\.error;\n\s*assertLoaderUnchanged\(transpiler, 'while the inventory ran'\);/);
    assert.match(runner, /execFileSync\('npm', npmCiArgs, \{ cwd: harness/);
    const loaderRoot = join(project, 'harness'), loaderModules = join(loaderRoot, 'node_modules');
    const pkg = async (path: string, manifest: object, file = 'index.js') => { await mkdir(path, { recursive: true }); await writeFile(join(path, 'package.json'), JSON.stringify(manifest)); await writeFile(join(path, file), `// ${JSON.stringify(manifest)}`); };
    await pkg(join(loaderModules, 'tsx'), { name: 'tsx', dependencies: { esbuild: '1' } }, 'loader.mjs');
    await pkg(join(loaderModules, 'esbuild'), { name: 'esbuild', optionalDependencies: { '@esbuild/linux-x64': '1', '@esbuild/aix-ppc64': '1' } });
    await pkg(join(loaderModules, '@esbuild', 'linux-x64'), { name: '@esbuild/linux-x64' }, 'esbuild');
    await pkg(join(loaderModules, 'unrelated'), { name: 'unrelated' });
    const entry = `file://${join(loaderModules, 'tsx', 'loader.mjs')}`, before = loaderDigest(entry);
    await writeFile(join(loaderModules, 'unrelated', 'index.js'), 'changed');
    assert.equal(loaderDigest(entry), before, 'a package the loader does not load is not its business');
    await writeFile(join(loaderModules, '@esbuild', 'linux-x64', 'esbuild'), 'a substituted binary');
    assert.notEqual(loaderDigest(entry), before, 'a rewritten platform binary two dependencies down is caught');
    await pkg(join(loaderModules, '@esbuild', 'linux-x64'), { name: '@esbuild/linux-x64' }, 'esbuild');
    assert.equal(loaderDigest(entry), before);
    await pkg(join(loaderModules, 'tsx', 'node_modules', 'esbuild'), { name: 'esbuild', shadow: true });
    assert.notEqual(loaderDigest(entry), before, 'a nested package added to shadow a dependency is caught');
    await rm(join(loaderModules, 'tsx', 'node_modules'), { recursive: true });
    assert.notEqual(loaderDigest(entry, join(loaderModules, 'unrelated', 'index.js')), before, 'so is a different node binary');
    const tap = ['ok 1 - unit:demo first case', 'ok 2 - unit:demo-other is another proof # SKIP test name does not match pattern', 'ok 3 - an ordinary case # SKIP', '    not ok 1 - unit:demo nested case', 'ok 4 - unit:demo skipped case # SKIP'].join('\n');
    assert.deepEqual(countProofCases(tap, 'unit:demo'), { executed: 2, failed: 1, skipped: 1 });
    for (const file of ['src/cli/verify.ts', 'scripts/run-unit-acceptance.mjs'])
      assert.doesNotMatch(await readFile(new URL(file, repository), 'utf8'), /\['--test-name-pattern'|'--test-name-pattern',/, `${file} never narrows a proof run by name`);
  } finally {
    if (saved.token === undefined) delete process.env.GRAPHYARD_TOKEN; else process.env.GRAPHYARD_TOKEN = saved.token;
    if (saved.herdr === undefined) delete process.env.HERDR_PANE; else process.env.HERDR_PANE = saved.herdr;
    await rm(project, { recursive: true, force: true });
  }
});

test('unit:proof-and-cli-self-sufficient graphyard evidence fills sha, baseSha and policyRevision from the current candidate when omitted', async () => {
  const sha = 'a'.repeat(40), baseSha = 'b'.repeat(40), work = { id: 'work-1', key: 'GY-1', candidate: { sha, baseSha }, policyRevision: 4 };
  const request = { source: 'the producer request for GY-1', sha, baseSha, policyRevision: 4 }, checkout = { source: 'the checkout HEAD', sha };
  const bare = { proof: 'unit:x', result: 'pass', executed: 3, skipped: 0 };
  assert.deepEqual(bindEvidence(bare, work, request), { ...bare, sha, baseSha, policyRevision: 4 });
  assert.deepEqual(bindEvidence({ ...bare, baseSha, policyRevision: 4 }, work, checkout), { ...bare, sha, baseSha, policyRevision: 4 }, 'a checkout at the current head binds its sha');
  // A checkout records only its head: a base or policy that moved after the run cannot be detected there, so neither is defaulted.
  assert.throws(() => bindEvidence(bare, work, checkout), /the checkout HEAD records only the head the run tested, not its baseSha or policyRevision, so the evidence file must name its baseSha, policyRevision/);
  assert.throws(() => bindEvidence({ ...bare, baseSha }, { ...work, policyRevision: 5 }, checkout), /not its policyRevision, so the evidence file must name its policyRevision/);
  const explicit = { proof: 'unit:x', sha: 'c'.repeat(40), baseSha: 'd'.repeat(40), policyRevision: 2 };
  assert.deepEqual(bindEvidence(explicit, work, null), explicit, 'values the file carries are sent as written');
  assert.throws(() => bindEvidence({ proof: 'unit:x' }, { key: 'GY-1', candidate: null, policyRevision: 1 }, request), /GY-1 has no observed candidate yet/);
  // A candidate that moved after the run is never stamped onto the evidence.
  const moved = 'e'.repeat(40);
  assert.throws(() => bindEvidence(bare, { ...work, candidate: { sha: moved, baseSha } }, request), /current sha is e{40}, but the evidence was produced for a{40} \(the producer request for GY-1\); the candidate moved after the run/);
  assert.throws(() => bindEvidence({ ...bare, baseSha, policyRevision: 4 }, { ...work, candidate: { sha: moved, baseSha } }, checkout), /produced for a{40} \(the checkout HEAD\)/);
  assert.throws(() => bindEvidence(bare, { ...work, candidate: { sha, baseSha: moved } }, request), /current baseSha is e{40}/);
  assert.throws(() => bindEvidence(bare, { ...work, policyRevision: 5 }, request), /current policyRevision is 5, but the evidence was produced for 4/);
  assert.throws(() => bindEvidence({ ...bare, sha: moved }, work, request), /produced for e{40} \(the evidence file\)/, 'the others are not defaulted beside a sha the candidate no longer is');
  assert.throws(() => bindEvidence(bare, work, null), /Nothing records which head this evidence tested/);
  // The binding comes from the producer request the session was launched with, else the checkout's HEAD.
  assert.deepEqual(testedBinding('GY-1', { GRAPHYARD_PRODUCER_BINDING: `GY-1@${sha}@${baseSha}@4` }), request);
  const repo = await scratch('tested');
  try {
    assert.equal(testedBinding('GY-1', {}, repo), null, 'no checkout, no binding');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    git('init', '-q'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
    assert.deepEqual(testedBinding('GY-1', { GRAPHYARD_PRODUCER_BINDING: `GY-2@${sha}@${baseSha}@4` }, repo), { source: `the checkout HEAD in ${repo}`, sha: git('rev-parse', 'HEAD') }, 'another item\'s request does not bind this one');
  } finally { await rm(repo, { recursive: true, force: true }); }

  const file = join(await scratch('evidence'), 'evidence.json'), saved = process.env.GRAPHYARD_PRODUCER_BINDING;
  try {
    await writeFile(file, JSON.stringify({ proof: 'unit:x', result: 'pass', executed: 1, skipped: 0 }));
    const sent: { path: string; data: unknown }[] = [];
    const command = leaseCommands.find(entry => entry.name === 'evidence')!;
    process.env.GRAPHYARD_PRODUCER_BINDING = `GY-1@${sha}@${baseSha}@4`;
    await command.run({ args: [file], api: async (path: string, data: unknown) => { sent.push({ path, data }); return { ok: true }; }, print: () => {} } as any, work);
    assert.deepEqual(sent, [{ path: 'work/work-1/evidence', data: { proof: 'unit:x', result: 'pass', executed: 1, skipped: 0, sha, baseSha, policyRevision: 4 } }]);
  } finally {
    if (saved === undefined) delete process.env.GRAPHYARD_PRODUCER_BINDING; else process.env.GRAPHYARD_PRODUCER_BINDING = saved;
    await rm(join(file, '..'), { recursive: true, force: true });
  }
});

test('unit:proof-and-cli-self-sufficient graphyard complete refused during a GitHub request pause waits for the named reset and submits again, bounded', async () => {
  const refusal = (at: string) => new Error(JSON.stringify({ error: `GitHub requests paused until ${at} after a rate limit` }));
  assert.equal((githubPauseReset(refusal('2026-09-24T18:00:00.000Z')) as Date).toISOString(), '2026-09-24T18:00:00.000Z');
  assert.equal(githubPauseReset(new Error(JSON.stringify({ error: 'GitHub requests paused after a rate/access refusal' }))), 'unnamed');
  assert.equal(githubPauseReset(new Error(JSON.stringify({ error: 'Lease epoch is stale' }))), null);

  let clock = Date.parse('2026-09-24T17:50:00.000Z');
  const slept: number[] = [], sleep = async (ms: number) => { slept.push(ms); clock += ms; };
  let calls = 0;
  const submitted = await submitThroughPause(async () => { calls++; if (calls === 1) throw refusal('2026-09-24T17:55:00.000Z'); return { submitted: true }; }, { now: () => clock, sleep, report: () => {} });
  assert.deepEqual(submitted, { submitted: true });
  assert.equal(calls, 2);
  assert.deepEqual(slept, [5 * 60_000 + pauseRetry.marginMs], 'it waited until the named reset');

  calls = 0; slept.length = 0;
  await assert.rejects(submitThroughPause(async () => { calls++; throw refusal('2026-09-24T23:00:00.000Z'); }, { now: () => clock, sleep, report: () => {} }), /paused until 2026-09-24T23:00:00\.000Z.*complete waits at most 20 minutes/);
  assert.equal(calls, 1); assert.deepEqual(slept, [], 'a reset beyond the bound fails at once');

  calls = 0;
  await assert.rejects(submitThroughPause(async () => { calls++; throw refusal(new Date(clock + 1000).toISOString()); }, { now: () => clock, sleep, report: () => {} }), /paused until/);
  assert.equal(calls, pauseRetry.maxAttempts, 'repeated pauses are retried a bounded number of times');

  calls = 0;
  await assert.rejects(submitThroughPause(async () => { calls++; throw new Error('Lease epoch is stale'); }, { now: () => clock, sleep }), /Lease epoch is stale/);
  assert.equal(calls, 1, 'any other refusal fails at once');

  // Through the command itself: the same request, under the same idempotency key, after the reset.
  const command = leaseCommands.find(entry => entry.name === 'complete')!;
  const requests: { path: string; data: unknown; key?: string }[] = [], printed: any[] = [];
  const reset = new Date(Date.now() + 300).toISOString(), margin = pauseRetry.marginMs;
  pauseRetry.marginMs = 0;
  try {
    await command.run({ args: ['3', '42'], repositoryRoot: () => { throw new Error('no worktree'); }, print: (value: unknown) => printed.push(value),
      api: async (path: string, data: unknown, key?: string) => { requests.push({ path, data, key }); if (requests.length === 1) throw refusal(reset); return { key: 'GY-1', submitted: true }; } } as any, { id: 'work-1', key: 'GY-1' });
  } finally { pauseRetry.marginMs = margin; }
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.path === 'work/work-1/submit' && JSON.stringify(request.data) === JSON.stringify({ epoch: 3, pr: 42 })));
  assert.equal(requests[0].key, requests[1].key);
  assert.equal(printed[0].submitted, true);
});
