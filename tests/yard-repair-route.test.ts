import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema, type WorkerProfile } from '../src/master.js';
import type { Principal } from '../src/model.js';
import { coordinationViewHeader } from '../src/server/work-view.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import { createSchema } from '../src/model-boundary/work.js';
import { dispatchSort } from '../src/model/coordination.js';
import { mergeQueue } from '../src/model/merge-queue.js';
import { needsSpecCheck, specCheckRefusal } from '../src/model/spec-check.js';
import type { Work } from '../src/model.js';

// GY-3102: a yard-repair item takes its own route past a broken pipeline.

const item = (key: string, extra: Record<string, unknown> = {}) => ({
  key, id: key, title: key, type: 'feature', priority: 2, createdAt: '2026-01-01T00:00:00Z', stageEnteredAt: '2026-01-01T00:00:00Z', ...extra,
}) as unknown as Work;

test('unit:yard-repair-route create accepts yardRepair', () => {
  const parsed = createSchema.parse({ title: 'Fix', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:x'] }], yardRepair: true });
  assert.equal(parsed.yardRepair, true);
});

test('unit:yard-repair-route skips the spec-check hold', () => {
  assert.equal(needsSpecCheck(item('GY-1')), true);
  assert.ok(specCheckRefusal(item('GY-1')));
  assert.equal(needsSpecCheck(item('GY-2', { yardRepair: true })), false);
  assert.equal(specCheckRefusal(item('GY-2', { yardRepair: true })), null);
});

test('unit:yard-repair-route sorts first in dispatchSort', () => {
  const sorted = dispatchSort([item('GY-1', { priority: 0 }), item('GY-2', { priority: 4, yardRepair: true })]);
  assert.deepEqual(sorted.map(entry => entry.key), ['GY-2', 'GY-1']);
});

test('unit:yard-repair-route merges first, oldest first', () => {
  const owed = (key: string, createdAt: string, extra: Record<string, unknown> = {}) => item(key, {
    createdAt, stage: 'review', submission: {}, candidate: { sha: key.padEnd(40, '0') }, observation: { source: 'control-plane' },
    gates: [{ name: 'build', passed: true }, { name: 'review', passed: true }], ...extra,
  });
  const queue = mergeQueue([
    owed('GY-1', '2026-01-01T00:00:00Z', { priority: 0 }),
    owed('GY-3', '2026-01-03T00:00:00Z', { yardRepair: true }),
    owed('GY-2', '2026-01-02T00:00:00Z', { yardRepair: true }),
  ], {}, Date.parse('2026-02-01T00:00:00Z'));
  assert.deepEqual(queue.queue.map(entry => entry.key), ['GY-2', 'GY-3', 'GY-1']);
});

// The release cap, driven through the loop cycle the way tests/loop-releases-backlog-to-concurrency.test.ts does.
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });
const repository = 'owner/yard-repair';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const loopId = 'graphyard-master-yard-operator';
const credentials = [operator, coordinator].map(principal => ({ ...principal, token: `yard-${principal.id}-${'x'.repeat(32)}` }));
const agentToken = `yard-agent-${randomUUID()}`;
let store: Store, http: ReturnType<typeof server>, url: string;

const call = async (bearer: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const parsed = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(parsed));
  return parsed;
};
const file = (title: string, extra: Record<string, unknown> = {}) => call(credentials[0].token, 'work', {
  title, type: 'chore', priority: 1, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:yard-repair-route', 'e2e:fixture'] }], policy: { checks: ['test'], review: true }, ...extra,
}) as Promise<Work>;

before(async () => {
  store = await withDatabase('yard-repair-route');
  await store.init();
  http = server(new Engine(store, 300, repository), credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  await call(credentials[0].token, 'operator-agents', { id: loopId, displayName: 'Master loop', capabilities: [],
    scope: { repositories: [repository], workItems: ['*'] }, token: agentToken, reason: 'the loop releases under its own identity' });
});
after(async () => { http?.close(); await store?.close(); });

test('unit:yard-repair-route releaseBacklog releases a yard repair past a full pipeline and holds ordinary backlog', async () => {
  const inFlight = await file('In flight');
  await call(credentials[0].token, `work/${inFlight.id}/ready`, { expectedRevision: inFlight.revision, reason: 'already running' });
  const ordinary = await file('Ordinary backlog', { priority: 0 });
  const repair = await file('Yard repair', { priority: 3, yardRepair: true });
  assert.equal(repair.yardRepair, true, 'engine create stores the field');

  const profile = { name: 'one', principal: 'worker-a', agentName: 'agent-one', mode: 'launch', kind: 'claude', credentialFile: '/srv/one.token', agentArgs: [], approvals: 'auto', environment: {} } as WorkerProfile;
  // Concurrency 1, and one item is already ready: the cap is full.
  const config = masterConfigSchema.parse({ version: 1, url, credentialFile: '/outside/coordinator.token', cliPath: '/outside/bin/graphyard.mjs', repository, baseBranch: 'main',
    hostId: 'loop-host', masterAgentName: 'graphyard-master-yard', operatorAgent: { id: loopId, credentialFile: '/outside/operator-agent.token' }, workers: [profile] });
  const released: string[] = [], reasons: string[] = [];
  const effects: DaemonEffects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({ one: { available: true, reason: null } }),
    snapshot: async () => {
      const snapshot = await call(credentials[1].token, 'work-snapshot', undefined, { [coordinationViewHeader]: 'coordination' });
      return { work: snapshot.work as Work[], now: snapshot.now };
    },
    closeSession: () => {},
    release: async (item, reason) => {
      released.push(item.key); reasons.push(reason);
      return call(agentToken, `work/${item.id}/ready`, { expectedRevision: item.revision, reason });
    },
    dispatch: async () => ({ pane: null }),
    persist: async () => {},
  };
  const state = emptyDaemonState(config);
  await runCycle(config, state, effects);
  assert.deepEqual(released, [repair.key], 'only the yard repair passes the full cap; the higher-priority ordinary item waits');
  assert.match(reasons[0], /yard repair, so the loop releases it past the pipeline cap/);
  const decision = Object.entries(state.actions).find(([key]) => key.startsWith(`release:${repair.id}:`))?.[1];
  assert.match(decision?.detail ?? '', new RegExp(`Released yard repair ${repair.key} past the pipeline cap`));
  assert.ok(!Object.keys(state.actions).some(key => key.startsWith(`release:${ordinary.id}:`)), 'no release decision for the ordinary item');
});
