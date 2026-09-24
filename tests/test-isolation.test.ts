import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedTestEnvironment, reserveTestPorts, testPortEnvironment } from '../src/cli/test-isolation.js';
import { countProofCases, runProof } from '../src/cli/verify.js';
import { bindEvidence, leaseCommands } from '../src/cli/lease.js';
import { githubPauseReset, pauseRetry, submitThroughPause } from '../src/cli/complete.js';
import { ensureWorktreeDependencies, installMatchesLockfile } from '../src/repository-setup.js';
import { runTests } from './helpers/run-tests.js';

const repository = new URL('..', import.meta.url);
const scratch = (prefix: string) => mkdtemp(join(tmpdir(), `graphyard-isolation-${prefix}-`));
const listen = (port = 0) => new Promise<{ port: number; close(): Promise<void> }>((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve({ port: (server.address() as { port: number }).port, close: () => new Promise(done => server.close(() => done())) }));
});
/** A pid no process holds any more: a child that has already exited. */
const exitedPid = () => new Promise<number>(resolve => { const child = spawn(process.execPath, ['-e', '']); child.once('exit', () => resolve(child.pid!)); });

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

test('unit:test-isolation reserves a free port window per run: held and busy windows are skipped, an exited holder is reclaimed', async () => {
  const locks = await scratch('locks');
  try {
    const busy = await listen();
    try {
      const options = { first: busy.port, span: 4, last: busy.port + 400, lockDirectories: [locks] };
      const first = await reserveTestPorts(options);
      assert.ok(first.base > busy.port, 'the window holding a listening port is skipped');
      const second = await reserveTestPorts(options);
      assert.ok(second.base >= first.base + first.span, 'a window another live run holds is skipped');
      first.release();
      const again = await reserveTestPorts(options);
      assert.equal(again.base, first.base, 'a released window is free again');
      again.release(); second.release();
      await writeFile(join(locks, `${first.base}.lock`), `${await exitedPid()}\n`);
      const reclaimed = await reserveTestPorts(options);
      assert.equal(reclaimed.base, first.base, 'a lock whose run has exited does not hold the window');
      reclaimed.release();
      assert.deepEqual(await readdir(locks), []);
    } finally { await busy.close(); }
  } finally { await rm(locks, { recursive: true, force: true }); }
});

test('unit:test-isolation two concurrent test runs on one host both pass', async () => {
  const project = await scratch('project'), locks = await scratch('locks');
  try {
    await mkdir(join(project, 'tests'));
    // Stands in for a database-backed test file: it holds base + 7 for a while, as its Postgres
    // would, and fails if it can see the session's credentials.
    await writeFile(join(project, 'tests', 'database.test.ts'), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
test('holds its database port', async () => {
  assert.deepEqual(Object.keys(process.env).filter(name => /^(GRAPHYARD|HERDR)_/.test(name)).sort(), ['GRAPHYARD_EVENTS_TEST_PORT', 'GRAPHYARD_TEST_PORT']);
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 7;
  const server = createServer();
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen({ port, host: '127.0.0.1', exclusive: true }, () => ok()); });
  await new Promise(done => setTimeout(done, 1500));
  await new Promise(done => server.close(done));
});
`);
    const environment = { ...process.env, GRAPHYARD_TOKEN: 'session-credential', GRAPHYARD_TOKEN_FILE: '/run/credential', HERDR_PANE: 'w1:p1', GRAPHYARD_TEST_PORT: '15438' };
    const runs = await Promise.all([0, 1].map(() => runTests({ cwd: project, environment, stdio: 'pipe', ports: { span: 20, lockDirectories: [locks] } })));
    for (const run of runs) assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.notEqual(runs[0].base, runs[1].base, 'each run held its own window');
    assert.ok(runs.every(run => run.environment.GRAPHYARD_TOKEN === undefined && run.environment.HERDR_PANE === undefined));
  } finally { await rm(project, { recursive: true, force: true }); await rm(locks, { recursive: true, force: true }); }
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
    const lock = (version: string) => ({ name: 'app', lockfileVersion: 3, packages: { '': { name: 'app' }, 'node_modules/left-pad': { version, integrity: `sha512-${version}` }, 'node_modules/@esbuild/darwin-arm64': { version: '0.1.0', optional: true } } });
    await writeFile(join(root, 'node_modules', '.package-lock.json'), JSON.stringify({ name: 'app', lockfileVersion: 3, packages: { 'node_modules/left-pad': { version: '1.0.0', integrity: 'sha512-1.0.0' } } }));
    const installs: string[] = [];
    const installer = async (cwd: string) => { installs.push(cwd); };

    await writeFile(join(worktree, 'package-lock.json'), JSON.stringify(lock('1.0.0')));
    const shared = await ensureWorktreeDependencies(worktree, installer);
    assert.equal(shared.state, 'current', shared.reason);
    assert.equal(shared.install, join(root, 'node_modules'));
    assert.deepEqual(installs, [], 'an install that matches the lockfile is used as it is');

    await writeFile(join(worktree, 'package-lock.json'), JSON.stringify(lock('2.0.0')));
    const changed = await ensureWorktreeDependencies(worktree, installer);
    assert.equal(changed.state, 'installed', changed.reason);
    assert.deepEqual(installs, [worktree], 'a changed lockfile is installed in the worktree itself');
    assert.match(changed.reason, /left-pad is installed at 1\.0\.0, package-lock\.json names 2\.0\.0/);

    const failed = await ensureWorktreeDependencies(worktree, async () => { throw new Error('npm ci exited with 1'); });
    assert.equal(failed.state, 'failed'); assert.match(failed.reason, /npm ci exited with 1/);

    await mkdir(join(worktree, 'node_modules'));
    await writeFile(join(worktree, 'node_modules', '.package-lock.json'), JSON.stringify({ packages: { 'node_modules/left-pad': { version: '2.0.0', integrity: 'sha512-2.0.0' } } }));
    assert.equal((await ensureWorktreeDependencies(worktree, installer)).state, 'current', 'the worktree\'s own matching install is kept');
    assert.equal(installs.length, 1);

    assert.equal(installMatchesLockfile(lock('1.0.0'), { packages: {} }), 'node_modules/left-pad is named by package-lock.json but not installed');
    assert.equal(installMatchesLockfile(lock('1.0.0'), null), 'the install records no hidden lockfile (node_modules/.package-lock.json)');
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
    const locks = join(project, 'locks');
    const run = await runProof(project, 'unit:demo', ['tests/demo.test.ts'], { span: 20, lockDirectories: [locks] });
    assert.deepEqual(run, { result: 'pass', executed: 2, failed: 0, skipped: 0, files: ['tests/demo.test.ts'] });
    assert.ok(existsSync(marker), 'the file ran whole: its other cases ran too, rather than being reported as skipped');

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
  assert.deepEqual(bindEvidence({ proof: 'unit:x', result: 'pass', executed: 3, skipped: 0 }, work), { proof: 'unit:x', result: 'pass', executed: 3, skipped: 0, sha, baseSha, policyRevision: 4 });
  const explicit = { proof: 'unit:x', sha: 'c'.repeat(40), baseSha: 'd'.repeat(40), policyRevision: 2 };
  assert.deepEqual(bindEvidence(explicit, work), explicit, 'values the file carries are sent as written');
  assert.throws(() => bindEvidence({ proof: 'unit:x' }, { key: 'GY-1', candidate: null, policyRevision: 1 }), /GY-1 has no observed candidate yet/);

  const file = join(await scratch('evidence'), 'evidence.json');
  try {
    await writeFile(file, JSON.stringify({ proof: 'unit:x', result: 'pass', executed: 1, skipped: 0 }));
    const sent: { path: string; data: unknown }[] = [];
    const command = leaseCommands.find(entry => entry.name === 'evidence')!;
    await command.run({ args: [file], api: async (path: string, data: unknown) => { sent.push({ path, data }); return { ok: true }; }, print: () => {} } as any, work);
    assert.deepEqual(sent, [{ path: 'work/work-1/evidence', data: { proof: 'unit:x', result: 'pass', executed: 1, skipped: 0, sha, baseSha, policyRevision: 4 } }]);
  } finally { await rm(join(file, '..'), { recursive: true, force: true }); }
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
