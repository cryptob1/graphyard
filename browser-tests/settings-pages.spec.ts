import { test, expect, type Page } from '@playwright/test';
import { applyRegistryMutation, emptyRegistry, fleetView, foldObservation, proposedRuntimes, type AgentRegistry } from '../src/model/registry';
import { NOW, boardApi } from './ui-board';

// GY-978 AC-3: the Agents, Settings and Operator automation pages are built from the shared layout
// (web/components/page-layout.tsx), show no raw JSON or internal id until a disclosure is opened,
// and at 1280px and 390px wide neither scroll sideways nor log a console error. The board fixture
// answers every read; the registry is a real one, viewed through the real `fleetView`.

const hour = 3_600_000, host = 'agent-host-1';
const identityId = '7d0c2a8e-3b1f-4c55-9a0e-5f1b6c2d9e41';

function registry(): AgentRegistry {
  const document = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: proposedRuntimes.filter(runtime => ['claude', 'codex'].includes(runtime.name)),
    models: [{ name: 'opus', id: 'claude-opus-5' }, { name: 'gpt', id: 'gpt-5.5-codex' }],
    accounts: [
      { name: 'opencode-a', runtime: 'codex', model: 'gpt', credential: { host, home: '/home/agent/.coding_agents/opencode-a' } },
      { name: 'cursor-a', runtime: 'codex', model: 'gpt', credential: { host, home: '/home/agent/.coding_agents/cursor-a' } },
      { name: 'claude-b', runtime: 'claude', model: 'opus', credential: { host, home: '/home/agent/.coding_agents/claude-b' } },
      { name: 'spare', runtime: 'claude', model: 'opus', credential: { host, home: '/home/agent/.coding_agents/spare' } },
    ],
    roles: [{ name: 'worker', accounts: ['opencode-a', 'cursor-a', 'claude-b'], concurrency: 4 }, { name: 'reviewer', accounts: ['claude-b'], concurrency: 1 }],
    reason: 'settings pages fixture',
  }, { actor: 'coordinator', at: new Date(NOW - 2 * hour).toISOString() }).registry;
  const resetsAt = new Date(NOW + 70 * hour).toISOString();
  foldObservation(document.accounts[0], { loggedIn: true, state: 'exhausted', usage: [{ window: '7d', percent: 100, resetsAt }], resetsAt, reason: 'weekly window spent' }, { actor: 'coordinator', at: new Date(NOW - hour).toISOString() });
  document.accounts[1].smoke = { result: 'fail', reason: 'the model refused the smoke prompt', at: new Date(NOW - 10 * 60_000).toISOString(), by: 'coordinator' };
  return document;
}

const operatorAgents = [{ id: identityId, displayName: 'Master loop', capabilities: ['work.create', 'work.release'], scope: { repositories: ['fixture/shop'], workItems: [] }, fingerprints: ['sha256:4f2a9c0e'], revision: 3, revokedAt: null,
  lastMutation: { kind: 'create', actor: 'operator', at: new Date(NOW - 5 * hour).toISOString(), reason: 'Scoped master loop' } }];

async function open(page: Page, errors: string[]) {
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.setFixedTime(new Date(NOW));
  const view = fleetView(registry(), NOW);
  await page.route('**/api/**', route => {
    const route_ = new URL(route.request().url()).pathname.slice('/api/'.length);
    if (route_ === 'agent-registry') return route.fulfill({ json: view });
    if (route_ === 'operator-agents') return route.fulfill({ json: operatorAgents });
    if (route_.startsWith('agent-registry/connect')) return route.fulfill({ json: { connects: [], providers: [], hosts: [] } });
    const url = new URL(route.request().url());
    return route.fulfill({ json: boardApi(url.pathname.slice(1) + url.search) });
  });
  await page.goto('/');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', level: 1 })).toBeVisible();
}

async function openSettings(page: Page, tab: string, phone: boolean) {
  const menu = page.getByRole('button', { name: 'Menu' });
  if (phone && await menu.getAttribute('aria-expanded') !== 'true') await menu.click();
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Pages in this section' }).getByRole('button', { name: tab, exact: true }).click();
}

// A UUID, or a JSON object or array printed as text.
const internalId = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const rawJson = /[{[]\s*"[^"]+"\s*:/;
const pages = [
  { tab: 'Agents', heading: 'Agents' },
  { tab: 'Test cases', heading: 'Test-case library' },
  { tab: 'Proof authority', heading: 'Proof authority' },
  { tab: 'Operator automation', heading: 'Operator automation' },
] as const;

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'phone', width: 390, height: 844 }] as const) test(`unit:settings-pages-browser-check — the Agents, settings and automation pages use the shared layout, hide raw JSON and internal ids until expanded, and fit ${viewport.width}px with no console error`, async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await open(page, errors);
  for (const { tab, heading } of pages) {
    await openSettings(page, tab, viewport.name === 'phone');
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    // The shared layout: the page header with its place in Settings, and a heading block.
    await expect(main.locator('header .breadcrumb')).toContainText(/^Settings\s*\/\s*/);
    await expect(main.locator('.page-heading h1')).toHaveCount(1);
    await page.waitForTimeout(200);
    // No sideways scroll at this width.
    const bounds = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, width: document.documentElement.clientWidth }));
    expect(bounds.content, `${tab} fits ${viewport.width}px`).toBeLessThanOrEqual(bounds.width);
    // The default view names no internal id and prints no raw record (closed disclosures are not rendered text).
    const shown = await main.innerText();
    expect(shown, `${tab} shows no internal id`).not.toMatch(internalId);
    expect(shown, `${tab} shows no raw JSON`).not.toMatch(rawJson);
  }

  // What the default view leaves out is one click away: the automation identity's id behind its disclosure.
  const main = page.getByRole('main');
  await main.locator('[data-identity] details summary').click();
  await expect(main.locator('[data-identity] details')).toContainText(identityId);

  // The Agents page answers at a glance: one status per account, and each role's launch verdict.
  await openSettings(page, 'Agents', viewport.name === 'phone');
  const table = main.getByRole('table', { name: 'Accounts at a glance' });
  await expect(table.locator('[data-account-row]')).toHaveCount(4);
  await expect(table.locator('[data-account-row="opencode-a"] [data-chip]')).toHaveText('Spent');
  await expect(table.locator('[data-account-row="cursor-a"] [data-chip]')).toHaveText('Launch failing');
  await expect(table.locator('[data-account-row="claude-b"] [data-chip]')).toHaveText('Idle');
  await expect(table.locator('[data-account-row="spare"] [data-chip]')).toHaveText('No role');
  await expect(table.locator('[data-account-row="opencode-a"]')).toContainText('in 2d 22h');
  await expect(main.locator('[data-role-launch="worker"]')).toHaveText('Workers');
  await expect(main.locator('[data-role-launch="worker"]')).toHaveAttribute('title', 'next: claude-b now');
  await expect(main.locator('[data-role-launch="worker"]')).toBeVisible();

  expect(errors, 'no console error on any settings page').toEqual([]);
});
