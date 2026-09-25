import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireDaemonLock, actionDetailMax, candidateKey, cycleFailureDelay, cycleFailureStart, daemonStatePath, daemonStateSchema, daemonSummary, dispatchKey, emptyDaemonState, missingProofs, noteCycleFailure, observeDeployment, percentiles, profileHealth, pruneDaemonState, readDaemonState, reconcilePendingActions, retainedActions, retriedSnapshot, runCycle, runDaemon, snapshotRetryDelayMs, stageMetrics, writeDaemonState, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig, type MasterRun, type WorkerProfile } from '../src/master.js';
import type { Work } from '../src/model.js';

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const workerToken = 'worker-token-'.padEnd(40, 'x');

async function privateDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-daemon-'));
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
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'ready', revision: 3, policyRevision: 1,
    createdAt: iso(-4 * hour), updatedAt: iso(0), stageEnteredAt: iso(-2 * hour), ready: true, epoch: 0,
    lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null,
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
    requestProof: item => { log.push(`proof:${item.key}`); },
    merge: async item => { log.push(`merge:${item.key}`); return { result: 'merge requested' }; },
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async (item, observation) => { log.push(`record:${item.key}:${observation.sha.slice(0, 4)}`); },
    requestSmoke: item => { log.push(`smoke:${item.key}`); },
    persist: async () => {},
    ...overrides,
  };
}

test('the daemon cursor lives beside the coordinator credential, stays private, and refuses another repository', async () => {
  const { directory, token } = await privateDirectory();
  try {
    const master = config(token);
    assert.equal(daemonStatePath(master), join(directory, 'coordinator.daemon.json'));
    const root = await mkdtemp(join(tmpdir(), 'graphyard-daemon-root-'));
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

test('restarting the loop resumes the cursor without dispatching or requesting a review twice', async () => {
  const { directory, token } = await privateDirectory();
  const workerCredential = join(directory, 'worker.token');
  await writeFile(workerCredential, workerToken, { mode: 0o600 });
  const root = await mkdtemp(join(tmpdir(), 'graphyard-daemon-root-'));
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
    assert.equal(calls.filter(call => call.startsWith('review')).length, 0);
    const reviewActions = Object.values(state.actions).filter(action => action.kind === 'review');
    assert.equal(reviewActions.length, 1);

    // Simulate a kill: keep only what reached disk, then restart from it.
    state = JSON.parse(JSON.stringify(persisted.at(-1)));
    await runCycle(master, state, recording, () => clock + 30_000);
    await runCycle(master, state, recording, () => clock + 60_000);
    assert.deepEqual(calls.filter(call => call.startsWith('dispatch')), ['dispatch:GY-42'], 'a restart must not dispatch the same attempt twice');
    assert.equal(Object.values(state.actions).filter(action => action.kind === 'review').length, 1, 'a restart must not request a second review for the same candidate');
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

test('one cycle closes finished sessions, dispatches, requests proof, merges only through the guard, and measures', async () => {
  const { directory, token } = await privateDirectory();
  const workerCredential = join(directory, 'worker.token');
  await writeFile(workerCredential, workerToken, { mode: 0o600 });
  try {
    const master = config(token, { workers: [profile('codex', workerCredential)], run: { intervalSeconds: 20, proofWorkflow: 'acceptance.yml', deploymentShaField: 'commit' } });
    const finished = work({ id: 'finished', key: 'GY-10', stage: 'done', delivery: { mergedAt: iso(-hour), mergeSha: 'c'.repeat(40), authorizationRevision: 5 } });
    const ready = work();
    const acceptance = submitted({ id: 'acceptance', key: 'GY-44', stage: 'acceptance',
      criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['integration:loop', 'manual:witness'] }],
      gates: [{ name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }, { name: 'acceptance', passed: false, reasons: ['needs evidence'] }] });
    const log: string[] = []; let closed = false;
    const proven = { id: 'e1', proof: 'integration:loop', sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 1, producer: 'ci', trusted: true, result: 'pass' as const, executed: 4, skipped: 0, at: iso(0) };
    const mergeable = submitted({ id: 'mergeable', key: 'GY-45', stage: 'merge', evidence: [proven], gates: [{ name: 'merge', passed: true, reasons: [] }] });
    const deps = effects({
      agents: () => closed ? [] : [{ name: 'agent-codex', pane_id: 'pane-1', agent_status: 'done' }],
      closeSession: pane => { closed = true; log.push(`close:${pane}`); },
      snapshot: async () => ({ work: [finished, ready, acceptance, mergeable], now: iso(0) }),
      observeDeployment: async delivered => ({ source: 'endpoint', sha: 'c'.repeat(40), at: iso(0), reason: null, deployed: delivered.map(item => item.key), pending: [] }),
    }, log);
    const state = emptyDaemonState(master);
    const result = await runCycle(master, state, deps, () => clock);
    assert.deepEqual(log, ['close:pane-1', 'dispatch:GY-42', 'proof:GY-44', 'merge:GY-45']);
    const kinds = result.actions.map(action => `${action.kind}:${action.state}`);
    for (const expected of ['close:done', 'dispatch:done', 'review:done', 'proof:done', 'escalation:done', 'merge:done', 'deployment:done']) assert.ok(kinds.includes(expected), `cycle should record ${expected}, recorded ${kinds.join(', ')}`);
    assert.ok(result.actions.some(action => action.kind === 'escalation' && /manual:witness/.test(action.detail)), 'an operator-witnessed proof must escalate, never be produced by the coordinator');
    assert.equal(result.deployment!.deployed.length, 1);
    // Every cycle measures, whether or not it acted.
    assert.equal(result.metrics.cycle, 0);
    assert.equal(result.metrics.open, 3);
    assert.equal(result.metrics.stages.ready.p50Ms, 2 * hour);
    assert.equal(result.metrics.lead.count, 1);
    assert.equal(result.metrics.lead.p90Ms, 3 * hour);
    assert.equal(state.metrics.length, 1);
    // A second cycle repeats no completed action.
    log.length = 0;
    await runCycle(master, state, deps, () => clock + 20_000);
    assert.deepEqual(log, [], 'completed actions must not repeat while the candidate is unchanged');
    assert.equal(state.cycle, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a disabled automatic merge keeps the loop cycling and never invokes the merge', async () => {
  const { directory, token } = await privateDirectory();
  try {
    const master = config(token, { autoMerge: false });
    const mergeable = submitted({ id: 'mergeable', key: 'GY-45', stage: 'merge', gates: [{ name: 'merge', passed: true, reasons: [] }] });
    const log: string[] = [];
    const state = emptyDaemonState(master);
    const result = await runCycle(master, state, effects({ snapshot: async () => ({ work: [mergeable], now: iso(0) }) }, log), () => clock);
    assert.deepEqual(log.filter(entry => entry.startsWith('merge')), []);
    assert.ok(result.actions.some(action => action.kind === 'escalation' && /explicit operator approval/.test(action.detail)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a refused merge is recorded as the gate working and does not stop the loop', async () => {
  const { directory, token } = await privateDirectory();
  try {
    const master = config(token);
    const mergeable = submitted({ id: 'mergeable', key: 'GY-45', stage: 'merge', gates: [{ name: 'merge', passed: true, reasons: [] }] });
    const state = emptyDaemonState(master);
    const result = await runCycle(master, state, effects({
      snapshot: async () => ({ work: [mergeable], now: iso(0) }),
      merge: async () => { throw new Error('GY-45 does not have a current all-gates-passing merge authorization'); },
    }), () => clock);
    const merge = result.actions.find(action => action.kind === 'merge')!;
    assert.equal(merge.state, 'failed');
    assert.match(merge.detail, /all-gates-passing merge authorization/);
    assert.equal(result.metrics.cycle, 0, 'the cycle still completes and measures after a refusal');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an unhealthy profile is routed around and an exhausted reviewer is escalated, never approved', async () => {
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
    const exhausted = submitted({
      policy: { checks: ['test'], review: true, reviewProvider: 'agent', reviewerProfiles: [{ name: 'claude-reviewer', runtime: 'claude', reviewerApp: 'claude-reviewer', timeoutSeconds: 1800 }] } as any,
      reviewFailovers: [{ profile: 'claude-reviewer', reviewerApp: 'claude-reviewer', runtime: 'claude', exhaustion: 'usage-limit', reason: 'quota', at: iso(0), sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 1, requestCommentId: 1, nextProfile: null }],
    });
    const ready = work({ id: 'ready-1', key: 'GY-60' });
    const result = await runCycle(master, state, effects({
      snapshot: async () => ({ work: [ready, exhausted], now: iso(0) }),
      credentials: async () => ({ broken: { available: false, reason: 'Worker credential file is unreadable' }, spare: { available: true, reason: null }, observed: { available: true, reason: null } }),
    }, log), () => clock);
    assert.deepEqual(log.filter(entry => entry.startsWith('dispatch')), ['dispatch:GY-60']);
    assert.equal(result.actions.find(action => action.kind === 'dispatch')!.principal, 'spare-principal', 'the loop routes around the unhealthy profile');
    const escalation = result.actions.find(action => action.kind === 'escalation' && /reviewer profile/.test(action.detail))!;
    assert.match(escalation.detail, /exhausted for the current candidate/);
    assert.match(escalation.detail, /never an approval/);
    assert.equal(result.actions.some(action => action.kind === 'merge'), false, 'an exhausted reviewer never becomes a merge');
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

test('the loop records the observed deployment, requests the trusted smoke proof, escalates a failed verdict with rollback guidance, and measures post-deploy time', async () => {
  const { directory, token } = await privateDirectory();
  try {
    const mergeSha = 'c'.repeat(40), serving = 'd'.repeat(40);
    const delivered = (overrides: Partial<Work['delivery']> = {}, extra: Partial<Work> = {}) => work({ id: 'smoky', key: 'GY-50', stage: 'done', createdAt: iso(-5 * hour),
      policy: { checks: ['test'], review: true, deploySmoke: true }, delivery: { mergedAt: iso(-2 * hour), mergeSha, authorizationRevision: 5, ...overrides }, ...extra });
    const plain = work({ id: 'plain', key: 'GY-51', stage: 'done', delivery: { mergedAt: iso(-hour), mergeSha: 'e'.repeat(40), authorizationRevision: 6 } });
    const pending = delivered({}, { id: 'pending', key: 'GY-52' });
    const log: string[] = [];
    let snapshot: Work[] = [delivered(), plain, pending];
    const deps = effects({
      snapshot: async () => ({ work: snapshot, now: iso(0) }),
      observeDeployment: async () => ({ source: 'endpoint', sha: serving, at: iso(-hour), reason: null, deployed: ['GY-50', 'GY-51'], pending: ['GY-52'] }),
    }, log);
    const unconfigured = config(token, { run: { intervalSeconds: 20, deploymentShaField: 'commit' } });
    const state = emptyDaemonState(unconfigured);
    // Cycle 1: the release serves GY-50, so its deployment is recorded on Graphyard. GY-51 asks for no
    // smoke proof and GY-52 is not yet served, so neither is touched.
    let result = await runCycle(unconfigured, state, deps, () => clock);
    assert.deepEqual(log, ['record:GY-50:dddd']);
    assert.ok(result.actions.some(action => action.kind === 'deployment' && action.work === 'GY-50' && action.state === 'done'));
    assert.equal(result.metrics.postDeploy.count, 2, 'both smoke-policy deliveries are still inside their post-deploy window');
    assert.equal(result.metrics.postDeployFailures, 0);
    // Cycle 2: Graphyard now holds the observation. Without a smoke workflow the loop can only say so.
    log.length = 0;
    const observation = { sha: serving, mergeSha, source: 'endpoint' as const, observedAt: iso(-hour), covers: 'descendant' as const, at: iso(-hour), observer: 'master' };
    snapshot = [delivered({ deployment: observation }), plain, pending];
    result = await runCycle(unconfigured, state, deps, () => clock + 20_000);
    assert.deepEqual(log, [], 'the loop never re-records a deployment Graphyard already holds');
    const unconfiguredSmoke = result.actions.find(action => action.kind === 'smoke')!;
    assert.equal(unconfiguredSmoke.state, 'failed'); assert.match(unconfiguredSmoke.detail, /--smoke-workflow/);
    assert.equal(result.metrics.production.count, 1, 'PR-to-production latency is measured from the recorded observation');
    assert.equal(result.metrics.production.p50Ms, 4 * hour);
    // With the workflow configured the request names the exact deployed and merge commits, once.
    const configured = config(token, { run: { intervalSeconds: 20, deploymentShaField: 'commit', smokeWorkflow: 'deploy-smoke.yml' } });
    delete state.actions[`smoke:smoky:${serving}`];
    result = await runCycle(configured, state, deps, () => clock + 40_000);
    assert.deepEqual(log, ['smoke:GY-50']);
    assert.match(result.actions.find(action => action.kind === 'smoke')!.detail, /deploy-smoke\.yml for GY-50 against deployed dddddddddddd \(merge cccccccccccc\)/);
    log.length = 0;
    await runCycle(configured, state, deps, () => clock + 60_000);
    assert.deepEqual(log, [], 'one smoke request per deployed commit');
    // Cycle 3: the trusted producer reported a failure. The loop escalates with rollback guidance and
    // the failure shows up in the flow analytics; it never requests the proof again or clears it.
    const smoke = { evidenceId: 'ev-1', result: 'fail' as const, sha: serving, mergeSha, producer: 'smoke-runner', at: iso(-30 * 60_000), executed: 3, skipped: 0 };
    snapshot = [delivered({ deployment: observation, smoke }), plain, pending];
    result = await runCycle(configured, state, deps, () => clock + 80_000);
    assert.deepEqual(log, []);
    const escalation = result.actions.find(action => action.kind === 'escalation' && action.work === 'GY-50')!;
    assert.match(escalation.detail, /delivered with a failed post-deployment smoke proof/);
    assert.ok(escalation.detail.includes(serving) && escalation.detail.includes(mergeSha) && /revert .* on main/.test(escalation.detail));
    assert.equal(result.metrics.postDeployFailures, 1);
    assert.equal(result.metrics.postDeploy.p50Ms, 90 * 60_000, 'post-deploy time runs from merge to the verdict');
    const again = await runCycle(configured, state, deps, () => clock + 100_000);
    assert.equal(again.actions.filter(action => action.kind === 'escalation').length, 0, 'an escalation is recorded once per verdict');
    // A record interrupted mid-flight is resolved against Graphyard, not the cursor.
    state.actions['deployment:record:smoky:x'] = { kind: 'deployment', work: 'GY-50', principal: null, epoch: null, state: 'started', detail: 'Recording', attempts: 1, cycle: 0, at: iso(0) };
    state.actions['deployment:record:pending:x'] = { kind: 'deployment', work: 'GY-52', principal: null, epoch: null, state: 'started', detail: 'Recording', attempts: 1, cycle: 0, at: iso(0) };
    const resumed = reconcilePendingActions(state, snapshot, clock);
    assert.deepEqual(resumed.map(action => `${action.work}:${action.state}`), ['GY-50:done', 'GY-52:failed']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('deployment verification reports the served commit and which delivered items it covers', async () => {
  const { directory, token } = await privateDirectory();
  try {
    // Containment is git ancestry over the coordinator's own checkout, so the fixture is a real
    // history: an earlier merge the release descends from, the release itself, and a merge on a
    // branch the release does not contain.
    const origin = join(directory, 'origin'), checkout = join(directory, 'checkout');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    execFileSync('git', ['init', '-q', '-b', 'main', origin]);
    git(origin, 'config', 'user.email', 'loop@graphyard.example');
    git(origin, 'config', 'user.name', 'Graphyard');
    git(origin, 'commit', '--allow-empty', '-q', '-m', 'GY-1: earlier');
    const earlier = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'commit', '--allow-empty', '-q', '-m', 'GY-2: release');
    const head = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'checkout', '-q', '-b', 'unrelated');
    git(origin, 'commit', '--allow-empty', '-q', '-m', 'GY-3: not on main');
    const unrelated = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'checkout', '-q', 'main');
    execFileSync('git', ['clone', '-q', origin, checkout]);
    const delivered = [
      work({ id: 'a', key: 'GY-1', stage: 'done', delivery: { mergedAt: iso(-hour), mergeSha: earlier, authorizationRevision: 1 } }),
      work({ id: 'b', key: 'GY-2', stage: 'done', delivery: { mergedAt: iso(-hour), mergeSha: head, authorizationRevision: 2 } }),
      work({ id: 'c', key: 'GY-3', stage: 'done', delivery: { mergedAt: iso(0), mergeSha: unrelated, authorizationRevision: 3 } }),
    ];
    const calls: string[] = [];
    const run = (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'git') return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (args[1] === 'graphql') { assert.match(args[3], /nodes\(ids: \["DE_9"\]\)/); return JSON.stringify({ data: { nodes: [{ databaseId: 9, latestStatus: { state: 'SUCCESS' } }] } }); }
      if (args[1].includes('/deployments?')) return JSON.stringify([{ id: 9, node_id: 'DE_9', sha: head, ref: 'main', environment: 'production' }]);
      throw new Error(`unexpected ${args.join(' ')}`);
    };
    const fromProvider = await observeDeployment(config(token), delivered, run, fetch, () => clock, { root: checkout });
    assert.equal(fromProvider.source, 'github-deployment');
    assert.equal(fromProvider.sha, head);
    assert.deepEqual(fromProvider.deployed, ['GY-1', 'GY-2']);
    assert.deepEqual(fromProvider.pending, ['GY-3'], 'a merge the running release does not contain is not deployed');
    assert.equal(calls.filter(entry => entry.includes('/compare/')).length, 0, 'containment is local ancestry, never a compare per delivery');
    assert.equal(fromProvider.requests, 2);
    assert.deepEqual(fromProvider.containment, { release: head, settled: { 'GY-1': head, 'GY-2': head } }, 'what the release was shown to serve is retained for the next cycle');

    const endpoint = config(token, { run: { intervalSeconds: 20, deploymentUrl: 'https://app.example/version', deploymentShaField: 'build.commit' } });
    const fetcher = (async () => new Response(JSON.stringify({ build: { commit: head.toUpperCase() } }))) as typeof fetch;
    const fromEndpoint = await observeDeployment(endpoint, delivered, run, fetcher, () => clock, { root: checkout });
    assert.equal(fromEndpoint.source, 'endpoint');
    assert.equal(fromEndpoint.sha, head);
    assert.equal(fromEndpoint.requests, 0);

    const silent = (async () => new Response(JSON.stringify({ ok: true }))) as typeof fetch;
    const missing = await observeDeployment(endpoint, delivered, run, silent, () => clock, { root: checkout });
    assert.equal(missing.source, 'unavailable');
    assert.match(missing.reason!, /did not report a commit at build\.commit/);
    assert.deepEqual(missing.pending, ['GY-1', 'GY-2', 'GY-3'], 'an unverifiable deployment leaves every delivery pending, never assumed live');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('stage percentiles and outstanding proofs are computed from the snapshot the cycle acted on', () => {
  assert.deepEqual(percentiles([]), { count: 0, p50Ms: 0, p90Ms: 0 });
  assert.deepEqual(percentiles([10, 20, 30, 40, 100]), { count: 5, p50Ms: 30, p90Ms: 100 });
  const metrics = stageMetrics([
    work({ id: '1', stage: 'ready', stageEnteredAt: iso(-hour) }),
    work({ id: '2', stage: 'ready', stageEnteredAt: iso(-3 * hour) }),
    work({ id: '3', stage: 'review', stageEnteredAt: iso(-2 * hour) }),
    work({ id: '4', stage: 'done', delivery: { mergedAt: iso(-hour), mergeSha: 'c'.repeat(40), authorizationRevision: 1 }, createdAt: iso(-5 * hour) }),
  ], clock);
  assert.equal(metrics.stages.ready.count, 2);
  assert.equal(metrics.stages.ready.p50Ms, hour);
  assert.equal(metrics.stages.ready.p90Ms, 3 * hour);
  assert.equal(metrics.stages.done, undefined, 'delivered work has no stage dwell');
  assert.equal(metrics.lead.p50Ms, 4 * hour);

  const candidate = submitted({ criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['integration:loop', 'manual:witness'] }] });
  assert.deepEqual(missingProofs(candidate, new Date(clock)), ['integration:loop', 'manual:witness']);
  const evidence = { id: 'e1', proof: 'integration:loop', sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 1, producer: 'ci', trusted: true, result: 'pass' as const, executed: 4, skipped: 0, at: iso(0) };
  assert.deepEqual(missingProofs({ ...candidate, evidence: [evidence] }, new Date(clock)), ['manual:witness']);
  assert.deepEqual(missingProofs({ ...candidate, evidence: [{ ...evidence, skipped: 1 }] }, new Date(clock)), ['integration:loop', 'manual:witness'], 'a skipped run is not proof');
  assert.deepEqual(missingProofs({ ...candidate, evidence: [{ ...evidence, trusted: false }] }, new Date(clock)), ['integration:loop', 'manual:witness'], 'untrusted evidence is not proof');
});

test('the cursor stays bounded without discarding an unresolved action, and status reports the loop', () => {
  const { directory: _ } = { directory: '' };
  const state = emptyDaemonState(masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project' }));
  for (let index = 0; index < retainedActions + 50; index++) state.actions[`done:${index}`] = { kind: 'review', work: `GY-${index}`, principal: null, epoch: null, state: 'done', detail: 'recorded', attempts: 1, cycle: index, at: iso(index) };
  state.actions.stuck = { kind: 'proof', work: 'GY-9', principal: null, epoch: null, state: 'indeterminate', detail: 'interrupted', attempts: 1, cycle: 0, at: iso(-hour) };
  for (let index = 0; index < 150; index++) state.metrics.push({ cycle: index, at: iso(index), durationMs: 1, open: 1, actions: 0, stages: {}, lead: { count: 0, p50Ms: 0, p90Ms: 0 }, production: { count: 0, p50Ms: 0, p90Ms: 0 }, postDeploy: { count: 0, p50Ms: 0, p90Ms: 0 }, postDeployFailures: 0 });
  pruneDaemonState(state);
  assert.equal(Object.keys(state.actions).length, retainedActions + 1);
  assert.ok(state.actions.stuck, 'an unresolved action is never pruned away');
  assert.equal(state.metrics.length, 100);

  state.lock = { id: 'lock', pid: 10, host: 'machine-a', startedAt: iso(0), heartbeatAt: iso(0) };
  state.lastCycleAt = iso(0);
  const live = daemonSummary(state, clock + 20_000, 20_000);
  assert.equal(live.running, true);
  assert.equal(live.unresolved.length, 1);
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

test('a busy fleet is capacity, not an escalation; a fleet that cannot take work is escalated once', async () => {
  const { directory, token } = await privateDirectory();
  const credential = join(directory, 'worker.token');
  await writeFile(credential, workerToken, { mode: 0o600 });
  try {
    const master = config(token, { workers: [profile('codex', credential)] });
    const ready = work({ id: 'ready-1', key: 'GY-80' });
    const busy = effects({ agents: () => [{ name: 'agent-codex', pane_id: 'pane-1', agent_status: 'working' }], snapshot: async () => ({ work: [ready], now: iso(0) }) });
    const working = await runCycle(master, emptyDaemonState(master), busy, () => clock);
    assert.equal(working.actions.some(action => action.kind === 'escalation'), false, 'every worker working is normal capacity');
    assert.equal(working.health[0].busy, true);

    const broken = effects({ snapshot: async () => ({ work: [ready], now: iso(0) }), credentials: async () => ({ codex: { available: false, reason: 'Worker credential file is unreadable' } }) });
    const state = emptyDaemonState(master);
    const first = await runCycle(master, state, broken, () => clock);
    assert.match(first.actions.find(action => action.kind === 'escalation')!.detail, /No worker profile can take GY-80.*unreadable/);
    const second = await runCycle(master, state, broken, () => clock + 20_000);
    assert.equal(second.actions.some(action => action.kind === 'escalation'), false, 'an unchanged escalation is stated once, not every cycle');
  } finally { await rm(directory, { recursive: true, force: true }); }
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

test('a stable detail over the bound is recorded once, not re-recorded every cycle', async () => {
  const { directory, token } = await privateDirectory();
  const credential = join(directory, 'worker.token');
  await writeFile(credential, workerToken, { mode: 0o600 });
  try {
    const master = config(token, { workers: [profile('codex', credential)] });
    const ready = work({ id: 'ready-long', key: 'GY-179' });
    const reason = `Worker credential file is unreadable: ${'y'.repeat(actionDetailMax * 2)}`;
    const broken = effects({ snapshot: async () => ({ work: [ready], now: iso(0) }), credentials: async () => ({ codex: { available: false, reason } }) });
    const state = emptyDaemonState(master);
    const key = 'escalation:dispatch:ready-long';
    const first = await runCycle(master, state, broken, () => clock);
    const escalation = state.actions[key];
    assert.ok(escalation, 'the escalation is recorded');
    assert.ok(escalation.detail.length <= actionDetailMax && escalation.detail.endsWith('…'), 'the stored detail is the bounded form');
    assert.ok(first.actions.includes(escalation), 'the first cycle performed the escalation');
    assert.equal(escalation.attempts, 1);
    for (let cycle = 1; cycle <= 4; cycle++) {
      const again = await runCycle(master, state, broken, () => clock + cycle * 20_000);
      assert.equal(again.actions.some(action => action.kind === 'escalation'), false, `cycle ${cycle} does not report the unchanged escalation again`);
      assert.equal(state.actions[key], escalation, `cycle ${cycle} does not rewrite the stored action`);
      assert.equal(state.actions[key].attempts, 1, `cycle ${cycle} leaves the attempts count unchanged`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a persistently refused merge backs off instead of calling the provider every cycle', async () => {
  const { directory, token } = await privateDirectory();
  try {
    const master = config(token);
    const mergeable = submitted({ id: 'mergeable', key: 'GY-81', stage: 'merge', gates: [{ name: 'merge', passed: true, reasons: [] }] });
    let attempts = 0;
    const deps = effects({ snapshot: async () => ({ work: [mergeable], now: iso(0) }), merge: async () => { attempts++; throw new Error('base branch advanced outside the merge queue'); } });
    const state = emptyDaemonState(master);
    for (let cycle = 0; cycle < 8; cycle++) await runCycle(master, state, deps, () => clock + cycle * 20_000);
    assert.deepEqual([attempts < 8, attempts >= 3], [true, true], `a refusal should retry on a widening interval, not 8 times (saw ${attempts})`);
    // A new commit is a new candidate and retries immediately.
    const fresh = { ...mergeable, candidate: { ...mergeable.candidate!, sha: 'f'.repeat(40) } } as Work;
    await runCycle(master, state, effects({ snapshot: async () => ({ work: [fresh], now: iso(0) }), merge: async () => { attempts++; return { result: 'merge requested' }; } }), () => clock + 8 * 20_000);
    assert.equal(state.actions[candidateKey('merge', fresh)].state, 'done');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:state-bounded-at-persist — no value over a schema bound can fail the cursor write or the cycle', async () => {
  const { directory, token } = await privateDirectory();
  const credential = join(directory, 'worker.token');
  await writeFile(credential, workerToken, { mode: 0o600 });
  try {
    const master = config(token, { workers: [profile('codex', credential)], run: { proofWorkflow: 'acceptance.yml' } });
    // 250 deliveries against the 200-entry bound on `pending`, the case that stopped the fleet.
    const delivered = Array.from({ length: 250 }, (_, index) => work({ id: `delivered-${index}`, key: `GY-${1000 + index}`, stage: 'done',
      delivery: { mergedAt: iso(-hour + index), mergeSha: index.toString(16).padStart(40, 'c'), authorizationRevision: 5 } } as Partial<Work>));
    const ready = work({ id: 'ready', key: 'GY-7' });
    const refusal = `base branch advanced outside the merge queue: ${'r'.repeat(3000)}`;
    const mergeable = submitted({ id: 'mergeable', key: 'GY-8', stage: 'merge', gates: [{ name: 'merge', passed: true, reasons: [] }] });
    // A proof list long enough that the silence subject quoting it runs past its 500-character bound.
    const proving = submitted({ id: 'proving', key: 'GY-9', stage: 'acceptance', criteria: [{ id: 'AC-1', text: 'Proven', proofs: Array.from({ length: 30 }, (_, index) => `unit:${'p'.repeat(90)}-${index}`) }],
      gates: [{ name: 'acceptance', passed: false, reasons: ['needs evidence'] }] });
    const reason = `The deployment endpoint answered ${'d'.repeat(2000)}`;
    let observe: () => Promise<any> = async () => ({ source: 'unavailable', sha: null, at: iso(0), reason, deployed: [], pending: delivered.map(item => item.key) });
    const written: DaemonState[] = [];
    // Every write is judged by the schema exactly as the cursor file is.
    const persist = async (next: DaemonState) => { written.push(daemonStateSchema.parse(JSON.parse(JSON.stringify(next)))); };
    const deps = effects({ snapshot: async () => ({ work: [...delivered, ready, mergeable, proving], now: iso(0) }), persist,
      merge: async () => { throw new Error(refusal); }, observeDeployment: async () => observe() });
    const state = emptyDaemonState(master);
    // An attempt counter one short of its bound, due for a retry: the retry is attempt 1001.
    state.cycle = 40;
    state.actions[dispatchKey(ready)] = { kind: 'dispatch', work: ready.key, principal: 'codex-principal', epoch: 0, state: 'failed', detail: 'Dispatch failed', attempts: 1000, cycle: 0, at: iso(-hour) };
    const result = await runCycle(master, state, deps, () => clock);
    assert.equal(result.metrics.cycle, 40, 'the cycle completes and measures');
    assert.equal(state.cycle, 41);
    assert.equal(state.actions[dispatchKey(ready)].state, 'done', 'the retry that is attempt 1001 runs and is recorded');
    assert.equal(state.actions[dispatchKey(ready)].attempts, 1000, 'attempts are clamped to the bound, not reset');
    assert.equal(state.deployment!.pending.length, 200, 'the newest 200 deliveries are kept');
    assert.equal(state.deployment!.pending.at(-1), 'GY-1249');
    assert.ok(state.deployment!.reason!.length <= 500 && state.deployment!.reason!.endsWith('…'));
    assert.ok(state.actions[candidateKey('merge', mergeable)].detail.length <= actionDetailMax, 'the 3,000-character refusal is recorded within the bound');
    assert.equal(state.actions[candidateKey('merge', mergeable)].state, 'failed');
    assert.ok(Object.values(state.silence.subjects).every(subject => subject.detail.length <= 500), 'every silence subject fits its bound');
    assert.ok(Object.values(state.silence.subjects).some(subject => subject.kind === 'proof' && subject.detail.endsWith('…')));
    // The failed observation keeps every delivery pending: the catch path is bounded too.
    observe = async () => { throw new Error(reason); };
    const again = await runCycle(master, state, deps, () => clock + 20_000);
    assert.equal(again.metrics.cycle, 41);
    assert.equal(state.deployment!.pending.length, 200);
    assert.ok(state.deployment!.reason!.length <= 500);
    // A cursor that already holds over-long values — written by an older loop, or edited — is written within bounds.
    state.actions['legacy'] = { kind: 'merge', work: 'GY-8', principal: null, epoch: null, state: 'failed', detail: 'x'.repeat(5000), attempts: 5000, cycle: 0, at: iso(0) };
    state.profiles.codex = { failures: 1, reason: 'y'.repeat(3000), cooldownUntil: null };
    await writeDaemonState(master, state);
    const stored = JSON.parse(await readFile(daemonStatePath(master), 'utf8')) as DaemonState;
    assert.equal(stored.actions.legacy.attempts, 1000);
    assert.ok(stored.actions.legacy.detail.length <= actionDetailMax && stored.profiles.codex.reason!.length <= 500);
    assert.ok(written.length > 0 && written.every(entry => entry.deployment === null || entry.deployment.pending.length <= 200));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:item-failure-isolated — one item whose handling throws fails only its own action, never the cycle', async () => {
  const { directory, token } = await privateDirectory();
  const credential = join(directory, 'worker.token');
  await writeFile(credential, workerToken, { mode: 0o600 });
  try {
    const master = config(token, { workers: ['alpha', 'beta', 'gamma'].map(name => profile(name, credential)) });
    const lease = (owner: string) => ({ owner, epoch: 1, expiresAt: iso(10 * 60_000) });
    // Two workers sit at a prompt on their assignments; recording the first one's session handle throws.
    const broken = work({ id: 'broken', key: 'GY-1', stage: 'build', epoch: 1, lease: lease('alpha-principal'), gates: [{ name: 'build', passed: false, reasons: ['Worker has not submitted'] }] });
    const waiting = work({ id: 'waiting', key: 'GY-2', stage: 'build', epoch: 1, lease: lease('beta-principal'), gates: [{ name: 'build', passed: false, reasons: ['Worker has not submitted'] }] });
    const ready = work({ id: 'ready', key: 'GY-3' });
    const mergeable = submitted({ id: 'mergeable', key: 'GY-4', stage: 'merge', gates: [{ name: 'merge', passed: true, reasons: [] }] });
    const log: string[] = [];
    const deps = effects({
      snapshot: async () => ({ work: [broken, waiting, ready, mergeable], now: iso(0) }),
      agents: () => [{ name: 'agent-alpha', pane_id: 'pane-a', agent_status: 'blocked' }, { name: 'agent-beta', pane_id: 'pane-b', agent_status: 'blocked' }],
      recordSession: ((item: Work) => { if (item.key === 'GY-1') throw new TypeError("Cannot read properties of undefined (reading 'pane')"); log.push(`session:${item.key}`); return Promise.resolve(); }) as DaemonEffects['recordSession'],
    }, log);
    const state = emptyDaemonState(master);
    const result = await runDaemon(master, state, deps, { once: true, intervalMs: 20_000, identity: { pid: process.pid, host: 'machine-a' }, signals: ['SIGUSR2'], now: () => clock, log: () => {} });
    assert.deepEqual(result.failed, [], 'the cycle is not counted as failed');
    assert.equal(result.cycles.length, 1);
    assert.equal(state.failures.consecutive, 0);
    assert.equal(state.failures.total, 0);
    const isolated = state.actions['isolated:session:broken'];
    assert.equal(isolated?.state, 'failed', 'the failure is recorded against the item it was handling');
    assert.equal(isolated.work, 'GY-1');
    assert.match(isolated.detail, /reading 'pane'/);
    // Every other item was still handled, in the same step and in every step after it.
    // The ready item's session is registered before its launch dispatches (GY-172: every launch registers first).
    assert.deepEqual(log, ['session:GY-2', 'session:GY-3', 'dispatch:GY-3', 'merge:GY-4']);
    assert.ok(Object.keys(state.actions).some(key => key.startsWith('session:blocked:beta:')), 'the other blocked worker is still recorded');
    assert.equal(state.actions[dispatchKey(ready)].state, 'done');
    assert.equal(state.actions[candidateKey('merge', mergeable)].state, 'done');
    assert.ok(result.cycles[0].actions >= 4, 'the isolated failure is one of the cycle\'s actions, beside every other item\'s');
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
