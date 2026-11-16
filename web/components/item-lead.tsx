import type { Work } from '../../src/model';

/**
 * GY-3382: an item's two lead sentences — how it helps users, and why it is the simplest thing
 * that works — as its summary in the Work list. The item's own page leads with the why sentence
 * as its heading (GY-3392); an item from before the sentences has neither and shows nothing.
 */
export default function ItemLead({ item }: { item: Pick<Work, 'why' | 'simplest'> }) {
  if (!item.why && !item.simplest) return null;
  return <span className="row-lead muted" data-lead>{[item.why, item.simplest].filter(Boolean).join(' ')}</span>;
}
