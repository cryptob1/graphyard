import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createServer, request } from 'node:http';
import { randomUUID } from 'node:crypto';
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

type Reply = { status: number; body: any };
/** A plain request to the 127.0.0.1 TCP port, with whatever headers a local process cares to forge. */
const overTcp = (port: number, path: string, headers: Record<string, string>) => new Promise<Reply>((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, headers }, res => {
    let data = ''; res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; }); res.on('end', () => resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : null }));
  });
  req.on('error', reject); req.end();
});
const call = async (url: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
  const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => null) };
};

// GY-3486: one Invite button for the installs on this machine. A teammate is a row naming their
// Tailscale login; tailscaled's identity header is trusted only on the socket it alone serves.
test('e2e:one-step-invite — Invite from the top bar admits a Tailscale login to both installs through their serve sockets, and revoking it there refuses her', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const hostDir = await temporaryDirectory('gy-one-step-invite'), machineDir = join(hostDir, 'machine');
  await mkdir(machineDir);
  await writeFile(join(machineDir, 'tailnet.json'), JSON.stringify({ dnsName: 'yard.tail-test.ts.net.', ip: '100.64.0.7', deviceId: 'nFAKE123CNTRL' }));
  const deviceInvites: unknown[] = [];
  const provider = createServer((req, res) => {
    let body = ''; req.setEncoding('utf8'); req.on('data', chunk => { body += chunk; });
    req.on('end', () => { deviceInvites.push(JSON.parse(body)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify([{ inviteUrl: `https://login.tailscale.com/admin/invite/one-step-${deviceInvites.length}` }])); });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const tailscaleApi = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const installs = await Promise.all(['a', 'b'].map(async name => {
    const store = await withDatabase(`one_step_invite_${name}`);
    await store.init();
    const engine = new Engine(store, 120, `owner/${name}`);
    engine.gitRunner = null;
    const loop = `test-loop-coordinator-${name}-credential-0123456789`, credentialFile = join(hostDir, `${name}.token`);
    await writeFile(credentialFile, loop, { mode: 0o600 });
    const token = `test-operator-${name}-credential-0123456789`, reader = `test-reader-${name}-credential-0123456789`;
    const http = server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token }, { id: 'loop', role: 'coordinator', token: loop }, { id: 'watcher', role: 'reader', token: reader }]);
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const socket = join(hostDir, `${name}.sock`), served = await http.serveSocket(socket);
    const port = (http.address() as { port: number }).port;
    return { name, store, http, served, socket, port, url: `http://127.0.0.1:${port}`, credentialFile, token, reader, tailnet: `http://yard.tail-test.ts.net:${port}` };
  }));
  const restorePath = onPath(await fakeTailscale(hostDir));
  await writeFile(join(hostDir, 'serve.json'), JSON.stringify(Object.fromEntries(installs.map(install => [install.port, install.url]))));
  const sync = () => settleHostLoops(installs, { machineDir, tailscaleApi });
  await sync();
  const [a, b] = installs;
  const contexts: BrowserContext[] = [];
  const settled = { timeout: 15_000 };
  try {
    const context = await browser.newContext();
    contexts.push(context);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL! });
    await context.route('**/*', async route => {
      const { pathname, search } = new URL(route.request().url());
      await route.fetch(pathname.startsWith('/api/') ? { url: a.url + pathname + search } : {}).then(response => route.fulfill({ response }), () => route.abort('connectionrefused')).catch(() => {});
    });
    const page = await context.newPage();
    const { code } = (await call(a.url, '/api/sign-in-links', a.token, {})).body;
    await page.goto('/#sign-in=' + code);
    const open = async (target: Page) => {
      await target.getByRole('button', { name: 'Invite', exact: true }).click();
      const dialog = target.getByRole('dialog', { name: 'Invite' });
      await expect(dialog).toBeVisible(settled);
      return dialog;
    };
    let dialog = await open(page);

    // Nothing saved for the machine yet: one line asks once for a Tailscale API token, sealed in this browser.
    await expect(dialog).toContainText('Paste a Tailscale API token once so each invite includes tailnet access.', settled);
    const apiToken = 'tskey-api-FAKE-one-step-only';
    await dialog.getByLabel('Tailscale API token', { exact: true }).fill(apiToken);
    await dialog.getByRole('button', { name: 'Save token', exact: true }).click();
    await expect(dialog.getByText('Paste a Tailscale API token once')).toHaveCount(0, settled);
    await sync();

    // Invite ana as Viewer (the default) to both installs (all checked) in one message: Tailscale's invite and both addresses, no Graphyard link.
    await dialog.getByLabel('Tailscale logins', { exact: true }).fill('ana@example.com');
    await expect(dialog.getByLabel('Role', { exact: true })).toHaveValue('viewer');
    for (const install of installs) await expect(dialog.getByRole('checkbox', { name: new RegExp(install.tailnet.replace(/[.:/]/g, '\\$&')) })).toBeChecked(settled);
    const answering = setInterval(() => { void sync().catch(() => {}); }, 1_000);
    try { await dialog.getByRole('button', { name: 'Invite', exact: true }).click(); await expect(dialog.getByLabel('Invitation message', { exact: true })).toBeVisible(settled); }
    finally { clearInterval(answering); }
    const message = await dialog.getByLabel('Invitation message', { exact: true }).inputValue();
    for (const part of ['ana@example.com', 'viewer', 'https://login.tailscale.com/admin/invite/one-step-1', a.tailnet, b.tailnet]) expect(message, `message carries ${part}`).toContain(part);
    expect(message).not.toContain('#sign-in=');
    expect(deviceInvites).toEqual([[{ multiUse: false, allowExitNode: false }]]);
    await dialog.getByRole('button', { name: /^Copy/ }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(message);
    await sync();

    // On each install's serve socket Tailscale's header is ana herself: Work answers her, and the history names her, with no sign-in step.
    for (const install of installs) {
      const status = await viaSocket(install.socket, '/api/status', 'ana@example.com');
      expect(status.status).toBe(200);
      expect(status.body.actor).toMatchObject({ id: 'ana@example.com', role: 'reader', team: 'viewer', sessionKind: 'human' });
      expect((await viaSocket(install.socket, '/api/work-snapshot', 'ana@example.com')).status).toBe(200);
      const history = await viaSocket(install.socket, '/api/events?view=rows&kind=team.signed-in', 'ana@example.com');
      expect(history.body.map((event: { actor: string }) => event.actor)).toContain('ana@example.com');
      const bob = await viaSocket(install.socket, '/api/work-snapshot', 'bob@example.com');
      expect(bob.status).toBe(403);
      expect(bob.body.error).toBe('You are not invited to this install. Ask the owner to invite bob@example.com.');
      // The same header on the 127.0.0.1 TCP port is anyone's to forge: it opens no session.
      const forged = await overTcp(install.port, '/api/status', { 'Tailscale-User-Login': 'ana@example.com', Host: `yard.tail-test.ts.net:${install.port}` });
      expect(forged.status).toBe(401);
      const local = await overTcp(install.port, '/api/status', { 'Tailscale-User-Login': 'ana@example.com', Host: `127.0.0.1:${install.port}` });
      expect(JSON.stringify(local.body)).not.toContain('ana@example.com');
    }

    // The dialog lists every teammate persistently.
    await page.reload();
    dialog = await open(page);
    const teammates = dialog.getByRole('list', { name: 'Teammates' });
    await expect(teammates.getByRole('listitem').filter({ hasText: 'ana@example.com' })).toContainText('viewer', settled);
    await expect(teammates.getByRole('listitem').filter({ hasText: 'ana@example.com' })).toContainText(b.tailnet, settled);

    // Only the operator's human session invites: a reader, a maintainer and an operator-agent identity are refused.
    expect((await call(a.url, '/api/invites', a.token, { name: 'mo@example.com', role: 'maintainer', share: 'reusable' })).status).toBe(200);
    expect((await viaSocket(a.socket, '/api/status', 'mo@example.com')).body.actor).toMatchObject({ id: 'mo@example.com', team: 'maintainer' });
    expect((await viaSocket(a.socket, '/api/invites', 'mo@example.com', { logins: ['eve@example.com'], role: 'viewer', installs: [a.tailnet] })).status).toBe(403);
    expect((await call(a.url, '/api/invites', a.reader, { logins: ['eve@example.com'], role: 'viewer', installs: [a.tailnet] })).status).toBe(403);
    const agentToken = `operator-agent-${randomUUID()}`;
    expect((await call(a.url, '/api/operator-agents', a.token, { id: 'helper', displayName: 'Helper', capabilities: [], scope: { repositories: ['owner/a'], workItems: ['*'] }, token: agentToken, reason: 'proves invites refuse agents' })).status).toBe(200);
    expect((await call(a.url, '/api/invites', agentToken, { logins: ['eve@example.com'], role: 'viewer', installs: [a.tailnet] })).status).toBe(403);

    // Two logins in one invite: one multi-use Tailscale device invite serves both.
    await dialog.getByLabel('Tailscale logins', { exact: true }).fill('cy@example.com, di@example.com');
    const again = setInterval(() => { void sync().catch(() => {}); }, 1_000);
    try { await dialog.getByRole('button', { name: 'Invite', exact: true }).click(); await expect(dialog.getByLabel('Invitation message', { exact: true })).toHaveValue(/one-step-2/, settled); }
    finally { clearInterval(again); }
    expect(deviceInvites[1]).toEqual([{ multiUse: true, allowExitNode: false }]);

    // Revoke ana in the dialog: her next socket request on either install is refused.
    await teammates.getByRole('listitem').filter({ hasText: 'ana@example.com' }).getByRole('button', { name: 'Revoke' }).click();
    await expect(teammates.getByRole('listitem').filter({ hasText: 'ana@example.com' })).toHaveCount(0, settled);
    await sync();
    for (const install of installs) {
      const refused = await viaSocket(install.socket, '/api/work-snapshot', 'ana@example.com');
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe('You are not invited to this install. Ask the owner to invite ana@example.com.');
    }
    expect(await page.content()).not.toContain(apiToken);
  } finally {
    restorePath();
    for (const context of contexts) await context.close();
    for (const install of installs) {
      install.served.close();
      await new Promise<void>(resolve => { install.http.close(() => resolve()); install.http.closeAllConnections(); });
      await install.store.close();
    }
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
});
