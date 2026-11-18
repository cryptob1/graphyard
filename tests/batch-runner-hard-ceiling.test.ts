import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapGate, gateBoundMs, gateCeilingMs, gateRecordPath, readGateRecord, writeGateRecord } from '../src/batch-gate.js';
import { batchGateStep } from '../src/daemon/cycle-batch-gate.js';
import { mergeWriterReads, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import { launchTrialRun, readTrialRunSpec, trialRunFiles, trialRunsDirectory } from '../src/merge-writer/trial-run.js';
import { runFiles } from '../src/runner/pi.js';
import { slotsDirectoryVariable } from '../src/master/verification-slots.js';
import { masterConfigSchema } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3509: after GY-3507 bounded a gate run at 90 minutes, a new batch run's trial still received
// hours: the gate handed its runner the time left plus two more bounds, and a host with busy trial
// slots multiplied that again by the share. The runner now gets the gate's own remaining time.

const repository = 'owner/project', minute = 60_000, ceilingMs = 5_400_000;
const start = Date.parse('2026-11-18T08:00:00Z');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const passing = { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {}, e2e: [] } as unknown as MergeTrialRun;
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository, baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy' } } });

const previous = process.env[slotsDirectoryVariable];
after(() => { if (previous === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = previous; });

/** A main with one merge past its verified commit, a gate record whose history says hundreds of minutes, and a loop with two merge trials in flight beside the gate. */
async function world(label: string) {
  const base = await temporaryDirectory(label);
  const slots = join(base, 'heavy-jobs'), trialSlots = join(base, 'trial-slots');
  await mkdir(slots, { recursive: true }); await mkdir(trialSlots, { recursive: true });
  await writeFile(join(slots, 'limit'), '4\n');
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
  // Inflated history: every verified run, the catalog and the selected tests' gate runs took hours.
  const hours = [400, 420, 450, 480, 500].map(ms => ({ ms: ms * minute, at: new Date(start - minute).toISOString() }));
  await writeGateRecord(gateRecordPath(coordinator), { ...bootstrapGate(repository, verified), diagnosticsAt: new Date(start).toISOString(), verifiedRuns: hours, gateRuns: hours, catalogMs: 1000 * minute });
  const reads: MergeWriterReads = {
    baseBranch: 'main', now: () => start, cores: 24, parallel: 3,
    fetch: async () => { git(coordinator, 'fetch', '-q', 'origin', 'main'); return git(coordinator, 'rev-parse', 'origin/main'); },
    git: async (args, extra) => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
    merge: async () => { throw new Error('unused'); }, trial: async () => { throw new Error('unused'); },
    push: async () => 'pushed', holds: async () => true, record: async () => undefined,
    gate: { root: coordinator, repository, slots: trialSlots },
  };
  const loop = () => {
    const state = emptyDaemonState({ url: 'http://127.0.0.1:1', repository } as any);
    // Two merge trials in flight: with the gate, a share of 3.
    state.mergeWriter.inFlights = [{ key: 'GY-1' }, { key: 'GY-2' }] as any;
    return { state, effects: { mergeWriter: reads } as any, snapshot: { work: [], now: new Date(start).toISOString() } as any, performed: [], now: () => start, log: () => {} };
  };
  const record = () => readGateRecord(gateRecordPath(coordinator))!;
  return { coordinator, tip, reads, loop, record };
}

test('integration:batch-runner-hard-ceiling — a batch over hours of recorded history, beside two busy trial slots, hands its runner at most 90 minutes: the bounded deadline is never multiplied', { timeout: 60_000 }, async () => {
  const yard = await world('runner-ceiling-integration');
  assert.equal(gateBoundMs(yard.record()), gateCeilingMs, 'the inflated history meets the 90-minute ceiling');
  const limits: number[] = [];
  // The runner boundary the loop uses for an in-process trial: the merge writer's own trial, its runMergeTrial substituted.
  const runner = mergeWriterReads(config, yard.coordinator, async () => '', { base: '/managed', record: async () => ({}),
    trial: async input => { limits.push(input.timeoutMs); return passing; } });
  yard.reads.trial = runner.trial;
  await (await batchGateStep(yard.loop()))!.gate!;
  assert.deepEqual(yard.record().lastOutcome && yard.record().lastOutcome!.outcome, 'verified');
  assert.ok(limits.length >= 1);
  for (const limit of limits) assert.ok(limit <= ceilingMs, `the runner's timeout is ${limit} ms, at most 5400000`);
  assert.equal(limits[0], gateCeilingMs, 'the runner gets the gate\'s own remaining time, not three bounds times the share');
});

test('e2e:batch-runner-hard-ceiling — a new batch run through the loop\'s gate step and the detached runner launch writes a spec and outer deadline of at most 90 minutes, keeps every check, and settles on its verdict', { timeout: 60_000 }, async () => {
  const yard = await world('runner-ceiling-e2e');
  const directories: string[] = [];
  yard.reads.ensureTrialImage = async () => {};
  // The production launch, its spawn standing in for the detached node child (this process, alive).
  yard.reads.launchTrialRun = request => {
    const handle = launchTrialRun({ runsRoot: trialRunsDirectory(yard.coordinator), pollMs: 20, spawn: (() => ({ pid: process.pid, on: () => {}, unref: () => {} })) as any,
      spec: { version: 1, ...request, root: yard.coordinator, base: '/managed', hidden: [], startedAt: new Date().toISOString() } });
    directories.push(handle.directory);
    return handle;
  };
  yard.reads.adoptTrialRun = async () => null;
  const flight = (await batchGateStep(yard.loop()))!.gate!;
  const until = async (condition: () => boolean, what: string) => { for (const deadline = Date.now() + 15_000; !condition();) { assert.ok(Date.now() < deadline, what); await new Promise(resolve => setTimeout(resolve, 20)); } };
  await until(() => !!yard.record().inFlight?.run, 'the gate launched its run and saved it on the record');
  const directory = directories[0]!;
  try {
    const spec = (await readTrialRunSpec(directory))!;
    const meta = JSON.parse(readFileSync(runFiles(directory).meta, 'utf8')) as { timeoutMs: number };
    assert.ok(spec.timeoutMs <= ceilingMs, `the batch spec's timeout is ${spec.timeoutMs} ms`);
    assert.ok(meta.timeoutMs <= ceilingMs, `the run's outer deadline is ${meta.timeoutMs} ms`);
    assert.equal(spec.timeoutMs, gateCeilingMs);
    assert.deepEqual(yard.record().inFlight!.checks, ['build', 'affected'], 'every required check is retained');
    assert.equal(yard.record().inFlight!.run!.directory, directory);
  } finally {
    // The run's verdict, written as the detached runner writes it, so the gate settles whatever the assertions found.
    await writeFile(trialRunFiles(directory).result, `${JSON.stringify({ ok: true, run: passing })}\n`);
  }
  await flight;
  assert.equal(yard.record().verified, yard.tip, 'the run\'s verdict settles the batch');
});
