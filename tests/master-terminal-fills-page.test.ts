import test from 'node:test';
import assert from 'node:assert/strict';
import { fillsThePage, type FillSample } from '../browser-tests/terminal-fill.js';
import type { Page } from '@playwright/test';

/** A screen that fills its container: the pane's last column is at the right edge, its rows fill the height. */
const filled: FillSample = { right: 0.2, bottom: 0.3, drawnRows: 24, rows: 24, documentScrolls: false };

/** A page whose measurements follow SCRIPT and then hold LAST forever, as the Master page's terminal does. */
const scripted = (script: (FillSample | null)[], last: FillSample | null) => ({
  page: {
    evaluate: async () => script.length ? script.shift()! : last,
    waitForTimeout: (ms: number) => new Promise<void>(done => setTimeout(done, ms)),
  } as unknown as Page,
});

test(`unit:test-browser-tests-master-terminal-fills-page-spec-ts-pinned — the fill check waits for the fill to hold
across a reconnect's asynchronous buffer rewrite instead of measuring one instant, and still fails a pane that does not fill its page`, async () => {
  // The reconnect race (GY-3372): the pane still shows the pre-drop screen (filled), then the
  // reattach's scrollback rewrite blanks it mid-render (null) before the live redraw repaints it.
  // Measuring one instant passed on the stale screen and then crashed reading the null sample.
  const raced = scripted([filled, null, null, filled], filled);
  await fillsThePage(raced.page, 2_000, 60, 1);
  // A pane whose drawing leaves a gap, or a page whose document scrolls, never holds the window,
  // so the check still fails on a pane that does not fill its page.
  const gapped = scripted([], { ...filled, right: 5 });
  await assert.rejects(fillsThePage(gapped.page, 150, 60, 1), /does not fill its container/);
  const scrolling = scripted([], { ...filled, documentScrolls: true });
  await assert.rejects(fillsThePage(scrolling.page, 150, 60, 1), /does not fill its container/);
});
