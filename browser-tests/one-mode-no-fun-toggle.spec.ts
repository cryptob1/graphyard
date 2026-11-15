import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';
import { emptyRegistry, fleetView } from '../src/model/registry';
import { boardStatus, boardWork, NOW } from './ui-board';

// GY-3320: the dashboard has one mode. There is no Fun control anywhere, a Fun preference stored
// before the change does nothing, and the menu and the Master page read Master and Workers.
test('e2e:one-mode-no-fun-toggle — no Fun control on any page, a stored Fun preference has no effect, Master and Workers', async ({ page }) => {
  test.setTimeout(60_000);
  const work = boardWork();
  await page.addInitScript(() => localStorage.setItem('graphyard.fun', 'off'));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/status')) return route.fulfill({ json: boardStatus('admin') });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work, now: new Date(NOW).toISOString() } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus(work, NOW, null) });
    // Settings › Agents renders the registry view; an empty registry, not the catch-all [], keeps the page up.
    if (path.endsWith('/agent-registry')) return route.fulfill({ json: fleetView(emptyRegistry(), NOW) });
    return route.fulfill({ json: [] });
  });
  await page.goto('/?sign-in');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible();

  // The stored 'off' from before changes nothing: the line, the names and the strip all show.
  await expect(page.locator('html')).not.toHaveAttribute('data-fun', /.*/);
  await expect(page.locator('[data-build-line]')).toBeVisible();
  await expect(page.locator('[data-row="GY-14"] .row-who')).toContainText('is running GY-14');
  await expect(page.locator('.trust-strip')).toContainText('verified by running');

  const noFun = async () => {
    await expect(page.getByRole('button', { name: /^fun$/i, includeHidden: true })).toHaveCount(0);
    await expect(page.locator('[aria-pressed]').filter({ hasText: /^fun$/i })).toHaveCount(0);
  };
  await noFun();
  const menu = page.getByRole('navigation', { name: 'Primary' }).getByRole('button');
  await expect(menu).toHaveText(['Work', 'Master', 'Workers', 'Shipped', 'Tests', 'Settings']);

  await menu.nth(1).click();
  await expect(page.getByRole('heading', { name: 'Master', exact: true, level: 1 })).toBeVisible();
  await noFun();
  await menu.nth(2).click();
  await expect(page.getByRole('heading', { name: 'Workers', exact: true, level: 1 })).toBeVisible();
  await noFun();
  await menu.nth(5).click();
  const tabs = page.getByRole('navigation', { name: 'Pages in this section' }).getByRole('button');
  await expect(tabs.first()).toBeVisible(); // allInnerTexts does not wait: read the tab names once the bar has rendered.
  for (const name of await tabs.allInnerTexts()) {
    await tabs.filter({ hasText: name }).first().click();
    await noFun();
    await expect(page.getByRole('main').getByText(/fun mode/i)).toHaveCount(0);
  }
});

test('e2e:one-mode-no-fun-toggle — no source under web/ or src/ references the Fun mode setting', () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : /\.(tsx?|css|html|mjs)$/.test(entry.name) ? [join(dir, entry.name)] : []);
  const setting = /graphyard\.fun\b|data-fun|dataset\.fun|\b(useFun|readFun|setFun|bootFun|applyFun)\b|Fun (toggle|mode|off|on)\b/;
  const offenders = ['web', 'src'].flatMap(files).filter(file => setting.test(readFileSync(file, 'utf8')));
  expect(offenders).toEqual([]);
});
