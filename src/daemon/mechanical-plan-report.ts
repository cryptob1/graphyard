// Concern: GY-1764 — the loop's report of each item's planned mechanical round to the review gate.
import type { Work } from '../model.js';
import { mechanicalPlanFreshMs } from '../mechanical-findings.js';
import { deliveredMeanwhile } from './decision-reads.js';
import { message } from './state.js';

type Plan = { key: string; head: string; pr?: number; epoch?: number; reviewId: number };
type Effects = { recordMechanicalPlan?: (item: Work, plan: { reviewId: number; head: string } | null) => Promise<unknown>; mechanicalFixes?: unknown };

/**
 * A projection the loop last confirmed within `mechanicalPlanFreshMs` is current; an older one is re-reported, so the gate
 * never holds on evidence a failed write or ledger read left stale. A report that cannot be written is a visible, retried
 * failure (`fail` names it) and the item forms no decision from the ledger this cycle: the returned set holds those items.
 *
 * GY-1795: `fail`'s third argument says whether the failure still counts as a decision fault. A refusal naming the item
 * delivered after this cycle's snapshot is no report at all — the target is settled, the projection lapses and the next
 * snapshot shows it done — so it is not even named. A write the gate's own freshness already governs — the same plan
 * re-confirmed, or the clear of a plan the ledger ceased to carry — changes nothing the gate reads that
 * `mechanicalPlanFreshMs` does not, so it is retried without an instance; only a plan the gate would newly hold counts.
 */
export async function reportMechanicalPlans(work: readonly Work[], plans: readonly Plan[], effects: Effects, clock: number, fail: (item: Work, detail: string, counts: boolean) => Promise<void>) {
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
    if (deliveredMeanwhile(message(failure))) continue;
    // Only a plan the ledger still carries blocks the item's decision: one the ledger ceased to plan owes no round, so the decision step
    // agrees with the ledger (nothing owed) while the stale projection lapses by `mechanicalPlanFreshMs` at the gate.
    if (wanted) unreported.add(item.id);
    // GY-1795: a failed write whose content the gate's freshness governs — the same plan re-confirmed, or the clear of a
    // plan the ledger ceased to carry — is self-healing (the next cycle writes it, and the hold lapses at
    // `mechanicalPlanFreshMs` whatever the write does), so it stays a visible failed action but counts no decision fault.
    const fresh = !wanted || (wanted.reviewId === held?.reviewId && wanted.head === held?.head);
    await fail(item, `Could not report ${item.key}'s mechanical plan (${wanted ? `review ${wanted.reviewId} on ${wanted.head.slice(0, 12)}` : 'none'}): ${message(failure)}; the review gate drops the hold once its last confirmation passes ${Math.round(mechanicalPlanFreshMs / 60_000)} minutes old`, !fresh);
  }
  return unreported;
}
