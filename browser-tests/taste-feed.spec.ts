import { test, expect, type Page } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';

// GY-3393: the Taste feed on the Work page. Delivered items the owner has not tasted appear as
// cards with their why sentence and the evidence that ran the real app; Looks good records the
// taste and the card leaves; Send back with a note posts the note; and neither action reopens or
// holds the delivery. Browser-only API fixtures: no production requests, credentials, or writes.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const at = '2026-01-01T00:00:00Z';
const delivered = (key: string, title: string, why: string, minutesAgo: number) => ({
  dependencies: [], scenarioRequirements: [], id: `fixture-${key.toLowerCase()}`, key, title, summary: why,
  type: 'feature', priority: 2, stage: 'done', stageEnteredAt: at, ready: true, policy: { review: true, checks: ['test'] },
  policyRevision: 1, revision: 1, violations: [], workspaces: [], createdAt: at, updatedAt: at,
  criteria: [{ id: 'AC-1', text: 'Works', proofs: ['e2e:taste-feed'] }], lease: null, candidate: null, submission: null,
  reworkRequested: false, evidence: [{ id: 'ev-1', proof: 'e2e:taste-feed', sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 1, producer: 'producer-1', trusted: true, result: 'pass', executed: 3, skipped: 0, at }],
  observation: { merged: true, mergeSha: 'c'.repeat(40), mergedAt: new Date(Date.now() - minutesAgo * 60000).toISOString(), candidate: null, checks: [], reviews: [], protected: true, mergeable: true, files: [], at },
  delivery: { mergeSha: 'c'.repeat(40), mergedAt: new Date(Date.now() - minutesAgo * 60000).toISOString(), authorizationRevision: 1, pr: 9 },
  gates: [], trialScreenshots: { mergeSha: 'c'.repeat(40), baseTip: 'd'.repeat(40), at, cases: [{ case: 'taste-feed', before: true, after: true }] },
});

/** The dashboard with a taste feed: the two delivered items served by the snapshot, the taste route answered in the fixture. */
async function tastePage(page: Page, role = 'admin') {
  const state = {
    work: [delivered('GY-2', 'A second shipped thing', 'The second delivery\u2019s why sentence.', 30),
      delivered('GY-1', 'A shipped thing', 'The delivery\u2019s why sentence.', 90)] as any[],
    tasted: [] as { id: string; body: any }[],
  };
  await page.route('**/api/**', async route => {
    if (route.request().headers().authorization !== 'Bearer browser-fixture') return route.fulfill({ status: 401, json: { error: 'Rejected' } });
    const url = new URL(route.request().url()), path = url.pathname;
    const taste = /^\/api\/work\/([^/]+)\/taste$/.exec(path);
    if (taste && route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      const item = state.work.find(entry => entry.id === taste[1]);
      if (item) item.taste = { verdict: body.verdict, at: new Date().toISOString(), by: 'fixture' };
      state.tasted.push({ id: taste[1], body });
      return route.fulfill({ json: item ?? {} });
    }
    if (path.endsWith('/trial-screenshots/taste-feed/after')) return route.fulfill({ body: png, contentType: 'image/png' });
    if (path.endsWith('/status')) return route.fulfill({ json: { actor: { id: 'fixture', role, sessionKind: role === 'admin' ? 'human' : 'ai' }, github: true, reviewProviders: ['github'], repository: 'fixture/repository', jobs: [] } });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work: state.work, now: new Date().toISOString() } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus(state.work, Date.now(), null) });
    return route.fulfill({ json: [] });
  });
  await page.goto('/?sign-in');
  await page.getByLabel('Access token').fill('browser-fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible();
  return state;
}

test('e2e:taste-feed — shipped items show in Taste with their why and evidence, and both actions work', async ({ page }) => {
  const state = await tastePage(page);
  const section = page.locator('[data-taste-section]');
  await expect(section).toBeVisible();
  // Newest first: GY-2 shipped later, so its card leads.
  await expect(section.locator('[data-taste-card]')).toHaveCount(2);
  await expect(section.locator('[data-taste-card]')).toHaveText([/GY-2/, /GY-1/]);
  // Each card carries its why sentence and the proof that ran the real app…
  await expect(page.getByText('The delivery’s why sentence.')).toBeVisible();
  await expect(page.getByText('e2e:taste-feed · 3 executed').first()).toBeVisible();
  // …and the screenshot the trial kept of it.
  await expect(section.locator('img.taste-shot').first()).toBeVisible();
  // Looks good records the taste and the card leaves the feed, without a reload.
  await page.getByRole('button', { name: 'Looks good GY-2' }).click();
  await expect(section.locator('[data-taste-card]')).toHaveCount(1);
  await expect(section.locator('[data-taste-card="GY-1"]')).toBeVisible();
  expect(state.tasted).toEqual([{ id: 'fixture-gy-2', body: { verdict: 'good' } }]);
  // Send back with a note posts the note; that card leaves too.
  await page.getByLabel('Send-back note for GY-1').fill('The spacing is too tight on mobile');
  await page.getByRole('button', { name: 'Send back GY-1' }).click();
  await expect(section).toHaveCount(0);
  expect(state.tasted.at(-1)).toEqual({ id: 'fixture-gy-1', body: { verdict: 'send-back', note: 'The spacing is too tight on mobile' } });
});

test('a reader tastes nothing: the cards show, the actions do not', async ({ page }) => {
  await tastePage(page, 'reader');
  await expect(page.locator('[data-taste-card]')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Looks good GY-2' })).toHaveCount(0);
  await expect(page.getByLabel('Send-back note for GY-1')).toHaveCount(0);
});
