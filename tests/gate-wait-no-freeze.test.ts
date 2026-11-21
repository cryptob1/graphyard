import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapGate, gateRecordPath, gateSummary, readGateRecord, writeGateRecord } from '../src/batch-gate.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { batchGateStep } from '../src/daemon/cycle-batch-gate.js';
import { runCycle } from '../src/daemon/cycle.js';
import { mergeWriterIdle, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import { acquireVerificationSlot, slotsDirectoryVariable } from '../src/master/verification-slots.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { masterConfigSchema, type WorkerProfile } from '../src/master.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3518: one batch gate waiting for a host heavy-job slot paused every new implementation launch,
// so the items that would have cleared the jam could not start either. A gate that only waits for
// its slot now pauses nothing: free workers launch ready items, and the gate takes the next slot
// that frees. Once its check runs, launches pause as before (GY-3444).

const repository = 'owner/project';
const start = Date.parse('2030-06-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, what: string, timeoutMs = 15_000) {
  for (const deadline = Date.now() + timeoutMs; !condition();) { assert.ok(Date.now() < deadline, `timed out waiting until ${what}`); await sleep(20); }
}
const passing = { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {}, e2e: [] } as unknown as MergeTrialRun;
const previous = process.env[slotsDirectoryVariable];
after(() => { if (previous === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = previous; });

/** Every host heavy-job slot held, a gate waiting for one, a ready item and a free worker. */
async function world(label: string) {
  const base = await temporaryDirectory(label);
  const slots = join(base, 'heavy-jobs');
  await mkdir(slots, { recursive: true });
  await writeFile(join(slots, 'limit'), '1\n');
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
  // The reserved gate slot and the one ordinary slot are both held by other jobs on the host.
  const held = [await acquireVerificationSlot({ directory: slots, label: 'merge trial batch-gate (other project)', reserved: true }),
    await acquireVerificationSlot({ directory: slots, label: 'npm test (other project)' })];
  const checks: { resolve: (run: MergeTrialRun) => void }[] = [];
  const reads: MergeWriterReads = {
    baseBranch: 'main', now: () => start, cores: 2, parallel: 1,
    fetch: async () => { git(coordinator, 'fetch', '-q', 'origin', 'main'); return git(coordinator, 'rev-parse', 'origin/main'); },
    git: async (args, extra) => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
    merge: async () => { throw new Error('unused'); },
    trial: () => new Promise<MergeTrialRun>(resolve => { checks.push({ resolve }); }),
    push: async () => 'pushed', holds: async () => true, record: async () => undefined,
    gate: { root: coordinator, repository },
  };
  const worker = { name: 'w1', principal: 'w1-principal', agentName: 'agent-w1', mode: 'launch', kind: 'claude', credentialFile: '/outside/w1.token', agentArgs: [], environment: {} } as unknown as WorkerProfile;
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository, baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [worker], run: { mergeWriter: { deployKeyFile: '/keys/deploy' } } });
  const ready = {
    id: 'w1', key: 'GY-1', title: 'Clears the jam', description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
    policy: { checks: ['test'], review: true }, revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(start - 60_000),
    ready: true, epoch: 0, lease: null, workspaces: [], submission: null, candidate: null, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: null, blocker: null, violations: [], sessions: [], gates: ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: name === 'ready', reasons: [] })), stage: 'ready',
  } as unknown as Work;
  const work = [ready];
  const dispatched: string[] = [];
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: iso(start) }),
    agents: () => [], herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({ w1: { available: true, reason: null } }),
    closeSession: () => {},
    // The worker claims the item it was launched for.
    dispatch: async target => {
      dispatched.push(target.key);
      Object.assign(ready, { epoch: 1, stage: 'build', lease: { owner: 'w1-principal', epoch: 1, expiresAt: iso(start + 3_600_000) } });
      return { pane: 'p1', epoch: 1 };
    },
    dispatchTick: async () => {},
    mergeWriter: { ...reads, gate: undefined },
    persist: async () => {},
  };
  const state = emptyDaemonState(config);
  const loop = { state, effects: { mergeWriter: reads } as any, snapshot: { work: [], now: iso(start) } as any, performed: [], now: () => start, log: () => {} };
  const summary = () => gateSummary(readGateRecord(gateRecordPath(coordinator))!)!.inFlight;
  return { coordinator, tip, config, state, effects, loop, held, checks, dispatched, work, summary };
}

test('integration:gate-wait-no-freeze — with every heavy-job slot held and the gate waiting for one, a free worker launches the ready item; the gate takes the next slot that frees', { timeout: 120_000 }, async () => {
  const yard = await world('gate-wait-no-freeze');
  const flight = (await batchGateStep(yard.loop))!.gate!;
  await until(() => /waiting for a host heavy-job slot/.test(yard.summary()?.progress ?? ''), 'the gate waits for a slot');

  await runCycle(yard.config, yard.state, yard.effects, () => start);
  await mergeWriterIdle(yard.state);
  assert.deepEqual(yard.dispatched, ['GY-1'], 'the free worker launches the ready item while the gate waits');
  assert.equal(yard.checks.length, 0, 'the gate still waits: it took no slot from anyone');

  // A slot frees: the gate takes it and its check starts.
  for (const slot of yard.held) slot.release();
  await until(() => yard.checks.length === 1, 'the gate\'s check starts on the freed slot');
  yard.checks[0]!.resolve(passing);
  await flight;
  assert.equal(readGateRecord(gateRecordPath(yard.coordinator))!.verified, yard.tip, 'the gate verified main');
});

test('e2e:gate-wait-no-freeze — with the gate waiting for a slot a ready item is claimed, and master status shows both the waiting gate and the claimed item', { timeout: 120_000 }, async () => {
  const yard = await world('gate-wait-no-freeze-status');
  const flight = (await batchGateStep(yard.loop))!.gate!;
  await until(() => /waiting for a host heavy-job slot/.test(yard.summary()?.progress ?? ''), 'the gate waits for a slot');
  await runCycle(yard.config, yard.state, yard.effects, () => start);
  await mergeWriterIdle(yard.state);
  assert.deepEqual(yard.dispatched, ['GY-1']);

  const api = async (path: string) => {
    if (path === 'work-snapshot') return { work: yard.work, now: iso(start) };
    throw Object.assign(new Error('not served'), { status: 404 });
  };
  const run = async (command: string, args: string[]) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'b'.repeat(40)}\n`;
  const status = await masterStatusReport(yard.coordinator, yard.config, api, run as any);
  assert.match(status.batchGate!.inFlight!.progress ?? '', /waiting for a host heavy-job slot/, 'status shows the gate waiting for its slot in one line');
  const item = status.items.find(entry => entry.key === 'GY-1')!;
  assert.equal(item.owner, 'w1-principal', 'status shows the ready item claimed by the worker');

  for (const slot of yard.held) slot.release();
  await until(() => yard.checks.length === 1, 'the gate\'s check starts on the freed slot');
  yard.checks[0]!.resolve(passing);
  await flight;
});
