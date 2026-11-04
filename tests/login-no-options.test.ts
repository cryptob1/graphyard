import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createContext } from '../src/cli/context.js';
import { loginCommand, openCommand } from '../src/cli/session-commands.js';
import { HumanSignIn, signInSessionTtlMs } from '../src/server/auth.js';
import { signInDatabase } from './helpers/sign-in-database.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2171: `graphyard login` with no options and no GRAPHYARD_TOKEN_FILE finds the operator credential
// the install recorded under the config home, and the human session its link opens lasts until 90 days unused.

// Mints a link with no credential named, against a stub server, and returns the credential it sent and what it printed.
async function loginWithNoOptions(root: string, configHome: string, command = loginCommand, env: Record<string, string> = {}) {
  const seen: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    if (request.url === '/api/sign-in-links') seen.push(request.headers.authorization);
    response.setHeader('Content-Type', 'application/json');
    response.end(request.url === '/api/sign-in-links' ? JSON.stringify({ code: 'one-time-code-0123456789', principal: 'acme-widget-operator', expiresAt: '2026-10-19T00:10:00Z' }) : '{}');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const names = ['GRAPHYARD_URL', 'GRAPHYARD_CONFIG_HOME', 'GRAPHYARD_REPOSITORY_ROOT', 'GRAPHYARD_TOKEN', 'GRAPHYARD_TOKEN_FILE', 'PATH'] as const;
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) if (name !== 'PATH') delete process.env[name];
    Object.assign(process.env, env, { GRAPHYARD_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, GRAPHYARD_CONFIG_HOME: configHome, GRAPHYARD_REPOSITORY_ROOT: root });
    const printed: any[] = [];
    const context = await createContext('login', undefined, [], false);
    await command.run({ ...context, print: value => printed.push(value) }, undefined);
    return { seen, printed: printed[0], base: process.env.GRAPHYARD_URL! };
  } finally {
    for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    server.close();
  }
}

async function checkout(upJson?: object) {
  const root = await temporaryDirectory('login-repo');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/acme/widget.git']);
  if (upJson) { await mkdir(join(root, '.graphyard')); await writeFile(join(root, '.graphyard/up.json'), JSON.stringify(upJson)); }
  return root;
}

test('unit:login-no-options graphyard login with no options signs in with the install\'s recorded operator credential and links to the tailnet address', async () => {
  const root = await checkout({ version: 1, repository: 'acme/widget', provider: 'local', completed: [], noHerdr: true, goal: null, tailnetUrl: 'http://host.tailnet.ts.net:4310' });
  const home = await temporaryDirectory('login-config');
  const install = join(home, 'acme-widget'), token = 'operator-admin-credential-0123456789abcdef';
  await mkdir(join(install, 'tokens'), { recursive: true });
  await writeFile(join(install, 'tokens/acme-widget-admin.token'), `${token}\n`, { mode: 0o600 });
  await writeFile(join(install, 'install.json'), JSON.stringify({ version: 1, installId: 'acme-widget', repository: 'acme/widget', provider: 'local', baseBranch: 'main', createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z',
    principals: [{ id: 'acme-widget-worker-1', role: 'worker', fingerprint: '000000000000' }, { id: 'acme-widget-admin', role: 'admin', sessionKind: 'human', fingerprint: '111111111111' }] }));

  const { seen, printed } = await loginWithNoOptions(root, home);
  assert.deepEqual(seen, [`Bearer ${token}`], 'the link is minted with the recorded operator credential');
  assert.equal(printed.signIn, 'http://host.tailnet.ts.net:4310/#sign-in=one-time-code-0123456789');
});

// A self-contained host (src/install/host.ts) writes the tokens to /home/graphyard/.config/graphyard/<install>/tokens/
// and no install.json, and its environment sets GRAPHYARD_CONFIG_HOME to <install> itself.
for (const [layout, configHomeOf] of [['GRAPHYARD_CONFIG_HOME at <install>', (home: string) => join(home, 'acme-widget')], ['the default config home', (home: string) => home]] as const) {
  test(`unit:login-no-options on a self-contained host (${layout}) graphyard login finds the operator credential the host install wrote`, async () => {
    const root = await checkout(), home = await temporaryDirectory('login-host-config');
    const token = 'host-operator-credential-0123456789abcdef';
    await mkdir(join(home, 'acme-widget/tokens'), { recursive: true });
    await writeFile(join(home, 'acme-widget/tokens/acme-widget-master.token'), 'coordinator-credential-0123456789abcdef\n', { mode: 0o600 });
    await writeFile(join(home, 'acme-widget/tokens/acme-widget-operator.token'), `${token}\n`, { mode: 0o600 });

    const { seen, printed, base } = await loginWithNoOptions(root, configHomeOf(home));
    assert.deepEqual(seen, [`Bearer ${token}`], 'the link is minted with the host operator credential');
    assert.equal(printed.signIn, `${base}/#sign-in=one-time-code-0123456789`);
  });
}

test('unit:signin-session-renews-on-use — a session used within 90 days stays valid, and one left unused for 90 days is refused', async () => {
  let now = Date.parse('2026-10-19T00:00:00Z');
  const database = await signInDatabase(3077);
  try {
    const table = new HumanSignIn(database.store, () => now);
    const { code } = table.issue({ id: 'operator', role: 'admin', sessionKind: 'human' }, true);
    const session = await table.redeem(code);
    assert.equal(signInSessionTtlMs, 90 * 86_400_000);
    assert.equal(session.expiresAt, '2027-01-17T00:00:00.000Z');
    const expiry = async () => (await database.store.pool.query('SELECT expires_at FROM human_sign_in_sessions')).rows[0].expires_at.toISOString();
    // Used every 80 days, the session outlives its first 90.
    for (let use = 0; use < 3; use++) { now += 80 * 86_400_000; assert.equal((await table.authenticate(session.token))?.id, 'operator'); }
    assert.equal(await expiry(), new Date(now + signInSessionTtlMs).toISOString());
    // A use within the hour does not write again.
    now += 30 * 60_000;
    assert.equal((await table.authenticate(session.token))?.id, 'operator');
    assert.equal(await expiry(), new Date(now - 30 * 60_000 + signInSessionTtlMs).toISOString());
    now += signInSessionTtlMs;
    assert.equal(await table.authenticate(session.token), null);
  } finally { await database.close(); }
});

test('unit:open-command — graphyard open opens the one-time link in the default browser, and prints it when no opener runs', async () => {
  const root = await checkout(), home = await temporaryDirectory('open-config'), bin = await temporaryDirectory('open-bin'), seen = join(bin, 'opened');
  for (const opener of ['xdg-open', 'open']) { await writeFile(join(bin, opener), `#!/bin/sh\nprintf '%s' "$1" > '${seen}'\n`); await chmod(join(bin, opener), 0o755); }
  const env = { GRAPHYARD_TOKEN: 'operator-admin-credential-0123456789abcdef' };
  const opened = await loginWithNoOptions(root, home, openCommand, { ...env, PATH: bin });
  assert.deepEqual(opened.printed, { opened: true, principal: 'acme-widget-operator' });
  let url = '';
  for (let wait = 0; !url && wait < 100; wait++) url = await readFile(seen, 'utf8').catch(() => new Promise<string>(done => setTimeout(() => done(''), 50)));
  assert.equal(url, `${opened.base}/#sign-in=one-time-code-0123456789`);
  const printed = await loginWithNoOptions(root, home, openCommand, { ...env, PATH: await temporaryDirectory('open-empty-bin') });
  assert.equal(printed.printed.opened, false);
  assert.equal(printed.printed.signIn, `${printed.base}/#sign-in=one-time-code-0123456789`);
});
