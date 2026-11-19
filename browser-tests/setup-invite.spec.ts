import { test, expect, type BrowserContext } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from '../tests/helpers/postgres';
import { temporaryDirectory } from '../tests/helpers/temp-dirs';
import { Engine } from '../src/engine';
import { server } from '../src/server';
import { settleHostLoops } from '../tests/helpers/team-access-hosts';
import { fakeTailscale, onPath } from '../tests/helpers/fake-tailscale';
import { viaSocket } from '../tests/helpers/serve-socket';

test.use({ actionTimeout: 15_000 });

// GY-3486: Invite (top bar) replaced Setup's section: the operator invites sam as viewer, copies one
// message with the share and this install's address, and sam's Tailscale login is the sign-in on the serve socket.
test('e2e:setup-invite — Invite adds a viewer by Tailscale login, copies one message, lists them after reload and revokes their access', async ({ page, context, browser, baseURL }) => {
  test.setTimeout(90_000);
  const hostDir = await temporaryDirectory('gy-setup-invite'), machineDir = join(hostDir, 'machine');
  await mkdir(machineDir);
  await writeFile(join(machineDir, 'tailnet.json'), JSON.stringify({ dnsName: 'yard.tail-test.ts.net.', ip: '100.64.0.7', deviceId: 'nFAKE123CNTRL' }));
  const store = await withDatabase('setup_invite');
  await store.init();
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  const loop = 'test-loop-coordinator-setup-invite-0123456789', credentialFile = join(hostDir, 'loop.token');
  await writeFile(credentialFile, loop, { mode: 0o600 });
  const http = server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token: 'test-human-operator' }, { id: 'loop', role: 'coordinator', token: loop }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const socket = join(hostDir, 'serve.sock'), served = await http.serveSocket(socket);
  const port = (http.address() as { port: number }).port, url = `http://127.0.0.1:${port}`, tailnet = `http://yard.tail-test.ts.net:${port}`;
  const restorePath = onPath(await fakeTailscale(hostDir));
  await writeFile(join(hostDir, 'serve.json'), JSON.stringify({ [port]: url }));
  const sync = () => settleHostLoops([{ url, credentialFile }], { machineDir });
  const share = 'https://login.tailscale.com/admin/invite/setup-invite-share';
  await fetch(url + '/api/team-access/share-link', { method: 'POST', headers: { Authorization: 'Bearer test-human-operator', 'Content-Type': 'application/json' }, body: JSON.stringify({ url: share }) });
  await sync();
  const teammateContext = await browser.newContext();
  const settled = { timeout: 15_000 };
  const proxy = async (browserContext: BrowserContext) => browserContext.route('**/*', async route => {
    const { pathname, search } = new URL(route.request().url());
    await route.fetch(pathname.startsWith('/api/') ? { url: url + pathname + search } : {})
      .then(response => route.fulfill({ response }), () => route.abort('connectionrefused')).catch(() => {});
  });
  // sam's browser on the tailnet: tailscaled carries each request to the serve socket with her login.
  await teammateContext.route('**/*', async route => {
    const request = route.request(), { pathname, search } = new URL(request.url());
    if (!pathname.startsWith('/api/')) return route.fetch().then(response => route.fulfill({ response }), () => route.abort('connectionrefused')).catch(() => {});
    const reply = await viaSocket(socket, pathname + search, 'sam@example.com', request.method() === 'GET' ? undefined : JSON.parse(request.postData() || '{}'));
    await route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body) }).catch(() => {});
  });
  try {
    await proxy(context);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL! });
    const { code } = await (await fetch(url + '/api/sign-in-links', { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } })).json() as { code: string };
    await page.goto('/#sign-in=' + code + '&setup');
    // Setup no longer carries an invite section: Invite lives in the top bar.
    await expect(page.getByRole('region', { name: 'Invite someone', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Invite' });
    await dialog.getByLabel('Tailscale logins', { exact: true }).fill('sam@example.com');
    await dialog.getByLabel('Role', { exact: true }).selectOption('viewer');
    await dialog.getByRole('button', { name: 'Invite', exact: true }).click();
    const message = dialog.getByLabel('Invitation message', { exact: true });
    await expect(message).toBeVisible(settled);
    const text = await message.inputValue();
    for (const part of ['sam@example.com', 'as viewer', share, tailnet]) expect(text, `message carries ${part}`).toContain(part);
    expect(text).not.toContain('#sign-in=');
    await dialog.getByRole('button', { name: /^Copy/ }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
    const list = dialog.getByRole('list', { name: 'Teammates' });
    await expect(list).toContainText('sam@example.com');
    await expect(list).toContainText('viewer');

    // sam opens the install on the tailnet: Tailscale's login is the sign-in, as a viewer, with no Invite.
    const teammate = await teammateContext.newPage();
    const signedIn = teammate.waitForResponse(response => new URL(response.url()).pathname === '/api/status');
    await teammate.goto(baseURL + '/#setup');
    expect((await (await signedIn).json()).actor).toMatchObject({ id: 'sam@example.com', role: 'reader', team: 'viewer' });
    await expect(teammate.getByText('sam@example.com').first()).toBeVisible(settled);
    await expect(teammate.getByRole('button', { name: 'Invite', exact: true })).toHaveCount(0);
    expect((await viaSocket(socket, '/api/invites', 'sam@example.com', { logins: ['eve@example.com'], role: 'viewer', installs: [tailnet] })).status).toBe(403);

    // The list persists across reloads, and nothing of the invite is kept in the browser.
    const storage = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]));
    expect(storage).not.toContain('sam@example.com');
    await page.goto('/#setup');
    await page.reload();
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    await expect(list).toContainText('sam@example.com', settled);
    await expect(list).toContainText('viewer');

    // Revoke ends sam's access at once.
    await list.getByRole('listitem').filter({ hasText: 'sam@example.com' }).getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(list.getByRole('listitem').filter({ hasText: 'sam@example.com' })).toHaveCount(0, settled);
    expect((await viaSocket(socket, '/api/status', 'sam@example.com')).status).toBe(403);
    await teammate.reload();
    await expect(teammate.getByText('You are not invited to this install. Ask the owner to invite sam@example.com.')).toBeVisible(settled);
  } finally {
    restorePath();
    await teammateContext.close();
    served.close();
    await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); });
    await store.close();
  }
});
