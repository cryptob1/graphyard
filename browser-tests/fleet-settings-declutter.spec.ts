import { mkdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { applyRegistryMutation, emptyRegistry, fleetView, foldObservation, proposedRuntimes, type AgentRegistry, type FleetSession } from '../src/model/registry';
import { NOW, boardApi } from './ui-board';

// GY-1325 AC-5: Settings › Agents over a production-sized fleet — 17 accounts, 6 roles, six of them
// spent until the same day — stays readable. At 1440px the page is at most half the height it
// rendered before the declutter (one row per account, one launch line, spent accounts collapsed),
// and at 390px the accounts table stacks into one card per account with no sideways scroll. Both
// widths are captured to browser-tests/screenshots/after/fleet-settings-declutter-<width>.png.

const hour = 3_600_000, minute = 60_000, host = 'agent-host-1';
const at = (offset: number) => new Date(NOW + offset).toISOString();
/** The Agents page's rendered height at 1440px over this fleet before GY-1325, measured on main 8974038c72. */
const heightBefore = 3_238;
const out = 'browser-tests/screenshots/after';

const runtimes: Record<string, string> = { claude: 'opus', codex: 'gpt', opencode: 'glm', pi: 'glm', cursor: 'gpt', muse: 'opus' };
const names = ['claude-a', 'claude-b', 'claude-c', 'claude-d', 'codex-a', 'codex-b', 'codex-c', 'opencode-a', 'opencode-b', 'opencode-c', 'pi-a', 'pi-b', 'pi-c', 'cursor-a', 'cursor-b', 'muse-a', 'muse-b'];
const spent = ['claude-a', 'claude-c', 'opencode-a', 'opencode-b', 'pi-a', 'pi-b'];

function registry(): AgentRegistry {
  const all = names.filter(name => !name.startsWith('muse'));
  const document = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: proposedRuntimes.filter(runtime => runtime.name in runtimes),
    models: [{ name: 'opus', id: 'claude-opus-5' }, { name: 'gpt', id: 'gpt-5.5-codex' }, { name: 'glm', id: 'zai/glm-5.3' }],
    accounts: names.map(name => ({ name, runtime: name.split('-')[0], model: runtimes[name.split('-')[0]], credential: { host, home: `/home/agent/.coding_agents/${name}` } })),
    roles: [
      { name: 'worker', accounts: all, concurrency: 6 },
      { name: 'reviewer', accounts: ['claude-b', 'codex-a', 'codex-b', 'claude-a'], concurrency: 3 },
      { name: 'producer', accounts: ['codex-b', 'pi-c', 'opencode-c', 'muse-a'], concurrency: 3 },
      { name: 'approver', accounts: ['claude-d', 'codex-b', 'muse-b'], concurrency: 1 },
      { name: 'escalation-handler', accounts: ['claude-d', 'codex-c'], concurrency: 1 },
      { name: 'master', accounts: ['claude-d'], concurrency: 1 },
    ],
    reason: 'production-sized fleet',
  }, { actor: 'coordinator', at: at(-6 * hour) }).registry;
  const resetsAt = at(3 * 24 * hour + 2 * hour);
  for (const account of document.accounts) foldObservation(account, spent.includes(account.name)
    ? { loggedIn: true, state: 'exhausted', usage: [{ window: '5h', percent: 4 }, { window: '7d', percent: 100, resetsAt }].map(entry => ({ resetsAt: null, ...entry })), resetsAt, reason: 'weekly window spent' }
    : { loggedIn: true, state: 'available', usage: account.runtime === 'claude' || account.runtime === 'codex' ? [{ window: '5h', percent: 31, resetsAt: at(2 * hour) }, { window: '7d', percent: 58, resetsAt: at(4 * 24 * hour) }] : [], resetsAt: null, reason: null },
  { actor: 'coordinator', at: at(-5 * minute) });
  document.accounts.find(account => account.name === 'cursor-a')!.smoke = { result: 'fail', reason: 'the model refused the smoke prompt', at: at(-10 * minute), by: 'coordinator' };
  const session = (n: number, role: FleetSession['role'], account: string, work: string): FleetSession => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, role, account, runtime: account.split('-')[0], model: runtimes[account.split('-')[0]], host, work, principal: 'agent',
    selectedAt: at(-n * minute), selectedBy: 'coordinator', reason: `${account} is the first eligible account for ${role}`, skipped: [], endedAt: null, endReason: null });
  document.sessions = [session(1, 'worker', 'claude-b', 'GY-1236'), session(2, 'reviewer', 'claude-b', 'GY-1315'), session(3, 'worker', 'codex-a', 'GY-1320'), session(4, 'master', 'claude-d', 'GY-1325'), session(5, 'producer', 'codex-c', 'GY-1310')];
  return document;
}

async function openAgents(page: Page, phone: boolean) {
  await page.clock.setFixedTime(new Date(NOW));
  const view = fleetView(registry(), NOW);
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname.slice('/api/'.length);
    if (path === 'agent-registry') return route.fulfill({ json: view });
    if (path.startsWith('agent-registry/connect')) return route.fulfill({ json: { connects: [], providers: [], hosts: [] } });
    const url = new URL(route.request().url());
    return route.fulfill({ json: boardApi(url.pathname.slice(1) + url.search) });
  });
  await page.goto('/');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', level: 1 })).toBeVisible();
  if (phone) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Pages in this section' }).getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(page.getByRole('main').getByRole('table', { name: 'Accounts at a glance' })).toBeVisible();
  await page.waitForTimeout(250);
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }] as const) test(`manual:fleet-settings-declutter-screenshots — Settings › Agents over 17 accounts and 6 roles at ${viewport.width}px: no sideways scroll, ${viewport.width === 1440 ? 'at most half its former height' : 'one card per account'}`, async ({ page }) => {
  test.setTimeout(60_000);
  mkdirSync(out, { recursive: true });
  await page.setViewportSize(viewport);
  await openAgents(page, viewport.width < 650);
  const table = page.getByRole('main').getByRole('table', { name: 'Accounts at a glance' });
  const bounds = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, width: document.documentElement.clientWidth, height: document.documentElement.scrollHeight }));
  expect(bounds.content, `fits ${viewport.width}px`).toBeLessThanOrEqual(bounds.width);
  console.log(`fleet-settings-declutter ${viewport.width}px: ${bounds.height}px tall`);
  await page.screenshot({ path: `${out}/fleet-settings-declutter-${viewport.width}.png`, fullPage: true });
  // Every account is one row; the six spent until the same day sit behind one summary row.
  await expect(table.locator('[data-account-row]')).toHaveCount(names.length);
  await expect(table.locator('[data-spent-summary]')).toHaveCount(1);
  await expect(table.locator('[data-spent-summary]')).toContainText(`6 spent until`);
  for (const name of spent) await expect(table.locator(`[data-account-row="${name}"]`)).toBeHidden();
  if (viewport.width === 1440) expect(bounds.height, `at most half of ${heightBefore}px`).toBeLessThanOrEqual(heightBefore / 2);
  else {
    // Stacked: each visible account row is one card the width of the table, no wider than the screen.
    const cards = await table.locator('[data-account-row]:visible').evaluateAll(rows => rows.map(row => { const box = row.getBoundingClientRect(); return { display: getComputedStyle(row).display, right: box.right }; }));
    expect(cards.length).toBe(names.length - spent.length);
    for (const card of cards) { expect(card.display).toBe('block'); expect(card.right).toBeLessThanOrEqual(viewport.width); }
  }
  // A click on the summary opens the spent accounts' own rows.
  await table.locator('[data-spent-summary] button').click();
  for (const name of spent) await expect(table.locator(`[data-account-row="${name}"]`)).toBeVisible();
  const opened = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(opened, 'still no sideways scroll with the spent rows open').toBe(true);
});
