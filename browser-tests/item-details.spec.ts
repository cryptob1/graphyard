import { test, expect, type Page } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';

// GY-2011: an item page opens on its plain summary and folds description and criteria under Details.

const now = '2026-01-01T00:00:00Z';
const work = [
  { dependencies: [], scenarioRequirements: [], id: 'w-api', key: 'GY-10', title: 'Signup API', summary: 'The signup API answers.', description: 'Full API detail.', type: 'feature', priority: 1, stage: 'ready', stageEnteredAt: now, ready: true, policy: { review: true, checks: ['test'] }, policyRevision: 1, revision: 1, violations: [], workspaces: [], criteria: [{ id: 'AC-1', text: 'API works', proofs: ['unit:api'] }], evidence: [], gates: [] },
];

async function fixture(page: Page) {
  await page.route('**/api/**', async route => {
    if (route.request().headers().authorization !== 'Bearer browser-fixture') return route.fulfill({ status: 401, json: { error: 'Rejected' } });
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/status')) return route.fulfill({ json: { actor: { id: 'fixture', role: 'admin', sessionKind: 'human' }, github: true, reviewProviders: ['github'], repository: 'fixture/repository', jobs: [] } });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work, now } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus(work as any, Date.parse(now), null) });
    if (path.includes('/events')) return route.fulfill({ json: [] });
    return route.fulfill({ json: path.endsWith('/work') ? work : [] });
  });
}

test('integration:item-details — an item page opens on its plain summary and folds Details', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await fixture(page);
  await page.goto('/');
  await page.getByLabel('Access token').fill('browser-fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', exact: true })).toBeVisible();

  await page.getByRole('button', { name: /Signup API.*GY-10/ }).click();
  const item = page.locator('article.item-page');
  await expect(item.locator('h1[data-plain-summary="true"]')).toHaveText('The signup API answers.');
  const details = item.locator('.item-details-fold');
  await expect(details).toBeVisible();
  await expect(details).not.toHaveAttribute('open', '');
  await expect(details.locator('.item-description')).toBeHidden();
  await details.locator(':scope > summary').click();
  await expect(details).toHaveAttribute('open', '');
  await expect(details.locator('.item-description')).toHaveText('Full API detail.');
  await expect(details.getByRole('region', { name: 'Requirements' })).toContainText('API works');
});
