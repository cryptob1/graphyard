import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { heavyRunLabel } from './helpers/run-tests.js';
import { heldSlots, heldVariable, hostHeavyJobsDirectory, projectVariable, slotsDirectoryVariable, verificationEnvironment } from '../src/master/verification-slots.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';

// GY-3447: since GY-3290 a worker's own `npm run build` and selected tests waited for one of the
// host's two heavy-job slots while a batch gate and a merge trial held both for 45+ minutes. Only
// merge trials, batch gates, whole suites and deploy builds take a slot now; a worker's build,
// type check, selected tests and host-run check start at once, under the session's fair share.

const launcher = join(import.meta.dirname, 'helpers', 'heavy-job-launcher.ts'), checkout = join(import.meta.dirname, '..');
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const until = async (condition: () => boolean, what: string, timeoutMs = 60_000) => {
  for (const deadline = Date.now() + timeoutMs; !condition();) { assert.ok(Date.now() < deadline, `timed out waiting until ${what}`); await sleep(25); }
};
const waiting = /waits for a host heavy-job slot|waiting for a host heavy-job slot/;

/** Two item trials fill the ordinary host slots and a batch gate holds the reservation until `go`. */
async function fullHost() {
  const scratch = await temporaryDirectory('worker-verify'), data = join(scratch, 'data'), log = join(scratch, 'runs.log'), go = join(scratch, 'go');
  const root = join(scratch, 'app'), managed = join(scratch, 'managed');
  mkdirSync(root); mkdirSync(managed); writeFileSync(log, '');
  // The worker's commands: each script records that it ran and finishes at once.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { build: 'node job.mjs', 'test:affected': 'node job.mjs', test: 'node job.mjs' } }));
  writeFileSync(join(root, 'job.mjs'), `import { appendFileSync } from 'node:fs'; appendFileSync(process.env.RUN_LOG, 'start ' + process.env.JOB_ID + '\\nend ' + process.env.JOB_ID + '\\n');\n`);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.com', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-qm', 'fixture');
  const base = { PATH: process.env.PATH, HOME: process.env.HOME, GRAPHYARD_DATA_HOME: data, RUN_GO: go, RUN_LOG: log };
  const started: ChildProcess[] = [];
  after(() => { for (const child of started) child.kill('SIGKILL'); });
  const track = (id: string, child: ChildProcess) => {
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    started.push(child);
    return { id, stderr: () => stderr, closed: once(child, 'close').then(([code]) => code as number | null) };
  };
  const events = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => line.split(' ') as [string, string]);
  const fixture = {
    directory: hostHeavyJobsDirectory(base), events, go: () => writeFileSync(go, ''),
    ran: (id: string) => events().some(([event, job]) => event === 'start' && job === id),
    /** A worker session's command, typed as it types it: through the wrappers its harness puts first on PATH. */
    session: (id: string, args: string[]) => track(id, spawn('npm', args, { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], env: { ...base, ...verificationEnvironment('acme/app', base), JOB_ID: id } })),
    /** The loop's own trial, check or gate, in its own process. */
    launch: (mode: string, id: string, project = 'acme/app') => track(id, spawn(process.execPath, ['--import', 'tsx', launcher, mode, id, root, managed],
      { stdio: ['ignore', 'ignore', 'pipe'], env: { ...base, FIXTURE_PROJECT: project } })),
  };
  const holders = [fixture.launch('trial', 'GY-1'), fixture.launch('trial', 'GY-2'), fixture.launch('gate', 'gate-site', 'acme/site')];
  await until(() => fixture.ran('GY-1') && fixture.ran('GY-2') && fixture.ran('gate-site'), 'two merge trials and a batch gate fill the host budget');
  assert.equal(heldSlots(fixture.directory).length, 3);
  return { ...fixture, holders, scratch };
}

test('integration:worker-verify-not-queued — with both ordinary slots held by merge trials and the reservation held by a batch gate, a worker build and selected tests start at once; a merge trial and a whole suite still wait', { timeout: 180_000 }, async () => {
  const host = await fullHost();
  // A worker's build, its affected tests, a named test file and its host-run check: none waits.
  const worker = [host.session('build', ['run', 'build']), host.session('affected', ['run', 'test:affected']), host.session('selected', ['test', '--', 'tests/a.test.ts'])];
  for (const job of worker) assert.equal(await job.closed, 0, job.stderr());
  for (const job of worker) { assert.ok(host.ran(job.id), `${job.id} ran`); assert.doesNotMatch(job.stderr(), waiting); }
  const check = host.launch('check', 'GY-3');
  await until(() => host.ran('GY-3'), 'the worker check starts beside the holders');
  assert.doesNotMatch(check.stderr(), waiting);

  // This repository's own runner: a selected run (`npm run test:affected`) and a type check (`npm run build`) take no slot.
  assert.equal(heavyRunLabel('typecheck', []), null);
  assert.equal(heavyRunLabel('test', ['tests/a.test.ts']), null);
  assert.equal(heavyRunLabel('test', ['--files-from', 'list']), null);
  assert.equal(heavyRunLabel('browser', ['browser-tests/a.spec.ts']), null);
  assert.equal(heavyRunLabel('test', []), 'npm test', 'a whole suite still takes a slot');
  assert.equal(heavyRunLabel('browser', []), 'npm run test:browser');
  const list = join(host.scratch, 'none.txt');
  writeFileSync(list, '');
  const environment: NodeJS.ProcessEnv = { ...process.env, [slotsDirectoryVariable]: host.directory, [projectVariable]: 'acme/app' };
  delete environment[heldVariable];
  const runner = spawn(process.execPath, ['--import', 'tsx', 'tests/helpers/run-tests.ts', '--files-from', list], { cwd: checkout, env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
  let runnerErr = '';
  runner.stderr.on('data', chunk => { runnerErr += chunk; });
  const [code] = await Promise.race([once(runner, 'close'), sleep(60_000).then(() => [`still waiting: ${runnerErr}`])]);
  assert.equal(code, 0, runnerErr);
  assert.doesNotMatch(runnerErr, waiting);

  // A merge trial and a worker's whole suite still wait for a slot, naming the holders.
  const trial = host.launch('trial', 'GY-4'), suite = host.session('suite', ['test']);
  await until(() => waiting.test(trial.stderr()) && waiting.test(suite.stderr()), 'the merge trial and the whole suite wait');
  assert.ok(!host.ran('GY-4') && !host.ran('suite'), 'neither starts while both slots are held');
  for (const holder of ['merge trial GY-1 (acme/app)', 'merge trial GY-2 (acme/app)', 'merge trial batch-gate (acme/site)']) {
    assert.ok(suite.stderr().includes(holder), `the waiting suite names ${holder}: ${suite.stderr()}`);
  }

  host.go();
  for (const job of [...host.holders, check, trial, suite]) assert.equal(await job.closed, 0, job.stderr());
  assert.ok(host.ran('GY-4') && host.ran('suite'), 'both ran once a slot freed');
  let running = 0, peak = 0;
  for (const [event, id] of host.events()) if (['GY-1', 'GY-2', 'gate-site', 'GY-4', 'suite'].includes(id)) { running += event === 'start' ? 1 : -1; peak = Math.max(peak, running); }
  assert.equal(peak, 3, 'two ordinary jobs plus one reserved gate never exceed the budget');
  assert.deepEqual(heldSlots(host.directory), []);
});

test('e2e:worker-verify-not-queued — while trials fill the host budget a worker completes its build and tests without waiting, and master status names the slot holders', { timeout: 120_000 }, async () => {
  const host = await fullHost();
  const worker = [host.session('build', ['run', 'build']), host.session('affected', ['run', 'test:affected'])];
  for (const job of worker) { assert.equal(await job.closed, 0, job.stderr()); assert.doesNotMatch(job.stderr(), waiting); assert.ok(host.ran(job.id)); }
  assert.equal(heldSlots(host.directory).length, 3, 'the trials still hold both ordinary slots and the reservation');

  const root = await temporaryDirectory('worker-verify-status');
  const master = masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'acme/app', baseBranch: 'main', githubAppId: 1234, hostId: 'loop-host', masterAgentName: 'graphyard-master-slots', workers: [],
  }) as MasterConfig;
  const previous = process.env[slotsDirectoryVariable];
  process.env[slotsDirectoryVariable] = host.directory;
  try {
    const report = await masterStatusReport(root, master, async () => ({ work: [], now: new Date().toISOString() }), async () => { throw new Error('no git in the fixture'); });
    assert.equal(report.heavyJobs.limit, 2);
    assert.deepEqual(report.heavyJobs.holders.map(holder => `${holder.label} (${holder.project})`).sort(), ['merge trial GY-1 (acme/app)', 'merge trial GY-2 (acme/app)', 'merge trial batch-gate (acme/site)']);
    for (const holder of report.heavyJobs.holders) { assert.ok(holder.pid! > 0); assert.ok(holder.since); }
  } finally { if (previous === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = previous; }
  host.go();
  for (const job of host.holders) assert.equal(await job.closed, 0, job.stderr());
});
