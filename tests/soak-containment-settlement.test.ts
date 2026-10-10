import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routineDecision } from '../src/daemon/decisions.js';
import { fenced, loop, minute, running, world } from './helpers/containment-settlement-world.js';
import type { SessionHandle } from '../src/model/sessions.js';

/**
 * GY-1633 (AC-1). The two per-cycle paths this item adds, over many cycles of the real loop: the
 * close of a submitted attempt's session whose fence outlived its grace window (GY-1520's shape) and
 * the reclaim step's settlement of a delivered item's fence (GY-1627's). Beside them stand a submitted
 * attempt still in its grace window, whose supervisor is left alone until the window ends, and a
 * delivered item whose supervisor never stops, which the loop must keep refusing without settling,
 * closing or asking anything of it. After every cycle the system invariants hold; each pane is closed
 * once, each fence settled once, nothing is retried once done, and no recovery decision is asked of a
 * fence the reclaim step is settling.
 */
test('unit:containment-settlement-soak — over repeated cycles each lingering fence is closed and settled once by the loop, a held one is never settled, and every invariant holds', { timeout: 300_000 }, async () => {
  const delivered = (key: string, lapsedMs: number) => fenced(key, lapsedMs, { stage: 'done',
    sessions: [{ ...running(key, `w1:p${key}`), state: 'finished', outcome: `closed by the loop: ${key} has left build, the stage this implementation session was launched for, and is now in done`, endedAt: new Date().toISOString() } as unknown as SessionHandle] });
  const fleet = world([
    fenced('GY-1520', 3 * minute, { submission: { epoch: 4, pr: 1004 }, sessions: [running('GY-1520', 'w1:pM68')] }),
    // Its lease runs 90s more: not yet lapsed in the first cycles; cycle 5 dates its lapse past the grace window.
    fenced('GY-1521', -90_000, { submission: { epoch: 4, pr: 1005 }, sessions: [running('GY-1521', 'w1:pM69')] }),
    delivered('GY-1627', 3 * minute),
    delivered('GY-1628', 3 * minute),
  ], ['GY-1520', 'GY-1521', 'GY-1628']);
  const harness = await loop(fleet.effects, fleet.snapshot);
  const violations: string[] = [], recoveries: string[] = [];
  try {
    for (let cycle = 1; cycle <= 8; cycle++) {
      // GY-1521's lease lapses 90s in: move the clock past its grace window halfway through.
      if (cycle === 5) { const item = fleet.plane.items.get('work-GY-1521')!; item.containmentQuarantine = { ...item.containmentQuarantine!, leaseExpiresAt: new Date(Date.now() - 3 * minute).toISOString() }; }
      const before = fleet.panesClosed.length;
      await harness.run();
      assert.ok(harness.state.invariants.report.length, `cycle ${cycle}: the loop judged the system invariants`);
      for (const check of harness.state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle}: ${check.invariant} — ${check.reading}`);
      for (const item of fleet.plane.items.values()) {
        const decision = routineDecision(item, harness.config, Date.now(), { key: item.key, epoch: 4, settleable: true, refusals: [], host: 'coordinator-host', scope: null, verification: null, attestation: '' } as any);
        if (decision?.action === 'recover') recoveries.push(`cycle ${cycle}: ${item.key}`);
      }
      if (cycle < 5) assert.equal(fleet.byKey('GY-1521').sessions?.[0]?.state, 'running', `cycle ${cycle}: GY-1521 is in its grace window, so its session is left alone`);
      if (cycle === 1) assert.equal(fleet.panesClosed.length - before, 1, 'the first cycle closes GY-1520\'s pane only');
    }
    assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
    assert.deepEqual(recoveries, [], 'no recovery decision is asked of a fence the reclaim step settles inside its bound');
    assert.deepEqual([...fleet.panesClosed].sort(), ['w1:pM68', 'w1:pM69'], 'each lingering submitted session is closed once');
    assert.deepEqual([...fleet.plane.settles].sort(), ['GY-1520', 'GY-1521', 'GY-1627'], 'each settleable fence is settled once');
    assert.notEqual(fleet.byKey('GY-1628').containmentQuarantine, null, 'a supervisor still running holds its fence');
    const failed = Object.entries(harness.state.actions).filter(([key, action]) => key.startsWith('settle:') && action.state !== 'done');
    assert.deepEqual(failed.map(([key]) => key), [], 'no settlement is left failing, so none is retried');
    assert.match(harness.state.actions['escalation:containment:work-GY-1628:4']?.detail ?? '', /cannot be settled automatically/, 'the held fence is escalated, once its refusal is known');
  } finally { await harness.cleanup(); }
});
