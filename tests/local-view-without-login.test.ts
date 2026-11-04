import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal } from '../src/model.js';
import { signInDatabase } from './helpers/sign-in-database.js';
import { localRequest } from './helpers/local-request.js';

// Viewing the dashboard on the machine that serves it needs no sign-in: a tokenless GET from
// loopback, addressed to the served host and port, reads as the local viewer. Any other Host
// (a DNS-rebinding page, the tailnet proxy) or a forwarded request still needs a session, and no
// CORS header lets another website read the answer.
test('integration:local-view-without-login — a local Host GET without a session reads the board; a foreign Host or proxied request is refused; no Access-Control-Allow-Origin header', async () => {
  const database = await signInDatabase(3091);
  const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
  const engine = new Engine(database.store, 120, 'owner/project');
  engine.gitRunner = null;
  const http = server(engine, [{ ...operator, token: `operator-${'x'.repeat(32)}` }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port, url = `http://127.0.0.1:${port}`;
  try {
    const work = await engine.execute(operator, 'create', null, { type: 'chore', title: 'Visible without login', criteria: [{ id: 'AC-1', text: 'Shown', proofs: ['unit:shown', 'e2e:fixture'] }] }, randomUUID());
    const origin = { Origin: 'http://evil.example' };
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const board = await localRequest(url, '/api/board', { headers: { Host: host, ...origin } });
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
      const refused = await localRequest(url, '/api/board', { headers: { ...headers, ...origin } });
      assert.equal(refused.status, 401, JSON.stringify(headers));
      assert.equal(refused.headers['access-control-allow-origin'], undefined);
    }
    // A wrong token is refused as before; the local viewer is only ever tokenless.
    assert.equal((await localRequest(url, '/api/board', { headers: { Authorization: 'Bearer not-a-token' } })).status, 401);
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); await database.close(); }
});
