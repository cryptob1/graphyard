import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDatabase } from '../tests/helpers/postgres';
import { Engine } from '../src/engine';
import { server } from '../src/server';
import { gitRunnerFor } from '../src/merge-writer/local-observation';

// e2e:where-it-runs — GY-3434: on a served dashboard whose repository's main declares app.url in
// graphyard.json and serves a commit, the top bar's Open app button and the Work page's Where it
// runs card both link to the app, and the card shows the machine, the serving commit, its deploy
// time and the dashboard's own link. With none declared the card names the one setting to add.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

/** A managed repository whose main holds CONFIG as graphyard.json and whose serve pass serves main. */
async function repository(config: object) {
  const root = await mkdtemp(join(tmpdir(), 'where-it-runs-'));
  git(root, 'init', '-q', '-b', 'main');
  await writeFile(join(root, 'graphyard.json'), JSON.stringify(config));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'declare');
  const commit = git(root, 'rev-parse', 'HEAD');
  await mkdir(join(root, '.graphyard'), { recursive: true });
  const started = new Date(Date.now() - 5 * 60_000).toISOString();
  await writeFile(join(root, '.graphyard', 'served.json'), JSON.stringify({ commit, url: 'http://127.0.0.1:8088/', failed: null, reason: null, started, at: started }));
  return { root, commit };
}

/** The real control plane reading that repository, serving the built dashboard's API reads. */
async function plane(context: BrowserContext, root: string) {
  const previous = process.env.GRAPHYARD_REPOSITORY_ROOT;
  process.env.GRAPHYARD_REPOSITORY_ROOT = root;
  const store = await withDatabase(`where_it_runs_${Date.now()}`);
  await store.init();
  const engine = new Engine(store, 120, 'fixture/shop');
  engine.gitRunner = gitRunnerFor(root);
  const http = server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token: 'test-human-operator' }]);
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

async function openWork(page: Page, url: string) {
  const signIn = await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } });
  expect(signIn.status).toBe(200);
  const { code } = await signIn.json() as { code: string };
  await page.goto(`/#sign-in=${code}`);
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
}

test('e2e:where-it-runs — Open app and the Where it runs card link to main\'s app.url with machine, serving commit, deploy time and the dashboard link', async ({ page, context }) => {
  test.setTimeout(90_000);
  const app = 'https://shop.tail1234.ts.net:8088/';
  const { root, commit } = await repository({ app: { url: app } });
  const { url, close } = await plane(context, root);
  try {
    await openWork(page, url);
    await expect(page.locator('.top-bar [data-open-app]')).toHaveAttribute('href', app, { timeout: 15_000 });
    await expect(page.locator('.top-bar [data-open-app]')).toHaveText(/Open app/);
    const card = page.getByRole('region', { name: 'Where it runs' });
    await expect(card).toHaveAttribute('data-where-it-runs', 'declared');
    await expect(card.locator('[data-app-link]')).toHaveAttribute('href', app);
    await expect(card.locator('[data-machine]')).toHaveText(hostname());
    await expect(card.locator('[data-commit]')).toHaveText(commit.slice(0, 8));
    await expect(card.locator('[data-deployed-at]')).toHaveText(/^\S.* ago$/);
    const origin = new URL(page.url()).origin;
    await expect(card.locator('[data-dashboard-link]')).toHaveAttribute('href', origin);
    await expect(card.locator('[data-dashboard-link]')).toHaveText(origin);
  } finally { await page.close(); await close(); }
});

test('e2e:where-it-runs — with no app.url declared the card names the one setting to add and no Open app shows', async ({ page, context }) => {
  test.setTimeout(90_000);
  const { root } = await repository({});
  const { url, close } = await plane(context, root);
  try {
    await openWork(page, url);
    const card = page.getByRole('region', { name: 'Where it runs' });
    await expect(card).toHaveAttribute('data-where-it-runs', 'missing', { timeout: 15_000 });
    await expect(card.locator('[data-app-missing]')).toContainText('"app": { "url"');
    await expect(card.locator('[data-app-missing]')).toContainText('graphyard.json');
    await expect(page.locator('[data-open-app]')).toHaveCount(0);
  } finally { await page.close(); await close(); }
});
