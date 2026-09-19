import type { Escalation, EscalationTrigger, Lease, Work } from './work.js';

// The one sentence every path that discards an assignment writes, so the epoch a
// standing lease-loss belongs to can be read back from the record itself.
export function leaseLossReason(lease: Pick<Lease, 'owner' | 'epoch'>) { return `Worker ${lease.owner} lost lease epoch ${lease.epoch}`; }
export function leaseLossEpoch(escalation: Escalation): number | null {
  const match = escalation.trigger === 'lease-loss' ? /^Worker .+ lost lease epoch (\d+)$/.exec(escalation.reason) : null;
  return match ? Number(match[1]) : null;
}
// An implementation lease ends at `submit`: the candidate is bound and the worker's job is
// done. A lease that still lapses under that epoch — one a worker kept renewing past its
// submission — is expected lifecycle, not an abandoned assignment. Only an epoch with no
// bound submission was lost while its work was unfinished, and only that raises the concern.
export type LeaseLapse = 'expired' | 'lost';
export function submittedEpoch(work: Pick<Work, 'submission'>, epoch: number) { return !!work.submission && work.submission.epoch === epoch; }
export function classifyLeaseLapse(work: Pick<Work, 'submission'>, lease: Pick<Lease, 'epoch'>): LeaseLapse { return submittedEpoch(work, lease.epoch) ? 'expired' : 'lost'; }
// A standing lease-loss raised for an epoch that already had its candidate bound was
// recorded before post-submission expiry stopped being treated as an incident. It is
// settled by reconciliation with this audited note rather than by a human.
export const leaseLossAutoSettlement = 'auto-settled: submitted before expiry';
export function settleableLeaseLoss(work: Pick<Work, 'submission' | 'escalation' | 'escalations'>): Escalation[] {
  return standingEscalations(work).filter(entry => { const epoch = leaseLossEpoch(entry); return epoch !== null && submittedEpoch(work, epoch); });
}

// Every unresolved trigger stands on its own. A document written before
// `escalations` existed carries only the singular field, so it is read as a
// one-entry list rather than migrated in place.
export function standingEscalations(work: Pick<Work, 'escalation' | 'escalations'>): Escalation[] {
  if (work.escalations) return work.escalations;
  return work.escalation ? [work.escalation] : [];
}
function setEscalations(work: Work, escalations: Escalation[]) {
  work.escalations = escalations;
  work.escalation = escalations[0] ?? null;
}
// An unresolved escalation refuses delivery. Only a human operator can resolve
// one, so no lead or automated path can deliver past it.
export function escalationRefusals(work: Work): string[] {
  return standingEscalations(work).map(entry => `Unresolved ${entry.trigger} escalation requires operator resolution: ${entry.reason}`);
}
export function escalationRefusal(work: Work): string | null { return escalationRefusals(work)[0] ?? null; }
// A standing escalation is never overwritten, and a later distinct trigger never
// disappears behind it: each trigger is kept until it is resolved on its own, so
// resolving one concern cannot silently drop another. Raising one refuses the
// merge gate, invalidates merge authorization, and fences any in-flight merge
// execution in the same transaction, so a candidate that was already merge-ready
// cannot be delivered while it stands.
export function raiseEscalation(work: Work, escalation: Escalation) {
  const standing = standingEscalations(work);
  // One entry per trigger: a repeat of a trigger that already stands is history,
  // not a second incident, and resolution names a trigger.
  if (standing.some(entry => entry.trigger === escalation.trigger)) return false;
  setEscalations(work, [...standing, escalation]);
  work.mergeAuthorization = null;
  fenceMergeExecution(work, `Unresolved ${escalation.trigger} escalation: ${escalation.reason}`, escalation.at);
  const merge = work.gates.find(gate => gate.name === 'merge');
  if (merge) for (const reason of escalationRefusals(work)) if (!merge.reasons.includes(reason)) { merge.reasons.push(reason); merge.passed = false; }
  return true;
}
// Resolving names one standing trigger and leaves every other one standing.
export function resolveEscalation(work: Work, trigger: EscalationTrigger) {
  const standing = standingEscalations(work);
  const remaining = standing.filter(entry => entry.trigger !== trigger);
  setEscalations(work, remaining);
  return standing.length - remaining.length;
}
// An execution holds the record until it expires. Once the broker has committed it to the
// provider, only a GitHub observation may retire it: the provider outcome is unknown until
// observed, and revocation must keep refusing across that gap rather than reopen the instant
// the authority lapses while a provider call may still be in flight.
export function holdsMergeExecution(work: Pick<Work, 'mergeExecution'>, now: number) {
  const execution = work.mergeExecution;
  return !!execution && (!!execution.committingAt || Date.parse(execution.expiresAt) > now);
}
// The provider-clock wait a verification demands before the commit: the rest of the database's
// current second plus the verified offset width. The broker rebuilds it from the record when it
// resumes an execution that was verified but not yet committed.
export function providerDelayAfterVerification(verifiedAt: number, offset: { min: number; max: number }) {
  return Math.ceil((verifiedAt + 1) / 1000) * 1000 - verifiedAt + Math.ceil(offset.max - offset.min);
}
// Fencing, not cancelling: the execution row stays so its owner can still cancel
// or observe it idempotently, but no verification and no provider call may
// proceed under it. The broker re-reads this between verification and the merge
// call, so a concern raised mid-flight still stops delivery.
export function fenceMergeExecution(work: Work, reason: string, at: string) {
  if (!work.mergeExecution || work.mergeExecution.fenced) return false;
  work.mergeExecution.fenced = { reason, at };
  return true;
}
