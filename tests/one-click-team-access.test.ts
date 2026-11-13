import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { applyTailnetCommand, readTailnet, runUp, type UpDependencies } from '../src/up.js';
import { guideTopics as guides } from '../src/guide.js';
import { credentialMaskFor, masterCredentialMask } from '../src/master/confinement.js';
import { teamAccessSummary } from '../src/team-access.js';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3294: one machine, many installs, one port each; two locks — the machine's tailnet and each install's own sign-in.
const operator = 'test-human-operator-token';
const minute = 60_000, hour = 60 * minute, day = 24 * hour;

/** A fake `tailscale` on PATH: the only thing stubbed. It answers status for one node and keeps a serve config keyed by port, as `tailscale serve --bg --http=PORT` does. */
async function fakeTailscale(dir: string) {
  await mkdir(join(dir, 'bin'), { recursive: true });
  const script = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const file = path.join(__dirname, '..', 'serve.json'), log = path.join(__dirname, '..', 'calls.log');
const args = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify(args) + '\\n');
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
if (args[0] === 'status') { process.stdout.write(JSON.stringify({ Self: { ID: 'nFAKE123CNTRL', DNSName: 'yard.tail-test.ts.net.', TailscaleIPs: ['100.64.0.7', 'fd7a::7'], Online: true } })); process.exit(0); }
if (args[0] === 'serve' && args[1] === 'status') { process.stdout.write(JSON.stringify(config)); process.exit(0); }
if (args[0] === 'serve' && args[1] === 'reset') { fs.writeFileSync(file, '{}'); process.exit(0); }
if (args[0] === 'serve') { const port = /--http=(\\d+)/.exec(args.join(' '))[1]; config[port] = args[args.length - 1]; fs.writeFileSync(file, JSON.stringify(config)); process.exit(0); }
process.exit(1);
`;
  await writeFile(join(dir, 'bin', 'tailscale'), script);
  await chmod(join(dir, 'bin', 'tailscale'), 0o755);
}

async function up(root: string, port: number, machineDir: string, path: string) {
  await mkdir(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const previous = process.env.PATH, notes: string[] = [];
  process.env.PATH = path;
  try {
    const dependencies = {
      root, emit: (event: { kind: string; text?: string }) => { if (event.kind === 'note') notes.push(event.text!); }, now: Date.now, sleep: async () => {},
      serverUrl: async () => `http://127.0.0.1:${port}`, masterToken: async () => null, status: async () => null, publishOnboarding: async () => null,
      gh: async () => ({ code: 0, stdout: '{}' }), git: async () => ({ code: 0, stdout: '' }), cli: async () => ({ code: 0, stdout: '{}' }),
      tailnet: readTailnet, applyTailnet: applyTailnetCommand, machineDir, humanWaitMs: 0, machineWaitMs: 0,
    } as unknown as UpDependencies;
    const result = await runUp({ repository: `owner/install-${port}` } as Parameters<typeof runUp>[0], dependencies);
    return { reachableUrl: result.reachableUrl, notes };
  } finally { process.env.PATH = previous; }
}

test('unit:tests/one-click-team-access.test.ts — up serves each install on its own port by default, idempotently, and carries on without Tailscale', async () => {
  const host = await temporaryDirectory('team-access-host'), machineDir = join(host, 'machine');
  await fakeTailscale(host);
  const path = `${join(host, 'bin')}:${process.env.PATH}`;
  const a = await up(join(host, 'a'), 4311, machineDir, path);
  const b = await up(join(host, 'b'), 4312, machineDir, path);
  assert.equal(a.reachableUrl, 'http://yard.tail-test.ts.net:4311');
  assert.equal(b.reachableUrl, 'http://yard.tail-test.ts.net:4312');
  const rerun = await up(join(host, 'a'), 4311, machineDir, path);
  assert.equal(rerun.reachableUrl, 'http://yard.tail-test.ts.net:4311');
  const calls = (await readFile(join(host, 'calls.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const serves = calls.filter(args => args[0] === 'serve');
  assert.deepEqual(serves, [
    ['serve', '--bg', '--http=4311', 'http://127.0.0.1:4311'], ['serve', '--bg', '--http=4312', 'http://127.0.0.1:4312'], ['serve', '--bg', '--http=4311', 'http://127.0.0.1:4311'],
  ], 'every run forwards its own port automatically, with no --share-tailnet, and never resets another');
  assert.deepEqual(JSON.parse(await readFile(join(host, 'serve.json'), 'utf8')), { 4311: 'http://127.0.0.1:4311', 4312: 'http://127.0.0.1:4312' }, 'rerunning A keeps B served');
  assert.deepEqual(JSON.parse(await readFile(join(machineDir, 'tailnet.json'), 'utf8')), { dnsName: 'yard.tail-test.ts.net.', ip: '100.64.0.7', deviceId: 'nFAKE123CNTRL' });

  const bare = await temporaryDirectory('team-access-no-tailscale');
  await mkdir(join(bare, 'empty'));
  const local = await up(join(bare, 'c'), 4313, join(bare, 'machine'), join(bare, 'empty'));
  assert.equal(local.reachableUrl, null, 'without Tailscale the install continues on this machine only');
  assert.ok(!local.notes.some(note => /did not finish/.test(note)));
});

async function install(label: string, env: NodeJS.ProcessEnv, clock: () => number) {
  const store = await withDatabase(label);
  await store.init();
  const engine = new Engine(store, 120, `owner/${label}`);
  engine.gitRunner = null;
  const http = server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token: operator }], { env, clock });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port, base = `http://127.0.0.1:${port}`;
  const call = async (path: string, body?: unknown, token = operator) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any, text: '' };
  };
  const redeem = async (code: string) => {
    const response = await fetch(`${base}/api/sign-in`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    return { status: response.status, body: await response.json() as any };
  };
  return { store, http, port, call, redeem, close: async () => { await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }); await store.close(); } };
}

test('unit:tests/one-click-team-access.test.ts — two installs share the machine link, invite with both links, and redeem only where intended within 24 hours', async () => {
  const host = await temporaryDirectory('team-access-servers'), machineDir = join(host, 'machine');
  await mkdir(machineDir);
  await writeFile(join(machineDir, 'tailnet.json'), JSON.stringify({ dnsName: 'yard.tail-test.ts.net.', ip: '100.64.0.7', deviceId: 'nFAKE123CNTRL' }));
  const requests: { url: string; auth: string; body: string }[] = [];
  let providerStatus = 200;
  const provider = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: `${req.method} ${req.url}`, auth: String(req.headers.authorization), body });
    res.writeHead(providerStatus, { 'Content-Type': 'application/json' });
    res.end(providerStatus === 200 ? JSON.stringify([{ id: 'inv1', multiUse: false, inviteUrl: 'https://login.tailscale.com/admin/invite/single-use-test' }]) : JSON.stringify({ message: 'not authorized' }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  let now = Date.parse('2026-11-13T12:00:00Z');
  const env = { ...process.env, GRAPHYARD_MACHINE_DIR: machineDir, GRAPHYARD_TAILSCALE_API: `http://127.0.0.1:${(provider.address() as { port: number }).port}` };
  const logged: string[] = [], original = { log: console.log, error: console.error, warn: console.warn };
  for (const name of ['log', 'error', 'warn'] as const) console[name] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  const a = await install('team_access_a', env, () => now), b = await install('team_access_b', env, () => now);
  try {
    const empty = (await a.call('/api/team-access')).body;
    assert.equal(empty.installUrl, `http://yard.tail-test.ts.net:${a.port}`);
    assert.equal(empty.shareLink, null);
    assert.match(empty.guidance, /No Tailscale share link is saved for this machine yet.*Share.*paste it here/);
    assert.match(empty.acl, new RegExp(`"tcp:${a.port}"`));
    assert.match(empty.acl, /autogroup:shared/);
    assert.equal(empty.summary, teamAccessSummary);
    assert.equal((await a.call('/api/team-access', undefined, 'not-a-token')).status, 401);

    const link = 'https://login.tailscale.com/admin/invite/machine-share-test';
    assert.equal((await a.call('/api/team-access/share-link', { url: 'https://evil.example/x' })).status, 400);
    const saved = (await a.call('/api/team-access/share-link', { url: link })).body.shareLink;
    assert.equal(saved.url, link);
    assert.equal(saved.expiresAt, new Date(now + 30 * day).toISOString(), 'Tailscale expires the share link 30 days after it was made');
    const onB = (await b.call('/api/team-access')).body;
    assert.deepEqual(onB.shareLink, saved, 'install B on the same machine shows the link pasted on A');
    assert.equal(onB.installUrl, `http://yard.tail-test.ts.net:${b.port}`);
    assert.match(onB.acl, new RegExp(`"tcp:${b.port}"`));

    const inviteA = (await a.call('/api/invites', { name: 'sam', role: 'viewer' })).body;
    const inviteB = (await b.call('/api/invites', { name: 'kim', role: 'maintainer' })).body;
    for (const [invite, install, name] of [[inviteA, a, 'sam'], [inviteB, b, 'kim']] as const) {
      const url = `http://yard.tail-test.ts.net:${install.port}`;
      assert.equal(invite.link, `${url}/#sign-in=${invite.code}`);
      assert.deepEqual(invite.share, { url: link, kind: 'reusable', expiresAt: saved.expiresAt });
      for (const part of [`Hi ${name}`, url, `port ${install.port} only`, 'Two locks', link, `reusable, Tailscale expires it ${saved.expiresAt.slice(0, 10)}`, invite.link, 'single use, expires in 24 hours', 'One machine runs several Graphyard installs, one port each'])
        assert.ok(invite.message.includes(part), `the message carries ${part}:\n${invite.message}`);
      assert.equal(invite.expiresAt, new Date(now + day).toISOString());
    }

    assert.equal((await b.redeem(inviteA.code)).status, 401, "A's invite cannot sign in to B");
    now += 11 * minute;
    const session = await a.redeem(inviteA.code);
    assert.equal(session.status, 200, 'an invite still works after ten minutes');
    assert.deepEqual([session.body.actor.id, session.body.actor.team], ['sam', 'viewer']);
    assert.equal((await b.call('/api/status', undefined, session.body.token)).status, 401, "A's session does not authenticate against B");
    assert.equal((await a.redeem(inviteA.code)).status, 401, 'an invite works once');
    now += day - 11 * minute - minute;
    assert.equal((await b.redeem(inviteB.code)).status, 200, 'an invite still works a minute before 24 hours');
    const late = (await a.call('/api/invites', { name: 'lee', role: 'viewer' })).body;
    now += day;
    assert.equal((await a.redeem(late.code)).status, 401, 'an unused invite expires at 24 hours');

    // Reusable link: an older link keeps its real expiry, warns in its last seven days, is replaced for both, and refuses invites once expired.
    now = Date.parse(saved.savedAt) + 24 * day;
    assert.equal((await b.call('/api/team-access/share-link', { url: link })).body.shareLink.savedAt, saved.savedAt, 'pasting the same link again keeps its expiry');
    assert.equal((await a.call('/api/team-access')).body.shareLink.state, 'refresh');
    now = Date.parse(saved.savedAt) + 30 * day;
    assert.equal((await b.call('/api/team-access')).body.shareLink.state, 'expired');
    const refused = await a.call('/api/invites', { name: 'max', role: 'viewer' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /share link expired .*paste it on Setup/);
    const fresh = 'https://login.tailscale.com/admin/invite/fresh-share';
    await b.call('/api/team-access/share-link', { url: fresh });
    assert.deepEqual((await a.call('/api/team-access')).body.shareLink, { url: fresh, savedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * day).toISOString(), state: 'ok' });

    // Optional API mode: the owner's token is written 0600 for the machine, never answered back, and each invite asks Tailscale for one single-use device invite.
    const token = 'tskey-api-FAKE-not-a-real-token-1234';
    const savedToken = await a.call('/api/team-access/tailscale-token', { token });
    assert.equal(savedToken.status, 200);
    assert.equal(savedToken.body.mode, 'api');
    assert.equal(((await stat(join(machineDir, 'tailscale-api-token'))).mode & 0o777), 0o600);
    assert.equal((await b.call('/api/team-access')).body.mode, 'api', 'the token serves every install on the machine');
    const apiInvite = await b.call('/api/invites', { name: 'ana', role: 'viewer' });
    assert.equal(apiInvite.status, 200);
    assert.deepEqual(requests.map(request => [request.url, request.auth, JSON.parse(request.body)]), [['POST /api/v2/device/nFAKE123CNTRL/device-invites', `Bearer ${token}`, [{ multiUse: false, allowExitNode: false }]]]);
    assert.deepEqual(apiInvite.body.share, { url: 'https://login.tailscale.com/admin/invite/single-use-test', kind: 'single-use' });
    assert.ok(apiInvite.body.message.includes('https://login.tailscale.com/admin/invite/single-use-test (Tailscale share link, single use, made for you)'));
    assert.ok(apiInvite.body.message.includes(`http://yard.tail-test.ts.net:${b.port}/#sign-in=${apiInvite.body.code}`));
    providerStatus = 403;
    const failed = await a.call('/api/invites', { name: 'zoe', role: 'viewer' });
    assert.equal(failed.status, 502);
    assert.match(failed.body.error, /Tailscale refused the device invite \(403: not authorized\); no invite was made/);
    assert.equal((await a.store.pool.query("SELECT 1 FROM team_members WHERE name='zoe'")).rowCount, 0, 'a refused Tailscale invite leaves no Graphyard invite');
    const visible = JSON.stringify([savedToken.body, apiInvite.body, failed.body, (await a.call('/api/team-access')).body, logged, await readFile(join(machineDir, 'tailnet.json'), 'utf8')]);
    assert.ok(!visible.includes(token), 'the token appears in no response, record or log');
    assert.equal((await a.call('/api/team-access/tailscale-token', { token: '' })).body.mode, 'reusable', 'removing the token returns to the share link');
  } finally {
    Object.assign(console, original);
    await a.close(); await b.close();
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
});

test('unit:tests/one-click-team-access.test.ts — the machine directory holding the Tailscale token is masked from confined sessions and the Chief', async () => {
  const home = await temporaryDirectory('team-access-mask'), machine = join(home, 'machine'), own = join(home, 'own-install');
  await mkdir(machine); await mkdir(own);
  await writeFile(join(machine, 'tailscale-api-token'), 'tskey-api-FAKE\n', { mode: 0o600 });
  assert.equal(credentialMaskFor({}, { credentialFile: join(own, 'token') }, home).configHome, home, 'workers, reviewers and producers lose the whole config home, the machine directory with it');
  const chief = masterCredentialMask({ credentialFile: join(own, 'token') }, [], home);
  assert.ok(chief.hostPaths!.includes(machine), 'the master session reads its own install directory, never the machine token');
  assert.ok(!chief.hostPaths!.includes(own));
});

test('unit:tests/one-click-team-access.test.ts — README, the infra and setup guides, and the summary say the same thing', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /one machine, many installs, one port each; two locks: tailnet plus per-install sign-in/);
  for (const phrase of ['one machine, many installs, one port each', 'tailscale serve --bg --http=PORT', "Two locks keep each install private: the machine's tailnet, then the install's own Graphyard sign-in", 'expires that link after 30 days', 'expires in 24 hours', 'single-use Tailscale device invite', 'tailnet policy grant'])
    assert.ok(guides.infra.includes(phrase), `guide infra says: ${phrase}`);
  assert.match(guides.setup, /one machine, many installs, one port each; two locks: tailnet plus per-install sign-in/);
  assert.match(teamAccessSummary, /One machine, many installs, one port each\. Two locks .*tailnet.*own Graphyard sign-in/);
});
