import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createServer } from 'node:http';
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

// GY-3294: two installs on one simulated Tailscale machine, each served on its own port, share the
// machine's Tailscale link. GY-3486: each invites from the top bar's Invite dialog with one message
// carrying the link and its own address; the person's Tailscale login is their sign-in on that install alone.
test('e2e:one-click-team-access — two installs share the machine link and copy one invitation each from the Invite dialog', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const hostDir = await temporaryDirectory('gy-team-access'), machineDir = join(hostDir, 'machine');
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
    const socket = join(hostDir, `${name}.sock`), served = await http.serveSocket(socket);
    const port = (http.address() as { port: number }).port;
    return { name, store, http, served, socket, port, url: `http://127.0.0.1:${port}`, credentialFile, token: `test-operator-${name}`, tailnet: `http://yard.tail-test.ts.net:${port}` };
  }));
  // Each install's master loop on the shared host, as the loop runs it every 15 seconds: settled
  // here whenever a page is about to read what the other install saved, and a short ticker only
  // while the page polls for the single-use invite its host must answer (setup.tsx polls every second).
  // GY-3411: the loops are settled before the one reload, so the page's read is waited for, not raced:
  // retrying sync-and-reload cut short the page's read on a loaded host, even with GY-3412's 5 s wait.
  // up served both installs on their own ports; each loop reads that from the tailscale command.
  const restorePath = onPath(await fakeTailscale(hostDir));
  await writeFile(join(hostDir, 'serve.json'), JSON.stringify(Object.fromEntries(installs.map(install => [install.port, install.url]))));
  const sync = () => settleHostLoops(installs, { machineDir, tailscaleApi });
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
  const settled = { timeout: 15_000 };
  /** GY-3486: Invite opens from the top bar of any page of the operator's human session. */
  const dialogOf = async (page: Page) => {
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Invite' });
    await expect(dialog).toBeVisible(settled);
    return dialog;
  };
  const signIn = async (page: Page, install: typeof a) => {
    const { code } = await (await fetch(install.url + '/api/sign-in-links', { method: 'POST', headers: { Authorization: `Bearer ${install.token}` } })).json() as { code: string };
    await page.goto('/#sign-in=' + code + '&setup');
    return dialogOf(page);
  };
  /** Reload on its own address, as the person would; the spent sign-in link stays out of the address bar. */
  const reload = async (page: Page) => { await page.goto('/#setup'); await page.reload(); return dialogOf(page); };
  const addressOf = (install: typeof a) => new RegExp(install.tailnet.replace(/[.:/]/g, '\\$&'));
  /** Invite LOGIN as ROLE to INSTALL alone (the other install unticked); the message, or the missing step. */
  const invite = async (dialog: Awaited<ReturnType<typeof dialogOf>>, login: string, role: string, install: typeof a) => {
    await dialog.getByLabel('Tailscale logins', { exact: true }).fill(login);
    await dialog.getByLabel('Role', { exact: true }).selectOption(role);
    for (const other of installs) await dialog.getByRole('checkbox', { name: addressOf(other) }).setChecked(other === install);
    await dialog.getByRole('button', { name: 'Invite', exact: true }).click();
  };
  const message = (dialog: Awaited<ReturnType<typeof dialogOf>>) => dialog.getByLabel('Invitation message', { exact: true });
  try {
    const pageA = await open(a), pageB = await open(b);
    let dialogA = await signIn(pageA, a), dialogB = await signIn(pageB, b);

    // Each install's dialog lists both installs on the machine by their own tailnet address and port, all ticked.
    for (const dialog of [dialogA, dialogB]) for (const install of installs) await expect(dialog.getByRole('checkbox', { name: addressOf(install) })).toBeChecked(settled);

    // With no share link or token saved, the dialog asks once for a token, and Invite withholds the message and names the missing step.
    await expect(dialogA).toContainText('Paste a Tailscale API token once so each invite includes tailnet access.', settled);
    await invite(dialogA, 'early@example.com', 'viewer', a);
    await expect(dialogA.getByRole('status')).toContainText('Tailscale access is missing from this message', settled);
    await expect(message(dialogA)).toHaveCount(0, settled);

    // A share link saved for the machine on A (with the day it was made) reaches B after the host loops sync.
    const link = 'https://login.tailscale.com/admin/invite/machine-share-browser';
    expect((await (await fetch(a.url + '/api/team-access/share-link', { method: 'POST', headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: link, createdOn: isoDay(now) }) })).json()).shareLink.state).toBe('ok');
    await sync(); dialogB = await reload(pageB);
    await expect(dialogB.getByText('Paste a Tailscale API token once')).toHaveCount(0, settled);

    // Invite on each install: one message with the machine link and that install's own address, no Graphyard sign-in link, copied whole.
    for (const [page, dialog, install, other, login, role] of [[pageA, dialogA, a, b, 'sam@example.com', 'viewer'], [pageB, dialogB, b, a, 'kim@example.com', 'maintainer']] as const) {
      await invite(dialog, login, role, install);
      await expect(message(dialog)).toBeVisible(settled);
      const text = await message(dialog).inputValue();
      for (const part of [`Hi ${login}`, `as ${role}`, `Accept this Tailscale share of the machine: ${link}`, 'reusable share link', install.tailnet, 'Tailscale signs you in'])
        expect(text, `message carries ${part}`).toContain(part);
      expect(text).not.toContain(other.tailnet);
      expect(text).not.toContain('#sign-in=');
      await dialog.getByRole('button', { name: /^Copy/ }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
    }

    // Each person reaches only the install they were invited to, as themselves and with their role, through its serve socket.
    await sync();
    expect((await viaSocket(a.socket, '/api/status', 'sam@example.com')).body.actor).toMatchObject({ id: 'sam@example.com', team: 'viewer' });
    expect((await viaSocket(b.socket, '/api/status', 'kim@example.com')).body.actor).toMatchObject({ id: 'kim@example.com', team: 'maintainer' });
    expect((await viaSocket(b.socket, '/api/status', 'sam@example.com')).status).toBe(403);
    expect((await viaSocket(a.socket, '/api/status', 'kim@example.com')).status).toBe(403);

    // An older link keeps its real expiry: made 25 days ago it replaces A's for B too, and refuses invites once expired.
    await fetch(a.url + '/api/team-access/share-link', { method: 'POST', headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: link, createdOn: isoDay(now - 25 * 86_400_000) }) });
    await sync();
    now += 6 * 86_400_000;
    dialogB = await reload(pageB);
    await invite(dialogB, 'max@example.com', 'viewer', b);
    await expect(dialogB.getByRole('alert')).toContainText('share link expired', settled);

    // The API token: sealed to the machine in the browser, never shown, and each invite gets a single-use Tailscale link.
    const token = 'tskey-api-FAKE-browser-only';
    await dialogB.getByLabel('Tailscale API token', { exact: true }).fill(token);
    await dialogB.getByRole('button', { name: 'Save token' }).click();
    await expect(dialogB.getByText('Paste a Tailscale API token once')).toHaveCount(0, settled);
    await sync();
    // The host answers the pending device invite while the dialog polls for it, as its loop would.
    const answering = setInterval(() => { void sync().catch(() => {}); }, 1_000);
    try { await invite(dialogB, 'ana@example.com', 'viewer', b); await expect(message(dialogB)).toBeVisible(settled); } finally { clearInterval(answering); }
    const apiMessage = await message(dialogB).inputValue();
    expect(apiMessage).toContain('https://login.tailscale.com/admin/invite/single-use-browser (single-use invite, made for you)');
    expect(apiMessage).toContain(b.tailnet);
    await sync(); dialogA = await reload(pageA);
    await expect(dialogA.getByText('Paste a Tailscale API token once')).toHaveCount(0, settled);
    for (const page of [pageA, pageB]) expect(await page.content()).not.toContain(token);

    // The teammates stay listed after reload; Revoke there refuses the person's next request.
    const sam = dialogA.getByRole('list', { name: 'Teammates' }).getByRole('listitem').filter({ hasText: 'sam@example.com' });
    await expect(sam).toContainText('viewer', settled);
    await sam.getByRole('button', { name: 'Revoke' }).click();
    await expect(sam).toHaveCount(0, settled);
    expect((await viaSocket(a.socket, '/api/status', 'sam@example.com')).status).toBe(403);
  } finally {
    restorePath();
    for (const context of contexts) await context.close();
    for (const install of installs) { install.served.close(); await new Promise<void>(resolve => { install.http.close(() => resolve()); install.http.closeAllConnections(); }); await install.store.close(); }
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
});
