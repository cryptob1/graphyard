import { test, expect, type Page } from '@playwright/test';
import { attributionDrilldown, computeAttribution, type AttributionDataset, type AttributionRecord } from '../src/attribution';
import { computeFlow, type FlowDataset } from '../src/flow-analytics';

// Browser-only fixtures. The report is computed by the real aggregation from synthetic
// ledger records, so the Attribution section is exercised against the exact payload
// `GET /api/analytics/attribution` produces, and the drill-down against its exact rows.
const day = 86_400_000, minute = 60_000;
const observedAt = Date.now();
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let sequence = 0;
function record(workKey: string, kind: AttributionRecord['kind'], agoMs: number, details: Record<string, unknown>, ids: Partial<Pick<AttributionRecord, 'candidateId' | 'requestId' | 'attemptId'>> = {}): AttributionRecord {
  sequence++;
  return { id: uuid(sequence), seq: sequence, workId: `work-${workKey}`, workKey, proof: 'e2e:checkout', environmentId: 'preview', candidateId: ids.candidateId ?? null, requestId: ids.requestId ?? null, attemptId: ids.attemptId ?? null,
    kind, recordedAt: new Date(observedAt - agoMs).toISOString(), dedupe: `${kind}:${sequence}`, details };
}
function dataset(days: 7 | 30 | 90): AttributionDataset {
  const within = (agoMs: number) => agoMs < days * day;
  const manifest = { manifestHash: 'm'.repeat(64), observationIds: [uuid(900)], evidenceId: uuid(700), buildId: uuid(800), release: { id: '2026.09.18-1', revision: 1 } };
  const all: AttributionRecord[] = [
    record('GY-7', 'target-checked', 3 * day + 10 * minute, { phase: 'request', state: 'unobserved', reason: 'Target unobserved at request', ...manifest }, { candidateId: uuid(1), requestId: uuid(2) }),
    record('GY-7', 'target-mismatch', 3 * day, { phase: 'observation', state: 'mismatched', mismatchedServices: 2, partialConvergence: false, reason: 'Service api runs sha256:2222 instead of sha256:1111', ...manifest }, { candidateId: uuid(1), requestId: uuid(2) }),
    record('GY-7', 'superseded', 3 * day, { reason: 'Target moved while the request was queued; the record is preserved and superseded', ...manifest }, { candidateId: uuid(1), requestId: uuid(2) }),
    record('GY-7', 'paid-run-avoided', 3 * day, { reason: 'Execution withheld: the target runs another manifest', ...manifest }, { candidateId: uuid(1), requestId: uuid(2) }),
    record('GY-7', 'rescheduled', 3 * day, { reason: 'Fresh request minted: the moved target contains the intended change via release-membership', via: 'release-membership', ...manifest }, { candidateId: uuid(3), requestId: uuid(4) }),
    record('GY-7', 'target-checked', 3 * day - 4 * minute, { phase: 'dispatch', state: 'matched', reason: 'Target matched at dispatch', ...manifest }, { candidateId: uuid(3), requestId: uuid(4), attemptId: uuid(5) }),
    record('GY-7', 'evidence-bound', 3 * day - 9 * minute, { result: 'pass', reason: 'Evidence pass: bound to manifest, signature and target observations', ...manifest }, { candidateId: uuid(3), requestId: uuid(4), attemptId: uuid(5) }),
    record('GY-8', 'target-mismatch', 12 * day, { phase: 'dispatch', state: 'mismatched', mismatchedServices: 1, partialConvergence: true, reason: 'Service web runs sha256:4444 instead of sha256:3333', ...manifest }, { candidateId: uuid(6), requestId: uuid(7) }),
    record('GY-8', 'target-checked', 12 * day - 6 * minute, { phase: 'observed', state: 'matched', reason: 'Target matched', ...manifest }, { candidateId: uuid(6), requestId: uuid(7) }),
    record('GY-8', 'reanchor-blocked', 12 * day - 2 * minute, { contains: null, reasons: ['The observed target matches no trusted build attestation or release manifest; membership is unknown'], reason: 'The observed target matches no trusted build attestation or release manifest; membership is unknown', ...manifest }, { candidateId: uuid(6), requestId: uuid(7) }),
    record('GY-9', 'signature-regenerated', 40 * day, { changed: ['build-inputs'], reason: 'Compatibility signature regenerated: build-inputs changed', ...manifest }, { candidateId: uuid(8) }),
    record('GY-9', 'unsupported-claim-refused', 40 * day, { claim: 'client-supplied-sha', reason: 'A client-supplied SHA was offered as target proof', ...manifest }, { candidateId: uuid(8), requestId: uuid(9) }),
    record('GY-9', 'attribution-undermined', 40 * day - minute, { phase: 'delayed-observation', state: 'mismatched', mismatchedServices: 1, reason: 'Observation measured api at sha256:5555 during the execution window', ...manifest }, { candidateId: uuid(8), requestId: uuid(9), attemptId: uuid(10) }),
  ];
  const records = all.filter(r => within(observedAt - Date.parse(r.recordedAt)));
  const request = (id: string, workKey: string, agoMs: number, targetKind: 'immutable-preview' | 'shared-staging', acknowledged: boolean) => ({
    id, workId: `work-${workKey}`, proof: 'e2e:checkout', candidateId: uuid(1), expectedWorkRevision: 1, runner: { id: 'runner', revision: 1 }, collector: { id: 'collector', revision: 1 }, deadline: new Date(observedAt - agoMs + 30 * minute).toISOString(), maxAttempts: 3,
    state: acknowledged ? 'completed' : 'superseded', createdAt: new Date(observedAt - agoMs).toISOString(), createdBy: 'operator',
    attempts: acknowledged ? [{ id: uuid(5), epoch: 1, dispatchedAt: new Date(observedAt - agoMs + minute).toISOString(), acknowledgedAt: new Date(observedAt - agoMs + minute).toISOString(), finishedAt: new Date(observedAt - agoMs + 6 * minute).toISOString(), expiresAt: new Date(observedAt - agoMs + 7 * minute).toISOString(), state: 'completed', settled: true }] : [],
    attribution: { workKey, environmentId: 'preview', environmentRevision: 1, targetKind, manifestHash: 'm'.repeat(64), digestHash: 'd'.repeat(64), signature: 's'.repeat(64), buildId: uuid(800), target: { state: 'unobserved', observationIds: [], observedAt: null, digestHash: null } },
  });
  const requests = [request(uuid(2), 'GY-7', 3 * day + 10 * minute, 'immutable-preview', false), request(uuid(4), 'GY-7', 3 * day, 'immutable-preview', true), request(uuid(7), 'GY-8', 12 * day, 'shared-staging', false), request(uuid(9), 'GY-9', 40 * day, 'immutable-preview', true)]
    .filter(r => within(observedAt - Date.parse(r.createdAt)));
  return { observedAt: new Date(observedAt).toISOString(), from: new Date(observedAt - days * day).toISOString(), to: new Date(observedAt).toISOString(), days,
    records, recordsTruncated: false, requests: requests as any, requestsTruncated: false, environments: { preview: { immutable: true } },
    blockedNow: [{ workKey: 'GY-8', workId: 'work-GY-8', proof: 'e2e:checkout', environmentId: 'preview', reasons: ['The observed target matches no trusted build attestation or release manifest; membership is unknown'], since: new Date(observedAt - 12 * day).toISOString(), supersededRequestId: uuid(7) }] };
}
const emptyFlow: FlowDataset = { observedAt: new Date(observedAt).toISOString(), from: new Date(observedAt - 30 * day).toISOString(), to: new Date(observedAt).toISOString(), days: 30, work: [], included: [], facts: [], latest: [], carryIn: [], deployments: [], mergedForDeployments: [],
  scanned: 0, truncated: false, workTruncated: false, deploymentsTruncated: false, deploymentMergesTruncated: false, projection: { lastEvent: 0, updatedAt: new Date(observedAt).toISOString(), pendingEvents: 0, pendingCapped: false } } as FlowDataset;

type FixtureState = { status: number; delay: boolean; queries: string[]; mutate: (report: any) => any };
async function fixture(page: Page, role = 'admin') {
  const state: FixtureState = { status: 200, delay: false, queries: [], mutate: report => report };
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (route.request().headers().authorization !== 'Bearer browser-fixture') return route.fulfill({ status: 401, json: { error: 'Rejected' } });
    if (url.pathname.startsWith('/api/analytics/attribution')) {
      state.queries.push(url.search);
      const days = Number(url.searchParams.get('window') ?? 30) as 7 | 30 | 90;
      if (state.delay) await new Promise(resolve => setTimeout(resolve, 600));
      if (state.status !== 200) return route.fulfill({ status: state.status, json: { error: 'Attribution analytics are temporarily unavailable' } });
      const source = dataset(days);
      if (url.pathname.endsWith('/drilldown')) return route.fulfill({ json: attributionDrilldown(source, { metric: url.searchParams.get('metric') ?? 'targetMismatches', key: url.searchParams.get('key'), authorized: role !== 'reader' && role !== 'worker' }) });
      return route.fulfill({ json: state.mutate(computeAttribution(source)) });
    }
    if (url.pathname.startsWith('/api/analytics/flow')) return route.fulfill({ json: computeFlow(emptyFlow, { days: 30 }) });
    return route.fulfill({
      json: url.pathname.endsWith('/status') ? { actor: { id: 'fixture', role }, github: true, reviewProviders: ['github'], repository: 'fixture/repository', jobs: [] }
        : url.pathname.endsWith('/work-snapshot') ? { work: [], now: new Date(observedAt).toISOString(), jobs: [] } : [],
    });
  });
  await page.goto('/');
  await page.getByLabel('Access token').fill('browser-fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  // Attribution is part of flow analytics, behind the one Insights page's Show details (GY-168).
  // On a phone the one navigation folds into the Menu button (GY-161).
  if (page.viewportSize()!.width <= 650) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Insights', exact: true }).click();
  await page.getByText('Show details', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Attribution', level: 2 })).toBeVisible();
  return state;
}
const section = (page: Page) => page.getByRole('region', { name: 'Attribution', exact: true });
const card = (page: Page, metric: string) => section(page).locator(`.attribution-card[data-metric="${metric}"]`);

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`integration:attribution-browser-responsive on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const state = await fixture(page);
    const region = section(page);
    await expect(region.locator('.attribution-state')).toHaveAttribute('data-state', /complete|sparse/);
    // Nothing scrolls sideways: cards stack and tables scroll inside their own labelled region.
    const overflow = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
    expect(overflow.content).toBeLessThanOrEqual(overflow.width + 1);

    // Every metric the acceptance criteria name is a measured or blocked card, or, with no data,
    // is named once under "Unknown, not zero" rather than drawn as an UNKNOWN card; the metrics
    // table carries average, median, p90 and n for each.
    const metrics = ['targetMismatches', 'paidRunsAvoided', 'superseded', 'rescheduled', 'convergenceWait', 'reanchors', 'signatureRegenerations', 'candidateToReleaseDrift', 'multiServiceConvergence', 'immutablePreviewShare', 'unsupportedClaims', 'cost', 'blocked'];
    const drawn = await region.locator('.attribution-card').evaluateAll(elements => elements.map(element => [(element as HTMLElement).dataset.metric, (element as HTMLElement).dataset.state]));
    for (const [, cardState] of drawn) expect(cardState).toMatch(/measured|blocked/);
    const unknown = region.locator('h4', { hasText: 'Unknown, not zero' }).locator('xpath=following-sibling::ul[1]/li');
    expect(drawn.length + await unknown.count()).toBe(metrics.length);
    for (const [metric] of drawn) expect(metrics).toContain(metric);
    const table = region.getByRole('region', { name: 'Attribution metrics table' });
    for (const column of ['Average', 'Median', 'p90', 'n']) await expect(table.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
    await expect(table.locator('tbody tr')).toHaveCount(13);

    // Metric states: a measured count, an unknown that is never rendered as zero, and a standing block.
    await expect(card(page, 'targetMismatches')).toHaveAttribute('data-state', 'measured');
    await expect(card(page, 'targetMismatches').locator('strong')).toHaveText('2');
    await expect(card(page, 'blocked')).toHaveAttribute('data-state', 'blocked');
    await expect(card(page, 'blocked')).toContainText('blocked');
    await expect(card(page, 'multiServiceConvergence')).toHaveAttribute('data-state', 'measured');
    await expect(card(page, 'multiServiceConvergence')).toContainText('n 1');
    await expect(card(page, 'immutablePreviewShare')).toContainText('shared staging');
    await expect(card(page, 'cost')).toContainText('saved');

    // Coverage, exclusions and definitions are on the page, not behind an export.
    await expect(region.getByRole('heading', { name: 'Coverage and exclusions' })).toBeVisible();
    await expect(region.getByText(/ledger record\(s\) and .* validation request\(s\) were read/)).toBeVisible();
    await expect(region.getByRole('heading', { name: 'Blocked re-anchors now' })).toBeVisible();
    await expect(region.getByText(/GY-8 · e2e:checkout · preview/)).toBeVisible();
    await region.getByText('Attribution metric definitions and cost model').click();
    await expect(region.getByText('One cost unit is one acknowledged attempt')).toBeVisible();

    // 7/30/90-day filters drive the attribution query; the 7-day window drops the older records and says so honestly.
    await page.getByLabel('Window').selectOption('7');
    await expect.poll(() => state.queries.filter(q => !q.includes('metric=')).at(-1)).toContain('window=7');
    await expect(card(page, 'targetMismatches').locator('strong')).toHaveText('1');
    await expect(card(page, 'multiServiceConvergence')).toHaveCount(0);
    await expect(unknown.filter({ hasText: 'No partial rollout' })).toHaveCount(1);
    await expect(card(page, 'signatureRegenerations')).toHaveAttribute('data-state', 'measured');
    await expect(card(page, 'signatureRegenerations').locator('strong')).toHaveText('0');
    await page.getByLabel('Window').selectOption('90');
    await expect.poll(() => state.queries.filter(q => !q.includes('metric=')).at(-1)).toContain('window=90');
    await expect(card(page, 'targetMismatches').locator('strong')).toHaveText('3');
    await expect(card(page, 'unsupportedClaims').locator('strong')).toHaveText('2');
    await expect(card(page, 'signatureRegenerations')).toContainText('build-inputs ×1');
    await page.getByLabel('Window').selectOption('30');
    await expect(card(page, 'targetMismatches').locator('strong')).toHaveText('2');

    // Drill-down from an aggregate to the exact work, release, request, attempt, evidence and artifact behind it, by keyboard.
    const rescheduled = card(page, 'rescheduled');
    await rescheduled.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Requests rescheduled attribution drill-down' });
    await expect(dialog.getByRole('button', { name: 'Close attribution drill-down' })).toBeFocused();
    const records = dialog.getByRole('region', { name: /attribution records/ });
    for (const column of ['workKey', 'release', 'request', 'attempt', 'evidence', 'artifact']) await expect(records.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
    await expect(records.locator('tbody tr')).toHaveCount(1);
    await expect(records).toContainText('GY-7');
    await expect(records).toContainText('2026.09.18-1 r1');
    await expect(records).toContainText(uuid(4));
    await expect(records).toContainText(`build ${uuid(800)}`);
    await expect(dialog).toContainText('Identifiers are included for your role.');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(rescheduled).toBeFocused();

    // The metrics table is keyboard reachable as a scrollable region and every card is a named button.
    await table.focus();
    expect(await table.evaluate(element => element === document.activeElement)).toBe(true);
    await expect(card(page, 'targetMismatches')).toHaveAccessibleName(/Target mismatches: 2, measured/);
    const contrast = await region.locator('.attribution-state').evaluate(element => getComputedStyle(element).color);
    expect(contrast).not.toBe('rgb(0, 0, 0)');
  });
}

test('attribution distinguishes loading, unavailable, empty, partial, sparse, stale and complete, and readers see counts without identifiers', async ({ page }) => {
  const state = await fixture(page, 'reader');
  const region = section(page);
  await expect(region.locator('.attribution-state')).toHaveAttribute('data-state', /complete|sparse/);

  state.delay = true;
  await region.getByRole('button', { name: 'Reload attribution' }).click();
  await expect(region.getByRole('status')).toContainText('Loading attribution…');
  await expect(region.locator('.attribution-state')).toHaveAttribute('data-state', 'loading');
  await expect(region.locator('.attribution-state')).toContainText('earlier observation');
  await expect(region.locator('.attribution-state')).toHaveAttribute('data-state', /complete|sparse/);
  state.delay = false;

  state.status = 503;
  await region.getByRole('button', { name: 'Reload attribution' }).click();
  await expect(region.getByRole('alert')).toContainText('temporarily unavailable');
  await expect(region.locator('.attribution-state')).toHaveAttribute('data-state', 'unavailable');
  state.status = 200;
  await region.getByRole('button', { name: 'Retry attribution' }).click();
  await expect(region.getByRole('alert')).toHaveCount(0);

  const variants: [string, (report: any) => any][] = [
    ['partial', report => ({ ...report, coverage: { ...report.coverage, recordsTruncated: true, complete: false } })],
    ['stale', report => ({ ...report, generatedAt: new Date(Date.now() - 5 * minute).toISOString() })],
    ['sparse', report => ({ ...report, coverage: { ...report.coverage, sparse: true } })],
    ['empty', report => ({ ...report, coverage: { ...report.coverage, empty: true } })],
  ];
  for (const [expected, mutate] of variants) {
    state.mutate = mutate;
    await region.getByRole('button', { name: 'Reload attribution' }).click();
    await expect(region.locator('.attribution-state')).toHaveAttribute('data-state', expected);
  }
  await expect(region.getByText('no figure is rendered as zero')).toBeVisible();
  state.mutate = report => report;

  // A reader drills down to counts and kinds; request, attempt, evidence and artifact identifiers require an audit role.
  await page.getByLabel('Window').selectOption('90');
  await expect(card(page, 'unsupportedClaims').locator('strong')).toHaveText('2');
  await card(page, 'unsupportedClaims').click();
  const dialog = page.getByRole('dialog', { name: 'Unsupported-success claims prevented attribution drill-down' });
  await expect(dialog).toContainText('Identifiers require an operator, coordinator, or producer role');
  const records = dialog.getByRole('region', { name: /attribution records/ });
  await expect(records.locator('tbody tr')).toHaveCount(2);
  await expect(records).toContainText('requires audit role');
  await expect(records).not.toContainText(uuid(10));
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
