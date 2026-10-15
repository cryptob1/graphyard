// Concern: GY-1764 — the loop's report of each item's planned mechanical round to the review gate.
import type { Work } from '../model.js';
import { bindingApproval } from '../model/carry.js';
import { mechanicalHoldUntil, mechanicalPlanFreshMs, mechanicalRoundStartMs } from '../mechanical-findings.js';
import type { FaultKind } from '../model/fault-classes.js';
import { deliveredMeanwhile } from './decision-reads.js';
import { detailChanged } from './decision-text.js';
import { type DaemonState, message } from './state.js';

type Plan = { key: string; head: string; pr?: number; epoch?: number; reviewId: number };
/** The approvals a ledger read has answered for: planned, or settled otherwise (follow-ups filed, a fresh read present, a fallback), so a plan still owed is never reported past the ledger's answer. */
export type AnsweredApproval = { key: string; reviewId: number };
type LedgerRead = { answered?: readonly AnsweredApproval[] };
type Effects = { recordMechanicalPlan?: (item: Work, plan: { reviewId: number; head: string } | null, answered?: { reviewId: number; head: string }) => Promise<unknown>; mechanicalFixes?: unknown };
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
 * The approvals a ledger read has answered for — planned, or settled otherwise (follow-ups filed, a fresh read
 * present, a fallback or an applied round). The loop reports a plan for exactly the approvals no record answers,
 * so a head is held from the moment its approval is observed until the ledger answers, and never past it.
 */
export function answeredMechanicalReviews(records: readonly { key: string; verdict?: { state?: string; reviewId?: number }; followUps?: unknown; freshRead?: unknown; mechanicalFix?: unknown }[]): AnsweredApproval[] {
  return records.flatMap(record => record.verdict?.state === 'APPROVED' && typeof record.verdict.reviewId === 'number' && !!record.verdict.reviewId && (record.mechanicalFix || record.followUps || record.freshRead) ? [{ key: record.key, reviewId: record.verdict.reviewId }] : []);
}

/**
 * The observed approval the loop reports a plan for while it has reported none: the approval binding the candidate
 * that names mechanical findings (the same one the review gate reads), inside its round's window. The ledger's plan
 * is what asks for the round; this only holds the head from the approval's observation to the loop's first report.
 */
function owedMechanicalPlan(item: Work, clock: number): { reviewId: number; head: string } | null {
  const approval = bindingApproval(item);
  const review = approval && item.observation?.reviews.find(entry => entry.state === 'APPROVED' && entry.sha === approval.sha && typeof entry.id === 'number' && entry.id > 0 && (entry.mechanical ?? 0) > 0 && !!entry.submittedAt);
  if (!review || !item.candidate) return null;
  return clock < Date.parse(review.submittedAt!) + mechanicalRoundStartMs ? { reviewId: review.id as number, head: item.candidate.sha } : null;
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
 *
 * GY-1814: the gate holds an approval naming mechanical findings from its observation (mechanical-findings.ts), so
 * between the cycle the approval was observed and the ledger pass that plans it — the head can merge inside one
 * observation job — the loop reports the observed approval itself as the plan. The provisional report stands only
 * while the ledger has not answered the approval (`answered`, which mechanical-fixes reads carry): an approval the
 * ledger answered without a plan is cleared exactly as before, and a read that fails or an effects wiring without
 * the answered list answers everything, so the gate never holds what nothing backs (GY-1764).
 */
export async function reportMechanicalPlans(work: readonly Work[], plans: readonly Plan[], effects: Effects, clock: number, sink: PlanReportSink, snapshot?: LedgerRead | null) {
  const unreported = new Set<string>();
  if (!effects.recordMechanicalPlan || !effects.mechanicalFixes) return unreported;
  let answered: readonly AnsweredApproval[] | null = null, answeredKnown = false;
  for (const item of work) {
    if (item.stage === 'done' || !item.candidate) continue;
    const plan = plans.find(entry => entry.key === item.key && entry.head === item.candidate!.sha && entry.pr === item.candidate!.pr && entry.epoch === item.epoch);
    let wanted = plan ? { reviewId: plan.reviewId, head: plan.head } : null;
    // The provisional report of an approval the ledger has not answered — or, once it answered none, the
    // clear that releases the gate's hold over it: either is written over an item that reports nothing.
    const owed = !plan ? owedMechanicalPlan(item, clock) : null;
    if (owed) {
      // One ledger snapshot decides plan and answer together (the cycle's own read when it passes it), so a transition between two reads never pairs an old plan with a new answer.
      if (answered === null) ({ known: answeredKnown, answered } = snapshot !== undefined ? { known: !!snapshot && snapshot.answered !== undefined, answered: snapshot?.answered ?? [] } : await (effects.mechanicalFixes as () => Promise<LedgerRead>)().then(
        read => ({ known: read.answered !== undefined, answered: read.answered ?? [] }), () => ({ known: false, answered: [] })));
      wanted = answeredKnown && !answered.some(entry => entry.key === item.key && entry.reviewId === owed.reviewId) ? owed : null;
    }
    const held = item.mechanicalPlan ?? null;
    // A clear is written only over a plan that stood or an approval the gate may still hold: rewriting the
    // absence would churn every never-planned item each cycle, and `mechanicalPlan` null is the loop's
    // standing answer the gate reads.
    if (!wanted && !held && !owed) continue;
    if (wanted?.reviewId === held?.reviewId && wanted?.head === held?.head && held && clock - Date.parse(held.at) < mechanicalPlanFreshMs) continue;
    let failure: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) { try { await effects.recordMechanicalPlan(item, wanted, wanted ? undefined : (owed ?? (held ? { reviewId: held.reviewId, head: held.head } : undefined))); failure = null; break; } catch (error) { failure = error; } }
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
    // plan the ledger ceased to carry — is self-healing (the next cycle writes it, and whatever the write does the hold
    // lapses at `mechanicalPlanFreshMs`, or for an approval inside its round at that round's window, GY-1814), so it stays a
    // visible failed action but counts no decision fault. The detail names that later release when it applies (Codex, PR #1215).
    const fresh = !wanted || (wanted.reviewId === held?.reviewId && wanted.head === held?.head);
    const until = mechanicalHoldUntil(item, clock);
    await sink.fail(item, `Could not report ${item.key}'s mechanical plan (${wanted ? `review ${wanted.reviewId} on ${wanted.head.slice(0, 12)}` : 'none'}): ${message(failure)}; the review gate drops the hold once its last confirmation passes ${Math.round(mechanicalPlanFreshMs / 60_000)} minutes old${until ? `, except over an approval still inside its mechanical round, which it holds until a report lands or ${new Date(until).toISOString()}` : ''}`, !fresh);
  }
  return unreported;
}
