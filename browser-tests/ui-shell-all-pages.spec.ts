import { readFileSync, mkdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { signInDatabase } from '../tests/helpers/sign-in-database';
import { signInProcess } from '../tests/helpers/sign-in-process';

// GY-3322: every page in the dashboard router is built from the one page shell (web/style.css, GY-3321):
// the page heading — h1 title, the primary fact under it, actions top right — cards (.panel) with their
// section heading, the one table class (.sessions-table) and the one empty state (.empty). The routes
// are read from the router itself, so a page added without the shell fails here.
const router = readFileSync(new URL('../web/pages/index.tsx', import.meta.url), 'utf8');
const routes = [...router.slice(router.indexOf('export const views')).matchAll(/\{ id: '([a-z-]+)'/g)].map(match => match[1]);
// Pages that list what the control plane holds: with nothing to list they show the shared empty state.
const lists = ['work', 'now', 'needs-you', 'shipped', 'workers', 'releases', 'tests', 'scenarios', 'product', 'costs', 'automation'];
const operator = { Authorization: 'Bearer test-human-operator', 'Content-Type': 'application/json' };
const settled = { timeout: 15_000 };
const shots = process.env.UI_REVIEW_SHOTS ? new URL('../verification/ui-review/after/', import.meta.url) : null;

async function seed(url: string) {
  const file = async (n: number, title: string) => (await (await fetch(`${url}/api/work`, { method: 'POST', headers: { ...operator, 'Idempotency-Key': `ui-shell-all-${n}` },
    body: JSON.stringify({ title, type: 'feature', description: 'Seeded for the page shell.', criteria: [{ id: 'AC-1', text: 'It works in the browser', proofs: ['e2e:fixture'] }] }) })).json() as { id: string });
  for (const [n, title] of [[1, 'Sign-up form remembers the email'], [2, 'Faster search on the Work page']] as const) {
    const item = await file(n, title);
    await fetch(`${url}/api/work/${item.id}/ready`, { method: 'POST', headers: { ...operator, 'Idempotency-Key': `ui-shell-all-ready-${n}` }, body: JSON.stringify({ reason: 'Released by the ui-shell-all-pages case' }) });
  }
  await file(3, 'Export costs as a spreadsheet');
}

/** The shell as rendered on the open page, read from the top of the page. */
function shell(page: Page) {
  return page.evaluate(() => {
    scrollTo(0, 0);
    const style = (node: Element | null) => { if (!node) return null; const s = getComputedStyle(node); return `${s.fontSize} ${s.fontWeight} ${s.letterSpacing} ${s.fontFamily}`; };
    const onFirstScreen = (node: Element | null) => { const b = node?.getBoundingClientRect(); return !!b && b.width > 0 && b.height > 0 && b.top >= 0 && b.bottom <= innerHeight; };
    const titles = [...document.querySelectorAll('main h1')];
    const fact = document.querySelector('main .page-heading .page-fact');
    return {
      titles: titles.length, titleText: titles[0]?.textContent?.trim() ?? '', titleInHeading: !!titles[0]?.closest('.page-heading'), title: style(titles[0] ?? null),
      fact: fact?.textContent?.trim() ?? '', firstScreen: { title: onFirstScreen(titles[0] ?? null), fact: onFirstScreen(fact) },
      // The Master page's content is its terminal, which fills the page (GY-3308).
      cards: document.querySelectorAll('main .panel, main table.sessions-table, main .live-terminal').length,
      sections: [...new Set([...document.querySelectorAll('main .panel > h2, main .panel > summary')].map(style))],
      strays: [...document.querySelectorAll('main section > h2, main article > h2')].filter(h2 => !h2.parentElement!.matches('.panel, .modal')).map(h2 => h2.textContent),
      tables: [...document.querySelectorAll('main table')].map(table => table.className).filter(name => !name.split(' ').includes('sessions-table')),
      empty: !!document.querySelector('main .empty'),
      legacy: [...document.querySelectorAll('main .breadcrumb, main .eyebrow, main .section-title')].map(node => node.className),
      sideways: document.documentElement.scrollWidth - innerWidth,
    };
  });
}

for (const data of ['seeded', 'empty'] as const) for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`e2e:ui-shell-all-pages — every dashboard page uses the shared shell, ${data}, at ${viewport.width} px`, async ({ page }) => {
    test.setTimeout(240_000);
    expect(routes.length, 'the router lists its pages').toBeGreaterThan(10);
    const database = await signInDatabase();
    const http = await signInProcess(database.url);
    const errors: string[] = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(`${message.text()} (${message.location().url})`); });
    page.on('pageerror', error => errors.push(error.message));
    try {
      if (data === 'seeded') await seed(http.url);
      await page.route('**/*', async route => {
        const { pathname, search } = new URL(route.request().url());
        const response = await route.fetch(pathname.startsWith('/api/') ? { url: http.url + pathname + search } : {}).catch(() => null);
        if (!response) return route.abort('connectionrefused').catch(() => {});
        await route.fulfill({ response }).catch(() => {});
      });
      // The Master terminal's socket would reach the static preview server, not the plane: it is answered here and
      // left silent, as the terminal's own cases (master-page-terminal, master-terminal-fills-page) drive the real one.
      await page.routeWebSocket(/\/api\/terminal/, () => {});
      await page.setViewportSize(viewport);
      const { code } = await (await fetch(`${http.url}/api/sign-in-links`, { method: 'POST', headers: operator })).json() as { code: string };
      await page.goto('/#sign-in=' + code);
      await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible(settled);
      if (shots) mkdirSync(shots, { recursive: true });
      const reads: Record<string, Awaited<ReturnType<typeof shell>>> = {};
      for (const route of routes) {
        await page.evaluate(id => { location.hash = id; }, route);
        // A page still reading says so in its fact, ending in an ellipsis; the read is done once it does not.
        const fact = page.locator('main .page-heading .page-fact');
        await expect(fact, `${route} shows its primary fact`).toBeVisible(settled);
        await expect(fact, `${route} finishes reading`).not.toHaveText(/…$/, settled);
        const read = reads[route] = await shell(page);
        expect(read.titles, `${route} has one page title`).toBe(1);
        expect(read.titleInHeading, `${route} title sits in the shared page heading`).toBe(true);
        expect(read.fact, `${route} states its primary fact`).not.toBe('');
        expect(read.firstScreen, `${route} first screen shows its title and primary fact`).toEqual({ title: true, fact: true });
        expect(read.cards > 0 || read.empty, `${route} shows its content in cards, the shared table or the shared empty state`).toBe(true);
        expect(read.strays, `${route} section headings belong to cards`).toEqual([]);
        expect(read.tables, `${route} tables use the shared table class`).toEqual([]);
        expect(read.legacy, `${route} uses no page-local heading`).toEqual([]);
        if (data === 'empty' && lists.includes(route)) expect(read.empty, `${route} shows the shared empty state with no data`).toBe(true);
        expect(read.sideways, `${route} never scrolls sideways at ${viewport.width} px`).toBeLessThanOrEqual(0);
        if (shots) await page.screenshot({ path: new URL(`${route}-${viewport.width}${data === 'empty' ? '-empty' : ''}.jpg`, shots).pathname, quality: 70 });
      }
      const all = Object.entries(reads);
      expect(new Set(all.map(([, read]) => read.titleText)).size, `each route opens its own page: ${all.map(([route, read]) => `${route}=${read.titleText}`)}`).toBe(routes.length);
      for (const [route, read] of all) expect(read.title, `${route} uses the shared title style`).toBe(all[0][1].title);
      const sections = new Set(all.flatMap(([, read]) => read.sections));
      expect([...sections], 'every card heading uses the shared section heading style').toHaveLength(1);
      expect(errors, 'no console errors').toEqual([]);
    } finally { await http.close(); await database.close(); }
  });
}
