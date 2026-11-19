import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterCredentialMask, sessionMountNamespaceWorks } from '../src/master/confinement.js';
import { masterSessionConfinement } from '../src/master/launch.js';
import { inviteRefused, teammateSessionTtlMs } from '../src/server/auth.js';
import { funnelCommand } from '../src/team-access.js';
import { servedInstall, servedNode } from './helpers/served-install.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3514: Invite gives one link on the install's Funnel address; it opens once, on any device, within
// the days the owner picked; a teammate's session is short and renews with use; revoking ends it at
// once, closing their Master page; every line typed into the master is listed with who and when; and
// the master session the typing reaches cannot write the checkout or read the operator's token.

const funnelUrl = `https://${servedNode.DNSName.replace(/\.$/, '')}`;
const minute = 60_000, day = 24 * 60 * minute;

/** An install whose loop has turned Funnel on for it, with a clock the test moves. */
async function funnelInstall(label: string) {
  let now = Date.now();
  const install = await servedInstall(label, { funnel: true, clock: () => now });
  await install.sync();
  const as = async (token: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const response = await fetch(install.base + path, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  /** A request as tailscaled's Funnel proxy delivers one from the public internet: the public Host, forwarded, no Tailscale identity. */
  const publicly = { Host: new URL(funnelUrl).host, 'X-Forwarded-For': '203.0.113.9', 'X-Forwarded-Proto': 'https' };
  const open = (link: string) => as('', '/api/sign-in', { body: { code: new URL(link).hash.replace('#sign-in=', '') }, headers: publicly });
  return { ...install, as, open, publicly, advance: (ms: number) => { now += ms; } };
}

/** A WebSocket client of the server's terminal routes, with the token as its second subprotocol. */
function socket(base: string, path: string, token: string) {
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}${path}`, ['graphyard', token]);
  const messages: any[] = [];
  ws.addEventListener('message', event => { if (typeof event.data === 'string') messages.push(JSON.parse(event.data)); });
  const opened = new Promise<void>((resolve, reject) => { ws.addEventListener('open', () => resolve()); ws.addEventListener('error', () => reject(new Error(`${path} refused`))); });
  const closed = new Promise<void>(resolve => ws.addEventListener('close', () => resolve()));
  return { ws, messages, opened, closed };
}
const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(check(), what);
};

test('integration:one-link-invite — one-use links valid for the owner\'s days, short renewing sessions, revoke ends typing and reading at once, and typed lines listed with who and when', async () => {
  const install = await funnelInstall('one_link_invite');
  try {
    // AC-2: the link opens once; a second open gets one plain line with one next action.
    const invite = await install.as(install.operator, '/api/invites', { body: { name: 'mo', role: 'maintainer', days: 30 } });
    assert.equal(invite.status, 200, JSON.stringify(invite.body));
    assert.ok(invite.body.link.startsWith(`${funnelUrl}/#sign-in=`), invite.body.link);
    assert.equal(invite.body.note, null, 'Funnel serves it: no warning');
    // The owner picks how long it stays valid: 20 days later a 30-day link still opens.
    install.advance(20 * day);
    const mo = await install.open(invite.body.link);
    assert.equal(mo.status, 200, JSON.stringify(mo.body));
    assert.equal(mo.body.actor.id, 'mo');
    const again = await install.open(invite.body.link);
    assert.equal(again.status, 401);
    assert.equal(again.body.error, inviteRefused);
    assert.match(inviteRefused, /^[^\n]+\. Ask the owner for a new one\.$/, 'one line, one next action');
    // A 1-day link has expired after two days; there is no other fixed Graphyard expiry.
    assert.equal((await install.as(install.operator, '/api/invites', { body: { name: 'vera', role: 'viewer', days: 3 } })).status, 400, 'only the offered choices');
    const short = await install.as(install.operator, '/api/invites', { body: { name: 'vera', role: 'viewer', days: 1 } });
    install.advance(2 * day);
    assert.equal((await install.open(short.body.link)).status, 401);
    const vera = await install.open((await install.as(install.operator, '/api/invites', { body: { name: 'vera', role: 'viewer', days: 1 } })).body.link);
    assert.equal(vera.status, 200);

    // AC-2: a maintainer's session is short-lived and renews while they are active.
    install.advance(teammateSessionTtlMs - minute);
    assert.equal((await install.as(mo.body.token, '/api/work-snapshot')).status, 401, 'opened 2 days ago and idle since: ended');
    const fresh = await install.open((await install.as(install.operator, '/api/invites', { body: { name: 'mo', role: 'maintainer', days: 7 } })).body.link);
    for (let i = 0; i < 3; i++) {
      install.advance(teammateSessionTtlMs - minute);
      assert.equal((await install.as(fresh.body.token, '/api/work-snapshot')).status, 200, 'each use renews it');
    }
    install.advance(teammateSessionTtlMs + minute);
    assert.equal((await install.as(fresh.body.token, '/api/work-snapshot')).status, 401, 'unused past its lifetime: ended');
    const maintainer = (await install.open((await install.as(install.operator, '/api/invites', { body: { name: 'mo', role: 'maintainer', days: 7 } })).body.link)).body.token as string;
    const viewer = (await install.open((await install.as(install.operator, '/api/invites', { body: { name: 'vera', role: 'viewer', days: 7 } })).body.link)).body.token as string;

    // AC-3: the master pane through the host bridge; the maintainer types, the viewer only watches.
    const host = socket(install.base, '/api/terminal-host', install.loop);
    await host.opened;
    const streams = new Map<string, string>();
    host.ws.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'open') {
        streams.set(message.id, message.control ? 'control' : 'view');
        host.ws.send(JSON.stringify({ id: message.id, line: JSON.stringify({ type: 'session', session: { pane: 'master-pane' } }) }));
      }
    });
    const typing = socket(install.base, '/api/terminal?cols=80&rows=24', maintainer), watching = socket(install.base, '/api/terminal?cols=80&rows=24', viewer);
    await Promise.all([typing.opened, watching.opened]);
    await until(() => streams.size === 2 && typing.messages.some(m => m.type === 'session') && watching.messages.some(m => m.type === 'session'), 'both pages see the master pane');
    assert.deepEqual([...streams.values()].sort(), ['control', 'view']);
    typing.ws.send(JSON.stringify({ type: 'input', data: 'list what is blocked\r' }));
    watching.ws.send(JSON.stringify({ type: 'input', data: 'a viewer types\r' }));
    const typed = async () => (await install.as(install.operator, '/api/typed-input')).body.typed as { who: string; at: string; text: string }[];
    let list: Awaited<ReturnType<typeof typed>> = [];
    await until(() => { void typed().then(value => { list = value; }); return list.length > 0; }, 'the typed line is recorded');

    // AC-4: one plain list of who typed what, and when; a viewer's keys reach nothing.
    assert.deepEqual(list.map(entry => [entry.who, entry.text]), [['mo', 'list what is blocked']]);
    assert.ok(Math.abs(Date.parse(list[0]!.at) - Date.now()) < 60 * minute, 'when it was typed');
    assert.equal((await install.as(viewer, '/api/typed-input')).status, 200, 'everyone signed in reads the list');
    const master = await readFile(new URL('../web/pages/master.tsx', import.meta.url), 'utf8');
    assert.match(master, /api\('typed-input'\)/);
    assert.match(master, /<h2>Typed into the master<\/h2>/);

    // AC-3: revoking the maintainer closes their Master page at once; they can neither read nor type.
    const revoked = await install.as(install.operator, '/api/invites/mo/revoke', { body: {} });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    await Promise.race([typing.closed, new Promise((_, reject) => setTimeout(() => reject(new Error('the revoked page stayed open')), 5_000))]);
    assert.equal((await install.as(maintainer, '/api/work-snapshot')).status, 401);
    await assert.rejects(socket(install.base, '/api/terminal?cols=80&rows=24', maintainer).opened, 'a revoked person cannot reopen the master pane');
    assert.equal(watching.ws.readyState, WebSocket.OPEN, 'the viewer still watches');
    assert.equal((await install.as(viewer, '/api/work-snapshot')).status, 200);
    watching.ws.close(); host.ws.close();
  } finally { await install.close(); }
});

test('e2e:one-link-invite — Invite gives exactly one link on the install\'s Funnel address that signs a person in from a device with no Tailscale; Funnel exposes that port alone; the master session cannot write outside .graphyard or read the operator\'s token', async () => {
  const install = await funnelInstall('one_link_invite_e2e');
  try {
    // AC-1: the loop turned Funnel on for this install's own loopback port, and for nothing else.
    const calls = readFileSync(join(install.host, 'calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
    assert.deepEqual(calls.filter(args => args[0] === 'funnel'), [['funnel', '--bg', '--https=443', install.base]]);
    assert.deepEqual(funnelCommand('4310', { TCP: { 443: { HTTPS: true } } }), ['tailscale', 'funnel', '--bg', '--https=8443', 'http://127.0.0.1:4310'], 'the next free public port, to this port alone');
    assert.equal(funnelCommand('4310', { TCP: { 443: {}, 8443: {}, 10000: {} } }), null, 'never another service\'s port');
    const access = await install.as(install.operator, '/api/team-access');
    assert.equal(access.body.installUrl, funnelUrl);
    assert.equal(access.body.public, true);

    // AC-1: Invite returns exactly one link.
    const invite = await install.as(install.operator, '/api/invites', { body: { name: 'ana@example.com', role: 'maintainer', days: 7 } });
    const links = Object.values(invite.body).filter(value => typeof value === 'string' && /https?:\/\//.test(value));
    assert.deepEqual(links, [invite.body.link]);
    // From the public internet, with no Tailscale login, nothing reads without the link…
    assert.equal((await install.as('', '/api/work-snapshot', { headers: install.publicly })).status, 401);
    // …and opening it signs the person in.
    const opened = await install.open(invite.body.link);
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const status = await install.as(opened.body.token, '/api/status', { headers: install.publicly });
    assert.equal(status.status, 200);
    assert.equal(status.body.actor.id, 'ana@example.com');
  } finally { await install.close(); }

  // AC-5: what a typed command can do in the master session: its confinement as the loop launches it.
  const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
  mkdirSync(join(checkout, '.graphyard'), { recursive: true });
  const home = await temporaryDirectory('one-link-master-home', join(checkout, '.graphyard'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const root = join(home, 'code', 'project'), configHome = join(home, '.config', 'graphyard'), installDir = join(configHome, 'project-install');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'README.md'), 'tracked\n');
    for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-qm', 'seed']]) execFileSync('git', ['-C', root, ...args]);
    const secret = 'operator-admin-credential-'.padEnd(48, 'x');
    const operatorToken = join(installDir, 'tokens', 'operator.token'), masterToken = join(configHome, 'masters', 'master.token'), deployKey = join(installDir, 'merge-writer.key');
    for (const [file, value] of [[operatorToken, secret], [masterToken, 'master-own-token-'.padEnd(40, 'x')], [deployKey, 'deploy-key']]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${value}\n`, { mode: 0o600 });
    }
    const config = { credentialFile: masterToken, run: { mergeWriter: { deployKeyFile: deployKey } } };
    const mask = masterCredentialMask(config, [], configHome);
    assert.ok(mask.hostPaths!.includes(operatorToken), 'the operator\'s token is masked even in the install directory the master keeps');
    assert.ok(!mask.hostPaths!.includes(deployKey) && !mask.hostPaths!.includes(masterToken), 'what the master already holds stays its own');
    assert.ok(await sessionMountNamespaceWorks(), 'bubblewrap mount namespaces work on this host');
    const master = await masterSessionConfinement('claude', root, { bwrap: 'bwrap', platform: 'linux', mountNamespaceWorks: true }, [dirname(masterToken)], undefined, mask);
    const typed = [
      `cat ${operatorToken} 2>/dev/null && echo OPERATOR-READ`,
      `echo changed > ${join(root, 'README.md')} 2>/dev/null && echo CHECKOUT-WRITTEN`,
      `echo note > ${join(home, 'outside.txt')} 2>/dev/null && echo HOME-WRITTEN`,
      `echo note > ${join(root, '.graphyard', 'typed.txt')} && echo GRAPHYARD-WRITTEN`,
      `test -r ${masterToken} && echo OWN-TOKEN`,
    ].join('; ');
    const run = spawnSync(master.wrapper[0], [...master.wrapper.slice(1), '/bin/sh', '-c', typed], { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
    const output = run.stdout + run.stderr;
    assert.ok(!output.includes(secret) && !output.includes('OPERATOR-READ'), `the operator's token is unreachable: ${output}`);
    assert.ok(!output.includes('CHECKOUT-WRITTEN') && readFileSync(join(root, 'README.md'), 'utf8') === 'tracked\n', `the checkout is unwritable: ${output}`);
    assert.ok(!output.includes('HOME-WRITTEN') && !existsSync(join(home, 'outside.txt')), `the home is unwritable: ${output}`);
    assert.ok(output.includes('GRAPHYARD-WRITTEN') && output.includes('OWN-TOKEN'), `the master keeps .graphyard and its own token: ${output}`);
  } finally { if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome; }
});
