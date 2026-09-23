import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { executorsCommand } from '../src/cli/master-executors.js';
import { runExecutor, type ExecutorEffects } from '../src/auto-dispatch.js';
import { releaseGuardedEffects, staleReleaseReason } from '../src/executor.js';
import { detectSupervisorUnit, executorFleetReport, executorRegistrar, executorRestartCommand, executorsDirectory, readCommit, readExecutorRegistrations, readRelease, readRestartFence, restartFenceFile, removeExecutorRegistration, restartExecutors, writeExecutorRegistration, type ExecutorRegistration } from '../src/executor-fleet.js';
import type { ActionRow } from '../src/model/actions.js';

/**
 * GY-126: a stateless executor loads its modules once, so a delivered fix never reached it and the
 * fleet kept running the code it had when it booted. Each test is named for the proof it produces:
 * unit:executor-release-reported, integration:stale-executor-stands-down and
 * integration:executor-restart-command.
 *
 * The executors here are the shipped loop (`runExecutor`) over the shipped guard
 * (`releaseGuardedEffects`) and record (`executorRegistrar`), with the control plane stubbed at the
 * claim; the supervisor is a stub that records every command and, when told to restart a unit,
 * registers a fresh executor the way a restarted process does.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-executor-release-'));
  git(root, 'init', '-q');
  git(root, 'remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'first\n');
  git(root, 'add', 'README.md'); git(root, 'commit', '-q', '-m', 'first');
  return root;
}
async function commit(root: string, text: string) { await writeFile(join(root, 'README.md'), `${text}\n`); git(root, 'commit', '-q', '-am', text); return git(root, 'rev-parse', 'HEAD'); }
async function fixture() {
  const root = await repository();
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-executor-credentials-'));
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const dispose = async () => { await rm(root, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }); };
  return { root, master, dispose };
}
const masterApi = async (path: string) => path === 'work-snapshot' ? { work: [], now: new Date().toISOString() } : { decisions: [] };
const status = (root: string, master: MasterConfig, commit: string | null) => masterStatusReport(root, master, masterApi, { actor: { id: 'coordinator-1' } }, { commit });
const row = (id: string, key: string, kind: ActionRow['kind'] = 'resync'): ActionRow => ({ id, kind, work: `work-${key}`, key, inputs: { kind: 'resync' } as ActionRow['inputs'], gate: 'build', refusal: null, reason: 'test', binding: 'b',
  requestedBy: 'graphyard', requestedAt: new Date().toISOString(), state: 'pending', claim: null, attempts: 0, history: [] });
const otherCommit = 'b'.repeat(40);
const deadPid = 2_147_483_646;
/** A record as an executor on another commit would have written it. */
const registered = (master: MasterConfig, name: string, commit: string, overrides: Partial<ExecutorRegistration> = {}): ExecutorRegistration => ({
  version: 1, name, host: master.hostId, pid: process.pid, principal: 'graphyard-master', kinds: ['resync', 'merge'], intervalSeconds: 5, root: '/srv/graphyard',
  release: { commit, dirty: false }, supervisor: { unit: `graphyard-executor@${name}.service`, restart: `systemctl --user restart graphyard-executor@${name}.service` },
  state: 'running', standDown: null, startedAt: new Date(Date.now() - 60_000).toISOString(), updatedAt: new Date().toISOString(), stoppedAt: null, claims: 3, lastClaim: null, inFlight: null, claiming: null, ...overrides });

test('unit:executor-release-reported — an executor records the commit it loaded, dirty or not, on each claim and in its registration, and master status lists each executor\'s commit beside the coordinator\'s', async () => {
  const { root, master, dispose } = await fixture();
  try {
    // The release is read from the checkout: the commit, and whether tracked files differ from it.
    const first = readRelease(root);
    assert.equal(first.commit, git(root, 'rev-parse', 'HEAD'));
    assert.equal(first.dirty, false);
    await writeFile(join(root, 'README.md'), 'edited but not committed\n');
    assert.deepEqual(readRelease(root), { commit: first.commit, dirty: true }, 'uncommitted changes to tracked files make the release dirty');
    assert.equal(readCommit(root), first.commit);
    assert.deepEqual(readRelease(join(tmpdir())), { commit: null, dirty: null }, 'no checkout reads as unknown, never as a guess');
    git(root, 'checkout', '-q', '--', 'README.md');

    // The record: written running at startup with the loaded release, and rewritten on every claim
    // with the release that claim runs on.
    const registrar = executorRegistrar(master, { name: 'exec-1', host: master.hostId, pid: process.pid, principal: 'graphyard-master', kinds: ['resync'], intervalSeconds: 5, root, release: first, supervisor: 'graphyard-executor@exec-1.service' });
    await registrar.started();
    const [written] = await readExecutorRegistrations(master);
    assert.equal(written.name, 'exec-1');
    assert.deepEqual(written.release, first);
    assert.equal(written.state, 'running');
    assert.deepEqual(written.supervisor, { unit: 'graphyard-executor@exec-1.service', restart: 'systemctl --user restart graphyard-executor@exec-1.service' });
    assert.equal(written.claims, 0);
    assert.match(await readFile(registrar.file, 'utf8'), /"commit": "[0-9a-f]{40}"/);
    assert.ok(registrar.file.startsWith(executorsDirectory(master)), 'the record lives beside the coordinator credential');

    const claims: string[] = [];
    const base: ExecutorEffects = {
      claim: async request => { claims.push(request.executor); return { action: claims.length === 1 ? row('a1', 'GY-1') : null, open: 0 }; },
      settle: async () => ({}),
      handlers: { resync: async () => 'ok' },
    };
    const guarded = releaseGuardedEffects(base, { loaded: first, current: () => readCommit(root), standDown: () => assert.fail('an executor on its checkout\'s commit never stands down'), claimed: action => registrar.claimed(action), settled: () => registrar.settled() });
    const claimed = await guarded.claim({ host: master.hostId, executor: 'exec-1', kinds: ['resync'] });
    assert.equal(claimed.action?.id, 'a1');
    let after = (await readExecutorRegistrations(master))[0];
    assert.equal(after.claims, 1);
    assert.deepEqual(after.lastClaim && { key: after.lastClaim.key, kind: after.lastClaim.kind, release: after.lastClaim.release }, { key: 'GY-1', kind: 'resync', release: first }, 'the claim records the loaded release');
    assert.equal(after.inFlight?.key, 'GY-1', 'and the action in flight');
    await guarded.settle(claimed.action!, 'done', 'ok');
    after = (await readExecutorRegistrations(master))[0];
    assert.equal(after.inFlight, null);
    assert.equal(after.claims, 1);
    await guarded.claim({ host: master.hostId, executor: 'exec-1', kinds: ['resync'] });
    assert.deepEqual(claims, ['exec-1', 'exec-1'], 'an executor on the checkout\'s commit keeps claiming');

    // Two executors on different commits: status lists each with its commit beside the
    // coordinator's, so the split reads in one line per executor.
    await writeExecutorRegistration(master, registered(master, 'exec-2', otherCommit, { release: { commit: otherCommit, dirty: true } }));
    const report = await status(root, master, first.commit);
    assert.equal(report.executors.coordinator.commit, first.commit);
    const lines = Object.fromEntries(report.executors.executors.map(entry => [entry.name, entry.line]));
    assert.equal(lines['exec-1'], `exec-1 on host-a runs ${first.commit!.slice(0, 12)} beside the coordinator's ${first.commit!.slice(0, 12)}`);
    assert.equal(lines['exec-2'], `exec-2 on host-a runs ${otherCommit.slice(0, 12)} (dirty) beside the coordinator's ${first.commit!.slice(0, 12)} — split, claims until its next check`);
    const byName = Object.fromEntries(report.executors.executors.map(entry => [entry.name, entry]));
    assert.deepEqual({ exec1: byName['exec-1'].split, exec2: byName['exec-2'].split, fleet: report.executors.split }, { exec1: false, exec2: true, fleet: true });
    assert.deepEqual(byName['exec-2'].release, { commit: otherCommit, dirty: true }, 'the recorded commit and dirtiness are reported as recorded');
    assert.equal(byName['exec-1'].alive, true, 'a record on this host is checked against its process');
    assert.deepEqual(report.executors.needingRestart, ['exec-2']);
    // The same lines from the command, without the rest of the report.
    const listed = await executorsCommand(master, [], { actions: async () => ({}), coordinatorCommit: first.commit }) as { lines: string[] };
    assert.deepEqual(listed.lines.sort(), [lines['exec-1'], lines['exec-2']].sort());

    // A record whose process is gone is not a running executor, and a stopped one is not split.
    await writeExecutorRegistration(master, registered(master, 'exec-3', otherCommit, { pid: deadPid }));
    await writeExecutorRegistration(master, registered(master, 'exec-4', otherCommit, { state: 'stopped', stoppedAt: new Date().toISOString() }));
    const settled = executorFleetReport(await readExecutorRegistrations(master), { commit: first.commit }, { hostId: master.hostId });
    const states = Object.fromEntries(settled.executors.map(entry => [entry.name, { state: entry.state, needsRestart: entry.needsRestart }]));
    assert.deepEqual(states, { 'exec-1': { state: 'running', needsRestart: false }, 'exec-2': { state: 'running', needsRestart: true }, 'exec-3': { state: 'gone', needsRestart: false }, 'exec-4': { state: 'stopped', needsRestart: false } });

    // The supervisor unit is read from the process itself, and only an executor unit counts.
    assert.equal(detectSupervisorUnit({ env: {}, cgroup: '0::/user.slice/user-1000.slice/user@1000.service/app.slice/graphyard-executor@exec-1.service\n' }), 'graphyard-executor@exec-1.service');
    assert.equal(detectSupervisorUnit({ env: {}, cgroup: '0::/user.slice/user-1000.slice/user@1000.service/app.slice/herdr.service\n' }), null, 'a terminal multiplexer\'s unit is not this executor\'s supervisor');
    assert.equal(detectSupervisorUnit({ env: { GRAPHYARD_EXECUTOR_UNIT: 'graphyard-executor@custom.service' }, cgroup: null }), 'graphyard-executor@custom.service');
    assert.equal(detectSupervisorUnit({ env: {}, cgroup: null }), null);
    assert.equal(detectSupervisorUnit({ named: 'graphyard-executor@by-hand.service', env: { GRAPHYARD_EXECUTOR_UNIT: 'graphyard-executor@custom.service' }, cgroup: null }), 'graphyard-executor@by-hand.service', '--unit names the unit over the environment');
    // Every source is held to the same rule: a named unit that is not an executor's own is refused, never recorded.
    assert.throws(() => detectSupervisorUnit({ env: { GRAPHYARD_EXECUTOR_UNIT: 'dbus.service' }, cgroup: null }), /dbus\.service is not a graphyard-executor service/);
    assert.throws(() => detectSupervisorUnit({ named: 'pipewire.service', env: {}, cgroup: null }), /pipewire\.service is not a graphyard-executor service/);
    assert.throws(() => detectSupervisorUnit({ named: 'graphyard-executorish.service', env: {}, cgroup: null }), /is not a graphyard-executor service/);
    assert.equal(detectSupervisorUnit({ env: {}, cgroup: '0::/user.slice/app.slice/graphyard-executorish.service\n' }), null);
    assert.throws(() => executorRegistrar(master, { name: 'exec-9', host: master.hostId, pid: process.pid, principal: 'graphyard-master', kinds: ['resync'], intervalSeconds: 5, root, release: first, supervisor: 'dbus.service' }), /dbus\.service is not a graphyard-executor service/);
  } finally { await dispose(); }
});

test('integration:stale-executor-stands-down — an executor whose checkout moved on finishes the action in flight, claims nothing more, says why with the restart command, and master status raises one attention item naming every such executor', async () => {
  const { root, master, dispose } = await fixture();
  try {
    const loaded = readRelease(root);
    const events: string[] = [];
    let moved: string | null = null;
    const registrar = executorRegistrar(master, { name: 'exec-1', host: master.hostId, pid: process.pid, principal: 'graphyard-master', kinds: ['resync'], intervalSeconds: 5, root, release: loaded, supervisor: 'graphyard-executor@exec-1.service' });
    await registrar.started();
    let offered = 0;
    const base: ExecutorEffects = {
      claim: async () => { offered += 1; events.push(`claim ${offered}`); return { action: offered === 1 ? row('a1', 'GY-1') : null, open: 0 }; },
      settle: async (action, result) => { events.push(`settle ${action.key} ${result}`); return {}; },
      handlers: {
        // The fix lands while the action runs: the checkout moves under the executor mid-handler.
        resync: async () => { moved = await commit(root, 'the delivered fix'); events.push('moved'); return 'resynced'; },
      },
    };
    const guarded = releaseGuardedEffects(base, {
      loaded, current: () => readCommit(root),
      claimed: action => registrar.claimed(action), settled: () => registrar.settled(),
      standDown: detail => { events.push(`stand down: ${detail.reason}`); return registrar.standDown(detail); },
      resumed: () => { events.push('resumed'); return registrar.resumed(); },
    });
    const { steps } = await runExecutor({ id: 'exec-1', host: master.hostId }, guarded, { intervalMs: 5, maxSteps: 4 });

    // One claim ran to its settlement under the code it started with; every later tick refused
    // to claim before asking the queue, and said so once.
    assert.equal(steps[0].result, 'done');
    assert.deepEqual(steps.slice(1).map(step => step.result), ['idle', 'idle', 'idle']);
    assert.equal(offered, 1, 'the queue was asked once: a stale executor never claims');
    assert.equal(events[0], 'claim 1');
    assert.deepEqual(events.slice(1, 3), ['moved', 'settle GY-1 done'], 'the action in flight finishes and settles first');
    assert.equal(events[3], `stand down: ${staleReleaseReason(loaded, moved)}`);
    assert.equal(events.length, 4, 'the reason is recorded once, not per tick');
    assert.ok(guarded.standingDown());
    const [record] = await readExecutorRegistrations(master);
    assert.equal(record.state, 'standing-down');
    assert.equal(record.standDown?.current, moved);
    assert.equal(record.standDown?.restart, executorRestartCommand, 'the record names the command that restarts it');
    assert.match(record.standDown!.reason, new RegExp(`loaded ${loaded.commit!.slice(0, 12)} at startup and its checkout now holds ${moved!.slice(0, 12)}`));
    assert.equal(record.inFlight, null);
    assert.deepEqual(record.release, loaded, 'the loaded release stays what it was: the process still runs it');

    // Status: the coordinator runs the new commit; one item names every executor that stood down or
    // will, with the fleet restart as the next command, and it is counted.
    await writeExecutorRegistration(master, registered(master, 'exec-2', loaded.commit!, { supervisor: null }));
    const report = await status(root, master, moved);
    const items = report.attentionItems.filter(item => item.subject === 'executors');
    assert.equal(items.length, 1, `one attention item for the fleet: ${JSON.stringify(items)}`);
    assert.match(items[0].text, /2 executors run a release other than the coordinator's/);
    assert.match(items[0].text, new RegExp(`exec-1 on host-a \\(loaded ${loaded.commit!.slice(0, 12)}, standing down since ${record.standDown!.at.slice(0, 10)}`));
    assert.match(items[0].text, /exec-2 on host-a \(loaded [0-9a-f]{12}, stands down at its next check; no supervisor unit, so it must be stopped and started by hand\)/);
    assert.equal(items[0].next, executorRestartCommand);
    assert.equal(items[0].role, 'master', 'the master runs the restart; no human is asked');
    assert.deepEqual(report.executors.needingRestart.sort(), ['exec-1', 'exec-2']);
    assert.equal(report.executors.executors.find(entry => entry.name === 'exec-1')!.line, `exec-1 on host-a runs ${loaded.commit!.slice(0, 12)} beside the coordinator's ${moved!.slice(0, 12)} — split, standing down`);
    assert.ok(report.counts.attention >= 1);
    const without = await status(root, master, loaded.commit);
    assert.equal(without.attentionItems.filter(item => item.subject === 'executors' && /exec-2/.test(item.text)).length, 0, 'an executor on the coordinator\'s commit raises nothing');

    // A checkout that comes back to the loaded commit is not stale any more: claiming resumes.
    git(root, 'reset', '-q', '--hard', loaded.commit!);
    await runExecutor({ id: 'exec-1', host: master.hostId }, guarded, { intervalMs: 5, maxSteps: 1 });
    assert.equal(offered, 2);
    assert.equal(events.at(-2), 'resumed');
    assert.equal((await readExecutorRegistrations(master))[0].state, 'running');
    assert.equal(guarded.standingDown(), false);
  } finally { await dispose(); }
});

test('integration:executor-restart-command — master executors restart refuses while an executor holds a claimed action, naming it, and otherwise restarts every registered executor through its supervisor and waits for each to register again on the current release', async () => {
  const { root, master, dispose } = await fixture();
  try {
    const current = readCommit(root)!;
    await writeExecutorRegistration(master, registered(master, 'exec-1', otherCommit));
    await writeExecutorRegistration(master, registered(master, 'exec-2', otherCommit, { state: 'standing-down', standDown: { at: new Date().toISOString(), reason: 'stale', current, restart: executorRestartCommand } }));
    const calls: string[][] = [];
    const supervisor = (behaviour: 'reregister' | 'silent') => (command: string, args: string[]) => {
      calls.push([command, ...args]);
      if (command === 'systemctl' && args[1] === 'restart' && behaviour === 'reregister') {
        // The unit's new process registers itself a moment later, on the checkout's current commit.
        const name = args[2].replace(/^graphyard-executor@|\.service$/g, '');
        void delay(10).then(() => executorRegistrar(master, { name, host: master.hostId, pid: process.pid + 1, principal: 'graphyard-master', kinds: ['resync'], intervalSeconds: 5, root, release: { commit: current, dirty: false }, supervisor: args[2] }).started());
      }
      return '';
    };
    const quick = { sleep: (ms: number) => delay(Math.min(ms, 5)).then(() => {}), timeoutMs: 2_000 };

    // A claimed action anywhere on this host refuses the whole restart, by executor and action.
    const claimed: ActionRow = { ...row('a1', 'GY-7', 'merge'), state: 'claimed', claim: { executor: 'exec-1', host: master.hostId, principal: 'graphyard-master', claimedAt: '2026-09-22T10:00:00.000Z', expiresAt: '2026-09-22T10:02:00.000Z', attempt: 1 } };
    const busy = { queue: { executors: [{ executor: 'exec-1', host: master.hostId, actions: 1 }, { executor: 'exec-9', host: 'host-b', actions: 1 }] }, actions: [claimed] };
    const refused = await restartExecutors(master, { actions: async () => busy, coordinatorCommit: current, run: supervisor('reregister'), ...quick });
    assert.equal(refused.result, 'refused');
    assert.deepEqual(refused.held, [{ name: 'exec-1', host: master.hostId, key: 'GY-7', kind: 'merge', id: 'a1', since: '2026-09-22T10:00:00.000Z' }], 'another host\'s claim does not hold this host\'s restart');
    assert.match(refused.reason!, /exec-1 holds merge for GY-7 since 2026-09-22T10:00:00.000Z/);
    assert.equal(calls.length, 0, 'nothing was restarted');
    // An action the record says is in flight refuses too, even before the control plane shows the claim.
    await writeExecutorRegistration(master, registered(master, 'exec-1', otherCommit, { inFlight: { id: 'a2', key: 'GY-8', kind: 'dispatch', since: '2026-09-22T10:01:00.000Z' } }));
    const held = await restartExecutors(master, { actions: async () => ({ queue: { executors: [] }, actions: [] }), coordinatorCommit: current, run: supervisor('reregister'), ...quick });
    assert.equal(held.result, 'refused');
    assert.match(held.reason!, /exec-1 holds dispatch for GY-8/);
    await writeExecutorRegistration(master, registered(master, 'exec-1', otherCommit));

    // Without a claim: both units are restarted, their new processes register on the current
    // commit, and the result says what each ran before and runs now.
    const idle = async () => ({ queue: { executors: [] }, actions: [] });
    const restarted = await restartExecutors(master, { actions: idle, coordinatorCommit: current, run: supervisor('reregister'), ...quick });
    assert.equal(restarted.result, 'restarted', restarted.reason ?? '');
    assert.deepEqual(calls.sort(), [['systemctl', '--user', 'restart', 'graphyard-executor@exec-1.service'], ['systemctl', '--user', 'restart', 'graphyard-executor@exec-2.service']], 'each executor is restarted through its own unit and nothing else is touched');
    assert.deepEqual(restarted.restarted.map(entry => ({ name: entry.name, unit: entry.unit, registered: entry.registered, before: entry.release.before.commit, after: entry.release.after?.commit, newPid: entry.pid.after !== entry.pid.before })).sort((a, b) => a.name.localeCompare(b.name)),
      [{ name: 'exec-1', unit: 'graphyard-executor@exec-1.service', registered: true, before: otherCommit, after: current, newPid: true }, { name: 'exec-2', unit: 'graphyard-executor@exec-2.service', registered: true, before: otherCommit, after: current, newPid: true }]);
    assert.deepEqual({ unsupervised: restarted.unsupervised, forgotten: restarted.forgotten, held: restarted.held }, { unsupervised: [], forgotten: [], held: [] });
    const after = executorFleetReport(await readExecutorRegistrations(master), { commit: current }, { hostId: master.hostId, alive: () => true });
    assert.deepEqual({ split: after.split, needing: after.needingRestart }, { split: false, needing: [] }, 'the fleet is whole again');

    // An executor with no supervisor unit is named with what stops and starts it, never signalled;
    // a record whose process is gone and which no unit brings back is forgotten.
    await writeExecutorRegistration(master, registered(master, 'exec-1', otherCommit));
    await writeExecutorRegistration(master, registered(master, 'exec-3', otherCommit, { supervisor: null, root }));
    await writeExecutorRegistration(master, registered(master, 'exec-4', otherCommit, { supervisor: null, pid: deadPid }));
    calls.length = 0;
    const partial = await restartExecutors(master, { actions: idle, coordinatorCommit: current, run: supervisor('reregister'), ...quick });
    assert.equal(partial.result, 'incomplete');
    assert.match(partial.reason!, /exec-3 has no supervisor unit and was not restarted/);
    assert.equal(partial.unsupervised.length, 1);
    assert.match(partial.unsupervised[0].instruction, new RegExp(`kill -TERM ${process.pid}.*node scripts/graphyard-executor.mjs --name exec-3`));
    assert.deepEqual(partial.forgotten, ['exec-4']);
    assert.equal((await readExecutorRegistrations(master)).some(entry => entry.name === 'exec-4'), false);
    assert.ok(calls.some(call => call[3] === 'graphyard-executor@exec-1.service'), 'the supervised executor was still restarted');
    assert.ok(!calls.some(call => call[0] === 'kill'), 'no process is signalled by this command');
    await removeExecutorRegistration(master, 'exec-3');

    // A unit whose executor never registers again is named at the timeout, not reported as back —
    // not even when the old process's own record was written moments before the restart.
    await removeExecutorRegistration(master, 'exec-2');
    await writeExecutorRegistration(master, registered(master, 'exec-1', otherCommit, { release: { commit: current, dirty: false }, startedAt: new Date().toISOString() }));
    const silent = await restartExecutors(master, { actions: idle, coordinatorCommit: current, run: supervisor('silent'), sleep: quick.sleep, timeoutMs: 30 });
    assert.equal(silent.result, 'incomplete');
    assert.match(silent.reason!, /exec-1 \(graphyard-executor@exec-1\.service\) did not register again on [0-9a-f]{12} within \d+s; read journalctl --user -u UNIT/);
    assert.equal(silent.restarted[0].registered, false);

    // The command: the same result, and a non-zero exit for anything but a whole restart.
    await writeExecutorRegistration(master, registered(master, 'exec-1', otherCommit));
    const before = process.exitCode;
    try {
      const outcome = await executorsCommand(master, ['restart', '--timeout', '5'], { actions: idle, coordinatorCommit: current, run: supervisor('reregister'), sleep: quick.sleep }) as { result: string; host: string };
      assert.deepEqual({ result: outcome.result, host: outcome.host }, { result: 'restarted', host: 'host-a' });
      assert.equal(process.exitCode, before);
      await writeExecutorRegistration(master, registered(master, 'exec-1', otherCommit, { inFlight: { id: 'a3', key: 'GY-9', kind: 'merge', since: new Date().toISOString() } }));
      const refusal = await executorsCommand(master, ['restart'], { actions: idle, coordinatorCommit: current, run: supervisor('reregister'), sleep: quick.sleep }) as { result: string };
      assert.equal(refusal.result, 'refused');
      assert.equal(process.exitCode, 1);
    } finally { process.exitCode = before; }
    await removeExecutorRegistration(master, 'exec-1');

    // The claim/restart race: the restart raises a fence before it reads, an executor announces a
    // claim before it looks for the fence, so neither order lets a claim slip between the reading
    // and the restart.
    const until = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i++) await delay(5); assert.ok(condition(), 'condition never held'); };
    const racer = executorRegistrar(master, { name: 'exec-5', host: master.hostId, pid: process.pid, principal: 'graphyard-master', kinds: ['merge'], intervalSeconds: 5, root, release: { commit: current, dirty: false }, supervisor: 'graphyard-executor@exec-5.service' });
    await racer.started();
    let asked = 0, answer: ((value: { action: ActionRow | null; open: number }) => void) | null = null;
    const racing = releaseGuardedEffects({ claim: () => { asked += 1; return new Promise(resolve => { answer = resolve; }); }, settle: async () => ({}), handlers: {} }, {
      loaded: { commit: current, dirty: false }, current: () => current, standDown: () => assert.fail('the executor is on the current commit'),
      claimed: action => racer.claimed(action), settled: () => racer.settled(), claiming: () => racer.claiming(), abandoned: () => racer.abandoned(), fenced: () => readRestartFence(master),
    });
    // The executor announced first and is waiting on the queue: the restart reads nothing and
    // restarts nothing until the claim is recorded, then refuses naming it.
    const inClaim = racing.claim({ host: master.hostId, executor: 'exec-5', kinds: ['merge'] });
    await until(() => asked === 1);
    calls.length = 0;
    let reads = 0;
    const racingRestart = restartExecutors(master, { actions: async () => { reads += 1; return { queue: { executors: [] }, actions: [] }; }, coordinatorCommit: current, run: supervisor('reregister'), ...quick });
    await delay(60);
    assert.equal(reads, 0, 'the queue is not read while a claim is announced');
    assert.equal(calls.length, 0, 'and nothing is restarted');
    assert.ok(await readRestartFence(master), 'the fence stands while the restart waits');
    answer!({ action: row('a5', 'GY-11', 'merge'), open: 0 });
    const won = await inClaim;
    assert.equal(won.action?.id, 'a5');
    const raced = await racingRestart;
    assert.equal(raced.result, 'refused');
    assert.match(raced.reason!, /exec-5 holds merge for GY-11/);
    assert.equal(calls.length, 0, 'the executor holding the claim was not restarted');
    assert.equal(await readRestartFence(master), null, 'the fence is lowered with the refusal');
    await racing.settle(won.action!, 'done', 'ok');

    // The restart raised its fence first: an executor that reaches its claim meanwhile does not ask
    // the queue, abandons the claim it announced, and the restart goes ahead.
    asked = 0;
    const fencedOut = await restartExecutors(master, { actions: async () => {
      const attempt = await racing.claim({ host: master.hostId, executor: 'exec-5', kinds: ['merge'] });
      assert.equal(attempt.action, null);
      return { queue: { executors: [] }, actions: [] };
    }, coordinatorCommit: current, run: supervisor('reregister'), ...quick });
    assert.equal(asked, 0, 'a fenced executor never asks the queue');
    assert.equal(fencedOut.result, 'restarted', fencedOut.reason ?? '');
    assert.deepEqual(calls, [['systemctl', '--user', 'restart', 'graphyard-executor@exec-5.service']]);
    assert.equal(await readRestartFence(master), null, 'the fence is lowered once the fleet is back');

    // A claim announced by a live executor that never resolves refuses the restart at the claim wait.
    await writeExecutorRegistration(master, registered(master, 'exec-5', current, { claiming: new Date().toISOString() }));
    calls.length = 0;
    const stuck = await restartExecutors(master, { actions: idle, coordinatorCommit: current, run: supervisor('reregister'), sleep: quick.sleep, timeoutMs: 40 });
    assert.equal(stuck.result, 'refused');
    assert.match(stuck.reason!, /exec-5 since .* is claiming|is claiming an action: exec-5 since/);
    assert.equal(calls.length, 0);
    await writeExecutorRegistration(master, registered(master, 'exec-5', current));

    // Two restarts never run at once: a fence held by a live restart refuses the second; one left by
    // a restart that exited stands for nothing.
    const fence = (pid: number) => writeFile(restartFenceFile(master), JSON.stringify({ id: 'other', pid, host: master.hostId, at: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    await fence(process.pid);
    calls.length = 0;
    const second = await restartExecutors(master, { actions: idle, coordinatorCommit: current, run: supervisor('reregister'), ...quick });
    assert.equal(second.result, 'refused');
    assert.match(second.reason!, new RegExp(`another restart on host-a \\(pid ${process.pid}, since`));
    assert.equal(calls.length, 0);
    assert.equal((await readRestartFence(master))?.id, 'other', 'the refused restart leaves the other one\'s fence standing');
    await fence(deadPid);
    const afterOrphan = await restartExecutors(master, { actions: idle, coordinatorCommit: current, run: supervisor('reregister'), ...quick });
    assert.equal(afterOrphan.result, 'restarted', afterOrphan.reason ?? '');

    // A record naming a unit that is not an executor's own is never restarted through it.
    await writeExecutorRegistration(master, registered(master, 'exec-6', otherCommit, { supervisor: { unit: 'dbus.service', restart: 'systemctl --user restart dbus.service' } }));
    calls.length = 0;
    const foreign = await restartExecutors(master, { actions: idle, coordinatorCommit: current, run: supervisor('reregister'), ...quick });
    assert.equal(foreign.result, 'incomplete');
    assert.ok(!calls.some(call => call.includes('dbus.service')), `dbus.service was restarted: ${JSON.stringify(calls)}`);
    assert.match(foreign.unsupervised.find(entry => entry.name === 'exec-6')!.instruction, /runs under dbus\.service, which is not a graphyard-executor service this command may restart/);
    await removeExecutorRegistration(master, 'exec-6');

    await assert.rejects(executorsCommand(master, ['stop'], { actions: idle, coordinatorCommit: current }), /Use master executors, or master executors restart/);
  } finally { await dispose(); }
});
