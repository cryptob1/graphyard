import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { priorityServer } from '../tests/helpers/priority-server';
import { Engine } from '../src/engine';
import type { Work } from '../src/model';

// GY-3510: an item whose workers died at startup three claims in a row reads, on its page, as one
// plain line naming the last exit reason, with one who-acts-next line, at 1280 and at 390 wide.
const exit = 'claude exited with code 1: Invalid API key';

test('e2e:expiry-loop-stop — three startup deaths read as one plain line with one next action, no sideways scroll at 1280 and 390', async ({ page }) => {
  test.setTimeout(180_000);
  const f = await priorityServer();
  const settled = { timeout: 15_000 };
  try {
    const operator = f.engine.principals.find(p => p.id === 'operator')!, worker = f.engine.principals.find(p => p.id === 'worker')!;
    // Leases this engine grants lapse at once, as a worker that dies at startup leaves them.
    const expiring = new Engine(f.store, 0, 'owner/project'); expiring.principals = f.engine.principals; expiring.gitRunner = null;
    let item = await f.engine.execute(operator, 'create', null, { type: 'chore', title: 'Startup deaths stop', why: 'Owners see why workers never start.', simplest: 'Stop after three and say why.',
      criteria: [{ id: 'AC-1', text: 'Works', proofs: ['e2e:expiry-loop-stop'] }] }, randomUUID());
    item = await f.engine.execute(operator, 'ready', item.id, {}, randomUUID());
    for (let n = 0; n < 3; n++) {
      const claimed = await expiring.execute(worker, 'claim', item.id, {}, randomUUID());
      const document = (await f.store.list()).find(w => w.id === item.id)! as Work;
      const at = new Date().toISOString();
      document.sessions = [...document.sessions ?? [], { id: `worker:${claimed.epoch}`, kind: 'implementation', principal: 'worker', epoch: claimed.epoch, runtime: 'claude', host: 'h', workspace: null, tab: null, pane: null, agentName: null, role: 'implementation', head: null,
        attach: null, transcript: null, subject: item.key, startedAt: at, updatedAt: at, endedAt: at, state: 'finished', outcome: exit }];
      await f.store.pool.query('UPDATE work_items SET document=$2::jsonb WHERE id=$1', [document.id, JSON.stringify(document)]);
      await f.engine.reconcile();
    }

    await page.route('**/api/**', async route => {
      const { pathname, search } = new URL(route.request().url());
      const response = await route.fetch({ url: f.url + pathname + search }).catch(() => null);
      await (response ? route.fulfill({ response }) : route.abort()).catch(() => {});
    });
    const { code } = await f.ok('sign-in-links', {});
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/#sign-in=' + code);
    await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible(settled);
    await page.locator(`[data-row="${item.key}"]`).click();

    const where = page.locator('article.item-page section[aria-label="Where it is now"]');
    await expect(where.locator('.status-sentence')).toHaveText(`Workers keep failing to start: ${exit}`, settled);
    await expect(where.locator('.next-line')).toHaveCount(1);
    // No ids or agent text in the main view: no item key, worker id or epoch in the plain line's panel.
    await expect(where).not.toContainText(item.key);
    await expect(where).not.toContainText(/worker:\d|epoch/);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(where.locator('.status-sentence')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `no sideways scroll at ${width}`).toBe(true);
    }
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await f.close();
  }
});
