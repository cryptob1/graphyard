import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { masterCauses } from '../src/daemon/master-stalled-delivery.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { masterConfigSchema, type WorkerProfile } from '../src/master.js';
import type { Work } from '../src/model.js';
import type { AgentRegistry, CanaryOffer, FleetRuntime } from '../src/model/registry.js';
import { readySpecCheck } from './helpers/spec-check.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workFixture } from './helpers/work-fixture.js';

/**
 * GY-3103: a newer installed runtime version runs one canary session before the fleet switches to
 * it, and a worker launch failure backs off its runtime for its item (1 min doubling to 30 min).
 */
// Imported at run time, so the same file run against the base fails case by case rather than at load.
const { canaryOffer, launchBackoffMs } = await import('../src/daemon/sessions.js') as typeof import('../src/daemon/sessions.js');
const scratch = await temporaryDirectory('runtime-canary');
after(() => rm(scratch, { recursive: true, force: true }));
const t0 = Date.parse('2030-01-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const installs = join(scratch, 'mise', 'installs', 'opencode');
for (const version of ['2.2.4', '2.2.5']) await mkdir(join(installs, version, 'bin'), { recursive: true });
await mkdir(join(installs, 'latest'), { recursive: true });
const token = join(scratch, 'coordinator.token'), workerToken = join(scratch, 'worker.token');
await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
await writeFile(workerToken, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });

const profiles = Array.from({ length: 9 }, (_, index): WorkerProfile => ({ name: `opencode-${index}`, principal: `worker-${index}`, agentName: `agent-${index}`, mode: 'launch', kind: 'claude', credentialFile: workerToken, agentArgs: [], environment: {} }) as unknown as WorkerProfile);
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
  repository: 'owner/project', baseBranch: 'main', hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: profiles });
const runtime = (version: string): FleetRuntime => ({ name: 'opencode', launch: { kind: 'opencode', args: [], environment: { PATH: `${join(installs, version, 'bin')}:/usr/bin:/bin`, MISE_NO_CONFIG: '1' }, homeVariable: 'XDG_DATA_HOME', modelFlag: null, login: null, loginFile: null } } as unknown as FleetRuntime);
const registryOf = (runtimes: FleetRuntime[]): Pick<AgentRegistry, 'runtimes' | 'accounts' | 'roles'> => ({ runtimes: [...runtimes, { name: 'claude', launch: { kind: 'claude', environment: {} } } as unknown as FleetRuntime],
  accounts: [{ name: 'oc-a', runtime: 'opencode' }, { name: 'cl-a', runtime: 'claude' }] as AgentRegistry['accounts'],
  roles: [{ name: 'worker', accounts: ['oc-a', 'cl-a'] }] as AgentRegistry['roles'] });
function work(id: string, key: string, overrides: Partial<Work> = {}): Work {
  return workFixture({ id, key, priority: 1, createdAt: iso(t0 - 3_600_000), updatedAt: iso(t0), stageEnteredAt: iso(t0),
    specCheck: readySpecCheck(iso(t0 - 3_600_000)), ...overrides });
}
const session = (startedAt: number, overrides: Record<string, unknown> = {}) => ({ id: 'worker-0:1', kind: 'implementation', principal: 'worker-0', runtime: 'opencode', host: 'machine-b', epoch: 1,
  subject: 'GY-1', state: 'running', startedAt: iso(startedAt), runtimeStartedAt: iso(startedAt), updatedAt: iso(startedAt), initialHead: 'a'.repeat(40), ...overrides });

function harness(items: Work[], registry = registryOf([runtime('2.2.4')])) {
  let now = t0;
  const launches: { key: string; canaries: CanaryOffer[]; exclude: string[] }[] = [], switched: { runtime: FleetRuntime; reason: string }[] = [];
  const state = emptyDaemonState(config);
  const behave: { dispatch: DaemonEffects['dispatch'] | null } = { dispatch: null };
  const effects: DaemonEffects = {
    agents: () => [], persist: async () => {}, closeSession: () => {},
    credentials: async list => Object.fromEntries(list.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: items, now: iso(now) }),
    registry: async () => registry,
    setRuntime: async (next, reason) => { switched.push({ runtime: next, reason }); registry = { ...registry, runtimes: registry.runtimes.map(entry => entry.name === next.name ? next : entry) }; },
    dispatch: async (item, profile, agents, snapshot, launch) => {
      launches.push({ key: item.key, canaries: launch?.canaries ?? [], exclude: launch?.exclude ?? [] });
      if (behave.dispatch) return behave.dispatch(item, profile, agents, snapshot, launch);
      const canary = launch?.canaries?.find(offer => offer.runtime === 'opencode');
      launch?.onRuntime?.('opencode');
      return { epoch: 1, runtime: 'opencode', runtimeStartedAt: iso(now), canary: canary ? { runtime: canary.runtime, failed: null } : null };
    },
  };
  const cycle = async (at: number) => { now = at; await runCycle(config, state, effects, () => now, undefined, () => {}); };
  return { state, launches, switched, cycle, behave, registry: () => registry };
}

test('unit:runtime-canary-and-backoff — the newest installed version beside the pinned one is the canary, compared as versions, and the newest when the pinned one is gone', () => {
  assert.deepEqual(canaryOffer(runtime('2.2.4')), { runtime: 'opencode', entry: join(installs, '2.2.5', 'bin'), version: '2.2.5' }, 'the installed directories are read; latest is not a version');
  // Versions compare numerically: 2.10.0 releases above 2.2.5 and its prerelease below it.
  const versions = (names: string[]) => () => names;
  assert.equal(canaryOffer(runtime('2.2.4'), versions(['2.2.4', '2.10.0', 'latest']))?.version, '2.10.0');
  assert.equal(canaryOffer(runtime('2.10.0'), versions(['2.10.0', '2.10.0-rc.1', '2.9.9'])), null, 'the pinned version is the newest: no canary');
  assert.equal(canaryOffer(runtime('2.2.4'), versions(['2.2.5', '2.2.6']))?.version, '2.2.6', 'a pinned directory that no longer exists makes the newest the canary');
  assert.equal(canaryOffer({ name: 'claude', launch: { kind: 'claude', environment: { PATH: '/usr/bin:/bin' } } } as unknown as FleetRuntime), null, 'a PATH not led by a versioned install has no canary');
});

test('unit:runtime-canary-and-backoff — one session runs the newer version while the fleet stays pinned, and a canary past 60 s switches the runtime through runtime.set with its reason', async () => {
  const items = [work('one', 'GY-1'), work('two', 'GY-2')];
  const run = harness(items);
  await run.cycle(t0);
  assert.equal(run.launches.length, 2);
  const newer = join(installs, '2.2.5', 'bin');
  assert.deepEqual(run.launches[0].canaries, [{ runtime: 'opencode', entry: newer, version: '2.2.5' }], 'the first launch is the canary');
  assert.deepEqual(run.launches[1].canaries, [], 'every other launch keeps the pinned version');
  assert.equal(run.state.canaries.opencode.epoch, 1);
  items[0] = { ...items[0], sessions: [session(t0)] } as Work;
  await run.cycle(t0 + 30_000);
  assert.equal(run.switched.length, 0, 'inside its first minute the canary has proved nothing');
  await run.cycle(t0 + 61_000);
  assert.equal(run.switched.length, 1);
  assert.equal(run.switched[0].runtime.launch.environment.PATH, `${newer}:/usr/bin:/bin`, 'only the pinned entry of PATH changes');
  assert.equal(run.switched[0].runtime.launch.environment.MISE_NO_CONFIG, '1');
  assert.match(run.switched[0].reason, /Canary GY-1 epoch 1 on opencode 2\.2\.5 ran 61 s; opencode now launches from .*2\.2\.5\/bin instead of .*2\.2\.4\/bin/);
  assert.deepEqual(run.state.canaries, {});
  // Pinned to the newest now: a later launch is no canary.
  items.push(work('three', 'GY-3'));
  await run.cycle(t0 + 90_000);
  assert.deepEqual(run.launches.at(-1), { key: 'GY-3', canaries: [], exclude: [] });

  // A commit proves the canary at once.
  const proved = harness([work('one', 'GY-1', { sessions: [session(t0, { workTree: { at: iso(t0 + 6_000), head: 'b'.repeat(40), dirty: null } })] } as Partial<Work>)]);
  await proved.cycle(t0);
  await proved.cycle(t0 + 7_000);
  assert.match(proved.switched[0]?.reason ?? '', /committed/);
});

test('unit:runtime-canary-and-backoff — a failed canary keeps the pinned version, is not retried, and wakes the master with its error', async () => {
  const items = [work('one', 'GY-1')];
  const run = harness(items);
  await run.cycle(t0);
  items[0] = { ...items[0], epoch: 1, sessions: [session(t0, { state: 'finished', endedAt: iso(t0 + 5_000), outcome: 'opencode exited: unknown flag --prompt' })] } as Work;
  await run.cycle(t0 + 10_000);
  assert.equal(run.switched.length, 0, 'the runtime stays pinned');
  assert.match(run.state.canaries.opencode.failed!, /unknown flag --prompt/);
  const causes = masterCauses(items, run.state.actions).filter(cause => cause.key === 'runtime-canary:opencode');
  assert.equal(causes.length, 1, 'the master is woken');
  assert.match(causes[0].detail, /canary of opencode 2\.2\.5 failed, so opencode stays on its pinned version: .*unknown flag --prompt/);
  items.push(work('two', 'GY-2'));
  await run.cycle(t0 + 20_000);
  assert.deepEqual(run.launches.at(-1)?.canaries, [], 'a failed version is not offered again');
  assert.equal(run.registry().runtimes[0].launch.environment.PATH.split(':')[0], join(installs, '2.2.4', 'bin'));

  // A canary whose runtime never starts fails the same way, from the dispatch itself.
  const refused = harness([work('one', 'GY-1')]);
  refused.behave.dispatch = async (_item, _profile, _agents, _snapshot, launch) => ({ epoch: 1, runtime: 'opencode', canary: { runtime: launch!.canaries![0].runtime, failed: 'opencode never started' } });
  await refused.cycle(t0);
  assert.match(refused.state.canaries.opencode.failed!, /never started/);
});

test('unit:runtime-canary-and-backoff — launch failures back off per runtime and item: 1 min doubling to 30 min, nine profiles count as one, a useful launch of the runtime resets it for the item', async () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 12].map(launchBackoffMs), [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000, 1_800_000]);
  const items = [work('x', 'GY-10')];
  const run = harness(items, { ...registryOf([runtime('2.2.5')]), roles: [{ name: 'worker', accounts: ['oc-a'] }] as AgentRegistry['roles'] });
  run.behave.dispatch = async (_item, _profile, _agents, _snapshot, launch) => { launch?.onRuntime?.('opencode'); throw new Error('opencode TUI exited'); };
  let at = t0;
  const attempts = () => run.launches.filter(launch => launch.key === 'GY-10').length;
  const waits: number[] = [];
  for (let failure = 1; failure <= 7; failure++) {
    await run.cycle(at);
    assert.equal(attempts(), failure, `failure ${failure} is one launch, not one per profile`);
    const wait = Date.parse(run.state.launchBackoff['opencode:x'].until) - at;
    waits.push(wait);
    await run.cycle(at + wait - 1_000);
    assert.equal(attempts(), failure, 'no profile launches the item inside its back-off');
    at += wait + 1;
  }
  assert.deepEqual(waits, [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000]);
  assert.equal(Object.keys(run.state.launchBackoff).length, 1, 'nine profiles of one runtime are one back-off');

  // Another runtime still launches the item, with the backed-off runtime's accounts excluded; other items are unaffected.
  const mixed = harness([work('x', 'GY-10'), work('y', 'GY-11')]);
  mixed.state.launchBackoff['opencode:x'] = { failures: 1, reason: 'opencode TUI exited', until: iso(t0 + 60_000) };
  mixed.behave.dispatch = async () => ({ epoch: 1 });
  await mixed.cycle(t0);
  assert.deepEqual(mixed.launches.map(launch => [launch.key, launch.exclude]), [['GY-10', ['oc-a']], ['GY-11', []]]);

  // A launch of the runtime for the item that outlives the failed-launch window clears its back-off; another item's back-off stands.
  const useful = work('x', 'GY-10', { epoch: 1, stage: 'build', ready: true, sessions: [session(t0 - 120_000, { host: 'machine-a', principal: 'worker-0' })] } as Partial<Work>);
  const reset = harness([useful]);
  reset.state.launchBackoff['opencode:x'] = { failures: 3, reason: 'opencode TUI exited', until: iso(t0 + 240_000) };
  reset.state.launchBackoff['opencode:z'] = { failures: 1, reason: 'opencode TUI exited', until: iso(t0 + 60_000) };
  await reset.cycle(t0);
  assert.deepEqual(Object.keys(reset.state.launchBackoff), ['opencode:z'], 'a successful launch of the runtime resets its back-off for that item');
});
