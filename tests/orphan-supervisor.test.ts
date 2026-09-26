import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { assignmentSurrender, herdrSessionProbe, supervise } from '../src/supervisor.js';
import { emptyDaemonState, orphanedSupervisors, runCycle, stopWatchSupervisor, type DaemonEffects, type DaemonState, type OrphanSupervisor } from '../src/master-daemon.js';
import { nameOrphanSupervisors, supervisorReclaimCommand } from '../src/cli/master-status.js';
import { buildMasterStatus, masterConfigSchema, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const leaseMs = 120_000;
const renewal = (duration = leaseMs) => ({ updatedAt: new Date().toISOString(), lease: { epoch: 1, expiresAt: new Date(Date.now() + duration).toISOString() } });

test('integration:supervisor-exits-with-session a supervisor whose Herdr session is gone stops heartbeating inside one lease period, releases the lease and records the cause', async () => {
  const surrendered: string[] = [];
  let renewals = 0, looks = 0;
  const started = performance.now();
  const code = await supervise(process.execPath, ['-e', 'setInterval(() => {}, 20)'], 1,
    async () => { renewals++; return renewal(); },
    { intervalMs: 20, graceMs: 25, session: { visible: () => ++looks < 3, surrender: async cause => { surrendered.push(cause); } } });
  const elapsed = performance.now() - started;
  const heartbeats = renewals;

  assert.equal(code, 1);
  assert.ok(elapsed < leaseMs, `the supervisor stopped after ${Math.round(elapsed)}ms, inside one ${leaseMs}ms lease period`);
  assert.deepEqual(surrendered, ['Herdr no longer reports this agent session'],
    'the lease is released once, with the cause that ended the attempt recorded on the assignment');
  await delay(100);
  assert.equal(renewals, heartbeats, 'nothing is renewed after the session is gone');
});

test('integration:supervisor-exits-with-session a supervisor whose agent has left its containment scope stops, names the exit and never mistakes a scope it has not seen alive for an empty one', async () => {
  // The containment here only records the signals it is given, so the child must outlive them:
  // only the supervisor's own judgement, never a kill, can end this attempt.
  const child = { command: process.execPath, args: ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 800)"] };
  const causes: string[] = [];
  let live = 2, signals: NodeJS.Signals[] = [], settled = 0;
  const containment = { ...child, signal: (signal: NodeJS.Signals) => { signals.push(signal); }, empty: () => live-- <= 0 };
  const code = await supervise('ignored', [], 1, async () => renewal(), {
    containment, detached: false, intervalMs: 20, graceMs: 25, shutdownPollMs: 5,
    session: { visible: () => null, surrender: async cause => { causes.push(cause); } },
    quarantine: { establish: async () => {}, settle: async () => { settled++; } },
  });
  assert.equal(code, 1);
  assert.deepEqual(causes, ['the worker containment scope holds no process, so the agent has exited']);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'], 'the scope is stopped through its own containment, not left running');
  assert.equal(settled, 1, 'the quarantine is settled once the containment is verified empty');

  // A scope reported empty before it was ever seen holding the agent is a scope that has not
  // started yet: acting on it would kill the session it is about to hold.
  const early: string[] = [];
  let renewals = 0;
  assert.equal(await supervise('ignored', [], 1,
    async () => ++renewals < 4 ? renewal() : Promise.reject(Object.assign(new Error('lease epoch superseded'), { confirmedRefusal: true })),
    { containment: { ...child, signal: () => {}, empty: () => true }, detached: false, intervalMs: 20, graceMs: 25, shutdownPollMs: 5,
      session: { visible: () => null, surrender: async cause => { early.push(cause); } },
      quarantine: { establish: async () => {}, settle: async () => {} } }), 1);
  assert.deepEqual(early, [], 'an always-empty scope was never seen alive, so its emptiness proves nothing');
  assert.ok(renewals >= 4, 'the supervisor kept renewing until the lease itself was refused');
});

test('integration:supervisor-exits-with-session the surrender a supervisor performs by default records the cause, withdraws the report and releases its own assignment', async () => {
  const calls: { path: string; body: any }[] = [];
  const surrender = assignmentSurrender(3, [process.execPath, launcher, 'watch', 'GY-83', '3', '--', 'opencode'],
    { GRAPHYARD_URL: 'https://graphyard.example/', GRAPHYARD_TOKEN: 'worker-token' },
    async (url, token, path, body) => {
      assert.equal(url, 'https://graphyard.example/'); assert.equal(token, 'worker-token');
      calls.push({ path, body });
    });
  await surrender!('Herdr no longer reports this agent session');
  assert.deepEqual(calls.map(call => call.path), ['work/GY-83/blocked', 'work/GY-83/blocked', 'work/GY-83/release']);
  assert.match(calls[0].body.reason, /^Watch supervisor ended attempt 3: Herdr no longer reports this agent session$/);
  assert.deepEqual(calls[1].body, { epoch: 3, reason: null }, 'the report is withdrawn so the freed item waits on nobody');
  assert.deepEqual(calls[2].body, { epoch: 3 });

  // Another attempt's command line, a missing credential, and a missing assignment each surrender
  // nothing rather than guessing which lease to end.
  const environment = { GRAPHYARD_URL: 'https://graphyard.example', GRAPHYARD_TOKEN: 'worker-token' };
  const argv = [process.execPath, launcher, 'watch', 'GY-83', '3', '--', 'opencode'];
  assert.equal(assignmentSurrender(2, argv, environment), undefined);
  assert.equal(assignmentSurrender(3, argv, { GRAPHYARD_URL: environment.GRAPHYARD_URL }), undefined);
  assert.equal(assignmentSurrender(3, [process.execPath, launcher, 'status', 'GY-83'], environment), undefined);

  // The session probe identifies this supervisor's own pane, and an unreachable Herdr is not an absence.
  const pane = { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p7' };
  const agents = (json: string) => () => json;
  assert.equal(herdrSessionProbe(pane, agents(JSON.stringify({ result: { agents: [{ pane_id: 'w1:p7' }] } })))(), true);
  assert.equal(herdrSessionProbe(pane, agents(JSON.stringify({ result: { agents: [{ pane_id: 'w1:p9' }] } })))(), false);
  assert.equal(herdrSessionProbe(pane, agents('not json'))(), null);
  assert.equal(herdrSessionProbe(pane, () => { throw new Error('herdr is not running'); })(), null);
  assert.equal(herdrSessionProbe({ HERDR_ENV: '1' }, agents(JSON.stringify({ result: { agents: [] } })))(), null,
    'a supervisor with no pane of its own claims nothing about the session');
});

const observedAt = '2030-01-01T12:00:00.000Z';
const at = (offsetMs: number) => new Date(Date.parse(observedAt) + offsetMs).toISOString();
const scope = { unit: 'graphyard-watch-2595298-d4330bd1-0dda-4993-a359-e06ce63afe44.scope', pid: 2595298 };
const workspace = { host: 'coordinator-host', path: '/srv/worktrees/GY-83-2', branch: 'graphyard/gy-83-2', epoch: 2, owner: 'worker-a' };
const worker = { name: 'opencode-1', principal: 'worker-a', agentName: 'graphyard-opencode-1', mode: 'launch', kind: 'codex', credentialFile: '/srv/credentials/opencode-1.token', agentArgs: [], environment: {} } as unknown as WorkerProfile;

function item(leaseExpiresAt: string | null, overrides: Partial<Work> = {}): Work {
  return { id: 'work-83', key: 'GY-83', title: 'An orphaned watch supervisor renews a lease forever', description: '', type: 'bug', priority: 0,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Stops', proofs: ['unit:orphan-supervisor-attention'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/supervisor.ts'], stage: 'build', revision: 9, policyRevision: 1,
    createdAt: at(-7_200_000), updatedAt: observedAt, stageEnteredAt: at(-600_000), ready: true, epoch: 2,
    lease: leaseExpiresAt ? { owner: 'worker-a', epoch: 2, expiresAt: leaseExpiresAt } : null,
    workspaces: [workspace], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: null, blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [],
    containmentQuarantine: { owner: 'worker-a', epoch: 2, at: at(-7_200_000), settlementHash: 'a'.repeat(64), launchAcknowledgedAt: at(-7_200_000), launchExpiresAt: at(-7_200_000), leaseExpiresAt: at(-7_200_000), scope },
    ...overrides } as Work;
}

async function daemon(work: (cycle: number) => Work[], overrides: Partial<DaemonEffects> = {}) {
  const directory = await temporaryDirectory('orphan');
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'coordinator-host',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [worker] });
  const state: DaemonState = emptyDaemonState(config);
  let cycle = 0;
  const stopped: { orphan: OrphanSupervisor; signal: NodeJS.Signals }[] = [];
  const effects: DaemonEffects = {
    agents: () => [],
    herdr: () => ({ agents: [], available: true }),
    stopSupervisor: (orphan, signal) => { stopped.push({ orphan, signal }); },
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: work(cycle++), now: observedAt }),
    closeSession: () => {},
    dispatch: async () => {},
    requestProof: () => {},
    merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: observedAt, reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
    ...overrides,
  };
  return { config, state, effects, stopped, cleanup: () => rm(directory, { recursive: true, force: true }),
    run: () => runCycle(config, state, effects, () => Date.parse(observedAt)) };
}

test('integration:orphan-supervisor-reclaim the loop records a lease renewed by a vanished session as an incident with its pid and unit, and stops that supervisor through its containment scope', async () => {
  // The supervisor keeps renewing: each cycle reads a later expiry than the one before it.
  const expiries = [at(30_000), at(55_000), at(80_000)];
  const harness = await daemon(cycle => [item(expiries[Math.min(cycle, expiries.length - 1)])]);
  try {
    const first = await harness.run();
    assert.equal(harness.stopped.length, 0, 'one observation cannot tell a renewed lease from one that has not lapsed yet');
    assert.deepEqual(first.actions.filter(action => action.work === 'GY-83'), []);
    assert.deepEqual(harness.state.orphans['work-83'], { epoch: 2, owner: 'worker-a', pid: scope.pid, unit: scope.unit, firstSeenAt: observedAt, leaseExpiresAt: expiries[0], stops: 0, stoppedLeaseExpiresAt: null });

    const second = await harness.run();
    assert.equal(harness.stopped.length, 1, 'the loop stops the supervisor itself rather than leaving it to a human');
    assert.deepEqual(harness.stopped[0].orphan.scope, scope);
    assert.equal(harness.stopped[0].signal, 'SIGTERM');
    const incident = second.actions.find(action => action.work === 'GY-83')!;
    assert.equal(incident.state, 'done');
    assert.equal(incident.principal, 'worker-a');
    assert.equal(incident.epoch, 2);
    assert.match(incident.detail, new RegExp(`pid ${scope.pid}`), 'the incident names the process that holds the lease');
    assert.match(incident.detail, new RegExp(`containment scope ${scope.unit.replace(/[.]/g, '\\.')}`), 'the incident names the scope it is stopped through');
    assert.match(incident.detail, /Herdr no longer reports session graphyard-opencode-1/);
    assert.equal(harness.state.orphans['work-83'].stops, 1);

    // A lease that advances past the stop proves it did not take; the next signal is not negotiable.
    const third = await harness.run();
    assert.equal(harness.stopped.length, 2);
    assert.equal(harness.stopped[1].signal, 'SIGKILL');
    assert.match(third.actions.find(action => action.work === 'GY-83')!.detail, /SIGKILL/);
  } finally { await harness.cleanup(); }
});

test('integration:orphan-supervisor-reclaim a live session, an unreadable Herdr, a lease that stopped advancing and a lapsed lease are never stopped', async () => {
  const live: HerdrAgent[] = [{ name: 'graphyard-opencode-1', agent_status: 'done', pane_id: 'w1:p7' }];
  for (const [reason, overrides, work] of [
    ['Herdr still reports the session', { herdr: () => ({ agents: live, available: true }) }, (cycle: number) => [item(at(30_000 + cycle * 25_000))]],
    ['Herdr could not be read at all', { herdr: () => ({ agents: [], available: false }) }, (cycle: number) => [item(at(30_000 + cycle * 25_000))]],
    ['the lease stopped advancing', {}, () => [item(at(30_000))]],
    ['the lease has lapsed', {}, () => [item(at(-30_000))]],
    ['the launch recorded no containment scope', {}, () => [item(at(30_000), { containmentQuarantine: null } as Partial<Work>)]],
  ] as [string, Partial<DaemonEffects>, (cycle: number) => Work[]][]) {
    const harness = await daemon(work, overrides);
    try {
      await harness.run(); await harness.run(); await harness.run();
      assert.equal(harness.stopped.length, 0, `nothing is stopped when ${reason}`);
    } finally { await harness.cleanup(); }
  }
});

test('integration:orphan-supervisor-reclaim the stop reaches the recorded scope and refuses a pid that no longer runs that assignment', async () => {
  const orphan: OrphanSupervisor = { id: 'work-83', key: 'GY-83', epoch: 2, owner: 'worker-a', profile: worker.name, agentName: worker.agentName, scope, leaseExpiresAt: at(30_000) };
  const commands: string[][] = [], killed: [number, NodeJS.Signals][] = [];
  const run = (command: string, args: string[]) => { commands.push([command, ...args]); return ''; };
  const supervisorArgv = ['node', launcher, 'watch', 'GY-83', '2', '--', 'opencode'].join('\0');

  const result = await stopWatchSupervisor(orphan, 'SIGTERM', run, (pid, signal) => { killed.push([pid, signal]); }, () => supervisorArgv);
  assert.deepEqual(commands, [['systemctl', '--user', 'kill', '--kill-whom=all', '--signal=SIGTERM', scope.unit]]);
  assert.deepEqual(killed, [[scope.pid, 'SIGTERM']], 'the supervisor that outlived the scope is stopped too');
  assert.deepEqual(result.refusals, []);

  // A recycled pid keeps its scope stopped and is reported, never signalled.
  killed.length = 0;
  const recycled = await stopWatchSupervisor(orphan, 'SIGKILL', run, (pid, signal) => { killed.push([pid, signal]); }, () => ['node', launcher, 'watch', 'GY-42', '1', '--', 'opencode'].join('\0'));
  assert.deepEqual(killed, []);
  assert.match(recycled.refusals[0], /no longer runs the watch supervisor for GY-83 epoch 2/);

  await assert.rejects(stopWatchSupervisor({ ...orphan, scope: { ...scope, unit: 'user.slice' } }, 'SIGTERM', run), /not a Graphyard watch scope/);
  await assert.rejects(stopWatchSupervisor(orphan, 'SIGTERM', () => { throw new Error('no user manager'); }, () => {}, () => { throw new Error('ESRCH'); }), /no user manager/);
});

const status = (work: Work, agents: HerdrAgent[] = []) => buildMasterStatus({ work: [work], now: observedAt }, [worker], agents);
const named = (work: Work, agents: HerdrAgent[] = [], available = true) =>
  nameOrphanSupervisors(status(work, agents), [work], [worker], { agents, available }, Date.parse(observedAt));

test('unit:orphan-supervisor-attention master status names an orphaned supervisor and the command that reclaims it instead of reporting a finished session', () => {
  const held = item(at(30_000));
  assert.equal(status(held).work[0].attention, 'Assigned worker session is offline',
    'the ambiguous line is what the report says without this');

  const report = named(held);
  const row = report.work[0];
  assert.doesNotMatch(row.attention!, /Assigned worker session is/);
  assert.equal(row.attention, `Lease epoch 2 of GY-83 is still advancing (to ${at(30_000)}) while Herdr no longer reports session graphyard-opencode-1: an orphaned watch supervisor (pid ${scope.pid}, containment scope ${scope.unit}) holds the item for a worker that cannot act`);
  assert.equal(row.attentionOwner!.role, 'master');
  assert.equal(row.attentionOwner!.human, false, 'reclaiming an orphaned supervisor is not a human decision');
  assert.ok(row.attentionOwner!.next.startsWith(supervisorReclaimCommand), `the reclaim command leads: ${row.attentionOwner!.next}`);
  assert.match(row.attentionOwner!.next, new RegExp(`--signal=SIGTERM ${scope.unit.replace(/[.]/g, '\\.')}`), 'the by-hand path names the exact scope on the registered host');
  assert.match(row.attentionOwner!.next, /coordinator-host/);

  // The row and the attention list say the same thing, exactly once, and the count is unchanged.
  assert.deepEqual(report.attentionItems.map(entry => entry.text), [row.attention]);
  assert.equal(report.counts.attention, status(held).counts.attention);
});

test('unit:orphan-supervisor-attention a reported session, an unreadable Herdr and a lapsed lease keep the report as it was', () => {
  const held = item(at(30_000));
  const working: HerdrAgent[] = [{ name: 'graphyard-opencode-1', agent_status: 'working', pane_id: 'w1:p7' }];
  assert.equal(named(held, working).work[0].attention, null, 'a session Herdr reports working is nobody\'s attention');

  const done: HerdrAgent[] = [{ name: 'graphyard-opencode-1', agent_status: 'done', pane_id: 'w1:p7' }];
  assert.equal(named(held, done).work[0].attention, 'Assigned worker session is done',
    'a session Herdr still reports is not an orphaned supervisor, whatever state it is in');

  assert.equal(named(held, [], false).work[0].attention, 'Assigned worker session is offline',
    'an unreadable Herdr reports no sessions, and every live assignment must not read as orphaned');

  // A lapsed lease is the containment path's business, not an advancing one.
  const lapsed = item(at(-30_000));
  assert.deepEqual(orphanedSupervisors([lapsed], [worker], [], Date.parse(observedAt)), []);
  assert.match(named(lapsed).work[0].attention!, /^Worker lease for epoch 2 lapsed at .*containment grace window/);
});

test('unit:orphan-supervisor-attention only the epoch that holds the lease, under a launch profile, is read as an orphaned supervisor', () => {
  const now = Date.parse(observedAt);
  const held = item(at(30_000));
  assert.equal(orphanedSupervisors([held], [worker], [], now).length, 1);
  // Another attempt's containment scope must never be stopped on this attempt's behalf.
  assert.deepEqual(orphanedSupervisors([item(at(30_000), { containmentQuarantine: { ...held.containmentQuarantine!, epoch: 1 } } as Partial<Work>)], [worker], [], now), []);
  assert.deepEqual(orphanedSupervisors([item(at(30_000), { containmentQuarantine: { ...held.containmentQuarantine!, owner: 'worker-b' } } as Partial<Work>)], [worker], [], now), []);
  assert.deepEqual(orphanedSupervisors([held], [{ ...worker, mode: 'existing' } as WorkerProfile], [], now), [],
    'an observed session is never injected into, so it is never stopped either');
  assert.deepEqual(orphanedSupervisors([item(at(30_000), { stage: 'done' } as Partial<Work>)], [worker], [], now), []);
  assert.deepEqual(orphanedSupervisors([held], [], [], now), []);
});
