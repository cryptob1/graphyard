import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { cycleFailureAttentionAfter, cycleFailureCeiling, cycleFailureCeilingMs, cycleFailureDelay, daemonStateSchema, daemonSummary, emptyDaemonState, loopAttention, loopLiveness, runDaemon, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Each test is named for the proof it produces (GY-119): unit:cycle-failure-survived,
// unit:cycle-failure-backoff and unit:detached-rejection-survived.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const iso = (offsetMs: number) => new Date(Date.parse('2030-01-01T00:00:00Z') + offsetMs).toISOString();

async function privateDirectory() {
  const directory = await temporaryDirectory('cycle-failure');
  const token = join(directory, 'coordinator.token');
  await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  return { directory, token };
}
function config(credentialFile: string): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
}
function effects(overrides: Partial<DaemonEffects> = {}): DaemonEffects {
  return {
    agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: [], now: iso(0) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    persist: async () => {},
    ...overrides,
  };
}
/** What `fetch` throws when `AbortSignal.timeout` fires: the failure that ended the process on 2026-09-21. */
const timedOut = () => new DOMException('The operation was aborted due to timeout', 'AbortError');
/** Every state the loop persisted, copied at the time, so the cursor's history can be read back. */
const persisted = (): { states: DaemonState[]; persist: DaemonEffects['persist'] } => {
  const states: DaemonState[] = [];
  return { states, persist: async state => { states.push(structuredClone(state)); } };
};
const stop = () => { process.emit('SIGUSR2' as NodeJS.Signals); };
const options = (extra: Partial<Parameters<typeof runDaemon>[3]> = {}) => ({ intervalMs: 5, identity: { pid: process.pid, host: 'machine-a' }, signals: ['SIGUSR2' as NodeJS.Signals], log: () => {}, ...extra });

test('unit:cycle-failure-survived — a rejection escaping the cycle or the reload fails that cycle, is recorded with its number and call, and the loop runs the next cycle in the same process', async () => {
  const { directory, token } = await privateDirectory();
  try {
    const master = config(token);
    // A cursor written before the loop counted its own failures still parses, with none.
    assert.deepEqual(daemonStateSchema.parse({ version: 1, url: master.url, repository: master.repository }).failures, { consecutive: 0, total: 0, last: null, unhandled: 0, lastUnhandled: null });

    // The snapshot read times out on the first cycle, exactly as the control-plane fetch did.
    const state = emptyDaemonState(master), log: string[] = [], { states, persist } = persisted();
    let reads = 0;
    const deps = effects({ persist, snapshot: async () => { reads += 1; if (reads === 1) throw timedOut(); if (reads >= 3) stop(); return { work: [], now: iso(0) }; } });
    const result = await runDaemon(master, state, deps, options({ log: line => log.push(line) }));
    assert.ok(result.stopped, 'the loop ran until its stop signal, not until the failure');
    assert.ok(reads >= 3, `the cycle after the failure ran in the same process (${reads} reads)`);
    // The failed cycle counted: the first completed cycle is number 1, and its failure is on the cursor.
    assert.deepEqual(result.failed.map(failure => [failure.cycle, failure.call]), [[0, 'snapshot']]);
    assert.equal(result.cycles[0]?.cycle, 1, 'the cycle counter advanced past the failed cycle');
    assert.equal(state.cycle, result.cycles.length + 1);
    assert.equal(state.failures.total, 1);
    assert.equal(state.failures.consecutive, 0, 'the completed cycle ended the run of failures');
    assert.equal(state.failures.last?.cycle, 0);
    assert.equal(state.failures.last?.phase, 'cycle');
    assert.equal(state.failures.last?.call, 'snapshot', 'the failure names the effect the rejection escaped from');
    assert.match(state.failures.last!.reason, /aborted due to timeout/);
    assert.equal(state.failures.last?.delayMs, 5, 'one failure waits the normal interval before the next cycle');
    // Persisted at the failure, before the next cycle, and logged with the cycle number.
    const recorded = states.find(entry => entry.failures.last?.cycle === 0);
    assert.ok(recorded && recorded.cycle === 1 && recorded.failures.consecutive === 1, 'the failure and the advanced counter were written to the cursor');
    assert.equal(recorded.lastCycleAt, recorded.failures.last?.at, 'a failed cycle still ends the cycle: liveness reads it, so a restart is never advised for a throw');
    assert.ok(log.some(line => /cycle 0 failed in the snapshot call: The operation was aborted due to timeout; 1 consecutive failure/.test(line)), log.join('\n'));
    assert.ok(log.some(line => /cycle 1 complete .*recovered after 1 failed cycle/.test(line)), log.join('\n'));
    assert.equal(state.lock, null, 'the lock is released on the stop, as before');

    // A configuration reload that rejects is the same event, attributed to the reload.
    const reloading = emptyDaemonState(master), reloadLog: string[] = [];
    let reloads = 0, cycles = 0;
    const survivedReload = await runDaemon(master, reloading, effects({ snapshot: async () => { if (++cycles >= 2) stop(); return { work: [], now: iso(0) }; } }),
      options({ log: line => reloadLog.push(line), reload: async () => { if (++reloads === 1) throw new Error('master.json: Unexpected end of JSON input'); return { config: master, changed: [], refused: null, at: iso(0) }; } }));
    assert.deepEqual(survivedReload.failed.map(failure => [failure.cycle, failure.call]), [[0, 'reload']]);
    assert.equal(reloading.failures.last?.phase, 'reload');
    assert.ok(reloadLog.some(line => /cycle 0 failed in the configuration reload: master.json: Unexpected end of JSON input/.test(line)), reloadLog.join('\n'));
    assert.equal(cycles, 2, 'the cycle after the failed reload ran');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:cycle-failure-backoff — consecutive failures wait longer each time up to the ceiling, reset on the first success, and past three raise an attention item naming the failing call', async () => {
  // The schedule: the interval, doubled per consecutive failure, to five minutes or the interval itself.
  assert.deepEqual([1, 2, 3, 4, 5, 6, 10].map(failures => cycleFailureDelay(failures, 20_000)), [20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
  assert.equal(cycleFailureCeilingMs, 300_000);
  assert.equal(cycleFailureDelay(0, 20_000), 20_000, 'no failure is the normal interval');
  assert.equal(cycleFailureDelay(4, 900_000), 900_000, 'an interval longer than the ceiling is its own ceiling');
  assert.equal(cycleFailureCeiling(null), 300_000);
  assert.equal(cycleFailureCeiling(180_000), 90_000, 'under a watchdog the ceiling is half the window, so a backoff is never restarted as a hang');
  assert.deepEqual([1, 2, 3, 4, 5].map(failures => cycleFailureDelay(failures, 20_000, cycleFailureCeiling(180_000))), [20_000, 40_000, 80_000, 90_000, 90_000]);
  assert.equal(cycleFailureAttentionAfter, 3);

  const { directory, token } = await privateDirectory();
  try {
    const master = config(token);
    const state = emptyDaemonState(master), log: string[] = [], { states, persist } = persisted(), readAt: number[] = [];
    let reads = 0;
    const deps = effects({ persist, snapshot: async () => { readAt.push(Date.now()); reads += 1; if (reads <= 5) throw timedOut(); stop(); return { work: [], now: iso(0) }; } });
    const started = Date.now();
    const result = await runDaemon(master, state, deps, options({ log: line => log.push(line) }));
    assert.ok(result.stopped);
    assert.equal(reads, 6, 'five failures, then the cycle that succeeded');
    // Each failure waited longer than the last: 5, 10, 20, 40, 80 ms on a 5 ms interval.
    assert.deepEqual(result.failed.map(failure => failure.delayMs), [5, 10, 20, 40, 80]);
    assert.deepEqual(result.failed.map(failure => failure.cycle), [0, 1, 2, 3, 4]);
    assert.ok(Date.now() - started >= 150, `the loop waited the growing delays (${Date.now() - started}ms elapsed)`);
    for (let index = 1; index < readAt.length; index++) assert.ok(readAt[index] - readAt[index - 1] >= result.failed[index - 1].delayMs - 2, `read ${index} came after the ${result.failed[index - 1].delayMs}ms wait`);
    // The count and reason were on the cursor at every step, growing with the run.
    const failing = states.filter(entry => entry.failures.consecutive > 0).map(entry => entry.failures);
    assert.deepEqual([...new Set(failing.map(failures => failures.consecutive))], [1, 2, 3, 4, 5]);
    assert.ok(failing.every(failures => failures.last?.call === 'snapshot' && /aborted due to timeout/.test(failures.last.reason)));
    // Then the success reset the run; the total remains.
    assert.equal(state.failures.consecutive, 0);
    assert.equal(state.failures.total, 5);
    assert.ok(log.some(line => /recovered after 5 failed cycle\(s\)/.test(line)), log.join('\n'));

    // Under `master status`: the count and reason under daemon.failures, an attention item once
    // three cycles in a row have failed, and no stall — the loop is waiting on purpose.
    const two = states.find(entry => entry.failures.consecutive === 2)!, three = states.find(entry => entry.failures.consecutive === 3)!, five = states.find(entry => entry.failures.consecutive === 5)!;
    const summary = (entry: DaemonState, at: number) => daemonSummary(entry, at, 5, 'machine-a');
    assert.equal(summary(three, Date.parse(three.failures.last!.at)).failures.consecutive, 3);
    assert.equal(summary(three, Date.parse(three.failures.last!.at)).failures.last?.reason, 'The operation was aborted due to timeout');
    const attention = (entry: DaemonState, at: number) => { const view = summary(entry, at); return loopAttention({ liveness: view.liveness, silence: view.silence, budget: view.budget, failures: view.failures }); };
    assert.deepEqual(attention(two, Date.parse(two.failures.last!.at)), [], 'two failures are a retry, not attention');
    const raised = attention(three, Date.parse(three.failures.last!.at));
    assert.equal(raised.length, 1);
    assert.match(raised[0].text, /failed 3 consecutive cycles, the last \(cycle 2 at .*\) in the snapshot call: The operation was aborted due to timeout/);
    assert.match(raised[0].text, /keeps cycling in-process/);
    assert.equal(raised[0].role, 'master');
    assert.match(raised[0].next, /daemon\.failures/);
    // Mid-backoff the lag exceeds two intervals, and the loop is still running: its next cycle is announced.
    const dueAt = Date.parse(five.failures.last!.nextAt);
    const waiting = loopLiveness(five, dueAt - 1, 5, 'machine-a');
    assert.equal(waiting.state, 'running');
    assert.ok(waiting.lagMs! > 2 * 5, 'the wait is longer than the stall bound would allow a healthy cycle');
    assert.match(waiting.detail, /Cycle 4 failed .* in the snapshot call .*5 consecutive failure\(s\), the next cycle is due at/);
    assert.equal(summary(five, dueAt - 1).running, true);
    assert.equal(loopLiveness(five, dueAt + 2 * 5 + 1, 5, 'machine-a').state, 'stalled', 'a loop that misses the cycle it announced is stalled after all');
    const recovered = states.filter(entry => entry.lock && entry.failures.consecutive === 0 && entry.failures.total === 5).at(-1)!;
    assert.equal(loopLiveness(recovered, Date.parse(recovered.lastCycleAt!), 5, 'machine-a').state, 'running');
    assert.match(loopLiveness(recovered, Date.parse(recovered.lastCycleAt!), 5, 'machine-a').detail, /^Cycle \d+ completed/, 'after the reset the liveness line is the ordinary one');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:detached-rejection-survived — an unhandled rejection or uncaught exception anywhere in the loop process is caught, logged with its origin, counted on the cursor, and the process keeps cycling until its stop signal', async () => {
  // A real process, since the claim is that it survives: the loop runs under tsx with effects that
  // reject a detached promise on the first cycle and throw from a timer on the second.
  const directory = await temporaryDirectory('detached-rejection');
  try {
    const token = join(directory, 'coordinator.token');
    await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const source = (file: string) => fileURLToPath(new URL(`../src/${file}`, import.meta.url));
    const script = join(directory, 'loop.mts');
    await writeFile(script, `
      import { emptyDaemonState, runDaemon } from ${JSON.stringify(source('master-daemon.ts'))};
      import { masterConfigSchema } from ${JSON.stringify(source('master.ts'))};
      const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: ${JSON.stringify(token)}, cliPath: ${JSON.stringify(launcher)},
        repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
      const state = emptyDaemonState(master);
      let cycles = 0;
      const effects = {
        agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
        observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }),
        recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
        snapshot: async () => {
          cycles += 1;
          // A detached promise, as an approver watch or a Herdr read nobody awaited would leave behind.
          if (cycles === 1) void Promise.reject(new Error('detached read failed'));
          // A callback that throws outside every await, which is an uncaught exception.
          if (cycles === 2) setTimeout(() => { throw new Error('detached timer threw'); }, 0);
          if (cycles === 4) process.kill(process.pid, 'SIGTERM');
          return { work: [], now: new Date().toISOString() };
        },
      };
      const result = await runDaemon(master, state, effects, { intervalMs: 5, identity: { pid: process.pid, host: 'machine-a' } });
      console.log(JSON.stringify({ cycles: result.cycles.length, failed: result.failed.length, stopped: result.stopped, failures: state.failures }));
    `);
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), script], { timeout: 60_000, encoding: 'utf8' });
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
    assert.equal(result.stopped, true, 'only the stop signal ended the process');
    assert.ok(result.cycles >= 4, `the loop kept cycling after both events (${result.cycles} cycles)`);
    assert.equal(result.failed, 0, 'neither event was a failed cycle: both happened outside the cycle');
    assert.equal(result.failures.unhandled, 2);
    assert.equal(result.failures.lastUnhandled.origin, 'uncaughtException');
    assert.equal(result.failures.lastUnhandled.reason, 'detached timer threw');
    assert.ok(typeof result.failures.lastUnhandled.cycle === 'number');
    assert.match(stderr, /unhandledRejection caught at the process level during cycle \d+ \(1 so far\); the loop keeps running: detached read failed/);
    assert.match(stderr, /uncaughtException caught at the process level during cycle \d+ \(2 so far\); the loop keeps running: detached timer threw/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
