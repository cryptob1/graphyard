import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { heavyRunLabel } from './helpers/run-tests.js';
import { emptyDaemonState, type DaemonState } from '../src/daemon/state.js';
import { mergeWriterStep, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { cpuPressureStep, cpuWaiting, trialCapNow } from '../src/daemon/cpu-pressure.js';
import type { TrialRunHandle } from '../src/merge-writer/trial-run.js';
import type { MergePorts, MergeTrialRun } from '../src/merge-writer/executor.js';
import { foldMergeLedger } from '../src/model-boundary/merge-ledger.js';
import { masterConfigSchema, masterSettingsFromArgs, saveMasterSettings, type MasterConfig } from '../src/master.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { fleetCommand } from '../src/cli/master/fleet.js';
import { acquireVerificationSlot, heavyJobLimit, heldSlots, hostHeavyJobsDirectory, readStrictCap, setStrictCap, slotsDirectoryVariable, verificationEnvironment, withHeavyJob } from '../src/master/verification-slots.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { Work } from '../src/model.js';

// GY-3446: when another project on the host asks Graphyard to back off overnight (Huck: at most 2
// trials, throttle at 80C), the master sets a temporary trial cap and heat limit for its install,
// and a host-wide strict heavy-job cap every install shares; each reverts on its own at its expiry.
// GY-3501: the heat limit halves merge trials sooner; it holds no launch.

const start = Date.parse('2030-09-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const until = async (condition: () => boolean, what: string, timeoutMs = 60_000) => {
  for (const deadline = Date.now() + timeoutMs; !condition();) { assert.ok(Date.now() < deadline, `timed out waiting until ${what}`); await sleep(25); }
};
const base = sha('base');
const masterInput = { version: 1, url: 'https://graphyard.example', cliPath: process.execPath, repository: 'acme/app', baseBranch: 'main', githubAppId: 1234, hostId: 'loop-host',
  masterAgentName: 'graphyard-master-app', workers: [], run: { mergeWriter: { parallel: 4 } } };

/** An install's .graphyard/master.json, for master config to change. */
async function install() {
  const root = await temporaryDirectory('temporary-limits'), credentials = await temporaryDirectory('temporary-limits-credentials');
  const credentialFile = join(credentials, 'token');
  await writeFile(credentialFile, 'fixture-token', { mode: 0o600 });
  execFileSync('git', ['init', '-q', root]);
  await mkdir(join(root, '.graphyard'));
  await writeFile(join(root, '.graphyard/master.json'), JSON.stringify({ ...masterInput, credentialFile }), { mode: 0o600 });
  return root;
}
const status = (root: string, master: MasterConfig, now: number) =>
  masterStatusReport(root, master, async () => ({ work: [], now: iso(now) }), async () => { throw new Error('no git in the fixture'); });

/** Four due heads and the merge writer's detached trial runs, as tests/hot-trial-cap.test.ts drives them. */
function world() {
  const live = new Set<string>(), launches: string[] = [];
  const snapshot = (): Work[] => [1, 2, 3, 4].map(n => {
    const candidate = { sha: sha(`head${n}`), baseSha: base, pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' };
    return {
      id: `w${n}`, key: `GY-${n}`, title: `Item ${n}`, type: 'feature', description: '', priority: 1, dependencies: [], stage: 'build',
      criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }], policy: { checks: ['test'], review: true },
      revision: 1, policyRevision: 1, createdAt: iso(start + n * 1000), updatedAt: iso(start), stageEnteredAt: iso(start + n * 1000),
      ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: n }, candidate, reworkRequested: false,
      scenarioRequirements: [], evidence: [], blocker: null, violations: [], mergeLedger: foldMergeLedger([])[`GY-${n}`] ?? null,
      observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, baseTip: base, baseTipContained: true, at: iso(start) },
      gates: ['ready', 'build', 'review'].map(name => ({ name, passed: true, reasons: [] })),
    } as unknown as Work;
  });
  const ports: MergePorts = {
    baseBranch: 'main', now: () => start, fetch: async () => base,
    merge: async (head, tip) => ({ mergeSha: sha(`merge:${head}:${tip}`), files: ['src/item.ts'] }),
    trial: async () => { throw new Error('detached trial runs only'); },
    push: async () => 'pushed', holds: async () => false,
    record: async () => {},
  };
  const reads: MergeWriterReads = {
    ...ports, parallel: 4, cores: 24,
    launchTrialRun: spec => {
      live.add(spec.key); launches.push(spec.key);
      return { directory: `/runs/${spec.key}`, mergeSha: spec.mergeSha, trial: () => new Promise<MergeTrialRun>(() => {}), detach: () => {}, cancel: () => { live.delete(spec.key); } } as TrialRunHandle;
    },
    stopTrialRun: () => {},
  };
  return { live, launches, cycle: (config: MasterConfig, state: DaemonState, now: number) =>
    mergeWriterStep({ config, state, effects: { mergeWriter: reads, persist: async () => {}, rework: async () => {} }, now: () => now, snapshot: { work: snapshot(), now: iso(now) }, performed: [] } as unknown as Cycle) };
}

/** The loop's CPU reading: a package average of `celsius` and calm pressure. */
const reading = (config: MasterConfig, state: DaemonState, now: number, celsius: number) => cpuPressureStep({ config, state, now: () => now, log: () => {},
  effects: { cpuPressure: async () => ({ pressure: 'some avg10=1.00 avg60=10.00 avg300=1.00 total=1', stat: null, celsius }) } as never });

test('integration:temporary-trial-limits — trialCap=2 and launchHotCelsius=80 set with an expiry hold trials to 2 and halve them from 80C, show on master status, revert at expiry, and looser values are refused', { timeout: 60_000 }, async () => {
  const root = await install(), expiry = start + 8 * 3600_000;
  // Looser than the defaults, or with no expiry, is refused.
  assert.throws(() => masterSettingsFromArgs(['trialCap=2'], start), /until=TIME/);
  assert.throws(() => masterSettingsFromArgs(['trialCap=2', `until=${iso(start - 1000)}`], start), /until=TIME/);
  await assert.rejects(saveMasterSettings(root, masterSettingsFromArgs(['trialCap=5', `until=${iso(expiry)}`], start)), /only lowers the trial cap.*1 to 4/);
  await assert.rejects(saveMasterSettings(root, masterSettingsFromArgs(['launchHotCelsius=90', `until=${iso(expiry)}`], start)), /only lowers the heat limit|85/);
  const saved = await saveMasterSettings(root, masterSettingsFromArgs(['trialCap=2', 'launchHotCelsius=80', `until=${iso(expiry)}`], start));
  assert.deepEqual(saved.changed, ['trialCap', 'launchHotCelsius']);
  const master = masterConfigSchema.parse(JSON.parse(readFileSync(join(root, '.graphyard/master.json'), 'utf8'))) as MasterConfig;
  assert.deepEqual(master.run.trialCap, { value: 2, until: iso(expiry) });

  // Four due heads, a cap of 4 by default: the temporary cap starts only two.
  const yard = world(), state = emptyDaemonState(master);
  await reading(master, state, start, 60);
  await yard.cycle(master, state, start);
  await until(() => yard.launches.length >= 2, 'two trials start');
  await sleep(50);
  assert.deepEqual(yard.launches, ['GY-1', 'GY-2'], 'no more than two merge trials at once');
  assert.deepEqual(state.cpuPressure?.trialCap, { now: 2, full: 2 });
  // A 77C average halves trials under the temporary 80C limit; the default (85C) would not.
  await reading(master, state, start + 61_000, 77);
  assert.equal(cpuWaiting(state), null, 'heat holds no launch (GY-3501)');
  assert.equal(trialCapNow(state, 2), 1, 'the temporary heat limit halves the trial cap at 77C');
  const shown = await status(root, master, start);
  assert.deepEqual(shown.temporaryLimits.trialCap, { value: 2, until: iso(expiry) });
  assert.deepEqual(shown.temporaryLimits.launchHotCelsius, { value: 80, until: iso(expiry) });

  // Past the expiry both revert to their defaults: the full cap of 4, and 77C halves nothing.
  const later = expiry + 60_000, cool = emptyDaemonState(master);
  await reading(master, state, later, 77);
  assert.equal(cpuWaiting(state), null);
  assert.equal(trialCapNow(state, 4), 4, 'the default heat limit halves nothing at 77C');
  await reading(master, cool, later, 60);
  await yard.cycle(master, cool, later);
  await until(() => yard.launches.length >= 4, 'the default cap starts the other two');
  assert.deepEqual(cool.cpuPressure?.trialCap?.full, 4);
  const reverted = await status(root, master, later);
  assert.deepEqual(reverted.temporaryLimits, { trialCap: null, launchHotCelsius: null, hostHeavyJobs: null });
});

/** Two installs on one host: each job a process of its own project, through the loop's own entry points (tests/helpers/heavy-job-launcher.ts). */
async function host() {
  const scratch = await temporaryDirectory('strict-cap'), data = join(scratch, 'data'), log = join(scratch, 'runs.log'), go = join(scratch, 'go');
  const root = join(scratch, 'app'), managed = join(scratch, 'managed');
  mkdirSync(root); mkdirSync(managed); writeFileSync(log, '');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { 'test:affected': 'node job.mjs', test: 'node job.mjs' } }));
  writeFileSync(join(root, 'job.mjs'), `import { appendFileSync } from 'node:fs'; appendFileSync(process.env.RUN_LOG, 'start ' + process.env.JOB_ID + '\\nend ' + process.env.JOB_ID + '\\n');\n`);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.com', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-qm', 'fixture');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, GRAPHYARD_DATA_HOME: data, RUN_GO: go, RUN_LOG: log };
  const started: ChildProcess[] = [];
  after(() => { for (const child of started) child.kill('SIGKILL'); });
  const track = (id: string, child: ChildProcess) => {
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    started.push(child);
    return { id, stderr: () => stderr, closed: once(child, 'close').then(([code]) => code as number | null) };
  };
  const launcher = join(import.meta.dirname, 'helpers', 'heavy-job-launcher.ts');
  const events = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => line.split(' ') as [string, string]);
  return {
    directory: hostHeavyJobsDirectory(env), managed, events, go: () => writeFileSync(go, ''),
    ran: (id: string) => events().some(([event, job]) => event === 'start' && job === id),
    session: (id: string, args: string[], project = 'acme/app') => track(id, spawn('npm', args, { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], env: { ...env, ...verificationEnvironment(project, env), JOB_ID: id } })),
    launch: (mode: string, id: string, project = 'acme/app') => track(id, spawn(process.execPath, ['--import', 'tsx', launcher, mode, id, root, managed], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...env, FIXTURE_PROJECT: project } })),
  };
}
const waiting = /waits for a host heavy-job slot|waiting for a host heavy-job slot|strict heavy-job cap/;

test('integration:temporary-trial-limits — a host-wide strict cap of 1 serializes trials, the batch gate, selected test runs and worker checks of two installs, leaves running jobs alone, pauses at 85C, and lifts at its expiry', { timeout: 240_000 }, async () => {
  const yard = await host();
  // Two installs' merge trials run under the ordinary limit of two.
  const running = [yard.launch('trial', 'GY-1', 'acme/app'), yard.launch('trial', 'HK-1', 'huck/app')];
  await until(() => yard.ran('GY-1') && yard.ran('HK-1'), 'both trials run');

  // The strict cap of 1 lands: nothing running is stopped, and no new job starts until fewer than one run.
  const cap = setStrictCap(yard.directory, { value: 1, until: iso(Date.now() + 3600_000) }, 'graphyard-master-app')!;
  assert.equal(heavyJobLimit(yard.directory), 1);
  assert.equal(heldSlots(yard.directory).length, 2, 'lowering kills no running job');
  assert.throws(() => setStrictCap(yard.directory, { value: 3, until: cap.until }, 'graphyard-master-app'), /only tightens.*1 to 2/);
  // The batch gate loses its reservation beside the limit; a worker check, a selected test run and an affected run take a slot (GY-3447 exempts them otherwise).
  const queued = [yard.launch('gate', 'gate-huck', 'huck/app'), yard.launch('check', 'GY-3', 'acme/app'),
    yard.session('selected', ['test', '--', 'tests/a.test.ts']), yard.session('affected', ['run', 'test:affected'], 'huck/app')];
  await until(() => queued.every(job => waiting.test(job.stderr())), 'every new job waits for the strict cap');
  for (const job of queued) assert.ok(!yard.ran(job.id), `${job.id} has not started`);
  assert.equal(heavyRunLabel('test', ['tests/a.test.ts'], true), 'npm test tests/a.test.ts', "this repository's runner takes a slot for selected files too");

  // Released, every job runs, one at a time across both installs.
  yard.go();
  for (const job of [...running, ...queued]) assert.equal(await job.closed, 0, job.stderr());
  const order = yard.events(), firstQueued = order.findIndex(([event, id]) => event === 'start' && queued.some(job => job.id === id));
  assert.ok(order.slice(0, firstQueued).filter(([event]) => event === 'end').length === 2, 'no queued job started before both running trials ended');
  let live = 0, peak = 0;
  for (const [event] of order.slice(firstQueued)) { live += event === 'start' ? 1 : -1; peak = Math.max(peak, live); }
  assert.equal(peak, 1, 'under the strict cap no two heavy jobs run at once');
  assert.deepEqual(heldSlots(yard.directory), []);

  // A trial's own serve and test containers run on its slot: no deadlock at a cap of 1.
  const previous = process.env[slotsDirectoryVariable];
  process.env[slotsDirectoryVariable] = yard.directory;
  try {
    assert.equal(await withHeavyJob('merge trial GY-9', () => withHeavyJob('serve GY-9', () => withHeavyJob('session tests GY-9', async () => 'nested ran'))), 'nested ran');
  } finally { if (previous === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = previous; }

  // At 85C or more no new run starts under the strict cap; it starts once the CPU reads cooler.
  const sensors = await temporaryDirectory('strict-cap-sensors');
  mkdirSync(join(sensors, 'hwmon0'));
  writeFileSync(join(sensors, 'hwmon0', 'name'), 'coretemp\n');
  writeFileSync(join(sensors, 'hwmon0', 'temp1_label'), 'Package id 0\n');
  writeFileSync(join(sensors, 'hwmon0', 'temp1_input'), '90000\n');
  const lines: string[] = [];
  let taken = false;
  const hot = acquireVerificationSlot({ directory: yard.directory, label: 'npm test', hwmon: sensors, pollMs: 20, onWait: line => lines.push(line) }).then(held => { taken = true; return held; });
  await until(() => lines.length > 0, 'the hot start waits');
  assert.match(lines[0]!, /90C, 85C or more/);
  await sleep(100);
  assert.ok(!taken, 'nothing starts at 90C');
  writeFileSync(join(sensors, 'hwmon0', 'temp1_input'), '70000\n');
  (await hot).release();

  // At its expiry the strict cap lifts on its own: the ordinary limit, reservation and exemptions return.
  assert.ok(readStrictCap(yard.directory, Date.parse(cap.until) + 1000) === null);
  setStrictCap(yard.directory, { value: 1, until: iso(Date.now() + 300) }, 'graphyard-master-app');
  await sleep(400);
  assert.equal(heavyJobLimit(yard.directory), 2);
  const holders = [yard.launch('hold', 'GY-5', 'acme/app'), yard.launch('hold', 'HK-5', 'huck/app')];
  await until(() => yard.ran('GY-5') && yard.ran('HK-5'), 'two jobs hold both ordinary slots again');
  const free = yard.session('after', ['test', '--', 'tests/a.test.ts']);
  assert.equal(await free.closed, 0, free.stderr());
  assert.doesNotMatch(free.stderr(), waiting, 'a selected test run starts at once again');
  for (const id of ['GY-5', 'HK-5']) writeFileSync(join(yard.managed, `gate-${id}`), '');
  for (const job of holders) assert.equal(await job.closed, 0, job.stderr());
});

test('e2e:temporary-trial-limits — master config sets a temporary trial cap, heat limit and host strict cap; master status shows each with its expiry, and they revert at expiry', { timeout: 60_000 }, async () => {
  const root = await install(), data = await temporaryDirectory('temporary-limits-data'), expiry = Date.now() + 3600_000;
  const directory = join(data, 'heavy-jobs'), previous = process.env[slotsDirectoryVariable];
  process.env[slotsDirectoryVariable] = directory;
  try {
    const stored = masterConfigSchema.parse(JSON.parse(readFileSync(join(root, '.graphyard/master.json'), 'utf8'))) as MasterConfig;
    const printed: unknown[] = [];
    const config = (args: string[]) => fleetCommand({ id: 'config', args, root, master: stored, print: (value: unknown) => { printed.push(value); return value; }, coordinator: { actor: { id: 'graphyard-master-app' } } } as never);
    await config(['trialCap=2', 'launchHotCelsius=80', 'hostHeavyJobs=1', `until=${iso(expiry)}`]);
    await assert.rejects(config(['launchHotCelsius=90', `until=${iso(expiry)}`]), /only lowers the heat limit/);
    assert.match(JSON.stringify(printed[0]), /"hostHeavyJobs":\{"limit":1/);

    const master = masterConfigSchema.parse(JSON.parse(readFileSync(join(root, '.graphyard/master.json'), 'utf8'))) as MasterConfig;
    const shown = await status(root, master, Date.now());
    assert.deepEqual(shown.temporaryLimits, { trialCap: { value: 2, until: iso(expiry) }, launchHotCelsius: { value: 80, until: iso(expiry) },
      hostHeavyJobs: { value: 1, until: iso(expiry), by: 'graphyard-master-app' } });
    assert.equal(shown.heavyJobs.limit, 1);

    const reverted = await status(root, master, expiry + 1000);
    assert.deepEqual(reverted.temporaryLimits, { trialCap: null, launchHotCelsius: null, hostHeavyJobs: null });
    // Cleared early with an empty value, each returns to its default at once.
    await config(['trialCap=', 'launchHotCelsius=', 'hostHeavyJobs=']);
    const cleared = masterConfigSchema.parse(JSON.parse(readFileSync(join(root, '.graphyard/master.json'), 'utf8'))) as MasterConfig;
    assert.deepEqual((await status(root, cleared, Date.now())).temporaryLimits, { trialCap: null, launchHotCelsius: null, hostHeavyJobs: null });
    assert.equal(heavyJobLimit(directory), 2);
  } finally { if (previous === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = previous; }
});
