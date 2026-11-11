import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema } from '../../src/master.js';
import { emptyDaemonState } from '../../src/daemon/state.js';
import { Launcher, runCycle } from '../../src/daemon/cycle.js';
import { temporaryDirectory } from './temp-dirs.js';
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
  const call = async (path: string, body?: unknown, token = tokens.operator, key: string = randomUUID()) => {
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

/** One normal loop cycle with exactly one available worker; no forced claim or preemption. */
export async function nextPriorityDispatch(f: Awaited<ReturnType<typeof priorityServer>>) {
  const directory = await temporaryDirectory('priority-dispatch');
  const credential = join(directory, 'worker.token'); await writeFile(credential, f.tokens.worker, { mode: 0o600 });
  const cli = fileURLToPath(new URL('../../bin/graphyard.mjs', import.meta.url));
  const master = masterConfigSchema.parse({ version: 1, url: f.url, credentialFile: credential, cliPath: cli, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'test-host', masterAgentName: 'test-master', workers: [{ name: 'only-worker', principal: 'worker', agentName: 'worker', mode: 'launch', kind: 'codex', credentialFile: credential }] });
  const launched: string[] = [];
  const launcher = new Launcher();
  await runCycle(master, emptyDaemonState(master), {
    agents: () => [], credentials: async () => ({ 'only-worker': { available: true, reason: null } }),
    snapshot: async () => ({ work: await f.store.list(), now: new Date().toISOString() }),
    closeSession: () => {}, persist: async () => {}, dispatch: async item => { launched.push(item.key); },
  }, Date.now, launcher);
  await launcher.idle();
  return launched;
}
