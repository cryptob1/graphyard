import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { runWorkerCheck } from '../src/merge-writer/worker-check.js';
import { workerVerificationPump } from '../src/daemon/worker-verification.js';

// GY-3283: a confined worker runs its item's declared preMerge check, with the check's Compose
// services, on its own head through `graphyard check NAME`; the host loop runs it as the trial does.
// As in e2e:premerge-check-services, a stub docker first on PATH answers Compose, a loopback listener
// stands in for the postgres service and a preload resolves its name. Trial children run unwrapped
// (nested bubblewrap cannot start inside the trial); the worker runs under the session mount boundary
// where bubblewrap can start, and checks it reaches no Docker socket either way.
const cli = new URL('../bin/graphyard.mjs', import.meta.url).pathname;

test('e2e:worker-runs-declared-check — a leased worker gets its declared check\'s output and pass/fail from the host, a worker without the lease is refused, and the worker reaches no Docker socket', { timeout: 300_000 }, async t => {
  const [{ withDatabase }, { Engine }, { server }, { readOnlyMountWrapper }] = await Promise.all([
    import('./helpers/postgres.js'), import('../src/engine.js'), import('../src/server.js'), import('../src/master/confinement.js'),
  ]);
  const listener = createServer(socket => socket.once('data', query => socket.end(/no_such_table/.test(String(query)) ? 'ERROR: relation "no_such_table" does not exist\n' : '[{"answer":1}]\n')));
  await new Promise<void>(done => listener.listen(0, '127.0.0.1', done));
  t.after(() => { listener.close(); });
  const port = (listener.address() as { port: number }).port, execPath = process.execPath, hostPath = process.env.PATH!;
  t.after(() => { process.execPath = execPath; });

  const root = await temporaryDirectory('worker-check', process.cwd());
  const stub = await temporaryDirectory('docker', root);
  writeFileSync(join(stub, 'docker'), `#!/bin/sh
case "$*" in
  *" config "*) printf '%s' '{"services":{"db":{"image":"postgres:16-alpine"}}}' ;;
  "ps --quiet --filter"*) echo 0123456789ab ;;
esac
`, { mode: 0o755 });
  symlinkSync(execPath, join(stub, 'node'));
  process.execPath = join(stub, 'node');
  const resolver = join(stub, 'compose-dns.mjs');
  writeFileSync(resolver, `import dns from 'node:dns';
const lookup = dns.lookup;
dns.lookup = (host, options, callback) => lookup(host === 'db' ? '127.0.0.1' : host, options, callback);
`);

  const store = await withDatabase('worker-runs-declared-check');
  await store.init(); t.after(() => store.close());
  const engine = new Engine(store, 600, 'owner/project'); engine.gitRunner = null;
  const worker = { id: 'worker', role: 'worker' as const }, operator = { id: 'operator', role: 'admin' as const, sessionKind: 'human' as const };
  const credentials = [{ ...worker, token: 'worker-test-token' }, { id: 'other-worker', role: 'worker' as const, token: 'other-test-token' }, { id: 'host', role: 'coordinator' as const, token: 'host-test-token' }];
  engine.principals = [operator, ...credentials];
  let work = await engine.execute(operator, 'create', null, { type: 'feature', title: 'Declared check', criteria: [{ id: 'AC-1', text: 'Queries db', proofs: ['e2e:fixture'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());

  // The coordinator checkout, and the worker's assigned worktree on graphyard/<key>-<epoch>.
  const coordinator = await temporaryDirectory('coordinator', root), base = await temporaryDirectory('trials', root);
  const branch = `graphyard/${work.key.toLowerCase()}-1`, repository = join(root, 'worker');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  git(coordinator, 'init', '-q', '-b', 'main'); git(coordinator, 'config', 'user.name', 'Fixture'); git(coordinator, 'config', 'user.email', 'fixture@example.invalid');
  git(coordinator, 'commit', '--allow-empty', '-qm', 'base');
  git(coordinator, 'worktree', 'add', '-qb', branch, repository);
  const query = (sql: string) => `import net from 'node:net';
const socket = net.connect({ host: process.env.GRAPHYARD_SERVICE_DB_HOST, port: Number(process.env.GRAPHYARD_SERVICE_DB_PORT) });
let answer = '';
socket.on('data', chunk => { answer += chunk; });
socket.on('end', () => { console.log(answer.trim()); process.exit(answer.startsWith('ERROR') ? 1 : 0); });
socket.write(${JSON.stringify(sql)});
`;
  writeFileSync(join(repository, '.gitignore'), '.graphyard/\n');
  writeFileSync(join(repository, 'compose.yml'), 'services:\n  db:\n    image: postgres:16-alpine\n');
  writeFileSync(join(repository, 'graphyard.json'), JSON.stringify({ delivery: { mergeGate: { perCandidate: [], preMerge: [
    { check: 'lint', command: 'node -e "process.exit(3)"', source: 'script', reason: 'fixture' },
    { check: 'verify', command: 'node query.mjs', source: 'script', reason: 'fixture', paths: ['src/**'], services: [{ file: 'compose.yml', service: 'db', port }] },
  ] } } }));
  writeFileSync(join(repository, 'query.mjs'), query('select 1 as answer'));
  git(repository, 'add', '-A'); git(repository, 'commit', '-qm', 'a check with a postgres service');
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'test', path: repository, branch }, randomUUID());

  const http = server(engine, credentials);
  await new Promise<void>(done => http.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => http.close(() => done())));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const mutate = async (path: string, data: unknown) => {
    const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: 'Bearer host-test-token', 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    return result;
  };
  // The host loop's own pump, its trial children unwrapped and given the service-name resolver.
  const run: ChildRun = (command, args, options = {}) => command === 'git' ? defaultChildRun(command, args, options)
    : defaultChildRun(command, args, { ...options, wrapper: undefined, env: { ...options.env, NODE_OPTIONS: `--import=${resolver}` } });
  const pump = workerVerificationPump(coordinator, () => 'test', mutate, () => base,
    request => runWorkerCheck({ ...request, trial: input => runTrial({ ...input, run, environment: { PATH: hostPath } }) }));
  const pumping = setInterval(() => { void pump().catch(() => {}); }, 50);
  t.after(() => clearInterval(pumping));

  let wrapper: readonly string[] | undefined;
  try { execFileSync('bwrap', ['--ro-bind', '/', '/', '--', 'true'], { stdio: 'ignore' }); wrapper = readOnlyMountWrapper({ coordinatorRoot: coordinator, sessionDirectory: repository, secretsBus: null }); }
  catch { wrapper = undefined; }
  const asWorker = async (token: string, args: string[]) => {
    const env = { PATH: hostPath, HOME: process.env.HOME!, GRAPHYARD_URL: url, GRAPHYARD_TOKEN: token };
    try { return { code: 0, out: await defaultChildRun(execPath, args, { cwd: repository, env, wrapper, timeoutMs: 240_000 }) }; }
    catch (error: any) { return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }; }
  };

  const docker = await asWorker('worker-test-token', ['-e', `require('node:net').createConnection('/var/run/docker.sock').on('connect', () => process.exit(9)).on('error', () => process.exit(0))`]);
  assert.equal(docker.code, 0, 'the worker sandbox reaches no Docker socket');

  const passing = await asWorker('worker-test-token', [cli, 'check', 'verify']);
  assert.equal(passing.code, 0, passing.out);
  assert.match(passing.out, /"answer":1/);
  assert.match(passing.out, /check verify passed on [0-9a-f]{12}/);

  writeFileSync(join(repository, 'query.mjs'), query('select * from no_such_table'));
  git(repository, 'commit', '-qam', 'a failing query');
  const failing = await asWorker('worker-test-token', [cli, 'check', 'verify', work.key]);
  assert.equal(failing.code, 1, failing.out);
  assert.match(failing.out, /no_such_table/);
  assert.match(failing.out, new RegExp(`check verify failed on ${git(repository, 'rev-parse', 'HEAD').slice(0, 12)}`));

  const unknown = await asWorker('worker-test-token', [cli, 'check', 'nope']);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.out, /No pre-merge check named nope; this head declares: lint, verify/);

  const refused = await asWorker('other-test-token', [cli, 'check', 'verify', work.key]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /Lease missing, expired, or superseded/);
});
