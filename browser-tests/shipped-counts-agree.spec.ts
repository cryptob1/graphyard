import { test, expect, type Page } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';

// GY-3452: shipped means live. The top bar and the Work page's card read one count — the week's
// merges the live commit contains — and the same waiting-to-go-live count for those it does not.
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const merged = (key: string, minutesAgo: number) => ({ dependencies: [], scenarioRequirements: [], id: `fixture-${key}`, key, title: `Change ${key}`, description: key, type: 'feature', priority: 2,
  stage: 'done', stageEnteredAt: at(minutesAgo), ready: true, policy: { review: true, checks: ['test'] }, policyRevision: 1, revision: 1, violations: [], workspaces: [], criteria: [], evidence: [], gates: [], sessions: [],
  delivery: { mergedAt: at(minutesAgo), mergeSha: key.replace(/\D/g, '').padStart(40, 'a'), authorizationRevision: 1 } });

async function serve(page: Page, work: any[], live: { commit: string; waiting: string[] }) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const now = new Date().toISOString();
    if (path.endsWith('/status')) return route.fulfill({ json: { actor: { id: 'operator', role: 'admin', sessionKind: 'human' }, repository: 'fixture/repository', jobs: [], live } });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work, now } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus(work, Date.parse(now), null) });
    return route.fulfill({ json: [] });
  });
  await page.goto('/?sign-in');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible();
}

test('e2e:shipped-counts-agree — the top bar and the Work page card show the same shipped and waiting-to-go-live counts', async ({ page }) => {
  // Four merges this week; the live commit contains two of them, so two wait to go live.
  await serve(page, [merged('GY-1', 300), merged('GY-2', 200), merged('GY-3', 100), merged('GY-4', 50)], { commit: 'c'.repeat(40), waiting: ['GY-3', 'GY-4'] });
  const strip = page.locator('.city-strip'), card = page.getByLabel('Shipped this week');
  await expect(strip).toHaveAttribute('data-shipped', '2');
  await expect(strip).toHaveAttribute('data-waiting', '2');
  await expect(strip).toContainText('2 shipped this week');
  await expect(strip).toContainText('2 waiting to go live');
  await expect(card.locator('[data-shipped]')).toHaveAttribute('data-shipped', '2');
  await expect(card.locator('[data-waiting]')).toHaveAttribute('data-waiting', '2');
  await expect(card).toContainText('2 shipped this week.');
  await expect(card).toContainText('2 waiting to go live.');
});
