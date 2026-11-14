import { test, expect, type Browser } from '@playwright/test';
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
async function fixture(browser: Browser, phone = false) {
  const site = await temporaryDirectory('master-ux');
  await symlink(resolve('.graphyard/browser-dist'), join(site, 'dist'));
  const database = await withDatabase('master_ux'); await database.init();
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
  const current = { master: { agentName: 'master', pane: 'w1:master' as string | null, account: 'test-account', runtime: 'codex' }, status: 'idle', gap: '' };
  const save = () => writeFile(join(site, 'master.daemon.json'), JSON.stringify(current));
  await save();
  const stopping = new AbortController();
  await new Promise<void>(done => bridgeTerminals(url, 'test-coordinator', stopping.signal, done, terminalSessionReader(() => ({ credentialFile: join(site, 'master.token') }) as MasterConfig)));
  const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  await serveXterm(context);
  const page = await context.newPage();
  // Capture the real xterm instance for buffer/dimension assertions, without replacing its behavior.
  await page.addInitScript(() => {
    let original: any;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => original, set: value => {
      original = class extends value { constructor(options: unknown) { super(options); (window as any).testTerminal = this; } };
    } });
  });
  const { code } = await (await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } })).json() as { code: string };
  await page.goto(`${url}/#sign-in=${code}&master`);
  const calls = async () => (await readFile(join(site, 'herdr.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const inputs = async () => (await calls()).filter(entry => entry.command?.type === 'terminal.input').map(entry => entry.command.text);
  await expect(page.locator('.xterm-rows')).toContainText('screen of w1:master', settled);
  return { page, child, current, save, calls, inputs, stop: async () => {
    await context.close(); stopping.abort();
    const ended = once(child, 'exit'); child.send('stop'); await ended; await database.close();
    process.env = original;
  } };
}

test('e2e:master-page-ux — history, fitting, native input, clipboard, reconnect and pane changes', async ({ browser }) => {
  // Includes server startup, two reconnects and two pane changes under the parallel browser suite.
  test.setTimeout(60_000);
  const f = await fixture(browser), { page } = f;
  try {
    await expect(page.getByRole('status')).toContainText('test-account · codex · idle · w1:master');
    await expect(page.getByRole('status')).toContainText('You can type here');
    const layout = () => page.evaluate(() => {
      const terminal = (window as any).testTerminal, box = document.querySelector('.terminal-host')!.getBoundingClientRect();
      return { cols: terminal.cols, rows: terminal.rows, bottom: box.bottom, height: box.height, viewport: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    const before = await layout(); expect(before.height).toBeGreaterThan(600); expect(before.overflow).toBe(false);
    // The terminal ends at the page's bottom padding: the document never scrolls (GY-3308), so the
    // gap below it is that padding (32 px on a desktop main) rather than a fixed 12 px, and at least the version-label strip (GY-3310).
    expect(before.viewport - before.bottom).toBeLessThan(40);
    await page.setViewportSize({ width: 1050, height: 720 });
    await expect.poll(async () => (await layout()).cols).not.toBe(before.cols);
    const after = await layout();
    await expect.poll(async () => (await f.calls()).filter(entry => entry.size).at(-1)?.size).toEqual({ cols: after.cols, rows: after.rows });
    // History is actually in xterm's scrollback, not just a hidden JSON frame.
    await page.evaluate(() => (window as any).testTerminal.scrollToTop());
    await expect(page.locator('.xterm-rows')).toContainText('earlier line 0000');
    expect(await page.evaluate(() => {
      const buffer = (window as any).testTerminal.buffer.active;
      return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString()).filter(line => String(line).startsWith('earlier line ')).length;
    })).toBe(1000);
    await page.evaluate(() => (window as any).testTerminal.scrollToBottom());
    await page.keyboard.type('hello master'); await page.keyboard.press('Enter');
    for (const key of ['Control+c', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape', 'Alt+x']) await page.keyboard.press(key);
    await expect.poll(f.inputs).toEqual(expect.arrayContaining(['\x03', '\x1b[A', '\x1b[B', '\x1b[D', '\x1b[C', '\x1b', '\x1bx']));
    await expect(page.locator('.xterm-rows')).toContainText('hello master');
    await page.evaluate(() => navigator.clipboard.writeText('first line\nsecond line'));
    await page.keyboard.press('Control+Shift+V');
    await expect.poll(f.inputs).toContain('\x1b[200~first line\rsecond line\x1b[201~');
    await page.evaluate(() => (window as any).testTerminal.select(0, (window as any).testTerminal.buffer.active.baseY, 6));
    const selected = await page.evaluate(() => (window as any).testTerminal.getSelection());
    await page.keyboard.press('Control+Shift+C');
    expect(selected).not.toBe('');
    // Copy writes asynchronously; key dispatch can finish before the native clipboard write.
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(selected);
    await page.evaluate(() => navigator.clipboard.writeText('right click paste'));
    await page.locator('.terminal-host').click({ button: 'right' });
    await expect.poll(f.inputs).toContain('\x1b[200~right click paste\x1b[201~');
    await page.evaluate(() => (window as any).survivedDrop = true);
    // The pane's output changes before the drop: the reconnect re-reads it 250 ms later, and output
    // written after the drop could miss that read (GY-3261).
    f.current.gap = 'output produced during the gap'; await f.save();
    f.child.send('drop-terminals');
    await expect(page.locator('.live-terminal')).toHaveAttribute('data-terminal', 'reconnecting');
    await expect(page.locator('.xterm-rows')).toContainText(f.current.gap, settled);
    expect(await page.evaluate(() => (window as any).survivedDrop)).toBe(true);
    // A failed reconnect while offline must keep retrying once the network returns.
    await page.context().setOffline(true);
    f.current.gap = 'output while offline'; await f.save();
    f.child.send('drop-terminals');
    await expect(page.locator('.live-terminal')).toHaveAttribute('data-terminal', 'reconnecting');
    await page.waitForTimeout(1000);
    await page.context().setOffline(false);
    await expect(page.locator('.xterm-rows')).toContainText(f.current.gap, settled);
    f.current.master.pane = 'w1:replacement'; f.current.master.account = 'second-account'; f.current.status = 'working'; await f.save();
    await expect(page.locator('.xterm-rows')).toContainText('screen of w1:replacement');
    await expect(page.getByRole('status')).toContainText('second-account · codex · working · w1:replacement');
    f.current.master.pane = null; f.current.master.agentName = ''; await f.save();
    await expect(page.getByRole('status')).toContainText('The loop relaunches the master on its own.');
    f.child.send('drop-terminals');
    await expect(page.locator('.live-terminal')).toHaveAttribute('data-terminal', 'control');
    await expect(page.getByRole('status')).toContainText('absent · No pane');
    f.current.master.pane = 'w1:returned'; f.current.master.agentName = 'master'; await f.save();
    await expect(page.locator('.xterm-rows')).toContainText('screen of w1:returned');
  } finally { await f.stop(); }
});

test('e2e:master-page-phone — fits 390x844 and phone keys reach the pane', async ({ browser }) => {
  const f = await fixture(browser, true), { page } = f;
  try {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const box = await page.locator('.terminal-host').boundingBox(); expect(box!.width).toBeLessThan(390); expect(box!.height).toBeGreaterThan(300);
    const keys = page.getByRole('group', { name: 'Terminal keys' });
    for (const name of ['Esc', 'Tab', 'Ctrl-C', '←', '↓', '↑', '→', 'Enter']) await keys.getByRole('button', { name, exact: true }).click();
    await expect.poll(f.inputs).toEqual(['\x1b', '\t', '\x03', '\x1b[D', '\x1b[B', '\x1b[A', '\x1b[C', '\r']);
  } finally { await f.stop(); }
});
