import { test, expect, type Page } from '@playwright/test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { symlink } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { signInDatabase } from '../tests/helpers/sign-in-database';
import { temporaryDirectory } from '../tests/helpers/temp-dirs';
import { serveXterm } from './xterm';

// GY-3479: no page of the dashboard is clipped. Nothing widens the page past the window, the
// sidebar's first label reads in full, the version sits in the sidebar foot clear of everything,
// and on Work every row keeps its "Who acts next" and "In step" cells inside the row.
const stub = resolve('fixtures/herdr-terminal-stub');
const settled = { timeout: 15_000 };
const operator = { Authorization: 'Bearer test-human-operator', 'Content-Type': 'application/json' };

/** The real control plane serving the built dashboard, with the stub herdr for the Master terminal (tests/helpers/terminal-server.ts). */
async function plane(database: string, site: string) {
  const child = fork(resolve('tests/helpers/terminal-server.ts'), [database, site], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, GRAPHYARD_BUILD_SHA: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b', PATH: `${stub}${delimiter}${process.env.PATH}`, HERDR_STUB_LOG: join(site, 'herdr.log'), GRAPHYARD_HERDR_CONFIG_HOME: '', GRAPHYARD_HERDR_SESSION: '' } });
  const [{ url }] = await once(child, 'message') as [{ url: string }];
  return { url, close: async () => { const ended = once(child, 'exit'); child.send('stop'); await ended; } };
}

/** Rows that wait on someone and rows that move, with long titles, so Work shows full rows. */
async function seed(url: string) {
  for (const n of [1, 2, 3]) {
    const item = await (await fetch(`${url}/api/work`, { method: 'POST', headers: { ...operator, 'Idempotency-Key': `no-clipping-${n}` },
      body: JSON.stringify({ title: `A long enough title for row ${n} that it has to wrap onto a second line on a narrow window`, why: 'The operator reads the whole row.', simplest: 'One row per item.', type: 'feature', criteria: [{ id: 'AC-1', text: 'It works', proofs: ['e2e:fixture'] }] }) })).json() as { id: string };
    if (n > 1) await fetch(`${url}/api/work/${item.id}/ready`, { method: 'POST', headers: { ...operator, 'Idempotency-Key': `no-clipping-ready-${n}` }, body: JSON.stringify({ reason: 'Seeded' }) });
  }
  await fetch(`${url}/api/team-access/share-link`, { method: 'POST', headers: operator, body: JSON.stringify({ url: 'https://login.tailscale.com/admin/invite/no-clipping-share' }) });
}

/** What the open page shows about clipping, read after a sideways wheel scroll. */
async function check(page: Page, where: string) {
  const width = page.viewportSize()!.width;
  await page.mouse.move(width / 2, 300);
  await page.mouse.wheel(400, 0);
  await page.waitForTimeout(100);
  const read = await page.evaluate(() => {
    const doc = document.documentElement;
    // The text a person sees of a sidebar label: its own box, cut by any ancestor that clips it and by the window.
    const seen = (node: Element | null) => {
      const box = node?.getBoundingClientRect();
      if (!node || !box) return { left: -1, text: '(missing)' };
      let left = Math.max(box.left, 0);
      for (let parent = node.parentElement; parent; parent = parent.parentElement) if (getComputedStyle(parent).overflowX !== 'visible') left = Math.max(left, parent.getBoundingClientRect().left);
      return { left: box.left, text: left > box.left + 1 ? '(cut)' : node.textContent!.trim() };
    };
    const first = seen(document.querySelector('.primary-nav .nav span')), master = seen(document.querySelector('.primary-nav [data-nav="master"] span'));
    const label = document.querySelector('.version-label');
    const foot = label?.closest('.sidebar-bottom');
    const at = label?.getBoundingClientRect();
    const sidebar = document.querySelector('.sidebar')!.getBoundingClientRect();
    const hits = (other: DOMRect) => !!at && other.width > 0 && other.height > 0 && other.left < at.right && other.right > at.left && other.top < at.bottom && other.bottom > at.top;
    const overlaps = label ? [...document.body.querySelectorAll('*')].filter(other => !other.contains(label) && !label.contains(other) && getComputedStyle(other).visibility !== 'hidden' && hits(other.getBoundingClientRect())).map(other => other.outerHTML.slice(0, 100)) : [];
    return {
      scroll: { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth }, offsetLeft: window.visualViewport!.offsetLeft, scrollX: window.scrollX,
      first, master,
      label: !!label, inFoot: !!foot, insideSidebar: !!at && at.left >= sidebar.left - 1 && at.right <= sidebar.right + 1, overlaps,
    };
  });
  expect.soft(read.scroll.scrollWidth, `${where}: the page is no wider than the window`).toBe(read.scroll.clientWidth);
  expect.soft(read.offsetLeft, `${where}: the view stays at the left edge after a sideways scroll`).toBe(0);
  expect.soft(read.scrollX, `${where}: the page does not scroll sideways`).toBe(0);
  expect.soft(read.first.left, `${where}: the first sidebar label starts inside the window`).toBeGreaterThanOrEqual(0);
  expect.soft(read.first.text, `${where}: the first sidebar label reads in full`).toBe('Work');
  expect.soft(read.master.left, `${where}: the Master label starts inside the window`).toBeGreaterThanOrEqual(0);
  expect.soft(read.master.text, `${where}: the Master label reads in full`).toBe('Master');
  expect.soft(read.label, `${where}: the version shows`).toBe(true);
  expect.soft(read.inFoot, `${where}: the version sits in the sidebar foot`).toBe(true);
  if (width > 650) expect.soft(read.insideSidebar, `${where}: the version sits inside the sidebar`).toBe(true);
  expect.soft(read.overlaps, `${where}: the version overlaps nothing`).toEqual([]);
}

/** On a phone the menu folds the sidebar away; it is opened to read its labels, then closed. */
async function checkWithMenu(page: Page, where: string) {
  const narrow = page.viewportSize()!.width <= 650;
  const menu = page.getByRole('button', { name: 'Menu' });
  if (narrow) await menu.click();
  await check(page, where);
  if (narrow) await menu.click();
}

for (const viewport of [{ width: 390, height: 844 }, { width: 800, height: 700 }, { width: 1280, height: 800 }]) {
  test(`e2e:dashboard-no-clipping — no page is clipped at ${viewport.width} px`, async ({ browser }) => {
    test.setTimeout(180_000);
    const database = await signInDatabase();
    const site = await temporaryDirectory('no-clipping');
    await symlink(resolve('.graphyard/browser-dist'), join(site, 'dist'));
    const http = await plane(database.url, site);
    const page = await browser.newPage({ viewport }); await serveXterm(page);
    try {
      await seed(http.url);
      const { code } = await (await fetch(`${http.url}/api/sign-in-links`, { method: 'POST', headers: operator })).json() as { code: string };
      await page.goto(`${http.url}/#sign-in=${code}`);
      await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible(settled);
      await expect(page.locator('.work-row').first()).toBeVisible(settled);
      await expect(page.locator('.version-label')).toContainText('Graphyard 1a2b3c4', settled);
      await checkWithMenu(page, 'Work');

      if (viewport.width === 800) {
        const cut = await page.locator('.work-row').evaluateAll(rows => rows.flatMap(row => {
          const outer = row.getBoundingClientRect();
          return [...row.querySelectorAll('.row-who, .row-time')].filter(cell => { const box = cell.getBoundingClientRect(); return box.width > 0 && (box.left < outer.left - 1 || box.right > outer.right + 1 || box.top < outer.top - 1 || box.bottom > outer.bottom + 1); })
            .map(cell => `${row.getAttribute('data-row')} ${cell.className}`);
        }));
        expect.soft(cut, 'every row keeps its Who acts next and In step cells inside it').toEqual([]);
      }

      await page.evaluate(() => { location.hash = 'master'; });
      await expect(page.locator('.xterm-rows')).toContainText('screen of w1:master', settled);
      await page.locator('.xterm-screen').click();
      await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
      await checkWithMenu(page, 'Master');

      await page.evaluate(() => { location.hash = 'workers'; });
      await expect(page.getByRole('heading', { name: 'Workers', exact: true, level: 1 })).toBeVisible(settled);
      await checkWithMenu(page, 'Workers');

      await page.evaluate(() => { location.hash = 'agents'; });
      await expect(page.getByRole('navigation', { name: 'Pages in this section' }).getByRole('button', { name: 'Agents', exact: true })).toHaveAttribute('aria-current', 'page', settled);
      await checkWithMenu(page, 'Settings → Agents');

      await page.evaluate(() => { location.hash = 'setup'; });
      await expect(page.getByRole('heading', { name: 'Set up Graphyard', exact: true, level: 1 })).toBeVisible(settled);
      await checkWithMenu(page, 'Settings → Setup');

      // GY-3486: the Invite dialog from the top bar fits the window too.
      await page.getByRole('button', { name: 'Invite', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Invite' });
      await expect(dialog.getByRole('group', { name: 'Installs on this machine' })).toBeVisible(settled);
      const box = await dialog.evaluate(node => { const at = node.getBoundingClientRect(); return { left: at.left, right: at.right, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth }; });
      expect.soft(box.left, 'Invite: the dialog starts inside the window').toBeGreaterThanOrEqual(0);
      expect.soft(box.right, 'Invite: the dialog ends inside the window').toBeLessThanOrEqual(viewport.width);
      expect.soft(box.scrollWidth, 'Invite: nothing in the dialog is wider than it').toBeLessThanOrEqual(box.clientWidth);
      expect.soft(box.page, 'Invite: the page is no wider than the window').toBe(0);
      await dialog.getByRole('button', { name: 'Close Invite' }).click();
      await expect(dialog).toBeHidden(settled);

      await page.evaluate(() => { location.hash = 'work'; });
      await page.locator('.work-row .card-open').first().click();
      await expect(page.getByRole('button', { name: /Back/ }).first()).toBeVisible(settled);
      await checkWithMenu(page, 'item page');
    } finally { await page.close(); await http.close(); await database.close(); }
  });
}
