import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { proposedRuntimes, type AgentRegistry as Registry } from '../src/model/registry.js';
import type { Principal, Work } from '../src/model.js';

// GY-3096: the hold a provider limit notice places lives in the control-plane registry, not in the
// loop process that read the notice, so a freshly started loop's next selection skips the account.
const HOST = 'loop-host';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const worker: Principal = { id: 'graphyard-cursor-2', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, worker].map(principal => ({ ...principal, token: `${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;

let store: Store, http: ReturnType<typeof server>, url: string;
const ok = async (principal: Principal, path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json() as any;
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(result)}`);
  return result;
};

before(async () => {
  store = await withDatabase('limit-notice-hold');
  await store.init();
  http = server(new Engine(store, 7200, 'owner/limit-notice'), credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); });

test('unit:limit-notice-hold-persists — a session ended on its provider limit notice marks its account exhausted in the registry with the notice and reset, and a fresh loop\'s next selection for any role skips it', async () => {
  const runtime = proposedRuntimes.find(entry => entry.name === 'claude')!;
  await ok(operator, 'agent-registry/apply', { runtimes: [runtime], models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: ['claude-c', 'claude-d'].map(name => ({ name, runtime: 'claude', model: 'opus', credential: { host: HOST, home: `/home/fixture/${name}` } })),
    roles: [{ name: 'worker', accounts: ['claude-c', 'claude-d'], concurrency: 10 }, { name: 'reviewer', accounts: ['claude-c', 'claude-d'], concurrency: 10 }], reason: 'Two subscriptions' });
  const loggedIn = ['claude-c', 'claude-d'].map(account => ({ account, quota: { loggedIn: true, state: 'available' } }));
  const select = (registry: AgentRegistry, role: 'worker' | 'reviewer', work: string) =>
    registry.select(coordinator, { role, host: HOST, work, principal: worker.id, observations: loggedIn }, randomUUID()) as Promise<{ session: { id: string; account: string } | null; skipped: { account: string; reason: string }[] }>;

  const filed = await ok(operator, 'work', { title: 'Spend an account', type: 'chore', criteria: [{ id: 'AC-1', text: 'Held', proofs: ['unit:limit-notice-hold-persists', 'e2e:create-work-item'] }] }) as Work;
  await ok(operator, `work/${filed.id}/ready`, {});
  // The loop that dispatched the attempt: the registry hands it claude-c.
  const first = (await select(new AgentRegistry(store), 'worker', filed.key)).session!;
  assert.equal(first.account, 'claude-c');
  await ok(worker, `work/${filed.id}/claim`, {});

  // The loop ends the session on its pane's limit notice; it could not name the account (the incident's null).
  const resetsAt = new Date(Date.now() + 5 * 3_600_000).toISOString(), notice = 'Usage limit reached · limit resets 1pm';
  await ok(coordinator, `work/${filed.id}/capacity`, { event: 'exhausted', role: 'worker', epoch: 1, profile: 'graphyard-cursor-2', account: null, runtime: 'claude',
    reason: `the session stopped on its provider's limit notice: ${notice}`, resetsAt, partialWork: { state: 'not-applicable', detail: 'fixture' } });

  const held = ((await ok(coordinator, 'agent-registry/document')) as Registry).accounts.find(account => account.name === 'claude-c')!.quota;
  assert.equal(held.state, 'exhausted');
  assert.equal(held.resetsAt, resetsAt);
  assert.ok(held.reason?.includes(notice), held.reason ?? 'no reason');

  // The pane closed, so the session no longer counts against the account's plan.
  await ok(coordinator, `agent-registry/sessions/${first.id}/end`, { reason: 'the pane closed on its limit notice' });
  // A freshly started loop holds nothing in memory; its probes still read claude-c available. Every role skips it.
  for (const role of ['worker', 'reviewer'] as const) {
    const fresh = await select(new AgentRegistry(store), role, `GY-${role === 'worker' ? 9001 : 9002}`);
    assert.equal(fresh.session?.account, 'claude-d', `${role} selection skips the held account`);
    assert.match(fresh.skipped.find(entry => entry.account === 'claude-c')?.reason ?? '', /exhausted/);
    await ok(coordinator, `agent-registry/sessions/${fresh.session!.id}/end`, { reason: 'fixture' });
  }
});
