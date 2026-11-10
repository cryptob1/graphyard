import { test, expect } from '@playwright/test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { signInDatabase } from '../tests/helpers/sign-in-database';

test('e2e:master-page-terminal-refused — when the terminal cannot start, the Master page says "refused:" with the cause, not "Detached"', async ({ browser }) => {
  const site = await mkdtemp(join(tmpdir(), 'graphyard-refused-terminal-'));
  await symlink(resolve('.graphyard/browser-dist'), join(site, 'dist'));
  const database = await signInDatabase();
  // No herdr on the server's PATH or in its home, and no host supervisor connected.
  const child = fork(resolve('tests/helpers/terminal-server.ts'), [database.url, site], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, PATH: join(site, 'empty'), HOME: site, GRAPHYARD_HERDR_CONFIG_HOME: '', GRAPHYARD_HERDR_SESSION: '' } });
  const [{ url }] = await once(child, 'message') as [{ url: string }];
  try {
    const { code } = await (await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } })).json() as { code: string };
    const page = await browser.newPage();
    await page.goto(`${url}/#sign-in=${code}&master`);
    await expect(page.getByRole('status')).toContainText('refused: herdr is not installed', { timeout: 15_000 });
    await expect(page.getByRole('status')).not.toContainText('Detached');
  } finally {
    const ended = once(child, 'exit'); child.send('stop'); await ended;
    await database.close(); await rm(site, { recursive: true, force: true });
  }
});
