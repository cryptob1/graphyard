import { test, expect, type Page } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';

// Stored legacy reports have no dashboard panel after retirement.

const now = '2026-01-01T00:00:00Z';
const work = [
  {
    dependencies: [], scenarioRequirements: [], id: 'w-spec', key: 'GY-20', title: 'Export flow', summary: 'The export flow moves behind the settings screen.', description: 'The export flow moves.', type: 'feature', priority: 1, stage: 'ready', stageEnteredAt: now, ready: true, policy: { review: true, checks: ['test'] }, policyRevision: 2, revision: 3, violations: [], workspaces: [],
    criteria: [{ id: 'AC-1', text: 'A signed-up user can export their data', proofs: ['e2e:export-flow'] }], evidence: [], gates: [],
    specCheck: { policyRevision: 2, verdict: 'gaps', paraphrase: 'The change moves the export flow behind the settings screen; AC-1 is proven by the e2e case that signs up and exports.', gaps: ['AC-1 does not say which of the two export buttons the flow starts from'], reviewer: 'spec-checker', at: now, recheck: true },
  },
  {
    dependencies: [], scenarioRequirements: [], id: 'w-spec-bug', key: 'GY-21', title: 'Export 500s', summary: 'The export button 500s.', description: 'The export button 500s on an empty dataset.', type: 'bug', priority: 1, stage: 'ready', stageEnteredAt: now, ready: true, policy: { review: true, checks: ['test'] }, policyRevision: 1, revision: 1, violations: [], workspaces: [],
    criteria: [{ id: 'AC-1', text: 'Export answers on an empty dataset', proofs: ['unit:export'] }], evidence: [], gates: [],
  },
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

test('integration:feature-skips-spec-check — legacy feature reports have no dashboard panel', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await fixture(page);
  await page.goto('/?sign-in');
  await page.getByLabel('Access token').fill('browser-fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', exact: true })).toBeVisible();

  await page.getByRole('button', { name: /Export flow.*GY-20/ }).click();
  const panel = page.locator('section[aria-label="Spec check"]');
  await expect(panel).toHaveCount(0);
});

test('integration:feature-skips-spec-check — bugs show no obsolete panel', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await fixture(page);
  await page.goto('/?sign-in');
  await page.getByLabel('Access token').fill('browser-fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', exact: true })).toBeVisible();

  await page.getByRole('button', { name: /Export 500s.*GY-21/ }).click();
  await expect(page.locator('article.item-page h1')).toHaveText('The export button 500s.');
  await expect(page.locator('section[aria-label="Spec check"]')).toHaveCount(0);
});
