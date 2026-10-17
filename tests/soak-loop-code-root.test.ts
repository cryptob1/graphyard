import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { deploymentObservationSchema, emptyDaemonState, writeDaemonState, type DaemonState } from '../src/master-daemon.js';
import { daemonStatePath } from '../src/daemon/state.js';
import { alignRunningLoopUnit, heldCliSnapshotAt, heldCliPointer, holdCliAt, loadedHeldSnapshot, performSelfUpgrade, readHeldCli, type SelfUpgradeDeps, type SelfUpgradeOutcome } from '../src/daemon/upgrade.js';
import { daemonEffects } from '../src/daemon/effects-production.js';
import { alignLoopUnit, loopUnitOf } from '../src/supervisor.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { minute } from './helpers/soak-world.js';
import { soakControlPlanes } from './helpers/soak-plane.js';
import { upgradeRefusalAttention } from '../src/master/release-lag.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * GY-1899 under the real upgrade step for a simulated day: a managed repository and the Graphyard
 * checkout its loop runs from stand apart — the managed repository another clone of the same
 * history, standing at its own commit the CLI repository holds — and the loop's loaded-code reading,
 * its self-upgrade, its held-cli pin and its unit alignment all act on the CLI checkout alone, pass
 * after pass, across heads, a release lag, a dirty checkout and the restarts between. The soak of
 * the release-candidate concern (GY-404) in its own file: the world is the loop-code-root fixture
 * shape run for simulated hours, the production startup layering (run.ts:275-287: the wiring's own
 * `daemonEffects().loadedRelease`, then the held snapshot's commit when the loaded modules come from
 * one) is replayed at every restart, and the invariants are asserted after every single pass —
 * the managed repository's HEAD and tracked tree never move, the cursor records the checkout's or
 * the snapshot's commit and never the managed repository's HEAD, restarts stay at one per head (a
 * false reading of the shared managed commit would owe the same restart every pass), the pin is
 * written and lifted at most once per head, and no pin outlives its head.
 */

soakControlPlanes('soak-loop-code-root', 446);

// The one instant in the file, the day's start: the code under test takes now: () => clock, and
// `new Date(clock)` derives every observation stamp from it; nothing reads the wall clock.
const dayStart = 1_791_000_000_000;
/** One cycle of the simulated day: the clock advances this much between passes. */
const cycle = 10 * 60_000, hour = 6 * cycle;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.com', ...args], { encoding: 'utf8' }).trim();
/** The real child run the upgrade step gets: every git command it issues runs for real, in a fixture. */
const run = (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8' });

interface World {
  master: MasterConfig; managed: { root: string; head: string }; checkout: string; loaded: string; origin: string;
  state: DaemonState; unitPath: string; unitInput: { root: string; cliPath: string; repository: string; intervalSeconds: number };
  advance: (version: number) => Promise<string>;
  /** Every pass's outcome, the pin after it, and every restart's release, for the bounds the day asserts. */
  outcomes: string[]; pins: (string | null)[]; restarts: { to: string | null }[];
  /** Runs one pass ten simulated minutes later and asserts the invariants every pass must hold. */
  pass: (label: string) => Promise<SelfUpgradeOutcome>;
}

/** The day's world: one shared history, a managed clone at its own commit, a CLI checkout one move behind, a real cursor and unit file. */
async function world(label: string, options: { external?: boolean } = {}): Promise<World> {
  // The CLI checkout's history: base (the loaded commit), then the merged release, then heads pushed as the day runs.
  const seed = await temporaryDirectory(`soak-code-root-${label}-seed`), origin = await temporaryDirectory(`soak-code-root-${label}-origin`);
  await mkdir(join(seed, 'src'), { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  await writeFile(join(seed, 'src', 'loop.ts'), 'export const version = 0;\n');
  // The launcher's sanity read (`readHeldCli`) takes a snapshot for the CLI's code only when it holds src/cli.ts.
  await writeFile(join(seed, 'src', 'cli.ts'), 'export const cli = true;\n');
  git(seed, 'add', 'src/loop.ts', 'src/cli.ts');
  git(seed, 'commit', '-q', '-m', 'base');
  const loaded = git(seed, 'rev-parse', 'HEAD');
  git(origin, 'init', '-q', '--bare');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  await writeFile(join(seed, 'src', 'loop.ts'), 'export const version = 1;\n');
  git(seed, 'commit', '-q', '-am', 'merged release');
  git(seed, 'push', '-q', 'origin', 'main');
  const advance = async (version: number) => {
    await writeFile(join(seed, 'src', 'loop.ts'), `export const version = ${version};\n`);
    git(seed, 'commit', '-q', '-am', `merged release ${version}`);
    git(seed, 'push', '-q', 'origin', 'main');
    return git(seed, 'rev-parse', 'HEAD');
  };
  // The checkout the loop runs from, clean and detached one move behind the tip; the managed
  // repository, another clone of the same history standing at the tip — a commit the CLI
  // repository holds, whose HEAD a wrong startup read would take for the loop's release.
  const checkout = await temporaryDirectory(`soak-code-root-${label}-cli`);
  git(checkout, 'init', '-q');
  git(checkout, 'remote', 'add', 'origin', origin);
  git(checkout, 'fetch', '-q', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  git(checkout, 'checkout', '-q', '--detach', loaded);
  const managedRoot = await temporaryDirectory(`soak-code-root-${label}-managed`);
  if (options.external) {
    // GY-1958: an external install — the managed repository is another project, its own history
    // and its own origin, whose base branch shares the name `main` with Graphyard's.
    const appOrigin = await temporaryDirectory(`soak-code-root-${label}-app-origin`);
    git(appOrigin, 'init', '-q', '--bare');
    git(managedRoot, 'init', '-q', '-b', 'main');
    await writeFile(join(managedRoot, 'app.txt'), 'the managed app\n');
    git(managedRoot, 'add', 'app.txt');
    git(managedRoot, 'commit', '-q', '-m', 'app');
    git(managedRoot, 'remote', 'add', 'origin', appOrigin);
    git(managedRoot, 'push', '-q', 'origin', 'main');
  } else {
    git(managedRoot, 'init', '-q');
    git(managedRoot, 'remote', 'add', 'origin', origin);
    git(managedRoot, 'fetch', '-q', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    git(managedRoot, 'checkout', '-q', '--detach', 'origin/main');
  }
  // The control-plane configuration a managed repository carries in production, untracked like the real one.
  await mkdir(join(managedRoot, '.graphyard'), { recursive: true });
  await writeFile(join(managedRoot, '.graphyard', 'master.json'), '{}\n');
  const managed = { root: managedRoot, head: git(managedRoot, 'rev-parse', 'HEAD') };
  const credentials = await temporaryDirectory(`soak-code-root-${label}-credentials`);
  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(credentials, 'coordinator.token'),
    cliPath: join(checkout, 'bin', 'graphyard.mjs'), repository: 'owner/managed', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a',
    masterAgentName: 'graphyard-master-managed', autoMerge: true, mergeMethod: 'merge', workers: [] });
  // The loop unit as master init installed it, under a temporary home: the checkout's launcher, no pin.
  const home = await temporaryDirectory(`soak-code-root-${label}-home`);
  const unitDirectory = join(home, '.config', 'systemd', 'user');
  await mkdir(unitDirectory, { recursive: true });
  const unitName = loopUnitOf(managed.root), unitPath = join(unitDirectory, unitName);
  const unitInput = { root: managed.root, cliPath: master.cliPath, repository: master.repository, intervalSeconds: master.run.intervalSeconds };
  const { loopUnitText } = await import('../src/supervisor.js');
  await writeFile(unitPath, loopUnitText({ ...unitInput, heldLauncher: null }));
  const host = { home, platform: 'linux' as const, temporaryDirectories: [join(home, 'elsewhere')],
    run: (command: string, args: string[]) => (args[1] === 'is-enabled' ? 'enabled' : args[1] === 'is-active' ? 'active' : '') };
  const state = emptyDaemonState(master);
  state.release = { commit: loaded, dirty: false };
  await writeDaemonState(master, state);
  // The simulated clock, the production startup layering, and the pass.
  let clock = dayStart;
  /** The startup reading a restarted process records (run.ts:275-287): the wiring reads the CLI checkout; a held snapshot's commit stands over it when the loaded modules come from one — the dirty-checkout restarts load the snapshot, the checkout restarts load the checkout. */
  const loadedHeld = (commit: string) => loadedHeldSnapshot(checkout, join(heldCliSnapshotAt(checkout, commit), 'src', 'daemon', 'upgrade.ts'));
  const startupRelease = async () => {
    const reading = daemonEffects(managed.root, master, { snapshot: async () => ({ work: [], now: new Date(clock).toISOString() }), mutate: async () => ({}), run }).loadedRelease ?? null;
    const pin = readHeldCli(checkout);
    const fromSnapshot = pin !== null && git(checkout, 'status', '--porcelain', '--untracked-files=no') !== '';
    const snapshot = fromSnapshot ? loadedHeld(pin) : null;
    return snapshot ? { commit: snapshot, dirty: false } : reading;
  };
  const w: World = {
    master, managed, checkout, loaded, origin, state, unitPath, unitInput, advance,
    outcomes: [], pins: [], restarts: [],
    async pass(label: string) {
      clock += cycle;
      const restartsBefore = w.restarts.length;
      const outcome = await performSelfUpgrade(master, state, {
        root: managed.root, run, now: () => clock,
        persist: async written => writeDaemonState(master, written),
        alignUnit: async () => alignRunningLoopUnit(managed.root, master, unitName, input => alignLoopUnit(input, host)),
        alignExecutorUnits: async () => ({ wrote: 'updated', reason: null }),
        restartExecutors: async to => ({ result: 'restarted' as const, reason: null, coordinator: { commit: to }, held: [], restarted: [], unsupervised: [], forgotten: [] }),
        restartSelf: async () => { state.release = await startupRelease(); w.restarts.push({ to: state.release?.commit ?? null }); },
      } satisfies SelfUpgradeDeps);
      w.outcomes.push(outcome.outcome);
      w.pins.push(readHeldCli(checkout));
      // The invariants every pass of the day must hold, whichever step ran.
      assert.equal(git(managed.root, 'rev-parse', 'HEAD'), managed.head, `${label}: the managed repository's HEAD never moves`);
      assert.equal(git(managed.root, 'status', '--porcelain', '--untracked-files=no'), '', `${label}: the managed repository's tracked tree never changes`);
      assert.ok(!existsSync(heldCliPointer(managed.root)), `${label}: no pin ever lands on the managed repository`);
      const release = state.release?.commit ?? null;
      assert.notEqual(release, managed.head, `${label}: the loop never reports the managed repository's HEAD, however much history they share`);
      const standing = git(checkout, 'rev-parse', 'HEAD'), pin = readHeldCli(checkout);
      assert.ok(release !== null && (release === standing || (pin !== null && release === pin)), `${label}: the cursor records the checkout's standing or the held snapshot, never anything else (${release} vs ${standing}/${pin})`);
      const unit = await readFile(unitPath, 'utf8');
      const launcher = pin ? join(heldCliSnapshotAt(checkout, pin), 'bin', 'graphyard.mjs') : master.cliPath;
      // The unit follows the pin at the restart points (GY-1790: the loop unit is pointed before
      // anything restarts, and returned on the lift) — not while a held promotion only pins.
      if (w.restarts.length > restartsBefore || outcome.outcome === 'up-to-date')
        assert.ok(unit.includes(`ExecStart=${process.execPath} ${launcher} master run`), `${label}: the loop unit starts the launcher the pin requires now (${launcher}): ${unit.split('\n').find(line => line.startsWith('ExecStart'))}`);
      return outcome;
    },
  };
  return w;
}

/** The pin changed at most twice per head: placed once and lifted once, never thrashed. */
function assertPinBounds(world: World, heads: number, label: string) {
  const changes = world.pins.filter((pin, index) => index > 0 && pin !== world.pins[index - 1]).length;
  assert.ok(changes <= 2 * heads, `${label}: at most one place and one lift per head, never thrash (${changes} pin writes across ${heads} heads): ${JSON.stringify(world.pins)}`);
  assert.equal(world.pins[world.pins.length - 1], null, `${label}: the day ends with no pin standing`);
}

test('manual:loop-code-root-clean-day — over a simulated day of three merged heads on distinct managed and CLI roots, every pass leaves the managed repository untouched, every restart loads the head it restarted onto and never the managed clone\u2019s shared commit, each head costs exactly one restart and no pin, and the cursor carries each head forward', { timeout: 300_000 }, async () => {
  const w = await world('clean');
  // The heads merge one at a time: each is the base tip the day's passes fetch, and each is
  // deployed before the passes that align with it run.
  for (const [index, version] of [2, 3, 4].entries()) {
    const head = await w.advance(version);
    const before = w.restarts.length;
    w.state.deployment = deploymentObservationSchema.parse({ source: 'endpoint', sha: head, at: new Date(dayStart + (index + 1) * 4 * hour).toISOString(), reason: null, deployed: ['GY-1'], pending: [] });
    const first = await w.pass(`clean day, head ${index + 1}, first pass`);
    assert.equal(first.outcome, 'upgraded', JSON.stringify(first));
    assert.equal(first.code, true, 'the head touches loaded code');
    assert.deepEqual(w.restarts.slice(before), [{ to: head }], 'exactly one restart, onto the head');
    assert.deepEqual(w.state.release, { commit: head, dirty: false }, 'the restarted loop reports the checkout it runs');
    assert.equal(w.pins.at(-1), null, 'a clean checkout holds no pin');
    for (const idle of [1, 2]) {
      const pass = await w.pass(`clean day, head ${index + 1}, idle ${idle}`);
      assert.equal(pass.outcome, 'skipped', JSON.stringify(pass));
    }
  }
  assert.equal(w.restarts.length, 3, 'one restart per head across the day — a false reading of the managed clone\u2019s shared commit would owe the same restart again every pass');
  assertPinBounds(w, 3, 'clean day');
});

test('manual:loop-code-root-holds-day — the same world through a release-lagged promotion and a dirty checkout: the served release is pinned under the CLI checkout until the plane catches up, the dirty head restarts onto its held snapshot with the checkout left behind, both pins lift in the day, and the managed repository is never touched', { timeout: 300_000 }, async () => {
  const w = await world('holds');
  // Head one merged and deployed, while production still serves the release the loop runs: the
  // restart is held, the launcher pinned to the served release under the CLI checkout.
  const lagged = await w.advance(2);
  w.state.deployment = deploymentObservationSchema.parse({ source: 'endpoint', sha: w.loaded, at: new Date(dayStart + hour).toISOString(), reason: null, deployed: ['GY-1'], pending: [] });
  const held = await w.pass('holds day, lagged head, first pass');
  assert.equal(held.outcome, 'pending', JSON.stringify(held));
  assert.equal(w.state.upgrade.stalled?.cause, 'release-lagged');
  assert.equal(w.pins.at(-1), w.loaded, 'the served release is pinned, under the CLI checkout');
  assert.equal(git(w.checkout, 'rev-parse', 'HEAD'), lagged, 'the checkout moved; only the restart is held');
  const still = await w.pass('holds day, lagged head, second pass');
  assert.equal(still.outcome, 'pending', JSON.stringify(still));
  assert.deepEqual(w.restarts, [], 'nothing restarts while the plane lags');
  // Production catches up: the held restart completes onto the checkout, the pin lifts.
  w.state.deployment = deploymentObservationSchema.parse({ source: 'endpoint', sha: lagged, at: new Date(dayStart + 2 * hour).toISOString(), reason: null, deployed: ['GY-1'], pending: [] });
  const served = await w.pass('holds day, lagged head, served');
  assert.equal(served.outcome, 'upgraded', JSON.stringify(served));
  assert.deepEqual(w.restarts, [{ to: lagged }], 'one restart for the head, onto the checkout');
  assert.deepEqual(w.state.release, { commit: lagged, dirty: false });
  assert.equal(w.pins.at(-1), null, 'the pin lifted once the plane served the move');

  // Head two lands while the checkout stands dirty in a tracked file: the upgrade leaves it where
  // it stands, restarts onto its held snapshot, and the cursor names the checkout left behind.
  const dirtyHead = await w.advance(3);
  await writeFile(join(w.checkout, 'src', 'loop.ts'), 'export const version = 2; // work in progress\n');
  w.state.deployment = deploymentObservationSchema.parse({ source: 'endpoint', sha: dirtyHead, at: new Date(dayStart + 3 * hour).toISOString(), reason: null, deployed: ['GY-1'], pending: [] });
  const snapshotted = await w.pass('holds day, dirty head, snapshot pass');
  assert.equal(snapshotted.outcome, 'upgraded', JSON.stringify(snapshotted));
  assert.equal(git(w.checkout, 'rev-parse', 'HEAD'), lagged, 'the dirty checkout stays where the served pass left it');
  assert.deepEqual({ commit: w.state.upgrade.snapshot!.commit, checkout: w.state.upgrade.snapshot!.checkout, dirty: w.state.upgrade.snapshot!.dirty }, { commit: dirtyHead, checkout: lagged, dirty: ['src/loop.ts'] });
  assert.deepEqual(w.restarts.slice(1), [{ to: dirtyHead }], 'the restarted loop loaded the held snapshot');
  assert.deepEqual(w.state.release, { commit: dirtyHead, dirty: false }, 'the cursor records the snapshot the loop runs, never the managed clone\u2019s commit');
  assert.equal(w.pins.at(-1), dirtyHead, 'the snapshot is pinned, under the CLI checkout');
  // The checkout moved onto the commit the loop runs from its snapshot and cleaned there: the pin
  // lifts, nothing restarts, and the day ends clean.
  git(w.checkout, 'checkout', '-q', '--', 'src/loop.ts');
  git(w.checkout, 'checkout', '-q', '--detach', dirtyHead);
  // The checkout now stands clean on the commit the loop runs from its held snapshot.
  const lifted = await w.pass('holds day, dirty head, lift pass');
  assert.equal(lifted.outcome, 'up-to-date', JSON.stringify(lifted));
  assert.deepEqual(w.restarts, [{ to: lagged }, { to: dirtyHead }], 'one restart per head across the whole day');
  const idle = await w.pass('holds day, final idle pass');
  assert.equal(idle.outcome, 'skipped', JSON.stringify(idle));
  assert.equal(w.state.upgrade.snapshot, undefined, 'the lift cleared the record of the checkout left behind');
  assertPinBounds(w, 2, 'holds day');
});

/**
 * The same concern under the real loop (tests/helpers/soak-simulation.ts, `codeRoot`): the managed
 * repository stays /soak/coordinator while the loop's launcher comes from a separate Graphyard
 * checkout, and every cycle runs the real loop with its system invariants. The day's own invariants
 * add, after every cycle: every git command the self-upgrade issues targets the CLI checkout; at each
 * loop restart the unit the production alignment renders starts the launcher the pin requires and
 * hands it the CLI checkout while a pin stands; at each fleet restart the executor unit the real
 * renderer wrote starts the snapshot's entry handed the CLI checkout, or the CLI checkout's own
 * entry once the pin lifts — both always working in the managed repository.
 */
async function codeRoot(label: string) {
  const root = await temporaryDirectory(`soak-code-root-${label}-day`);
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'graphyard-executor.mjs'), '// entry\n');
  return root;
}
const hours = (count: number) => count * 6 * cycle;
type Day = Awaited<ReturnType<typeof simulateDay>>;
/** What every distinct-roots day must show, whichever holds it ran through. */
function assertDistinctRoots(day: Day, root: string, label: string, snapshots: boolean) {
  const c = day.codeRootDay!;
  assert.deepEqual(day.violations, [], `${label}: every system invariant and every checkout binding holds after every cycle`);
  assert.deepEqual(day.lost, [], `${label}: no lease was lost`);
  assert.deepEqual([...c.gitRoots], [root], `${label}: the self-upgrade ran git only in the CLI checkout, never in the managed repository`);
  const held = c.loopUnits.filter(unit => unit.pin), free = c.loopUnits.filter(unit => !unit.pin);
  // A snapshot restart points the loop unit while its pin stands; a release-lag hold only pins, and its lift restarts onto the checkout.
  assert.ok((snapshots ? held.length > 0 : held.length === 0) && free.length > 0, `${label}: the loop unit was aligned while a pin stood (${held.length}) and after it lifted (${free.length})`);
  assert.ok(held.every(unit => unit.handed === root && unit.launcher === join(root, '.graphyard', 'held-cli', unit.pin!.slice(0, 12), 'bin', 'graphyard.mjs')), `${label}: a held loop unit starts the snapshot under the CLI checkout and hands that checkout: ${JSON.stringify(held.find(unit => unit.handed !== root))}`);
  assert.ok(free.every(unit => unit.handed === null && unit.launcher === join(root, 'bin', 'graphyard.mjs')), `${label}: an unpinned loop unit starts the CLI checkout's launcher, handed nothing`);
  assert.ok(c.loopUnits.every(unit => unit.working === '/soak/coordinator'), `${label}: the loop always works in the managed repository`);
  assert.ok(c.executorUnits.some(unit => unit.pin) === snapshots && c.executorUnits.every(unit => unit.working === '/soak/coordinator' && (unit.entry === join(root, 'scripts', 'graphyard-executor.mjs') ? unit.handed === null : unit.handed === root)), `${label}: executor units start the CLI checkout's entry, or a snapshot's handed the CLI checkout: ${JSON.stringify(c.executorUnits)}`);
  assert.ok(day.upgrades.self >= 2, `${label}: the loop restarted onto more than one head (${day.upgrades.self})`);
  assert.equal(day.state.release?.commit, day.checkout.head, `${label}: the day ends with the loop reporting the CLI checkout's commit`);
  assert.ok(day.upgrades.pins.some(pin => pin.commit), `${label}: the day pinned a release under the CLI checkout`);
  assert.equal(day.upgrades.samples.at(-1)?.pin, null, `${label}: no pin outlives the day`);
  assert.equal(readHeldCli(root), null, `${label}: the pin's pointer under the CLI checkout is lifted`);
}

test('manual:loop-code-root-real-loop-snapshot-day — the real loop over a simulated day with the CLI checkout apart from the managed repository: two deploys restart it onto held snapshots of a dirty checkout and the lift returns it, with every git command on the CLI checkout and every loop and executor unit binding the CLI checkout\u2019s launcher or its snapshot', { timeout: 600_000 }, async () => {
  const root = await codeRoot('snapshot');
  const day = await simulateDay({ hours: 8, dirtyLift: true, codeRoot: root,
    plan: { deploys: [hours(2), hours(4)], dirtyCheckout: { from: hours(1), to: hours(6) }, headMove: { from: hours(99), to: hours(100) }, heldClaimRestarts: 0, deaths: new Set() } });
  assert.deepEqual(day.failures, [], 'no cycle or self-upgrade failed');
  assert.ok(day.upgrades.samples.some(sample => sample.snapshot && sample.pin), 'the loop ran a held snapshot of the dirty checkout');
  assertDistinctRoots(day, root, 'snapshot day', true);
});

test('manual:loop-code-root-real-loop-release-lag-day — the real loop over a simulated day whose deploys lag the base tip, with the CLI checkout apart from the managed repository: each hold pins the served release under the CLI checkout, the units start its snapshot handed that checkout, and each lift restarts the loop and the fleet onto the CLI checkout\u2019s commit', { timeout: 600_000 }, async () => {
  const root = await codeRoot('lag');
  const plan = { items: 16, heldClaimRestarts: 0, leftovers: 0, slowRecompute: 0, unstable: 0, attested: 0, workMs: 15 * minute, rework: new Set<number>(), deaths: new Set<number>(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set<number>(), misread: new Set<number>(), exits: new Set<number>(), spentProducer: 0, lostRuns: 0,
    outOfQueue: { item: 16, afterMs: hours(99) }, blind: { from: hours(99), to: hours(100) }, split: { at: hours(99), item: 16 }, loopRestarts: [] as number[], dirtyCheckout: { from: hours(99), to: hours(100) }, headMove: { from: hours(99), to: hours(100) },
    deploys: [90 * minute, hours(3), hours(4) + 30 * minute, hours(6)] };
  const day = await simulateDay({ hours: 7, plan, releaseLag: { cutAgoMs: 30 * minute }, codeRoot: root });
  assert.deepEqual(day.failures, [], 'no cycle or self-upgrade failed');
  const r = day.releaseLagDay!;
  assert.ok(r.passes.some(pass => pass.stall === 'release-lagged' && pass.pin), 'the day held a restart with the served release pinned');
  assert.deepEqual(r.restarts.filter(restart => !restart.contained), [], 'every restart landed on a commit the served release contains');
  assertDistinctRoots(day, root, 'release-lag day', false);
});

test('manual:loop-code-root-external-install-day — an install managing another project over a simulated day of Graphyard heads and app deploys: the legacy pin and owed restart an earlier loop left are retired on the first pass, then every pass refuses with one standing action row and one unchanging attention, writes nothing to the cursor, restarts nothing, and never fetches in or moves the CLI checkout or the managed repository', { timeout: 300_000 }, async () => {
  const w = await world('external', { external: true });
  const originTip = () => git(w.checkout, 'rev-parse', 'refs/remotes/origin/main');
  const fetched = originTip();
  // What the pre-GY-1958 loop left: a held snapshot pinned under the CLI checkout and a restart owed.
  await holdCliAt(w.checkout, run, w.loaded);
  w.state.upgrade.snapshot = { at: new Date(dayStart).toISOString(), commit: w.loaded, checkout: w.loaded, dirty: ['src/loop.ts'] };
  w.state.upgrade.pending = { from: null, to: w.loaded, code: true };
  w.state.upgrade.stalled = { cause: 'executors-refused', reason: 'a claim was in flight', since: new Date(dayStart).toISOString(), at: new Date(dayStart).toISOString() };
  const cursor = daemonStatePath(w.master);
  const attentions = new Set<string>();
  let written: string | null = null;
  // A day: Graphyard's own main advances every four hours while the app deploys every cycle.
  for (let pass = 0; pass < 6 * 24; pass++) {
    if (pass % 24 === 12) await w.advance(10 + pass);
    w.state.deployment = deploymentObservationSchema.parse({ source: 'endpoint', sha: w.managed.head, at: new Date(dayStart + pass * cycle).toISOString(), reason: null, deployed: [`GY-${pass + 1}`], pending: [] });
    const outcome = await w.pass(`external day, pass ${pass}`);
    assert.equal(outcome.outcome, 'refused', JSON.stringify(outcome));
    assert.equal(git(w.checkout, 'rev-parse', 'HEAD'), w.loaded, `pass ${pass}: the CLI checkout never moves`);
    assert.equal(originTip(), fetched, `pass ${pass}: nothing is fetched into the CLI checkout`);
    assert.equal(w.pins.at(-1), null, `pass ${pass}: the legacy pin is lifted and no pin is placed`);
    assert.equal(w.state.upgrade.pending, null);
    assert.equal(w.state.upgrade.snapshot, undefined);
    assert.equal(w.state.upgrade.stalled, undefined, `pass ${pass}: no stall stands`);
    for (const item of upgradeRefusalAttention(w.state.upgrade.refused, w.managed.root, 'main')) attentions.add(`${item.text}\n${item.next}`);
    // From the second pass on the cursor on disk is never rewritten: the standing refusal wakes nothing.
    if (pass === 1) { written = await readFile(cursor, 'utf8'); assert.match(written, /upgrade:refused/); }
    if (pass > 1) assert.equal(await readFile(cursor, 'utf8').catch(() => null), written, `pass ${pass}: an idle refusal writes nothing`);
  }
  assert.equal(w.restarts.length, 0, 'an external install never restarts itself onto Graphyard code');
  assert.equal(w.state.actions['upgrade:refused']?.attempts, 1, 'one deduplicated action row for the whole day');
  assert.equal(w.state.actions['upgrade:align']?.state, 'done', 'the retirement is recorded once');
  assert.equal(attentions.size, 1, `one unchanging attention across the day: ${[...attentions].join(' | ')}`);
  assert.match([...attentions][0], /graphyard up\b/);
  assert.doesNotMatch([...attentions][0], /checkout --detach/);
});
