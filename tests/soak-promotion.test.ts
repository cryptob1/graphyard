import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  defaultPromoteEveryMinutes, promotionCandidatesListed, promotionCycle, promotionLedgerReadMs,
  promotionOffReason, promotionRunsReadMs, promotionSoaksListed, promotionStatus, promotionUpToDateReason,
  type PromotionReads,
} from '../src/daemon/deployment.js';
import { observedPromotionStatus } from '../src/daemon/promotion-stale.js';
import { promotionStateSchema, type PromotionState } from '../src/daemon/state.js';
import { clock, hour, minute } from './helpers/soak-world.js';
import { soakConfig, soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * GY-1513: the promotion drive over release candidates whose runs conclude at promote while each
 * one's advisory soak runs on in a workflow of its own. One concern of the release-candidate soak
 * (GY-404), split per concern (GY-1363): the world is tests/helpers/soak-world.ts, the control
 * planes tests/helpers/soak-plane.ts, the day itself tests/helpers/soak-simulation.ts, and every
 * suite asserts the system invariants after every cycle.
 *
 * GY-1894: a second day exercises repeated in-flight settlement against a moving tip, the main-watch
 * gate on a refreshed ledger, and disabled-promotion summaries — bounded reads/dispatches and
 * truthful master-status reasons across successive candidates. That day is pure cycle I/O and does
 * not share the control-plane Postgres the overlapping-soaks day needs.
 */
const sha = (label: string) => createHash('sha1').update(label).digest('hex');
const iso = (at: number) => new Date(at).toISOString();

/**
 * GY-1894: repeated settlement of a carried in-flight flag against a moving tip, the main-watch gate
 * after a forced ledger refresh, and disabled-promotion summaries — over a simulated succession of
 * candidates, not a single unit fixture. Instants are epoch milliseconds handed to the cycle.
 */
test('unit:soak-promotion-stale-tip-settlement — successive candidates settle in-flight against a moved tip, wait on an unclassified watch tip, and keep disabled-promotion summaries truthful without a stuck-drive alert', async () => {
  const t0 = 1_760_100_000_000;
  const cycleMs = 20_000, everyMinutes = 10, validationMs = 8 * minute;
  const mainline = [sha('root')];
  let promoted = mainline[0]!, promotedAt = t0, now = t0;
  const cuts: { at: number; sha: string; concludesAt: number }[] = [];
  let ledgerReads = 0, runReads = 0, dispatches = 0;
  const pending = ['GY-1894-a'];
  const liveReads = (): PromotionReads => ({
    ledger: async () => {
      ledgerReads++;
      const tip = mainline.at(-1)!;
      return { mainSha: tip, promotedSha: promoted, promotedAt: iso(promotedAt), behind: tip === promoted ? 0 : 1, candidates: [] };
    },
    runs: async () => {
      runReads++;
      return cuts.slice().reverse().map(cut => ({
        status: now < cut.concludesAt ? 'in_progress' : 'completed',
        createdAt: iso(cut.at), event: 'workflow_dispatch' as const, headSha: cut.sha,
      }));
    },
    dispatch: async () => {
      dispatches++;
      const tip = mainline.at(-1)!;
      cuts.push({ at: now, sha: tip, concludesAt: now + validationMs });
    },
  });

  let state: PromotionState | null = null;
  let watchWaits = 0, settlements = 0;
  const cycles = 90;

  for (let cycle = 0; cycle < cycles; cycle++) {
    now = t0 + cycle * cycleMs;
    // Land a merge every ~3 minutes so tips move while candidates validate.
    if (cycle > 0 && cycle % 9 === 0) mainline.push(sha(`merge-${mainline.length}`));
    // Promote a concluded cut six minutes after dispatch so the next tip can follow.
    for (const cut of cuts) {
      if (now >= cut.at + 6 * minute && now >= cut.concludesAt && cut.sha !== promoted) {
        promoted = cut.sha;
        promotedAt = cut.at + 6 * minute;
      }
    }
    // For a stretch, leave the watch on the previous tip so a refreshed ledger cannot dispatch ahead of classification.
    const holdWatch = cycle >= 30 && cycle < 45;
    const watchedTip = holdWatch ? (mainline.at(-2) ?? mainline[0]!) : mainline.at(-1)!;

    const result = await promotionCycle(state, liveReads(), { now, everyMinutes, intervalMs: cycleMs, watchedTip });
    state = promotionStateSchema.parse(result.state);
    if (result.dispatched) settlements++;
    if (/has not classified the base branch tip/.test(state.reason ?? '')) watchWaits++;
  }

  assert.ok(state, 'the day left a promotion state');
  // A lag tip ahead of whatever the ledger last named: summary drops the up-to-date claim and names both SHAs.
  const ledgerTip = state.mainSha ?? promoted;
  const lagTip = sha('lag-ahead');
  const mismatch = observedPromotionStatus({
    ...state,
    mainSha: ledgerTip,
    promotedSha: ledgerTip,
    reason: promotionUpToDateReason,
    ledgerReadAt: iso(now - minute),
  }, { tip: lagTip, awaiting: pending, now, intervalMs: cycleMs });
  assert.doesNotMatch(mismatch.reason ?? '', /Production runs the base branch tip/, 'mismatch never keeps the up-to-date claim');
  assert.ok(mismatch.attention, 'mismatch raises attention naming the tips');
  assert.match(mismatch.attention!.text, new RegExp(ledgerTip.slice(0, 12)));
  assert.match(mismatch.attention!.text, new RegExp(lagTip.slice(0, 12)));
  assert.doesNotMatch(mismatch.attention!.text, /past its .*read window/, 'inside the window the stuck diagnosis stays off');

  // Disabled stretch: promotion off retains the ledger; summary names tips, never a stuck-drive restart.
  const off = await promotionCycle(state, liveReads(), { now: now + cycleMs, everyMinutes: 0, intervalMs: cycleMs });
  state = promotionStateSchema.parse(off.state);
  assert.equal(state.reason, promotionOffReason);
  const lagWhileOff = sha('lag-while-off');
  const disabled = observedPromotionStatus({
    ...state,
    ledgerReadAt: iso(now - 20 * minute),
    mainSha: state.mainSha ?? promoted,
    promotedSha: state.promotedSha ?? promoted,
  }, { tip: lagWhileOff, awaiting: pending, now: now + cycleMs, intervalMs: cycleMs });
  assert.ok(disabled.attention, 'disabled promotion raises the neutral mismatch attention');
  assert.match(disabled.attention.text, new RegExp(lagWhileOff.slice(0, 12)));
  assert.doesNotMatch(`${disabled.attention.text} ${disabled.attention.next}`, /past its .*read window|systemctl/, 'never a stuck-drive restart');
  assert.ok((disabled.reason ?? '').startsWith(promotionOffReason));
  assert.match(disabled.reason ?? '', new RegExp(lagWhileOff.slice(0, 12)));
  assert.doesNotMatch(disabled.reason ?? '', /Production runs the base branch tip/);

  assert.ok(settlements >= 2, `at least two promote dispatches across the day: ${settlements}`);
  assert.ok(watchWaits >= 1, `the watch gate held at least one refreshed tip: ${watchWaits}`);
  assert.ok(ledgerReads <= cycles + settlements + 5, `ledger reads stay bounded (${ledgerReads} over ${cycles} cycles)`);
  assert.ok(runReads <= cycles + 5, `run reads stay bounded (${runReads} over ${cycles} cycles)`);
  assert.equal(dispatches, settlements, 'every dispatch was counted');
  assert.ok((state.candidates?.length ?? 0) <= promotionCandidatesListed, 'candidate list stays bounded');
  assert.ok(dispatches < cycles / 3, `dispatches stay sparse against cycles (${dispatches}/${cycles})`);

  // Production at the tip records the up-to-date reason only when the lag tip agrees.
  const caughtUp = await promotionCycle(
    promotionStateSchema.parse({ ...state, inFlight: false, mainSha: promoted, promotedSha: promoted, reason: null }),
    {
      ledger: async () => ({ mainSha: promoted, promotedSha: promoted, promotedAt: iso(promotedAt), behind: 0, candidates: [] }),
      runs: async () => [],
      dispatch: async () => { throw new Error('no dispatch while caught up'); },
    },
    { now: now + 2 * cycleMs + promotionLedgerReadMs, everyMinutes, intervalMs: cycleMs, watchedTip: promoted },
  );
  assert.equal(promotionStateSchema.parse(caughtUp.state).reason, promotionUpToDateReason);
  const agree = observedPromotionStatus(caughtUp.state, { tip: promoted, awaiting: pending, now: now + 3 * cycleMs, intervalMs: cycleMs });
  assert.equal(agree.attention, null, 'agreeing tips raise no stale attention');
  assert.equal(agree.reason, promotionUpToDateReason);
});
