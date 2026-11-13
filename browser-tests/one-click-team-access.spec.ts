import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDatabase } from '../tests/helpers/postgres';
import { Engine } from '../src/engine';
import { server } from '../src/server';

test.use({ actionTimeout: 15_000 });

// GY-3294: two installs on one simulated Tailscale machine, each served on its own port, share the
// machine's Tailscale link through the real Setup page and each invite with both links.
test('e2e:one-click-team-access — two installs share the machine link and copy invitations carrying both locks', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const machineDir = join(await mkdtemp(join(tmpdir(), 'gy-team-access-')), 'machine');
  await mkdir(machineDir);
  await writeFile(join(machineDir, 'tailnet.json'), JSON.stringify({ dnsName: 'yard.tail-test.ts.net.', ip: '100.64.0.7', deviceId: 'nFAKE123CNTRL' }));
  const provider = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify([{ inviteUrl: 'https://login.tailscale.com/admin/invite/single-use-browser' }])); }); });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  let now = Date.now();
  const env = { ...process.env, GRAPHYARD_MACHINE_DIR: machineDir, GRAPHYARD_TAILSCALE_API: `http://127.0.0.1:${(provider.address() as { port: number }).port}` };
  const installs = await Promise.all(['a', 'b'].map(async name => {
    const store = await withDatabase(`team_access_browser_${name}`);
    await store.init();
    const engine = new Engine(store, 120, `owner/${name}`);
    engine.gitRunner = null;
    const http = server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token: `test-operator-${name}` }], { env, clock: () => now });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    return { name, store, http, port, url: `http://127.0.0.1:${port}`, token: `test-operator-${name}`, tailnet: `http://yard.tail-test.ts.net:${port}` };
  }));
  const [a, b] = installs;
  const contexts: BrowserContext[] = [];
  /** A browser whose API calls reach INSTALL, as the dashboard served on that install's port would. */
  const open = async (install: typeof a) => {
    const context = await browser.newContext();
    contexts.push(context);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL! });
    await context.route('**/*', async route => {
      const { pathname, search } = new URL(route.request().url());
      await route.fetch(pathname.startsWith('/api/') ? { url: install.url + pathname + search } : {}).then(response => route.fulfill({ response }), () => route.abort('connectionrefused'));
    });
    return context.newPage();
  };
  const signIn = async (page: Page, install: typeof a) => {
    const { code } = await (await fetch(install.url + '/api/sign-in-links', { method: 'POST', headers: { Authorization: `Bearer ${install.token}` } })).json() as { code: string };
    await page.goto('/#sign-in=' + code + '&setup');
    const section = page.getByRole('region', { name: 'Invite someone', exact: true });
    await expect(section).toBeVisible({ timeout: 15_000 });
    return section;
  };
  /** Reload Setup on its own address, as the person would; the spent sign-in link stays out of the address bar. */
  const reload = async (page: Page) => { await page.goto('/#setup'); await page.reload(); await expect(page.getByRole('region', { name: 'Invite someone', exact: true })).toBeVisible({ timeout: 15_000 }); };
  const invite = async (page: Page, name: string, role: string) => {
    const section = page.getByRole('region', { name: 'Invite someone', exact: true });
    await section.getByLabel('Name', { exact: true }).fill(name);
    await section.getByLabel('Role', { exact: true }).selectOption(role);
    await section.getByRole('button', { name: 'Invite', exact: true }).click();
    const message = section.getByLabel('Invitation message', { exact: true });
    await expect(message).toBeVisible();
    return message;
  };
  try {
    const pageA = await open(a), pageB = await open(b);
    const sectionA = await signIn(pageA, a), sectionB = await signIn(pageB, b);

    await expect(sectionA).toContainText('One machine, many installs, one port each. Two locks keep each install private');
    await expect(sectionA.getByRole('link', { name: a.tailnet })).toBeVisible();
    await expect(sectionA).toContainText(`(port ${a.port})`);
    await expect(sectionA.locator('[data-share-state="missing"]')).toContainText('No Tailscale share link is saved for this machine yet');
    await sectionA.getByText("Optional: keep shared people on this install's port").click();
    await expect(sectionA.getByLabel('ACL example')).toContainText(`"tcp:${a.port}"`);
    await expect(sectionA.getByLabel('ACL example')).toContainText('autogroup:shared');

    // Paste the machine's share link on A; B, on the same machine, shows the same saved link.
    const link = 'https://login.tailscale.com/admin/invite/machine-share-browser';
    await sectionA.getByLabel('Tailscale share link', { exact: true }).fill(link);
    await sectionA.getByRole('button', { name: 'Save for this machine' }).click();
    await expect(sectionA.locator('[data-share-state="ok"]')).toContainText(link);
    await reload(pageB);
    await expect(sectionB.locator('[data-share-state="ok"]')).toContainText(link);
    await expect(sectionB.getByRole('link', { name: b.tailnet })).toBeVisible();

    // Invite someone on each install: one message with the machine link and that install's own sign-in link.
    for (const [page, install, name, role] of [[pageA, a, 'sam', 'viewer'], [pageB, b, 'kim', 'maintainer']] as const) {
      const message = await invite(page, name, role);
      const text = await message.inputValue();
      const signInLink = await page.getByLabel('Sign-in link', { exact: true }).inputValue();
      expect(signInLink).toMatch(new RegExp(`^${install.tailnet.replace(/[.:/]/g, '\\$&')}/#sign-in=`));
      for (const part of [`Hi ${name}`, `${install.tailnet} as ${role}`, `port ${install.port} only`, 'Two locks keep it private', link, 'reusable, Tailscale expires it', signInLink, 'single use, expires in 24 hours'])
        expect(text, `message carries ${part}`).toContain(part);
      const copy = page.getByRole('button', { name: /^Copy Copy message:/ });
      await expect(copy).toHaveText('Copy message');
      await copy.click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
    }

    // The invite redeems on its own install with its role.
    const code = (await pageA.getByLabel('Sign-in link', { exact: true }).inputValue()).split('#sign-in=')[1];
    const teammate = await open(a);
    const signedIn = teammate.waitForResponse(response => new URL(response.url()).pathname === '/api/sign-in');
    await teammate.goto(`/#sign-in=${code}`);
    expect((await (await signedIn).json()).actor).toMatchObject({ id: 'sam', team: 'viewer' });

    // The reusable link keeps its real expiry: a warning in its last seven days, a refusal once expired.
    now += 24 * 86_400_000;
    await reload(pageA);
    await expect(sectionA.locator('[data-share-state="refresh"]')).toContainText('expires within seven days');
    now += 7 * 86_400_000;
    await reload(pageB);
    await expect(sectionB.locator('[data-share-state="expired"]')).toContainText('It has expired');
    await sectionB.getByLabel('Name', { exact: true }).fill('max');
    await sectionB.getByRole('button', { name: 'Invite', exact: true }).click();
    await expect(sectionB.getByRole('alert')).toContainText('share link expired');

    // Optional API mode: the owner's token is saved for the machine, never shown, and each invite gets a single-use Tailscale link.
    const token = 'tskey-api-FAKE-browser-only';
    await sectionB.getByText('Optional: a single-use Tailscale invite per person').click();
    await sectionB.getByLabel('Tailscale API token', { exact: true }).fill(token);
    await sectionB.getByRole('button', { name: 'Save token' }).click();
    await expect(sectionB).toContainText('A token is saved: invites make single-use Tailscale links.');
    await expect(sectionB.getByLabel('Tailscale API token', { exact: true })).toHaveValue('');
    const apiMessage = await (await invite(pageB, 'ana', 'viewer')).inputValue();
    expect(apiMessage).toContain('https://login.tailscale.com/admin/invite/single-use-browser (Tailscale share link, single use, made for you)');
    expect(apiMessage).toContain(`${b.tailnet}/#sign-in=`);
    await reload(pageA);
    await expect(sectionA).toContainText('A token is saved');
    for (const page of [pageA, pageB]) expect(await page.content()).not.toContain(token);
  } finally {
    for (const context of contexts) await context.close();
    for (const install of installs) { await new Promise<void>(resolve => { install.http.close(() => resolve()); install.http.closeAllConnections(); }); await install.store.close(); }
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
});
