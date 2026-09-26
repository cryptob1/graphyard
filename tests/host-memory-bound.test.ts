import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import type { NextActionKind } from '../src/model/next-action.js';
import { classifyAttention } from '../src/model/fault-classes.js';
import { masterConfigSchema, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { daemonSummary } from '../src/daemon/run.js';
import { cycleFaults } from '../src/daemon/faults.js';
import { memoryActionKey } from '../src/daemon/cycle-dispatch.js';
import { emptyDispatchCursor, launchingKinds, runDispatchTick, runExecutorTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { hostMemoryAttention, hostMemoryFloor, hostMemoryHold, memoryConsumers, type HostMemoryReading } from '../src/master-resources.js';
import { acquireVerificationSlot, defaultVerificationSlots, heavyCommand, heldSlots, verificationEnvironment, verificationSlotsDirectory } from '../src/master/verification-slots.js';

/**
 * GY-612: concurrent agent test runs exhausted host memory. On a 62 GB host fourteen full suites
 * and five `tsc --noEmit` runs were live at once and available memory fell to one or two gigabytes.
 * unit:host-verification-slots bounds heavy verification runs per host; unit:dispatch-defers-on-host-memory
 * holds new launches while the host is below its memory floor and resumes them once it recovers.
 */

const GiB = 2 ** 30;

// ---- AC-1 --------------------------------------------------------------------------------------

test('unit:host-verification-slots — heavy verification runs started by a session take a host-wide slot: more runs than slots never exceed the bound at once, the rest wait saying on what, and all complete', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'gy-slots-'));
  try {
    // The bound: max(2, floor(total GB / 8)), overridable per host.
    assert.equal(defaultVerificationSlots(62 * GiB), 7);
    assert.equal(defaultVerificationSlots(8 * GiB), 2, 'never fewer than two');
    assert.equal(heavyCommand('tsc', ['--noEmit']), true);
    assert.equal(heavyCommand('npx', ['tsc', '--noEmit']), true);
    assert.equal(heavyCommand('npx', ['vite', 'build']), false);
    assert.equal(heavyCommand('tsc', ['--version']), false);

    // The session harness's environment: a lock directory under the managed worktree root, the bound,
    // and the wrapper directory first on PATH. A fake `tsc` stands in for the real one after it.
    const managedRoot = join(scratch, 'managed'), fakeBin = join(scratch, 'fake-bin'), log = join(scratch, 'runs.log');
    await mkdir(fakeBin, { recursive: true });
    await writeFile(join(fakeBin, 'tsc'), `#!/bin/sh\necho "start $$" >> "$RUN_LOG"\nsleep 0.4\necho "end $$" >> "$RUN_LOG"\n`);
    await chmod(join(fakeBin, 'tsc'), 0o755);
    const environment = verificationEnvironment(managedRoot, { PATH: [fakeBin, process.env.PATH].join(delimiter), GRAPHYARD_VERIFICATION_SLOTS: '2' });
    const directory = verificationSlotsDirectory(managedRoot);
    assert.equal(environment.GRAPHYARD_VERIFICATION_SLOTS_DIR, directory);
    assert.equal(environment.GRAPHYARD_VERIFICATION_SLOTS, '2');
    assert.equal(environment.PATH.split(delimiter)[0], join(directory, 'bin'));
    assert.ok(existsSync(join(directory, 'bin', 'tsc')) && existsSync(join(directory, 'bin', 'npx')));

    // Five runs, two slots: `tsc --noEmit` as a session types it, through the wrapper on its PATH.
    const runs = 5;
    const outcomes = await Promise.all(Array.from({ length: runs }, () => new Promise<{ code: number | null; stderr: string }>(done => {
      const child = spawn('tsc', ['--noEmit'], { env: { ...process.env, ...environment, RUN_LOG: log }, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('close', code => done({ code, stderr }));
    })));
    assert.deepEqual(outcomes.map(outcome => outcome.code), Array(runs).fill(0), 'every run completes');
    const events = (await readFile(log, 'utf8')).trim().split('\n').map(line => line.split(' ')[0]);
    let running = 0, peak = 0;
    for (const event of events) { running += event === 'start' ? 1 : -1; peak = Math.max(peak, running); }
    assert.equal(events.filter(event => event === 'start').length, runs);
    assert.equal(events.filter(event => event === 'end').length, runs);
    assert.equal(peak, 2, 'no more than the bound ran at once, and the bound was used');
    const waited = outcomes.filter(outcome => /waits for a host verification slot: all 2 under .+ are held by tsc --noEmit \(pid \d+/.test(outcome.stderr));
    assert.ok(waited.length >= runs - 2, 'each run that waited said it waits, on what, and who holds the slots');
    assert.deepEqual(heldSlots(directory), [], 'every slot is given back');

    // A slot whose owner died is taken back by the next run rather than held forever.
    await mkdir(join(directory, 'slot-0'));
    await writeFile(join(directory, 'slot-0', 'owner.json'), JSON.stringify({ pid: 999_999_999, label: 'npm test', cwd: '/gone', at: new Date().toISOString() }));
    const taken = await acquireVerificationSlot({ directory, slots: 1, label: 'npm test', alive: pid => pid === process.pid, pollMs: 10 });
    assert.equal(taken.slot, 0);
    assert.equal(heldSlots(directory)[0].owner?.pid, process.pid);
    taken.release();

    // In one process too: more acquisitions than slots, never more than the bound held at once.
    let held = 0, most = 0; const lines: string[] = [];
    await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const slot = await acquireVerificationSlot({ directory, slots: 2, label: `run ${index}`, pollMs: 5, onWait: line => lines.push(line) });
      held++; most = Math.max(most, held);
      await new Promise(done => setTimeout(done, 30));
      held--; slot.release();
    }));
    assert.equal(most, 2);
    assert.ok(lines.some(line => line.includes('waits for a host verification slot')));
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

// ---- AC-2 --------------------------------------------------------------------------------------

const at = Date.parse('2026-09-26T11:50:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const low: HostMemoryReading = { totalBytes: 62 * GiB, availableBytes: 2 * GiB, consumers: memoryConsumers([[14, 'node'], [5.7, 'claude'], [2.8, 'opencode'], [1, 'postgres']].map(([gb, command]) => `${Math.round(Number(gb) * 1024 * 1024)} ${command}`).join('\n')) };
const recovered: HostMemoryReading = { totalBytes: 62 * GiB, availableBytes: 20 * GiB };
const worker = { name: 'worker-a', principal: 'agent-a', agentName: 'agent-worker-a', mode: 'launch', kind: 'codex', credentialFile: '/nonexistent', agentArgs: [], environment: {} } as unknown as WorkerProfile;
const config = masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:9', credentialFile: '/nonexistent/coordinator.json', cliPath: '/nonexistent/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [worker],
  producers: [{ name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'claude', credentialFile: '/nonexistent/producer-a.token' }],
  reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' }], reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: '/nonexistent/reviewer.json', boundAt: iso(at) } }) as MasterConfig;
const ready = { id: 'work-ready', key: 'GY-44', title: 'Ready', description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:x'] }],
  policy: { checks: ['test'], review: true }, plannedFiles: ['src/ready.ts'], stage: 'ready', revision: 1, policyRevision: 1, createdAt: iso(at), updatedAt: iso(at), stageEnteredAt: iso(at), ready: true, epoch: 0,
  lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
  gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [] } as unknown as Work;
function loopEffects(log: string[], memory: () => HostMemoryReading): DaemonEffects {
  return {
    agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: [ready], now: iso(at) }), closeSession: () => {}, dispatch: async item => { log.push(`dispatch:${item.key}`); },
    requestProof: () => {}, merge: async () => ({ result: 'merge requested' }), recordDeployment: async () => {}, requestSmoke: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(at), reason: 'not configured', deployed: [], pending: [] }) as any,
    persist: async () => {}, hostMemory: async () => memory(),
  } as DaemonEffects;
}
/** A submitted head with open producer requests, as the control plane raises them at the build gate. */
function submitted(): Work {
  const sha = 'a1'.padEnd(40, 'f'), baseSha = 'b1'.padEnd(40, 'f'), candidate = { sha, baseSha, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' };
  const item = { id: 'work-64', key: 'GY-64', title: 'Submitted', description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Proof', proofs: ['unit:memory-proof'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 1,
    createdAt: iso(at), updatedAt: iso(at), stageEnteredAt: iso(at), ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 64 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [], at: iso(at), prState: 'open', draft: false, baseTip: baseSha, baseTree: '7b'.padEnd(40, 'f'), baseTipContained: true },
    blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }], violations: [] } as unknown as Work;
  reconcileAutoDispatch(item, [item], new Date(at));
  return item;
}

test('unit:dispatch-defers-on-host-memory — below the memory floor the loop defers new launches with a recorded reason, raises one resources attention item naming the top consumers, and resumes once memory recovers', async () => {
  assert.equal(hostMemoryFloor(62 * GiB), 62 * GiB * 0.1, '10% of total on a large host');
  assert.equal(hostMemoryFloor(16 * GiB), 4 * GiB, '4 GB on a small one');
  let memory = low;
  const log: string[] = [];
  const state = emptyDaemonState(config);

  // Low: nothing is dispatched, and the deferral is recorded with its reason and consumers.
  await runCycle(config, state, loopEffects(log, () => memory));
  assert.deepEqual(log, [], 'no worker is launched while the host is below its floor');
  const deferred = state.actions[memoryActionKey];
  assert.match(deferred.detail, /^Launches deferred: host machine-a has 2\.0 GB of 62\.0 GB memory available, below its 6\.2 GB floor, so new session launches on it are deferred until memory recovers; top consumers: node 14\.0 GB, claude 5\.7 GB, opencode 2\.8 GB, postgres 1\.0 GB$/);
  assert.equal(state.memory?.low, true);
  assert.equal(daemonSummary(state, at, 30_000, 'machine-a').memory?.low, true, 'master status reads it from the loop');

  // One `resources` attention item, naming the top consumers, from master status and from the loop's fault tracking.
  const attention = classifyAttention(hostMemoryAttention(state.memory));
  assert.equal(attention.length, 1);
  assert.equal(attention[0].faultClass, 'resources');
  assert.match(attention[0].text, /top consumers: node 14\.0 GB, claude 5\.7 GB/);
  const faults = cycleFaults(state, [ready], at, { config }).filter(fault => fault.faultClass === 'resources');
  assert.deepEqual(faults.map(fault => fault.kind), ['memory-pressure']);

  // Still low: still deferred, and the crossing is not recorded again.
  await runCycle(config, state, loopEffects(log, () => memory));
  assert.deepEqual(log, []);
  assert.equal(state.actions[memoryActionKey].attempts, deferred.attempts);

  // Producer and reviewer launches wait on it too, with the same reason.
  const item = submitted(), launched: string[] = [];
  const dispatchEffects: DispatchEffects = {
    snapshot: async () => ({ work: [item], now: iso(at) }), agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    reconcileReviews: async () => ({ reviews: [] }), reconcileProducers: async () => ({ producers: [] }),
    launchReview: async () => { launched.push('review'); }, launchProducer: async () => { launched.push('producer'); },
    persist: async () => {}, hostMemory: async () => memory,
  };
  const tick = await runDispatchTick(config, emptyDispatchCursor(config), dispatchEffects, () => at);
  assert.equal(launched.length, 0, 'no reviewer or producer is launched');
  assert.ok(tick.waiting.length > 0 && tick.waiting.every(wait => /below its 6\.2 GB floor, so new session launches on it are deferred/.test(wait.reason)));
  // The executor claims no launching row meanwhile: the rows wait in the queue without failing.
  const claims: NextActionKind[][] = [];
  const idle = await runExecutorTick({ id: 'executor-a', host: 'machine-a' }, { claim: async request => { claims.push(request.kinds); return { action: null }; }, settle: async () => {},
    handlers: { dispatch: async () => 'launched', 'request-review': async () => 'launched', resync: async () => 'resynced' }, launchHold: () => hostMemoryHold('machine-a', async () => memory, () => at) });
  assert.deepEqual(claims, [['resync']]);
  assert.ok(claims[0].every(kind => !launchingKinds.includes(kind)));
  assert.match(idle.reason, /launches none: host machine-a has 2\.0 GB/);

  // Recovered: the loop resumes launching and says so, and the attention clears.
  memory = recovered;
  await runCycle(config, state, loopEffects(log, () => memory));
  assert.deepEqual(log, ['dispatch:GY-44']);
  assert.match(state.actions[memoryActionKey].detail, /^Launches resumed: host machine-a has 20\.0 GB of 62\.0 GB memory available again, above its 6\.2 GB floor \(deferred since /);
  assert.equal(state.memory?.low, false);
  assert.deepEqual(hostMemoryAttention(state.memory), []);
  launched.length = 0;
  await runDispatchTick(config, emptyDispatchCursor(config), dispatchEffects, () => at);
  assert.ok(launched.includes('producer'), 'producer launches resume');
  claims.length = 0;
  await runExecutorTick({ id: 'executor-a', host: 'machine-a' }, { claim: async request => { claims.push(request.kinds); return { action: null }; }, settle: async () => {},
    handlers: { dispatch: async () => 'launched', resync: async () => 'resynced' }, launchHold: () => hostMemoryHold('machine-a', async () => memory, () => at) });
  assert.ok(claims[0].includes('dispatch'), 'the executor claims dispatch rows again');
});
