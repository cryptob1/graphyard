import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadMasterConfig, masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';
import type { ActionRow } from '../src/model/actions.js';
import { describeUnserved, ExecutorRegistry, executorReport, ledgerLoopMerger, LoopRegistry, loopPresenceInterval, loopPresenceLiveMs, reportedLoopMerger, startExecutorFor } from '../src/model/executor-presence.js';
import { executorFleet } from '../src/cli/executor-report.js';
import { deploymentObservationSchema, emptyDaemonState, noteWatchdog, watchdogPlan, writeDaemonState, type DaemonState } from '../src/master-daemon.js';
import { awaitSupervisorRestart, performSelfUpgrade, restartEndedBySupervisorStop } from '../src/daemon/upgrade.js';
import { ChildProcessError } from '../src/child-runner.js';
import { readRestartFence, restartExecutors, writeExecutorRegistration, type ExecutorRegistration } from '../src/executor-fleet.js';
import { alignLoopUnit, loopUnitName, loopUnitText, loopWatchdogSeconds } from '../src/supervisor.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-916: the loop filed configuration faults against its own installation without reading the
 * installation state it already holds. Each test is named for the proof it produces:
 * unit:merge-row-served-by-live-loop and unit:merge-remedy-withheld-while-loop-merges (AC-1),
 * unit:upgrade-self-restart-survives-supervisor-stop and unit:upgrade-self-restart-failure-still-recorded
 * (AC-2), unit:restart-executors-awaits-held-claims and unit:upgrade-owed-restart-recorded-pending
 * (AC-3), unit:alignment-reapplies-supervisor-unit and unit:watchdog-refusal-clears-on-reapplied-unit (AC-4).
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const hex = (letter: string) => letter.repeat(40);

async function fixture() {
  const directory = await temporaryDirectory('config-faults');
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [],
    run: { intervalSeconds: 300 } });
  return { directory, master, dispose: () => rm(directory, { recursive: true, force: true }) };
}

const row = (id: string, key: string, kind: ActionRow['kind'], requestedAt: string, overrides: Partial<ActionRow> = {}): ActionRow => ({ id, kind, work: `work-${key}`, key, inputs: { kind } as ActionRow['inputs'], gate: kind === 'merge' ? 'merge' : 'build', refusal: null, reason: `${key} needs ${kind}`, binding: 'b',
  requestedBy: 'graphyard', requestedAt, state: 'pending', claim: null, attempts: 0, history: [], ...overrides });
const item = (key: string, rows: ActionRow[]) => ({ id: `work-${key}`, key, stage: 'merge', actionQueue: { actions: rows, history: [] } }) as unknown as Work;

/** A pending merge row and a pending resync row, two minutes old, and one live executor serving dispatch alone. */
function queue() {
  const now = new Date(clock);
  const work = [item('GY-903', [row('a'.repeat(32), 'GY-903', 'merge', iso(-120_000))]), item('GY-904', [row('b'.repeat(32), 'GY-904', 'resync', iso(-60_000))])];
  const registry = new ExecutorRegistry();
  registry.observe({ executor: 'graphyard-master@vishrog/1', host: 'vishrog', principal: 'graphyard-master', kinds: ['dispatch'] }, now);
  return { now, work, registry };
}

test('unit:merge-row-served-by-live-loop — with a live master loop merging, executorReport lists no pending merge row as unserved; with no live loop the report is unchanged', async () => {
  const { now, work, registry } = queue();
  // No loop: the merge row is unserved exactly as before, with its start command.
  const before = executorReport(work, registry, now);
  assert.deepEqual(before.unserved.map(entry => [entry.key, entry.kind, entry.start]), [['GY-903', 'merge', startExecutorFor('merge')], ['GY-904', 'resync', startExecutorFor('resync')]]);
  assert.equal(before.loop, undefined, 'no loop is invented');
  assert.deepEqual(before, executorReport(work, registry, now, undefined, null), 'an explicit absent loop is the same report');
  // A live loop named by the master CLI: the merge row waits on it, the resync row is still unserved.
  const loop = { live: true, name: 'the master loop (graphyard-master.service, pid 7 on vishrog, automatic merging on)' };
  const served = executorReport(work, registry, now, undefined, loop);
  assert.deepEqual(served.unserved.map(entry => entry.key), ['GY-904']);
  assert.deepEqual(served.loop, loop);
  // An installed but stopped loop merges nothing: the report is unchanged.
  assert.deepEqual(executorReport(work, registry, now, undefined, { live: false, name: 'installed' }).unserved.map(entry => entry.key), ['GY-903', 'GY-904']);
  // The control plane's own view: the ledger's merge requests from the loop's daemon instance.
  const ledger = [{ by: 'graphyard-master#daemon-5e1f', created_at: new Date(clock - 60_000) }, { by: 'graphyard-master#executor-77', created_at: new Date(clock - 1000) }];
  const query = async (text: string, values: unknown[]) => {
    assert.match(text, /kind='merge.enqueue.requested'/);
    const since = values[0] as Date;
    return { rows: ledger.filter(entry => entry.created_at > since && entry.by.includes('#daemon-')).sort((x, y) => +y.created_at - +x.created_at) };
  };
  const seen = await ledgerLoopMerger(query, now);
  assert.deepEqual(seen, { live: true, name: `the master loop (graphyard-master, last merge request ${iso(-60_000)})` });
  assert.deepEqual(executorReport(work, registry, now, undefined, seen).unserved.map(entry => entry.key), ['GY-904'], 'a merge request from the loop inside the window serves merge');
  assert.equal(await ledgerLoopMerger(query, new Date(clock + 2 * 3_600_000)), null, 'a loop not seen merging for hours is not assumed live');
  ledger.shift();
  assert.equal(await ledgerLoopMerger(query, now), null, 'an executor\'s merge request is not the loop');
  // The loop's own reads (GY-916): a live loop that has had nothing to merge for hours still reads
  // every cycle, and each read keeps it the merger; with no merge request in the ledger at all.
  const loops = new LoopRegistry();
  assert.equal(await reportedLoopMerger(loops, query, now), null, 'no read and no merge request: no loop');
  for (let hour = 0; hour <= 3; hour += 1) {
    const at = new Date(clock + hour * 3_600_000);
    loops.observe({ principal: 'graphyard-master', intervalSeconds: 300 }, at);
    const reading = await reportedLoopMerger(loops, query, new Date(at.getTime() + 600_000));
    assert.deepEqual(reading, { live: true, name: `the master loop (graphyard-master, cycling every 300s, last read ${at.toISOString()})` }, `still the merger ${hour}h after its last merge request`);
    assert.deepEqual(executorReport(work, registry, new Date(at.getTime() + 600_000), undefined, reading).unserved.map(entry => entry.key), ['GY-904']);
  }
  // A loop that stops reading lapses after three of its cycles, and the report is the fleet's again.
  const lastRead = clock + 3 * 3_600_000;
  assert.equal(loopPresenceLiveMs(300), 900_000);
  assert.equal(loopPresenceLiveMs(20), 120_000, 'never under an executor\'s window');
  assert.equal((await reportedLoopMerger(loops, query, new Date(lastRead + 900_000)))?.live, true);
  assert.equal(await reportedLoopMerger(loops, query, new Date(lastRead + 900_001)), null);
  // A loop seen reading that requests a merge and then crashes: once its reads lapse it is not live,
  // although its merge request is still inside the ledger's window; the report is the fleet's again.
  const crashed = new LoopRegistry();
  ledger.unshift({ by: 'graphyard-master#daemon-5e1f', created_at: new Date(clock - 60_000) });
  crashed.observe({ principal: 'graphyard-master', intervalSeconds: 20 }, new Date(clock - 300_000));
  assert.equal((await ledgerLoopMerger(query, now))?.live, true, 'the ledger still holds its recent merge request');
  assert.equal(await reportedLoopMerger(crashed, query, now), null, 'a lapsed reader with a recent merge request is not the merger');
  assert.deepEqual(executorReport(work, registry, now, undefined, await reportedLoopMerger(crashed, query, now)), before, 'with no live loop the report and its start command are unchanged');
  // A control plane that has never seen the loop read (just restarted) still reads the ledger.
  assert.equal((await reportedLoopMerger(new LoopRegistry(), query, now))?.live, true);
  ledger.shift();
  // Only an interval `master run` accepts names a loop.
  assert.deepEqual(['300', ['20'], undefined, '', '4', '901', '1.5', 'x'].map(value => loopPresenceInterval(value as never)), [300, 20, null, null, null, null, null, null]);

  // master status's fleet: the control plane did not see the loop, the master CLI on its host does.
  const root = await temporaryDirectory('config-faults-fleet');
  try {
    const answer = executorReport(work, new ExecutorRegistry(), now);
    const systemctl = () => { throw Object.assign(new Error('no user manager'), { stdout: '' }); };
    const masterApi = async () => ({ executors: answer });
    const snapshot = { work, now: now.toISOString() };
    const without = await executorFleet(root, masterApi, snapshot, systemctl as never);
    assert.deepEqual(without.unserved.map(entry => entry.kind), ['merge', 'resync'], 'without a live loop the fleet report is the control plane\'s');
    const withLoop = await executorFleet(root, masterApi, snapshot, systemctl as never, loop);
    assert.deepEqual(withLoop.presence.unserved.map(entry => entry.kind), ['resync']);
    assert.deepEqual(withLoop.unserved.map(entry => entry.kind), ['resync']);
    assert.ok(withLoop.attention.every(entry => !/Nothing can run merge/.test(entry.text)), 'no merge row is named unserved');
    // Unnamed by the caller, the loop is read from this host's cursor: a live lock is a merging loop.
    const { master, dispose } = await fixture();
    try {
      execFileSync('git', ['init', '-q', root]);
      await mkdir(join(root, '.graphyard'), { recursive: true });
      await writeFile(join(root, '.graphyard', 'master.json'), JSON.stringify(master), { mode: 0o600 });
      const config = await loadMasterConfig(root);
      const at = Date.now();
      await writeDaemonState(config, { ...emptyDaemonState(config), cycle: 3, lastCycleAt: new Date(at - 5_000).toISOString(),
        lock: { id: 'loop-lock', pid: process.pid, host: config.hostId, startedAt: new Date(at - 60_000).toISOString(), heartbeatAt: new Date(at - 5_000).toISOString() } });
      const detected = await executorFleet(root, masterApi, snapshot, systemctl as never);
      assert.deepEqual(detected.unserved.map(entry => entry.kind), ['resync'], 'the live loop on this host serves merge');
      assert.match(detected.presence.loop?.name ?? '', /the master loop \(.*pid \d+ on host-a/);
    } finally { await dispose(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:merge-remedy-withheld-while-loop-merges — no remediation text proposes giving executors the merge kind while a live loop merges; without one the start command is unchanged', () => {
  const { now, work, registry } = queue();
  const loop = { live: true, name: 'the master loop (pid 7 on vishrog)' };
  const report = executorReport(work, registry, now, undefined, loop);
  const lines = describeUnserved(report);
  assert.ok(lines.every(line => line.kind !== 'merge' && !/--kinds merge/.test(line.text) && !/--kinds merge/.test(line.start)), 'nothing proposes --kinds merge');
  // A report carrying the loop is never described as merge-unserved, even if a merge row reached it.
  const stale = { ...report, unserved: executorReport(work, registry, now).unserved };
  assert.ok(describeUnserved(stale).every(line => line.kind !== 'merge'), 'the loop on the report withholds the merge remedy');
  // No loop: the same text and command as before.
  const unchanged = describeUnserved(executorReport(work, registry, now));
  const merge = unchanged.find(line => line.kind === 'merge')!;
  assert.equal(merge.start, startExecutorFor('merge'));
  assert.match(merge.text, /^Nothing can run merge: GY-903 has waited 2m/);
  assert.match(merge.text, /--kinds merge$/);
});

const verified = (sha: string): DaemonState['deployment'] =>
  deploymentObservationSchema.parse({ source: 'endpoint', sha, at: iso(0), reason: null, deployed: ['GY-1'], pending: [] });
/** Fake git: a detached checkout at `head` whose base branch fetches to `tip`. */
const fakeGit = (head: string, tip: string, diff: string[] = ['src/daemon/run.ts']) => {
  let current = head;
  return async (command: string, args: string[]) => {
    const [op, ...operands] = args.slice(2);
    if (op === 'rev-parse') return `${operands[0] === 'HEAD' ? current : tip}\n`;
    if (op === 'symbolic-ref') throw Object.assign(new Error('not a symbolic ref'), { status: 1 });
    if (op === 'status' || op === 'fetch') return '';
    if (op === 'diff') return `${diff.join('\n')}\n`;
    if (op === 'checkout') { current = operands[2]; return ''; }
    throw new Error(`fake git cannot answer ${command} ${args.join(' ')}`);
  };
};
const restarted = (to: string) => ({ result: 'restarted' as const, reason: null, coordinator: { commit: to }, held: [], restarted: [], unsupervised: [], forgotten: [] });
const failedActions = (state: DaemonState) => Object.entries(state.actions).filter(([, action]) => action.state === 'failed' || action.state === 'indeterminate');

test('unit:upgrade-self-restart-survives-supervisor-stop — when the supervisor\'s stop ends the awaited systemctl --no-block restart child, performSelfUpgrade records upgraded with self true and stores no failed action', async () => {
  const { master, dispose } = await fixture();
  try {
    const state = emptyDaemonState(master);
    state.deployment = verified(hex('b'));
    state.release = { commit: hex('a'), dirty: false };
    // The unit's stop signals its whole cgroup: the systemctl child dies on SIGTERM with no exit
    // status (the child runner's own rejection), and the loop process receives the same SIGTERM.
    const killed = () => new ChildProcessError('systemctl', ['--user', '--no-block', 'restart', loopUnitName], { stdout: '', stderr: '', status: null, signal: 'SIGTERM', timedOut: false });
    const loopProcess = new EventEmitter();
    let selfCalls = 0;
    const upgraded = await performSelfUpgrade(master, state, { root: '/srv/graphyard', run: fakeGit(hex('a'), hex('b')), now: () => clock, persist: async () => {},
      restartExecutors: async to => restarted(to),
      restartSelf: () => awaitSupervisorRestart(async () => { selfCalls += 1; loopProcess.emit('SIGTERM'); throw killed(); }, loopProcess) });
    assert.equal(selfCalls, 1);
    assert.equal(loopProcess.listenerCount('SIGTERM'), 0, 'the watch ends with the wait');
    // The loop's own stop may land a moment after the child's: it is awaited inside the grace.
    const late = await awaitSupervisorRestart(async () => { setTimeout(() => loopProcess.emit('SIGTERM'), 20); throw killed(); }, loopProcess, 5_000).catch(error => error);
    assert.equal(restartEndedBySupervisorStop(late), true);
    assert.deepEqual({ outcome: upgraded.outcome, self: upgraded.outcome === 'upgraded' && upgraded.self, to: upgraded.outcome === 'upgraded' && upgraded.to }, { outcome: 'upgraded', self: true, to: hex('b') });
    assert.deepEqual(failedActions(state), [], 'no failed action is stored');
    assert.equal(state.faults.instances.length, 0, 'and no fault instance');
    assert.equal(state.upgrade.last?.self, true, 'the cursor says the loop re-executed itself');
    assert.equal(state.upgrade.pending, null);
    assert.equal(state.upgrade.alignedRelease, hex('b'));
  } finally { await dispose(); }
});

test('unit:upgrade-self-restart-failure-still-recorded — a systemctl failure not caused by the supervisor\'s stop still stores the failed action:config', async () => {
  const { master, dispose } = await fixture();
  try {
    for (const failure of [
      new ChildProcessError('systemctl', ['--user', '--no-block', 'restart', loopUnitName], { stdout: '', stderr: 'Failed to connect to bus', status: 1, signal: null, timedOut: false }),
      new ChildProcessError('systemctl', ['--user', '--no-block', 'restart', loopUnitName], { stdout: '', stderr: '', status: null, signal: 'SIGTERM', timedOut: true, timeoutMs: 30_000 }),
      new Error('this loop runs under no graphyard-master supervisor unit'),
      // A child signalled by something other than the unit's stop: the loop itself received no stop.
      await awaitSupervisorRestart(async () => { throw new ChildProcessError('systemctl', ['--user', '--no-block', 'restart', loopUnitName], { stdout: '', stderr: '', status: null, signal: 'SIGTERM', timedOut: false }); }, new EventEmitter(), 10).catch(error => error),
      await awaitSupervisorRestart(async () => { throw new ChildProcessError('systemctl', ['--user', '--no-block', 'restart', loopUnitName], { stdout: '', stderr: '', status: null, signal: 'SIGINT', timedOut: false }); }, new EventEmitter(), 10).catch(error => error),
    ]) {
      assert.equal(restartEndedBySupervisorStop(failure), false);
      const state = emptyDaemonState(master);
      state.deployment = verified(hex('b'));
      state.release = { commit: hex('a'), dirty: false };
      const upgraded = await performSelfUpgrade(master, state, { root: '/srv/graphyard', run: fakeGit(hex('a'), hex('b')), now: () => clock, persist: async () => {},
        restartExecutors: async to => restarted(to), restartSelf: async () => { throw failure; } });
      assert.equal(upgraded.outcome, 'failed');
      assert.match(upgraded.outcome === 'failed' ? upgraded.reason : '', /could not re-execute itself through its supervisor/);
      const failed = failedActions(state);
      assert.equal(failed.length, 1);
      assert.deepEqual([failed[0][0], failed[0][1].kind, failed[0][1].faultClass], [`upgrade:${hex('b')}`, 'config', 'configuration']);
      assert.equal(state.upgrade.last?.self, false);
    }
  } finally { await dispose(); }
});

const registered = (master: MasterConfig, name: string, overrides: Partial<ExecutorRegistration> = {}): ExecutorRegistration => ({
  version: 1, name, host: master.hostId, pid: process.pid, principal: 'graphyard-master', kinds: ['resync'], intervalSeconds: 5, root: '/srv/graphyard',
  release: { commit: hex('c'), dirty: false }, supervisor: { unit: `graphyard-executor@${name}.service`, restart: `systemctl --user restart graphyard-executor@${name}.service` },
  state: 'running', standDown: null, startedAt: new Date(Date.now() - 60_000).toISOString(), updatedAt: new Date().toISOString(), stoppedAt: null, claims: 3, lastClaim: null, inFlight: null, claiming: null, interrupted: null, ...overrides });

test('unit:restart-executors-awaits-held-claims — restartExecutors waits inside its fence, within its timeout, for control-plane held claims to settle before refusing', async () => {
  const { master, dispose } = await fixture();
  try {
    const current = hex('d');
    await writeExecutorRegistration(master, registered(master, 'exec-1'));
    const calls: string[][] = [];
    const supervisor = (command: string, args: string[]) => {
      calls.push([command, ...args]);
      if (command === 'systemctl' && args[1] === 'restart') void delay(10).then(() => writeExecutorRegistration(master, registered(master, 'exec-1', { pid: process.pid + 1, startedAt: new Date().toISOString(), release: { commit: current, dirty: false } })));
      return '';
    };
    const claimed = row('c'.repeat(32), 'GY-515', 'resync', new Date().toISOString(), { state: 'claimed', claim: { executor: 'exec-1', host: master.hostId, principal: 'graphyard-master', claimedAt: '2026-09-28T06:56:31.312Z', expiresAt: '2026-09-28T06:58:31.312Z', attempt: 1 } });
    const busy = { queue: { executors: [{ executor: 'exec-1', host: master.hostId, actions: 1 }] }, actions: [claimed] };
    const idle = { queue: { executors: [] }, actions: [] };
    // The claim settles on the third reading: the restart waited, under its fence, then went ahead.
    let reads = 0, fencedDuringWait = false;
    const settles = await restartExecutors(master, { coordinatorCommit: current, run: supervisor, sleep: ms => delay(Math.min(ms, 5)).then(() => {}), timeoutMs: 5_000,
      actions: async () => { reads += 1; if (reads === 2) fencedDuringWait = !!await readRestartFence(master); return reads < 3 ? busy : idle; } });
    assert.equal(settles.result, 'restarted', settles.reason ?? '');
    assert.equal(reads, 3, 'the held claim was read again until it settled');
    assert.ok(fencedDuringWait, 'the wait happens inside the fence');
    assert.deepEqual(calls, [['systemctl', '--user', 'restart', 'graphyard-executor@exec-1.service']]);
    // A claim still held when the timeout ends refuses, naming it, having restarted nothing.
    calls.length = 0;
    let waits = 0;
    const started = Date.now();
    const refused = await restartExecutors(master, { coordinatorCommit: current, run: supervisor, sleep: ms => { waits += 1; return delay(Math.min(ms, 5)).then(() => {}); }, timeoutMs: 100, actions: async () => busy });
    assert.equal(refused.result, 'refused');
    assert.match(refused.reason!, /exec-1 holds resync for GY-515 since 2026-09-28T06:56:31.312Z/);
    assert.ok(waits > 1 && Date.now() - started >= 100, 'it waited out its timeout before refusing');
    assert.deepEqual(calls, [], 'nothing was restarted');
    assert.equal(await readRestartFence(master), null, 'the fence is lowered with the refusal');
  } finally { await dispose(); }
});

test('unit:upgrade-owed-restart-recorded-pending — an upgrade pass whose executor restart is still refused records the owed restart as pending on the cursor, not a failed action:config, and the next cycle completes it', async () => {
  const { master, dispose } = await fixture();
  try {
    const state = emptyDaemonState(master);
    state.deployment = verified(hex('b'));
    state.release = { commit: hex('a'), dirty: false };
    const run = fakeGit(hex('a'), hex('b'));
    const refusal = 'Restart refused while an executor on host-a holds a claimed action: graphyard-master@vishrog/1 holds resync for GY-515 since 2026-09-28T06:56:31.312Z';
    let selfCalls = 0;
    const blocked = await performSelfUpgrade(master, state, { root: '/srv/graphyard', run, now: () => clock, persist: async () => {},
      restartExecutors: async to => ({ ...restarted(to), result: 'refused' as const, reason: refusal }), restartSelf: async () => { selfCalls += 1; } });
    assert.equal(blocked.outcome, 'pending');
    assert.match(blocked.outcome === 'pending' ? blocked.reason : '', /retried next cycle/);
    assert.deepEqual(state.upgrade.pending, { from: hex('a'), to: hex('b'), code: true }, 'the owed restart is on the cursor');
    assert.equal(state.upgrade.alignedRelease, null);
    assert.deepEqual(failedActions(state), [], 'no failed action:config');
    assert.equal(state.faults.instances.length, 0);
    assert.equal(state.actions[`upgrade:${hex('b')}`].state, 'waiting');
    assert.equal(selfCalls, 0, 'the loop does not re-execute before its executors');
    // Next cycle: the claims settled, the checkout already at the tip, the owed restarts complete.
    const executors: string[] = [];
    const finished = await performSelfUpgrade(master, state, { root: '/srv/graphyard', run, now: () => clock, persist: async () => {},
      restartExecutors: async to => { executors.push(to); return restarted(to); }, restartSelf: async () => { selfCalls += 1; } });
    assert.equal(finished.outcome, 'upgraded');
    assert.deepEqual(executors, [hex('b')]);
    assert.equal(selfCalls, 1);
    assert.equal(state.upgrade.pending, null);
    assert.equal(state.upgrade.alignedRelease, hex('b'));
    assert.equal(state.actions[`upgrade:${hex('b')}`].state, 'done');
    assert.deepEqual(failedActions(state), []);
  } finally { await dispose(); }
});

/** A coordinator checkout and a temp-rooted home with the hand-copied packaged unit installed. */
async function installedUnit(master: MasterConfig) {
  const home = await temporaryDirectory('config-faults-home');
  const root = join(home, 'code', 'graphyard');
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(join(root, '.graphyard', 'master.json'), '{}');
  const unitDirectory = join(home, '.config', 'systemd', 'user');
  await mkdir(unitDirectory, { recursive: true });
  const input = { root, cliPath: master.cliPath, repository: master.repository, intervalSeconds: master.run.intervalSeconds, execPath: '/usr/bin/node' };
  // The packaged example as an operator copied it: this loop's checkout and launcher, the 20s default's window.
  const stale = loopUnitText({ ...input, intervalSeconds: 20 }).replace(/^WatchdogSec=.*$/m, 'WatchdogSec=600');
  await writeFile(join(unitDirectory, loopUnitName), stale);
  const commands: string[][] = [];
  const host = { home, temporaryDirectories: [join(home, 'tmp-elsewhere')], platform: 'linux' as const, run: (command: string, args: string[]) => { commands.push([command, ...args]); return args[1] === 'is-enabled' ? 'enabled' : args[1] === 'is-active' ? 'active' : ''; } };
  return { home, root, input, host, commands, unitPath: join(unitDirectory, loopUnitName), dispose: () => rm(home, { recursive: true, force: true }) };
}

test('unit:alignment-reapplies-supervisor-unit — the alignment step rewrites the supervisor unit whose text no longer matches loopUnitText for the running configuration, before the loop re-executes through it', async () => {
  const { master, dispose } = await fixture();
  const unit = await installedUnit(master);
  try {
    assert.match(await readFile(unit.unitPath, 'utf8'), /^WatchdogSec=600$/m);
    const order: string[] = [];
    const state = emptyDaemonState(master);
    state.deployment = verified(hex('b'));
    state.release = { commit: hex('a'), dirty: false };
    const upgraded = await performSelfUpgrade(master, state, { root: '/srv/graphyard', run: fakeGit(hex('a'), hex('b')), now: () => clock, persist: async () => {},
      restartExecutors: async to => { order.push('executors'); return restarted(to); },
      alignUnit: async () => { order.push('unit'); return alignLoopUnit(unit.input, unit.host); },
      restartSelf: async () => { order.push('self'); } });
    assert.equal(upgraded.outcome, 'upgraded');
    assert.deepEqual(order, ['executors', 'unit', 'self'], 'the unit is re-applied before the loop re-executes through it');
    const text = await readFile(unit.unitPath, 'utf8');
    assert.equal(text, loopUnitText(unit.input), 'the unit now matches the running configuration');
    assert.match(text, new RegExp(`^WatchdogSec=${loopWatchdogSeconds(300)}$`, 'm'));
    assert.equal(loopWatchdogSeconds(300), 1800);
    assert.ok(unit.commands.some(command => command.join(' ') === 'systemctl --user daemon-reload'), 'systemd re-reads the unit');
    assert.ok(!unit.commands.some(command => command[1] === 'restart'), 'no blocking restart from inside the unit: the loop\'s own --no-block restart follows');
    assert.equal(state.actions['upgrade:unit'].state, 'done');
    assert.deepEqual(failedActions(state), []);
    // A unit that already matches is not touched again.
    unit.commands.length = 0;
    assert.equal((await alignLoopUnit(unit.input, unit.host)).wrote, 'unchanged');
    assert.deepEqual(unit.commands, []);
  } finally { await unit.dispose(); await dispose(); }
});

test('unit:watchdog-refusal-clears-on-reapplied-unit — watchdogPlan\'s refusal clears once the installed unit matches, and between alignments it is stored once per process, not once per cycle', async () => {
  const { master, dispose } = await fixture();
  try {
    const intervalMs = master.run.intervalSeconds * 1000;
    const state = emptyDaemonState(master);
    const persisted: number[] = [];
    const persist = async () => { persisted.push(1); };
    // The hand-copied unit's 600s window under a 300s interval: refused, stored once.
    const stale = watchdogPlan({ NOTIFY_SOCKET: '/run/notify', WATCHDOG_USEC: String(600 * 1_000_000) }, intervalMs);
    assert.match(stale.refusal ?? '', /watchdog window \(600s\) is not longer than two cycle intervals \(600s\)/);
    const [first] = await noteWatchdog(state, stale, iso(0), persist);
    assert.equal(first.state, 'failed');
    assert.equal(first.faultClass, 'configuration');
    // The same process start noted again, and later restarts before the alignment: not stored again.
    assert.deepEqual(await noteWatchdog(state, stale, iso(1000), persist), []);
    assert.deepEqual(await noteWatchdog(state, stale, iso(2000), persist), []);
    assert.equal(state.faults.instances.length, 1, 'one configuration fault, not one per cycle or restart');
    // The alignment re-applied the unit; the process it starts runs under the generated window.
    const aligned = watchdogPlan({ NOTIFY_SOCKET: '/run/notify', WATCHDOG_USEC: String(loopWatchdogSeconds(master.run.intervalSeconds) * 1_000_000) }, intervalMs);
    assert.equal(aligned.refusal, null);
    const cleared = await noteWatchdog(state, aligned, iso(3000), persist);
    assert.equal(cleared.length, 1);
    assert.equal(state.actions['escalation:watchdog:600000'].state, 'done', 'the standing refusal is cleared');
    assert.match(state.actions['escalation:watchdog:600000'].detail, /^Cleared: the supervisor's watchdog window is now 1800s/);
    assert.deepEqual(Object.values(state.actions).filter(action => action.state === 'failed'), []);
    // Nothing more to clear on the next start.
    assert.deepEqual(await noteWatchdog(state, aligned, iso(4000), persist), []);
    // An unsupervised loop clears nothing and stores nothing.
    assert.deepEqual(await noteWatchdog(emptyDaemonState(master), watchdogPlan({}, intervalMs), iso(0), persist), []);
  } finally { await dispose(); }
});
