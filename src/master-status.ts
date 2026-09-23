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
 * repeated the raw refusal is replaced by it. The row's own attention is replaced only when it is
 * about a launch; one ranked above it (quarantine, a human-only park, a merge violation) stays,
 * with its owner, and the ledger item is listed beside it. Only a refusal that stands now counts:
 * a dispatch failure, or an action back in the queue whose latest event is a failure — an action
 * that failed once on a full ledger and has since been claimed again or completed says nothing
 * about the file.
 * `counts.attention`, when given, is moved by exactly the items removed and added, so it keeps
 * matching the list.
 */
export function ledgerRefusalAttention<T extends { work: any[]; attentionItems: AttentionItem[]; counts?: { attention: number } }>(status: T, work: Work[]): T {
  // Per item, one standing refusal per ledger: a refused review and a refused producer launch are separate faults.
  const refusals = new Map<string, Map<LedgerKind, RegExpMatchArray>>();
  // What an action says now: its failed resolution, its stall, or a latest event that is a failure.
  // A reclaimed row keeps its last failure and stall while the new attempt runs, so only a row
  // back in the queue with a failure as its latest event is still refused.
  const standing = (action: ActionRow) => action.state !== 'pending' || action.history.at(-1)?.event !== 'failed' ? []
    : [action.resolution, action.stall?.reason, action.history.at(-1)!.reason];
  for (const row of status.work as { key: string; dispatch?: { review: { failure?: { reason: string } | null } | null; producers: { failure?: { reason: string } | null }[] } | null }[]) {
    const item = work.find(candidate => candidate.key === row.key);
    const reasons = [row.dispatch?.review?.failure?.reason, ...(row.dispatch?.producers ?? []).map(request => request.failure?.reason), ...(item?.actionQueue?.actions ?? []).flatMap(standing)];
    const byKind = new Map<LedgerKind, RegExpMatchArray>();
    for (const match of reasons.map(reason => reason?.match(sessionLedgerRefusal))) if (match && !byKind.has(match[1] as LedgerKind)) byKind.set(match[1] as LedgerKind, match);
    if (byKind.size) refusals.set(row.key, byKind);
  }
  if (!refusals.size) return status;
  const items: AttentionItem[] = [], replaced = new Map<string, string | null>();
  const rows = status.work.map((row: { key: string; attention: string | null }) => {
    const byKind = refusals.get(row.key);
    if (!byKind) return row;
    const own = [...byKind.values()].map(([, kind, path, bound, live]) => {
      const spec = kind === 'review' ? reviewLedgerSpec : producerLedgerSpec;
      const text = `${row.key}'s ${kind === 'review' ? 'review' : 'proof producer'} cannot be requested because the ${spec.name} (${path}) refused the write: its bound is ${bound} records and ${live} are live sessions. This is local state, not ${spec.role} capacity`;
      return { subject: row.key, text, ...agentOwner('master', `${sessionLedgerRemedy(spec)}; master status reports the ledger's headroom under ledgers`) } as AttentionItem;
    });
    items.push(...own);
    // A row reporting something ranked above a launch — quarantine, a human-only park, an
    // unauthorized or reverted merge, an offline worker — keeps it; the ledger item is listed beside it.
    if (!aboutLaunch(row)) return row;
    replaced.set(row.key, row.attention);
    const { subject, text: attention, ...owner } = own[0];
    return { ...row, attention, attentionOwner: owner };
  });
  // What the item used to say about a refused launch — its row's attention, the busy agent, the raw
  // launch refusal, a stalled row repeating it — gives way to that ledger's item. Supersession is
  // per launch: a review ledger refusal never hides a stalled or refused producer launch, nor the reverse.
  const superseded = (entry: AttentionItem) => {
    const byKind = refusals.get(entry.subject);
    if (!byKind) return false;
    if (replaced.has(entry.subject) && entry.text === replaced.get(entry.subject)) return true;
    const kind = attentionLaunchKind(entry.text);
    return !!kind && byKind.has(kind);
  };
  const attentionItems = [...status.attentionItems.filter(entry => !superseded(entry)), ...items];
  const counts = status.counts && { ...status.counts, attention: status.counts.attention + attentionItems.length - status.attentionItems.length };
  return { ...status, work: rows, attentionItems, ...(counts ? { counts } : {}) };
}

type LedgerKind = 'review' | 'producer';

/**
 * Whether a row's attention is the item's launch, or nothing ranked above it: no attention, the
 * gate or dwell fallback, a refused, retried, unacknowledged or exhausted review or producer launch.
 */
function aboutLaunch(row: { attention: string | null; refusal?: { reason: string } | null }): boolean {
  const text = row.attention;
  if (!text || text === row.refusal?.reason || /^Work has remained at \S+ for more than one hour$/.test(text)) return true;
  if (/^Every configured reviewer profile is exhausted/.test(text)) return true;
  if (/^(Reviewer session|Producer session for \S+ proofs) of \S+ ((failed|expired) after attempt|\(\S+\) is awaiting acknowledgement)/.test(text)) return true;
  return !!attentionLaunchKind(text);
}

/** Which launch an attention text is about, when it is about a launch at all. */
function attentionLaunchKind(text: string): LedgerKind | null {
  const refusal = text.match(sessionLedgerRefusal);
  if (refusal) return refusal[1] as LedgerKind;
  if (/reviewer agent \S+ is busy in Herdr|request-review action|review launch for \S+ refused/i.test(text)) return 'review';
  if (/producer profile is busy|producer launch for \S+ refused/i.test(text)) return 'producer';
  return null;
}
