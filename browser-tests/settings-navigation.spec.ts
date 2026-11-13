import { test, expect, type Page } from '@playwright/test';
import { boardApi } from './ui-board';

// GY-3297: Settings holds configuration only. Product sits under Master (the Chief keeps the brief), Costs under Workers and
// Test cases under Tests; Settings keeps Agents and Setup, with Operator automation behind an
// Advanced fold for the admin alone. Each is reached by click and by keyboard at 1280px and 390px,
// the old direct links still open, and the phone menu neither clips nor scrolls sideways.

async function open(page: Page, role: string, hash = '') {
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/operator-agents') return route.fulfill({ json: [{ id: 'a', displayName: 'Master loop', capabilities: ['work.create'], scope: { repositories: [], workItems: [] }, fingerprints: [], revision: 1, revokedAt: null, lastMutation: { kind: 'create', actor: 'operator', at: '2026-01-01T00:00:00Z', reason: 'Scoped master loop' } }] });
    return route.fulfill({ json: boardApi(url.pathname.slice(1) + url.search, role) });
  });
  await page.goto(`/?sign-in${hash}`);
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
}

const primary = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const tabs = (page: Page) => page.getByRole('navigation', { name: 'Pages in this section' });
async function menu(page: Page) {
  const button = page.getByRole('button', { name: 'Menu' });
  if (page.viewportSize()!.width > 650 || await button.getAttribute('aria-expanded') === 'true') return;
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
}
async function entry(page: Page, name: string) { await menu(page); await primary(page).getByRole('button', { name, exact: true }).click(); }
async function heading(page: Page, name: string | RegExp) { await expect(page.getByRole('main').getByRole('heading', { name, level: 1 })).toBeVisible(); }

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'phone', width: 390, height: 844 }]) {
  test(`e2e:settings-navigation — everyday pages outside Settings, configuration inside it, at ${viewport.name} width`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize(viewport);
    await open(page, 'admin');
    await heading(page, 'Work');

    // Settings is configuration: Agents and Setup as tabs, Operator automation behind Advanced, nothing everyday.
    await entry(page, 'Settings');
    await heading(page, 'Agents');
    await expect(tabs(page).getByRole('button')).toHaveText(['Agents', 'Setup']);
    await expect(tabs(page).getByText('Advanced', { exact: true })).toBeVisible();
    await expect(tabs(page).getByRole('button', { name: 'Operator automation', includeHidden: true })).toBeHidden();
    for (const everyday of ['Product', 'Costs', 'Test cases']) await expect(tabs(page).getByRole('button', { name: everyday, exact: true })).toHaveCount(0);

    // Product beside the Chief, Costs beside Workers, Test cases beside Tests: clicks.
    await menu(page);
    await primary(page).locator('[data-nav="master"]').click();
    await tabs(page).getByRole('button', { name: 'Product', exact: true }).click();
    await heading(page, 'Product');
    await entry(page, 'Workers');
    await tabs(page).getByRole('button', { name: 'Costs', exact: true }).click();
    await heading(page, 'Costs');
    await entry(page, 'Tests');
    await tabs(page).getByRole('button', { name: 'Test cases', exact: true }).click();
    await heading(page, 'Test-case library');

    // The configuration area by keyboard alone: Enter on the Settings entry, Tab along its tabs, open Advanced.
    await menu(page);
    await primary(page).getByRole('button', { name: 'Settings', exact: true }).press('Enter');
    await heading(page, 'Agents');
    await tabs(page).getByRole('button', { name: 'Agents', exact: true }).focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await heading(page, 'Set up Graphyard');
    await page.keyboard.press('Tab');
    await expect(tabs(page).locator('summary')).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await heading(page, 'Operator automation');
    await expect(tabs(page).getByRole('button', { name: 'Operator automation' })).toHaveAttribute('aria-current', 'page');

    // The phone menu: every entry fits, nothing scrolls sideways, and the tab row wraps inside the page.
    await menu(page);
    for (const button of await primary(page).getByRole('button').all()) {
      const box = await button.evaluate(element => ({ clipped: element.scrollWidth > element.clientWidth + 1, right: element.getBoundingClientRect().right }));
      expect(box.clipped).toBe(false);
      expect(box.right).toBeLessThanOrEqual(viewport.width);
    }
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(sideways).toBeLessThanOrEqual(0);
  });
}

for (const [hash, name] of [['#setup', 'Set up Graphyard'], ['#master', /Master|The Chief/]] as const) test(`e2e:settings-navigation — the direct link ${hash} still opens its page`, async ({ page }) => {
  await open(page, 'admin', hash);
  await heading(page, name);
});

test('e2e:settings-navigation — identities without the permission gain no configuration controls', async ({ page }) => {
  await open(page, 'reader');
  await heading(page, 'Work');
  await entry(page, 'Settings');
  await heading(page, 'Agents');
  // A reader sees Agents alone: no Setup, no Advanced fold, no Operator automation.
  await expect(tabs(page)).toHaveCount(0);
  await expect(page.getByText('Advanced', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open the first-run Setup checklist' })).toHaveCount(0);
  // Everyday pages stay reachable for them outside Settings.
  await entry(page, 'Workers');
  await tabs(page).getByRole('button', { name: 'Costs', exact: true }).click();
  await heading(page, 'Costs');
});

test('e2e:settings-navigation — a worker has nothing to configure', async ({ page }) => {
  await open(page, 'worker');
  await heading(page, 'Work');
  await expect(primary(page).getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
  await entry(page, 'Tests');
  await tabs(page).getByRole('button', { name: 'Test cases', exact: true }).click();
  await heading(page, 'Test-case library');
});
