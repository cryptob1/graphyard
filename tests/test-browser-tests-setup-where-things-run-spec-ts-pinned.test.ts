import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Agent, createServer, get } from 'node:http';

// GY-3358: test:browser-tests/setup-where-things-run.spec.ts failed on the batch gate and passed its
// re-run. Its teardown called http.close() while the open page kept polling /api/status every 5 s
// through the proxy's keep-alive connection: a poll in flight at close holds the socket open and the
// next poll reuses it, so close() never called back and the test ran out its 90 s. A loaded host,
// where each poll takes seconds, makes a poll in flight at teardown likely; a re-run usually misses it.
// The spec now drops every connection as it closes, as setup-invite and create-work-one-box do.

/** Close a server while a keep-alive client has a request in flight and keeps polling; resolves whether close() called back within 2 s. */
async function closesUnderPolling(close: (server: ReturnType<typeof createServer>, done: () => void) => void) {
  const server = createServer((_req, res) => setTimeout(() => res.end('ok'), 200));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new Agent({ keepAlive: true }), port = (server.address() as { port: number }).port;
  const poll = () => new Promise<void>(resolve => get({ host: '127.0.0.1', port, agent }, res => { res.resume(); res.on('end', resolve); }).on('error', () => resolve()));
  await poll();
  void poll(); await new Promise(resolve => setTimeout(resolve, 50)); // a poll in flight at teardown
  const timer = setInterval(() => void poll(), 300);
  try {
    return await Promise.race([new Promise<boolean>(resolve => close(server, () => resolve(true))), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2_000))]);
  } finally { clearInterval(timer); server.closeAllConnections(); server.close(); agent.destroy(); }
}

test('unit:test-browser-tests-setup-where-things-run-spec-ts-pinned — the Setup where-things-run spec closes its server even while the page polls', async () => {
  assert.equal(await closesUnderPolling((server, done) => server.close(done)), false, 'close() alone hangs while a keep-alive client polls (the flake)');
  assert.equal(await closesUnderPolling((server, done) => { server.close(done); server.closeAllConnections(); }), true, 'closing every connection lets close() return');
  const spec = readFileSync('browser-tests/setup-where-things-run.spec.ts', 'utf8');
  assert.match(spec, /http\.close\(\(\) => resolve\(\)\); http\.closeAllConnections\(\);/, 'the spec drops every connection as it closes its server');
});
