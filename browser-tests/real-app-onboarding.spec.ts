import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from '../tests/helpers/postgres';
import { temporaryDirectory } from '../tests/helpers/temp-dirs';
import { Engine } from '../src/engine';
import { server } from '../src/server';
import { onboardingServe } from '../src/model/onboarding-work';

test('e2e:real-app-onboarding — Setup names the placeholder fault and recognizes the real app on main', async ({ page, context, baseURL }) => {
  test.setTimeout(90_000);
  const root = await temporaryDirectory('real-app-onboarding-browser');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test' } }).trim();
  git('init', '-q', '-b', 'main');
  const save = async (config: object) => { await writeFile(join(root, 'graphyard.json'), JSON.stringify(config)); git('add', '.'); git('commit', '-qm', 'app declaration'); };
  await save({ e2e: { serve: onboardingServe } });
  const previous = process.env.GRAPHYARD_REPOSITORY_ROOT;
  process.env.GRAPHYARD_REPOSITORY_ROOT = root;
  const store = await withDatabase('real_app_onboarding');
  await store.init();
  const engine = new Engine(store, 120, 'owner/Lumina');
  const http = server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token: 'test-operator' }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  try {
    await context.route('**/api/**', async route => {
      const request = new URL(route.request().url());
      await route.fetch({ url: url + request.pathname + request.search }).then(response => route.fulfill({ response }), () => route.abort()).catch(() => {});
    });
    const signIn = await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-operator' } });
    const { code } = await signIn.json() as { code: string };
    await page.goto(`${baseURL}/#sign-in=${code}&setup`);
    const item = page.locator('[data-setup-item="real-app"]');
    await expect(item).toContainText('Project not onboarded');
    await expect(item).toContainText('Master fault: owner/Lumina');
    await expect(item).toContainText('Placeholder serve');
    await expect(item).toHaveAttribute('data-done', 'no');
    await expect(item).not.toContainText('Needs you');
    await save({ e2e: { serve: { command: 'node app.js', url: 'http://127.0.0.1:43911/', readySeconds: 30 } }, featureMap: [{ name: 'Home', url: '/', traps: [] }] });
    // A stale working tree must not override main.
    await writeFile(join(root, 'graphyard.json'), JSON.stringify({ e2e: { serve: onboardingServe } }));
    await page.goto(`${baseURL}/#setup`);
    await page.reload();
    await expect(item).toContainText('Project onboarded');
    await expect(item).toHaveAttribute('data-done', 'yes');
    await expect(item).not.toContainText('Master fault');
  } finally {
    await new Promise<void>(resolve => http.close(() => resolve()));
    if (previous === undefined) delete process.env.GRAPHYARD_REPOSITORY_ROOT; else process.env.GRAPHYARD_REPOSITORY_ROOT = previous;
  }
});
