import { useEffect, useRef, type ReactNode } from 'react';

/** Shared keyboard boundary for drawers and forms. */
export default function Dialog({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = root.current!;
    const focusable = () => [...element.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter(e => e.getClientRects().length);
    const focusFirst = () => (focusable()[0] ?? element).focus();
    focusFirst();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key === 'Tab') {
        const items = focusable(); const index = items.indexOf(document.activeElement as HTMLElement);
        if (!items.length) { event.preventDefault(); element.focus(); }
        else if (event.shiftKey && index <= 0) { event.preventDefault(); items.at(-1)!.focus(); }
        else if (!event.shiftKey && (index < 0 || index === items.length - 1)) { event.preventDefault(); items[0].focus(); }
      }
    };
    const focusin = (event: FocusEvent) => { if (!element.contains(event.target as Node)) focusFirst(); };
    document.addEventListener('keydown', keydown); document.addEventListener('focusin', focusin);
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', keydown); document.removeEventListener('focusin', focusin); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="overlay" ref={root} tabIndex={-1} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>{children}</div>;
}
