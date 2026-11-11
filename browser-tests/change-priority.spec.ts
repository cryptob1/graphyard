import { test, expect } from '@playwright/test';
import { priorityServer, nextPriorityDispatch } from '../tests/helpers/priority-server';

test('e2e:change-priority — row and item controls persist and show attributed audit history', async ({ page }) => {
  test.setTimeout(120_000);
  const f = await priorityServer();
  try {
    const fields = { type: 'chore', criteria: [{ id: 'AC-1', text: 'Priority works', proofs: ['e2e:change-priority'] }] };
    const earlier = await f.ok('work', { ...fields, title: 'Earlier item', priority: 3 });
    const item = await f.ok('work', { ...fields, title: 'Change my priority', priority: 3 });
    const legacy = await f.ok('work', { ...fields, title: 'Keep existing P4', priority: 4 });
    for (const ready of [earlier, item]) await f.ok(`work/${ready.id}/ready`, { reason: 'Ready' });
    await page.route('**/api/**', async route => {
      const { pathname, search } = new URL(route.request().url());
      await route.fulfill({ response: await route.fetch({ url: f.url + pathname + search }) });
    });
    const { code } = await f.ok('sign-in-links', {});
    await page.goto('/#sign-in=' + code);
    await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible();
    const row = page.locator(`[data-row="${item.key}"]`);
    const selector = row.getByRole('combobox', { name: `Priority for ${item.key}` });
    await expect(selector).toHaveValue('3');
    await selector.selectOption('0');
    await expect(selector).toHaveValue('0');
    await expect(page.locator('article.item-page')).toHaveCount(0);
    expect(await nextPriorityDispatch(f)).toEqual([item.key]);
    await row.getByRole('button', { name: /open/ }).click();
    const details = page.locator('article.item-page');
    const detailSelector = details.getByRole('combobox', { name: `Priority for ${item.key}` });
    await expect(detailSelector).toHaveValue('0');
    await details.locator('.full-history > summary').click();
    const history = details.getByRole('region', { name: 'History entries' });
    await expect(history).toContainText('Priority changed from P3 to P0 from the dashboard');
    await expect(history).toContainText('P3 → P0');
    await expect(history).toContainText('operator');
    await detailSelector.selectOption('2');
    await expect(detailSelector).toHaveValue('2');
    await expect(history).toContainText('Priority changed from P0 to P2 from the dashboard');
    await details.getByRole('button', { name: '← Back', exact: true }).click();
    await page.locator('[data-group-section="backlog"] > summary').click();
    await expect(selector).toHaveValue('2');
    const legacyRow = page.locator(`[data-row="${legacy.key}"]`);
    await expect(legacyRow.getByRole('combobox')).toHaveValue('4');
    await expect(legacyRow.locator('option:checked')).toHaveText('P4 (existing)');
    await legacyRow.getByRole('button', { name: /open/ }).click();
    await expect(page.getByRole('combobox', { name: `Priority for ${legacy.key}` })).toHaveValue('4');
    expect((await f.store.workDocument(legacy.id))!.priority).toBe(4);
    expect((await f.ok(`events?work=${legacy.id}`)).filter((event: any) => event.kind === 'priority')).toHaveLength(0);
    expect((await f.call(`work/${item.id}/priority`, { priority: 0, source: 'dashboard' }, f.tokens.worker)).status).toBe(403);
  } finally { await f.close(); }
});
