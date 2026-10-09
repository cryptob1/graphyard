import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hour, minute } from './helpers/soak-world.js';
import { soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * GY-1585 under the real loop for a simulated day. Instance 2026-10-09T11:32:44Z..11:40Z: the
 * self-upgrade re-executed the loop onto a merged tip before the promoted release served it, so the
 * coordinator's registry selects spoke a schema the serving plane still refused (400 Invalid input
 * on every launch). Here every deploy promotes a release cut half an hour earlier while items keep
 * merging, so each alignment after a deploy finds a tip with loaded code the served release does
 * not contain: the restart is held, cycle after cycle, until a later deploy serves it.
 *
 * One concern of the release-candidate soak (GY-404), in its own file (GY-1363): the world is
 * tests/helpers/soak-world.ts, the control planes tests/helpers/soak-plane.ts, the day
 * tests/helpers/soak-simulation.ts (`releaseLag`), and the system invariants are asserted after
 * every cycle.
 */
soakControlPlanes('soak-release-lag', 431);

const deploys = [90 * minute, 3 * hour, 4 * hour + 30 * minute, 6 * hour];
const plan = { items: 16, heldClaimRestarts: 0, leftovers: 0, slowRecompute: 0, unstable: 0, attested: 0, workMs: 15 * minute, rework: new Set<number>(), deaths: new Set<number>(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set<number>(), misread: new Set<number>(), exits: new Set<number>(), spentProducer: 0, lostRuns: 0,
  outOfQueue: { item: 16, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 16 }, loopRestarts: [] as number[], dirtyCheckout: { from: 99 * hour, to: 100 * hour }, headMove: { from: 99 * hour, to: 100 * hour }, deploys };

test('manual:self-upgrade-holds-restart-until-release-serves-it — over a simulated day of the real loop whose every deploy serves a release behind the base tip, each alignment checks the tip out but holds the executor and loop restarts under one waiting release-lagged row, never advancing the held target or fetching while production lags; the deploy that serves it completes the restart and settles the row, every restart lands on a commit the served release contains, the upgrade rows stay bounded by the deploys, and the day ends with the loop on the release production serves', { timeout: 600_000 }, async () => {
  const day = await simulateDay({ hours: 7, plan, releaseLag: { cutAgoMs: 30 * minute } });
  const r = day.releaseLagDay!, short = (sha: string) => sha.slice(0, 12);
  assert.deepEqual(day.violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(day.failures, [], 'no cycle or self-upgrade failed');
  assert.deepEqual(day.lost, [], 'no lease was lost');
  assert.equal(day.production.deploys.length, deploys.length);

  // The core property: no restart ever loads code the plane does not serve.
  assert.ok(r.restarts.length > 0, 'the loop restarted onto merged code during the day');
  assert.deepEqual(r.restarts.filter(restart => !restart.contained), [], 'every executor and loop restart landed on a commit the served release contains');

  // The holds: runs of consecutive held passes, one per lagging deploy.
  const holds: { target: string; passes: typeof r.passes }[] = [];
  for (const pass of r.passes) {
    if (pass.stall !== 'release-lagged') continue;
    const last = holds.at(-1);
    if (last && last.target === pass.pending && r.passes[r.passes.indexOf(pass) - 1]?.stall === 'release-lagged') last.passes.push(pass);
    else holds.push({ target: pass.pending!, passes: [pass] });
  }
  assert.ok(holds.length >= 2, `the day held the restart more than once: ${holds.map(hold => short(hold.target)).join(', ')}`);
  assert.ok(holds.length <= deploys.length, 'at most one hold per deploy');
  /** Where the cycle after a pass starts: a restart is clocked inside its pass's cycle, after the pass's start. */
  const nextStart = (pass: typeof r.passes[number]) => r.passes[r.passes.indexOf(pass) + 1]?.elapsed ?? Infinity;
  for (const hold of holds) {
    const label = `hold on ${short(hold.target)}`, [first] = hold.passes, end = hold.passes.at(-1)!;
    assert.ok(hold.passes.length >= 6, `${label} stood for ${hold.passes.length} cycles`);
    assert.ok(hold.passes.every(pass => pass.outcome === 'pending' && pass.head === hold.target && pass.pending === hold.target), `${label}: the checkout holds the target and the restart stays owed on it`);
    assert.ok(hold.passes.every(pass => pass.fetches === first.fetches), `${label}: no held pass fetched a newer tip`);
    assert.ok(hold.passes.every(pass => pass.held?.state === 'waiting' && pass.held.attempts === first.held!.attempts), `${label}: one waiting row whose attempts do not grow while the hold stands`);
    assert.ok(hold.passes.every(pass => pass.waiting === 1), `${label}: no other upgrade row waits beside it`);
    assert.ok(hold.passes.every(pass => pass.upgradeRows === first.upgradeRows), `${label}: a standing hold adds no upgrade row`);
    assert.ok(!r.restarts.some(restart => restart.elapsed >= first.elapsed && restart.elapsed < nextStart(end)), `${label}: nothing restarted while it stood`);
    // The pass after the hold completes the restart onto exactly the held target, once the release serves it.
    const next = r.passes[r.passes.indexOf(end) + 1], after = r.passes[r.passes.indexOf(end) + 2]?.elapsed ?? Infinity;
    if (!next) continue;
    assert.equal(next.outcome, 'upgraded', `${label}: the first pass after it completed the restart`);
    assert.deepEqual(r.restarts.filter(restart => restart.elapsed >= next.elapsed && restart.elapsed < after).map(restart => [restart.kind, restart.to]), [['executors', hold.target], ['self', hold.target]], `${label}: the executors and the loop restarted onto the held target`);
    assert.equal(next.held?.state, 'done', `${label}: the pass that lifted it settled the waiting row`);
    assert.equal(next.waiting, 0, `${label}: no upgrade row is left waiting`);
  }
  // Rows bounded: one per release the alignment ran under, the held row and the unit, whatever the cycle count.
  assert.ok(Math.max(...r.passes.map(pass => pass.upgradeRows)) <= deploys.length + 2, `the upgrade rows stay bounded by the deploys: ${Object.keys(day.state.actions).filter(key => key.startsWith('upgrade:')).join(', ')}`);
  assert.equal(day.state.actions['upgrade:held']?.state, 'done', 'the last hold is settled');
  assert.match(day.state.actions['upgrade:held']!.detail, /^The restart onto [0-9a-f]{12} is no longer held: production serves release [0-9a-f]{12}, which contains/);
  // Convergence: the day ends with the loop on the release production serves.
  assert.equal(day.state.release?.commit, day.production.sha, 'the loop runs the release production serves');
  assert.equal(day.checkout.head, day.production.sha, 'and the checkout holds it');
  assert.equal(day.state.upgrade.pending, null);
  assert.equal(day.state.upgrade.stalled, undefined);
});
