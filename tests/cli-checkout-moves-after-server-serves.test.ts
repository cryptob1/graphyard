import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyInstall, buildPlan, installRequestFromArgs, prepareInstall } from '../src/install/index.js';
import { gitWatchPorts, watchPorts } from '../src/cli/upgrade.js';
import { deployRecordPath, readDeployRecord, watchMain, type DeployWatchPorts } from '../src/deploy-watch.js';
import { defaultChildRun } from '../src/child-runner.js';
import { harness } from './install-harness.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2978: a deploy pass moves the watched checkout — the workers' CLI checkout when the unit watches
// it — only after the new server passed health and serves the same commit; the server deploys from
// the install's own build worktree, and a failed server deploy leaves the CLI checkout where it was.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const head = (checkout: string) => git(checkout, 'rev-parse', 'HEAD');
const short = (sha: string) => sha.slice(0, 7);

/** An origin, a second clone that pushes to it, and the CLI checkout the deploy unit watches, at commit A. */
async function repositories(label: string, seed?: (pusher: string) => Promise<void>) {
  const base = await temporaryDirectory(label);
  const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), checkout = join(base, 'checkout');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, pusher);
  if (seed) { await seed(pusher); git(pusher, 'add', '-A'); git(pusher, 'commit', '-q', '-m', 'A'); git(pusher, 'push', '-q', 'origin', 'HEAD:main'); }
  else { await writeFile(join(pusher, 'release.txt'), 'A'); git(pusher, 'add', '.'); git(pusher, 'commit', '-q', '-m', 'A'); git(pusher, 'push', '-q', 'origin', 'HEAD:main'); }
  const commit = async (name: string) => { await writeFile(join(pusher, 'release.txt'), name); git(pusher, 'add', '.'); git(pusher, 'commit', '-q', '-m', name); git(pusher, 'push', '-q', 'origin', 'HEAD:main'); return git(pusher, 'rev-parse', 'HEAD'); };
  const a = git(pusher, 'rev-parse', 'HEAD');
  git(base, 'clone', '-q', origin, checkout);
  git(checkout, 'checkout', '-q', '--detach', a);
  return { checkout, commit, a };
}

test('unit:cli-checkout-moves-after-server-serves — a deploy pass builds and restarts the server while the CLI checkout holds the old commit, moves the checkout once health passes, and leaves it on the old commit when health fails', async () => {
  const { checkout, commit, a } = await repositories('cli-checkout-deploy');
  const b = await commit('B');
  let served = a, refused: string | null = null;
  const server = createHttpServer((request, response) => {
    const ok = served !== refused;
    response.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok, healthy: ok, commit: served }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const tree = gitWatchPorts(checkout, 'main', defaultChildRun);
  const samples: string[] = [];
  const ports: DeployWatchPorts = {
    ...tree,
    checkout: async sha => { samples.push(`checkout ${short(sha)} @ ${short(head(checkout))}`); await tree.checkout(sha); },
    build: async sha => { samples.push(`build ${short(sha)} @ ${short(head(checkout))}`); },
    restart: async sha => { samples.push(`restart ${short(sha)} @ ${short(head(checkout))}`); served = sha; },
    health: async sha => {
      samples.push(`health ${short(sha)} @ ${short(head(checkout))}`);
      const response = await fetch(`${url}/healthz`), body = await response.json() as { ok: boolean; commit: string };
      if (!response.ok || !body.ok || body.commit !== sha) throw new Error(`health failed: /healthz answered ${response.status} for ${body.commit.slice(0, 7)}`);
    },
    pin: async sha => { samples.push(`pin ${short(sha)} @ ${short(head(checkout))}`); },
    prune: async () => {},
    schema: async () => 7, database: async () => 7,
  };
  const root = await temporaryDirectory('cli-checkout-record'), file = deployRecordPath(root);
  try {
    // The server reports the new commit healthy only after the restart, and the checkout moves then — never before.
    await watchMain(file, ports, { intervalMs: 1000, once: true, log: () => {} });
    assert.deepEqual(samples, [`build ${short(b)} @ ${short(a)}`, `restart ${short(b)} @ ${short(a)}`, `health ${short(b)} @ ${short(a)}`, `checkout ${short(b)} @ ${short(a)}`, `pin ${short(b)} @ ${short(b)}`],
      'the CLI checkout holds the old commit through build, restart and health, and is moved only before the pin that follows');
    assert.equal(head(checkout), b, 'the checkout is on the new tip after the server serves it');
    assert.equal(readDeployRecord(file)?.tip, b);

    // A server deploy that fails health rolls back, and the CLI checkout stays on the commit the server went back to.
    const c = await commit('C');
    refused = c;
    samples.length = 0;
    await watchMain(file, ports, { intervalMs: 1000, once: true, log: () => {} });
    assert.deepEqual(samples, [`build ${short(c)} @ ${short(b)}`, `restart ${short(c)} @ ${short(b)}`, `health ${short(c)} @ ${short(b)}`, `build ${short(b)} @ ${short(b)}`, `restart ${short(b)} @ ${short(b)}`, `health ${short(b)} @ ${short(b)}`, `checkout ${short(b)} @ ${short(b)}`, `pin ${short(b)} @ ${short(b)}`],
      'the failed deploy never moved the CLI checkout, and the rollback finds it already on the old commit');
    assert.equal(head(checkout), b, 'the CLI checkout stays on the old commit');
    assert.deepEqual([readDeployRecord(file)?.tip, readDeployRecord(file)?.failed], [b, c]);
  } finally { server.close(); }
});

test('unit:deploy-builds-from-its-own-worktree — a watch pass over a fixture install redeploys from the install\'s build worktree at the new commit while the watched checkout still holds the old one, then moves the checkout and npm-cis it', async () => {
  const fixture = await harness({ provider: 'compose', serverUrl: 'http://127.0.0.1:4310' });
  const saved = { configHome: process.env.GRAPHYARD_CONFIG_HOME, testCli: process.env.GRAPHYARD_TEST_CLI, testLog: process.env.GRAPHYARD_TEST_REDEPLOY_LOG };
  process.env.GRAPHYARD_CONFIG_HOME = fixture.configHome;
  try {
    const session = await prepareInstall(fixture.root, installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--apply']).request, fixture.deps, 'apply');
    await applyInstall(session, await buildPlan(session));

    // The watched CLI checkout, and the redeploy CLI the plan runs: a committed stub that records each
    // invocation with the watched checkout's HEAD at that moment. The fixture's one file: dependency
    // makes every npm ci observable without a registry.
    const { checkout, commit, a } = await repositories('deploy-build-worktree', async pusher => {
      await writeFile(join(pusher, 'package.json'), JSON.stringify({ name: 'fixture', private: true, version: '1.0.0', dependencies: { 'fixture-lib': 'file:vendor/fixture-lib' } }));
      await mkdir(join(pusher, 'vendor/fixture-lib'), { recursive: true });
      await writeFile(join(pusher, 'vendor/fixture-lib/package.json'), JSON.stringify({ name: 'fixture-lib', version: '1.0.0' }));
      await mkdir(join(pusher, 'bin'), { recursive: true });
      await writeFile(join(pusher, 'bin', 'graphyard.mjs'), `import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const cliHead = () => { try { return execFileSync('git', ['-C', process.env.GRAPHYARD_TEST_CLI, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unreadable'; } };
appendFileSync(process.env.GRAPHYARD_TEST_REDEPLOY_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), cliHead: cliHead() }) + '\\n');
`);
      execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], { cwd: pusher, stdio: 'ignore' });
    });
    const log = join(await temporaryDirectory('deploy-build-log'), 'redeploys.jsonl');
    process.env.GRAPHYARD_TEST_CLI = checkout;
    process.env.GRAPHYARD_TEST_REDEPLOY_LOG = log;
    const b = await commit('B');

    const server = createHttpServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, healthy: true, version: `unreleased ${b.slice(0, 12)}` }));
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const repoRoot = await temporaryDirectory('deploy-build-repo'), file = deployRecordPath(repoRoot);
    const ports = await watchPorts({ cliRoot: checkout, repoRoot, repository: 'owner/project', baseBranch: 'main', url, run: defaultChildRun });
    if (typeof ports === 'string') throw new Error(ports);
    ports.prune = async () => {};
    try {
      await watchMain(file, ports, { intervalMs: 1000, once: true, log: () => {} });
      const build = join(fixture.configHome, 'owner-project', 'deploy', 'build');
      assert.equal(readDeployRecord(file)?.tip, b, 'the new tip is recorded as served');
      assert.equal(head(checkout), b, 'the watched checkout moved to the new tip');
      assert.ok(existsSync(join(build, '.git')), 'the build worktree exists under the install directory');
      assert.equal(head(build), b, 'the build worktree holds the deployed commit');
      assert.ok(existsSync(join(build, 'node_modules', 'fixture-lib')), 'the build worktree holds the dependencies npm ci installed');
      assert.ok(existsSync(join(checkout, 'node_modules', 'fixture-lib')), 'the watched checkout was npm-ci-ed after it moved');
      const redeploys = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { args: string[]; cwd: string; cliHead: string });
      assert.equal(redeploys.length, 2, 'the redeploy ran its --plan preview and its --apply');
      for (const invocation of redeploys) {
        assert.equal(invocation.cliHead, a, 'the redeploy ran while the watched checkout still held the old commit');
        assert.equal(invocation.args[invocation.args.indexOf('--source-root') + 1], build, 'the image builds from the install\'s build worktree, never from the watched checkout');
      }
      assert.ok(redeploys[1].args.includes('--apply'), 'the second invocation applies');
    } finally { server.close(); }
  } finally {
    for (const [name, value] of [['GRAPHYARD_CONFIG_HOME', saved.configHome], ['GRAPHYARD_TEST_CLI', saved.testCli], ['GRAPHYARD_TEST_REDEPLOY_LOG', saved.testLog]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await fixture.cleanup();
  }
});
