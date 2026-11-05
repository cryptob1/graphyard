import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { composeBundle, type AdapterContext } from '../src/install/adapters.js';
import { randomUUID } from 'node:crypto';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal } from '../src/model.js';
import { signInDatabase } from './helpers/sign-in-database.js';
import { localRequest } from './helpers/local-request.js';

// Viewing the dashboard on the machine that serves it needs no sign-in: a tokenless GET from
// loopback, addressed to the served host and port, reads as the local viewer. Any other Host
// (a DNS-rebinding page, the tailnet proxy), forwarded or cross-origin browser request is refused.
test('integration:local-view-without-login — local reads need no session; foreign Host, proxy and cross-site reads are refused', async () => {
  const database = await signInDatabase();
  const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
  const engine = new Engine(database.store, 120, 'owner/project');
  engine.gitRunner = null;
  const http = server(engine, [{ ...operator, token: `operator-${'x'.repeat(32)}` }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const listenerPort = (http.address() as { port: number }).port;
  // Model Docker's TCP publication: the external port differs and the backend sees a peer
  // outside its direct-loopback allowlist. No HTTP headers are rewritten by Docker NAT.
  const relay = createServer(client => {
    const upstream = connect({ host: '127.0.0.1', port: listenerPort, localAddress: '127.0.0.2' });
    client.pipe(upstream).pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
  });
  await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve));
  const publishedPort = (relay.address() as { port: number }).port;
  const previousPort = process.env.GRAPHYARD_LOCAL_VIEW_PORT;
  delete process.env.GRAPHYARD_LOCAL_VIEW_PORT;
  try {
    const work = await engine.execute(operator, 'create', null, { type: 'chore', title: 'Visible without login', criteria: [{ id: 'AC-1', text: 'Shown', proofs: ['unit:shown', 'e2e:fixture'] }] }, randomUUID());
    assert.equal((await localRequest(`http://127.0.0.1:${publishedPort}`, '/api/board')).status, 401, 'undeclared publication cannot bypass the socket boundary');
    for (const port of [listenerPort, publishedPort]) {
      if (port === publishedPort) {
        const bundle = composeBundle({ workdir: '/fixture', installId: 'test', image: 'graphyard:test', port } as AdapterContext, []);
        const compose = bundle.find(file => file.path.endsWith('/compose.yaml'))!.content;
        assert.ok(compose.includes(`ports: ["127.0.0.1:${port}:4310"]`));
        const configuredPort = /GRAPHYARD_LOCAL_VIEW_PORT: "(\d+)"/.exec(compose)![1];
        process.env.GRAPHYARD_LOCAL_VIEW_PORT = configuredPort;
      }
      const url = `http://127.0.0.1:${port}`;
      for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
        const board = await localRequest(url, '/api/board', { headers: { Host: host, Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' } });
        assert.equal(board.status, 200, `${host}: ${JSON.stringify(board.body)}`);
        assert.ok(JSON.stringify(board.body).includes(work.key), `${host} reads the board`);
        assert.equal(board.headers['access-control-allow-origin'], undefined);
      }
      const status = await localRequest(url, '/api/status');
      assert.equal(status.status, 200);
      assert.deepEqual([status.body.actor.id, status.body.actor.role], ['local-viewer', 'reader']);
      // The dashboard sends its empty token, which a browser trims to "Bearer".
      const snapshot = await localRequest(url, '/api/work-snapshot', { headers: { Authorization: 'Bearer' } });
      assert.ok(snapshot.body.work.some((item: { id: string }) => item.id === work.id));

      for (const headers of [{ Host: `evil.example:${port}` }, { Host: `graphyard.tailnet.ts.net:${port}` }, { Host: `127.0.0.1:${port + 1}` }, { Host: `127.0.0.1:${port}`, 'X-Forwarded-For': '100.64.0.7' }, { Host: `127.0.0.1:${port}`, Forwarded: 'for=100.64.0.7' }] as Record<string, string>[]) {
        const refused = await localRequest(url, '/api/board', { headers });
        assert.equal(refused.status, 401, JSON.stringify(headers));
        assert.equal(refused.headers['access-control-allow-origin'], undefined);
      }
      for (const headers of [
        { Origin: 'http://evil.example' }, { Origin: 'null' },
        { Origin: `http://127.0.0.1:${port + 1}` }, { Origin: `https://127.0.0.1:${port}` },
        { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' },
        { Origin: url, 'Sec-Fetch-Site': 'cross-site' },
        { Origin: 'http://evil.example', 'Sec-Fetch-Site': 'same-origin' },
      ] as Record<string, string>[]) {
        const refused = await localRequest(url, '/api/board', { headers });
        assert.equal(refused.status, 401, JSON.stringify(headers));
      }
      assert.equal((await localRequest(url, '/api/board', { headers: { 'Sec-Fetch-Site': 'none' } })).status, 200);
      // A wrong token is refused as before; the local viewer is only ever tokenless.
      assert.equal((await localRequest(url, '/api/board', { headers: { Authorization: 'Bearer not-a-token' } })).status, 401);
      assert.equal((await localRequest(url, '/api/work', { method: 'POST', body: { type: 'chore', title: 'Anonymous mutation' } })).status, 401);
    }
  } finally {
    if (previousPort === undefined) delete process.env.GRAPHYARD_LOCAL_VIEW_PORT;
    else process.env.GRAPHYARD_LOCAL_VIEW_PORT = previousPort;
    await new Promise<void>(resolve => relay.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
    await database.close();
  }
});
