import { test, expect, type Page } from '@playwright/test';
import { signInDatabase } from '../tests/helpers/sign-in-database';
import { signInProcess } from '../tests/helpers/sign-in-process';

// GY-3321: the Work page and a work item page are built from one page shell (web/style.css):
// the page heading — title, the page's primary fact, its primary action top right — the card
// (.panel) with its section heading, and the one table class.
const operator = { Authorization: 'Bearer test-human-operator', 'Content-Type': 'application/json' };
const settled = { timeout: 15_000 };

async function seed(url: string) {
  const file = async (n: number, title: string) => (await (await fetch(`${url}/api/work`, { method: 'POST', headers: { ...operator, 'Idempotency-Key': `ui-shell-${n}` },
    body: JSON.stringify({ title, why: 'People finish the task faster.', simplest: 'One small change on an existing page.', type: 'feature', description: 'Seeded for the page shell.', criteria: [{ id: 'AC-1', text: 'It works in the browser', proofs: ['e2e:fixture'] }] }) })).json() as { id: string; key: string });
  for (const [n, title] of [[1, 'Sign-up form remembers the email'], [2, 'Faster search on the Work page']] as const) {
    const item = await file(n, title);
    await fetch(`${url}/api/work/${item.id}/ready`, { method: 'POST', headers: { ...operator, 'Idempotency-Key': `ui-shell-ready-${n}` }, body: JSON.stringify({ reason: 'Released by the ui-shell case' }) });
  }
  return file(3, 'Export costs as a spreadsheet'); // left in Backlog: its page's primary action is Release to ready
}

/** The shell as rendered: the title's element and style, the section heading style, the card and table classes, and what the first screen shows. The item page's primary fact sits under its plate heading, in Where it is now (GY-3392). */
async function shell(page: Page, card: string) {
  return page.evaluate(card => {
    const style = (node: Element | null) => { if (!node) return null; const s = getComputedStyle(node); return { font: s.fontSize, weight: s.fontWeight, spacing: s.letterSpacing, family: s.fontFamily, color: s.color }; };
    const box = (node: Element | null) => node?.getBoundingClientRect() ?? null;
    const onFirstScreen = (node: Element | null) => { const b = box(node); return !!b && b.width > 0 && b.top >= 0 && b.bottom <= innerHeight; };
    const title = document.querySelector('main h1');
    const heading = document.querySelector('main .page-heading');
    const action = [...document.querySelectorAll('main .page-heading .page-actions button, main .page-heading .page-actions a')].at(-1) ?? null;
    const sidebar = document.querySelector('.sidebar')!.getBoundingClientRect();
    const available = innerWidth - (sidebar.width < innerWidth ? sidebar.width : 0);
    const cardNode = document.querySelector(card);
    const fact = heading?.querySelector('.page-fact') ?? document.querySelector('.where-now .page-fact');
    return {
      scrolled: scrollY,
      titleTag: title?.tagName, titleInHeading: !!title?.closest('.page-heading'), title: style(title),
      section: style(cardNode?.querySelector(':scope > h2') ?? null), cardClass: cardNode?.classList.contains('panel') ?? false,
      tables: [...document.querySelectorAll('main table')].map(table => table.className),
      firstScreen: { title: onFirstScreen(title), fact: onFirstScreen(fact), action: onFirstScreen(action) },
      action: action?.textContent?.trim() ?? null,
      widths: [heading, cardNode].map(node => (box(node)?.width ?? 0) / available),
      sideways: document.documentElement.scrollWidth - innerWidth,
    };
  }, card);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`e2e:ui-shell-work-pages — Work and a work item page share one shell at ${viewport.width} px`, async ({ page }) => {
    test.setTimeout(120_000);
    const database = await signInDatabase();
    const http = await signInProcess(database.url);
    const errors: string[] = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', error => errors.push(error.message));
    try {
      const backlog = await seed(http.url);
      // API requests reach the real control plane through the test, as in dashboard-live-new-item.
      await page.route('**/*', async route => {
        const { pathname, search } = new URL(route.request().url());
        const response = await route.fetch(pathname.startsWith('/api/') ? { url: http.url + pathname + search } : {}).catch(() => null);
        if (!response) return route.abort('connectionrefused').catch(() => {});
        await route.fulfill({ response }).catch(() => {});
      });
      await page.setViewportSize(viewport);
      const { code } = await (await fetch(`${http.url}/api/sign-in-links`, { method: 'POST', headers: operator })).json() as { code: string };
      await page.goto('/#sign-in=' + code);
      await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible(settled);
      await expect(page.locator('[data-group-section="up-next"]')).toBeVisible(settled);
      const work = await shell(page, '[data-group-section="up-next"]');

      await page.locator('[data-group-section="backlog"] > summary').click();
      await page.locator(`[data-row="${backlog.key}"]`).click();
      // GY-3392: the page leads with the item's why sentence; the pipeline state answers below it.
      await expect(page.getByRole('heading', { name: 'People finish the task faster.', level: 1 })).toBeVisible(settled);
      await page.evaluate(() => window.scrollTo(0, 0));
      const item = await shell(page, 'article.item-page section[aria-label="Activity"]');

      for (const [name, read] of [['Work', work], ['item', item]] as const) {
        expect(read.scrolled, `${name} opens at the top`).toBe(0);
        expect(read.titleTag, `${name} title element`).toBe('H1');
        expect(read.titleInHeading, `${name} title sits in the shared page heading`).toBe(true);
        expect(read.cardClass, `${name} cards use the shared card class`).toBe(true);
        expect(read.tables.every(name => name.split(' ').includes('sessions-table')), `${name} tables use the shared table class: ${read.tables}`).toBe(true);
        expect(read.firstScreen, `${name} first screen shows title, primary fact and primary action`).toEqual({ title: true, fact: true, action: true });
        if (viewport.width === 1440) for (const share of read.widths) expect(share, `${name} content uses the width beside the sidebar`).toBeGreaterThanOrEqual(0.85);
        expect(read.sideways, `${name} never scrolls sideways`).toBeLessThanOrEqual(0);
      }
      expect(work.action).toContain('New work item');
      expect(item.action).toBe('Release to ready');
      expect(item.title, 'same title style').toEqual(work.title);
      expect(item.section, 'same section heading style').toEqual(work.section);
      expect(work.section).not.toBeNull();
      expect(errors, 'no console errors').toEqual([]);
    } finally { await http.close(); await database.close(); }
  });
}
