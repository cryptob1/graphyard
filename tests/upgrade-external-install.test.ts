import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { deploymentObservationSchema, emptyDaemonState, type DaemonState } from '../src/master-daemon.js';
import { checkoutState, externalUpgradeRefusal, managesOwnCheckout, performSelfUpgrade } from '../src/daemon/upgrade.js';
import { upgradeRefusalAttention } from '../src/master/release-lag.js';
import type { ChildRun } from '../src/child-runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1958: the loop's self-upgrade never moves an external install onto Graphyard's unreleased
 * main. `config.baseBranch` is the managed repository's base branch, and the alignment fetched that
 * ref name from the CLI checkout's origin and checked its tip out — so an install whose managed app
 * deploys to `main` moved its Graphyard checkout onto Graphyard's own unreleased base tip on every
 * verified app deploy. Now an install whose managed repository is not the repository the CLI
 * checkout holds runs no alignment at all: no fetch, no move, and a standing refusal in master
 * status that names the command the install upgrades by. An install whose managed repository IS the
 * checkout's own — Graphyard on Graphyard, a linked worktree of it included — keeps today's
 * behaviour. Each test is named for the proof it produces: unit:upgrade-external-install.
 */

// The clock the upgrade stamps its refusal and actions with, derived from this fixed instant.
const clock = 1_800_000_000_000;
const iso = (offsetMs = 0) => new Date(clock + offsetMs).toISOString();
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** The runner's error carries git's exit status, as the loop's own child runner's does: checkoutState reads status 1, the repository probe 128. */
const runPlain: ChildRun = async (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A runner that records every command's operation, so a test can prove nothing fetched or moved the checkout. */
const recordingRun = () => {
  const operations: string[] = [];
  const run: ChildRun = async (command, args) => {
    const rest = args[0] === '-C' ? args.slice(2) : args;
    operations.push(rest.join(' '));
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  };
  return { run, operations };
};

const config = async (cliPath: string, repository: string): Promise<MasterConfig> => {
  const directory = await temporaryDirectory('upgrade-external-credentials');
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath,
    repository, baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
};

/** A one-commit git repository with `file` in it, on branch `main`. */
async function repository(directory: string, name: string, contents: string): Promise<string> {
  await mkdir(dirname(join(directory, name)), { recursive: true });
  await writeFile(join(directory, name), contents);
  git(directory, 'init', '-q', '-b', 'main');
  git(directory, 'add', name);
  git(directory, 'commit', '-q', '-m', `first ${name}`);
  return git(directory, 'rev-parse', 'HEAD');
}

/** A verified deployment observation of the managed repository, serving `sha` with a delivered item. */
const verified = (sha: string): DaemonState['deployment'] =>
  deploymentObservationSchema.parse({ source: 'endpoint', sha, at: iso(0), reason: null, deployed: ['GY-1'], pending: [] });

const deps = (root: string, run: ChildRun) => ({ root, run, now: () => clock, persist: async () => {} });

test('unit:upgrade-external-install — a verified deployment of a managed repository the checkout does not hold leaves the checkout untouched, fetches nothing in it, and names the command upgrade', async () => {
  const checkout = await temporaryDirectory('upgrade-external-checkout');
  const managed = await temporaryDirectory('upgrade-external-managed');
  try {
    const loaded = await repository(checkout, 'README.md', 'graphyard\n');
    git(checkout, 'checkout', '-q', '-b', 'operator-branch');
    const served = await repository(managed, 'app.txt', 'app one\n');
    await writeFile(join(managed, 'app.txt'), 'app two\n');
    git(managed, 'commit', '-qam', 'app two');
    const servedTip = git(managed, 'rev-parse', 'HEAD');
    assert.notEqual(servedTip, served, 'the managed repository holds a newer verified deploy');

    const master = await config(join(checkout, 'bin/graphyard.mjs'), 'owner/app');
    const state = emptyDaemonState(master);
    state.release = { commit: loaded, dirty: false };
    state.deployment = verified(servedTip);
    const { run, operations } = recordingRun();
    const before = await checkoutState(checkout, runPlain);

    const outcome = await performSelfUpgrade(master, state, deps(managed, run));

    assert.ok(outcome.outcome === 'refused', `the external install's pass refuses: ${JSON.stringify(outcome)}`);
    assert.match(outcome.reason, /graphyard up\b/, 'the refusal names the command the install upgrades by');
    // No fetch and no checkout ran anywhere in the pass, least of all in the CLI checkout.
    assert.deepEqual(operations.filter(entry => /^(fetch|checkout)\b/.test(entry)), [], `the pass ran only reads: ${operations.join(' | ')}`);
    // HEAD, branch and working tree stand exactly where they stood.
    const after = await checkoutState(checkout, runPlain);
    assert.deepEqual(after, before, 'the CLI checkout is unchanged');
    assert.equal(after.commit, loaded);
    assert.equal(after.branch, 'refs/heads/operator-branch');
    assert.equal(after.dirty, false);
    assert.equal(await readFile(join(checkout, 'README.md'), 'utf8'), 'graphyard\n', 'the working tree is untouched');
    // Master status names the command upgrade: the cursor carries the refusal and the attention renders it.
    assert.deepEqual(state.upgrade.refused, { at: iso(0), reason: externalUpgradeRefusal, commit: loaded });
    const action = state.actions['upgrade:refused'];
    assert.ok(action, 'the pass records its upgrade:refused action');
    assert.equal(action.state, 'failed');
    assert.match(action.detail, /graphyard up\b/);
    const attention = upgradeRefusalAttention(state.upgrade.refused, managed, 'main');
    assert.equal(attention.length, 1);
    assert.equal(attention[0].subject, 'upgrade');
    assert.match(attention[0].text, /upgrades by command/, 'master status names that the install upgrades by command');
    assert.match(attention[0].next, /graphyard up\b/, 'the remedy is the command upgrade');
    // The remedy never sends anyone to detach-checkout the managed repository, nor says the loop aligns a checkout here.
    for (const words of [attention[0].text, attention[0].next]) {
      assert.doesNotMatch(words, /checkout --detach/);
      assert.doesNotMatch(words, /aligns the checkout/);
      assert.ok(!words.includes(managed), 'the attention names no command against the managed repository');
    }
    const timeOfRefusal = state.upgrade.refused!.at;

    // The next pass records no new refusal row: one standing refusal, its time touched, not re-opened.
    const { run: runAgain, operations: operationsAgain } = recordingRun();
    const second = await performSelfUpgrade(master, state, deps(managed, runAgain));
    assert.equal(second.outcome, 'refused');
    assert.deepEqual(operationsAgain.filter(entry => /^(fetch|checkout)\b/.test(entry)), [], 'no later pass fetches or moves either');
    assert.equal(state.actions['upgrade:refused']?.attempts, 1, 'the standing refusal is deduplicated, not re-recorded per pass');
    assert.equal(state.upgrade.refused?.at, timeOfRefusal, 'the standing refusal is not rewritten, so the attention never churns');
    assert.equal(state.upgrade.stalled, undefined, 'nothing is owed, so no stall stands');
  } finally {
    await rm(checkout, { recursive: true, force: true });
    await rm(managed, { recursive: true, force: true });
  }
});

test('unit:upgrade-external-install — a managed root that is no repository is never taken for the checkout\u2019s own', async () => {
  const checkout = await temporaryDirectory('upgrade-external-checkout');
  const managed = await temporaryDirectory('upgrade-external-unreadable');
  try {
    const loaded = await repository(checkout, 'README.md', 'graphyard\n');
    await writeFile(join(managed, 'not-a-repo.txt'), 'just a directory\n');
    const master = await config(join(checkout, 'bin/graphyard.mjs'), 'owner/app');
    const state = emptyDaemonState(master);
    state.release = { commit: loaded, dirty: false };
    state.deployment = verified(loaded);
    const { run, operations } = recordingRun();

    const outcome = await performSelfUpgrade(master, state, deps(managed, run));

    assert.ok(outcome.outcome === 'refused', `the unreadable root's pass refuses: ${JSON.stringify(outcome)}`);
    assert.match(outcome.reason, /graphyard up\b/);
    assert.deepEqual(operations.filter(entry => /^(fetch|checkout)\b/.test(entry)), [], 'a root git cannot place never sends the upgrade fetching');
  } finally {
    await rm(checkout, { recursive: true, force: true });
    await rm(managed, { recursive: true, force: true });
  }
});

test('unit:upgrade-external-install — with the managed repository equal to the CLI checkout\u2019s own, a verified deployment still fetches and moves the checkout as before', async () => {
  const origin = await temporaryDirectory('upgrade-external-origin');
  const checkout = await temporaryDirectory('upgrade-external-own');
  try {
    const first = await repository(origin, 'docs/lag.md', 'lag\n');
    git(checkout, 'init', '-q', '-b', 'main');
    git(checkout, 'remote', 'add', 'origin', origin);
    git(checkout, 'fetch', '-q', 'origin');
    git(checkout, 'checkout', '-q', '--detach', 'origin/main');
    await writeFile(join(origin, 'docs', 'lag.md'), 'lag\nmore\n');
    git(origin, 'commit', '-qam', 'second');
    const tip = git(origin, 'rev-parse', 'HEAD');
    assert.notEqual(tip, first);

    const master = await config(join(checkout, 'bin/graphyard.mjs'), 'owner/graphyard');
    const state = emptyDaemonState(master);
    state.release = { commit: first, dirty: false };
    state.deployment = verified(tip);
    const { run, operations } = recordingRun();

    const outcome = await performSelfUpgrade(master, state, deps(checkout, run));

    assert.ok(outcome.outcome === 'upgraded', `the own install still aligns: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.code, false, 'a docs-only tip moves the checkout and restarts nothing');
    assert.ok(operations.some(entry => /^fetch\b/.test(entry)), 'the pass fetched the base tip as before');
    assert.equal((await checkoutState(checkout, runPlain)).commit, tip, 'the checkout moved onto the verified tip');
    assert.equal(state.upgrade.last?.to, tip);
    assert.equal(state.upgrade.refused, null, 'no refusal stands on an own install');
  } finally {
    await rm(origin, { recursive: true, force: true });
    await rm(checkout, { recursive: true, force: true });
  }
});

test('unit:upgrade-external-install — a linked worktree of the managed repository counts as the checkout\u2019s own and the upgrade keeps today\u2019s behaviour', async () => {
  const remote = await temporaryDirectory('upgrade-external-remote');
  const checkout = await temporaryDirectory('upgrade-external-clone');
  const managed = await temporaryDirectory('upgrade-external-worktree');
  try {
    await repository(remote, 'placeholder', 'bare\n');
    git(remote, 'checkout', '-q', '--detach');
    git(checkout, 'init', '-q', '-b', 'main');
    git(checkout, 'remote', 'add', 'origin', remote);
    git(checkout, 'fetch', '-q', 'origin');
    git(checkout, 'checkout', '-q', '--detach', 'origin/main');
    const first = git(checkout, 'rev-parse', 'HEAD');
    git(checkout, 'branch', 'main', 'origin/main');
    git(checkout, 'worktree', 'add', '-q', managed, 'main');
    await writeFile(join(managed, 'app.txt'), 'worktree app two\n');
    git(managed, 'add', 'app.txt');
    git(managed, 'commit', '-qam', 'second');
    git(managed, 'push', '-q', 'origin', 'main');
    const tip = git(managed, 'rev-parse', 'HEAD');
    assert.notEqual(tip, first);
    assert.equal(await managesOwnCheckout(checkout, managed, runPlain), true, 'the two checkouts share one repository');

    const master = await config(join(checkout, 'bin/graphyard.mjs'), 'owner/graphyard');
    const state = emptyDaemonState(master);
    state.release = { commit: first, dirty: false };
    state.deployment = verified(tip);
    const { run, operations } = recordingRun();

    const outcome = await performSelfUpgrade(master, state, deps(managed, run));

    assert.ok(outcome.outcome === 'upgraded', `the worktree install still aligns: ${JSON.stringify(outcome)}`);
    assert.ok(operations.some(entry => /^fetch\b/.test(entry)), 'the pass fetched the base tip as before');
    assert.equal((await checkoutState(checkout, runPlain)).commit, tip, 'the CLI checkout moved onto the verified tip');
  } finally {
    await rm(remote, { recursive: true, force: true });
    await rm(checkout, { recursive: true, force: true });
    await rm(managed, { recursive: true, force: true });
  }
});

test('unit:upgrade-external-install — managesOwnCheckout judges the checkout\u2019s own repository, a linked worktree of it, another checkout of its upstream, a separate repository and no repository', async () => {
  const origin = await temporaryDirectory('upgrade-external-judge-origin');
  const checkout = await temporaryDirectory('upgrade-external-judge');
  const fork = await temporaryDirectory('upgrade-external-judge-fork');
  const other = await temporaryDirectory('upgrade-external-judge-other');
  const otherOrigin = await temporaryDirectory('upgrade-external-judge-other-origin');
  const worktree = await temporaryDirectory('upgrade-external-judge-worktree');
  const plain = await temporaryDirectory('upgrade-external-judge-plain');
  try {
    await repository(origin, 'README.md', 'graphyard\n');
    for (const clone of [checkout, fork]) {
      git(clone, 'init', '-q', '-b', 'main');
      git(clone, 'remote', 'add', 'origin', origin);
      git(clone, 'fetch', '-q', 'origin');
      git(clone, 'checkout', '-q', '--detach', 'origin/main');
    }
    await repository(other, 'README.md', 'other\n');
    git(other, 'remote', 'add', 'origin', otherOrigin);
    git(checkout, 'worktree', 'add', '-q', worktree);
    await writeFile(join(plain, 'file.txt'), 'no repository here\n');

    assert.equal(await managesOwnCheckout(checkout, checkout, runPlain), true, 'the same directory is its own');
    assert.equal(await managesOwnCheckout(checkout, worktree, runPlain), true, 'a linked worktree is its own');
    assert.equal(await managesOwnCheckout(checkout, fork, runPlain), true, 'another checkout of the same upstream is its own, however the fork or second checkout is spelled');
    assert.equal(await managesOwnCheckout(checkout, other, runPlain), false, 'a repository of another origin is not');
    assert.equal(await managesOwnCheckout(checkout, plain, runPlain), false, 'no repository at all is not');
  } finally {
    await rm(origin, { recursive: true, force: true });
    await rm(checkout, { recursive: true, force: true });
    await rm(fork, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
    await rm(otherOrigin, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
    await rm(plain, { recursive: true, force: true });
  }
});

test('unit:upgrade-external-install — origins are compared case-sensitively in their path and case-insensitively in their host', async () => {
  // Two repositories whose common directories differ, answering these origins.
  const judged = (code: string, managed: string) => managesOwnCheckout('/code', '/managed', async (_command, args) => {
    if (args[2] === 'rev-parse') return `${args[1]}/.git\n`;
    return `${args[1] === '/code' ? code : managed}\n`;
  });
  assert.equal(await judged('/srv/Owner/App', '/srv/owner/app'), false, 'filesystem origins differing in path case are two projects');
  assert.equal(await judged('https://GitHub.com/cryptob1/graphyard.git', 'git@github.com:cryptob1/graphyard'), true, 'one upstream spelled two ways, its host in another case, is one project');
  assert.equal(await judged('https://github.com/Owner/App', 'https://github.com/owner/other'), false);
});

test('unit:upgrade-external-install — an external install an earlier loop already moved has its owed restart and held snapshot retired, never left standing', async () => {
  const checkout = await temporaryDirectory('upgrade-external-legacy-checkout');
  const managed = await temporaryDirectory('upgrade-external-legacy-managed');
  try {
    const loaded = await repository(checkout, 'README.md', 'graphyard\n');
    await repository(managed, 'app.txt', 'app\n');
    const master = await config(join(checkout, 'bin/graphyard.mjs'), 'owner/app');
    const state = emptyDaemonState(master);
    state.release = { commit: loaded, dirty: false };
    state.deployment = verified(git(managed, 'rev-parse', 'HEAD'));
    // What the pre-GY-1958 loop left on the cursor after moving this install's checkout.
    state.upgrade.pending = { from: 'a'.repeat(40), to: loaded, code: true };
    state.upgrade.snapshot = { at: iso(0), commit: loaded, checkout: 'b'.repeat(40), dirty: ['src/master.ts'] };
    state.upgrade.stalled = { cause: 'executors-refused', reason: 'a claim was in flight', since: iso(0), at: iso(0) };
    const pins: (string | null)[] = [], executorEntries: (string | null)[] = [];
    let unitRewrites = 0, unitRefused = true;
    const { run, operations } = recordingRun();
    const legacyDeps = { ...deps(managed, run),
      holdCli: async (commit: string | null) => { pins.push(commit); },
      alignExecutorUnits: async (script: string | null) => { executorEntries.push(script); return { wrote: 'updated', reason: null }; },
      alignUnit: async () => { unitRewrites++; return unitRefused ? { wrote: 'refused', reason: 'unit not writable', launcherStale: true } : { wrote: 'updated', reason: null }; } };

    // A step that fails keeps the record, says why once, and is retried next pass.
    assert.equal((await performSelfUpgrade(master, state, legacyDeps)).outcome, 'refused');
    assert.ok(state.upgrade.pending && state.upgrade.snapshot, 'nothing is forgotten while the unit still names the snapshot’s launcher');
    assert.equal(state.actions['upgrade:align']?.state, 'failed');
    assert.match(state.actions['upgrade:align']!.detail, /could not be retired/);

    unitRefused = false;
    assert.equal((await performSelfUpgrade(master, state, legacyDeps)).outcome, 'refused');
    assert.deepEqual(pins, [null, null], 'the pin is lifted, never placed');
    assert.deepEqual(executorEntries, [null, null], 'the executor units go back to the checkout’s launcher');
    assert.equal(unitRewrites, 2);
    assert.equal(state.upgrade.pending, null, 'the owed restart is retired');
    assert.equal(state.upgrade.snapshot, undefined, 'the held snapshot record is retired');
    assert.equal(state.upgrade.stalled, undefined, 'the stall is retired');
    assert.equal(state.actions['upgrade:align']?.state, 'done');
    assert.match(state.actions['upgrade:align']!.detail, /^Retired the restart owed onto .*the held snapshot of .*the executors-refused stall/);
    assert.equal(state.upgrade.refused?.reason, externalUpgradeRefusal);
    assert.deepEqual(operations.filter(entry => /^(fetch|checkout)\b/.test(entry)), [], 'retiring moves nothing');
    assert.equal((await checkoutState(checkout, runPlain)).commit, loaded);

    // Settled, later passes have nothing to retire.
    await performSelfUpgrade(master, state, legacyDeps);
    assert.deepEqual(pins, [null, null]);
  } finally {
    await rm(checkout, { recursive: true, force: true });
    await rm(managed, { recursive: true, force: true });
  }
});
