import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createContext } from '../src/cli/context.js';
import { loginCommand } from '../src/cli/session-commands.js';
import { HumanSignIn, signInSessionTtlMs } from '../src/server/auth.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2171: `graphyard login` with no options and no GRAPHYARD_TOKEN_FILE finds the operator credential
// the install recorded under the config home, and the human session its link opens lasts 30 days.

test('unit:login-no-options graphyard login with no options signs in with the install\'s recorded operator credential and links to the tailnet address', async () => {
  const root = await temporaryDirectory('login-repo'), home = await temporaryDirectory('login-config');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/acme/widget.git']);
  await mkdir(join(root, '.graphyard'));
  await writeFile(join(root, '.graphyard/up.json'), JSON.stringify({ version: 1, repository: 'acme/widget', provider: 'local', completed: [], noHerdr: true, goal: null, tailnetUrl: 'http://host.tailnet.ts.net:4310' }));
  const install = join(home, 'acme-widget'), token = 'operator-admin-credential-0123456789abcdef';
  await mkdir(join(install, 'tokens'), { recursive: true });
  await writeFile(join(install, 'tokens/acme-widget-admin.token'), `${token}\n`, { mode: 0o600 });
  await writeFile(join(install, 'install.json'), JSON.stringify({ version: 1, installId: 'acme-widget', repository: 'acme/widget', provider: 'local', baseBranch: 'main', createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z',
    principals: [{ id: 'acme-widget-worker-1', role: 'worker', fingerprint: '000000000000' }, { id: 'acme-widget-admin', role: 'admin', sessionKind: 'human', fingerprint: '111111111111' }] }));

  const seen: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    if (request.url === '/api/sign-in-links') seen.push(request.headers.authorization);
    response.setHeader('Content-Type', 'application/json');
    response.end(request.url === '/api/sign-in-links' ? JSON.stringify({ code: 'one-time-code-0123456789', principal: 'acme-widget-admin', expiresAt: '2026-10-19T00:10:00Z' }) : '{}');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const names = ['GRAPHYARD_URL', 'GRAPHYARD_CONFIG_HOME', 'GRAPHYARD_REPOSITORY_ROOT', 'GRAPHYARD_TOKEN', 'GRAPHYARD_TOKEN_FILE'] as const;
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, { GRAPHYARD_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, GRAPHYARD_CONFIG_HOME: home, GRAPHYARD_REPOSITORY_ROOT: root });
    const printed: any[] = [];
    const context = await createContext('login', undefined, [], false);
    await loginCommand.run({ ...context, print: value => printed.push(value) }, undefined);
    assert.deepEqual(seen, [`Bearer ${token}`], 'the link is minted with the recorded operator credential');
    assert.equal(printed[0].signIn, 'http://host.tailnet.ts.net:4310/#sign-in=one-time-code-0123456789');
    assert.equal(printed[0].principal, 'acme-widget-admin');
  } finally {
    for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    server.close();
  }
});

test('unit:human-session-30-days a session opened from a sign-in link stays valid for 30 days', () => {
  let now = Date.parse('2026-10-19T00:00:00Z');
  const table = new HumanSignIn(() => now);
  const { code } = table.issue({ id: 'operator', role: 'admin', sessionKind: 'human' }, true);
  const session = table.redeem(code);
  assert.equal(signInSessionTtlMs, 30 * 86_400_000);
  assert.equal(session.expiresAt, '2026-11-18T00:00:00.000Z');
  now += 29 * 86_400_000;
  assert.equal(table.authenticate(session.token)?.id, 'operator');
  now += 86_400_000;
  assert.equal(table.authenticate(session.token), null);
});
