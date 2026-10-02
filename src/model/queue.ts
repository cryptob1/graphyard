import { baseRefreshConflict, defaultMergeBatchSize, describeTipWindow, ejectedCheckLift, ejectedTipRestore, ejectingCheck, ejectionReason, failedCheckEjectionPrefix, mergeRefusalEjectionPrefix, standingMergeRefusal, nextQueueSequence, pendingBaseRefresh, pendingRestore, predictQueue, predecessorWait, predecessorWaitText, queueHistoryLimit, queueBatch, queuePlacement, sameMergeBatch, sameTips, stuckBatchMs, windowBatchView } from '../merge-queue.js';
import type { QueueEjection, QueueHistoryEntry, QueuePlacement } from '../merge-queue.js';
import type { Work } from './work.js';
import { behindBaseHold } from './behind-base.js';
import { carriedApproval, currentCarry, describeGround } from './carry.js';
import { currentEvidence } from './evidence.js';
import { evaluateLandability, landabilityAudit, landabilityEjections, landabilityFamily, type LandabilityVerdict } from './landability.js';
import { exactApproval } from './review.js';
import { requiredProofs } from './bootstrap.js';
import { defaultOptimisticMerge, defaultOptimisticExclude, optimisticEligibility, type OptimisticEligibility } from '../optimistic-merge.js';

/** The master's merge-queue settings as the control plane applies them: `mergeQueue.batchSize`, `mergeQueue.parallelTips` (GY-498), `mergeQueue.optimistic` and `mergeQueue.optimisticExclude`. */
export interface MergeQueueSettings { batchSize?: number; optimistic?: boolean; optimisticExclude?: readonly string[]; parallelTips?: number }
export const queueSettings = (settings: number | MergeQueueSettings | undefined) => typeof settings === 'object'
  ? { batchSize: settings.batchSize ?? defaultMergeBatchSize, optimistic: settings.optimistic ?? defaultOptimisticMerge, optimisticExclude: settings.optimisticExclude ?? defaultOptimisticExclude, parallelTips: settings.parallelTips }
  : { batchSize: settings ?? defaultMergeBatchSize, optimistic: defaultOptimisticMerge, optimisticExclude: defaultOptimisticExclude, parallelTips: undefined };

/**
 * Queue membership is derived, never asserted: no command, operator, or administrator can
 * place, reorder, or hold a position. An entry leaves only by merging or by an explicit,
 * observed validation failure, and a re-entry always starts a new sequence at the back — except
 * a CI ejection a passing rerun on the same tip lifts (GY-1095), which returns to the place it held.
 *
 * The one entry that never joins is an optimistic one (GY-500): not queued, every gate passing on
 * its own head, and its files disjoint from everything the base changed since its bound base (see
 * optimisticEligibility). It merges head-bound at once, with no queue reason on its merge gate;
 * main is guarded after the merge instead. An entry that stops being eligible joins as any other.
 */
export function placeInQueue(work: Work, all: Work[], now: Date, ciAppIds: number[], eligible: boolean, settings: number | MergeQueueSettings = defaultMergeBatchSize, landability?: LandabilityVerdict) {
  const { batchSize, optimistic: optimisticMode, optimisticExclude, parallelTips } = queueSettings(settings);
  const history = [...(work.queueHistory ?? [])];
  const candidate = work.candidate;
  let queue = work.queue ?? null, queueSequence = work.queueSequence ?? 0, ejection = work.queueEjection ?? null;
  // The landability verdict is computed on demand from the live facts (GY-878): the caller's own
  // evaluation of this pass, or a fresh one, never a verdict stored on an earlier record.
  let computed = landability;
  const verdict = () => computed ??= evaluateLandability(work, all, now);
  const record = (event: QueueHistoryEntry['event'], reason?: string, tip?: string, audit?: QueueHistoryEntry['verdict']) => {
    history.push({ at: now.toISOString(), event, sequence: queueSequence, ...(reason ? { reason } : {}), ...(tip ? { tip } : {}), ...(event === 'ejected' ? { conflict: null } : {}), ...(audit ? { verdict: audit } : {}) });
    if (history.length > queueHistoryLimit) history.splice(0, history.length - queueHistoryLimit);
  };
  const probe = { ...work, queue, queueSequence, gates: [], violations: work.violations } as Work;
  // The batch plan (GY-330) decides which failed tip ejects: it is read from the queue as it
  // stands, with this entry's own record as just observed. Under a parallel-tip window (GY-498)
  // the window's prefix verdicts decide instead: the first failing tip isolates its own entry.
  const peersOf = (subject: Work) => all.map(item => item.id === subject.id ? subject : item);
  const batchOf = (subject: Work) => queueBatch(subject, peersOf(subject), now.getTime(), batchSize, ciAppIds);
  const windowOf = (subject: Work) => parallelTips ? describeTipWindow(peersOf(subject), predictQueue(peersOf(subject), now.getTime()), parallelTips, ciAppIds).get(subject.key) ?? null : null;
  const reason = queue ? ejectionReason(probe, ciAppIds, all, parallelTips ? null : batchOf(probe), windowOf(probe), now, verdict()) : null;
  const optimistic: OptimisticEligibility | null = !queue && eligible ? optimisticEligibility(work, all, { enabled: optimisticMode, gatesPass: eligible, exclude: optimisticExclude }) : null;
  if (optimistic?.eligible) return { queue: null, queueSequence, ejection, history, reasons: [] as string[], placement: null, optimistic };
  const lift = !queue && eligible && ejection?.check ? ejectedCheckLift(work, all, ciAppIds) : null;
  if (queue && reason) {
    // A landability ejection is typed as one and records the verdict version and inputs it was
    // refused by, so the audit trail shows what was judged and re-entry never reads the text.
    const audit = landabilityEjections(verdict()).includes(reason) ? landabilityAudit(verdict()) : undefined;
    // A required check failing on the tip is recorded as a typed fact with the failed run and the
    // speculation the entry held, so a passing rerun on the same tip can lift it (GY-1095).
    const failing = ejectingCheck(probe, ciAppIds);
    const check = failing && candidate && reason.startsWith(failedCheckEjectionPrefix(failing.name))
      ? { name: failing.name, runId: failing.run.id ?? null, tip: candidate.sha, speculation: queue.speculation ?? null } : null;
    ejection = { at: now.toISOString(), sequence: queue.sequence, reason, sha: candidate?.sha ?? null, policyRevision: work.policyRevision, conflict: null,
      family: audit ? 'landability' : null, ...(audit ? { verdict: audit } : {}), check };
    record('ejected', reason, queue.speculation?.tip ?? candidate?.sha, audit);
    queue = null;
  } else if (lift && ejection?.check) {
    // A CI ejection whose check's newest run on the same tip now passes is lifted (GY-1095): the
    // failure it was made for was superseded, so the entry re-enters at the sequence it held, with
    // its speculation, and needs no new candidate. A rerun that failed again, another failing
    // required check, or a changed tip keeps the ejection.
    queue = { sequence: ejection.sequence, enqueuedAt: now.toISOString(), policyRevision: work.policyRevision, speculation: ejection.check.speculation };
    queueSequence = Math.max(queueSequence, ejection.sequence);
    history.push({ at: now.toISOString(), event: 'lifted', sequence: ejection.sequence, reason: lift.reason, tip: lift.tip, check: lift.check, runId: lift.run.id ?? null });
    if (history.length > queueHistoryLimit) history.splice(0, history.length - queueHistoryLimit);
    ejection = null;
  } else if (!queue && eligible && (!(ejection && candidate && ejection.sha === candidate.sha && ejection.policyRevision === work.policyRevision) || predecessorReentry(work, all)
    // A candidate ejected for a merge refusal a fresh approval has since answered re-enters (GY-831).
    || ejection!.reason.startsWith(mergeRefusalEjectionPrefix) && !standingMergeRefusal(work)
    // A landability ejection is never sticky (GY-878): it holds the head out only while the verdict,
    // recomputed now from live facts, still refuses; once it is landable the same head re-enters.
    // Any other ejection keeps the head out until it changes, so a CI or review ejection does not
    // churn in and out. The ejected tip is still restored to the item's own head first.
    || landabilityFamily(ejection!) && !ejectedTipRestore(work, all) && verdict().verdict === 'landable')) {
    queueSequence = nextQueueSequence(all);
    queue = { sequence: queueSequence, enqueuedAt: now.toISOString(), policyRevision: work.policyRevision, speculation: null };
    ejection = null;
    record('enqueued');
  }
  const waiting = queue ? null : predecessorWait({ ...work, queue, queueEjection: ejection } as Work, all);
  const shadow = { ...work, queue, queueSequence } as Work;
  const placement = queue ? queuePlacement(shadow, all.map(item => item.id === work.id ? shadow : item), now.getTime()) : null;
  if (queue) {
    if (parallelTips) {
      // Under the parallel-tip window (GY-498) every entry validates on its own tip, so there is
      // no combined batch tip to wedge (GY-506's dissolution belongs to the batch plan). The view
      // is replaced only when it differs in content, for the same jsonb key-order reason as below.
      const view = windowOf(shadow);
      const batch = view ? windowBatchView(work.key, view, parallelTips) : null;
      const tips = view?.tips ?? null;
      if (!sameMergeBatch(queue.batch ?? null, batch) || !sameTips(queue.tips ?? null, tips)) {
        const { batch: _previous, tips: _previousTips, ...entry } = queue;
        queue = { ...entry, ...(batch ? { batch } : {}), ...(tips ? { tips } : {}) } as typeof queue;
      }
    } else {
      const batch = batchOf(shadow);
      let mutated = false;
      // A head batch sitting in 'testing' with no published tip is the GY-506 deadlock: nothing
      // names CI to wait for, so the queue can only advance by a tip being published. The head
      // member times the state; after `stuckBatchMs` the batch dissolves and its members validate
      // as single-entry batches, in their existing order, each re-predicted in turn.
      const stuck = !!batch && batch.batch === 1 && batch.state === 'testing' && batch.tip === null && batch.members.length > 0;
      if (batch && batch.members[0] === work.key) {
        if (stuck) {
          if (!queue.batchStall) { queue = { ...queue, batchStall: { since: now.toISOString() } }; mutated = true; }
          const since = Date.parse(queue.batchStall!.since);
          if (!queue.batchDissolved && now.getTime() - since >= stuckBatchMs) {
            const members = [...batch.members];
            queue = { ...queue, batchDissolved: { at: now.toISOString(), members } };
            mutated = true;
            record('dissolved', `batch 1 (${members.join(', ')}) sat in testing with no published tip for ${Math.round((now.getTime() - since) / 60_000)} minutes (GY-506); its members return to single-entry queue positions in their existing order and are re-predicted`);
          }
        } else if (queue.batchStall) {
          const { batchStall: _stall, ...entry } = queue;
          queue = entry; mutated = true;
        }
      }
      // The dissolution holds while every member it named is still queued; one that left (merged,
      // or ejected) ends it and the ordinary batch plan resumes for the rest.
      if (queue.batchDissolved) {
        const members = queue.batchDissolved.members;
        const live = (key: string) => key === work.key ? !!queue : all.some(item => item.id !== work.id && item.queue && item.stage !== 'done' && item.key === key);
        if (!members.every(live)) {
          const { batchDissolved: _dissolved, ...entry } = queue;
          queue = entry; mutated = true;
        }
      }
      // The derived view replaces the stored one only when it differs in content. Postgres jsonb
      // stores object keys shortest-first and the derived view names `batch` last, so rewriting an
      // equal view changed the document's key order — and the reconcile pass, seeing a difference,
      // re-saved every queued entry every pass (GY-506): every in-flight observation then lost the
      // revision race and its job was rescheduled, silently, without one. An equal view is kept.
      if (mutated || !sameMergeBatch(queue.batch ?? null, batch)) {
        const { batch: _previous, ...entry } = queue;
        queue = batch ? { ...entry, batch } : entry;
      }
    }
  }
  const reasons = placement ? placement.reasons
    : work.observation?.merged || work.stage === 'done' ? []
    : waiting?.length ? [predecessorWaitText(work, waiting)]
    : ejection ? [`Ejected from the merge queue: ${ejection.reason}; ${ejection.check ? `a passing rerun of ${ejection.check.name} on this tip lifts the ejection, or ` : ''}a new candidate re-enters at the back of the queue`]
    : eligible ? ['Candidate has not entered the merge queue'] : [];
  return { queue, queueSequence, ejection, history, reasons, placement, optimistic };
}

/**
 * The record of a queued entry leaving the queue for `reason`: the ejection and the history entry.
 * A speculative-merge conflict (`conflict`, the caller's typed knowledge, never read from the
 * reason: GY-252) records that it was one and the base it was attempted onto, and the prediction
 * it was found on (GY-321): the entries ahead of it, or [] when the merge was onto the base branch
 * tip itself. Only the latter is a conflict with the base, which a sync can resolve; the former
 * waits for those entries instead.
 */
export function queueEjectionRecord(work: Work, all: Work[], reason: string, now: Date, conflict = false): { ejection: QueueEjection; history: QueueHistoryEntry[] } {
  const sequence = work.queue!.sequence, at = now.toISOString();
  const placement = conflict ? queuePlacement(work, all, now.getTime()) : null;
  const predecessors = conflict ? placement?.predecessors ?? [] : null;
  const ejection: QueueEjection = { at, sequence, reason, sha: work.candidate?.sha ?? null, policyRevision: work.policyRevision,
    conflict: conflict ? { base: placement?.predictedBase ?? null } : null, ...(predecessors ? { predecessors } : {}) };
  const history = [...(work.queueHistory ?? []), { at, event: 'ejected' as const, sequence, reason, conflict: ejection.conflict, ...(work.queue!.speculation ? { tip: work.queue!.speculation.tip } : {}), ...(predecessors ? { predecessors } : {}) }].slice(-queueHistoryLimit);
  return { ejection, history };
}

/**
 * The lift this evaluation just made (GY-1095), for the ledger: an entry unqueued before it that
 * re-entered by a `lifted` history entry at `now`, naming the check, the passing run and the tip.
 */
export function liftedEjection(work: Pick<Work, 'queue' | 'queueHistory'>, queuedBefore: number | null, now: Date) {
  const entry = work.queueHistory?.at(-1);
  if (queuedBefore !== null || !work.queue || entry?.event !== 'lifted' || entry.at !== now.toISOString()) return null;
  return { sequence: entry.sequence, check: entry.check ?? null, runId: entry.runId ?? null, tip: entry.tip ?? null, reason: entry.reason ?? null };
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
