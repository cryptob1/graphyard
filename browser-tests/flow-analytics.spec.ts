import { test, expect, type Page } from '@playwright/test';
import { computeFlow, deriveFacts, flowDrilldown, flowExport, type FlowDataset, type FlowFact, type LedgerEvent, type ProjectionState } from '../src/flow-analytics';
import { computeAttribution, type AttributionDataset } from '../src/attribution';
import type { Work } from '../src/model';
import { stepIds } from '../src/model/pr-steps';
import { formatDuration } from '../src/model/duration';
import { NOW, boardApi, boardWork } from './ui-board';

// Browser-only fixtures. The report is computed by the real aggregation from synthetic
// ledger events, so the page is exercised against the exact payload the API produces.
const day = 86_400_000;
const observedAt = Date.now();
const head = 'a'.repeat(40), base = 'b'.repeat(40);
let sequence = 0;

function snapshot(key: string, at: number, overrides: Partial<Work>): Work {
  return {
    id: `work-${key}`, key, title: `Fixture ${key}`, description: '', type: 'feature', priority: 2,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Observable behavior', proofs: ['integration:flow'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], scenarioRequirements: [],
    stage: 'build', revision: 1, policyRevision: 1, createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(),
    stageEnteredAt: new Date(at).toISOString(), ready: true, epoch: 1, lease: null, workspaces: [], candidate: null,
    submission: null, reworkRequested: false, evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }],
    violations: [], ...overrides,
  } as Work;
}
function event(work: Work, at: number, kind: string): LedgerEvent {
  return { seq: ++sequence, work_id: work.id, actor: 'fixture', kind, payload: { work }, created_at: new Date(at).toISOString() };
}
function observation(work: Work, at: number, reviews: any[], merged = false) {
  return {
    candidate: { sha: head, baseSha: base, pr: Number(work.key.slice(3)), branch: `graphyard/${work.key}`, author: 'author', createdAt: new Date(at - 2 * day).toISOString() },
    checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews, protected: true, mergeable: true,
    merged, mergeSha: merged ? 'c'.repeat(40) : null, mergedAt: merged ? new Date(at).toISOString() : null,
    files: ['src/flow.ts'], at: new Date(at).toISOString(),
  };
}
function gates(names: string[]) {
  return ['ready', 'build', 'review', 'test', 'acceptance', 'merge'].map(name => ({ name, passed: !names.includes(name), reasons: names.includes(name) ? [`${name} gate refuses`] : [] }));
}
function dataset(): FlowDataset {
  const events: LedgerEvent[] = [];
  const created = observedAt - 20 * day;
  const reviewing = snapshot('GY-1', created, {});
  events.push(event(reviewing, created, 'create'));
  const submitted = { ...reviewing, stage: 'build' as const, stageEnteredAt: new Date(created + 2 * day).toISOString(), submission: { epoch: 1, pr: 1 }, gates: gates(['build', 'review', 'acceptance', 'merge']) };
  events.push(event(submitted, created + 2 * day, 'submit'));
  const waiting = { ...submitted, stage: 'review' as const, stageEnteredAt: new Date(created + 4 * day).toISOString(), candidate: observation(submitted, created + 4 * day, []).candidate, observation: observation(submitted, created + 4 * day, []) as any, gates: gates(['review', 'acceptance', 'merge']) };
  events.push(event(waiting, created + 4 * day, 'github.observed'));

  const proving = snapshot('GY-2', created + day, { submission: { epoch: 1, pr: 2 } });
  events.push(event(proving, created + day, 'create'));
  const approved = { ...proving, stage: 'acceptance' as const, stageEnteredAt: new Date(created + 6 * day).toISOString(), candidate: observation(proving, created + 6 * day, []).candidate, observation: observation(proving, created + 6 * day, [{ reviewer: 'reviewer', sha: head, state: 'APPROVED', id: 71, submittedAt: new Date(created + 6 * day).toISOString() }]) as any, gates: gates(['acceptance', 'merge']) };
  events.push(event(approved, created + 6 * day, 'github.observed'));

  const shipped = snapshot('GY-3', created + 2 * day, { submission: { epoch: 1, pr: 3 } });
  events.push(event(shipped, created + 2 * day, 'create'));
  const merged = {
    ...shipped, stage: 'done' as const, stageEnteredAt: new Date(created + 9 * day).toISOString(),
    candidate: observation(shipped, created + 9 * day, []).candidate, observation: observation(shipped, created + 9 * day, [{ reviewer: 'reviewer', sha: head, state: 'APPROVED', id: 72, submittedAt: new Date(created + 8 * day).toISOString() }], true) as any,
    delivery: { mergedAt: new Date(created + 9 * day).toISOString(), mergeSha: 'c'.repeat(40), authorizationRevision: 2 },
    evidence: [{ id: 'evidence-1', proof: 'integration:flow', sha: head, baseSha: base, policyRevision: 1, producer: 'ci', trusted: true, result: 'pass' as const, executed: 12, skipped: 0, at: new Date(created + 8 * day).toISOString() }],
    gates: gates([]),
  };
  events.push(event(merged, created + 9 * day, 'github.observed'));

  const states = new Map<string, ProjectionState>();
  const facts: FlowFact[] = [];
  for (const entry of events) {
    const state = states.get(entry.work_id) ?? {};
    states.set(entry.work_id, state);
    facts.push(...deriveFacts(entry, state));
  }
  const latest: FlowFact[] = [];
  for (const fact of [...facts].reverse()) if (!latest.some(entry => entry.workId === fact.workId && entry.kind === fact.kind)) latest.push(fact);
  const work = [waiting, approved, merged] as Work[];
  return {
    observedAt: new Date(observedAt).toISOString(), from: new Date(observedAt - 30 * day).toISOString(), to: new Date(observedAt).toISOString(),
    days: 30, work, included: work, facts, latest, carryIn: [], deployments: [], mergedForDeployments: [],
    scanned: facts.length, truncated: false, workTruncated: false, deploymentsTruncated: false, deploymentMergesTruncated: false,
    projection: { lastEvent: sequence, updatedAt: new Date(observedAt).toISOString(), pendingEvents: 0, pendingCapped: false },
  };
}

// `phase` answers the phase drill-down per requested key, so a test can reproduce the row bound
// the control plane applies (flowLimits.drilldown) exactly as the page meets it.
type FixtureState = { report: any; drill: any; phase?: (key: string | null) => any; status: number; delay: boolean; queries: string[] };
async function fixture(page: Page, role = 'admin', mutate: (report: any) => any = report => report) {
  const source = dataset();
  const report = mutate(computeFlow(source, { days: 30 }));
  const drill = flowDrilldown(source, report, { metric: 'bottleneck', key: 'review', authorized: role !== 'reader' });
  const state: FixtureState = { report, drill, status: 200, delay: false, queries: [] };
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (route.request().headers().authorization !== 'Bearer browser-fixture') return route.fulfill({ status: 401, json: { error: 'Rejected' } });
    // The Attribution section of the same page reads its own endpoint; browser-tests/attribution.spec.ts exercises it.
    if (url.pathname.startsWith('/api/analytics/attribution')) {
      const empty: AttributionDataset = { observedAt: new Date(observedAt).toISOString(), from: new Date(observedAt - 30 * day).toISOString(), to: new Date(observedAt).toISOString(), days: 30, records: [], recordsTruncated: false, requests: [], requestsTruncated: false, environments: {}, blockedNow: [] };
      return route.fulfill({ json: url.pathname.endsWith('/drilldown') ? { rows: [], columns: [], total: 0, truncated: false } : computeAttribution(empty) });
    }
    if (url.pathname.startsWith('/api/analytics/flow')) {
      state.queries.push(url.search);
      if (state.delay) await new Promise(resolve => setTimeout(resolve, 600));
      if (state.status !== 200) return route.fulfill({ status: state.status, json: { error: 'Flow analytics are temporarily unavailable' } });
      if (url.pathname.endsWith('/export'))
        return route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', headers: { 'content-disposition': 'attachment; filename="graphyard-flow-bottleneck-30d.csv"' }, body: flowExport(state.report, state.drill, 'csv') });
      if (url.pathname.endsWith('/drilldown') && url.searchParams.get('metric') === 'phase' && state.phase)
        return route.fulfill({ json: state.phase(url.searchParams.get('key')) });
      return route.fulfill({ json: url.pathname.endsWith('/drilldown') ? state.drill : state.report });
    }
    return route.fulfill({
      json: url.pathname.endsWith('/status') ? { actor: { id: 'fixture', role }, github: true, reviewProviders: ['github'], repository: 'fixture/repository', jobs: [] }
        : url.pathname.endsWith('/work-snapshot') ? { work: [], now: new Date(observedAt).toISOString(), jobs: [] } : [],
    });
  });
  await page.goto('/');
  await page.getByLabel('Access token').fill('browser-fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  // Flow analytics is part of the one Insights page, behind its one Show details (GY-168).
  // On a phone the one navigation folds into the Menu button (GY-161).
  if (page.viewportSize()!.width <= 650) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Insights', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Insights', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Flow analytics' })).toHaveCount(0);
  await page.locator('.insight-details > summary').click();
  await expect(page.getByRole('heading', { name: 'Flow analytics', level: 2 })).toBeVisible();
  return state;
}
/** The flow analytics report on the Insights page, apart from the shipping pulse beside it. */
const analytics = (page: Page) => page.getByRole('region', { name: 'Flow analytics', exact: true });

test('integration:flow-analytics-browser', async ({ page }) => {
  const state = await fixture(page);
  await expect(page.locator('.flow-state')).toHaveAttribute('data-state', /complete|sparse/);

  // The report opens on each wait category with items, as a card with its count.
  const reviewCard = page.getByRole('button', { name: /Waiting for review/ });
  await expect(reviewCard).toContainText('1');
  await expect(page.getByText(/undelivered item\(s\) are/)).toBeVisible();

  // Each visualization is paired with an equivalent data table.
  const cumulative = page.getByRole('img', { name: /Cumulative flow by stage/ });
  await expect(cumulative).toBeVisible();
  const cumulativeTable = page.getByRole('region', { name: 'Cumulative flow data table' });
  await expect(cumulativeTable.locator('tbody tr')).toHaveCount(30);
  await expect(cumulativeTable.getByRole('columnheader', { name: 'review' })).toBeVisible();
  const leadTable = page.getByRole('region', { name: 'Lead time data table' });
  await expect(leadTable.locator('tbody tr')).toHaveCount(30);

  // Honest empty reporting: metrics without a sample are an em dash, never a zero.
  await expect(page.getByRole('table', { name: /Milestone-to-milestone/ }).or(page.locator('table').filter({ hasText: 'pr created to review start' }))).toBeVisible();
  await expect(page.locator('table').filter({ hasText: 'pr created to review start' })).toContainText('—');

  // Filters narrow the query the control plane is asked for.
  await page.getByLabel('Window').selectOption('7');
  await expect.poll(() => state.queries.at(-1)).toContain('window=7');
  await page.getByLabel('Work type').selectOption('feature');
  await expect.poll(() => state.queries.at(-1)).toContain('type=feature');
  await page.getByLabel('Stage', { exact: true }).selectOption('review');
  await expect.poll(() => state.queries.at(-1)).toContain('stage=review');
  await page.getByLabel('Window').selectOption('30');
  await expect.poll(() => state.queries.at(-1)).toContain('window=30');

  // Drill-down opens the exact underlying records and exports them.
  await reviewCard.click();
  const dialog = page.getByRole('dialog', { name: 'Waiting for review drill-down' });
  await expect(dialog.getByRole('region', { name: /records/ }).locator('tbody tr')).toHaveCount(1);
  await expect(dialog.getByText('GY-1')).toBeVisible();
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export CSV' }).click();
  expect((await download).suggestedFilename()).toBe('graphyard-flow-bottleneck-30d.csv');
  await expect(dialog.getByRole('status')).toContainText('as CSV with definitions, timezone, filters, coverage and exclusions');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(reviewCard).toBeFocused();
});

test('flow analytics distinguishes loading, unavailable, empty, sparse, partial, stale and complete', async ({ page }) => {
  const state = await fixture(page);
  await expect(page.locator('.flow-state')).toHaveAttribute('data-state', /complete|sparse/);

  state.delay = true;
  await analytics(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(analytics(page).getByRole('status')).toContainText('Loading flow analytics…');
  await expect(page.locator('.flow-state')).toBeVisible();
  await expect(page.locator('.flow-state')).toHaveAttribute('data-state', 'loading');
  await expect(page.locator('.flow-state')).toContainText('earlier observation');
  await expect(page.locator('.flow-state')).toHaveAttribute('data-state', /complete|sparse/);
  state.delay = false;

  state.status = 503;
  await analytics(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(analytics(page).getByRole('alert')).toContainText('temporarily unavailable');
  await expect(analytics(page).getByRole('alert')).toContainText('earlier observation');
  state.status = 200;
  await analytics(page).getByRole('button', { name: 'Retry flow analytics' }).click();
  await expect(analytics(page).getByRole('alert')).toHaveCount(0);

  const base = state.report;
  const variants: [string, (report: any) => any][] = [
    ['partial', report => ({ ...report, coverage: { ...report.coverage, truncated: true, complete: false } })],
    ['partial', report => ({ ...report, coverage: { ...report.coverage, sliceFilterTruncated: true, slices: { ...report.coverage.slices, truncatedInRepository: 2 }, complete: false } })],
    ['stale', report => ({ ...report, coverage: { ...report.coverage, projection: { ...report.coverage.projection, stale: true, pendingEvents: 12 } } })],
    ['empty', report => ({ ...report, coverage: { ...report.coverage, workItems: 0 } })],
  ];
  for (const [expected, mutate] of variants) {
    state.report = mutate(base);
    await analytics(page).getByRole('button', { name: 'Refresh' }).click();
    await expect(page.locator('.flow-state')).toHaveAttribute('data-state', expected);
    if (state.report.coverage.sliceFilterTruncated) await expect(page.locator('.flow-state')).toContainText('this slice filter may have missed them');
  }
  await expect(page.getByText('nothing is shown as zero')).toBeVisible();
});

// The five phases the handed-in-to-merged figure adds up, in the client's order.
const phases = ['pr-created-to-review-start', 'review-start-to-review-complete', 'review-complete-to-evidence-complete', 'evidence-complete-to-merge-authorized', 'merge-authorized-to-merged'];
const phaseRows = (episodes: number, bucket: string) => Array.from({ length: episodes }, (_, index) =>
  ({ workKey: `GY-${index}`, metric: 'phase', bucket, observedAt: new Date(observedAt).toISOString(), valueMs: 60_000, pullRequest: index, commit: `${index}`.repeat(4), detail: bucket }));

test('a phase drill-down cut off by the row bound is read per phase, and never averaged when even that is cut off', async ({ page }) => {
  const state = await fixture(page);
  // One request for every phase of every episode exceeds the bound: the rows come back cut off
  // and sorted by work key, so their percentiles would be a biased sample presented as the whole.
  state.phase = key => key === null
    ? { metric: 'phase', key, columns: [], total: 900, truncated: true, rows: phaseRows(3, phases[0]) }
    : { metric: 'phase', key, columns: [], total: 3, truncated: false, rows: phaseRows(3, key) };
  await analytics(page).getByRole('button', { name: 'Refresh' }).click();
  // Asking one phase at a time stays inside the bound, so the figure is the whole window's.
  await expect.poll(() => phases.every(phase => state.queries.some(query => query.includes(`key=${phase}`)))).toBe(true);
  const headline = page.locator('.flow-headline');
  await expect(headline).toContainText('5m typical (p50)');
  await expect(headline).toContainText('3 merged');

  // Past the bound even per phase, nothing is drawn from the part that came back.
  state.phase = key => ({ metric: 'phase', key, columns: [], total: 900, truncated: true, rows: phaseRows(3, key ?? phases[0]) });
  await analytics(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('heading', { name: 'Handed in → merged' })).toBeVisible();
  await expect(page.locator('.flow-unreadable')).toContainText('more merged changes than one read can return');
  await expect(page.locator('.flow-headline')).not.toContainText('typical');
});

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`flow analytics is keyboard reachable, labelled, and usable on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await fixture(page, 'reader');
    for (const name of ['Window', 'Work type', 'Stage', 'Delivery slice']) await expect(page.getByLabel(name, { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Cumulative flow data table' })).toBeVisible();
    await expect(page.getByRole('img', { name: /Cumulative flow by stage/ })).toBeVisible();
    const overflow = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
    expect(overflow.content).toBeLessThanOrEqual(overflow.width + 1);
    const scroller = page.getByRole('region', { name: 'Cumulative flow data table' });
    await scroller.focus();
    expect(await scroller.evaluate(element => element === document.activeElement)).toBe(true);
    const card = page.getByRole('button', { name: /Waiting for review/ });
    await card.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Waiting for review drill-down' });
    await expect(dialog.getByRole('button', { name: 'Close drill-down' })).toBeFocused();
    await expect(dialog).toContainText('Evidence and artifact identifiers require an operator');
    await page.keyboard.press('Escape');
    await expect(card).toBeFocused();
    const contrast = await page.locator('.flow-state').evaluate(element => getComputedStyle(element).color);
    expect(contrast).not.toBe('rgb(0, 0, 0)');
  });
}

// GY-705: the Flow panel on the GY-161 board, with the report, the step-move rows and the work
// snapshot each under the test's control.
type PanelControl = { report: any; failMoves: boolean; holdReport: Promise<void> | null; holdMoves: Promise<void> | null; work: any[] };
async function flowPanel(page: Page, control: Partial<PanelControl> = {}) {
  const state: PanelControl = { report: boardApi('analytics/flow?window=7'), failMoves: false, holdReport: null, holdMoves: null, work: boardWork(), ...control };
  await page.clock.setFixedTime(new Date(NOW));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.slice(1) + url.search;
    if (url.pathname === '/api/analytics/flow/drilldown' && url.searchParams.get('metric') === 'steps') {
      if (state.holdMoves) await state.holdMoves;
      return state.failMoves ? route.fulfill({ status: 503, json: { error: 'The ledger is under load' } }) : route.fulfill({ json: boardApi(path) });
    }
    if (url.pathname === '/api/analytics/flow') {
      if (state.holdReport) await state.holdReport;
      return route.fulfill({ json: state.report });
    }
    if (url.pathname === '/api/work-snapshot') return route.fulfill({ json: { work: state.work, jobs: [], now: new Date(NOW).toISOString() } });
    return route.fulfill({ json: boardApi(path) });
  });
  await page.goto('/');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', level: 1 })).toBeVisible();
  if (page.viewportSize()!.width <= 650) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Insights', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Insights', level: 1 })).toBeVisible();
  return state;
}
/** A report whose step dwell has a well-sampled median for every step. */
function everyStepMeasured() {
  const report = boardApi('analytics/flow?window=7') as any;
  return { ...report, stepDwell: stepIds.map((step, index) => ({ step, n: 9, medianMs: (index + 2) * 7 * 60_000, sparse: false })) };
}
const stepHead = (page: Page, step: string) => page.locator('.flow-step').nth(stepIds.indexOf(step as any));

test('unit:flow-medians-independent-of-replay — a failed step-move read leaves every step header showing its median from the report, under its own notice', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const report = everyStepMeasured();
  await flowPanel(page, { report, failMoves: true });
  await expect(page.locator('[data-flow="replay-error"]')).toContainText('The recorded history could not be read');
  await expect(page.locator('[data-flow="report-error"]')).toHaveCount(0);
  for (const { step, medianMs } of report.stepDwell)
    await expect(stepHead(page, step).locator('.flow-median')).toHaveText(` · median ${formatDuration(medianMs / 60000)}`);
  await expect(page.locator('.flow-step .flow-median', { hasText: '—' })).toHaveCount(0);
  await expect(page.locator('.flow-wait')).toHaveText('No recorded history to replay.');
});

test('unit:flow-medians-independent-of-replay — a step-move read that has not answered never holds the medians back', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const report = everyStepMeasured();
  await flowPanel(page, { report, holdMoves: new Promise(() => {}) });
  for (const { step, medianMs } of report.stepDwell)
    await expect(stepHead(page, step).locator('.flow-median')).toHaveText(` · median ${formatDuration(medianMs / 60000)}`);
  await expect(page.locator('.flow-wait')).toHaveText('Reading the recorded step changes…');
});

for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: '375 px', width: 375, height: 812 }]) {
  test(`unit:flow-now-compact — 40 items at one step keep the Now panel within 320 px behind a '+N more' control that shows them all, at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const work = boardWork();
    const template = work.find(item => item.key === 'GY-15');
    const crowd = Array.from({ length: 40 }, (_, index) => ({ ...template, id: `crowd-${index}`, key: `GY-${300 + index}`, title: `Crowded item ${index}` }));
    await flowPanel(page, { work: [...work, ...crowd] });
    const lane = page.locator('[data-flow="now"]');
    const step = await lane.locator('.now-dot[data-key="GY-300"]').getAttribute('data-step');
    const total = Number(await stepHead(page, step!).getAttribute('data-count'));
    await expect(lane.locator(`.now-dot[data-step="${step}"]`)).toHaveCount(12);
    expect(total).toBeGreaterThanOrEqual(40);
    // The step header carries the column's full count at either width.
    const count = stepHead(page, step!).locator('> span').getByText(`${total} now`);
    await expect(count).toBeVisible();
    // Several dots share a row: the twelve shown stand on six rows.
    const rows = await lane.locator(`.now-dot[data-step="${step}"]`).evaluateAll(dots => new Set(dots.map(dot => (dot as HTMLElement).dataset.row)).size);
    expect(rows).toBe(6);
    const more = lane.locator(`.now-more[data-step="${step}"]`);
    await expect(more).toHaveAttribute('data-hidden', String(total - 12));
    await expect(more).toContainText(`+${total - 12}`);
    await expect(more).toHaveAccessibleName(new RegExp(`Show all ${total} items`));
    const bounded = async () => {
      const height = (await lane.boundingBox())!.height;
      expect(height).toBeLessThanOrEqual(320);
      const overflow = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
      expect(overflow.content).toBeLessThanOrEqual(overflow.width);
    };
    await bounded();
    // No two shown dots overlap.
    const boxes = await lane.locator('.now-dot').evaluateAll(dots => dots.map(dot => dot.getBoundingClientRect()).map(r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })));
    for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1))
      expect(a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5, 'Now dots overlap').toBe(true);
    await more.click();
    await expect(lane.locator(`.now-dot[data-step="${step}"]`)).toHaveCount(total);
    for (const item of crowd) await expect(lane.locator(`.now-dot[data-key="${item.key}"]`)).toHaveCount(1);
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await bounded();
    // The expanded column scrolls inside the lane, down to its last item.
    await lane.locator('.now-dot[data-key="GY-339"]').scrollIntoViewIfNeeded();
    await expect(lane.locator('.now-dot[data-key="GY-339"]')).toBeInViewport();
    await more.click();
    await expect(lane.locator(`.now-dot[data-step="${step}"]`)).toHaveCount(12);
  });
}

test('unit:flow-now-renders-first — the Now view is drawn from the work snapshot before the flow report answers, and the medians follow the report', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  let answer!: () => void;
  const report = everyStepMeasured();
  await flowPanel(page, { report, holdReport: new Promise<void>(resolve => { answer = resolve; }), holdMoves: new Promise(() => {}) });
  const lane = page.locator('[data-flow="now"]');
  await expect(lane.locator('.now-dot').first()).toBeVisible();
  await expect(lane.locator('.now-dot[data-key="GY-15"]')).toBeVisible();
  await expect(page.locator('.flow-step .flow-median').first()).toHaveText(' · median —');
  answer();
  for (const { step, medianMs } of report.stepDwell)
    await expect(stepHead(page, step).locator('.flow-median')).toHaveText(` · median ${formatDuration(medianMs / 60000)}`);
});
