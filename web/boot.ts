import { readFun } from './fun';

/**
 * The one-second boot sequence (GY-3272 AC-4a): once per browser session the yard switches on —
 * the neon logo flickers in, a few lines of system readout type out, then the page. Any key or
 * click skips it at once. It never runs under reduced motion, with Fun off, or in Daylight, and
 * it never blocks input: the veil ignores the pointer and the dashboard renders beneath it.
 */
const READOUT = ['graphyard control plane', 'night yard · the streetlights are on', 'the merge queue never sleeps'];

export function boot() {
  if (document.documentElement.dataset.theme === 'daylight') return;
  if (!readFun() || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // Once per browser session: the tab's own storage, so a reload (or a second visit) goes straight to the page.
  try { if (sessionStorage.getItem('graphyard.boot')) return; sessionStorage.setItem('graphyard.boot', '1'); } catch { return; }
  const veil = document.createElement('div');
  veil.className = 'boot';
  veil.dataset.boot = 'run';
  veil.setAttribute('aria-hidden', 'true');
  const logo = document.createElement('div');
  logo.className = 'boot-logo';
  logo.textContent = 'graphyard';
  const readout = document.createElement('pre');
  readout.className = 'boot-readout';
  veil.append(logo, readout);
  document.body.append(veil);
  const whole = READOUT.join('\n');
  let at = 0;
  const typing = setInterval(() => {
    at = Math.min(whole.length, at + 2);
    readout.textContent = whole.slice(0, at);
    if (at >= whole.length) clearInterval(typing);
  }, 18);
  const done = setTimeout(() => clearInterval(typing), 1100);
  const skip = () => { clearInterval(typing); clearTimeout(done); veil.remove(); };
  addEventListener('keydown', skip, { capture: true, once: true });
  document.addEventListener('pointerdown', skip, { capture: true, once: true });
  // The page's own timers fade the veil out (opacity only) and remove it inside the second.
  setTimeout(() => veil.classList.add('leaving'), 850);
  setTimeout(() => { veil.remove(); removeEventListener('keydown', skip, { capture: true }); document.removeEventListener('pointerdown', skip, { capture: true }); }, 1050);
}
