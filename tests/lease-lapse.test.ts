import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Each test is named for the proof it produces, so acceptance evidence maps to
// one executed case per required proof.
const human: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const master: Principal = { id: 'master-admin', role: 'admin', sessionKind: 'ai' };
const worker: Principal = { id: 'engineer-a', role: 'worker', sessionKind: 'ai' };
const replacement: Principal = { id: 'engineer-b', role: 'worker', sessionKind: 'ai' };
let database: EmbeddedPostgres, store: Store, engine: Engine, expiring: Engine;
const id = () => randomUUID();
const input = (title: string) => ({ title, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }] });
const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
const events = async (work: Work, kind: string) => (await store.events(work.id)).filter(event => event.kind === kind);
const merge = (work: Work) => work.gates.find(gate => gate.name === 'merge')!;

before(async () => {
  const port = Number(process.env.GRAPHYARD_LEASE_LAPSE_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 14);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('lease-lapse'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, 120, 'owner/project');
  engine.principals = [human, master, worker, replacement];
  // Leases granted by this engine expire at once, so reconciliation sees the lapse.
  expiring = new Engine(store, 0, 'owner/project'); expiring.principals = engine.principals;
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

// A claim through the expiring engine has already lapsed by the time a workspace could be
// registered, so that attempt is left without one, as a supervisor that never started leaves it.
async function claimed(title: string, by: Engine = engine, actor: Principal = worker) {
  let work = await engine.execute(human, 'create', null, input(title), id());
  work = await engine.execute(human, 'ready', work.id, {}, id());
  work = await by.execute(actor, 'claim', work.id, {}, id());
  if (by !== engine) return work;
  return engine.execute(actor, 'workspace', work.id, { epoch: work.epoch, host: 'lapse-host', path: `/tmp/lapse/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, id());
}
// Rewrite the stored document with the lease still on the record past its expiry.
async function overwrite(work: Work, mutate: (document: Work) => void) {
  const document = await reload(work); mutate(document);
  await store.pool.query('UPDATE work_items SET document=$2::jsonb WHERE id=$1', [document.id, JSON.stringify(document)]);
  return document;
}
const lapse = (work: Work, epoch: number) => overwrite(work, document => { document.lease = { owner: worker.id, epoch, expiresAt: '2000-01-01T00:00:00Z' }; });

test('integration:lease-lapse-no-escalation: a lapsed lease is recorded as lease.expired and ends the attempt; nothing escalates and the item is claimable again', async () => {
  // A blocked report ends its attempt and releases the lease in the same transaction (GY-1008): nothing is left to lapse.
  let blocked = await claimed('lapse-after-blocked');
  blocked = await engine.execute(worker, 'blocked', blocked.id, { epoch: blocked.epoch, reason: 'plannedFiles cannot cover src/server/index.ts' }, id());
  assert.equal(blocked.lease, null, 'the blocked report released the lease');
  await engine.reconcile();
  assert.equal((await events(await reload(blocked), 'lease.expired')).length, 0, 'no lapse: the attempt ended on the record');

  // A rework while the lease is live discards it: its end is history with the rework as its cause.
  let reworked = await claimed('lapse-after-rework-live');
  const liveEpoch = reworked.epoch;
  reworked = await engine.execute(master, 'rework', reworked.id, { reason: 'Stopped the session to re-dispatch', previousWorkerStopped: true }, id());
  assert.equal(reworked.lease, null);
  assert.deepEqual((await events(reworked, 'lease.expired')).map(event => [event.payload.details.epoch, event.payload.details.cause]), [[liveEpoch, 'rework']]);

  // A silent lapse ends the attempt on reconcile: recorded once, no escalation, and another worker claims a fresh epoch.
  let vanished = await claimed('lapse-silent', expiring);
  const vanishedEpoch = vanished.epoch;
  await engine.reconcile();
  vanished = await reload(vanished);
  assert.equal(vanished.lease, null);
  assert.deepEqual((await events(vanished, 'lease.expired')).map(event => event.payload.details.epoch), [vanishedEpoch], 'the lapse is history');
  assert.equal(merge(vanished).reasons.some(reason => /lease-loss/.test(reason)), false, 'nothing escalates');
  await engine.reconcile();
  assert.equal((await events(vanished, 'lease.expired')).length, 1, 'recorded once');
  vanished = await engine.execute(replacement, 'claim', vanished.id, {}, id());
  assert.equal(vanished.epoch, vanishedEpoch + 1);
  assert.equal(vanished.lease!.owner, replacement.id);

  // A replacement claim over a lapsed lease records how that assignment ended, as reconciliation would.
  let replaced = await claimed('lapse-replaced');
  const replacedEpoch = replaced.epoch;
  await lapse(replaced, replacedEpoch);
  replaced = await engine.execute(replacement, 'claim', replaced.id, {}, id());
  assert.equal(replaced.lease!.owner, replacement.id);
  assert.deepEqual((await events(replaced, 'lease.expired')).map(event => event.payload.details.epoch), [replacedEpoch]);
});
