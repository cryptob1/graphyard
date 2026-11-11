import { test, expect, type Page } from '@playwright/test';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { signInDatabase } from '../tests/helpers/sign-in-database';

const stub = resolve('fixtures/herdr-terminal-stub');
const settled = { timeout: 15_000 };

/** The status a WebSocket handshake to /api/terminal answers with, carrying TOKEN as the dashboard does. */
const handshake = (url: string, token?: string) => new Promise<number>((done, fail) => {
  const call = request(`${url}/api/terminal`, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), ...(token ? { 'Sec-WebSocket-Protocol': `graphyard, ${token}` } : {}) } });
  call.on('upgrade', (response, socket) => { socket.destroy(); done(response.statusCode!); });
  call.on('response', response => { response.resume(); done(response.statusCode!); });
  call.on('error', fail); call.end();
});

test('e2e:master-page-terminal — the operator types into the master pane live; others watch read-only; a worker pane opens from Workers; closing detaches', async ({ browser }) => {
  const database = await signInDatabase();
  const site = await mkdtemp(join(tmpdir(), 'graphyard-master-terminal-'));
  const log = join(site, 'herdr.log');
  // The server serves ./dist: the bundle Playwright's web server built.
  await symlink(resolve('.graphyard/browser-dist'), join(site, 'dist'));
  const child = fork(resolve('tests/helpers/terminal-server.ts'), [database.url, site], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, PATH: `${stub}${delimiter}${process.env.PATH}`, HERDR_STUB_LOG: log, GRAPHYARD_HERDR_CONFIG_HOME: '', GRAPHYARD_HERDR_SESSION: '' } });
  const [{ url }] = await once(child, 'message') as [{ url: string }];
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const rows = (page: Page) => page.locator('.xterm-rows');
  try {
    // Unauthenticated, or with a token nobody holds, the handshake is refused before any upgrade.
    expect(await handshake(url)).toBe(401);
    expect(await handshake(url, 'not-a-token')).toBe(401);

    // The operator signs in from a link straight to the Master page and sees the master's screen.
    const { code } = await (await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } })).json() as { code: string };
    const operator = await browser.newPage();
    await operator.goto(`${url}/#sign-in=${code}&master`);
    await expect(operator.getByRole('heading', { name: 'Master', exact: true })).toBeVisible(settled);
    await expect(rows(operator)).toContainText('screen of w1:master', settled);
    await expect(operator.getByRole('status')).toContainText('You can type here', settled);
    // It types a line and sees it echoed back through the WebSocket.
    await operator.locator('.terminal-host').click();
    await operator.keyboard.type('status please');
    await operator.keyboard.press('Enter');
    await expect(rows(operator)).toContainText('status please', settled);
    expect((await calls()).some(entry => entry.args?.slice(0, 4).join(' ') === 'terminal session control w1:master')).toBe(true);
    // The typed line is in history, attributed to the human who typed it.
    await expect.poll(async () => (await database.store.pool.query("SELECT actor, payload FROM events WHERE kind='master.terminal.input'")).rows, settled)
      .toEqual([{ actor: 'operator', payload: { pane: 'w1:master', line: 'status please' } }]);

    // A reader's session sees the same screen, read-only: what it types never reaches the pane.
    const reader = await browser.newPage();
    await reader.addInitScript(() => sessionStorage.setItem('graphyard-token', 'test-reader'));
    await reader.goto(`${url}/#master`);
    await expect(rows(reader)).toContainText('screen of w1:master', settled);
    await expect(reader.getByRole('status')).toContainText('read-only', settled);
    await reader.locator('.terminal-host').click();
    await reader.keyboard.type('rm -rf');
    await reader.keyboard.press('Enter');
    expect((await calls()).some(entry => entry.args?.slice(0, 4).join(' ') === 'terminal session observe w1:master')).toBe(true);
    expect((await calls()).filter(entry => entry.command?.type === 'terminal.input').map(entry => entry.command.text).join('')).not.toContain('rm -rf');
    await reader.close();

    // The operator leaves for Workers: the page detaches, Herdr is released, and no pane is closed.
    await operator.getByRole('navigation', { name: 'Pages in this section' }).getByRole('button', { name: 'Workers', exact: true }).click();
    await expect.poll(async () => (await calls()).some(entry => entry.pane === 'w1:master' && entry.command?.type === 'terminal.release'), settled).toBe(true);
    expect((await calls()).some(entry => entry.args?.[0] === 'pane' && entry.args?.[1] === 'close')).toBe(false);

    // A worker's pane opens from the Workers page, read-only even for the operator.
    await operator.getByRole('row', { name: /work-claude/ }).getByRole('button', { name: 'Watch', exact: true }).click();
    await expect(rows(operator)).toContainText('screen of w1:worker', settled);
    await expect(operator.locator('.terminal-session')).toHaveCount(0);
    await expect(operator.getByRole('status')).not.toContainText('unknown');
    await expect(operator.getByRole('status')).toContainText('read-only', settled);
    expect((await calls()).some(entry => entry.args?.slice(0, 4).join(' ') === 'terminal session observe w1:worker')).toBe(true);
    await operator.getByRole('button', { name: 'Close', exact: true }).click();
    await expect.poll(async () => (await calls()).some(entry => entry.pane === 'w1:worker' && entry.detached), settled).toBe(true);
    await operator.close();
  } finally {
    const ended = once(child, 'exit'); child.send('stop'); await ended;
    await database.close(); await rm(site, { recursive: true, force: true });
  }
});
