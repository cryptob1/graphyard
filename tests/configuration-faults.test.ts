import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';
import type { ActionRow } from '../src/model/actions.js';
import { ExecutorRegistry, executorLiveMs, executorReport } from '../src/model/executor-presence.js';
import { executorRunnableKinds, type NextActionKind } from '../src/model/action-kinds.js';
import { attentionKind, faultClassOf } from '../src/model/fault-classes.js';
import { deploymentObservationSchema, emptyDaemonState, pruneDaemonState, retainedActions, storeAction, type DaemonState } from '../src/master-daemon.js';
import { endFailingRuns } from '../src/daemon/faults.js';
import { detailChanged } from '../src/daemon/decisions.js';
import { performSelfUpgrade } from '../src/daemon/upgrade.js';
import { executorFleet } from '../src/cli/executor-report.js';
import { loopMergerExecutorKinds, writeExecutorDeclaration, type SystemctlRunner } from '../src/repository-setup.js';
import { loopSupervision, loopSupervisionAttention } from '../src/supervisor.js';
import { fleetStatus } from '../src/master/attention.js';
import type { FleetView } from '../src/model/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1086 names this file for its proof: manual:fault-class-configuration. The master loop filed 18
// configuration faults in 24 hours on 1 October 2026 — "a permission, variable, setup step, executor
// or sandbox rule the installation lacks". The installation lacked none of them. The shared cause:
// the loop read a state the product is in by design, or on its way through, as a configuration gap,
// and counted one standing refusal again every time its own cursor bound forgot it.
//
//   - executor (4): a pending merge row "no executor serves" — on an installation where the master
//     loop is the one merger (GY-245) and the executors are declared without merge on purpose;
//   - executor (1): "no executor is alive" read off a control plane's in-memory presence that had
//     heard from nobody yet;
//   - setup (2), executor slots (2): systemd units read while `deactivating`, the state every restart
//     passes through — the loop's own self-upgrade hand-off, an operator's restart;
//   - fleet (2): a role at its concurrency limit (capacity working), and the opt-in master role not
//     yet named, which the loop's own master step already records as a wait and not a fault;
//   - action:config (6 + 1): upgrade:refused and escalation:dirty-checkout are written once while
//     they stand; the row went oldest, the 500-row cursor bound retired it, and the next cycle
//     refused afresh as a new instance — six for one operator hold on the coordinator checkout.
//
// Each instance is replayed against the shipped code. Against the base each test fails on its first
// assertion, the instance recurring; against the candidate it does not.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const instances = {
  merge: ['executor|GY-1063|2026-10-01T13:27:57.751Z', 'executor|GY-980|2026-10-01T13:36:37.333Z', 'executor|GY-1063|2026-10-01T14:32:06.820Z', 'executor|GY-566|2026-10-01T22:16:21.164Z'],
  presence: ['executor|GY-859|2026-10-01T17:23:33.080Z'],
  stopping: ['setup|setup|2026-10-01T15:49:12.364Z', 'setup|setup|2026-10-01T22:14:48.524Z', 'executor|executors|2026-10-01T22:14:48.524Z', 'executor|executors|2026-10-01T22:14:48.524Z#1'],
  fleet: ['fleet|fleet|2026-10-01T14:36:57.269Z', 'fleet|fleet|2026-10-01T17:23:33.080Z'],
  refusal: ['action:config|upgrade:refused|2026-10-01T14:25:15.429Z', 'action:config|upgrade:refused|2026-10-01T15:33:29.852Z', 'action:config|upgrade:refused|2026-10-01T18:11:52.788Z',
    'action:config|upgrade:refused|2026-10-01T19:33:20.278Z', 'action:config|upgrade:refused|2026-10-01T20:52:08.903Z', 'action:config|upgrade:refused|2026-10-01T21:59:36.232Z'],
  dirty: ['action:config|escalation:dirty-checkout|2026-10-01T15:46:00.796Z'],
};

test('manual:fault-class-configuration — the item lists 18 instances, and every one is replayed below', () => {
  const all = Object.values(instances).flat();
  assert.equal(all.length, 18);
  assert.equal(new Set(all).size, 18);
  for (const id of all) assert.equal(faultClassOf(id.split('|')[0]), 'configuration', id);
});

const pendingRow = (key: string, kind: NextActionKind, requestedAt: string): Work => ({
  id: `work-${key}`, key, stage: 'build',
  actionQueue: { history: [], actions: [{ id: `${kind}-${key}`, kind, work: `work-${key}`, key, inputs: { kind } as ActionRow['inputs'], gate: null, refusal: null, reason: `${key} needs ${kind}`,
    binding: `${kind}:1`, requestedBy: 'graphyard', requestedAt, state: 'pending', claim: null, attempts: 0, history: [] } as ActionRow] },
} as unknown as Work);

/** A coordinator host that declared two slots without merge, as `--install` writes them beside a merging loop. */
async function declaredHost(slot: string) {
  const root = await temporaryDirectory('config-faults');
  execFileSync('git', ['init', '-q', root]);
  await mkdir(join(root, '.graphyard'), { recursive: true, mode: 0o700 });
  await writeExecutorDeclaration(root, { version: 1, count: 2, kinds: [...loopMergerExecutorKinds], intervalSeconds: 5 });
  const run: SystemctlRunner = args => {
    if (args[0] === 'is-active') { if (slot === 'active') return 'active'; throw Object.assign(new Error(slot), { stdout: `${slot}\n` }); }
    return '';
  };
  return { root, run };
}

for (const id of instances.merge) {
  const [, key, at] = id.split('|');
  test(`manual:fault-class-configuration — ${id}: a merge row is the merging loop's, never an executor the fleet lacks`, async () => {
    const now = new Date(Date.parse(at));
    const registry = new ExecutorRegistry(new Date(now.getTime() - 3_600_000));
    for (const slot of [1, 2]) registry.observe({ executor: `graphyard-master@vishrog/${slot}`, host: 'vishrog', principal: 'graphyard-master', kinds: [...loopMergerExecutorKinds] }, now);
    const work = [pendingRow(key, 'merge', new Date(now.getTime() - 7 * 60_000).toISOString())];
    const report = executorReport(work, registry, now);
    const { root, run } = await declaredHost('active');
    try {
      const loop = async () => ({ name: 'the master loop (graphyard-master.service, automatic merging on)' });
      const fleet = await executorFleet(root, async () => ({ executors: report }), { work, now: now.toISOString() }, run, loop);
      assert.deepEqual(fleet.attention.map(item => item.text).filter(text => /^Nothing can run merge/.test(text)), [], 'no executor is asked for merge beside a merging loop');
      // Without a merging loop the same row is a real gap, named as before.
      const alone = await executorFleet(root, async () => ({ executors: report }), { work, now: now.toISOString() }, run, async () => null);
      assert.match(alone.attention[0].text, new RegExp(`^Nothing can run merge: ${key} has waited 7m`));
      assert.equal(attentionKind({ subject: key, text: alone.attention[0].text }), 'executor');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test(`manual:fault-class-configuration — ${instances.presence[0]}: a control plane that has heard from nobody yet does not report the fleet dead`, () => {
  const now = new Date('2026-10-01T17:23:33.080Z');
  const work = [pendingRow('GY-859', 'resync', '2026-10-01T17:06:00.000Z'), pendingRow('GY-860', 'resync', '2026-10-01T17:10:00.000Z')];
  const listening = executorReport(work, new ExecutorRegistry(new Date(now.getTime() - 10_000)), now);
  assert.deepEqual(listening.unserved, [], 'ten seconds after a restart, no executor has had its turn to poll');
  // A full liveness window later, an empty registry is a dead fleet, and says so.
  const silent = executorReport(work, new ExecutorRegistry(new Date(now.getTime() - executorLiveMs - 1)), now);
  assert.deepEqual(silent.unserved.map(entry => entry.key), ['GY-859', 'GY-860']);
  // One executor heard inside the first window is judged at once: the warm-up never hides a kind nobody serves.
  const early = new ExecutorRegistry(new Date(now.getTime() - 10_000));
  early.observe({ executor: 'e/1', host: 'h', principal: 'p', kinds: executorRunnableKinds.filter(kind => kind !== 'resync') }, now);
  assert.deepEqual(executorReport(work, early, now).unserved.map(entry => entry.kind), ['resync', 'resync']);
});

for (const id of instances.stopping) {
  const [kind] = id.split('|');
  test(`manual:fault-class-configuration — ${id}: a unit systemd is stopping is a restart in passage, not a supervisor or slot that is down`, async () => {
    if (kind === 'setup') {
      const home = await temporaryDirectory('config-faults-home');
      try {
        const host = (active: string) => ({ platform: 'linux' as const, home, temporaryDirectories: [], run: (command: string, args: string[]) => {
          if (command === 'loginctl') return 'yes';
          if (args.includes('is-active')) { if (active === 'active') return 'active'; throw Object.assign(new Error(active), { stdout: `${active}\n` }); }
          if (args.includes('is-enabled')) return 'enabled';
          return '';
        } });
        const stopping = loopSupervisionAttention(await loopSupervision({ root: home, cliPath: launcher }, host('deactivating'))).map(item => item.text);
        assert.deepEqual(stopping.filter(text => /installed but not running/.test(text)), [], 'the loop reading its own unit mid-restart');
        const stopped = loopSupervisionAttention(await loopSupervision({ root: home, cliPath: launcher }, host('inactive'))).map(item => item.text);
        assert.ok(stopped.some(text => /installed but not running/.test(text)), 'a unit that stays stopped is still named');
      } finally { await rm(home, { recursive: true, force: true }); }
      return;
    }
    const now = new Date('2026-10-01T22:14:48.524Z');
    const registry = new ExecutorRegistry(new Date(now.getTime() - 3_600_000));
    registry.observe({ executor: 'graphyard-master@vishrog/1', host: 'vishrog', principal: 'graphyard-master', kinds: [...loopMergerExecutorKinds] }, now);
    const report = executorReport([], registry, now);
    for (const [state, named] of [['deactivating', false], ['failed', true]] as const) {
      const { root, run } = await declaredHost(state);
      try {
        const fleet = await executorFleet(root, async () => ({ executors: report }), { work: [], now: now.toISOString() }, run, async () => null);
        const lines = fleet.attention.map(item => item.text).filter(text => /^Executor slot \d is /.test(text));
        assert.equal(lines.length, named ? 2 : 0, `slots ${state}: ${lines.join(' | ')}`);
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  });
}

const fleet = (attention: string[]) => ({ revision: 1, updatedAt: null, configured: true, host: 'vishrog', runtimes: [], models: [], accounts: [], roles: [], sessions: [], refusals: [], lastMutation: null, attention }) as unknown as FleetView;
for (const [id, line] of [[instances.fleet[0], 'role reviewer is at its concurrency limit (6 of 6 live)'],
  [instances.fleet[1], 'role master is not configured; the durable loop launches no master session until graphyard master registry role set master ACCOUNT[,ACCOUNT…] --reason REASON names its accounts']] as const) {
  test(`manual:fault-class-configuration — ${id}: "${line.slice(0, 40)}…" is the fleet as configured, not a configuration it lacks`, () => {
    const control = 'role producer is not configured; its sessions launch from local profiles until it is';
    const items = fleetStatus(fleet([line, control])).attentionItems;
    assert.deepEqual(items.map(item => item.text), [control], 'only the line naming a gap is raised');
    assert.equal(items[0].kind, 'fleet');
  });
}

// The loop's refusals, replayed over the cycles of the day: each cycle the refusal is observed again,
// the loop's other work resolves enough actions to pass the cursor bound, and the cursor is pruned.
const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/nonexistent/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
const policy = { windowHours: 24, threshold: 3 };
function churn(state: DaemonState, at: number, cycle: number) {
  for (let index = 0; index <= retainedActions; index += 1)
    state.actions[`merge:churn-${cycle}-${index}`] = { kind: 'merge', work: `GY-${index}`, principal: null, state: 'done', detail: 'merged', attempts: 1, epoch: null, cycle, at: new Date(at + index).toISOString() } as DaemonState['actions'][string];
  pruneDaemonState(state);
  endFailingRuns(state, policy, at + retainedActions + 1);
}
const opened = (state: DaemonState, subject: string) => state.faults.instances.filter(entry => entry.kind === 'action:config' && entry.subject === subject);

test(`manual:fault-class-configuration — ${instances.refusal.join(', ')}: one hold on the coordinator checkout is one instance for as long as it stands`, async () => {
  const start = Date.parse('2026-10-01T14:25:15.429Z'), step = 80 * 60_000;
  const tip = 'b'.repeat(40);
  let head = '2a2d311349c4'.padEnd(40, '0'), now = start;
  const run = async (_command: string, args: string[]) => {
    const op = args[2];
    if (op === 'rev-parse') return `${args[3] === 'HEAD' ? head : tip}\n`;
    if (op === 'symbolic-ref') return 'refs/heads/coordinator/hold-until-gy-1005';
    if (op === 'status' || op === 'fetch') return '';
    throw new Error(`fake git cannot answer: git ${args.slice(2).join(' ')}`);
  };
  const state = emptyDaemonState(master);
  state.deployment = deploymentObservationSchema.parse({ source: 'endpoint', sha: tip, at: new Date(start).toISOString(), reason: null, deployed: ['GY-1'], pending: [] });
  // A day and a half of cycles; the operator commits on the hold branch at 18:11, as on the day.
  for (let cycle = 0; cycle < 27; cycle += 1) {
    if (now >= Date.parse('2026-10-01T18:11:52.788Z')) head = 'f0de7bd665ac'.padEnd(40, '0');
    const outcome = await performSelfUpgrade(master, state, { root: '/coordinator', run, now: () => now });
    assert.equal(outcome.outcome, 'refused');
    churn(state, now + 1, cycle);
    now += step;
  }
  assert.equal(opened(state, 'upgrade:refused').length, 1, `the hold opened ${opened(state, 'upgrade:refused').length} instances`);
  assert.match(state.actions['upgrade:refused']!.detail, /at f0de7bd665ac untouched: HEAD holds refs\/heads\/coordinator\/hold-until-gy-1005/);
  // The hold ends: the checkout is detached at the tip, the refusal clears, and a later hold is a new instance.
  head = tip;
  await performSelfUpgrade(master, state, { root: '/coordinator', run: async (command, args) => args[2] === 'symbolic-ref' ? Promise.reject(Object.assign(new Error('not a symbolic ref'), { status: 1 })) : run(command, args), now: () => now });
  assert.equal(state.upgrade.refused, null);
});

test(`manual:fault-class-configuration — ${instances.dirty[0]}: a dirty checkout refused between cycles is one instance while it stands`, () => {
  // The loop's checkout guard (daemon/run.ts) writes the escalation only when its detail changes,
  // exactly as here; the row then has to outlive the cursor bound for the refusal to stay one fault.
  const key = 'escalation:dirty-checkout';
  const detail = 'the master loop refuses to start, self-upgrade or restart from the coordinator checkout at /home/vish/code/graphyard: it holds uncommitted work at 2a2d311349c4 — 2 modified and 0 untracked source dirty path(s): src/daemon/cycle-delivery.ts, tests/master-daemon.test.ts';
  const state = emptyDaemonState(master);
  let now = Date.parse('2026-10-01T15:46:00.796Z');
  for (let cycle = 0; cycle < 12; cycle += 1) {
    if (detailChanged(state.actions[key], detail))
      storeAction(state, key, { kind: 'escalation', work: null, principal: null, state: 'failed', detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, epoch: null, cycle, at: new Date(now).toISOString() }, 'action:config');
    churn(state, now + 1, cycle);
    now += 30 * 60_000;
  }
  assert.equal(opened(state, key).length, 1, `the dirty checkout opened ${opened(state, key).length} instances`);
  assert.equal(Object.keys(state.actions).length <= retainedActions + 1, true, 'the cursor bound still holds');
});
