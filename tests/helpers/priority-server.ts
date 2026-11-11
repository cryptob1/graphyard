import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Engine } from '../../src/engine.js';
import { server } from '../../src/server.js';
import { withDatabase } from './postgres.js';

export async function priorityServer() {
  const store = await withDatabase('change-priority'); await store.init();
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = null;
  const tokens = { operator: 'operator-' + 'a'.repeat(32), worker: 'worker-' + 'w'.repeat(32), master: 'master-' + 'm'.repeat(32) };
  const http = server(engine, [
    { id: 'operator', role: 'admin', sessionKind: 'human', token: tokens.operator },
    { id: 'worker', role: 'worker', token: tokens.worker },
  ]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const call = async (path: string, body?: unknown, token = tokens.operator, key = randomUUID()) => {
    const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const ok = async (path: string, body?: unknown, token = tokens.operator) => {
    const result = await call(path, body, token); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  };
  await ok('operator-agents', { id: 'master', displayName: 'Master', capabilities: [], scope: { repositories: ['owner/project'], workItems: ['*'] }, token: tokens.master, reason: 'Test master' });
  const teammate = async (role: string) => {
    const { code } = await ok('invites', { name: role, role });
    return (await ok('sign-in', { code })).token as string;
  };
  return { store, engine, url, tokens, call, ok, teammate,
    close: async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await store.close(); } };
}
