import { test, expect } from '@playwright/test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { withDatabase } from '../tests/helpers/postgres';
import { temporaryDirectory } from '../tests/helpers/temp-dirs';
import { serveXterm } from './xterm';

const settled = { timeout: 15_000 };

// GY-3345: the receiving install's Master page shows a thread with another install's Master: the
// sender install's name, its message and this Master's reply, in order, at 1280 px and 390 px with
// no horizontal page scroll. The real control plane serves the built dashboard.
test('e2e:cross-install-master-messaging — the receiving install\'s Master page shows the thread with the sender\'s name, the message and the reply in order at 1280 px and 390 px', async ({ browser }) => {
  test.setTimeout(120_000);
  const site = await temporaryDirectory('cross-install-messages');
  await symlink(resolve('.graphyard/browser-dist'), join(site, 'dist'));
  const database = await withDatabase('cross_install_messages'); await database.init();
  const child = fork(resolve('tests/helpers/terminal-server.ts'), [(database.pool.options as { connectionString: string }).connectionString, site], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env, PATH: join(site, 'empty'), HOME: site },
  });
  const [{ url }] = await once(child, 'message') as [{ url: string }];
  const post = async (bearer: string, path: string, body: unknown) => {
    const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json() as Promise<any>;
  };
  try {
    // install-a's Master writes, under the thread it opened; this Master answers it (what master send --reply records here).
    const message = 'Your trial image lacks Go 1.23; GY-12 on install-a fails on it. Can you add it to the image?';
    const reply = 'Added Go 1.23 to the trial image in GY-40; retry GY-12 once it is served.';
    const sent = await post('test-install-a', 'master/messages', { text: message, thread: 'thread-from-install-a' });
    await post('test-coordinator', `master/messages/${sent.id}/reply`, { text: reply });
    for (const width of [1280, 390] as const) {
      const { code } = await post('test-human-operator', 'sign-in-links', {});
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
      await serveXterm(context);
      const page = await context.newPage();
      await page.goto(`${url}/#sign-in=${code}&master`);
      const thread = page.getByRole('article', { name: 'Thread with install-a' });
      await expect(thread).toBeVisible(settled);
      await expect(thread.getByRole('heading')).toHaveText('With install-a');
      const entries = thread.getByRole('listitem');
      await expect(entries).toHaveCount(2);
      await expect(entries.nth(0)).toContainText('install-a'); await expect(entries.nth(0)).toContainText(message);
      await expect(entries.nth(1)).toContainText('Master'); await expect(entries.nth(1)).toContainText(reply);
      expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth), `no horizontal page scroll at ${width} px`).toBe(true);
      await context.close();
    }
  } finally {
    const ended = once(child, 'exit'); child.send('stop'); await ended; await database.close();
  }
});
