import { agentOwner, type AttentionItem } from './master.js';
import type { Work } from './model.js';
import { producerLedgerSpec } from './producer.js';
import { reviewLedgerSpec, sessionLedgerRefusal, sessionLedgerRemedy } from './reviewer.js';

/**
 * A launch refused by a full session ledger is attributed to that ledger (GY-131).
 *
 * The refusal is local state: `.graphyard/reviews.json` or `.graphyard/producers.json` could not
 * take another record. On 2026-09-23 the review ledger was full and `master status` showed each
 * starved item as `reviewer agent review-claude-1 is busy in Herdr` — reviewer capacity — while
 * the real fault was the file. Every row whose review or producer launch carries a ledger refusal
 * (a dispatch failure, or a failed action row) gets one attention item naming the ledger, its bound,
 * the live count and the remedy, and every other attention for that item that blamed capacity or
 * repeated the raw refusal is replaced by it.
 */
export function ledgerRefusalAttention<T extends { work: any[]; attentionItems: AttentionItem[] }>(status: T, work: Work[]): T {
  const refusals = new Map<string, RegExpMatchArray>();
  for (const row of status.work as { key: string; dispatch?: { review: { failure?: { reason: string } | null } | null; producers: { failure?: { reason: string } | null }[] } | null }[]) {
    const item = work.find(candidate => candidate.key === row.key);
    const reasons = [row.dispatch?.review?.failure?.reason, ...(row.dispatch?.producers ?? []).map(request => request.failure?.reason),
      ...(item?.actionQueue?.actions ?? []).flatMap(action => [action.resolution, action.history.filter(entry => entry.event === 'failed').at(-1)?.reason])];
    const match = reasons.map(reason => reason?.match(sessionLedgerRefusal)).find(Boolean);
    if (match) refusals.set(row.key, match);
  }
  if (!refusals.size) return status;
  const items = new Map<string, AttentionItem>();
  const rows = status.work.map((row: { key: string; attention: string | null }) => {
    const match = refusals.get(row.key);
    if (!match) return row;
    const [, kind, path, bound, live] = match;
    const spec = kind === 'review' ? reviewLedgerSpec : producerLedgerSpec;
    const text = `${row.key}'s ${kind === 'review' ? 'review' : 'proof producer'} cannot be requested because the ${spec.name} (${path}) refused the write: its bound is ${bound} records and ${live} are live sessions. This is local state, not ${spec.role} capacity`;
    const item: AttentionItem = { subject: row.key, text, ...agentOwner('master', `${sessionLedgerRemedy(spec)}; master status reports the ledger's headroom under ledgers`) };
    items.set(row.key, item);
    const { subject, text: attention, ...owner } = item;
    return { ...row, attention, attentionOwner: owner };
  });
  // What the item used to say — the busy agent, the raw launch refusal, a stalled row repeating it — gives way to the one ledger item.
  const superseded = (entry: AttentionItem) => items.has(entry.subject) && (sessionLedgerRefusal.test(entry.text) || /is busy in Herdr|launch for \S+ refused|request-review action/i.test(entry.text));
  return { ...status, work: rows, attentionItems: [...status.attentionItems.filter(entry => !superseded(entry)), ...items.values()] };
}
