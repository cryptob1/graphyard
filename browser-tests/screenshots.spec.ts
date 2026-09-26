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
    // No column of the Workers sessions-table is cut off, and every group chip is on screen (GY-161, AC-9 and AC-10).
    const cut = await page.evaluate(() => [...document.querySelectorAll('.sessions-table th, .sessions-table td, [data-tile]')].filter(element => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && (element.scrollWidth > element.clientWidth + 1 || box.right > document.documentElement.clientWidth + 1 || box.left < -1);
    }).map(element => element.textContent?.trim().slice(0, 40)));
    expect(cut, `${name}: nothing cut off at ${viewport.name} width`).toEqual([]);
    // Agent names and roles never break mid-word: each renders on one line (GY-161, AC-13).
    const broken = await page.evaluate(() => [...document.querySelectorAll('.sessions-table .agent-name, .sessions-table td[data-label=Role]')].filter(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      return new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top))).size > 1;
    }).map(element => element.textContent?.trim()));
    expect(broken, `${name}: agent names and roles on one line at ${viewport.name} width`).toEqual([]);
    await page.screenshot({ path: `${out}/${name}-${viewport.name}.png`, fullPage: true });
  };
  // Every sidebar entry this session may open, and every page under it, as the dashboard lists them.
  if (phone) await page.getByRole('button', { name: 'Menu' }).click();
  // Read the entries once the sidebar has rendered, not while the page is still loading.
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  const entries = await page.getByRole('navigation', { name: 'Primary' }).getByRole('button').allTextContents();
  if (phone) await page.getByRole('button', { name: 'Menu' }).click();
  expect(entries).toEqual(['Work', 'Workers', 'Shipped', 'Tests', 'Insights', 'Settings']);
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

// GY-204: the Flow page's 24-hour replay waits still under its play button, as a video does,
// captured at a laptop and a small-phone width. Pressing play starts it and the pause control appears.
export const replayOverlayWidths = [{ name: 'laptop', width: 1280, height: 900 }, { name: 'small-phone', width: 375, height: 812 }] as const;
for (const viewport of replayOverlayWidths) test(`the Flow replay's play overlay is captured at ${viewport.width} px`, async ({ page }) => {
  mkdirSync(out, { recursive: true });
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await open(page);
  await nav(page, 'Insights', viewport.width < 650);
  const play = page.getByRole('button', { name: 'Play the last 24 hours' });
  await expect(play).toBeVisible();
  await expect(page.locator('.replay-stage')).toHaveAttribute('data-playing', 'false');
  const box = (await page.locator('.replay-disc').boundingBox())!;
  expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(64);
  const bounds = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, width: document.documentElement.clientWidth }));
  expect(bounds.content).toBeLessThanOrEqual(bounds.width);
  await play.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/insights-replay-overlay-${viewport.width}.png`, fullPage: true });
  await play.click();
  await expect(page.getByRole('button', { name: 'Pause the replay' })).toBeVisible();
  await expect(play).toBeHidden();
});

// GY-198: the sign-in page in its token-form, verifying and unreachable states, at 1280 px and 375 px wide.
// The images land in browser-tests/screenshots/login/; tests/ui-login.test.ts checks they are committed.
export const loginWidths = [1280, 375] as const;
export const loginStates = ['token-form', 'verifying', 'unreachable'] as const;
const loginOut = 'browser-tests/screenshots/login';

for (const width of loginWidths) test(`the sign-in page is captured in every state at ${width} px`, async ({ page }) => {
  mkdirSync(loginOut, { recursive: true });
  await page.setViewportSize({ width, height: 800 });
  await page.clock.install({ time: new Date(NOW) });
  // The status read never answers, so the page stays verifying until the clock passes the 10 second bound.
  await page.route('**/api/**', () => {});
  const shot = async (state: typeof loginStates[number]) => {
    // Nothing overflows sideways, every block of the column shares one left edge, and no text sits beside a button:
    // the helper text starts below the last button.
    const layout = await page.evaluate(() => {
      const column = document.querySelector('.login')!;
      const lefts = [...column.children].map(child => Math.round(child.getBoundingClientRect().left));
      const help = column.querySelector('.login-help')!.getBoundingClientRect();
      const buttons = [...column.querySelectorAll('button')].map(button => button.getBoundingClientRect());
      return { content: document.documentElement.scrollWidth, width: document.documentElement.clientWidth, lefts, helpTop: help.top, buttonBottom: Math.max(...buttons.map(box => box.bottom)) };
    });
    expect(layout.content, `${state} fits ${width} px`).toBeLessThanOrEqual(layout.width);
    expect(new Set(layout.lefts).size, `${state}: one left edge at ${width} px`).toBe(1);
    expect(layout.helpTop, `${state}: the helper text is below the action at ${width} px`).toBeGreaterThanOrEqual(layout.buttonBottom);
    await page.screenshot({ path: `${loginOut}/${state}-${width}.png`, fullPage: true });
  };
  await page.goto('/');
  await expect(page.getByLabel('Access token')).toBeFocused();
  await shot('token-form');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('status')).toHaveText('Verifying connection…');
  await expect(page.getByRole('button', { name: 'Use another token' })).toHaveClass(/text-button/);
  await shot('verifying');
  await page.clock.fastForward(10_000);
  await expect(page.getByRole('alert')).toHaveText(/^Can't reach the control plane at 127\.0\.0\.1:4319$/);
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await shot('unreachable');
  // A rejected token returns to the form with the notice and the input focused.
  await page.unroute('**/api/**');
  await page.route('**/api/**', route => route.fulfill({ status: 401, json: { error: 'Unauthorized' } }));
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('alert')).toHaveText('That token was not accepted');
  await expect(page.getByLabel('Access token')).toBeFocused();
});
