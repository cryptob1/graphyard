import { ejectionReason, nextQueueSequence, queueHistoryLimit, queuePlacement } from '../merge-queue.js';
import type { QueueHistoryEntry } from '../merge-queue.js';
import type { Work } from './work.js';

/**
 * Queue membership is derived, never asserted: no command, operator, or administrator can
 * place, reorder, or hold a position. An entry leaves only by merging or by an explicit,
 * observed validation failure, and a re-entry always starts a new sequence at the back.
 */
export function placeInQueue(work: Work, all: Work[], now: Date, ciAppIds: number[], eligible: boolean) {
  const history = [...(work.queueHistory ?? [])];
  const candidate = work.candidate;
  let queue = work.queue ?? null, queueSequence = work.queueSequence ?? 0, ejection = work.queueEjection ?? null;
  const record = (event: QueueHistoryEntry['event'], reason?: string, tip?: string) => {
    history.push({ at: now.toISOString(), event, sequence: queueSequence, ...(reason ? { reason } : {}), ...(tip ? { tip } : {}) });
    if (history.length > queueHistoryLimit) history.splice(0, history.length - queueHistoryLimit);
  };
  const probe = { ...work, queue, queueSequence, gates: [], violations: work.violations } as Work;
  const reason = queue ? ejectionReason(probe, ciAppIds) : null;
  if (queue && reason) {
    ejection = { at: now.toISOString(), sequence: queue.sequence, reason, sha: candidate?.sha ?? null, policyRevision: work.policyRevision };
    record('ejected', reason, queue.speculation?.tip ?? candidate?.sha);
    queue = null;
  } else if (!queue && eligible && !(ejection && candidate && ejection.sha === candidate.sha && ejection.policyRevision === work.policyRevision)) {
    queueSequence = nextQueueSequence(all);
    queue = { sequence: queueSequence, enqueuedAt: now.toISOString(), policyRevision: work.policyRevision, speculation: null };
    ejection = null;
    record('enqueued');
  }
  const shadow = { ...work, queue, queueSequence } as Work;
  const placement = queue ? queuePlacement(shadow, all.map(item => item.id === work.id ? shadow : item), now.getTime()) : null;
  const reasons = placement ? placement.reasons
    : work.observation?.merged || work.stage === 'done' ? []
    : ejection ? [`Ejected from the merge queue: ${ejection.reason}; a new candidate re-enters at the back of the queue`]
    : eligible ? ['Candidate has not entered the merge queue'] : [];
  return { queue, queueSequence, ejection, history, reasons, placement };
}
