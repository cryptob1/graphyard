import { test, expect, type Page } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';
import { openHumanOnly } from '../src/model/human-request';

// GY-738: the operator opens the one-time sign-in link, lands in a human session without a token,
// and answers a money request with one click, at desktop width and at 375 px. Browser-only API
// fixtures: no production requests, credentials or writes.
const request = { id: '5b0c8f4e-7d8a-4f6e-9a55-0c1d2e3f4a5b', kind: 'money-or-accounts', needed: 'A Hetzner Cloud project for the live-install proofs', reason: 'The proofs provision real servers',
  requestedBy: 'worker', epoch: 1, at: '2026-01-01T00:00:00Z',
  choices: [{ id: 'choice-1', label: 'Approve up to €50/month', outcome: 'provided', input: 'none' }, { id: 'choice-2', label: 'Approve with a different cap…', outcome: 'provided', input: 'text' }] };
const parked = { dependencies: [], plannedFiles: [], scenarioRequirements: [], id: 'parked-work', key: 'GY-7', title: 'Live-install proofs', description: 'Needs an account', type: 'feature', priority: 1,
  stage: 'ready', stageEnteredAt: '2026-01-01T00:00:00Z', ready: true, policy: { review: true, checks: ['test'] }, policyRevision: 1, revision: 1, epoch: 1, violations: [], workspaces: [],
  criteria: [{ id: 'AC-1', text: 'Proven live', proofs: ['unit:live'] }], evidence: [], gates: [], lease: null, blocker: `Waiting on a human-only decision (spending money or opening third-party accounts): ${request.needed}`, humanRequest: request, humanRequests: [] };
const now = '2026-01-01T02:00:00Z';

async function fixture(page: Page) {
  const posted: { path: string; body: any }[] = [];
  let work: any = parked;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    // The link is the credential: the one route reached without a token, and it opens a human session.
    if (path === '/api/sign-in') { posted.push({ path, body: route.request().postDataJSON() }); return route.fulfill({ json: { token: 'browser-human', actor: { id: 'operator', role: 'admin', sessionKind: 'human' }, expiresAt: '2026-01-01T14:00:00Z' } }); }
    if (route.request().headers().authorization !== 'Bearer browser-human') return route.fulfill({ status: 401, json: { error: 'Rejected' } });
    if (method === 'POST') {
      const body = route.request().postDataJSON(); posted.push({ path, body });
      const choice = request.choices.find(entry => entry.id === body.choice)!;
      work = { ...parked, blocker: null, humanRequest: null, humanRequests: [{ ...request, answer: { by: 'operator', at: now, outcome: choice.outcome, text: choice.label, waitedMs: 7_200_000, choice: { id: choice.id, label: choice.label }, note: null } }] };
      return route.fulfill({ json: work });
    }
    if (path.endsWith('/status')) return route.fulfill({ json: { actor: { id: 'operator', role: 'admin', sessionKind: 'human' }, humanOnly: openHumanOnly([{ work }], Date.parse(now)), github: true, reviewProviders: ['github'], repository: 'fixture/repository', jobs: [] } });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work: [work], now } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus([work], Date.parse(now), null) });
    return route.fulfill({ json: path.endsWith('/work') ? [work] : [] });
  });
  return posted;
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) {
  test(`the operator signs in from the link and answers a money request with one click at ${viewport.width} px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const posted = await fixture(page);
    await page.goto('/#sign-in=one-time-code-from-graphyard-login');
    // Signed in without typing a token; the code leaves the address bar at once.
    await expect(page.getByRole('button', { name: 'Every request and answer →' })).toBeVisible();
    expect(posted[0]).toEqual({ path: '/api/sign-in', body: { code: 'one-time-code-from-graphyard-login' } });
    expect(new URL(page.url()).hash).toBe('');
    expect(await page.evaluate(() => sessionStorage.getItem('graphyard-token'))).toBe('browser-human');

    await page.getByRole('button', { name: 'Every request and answer →' }).click();
    await expect(page.getByText('Signed in as')).toContainText('operator · human operator');
    const card = page.locator('.human-request');
    await expect(card.getByRole('button', { name: 'Decline' })).toBeVisible();
    await expect(card.getByText('graphyard answer', { exact: false })).toBeHidden();
    // One click is the whole answer.
    await card.getByRole('button', { name: 'Approve up to €50/month' }).click();
    await expect(page.getByRole('region', { name: 'Recently answered' })).toContainText('Approve up to €50/month');
    expect(posted.at(-1)).toEqual({ path: '/api/work/parked-work/answer', body: { request: request.id, choice: 'choice-1' } });
    await expect(page.locator('.human-request')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
  });
}
