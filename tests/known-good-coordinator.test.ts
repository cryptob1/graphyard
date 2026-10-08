import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { ChildRun } from '../src/child-runner.js';
import { coordinatorDoctorLine, knownGoodCli, knownGoodDirectory, knownGoodState, pinAfterVerify, pinKnownGood, pinningVerify, promotionsBehind } from '../src/master/known-good.js';
import { loopUnitText } from '../src/supervisor.js';
import { operationsCommand } from '../src/cli/master/operations.js';
import type { MasterSession } from '../src/cli/master/session.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/** GY-1529: the known-good coordinator — a pinned checkout at the last promoted SHA runs the loop; recover repins it. */
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
/** A real repository with three commits; npm is a recorded stub, git is real. */
async function world() {
  const base = await temporaryDirectory('known-good');
  const repository = join(base, 'repo'), installDir = join(base, 'install');
  mkdirSync(repository); git(repository, 'init', '-q', '-b', 'main');
  const shas: string[] = [];
  for (const name of ['a', 'b', 'c']) { writeFileSync(join(repository, `${name}.txt`), name); git(repository, 'add', '.'); git(repository, 'commit', '-q', '-m', name); shas.push(git(repository, 'rev-parse', 'HEAD')); }
  const calls: string[] = [];
  let failBuild = false;
  const run: ChildRun = (command, args, options) => {
    if (command === 'npm') {
      calls.push(`npm ${args.join(' ')} @${options?.cwd?.split('/').pop()}`);
      if (args[0] === 'run' && failBuild) throw new Error('build failed');
      if (args[0] === 'run') { mkdirSync(join(options!.cwd!, 'dist'), { recursive: true }); writeFileSync(join(options!.cwd!, 'dist', 'cli.js'), '// built\n'); }
      return '';
    }
    return execFileSync(command, args, { encoding: 'utf8', cwd: options?.cwd });
  };
  return { repository, installDir, shas, calls, run, pin: { installDir, repository }, failBuild: (value: boolean) => { failBuild = value; } };
}
const short = (sha: string) => sha.slice(0, 12);

test('unit:known-good-pin-atomic — a pin is a detached worktree under coordinator/<sha12>, built there, and current is repointed by renaming a symlink; a failed build leaves the pin and the tree untouched', async () => {
  const w = await world();
  assert.equal(knownGoodState(w.installDir), null);
  const state = await pinKnownGood({ ...w.pin, now: () => new Date('2026-10-08T00:00:00Z') }, w.shas[0], w.run);
  assert.deepEqual(state, { sha: w.shas[0], pinnedAt: '2026-10-08T00:00:00.000Z', previous: null });
  assert.deepEqual(w.calls, [`npm ci @${short(w.shas[0])}`, `npm run build @${short(w.shas[0])}`]);
  const directory = knownGoodDirectory(w.installDir);
  assert.ok(lstatSync(join(directory, 'current')).isSymbolicLink());
  assert.equal(readlinkSync(join(directory, 'current')), short(w.shas[0]));
  assert.equal(git(join(directory, short(w.shas[0])), 'rev-parse', 'HEAD'), w.shas[0]);
  assert.equal(git(join(directory, short(w.shas[0])), 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
  assert.equal(realpathSync(knownGoodCli(w.installDir)), realpathSync(join(directory, short(w.shas[0]), 'dist', 'cli.js')));
  assert.deepEqual(knownGoodState(w.installDir), state);
  // A failing build pins nothing: the symlink, the state and the directory are as they were.
  w.failBuild(true);
  await assert.rejects(pinKnownGood(w.pin, w.shas[1], w.run), /build failed/);
  assert.equal(readlinkSync(join(directory, 'current')), short(w.shas[0]));
  assert.deepEqual(knownGoodState(w.installDir), state);
  assert.equal(existsSync(join(directory, short(w.shas[1]))), false);
  await assert.rejects(pinKnownGood(w.pin, 'abc', w.run), /full 40-character/);
});

test('unit:known-good-keeps-previous — the pin before the previous one is removed, the previous one stays for recover, and pinning the pinned SHA changes nothing', async () => {
  const w = await world();
  const directory = knownGoodDirectory(w.installDir);
  await pinKnownGood(w.pin, w.shas[0], w.run);
  const second = await pinKnownGood(w.pin, w.shas[1], w.run);
  assert.equal(second.previous, w.shas[0]);
  assert.ok(existsSync(join(directory, short(w.shas[0]))));
  const third = await pinKnownGood(w.pin, w.shas[2], w.run);
  assert.equal(third.previous, w.shas[1]);
  assert.equal(existsSync(join(directory, short(w.shas[0]))), false, 'the pin before the previous one is removed');
  assert.ok(existsSync(join(directory, short(w.shas[1]))));
  assert.equal(readlinkSync(join(directory, 'current')), short(w.shas[2]));
  const calls = w.calls.length;
  assert.deepEqual(await pinKnownGood(w.pin, w.shas[2], w.run), third);
  assert.equal(w.calls.length, calls);
  assert.equal(git(w.repository, 'worktree', 'list').split('\n').length, 3);
});

test('unit:known-good-pin-after-verify — the pin moves only after production verifies the promoted SHA; a failed verify leaves it unchanged', async () => {
  const w = await world();
  await pinKnownGood(w.pin, w.shas[0], w.run);
  const verifying = (verified: boolean) => async (sha: string) => ({ served: verified ? sha : w.shas[0], verified });
  assert.equal(await pinAfterVerify(w.pin, w.shas[1], w.run, async () => ({ verified: false })), null);
  assert.equal(knownGoodState(w.installDir)!.sha, w.shas[0]);
  const refused = await pinningVerify(w.pin, w.run, verifying(false))(w.shas[1]);
  assert.equal(refused.verified, false);
  assert.equal(knownGoodState(w.installDir)!.sha, w.shas[0]);
  const failures: unknown[] = [];
  w.failBuild(true);
  assert.equal((await pinningVerify(w.pin, w.run, verifying(true), error => failures.push(error))(w.shas[1])).verified, true, 'a pin that fails never fails the verification');
  assert.equal(failures.length, 1); assert.equal(knownGoodState(w.installDir)!.sha, w.shas[0]);
  w.failBuild(false);
  assert.equal((await pinningVerify(w.pin, w.run, verifying(true))(w.shas[1])).verified, true);
  assert.deepEqual([knownGoodState(w.installDir)!.sha, knownGoodState(w.installDir)!.previous], [w.shas[1], w.shas[0]]);
});

test('unit:master-unit-uses-known-good — ExecStart runs coordinator/current/dist/cli.js once a pin exists and the checkout path before', async () => {
  const w = await world();
  const input = { root: w.repository, cliPath: '/checkout/bin/graphyard.mjs', repository: 'owner/project', intervalSeconds: 60, execPath: '/usr/bin/node', installDir: w.installDir };
  assert.match(loopUnitText(input), /^ExecStart=\/usr\/bin\/node \/checkout\/bin\/graphyard\.mjs master run$/m);
  await pinKnownGood(w.pin, w.shas[0], w.run);
  assert.match(loopUnitText(input), new RegExp(`^ExecStart=/usr/bin/node ${knownGoodDirectory(w.installDir)}/current/dist/cli\\.js master run$`, 'm'));
});

test('unit:known-good-doctor-line — doctor prints the pinned and production SHAs and FAILs when the pin is more than one promotion behind', () => {
  const [a, b, c] = ['a', 'b', 'c'].map(letter => letter.repeat(40));
  assert.deepEqual(coordinatorDoctorLine(a, a, 0), { line: `coordinator: pinned ${'a'.repeat(12)} (production ${'a'.repeat(12)})`, ok: true });
  assert.deepEqual(coordinatorDoctorLine(b, c, promotionsBehind(b, [c, b, a])), { line: `coordinator: pinned ${'b'.repeat(12)} (production ${'c'.repeat(12)})`, ok: true });
  assert.deepEqual(coordinatorDoctorLine(a, c, promotionsBehind(a, [c, b, a])), { line: `FAIL coordinator: pinned ${'a'.repeat(12)} (production ${'c'.repeat(12)})`, ok: false });
  assert.equal(coordinatorDoctorLine(a, c, promotionsBehind(a, [c, b])).ok, false, 'a pin that is no longer a promoted SHA fails');
  assert.equal(coordinatorDoctorLine(null, c, null).ok, true);
});

let pg: EmbeddedPostgres, store: Store, http: ReturnType<typeof server>, url: string;
const admin = { id: 'human-operator', role: 'admin' as const, sessionKind: 'human' as const, token: `human-operator-token-${'x'.repeat(32)}` };
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 183;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('known-good-pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('known_good_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/known_good_test`); await store.init();
  const engine = new Engine(store, [15368], 120, 'owner/project'); engine.submissionObserver = null; engine.directMergeEnvironment = null;
  http = server(engine, [admin, { id: 'graphyard-master', role: 'coordinator', token: `graphyard-master-token-${'y'.repeat(32)}` }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (pg) await pg.stop(); });

test('integration:master-recover-repins-and-records — master recover repins the previous SHA (or --to), rewrites the unit onto the pin, restarts it and records policy.coordinator.recovered {from, to, reason}', async () => {
  const w = await world();
  const home = await temporaryDirectory('known-good-home');
  const previousConfig = process.env.GRAPHYARD_CONFIG_HOME;
  process.env.GRAPHYARD_CONFIG_HOME = join(home, 'config');
  try {
    const { installDirectory } = await import('../src/install/secrets.js');
    const { installIdFor } = await import('../src/install/types.js');
    const installDir = installDirectory(installIdFor('owner/project'));
    const root = w.repository;
    mkdirSync(join(root, '.graphyard'), { recursive: true }); writeFileSync(join(root, '.graphyard', 'master.json'), '{}');
    const unitDirectory = join(home, '.config', 'systemd', 'user'); mkdirSync(unitDirectory, { recursive: true });
    const master = { repository: 'owner/project', cliPath: join(root, 'bin', 'graphyard.mjs'), run: { intervalSeconds: 60 } };
    const host = { home, platform: 'linux' as const, temporaryDirectories: [join(home, 'tmp-elsewhere')], run: (_command: string, args: string[]) => args[1] === 'is-enabled' ? 'enabled' : args[1] === 'is-active' ? 'active' : '' };
    const restarts: string[] = [];
    writeFileSync(join(unitDirectory, 'graphyard-master.service'), loopUnitText({ root, cliPath: master.cliPath, repository: master.repository, intervalSeconds: 60, installDir }));
    const effects = { run: w.run, host, restart: (unit: string) => { restarts.push(unit); } };
    const pin = { installDir, repository: root };
    await pinKnownGood(pin, w.shas[0], w.run); await pinKnownGood(pin, w.shas[1], w.run);
    const session = (args: string[], stdin = admin.token) => ({
      id: 'recover', args, root, master, print: (value: unknown) => value, readSecret: stdin,
      masterMutation: async (path: string, body: unknown, _id: unknown, credential: string) => {
        const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
        return response.json();
      },
    }) as unknown as MasterSession;
    await assert.rejects(operationsCommand(session([]), effects), /--admin-token-stdin/);
    // The secret is read from stdin by the command; the test substitutes it through the module under test's reader.
    const ledger = async () => (await store.pool.query("SELECT actor, payload FROM events WHERE kind='policy.coordinator.recovered' AND work_id IS NULL ORDER BY seq")).rows;
    assert.deepEqual(await ledger(), []);
    const { readSecretFromStdin } = await import('../src/cli/context.js');
    assert.equal(typeof readSecretFromStdin, 'function');
    const result: any = await withStdin(admin.token, () => operationsCommand(session(['--admin-token-stdin', '--reason', 'main-watch freeze after a self-merge']), effects));
    assert.equal(result.recovered, true); assert.equal(result.from, w.shas[1]); assert.equal(result.to, w.shas[0]);
    assert.deepEqual(knownGoodState(installDir)!.sha, w.shas[0]);
    assert.equal(readlinkSync(join(knownGoodDirectory(installDir), 'current')), short(w.shas[0]));
    assert.equal(restarts.length, 1);
    assert.match(readFileSync(join(unitDirectory, restarts[0]), 'utf8'), /ExecStart=.*\/coordinator\/current\/dist\/cli\.js master run/);
    const rows = await ledger();
    assert.equal(rows.length, 1); assert.equal(rows[0].actor, admin.id);
    assert.deepEqual(rows[0].payload, { from: w.shas[1], to: w.shas[0], reason: 'main-watch freeze after a self-merge' });
    const explicit: any = await withStdin(admin.token, () => operationsCommand(session(['--admin-token-stdin', '--to', w.shas[2]]), effects));
    assert.equal(explicit.to, w.shas[2]);
    assert.equal((await ledger()).length, 2);
    // Only an admin credential records it.
    const refused = await fetch(`${url}/api/coordinator/recovered`, { method: 'POST', headers: { Authorization: 'Bearer graphyard-master-token-' + 'y'.repeat(32), 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ from: null, to: w.shas[0], reason: 'no' }) });
    assert.equal(refused.status, 403);
  } finally { if (previousConfig === undefined) delete process.env.GRAPHYARD_CONFIG_HOME; else process.env.GRAPHYARD_CONFIG_HOME = previousConfig; }
});

/** Runs `body` with `secret` on a stdin the command's reader consumes. */
async function withStdin<T>(secret: string, body: () => Promise<T>): Promise<T> {
  const { Readable } = await import('node:stream');
  const descriptor = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  Object.defineProperty(process, 'stdin', { value: Object.assign(Readable.from([secret]), { isTTY: false }), configurable: true });
  try { return await body(); } finally { Object.defineProperty(process, 'stdin', descriptor); }
}
