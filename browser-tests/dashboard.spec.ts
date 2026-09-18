import { test, expect, type Page } from '@playwright/test';

// Browser-only API fixtures: no production requests, credentials, or writes.
const work = { dependencies: [], plannedFiles: [], scenarioRequirements: [], id: 'fixture-work', key: 'GY-1', title: 'Browser fixture', description: 'Isolated UI audit', type: 'feature', priority: 1, stage: 'review', stageEnteredAt: '2026-01-01T00:00:00Z', ready: true, policy: { review: true, reviewProvider: 'github', checks: ['test'] }, policyRevision: 1, revision: 1, violations: [], workspaces: [], criteria: [{ id: 'AC-1', text: 'Observable behavior', proofs: ['manual:browser'] }], evidence: [], gates: [{ name: 'review', passed: false, reasons: ['Independent review required'] }], submission: { epoch: 1 }, candidate: { pr: 1, sha: 'abcdef123456' } };
async function fixture(page: Page, role = 'admin') {
  const state = { offline: false, unauthorized: false, writes: 0, pause: false };
  await page.route('**/api/**', async route => {
    if (state.offline) return route.abort();
    if (state.pause) await new Promise(r => setTimeout(r, 500));
    if (route.request().headers().authorization !== 'Bearer browser-fixture' || state.unauthorized) return route.fulfill({ status: 401, json: { error: 'Rejected' } });
    if (route.request().method() !== 'GET') state.writes++;
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path.endsWith('/status') ? { actor: { id: 'fixture', role, sessionKind: role === 'admin' ? 'human' : 'ai' }, github: true, reviewProviders: ['github','codex'], repository: 'fixture/repository', jobs: [], delegation: { limits: { maxLeads: 3, maxEngineersPerLead: 2, minReviewers: 1, maxReviewers: 2 }, slices: [{ id: 'product', name: 'Product', lead: { id: 'product-lead', displayName: 'Pine', role: 'slice-lead', sessionKind: 'ai' }, engineers: [{ id: 'engineer-a', displayName: 'Atlas', role: 'worker', sessionKind: 'ai' }, { id: 'human-pair', displayName: 'Rivera', role: 'worker', sessionKind: 'human' }], workers: [{ key: 'GY-1', id: 'engineer-a', displayName: 'Atlas', role: 'worker', sessionKind: 'ai' }, { key: 'GY-2', id: 'human-pair', displayName: 'Rivera', role: 'worker', sessionKind: 'human' }, { key: 'GY-3', id: 'engineer-a', displayName: 'Atlas', role: 'worker', sessionKind: 'ai' }], bottlenecks: [{ key: 'GY-1', reason: 'Independent review required' }] }, { id: 'infrastructure', name: 'Infrastructure', lead: null, workers: [], bottlenecks: [] }, { id: 'docs-experience', name: 'Docs/experience', lead: null, workers: [], bottlenecks: [] }], reviewers: [{ id: 'reviewer-a', displayName: 'Rowan', role: 'producer', sessionKind: 'ai' }, { id: 'legacy-proof', displayName: null, role: 'producer', sessionKind: 'undeclared' }] } } : path.endsWith('/work-snapshot') ? {work:[work],now:'2026-01-01T00:00:00Z'} : path.endsWith('/work') ? [work] : [] });
  });
  await page.goto('/'); return state;
}
async function login(page: Page, value = 'browser-fixture') { await page.getByLabel('Access token').fill(value); await page.getByRole('button', { name: 'Open control plane' }).click(); }

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`How Graphyard works is a readable visual guide on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/docs/how-graphyard-works');
    await expect(page.getByRole('heading', { name: 'How Graphyard works', level: 1 })).toBeVisible();
    const flow = page.locator('.how-guide > ol');
    await expect(flow.locator(':scope > li')).toHaveCount(10);
    const cards = await flow.locator(':scope > li').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top));
    expect(cards).toEqual([...cards].sort((a, b) => a - b));
    expect(new Set(cards).size).toBe(cards.length);
    await expect(flow.getByText('Setup', { exact: true })).toBeVisible();
    await expect(flow.getByText('Done', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Who does what' })).toBeVisible();
    await expect(page.getByText('Graphyard: delivery authority')).toBeVisible();
    await expect(page.getByText('Herdr: runtime supervision')).toBeVisible();
    const bounds = await page.locator('.docs-shell').evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
    expect(bounds.content).toBeLessThanOrEqual(bounds.width);
  });
}

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

test('slice view names leads, workers, reviewers and bottlenecks and labels each session kind from data', async ({ page }) => {
  await fixture(page); await login(page);
  const slices = page.getByRole('region', { name: 'Delivery slices' });
  await expect(slices.getByText('Product', { exact: true })).toBeVisible();
  await expect(slices.getByText('Pine')).toBeVisible();
  // Only the slice that actually has a lead is labelled with a lead's session kind.
  await expect(slices.getByText('AI lead', { exact: true })).toHaveCount(1);
  await expect(slices.getByText('No lead assigned', { exact: true })).toHaveCount(2);
  await expect(slices.getByText('Unassigned', { exact: true })).toHaveCount(2);
  const product = slices.locator('.slice-card').first();
  // Capacity is engineers, not leases: Atlas holds GY-1 and GY-3 but occupies one seat.
  await expect(product).toContainText('2/2 active engineers · 3 claimed items · 1 bottleneck');
  // Workers, reviewers and bottlenecks are named, and each identity carries its declared kind.
  await expect(product).toContainText('GY-1 · Atlas');
  await expect(product).toContainText('GY-2 · Rivera');
  await expect(product).toContainText('GY-3 · Atlas');
  await expect(product.locator('.session .identity.ai')).toHaveCount(2);
  await expect(product.locator('.session .identity.human')).toHaveCount(1);
  await expect(product).toContainText('GY-1 — Independent review required');
  await expect(slices.locator('.slice-card').nth(1)).toContainText('Bottlenecks: none');
  await expect(slices).toContainText('Independent review/proof sessions (2):');
  await expect(slices).toContainText('Rowan');
  await expect(slices).toContainText('legacy-proof');
  await expect(slices.getByText('Session kind undeclared', { exact: true })).toHaveCount(1);
  // The signed-in session states its own kind.
  const session = page.locator('.sidebar-bottom');
  await expect(session).toContainText('fixture · admin');
  await expect(session.locator('.identity.human')).toHaveCount(1);
  await expect(session.locator('.identity.ai')).toHaveCount(0);
});

test('an AI session is labelled AI in the signed-in session summary', async ({ page }) => {
  await fixture(page, 'worker'); await login(page);
  const session = page.locator('.sidebar-bottom');
  await expect(session).toContainText('fixture · worker');
  await expect(session.locator('.identity.ai')).toHaveCount(1);
  await expect(session.locator('.identity.human')).toHaveCount(0);
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

 test('maximum-length agent labels fit board cards and remain available in details', async ({page}) => {
  await fixture(page);
  const displayName='A'.repeat(100),runtime='R'.repeat(80),identity=`${displayName} · ${runtime}`;
  const assigned={...work,lease:{owner:'worker-a',epoch:1,expiresAt:'2026-01-01T00:01:00Z'},lastAssignment:{owner:'worker-a',epoch:1,displayName,runtime}};
  await page.route('**/api/work-snapshot',route=>route.fulfill({json:{work:[assigned],now:'2026-01-01T00:00:00Z'}}));
  await login(page);await page.getByRole('button',{name:/Work board/}).click();
  const card=page.locator('.card').first(),label=card.locator('.assignment-label');
  await expect(label).toHaveText(identity);
  await expect(label).toHaveAttribute('title',`${identity} · Worker ID: worker-a`);
  const bounds=await card.evaluate(e=>{const label=e.querySelector('.assignment-label')!;return {card:e.clientWidth,content:e.scrollWidth,label:label.clientWidth,text:label.scrollWidth,ellipsis:getComputedStyle(label).textOverflow}});
  expect(bounds.content).toBeLessThanOrEqual(bounds.card);expect(bounds.text).toBeGreaterThan(bounds.label);expect(bounds.ellipsis).toBe('ellipsis');
  await card.click();const details=page.getByRole('dialog').locator('.assignment-details');
  await expect(details).toHaveText(identity);
  expect(await details.evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
 });

test('scenario loading, failure, retry and real empty library are distinct', async ({ page }) => {
  await fixture(page); let release: () => void = () => {}; let failing = true;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/scenarios', async route => {
    await pending;
    return route.fulfill(failing ? { status: 503, json: { error: 'Runner catalog unavailable' } } : { json: [] });
  });
  await login(page); await page.getByRole('button', { name: 'Test cases', exact: false }).click();
  await expect(page.getByRole('status')).toHaveText('Loading test cases…');
  await expect(page.getByText('Describe the behavior you need to prove.')).toHaveCount(0);
  release(); await expect(page.getByRole('alert')).toContainText('unavailable');
  await expect(page.getByText('Describe the behavior you need to prove.')).toHaveCount(0);
  failing = false; await page.getByRole('button', { name: 'Retry loading test cases' }).click();
  await expect(page.getByText('Describe the behavior you need to prove.')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

const savedScenario = { id: 'saved-case', title: 'Saved case', purpose: 'Proves the library survives a failed re-read', setup: ['a condition'], steps: ['an action'], expected: ['an assertion'], environment: 'staging', runner: 'Playwright', testPath: 'tests/e2e/saved.spec.ts', revision: 1, hash: 'abc123', createdAt: '2026-01-01T00:00:00Z', createdBy: 'fixture' };
async function publishCase(page: Page, id: string) {
  await page.getByRole('button', { name: '＋ New test case' }).click();
  await page.getByLabel('Stable ID').fill(id);
  await page.getByLabel('Title', { exact: true }).fill('Published case');
  await page.getByLabel('Purpose').fill('Publishes while the catalog read fails');
  await page.getByLabel('Steps — one action per line').fill('an action');
  await page.getByLabel('Expected results — one assertion per line').fill('an assertion');
  await page.getByLabel('Test file in Git').fill('tests/e2e/published.spec.ts');
  await page.getByRole('button', { name: 'Publish test case' }).click();
}

test('a failed re-read keeps already-observed test cases visible and marks them stale', async ({ page }) => {
  await fixture(page); let reads = false;
  await page.route('**/api/scenarios', route => route.request().method() === 'POST' ? (reads = true, route.fulfill({ json: savedScenario }))
    : reads ? route.fulfill({ status: 503, json: { error: 'Runner catalog unavailable' } }) : route.fulfill({ json: [savedScenario] }));
  await login(page); await page.getByRole('button', { name: 'Test cases', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'Saved case' })).toBeVisible();
  await publishCase(page, 'published-case');
  await expect(page.getByRole('alert')).toContainText('unavailable');
  await expect(page.getByRole('heading', { name: 'Saved case' })).toBeVisible();
  await expect(page.getByText('Previously loaded definitions are shown; they may be stale.')).toBeVisible();
  await expect(page.getByText('Describe the behavior you need to prove.')).toHaveCount(0);
});

test('a failed re-read reports unknown contents instead of claiming an empty or shown library', async ({ page }) => {
  await fixture(page); let reads = false;
  await page.route('**/api/scenarios', route => route.request().method() === 'POST' ? (reads = true, route.fulfill({ json: savedScenario }))
    : reads ? route.fulfill({ status: 503, json: { error: 'Runner catalog unavailable' } }) : route.fulfill({ json: [] }));
  await login(page); await page.getByRole('button', { name: 'Test cases', exact: false }).click();
  await expect(page.getByText('Describe the behavior you need to prove.')).toBeVisible();
  await publishCase(page, 'published-case');
  await expect(page.getByRole('alert')).toContainText('unavailable');
  await expect(page.getByText('Describe the behavior you need to prove.')).toHaveCount(0);
  await expect(page.getByText('Previously loaded definitions are shown; they may be stale.')).toHaveCount(0);
  await expect(page.getByText('The library could not be re-read; its current contents are unknown.')).toBeVisible();
  await expect(page.getByText('Test cases could not be re-read. Retry to observe the library.')).toBeVisible();
});

test('a rejected publish never reports the library as unread or stale', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/scenarios', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 400, json: { error: 'Stable ID exceeds 100 characters' } }) : route.fulfill({ json: [savedScenario] }));
  await login(page); await page.getByRole('button', { name: 'Test cases', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'Saved case' })).toBeVisible();
  await publishCase(page, 'rejected-case');
  await expect(page.getByRole('alert')).toContainText('Stable ID exceeds 100 characters');
  await page.getByRole('button', { name: 'Close form' }).click();
  await expect(page.getByRole('heading', { name: 'Saved case' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('Previously loaded definitions are shown; they may be stale.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry loading test cases' })).toHaveCount(0);
});

test('a rejected publish leaves a confirmed empty library reported as empty', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/scenarios', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 400, json: { error: 'Stable ID exceeds 100 characters' } }) : route.fulfill({ json: [] }));
  await login(page); await page.getByRole('button', { name: 'Test cases', exact: false }).click();
  await expect(page.getByText('Describe the behavior you need to prove.')).toBeVisible();
  await publishCase(page, 'rejected-case');
  await expect(page.getByRole('alert')).toContainText('Stable ID exceeds 100 characters');
  await page.getByRole('button', { name: 'Close form' }).click();
  await expect(page.getByText('Describe the behavior you need to prove.')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('The library could not be re-read; its current contents are unknown.')).toHaveCount(0);
  await expect(page.getByText('Test cases could not be re-read. Retry to observe the library.')).toHaveCount(0);
});

test('a publish error is not carried into the next form', async ({ page }) => {
  await fixture(page); let reject = true;
  await page.route('**/api/scenarios', route => route.request().method() === 'POST'
    ? (reject ? route.fulfill({ status: 400, json: { error: 'Stable ID exceeds 100 characters' } }) : route.fulfill({ json: savedScenario }))
    : route.fulfill({ json: [] }));
  await login(page); await page.getByRole('button', { name: 'Test cases', exact: false }).click();
  await expect(page.getByText('Describe the behavior you need to prove.')).toBeVisible();
  await publishCase(page, 'rejected-case');
  await expect(page.getByRole('alert')).toContainText('Stable ID exceeds 100 characters');
  await page.getByRole('button', { name: 'Close form' }).click();
  reject = false; await page.getByRole('button', { name: '＋ New test case' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('work details explain missing proof and operator can revise explicit criteria', async ({ page }) => {
  const state = await fixture(page); await login(page);
  await page.getByRole('button', { name: /GY-1.*Browser fixture/ }).click();
  await expect(page.getByText('AC-1 · manual:browser · unmeasured')).toBeVisible();
  await page.getByRole('button', { name: 'Revise requirements', exact: true }).click();
  const form = page.getByRole('form', { name: 'Revise requirements' });
  await form.getByRole('button', { name: 'Add criterion' }).click();
  await form.getByLabel('Observable outcome').nth(1).fill('An explicit second outcome');
  await form.getByLabel('Required proofs (comma separated)').nth(1).fill('integration:second');
  await form.getByLabel('Reason for revision').fill('New behavior discovered during planning');
  let body: any;
  await page.route('**/api/work/fixture-work/requirements', async route => { body = route.request().postDataJSON(); await route.fulfill({ json: work }); });
  await form.getByRole('button', { name: 'Save requirement revision' }).click();
  await expect(form).toHaveCount(0);
  expect(body.expectedPolicyRevision).toBe(1); expect(body.criteria[1]).toEqual({ id: 'AC-2', text: 'An explicit second outcome', proofs: ['integration:second'] });
  expect(body.reason).toBe('New behavior discovered during planning'); expect(state.writes).toBe(0);
});

test('validation view reports failures honestly and bounds request history', async ({ page }) => {
  await fixture(page); let fail = true;
  const requests = Array.from({ length: 25 }, (_, i) => ({ id: `request-${i}`, workId: work.id, proof: 'e2e:behavior', candidateId: 'candidate', runner: { id: 'runner' }, collector: { id: 'collector' }, state: 'expired', attempts: [{ id: `attempt-${i}`, epoch: 1, state: 'expired', settled: false, dispatchedAt: '2026-01-01T00:00:00Z' }], maxAttempts: 2, deadline: '2026-01-01T01:00:00Z', createdAt: '2026-01-01T00:00:00Z' }));
  let olderReads = 0;
  await page.route('**/api/validation*', route => {
    const older = new URL(route.request().url()).searchParams.has('cursor'); if (older) olderReads++;
    return route.fulfill(fail ? { status: 503, json: { error: 'Validation unavailable' } } : { json: { candidates: [], requests: older ? requests.slice(20) : requests.slice(0,20), nextCursor: older ? null : 'page-two' } });
  });
  await login(page); await page.getByRole('button', { name: '↻ Validation' }).click();
  await expect(page.getByRole('heading', { name: 'Validation requests' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Validation unavailable');
  await expect(page.getByText('No validation requested yet.')).toHaveCount(0);
  fail = false; await page.getByRole('button', { name: 'Retry validation requests' }).click();
  await expect(page.locator('.scenario-card')).toHaveCount(20);
  await expect(page.getByText('Resources remain reserved.', { exact: false })).toHaveCount(20);
  expect(olderReads).toBe(0);
  await page.getByRole('button', { name: 'Load older requests' }).click();
  await expect(page.locator('.scenario-card')).toHaveCount(25);
  expect(olderReads).toBe(1);
  await expect(page.getByText('Browsing history; live updates paused.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Return to latest' }).click();
  await expect(page.locator('.scenario-card')).toHaveCount(20);
});
