import { test, expect } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';
import { boardStatus, boardWork, NOW } from './ui-board';

// GY-3287 AC-1: Master is the left menu's second top-level entry, opening the master's live page,
// named the Chief with Fun on and Master with it off — no longer only a sub-page under Workers.
test('e2e:master-in-left-menu — Master is the second left-menu entry, opens the master page, and reads The Chief with Fun on and Master with it off', async ({ page }) => {
  const work = boardWork();
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/status')) return route.fulfill({ json: boardStatus('admin') });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work, now: new Date(NOW).toISOString() } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus(work, NOW, null) });
    return route.fulfill({ json: [] });
  });
  await page.goto('/?sign-in');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible();

  const menu = page.getByRole('navigation', { name: 'Primary' }).getByRole('button');
  await expect(menu).toHaveText(['Work', 'The Chief', 'Workers', 'Shipped', 'Tests', 'Settings']);
  await menu.nth(1).click();
  await expect(page.getByRole('heading', { name: 'The Chief', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Master terminal' })).toBeVisible();
  await expect(menu.nth(1)).toHaveAttribute('aria-current', 'page');

  await page.getByRole('button', { name: 'Fun', exact: true }).click();
  await expect(menu.nth(1)).toHaveText('Master');
  await expect(page.getByRole('heading', { name: 'Master', exact: true, level: 1 })).toBeVisible();

  // Workers is its own page again: no sub-page row offering Master beside it (Costs sits there since GY-3297).
  await menu.nth(2).click();
  await expect(page.getByRole('heading', { name: 'Workers', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Pages in this section' }).getByRole('button', { name: /Master|Chief/ })).toHaveCount(0);
});
