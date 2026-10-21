import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { emptyDaemonState, profileHealth, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import {
  masterConfigSchema, observedExhaustions, recordObservedExhaustion,
  reclaimableAgent, selectAccount, type HerdrAgent, type MasterConfig, type WorkerProfile,
} from '../src/master.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1708 AC-2: mid-attempt exhaustion hold never launches a second session on the spent account,
// never double-counts the attempt, and keeps role bound counters truthful through the redispatch.

const repository = 'owner/capacity-bounds';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const workerA: Principal = { id: 'worker-a', role: 'worker', sessionKind: 'ai' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, workerA, coordinator].map(principal => ({ ...principal, token: `bounds-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;

let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, home: string;

const call = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const result = await call(principal, method, path, body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 179;
  database = new EmbeddedPostgres({
    databaseDir: await temporaryDirectory('capacity-bounds-db'),
    user: 'graphyard', password: 'testing-only', port, persistent: false,
    onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'],
  });
  await database.initialise(); await database.start(); await database.createDatabase('capacity_bounds');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/capacity_bounds`);
  await store.init();
  engine = new Engine(store, [15368], 300, repository);
  engine.submissionObserver = null; engine.controlPlaneAppId = 1234;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  home = await temporaryDirectory('capacity-bounds');
  await mkdir(join(home, 'env-a'), { recursive: true });
  await mkdir(join(home, 'env-b'), { recursive: true });
  await writeFile(join(home, 'env-a/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'x' } }));
  await writeFile(join(home, 'env-b/auth.json'), JSON.stringify({ tokens: { access_token: 'x' } }));
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('unit:capacity-hold-respects-machine-bounds — a held account is not re-selected, occupiesRoleBound blocks a second live session, and the spent epoch is counted once', async () => {
  const capacity = await import('../src/model/capacity.js') as {
    accountHeldForRole?: (held: Record<string, { until?: string; resetsAt?: string | null }>, account: string, now: number) => boolean;
    workerAttemptLedger?: (work: Work, epoch: number) => { exhaustions: number; attempts: number; released: number; open: number; preservedCommit: string | null };
  };
  const sessions = await import('../src/daemon/sessions.js') as {
    occupiesRoleBound?: (profile: WorkerProfile, agent: HerdrAgent | undefined, work: readonly Work[], now: number) => boolean;
  };
  assert.equal(typeof capacity.accountHeldForRole, 'function', 'GY-1708 exports accountHeldForRole');
  assert.equal(typeof capacity.workerAttemptLedger, 'function', 'GY-1708 exports workerAttemptLedger');
  assert.equal(typeof sessions.occupiesRoleBound, 'function', 'GY-1708 exports occupiesRoleBound');
  const accountHeldForRole = capacity.accountHeldForRole!;
  const workerAttemptLedger = capacity.workerAttemptLedger!;
  const occupiesRoleBound = sessions.occupiesRoleBound!;

  await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
  const now = Date.now();
  const resetsAt = new Date(now + 3_600_000).toISOString();
  const config = masterConfigSchema.parse({
    version: 1, url, credentialFile: join(home, 'coordinator.token'), cliPath: join(process.cwd(), 'bin/graphyard.mjs'),
    repository, baseBranch: 'main', githubAppId: 4242, hostId: 'loop-host', masterAgentName: 'graphyard-master-bounds',
    workers: [{ name: 'builder', principal: workerA.id, agentName: 'agent-builder', mode: 'launch', kind: 'claude', credentialFile: join(home, 'builder.token'), accounts: ['env-a', 'env-b'] }],
    environments: [
      { name: 'env-a', kind: 'claude', home: join(home, 'env-a') },
      { name: 'env-b', kind: 'codex', home: join(home, 'env-b') },
    ],
  }) as MasterConfig;

  await recordObservedExhaustion(config, 'env-a', {
    at: new Date(now).toISOString(), resetsAt, reason: "You've hit your weekly limit",
    role: 'worker', profile: 'builder', work: 'GY-1708',
  }, now);
  const held = await observedExhaustions(config);
  assert.equal(accountHeldForRole(held, 'env-a', now), true, 'GY-1705 hold stands while the reset is ahead');
  assert.equal(accountHeldForRole(held, 'env-b', now), false);
  assert.equal(accountHeldForRole(held, 'env-a', Date.parse(resetsAt) + 1), false, 'after the reset the account is free again');

  const selected = await selectAccount(config, 'worker', config.workers[0], { quota: false, now: () => now, cacheMs: 0, work: 'GY-1708' });
  assert.equal(selected.account?.name, 'env-b', 'selection fails over to the next account; the held one is never re-selected');

  const profile = config.workers[0] as WorkerProfile;
  const live: HerdrAgent = { name: profile.agentName, pane_id: 'pane-1', agent_status: 'working' };
  const finished: HerdrAgent = { name: profile.agentName, pane_id: 'pane-1', agent_status: 'done' };
  const filed = await ok(operator, 'POST', 'work', {
    title: 'bounds', 
    criteria: [{ id: 'AC-1', text: 'bounds', proofs: ['unit:capacity-hold-respects-machine-bounds'] }],
  }) as Work;
  const ready = await ok(operator, 'POST', `work/${filed.id}/ready`, {}) as Work;
  const claimed = await ok(workerA, 'POST', `work/${ready.id}/claim`, {}) as Work;
  assert.equal(occupiesRoleBound(profile, live, [claimed], now), true, 'a working agent under a live lease occupies the bound');
  assert.equal(occupiesRoleBound(profile, finished, [claimed], now), true, 'a finished agent whose lease still owns it still occupies the bound');

  // End the attempt as capacity exhaustion would: released epoch, no live lease.
  await ok(coordinator, 'POST', `work/${claimed.id}/capacity`, {
    event: 'exhausted', role: 'worker', epoch: claimed.epoch, profile: 'builder', account: 'env-a', runtime: 'claude',
    reason: "You've hit your weekly limit", resetsAt,
    partialWork: { state: 'clean', detail: 'nothing uncommitted' },
  });
  const after = await reload(claimed.id);
  assert.equal(after.lease, null);
  const ledger = workerAttemptLedger(after, 1);
  assert.deepEqual(ledger, { exhaustions: 1, attempts: 1, released: 1, open: 0, preservedCommit: null }, 'the spent epoch is counted once');
  assert.equal(occupiesRoleBound(profile, finished, [after], now), false, 'once the lease ends the finished agent no longer occupies the bound');
  assert.equal(reclaimableAgent(profile, finished, [after], now), true);

  // Dispatch after the hold: the spent account stays held; the profile is free for the redispatch.
  const herdr = { agents: [finished] as HerdrAgent[] };
  const state: DaemonState = emptyDaemonState(config);
  const dispatches: string[] = [];
  const effects: DaemonEffects = {
    agents: () => herdr.agents,
    herdr: () => ({ agents: herdr.agents, available: true }),
    credentials: async () => ({ builder: { available: true, reason: null, accounts: [
      { environment: 'env-a', healthy: false, reason: 'held', quota: 'exhausted', resetsAt },
      { environment: 'env-b', healthy: true, reason: null, quota: 'ok', resetsAt: null },
    ] } }),
    snapshot: async () => {
      const snapshot = await ok(coordinator, 'GET', 'work-snapshot');
      return { work: snapshot.work as Work[], now: snapshot.now };
    },
    closeSession: () => {},
    dispatch: async (work, chosen) => {
      const pick = await selectAccount(config, 'worker', chosen, { quota: false, now: () => now, cacheMs: 0, work: work.key });
      assert.notEqual(pick.account?.name, 'env-a', 'redispatch never launches on the held account');
      dispatches.push(pick.account?.name ?? 'none');
      const next = await ok(workerA, 'POST', `work/${work.id}/claim`, {}) as Work;
      herdr.agents = [{ name: chosen.agentName, pane_id: 'pane-2', agent_status: 'working' }];
      await ok(workerA, 'POST', `work/${work.id}/workspace`, {
        epoch: next.epoch, host: 'loop-host', path: `/tmp/bounds/${next.id}`, branch: `graphyard/${next.key.toLowerCase()}-${next.epoch}`,
      });
    },
    requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'n/a', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
    reportCapacity: (work, event) => ok(coordinator, 'POST', `work/${work.id}/capacity`, event) as Promise<Work>,
  };
  const health = profileHealth(config.workers, { builder: { available: true, reason: null } }, herdr.agents, state, now, [after]);
  assert.equal(health[0].busy, false, 'finished agent with no live lease is not busy: the bound is free for redispatch');
  await runCycle(config, state, effects, () => now);
  assert.deepEqual(dispatches, ['env-b'], 'one redispatch on the free account; the held account never launches a second session');
  const redispatched = await reload(claimed.id);
  assert.equal(redispatched.epoch, 2);
  assert.equal(redispatched.lease?.owner, workerA.id);
  assert.equal(workerAttemptLedger(redispatched, 1).open, 0, 'epoch 1 stays closed');
  assert.equal(workerAttemptLedger(redispatched, 2).open, 1, 'epoch 2 is the one open attempt');
});
