import { useState, useSyncExternalStore } from 'react';
import { mergedAt } from './groups';
import type { Work } from '../src/model';

/**
 * The dashboard's fun (GY-3268): friendly agent names, a line about building at the top of the
 * Work page, playful empty states and a small celebration when work ships. Dashboard only — the CLI
 * and agent prompts stay plain. The Fun toggle in the page menu turns it all off (remembered per
 * browser); with it off, names and lines fall back to the plain text, and reduced motion stops the confetti.
 */
const KEY = 'graphyard.fun';
const listeners = new Set<() => void>();
const readFun = () => { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } };
export function setFun(on: boolean) { try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* private mode: this page only */ } listeners.forEach(listener => listener()); }
export const useFun = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, readFun, () => true);

const NAMES = ['Ada', 'Juno', 'Pixel', 'Milo', 'Nova', 'Otto', 'Iris', 'Felix', 'Luna', 'Hugo', 'Wren', 'Theo', 'Mabel', 'Ziggy', 'Pip', 'Rosa', 'Arlo', 'Cleo', 'Basil', 'Echo',
  'Fern', 'Gus', 'Hazel', 'Indy', 'Jasper', 'Kit', 'Lark', 'Moss', 'Nico', 'Olive', 'Percy', 'Quinn', 'Ruby', 'Sage', 'Tilly', 'Umi', 'Vera', 'Wally', 'Xena', 'Yuki',
  'Zara', 'Bea', 'Cosmo', 'Dot', 'Elio', 'Flo', 'Gem', 'Hank', 'Ivy', 'Jett', 'Kai', 'Lola', 'Max', 'Nell', 'Oz', 'Poppy', 'Remy', 'Sunny', 'Toby', 'Uma',
  'Vito', 'Willa', 'Yara', 'Zed', 'Alma', 'Bram', 'Coco', 'Dex', 'Esme', 'Fitz', 'Greta', 'Hux', 'Ines', 'Jojo', 'Kip', 'Lenny', 'Mira', 'Ned', 'Opal', 'Pike',
  'Rue', 'Sol', 'Tess', 'Ugo', 'Vale', 'Wim', 'Xavi', 'Yoyo', 'Zuzu', 'Aggie', 'Bix', 'Dara', 'Eli', 'Fable', 'Gil', 'Hopper', 'Juniper', 'Koko', 'Lumen', 'Mochi'];

const isMaster = (id: string) => /master/.test(id);
/** Ids that are not an agent account: Graphyard itself and the people who run it keep their own names. */
const unnamed = (id: string) => id === 'graphyard' || /operator|admin|human/.test(id);
/** An account's friendly name: the same on every page and every install, from its id alone. The master is always the Foreman. */
export function friendlyName(id: string): string | null {
  if (isMaster(id)) return 'the Foreman';
  if (unnamed(id)) return null;
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return NAMES[(hash >>> 0) % NAMES.length];
}
/** An account as the dashboard names it: its friendly name with the account id on hover, or the id itself with Fun off. */
export function Agent({ id, master, detail }: { id: string; master?: boolean; detail?: string }) {
  const fun = useFun(), name = fun ? (master ? 'the Foreman' : friendlyName(id)) : null;
  return <span className="agent" data-agent={id} title={detail ? `${id} · ${detail}` : id}>{name ?? id}</span>;
}

/** A quiet state's line: playful with Fun on, plain with it off. */
export const Playful = ({ plain, fun }: { plain: string; fun: string }) => <>{useFun() ? fun : plain}</>;

export const LINES = [
  'You had an idea at breakfast. It shipped before lunch.', 'Twelve agents, zero standups.', 'The backlog is just a to-do list for the crew.',
  'Write what must be true. The yard does the rest.', 'Somewhere, an agent is writing your tests. Cheerfully.', 'Ship small, ship often, sleep well.',
  'Nobody here has ever said “works on my machine.”', 'Code review at the speed of thought.', 'Every merge is a tiny celebration.',
  'Ideas in, software out.', 'The crew never asks for a status update.', 'Your criteria are the blueprint. The agents are the builders.',
  'Reviews that never wait for Monday.', 'A green check is a love letter from the future.', 'Build the thing, not the process.',
  'The yard runs while you sleep.', 'Fewer meetings, more merges.', 'Today is a good day to delete code.',
  'One goal, many hands, no handoffs.', 'The fastest code review is the one already done.', 'Coffee for you. Commits for them.',
  'Every item has a builder, a reviewer and a happy ending.', 'Proof beats promises.', 'Small changes, big days.',
  'The robots are building. You are deciding.', 'File it before you forget it. Ship it before you need it.', 'Somebody always has the next item.',
  'Main stays green. Spirits stay high.', 'Good software is a thousand small yeses.', 'From “what if” to “it’s live” in one sitting.',
  'The crew loves a clear acceptance criterion.', 'Fresh worktree, fresh start.', 'Building software is fun again.',
  '“The best way to predict the future is to invent it.” — Alan Kay', '“Simplicity is prerequisite for reliability.” — Edsger Dijkstra',
  '“Make it work, make it right, make it fast.” — Kent Beck', '“Real artists ship.” — Steve Jobs', '“Done is better than perfect.” — Sheryl Sandberg',
  '“What I cannot create, I do not understand.” — Richard Feynman', '“The details are not the details. They make the design.” — Charles Eames',
];
/** The Work page header's line: a new one per page load, the next one on a tap. Nothing with Fun off. */
export function BuildLine() {
  const fun = useFun();
  const [index, setIndex] = useState(() => Math.floor(Math.random() * LINES.length));
  if (!fun) return null;
  return <button type="button" className="build-line" title="Another one" data-fun data-build-line={index} onClick={() => setIndex(value => (value + 1) % LINES.length)}>{LINES[index]}</button>;
}

const day = 24 * 60 * 60 * 1000;
const startOfDay = (at: number) => { const date = new Date(at); date.setHours(0, 0, 0, 0); return date.getTime(); };
/** How many items merged today, and for how many days in a row, ending today, at least one did. */
export function shippedToday(work: Work[], now = Date.now()) {
  const days = new Set(work.filter(w => w.stage === 'done' && !!(w.delivery?.mergedAt ?? w.observation?.mergedAt)).map(w => startOfDay(mergedAt(w))));
  const today = startOfDay(now);
  const count = work.filter(w => w.stage === 'done' && !!(w.delivery?.mergedAt ?? w.observation?.mergedAt) && startOfDay(mergedAt(w)) === today).length;
  let streak = 0;
  for (let at = today; days.has(at); at = startOfDay(at - day / 2)) streak++;
  return { count, streak };
}
export function ShippedToday({ work }: { work: Work[] }) {
  const fun = useFun(), { count, streak } = shippedToday(work);
  if (!fun) return null;
  return <span className="shipped-today" aria-label="Shipped today" data-fun data-shipped-today={count}>🚢 {count} shipped today{streak > 1 ? ` · 🔥 ${streak}-day streak` : ''}</span>;
}

/** The agent that built an item: the last implementer, or the lease holder. */
export const builderOf = (w: Work) => w.implementers?.at(-1) ?? w.lease?.owner ?? null;
/** A brief confetti burst, a few dozen CSS pieces that remove themselves. None with Fun off or reduced motion set. */
export function confetti() {
  if (!readFun() || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const burst = document.createElement('div');
  burst.className = 'confetti'; burst.setAttribute('aria-hidden', 'true');
  for (let n = 0; n < 40; n++) {
    const piece = document.createElement('i');
    piece.style.cssText = `left:${Math.random() * 100}%;background:hsl(${Math.random() * 360} 90% 60%);animation-delay:${Math.random() * 0.4}s;--drift:${Math.random() * 200 - 100}px`;
    burst.append(piece);
  }
  document.body.append(burst);
  setTimeout(() => burst.remove(), 2200);
}
/** The toast when an item merges while the page is open: who built it and what. */
export function ShippedToast({ item, onClose }: { item: Work; onClose(): void }) {
  const fun = useFun(), builder = builderOf(item), name = builder && fun ? friendlyName(builder) ?? builder : builder;
  return <div className="toast" aria-live="polite" data-toast={item.key} onClick={onClose}>
    {builder ? <span title={builder}>{name}</span> : 'Graphyard'} shipped “{item.title}”{fun ? ' 🎉' : ''}
  </div>;
}
