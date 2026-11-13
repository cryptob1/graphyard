import { useEffect, useLayoutEffect, useRef } from 'react';
import { readFun } from './fun';

// The dashboard's unit tests render the Work page to static markup: there the effect is a plain
// one (never run), on the page it lands before the browser paints, where a glide must begin.
const useGlideEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * Rows glide to their new group when an item changes stage (GY-3272 AC-4b) instead of jumping:
 * after every render of the Work page, a row that was somewhere else on its last paint is set
 * down where it was and transitioned — transform only, so the compositor moves it — to where it
 * now belongs. The glide never runs with Fun off or under reduced motion, and it never blocks
 * input: the row is interactive for the whole 450 ms.
 */
export function useGlide() {
  const were = useRef(new Map<string, { left: number; top: number }>());
  useGlideEffect(() => {
    // Document-relative places, so a scroll between two renders is never mistaken for a move.
    const place = (row: HTMLElement) => { const rect = row.getBoundingClientRect(); return { left: rect.left + scrollX, top: rect.top + scrollY }; };
    const rows = [...document.querySelectorAll<HTMLElement>('.work-row')];
    const now = new Map(rows.map(row => [row.dataset.row!, place(row)]));
    if (readFun() && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const [key, was] of were.current) {
        const row = rows.find(candidate => candidate.dataset.row === key);
        const fresh = row ? now.get(key) : undefined;
        if (!row || !fresh) continue;
        const dx = was.left - fresh.left, dy = was.top - fresh.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        row.classList.add('glide');
        row.style.transition = 'none';
        row.style.transform = `translate(${dx}px, ${dy}px)`;
        row.getBoundingClientRect(); // reflow, so the row is set down where it was before it glides
        row.style.transition = 'transform 450ms cubic-bezier(.2,.8,.2,1)';
        row.style.transform = '';
        const land = () => { row.style.transition = ''; row.style.transform = ''; row.classList.remove('glide'); };
        row.addEventListener('transitionend', land, { once: true });
        setTimeout(land, 600);
      }
    }
    were.current = now;
  });
}
