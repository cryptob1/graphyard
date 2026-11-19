import { test, expect, type Page } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';

// GY-3527: the Work page leads with merges an hour over the last 24 hours, then says in one line
// how long an item takes from release to merge, and turns into a warning naming the item, its stage and the next action when the pipeline stalls.
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const item = (key: string, stage: string, minutesAgo: number, title = `Change ${key}`) => ({ dependencies: [], scenarioRequirements: [], id: `fixture-${key}`, key, title, description: key, type: 'feature', priority: 2,
  stage, stageEnteredAt: at(minutesAgo), ready: true, policy: { review: true, checks: ['test'] }, policyRevision: 1, revision: 1, violations: [], workspaces: [], criteria: [], evidence: [], gates: [], sessions: [],
  ...(stage === 'done' ? { delivery: { mergedAt: at(minutesAgo), mergeSha: key.replace(/\D/g, '').padStart(40, 'a'), authorizationRevision: 1 } } : {}) });
const work = [item('GY-1', 'done', 300), item('GY-2', 'done', 12), item('GY-3', 'review', 20, 'A long title that has to wrap onto a second line on a narrow phone window without scrolling sideways')];

async function serve(page: Page, pipelineTime: unknown) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const now = new Date().toISOString();
    if (path.endsWith('/status')) return route.fulfill({ json: { actor: { id: 'operator', role: 'admin', sessionKind: 'human' }, repository: 'fixture/repository', jobs: [], live: { commit: 'c'.repeat(40), waiting: [] }, checksRunning: 1, pipelineTime } });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work, now } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus(work as never, Date.parse(now), null) });
    return route.fulfill({ json: [] });
  });
  await page.goto('/?sign-in');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible();
}
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

for (const width of [390, 1280]) {
  test(`e2e:main-page-pipeline-time — at ${width}px the page leads with merges an hour, largest, then a calm line: last merge and median, no ids, top bar unchanged`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await serve(page, { merged24h: 31, median: 42, p90: 95, samples: 10, lastMergeAt: at(12), oldest: { id: 'fixture-GY-3', key: 'GY-3', title: 'Fresh', stage: 'review', releasedAt: at(20) } });
    const line = page.locator('[data-speed-line]');
    await expect(line).toHaveAttribute('data-speed-line', 'calm');
    await expect(line).toHaveText(/^Last merge 1[23] min ago\. An item takes 42 min from release to merge \(slowest tenth 1 h 35 min\)\.$/);
    await expect(line).not.toContainText('GY-');
    const figure = page.locator('[data-speed-figure]');
    await expect(figure).toHaveText('1.3 merges an hour (31 in the last 24 hours)');
    // First and largest: nothing in the page's content (everything in .main but the shared top bar) sits above it or has bigger text.
    const { first, largest } = await page.evaluate(() => {
      const figure = document.querySelector('[data-speed-figure]')!, size = (el: Element) => parseFloat(getComputedStyle(el).fontSize);
      const text = [...document.querySelectorAll('.main *')].filter(el => el !== figure && !figure.contains(el) && !el.closest('.top-bar') && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent!.trim()) && (el as HTMLElement).offsetParent);
      return { first: text.every(el => el.getBoundingClientRect().top >= figure.getBoundingClientRect().bottom - 1), largest: text.every(el => size(el) < size(figure)) };
    });
    expect({ first, largest }).toEqual({ first: true, largest: true });
    // The top bar's metrics keep their meaning.
    await expect(page.locator('.activity-strip')).toHaveAttribute('data-in-trial', '1');
    await expect(page.locator('.activity-strip')).toHaveAttribute('data-shipped-tonight', /\d/);
    await expect(page.locator('.shipped-strip')).toContainText('shipped');
    expect(await noSideScroll(page)).toBe(true);
  });

  test(`e2e:main-page-pipeline-time — a stuck item turns the line into a warning at ${width}px naming it, its stage and the next action`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await serve(page, { merged24h: 48, median: 30, p90: 60, samples: 10, lastMergeAt: at(12), oldest: { id: 'fixture-GY-3', key: 'GY-3', title: work[2].title, stage: 'review', releasedAt: at(125) } });
    const line = page.locator('[data-speed-line]');
    await expect(line).toHaveAttribute('data-speed-line', 'warning');
    await expect(line).toContainText(`GY-3 ${work[2].title} has been in the pipeline 2 h 5 min, longer than the slowest tenth (1 h); it is in review. Next: open GY-3 and clear what holds it.`);
    expect(await noSideScroll(page)).toBe(true);
    await line.getByRole('button', { name: 'Open →' }).click();
    await expect(page.getByRole('button', { name: '← Back' })).toBeVisible();
  });

  test(`e2e:main-page-pipeline-time — a stale last merge warns at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await serve(page, { merged24h: 0, median: 40, p90: 400, samples: 10, lastMergeAt: at(150), oldest: { id: 'fixture-GY-3', key: 'GY-3', title: 'Slow', stage: 'test', releasedAt: at(100) } });
    const line = page.locator('[data-speed-line]');
    await expect(line).toHaveAttribute('data-speed-line', 'warning');
    await expect(page.locator('[data-speed-figure]')).toHaveText('0.0 merges an hour (0 in the last 24 hours)');
    await expect(line).toContainText(/^No merge for 2 h 3\d min, over three times the usual 40 min\. Oldest: GY-3 Slow, in its merge trial\. Next: open GY-3 and clear what holds it\./);
    expect(await noSideScroll(page)).toBe(true);
  });
}
