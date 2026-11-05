import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Principal } from '../src/model.js';

// GY-1983: the loop deploys each new main itself (GY-1982), so the release-candidate pipeline —
// candidates, UAT, holds, soaks, seals, promotion and candidate reverts — is gone.

const admin: Principal = { id: 'removal-admin', role: 'admin', sessionKind: 'human' };
const credential = { ...admin, token: `removal-admin-${'r'.repeat(32)}` };
let store: Store | null = null, http: ReturnType<typeof server> | null = null;
after(async () => { http?.close(); await store?.close(); });

test('unit:retired-release-routes — `graphyard release` is no longer a command and /api/candidates answers 404', { timeout: 120_000 }, async () => {
  // No command is named release; giving up a lease is `unclaim GY-N EPOCH`.
  const { commands, renderHelp } = await import('../src/cli/index.js');
  assert.deepEqual(commands.filter(command => command.name === 'release'), []);
  assert.doesNotMatch(renderHelp(), /^ {2}release /m);

  store = await withDatabase('server-release-routes'); await store.init();
  const engine = new Engine(store, 120, 'owner/removed');
  http = server(engine, [credential]);
  await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  for (const [method, path] of [['GET', 'candidates'], ['POST', 'candidates'], ['GET', 'candidates/20261018T000000Z'], ['POST', 'candidates/20261018T000000Z/promotion']]) {
    const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `removed-${method}-${path}` }, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal(response.status, 404, `${method} /api/${path}`);
    assert.deepEqual(await response.json(), { error: 'Route not found' });
  }
});
