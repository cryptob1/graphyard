import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDatabase } from '../tests/helpers/postgres';
import { Engine } from '../src/engine';
import { server } from '../src/server';
import { gitRunnerFor } from '../src/merge-writer/local-observation';
import { bootstrapGate, gateRecordPath, writeGateRecord } from '../src/batch-gate';

// e2e:dashboard-header-plain — GY-3483: the header shows only what is happening now. Over a real
// control plane managing a repository with no deploy and a batch gate running on main, the strip
// reads agents working, checks running (the gate counts) and merged today; no release line, no
// zero week line; the sidebar foot reads Live and the signed-in name and role, never an id or an
// update time; and Delivery is a Settings tab — at 1280 and 390 px.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const principalId = 'owner-principal-7';

/** A managed repository with no deploy, whose batch gate is running on main's commit. */
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'header-plain-'));
  git(root, 'init', '-q', '-b', 'main');
  await writeFile(join(root, 'README.md'), 'shop\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'start');
  const commit = git(root, 'rev-parse', 'HEAD');
  await writeGateRecord(gateRecordPath(root), { ...bootstrapGate('fixture/shop', commit), inFlight: { tip: commit, startedAt: new Date().toISOString(), step: 'trial' } });
  return root;
}

async function plane(context: BrowserContext, root: string) {
  const previous = process.env.GRAPHYARD_REPOSITORY_ROOT;
  process.env.GRAPHYARD_REPOSITORY_ROOT = root;
  const store = await withDatabase(`header_plain_${Date.now()}`);
  await store.init();
  const engine = new Engine(store, 120, 'fixture/shop');
  engine.gitRunner = gitRunnerFor(root);
  const http = server(engine, [{ id: principalId, displayName: 'Avery', role: 'admin', sessionKind: 'human', token: 'test-human-owner' }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  await context.route('**/*', async route => {
    const { pathname, search } = new URL(route.request().url());
    await route.fetch(pathname.startsWith('/api/') ? { url: url + pathname + search } : {})
      .then(response => route.fulfill({ response }), () => route.abort('connectionrefused'));
  });
  const close = async () => {
    await context.unrouteAll(); await new Promise<void>(resolve => http.close(() => resolve())); await store.close();
    if (previous === undefined) delete process.env.GRAPHYARD_REPOSITORY_ROOT; else process.env.GRAPHYARD_REPOSITORY_ROOT = previous;
  };
  return { url, close };
}

/** Opens a sidebar entry, through the menu on a phone. */
async function go(page: Page, label: string) {
  const menu = page.getByRole('button', { name: 'Menu' });
  if (await menu.isVisible() && await menu.getAttribute('aria-expanded') !== 'true') await menu.click();
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: label, exact: true }).click();
}

/** The header's and sidebar's whole text, shown or folded. */
const chrome = (page: Page) => page.evaluate(() => ['.top-bar', '.sidebar'].map(selector => document.querySelector(selector)?.textContent ?? '').join(' '));

for (const width of [1280, 390]) {
  test(`e2e:dashboard-header-plain — the header shows agents, checks running and merged today, no idle release or week line, a plain sidebar foot, and Delivery under Settings at ${width}px`, async ({ page, context }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    const root = await repository();
    const { url, close } = await plane(context, root);
    try {
      const signIn = await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-owner' } });
      expect(signIn.status).toBe(200);
      await page.goto(`/#sign-in=${(await signIn.json() as { code: string }).code}`);
      await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });

      // The strip: no agent session is live, the batch gate on main is one check running, nothing merged today.
      const strip = page.locator('.top-bar .activity-strip');
      await expect(strip).toHaveAttribute('data-in-trial', '1', { timeout: 15_000 });
      await expect(strip).toHaveAttribute('data-on-shift', '0');
      await expect(strip).toHaveAttribute('data-shipped-tonight', '0');
      await expect(strip).toHaveText(/0 agents working · 1 check running · 0 merged today/);
      // No deploy: no release line. No reverts or gates removed: no week line.
      await expect(page.locator('.top-bar .release-line')).toHaveCount(0);
      await expect(page.locator('.top-bar .week-line')).toHaveCount(0);
      // The sidebar foot: Live, the time only in its title, and the name and role.
      await expect(page.locator('.sidebar .connection')).toHaveText('Live');
      await expect(page.locator('.sidebar .signed-in')).toHaveText('Avery · Owner');
      await expect(page.locator('.sidebar [aria-label="Delivery"]')).toHaveCount(0);

      for (const [label, heading] of [['Work', 'Work'], ['Master', 'Master'], ['Settings', 'Agents']] as const) {
        await go(page, label);
        await expect(page.getByRole('heading', { name: heading, exact: true, level: 1 })).toBeVisible();
        const text = await chrome(page);
        for (const absent of ['No deploy configured', 'Reverts this week', 'Gates removed this week', 'local-viewer', 'updated', principalId])
          expect(text, `${label} at ${width}px shows ${absent}`).not.toContain(absent);
        await expect(page.locator('.top-bar .activity-strip')).toContainText('1 check running');
      }

      // Delivery is a Settings tab, and says there is no deploy.
      await page.getByRole('navigation', { name: 'Pages in this section' }).getByRole('button', { name: 'Delivery', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Delivery', exact: true, level: 1 })).toBeVisible();
      await expect(page.locator('[data-deploy="none"]')).toContainText('No deploy configured');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally { await page.close(); await close(); }
  });
}
