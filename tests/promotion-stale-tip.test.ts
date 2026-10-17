import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promotionCycle, promotionLedgerReadMs, promotionStatus, promotionUpToDateReason, promotionWorkflow, type PromotionLedger, type PromotionReads, type PromotionRun } from '../src/daemon/deployment.js';
import { promotionStateSchema, type PromotionState } from '../src/daemon/state.js';

// GY-1894: the promotion cycle answered at its ledger check — `mainSha === promotedSha` — before it
// read the workflow's runs, so a state written while a candidate was in flight carried
// `inFlight: true` past the run's conclusion (the early return skips the runs read that clears it),
// and a merge that landed behind the promotion the candidate had just recorded sat behind a recorded
// 'Production runs the base branch tip; nothing to promote' while `master status` reported a
// candidate in validation and the release lag named the delivery awaiting promotion. The cycle now
// settles an in-flight flag against the runs before it concludes nothing to promote, and master
// status's promotion summary raises attention and drops the up-to-date claim once the ledger is past
// its read window on a tip the checkout's base ref has moved past.
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
});

test('unit:promotion-reason-agrees-with-release-lag — master status\'s promotion summary raises attention naming both SHAs when the lag names a delivery awaiting promotion on a base tip the recorded ledger does not name, and the reason never claims the promoted SHA is the base tip while they differ', () => {
  // The incident: the ledger stuck past its read window naming the promoted SHA the base tip, while the checkout's base ref has moved and a delivery awaits promotion on the move.
  const pastWindow = { ledgerReadAt: iso(T - 20 * minute), checkedAt: iso(T - minute) };
  const summary = promotionStatus(stuckState(pastWindow), { tip: LAG_TIP, awaiting: ['GY-1872'], now: T });
  assert.ok(summary.attention, 'the stuck drive is named');
  assert.equal(summary.attention!.subject, 'promotion');
  assert.match(summary.attention!.text, new RegExp(PROMOTED.slice(0, 12)), 'the recorded ledger tip is named');
  assert.match(summary.attention!.text, new RegExp(LAG_TIP.slice(0, 12)), 'the base tip the lag read is named');
  assert.match(summary.attention!.text, /GY-1872/, 'the delivery awaiting promotion is named');
  assert.doesNotMatch(summary.reason ?? '', /Production runs the base branch tip/, 'the up-to-date claim gives way once the window has passed on a moved tip');
  assert.match(summary.reason ?? '', new RegExp(PROMOTED.slice(0, 12)));
  assert.match(summary.reason ?? '', new RegExp(LAG_TIP.slice(0, 12)));
  assert.match(summary.reason ?? '', /GY-1872/);
  // Inside the read window the staleness is the design: no attention, the reason as the loop wrote it.
  const inWindow = promotionStatus(stuckState({ ledgerReadAt: iso(T - minute), checkedAt: iso(T - minute) }), { tip: LAG_TIP, awaiting: ['GY-1872'], now: T });
  assert.equal(inWindow.attention, null);
  assert.equal(inWindow.reason, promotionUpToDateReason);
  // A moved tip past the window with nothing awaiting promotion is not the stuck drive.
  const nothingAwaiting = promotionStatus(stuckState(pastWindow), { tip: LAG_TIP, awaiting: [], now: T });
  assert.equal(nothingAwaiting.attention, null);
  // A reason that makes no claim about the tip stands as written; the attention still names the disagreement.
  const validating = stuckState({ ...pastWindow, reason: 'A release candidate is still in validation; the next promotion is dispatched as soon as it concludes' });
  const otherReason = promotionStatus(validating, { tip: LAG_TIP, awaiting: ['GY-1872'], now: T });
  assert.ok(otherReason.attention);
  assert.equal(otherReason.reason, validating.reason, 'a reason that claims nothing about the tip is not rewritten');
  // No lag read beside the summary: exactly what the loop recorded, as before.
  const unobserved = promotionStatus(stuckState(pastWindow));
  assert.equal(unobserved.attention, null);
  assert.equal(unobserved.reason, promotionUpToDateReason);
});
