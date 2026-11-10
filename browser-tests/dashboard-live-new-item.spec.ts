import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { signInDatabase } from '../tests/helpers/sign-in-database';
import { signInProcess } from '../tests/helpers/sign-in-process';

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** The remote browser's link once the dashboard is open: 2 Mbit/s, as over a tailnet from a phone or a busy Wi-Fi. */
const bytesPerMs = 250;

test('e2e:dashboard-live-new-item — an item filed through the CLI, and its stage change, show on the open dashboard without a reload', async ({ page }) => {
  test.setTimeout(120_000);
  const database = await signInDatabase();
  const http = await signInProcess(database.url);
  const live = { timeout: 10_000 };
  const operator = { Authorization: 'Bearer test-human-operator', 'Content-Type': 'application/json' };
  try {
    // A ledger of settled deliveries, as every real install has: each poll used to carry all of them again.
    const ids: string[] = [];
    for (let batch = 0; batch < 10; batch++) ids.push(...await Promise.all(Array.from({ length: 20 }, async (_, n) => {
      const response = await fetch(http.url + '/api/work', { method: 'POST', headers: { ...operator, 'Idempotency-Key': `ledger-${batch}-${n}` },
        body: JSON.stringify({ title: `Delivered ${batch * 20 + n}`, type: 'chore', criteria: [{ id: 'AC-1', text: 'Delivered', proofs: ['e2e:fixture'] }] }) });
      return (await response.json() as { id: string }).id;
    })));
    await database.store.pool.query(`UPDATE work_items SET document = (jsonb_set(document, '{criteria,0,text}', to_jsonb(repeat('delivered ', 2000))) || jsonb_build_object('stage', 'done', 'actionQueue', jsonb_build_object('actions', '[]'::jsonb, 'history', '[]'::jsonb))) - 'lease' - 'nextAction' - 'queue' WHERE id = ANY($1::uuid[])`, [ids]);
    // API requests reach the real control plane through the test, as in signin-session-survives-restart;
    // once the dashboard is open, each answer arrives at the remote link's pace.
    let remote = false;
    await page.route('**/*', async route => {
      const { pathname, search } = new URL(route.request().url());
      const response = await route.fetch(pathname.startsWith('/api/') ? { url: http.url + pathname + search } : {}).catch(() => null);
      if (!response) return route.abort('connectionrefused').catch(() => {});
      if (remote && pathname.startsWith('/api/')) await sleep((await response.body()).length / bytesPerMs);
      await route.fulfill({ response }).catch(() => {});
    });
    const { code } = await (await fetch(http.url + '/api/sign-in-links', { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } })).json() as { code: string };
    await page.goto('/#sign-in=' + code);
    await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[aria-label="Shipped this week"]')).toBeVisible();
    remote = true;
    await sleep(6_000);

    const cwd = await mkdtemp(join(tmpdir(), 'dashboard-live-'));
    const env: NodeJS.ProcessEnv = { ...process.env, GRAPHYARD_URL: http.url, GRAPHYARD_TOKEN: 'test-human-operator' };
    delete env.GRAPHYARD_TOKEN_FILE;
    const cli = async (...args: string[]) => JSON.parse((await exec(process.execPath, [launcher, ...args], { cwd, env })).stdout);
    await writeFile(join(cwd, 'work.json'), JSON.stringify({ title: 'Filed while the dashboard is open', type: 'chore', owner: 'operator',
      criteria: [{ id: 'AC-1', text: 'Shows without a reload', proofs: ['e2e:dashboard-live-new-item'] }] }));
    const filed = await cli('create', join(cwd, 'work.json'));
    const filedAt = Date.now();

    // Work (the overview): the new row is on the board, in Backlog.
    await expect(page.locator(`[data-row="${filed.key}"]`)).toHaveAttribute('data-group', 'backlog', live);
    // Now: the operator's own items list it.
    await page.getByRole('navigation', { name: 'Pages in this section' }).getByRole('button', { name: 'Now', exact: true }).click();
    await expect(page.getByRole('table', { name: 'Your items' }).locator('tbody tr').filter({ hasText: filed.title })).toContainText('Backlog', { timeout: Math.max(1, 10_000 - (Date.now() - filedAt)) });

    // A stage change of an existing item shows too: released for work, it leaves Backlog for Up next.
    await cli('ready', filed.key, 'Released by the dashboard-live-new-item case');
    await expect(page.getByRole('table', { name: 'Your items' }).locator('tbody tr').filter({ hasText: filed.title }).locator('td').nth(1)).not.toHaveText('Backlog', live);
    await page.getByRole('navigation', { name: 'Pages in this section' }).getByRole('button', { name: 'Work', exact: true }).click();
    await expect(page.locator(`[data-row="${filed.key}"]`)).not.toHaveAttribute('data-group', 'backlog', live);
    expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(1);
  } finally { await http.close(); await database.close(); }
});
