import type { Page } from '@playwright/test';

/**
 * How the pane's drawing sits in the terminal container: the host-side herdr stub's master pane is
 * laid out at 70 columns and draws a ruler, every row filled to the pane's width and ending in `|`.
 * `right` is the gap from the last drawn column to the container's right edge, `bottom` from the last
 * drawn row to its bottom edge, each in character cells.
 */
export interface FillSample { right: number; bottom: number; drawnRows: number; rows: number; documentScrolls: boolean }

/** One measurement of the pane's drawing, or null while the screen carries no ruler rows: an empty terminal, or a buffer mid-rewrite. */
const fill = (page: Page) => page.evaluate(() => {
  const host = document.querySelector('.terminal-host')!.getBoundingClientRect();
  const rows = [...document.querySelectorAll('.xterm-rows > div')].filter(row => /^row \d+ =*\|$/.test((row.textContent ?? '').trimEnd()));
  const last = rows.at(-1);
  if (!last) return null;
  const terminal = (window as any).testTerminal, screen = document.querySelector('.xterm-screen')!.getBoundingClientRect();
  const cell = { width: screen.width / terminal.cols, height: screen.height / terminal.rows };
  // The rendered `|` itself, measured off the DOM, not computed from the buffer.
  const walker = document.createTreeWalker(last, NodeFilter.SHOW_TEXT);
  let bar: DOMRect | undefined;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.textContent!.lastIndexOf('|');
    if (at >= 0) { const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + 1); bar = range.getBoundingClientRect(); }
  }
  if (!bar) return null;
  return {
    right: (host.right - bar.right) / cell.width,
    bottom: (host.bottom - last.getBoundingClientRect().bottom) / cell.height,
    drawnRows: rows.length, rows: terminal.rows,
    // The Master page document never scrolls (GY-3308).
    documentScrolls: document.scrollingElement!.scrollHeight > innerHeight + 1 || scrollY !== 0,
  };
});

/**
 * The pane's drawing spans the container's width (its last column within one cell of the right edge)
 * and its rows fill the height, and the document does not scroll. A glyph may overhang an edge by
 * sub-pixel rounding (0.05 cell), never by a visible amount.
 */
const fills = (at: FillSample | null): at is FillSample =>
  !!at && at.right >= -0.05 && at.right <= 1 && at.bottom >= -0.05 && at.bottom <= 1 && at.drawnRows === at.rows && !at.documentScrolls;

/**
 * A reconnect rewrites the pane asynchronously (GY-3372): the reattached stream's scrollback
 * replaces what was on screen and the live redraw lands over frames, so any one instant can sample
 * a half-drawn screen — measuring one moment passed on the stale pre-drop screen and then crashed
 * reading a sample that landed mid-rewrite. The check instead waits for the fill to *hold*: every
 * sample across a settling window must be a filled, non-scrolling screen, and an interruption
 * restarts the window. A pane drawn at the wrong size never holds, so the check still fails on it.
 */
export async function fillsThePage(page: Page, timeoutMs = 15_000, settleMs = 600, intervalMs = 40): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let heldSince: number | null = null, last: FillSample | null = null;
  for (;;) {
    let sample: FillSample | null = null;
    try { sample = await fill(page); } catch { /* mid-navigation: no terminal host to measure yet */ }
    if (sample) {
      last = sample;
      if (fills(sample)) {
        heldSince ??= Date.now();
        if (Date.now() - heldSince >= settleMs) return;
        await page.waitForTimeout(intervalMs);
        continue;
      }
    }
    heldSince = null;
    if (Date.now() >= deadline) throw new Error(`The terminal does not fill its container (gaps in cells): ${JSON.stringify(last)}`);
    await page.waitForTimeout(intervalMs);
  }
}
