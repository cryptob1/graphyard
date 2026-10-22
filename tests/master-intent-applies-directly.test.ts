import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';
import { appliedReworkBrief } from '../src/master/rework-brief.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2874: the master applies intent with its own identity at once, and a lapsed lease ends the attempt.
const operator: Principal = { id: 'operator', role: 'admin' };
const master: Principal = { id: 'graphyard-master-project-operator', role: 'operator-agent', scope: { repositories: ['owner/project'], workItems: ['*'] } };
const first: Principal = { id: 'worker-one', role: 'worker' };
const second: Principal = { id: 'worker-two', role: 'worker' };
let pg: EmbeddedPostgres, store: Store, engine: Engine;
const id = () => randomUUID();

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 111;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('master-intent'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('master_intent_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/master_intent_test`); await store.init();
  // A one-second lease, so the lapse is real time and not a fixture.
  engine = new Engine(store, 1, 'owner/project');
  engine.operatorAuthorizer = async (_db, _now, actor) => actor;
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });

const criteria = [{ id: 'AC-1', text: 'The first behaviour holds', proofs: ['unit:first'] }, { id: 'AC-2', text: 'The second behaviour holds', proofs: ['unit:second'] }];
const create = (title: string) => engine.execute(operator, 'create', null, { title, type: 'chore', priority: 2, criteria, dependencies: [], policy: { checks: ['test'], review: true } }, id());
const events = async (work: Work) => (await store.pool.query('SELECT kind, payload FROM events WHERE work_id=$1 ORDER BY seq', [work.id])).rows as { kind: string; payload: unknown }[];
const retired = /^(decision|escalation|quarantine|launch|settle|autosettle|recover|resolve)\b/;

test('unit:master-intent-applies-directly — the master rewrites requirements with its own identity, applied at once with one history event and nothing pending', async () => {
  const work = await create('A requirements rewrite');
  const before = (await events(work)).length;
  // A rewrite that retires AC-2 and rewords AC-1: once an approver's decision, now the master's own intent.
  const revised = await engine.execute(master, 'requirements', work.id, { expectedPolicyRevision: work.policyRevision, reason: 'The second behaviour moved to another item',
    criteria: [{ id: 'AC-1', text: 'The first behaviour holds, reworded', proofs: ['unit:first'] }], dependencies: [], exclusiveResources: [], producerProofs: [] }, id());
  assert.equal(revised.policyRevision, work.policyRevision + 1, 'the revision is applied in the same request');
  assert.deepEqual(revised.criteria.map(criterion => [criterion.id, criterion.text]), [['AC-1', 'The first behaviour holds, reworded']]);
  assert.deepEqual(revised.retiredCriterionIds, ['AC-2']);
  const added = (await events(work)).slice(before);
  assert.deepEqual(added.map(event => event.kind), ['requirements'], 'exactly one history event records the rewrite');
  const stored = (await store.list()).find(item => item.id === work.id)! as Work & Record<string, unknown>;
  assert.equal(stored.policyRevision, revised.policyRevision);
  for (const field of ['escalation', 'escalations', 'containmentQuarantine']) assert.equal(field in stored, false, `no ${field} on the item`);
  assert.equal(stored.blocker, null, 'nothing waits on the rewrite');
  assert.ok(!(await events(work)).some(event => retired.test(event.kind)), 'no decision, approver or escalation record in its history');
});

test('unit:master-intent-applies-directly — a master rework applies at once and records the reason the next round is briefed with', async () => {
  let work = await create('A rework');
  work = await engine.execute(operator, 'ready', work.id, {}, id());
  const before = (await events(work)).length;
  const reworked = await engine.execute(master, 'rework', work.id, { reason: 'The review named a missing guard', previousWorkerStopped: true }, id());
  assert.equal(reworked.reworkRequested, true);
  assert.equal(reworked.lastRework?.reason, 'The review named a missing guard');
  assert.deepEqual((await events(work)).slice(before).map(event => event.kind), ['rework'], 'exactly one history event records the rework');
  assert.deepEqual(appliedReworkBrief({ ...reworked, submission: { epoch: 1, pr: 1 } as Work['submission'], pipeline: undefined }), { reason: 'The review named a missing guard', at: reworked.lastRework!.at });
});

test('unit:lapsed-lease-is-claimable — a lapsed lease ends the attempt and the item is claimable on the next cycle, with no containment, escalation or decision', async () => {
  let work = await create('A lease that lapses');
  work = await engine.execute(operator, 'ready', work.id, {}, id());
  work = await engine.execute(first, 'claim', work.id, {}, id());
  assert.equal(work.lease?.owner, first.id);
  // The worker vanishes: nothing renews the lease.
  await delay(1_500);
  await engine.reconcile();
  const lapsed = (await store.list()).find(item => item.id === work.id)! as Work & Record<string, unknown>;
  assert.equal(lapsed.lease, null, 'the lapse ended the attempt');
  assert.equal(lapsed.nextAction?.kind, 'dispatch', 'the next cycle offers the item for a fresh attempt');
  for (const field of ['escalation', 'escalations', 'containmentQuarantine']) assert.equal(field in lapsed, false, `no ${field} on the item`);
  const claimed = await engine.execute(second, 'claim', work.id, {}, id());
  assert.equal(claimed.lease?.owner, second.id, 'another worker claims it');
  assert.equal(claimed.epoch, work.epoch + 1);
  const history = await events(work);
  assert.ok(history.some(event => event.kind === 'lease.expired'), 'the lapse is recorded as the attempt ending');
  assert.ok(!history.some(event => retired.test(event.kind)), 'no containment, escalation or decision event in its history');
});
