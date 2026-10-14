import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { buildPlan, coreEnv, materializeInstall, prepareInstall, type InstallSession } from '../src/install/index.js';
import type { LocalSupervisor } from '../src/install/local.js';
import type { LocalRuntime } from '../src/install/local-runtime.js';
import { REDACTED } from '../src/install/types.js';
import { harness, type Harness } from './install-harness.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1500: `graphyard install --provider local` (and `graphyard up --local`) runs the control plane
 * on this machine against an embedded Postgres cluster under ~/.config/graphyard/INSTALL/postgres,
 * supervised by a systemd user unit, with no Docker. Each test is named for the proof it produces.
 */
// Loaded inside each test, so a tree without them fails as a test case, not at load.
const local = () => import('../src/install/local.js');
const runtimeModule = () => import('../src/install/local-runtime.js');

const INSTALL = 'owner-project';

/** A loopback port nothing listens on, for the server this install would serve on. */
const freePort = () => new Promise<number>((accept, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => accept(port)); });
});

/**
 * A systemd user manager that runs the unit in this process: `enable --now` starts the runtime the
 * unit's ExecStart names, `restart` stops and starts it, `is-active` reports it. Every call is kept.
 */
function inProcessSystemd(unitDirectory: string) {
  const calls: string[][] = [];
  let runtime: LocalRuntime | null = null, starts = 0;
  const directoryOf = async (unit: string) => (await readFile(join(unitDirectory, unit), 'utf8')).match(/^ExecStart=.* (\S+)$/m)![1];
  const supervisor: LocalSupervisor = {
    systemd: { unitDirectory }, reason: null,
    async systemctl(args) {
      calls.push(args);
      const [verb, ...rest] = args, unit = rest[rest.length - 1];
      if (verb === 'is-active') { if (!runtime) throw new Error('inactive'); return 'active\n'; }
      if (verb === 'enable' && !runtime) { runtime = await (await runtimeModule()).startLocalRuntime(await directoryOf(unit)); starts++; }
      if (verb === 'restart') { await runtime?.stop(); runtime = await (await runtimeModule()).startLocalRuntime(await directoryOf(unit)); starts++; }
      if (verb === 'stop') { await runtime?.stop(); runtime = null; }
      return '';
    },
    detach: async () => { throw new Error('systemd is present: nothing is started detached'); },
    kill: async () => {},
  };
  return { supervisor, calls, starts: () => starts, runtime: () => runtime, stop: async () => { await runtime?.stop(); runtime = null; } };
}

const foreground = (): LocalSupervisor => ({ systemd: null, reason: 'no systemd user manager answers (test host)', systemctl: async () => { throw new Error('no systemd'); }, detach: async () => { throw new Error('a plan starts nothing'); }, kill: async () => {} });

async function localFixture(supervisor: LocalSupervisor, port: number, fixture?: Harness) {
  const harnessed = fixture ?? await harness({ provider: 'local' });
  // The local provider's health is the real server's: no fake answers for it.
  return { fixture: harnessed, deps: { ...harnessed.deps, fetch, localSupervisor: supervisor }, inputs: { repository: 'owner/project', provider: 'local' as const, port } };
}

/** The provider half of `install --apply` (performInstall), which is all the local provider adds. */
async function applyProvider(session: InstallSession) {
  await materializeInstall(session);
  const { adapter, context } = session;
  const observation = await adapter.observe(context);
  await adapter.provision(context, observation);
  await adapter.setEnv(context, coreEnv(session));
  await adapter.deploy(context);
  const url = await adapter.url(context);
  for (let attempt = 0; attempt < 60; attempt++) { if (await adapter.health(context, url)) return url; await new Promise(accept => setTimeout(accept, 500)); }
  throw new Error(`${url} never became healthy`);
}

/** Every file under DIRECTORY with its mode and modification time. */
async function snapshot(directory: string, skip: (path: string) => boolean = () => false): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (!entry.isFile() || skip(path)) continue;
    const info = await stat(path);
    out[path] = `${(info.mode & 0o777).toString(8)} ${info.mtimeMs}`;
  }
  return out;
}

test('unit:local-provider-plan — install --provider local --plan lists Node 24, resolvable embedded-postgres binaries and a free loopback port, plans the cluster and the unit, never needs Docker, and creates nothing', async () => {
  const { localUnit, runtimeCommand } = await local();
  const unitDirectory = await temporaryDirectory('local-units');
  const port = await freePort();
  const { fixture, deps, inputs } = await localFixture(inProcessSystemd(unitDirectory).supervisor, port);
  try {
    const plan = await buildPlan(await prepareInstall(fixture.root, inputs, deps, 'plan'));
    const preflight = Object.fromEntries(plan.preflight.map(item => [item.name, item]));
    for (const name of ['Node.js', 'Embedded Postgres', 'Loopback port', 'Supervisor']) assert.equal(preflight[name]?.ok, true, `${name}: ${preflight[name]?.detail}`);
    assert.match(preflight['Node.js'].detail, /^Node (2[4-9]|[3-9]\d)\./);
    assert.match(preflight['Embedded Postgres'].detail, /@embedded-postgres\/.* provides .*postgres; no Docker is needed/);
    assert.match(preflight['Loopback port'].detail, new RegExp(`server 127\\.0\\.0\\.1:${port}; Postgres 127\\.0\\.0\\.1:\\d+`));
    assert.ok(!plan.preflight.some(item => /docker/i.test(item.name)), 'no Docker preflight');
    assert.ok(!fixture.allCommandLines().some(line => /^docker\b/.test(line)), 'no docker command ran');

    const directory = join(fixture.configHome, INSTALL);
    const action = (id: string) => plan.actions.find(entry => entry.id === id)!;
    assert.equal(action('provider.provision.database').state, 'create');
    assert.match(action('provider.provision.database').title, new RegExp(`under ${join(directory, 'postgres').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} \\(directory 0700, password file 0600\\)`));
    assert.equal(action('provider.provision.app').command, `systemctl --user enable --now ${localUnit(INSTALL)}`);
    const core = Object.fromEntries(action('provider.env.core').values!.map(value => [value.name, value.value]));
    assert.equal(core.HOST, '127.0.0.1');
    assert.equal(core.PORT, String(port));
    assert.equal(core.DATABASE_URL, REDACTED, 'the cluster password never reaches the plan');
    assert.match(action('github.webhook').title, /^Skipped: a local install registers no App webhook/);
    assert.equal(plan.provider, 'local');
    assert.deepEqual(await readdir(fixture.configHome), [], 'a plan creates nothing');

    // Without a systemd user manager the plan names the foreground command, as master init does for the loop.
    const unsupervised = await buildPlan(await prepareInstall(fixture.root, inputs, { ...deps, localSupervisor: foreground() }, 'plan'));
    const app = unsupervised.actions.find(entry => entry.id === 'provider.provision.app')!;
    assert.equal(app.command, runtimeCommand(directory).join(' '));
    assert.match(app.human!, /cannot install a supervisor for the local control plane on this host .* run ".*local-runtime\.ts .*" under this platform's own always-restart supervisor/);

    // A taken server port fails preflight before anything is created.
    const taken = createServer(); await new Promise<void>(accept => taken.listen(0, '127.0.0.1', () => accept()));
    try {
      const busy = await buildPlan(await prepareInstall(fixture.root, { ...inputs, port: (taken.address() as { port: number }).port }, { ...deps, fetch: (async () => new Response('', { status: 404 })) as unknown as typeof fetch }, 'plan'));
      const loopback = busy.preflight.find(item => item.name === 'Loopback port')!;
      assert.equal(loopback.ok, false);
      assert.match(loopback.detail, /is taken by another process/);
    } finally { taken.close(); }
  } finally { await fixture.cleanup(); }
});

test('integration:local-provider-embedded-postgres — --apply creates the cluster under the install directory (0700, password 0600), serves on 127.0.0.1 with DATABASE_URL pointing at it, and a rerun changes nothing', { timeout: 240_000 }, async () => {
  const { localUnit } = await local();
  const { localPaths } = await runtimeModule();
  const unitDirectory = await temporaryDirectory('local-units');
  const systemd = inProcessSystemd(unitDirectory);
  const port = await freePort();
  const { fixture, deps, inputs } = await localFixture(systemd.supervisor, port);
  try {
    const session = await prepareInstall(fixture.root, inputs, deps, 'apply');
    const url = await applyProvider(session);
    assert.equal(url, `http://127.0.0.1:${port}`);
    const health = await (await fetch(`${url}/healthz`)).json() as any;
    assert.equal(health.ok, true);

    const paths = localPaths(join(fixture.configHome, INSTALL));
    assert.ok(existsSync(join(paths.data, 'PG_VERSION')), 'the cluster lives under the install directory');
    assert.equal((await stat(paths.postgres)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.passwordFile)).mode & 0o777, 0o600);
    assert.equal((await stat(paths.environment)).mode & 0o777, 0o600);
    const environment = JSON.parse(await readFile(paths.environment, 'utf8'));
    const password = (await readFile(paths.passwordFile, 'utf8')).trim();
    const pgPort = Number((await readFile(paths.portFile, 'utf8')).trim());
    assert.equal(environment.DATABASE_URL, `postgres://graphyard:${password}@127.0.0.1:${pgPort}/graphyard`, 'DATABASE_URL points at the embedded cluster');
    assert.equal(environment.HOST, '127.0.0.1');
    assert.equal(systemd.runtime()!.databaseUrl, environment.DATABASE_URL, 'the server runs against it');
    // The server migrated that database through the Store: its schema generation is the one it expects.
    const { Store } = await import('../src/store.js');
    const store = new Store(environment.DATABASE_URL, { max: 1 });
    try { assert.equal(await store.schema(), health.schema); } finally { await store.close(); }
    const unit = await readFile(join(unitDirectory, localUnit(INSTALL)), 'utf8');
    assert.match(unit, /^Restart=always$/m);
    assert.match(unit, new RegExp(`^ExecStart=.*local-runtime\\.ts ${paths.directory.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm'));

    // The rerun: the plan finds everything in place, and applying it again writes nothing and restarts nothing.
    const again = await prepareInstall(fixture.root, inputs, deps, 'apply');
    const plan = await buildPlan(again);
    for (const id of ['provider.provision.database', 'provider.provision.app', 'provider.env.core']) assert.equal(plan.actions.find(entry => entry.id === id)!.state, 'satisfied', id);
    assert.deepEqual(plan.drift, []);
    const before = { config: await snapshot(fixture.configHome, path => path.startsWith(paths.data)), units: await snapshot(unitDirectory) };
    const calls = systemd.calls.length, starts = systemd.starts();
    assert.equal(await applyProvider(again), url);
    assert.deepEqual({ config: await snapshot(fixture.configHome, path => path.startsWith(paths.data)), units: await snapshot(unitDirectory) }, before, 'no file under the install directory or the unit directory changed');
    assert.deepEqual(systemd.calls.slice(calls).map(args => args[0]), ['is-active'], 'it only read the unit\'s state');
    assert.equal(systemd.starts(), starts, 'the runtime was not restarted');
  } finally { await systemd.stop(); await fixture.cleanup(); }
});

test('integration:local-runtime-restart — the supervised process starts the cluster, migrates through the Store, then serves; on SIGTERM it closes the store before it stops the cluster, and a restart serves the same ledger', { timeout: 240_000 }, async () => {
  const { runtimeCommand, localUnit } = await local();
  const { localPaths, startLocalRuntime, serveControlPlane } = await runtimeModule();
  const unitDirectory = await temporaryDirectory('local-units');
  const systemd = inProcessSystemd(unitDirectory);
  const port = await freePort();
  const { fixture, deps, inputs } = await localFixture(systemd.supervisor, port);
  let child: ChildProcess | null = null;
  try {
    const session = await prepareInstall(fixture.root, inputs, deps, 'apply');
    await applyProvider(session);
    await systemd.stop();
    const directory = join(fixture.configHome, INSTALL), paths = localPaths(directory);
    const environment = JSON.parse(await readFile(paths.environment, 'utf8'));
    const admin = JSON.parse(environment.GRAPHYARD_PRINCIPALS).find((principal: any) => principal.role === 'admin');
    const url = `http://127.0.0.1:${port}`;

    // In process: the server closes (awaiting store.close()) before the cluster is stopped.
    const order: string[] = [];
    const runtime = await startLocalRuntime(directory, { serve: async env => { const served = await serveControlPlane(env); order.push('served'); return { close: async () => { await served.close(); order.push('store closed'); } }; } });
    runtime.cluster.process.once('exit', () => order.push('cluster stopped'));
    // Mutations wait for startup validation (a retryable 503 until then).
    let created!: Response;
    for (let attempt = 0; attempt < 120; attempt++) {
      created = await fetch(`${url}/api/work`, { method: 'POST', headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'gy-1500-restart' }, body: JSON.stringify({ title: 'Survives a restart', criteria: [{ id: 'AC-1', text: 'Kept', proofs: ['unit:kept'] }] }) });
      if (created.status !== 503) break;
      await new Promise(accept => setTimeout(accept, 250));
    }
    assert.equal(created.status, 200, await created.clone().text());
    const item = await created.json() as any;
    await runtime.stop();
    assert.deepEqual(order, ['served', 'store closed', 'cluster stopped']);

    // systemd signals only the runtime, never the cluster it spawned, so the store closes before the cluster stops.
    const unit = await readFile(join(unitDirectory, localUnit(INSTALL)), 'utf8');
    assert.match(unit, /^KillMode=mixed$/m);
    assert.match(unit, /^KillSignal=SIGTERM$/m);

    // As the unit runs it: the foreground command, stopped with the unit's KillSignal and started again.
    const start = async () => {
      const [program, ...args] = runtimeCommand(directory);
      const started = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
      let output = ''; started.stdout!.on('data', chunk => { output += chunk; }); started.stderr!.on('data', chunk => { output += chunk; });
      for (let attempt = 0; attempt < 120; attempt++) {
        if (started.exitCode !== null) throw new Error(`the runtime exited ${started.exitCode}: ${output}`);
        try { if ((await fetch(`${url}/healthz`)).ok) return started; } catch { /* starting */ }
        await new Promise(accept => setTimeout(accept, 500));
      }
      throw new Error(`the runtime never served: ${output}`);
    };
    for (const round of [1, 2]) {
      child = await start();
      const listed = await (await fetch(`${url}/api/work`, { headers: { Authorization: `Bearer ${admin.token}` } })).json() as any[];
      assert.ok(listed.some(work => work.id === item.id), `round ${round}: the restarted runtime serves the same ledger`);
      const exited = new Promise<number | null>(accept => child!.once('exit', code => accept(code)));
      child.kill('SIGTERM');
      assert.equal(await exited, 0, 'it shuts down cleanly on SIGTERM');
      child = null;
      assert.equal(existsSync(join(paths.data, 'postmaster.pid')), false, 'the cluster stopped with it');
    }
  } finally { child?.kill('SIGKILL'); await systemd.stop(); await fixture.cleanup(); }
});

test('unit:local-provider-credentials-outside-repo — the local provider writes every credential under the install directory, none inside the repository, and embedded-postgres is a runtime dependency', async () => {
  const { localPaths } = await runtimeModule();
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.dependencies['embedded-postgres'], 'an installed CLI can start the cluster');
  assert.equal(pkg.devDependencies['embedded-postgres'], undefined);

  const unitDirectory = await temporaryDirectory('local-units');
  const { fixture, deps, inputs } = await localFixture(inProcessSystemd(unitDirectory).supervisor, await freePort());
  try {
    const status = () => execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--ignored'], { cwd: fixture.root, encoding: 'utf8' });
    const before = status();
    const session = await prepareInstall(fixture.root, inputs, deps, 'apply');
    await materializeInstall(session);
    await session.adapter.setEnv(session.context, coreEnv(session));
    assert.equal(status(), before, 'nothing was written inside the repository');

    const directory = join(fixture.configHome, INSTALL), paths = localPaths(directory);
    const password = (await readFile(paths.passwordFile, 'utf8')).trim();
    assert.ok(password.length >= 32);
    for (const file of [paths.passwordFile, paths.environment]) assert.equal((await stat(file)).mode & 0o777, 0o600, file);
    assert.equal((await stat(paths.postgres)).mode & 0o777, 0o700);
    assert.ok(!existsSync(join(directory, 'database.password')), 'the cluster password has one home, beside the cluster');
    // The password and every token appear only in files under the install directory.
    const secrets = [password, ...session.tokens.values()];
    for (const [path] of Object.entries(await snapshot(fixture.root, path => path.includes(`${join(fixture.root, '.git')}`)))) {
      const text = await readFile(path, 'utf8');
      assert.ok(!secrets.some(secret => text.includes(secret)), `${path} holds a credential`);
    }

    // A config home inside the repository is refused before anything is written.
    const inside = { ...deps, configHome: join(fixture.root, '.graphyard', 'config') };
    await assert.rejects(prepareInstall(fixture.root, inputs, inside, 'apply'), /Refusing to store installation credentials inside the managed repository/);
  } finally { await fixture.cleanup(); }
});
