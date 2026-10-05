// Concern: the decision histories the decisions step reads, kept across cycles (GY-1142).
import type { Work } from '../model.js';
import type { ApprovalWatch } from './state.js';
import type { DaemonEffects } from './effects.js';

/** Every kind the control plane folds an item's decision history from (server/decision-ledger.ts). */
export const decisionEventKinds = ['requested', 'concurred', 'refused', 'declined', 'approved', 'applied', 'failed', 'stale', 'withdrawn'].map(kind => `decision.${kind}`);
type DecisionHistory = Awaited<ReturnType<NonNullable<DaemonEffects['decisions']>>>['decisions'];
/** The decision histories the loop keeps across cycles, by work id, and the ledger seq they are current to. */
export interface HeldDecisions { seq: string | null; histories: Map<string, DecisionHistory>; refreshedAt: number | null }
export const emptyHeldDecisions = (): HeldDecisions => ({ seq: null, histories: new Map(), refreshedAt: null });
/** How many history reads the decisions step has in flight at once. */
export const decisionReadConcurrency = 8;
/** How long the decisions step's control-plane reads may take in all, from the step's start (GY-1241). */
export const decisionReadDeadlineMs = 10_000;
/** How long a kept history may go without being read afresh, whatever the ledger says (GY-1241). */
export const decisionRefreshMs = 5 * 60_000;
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
 * still unanswered then rejects, and none is started after it, so a slow control plane makes the
 * histories unknown for this cycle (each caller waits on an unknown history) rather than holding
 * the step for a request timeout per item. A read that answers late is still kept for the next
 * cycle. A ledger event whose seq was taken before the cursor but committed after it is never
 * named by `decisionChanges`, so every kept history is dropped and read afresh at least every
 * `decisionRefreshMs`. A kept history is handed out as a copy: no caller can change what later
 * cycles read.
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
    let pending = reading.get(item.id);
    if (!pending) {
      if (performance.now() >= until) return Promise.reject(late(`${item.key}'s decision history`));
      reading.set(item.id, pending = effects.decisions!(item));
      pending.then(result => { if (reading.get(item.id) === pending) held.histories.set(item.id, structuredClone(result.decisions)); }, () => { if (reading.get(item.id) === pending) reading.delete(item.id); });
    }
    return bounded(pending, `${item.key}'s decision history`);
  };
  const moves = (item: Work) => { held.histories.delete(item.id); reading.delete(item.id); };
  const writes = <A extends unknown[], R>(call: ((item: Work, ...rest: A) => Promise<R>) | undefined) =>
    call && ((item: Work, ...rest: A) => { moves(item); const made = call(item, ...rest); made.then(() => moves(item), () => moves(item)); return made; });
  const reads: DaemonEffects = new Proxy(effects, { get: (target, property, receiver) => {
    if (property === 'decisions') return target.decisions && read;
    if (property === 'decide' || property === 'withdraw') return writes(Reflect.get(target, property, receiver));
    return Reflect.get(target, property, receiver);
  } });
  // The open watches' histories are read ahead, a bounded few at a time, while the step works.
  const keys = new Set(watched.filter(watch => !watch.settledAt).map(watch => watch.work));
  const ahead = effects.decisions ? open.filter(item => keys.has(item.key) && !held.histories.has(item.id)) : [];
  const next = async (): Promise<void> => { const item = ahead.shift(); if (item) { await read(item).catch(() => undefined); return next(); } };
  void Promise.all(Array.from({ length: decisionReadConcurrency }, next));
  return reads;
}
