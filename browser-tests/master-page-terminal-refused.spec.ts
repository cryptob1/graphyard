import { test, expect } from '@playwright/test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { rm, symlink } from 'node:fs/promises';
import { temporaryDirectory } from '../tests/helpers/temp-dirs';
import { join, resolve } from 'node:path';
import { signInDatabase } from '../tests/helpers/sign-in-database';

test('e2e:master-page-terminal-refused — when the terminal cannot start, the Master page says "refused:" with the cause, not "Detached"', async ({ browser }) => {
  const site = await temporaryDirectory('refused-terminal');
  await symlink(resolve('.graphyard/browser-dist'), join(site, 'dist'));
  const database = await signInDatabase();
  // No herdr on the server's PATH or in its home, and no host supervisor connected.
  const child = fork(resolve('tests/helpers/terminal-server.ts'), [database.url, site], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, PATH: join(site, 'empty'), HOME: site, GRAPHYARD_HERDR_CONFIG_HOME: '', GRAPHYARD_HERDR_SESSION: '' } });
  const [{ url }] = await once(child, 'message') as [{ url: string }];
  try {
    const { code } = await (await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } })).json() as { code: string };
    const page = await browser.newPage();
    let connections = 0;
    page.on('websocket', () => connections++);
    await page.goto(`${url}/#sign-in=${code}&master`);
    await expect(page.getByRole('status')).toContainText('refused: herdr is not installed', { timeout: 15_000 });
    await expect(page.getByRole('status')).not.toContainText('Detached');
    // Longer than the maximum reconnect delay: a refusal must remain stable.
    await page.waitForTimeout(2500);
    expect(connections).toBe(1);
    await expect(page.getByRole('status')).toContainText('refused: herdr is not installed');

    // An expired token is refused before upgrade; browsers conceal its HTTP status.
    await page.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, String(url).includes('/api/terminal?') ? ['graphyard', 'expired-token'] : protocols);
        }
      };
    });
    await page.goto(`${url}/#master`);
    await page.reload();
    await expect(page.getByRole('status')).toContainText('Not available: sign in, and check the session still has a pane.');
    const afterRefusal = connections;
    await page.waitForTimeout(2500);
    expect(connections).toBe(afterRefusal);
    await expect(page.locator('.live-terminal')).toHaveAttribute('data-terminal', 'refused');
  } finally {
    const ended = once(child, 'exit'); child.send('stop'); await ended;
    await database.close(); await rm(site, { recursive: true, force: true });
  }
});
