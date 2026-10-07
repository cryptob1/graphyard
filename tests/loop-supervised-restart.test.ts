import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { deploymentObservationSchema, emptyDaemonState, readDaemonState, runDaemon, writeDaemonState, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { performSelfUpgrade, recoverMovedHead } from '../src/daemon/upgrade.js';
import type { UnsupervisedReexecution } from '../src/daemon/reexec.js';
import { readRelease } from '../src/executor-fleet.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1399: the master loop on a host whose systemd user manager it cannot reach ran its first-loaded
 * code forever — the self-upgrade and the moved-HEAD recovery both re-executed only through
 * `systemctl --user restart`, so every merged fix sat in the checkout unloaded. A loop no unit runs
 * now re-executes itself: it starts its successor detached from the checkout and stops by its own
 * SIGTERM, and the successor waits for it to release the lock. Each test is named for its proof.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const hex = (letter: string) => letter.repeat(40);
// Loaded inside each test, so a checkout without the re-execution fails its proofs as test cases.
const reexecution = () => import('../src/daemon/reexec.js');
const loopPredecessorVariable = 'GRAPHYARD_LOOP_PREDECESSOR';
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function fixture() {
  const root = await temporaryDirectory('loop-reexec');
  const credentialFile = join(root, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  return { root, master };
}

/** A detached coordinator checkout at `head` whose base branch's remote ref holds `tip` once fetched. */
class FakeGit {
  head: string; originTip: string; diffPaths = ['src/daemon/run.ts']; checkouts: string[] = [];
  constructor(head: string, originTip: string) { this.head = head; this.originTip = originTip; }
  run = async (command: string, args: string[]): Promise<string> => {
    assert.equal(command, 'git');
    const rest = args.slice(2), op = rest[0], operands = rest.slice(1);
    if (op === 'rev-parse') return `${operands[0] === 'HEAD' ? this.head : this.originTip}\n`;
    if (op === 'symbolic-ref') throw Object.assign(new Error('fatal: not a symbolic ref'), { status: 1 });
    if (op === 'status') return '';
    if (op === 'fetch') return '';
    if (op === 'diff') return `${this.diffPaths.join('\n')}\n`;
    if (op === 'merge-base') return '';
    if (op === 'checkout') { this.head = operands[2]; this.checkouts.push(operands[2]); return ''; }
    throw new Error(`fake git cannot answer: git ${rest.join(' ')}`);
  };
}

const verified = (sha: string): DaemonState['deployment'] =>
  deploymentObservationSchema.parse({ source: 'endpoint', sha, at: iso(0), reason: null, deployed: ['GY-1365', 'GY-1385'], pending: [] });
const restarted = (to: string) => ({ result: 'restarted' as const, reason: null, coordinator: { commit: to }, held: [], restarted: [], unsupervised: [], forgotten: [] });

/** The re-execution with its process effects recorded: what it spawned, and what it signalled. */
function recordedReexecution(root: string, onKill: (pid: number, signal: NodeJS.Signals) => void = () => {}) {
  const spawned: { command: string; args: string[]; cwd: string; detached: boolean; predecessor: string | undefined; unref: number }[] = [];
  const killed: { pid: number; signal: NodeJS.Signals }[] = [];
  const input: UnsupervisedReexecution = {
    root, cliPath: launcher, logDirectory: root, execPath: '/usr/bin/node', pid: 4242, env: { PATH: '/usr/bin' },
    open: () => 7,
    spawn: (command, args, options) => {
      const entry = { command, args, cwd: options.cwd, detached: options.detached, predecessor: options.env[loopPredecessorVariable], unref: 0 };
      spawned.push(entry);
      return { pid: 4343, unref: () => { entry.unref += 1; } };
    },
    kill: (pid, signal) => { killed.push({ pid, signal }); onKill(pid, signal); },
  };
  return { input, spawned, killed };
}

test('unit:master-loop-supervised-restart — a loop no supervisor unit runs re-executes itself onto the checkout: it starts its successor detached and stops by its own SIGTERM, and the successor waits for it to exit', async () => {
  const { awaitLoopPredecessor, reexecuteUnsupervised } = await reexecution();
  assert.equal((await reexecution()).loopPredecessorVariable, loopPredecessorVariable);
  const { root, master } = await fixture();
  // The successor is `master run` from the coordinator checkout, detached, told which loop it replaces.
  const recorded = recordedReexecution(root);
  assert.deepEqual(reexecuteUnsupervised(recorded.input), { successor: 4343 });
  assert.deepEqual(recorded.spawned, [{ command: '/usr/bin/node', args: [launcher, 'master', 'run'], cwd: root, detached: true, predecessor: '4242', unref: 1 }]);
  assert.deepEqual(recorded.killed, [{ pid: 4242, signal: 'SIGTERM' }], 'and the running loop is stopped the way a supervisor stops it');

  // A successor that did not start leaves the running loop alone: no signal, a failure the upgrade records.
  const unstarted = recordedReexecution(root);
  assert.throws(() => reexecuteUnsupervised({ ...unstarted.input, spawn: () => ({ pid: undefined, unref: () => {} }) }), /did not start, so this loop keeps running/);
  assert.deepEqual(unstarted.killed, []);

  // A real detached process receives the argv and the predecessor it waits for.
  const script = join(root, 'successor.mjs'), out = join(root, 'successor.json');
  await writeFile(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), predecessor: process.env.${loopPredecessorVariable}, cwd: process.cwd() }));\n`);
  const real = reexecuteUnsupervised({ root, cliPath: script, logDirectory: root, kill: () => {} });
  assert.ok(real.successor > 0);
  let written: { argv: string[]; predecessor: string; cwd: string } | null = null;
  for (let attempt = 0; attempt < 100 && !written; attempt++) { try { written = JSON.parse(await readFile(out, 'utf8')); } catch { await delay(50); } }
  assert.deepEqual(written, { argv: ['master', 'run'], predecessor: String(process.pid), cwd: root });

  // The successor waits for its predecessor before it reads the cursor; a process started otherwise does not wait.
  let checks = 0;
  assert.deepEqual(await awaitLoopPredecessor({ [loopPredecessorVariable]: '4242' }, { alive: () => ++checks < 3, pollMs: 1, self: 1 }), { waited: true, predecessor: 4242 });
  assert.equal(checks, 3);
  assert.deepEqual(await awaitLoopPredecessor({}, { alive: () => { throw new Error('never probed'); } }), { waited: false, predecessor: null });
  await assert.rejects(awaitLoopPredecessor({ [loopPredecessorVariable]: '4242' }, { alive: () => true, pollMs: 1, timeoutMs: 5, self: 1 }), /did not stop within .* this successor exits rather than run beside it/);

  // The moved-HEAD recovery re-executes through the same path: a clean forward move served by a verified release loads.
  const state = emptyDaemonState(master);
  state.deployment = verified(hex('b'));
  const fake = new FakeGit(hex('b'), hex('b'));
  const recovery = recordedReexecution(root);
  const recovered = await recoverMovedHead(master, state, hex('a'), hex('b'), { root, run: fake.run, restartExecutors: async to => restarted(to), restartSelf: async () => { reexecuteUnsupervised(recovery.input); }, now: () => clock });
  assert.deepEqual({ outcome: recovered.outcome, self: recovered.outcome === 'upgraded' && recovered.self }, { outcome: 'upgraded', self: true });
  assert.equal(recovery.spawned.length, 1);
  assert.equal(recovery.killed.length, 1);
});

test('unit:loop-self-upgrade-after-verified-deployment — once a delivery is verified deployed, an unsupervised loop checks out the base tip, re-executes onto it between cycles and releases its lock, and its successor loads that tip', async () => {
  const { reexecuteUnsupervised } = await reexecution();
  const { master } = await fixture();
  const repo = await temporaryDirectory('loop-reexec-repo');
  await writeFile(join(repo, 'README.md'), 'first\n');
  git(repo, 'init', '-q'); git(repo, 'add', 'README.md'); git(repo, 'commit', '-q', '-m', 'first');
  const loaded = git(repo, 'rev-parse', 'HEAD');
  const fake = new FakeGit(loaded, hex('c'));
  const state = emptyDaemonState(master);
  await writeDaemonState(master, state);
  state.deployment = verified(hex('c'));
  // The loop's signals arrive on its own process host; the re-execution's SIGTERM lands there.
  const host = new EventEmitter();
  const recorded = recordedReexecution(repo, (_pid, signal) => { host.emit(signal); });
  let upgrades = 0;
  const effects = {
    snapshot: async () => ({ work: [], now: iso(0) }),
    agents: () => [], credentials: async () => ({}),
    observeDeployment: async () => state.deployment,
    requestSmoke: async () => {}, merge: async () => {}, recordDeployment: async () => {}, requestProof: async () => {},
    dispatch: async () => {}, recordSession: async () => {}, closeSession: () => {},
    persist: (written: DaemonState) => writeDaemonState(master, written),
    loadedRelease: readRelease(repo),
    selfUpgrade: async (current: DaemonState) => {
      upgrades += 1;
      return performSelfUpgrade(master, current, { root: repo, run: fake.run, restartExecutors: async to => restarted(to), restartSelf: async () => { reexecuteUnsupervised(recorded.input); }, now: () => clock });
    },
  } as unknown as DaemonEffects;
  const bound = new AbortController();
  const result = await Promise.race([
    runDaemon(master, state, effects, { intervalMs: 20_000, identity: { pid: process.pid, host: master.hostId }, process: host as unknown as NodeJS.Process, signals: ['SIGTERM'] }),
    delay(15_000, undefined, { signal: bound.signal }).then(() => { throw new Error('the loop did not stop after re-executing itself'); }),
  ]).finally(() => bound.abort());
  assert.equal(result.stopped, true, 'the loop ended between cycles on its own re-execution, not by a timeout');
  assert.equal(result.cycles.length, 1, 'after exactly the cycle that preceded the upgrade');
  assert.equal(upgrades, 1);
  assert.deepEqual(fake.checkouts, [hex('c')], 'the checkout holds the verified base tip');
  assert.deepEqual(state.upgrade.last, { at: iso(0), from: loaded, to: hex('c'), code: true, executors: 'restarted', self: true });
  assert.equal(state.upgrade.alignedRelease, hex('c'));
  assert.equal(recorded.spawned.length, 1, 'one successor was started');
  assert.equal(recorded.spawned[0].predecessor, '4242');
  assert.deepEqual(recorded.killed, [{ pid: 4242, signal: 'SIGTERM' }]);
  const persisted = await readDaemonState(repo, master);
  assert.equal(persisted.lock, null, 'the lock the successor waits on is released');
  assert.equal(persisted.upgrade.alignedRelease, hex('c'), 'and the successor finds the alignment complete, never repeating it');
});
