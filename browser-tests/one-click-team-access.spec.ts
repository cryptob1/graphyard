import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDatabase } from '../tests/helpers/postgres';
import { Engine } from '../src/engine';
import { server } from '../src/server';
import { syncTeamAccess } from '../src/master/team-access';

test.use({ actionTimeout: 15_000 });

// GY-3294: two installs on one simulated Tailscale machine, each served on its own port, share the
// machine's Tailscale link through the real Setup page and each invite with both links.
test('e2e:one-click-team-access — two installs share the machine link and copy invitations carrying both locks', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const machineDir = join(await mkdtemp(join(tmpdir(), 'gy-team-access-')), 'machine');
  await mkdir(machineDir);
  await writeFile(join(machineDir, 'tailnet.json'), JSON.stringify({ dnsName: 'yard.tail-test.ts.net.', ip: '100.64.0.7', deviceId: 'nFAKE123CNTRL' }));
  const provider = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify([{ inviteUrl: 'https://login.tailscale.com/admin/invite/single-use-browser' }])); }); });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  let now = Date.now();
  const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const tailscaleApi = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const installs = await Promise.all(['a', 'b'].map(async name => {
    const store = await withDatabase(`team_access_browser_${name}`);
    await store.init();
    const engine = new Engine(store, 120, `owner/${name}`);
    engine.gitRunner = null;
    const loop = `test-loop-coordinator-${name}-credential-0123456789`, credentialFile = join(machineDir, '..', `${name}.token`);
    await writeFile(credentialFile, loop, { mode: 0o600 });
    const http = server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token: `test-operator-${name}` }, { id: 'loop', role: 'coordinator', token: loop }], { clock: () => now });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    return { name, store, http, port, url: `http://127.0.0.1:${port}`, credentialFile, token: `test-operator-${name}`, tailnet: `http://yard.tail-test.ts.net:${port}` };
  }));
  // Each install's master loop on the shared host, as the loop runs it every 15 seconds: one pass
  // here whenever a page is about to read what the other install saved, and a short ticker only
  // while the page polls for the single-use invite its host must answer (setup.tsx polls every second).
  const sync = () => Promise.all(installs.map(install => syncTeamAccess({ url: install.url, credentialFile: install.credentialFile }, { machineDir, tailscaleApi })));
  await sync();
  const [a, b] = installs;
  const contexts: BrowserContext[] = [];
  /** A browser whose API calls reach INSTALL, as the dashboard served on that install's port would. */
  const open = async (install: typeof a) => {
    const context = await browser.newContext();
    contexts.push(context);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL! });
    await context.route('**/*', async route => {
      const { pathname, search } = new URL(route.request().url());
      await route.fetch(pathname.startsWith('/api/') ? { url: install.url + pathname + search } : {}).then(response => route.fulfill({ response }), () => route.abort('connectionrefused')).catch(() => { /* the page navigated away meanwhile */ });
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
    await expect(message).toBeVisible({ timeout: 15_000 });
    return message;
  };
  try {
    const pageA = await open(a), pageB = await open(b);
    const sectionA = await signIn(pageA, a), sectionB = await signIn(pageB, b);

    // GY-3345: this spec's own budget covers every poll: on a loaded trial host (two control
    // planes and two clusters per install beside the rest of the suite) the default 5 s expect
    // timeout is what a busy page loses, not its meaning. A reloaded page reads team access through
    // the routed API after its section shows, so each poll gives that read 5 s, not 1 s (GY-3412 trial).
    // GY-3396's trial lost one of these reads at 15 s while the suite's newest walk ran beside it, so
    // the budget is 25 s and the test 180 s.
    const settled = { timeout: 25_000 };
    await expect(sectionA).toContainText("One machine, many installs, one port each. Two locks: the Tailscale share lets a person's devices reach this machine", settled);
    await expect(async () => { await sync(); await reload(pageA); await expect(sectionA.getByRole('link', { name: a.tailnet })).toBeVisible({ timeout: 5_000 }); }).toPass({ timeout: 30_000 });
    await expect(sectionA).toContainText(`(port ${a.port})`, settled);
    await expect(sectionA.locator('[data-share-state="missing"]')).toContainText('No Tailscale share link is saved for this machine yet, so Invite cannot make a complete message', settled);
    await sectionA.getByText("Optional: keep shared people on this install's port").click();
    await expect(sectionA.getByLabel('ACL example')).toContainText(`"tcp:${a.port}"`, settled);
    await expect(sectionA.getByLabel('ACL example')).toContainText('TEAMMATE@example.com', settled);
    await expect(sectionA).toContainText('does not revoke them', settled);

    // With no share link saved, Invite withholds the message and names the missing step.
    await sectionA.getByLabel('Name', { exact: true }).fill('early');
    await sectionA.getByRole('button', { name: 'Invite', exact: true }).click();
    await expect(sectionA.locator('[data-invite-missing]')).toContainText('No ready-to-send message yet: No Tailscale share link is saved', settled);
    await expect(sectionA.getByLabel('Invitation message', { exact: true })).toHaveCount(0, settled);

    // Paste the machine's share link on A (made today by default); B, on the same machine, shows it after the host loops sync.
    const link = 'https://login.tailscale.com/admin/invite/machine-share-browser';
    await expect(sectionA.getByLabel('Made on', { exact: true })).toHaveValue(isoDay(Date.now()), settled);
    await sectionA.getByLabel('Tailscale share link', { exact: true }).fill(link);
    await sectionA.getByRole('button', { name: 'Save for this machine' }).click();
    await expect(sectionA.locator('[data-share-state="ok"]')).toContainText(link, settled);
    await expect(async () => { await sync(); await reload(pageB); await expect(sectionB.locator('[data-share-state="ok"]')).toContainText(link, { timeout: 5_000 }); }).toPass({ timeout: 30_000 });
    await expect(sectionB.getByRole('link', { name: b.tailnet })).toBeVisible(settled);

    // Invite someone on each install: one message with the machine link and that install's own sign-in link.
    for (const [page, install, name, role] of [[pageA, a, 'sam', 'viewer'], [pageB, b, 'kim', 'maintainer']] as const) {
      const message = await invite(page, name, role);
      const text = await message.inputValue();
      const signInLink = await page.getByLabel('Sign-in link', { exact: true }).inputValue();
      expect(signInLink).toMatch(new RegExp(`^${install.tailnet.replace(/[.:/]/g, '\\$&')}/#sign-in=`));
      for (const part of [`Hi ${name}`, `${install.tailnet} as ${role}`, `this one is on port ${install.port}`, 'Two locks', `accept this machine share: ${link}`, 'reusable Tailscale share link; Tailscale expires it', "as far as the owner's tailnet policy allows", signInLink, 'single use, expires in 24 hours', 'does not sign you in to the others'])
        expect(text, `message carries ${part}`).toContain(part);
      expect(text).not.toMatch(/port \d+ only/);
      const copy = page.getByRole('button', { name: /^Copy Copy message:/ });
      await expect(copy).toHaveText('Copy message', settled);
      await copy.click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
    }

    // The invite redeems on its own install with its role.
    const code = (await pageA.getByLabel('Sign-in link', { exact: true }).inputValue()).split('#sign-in=')[1];
    const teammate = await open(a);
    const signedIn = teammate.waitForResponse(response => new URL(response.url()).pathname === '/api/sign-in');
    await teammate.goto(`/#sign-in=${code}`);
    expect((await (await signedIn).json()).actor).toMatchObject({ id: 'sam', team: 'viewer' });

    // An older link keeps its real expiry: made 25 days ago it warns, replaces A's for B too, and refuses invites once expired.
    await sectionA.getByLabel('Tailscale share link', { exact: true }).fill(link);
    await sectionA.getByLabel('Made on', { exact: true }).fill(isoDay(now - 25 * 86_400_000));
    await sectionA.getByRole('button', { name: 'Save for this machine' }).click();
    await expect(sectionA.locator('[data-share-state="refresh"]')).toContainText('expires within seven days', settled);
    await expect(async () => { await sync(); await reload(pageB); await expect(sectionB.locator('[data-share-state="refresh"]')).toContainText('expires within seven days', { timeout: 5_000 }); }).toPass({ timeout: 30_000 });
    now += 6 * 86_400_000;
    await reload(pageB);
    await expect(sectionB.locator('[data-share-state="expired"]')).toContainText('It has expired', settled);
    await sectionB.getByLabel('Name', { exact: true }).fill('max');
    await sectionB.getByRole('button', { name: 'Invite', exact: true }).click();
    await expect(sectionB.getByRole('alert')).toContainText('share link expired', settled);

    // Optional API mode: the owner's token is sealed to the machine, never shown, and each invite gets a single-use Tailscale link.
    const token = 'tskey-api-FAKE-browser-only';
    await sectionB.getByText('Optional: a single-use Tailscale invite per person').click();
    await sectionB.getByLabel('Tailscale API token', { exact: true }).fill(token);
    await sectionB.getByRole('button', { name: 'Save token' }).click();
    await expect(sectionB).toContainText('A token is saved: invites make single-use Tailscale links.', settled);
    await expect(sectionB.getByLabel('Tailscale API token', { exact: true })).toHaveValue('', settled);
    // The host answers the pending device invite while the page polls for it, as its loop would.
    const answering = setInterval(() => { void sync().catch(() => {}); }, 1_000);
    let apiMessage: string;
    try { apiMessage = await (await invite(pageB, 'ana', 'viewer')).inputValue(); } finally { clearInterval(answering); }
    expect(apiMessage).toContain('accept this machine share: https://login.tailscale.com/admin/invite/single-use-browser (single-use Tailscale invite, made for you)');
    expect(apiMessage).toContain(`${b.tailnet}/#sign-in=`);
    await expect(async () => { await sync(); await reload(pageA); await expect(sectionA).toContainText('A token is saved', { timeout: 5_000 }); }).toPass({ timeout: 30_000 });
    for (const page of [pageA, pageB]) expect(await page.content()).not.toContain(token);
  } finally {
    for (const context of contexts) await context.close();
    for (const install of installs) { await new Promise<void>(resolve => { install.http.close(() => resolve()); install.http.closeAllConnections(); }); await install.store.close(); }
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
});
