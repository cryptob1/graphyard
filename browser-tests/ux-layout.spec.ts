import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { boardApi } from './ui-board';

// GY-3478: the UX standard's one mechanical check. Every page in the view registry and an item page,
// at phone and desktop width, as a reader and as an admin, scroll no wider than the window.
const router = readFileSync(new URL('../web/pages/index.tsx', import.meta.url), 'utf8');
const routes = [...router.slice(router.indexOf('export const views')).matchAll(/\{ id: '([a-z-]+)'/g)].map(match => match[1]);

for (const role of ['reader', 'admin']) for (const width of [390, 1280]) {
  test(`e2e:ux-layout — no page scrolls sideways at ${width} px as ${role}`, async ({ page }) => {
    test.setTimeout(120_000);
    expect(routes.length, 'the router lists its pages').toBeGreaterThan(10);
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/**', route => {
      const url = new URL(route.request().url());
      return route.fulfill({ json: boardApi(url.pathname.slice(1) + url.search, role) });
    });
    await page.routeWebSocket(/\/api\/terminal/, () => {});
    await page.goto('/?sign-in');
    await page.getByLabel('Access token').fill('fixture');
    await page.getByRole('button', { name: 'Open control plane' }).click();
    await expect(page.getByRole('main').getByRole('heading', { level: 1 }).first()).toBeVisible();
    const wide: string[] = [];
    for (const target of [...routes, 'GY-13']) {
      await page.evaluate(hash => { location.hash = hash; }, target);
      await expect(page.getByRole('main').getByRole('heading', { level: 1 }).first()).toBeVisible();
      await page.waitForTimeout(150);
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
      if (scrollWidth !== clientWidth) wide.push(`${target}: ${scrollWidth} > ${clientWidth}`);
    }
    expect(wide, 'pages wider than the window').toEqual([]);
  });
}
