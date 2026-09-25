import type { Work } from './work.js';

// Rulings that stop delivery until an authorized recovery clears them. A plan
// rejection is superseded by a later approve-plan from the same slice lead; a
// send-back is cleared only by the operator rework lifecycle, which reopens
// implementation. Ranked so a later ruling can raise, but never weaken, a hold.
export const blockingRulingActions = ['reject-plan', 'send-back'] as const;
export type BlockingRulingAction = typeof blockingRulingActions[number];
export const blockingRulingRank: Record<BlockingRulingAction, number> = { 'reject-plan': 1, 'send-back': 2 };
export function leadHoldRefusal(work: Work): string | null {
  return work.leadHold
    ? `Slice lead ${work.leadHold.leadId} ruled ${work.leadHold.action} under rule ${work.leadHold.ruleId}; delivery is blocked until the authorized recovery: ${work.leadHold.reason}`
    : null;
}
// Applied inside the ruling transaction: the hold is recorded, merge
// authorization is invalidated, and the merge gate refuses in the same write.
export function holdDelivery(work: Work, hold: NonNullable<Work['leadHold']>) {
  const standing = work.leadHold;
  // A ruling may strengthen a standing hold, but it cannot replace an
  // equal-ranked hold and thereby transfer that hold's recovery authority to a
  // different lead. The later ruling remains in append-only history.
  if (standing && blockingRulingRank[standing.action] >= blockingRulingRank[hold.action]) return false;
  const superseded = leadHoldRefusal(work);
  work.leadHold = hold;
  work.mergeAuthorization = null;
  const merge = work.gates.find(gate => gate.name === 'merge');
  const reason = leadHoldRefusal(work)!;
  if (merge) {
    merge.reasons = merge.reasons.filter(entry => entry !== superseded && entry !== reason);
    merge.reasons.push(reason);
    merge.passed = false;
  }
  return true;
}
// Clearing a hold removes its refusal from the merge gate. Merge authorization is
// not reissued here: only a full gate evaluation may mint it, so the recovery is
// fail-closed until the next evaluation confirms every other gate still passes.
export function releaseLeadHold(work: Work) {
  const reason = leadHoldRefusal(work);
  work.leadHold = null;
  const merge = work.gates.find(gate => gate.name === 'merge');
  if (!reason || !merge) return;
  merge.reasons = merge.reasons.filter(entry => entry !== reason);
  merge.passed = merge.reasons.length === 0;
}
