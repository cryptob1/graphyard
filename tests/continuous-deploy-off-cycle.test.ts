import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { daemonEffects, emptyDaemonState, runDaemon, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { coordinatorCheckoutGuard } from '../src/daemon/run.js';
import { deployLine, promotionReading, type DeployPorts } from '../src/daemon/continuous-deploy.js';

/** The new exports, imported in the case so a reverted source fails the case, not the file (graphyard verify's exercise). */
const offCycle = () => import('../src/daemon/continuous-deploy.js') as Promise<Record<string, any>>;
import { performSelfUpgrade, type SelfUpgradeDeps } from '../src/daemon/upgrade.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-2344: a deploy of main runs off the cycle. The loop used to hold every cycle — heartbeat,
 * dispatch, the merge writer — behind the deploy, for as long as it took; the deploy now proceeds
 * beside the cycles, its result is recorded when it settles, and no second deploy starts meanwhile.
 * The coordinator checkout guard reads the deploy's own checkout moves as the loop's own, never as
 * drift.
 */

const full = (prefix: string) => prefix.padEnd(40, '0');
const released = full('a1a1a1a1a1a1'), tip = full('b2b2b2b2b2b2');
const iso = (at: number) => new Date(at).toISOString();

/** A clean, detached coordinator checkout at `head`; a fetch finds `originTip`; every ancestry read answers "not contained". */
class FakeGit {
  checkouts: string[] = [];
  diff = 'src/daemon/run.ts\n';
  constructor(public head: string, public originTip: string) {}
  run = async (_command: string, args: string[]): Promise<string> => {
    const [op, ...operands] = args.slice(2);
    if (op === 'rev-parse') return `${operands[0] === 'HEAD' ? this.head : this.originTip}\n`;
    if (op === 'symbolic-ref') throw Object.assign(new Error('fatal: not a symbolic ref'), { status: 1 });
    if (op === 'status') return '';
    if (op === 'fetch') return '';
    if (op === 'diff') return this.diff;
    if (op === 'checkout') { this.head = operands[2]; this.checkouts.push(operands[2]); return ''; }
    if (op === 'merge-base') throw Object.assign(new Error('not an ancestor'), { status: 1 });
    throw new Error(`fake git cannot answer: git ${args.slice(2).join(' ')}`);
  };
}

/** Ports whose deploy step records its start at once and then waits on `gate` (when set), keeping the deploy in flight; `fails` names the step that throws. */
function fakePorts(options: { gate?: Promise<void>; fails?: Record<string, string> } = {}) {
  const started: string[] = [], calls: string[] = [], pins: string[] = [];
  const step = (name: 'deploy' | 'health') => async (commit: string) => {
    if (name === 'deploy') { started.push(commit.slice(0, 12)); if (options.gate) await options.gate; }
    calls.push(`${name}:${commit.slice(0, 12)}`);
    if (options.fails?.[commit] === name) throw new Error(`${name} refused ${commit.slice(0, 12)}`);
  };
  const ports: DeployPorts = { deploy: step('deploy'), health: step('health'),
    schemas: async () => ({ target: 7, database: 7 }), pin: async commit => { pins.push(commit); } };
  return { ports, started, calls, pins };
}

const config = async () => {
  const root = await temporaryDirectory('deploy-off-cycle');
  const secrets = await temporaryDirectory('deploy-off-cycle-secrets');
  const credentialFile = join(secrets, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master = masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:9', credentialFile, cliPath: join(secrets, 'bin', 'graphyard.mjs'),
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'deploy-off-cycle-host', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  return { root, master };
};

const upgradeDeps = (fake: FakeGit, ports: DeployPorts, fleet: { self: number }): SelfUpgradeDeps => ({
  root: '/coordinator', run: fake.run, deploy: async () => ports,
  restartSelf: async () => { fleet.self += 1; },
});

/** The production effects factory over fakes, with the loop's self-upgrade running the real alignment against the fake git and the given ports. */
function loopEffects(root: string, master: MasterConfig, deps: SelfUpgradeDeps): DaemonEffects {
  const effects = daemonEffects(root, master, {
    snapshot: async () => ({ work: [], now: iso(Date.now()) }),
    mutate: async path => ({ path }),
    // The loop's cold wait for the intervention report's first copy would outlast every phase here; nothing below reads it.
    run: async command => { if (command === 'herdr') return JSON.stringify({ result: { agents: [] } }); throw new Error(`unplanned child: ${command}`); },
  });
  return Object.assign(effects, {
    agents: async () => [], herdr: async () => ({ agents: [], available: true }), credentials: async () => ({}), roleHealth: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: iso(Date.now()), reason: 'not configured', deployed: [], pending: [] }),
 closeSession: async () => {},
    masterSession: undefined,
    loadedRelease: { commit: released, dirty: false },
    selfUpgrade: (state: DaemonState) => performSelfUpgrade(master, state, deps),
  }) as DaemonEffects;
}

/** The wait bound every phase gets: the loop cycles every 25 ms, so anything owed lands far inside it. */
async function waitFor(until: () => boolean, what: string) {
  for (let waited = 0; waited < 20_000 && !until(); waited += 10) await sleep(10);
  assert.ok(until(), what);
}

/** Runs the real loop beside the test: cycles every 25 ms, stopped through the fake process's SIGTERM. */
async function startLoop(root: string, master: MasterConfig, state: DaemonState, effects: DaemonEffects, fake: FakeGit) {
  const lines: string[] = [];
  const handlers: Record<string, () => void> = {};
  const started = runDaemon(master, state, effects, {
    intervalMs: 25, identity: { pid: process.pid, host: master.hostId }, signals: ['SIGTERM'], log: line => lines.push(line),
    checkout: async () => ({ root: '/coordinator', commit: fake.head, modified: [], untracked: [] }),
    repository: root,
    process: { on: (signal: NodeJS.Signals, handler: () => void) => { handlers[signal] = handler; }, off: () => {} } as unknown as Pick<NodeJS.Process, 'on' | 'off'>,
  });
  return { lines, stop: () => handlers.SIGTERM?.(), done: started };
}

test('unit:continuous-deploy-off-cycle — with a deploy that outlasts several cycle intervals, the loop completes cycles while the deploy runs, records its success once it settles and starts no second deploy meanwhile, then restarts onto the deployed tip', async t => {
  const { root, master } = await config();
  const fake = new FakeGit(released, tip);
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(async () => { release(); await sleep(20); });
  const { ports, started, calls, pins } = fakePorts({ gate });
  const fleet = { self: 0 };
  const state = emptyDaemonState(master);
  state.release = { commit: released, dirty: false };
  const effects = loopEffects(root, master, upgradeDeps(fake, ports, fleet));

  const loop = await startLoop(root, master, state, effects, fake);
  t.after(() => loop.stop());
  // The pass starts the deploy of the base tip; its deploy step waits on the gate, the way a long
  // build outlasts several cycle intervals.
  await waitFor(() => started.length >= 1, 'the deploy of the base tip never started');
  const whileRunning = { cycle: state.cycle, heartbeat: state.lock?.heartbeatAt };
  // Cycles complete while the deploy runs: the heartbeat advances, and the dispatch and merge steps run.
  await waitFor(() => state.cycle >= whileRunning.cycle + 3, 'the loop never completed cycles while the deploy ran');
  assert.notEqual(state.lock?.heartbeatAt, whileRunning.heartbeat, 'the heartbeat advanced while the deploy ran');
  assert.notEqual(state.lastCycleAt, null);
  const steps = state.metrics.at(-1)?.steps;
  assert.ok(steps && 'dispatch' in steps && 'merge' in steps, 'the cycles that completed ran their dispatch and merge steps');
  // One deploy is running: no second starts, nothing settles yet, and the checkout the deploy holds is never drift.
  assert.equal(started.length, 1, 'no second deploy started while the first runs');
  assert.equal(state.promotion === null, true, 'the deploy has settled nothing onto the cursor yet');
  assert.equal(state.actions['attention:dirty-checkout'], undefined, 'the deploy holding the checkout at the tip is never the guard\'s drift');
  // The deploy settles: its success is recorded, and the loop restarts onto the tip it deployed.
  release();
  await waitFor(() => state.promotion?.promotedSha === tip, 'the deploy never settled onto the cursor');
  assert.deepEqual(calls, [`deploy:${tip.slice(0, 12)}`, `health:${tip.slice(0, 12)}`]);
  assert.deepEqual(pins, [tip], 'the deployed tip is pinned known good');
  assert.equal(state.actions['upgrade:deploy']?.state, 'done');
  assert.equal(state.promotion?.deployFailed, null);
  await waitFor(() => fleet.self >= 1, 'the loop never restarted onto the deployed tip');
  assert.equal(state.upgrade.last?.to, tip);
  assert.equal(state.upgrade.last?.code, true, 'the deployed tip is loaded code whatever the diff says');
  assert.equal(started.length, 1, 'still no second deploy');
  assert.equal(state.actions['attention:dirty-checkout'], undefined);
  loop.stop();
  const result = await loop.done;
  assert.ok(result.cycles.length >= 4, `the loop completed ${result.cycles.length} cycles across the deploy`);
  assert.deepEqual(result.failed, []);
});

test('unit:continuous-deploy-off-cycle-rollback — a deploy whose health check fails settles into the recorded rollback while the loop keeps cycling, the second attempt runs off the cycle too, and the spent tip is attempted no third time', async t => {
  const { root, master } = await config();
  const fake = new FakeGit(released, tip);
  const { ports, started, calls } = fakePorts({ fails: { [tip]: 'health' } });
  const fleet = { self: 0 };
  const state = emptyDaemonState(master);
  state.release = { commit: released, dirty: false };
  state.promotion = promotionReading(null, iso(0), { mainSha: released, promotedSha: released, promotedAt: iso(0) });
  const effects = loopEffects(root, master, upgradeDeps(fake, ports, fleet));

  const loop = await startLoop(root, master, state, effects, fake);
  t.after(() => loop.stop());
  const tipDeploys = () => started.filter(commit => commit === tip.slice(0, 12)).length;
  // The first attempt runs off the cycle and fails health: the settle rolls the release back and records the failure.
  await waitFor(() => state.promotion?.deployFailed?.attempts === 1, 'the failed deploy never settled');
  assert.deepEqual(calls, [`deploy:${tip.slice(0, 12)}`, `health:${tip.slice(0, 12)}`, `deploy:${released.slice(0, 12)}`, `health:${released.slice(0, 12)}`],
    'the recorded release was redeployed through the same sequence');
  assert.equal(fake.head, released, 'the checkout is back on the recorded release');
  assert.equal(state.promotion?.promotedSha, released);
  assert.equal(state.actions['upgrade:deploy']?.state, 'failed');
  assert.equal(fleet.self, 0, 'nothing restarted onto the failed tip');
  assert.equal(state.actions['attention:dirty-checkout'], undefined, 'the rollback moving the checkout back is never the guard\'s drift');
  // The second attempt starts off the cycle, fails the same way, and the settle records it.
  await waitFor(() => tipDeploys() === 2, 'the second attempt never started');
  await waitFor(() => state.promotion?.deployFailed?.attempts === 2, 'the second attempt never settled');
  assert.equal(fake.head, released);
  // The tip has failed twice: further cycles attempt it no more, and the failure line stands for master status.
  const spentAt = state.cycle;
  await waitFor(() => state.cycle >= spentAt + 3, 'the loop never kept cycling past the spent tip');
  assert.equal(tipDeploys(), 2, 'a tip that failed twice is not attempted again');
  assert.match(deployLine(state.promotion?.deployFailed) ?? '', /failed at health/);
  assert.equal(state.actions['attention:dirty-checkout'], undefined);
  loop.stop();
  const result = await loop.done;
  assert.ok(result.cycles.length >= 5, `the loop completed ${result.cycles.length} cycles across both attempts`);
});

test('unit:continuous-deploy-off-cycle-guard — the guard reads the deploy in flight and the promotion reading it records as the loop\'s own positions, and still refuses a foreign move', async t => {
  const { deployInFlight, deployTipOffCycle } = await offCycle();
  const { master } = await config();
  const fake = new FakeGit(released, tip);
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(async () => { release(); await sleep(20); });
  const { ports } = fakePorts({ gate });
  const state = emptyDaemonState(master);
  state.release = { commit: released, dirty: false };
  state.promotion = promotionReading(null, iso(0), { mainSha: released, promotedSha: released, promotedAt: iso(0) });
  const guard = coordinatorCheckoutGuard({
    state: () => state, read: async () => ({ root: '/coordinator', commit: fake.head, modified: [], untracked: [] }),
    agents: async () => [], snapshot: async () => ({ work: [], now: iso(0) }), persist: async () => {}, now: () => 0, log: () => {}, applies: () => true,
  });
  assert.equal(await guard.start(released), null);
  assert.equal(deployInFlight(), null);
  assert.match(deployTipOffCycle(state, tip, released, ports, { git: (...args: string[]) => fake.run('git', ['-C', '/coordinator', ...args]), at: () => iso(0), persist: async () => {}, note: async () => {} }) ?? '', /deploying base tip/);
  // While the deploy runs, the checkout legitimately stands at the tip it is deploying: not drift.
  fake.head = tip;
  assert.deepEqual(await guard.betweenCycles(undefined), { refusal: null, upgraded: null });
  // A foreign move while the deploy runs is still drift.
  fake.head = full('d4d4d4d4d4d4');
  assert.match((await guard.betweenCycles(undefined)).refusal ?? '', /HEAD moved/);
  fake.head = tip;
  // Settled, the promotion reading names the tip the deploy left the checkout at: not drift until the restart lands.
  release();
  for (let waited = 0; waited < 5_000 && deployInFlight(); waited += 5) await sleep(5);
  assert.equal(deployInFlight(), null, 'the deploy never settled');
  assert.equal(state.promotion?.promotedSha, tip);
  assert.deepEqual(await guard.betweenCycles(undefined), { refusal: null, upgraded: null });
});
