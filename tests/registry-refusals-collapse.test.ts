import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from './helpers/warm-postgres.js';
import { Store } from '../src/store.js';
import { AgentRegistry } from '../src/agent-registry.js';
import type { Principal } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-3095 AC-3: on 2026-11-04 the loop asked the registry for two launches every cycle, each refused
 * for its own unchanged reason; because each refusal differed from the one before it, both were
 * appended every cycle, and all 100 of history's newest entries were those two refusals. Identical
 * consecutive refusals of one request are now one entry with a count and last-seen time.
 */

const operator: Principal = { id: 'operator', role: 'admin' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const HOST = 'machine-a';
let pg: EmbeddedPostgres, store: Store, registry: AgentRegistry;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 3095;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('refusals-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('refusals_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/refusals_test`); await store.init();
  registry = new AgentRegistry(store);
});
after(async () => { await store?.close(); await pg?.stop(); });

const select = (role: string, work: string) => registry.select(coordinator, { role, host: HOST, work }, randomUUID());

test('integration:registry-refusals-collapse — identical consecutive refusals are one history entry with a count and last-seen time; a different refusal starts a new one', async () => {
  // A worker role that names no account, and no reviewer role at all: two requests refused for two reasons.
  await registry.mutate(operator, 'role.set', { role: { name: 'worker', accounts: [], concurrency: 2 }, reason: 'no worker accounts yet' }, randomUUID());
  for (let cycle = 0; cycle < 6; cycle++) {
    assert.equal((await select('worker', 'GY-1')).selected, false);
    assert.equal((await select('reviewer', 'GY-2')).selected, false);
  }
  let history = await registry.history(operator, 100);
  const refused = history.filter(entry => entry.kind === 'refused');
  assert.equal(refused.length, 2, 'six cycles of two alternating refusals are two entries');
  const [reviewer, worker] = refused;
  assert.equal(worker.change.refusal.reason, 'role worker names no account');
  assert.equal(reviewer.change.refusal.reason, 'role reviewer is not configured in the agent registry');
  for (const entry of refused) {
    assert.equal(entry.count, 6, `${entry.change.refusal.role} carries its count`);
    assert.ok(Date.parse(entry.lastSeenAt!) > Date.parse(entry.at), `${entry.change.refusal.role} carries when it was last seen`);
  }
  assert.equal(history[2].kind, 'role.set', 'the real change stays among the newest entries');

  // A different refusal of the same request starts a new entry, counted from one.
  await registry.mutate(operator, 'role.remove', { name: 'worker', reason: 'retire the worker role' }, randomUUID());
  await select('worker', 'GY-1');
  await select('worker', 'GY-1');
  history = await registry.history(operator, 100);
  assert.equal(history[0].kind, 'refused');
  assert.equal(history[0].change.refusal.reason, 'role worker is not configured in the agent registry');
  assert.equal(history[0].count, 2);
  assert.equal(history[1].kind, 'role.remove');
  assert.equal(history.filter(entry => entry.kind === 'refused').length, 3);
});
