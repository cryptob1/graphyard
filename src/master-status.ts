import { agentOwner, type AttentionItem } from './master.js';
import type { ActionRow } from './model/actions.js';
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
 * repeated the raw refusal is replaced by it. Only a refusal that stands now counts: a dispatch
 * failure, a failed resolution, a stall, or an action whose latest event is a failure — an action
 * that failed once on a full ledger and has since been claimed again or completed says nothing
 * about the file.
 * `counts.attention`, when given, is moved by exactly the items removed and added, so it keeps
 * matching the list.
 */
export function ledgerRefusalAttention<T extends { work: any[]; attentionItems: AttentionItem[]; counts?: { attention: number } }>(status: T, work: Work[]): T {
  const refusals = new Map<string, RegExpMatchArray>();
  // What an action says now: its failed resolution, its stall, or a latest event that is a failure.
  const standing = (action: ActionRow) => [action.result === 'failed' ? action.resolution : undefined, action.stall?.reason, action.history.at(-1)?.event === 'failed' ? action.history.at(-1)!.reason : undefined];
  for (const row of status.work as { key: string; dispatch?: { review: { failure?: { reason: string } | null } | null; producers: { failure?: { reason: string } | null }[] } | null }[]) {
    const item = work.find(candidate => candidate.key === row.key);
    const reasons = [row.dispatch?.review?.failure?.reason, ...(row.dispatch?.producers ?? []).map(request => request.failure?.reason), ...(item?.actionQueue?.actions ?? []).flatMap(standing)];
    const match = reasons.map(reason => reason?.match(sessionLedgerRefusal)).find(Boolean);
    if (match) refusals.set(row.key, match);
  }
  if (!refusals.size) return status;
  const items = new Map<string, AttentionItem>(), replaced = new Map<string, string | null>();
  const rows = status.work.map((row: { key: string; attention: string | null }) => {
    const match = refusals.get(row.key);
    if (!match) return row;
    const [, kind, path, bound, live] = match;
    const spec = kind === 'review' ? reviewLedgerSpec : producerLedgerSpec;
    const text = `${row.key}'s ${kind === 'review' ? 'review' : 'proof producer'} cannot be requested because the ${spec.name} (${path}) refused the write: its bound is ${bound} records and ${live} are live sessions. This is local state, not ${spec.role} capacity`;
    const item: AttentionItem = { subject: row.key, text, ...agentOwner('master', `${sessionLedgerRemedy(spec)}; master status reports the ledger's headroom under ledgers`) };
    items.set(row.key, item); replaced.set(row.key, row.attention);
    const { subject, text: attention, ...owner } = item;
    return { ...row, attention, attentionOwner: owner };
  });
  // What the item used to say — its row's attention, the busy agent, the raw launch refusal, a stalled row repeating it — gives way to the one ledger item.
  const superseded = (entry: AttentionItem) => items.has(entry.subject) && (entry.text === replaced.get(entry.subject) || sessionLedgerRefusal.test(entry.text) || /is busy in Herdr|launch for \S+ refused|request-review action/i.test(entry.text));
  const attentionItems = [...status.attentionItems.filter(entry => !superseded(entry)), ...items.values()];
  const counts = status.counts && { ...status.counts, attention: status.counts.attention + attentionItems.length - status.attentionItems.length };
  return { ...status, work: rows, attentionItems, ...(counts ? { counts } : {}) };
}
