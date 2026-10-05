// Concern: the decision histories the decisions step reads, kept across cycles (GY-1142).
import type { Work } from '../model.js';
import { approvalApplyGraceMs, situationLabel, stalledApproval, supersededSituation, type DecisionSituation } from '../model/approval.js';
import { routableScopeRequest } from '../model/scope.js';
import type { ApprovalWatch } from './state.js';
import type { DaemonEffects } from './effects.js';

/** Every kind the control plane folds an item's decision history from (server/decision-ledger.ts). */
export const decisionEventKinds = ['requested', 'concurred', 'refused', 'declined', 'approved', 'applied', 'failed', 'stale', 'withdrawn', 'superseded'].map(kind => `decision.${kind}`);
type DecisionHistory = Awaited<ReturnType<NonNullable<DaemonEffects['decisions']>>>['decisions'];
/** The decision histories the loop keeps across cycles, by work id, and the ledger seq they are current to. */
export interface HeldDecisions { seq: string | null; histories: Map<string, DecisionHistory>; refreshedAt: number | null }
export const emptyHeldDecisions = (): HeldDecisions => ({ seq: null, histories: new Map(), refreshedAt: null });
/** How many history reads the decisions step has in flight at once. */
export const decisionReadConcurrency = 8;
/** How long the decisions step's control-plane reads may take in all, from the step's start (GY-1241). */
export const decisionReadDeadlineMs = 10_000;
/**
 * GY-1293. A request that failed only because its history read missed the step's deadline: its
 * read was still started, so it is asked again on the next cycle, never on the widening backoff.
 */
export const lateDecisionRead = (detail: string) => / ms read deadline passed before .+ answered; it is read again next cycle/.test(detail);
/** How long a kept history may go without being read afresh, whatever the ledger says (GY-1241). */
export const decisionRefreshMs = 30 * 60_000;
/**
 * GY-1142. The decisions step read each item's decision history from the control plane once for
 * every place it looked — the request, its supervision, the moved-past sweep, the hand-launched
 * approvers — on every cycle, one at a time: at about 90 open items and hundreds of decisions that
 * was most of a three-minute cycle, and every merge, refresh and close waited behind it.
 *
 * The step now sees its effects through this. A history is read at most once per cycle, and one
 * read on an earlier cycle is kept while the ledger shows no decision of that item moved since:
 * a single `decisionChanges` read per cycle names the items that did. Its own `decide` and
 * `withdraw` calls drop the item's history, so whatever the step wrote it reads back. The
 * items with a watch still open are read before the step reaches them, `decisionReadConcurrency`
 * at a time. Without `decisionChanges`, or when it cannot be read, nothing is kept from one cycle
 * to the next.
 *
 * GY-1241. The reads share one deadline, `decisionReadDeadlineMs` from the step's start: a read
 * still unanswered then rejects, so a slow control plane makes the histories unknown for this cycle
 * (each caller waits on an unknown history) rather than holding the step for a request timeout per
 * item. A read the step reaches after the deadline is still started, and rejected at once: what
 * answers is kept for the next cycle, so an item the step reaches late is never starved of its read
 * however long the step's other work takes. The read-ahead awaits the reads themselves, not the
 * deadline, so it stays `decisionReadConcurrency` at a time. A ledger event whose seq was taken before the cursor but committed after it is never
 * named by `decisionChanges`, so every kept history is dropped and read afresh at least every
 * `decisionRefreshMs`. A kept history is handed out as a copy: no caller can change what later
 * cycles read.
 *
 * GY-1293. The read-ahead takes first the items whose refused scope request the step may put to
 * an approver this cycle, then the open watches. A worker waits on that request, inside the scope
 * budget: read only when the step reached it, its history missed the deadline behind every slower
 * read ahead of it, cycle after cycle (GY-1287 on 5 October 2026, twice, until the budget passed).
 */
export async function decisionReads(effects: DaemonEffects, held: HeldDecisions, open: readonly Work[], watched: readonly ApprovalWatch[], clock = Date.now(), deadlineMs = decisionReadDeadlineMs) {
  const until = performance.now() + deadlineMs;
  const late = (what: string) => new Error(`the decisions step's ${deadlineMs} ms read deadline passed before ${what} answered; it is read again next cycle`);
  const bounded = <T>(made: Promise<T>, what: string): Promise<T> => {
    const left = until - performance.now();
    if (left <= 0) { made.catch(() => undefined); return Promise.reject(late(what)); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(late(what)), left); timer.unref?.(); });
    return Promise.race([made, expired]).finally(() => clearTimeout(timer));
  };
  const ids = new Set(open.map(item => item.id));
  for (const id of held.histories.keys()) if (!ids.has(id)) held.histories.delete(id);
  if (held.refreshedAt === null || clock - held.refreshedAt >= decisionRefreshMs) { held.histories.clear(); held.refreshedAt = clock; }
  const moved = effects.decisions && effects.decisionChanges ? await bounded(effects.decisionChanges(held.seq), 'the decision ledger').catch(() => null) : null;
  if (!moved || !moved.complete) held.histories.clear();
  else for (const id of moved.work) held.histories.delete(id);
  if (moved) held.seq = moved.seq;
  const reading = new Map<string, ReturnType<NonNullable<DaemonEffects['decisions']>>>();
  const read = (item: Work): ReturnType<NonNullable<DaemonEffects['decisions']>> => {
    const kept = held.histories.get(item.id);
    if (kept) return Promise.resolve({ decisions: structuredClone(kept) });
    return bounded(start(item), `${item.key}'s decision history`);
  };
  /** The item's history read, started if none is in flight, unbounded: what answers is kept. */
  const start = (item: Work) => {
    let pending = reading.get(item.id);
    if (!pending) {
      reading.set(item.id, pending = effects.decisions!(item));
      pending.then(result => { if (reading.get(item.id) === pending) held.histories.set(item.id, structuredClone(result.decisions)); }, () => { if (reading.get(item.id) === pending) reading.delete(item.id); });
    }
    return pending;
  };
  const moves = (item: Work) => { held.histories.delete(item.id); reading.delete(item.id); };
  const writes = <A extends unknown[], R>(call: ((item: Work, ...rest: A) => Promise<R>) | undefined) =>
    call && ((item: Work, ...rest: A) => { moves(item); const made = call(item, ...rest); made.then(() => moves(item), () => moves(item)); return made; });
  const reads: DaemonEffects = new Proxy(effects, { get: (target, property, receiver) => {
    if (property === 'decisions') return target.decisions && read;
    if (property === 'decide' || property === 'withdraw') return writes(Reflect.get(target, property, receiver));
    return Reflect.get(target, property, receiver);
  } });
  // The waiting scope requests' and open watches' histories are read ahead, a bounded few at a time, while the step works.
  const keys = new Set(watched.filter(watch => !watch.settledAt).map(watch => watch.work));
  const scoped = open.filter(item => item.stage !== 'done' && !!routableScopeRequest(item, clock));
  const ahead = effects.decisions ? [...scoped, ...open.filter(item => keys.has(item.key) && !scoped.includes(item))].filter(item => !held.histories.has(item.id)) : [];
  const next = async (): Promise<void> => { const item = ahead.shift(); if (item) { if (!held.histories.has(item.id)) await start(item).catch(() => undefined); return next(); } };
  void Promise.all(Array.from({ length: decisionReadConcurrency }, next));
  return reads;
}

/**
 * Why an approved decision the loop reads must be settled rather than waited on, or null (GY-1297):
 * the item moved past the situation it was bound to, or it has stood approved and unapplied past
 * the grace its own approval had to apply it. Without the item's candidate (a watch read alone)
 * only the stall is judged; the settlement the loop sends judges the situation on the server.
 */
export function unsettledApproval(work: Pick<Work, 'key'> & Partial<Pick<Work, 'candidate'>>, decision: { id: string; action: string; state: string; approvedBy?: string | null; approvedAt?: string | null; situation?: DecisionSituation | null }, now: number): string | null {
  const moved = work.candidate === undefined ? null : supersededSituation(decision, { candidate: work.candidate });
  if (moved) return `${decision.action} decision ${decision.id} on ${work.key} was approved for ${situationLabel(moved.bound)}, but the item is now at ${situationLabel(moved.current)}; it is superseded so the current candidate's request is judged`;
  if (stalledApproval(decision, now)) return `${decision.action} decision ${decision.id} on ${work.key} was approved by ${decision.approvedBy ?? 'its approver'} at ${decision.approvedAt} and no outcome was recorded within ${Math.round(approvalApplyGraceMs / 1000)}s; its application is resumed so it settles applied or failed`;
  return null;
}
