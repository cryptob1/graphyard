// Concern: GY-1764 — the loop's report of each item's planned mechanical round to the review gate.
import type { Work } from '../model.js';
import { mechanicalPlanFreshMs } from '../mechanical-findings.js';
import { message } from './state.js';

type Plan = { key: string; head: string; pr?: number; epoch?: number; reviewId: number };
type Effects = { recordMechanicalPlan?: (item: Work, plan: { reviewId: number; head: string } | null) => Promise<unknown>; mechanicalFixes?: unknown };

/**
 * A projection the loop last confirmed within `mechanicalPlanFreshMs` is current; an older one is re-reported, so the gate
 * never holds on evidence a failed write or ledger read left stale. A report that cannot be written is a visible, retried
 * failure (`fail` names it) and the item forms no decision from the ledger this cycle: the returned set holds those items.
 */
export async function reportMechanicalPlans(work: readonly Work[], plans: readonly Plan[], effects: Effects, clock: number, fail: (item: Work, detail: string) => Promise<void>) {
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
    if (wanted || held) unreported.add(item.id);
    await fail(item, `Could not report ${item.key}'s mechanical plan (${wanted ? `review ${wanted.reviewId} on ${wanted.head.slice(0, 12)}` : 'none'}): ${message(failure)}; the review gate drops the hold once its last confirmation passes ${Math.round(mechanicalPlanFreshMs / 60_000)} minutes old`);
  }
  return unreported;
}
