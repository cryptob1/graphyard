import { test, expect } from '@playwright/test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { signInDatabase } from '../tests/helpers/sign-in-database';
import { serveXterm } from './xterm';

const settled = { timeout: 15_000 };
const fromA = 'Your trial image lacks Go 1.23; can you add it?';
const toB = 'GY-40 adds Go 1.23 to the trial image; retry once it is served.';
const blocker = `The staging database is unreachable from the worker sandbox: psql connection refused on 127.0.0.1:5432 ${'and the retry budget is spent '.repeat(6)}`.trim();

/**
 * GY-3481: the Master page shows what is stuck and the terminal; messages between installs fold
 * away below it. The real control plane serves the built dashboard with a stub herdr master pane.
 */
test('e2e:master-page-plain — blockers and the terminal first, install messages in one closed fold below, plain status strings at 1280 and 390 px', async ({ browser }) => {
  test.setTimeout(120_000);
  const database = await signInDatabase();
  const site = await mkdtemp(join(tmpdir(), 'graphyard-master-plain-'));
  await symlink(resolve('.graphyard/browser-dist'), join(site, 'dist'));
  const child = fork(resolve('tests/helpers/terminal-server.ts'), [database.url, site], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, PATH: `${resolve('fixtures/herdr-terminal-stub')}${delimiter}${process.env.PATH}`, HERDR_STUB_LOG: join(site, 'herdr.log'), GRAPHYARD_HERDR_CONFIG_HOME: '', GRAPHYARD_HERDR_SESSION: '' } });
  const [{ url }] = await once(child, 'message') as [{ url: string }];
  const call = async (bearer: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json() as Promise<any>;
  };
  try {
    // Two install messages, one thread each, and one blocker the Master owes.
    await call('test-install-a', 'master/messages', { text: fromA, thread: 'from-install-a' });
    await call('test-coordinator', 'master/messages', { text: toB, thread: 'to-install-b', to: 'install-b' });
    const fleet = await call('test-human-operator', 'work');
    const item = (fleet.work ?? fleet).find((entry: any) => entry.title === 'Watch a worker');
    await call('test-worker', `work/${item.id}/blocked`, { epoch: item.epoch, reason: blocker });
    await call('test-coordinator', 'product-brief', { markdown: '## Problem\n\nShip faster.', updatedAt: '2026-11-13T08:00:00Z', by: 'graphyard-master', why: 'the standing brief',
      history: [{ at: '2026-11-13T08:00:00Z', by: 'graphyard-master', why: 'the standing brief', words: 3 }] });

    for (const width of [1280, 390] as const) {
      const { code } = await call('test-human-operator', 'sign-in-links', {});
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
      await serveXterm(context);
      const page = await context.newPage();
      await page.goto(`${url}/#sign-in=${code}&master`);
      const status = page.getByRole('status');
      await expect(status).toContainText('You can type here', settled);
      await expect(page.locator('.terminal-session')).toHaveText('Working · master-agent');
      await expect(page.locator('.terminal-session')).toHaveAttribute('title', 'claude · w1:master');

      // Blockers: 'Blocked (1)', key, title and age; the blocker one line, its full text in its title.
      const owes = page.getByRole('region', { name: 'Blockers the Master owes' });
      await expect(owes.getByRole('heading')).toHaveText('Blocked (1)', settled);
      await expect(owes).toContainText(`${item.key} Watch a worker`);
      await expect(owes).toContainText(/blocked \S+/);
      const line = owes.locator(`[title="${blocker}"]`);
      await expect(line).toHaveText(blocker);
      const box = await line.evaluate(element => ({ height: element.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(element).lineHeight) || 16,
        clipped: element.scrollWidth > element.clientWidth, ellipsis: getComputedStyle(element).textOverflow }));
      expect(box.height, 'the blocker reads as one line').toBeLessThan(box.lineHeight * 1.6);
      expect(box.clipped && box.ellipsis === 'ellipsis', 'a long blocker ends in an ellipsis').toBe(true);

      // Nothing above the terminal carries a message body; one closed fold below it holds the threads.
      const above = await page.evaluate(() => {
        const terminal = document.querySelector('.live-terminal')!;
        const main = terminal.closest('main') ?? document.body;
        let text = '';
        for (const node of main.querySelectorAll('*')) if (!node.children.length && (node.compareDocumentPosition(terminal) & Node.DOCUMENT_POSITION_FOLLOWING)) text += ` ${(node as HTMLElement).innerText ?? ''}`;
        return text;
      });
      expect(above).not.toContain(fromA); expect(above).not.toContain(toB);
      const fold = page.locator('details', { hasText: 'Messages with other installs (2)' });
      await expect(fold).toHaveCount(1);
      expect(await fold.evaluate((element, terminal) => !!(terminal!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING), await page.locator('.live-terminal').elementHandle())).toBe(true);
      await expect(fold).not.toHaveAttribute('open');
      await expect(page.getByText(fromA)).toBeHidden();
      await expect(page.getByText(toB)).toBeHidden();

      // Outside a title, the closed fold or the pane's own screen, no principal id or pane id is visible.
      const visible = await page.evaluate(() => {
        const copy = document.body.cloneNode(true) as HTMLElement; copy.querySelector('.terminal-host')?.remove();
        copy.style.position = 'absolute'; document.body.append(copy);
        try { return copy.innerText; } finally { copy.remove(); }
      });
      for (const id of ['w1:master', 'w1:worker', 'install-a', 'install-b', 'agent-a', 'executor-a', 'graphyard-master', 'test-account']) expect(visible, id).not.toContain(id);
      for (const old of ['the Master clears these', 'read-only: only the operator', 'The loop relaunches']) expect(visible).not.toContain(old);

      await fold.locator('summary').click();
      for (const [peer, text] of [['install-a', fromA], ['install-b', toB]] as const) {
        const thread = fold.getByRole('article', { name: `Thread with ${peer}` });
        await expect(thread.getByRole('heading')).toHaveText(`With ${peer}`);
        await expect(thread).toContainText(text);
      }
      expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth), `no horizontal scroll at ${width} px`).toBe(true);

      // A viewer reads 'View only'; signed out reads 'Sign in to see the terminal.'
      const viewer = await context.newPage();
      await viewer.addInitScript(() => sessionStorage.setItem('graphyard-token', 'test-reader'));
      await viewer.goto(`${url}/#master`);
      await expect(viewer.getByRole('status')).toContainText('View only', settled);

      // Product: when and by whom in plain words; reasons only in the Changes fold.
      await page.goto(`${url}/#product`);
      await expect(page.getByText('Updated Nov 13 by the master.')).toBeVisible(settled);
      const product = await page.evaluate(() => document.body.innerText);
      expect(product).not.toContain('graphyard-master'); expect(product).not.toContain('the standing brief');
      expect(product).not.toContain('Kept by the master');
      await context.close();
    }

    const signedOut = await browser.newPage(); await serveXterm(signedOut);
    await signedOut.goto(`${url}/#master`);
    await expect(signedOut.getByText('Sign in to see the terminal.')).toBeVisible(settled);
    await signedOut.close();
  } finally {
    const ended = once(child, 'exit'); child.send('stop'); await ended;
    await database.close(); await rm(site, { recursive: true, force: true });
  }
});
