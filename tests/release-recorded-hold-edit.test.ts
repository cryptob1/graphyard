import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Store } from '../src/store.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema, type WorkerProfile } from '../src/master.js';
import type { Principal, Work } from '../src/model.js';
import { coordinationViewHeader } from '../src/server/work-view.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';

setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// GY-3282: every release records who and why (the loop's own is 'loop'), a held item stays in
// backlog until released, and a description edit is recorded in history and queued for a leased worker.
const repository = 'owner/release-recorded';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const worker: Principal = { id: 'worker-a', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, worker].map(principal => ({ ...principal, token: `release-${principal.id}-${'x'.repeat(32)}` }));
const token = (id: string) => credentials.find(credential => credential.id === id)!.token;
const loopId = 'release-recorded-operator';
let store: Store, http: ReturnType<typeof server>, url: string, agentToken: string;

const call = async (bearer: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...(path === 'work-snapshot' ? { [coordinationViewHeader]: 'coordination' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const parsed = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(parsed));
  return parsed;
};
const file = (title: string, extra: Record<string, unknown> = {}) => call(token(operator.id), 'POST', 'work', {
  title, type: 'chore', description: 'The first description', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:release-recorded-hold-edit', 'e2e:fixture'] }], policy: { checks: ['test'], review: true }, ...extra }) as Promise<Work>;
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;

before(async () => {
  store = await withDatabase('release-recorded-hold-edit'); await store.init();
  http = server(new Engine(store, 300, repository), credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  agentToken = `loop-agent-${randomUUID()}`;
  await call(token(operator.id), 'POST', 'operator-agents', { id: loopId, displayName: 'Loop', capabilities: [], scope: { repositories: [repository], workItems: ['*'] }, token: agentToken, reason: 'the loop applies its decisions' });
});
after(async () => { http?.close(); await store?.close(); });

test('integration:release-recorded-hold-edit — the loop releases an unheld item as "loop" with a reason, skips a held one until an identity releases it, and a description edit is history and reaches the leased worker', async () => {
  const free = await file('Free item'), held = await file('Held item', { hold: true });
  const profile = { name: 'one', principal: worker.id, agentName: 'agent-one', mode: 'launch', kind: 'claude', credentialFile: '/srv/one.token', agentArgs: [], approvals: 'auto', environment: {} } as WorkerProfile;
  const config = masterConfigSchema.parse({ version: 1, url, credentialFile: '/outside/c.token', cliPath: '/outside/graphyard.mjs', repository, baseBranch: 'main', githubAppId: 1234, hostId: 'h', masterAgentName: 'm', autoMerge: true, mergeMethod: 'merge',
    operatorAgent: { id: loopId, credentialFile: '/outside/o.token' }, workers: [profile, { ...profile, name: 'two', agentName: 'agent-two' }] });
  const effects: DaemonEffects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({}),
    snapshot: async () => { const snapshot = await call(token(coordinator.id), 'GET', 'work-snapshot'); return { work: snapshot.work as Work[], now: snapshot.now }; },
    closeSession: () => {},
    release: (item, reason) => call(agentToken, 'POST', `work/${item.id}/ready`, { expectedRevision: item.revision, reason, by: 'loop' }),
    dispatch: async () => { throw new Error('no launch in this test'); },
    persist: async () => {},
  };
  await runCycle(config, emptyDaemonState(config), effects);
  const released = await reload(free.id);
  assert.equal(released.ready, true); assert.equal(released.releasedBy, 'loop'); assert.ok(released.releaseReason);
  assert.equal((await reload(held.id)).ready, false, 'a held item stays undispatched');

  const byOperator = await call(token(operator.id), 'POST', `work/${held.id}/ready`, { reason: 'The operator is done holding it' });
  assert.equal(byOperator.ready, true); assert.equal(byOperator.releasedBy, operator.id); assert.equal(byOperator.releaseReason, 'The operator is done holding it');

  // A description edit on a leased item is history and reaches the worker's next sync.
  await call(token(worker.id), 'POST', `work/${held.id}/claim`, {});
  const claimed = await reload(held.id);
  const edited = await call(token(operator.id), 'POST', `work/${held.id}/requirements`, { expectedPolicyRevision: claimed.policyRevision, reason: 'Clarify the goal', description: 'The clarified description', criteria: claimed.criteria, dependencies: [], exclusiveResources: [] });
  assert.equal(edited.description, 'The clarified description');
  assert.deepEqual(edited.unsyncedRevision.changed, ['description changed: The clarified description']);
  assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM events WHERE work_id=$1 AND kind='requirements'", [held.id])).rows[0].n, 1);
});
