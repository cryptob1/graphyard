import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { graphyardTools, type DecidePayload } from '../src/runner/payloads.js';
import { detachedLaunch, piRunner, readRunMeta, runAlive, runContainment, signalRun } from '../src/runner/pi.js';
import { adoptRuns, applyOnce, clearRuns, detachRuns, liveRun, runsDirectory, type Applied } from '../src/runner/registry.js';
import { approverRunOptions, startNarrowRun } from '../src/runner/roles.js';
import { lostRun, lostRunReason, sessionRetry } from '../src/producer.js';
import { emptyDaemonState, runDaemon, type DaemonEffects } from '../src/master-daemon.js';
import type { RunResult } from '../src/runner/types.js';

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
  const root = await mkdtemp(join(tmpdir(), 'graphyard-headless-restart-'));
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
  const start = async (decision: string, name: string) => {
    const { file, release, verdict } = await scenario(decision);
    const started = startNarrowRun({ runner: runner(file), name, role: 'approver', work: 'GY-1', subject: decision, root, context: { decision },
      prompt: `Judge ${decision}`, options: approverRunOptions(root, decision, {}, 60_000), apply });
    // Live once the fake Pi has taken its request up.
    await new Promise<void>(resolve => { const off = started.run.onEvent(event => { if (event.kind === 'tool-start') { off(); resolve(); } }); });
    return { started, release, verdict, meta: readRunMeta(started.run.directory!)! };
  };
  // The restarted loop's approver adoption: the options the run is judged by, and the same apply.
  const adopters = { approver: async (owner: { context: Record<string, unknown> }) => ({ options: approverRunOptions('', String(owner.context.decision), {}, 60_000), apply }) };
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

    // A producer session whose run was lost is retried after the base wait and spends no attempt.
    const now = Date.parse('2030-01-01T00:10:00.000Z');
    const records = [
      { requestId: 'r1', state: 'failed', requestedAt: '2030-01-01T00:00:00.000Z', closedAt: '2030-01-01T00:05:00.000Z', resolution: 'the headless run ended (exit: pi exited with code 3) without trusted evidence' },
      { requestId: 'r1', state: 'failed', requestedAt: '2030-01-01T00:06:00.000Z', closedAt: '2030-01-01T00:08:00.000Z', resolution: `${lostRunReason}: the run's process is gone; retried without spending an attempt` },
    ];
    assert.ok(lostRun(records[1]) && !lostRun(records[0]));
    const retry = sessionRetry(records, 'r1', now);
    assert.equal(retry.started, 1, 'only the run that ran counts against the budget');
    assert.equal(retry.nextAt, '2030-01-01T00:09:00.000Z', 'retried after the base wait, not a widened one');
    assert.equal(retry.launch, true);
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
    const result = await runDaemon(config, emptyDaemonState(config), effects, { once: true, intervalMs: 5, identity: { pid: process.pid, host: 'machine-a' }, signals: ['SIGUSR2'], log: line => lines.push(line) });
    assert.equal(result.cycles.length + result.failed.length, 1);
    assert.ok(lines.some(line => /stopping: left 1 headless run\(s\) running, detached/.test(line)), lines.join('\n'));
    await delay(200);
    assert.ok(runAlive(meta), 'shutdown left the detached run untouched');
    assert.equal(existsSync(join((await readdir(runsDirectory(root))).map(name => join(runsDirectory(root), name))[0], 'stopped.json')), false, 'no stop was recorded for it');

    // The next loop adopts it on start, and its verdict is applied once when it ends.
    const next: string[] = [];
    const adoptEffects = { ...effects, adoptRuns: () => adoptRuns(root, adopters) } as unknown as DaemonEffects;
    const restarted = runDaemon(config, emptyDaemonState(config), adoptEffects, { once: true, intervalMs: 5, identity: { pid: process.pid, host: 'machine-a' }, signals: ['SIGUSR2'], log: line => next.push(line) });
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
  assert.equal(runContainment({ cgroup: '0::/system.slice/graphyard-executor@a.service', systemd: () => false }), 'setsid', 'no user manager: its own session only');
  const scoped = detachedLaunch('/runs/r1', 'r1', 'pi', ['--mode', 'json'], 'systemd');
  assert.equal(scoped.file, 'systemd-run');
  assert.deepEqual(scoped.args.slice(0, 5), ['--user', '--scope', '--quiet', '--collect', '--unit=graphyard-run-r1.scope']);
  assert.equal(scoped.unit, 'graphyard-run-r1.scope');
  const plain = detachedLaunch('/runs/r1', 'r1', 'pi', ['--mode', 'json'], 'setsid');
  assert.equal(plain.file, '/bin/sh');
  assert.match(plain.args[1], /trap : TERM INT HUP/);
  assert.match(plain.args[1], /'\/runs\/r1\/exit'/, 'the shell records Pi\'s exit in the run directory');
});
