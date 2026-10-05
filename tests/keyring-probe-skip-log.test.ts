import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { keyringEndpointWarning, type KeyringEndpointVerdict, type KeyringProbeBackoff } from '../src/master/launch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const listen = async (endpoint: string) => { const server = createServer(); await new Promise<void>(done => server.listen(endpoint, done)); return server; };
const close = (server: Server) => new Promise<void>(done => server.close(() => done()));

test('unit:keyring-probe-skip-logged — a launch skipped inside a backoff window logs the skip once per window, keeping its null (GY-1226)', async () => {
  const base = await temporaryDirectory('keyring-probe-skip-log');
  const endpoint = join(base, 'graphyard-secrets-bus');
  const server = await listen(endpoint);
  try {
    let clock = 0;
    const backoff: KeyringProbeBackoff = { windows: new Map(), now: () => clock };
    const verdicts = new Map<string, KeyringEndpointVerdict>();
    const bound = { mechanism: 'read-only-mount' as const, wrapper: ['bwrap', '--ro-bind', realpathSync(endpoint), '/run/user/1/bus', '--'], detail: '' };
    const unreachable = () => { throw new Error('Failed to connect to bus'); };
    const lines: string[] = [];
    const launch = (name: string, started = Promise.resolve(true)) => keyringEndpointWarning(name, bound, unreachable, endpoint, verdicts, started, backoff, line => lines.push(line));

    assert.equal(await launch('gy-probe'), null);
    assert.equal(lines.length, 0, 'the unjudged probe itself logs nothing');

    clock = 5_000;
    assert.equal(await launch('gy-failed', Promise.resolve(false)), null);
    assert.equal(lines.length, 0, 'a failed launch logs nothing under its name');

    clock = 10_000;
    assert.equal(await launch('gy-skipped'), null, 'the skipped launch still returns null');
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith(`graphyard: gy-skipped: keyring endpoint ${realpathSync(endpoint)} not checked`), lines[0]);
    assert.match(lines[0], /skip the check for 20 s more \(window 30 s\)/);

    clock = 15_000;
    assert.equal(await launch('gy-quiet'), null);
    assert.equal(lines.length, 1, 'later skips in the same window do not repeat the line');

    clock = 30_000;
    assert.equal(await launch('gy-reprobe'), null, 'the window lapses and the launch probes again');
    clock = 31_000;
    assert.equal(await launch('gy-next-window'), null);
    assert.equal(lines.length, 2, 'the next window records its skip again');
    assert.match(lines[1], /^graphyard: gy-next-window: .*for 59 s more \(window 60 s\)/);

    // A caller that passes no `skipped` keeps the silent contract.
    assert.equal(await keyringEndpointWarning('gy-silent', bound, unreachable, endpoint, verdicts, Promise.resolve(true), backoff), null);
  } finally {
    await close(server);
    rmSync(base, { recursive: true, force: true });
  }
});
