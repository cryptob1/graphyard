import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { masterConfigSchema } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const alice: Principal = { id: 'alice', role: 'admin', sessionKind: 'human' };
const bob: Principal = { id: 'bob', role: 'admin', sessionKind: 'human' };
let pg: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 2987;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('owners-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('owners_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/owners_test`); await store.init();
  engine = new Engine(store, 120, 'owner/project'); engine.principals = [alice, bob];
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });
const criteria = [{ id: 'AC-1', text: 'Ownership routes work', proofs: ['unit:masters-dispatch-owned-items'] }];
const create = (owner?: string | null) => engine.execute(alice, 'create', null, { title: `Item ${owner ?? 'install'}`, type: 'chore', criteria, owner }, randomUUID());

test('unit:masters-dispatch-owned-items two personal masters and the install share one control plane and one loop', async () => {
  const owned = await Promise.all([create('alice'), create('bob'), create()]);
  for (const item of owned) await engine.execute(alice, 'ready', item.id, {}, randomUUID());
  const config = masterConfigSchema.parse({ version: 1, url: 'http://control-plane', credentialFile: '/tmp/unused-owner-test-token', cliPath: '/tmp/unused-cli', repository: 'owner/project', baseBranch: 'main', githubAppId: 0, hostId: 'test', masterAgentName: 'master', people: ['alice', 'bob'], workers: ['one', 'two', 'three'].map(name => ({ name, principal: name, agentName: name, mode: 'launch', kind: 'codex', credentialFile: '/tmp/unused-worker-token' })) });
  const state = emptyDaemonState(config), dispatched: string[] = [], handovers = new Map<string, string>();
  let reviewTicks = 0;
  const effects: DaemonEffects = {
    snapshot: async () => ({ work: await store.list(), now: new Date().toISOString() }),
    agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    closeSession: () => {}, persist: async () => {}, dispatchTick: async () => { reviewTicks++; },
    dispatch: async (item, profile) => {
      dispatched.push(item.key);
      await engine.execute({ id: profile.principal, role: 'worker' }, 'claim', item.id, {}, randomUUID());
    },
    masterSession: { launch: async handover => { handovers.set('install', handover); return { agentName: 'master', pane: 'install', runtime: 'codex', account: null, session: null }; } },
    personalMasterSession: scope => ({ launch: async handover => { handovers.set(scope.forPerson!, handover); return { agentName: scope.masterAgentName, pane: scope.forPerson!, runtime: 'codex', account: null, session: null }; } }),
  };
  await runCycle(config, state, effects);
  assert.deepEqual(new Set(dispatched), new Set(owned.map(item => item.key)));
  assert.equal(new Set((await store.list()).filter(item => owned.some(owned => owned.id === item.id)).map(item => item.lease?.owner)).size, 3, 'scopes reserve distinct worker profiles throughout a cycle');
  assert.equal(reviewTicks, 1, 'only the install dispatches reviews and proofs');
  assert.equal(state.cycle, 1, 'one loop owns all three dispatch scopes');
  for (const [person, item] of [['alice', owned[0]], ['bob', owned[1]], ['install', owned[2]]] as const) {
    assert.ok(handovers.get(person)?.includes(item.key), `${person} sees their own item`);
    for (const other of owned.filter(other => other.id !== item.id)) assert.ok(!handovers.get(person)?.includes(`${other.key}:`), `${person} does not see another owner's item`);
  }
  assert.equal(Object.keys(state.personalMasters).length, 2);
  // Running each scope itself against the same control plane also never borrows another scope.
  for (const person of ['alice', 'bob', undefined]) {
    const scope = { ...config, people: [], forPerson: person };
    await runCycle(scope, emptyDaemonState(scope), { ...effects, masterSession: undefined, dispatch: async () => { assert.fail('already claimed work must not dispatch again'); } });
  }
});

test('unit:masters-dispatch-owned-items the shared loop releases each scope\'s backlog once, while each scope dispatches only its own', async () => {
  const backlog = await Promise.all([create('alice'), create('bob'), create()]);
  const config = masterConfigSchema.parse({ version: 1, url: 'http://control-plane', credentialFile: '/tmp/unused-owner-test-token', cliPath: '/tmp/unused-cli', repository: 'owner/project', baseBranch: 'main', githubAppId: 0, hostId: 'test', masterAgentName: 'master', people: ['alice', 'bob'], workers: Array.from({ length: 12 }, (_, index) => ({ name: `w${index}`, principal: `w${index}`, agentName: `w${index}`, mode: 'launch', kind: 'codex', credentialFile: '/tmp/unused-worker-token' })) });
  const released: string[] = [];
  await runCycle(config, emptyDaemonState(config), {
    snapshot: async () => ({ work: await store.list(), now: new Date().toISOString() }),
    agents: () => [], closeSession: () => {}, persist: async () => {}, dispatch: async () => {},
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: false, reason: 'not under test' }])),
    release: async item => { released.push(item.key); },
  } as DaemonEffects);
  for (const item of backlog) assert.equal(released.filter(key => key === item.key).length, 1, `${item.key} is released once`);
});

test('unit:masters-dispatch-owned-items owner changes are transactional requirements, preserve criteria and append history', async () => {
  const item = await create('alice');
  const requirements = { expectedPolicyRevision: item.policyRevision, reason: 'Bob now owns this priority', criteria, dependencies: [], exclusiveResources: [], producerProofs: [] };
  const revised = await engine.execute(alice, 'requirements', item.id, { ...requirements, owner: 'bob' }, randomUUID());
  assert.equal(revised.owner, 'bob'); assert.deepEqual(revised.criteria.map(ac => ac.text), criteria.map(ac => ac.text));
  const events = (await store.pool.query("SELECT actor, payload FROM events WHERE work_id=$1 AND kind='requirements'", [item.id])).rows;
  assert.equal(events.length, 1); assert.equal(events[0].actor, 'alice'); assert.equal(events[0].payload.details.owner, 'bob');
  await assert.rejects(create('not-a-person'), /person principal/);
  await assert.rejects(engine.execute(alice, 'requirements', item.id, { ...requirements, expectedPolicyRevision: revised.policyRevision, owner: 'not-a-person' }, randomUUID()), /person principal/);
  assert.equal((await store.list()).find(work => work.id === item.id)?.owner, 'bob');
  const unowned = await engine.execute(alice, 'requirements', item.id, { ...requirements, expectedPolicyRevision: revised.policyRevision, owner: null }, randomUUID());
  assert.equal(unowned.owner, null);
});

test('unit:masters-dispatch-owned-items registry permits one live master per human owner and one install master', async () => {
  const { AgentRegistry } = await import('../src/agent-registry.js');
  const { proposedRuntimes } = await import('../src/model/registry.js');
  const registry = new AgentRegistry(store);
  await registry.mutate(alice, 'apply', {
    reason: 'Personal masters share the installed fleet', runtimes: [proposedRuntimes.find(runtime => runtime.name === 'codex')],
    models: [{ name: 'default', id: null, cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'strong', contextTokens: null, notes: 'Test default' } }],
    accounts: [{ name: 'shared', runtime: 'codex', model: 'default', credential: { host: 'test', home: null } }],
    roles: [{ name: 'master', accounts: ['shared'], concurrency: 1 }],
  }, randomUUID());
  for (const group of ['alice', 'bob', null]) {
    const selected = await registry.select(alice, { role: 'master', host: 'test', group }, randomUUID());
    assert.equal(selected.selected, true, `master for ${group ?? 'install'} gets its own slot`);
    assert.equal(selected.session?.group, group);
    const duplicate = await registry.select(alice, { role: 'master', host: 'test', group }, randomUUID());
    assert.equal(duplicate.selected, false, 'a second master in the same scope is refused');
  }
});
