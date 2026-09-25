// Concern: cursor action keys, and reconciling pending actions against Graphyard after a restart.
import type { Work } from '../model.js';
import { type ScopeRequestState, unplannedPaths } from '../model/scope.js';
import type { WorkerProfile } from '../master.js';
import { faultActionKey, storeAction, type DaemonAction, type DaemonActionKind, type DaemonState } from './state.js';
import { openFaultClassItem, type FaultClass } from '../model/fault-classes.js';
import type { RoutineDecision } from './decisions.js';

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
    } else if (action.kind === 'scope' && action.work) {
      // The decision lives on the item: either the control plane recorded one for the open
      // request or it did not, and an undecided request is simply asked again next cycle.
      const pending = item?.scopeRequest && !item.scopeRequest.decision;
      next.state = pending ? 'failed' : 'done';
      next.detail = pending ? 'Resumed: the scope request is still undecided and will be decided again'
        : `Resumed: Graphyard holds the decision (${item?.scopeRequest?.decision?.state ?? 'the request was withdrawn or superseded'})`;
    } else if (action.kind === 'failover') {
      // A worker failover took effect exactly when the attempt's lease ended on the record. An
      // interrupted one is tried again: the control plane writes an exhaustion once, and a
      // reviewer or producer session already ended is no longer pending, so nothing repeats.
      const ended = action.epoch !== null && !!item && (!item.lease || item.lease.epoch !== action.epoch);
      next.state = ended ? 'done' : 'failed';
      next.detail = ended ? `Resumed: Graphyard shows attempt ${action.epoch} ended, so the item is re-queued` : 'Resumed: the failover was interrupted; the session is read again on this cycle';
    } else if (action.kind === 'deployment' && action.work) {
      // Recording a deployment either landed on the delivery snapshot or it did not; a repeat of a
      // landed record is refused by Graphyard, so retrying is safe.
      next.state = item?.delivery?.deployment ? 'done' : 'failed';
      next.detail = next.state === 'done' ? 'Resumed: Graphyard holds the deployment observation' : 'Resumed: no deployment observation was recorded; it may be recorded again';
    } else if (action.kind === 'decision') {
      // Both halves are safe to repeat: a request already standing on the item is adopted rather
      // than made twice, and a session already listed under the decision's name is adopted rather
      // than launched twice. Left indeterminate, the decision would never be looked at again.
      next.state = state.approvals[key] ? 'done' : 'failed';
      next.detail = next.state === 'done' ? 'Resumed: the decision was requested before the restart; its approver session is supervised from here'
        : 'Resumed: no request was recorded before the restart; a standing one is adopted, otherwise it is requested again';
    } else if (action.kind === 'fault') {
      // Filing a recurring class's item is idempotent under its key: the item the filing made stands open naming the
      // class, and later instances link to it; without one, the class files again under the same key.
      const filed = openFaultClassItem(work, key.slice(faultActionKey('').length) as FaultClass);
      next.state = filed ? 'done' : 'failed';
      next.work = filed?.key ?? null;
      next.detail = filed ? `Resumed: ${filed.key} stands open for the class; later instances link to it` : 'Resumed: no item stands for the class, so it is filed again under the same idempotency key';
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
/** One routine decision per action, item, binding (the head, or the quarantined epoch) and policy revision. */
export const decisionKey = (work: Work, decision: Pick<RoutineDecision, 'action' | 'binding'>) => `decision:${decision.action}:${work.id}:${decision.binding}:${work.policyRevision}`;
/** One decision per request: the instant the worker recorded it identifies the ask. */
export const scopeKey = (work: Work, request: ScopeRequestState) => `scope:${work.id}:${request.epoch}:${request.at}`;
/**
 * The requirements revision that widens `work` by `paths` in answer to `request`. It names the
 * request it answers and the head its findings were read for, so the control plane refuses it once a
 * claim or a lease end has cleared that request, or a push has replaced that head, while the loop
 * was still reading the findings it is grounded on.
 */
/**
 * When the control plane recorded the answer to a routed scope request (GY-176): the approval or
 * refusal event's own time, else the item's `scopeDecision` for that same request, written in the
 * same transaction. Null when neither is known; the caller then falls back to its observation.
 */
export function scopeAnsweredAt(work: Work, request: { epoch: number; at: string }, eventAt: string | null | undefined): string | null {
  if (eventAt && Number.isFinite(Date.parse(eventAt))) return eventAt;
  const decision = work.scopeDecision;
  return decision && decision.requestedAt === request.at && (decision.epoch === undefined || decision.epoch === request.epoch) ? decision.at : null;
}

/**
 * Whether an approver's settled judgement answered the routed request it names (GY-176), read from
 * the item as observed at `clock`. The control plane attaches a refusal only to the open request of
 * a live attempt under the revision it was asked against; a stale one leaves the request as it stood,
 * which is no outcome: neither measured nor reported to the worker. An applied widening answers once
 * the item holds its outcome or plans the paths. `pending` when the judgement was recorded after the
 * observation, which cannot say yet.
 */
export function scopeOutcomeAnswered(work: Work, request: { epoch: number; at: string; paths: string[] }, judged: { state: string; approvedAt?: string | null; refusal?: { at?: string } | null }, clock: number): 'answered' | 'unanswered' | 'pending' {
  const approved = judged.state === 'applied', decision = work.scopeDecision;
  if (decision && decision.requestedAt === request.at && (decision.epoch === undefined || decision.epoch === request.epoch)
    && decision.state === (approved ? 'approved' : 'refused') && (approved || decision.decidedBy !== 'graphyard')) return 'answered';
  if (approved && !unplannedPaths(work.plannedFiles, request.paths).length) return 'answered';
  const at = Date.parse((approved ? judged.approvedAt : judged.refusal?.at) ?? '');
  return Number.isFinite(at) && at >= clock ? 'pending' : 'unanswered';
}

export const answeringWidening = (work: Work, request: ScopeRequestState, paths: string[], reason: string) => ({
  expectedPolicyRevision: work.policyRevision, criteria: work.criteria, dependencies: work.dependencies,
  plannedFiles: [...new Set([...(work.plannedFiles ?? []), ...paths])], exclusiveResources: work.exclusiveResources ?? [], producerProofs: work.producerProofs ?? [],
  reason, answers: { epoch: request.epoch, at: request.at, sha: work.candidate?.sha ?? null } });
