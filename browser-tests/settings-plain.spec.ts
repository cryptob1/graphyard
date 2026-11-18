import { test, expect, type Page } from '@playwright/test';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, fleetView, foldObservation, proposedRuntimes, type AgentRegistry } from '../src/model/registry';
import { NOW, boardApi } from './ui-board';

// GY-3482: the Settings pages read in plain words. With an automation identity, an account whose
// smoke test the provider refused with a 429 JSON body and a live master seeded, Operator
// automation, Agents and Setup show short facts, no bootstrap policy text, raw provider error or
// capability string outside a fold or a title, and keep the identifiers one click away.

const hour = 3_600_000, minute = 60_000, host = 'agent-host-1';
const identityId = '7d0c2a8e-3b1f-4c55-9a0e-5f1b6c2d9e41';
const rawError = '429 Too Many Requests: {"code":"rate_limit_exceeded","message":"You have hit your usage limit"}';
const day = (at: number) => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

function registry(): AgentRegistry {
  const document = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude'),
    models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: ['spent-a', 'claude-b', 'claude-m'].map(name => ({ name, runtime: 'claude', model: 'opus', credential: { host, home: `/home/agent/.coding_agents/${name}` } })),
    roles: [{ name: 'worker', accounts: ['spent-a', 'claude-b'], concurrency: 2 }, { name: 'reviewer', accounts: ['spent-a'], concurrency: 1 }, { name: 'master', accounts: ['claude-m'], concurrency: 1 }],
    reason: 'settings plain fixture',
  }, { actor: 'coordinator', at: new Date(NOW - 2 * hour).toISOString() }).registry;
  for (const account of document.accounts) foldObservation(account, { loggedIn: true, state: 'available', usage: [], resetsAt: null, reason: null }, { actor: 'coordinator', at: new Date(NOW - minute).toISOString() });
  document.accounts[0].smoke = { result: 'fail', reason: rawError, at: new Date(NOW - 10 * minute).toISOString(), by: 'coordinator' };
  document.sessions = [{ id: '00000000-0000-4000-8000-000000348201', role: 'master', account: 'claude-m', runtime: 'claude', model: 'opus', host, work: null, principal: 'agent',
    selectedAt: new Date(NOW - hour).toISOString(), selectedBy: 'coordinator', reason: 'first eligible', skipped: [], endedAt: null, endReason: null }] as any;
  return document;
}

const operatorAgents = [{ id: identityId, displayName: 'Master loop', capabilities: ['work.create', 'work.release'], scope: { repositories: ['fixture/shop'], workItems: [] }, fingerprints: ['sha256:4f2a9c0e'], revision: 3, revokedAt: null,
  lastMutation: { kind: 'create', actor: 'operator', at: new Date(NOW - 5 * hour).toISOString(), reason: 'Scoped master loop' } }];

async function open(page: Page, alerts: number | false) {
  await page.clock.setFixedTime(new Date(NOW));
  const view = fleetView(registry(), NOW);
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url()), path = url.pathname.slice('/api/'.length);
    if (path === 'agent-registry') return route.fulfill({ json: view });
    if (path === 'operator-agents') return route.fulfill({ json: operatorAgents });
    if (path.startsWith('agent-registry/connect')) return route.fulfill({ json: { connects: [], providers: [], hosts: [] } });
    const json = boardApi(url.pathname.slice(1) + url.search);
    return route.fulfill({ json: path === 'status' ? { ...json, setup: { ...(json as any).setup, alerts } } : json });
  });
  await page.goto('/?sign-in');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', level: 1 })).toBeVisible();
}

async function openTab(page: Page, tab: string, heading: string) {
  const menu = page.getByRole('button', { name: 'Menu' });
  if (page.viewportSize()!.width <= 650 && await menu.getAttribute('aria-expanded') !== 'true') await menu.click();
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Settings', exact: true }).click();
  const tabs = page.getByRole('navigation', { name: 'Pages in this section' });
  if (tab === 'Operator automation') await tabs.getByText('Advanced', { exact: true }).click();
  await tabs.getByRole('button', { name: tab, exact: true }).click();
  await expect(page.getByRole('main').getByRole('heading', { name: heading, level: 1 })).toBeVisible();
}

/** The page as read without opening anything: closed folds and titles are not rendered text. */
async function plain(page: Page, label: string) {
  const shown = (await page.getByRole('main').innerText()).toLowerCase();
  for (const word of ['bootstrap', 'scoped', 'policy:', '{"code"', 'cannot launch master']) expect(shown, `${label} shows "${word}"`).not.toContain(word);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways, `${label} scrolls sideways`).toBeLessThanOrEqual(0);
}

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'phone', width: 390, height: 844 }]) test(`e2e:settings-plain — Settings pages read in plain words at ${viewport.width}px`, async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize(viewport);
  await open(page, false);
  const main = page.getByRole('main');

  // Operator automation: a count, one line per identity, everything else in its Details.
  await openTab(page, 'Operator automation', 'Operator automation');
  await expect(main.locator('.page-fact')).toHaveText('1 automation identity, 1 active.');
  await expect(main.locator('[data-identity] strong')).toHaveText('Master loop · active');
  await expect(main.locator('[data-identity]')).toContainText(`Changed ${day(NOW - 5 * hour)}`);
  await expect(main.getByText('Capabilities:')).toBeHidden();
  await plain(page, 'Operator automation');
  await main.locator('[data-identity] details summary').click();
  await expect(main.locator('[data-identity] details')).toContainText(identityId);
  await expect(main.locator('[data-identity] details')).toContainText('work.create, work.release');

  // Agents: one fact, one row per role, a short phrase for the provider's error with the raw body in its title.
  await openTab(page, 'Agents', 'Agents');
  await expect(main.locator('.page-fact')).toHaveText('1 of 3 roles ready · 3 accounts');
  await expect(main.locator('[data-role-launch="worker"]')).toHaveText('Workers · ready (claude-b)');
  await expect(main.locator('[data-role-launch="master"]')).toHaveText('Master · running (claude-m)');
  await expect(main.locator('[data-role-launch="reviewer"]')).toHaveText(`Reviewers · waiting: limit reached until ${day(NOW + 20 * minute)}`);
  const why = main.locator('[data-account-row="spent-a"] td.why');
  await expect(why).toHaveText(`Limit reached · back ${day(NOW + 20 * minute)}`);
  await expect(why).toHaveAttribute('title', /\{"code":"rate_limit_exceeded"/);
  await expect(main.locator('details.more-details > summary')).toContainText(['Account details', 'Roles', 'Runtimes']);
  await plain(page, 'Agents');
  await main.locator('details.more-details > summary', { hasText: 'Account details' }).click();
  await expect(main.locator('details.more-details', { hasText: 'Account details' })).toContainText('/home/agent/.coding_agents/spent-a');

  // Setup: stall alerts in one line, the terminal commands in one closed fold.
  await openTab(page, 'Setup', 'Set up Graphyard');
  await expect(main.locator('[data-alerts] p').first()).toHaveText('Stall alerts: off');
  await expect(main.getByText('run.alertUrl')).toBeHidden();
  const terminal = main.locator('details', { hasText: 'Watch agents in a terminal' });
  await expect(terminal).not.toHaveAttribute('open', '');
  await expect(main.locator('[data-herdr-command]').first()).toBeHidden();
  await plain(page, 'Setup');
  await terminal.locator('summary').click();
  await expect(main.locator('[data-herdr-command="local"]')).toBeVisible();
  await main.locator('[data-alerts] summary').click();
  await expect(main.getByText('run.alertUrl')).toBeVisible();
});

test('e2e:settings-plain — stall alerts that are on read with their window', async ({ page }) => {
  await open(page, 20);
  await openTab(page, 'Setup', 'Set up Graphyard');
  await expect(page.getByRole('main').locator('[data-alerts] p').first()).toHaveText('Stall alerts: on (after 20 min)');
});
