import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { withDatabase } from '../tests/helpers/postgres';
import { Engine } from '../src/engine';
import { server } from '../src/server';
import { proposedRuntimes } from '../src/model/registry';

// e2e:account-availability-one-authority — GY-3555: on a served dashboard, the Workers page lists
// each account as its own last live request decided it, one line each: available, held until the
// reset the provider stated in its words, or broken in its words, with when it was checked live.
// The quotas reach the control plane as an executor reports them (POST agent-registry/observe).

const HOST = 'build-host';
const weekly = "You've hit your weekly limit, resets Nov 21, 9pm (America/Los_Angeles)";
const fragment = 't":0,"concurrency_limit":0,"budget":0},"by_type":{';

async function plane(context: BrowserContext) {
  const store = await withDatabase(`availability_${randomUUID().slice(0, 8).replace(/-/g, '')}`);
  await store.init();
  const engine = new Engine(store, 120, 'fixture/shop');
  engine.gitRunner = null;
  const http = server(engine, [
    { id: 'operator', role: 'admin', sessionKind: 'human', token: 'test-human-operator' },
    { id: 'executor', role: 'coordinator', sessionKind: 'ai', token: 'test-executor' },
  ]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  await context.route('**/*', async route => {
    const { pathname, search } = new URL(route.request().url());
    await route.fetch(pathname.startsWith('/api/') ? { url: url + pathname + search } : {})
      .then(response => route.fulfill({ response }), () => route.abort('connectionrefused'));
  });
  const close = async () => { await context.unrouteAll(); await new Promise<void>(resolve => http.close(() => resolve())); await store.close(); };
  return { url, close };
}

async function post(url: string, token: string, path: string, body: unknown) {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** Three accounts, each with the live result its executor reported: one passed, one refused for its weekly limit, one failed otherwise. */
async function seed(url: string) {
  const runtime = proposedRuntimes.find(entry => entry.name === 'claude')!;
  const names = ['claude-a', 'claude-b', 'claude-with-a-long-account-name-c'];
  await post(url, 'test-human-operator', 'agent-registry/apply', { runtimes: [runtime], models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: names.map(name => ({ name, runtime: 'claude', model: 'opus', credential: { host: HOST, home: `/home/operator/.coding_agents/${name}` } })),
    roles: [{ name: 'worker', accounts: names, concurrency: 1 }], reason: 'availability e2e' });
  const since = new Date(Date.now() - 4 * 60_000).toISOString(), reset = new Date(Date.now() + 2 * 86_400_000).toISOString();
  await post(url, 'test-executor', 'agent-registry/observe', { host: HOST, observations: [
    { account: 'claude-a', quota: { loggedIn: true, state: 'available', usage: [], resetsAt: null, reason: null, since } },
    { account: 'claude-b', quota: { loggedIn: true, state: 'exhausted', usage: [], resetsAt: reset, reason: weekly, since, session: 'named' } },
    { account: names[2], quota: { loggedIn: true, state: 'broken', usage: [], resetsAt: null, reason: fragment, since } },
  ] });
  return reset;
}

async function openWorkers(page: Page, url: string) {
  const signIn = await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } });
  expect(signIn.status).toBe(200);
  const { code } = await signIn.json() as { code: string };
  await page.goto(`/#sign-in=${code}`);
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
  if ((page.viewportSize()?.width ?? 1280) < 650) await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.locator('[data-nav="workers"]').click();
  await expect(page.getByRole('heading', { name: 'Workers', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`e2e:account-availability-one-authority — Workers lists each account as available, held until the provider's reset in its words, or broken, with its last live check, one line each, at ${viewport.width} px`, async ({ page, context }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    const { url, close } = await plane(context);
    try {
      const reset = await seed(url);
      await openWorkers(page, url);
      const list = page.getByRole('list', { name: 'Account availability' });
      await expect(list).toBeVisible({ timeout: 15_000 });
      const row = (name: string) => list.locator(`[data-availability-row="${name}"]`);
      await expect(row('claude-a')).toHaveAttribute('data-state', 'available');
      await expect(row('claude-a')).toHaveAttribute('title', /^claude-a · available · checked live 4m \d\ds ago$/);
      await expect(row('claude-b')).toHaveAttribute('data-state', 'held');
      const until = await page.evaluate(iso => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), reset);
      const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await expect(row('claude-b')).toHaveAttribute('title', new RegExp(`^claude-b · held until ${escape(until)} · checked live 4m \\d\\ds ago · ${escape(weekly)}$`));
      const broken = row('claude-with-a-long-account-name-c');
      await expect(broken).toHaveAttribute('data-state', 'broken');
      await expect(broken).toHaveAttribute('title', new RegExp(`· broken · checked live 4m \\d\\ds ago · ${escape(fragment)}$`));
      // One line each: every row is one text line high, and nothing scrolls sideways.
      for (const name of ['claude-a', 'claude-b', 'claude-with-a-long-account-name-c']) {
        const { height, lineHeight } = await row(name).evaluate(element => ({ height: element.clientHeight, lineHeight: parseFloat(getComputedStyle(element).lineHeight) || 18 }));
        expect(height, name).toBeLessThan(lineHeight * 2 + 16);
      }
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width).toBeLessThanOrEqual(viewport.width);
    } finally { await page.close(); await close(); }
  });
}
