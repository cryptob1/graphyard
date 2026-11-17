import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapGate, gateLimitMs, gateRecordPath, gateSummary, readGateRecord, writeGateRecord } from '../src/batch-gate.js';
import { batchGateStep, noteBatchGateStopping } from '../src/daemon/cycle-batch-gate.js';
import { runCycle } from '../src/daemon/cycle.js';
import { heavyTrial, mergeWriterIdle, mergeWriterSummary, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import { acquireVerificationSlot, declarationSlot, heldSlots, slotsDirectoryVariable } from '../src/master/verification-slots.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3449: a batch gate on e27e5826 timed out while a step of its check that cannot be cancelled —
// the trial image's build — was still settling, and its host heavy-job slot stayed taken; with two
// slots host-wide, merge trials (the fixes for those timeouts among them) could not start. A gate
// run that ends for any reason now gives its slot back at once.

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
const passing = { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: { 'unit:item-works': { executed: 1, failed: 0 } }, e2e: [] } as unknown as MergeTrialRun;
const failing = { ...passing, build: 'fail' } as unknown as MergeTrialRun;

const previous = process.env[slotsDirectoryVariable];
after(() => { if (previous === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = previous; });
/** The jobs holding the test host's heavy-job slots, by label. */
const holders = (directory: string) => heldSlots(directory).filter(entry => entry.slot < declarationSlot).map(entry => entry.owner?.label);

/**
 * A main with a verified base and one merge past it, a host heavy-job budget of `limit` in the
 * test's own directory, and a loop whose gate launches its checks detached. The trial image build
 * before each launch is `image` (it cannot be cancelled); the detached run answers `verdict`.
 */
async function world(label: string, options: { limit: number; image: (call: number) => Promise<void>; verdict: (key: string) => Promise<MergeTrialRun> }) {
  const base = await temporaryDirectory(label);
  const slots = join(base, 'heavy-jobs');
  await mkdir(slots, { recursive: true });
  await writeFile(join(slots, 'limit'), `${options.limit}\n`);
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
  let clock = start, images = 0;
  const launches: string[] = [];
  const reads: MergeWriterReads = {
    baseBranch: 'main', now: () => clock, cores: 2, parallel: 1,
    fetch: async () => { git(coordinator, 'fetch', '-q', 'origin', 'main'); return git(coordinator, 'rev-parse', 'origin/main'); },
    git: async (args, extra) => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
    merge: async head => ({ mergeSha: sha(`merge:${head}`), files: ['src/app.ts'] }),
    trial: async () => { throw new Error('every trial runs detached'); },
    ensureTrialImage: () => options.image(++images),
    launchTrialRun: request => {
      launches.push(request.key);
      return { directory: join(base, 'runs', request.key), mergeSha: request.mergeSha, trial: () => options.verdict(request.key), detach: () => {}, cancel: () => {} };
    },
    adoptTrialRun: async () => null,
    push: async () => 'pushed', holds: async () => true, record: async () => undefined,
    gate: { root: coordinator, repository, slots: join(base, 'trial-slots') },
  };
  const state = emptyDaemonState({ url: 'http://127.0.0.1:1', repository } as any);
  const cycle = { state, effects: { mergeWriter: reads } as any, snapshot: { work: [], now: iso(start) } as any, performed: [], now: () => clock, log: () => {} };
  return { slots, coordinator, tip, reads, state, cycle, launches, images: () => images, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

/** A merge trial queued behind the gate: it starts once it holds a slot of the host budget. */
const mergeTrial = () => {
  let started = false;
  const done = heavyTrial('GY-9', undefined, undefined, async () => { started = true; });
  return { started: () => started, done };
};

test('integration:gate-releases-heavy-slot — a gate run that verifies, is held, times out or is interrupted by a loop restart releases its host heavy-job slot, and a merge trial waiting on that slot starts at once', { timeout: 120_000 }, async () => {
  // Verified: the slot is the gate's while its check runs, and free once the run settles.
  {
    let during: (string | undefined)[] = [];
    const yard = await world('gate-slot-verified', { limit: 1, image: async () => {}, verdict: async () => { during = holders(yard.slots); return passing; } });
    await (await batchGateStep(yard.cycle))!.gate;
    assert.deepEqual(during, ['merge trial batch-gate'], 'the gate\'s check holds a host heavy-job slot');
    assert.equal(readGateRecord(gateRecordPath(yard.coordinator))!.verified, yard.tip);
    assert.deepEqual(holders(yard.slots), [], 'a verified gate holds no slot');
  }

  // Held: the build fails twice and no merged item is left to revert.
  {
    const yard = await world('gate-slot-held', { limit: 1, image: async () => {}, verdict: async () => failing });
    await (await batchGateStep(yard.cycle))!.gate;
    assert.ok(readGateRecord(gateRecordPath(yard.coordinator))!.held, 'the gate is held');
    assert.deepEqual(holders(yard.slots), [], 'a held gate holds no slot');
  }

  // Timed out: the first run's image build is still settling when the gate's bound passes. Its slot
  // is reclaimed at once, so the retry on the newest main starts, verifies, and a merge trial follows.
  {
    let finishImage!: () => void;
    const hung = new Promise<void>(resolve => { finishImage = resolve; });
    const yard = await world('gate-slot-timeout', { limit: 1, image: call => call === 1 ? hung : Promise.resolve(), verdict: async () => passing });
    const flight = (await batchGateStep(yard.cycle))!.gate!;
    await until(() => yard.images() === 1, 'the gate\'s first run builds the trial image');
    assert.deepEqual(holders(yard.slots), ['merge trial batch-gate']);
    yard.advance(gateLimitMs + 1);
    await until(() => yard.images() === 2, 'the timed-out run\'s slot goes to the retry', 15_000);
    await flight;
    assert.equal(readGateRecord(gateRecordPath(yard.coordinator))!.verified, yard.tip, 'the retry verified main');
    assert.deepEqual(holders(yard.slots), [], 'the timed-out run left no slot behind though its image build has not settled');
    const merge = mergeTrial();
    await until(merge.started, 'a waiting merge trial takes the freed slot');
    await merge.done;
    finishImage();
  }

  // Interrupted by a loop restart: the slot frees when the loop stops; the detached run is left for the next loop to adopt.
  {
    let finishImage!: () => void;
    const hung = new Promise<void>(resolve => { finishImage = resolve; });
    const yard = await world('gate-slot-restart', { limit: 1, image: () => hung, verdict: async () => passing });
    const flight = (await batchGateStep(yard.cycle))!.gate!;
    await until(() => holders(yard.slots).length === 1, 'the gate takes its slot');
    const merge = mergeTrial();
    await sleep(300);
    assert.equal(merge.started(), false, 'the merge trial waits while the gate runs');
    noteBatchGateStopping(yard.state);
    await until(merge.started, 'the stopping loop\'s gate slot goes to the waiting merge trial');
    await merge.done;
    finishImage();
    await flight;
  }
});

test('e2e:gate-releases-heavy-slot — after a gate timeout, a queued merge trial takes the freed slot within one cycle and master status shows no stale holder', { timeout: 120_000 }, async () => {
  let finishImage!: () => void;
  const hung = new Promise<void>(resolve => { finishImage = resolve; });
  // Two slots, as on a real host; another project's suite holds one throughout.
  const yard = await world('gate-slot-e2e', { limit: 2, image: call => call === 1 ? hung : Promise.resolve(), verdict: async () => passing });
  const other = await acquireVerificationSlot({ directory: yard.slots, label: 'npm test (other project)' });
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

  // The gate runs first and holds the second slot; its first run's image build hangs past the gate's bound.
  const flight = (await batchGateStep({ ...yard.cycle, state }))!.gate!;
  await until(() => yard.images() === 1, 'the gate builds the trial image');
  assert.deepEqual(holders(yard.slots).sort(), ['merge trial batch-gate', 'npm test (other project)']);
  yard.advance(gateLimitMs + 1);
  let settled = false;
  void flight.then(() => { settled = true; });
  await until(() => settled, 'the gate\'s retry gets a slot after its first run timed out and settles', 15_000);

  // One cycle: the queued merge trial takes the freed slot.
  await runCycle(config, state, effects, yard.now);
  await until(() => yard.launches.includes('GY-2'), 'the queued merge trial starts within one cycle');
  const status = mergeWriterSummary(state.mergeWriter, yard.now());
  const steps = [status.inFlight, ...(status.inFlights ?? [])].map(entry => entry?.step ?? '');
  assert.ok(!steps.some(step => /batch-gate/.test(step)), `master status names no stale holder: ${JSON.stringify(steps)}`);
  assert.equal(gateSummary(readGateRecord(gateRecordPath(yard.coordinator)))!.inFlight, null, 'the gate holds nothing in flight');
  assert.ok(!holders(yard.slots).includes('merge trial batch-gate'), 'no slot is held for the gate');
  await mergeWriterIdle(state);
  other.release();
  finishImage();
});
