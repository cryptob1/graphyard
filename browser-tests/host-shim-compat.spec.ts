import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from '../tests/helpers/postgres';
import { shardHosts } from '../tests/helpers/shard-hosts';
import { readHostReadings, type HostReading } from '../src/hosts';
import { hostShimDigest, hostShimScript } from '../src/host-shim';
import { defaultChildRun } from '../src/child-runner';
import { Engine } from '../src/engine';
import { server } from '../src/server';
import { encodeLoopHosts, loopHostsHeader, loopPresenceHeader, loopSupervisionHeader } from '../src/model/loop-presence';
import { coordinationViewHeader } from '../src/server/work-view';

// e2e:host-shim-compat — GY-3517: two added compute machines, one whose host helper is too old for
// this release's trials and one on another release's helper that still speaks every trial verb, read
// through their shims as the loop reads them. The top bar says, in one line, which machine needs an
// update and the one command; Needs you holds it as the owner's item; the other machine stays ready.
// Once the old machine's helper is updated, the loop's next probe clears both. At 1280 px and 390 px.

async function plane(context: BrowserContext, label: string) {
  const store = await withDatabase(label);
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

async function seedLoopRead(url: string, readings: HostReading[]) {
  const read = await fetch(`${url}/api/work-snapshot`, { headers: {
    Authorization: 'Bearer test-loop', [coordinationViewHeader]: 'coordination', [loopPresenceHeader]: '15', [loopSupervisionHeader]: 'autonomous',
    [loopHostsHeader]: encodeLoopHosts(readings),
  } });
  expect(read.status).toBe(200);
}

async function signIn(page: Page, url: string) {
  const link = await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } });
  expect(link.status).toBe(200);
  const { code } = await link.json() as { code: string };
  await page.goto(`/#sign-in=${code}`);
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
}

const noOverflow = async (page: Page, width: number) => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`e2e:host-shim-compat — the top bar names the compute machine whose helper needs an update with the one command, Needs you holds it, and both clear once it is updated, at ${viewport.width} px`, async ({ page, context }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    // Each machine runs its own copy of the helper: the fixture's ssh runs the one named after the host.
    const hosts = await shardHosts(`host_shim_compat_${viewport.width}`, ['oldbox', 'newbox']);
    await writeFile(hosts.shim, `#!/bin/sh\nexec "$HOME/../shim" "$@"\n`);
    const helper = (name: string, script: string) => writeFile(join(hosts.home(name), '..', 'shim'), script, { mode: 0o755 });
    await helper('oldbox', hostShimScript.replace(hostShimDigest, '0'.repeat(64)).replace(/run-shard:\d+/, 'run-shard:1'));
    await helper('newbox', hostShimScript.replace(hostShimDigest, 'f'.repeat(64)));
    const file = join(hosts.root, 'hosts.json');
    await writeFile(file, JSON.stringify([{ target: 'gy-compute@oldbox', addedAt: 'x' }, { target: 'gy-compute@newbox', addedAt: 'x' }]));
    const run = (command: string, args: string[], options: Parameters<typeof defaultChildRun>[2] = {}) => defaultChildRun(command, args, { ...options, env: { ...process.env, PATH: `${hosts.bin}:${process.env.PATH}` } });
    const readings = await readHostReadings([], { file, run, local: 'here' });
    const { url, close } = await plane(context, `host_shim_compat_${viewport.width}`);
    try {
      await seedLoopRead(url, readings);
      await signIn(page, url);
      const line = page.locator('[data-host-update]');
      await expect(line).toHaveCount(1, { timeout: 15_000 });
      await expect(line).toHaveText('Compute machines need an update: gy-compute@oldbox · run graphyard host prepare, then the script it prints on each with sudo');
      await expect(line).toBeInViewport();
      await noOverflow(page, viewport.width);

      await page.evaluate(() => { location.hash = 'needs-you'; });
      await expect(page.getByRole('heading', { name: 'Needs you', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
      const item = page.locator('[data-host-update-request]');
      await expect(item).toContainText('Compute machines need an update');
      await expect(item).toContainText('gy-compute@oldbox takes no trial work until updated. Run graphyard host prepare');
      await expect(item).not.toContainText('newbox');
      await noOverflow(page, viewport.width);

      // The owner updates oldbox: the loop's next probe reads it ready and the line and item go.
      await helper('oldbox', hostShimScript);
      await seedLoopRead(url, await readHostReadings(readings, { file, run, local: 'here' }));
      await expect(line).toHaveCount(0, { timeout: 15_000 });
      await expect(item).toHaveCount(0);

      // Workers shows each host's latest probe with when it was read.
      await page.evaluate(() => { location.hash = 'workers'; });
      const hostsTable = page.getByRole('table', { name: 'Hosts' });
      await expect(hostsTable.locator('[data-host="gy-compute@oldbox"]')).not.toHaveAttribute('data-away', /.*/);
      await expect(hostsTable.locator('[data-host="gy-compute@oldbox"] [data-label="Read"]')).toHaveText(/^\d+m ago$/);
      await noOverflow(page, viewport.width);
    } finally { await page.close(); await close(); }
  });
}
