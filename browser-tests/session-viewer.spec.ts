import { test, expect, type Page } from '@playwright/test';

// GY-713 AC-2: the Workers page lists every session a loop has published a live view of, with its
// role, runtime, account, state and age; "Watch live" opens a read-only terminal view whose tail
// updates as the loop publishes it. The page is served a stubbed running session whose tail grows
// on every read; nothing is ever posted to it, and the view holds no input control.

const now = Date.now();
const startedAt = new Date(now - 4 * 60_000).toISOString();
const summary = { work: 'work-7', session: 'gy-7-review', role: 'reviewer', runtime: 'claude', account: 'claude-b', principal: 'reviewer-a', startedAt, surface: 'herdr',
  attach: 'herdr pane attach w1:p7 --workspace w1', transcript: '/home/agent/.claude/projects/gy-7/transcript.jsonl', host: 'agent-host-1', stale: false, error: null };

async function open(page: Page) {
  const writes: string[] = [];
  let reads = 0;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (route.request().headers().authorization !== 'Bearer browser-fixture') return route.fulfill({ status: 401, json: { error: 'Rejected' } });
    if (route.request().method() !== 'GET') { writes.push(url.pathname); return route.fulfill({ json: {} }); }
    const at = new Date().toISOString();
    if (url.pathname.endsWith('/status')) return route.fulfill({ json: { actor: { id: 'fixture', role: 'admin', sessionKind: 'human' }, github: true, reviewProviders: ['github'], repository: 'fixture/repository', jobs: [] } });
    if (url.pathname.endsWith('/work-snapshot')) return route.fulfill({ json: { work: [], now: at, jobs: [] } });
    if (url.pathname === '/api/session-tails') return route.fulfill({ json: { tails: [{ ...summary, readAt: at, publishedAt: at, lineCount: reads }] } });
    if (url.pathname === '/api/work/work-7/session-tails/gy-7-review') {
      reads++;
      const lines = Array.from({ length: 30 + reads }, (_, index) => `review step ${index + 1}`);
      return route.fulfill({ json: { ...summary, readAt: at, publishedAt: at, lines } });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto('/');
  await page.getByLabel('Access token').fill('browser-fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  const menu = page.getByRole('button', { name: 'Menu' });
  if (page.viewportSize()!.width <= 650 && await menu.getAttribute('aria-expanded') !== 'true') await menu.click();
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Workers', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Workers', level: 1 })).toBeVisible();
  return { writes };
}

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'phone', width: 375, height: 812 }]) {
  test(`unit:session-viewer-read-only — a running session opens a read-only live view whose tail updates, with no input control (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const { writes } = await open(page);
    const list = page.getByRole('region', { name: 'Live sessions' });
    const row = list.locator('[data-live-session="gy-7-review"]');
    await expect(row).toContainText('Reviews code');
    await expect(row).toContainText('claude');
    await expect(row).toContainText('claude-b');
    await expect(row).toContainText('running');
    await expect(row).toContainText('started 4m ago');
    await row.getByRole('button', { name: 'Watch live' }).click();

    const viewer = page.getByRole('region', { name: 'Live view of gy-7-review' });
    const log = viewer.getByRole('log', { name: 'Session output' });
    await expect(log).toContainText('review step 31');
    // The tail updates while the view is open: later reads bring later lines.
    await expect(log).toContainText('review step 33', { timeout: 10_000 });
    // It follows the end as lines arrive.
    await expect.poll(() => log.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(30);
    await expect(viewer).toContainText('herdr pane attach w1:p7 --workspace w1');
    await expect(viewer).toContainText('/home/agent/.claude/projects/gy-7/transcript.jsonl');

    // Read-only: nothing in the view accepts input, and nothing was ever sent.
    expect(await viewer.locator('input, textarea, select, form, [contenteditable]:not([contenteditable="false"])').count()).toBe(0);
    await log.click();
    await page.keyboard.type('rm -rf /\n');
    await expect(log).not.toContainText('rm -rf');
    expect(writes).toEqual([]);
    // The page never scrolls sideways, at either width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

    await viewer.getByRole('button', { name: 'Close' }).click();
    await expect(viewer).toHaveCount(0);
  });
}
