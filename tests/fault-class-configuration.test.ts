import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { deploymentObservationSchema, emptyDaemonState, noteWatchdog, watchdogPlan, type DaemonState } from '../src/master-daemon.js';
import { awaitSupervisorRestart, performSelfUpgrade, restartEndedBySupervisorStop } from '../src/daemon/upgrade.js';
import { ChildProcessError } from '../src/child-runner.js';
import { alignLoopUnit, loopUnitName, loopUnitText, loopWatchdogSeconds } from '../src/supervisor.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-916: the loop filed configuration faults against its own installation without reading the
 * installation state it already holds. Each test is named for the proof it produces:
 * unit:upgrade-self-restart-survives-supervisor-stop and unit:upgrade-self-restart-failure-still-recorded
 * (AC-2), unit:alignment-reapplies-supervisor-unit and unit:watchdog-refusal-clears-on-reapplied-unit (AC-4).
 * The executor fleet's cases (AC-1, AC-3) went with the fleet (GY-1984).
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
// The 2030-01-01 clock and the iso() offsets from it are handed explicitly as now to performSelfUpgrade and noteWatchdog.
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
        restartSelf: async () => { throw failure; } });
      assert.equal(upgraded.outcome, 'failed');
      assert.match(upgraded.outcome === 'failed' ? upgraded.reason : '', /could not re-execute itself through its supervisor/);
      const failed = failedActions(state);
      assert.equal(failed.length, 1);
      assert.deepEqual([failed[0][0], failed[0][1].kind, failed[0][1].faultClass], [`upgrade:${hex('b')}`, 'config', 'configuration']);
      assert.equal(state.upgrade.last?.self, false);
    }
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
      alignUnit: async () => { order.push('unit'); return alignLoopUnit(unit.input, unit.host); },
      restartSelf: async () => { order.push('self'); } });
    assert.equal(upgraded.outcome, 'upgraded');
    assert.deepEqual(order, ['unit', 'self'], 'the unit is re-applied before the loop re-executes through it');
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

// Instances 3-4 were recorded by the release before GY-1761 (PR #1167's merge), whose classifier read the recorded master-role refusal as a genuine blocker and a setup fault for the operator.
const servingRelease = '7eefa971614153c714fb46c6dcc4512ad4d36b8c';
const gy1674Recorded = "Blocked command: graphyard master status in this worktree, error: '.graphyard/master.json does not exist: run graphyard install --apply'. The worker token holds no master role, so the checkout-restore cannot be issued or observed from here.";
const gy1696Recorded = "blocked on epoch 2: AC-1 is a live observation that only a master-role session can record. Blocked command: graphyard master status in this worktree (GY-1696-2), error: '.graphyard/master.json does not exist: run graphyard install --apply, or graphyard master init --token-stdin'.";
for (const [key, recorded] of [['GY-1674', gy1674Recorded], ['GY-1696', gy1696Recorded]] as const) {
  test(`manual:fault-class-configuration — setup|${key}|2026-10-13T07:39:48.821Z: the serving release left its recorded master-role refusal to the operator; the candidate hands the step to a master-role identity`, async () => {
    const { importAt } = await import('./helpers/base-tree.js');
    const base = await importAt(servingRelease, 'src/model/blocker-class.ts');
    const baseKind = await importAt(servingRelease, 'src/model/blocker-kind.ts');
    const { classifyBlocker } = await import('../src/model/blocker-class.js');
    const { blockerKind } = await import('../src/model/blocker-kind.js');
    assert.equal(base.classifyBlocker(recorded).class, 'genuine', 'the serving release did not recognise the refusal: it stood as a blocker for the master to read');
    assert.equal(base.needsSomeone(base.classifyBlocker(recorded).class), true);
    assert.equal(classifyBlocker(recorded).class, 'master-role', 'the candidate classes it as the master-role step');
    assert.equal(blockerKind(recorded), 'setup');
    assert.notEqual(baseKind.blockerKind(recorded), blockerKind(recorded), 'the fault kind it is filed under changed with the classifier');
  });
}
