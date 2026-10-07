import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
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
const successorReadyVariable = 'GRAPHYARD_LOOP_SUCCESSOR_READY';
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

/** A fake successor process: it reports ready as a real successor's setup does, unless told otherwise. */
function successor(pid: number | undefined, env: NodeJS.ProcessEnv, behaviour: 'ready' | 'exit' | 'silent' = 'ready') {
  const child = Object.assign(new EventEmitter(), { pid, exitCode: null as number | null, unrefs: 0, unref() { child.unrefs += 1; } });
  setImmediate(() => {
    if (behaviour === 'ready') writeFileSync(env[successorReadyVariable]!, `${pid}\n`);
    if (behaviour === 'exit') { child.exitCode = 1; child.emit('exit', 1, null); }
  });
  return child;
}

/** The re-execution with its process effects recorded: what it spawned, opened, closed and signalled. */
function recordedReexecution(root: string, onKill: (pid: number, signal: NodeJS.Signals) => void = () => {}, behaviour: 'ready' | 'exit' | 'silent' = 'ready') {
  const spawned: { command: string; args: string[]; cwd: string; detached: boolean; predecessor: string | undefined; child: ReturnType<typeof successor> }[] = [];
  const killed: { pid: number; signal: NodeJS.Signals }[] = [];
  const closed: number[] = [];
  const input: UnsupervisedReexecution = {
    root, cliPath: launcher, logDirectory: root, execPath: '/usr/bin/node', pid: 4242, env: { PATH: '/usr/bin' }, pollMs: 1, readyMs: 2_000,
    open: () => 7, close: fd => { closed.push(fd); },
    spawn: (command, args, options) => {
      const child = successor(4343, options.env, behaviour);
      spawned.push({ command, args, cwd: options.cwd, detached: options.detached, predecessor: options.env[loopPredecessorVariable], child });
      return child;
    },
    kill: (pid, signal) => { killed.push({ pid, signal }); onKill(pid, signal); },
  };
  return { input, spawned, killed, closed };
}

test('unit:master-loop-supervised-restart — a loop no supervisor unit runs re-executes itself onto the checkout: it starts its successor detached and stops by its own SIGTERM, and the successor waits for it to exit', async () => {
  const { awaitLoopPredecessor, reexecuteUnsupervised } = await reexecution();
  assert.equal((await reexecution()).loopPredecessorVariable, loopPredecessorVariable);
  const { root, master } = await fixture();
  // The successor is `master run` from the coordinator checkout, detached, told which loop it replaces;
  // the loop stops only once the successor reports ready, and closes its copy of the log descriptor.
  const recorded = recordedReexecution(root);
  assert.deepEqual(await reexecuteUnsupervised(recorded.input), { successor: 4343 });
  assert.deepEqual(recorded.spawned.map(({ child, ...entry }) => ({ ...entry, unrefs: child.unrefs })), [{ command: '/usr/bin/node', args: [launcher, 'master', 'run'], cwd: root, detached: true, predecessor: '4242', unrefs: 1 }]);
  assert.deepEqual(recorded.killed, [{ pid: 4242, signal: 'SIGTERM' }], 'and the running loop is stopped the way a supervisor stops it');
  assert.deepEqual(recorded.closed, [7]);

  // A successor that exits during its setup, or never reports ready, leaves the running loop alone:
  // no SIGTERM to it, a failure the upgrade records, and the descriptor still closed.
  const exited = recordedReexecution(root, () => {}, 'exit');
  await assert.rejects(reexecuteUnsupervised(exited.input), /exited before it was ready \(code 1\), so this loop keeps running/);
  assert.deepEqual([exited.killed, exited.closed], [[], [7]]);
  const silent = recordedReexecution(root, () => {}, 'silent');
  await assert.rejects(reexecuteUnsupervised({ ...silent.input, readyMs: 20 }), /did not report ready within .* and was stopped, so this loop keeps running/);
  assert.deepEqual(silent.killed, [{ pid: 4343, signal: 'SIGTERM' }], 'only the unready successor is stopped');

  // A real launch failure arrives as an 'error' event after spawn returns: it fails the re-execution,
  // and this process — the loop — survives it, unsignalled.
  const unsignalled: number[] = [];
  await assert.rejects(reexecuteUnsupervised({ root, cliPath: launcher, logDirectory: root, execPath: join(root, 'missing-node'), pollMs: 1, kill: pid => { unsignalled.push(pid); } }),
    /could not be launched: .*ENOENT.*so this loop keeps running/);
  await delay(20);
  assert.deepEqual(unsignalled, []);

  // A real detached process receives the argv and the predecessor it waits for, and reports ready.
  const script = join(root, 'successor.mjs'), out = join(root, 'successor.json');
  await writeFile(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), predecessor: process.env.${loopPredecessorVariable}, cwd: process.cwd() }));\nwriteFileSync(process.env.${successorReadyVariable}, String(process.pid));\n`);
  const signalled: number[] = [];
  const real = await reexecuteUnsupervised({ root, cliPath: script, logDirectory: root, pollMs: 5, kill: pid => { signalled.push(pid); } });
  assert.ok(real.successor! > 0);
  assert.deepEqual(signalled, [process.pid]);
  assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), { argv: ['master', 'run'], predecessor: String(process.pid), cwd: root });

  // The successor reports ready, then waits for its predecessor before it reads the cursor, however
  // long that loop's shutdown takes; where a unit is installed it leaves the unit time to take the lock.
  // A process started otherwise does not wait.
  const readyFile = join(root, 'ready-probe');
  let checks = 0;
  assert.deepEqual(await awaitLoopPredecessor({ [loopPredecessorVariable]: '4242', [successorReadyVariable]: readyFile }, { alive: () => ++checks < 3, pollMs: 1, self: 1, unitInstalled: () => false }), { waited: true, predecessor: 4242, handover: false });
  assert.equal(checks, 3);
  assert.equal((await readFile(readyFile, 'utf8')).trim(), '1');
  let polls = 0;
  const handed = await awaitLoopPredecessor({ [loopPredecessorVariable]: '4242' }, { alive: () => ++polls < 200, pollMs: 1, self: 1, unitInstalled: () => true, handoverMs: 1 });
  assert.deepEqual([handed, polls], [{ waited: true, predecessor: 4242, handover: true }, 200], 'no deadline gives up on a predecessor still shutting down');
  assert.deepEqual(await awaitLoopPredecessor({}, { alive: () => { throw new Error('never probed'); } }), { waited: false, predecessor: null, handover: false });

  // The moved-HEAD recovery re-executes through the same path: a clean forward move served by a verified release loads.
  const state = emptyDaemonState(master);
  state.deployment = verified(hex('b'));
  const fake = new FakeGit(hex('b'), hex('b'));
  const recovery = recordedReexecution(root);
  const recovered = await recoverMovedHead(master, state, hex('a'), hex('b'), { root, run: fake.run, restartExecutors: async to => restarted(to), restartSelf: async () => { await reexecuteUnsupervised(recovery.input); }, now: () => clock });
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
      return performSelfUpgrade(master, current, { root: repo, run: fake.run, restartExecutors: async to => restarted(to), restartSelf: async () => { await reexecuteUnsupervised(recorded.input); }, now: () => clock });
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
