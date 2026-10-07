import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as report_ from '../src/cli/executor-report.js';
import * as executor_ from '../src/executor.js';
import { controlPlaneHandlers, type ControlPlaneEffects } from '../src/executor.js';
import { runExecutorTick } from '../src/auto-dispatch.js';
import { masterConfigSchema, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { classifyAttention } from '../src/model/fault-classes.js';
import { executorUnit, writeExecutorDeclaration, type SystemctlRunner } from '../src/repository-setup.js';
import type { ActionRow } from '../src/model/actions.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Reached through their modules, so this file loads on a base without them and each case fails on its own.
const { executorFleet } = report_;
const executorSlotFaults: typeof report_.executorSlotFaults = (...args) => report_.executorSlotFaults(...args);
const unitRestartPolicy: typeof executor_.unitRestartPolicy = unit => executor_.unitRestartPolicy(unit);
const workerStartFence: typeof executor_.workerStartFence = (...args) => executor_.workerStartFence(...args);
const workerStartFenceBoundMs = () => executor_.workerStartFenceBoundMs;

// GY-1431: on 2026-10-07 both executor slots of the coordinator host lay inactive from 06:53:24Z
// while three dispatches were requested and none ran; GY-1416 and GY-1427 idled claimable for
// half an hour. The slot health is now a resources fault that pages until the unit is active again,
// a fenced worker start is retried once its fence lapses, and the installed unit must restart a
// crashed slot by itself.

const root = fileURLToPath(new URL('..', import.meta.url));
const host = 'vishrog';
const observedAt = '2026-10-07T06:53:24.013Z';

/** systemd as the host answered it: `is-active` exits non-zero with the state on stdout for anything but active. */
function systemd(states: Record<string, string>, manager = true): SystemctlRunner {
  return args => {
    if (args[0] === 'show-environment') { if (!manager) throw new Error('Failed to connect to bus: No medium found'); return 'HOME=/home/vish'; }
    if (args[0] === 'is-active') {
      const state = states[args[1]] ?? 'inactive';
      if (state === 'active') return 'active';
      throw Object.assign(new Error(state), { stdout: `${state}\n` });
    }
    return '';
  };
}
/** The control plane's executor report at the replayed moment: nobody live, two dispatches unserved. */
const report = (live: { executor: string; host: string }[] = []) => async (path: string) => {
  assert.equal(path, 'actions');
  return { executors: { live: live.map(entry => ({ ...entry, principal: 'graphyard-master', kinds: ['dispatch'], seenAt: observedAt, claims: 0 })), liveMs: 120_000,
    served: live.length ? ['dispatch'] : [], loop: null,
    unserved: live.length ? [] : [
      { kind: 'dispatch', key: 'GY-1416', work: 'id-1416', since: '2026-10-07T06:37:00.000Z', waitedMs: 1_740_000, start: 'start an executor that serves dispatch' },
      { kind: 'dispatch', key: 'GY-1427', work: 'id-1427', since: '2026-10-07T06:38:00.000Z', waitedMs: 1_680_000, start: 'start an executor that serves dispatch' },
    ] } };
};

let checkout: string;
async function declaredHost() {
  checkout ??= await (async () => {
    const dir = await temporaryDirectory('slot-health');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    await mkdir(join(dir, '.graphyard'), { mode: 0o700 });
    await writeExecutorDeclaration(dir, { version: 1, count: 2, kinds: null, intervalSeconds: 5 });
    return dir;
  })();
  return checkout;
}

test('integration:executor-slot-fault — the 06:53:24Z two-slot inactivity raises one resources fault per declared slot naming its unit and journalctl, which stands until that unit is observed active again', async () => {
  const dir = await declaredHost();
  const snapshot = { work: [] as Work[], now: observedAt };
  const slotFaults = async (states: Record<string, string>, live: { executor: string; host: string }[] = [], manager = true) => {
    const fleet = await executorFleet(dir, report(live), snapshot, systemd(states, manager), null, host);
    return { fleet, faults: classifyAttention(fleet.attention).filter(item => item.faultClass === 'resources') };
  };
  const [one, two] = [executorUnit(1), executorUnit(2)];

  // The replay: both slots inactive.
  const both = await slotFaults({ [one]: 'inactive', [two]: 'inactive' });
  assert.equal(both.faults.length, 2, 'one resources fault per inactive slot');
  for (const [index, unit] of [one, two].entries()) {
    const fault = both.faults[index];
    assert.equal(fault.resource, unit);
    assert.equal(fault.kind, 'resource-bound');
    assert.match(fault.text, new RegExp(`^Executor slot ${index + 1} is inactive although this host declares 2 slot\\(s\\)`));
    assert.ok(fault.text.includes(`journalctl --user -u ${unit}`), 'the fault names the journalctl command that says why');
    assert.ok(fault.next.includes(`systemctl --user start ${unit}`) && fault.next.includes(`journalctl --user -u ${unit}`));
    assert.equal(fault.human, false);
  }
  // The dispatcher tells slots down apart from a saturated fleet.
  const unserved = both.fleet.attention.find(item => item.text.startsWith('Nothing can run dispatch'))!;
  assert.equal(unserved.subject, 'GY-1416');
  assert.match(unserved.text, /This host's executor slots are down, not saturated: graphyard-executor@1\.service inactive, graphyard-executor@2\.service inactive\./);
  assert.equal(unserved.next, `systemctl --user start ${one} ${two}`);

  // A slot starting again, or failing in its restart loop, is not back: its fault stands.
  for (const state of ['activating', 'failed']) {
    const { faults } = await slotFaults({ [one]: state, [two]: 'inactive' });
    assert.deepEqual(faults.map(fault => fault.resource), [one, two], `a slot ${state} still pages`);
  }
  // Slot 1 observed active: only slot 2's fault stands; both active: none, and nothing says saturated.
  assert.deepEqual((await slotFaults({ [one]: 'active', [two]: 'inactive' })).faults.map(fault => fault.resource), [two]);
  const recovered = await slotFaults({ [one]: 'active', [two]: 'active' }, [{ executor: `graphyard-master@${host}/1`, host }, { executor: `graphyard-master@${host}/2`, host }]);
  assert.deepEqual(recovered.faults, []);
  assert.deepEqual(recovered.fleet.attention, []);

  // From the loop's vantage on 2026-10-07 no user manager answered: the slots are read from the
  // control plane's presence instead, and a declared slot nobody claims as is down.
  const unseen = await slotFaults({}, [{ executor: `graphyard-master@${host}/1`, host }], false);
  assert.deepEqual(unseen.fleet.slots.map(slot => [slot.unit, slot.active, slot.seenBy]), [[one, 'active', 'presence'], [two, 'inactive', 'presence']]);
  assert.deepEqual(unseen.faults.map(fault => fault.resource), [two]);
  assert.match(unseen.faults[0].text, /read from the control plane: no executor claims as slot 2 of this host; no systemd user manager answers on this host/);
  assert.ok(unseen.faults[0].text.includes(`journalctl --user -u ${two}`));
  // Another host's slot 2 is not this host's.
  assert.deepEqual((await slotFaults({}, [{ executor: `graphyard-master@${host}/1`, host }, { executor: 'graphyard-master@elsewhere/2', host: 'elsewhere' }], false)).faults.map(fault => fault.resource), [two]);
  // A stop in progress is a transition, not a fault (GY-1086).
  assert.deepEqual(executorSlotFaults([{ slot: 1, unit: one, active: 'deactivating', seenBy: 'systemd' }], 1), []);
});

const at = (iso: string) => Date.parse(iso);
function work(overrides: Partial<Work> = {}): Work {
  const created = '2026-10-07T06:00:00.000Z';
  return {
    id: 'id-1416', key: 'GY-1416', title: 'Self-provisioning deployment variables', description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:x'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'build', revision: 40, policyRevision: 1, createdAt: created, updatedAt: created, stageEnteredAt: created,
    ready: true, epoch: 5, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: true, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], containmentQuarantine: null, ...overrides,
  } as Work;
}
/** GY-1416's epoch-5 fence as it stood when the epoch-6 start was refused at 07:11Z. */
const fence = { owner: 'graphyard-opencode-2', epoch: 5, at: '2026-10-07T07:09:10.000Z', settlementHash: 'f'.repeat(64), leaseExpiresAt: '2026-10-07T07:11:40.000Z', launchAcknowledgedAt: '2026-10-07T07:10:10.000Z', launchExpiresAt: '2026-10-07T07:12:10.000Z' };
const refusal = 'Worker startup for epoch 5 remains fenced; stop its supervisor and wait for both lease and launch authority expiry before recovery';
const profile = { name: 'opencode-primary', principal: 'graphyard-opencode-1', agentName: 'graphyard-opencode-1', mode: 'launch', kind: 'opencode', credentialFile: '/srv/credentials/opencode.token', agentArgs: [], approvals: 'auto', environment: {} } as unknown as WorkerProfile;
const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/srv/graphyard/coordinator.token', cliPath: '/srv/graphyard/bin/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: host, masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [profile] });
const row = { id: 'row-1416', kind: 'dispatch', work: 'id-1416', key: 'GY-1416', inputs: { kind: 'dispatch', target: 'implementation', epoch: 5, priority: 1, plannedFiles: [] },
  gate: 'build', refusal: null, reason: 'GY-1416 is ready', binding: 'dispatch:5', requestedBy: 'graphyard', requestedAt: '2026-10-07T07:10:00.000Z', state: 'claimed', claim: null, attempts: 1, history: [] } as unknown as ActionRow;

/** The executor's dispatch handler on a clock the test moves, against an engine that refuses a start while the fence stands. */
function dispatcher(start: string, snapshots: (now: number) => Work) {
  let clock = at(start);
  const slept: number[] = [], launches: string[] = [];
  const effects: ControlPlaneEffects = {
    snapshot: async () => ({ work: [snapshots(clock)], now: new Date(clock).toISOString() }), mutate: async () => ({}), agents: () => [],
    workerCredentials: async list => Object.fromEntries(list.map(entry => [entry.name, { available: true, reason: null }])), producerCredentials: async () => ({}),
    dispatchWorker: async item => {
      launches.push(new Date(clock).toISOString());
      if (workerStartFence({ ...item, containmentQuarantine: fence } as Work, clock)) throw new Error(refusal);
      return { launched: item.key };
    },
    launchReview: async () => ({}), launchProducer: async () => ({}), observeDeployment: async () => ({}) as any,
    now: () => clock, sleep: async ms => { slept.push(ms); clock += ms; },
  };
  return { handlers: controlPlaneHandlers(() => config, effects), slept, launches, clock: () => clock };
}

test('integration:dispatch-retry-after-fence — GY-1416\'s epoch-6 start, refused at 07:11Z by the epoch-5 fence, is retried once the lease and launch authority expire and the retry is recorded on the attempt', async () => {
  // The snapshot shows the fence: the dispatcher waits it out (inside the 2-minute bound) and launches once.
  const seen = dispatcher('2026-10-07T07:11:00.000Z', () => work({ containmentQuarantine: fence }));
  const settled: [string, string][] = [];
  const step = await runExecutorTick({ id: `graphyard-master@${host}/1`, host }, {
    claim: async () => ({ action: row }), settle: async (_, result, reason) => { settled.push([result, reason]); }, handlers: { dispatch: seen.handlers.dispatch! },
  }, seen.clock);
  assert.equal(step.result, 'done', step.reason);
  assert.deepEqual(seen.launches.length, 1, 'no launch is attempted into the standing fence');
  assert.ok(at(seen.launches[0]) > at(fence.launchExpiresAt) && at(seen.launches[0]) > at(fence.leaseExpiresAt), 'the launch comes after both the lease and the launch authority expire');
  assert.ok(seen.slept.reduce((sum, ms) => sum + ms, 0) <= workerStartFenceBoundMs(), 'inside the launch bound');
  assert.equal(settled.length, 1);
  assert.equal(settled[0][0], 'done');
  assert.match(settled[0][1], /^dispatched GY-1416 to opencode-primary; .*; retried after graphyard-opencode-2's epoch 5 fence lapsed at 2026-10-07T07:12:10\.000Z$/, 'the settlement the attempt is recorded with names the retry');

  // A snapshot taken before the fence was written: the engine refuses, the dispatcher reads the
  // fence, waits it out and launches again.
  let reads = 0;
  const stale = dispatcher('2026-10-07T07:11:00.000Z', () => work(reads++ ? { containmentQuarantine: fence } : {}));
  const result = await stale.handlers.dispatch!(row, { id: 'executor', host });
  assert.equal(stale.launches.length, 2);
  assert.equal(stale.launches[0], '2026-10-07T07:11:00.000Z');
  assert.ok(at(stale.launches[1]) > at(fence.launchExpiresAt));
  assert.match(result, /retried after graphyard-opencode-2's epoch 5 fence lapsed at 2026-10-07T07:12:10\.000Z/);

  // A fence that outlasts the 2-minute launch bound is not waited on silently: the attempt fails
  // with a fault naming the fence, and the row backs off to retry.
  const held = { ...fence, launchExpiresAt: '2026-10-07T07:20:00.000Z' };
  const long = dispatcher('2026-10-07T07:11:00.000Z', () => work({ containmentQuarantine: held }));
  const failed: [string, string][] = [];
  const refused = await runExecutorTick({ id: 'executor', host }, { claim: async () => ({ action: row }), settle: async (_, outcome, reason) => { failed.push([outcome, reason]); }, handlers: { dispatch: long.handlers.dispatch! } }, long.clock);
  assert.equal(refused.result, 'failed');
  assert.deepEqual(long.launches, []); assert.deepEqual(long.slept, []);
  assert.equal(failed[0][0], 'failed');
  assert.match(failed[0][1], /^GY-1416's worker start is fenced by graphyard-opencode-2's epoch 5 supervisor until 2026-10-07T07:20:00\.000Z \(lease 2026-10-07T07:11:40\.000Z, launch authority 2026-10-07T07:20:00\.000Z\), 540s past the 2-minute launch bound; stop that supervisor/);

  // Without a fence the dispatch is what it was.
  const clear = dispatcher('2026-10-07T07:13:00.000Z', () => work({ containmentQuarantine: fence }));
  assert.match(await clear.handlers.dispatch!(row, { id: 'executor', host }), /^dispatched GY-1416 to opencode-primary; the worker launcher claimed under graphyard-opencode-1$/);
  assert.deepEqual(clear.slept, []);
});

test('unit:executor-unit-restart-policy — the shipped executor unit restarts a crashed slot with Restart=always and a bounded RestartSec, and a unit without it fails the install check', async () => {
  const shipped = await readFile(join(root, 'examples/master/graphyard-executor@.service'), 'utf8');
  const policy = unitRestartPolicy(shipped);
  assert.deepEqual({ restart: policy.restart, restartSec: policy.restartSec, ok: policy.ok, reason: policy.reason }, { restart: 'always', restartSec: 10, ok: true, reason: null });
  assert.equal(policy.startLimitIntervalSec, '0');
  const without = (pattern: RegExp, replacement = '') => unitRestartPolicy(shipped.replace(pattern, replacement));
  assert.match(without(/^Restart=always$/m).reason!, /^Restart=\(unset\); a crashed slot stays down/);
  assert.match(without(/^Restart=always$/m, 'Restart=on-failure').reason!, /^Restart=on-failure;/);
  assert.match(without(/^RestartSec=10$/m).reason!, /^RestartSec is unset/);
  assert.match(without(/^RestartSec=10$/m, 'RestartSec=5min').reason!, /^RestartSec=5min leaves a crashed slot down past the 60s bound/);
  assert.equal(without(/^RestartSec=10$/m, 'RestartSec=30s').ok, true);
  assert.equal(unitRestartPolicy('# Restart=always\n# RestartSec=10\n[Service]\nExecStart=/bin/true\n').ok, false, 'a commented-out policy is no policy');

  // The install check the script runs: it reports the policy and fails (status 1) without it.
  // @ts-expect-error The standalone executor is a dependency-free entry point script.
  const { installCheck } = await import('../scripts/graphyard-executor.mjs');
  const executor = { unitRestartPolicy };
  const installed = { installed: true, unitFile: '/home/u/.config/systemd/user/graphyard-executor@.service', units: [] };
  const quiet = { log: console.log, error: console.error };
  console.log = () => {}; console.error = () => {};
  try {
    const good = await installCheck(installed, executor, async () => shipped, '/unused');
    assert.deepEqual([good.restartPolicy.unitFile, good.restartPolicy.restart, good.restartPolicy.restartSec, good.restartPolicy.ok], [installed.unitFile, 'always', 10, true]);
    await assert.rejects(installCheck(installed, executor, async () => shipped.replace(/^Restart=always$/m, ''), '/unused'), (error: any) => error.exitCode === 1 && /fails the install check: Restart=\(unset\)/.test(error.message) && error.report.restartPolicy.ok === false);
    // No user manager installed a unit: the check reads the shipped template the operator installs by hand.
    const read: string[] = [];
    await installCheck({ installed: false, unitFile: null }, executor, async (path: string) => { read.push(path); return shipped; }, '/checkout/examples/master/graphyard-executor@.service');
    assert.deepEqual(read, ['/checkout/examples/master/graphyard-executor@.service']);
  } finally { Object.assign(console, quiet); }
});
