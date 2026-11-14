import { test, expect, type Page } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';
import { boardStatus, boardWork, NOW } from './ui-board';

// GY-3272 AC-2: the dashboard is keyboard-first — Cmd/Ctrl+K opens the palette (an item key and
// Enter opens that item), j/k walk the Work rows and Enter opens the one under the cursor,
// g m opens Master (g w Work, g s Setup), ? shows the shortcut sheet — and the top bar's live
// strip counts the same numbers the Workers page and the ledger read off this board.
const ledger = (item: any, state: string) => ({ key: item.key, state, head: item.candidate.sha, baseTip: null, mergeSha: null, risk: null, intentAt: null, pushedAt: null, observedTip: null, refusal: null, events: 1 });
/** The board fixture with one merge trial out (GY-21 pushed) and one merge from tonight (GY-18). */
const stripWork = () => boardWork().map(item => {
  if (item.key === 'GY-21') return { ...item, mergeLedger: ledger(item, 'pushed') };
  if (item.key === 'GY-18' && item.delivery) {
    const tonight = new Date(NOW - 3_600_000).toISOString();
    return { ...item, delivery: { ...item.delivery, mergedAt: tonight, deployment: item.delivery.deployment ? { ...item.delivery.deployment, observedAt: tonight, at: tonight } : item.delivery.deployment } };
  }
  return item;
});

async function serve(page: Page) {
  const state = { work: stripWork() };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/status')) return route.fulfill({ json: boardStatus('admin') });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work: state.work, now: new Date(NOW).toISOString() } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus(state.work, NOW, null) });
    if (path.endsWith('/events')) return route.fulfill({ json: [] });
    if (path.includes('/work/')) return route.fulfill({ json: state.work.find(w => path.endsWith(w.id)) ?? {} });
    return route.fulfill({ json: [] });
  });
  await page.goto('/?sign-in');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible();
  // The keys walk rows, so the test waits for the board the way its reader does.
  await expect(page.locator('.work-row').first()).toBeVisible();
  return state;
}

const palette = (page: Page) => page.getByRole('dialog', { name: 'Command palette' });
const search = (page: Page) => page.getByLabel('Search commands');
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Keyboard shortcuts' });

test('e2e:keyboard-palette — Cmd/Ctrl+K opens the palette; an item key and Enter opens that item; the palette jumps and switches theme', async ({ page }) => {
  await serve(page);
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await expect(search(page)).toBeFocused();
  // Type an item key, press Enter: that item's page opens.
  await search(page).fill('GY-15');
  await page.keyboard.press('Enter');
  await expect(page.locator('article.item-page')).toContainText('Add dark mode to settings');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible();
  // A command by name: the Master page — its title is the Chief (AC-5) — then the theme, both without the mouse.
  await page.keyboard.press('Control+k');
  await search(page).fill('Master');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'The Chief', exact: true, level: 1 })).toBeVisible();
  await page.keyboard.press('Control+k');
  await search(page).fill('Daylight');
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'daylight');
  await page.keyboard.press('Control+k');
  await search(page).fill('Night Yard');
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
  // The visible button opens it too — the affordance a phone has.
  await page.getByRole('button', { name: 'Command palette (Ctrl K)' }).click();
  await expect(palette(page)).toBeVisible();
  // ↑ chooses the next match; Enter runs it.
  const chosen = page.locator('.palette-choice[aria-selected="true"]');
  const first = await chosen.textContent();
  await page.keyboard.press('ArrowDown');
  await expect(chosen).not.toHaveText(first!);
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);
});

test('e2e:keyboard-palette — j/k move a cursor through the Work rows, Enter opens that row, and Esc clears the cursor', async ({ page }) => {
  await serve(page);
  const cursor = page.locator('.work-row.kb-cursor');
  // The board's first visible row is the one that needs the operator.
  await page.keyboard.press('j');
  await expect(cursor).toHaveAttribute('data-row', 'GY-20');
  await page.keyboard.press('j');
  await expect(cursor).toHaveAttribute('data-row', 'GY-17');
  await page.keyboard.press('k');
  await expect(cursor).toHaveAttribute('data-row', 'GY-20');
  await page.keyboard.press('Enter');
  await expect(page.locator('article.item-page')).toContainText('Prove the one-command install on a real cloud host');
  // Back on the board the cursor is gone, and typing in the search box never moves it.
  await page.keyboard.press('Escape');
  await expect(cursor).toHaveCount(0);
  await page.getByLabel('Search work').fill('?');
  await expect(page.locator('article.item-page')).toHaveCount(0);
  await expect(sheet(page)).toHaveCount(0);
  await page.getByLabel('Search work').fill('');
});

test('e2e:keyboard-palette — g m opens Master, g w Work, g s Setup, and ? shows the shortcut sheet', async ({ page }) => {
  await serve(page);
  await page.keyboard.press('g');
  await page.keyboard.press('m');
  await expect(page.getByRole('heading', { name: 'The Chief', exact: true, level: 1 })).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('w');
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('s');
  await expect(page.getByRole('heading', { name: 'Set up Graphyard' })).toBeVisible();
  // The sheet: every shortcut on one dialog, closed with Escape.
  await page.keyboard.press('g');
  await page.keyboard.press('w');
  await page.keyboard.press('?');
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page)).toContainText('Command palette');
  await expect(sheet(page)).toContainText('Move through the Work rows');
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
});

test('e2e:keyboard-palette — the top bar strip counts the shift, the trials and tonight’s ships, matching the Workers page', async ({ page }) => {
  await serve(page);
  // The fixture holds two fresh running sessions (a third not seen for forty minutes), one pushed
  // merge trial and one merge from tonight.
  const strip = page.locator('.city-strip');
  await expect(strip).toHaveAttribute('data-on-shift', '2');
  await expect(strip).toHaveAttribute('data-in-trial', '1');
  await expect(strip).toHaveAttribute('data-shipped-tonight', '1');
  await expect(strip).toContainText('2 runners on shift');
  await expect(strip).toContainText('1 in trial');
  await expect(strip).toContainText('1 shipped tonight');
  // The same numbers the Workers page reads off the same board.
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Workers', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Workers', exact: true, level: 1 })).toBeVisible();
  await expect(page.locator('.page-heading .summary')).toContainText('2 agent sessions open. 1 not seen recently.');
});
