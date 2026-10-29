import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2978: while an install deploys a new release, its CLI checkout and the server differ for the
// length of the deploy. A lease command — heartbeat, claim, complete, blocked, defer — proceeds
// through that window with a one-line warning, because the server's own request validation checks
// the wire protocol; a non-lease command keeps refusing by name before its first request.

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const checkout = fileURLToPath(new URL('..', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, '0');
const listen = (server: Server) => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));
const origin = (server: Server) => `http://127.0.0.1:${(server.address() as any).port}`;

test('unit:lease-commands-survive-cli-server-skew — heartbeat and blocked from a CLI at another commit than the server succeed with the version-difference warning, a non-lease command still refuses before its first request', async () => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim();
  const deployed = sha40('deployed');
  const cwd = await temporaryDirectory('lease-skew-cwd');
  const requests: string[] = [];
  const bodies: unknown[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/healthz') return response.end(JSON.stringify({ ok: true, version: '0.0.0-dev', commit: deployed }));
    let text = '';
    request.on('data', chunk => text += chunk);
    request.on('end', () => {
      if (text) bodies.push(JSON.parse(text));
      if (request.url === '/api/work/GY-1') return response.end(JSON.stringify({ id: 'work-1', key: 'GY-1', epoch: 1 }));
      return response.end(JSON.stringify({ ok: true }));
    });
  });
  await listen(server);
  const env = { ...process.env, GRAPHYARD_TOKEN: 'test-only', GRAPHYARD_URL: origin(server) } as Record<string, string | undefined>;
  delete env.GRAPHYARD_VERSION; // an unreleased build: the commit it runs is what the server's answer differs from
  const run = (args: string[]) => exec(process.execPath, [launcher, ...args], { cwd, env });
  try {
    // heartbeat proceeds and extends the lease.
    const heartbeat = await run(['heartbeat', 'GY-1', '1']);
    assert.deepEqual(JSON.parse(heartbeat.stdout), { ok: true }, 'the heartbeat succeeded');
    assert.match(heartbeat.stderr, new RegExp(`CLI commit ${head} and server commit ${deployed} differ: run graphyard upgrade; the heartbeat proceeds`), 'the warning names the difference and the command carries on');
    assert.equal(heartbeat.stderr.split('\n').filter(line => line.includes('differ')).length, 1, 'the warning is one line');
    assert.deepEqual(requests, ['GET /healthz', 'GET /api/work/GY-1', 'POST /api/work/work-1/heartbeat'], 'the request went out');

    // blocked proceeds and records the blocker.
    requests.length = 0;
    const blocked = await run(['blocked', 'GY-1', '1', 'waiting on the deploy to finish']);
    assert.deepEqual(JSON.parse(blocked.stdout), { ok: true }, 'the blocker was recorded');
    assert.match(blocked.stderr, new RegExp(`CLI commit ${head} and server commit ${deployed} differ: run graphyard upgrade; the blocked proceeds`));
    assert.deepEqual(requests, ['GET /healthz', 'GET /api/work/GY-1', 'POST /api/work/work-1/blocked']);
    assert.deepEqual(bodies.at(-1), { epoch: 1, reason: 'waiting on the deploy to finish' });

    // A non-lease command keeps today's behaviour: refused by name, before its first API request.
    requests.length = 0;
    const status = await run(['status', 'GY-1']).then(() => null, (error: any) => error);
    assert.match(status?.stderr ?? '', new RegExp(`CLI commit ${head} and server commit ${deployed} differ: run graphyard upgrade$`, 'm'), 'the refusal names no proceeding');
    assert.doesNotMatch(status?.stderr ?? '', /proceeds/);
    assert.deepEqual(requests, ['GET /healthz'], 'the skewed invocation is refused before its first API request');
  } finally { await close(server); }
});
