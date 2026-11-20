import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { bootstrapGate, gateBoundMs, gateLimitMs, gateRecordPath, gateSummary, readGateRecord, runGate, writeGateRecord, type GatePorts } from '../src/batch-gate.js';
import { batchGateStep, noteBatchGateStopping } from '../src/daemon/cycle-batch-gate.js';
import { runCycle } from '../src/daemon/cycle.js';
import { mergeWriterIdle, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import { trialContainerLaunch } from '../src/merge-writer/trial-container.js';
import { trialLoad, trialStartOwner, trialStartWaiting } from '../src/merge-writer/trial-load.js';
import { acquireVerificationSlot, declarationSlot, heldSlots, slotsDirectoryVariable } from '../src/master/verification-slots.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3474: a batch gate on a hot shared host stayed "running" for hours, its whole lifetime counted
// as waiting: the loop's CPU hold on other launches and any install's waiting gate start both
// stopped its clock, so a stalled check never met its bound. Only the gate's own check's wait — the
// host heavy-job slot, or its own container start — is left out now, and status names what the
// check is doing and which detached run it is.

const repository = 'owner/project';
const start = Date.parse('2030-05-01T00:00:00Z');
const minute = 60_000;
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, what: string, timeoutMs = 15_000) {
  for (const deadline = Date.now() + timeoutMs; !condition();) { assert.ok(Date.now() < deadline, `timed out waiting until ${what}`); await sleep(20); }
}
const passing = { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: { 'unit:item-works': { executed: 1, failed: 0 } }, e2e: [] } as unknown as MergeTrialRun;

const previous = process.env[slotsDirectoryVariable];
after(() => { if (previous === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = previous; });
const holders = (directory: string) => heldSlots(directory).filter(entry => entry.slot < declarationSlot).map(entry => entry.owner?.label);

/** One detached run as the loops see it: its directory, and each loop's watch of it, which the test steps, passes or drops. */
interface Run { directory: string; proofs: string[]; files: string[]; timeoutMs?: number; watches: { onStep?: (step: string) => void; resolve: (run: MergeTrialRun) => void; reject: (error: Error) => void; signal?: AbortSignal }[] }

/**
 * A main with a verified base and one merge past it, a host that reads 96C with another install's
 * gate start waiting, and a loop whose gate launches its checks as detached runs the test controls.
 */
async function world(label: string) {
  const base = await temporaryDirectory(label);
  const slots = join(base, 'heavy-jobs'), trialSlots = join(base, 'trial-slots');
  await mkdir(slots, { recursive: true }); await mkdir(trialSlots, { recursive: true });
  await writeFile(join(slots, 'limit'), '1\n');
  process.env[slotsDirectoryVariable] = slots;
  // Another install's gate start waits on this machine throughout: its launcher is alive, its marker names its own install.
  await writeFile(join(trialSlots, `wait-0-${process.ppid}`), trialStartOwner('/another/install', sha('theirs')));
  const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), coordinator = join(base, 'coordinator');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, pusher);
  await writeFile(join(pusher, 'graphyard.json'), '{}');
  git(pusher, 'add', '.'); git(pusher, 'commit', '-q', '-m', 'base'); git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  const verified = git(pusher, 'rev-parse', 'HEAD');
  await writeFile(join(pusher, 'f1.ts'), 'ok\n');
  git(pusher, 'add', '.'); git(pusher, 'commit', '-q', '-m', 'change 1'); git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  const tip = git(pusher, 'rev-parse', 'HEAD');
  git(base, 'clone', '-q', origin, coordinator);
  await mkdir(join(coordinator, '.graphyard'), { recursive: true });
  await writeGateRecord(gateRecordPath(coordinator), { ...bootstrapGate(repository, verified), diagnosticsAt: iso(start) });
  let clock = start;
  const runs: Run[] = [], adopted: string[] = [], merges: string[] = [];
  const watch = (run: Run) => (onStep?: (step: string) => void, _timing?: unknown, signal?: AbortSignal) => new Promise<MergeTrialRun>((resolve, reject) => {
    run.watches.push({ onStep, resolve, reject, signal });
    signal?.addEventListener('abort', () => reject(new Error('the trial run was stopped')), { once: true });
  });
  const reads: MergeWriterReads = {
    baseBranch: 'main', now: () => clock, cores: 2, parallel: 1,
    fetch: async () => { git(coordinator, 'fetch', '-q', 'origin', 'main'); return git(coordinator, 'rev-parse', 'origin/main'); },
    git: async (args, extra) => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
    merge: async head => ({ mergeSha: sha(`merge:${head}`), files: ['src/app.ts'] }),
    trial: async () => { throw new Error('every trial runs detached'); },
    ensureTrialImage: async () => {},
    launchTrialRun: request => {
      if (request.key !== 'batch-gate') { merges.push(request.key); return { directory: join(base, 'runs', request.key), mergeSha: request.mergeSha, trial: async () => passing, detach: () => {}, cancel: () => {} }; }
      const run: Run = { directory: join(base, 'runs', `run-${runs.length + 1}`), proofs: request.proofs, files: request.changedFiles, timeoutMs: request.timeoutMs, watches: [] };
      runs.push(run);
      return { directory: run.directory, mergeSha: request.mergeSha, trial: watch(run), detach: () => {}, cancel: () => {} };
    },
    adoptTrialRun: async ref => {
      const run = runs.find(entry => entry.directory === ref.directory);
      if (!run) return null;
      adopted.push(ref.directory);
      return { directory: run.directory, mergeSha: ref.mergeSha, trial: watch(run), detach: () => {}, cancel: () => {} };
    },
    push: async () => 'pushed', holds: async () => true, record: async () => undefined,
    gate: { root: coordinator, repository, slots: trialSlots },
  };
  /** A loop of this install: its own state, with the host's CPU read at 96C so every other launch waits. */
  const loop = () => {
    const state = emptyDaemonState({ url: 'http://127.0.0.1:1', repository } as any);
    state.cpuPressure = { at: iso(clock), avg60: 10, steal: null, stat: null, celsius: 96, samples: [], testBudget: null, trialCap: null } as any;
    return { state, effects: { mergeWriter: reads } as any, snapshot: { work: [], now: iso(clock) } as any, performed: [], now: () => clock, log: () => {} };
  };
  const record = () => readGateRecord(gateRecordPath(coordinator))!;
  /** The `count`-th loop watch of the `index`-th run, once that loop watches it. */
  const watching = async (index: number, count = 1) => { await until(() => (runs[index]?.watches.length ?? 0) >= count, `run ${index + 1} is watched`); return runs[index]!.watches[count - 1]!; };
  const waited = (ms: number) => until(() => (record().inFlight?.waitedMs ?? 0) >= ms, `the record counts ${ms / minute} minutes waited`);
  return { slots, trialSlots, coordinator, tip, reads, runs, adopted, merges, loop, record, watching, waited, summary: () => gateSummary(record())!.inFlight, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

test('integration:batch-gate-own-wait-liveness — a stalled check on a hot host, beside another install\'s waiting gate, meets its bound: its run is stopped and the existing retry verifies main, the record naming each run', { timeout: 120_000 }, async () => {
  const yard = await world('gate-own-wait-stalled');
  const flight = (await batchGateStep(yard.loop()))!.gate!;
  const stalled = await yard.watching(0);
  stalled.onStep?.('install');
  await until(() => yard.summary()?.progress === 'install', 'the record carries the run\'s own step');
  assert.equal(yard.record().inFlight!.run!.directory, yard.runs[0]!.directory, 'the record names the check\'s detached run');
  assert.equal(yard.summary()!.run, basename(yard.runs[0]!.directory));
  assert.equal(trialStartWaiting('gate', yard.trialSlots), true, 'a gate start waits on this machine');
  assert.equal(trialStartWaiting('gate', yard.trialSlots, trialStartOwner(yard.coordinator, yard.tip)), false, 'it is another install\'s');

  // The check stalls: no step, no verdict. Neither the 96C host nor the other install's wait is the gate's own.
  yard.advance(gateLimitMs + 1);
  const retry = await yard.watching(1);
  assert.equal(stalled.signal?.aborted, true, 'the stalled run is stopped, never left beside its retry');
  assert.ok((yard.record().inFlight?.waitedMs ?? 0) < minute, 'none of the stalled time counted as waiting');
  assert.equal(yard.record().inFlight!.run!.directory, yard.runs[1]!.directory, 'the record names the retry\'s run');
  retry.resolve(passing);
  await flight;
  assert.equal(yard.record().verified, yard.tip, 'the retry verified main');
  assert.equal(yard.runs.length, 2);
  assert.deepEqual(holders(yard.slots), []);
});

test('e2e:batch-gate-median-bound — a gate run on the real loop step and detached runner meets twice its verified median: its one run is stopped, the timeout names its bound, nothing verifies, and the retry runs every check', { timeout: 120_000 }, async () => {
  const yard = await world('gate-median-bound');
  // GY-3507: the recorded history of 2026-11-18 — verified runs of 30 to 40 minutes, one 400-minute outlier — and a diagnostics catalog stretched to 222 minutes.
  const history = [30, 32, 35, 38, 400].map(ms => ({ ms: ms * minute, at: iso(start - minute) }));
  await writeGateRecord(gateRecordPath(yard.coordinator), { ...yard.record(), verifiedRuns: history, catalogMs: 222 * minute });
  const bound = gateBoundMs(yard.record());
  assert.equal(bound, 70 * minute);
  const before = yard.record().verified;
  const flight = (await batchGateStep(yard.loop()))!.gate!;
  const stalled = await yard.watching(0);
  assert.ok(yard.runs[0]!.timeoutMs! <= bound, `the detached run's own clock follows the gate's bound (${yard.runs[0]!.timeoutMs} ms), not hours`);
  const checks = yard.record().inFlight!.checks!;
  assert.deepEqual([checks[0], checks.at(-1)], ['build', 'affected'], 'the build and affected tests are cut into the batch');
  yard.advance(bound - minute);
  await sleep(1500);
  assert.equal(stalled.signal?.aborted, false, 'inside its bound the run goes on');
  assert.equal(yard.runs.length, 1);
  yard.advance(2 * minute);
  const retry = await yard.watching(1);
  assert.equal(stalled.signal?.aborted, true, 'the run past its bound is stopped before its retry starts: never two at once');
  const timedOut = yard.record().lastOutcome!;
  assert.equal(timedOut.outcome, 'timeout');
  assert.equal(timedOut.reason, 'past 70 minutes', 'the failure names the bound it met');
  assert.equal(yard.record().verified, before, 'a timeout verifies nothing');
  assert.equal(yard.record().verifiedRuns!.length, 5, 'and samples nothing');
  assert.deepEqual(yard.record().inFlight!.checks, checks, 'the retry runs every check');
  assert.deepEqual(yard.runs[1]!.files, yard.runs[0]!.files);
  retry.resolve(passing);
  await flight;
  assert.equal(yard.record().verified, yard.tip);
});

test('integration:batch-gate-own-wait-liveness — the gate\'s own waits, for its host heavy-job slot and then for its own container start, are not its time: two bounds of each neither time it out nor start a second run', { timeout: 120_000 }, async () => {
  const yard = await world('gate-own-wait-live');
  // The reserved gate slot and the one ordinary slot are both taken, so the gate's check waits for the host.
  const otherGate = await acquireVerificationSlot({ directory: yard.slots, label: 'merge trial batch-gate (other project)', reserved: true });
  const suite = await acquireVerificationSlot({ directory: yard.slots, label: 'npm test (other project)' });
  let settled = false;
  const flight = (await batchGateStep(yard.loop()))!.gate!.then(() => { settled = true; });
  await until(() => /waiting for a host heavy-job slot/.test(yard.summary()?.progress ?? ''), 'status says the check waits for a slot');
  assert.equal(yard.summary()!.run, null, 'a waiting check has no run yet');
  yard.advance(2 * gateLimitMs);
  await yard.waited(2 * gateLimitMs);
  assert.equal(yard.runs.length, 0);
  assert.equal(settled, false, 'two bounds waiting for a slot time nothing out');
  otherGate.release(); suite.release();
  const live = await yard.watching(0);

  // Its own container start now waits (the cap, heat or the disk floor): the launcher's marker names this install and commit.
  const marker = join(yard.trialSlots, `wait-0-${process.pid}`);
  await writeFile(marker, trialStartOwner(yard.coordinator, yard.tip));
  yard.advance(2 * gateLimitMs);
  await yard.waited(4 * gateLimitMs);
  assert.equal(settled, false, 'two bounds waiting to start time nothing out');
  assert.equal(live.signal?.aborted, false, 'the live waiting run is not stopped');
  await rm(marker);
  live.resolve(passing);
  await flight;
  assert.equal(yard.record().verified, yard.tip);
  assert.equal(yard.runs.length, 1, 'one run, never a duplicate');
});

test('integration:batch-gate-own-wait-liveness — a batch adopted again before the loop next sees its run counts the gap since its last sight once', async () => {
  const now = Date.parse('2026-11-17T08:00:00Z');
  const ports: GatePorts = { now: () => now, fetch: async () => 'b'.repeat(40), landings: async () => [], files: async () => ['src/a.ts'], catalog: async () => [], core: async () => [],
    run: async () => { throw new Error('the trial host is down'); }, revert: async () => { throw new Error('unused'); }, file: async () => ({ item: null }) };
  const record = bootstrapGate(repository, 'a'.repeat(40));
  record.inFlight = { tip: 'b'.repeat(40), startedAt: iso(now - 20 * minute), files: ['src/a.ts'], checks: ['build'], results: {}, seenAt: iso(now - 10 * minute) };
  // Each loop stops mid-run, so the next adopts the batch as it was last checkpointed.
  let saved = record.inFlight;
  ports.checkpoint = async () => { saved = record.inFlight; };
  for (let cycle = 0; cycle < 3; cycle++) { record.inFlight = saved; await assert.rejects(runGate(ports, record), /trial host is down/); }
  assert.equal(saved!.waitedMs, 10 * minute, 'three adoptions count the ten minutes once');
});

test('integration:batch-gate-own-wait-liveness — a waiting container start names its owner, so a gate reads its own start\'s wait and no other\'s', { timeout: 60_000 }, async () => {
  const base = await temporaryDirectory('gate-own-wait-marker', process.cwd());
  const bin = join(base, 'bin'), hwmon = join(base, 'hwmon'), slots = join(base, 'slots'), log = join(base, 'docker.log'), children: ChildProcess[] = [];
  await mkdir(bin); await mkdir(hwmon);
  await writeFile(join(bin, 'docker'), `#!/bin/sh
echo "$*" >> ${JSON.stringify(log)}
case "$3" in
  start) for name; do :; done; echo $$ > ${JSON.stringify(log)}."$name"; exec sleep 60 ;;
  rm) for name; do :; done; kill "$(cat ${JSON.stringify(log)}."$name")" 2>/dev/null; exit 0 ;;
esac
exit 0
`);
  await writeFile(join(bin, 'df'), '#!/bin/sh\necho Avail\necho 100000000000\n');
  await chmod(join(bin, 'docker'), 0o755); await chmod(join(bin, 'df'), 0o755);
  const launch = async (owner: string) => {
    const load = { ...await trialLoad(join(base, 'install'), 'gate'), slots, cap: 1, hotCap: 1, hwmon, floorBytes: 30e9, owner };
    const [program, ...words] = trialContainerLaunch({ image: 'graphyard-trial:local', mounts: [[base, '/scratch', false]], network: 'none', load });
    const child = spawn(program!, [...words, 'sleep', '600'], { cwd: base, env: { PATH: `${bin}:/usr/bin:/bin` }, stdio: ['ignore', 'ignore', 'pipe'] });
    let said = '';
    child.stderr!.on('data', chunk => { said += chunk; });
    children.push(child);
    return () => said;
  };
  const mine = trialStartOwner('/install/mine', 'b'.repeat(40)), theirs = trialStartOwner('/install/theirs', 'c'.repeat(40));
  try {
    await launch(theirs);
    await until(() => existsSync(log) && readFileSync(log, 'utf8').includes(' create '), 'the other install\'s gate start takes the one slot');
    const second = await launch(mine);
    await until(() => second().includes('waiting'), 'this gate\'s start waits for the slot');
    await until(() => trialStartWaiting('gate', slots, mine), 'the gate reads its own start\'s wait');
    assert.equal(trialStartWaiting('gate', slots, theirs), false, 'the other install\'s gate, which is running, reads none');
    assert.equal(trialStartWaiting('gate', slots), true);
  } finally { for (const child of children) if (child.exitCode === null && child.signalCode === null) { const gone = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM'); await gone; } }
});

test('e2e:batch-gate-own-wait-liveness — a gate on a hot host reports its wait, then its run and step; a loop restart adopts that run, every check settles once, and the next cycle dispatches the queued merge', { timeout: 120_000 }, async () => {
  const yard = await world('gate-own-wait-e2e');
  const otherGate = await acquireVerificationSlot({ directory: yard.slots, label: 'merge trial batch-gate (other project)', reserved: true });
  const suite = await acquireVerificationSlot({ directory: yard.slots, label: 'npm test (other project)' });

  // Waiting: status names the wait and no run, and the wait is not the gate's time.
  const first = yard.loop();
  const flight = (await batchGateStep(first))!.gate!;
  await until(() => /waiting for a host heavy-job slot/.test(yard.summary()?.progress ?? ''), 'status says the gate\'s check waits for a slot');
  assert.equal(yard.summary()!.run, null);
  yard.advance(10 * minute);
  await yard.waited(10 * minute);
  otherGate.release(); suite.release();

  // Running: status names the run and its step, and the earlier wait.
  const watched = await yard.watching(0), run = yard.runs[0]!;
  watched.onStep?.('build');
  await until(() => yard.summary()?.progress === 'build', 'status names the run\'s step');
  assert.equal(yard.summary()!.run, basename(run.directory), 'status names the exact run');
  assert.ok(yard.summary()!.waitedMs >= 10 * minute, 'status counts the slot wait as waited');
  assert.deepEqual(yard.record().inFlight!.checks, ['build', 'e2e:graphyard-feature-map', 'affected'], 'the batch\'s checks: the build, the real-app feature check and the affected tests');
  await until(() => !!yard.record().inFlight?.seenAt, 'the loop\'s sight of the run is on the record');

  // The loop restarts under the run: it stops watching, the run goes on, and an hour passes before the next loop.
  noteBatchGateStopping(first.state);
  watched.reject(new Error('the loop stopped'));
  await flight;
  assert.equal(yard.record().inFlight!.run!.directory, run.directory, 'the interrupted gate keeps its batch and its run');
  yard.advance(60 * minute);

  // The next loop adopts the same run: no second attempt, no time-out for the time it was down.
  const second = yard.loop();
  const adoptedFlight = (await batchGateStep(second))!.gate!;
  const adoptedWatch = await yard.watching(0, 2);
  adoptedWatch.onStep?.('tests');
  await until(() => yard.summary()?.progress === 'tests', 'status follows the adopted run');
  assert.equal(yard.summary()!.run, basename(run.directory));
  assert.equal(yard.runs.length, 1, 'no duplicate attempt beside the live run');
  adoptedWatch.resolve(passing);
  await adoptedFlight;
  const settled = yard.record();
  assert.equal(settled.verified, yard.tip, 'the adopted run\'s verdict verified main');
  assert.equal(settled.lastOutcome!.outcome, 'verified');
  assert.equal(settled.inFlight, null);
  assert.deepEqual([yard.runs.length, yard.adopted], [1, [run.directory]], 'the batch\'s checks ran once, in the one run');
  assert.deepEqual(holders(yard.slots), [], 'the settled gate holds no host slot');

  // Ordinary dispatch resumes: the next cycle starts the queued merge trial.
  const candidate = { sha: sha('head2'), baseSha: yard.tip, pr: 2, branch: 'graphyard/gy-2-1', author: 'worker' };
  const gates = ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: name !== 'merge', reasons: [] }));
  const work = [{
    id: 'w2', key: 'GY-2', title: 'Queued merge', description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
    policy: { checks: ['test'], review: true }, revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(start), ready: true, epoch: 1, lease: null,
    workspaces: [], submission: { epoch: 1, pr: 2 }, candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [], sessions: [], gates, stage: 'build', mergeLedger: null,
    observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, baseTip: yard.tip, baseTipContained: true, at: iso(start) },
  }] as unknown as Work[];
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository, baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy' } } });
  const state = emptyDaemonState(config);
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), snapshot: async () => ({ work, now: iso(yard.now()) }),
    closeSession: () => {}, dispatch: async () => {}, dispatchTick: async () => {}, persist: async () => {}, mergeWriter: yard.reads } as unknown as DaemonEffects;
  await runCycle(config, state, effects, yard.now);
  await until(() => yard.merges.includes('GY-2'), 'the queued merge trial starts within one cycle');
  await mergeWriterIdle(state);
});
