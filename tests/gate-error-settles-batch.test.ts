import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapGate, gateRecordPath, readGateRecord, writeGateRecord } from '../src/batch-gate.js';
import { batchGateStep, noteBatchGateStopping } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import { TrialTimeoutError } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3567: a gate run that threw on a host fault left its batch standing, so every later cycle
// adopted the finished run's directory and replayed the same failure until a human edited the
// record. A thrown gate now settles its batch: the next cycle launches a fresh run on main's tip.

const repository = 'owner/project';
const start = Date.parse('2030-06-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const passing = { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {}, e2e: [] } as unknown as MergeTrialRun;

/**
 * A main with a verified base and one merge past it, and a gate whose checks run detached. Each
 * launch answers `verdict(launch number)`; a run directory once launched is adoptable, and an
 * adopted run answers what that run answered (a finished run replays its result).
 */
async function world(label: string, verdict: (launch: number) => Promise<MergeTrialRun>) {
  const base = await temporaryDirectory(label);
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
  const file = gateRecordPath(coordinator);
  await writeGateRecord(file, { ...bootstrapGate(repository, verified), diagnosticsAt: iso(start) });
  const runs = new Map<string, () => Promise<MergeTrialRun>>();
  const launched: string[] = [], adopted: string[] = [];
  const reads: MergeWriterReads = {
    baseBranch: 'main', now: () => start, cores: 2, parallel: 1,
    fetch: async () => { git(coordinator, 'fetch', '-q', 'origin', 'main'); return git(coordinator, 'rev-parse', 'origin/main'); },
    git: async (args, extra) => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
    merge: async () => { throw new Error('unused'); },
    trial: async () => { throw new Error('every gate check runs detached'); },
    launchTrialRun: request => {
      const directory = join(base, 'runs', `run-${launched.length + 1}`);
      launched.push(directory);
      const answer = verdict(launched.length);
      answer.catch(() => undefined);
      runs.set(directory, () => answer);
      return { directory, mergeSha: request.mergeSha, trial: () => answer, detach: () => {}, cancel: () => {} };
    },
    adoptTrialRun: async ({ directory }) => {
      const run = runs.get(directory);
      if (!run) return null;
      adopted.push(directory);
      return { directory, mergeSha: '', trial: run, detach: () => {}, cancel: () => {} } as any;
    },
    push: async () => 'pushed', holds: async () => true, record: async () => undefined,
    gate: { root: coordinator, repository },
  };
  /** One loop (its own state, as after a restart) running one gate cycle. */
  const loop = () => {
    const state = emptyDaemonState({ url: 'http://127.0.0.1:1', repository } as any);
    return { state, cycle: { state, effects: { mergeWriter: reads } as any, snapshot: { work: [], now: iso(start) } as any, performed: [], now: () => start, log: () => {} } };
  };
  return { file, tip, launched, adopted, loop };
}

const gateOnce = async (cycle: Parameters<typeof batchGateStep>[0]) => { const flight = (await batchGateStep(cycle))!; await flight.gate; await flight.diagnostics; };

for (const [fault, error] of [['a trial-host fault', () => new Error('the trial container is gone')], ['a TrialTimeoutError', () => new TrialTimeoutError('tests', 1_000, '')]] as const) {
  test(`integration:gate-error-settles-batch — after ${fault}, the next gate cycle launches a fresh run on main's tip instead of adopting the finished run`, { timeout: 60_000 }, async () => {
    const yard = await world(`gate-error-${fault.length}`, async launch => { if (launch === 1) throw error(); return passing; });
    await gateOnce(yard.loop().cycle);
    const failed = readGateRecord(yard.file)!;
    assert.equal(failed.lastOutcome?.outcome, 'error');
    assert.equal(failed.lastOutcome?.tip, yard.tip);
    assert.equal(failed.inFlight, null, 'the thrown gate settles its batch');
    await gateOnce(yard.loop().cycle);
    assert.deepEqual(yard.adopted, [], 'the finished run is not adopted');
    assert.equal(yard.launched.length, 2, 'a fresh run launches');
    const after = readGateRecord(yard.file)!;
    assert.equal(after.verified, yard.tip, 'the fresh run on main\'s tip verifies');
    assert.equal(after.lastOutcome?.outcome, 'verified');
  });
}

test('integration:gate-error-settles-batch — a live detached gate run is adopted after a loop restart, and a loop stop leaves the record as last checkpointed', { timeout: 60_000 }, async () => {
  let kill!: (error: Error) => void;
  const live = new Promise<MergeTrialRun>((_, reject) => { kill = reject; });
  const yard = await world('gate-error-restart', async launch => (launch === 1 ? live : passing));
  const first = yard.loop();
  const flight = (await batchGateStep(first.cycle))!.gate!;
  for (const deadline = Date.now() + 10_000; !readGateRecord(yard.file)!.inFlight?.run;) {
    assert.ok(Date.now() < deadline, 'the gate records its launched run');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const checkpointed = readGateRecord(yard.file)!;
  // The stop kills the gate's children, so its check throws; that is no outcome and no settlement.
  noteBatchGateStopping(first.state);
  kill(new Error('killed by the loop stopping'));
  await flight;
  assert.deepEqual(readGateRecord(yard.file), checkpointed, 'a loop stop leaves the record as last checkpointed');
  assert.equal(checkpointed.inFlight?.run?.directory, yard.launched[0]);

  // The next loop adopts the still-live run; once it answers, the gate verifies with no fresh launch.
  const rejoined = new Promise<MergeTrialRun>(resolve => setTimeout(() => resolve(passing), 50));
  // The run outlived the old loop: the adopted run answers its own verdict.
  yard.launched.length = 0;
  const directory = checkpointed.inFlight!.run!.directory;
  const { adopted } = yard;
  const second = yard.loop();
  (second.cycle.effects.mergeWriter as MergeWriterReads).adoptTrialRun = async request => {
    adopted.push(request.directory);
    return request.directory === directory ? { directory, mergeSha: '', trial: () => rejoined, detach: () => {}, cancel: () => {} } as any : null;
  };
  await gateOnce(second.cycle);
  assert.deepEqual(yard.adopted, [directory], 'the live run is adopted');
  assert.deepEqual(yard.launched, [], 'no fresh run launches beside it');
  assert.equal(readGateRecord(yard.file)!.verified, yard.tip);
});

test('e2e:gate-error-settles-batch — after a gate run fails on a host fault, a fresh gate run reaches a verdict once the fault is gone, with no edit to the record', { timeout: 60_000 }, async () => {
  let faulty = true;
  const yard = await world('gate-error-e2e', async () => { if (faulty) throw new Error('the trial host lost its disk'); return passing; });
  await gateOnce(yard.loop().cycle);
  assert.equal(readGateRecord(yard.file)!.lastOutcome?.outcome, 'error');
  // The fault persists for a cycle: each cycle is a fresh run that fails on its own, never a replay.
  await gateOnce(yard.loop().cycle);
  assert.equal(yard.launched.length, 2);
  faulty = false;
  await gateOnce(yard.loop().cycle);
  assert.deepEqual(yard.adopted, [], 'no finished run is replayed');
  assert.equal(yard.launched.length, 3);
  const record = readGateRecord(yard.file)!;
  assert.deepEqual([record.verified, record.lastOutcome?.outcome, record.inFlight], [yard.tip, 'verified', null]);
});
