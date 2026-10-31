import { test, expect } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';

const now = '2026-10-30T12:00:00Z';
const base = { description: '', type: 'chore', priority: 2, stageEnteredAt: now, dependencies: [], criteria: [], policy: { checks: ['test'], review: true }, ready: false, epoch: 0, lease: null, gates: [], violations: [], workspaces: [], evidence: [], scenarioRequirements: [] };
const work = [
  { ...base, id: 'alice-one', key: 'GY-1', title: 'Alice priority', owner: 'alice', stage: 'backlog' },
  { ...base, id: 'bob-one', key: 'GY-2', title: 'Bob priority', owner: 'bob', stage: 'backlog' },
  { ...base, id: 'alice-two', key: 'GY-3', title: 'Alice delivery', owner: 'alice', stage: 'done', closure: { reason: 'Finished', at: now, by: 'alice' } },
  { ...base, id: 'alice-three', key: 'GY-5', title: 'Alice shipped', owner: 'alice', stage: 'done' },
  { ...base, id: 'unowned', key: 'GY-4', title: 'Install priority', stage: 'backlog' },
];

for (const person of ['alice', 'bob', 'charlie']) {
  test(`e2e:per-owner-now-page signed-in ${person} sees exactly their items, stage and next step`, async ({ page }) => {
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const actor = { id: person, role: 'admin', sessionKind: 'human' };
      if (path === '/api/sign-in') return route.fulfill({ json: { token: `${person}-session`, actor, expiresAt: '2030-01-01T00:00:00Z' } });
      if (route.request().headers().authorization !== `Bearer ${person}-session`) return route.fulfill({ status: 401, json: { error: 'Sign in' } });
      if (path === '/api/status') return route.fulfill({ json: { actor, repository: 'team/project', jobs: [] } });
      if (path === '/api/work-snapshot') return route.fulfill({ json: { work, now } });
      if (path === '/api/board') return route.fulfill({ json: boardFromStatus(work as any, Date.parse(now), null) });
      return route.fulfill({ json: [] });
    });
    await page.goto(`/#sign-in=${person}-one-time-code`);
    await page.getByRole('button', { name: 'Now', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Now', exact: true })).toBeVisible();
    const mine = work.filter(item => 'owner' in item && item.owner === person);
    const stage = (item: typeof work[number]) => 'closure' in item ? 'Closed' : item.stage === 'done' ? 'Shipped' : 'Backlog';
    if (!mine.length) {
      await expect(page.getByText('You have no items yet.')).toBeVisible();
      await expect(page.getByText(/master assigns you as owner/i)).toBeVisible();
    } else {
      const rows = page.getByRole('table', { name: 'Your items' }).locator('tbody tr');
      await expect(rows).toHaveCount(mine.length);
      for (const item of mine) {
        const row = rows.filter({ hasText: item.title });
        await expect(row).toContainText(item.key);
        await expect(row.locator('td').nth(1)).toHaveText(stage(item));
        await expect(row.locator('td').nth(2)).not.toBeEmpty();
      }
      if (person === 'alice') {
        await expect(rows.filter({ hasText: 'Alice priority' }).locator('td').nth(2)).toHaveText('Master agent: Release it for work when it is a priority');
        await expect(rows.filter({ hasText: 'Alice delivery' }).locator('td').nth(2)).toHaveText('Nobody: Closed: Finished');
      }
    }
    for (const item of work.filter(item => !('owner' in item) || item.owner !== person)) {
      await expect(page.getByRole('button', { name: `${item.key} · ${item.title}`, exact: true })).toHaveCount(0);
    }
    // The shared board remains available beside Now; owned cards name the human owner, unowned ones do not.
    await page.getByRole('navigation', { name: 'Pages in this section' }).getByRole('button', { name: 'Work', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible();
    if (person === 'alice') {
      await expect(page.locator('[data-row="GY-1"] .row-owner')).toHaveText('Owner · alice');
      await expect(page.locator('[data-row="GY-4"] .row-owner')).toHaveCount(0);
    }
  });
}
