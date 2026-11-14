import { test, expect } from '@playwright/test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { signInDatabase } from '../tests/helpers/sign-in-database';
import { serveXterm } from './xterm';

const settled = { timeout: 15_000 };

/**
 * GY-3314: the Workers page is one compact line per agent — name, item key with a truncated
 * title, a state of at most three words, its age — over nine stubbed open headless sessions on
 * the served dashboard, and opening a row shows that session's live, read-only output: what the
 * run prints arrives without a reload, the earlier output scrolls, and nothing can type into it.
 */
test('e2e:workers-page-live-session — one compact row per agent; opening it shows the run\'s live output, read-only; the master\'s row opens the Master page', async ({ browser }) => {
  test.setTimeout(120_000);
  const database = await signInDatabase();
  const site = await mkdtemp(join(tmpdir(), 'graphyard-workers-page-'));
  await symlink(resolve('.graphyard/browser-dist'), join(site, 'dist'));
  const child = fork(resolve('tests/helpers/workers-page-server.ts'), [database.url, site], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const [{ url, first, session, master }] = await once(child, 'message') as [{ url: string; first: string; session: string; master: string }];
  const signIn = async () => (await (await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } })).json() as { code: string }).code;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await serveXterm(page);
    await page.goto(`${url}/#sign-in=${await signIn()}`);
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Workers', exact: true }).click();
    const table = page.getByRole('table', { name: 'Agent sessions' });
    const rows = table.locator('tr[data-session]');
    await expect(rows).toHaveCount(9, settled);

    // One compact line: each row is no taller than 44 px, on one line, inside the viewport.
    const compact = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      const lines = [...document.querySelectorAll('tr[data-session]')].map(row => {
        const title = row.querySelector('.row-title')!;
        return { height: Math.round(row.getBoundingClientRect().height), right: Math.round(row.getBoundingClientRect().right),
          wrapped: title.getBoundingClientRect().height > 24, truncated: title.scrollWidth > title.clientWidth + 1 };
      });
      return { width, scroll: document.documentElement.scrollWidth, lines,
        clipped: [...document.querySelectorAll('tr[data-session] th, tr[data-session] td')].filter(cell => cell.getBoundingClientRect().right > width + 1).length };
    });
    expect(compact.scroll, 'the page does not scroll sideways at 1280 px').toBeLessThanOrEqual(compact.width);
    expect(compact.clipped, 'no cell reaches past the right edge').toBe(0);
    expect(compact.lines.length).toBe(9);
    for (const [index, line] of compact.lines.entries()) {
      expect(line.height, `row ${index} is one compact line`).toBeLessThanOrEqual(44);
      expect(line.right, `row ${index} ends inside the viewport`).toBeLessThanOrEqual(compact.width);
      expect(line.wrapped, `row ${index}'s title stays on one line`).toBe(false);
    }
    expect(compact.lines.some(line => line.truncated), 'the long title is truncated in place, not pushed wide').toBe(true);

    // Every row names its state in at most three words, and how long it has held it.
    for (let index = 0; index < 9; index++) {
      const words = (await rows.nth(index).locator('td[data-label=State]').innerText()).trim().split(/\s+/);
      expect(words.length, `row ${index} state "${words.join(' ')}" is at most three words`).toBeLessThanOrEqual(3);
      await expect(rows.nth(index).locator('td[data-label=Age]')).toHaveText(/\d+[smh]/);
    }
    await expect(rows.filter({ hasText: 'Building' })).toHaveCount(6);
    await expect(table.locator('tr[data-role=reviewer] td[data-label=State]')).toHaveText('In review');
    await expect(table.locator('tr[data-role=producer] td[data-label=State]')).toHaveText('Proving');
    await expect(table.locator('tr[data-role=master] td[data-label=State]')).toHaveText('Runs the loop');

    // Opening a row shows that session's output: the run's own lines, live.
    await page.locator(`tr[data-session="${session}"]`).click();
    const output = page.getByLabel('Session output');
    await expect(output).toContainText('line 1 of the long run', settled);
    await expect(output).toContainText('line 40 of the long run', settled);
    // The view offers no input: no terminal keys, nothing to type into.
    await expect(page.getByRole('group', { name: 'Terminal keys' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Watch', exact: true })).toHaveCount(0);
    await expect(page.locator('.session-view input, .session-view textarea')).toHaveCount(0);
    // New output appended to the run appears in the view without a reload.
    await appendFile(join(site, '.graphyard', 'worker-runs', first, 'log.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), stream: 'stdout', text: 'a fresh line the run just printed' })}\n`);
    await expect(output).toContainText('a fresh line the run just printed', settled);
    // Earlier output is reachable by scrolling: the view followed the tail, and it scrolls back to the top.
    const scroll = await output.evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight, view: element.clientHeight }));
    expect(scroll.height, 'the run\'s earlier output is longer than the view').toBeGreaterThan(scroll.view);
    expect(scroll.top + scroll.view, 'the view follows the tail').toBeGreaterThanOrEqual(scroll.height - 2);
    await output.evaluate(element => { element.scrollTop = 0; });
    expect(await output.evaluate(element => element.scrollTop), 'scrolling reaches the earlier output').toBe(0);

    // The master's row opens the Master page.
    await page.locator(`tr[data-session="${master}"]`).click();
    await expect(page.getByRole('heading', { name: 'Master', exact: true })).toBeVisible(settled);
    await page.close();

    // On a phone each agent is one card, and the page does not scroll sideways.
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await serveXterm(phone);
    await phone.goto(`${url}/#sign-in=${await signIn()}`);
    await phone.getByRole('button', { name: 'Menu' }).click();
    await phone.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Workers', exact: true }).click();
    const cards = phone.locator('tr[data-session]');
    await expect(cards).toHaveCount(9, settled);
    const phoneLayout = await phone.evaluate(() => ({
      scroll: document.documentElement.scrollWidth, width: document.documentElement.clientWidth,
      cards: [...document.querySelectorAll('tr[data-session]')].map(card => ({ display: getComputedStyle(card).display, width: Math.round(card.getBoundingClientRect().width) })),
    }));
    expect(phoneLayout.scroll, 'the page does not scroll sideways at 390 px').toBeLessThanOrEqual(phoneLayout.width);
    expect(phoneLayout.cards.length).toBe(9);
    for (const card of phoneLayout.cards) {
      expect(card.display, 'each agent is one card, not a table row').toBe('block');
      expect(card.width, 'each card fits the phone width').toBeLessThanOrEqual(phoneLayout.width);
    }
    // A card opens the same live view under itself.
    await phone.locator(`tr[data-session="${session}"]`).click();
    await expect(phone.getByLabel('Session output')).toContainText('a fresh line the run just printed', settled);
    await phone.close();
  } finally {
    const ended = once(child, 'exit'); child.send('stop'); await ended;
    await database.close(); await rm(site, { recursive: true, force: true });
  }
});
