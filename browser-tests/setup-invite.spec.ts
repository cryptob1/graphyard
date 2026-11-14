import { test, expect, type BrowserContext } from '@playwright/test';
import { withDatabase } from '../tests/helpers/postgres';
import { Engine } from '../src/engine';
import { server } from '../src/server';

test.use({ actionTimeout: 15_000 });

test('e2e:setup-invite — Setup invites, copies a single-use viewer link and revokes the redeemed session', async ({ page, context, browser, baseURL }) => {
  test.setTimeout(90_000);
  const store = await withDatabase('setup_invite');
  await store.init();
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  const http = server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token: 'test-human-operator' }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const fresh = await browser.newContext();
  const reused = await browser.newContext();
  const settled = { timeout: 15_000 };
  const proxy = async (browserContext: BrowserContext) => browserContext.route('**/*', async route => {
    const { pathname, search } = new URL(route.request().url());
    await route.fetch(pathname.startsWith('/api/') ? { url: url + pathname + search } : {})
      .then(response => route.fulfill({ response }), () => route.abort('connectionrefused'));
  });
  try {
    await Promise.all([proxy(context), proxy(fresh), proxy(reused)]);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL! });
    const { code } = await (await fetch(url + '/api/sign-in-links', { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } })).json() as { code: string };
    await page.goto('/#sign-in=' + code + '&setup');
    const section = page.getByRole('region', { name: 'Invite someone', exact: true });
    await expect(section).toBeVisible(settled);
    await section.getByLabel('Name', { exact: true }).fill('sam');
    await section.getByLabel('Role', { exact: true }).selectOption('viewer');
    const response = page.waitForResponse(response => response.url().endsWith('/api/invites') && response.request().method() === 'POST');
    await section.getByRole('button', { name: 'Invite', exact: true }).click();
    const invite = await (await response).json();
    const link = `${baseURL}/#sign-in=${invite.code}`;
    await expect(section.getByLabel('Sign-in link', { exact: true })).toHaveValue(link);
    await section.getByRole('button', { name: /^Copy Copy:/ }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
    const list = section.getByRole('list', { name: 'Invited from this page' });
    await expect(list).toContainText('sam');
    await expect(list).toContainText('viewer');
    await expect(list.locator('time')).toHaveAttribute('datetime', invite.expiresAt);
    await expect(list.locator('time')).toBeVisible();
    await expect(list.locator('time')).not.toBeEmpty();

    const teammate = await fresh.newPage();
    const signedIn = teammate.waitForResponse(response => new URL(response.url()).pathname === '/api/sign-in');
    await teammate.goto(link);
    const session = await (await signedIn).json();
    expect(session.actor).toMatchObject({ id: 'sam', role: 'reader', team: 'viewer' });
    await expect(teammate.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible(settled);
    await teammate.goto(baseURL + '/#setup');
    await teammate.reload();
    await expect(teammate.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible(settled);
    await expect(teammate.getByRole('region', { name: 'Invite someone', exact: true })).toHaveCount(0);
    const again = await reused.newPage();
    await again.goto(link);
    await expect(again.getByRole('alert')).toContainText('already used', settled);
    // Redemption must not remove the entry or its metadata from the still-open Setup page.
    await expect(list).toContainText('sam');
    await expect(list).toContainText('viewer');
    await expect(list.locator('time')).toHaveAttribute('datetime', invite.expiresAt);
    await list.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(list).toHaveCount(0);
    expect((await fetch(url + '/api/status', { headers: { Authorization: `Bearer ${session.token}` } })).status).toBe(401);
    await teammate.reload();
    await expect(teammate.getByRole('button', { name: 'Sign out', exact: true })).toBeHidden(settled);

    // A successful creation disappears on reload; neither its metadata nor bearer link is persisted.
    await section.getByLabel('Name', { exact: true }).fill('morgan');
    await section.getByLabel('Role', { exact: true }).selectOption('maintainer');
    await section.getByRole('button', { name: 'Invite', exact: true }).click();
    await expect(list).toContainText('morgan');
    await expect(list).toContainText('maintainer');
    const storage = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]));
    expect(storage).not.toContain('sign-in=');
    await page.goto('/#setup');
    await page.reload();
    await expect(section).toBeVisible(settled);
    await expect(list).toHaveCount(0);
    await expect(section.getByLabel('Sign-in link', { exact: true })).toHaveCount(0);
  } finally {
    await fresh.close(); await reused.close();
    await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); });
    await store.close();
  }
});
