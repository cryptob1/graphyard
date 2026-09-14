import { test, expect, type Page } from '@playwright/test';

// Browser-only API fixtures: no production requests, credentials, or writes.
const work = { id: 'fixture-work', key: 'GY-1', title: 'Browser fixture', description: 'Isolated UI audit', type: 'feature', priority: 1, stage: 'review', stageEnteredAt: '2026-01-01T00:00:00Z', ready: true, policy: { review: true, reviewProvider: 'github', checks: ['test'] }, policyRevision: 1, revision: 1, violations: [], workspaces: [], criteria: [{ id: 'AC-1', text: 'Observable behavior', proofs: ['manual:browser'] }], evidence: [], gates: [{ name: 'review', passed: false, reasons: ['Independent review required'] }], submission: { epoch: 1 }, candidate: { pr: 1, sha: 'abcdef123456' } };
async function fixture(page: Page, role = 'admin') {
  const state = { offline: false, unauthorized: false, writes: 0, pause: false };
  await page.route('**/api/**', async route => {
    if (state.offline) return route.abort();
    if (state.pause) await new Promise(r => setTimeout(r, 500));
    if (route.request().headers().authorization !== 'Bearer browser-fixture' || state.unauthorized) return route.fulfill({ status: 401, json: { error: 'Rejected' } });
    if (route.request().method() !== 'GET') state.writes++;
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path.endsWith('/status') ? { actor: { id: 'fixture', role }, github: true, reviewProviders: ['github','codex'], repository: 'fixture/repository', jobs: [] } : path.endsWith('/work-snapshot') ? {work:[work],now:'2026-01-01T00:00:00Z'} : path.endsWith('/work') ? [work] : [] });
  });
  await page.goto('/'); return state;
}
async function login(page: Page, value = 'browser-fixture') { await page.getByLabel('Access token').fill(value); await page.getByRole('button', { name: 'Open control plane' }).click(); }

test('invalid login remains on login; whitespace is trimmed and loading never claims empty work', async ({ page }) => {
  const state = await fixture(page);
  await login(page, 'invalid');
  await expect(page.getByRole('alert')).toContainText('rejected');
  await expect(page.getByLabel('Access token')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Delivery graph' })).toHaveCount(0);
  await expect(page.getByText('GitHub enforcement is not connected', { exact: false })).toHaveCount(0);
  state.pause = true; await login(page, '  browser-fixture  ');
  await expect(page.getByRole('status')).toContainText('Verifying');
  await expect(page.getByRole('heading', { name: 'Delivery graph' })).toBeVisible();
  await expect(page.getByText('fixture/repository')).toBeVisible();
});

test('connection loss labels stale data, recovers, and revoked sessions clear the dashboard', async ({ page }) => {
  const state = await fixture(page); await login(page);
  await expect(page.getByText('Control plane connected')).toBeVisible();
  state.offline = true;
  await expect(page.getByText('Disconnected · data may be stale')).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('alert')).toContainText('stale');
  await expect(page.getByRole('heading', { name: 'Browser fixture' })).toBeVisible();
  state.offline = false;
  await expect(page.getByText('Control plane connected')).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('alert')).toHaveCount(0);
  state.unauthorized = true;
  await expect(page.getByLabel('Access token')).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('heading', { name: 'Browser fixture' })).toHaveCount(0);
});

test('mobile sign out is reachable and removes the session', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixture(page); await login(page);
  const signOut = page.getByRole('button', { name: 'Sign out' });
  await expect(signOut).toBeVisible(); await signOut.click();
  await expect(page.getByLabel('Access token')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('graphyard-token'))).toBeNull();
});

async function checkDialog(page: Page, trigger: ReturnType<Page['getByRole']>) {
  await trigger.click(); const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Close/ })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await dialog.evaluate(e => e.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: /Close/ })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
}
test('all three dialogs move, trap, and restore focus and close with Escape', async ({ page }) => {
  const state = await fixture(page); await login(page);
  await checkDialog(page, page.getByRole('button', { name: /GY-1 P1/ }));
  await checkDialog(page, page.getByRole('button', { name: '＋ New work item' }));
  await page.getByRole('button', { name: '✓ Test cases' }).click();
  await checkDialog(page, page.getByRole('button', { name: '＋ New test case' }));
  expect(state.writes).toBe(0);
});

test('reader has no creation controls; graph filters and search still work', async ({ page }) => {
  await fixture(page, 'reader'); await login(page);
  await expect(page.getByRole('heading', { name: 'Browser fixture' })).toBeVisible();
  await expect(page.getByRole('button', { name: '＋ New work item' })).toHaveCount(0);
  await page.getByLabel('Search work').fill('no matches');
  await expect(page.getByRole('heading', { name: 'Browser fixture' })).toHaveCount(0);
  await page.getByLabel('Search work').fill('GY-1');
  await expect(page.getByRole('heading', { name: 'Browser fixture' })).toBeVisible();
  await page.getByRole('button', { name: '✓ Test cases' }).click();
  await expect(page.getByRole('heading', { name: 'Test-case library' })).toBeVisible();
  await expect(page.getByRole('button', { name: '＋ New test case' })).toHaveCount(0);
});

test('a delayed post-create refresh cannot restore the signed-out session or leak into a new login', async ({ page }) => {
  await fixture(page); await login(page);
  let resume!: () => void;
  const held = new Promise<void>(resolve => { resume = resolve; });
  let requested!: () => void;
  const pending = new Promise<void>(resolve => { requested = resolve; });
  let created = false;
  await page.route('**/api/work*', async route => {
    if (route.request().method() === 'POST') { expect(route.request().postDataJSON().policy.reviewProvider).toBe('codex'); created = true; return route.fulfill({ json: work }); }
    if (!created) return route.fallback();
    requested(); await held; return route.fulfill({ json: {work:[work],now:'2026-01-01T00:00:00Z'} });
  });
  await page.getByRole('button', { name: '＋ New work item' }).click();
  await page.getByLabel('Title', { exact: true }).fill('Delayed creation');
  await page.getByLabel('Acceptance criterion').fill('No data crosses sessions');
  await page.getByLabel('Required proof').fill('manual:session');
  await page.getByLabel('Code review provider').selectOption('codex');
  await page.getByRole('button', { name: 'Create work item', exact: true }).click();
  await pending;
  await page.getByRole('button', { name: 'Sign out' }).click();
  const oldResponse = page.waitForResponse(response => response.url().endsWith('/api/work-snapshot') && response.status() === 200);
  resume(); await oldResponse;
  // Let the old response's React updates settle before attempting another login.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  let rejectLogin!: () => void;
  const rejected = new Promise<void>(resolve => { rejectLogin = resolve; });
  await page.route('**/api/status', async route => { await rejected; return route.fulfill({ status: 401, json: { error: 'Rejected' } }); });
  await login(page, 'invalid');
  await expect(page.getByRole('status')).toContainText('Verifying');
  await expect(page.getByRole('heading', { name: 'Delivery graph' })).toHaveCount(0);
  rejectLogin();
  await expect(page.getByRole('alert')).toContainText('rejected');
  await expect(page.getByLabel('Access token')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Browser fixture' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Delivery graph' })).toHaveCount(0);
});

 test('polling retains loaded history when an event refresh fails', async ({ page }) => {
  await fixture(page); let eventReads = 0;
  await page.route('**/api/events**', route => {
    eventReads++;
    return eventReads === 1 ? route.fulfill({ json: [{ seq: 1, kind: 'fixture-created', actor: 'fixture', created_at: '2026-01-01T00:00:00Z' }] }) : route.fulfill({ status: 503, json: { error: 'History temporarily unavailable' } });
  });
  await login(page); await page.getByRole('button', { name: /GY-1 P1/ }).click();
  await expect(page.getByRole('dialog').getByText('fixture-created', { exact: true })).toBeVisible();
  await expect.poll(() => eventReads, { timeout: 10000 }).toBeGreaterThan(1);
  await expect(page.getByRole('dialog').getByText('fixture-created', { exact: true })).toBeVisible();
 });

test('history groups observation noise and bounds expanded rows without losing other events', async ({ page }) => {
  await fixture(page);
  const events = Array.from({ length: 60 }, (_, i) => ({ seq: 60 - i, kind: i < 40 ? 'github.observed' : `work.event-${i}`, actor: 'github', created_at: new Date(Date.UTC(2026, 0, 1, 0, 60 - i)).toISOString() }));
  await page.route('**/api/events**', route => route.fulfill({ json: events }));
  await login(page); await page.getByRole('button', { name: /GY-1 P1/ }).click();
  const history = page.getByRole('region', { name: 'Work history', exact: true });
  await expect(history.getByText('github.observed × 40', { exact: true })).toBeVisible();
  await expect(history.locator('.timeline > div')).toHaveCount(20);
  await history.getByRole('button', { name: 'Show more history' }).click();
  await expect(history.locator('.timeline > div')).toHaveCount(21);
  await expect(history.getByText('work.event-59', { exact: true })).toBeAttached();
  await history.getByLabel('Group consecutive GitHub observations').uncheck();
  await expect(history.locator('.timeline > div')).toHaveCount(20);
  await history.getByRole('button', { name: 'Show more history' }).click();
  await expect(history.locator('.timeline > div')).toHaveCount(40);
  const bounds = await history.getByRole('region', { name: 'History entries' }).evaluate(e => ({ height: e.clientHeight, content: e.scrollHeight }));
  expect(bounds.height).toBeLessThanOrEqual(320); expect(bounds.content).toBeGreaterThan(bounds.height);
  await history.getByRole('button', { name: 'Show less history' }).click();
  await expect(history.locator('.timeline > div')).toHaveCount(20);
});

 test('unavailable review providers disable selection and explain the missing connection', async ({page}) => {
  await fixture(page);
  await page.route('**/api/status',route=>route.fulfill({json:{actor:{id:'fixture',role:'admin'},github:true,reviewProviders:['github'],repository:'fixture/repository',jobs:[]}}));
  await login(page);await page.getByRole('button',{name:/GY-1 P1/}).click();
  await expect(page.getByRole('button',{name:'Use Codex cloud review'})).toBeDisabled();
  await expect(page.getByText(/Codex review is unavailable/)).toBeVisible();
  await page.getByLabel('Close details').click();await page.getByRole('button',{name:'New work item'}).click();
  expect(await page.locator('option[value="codex"]').evaluate((e:HTMLOptionElement)=>e.disabled)).toBe(true);
 });

 test('lease activity uses the work snapshot time despite a later status response', async ({page}) => {
  await fixture(page);
  const assigned={...work,lease:{owner:'worker-a',epoch:1,expiresAt:'2026-01-01T00:01:00Z'},lastAssignment:{owner:'worker-a',epoch:1,displayName:'Atlas',runtime:'Codex'}};
  await page.route('**/api/work-snapshot',route=>route.fulfill({json:{work:[assigned],now:'2026-01-01T00:00:00Z'}}));
  await page.route('**/api/status',route=>route.fulfill({json:{actor:{id:'fixture',role:'reader'},github:true,jobs:[],now:'2026-01-01T00:02:00Z'}}));
  await login(page);const card=page.locator('.card').first();await expect(card).toContainText('Atlas · Codex');await expect(card).not.toContainText('Last worked by');
  await expect(card.locator('.dot.green')).toHaveCount(1);
 });
