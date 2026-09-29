import type { StatusDuration } from '../../src/model/duration';

/**
 * How long the item beside it has held its current status (GY-108). One render for every view,
 * so the number, the threshold and the overdue mark cannot differ between two places showing
 * the same item; what to show is decided once, by `statusHeld` in src/model/plain-status.ts.
 *
 * An overdue duration is never red alone. It carries the word "overdue" and a triangle, so it
 * survives greyscale, a reader who cannot separate red from green, and a screen reader, which
 * announces the visible words rather than the colour; the triangle is decoration and is hidden
 * from assistive technology so nothing is read twice.
 */
export default function StatusAge({ held }: { held: StatusDuration }) {
  return <span className={held.overdue ? 'status-age overdue' : 'status-age'} title={held.label}>
    {held.overdue && <span className="overdue-mark" aria-hidden="true">▲ </span>}{held.text}{held.overdue && ' overdue'}
  </span>;
}
