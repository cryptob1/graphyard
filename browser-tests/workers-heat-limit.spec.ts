import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { withDatabase } from '../tests/helpers/postgres';
import { Engine } from '../src/engine';
import { server } from '../src/server';
import { encodeLoopCpu, loopCpuHeader, loopPresenceHeader, loopSupervisionHeader } from '../src/model/loop-presence';
import { coordinationViewHeader } from '../src/server/work-view';

// e2e:heat-limit-laptop (GY-3416): the Workers page header beside the sessions carries what a hot
// laptop's loop read — the hottest package or core sensor (96C) and the trial cap halved by the
// heat. Since GY-3501 the reading holds no launch, so no launches-waiting word serves beside them.

/** The real control plane serving the built dashboard, proxying the page's API reads to it. */
async function plane(context: BrowserContext) {
  const store = await withDatabase('workers_heat_limit');
  await store.init();
  const engine = new Engine(store, 120, 'fixture/laptop');
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

/** The loop's coordination read seeding the laptop's reading, exactly as `master run` sends it. */
async function seedLoopRead(url: string) {
  const read = await fetch(`${url}/api/work-snapshot`, { headers: {
    Authorization: 'Bearer test-loop',
    [coordinationViewHeader]: 'coordination', [loopPresenceHeader]: '15', [loopSupervisionHeader]: 'autonomous',
    // The operator's reading (GY-3416's episode): package 95C, core 16 at 96C, against a 105C
    // critical — over the 85C limit, so the cap of 4 trials is halved; the heat holds no launch.
    [loopCpuHeader]: encodeLoopCpu({ avg60: 20, steal: 0, celsius: 96, trialCap: { now: 2, full: 4 } }),
  } });
  expect(read.status).toBe(200);
}

async function openWorkers(page: Page, url: string) {
  const signIn = await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } });
  expect(signIn.status).toBe(200);
  const { code } = await signIn.json() as { code: string };
  await page.goto(`/#sign-in=${code}`);
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-nav="workers"]').click();
  await expect(page.getByRole('heading', { name: 'Workers', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
}

test('e2e:heat-limit-laptop — the Workers page header shows the laptop\'s hot reading and the halved trial cap', async ({ page, context }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const { url, close } = await plane(context);
  try {
    await seedLoopRead(url);
    await openWorkers(page, url);
    const figures = page.locator('.host-cpu');
    await expect(figures).toBeVisible({ timeout: 15_000 });
    await expect(figures).toContainText('temperature 96°C');
    await expect(figures).toContainText('trials 2 of 4');
  } finally { await page.close(); await close(); }
});
