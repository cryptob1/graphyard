import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Work } from '../src/model.js';
import { blockedAttemptMarker } from '../src/model/capacity.js';
import { classifyBlocker } from '../src/model/blocker-class.js';
import { faultClassOf, statusFaults, workFaults } from '../src/model/fault-classes.js';
import { cycleFaults, emptyDaemonState, type DaemonEffects } from '../src/master-daemon.js';
import { executorFleet } from '../src/cli/executor-report.js';
import { executorUnit, writeExecutorDeclaration, type SystemctlRunner } from '../src/repository-setup.js';
import { probeBlocker } from '../src/daemon/blocker-probes.js';
import { loopUnitName } from '../src/supervisor.js';
import { masterConfigSchema } from '../src/master.js';
import type { Cycle } from '../src/daemon/cycle.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1428: four configuration faults in 24 hours, one cause — the host's systemd user manager
 * stopped answering. Each instance on the item is replayed here against a simulated host: the two
 * sandbox-blocker instances on GY-1399 (its worker's blockers quoting the refused user bus) and the
 * two executor instances ("Executor slot N is inactive although this host declares 2 slot(s)").
 * On the base they are configuration faults with no repair; on the candidate the loop revives the
 * manager and starts the declared slots, a failed `is-active` is no longer read as a slot that is
 * down, and a blocker quoting the masked bus is the host check the loop probes, not a sandbox rule.
 * The candidate's own modules are imported when a test runs, so this file loads on the base too.
 */

const clock = Date.parse('2030-01-01T12:00:00Z');
const config = () => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/outside/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const busRefused = 'Failed to connect to user scope bus via local transport: Connection refused';
// The two GY-1399 blockers, as the item quotes them.
const blockers = [
  "Host operator action needed; the code is complete. PR #861 at 6da753ac4a53: graphyard-reviewer[bot] found no remaining code defect (both earlier BLOCKING findings fixed, threads resolved). AC-1 and AC-2 are host outcomes a diff cannot deliver. Blocked command: systemctl --user show-environment fails with 'Failed to connect to user scope bus via local transport: Connection refused'. It fails from this worker sandbox and from the running loop itself (the board's 'master loop is not supervised on t",
  "Host operator act needed; code complete at PR #861 head 1fc16433bcc7 (only change this epoch: the reviewer's wording nit in src/daemon/upgrade.ts; graphyard verify GY-1399 passes both proofs, typecheck clean). The reviewer's only BLOCKING grounds are AC-1/AC-2 host outcomes. Blocked command: systemctl --user show-environment -> 'Failed to connect to user scope bus via local transport: Connection refused' (worker bwrap masks /run/user/1000/bus and unshares PIDs, checkout is read-only, so no worke",
];

function item(key: string, overrides: Partial<Work> = {}): Work {
  return {
    id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'build', revision: 1, policyRevision: 1,
    createdAt: iso(-3_600_000), updatedAt: iso(0), stageEnteredAt: iso(-3_600_000), ready: true, epoch: 3, lease: null, workspaces: [],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [], ...overrides,
  } as unknown as Work;
}
/** GY-1399 blocked by its worker a minute ago, as the `blocked` report records it. */
const blockedItem = (blocker: string) => item('GY-1399', { blocker, capacity: { exhaustions: [{ role: 'worker', epoch: 3, cause: 'interrupted', profile: 'claude-1', account: null, runtime: 'claude',
  reason: `${blockedAttemptMarker}3: ${blocker}`.slice(0, 500), resetsAt: null, partialWork: { state: 'clean' }, at: iso(-60_000), owner: 'graphyard-claude-1', recordedBy: 'coordinator' }], escalations: [] } } as unknown as Partial<Work>);

/**
 * A host whose user manager can stop answering. While it is down every `systemctl --user` call fails
 * the way the worker and the loop saw it; `loginctl enable-linger` starts it when logind allows.
 */
function simulatedHost(options: { manager: boolean; slots: Record<string, string>; logind?: boolean; isActiveUnreachable?: boolean; disabled?: string[] }) {
  const state = { manager: options.manager, slots: { [loopUnitName]: 'active', ...options.slots } as Record<string, string>, disabled: new Set(options.disabled ?? []) };
  const calls: string[] = [];
  const refuse = () => { throw Object.assign(new Error(`Command failed: systemctl --user\n${busRefused}`), { stderr: `${busRefused}\n`, stdout: '' }); };
  const systemctl: SystemctlRunner = args => {
    calls.push(`systemctl --user ${args.join(' ')}`);
    if (!state.manager) refuse();
    if (args[0] === 'show-environment') return 'HOME=/home/operator';
    if (args[0] === 'is-active') {
      if (options.isActiveUnreachable) refuse();
      const active = state.slots[args.at(-1)!] ?? 'inactive';
      if (active === 'active') return 'active';
      throw Object.assign(new Error(`Command failed: systemctl --user is-active ${args.at(-1)}`), { stdout: `${active}\n`, stderr: '' });
    }
    if (args[0] === 'is-enabled') {
      if (!state.disabled.has(args.at(-1)!)) return 'enabled';
      throw Object.assign(new Error(`Command failed: systemctl --user is-enabled ${args.at(-1)}`), { stdout: 'disabled\n', stderr: '' });
    }
    if (args[0] === 'enable' && args[1] === '--now') { for (const unit of args.slice(2)) { state.slots[unit] = 'active'; state.disabled.delete(unit); } return ''; }
    return '';
  };
  const loginctl = (args: string[]) => {
    calls.push(`loginctl ${args.join(' ')}`);
    if (options.logind === false) throw Object.assign(new Error('Command failed: loginctl enable-linger'), { stderr: 'Could not enable linger: Access denied\n' });
    state.manager = true;
    return '';
  };
  return { state, calls, systemctl, loginctl };
}

async function declaredCheckout(count: number) {
  const checkout = await temporaryDirectory('user-manager');
  execFileSync('git', ['init', '-q'], { cwd: checkout });
  await mkdir(join(checkout, '.graphyard'), { mode: 0o700 });
  await writeExecutorDeclaration(checkout, { version: 1, count, kinds: null, intervalSeconds: 5 });
  return checkout;
}
const noPresence = async () => ({ executors: undefined });
const slotLines = (fleet: Awaited<ReturnType<typeof executorFleet>>) => fleet.attention.filter(entry => /^Executor slot \d+ is /.test(entry.text)).map(entry => entry.text);
const executorFaults = (fleet: Awaited<ReturnType<typeof executorFleet>>) => statusFaults({ github: true, executors: { attention: fleet.attention } } as any).filter(fault => fault.kind === 'executor');

test('manual:fault-class-configuration — GY-1428 executor instances: a failed is-active is no slot that is down', async () => {
  // The manager answered show-environment, then refused is-active: the base read both slots "inactive".
  const checkout = await declaredCheckout(2);
  try {
    const host = simulatedHost({ manager: true, slots: {}, isActiveUnreachable: true });
    const fleet = await executorFleet(checkout, noPresence, { work: [], now: iso(0) }, host.systemctl, null);
    assert.deepEqual(slotLines(fleet), [], 'no "Executor slot N is inactive" line for a slot systemd was never asked about');
    assert.deepEqual(executorFaults(fleet), []);
    assert.equal(fleet.supervision.supervised, false);
    assert.match(fleet.supervision.reason!, /could not reach it/);
  } finally { await rm(checkout, { recursive: true, force: true }); }
});

test('manual:fault-class-configuration — GY-1428 executor instances: the loop starts declared slots the manager left down', async () => {
  const checkout = await declaredCheckout(2);
  try {
    // A manager that came back without the slots (they died with it): the base raised one line per slot.
    const host = simulatedHost({ manager: true, slots: {} });
    const before = await executorFleet(checkout, noPresence, { work: [], now: iso(0) }, host.systemctl, null);
    assert.deepEqual(slotLines(before), [1, 2].map(slot => `Executor slot ${slot} is inactive although this host declares 2 slot(s); journalctl --user -u ${executorUnit(slot)} says why`), 'the two instances the item lists');
    const { healUserSupervision } = await import('../src/user-manager.js');
    const heal = await healUserSupervision(checkout, { systemctl: host.systemctl, loginctl: host.loginctl, masked: () => false, wait: async () => {}, platform: 'linux' });
    assert.equal(heal.reason, null);
    assert.ok(host.calls.includes(`systemctl --user enable --now ${executorUnit(1)} ${executorUnit(2)}`), host.calls.join('\n'));
    const after = await executorFleet(checkout, noPresence, { work: [], now: iso(0) }, host.systemctl, null);
    assert.deepEqual(slotLines(after), []);
    assert.deepEqual(executorFaults(after), []);
  } finally { await rm(checkout, { recursive: true, force: true }); }
});

test('manual:fault-class-configuration — GY-1428 the dead user manager is revived through logind, then its slots started', async () => {
  const { healUserSupervision } = await import('../src/user-manager.js');
  const checkout = await declaredCheckout(2);
  try {
    const host = simulatedHost({ manager: false, slots: {} });
    const heal = await healUserSupervision(checkout, { systemctl: host.systemctl, loginctl: host.loginctl, masked: () => false, wait: async () => {}, platform: 'linux' });
    assert.equal(heal.reason, null);
    assert.deepEqual(heal.performed.length, 2);
    assert.ok(host.calls.indexOf('loginctl enable-linger') < host.calls.indexOf(`systemctl --user enable --now ${executorUnit(1)} ${executorUnit(2)}`));
    assert.deepEqual(slotLines(await executorFleet(checkout, noPresence, { work: [], now: iso(0) }, host.systemctl, null)), []);

    // Behind a masked bus the host is not what failed: logind is never asked.
    const masked = simulatedHost({ manager: false, slots: {} });
    const refused = await healUserSupervision(checkout, { systemctl: masked.systemctl, loginctl: masked.loginctl, masked: () => true, wait: async () => {}, platform: 'linux' });
    assert.match(refused.reason!, /masked user bus/);
    assert.ok(!masked.calls.includes('loginctl enable-linger'));
    // A logind that refuses is the reason, once; nothing else is attempted.
    const denied = simulatedHost({ manager: false, slots: {}, logind: false });
    assert.match((await healUserSupervision(checkout, { systemctl: denied.systemctl, loginctl: denied.loginctl, masked: () => false, wait: async () => {}, platform: 'linux' })).reason!, /logind refused to start it: Could not enable linger: Access denied/);
    // A host that declares no slot is left alone.
    const bare = await temporaryDirectory('user-manager-bare');
    try { const idle = simulatedHost({ manager: false, slots: {} }); const left = await healUserSupervision(bare, { systemctl: idle.systemctl, loginctl: idle.loginctl, masked: () => false, platform: 'linux' }); assert.deepEqual([left.performed, left.reason], [[], null]); assert.ok(!idle.calls.includes('loginctl enable-linger')); }
    finally { await rm(bare, { recursive: true, force: true }); }
  } finally { await rm(checkout, { recursive: true, force: true }); }
});

test('manual:fault-class-configuration — GY-1428 sandbox-blocker instances: GY-1399\'s blockers are the host check the loop probes and heals', async () => {
  for (const blocker of blockers) {
    assert.equal(classifyBlocker(blocker).class, 'host-supervisor');
    const blocked = blockedItem(blocker);
    // The base counted each as a configuration fault (`sandbox-blocker`) the moment it was raised.
    const kinds = workFaults(blocked, clock).map(fault => fault.kind);
    assert.deepEqual(kinds, ['blocker']);
    assert.notEqual(faultClassOf(kinds[0]), 'configuration');
    // Inside the master's turn the loop is probing it: no instance of any class.
    assert.deepEqual(cycleFaults(emptyDaemonState(config()), [blocked], clock).filter(fault => fault.subject === 'GY-1399'), []);
  }
  // And the probe the loop runs passes once the step before it revived the manager.
  const checkout = await declaredCheckout(2);
  try {
    const host = simulatedHost({ manager: false, slots: {} });
    const run = (command: string, args: string[]) => { assert.equal(command, 'systemctl'); return host.systemctl(args.slice(1).filter(arg => arg !== '--quiet')); };
    const deps = { run, launch: null, cwd: checkout, clock };
    assert.equal((await probeBlocker(blockedItem(blockers[0]), classifyBlocker(blockers[0]), deps))!.passed, false, 'the base: the manager stays down');
    const { healUserSupervision } = await import('../src/user-manager.js');
    await healUserSupervision(checkout, { systemctl: host.systemctl, loginctl: host.loginctl, masked: () => false, wait: async () => {}, platform: 'linux' });
    assert.equal((await probeBlocker(blockedItem(blockers[0]), classifyBlocker(blockers[0]), deps))!.passed, true);
  } finally { await rm(checkout, { recursive: true, force: true }); }
});

/** The real step over the real repair on a simulated host, one cycle a minute. */
async function hostLoop(host: ReturnType<typeof simulatedHost>, checkout: string) {
  const { hostSupervisionStep } = await import('../src/daemon/cycle-host.js');
  const { healUserSupervision } = await import('../src/user-manager.js');
  const state = emptyDaemonState(config());
  let waited = 0;
  const effects = { persist: async () => {}, healHostSupervision: (allow: any) => healUserSupervision(checkout, { systemctl: host.systemctl, loginctl: host.loginctl, masked: () => false, wait: async (ms: number) => { waited += ms; }, platform: 'linux' }, allow) } as unknown as DaemonEffects;
  return { state, waited: () => waited, cycle: async (minute: number) => { const performed: unknown[] = []; await hostSupervisionStep({ effects, state, now: () => clock + minute * 60_000, performed } as unknown as Cycle); return performed; } };
}

test('manual:fault-class-configuration — GY-1428 a manager that stays down is one failing run of the loop\'s step, revived with backoff, ended when it answers', async () => {
  const { hostSupervisionKey } = await import('../src/daemon/cycle-host.js');
  const checkout = await declaredCheckout(2);
  try {
    const host = simulatedHost({ manager: false, slots: {}, logind: false });
    const loop = await hostLoop(host, checkout);
    const revivals: number[] = [];
    for (let minute = 0; minute < 120; minute++) {
      const before = host.calls.filter(call => call === 'loginctl enable-linger').length;
      await loop.cycle(minute);
      if (host.calls.filter(call => call === 'loginctl enable-linger').length > before) revivals.push(minute);
    }
    // Backoff: 1, 2, 4, 8, 16, 30, 30 … minutes between revivals, never one a cycle.
    assert.deepEqual(revivals, [0, 1, 3, 7, 15, 31, 61, 91], `revivals at minutes ${revivals.join(', ')}`);
    assert.equal(loop.state.actions[hostSupervisionKey].state, 'failed');
    assert.equal(loop.state.actions[hostSupervisionKey].attempts, revivals.length);
    assert.equal(Object.keys(loop.state.actions).filter(key => key.startsWith('host-supervision')).length, 1, 'one record for the condition, not one per slot or blocker');
    // The manager comes back on its own: the run ends, the slots are started, and a quiet host records nothing more.
    host.state.manager = true;
    const recovered = await loop.cycle(120);
    assert.equal(loop.state.actions[hostSupervisionKey].state, 'done');
    assert.ok(recovered.length >= 2, 'the run ended and the slots were started');
    assert.deepEqual(await loop.cycle(121), []);
  } finally { await rm(checkout, { recursive: true, force: true }); }
});

test('manual:fault-class-configuration — GY-1428 a revival waits at most three seconds, and only on the cycles it is attempted', async () => {
  const checkout = await declaredCheckout(1);
  try {
    // logind accepts, but the manager never answers.
    const host = simulatedHost({ manager: false, slots: {} });
    const silent = { ...host, loginctl: (args: string[]) => { host.calls.push(`loginctl ${args.join(' ')}`); return ''; } };
    const loop = await hostLoop(silent, checkout);
    await loop.cycle(0);
    assert.equal(loop.waited(), 3000);
    await loop.cycle(0.5);
    assert.equal(loop.waited(), 3000, 'a cycle inside the backoff neither asks logind nor waits');
  } finally { await rm(checkout, { recursive: true, force: true }); }
});

test('manual:fault-class-configuration — GY-1428 a crash-looping slot is restarted with a cooldown, then reported failed and left down', async () => {
  const { hostSlotKey } = await import('../src/daemon/cycle-host.js');
  const checkout = await declaredCheckout(1);
  try {
    const unit = executorUnit(1);
    const host = simulatedHost({ manager: true, slots: { [unit]: 'failed' } });
    const loop = await hostLoop(host, checkout);
    const starts: number[] = [];
    for (let minute = 0; minute < 60; minute++) {
      host.state.slots[unit] = 'failed'; // it dies again within a minute of every start
      const before = host.calls.filter(call => call.startsWith('systemctl --user enable --now')).length;
      await loop.cycle(minute);
      if (host.calls.filter(call => call.startsWith('systemctl --user enable --now')).length > before) starts.push(minute);
    }
    assert.deepEqual(starts, [0, 10, 20], `restarts at minutes ${starts.join(', ')}`);
    assert.equal(loop.state.actions[hostSlotKey(unit)].state, 'failed');
    assert.match(loop.state.actions[hostSlotKey(unit)].detail, /no longer restarts it: journalctl --user -u graphyard-executor@1/);
    // Seen running again (an operator started it), the failing run ends.
    host.state.slots[unit] = 'active';
    await loop.cycle(61);
    assert.equal(loop.state.actions[hostSlotKey(unit)].state, 'done');
  } finally { await rm(checkout, { recursive: true, force: true }); }
});

test('manual:fault-class-configuration — GY-1428 a slot an operator disabled is left down, and a loop outside its unit is reported, never started', async () => {
  const { hostLoopUnitKey } = await import('../src/daemon/cycle-host.js');
  const checkout = await declaredCheckout(2);
  try {
    const host = simulatedHost({ manager: true, slots: { [loopUnitName]: 'inactive' }, disabled: [executorUnit(2)] });
    const loop = await hostLoop(host, checkout);
    await loop.cycle(0);
    assert.ok(host.calls.includes(`systemctl --user enable --now ${executorUnit(1)}`), host.calls.join('\n'));
    assert.ok(!host.calls.some(call => call.startsWith('systemctl --user enable') && call.includes(executorUnit(2))), 'the disabled slot stays down');
    assert.ok(!host.calls.some(call => call.startsWith('systemctl --user enable') && call.includes(loopUnitName)), 'the loop never starts its own unit under itself');
    assert.equal(loop.state.actions[hostLoopUnitKey].state, 'waiting');
    assert.match(loop.state.actions[hostLoopUnitKey].detail, /loop's unit is inactive/);
    assert.deepEqual(await loop.cycle(1), [], 'reported once while nothing changes');
    host.state.slots[loopUnitName] = 'active';
    await loop.cycle(2);
    assert.equal(loop.state.actions[hostLoopUnitKey], undefined);
  } finally { await rm(checkout, { recursive: true, force: true }); }
});
