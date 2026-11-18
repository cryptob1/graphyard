import { test, expect, type Page } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';
import { boardStatus, boardWork, NOW } from './ui-board';
import { serveXterm } from './xterm';

// GY-3272 AC-2: the dashboard is keyboard-first — Cmd/Ctrl+K opens the palette (an item key and
// Enter opens that item), j/k walk the Work rows and Enter opens the one under the cursor,
// g m opens Master (g w Work, g s Setup), ? shows the shortcut sheet.
async function serve(page: Page) {
  const state = { work: boardWork() };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/status')) return route.fulfill({ json: boardStatus('admin') });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work: state.work, now: new Date(NOW).toISOString() } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus(state.work, NOW, null) });
    if (path.endsWith('/events')) return route.fulfill({ json: [] });
    if (path.includes('/work/')) return route.fulfill({ json: state.work.find(w => path.endsWith(w.id)) ?? {} });
    return route.fulfill({ json: [] });
  });
  await serveXterm(page); // the Master page's xterm.js, served locally (GY-3357)
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
  test.setTimeout(60_000);
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
  // A command by name: the Master page — its title is Master — then the theme, both without the mouse.
  await page.keyboard.press('Control+k');
  await search(page).fill('Master');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Master', exact: true, level: 1 })).toBeVisible();
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
  test.setTimeout(60_000);
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
  test.setTimeout(60_000);
  await serve(page);
  await page.keyboard.press('g');
  await page.keyboard.press('m');
  await expect(page.getByRole('heading', { name: 'Master', exact: true, level: 1 })).toBeVisible();
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
