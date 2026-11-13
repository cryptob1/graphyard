import { useSyncExternalStore } from 'react';

/**
 * The dashboard's two looks (GY-3272): Night Yard, the neo-noir default — near-black blue, neon
 * accents, rain and grain — and Daylight, the plain light theme. The choice is the browser's own
 * (like the Fun toggle, web/fun.tsx): remembered under graphyard.theme, applied as
 * `<html data-theme>` before the dashboard renders, so the stylesheet's Night Yard effects key
 * off `html:not([data-theme='daylight'])` and a fresh visitor gets Night Yard with no flash.
 */
export type Theme = 'night' | 'daylight';
const KEY = 'graphyard.theme';
const listeners = new Set<() => void>();

export function readTheme(): Theme {
  try { return localStorage.getItem(KEY) === 'daylight' ? 'daylight' : 'night'; } catch { return 'night'; }
}
const apply = (theme: Theme) => { document.documentElement.dataset.theme = theme; };
/** Set the theme, remember it, and tell every listener. */
export function setTheme(theme: Theme) {
  try { localStorage.setItem(KEY, theme); } catch { /* private mode: this page only */ }
  apply(theme);
  listeners.forEach(listener => listener());
}
export const toggleTheme = () => setTheme(readTheme() === 'night' ? 'daylight' : 'night');
export const useTheme = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, readTheme, () => 'night' as Theme);
/** Once, before the dashboard renders: the remembered theme is on <html> for the first paint. */
export function applyTheme() { apply(readTheme()); }
