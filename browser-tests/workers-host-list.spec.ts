import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from '../tests/helpers/postgres';
import { fakeHosts } from '../tests/helpers/fake-hosts';
import { readHostReadings, type HostReading } from '../src/hosts';
import { defaultChildRun } from '../src/child-runner';
import { Engine } from '../src/engine';
import { server } from '../src/server';
import { encodeLoopHosts, loopHostsHeader, loopPresenceHeader, loopSupervisionHeader } from '../src/model/loop-presence';
import { coordinationViewHeader } from '../src/server/work-view';

// e2e:workers-host-list — GY-3407: on a served dashboard whose loop names its hosts on its
// coordination read exactly as `master run` sends them (X-Graphyard-Loop-Hosts), the Workers page
// lists this machine and an added host with cores, temperature, steal and runs now, and an
// unreachable host as away — on a desktop viewport and on a phone's. The added host is the fixture
// tests/helpers/fake-hosts.ts prepares by running the script `graphyard host prepare` prints, and
// the readings below are read from it through its shim, not invented.

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

/** This machine and the prepared fixture host, as two cycles of the loop really read them. */
async function prepareAndRead(label: string) {
  const hosts = await fakeHosts(label, [{ name: 'prepped' }]);
  await mkdir(join(hosts.root, 'config', 'machine'), { recursive: true });
  const file = join(hosts.root, 'config', 'machine', 'hosts.json');
  await writeFile(file, JSON.stringify([{ target: 'gy-compute@prepped', addedAt: 'x' }, { target: 'gy-compute@gone', addedAt: 'x' }]));
  const run = (command: string, args: string[], options: Parameters<typeof defaultChildRun>[2] = {}) => defaultChildRun(command, args, { ...options, env: { ...process.env, PATH: `${hosts.bin}:${process.env.PATH}` } });
  const first = await readHostReadings([], { file, run, local: 'vishrog' });
  return readHostReadings(first, { file, run, local: 'vishrog' });
}

/** The loop's coordination read naming its hosts, exactly as `master run` sends it. */
async function seedLoopRead(url: string, readings: HostReading[]) {
  const read = await fetch(`${url}/api/work-snapshot`, { headers: {
    Authorization: 'Bearer test-loop',
    [coordinationViewHeader]: 'coordination', [loopPresenceHeader]: '15', [loopSupervisionHeader]: 'autonomous',
    [loopHostsHeader]: encodeLoopHosts(readings),
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
  test(`e2e:workers-host-list — Workers lists this machine and the prepared host with cores, temperature, steal and runs now, an unreachable one away, at ${viewport.width} px`, async ({ page, context }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    const readings = await prepareAndRead(`workers_host_list_${viewport.width}`);
    const { url, close } = await plane(context);
    try {
      await seedLoopRead(url, readings);
      await openWorkers(page, url);
      const hosts = page.getByRole('table', { name: 'Hosts' });
      await expect(hosts).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('heading', { name: 'Hosts', level: 2 })).toBeVisible();
      const local = hosts.locator('[data-host="vishrog"]');
      await expect(local).toContainText('this machine');
      await expect(local.locator('[data-label="Cores"]')).toHaveText(/^\d+$/);
      await expect(local.locator('[data-label="Temperature"]')).toHaveText(/^(\d+°C|—)$/);
      await expect(local.locator('[data-label="Steal"]')).toHaveText(/^\d+%$/);
      await expect(local.locator('[data-label="Runs now"]')).toHaveText('2');
      const added = hosts.locator('[data-host="gy-compute@prepped"]');
      await expect(added.locator('[data-label="Cores"]')).toHaveText(/^\d+$/);
      await expect(added.locator('[data-label="Temperature"]')).toHaveText(/^(\d+°C|—)$/);
      await expect(added.locator('[data-label="Steal"]')).toHaveText(/^\d+%$/);
      await expect(added.locator('[data-label="Runs now"]')).toHaveText('2');
      await expect(hosts.locator('[data-host="gy-compute@gone"]')).toContainText('Away');
      await expect(hosts.locator('[data-host="gy-compute@gone"] [data-label="State"] span')).toHaveAttribute('title', /is unreachable over SSH/);
      await expect(page.locator('[data-hosts-note]')).toHaveText('Added hosts are watched, not given work yet: trials and previews run on this machine.');
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width).toBeLessThanOrEqual(viewport.width);
    } finally { await page.close(); await close(); }
  });
}
