import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routineDecision } from '../src/daemon/decisions.js';
import { containmentGraceMs, containmentInMotion, containmentSettleWaitBoundMs } from '../src/model/containment.js';
import { clock } from './helpers/soak-world.js';
import { fenced, iso, loop, minute, running, world } from './helpers/containment-settlement-world.js';
import type { Work } from '../src/model.js';
import type { SessionHandle } from '../src/model/sessions.js';

const hour = 60 * minute, day = 24 * hour;

/**
 * GY-1633 (AC-1). The two per-cycle paths this item adds, over a simulated week of the real loop —
 * the seven-day window the intervention report counts — on a controlled clock: the guarded close of
 * a submitted attempt's session whose fence outlived its grace window (GY-1520's shape) and the
 * reclaim step's settlement of a delivered item's fence (GY-1627's). Fences arrive on different days:
 *
 *   - GY-1520 (day 0): submitted, its supervisor honours a stop. Left alone through its grace window,
 *     then stopped, verified gone, its pane closed and its fence settled, inside the settle bound.
 *   - GY-1530 (day 1): submitted, its supervisor survives every stop until past the settle bound. Its
 *     pane is never closed under it and its fence stands until it exits; then the loop settles it.
 *   - GY-1627 (day 3): delivered, its supervisor gone. The reclaim step settles it.
 *   - GY-1628 (day 0): delivered, its supervisor never stops. It is refused, escalated once, never settled.
 *   - GY-1550 (day 2): submitted, its supervisor running, but its fenced workspace is registered to
 *     another host; GY-1551 (day 2) likewise with no workspace registered at all. This host cannot
 *     inspect either fence, so neither is stopped, its pane never closed, its fence never settled.
 *   - GY-1540 (day 1): a live lease renewed every cycle beside a running supervisor until it submits an
 *     hour later. Never stopped, its pane never closed.
 *
 * After every cycle the system invariants hold, no pane is ever closed under a running supervisor, and
 * no recovery decision is asked of a fence still in motion; each pane is closed once and each fence
 * settled once, all by the loop.
 */
test('unit:containment-settlement-soak — over a simulated week each lingering fence is stopped, verified, closed and settled once by the loop, a live supervisor is never closed under, and every invariant holds', { timeout: 300_000 }, async () => {
  const start = Date.parse('2026-10-03T00:00:00Z');
  clock.install(start);
  const at = (offsetMs: number) => new Date(start + offsetMs).toISOString();
  // `key`'s fence, its lease lapsing one minute after it arrives.
  const submitted = (key: string, pane: string, pr: number) => fenced(key, -minute, { submission: { epoch: 4, pr }, sessions: [running(key, pane)] });
  const delivered = (key: string, lapsedMs: number) => fenced(key, lapsedMs, { stage: 'done',
    sessions: [{ ...running(key, `w1:p${key}`), state: 'finished', outcome: `closed by the loop: ${key} has left build, the stage this implementation session was launched for, and is now in done`, endedAt: iso(0) } as unknown as SessionHandle] });
  const leased = () => fenced('GY-1540', -10 * minute, { lease: { owner: 'worker-a', epoch: 4, expiresAt: iso(10 * minute) }, lastAssignment: { owner: 'worker-a', epoch: 4, claimedAt: iso(0) },
    sessions: [{ ...running('GY-1540', 'w1:pLive'), startedAt: iso(0) } as unknown as SessionHandle] });
  const fleet = world([submitted('GY-1520', 'w1:pM68', 1004), delivered('GY-1628', 3 * minute)], ['GY-1520', 'GY-1628']);
  const arrivals: { at: number; key: string; make: () => Work; supervisor: boolean; ignoresStop?: boolean }[] = [
    { at: day, key: 'GY-1530', make: () => submitted('GY-1530', 'w1:pM70', 1005), supervisor: true, ignoresStop: true },
    { at: day, key: 'GY-1540', make: leased, supervisor: true },
    { at: 2 * day, key: 'GY-1550', make: () => ({ ...submitted('GY-1550', 'w1:pM72', 1007), workspaces: [{ host: 'other-host', path: '/srv/worktrees/GY-1550-4', epoch: 4, owner: 'worker-a', branch: 'graphyard/gy-1550-1' }] }), supervisor: true },
    { at: 2 * day, key: 'GY-1551', make: () => ({ ...submitted('GY-1551', 'w1:pM73', 1008), workspaces: [] }), supervisor: true },
    { at: 3 * day, key: 'GY-1627', make: () => delivered('GY-1627', 3 * minute), supervisor: false },
  ];
  // GY-1530's supervisor exits on its own well past its settle bound; GY-1540 submits an hour in, and
  // its supervisor settles its own fence and exits, as a clean `complete` does.
  const stubbornExit = day + minute + containmentGraceMs + containmentSettleWaitBoundMs + 30 * minute, liveEnds = day + hour;
  // Every minute for the half hour after each arrival or exit, hourly otherwise, for seven days.
  const busy = [0, day, 2 * day, stubbornExit, liveEnds, 3 * day];
  const steps = [...new Set([...Array.from({ length: 7 * 24 + 1 }, (_, n) => n * hour), ...busy.flatMap(mark => Array.from({ length: 30 }, (_, n) => mark + n * minute))])].sort((a, b) => a - b);
  // Herdr lists each open session's pane: its agent at work while its supervisor runs, a bare shell once it exited.
  const agents = () => [...fleet.plane.items.values()].flatMap(item => (item.sessions ?? []).filter(handle => handle.state === 'running' && handle.pane && !fleet.panesClosed.includes(handle.pane))
    .map(handle => fleet.running.has(item.key) ? { name: 'graphyard-opencode-1', pane_id: handle.pane, agent: 'claude', agent_status: 'working' } : { name: null, pane_id: handle.pane, agent: null, agent_status: null }));
  const harness = await loop({ ...fleet.effects, agents, herdr: () => ({ agents: agents(), available: true }) } as typeof fleet.effects, fleet.snapshot);
  const violations: string[] = [], recoveries: string[] = [], settledInMotion: string[] = [];
  let cycles = 0;
  try {
    for (const step of steps) {
      clock.advance(start + step - clock.now());
      for (const arrival of arrivals) if (step >= arrival.at && !fleet.byKey(arrival.key)) {
        const item = arrival.make();
        fleet.plane.items.set(item.id, item);
        if (arrival.supervisor) fleet.running.add(arrival.key);
        if (arrival.ignoresStop) fleet.stubborn.add(arrival.key);
      }
      if (step >= stubbornExit) { fleet.stubborn.delete('GY-1530'); fleet.running.delete('GY-1530'); }
      // The live attempt renews its lease, as its supervisor does, until it submits.
      const live = fleet.byKey('GY-1540');
      if (live && step < liveEnds) {
        live.lease = { owner: 'worker-a', epoch: 4, expiresAt: iso(10 * minute) };
        live.containmentQuarantine = { ...live.containmentQuarantine!, leaseExpiresAt: live.lease.expiresAt };
        assert.ok(fleet.running.has('GY-1540') && !fleet.stopped.includes('GY-1540') && !fleet.panesClosed.includes('w1:pLive'), `${at(step)}: the live attempt is untouched while it holds its lease`);
      } else if (live?.lease) {
        Object.assign(live, { lease: null, containmentQuarantine: null, submission: { epoch: 4, pr: 1006 }, sessions: [{ ...live.sessions![0], state: 'finished', outcome: 'submitted', endedAt: iso(0) }] });
        fleet.running.delete('GY-1540');
      }
      const cycleAt = Date.now(), fencedBefore = new Map([...fleet.plane.items.values()].filter(item => item.containmentQuarantine).map(item => [item.key, containmentInMotion(item, cycleAt)]));
      const settlesBefore = fleet.plane.settles.length;
      await harness.run();
      cycles++;
      const when = `${at(step)} (cycle ${cycles})`;
      assert.ok(harness.state.invariants.report.length, `${when}: the loop judged the system invariants`);
      for (const check of harness.state.invariants.report) if (!check.holds) violations.push(`${when}: ${check.invariant} — ${check.reading}`);
      for (const key of fleet.plane.settles.slice(settlesBefore)) if (key === 'GY-1530' && step < stubbornExit) settledInMotion.push(`${when}: ${key}`);
      for (const item of fleet.plane.items.values()) {
        if (!item.containmentQuarantine || !fencedBefore.get(item.key)) continue;
        const decision = routineDecision(item, harness.config, cycleAt, { key: item.key, epoch: 4, settleable: true, refusals: [], host: 'coordinator-host', scope: null, verification: null, attestation: '' } as any);
        if (decision?.action === 'recover') recoveries.push(`${when}: ${item.key}`);
      }
      if (step < day && step < minute + containmentGraceMs) assert.deepEqual(fleet.stopped, [], `${when}: GY-1520 is in its grace window, so its supervisor is left alone`);
      if (step >= day && step < stubbornExit && fleet.byKey('GY-1530')) {
        assert.equal(fleet.byKey('GY-1530').sessions?.[0]?.state, 'running', `${when}: GY-1530's supervisor still runs, so its session stays open`);
        assert.ok(fleet.running.has('GY-1530'), `${when}: and its supervisor is untouched by any pane close`);
      }
      for (const key of ['GY-1550', 'GY-1551']) if (fleet.byKey(key)) {
        assert.equal(fleet.byKey(key).sessions?.[0]?.state, 'running', `${when}: ${key}'s fence cannot be inspected here, so its session stays open`);
        assert.ok(fleet.running.has(key) && !fleet.stopped.includes(key), `${when}: and its supervisor is neither stopped nor closed under`);
      }
    }
    assert.ok(cycles > 250, `the week ran ${cycles} cycles`);
    assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
    assert.deepEqual(fleet.closedUnderLive, [], 'no pane is ever closed under a running supervisor');
    assert.deepEqual(recoveries, [], 'no recovery decision is asked of a fence still in motion');
    assert.deepEqual(settledInMotion, [], 'a fence whose supervisor runs is never settled');
    assert.deepEqual([...fleet.panesClosed].sort(), ['w1:pM68', 'w1:pM70'], 'each lingering submitted session is closed once');
    assert.deepEqual([...fleet.plane.settles].sort(), ['GY-1520', 'GY-1530', 'GY-1627'], 'each settleable fence is settled once, by the loop');
    assert.equal(fleet.stopped.filter(key => key === 'GY-1520').length, 1, 'GY-1520 is stopped once');
    assert.ok(fleet.stopped.includes('GY-1530'), 'GY-1530 is asked to stop');
    assert.ok(!fleet.stopped.includes('GY-1540') && !fleet.stopped.includes('GY-1628'), 'a leased or delivered supervisor is never stopped by this path');
    for (const key of ['GY-1550', 'GY-1551']) {
      assert.ok(!fleet.panesClosed.some(pane => fleet.byKey(key).sessions?.some(handle => handle.pane === pane)), `${key}'s pane is never closed`);
      assert.notEqual(fleet.byKey(key).containmentQuarantine, null, `${key}'s uninspectable fence is never settled`);
      assert.ok(!Object.keys(harness.state.actions).some(action => action.startsWith(`close:implementation:work-${key}:`)), `${key} is never attempted by the close step, so no failing close is retried each cycle`);
    }
    assert.equal(fleet.byKey('GY-1540').sessions?.[0]?.outcome, 'submitted', 'the live attempt ended on its own submission, not by the loop');
    assert.notEqual(fleet.byKey('GY-1628').containmentQuarantine, null, 'a delivered supervisor still running holds its fence');
    assert.match(harness.state.actions['escalation:containment:work-GY-1628:4']?.detail ?? '', /cannot be settled automatically/, 'the held fence is escalated, once its refusal is known');
    const failed = Object.entries(harness.state.actions).filter(([key, action]) => key.startsWith('settle:') && action.state !== 'done' && !key.includes('GY-1628'));
    assert.deepEqual(failed.map(([key]) => key), [], 'no settlement is left failing, so none is retried');
  } finally { await harness.cleanup(); clock.uninstall(); }
});
