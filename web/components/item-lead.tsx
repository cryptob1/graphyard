import type { Work } from '../../src/model';

/**
 * GY-3382: an item's two lead sentences — how it helps users, and why it is the simplest thing that
 * works — at the top of its page and as its summary in the Work list. An item from before them has
 * neither and shows nothing.
 */
export default function ItemLead({ item, row }: { item: Pick<Work, 'why' | 'simplest'>; row?: boolean }) {
  if (!item.why && !item.simplest) return null;
  if (row) return <span className="row-lead muted" data-lead>{[item.why, item.simplest].filter(Boolean).join(' ')}</span>;
  return <div className="item-lead" data-lead>
    {item.why && <p data-why><strong>Why:</strong> {item.why}</p>}
    {item.simplest && <p data-simplest><strong>Simplest:</strong> {item.simplest}</p>}
  </div>;
}
