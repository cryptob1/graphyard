import { test, expect, type Page } from '@playwright/test';
import { boardApi } from './ui-board';
import { costSummary, type UsageRow } from '../src/model/token-costs';
import { emptyRegistry, type AgentRegistry } from '../src/model/registry';

// GY-3315: the Costs page states what was spent in dollars. Three models ran: claude-fable-5-2 and
// glm-5.3 are on the bundled price sheet (their registry entries carry no price, as an account's
// own default model does), gpt-6-astra is on none. The page is served the exact view `GET /api/costs`
// returns, computed by the real `costSummary` over stubbed usage.

const now = Date.now(), at = new Date(now).toISOString();
const unpricedModel = (name: string) => ({ name, id: null, cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'strong', contextTokens: null } });
function registry(astraPriced: boolean): AgentRegistry {
  return { ...emptyRegistry(), models: [unpricedModel('claude-fable-5-2'), unpricedModel('glm-5.3'),
    astraPriced ? { ...unpricedModel('gpt-6-astra'), cost: { inputPerMTok: 2, outputPerMTok: 10, asOf: '2026-11-14' } } : unpricedModel('gpt-6-astra')],
  accounts: [{ name: 'claude-a' }, { name: 'zai' }, { name: 'codex-a' }] } as unknown as AgentRegistry;
}
const row = (id: string, role: UsageRow['role'], account: string, model: string, input: number, output: number, work: string | null): UsageRow =>
  ({ id, work, role, account, runtime: 'stub', model, reported: true, input, output, cacheRead: 0, cacheWrite: 0, at });
// Fable at $8/$40: $8.00 + $4.00. GLM at $1.40/$4.40: $0.70 + $0.22. Astra: 300k tokens.
const rows = [row('w', 'worker', 'claude-a', 'claude-fable-5-2', 1_000_000, 100_000, 'GY-1'), row('r', 'reviewer', 'zai', 'glm-5.3', 500_000, 50_000, 'GY-1'),
  row('m', 'master', 'codex-a', 'gpt-6-astra', 250_000, 50_000, null)];

async function open(page: Page, astraPriced: boolean) {
  const summary = costSummary(rows, registry(astraPriced), new Set(['GY-1']), now);
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/costs') return route.fulfill({ json: summary });
    return route.fulfill({ json: boardApi(url.pathname.slice(1) + url.search) });
  });
  await page.goto('/?sign-in');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  const menu = page.getByRole('button', { name: 'Menu' });
  if (page.viewportSize()!.width <= 650 && await menu.getAttribute('aria-expanded') !== 'true') await menu.click();
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Workers', exact: true }).click();
  await page.getByRole('navigation', { name: 'Pages in this section' }).getByRole('button', { name: 'Costs', exact: true }).click();
  await expect(page.getByRole('main').getByRole('heading', { name: 'Costs', level: 1 })).toBeVisible();
  await expect(page.locator('[data-cost-window]')).toHaveCount(4);
}

const cost = (page: Page, table: string, line: string) => page.getByRole('table', { name: table }).locator(`tr[data-cost-line="${line}"] td`).nth(6);

/** Every numeric column's header text and cell texts end at the same x, and the page never scrolls sideways. */
async function aligned(page: Page) {
  const misaligned = await page.evaluate(() => {
    const edge = (cell: Element) => { const range = document.createRange(); range.selectNodeContents(cell); return range.getBoundingClientRect().right; };
    const out: string[] = [];
    for (const table of document.querySelectorAll('main table')) {
      const headers = [...table.querySelectorAll('thead th')];
      headers.forEach((header, column) => {
        if (getComputedStyle(header).display === 'none' || !/^(Tokens|Input|Output|Cache read|Cache write|Cost|Not reported)$/.test(header.textContent!.trim())) return;
        for (const tr of table.querySelectorAll('tbody tr')) {
          const cell = (tr as HTMLTableRowElement).cells[column];
          if (!cell || cell.colSpan > 1 || getComputedStyle(cell).display === 'none') continue;
          if (Math.abs(edge(cell) - edge(header)) > 2) out.push(`${table.getAttribute('aria-label')} › ${header.textContent} › ${cell.textContent}: ${edge(cell)} vs ${edge(header)}`);
        }
      });
    }
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth) out.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${document.documentElement.clientWidth}`);
    return out;
  });
  expect(misaligned).toEqual([]);
}

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'phone', width: 390, height: 844 }]) {
  test(`e2e:costs-page-priced — totals in dollars, 'at least' beside an unpriced model, aligned tables, at ${viewport.name} width`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await open(page, false);
    // Each total is what the priced tokens cost, at least: $12.00 + $0.92.
    for (const tile of await page.locator('[data-cost-window]').all()) {
      await expect(tile.locator('strong')).toHaveText('at least $12.92');
      expect(await tile.textContent()).not.toContain('per shipped item');
    }
    // One line under the cards names the unpriced model and its tokens.
    const note = page.locator('[data-unpriced]');
    await expect(note).toHaveCount(1);
    await expect(note).toContainText('gpt-6-astra (300k tokens)');
    expect((await note.textContent())!.split('gpt-6-astra').length - 1).toBe(1);
    // Priced rows in dollars; only the wholly unpriced row reads 'price unknown'.
    for (const [table, fable, glm, astra] of [['By role', 'Workers', 'Reviewers', 'Master'], ['By model', 'claude-fable-5-2', 'glm-5.3', 'gpt-6-astra'], ['By account', 'claude-a', 'zai', 'codex-a']]) {
      await expect(cost(page, table, fable)).toHaveText('$12.00');
      await expect(cost(page, table, glm)).toHaveText('$0.92');
      await expect(cost(page, table, astra)).toHaveText('price unknown');
      await expect(page.getByRole('table', { name: table }).getByText('price unknown')).toHaveCount(1);
    }
    await aligned(page);
  });

  test(`e2e:costs-page-priced — every model priced: exact dollars and a per-shipped-item figure, at ${viewport.name} width`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await open(page, true);
    for (const tile of await page.locator('[data-cost-window]').all()) {
      await expect(tile.locator('strong')).toHaveText('$13.92');
      await expect(tile.locator('small')).toHaveText(/\$12\.92 per shipped item \(1\)/);
    }
    await expect(page.locator('[data-unpriced]')).toHaveCount(0);
    await expect(cost(page, 'By model', 'gpt-6-astra')).toHaveText('$1.00');
    await expect(page.getByRole('main').getByText('price unknown')).toHaveCount(0);
    await aligned(page);
  });
}
