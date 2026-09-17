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
    return route.fulfill({ json: path.endsWith('/status') ? { actor: { id: 'fixture', role }, github: true, reviewProviders: ['github','codex'], repository: 'fixture/repository', jobs: [] } : path.endsWith('/work-snapshot') ? {work:[work],now:'2026-01-01T00:00:00Z'} : path.endsWith('/work') ? [work] : [] });
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

const pulseFixture = (overrides: Record<string, unknown> = {}) => ({ generatedAt: new Date().toISOString(), range: { start: '2026-06-29T00:00:00.000Z', end: new Date().toISOString(), weeks: 12, semantics: 'repository-utc-inclusive' }, completeness: 'complete', truncated: false, counts: { days7: 3, days30: 8 }, intentToMerge: { medianHours: 12.5, sampleSize: 7, excluded: 1 }, prToProduction: { averageHours: 30, medianHours: 24, p90Hours: 48, sampleSize: 6, eligible: 8, excluded: 2, coveragePercent: 75, sparse: false, exclusions: { 'no-verifiable-production-deployment': 2 }, split: { prToMergeAverageHours: 18, mergeToProductionAverageHours: 12 } }, weeks: Array.from({ length: 12 }, (_, index) => ({ start: new Date(Date.UTC(2026, 5, 29 + index * 7)).toISOString(), end: new Date(Date.UTC(2026, 6, 5 + index * 7)).toISOString(), count: index % 4 })), recent: [{ key: 'GY-9', title: 'Exact delivery', pullRequest: 42, mergeSha: 'abcdef1234567890abcdef1234567890abcdef12', mergedAt: '2026-09-15T12:00:00.000Z', quality: { passingProofs: 4, requiredProofs: 4, violations: [] } }], ...overrides });

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) test(`shipping pulse exposes exact metrics, links and chart text on ${viewport.name}`, async ({ page }) => {
  await page.setViewportSize(viewport); await fixture(page);
  await page.route('**/api/shipping-pulse', route => route.fulfill({ json: pulseFixture() }));
  await login(page); await page.getByRole('button', { name: /Shipping pulse/ }).click();
  await expect(page.getByRole('heading', { name: 'Shipping pulse' })).toBeVisible();
  await expect(page.getByLabel('Delivery metrics')).toContainText('3');
  await expect(page.getByText('12.5h')).toBeVisible(); await expect(page.getByText('7 included · 1 excluded')).toBeVisible();
  await expect(page.getByLabel('Pull request to production metrics')).toContainText('30h');
  await expect(page.getByText('6 included of 8')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Weekly delivery counts' }).getByRole('listitem')).toHaveCount(12);
  await expect(page.getByRole('link', { name: /PR #42/ })).toHaveAttribute('href', 'https://github.com/fixture/repository/pull/42');
  await expect(page.getByRole('link', { name: /Commit abcdef12/ })).toHaveAttribute('href', 'https://github.com/fixture/repository/commit/abcdef1234567890abcdef1234567890abcdef12');
  const shell = page.locator('.shell'); expect((await shell.evaluate(element => element.scrollWidth <= element.clientWidth))).toBe(true);
});

test('shipping pulse labels sparse and unavailable production samples without fabricating zero', async ({ page }) => {
  await fixture(page);
  // The second delivery's authorizing snapshot cannot be resolved, so its proof totals are
  // unknown. An unknown total must never be drawn as 0/0, which would read as a clean record.
  const unresolved = { key: 'GY-10', title: 'Unretained authorization', pullRequest: 43, mergeSha: 'bcdef01234567890abcdef1234567890abcdef12', mergedAt: '2026-09-14T12:00:00.000Z', quality: { passingProofs: null, requiredProofs: null, violations: [], unavailableReason: 'The immutable snapshot that authorized this delivery is no longer in the retained ledger, so recorded proof totals are unknown.' } };
  await page.route('**/api/shipping-pulse', route => route.fulfill({ json: pulseFixture({ prToProduction: { averageHours: null, medianHours: null, p90Hours: null, sampleSize: 0, eligible: 1, excluded: 1, coveragePercent: 0, sparse: true, exclusions: { 'no-verifiable-production-deployment': 1 }, split: { prToMergeAverageHours: null, mergeToProductionAverageHours: null } }, recent: [...pulseFixture().recent, unresolved] }) }));
  await login(page); await page.getByRole('button', { name: /Shipping pulse/ }).click();
  await expect(page.getByText('Sparse sample.')).toBeVisible();
  await expect(page.getByLabel('Pull request to production metrics')).toContainText('Unavailable');
  await page.getByText('Why records were excluded').click();
  await expect(page.getByText('no verifiable production deployment: 1')).toBeVisible();
  const entry = page.locator('.delivery-list article').filter({ hasText: 'GY-10' });
  await expect(entry).toContainText('Recorded proof totals unavailable');
  await expect(entry).toContainText('no longer in the retained ledger');
  await expect(entry).not.toContainText('0/0');
  await expect(page.locator('.delivery-list article').filter({ hasText: 'GY-9' })).toContainText('4/4 recorded proofs passed');
});

test('shipping pulse distinguishes loading, unavailable, empty, partial, and stale data', async ({ page }) => {
  await fixture(page); let mode = 'loading'; let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/shipping-pulse', async route => {
    if (mode === 'loading') { await pending; return route.abort(); }
    if (mode === 'unavailable') return route.abort();
    if (mode === 'empty') return route.fulfill({ json: pulseFixture({ recent: [], counts: { days7: 0, days30: 0 }, weeks: Array.from({ length: 12 }, (_, index) => ({ start: new Date(Date.UTC(2026, 5, 29 + index * 7)).toISOString(), end: new Date(Date.UTC(2026, 6, 5 + index * 7)).toISOString(), count: 0 })) }) });
    return route.fulfill({ json: pulseFixture({ completeness: 'partial', partialReason: 'More production observations matched a merge than the query cap reads.' }) });
  });
  await login(page); await page.getByRole('button', { name: /Shipping pulse/ }).click();
  await expect(page.getByRole('status')).toContainText('Loading shipping pulse');
  mode = 'unavailable'; release(); await expect(page.getByRole('alert')).toContainText('unavailable');
  mode = 'empty'; await page.getByRole('button', { name: /Delivery graph/ }).click(); await page.getByRole('button', { name: /Shipping pulse/ }).click();
  await expect(page.getByText('No deliveries in this window')).toBeVisible(); await expect(page.getByLabel('Delivery metrics')).toHaveCount(0);
  mode = 'partial'; await page.getByRole('button', { name: /Delivery graph/ }).click(); await page.getByRole('button', { name: /Shipping pulse/ }).click();
  await expect(page.getByText('Partial history.')).toBeVisible(); await expect(page.getByText('More production observations matched a merge than the query cap reads.')).toBeVisible();
  // Partial at the production cap does not truncate the delivery sample, so the durations
  // are not labelled as sampled here; only the delivery cap does that.
  await expect(page.getByText('Sampled durations:')).toHaveCount(0);
  // Staleness is measured from this browser's own last successful read, so it appears
  // when a refresh fails while data is on screen - never from a repository/browser clock gap.
  mode = 'unavailable'; await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('Data is stale.')).toBeVisible();
  await expect(page.getByText('Partial history.')).toBeVisible();
});

test('truncated history labels durations as newest-delivery samples, never as bounds', async ({ page }) => {
  await fixture(page);
  // The delivery cap makes counts lower bounds but leaves the durations a sample of the
  // newest work, so every duration group must say so rather than read as a bound.
  await page.route('**/api/shipping-pulse', route => route.fulfill({ json: pulseFixture({ completeness: 'partial', truncated: true, partialReason: 'More than 1000 exact deliveries occurred in the bounded window; only the newest 1000 were read. The counts are lower bounds. The durations are not bounds.' }) }));
  await login(page); await page.getByRole('button', { name: /Shipping pulse/ }).click();
  await expect(page.getByText('Partial history.')).toBeVisible();
  await expect(page.getByText('The counts are lower bounds. The durations are not bounds.')).toBeVisible();
  const sampled = page.getByText('Sampled durations:');
  await expect(sampled).toHaveCount(2);
  await expect(sampled.first()).toContainText('they are not lower bounds');
});

test('shipping pulse is not offered to operator agents whose scoped API cannot serve it', async ({ page }) => {
  await fixture(page, 'operator-agent'); await login(page);
  await expect(page.getByRole('button', { name: /Delivery graph/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Shipping pulse/ })).toHaveCount(0);
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
