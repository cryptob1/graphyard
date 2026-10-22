// Concern: cursor action keys, and reconciling pending actions against Graphyard after a restart.
import type { Work } from '../model.js';
import type { WorkerProfile } from '../master.js';
import { storeAction, type DaemonAction, type DaemonActionKind, type DaemonState } from './state.js';

/**
 * A daemon killed mid-action leaves a `started` cursor entry. Graphyard, not the cursor, decides
 * what actually happened: an assignment that landed is closed as done, one that did not is released
 * for a fresh attempt. Neither outcome repeats an action that already took effect.
 *
 * A dispatch lands only by the launcher claiming under the worker's own identity, and every claim
 * advances the epoch, so the attempt epoch is the one honest witness. A submission is not: rework
 * authorized by an operator keeps the previous attempt's submission while the item waits to be
 * assigned again, and reading that as success would strand the rework at a key that never retries.
 */
export function reconcilePendingActions(state: DaemonState, work: Work[], now: number) {
  const resumed: DaemonAction[] = [];
  for (const [key, action] of Object.entries(state.actions)) {
    if (action.state !== 'started') continue;
    // A base refresh is the control plane's own work, not an effect this loop invoked, so there is
    // nothing interrupted to reconcile: the cycle resolves the same entry from Graphyard's record
    // of what the merge did, or leaves it open while the reconciliation job has not run yet.
    if (action.kind === 'refresh') continue;
    const item = work.find(candidate => candidate.key === action.work || candidate.id === action.work);
    const owned = !!item?.lease && item.lease.owner === action.principal && Date.parse(item.lease.expiresAt) > now;
    const next: DaemonAction = { ...action, at: new Date(now).toISOString() };
    if (action.kind === 'dispatch') {
      // A cursor written before attempt epochs were recorded can fall back only to a submission the
      // current attempt owns; one kept across rework says nothing about the attempt just dispatched.
      const landed = owned ? 'Graphyard shows the assignment landed before the restart'
        : action.epoch !== null && item && item.epoch > action.epoch ? `Graphyard advanced the attempt past epoch ${action.epoch}, so the assignment landed before the restart`
          : action.epoch === null && item?.submission && !item.reworkRequested ? 'the current attempt is already submitted, so the assignment landed before the restart'
            : null;
      next.state = landed ? 'done' : 'failed';
      next.detail = landed ? `Resumed: ${landed}` : 'Resumed: no assignment landed, so the item stays eligible for a fresh dispatch';
    } else if (action.kind === 'merge') {
      next.state = item?.observation?.merged || item?.stage === 'done' ? 'done' : 'failed';
      next.detail = next.state === 'done' ? 'Resumed: Graphyard observed the merge' : 'Resumed: no merge was observed; the guarded merge may be attempted again';
      // The guarded merge only asks GitHub to merge one exact head, so asking again is safe: a
      // restart that interrupted it is a retry, never a merge fault (GY-1087: GY-999 counted at a
      // restart and merged on the retry twelve minutes later).
      if (next.state === 'failed') { resumed.push(storeAction(state, key, next)); continue; }
    } else if (action.kind === 'scope') {
      // Scope requests are retired (GY-1992): nothing decides or retries one now.
      next.state = 'done';
      next.detail = 'Resumed: scope requests are retired; nothing is left to decide';
    } else if (action.kind === 'failover') {
      // A worker failover took effect exactly when the attempt's lease ended on the record. An
      // interrupted one is tried again: the control plane writes an exhaustion once, and a
      // reviewer or producer session already ended is no longer pending, so nothing repeats.
      const ended = action.epoch !== null && !!item && (!item.lease || item.lease.epoch !== action.epoch);
      next.state = ended ? 'done' : 'failed';
      next.detail = ended ? `Resumed: Graphyard shows attempt ${action.epoch} ended, so the item is re-queued` : 'Resumed: the failover was interrupted; the session is read again on this cycle';
    } else if (action.kind === 'deployment' && action.work) {
      // A per-item deployment record from before GY-1981 (done = merged): nothing records or retries one now.
      next.state = 'done';
      next.detail = 'Resumed: per-item deployment records are retired; the item was delivered at its merge';
    } else if (action.kind === 'decision') {
      // A rework the restart interrupted is decided again from the snapshot: one that applied left the item reworked.
      next.state = 'failed';
      next.detail = 'Resumed: the rework was interrupted; the next cycle decides it again from the snapshot';
    } else if (action.kind === 'fault') {
      // The loop files no work item for a recurring fault class (GY-2186): a class past its
      // threshold is one master-status attention line. A filing a restart interrupted is retired,
      // never retried; the recurrence the row counted reads as the attention line instead.
      next.state = 'done';
      next.work = null;
      next.detail = 'Resumed: fault-class filings are retired; the recurrence reads as a master-status attention line';
    } else {
      next.state = 'indeterminate';
      next.detail = `Resumed: the ${action.kind} request was interrupted and its effect is unknown`;
    }
    resumed.push(storeAction(state, key, next));
  }
  return resumed;
}

export const dispatchKey = (work: Work) => `dispatch:${work.id}:${work.epoch}`;
export const candidateKey = (kind: DaemonActionKind, work: Work) => `${kind}:${work.id}:${work.candidate?.sha ?? 'none'}:${work.candidate?.baseSha ?? 'none'}:${work.policyRevision}`;
export const closeKey = (profile: WorkerProfile, pane: string) => `close:${profile.name}:${pane}`;
