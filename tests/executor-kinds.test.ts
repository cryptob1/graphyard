import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, writeDaemonState } from '../src/master-daemon.js';
import { loadMasterConfig } from '../src/master.js';
import { loopUnitName } from '../src/supervisor.js';
import { executorRunnableKinds, type NextActionKind } from '../src/model/action-kinds.js';
import { detectLoopMerger, installationMerger, loopMergeGuardedEffects, loopMergeRefusal } from '../src/executor.js';
import { executorDeclarationFile, executorUnit, installExecutorSupervision, loopMergerExecutorKinds, type SystemctlRunner } from '../src/repository-setup.js';
import type { ExecutorEffects } from '../src/auto-dispatch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const launcher = join(root, 'bin/graphyard.mjs');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const template = await readFile(join(root, 'examples/master/graphyard-executor@.service'), 'utf8');
const systemctl: SystemctlRunner = args => args[0] === 'is-active' ? 'active' : '';

/** A coordinator host: master.json and its credential, one unit directory with the loop's unit installed and one without. */
async function coordinatorHost() {
  const base = await temporaryDirectory('executor-kinds');
  const checkout = join(base, 'checkout'), credentials = join(base, 'credentials');
  await mkdir(join(checkout, '.graphyard'), { recursive: true, mode: 0o700 }); await mkdir(credentials, { mode: 0o700 });
  git(checkout, 'init', '-q'); git(checkout, 'remote', 'add', 'origin', 'https://github.com/owner/project.git');
  const credentialFile = join(credentials, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await writeFile(join(checkout, '.graphyard/master.json'), JSON.stringify({ version: 1, url: 'http://127.0.0.1:9', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'unit-host', masterAgentName: 'graphyard-master-unit', autoMerge: true, mergeMethod: 'merge', workers: [], run: {} }), { mode: 0o600 });
  const withLoop = join(base, 'systemd-with-loop'), withoutLoop = join(base, 'systemd-without-loop');
  await mkdir(withLoop); await mkdir(withoutLoop);
  await writeFile(join(withLoop, loopUnitName), '[Service]\nExecStart=/bin/true\n');
  return { base, checkout, withLoop, withoutLoop };
}

test('unit:single-merger-default the executor install leaves merge to a merging loop, keeps it without one, and a live loop makes an executor refuse merge rows', async () => {
  const host = await coordinatorHost();
  try {
    const install = (unitDirectory: string, kinds?: NextActionKind[]) => installExecutorSupervision(host.checkout, { run: systemctl, unitDirectory, template, node: process.execPath, ...(kinds ? { kinds } : {}) });
    const declared = async () => JSON.parse(await readFile(join(host.checkout, executorDeclarationFile), 'utf8')).kinds as NextActionKind[] | null;

    // 1. The loop's unit is installed and it merges automatically: the executors are declared
    //    with every kind they can run except merge, and the running slots restart onto it.
    const beside = await install(host.withLoop);
    assert.deepEqual(beside.declaration.kinds, executorRunnableKinds.filter(kind => kind !== 'merge'));
    assert.ok(!(beside.declaration.kinds as string[]).includes('merge'));
    assert.deepEqual(await declared(), loopMergerExecutorKinds);
    assert.match(beside.merger, /master loop \(graphyard-master\.service, automatic merging on\) merges/);
    // An explicit kind list that puts merge beside the loop is refused, naming the loop.
    await assert.rejects(install(host.withLoop, ['resync', 'merge']), /master loop \(graphyard-master\.service.*\) merges on this installation; an executor declared with merge would race it/);
    assert.deepEqual((await install(host.withLoop, ['resync', 'reclaim'])).declaration.kinds, ['resync', 'reclaim']);

    // 2. No loop on the host: the executors keep merge — the default (every kind) comes back,
    //    and an explicit list with merge is kept as declared.
    assert.deepEqual((await installExecutorSupervision(host.checkout, { run: systemctl, unitDirectory: host.withLoop, template, node: process.execPath, kinds: null })).declaration.kinds, loopMergerExecutorKinds);
    const restarted: string[][] = [];
    const alone = await installExecutorSupervision(host.checkout, { run: args => { restarted.push(args); return systemctl(args); }, unitDirectory: host.withoutLoop, template, node: process.execPath });
    assert.equal(alone.declaration.kinds, null, 'without a loop the executors serve every kind, merge included');
    assert.equal(await declared(), null);
    assert.match(alone.merger, /no master loop merges on this host, so the executors run the guarded merge/);
    assert.ok(restarted.some(args => args[0] === 'restart' && args.includes(executorUnit(1))), 'a changed kind list restarts the slots that read it at start');
    assert.deepEqual((await install(host.withoutLoop, ['resync', 'merge'])).declaration.kinds, ['resync', 'merge']);

    // 3. The refusal: an executor that still serves merge, beside a live loop on this installation
    //    (its cursor holds a lock with a fresh cycle), claims without merge and says why, naming the loop.
    const config = await loadMasterConfig(host.checkout);
    assert.equal(await detectLoopMerger(host.checkout, { config, unitDirectory: host.withoutLoop }), null, 'no unit and no cursor: no loop');
    const now = Date.now();
    await writeDaemonState(config, { ...emptyDaemonState(config), cycle: 3, lastCycleAt: new Date(now - 5_000).toISOString(),
      lock: { id: 'loop-lock', pid: process.pid, host: 'unit-host', startedAt: new Date(now - 60_000).toISOString(), heartbeatAt: new Date(now - 5_000).toISOString() } });
    const loop = await detectLoopMerger(host.checkout, { config, unitDirectory: host.withoutLoop, now });
    assert.ok(loop?.live, 'a live cursor lock is a running loop');
    assert.match(loop!.name, new RegExp(`the master loop \\(pid ${process.pid} on unit-host, automatic merging on\\)`));
    const claims: NextActionKind[][] = [], logged: string[] = [];
    const effects: ExecutorEffects = { claim: async request => { claims.push(request.kinds); return { action: null, open: 0 }; }, settle: async () => {}, handlers: {} };
    const guarded = loopMergeGuardedEffects(effects, () => detectLoopMerger(host.checkout, { config, unitDirectory: host.withoutLoop }), line => logged.push(line));
    await guarded.claim({ host: 'unit-host', executor: 'master@unit-host/1', kinds: ['resync', 'merge'] });
    assert.deepEqual(claims, [['resync']], 'the merge kind never reaches the claim, so the executor never writes the item the loop is merging');
    assert.deepEqual(await guarded.claim({ host: 'unit-host', executor: 'master@unit-host/1', kinds: ['merge'] }), { action: null, open: 0 });
    assert.equal(claims.length, 1, 'an executor serving only merge claims nothing beside the loop');
    assert.equal(logged.length, 1, 'the refusal is said once while the same loop stands');
    assert.equal(logged[0], `[graphyard-executor] master@unit-host/1: ${loopMergeRefusal(loop!)}`);
    assert.match(logged[0], /the master loop \(pid \d+ on unit-host, automatic merging on\) merges on this installation, so this executor refuses merge rows/);
    // The loop stops: its lock is released, and the executor claims merge again.
    await writeDaemonState(config, { ...emptyDaemonState(config), cycle: 3, lastCycleAt: new Date(now - 5_000).toISOString(), lock: null });
    await guarded.claim({ host: 'unit-host', executor: 'master@unit-host/1', kinds: ['resync', 'merge'] });
    assert.deepEqual(claims.at(-1), ['resync', 'merge']);
  } finally { await rm(host.base, { recursive: true, force: true }); }
});

test('unit:dual-merger-surfaced master status names the merger and raises an attention item when the loop and the executors both merge', () => {
  const loopOn = { configured: true, running: true, autoMerge: true }, loopOff = { configured: false, running: false, autoMerge: true };
  const beside = installationMerger({ loop: loopOn, declaration: { count: 2, kinds: loopMergerExecutorKinds }, served: loopMergerExecutorKinds });
  assert.equal(beside.merger, 'loop');
  assert.match(beside.detail, /the master loop runs the guarded merge; the executors do not/);
  assert.deepEqual(beside.attention, []);
  const alone = installationMerger({ loop: loopOff, declaration: { count: 1, kinds: null }, served: [] });
  assert.equal(alone.merger, 'executors');
  assert.deepEqual(alone.attention, []);

  // Both: the loop runs and this host declares executors serving every kind (merge included).
  const both = installationMerger({ loop: loopOn, declaration: { count: 1, kinds: null }, served: [] });
  assert.equal(both.merger, 'both');
  assert.equal(both.attention.length, 1);
  assert.equal(both.attention[0].subject, 'installation');
  assert.match(both.attention[0].text, /Two components merge: the master loop is running and the executors serve merge \(this host declares every kind\)/);
  assert.match(both.attention[0].next, /node scripts\/graphyard-executor\.mjs --install/);
  assert.equal(both.attention[0].human, false);
  // A live executor elsewhere serving merge beside an installed loop is the same race.
  const remote = installationMerger({ loop: { configured: true, running: false, autoMerge: false }, declaration: null, served: ['resync', 'merge'] });
  assert.equal(remote.merger, 'both');
  assert.match(remote.attention[0].text, /the master loop is installed and the executors serve merge \(a live executor serves it\)/);
});
