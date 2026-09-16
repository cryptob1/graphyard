import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { classifyIntake, defaultDelegationLimits, delegationSnapshot, mergeOrder, recordIntake, recordLeadRuling, recordLeadViolation, validateDelegationPrincipals } from '../src/delegation.js';
import { Engine } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';
import { Store } from '../src/store.js';

const admin: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const lead: Principal = { id: 'product-lead', role: 'slice-lead', slice: 'product', sessionKind: 'ai' };
const workerA: Principal = { id: 'engineer-a', role: 'worker', sessionKind: 'ai' };
const workerB: Principal = { id: 'engineer-b', role: 'worker', sessionKind: 'ai' };
const workerC: Principal = { id: 'engineer-c', role: 'worker', sessionKind: 'ai' };
let database: EmbeddedPostgres, store: Store, engine: Engine;
const input = (title: string, slice: Work['slice'] = 'product') => ({ title, slice, plannedFiles: [`src/${title}.ts`], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }] });

before(async () => {
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-delegation-')), user: 'graphyard', password: 'testing-only', port: 15448, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('delegation_test');
  store = new Store('postgres://graphyard:testing-only@127.0.0.1:15448/delegation_test'); await store.init(); engine = new Engine(store);
});
after(async () => { await store?.close(); await database?.stop(); });

test('formal slices and principal boundaries are explicit', () => {
  const principals: Principal[] = [admin, lead, { id: 'infra-lead', role: 'slice-lead', slice: 'infrastructure', sessionKind: 'ai' }, { id: 'docs-lead', role: 'slice-lead', slice: 'docs-experience', sessionKind: 'ai' }];
  validateDelegationPrincipals(principals);
  const snapshot = delegationSnapshot(principals, [], Date.now());
  assert.deepEqual(snapshot.slices.map(s => s.id), ['product', 'infrastructure', 'docs-experience']);
  assert.deepEqual(snapshot.limits, defaultDelegationLimits);
  assert.throws(() => validateDelegationPrincipals([...principals, { id: 'extra', role: 'slice-lead', slice: 'product', sessionKind: 'ai' }]), /limit exceeded/);
  assert.throws(() => validateDelegationPrincipals([{ id: 'human-lead', role: 'slice-lead', slice: 'product', sessionKind: 'human' }]), /AI sessions/);
});

test('routine intake reaches backlog while AI human-only decisions are refused', async () => {
  assert.equal(classifyIntake('defect'), 'routine'); assert.equal(classifyIntake('waiver'), 'human-only');
  const item = await recordIntake(store, lead, { origin: 'verification-finding', title: 'Broken acceptance path', description: 'Observed by validation' });
  assert.equal(item.state, 'backlog');
  await assert.rejects(recordIntake(store, lead, { origin: 'priority', title: 'Make this P0', description: '' }), /human-only/);
  const human = await recordIntake(store, admin, { origin: 'goal', title: 'New product goal', description: '' });
  assert.equal(human.state, 'backlog');
});

test('lead rulings require citations and reasons, stay in-slice, and append immutable history', async () => {
  let item = await engine.execute(admin, 'create', null, input('plan'), randomUUID());
  await assert.rejects(recordLeadRuling(store, lead, item.id, { action: 'approve-plan', ruleId: '', reason: 'looks good' }));
  const result = await recordLeadRuling(store, lead, item.id, { action: 'approve-plan', ruleId: 'rules/plan-v1#approval', reason: 'Plan satisfies the written scope' });
  assert.equal(result.ruling.leadId, lead.id);
  const rows = await store.pool.query('SELECT * FROM lead_rulings WHERE work_id=$1', [item.id]);
  assert.equal(rows.rowCount, 1); assert.equal(rows.rows[0].rule_id, 'rules/plan-v1#approval');
  await assert.rejects(store.pool.query('DELETE FROM lead_rulings WHERE id=$1', [rows.rows[0].id]), /append-only/);
  item = await engine.execute(admin, 'create', null, input('infra', 'infrastructure'), randomUUID());
  await assert.rejects(recordLeadRuling(store, lead, item.id, { action: 'send-back', ruleId: 'rules/x', reason: 'wrong slice' }), /own slice/);
  await assert.rejects(engine.execute(lead, 'claim', item.id, {}, randomUUID()), /Worker permission/);
  await assert.rejects(engine.execute(lead, 'evidence', item.id, { proof: 'unit:works', sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 1, result: 'pass', executed: 1, skipped: 0 }, randomUUID()), /not permitted/);
  await recordLeadViolation(store, lead, item.id, 'claim');
  assert.equal((await store.events(item.id))[0].kind, 'lead.action.refused');
});

test('server enforces two active engineers per lead slice', async () => {
  const items = [];
  for (const name of ['one', 'two', 'three']) { let item = await engine.execute(admin, 'create', null, input(name), randomUUID()); item = await engine.execute(admin, 'ready', item.id, {}, randomUUID()); items.push(item); }
  await engine.execute(workerA, 'claim', items[0].id, {}, randomUUID());
  await engine.execute(workerB, 'claim', items[1].id, {}, randomUUID());
  await assert.rejects(engine.execute(workerC, 'claim', items[2].id, {}, randomUUID()), /Engineer limit for product exceeded: 2\/2/);
});

test('merge ordering follows dependencies and current conflicts, not registration order', () => {
  const work = (id: string, overrides: Partial<Work> = {}) => ({ id, key: id, stage: 'merge', priority: 2, dependencies: [], plannedFiles: [], workspaces: [], evidence: [], criteria: [], scenarioRequirements: [], gates: [], violations: [], lease: null, submission: null, ready: true, ...overrides }) as unknown as Work;
  const dependency = work('GY-2', { stage: 'done' });
  const laterReady = work('GY-9', { dependencies: [dependency.id], priority: 0 });
  const conflicted = work('GY-1', { plannedFiles: ['src/shared/'] });
  const peer = work('GY-3', { plannedFiles: ['src/shared/file.ts'], stage: 'build', lease: { owner: 'x', epoch: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() } });
  const order = mergeOrder([conflicted, dependency, peer, laterReady]);
  assert.equal(order[0], 'GY-9');
  assert.ok(order.indexOf('GY-1') > order.indexOf('GY-9'));
});
