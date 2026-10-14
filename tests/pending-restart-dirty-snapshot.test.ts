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
import { alignExecutorUnitScript, checkoutRootVariable, renderExecutorUnit } from '../src/repository-setup.js';
import { installUnitsFile, perInstallUnits } from '../src/install/units.js';
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
// unit alignments are recorded fakes, except where the real unit renderer is the thing proved. Each
// test is named for the proof it produces: unit:pending-restart-dirty-checkout-snapshots,
// unit:dirty-path-porcelain-unquoted, unit:snapshot-upgrade-survives-head-drift,
// unit:pending-restart-unknown-dirty-keeps-pin, unit:dirty-launcher-restarts-from-snapshot-launcher;
// and, from the review of PR #1201: unit:moved-dirty-checkout-hold-keeps-served-pin (a dirtied
// checkout moved onto an unserved commit is pinned to the served release for the hold),
// unit:executor-unit-render-idempotent (re-rendering a unit the pin already rendered changes
// nothing, and the lift leaves no handed-checkout line), unit:snapshot-lift-returns-the-units (a
// clean restart from a snapshot loop returns the executor units, and a lift keeps its record until
// the loop unit is rewritten).

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
  assert.match(named[0].text, new RegExp(`stands clean at ${short(byHand)}, moved there by hand while the pin stands`), 'and says it stands clean there, never that it stood dirty');
  // The rule holds on every pass, not only the one that saw the move: standing clean at the
  // foreign commit on the next pass is not the cleaning of a checkout left behind dirty, so the
  // pin keeps standing and nothing is aligned or restarted from it.
  const again = recording(m.root);
  const skippedAgain = await performSelfUpgrade(m.master, moved.state, again.deps({ loadedFrom: join(moved.snapshot, 'src', 'daemon', 'upgrade.ts') }));
  assert.equal(skippedAgain.outcome, 'skipped', JSON.stringify(skippedAgain));
  assert.match('reason' in skippedAgain ? skippedAgain.reason : '', /moved there by hand while the loop runs its held snapshot/);
  assert.equal(readHeldCli(m.root), m.tip, 'the pin keeps standing on the next pass too');
  assert.deepEqual(again.calls, { executors: [], self: 0 });
  assert.deepEqual(moved.state.upgrade.snapshot, { at: iso(), commit: m.tip, checkout: byHand, dirty: [] }, 'the record is unchanged');
  assert.equal(git(m.root, 'rev-parse', 'HEAD'), byHand, 'the moved checkout is not touched');
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

  // The checkout's own launcher (config.cliPath) is what every operator and session command
  // starts, pin or no pin. It reads the pin without importing the checkout's hooks module, so a
  // hostile bin/held-release-hooks.mjs beside it — pinning nothing, marking every process that
  // loads it — is never evaluated: the command loads release B through the snapshot's hooks.
  const h = await world('dirty-hooks-only', {
    seed: async origin => {
      await mkdir(join(origin, 'bin'), { recursive: true });
      for (const file of ['graphyard.mjs', 'held-release-hooks.mjs']) await writeFile(join(origin, 'bin', file), await readFile(hooksOf(file)));
    },
  });
  const hooksOnlyMarker = join(h.root, 'edited-hooks-ran.txt');
  await writeFile(join(h.root, 'bin', 'held-release-hooks.mjs'), [
    `import { appendFileSync } from 'node:fs';`,
    `appendFileSync(${JSON.stringify(hooksOnlyMarker)}, 'ran');`,
    'export function heldRelease() { return null; }',
    'export function initialize() {}',
    'export async function resolve(specifier, context, next) { return next(specifier, context); }',
    '',
  ].join('\n'));
  assert.equal(status(h.root), ' M bin/held-release-hooks.mjs');
  const hooksState = emptyDaemonState(h.master);
  hooksState.release = { commit: h.loaded, dirty: true };
  hooksState.deployment = verified(h.tip);
  const hooksDone = await performSelfUpgrade(h.master, hooksState, recording(h.root).deps());
  assert.equal(hooksDone.outcome, 'upgraded', JSON.stringify(hooksDone));
  assert.equal(readHeldCli(h.root), h.tip);
  assert.equal(h.launch('watch', 'GY-1', '1').release, 'B', 'a command through the checkout\'s launcher loads the pinned release');
  assert.equal(existsSync(hooksOnlyMarker), false, 'without evaluating the checkout\'s edited hooks module');
  const hooksNamed = upgrade.leftBehindCheckoutAttention(hooksState.upgrade.snapshot, h.tip, h.root);
  assert.match(hooksNamed[0].text, /reads the pin without loading its own bin\/held-release-hooks\.mjs and registers the snapshot's, so the edit loads nowhere while the pin stands\.$/);
  // With bin/graphyard.mjs itself dirty, master status says what is true of it: the supervised
  // starts never run it, a command started through it still does, so it is to be returned.
  const bothNamed = upgrade.leftBehindCheckoutAttention(state.upgrade.snapshot, w.tip, w.root);
  assert.match(bothNamed[0].text, /the loop and the executors start the launcher held in the snapshot, so their starts never run those edits; every command started through the checkout's launcher still runs its edited bin\/graphyard\.mjs before the pin redirects any module, so return it to the commit first\.$/);
});

test('unit:moved-dirty-checkout-hold-keeps-served-pin — a checkout-loaded loop on the served release whose checkout is moved by hand onto an unserved merged commit and dirtied there holds the restart with the launcher pinned to the served release, so no command it starts loads the unserved dirty tree; a dirty checkout still at the loaded commit holds with no pin, as before; the hold completes onto a snapshot once the commit is served', async () => {
  // Served A, loaded A; the operator moves the checkout onto B, merged but not served, and edits it.
  const w = await world('moved-dirty-hold');
  git(w.root, 'fetch', '-q', 'origin');
  git(w.root, 'checkout', '-q', '--detach', w.tip);
  const before = await dirtied(w.root);
  const state = emptyDaemonState(w.master);
  state.release = { commit: w.loaded, dirty: false };
  state.deployment = verified(w.loaded);
  state.upgrade.alignedRelease = w.loaded;
  const { calls, deps } = recording(w.root);
  const held = await performSelfUpgrade(w.master, state, deps());
  assert.equal(held.outcome, 'pending', JSON.stringify(held));
  assert.match('reason' in held ? held.reason : '', new RegExp(`^restart held: production serves release ${short(w.loaded)}, which does not contain ${short(w.tip)} yet`));
  assert.equal(state.upgrade.stalled?.cause, 'release-lagged');
  assert.equal(readHeldCli(w.root), w.loaded, 'the launcher is pinned to the served release while the hold stands');
  assert.equal(w.launch('watch', 'GY-1', '1').release, 'A', 'a command the checkout\'s launcher starts loads the served release, not the unserved dirty tree');
  assert.deepEqual(calls, { executors: [], self: 0 }, 'nothing restarts');
  assert.deepEqual([git(w.root, 'rev-parse', 'HEAD'), status(w.root)], [w.tip, before], 'the checkout is untouched');
  assert.deepEqual(state.upgrade.pending, { from: w.loaded, to: w.tip, code: true });
  // The same hold on a later pass pins nothing new: one snapshot, the same pin.
  const second = await performSelfUpgrade(w.master, state, deps());
  assert.equal(second.outcome, 'pending', JSON.stringify(second));
  assert.equal(readHeldCli(w.root), w.loaded);
  // B served: the hold completes onto a held snapshot of B, the dirty checkout left where it stands.
  state.deployment = verified(w.tip);
  const completed = await performSelfUpgrade(w.master, state, deps());
  assert.deepEqual(completed, { outcome: 'upgraded', from: w.loaded, to: w.tip, code: true, executors: restarted(w.tip), self: true, left: { checkout: w.tip, dirty: ['README.md'] } });
  assert.equal(readHeldCli(w.root), w.tip, 'the pin moves to the snapshot of B');
  assert.equal(w.launch('watch', 'GY-1', '1').release, 'B');
  assert.deepEqual(state.upgrade.snapshot, { at: iso(), commit: w.tip, checkout: w.tip, dirty: ['README.md'] });

  // Unmoved: the checkout dirty where the loop loaded it, B merged and unserved. What its launcher
  // starts already speaks the served protocol, so the hold places no pin (GY-1773).
  const u = await world('unmoved-dirty-hold');
  await dirtied(u.root);
  const unmoved = emptyDaemonState(u.master);
  unmoved.release = { commit: u.loaded, dirty: true };
  unmoved.deployment = verified(u.loaded);
  const unmovedHeld = await performSelfUpgrade(u.master, unmoved, recording(u.root).deps());
  assert.equal(unmovedHeld.outcome, 'pending', JSON.stringify(unmovedHeld));
  assert.equal(unmoved.upgrade.stalled?.cause, 'release-lagged');
  assert.equal(readHeldCli(u.root), null, 'no pin: the checkout still holds the commit the loop runs');
  assert.equal(git(u.root, 'rev-parse', 'HEAD'), u.loaded);
});

test('unit:executor-unit-render-idempotent — rendering an executor unit the pin already rendered is byte-identical, the alignment then writes nothing and reloads nothing, and the lift removes the handed-checkout line it added', async () => {
  const w = await world('unit-render');
  const template = await readFile(fileURLToPath(new URL('../examples/master/graphyard-executor@.service', import.meta.url)), 'utf8');
  const snapshotScript = join(upgrade.heldCliSnapshotAt(w.root, w.tip), 'scripts', 'graphyard-executor.mjs');
  const installed = renderExecutorUnit(template, { root: w.root, node: process.execPath });
  const pinned = renderExecutorUnit(installed, { root: w.root, node: process.execPath, script: snapshotScript, checkoutRoot: w.root });
  const environment = new RegExp(`^Environment="${checkoutRootVariable}=`, 'm');
  assert.equal(pinned.split('\n').filter(line => environment.test(line)).length, 1, 'one handed-checkout line');
  assert.match(pinned, new RegExp(`^Environment="${checkoutRootVariable}=${w.root}"\nExecStart=${process.execPath} ${snapshotScript} --slot %i$`, 'm'));
  assert.equal(renderExecutorUnit(pinned, { root: w.root, node: process.execPath, script: snapshotScript, checkoutRoot: w.root }), pinned, 'rendering the rendered unit again changes nothing');
  assert.equal(renderExecutorUnit(pinned, { root: w.root, node: process.execPath }), installed, 'the lift renders the checkout\'s unit, the handed-checkout line gone');
  assert.equal(renderExecutorUnit(installed, { root: w.root, node: process.execPath }), installed);

  // The alignment the finish and the lift run, against a unit directory of this test's own, with
  // the install's units recorded so no user unit directory is consulted. Every retry of a refused
  // restart re-runs it before the fleet restarts: the second call must be a no-op.
  const units = perInstallUnits('owner/project');
  await mkdir(join(w.root, '.graphyard'), { recursive: true });
  await writeFile(join(w.root, installUnitsFile), `${JSON.stringify(units)}\n`);
  const unitDirectory = join(w.directory, 'systemd-user');
  await mkdir(unitDirectory, { recursive: true });
  const unitFile = join(unitDirectory, units.executorTemplate);
  await writeFile(unitFile, installed);
  const reloads: string[][] = [];
  const run = (args: string[]) => { reloads.push(args); return ''; };
  assert.deepEqual(await alignExecutorUnitScript(w.root, snapshotScript, { run, unitDirectory }), { wrote: 'updated', reason: null });
  assert.equal(await readFile(unitFile, 'utf8'), pinned);
  assert.deepEqual(reloads, [['daemon-reload']]);
  assert.deepEqual(await alignExecutorUnitScript(w.root, snapshotScript, { run, unitDirectory }), { wrote: 'unchanged', reason: null }, 'the retry writes nothing');
  assert.deepEqual(await alignExecutorUnitScript(w.root, snapshotScript, { run, unitDirectory }), { wrote: 'unchanged', reason: null });
  assert.equal(await readFile(unitFile, 'utf8'), pinned, 'the unit holds one handed-checkout line however often it is aligned');
  assert.deepEqual(reloads, [['daemon-reload']], 'the manager is reloaded once');
  assert.deepEqual(await alignExecutorUnitScript(w.root, null, { run, unitDirectory }), { wrote: 'updated', reason: null });
  assert.equal(await readFile(unitFile, 'utf8'), installed, 'the lift returns the unit to the checkout\'s entry, byte for byte');
  assert.deepEqual(await alignExecutorUnitScript(w.root, null, { run, unitDirectory }), { wrote: 'unchanged', reason: null });
  assert.deepEqual(reloads, [['daemon-reload'], ['daemon-reload']]);
});

test('unit:snapshot-lift-returns-the-units — a loop running a held snapshot whose checkout is cleaned where it was left restarts from the checkout with the executor units returned to its entry before the fleet restarts, and a lift onto the snapshot commit keeps its record and retries while the loop unit cannot be rewritten', async () => {
  // Cleaned where it was left: the ordinary alignment moves the clean checkout onto B and restarts
  // the loop and the executors from it. The pin lifts, and the executor units — pointed into the
  // snapshot by the earlier restart — are pointed back at the checkout's entry first.
  const c = await world('cleaned-left-behind');
  const cleaned = await snapshotUpgrade(c);
  cleaned.state.release = { commit: c.tip, dirty: false };
  git(c.root, 'checkout', '-q', '--', 'README.md');
  assert.equal(status(c.root), '');
  const executorScripts: (string | null)[] = [];
  const aligned = recording(c.root);
  const done = await performSelfUpgrade(c.master, cleaned.state, aligned.deps({ loadedFrom: join(cleaned.snapshot, 'src', 'daemon', 'upgrade.ts'), alignExecutorUnits: async script => { executorScripts.push(script); return { wrote: 'updated', reason: null }; } }));
  assert.deepEqual(done, { outcome: 'upgraded', from: c.loaded, to: c.tip, code: true, executors: restarted(c.tip), self: false }, 'the loop already runs B, so only the executors restart, from the checkout');
  assert.deepEqual([...executorScripts], [null], 'the executor units are returned to the checkout\'s entry before the fleet restarts');
  assert.equal(readHeldCli(c.root), null, 'the pin is lifted');
  assert.equal(cleaned.state.upgrade.snapshot, undefined, 'the record is cleared');
  assert.deepEqual([git(c.root, 'rev-parse', 'HEAD'), status(c.root)], [c.tip, ''], 'the clean checkout is moved onto B');
  assert.deepEqual(aligned.calls, { executors: [c.tip], self: 0 });

  // Moved onto B and clean there: the lift. The pin lifts and the executor units return, but while
  // the loop's own unit cannot be rewritten its ExecStart still names the snapshot's launcher, so
  // the record stays and the next pass retries the rewrite before the snapshot is forgotten.
  const l = await world('lift-unit-refused');
  const lifted = await snapshotUpgrade(l);
  lifted.state.release = { commit: l.tip, dirty: false };
  git(l.root, 'checkout', '-q', '--', 'README.md');
  git(l.root, 'checkout', '-q', '--detach', l.tip);
  assert.equal(status(l.root), '');
  const unitWrites: string[] = [];
  const refusing = recording(l.root);
  let unit: { wrote: string; reason: string | null } = { wrote: 'refused', reason: 'EACCES: the unit file is read-only' };
  const liftDeps = () => refusing.deps({ loadedFrom: join(lifted.snapshot, 'src', 'daemon', 'upgrade.ts'), alignUnit: async () => { unitWrites.push(unit.wrote); return unit; }, alignExecutorUnits: async script => { executorScripts.push(script); return { wrote: 'updated', reason: null }; } });
  const kept = await performSelfUpgrade(l.master, lifted.state, liftDeps());
  assert.equal(kept.outcome, 'skipped', JSON.stringify(kept));
  assert.match('reason' in kept ? kept.reason : '', /the loop's supervisor unit could not be returned to the checkout's launcher \(upgrade:unit names why\); retried next cycle$/);
  assert.equal(lifted.state.actions['upgrade:unit']?.state, 'failed', 'the refused rewrite is recorded');
  assert.match(lifted.state.actions['upgrade:unit']?.detail ?? '', /EACCES: the unit file is read-only/);
  assert.deepEqual(lifted.state.upgrade.snapshot, { at: iso(), commit: l.tip, checkout: l.loaded, dirty: ['README.md'] }, 'the record stays until the loop unit is restored');
  assert.equal(readHeldCli(l.root), null, 'the pin itself is lifted');
  assert.deepEqual(refusing.calls, { executors: [], self: 0 }, 'nothing restarts: the code is the same');
  unit = { wrote: 'updated', reason: null };
  const restored = await performSelfUpgrade(l.master, lifted.state, liftDeps());
  assert.deepEqual(restored, { outcome: 'up-to-date', commit: l.tip });
  assert.equal(lifted.state.upgrade.snapshot, undefined, 'the record is cleared once the unit is rewritten');
  assert.deepEqual(unitWrites, ['refused', 'updated']);
  assert.deepEqual(executorScripts.slice(1), [null, null], 'the executor units are returned on each pass, a no-op once they are');
  assert.equal(lifted.state.actions['upgrade:unit']?.state, 'done');
});
