import { test, expect, type Browser, type Page } from '@playwright/test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { symlink, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { withDatabase } from '../tests/helpers/postgres';
import { temporaryDirectory } from '../tests/helpers/temp-dirs';
import { bridgeTerminals } from '../src/master/terminal-bridge';
import { terminalSessionReader } from '../src/master/terminal-session';
import type { MasterConfig } from '../src/master/profiles';
import { serveXterm } from './xterm';

const settled = { timeout: 15_000 };

/** The pane's scroll position in its buffer: `top` 0 is the first line of the history the page was sent. */
const scroll = (page: Page) => page.evaluate(() => {
  const terminal = (window as any).testTerminal, buffer = terminal.buffer.active;
  return { top: buffer.viewportY, bottom: buffer.length - terminal.rows, length: buffer.length };
});

/**
 * The Master page against the real control plane, with the host-side herdr stub holding more
 * history than one screen and its TUI running on the alternate screen: exactly the report (GY-3308).
 */
async function fixture(browser: Browser, width: 1280 | 390) {
  const site = await temporaryDirectory('master-scroll');
  await symlink(resolve('.graphyard/browser-dist'), join(site, 'dist'));
  const database = await withDatabase('master_scroll'); await database.init();
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
  await writeFile(join(site, 'master.daemon.json'), JSON.stringify({
    master: { agentName: 'master', pane: 'w1:master', account: 'test-account', runtime: 'codex' }, status: 'working', tui: true,
  }));
  const stopping = new AbortController();
  await new Promise<void>(done => bridgeTerminals(url, 'test-coordinator', stopping.signal, done, terminalSessionReader(() => ({ credentialFile: join(site, 'master.token') }) as MasterConfig)));
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, hasTouch: true });
  await serveXterm(context);
  const page = await context.newPage();
  // Capture the real xterm instance for scroll-position assertions, without replacing its behavior.
  await page.addInitScript(() => {
    let original: any;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => original, set: value => {
      original = class extends value { constructor(options: unknown) { super(options); (window as any).testTerminal = this; } };
    } });
  });
  const { code } = await (await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } })).json() as { code: string };
  await page.goto(`${url}/#sign-in=${code}&master`);
  await expect(page.locator('.xterm-rows')).toContainText('master TUI on w1:master', settled);
  return { page, stop: async () => {
    await context.close(); stopping.abort();
    const ended = once(child, 'exit'); child.send('stop'); await ended; await database.close();
    process.env = original;
  } };
}

/** One full check at one width: UP reaches the first line of the sent history below a reachable header, then the bottom follows live output again. */
async function scrollsToTheTop(page: Page, up: () => Promise<void>, down: () => Promise<void>, tries: number) {
  // A wheel notch moves a few lines, a drag or a page one screen: keep going until the top, as a reader would.
  for (let i = 0; i < tries && (await scroll(page)).top > 0; i++) await up();
  // The first line of the history the page was sent is fully visible below the page header — one
  // atomic DOM read, polled: xterm re-renders its rows as live output arrives.
  const firstLineBelowHeader = () => page.evaluate(() => {
    const header = document.querySelector('.top-bar')!.getBoundingClientRect();
    const row = [...document.querySelectorAll('.xterm-rows > div')].find(div => (div.textContent ?? '').includes('earlier line 0000'));
    if (!row) return false;
    const line = row.getBoundingClientRect();
    return line.y >= header.bottom - 1 && line.y + line.height <= innerHeight + 0.5
      // The header itself stays reachable: fully on screen while the history is scrolled.
      && header.top >= 0 && header.bottom <= innerHeight + 0.5;
  });
  await expect.poll(firstLineBelowHeader, { timeout: 10_000 }).toBe(true);
  // The view stays where the user scrolled while new live output arrives.
  const held = await scroll(page);
  await expect.poll(async () => (await scroll(page)).length).toBeGreaterThan(held.length);
  await page.waitForTimeout(400);
  expect((await scroll(page)).top).toBe(held.top);
  // Scrolling back to the bottom resumes following live output.
  for (let i = 0; i < tries && (await scroll(page)).top < (await scroll(page)).bottom; i++) await down();
  const followed = await scroll(page);
  await expect.poll(async () => (await scroll(page)).length).toBeGreaterThan(followed.length);
  const now = await scroll(page);
  expect(now.top).toBe(now.bottom);
  await expect(page.locator('.xterm-rows')).toContainText('live line ');
}

test('e2e:master-page-scroll-top — wheel, touch drag and keyboard reach the top of the history at 1280 px and 390 px, and live output neither pulls the view back nor traps the header', async ({ browser }) => {
  // Two cold server boots and six scroll sequences (three inputs at two widths), within the case's 300 s budget.
  test.setTimeout(240_000);
  const host = (page: Page) => page.locator('.terminal-host').boundingBox();
  const wheel = async (page: Page, up: boolean) => {
    const box = (await host(page))!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // Alt is the terminal's fast scroll: a plain notch moves a few lines, too slow to cross the history.
    await page.keyboard.down('Alt');
    await page.mouse.wheel(0, up ? -600 : 600);
    await page.keyboard.up('Alt');
  };
  // A finger dragged down the terminal moves the history down with it: one screen-length drag,
  // dispatched move by move as a real finger arrives (one frame each).
  const drag = async (page: Page, up: boolean) => {
    const box = (await host(page))!;
    const move = (step: number) => page.evaluate(({ box, up, step }) => {
      const target = document.querySelector('.terminal-host')!;
      const y = box.y + box.height / 2 + (up ? 1 : -1) * step * (box.height / 5);
      const touch = (type: string, y: number) => target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true,
        touches: [new Touch({ identifier: 1, target, clientX: box.x + box.width / 2, clientY: y })] }));
      step === 0 ? touch('touchstart', y) : step > 5 ? touch('touchend', y) : touch('touchmove', y);
    }, { box, up, step });
    for (let step = 0; step <= 6; step++) { await move(step); await page.waitForTimeout(20); }
  };
  const keys = async (page: Page, up: boolean) => {
    const box = (await host(page))!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.press(up ? 'Shift+PageUp' : 'Shift+PageDown');
  };

  for (const width of [1280, 390] as const) {
    const f = await fixture(browser, width), { page } = f;
    try {
      // The pane's TUI redraw must not cut the page off from the history it was sent.
      expect((await scroll(page)).length).toBeGreaterThan(await page.evaluate(() => (window as any).testTerminal.rows) * 2);
      await scrollsToTheTop(page, () => wheel(page, true), () => wheel(page, false), 400);
      await scrollsToTheTop(page, () => drag(page, true), () => drag(page, false), 120);
      await scrollsToTheTop(page, () => keys(page, true), () => keys(page, false), 120);
    } finally { await f.stop(); }
  }
});
