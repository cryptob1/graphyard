import { test, expect, type Browser, type Page } from '@playwright/test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { withDatabase } from '../tests/helpers/postgres';
import { temporaryDirectory } from '../tests/helpers/temp-dirs';
import { bridgeTerminals } from '../src/master/terminal-bridge';
import { terminalSessionReader } from '../src/master/terminal-session';
import type { MasterConfig } from '../src/master/profiles';
import { serveXterm } from './xterm';

const settled = { timeout: 15_000 };

/**
 * How the pane's drawing sits in the terminal container: the host-side herdr stub's master pane is
 * laid out at 70 columns and draws a ruler, every row filled to the pane's width and ending in `|`.
 * `right` is the gap from the last drawn column to the container's right edge, `bottom` from the last
 * drawn row to its bottom edge, each in character cells.
 */
const fill = (page: Page) => page.evaluate(() => {
  const host = document.querySelector('.terminal-host')!.getBoundingClientRect();
  const rows = [...document.querySelectorAll('.xterm-rows > div')].filter(row => /^row \d+ =*\|$/.test((row.textContent ?? '').trimEnd()));
  const last = rows.at(-1);
  if (!last) return null;
  const terminal = (window as any).testTerminal, screen = document.querySelector('.xterm-screen')!.getBoundingClientRect();
  const cell = { width: screen.width / terminal.cols, height: screen.height / terminal.rows };
  // The rendered `|` itself, measured off the DOM, not computed from the buffer.
  const walker = document.createTreeWalker(last, NodeFilter.SHOW_TEXT);
  let bar: DOMRect | undefined;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.textContent!.lastIndexOf('|');
    if (at >= 0) { const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + 1); bar = range.getBoundingClientRect(); }
  }
  if (!bar) return null;
  return {
    right: (host.right - bar.right) / cell.width,
    bottom: (host.bottom - last.getBoundingClientRect().bottom) / cell.height,
    drawnRows: rows.length, rows: terminal.rows,
    // The Master page document never scrolls (GY-3308).
    documentScrolls: document.scrollingElement!.scrollHeight > innerHeight + 1 || scrollY !== 0,
  };
});

/** The pane's drawing spans the container's width (its last column within one cell of the right edge) and its rows fill the height. */
async function fillsThePage(page: Page) {
  const fills = (at: Awaited<ReturnType<typeof fill>>) => !!at && at.right >= 0 && at.right <= 1 && at.bottom >= 0 && at.bottom <= 1 && at.drawnRows === at.rows;
  await expect.poll(async () => fills(await fill(page)), settled).toBe(true).catch(async error => {
    throw new Error(`The terminal does not fill its container (gaps in cells): ${JSON.stringify(await fill(page))}\n${error}`);
  });
  expect((await fill(page))!.documentScrolls).toBe(false);
}

async function fixture() {
  const site = await temporaryDirectory('master-fills');
  await symlink(resolve('.graphyard/browser-dist'), join(site, 'dist'));
  const database = await withDatabase('master_fills'); await database.init();
  const child = fork(resolve('tests/helpers/terminal-server.ts'), [(database.pool.options as { connectionString: string }).connectionString, site], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, PATH: join(site, 'empty'), HOME: site, GRAPHYARD_HERDR_CONFIG_HOME: '', GRAPHYARD_HERDR_SESSION: '' },
  });
  const [{ url }] = await once(child, 'message') as [{ url: string }];
  const original = { ...process.env };
  process.env.PATH = `${resolve('fixtures/herdr-terminal-stub')}${delimiter}${process.env.PATH}`;
  process.env.HERDR_STUB_LOG = join(site, 'herdr.log');
  process.env.HERDR_STUB_STATE = join(site, 'master.daemon.json');
  process.env.GRAPHYARD_HERDR_CONFIG_HOME = ''; process.env.GRAPHYARD_HERDR_SESSION = '';
  // The pane Herdr laid out at 70 columns, as in the owner's report.
  await writeFile(join(site, 'master.daemon.json'), JSON.stringify({
    master: { agentName: 'master', pane: 'w1:master', account: 'test-account', runtime: 'codex' }, status: 'idle', pane: { cols: 70, rows: 20 },
  }));
  const stopping = new AbortController();
  await new Promise<void>(done => bridgeTerminals(url, 'test-coordinator', stopping.signal, done, terminalSessionReader(() => ({ credentialFile: join(site, 'master.token') }) as MasterConfig)));
  const inputs = async () => (await readFile(join(site, 'herdr.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.command?.type === 'terminal.input');
  return { url, child, inputs, stop: async () => {
    stopping.abort();
    const ended = once(child, 'exit'); child.send('stop'); await ended; await database.close();
    process.env = original;
  } };
}

async function open(browser: Browser, url: string, width: 1280 | 390, viewer: 'typing' | 'read-only') {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
  await serveXterm(context);
  const page = await context.newPage();
  await page.addInitScript(() => {
    let original: any;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => original, set: value => {
      original = class extends value { constructor(options: unknown) { super(options); (window as any).testTerminal = this; } };
    } });
  });
  if (viewer === 'typing') {
    const { code } = await (await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } })).json() as { code: string };
    await page.goto(`${url}/#sign-in=${code}&master`);
  } else {
    await page.addInitScript(() => sessionStorage.setItem('graphyard-token', 'test-reader'));
    await page.goto(`${url}/#master`);
  }
  await expect(page.getByRole('status')).toContainText(viewer === 'typing' ? 'You can type here' : 'read-only', settled);
  return { page, close: () => context.close() };
}

test('e2e:master-terminal-fills-page — the Master terminal fills the page on open, after navigating back and after a reconnect, for typing and read-only viewers at 1280 px and 390 px', async ({ browser }) => {
  test.setTimeout(240_000);
  const f = await fixture();
  try {
    for (const width of [1280, 390] as const) for (const viewer of ['typing', 'read-only'] as const) {
      const { page, close } = await open(browser, f.url, width, viewer);
      try {
        // First open.
        await fillsThePage(page);
        // Away to Work and back to Master: the page mounts a new terminal.
        const menu = page.getByRole('navigation', { name: 'Primary' });
        if (width === 390) await page.getByRole('button', { name: 'Menu' }).click();
        await menu.getByRole('button', { name: 'Work', exact: true }).click();
        await expect(page.locator('.terminal-host')).toHaveCount(0);
        if (width === 390) await page.getByRole('button', { name: 'Menu' }).click();
        await menu.getByRole('button', { name: 'Master', exact: true }).click();
        await fillsThePage(page);
        // A reconnect: the server drops the socket and the page dials back in.
        f.child.send('drop-terminals');
        await expect(page.locator('.live-terminal')).toHaveAttribute('data-terminal', 'reconnecting', settled);
        await expect(page.locator('.live-terminal')).toHaveAttribute('data-terminal', viewer === 'typing' ? 'control' : 'observe', settled);
        await fillsThePage(page);
        if (viewer === 'read-only') {
          // Still no way to send input: typed keys never reach the pane and the phone keys stay disabled.
          await page.locator('.terminal-host').click();
          await page.keyboard.type('rm -rf'); await page.keyboard.press('Enter');
          await page.waitForTimeout(300);
          expect((await f.inputs()).map(entry => entry.command.text).join('')).not.toContain('rm -rf');
          if (width === 390) await expect(page.getByRole('group', { name: 'Terminal keys' }).getByRole('button', { name: 'Enter' })).toBeDisabled();
        }
      } finally { await close(); }
    }
  } finally { await f.stop(); }
});
