// Concern: the decision histories the decisions step reads, kept across cycles (GY-1142).
import type { Work } from '../model.js';
import type { ApprovalWatch } from './state.js';
import type { DaemonEffects } from './effects.js';

/** Every kind the control plane folds an item's decision history from (server/decision-ledger.ts). */
export const decisionEventKinds = ['requested', 'concurred', 'refused', 'declined', 'approved', 'applied', 'failed', 'stale', 'withdrawn'].map(kind => `decision.${kind}`);
type DecisionHistory = Awaited<ReturnType<NonNullable<DaemonEffects['decisions']>>>['decisions'];
/** The decision histories the loop keeps across cycles, by work id, and the ledger seq they are current to. */
export interface HeldDecisions { seq: string | null; histories: Map<string, DecisionHistory> }
export const emptyHeldDecisions = (): HeldDecisions => ({ seq: null, histories: new Map() });
/** How many history reads the decisions step has in flight at once. */
export const decisionReadConcurrency = 8;
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
 */
export async function decisionReads(effects: DaemonEffects, held: HeldDecisions, open: readonly Work[], watched: readonly ApprovalWatch[]) {
  const ids = new Set(open.map(item => item.id));
  for (const id of held.histories.keys()) if (!ids.has(id)) held.histories.delete(id);
  const moved = effects.decisions && effects.decisionChanges ? await effects.decisionChanges(held.seq).catch(() => null) : null;
  if (!moved || !moved.complete) held.histories.clear();
  else for (const id of moved.work) held.histories.delete(id);
  if (moved) held.seq = moved.seq;
  const reading = new Map<string, ReturnType<NonNullable<DaemonEffects['decisions']>>>();
  const read = (item: Work) => {
    const kept = held.histories.get(item.id);
    if (kept) return Promise.resolve({ decisions: kept });
    let pending = reading.get(item.id);
    if (!pending) {
      reading.set(item.id, pending = effects.decisions!(item));
      pending.then(result => { if (reading.get(item.id) === pending) held.histories.set(item.id, result.decisions); }, () => { if (reading.get(item.id) === pending) reading.delete(item.id); });
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
  // The open watches' histories are read ahead, a bounded few at a time, while the step works.
  const keys = new Set(watched.filter(watch => !watch.settledAt).map(watch => watch.work));
  const ahead = effects.decisions ? open.filter(item => keys.has(item.key) && !held.histories.has(item.id)) : [];
  const next = async (): Promise<void> => { const item = ahead.shift(); if (item) { await read(item).catch(() => undefined); return next(); } };
  void Promise.all(Array.from({ length: decisionReadConcurrency }, next));
  return reads;
}
