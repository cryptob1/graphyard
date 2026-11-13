import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join, relative } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { sessionSlotsGrant } from '../src/master/harness.js';
import { heavyCommand, heavyJobLimit, heldSlots, hostHeavyJobsDirectory, slotsDirectoryVariable, verificationBin, verificationEnvironment, waitStep, withHeavyJob } from '../src/master/verification-slots.js';

// GY-3290: every Graphyard project of one user on one host shares one heavy-job budget. On
// 13 November 2026 a 24-core host shared by several projects sat at load 50–86 and local
// verification timed out: each project bounded only its own runs, under its own managed root.

const launcher = join(import.meta.dirname, 'helpers', 'heavy-job-launcher.ts');
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const until = async (condition: () => boolean, what: string, timeoutMs = 60_000) => {
  for (const deadline = Date.now() + timeoutMs; !condition();) { assert.ok(Date.now() < deadline, `timed out waiting until ${what}`); await sleep(25); }
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.com', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();

/** One host: a data directory two fixture installs share, each install its own repository, managed root and project. */
async function host() {
  const scratch = await temporaryDirectory('heavy-budget'), data = join(scratch, 'data'), log = join(scratch, 'runs.log');
  writeFileSync(log, '');
  const installs = ['acme/app', 'acme/site'].map(project => {
    const root = join(scratch, project.replace('/', '-')), managed = join(scratch, `${project.replace('/', '-')}-managed`);
    mkdirSync(join(root, 'site'), { recursive: true }); mkdirSync(managed);
    // The session's commands: each script is the recorded job, and one run with NESTED starts another heavy command through the wrappers.
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { 'test:affected': 'node job.mjs', build: 'node job.mjs', 'build:nested': 'node job.mjs nested' } }));
    writeFileSync(join(root, 'job.mjs'), `import { appendFileSync } from 'node:fs'; import { execFileSync } from 'node:child_process';
const nested = process.argv[2] === 'nested', id = (nested ? 'nested-' : '') + process.env.JOB_ID;
appendFileSync(process.env.RUN_LOG, 'start ' + id + '\\n');
await new Promise(done => setTimeout(done, nested ? 50 : 400));
if (!nested && process.env.NESTED) execFileSync(${JSON.stringify(join(verificationBin, 'npm'))}, ['run', 'build:nested'], { stdio: 'inherit' });
appendFileSync(process.env.RUN_LOG, 'end ' + id + '\\n');\n`);
    writeFileSync(join(root, 'site', 'index.html'), '<h1>Site</h1>');
    git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'fixture');
    return { project, root, managed };
  });
  const base = { PATH: process.env.PATH, HOME: process.env.HOME, GRAPHYARD_DATA_HOME: data };
  const started: { id: string; project: string; child: ChildProcess; stderr: () => string; closed: Promise<number | null> }[] = [];
  const track = (id: string, project: string, child: ChildProcess) => {
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    const job = { id, project, child, stderr: () => stderr, closed: once(child, 'close').then(([code]) => code as number | null) };
    started.push(job);
    return job;
  };
  return {
    scratch, data, log, installs, started, directory: hostHeavyJobsDirectory(base),
    /** A worker session's command, typed as the session types it: through the wrappers its harness puts first on PATH. */
    session: (install: typeof installs[number], id: string, script: string, nested = false) => track(id, install.project, spawn('npm', ['run', script],
      { cwd: install.root, stdio: ['ignore', 'ignore', 'pipe'], env: { ...base, ...verificationEnvironment(install.project, base), RUN_LOG: log, JOB_ID: id, ...(nested ? { NESTED: '1' } : {}) } })),
    /** The install's loop or deploy watch: its own process, running one job through the entry point `mode` names. */
    launch: (install: typeof installs[number], mode: string, id: string) => track(id, install.project, spawn(process.execPath, ['--import', 'tsx', launcher, mode, id, install.root, install.managed],
      { stdio: ['ignore', 'ignore', 'pipe'], env: { ...base, RUN_LOG: log, FIXTURE_PROJECT: install.project } })),
    events: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => line.split(' ') as [string, string]),
  };
}
/** The most jobs that ran at once, nested work aside: it runs inside its parent. */
function peak(events: [string, string][]) {
  let running = 0, most = 0;
  for (const [event, id] of events) if (!id.startsWith('nested-')) { running += event === 'start' ? 1 : -1; most = Math.max(most, running); }
  return most;
}

test('e2e:host-heavy-budget — two installs on one host launch nine heavy jobs from their own processes, and never more than two run at once', { timeout: 180_000 }, async () => {
  const fixture = await host(), [app, site] = fixture.installs;
  // Both installs resolve the one host directory, outside both repositories and both managed roots.
  const environments = fixture.installs.map(install => verificationEnvironment(install.project, { PATH: '/usr/bin', GRAPHYARD_DATA_HOME: fixture.data }));
  assert.equal(environments[0][slotsDirectoryVariable], fixture.directory);
  assert.equal(environments[1][slotsDirectoryVariable], fixture.directory);
  for (const install of fixture.installs) for (const path of [install.root, install.managed]) assert.ok(relative(path, fixture.directory).startsWith('..'), `${fixture.directory} is outside ${path}`);
  // A session gains the lock directory, its project and the wrappers on PATH: no credential, no other variable.
  assert.deepEqual(Object.keys(environments[0]).sort(), ['GRAPHYARD_HEAVY_JOB_PROJECT', 'GRAPHYARD_VERIFICATION_SLOTS_DIR', 'PATH']);
  assert.equal(heavyJobLimit(fixture.directory), 2, 'two unless the host says otherwise');

  // Worker verification (the affected tests and a build, each nesting another heavy command), merge
  // and batch-gate trials, a host-run worker check, a preview build and a deploy build — across both installs at once.
  const jobs = [
    fixture.session(app, 'affected-app', 'test:affected', true), fixture.session(site, 'build-site', 'build', true),
    fixture.launch(app, 'trial', 'GY-1'), fixture.launch(site, 'trial', 'GY-2'), fixture.launch(app, 'gate', 'gate-app'),
    fixture.launch(site, 'check', 'GY-3'), fixture.launch(app, 'preview', 'preview-app'), fixture.launch(site, 'deploy', 'deploy-site'), fixture.launch(app, 'deploy', 'deploy-app'),
  ];
  const codes = await Promise.all(jobs.map(job => job.closed));
  assert.deepEqual(codes, jobs.map(() => 0), jobs.map(job => `${job.id}: ${job.stderr()}`).join('\n'));
  const events = fixture.events(), ids = ['affected-app', 'build-site', 'GY-1', 'GY-2', 'gate-app', 'GY-3', 'preview-app', 'deploy-site', 'deploy-app'];
  for (const event of ['start', 'end']) assert.deepEqual(events.filter(entry => entry[0] === event && !entry[1].startsWith('nested-')).map(entry => entry[1]).sort(), [...ids].sort(), `every queued job ${event}s`);
  assert.equal(peak(events), 2, `never more than two heavy jobs at once across both installs, and both slots used: ${JSON.stringify(events)}`);
  // Nested work ran inside its parent, on its parent's slot: it neither waited nor counted.
  for (const id of ['affected-app', 'build-site']) {
    const order = events.filter(entry => entry[1].endsWith(id)).map(entry => entry.join(' '));
    assert.deepEqual(order, [`start ${id}`, `start nested-${id}`, `end nested-${id}`, `end ${id}`]);
  }
  // A job that waited said what it waits for and which jobs of which projects hold it — the other install's among them.
  const waits = jobs.flatMap(job => job.stderr().split('\n').filter(line => /waits for a host heavy-job slot|waiting for a host heavy-job slot/.test(line)).map(line => ({ job, line })));
  assert.ok(waits.length >= 7, `seven of nine waited: ${waits.length}`);
  for (const { line } of waits) assert.match(line, /held by .+\(acme\/(app|site)\)/);
  assert.ok(waits.some(({ job, line }) => line.includes(`(${job.project === 'acme/app' ? 'acme/site' : 'acme/app'})`)), 'a waiter names a holder of the other project');
  assert.ok(waits.some(({ line }) => line.includes('every Graphyard project on this host shares 2 at once') && line.includes(join(fixture.directory, 'limit'))), 'and the shared limit, with where it is set');
  assert.deepEqual(heldSlots(fixture.directory), [], 'every slot is given back');
});

test('e2e:host-heavy-budget — nested heavy work under a limit of one runs on its parent\'s slot instead of deadlocking', { timeout: 120_000 }, async () => {
  const fixture = await host(), [app] = fixture.installs;
  mkdirSync(fixture.directory, { recursive: true });
  writeFileSync(join(fixture.directory, 'limit'), '1\n');
  const job = fixture.session(app, 'affected-app', 'test:affected', true);
  assert.equal(await job.closed, 0, job.stderr());
  assert.doesNotMatch(job.stderr(), /waits for a host heavy-job slot/);
  // In one process too: a preview build inside a trial, a trial inside a gate.
  process.env[slotsDirectoryVariable] = fixture.directory;
  try {
    assert.equal(await withHeavyJob('outer', () => withHeavyJob('inner', async () => heldSlots(fixture.directory).length)), 1, 'the inner job holds no second slot');
  } finally { delete process.env[slotsDirectoryVariable]; }
  // This repository's own runner takes the slot itself, so the wrapper leaves its scripts alone; another project's scripts are wrapped.
  assert.equal(heavyCommand('npm', ['test'], join(import.meta.dirname, '..')), false);
  assert.equal(heavyCommand('npm', ['run', 'test:affected'], app.root), true);
  assert.equal(heavyCommand('pnpm', ['build'], app.root), true);
  assert.equal(heavyCommand('npm', ['run', 'dev'], app.root), false);
  assert.equal(heavyCommand('npm', ['install'], app.root), false);
});

test('e2e:host-heavy-budget — a lowered limit keeps running jobs and admits none until below it; finished, failed, cancelled and dead holders all give their slot back', { timeout: 120_000 }, async () => {
  const fixture = await host(), [app, site] = fixture.installs;
  mkdirSync(fixture.directory, { recursive: true });
  const limit = (value: number) => writeFileSync(join(fixture.directory, 'limit'), `${value}\n`);
  const holders = () => heldSlots(fixture.directory).map(entry => entry.owner?.label).sort();
  limit(3);
  const [one, two, three] = [fixture.launch(app, 'hold', 'one'), fixture.launch(site, 'hold', 'two'), fixture.launch(site, 'hold', 'three')];
  await until(() => fixture.events().length === 3, 'three jobs run under a limit of three');

  // The host lowers its limit to two: the three running jobs are untouched, and a new one waits, saying why and behind whom.
  limit(2);
  process.env[slotsDirectoryVariable] = fixture.directory;
  process.env.GRAPHYARD_HEAVY_JOB_PROJECT = 'acme/app';
  try {
    const lines: string[] = [];
    let ran = false;
    const queued = withHeavyJob('merge trial GY-9', async () => { ran = true; return holders(); }, { onWait: line => lines.push(line) });
    await until(() => lines.length === 1, 'the new job reports its wait');
    assert.match(lines[0], /merge trial GY-9 waits for a host heavy-job slot: every Graphyard project on this host shares 2 at once, held by held job one \(acme\/app\) \[pid \d+, .+\]; held job two \(acme\/site\) .+; held job three \(acme\/site\)/);
    assert.equal(waitStep(fixture.directory), 'waiting for a host heavy-job slot, held by held job one (acme/app), held job two (acme/site), held j');
    assert.deepEqual(holders(), ['held job one', 'held job three', 'held job two'], 'every running job keeps its slot');

    // One finishes normally: two still run, which is the limit, so the new job still waits.
    writeFileSync(join(fixture.scratch, `${app.project.replace('/', '-')}-managed`, 'gate-one'), '');
    assert.equal(await one.closed, 0, one.stderr());
    await sleep(2500);
    assert.equal(ran, false, 'nothing is admitted at the lowered limit');
    assert.deepEqual(holders(), ['held job three', 'held job two']);

    // One holder dies (SIGKILL): its slot is reclaimed, the live holder is left alone, and the queued job runs.
    two.child.kill('SIGKILL');
    await two.closed;
    assert.deepEqual(await queued, ['held job three', 'merge trial GY-9'], 'the dead holder\'s slot went to the waiter; the live job kept its own');
    assert.equal(three.child.exitCode, null, 'the live job was never signalled');
    assert.deepEqual(fixture.events().filter(entry => entry[0] === 'end').map(entry => entry[1]), ['one'], 'and is still running');

    // A job that fails gives its slot back, as the one that finished did.
    await assert.rejects(withHeavyJob('failing build', async () => { throw new Error('the build failed'); }), /the build failed/);
    assert.deepEqual(holders(), ['held job three']);

    // A job cancelled while it waits never starts and holds nothing; one cancelled while it runs (SIGTERM) frees its slot.
    limit(1);
    const cancel = new AbortController();
    let started = false;
    const cancelled = withHeavyJob('cancelled trial', async () => { started = true; }, { onWait: () => cancel.abort(new Error('the head was replaced')), signal: cancel.signal });
    await assert.rejects(cancelled, /the head was replaced/);
    assert.equal(started, false);
    three.child.kill('SIGTERM');
    await three.closed;
    assert.deepEqual(await withHeavyJob('next job', async () => holders()), ['next job'], 'the cancelled job\'s slot is taken by the next');
    assert.deepEqual(holders(), []);
  } finally { delete process.env[slotsDirectoryVariable]; delete process.env.GRAPHYARD_HEAVY_JOB_PROJECT; }

  // The lock directory is the only path the budget adds to a session's writable roots.
  process.env[slotsDirectoryVariable] = fixture.directory;
  try { assert.deepEqual(sessionSlotsGrant(), [fixture.directory]); } finally { delete process.env[slotsDirectoryVariable]; }
  assert.ok(existsSync(fixture.directory));
});
