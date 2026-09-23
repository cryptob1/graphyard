import type { ExhaustionRecord } from './capacity.js';
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
// submission — is expected lifecycle, not an abandoned assignment. The same holds for a lapse
// the control plane itself caused and already recorded: the worker reported `blocked` for that
// epoch and stopped awaiting the operator, an admin attested with `rework` or
// `recover-containment --previous-worker-stopped` that it stopped the worker, or the loop
// recorded that the attempt's provider account ran out of quota mid-session. Only an epoch
// with no bound submission, no carried blocked report, no attestation and no exhaustion record
// was lost while its work was unfinished — a worker that silently vanished — and only that
// raises the concern.
export type LeaseLapse = 'expired' | 'lost';
export type LeaseLapseCause = 'submitted' | 'blocked-awaiting-operator' | 'stopped-by-attestation' | 'exhausted-capacity';
export const attestationKinds = ['blocked', 'stopped-worker'] as const;
export type AttestationKind = typeof attestationKinds[number];
/**
 * One ledger entry that explains why a lease for `epoch` ended without its worker finishing: the
 * worker's own `blocked` report (withdrawn by a later `blocked GY-N EPOCH -` for the same epoch),
 * or the admin's stopped-worker attestation carried by `rework` or `recover-containment`. It is
 * read back from the append-only events ledger, never asserted by a client.
 */
export interface Attestation { kind: AttestationKind; source: 'blocked' | 'rework' | 'recover-containment'; epoch: number; actor: string; at: string; reason: string; seq: number }
export interface LedgerEntry { seq: number; actor: string; kind: string; at: string; details?: unknown; workEpoch?: number }
export function attestationsFromLedger(entries: LedgerEntry[]): Attestation[] {
  const result: Attestation[] = [];
  for (const entry of [...entries].sort((a, b) => a.seq - b.seq)) {
    const details = (entry.details ?? {}) as Record<string, unknown>;
    if (entry.kind === 'blocked') {
      const epoch = details.epoch;
      if (!Number.isInteger(epoch)) continue;
      // The worker's latest word for the epoch stands: a cleared blocker withdraws the report.
      const carried = result.findIndex(item => item.kind === 'blocked' && item.epoch === epoch);
      if (carried >= 0) result.splice(carried, 1);
      if (typeof details.reason === 'string') result.push({ kind: 'blocked', source: 'blocked', epoch: epoch as number, actor: entry.actor, at: entry.at, reason: details.reason, seq: entry.seq });
    } else if ((entry.kind === 'rework' || entry.kind === 'recover') && details.previousWorkerStopped === true && Number.isInteger(entry.workEpoch)) {
      result.push({ kind: 'stopped-worker', source: entry.kind === 'rework' ? 'rework' : 'recover-containment', epoch: entry.workEpoch!, actor: entry.actor, at: entry.at, reason: typeof details.reason === 'string' ? details.reason : '', seq: entry.seq });
    }
  }
  return result;
}
export function attestationFor(attestations: Attestation[], epoch: number, kind?: AttestationKind): Attestation | null {
  return attestations.find(item => item.epoch === epoch && (!kind || item.kind === kind)) ?? null;
}
export function submittedEpoch(work: Pick<Work, 'submission'>, epoch: number) { return !!work.submission && work.submission.epoch === epoch; }
/**
 * The attempt's own provider-exhaustion record, when the account it ran on ran out mid-work.
 *
 * It is written by the one audited transaction that also ends the attempt (`POST
 * /api/work/:id/capacity`, coordinator only, appended to the ledger as `capacity.exhausted`), so
 * it says the same thing an attestation says: the control plane knows why this worker stopped.
 * The lease usually ends in that same transaction — but the loop reads a session's output on its
 * own cadence, so an expiry reconciled before the report arrives raises a lease-loss for an
 * attempt whose end is already explained. That is a settlement, not a decision for anybody.
 */
export function workerExhaustion(work: Pick<Work, 'capacity'>, epoch: number): ExhaustionRecord | null {
  return (work.capacity?.exhaustions ?? []).find(entry => entry.role === 'worker' && entry.epoch === epoch) ?? null;
}
/** Why a lapse of `lease` is expected lifecycle, or null when the worker silently vanished. */
export function leaseLapseCause(work: Pick<Work, 'submission' | 'capacity'>, lease: Pick<Lease, 'epoch'>, attestations: Attestation[] = []): { cause: LeaseLapseCause; attestation: Attestation | null; exhaustion?: ExhaustionRecord } | null {
  if (submittedEpoch(work, lease.epoch)) return { cause: 'submitted', attestation: null };
  const blocked = attestationFor(attestations, lease.epoch, 'blocked');
  if (blocked) return { cause: 'blocked-awaiting-operator', attestation: blocked };
  const stopped = attestationFor(attestations, lease.epoch, 'stopped-worker');
  if (stopped) return { cause: 'stopped-by-attestation', attestation: stopped };
  const exhausted = workerExhaustion(work, lease.epoch);
  if (exhausted) return { cause: 'exhausted-capacity', attestation: null, exhaustion: exhausted };
  return null;
}
export function classifyLeaseLapse(work: Pick<Work, 'submission' | 'capacity'>, lease: Pick<Lease, 'epoch'>, attestations: Attestation[] = []): LeaseLapse { return leaseLapseCause(work, lease, attestations) ? 'expired' : 'lost'; }
// A standing lease-loss raised for an epoch that already had its candidate bound was
// recorded before post-submission expiry stopped being treated as an incident, and one
// raised by the control plane (actor `graphyard`) for an epoch whose lapse a blocked report, a
// stopped-worker attestation or a recorded capacity exhaustion explains never needed a human
// either. All of them are settled by reconciliation with an audited note naming the cause
// rather than by a human: an escalation reaches a person only when nothing on the record says
// why the attempt ended.
export const leaseLossAutoSettlement = 'auto-settled: submitted before expiry';
export function leaseLossSettlementNote(cause: LeaseLapseCause, attestation: Attestation | null, exhaustion: ExhaustionRecord | null = null) {
  if (cause === 'submitted') return leaseLossAutoSettlement;
  if (cause === 'exhausted-capacity') return `auto-settled: the ${exhaustion?.profile ?? 'worker'} account ${exhaustion?.account ?? 'it ran on'} reported no quota left for epoch ${exhaustion?.epoch} (recorded by ${exhaustion?.recordedBy ?? 'the loop'} at ${exhaustion?.at}; ${exhaustion?.resetsAt ? `resets ${exhaustion.resetsAt}` : 'no reset time given'}), which is why the attempt ended`;
  const source = attestation ? ` (${attestation.source} by ${attestation.actor} at ${attestation.at})` : '';
  return cause === 'blocked-awaiting-operator' ? `auto-settled: blocked report for epoch ${attestation?.epoch} explains the lapse${source}`
    : `auto-settled: stopped-worker attestation for epoch ${attestation?.epoch} explains the lapse${source}`;
}
export interface LeaseLossSettlement { escalation: Escalation; epoch: number; cause: LeaseLapseCause; attestation: Attestation | null; exhaustion?: ExhaustionRecord; note: string }
export function settleableLeaseLoss(work: Pick<Work, 'submission' | 'capacity' | 'escalation' | 'escalations'>, attestations: Attestation[] = []): LeaseLossSettlement[] {
  const settlements: LeaseLossSettlement[] = [];
  for (const escalation of standingEscalations(work)) {
    const epoch = leaseLossEpoch(escalation);
    if (epoch === null) continue;
    // A lead-raised concern is never settled from the ledger or from the exhaustion record: only
    // the lapse the control plane itself raised is explained by what the control plane wrote. A
    // bound submission explains the epoch whoever raised it, and settles it as it always has.
    const explained = leaseLapseCause(work, { epoch }, escalation.actor === 'graphyard' ? attestations : []);
    if (explained && (escalation.actor === 'graphyard' || explained.cause === 'submitted'))
      settlements.push({ escalation, epoch, ...explained, note: leaseLossSettlementNote(explained.cause, explained.attestation, explained.exhaustion ?? null) });
  }
  return settlements;
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
// An unresolved escalation refuses delivery. Only an operator resolves one — a
// declared human, or for a control-plane-raised lease-loss an admin citing the
// ledger attestation — so no lead or automated path can deliver past it.
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
