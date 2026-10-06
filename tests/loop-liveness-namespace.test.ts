import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostPidProbe, loopAttention, loopLiveness } from '../src/daemon/liveness.js';

// GY-1369: every agent session runs confined to a PID namespace of its own, so the live loop's pid
// is invisible to it. Such a reader read "names a process that is gone" while the loop cycled.
const now = Date.parse('2026-10-06T11:20:00.000Z');
const intervalMs = 300_000;
const unseen = 2 ** 22 - 1;
const state = (lastCycleAt: string) => ({ cycle: 12712, lastCycleAt,
  lock: { id: 'lock', pid: unseen, host: 'vishrog', startedAt: '2026-10-06T11:13:53.515Z', heartbeatAt: lastCycleAt } });

test('unit:loop-liveness-confined-reader — a pid outside the reader\'s own PID namespace is unknown, not gone, so a cycling loop raises no loop-liveness attention', () => {
  assert.equal(hostPidProbe(process.pid, () => 'pid:[4026535170]'), true, 'a pid it sees is alive wherever it reads from');
  assert.equal(hostPidProbe(unseen, () => 'pid:[4026531836]'), false, 'the host namespace sees every host pid');
  assert.equal(hostPidProbe(unseen, () => null), false, 'without PID namespaces the probe is authoritative');
  assert.equal(hostPidProbe(unseen, () => 'pid:[4026535170]'), null, 'a confined reader cannot tell');

  const confined = () => null;
  const cycling = loopLiveness(state('2026-10-06T11:14:50.470Z'), now, intervalMs, 'vishrog', confined);
  assert.equal(cycling.state, 'running');
  assert.deepEqual(loopAttention({ liveness: cycling }), []);

  // A loop that really died still surfaces to that reader, on the two-interval stall bound.
  const dead = loopLiveness(state('2026-10-06T11:05:00.000Z'), now, intervalMs, 'vishrog', confined);
  assert.equal(dead.state, 'stalled');
  assert.match(loopAttention({ liveness: dead })[0].next, /graphyard master restart/);

  // The host's own reading still reports the gone process at once.
  assert.match(loopLiveness(state('2026-10-06T11:14:50.470Z'), now, intervalMs, 'vishrog', () => false).detail, /names a process that is gone/);
});
