import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { acquireDaemonLock, daemonStateSchema, emptyDaemonState, loopLiveness, type DaemonState } from '../src/master-daemon.js';
// A namespace import, so the symbols GY-1370 adds read as missing test cases on a base without them, not a failed load.
import * as daemon from '../src/master-daemon.js';

const interval = 20_000;
const config = { url: 'http://127.0.0.1:1', repository: 'owner/repo' } as Parameters<typeof emptyDaemonState>[0];
// A pid that is certainly gone: a child that already exited and was reaped.
const deadPid = () => { const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }); return Number(child.stdout); };
const foreign = 'pid:[4026539999]';
function cursor(lock: Partial<NonNullable<DaemonState['lock']>>, lastCycleAt: number) {
  const state = emptyDaemonState(config);
  state.lock = { id: 'lock', pid: deadPid(), host: 'machine-a', startedAt: new Date(lastCycleAt).toISOString(), heartbeatAt: new Date(lastCycleAt).toISOString(), ...lock };
  state.cycle = 12707;
  state.lastCycleAt = new Date(lastCycleAt).toISOString();
  return state;
}

test('unit:loop-liveness-foreign-namespace — a reader outside the lock\'s PID namespace never reads an invisible pid as an absent loop', () => {
  const now = Date.parse('2026-10-06T10:51:00Z');
  const recorded = 'pid:[4026531836]';
  // GY-1369: a sandboxed diagnostician read the host loop's lock and could not see its pid.
  const recent = loopLiveness(cursor({ pidNamespace: recorded }, now - 5_000), now, interval, 'machine-a', foreign);
  assert.equal(recent.state, 'running', 'a recent last cycle is a running loop whatever the probe says');
  assert.match(recent.detail, /could not be probed from this PID namespace/);
  assert.match(recent.detail, new RegExp(`pid:\\[4026539999\\].*pid:\\[4026531836\\]`), 'the detail names both namespaces');

  const lagging = loopLiveness(cursor({ pidNamespace: recorded }, now - 3 * interval), now, interval, 'machine-a', foreign);
  assert.equal(lagging.state, 'stalled', 'past two intervals the lag rule judges it stalled, not absent');
  assert.match(lagging.detail, /is stalled; pid \d+ could not be probed from this PID namespace/);

  const slowCursor = cursor({ pidNamespace: recorded }, now - 3 * interval);
  slowCursor.metrics = [{ cycle: 12706, at: new Date(now - 3 * interval).toISOString(), durationMs: 5 * interval } as DaemonState['metrics'][number]];
  const slow = loopLiveness(slowCursor, now, interval, 'machine-a', foreign);
  assert.equal(slow.state, 'slow', 'a measured long cycle still explains the lag');
  assert.match(slow.detail, /could not be probed from this PID namespace/);

  // The same lock read from its own namespace: a pid that is truly gone is an absent loop.
  const own = loopLiveness(cursor({ pidNamespace: recorded }, now - 5_000), now, interval, 'machine-a', recorded);
  assert.equal(own.state, 'absent');
  assert.match(own.detail, /names a process that is gone/);
  // And a live pid in the reader's own namespace is running, with no probe caveat.
  const live = loopLiveness(cursor({ pid: process.pid, pidNamespace: recorded }, now - 5_000), now, interval, 'machine-a', recorded);
  assert.equal(live.state, 'running');
  assert.doesNotMatch(live.detail, /could not be probed/);
  // A lock on another host is never probed at all, so it never carries the caveat either.
  assert.doesNotMatch(loopLiveness(cursor({ host: 'machine-b', pidNamespace: recorded }, now - 5_000), now, interval, 'machine-a', foreign).detail, /could not be probed/);
});

test('unit:loop-liveness-foreign-namespace — the lock records the namespace it was taken in, and the cursor keeps it', () => {
  const state = emptyDaemonState(config);
  const lock = acquireDaemonLock(state, { pid: process.pid, host: 'machine-a' }, Date.now(), interval);
  assert.equal(lock.pidNamespace, daemon.pidNamespace());
  assert.deepEqual(daemonStateSchema.parse(JSON.parse(JSON.stringify(state))).lock, lock, 'the namespace survives a cursor round trip');
  // A cursor written before GY-1370 still parses.
  const legacy = { ...emptyDaemonState(config), lock: { id: 'old', pid: 1, host: 'machine-a', startedAt: '2026-10-06T00:00:00Z', heartbeatAt: '2026-10-06T00:00:00Z' } };
  assert.equal(daemonStateSchema.parse(legacy).lock?.pidNamespace, undefined);
});

test('unit:loop-liveness-foreign-namespace — a lock written before the namespace was recorded is probed on the host and unprobeable from a sandbox', () => {
  const now = Date.parse('2026-10-06T10:51:00Z');
  const legacy = () => { const state = cursor({}, now - 5_000); delete state.lock!.pidNamespace; return state; };
  assert.equal(daemon.pidProbeable({}, daemon.initialPidNamespace), true);
  assert.equal(daemon.pidProbeable({}, null), true, 'a reader with no /proc (not Linux) probes as it always did');
  assert.equal(daemon.pidProbeable({}, foreign), false);
  assert.equal(daemon.pidProbeable({ pidNamespace: foreign }, null), false, 'a reader that cannot name its namespace cannot match a recorded one');

  const host = loopLiveness(legacy(), now, interval, 'machine-a', daemon.initialPidNamespace);
  assert.equal(host.state, 'absent', 'on the host a gone pid is still an absent loop');
  const sandboxed = loopLiveness(legacy(), now, interval, 'machine-a', foreign);
  assert.equal(sandboxed.state, 'running', 'a sandboxed reader files no loop fault from an invisible pid');
  assert.match(sandboxed.detail, /could not be probed from this PID namespace \(pid:\[4026539999\], the lock was taken in the host's\)/);
  const stalled = loopLiveness(cursor({}, now - 3 * interval), now, interval, 'machine-a', foreign);
  assert.equal(stalled.state, 'stalled');
});
