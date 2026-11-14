import { test, expect, type Page } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';
import { LINES, friendlyName } from '../web/fun';

// This spec proves motion, so it asks for it over the suite's reduced-motion default.
test.use({ reducedMotion: 'no-preference' });

// GY-3268: the dashboard is fun — named agents, a line about building, playful empty states and a
// small celebration when work ships — and the Fun toggle (or reduced motion, for the confetti) turns it off.
const builder = 'graphyard-claude-1', master = 'cryptob1-graphyard-master';
const name = friendlyName(builder)!;
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const session = (id: string, kind: string, principal: string) => ({ id, kind, principal, epoch: 1, runtime: 'claude', host: 'host', workspace: null, tab: null, pane: null, agentName: principal, role: kind,
  head: null, attach: null, transcript: null, subject: 'GY-1: Change priority from the dashboard', startedAt: at(5), updatedAt: at(0), endedAt: null, state: 'running', outcome: null, observed: 'working', observedAt: at(0) });
const item = (key: string, title: string) => ({ dependencies: [], scenarioRequirements: [], id: `fixture-${key}`, key, title, description: title, type: 'feature', priority: 2, stage: 'build', stageEnteredAt: at(5), ready: true,
  policy: { review: true, checks: ['test'] }, policyRevision: 1, revision: 1, violations: [], workspaces: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['e2e:dashboard-fun'] }], evidence: [],
  gates: [{ name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }], lease: { epoch: 1, owner: builder, expiresAt: at(-60) }, implementers: [builder],
  sessions: [session(`${builder}:1`, 'implementation', builder), session('master:1', 'coordination', master)] });
const merged = (work: any) => ({ ...work, stage: 'done', lease: undefined, gates: [], delivery: { mergedAt: new Date().toISOString(), mergeSha: 'a'.repeat(40) } });

async function serve(page: Page, work: any[]) {
  const state = { work };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const now = new Date().toISOString();
    if (path.endsWith('/status')) return route.fulfill({ json: { actor: { id: 'operator', role: 'admin', sessionKind: 'human' }, repository: 'fixture/repository', jobs: [] } });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work: state.work, now } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus(state.work, Date.parse(now), null) });
    if (path.endsWith('/events')) return route.fulfill({ json: [{ seq: 2, kind: 'claim', actor: builder, created_at: at(4) }, { seq: 1, kind: 'ready', actor: master, created_at: at(5) }] });
    if (path.includes('/work/')) return route.fulfill({ json: state.work.find(w => path.endsWith(w.id)) ?? {} });
    return route.fulfill({ json: [] });
  });
  await page.goto('/?sign-in');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible();
  return state;
}
const shipped = (page: Page) => page.locator('[aria-label="Shipped today"]');
const live = { timeout: 15_000 };

test('e2e:dashboard-fun — named agents on every page, a rotating line, and a toast with confetti when an item merges', async ({ page }) => {
  const state = await serve(page, [item('GY-1', 'Change priority from the dashboard'), item('GY-2', 'Another change')]);
  // The Work page: the builder by its friendly name, the account id on hover.
  const agent = page.locator(`[data-row="GY-1"] [data-agent="${builder}"]`);
  await expect(agent).toHaveText(name);
  await expect(agent).toHaveAttribute('title', builder);
  // One of the lines, and a tap shows another.
  const line = page.locator('[data-build-line]');
  const first = await line.textContent();
  expect(LINES).toContain(first);
  await line.click();
  await expect(line).not.toHaveText(first!);
  expect(LINES).toContain(await line.textContent());
  await expect(shipped(page)).toHaveAttribute('data-shipped-today', '0');

  // The item history names the same account the same way, and the master as the Chief.
  await page.getByRole('button', { name: /Change priority from the dashboard.*GY-1/ }).click();
  await page.locator('.full-history > summary').click();
  const history = page.getByRole('region', { name: 'History entries' });
  await expect(history.locator(`[data-agent="${builder}"]`)).toHaveText(name);
  await expect(history.locator(`[data-agent="${master}"]`)).toHaveText('the Chief');
  await expect(history.locator(`[data-agent="${builder}"]`)).toHaveAttribute('title', builder);

  // The Workers page: the same name for the same account, the master as the Chief.
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Workers', exact: true }).click();
  const sessions = page.getByRole('table', { name: 'Agent sessions' });
  await expect(sessions.locator(`[data-agent="${builder}"]`).first()).toHaveText(name);
  await expect(sessions.locator(`[data-agent="${master}"]`).first()).toHaveText('the Chief');

  // GY-1 merges while the page is open: a toast names its builder, confetti runs, and Shipped today counts it.
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Work', exact: true }).click();
  state.work = [merged(state.work[0]), state.work[1]];
  await expect(page.locator('[data-toast="GY-1"]')).toContainText(`${name} shipped “Change priority from the dashboard”`, live);
  await expect(page.locator('.confetti')).toHaveCount(1);
  await expect(shipped(page)).toHaveAttribute('data-shipped-today', '1');

  // Fun off: names and lines fall back to the plain text, and a merge brings a toast but no confetti.
  await page.locator('.confetti').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Fun', exact: true }).click();
  await expect(page.locator('[data-build-line]')).toHaveCount(0);
  await expect(page.locator(`[data-row="GY-2"] [data-agent="${builder}"]`)).toHaveText(builder);
  state.work = [state.work[0], merged(state.work[1])];
  await expect(page.locator('[data-toast="GY-2"]')).toContainText(`${builder} shipped “Another change”`, live);
  await expect(page.locator('.confetti')).toHaveCount(0);
  // The choice is remembered by this browser.
  await expect(page.getByRole('button', { name: 'Fun', exact: true })).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => localStorage.getItem('graphyard.fun'))).toBe('off');
});

test('e2e:dashboard-fun — with reduced motion set, a merge brings the toast and no confetti', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const state = await serve(page, [item('GY-1', 'Change priority from the dashboard')]);
  state.work = [merged(state.work[0])];
  await expect(page.locator('[data-toast="GY-1"]')).toContainText(`${name} shipped`, live);
  await expect(page.locator('.confetti')).toHaveCount(0);
});

test('e2e:dashboard-fun — an empty board shows the playful empty-state line, and the plain one with Fun off', async ({ page }) => {
  await serve(page, []);
  await expect(page.getByRole('heading', { name: 'The yard is quiet. File a goal and wake the crew.' })).toBeVisible();
  await page.getByRole('button', { name: 'Fun', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No work yet.' })).toBeVisible();
});
