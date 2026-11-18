import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { observeAccount } from '../src/fleet.js';
import { hostAccountsVariable } from '../src/host-accounts.js';
import { registryCommand } from '../src/cli/master-registry.js';
import { proposedRuntimes, utcClock, type AgentRegistry, type FleetView } from '../src/model/registry.js';
import { accountStatus } from '../web/agent-status.js';
import type { Principal } from '../src/model.js';

// GY-3494 e2e: an account seeded at 100% of its weekly allowance, through the real control plane and `master registry`.
const HOST = 'ceiling-host';
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
  store = await withDatabase('usage-ceiling-holds');
  await store.init();
  http = server(new Engine(store, 7200, 'owner/usage-ceiling'), credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); });

test('e2e:usage-ceiling-holds — an account at 100% weekly is no role\'s next account, and master registry and the dashboard say when it is back', async () => {
  const root = await temporaryDirectory('usage-ceiling-e2e');
  process.env[hostAccountsVariable] = await temporaryDirectory('host-records', root);
  const runtime = proposedRuntimes.find(entry => entry.name === 'claude')!;
  const homes = { 'claude-spent': await temporaryDirectory('claude-spent', root), 'claude-fresh': await temporaryDirectory('claude-fresh', root) };
  for (const [name, home] of Object.entries(homes)) await writeFile(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `token-${name}`, refreshToken: 'r', expiresAt: Date.now() + 86_400_000 } }));
  await call(operator, 'agent-registry/apply', { runtimes: [runtime], models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: Object.entries(homes).map(([name, home]) => ({ name, runtime: 'claude', model: 'opus', plan: name, credential: { host: HOST, home } })),
    roles: ['worker', 'reviewer', 'producer', 'master'].map(name => ({ name, accounts: ['claude-spent', 'claude-fresh'], concurrency: 2 })), reason: 'ceiling e2e' });

  // Seed: the provider reports claude-spent's weekly window at 100%, and its live request passes.
  const reset = new Date(Math.ceil((Date.now() + 2 * 86_400_000) / 60_000) * 60_000).toISOString();
  const usage = (async (_url: string, init: { headers: Record<string, string> }) => new Response(JSON.stringify({
    seven_day: { utilization: init.headers.Authorization.endsWith('claude-spent') ? 100 : 20, resets_at: reset } }), { status: 200 })) as unknown as typeof fetch;
  const document = await call(coordinator, 'agent-registry/document') as AgentRegistry;
  const observations = await Promise.all(document.accounts.map(async account => ({ account: account.name,
    quota: (await observeAccount(account, runtime, { fetch: usage, cacheMs: 0, smoke: async () => ({ ok: true }), opencodeAuth: null, opencodeModels: null }, document.accounts, 'claude-opus-5')).quota })));
  await call(coordinator, 'agent-registry/observe', { host: HOST, observations });

  // `graphyard master registry` as the operator runs it.
  const view = await registryCommand({ hostId: HOST }, [], { read: path => call(coordinator, path), write: path => { throw new Error(`no write expected: ${path}`); } }) as FleetView;
  const sentence = `weekly allowance 100% used, back ${utcClock(reset)}`;
  for (const role of view.roles) assert.equal(role.next, 'claude-fresh', `${role.role} next account`);
  const spent = view.accounts.find(account => account.name === 'claude-spent')!;
  assert.equal(spent.eligible, false);
  assert.equal(spent.ineligible, `claude-spent quota is exhausted: ${sentence}`, 'one plain sentence saying when it is back');
  assert.equal(spent.evidence, sentence);
  // The dashboard's account row says the same sentence.
  assert.equal(accountStatus(spent, view, Date.now()).reason, sentence);
});
