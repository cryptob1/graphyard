import type { Work } from '../../src/model';

const MAX_LEAD = 110;

/** One short line, at most `limit` characters, with a trailing ellipsis when cut. */
export function shortLine(text: string, limit = MAX_LEAD): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 1).trimEnd()}…`;
}

/** First sentence of a longer fallback text, cut at `limit` characters with an ellipsis. */
function firstSentenceShort(text: string, limit = MAX_LEAD): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const match = clean.match(/^.+?[.!?](?=\s|$)/);
  return shortLine(match ? match[0] : clean, limit);
}

/**
 * GY-3574: one short line under a Work row's title — `item.summary` when set, otherwise the
 * fallback lead (`why` / `simplest`, or the first sentence of `description` when it adds beyond
 * the title), cut at 110 characters with an ellipsis. The full description stays on the item page.
 */
export function rowLeadText(item: Pick<Work, 'title' | 'summary' | 'plainSummary' | 'why' | 'simplest' | 'description'>): string {
  const summary = typeof item.summary === 'string' ? item.summary.trim() : item.plainSummary?.trim() ?? '';
  if (summary) return shortLine(summary);
  const lead = [item.why, item.simplest].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (lead) return lead.length <= MAX_LEAD ? lead : firstSentenceShort(lead);
  const description = typeof item.description === 'string' ? item.description.replace(/\s+/g, ' ').trim() : '';
  const title = item.title.trim();
  if (description && description !== title && description !== `${title}.`) return firstSentenceShort(description);
  return '';
}

/**
 * GY-3382 / GY-3574: one short line under a Work row's title; an item with nothing to add beyond
 * its title shows nothing.
 */
export default function ItemLead({ item }: { item: Pick<Work, 'title' | 'summary' | 'plainSummary' | 'why' | 'simplest' | 'description'> }) {
  const text = rowLeadText(item);
  if (!text) return null;
  return <span className="row-lead muted" data-lead>{text}</span>;
}
