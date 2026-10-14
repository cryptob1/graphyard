import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { deploymentObservationSchema, emptyDaemonState, type DaemonState } from '../src/master-daemon.js';
import * as upgrade from '../src/daemon/upgrade.js';
import type { SelfUpgradeDeps, SelfUpgradeOutcome } from '../src/daemon/upgrade.js';
import { coordinatorCheckoutGuard } from '../src/daemon/run.js';
import { loopUnitText, type LoopUnitInput } from '../src/supervisor.js';
import type { CoordinatorCheckout } from '../src/master/profiles.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1790: a checkout dirtied after a refused or failed restart, with HEAD still at the loop's
// release and nothing newer merged, is never snapshotted — the pending restart reloads from the
// dirty tree. The retried restart goes onto a held-cli snapshot of the commit with the launcher
// pinned to it, the checkout left behind with its dirty paths, and a status read that fails is
// never taken for clean. Git quotes pathnames holding a quote, an awkward space or an arrow, so
// every path the upgrade records or classifies is read unquoted; a launcher the checkout holds
// dirty never decides what loads — the units start the launcher held in the snapshot, with the
// checkout handed to it, and a hostile checkout launcher is never the code that boots. Real
// repositories and the shipped git and launcher throughout; the fleet, the supervisor and the
// unit alignments are recorded fakes. Each
// test is named for the proof it produces: unit:pending-restart-dirty-checkout-snapshots,
// unit:dirty-path-porcelain-unquoted, unit:snapshot-upgrade-survives-head-drift,
// unit:pending-restart-unknown-dirty-keeps-pin, unit:dirty-launcher-restarts-from-snapshot-launcher.

const clock = Date.parse('2030-01-01T12:00:00.000Z');
const iso = (offsetMs = 0) => new Date(clock + offsetMs).toISOString();
const short = (commit: string) => commit.slice(0, 12);
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = async (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const verified = (sha: string): DaemonState['deployment'] => deploymentObservationSchema.parse({ source: 'endpoint', sha, at: iso(), reason: null, deployed: ['GY-1'], pending: [] });
const restarted = (to: string) => ({ result: 'restarted' as const, reason: null, coordinator: { commit: to }, held: [], restarted: [], unsupervised: [], forgotten: [] });
const status = (root: string) => execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trimEnd();

/**
 * An origin holding release A and the merged tip B, and the coordinator checkout: a clone of it
 * detached at A, with the shipped launcher beside it so what the pin does to spawned commands is
 * observable, and a master configuration whose cursor lives in its own directory. `seed` adds
 * files before A is committed (a dirty tree needs them at A); `tip` replaces the change B is.
 */
async function world(label: string, options: { seed?: (origin: string) => Promise<void> | void; tip?: (origin: string) => Promise<void> | void } = {}) {
  const origin = await temporaryDirectory(`${label}-origin`);
  const cli = (release: string) => `import { z } from 'zod';\nexport const release: string = '${release}';\nconsole.log(JSON.stringify({ release, argv: process.argv[1], schema: typeof z }));\n`;
  await mkdir(join(origin, 'src', 'daemon'), { recursive: true });
  await writeFile(join(origin, 'src', 'cli.ts'), cli('A'));
  await writeFile(join(origin, 'src', 'daemon', 'state.ts'), "export const upgradeStallCauses = ['checkout-failed', 'release-lagged', 'snapshot-failed'] as const;\n");
  await writeFile(join(origin, 'package.json'), '{ "type": "module" }\n');
  await writeFile(join(origin, 'README.md'), 'release A\n');
  await writeFile(join(origin, 'tsconfig.json'), '{}\n');
  await writeFile(join(origin, 'docs.md'), 'docs for A\n');
  await options.seed?.(origin);
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'add', '.');
  git(origin, 'commit', '-q', '-m', 'release A');
  const loaded = git(origin, 'rev-parse', 'HEAD');
  if (options.tip) await options.tip(origin); else await writeFile(join(origin, 'src', 'cli.ts'), cli('B'));
  git(origin, 'commit', '-q', '-am', 'release B');
  const tip = git(origin, 'rev-parse', 'HEAD');
  const root = await temporaryDirectory(`${label}-checkout`);
  execFileSync('git', ['clone', '-q', origin, root], { stdio: 'ignore' });
  git(root, 'checkout', '-q', '--detach', loaded);
  await mkdir(join(root, 'bin'), { recursive: true });
  for (const file of ['graphyard.mjs', 'held-release-hooks.mjs']) await writeFile(join(root, 'bin', file), await readFile(fileURLToPath(new URL(`../bin/${file}`, import.meta.url))));
  await symlink(fileURLToPath(import.meta.resolve('tsx')).replace(/\/node_modules\/.*$/, '/node_modules'), join(root, 'node_modules'), 'dir');
  const directory = await temporaryDirectory(`${label}-credentials`);
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: join(root, 'bin', 'graphyard.mjs'),
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const launch = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [join(root, 'bin', 'graphyard.mjs'), ...args], { encoding: 'utf8' })) as { release: string; argv: string; schema: string };
  return { origin, root, directory, loaded, tip, master, launch, cli };
}

/** The upgrade's dependencies: the real checkout and git, a recorded fleet restart and self re-execution, the fixed clock. */
function recording(root: string) {
  const calls = { executors: [] as string[], self: 0 };
  const deps = (extra: Partial<SelfUpgradeDeps> = {}): SelfUpgradeDeps => ({ root, run,
    restartExecutors: async to => { calls.executors.push(to); return restarted(to); },
    restartSelf: async () => { calls.self += 1; }, persist: async () => {}, now: () => clock, ...extra });
  return { calls, deps };
}

/** The operator's edit: one tracked file B does not touch, so a later move onto B carries it. */
async function dirtied(root: string) {
  await writeFile(join(root, 'README.md'), 'release A, edited by the operator\n');
  assert.equal(status(root), ' M README.md');
  return ' M README.md';
}

/** The snapshot upgrade from a dirty checkout at A onto B, verified served, as the loop at A performs it. */
async function snapshotUpgrade(w: Awaited<ReturnType<typeof world>>) {
  const before = await dirtied(w.root);
  const state = emptyDaemonState(w.master);
  state.release = { commit: w.loaded, dirty: true };
  state.deployment = verified(w.tip);
  const { calls, deps } = recording(w.root);
  const upgraded = await performSelfUpgrade(w.master, state, deps());
  assert.equal(upgraded.outcome, 'upgraded', JSON.stringify(upgraded));
  return { before, state, calls, deps, upgraded, snapshot: upgrade.heldCliSnapshotAt(w.root, w.tip) };
}
const performSelfUpgrade = upgrade.performSelfUpgrade;
const readHeldCli = upgrade.readHeldCli;

test('unit:pending-restart-dirty-checkout-snapshots — a restart onto B pending after a refused or failed attempt, with the checkout then dirtied at B and nothing newer merged, retried loads a held-cli snapshot of B with the launcher pinned to it, the checkout left behind with its dirty paths; a clean checkout at B restarts from the checkout as before', async () => {
  // Refused: the alignment moved the checkout onto B, the executors held their claims, and the
  // operator dirtied the checkout while HEAD stayed at B. The retry never runs the dirty tree.
  const r = await world('pending-refused');
  git(r.root, 'fetch', '-q', 'origin');
  git(r.root, 'checkout', '-q', '--detach', r.tip);
  const before = await dirtied(r.root);
  const state = emptyDaemonState(r.master);
  state.release = { commit: r.loaded, dirty: false };
  state.deployment = verified(r.tip);
  state.upgrade.pending = { from: r.loaded, to: r.tip, code: true };
  state.upgrade.last = { at: iso(), from: r.loaded, to: r.tip, code: true, executors: 'refused: a claim was held', self: false };
  state.upgrade.stalled = { cause: 'executors-refused', reason: 'the executors were not restarted: a claim was held', since: iso(), at: iso() };
  const refused = recording(r.root);
  const done = await performSelfUpgrade(r.master, state, refused.deps());
  assert.deepEqual(done, { outcome: 'upgraded', from: r.loaded, to: r.tip, code: true, executors: restarted(r.tip), self: true, left: { checkout: r.tip, dirty: ['README.md'] } });
  assert.equal(readHeldCli(r.root), r.tip, 'the launcher is pinned to the snapshot of B');
  assert.equal(r.launch('watch', 'GY-1', '1').release, 'B', 'the restarted launcher loads the snapshot');
  assert.deepEqual(refused.calls, { executors: [r.tip], self: 1 });
  assert.deepEqual([git(r.root, 'rev-parse', 'HEAD'), status(r.root)], [r.tip, before], 'the checkout is untouched: HEAD where it stood, the edit intact');
  assert.deepEqual(state.upgrade.snapshot, { at: iso(), commit: r.tip, checkout: r.tip, dirty: ['README.md'] }, 'the cursor records the checkout left behind with its dirty paths');
  assert.equal(state.upgrade.pending ?? null, null, 'nothing stays owed');
  assert.equal(state.upgrade.stalled, undefined, 'the refusal stall is settled');

  // Failed: the re-execution failed after the cursor cleared the restart, the release it aligned
  // stands, and the checkout was dirtied at the tip since. The retried restart — no pending on
  // the cursor, the checkout holding newer code than the loop loaded — snapshots all the same.
  const f = await world('pending-failed');
  git(f.root, 'fetch', '-q', 'origin');
  git(f.root, 'checkout', '-q', '--detach', f.tip);
  const failedBefore = await dirtied(f.root);
  const failed = emptyDaemonState(f.master);
  failed.release = { commit: f.loaded, dirty: false };
  failed.deployment = verified(f.tip);
  failed.upgrade.alignedRelease = f.tip;
  failed.upgrade.last = { at: iso(), from: f.loaded, to: f.tip, code: true, executors: 'restarted', self: false };
  failed.upgrade.stalled = { cause: 'supervisor-unreachable', reason: 'the loop could not re-execute itself through its supervisor', since: iso(), at: iso() };
  const retried = recording(f.root);
  const retriedDone = await performSelfUpgrade(f.master, failed, retried.deps());
  assert.equal(retriedDone.outcome, 'upgraded', JSON.stringify(retriedDone));
  assert.deepEqual('left' in retriedDone && retriedDone.left, { checkout: f.tip, dirty: ['README.md'] }, 'the dirty checkout is left behind, never what restarts');
  assert.equal(readHeldCli(f.root), f.tip);
  assert.equal(f.launch('watch', 'GY-1', '1').release, 'B');
  assert.deepEqual(retried.calls, { executors: [f.tip], self: 1 });
  assert.deepEqual([git(f.root, 'rev-parse', 'HEAD'), status(f.root)], [f.tip, failedBefore], 'the checkout is untouched');

  // Clean: a checkout at B with no edit restarts from the checkout as before — no pin, no record.
  const c = await world('pending-clean');
  git(c.root, 'fetch', '-q', 'origin');
  git(c.root, 'checkout', '-q', '--detach', c.tip);
  const clean = emptyDaemonState(c.master);
  clean.release = { commit: c.loaded, dirty: false };
  clean.deployment = verified(c.tip);
  clean.upgrade.pending = { from: c.loaded, to: c.tip, code: true };
  const fromCheckout = recording(c.root);
  const cleanDone = await performSelfUpgrade(c.master, clean, fromCheckout.deps());
  assert.deepEqual(cleanDone, { outcome: 'upgraded', from: c.loaded, to: c.tip, code: true, executors: restarted(c.tip), self: true });
  assert.equal(readHeldCli(c.root), null, 'no pin stands for a clean checkout');
  assert.equal(clean.upgrade.snapshot, undefined);
  assert.deepEqual([git(c.root, 'rev-parse', 'HEAD'), status(c.root)], [c.tip, '']);
});

test('unit:dirty-path-porcelain-unquoted — a modified or staged path whose name git quotes (a quote or " -> " in it) is recorded in the upgrade cursor and classified by its real path, and a quoted rename records both its paths', async () => {
  const quoted = 'src/note "1".ts', arrowed = 'src/a -> "b".ts', renamedFrom = 'old "n".txt', renamedTo = 'new "n".txt';
  const w = await world('porcelain-unquoted', {
    seed: async origin => {
      await writeFile(join(origin, quoted), 'one\n');
      await writeFile(join(origin, arrowed), 'two\n');
      await writeFile(join(origin, renamedFrom), 'three\n');
    },
    // B changes only the quoted loaded path: the loaded-code decision must come from its real name.
    tip: origin => writeFile(join(origin, quoted), 'one, changed by B\n'),
  });
  const { root } = w;
  // The operator's tree: the quoted loaded path modified, the arrowed path modified, and a rename
  // of quoted paths staged. Git quotes every one of those names in its porcelain status.
  await writeFile(join(root, quoted), 'one, edited by the operator\n');
  await writeFile(join(root, arrowed), 'two, edited by the operator\n');
  git(root, 'mv', renamedFrom, renamedTo);
  const before = status(root);
  assert.match(before, /"src\/note \\"1\\"\.ts"/, 'git quotes the modified loaded path');
  assert.match(before, /"old \\"n\\"\.txt" -> "new \\"n\\"\.txt"/, 'git quotes both paths of the staged rename');
  const state = emptyDaemonState(w.master);
  state.release = { commit: w.loaded, dirty: true };
  state.deployment = verified(w.tip);
  const { calls, deps } = recording(root);
  const done = await performSelfUpgrade(w.master, state, deps());
  assert.equal(done.outcome, 'upgraded', JSON.stringify(done));
  // The diff from A to B names the quoted path too; classified by its real path it is loaded code,
  // so the executors restart — left quoted, the name would read as docs-only and nothing would.
  assert.deepEqual(calls.executors, [w.tip], 'the quoted loaded path is classified by its real path');
  assert.deepEqual(done.left?.dirty, [renamedFrom, renamedTo, arrowed, quoted], 'the cursor records every quoted path by its real name, a rename as both its paths');
  assert.deepEqual(state.upgrade.snapshot?.dirty, [renamedFrom, renamedTo, arrowed, quoted]);
  assert.equal(readHeldCli(root), w.tip, 'the launcher is pinned to the snapshot');
  assert.deepEqual([git(root, 'rev-parse', 'HEAD'), status(root)], [w.loaded, before], 'the checkout is untouched');
});

test('unit:snapshot-upgrade-survives-head-drift — a loop running a held-cli snapshot whose dirty coordinator checkout has its HEAD moved to another commit still takes later snapshot upgrades onto newer merged commits, and the moved HEAD stays reported as standing attention', async () => {
  const w = await world('head-drift');
  const { state, deps, snapshot } = await snapshotUpgrade(w);
  state.release = { commit: w.tip, dirty: false };
  // The operator moves the dirty checkout's HEAD by hand onto another commit C, and D merges.
  await writeFile(join(w.origin, 'docs.md'), 'docs for C\n');
  git(w.origin, 'commit', '-q', '-am', 'release C');
  git(w.root, 'fetch', '-q', 'origin');
  git(w.root, 'checkout', '-q', '--detach', git(w.origin, 'rev-parse', 'HEAD'));
  const movedTo = git(w.root, 'rev-parse', 'HEAD');
  assert.notEqual(movedTo, w.loaded);
  await writeFile(join(w.origin, 'src', 'cli.ts'), w.cli('D'));
  git(w.origin, 'commit', '-q', '-am', 'release D');
  const next = git(w.origin, 'rev-parse', 'HEAD');
  state.deployment = verified(next);
  const before = status(w.root);
  const second = recording(w.root);
  const upgraded = await performSelfUpgrade(w.master, state, second.deps({ loadedFrom: join(snapshot, 'src', 'daemon', 'upgrade.ts') }));
  assert.equal(upgraded.outcome, 'upgraded', JSON.stringify(upgraded));
  assert.deepEqual('left' in upgraded && upgraded.left, { checkout: movedTo, dirty: ['README.md'] }, 'the moved dirty checkout is left behind');
  assert.deepEqual(state.upgrade.snapshot, { at: iso(), commit: next, checkout: movedTo, dirty: ['README.md'] }, 'the snapshot upgrade lands on the newer merged commit');
  assert.equal(readHeldCli(w.root), next);
  assert.deepEqual(second.calls, { executors: [next], self: 1 });
  assert.deepEqual([git(w.root, 'rev-parse', 'HEAD'), status(w.root)], [movedTo, before], 'the moved checkout is untouched');

  // The loop's checkout guard (src/daemon/run.ts): a snapshot loop is not refused by the dirty
  // tree, its HEAD moving to another commit stays standing attention, and the self-upgrade the
  // guard skips for a checkout-loaded loop's drift is never withheld from a snapshot loop.
  const dirtyAt = (commit: string): CoordinatorCheckout => ({ root: w.root, commit, modified: ['README.md'], untracked: [] });
  const cleanAt = (commit: string): CoordinatorCheckout => ({ root: w.root, commit, modified: [], untracked: [] });
  let tree = dirtyAt(w.tip);
  const guardState = emptyDaemonState(w.master);
  const upgrades: DaemonState[] = [];
  const guard = coordinatorCheckoutGuard({ state: () => guardState, read: async () => tree, agents: async () => [], snapshot: async () => ({ work: [], now: iso() }),
    persist: async () => {}, now: () => clock, log: () => {}, applies: () => true, runsSnapshot: () => w.tip });
  const selfUpgrade = async (current: DaemonState): Promise<SelfUpgradeOutcome> => { upgrades.push(current); return { outcome: 'skipped', reason: 'recorded' }; };
  assert.equal(await guard.start(null), null, 'a snapshot loop is not refused by the dirty checkout it runs beside');
  tree = dirtyAt(movedTo);
  const dirtyMoved = await guard.betweenCycles(selfUpgrade);
  assert.ok(dirtyMoved.refusal, 'the moved dirty checkout is escalated');
  assert.match(dirtyMoved.refusal ?? '', /refuses to start, self-upgrade or restart/);
  assert.equal(guardState.actions['escalation:dirty-checkout']?.state, 'failed', 'the attention stands');
  assert.equal(upgrades.length, 1, 'the guard withholds no snapshot upgrade for it');
  // A clean moved HEAD is the drift refusal itself — still recorded, still no upgrade withheld.
  tree = cleanAt(movedTo);
  const cleanMoved = await guard.betweenCycles(selfUpgrade);
  assert.match(cleanMoved.refusal ?? '', new RegExp(`HEAD moved from ${short(w.tip)} to ${short(movedTo)}`), 'the HEAD drift is reported as standing attention');
  assert.equal(guardState.actions['escalation:dirty-checkout']?.state, 'failed');
  assert.equal(upgrades.length, 2, 'and still withholds no snapshot upgrade from a snapshot loop');
});

test('unit:pending-restart-unknown-dirty-keeps-pin — a pending restart whose checkout is at the target but whose git status read fails treats the checkout as possibly dirty: nothing restarts from it, the pin stands, and the failed read is recorded; and a clean detached checkout moved by hand to another commit while the pin stands keeps the pin and is reported as left behind', async () => {
  const unreadable: SelfUpgradeDeps['run'] = async (command, args) => { if (args.includes('status')) throw new Error('fatal: Unable to create index.lock: File exists'); return run(command, args); };
  // No pin yet: the restart is owed onto B, the checkout holds B, and its dirtiness cannot be read.
  const u = await world('unknown-dirty');
  git(u.root, 'fetch', '-q', 'origin');
  git(u.root, 'checkout', '-q', '--detach', u.tip);
  const state = emptyDaemonState(u.master);
  state.release = { commit: u.loaded, dirty: false };
  state.deployment = verified(u.tip);
  state.upgrade.pending = { from: u.loaded, to: u.tip, code: true };
  const owed = recording(u.root);
  const done = await performSelfUpgrade(u.master, state, owed.deps({ run: unreadable }));
  assert.deepEqual(done, { outcome: 'failed', reason: `the restart onto ${short(u.tip)} is still owed, but whether the coordinator checkout at ${short(u.tip)} is dirty could not be read; it is never taken for clean, retried next cycle` });
  assert.equal(state.actions['upgrade:align']?.state, 'failed', 'the failed read is recorded');
  assert.equal(state.upgrade.stalled?.cause, 'checkout-failed');
  assert.deepEqual(state.upgrade.pending, { from: u.loaded, to: u.tip, code: true }, 'the restart stays owed');
  assert.deepEqual(owed.calls, { executors: [], self: 0 }, 'nothing restarts from the checkout');
  assert.equal(git(u.root, 'rev-parse', 'HEAD'), u.tip, 'the checkout is untouched');
  assert.equal(readHeldCli(u.root), null);
  // With the pin standing the same failed read must not clear it: the loop on the snapshot keeps it.
  const p = await world('unknown-dirty-pin');
  const pinned = await snapshotUpgrade(p);
  pinned.state.release = { commit: p.tip, dirty: false };
  git(p.root, 'checkout', '-q', '--detach', p.tip);
  pinned.state.upgrade.pending = { from: p.loaded, to: p.tip, code: true };
  const kept = recording(p.root);
  const pinDone = await performSelfUpgrade(p.master, pinned.state, kept.deps({ loadedFrom: join(pinned.snapshot, 'src', 'daemon', 'upgrade.ts'), run: unreadable }));
  assert.equal(pinDone.outcome, 'failed', JSON.stringify(pinDone));
  assert.equal(readHeldCli(p.root), p.tip, 'the pin is not cleared');
  assert.deepEqual(kept.calls, { executors: [], self: 0 }, 'the loop and the executors are not restarted from the checkout');
  assert.deepEqual(pinned.state.upgrade.pending, { from: p.loaded, to: p.tip, code: true });

  // A clean detached checkout moved by hand to another commit while the pin stands: the pin keeps,
  // nothing lifts it, and the cursor names the checkout as left behind where it now stands.
  const m = await world('hand-moved');
  const moved = await snapshotUpgrade(m);
  moved.state.release = { commit: m.tip, dirty: false };
  git(m.root, 'checkout', '-q', '--', 'README.md');
  await writeFile(join(m.origin, 'docs.md'), 'docs for C\n');
  git(m.origin, 'commit', '-q', '-am', 'release C');
  git(m.root, 'fetch', '-q', 'origin');
  git(m.root, 'checkout', '-q', '--detach', git(m.origin, 'rev-parse', 'HEAD'));
  const byHand = git(m.root, 'rev-parse', 'HEAD');
  assert.notEqual(byHand, m.loaded);
  assert.equal(status(m.root), '', 'the moved checkout stands clean and detached');
  const pass = recording(m.root);
  const skipped = await performSelfUpgrade(m.master, moved.state, pass.deps({ loadedFrom: join(moved.snapshot, 'src', 'daemon', 'upgrade.ts') }));
  assert.equal(skipped.outcome, 'skipped', JSON.stringify(skipped));
  assert.equal(readHeldCli(m.root), m.tip, 'the pin keeps standing');
  assert.deepEqual(pass.calls, { executors: [], self: 0 }, 'nothing restarts');
  assert.deepEqual(moved.state.upgrade.snapshot, { at: iso(), commit: m.tip, checkout: byHand, dirty: [] }, 'the checkout is reported as left behind where it now stands');
  const named = upgrade.leftBehindCheckoutAttention(moved.state.upgrade.snapshot, m.tip, m.root);
  assert.equal(named.length, 1);
  assert.ok(named[0].text.includes(short(byHand)), 'master status names the checkout where it was moved to');
});

test('unit:dirty-launcher-restarts-from-snapshot-launcher — a checkout whose own launcher files are dirty still restarts onto the held snapshot by starting the launcher held in it: the supervisor units point into the snapshot, a checkout launcher that drops the held hooks and hooks that pin nothing never run, and the cursor records the checkout left behind instead of holding the restart as snapshot-failed', async () => {
  // The launcher is tracked at A, so the snapshot of B holds it too and what the units start is
  // the commit's own launcher. The operator's edits are hostile: the checkout's launcher drops the
  // held hooks from its spawn and marks every start, and its hooks pin nothing and mark every
  // process that loads them — if either ran, the checkout's own tree would load and the markers
  // would name it.
  const hooksOf = (name: string) => fileURLToPath(new URL(`../bin/${name}`, import.meta.url));
  const w = await world('dirty-launcher', {
    seed: async origin => {
      await mkdir(join(origin, 'bin'), { recursive: true });
      for (const file of ['graphyard.mjs', 'held-release-hooks.mjs']) await writeFile(join(origin, 'bin', file), await readFile(hooksOf(file)));
    },
  });
  const launcherMarker = join(w.root, 'checkout-launcher-ran.txt'), hooksMarker = join(w.root, 'edited-hooks-ran.txt');
  const shipped = await readFile(join(w.root, 'bin', 'graphyard.mjs'), 'utf8');
  const hostileLauncher = `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(launcherMarker)}, 'ran');\n${shipped.replace('...held(), ', '')}`;
  assert.ok(shipped.includes('...held()') && !hostileLauncher.includes('...held()'), 'the edit drops the held hooks from the spawn');
  await writeFile(join(w.root, 'bin', 'graphyard.mjs'), hostileLauncher);
  await writeFile(join(w.root, 'bin', 'held-release-hooks.mjs'), [
    '// edited by the operator: it pins nothing and marks every process that loads it',
    `import { appendFileSync } from 'node:fs';`,
    `appendFileSync(${JSON.stringify(hooksMarker)}, 'ran');`,
    'export function heldRelease() { return null; }',
    'export function initialize() {}',
    'export async function resolve(specifier, context, next) { return next(specifier, context); }',
    '',
  ].join('\n'));
  const before = status(w.root);
  assert.equal(before, ' M bin/graphyard.mjs\n M bin/held-release-hooks.mjs');
  const state = emptyDaemonState(w.master);
  state.release = { commit: w.loaded, dirty: true };
  state.deployment = verified(w.tip);
  const { calls, deps } = recording(w.root);
  // The unit alignments are recorded fakes, wired the way the loop wires them: the loop unit's
  // ExecStart follows the pin through alignRunningLoopUnit, and the executor units' entry is
  // pointed at the snapshot's own script before the fleet restarts.
  const captured: { unit: LoopUnitInput | null } = { unit: null };
  const executorScripts: (string | null)[] = [];
  const done = await performSelfUpgrade(w.master, state, deps({
    alignUnit: async () => {
      const unitDirectory = join(w.directory, 'units');
      await mkdir(unitDirectory, { recursive: true });
      const previous = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = unitDirectory;
      try {
        const aligned = await upgrade.alignRunningLoopUnit(w.root, w.master, 'graphyard-master.service', async input => { captured.unit = input; return { wrote: 'unchanged', reason: null, unitPath: 'unused' }; });
        return { wrote: aligned.wrote, reason: aligned.reason };
      } finally { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; }
    },
    alignExecutorUnits: async script => { executorScripts.push(script); return { wrote: 'updated', reason: null }; },
  }));
  const snapshot = upgrade.heldCliSnapshotAt(w.root, w.tip);
  assert.equal(done.outcome, 'upgraded', JSON.stringify(done));
  assert.deepEqual('left' in done && done.left, { checkout: w.loaded, dirty: ['bin/graphyard.mjs', 'bin/held-release-hooks.mjs'] }, 'the restart is not held as snapshot-failed; the checkout is named left behind with its dirty launcher paths');
  assert.equal(readHeldCli(w.root), w.tip, 'the launcher is pinned to the snapshot');
  assert.deepEqual(executorScripts, [join(snapshot, 'scripts', 'graphyard-executor.mjs')], 'the executor units are pointed at the snapshot\'s entry before the fleet restarts');
  assert.deepEqual(calls, { executors: [w.tip], self: 1 }, 'the executors and the loop restart onto the snapshot');
  assert.deepEqual([git(w.root, 'rev-parse', 'HEAD'), status(w.root)], [w.loaded, before], 'the checkout and its launcher are untouched');
  // The loop unit's ExecStart follows the pin: it names the launcher held in the snapshot and hands
  // it the checkout in the environment, never the checkout's own launcher while the pin stands.
  assert.ok(captured.unit, 'the loop unit is aligned while the pin stands');
  assert.equal(captured.unit.heldLauncher, join(snapshot, 'bin', 'graphyard.mjs'), 'the unit input carries the launcher held in the snapshot');
  assert.equal(upgrade.heldLauncherOf(w.root), join(snapshot, 'bin', 'graphyard.mjs'), 'the pin names the snapshot launcher');
  const unit = loopUnitText(captured.unit);
  assert.ok(unit.includes(`ExecStart=${process.execPath} ${join(snapshot, 'bin', 'graphyard.mjs')} master run`), 'the unit starts the launcher held in the snapshot');
  assert.ok(unit.includes(`Environment=GRAPHYARD_CHECKOUT_ROOT=${w.root}`), 'the unit hands the checkout root to the snapshot launcher');
  assert.ok(!unit.includes(`ExecStart=${process.execPath} ${w.master.cliPath} `), 'the checkout launcher is not what the unit starts while the pin stands');
  // What the supervisor starts after the restart is the snapshot's launcher with the checkout
  // handed to it: release B loads even though the checkout launcher registers no hooks and its
  // hooks pin nothing — the hostile edits never run.
  const started = JSON.parse(execFileSync(process.execPath, [join(snapshot, 'bin', 'graphyard.mjs'), 'watch', 'GY-1', '1'], { encoding: 'utf8', cwd: w.root, env: { ...process.env, GRAPHYARD_CHECKOUT_ROOT: w.root } })) as { release: string };
  assert.equal(started.release, 'B', 'the launcher held in the snapshot loads release B with the checkout handed to it');
  assert.equal(existsSync(launcherMarker), false, 'the checkout\'s hostile launcher never ran');
  assert.equal(existsSync(hooksMarker), false, 'the checkout\'s hostile hooks never ran');
});
