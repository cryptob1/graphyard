import { test, expect } from '@playwright/test';
import { boardFromStatus } from '../../src/model/board';
import { openHumanOnly } from '../../src/model/human-request';

// GY-3364: a background poll already in flight when the operator answers must not undo the answer.
// Hold the first background status read until the answer's refresh has landed; without ordering
// these reads, its old request list resurrects the card and erases Recently answered.
const request = { id: '5b0c8f4e-7d8a-4f6e-9a55-0c1d2e3f4a5b', kind: 'money-or-accounts', needed: 'A Hetzner Cloud project for the live-install proofs', reason: 'The proofs provision real servers',
  requestedBy: 'worker', epoch: 1, at: '2026-01-01T00:00:00Z', choices: [{ id: 'choice-1', label: 'Approve up to €50/month', outcome: 'provided', input: 'none' }] };
const parked = { dependencies: [], scenarioRequirements: [], id: 'parked-work', key: 'GY-7', title: 'Live-install proofs', description: 'Needs an account', type: 'feature', priority: 1,
  stage: 'ready', stageEnteredAt: '2026-01-01T00:00:00Z', ready: true, policy: { review: true, checks: ['test'] }, policyRevision: 1, revision: 1, epoch: 1, violations: [], workspaces: [],
  criteria: [{ id: 'AC-1', text: 'Proven live', proofs: ['unit:live'] }], evidence: [], gates: [], lease: null, blocker: `Waiting on a human-only decision (spending money or opening third-party accounts): ${request.needed}`, humanRequest: request, humanRequests: [] };
const now = '2026-01-01T02:00:00Z';

test('an older poll cannot undo a successful answer', async ({ page }) => {
  await page.clock.install({ time: new Date(now) });
  await page.clock.pauseAt(new Date(now));
  let markHeld!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { markHeld = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  let work: any = parked, statusReads = 0;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    if (path === '/api/sign-in') return route.fulfill({ json: { token: 'browser-human', actor: { id: 'operator', role: 'admin', sessionKind: 'human' }, expiresAt: '2026-01-01T14:00:00Z' } });
    if (method === 'POST') {
      const choice = request.choices[0];
      work = { ...parked, blocker: null, humanRequest: null, humanRequests: [{ ...request, answer: { by: 'operator', at: now, outcome: choice.outcome, text: choice.label, waitedMs: 7_200_000, choice: { id: choice.id, label: choice.label }, note: null } }] };
      return route.fulfill({ json: work });
    }
    if (path.endsWith('/status')) {
      const json = { actor: { id: 'operator', role: 'admin', sessionKind: 'human' }, humanOnly: openHumanOnly([{ work }], Date.parse(now)), github: true, reviewProviders: ['github'], repository: 'fixture/repository', jobs: [] };
      if (++statusReads === 2) { markHeld(); await released; }
      return route.fulfill({ json });
    }
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work: [work], now } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus([work], Date.parse(now), null) });
    return route.fulfill({ json: path.endsWith('/work') ? [work] : [] });
  });
  await page.goto('/#sign-in=one-time-code-from-graphyard-login');
  await held;
  await page.getByRole('button', { name: 'Every request and answer →' }).click();
  await page.locator('.human-request').getByRole('button', { name: 'Approve up to €50/month' }).click();
  await expect(page.getByRole('region', { name: 'Recently answered' })).toContainText('Approve up to €50/month');
  const response = page.waitForResponse('**/api/status');
  release();
  await (await response).finished();
  // Drain the browser's response callbacks and React paint before inspecting the old poll's effect.
  await page.clock.runFor(100);
  await expect(page.locator('.human-request')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Recently answered' })).toContainText('Approve up to €50/month');
});
