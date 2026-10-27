import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { isClosed, type Principal, type Work } from '../src/model.js';
import * as model from '../src/model.js';
import type { Services } from '../src/server/routes.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// GY-1694/GY-1799: the 2026-10-13 instants are the fixture's own clock, judged against the explicit `now` below: the daemon cycle is handed that `now`, and the delivered-observation close reads its clock from the fixture-clocked store the test hands it (src/server/close.ts judges the worker lease against the transaction's `now`), so nothing judges the fixture against the wall clock and the file holds no wall-clock reading to allow.

const hour = 3_600_000, now = Date.parse('2026-10-13T12:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const filed = sha('a'), serving = sha('b'), mergeSha = sha('c');
const parentId = '11111111-1111-4111-8111-111111111111';
const proof = 'manual:post-deploy/webhook-deliveries-clean-24h', own = 'manual:webhook-deliveries-clean-24h-on-serving-release';
const base = (n: number, extra: Partial<Work> = {}): Work => ({
  id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`, key: `GY-${n}`, title: `Item ${n}`, description: '', type: 'chore', priority: 1, stage: 'ready', ready: true, epoch: 0, revision: 3, policyRevision: 1,
  createdAt: iso(now - 30 * hour), updatedAt: iso(now - 2 * hour), stageEnteredAt: iso(now - 2 * hour), lease: null, lastAssignment: null, systemDriven: true, implementers: [],
  workspaces: [], sessions: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], criteria: [], 
  policy: { checks: ['test', 'typecheck'], review: true }, dependencies: [],
  gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }],
  ...extra,
}) as unknown as Work;
const parent = base(1700, { id: parentId, stage: 'done', ready: true, criteria: [{ id: 'AC-2', text: 'A 24-hour window of live GitHub activity shows zero failed webhook deliveries', proofs: [proof] }],
  delivery: { mergeSha, mergedAt: iso(now - 40 * hour), deployment: { sha: filed, mergeSha, source: 'endpoint', observedAt: iso(now - 30 * hour), covers: 'descendant', at: iso(now - 30 * hour), observer: 'graphyard-master' } } } as Partial<Work>);
/** A follow-up the filer filed for `parent` AC-2 on the filed release, window closed an hour ago. */
const followUp = (n: number, extra: Partial<Work> = {}) => base(n, { description: `Post-deploy follow-up: post-deploy:${parentId}:AC-2:${proof}:${filed}\n\nowed`,
  criteria: [{ id: 'AC-1', text: `From this head against the serving release ${filed.slice(0, 12)} that carries GY-1700's merge: zero failed webhook deliveries over 24 hours`, proofs: [own] }],
  observationWindow: { notBefore: iso(now - hour), basis: 'criterion-window', detail: 'the 24-hour live window ran' }, ...extra });

// GY-1779: against a real Postgres, the coordinator's `reading`
// command records the trusted evidence loopObservation binds to a later serving release, refuses a
// reading of anything else, and closing as delivered-observation closes the superseded pull request.
const repository = 'owner/loop-readings';
const operator: Principal = { id: 'readings-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'readings-master', role: 'coordinator', sessionKind: 'ai', proofs: ['manual:*'] };
const worker: Principal = { id: 'readings-worker', role: 'worker', sessionKind: 'ai' };
let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1790;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('loop-readings-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('readings_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/readings_test`); await store.init();
  engine = new Engine(store, 300, repository); engine.submissionObserver = null;
});
after(async () => { await store?.close(); await database?.stop(); });
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
/** An item created through the engine, then written as the control plane would have left it: the fixture for what the reading binds to. */
async function plant(shape: Work): Promise<Work> {
  const created = await engine.execute(operator, 'create', null, { type: 'chore',  title: shape.title, criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:readings'] }] }, randomUUID()) as Work;
  const { id, key, ...rest } = shape;
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [created.id, JSON.stringify({ ...created, ...rest, id: created.id, key: created.key })]);
  return reload(created.id);
}

/** GY-1799: the close path's services with the store's clock replaced — every transaction the close opens (src/server/close.ts judges the worker lease against the transaction's `now`) is handed the fixture's `now`, so the live-lease refusal is judged against the fixture's own clock, never the database's wall clock. */
function clockedServices(): Services {
  const clocked = Object.assign(Object.create(engine), { store: Object.assign(Object.create(store), {
    transaction: (fn: Parameters<Store['transaction']>[0], options?: Parameters<Store['transaction']>[1]) => store.transaction((db, at) => fn(db, new Date(now)), options),
  }) as Store });
  return { engine: clocked, repository, principals: [] } as unknown as Services;
}

test('integration:loop-records-due-observation-reading — the coordinator records the reading as trusted evidence bound to the serving release, refuses one off the parent\'s merge or on another item, and and the delivered-observation close closes the item, touching no pull request', async () => {
  const { loopObservation } = model as unknown as { loopObservation: (work: Work, at: Date, all: Work[]) => { due: boolean } | null };
  const delivered = await plant(parent);
  const item = await plant({ ...followUp(0, { stage: 'build', epoch: 2, candidate: { pr: 1172, sha: sha('d'), baseSha: sha('e'), author: 'bot', branch: 'graphyard/gy-x-2', createdAt: iso(now - hour) } } as Partial<Work>), description: `Post-deploy follow-up: post-deploy:${delivered.id}:AC-2:${proof}:${filed}\n\nowed` } as Work);
  const code = await plant(base(0, { criteria: [{ id: 'AC-1', text: 'Code', proofs: ['unit:code'] }] }));
  const reading = { proof: own, sha: serving, baseSha: mergeSha, policyRevision: 1, result: 'pass' as const, detail: 'the advanced delivery log shows 0 failed deliveries in 24 hours' };
  await assert.rejects(engine.execute(worker, 'reading', item.id, reading, randomUUID()), /Coordinator permission required/);
  // GY-2876: no admin records a trusted reading, with or without a roster pattern for the proof.
  for (const admin of [operator, { ...operator, proofs: ['manual:*'] }]) await assert.rejects(engine.execute(admin, 'reading', item.id, reading, randomUUID()), /only the loop records a reading/);
  // A coordinator without a roster pattern for the proof is refused; the loop's, with one, records it below.
  await assert.rejects(engine.execute({ ...coordinator, proofs: undefined }, 'reading', item.id, reading, randomUUID()), /no roster --proof pattern for manual:/);
  await assert.rejects(engine.execute(coordinator, 'reading', code.id, { ...reading, proof: 'unit:code' }, randomUUID()), /not a loop-owned observation item/);
  await assert.rejects(engine.execute(coordinator, 'reading', item.id, { ...reading, baseSha: sha('f') }, randomUUID()), /bound to the parent delivery's merge/);
  const { closeWork } = await import('../src/server/close.js');
  const services = clockedServices();
  const close = (principal: Principal, id: string, ref: string | null = serving) => closeWork(services, principal, id, { kind: 'delivered-observation', reason: 'read', ref }, randomUUID());
  // No reading yet: the close is refused. A worker never closes; neither does the kind close a code item.
  await assert.rejects(close(coordinator, item.id), /carries no passing reading of manual:webhook-deliveries-clean-24h-on-serving-release as the loop reads one/);
  await assert.rejects(close(worker, item.id), /Only the master \(coordinator or operator agent\) or an admin may close work/);
  await assert.rejects(close(coordinator, code.id), /is not a loop-owned observation item/);
  // Only a failed reading: still refused.
  await engine.execute(coordinator, 'reading', item.id, { ...reading, result: 'fail', detail: '2 failed deliveries' }, randomUUID());
  await assert.rejects(close(coordinator, item.id), /carries no passing reading/);
  const read = await engine.execute(coordinator, 'reading', item.id, reading, randomUUID()) as Work;
  const entry = read.evidence.at(-1)!;
  assert.deepEqual([entry.trusted, entry.producer, entry.sha, entry.baseSha, entry.result, entry.reading], [true, coordinator.id, serving, mergeSha, 'pass', { detail: reading.detail }]);
  assert.equal(loopObservation(read, new Date(now), [delivered]), null, 'the loop\'s reading on the later serving release ends the wait');
  // The pass is on the serving release: a close naming another release, or none, is refused.
  await assert.rejects(close(coordinator, item.id, null), /names the release its reading was taken on/);
  await assert.rejects(close(coordinator, item.id, filed), /passing reading was taken on release bbbbbbbbbbbb, not aaaaaaaaaaaa/);
  // A live worker lease does not hold the close: the closure ends it.
  const leased = await plant({ ...followUp(0, { stage: 'build', epoch: 2, lease: { owner: worker.id, epoch: 2, expiresAt: iso(now + 24 * hour) }, candidate: { pr: 1174, sha: sha('d'), baseSha: sha('e'), author: 'bot', branch: 'graphyard/gy-y-2', createdAt: iso(now - hour) }, evidence: [{ ...entry, id: randomUUID() }] } as Partial<Work>), description: `Post-deploy follow-up: post-deploy:${delivered.id}:AC-2:${proof}:${filed}\n\nowed` } as Work);
  assert.equal(((await close(coordinator, leased.id)) as Work).lease, null);
  // The close as delivered-observation closes the item on the reading; since GY-2010 no pull request is touched or recorded.
  const closed = await closeWork(services, coordinator, item.id, { kind: 'delivered-observation', reason: `${read.key}'s reading passed on the serving release`, ref: serving }, randomUUID()) as Work;
  assert.deepEqual([closed.stage, closed.closure?.kind, closed.closure?.ref, closed.closure?.by, isClosed(closed)], ['done', 'delivered-observation', serving, coordinator.id, true]);
  const audit = (await store.pool.query("SELECT payload FROM events WHERE work_id=$1 AND kind='work.closed'", [item.id])).rows[0].payload;
  assert.equal(audit.details.pullRequest, undefined, 'the closure records no pull request');
  assert.equal(closed.closure?.pullRequest, undefined);
  assert.equal((await store.pool.query("SELECT 1 FROM events WHERE work_id=$1 AND kind='work.pull-request-closed'", [item.id])).rowCount, 0);
});
