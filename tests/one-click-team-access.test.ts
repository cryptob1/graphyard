import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { applyTailnetCommand, readTailnet, runUp, tailscaleMissingNote, type UpDependencies } from '../src/up.js';
import { guideTopics as guides } from '../src/guide.js';
import { credentialMaskFor, masterCredentialMask } from '../src/master/confinement.js';
import { aclGuidance, teamAccessSummary } from '../src/team-access.js';
import { syncTeamAccess } from '../src/master/team-access.js';
import { settleHostLoops } from './helpers/team-access-hosts.js';
import { sealForHost } from '../web/seal.js';
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
  assert.ok(local.notes.includes(tailscaleMissingNote), 'a host without Tailscale gets one install instruction');
  assert.match(tailscaleMissingNote, /install Tailscale \(https:\/\/tailscale\.com\/download\).*rerun graphyard up/);
});

const coordinator = (label: string) => `test-loop-coordinator-${label}-credential-0123456789`;
async function install(label: string, host: string, clock: () => number) {
  const store = await withDatabase(label);
  await store.init();
  const engine = new Engine(store, 120, `owner/${label}`);
  engine.gitRunner = null;
  const http = server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token: operator }, { id: 'loop', role: 'coordinator', token: coordinator(label) }], { clock });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port, base = `http://127.0.0.1:${port}`;
  const call = async (path: string, body?: unknown, token = operator) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const redeem = async (code: string) => {
    const response = await fetch(`${base}/api/sign-in`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    return { status: response.status, body: await response.json() as any };
  };
  const credentialFile = join(host, `${label}.token`);
  await writeFile(credentialFile, coordinator(label), { mode: 0o600 });
  return { store, http, port, call, redeem, credentialFile, base, close: async () => { await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }); await store.close(); } };
}

test('unit:tests/one-click-team-access.test.ts — two installs share the machine link through their host loops, invite with both links, and redeem only where intended within 24 hours', async () => {
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
  const tailscaleApi = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  let now = Date.parse('2026-11-13T12:00:00Z');
  const logged: string[] = [], original = { log: console.log, error: console.error, warn: console.warn };
  for (const name of ['log', 'error', 'warn'] as const) console[name] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  const a = await install('team_access_a', host, () => now), b = await install('team_access_b', host, () => now);
  /** One pass of each install's master loop on the shared host (master/team-access.ts). */
  const sync = async (...installs: typeof a[]) => { for (const entry of installs) await syncTeamAccess({ url: entry.base, credentialFile: entry.credentialFile }, { machineDir, tailscaleApi }); };
  try {
    const before = (await a.call('/api/team-access')).body;
    assert.equal(before.installUrl, null, 'the server never reads the host machine directory itself');
    assert.match(before.guidance, /Tailscale is not serving this machine.*https:\/\/tailscale\.com\/download/);
    const local = (await a.call('/api/invites', { name: 'early', role: 'viewer', origin: a.base })).body;
    assert.equal(local.message, null, 'no tailnet: the message is withheld');
    assert.match(local.missing, /Tailscale is not serving this machine/);

    await sync(a, b);
    const empty = (await a.call('/api/team-access')).body;
    assert.equal(empty.installUrl, `http://yard.tail-test.ts.net:${a.port}`);
    assert.equal(empty.shareLink, null);
    assert.match(empty.guidance, /No Tailscale share link is saved for this machine yet, so Invite cannot make a complete message.*Share.*paste it here/);
    assert.match(empty.acl, new RegExp(`"tcp:${a.port}"`));
    assert.match(empty.acl, /"TEAMMATE@example\.com"/);
    assert.match(empty.acl, /"100\.64\.0\.7"/);
    assert.equal(empty.aclGuidance, aclGuidance);
    assert.equal(empty.summary, teamAccessSummary);
    assert.equal((await a.call('/api/team-access', undefined, 'not-a-token')).status, 401);
    assert.equal((await a.call('/api/team-access', undefined, coordinator('team_access_a'))).status, 403, 'only the operator reads team access');
    const withheld = (await a.call('/api/invites', { name: 'early', role: 'viewer' })).body;
    assert.equal(withheld.message, null, 'without a share link no supposedly complete message is made');
    assert.match(withheld.missing, /No Tailscale share link is saved/);

    // The owner pastes the link on A with the day it was made; B shows it after the host loops' next pass.
    const link = 'https://login.tailscale.com/admin/invite/machine-share-test';
    assert.equal((await a.call('/api/team-access/share-link', { url: 'https://evil.example/x' })).status, 400);
    assert.equal((await a.call('/api/team-access/share-link', { url: link, createdOn: 'last week' })).status, 400);
    const saved = (await a.call('/api/team-access/share-link', { url: link })).body.shareLink;
    assert.deepEqual(saved, { url: link, createdOn: '2026-11-13', expiresAt: '2026-12-13T00:00:00.000Z', state: 'ok' }, 'made today unless the owner says otherwise; Tailscale expires it 30 days later');
    assert.equal((await b.call('/api/team-access')).body.shareLink, null, 'B learns it from the machine, not from A');
    await sync(a, b);
    assert.deepEqual(JSON.parse(await readFile(join(machineDir, 'tailnet.json'), 'utf8')).shareLink, { url: link, createdOn: '2026-11-13', expiresAt: '2026-12-13T00:00:00.000Z' });
    const onB = (await b.call('/api/team-access')).body;
    assert.deepEqual(onB.shareLink, saved, 'install B on the same machine shows the link pasted on A');
    assert.equal(onB.installUrl, `http://yard.tail-test.ts.net:${b.port}`);
    assert.match(onB.acl, new RegExp(`"tcp:${b.port}"`));
    await sync(a, b);
    assert.deepEqual((await a.call('/api/team-access')).body.shareLink, saved, 'a later pass does not re-apply or lose it');

    const inviteA = (await a.call('/api/invites', { name: 'sam', role: 'viewer' })).body;
    const inviteB = (await b.call('/api/invites', { name: 'kim', role: 'maintainer' })).body;
    for (const [invite, install, name] of [[inviteA, a, 'sam'], [inviteB, b, 'kim']] as const) {
      const url = `http://yard.tail-test.ts.net:${install.port}`;
      assert.equal(invite.link, `${url}/#sign-in=${invite.code}`);
      assert.equal(invite.missing, null);
      assert.deepEqual(invite.share, { url: link, kind: 'reusable', expiresAt: saved.expiresAt });
      for (const part of [`Hi ${name}`, `${url} as`, `this one is on port ${install.port}`, 'Two locks', `accept this machine share: ${link}`, 'reusable Tailscale share link; Tailscale expires it 2026-12-13', "reach this machine, as far as the owner's tailnet policy allows", invite.link, 'single use, expires in 24 hours', 'does not sign you in to the others', 'One machine runs several Graphyard installs, one port each'])
        assert.ok(invite.message.includes(part), `the message carries ${part}:\n${invite.message}`);
      assert.doesNotMatch(invite.message, /port \d+ only/, 'the share reaches the machine, not one port');
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

    // An older pasted link keeps its real expiry: made 25 days ago it warns now, and refuses invites five days on.
    now = Date.parse('2026-11-20T12:00:00Z');
    const older = (await b.call('/api/team-access/share-link', { url: link, createdOn: '2026-10-26' })).body.shareLink;
    assert.deepEqual([older.expiresAt, older.state], ['2026-11-25T00:00:00.000Z', 'refresh']);
    await sync(b, a);
    assert.equal((await a.call('/api/team-access')).body.shareLink.state, 'refresh', 'the replacement reaches A too');
    now = Date.parse('2026-11-25T00:00:00Z');
    assert.equal((await a.call('/api/team-access')).body.shareLink.state, 'expired');
    const refused = await a.call('/api/invites', { name: 'max', role: 'viewer' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /share link expired 2026-11-25.*paste it on Setup/);
    const fresh = 'https://login.tailscale.com/admin/invite/fresh-share';
    await a.call('/api/team-access/share-link', { url: fresh });
    await sync(a, b);
    assert.deepEqual((await b.call('/api/team-access')).body.shareLink, { url: fresh, createdOn: '2026-11-25', expiresAt: '2026-12-25T00:00:00.000Z', state: 'ok' });

    // Optional API mode: the token is sealed to the host in the browser, written 0600 by the host alone, never answered back.
    const token = 'tskey-api-FAKE-not-a-real-token-1234';
    assert.equal((await a.call('/api/team-access/tailscale-token', { token })).status, 400, 'a token in the clear is refused');
    const sealed = await sealForHost((await a.call('/api/team-access')).body.hostKey, token);
    const savedToken = await a.call('/api/team-access/tailscale-token', { sealed });
    assert.equal(savedToken.status, 200);
    assert.equal(savedToken.body.mode, 'api');
    await sync(a, b);
    assert.equal(((await stat(join(machineDir, 'tailscale-api.token'))).mode & 0o777), 0o600);
    assert.equal((await readFile(join(machineDir, 'tailscale-api.token'), 'utf8')).trim(), token);
    assert.equal((await b.call('/api/team-access')).body.mode, 'api', 'the token serves every install on the machine');

    // Invite someone in API mode: Tailscale's single-use invite first, then the Graphyard invite, one message.
    const pending = (await b.call('/api/invites', { name: 'ana', role: 'viewer' })).body;
    assert.match(pending.pending, /^[0-9a-f-]{36}$/);
    assert.equal(pending.message, undefined);
    assert.equal((await b.call(`/api/team-access/device-invites/${pending.pending}`)).body.state, 'pending');
    await sync(b);
    assert.deepEqual(requests.map(request => [request.url, request.auth, JSON.parse(request.body)]), [['POST /api/v2/device/nFAKE123CNTRL/device-invites', `Bearer ${token}`, [{ multiUse: false, allowExitNode: false }]]]);
    assert.equal((await b.call(`/api/team-access/device-invites/${pending.pending}`)).body.state, 'ready');
    const apiInvite = await b.call('/api/invites', { name: 'ana', role: 'viewer', deviceInvite: pending.pending });
    assert.equal(apiInvite.status, 200);
    assert.deepEqual(apiInvite.body.share, { url: 'https://login.tailscale.com/admin/invite/single-use-test', kind: 'single-use' });
    assert.ok(apiInvite.body.message.includes('accept this machine share: https://login.tailscale.com/admin/invite/single-use-test (single-use Tailscale invite, made for you)'));
    assert.ok(apiInvite.body.message.includes(`http://yard.tail-test.ts.net:${b.port}/#sign-in=${apiInvite.body.code}`));
    assert.equal((await b.call('/api/invites', { name: 'ana', role: 'viewer', deviceInvite: pending.pending })).status, 409, 'one Tailscale invite serves one Graphyard invite');

    providerStatus = 403;
    const second = (await a.call('/api/invites', { name: 'zoe', role: 'viewer' })).body;
    await sync(a);
    const failed = (await a.call(`/api/team-access/device-invites/${second.pending}`)).body;
    assert.equal(failed.state, 'failed');
    assert.match(failed.error, /Tailscale refused the device invite \(403: not authorized\); no invite was made/);
    assert.equal((await a.store.pool.query("SELECT 1 FROM team_members WHERE name='zoe'")).rowCount, 0, 'a refused Tailscale invite leaves no Graphyard invite');
    assert.equal((await a.call('/api/invites', { name: 'zoe', role: 'viewer', deviceInvite: second.pending })).status, 409, 'nor can one be made from it');
    const fallback = (await a.call('/api/invites', { name: 'zoe', role: 'viewer', share: 'reusable' })).body;
    assert.ok(fallback.message.includes(fresh), 'the owner may choose the reusable link instead');
    const stale = (await a.call('/api/invites', { name: 'ivy', role: 'viewer' })).body;
    now += 3 * minute;
    assert.match((await a.call(`/api/team-access/device-invites/${stale.pending}`)).body.error, /master loop did not make the Tailscale invite in time/);

    const events = (await a.store.pool.query("SELECT payload FROM events WHERE kind LIKE 'team-access.%'")).rows;
    const visible = JSON.stringify([savedToken.body, apiInvite.body, failed, (await a.call('/api/team-access')).body, logged, events, (await b.store.pool.query("SELECT payload FROM events")).rows, await readFile(join(machineDir, 'tailnet.json'), 'utf8')]);
    assert.ok(!visible.includes(token) && !visible.includes('FAKE-not-a-real'), 'the token appears in no response, record or log');
    const reports = (await a.store.pool.query("SELECT 1 FROM events WHERE kind='team-access.host'")).rowCount!;
    await sync(a); await sync(a);
    assert.equal((await a.store.pool.query("SELECT 1 FROM events WHERE kind='team-access.host'")).rowCount, reports, 'an unchanged machine adds nothing to the ledger');
    assert.equal((await a.call('/api/team-access/tailscale-token', { remove: true })).body.mode, 'reusable', 'removing the token returns to the share link');
    await sync(a);
    await assert.rejects(stat(join(machineDir, 'tailscale-api.token')));
  } finally {
    Object.assign(console, original);
    await a.close(); await b.close();
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
});

// GY-3411: the browser spec retried sync-and-reload because one pass of the loops shows a change
// only to the installs whose loop ran after the saving one's; settled loops need one read.
test('unit:test-browser-tests-one-click-team-access-spec-ts-pinned — settling the host loops once shows a saved share link on every install, whichever install saved it', async () => {
  const host = await temporaryDirectory('team-access-settle'), machineDir = join(host, 'machine');
  await mkdir(machineDir);
  await writeFile(join(machineDir, 'tailnet.json'), JSON.stringify({ dnsName: 'yard.tail-test.ts.net.', ip: '100.64.0.7', deviceId: 'nFAKE123CNTRL' }));
  const a = await install('team_access_settle_a', host, Date.now), b = await install('team_access_settle_b', host, Date.now);
  const settle = () => settleHostLoops([a, b].map(entry => ({ url: entry.base, credentialFile: entry.credentialFile })), { machineDir });
  const shown = async (entry: typeof a) => (await entry.call('/api/team-access')).body.shareLink?.url ?? null;
  try {
    // The spec waits on settled loops with one reload: a retried reload restarts the page's read each attempt.
    const spec = await readFile(new URL('../browser-tests/one-click-team-access.spec.ts', import.meta.url), 'utf8');
    assert.match(spec, /settleHostLoops\(installs, /);
    assert.doesNotMatch(spec, /toPass\(/, 'no retry loop reloads the page');
    // The last loop in turn saves: the first has already run when the machine learns of it.
    for (const [saver, link] of [[b, 'https://login.tailscale.com/admin/invite/saved-on-b'], [a, 'https://login.tailscale.com/admin/invite/saved-on-a']] as const) {
      assert.equal((await saver.call('/api/team-access/share-link', { url: link })).status, 200);
      await settle();
      assert.deepEqual([await shown(a), await shown(b)], [link, link], 'both installs show the link after one settle');
    }
  } finally { await a.close(); await b.close(); }
});

test('unit:tests/one-click-team-access.test.ts — the machine directory holding the Tailscale token is masked from confined sessions and the Chief', async () => {
  const home = await temporaryDirectory('team-access-mask'), machine = join(home, 'machine'), own = join(home, 'own-install');
  await mkdir(machine); await mkdir(own);
  await writeFile(join(machine, 'tailscale-api.token'), 'tskey-api-FAKE\n', { mode: 0o600 });
  assert.equal(credentialMaskFor({}, { credentialFile: join(own, 'token') }, home).configHome, home, 'workers, reviewers and producers lose the whole config home, the machine directory with it');
  const chief = masterCredentialMask({ credentialFile: join(own, 'token') }, [], home);
  assert.ok(chief.hostPaths!.includes(machine), 'the master session reads its own install directory, never the machine token');
  assert.ok(!chief.hostPaths!.includes(own));
});

test('unit:tests/one-click-team-access.test.ts — README, the infra and setup guides, and the summary say the same thing', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /one machine, many installs, one port each; two locks: tailnet plus per-install sign-in/);
  for (const phrase of ['one machine, many installs, one port each', 'tailscale serve --bg --http=PORT', "Two locks: the machine's Tailscale share lets a person's devices reach this machine, as far as your tailnet policy allows, and each install still needs its own Graphyard sign-in",
    'Reusable machine-share link (default)', 'Automatic single-use device invite (optional)', 'expires an unused share link 30 days after it was made', 'with the day it was made', 'expires in 24 hours', '~/.config/graphyard/machine/tailscale-api.token', 'names the missing step', 'tailnet policy grant with a teammate placeholder', 'review broader grants'])
    assert.ok(guides.infra.includes(phrase), `guide infra says: ${phrase}`);
  assert.match(guides.setup, /one machine, many installs, one port each; two locks: tailnet plus per-install sign-in/);
  assert.match(teamAccessSummary, /One machine, many installs, one port each\. Two locks: the Tailscale share lets a person's devices reach this machine \(as far as your tailnet policy allows\), and each install still needs its own Graphyard sign-in/);
  assert.match(aclGuidance, /TEAMMATE@example\.com.*does not revoke them/);
  // The dashboard Guide's FAQ answers the same flow: tailnet serving by default, one port each, two locks, 24-hour invites.
  const guidePage = await readFile(new URL('../web/pages/guide.tsx', import.meta.url), 'utf8');
  const faq = guidePage.slice(guidePage.indexOf("['faq-access'"), guidePage.indexOf("['faq-decisions'"));
  for (const phrase of ['http://HOST:PORT', 'one machine, many installs, one port each', 'two locks', 'within 24 hours', 'Invite someone']) assert.ok(faq.includes(phrase), `the Guide FAQ says: ${phrase}`);
  assert.doesNotMatch(faq, /share-tailnet|ten minutes|HTTPS/, 'the Guide FAQ names no retired flag, ten-minute link or HTTPS address');
  assert.doesNotMatch(guides.infra + readme + teamAccessSummary, /opens port \d+ only|port PORT only/, 'nothing claims the share reaches one port alone');
});
