import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { createContext } from '../src/cli/context.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { server } from '../src/server.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const listen = (http: Server, port = 0) => new Promise<void>(resolve => http.listen(port, '127.0.0.1', resolve));
const close = (http: Server) => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); });
const portOf = (http: Server) => (http.address() as { port: number }).port;

test('integration:cli-waits-out-plane-restart — CLI survives refusal during restart and replays a committed mutation exactly once after reset', async () => {
  const cwd = await temporaryDirectory('cli-restart');

  let store: Store | undefined, plane: Server | undefined, proxy: Server | undefined;
  let restart: Promise<void> | undefined;
  try {
    store = await withDatabase('cli-waits-out-plane-restart'); await store.init();
    const token = 'restart-test-token-'.padEnd(40, 'x');
    plane = server(new Engine(store, 300, 'owner/restart'), [{ id: 'restart-operator', role: 'admin', sessionKind: 'human', token }]);
    await listen(plane);
    const upstream = `http://127.0.0.1:${portOf(plane)}`;
    const posts: { key: string | undefined; body: string }[] = [];
    let interruptRead = true;
    proxy = createServer(async (req, res) => {
      if (req.url === '/healthz') {
        res.end('{}');
        if (interruptRead) {
          interruptRead = false;
          const port = portOf(proxy!);
          // The probe succeeds just as deployment takes the listener down. The API sees ECONNREFUSED.
          restart = new Promise<void>(resolve => proxy!.close(() => {
            setTimeout(() => { void listen(proxy!, port).then(resolve); }, 250);
          }));
          proxy!.closeIdleConnections();
        }
        return;
      }
      let body = ''; for await (const chunk of req) body += chunk;
      if (req.method === 'POST') posts.push({ key: req.headers['idempotency-key'] as string | undefined, body });
      const response = await fetch(`${upstream}${req.url}`, { method: req.method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': String(req.headers['idempotency-key']) }, body: req.method === 'POST' ? body : undefined });
      const result = await response.text();
      // The real database has committed; lose its response before any HTTP headers reach the CLI.
      if (req.method === 'POST' && posts.length === 1) { req.socket.destroy(); return; }
      res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(result);
    });
    await listen(proxy);
    const env: NodeJS.ProcessEnv = { ...process.env, GRAPHYARD_URL: `http://127.0.0.1:${portOf(proxy)}`, GRAPHYARD_TOKEN: token };
    delete env.GRAPHYARD_TOKEN_FILE;
    const status = await exec(process.execPath, [launcher, 'status'], { cwd, env });
    assert.ok(JSON.parse(status.stdout));
    await restart;
    const input = join(cwd, 'work.json');
    await writeFile(input, JSON.stringify({ title: 'Created across restart', type: 'chore', criteria: [{ id: 'AC-1', text: 'Fixture', proofs: ['integration:fixture', 'e2e:fixture'] }] }));
    const created = JSON.parse((await exec(process.execPath, [launcher, 'create', input], { cwd, env })).stdout);
    assert.equal(posts.length, 2);
    assert.ok(posts[0].key);
    assert.deepEqual(posts[0], posts[1], 'the key and body survive a lost response');
    const work = await store.list();
    assert.equal(work.length, 1, 'the real idempotency receipt prevents a second creation');
    assert.equal(work[0].id, created.id);
  } finally {
    await restart;
    if (proxy) await close(proxy);
    if (plane) await close(plane);
    await store?.close();
  }
});

test('integration:cli-waits-out-plane-restart — HTTP errors and invalid requests are never retried; exhausted connection failures name the URL', async t => {
  const originalUrl = process.env.GRAPHYARD_URL, originalToken = process.env.GRAPHYARD_TOKEN, originalFile = process.env.GRAPHYARD_TOKEN_FILE;
  process.env.GRAPHYARD_URL = 'http://127.0.0.1:4310'; process.env.GRAPHYARD_TOKEN = 'test-only'; delete process.env.GRAPHYARD_TOKEN_FILE;
  try {
    for (const status of [400, 401, 403, 409, 429, 500, 503]) {
      let calls = 0;
      const mocked = t.mock.method(globalThis, 'fetch', async (url: string) => {
        if (url.endsWith('/healthz')) return new Response('{}');
        calls++; return new Response(JSON.stringify({ error: 'refused' }), { status });
      });
      const context = await createContext('status', undefined, [], false);
      await assert.rejects(context.api('status'), (error: any) => error.status === status);
      assert.equal(calls, 1);
      mocked.mock.restore();
    }
    let invalidCalls = 0;
    const invalid = t.mock.method(globalThis, 'fetch', async (url: string) => {
      if (url.endsWith('/healthz')) return new Response('{}');
      invalidCalls++; throw new TypeError('Failed to parse URL');
    });
    await assert.rejects((await createContext('status', undefined, [], false)).api('status'), /Failed to parse URL/);
    assert.equal(invalidCalls, 1);
    invalid.mock.restore();
    let now = 0, calls = 0;
    t.mock.method(Date, 'now', () => now);
    const late = t.mock.method(globalThis, 'fetch', async (url: string) => {
      if (url.endsWith('/healthz')) return new Response('{}');
      if (++calls === 1) { now = 58_000; throw new TypeError('fetch failed'); }
      return new Response('{"recovered":true}');
    });
    assert.deepEqual(await (await createContext('status', undefined, [], false)).api('status'), { recovered: true });
    assert.equal(calls, 2, 'a connection failure late in the 60-second window still retries');
    late.mock.restore();
    now = 0; calls = 0;
    t.mock.method(globalThis, 'fetch', async (url: string) => {
      if (url.endsWith('/healthz')) return new Response('{}');
      calls++; now = 60_000; throw new TypeError('fetch failed');
    });
    const context = await createContext('status', undefined, [], false);
    await assert.rejects(context.api('status'), /Control plane unreachable at http:\/\/127\.0\.0\.1:4310\/api\/status after 60 seconds/);
    assert.equal(calls, 1, 'no retry after the deadline');
  } finally {
    for (const [key, value] of Object.entries({ GRAPHYARD_URL: originalUrl, GRAPHYARD_TOKEN: originalToken, GRAPHYARD_TOKEN_FILE: originalFile })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
