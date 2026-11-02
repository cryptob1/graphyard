import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { watchPorts, deployHealth } from '../src/cli/upgrade.js';
import { deployOnce, deployRecordPath, readDeployRecord } from '../src/deploy-watch.js';
import { defaultChildRun } from '../src/child-runner.js';
import { restartCause } from '../src/daemon/run.js';

const cliReleasePath = (directory: string, commit: string) => join(directory, 'deploy', 'releases', commit);
const activeCliRoot = (root: string) => realpath(join(root, '.graphyard', 'cli-current'));
const source = fileURLToPath(new URL('../', import.meta.url));
const modules = resolve(createRequire(import.meta.url).resolve('tsx'), '../../..');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test' } }).trim();

// Each fixture owns its tsx tree. Other unchanged dependencies may be shared, just as worker
// worktrees share dependencies; the failing installer removes only the candidate's own tree.
async function dependencies(root: string) {
  const target = join(root, 'node_modules');
  await mkdir(target, { recursive: true });
  for (const name of await readdir(modules)) {
    if (name === 'tsx') await cp(join(modules, name), join(target, name), { recursive: true });
    else await symlink(join(modules, name), join(target, name));
  }
}

function invoke(root: string, url: string) {
  const child = spawn(process.execPath, [join(root, 'bin/graphyard.mjs'), 'status'], {
    cwd: root, env: { ...process.env, GRAPHYARD_URL: url, GRAPHYARD_TOKEN: 'fixture-token' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
  return new Promise<{ code: number | null; out: string; err: string }>((accept, reject) => {
    child.once('error', reject); child.once('exit', code => accept({ code, out, err }));
  });
}

test('integration:deploy-stable-cli — real CLI loading survives delayed install, failed install, healthy handover and rollback; mismatches remain bounded refusals', async () => {
  const base = await temporaryDirectory('deploy-stable-cli');
  const checkout = join(base, 'checkout'), directory = join(base, 'config', 'owner-project');
  await mkdir(checkout); await mkdir(directory, { recursive: true });
  for (const name of ['src', 'bin']) await cp(join(source, name), join(checkout, name), { recursive: true });
  for (const name of ['package.json', 'package-lock.json']) await cp(join(source, name), join(checkout, name));
  await writeFile(join(checkout, '.gitignore'), 'node_modules/\n.graphyard/\n');
  git(checkout, 'init', '-q', '-b', 'main'); git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'A');
  const a = git(checkout, 'rev-parse', 'HEAD');
  const origin = join(base, 'origin.git'); git(base, 'clone', '-q', '--bare', checkout, origin); git(checkout, 'remote', 'add', 'origin', origin);
  await dependencies(checkout);
  // Also retain a legacy deploy/build CLI, the path workers used before this change.
  const legacy = join(directory, 'deploy', 'build');
  git(checkout, 'worktree', 'add', '--detach', '-q', legacy, a); await dependencies(legacy);
  const pusher = join(base, 'pusher'); git(base, 'clone', '-q', origin, pusher);
  const commit = async (name: string) => {
    await writeFile(join(pusher, 'release.txt'), name); git(pusher, 'add', 'release.txt'); git(pusher, 'commit', '-qm', name);
    const sha = git(pusher, 'rev-parse', 'HEAD'); git(pusher, 'push', '-q', 'origin', 'HEAD:main'); return sha;
  };
  // The fixture's source checkout stays on A even while origin advances.
  let served = a, healthy = true, apiCalls = 0;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.startsWith('/healthz')) response.end(JSON.stringify({ ok: true, healthy, version: `unreleased ${served.slice(0, 12)}`, commit: served, schema: 0 }));
    else { apiCalls++; response.end(JSON.stringify({ fixture: true, commit: served })); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await writeFile(join(directory, 'install.json'), JSON.stringify({ version: 1, installId: 'owner-project', repository: 'owner/project', provider: 'compose', baseBranch: 'main', createdAt: 'now', updatedAt: 'now' }));
  const previousHome = process.env.GRAPHYARD_CONFIG_HOME;
  process.env.GRAPHYARD_CONFIG_HOME = join(base, 'config');
  let releaseInstall!: () => void, started!: () => void, releaseBuild!: () => void, buildStarted!: () => void;
  let waitForInstall = Promise.resolve(), installStarted = Promise.resolve(), failInstall = false, unhealthy: string | null = null;
  let waitForBuild = Promise.resolve();
  const installs: string[] = [], restarts: string[] = [], previews: string[] = [];
  let pending: Promise<unknown> | undefined;
  try {
    const ports = await watchPorts({ cliRoot: checkout, repoRoot: checkout, repository: 'owner/project', url, run: async (command, args, options) => {
      // Recognize the predecessor's shell invocation too, so exercising the base fails
      // on its mutation of the active tree, without installing dependencies over the network.
      const oldInstall = command === 'sh' && /^npm ci --prefix "([^"]+)"$/.exec(args[1] ?? '');
      if (command === 'npm' || oldInstall) {
        const root = oldInstall ? oldInstall[1]! : args[args.indexOf('--prefix') + 1]!; installs.push(root); started?.();
        await waitForInstall;
        if (failInstall) {
          await mkdir(join(root, 'node_modules'), { recursive: true });
          await writeFile(join(root, 'node_modules', 'partial'), 'incomplete');
          // Real npm rejects a corrupt candidate lockfile, with no network or shared-tree writes.
          await writeFile(join(root, 'package-lock.json'), '{invalid');
          return defaultChildRun(command, [...args, '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], options);
        }
        await dependencies(root); return '';
      }
      if (command === process.execPath && args.includes('install')) {
        const root = resolve(args[2]!, '../..'), sha = git(root, 'rev-parse', 'HEAD');
        assert.ok(args.includes('--source-root') && args.includes(root), 'plan/apply builds the exact isolated source');
        if (args.includes('--plan')) previews.push(sha);
        else { buildStarted?.(); await waitForBuild; restarts.push(sha); served = sha; healthy = sha !== unhealthy; }
        return '';
      }
      if (command === 'docker') return '';
      return defaultChildRun(command, args, options);
    } });
    assert.notEqual(typeof ports, 'string'); if (typeof ports === 'string') throw new Error(ports);
    ports.health = deployHealth(checkout, url, 1, 0);
    const file = deployRecordPath(checkout);
    const check = async (root = legacy) => { const result = await invoke(root, url); assert.equal(result.code, 0, result.err); assert.equal(JSON.parse(result.out).commit, served); return result; };
    const oldLoader = await readFile(join(legacy, 'node_modules/tsx/dist/loader.mjs'));
    const oldSource = await readFile(join(legacy, 'src/cli/context.ts'));
    await check();
    const b = await commit('B');
    waitForInstall = new Promise(done => { releaseInstall = done; }); installStarted = new Promise(done => { started = done; });
    waitForBuild = new Promise(done => { releaseBuild = done; });
    const building = new Promise<void>(done => { buildStarted = done; });
    pending = deployOnce(file, ports, () => {}); await installStarted;
    assert.equal(git(legacy, 'rev-parse', 'HEAD'), a, 'the active legacy CLI source stays unchanged throughout install');
    for (let index = 0; index < 3; index++) await check();
    assert.equal(git(legacy, 'rev-parse', 'HEAD'), a); assert.equal(git(checkout, 'rev-parse', 'HEAD'), a);
    assert.deepEqual(await readFile(join(legacy, 'node_modules/tsx/dist/loader.mjs')), oldLoader);
    assert.deepEqual(await readFile(join(legacy, 'src/cli/context.ts')), oldSource);
    releaseInstall(); await building;
    for (let index = 0; index < 3; index++) await check();
    assert.deepEqual(await readFile(join(legacy, 'node_modules/tsx/dist/loader.mjs')), oldLoader);
    assert.deepEqual(await readFile(join(legacy, 'src/cli/context.ts')), oldSource);
    releaseBuild(); assert.equal(await pending, 'deployed');
    assert.equal(await activeCliRoot(legacy), cliReleasePath(directory, b)); await check(); await check(checkout);
    assert.match(restartCause({ credentialFile: join(base, 'token'), cliPath: join(legacy, 'bin/graphyard.mjs') }, checkout, a) ?? '', /deploy unit serves/);
    assert.equal(await ports.head(), b); assert.deepEqual(previews, [b]);

    const c = await commit('C'); failInstall = true;
    const restartsBefore = restarts.length;
    assert.equal(await deployOnce(file, ports, () => {}), 'rolled-back');
    assert.equal(restarts.length, restartsBefore, 'failed dependency install never restarts the healthy server');
    assert.equal(readDeployRecord(file)?.tip, b); assert.equal(readDeployRecord(file)?.failed, c);
    assert.match(readDeployRecord(file)?.reason ?? '', /build failed:.*npm/);
    for (let index = 0; index < 3; index++) await check();
    assert.equal(await activeCliRoot(legacy), cliReleasePath(directory, b));

    failInstall = false; const d = await commit('D'); unhealthy = d;
    assert.equal(await deployOnce(file, ports, () => {}), 'rolled-back');
    assert.equal(served, b); assert.equal(await activeCliRoot(legacy), cliReleasePath(directory, b)); await check();
    assert.equal(installs.filter(path => path === cliReleasePath(directory, b)).length, 1, 'rollback reuses retained dependencies');
    assert.deepEqual(await readFile(join(legacy, 'node_modules/tsx/dist/loader.mjs')), oldLoader);
    assert.deepEqual(await readFile(join(legacy, 'src/cli/context.ts')), oldSource);

    // During server/CLI publication skew, only retries occur. They reload the pointer.
    const e = await commit('E'); await ports.fetch(); await ports.build(e); served = e; healthy = true;
    const during = invoke(legacy, url);
    await new Promise(done => setTimeout(done, 900)); await ports.checkout(e);
    const handedOver = await during; assert.equal(handedOver.code, 0, handedOver.err); assert.match(handedOver.err, /release handover: retry/);
    const callsBefore = apiCalls; served = 'f'.repeat(40);
    const mismatch = await invoke(legacy, url);
    assert.equal(mismatch.code, 1); assert.match(mismatch.err, /CLI commit .* and server commit .* differ/);
    assert.equal((mismatch.err.match(/release handover: retry/g) ?? []).length, 3);
    assert.equal(apiCalls, callsBefore, 'true mismatch never reaches the API');
  } finally {
    releaseInstall?.(); releaseBuild?.();
    await pending?.catch(() => {});
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    if (previousHome === undefined) delete process.env.GRAPHYARD_CONFIG_HOME; else process.env.GRAPHYARD_CONFIG_HOME = previousHome;
  }
});
