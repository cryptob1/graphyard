import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { answerHumanDecision, listHumanRequests, requestHumanDecision } from '../src/server/waits.js';
import { buildBoard } from '../src/model/board.js';
import { blockerSummary } from '../src/model/plain-status.js';
import type { Services } from '../src/server/routes.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-2875 AC-2: a blocker is plain text. The worker or master sets and clears it; nothing probes or
 * classifies it. Parking a decision only a human may make still records the request the human
 * requests surface lists, and the answer resumes the item.
 */
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker' };
let pg: EmbeddedPostgres, store: Store, engine: Engine, services: Services;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 2876;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('blocker-plain-text-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('blocker_plain_text');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/blocker_plain_text`); await store.init();
  engine = new Engine(store, 120, 'owner/project'); engine.submissionObserver = null; engine.directMergeEnvironment = null;
  services = { engine, repository: 'owner/project', principals: [] } as unknown as Services;
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });

async function claimed(title: string) {
  let w = await engine.execute(operator, 'create', null, { title, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:blocker-is-plain-text'] }] }, randomUUID());
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID());
  const pulled = await engine.pullAssignment(worker, { work: w.id }, randomUUID());
  assert.equal(pulled.assigned?.id, w.id, JSON.stringify(pulled.refused));
  return pulled.assigned!;
}
const derived = ['blockerProbe', 'blockerClass', 'class', 'kind', 'probe'];

test('unit:blocker-is-plain-text — blocked sets the item\'s blocker as that string with nothing derived from it, and unblock leaves the item claimable', async () => {
  const w = await claimed('Blocked');
  const reason = 'git push failed: Permission denied (publickey) for https://github.com/owner/project';
  const blocked = await engine.execute(worker, 'blocked', w.id, { epoch: w.epoch, reason }, randomUUID());
  assert.equal(blocked.blocker, reason, 'the blocker is the worker\'s own string');
  assert.equal(typeof blocked.blocker, 'string');
  for (const field of derived) assert.equal(field in blocked, false, `no ${field} is derived from it`);
  assert.equal(blocked.humanRequest ?? null, null, 'no human request is derived from it');
  assert.equal(blocked.lease, null, 'the blocked attempt holds no lease');
  // The board shows it as one sentence and nothing else: no class, kind or probe.
  const row = buildBoard([blocked], Date.now()).groups.blocked.find(entry => entry.key === blocked.key)!;
  assert.deepEqual(Object.keys(row.blocker!).sort(), ['summary']);
  assert.equal(row.command, `graphyard master unblock ${blocked.key} REASON`, 'the master clears it');
  assert.equal(blockerSummary(reason, Date.now()).kind, 'fault');
  // Still blocked, the item is not claimable.
  const refused = await engine.pullAssignment(worker, { work: w.id }, randomUUID());
  assert.equal(refused.assigned, null, 'a blocked item is not claimed');
  const cleared = await engine.execute(operator, 'unblock', w.id, { reason: 'Credential fixed', expectedRevision: blocked.revision }, randomUUID());
  assert.equal(cleared.blocker, null);
  const again = await engine.pullAssignment(worker, { work: w.id }, randomUUID());
  assert.equal(again.assigned?.id, w.id, `the unblocked item is claimable: ${JSON.stringify(again.refused)}`);
});

test('unit:blocker-is-plain-text — park with a human-only kind records the request human-requests lists, and answer resumes it', async () => {
  const w = await claimed('Parked');
  const parked = await requestHumanDecision(services, worker, w.id, { epoch: w.epoch, kind: 'money-or-accounts', needed: 'A paid plan on the error-tracking vendor', reason: 'The integration needs a paid plan',
    ask: 'Upgrade the error-tracking account to the paid plan.', recommendation: 'The smallest paid plan', why: 'The free plan has no API access.' }, randomUUID()) as Work;
  assert.equal(parked.humanRequest?.kind, 'money-or-accounts');
  assert.equal(parked.lease, null, 'parking ends the lease');
  const listed = await listHumanRequests(services, operator);
  const row = listed.requests.find(entry => entry.id === w.id);
  assert.ok(row, 'human-requests lists the parked request');
  assert.equal(row!.request.id, parked.humanRequest!.id);
  const answered = await answerHumanDecision(services, operator, w.id, { request: parked.humanRequest!.id, answer: 'Upgraded to the smallest paid plan' }, randomUUID()) as Work;
  assert.equal(answered.humanRequest, null);
  assert.equal(answered.blocker, null, 'a provided answer clears the park');
  assert.equal(answered.humanRequests?.at(-1)?.answer?.outcome, 'provided');
  assert.ok(!(await listHumanRequests(services, operator)).requests.some(entry => entry.id === w.id), 'nothing is waiting on the human any more');
  const resumed = await engine.pullAssignment(worker, { work: w.id }, randomUUID());
  assert.equal(resumed.assigned?.id, w.id, `the answered item is claimable: ${JSON.stringify(resumed.refused)}`);
});
