import { test, expect } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';
import { boardStatus, boardWork, NOW } from './ui-board';
import { serveXterm } from './xterm';

// A loaded trial host renders the dashboard past the 5 s default wait (GY-3469).
const settled = { timeout: 15_000 };

// GY-3287 AC-1: Master is the left menu's second top-level entry, opening the master's live page,
// named Master (GY-3307) — no longer only a sub-page under Workers.
test('e2e:master-in-left-menu — Master is the second left-menu entry, opens the master page, and reads Master', async ({ page }) => {
  const work = boardWork();
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/status')) return route.fulfill({ json: boardStatus('admin') });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work, now: new Date(NOW).toISOString() } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus(work, NOW, null) });
    return route.fulfill({ json: [] });
  });
  await serveXterm(page); // the Master page's xterm.js, served locally (GY-3357)
  await page.goto('/?sign-in');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible(settled);

  const menu = page.getByRole('navigation', { name: 'Primary' }).getByRole('button');
  await expect(menu).toHaveText(['Work', 'Master', 'Workers', 'Shipped', 'Tests', 'Settings'], settled);
  await menu.nth(1).click();
  await expect(page.getByRole('heading', { name: 'Master', exact: true, level: 1 })).toBeVisible(settled);
  await expect(page.getByRole('region', { name: 'Master terminal' })).toBeVisible(settled);
  await expect(menu.nth(1)).toHaveAttribute('aria-current', 'page', settled);

  // Workers is its own page again: no sub-page row offering Master beside it (Costs sits there since GY-3297).
  await menu.nth(2).click();
  await expect(page.getByRole('heading', { name: 'Workers', exact: true, level: 1 })).toBeVisible(settled);
  await expect(page.getByRole('navigation', { name: 'Pages in this section' }).getByRole('button', { name: /^Master$/ })).toHaveCount(0, settled);
});
