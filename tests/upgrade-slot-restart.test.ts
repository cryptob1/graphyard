import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { executorsCommand } from '../src/cli/master-executors.js';
import * as fleet_ from '../src/executor-fleet.js';
import { executorRegistrar, readExecutorRegistrations, readRestartFence, restartExecutors, writeExecutorRegistration, type ExecutorRegistration, type ExecutorRestartResult } from '../src/executor-fleet.js';
import { performSelfUpgrade } from '../src/daemon/upgrade.js';
import { deploymentObservationSchema, emptyDaemonState } from '../src/master-daemon.js';
import * as report_ from '../src/cli/executor-report.js';
import { executorFleet } from '../src/cli/executor-report.js';
import { writeExecutorDeclaration, type SystemctlRunner } from '../src/repository-setup.js';
import { ExecutorRegistry, executorReport } from '../src/model/executor-presence.js';
import { attentionKind } from '../src/model/fault-classes.js';
import type { Work } from '../src/model.js';
import type { ActionRow } from '../src/model/actions.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1432: each code-moving self-upgrade left both executor slots inactive for minutes. The slots
 * had already stood down and restarted themselves onto the new commit, and the upgrade's fleet
 * restart stopped them again; the report then named the outage as a fleet lacking capacity and
 * paged the operator mid-upgrade. Each test is named for the proof it produces:
 * unit:fleet-restart-skips-current-release, integration:upgrade-slots-claim-within-poll,
 * unit:slots-down-distinct-from-no-capacity and unit:slot-down-past-bound-pages-operator.
 *
 * The supervisor is a stub: told to restart a unit, it records the slot down, and a moment later
 * registers the unit's new process on the checkout's commit, as a restarted executor does.
 */

// Reached through their modules, so this file loads on a base without them and each case fails on its own.
const runsRelease: typeof fleet_.runsRelease = (...args) => fleet_.runsRelease(...args);
const slotPaged: typeof report_.slotPaged = slot => report_.slotPaged(slot);
const slotUpgradeBoundMs = () => report_.slotUpgradeBoundMs ?? 120_000;

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const hex = (letter: string) => letter.repeat(40);
const loaded = hex('a'), target = hex('b');

async function fixture() {
  const directory = await temporaryDirectory('upgrade-slot-restart');
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  return { master, dispose: () => rm(directory, { recursive: true, force: true }) };
}
const unit = (slot: number) => `graphyard-executor@${slot}.service`;
const record = (master: MasterConfig, slot: number, commit: string, overrides: Partial<ExecutorRegistration> = {}): ExecutorRegistration => ({
  version: 1, name: `graphyard-master@host-a/${slot}`, host: master.hostId, pid: process.pid, principal: 'graphyard-master', kinds: ['dispatch'], intervalSeconds: 5, root: '/srv/graphyard',
  release: { commit, dirty: false }, supervisor: { unit: unit(slot), restart: `systemctl --user restart ${unit(slot)}` },
  state: 'running', standDown: null, startedAt: new Date(Date.now() - 60_000).toISOString(), updatedAt: new Date().toISOString(), stoppedAt: null, claims: 0, lastClaim: null, inFlight: null, claiming: null, interrupted: null, ...overrides });
const idle = async () => ({ queue: { executors: [] }, actions: [] });

/** A supervisor stub that restarts a unit in `restartMs`, recording when each slot went down and came back. */
function supervisor(master: MasterConfig, commit: string, restartMs = 40) {
  const calls: string[][] = [], down = new Map<string, number>(), back = new Map<string, number>();
  let pid = process.pid + 100;
  const run = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command === 'systemctl' && args[1] === 'restart') {
      const name = args[2];
      down.set(name, Date.now());
      const slot = Number(/@(\d+)\.service$/.exec(name)![1]);
      void delay(restartMs).then(async () => {
        await executorRegistrar(master, { name: `graphyard-master@host-a/${slot}`, host: master.hostId, pid: ++pid, principal: 'graphyard-master', kinds: ['dispatch'], intervalSeconds: 5, root: '/srv/graphyard', release: { commit, dirty: false }, supervisor: name }, Date.now, () => true).started();
        back.set(name, Date.now());
      });
    }
    return '';
  };
  return { run, calls, down, back };
}
const quick = { sleep: (ms: number) => delay(Math.min(ms, 10)).then(() => {}), timeoutMs: 2_000, pollMs: 10 };

test('unit:fleet-restart-skips-current-release — master executors restart leaves a slot already on the coordinator\'s commit running, restarts only the stale one, and is not held by a claim the current slot holds', async () => {
  const { master, dispose } = await fixture();
  const exitCode = process.exitCode;
  try {
    // Slot 1 stood down and restarted itself onto the target; slot 2 still runs the loaded commit.
    await writeExecutorRegistration(master, record(master, 1, target, { inFlight: { id: 'a1', key: 'GY-1416', kind: 'dispatch', since: new Date().toISOString() } }));
    await writeExecutorRegistration(master, record(master, 2, loaded));
    const stub = supervisor(master, target);
    const outcome = await executorsCommand(master, ['restart', '--timeout', '5'], { actions: idle, coordinatorCommit: target, run: stub.run, sleep: quick.sleep, alive: () => true }) as ExecutorRestartResult & { host: string };
    assert.equal(outcome.result, 'restarted', outcome.reason ?? '');
    assert.deepEqual(stub.calls, [['systemctl', '--user', 'restart', unit(2)]], 'only the stale slot is stopped and started');
    assert.deepEqual(outcome.current, [{ name: 'graphyard-master@host-a/1', unit: unit(1), commit: target }]);
    assert.deepEqual(outcome.restarted.map(entry => ({ unit: entry.unit, registered: entry.registered, after: entry.release.after?.commit })), [{ unit: unit(2), registered: true, after: target }]);

    // Every slot already current: nothing is stopped at all.
    stub.calls.length = 0;
    const none = await executorsCommand(master, ['restart', '--timeout', '5'], { actions: idle, coordinatorCommit: target, run: stub.run, sleep: quick.sleep, alive: () => true }) as ExecutorRestartResult;
    assert.equal(none.result, 'restarted');
    assert.match(none.reason!, /already runs bbbbbbbbbbbb: graphyard-master@host-a\/1, graphyard-master@host-a\/2; none was restarted/);
    assert.deepEqual(stub.calls, []);

    // --all restarts every slot, the current ones included; the current slot's claim then holds it.
    const all = await restartExecutors(master, { actions: idle, coordinatorCommit: target, run: stub.run, sleep: quick.sleep, timeoutMs: 50, alive: () => true });
    assert.equal(all.result, 'refused');
    assert.match(all.reason!, /holds dispatch for GY-1416/);
    await writeExecutorRegistration(master, record(master, 1, target));
    stub.calls.length = 0;
    const forced = await executorsCommand(master, ['restart', '--timeout', '5', '--all'], { actions: idle, coordinatorCommit: target, run: stub.run, sleep: quick.sleep, alive: () => true }) as ExecutorRestartResult;
    assert.equal(forced.result, 'restarted', forced.reason ?? '');
    assert.deepEqual(stub.calls.map(call => call[3]).sort(), [unit(1), unit(2)]);
    // A dead process on the target commit is no running slot: it is not skipped as current.
    const onTarget = record(master, 1, target);
    assert.deepEqual([runsRelease(onTarget, target, () => true), runsRelease(onTarget, target, () => false), runsRelease({ ...onTarget, state: 'standing-down' }, target, () => true), runsRelease(onTarget, null, () => true)], [true, false, false, false]);

    // A slot loaded from a dirty checkout on the target commit refuses every claim until restarted
    // after the checkout is cleaned (GY-857): it is not current, and the default restart restarts it.
    assert.equal(runsRelease({ ...onTarget, release: { commit: target, dirty: true } }, target, () => true), false);
    assert.equal(runsRelease({ ...onTarget, release: { commit: target, dirty: null } }, target, () => true), false);
    await writeExecutorRegistration(master, record(master, 1, target, { release: { commit: target, dirty: true } }));
    await writeExecutorRegistration(master, record(master, 2, target));
    stub.calls.length = 0;
    const dirty = await executorsCommand(master, ['restart', '--timeout', '5'], { actions: idle, coordinatorCommit: target, run: stub.run, sleep: quick.sleep, alive: () => true }) as ExecutorRestartResult;
    assert.equal(dirty.result, 'restarted', dirty.reason ?? '');
    assert.deepEqual(stub.calls, [['systemctl', '--user', 'restart', unit(1)]], 'the dirty-loaded slot is restarted; the clean current one is left running');
    assert.deepEqual(dirty.current?.map(entry => entry.unit), [unit(2)]);
  } finally { process.exitCode = exitCode; await dispose(); }
});

/** Fake git for the upgrade: a detached checkout at `head` and the base branch at `tip`. */
const fakeGit = (state: { head: string; tip: string }) => async (command: string, args: string[]) => {
  const op = args[2];
  if (op === 'rev-parse') return `${args[3] === 'HEAD' ? state.head : state.tip}\n`;
  if (op === 'symbolic-ref') throw Object.assign(new Error('not a symbolic ref'), { status: 1 });
  if (op === 'status' || op === 'fetch') return '';
  if (op === 'diff') return 'src/daemon/run.ts\n';
  if (op === 'checkout') { state.head = args[5]; return ''; }
  throw new Error(`fake git cannot answer: ${command} ${args.join(' ')}`);
};

test('integration:upgrade-slots-claim-within-poll — across a code-moving upgrade each slot is down no longer than its own unit restart, slots already on the target are not stopped again, and a dispatch row is claimed within one executor poll of the slots returning', async () => {
  const { master, dispose } = await fixture();
  const executorPollMs = 200;
  try {
    const upgrade = async (records: ExecutorRegistration[]) => {
      for (const entry of await readExecutorRegistrations(master)) await writeExecutorRegistration(master, { ...entry, state: 'stopped' });
      for (const entry of records) await writeExecutorRegistration(master, entry);
      const stub = supervisor(master, target);
      const state = emptyDaemonState(master);
      state.deployment = deploymentObservationSchema.parse({ source: 'endpoint', sha: target, at: new Date().toISOString(), reason: null, deployed: ['GY-1'], pending: [] });
      let returnedAt = 0, selfAt = 0;
      const outcome = await performSelfUpgrade(master, state, {
        root: '/srv/graphyard', run: fakeGit({ head: loaded, tip: target }),
        // The shipped wiring (daemon/effects.ts): the fleet restart against the checked-out tip, leaving current slots running.
        restartExecutors: async to => { const result = await restartExecutors(master, { actions: idle, coordinatorCommit: to, run: stub.run, ...quick, alive: () => true, skipCurrent: true }); returnedAt = Date.now(); return result; },
        restartSelf: async () => { selfAt = Date.now(); },
      });
      return { outcome, stub, returnedAt, selfAt };
    };

    // Both slots stood down and restarted themselves onto the target before the pass: neither is stopped again.
    const settled = await upgrade([record(master, 1, target), record(master, 2, target)]);
    assert.equal(settled.outcome.outcome, 'upgraded');
    assert.deepEqual(settled.stub.calls, [], 'no slot that already runs the target is stopped and started again');
    assert.match(settled.outcome.outcome === 'upgraded' ? settled.outcome.executors?.reason ?? '' : '', /already runs bbbbbbbbbbbb: .*none was restarted/);
    assert.ok(settled.selfAt > 0, 'the loop still re-executes itself');

    // One slot still on the loaded commit: the fleet restart runs, each slot is down only for its
    // own restart, and every slot is back before the loop's own restart is even asked for.
    const moving = await upgrade([record(master, 1, target), record(master, 2, loaded)]);
    assert.equal(moving.outcome.outcome, 'upgraded');
    assert.deepEqual(moving.stub.calls, [['systemctl', '--user', 'restart', unit(2)]], 'only the stale slot is restarted; slot 1 is never inactive');
    assert.ok(moving.returnedAt <= moving.selfAt, 'the fleet restart returned before the loop asked for its own');
    for (const [name, wentDown] of moving.stub.down) {
      const cameBack = moving.stub.back.get(name)!;
      assert.ok(cameBack - wentDown < 1_000, `${name} was down ${cameBack - wentDown}ms: its own restart, seconds at most`);
      assert.ok(cameBack <= moving.selfAt, `${name} came back before the loop restarted itself`);
    }
    assert.equal(await readRestartFence(master), null, 'the fence is lowered as the fleet returns');

    // A dispatch row pending meanwhile is claimed at the next poll of a returned slot.
    const returned = Math.max(...moving.stub.back.values());
    const row: Pick<ActionRow, 'kind' | 'key'> = { kind: 'dispatch', key: 'GY-1427' };
    let claimedAt = 0;
    for (let at = returned; !claimedAt; at += executorPollMs) {
      await delay(Math.max(0, at - Date.now()));
      if (!(await readRestartFence(master))) claimedAt = Date.now();
    }
    assert.ok(claimedAt - returned <= executorPollMs + 50, `${row.kind} for ${row.key} was claimed ${claimedAt - returned}ms after the slots returned, within one ${executorPollMs}ms poll`);
  } finally { await dispose(); }
});

/** A coordinator host that declared two slots, each in `states`, down since `downFor` ms before now. */
async function declaredHost(states: [string, string], downFor: number | null) {
  const root = await temporaryDirectory('upgrade-slot-host');
  execFileSync('git', ['init', '-q', root]);
  await mkdir(join(root, '.graphyard'), { recursive: true, mode: 0o700 });
  await writeExecutorDeclaration(root, { version: 1, count: 2, kinds: null, intervalSeconds: 5 });
  const run: SystemctlRunner = args => {
    const slot = Number(/@(\d+)/.exec(args[1] ?? '')?.[1] ?? 0);
    if (args[0] === 'is-active') { const state = states[slot - 1]; if (state === 'active') return 'active'; throw Object.assign(new Error(state), { stdout: `${state}\n` }); }
    // systemd dates the stop by this host's clock, whatever the control plane's `now` reads.
    if (args[0] === 'show') return downFor === null ? '' : `@${((Date.now() - downFor) / 1000).toFixed(6)}`;
    return '';
  };
  return { root, run };
}
const pendingDispatch = (key: string, requestedAt: string): Work => ({ id: `work-${key}`, key, actionQueue: { actions: [{ id: `row-${key}`, kind: 'dispatch', work: `work-${key}`, key, inputs: { kind: 'dispatch' }, gate: 'build',
  refusal: null, reason: 'ready', binding: 'dispatch:0', requestedBy: 'graphyard', requestedAt, state: 'pending', claim: null, attempts: 0, history: [] }], history: [] } } as unknown as Work);

test('unit:slots-down-distinct-from-no-capacity — the fleet report names slots down apart from a fleet without capacity, and raises nothing while a slot is mid-upgrade', async () => {
  const now = Date.parse('2026-10-07T06:53:24.013Z');
  const work = [pendingDispatch('GY-1416', new Date(now - 29 * 60_000).toISOString())];
  // Nobody polled for a window: the control plane names dispatch unserved.
  const report = executorReport(work, new ExecutorRegistry(new Date(now - 3_600_000)), new Date(now));
  assert.equal(report.unserved[0]?.kind, 'dispatch');
  const fleet = async (states: [string, string], downFor: number | null) => {
    const { root, run } = await declaredHost(states, downFor);
    try { return await executorFleet(root, async () => ({ executors: report }), { work, now: new Date(now).toISOString() }, run, async () => null); }
    finally { await rm(root, { recursive: true, force: true }); }
  };

  // Every declared slot runs and none serves it: no capacity, with the generic remedy.
  const capacity = await fleet(['active', 'active'], null);
  assert.equal(capacity.capacity, 'no-capacity');
  assert.match(capacity.attention[0].text, /^Nothing can run dispatch: GY-1416 has waited 29m .*no executor is alive/);
  assert.deepEqual(capacity.slots.map(slot => slot.active), ['active', 'active']);

  // The slots are stopped past the bound: slots down, not capacity, and the remedy is to start them.
  const down = await fleet(['inactive', 'inactive'], 5 * 60_000);
  assert.equal(down.capacity, 'slots-down');
  const line = down.attention.find(item => item.subject === 'GY-1416')!;
  assert.match(line.text, /^Nothing can run dispatch: GY-1416 has waited 29m .* This host's executor slots are down, not saturated: graphyard-executor@1\.service inactive for 5m, past the 2m upgrade bound, graphyard-executor@2\.service inactive for 5m/);
  assert.equal(line.next, `systemctl --user start ${unit(1)} ${unit(2)}`);
  assert.equal(attentionKind({ subject: line.subject, text: line.text }), 'executor', 'still an executor fault for the fault classes');

  // Mid-upgrade — stopped seconds ago, inside the bound — raises neither line.
  const restarting = await fleet(['inactive', 'inactive'], 8_000);
  assert.equal(restarting.capacity, 'restarting');
  assert.deepEqual(restarting.attention, [], 'a slot inside its restart is neither slots down nor no capacity');
  assert.deepEqual(restarting.slots.map(slot => ({ unit: slot.unit, paged: slotPaged(slot) })), [{ unit: unit(1), paged: false }, { unit: unit(2), paged: false }]);
  for (const slot of restarting.slots) assert.ok(slot.downMs! >= 8_000 && slot.downMs! < 9_000, `${slot.unit} down ${slot.downMs}ms by the host clock`);
});

test('unit:slot-down-past-bound-pages-operator — a declared slot inactive past the upgrade bound raises the start attention naming its unit; inside the bound, and while stopping, it raises nothing', async () => {
  const now = Date.parse('2026-10-07T06:53:24.013Z');
  const registry = new ExecutorRegistry(new Date(now - 3_600_000));
  registry.observe({ executor: 'graphyard-master@vishrog/2', host: 'vishrog', principal: 'graphyard-master', kinds: ['dispatch'] }, new Date(now));
  const report = executorReport([], registry, new Date(now));
  const slotLines = async (states: [string, string], downFor: number | null, snapshotNow = now) => {
    const { root, run } = await declaredHost(states, downFor);
    try { return (await executorFleet(root, async () => ({ executors: report }), { work: [], now: new Date(snapshotNow).toISOString() }, run, async () => null)).attention.filter(item => /^Executor slot \d is /.test(item.text)); }
    finally { await rm(root, { recursive: true, force: true }); }
  };
  const past = await slotLines(['inactive', 'active'], slotUpgradeBoundMs() + 1_000);
  assert.equal(past.length, 1);
  assert.match(past[0].text, /^Executor slot 1 is inactive for 2m, past the 2m upgrade bound although this host declares 2 slot\(s\); journalctl --user -u graphyard-executor@1\.service -n 200 says why/);
  assert.ok(past[0].next.startsWith(`systemctl --user start ${unit(1)} `), 'the operator-paged start attention names the unit');
  assert.equal(past[0].role, 'master');
  assert.deepEqual(await slotLines(['inactive', 'active'], slotUpgradeBoundMs() - 1_000), [], 'inside the bound the slot is mid-upgrade');
  assert.deepEqual(await slotLines(['deactivating', 'active'], null), [], 'a stopping slot is a restart in passage');
  // A failed slot, or one systemd cannot date, is no upgrade: it is named at once.
  assert.equal((await slotLines(['failed', 'active'], 1_000)).length, 1);
  assert.equal((await slotLines(['inactive', 'active'], null)).length, 1);
  // The control plane's clock skewed five minutes either way from the host's moves neither verdict:
  // the bound is measured on the host clock systemd dated the stop with.
  for (const skew of [5 * 60_000, -5 * 60_000]) {
    assert.deepEqual(await slotLines(['inactive', 'active'], 8_000, Date.now() + skew), [], `a mid-upgrade slot raises nothing with the control plane ${skew}ms off`);
    assert.equal((await slotLines(['inactive', 'active'], slotUpgradeBoundMs() + 1_000, Date.now() + skew)).length, 1, `a slot past the bound pages with the control plane ${skew}ms off`);
  }
});
