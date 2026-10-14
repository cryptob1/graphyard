import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPromoteEveryMinutes, promotionCandidatesListed, promotionRunsReadMs, promotionSoaksListed, promotionStatus } from '../src/daemon/deployment.js';
import { clock, hour, minute } from './helpers/soak-world.js';
import { soakConfig, soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * GY-1513: the promotion drive over release candidates whose runs conclude at promote while each
 * one's advisory soak runs on in a workflow of its own. One concern of the release-candidate soak
 * (GY-404), split per concern (GY-1363): the world is tests/helpers/soak-world.ts, the control
 * planes tests/helpers/soak-plane.ts, the day itself tests/helpers/soak-simulation.ts, and every
 * suite asserts the system invariants after every cycle.
 */
soakControlPlanes('soak-promotion', 414);

test('unit:soak-promotion-overlapping-soaks — a simulated day of the real loop (GY-1513): each release run promotes its candidate six minutes in and concludes at eight while its soak runs on for twenty-five; the next candidate is dispatched within one loop interval of the run concluding, inside the ten-minute gap, while the last soak still runs; soak reads stay bounded, fail without failing a cycle and decide nothing; master status shows every candidate\'s soak', { timeout: 360_000 }, async () => {
  const hours = 6, interval = soakConfig.run.intervalSeconds * 1000;
  const day = await simulateDay({ hours, promotion: { validationMs: 8 * minute, promoteAfterMs: 6 * minute, soakMs: 25 * minute } });
  const { promotion, violations, failures, lost, state, cycles, dayStart } = day;
  const at = (time: number) => Math.round((time - dayStart) / minute);
  if (process.env.SOAK_TRACE) console.error(`promotion: ${JSON.stringify({ dispatches: promotion.dispatches.map(at), promotions: promotion.promotions.map(at), followDelays: promotion.followDelays, soakOverlaps: promotion.soakOverlaps, soakReads: promotion.soakReads, failedSoakReads: promotion.failedSoakReads, runReads: promotion.runReads, cycles })}`);
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(failures, [], 'no cycle failed: a failed soak read is advisory');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  assert.deepEqual(promotion.violations, [], 'never while a candidate is in validation, never a tip cut twice, never when production runs main, and inside the gap only after a run that promoted');

  // The runs promoted their candidates, whatever each one's soak said, and the next candidate followed each promoting run.
  assert.ok(promotion.promotions.length >= 3, `the runs promoted their candidates over ${hours} h: ${promotion.promotions.map(at)}`);
  assert.ok(promotion.promotions.length >= promotion.candidates.length - 1, `every candidate but the day's last promoted: ${promotion.promotions.length} of ${promotion.candidates.length}`);
  assert.ok(promotion.soaks.some(soak => soak.result === 'failure' && promotion.promotions.some(time => time >= soak.startedAt)), 'a candidate whose soak fails is promoted all the same');
  // AC-3 through the loop: with main already ahead, a promoting run is followed within one interval of concluding — inside the ten-minute gap.
  assert.ok(promotion.followDelays.length >= 2, `main was ahead when runs concluded: ${promotion.followDelays.length} follow-ups`);
  for (const delay of promotion.followDelays) assert.ok(delay <= interval, `dispatched ${Math.round(delay / 1000)}s after the run concluded, within the ${interval / 1000}s interval`);
  const gaps = promotion.dispatches.slice(1).map((time, index) => time - promotion.dispatches[index]);
  assert.ok(gaps.some(gap => gap < defaultPromoteEveryMinutes * minute), `a promoting run is followed inside the ${defaultPromoteEveryMinutes}-minute gap: ${gaps.map(gap => Math.round(gap / minute))}`);
  assert.ok(promotion.soakOverlaps >= 2, `the next candidates were dispatched while the last soak still ran: ${promotion.soakOverlaps}`);

  // Bounded: soak runs are read at most once a run-read window, and only while one runs or the newest candidate's is awaited;
  // the failing half hour cost one read a window and no cycle; the state keeps at most ten runs and five candidates.
  assert.ok(promotion.soakReads <= Math.ceil(hours * hour / promotionRunsReadMs) + 2 && promotion.soakReads < cycles, `soak reads at most once a minute (${promotion.soakReads} over ${cycles} cycles)`);
  assert.ok(promotion.failedSoakReads >= 1 && promotion.failedSoakReads <= Math.ceil(30 * minute / promotionRunsReadMs) + 1, `failed soak reads stay bounded (${promotion.failedSoakReads} in half an hour)`);
  assert.ok(promotion.runReads <= Math.ceil(hours * hour / interval) + 2 && promotion.runReads < cycles, `run reads at most once an interval (${promotion.runReads} over ${cycles} cycles)`);
  assert.ok((state.promotion?.soaks?.length ?? 0) <= promotionSoaksListed && (state.promotion?.candidates?.length ?? 0) <= promotionCandidatesListed, 'the promotion state stays bounded');

  // Master status at the day's end: every listed candidate's soak, running while its run is, its recorded verdict once concluded.
  const status = promotionStatus(state.promotion);
  assert.ok(status.candidates.length >= 3 && status.candidates.every(candidate => candidate.soak), `every listed candidate shows its soak: ${JSON.stringify(status.candidates)}`);
  for (const candidate of status.candidates) {
    const soak = promotion.soaks.find(entry => entry.id === candidate.id)!;
    assert.equal(candidate.soak?.state, clock.now() < soak.endsAt ? 'running' : soak.result === 'success' ? 'passed' : 'failed', `${candidate.id}'s soak as master status shows it`);
  }
  assert.equal(status.lastPromotedSha, promotion.promoted?.sha, 'production runs the last promoted candidate');
});
