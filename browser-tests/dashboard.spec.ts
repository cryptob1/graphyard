import { readFileSync } from 'node:fs';
import { test, expect, type Locator, type Page, type Route } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';

// GET /api/board (GY-200): the Work page renders the groups the server serves. The fixture builds it
// with the server's own module over the snapshot the page is served, read back through the page's
// routes, so a test that overrides the snapshot is served that snapshot's board.
// A read still in flight when its test ends is abandoned rather than failing the finished test.
async function serveBoard(page: Page, route: Route) {
  try {
    const snapshot = await page.evaluate(() => fetch('/api/work-snapshot', { headers: { Authorization: 'Bearer browser-fixture' } }).then(response => response.json()));
    await route.fulfill({ json: boardFromStatus(snapshot?.work ?? [], Date.parse(snapshot?.now ?? new Date().toISOString()), null) });
  } catch { /* the page closed under the read */ }
}

// Browser-only API fixtures: no production requests, credentials, or writes.
const work = { dependencies: [], plannedFiles: [], scenarioRequirements: [], id: 'fixture-work', key: 'GY-1', title: 'Browser fixture', description: 'Isolated UI audit', type: 'feature', priority: 1, stage: 'review', stageEnteredAt: '2026-01-01T00:00:00Z', ready: true, policy: { review: true, reviewProvider: 'github', checks: ['test'] }, policyRevision: 1, revision: 1, violations: [], workspaces: [], criteria: [{ id: 'AC-1', text: 'Observable behavior', proofs: ['manual:browser'] }], evidence: [], gates: [{ name: 'review', passed: false, reasons: ['Independent review required'] }], submission: { epoch: 1 }, candidate: { pr: 1, sha: 'abcdef1234567890abcdef1234567890abcdef12' } };
const proofGrants = { authorities: [{ principalId: 'ci', role: 'producer', patterns: ['integration:*'], source: 'grant' }, { principalId: 'operator', role: 'admin', patterns: ['manual:*'], source: 'role' }],
  grants: [{ principalId: 'ci', role: 'producer', patterns: ['integration:*'], revision: 3, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', seededFrom: ['integration:claim-safety'], lastMutation: { kind: 'grant', actor: 'operator', at: '2026-01-02T00:00:00Z', reason: 'CI produces integration proof', patterns: ['integration:*'] } }] };
async function fixture(page: Page, role = 'admin') {
  const state = { offline: false, unauthorized: false, writes: 0, pause: false };
  await page.route('**/api/**', async route => {
    if (state.offline) return route.abort();
    if (state.pause) await new Promise(r => setTimeout(r, 500));
    if (route.request().headers().authorization !== 'Bearer browser-fixture' || state.unauthorized) return route.fulfill({ status: 401, json: { error: 'Rejected' } });
    if (route.request().method() !== 'GET') state.writes++;
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/board')) return serveBoard(page, route);
    return route.fulfill({ json: path.endsWith('/status') ? { actor: { id: 'fixture', role, sessionKind: role === 'admin' ? 'human' : 'ai' }, github: true, reviewProviders: ['github','codex'], repository: 'fixture/repository', jobs: [], delegation: { limits: { maxLeads: 3, maxEngineersPerLead: 2, minReviewers: 1, maxReviewers: 2 }, slices: [{ id: 'product', name: 'Product', lead: { id: 'product-lead', displayName: 'Pine', role: 'slice-lead', sessionKind: 'ai' }, engineers: [{ id: 'engineer-a', displayName: 'Atlas', role: 'worker', sessionKind: 'ai' }, { id: 'human-pair', displayName: 'Rivera', role: 'worker', sessionKind: 'human' }], workers: [{ key: 'GY-1', id: 'engineer-a', displayName: 'Atlas', role: 'worker', sessionKind: 'ai' }, { key: 'GY-2', id: 'human-pair', displayName: 'Rivera', role: 'worker', sessionKind: 'human' }, { key: 'GY-3', id: 'engineer-a', displayName: 'Atlas', role: 'worker', sessionKind: 'ai' }], bottlenecks: [{ key: 'GY-1', reason: 'Independent review required' }] }, { id: 'infrastructure', name: 'Infrastructure', lead: null, workers: [], bottlenecks: [] }, { id: 'docs-experience', name: 'Docs/experience', lead: null, workers: [], bottlenecks: [] }], reviewers: [{ id: 'reviewer-a', displayName: 'Rowan', role: 'producer', sessionKind: 'ai' }, { id: 'legacy-proof', displayName: null, role: 'producer', sessionKind: 'undeclared' }] } } : path.endsWith('/work-snapshot') ? {work:[work],now:'2026-01-01T00:00:00Z'} : path.endsWith('/work') ? [work] : path === '/api/proof-grants' ? proofGrants : [] });
  });
  await page.goto('/'); return state;
}
// Opening a work item goes through the card's own selection control, a sibling of
// the candidate links rather than a button wrapped around them.
const cardSelect = (page: Page) => page.getByRole('button', { name: /Browser fixture.*GY-1/ });

async function login(page: Page, value = 'browser-fixture') { await page.getByLabel('Access token').fill(value); await page.getByRole('button', { name: 'Open control plane' }).click(); }
// The one navigation (GY-161): the sidebar holds Work, Workers, Shipped, Tests (planned), Insights and
// Settings; the other pages are sub-page links under one of them. On a phone the sidebar folds into
// a Menu button. An open work item is a page of its own, left with "← Back".
const workHeading = (page: Page) => page.getByRole('heading', { name: 'Work', exact: true, level: 1 });
async function sidebarEntry(page: Page, entry: string) {
  const menu = page.getByRole('button', { name: 'Menu' });
  if (page.viewportSize()!.width <= 650 && await menu.getAttribute('aria-expanded') !== 'true') await menu.click();
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: entry, exact: true }).click();
}
const openWork = (page: Page) => sidebarEntry(page, 'Work');
async function openPage(page: Page, section: 'Shipped' | 'Settings', tab: string) {
  await sidebarEntry(page, section);
  await page.getByRole('navigation', { name: 'Pages in this section' }).getByRole('button', { name: tab, exact: true }).click();
}
/** Insights is one page (GY-168): the shipping pulse and flow analytics are under its one Show details. */
async function openInsightsDetails(page: Page) {
  await sidebarEntry(page, 'Insights');
  await page.locator('.insight-details > summary').click();
}
const pulse = (page: Page) => page.locator('.pulse');
const itemPage = (page: Page, name?: string) => name ? page.getByRole('article', { name }) : page.locator('article.item-page');
const technicalDetails = (page: Page) => itemPage(page).getByText('Technical details', { exact: true }).click();
const fullHistory = (page: Page) => itemPage(page).locator('.full-history > summary').click();
const editMenu = (page: Page) => itemPage(page).getByText('Edit', { exact: true }).click();
const row = (page: Page, key: string) => page.locator(`.work-row[data-row="${key}"]`);

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`How Graphyard works is a readable visual guide on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/docs/how-graphyard-works');
    await expect(page.getByRole('heading', { name: 'How Graphyard works', level: 1 })).toBeVisible();
    const flow = page.locator('.how-guide > ol').first();
    await expect(flow.locator(':scope > li')).toHaveCount(6);
    const cards = await flow.locator(':scope > li').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top));
    expect(cards).toEqual([...cards].sort((a, b) => a - b));
    expect(new Set(cards).size).toBe(cards.length);
    await expect(flow.getByText('Ready', { exact: true })).toBeVisible();
    await expect(flow.getByText('Done', { exact: true })).toBeVisible();
    for (const heading of ['One trip from setup to Done', 'Who holds which authority', 'Correctness rules']) await expect(page.getByRole('heading', { name: heading, level: 2 })).toBeVisible();
    await expect(page.getByText('Gates are deterministic checks of one candidate', { exact: false })).toBeVisible();
    const bounds = await page.locator('.docs-shell').evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
    expect(bounds.content).toBeLessThanOrEqual(bounds.width);
  });
}

// The rendered diagrams and the glossary-driven pages must read on a phone as well as a desktop:
// every diagram loads as an image with its alt text, its legend is visible, and no page scrolls
// sideways. Nothing here touches the API.
for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`docs diagrams and glossary pages are accessible and fit the ${viewport.name} viewport`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const fits = async () => {
      const bounds = await page.locator('.docs-shell').evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth, page: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
      expect(bounds.content).toBeLessThanOrEqual(bounds.width);
      expect(bounds.page).toBeLessThanOrEqual(bounds.viewport);
    };
    const diagramsLoad = async (expected: number) => {
      const images = page.locator('img.docs-diagram');
      await expect(images).toHaveCount(expected);
      for (const image of await images.all()) {
        await image.scrollIntoViewIfNeeded();
        await expect(image).toBeVisible();
        expect((await image.getAttribute('alt'))?.length ?? 0).toBeGreaterThan(40);
        await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true);
        const geometry = await image.evaluate(element => { const img = element as HTMLImageElement; const box = img.getBoundingClientRect(); return { natural: img.naturalWidth, complete: img.complete, width: box.width, right: box.right, viewport: document.documentElement.clientWidth }; });
        expect(geometry.complete).toBe(true);
        expect(geometry.natural).toBeGreaterThan(0);
        expect(geometry.width).toBeGreaterThan(200);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
      }
    };

    await page.goto('/docs/how-graphyard-works');
    await expect(page.getByRole('heading', { name: 'How Graphyard works', level: 1 })).toBeVisible();
    await diagramsLoad(3);
    await expect(page.getByText('Text equivalent: in bootstrap the human operator supervises one worker', { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: 'legend', exact: true }).first()).toHaveAttribute('href', '/docs/glossary#diagram-legend');
    await fits();

    await page.goto('/docs/glossary');
    await expect(page.getByRole('heading', { name: 'Glossary', level: 1 })).toBeVisible();
    for (const term of ['1. Human operator (human authority)', '2. AI agent', '3. Agent session (Herdr-managed session or runtime)', '4. Principal, role, and credential', '5. Worker lease and worktree', '6. Independent reviewer and proof producer', '7. Graphyard control plane', '8. Herdr runtime']) {
      await expect(page.getByRole('heading', { name: term, level: 3 })).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: 'Diagram legend', level: 2 })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Amber rounded box' })).toBeVisible();
    await fits();

    await page.goto('/docs/operations');
    await expect(page.getByRole('heading', { name: 'Operations and recovery', level: 1 })).toBeVisible();
    for (const heading of ['Daily checklist', 'Incident decision tree', 'Recovery recipes', 'Safety facts that never change', 'Deeper references']) await expect(page.getByRole('heading', { name: heading, level: 2 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'lost worker' })).toHaveAttribute('href', '/docs/operations-reference#lost-worker-before-submission');
    await expect(page.getByRole('main').getByRole('link', { name: 'Operations reference', exact: true })).toHaveAttribute('href', '/docs/operations-reference');
    await expect(page.locator('img.docs-diagram')).toHaveCount(0);
    await fits();
  });
}

// The committed SVGs must read clearly at their native width: no two text elements may overlap,
// and no arrow label may cross a box outline. Measured with the browser's own text metrics.
for (const file of ['roles-and-authority', 'bootstrap-vs-normal', 'control-plane-components']) {
  test(`docs diagram ${file}.svg has no overlapping or clipped labels`, async ({ page }) => {
    const svg = readFileSync(new URL(`../docs/diagrams/${file}.svg`, import.meta.url), 'utf8');
    const [width, height] = svg.match(/viewBox="0 0 (\d+) (\d+)"/)!.slice(1).map(Number);
    await page.setViewportSize({ width, height });
    await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
    const report = await page.evaluate(() => {
      const bounds = (element: SVGGraphicsElement) => { const box = element.getBBox(); return { x: box.x, y: box.y, w: box.width, h: box.height }; };
      const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
        Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0;
      const texts = [...document.querySelectorAll('text')].map(text => ({ text: text.textContent?.trim() ?? '', ...bounds(text) })).filter(text => text.w > 0);
      const collisions: string[] = [];
      for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) if (overlap(texts[i], texts[j])) collisions.push(`${texts[i].text} / ${texts[j].text}`);
      // Boxes are every rect except the background; a label straddling an outline is neither inside nor clear of it.
      const boxes = [...document.querySelectorAll('rect')].slice(1).map(rect => bounds(rect)).filter(rect => rect.w > 60);
      const labels = [...document.querySelectorAll('text')].filter(text => text.getAttribute('fill') === '#b8c6b7').map(text => ({ text: text.textContent?.trim() ?? '', ...bounds(text) }));
      const clipped: string[] = [];
      for (const label of labels) for (const box of boxes) {
        const inside = label.x >= box.x && label.x + label.w <= box.x + box.w && label.y >= box.y && label.y + label.h <= box.y + box.h;
        if (!inside && overlap(label, box)) clipped.push(label.text);
      }
      return { textCount: texts.length, collisions, clipped, minX: Math.min(...texts.map(text => text.x)), maxX: Math.max(...texts.map(text => text.x + text.w)) };
    });
    expect(report.textCount).toBeGreaterThan(40);
    expect(report.collisions).toEqual([]);
    expect(report.clipped).toEqual([]);
    expect(report.minX).toBeGreaterThanOrEqual(0);
    expect(report.maxX).toBeLessThanOrEqual(width);
  });
}

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`dashboard durations use adaptive units with accessible text and no clipping on ${viewport.name}`, async ({ page }) => {
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60000).toISOString();
    const item = (key: string, stage: string, minutesAgo: number) => ({ ...work, id: `fixture-${key.toLowerCase()}`, key, stage, stageEnteredAt: at(minutesAgo) });
    const items = [item('GY-2', 'ready', 45), item('GY-3', 'review', 894), item('GY-4', 'review', 890), item('GY-5', 'build', 3060), item('GY-6', 'build', 3055)];
    await page.setViewportSize(viewport);
    await page.route('**/api/**', async route => {
      if (route.request().headers().authorization !== 'Bearer browser-fixture') return route.fulfill({ status: 401, json: { error: 'Rejected' } });
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/status')) return route.fulfill({ json: { actor: { id: 'fixture', role: 'admin' }, github: true, reviewProviders: ['github'], repository: 'fixture/repository', jobs: [] } });
      if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work: items, now: new Date().toISOString() } });
      if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus(items as any, Date.now(), null) });
      return route.fulfill({ json: [] });
    });
    await page.goto('/'); await login(page);
    // Every fixture item is handed in and waiting for review, so each is a Moving row with its
    // clock; the per-stage percentile strip went with the stage row (GY-161).
    await expect(page.locator('[data-group-section="moving"] .work-row')).toHaveCount(5);
    await expect(page.locator('.node')).toHaveCount(0);
    // The adaptive units on the rows themselves, where the duration is read rather than hovered:
    // every one of these fixtures has held its status for a while, so each says so.
    const age = (key: string) => row(page, key).locator('.status-age');
    await expect(age('GY-2')).toContainText('45m overdue');
    await expect(age('GY-3')).toContainText('14h 54m overdue');
    await expect(age('GY-5')).toContainText('2d 3h overdue');
    await expect(age('GY-6')).toContainText('2d 2h overdue');
    await expect(age('GY-2')).toHaveAttribute('title', 'In this status for 45m — longer than the 30m an item may hold one status before it counts as stopped');
    const clipped = await page.locator('.status-age').evaluateAll(nodes => nodes.map(element => element.scrollWidth > element.clientWidth + 1));
    expect(clipped).not.toContain(true);
  });
}

// GY-108: the board never said for how long, so an item waiting forty seconds looked exactly
// like one waiting fifty minutes. Every card now carries the time it has held its current status
// and says, in red and in words, when that is past the operator's thirty-minute threshold.
test('every moving row carries how long it has held its status, in red past thirty minutes, in the list and the item page', async ({ page }) => {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const item = (key: string, title: string, minutesAgo: number) => ({ ...work, id: `fixture-${key.toLowerCase()}`, key, title,
    createdAt: at(30 * 24 * 60), stageEnteredAt: at(minutesAgo) });
  const items = [item('GY-20', 'Just moved', 29), item('GY-21', 'Stopped moving', 31)];
  await page.route('**/api/**', async route => {
    if (route.request().headers().authorization !== 'Bearer browser-fixture') return route.fulfill({ status: 401, json: { error: 'Rejected' } });
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/status')) return route.fulfill({ json: { actor: { id: 'fixture', role: 'admin' }, github: true, reviewProviders: ['github'], repository: 'fixture/repository', jobs: [] } });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work: items, now: new Date().toISOString() } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus(items as any, Date.now(), null) });
    return route.fulfill({ json: [] });
  });
  await page.goto('/'); await login(page);
  const age = (key: string) => row(page, key).locator('.status-age');
  const colour = (key: string) => age(key).evaluate(element => getComputedStyle(element).color);
  const red = (value: string) => { const [r, g, b] = value.match(/\d+/g)!.map(Number); return r > g + 40 && r > b + 40; };
  // No control is pressed: the durations are on the untouched page, measured from when each item
  // entered its status rather than from the month-old creation date they share.
  await expect(age('GY-20')).toHaveText('29m');
  await expect(age('GY-21')).toContainText('31m overdue');
  expect(red(await colour('GY-21'))).toBe(true);
  expect(red(await colour('GY-20'))).toBe(false);
  // Red is never the only cue: the word survives greyscale and a screen reader, the triangle
  // beside it is decoration and is hidden from assistive technology, and the row is marked.
  await expect(age('GY-21').locator('.overdue-mark')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('.work-row.overdue')).toHaveCount(1);
  await expect(page.locator('.work-row.overdue')).toContainText('Stopped moving');
  // And so does the item page, from the same threshold. (The board view was removed by GY-161.)
  await row(page, 'GY-21').click();
  const drawer = itemPage(page, 'Stopped moving');
  await expect(drawer.locator('.status-age')).toContainText('31m overdue');
  expect(red(await drawer.locator('.status-age').evaluate(element => getComputedStyle(element).color))).toBe(true);
});

test('the work page shows one count row, the groups, each tile filtering to exactly its rows and nothing counted twice', async ({ page }) => {
  await fixture(page); await login(page);
  // The heading carries no count; the sidebar's Work entry carries no badge.
  await expect(workHeading(page)).toHaveText('Work');
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Work', exact: true })).toHaveText(/Work$/);
  await expect(page.getByRole('navigation', { name: 'Primary' }).locator('button small')).toHaveCount(0);
  await expect(page.locator('.stage-strip')).toHaveCount(0);
  const tiles = page.getByRole('group', { name: 'Filter by group' }).getByRole('button');
  await expect(tiles).toHaveCount(5);
  await expect(tiles.locator('.tile-label')).toHaveText(['Needs you', 'Blocked', 'Moving', 'Up next', 'Backlog']);
  await expect(tiles.locator('strong')).toHaveText(['0', '0', '1', '0', '0']);
  // Each count is its group's rows, and pressing a tile shows exactly those.
  await expect(page.locator('.work-row')).toHaveCount(1);
  await tiles.nth(2).click();
  await expect(tiles.nth(2)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.work-row')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Browser fixture' })).toBeVisible();
  await tiles.nth(1).click();
  await expect(page.locator('.work-row')).toHaveCount(0);
  await expect(tiles.locator('strong')).toHaveText(['0', '0', '1', '0', '0']);
  await page.getByRole('button', { name: 'Show every group' }).click();
  await expect(page.locator('.work-row')).toHaveCount(1);
});

test('invalid login remains on login; whitespace is trimmed and loading never claims empty work', async ({ page }) => {
  const state = await fixture(page);
  await login(page, 'invalid');
  await expect(page.getByRole('alert')).toContainText('rejected');
  await expect(page.getByLabel('Access token')).toBeVisible();
  await expect(workHeading(page)).toHaveCount(0);
  await expect(page.getByText('GitHub is not connected', { exact: false })).toHaveCount(0);
  state.pause = true; await login(page, '  browser-fixture  ');
  await expect(page.getByRole('status')).toContainText('Verifying');
  await expect(workHeading(page)).toBeVisible();
  await expect(page.getByText('fixture/repository')).toBeVisible();
});

test('connection loss labels stale data, recovers, and revoked sessions clear the dashboard', async ({ page }) => {
  const state = await fixture(page); await login(page);
  await expect(page.getByText(/^Live · updated/)).toBeVisible();
  state.offline = true;
  await expect(page.getByText(/^Disconnected · last updated/)).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('alert')).toContainText('stale');
  await expect(page.getByRole('heading', { name: 'Browser fixture' })).toBeVisible();
  state.offline = false;
  await expect(page.getByText(/^Live · updated/)).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('alert')).toHaveCount(0);
  state.unauthorized = true;
  await expect(page.getByLabel('Access token')).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('heading', { name: 'Browser fixture' })).toHaveCount(0);
});

test('mobile sign out is reachable and removes the session', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixture(page); await login(page);
  // The sidebar folds into the Menu button on a phone; sign-out is one tap inside it.
  await page.getByRole('button', { name: 'Menu' }).click();
  const signOut = page.getByRole('button', { name: 'Sign out' });
  await expect(signOut).toBeVisible(); await signOut.click();
  await expect(page.getByLabel('Access token')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('graphyard-token'))).toBeNull();
});

const pulseFixture = (overrides: Record<string, unknown> = {}) => ({ generatedAt: new Date().toISOString(), range: { start: '2026-06-29T00:00:00.000Z', end: new Date().toISOString(), weeks: 12, semantics: 'repository-utc-inclusive' }, completeness: 'complete', truncated: false, counts: { days7: 3, days30: 8 }, intentToMerge: { medianHours: 12.5, sampleSize: 7, excluded: 1 }, prToProduction: { averageHours: 30, medianHours: 24, p90Hours: 48, sampleSize: 6, eligible: 8, excluded: 2, coveragePercent: 75, sparse: false, exclusions: { 'no-verifiable-production-deployment': 2 }, split: { prToMergeAverageHours: 18, mergeToProductionAverageHours: 12 } }, weeks: Array.from({ length: 12 }, (_, index) => ({ start: new Date(Date.UTC(2026, 5, 29 + index * 7)).toISOString(), end: new Date(Date.UTC(2026, 6, 5 + index * 7)).toISOString(), count: index % 4 })), recent: [{ key: 'GY-9', title: 'Exact delivery', pullRequest: 42, mergeSha: 'abcdef1234567890abcdef1234567890abcdef12', mergedAt: '2026-09-15T12:00:00.000Z', quality: { passingProofs: 4, requiredProofs: 4, violations: [] } }], ...overrides });

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) test(`shipping pulse exposes exact metrics, links and chart text on ${viewport.name}`, async ({ page }) => {
  await page.setViewportSize(viewport); await fixture(page);
  await page.route('**/api/shipping-pulse', route => route.fulfill({ json: pulseFixture() }));
  await login(page); await openInsightsDetails(page);
  await expect(page.getByRole('heading', { name: 'Shipping pulse' })).toBeVisible();
  await expect(page.getByLabel('Delivery metrics')).toContainText('3');
  await expect(page.getByText('12.5h')).toBeVisible(); await expect(page.getByText('7 included · 1 excluded')).toBeVisible();
  await expect(page.getByLabel('Pull request to production metrics')).toContainText('30h');
  await expect(page.getByText('6 included of 8')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Weekly delivery counts' }).getByRole('listitem')).toHaveCount(12);
  await expect(page.getByRole('link', { name: /PR #42/ })).toHaveAttribute('href', 'https://github.com/fixture/repository/pull/42');
  await expect(page.getByRole('link', { name: /Commit abcdef12/ })).toHaveAttribute('href', 'https://github.com/fixture/repository/commit/abcdef1234567890abcdef1234567890abcdef12');
  // Deployment times are the provider's clock carried onto the repository clock with the
  // bracket the collector measured. The method note must say that rather than describe the
  // durations as exact, which would overstate values known only to that precision.
  await expect(page.locator('.pulse-method')).toContainText('carried onto the repository clock at ingestion using the offset bracket the collector measured');
  await expect(page.getByText('EXACT VERIFIED CONTAINMENT')).toHaveCount(0);
  const shell = page.locator('.shell'); expect((await shell.evaluate(element => element.scrollWidth <= element.clientWidth))).toBe(true);
});

test('shipping pulse labels sparse and unavailable production samples without fabricating zero', async ({ page }) => {
  await fixture(page);
  // The second delivery's authorizing snapshot cannot be resolved, so its proof totals are
  // unknown. An unknown total must never be drawn as 0/0, which would read as a clean record.
  const unresolved = { key: 'GY-10', title: 'Unretained authorization', pullRequest: 43, mergeSha: 'bcdef01234567890abcdef1234567890abcdef12', mergedAt: '2026-09-14T12:00:00.000Z', quality: { passingProofs: null, requiredProofs: null, violations: [], unavailableReason: 'The immutable snapshot that authorized this delivery is no longer in the retained ledger, so recorded proof totals are unknown.' } };
  await page.route('**/api/shipping-pulse', route => route.fulfill({ json: pulseFixture({ prToProduction: { averageHours: null, medianHours: null, p90Hours: null, sampleSize: 0, eligible: 1, excluded: 1, coveragePercent: 0, sparse: true, exclusions: { 'no-verifiable-production-deployment': 1 }, split: { prToMergeAverageHours: null, mergeToProductionAverageHours: null } }, recent: [...pulseFixture().recent, unresolved] }) }));
  await login(page); await openInsightsDetails(page);
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
  await login(page); await openInsightsDetails(page);
  await expect(page.getByRole('status').filter({ hasText: 'Loading shipping pulse' })).toBeVisible();
  mode = 'unavailable'; release(); await expect(page.getByRole('alert').filter({ hasText: 'Shipping pulse unavailable' })).toContainText('unavailable');
  mode = 'empty'; await openWork(page); await openInsightsDetails(page);
  await expect(page.getByText('No deliveries in this window')).toBeVisible(); await expect(page.getByLabel('Delivery metrics')).toHaveCount(0);
  mode = 'partial'; await openWork(page); await openInsightsDetails(page);
  await expect(page.getByText('Partial history.')).toBeVisible(); await expect(page.getByText('More production observations matched a merge than the query cap reads.')).toBeVisible();
  // Partial at the production cap does not truncate the delivery sample, so the durations
  // are not labelled as sampled here; only the delivery cap does that.
  await expect(page.getByText('Sampled durations:')).toHaveCount(0);
  // Staleness is measured from this browser's own last successful read, so it appears
  // when a refresh fails while data is on screen - never from a repository/browser clock gap.
  mode = 'unavailable'; await pulse(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('Data is stale.')).toBeVisible();
  await expect(page.getByText('Partial history.')).toBeVisible();
});

test('truncated history labels durations as newest-delivery samples, never as bounds', async ({ page }) => {
  await fixture(page);
  // The delivery cap makes counts lower bounds but leaves the durations a sample of the
  // newest work, so every duration group must say so rather than read as a bound.
  await page.route('**/api/shipping-pulse', route => route.fulfill({ json: pulseFixture({ completeness: 'partial', truncated: true, partialReason: 'More than 1000 exact deliveries occurred in the bounded window; only the newest 1000 were read. The counts are lower bounds. The durations are not bounds.' }) }));
  await login(page); await openInsightsDetails(page);
  await expect(page.getByText('Partial history.')).toBeVisible();
  await expect(page.getByText('The counts are lower bounds. The durations are not bounds.')).toBeVisible();
  const sampled = page.getByText('Sampled durations:');
  await expect(sampled).toHaveCount(2);
  await expect(sampled.first()).toContainText('they are not lower bounds');
});

test('the analytics pages are not offered to operator agents whose scoped API cannot serve them, nor are their routes read', async ({ page }) => {
  const analytics: string[] = [];
  page.on('request', request => { if (/\/api\/analytics\//.test(request.url())) analytics.push(request.url()); });
  await fixture(page, 'operator-agent'); await login(page);
  const primary = page.getByRole('navigation', { name: 'Primary' });
  await expect(primary.getByRole('button', { name: 'Work', exact: true })).toBeVisible();
  // Insights reads analytics/flow*, and it is the section's one page (GY-168), so the entry is gone.
  await expect(primary.getByRole('button', { name: 'Insights', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Shipping pulse|Flow analytics/ })).toHaveCount(0);
  expect(analytics).toEqual([]);
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
test('both dialogs move, trap, and restore focus and close with Escape; an item page is left with Back or Escape', async ({ page }) => {
  const state = await fixture(page); await login(page);
  // The item is a page (GY-161), not a dialog: it takes focus on its Back control and Escape returns to the list.
  await cardSelect(page).click();
  await expect(itemPage(page, 'Browser fixture')).toBeVisible();
  await expect(page.getByRole('button', { name: '← Back' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(workHeading(page)).toBeVisible();
  await cardSelect(page).click(); await page.getByRole('button', { name: '← Back' }).click();
  await expect(workHeading(page)).toBeVisible();
  await checkDialog(page, page.getByRole('button', { name: '＋ New work item' }));
  await openPage(page, 'Settings', 'Test cases');
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
  await openPage(page, 'Settings', 'Test cases');
  await expect(page.getByRole('heading', { name: 'Test-case library' })).toBeVisible();
  await expect(page.getByRole('button', { name: '＋ New test case' })).toHaveCount(0);
});

test('slice view names leads, workers, reviewers and bottlenecks and labels each session kind from data', async ({ page }) => {
  await fixture(page); await login(page);
  // Who works on what lives on the Workers page (GY-161).
  await sidebarEntry(page, 'Workers');
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
  // The signed-in summary names who and in which role, and carries no session-kind badge (GY-161, AC-10).
  const session = page.locator('.sidebar-bottom');
  await expect(session).toContainText('fixture · admin');
  await expect(session.locator('.identity')).toHaveCount(0);
});

test('an AI session is named in the signed-in summary without a session-kind badge', async ({ page }) => {
  await fixture(page, 'worker'); await login(page);
  const session = page.locator('.sidebar-bottom');
  await expect(session).toContainText('fixture · worker');
  await expect(session.locator('.identity')).toHaveCount(0);
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
  await expect(workHeading(page)).toHaveCount(0);
  rejectLogin();
  await expect(page.getByRole('alert')).toContainText('rejected');
  await expect(page.getByLabel('Access token')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Browser fixture' })).toHaveCount(0);
  await expect(workHeading(page)).toHaveCount(0);
});

 test('polling retains loaded history when an event refresh fails', async ({ page }) => {
  await fixture(page); let eventReads = 0;
  await page.route('**/api/events**', route => {
    eventReads++;
    return eventReads === 1 ? route.fulfill({ json: [{ seq: 1, kind: 'fixture-created', actor: 'fixture', created_at: '2026-01-01T00:00:00Z' }] }) : route.fulfill({ status: 503, json: { error: 'History temporarily unavailable' } });
  });
  await login(page); await cardSelect(page).click(); await fullHistory(page);
  await expect(itemPage(page).getByText('fixture-created', { exact: true })).toBeVisible();
  await expect.poll(() => eventReads, { timeout: 10000 }).toBeGreaterThan(1);
  await expect(itemPage(page).getByText('fixture-created', { exact: true })).toBeVisible();
 });

test('history groups observation noise and bounds expanded rows without losing other events', async ({ page }) => {
  await fixture(page);
  const events = Array.from({ length: 60 }, (_, i) => ({ seq: 60 - i, kind: i < 40 ? 'github.observed' : `work.event-${i}`, actor: 'github', created_at: new Date(Date.UTC(2026, 0, 1, 0, 60 - i)).toISOString() }));
  await page.route('**/api/events**', route => route.fulfill({ json: events }));
  await login(page); await cardSelect(page).click(); await fullHistory(page);
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
  await login(page);await cardSelect(page).click();await editMenu(page);
  await expect(page.getByRole('button',{name:'Use Codex cloud review'})).toBeDisabled();
  await expect(page.getByText(/Codex review is unavailable/)).toBeVisible();
  await page.getByRole('button',{name:'← Back'}).click();await page.getByRole('button',{name:'New work item'}).click();
  expect(await page.locator('option[value="codex"]').evaluate((e:HTMLOptionElement)=>e.disabled)).toBe(true);
 });

 test('lease activity uses the work snapshot time despite a later status response', async ({page}) => {
  await fixture(page);
  const assigned={...work,lease:{owner:'worker-a',epoch:1,expiresAt:'2026-01-01T00:01:00Z'},lastAssignment:{owner:'worker-a',epoch:1,displayName:'Atlas',runtime:'Codex'}};
  await page.route('**/api/work-snapshot',route=>route.fulfill({json:{work:[assigned],now:'2026-01-01T00:00:00Z'}}));
  await page.route('**/api/status',route=>route.fulfill({json:{actor:{id:'fixture',role:'reader'},github:true,jobs:[],now:'2026-01-01T00:02:00Z'}}));
  // The item view names the active worker; a lapsed lease would read "Last worked by".
  await login(page);await cardSelect(page).click();await technicalDetails(page);const owner=itemPage(page).locator('.assignment-details');
  await expect(owner).toHaveText('Atlas · Codex');await expect(owner).not.toContainText('Last worked by');
 });

 test('maximum-length agent labels fit the work rows and remain available in details', async ({page}) => {
  await fixture(page);
  const displayName='A'.repeat(100),runtime='R'.repeat(80),identity=`${displayName} · ${runtime}`;
  const assigned={...work,lease:{owner:'worker-a',epoch:1,expiresAt:'2026-01-01T00:01:00Z'},lastAssignment:{owner:'worker-a',epoch:1,displayName,runtime}};
  await page.route('**/api/work-snapshot',route=>route.fulfill({json:{work:[assigned],now:'2026-01-01T00:00:00Z'}}));
  await login(page);
  // The row names the role that acts next, never the agent's label, so a long label cannot overflow it.
  const card=page.locator('.work-row').first();
  const bounds=await card.evaluate(e=>({card:e.clientWidth,content:e.scrollWidth}));
  expect(bounds.content).toBeLessThanOrEqual(bounds.card);
  await expect(card).not.toContainText(displayName);
  await card.click();await technicalDetails(page);const details=itemPage(page).locator('.assignment-details');
  await expect(details).toHaveText(identity);
  await expect(itemPage(page)).toContainText('Worker ID: worker-a');
  expect(await details.evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
 });

test('scenario loading, failure, retry and real empty library are distinct', async ({ page }) => {
  await fixture(page); let release: () => void = () => {}; let failing = true;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/scenarios', async route => {
    await pending;
    return route.fulfill(failing ? { status: 503, json: { error: 'Runner catalog unavailable' } } : { json: [] });
  });
  await login(page); await openPage(page, 'Settings', 'Test cases');
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
  await login(page); await openPage(page, 'Settings', 'Test cases');
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
  await login(page); await openPage(page, 'Settings', 'Test cases');
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
  await login(page); await openPage(page, 'Settings', 'Test cases');
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
  await login(page); await openPage(page, 'Settings', 'Test cases');
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
  await login(page); await openPage(page, 'Settings', 'Test cases');
  await expect(page.getByText('Describe the behavior you need to prove.')).toBeVisible();
  await publishCase(page, 'rejected-case');
  await expect(page.getByRole('alert')).toContainText('Stable ID exceeds 100 characters');
  await page.getByRole('button', { name: 'Close form' }).click();
  reject = false; await page.getByRole('button', { name: '＋ New test case' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('work details explain missing proof and operator can revise explicit criteria', async ({ page }) => {
  const state = await fixture(page); await login(page);
  await cardSelect(page).click();
  await expect(itemPage(page).locator('.marker-pending')).toContainText('manual:browser pending');
  await technicalDetails(page);
  await expect(page.getByText('AC-1 · manual:browser · unmeasured')).toBeVisible();
  await editMenu(page);
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

test('releases view labels verification precisely, shows membership and reports failures honestly', async ({ page }) => {
  await fixture(page); let fail = true;
  const release = { id: 'release-1', revision: 1, environment: { id: 'production', revision: 1 }, sourceSha: 'a'.repeat(40), buildId: 'build', manifest: [{ service: 'api', digest: `sha256:${'1'.repeat(64)}` }], manifestHash: 'h', createdAt: '2026-01-01T00:00:00Z', createdBy: 'operator',
    members: [{ workId: work.id, key: 'GY-1', mergeSha: 'e'.repeat(40), included: true }, { workId: 'other', key: 'GY-2', mergeSha: 'f'.repeat(40), included: false, note: 'Reverted' }] };
  const environment = { environmentId: 'production', generation: 2, expected: { releaseId: 'release-1', releaseRevision: 1, manifestHash: 'h', buildId: 'build', policyRevision: 1, approvalId: null, selectedAt: '2026-01-01T00:00:00Z', selectedBy: 'operator' },
    history: [{ generation: 1, releaseId: 'release-0', releaseRevision: 1, policyRevision: 1, selectedAt: '2025-12-31T00:00:00Z', selectedBy: 'operator', outcome: 'verified', verifiedAt: '2025-12-31T00:10:00Z', supersededAt: '2026-01-01T00:00:00Z' }, { generation: 2, releaseId: 'release-1', releaseRevision: 1, policyRevision: 1, selectedAt: '2026-01-01T00:00:00Z', selectedBy: 'operator', outcome: 'selected' }],
    coverage: {}, verification: { generation: 2, status: 'mismatched', reasons: ['Instance api-1 of api runs sha256:ffff instead of sha256:1111'], interval: null, evaluatedAt: '2026-01-01T00:01:00Z', verifiedAt: null },
    incidents: [{ id: 'incident', generation: 1, releaseId: 'release-0', releaseRevision: 1, at: '2025-12-31T01:00:00Z', observationId: 'obs', reasons: ['Instance api-1 of api is unhealthy'] }], cursor: 9, lastNotification: { at: '2026-01-01T00:00:30Z', provider: 'railway', payloadHash: 'x' } };
  const rollback = { id: 'rollback-1', environmentId: 'production', environmentRevision: 1, generation: 2, failed: { releaseId: 'release-0', releaseRevision: 1, generation: 1, manifestHash: 'g', incidentIds: ['incident'] }, target: { releaseId: 'release-1', releaseRevision: 1, manifestHash: 'h', approvalId: null, verifiedAt: '2025-12-30T00:00:00Z' },
    reason: 'Incident', automatic: true, requestedBy: 'graphyard', requestedAt: '2026-01-01T00:00:00Z', repairWorkId: null, state: 'applied', verifiedAt: null, interval: null, history: [],
    operation: { id: 'op-12345678', registration: { id: 'rollback', revision: 1 }, principal: 'railway-rollback', epoch: 1, fencing: 'provider', claimedAt: '2026-01-01T00:00:10Z', precondition: { environment: 'production', generation: 2, expectedRunning: 'g', token: 't' }, outcome: 'applied', settledAt: '2026-01-01T00:00:40Z', providerOperationId: 'dep-9', detail: null, resolvedBy: null, evidence: null, reports: [] } };
  await page.route('**/api/delivery', route => route.fulfill(fail ? { status: 503, json: { error: 'Delivery state unavailable' } } : { json: { environments: [environment], releases: [release], rollbacks: [rollback], now: '2026-01-01T00:02:00Z' } }));
  await login(page); await openPage(page, 'Shipped', 'Releases');
  await expect(page.getByRole('heading', { name: 'Releases', level: 1 })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Delivery state unavailable');
  await expect(page.getByText('No release selected yet.')).toHaveCount(0);
  fail = false; await page.getByRole('button', { name: 'Retry loading releases' }).click();
  const card = page.locator('.scenario-card'); await expect(card).toHaveCount(1);
  await expect(card).toContainText('production · generation 2');
  await expect(card).toContainText('Running artifacts differ from the expected release');
  await expect(card).toContainText('Instance api-1 of api runs sha256:ffff instead of sha256:1111');
  await expect(card).toContainText('✓ GY-1 · merge eeeeeeee');
  await expect(card).toContainText('× GY-2 · merge ffffffff · excluded (reverted) · Reverted');
  await expect(card).toContainText('Incidents (1)');
  await expect(card).toContainText('Rollbacks (1)');
  await expect(card).toContainText('release-0 r1 → release-1 r1 · applied · automatic · operation op-12345 by railway-rollback (provider fencing, applied) · provider applied it; not complete until the target is observed and verified');
  await expect(card).toContainText('a hint to observe again, not proof');
  await card.getByText('Selection history (2)').click();
  await expect(card).toContainText('Generation 1 · release-0 r1 · verified');
  await expect(card).toContainText('Generation 2 · release-1 r1 · selected');
  await expect(page.getByText('Verified in production')).toHaveCount(0);
});

test('validation view reports failures honestly and bounds request history', async ({ page }) => {
  await fixture(page); let fail = true;
  const requests = Array.from({ length: 25 }, (_, i) => ({ id: `request-${i}`, workId: work.id, proof: 'e2e:behavior', candidateId: 'candidate', runner: { id: 'runner' }, collector: { id: 'collector' }, state: 'expired', attempts: [{ id: `attempt-${i}`, epoch: 1, state: 'expired', settled: false, dispatchedAt: '2026-01-01T00:00:00Z' }], maxAttempts: 2, deadline: '2026-01-01T01:00:00Z', createdAt: '2026-01-01T00:00:00Z' }));
  let olderReads = 0;
  await page.route('**/api/validation*', route => {
    const older = new URL(route.request().url()).searchParams.has('cursor'); if (older) olderReads++;
    return route.fulfill(fail ? { status: 503, json: { error: 'Validation unavailable' } } : { json: { candidates: [], requests: older ? requests.slice(20) : requests.slice(0,20), nextCursor: older ? null : 'page-two' } });
  });
  await login(page); await openPage(page, 'Shipped', 'Validation');
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

test('merge queue shows each entry with its position in line, and its predicted tip under Technical details', async ({ page }) => {
  const enqueuedAt = new Date(Date.now() - 45 * 60_000).toISOString();
  const headSha = 'a'.repeat(40), baseSha = 'b'.repeat(40), tipSha = 'c'.repeat(40);
  const entry = (overrides: Record<string, unknown>) => ({ ...work, stage: 'merge', evidence: [], observation: null, ...overrides });
  const head = entry({ id: 'queue-head', key: 'GY-10', title: 'Head of the queue', candidate: { pr: 10, sha: headSha, baseSha, branch: 'graphyard/gy-10-1', author: 'worker' },
    observation: { baseTip: baseSha, candidate: { sha: headSha, baseSha } }, gates: [{ name: 'merge', passed: true, reasons: [] }],
    queue: { sequence: 1, enqueuedAt, policyRevision: 1, speculation: { ref: 'refs/graphyard/queue/gy-10', tip: headSha, base: baseSha, baseTree: 'e'.repeat(40), predecessors: [], policyRevision: 1, publishedAt: enqueuedAt } } });
  const next = entry({ id: 'queue-next', key: 'GY-11', title: 'Behind the head', candidate: { pr: 11, sha: tipSha, baseSha: headSha, branch: 'graphyard/gy-11-1', author: 'worker' },
    observation: { baseTip: baseSha, candidate: { sha: tipSha, baseSha: headSha } }, gates: [{ name: 'merge', passed: false, reasons: ['Merge queue position 2 of 2: GY-10 is ahead'] }],
    queue: { sequence: 2, enqueuedAt, policyRevision: 1, speculation: { ref: 'refs/graphyard/queue/gy-11', tip: tipSha, base: headSha, baseTree: 'd'.repeat(40), predecessors: ['GY-10'], policyRevision: 1, publishedAt: enqueuedAt } } });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path.endsWith('/status') ? { actor: { id: 'fixture', role: 'admin' }, github: true, reviewProviders: ['github'], repository: 'fixture/repository', jobs: [] }
      : path.endsWith('/work-snapshot') ? { work: [head, next], now: new Date().toISOString() } : path.endsWith('/work') ? [head, next]
      : path.endsWith('/board') ? boardFromStatus([head, next] as any, Date.now(), null) : [] });
  });
  await page.goto('/'); await login(page);
  // GY-161: the queue is the Merge step of each moving row, in plain words, with the row's own clock.
  await expect(row(page, 'GY-10').locator('.steps-label')).toHaveText('Merging · Graphyard is merging it');
  await expect(row(page, 'GY-11').locator('.steps-label')).toHaveText('Merging · 2nd in line, after GY-10');
  for (const key of ['GY-10', 'GY-11']) {
    await expect(row(page, key).locator('[data-step="merge"]')).toHaveAttribute('data-state', 'current');
    await expect(row(page, key).locator('.status-age')).toHaveCount(1);
  }
  await row(page, 'GY-11').click();
  // The item page says where it is in line; the predicted base and tip are under Technical details.
  const drawer = itemPage(page, 'Behind the head');
  await expect(drawer.locator('.status-sentence')).toHaveText('Merging · 2nd in line, after GY-10.');
  await technicalDetails(page);
  await expect(drawer.getByRole('heading', { name: 'Merge queue' })).toBeVisible();
  await expect(drawer).toContainText('Position 2 of 2');
  await expect(drawer).toContainText(`Predicted base ${headSha.slice(0, 8)}`);
  await expect(drawer).toContainText(`predicted tip ${tipSha.slice(0, 8)}`);
  await expect(drawer).toContainText('Merge queue position 2 of 2: GY-10 is ahead');
  await expect(drawer).toContainText('refs/graphyard/queue/gy-11');
});

const prHref = 'https://github.com/fixture/repository/pull/1', commitHref = `https://github.com/fixture/repository/commit/${work.candidate!.sha}`;
const cardPrLink = (page: Page) => page.getByRole('link', { name: 'PR #1, open pull request for GY-1 in GitHub' });
const detailPrLink = (page: Page) => itemPage(page).getByRole('link', { name: 'PR #1, open pull request for GY-1 in GitHub' });
// A commit reads as its first eight characters (GY-168); the whole SHA is its title and link.
const shortSha = work.candidate!.sha.slice(0, 8);
const detailShaLink = (page: Page) => itemPage(page).getByRole('link', { name: `${shortSha}, open commit for GY-1 in GitHub` });
// The accent token (web/style.css --accent, the approved #c5e69b).
const focusRing = { outlineStyle: 'solid', outlineWidth: '2px', outlineColor: 'rgb(197, 230, 155)' };
const outline = (target: Locator) => target.evaluate(e => { const s = getComputedStyle(e); return { outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, outlineColor: s.outlineColor }; });
// An interactive element nested inside a button (or ARIA button) may be exposed as
// presentational content, so the dashboard must never nest one.
const nestedInteractives = (page: Page) => page.evaluate(() => [...document.querySelectorAll('button, [role="button"]')].flatMap(host =>
  [...host.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"], [tabindex]')].map(child => `${host.tagName}.${host.className} > ${child.tagName}.${child.className}`)));

test('card and ownership candidate references link to the exact PR and commit in the configured repository', async ({ page }) => {
  const state = await fixture(page); await login(page);
  await page.route('https://github.com/**', route => route.fulfill({ body: 'GitHub destination stub' }));
  const cardLink = cardPrLink(page);
  await expect(cardLink).toHaveAttribute('href', prHref);
  await expect(cardLink).toContainText('PR #1');
  await expect(cardLink).toHaveAttribute('target', '_blank');
  await expect(cardLink).toHaveAttribute('rel', 'noopener noreferrer');
  const [popup] = await Promise.all([page.waitForEvent('popup'), cardLink.click()]);
  expect(popup.url()).toBe(prHref); await popup.close();
  await expect(itemPage(page)).toHaveCount(0);
  await cardSelect(page).click();
  const dialog = itemPage(page);
  await expect(detailPrLink(page)).toHaveAttribute('href', prHref);
  const shaLink = detailShaLink(page);
  await expect(shaLink).toHaveAttribute('href', commitHref);
  for (const link of [detailPrLink(page), shaLink]) {
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  }
  await expect(shaLink.locator('code')).toHaveText(shortSha);
  await expect(shaLink.locator('code')).toHaveAttribute('title', work.candidate!.sha);
  // The pull request is linked once, in the page header.
  await expect(dialog.locator('.pr-button')).toContainText('PR #1');
  await expect(dialog.getByRole('link', { name: /open pull request/ })).toHaveCount(1);
  const [commitPopup] = await Promise.all([page.waitForEvent('popup'), shaLink.click()]);
  expect(commitPopup.url()).toBe(commitHref); await commitPopup.close();
  expect(state.writes).toBe(0);
});

test('the card selection control and the candidate PR link are sibling interactive elements', async ({ page }) => {
  await fixture(page); await login(page);
  const cardLink = cardPrLink(page);
  await expect(cardLink).toBeVisible();
  await expect(cardSelect(page)).toBeVisible();
  // The link must not sit inside the selection control, and no card may claim the
  // button role around it: nested interactives can be hidden from assistive tech.
  expect(await cardLink.evaluate(e => e.closest('button, [role="button"]') !== null)).toBe(false);
  expect(await page.locator('.work-row').first().evaluate(e => e.getAttribute('role'))).toBe(null);
  expect(await nestedInteractives(page)).toEqual([]);
  await cardSelect(page).click();
  await expect(detailPrLink(page)).toBeVisible();
  expect(await detailPrLink(page).evaluate(e => e.closest('button, [role="button"]') !== null)).toBe(false);
  expect(await detailShaLink(page).evaluate(e => e.closest('button, [role="button"]') !== null)).toBe(false);
  expect(await nestedInteractives(page)).toEqual([]);
});

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`candidate references keep keyboard access, focus treatment, and selection on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await fixture(page); await login(page);
    const cardLink = cardPrLink(page);
    await expect(cardLink).toBeVisible();
    const select = cardSelect(page);
    // Reach the control the way a keyboard user does, so :focus-visible applies.
    await select.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    await expect(select).toBeFocused();
    expect(await outline(select)).toEqual(focusRing);
    await page.keyboard.press('Tab');
    await expect(cardLink).toBeFocused();
    expect(await outline(cardLink)).toEqual(focusRing);
    await select.focus(); await page.keyboard.press('Enter');
    const dialog = itemPage(page); await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: '← Back' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(detailPrLink(page)).toBeFocused();
    expect(await outline(detailPrLink(page))).toEqual(focusRing);
    // The commit is in the pull request panel; the requirement's proof names between them are keyboard stops too.
    for (let stop = 0; stop < 8 && !await detailShaLink(page).evaluate(e => e === document.activeElement); stop++) await page.keyboard.press('Tab');
    await expect(detailShaLink(page)).toBeFocused();
    expect(await outline(detailShaLink(page))).toEqual(focusRing);
    // Linking the SHA must not turn it into an unreadable widget: the text stays
    // selectable with the ordinary gestures, and the whole SHA is its title.
    await page.route('https://github.com/**', route => route.fulfill({ body: 'GitHub destination stub' }));
    const shaText = detailShaLink(page).locator('code');
    expect(await shaText.evaluate(e => getComputedStyle(e).userSelect)).toBe('text');
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await expect(shaText).toHaveText(shortSha);
    await expect(shaText).toHaveAttribute('title', work.candidate!.sha);
    // A wrapped SHA would break the drag gesture below and hide characters on mobile.
    expect(await shaText.evaluate(e => e.getClientRects().length)).toBe(1);
    await shaText.dblclick();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(shortSha);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    const shaBox = (await shaText.boundingBox())!;
    await page.mouse.move(shaBox.x - 3, shaBox.y + shaBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(shaBox.x + shaBox.width + 3, shaBox.y + shaBox.height / 2, { steps: 10 });
    expect(await page.evaluate(() => window.getSelection()?.toString())).toContain(shortSha);
    await page.mouse.up();
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
    await expect(page.locator('.work-row').first()).toBeVisible();
    await select.focus(); await page.keyboard.press('Enter');
    await expect(itemPage(page)).toBeVisible();
    await expect(itemPage(page).getByRole('link', { name: 'PR #1, open pull request for GY-1 in GitHub' })).toBeVisible();
  });
}

test('an unconfigured GitHub repository renders candidate references as non-link text', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/status', route => route.fulfill({ json: { actor: { id: 'fixture', role: 'admin' }, github: false, reviewProviders: ['github'], repository: null, jobs: [] } }));
  await login(page);
  await expect(cardPrLink(page)).toHaveCount(0);
  await expect(page.locator('.card-pr').getByText('PR #1', { exact: true })).toBeVisible();
  await cardSelect(page).click();
  const dialog = itemPage(page);
  await expect(dialog.locator('.pr-button').getByText('PR #1', { exact: true })).toBeVisible();
  await expect(dialog.getByText(shortSha, { exact: true })).toBeVisible();
  await expect(dialog.getByRole('link', { name: /open pull request|open commit/ })).toHaveCount(0);
});

test('legacy abbreviated SHAs and invalid candidate references never become links', async ({ page }) => {
  await fixture(page);
  const cases = [
    { candidate: { pr: 1, sha: 'abcdef123456' }, shaText: 'abcdef12', prHref, commitHref: null },
    { candidate: { pr: 0, sha: work.candidate!.sha }, shaText: shortSha, prHref: null, commitHref },
    { candidate: { pr: 1, sha: 'not-a-sha' }, shaText: 'not-a-sha', prHref, commitHref: null }];
  for (const { candidate, shaText, prHref: expectedPr, commitHref: expectedCommit } of cases) {
    await page.route('**/api/work-snapshot', route => route.fulfill({ json: { work: [{ ...work, candidate }], now: '2026-01-01T00:00:00Z' } }));
    await login(page);
    await expect(page.locator('.work-row').getByRole('link', { name: /open pull request/ })).toHaveCount(expectedPr ? 1 : 0);
    if (expectedPr) await expect(page.locator('.work-row').getByRole('link', { name: /open pull request/ })).toHaveAttribute('href', expectedPr);
    await cardSelect(page).click();
    const dialog = itemPage(page);
    await expect(dialog.getByText(shaText, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('link', { name: /open pull request/ })).toHaveCount(expectedPr ? 1 : 0);
    await expect(dialog.getByRole('link', { name: /open commit/ })).toHaveCount(expectedCommit ? 1 : 0);
    if (expectedCommit) await expect(dialog.getByRole('link', { name: /open commit/ })).toHaveAttribute('href', expectedCommit);
    await page.getByRole('button', { name: '← Back' }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
  }
  await page.route('**/api/work-snapshot', route => route.fulfill({ json: { work: [{ ...work, candidate: null }], now: '2026-01-01T00:00:00Z' } }));
  await login(page);
  await expect(page.locator('.work-row').getByRole('link')).toHaveCount(0);
  await expect(page.locator('.work-row .status-line')).toBeVisible();
});

test('proof authority shows the live grant set, its source, and unproducible required proof', async ({ page }) => {
  await fixture(page); await login(page);
  await openPage(page, 'Settings', 'Proof authority');
  await expect(page.getByRole('heading', { name: 'Proof authority' })).toBeVisible();
  // The fixture item requires manual:browser, which the operator role covers, so the only
  // honest report is that nothing is unproducible.
  await expect(page.getByText('Every required proof name has at least one authorized producer.')).toBeVisible();
  await expect(page.getByText('ci · integration:*')).toBeVisible();
  await expect(page.getByText(/Source: Graphyard grant record .* revision 3 .* CI produces integration proof/)).toBeVisible();
  await expect(page.getByText(/bootstrap seed only/)).toBeVisible();
});

test('an operator grants authority through the dashboard and a reader cannot', async ({ page }) => {
  const state = await fixture(page); await login(page);
  await openPage(page, 'Settings', 'Proof authority');
  let body: any;
  await page.route('**/api/proof-grants/acceptance/grant', async route => { body = route.request().postDataJSON(); await route.fulfill({ json: proofGrants.grants[0] }); });
  const form = page.locator('form.grant-form').first();
  await form.getByLabel('Producer principal').fill('acceptance');
  await form.getByLabel('Patterns', { exact: true }).fill('manual:gy-43/*, unit:*');
  await form.getByLabel('Audit reason').fill('Designated acceptance witness');
  await form.getByRole('button', { name: 'Grant authority' }).click();
  await expect.poll(() => body).toBeTruthy();
  expect(body).toEqual({ patterns: ['manual:gy-43/*', 'unit:*'], reason: 'Designated acceptance witness' });
  expect(state.writes).toBe(0);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await fixture(page, 'reader'); await login(page);
  await openPage(page, 'Settings', 'Proof authority');
  await expect(page.getByText('ci · integration:*')).toBeVisible();
  await expect(page.locator('form.grant-form')).toHaveCount(0);
});
