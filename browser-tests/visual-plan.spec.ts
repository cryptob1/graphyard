import { test, expect, type Page } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';

// GY-2011: the goal picture page shows summary, outcomes, an SVG flowchart (boxes, arrows,
// Todo/Doing/Checking/Done colours) and Play steps through dependency order; the item page opens
// on its plain summary and folds description and criteria under Details.

const now = '2026-01-01T00:00:00Z';
const plan = {
  summary: 'Customers can sign up and pay. The API lands before the page. Notifications follow billing.',
  note: 'Node modules under src/.',
  author: 'planner', draftedAt: now,
  items: [
    { ref: 'api', title: 'API', plain: 'The signup API answers.', description: 'Full API detail.', outcomes: ['signup'], cases: ['signup-case'], criteria: [{ id: 'AC-1', text: 'API works', proofs: ['unit:api'] }], plannedFiles: ['src/api.ts'], dependsOn: [] },
    { ref: 'page', title: 'Page', plain: 'The signup page uses the API.', description: 'Full page detail.', outcomes: ['signup'], cases: ['signup-case'], criteria: [{ id: 'AC-1', text: 'Page works', proofs: ['unit:page'] }], plannedFiles: ['src/page.ts'], dependsOn: ['api'] },
    { ref: 'billing', title: 'Billing', plain: 'Customers can pay.', description: 'Full billing detail.', outcomes: ['signup'], cases: ['signup-case'], criteria: [{ id: 'AC-1', text: 'Billing works', proofs: ['unit:billing'] }], plannedFiles: ['src/billing.ts'], dependsOn: [] },
    { ref: 'notify', title: 'Notify', plain: 'Customers get a receipt.', description: 'Full notify detail.', outcomes: ['signup'], cases: ['signup-case'], criteria: [{ id: 'AC-1', text: 'Notify works', proofs: ['unit:notify'] }], plannedFiles: ['src/notify.ts'], dependsOn: ['billing'] },
  ],
};
const work = [
  { dependencies: [], plannedFiles: ['src/api.ts'], scenarioRequirements: [], id: 'w-api', key: 'GY-10', title: 'GOAL-V: API', summary: 'The signup API answers.', description: 'Full API detail.', type: 'feature', priority: 1, stage: 'done', stageEnteredAt: now, ready: true, policy: { review: true, checks: ['test'] }, policyRevision: 1, revision: 1, violations: [], workspaces: [], criteria: plan.items[0].criteria, evidence: [], gates: [] },
  { dependencies: [], plannedFiles: ['src/page.ts'], scenarioRequirements: [], id: 'w-page', key: 'GY-11', title: 'GOAL-V: Page', summary: 'The signup page uses the API.', description: 'Full page detail.', type: 'feature', priority: 1, stage: 'build', stageEnteredAt: now, ready: true, policy: { review: true, checks: ['test'] }, policyRevision: 1, revision: 1, violations: [], workspaces: [], criteria: plan.items[1].criteria, evidence: [], gates: [], lease: { owner: 'worker', epoch: 1, expiresAt: '2099-01-01T00:00:00Z' } },
  { dependencies: [], plannedFiles: ['src/billing.ts'], scenarioRequirements: [], id: 'w-billing', key: 'GY-12', title: 'GOAL-V: Billing', summary: 'Customers can pay.', description: 'Full billing detail.', type: 'feature', priority: 1, stage: 'review', stageEnteredAt: now, ready: true, policy: { review: true, checks: ['test'] }, policyRevision: 1, revision: 1, violations: [], workspaces: [], criteria: plan.items[2].criteria, evidence: [], gates: [], submission: { epoch: 1, pr: 12 }, candidate: { pr: 12, sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), branch: 'graphyard/gy-12-1', author: 'worker' } },
  { dependencies: [], plannedFiles: ['src/notify.ts'], scenarioRequirements: [], id: 'w-notify', key: 'GY-13', title: 'GOAL-V: Notify', summary: 'Customers get a receipt.', description: 'Full notify detail.', type: 'feature', priority: 1, stage: 'ready', stageEnteredAt: now, ready: true, policy: { review: true, checks: ['test'] }, policyRevision: 1, revision: 1, violations: [], workspaces: [], criteria: plan.items[3].criteria, evidence: [], gates: [] },
];
const goal = {
  id: 'goal-v', key: 'GOAL-V', statement: 'Customers can sign up and pay', stage: 'delivering', revision: 1,
  users: ['Customers'], constraints: [], deployTarget: 'uat', createdAt: now, updatedAt: now,
  acceptance: { author: 'author', pr: 1, branch: 'graphyard/goal-v', head: 'c'.repeat(40), draftedAt: now,
    outcomes: [{ id: 'signup', title: 'A customer can sign up', criteria: ['The signup page answers'], case: { id: 'signup-case' } }] },
  plan, planApproval: { by: 'approver', at: now, reason: 'Fine' },
  items: [{ ref: 'api', key: 'GY-10', id: 'w-api' }, { ref: 'page', key: 'GY-11', id: 'w-page' }, { ref: 'billing', key: 'GY-12', id: 'w-billing' }, { ref: 'notify', key: 'GY-13', id: 'w-notify' }],
};

async function fixture(page: Page) {
  await page.route('**/api/**', async route => {
    if (route.request().headers().authorization !== 'Bearer browser-fixture') return route.fulfill({ status: 401, json: { error: 'Rejected' } });
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/status')) return route.fulfill({ json: { actor: { id: 'fixture', role: 'admin', sessionKind: 'human' }, github: true, reviewProviders: ['github'], repository: 'fixture/repository', jobs: [] } });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work, now } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus(work as any, Date.parse(now), null) });
    if (path.endsWith('/goals/GOAL-V')) return route.fulfill({ json: goal });
    if (path.includes('/events')) return route.fulfill({ json: [] });
    return route.fulfill({ json: path.endsWith('/work') ? work : [] });
  });
}

test('integration:goal-visual-plan — a goal page shows summary, outcomes, four coloured boxes, arrows and Play order; an item page opens on its plain summary and folds Details', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await fixture(page);
  await page.goto('/');
  await page.getByLabel('Access token').fill('browser-fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', exact: true })).toBeVisible();

  await page.goto('/goals/GOAL-V');
  await expect(page.getByRole('article', { name: 'GOAL-V' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Plan summary' })).toContainText(plan.summary);
  await expect(page.getByRole('region', { name: 'Outcomes' })).toContainText('A customer can sign up');
  const flow = page.locator('svg.plan-flow');
  await expect(flow.locator('g.plan-box')).toHaveCount(4);
  await expect(flow.locator('g.plan-box[data-state="Done"]')).toHaveCount(1);
  await expect(flow.locator('g.plan-box[data-state="Doing"]')).toHaveCount(1);
  await expect(flow.locator('g.plan-box[data-state="Checking"]')).toHaveCount(1);
  await expect(flow.locator('g.plan-box[data-state="Todo"]')).toHaveCount(1);
  // Each state draws its own colour (the shared Todo/Doing/Checking/Done tokens).
  const fills = await flow.locator('g.plan-box rect').evaluateAll(rects => rects.map(rect => getComputedStyle(rect).fill));
  expect(new Set(fills).size).toBe(4);
  await expect(flow.locator('line.plan-arrow[data-from="api"][data-to="page"]')).toHaveCount(1);
  await expect(flow.locator('line.plan-arrow[data-from="billing"][data-to="notify"]')).toHaveCount(1);
  // Boxes follow dependency order: api, page, billing, notify.
  const order = await flow.locator('g.plan-box').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-ref')));
  expect(order).toEqual(['api', 'page', 'billing', 'notify']);

  await page.getByRole('button', { name: 'Play plan walkthrough' }).click();
  await expect(page.locator('.flow-caption')).toContainText('The signup API answers.');
  await expect(flow.locator('g.plan-box.lit[data-ref="api"]')).toBeVisible();
  await expect(page.locator('.flow-caption')).toContainText('The signup page uses the API.', { timeout: 3000 });
  await expect(flow.locator('g.plan-box.lit[data-ref="page"]')).toBeVisible();

  // Item page: plain summary first, description and criteria under Details (opened from a flowchart box).
  await flow.locator('g.plan-box[data-ref="api"]').click();
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