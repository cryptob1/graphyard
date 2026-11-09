import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { gateCheckSchema } from '../src/model-boundary/delivery-policy.js';
import { declaredPreMerge, repositoryTrialChecks, runTrial } from '../src/merge-writer/trial.js';
import { composeProjectPrefix, tcpAcceptProbe, type startCheckServices } from '../src/compose-preview.js';

// GY-3209: a pre-merge check can declare Compose services the trial starts beside it.

const identity = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
const nested = existsSync('/etc/graphyard-trial');
const services = [{ file: 'compose.yml', service: 'db', port: 5432 }, { file: 'compose.yml', service: 'cache-store', port: 6379 }];
const check = (extra: Record<string, unknown> = {}) => ({ check: 'db', command: 'node query.mjs', source: 'script', reason: 'fixture', services, ...extra });
const changed = ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts'];

async function repository(files: Record<string, string>) {
  const root = await temporaryDirectory('check-services-repo'), base = await temporaryDirectory('check-services-base');
  git(root, 'init', '-q', '-b', 'main');
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'base');
  return { root, base, mergeSha: git(root, 'rev-parse', 'HEAD') };
}
const policy = (preMerge: unknown[]) => JSON.stringify({ delivery: { mergeGate: { perCandidate: [], preMerge } } });

/** A trial whose children are faked (git runs for real) and whose services start is a fake recording each start and removal. */
async function fakeTrial(preMerge: unknown[], options: { fail?: boolean; probeFails?: boolean; startFails?: boolean } = {}) {
  const fixture = await repository({ 'graphyard.json': policy(preMerge) });
  const calls: { argv: string[]; env: Record<string, string>; wrapper: readonly string[] }[] = [];
  const started: Parameters<typeof startCheckServices>[0][] = [];
  let closed = 0;
  const run: ChildRun = async (command, args, childOptions = {}) => {
    if (command === 'git') return defaultChildRun(command, args, childOptions);
    calls.push({ argv: [command, ...args], env: (childOptions.env ?? {}) as Record<string, string>, wrapper: childOptions.wrapper ?? [] });
    if (args[0] === '-e') {
      if (options.probeFails) throw Object.assign(new Error('probe'), { status: 1, stdout: '', stderr: 'db:5432 accepted no TCP connection in time' });
      return 'accepts TCP connections';
    }
    if (args[0] === 'select.mjs') return changed.join('\n');
    if (options.fail) throw Object.assign(new Error('check failed'), { status: 1, stdout: 'connection refused', stderr: '' });
    return 'ok';
  };
  const fake: typeof startCheckServices = async request => {
    started.push(request);
    if (options.startFails) throw new Error('the Compose file declares no service "db"');
    return { network: 'container:fake-db', close: async () => { closed++; } };
  };
  const verdict = await runTrial({ root: fixture.root, base: fixture.base, mergeSha: fixture.mergeSha, changedFiles: changed, timeoutMs: 60_000, key: 'GY-3209',
    cores: 2, groupSize: 1, retries: 0, memory: async () => ({ totalBytes: 64 * 2 ** 30, availableBytes: 32 * 2 ** 30 }), environment: { PATH: process.env.PATH! }, run, services: fake });
  return { verdict, calls, started, closed: () => closed };
}
const joins = (wrapper: readonly string[], network: string) => nested || wrapper.some(word => word.includes(`"network":${JSON.stringify(network)}`));

test('unit:tests/premerge-check-services.test.ts — the delivery schema accepts a check\'s services from one Compose file and the trial reads them', () => {
  assert.equal(gateCheckSchema.safeParse(check()).success, true);
  assert.equal(gateCheckSchema.safeParse(check({ services: [services[0], { ...services[1], file: 'other.yml' }] })).success, false);
  assert.equal(gateCheckSchema.safeParse(check({ services: [{ file: 'compose.yml', service: 'db' }] })).success, false);
  const declared = declaredPreMerge(policy([check()]));
  assert.ok('preMerge' in declared && declared.preMerge);
  assert.deepEqual(repositoryTrialChecks({ preMerge: declared.preMerge }), [{ check: 'db', argv: ['node', 'query.mjs'], services }]);
});

test('unit:tests/premerge-check-services.test.ts — a check with services runs on their network with each service\'s host and port, after they accept TCP, and they are removed after a pass', { timeout: 60_000 }, async () => {
  const { verdict, calls, started, closed } = await fakeTrial([check()]);
  assert.deepEqual(verdict.tests, { passed: 1, failed: [], files: 1 }, verdict.logTail);
  assert.equal(started.length, 1);
  assert.deepEqual(started[0]!.services, services);
  const probe = calls.findIndex(call => call.argv[1] === '-e'), query = calls.findIndex(call => call.argv[1] === 'query.mjs');
  assert.ok(probe >= 0 && probe < query, 'the TCP readiness wait runs before the check');
  assert.deepEqual(calls[probe]!.argv.slice(3), ['db:5432', 'cache-store:6379']);
  for (const call of [calls[probe]!, calls[query]!]) {
    assert.ok(joins(call.wrapper, 'container:fake-db'), 'the child joins the services\' network');
    assert.equal(call.env.GRAPHYARD_SERVICE_DB_HOST, 'db');
    assert.equal(call.env.GRAPHYARD_SERVICE_DB_PORT, '5432');
    assert.equal(call.env.GRAPHYARD_SERVICE_CACHE_STORE_HOST, 'cache-store');
    assert.equal(call.env.GRAPHYARD_SERVICE_CACHE_STORE_PORT, '6379');
  }
  assert.equal(closed(), 1);
});

test('unit:tests/premerge-check-services.test.ts — a selection check with services starts them once and every shard shares them', { timeout: 60_000 }, async () => {
  const { verdict, calls, started, closed } = await fakeTrial([check({ command: 'node run.mjs', selection: { command: 'node select.mjs', pattern: '^tests/' } })]);
  assert.deepEqual(verdict.tests, { passed: 3, failed: [], files: 3 }, verdict.logTail);
  const shards = calls.filter(call => call.argv[1] === 'run.mjs');
  assert.equal(shards.length, 3);
  assert.equal(started.length, 1);
  for (const shard of shards) {
    assert.ok(joins(shard.wrapper, 'container:fake-db'));
    assert.equal(shard.env.GRAPHYARD_SERVICE_DB_HOST, 'db');
  }
  assert.equal(closed(), 1);
});

test('unit:tests/premerge-check-services.test.ts — the services are removed when the check fails, and services that never start or accept fail the check naming why', { timeout: 60_000 }, async () => {
  const failing = await fakeTrial([check()], { fail: true });
  assert.deepEqual(failing.verdict.tests.failed, ['db']);
  assert.equal(failing.closed(), 1);
  const unready = await fakeTrial([check()], { probeFails: true });
  assert.deepEqual(unready.verdict.tests.failed, ['db']);
  assert.match(unready.verdict.failingCase ?? '', /accepted no TCP connection/);
  assert.equal(unready.calls.some(call => call.argv[1] === 'query.mjs'), false);
  assert.equal(unready.closed(), 1);
  const refused = await fakeTrial([check()], { startFails: true });
  assert.deepEqual(refused.verdict.tests.failed, ['db']);
  assert.match(refused.verdict.failingCase ?? '', /services of check db did not start: .*declares no service "db"/);
});

test('unit:tests/premerge-check-services.test.ts — a check without services runs as before: no stack, no probe, no service variables, the trial\'s own network', { timeout: 60_000 }, async () => {
  const { verdict, calls, started } = await fakeTrial([{ check: 'lint', command: 'node lint.mjs', source: 'script', reason: 'fixture' }]);
  assert.deepEqual(verdict.tests, { passed: 1, failed: [], files: 1 }, verdict.logTail);
  assert.equal(started.length, 0);
  assert.deepEqual(calls.map(call => call.argv), [['node', 'lint.mjs']]);
  assert.ok(joins(calls[0]!.wrapper, 'bridge'));
  assert.equal(Object.keys(calls[0]!.env).some(name => name.startsWith('GRAPHYARD_SERVICE_')), false);
});

test('unit:tests/premerge-check-services.test.ts — the TCP readiness wait connects until each port accepts, and fails naming one that never does', { timeout: 30_000 }, async () => {
  const probe = (targets: { host: string; port: number }[], timeoutMs: number) => new Promise<{ code: number; out: string }>(done => {
    const [command, ...args] = tcpAcceptProbe(targets, timeoutMs);
    execFile(command === 'node' ? process.execPath : command!, args, (error, stdout, stderr) => done({ code: error ? Number(error.code) : 0, out: stdout + stderr }));
  });
  const reserve = () => new Promise<number>(done => { const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => done(port)); }); });
  // A service that listens only after a while is waited for.
  const late = await reserve();
  const server = createServer(socket => socket.end());
  setTimeout(() => server.listen(late, '127.0.0.1'), 700);
  try {
    const ready = await probe([{ host: '127.0.0.1', port: late }], 10_000);
    assert.equal(ready.code, 0, ready.out);
    assert.match(ready.out, new RegExp(`127\\.0\\.0\\.1:${late} accepts TCP connections`));
  } finally { server.close(); }
  const closed = await reserve();
  const never = await probe([{ host: '127.0.0.1', port: closed }], 600);
  assert.equal(never.code, 1);
  assert.match(never.out, new RegExp(`127\\.0\\.0\\.1:${closed} accepted no TCP connection in time`));
});

// AC-3: a real merge trial on a fixture whose check queries a stock postgres service. It needs Docker, so it runs
// from the e2e case premerge-check-services on the host-side Compose path, which sets GRAPHYARD_SERVICES_E2E.
const installedModules = resolve(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), '..');
test('e2e:premerge-check-services — a real trial starts a postgres service beside the check: a passing query passes, a failing one fails, and no container is left', {
  timeout: 900_000, skip: process.env.GRAPHYARD_SERVICES_E2E === '1' ? false : 'runs from e2e case premerge-check-services, where Docker is',
}, async () => {
  assert.equal(nested, false, 'the case runs on the host, where Docker is');
  const query = (sql: string) => `import pg from 'pg';
const client = new pg.Client({ host: process.env.GRAPHYARD_SERVICE_DB_HOST, port: Number(process.env.GRAPHYARD_SERVICE_DB_PORT), user: 'postgres', password: 'fixture', database: 'postgres' });
await client.connect();
try { console.log(JSON.stringify((await client.query(${JSON.stringify(sql)})).rows)); } finally { await client.end(); }
`;
  const fixture = await repository({
    '.gitignore': 'node_modules\n',
    'package.json': JSON.stringify({ name: 'fixture', private: true, scripts: {} }),
    'package-lock.json': '{"lockfileVersion":3}\n',
    'compose.yml': 'services:\n  db:\n    image: postgres:16-alpine\n    environment:\n      POSTGRES_PASSWORD: fixture\n',
    'graphyard.json': policy([{ check: 'db', command: 'node query.mjs', source: 'script', reason: 'fixture', services: [{ file: 'compose.yml', service: 'db', port: 5432 }] }]),
    'query.mjs': query('select 1 as answer'),
  });
  symlinkSync(installedModules, join(fixture.root, 'node_modules'));
  const trial = (mergeSha: string) => runTrial({ root: fixture.root, base: fixture.base, mergeSha, changedFiles: ['query.mjs'], timeoutMs: 600_000, key: 'GY-3209-E2E', retries: 0, environment: { PATH: process.env.PATH! } });
  const leftovers = () => execFileSync('docker', ['ps', '--all', '--format', '{{.Label "com.docker.compose.project"}}'], { encoding: 'utf8' })
    .split('\n').filter(project => project.startsWith(`${composeProjectPrefix}trial-services-gy-3209-e2e`));
  const passing = await trial(fixture.mergeSha);
  assert.deepEqual(passing.tests, { passed: 1, failed: [], files: 1 }, passing.logTail);
  assert.match(passing.logTail, /"answer":1/);
  assert.deepEqual(leftovers(), []);
  writeFileSync(join(fixture.root, 'query.mjs'), query('select * from no_such_table'));
  git(fixture.root, 'commit', '-qam', 'a failing query');
  const failing = await trial(git(fixture.root, 'rev-parse', 'HEAD'));
  assert.deepEqual(failing.tests.failed, ['db'], failing.logTail);
  assert.match(failing.logTail, /no_such_table/);
  assert.deepEqual(leftovers(), []);
});
