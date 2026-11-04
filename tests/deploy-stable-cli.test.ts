import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { credentialMaskFor, readOnlyMountWrapper } from '../src/master/confinement.js';
import { createRequire } from 'node:module';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { watchPorts, deployHealth } from '../src/cli/upgrade.js';
import { deployOnce, deployRecordPath, readDeployRecord } from '../src/deploy-watch.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { alignLoopUnit, deployUnitText, loopUnitText } from '../src/supervisor.js';
import { perInstallUnits, deployUnitOf } from '../src/install/units.js';
import { masterConfigSchema } from '../src/master.js';
import { restartCause } from '../src/daemon/run.js';

const cliReleasePath = (directory: string, commit: string) => join(directory, 'deploy', 'build', '.graphyard', 'cli-releases', commit);
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

async function maskedSession(root: string, checkout: string, config: string, credential: string, legacy = false) {
  const mask = credentialMaskFor({ cliPath: join(root, 'bin/graphyard.mjs') }, {}, config);
  // Reproduce a session launched by the predecessor: it exposes only its original checkout.
  if (legacy) mask.cli = [root];
  const wrapper = readOnlyMountWrapper({ coordinatorRoot: checkout, sessionDirectory: checkout, credentialMask: mask, secretsBus: null });
  const driver = `
    const fs = require('node:fs'), { execFile } = require('node:child_process');
    try { fs.readFileSync(process.argv[1]); console.log('CREDENTIAL-EXPOSED'); } catch { console.log('CREDENTIAL-HIDDEN'); }
    try { fs.writeFileSync(process.argv[2] + '/write-probe', 'bad'); console.log('CLI-WRITABLE'); } catch { console.log('CLI-READ-ONLY'); }
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      execFile(process.execPath, [process.argv[2] + '/bin/graphyard.mjs', 'status'], { env: { ...process.env, GRAPHYARD_URL: line, GRAPHYARD_TOKEN: 'fixture-token' } },
        (error, out, err) => console.log(JSON.stringify({ code: error ? error.code : 0, out, err })));
    });`;
  const child = spawn(wrapper[0]!, [...wrapper.slice(1), process.execPath, '-e', driver, credential, root], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  assert.equal((await lines.next()).value, 'CREDENTIAL-HIDDEN', stderr);
  assert.equal((await lines.next()).value, 'CLI-READ-ONLY', stderr);
  return {
    async invoke(url: string) {
      child.stdin.write(url + '\n');
      const line = await lines.next();
      assert.ok(!line.done, stderr);
      return JSON.parse(line.value) as { code: number; out: string; err: string };
    },
    async close() { child.stdin.end(); await new Promise<void>(done => child.once('exit', () => done())); },
  };
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

// The actual CLI command runs in another process, so replacing its source cannot
// replace already-loaded predecessor functions. Only host effects cross the IPC bridge.
function watcher(root: string, run: ChildRun) {
  const child = spawn(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'),
    join(root, 'src/cli.ts'), 'upgrade', '--watch', '--checkout', root], {
    cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  let ready!: () => void, deployed!: () => void;
  const started = new Promise<void>(done => { ready = done; });
  const serving = new Promise<void>(done => { deployed = done; });
  child.stderr!.on('data', data => { stderr += data; if (stderr.includes('[graphyard-deploy] serving ')) deployed(); });
  child.on('message', async (message: any) => {
    if (message.kind !== 'run') return;
    try {
      const value = await run(message.command, message.args, message.options);
      child.send({ id: message.id, value });
      if (message.command === 'git' && message.args.join(' ') === `-C ${root} rev-parse HEAD`) ready();
    } catch (error) { child.send({ id: message.id, error: String(error) }); }
  });
  const exited = new Promise<void>(done => child.once('exit', () => done()));
  const unexpected = exited.then(() => { throw new Error(`watcher exited before completing: ${stderr}`); });
  // Each race consumes the exit rejection, including during normal test cleanup.
  const startup = Promise.race([started, unexpected]), publication = Promise.race([serving, unexpected]);
  void startup.catch(() => {}); void publication.catch(() => {});
  return { started: startup, serving: publication,
    async stop() { child.kill('SIGTERM'); await exited; }, pid: child.pid };
}

test('integration:deploy-stable-cli — real CLI loading survives delayed install, failed install, healthy handover and rollback; mismatches remain bounded refusals', async () => {
  const base = await temporaryDirectory('deploy-stable-cli');
  const configHome = join(base, "operator's config");
  const checkout = join(base, 'checkout'), directory = join(configHome, 'owner-project');
  await mkdir(checkout); await mkdir(directory, { recursive: true });
  for (const name of ['src', 'bin']) await cp(join(source, name), join(checkout, name), { recursive: true });
  for (const name of ['package.json', 'package-lock.json']) await cp(join(source, name), join(checkout, name));
  // Keep the test IPC channel until the real command finishes its graceful stop.
  const entry = join(checkout, 'src/cli.ts');
  await writeFile(entry, (await readFile(entry, 'utf8')).replace('main().catch(', 'main().finally(() => { if (process.connected) process.disconnect(); }).catch('));
  await cp(join(checkout, 'src/child-runner.ts'), join(checkout, 'src/child-runner-real.ts'));
  await writeFile(join(checkout, 'src/child-runner.ts'), `
    export * from './child-runner-real.js';
    import { defaultChildRun as real } from './child-runner-real.js';
    let sequence = 0;
    const pending = new Map();
    if (process.send) process.on('message', message => {
      const call = pending.get(message.id); if (!call) return;
      pending.delete(message.id); message.error ? call.reject(new Error(message.error)) : call.resolve(message.value);
    });
    export const defaultChildRun = (command, args, options) => !process.send ? real(command, args, options) : new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject }); process.send({ kind: 'run', id, command, args, options });
    });
  `);
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
  process.env.GRAPHYARD_CONFIG_HOME = configHome;
  let releaseInstall!: () => void, started!: () => void, releaseBuild!: () => void, buildStarted!: () => void;
  let waitForInstall = Promise.resolve(), installStarted = Promise.resolve(), failInstall = false, unhealthy: string | null = null;
  let waitForBuild = Promise.resolve();
  const installs: string[] = [], restarts: string[] = [], previews: string[] = [];
  let pending: Promise<unknown> | undefined;
  let oldWatch: ReturnType<typeof watcher> | undefined, newWatch: ReturnType<typeof watcher> | undefined;
  const secret = join(directory, 'coordinator.token'); await writeFile(secret, 'must-stay-hidden', { mode: 0o600 });
  const sessions = new Map<string, Awaited<ReturnType<typeof maskedSession>>>();
  const load = (root: string) => sessions.get(root)?.invoke(url) ?? invoke(root, url);
  try {
    sessions.set(legacy, await maskedSession(legacy, checkout, configHome, secret, true));
    const run: ChildRun = async (command, args, options) => {
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
        assert.equal(args[args.indexOf('--source-root') + 1], root, 'plan/apply receives the literal isolated source path, including spaces and apostrophes');
        if (args.includes('--plan')) previews.push(sha);
        else { buildStarted?.(); await waitForBuild; restarts.push(sha); served = sha; healthy = sha !== unhealthy; }
        return '';
      }
      if (command === 'docker') return '';
      return defaultChildRun(command, args, options);
    };
    const ports = await watchPorts({ cliRoot: checkout, repoRoot: checkout, repository: 'owner/project', url, run });
    assert.notEqual(typeof ports, 'string'); if (typeof ports === 'string') throw new Error(ports);
    ports.health = deployHealth(checkout, url, 1, 0);
    const file = deployRecordPath(checkout);
    const check = async (root = legacy) => { const result = await load(root); assert.equal(result.code, 0, result.err); assert.equal(JSON.parse(result.out).commit, served); return result; };
    const oldLoader = await readFile(join(legacy, 'node_modules/tsx/dist/loader.mjs'));
    const oldSource = await readFile(join(legacy, 'src/cli/context.ts'));
    await check();
    // Start the real predecessor entry on A, then change its file on disk. Its
    // loaded functions would still npm-ci deploy/build on the next poll.
    await mkdir(join(checkout, '.graphyard'), { recursive: true });
    await writeFile(join(checkout, '.graphyard/master.json'), JSON.stringify(masterConfigSchema.parse({
      version: 1, url, credentialFile: secret, cliPath: join(checkout, 'bin/graphyard.mjs'),
      repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'test-host',
      masterAgentName: 'test-master', workers: [], run: { intervalSeconds: 300 },
    })));
    const upgrade = join(checkout, 'src/cli/upgrade.ts');
    await cp(join(source, 'tests/fixtures/deploy-predecessor/upgrade.ts.txt'), upgrade);
    oldWatch = watcher(checkout, run); await oldWatch.started;
    await cp(join(source, 'src/cli/upgrade.ts'), upgrade);
    const b = await commit('B');
    waitForInstall = new Promise(done => { releaseInstall = done; }); installStarted = new Promise(done => { started = done; });
    waitForBuild = new Promise(done => { releaseBuild = done; });
    const building = new Promise<void>(done => { buildStarted = done; });
    // Existing unit alignment is the supported migration: even though ExecStart
    // is unchanged, the implementation marker forces the old process to restart.
    const home = join(base, 'supervisor'), unitDirectory = join(home, '.config/systemd/user');
    await mkdir(unitDirectory, { recursive: true });
    const units = perInstallUnits('owner/project');
    await writeFile(join(checkout, '.graphyard/units.json'), JSON.stringify(units));
    const unitInput = { root: checkout, cliPath: join(checkout, 'bin/graphyard.mjs'), repository: 'owner/project', intervalSeconds: 300, installDir: directory };
    await writeFile(join(unitDirectory, units.master), loopUnitText(unitInput));
    await writeFile(join(unitDirectory, deployUnitOf(units)), deployUnitText(unitInput).replace(/^# Deploy implementation:.*\n/m, ''));
    const calls: string[] = [];
    await alignLoopUnit(unitInput, { home, temporaryDirectories: [], run: (command, args) => {
      calls.push([command, ...args].join(' '));
      if (command === 'systemctl' && args.join(' ') === `--user restart ${deployUnitOf(units)}`) {
        pending = (async () => { await oldWatch!.stop(); newWatch = watcher(checkout, run); await newWatch.serving; await newWatch.stop(); return 'deployed'; })();
      }
      return args.includes('is-enabled') ? 'enabled' : args.includes('is-active') ? 'active' : args.includes('show-user') ? 'yes' : '';
    } });
    assert.ok(pending, 'alignment must restart the predecessor, even with unchanged ExecStart');
    assert.equal(calls.filter(call => call.includes(' restart ')).length, 1, 'only the deploy watcher restarts');
    await Promise.race([installStarted, pending]);
    assert.equal(installs[0], cliReleasePath(directory, b), 'the restarted watcher installs into the candidate, never the active legacy tree');
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
    const aligned = await alignLoopUnit(unitInput, { home, run: () => { throw new Error('unchanged units must not restart'); } });
    assert.equal(aligned.wrote, 'unchanged');

    const release = cliReleasePath(directory, b);
    sessions.set(release, await maskedSession(release, checkout, configHome, secret));
    await check(release);

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
    const during = load(legacy);
    await new Promise(done => setTimeout(done, 900)); await ports.checkout(e);
    await check(release);
    const handedOver = await during; assert.equal(handedOver.code, 0, handedOver.err); assert.match(handedOver.err, /release handover: retry/);
    const callsBefore = apiCalls; served = 'f'.repeat(40);
    const mismatch = await load(legacy);
    assert.equal(mismatch.code, 1); assert.match(mismatch.err, /CLI commit .* and server commit .* differ/);
    assert.equal((mismatch.err.match(/release handover: retry/g) ?? []).length, 3);
    assert.equal(apiCalls, callsBefore, 'true mismatch never reaches the API');
  } finally {
    releaseInstall?.(); releaseBuild?.();
    await oldWatch?.stop(); await newWatch?.stop();
    await pending?.catch(() => {});
    for (const session of sessions.values()) await session.close();
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    if (previousHome === undefined) delete process.env.GRAPHYARD_CONFIG_HOME; else process.env.GRAPHYARD_CONFIG_HOME = previousHome;
  }
});
