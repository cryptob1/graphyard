import { mkdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { NOW, boardApi } from './ui-board';

// GY-161: every page of the dashboard, at desktop and phone width, over the board fixture
// (browser-tests/ui-board.ts). The images land in browser-tests/screenshots/after/ and are the
// "after" half attached to the pull request; browser-tests/screenshots/before/ holds the same
// pages captured from the dashboard as it was. tests/ui-dashboard.test.ts checks this list
// covers every sidebar entry and every page of the registry.
export const viewports = [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'phone', width: 390, height: 844 }] as const;
/** Pages opened from another page rather than from the navigation. */
export const linkedPages = ['item-moving', 'item-needs-you', 'item-blocked', 'needs-you', 'guide'] as const;

const out = 'browser-tests/screenshots/after';
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function open(page: Page) {
  await page.clock.setFixedTime(new Date(NOW));
  await page.route('**/api/**', route => { const url = new URL(route.request().url()); return route.fulfill({ json: boardApi(url.pathname.slice(1) + url.search) }); });
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.goto('/');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', level: 1 })).toBeVisible();
}
async function nav(page: Page, entry: string, phone: boolean) {
  if (phone) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: entry, exact: true }).click();
}

for (const viewport of viewports) test(`every page is captured at ${viewport.name} width`, async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(out, { recursive: true });
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await open(page);
  const phone = viewport.name === 'phone';
  const shot = async (name: string) => {
    await page.waitForTimeout(250);
    // No page may scroll sideways at either width.
    const bounds = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, width: document.documentElement.clientWidth }));
    expect(bounds.content, `${name} fits the ${viewport.name} width`).toBeLessThanOrEqual(bounds.width);
    await page.screenshot({ path: `${out}/${name}-${viewport.name}.png`, fullPage: true });
  };
  // Every sidebar entry this session may open, and every page under it, as the dashboard lists them.
  if (phone) await page.getByRole('button', { name: 'Menu' }).click();
  const entries = await page.getByRole('navigation', { name: 'Primary' }).getByRole('button').allTextContents();
  if (phone) await page.getByRole('button', { name: 'Menu' }).click();
  expect(entries).toEqual(['Work', 'Workers', 'Shipped', 'Insights', 'Settings']);
  for (const entry of entries) {
    await nav(page, entry, phone);
    const tabs = page.getByRole('navigation', { name: 'Pages in this section' });
    const names = await tabs.count() ? await tabs.getByRole('button').allTextContents() : [];
    if (!names.length) { await page.waitForLoadState('networkidle'); await shot(slug(entry)); continue; }
    for (const tab of names) {
      await tabs.getByRole('button', { name: tab, exact: true }).click();
      await page.waitForLoadState('networkidle');
      await shot(`${slug(entry)}-${slug(tab)}`);
    }
  }
  await nav(page, 'Work', phone);
  for (const [name, title] of [['item-moving', 'Cut the documentation to a short set'], ['item-needs-you', 'Prove the one-command install on a real cloud host'], ['item-blocked', 'Move sessions to Postgres']]) {
    await page.getByRole('button', { name: new RegExp(title) }).first().click();
    await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    await shot(name);
    await page.getByRole('button', { name: '← Back' }).click();
  }
  await page.getByRole('button', { name: 'Every request and answer →' }).click();
  await shot('needs-you');
  if (phone) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Help' }).click();
  await shot('guide');
});
