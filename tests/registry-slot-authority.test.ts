import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import EmbeddedPostgres from './helpers/warm-postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { proposedRuntimes } from '../src/model/registry.js';
import { recordObservedExhaustion, selectAccount, masterConfigSchema, readEnvironmentLog } from '../src/master.js';
import type { FleetClient } from '../src/fleet.js';

const actor = { id: 'executor', role: 'coordinator' as const }, hostId = 'registry-test-host';
let database: EmbeddedPostgres, store: Store, registry: AgentRegistry, root: string;
before(async () => {
  root = await temporaryDirectory('registry-slot-authority');
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 46;
  database = new EmbeddedPostgres({ databaseDir: join(root, 'pg'), user: 'graphyard', password: 'test', port, persistent: false,
    onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('slots');
  store = new Store(`postgres://graphyard:test@127.0.0.1:${port}/slots`); await store.init();
  registry = new AgentRegistry(store);
  await registry.mutate(actor, 'apply', {
    runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude'), models: [{ name: 'opus', id: 'opus' }],
    accounts: ['account-a', 'account-b'].map(name => ({ name, runtime: 'claude', model: 'opus', credential: { host: hostId, home: null } })),
    roles: [{ name: 'worker', accounts: ['account-a', 'account-b'], concurrency: 1 }], reason: 'slot test',
  }, randomUUID());
});
after(async () => { await store?.close(); await database?.stop(); });
const client = (): FleetClient => ({
  document: () => registry.document(actor),
  select: request => registry.select(actor, request, randomUUID()) as ReturnType<FleetClient['select']>,
  end: async (id, reason) => { await registry.endSession(actor, id, { reason }, randomUUID()); },
  observe: request => registry.observe(actor, request, randomUUID()),
});
async function executor(label: string) {
  const directory = await temporaryDirectory(label, root);
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'fixture-token');
  return masterConfigSchema.parse({ version: 1, url: 'https://unused.example', credentialFile, hostId,
    cliPath: join(root, 'graphyard.mjs'), repository: 'owner/project', baseBranch: 'main', masterAgentName: 'master', workers: [] });
}

test('unit:registry-slot-authority — independent loops racing for the last slot launch once; local names and logs grant no capacity', async () => {
  const configs = await Promise.all([executor('loop-a'), executor('loop-b')]);
  let launches = 0;
  const outcomes = await Promise.allSettled(configs.map(async (config, index) => {
    const selected = await selectAccount(config, 'worker', { name: `worker-${index}`, principal: `worker-${index}` },
      { registry: client(), work: `GY-${index + 1}`, quota: false });
    launches++;
    return selected;
  }));
  assert.equal(launches, 1);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  const document = await registry.document(actor);
  assert.equal(document.sessions.filter(session => !session.endedAt).length, 1);
  assert.match(String((outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult).reason), /concurrency limit/);
  // A second request for the same work must not supersede the winner's pre-launch reservation.
  const winner = document.sessions.find(session => !session.endedAt)!;
  const duplicate = await client().select({ role: 'worker', host: hostId, group: null, work: winner.work, principal: winner.principal, observations: [] });
  assert.equal(duplicate.selected, false);
  assert.equal((await registry.document(actor)).sessions.find(session => session.id === winner.id)!.endedAt, null);
  await registry.mutate(actor, 'role.set', { role: { name: 'worker', accounts: ['account-a', 'account-b'], concurrency: 3 }, reason: 'test purpose and principal reservations' }, randomUUID());
  for (const work of [winner.work, 'GY-other']) {
    const duplicate = await client().select({ role: 'worker', host: hostId, group: null, work, principal: winner.principal, observations: [] });
    assert.equal(duplicate.selected, false, 'spare role capacity cannot duplicate a worker purpose or identity');
    assert.match(duplicate.reason, /already reserved/);
  }
  await client().end(winner.id, 'test session finished');
});

test('unit:registry-slot-authority — exhaustion reported by one executor is held for every executor despite fresh healthy probes', async () => {
  const first = await executor('reporter'), second = await executor('other-host-loop');
  const until = new Date(Date.now() + 3_600_000).toISOString();
  await recordObservedExhaustion(first, 'account-a', { at: new Date().toISOString(), resetsAt: until,
    reason: 'provider session limit', role: 'worker', profile: 'worker-a', work: 'GY-3' }, Date.now(), { registry: client() });
  assert.deepEqual((await readEnvironmentLog(first)).exhausted, {}, 'no local exhaustion authority or outbox');
  for (const config of [second, first]) {
    const selected = await selectAccount(config, 'worker', { name: 'worker', principal: 'worker' }, { registry: client(), quota: false, work: 'GY-4' });
    assert.equal(selected.account?.name, 'account-b');
    await selected.release!('test session finished');
  }
  assert.equal((await registry.document(actor)).accounts.find(account => account.name === 'account-a')!.quota.state, 'exhausted');
  const down = { observe: async () => { throw new Error('registry unavailable'); } };
  await assert.rejects(recordObservedExhaustion(first, 'account-b', { at: new Date().toISOString(), resetsAt: until,
    reason: 'limit', role: 'worker', profile: 'worker', work: 'GY-5' }, Date.now(), { registry: down }), /registry unavailable/);
  assert.deepEqual((await readEnvironmentLog(first)).exhausted, {});
});

test('integration:registry-slot-authority-core — core E2E cases pass against this head with a temporary database', async () => {
  const { Engine } = await import('../src/engine.js');
  const { server } = await import('../src/server.js');
  const { parseCase } = await import('../src/e2e/case.js');
  const { runCases } = await import('../src/e2e/runner.js');
  const { readFile } = await import('node:fs/promises');
  const token = randomUUID().replaceAll('-', '').repeat(2);
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  const http = server(engine, [{ id: 'test-operator', role: 'admin', sessionKind: 'human', token }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  try {
    const cases = await Promise.all(['create-work-item', 'board', 'work-item-detail'].map(async id => {
      const file = `e2e/cases/${id}.json`;
      return { file, definition: parseCase(file, await readFile(file, 'utf8')) };
    }));
    const report = await runCases(cases, { url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, token,
      environment: 'uat', root: process.cwd(), retries: 0, withholdSecrets: true,
      artifactsDirectory: await temporaryDirectory('registry-core-artifacts', root), signal: AbortSignal.timeout(90_000) });
    assert.deepEqual(report.cases.map(result => [result.id, result.verdict]), cases.map(entry => [entry.definition.id, 'passed']), JSON.stringify(report.cases));
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); }
});
