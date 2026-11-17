import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapGate, gateRecordPath, readGateRecord, writeGateRecord } from '../src/batch-gate.js';
import { batchGateStep, gateStallKey, gateStartStallMs } from '../src/daemon/cycle-batch-gate.js';
import { runCycle } from '../src/daemon/cycle.js';
import { heavyTrial, mergeWriterIdle, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import { acquireVerificationSlot, declarationSlot, gateSlot, heldSlots, readHeavyDrain, requestHeavyDrain, resumeHeavyDrain, slotsDirectoryVariable } from '../src/master/verification-slots.js';
import { masterConfigSchema } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3450: the gate on e27e5826 ran four times with zero check results: its checks queued for the
// host's two heavy-job slots behind item merge trials and worker verifications, and a drain stopped
// new gate runs. The gate now has a reserved slot item work never takes, a drain never stops it, and
// a gate whose checks have not started in five minutes raises the stall alarm naming the holders.

const repository = 'owner/project';
const start = Date.parse('2030-05-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, what: string, timeoutMs = 10_000) {
  for (const deadline = Date.now() + timeoutMs; !condition();) { assert.ok(Date.now() < deadline, `timed out waiting until ${what}`); await sleep(20); }
}
const passing = { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {}, e2e: [] } as unknown as MergeTrialRun;

const previous = process.env[slotsDirectoryVariable];
after(() => { if (previous === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = previous; });
const holders = (directory: string) => heldSlots(directory).filter(entry => entry.slot < declarationSlot).map(entry => entry.owner?.label).sort();

/** A main with a verified base and one merge past it, a host budget of two in the test's own directory, and a loop whose gate launches its checks detached. */
async function world(label: string, verdict: () => Promise<MergeTrialRun> = async () => passing) {
  const base = await temporaryDirectory(label);
  const slots = join(base, 'heavy-jobs');
  await mkdir(slots, { recursive: true });
  await writeFile(join(slots, 'limit'), '2\n');
  process.env[slotsDirectoryVariable] = slots;
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
  let clock = start, checks = 0;
  const reads: MergeWriterReads = {
    baseBranch: 'main', now: () => clock, cores: 2, parallel: 1,
    fetch: async () => { git(coordinator, 'fetch', '-q', 'origin', 'main'); return git(coordinator, 'rev-parse', 'origin/main'); },
    git: async (args, extra) => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
    merge: async head => ({ mergeSha: sha(`merge:${head}`), files: ['src/app.ts'] }),
    trial: async () => { throw new Error('every trial runs detached'); },
    ensureTrialImage: async () => {},
    launchTrialRun: request => ({ directory: join(base, 'runs', request.key), mergeSha: request.mergeSha, trial: () => { checks++; return verdict(); }, detach: () => {}, cancel: () => {} }),
    adoptTrialRun: async () => null,
    push: async () => 'pushed', holds: async () => true, record: async () => undefined,
    drain: () => readHeavyDrain(slots),
    gate: { root: coordinator, repository, slots: join(base, 'trial-slots') },
  };
  const state = emptyDaemonState({ url: 'http://127.0.0.1:1', repository } as any);
  const cycle = { state, effects: { mergeWriter: reads } as any, snapshot: { work: [], now: iso(start) } as any, performed: [], now: () => clock, log: () => {} };
  return { slots, coordinator, tip, reads, state, cycle, checks: () => checks, advance: (ms: number) => { clock += ms; }, now: () => clock,
    verified: () => readGateRecord(gateRecordPath(coordinator))?.verified };
}

/** An item heavy job (a merge trial) that runs until `finish`. */
function itemJob(key: string) {
  let started = false, finish!: () => void;
  const running = new Promise<void>(resolve => { finish = resolve; });
  const done = heavyTrial(key, undefined, undefined, async () => { started = true; await running; });
  return { started: () => started, finish: () => { finish(); return done; } };
}

test('integration:gate-reserved-slot — with both ordinary slots held by item work, the gate check starts at once in the reserved slot under a drain; item work never takes the reserved slot; a gate whose checks have not started in 5 minutes raises the stall alarm naming the holders', { timeout: 120_000 }, async () => {
  // Both ordinary slots held by a merge trial and a worker verification, and a drain set: the gate runs and verifies.
  {
    let during: (string | undefined)[] = [];
    const yard = await world('reserved-gate', async () => { during = holders(yard.slots); return passing; });
    const trial = await acquireVerificationSlot({ directory: yard.slots, label: 'merge trial GY-1' });
    const verification = await acquireVerificationSlot({ directory: yard.slots, label: 'worker verification GY-2' });
    requestHeavyDrain(yard.slots, 'quiet window', 'graphyard-master');
    const started = Date.now();
    const step = await batchGateStep(yard.cycle);
    assert.ok(step?.gate, 'a drain does not stop the gate run');
    await step.gate;
    assert.ok(Date.now() - started < 5_000, 'the gate check did not wait for a slot');
    assert.deepEqual(during, ['merge trial GY-1', 'merge trial batch-gate', 'worker verification GY-2'], 'the gate check runs beside both ordinary holders');
    assert.ok(heldSlots(yard.slots).some(entry => entry.slot === gateSlot) === false, 'the reserved slot is free again');
    assert.equal(yard.verified(), yard.tip, 'the gate verified main');
    assert.equal(yard.checks(), 1);

    // Item work never takes the reserved slot: with the drain lifted and the reserved slot free, a third item trial waits.
    resumeHeavyDrain(yard.slots);
    const third = itemJob('GY-3');
    await sleep(1_500);
    assert.equal(third.started(), false, 'an item merge trial does not take the reserved slot');
    assert.ok(!heldSlots(yard.slots).some(entry => entry.slot === gateSlot));
    trial.release();
    await until(third.started, 'the item trial takes the freed ordinary slot');
    await third.finish();
    verification.release();
  }

  // Every slot held, the reserved one by another project's gate: after five minutes with no check started the alarm names the holders, and clears once a check starts.
  {
    const yard = await world('reserved-gate-stall');
    const other = await acquireVerificationSlot({ directory: yard.slots, label: 'merge trial batch-gate', project: 'other-project', firstSlot: gateSlot, slots: 1 });
    const trial = await acquireVerificationSlot({ directory: yard.slots, label: 'merge trial GY-1' });
    const verification = await acquireVerificationSlot({ directory: yard.slots, label: 'worker verification GY-2' });
    const flight = (await batchGateStep(yard.cycle))!.gate!;
    await sleep(300);
    assert.equal(yard.checks(), 0, 'the gate check waits for a slot');
    yard.advance(gateStartStallMs - 1_000);
    await batchGateStep(yard.cycle);
    assert.equal(yard.state.actions[gateStallKey], undefined, 'no alarm before five minutes');
    yard.advance(1_000);
    await batchGateStep(yard.cycle);
    const alarm = yard.state.actions[gateStallKey];
    assert.equal(alarm?.state, 'failed', 'the stall alarm stands');
    for (const holder of ['merge trial GY-1', 'worker verification GY-2', 'merge trial batch-gate (other-project)']) assert.match(alarm!.detail, new RegExp(holder.replace(/[()]/g, '\\$&')), `the alarm names ${holder}`);
    other.release();
    await flight;
    assert.equal(yard.verified(), yard.tip);
    await batchGateStep(yard.cycle);
    assert.equal(yard.state.actions[gateStallKey], undefined, 'the alarm clears once the gate check started');
    trial.release(); verification.release();
  }
});

test('e2e:gate-reserved-slot — while item trials fill the host budget and a drain is set, a loop cycle starts the batch gate, its check runs and it verifies', { timeout: 120_000 }, async () => {
  const yard = await world('reserved-gate-e2e');
  const first = itemJob('GY-1'), second = itemJob('GY-2');
  await until(() => first.started() && second.started(), 'two item trials fill the host budget');
  requestHeavyDrain(yard.slots, 'quiet window for the gate', 'graphyard-master');
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository, baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy' } } });
  const state = emptyDaemonState(config);
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), snapshot: async () => ({ work: [], now: iso(yard.now()) }),
    closeSession: () => {}, dispatch: async () => {}, dispatchTick: async () => {}, persist: async () => {}, mergeWriter: yard.reads } as unknown as DaemonEffects;
  await runCycle(config, state, effects, yard.now);
  await until(() => yard.verified() === yard.tip, 'the batch gate verifies main under item load and a drain', 15_000);
  assert.equal(yard.checks(), 1, 'the gate check ran');
  assert.equal(state.actions[gateStallKey], undefined, 'no stall alarm');
  await mergeWriterIdle(state);
  await first.finish(); await second.finish();
});
