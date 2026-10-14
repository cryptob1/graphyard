import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, hour } from './helpers/soak-world.js';
import { controlPlane, listeners, soakControlPlanes, stores } from './helpers/soak-plane.js';
import { twinHoldDay } from './helpers/soak-simulation.js';

/**
 * GY-1637: the twin-hold soak case failed 2 of 4 release soaks, its registry report stamped one real
 * millisecond before the hold it reported (the simulated clock runs real time forward, and the hold
 * was stamped after its file writes). This drives the same day, with the same inputs and the same
 * phase of the simulated hour, 50 times in a row in one process, each on a fresh control plane, and
 * every run must pass every assertion the soak case makes.
 */
soakControlPlanes('soak-twin-hold-deterministic', 436);

const runs = 50;

test('unit:soak-twin-hold-deterministic — the twin-hold day, driven 50 times in a row in one process with the same inputs from the same phase of the simulated hour, passes every assertion of its soak case every time', { timeout: 3_600_000 }, async () => {
  const failed: string[] = [];
  for (let run = 1; run <= runs; run++) {
    // The same seed for every run: each day starts on a whole simulated hour, so its reset, notice and cycles fall alike.
    const now = clock.now(); clock.advance(Math.ceil(now / hour) * hour - now);
    await controlPlane(`soak_twin_hold_${run}`);
    await twinHoldDay().catch((error: unknown) => { failed.push(`run ${run}: ${error instanceof Error ? error.message : String(error)}`); });
    // Each run's plane closes with its day, so fifty planes never hold fifty pools of connections at once.
    const listener = listeners.pop()!, store = stores.pop()!;
    await new Promise<void>(resolve => listener.close(() => resolve())); await store.close();
  }
  assert.deepEqual(failed, [], `every one of the ${runs} runs passed`);
});
