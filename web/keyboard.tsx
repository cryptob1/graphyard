import { useEffect, useState } from 'react';
import Dialog from './dialog';
import type { Dashboard } from './pages/dashboard';
import { useTheme, toggleTheme } from './theme';

/**
 * Keyboard-first navigation (GY-3272): ⌘/Ctrl K opens the command palette (jump to any item,
 * open a page, file a goal, switch theme), j/k walk the Work rows and Enter opens the one under
 * the cursor, g w / g m / g s jump to Work, Master and Setup, and ? shows this sheet. The keys
 * stay out of the way: nothing fires while a dialog or a field has the focus.
 */

/** The one list the sheet shows and the palette's Go commands name. */
export const shortcuts: [keys: string, does: string][] = [
  ['⌘/Ctrl K', 'Command palette'],
  ['j / k', 'Move through the Work rows'],
  ['Enter', 'Open the row under the cursor'],
  ['g w', 'Go to Work'],
  ['g m', 'Go to Master'],
  ['g s', 'Go to Setup'],
  ['?', 'Show this sheet'],
  ['Esc', 'Close'],
];

interface Command { key: string; title: string; hint: string; run(): void }

/** The palette over the open dashboard: every item by key or title, then the fixed commands. */
function commandsOf(dashboard: Dashboard, theme: string): Command[] {
  const admin = dashboard.status?.actor?.role === 'admin';
  const go = (view: string) => { dashboard.setSelected(null); dashboard.setView(view); };
  return [
    ...dashboard.work.map(item => ({ key: item.key, title: item.title, hint: 'Open item', run: () => dashboard.setSelected(item.id) })),
    { key: 'g w', title: 'Work', hint: 'Go', run: () => go('work') },
    { key: 'g m', title: 'Master', hint: 'Go', run: () => go('master') },
    ...(admin ? [{ key: 'g s', title: 'Setup', hint: 'Go', run: () => go('setup') }] : []),
    ...(admin ? [{ key: '', title: 'File a goal', hint: 'New work item', run: () => dashboard.setCreating(true) }] : []),
    { key: '', title: theme === 'night' ? 'Switch to Daylight' : 'Switch to Night Yard', hint: 'Theme', run: toggleTheme },
  ];
}

/** One command row; chosen reads as selected for the keyboard and for a screen reader. */
function Choice({ command, chosen, onChoose }: { command: Command; chosen: boolean; onChoose(): void }) {
  return <li role="option" aria-selected={chosen} className={chosen ? 'palette-choice on' : 'palette-choice'} onClick={onChoose} onMouseEnter={onChoose}>
    {command.key && <span className="mono palette-key">{command.key}</span>}{command.title}<small>{command.hint}</small>
  </li>;
}

export function CommandPalette({ dashboard, onClose }: { dashboard: Dashboard; onClose(): void }) {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState(0);
  const theme = useTheme();
  const commands = commandsOf(dashboard, theme);
  const needle = query.trim().toLowerCase();
  const matches = commands.filter(command => `${command.key} ${command.title}`.toLowerCase().includes(needle));
  const run = (index: number) => { const command = matches[index]; if (!command) return; onClose(); command.run(); };
  return <Dialog onClose={onClose}><section className="modal palette" role="dialog" aria-modal="true" aria-label="Command palette">
    <input aria-label="Search commands" placeholder="Jump to an item or a command…" value={query}
      onChange={event => { setQuery(event.target.value); setChosen(0); }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setChosen(value => Math.min(matches.length - 1, value + 1)); }
        if (event.key === 'ArrowUp') { event.preventDefault(); setChosen(value => Math.max(0, value - 1)); }
        if (event.key === 'Enter') { event.preventDefault(); run(chosen); }
      }}/>
    {matches.length
      ? <ul role="listbox" aria-label="Matches">{matches.slice(0, 9).map((command, index) => <Choice key={`${command.key}:${command.title}`} command={command} chosen={index === chosen} onChoose={() => setChosen(index)}/>)}</ul>
      : <p className="muted">Nothing matches “{query.trim()}”.</p>}
    <p className="muted palette-hint">↑↓ choose · Enter run · Esc close</p>
  </section></Dialog>;
}

/** The ? sheet: every shortcut on one small dialog. */
export function ShortcutSheet({ onClose }: { onClose(): void }) {
  return <Dialog onClose={onClose}><section className="modal shortcuts" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
    <button className="close" aria-label="Close shortcuts" onClick={onClose}>×</button>
    <h2>Keyboard shortcuts</h2>
    <ul>{shortcuts.map(([keys, does]) => <li key={keys}><kbd>{keys}</kbd><span>{does}</span></li>)}</ul>
  </section></Dialog>;
}

/** The rows j/k walk, in the order the page draws them. */
const rows = () => [...document.querySelectorAll<HTMLElement>('.work-row')].filter(row => row.getClientRects().length > 0);
const clearCursor = () => document.querySelectorAll('.work-row.kb-cursor').forEach(row => row.classList.remove('kb-cursor'));

/**
 * The latest dashboard and dialogs, so the key listener below — attached once, when the dashboard
 * bundle loads — always reads the state it should. Writing it during render keeps the keys ahead
 * of React's effect scheduling: a key pressed the instant the page paints still lands.
 */
const current: { dashboard?: Dashboard; setPalette?(open: boolean): void; setSheet?(open: boolean): void } = {};
/** When the last bare 'g' landed, for the g w / g m / g s jumps that follow one. */
let gAt = 0;

const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || !!target.closest('input, textarea, select, [role="dialog"]'));

if (typeof document !== 'undefined') document.addEventListener('keydown', (event: KeyboardEvent) => {
  const { dashboard, setPalette, setSheet } = current;
  if (!dashboard || !setPalette || !setSheet) return;
  const { setSelected, setView, status } = dashboard;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (!document.querySelector('[role="dialog"]')) { setSelected(null); setPalette(true); } return; }
  if (typing(event.target) || document.querySelector('[role="dialog"]')) return;
  const move = (delta: number) => {
    const list = rows(); if (!list.length) return;
    const at = list.findIndex(row => row.classList.contains('kb-cursor'));
    const next = at < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, at + delta));
    clearCursor(); list[next].classList.add('kb-cursor'); list[next].scrollIntoView({ block: 'nearest' });
  };
  const go = (view: string) => { setSelected(null); setView(view); };
  if (event.key === 'j') { move(1); return; }
  if (event.key === 'k') { move(-1); return; }
  if (event.key === 'Enter') {
    const row = document.querySelector<HTMLElement>('.work-row.kb-cursor');
    if (row) { event.preventDefault(); (row.querySelector<HTMLElement>('.card-open') ?? row).click(); }
    return;
  }
  if (event.key === 'Escape') { clearCursor(); return; }
  if (event.key === '?') { event.preventDefault(); setSheet(true); return; }
  if (event.key === 'g' && !event.ctrlKey && !event.metaKey && !event.altKey) { gAt = Date.now(); return; }
  // A two-second window: enough for a loaded machine to deliver the next key, short enough that a
  // stray later 'w' does not jump.
  if (gAt && Date.now() - gAt < 2000) {
    gAt = 0;
    if (event.key === 'w') { event.preventDefault(); go('work'); }
    if (event.key === 'm') { event.preventDefault(); go('master'); }
    if (event.key === 's' && status?.actor?.role === 'admin') { event.preventDefault(); go('setup'); }
  }
});

/**
 * The global keys: ⌘/Ctrl K, j/k, Enter, g w / g m / g s and ?, with the palette and the sheet as
 * this component's own two dialogs. Nothing fires while a dialog is open or a field has the focus.
 */
export default function KeyboardNav({ dashboard, palette, setPalette }: { dashboard: Dashboard; palette: boolean; setPalette(open: boolean): void }) {
  const [sheet, setSheet] = useState(false);
  const { view, selected } = dashboard;
  current.dashboard = dashboard; current.setPalette = setPalette; current.setSheet = setSheet;
  useEffect(() => { clearCursor(); }, [view, selected]);
  return <>
    {palette && <CommandPalette dashboard={dashboard} onClose={() => setPalette(false)}/>}
    {sheet && <ShortcutSheet onClose={() => setSheet(false)}/>}
  </>;
}
