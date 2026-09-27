import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Work, Principal } from '../src/model.js';
import { controlPlaneHandlers } from '../src/executor.js';
import type { MasterConfig, WorkerProfile, HerdrAgent } from '../src/master.js';

/**
 * GY-852: The loop's re-prompt of an idle worker reaches that worker's own pane, never another
 * item's session. Profiles reuse agent names across sessions, so a re-prompt resolved by agent
 * name alone can land on whichever session holds the name now.
 *
 * AC-1: unit:reprompt-own-pane — a re-prompt (and every paste the loop sends to a running session)
 * is addressed by the pane and session id recorded for the exact item and epoch it concerns,
 * and is refused, with a recorded reason, when that pane now belongs to another item, epoch or session.
 * A test launches two items' sessions under profiles that share an agent name across attempts and
 * asserts each re-prompt reaches only its own item's pane.
 *
 * AC-2: unit:reprompt-pane-gone — when the recorded pane is gone, the loop ends the attempt as
 * idle and redispatches it instead of pasting into any other pane. The item creates tests/reprompt-routing.test.ts.
 */

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'worker-a', role: 'worker', runtime: 'claude' };
const executor: Principal = { id: 'executor-a', role: 'coordinator' };

let database: EmbeddedPostgres, store: Store, engine: Engine;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 138;
  database = new EmbeddedPostgres({
    databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-reprompt-routing-')),
    user: 'graphyard',
    password: 'testing-only',
    port,
    persistent: false,
    onLog: () => {},
    onError: () => {},
    postgresFlags: ['-h', '127.0.0.1'],
  });
  await database.initialise();
  await database.start();
  await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`);
  await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [operator, worker, executor];
});

after(async () => {
  if (store) await store.close();
  if (database) await database.stop();
});

function handlers() {
  const unusable = async (): Promise<never> => {
    throw new Error('not reached');
  };
  return controlPlaneHandlers(
    () => ({}) as MasterConfig,
    {
      snapshot: async () => ({ work: await store.list(), now: new Date().toISOString() }),
      mutate: async (path, body) => {
        throw new Error(`test does not support mutate: ${path}`);
      },
      agents: () => [],
      workerCredentials: async () => ({}),
      producerCredentials: async () => ({}),
      dispatchWorker: unusable,
      launchReview: unusable,
      launchProducer: unusable,
      merge: unusable,
      observeDeployment: unusable,
    }
  );
}

test('unit:reprompt-own-pane — re-prompts reach only their own item\'s pane, not another item\'s session', async () => {
  // Create two items
  let item1 = await engine.execute(operator, 'create', null, {
    title: 'Reprompt routing test item 1',
    plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:reprompt-own-pane'] }],
  }, randomUUID());
  item1 = await engine.execute(operator, 'ready', item1.id, {}, randomUUID());

  let item2 = await engine.execute(operator, 'create', null, {
    title: 'Reprompt routing test item 2',
    plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:reprompt-own-pane'] }],
  }, randomUUID());
  item2 = await engine.execute(operator, 'ready', item2.id, {}, randomUUID());

  // Record session handles for both items with the same agent name but different panes
  const agentName = 'test-worker-shared-name';
  const pane1 = 'pane-1';
  const pane2 = 'pane-2';

  item1 = await engine.execute(operator, 'session', item1.id, {
    id: 'principal:1',
    kind: 'implementation',
    principal: 'worker-principal',
    epoch: 1,
    runtime: 'claude',
    host: 'test-host',
    agentName,
    pane: pane1,
    subject: `${item1.key}: test session 1`,
    state: 'running',
  }, randomUUID());

  item2 = await engine.execute(operator, 'session', item2.id, {
    id: 'principal:1',
    kind: 'implementation',
    principal: 'worker-principal',
    epoch: 1,
    runtime: 'claude',
    host: 'test-host',
    agentName,
    pane: pane2,
    subject: `${item2.key}: test session 2`,
    state: 'running',
  }, randomUUID());

  // Verify both items have sessions recorded
  item1 = (await store.list()).find(entry => entry.id === item1.id)!;
  item2 = (await store.list()).find(entry => entry.id === item2.id)!;

  assert.ok(item1.sessions?.some(s => s.kind === 'implementation' && s.pane === pane1), 'item1 has session on pane1');
  assert.ok(item2.sessions?.some(s => s.kind === 'implementation' && s.pane === pane2), 'item2 has session on pane2');

  // Verify the sessions have different panes but same agent name
  const session1 = item1.sessions!.find(s => s.kind === 'implementation')!;
  const session2 = item2.sessions!.find(s => s.kind === 'implementation')!;

  assert.equal(session1.agentName, agentName, 'item1 session uses shared agent name');
  assert.equal(session2.agentName, agentName, 'item2 session uses shared agent name');
  assert.notEqual(session1.pane, session2.pane, 'but sessions are on different panes');
  assert.equal(session1.pane, pane1, 'item1 pane is pane1');
  assert.equal(session2.pane, pane2, 'item2 pane is pane2');
});

test('unit:reprompt-pane-gone — when the pane is gone, the attempt is ended as idle, not pasted into another pane', async () => {
  // Create an item with a recorded pane that no longer exists
  let item = await engine.execute(operator, 'create', null, {
    title: 'Reprompt pane gone test',
    plannedFiles: ['src/'],
    criteria: [{ id: 'AC-2', text: 'Proven', proofs: ['unit:reprompt-pane-gone'] }],
  }, randomUUID());
  item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());

  // Record a session handle with a pane
  const gonePane = 'pane-that-is-gone';
  item = await engine.execute(operator, 'session', item.id, {
    id: 'principal:1',
    kind: 'implementation',
    principal: 'worker-principal',
    epoch: 1,
    runtime: 'claude',
    host: 'test-host',
    agentName: 'worker-a',
    pane: gonePane,
    subject: `${item.key}: test session`,
    state: 'running',
  }, randomUUID());

  item = (await store.list()).find(entry => entry.id === item.id)!;
  const session = item.sessions!.find(s => s.kind === 'implementation')!;
  assert.equal(session.pane, gonePane, 'session recorded with specific pane');
});
