import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withDatabase } from '../tests/helpers/postgres';
import { Engine } from '../src/engine';
import { server } from '../src/server';
import { bootstrapGate, gateRecordPath } from '../src/batch-gate';
import { environmentStatePath } from '../src/app-environments';
import { temporaryDirectory } from '../tests/helpers/temp-dirs';

// e2e:app-test-environments — GY-3296: the existing Tests view shows a short Where tests run block
// on the real control plane: one line per environment (local first, then each declared one) with
// where the app under test runs, when it is used and its last run with its timing; the lifecycle,
// limit, instances in use and a recoverable fault folded behind details. No Settings entry is added.

const commit = '3296aaaabbbbccccddddeeeeffff000011112222';

test('e2e:app-test-environments — the Tests view\'s Where tests run block shows local and named environments at desktop and phone widths', async ({ page, context, baseURL }) => {
  // One stack for both widths (GY-3293: embedded Postgres setup alone takes ~40 s on a loaded trial
  // host that runs the whole browser suite beside it; two parallel stacks outran 90 s there).
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const store = await withDatabase('app_test_environments');
  await store.init();
  const engine = new Engine(store, 120, 'fixture/shop');
  engine.gitRunner = null;
  const http = server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token: 'test-human-operator' }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  await context.route('**/*', async route => {
    const { pathname, search } = new URL(route.request().url());
    await route.fetch(pathname.startsWith('/api/') ? { url: url + pathname + search } : {}).then(response => route.fulfill({ response }), () => route.abort('connectionrefused')).catch(() => {});
  });
  // The checkout the control plane serves: a declared environment, the loop's environment state and its batch gate record.
  const checkout = await temporaryDirectory('app-test-environments-ui');
  mkdirSync(join(checkout, '.graphyard'), { recursive: true });
  writeFileSync(join(checkout, 'graphyard.json'), JSON.stringify({ e2e: { environments: { staging: { up: 'sh env/up.sh', down: 'sh env/down.sh', list: 'sh env/list.sh', maxConcurrent: 2 } } } }));
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  writeFileSync(environmentStatePath(checkout), JSON.stringify({
    instances: [{ environment: 'staging', runId: 'gy-stranded', instance: 'inst-stranded', commit, url: 'https://staging.example.test', loop: 'old', at }],
    runs: { staging: { commit, runId: 'gy-run-1', url: 'https://staging.example.test', at, ms: 42_000, outcome: 'fault', detail: 'teardown failed: exited 1: provider unavailable' } },
  }));
  const gate = { ...bootstrapGate('fixture/shop', commit), lastOutcome: { tip: commit, outcome: 'verified' as const, reason: null, finishedAt: at } };
  writeFileSync(gateRecordPath(checkout), JSON.stringify(gate));
  const previous = process.env.GRAPHYARD_REPOSITORY_ROOT;
  process.env.GRAPHYARD_REPOSITORY_ROOT = checkout;
  try {
    const { code } = await (await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } })).json() as { code: string };
    await page.goto(`${baseURL}/#sign-in=${code}`);
    await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
    const primary = page.getByRole('navigation', { name: 'Primary' });
    await primary.getByRole('button', { name: 'Tests', exact: true }).click();

    const block = page.getByRole('region', { name: 'Where tests run' });
    await expect(block).toBeVisible({ timeout: 15_000 });
    await expect(block).toContainText('Where the app under test runs. The test runner itself always runs on this host.');
    const local = block.locator('[data-environment="local"]'), staging = block.locator('[data-environment="staging"]');
    await expect(local).toContainText('On this host, inside the trial');
    await expect(local).toContainText('Every merge trial and batch gate');
    await expect(local).toContainText('last run passed 5 min ago');
    await expect(staging).toContainText('Wherever its up command provisions it');
    await expect(staging).toContainText('Once per batch gate on main');
    await expect(staging).toContainText('environment fault, retried 5 min ago in 42 s');

    // The lifecycle, limit and the recoverable fault are folded until opened.
    const detail = block.locator('[data-environment-detail="staging"]');
    await expect(detail).toBeHidden();
    await block.getByText('Lifecycle, waits and cleanup').click();
    await expect(detail).toContainText('at most 2 at once, 1 in use');
    await expect(detail).toContainText('up sh env/up.sh · down sh env/down.sh · list sh env/list.sh');
    await expect(detail).toContainText('teardown failed: exited 1: provider unavailable');
    await expect(block).toContainText('it never fails or reverts a change');

    // It fits the width and adds no Settings page.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await primary.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Pages in this section' }).getByRole('button')).toHaveText(['Agents', 'Setup']);

    // The same block answers at phone width: every row still readable, nothing overflows, the
    // navigation folds behind the menu, and it still adds no Settings page.
    await page.setViewportSize({ width: 390, height: 844 });
    const menu = page.getByRole('button', { name: 'Menu' });
    if (await menu.getAttribute('aria-expanded') !== 'true') await menu.click();
    await primary.getByRole('button', { name: 'Tests', exact: true }).click();
    await expect(block).toBeVisible({ timeout: 15_000 });
    await expect(local).toContainText('Every merge trial and batch gate');
    await expect(staging).toContainText('environment fault, retried 5 min ago in 42 s');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (await menu.getAttribute('aria-expanded') !== 'true') await menu.click();
    await primary.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Pages in this section' }).getByRole('button')).toHaveText(['Agents', 'Setup']);
  } finally {
    if (previous === undefined) delete process.env.GRAPHYARD_REPOSITORY_ROOT; else process.env.GRAPHYARD_REPOSITORY_ROOT = previous;
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
    await store.close();
  }
});
