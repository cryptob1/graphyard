import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { deploymentObservationSchema, emptyDaemonState, type DaemonState } from '../src/master-daemon.js';
import { heldCliPointer, heldCliSnapshotAt, holdCliAt, managesOwnCheckout, performSelfUpgrade, readHeldCli } from '../src/daemon/upgrade.js';
import type { SelfUpgradeDeps } from '../src/daemon/upgrade.js';
import type { ChildRun } from '../src/child-runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-2169: a loop a held snapshot carries keeps owning its install. The installed configuration's
 * cliPath names a held snapshot under the managed root's .graphyard/held-cli (the pin that keeps the
 * launcher on the release production serves), and that snapshot is a git repository of its own whose
 * origin — a clone's origin — names the managed root's path, so the ownership probes read it as
 * another project: the pass recorded the external-install refusal, lifted the pin and the loop ran
 * the served release again, never upgrading. Ownership is now judged from the checkout the snapshot
 * was cut from (the managed root), and an alignment that cannot move the server itself never moves
 * the CLI past the commit the server reports, so the pin never straddles the server and every
 * worker claim speaks its protocol. Real repositories and the shipped git throughout; the fleet and
 * the supervisor are recorded fakes. Each test is named for the proof it produces:
 * unit:held-snapshot-owns-checkout.
 */

// The clock the upgrade stamps its actions with, derived from this fixed instant.
const clock = 1_800_000_000_000;
const iso = (offsetMs = 0) => new Date(clock + offsetMs).toISOString();
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** The runner's error carries git's exit status, as the loop's own child runner's does. */
const runPlain: ChildRun = async (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const verified = (sha: string): DaemonState['deployment'] => deploymentObservationSchema.parse({ source: 'endpoint', sha, at: iso(), reason: null, deployed: ['GY-1'], pending: [] });

/**
 * An origin holding release A and the merged tip B (loaded code), and the managed root: a clone of
 * it detached at A. `dirty` replicates the incident's checkout, whose repository setup had rewritten
 * a tracked file; the held snapshot of A is cut exactly as the pin cuts it (holdCliAt), and the
 * configuration's launcher either names the snapshot's (the pinned install) or the checkout's.
 */
async function world(label: string, launcher: 'snapshot' | 'checkout') {
  const origin = await temporaryDirectory(`${label}-origin`);
  await mkdir(join(origin, 'src', 'daemon'), { recursive: true });
  await writeFile(join(origin, 'src', 'cli.ts'), "export const release: string = 'A';\n");
  await writeFile(join(origin, 'src', 'daemon', 'state.ts'), "export const upgradeStallCauses = ['checkout-failed', 'release-lagged'] as const;\n");
  await writeFile(join(origin, 'package.json'), '{ "type": "module" }\n');
  await writeFile(join(origin, 'tsconfig.json'), '{}\n');
  await writeFile(join(origin, 'README.md'), 'release A\n');
  await writeFile(join(origin, 'AGENTS.md'), 'instructions for A\n');
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'add', '.');
  git(origin, 'commit', '-q', '-m', 'release A');
  const loaded = git(origin, 'rev-parse', 'HEAD');
  await writeFile(join(origin, 'src', 'cli.ts'), "export const release: string = 'B';\n");
  git(origin, 'commit', '-q', '-am', 'release B');
  const tip = git(origin, 'rev-parse', 'HEAD');
  const root = await temporaryDirectory(`${label}-managed`);
  execFileSync('git', ['clone', '-q', origin, root], { stdio: 'ignore' });
  git(root, 'checkout', '-q', '--detach', loaded);
  await writeFile(join(root, 'AGENTS.md'), 'instructions for A, rewritten by repository setup\n');
  await holdCliAt(root, runPlain, loaded);
  const snapshot = heldCliSnapshotAt(root, loaded);
  const directory = await temporaryDirectory(`${label}-credentials`);
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile,
    cliPath: join(launcher === 'snapshot' ? snapshot : root, 'bin', 'graphyard.mjs'),
    repository: 'owner/graphyard', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  return { origin, root, snapshot, loaded, tip, master };
}

/** The upgrade's dependencies: the real git, recorded self re-executions, the fixed clock. */
function recording(root: string) {
  const calls = { self: 0, persisted: 0 };
  const deps = (extra: Partial<SelfUpgradeDeps> = {}): SelfUpgradeDeps => ({ root, run: runPlain,
    restartSelf: async () => { calls.self += 1; }, persist: async () => { calls.persisted += 1; }, now: () => clock, ...extra });
  return { calls, deps };
}

const dispose = async (w: Awaited<ReturnType<typeof world>>) => {
  await rm(w.origin, { recursive: true, force: true });
  await rm(w.root, { recursive: true, force: true });
  await rm(dirname(w.master.credentialFile), { recursive: true, force: true });
};

test('unit:held-snapshot-owns-checkout — a held snapshot under the managed root\u2019s .graphyard/held-cli is judged the managed checkout\u2019s own project: the pass from the snapshot records no external refusal and the held pin stands', async () => {
  const w = await world('held-owns', 'snapshot');
  const { root, snapshot, loaded, master } = w;
  try {
    // The shape the fix judges: the snapshot is a repository of its own, sharing no git directory
    // with the managed root, and its origin — a clone's origin — names the managed root's path, not
    // the upstream. The identity probes alone would read another project.
    assert.notEqual(git(snapshot, 'rev-parse', '--path-format=absolute', '--git-common-dir'), git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    assert.equal(git(snapshot, 'remote', 'get-url', 'origin'), root);
    assert.equal(await managesOwnCheckout(snapshot, root, runPlain), true, 'the snapshot judges as the managed checkout\u2019s own');

    // The loop runs the snapshot (the configuration's launcher names it); the cursor names the
    // checkout left behind dirty at the commit the snapshot holds, and the release was aligned.
    const state = emptyDaemonState(master);
    state.release = { commit: loaded, dirty: false };
    state.deployment = verified(loaded);
    state.upgrade.alignedRelease = loaded;
    state.upgrade.snapshot = { at: iso(), commit: loaded, checkout: loaded, dirty: ['AGENTS.md'] };
    const { deps } = recording(root);
    const outcome = await performSelfUpgrade(master, state, deps());
    assert.ok(outcome.outcome !== 'refused', `the pass refuses nothing: ${JSON.stringify(outcome)}`);
    assert.deepEqual(state.upgrade.refused, null, 'no external refusal is recorded');
    assert.equal(state.actions['upgrade:refused'], undefined);
    assert.equal(readHeldCli(root), loaded, 'the held pin stands');
    const pin = JSON.parse(await readFile(heldCliPointer(root), 'utf8')) as { commit: string; root: string };
    assert.equal(pin.commit, loaded);
    assert.equal(pin.root, snapshot);
    assert.ok(existsSync(snapshot), 'the snapshot the pin names stays on disk');
    // The managed checkout the snapshot was cut from: never touched.
    assert.equal(git(root, 'rev-parse', 'HEAD'), loaded);
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'instructions for A, rewritten by repository setup\n');
  } finally {
    await dispose(w);
  }
});

test('unit:held-snapshot-owns-checkout — an alignment that cannot move the server leaves the pin on the commit the server reports: a tip ahead of it is never snapshotted or pinned, and the pin follows the server when it moves', async () => {
  const w = await world('held-pin-served', 'checkout');
  const { root, snapshot, loaded, tip, master } = w;
  try {
    // The loop runs the served release A from its held snapshot (the checkout left dirty there);
    // the server reports A, while the base tip B is already merged but deployed nowhere.
    const state = emptyDaemonState(master);
    state.release = { commit: loaded, dirty: false };
    state.deployment = verified(loaded);
    const { calls, deps } = recording(root);
    const held = await performSelfUpgrade(master, state, deps({ loadedFrom: join(snapshot, 'src', 'daemon', 'upgrade.ts') }));
    assert.deepEqual(held, { outcome: 'up-to-date', commit: loaded }, 'the alignment targets the served commit, not the tip');
    assert.equal(readHeldCli(root), loaded, 'the pin stays on the server\u2019s commit');
    assert.ok(!existsSync(heldCliSnapshotAt(root, tip)), 'no snapshot of the unserved tip was cut');
    assert.equal(calls.self, 0);
    assert.ok(calls.persisted >= 1, 'the pass still records its alignment');
    assert.equal(git(root, 'rev-parse', 'HEAD'), loaded, 'the checkout is untouched');
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'instructions for A, rewritten by repository setup\n');

    // The server moves to B (its deployment verified): now the pin follows it exactly — the tip is
    // snapshotted for the dirty checkout, the launcher pinned, the loop restarted on.
    state.deployment = verified(tip);
    const moved = await performSelfUpgrade(master, state, deps({ loadedFrom: join(snapshot, 'src', 'daemon', 'upgrade.ts') }));
    assert.deepEqual(moved, { outcome: 'upgraded', from: loaded, to: tip, code: true, self: true, left: { checkout: loaded, dirty: ['AGENTS.md'] } });
    assert.equal(readHeldCli(root), tip, 'the pin names the commit the server reports');
    assert.deepEqual(state.upgrade.snapshot, { at: iso(), commit: tip, checkout: loaded, dirty: ['AGENTS.md'] });
  } finally {
    await dispose(w);
  }
});

test('unit:held-snapshot-owns-checkout — a clean checkout an undeployable upgrade aligns holds at the served release until the server reports the tip, then moves onto it as before', async () => {
  const w = await world('held-clean-served', 'checkout');
  const { root, loaded, tip, master } = w;
  try {
    git(root, 'checkout', '-q', '--', 'AGENTS.md'); // clean: return the world's rewritten file to the commit
    assert.equal(execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(), '');
    const state = emptyDaemonState(master);
    state.release = { commit: loaded, dirty: false };
    state.deployment = verified(loaded);
    const { calls, deps } = recording(root);
    const held = await performSelfUpgrade(master, state, deps());
    assert.deepEqual(held, { outcome: 'up-to-date', commit: loaded }, 'the checkout holds the served commit and stays there');
    assert.equal(readHeldCli(root), loaded, 'the pin names the commit the server reports');
    assert.equal(git(root, 'rev-parse', 'HEAD'), loaded, 'the checkout never moved onto the unserved tip');
    assert.equal(calls.self, 0);

    // The same tip, now verified served: the alignment moves onto it and restarts, as it always did.
    state.deployment = verified(tip);
    const moved = await performSelfUpgrade(master, state, deps());
    assert.deepEqual(moved, { outcome: 'upgraded', from: loaded, to: tip, code: true, self: true });
    assert.equal(git(root, 'rev-parse', 'HEAD'), tip);
    assert.equal(calls.self, 1);
    assert.equal(readHeldCli(root), null, 'the move lifted the pin: the checkout runs the served release itself');
  } finally {
    await dispose(w);
  }
});
