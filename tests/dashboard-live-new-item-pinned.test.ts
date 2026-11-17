import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { poll } from '../web/poll.js';

// GY-3363: browser-tests/dashboard-live-new-item.spec.ts failed on the batch gate's loaded host. The
// dashboard polled on a fixed 5 s interval and skipped a tick while a read was in flight, so a read
// that overran the interval left it idle until the tick after: an item filed during that read showed
// ~10 s plus a read later, past the spec's 10 s. The next read now starts as soon as an overrun one ends.
test('unit:test-browser-tests-dashboard-live-new-item-spec-ts-pinned — a dashboard read that overruns the poll interval is followed at once, a quick one five seconds after it started', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const advance = async (ms: number) => { for (let step = 0; step < ms; step++) { mock.timers.tick(1); await settle(); } };
  const starts: number[] = [], durations = [5_500, 1_000, 1_000];
  const polling = poll(() => { const ms = durations[starts.length] ?? 1_000; starts.push(Date.now()); return new Promise(resolve => setTimeout(resolve, ms)); }, 5_000);
  try {
    await settle();
    await advance(11_000);
    // 5.5 s read, then at once; a 1 s read, then 5 s after it started.
    assert.deepEqual(starts.map(at => Math.round(at / 100) * 100), [0, 5_500, 10_500]);
    // A read asked for while one is in flight (the tab shown again) does not start a second one.
    polling.now(); await settle();
    assert.equal(starts.length, 3);
  } finally { polling.stop(); mock.timers.reset(); }
});
