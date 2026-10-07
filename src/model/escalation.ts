import type { ExhaustionRecord } from './capacity.js';
import type { Escalation, EscalationTrigger, Lease, Work } from './work.js';

// The one sentence every path that discards an assignment writes, so the epoch a
// standing lease-loss belongs to can be read back from the record itself.
export function leaseLossReason(lease: Pick<Lease, 'owner' | 'epoch'>) { return `Worker ${lease.owner} lost lease epoch ${lease.epoch}`; }
export function leaseLossEpoch(escalation: Escalation): number | null {
  const match = escalation.trigger === 'lease-loss' ? /^Worker .+ lost lease epoch (\d+)$/.exec(escalation.reason) : null;
  return match ? Number(match[1]) : null;
}
/**
 * GY-1375. Whether a lease-loss is the lapse of an attempt whose worker never started: the
 * implementation session the launcher registered for that owner and epoch (`principal:epoch`) ended
 * with the launch's own failure (registeredLaunch in session-state.ts) and no pane. That lapse is the
 * launch's outcome, which the dispatch step records and classifies — a plane-wide one is no fault —
 * so it is no session-liveness instance of its own. On 6 October 2026 GY-1373's epoch 1 lapsed while
 * its launch waited out a control-plane outage, and the lapse counted beside the outage that caused it.
 */
export function lapsedBeforeStart(work: Pick<Work, 'sessions'>, escalation: Escalation): boolean {
  const epoch = leaseLossEpoch(escalation), owner = /^Worker (.+) lost lease epoch \d+$/.exec(escalation.reason)?.[1];
  const session = epoch === null ? undefined : (work.sessions ?? []).find(entry => entry.kind === 'implementation' && entry.id === `${owner}:${epoch}`);
  return !!session && session.state === 'finished' && !session.pane && !!session.outcome?.startsWith('the launch failed before the session started');
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
// raises the concern. An epoch whose lease ran past the worker no-submission renewal bound unsubmitted
// was ended by the control plane's own refusal to renew it (GY-1462), which explains it too.
export type LeaseLapse = 'expired' | 'lost';
export type LeaseLapseCause = 'submitted' | 'blocked-awaiting-operator' | 'stopped-by-attestation' | 'exhausted-capacity' | 'no-submission-bound';
/**
 * The worker no-submission bound (GY-1462): how long an attempt may hold its lease with no
 * submission for its epoch. It is declared here once; the doctor's checklist (doctorBounds), the
 * loop's `unsubmitted-attempt` fault, the server's renewal refusal and the lapse it causes all read
 * it. Renewal and session activity are no motion against it: at one bound the attempt is a
 * stalled-gate fault, at two the loop ends it through its reclaim path (its work kept on its
 * branch, the item dispatched again), and a little past that the server refuses its renewals, so
 * with no loop to end it the lease lapses into containment and reclaim.
 */
export const workerNoSubmissionBoundMs = 60 * 60_000;
/** After this many bounds unsubmitted, the loop ends the attempt. */
export const workerNoSubmissionRenewalBounds = 2;
/**
 * How long an attempt may hold its lease unsubmitted before the server refuses its renewals: the
 * loop's end plus ten minutes, so the loop has its cycles to end the attempt with its work kept
 * before the backstop lets the lease lapse.
 */
export const workerNoSubmissionRefusalMs = workerNoSubmissionRenewalBounds * workerNoSubmissionBoundMs + 10 * 60_000;
/**
 * When `epoch`'s attempt was claimed, or null when the record cannot date it: the epoch's
 * assignment (`lastAssignment`), else the pipeline timeline's attempt for that epoch.
 */
export function attemptClaimedAt(work: Partial<Pick<Work, 'lastAssignment'>> & { pipeline?: { attempts?: { epoch: number; claimedAt: string }[] } }, epoch: number): string | null {
  const claimedAt = work.lastAssignment?.epoch === epoch && work.lastAssignment.claimedAt
    ? work.lastAssignment.claimedAt : work.pipeline?.attempts?.find(attempt => attempt.epoch === epoch)?.claimedAt;
  return claimedAt && Number.isFinite(Date.parse(claimedAt)) ? claimedAt : null;
}
/**
 * Whether a lapsed `lease` ran to the no-submission refusal unsubmitted: its last renewal kept it
 * past the point from which the server refuses renewals (workerNoSubmissionRefusalMs), so it lapsed on that refusal
 * (renewals come well inside the lease, so a lease expiring past the bound was renewed up to it).
 */
export function lapsedAtNoSubmissionBound(work: Pick<Work, 'submission'> & Parameters<typeof attemptClaimedAt>[0], lease: Pick<Lease, 'epoch'> & Partial<Pick<Lease, 'expiresAt'>>): boolean {
  const claimedAt = attemptClaimedAt(work, lease.epoch);
  return !submittedEpoch(work, lease.epoch) && !!claimedAt && !!lease.expiresAt
    && Date.parse(lease.expiresAt) - Date.parse(claimedAt) >= workerNoSubmissionRefusalMs;
}
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
export function leaseLapseCause(work: Pick<Work, 'submission' | 'capacity'> & Parameters<typeof attemptClaimedAt>[0], lease: Pick<Lease, 'epoch'> & Partial<Pick<Lease, 'expiresAt'>>, attestations: Attestation[] = []): { cause: LeaseLapseCause; attestation: Attestation | null; exhaustion?: ExhaustionRecord } | null {
  if (submittedEpoch(work, lease.epoch)) return { cause: 'submitted', attestation: null };
  const blocked = attestationFor(attestations, lease.epoch, 'blocked');
  if (blocked) return { cause: 'blocked-awaiting-operator', attestation: blocked };
  const stopped = attestationFor(attestations, lease.epoch, 'stopped-worker');
  if (stopped) return { cause: 'stopped-by-attestation', attestation: stopped };
  const exhausted = workerExhaustion(work, lease.epoch);
  if (exhausted) return { cause: 'exhausted-capacity', attestation: null, exhaustion: exhausted };
  if (lapsedAtNoSubmissionBound(work, lease)) return { cause: 'no-submission-bound', attestation: null };
  return null;
}
export function classifyLeaseLapse(work: Parameters<typeof leaseLapseCause>[0], lease: Parameters<typeof leaseLapseCause>[1], attestations: Attestation[] = []): LeaseLapse { return leaseLapseCause(work, lease, attestations) ? 'expired' : 'lost'; }
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
  if (cause === 'no-submission-bound') return `auto-settled: the server refused renewal ${workerNoSubmissionRefusalMs / 60_000} minutes unsubmitted, past the worker no-submission bound, which is why the attempt ended`;
  if (cause === 'exhausted-capacity') return `auto-settled: the ${exhaustion?.profile ?? 'worker'} account ${exhaustion?.account ?? 'it ran on'} reported no quota left for epoch ${exhaustion?.epoch} (recorded by ${exhaustion?.recordedBy ?? 'the loop'} at ${exhaustion?.at}; ${exhaustion?.resetsAt ? `resets ${exhaustion.resetsAt}` : 'no reset time given'}), which is why the attempt ended`;
  const source = attestation ? ` (${attestation.source} by ${attestation.actor} at ${attestation.at})` : '';
  return cause === 'blocked-awaiting-operator' ? `auto-settled: blocked report for epoch ${attestation?.epoch} explains the lapse${source}`
    : `auto-settled: stopped-worker attestation for epoch ${attestation?.epoch} explains the lapse${source}`;
}
/**
 * GY-1390. The newer attempt that superseded a lost epoch, or null. A claim is granted only after
 * the lost lease ended, and a newer containment fence can only be raised once the lost epoch's was
 * lowered, so while the latest attempt holds its own lease or has submitted, and no fence of the
 * lost epoch stands, the record alone shows the lost attempt can no longer act. Only the latest
 * attempt vouches: a submission survives the rework claim after it, so an older one would hide a
 * later attempt that lapsed unexplained. From 30 September to 7 October 2026 the loop asked an
 * approver to settle 227 such lease-losses, one two-party decision each, and every one counted as
 * an escalation intervention at the build stage; reconciliation now settles them itself.
 */
export function supersedingAttempt(work: Pick<Work, 'submission'> & Partial<Pick<Work, 'epoch' | 'lease' | 'containmentQuarantine'>>, epoch: number): string | null {
  if (work.epoch === undefined || work.epoch <= epoch || work.containmentQuarantine && work.containmentQuarantine.epoch <= epoch) return null;
  if (work.lease && work.lease.epoch === work.epoch) return `epoch ${work.lease.epoch} is held by ${work.lease.owner}`;
  if (work.submission && work.submission.epoch === work.epoch) return `epoch ${work.submission.epoch} submitted PR #${work.submission.pr}`;
  return null;
}
/**
 * GY-1393. How long a control-plane lease-loss whose attempts have all ended stands before
 * reconciliation settles it on the record alone (`endedLeaseLoss`): long enough for every reader
 * that samples standing escalations — the deploy-lease-loss invariant and the session-liveness
 * faults among them — to see it on at least one loop cycle, and far shorter than the approver round
 * it replaced, which took 3 to 229 minutes.
 */
export const leaseLossSettleMs = 5 * 60_000;
/**
 * GY-1393. Why a standing control-plane lease-loss can no longer act, read from the record alone,
 * or null. `superseded` when a newer attempt took the item (`supersedingAttempt`). `ended` when
 * the item is between attempts with no lease and no containment fence — after the lost epoch, or
 * after later attempts that lapsed too (GY-1373 stood from epoch 1 through 18 more) — every worker's
 * supervisor lowered its fence at exit, or the loop settled it after verifying the supervisor gone.
 * The loop had asked an approver to confirm exactly that (28 ready-stage escalation interventions
 * in 7 days). A lead-raised concern, a delivered item, or a lost epoch whose fence still stands is
 * never settled here.
 */
export function endedLeaseLoss(work: Pick<Work, 'stage' | 'epoch' | 'lease' | 'submission' | 'containmentQuarantine'>, escalation: Escalation): { cause: 'superseded' | 'ended'; epoch: number; evidence: string } | null {
  const epoch = leaseLossEpoch(escalation);
  if (work.stage === 'done' || escalation.actor !== 'graphyard' || epoch === null) return null;
  const fence = work.containmentQuarantine;
  if (fence && fence.epoch <= epoch) return null;
  const newer = supersedingAttempt(work, epoch);
  if (newer) return { cause: 'superseded', epoch, evidence: newer };
  // Later attempts that lapsed too raised no lease-loss of their own (a repeat of a standing trigger
  // is history), so this one stands for them as well: with no lease and no fence, every one has ended.
  if (work.epoch >= epoch && !work.lease && !fence) return { cause: 'ended', epoch, evidence: `${work.epoch > epoch ? `every attempt from epoch ${epoch} to epoch ${work.epoch} has ended` : 'no newer attempt holds the item'}, and it holds no lease and no containment fence, so each supervisor lowered its fence or was verified gone` };
  return null;
}
export type LeaseLossSettlementCause = LeaseLapseCause | 'superseded' | 'ended';
export interface LeaseLossSettlement { escalation: Escalation; epoch: number; cause: LeaseLossSettlementCause; attestation: Attestation | null; exhaustion?: ExhaustionRecord; note: string }
/**
 * The standing lease-losses reconciliation settles: one the record explains, one a newer attempt
 * superseded (GY-1390), and — given `now` — one whose attempts have all ended once it has stood
 * `leaseLossSettleMs` (GY-1393). The last two rest only on the record, so an approver asked to
 * confirm them confirmed facts the control plane already held.
 */
export function settleableLeaseLoss(work: Pick<Work, 'submission' | 'capacity' | 'escalation' | 'escalations'> & Partial<Pick<Work, 'epoch' | 'lease' | 'containmentQuarantine' | 'stage'>>, attestations: Attestation[] = [], now?: number): LeaseLossSettlement[] {
  const settlements: LeaseLossSettlement[] = [];
  for (const escalation of standingEscalations(work)) {
    const epoch = leaseLossEpoch(escalation);
    if (epoch === null) continue;
    // A lead-raised concern is never settled from the ledger or from the exhaustion record: only
    // the lapse the control plane itself raised is explained by what the control plane wrote. A
    // bound submission explains the epoch whoever raised it, and settles it as it always has.
    const explained = leaseLapseCause(work, { epoch }, escalation.actor === 'graphyard' ? attestations : []);
    if (explained && (escalation.actor === 'graphyard' || explained.cause === 'submitted')) {
      settlements.push({ escalation, epoch, ...explained, note: leaseLossSettlementNote(explained.cause, explained.attestation, explained.exhaustion ?? null) });
      continue;
    }
    // A control-plane lapse a newer attempt superseded: nothing explains why the worker vanished,
    // but nothing from it can act or merge either, which is all the concern guarded (GY-1390).
    const newer = escalation.actor === 'graphyard' && work.stage !== 'done' ? supersedingAttempt(work, epoch) : null;
    if (newer) {
      settlements.push({ escalation, epoch, cause: 'superseded', attestation: null, note: `auto-settled: superseded — ${newer}, so nothing from epoch ${epoch} can act or merge` });
      continue;
    }
    // Every attempt has ended (GY-1393). Only a caller that passes the item's stage and epoch is asked: none is assumed for it.
    const ended = now !== undefined && work.stage !== undefined && work.epoch !== undefined && now - Date.parse(escalation.at) >= leaseLossSettleMs
      ? endedLeaseLoss({ stage: work.stage, epoch: work.epoch, lease: work.lease ?? null, submission: work.submission, containmentQuarantine: work.containmentQuarantine ?? null }, escalation) : null;
    if (ended?.cause === 'ended') settlements.push({ escalation, epoch, cause: 'ended', attestation: null, note: `auto-settled: ended — ${ended.evidence}, so nothing from epoch ${epoch} can act or merge` });
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
// merge gate and invalidates merge authorization in the same transaction, so a
// candidate that was already merge-ready is dequeued and cannot be delivered while it stands.
export function raiseEscalation(work: Work, escalation: Escalation) {
  const standing = standingEscalations(work);
  // One entry per trigger: a repeat of a trigger that already stands is history,
  // not a second incident, and resolution names a trigger.
  if (standing.some(entry => entry.trigger === escalation.trigger)) return false;
  setEscalations(work, [...standing, escalation]);
  work.mergeAuthorization = null;
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
