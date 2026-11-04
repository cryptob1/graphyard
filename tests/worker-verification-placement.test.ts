import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { runWorkerVerification } from '../src/merge-writer/worker-verification.js';
import type { Work } from '../src/model.js';

// This is deliberately a real trial: a host without Docker cannot satisfy placement.
test('integration:worker-verification-placement — exact committed head executes in the private trial and a failing proof stays failed', { timeout: 120_000 }, async () => {
  const root = await temporaryDirectory('worker-verification', process.cwd());
  const allocations = await temporaryDirectory('trials', root);
  const repository = await temporaryDirectory('repository', root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repository, '.gitignore'), '.graphyard/\nnode_modules/\n');
  await writeFile(join(repository, 'package.json'), '{"type":"module"}');
  await mkdir(join(repository, 'tests'));
  const source = (fails: boolean) => `
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
test('integration:placed — private container and unnested namespaces', () => {
  assert.equal(existsSync('/etc/graphyard-trial'), true);
  assert.equal(existsSync('/var/run/docker.sock'), false);
  execFileSync('bwrap', ['--unshare-user', '--ro-bind', '/', '/', '--', 'true']);
  assert.equal(${fails}, false, 'deliberate criterion failure');
});`;
  await writeFile(join(repository, 'tests/placed.test.ts'), source(false));
  git('add', '.'); git('commit', '-qm', 'passing head');
  const head = git('rev-parse', 'HEAD');
  const work = { key: 'GY-1', criteria: [{ id: 'AC-1', proofs: ['integration:placed'] }] } as Work;
  // Uncommitted candidate edits must never replace the requested head.
  await writeFile(join(repository, 'tests/placed.test.ts'), source(true));
  const passing = await runWorkerVerification(repository, work, { head, epoch: 1, mode: 'verify' }, 'main', allocations);
  assert.equal(passing.record.head, head);
  assert.equal(passing.record.ran[0].result, 'pass');
  assert.equal(passing.record.ran[0].executed, 1);
  git('add', '.'); git('commit', '-qm', 'failing head');
  const failedHead = git('rev-parse', 'HEAD');
  const failing = await runWorkerVerification(repository, work, { head: failedHead, epoch: 1, mode: 'complete' }, 'main', allocations);
  assert.equal(failing.record.head, failedHead);
  assert.equal(failing.record.ran[0].result, 'fail');
  assert.equal(failing.record.ran[0].failed, 1);
});

// Exercise the shipped route and host-loop wiring, with the client under the
// ordinary worker mount/socket boundary. The HTTP server has no usable repo path.
test('integration:worker-verification-placement — confined verify/complete cross HTTP to the host runner', { timeout: 180_000 }, async t => {
  const [{ default: EmbeddedPostgres }, { Store }, { Engine }, { server }, { daemonEffects },
    { readOnlyMountWrapper }, { defaultChildRun }, { randomUUID }] = await Promise.all([
    import('embedded-postgres'), import('../src/store.js'), import('../src/engine.js'), import('../src/server.js'),
    import('../src/daemon/effects-production.js'), import('../src/master/confinement.js'), import('../src/child-runner.js'), import('node:crypto'),
  ]);
  const root = await temporaryDirectory('verification-http', process.cwd());
  const repository = await temporaryDirectory('repository', root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'graphyard/verification'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repository, '.gitignore'), '.graphyard/\nnode_modules/\n');
  await writeFile(join(repository, 'package.json'), '{"type":"module"}');
  await mkdir(join(repository, 'tests'));
  const source = (fail: boolean) => `import { test } from 'node:test';
import assert from 'node:assert/strict'; import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
test('integration:placed-http', () => {
  assert.ok(existsSync('/etc/graphyard-trial'));
  assert.equal(existsSync('/var/run/docker.sock'), false);
  execFileSync('bwrap', ['--unshare-user', '--ro-bind', '/', '/', '--', 'true']);
  assert.equal(${fail}, false, 'deliberate failure');
});`;
  await writeFile(join(repository, 'tests/placed.test.ts'), source(false));
  git('add', '.'); git('commit', '-qm', 'passing');
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 3075;
  const database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('verification-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('verification');
  t.after(() => database.stop());
  const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/verification`);
  await store.init(); t.after(() => store.close());
  const engine = new Engine(store, 600, 'owner/project'); engine.gitRunner = null;
  const worker = { id: 'worker', role: 'worker' as const }, operator = { id: 'operator', role: 'admin' as const, sessionKind: 'human' as const };
  const credentials = [ { ...worker, token: 'worker-test-token' }, { id: 'host', role: 'coordinator' as const, token: 'host-test-token' } ];
  engine.principals = [operator, ...credentials];
  let work = await engine.execute(operator, 'create', null, { type: 'chore', title: 'Host verification', criteria: [{ id: 'AC-1', text: 'Runs privately', proofs: ['integration:placed-http', 'e2e:fixture'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'test', path: repository, branch: 'graphyard/verification' }, randomUUID());
  const http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => http.close(() => resolve())));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const api = async (path: string, data: unknown, token = 'host-test-token') => {
    const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    return result;
  };
  await assert.rejects(api('worker-verifications/take', { host: 'test' }, 'worker-test-token'), /Only the host coordinator/);
  await assert.rejects(api('worker-verifications/finish', { id: randomUUID(), error: 'forged' }, 'worker-test-token'), /Only the host coordinator/);
  const effects = daemonEffects(repository, { hostId: 'test' } as any, { snapshot: async () => ({ work: [], now: new Date().toISOString() }), mutate: api });
  const pump = setInterval(() => { void effects.snapshot().catch(() => {}); }, 50);
  t.after(() => clearInterval(pump));
  const previous = process.env.GRAPHYARD_REPOSITORY_ROOT;
  process.env.GRAPHYARD_REPOSITORY_ROOT = '/server-private/repo-does-not-exist-on-host';
  t.after(() => { if (previous === undefined) delete process.env.GRAPHYARD_REPOSITORY_ROOT; else process.env.GRAPHYARD_REPOSITORY_ROOT = previous; });
  const script = join(root, 'client.mjs');
  await writeFile(script, `
import assert from 'node:assert/strict'; import { createConnection } from 'node:net';
import { requestWorkerVerification } from ${JSON.stringify(new URL('../src/cli/worker-verification.ts', import.meta.url).href)};
await new Promise((resolve, reject) => {
  const socket = createConnection('/var/run/docker.sock');
  socket.on('connect', () => { socket.destroy(); reject(new Error('worker reached Docker')); });
  socket.on('error', resolve);
});
const api = async (path, data) => {
  const response = await fetch(${JSON.stringify(url)} + '/api/' + path, { method: 'POST', headers: { Authorization: 'Bearer worker-test-token', 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
};
try {
  const result = await requestWorkerVerification({ repositoryRoot: () => ${JSON.stringify(repository)}, api }, ${JSON.stringify(work)}, { mode: process.argv[2] });
  console.log(JSON.stringify(result));
} catch (error) { console.log(JSON.stringify({ error: error.message })); }
`);
  const wrapper = readOnlyMountWrapper({ coordinatorRoot: repository, sessionDirectory: repository, secretsBus: null });
  const invoke = async (mode: string) => JSON.parse(await defaultChildRun(process.execPath, ['--import', import.meta.resolve('tsx'), script, mode], { cwd: repository, wrapper, timeoutMs: 120_000 }));
  const passing = await invoke('verify');
  assert.equal(passing.record?.head, git('rev-parse', 'HEAD'), JSON.stringify(passing));
  assert.equal(passing.record.ran[0].result, 'pass');
  assert.equal(passing.record.ran[0].executed, 1);
  await writeFile(join(repository, 'tests/placed.test.ts'), source(true)); git('add', '.'); git('commit', '-qm', 'failing');
  const failing = await invoke('complete');
  assert.match(failing.error, /complete refused: required proofs failed/);
  const records = (await store.events(work.id)).filter(event => event.kind === 'work.self-verified');
  assert.equal(records.length, 2);
  assert.equal(records[1].payload.details.record.ran[0].failed, 1);
});
