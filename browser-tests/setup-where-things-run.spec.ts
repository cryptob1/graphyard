import { test, expect, type BrowserContext } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withDatabase } from '../tests/helpers/postgres';
import { Engine } from '../src/engine';
import { server } from '../src/server';
import { encodeLoopWhere, loopWhereHeader } from '../src/model/where-things-run';
import { encodeLoopPanes, loopPanesHeader, loopPresenceHeader, loopSupervisionHeader } from '../src/model/loop-presence';
import { coordinationViewHeader } from '../src/server/work-view';
import { loopWhereReport } from '../src/master/where';
import { temporaryDirectory } from '../tests/helpers/temp-dirs';

// e2e:setup-where-things-run — GY-3277: on a fixture install's served dashboard, the Setup page's
// 'Where things run' panel shows that install's loop and deploy unit names, server and database
// container names, port, URL, checkout and install directories and master pane. The coordinator
// read seeds the report exactly as the loop sends it — the where header beside its presence and
// panes — so the panel answers from the loop's own report, not from a fixture the page invented.

test('e2e:setup-where-things-run — the Setup page\'s Where things run panel names this install\'s units, containers, port, URL, directories and master pane', async ({ page, context, baseURL }) => {
  // Booting embedded Postgres alone takes ~11 s solo and several times that under the full parallel suite.
  test.setTimeout(120_000);
  const store = await withDatabase('setup_where_things_run');
  await store.init();
  const engine = new Engine(store, 120, 'fixture/shop');
  engine.gitRunner = null;
  const http = server(engine, [
    { id: 'operator', role: 'admin', sessionKind: 'human', token: 'test-human-operator' },
    { id: 'loop', role: 'coordinator', sessionKind: 'ai', token: 'test-loop' },
  ]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const proxy = async (browserContext: BrowserContext) => browserContext.route('**/*', async route => {
    const { pathname, search } = new URL(route.request().url());
    await route.fetch(pathname.startsWith('/api/') ? { url: url + pathname + search } : {})
      .then(response => route.fulfill({ response }), () => route.abort('connectionrefused'));
  });
  try {
    await proxy(context);
    // The fixture install: a checkout recording its units and an install directory naming its provider,
    // gathered by the loop's own report and sent on its coordination read exactly as `master run` sends it.
    const home = await temporaryDirectory('setup-where-things-run');
    const checkout = join(home, 'checkout');
    mkdirSync(join(checkout, '.graphyard'), { recursive: true });
    writeFileSync(join(checkout, '.graphyard', 'units.json'), JSON.stringify({ version: 1, slug: 'fixture-shop', master: 'graphyard-master-fixture-shop.service', executorTemplate: 'graphyard-executor-fixture-shop@.service', alias: false }));
    const configHome = join(home, 'config'), at = '2030-04-01T00:00:00.000Z';
    mkdirSync(join(configHome, 'fixture-shop'), { recursive: true });
    writeFileSync(join(configHome, 'fixture-shop', 'install.json'), JSON.stringify({ version: 1, installId: 'fixture-shop', repository: 'fixture/shop', provider: 'compose', baseBranch: 'main', createdAt: at, updatedAt: at }));
    const where = await loopWhereReport(checkout, { repository: 'fixture/shop', url }, configHome);
    expect(where).not.toBeNull();
    const read = await fetch(`${url}/api/work-snapshot`, { headers: {
      Authorization: 'Bearer test-loop',
      [coordinationViewHeader]: 'coordination', [loopPresenceHeader]: '15', [loopSupervisionHeader]: 'autonomous',
      [loopWhereHeader]: encodeLoopWhere(where!), [loopPanesHeader]: encodeLoopPanes({ configHome: '/home/op/.config/herdr', session: 'graphyard-master-fixture-shop', host: 'host-a', running: true, master: '3' }),
    } });
    expect(read.status).toBe(200);

    // Sign in as the fixture operator: the preview proxy cannot use local-viewer reads.
    const signIn = await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } });
    expect(signIn.status).toBe(200);
    const { code } = await signIn.json() as { code: string };
    await page.goto(`${baseURL}/#sign-in=${code}&setup`);
    const section = page.getByRole('region', { name: 'Where things run', exact: true });
    await expect(section).toBeVisible({ timeout: 15_000 });
    // Collapsed at the foot of the page until the operator opens it.
    await section.getByText('Where things run', { exact: true }).click();
    for (const shown of [
      where!.loopUnit, where!.deployUnit, where!.server, where!.database,
      String(where!.port), where!.url, where!.checkout, where!.installDirectory,
      'graphyard-master-fixture-shop', 'master pane 3',
      `journalctl --user -u ${where!.loopUnit}`, `docker logs ${where!.server}`,
    ]) await expect(section).toContainText(shown, { timeout: 15_000 });

    // The same dashboard's Guide page draws where things run as readable panels (GY-3295) naming the same parts.
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    const diagram = page.getByRole('figure', { name: 'Where things run' });
    await expect(diagram).toBeVisible({ timeout: 15_000 });
    for (const part of ['graphyard-master-OWNER-NAME.service', 'graphyard-OWNER-NAME-server-1', '127.0.0.1:4310']) await expect(diagram).toContainText(part);
    await expect(page.locator('.guide')).toContainText('Where things run');
  } finally {
    await new Promise<void>(resolve => http.close(() => resolve()));
  }
});
