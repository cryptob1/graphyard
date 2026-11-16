import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { withDatabase } from '../tests/helpers/postgres';
import { Engine } from '../src/engine';
import { server } from '../src/server';
import { encodeLoopHosts, loopHostsHeader, loopPresenceHeader, loopSupervisionHeader } from '../src/model/loop-presence';
import { coordinationViewHeader } from '../src/server/work-view';

// e2e:workers-host-list — GY-3407: on a served dashboard whose loop names its hosts on its
// coordination read exactly as `master run` sends them (X-Graphyard-Loop-Hosts), the Workers page
// lists this machine and an added host with cores, temperature, steal and runs now, and an
// unreachable host as away — on a desktop viewport and on a phone's.

/** The real control plane serving the built dashboard, proxying the page's API reads to it. */
async function plane(context: BrowserContext) {
  const store = await withDatabase('workers_host_list');
  await store.init();
  const engine = new Engine(store, 120, 'fixture/shop');
  engine.gitRunner = null;
  const http = server(engine, [
    { id: 'operator', role: 'admin', sessionKind: 'human', token: 'test-human-operator' },
    { id: 'loop', role: 'coordinator', sessionKind: 'ai', token: 'test-loop' },
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

/** The loop's coordination read naming its hosts, exactly as `master run` sends it. */
async function seedLoopRead(url: string) {
  const read = await fetch(`${url}/api/work-snapshot`, { headers: {
    Authorization: 'Bearer test-loop',
    [coordinationViewHeader]: 'coordination', [loopPresenceHeader]: '15', [loopSupervisionHeader]: 'autonomous',
    [loopHostsHeader]: encodeLoopHosts([
      { host: 'vishrog', local: true, away: false, cores: 24, celsius: 71, steal: 0, runs: 3 },
      { host: 'vish@vish-rexera', away: false, cores: 8, celsius: null, steal: 14, runs: 0 },
      { host: 'vish@old-laptop', away: true, reason: 'vish@old-laptop is unreachable over SSH: ssh: connect to host old-laptop port 22: Connection refused', cores: null, celsius: null, steal: null, runs: null },
    ]),
  } });
  expect(read.status).toBe(200);
}

async function openWorkers(page: Page, url: string) {
  const signIn = await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } });
  expect(signIn.status).toBe(200);
  const { code } = await signIn.json() as { code: string };
  await page.goto(`/#sign-in=${code}`);
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
  if (viewportWidth(page) < 650) await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.locator('[data-nav="workers"]').click();
  await expect(page.getByRole('heading', { name: 'Workers', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
}

const viewportWidth = (page: Page) => page.viewportSize()?.width ?? 1280;

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`e2e:workers-host-list — Workers lists this machine and added hosts with cores, temperature, steal and runs now, an unreachable one away, at ${viewport.width} px`, async ({ page, context }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    const { url, close } = await plane(context);
    try {
      await seedLoopRead(url);
      await openWorkers(page, url);
      const hosts = page.getByRole('table', { name: 'Hosts' });
      await expect(hosts).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('heading', { name: 'Hosts', level: 2 })).toBeVisible();
      const local = hosts.locator('[data-host="vishrog"]');
      await expect(local).toContainText('this machine');
      await expect(local.locator('[data-label="Cores"]')).toHaveText('24');
      await expect(local.locator('[data-label="Temperature"]')).toHaveText('71°C');
      await expect(local.locator('[data-label="Steal"]')).toHaveText('0%');
      await expect(local.locator('[data-label="Runs now"]')).toHaveText('3');
      const added = hosts.locator('[data-host="vish@vish-rexera"]');
      await expect(added.locator('[data-label="Cores"]')).toHaveText('8');
      await expect(added.locator('[data-label="Temperature"]')).toHaveText('—');
      await expect(added.locator('[data-label="Steal"]')).toHaveText('14%');
      await expect(added.locator('[data-label="Runs now"]')).toHaveText('0');
      await expect(hosts.locator('[data-host="vish@old-laptop"]')).toContainText('Away');
      await expect(hosts.locator('[data-host="vish@old-laptop"] [data-label="State"] span')).toHaveAttribute('title', /is unreachable over SSH/);
      await expect(page.locator('[data-hosts-note]')).toHaveText('Added hosts are watched, not given work yet: trials and previews run on this machine.');
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width).toBeLessThanOrEqual(viewport.width);
    } finally { await page.close(); await close(); }
  });
}
