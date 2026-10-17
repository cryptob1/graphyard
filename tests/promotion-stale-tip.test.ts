import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promotionCycle, promotionFrozenReason, promotionLedgerReadMs, promotionOffReason, promotionUpToDateReason, promotionWorkflow, type PromotionLedger, type PromotionReads, type PromotionRun } from '../src/daemon/deployment.js';
import { observedPromotionStatus, promotionSummaryWithLag } from '../src/daemon/promotion-stale.js';
import type { AttentionItem } from '../src/master/attention.js';
import { promotionStateSchema, type PromotionState } from '../src/daemon/state.js';

// GY-1894: the promotion cycle answered at its ledger check — `mainSha === promotedSha` — before it
// read the workflow's runs, so a state written while a candidate was in flight carried
// `inFlight: true` past the run's conclusion (the early return skips the runs read that clears it),
// and a merge that landed behind the promotion the candidate had just recorded sat behind a recorded
// 'Production runs the base branch tip; nothing to promote' while `master status` reported a
// candidate in validation and the release lag named the delivery awaiting promotion. The cycle now
// settles an in-flight flag against the runs before it concludes nothing to promote, and master
// status's promotion summary raises attention naming both SHAs and drops the up-to-date claim whenever
// the lag tip differs from the ledger while deliveries wait — a read-window allowance never preserves
// a known false claim. Past the window the attention is the stuck drive; intentionally disabled
// promotion stays truthful about the tips with no stuck-drive diagnosis.
// The instants below are explicit `now` arguments to a pure cycle; the file never reads the wall clock.

const promoSha = (seed: string) => seed.repeat(40).slice(0, 40);
const minute = 60_000;
const T = Date.parse('2026-10-17T09:20:00Z');
const iso = (at: number) => new Date(at).toISOString();
const PROMOTED = promoSha('a'), MOVED = promoSha('b'), LAG_TIP = promoSha('c');
const concludedRun = (): PromotionRun[] => [{ status: 'completed', createdAt: iso(T - 9 * minute), event: 'workflow_dispatch', headSha: PROMOTED }];

/** The state the stuck cycle wrote: production at the tip by a promotion its run had just recorded, the flag still up. */
const stuckState = (overrides: Partial<PromotionState> = {}) => promotionStateSchema.parse({
  checkedAt: iso(T), mainSha: PROMOTED, promotedSha: PROMOTED, promotedAt: iso(T - 8 * minute), behind: 0, ledgerReadAt: iso(T),
  inFlight: true, runsReadAt: iso(T - 11 * minute), dispatchedAt: iso(T - 11 * minute), lastDispatchAt: iso(T - 11 * minute), cutSha: PROMOTED,
  nextDueAt: null, reason: promotionUpToDateReason, candidates: [], ...overrides,
});

function stub(ledger: PromotionLedger, runs: PromotionRun[]) {
  const state = { ledger, runs, dispatches: 0, reads: 0 };
  const reads: PromotionReads = {
    ledger: async () => { state.reads++; return { ...state.ledger, candidates: state.ledger.candidates ?? [] }; },
    runs: async () => state.runs,
    dispatch: async () => { state.dispatches++; },
  };
  return { state, reads };
}

test('unit:promotion-reads-moved-tip-after-promotion — a promotion cycle whose previous state carried an in-flight flag reads the workflow\'s runs before it concludes nothing to promote: a merge that landed behind a promotion the candidate just recorded is dispatched within one ledger read window, not held behind a stuck flag', async () => {
  const every = 10;
  // The ledger read the window grants, once promotionLedgerReadMs after ledgerReadAt, returns the moved tip: the cycle dispatches promote=true and never answers nothing-to-promote.
  // This block's stubbed ledger already names the moved tip, so it exercises the moved-tip dispatch itself; the regression the fix answers is the block below —
  // there the ledger is still inside its window and only the runs read can clear the carried flag, which the early return used to skip.
  {
    const { state, reads } = stub({ mainSha: MOVED, promotedSha: PROMOTED, promotedAt: iso(T - 8 * minute), behind: 1 }, concludedRun());
    const result = await promotionCycle(stuckState(), reads, { now: T + promotionLedgerReadMs, everyMinutes: every, intervalMs: 20_000 });
    const parsed = promotionStateSchema.parse(result.state);
    assert.equal(result.dispatched, true, 'the moved tip is cut');
    assert.equal(state.dispatches, 1);
    assert.match(parsed.reason ?? '', new RegExp(`^Dispatched ${promotionWorkflow} with promote=true`));
    assert.doesNotMatch(parsed.reason ?? '', /nothing to promote/);
  }
  // The same while the ledger is still inside its window: the carried flag is settled by the runs read,
  // its conclusion re-reads the ledger at once, and the merge that is already on main rides out inside the window.
  {
    let reads = 0;
    const cycleReads = {
      ledger: async () => { reads++; return { mainSha: MOVED, promotedSha: PROMOTED, promotedAt: iso(T - 30_000), behind: 1, candidates: [] }; },
      runs: async () => concludedRun(),
      dispatch: async () => {},
    } as unknown as PromotionReads;
    const result = await promotionCycle(stuckState(), cycleReads, { now: T + minute, everyMinutes: every, intervalMs: 20_000 });
    const parsed = promotionStateSchema.parse(result.state);
    assert.equal(reads, 1, 'the concluded candidate re-read the ledger at once');
    assert.equal(result.dispatched, true, 'the merge is cut inside the window, not a window later');
    assert.equal(parsed.mainSha, MOVED);
    assert.doesNotMatch(parsed.reason ?? '', /nothing to promote/);
  }
  // No merge yet: the flag settles to false and the state says nothing to promote consistently, never stuck in flight and never re-cut.
  {
    const { state, reads } = stub({ mainSha: PROMOTED, promotedSha: PROMOTED, promotedAt: iso(T - 8 * minute), behind: 0 }, concludedRun());
    const result = await promotionCycle(stuckState(), reads, { now: T + minute, everyMinutes: every, intervalMs: 20_000 });
    const parsed = promotionStateSchema.parse(result.state);
    assert.equal(result.dispatched, false);
    assert.equal(parsed.inFlight, false, 'the flag the runs read settled is recorded cleared');
    assert.equal(parsed.reason, promotionUpToDateReason);
    // And the next cycle, the flag down and the ledger fresh, goes back to the cheap answer without reading runs again.
    const next = await promotionCycle(parsed, reads, { now: T + 2 * minute, everyMinutes: every, intervalMs: 20_000 });
    assert.equal(state.reads, 1, 'no runs read while nothing is in flight and the ledger is fresh');
    assert.equal(promotionStateSchema.parse(next.state).reason, promotionUpToDateReason);
  }
  // After an in-flight conclusion refreshes the ledger to a tip the watch has not classified, the cycle
  // re-applies the watched-tip gate and does not dispatch that unclassified tip in the same cycle.
  {
    let dispatches = 0;
    const WATCHED = PROMOTED;
    const cycleReads = {
      ledger: async () => ({ mainSha: MOVED, promotedSha: PROMOTED, promotedAt: iso(T - 30_000), behind: 1, candidates: [] }),
      runs: async () => concludedRun(),
      dispatch: async () => { dispatches++; },
    } as unknown as PromotionReads;
    const result = await promotionCycle(stuckState(), cycleReads, {
      now: T + minute, everyMinutes: every, intervalMs: 20_000, watchedTip: WATCHED,
    });
    const parsed = promotionStateSchema.parse(result.state);
    assert.equal(dispatches, 0, 'an unclassified refreshed tip is not dispatched');
    assert.equal(result.dispatched, false);
    assert.equal(parsed.mainSha, MOVED);
    assert.match(parsed.reason ?? '', /has not classified the base branch tip/);
    assert.match(parsed.reason ?? '', new RegExp(MOVED.slice(0, 12)));
  }
  // The same sequence under an active freeze: the refreshed tip waits; no dispatch rides out ahead of the watch.
  {
    let dispatches = 0;
    const frozen = { sha: promoSha('f'), since: iso(T - minute) };
    const cycleReads = {
      ledger: async () => ({ mainSha: MOVED, promotedSha: PROMOTED, promotedAt: iso(T - 30_000), behind: 1, candidates: [] }),
      runs: async () => concludedRun(),
      dispatch: async () => { dispatches++; },
    } as unknown as PromotionReads;
    const result = await promotionCycle(stuckState(), cycleReads, {
      now: T + minute, everyMinutes: every, intervalMs: 20_000, frozen, watchedTip: PROMOTED,
    });
    assert.equal(dispatches, 0);
    assert.equal(result.dispatched, false);
    assert.equal(promotionStateSchema.parse(result.state).reason, promotionFrozenReason(frozen));
  }
});

test('unit:promotion-reason-agrees-with-release-lag — master status\'s promotion summary raises attention naming both SHAs when the lag names a delivery awaiting promotion on a base tip the recorded ledger does not name, and the reason never claims the promoted SHA is the base tip while they differ', () => {
  // The incident: the ledger naming the promoted SHA the base tip, while the checkout's base ref has moved and a delivery awaits promotion on the move.
  const pastWindow = { ledgerReadAt: iso(T - 20 * minute), checkedAt: iso(T - minute) };
  const summary = observedPromotionStatus(stuckState(pastWindow), { tip: LAG_TIP, awaiting: ['GY-1872'], now: T });
  assert.ok(summary.attention, 'the stuck drive is named');
  assert.equal(summary.attention!.subject, 'promotion');
  assert.match(summary.attention!.text, new RegExp(PROMOTED.slice(0, 12)), 'the recorded ledger tip is named');
  assert.match(summary.attention!.text, new RegExp(LAG_TIP.slice(0, 12)), 'the base tip the lag read is named');
  assert.match(summary.attention!.text, /GY-1872/, 'the delivery awaiting promotion is named');
  assert.match(summary.attention!.text, /past its .*read window/, 'past the window the stuck drive is named');
  assert.doesNotMatch(summary.reason ?? '', /Production runs the base branch tip/, 'the up-to-date claim gives way on a moved tip');
  assert.match(summary.reason ?? '', new RegExp(PROMOTED.slice(0, 12)));
  assert.match(summary.reason ?? '', new RegExp(LAG_TIP.slice(0, 12)));
  assert.match(summary.reason ?? '', /GY-1872/);
  // Inside the read window: attention still names both SHAs (AC-2), the up-to-date claim is gone, and the
  // stuck-drive / restart diagnosis is reserved for a ledger past its window.
  const inWindow = observedPromotionStatus(stuckState({ ledgerReadAt: iso(T - minute), checkedAt: iso(T - minute) }), { tip: LAG_TIP, awaiting: ['GY-1872'], now: T });
  assert.ok(inWindow.attention, 'an observed mismatch raises attention inside the window too');
  assert.match(inWindow.attention!.text, new RegExp(PROMOTED.slice(0, 12)));
  assert.match(inWindow.attention!.text, new RegExp(LAG_TIP.slice(0, 12)));
  assert.doesNotMatch(inWindow.attention!.text, /past its .*read window/, 'inside the window the drive is not blamed as stuck');
  assert.doesNotMatch(inWindow.attention!.next ?? '', /systemctl|dispatch .* by hand/, 'no restart or manual-dispatch instruction while the drive is on schedule');
  assert.doesNotMatch(inWindow.reason ?? '', /Production runs the base branch tip/, 'a known false up-to-date claim never stands');
  assert.match(inWindow.reason ?? '', new RegExp(PROMOTED.slice(0, 12)));
  assert.match(inWindow.reason ?? '', new RegExp(LAG_TIP.slice(0, 12)));
  // A moved tip with nothing awaiting promotion is not the stuck drive.
  const nothingAwaiting = observedPromotionStatus(stuckState(pastWindow), { tip: LAG_TIP, awaiting: [], now: T });
  assert.equal(nothingAwaiting.attention, null);
  // The stuck-drive bound is the loop's own ledger window at its interval (`promotionReadWindows`):
  // at a 300s interval the loop keeps its ledger 15 minutes, so a ledger six minutes old on a moved
  // tip is still on schedule for the restart diagnosis — but AC-2 still names both SHAs and drops the
  // up-to-date claim.
  const longInterval = observedPromotionStatus(stuckState({ ledgerReadAt: iso(T - 6 * minute), checkedAt: iso(T - minute) }), { tip: LAG_TIP, awaiting: ['GY-1872'], now: T, intervalMs: 300_000 });
  assert.ok(longInterval.attention, 'mismatch attention fires inside the interval-granted window');
  assert.doesNotMatch(longInterval.attention!.text, /past its .*read window/, 'inside the interval-granted window the stuck diagnosis stays off');
  assert.doesNotMatch(longInterval.reason ?? '', /Production runs the base branch tip/);
  const pastLongWindow = observedPromotionStatus(stuckState({ ledgerReadAt: iso(T - 16 * minute), checkedAt: iso(T - minute) }), { tip: LAG_TIP, awaiting: ['GY-1872'], now: T, intervalMs: 300_000 });
  assert.ok(pastLongWindow.attention, 'past the interval-granted window the stuck drive is named');
  assert.match(pastLongWindow.attention!.text, /15-minute read window/, 'the window named is the interval-granted one');
  // `promotionSummaryWithLag` passes the interval through, so master status judges by the loop's own window.
  const lagAttention: AttentionItem[] = [];
  promotionSummaryWithLag(stuckState({ ledgerReadAt: iso(T - 6 * minute), checkedAt: iso(T - minute) }), { baseTip: LAG_TIP, promotion: { pending: ['GY-1872'] } }, lagAttention, T, 300_000);
  assert.equal(lagAttention.length, 1, 'the summary inside the interval-granted window still raises mismatch attention');
  assert.doesNotMatch(lagAttention[0]!.text, /past its .*read window/);
  promotionSummaryWithLag(stuckState({ ledgerReadAt: iso(T - 16 * minute), checkedAt: iso(T - minute) }), { baseTip: LAG_TIP, promotion: { pending: ['GY-1872'] } }, lagAttention, T, 300_000);
  assert.equal(lagAttention.length, 2, 'the summary past the interval-granted window raises the stuck-drive attention');
  assert.match(lagAttention[1]!.text, /15-minute read window/);
  // Intentionally disabled promotion retains its ledger: both tips are named in reason and attention, no stuck-drive / restart alert.
  const disabled = observedPromotionStatus(stuckState({
    ...pastWindow, reason: promotionOffReason, inFlight: false,
  }), { tip: LAG_TIP, awaiting: ['GY-1872'], now: T });
  assert.ok(disabled.attention, 'disabled promotion still raises the neutral mismatch attention');
  assert.match(disabled.attention.text, new RegExp(PROMOTED.slice(0, 12)));
  assert.match(disabled.attention.text, new RegExp(LAG_TIP.slice(0, 12)));
  assert.doesNotMatch(`${disabled.attention.text} ${disabled.attention.next}`, /past its .*read window|systemctl|restart it|dispatch .* by hand/, 'never a stuck-drive / restart diagnosis');
  const offAttention: AttentionItem[] = [];
  promotionSummaryWithLag(stuckState({ ...pastWindow, reason: promotionOffReason, inFlight: false }), { baseTip: LAG_TIP, promotion: { pending: ['GY-1872'] } }, offAttention, T);
  assert.equal(offAttention.length, 1, 'promotionSummaryWithLag appends the disabled mismatch attention');
  assert.ok((disabled.reason ?? '').startsWith(promotionOffReason), 'disabled reason stays named');
  assert.match(disabled.reason ?? '', new RegExp(PROMOTED.slice(0, 12)));
  assert.match(disabled.reason ?? '', new RegExp(LAG_TIP.slice(0, 12)));
  assert.match(disabled.reason ?? '', /GY-1872/);
  assert.doesNotMatch(disabled.reason ?? '', /Production runs the base branch tip/);
  // A reason that makes no claim about the tip stands as written; the attention still names the disagreement.
  const validating = stuckState({ ...pastWindow, reason: 'A release candidate is still in validation; the next promotion is dispatched as soon as it concludes' });
  const otherReason = observedPromotionStatus(validating, { tip: LAG_TIP, awaiting: ['GY-1872'], now: T });
  assert.ok(otherReason.attention);
  assert.equal(otherReason.reason, validating.reason, 'a reason that claims nothing about the tip is not rewritten');
  // Local mode records its own up-to-date wording (promotion-local.ts); the false claim gives way there too.
  const localReason = 'Production runs the base branch tip; nothing to cut or promote';
  const localAttention: AttentionItem[] = [];
  const local = promotionSummaryWithLag(stuckState({ ...pastWindow, reason: localReason }), { baseTip: LAG_TIP, promotion: { pending: ['GY-1872'] } }, localAttention, T);
  assert.equal(localAttention.length, 1, 'the local-mode mismatch raises attention');
  assert.match(localAttention[0]!.text, new RegExp(PROMOTED.slice(0, 12)));
  assert.match(localAttention[0]!.text, new RegExp(LAG_TIP.slice(0, 12)));
  assert.doesNotMatch(local.reason ?? '', /Production runs the base branch tip/, 'the local-mode up-to-date claim never stands on a moved tip');
  assert.match(local.reason ?? '', new RegExp(LAG_TIP.slice(0, 12)));
  // No lag read beside the summary: exactly what the loop recorded, as before.
  const unobserved = observedPromotionStatus(stuckState(pastWindow));
  assert.equal(unobserved.attention, null);
  assert.equal(unobserved.reason, promotionUpToDateReason);
});
