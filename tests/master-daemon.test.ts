import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireDaemonLock, actionDetailMax, candidateKey, cycleFailureDelay, cycleFailureStart, daemonStatePath, daemonStateSchema, daemonSummary, dispatchKey, emptyDaemonState, noteCycleFailure, profileHealth, pruneDaemonState, readDaemonState, reconcilePendingActions, retainedActions, retriedSnapshot, runCycle, runDaemon, snapshotRetryDelayMs, writeDaemonState, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig, type MasterRun, type WorkerProfile } from '../src/master.js';
import type { Work } from '../src/model.js';
import { readySpecCheck } from './helpers/spec-check.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const workerToken = 'worker-token-'.padEnd(40, 'x');

async function privateDirectory() {
  const directory = await temporaryDirectory('daemon');
  const token = join(directory, 'coordinator.token');
  await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  return { directory, token };
}
function config(credentialFile: string, overrides: Partial<Omit<MasterConfig, 'run'>> & { run?: Partial<MasterRun> } = {}): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], ...overrides });
}
function profile(name: string, credentialFile: string, overrides: Partial<WorkerProfile> = {}): WorkerProfile {
  return { name, principal: `${name}-principal`, agentName: `agent-${name}`, mode: 'launch', kind: 'codex',
    credentialFile, agentArgs: [], environment: {}, ...overrides } as WorkerProfile;
}
const hour = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.parse('2030-01-01T00:00:00Z') + offsetMs).toISOString();
const clock = Date.parse('2030-01-01T00:00:00Z');

function work(overrides: Partial<Work> = {}): Work {
  return {
    id: 'work-1', key: 'GY-42', title: 'Prove the durable loop', description: '', type: 'feature', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:loop'] }],
    policy: { checks: ['test'], review: true }, stage: 'ready', revision: 3, policyRevision: 1,
    createdAt: iso(-4 * hour), updatedAt: iso(0), stageEnteredAt: iso(-2 * hour), ready: true, epoch: 0,
    lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    // GY-2992: a released feature dispatches only with its spec check reported; this fixture stands after it did.
    specCheck: readySpecCheck(iso(-hour)),
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], ...overrides,
  } as Work;
}
const submitted = (overrides: Partial<Work> = {}) => work({
  stage: 'review', epoch: 1, submission: { epoch: 1, pr: 42 },
  candidate: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' },
  gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }],
  ...overrides,
});

function effects(overrides: Partial<DaemonEffects> = {}, log: string[] = []): DaemonEffects {
  return {
    agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: [], now: iso(0) }),
    closeSession: pane => { log.push(`close:${pane}`); },
    dispatch: async item => { log.push(`dispatch:${item.key}`); },
    persist: async () => {},
    ...overrides,
  };
}

test('the daemon cursor lives beside the coordinator credential, stays private, and refuses another repository', async () => {
  const { directory, token } = await privateDirectory();
  try {
    const master = config(token);
    assert.equal(daemonStatePath(master), join(directory, 'coordinator.daemon.json'));
    const root = await temporaryDirectory('daemon-root');
    execFileSync('git', ['init', '-q', root]);
    try {
      assert.equal((await readDaemonState(root, master)).cycle, 0, 'a missing cursor is an empty cursor, not a failure');
      const state = emptyDaemonState(master); state.cycle = 7;
      await writeDaemonState(master, state);
      assert.equal((await stat(daemonStatePath(master))).mode & 0o777, 0o600);
      assert.equal((await readDaemonState(root, master)).cycle, 7);
      await writeDaemonState(config(token, { repository: 'owner/other' }), emptyDaemonState(config(token, { repository: 'owner/other' })));
      await assert.rejects(readDaemonState(root, master), /another Graphyard server or repository/);
    } finally { await rm(root, { recursive: true, force: true }); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('only one loop owns a repository, and a killed daemon reclaims its own lock immediately', async () => {
  const { directory, token } = await privateDirectory();
  try {
    const master = config(token); const state = emptyDaemonState(master);
    acquireDaemonLock(state, { pid: process.pid, host: 'machine-a' }, clock, 20_000);
    assert.equal(state.lock!.pid, process.pid);
    // A live process on this host owns the loop; a second daemon must not double-dispatch.
    assert.throws(() => acquireDaemonLock(state, { pid: process.pid + 1, host: 'machine-a' }, clock, 20_000), /Another Graphyard master loop/);
    // A dead pid on this host is reclaimed without waiting out a staleness window.
    state.lock = { ...state.lock!, pid: 2 ** 22 - 1 };
    acquireDaemonLock(state, { pid: process.pid, host: 'machine-a' }, clock + 1000, 20_000);
    assert.equal(state.lock!.pid, process.pid);
    // Another host can only be judged by heartbeat age.
    state.lock = { ...state.lock!, host: 'machine-b', pid: 999_999, heartbeatAt: iso(0) };
    assert.throws(() => acquireDaemonLock(state, { pid: process.pid, host: 'machine-a' }, clock + 10_000, 20_000), /machine-b/);
    acquireDaemonLock(state, { pid: process.pid, host: 'machine-a' }, clock + 10 * 60_000, 20_000);
    assert.equal(state.lock!.host, 'machine-a');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an interrupted cursor entry is resolved against Graphyard, never repeated from the cursor alone', async () => {
  const { directory, token } = await privateDirectory();
  try {
    const master = config(token); const state = emptyDaemonState(master);
    const landed = work({ id: 'landed', key: 'GY-1', epoch: 1, lease: { owner: 'codex-principal', epoch: 1, expiresAt: iso(60_000) } });
    const lost = work({ id: 'lost', key: 'GY-2' });
    const merged = work({ id: 'merged', key: 'GY-3', stage: 'done', observation: { merged: true } as any });
    // Rework keeps the earlier attempt's submission while the item waits for a new claim, so only an
    // advanced epoch shows the dispatch landed; the worker that finished released its lease instead.
    const reworked = work({ id: 'reworked', key: 'GY-4', epoch: 2, submission: { epoch: 2, pr: 44 }, reworkRequested: true });
    const released = work({ id: 'released', key: 'GY-5', epoch: 3, submission: { epoch: 3, pr: 45 } });
    const dispatchAction = (key: string, epoch: number | null) => ({ kind: 'dispatch' as const, work: key, principal: 'codex-principal', epoch, state: 'started' as const, detail: 'Dispatching', attempts: 1, cycle: 0, at: iso(0) });
    state.actions[dispatchKey(work({ id: 'landed', epoch: 0 }))] = dispatchAction('GY-1', 0);
    state.actions[dispatchKey(work({ id: 'lost', epoch: 0 }))] = dispatchAction('GY-2', 0);
    state.actions[dispatchKey(work({ id: 'reworked', epoch: 2 }))] = dispatchAction('GY-4', 2);
    state.actions[dispatchKey(work({ id: 'released', epoch: 2 }))] = dispatchAction('GY-5', 2);
    state.actions['merge:merged'] = { kind: 'merge', work: 'GY-3', principal: null, epoch: null, state: 'started', detail: 'Merging', attempts: 1, cycle: 0, at: iso(0) };
    state.actions['proof:x'] = { kind: 'proof', work: 'GY-2', principal: null, epoch: null, state: 'started', detail: 'Requesting', attempts: 1, cycle: 0, at: iso(0) };
    const resumed = reconcilePendingActions(state, [landed, lost, merged, reworked, released], clock + 1000);
    assert.equal(resumed.length, 6);
    assert.equal(state.actions[dispatchKey(work({ id: 'landed', epoch: 0 }))].state, 'done');
    assert.match(state.actions[dispatchKey(work({ id: 'landed', epoch: 0 }))].detail, /assignment landed/);
    assert.equal(state.actions[dispatchKey(work({ id: 'lost', epoch: 0 }))].state, 'failed', 'an assignment that never landed must not be lost');
    assert.equal(state.actions[dispatchKey(work({ id: 'reworked', epoch: 2 }))].state, 'failed', 'a submission kept across rework is not proof that this attempt landed');
    assert.equal(state.actions[dispatchKey(work({ id: 'released', epoch: 2 }))].state, 'done', 'a landed dispatch stays done once the finished worker released its lease');
    assert.equal(state.actions['merge:merged'].state, 'done');
    assert.equal(state.actions['proof:x'].state, 'indeterminate');
    // A cursor written before attempt epochs were recorded still resolves against the current attempt.
    state.actions['dispatch:legacy'] = { ...dispatchAction('GY-5', null) };
    state.actions['dispatch:legacy-rework'] = { ...dispatchAction('GY-4', null) };
    reconcilePendingActions(state, [reworked, released], clock + 2000);
    assert.equal(state.actions['dispatch:legacy'].state, 'done');
    assert.equal(state.actions['dispatch:legacy-rework'].state, 'failed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('restarting the loop resumes the cursor without dispatching twice', async () => {
  const { directory, token } = await privateDirectory();
  const workerCredential = join(directory, 'worker.token');
  await writeFile(workerCredential, workerToken, { mode: 0o600 });
  const root = await temporaryDirectory('daemon-root');
  execFileSync('git', ['init', '-q', root]);
  try {
    const master = config(token, { workers: [profile('codex', workerCredential)] });
    const ready = work();
    const review = submitted({ id: 'work-2', key: 'GY-43', policy: { checks: ['test'], review: true, reviewProvider: 'agent', reviewerProfiles: [{ name: 'claude-reviewer', runtime: 'claude', reviewerApp: 'claude-reviewer', timeoutSeconds: 1800 }] } as any });
    const calls: string[] = [];
    let snapshotWork: Work[] = [ready, review];
    const shared = effects({
      snapshot: async () => ({ work: snapshotWork, now: iso(0) }),
      dispatch: async item => {
        calls.push(`dispatch:${item.key}`);
        // The launcher claims under the worker's identity; the next snapshot shows the lease.
        snapshotWork = snapshotWork.map(entry => entry.id === item.id ? { ...entry, epoch: 1, stage: 'build', lease: { owner: 'codex-principal', epoch: 1, expiresAt: iso(120_000) } } as Work : entry);
      },
    }, calls);
    let state = emptyDaemonState(master);
    const persisted: DaemonState[] = [];
    const recording = { ...shared, persist: async (value: DaemonState) => { persisted.push(JSON.parse(JSON.stringify(value))); } };
    await runCycle(master, state, recording, () => clock);
    assert.deepEqual(calls.filter(call => call.startsWith('dispatch')), ['dispatch:GY-42']);

    // Simulate a kill: keep only what reached disk, then restart from it.
    state = JSON.parse(JSON.stringify(persisted.at(-1)));
    await runCycle(master, state, recording, () => clock + 30_000);
    await runCycle(master, state, recording, () => clock + 60_000);
    assert.deepEqual(calls.filter(call => call.startsWith('dispatch')), ['dispatch:GY-42'], 'a restart must not dispatch the same attempt twice');
    assert.equal(state.cycle, 3);
    assert.equal(state.actions[dispatchKey(ready)].state, 'done');
  } finally { await rm(directory, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});

test('a dispatch of operator-authorized rework interrupted by a kill is dispatched again on restart', async () => {
  const { directory, token } = await privateDirectory();
  const workerCredential = join(directory, 'worker.token');
  await writeFile(workerCredential, workerToken, { mode: 0o600 });
  try {
    const master = config(token, { workers: [profile('codex', workerCredential)] });
    // An operator requested rework: the lease is gone and the build gate is open again, but Graphyard
    // keeps the earlier attempt's submission and PR so the new attempt reuses the same branch.
    const rework = submitted({ stage: 'build', reworkRequested: true, lease: null,
      gates: [{ name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }] });
    const calls: string[] = [];
    let snapshotWork: Work[] = [rework];
    const deps = effects({
      snapshot: async () => ({ work: snapshotWork, now: iso(0) }),
      dispatch: async item => {
        calls.push(`dispatch:${item.key}`);
        // The launcher claims for the worker, which is the only thing that advances the attempt.
        snapshotWork = snapshotWork.map(entry => entry.id === item.id
          ? { ...entry, epoch: entry.epoch + 1, lease: { owner: 'codex-principal', epoch: entry.epoch + 1, expiresAt: iso(120_000) } } as Work
          : entry);
      },
    }, calls);
    const state = emptyDaemonState(master);
    // The kill landed between the two cursor writes, so the dispatch is still open against this attempt.
    state.actions[dispatchKey(rework)] = { kind: 'dispatch', work: rework.key, principal: 'codex-principal', epoch: rework.epoch, state: 'started', detail: `Dispatching ${rework.key} to codex`, attempts: 1, cycle: 0, at: iso(0) };

    await runCycle(master, state, deps, () => clock);
    assert.deepEqual(calls.filter(call => call.startsWith('dispatch')), ['dispatch:GY-42'], 'rework whose dispatch never landed must be dispatched again');
    assert.equal(state.actions[dispatchKey(rework)].state, 'done');

    // The retry landed, so a second restart must not dispatch the same attempt twice.
    await runCycle(master, state, deps, () => clock + 30_000);
    assert.deepEqual(calls.filter(call => call.startsWith('dispatch')), ['dispatch:GY-42']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('one cycle closes finished sessions, dispatches, leaves proofs to CI and the green candidate to GitHub, and measures', async () => {
  const { directory, token } = await privateDirectory();
  const workerCredential = join(directory, 'worker.token');
  await writeFile(workerCredential, workerToken, { mode: 0o600 });
  try {
    const master = config(token, { workers: [profile('codex', workerCredential)], run: { intervalSeconds: 20, proofWorkflow: 'acceptance.yml', deploymentShaField: 'commit' } });
    const finished = work({ id: 'finished', key: 'GY-10', stage: 'done', delivery: { mergedAt: iso(-hour), mergeSha: 'c'.repeat(40), authorizationRevision: 5 },
      sessions: [{ id: 'codex-principal:1', kind: 'implementation', principal: 'codex-principal', epoch: 1, runtime: 'codex', host: 'machine-a', pane: 'pane-1', subject: 'GY-10', state: 'running' }] as Work['sessions'] });
    const ready = work();
    const acceptance = submitted({ id: 'acceptance', key: 'GY-44', stage: 'acceptance',
      criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['integration:loop', 'manual:witness'] }],
      gates: [{ name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }, { name: 'acceptance', passed: false, reasons: ['needs evidence'] }] });
    const log: string[] = []; let closed = false;
    const proven = { id: 'e1', proof: 'integration:loop', sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 1, producer: 'ci', trusted: true, result: 'pass' as const, executed: 4, skipped: 0, at: iso(0) };
    const mergeable = submitted({ id: 'mergeable', key: 'GY-45', stage: 'merge', evidence: [proven], gates: [{ name: 'merge', passed: true, reasons: [] }] });
    const deps = effects({
      closeSession: pane => { closed = true; log.push(`close:${pane}`); },
      snapshot: async () => ({ work: [closed ? { ...finished, sessions: [] } : finished, ready, acceptance, mergeable], now: iso(0) }),
    }, log);
    const state = emptyDaemonState(master);
    const result = await runCycle(master, state, deps, () => clock);
    // GY-1235: no proof is requested (CI runs the unit tests, UAT the end-to-end ones) and GitHub merges the green candidate.
    assert.deepEqual(log, ['close:pane-1', 'dispatch:GY-42']);
    const kinds = result.actions.map(action => `${action.kind}:${action.state}`);
    for (const expected of ['close:done', 'dispatch:done']) assert.ok(kinds.includes(expected), `cycle should record ${expected}, recorded ${kinds.join(', ')}`);
    assert.ok(!kinds.some(kind => kind.startsWith('proof:') || kind.startsWith('merge:')), kinds.join(', '));
    // Every cycle measures, whether or not it acted.
    assert.equal(result.metrics.cycle, 0);
    assert.equal(result.metrics.open, 3);
    assert.equal(state.metrics.length, 1);
    // A second cycle repeats no completed action.
    log.length = 0;
    await runCycle(master, state, deps, () => clock + 20_000);
    assert.deepEqual(log, [], 'completed actions must not repeat while the candidate is unchanged');
    assert.equal(state.cycle, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a disabled automatic merge keeps the loop cycling, never merges, and asks no operator for a merge GitHub makes', async () => {
  const { directory, token } = await privateDirectory();
  try {
    const master = config(token, { autoMerge: false });
    const mergeable = submitted({ id: 'mergeable', key: 'GY-45', stage: 'merge', gates: [{ name: 'merge', passed: true, reasons: [] }] });
    const log: string[] = [];
    const state = emptyDaemonState(master);
    const result = await runCycle(master, state, effects({ snapshot: async () => ({ work: [mergeable], now: iso(0) }) }, log), () => clock);
    assert.deepEqual(log.filter(entry => entry.startsWith('merge')), []);
    assert.deepEqual(result.actions.filter(action => action.kind === 'merge' || action.kind === 'attention'), [], 'GY-1235: GitHub merges on its branch protection');
    assert.equal(result.metrics.cycle, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an unhealthy profile is routed around', async () => {
  const { directory, token } = await privateDirectory();
  const first = join(directory, 'first.token'), second = join(directory, 'second.token');
  await writeFile(first, workerToken, { mode: 0o600 }); await writeFile(second, workerToken, { mode: 0o600 });
  try {
    const profiles = [profile('broken', first), profile('spare', second), profile('observed', second, { mode: 'existing' })];
    const master = config(token, { workers: profiles });
    const state = emptyDaemonState(master);
    const health = profileHealth(profiles, { broken: { available: false, reason: 'Worker credential file is unreadable' }, spare: { available: true, reason: null }, observed: { available: true, reason: null } },
      [], state, clock);
    assert.deepEqual(health.map(entry => entry.healthy), [false, true, false]);
    assert.match(health[0].reason!, /credential file is unreadable/);
    assert.match(health[2].reason!, /unsupervised process/);

    const log: string[] = [];
    const ready = work({ id: 'ready-1', key: 'GY-60' });
    const result = await runCycle(master, state, effects({
      snapshot: async () => ({ work: [ready], now: iso(0) }),
      credentials: async () => ({ broken: { available: false, reason: 'Worker credential file is unreadable' }, spare: { available: true, reason: null }, observed: { available: true, reason: null } }),
    }, log), () => clock);
    assert.deepEqual(log.filter(entry => entry.startsWith('dispatch')), ['dispatch:GY-60']);
    assert.equal(result.actions.find(action => action.kind === 'dispatch')!.principal, 'spare-principal', 'the loop routes around the unhealthy profile');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a failed launch puts its profile in cool-off so the next cycle uses another profile', async () => {
  const { directory, token } = await privateDirectory();
  const first = join(directory, 'first.token'), second = join(directory, 'second.token');
  await writeFile(first, workerToken, { mode: 0o600 }); await writeFile(second, workerToken, { mode: 0o600 });
  try {
    const master = config(token, { workers: [profile('flaky', first), profile('spare', second)] });
    const state = emptyDaemonState(master);
    const attempted: string[] = [];
    const items = [work({ id: 'one', key: 'GY-61' })];
    const deps = effects({
      snapshot: async () => ({ work: items, now: iso(0) }),
      dispatch: async (item, chosen) => { attempted.push(chosen.name); if (chosen.name === 'flaky') throw new Error('Herdr refused the operation: no capacity'); },
    });
    await runCycle(master, state, deps, () => clock);
    assert.deepEqual(attempted, ['flaky']);
    assert.equal(state.profiles.flaky.failures, 1);
    assert.match(state.profiles.flaky.reason!, /no capacity/);
    await runCycle(master, state, deps, () => clock + 20_000);
    assert.deepEqual(attempted, ['flaky', 'spare'], 'the cooled-off profile is skipped and the work still goes out');
    assert.equal(state.actions[dispatchKey(items[0])].state, 'done');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the cursor stays bounded without discarding an unresolved action, and status reports the loop', () => {
  const { directory: _ } = { directory: '' };
  const state = emptyDaemonState(masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project' }));
  for (let index = 0; index < retainedActions + 50; index++) state.actions[`done:${index}`] = { kind: 'review', work: `GY-${index}`, principal: null, epoch: null, state: 'done', detail: 'recorded', attempts: 1, cycle: index, at: iso(index) };
  state.actions.stuck = { kind: 'proof', work: 'GY-9', principal: null, epoch: null, state: 'indeterminate', detail: 'interrupted', attempts: 1, cycle: 0, at: iso(-hour) };
  for (let index = 0; index < 150; index++) state.metrics.push({ cycle: index, at: iso(index), durationMs: 1, open: 1, actions: 0 });
  pruneDaemonState(state);
  assert.equal(Object.keys(state.actions).length, retainedActions + 1);
  assert.ok(state.actions.stuck, 'an unresolved action is never pruned away');
  assert.equal(state.metrics.length, 100);

  state.lock = { id: 'lock', pid: 10, host: 'machine-a', startedAt: iso(0), heartbeatAt: iso(0) };
  state.lastCycleAt = iso(0);
  const live = daemonSummary(state, clock + 20_000, 20_000);
  assert.equal(live.running, true);
  assert.equal(live.actions.length, 40);
  assert.equal(daemonSummary(state, clock + hour, 20_000).running, false, 'a loop that stopped cycling is not reported as running');
});

test('runDaemon holds the lock while cycling, releases it on exit, and stops on a signal', async () => {
  const { directory, token } = await privateDirectory();
  try {
    const master = config(token);
    const state = emptyDaemonState(master);
    const locks: (DaemonState['lock'])[] = [];
    const deps = effects({ persist: async value => { locks.push(value.lock); } });
    const once = await runDaemon(master, state, deps, { once: true, intervalMs: 20_000, identity: { pid: process.pid, host: 'machine-a' }, signals: [], log: () => {} });
    assert.equal(once.cycles.length, 1);
    assert.equal(state.lock, null, 'the lock is released so a supervisor restart is never blocked by its own predecessor');
    assert.ok(locks.some(lock => lock?.pid === process.pid), 'the lock was persisted before the first cycle ran');

    const cycles: number[] = [];
    const continuous = effects({ snapshot: async () => { cycles.push(cycles.length); if (cycles.length >= 2) process.emit('SIGUSR2' as NodeJS.Signals); return { work: [], now: iso(0) }; } });
    const stopped = await runDaemon(master, emptyDaemonState(master), continuous, { intervalMs: 5, identity: { pid: process.pid, host: 'machine-a' }, signals: ['SIGUSR2'], log: () => {} });
    assert.ok(stopped.stopped);
    assert.ok(stopped.cycles.length >= 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('candidate-scoped cursor keys change with the commit, the base, and the policy', () => {
  const candidate = submitted();
  const base = candidateKey('review', candidate);
  assert.notEqual(base, candidateKey('proof', candidate));
  assert.notEqual(base, candidateKey('review', { ...candidate, policyRevision: 2 }));
  assert.notEqual(base, candidateKey('review', { ...candidate, candidate: { ...candidate.candidate!, sha: 'f'.repeat(40) } }));
  assert.notEqual(base, candidateKey('review', { ...candidate, candidate: { ...candidate.candidate!, baseSha: 'f'.repeat(40) } }));
  assert.equal(dispatchKey(work({ epoch: 1 })) === dispatchKey(work({ epoch: 2 })), false, 'a new attempt is a new dispatch');
});

test('record() bounds an over-long action detail instead of failing the cycle', async () => {
  const { directory, token } = await privateDirectory();
  const worker = join(directory, 'worker.token');
  await writeFile(worker, workerToken, { mode: 0o600 });
  try {
    const master = config(token, { workers: [profile('verbose', worker)] });
    const state = emptyDaemonState(master);
    const item = work({ id: 'long', key: 'GY-179' });
    const error = `Herdr refused the operation: ${'x'.repeat(actionDetailMax * 2)}`;
    const result = await runCycle(master, state, effects({
      snapshot: async () => ({ work: [item], now: iso(0) }),
      dispatch: async () => { throw new Error(error); },
    }), () => clock);
    const dispatch = state.actions[dispatchKey(item)];
    assert.equal(dispatch.state, 'failed');
    assert.ok(`Dispatch of GY-179 to verbose failed: ${error}`.length > actionDetailMax, 'the unbounded detail exceeds the bound');
    assert.ok(dispatch.detail.length <= actionDetailMax, 'the stored detail is cut to within the bound');
    assert.ok(dispatch.detail.endsWith('…'), 'the cut detail ends in an ellipsis');
    assert.match(dispatch.detail, /^Dispatch of GY-179 to verbose failed: Herdr refused the operation: x+…$/);
    assert.ok(result.actions.some(action => action === dispatch), 'the bounded action is reported by the cycle');
    assert.equal(result.metrics.cycle, 0, 'the cycle completes and measures instead of failing');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:state-bounded-at-persist — no value over a schema bound can fail the cursor write or the cycle', async () => {
  const { directory, token } = await privateDirectory();
  const credential = join(directory, 'worker.token');
  await writeFile(credential, workerToken, { mode: 0o600 });
  try {
    const master = config(token, { workers: [profile('codex', credential)], run: { proofWorkflow: 'acceptance.yml' } });
    const ready = work({ id: 'ready', key: 'GY-7' });
    const mergeable = submitted({ id: 'mergeable', key: 'GY-8', stage: 'merge', gates: [{ name: 'merge', passed: true, reasons: [] }] });
    // A proof list long enough that the silence subject quoting it runs past its 500-character bound.
    const proving = submitted({ id: 'proving', key: 'GY-9', stage: 'acceptance', criteria: [{ id: 'AC-1', text: 'Proven', proofs: Array.from({ length: 30 }, (_, index) => `unit:${'p'.repeat(90)}-${index}`) }],
      gates: [{ name: 'acceptance', passed: false, reasons: ['needs evidence'] }] });
    const written: DaemonState[] = [];
    // Every write is judged by the schema exactly as the cursor file is.
    const persist = async (next: DaemonState) => { written.push(daemonStateSchema.parse(JSON.parse(JSON.stringify(next)))); };
    const deps = effects({ snapshot: async () => ({ work: [ready, mergeable, proving], now: iso(0) }), persist });
    const state = emptyDaemonState(master);
    // An attempt counter one short of its bound, due for a retry: the retry is attempt 1001.
    state.cycle = 40;
    state.actions[dispatchKey(ready)] = { kind: 'dispatch', work: ready.key, principal: 'codex-principal', epoch: 0, state: 'failed', detail: 'Dispatch failed', attempts: 1000, cycle: 0, at: iso(-hour) };
    const result = await runCycle(master, state, deps, () => clock);
    assert.equal(result.metrics.cycle, 40, 'the cycle completes and measures');
    assert.equal(state.cycle, 41);
    assert.equal(state.actions[dispatchKey(ready)].state, 'done', 'the retry that is attempt 1001 runs and is recorded');
    assert.equal(state.actions[dispatchKey(ready)].attempts, 1000, 'attempts are clamped to the bound, not reset');
    // A cursor that already holds over-long values — written by an older loop, or edited — is written within bounds.
    state.actions['legacy'] = { kind: 'merge', work: 'GY-8', principal: null, epoch: null, state: 'failed', detail: 'x'.repeat(5000), attempts: 5000, cycle: 0, at: iso(0) };
    state.profiles.codex = { failures: 1, reason: 'y'.repeat(3000), cooldownUntil: null };
    await writeDaemonState(master, state);
    const stored = JSON.parse(await readFile(daemonStatePath(master), 'utf8')) as DaemonState;
    assert.equal(stored.actions.legacy.attempts, 1000);
    assert.ok(stored.actions.legacy.detail.length <= actionDetailMax && stored.profiles.codex.reason!.length <= 500);
    assert.ok(written.length > 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:fast-failure-backoff — a transient read failure costs seconds, not the idle interval', async () => {
  const { directory, token } = await privateDirectory();
  try {
    // Backoff starts from min(interval, the 30 s actionable interval) and doubles to the ceiling.
    const interval = 300_000;
    assert.equal(cycleFailureStart(interval), 30_000);
    const master = config(token);
    const state = emptyDaemonState(master);
    const delays: number[] = [];
    for (let failure = 0; failure < 5; failure++) delays.push((await noteCycleFailure(state, new Error('The operation was aborted due to timeout'), 'cycle', { now: clock, intervalMs: interval, persist: async () => {} })).delayMs);
    assert.ok(delays[0] <= 30_000, `the first failure waits at most 30 s (waited ${delays[0]}ms)`);
    assert.ok(delays[2] <= 120_000, `the third failure waits at most 120 s (waited ${delays[2]}ms)`);
    assert.deepEqual(delays, [30_000, 60_000, 120_000, 240_000, 300_000], 'doubling to the five-minute ceiling');
    assert.equal(cycleFailureDelay(10, cycleFailureStart(interval)), 300_000);
    assert.equal(cycleFailureStart(5_000), 5_000, 'an interval shorter than the actionable one is its own start');
    // The retry pause is a jittered second or so.
    assert.deepEqual([snapshotRetryDelayMs(() => 0), snapshotRetryDelayMs(() => 1)], [500, 1500]);
    // A snapshot GET that fails once and then answers is retried inside the cycle: not a failed cycle.
    let reads = 0;
    const flaky = async () => { reads += 1; if (reads === 1) throw new Error('The operation was aborted due to timeout'); return { work: [], now: iso(0) }; };
    const fresh = emptyDaemonState(master);
    const once = { once: true, intervalMs: interval, identity: { pid: process.pid, host: 'machine-a' }, signals: ['SIGUSR2' as NodeJS.Signals], now: () => clock, log: () => {} };
    const recovered = await runDaemon(master, fresh, effects({ snapshot: retriedSnapshot(flaky, () => 1) }), once);
    assert.equal(reads, 2, 'the read was tried again');
    assert.deepEqual(recovered.failed, [], 'one transient read failure is not a failed cycle');
    assert.equal(recovered.cycles.length, 1);
    assert.equal(fresh.failures.total, 0);
    // Two failures in a row fail the cycle, and that failure waits seconds, not the 300 s interval.
    let down = 0;
    const failing = emptyDaemonState(master);
    const outage = await runDaemon(master, failing, effects({ snapshot: retriedSnapshot(async () => { down += 1; throw new Error('connect ECONNREFUSED'); }, () => 1) }), once);
    assert.equal(down, 2, 'a read is retried once, not more');
    assert.equal(outage.failed.length, 1);
    assert.equal(outage.failed[0].delayMs, 30_000);
    assert.equal(failing.failures.last?.call, 'snapshot');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
