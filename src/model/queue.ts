import { baseRefreshConflict, defaultMergeBatchSize, ejectedTipRestore, ejectionReason, nextQueueSequence, pendingBaseRefresh, pendingRestore, predecessorWait, predecessorWaitText, queueHistoryLimit, queueBatch, queuePlacement, speculativeConflictReason } from '../merge-queue.js';
import type { QueueEjection, QueueHistoryEntry, QueuePlacement } from '../merge-queue.js';
import type { Work } from './work.js';
import { behindBaseHold } from './behind-base.js';
import { carriedApproval, currentCarry, describeGround } from './carry.js';
import { currentEvidence } from './evidence.js';
import { exactApproval } from './review.js';
import { requiredProofs } from './bootstrap.js';

/**
 * Queue membership is derived, never asserted: no command, operator, or administrator can
 * place, reorder, or hold a position. An entry leaves only by merging or by an explicit,
 * observed validation failure, and a re-entry always starts a new sequence at the back.
 */
export function placeInQueue(work: Work, all: Work[], now: Date, ciAppIds: number[], eligible: boolean, batchSize = defaultMergeBatchSize) {
  const history = [...(work.queueHistory ?? [])];
  const candidate = work.candidate;
  let queue = work.queue ?? null, queueSequence = work.queueSequence ?? 0, ejection = work.queueEjection ?? null;
  const record = (event: QueueHistoryEntry['event'], reason?: string, tip?: string) => {
    history.push({ at: now.toISOString(), event, sequence: queueSequence, ...(reason ? { reason } : {}), ...(tip ? { tip } : {}) });
    if (history.length > queueHistoryLimit) history.splice(0, history.length - queueHistoryLimit);
  };
  const probe = { ...work, queue, queueSequence, gates: [], violations: work.violations } as Work;
  // The batch plan (GY-330) decides which failed tip ejects: it is read from the queue as it
  // stands, with this entry's own record as just observed.
  const batchOf = (subject: Work) => queueBatch(subject, all.map(item => item.id === subject.id ? subject : item), now.getTime(), batchSize, ciAppIds);
  const reason = queue ? ejectionReason(probe, ciAppIds, all, batchOf(probe)) : null;
  if (queue && reason) {
    ejection = { at: now.toISOString(), sequence: queue.sequence, reason, sha: candidate?.sha ?? null, policyRevision: work.policyRevision };
    record('ejected', reason, queue.speculation?.tip ?? candidate?.sha);
    queue = null;
  } else if (!queue && eligible && (!(ejection && candidate && ejection.sha === candidate.sha && ejection.policyRevision === work.policyRevision) || predecessorReentry(work, all))) {
    queueSequence = nextQueueSequence(all);
    queue = { sequence: queueSequence, enqueuedAt: now.toISOString(), policyRevision: work.policyRevision, speculation: null };
    ejection = null;
    record('enqueued');
  }
  const waiting = queue ? null : predecessorWait({ ...work, queue, queueEjection: ejection } as Work, all);
  const shadow = { ...work, queue, queueSequence } as Work;
  const placement = queue ? queuePlacement(shadow, all.map(item => item.id === work.id ? shadow : item), now.getTime()) : null;
  if (queue) {
    const batch = batchOf(shadow);
    const { batch: _previous, ...entry } = queue;
    queue = batch ? { ...entry, batch } : entry;
  }
  const reasons = placement ? placement.reasons
    : work.observation?.merged || work.stage === 'done' ? []
    : waiting?.length ? [predecessorWaitText(work, waiting)]
    : ejection ? [`Ejected from the merge queue: ${ejection.reason}; a new candidate re-enters at the back of the queue`]
    : eligible ? ['Candidate has not entered the merge queue'] : [];
  return { queue, queueSequence, ejection, history, reasons, placement };
}

/**
 * The record of a queued entry leaving the queue for `reason`: the ejection and the history entry.
 * A speculative-merge conflict also records the prediction it was found on (GY-321): the entries
 * ahead of it, or [] when the merge was onto the base branch tip itself. Only the latter is a
 * conflict with the base, which a sync can resolve; the former waits for those entries instead.
 */
export function queueEjectionRecord(work: Work, all: Work[], reason: string, now: Date): { ejection: QueueEjection; history: QueueHistoryEntry[] } {
  const sequence = work.queue!.sequence, at = now.toISOString();
  const predecessors = speculativeConflictReason.test(reason) ? queuePlacement(work, all, now.getTime())?.predecessors ?? [] : null;
  const ejection: QueueEjection = { at, sequence, reason, sha: work.candidate?.sha ?? null, policyRevision: work.policyRevision, ...(predecessors ? { predecessors } : {}) };
  const history = [...(work.queueHistory ?? []), { at, event: 'ejected' as const, sequence, reason, ...(work.queue!.speculation ? { tip: work.queue!.speculation.tip } : {}), ...(predecessors ? { predecessors } : {}) }].slice(-queueHistoryLimit);
  return { ejection, history };
}

/**
 * GY-321. Whether an entry ejected for a conflict with its predecessors alone re-enters with the
 * same head: once any predecessor named in the ejection has landed or left the queue. A landed one
 * moved the base first. A head GitHub reports mergeable against the new tip re-enters as it is, and
 * its speculative tip integrates that base (GY-292); one that conflicts, or whose mergeability is
 * not computed yet (`behindBaseHold`), waits for the base refresh to bring it onto the new tip
 * (a new head re-enters by the ordinary rule; a refresh conflict is the base's and asks for rework).
 * An ejected speculative tip is still restored to the item's own head first (`ejectedTipRestore`).
 */
function predecessorReentry(work: Work, all: Work[]) {
  const waiting = predecessorWait(work, all);
  return !!waiting && !waiting.length && !behindBaseHold(work) && !pendingBaseRefresh(work) && !baseRefreshConflict(work) && !pendingRestore(work) && !ejectedTipRestore(work, all);
}

/** How one binding of a queued candidate currently stands, and why. */
export interface BindingState { state: 'exact' | 'carried' | 'required'; reason: string }
export interface QueueBindingReport {
  tip: string;
  /** What the carry decision for this tip rested on, as `describeGround` reads it (GY-330); null when none was recorded. */
  ground: string | null;
  /** The bound base and, when the base branch advanced only by a tree-identical commit, that advance. */
  base: { sha: string; tree: string; binding: QueuePlacement['binding']; carriedTo: { sha: string; tree: string } | null };
  approval: BindingState & { reviewer?: string; originalSha?: string };
  evidence: (BindingState & { proof: string; evidenceId?: string; producer?: string })[];
}
/**
 * Per queued item: whether its review and each required proof bind the current tip exactly, were
 * carried across a Graphyard-authored tip, or must be produced afresh — with the recorded reason.
 * Reported by master status and diagnose; the gates decide from the same records.
 */
export function describeQueueBinding(work: Work, all: Work[], now: Date, placement: QueuePlacement | null = queuePlacement(work, all, now.getTime())): QueueBindingReport | null {
  const speculation = work.queue?.speculation, candidate = work.candidate;
  if (!speculation || !candidate || speculation.tip !== candidate.sha) return null;
  const carry = currentCarry(work), tip = candidate.sha.slice(0, 12);
  const exact = exactApproval(work), carried = carriedApproval(work);
  const approval: QueueBindingReport['approval'] = exact ? { state: 'exact', reason: `${exact.reviewer} approved tip ${tip}`, reviewer: exact.reviewer }
    : carried ? { state: 'carried', reason: carried.reason, reviewer: carried.reviewer, originalSha: carried.originalSha }
    : { state: 'required', reason: carry?.approval.carried === false ? carry.approval.reason : `no approval is bound to tip ${tip}` };
  const evidence = requiredProofs(work, all).map(proof => {
    const current = currentEvidence(work, proof, now);
    const decision = carry?.evidence.find(entry => entry.proof === proof);
    if (current && current.sha === candidate.sha && current.baseSha === candidate.baseSha) return { proof, state: 'exact' as const, reason: `${current.producer} proved tip ${tip}`, evidenceId: current.id, producer: current.producer };
    if (current && decision?.carried) return { proof, state: 'carried' as const, reason: decision.reason, evidenceId: current.id, producer: current.producer };
    return { proof, state: 'required' as const, reason: decision && !decision.carried ? decision.reason : `no trusted evidence is bound to tip ${tip}`, ...(decision?.evidenceId ? { evidenceId: decision.evidenceId } : {}), ...(decision?.producer ? { producer: decision.producer } : {}) };
  });
  const carriedTo = speculation.carriedBase && speculation.carriedBase.sha !== speculation.base ? { sha: speculation.carriedBase.sha, tree: speculation.carriedBase.tree } : null;
  return { tip: candidate.sha, ground: describeGround(carry?.ground), base: { sha: speculation.base, tree: speculation.baseTree, binding: placement?.binding ?? null, carriedTo }, approval, evidence };
}

/**
 * The review and the proofs the current candidate holds by carry rather than by a fresh verdict on
 * this exact commit (GY-330), each with the ground the carry rested on. Status and the dashboard
 * show these as carried — the same verdict as before a Graphyard-authored merge, not a new one —
 * never as steps that passed afresh ahead of the one the item is at.
 */
export interface CarriedBinding { ground: string | null; reason: string; from: string }
export function carriedBindings(work: Work, all: Work[], now: Date): { review: CarriedBinding | null; proofs: (CarriedBinding & { proof: string; evidenceId?: string })[] } {
  const carry = currentCarry(work), candidate = work.candidate;
  if (!carry || !candidate) return { review: null, proofs: [] };
  const ground = describeGround(carry.ground), from = carry.from.sha;
  const approval = !exactApproval(work) ? carriedApproval(work) : null;
  const proofs = requiredProofs(work, all).flatMap(proof => {
    const current = currentEvidence(work, proof, now), decision = carry.evidence.find(entry => entry.proof === proof);
    if (!current || !decision?.carried || decision.evidenceId !== current.id || (current.sha === candidate.sha && current.baseSha === candidate.baseSha)) return [];
    return [{ proof, ground, reason: decision.reason, from, evidenceId: current.id }];
  });
  return { review: approval ? { ground, reason: approval.reason, from } : null, proofs };
}
