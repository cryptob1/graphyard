// Concern: the loop's own request of the repair lane (GY-1218).
//
// When every candidate in the merge band has been refused for the repair lane's stall bound on one
// shared reason, the merge path itself is broken, and the fix for it — approved, its required checks
// passed — is refused by the same gate. The repair lane (src/master/repair-lane.ts) exists for that
// case; nothing used to ask for it, so a master had to notice, and one handed the operator a bypass
// command instead. The loop now requests the `repair-merge` decision itself, naming the fault, and
// launches the independent approver for it like any routine decision. The approver still judges it,
// and the lane still checks every condition where the merge is made.
import type { Work } from '../model.js';
import { mergePath, repairDecisionAction, repairScopeRefusal, repairStallMs, withinMergePath } from '../master/repair-lane.js';
import type { RoutineDecision } from './decisions.js';

/** A merge-band stall: every candidate in the band refused for the stall bound on one shared reason. */
export interface MergeBandStall { reason: string; faultClass: string; since: string; band: string[] }

const gate = (work: Work, name: string) => work.gates.find(entry => entry.name === name);

/** The fault class a merge refusal names: a stale or missing GitHub read is an observation fault, anything else a merge fault. */
export const stallFaultClass = (reason: string) => /observ|stale|older than/i.test(reason) ? 'observation' : 'merge';

/** The merge band: open items with a submitted candidate that have reached the merge stage. */
export const mergeBand = (work: readonly Work[]) => work.filter(item => item.stage === 'merge' && !!item.candidate && !!item.submission);

/**
 * The band-wide stall, or null. Every band member must hold a failing merge gate entered at least
 * `repairStallMs` ago, and one refusal reason must be shared by all of them: a single item's own
 * refusal is that item's problem, not the merge path's.
 */
export function mergeBandStall(work: readonly Work[], now: number): MergeBandStall | null {
  const band = mergeBand(work);
  if (!band.length) return null;
  const refused = band.map(item => ({ item, merge: gate(item, 'merge'), since: Date.parse(item.stageEnteredAt ?? '') }));
  if (refused.some(entry => !entry.merge || entry.merge.passed || !Number.isFinite(entry.since) || now - entry.since < repairStallMs)) return null;
  const [first, ...rest] = refused;
  const reason = first.merge!.reasons.find(candidate => rest.every(entry => entry.merge!.reasons.includes(candidate)));
  if (!reason) return null;
  const since = new Date(Math.max(...refused.map(entry => entry.since))).toISOString();
  return { reason, faultClass: stallFaultClass(reason), since, band: band.map(item => item.key) };
}

/** Whether an item addresses the stall: marked a merge-path repair, or its criteria name the fault class or the shared reason. */
export function addressesStall(item: Work, stall: MergeBandStall) {
  if (item.repair === 'merge-path') return true;
  const named = new RegExp(`\\b${stall.faultClass}\\b`, 'i');
  return (item.criteria ?? []).some(criterion => named.test(criterion.text) || criterion.text.toLowerCase().includes(stall.reason.toLowerCase()));
}

/** Whether an item is an approved candidate whose required checks passed, confined to the merge path. */
export function repairCandidate(item: Work, stall: MergeBandStall) {
  return item.stage !== 'done' && !!item.candidate && !!item.submission && !!gate(item, 'review')?.passed && !!gate(item, 'test')?.passed
    && addressesStall(item, stall) && !repairScopeRefusal({ ...item, repair: 'merge-path' });
}

/**
 * The `repair-merge` decision the loop requests for `item`, or null. At most one per stall: only
 * the first repair candidate (highest priority, then oldest key) is asked for, and the binding names
 * its head and the shared reason, so the watch the loop keeps for it is the stall's one request.
 * The reason names the merge-path files the candidate repairs, which is the fault location the
 * server and the lane require it to name.
 */
export function repairTriggerDecision(item: Work, work: readonly Work[], now: number): RoutineDecision | null {
  const stall = mergeBandStall(work, now);
  if (!stall || !repairCandidate(item, stall)) return null;
  const chosen = work.filter(entry => repairCandidate(entry, stall))
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.key.localeCompare(b.key, undefined, { numeric: true }))[0];
  if (chosen?.id !== item.id) return null;
  const located = item.plannedFiles.filter(withinMergePath);
  const reason = `Every merge-band candidate (${stall.band.join(', ')}) has been refused since ${stall.since}, at least ${repairStallMs / 60_000} minutes, on one ${stall.faultClass} fault: ${stall.reason}. ${item.key} repairs it in ${located.join(', ') || mergePath.join(', ')}, is approved and has passed its required checks on head ${item.candidate!.sha.slice(0, 12)}, and is refused by the same gate, so the loop requests the repair lane for it.`;
  // The repair lane's action is not one of the routine actions the decision effect types; the
  // request path is the same, and the server judges `repair-merge` on its own precondition.
  return { action: repairDecisionAction as unknown as RoutineDecision['action'], reason: reason.slice(0, 2000), binding: `${item.candidate!.sha}:repair:${stall.faultClass}`, input: {} };
}
