import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { NOW, boardApi, emptyApi } from './ui-board';

// GY-3396: every dashboard page reviewed with real data in it, at desktop and phone width. The
// seed fixture (browser-tests/ui-board.ts) is a sanitized copy of this install — every page's read
// answers over it — and its empty counterpart answers with nothing to list. One browser walks the
// router's every page twice, seeded then empty, and holds the two screenshots of each page against
// each other: a page that lists what the control plane holds must show its seeded items, so its
// seeded picture differs from its empty one. The clock is fixed and the Work page's playful line
// (chosen by Math.random) is pinned, so the two pictures differ only by the data in them. Every
// page must fit its width (no sideways scroll), read in plain words — no internal term (trial,
// epoch, lease, builder) outside a folded Details section, which innerText already excludes — and
// log no console error. The routes are read from the router itself, so a page added without this
// review fails here.
const router = readFileSync(new URL('../web/pages/index.tsx', import.meta.url), 'utf8');
const routes = [...router.slice(router.indexOf('export const views')).matchAll(/\{ id: '([a-z-]+)'/g)].map(match => match[1]);
// Pages that list what the control plane holds: with nothing to list they draw the shared empty state.
const lists = ['work', 'now', 'needs-you', 'shipped', 'workers', 'releases', 'tests', 'scenarios', 'product', 'costs', 'agents', 'automation'];
const banned = /\b(?:trial|epoch|lease|builder)s?\b/i;
// The two widths share one worker, one after the other: the walk is heavy, and a trial host runs
// the rest of the browser suite beside it.
test.describe.configure({ mode: 'serial' });

/** One page visited: does it fit, and what does it say? */
async function review(page: Page, route: string, width: number) {
  const fact = page.locator('main .page-heading .page-fact');
  await expect(fact, `${route} shows its primary fact`).toBeVisible({ timeout: 15_000 });
  await expect(fact, `${route} finishes reading`).not.toHaveText(/…$/, { timeout: 15_000 });
  await page.waitForTimeout(150);
  return await page.evaluate(() => ({
    sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    // innerText is the text a person sees: a closed <details> body is not rendered, so folded
    // technical detail stays out of the words this check reads.
    words: document.body.innerText ?? '',
  }));
}

for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }]) {
  test(`e2e:pages-seeded-review — every dashboard page shows its seeded items, fits and reads plainly at ${viewport.name} width`, async ({ page }) => {
    test.setTimeout(480_000);
    expect(routes.length, 'the router lists its pages').toBeGreaterThan(10);
    // With PAGES_REVIEW_SHOTS set, each pass's pictures land on disk for eyes to read.
    const shots = process.env.PAGES_REVIEW_SHOTS ? `${process.env.PAGES_REVIEW_SHOTS}/${viewport.name}` : null;
    // The Work page's playful line and the confetti choose with Math.random: pin it, so the
    // seeded and empty pictures of a page differ only through their data.
    await page.addInitScript(() => { Math.random = () => 0.42; });
    await page.clock.setFixedTime(new Date(NOW));
    const errors: string[] = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(`${message.text()} (${message.location().url})`); });
    page.on('pageerror', error => errors.push(error.message));
    // The Master terminal's socket is answered here and left silent, as the shell case does.
    await page.routeWebSocket(/\/api\/terminal/, () => {});
    const data = { seeded: true as boolean };
    await page.route('**/api/**', route => {
      const url = new URL(route.request().url());
      const answer = data.seeded ? boardApi(url.pathname.slice(1) + url.search) : emptyApi(url.pathname.slice(1) + url.search);
      return route.fulfill({ json: answer });
    });
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    const visit = async (seeded: boolean) => {
      data.seeded = seeded;
      const pictures = new Map<string, Buffer>();
      // The token of the pass before stays in storage: sign the next pass in from a clean session.
      await page.goto('/?sign-in');
      await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
      await page.goto('/?sign-in');
      await page.getByLabel('Access token').fill('fixture');
      await page.getByRole('button', { name: 'Open control plane' }).click();
      await expect(page.getByRole('heading', { name: 'Work', level: 1 })).toBeVisible({ timeout: 15_000 });
      for (const route of routes) {
        const started = Date.now();
        await page.evaluate(id => { location.hash = id; }, route);
        const read = await review(page, route, viewport.width);
        expect(read.sideways, `${route} never scrolls sideways at ${viewport.name} width`).toBeLessThanOrEqual(0);
        const internal = read.words.match(banned);
        expect(internal, `${route} keeps internal words out of sight at ${viewport.name} width (found ${internal?.[0]})`).toBe(null);
        if (lists.includes(route)) {
          const buffer = await page.screenshot({ fullPage: true });
          if (shots) { mkdirSync(shots, { recursive: true }); writeFileSync(`${shots}/${route}${seeded ? '' : '-empty'}.png`, buffer); }
          pictures.set(route, buffer);
        }
        console.log(`pages-seeded-review ${seeded ? 'seeded' : 'empty'} ${viewport.width} ${route}: ${Date.now() - started}ms`);
      }
      if (seeded) {
        // One item page too: opened from Work, it is the page a reader spends the most time on.
        await page.evaluate(() => { location.hash = 'work'; });
        await page.getByRole('button', { name: /Cut the documentation to a short set/ }).click();
        const read = await review(page, 'the item page', viewport.width);
        expect(read.sideways, 'the item page never scrolls sideways').toBeLessThanOrEqual(0);
        expect(read.words.match(banned), 'the item page reads plainly').toBe(null);
        if (shots) { mkdirSync(shots, { recursive: true }); writeFileSync(`${shots}/item-page.png`, await page.screenshot({ fullPage: true })); }
      }
      return pictures;
    };

    const seeded = await visit(true);
    const empty = await visit(false);
    for (const route of lists) {
      const withData = seeded.get(route)!, without = empty.get(route)!;
      expect(withData.length, `${route} captured seeded and empty`).toBeGreaterThan(0);
      expect(withData.equals(without), `${route} shows its seeded items at ${viewport.name} width: its picture differs from the empty one`).toBe(false);
    }
    expect(errors, 'no console errors').toEqual([]);
  });
}
