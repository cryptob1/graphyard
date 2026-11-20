import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { observeAccount } from '../src/fleet.js';
import { hostAccountsVariable } from '../src/host-accounts.js';
import { registryCommand } from '../src/cli/master-registry.js';
import { proposedRuntimes, type AgentRegistry, type FleetView } from '../src/model/registry.js';
import type { Principal } from '../src/model.js';

// GY-3495 e2e: three Z.AI keys read through a stub quota endpoint, the real control plane and `master registry`.
const HOST = 'zai-host';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, coordinator].map(principal => ({ ...principal, token: `${principal.id}-${'x'.repeat(32)}` }));
let store: Store, http: ReturnType<typeof server>, url: string;
const call = async (principal: Principal, path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${credentials.find(entry => entry.id === principal.id)!.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json() as any;
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(result)}`);
  return result;
};

before(async () => {
  store = await withDatabase('zai-usage-read');
  await store.init();
  http = server(new Engine(store, 7200, 'owner/zai-usage-read'), credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); });

test('e2e:zai-usage-read — master registry shows each Z.AI key\'s own allowance and reset, and a key reporting none as not reported', async () => {
  const root = await temporaryDirectory('zai-usage-e2e');
  process.env[hostAccountsVariable] = await temporaryDirectory('host-records', root);
  const runtime = proposedRuntimes.find(entry => entry.name === 'opencode')!;
  const minute = (ms: number) => new Date(Math.ceil((Date.now() + ms) / 60_000) * 60_000).toISOString();
  const weeklyReset = minute(3 * 86_400_000), creditReset = minute(86_400_000);
  // The stub endpoint answers each key with its own limits.
  const limits: Record<string, unknown[]> = {
    'zai-weekly': [{ type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 1, nextResetTime: Date.parse(minute(20 * 86_400_000)) },
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 1, nextResetTime: Date.parse(minute(3_600_000)) },
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 96, nextResetTime: Date.parse(weeklyReset) }],
    'zai-credit': [{ type: 'CREDIT_LIMIT', unit: 6, percentage: 100, nextResetTime: Date.parse(creditReset) }],
    'zai-empty': [],
  };
  const homes: Record<string, string> = {};
  for (const name of Object.keys(limits)) {
    homes[name] = await temporaryDirectory(name, root);
    await mkdir(join(homes[name], 'opencode'), { recursive: true });
    await writeFile(join(homes[name], 'opencode/auth.json'), JSON.stringify({ 'zai-coding-plan': { key: `key-${name}` } }));
  }
  const endpoint = (async (_url: string, init: { headers: Record<string, string> }) => new Response(JSON.stringify({ code: 200, success: true,
    data: { limits: limits[init.headers.Authorization.replace('Bearer key-', '')] } }), { status: 200 })) as unknown as typeof fetch;
  await call(operator, 'agent-registry/apply', { runtimes: [runtime], models: [{ name: 'glm', id: 'zai-coding-plan/glm-5.1' }],
    accounts: Object.entries(homes).map(([name, home]) => ({ name, runtime: 'opencode', model: 'glm', credential: { host: HOST, home } })),
    roles: ['worker', 'reviewer'].map(name => ({ name, accounts: Object.keys(homes), concurrency: 3 })), reason: 'zai usage e2e' });

  // Probed one after another, as the loop does: no key reads another's windows.
  const document = await call(coordinator, 'agent-registry/document') as AgentRegistry;
  const observations = [];
  for (const account of document.accounts) observations.push({ account: account.name,
    quota: (await observeAccount(account, runtime, { fetch: endpoint, cacheMs: 0, smoke: async () => ({ ok: true, error: '' }), opencodeAuth: null, opencodeModels: null }, document.accounts, 'zai-coding-plan/glm-5.1')).quota });
  await call(coordinator, 'agent-registry/observe', { host: HOST, observations });

  const view = await registryCommand({ hostId: HOST }, [], { read: path => call(coordinator, path), write: path => { throw new Error(`no write expected: ${path}`); } }) as FleetView;
  const account = (name: string) => view.accounts.find(entry => entry.name === name)!;

  const weekly = account('zai-weekly');
  assert.deepEqual(weekly.usage.map(({ window, percent, resetsAt }) => ({ window, percent, resetsAt })), [
    { window: '5h', percent: 1, resetsAt: minute(3_600_000) }, { window: '7d', percent: 96, resetsAt: weeklyReset }], 'its own 5h and weekly windows, no monthly one');

  const credit = account('zai-credit');
  assert.deepEqual(credit.usage.map(({ window, percent, resetsAt }) => ({ window, percent, resetsAt })), [{ window: '7d', percent: 100, resetsAt: creditReset }]);
  assert.equal(credit.eligible, true, 'its own live request passed, so its 100% reading holds nothing (GY-3555)');

  const empty = account('zai-empty');
  assert.equal(empty.quota, 'unknown');
  assert.deepEqual(empty.usage, [], 'not a copy of another account\'s windows');
  assert.equal(empty.usageNote, 'this key reports no allowance');
});
