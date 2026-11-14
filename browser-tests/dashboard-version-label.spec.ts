import { test, expect, type Page } from '@playwright/test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { symlink } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { freePort } from '../src/cli/test-isolation';
import { signInDatabase } from '../tests/helpers/sign-in-database';
import { temporaryDirectory } from '../tests/helpers/temp-dirs';
import { serveXterm } from './xterm';

const stub = resolve('fixtures/herdr-terminal-stub');
const settled = { timeout: 15_000 };
const follows = { timeout: 30_000 };
const first = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';
const second = 'f0e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d';

/** The real control plane serving the built dashboard at build commit SHA on port, with the stub herdr for the Master terminal. */
async function plane(database: string, site: string, sha: string, port: number) {
  const child = fork(resolve('tests/helpers/terminal-server.ts'), [database, site, String(port)], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, GRAPHYARD_BUILD_SHA: sha, PATH: `${stub}${delimiter}${process.env.PATH}`, HERDR_STUB_LOG: join(site, 'herdr.log'), GRAPHYARD_HERDR_CONFIG_HOME: '', GRAPHYARD_HERDR_SESSION: '' } });
  const [{ url }] = await once(child, 'message') as [{ url: string }];
  return { url, close: async () => { const ended = once(child, 'exit'); child.send('stop'); await ended; } };
}

/** The label's box: in the viewport's bottom-left corner, clear of every visible control and of the Master terminal. */
async function checkCorner(page: Page) {
  const label = page.locator('.version-label');
  await expect(label).toBeVisible();
  const placement = await label.evaluate(node => {
    const box = node.getBoundingClientRect();
    const hits = (other: DOMRect) => other.width > 0 && other.height > 0 && other.left < box.right && other.right > box.left && other.top < box.bottom && other.bottom > box.top;
    const controls = [...document.querySelectorAll('button, a[href], input, textarea, select, [role=button], [tabindex]:not([tabindex="-1"]), .live-terminal, .terminal-host')]
      .filter(other => other !== node && hits(other.getBoundingClientRect()))
      .map(other => other.outerHTML.slice(0, 120));
    return { left: box.left, bottom: window.innerHeight - box.bottom, width: box.width, controls };
  });
  expect(placement.left).toBeLessThanOrEqual(1);
  expect(Math.abs(placement.bottom)).toBeLessThanOrEqual(1);
  expect(placement.width).toBeLessThan(page.viewportSize()!.width / 2);
  expect(placement.controls).toEqual([]);
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`e2e:dashboard-version-label — the served commit shows bottom-left on Work and Master at ${viewport.width} px and follows a new deploy`, async ({ browser }) => {
    test.setTimeout(120_000);
    const database = await signInDatabase();
    const site = await temporaryDirectory('version-label');
    await symlink(resolve('.graphyard/browser-dist'), join(site, 'dist'));
    // Both planes listen on one port, as one URL does across a deploy; the page talks to whichever is serving it.
    const port = await freePort();
    let http = await plane(database.url, site, first, port);
    const page = await browser.newPage({ viewport }); await serveXterm(page);
    try {
      const served = async () => (await (await fetch(`${http.url}/api/status`, { headers: { Authorization: 'Bearer test-human-operator' } })).json() as { build: { commit: string } }).build.commit.slice(0, 7);
      expect(await served()).toBe(first.slice(0, 7));
      const { code } = await (await fetch(`${http.url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } })).json() as { code: string };
      await page.goto(`${http.url}/#sign-in=${code}`);
      await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible(settled);
      await expect(page.locator('.version-label')).toContainText(await served());
      await checkCorner(page);

      // The Master page, its terminal live.
      if (viewport.width < 650) await page.getByRole('button', { name: 'Menu' }).click();
      await page.locator('[data-nav="master"]').click();
      await expect(page.locator('.xterm-rows')).toContainText('screen of w1:master', settled);
      await expect(page.locator('.version-label')).toContainText(first.slice(0, 7));
      await checkCorner(page);

      // A deploy: the plane restarts at a new commit on the same port; the label follows on the page's own poll, with no reload.
      await http.close();
      http = await plane(database.url, site, second, port);
      expect(await served()).toBe(second.slice(0, 7));
      await expect(page.locator('.version-label')).toContainText(second.slice(0, 7), follows);
      await checkCorner(page);
      expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(1);
    } finally { await page.close(); await http.close(); await database.close(); }
  });
}
