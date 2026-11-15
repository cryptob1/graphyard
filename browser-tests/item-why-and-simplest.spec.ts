import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { priorityServer } from '../tests/helpers/priority-server';
import type { Work } from '../src/model';

const why = 'Owners see at a glance how an item helps users.';
const simplest = 'Two sentences on create, shown where items already show.';

test('e2e:item-why-and-simplest — the create box files both sentences, the item page and Work list lead with them, requirements revise them, an older item opens without them', async ({ page }) => {
  test.setTimeout(180_000);
  const f = await priorityServer();
  const settled = { timeout: 15_000 };
  try {
    // An item from before the change carries neither sentence (the engine stores what its create carried).
    const older = await f.engine.execute(f.engine.principals.find(p => p.id === 'operator')!, 'create', null,
      { type: 'chore', title: 'Older item', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['e2e:item-why-and-simplest'] }] }, randomUUID());
    await page.route('**/api/**', async route => {
      const { pathname, search } = new URL(route.request().url());
      const response = await route.fetch({ url: f.url + pathname + search }).catch(() => null);
      await (response ? route.fulfill({ response }) : route.abort()).catch(() => {});
    });
    const { code } = await f.ok('sign-in-links', {});
    await page.goto('/#sign-in=' + code);
    await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible(settled);

    await page.getByRole('button', { name: '＋ New work item' }).click();
    const form = page.getByRole('dialog', { name: 'New work item' });
    await form.getByLabel('Title', { exact: true }).fill('Lead with why');
    // The browser refuses the box without the two sentences; the route refuses the API call by name.
    await form.getByRole('button', { name: 'Create work item', exact: true }).click();
    expect(await form.getByLabel('Why it helps users').evaluate(el => (el as HTMLInputElement).validity.valueMissing)).toBe(true);
    expect((await f.call('work', { title: 'API without', type: 'chore' })).body.error).toMatch(/needs why \(.*\) and simplest \(/);
    await form.getByLabel('Why it helps users').fill(why);
    await form.getByLabel('Why it is the simplest thing that works').fill(simplest);
    await form.getByText('Advanced', { exact: true }).click();
    await form.getByLabel('Acceptance criterion').fill('The item leads with its sentences');
    await form.getByLabel('Required proof').fill('e2e:item-why-and-simplest');
    const posted = page.waitForResponse(response => response.url().endsWith('/api/work') && response.request().method() === 'POST');
    await form.getByRole('button', { name: 'Create work item', exact: true }).click();
    const created = await (await posted).json() as Work;
    expect([created.why, created.simplest]).toEqual([why, simplest]);

    const itemPage = page.locator('article.item-page');
    const heading = itemPage.locator('.page-heading');
    await expect(heading.locator('[data-why]')).toHaveText(`Why: ${why}`, settled);
    await expect(heading.locator('[data-simplest]')).toHaveText(`Simplest: ${simplest}`);
    // Above the description and criteria, which fold under Details further down.
    const leadTop = (await heading.locator('[data-lead]').boundingBox())!.y, detailsTop = (await itemPage.locator('.item-details-fold').boundingBox())!.y;
    expect(leadTop).toBeLessThan(detailsTop);

    await page.getByRole('button', { name: '← Back' }).click();
    // Both items are unreleased: open the Backlog group, where the owner looks for them.
    await page.getByRole('button', { name: /^Backlog/ }).click();
    await expect(page.locator(`[data-row="${created.key}"] [data-lead]`)).toBeVisible(settled);
    await expect(page.locator(`[data-row="${created.key}"] [data-lead]`)).toHaveText(`${why} ${simplest}`);
    await expect(page.locator(`[data-row="${older.key}"]`)).toBeVisible();
    await expect(page.locator(`[data-row="${older.key}"] [data-lead]`)).toHaveCount(0);

    await page.locator(`[data-row="${created.key}"]`).getByRole('button', { name: /open/ }).click();
    await itemPage.locator('details.edit-menu > summary').click();
    await page.getByRole('button', { name: 'Revise requirements', exact: true }).click();
    const revise = page.getByRole('form', { name: 'Revise requirements' });
    await expect(revise.getByLabel('Why it helps users')).toHaveValue(why);
    await revise.getByLabel('Why it helps users').fill('Agents build what users need.');
    await revise.getByLabel('Reason for revision').fill('Sharper why');
    await revise.getByRole('button', { name: 'Save requirement revision' }).click();
    await expect(heading.locator('[data-why]')).toHaveText('Why: Agents build what users need.', settled);
    await expect(heading.locator('[data-simplest]')).toHaveText(`Simplest: ${simplest}`);
    await page.getByRole('button', { name: '← Back' }).click();
    await expect(page.locator(`[data-row="${created.key}"] [data-lead]`)).toBeVisible(settled);
    await expect(page.locator(`[data-row="${created.key}"] [data-lead]`)).toHaveText(`Agents build what users need. ${simplest}`, settled);

    await page.locator(`[data-row="${older.key}"]`).getByRole('button', { name: /open/ }).click();
    await expect(itemPage.locator('h1')).toHaveText('Older item', settled);
    await expect(itemPage.locator('[data-lead]')).toHaveCount(0);
  } finally {
    // GY-3362: 'wait' hung to the test timeout when a dashboard poll was in flight at teardown; the handler
    // already tolerates a closed server.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await f.close();
  }
});
