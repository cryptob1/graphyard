import { test, expect } from '@playwright/test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { signInDatabase } from '../tests/helpers/sign-in-database';

const settled = { timeout: 15_000 };

test('e2e:headless-workers — the item page lists worker runs by attempt and shows each run log, an earlier account\'s included', async ({ page }) => {
  const database = await signInDatabase();
  const site = await mkdtemp(join(tmpdir(), 'graphyard-worker-runs-'));
  await symlink(resolve('.graphyard/browser-dist'), join(site, 'dist'));
  const child = fork(resolve('tests/helpers/worker-runs-server.ts'), [database.url, site], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const [{ url, key }] = await once(child, 'message') as [{ url: string; key: string }];
  try {
    const { code } = await (await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } })).json() as { code: string };
    await page.goto(`${url}/#sign-in=${code}`);
    await page.getByRole('button', { name: new RegExp(key) }).first().click();
    const runs = page.getByRole('region', { name: 'Worker runs' });
    await expect(runs).toBeVisible(settled);
    const attempts = runs.locator('details.worker-run > summary');
    await expect(attempts).toHaveCount(2);
    await expect(attempts.nth(0)).toContainText('Attempt 1');
    await expect(attempts.nth(0)).toContainText('ended');
    await expect(attempts.nth(1)).toContainText('Attempt 2');
    await expect(attempts.nth(1)).toContainText('running');
    // The earlier account's ended run: stdout and stderr, each labelled, read through the host bridge.
    await attempts.nth(0).click();
    const first = runs.getByLabel('Log of attempt 1');
    await expect(first).toContainText('stdout working on the change', settled);
    await expect(first).toContainText("stderr You've hit your session limit");
    await expect(attempts.nth(0)).toContainText('on spent');
    await attempts.nth(1).click();
    await expect(runs.getByLabel('Log of attempt 2')).toContainText('stderr warning: token=[redacted]', settled);
    await expect(attempts.nth(1)).toContainText('on successor');
    // No terminal is offered for a worker anywhere on the item page.
    await expect(page.getByRole('button', { name: 'Watch', exact: true })).toHaveCount(0);
  } finally {
    const ended = once(child, 'exit'); child.send('stop'); await ended;
    await database.close(); await rm(site, { recursive: true, force: true });
  }
});
