import { after, mock, test } from 'node:test';
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
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import type { Principal } from '../src/model.js';
import type { NextActionKind } from '../src/model/next-action.js';
import { classifyAttention } from '../src/model/fault-classes.js';
import { actionRoutes } from '../src/server/routes/actions.js';
import { matchRoute, type RouteContext } from '../src/server/routes.js';
import { describeUnserved, durablePresence, ExecutorRegistry, executorLiveMs, executorRegistry, executorReport, ledgerLoopMerger, LoopRegistry, loopPresenceInterval, loopPresenceLiveMs, presenceQuery, reportedLoopMerger, startExecutorFor } from '../src/model/executor-presence.js';
import { executorFleet } from '../src/cli/executor-report.js';
import { deploymentObservationSchema, emptyDaemonState, noteWatchdog, runDaemon, watchdogPlan, writeDaemonState, type DaemonState } from '../src/master-daemon.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
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
    let waits = 0, keepAlives = 0;
    const started = Date.now();
    const refused = await restartExecutors(master, { coordinatorCommit: current, run: supervisor, sleep: ms => { waits += 1; return delay(Math.min(ms, 5)).then(() => {}); }, timeoutMs: 100, actions: async () => busy,
      onWait: () => { keepAlives += 1; } });
    assert.equal(refused.result, 'refused');
    assert.match(refused.reason!, /exec-1 holds resync for GY-515 since 2026-09-28T06:56:31.312Z/);
    assert.ok(waits > 1 && Date.now() - started >= 100, 'it waited out its timeout before refusing');
    assert.equal(keepAlives, waits, 'every poll of the wait feeds the supervisor\'s watchdog, so a long wait is not a hung loop');
    assert.deepEqual(calls, [], 'nothing was restarted');
    assert.equal(await readRestartFence(master), null, 'the fence is lowered with the refusal');
    // A keep-alive that fails does not decide the restart.
    const unfed = await restartExecutors(master, { coordinatorCommit: current, run: supervisor, sleep: ms => delay(Math.min(ms, 5)).then(() => {}), timeoutMs: 50, actions: async () => busy,
      onWait: () => { throw new Error('systemd-notify failed'); } });
    assert.equal(unfed.result, 'refused');
    assert.match(unfed.reason!, /holds resync for GY-515/);
    // The loop wires that keep-alive to its supervisor between cycles: under a watchdog the
    // upgrade's waits notify 'alive'; with no supervisor it is given none.
    for (const [environment, expected] of [[{ NOTIFY_SOCKET: '/run/notify', WATCHDOG_USEC: String(180 * 1_000_000) }, ['ready', 'alive', 'alive', 'alive']], [{}, []]] as const) {
      const notified: string[] = [];
      const effects = {
        snapshot: async () => ({ work: [], now: iso(0) }), agents: () => [], credentials: async () => ({}),
        observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'none', deployed: [], pending: [] }),
        requestSmoke: async () => {}, merge: async () => {}, recordDeployment: async () => {}, requestProof: async () => {},
        dispatch: async () => {}, recordSession: async () => {}, closeSession: () => {}, persist: async () => {},
        notify: (signal: string) => { notified.push(signal); },
        selfUpgrade: async (_state: DaemonState, keepAlive?: () => Promise<void>) => {
          assert.equal(!!keepAlive, !!environment.NOTIFY_SOCKET);
          // Two polls of a held claim on a test clock, then the refusal: two keep-alives mid-wait.
          let at = clock;
          await restartExecutors(master, { coordinatorCommit: current, run: supervisor, now: () => at, sleep: async ms => { at += ms; }, pollMs: 1000, timeoutMs: 2000, actions: async () => busy, onWait: keepAlive });
          return { outcome: 'skipped' as const, reason: 'nothing deployed yet' };
        },
      } as unknown as DaemonEffects;
      await runDaemon(master, emptyDaemonState(master), effects, { once: true, intervalMs: 20_000, identity: { pid: process.pid, host: master.hostId }, log: () => {}, signals: [], environment });
      assert.deepEqual(notified, expected);
    }
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

/**
 * GY-1289: executor presence outlives the control-plane process. GY-1288's three instances —
 * dispatch on GY-1287, approve-scope on GY-1286 and request-review on GY-1238, one read at
 * 2026-10-05T09:43:15.274Z — came from a production deploy: the fleet claimed durably at 09:42:41,
 * the serving process was replaced, and the new one answered the loop's read with an empty
 * in-memory registry past its birth-keyed grace. Each test is named for the proof it produces:
 * unit:executor-presence-outlives-restart (AC-1), unit:executor-presence-idle-poll-no-event (AC-2),
 * unit:executor-presence-renewal-live (AC-3), unit:executor-listening-keyed-to-evidence (AC-4), and
 * manual:fault-class-configuration (AC-5). The executor routes run against a real engine and store.
 */
const fleetKinds: NextActionKind[] = ['dispatch', 'request-review', 'approve-scope', 'resync', 'reclaim', 'verify-deployment'];
const coordinatorActor = { id: 'graphyard-master', role: 'coordinator' } as Principal;
const fleetSlot = (n: number) => `graphyard-master@vishrog/${n}`;
let database: EmbeddedPostgres | undefined, sharedStore: Store | undefined;
/** One Postgres for the file, started by the first test that needs it; every such test starts from an empty presence table. */
async function presenceStore(): Promise<Store> {
  if (!sharedStore) {
    const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1289;
    database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('executor-presence-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
    await database.initialise(); await database.start(); await database.createDatabase('presence_test');
    sharedStore = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/presence_test`); await sharedStore.init();
  }
  await sharedStore.pool.query('TRUNCATE executor_presence');
  return sharedStore;
}
after(async () => { await sharedStore?.close(); await database?.stop(); });
/** One serving process: an engine over the shared store, with its own in-memory registry. */
function servingProcess(store: Store) {
  const engine = new Engine(store, [15368], 300, 'owner/project');
  engine.submissionObserver = null;
  return engine;
}
/** Call one shipped executor route as the coordinator would over HTTP. */
let requestKey = 0;
async function route(engine: object, method: string, path: string, body: unknown = {}) {
  const url = new URL(`https://graphyard.example${path}`);
  for (const candidate of actionRoutes.routes) {
    const params = matchRoute(candidate, method, url.pathname);
    if (!params) continue;
    const context = { actor: coordinatorActor, url, services: { engine }, operatorVisible: (work: Work[]) => work, body: async () => Buffer.from(JSON.stringify(body)), idempotencyKey: () => `presence-${++requestKey}` } as unknown as RouteContext;
    return await candidate.handle(context, params) as any;
  }
  throw new Error(`no route ${method} ${path}`);
}
const ledgerCounts = async (store: Store) => (await store.pool.query('SELECT (SELECT count(*)::int FROM events) AS events, (SELECT count(*)::int FROM receipts) AS receipts')).rows[0] as { events: number; receipts: number };
/** GY-1288's pending rows, aged as the 09:43:15 instances name their waits, relative to `read`. */
function switchoverQueue(read: number) {
  const ago = (ms: number) => new Date(read - ms).toISOString();
  return [
    item('GY-1287', [row('7'.repeat(32), 'GY-1287', 'dispatch', ago(135_000))]), item('GY-1285', [row('5'.repeat(32), 'GY-1285', 'dispatch', ago(75_000))]),
    item('GY-1286', [row('6'.repeat(32), 'GY-1286', 'approve-scope', ago(125_000))]),
    item('GY-1238', [row('8'.repeat(32), 'GY-1238', 'request-review', ago(75_000))]), item('GY-1236', [row('9'.repeat(32), 'GY-1236', 'request-review', ago(45_000))]),
  ];
}
const configurationFaults = (report: ReturnType<typeof executorReport>) =>
  classifyAttention(describeUnserved(report).map(entry => ({ subject: entry.keys[0], text: entry.text }))).filter(fault => fault.faultClass === 'configuration');

/**
 * The switchover: the fleet polls the old process, which is replaced; the new one has been up longer
 * than its birth grace (the deploy's request storm kept every poll off it) when the loop reads, 34s
 * after the fleet's last poll. Returns the new process and the instant of the read.
 */
async function switchover(store: Store) {
  const old = servingProcess(store);
  for (const n of [1, 2]) await route(old, 'POST', '/api/actions/claim', { executor: fleetSlot(n), host: 'vishrog', kinds: fleetKinds });
  const replacement = servingProcess(store);
  Object.assign(executorRegistry(replacement), { since: new Date(Date.now() - 10 * 60_000) });
  return { replacement, read: Date.now() + 34_000 };
}

test('unit:executor-presence-outlives-restart — a control plane replaced between two claim polls reads the fleet live on its first actions read; its in-memory view alone reports "no executor is alive"', async () => {
  const store = await presenceStore();
  const { replacement, read } = await switchover(store);
  // Its first read through the shipped route: the fleet that polled the old process is live.
  const answer = await route(replacement, 'GET', '/api/actions');
  assert.deepEqual(answer.executors.live.map((entry: any) => entry.executor).sort(), [fleetSlot(1), fleetSlot(2)]);
  assert.deepEqual(answer.executors.served, [...fleetKinds].sort());
  assert.equal(answer.executors.listening, undefined);
  // The same read 34s later over GY-1288's queue: nothing is unserved.
  const now = new Date(read);
  const candidate = executorReport(switchoverQueue(read), executorRegistry(replacement), now, undefined, null, await durablePresence(presenceQuery(replacement)));
  assert.deepEqual(candidate.unserved, []);
  assert.deepEqual(describeUnserved(candidate), []);
  // The base: what the replaced process heard in memory, past its birth grace — a live fleet reported dead.
  const base = executorReport(switchoverQueue(read), executorRegistry(replacement), now);
  assert.deepEqual(base.live, []);
  assert.ok(describeUnserved(base).length > 0 && describeUnserved(base).every(entry => entry.text.includes('no executor is alive')));
});

test('unit:executor-presence-idle-poll-no-event — a claim poll that takes no action refreshes durable presence and appends no event row or receipt', async () => {
  const store = await presenceStore();
  const engine = servingProcess(store);
  const before = await ledgerCounts(store);
  const first = await route(engine, 'POST', '/api/actions/claim', { executor: fleetSlot(1), host: 'vishrog', kinds: fleetKinds });
  assert.equal(first.action, null, 'nothing to claim: an idle poll');
  const recorded = await durablePresence(presenceQuery(engine));
  assert.deepEqual(recorded?.map(entry => [entry.principal, entry.executor, entry.host, entry.kinds, entry.claims]), [[coordinatorActor.id, fleetSlot(1), 'vishrog', fleetKinds, 0]]);
  await delay(5);
  const second = await route(engine, 'POST', '/api/actions/claim', { executor: fleetSlot(1), host: 'vishrog', kinds: fleetKinds });
  assert.equal(second.action, null);
  const refreshed = await durablePresence(presenceQuery(engine));
  assert.equal(refreshed?.length, 1, 'one row per executor, overwritten by each poll');
  assert.ok(Date.parse(refreshed![0].seenAt) > Date.parse(recorded![0].seenAt), 'the second poll moved the executor\'s seenAt forward');
  // A presence-only poll (a fenced executor) is the same upsert.
  await route(engine, 'POST', '/api/actions/presence', { executor: fleetSlot(2), host: 'vishrog', kinds: ['dispatch'] });
  assert.equal((await durablePresence(presenceQuery(engine)))?.length, 2);
  assert.deepEqual(await ledgerCounts(store), before, 'no event row and no receipt for any poll that claimed nothing (GY-185)');
});

test('unit:executor-presence-renewal-live — an executor renewing its claim inside a handler longer than 120s stays live, on this process and a replaced one', async () => {
  const store = await presenceStore();
  const running = row('d'.repeat(32), 'GY-1126', 'dispatch', new Date().toISOString(), { state: 'claimed', claim: { executor: fleetSlot(1), host: 'vishrog', principal: coordinatorActor.id } as ActionRow['claim'] });
  // The engine's queue is a stub here (presence is judged beside it); the presence table is the real one.
  const serving = () => ({ store, claimNextAction: async () => ({ action: running, open: 0, at: new Date().toISOString() }), renewClaimedAction: async (_actor: Principal, id: string) => { assert.equal(id, running.id); return { action: running }; } });
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const engine = serving();
    const start = Date.now();
    await route(engine, 'POST', '/api/actions/claim', { executor: fleetSlot(1), host: 'vishrog', kinds: fleetKinds });
    // Inside the handler for 180s, renewing every 30s and polling nothing.
    for (let elapsed = 30_000; elapsed <= 180_000; elapsed += 30_000) {
      mock.timers.setTime(start + elapsed);
      await route(engine, 'POST', `/api/actions/${running.id}/renew`, {});
    }
    mock.timers.setTime(start + 190_000);
    const now = new Date();
    const queue = [item('GY-1300', [row('3'.repeat(32), 'GY-1300', 'request-review', new Date(start).toISOString())])];
    const durable = await durablePresence(presenceQuery(engine));
    const here = executorReport(queue, executorRegistry(engine), now, undefined, null, durable);
    assert.deepEqual(here.live.map(entry => entry.executor), [fleetSlot(1)], 'live 190s into one action');
    assert.deepEqual(here.unserved, [], 'it still serves every kind it polled with');
    // A process replaced mid-handler hears only renewals, yet the durable row keeps every kind the poll named.
    const replaced = serving();
    await route(replaced, 'POST', `/api/actions/${running.id}/renew`, {});
    const afterRestart = executorReport(queue, executorRegistry(replaced), new Date(), undefined, null, await durablePresence(presenceQuery(replaced)));
    assert.deepEqual(afterRestart.live.map(entry => [entry.executor, entry.kinds.length]), [[fleetSlot(1), fleetKinds.length]]);
    assert.deepEqual(afterRestart.unserved, []);
    // Without the renewals the same executor would have lapsed: the window is still 120s.
    assert.equal(durable![0].seenAt, new Date(start + 180_000).toISOString());
    assert.deepEqual(executorReport(queue, new ExecutorRegistry(new Date(start)), now, undefined, null, [{ ...durable![0], seenAt: new Date(start).toISOString() }]).live, []);
  } finally { mock.timers.reset(); }
});

test('unit:executor-listening-keyed-to-evidence — an empty fleet is judged once a poll was heard or durable presence was read, never on how long the process has been up', () => {
  const now = new Date(clock);
  const work = [item('GY-1301', [row('1'.repeat(32), 'GY-1301', 'dispatch', iso(-180_000))])];
  const stale = [{ executor: fleetSlot(1), host: 'vishrog', principal: coordinatorActor.id, kinds: fleetKinds, seenAt: iso(-executorLiveMs - 1), claims: 3 }];
  // A process born this instant that reads durable presence older than one window judges at once.
  const young = executorReport(work, new ExecutorRegistry(now), now, undefined, null, stale);
  assert.equal(young.listening, undefined);
  assert.deepEqual(young.unserved.map(entry => entry.key), ['GY-1301']);
  // An empty durable reading is evidence too: nothing durable heard from inside the window.
  assert.deepEqual(executorReport(work, new ExecutorRegistry(now), now, undefined, null, []).unserved.map(entry => entry.key), ['GY-1301']);
  // A process up for an hour that has heard nothing and cannot read durable presence judges nothing.
  const old = executorReport(work, new ExecutorRegistry(new Date(clock - 3_600_000)), now, undefined, null, null);
  assert.equal(old.listening, true);
  assert.deepEqual(old.unserved, []);
  // A poll heard and lapsed is evidence, whatever the durable reading.
  const heard = new ExecutorRegistry(new Date(clock - 3_600_000));
  heard.observe({ executor: fleetSlot(1), host: 'vishrog', principal: coordinatorActor.id, kinds: fleetKinds }, new Date(clock - executorLiveMs - 1));
  assert.deepEqual(executorReport(work, heard, now, undefined, null, null).unserved.map(entry => entry.key), ['GY-1301']);
  // And durable presence inside the window is live, however young or unheard the process.
  const fresh = [{ ...stale[0], seenAt: iso(-1000) }];
  const live = executorReport(work, new ExecutorRegistry(now), now, undefined, null, fresh);
  assert.deepEqual([live.live.map(entry => entry.executor), live.unserved, live.listening], [[fleetSlot(1)], [], undefined]);
});

const switchoverInstances = [
  { subject: 'GY-1287', kind: 'dispatch', text: 'Nothing can run dispatch: GY-1287 has waited 2m and 1 more for an executor that serves it, and no executor is alive.' },
  { subject: 'GY-1286', kind: 'approve-scope', text: 'Nothing can run approve-scope: GY-1286 has waited 2m for an executor that serves it, and no executor is alive.' },
  { subject: 'GY-1238', kind: 'request-review', text: 'Nothing can run request-review: GY-1238 has waited 1m and 1 more for an executor that serves it, and no executor is alive.' },
];
for (const instance of switchoverInstances) {
  test(`manual:fault-class-configuration — GY-1288 via GY-1289, ${instance.kind} on ${instance.subject} at 2026-10-05T09:43:15.274Z: a serving-process replacement between durable claims and the loop's read no longer reports a live fleet dead`, async () => {
    const store = await presenceStore();
    const { replacement, read } = await switchover(store);
    const now = new Date(read);
    // The base: the replaced process judges from memory alone and files the instance word for word.
    const reproduced = configurationFaults(executorReport(switchoverQueue(read), executorRegistry(replacement), now)).find(fault => fault.subject === instance.subject);
    assert.ok(reproduced, `${instance.subject} reproduces on the base`);
    assert.ok(reproduced.text.startsWith(instance.text), reproduced.text);
    assert.equal(reproduced.kind, 'executor');
    // The candidate: the same read with the durable presence the fleet left before the replacement.
    const candidate = executorReport(switchoverQueue(read), executorRegistry(replacement), now, undefined, null, await durablePresence(presenceQuery(replacement)));
    assert.equal(configurationFaults(candidate).find(fault => fault.subject === instance.subject), undefined, `${instance.subject} does not recur`);
    // A fleet that really stopped is still named once the window passes.
    const silent = executorReport(switchoverQueue(read + executorLiveMs), executorRegistry(replacement), new Date(read + executorLiveMs), undefined, null, await durablePresence(presenceQuery(replacement)));
    assert.ok(configurationFaults(silent).some(fault => fault.subject === instance.subject), 'a fleet silent past the window is still reported');
  });
}
