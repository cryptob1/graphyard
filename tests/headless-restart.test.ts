import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { graphyardTools, type DecidePayload } from '../src/runner/payloads.js';
import { cancelScratchRuns, cgroupService, detachedLaunch, piRunner, processIdentity, readRunMeta, runAlive, runContainment, scratchBoundMarginSeconds, scratchRunsDirectory, signalRun, sweepScratchRuns } from '../src/runner/pi.js';
import { adoptRuns, applyOnce, clearRuns, detachRuns, liveRun, liveRunCheckouts, runsDirectory, unendedRunOnDisk, type Applied } from '../src/runner/registry.js';
import { approverRunAdopter, approverRunContext, approverRunOptions, runConfinement, startNarrowRun } from '../src/runner/roles.js';
import { sessionMountNamespaceWorks } from '../src/master/profiles.js';
import { lostRun, lostRunReason, sessionRetry } from '../src/producer.js';
import { approvalStep, approvalWatchSchema, emptyDaemonState, maxApproverLaunches, runDaemon, type DaemonEffects } from '../src/master-daemon.js';
import { maxLostApproverRuns } from '../src/daemon/decisions.js';
import { EventEmitter } from 'node:events';
import type { RunResult } from '../src/runner/types.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/** The coordinator checkout the loop reads at its start (GY-857), clean: this test is not about it. */
const cleanCheckout = () => ({ root: '/', commit: null, modified: [], untracked: [] });

// GY-453. Headless Pi runs are detached from the process that launched them: a restart of the loop
// or an executor leaves them running, and the restarted process adopts them from the run registry
// on disk and applies each result exactly once. Driven against a fake Pi (a node script printing Pi
// JSONL) that holds its verdict until the test releases it, so the run is live across the restart.

const fakePi = `import { existsSync, readFileSync } from 'node:fs';
const [scenarioFile] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(scenarioFile, 'utf8'));
const out = record => process.stdout.write(JSON.stringify(record) + '\\n');
out({ type: 'session', version: 3, id: 'session-1' });
out({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'graphyard_decide', args: {} });
while (!existsSync(scenario.release)) await new Promise(resolve => setTimeout(resolve, 50));
out({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'graphyard_decide', result: { content: [{ type: 'text', text: 'recorded' }], details: scenario.verdict }, isError: false });
out({ type: 'agent_settled' });
process.exit(0);
`;

async function fixture() {
  const root = await temporaryDirectory('headless-restart');
  const script = join(root, 'fake-pi.mjs');
  await writeFile(script, fakePi);
  let count = 0;
  const scenario = async (decision: string) => {
    const file = join(root, `scenario-${++count}.json`), release = join(root, `release-${count}`);
    const verdict: DecidePayload = { decision, approve: true, reason: 'the criteria are met' };
    await writeFile(file, JSON.stringify({ release, verdict }));
    return { file, release: () => writeFile(release, ''), verdict };
  };
  const runner = (file: string) => piRunner({ command: process.execPath, commandArgs: [script, file], containment: 'setsid', pollMs: 50, exitGraceMs: 500 });
  const applied: { decision: string; ok: boolean; reason: string | null }[] = [];
  const apply = async (result: RunResult<DecidePayload>): Promise<Applied[]> => {
    applied.push({ decision: result.ok ? result.payload.decision : '', ok: result.ok, reason: result.ok ? null : result.failure.reason });
    return result.ok ? [{ subject: `decision ${result.payload.decision}`, outcome: 'applied', detail: 'approved' }] : [];
  };
  const start = async (decision: string, name: string, role: 'approver' | 'producer' = 'approver', checkout?: string) => {
    const { file, release, verdict } = await scenario(decision);
    const started = startNarrowRun({ runner: runner(file), name, role, work: 'GY-1', subject: decision, root,
      context: checkout ? approverRunContext('http://127.0.0.1:1', 'work-1', decision, 60_000, checkout) : { decision }, ...(checkout ? { checkout } : {}),
      prompt: `Judge ${decision}`, options: approverRunOptions(root, decision, {}, 60_000), apply });
    // Live once the fake Pi has taken its request up.
    await new Promise<void>(resolve => { const off = started.run.onEvent(event => { if (event.kind === 'tool-start') { off(); resolve(); } }); });
    return { started, release, verdict, meta: readRunMeta(started.run.directory!)! };
  };
  // The restarted loop's approver adoption: the options the run is judged by, and the same apply.
  const adopter = async (owner: { context: Record<string, unknown> }) => ({ options: approverRunOptions('', String(owner.context.decision), {}, 60_000), apply });
  const adopters = { approver: adopter, producer: adopter };
  return { root, start, applied, adopters, cleanup: async () => { clearRuns(); await rm(root, { recursive: true, force: true }); } };
}

test('unit:headless-run-survives-restart a detached run survives a restart of its launcher, is adopted from the registry on disk, and has its result applied exactly once', async () => {
  const { root, start, applied, adopters, cleanup } = await fixture();
  try {
    const { started, release, verdict, meta } = await start('decision-1', 'graphyard-approver-gy-1');
    assert.ok(meta.pid && runAlive(meta), 'the run is live');
    assert.equal(meta.containment, 'setsid');
    const owner = JSON.parse(await (await import('node:fs/promises')).readFile(join(started.run.directory!, 'owner.json'), 'utf8'));
    assert.deepEqual([owner.name, owner.role, owner.work, owner.subject], ['graphyard-approver-gy-1', 'approver', 'GY-1', 'decision-1'], 'the registry on disk names the run\'s owner');

    // The launching loop restarts: it stops watching and forgets every run, and signals none of them.
    assert.equal(detachRuns(), 1);
    assert.equal(liveRun('graphyard-approver-gy-1'), null, 'the restarted process starts with an empty registry');
    await delay(200);
    assert.ok(runAlive(meta), 'the run survived its launcher\'s restart');
    // Its launcher being gone says nothing about it (the GY-496 launcher-pid rule): the unended run on disk is adoption's to judge.
    assert.ok(unendedRunOnDisk(root, 'decision-1'), 'the detached run stands unended in the registry on disk');

    // The restarted loop adopts it: it is registered again under its session name and watched until it ends.
    const adopted = await adoptRuns(root, adopters);
    assert.deepEqual(adopted.map(run => [run.name, run.role, run.live]), [['graphyard-approver-gy-1', 'approver', true]]);
    assert.ok(liveRun('graphyard-approver-gy-1'), 'the adopted run reads as a live session again');
    assert.deepEqual(await adoptRuns(root, adopters), [], 'a run already watched is not adopted twice');

    await release();
    const record = await adopted[0].settled;
    assert.deepEqual(record.result, { ok: true, tool: graphyardTools.decide, submitted: 1 });
    assert.deepEqual(applied, [{ decision: verdict.decision, ok: true, reason: null }], 'the verdict was applied exactly once');
    assert.equal(liveRun('graphyard-approver-gy-1'), null);
    assert.equal(unendedRunOnDisk(root, 'decision-1'), false, 'once applied its record is on disk');

    // Nothing applies it again: not a further restart's adoption, not a stale watcher's late apply.
    detachRuns();
    assert.deepEqual(await adoptRuns(root, adopters), [], 'an applied run is never adopted again');
    assert.equal(await applyOnce(started.run.directory, async () => { throw new Error('applied twice'); }), null);
    assert.equal(applied.length, 1);
  } finally { await cleanup(); }
});

test('unit:headless-run-survives-restart a run that ended while unwatched is applied on adoption, and one whose process is gone without a result is lost and retried free', async () => {
  const { root, start, applied, adopters, cleanup } = await fixture();
  try {
    // Ended between the restart and the adoption: its exit is on disk, and its result is applied once.
    const finished = await start('decision-2', 'graphyard-approver-gy-2');
    detachRuns();
    await finished.release();
    for (let waited = 0; runAlive(finished.meta) && waited < 5_000; waited += 50) await delay(50);
    const [late] = await adoptRuns(root, adopters);
    assert.equal(late.live, false);
    assert.deepEqual((await late.settled).result, { ok: true, tool: graphyardTools.decide, submitted: 1 });
    assert.deepEqual(applied, [{ decision: 'decision-2', ok: true, reason: null }]);

    // Killed from outside while unwatched, shell and all: no exit is recorded, so the run is lost.
    const killed = await start('decision-3', 'graphyard-approver-gy-3');
    detachRuns();
    signalRun(killed.meta, 'SIGKILL');
    for (let waited = 0; runAlive(killed.meta) && waited < 5_000; waited += 50) await delay(50);
    const [lost] = await adoptRuns(root, adopters);
    const record = await lost.settled;
    assert.equal(record.result?.ok === false && record.result.reason, 'lost');
    assert.deepEqual(applied.at(-1), { decision: '', ok: false, reason: 'lost' }, 'a lost run applies no verdict');

    // A producer session whose run was lost is retried at once (GY-496) and spends no attempt.
    const now = Date.parse('2030-01-01T00:10:00.000Z');
    const records = [
      { requestId: 'r1', state: 'failed', requestedAt: '2030-01-01T00:00:00.000Z', closedAt: '2030-01-01T00:05:00.000Z', resolution: 'the headless run ended (exit: pi exited with code 3) without trusted evidence' },
      { requestId: 'r1', state: 'failed', requestedAt: '2030-01-01T00:06:00.000Z', closedAt: '2030-01-01T00:08:00.000Z', resolution: `${lostRunReason}: the run's process is gone; retried without spending an attempt` },
    ];
    assert.ok(lostRun(records[1]) && !lostRun(records[0]));
    const retry = sessionRetry(records, 'r1', now);
    assert.equal(retry.started, 1, 'only the run that ran counts against the budget');
    assert.equal(retry.nextAt, '2030-01-01T00:08:00.000Z', 'retried at once, with no widening wait');
    assert.equal(retry.launch, true);
  } finally { await cleanup(); }
});

test('unit:headless-run-survives-restart an adopted approver run keeps its managed checkout from a reclaim pass while it lives, and settles it once it ends', async () => {
  const { root, start, cleanup } = await fixture();
  try {
    const checkout = join(root, 'approval-checkout');
    const { meta } = await start('decision-9', 'graphyard-approver-gy-9', 'approver', checkout);
    assert.deepEqual(liveRunCheckouts(), [checkout], 'the launching loop holds the run\'s checkout');
    detachRuns();
    assert.deepEqual(liveRunCheckouts(), [], 'the restarted loop starts holding nothing');

    const settledCheckouts: string[] = [];
    const [adopted] = await adoptRuns(root, { approver: approverRunAdopter(async () => 'token', undefined, async directory => { settledCheckouts.push(directory); }) });
    assert.equal(adopted.live, true);
    assert.deepEqual(liveRunCheckouts(), [checkout], 'the adopted run holds its checkout again, so a reclaim pass leaves it');

    // Lost from outside: no verdict is applied (so no approve route is called), and the checkout is settled once.
    signalRun(meta, 'SIGKILL');
    const record = await adopted.settled;
    assert.equal(record.result?.ok === false && record.result.reason, 'lost');
    assert.deepEqual(settledCheckouts, [checkout]);
    assert.deepEqual(liveRunCheckouts(), []);
  } finally { await cleanup(); }
});

test('unit:headless-run-survives-restart a run an executor launched is re-adopted by the loop on its next cycle once that executor restarts, and applied once', async () => {
  const { root, start, applied, adopters, cleanup } = await fixture();
  try {
    // An executor on this host launched a headless producer run and is watching it (here: a live
    // process that is not this one holds the run's watch claim).
    const { started, release, meta } = await start('decision-5', 'graphyard-producer-gy-5', 'producer');
    detachRuns();
    const claim = join(started.run.directory!, 'watch.claim');
    await writeFile(claim, `${process.ppid}:${processIdentity(process.ppid) ?? ''}:watch`);

    // The loop runs its cycles beside it; each one looks for runs no live process watches.
    const host = new EventEmitter(), lines: string[] = [];
    let calls = 0, restarted: () => Promise<void> = async () => {};
    const executorRestarted = new Promise<void>(resolve => { restarted = async () => { resolve(); }; });
    const config = { url: 'https://graphyard.example', repository: 'owner/project', run: { intervalSeconds: 30 } } as never;
    const effects = { persist: async () => {}, snapshot: async () => { throw new Error('the control plane is offline'); },
      adoptRuns: async () => {
        const adopted = await adoptRuns(root, adopters);
        calls++;
        if (calls === 2) {
          assert.deepEqual(adopted, [], 'a run a live executor watches is left to it');
          // `master executors restart`: the executor's process ends; the run, detached, does not.
          await writeFile(claim, `${process.ppid}:1:watch`);
          await restarted();
        }
        if (adopted.length) { host.emit('SIGUSR2'); }
        return adopted;
      } } as unknown as DaemonEffects;
    const loop = runDaemon(config, emptyDaemonState(config), effects, { intervalMs: 5, identity: { pid: process.pid, host: 'machine-a' }, signals: ['SIGUSR2'], checkout: cleanCheckout, process: host as never, log: line => lines.push(line) });
    await executorRestarted;
    await loop;
    assert.ok(runAlive(meta), 'the executor\'s restart left the run running');
    assert.ok(calls >= 3, 'the loop adopts on its start and again on later cycles');
    assert.ok(lines.some(line => /adopted 1 headless run\(s\) no live process was watching: graphyard-producer-gy-5 \(producer for GY-1\)/.test(line)), lines.join('\n'));

    // The loop that adopted it stopped too (and signalled nothing); the next one picks it up again and applies it once.
    const [adopted] = await adoptRuns(root, adopters);
    assert.equal(adopted?.name, 'graphyard-producer-gy-5');
    await release();
    await adopted.settled;
    assert.deepEqual(applied, [{ decision: 'decision-5', ok: true, reason: null }], 'the result was applied exactly once');
    detachRuns();
    assert.deepEqual(await adoptRuns(root, adopters), [], 'an applied run is never adopted again');
  } finally { await cleanup(); }
});

test('unit:headless-run-survives-restart a run another live process watches is left to it, and a dead watcher\'s run is taken over', async () => {
  const { root, start, applied, adopters, cleanup } = await fixture();
  try {
    const { started, release } = await start('decision-6', 'graphyard-producer-gy-6', 'producer');
    detachRuns();
    const claim = join(started.run.directory!, 'watch.claim');
    // Another live process (here, this test's parent) holds the watch: nobody else adopts the run.
    await writeFile(claim, `${process.ppid}:${processIdentity(process.ppid) ?? ''}:watch`);
    assert.deepEqual(await adoptRuns(root, adopters), [], 'a run a live loop or executor watches is not adopted beside it');
    // The same pid under a different start time is a later process: its claim is stale.
    await writeFile(claim, `${process.ppid}:1:watch`);
    const [adopted] = await adoptRuns(root, adopters);
    assert.equal(adopted?.name, 'graphyard-producer-gy-6', 'a claim whose process is gone is taken over');
    await release();
    await adopted.settled;
    assert.deepEqual(applied, [{ decision: 'decision-6', ok: true, reason: null }]);
  } finally { await cleanup(); }
});

test('unit:restart-leaves-runs the loop\'s shutdown signals no headless run, logs how many it left running, and the next loop adopts them', async () => {
  const { root, start, applied, adopters, cleanup } = await fixture();
  try {
    const { release, meta } = await start('decision-4', 'graphyard-approver-gy-4');
    const lines: string[] = [];
    const config = { url: 'https://graphyard.example', repository: 'owner/project', run: { intervalSeconds: 30 } } as never;
    const persisted: unknown[] = [];
    const effects = { persist: async (state: unknown) => { persisted.push(state); }, snapshot: async () => { throw new Error('the control plane is offline'); } } as unknown as DaemonEffects;
    // A planned restart: the loop is stopped by its signal, and its shutdown hook runs.
    const result = await runDaemon(config, emptyDaemonState(config), effects, { once: true, intervalMs: 5, identity: { pid: process.pid, host: 'machine-a' }, signals: ['SIGUSR2'], checkout: cleanCheckout, log: line => lines.push(line) });
    assert.equal(result.cycles.length + result.failed.length, 1);
    assert.ok(lines.some(line => /stopping: left 1 headless run\(s\) running, detached/.test(line)), lines.join('\n'));
    await delay(200);
    assert.ok(runAlive(meta), 'shutdown left the detached run untouched');
    assert.equal(existsSync(join((await readdir(runsDirectory(root))).map(name => join(runsDirectory(root), name))[0], 'stopped.json')), false, 'no stop was recorded for it');

    // The next loop adopts it on start, and its verdict is applied once when it ends.
    const next: string[] = [];
    const adoptEffects = { ...effects, adoptRuns: () => adoptRuns(root, adopters) } as unknown as DaemonEffects;
    const restarted = runDaemon(config, emptyDaemonState(config), adoptEffects, { once: true, intervalMs: 5, identity: { pid: process.pid, host: 'machine-a' }, signals: ['SIGUSR2'], checkout: cleanCheckout, log: line => next.push(line) });
    await restarted;
    assert.ok(next.some(line => /adopted 1 headless run\(s\) left running by a restart: graphyard-approver-gy-4 \(approver for GY-1\)/.test(line)), next.join('\n'));
    // Its shutdown left the adopted run running too; a third watcher applies it.
    assert.ok(runAlive(meta));
    const [third] = await adoptRuns(root, adopters);
    await release();
    await third.settled;
    assert.deepEqual(applied, [{ decision: 'decision-4', ok: true, reason: null }]);
  } finally { await cleanup(); }
});

test('unit:restart-leaves-runs a run launched from a systemd service gets its own transient scope, so a service restart never reaches it', () => {
  assert.equal(runContainment({ cgroup: '0::/user.slice/user-1000.slice/user@1000.service/app.slice/graphyard-master.service', systemd: () => true }), 'systemd');
  assert.equal(runContainment({ cgroup: '0::/user.slice/user-1000.slice/user@1000.service/app.slice/graphyard-watch-1-x.scope', systemd: () => true }), 'setsid');
  const logged: string[] = [];
  assert.equal(runContainment({ cgroup: '0::/system.slice/graphyard-executor@a.service', systemd: () => false, log: line => logged.push(line) }), 'setsid', 'no user manager: its own session only');
  assert.equal(logged.length, 1, 'the setsid fallback inside a service is logged');
  assert.match(logged[0], /graphyard-executor@a\.service get no transient scope .* still ends them/);
  // The user manager's own unit is no service a stop could take: a process directly under it needs no scope.
  assert.equal(cgroupService('0::/user.slice/user-1000.slice/user@1000.service'), null);
  assert.equal(cgroupService('0::/user.slice/user-1000.slice/user@1000.service/'), null);
  assert.equal(runContainment({ cgroup: '0::/user.slice/user-1000.slice/user@1000.service', systemd: () => { throw new Error('never asked'); } }), 'setsid');
  const scoped = detachedLaunch('/runs/r1', 'r1', 'pi', ['--mode', 'json'], 'systemd');
  assert.equal(scoped.file, 'systemd-run');
  assert.deepEqual(scoped.args.slice(0, 5), ['--user', '--scope', '--quiet', '--collect', '--unit=graphyard-run-r1.scope']);
  assert.equal(scoped.unit, 'graphyard-run-r1.scope');
  const plain = detachedLaunch('/runs/r1', 'r1', 'pi', ['--mode', 'json'], 'setsid');
  assert.equal(plain.file, '/bin/sh');
  assert.match(plain.args[1], /trap : TERM INT HUP/);
  assert.match(plain.args[1], /'\/runs\/r1\/exit'/, 'the shell records Pi\'s exit in the run directory');
});

const capturingSpawn = (spawned: { command: string; args: readonly string[]; detached?: boolean }[]) => ((command: string, args: readonly string[], options: { detached?: boolean }) => {
  spawned.push({ command, args, detached: options?.detached });
  return Object.assign(new EventEmitter(), { pid: undefined, unref() {} });
}) as unknown as typeof import('node:child_process').spawn;

test('unit:restart-leaves-runs a confined run keeps its scope and its shell outside the confinement, which binds the run directory read-only and masks the user bus', async () => {
  // Every production headless run is confined (GY-888). The confinement masks the user bus and
  // systemd runtime directory, so a systemd-run inside it could never start a scope; and it binds
  // the coordinator checkout read-only, so a shell inside it could not write the run's output and
  // exit to `.graphyard/runs/`. Only Pi is confined, inside the run's shell.
  const base = await temporaryDirectory('headless-scope');
  try {
    const root = join(base, 'coordinator'), cwd = join(root, '.graphyard', 'worktrees', 'GY-1-1'), runs = runsDirectory(root);
    await mkdir(cwd, { recursive: true });
    const spawned: { command: string; args: readonly string[] }[] = [];
    const runner = piRunner({ command: 'pi', containment: 'systemd', spawn: capturingSpawn(spawned), confine: runConfinement({ coordinatorRoot: root, bwrap: 'bwrap' }), pollMs: 20 });
    const run = runner.start('Judge it', { tool: 'graphyard_decide', validate: value => value, timeoutMs: 60_000, cwd, runs });
    run.cancel('the test only inspects the launch');
    await run.result();
    assert.equal(spawned.length, 1);
    const [{ command, args }] = spawned;
    assert.equal(command, 'systemd-run', 'the transient scope is the outermost command, reachable to the user manager');
    const separator = args.indexOf('--');
    assert.deepEqual(args.slice(0, separator), ['--user', '--scope', '--quiet', '--collect', `--unit=graphyard-run-${run.id}.scope`]);
    assert.deepEqual(args.slice(separator + 1, separator + 3), ['/bin/sh', '-c'], 'the run\'s shell follows the scope, outside the confinement');
    const script = args[separator + 3];
    assert.match(script, /'bwrap' '--unshare-pid' .*'--ro-bind' '[^']*coordinator' .*'--' "\$0" "\$@"/, 'the confinement wraps Pi alone, the coordinator read-only');
    assert.ok(script.includes(`'${cwd}'`), 'the run\'s own checkout is re-exposed');
    assert.match(script, /"\$@" <\/dev\/null >'[^']*\.graphyard\/runs\/[^']*\/stdout\.jsonl'/, 'the shell, outside the confinement, writes the output under the coordinator checkout');
    // A run without its own scope is its shell, with the same confinement inside it.
    spawned.length = 0;
    const plain = piRunner({ command: 'pi', containment: 'setsid', spawn: capturingSpawn(spawned), confine: runConfinement({ coordinatorRoot: root, bwrap: 'bwrap' }), pollMs: 20 })
      .start('Judge it', { tool: 'graphyard_decide', validate: value => value, timeoutMs: 60_000, cwd, runs });
    plain.cancel('the test only inspects the launch');
    await plain.result();
    assert.equal(spawned[0].command, '/bin/sh');
    assert.match(spawned[0].args[1], /'bwrap' .*"\$0" "\$@"/);
    // A run that cannot be confined fails instead of starting unconfined.
    spawned.length = 0;
    const refused = await piRunner({ command: 'pi', containment: 'setsid', spawn: capturingSpawn(spawned), confine: runConfinement({ coordinatorRoot: root, bwrap: null }), pollMs: 20 })
      .start('Judge it', { tool: 'graphyard_decide', validate: value => value, timeoutMs: 60_000, cwd, runs }).result();
    assert.equal(refused.ok === false && refused.failure.reason, 'spawn');
    assert.equal(spawned.length, 0, 'nothing was started');
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('unit:headless-run-survives-restart a confined run whose directory lies under the coordinator checkout writes its output and exit, and its result is applied', { skip: process.platform !== 'linux' }, async t => {
  if (!(await sessionMountNamespaceWorks('bwrap'))) return t.skip('bubblewrap cannot build a mount namespace on this host');
  const { root, cleanup } = await fixture();
  try {
    // The loop's real layout: the coordinator checkout, a managed worktree and the run registry inside it.
    const cwd = join(root, '.graphyard', 'worktrees', 'GY-1-1'), release = join(root, 'release');
    await mkdir(cwd, { recursive: true });
    const verdict: DecidePayload = { decision: 'decision-c', approve: true, reason: 'the criteria are met' };
    await writeFile(join(root, 'scenario-c.json'), JSON.stringify({ release, verdict }));
    const runner = piRunner({ command: process.execPath, commandArgs: [join(root, 'fake-pi.mjs'), join(root, 'scenario-c.json')], containment: 'setsid', pollMs: 50, exitGraceMs: 500,
      confine: runConfinement({ coordinatorRoot: root, bwrap: 'bwrap' }) });
    const run = runner.start<DecidePayload>('Judge it', { tool: graphyardTools.decide, validate: value => value as DecidePayload, timeoutMs: 60_000, cwd, runs: runsDirectory(root) });
    await writeFile(release, '');
    const result = await run.result();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.ok && result.payload, verdict);
    assert.ok(run.directory!.startsWith(runsDirectory(root)));
    assert.equal((await readFile(join(run.directory!, 'exit'), 'utf8')).trim(), '0', 'the shell recorded Pi\'s exit beside its output');
  } finally { await cleanup(); }
});

test('unit:restart-leaves-runs a run outside the run registry gets no scope of its own and ends with the process that started it', async () => {
  // Triage and diagnosis runs start without a run registry directory: no owner on disk says what
  // their result is for, so nothing could adopt them after a restart.
  const spawned: { command: string; args: readonly string[]; detached?: boolean }[] = [];
  const scoped = piRunner({ command: 'pi', containment: 'systemd', spawn: capturingSpawn(spawned), pollMs: 20 }).start('Triage it', { tool: 'graphyard_decide', validate: value => value, timeoutMs: 60_000, cwd: '/' });
  scoped.cancel('the test only inspects the launch');
  await scoped.result();
  assert.equal(spawned[0].command, '/bin/sh', 'no transient scope: a service stop still ends it with the service');

  const { root, cleanup } = await fixture();
  try {
    const release = join(root, 'release-scratch');
    await writeFile(join(root, 'scenario-s.json'), JSON.stringify({ release, verdict: { decision: 'd', approve: true, reason: 'r' } }));
    const run = piRunner({ command: process.execPath, commandArgs: [join(root, 'fake-pi.mjs'), join(root, 'scenario-s.json')], containment: 'setsid', pollMs: 50 })
      .start('Triage it', { tool: graphyardTools.decide, validate: value => value, timeoutMs: 60_000, cwd: root });
    await new Promise<void>(resolve => { const off = run.onEvent(event => { if (event.kind === 'tool-start') { off(); resolve(); } }); });
    const pid = (run.events.find(event => event.kind === 'start') as { pid: number | null }).pid!;
    assert.ok(runAlive({ pid, identity: null }), 'the triage run is live');
    // The loop stops: its registry runs are left to the next loop, this one is cancelled with it.
    detachRuns();
    const result = await run.result();
    assert.equal(result.ok === false && result.failure.reason, 'cancelled');
    for (let waited = 0; runAlive({ pid, identity: null }) && waited < 5_000; waited += 50) await delay(50);
    assert.equal(runAlive({ pid, identity: null }), false, 'no unwatched, unbounded run outlives the process that started it');
    assert.equal(cancelScratchRuns(), 0, 'nothing is left to cancel');
  } finally { await cleanup(); }
});

test('unit:headless-run-survives-restart a lost approver run is relaunched without spending a launch only a bounded number of times, then counts, so the decision still escalates', () => {
  const at = new Date(Date.now() - 60_000).toISOString();
  const lost = { runtime: 'pi', startedAt: at, endedAt: at, events: [], applied: [], result: { ok: false as const, reason: 'lost' as const, detail: 'the run\'s process is gone and recorded no exit' } };
  const watch = (lostRuns: number) => approvalWatchSchema.parse({ work: 'GY-1', action: 'rework', decision: 'decision-1', agentName: 'graphyard-approver-gy-1', requestedAt: at, launchedAt: at, launches: maxApproverLaunches, lostRuns, run: lost });
  const gone = { agents: [], available: true };
  assert.equal(approvalStep(watch(0), { state: 'requested' }, gone, Date.now()).step, 'relaunch', 'a lost run on the last launch is given that launch back');
  assert.equal(approvalStep(watch(maxLostApproverRuns - 1), { state: 'requested' }, gone, Date.now()).step, 'relaunch');
  assert.equal(approvalStep(watch(maxLostApproverRuns), { state: 'requested' }, gone, Date.now()).step, 'exhausted', 'past the bound a lost run spends its launch, and the decision escalates');
  assert.equal(approvalStep({ ...watch(0), run: null }, { state: 'requested' }, gone, Date.now()).step, 'exhausted', 'a session that is merely gone always spent its launch');
});

test('unit:restart-leaves-runs a scratch run writes under the loop\'s checkout, bounds itself, and one a killed loop left is ended and removed by the next scratch run', async () => {
  const root = await temporaryDirectory('headless-scratch');
  const children: import('node:child_process').ChildProcess[] = [];
  try {
    // Its output lies under the checkout it reads, which an over-quota /tmp does not reach.
    const spawned: { command: string; args: readonly string[]; detached?: boolean }[] = [];
    const run = piRunner({ command: 'pi', spawn: capturingSpawn(spawned), pollMs: 20, exitGraceMs: 1_000 }).start('Triage it', { tool: 'graphyard_decide', validate: value => value, timeoutMs: 60_000, cwd: root });
    assert.match(spawned[0].args[1], new RegExp(`>'${join(root, '.graphyard', 'scratch-runs')}/[^']+/stdout\\.jsonl'`));
    // Its bound holds without a watcher: coreutils' timeout past the watcher's own bound.
    assert.ok(spawned[0].args[1].includes(`sleep ${61 + scratchBoundMarginSeconds}; kill -TERM -$$; sleep 5; kill -KILL -$$ ) & watchdog=$!; `), spawned[0].args[1]);
    assert.match(spawned[0].args[1], /kill -KILL "\$watchdog" 2>\/dev\/null; printf/, 'the watchdog ends once Pi has exited');
    run.cancel('the test only inspects the launch');
    await run.result();
    // A checkout it cannot write to falls back to the temp directory.
    assert.equal(scratchRunsDirectory('/proc'), join(tmpdir(), 'graphyard-runs'));
    // A registry run carries no bound of its own: its adopter enforces it after a restart.
    assert.doesNotMatch(detachedLaunch('/runs/r1', 'r1', 'pi', [], 'setsid').args[1], /watchdog/);
    // The bound holds with no watcher at all: the watchdog stops the run's group and its shell records the exit.
    const bounded = join(root, 'bounded');
    await mkdir(bounded);
    const launch = detachedLaunch(bounded, 'b1', process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 'setsid', [], 1);
    const shell = spawn(launch.file, launch.args, { detached: true, stdio: 'ignore' });
    children.push(shell);
    for (let waited = 0; !existsSync(join(bounded, 'exit')) && waited < 10_000; waited += 100) await delay(100);
    assert.equal((await readFile(join(bounded, 'exit'), 'utf8')).trim(), '143', 'Pi was stopped by TERM at the bound');

    // A loop killed outright (SIGKILL) left a run: its launcher is gone, the run is not.
    const scratchRoot = scratchRunsDirectory(root);
    const dead = spawn(process.execPath, ['-e', '']);
    await new Promise(resolve => dead.on('exit', resolve));
    const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    children.push(orphan);
    const orphaned = join(scratchRoot, 'orphan');
    await mkdir(orphaned, { recursive: true });
    const meta = { version: 1, id: 'orphan', command: 'pi', pid: orphan.pid, identity: processIdentity(orphan.pid!), containment: 'setsid', unit: null, startedAt: new Date().toISOString(), timeoutMs: 60_000, exitGraceMs: 1_000, launcher: { pid: dead.pid, identity: 'gone' } };
    await writeFile(join(orphaned, 'run.json'), JSON.stringify(meta));
    // One whose launcher still lives is that process's to end.
    const owned = join(scratchRoot, 'owned');
    await mkdir(owned, { recursive: true });
    await writeFile(join(owned, 'run.json'), JSON.stringify({ ...meta, id: 'owned', pid: null, identity: null, launcher: { pid: process.pid, identity: processIdentity(process.pid) } }));
    assert.equal(sweepScratchRuns(scratchRoot), 1);
    for (let waited = 0; runAlive(meta as never) && waited < 5_000; waited += 50) await delay(50);
    assert.equal(runAlive(meta as never), false, 'the orphaned run was ended');
    assert.equal(existsSync(orphaned), false, 'and its directory removed');
    assert.equal(existsSync(owned), true);
    // The next scratch run sweeps before it starts.
    await mkdir(join(scratchRoot, 'orphan-3'), { recursive: true });
    await writeFile(join(scratchRoot, 'orphan-3', 'run.json'), JSON.stringify({ ...meta, id: 'orphan-3', pid: null, identity: null }));
    const next = piRunner({ command: 'pi', spawn: capturingSpawn(spawned), pollMs: 20 }).start('Triage it', { tool: 'graphyard_decide', validate: value => value, timeoutMs: 60_000, cwd: root });
    assert.equal(existsSync(join(scratchRoot, 'orphan-3')), false);
    next.cancel('done'); await next.result();
  } finally {
    for (const child of children) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    await rm(root, { recursive: true, force: true });
  }
});
