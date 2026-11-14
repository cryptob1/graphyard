import { test, expect, type Page } from '@playwright/test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { signInDatabase } from '../tests/helpers/sign-in-database';
import { serveXterm } from './xterm';

const stub = resolve('fixtures/herdr-terminal-stub');
const settled = { timeout: 15_000 };

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
/** Fires a browser paste event carrying TEXT and/or a PNG on the terminal, as Ctrl/Cmd+V does. */
const paste = (page: Page, text: string, image: boolean) => page.locator('.xterm-helper-textarea').evaluate((area, { text, image, bytes }) => {
  const data = new DataTransfer();
  if (text) data.setData('text/plain', text);
  if (image) data.items.add(new File([new Uint8Array(bytes)], 'shot.png', { type: 'image/png' }));
  area.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}, { text, image, bytes: [...png] });

test('e2e:master-page-paste — Ctrl+V text arrives as one bracketed paste, a PNG is saved to the inbox and its path pasted, a viewer is refused', async ({ browser }) => {
  const database = await signInDatabase();
  const site = await mkdtemp(join(tmpdir(), 'graphyard-master-paste-'));
  const log = join(site, 'herdr.log');
  await symlink(resolve('.graphyard/browser-dist'), join(site, 'dist'));
  const child = fork(resolve('tests/helpers/terminal-server.ts'), [database.url, site], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, PATH: `${stub}${delimiter}${process.env.PATH}`, HERDR_STUB_LOG: log, GRAPHYARD_HERDR_CONFIG_HOME: '', GRAPHYARD_HERDR_SESSION: '' } });
  const [{ url }] = await once(child, 'message') as [{ url: string }];
  const typed = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.command?.type === 'terminal.input').map(entry => entry.command.text as string);
  try {
    const { code } = await (await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } })).json() as { code: string };
    const operator = await browser.newPage(); await serveXterm(operator);
    await operator.goto(`${url}/#sign-in=${code}&master`);
    await expect(operator.getByRole('status')).toContainText('You can type here', settled);
    await operator.locator('.terminal-host').click();

    // Real Ctrl+V: the browser's paste event delivers the text as one bracketed paste and no raw ^V reaches the pane.
    await operator.keyboard.press('Control+V');
    await paste(operator, 'a paragraph\nof pasted text', false);
    await expect.poll(async () => (await typed()).join(''), settled).toContain('\x1b[200~a paragraph\rof pasted text\x1b[201~');
    expect((await typed()).join('')).not.toContain('\x16');

    // A PNG is saved under .graphyard/master-inbox/ and its absolute path is pasted.
    await paste(operator, '', true);
    await expect(operator.getByRole('status')).toContainText('Pasted image → ', settled);
    const path = (await operator.getByRole('status').innerText()).match(/→ (\S+)/)![1]!;
    expect(path.startsWith(join(await realpath(site), '.graphyard', 'master-inbox') + '/') || path.startsWith(join(site, '.graphyard', 'master-inbox') + '/')).toBe(true);
    expect(path).toMatch(/shot\.png$/);
    expect((await stat(path)).size).toBe(png.length);
    await expect.poll(async () => (await typed()).join(''), settled).toContain(`\x1b[200~${path}\x1b[201~`);

    // A read-only viewer's paste is refused with a note and reaches nothing.
    const before = (await typed()).length;
    const reader = await browser.newPage(); await serveXterm(reader);
    await reader.addInitScript(() => sessionStorage.setItem('graphyard-token', 'test-reader'));
    await reader.goto(`${url}/#master`);
    await expect(reader.getByRole('status')).toContainText('read-only', settled);
    await paste(reader, 'sneaky', true);
    await expect(reader.getByRole('status')).toContainText('Paste refused', settled);
    expect((await typed()).length).toBe(before);
    await reader.close(); await operator.close();
  } finally {
    const ended = once(child, 'exit'); child.send('stop'); await ended;
    await database.close(); await rm(site, { recursive: true, force: true });
  }
});
