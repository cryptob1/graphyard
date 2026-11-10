import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createContext } from '../src/cli/context.js';
import { loginCommand } from '../src/cli/session-commands.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3216: `graphyard login` prints the tailnet address `tailscale serve` maps to the install's loopback URL.

async function login(upJson: object | undefined, stub: ((port: number) => string) | null) {
  const root = await temporaryDirectory('login-tailnet-repo');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/acme/widget.git']);
  if (upJson) { await mkdir(join(root, '.graphyard')); await writeFile(join(root, '.graphyard/up.json'), JSON.stringify(upJson)); }
  const home = await temporaryDirectory('login-tailnet-config'), install = join(home, 'acme-widget');
  await mkdir(join(install, 'tokens'), { recursive: true });
  await writeFile(join(install, 'tokens/acme-widget-operator.token'), 'operator-admin-credential-0123456789abcdef\n', { mode: 0o600 });
  const bin = await temporaryDirectory('login-tailnet-bin');
  const server = createServer((request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ code: 'one-time-code-0123456789', principal: 'acme-widget-operator', expiresAt: '2026-10-19T00:10:00Z' })); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  if (stub) { await writeFile(join(bin, 'tailscale'), `#!/bin/sh\n${stub(port)}\n`); await chmod(join(bin, 'tailscale'), 0o755); }
  const names = ['GRAPHYARD_URL', 'GRAPHYARD_CONFIG_HOME', 'GRAPHYARD_REPOSITORY_ROOT', 'GRAPHYARD_TOKEN', 'GRAPHYARD_TOKEN_FILE', 'PATH'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, { GRAPHYARD_URL: `http://localhost:${port}/`, GRAPHYARD_CONFIG_HOME: home, GRAPHYARD_REPOSITORY_ROOT: root, PATH: `${bin}:/usr/bin:/bin` });
    const printed: any[] = [];
    const context = await createContext('login', undefined, [], false);
    await loginCommand.run({ ...context, print: value => printed.push(value) }, undefined);
    return printed[0].signIn as string;
  } finally {
    for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    server.close();
  }
}
const serving = (port: number) => `echo '${JSON.stringify({ Web: { 'vishrog.tail3739e3.ts.net:8443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } } })}'`;
const code = '/#sign-in=one-time-code-0123456789';
// What `tailscale serve --bg --http=<port>` (the serve `up` sets up) and an https serve report: Web is alike, TCP tells them apart.
const servingOver = (kind: 'HTTP' | 'HTTPS') => (port: number) => `echo '${JSON.stringify({ TCP: { 4310: { [kind]: true } }, Web: { 'vishrog.tail3739e3.ts.net:4310': { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } } })}'`;

test('unit:login-tailnet-url login prints the served tailnet address, a recorded one wins, and no mapping falls back to loopback', async () => {
  assert.equal(await login(undefined, serving), `https://vishrog.tail3739e3.ts.net:8443${code}`);
  assert.equal(await login(undefined, servingOver('HTTP')), `http://vishrog.tail3739e3.ts.net:4310${code}`);
  assert.equal(await login(undefined, servingOver('HTTPS')), `https://vishrog.tail3739e3.ts.net:4310${code}`);
  assert.equal(await login({ version: 1, repository: 'acme/widget', provider: 'local', completed: [], noHerdr: true, goal: null, tailnetUrl: 'http://host.tailnet.ts.net:4310' }, serving), `http://host.tailnet.ts.net:4310${code}`);
  assert.match(await login(undefined, port => serving(port + 1)), /^http:\/\/localhost:\d+\/#sign-in=/);
  assert.match(await login(undefined, () => 'exit 1'), /^http:\/\/localhost:\d+\/#sign-in=/);
  assert.match(await login(undefined, () => 'echo nope'), /^http:\/\/localhost:\d+\/#sign-in=/);
  assert.match(await login(undefined, null), /^http:\/\/localhost:\d+\/#sign-in=/);
});
