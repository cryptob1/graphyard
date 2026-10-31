import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialMaskFor, credentialMaskWords, coordinatorConfinement, readOnlyMountWrapper, sessionMountNamespaceWorks } from '../src/master/profiles.js';
import { masterConfigSchema, runtimeLoginHomes } from '../src/master/profiles.js';
import { headlessConfinementWrapper, prepareConfinedGitPaths } from '../src/master/launch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1856: a confined session must not read the operator's credential locations. The read-only
// mount that keeps the coordinator checkout unwritable hid none of them — the Huck migration PM
// read a collector credential's path straight through the worker wrapper — so the wrapper now
// masks the operator config home with an empty tmpfs, with every credential path the install
// records beside it (the coordinator credential, the merge writer's deploy key, an upstream
// credential, the per-install `confinement.maskPaths` list), and re-exposes only the session's
// own token file and runtime login home. The worker's own work keeps working: its token is
// readable, its runtime login is writable, and git status, git commit, `graphyard sync` and the
// repository's test command succeed in its worktree.

const coordinatorSecret = 'coordinator-secret-'.padEnd(48, 'x');
const otherSecret = 'other-install-secret-'.padEnd(48, 'x');
const deploySecret = 'deploy-key-secret-'.padEnd(48, 'x');
const collectorSecret = 'collector-secret-'.padEnd(48, 'x');
const ownToken = 'worker-own-token-'.padEnd(40, 'x');

/** A coordinator checkout with a linked assignment worktree, an operator config home holding the install's credentials, and the recorded credential paths beside it. */
function fixture(base: string) {
  const root = join(base, 'coordinator');
  const run = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 1;\n');
  run('init', '-b', 'main');
  run('config', 'user.email', 'graphyard@localhost');
  run('config', 'user.name', 'Graphyard');
  run('add', '.');
  run('commit', '-m', 'coordinator');
  const worktree = join(root, '.graphyard', 'worktrees', 'gy-1856-1');
  mkdirSync(dirname(worktree), { recursive: true });
  run('worktree', 'add', '-b', 'graphyard/gy-1856-1', worktree, 'main');
  execFileSync('git', ['-C', worktree, 'config', 'user.email', 'w@t']);
  execFileSync('git', ['-C', worktree, 'config', 'user.name', 'Worker']);
  // The fixture repository's own test command, committed, so a confined `npm test` runs it.
  writeFileSync(join(worktree, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node test.js' } }, null, 2));
  writeFileSync(join(worktree, 'test.js'), 'console.log(\'the fixture test passes\');\n');
  execFileSync('git', ['-C', worktree, 'add', '.']);
  execFileSync('git', ['-C', worktree, 'commit', '-qm', 'the branch own change']);
  // The base tip the supported sync merges, as the merge writer advances it: nothing is fetched.
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'advance.md'), 'advanced on main\n');
  run('add', '.');
  run('commit', '-m', 'advance main');
  run('update-ref', 'refs/remotes/origin/main', run('rev-parse', 'HEAD'));
  prepareConfinedGitPaths(root);
  // The operator config home, with two installs' directories, the worker's own token, a recorded
  // deployment credential outside it, and a configured mask path — each with a secret in it.
  const configHome = join(base, 'config-home'), ownCredentialFile = join(configHome, 'workers', 'worker-a.token');
  const coordinatorCredential = join(configHome, 'install-a', 'masters', 'coordinator.token');
  const otherInstall = join(configHome, 'install-b', 'tokens', 'other-principal.token');
  const deployKey = join(base, 'deploy', 'deploy-key');
  const collectorCredential = join(base, 'collector', 'collector.token');
  const runtimeHome = join(base, 'runtime-home');
  for (const file of [coordinatorCredential, otherInstall, ownCredentialFile, deployKey, collectorCredential]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${file === ownCredentialFile ? ownToken : file === coordinatorCredential ? coordinatorSecret : file === otherInstall ? otherSecret : file === deployKey ? deploySecret : collectorSecret}\n`, { mode: 0o600 }); }
  mkdirSync(runtimeHome, { recursive: true });
  writeFileSync(join(runtimeHome, 'cli-config.json'), '{"authInfo":{"userId":"own-login"}}\n', { mode: 0o600 });
  const config = {
    credentialFile: coordinatorCredential,
    run: { mergeWriter: { deployKeyFile: deployKey } },
    confinement: { maskPaths: [collectorCredential] },
  };
  const mask = credentialMaskFor(config, { credentialFile: ownCredentialFile, runtimeHomes: [runtimeHome] }, configHome);
  return { root, worktree, base, configHome, coordinatorCredential, otherInstall, deployKey, collectorCredential, ownCredentialFile, runtimeHome, mask };
}

test('unit:credential-mask-covers-recorded-credential-locations — the mask gathers the config home, every recorded credential path, and keeps only the session\'s own', async () => {
  const base = await temporaryDirectory('credential mask units');
  try {
    const configHome = join(base, 'config-home'), deployed = join(base, 'deploy', 'deploy-key'), collector = join(base, 'collector', 'collector.token');
    for (const file of [join(configHome, 'masters', 'x.token'), deployed, collector]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'x'.repeat(40), { mode: 0o600 }); }
    const mask = credentialMaskFor({
      credentialFile: join(configHome, 'masters', 'x.token'),
      run: { mergeWriter: { deployKeyFile: deployed } },
      upstream: { url: 'https://upstream.example', credentialFile: collector },
      confinement: { maskPaths: [collector, 'relative/path'] },
    }, { credentialFile: join(configHome, 'workers', 'own.token'), runtimeHomes: [join(base, 'home')] }, configHome);
    assert.equal(mask.configHome, configHome, 'the operator config home is the override');
    assert.deepEqual(mask.extraPaths, [join(configHome, 'masters', 'x.token'), deployed, collector, collector], 'every recorded credential path is gathered, relative entries dropped');
    assert.deepEqual(mask.own, [join(configHome, 'workers', 'own.token'), join(base, 'home')], 'the session\'s own token and runtime login are kept');
    // A relative own path is never kept.
    assert.deepEqual(credentialMaskFor({}, { credentialFile: 'relative/token' }, configHome).own, [], 'a relative own path is not kept');
    // Without an override, the operator config home comes from GRAPHYARD_CONFIG_HOME, else ~/.config/graphyard.
    const saved = process.env.GRAPHYARD_CONFIG_HOME;
    try {
      process.env.GRAPHYARD_CONFIG_HOME = join(base, 'from-env');
      assert.equal(credentialMaskFor({}, {}).configHome, join(base, 'from-env'), 'GRAPHYARD_CONFIG_HOME names the config home');
      delete process.env.GRAPHYARD_CONFIG_HOME;
      assert.match(credentialMaskFor({}, {}).configHome, /[/]\.config[/]graphyard$/, 'the default is ~/.config/graphyard');
    } finally { if (saved === undefined) delete process.env.GRAPHYARD_CONFIG_HOME; else process.env.GRAPHYARD_CONFIG_HOME = saved; }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('unit:credential-mask-words — a location that exists is masked at the directory that holds it, and nothing broad or protected is', async () => {
  const base = await temporaryDirectory('credential mask words');
  try {
    const configHome = join(base, 'config-home');
    const token = join(configHome, 'install-a', 'masters', 'coordinator.token'), beside = join(configHome, 'install-a', 'masters', 'other.token');
    mkdirSync(dirname(token), { recursive: true });
    writeFileSync(token, 'x'.repeat(40)); writeFileSync(beside, 'x'.repeat(40));
    const outside = join(base, 'collector', 'collector.token');
    mkdirSync(dirname(outside)); writeFileSync(outside, 'x'.repeat(40));
    const mask = { configHome, extraPaths: [token, beside, outside, join(base, 'gone', 'x.token')], own: [] };
    assert.deepEqual(credentialMaskWords(mask, [join(base, 'coordinator')]),
      ['--tmpfs', configHome, '--tmpfs', join(base, 'collector')], 'the config home and each recorded path\'s directory are masked once; two files in one directory mask it once; a stale recorded path hides nothing');
    // A candidate that would hide the checkout or the session directory is dropped wholesale.
    assert.deepEqual(credentialMaskWords({ configHome: base, extraPaths: [], own: [] }, [join(base, 'coordinator')]), [], 'a mask that would hide the checkout is dropped');
    assert.deepEqual(credentialMaskWords({ configHome, extraPaths: [join(configHome, 'x')], own: [] }, [configHome]), [], 'a session directory under the config home keeps it unmasked');
    // A missing config home masks nothing, and `/` is never masked.
    assert.deepEqual(credentialMaskWords({ configHome: join(base, 'missing'), extraPaths: [], own: [] }, []), [], 'a missing config home masks nothing');
    assert.deepEqual(credentialMaskWords({ configHome: '/', extraPaths: ['/'], own: [] }, []), [], '/ is never masked');
    // The schema accepts the per-install list and refuses a relative entry.
    const master = { version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: '/bin/graphyard.mjs', repository: 'owner/project', baseBranch: 'main', githubAppId: 0, hostId: 'h', masterAgentName: 'graphyard-master-project' };
    assert.deepEqual(masterConfigSchema.parse({ ...master, confinement: { maskPaths: [outside] } }).confinement, { maskPaths: [outside] }, 'master.json parses the per-install mask list');
    assert.throws(() => masterConfigSchema.parse({ ...master, confinement: { maskPaths: ['relative/token'] } }), /absolute/, 'a relative mask path is refused');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('unit:worker-wrapper-masks-credentials — the read-only mount hides the credential locations and re-exposes the session\'s own last', async () => {
  const base = await temporaryDirectory('credential mask wrapper');
  try {
    const f = fixture(base);
    const wrapper = readOnlyMountWrapper({ coordinatorRoot: f.root, sessionDirectory: f.worktree, bwrap: 'bwrap' });
    assert.ok(!wrapper.includes(f.configHome) && !wrapper.includes(join(f.base, 'deploy')), 'without a mask no credential location is hidden');
    const masked = readOnlyMountWrapper({ coordinatorRoot: f.root, sessionDirectory: f.worktree, bwrap: 'bwrap', credentialMask: f.mask });
    assert.ok(masked.includes(f.configHome), 'the wrapper hides the operator config home');
    assert.ok(masked.includes(join(f.base, 'deploy')), 'the recorded deployment credential path is hidden at its directory');
    assert.ok(masked.includes(join(f.base, 'collector')), 'the configured mask path is hidden at its directory');
    const configIdx = masked.indexOf(f.configHome);
    assert.ok(configIdx > 0 && masked[configIdx - 1] === '--tmpfs', 'the config home is masked with an empty tmpfs');
    const ownIdx = masked.indexOf(f.ownCredentialFile);
    assert.ok(ownIdx > configIdx && masked[ownIdx - 1] === '--ro-bind', 'the session\'s own token is re-exposed read-only after the masks');
    const homeIdx = masked.indexOf(f.runtimeHome);
    assert.ok(homeIdx > configIdx && masked[homeIdx - 1] === '--bind', 'the session\'s own runtime login home is re-exposed writable after the masks');
    assert.equal(masked.at(-1), '--');
    // The master session carries no mask: it acts as the coordinator identity and reads its credential.
    const master = readOnlyMountWrapper({ coordinatorRoot: f.root, sessionDirectory: f.root, bwrap: 'bwrap' });
    assert.ok(!master.some((word, index) => word === '--tmpfs' && master[index + 1] === f.configHome), 'the master session keeps the coordinator credential readable');
    // The headless producer run carries the same mask through its runner.
    const headless = headlessConfinementWrapper(f.root, f.worktree, 'bwrap', f.mask);
    assert.ok(headless.includes(f.configHome), 'the headless run hides the operator config home too');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('integration:worker-credential-paths-denied — under the actual worker confinement the coordinator credential, another install\'s directory, a recorded deployment credential and a configured mask path are each unreadable, and no secret value is reachable', async () => {
  const base = await temporaryDirectory('credential mask denied');
  try {
    const f = fixture(base);
    const confinement = await coordinatorConfinement({ kind: 'pi', args: [], coordinatorRoot: f.root, sessionDirectory: f.worktree, platform: 'linux', mountNamespaceWorks: true, bwrap: 'bwrap', credentialMask: f.mask });
    assert.ok(confinement, 'the worker launch carries a confinement');
    assert.equal(confinement.mechanism, 'read-only-mount');
    if (process.platform !== 'linux') return;
    assert.ok(await sessionMountNamespaceWorks(), 'mount namespaces work on this Linux host');
    const probe = [
      'for path in "$1" "$2" "$3" "$4"; do',
      '  if test -r "$path"; then echo "READABLE $path"; else echo "DENIED $path"; fi',
      'done',
      'if ls "$5" >/dev/null 2>&1 && ! test -e "$5/install-a" && ! test -e "$5/install-b"; then echo "CONFIG-HOME-CREDENTIALS-GONE"; else echo "CONFIG-HOME-LISTED"; fi',
    ].join('\n');
    const run = spawnSync(confinement.wrapper[0], [...confinement.wrapper.slice(1, -1), '/bin/sh', '-c', probe, 'sh',
      f.coordinatorCredential, f.otherInstall, f.deployKey, f.collectorCredential, f.configHome],
      { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
    assert.equal(run.status, 0, `the confined probe ran: ${run.stderr}`);
    const output = run.stdout + '\n' + run.stderr;
    for (const [path, what] of [[f.coordinatorCredential, 'the coordinator credential'], [f.otherInstall, 'another install\'s directory'], [f.deployKey, 'the recorded deployment credential'], [f.collectorCredential, 'the configured mask path']] as [string, string][])
      assert.ok(run.stdout.includes(`DENIED ${path}`), `${what} is not readable under the confinement`);
    assert.ok(run.stdout.includes('CONFIG-HOME-CREDENTIALS-GONE'), `the operator config home holds no install under the confinement: ${output.slice(0, 400)}`);
    // No secret value is reachable: the probe output, and every read the probe attempted, hold none.
    for (const secret of [coordinatorSecret, otherSecret, deploySecret, collectorSecret])
      assert.ok(!output.includes(secret), 'no secret value appears in the probe output');
    for (const marker of ['READABLE', 'CONFIG-HOME-LISTED']) assert.ok(!run.stdout.includes(marker), marker);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('integration:worker-own-credentials-work — under the same confinement the worker\'s own runtime login and token are readable, and git status, git commit, graphyard sync and the repository\'s test command succeed in its worktree', async () => {
  const base = await temporaryDirectory('credential mask own work');
  try {
    const f = fixture(base);
    const confinement = await coordinatorConfinement({ kind: 'pi', args: [], coordinatorRoot: f.root, sessionDirectory: f.worktree, platform: 'linux', mountNamespaceWorks: true, bwrap: 'bwrap', credentialMask: f.mask });
    assert.ok(confinement, 'the worker launch carries a confinement');
    if (process.platform !== 'linux') return;
    assert.ok(await sessionMountNamespaceWorks(), 'mount namespaces work on this Linux host');
    // The supported sync, as an integration test runs it inside the worker confinement: the real
    // syncWork flow against this worktree, with the control-plane reads stubbed.
    const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
    writeFileSync(join(base, 'sync-driver.mjs'), [
      `import { syncWork } from ${JSON.stringify(join(checkout, 'src', 'cli', 'workspace.js'))};`,
      'const tree = process.env.WORKER_TREE, key = process.env.WORKER_KEY;',
      'process.chdir(tree);',
      'const status = { baseBranch: \'main\' };',
      'const work = { key, workspaces: [{ epoch: 1, branch: process.env.WORKER_BRANCH, host: \'test-host\', path: tree }], lease: { epoch: 1 } };',
      'const printed = [];',
      'await syncWork({ api: async () => status, print: value => printed.push(value) }, work);',
      'console.log(`WORKER-SYNC ${JSON.stringify(printed.at(-1))}`);',
    ].join('\n'));
    const script = [
      // The session's own credential and runtime login: readable, and the login writable.
      'test -r "$2" && test "$(cat "$2")" = "$3" && echo OWN-TOKEN-READABLE || echo OWN-TOKEN-DENIED',
      'test -r "$4/cli-config.json" && echo LOGIN-READABLE || echo LOGIN-DENIED',
      'touch "$4/launch-state" && echo LOGIN-WRITABLE || echo LOGIN-NOTWRITABLE',
      // The worktree's own work: status, a change, a commit.
      'git -C "$1" status --porcelain >/dev/null && echo GIT-STATUS-OK || echo GIT-STATUS-FAILED',
      'printf \'worker change\\n\' > "$1/src/worker.ts" && git -C "$1" add src/worker.ts && git -C "$1" commit -qm "the worker change" && echo GIT-COMMIT-OK || echo GIT-COMMIT-FAILED',
      // graphyard sync: merges the shared base tip and commits, inside the confinement. The driver
      // runs from this checkout, whose node_modules carry tsx; everything it writes goes to the
      // worktree and its admin directory.
      'cd "$5" || exit 9',
      'WORKER_TREE="$1" WORKER_KEY=GY-1856 WORKER_BRANCH=graphyard/gy-1856-1 node --import tsx "' + join(base, 'sync-driver.mjs') + '" || echo SYNC-FAILED',
      // The repository's test command, in the worktree, inside the confinement.
      'cd "$1" || exit 9',
      'HOME="$1/.npm-home" npm_config_cache="$1/.npm-cache" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false npm test || echo TEST-COMMAND-FAILED',
    ].join('\n');
    const run = spawnSync(confinement.wrapper[0], [...confinement.wrapper.slice(1, -1), '/bin/sh', '-c', script, 'sh', f.worktree, f.ownCredentialFile, ownToken, f.runtimeHome, checkout],
      { encoding: 'utf8', timeout: 240_000, killSignal: 'SIGKILL' });
    assert.equal(run.status, 0, `the confined worker ran: ${run.stderr}`);
    const output = run.stdout + '\n' + run.stderr;
    for (const marker of ['OWN-TOKEN-READABLE', 'LOGIN-READABLE', 'LOGIN-WRITABLE', 'GIT-STATUS-OK', 'GIT-COMMIT-OK'])
      assert.ok(run.stdout.includes(marker), `${marker}: ${output.slice(0, 400)}`);
    assert.ok(/the fixture test passes/.test(output), `the repository's test command ran: ${output.slice(-600)}`);
    assert.ok(!/npm error/.test(output), `npm test failed: ${output.slice(-600)}`);
    const syncs = [...run.stdout.matchAll(/^WORKER-SYNC (.*)$/gm)].map(match => JSON.parse(match[1]));
    assert.equal(syncs.length, 1, `the sync reported once: ${output.slice(0, 400)}`);
    assert.equal(syncs[0].ok, true, `graphyard sync succeeds: ${JSON.stringify(syncs[0])}`);
    assert.equal(syncs[0].merged, true, 'the sync merged the base tip');
    assert.ok(existsSync(join(f.worktree, 'docs', 'advance.md')), 'the base tip landed in the worktree');
    for (const marker of ['OWN-TOKEN-DENIED', 'LOGIN-DENIED', 'LOGIN-NOTWRITABLE', 'GIT-STATUS-FAILED', 'GIT-COMMIT-FAILED', 'SYNC-FAILED', 'TEST-COMMAND-FAILED', 'Read-only file system'])
      assert.ok(!output.includes(marker), marker);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
