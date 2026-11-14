import { test, expect } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';
import { boardStatus, boardWork, NOW } from './ui-board';

// GY-3307: the dashboard names the master agent Master everywhere — the navigation, the Master
// page's heading and its accessible controls — with Fun on and off, and the agents page stays
// Workers. Chief labels fail this proof.
test('e2e:master-worker-terminology — navigation, the Master heading and its accessible controls say Master, and Workers stays Workers', async ({ page }) => {
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
  await expect(menu).toHaveText(['Work', 'Master', 'Workers', 'Shipped', 'Tests', 'Settings']);

  // The Master page: its heading, its tab row and its terminal region all say Master.
  await menu.nth(1).click();
  await expect(page.getByRole('heading', { name: 'Master', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Master terminal' })).toBeVisible();
  const tabs = page.getByRole('navigation', { name: 'Pages in this section' }).getByRole('button');
  await expect(tabs).toHaveText(['Master', 'Product']);
  // Fun changes nothing here: the entry and the heading still say Master.
  await page.getByRole('button', { name: 'Fun', exact: true }).click();
  await expect(menu.nth(1)).toHaveText('Master');
  await expect(page.getByRole('heading', { name: 'Master', exact: true, level: 1 })).toBeVisible();

  // Workers remains Workers: its own entry, heading and tab row.
  await menu.nth(2).click();
  await expect(page.getByRole('heading', { name: 'Workers', exact: true, level: 1 })).toBeVisible();
  await expect(tabs).toHaveText(['Workers', 'Costs']);

  // Nothing on the board says Chief.
  await expect(page.getByText(/chief/i)).toHaveCount(0);
});
