import { test, expect, type Page } from '@playwright/test';
import { applyRegistryMutation, emptyRegistry, fleetView, proposedRuntimes, type AgentRegistry, type FleetSession } from '../src/model/registry';

// GY-170 AC-3: Settings › Agents lists, from the agent registry, every runtime; every account with
// its host, credential home, login, quota state and reset time; the role mapping and each role's
// launch policy; and which account each running session was launched on. It never shows a secret
// and refuses to send one. The page is served the exact view `GET /api/agent-registry` returns,
// computed by the real `fleetView` over a registry built with the real mutations.

const host = 'agent-host-1', now = Date.now(), hour = 3_600_000;
const resetsAt = new Date(now + 5 * hour).toISOString();
const at = (offset: number) => new Date(now + offset).toISOString();

function registry(): AgentRegistry {
  let document = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: proposedRuntimes.filter(runtime => ['claude', 'codex', 'pi'].includes(runtime.name)),
    models: [{ name: 'opus', id: 'claude-opus-5' }, { name: 'sonnet', id: 'claude-sonnet-5' }, { name: 'gpt', id: 'gpt-5.5-codex' }, { name: 'glm', id: 'zai/glm-5.3' }],
    accounts: [
      { name: 'claude-a', runtime: 'claude', model: 'opus', credential: { host, home: '/home/agent/.coding_agents/claude-a' } },
      { name: 'claude-b', runtime: 'claude', model: 'opus', credential: { host, home: '/home/agent/.coding_agents/claude-b' } },
      { name: 'codex', runtime: 'codex', model: 'gpt', credential: { host, home: '/home/agent/.coding_agents/codex' } },
      { name: 'pi-b', runtime: 'pi', model: 'glm', credential: { host: 'agent-host-2', home: '/home/agent/.coding_agents/pi-b' } },
    ],
    roles: [
      { name: 'worker', accounts: ['claude-a', 'claude-b', 'codex'], concurrency: 4, policy: { args: ['--permission-mode', 'bypassPermissions'], tools: [], model: null } },
      { name: 'reviewer', accounts: ['codex', 'claude-b'], concurrency: 2 },
      { name: 'approver', accounts: ['pi-b', 'claude-b'], concurrency: 1, policy: { args: ['--thinking', 'low'], tools: ['read', 'bash'], model: 'glm' } },
      { name: 'producer', accounts: ['claude-b', 'pi-b'], concurrency: 3, policy: { args: [], tools: ['Read', 'Bash(npm test:*)'], model: 'sonnet' } },
    ],
    reason: 'Proposed from ~/.coding_agents on agent-host-1',
  }, { actor: 'coordinator', at: at(-2 * hour) }).registry;
  document = applyRegistryMutation(document, 'account.quota', { name: 'claude-a', quota: { loggedIn: true, state: 'exhausted', usage: [{ window: '7d', percent: 100, resetsAt }], resetsAt, reason: 'weekly window spent' }, reason: 'observed' }, { actor: 'coordinator', at: at(-hour) }).registry;
  document = applyRegistryMutation(document, 'account.quota', { name: 'codex', quota: { loggedIn: false, state: 'unknown', usage: [], resetsAt: null, reason: null }, reason: 'observed' }, { actor: 'coordinator', at: at(-hour) }).registry;
  document = applyRegistryMutation(document, 'account.quota', { name: 'claude-b', quota: { loggedIn: true, state: 'available', usage: [{ window: '5h', percent: 12, resetsAt: null }], resetsAt: null, reason: null }, reason: 'observed' }, { actor: 'coordinator', at: at(-hour) }).registry;
  const session = (id: string, role: FleetSession['role'], account: string, runtime: string, model: string, work: string, ended = false): FleetSession => ({ id, role, account, runtime, model, host, work, principal: 'agent',
    selectedAt: at(-10 * 60_000), selectedBy: 'coordinator', reason: `${account} is the first eligible account for ${role}`, skipped: [], endedAt: ended ? at(-60_000) : null, endReason: ended ? 'the run ended' : null });
  document.sessions = [
    session('00000000-0000-4000-8000-000000000001', 'worker', 'claude-b', 'claude', 'opus', 'GY-170'),
    session('00000000-0000-4000-8000-000000000002', 'producer', 'claude-b', 'claude', 'sonnet', 'GY-169'),
    session('00000000-0000-4000-8000-000000000003', 'reviewer', 'codex', 'codex', 'gpt', 'GY-168', true),
  ];
  return document;
}

async function open(page: Page) {
  const posted: string[] = [];
  const view = fleetView(registry(), now);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (route.request().headers().authorization !== 'Bearer browser-fixture') return route.fulfill({ status: 401, json: { error: 'Rejected' } });
    if (route.request().method() === 'POST') { posted.push(url.pathname); return route.fulfill({ json: {} }); }
    if (url.pathname === '/api/agent-registry') return route.fulfill({ json: view });
    if (url.pathname.endsWith('/status')) return route.fulfill({ json: { actor: { id: 'fixture', role: 'admin' }, github: true, reviewProviders: ['github'], repository: 'fixture/repository', jobs: [], fleet: view } });
    if (url.pathname.endsWith('/work-snapshot')) return route.fulfill({ json: { work: [], now: new Date(now).toISOString(), jobs: [] } });
    return route.fulfill({ json: [] });
  });
  await page.goto('/');
  await page.getByLabel('Access token').fill('browser-fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  const menu = page.getByRole('button', { name: 'Menu' });
  if (page.viewportSize()!.width <= 650 && await menu.getAttribute('aria-expanded') !== 'true') await menu.click();
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Pages in this section' }).getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible();
  return { posted };
}

// What a pasted credential looks like anywhere on the page: provider keys, tokens, a bearer header, a PEM block, a JWT.
const secretShaped = /\bsk-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{8,}|github_pat_|\bxox[abp]-|Bearer\s+[A-Za-z0-9._-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|browser-fixture/;

test('integration:agents-settings-page — Settings › Agents renders every runtime, account, role mapping and policy from the registry, the account of each running session, and no secret', async ({ page }) => {
  const { posted } = await open(page);
  const main = page.getByRole('main');

  // Runtimes, each with its launch contract.
  await expect(main.locator('[data-runtime]')).toHaveCount(3);
  for (const runtime of ['claude', 'codex', 'pi']) await expect(main.locator(`[data-runtime="${runtime}"] strong`)).toHaveText(new RegExp(`^${runtime}`));
  await expect(main.locator('[data-runtime="pi"]')).toContainText('account home in PI_CODING_AGENT_DIR');
  await expect(main.locator('[data-runtime="pi"]')).toContainText('tools flag --tools');

  // Every account: host, credential home, login, quota state and reset time.
  const resetShown = await page.evaluate(iso => new Date(iso).toLocaleString(), resetsAt);
  const account = (name: string) => main.locator(`[data-account="${name}"]`);
  await expect(account('claude-a')).toContainText('Credential by reference: /home/agent/.coding_agents/claude-a on agent-host-1');
  await expect(account('claude-a')).toContainText('Login: logged in');
  await expect(account('claude-a')).toContainText('Quota: exhausted — 7d 100%');
  await expect(account('claude-a')).toContainText(`Resets: ${resetShown}`);
  await expect(account('claude-b')).toContainText('Quota: available');
  await expect(account('codex')).toContainText('Login: logged out');
  await expect(account('pi-b')).toContainText('/home/agent/.coding_agents/pi-b on agent-host-2');
  await expect(account('pi-b')).toContainText('Login: not observed');

  // The role mapping and each role's launch policy.
  const role = (name: string) => main.locator(`[data-role="${name}"]`);
  await expect(role('worker')).toContainText('Preference order: claude-a → claude-b → codex');
  await expect(role('worker')).toContainText('Launch policy: flags --permission-mode bypassPermissions · every tool the runtime allows · each account\'s own model');
  await expect(role('reviewer')).toContainText('Preference order: codex → claude-b');
  await expect(role('reviewer')).toContainText('Launch policy: no extra flags');
  await expect(role('approver')).toContainText('Preference order: pi-b → claude-b');
  await expect(role('approver')).toContainText('Launch policy: flags --thinking low · tools read, bash · model glm');
  await expect(role('producer')).toContainText('tools Read, Bash(npm test:*) · model sonnet');

  // Which account each running session was launched on; an ended session is not running.
  const running = main.getByRole('table', { name: 'Running sessions by account' });
  await expect(running.locator('tbody tr')).toHaveCount(2);
  await expect(running.locator('tr[data-session="00000000-0000-4000-8000-000000000001"]')).toContainText(/worker\s*GY-170\s*claude-b\s*claude\s*opus\s*agent-host-1/);
  await expect(running.locator('tr[data-session="00000000-0000-4000-8000-000000000002"]')).toContainText(/producer\s*GY-169\s*claude-b\s*claude\s*sonnet/);
  await expect(running).not.toContainText('GY-168');

  // No secret-shaped string anywhere on the page, rendered or in its markup.
  expect(await main.innerText()).not.toMatch(secretShaped);
  expect(await page.content()).not.toMatch(secretShaped);

  // The default view is the account cards and one connect button; every registry form waits behind a collapsed Advanced.
  await expect(main.locator('[data-connect-account]')).toBeVisible();
  const advanced = main.locator('details.advanced');
  await expect(advanced).not.toHaveAttribute('open', '');
  expect(await main.locator('input:visible, select:visible, textarea:visible').count()).toBe(0);
  await advanced.locator('summary').click();

  // A pasted credential is refused in the browser and never sent.
  const form = main.getByRole('form', { name: 'Set a role' });
  await form.getByLabel('Accounts, most preferred first').fill('claude-b');
  await form.getByLabel('Allowed tools').fill('Read, sk-ant-api03-abcdefghijklmnop');
  await form.getByLabel('Audit reason').fill('Pasting a key by mistake');
  await form.getByRole('button', { name: 'Save role' }).click();
  await expect(main.getByRole('alert').filter({ hasText: 'That looks like a credential' })).toBeVisible();
  expect(posted).toEqual([]);

  // Without one, the role and its policy are sent to the registry.
  await form.getByLabel('Allowed tools').fill('Read, Grep');
  await form.getByRole('button', { name: 'Save role' }).click();
  await expect.poll(() => posted).toEqual(['/api/agent-registry/roles']);
});
