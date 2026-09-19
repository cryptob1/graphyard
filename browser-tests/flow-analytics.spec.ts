import { test, expect, type Page } from '@playwright/test';
import { computeFlow, deriveFacts, flowDrilldown, flowExport, type FlowDataset, type FlowFact, type LedgerEvent, type ProjectionState } from '../src/flow-analytics';
import { computeAttribution, type AttributionDataset } from '../src/attribution';
import type { Work } from '../src/model';

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

type FixtureState = { report: any; drill: any; status: number; delay: boolean; queries: string[] };
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
  await page.getByRole('button', { name: 'Flow analytics' }).click();
  await expect(page.getByRole('heading', { name: 'Flow analytics', level: 1 })).toBeVisible();
  return state;
}

test('integration:flow-analytics-browser', async ({ page }) => {
  const state = await fixture(page);
  await expect(page.locator('.flow-state')).toHaveAttribute('data-state', /complete|sparse/);

  // Every aggregate is visible with its count, and the narrative matches the cards.
  const reviewCard = page.getByRole('button', { name: /Waiting on review/ });
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
  const dialog = page.getByRole('dialog', { name: 'Waiting on review drill-down' });
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
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('status')).toContainText('Loading flow analytics…');
  await expect(page.locator('.flow-state')).toBeVisible();
  await expect(page.locator('.flow-state')).toHaveAttribute('data-state', 'loading');
  await expect(page.locator('.flow-state')).toContainText('earlier observation');
  await expect(page.locator('.flow-state')).toHaveAttribute('data-state', /complete|sparse/);
  state.delay = false;

  state.status = 503;
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  await expect(page.getByRole('alert')).toContainText('earlier observation');
  state.status = 200;
  await page.getByRole('button', { name: 'Retry flow analytics' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);

  const base = state.report;
  const variants: [string, (report: any) => any][] = [
    ['partial', report => ({ ...report, coverage: { ...report.coverage, truncated: true, complete: false } })],
    ['partial', report => ({ ...report, coverage: { ...report.coverage, sliceFilterTruncated: true, slices: { ...report.coverage.slices, truncatedInRepository: 2 }, complete: false } })],
    ['stale', report => ({ ...report, coverage: { ...report.coverage, projection: { ...report.coverage.projection, stale: true, pendingEvents: 12 } } })],
    ['empty', report => ({ ...report, coverage: { ...report.coverage, workItems: 0 } })],
  ];
  for (const [expected, mutate] of variants) {
    state.report = mutate(base);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.locator('.flow-state')).toHaveAttribute('data-state', expected);
    if (state.report.coverage.sliceFilterTruncated) await expect(page.locator('.flow-state')).toContainText('this slice filter may have missed them');
  }
  await expect(page.getByText('nothing is shown as zero')).toBeVisible();
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
    const card = page.getByRole('button', { name: /Waiting on review/ });
    await card.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Waiting on review drill-down' });
    await expect(dialog.getByRole('button', { name: 'Close drill-down' })).toBeFocused();
    await expect(dialog).toContainText('Evidence and artifact identifiers require an operator');
    await page.keyboard.press('Escape');
    await expect(card).toBeFocused();
    const contrast = await page.locator('.flow-state').evaluate(element => getComputedStyle(element).color);
    expect(contrast).not.toBe('rgb(0, 0, 0)');
  });
}
