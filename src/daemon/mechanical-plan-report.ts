// Concern: GY-1764 — the loop's report of each item's planned mechanical round to the review gate.
import type { Work } from '../model.js';
import { mechanicalPlanFreshMs } from '../mechanical-findings.js';
import type { FaultKind } from '../model/fault-classes.js';
import { deliveredMeanwhile } from './decision-reads.js';
import { detailChanged } from './decision-text.js';
import { type DaemonState, message } from './state.js';

type Plan = { key: string; head: string; pr?: number; epoch?: number; reviewId: number };
type Effects = { recordMechanicalPlan?: (item: Work, plan: { reviewId: number; head: string } | null) => Promise<unknown>; mechanicalFixes?: unknown };
/** Where a report's outcome goes: `fail` names a write that failed (`counts`: as a decision fault); `settle` ends what an earlier failure of the same report recorded, once delivery settled its target. */
export type PlanReportSink = { fail: (item: Work, detail: string, counts: boolean) => Promise<void>; settle: (item: Work) => Promise<void> };
type Note = (key: string, item: Work, kind: 'decision', outcome: 'done' | 'failed', detail: string, at?: number, faultKind?: FaultKind | null) => Promise<unknown>;

/**
 * The loop's sink (cycle-decisions.ts): a failed write is one `mechanical-plan:ID` action row, rewritten when its text
 * or its count changes — a stored row whose count flips under the same text would otherwise keep counting (Codex, PR
 * #1203). The run a counting row opened was no fault either once the write stops counting, or once the item is
 * delivered meanwhile — the next snapshot skips the delivered item, so nothing else would end that run inside the
 * window: its instance is dropped and its run ended, as settleHeld drops a held one (the recurrence counts the record's
 * instances, not the row's class), and the delivered item's row reads done, settled, never failed.
 */
export function planReportSink(state: Pick<DaemonState, 'actions' | 'faults'>, note: Note): PlanReportSink {
  const keyOf = (item: Work) => `mechanical-plan:${item.id}`;
  const endRun = (key: string) => { const id = state.faults.failing[key]; if (!id) return; delete state.faults.failing[key]; if (!id.startsWith('held:')) state.faults.instances = state.faults.instances.filter(entry => entry.id !== id); };
  return {
    async fail(item, detail, counts) { const key = keyOf(item), stored = state.actions[key]; if (!detailChanged(stored, detail) && !!stored?.faultClass === counts) return; if (stored?.faultClass && !counts) endRun(key); await note(key, item, 'decision', 'failed', detail, undefined, counts ? undefined : null); },
    async settle(item) { const key = keyOf(item); if (state.actions[key]?.state !== 'failed') return; endRun(key); await note(key, item, 'decision', 'done', `${item.key}'s mechanical plan report is settled: the item was delivered after the cycle's snapshot, so the write it owed has no target`, undefined, null); },
  };
}

/**
 * A projection the loop last confirmed within `mechanicalPlanFreshMs` is current; an older one is re-reported, so the gate
 * never holds on evidence a failed write or ledger read left stale. A report that cannot be written is a visible, retried
 * failure (`sink.fail` names it) and the item forms no decision from the ledger this cycle: the returned set holds those items.
 *
 * GY-1795: `fail`'s third argument says whether the failure still counts as a decision fault. A refusal naming the item
 * delivered after this cycle's snapshot is no report at all — the target is settled, the projection lapses and the next
 * snapshot shows it done — so it is not named as a failure; what an earlier failure of the same report recorded is
 * settled instead (`sink.settle`). A write the gate's own freshness already governs — the same plan re-confirmed, or the
 * clear of a plan the ledger ceased to carry — changes nothing the gate reads that `mechanicalPlanFreshMs` does not, so
 * it is retried without an instance; only a plan the gate would newly hold counts.
 */
export async function reportMechanicalPlans(work: readonly Work[], plans: readonly Plan[], effects: Effects, clock: number, sink: PlanReportSink) {
  const unreported = new Set<string>();
  if (!effects.recordMechanicalPlan || !effects.mechanicalFixes) return unreported;
  for (const item of work) {
    if (item.stage === 'done' || !item.candidate) continue;
    const plan = plans.find(entry => entry.key === item.key && entry.head === item.candidate!.sha && entry.pr === item.candidate!.pr && entry.epoch === item.epoch);
    const wanted = plan ? { reviewId: plan.reviewId, head: plan.head } : null, held = item.mechanicalPlan ?? null;
    if (wanted?.reviewId === held?.reviewId && wanted?.head === held?.head && held && clock - Date.parse(held.at) < mechanicalPlanFreshMs) continue;
    let failure: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) { try { await effects.recordMechanicalPlan(item, wanted); failure = null; break; } catch (error) { failure = error; } }
    if (!failure) continue;
    // GY-1795: the item was delivered after this cycle's snapshot, so the write can never land and the target is
    // settled — no projection to synchronize, no hold, no instance; the next snapshot reads it done (GY-1336's rule).
    // A failure an earlier cycle recorded for the same report is settled with it (Codex, PR #1203): that snapshot
    // skips the item, so nothing else would end the run it opened.
    if (deliveredMeanwhile(message(failure))) { await sink.settle(item); continue; }
    // Only a plan the ledger still carries blocks the item's decision: one the ledger ceased to plan owes no round, so the decision step
    // agrees with the ledger (nothing owed) while the stale projection lapses by `mechanicalPlanFreshMs` at the gate.
    if (wanted) unreported.add(item.id);
    // GY-1795: a failed write whose content the gate's freshness governs — the same plan re-confirmed, or the clear of a
    // plan the ledger ceased to carry — is self-healing (the next cycle writes it, and the hold lapses at
    // `mechanicalPlanFreshMs` whatever the write does), so it stays a visible failed action but counts no decision fault.
    const fresh = !wanted || (wanted.reviewId === held?.reviewId && wanted.head === held?.head);
    await sink.fail(item, `Could not report ${item.key}'s mechanical plan (${wanted ? `review ${wanted.reviewId} on ${wanted.head.slice(0, 12)}` : 'none'}): ${message(failure)}; the review gate drops the hold once its last confirmation passes ${Math.round(mechanicalPlanFreshMs / 60_000)} minutes old`, !fresh);
  }
  return unreported;
}
