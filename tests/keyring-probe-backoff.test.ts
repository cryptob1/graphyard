import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyringEndpointWarning, keyringProbeBackoffMaxMs, keyringProbeBackoffMs, secretsBusMigration, type KeyringEndpointVerdict, type KeyringProbeBackoff } from '../src/master/launch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const listen = async (endpoint: string) => { const server = createServer(); await new Promise<void>(done => server.listen(endpoint, done)); return server; };
const close = (server: Server) => new Promise<void>(done => server.close(() => done()));

test('unit:keyring-probe-backoff — while the user manager stays unreachable, confined launches probe it once per doubling window, not once per launch (GY-1206)', async () => {
  const base = await temporaryDirectory('keyring-probe-backoff');
  const endpoint = join(base, 'graphyard-secrets-bus');
  let server = await listen(endpoint);
  try {
    let clock = 0, probes = 0;
    const backoff: KeyringProbeBackoff = { windows: new Map(), now: () => clock };
    const verdicts = new Map<string, KeyringEndpointVerdict>();
    const bound = () => ({ mechanism: 'read-only-mount' as const, wrapper: ['bwrap', '--ro-bind', realpathSync(endpoint), '/run/user/1/bus', '--'], detail: '' });
    const unreachable = () => { probes++; throw new Error('Failed to connect to bus'); };
    const unheld = () => { probes++; return 'ActiveState=inactive\n'; };
    const launch = (name: string, run: () => string | Promise<string>, started = Promise.resolve(true)) => keyringEndpointWarning(name, bound(), run, endpoint, verdicts, started, backoff);

    // The soak: a confined launch every 5 s for ten minutes against a user manager that never answers.
    const probedAt: number[] = [];
    for (clock = 0; clock < 600_000; clock += 5_000) {
      const before = probes;
      assert.equal(await launch(`gy-${clock}`, unreachable), null, 'an unjudged endpoint logs nothing');
      if (probes > before) probedAt.push(clock);
    }
    assert.deepEqual(probedAt, [0, 30_000, 90_000, 210_000, 450_000], 'each unjudged probe doubles the window before the next, from 30 s');
    assert.equal(keyringProbeBackoffMs, 30_000);
    assert.equal(backoff.windows.get(realpathSync(endpoint))?.delayMs, keyringProbeBackoffMaxMs, 'the window is capped');
    clock = 810_000;
    await launch('gy-capped', unreachable);
    assert.equal(probes, 6);
    assert.equal(backoff.windows.get(realpathSync(endpoint))?.delayMs, keyringProbeBackoffMaxMs, 'and stays at its cap');
    assert.equal(verdicts.size, 0, 'no unjudged verdict is kept');

    // Launches racing an unjudged probe share it and do not ask again inside the window it opens.
    clock = 1_200_000;
    const raced = await Promise.all([
      launch('gy-a', async () => { probes++; await new Promise(done => setTimeout(done, 20)); throw new Error('Failed to connect to bus'); }),
      launch('gy-b', unheld),
    ]);
    assert.deepEqual(raced, [null, null]);
    assert.equal(probes, 7, 'the racing launch waits out the window instead of probing again');

    // Once the user manager answers after the window, the unmigrated endpoint is reported and the window closes.
    clock += keyringProbeBackoffMaxMs;
    const reported = await launch('gy-c', unheld);
    assert.ok(reported && reported.startsWith('graphyard: gy-c: ') && reported.endsWith(`migrate: ${secretsBusMigration}`), 'the endpoint is reported once judged');
    assert.equal(backoff.windows.size, 0, 'a judged probe closes the window');
    assert.equal(await launch('gy-d', unheld), null, 'and its verdict is kept as before');
    assert.equal(probes, 8);

    // A socket replaced at the path is judged afresh, even inside a window opened for the earlier one.
    await close(server);
    server = await listen(endpoint);
    assert.equal(await launch('gy-e', unreachable), null);
    assert.equal(probes, 9);
    assert.equal(await launch('gy-f', unreachable), null, 'inside the window');
    assert.equal(probes, 9);
    await close(server);
    server = await listen(endpoint);
    const fresh = await launch('gy-g', unheld);
    assert.ok(fresh && fresh.startsWith('graphyard: gy-g: '), 'a new socket is probed despite the earlier socket\'s window');
    assert.equal(probes, 10);

    // A caller that passes no backoff keeps asking on every launch (GY-1039's own contract).
    await close(server);
    server = await listen(endpoint);
    const unbounded = new Map<string, KeyringEndpointVerdict>();
    for (const name of ['gy-h', 'gy-i']) assert.equal(await keyringEndpointWarning(name, bound(), unreachable, endpoint, unbounded), null);
    assert.equal(probes, 12);
  } finally {
    await close(server);
    rmSync(base, { recursive: true, force: true });
  }
});

test('unit:secrets-bus-filter-part-of-socket — stopping the endpoint socket stops the filtering proxy with it (GY-1206)', () => {
  const filter = readFileSync(join(root, 'deploy/systemd/graphyard-secrets-bus-filter.service'), 'utf8');
  const unit = filter.slice(filter.indexOf('[Unit]'), filter.indexOf('[Service]'));
  assert.match(unit, /^PartOf=graphyard-secrets-bus\.socket$/m, 'the filter unit is part of the socket unit');
});
