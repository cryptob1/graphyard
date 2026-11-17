import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { withDatabase } from '../tests/helpers/postgres';
import { Engine } from '../src/engine';
import { server } from '../src/server';
import { encodeLoopCpu, loopCpuHeader, loopPresenceHeader, loopSupervisionHeader } from '../src/model/loop-presence';
import { coordinationViewHeader } from '../src/server/work-view';

// e2e:dispatch-waits-on-cpu-pressure, e2e:dispatch-waits-on-cpu-temperature — GY-3348: on a served dashboard whose loop names the host's
// CPU on its coordination read exactly as `master run` sends it (X-Graphyard-Loop-Cpu beside its
// presence), the Workers page's header shows CPU pressure (avg60), steal and, since GY-3373, the
// hottest CPU sensor —
// both on a desktop viewport and on a phone's, where the header wraps. e2e:hot-host-budget (GY-3401):
// and the test budget each new session gets, with the trial cap halved while the CPU is hot.

/** The real control plane serving the built dashboard, proxying the page's API reads to it. */
async function plane(context: BrowserContext) {
  const store = await withDatabase('workers_cpu_figures');
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

/** The loop's coordination read seeding the host CPU figures, exactly as `master run` sends it. */
async function seedLoopRead(url: string) {
  const read = await fetch(`${url}/api/work-snapshot`, { headers: {
    Authorization: 'Bearer test-loop',
    [coordinationViewHeader]: 'coordination', [loopPresenceHeader]: '15', [loopSupervisionHeader]: 'autonomous',
    // The rexera reading (GY-3348's episode): avg60 94 with 12 percent steal; and core's 96C (GY-3373).
    // GY-3401: 9 sessions running on 24 cores, and the cap of 4 trials halved at 96C.
    [loopCpuHeader]: encodeLoopCpu({ avg60: 94, steal: 12, celsius: 96, testBudget: 2, trialCap: { now: 2, full: 4 } }),
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
  test(`e2e:dispatch-waits-on-cpu-pressure e2e:dispatch-waits-on-cpu-temperature e2e:hot-host-budget — the Workers page header shows CPU pressure, steal, temperature, test budget and trial cap at ${viewport.width} px`, async ({ page, context }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    const { url, close } = await plane(context);
    try {
      await seedLoopRead(url);
      await openWorkers(page, url);
      const figures = page.locator('.host-cpu');
      await expect(figures).toBeVisible({ timeout: 15_000 });
      await expect(figures).toContainText('Host CPU pressure 94%');
      await expect(figures).toContainText('steal 12%');
      await expect(figures).toContainText('temperature 96°C');
      await expect(figures).toContainText('2 test workers per session');
      await expect(figures).toContainText('trials 2 of 4');
    } finally { await page.close(); await close(); }
  });
}
