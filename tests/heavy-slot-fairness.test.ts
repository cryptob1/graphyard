import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { acquireVerificationSlot, gateSlot, heldSlots, hostHeavyJobsDirectory, slotsDirectoryVariable, type HeldSlot } from '../src/master/verification-slots.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';

// GY-3487: several installs share one host's heavy-job slots. One install held every slot, release
// after release, because its own older waiters were always at the head of the queue, and another
// install sat stuck for hours. A project that holds a slot now never takes another while a project
// holding none waits.

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
async function until(condition: () => boolean, what: string, timeoutMs = 60_000) {
  for (const deadline = Date.now() + timeoutMs; !condition();) { assert.ok(Date.now() < deadline, `timed out waiting until ${what}`); await sleep(10); }
}
const stop = new AbortController();
after(() => stop.abort());

function waiter(directory: string, label: string, project: string) {
  let held: HeldSlot | null = null;
  const lines: string[] = [];
  const taken = acquireVerificationSlot({ directory, label, project, pollMs: 5, signal: stop.signal, onWait: line => lines.push(line) }).then(slot => { held = slot; return slot; });
  taken.catch(() => {});
  return { taken, lines, held: () => held };
}

test('integration:heavy-slot-fairness — at limit 3 project A fills every slot alone; when one frees while A and B both wait, B takes it and A\'s waiter says why', { timeout: 120_000 }, async () => {
  const directory = join(await temporaryDirectory('heavy-slot-fairness'), 'heavy-jobs');
  mkdirSync(directory);
  writeFileSync(join(directory, 'limit'), '3\n');
  // With only one project waiting nothing changes: A fills the limit.
  const a: HeldSlot[] = [];
  for (let n = 1; n <= 3; n++) a.push(await acquireVerificationSlot({ directory, label: `merge trial A-${n}`, project: 'acme/a' }));
  assert.equal(heldSlots(directory).filter(entry => entry.slot < gateSlot).length, 3);
  // A queues a fourth job first, then B queues its only one.
  const aNext = waiter(directory, 'merge trial A-4', 'acme/a');
  await until(() => aNext.lines.length > 0, 'A\'s fourth job waits');
  const b = waiter(directory, 'merge trial B-1', 'acme/b');
  await until(() => b.lines.length > 0, 'B\'s job waits');
  a[0].release();
  await until(() => !!b.held() || !!aNext.held(), 'the freed slot is taken');
  await sleep(200);
  assert.ok(b.held(), 'the project holding none takes the freed slot');
  assert.equal(aNext.held(), null, 'the project holding three does not take a fourth');
  assert.ok(aNext.lines.some(line => line.includes('waiting: acme/b holds none and is next')), `A's waiter names why: ${aNext.lines.join('\n')}`);
  assert.equal(heldSlots(directory).filter(entry => entry.slot < gateSlot).length, 3, 'never more than the limit; no job was stopped');
  // Once B holds a slot, only A waits: it takes the next freed slot as before.
  a[1].release();
  (await aNext.taken).release();
  b.held()!.release(); a[2].release();
  assert.deepEqual(heldSlots(directory), []);
});

const launcher = join(import.meta.dirname, 'helpers', 'heavy-job-launcher.ts');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.com', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();

test('e2e:heavy-slot-fairness — two installs\' loops on one host submit merge trials at limit 2; both installs\' trials start before either runs a second at once, and master status lists holders from both', { timeout: 180_000 }, async () => {
  const scratch = await temporaryDirectory('heavy-slot-fairness-e2e'), data = join(scratch, 'data'), log = join(scratch, 'runs.log'), go = join(scratch, 'go');
  writeFileSync(log, '');
  const base = { PATH: process.env.PATH, HOME: process.env.HOME, GRAPHYARD_DATA_HOME: data, RUN_GO: go, RUN_LOG: log };
  const directory = hostHeavyJobsDirectory(base);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'limit'), '2\n');
  const installs = ['acme/app', 'acme/site'].map(project => {
    const root = join(scratch, project.replace('/', '-')), managed = `${root}-managed`;
    mkdirSync(root); mkdirSync(managed);
    writeFileSync(join(root, 'README.md'), project);
    git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'fixture');
    return { project, root, managed };
  });
  const children: ChildProcess[] = [];
  after(() => { for (const child of children) child.kill('SIGKILL'); });
  const waiting = /waits for a host heavy-job slot|waiting for a host heavy-job slot/;
  const trial = (install: typeof installs[number], id: string) => {
    const child = spawn(process.execPath, ['--import', 'tsx', launcher, 'trial', id, install.root, install.managed], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...base, FIXTURE_PROJECT: install.project } });
    children.push(child);
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    return { id, project: install.project, stderr: () => stderr, closed: once(child, 'close').then(([code]) => code as number | null) };
  };
  const events = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => line.split(' ') as [string, string]);
  // Another job holds both slots while the two loops submit: the app's three trials queue first, then the site's two.
  const holding = [await acquireVerificationSlot({ directory, label: 'deploy build', project: 'acme/ops' }), await acquireVerificationSlot({ directory, label: 'whole suite', project: 'acme/ops' })];
  const [app, site] = installs, jobs: ReturnType<typeof trial>[] = [];
  for (const [install, id] of [[app, 'GY-1'], [app, 'GY-2'], [app, 'GY-3'], [site, 'GY-11'], [site, 'GY-12']] as const) {
    const job = trial(install, id);
    jobs.push(job);
    await until(() => waiting.test(job.stderr()), `${id} waits`);
  }
  for (const held of holding) held.release();
  await until(() => events().length >= 2, 'two trials start');
  await sleep(500);
  const projectOf = (id: string) => jobs.find(job => job.id === id)!.project;
  assert.deepEqual(events().map(([, id]) => projectOf(id)).sort(), ['acme/app', 'acme/site'], `one trial from each install runs: ${JSON.stringify(events())}`);

  const master = masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'acme/app', baseBranch: 'main', githubAppId: 1234, hostId: 'loop-host', masterAgentName: 'graphyard-master-fairness', workers: [],
  }) as MasterConfig;
  const previous = process.env[slotsDirectoryVariable];
  process.env[slotsDirectoryVariable] = directory;
  try {
    const report = await masterStatusReport(await temporaryDirectory('heavy-slot-fairness-status'), master, async () => ({ work: [], now: new Date().toISOString() }), async () => { throw new Error('no git in the fixture'); });
    assert.equal(report.heavyJobs.limit, 2);
    assert.deepEqual([...new Set(report.heavyJobs.holders.map(holder => holder.project))].sort(), ['acme/app', 'acme/site'], 'master status lists holders from both installs');
  } finally { if (previous === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = previous; }

  writeFileSync(go, '');
  for (const job of jobs) assert.equal(await job.closed, 0, job.stderr());
  // Replay the run: no install ran two trials at once before the other's first trial started, and never more than two ran.
  const running = new Map<string, number>(), started = new Set<string>();
  let total = 0;
  for (const [event, id] of events()) {
    const project = projectOf(id), delta = event === 'start' ? 1 : -1;
    running.set(project, (running.get(project) ?? 0) + delta); total += delta;
    if (event === 'start') started.add(project);
    assert.ok(total <= 2, `never more than the limit: ${JSON.stringify(events())}`);
    if (running.get(project)! >= 2) assert.equal(started.size, 2, `${project} ran a second trial before the other install's first: ${JSON.stringify(events())}`);
  }
  assert.equal(events().filter(([event]) => event === 'start').length, 5, 'every trial ran');
  assert.deepEqual(heldSlots(directory), []);
});
