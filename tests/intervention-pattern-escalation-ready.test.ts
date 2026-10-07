import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { routineDecision, withheldDecision } from '../src/master-daemon.js';
import { foldInterventions, readInterventionLedger } from '../src/interventions.js';
import { endedLeaseLoss, leaseLossReason, leaseLossSettleMs, settleableLeaseLoss, standingEscalations, type Escalation, type Principal, type Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1393 names this file for its proof: manual:intervention-pattern-escalation-ready. Between
// 2026-09-30 and 2026-10-07 the intervention report counted 28 escalation interventions at the
// ready stage. Every one was a `lease-loss` the control plane raised (actor `graphyard`) when a
// worker's lease lapsed unexplained, and every one was resolved by the loop's two-party resolve
// (graphyard-master-graphyard-operator, approved by graphyard-approver-graphyard) on grounds the
// record alone held: "A newer attempt superseded it: epoch N is held by …, and no containment
// fence stands", "No newer attempt holds the item … holds no lease and no containment fence", or,
// for GY-1373/1374/1375, later attempts granted and expired with the item now holding no lease and
// no fence. Each approver round waited 3 to 229 minutes to confirm facts the control plane already
// had. Reconciliation now settles such a lease-loss itself once it has stood `leaseLossSettleMs`,
// and the loop no longer asks for the resolve.
//
// Each class is replayed below from the record the resolution cited.

const lost = (owner: string, epoch: number, at: string): Escalation => ({ trigger: 'lease-loss', reason: leaseLossReason({ owner, epoch }), at, actor: 'graphyard' });
const after5 = (at: string) => Date.parse(at) + leaseLossSettleMs;
function item(key: string, escalation: Escalation, overrides: Partial<Work>): Work {
  return {
    id: `work-${key}`, key, title: key, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'build', revision: 9, policyRevision: 1,
    createdAt: escalation.at, updatedAt: escalation.at, stageEnteredAt: escalation.at, ready: true, epoch: 1, lease: null, workspaces: [],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [], containmentQuarantine: null, escalation, escalations: [escalation], ...overrides,
  } as unknown as Work;
}

const instances = [
  { name: 'GY-1376 epoch 1, superseded by epoch 3 held by graphyard-claude-2', cause: 'superseded', evidence: /epoch 3 is held by graphyard-claude-2/,
    work: () => { const escalation = lost('graphyard-claude-1', 1, '2026-10-06T14:42:49.895Z'); return item('GY-1376', escalation, { epoch: 3, lease: { owner: 'graphyard-claude-2', epoch: 3, expiresAt: '2026-10-06T18:30:00.000Z' } }); } },
  { name: 'GY-1181 epoch 3, superseded by epoch 4 held by graphyard-claude-1', cause: 'superseded', evidence: /epoch 4 is held by graphyard-claude-1/,
    work: () => { const escalation = lost('graphyard-claude-2', 3, '2026-10-04T06:47:46.154Z'); return item('GY-1181', escalation, { epoch: 4, lease: { owner: 'graphyard-claude-1', epoch: 4, expiresAt: '2026-10-04T07:30:00.000Z' } }); } },
  { name: 'GY-1184 epoch 1, no newer attempt, no lease, no fence', cause: 'ended', evidence: /no newer attempt holds the item/,
    work: () => item('GY-1184', lost('graphyard-cursor-2', 1, '2026-10-04T08:23:39.364Z'), { epoch: 1 }) },
  { name: 'GY-1373 epoch 1, eighteen later epochs granted and expired', cause: 'ended', evidence: /every attempt from epoch 1 to epoch 19 has ended/,
    work: () => item('GY-1373', lost('graphyard-claude-1', 1, '2026-10-06T14:03:13.938Z'), { epoch: 19 }) },
] as const;

for (const instance of instances) {
  test(`manual:intervention-pattern-escalation-ready — ${instance.name}: reconciliation settles it on the record, and the loop asks no approver`, () => {
    const work = instance.work(), escalation = standingEscalations(work)[0];
    assert.equal(routineDecision(work, { autoMerge: true }, after5(escalation.at))?.action, undefined, 'no resolve decision, so no approver round and no intervention');
    assert.equal(withheldDecision(work, { autoMerge: true }, after5(escalation.at)), null);
    assert.deepEqual(settleableLeaseLoss(work, [], after5(escalation.at) - 1), [], 'it stands its bound first, so every sampling reader sees it');
    const [settled] = settleableLeaseLoss(work, [], after5(escalation.at));
    assert.equal(settled?.cause, instance.cause);
    assert.match(settled.note, instance.evidence);
    assert.match(settled.note, /^auto-settled: .*nothing from the lost attempt can act or merge$/);
  });
}

test('manual:intervention-pattern-escalation-ready — a lease-loss whose lost attempt might still act, or that a lead raised, is never settled on the record', () => {
  const escalation = lost('graphyard-claude-2', 1, '2026-10-06T16:50:43.335Z'), at = after5(escalation.at) + 60 * 60_000;
  const fence = { owner: 'graphyard-claude-2', epoch: 1, at: escalation.at, settlementHash: 'a'.repeat(64) };
  assert.equal(endedLeaseLoss(item('GY-1377', escalation, { containmentQuarantine: fence }), escalation), null, 'its own fence still stands: the supervisor is not shown gone');
  assert.equal(endedLeaseLoss(item('GY-1377', escalation, { epoch: 2, lease: { owner: 'graphyard-codex-1', epoch: 2, expiresAt: escalation.at }, containmentQuarantine: fence }), escalation), null);
  assert.equal(settleableLeaseLoss(item('GY-1377', escalation, { containmentQuarantine: fence }), [], at).length, 0);
  const lead = { ...escalation, actor: 'slice-lead' };
  assert.equal(settleableLeaseLoss(item('GY-1377', lead, {}), [], at).length, 0, 'a lead-raised concern stays for the master');
  assert.equal(endedLeaseLoss(item('GY-1377', escalation, { stage: 'done' }), escalation), null, 'delivered work is immutable');
  assert.equal(endedLeaseLoss(item('GY-1377', lost('graphyard-claude-2', 4, escalation.at), { epoch: 1 }), lost('graphyard-claude-2', 4, escalation.at)), null, 'an epoch the item never reached');
  const security = { ...escalation, trigger: 'security-concern' as const, reason: 'a credential' };
  assert.equal(settleableLeaseLoss(item('GY-1377', security, {}), [], at).length, 0);
  // Without a clock (the callers that predate GY-1393), only the ledger's explanations settle.
  assert.equal(settleableLeaseLoss(item('GY-1184', escalation, {}), []).length, 0);
});

test('manual:intervention-pattern-escalation-ready — while it stands its bound it waits on nobody, so the report counts no open escalation', () => {
  const escalation = lost('graphyard-cursor-2', 1, '2026-10-04T08:23:39.364Z'), work = item('GY-1184', escalation, {});
  const at = new Date(Date.parse(escalation.at) + 60_000).toISOString();
  // A row the fold reads for the item (here the epoch's earlier lease.expired), so its standing escalations are listed.
  const rows = [{ seq: 1, workId: work.id, actor: 'graphyard', kind: 'lease.expired', at: escalation.at, details: {} }];
  assert.deepEqual(foldInterventions(rows, [work], at).interventions, []);
  const fenced = item('GY-1184', escalation, { containmentQuarantine: { owner: 'graphyard-cursor-2', epoch: 1, at: escalation.at, settlementHash: 'a'.repeat(64) } });
  assert.deepEqual(foldInterventions(rows, [fenced], at).interventions.map(entry => entry.kind), ['escalation'], 'a fenced one does wait on its containment');
});

const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'engineer-a', role: 'worker', sessionKind: 'ai' };
const replacement: Principal = { id: 'engineer-b', role: 'worker', sessionKind: 'ai' };
let database: EmbeddedPostgres, store: Store, engine: Engine, expiring: Engine;
const id = () => randomUUID();
const reload = async (work: Work) => (await store.list()).find(entry => entry.id === work.id)!;
const events = async (work: Work, kind: string) => (await store.events(work.id)).filter(event => event.kind === kind);
async function overwrite(work: Work, mutate: (document: Work) => void) {
  const document = await reload(work); mutate(document);
  await store.pool.query('UPDATE work_items SET document=$2::jsonb WHERE id=$1', [document.id, JSON.stringify(document)]);
  return document;
}
const backdate = (work: Work) => overwrite(work, document => {
  const at = new Date(Date.now() - leaseLossSettleMs - 60_000).toISOString();
  document.escalations = standingEscalations(document).map(entry => ({ ...entry, at })); document.escalation = document.escalations[0];
});

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1393;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('escalation-ready'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.principals = [operator, worker, replacement];
  expiring = new Engine(store, [15368], 0, 'owner/project'); expiring.principals = engine.principals;
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

async function lapsed(title: string) {
  let work = await engine.execute(operator, 'create', null, { title, plannedFiles: [`src/${title}.ts`], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }] }, id());
  work = await engine.execute(operator, 'ready', work.id, {}, id());
  work = await expiring.execute(worker, 'claim', work.id, {}, id());
  await engine.reconcile();
  return reload(work);
}

test('manual:intervention-pattern-escalation-ready — the control plane raises the lapse, settles it after its bound with the cause, and the ledger folds to no intervention', async () => {
  // Between attempts: raised, standing its bound, then settled on the record.
  let ended = await lapsed('escalation-ready-ended');
  assert.deepEqual(standingEscalations(ended).map(entry => entry.reason), [leaseLossReason({ owner: worker.id, epoch: ended.epoch })]);
  await engine.reconcile();
  assert.equal(standingEscalations(await reload(ended)).length, 1, 'inside its bound it stands');
  await backdate(ended);
  await engine.reconcile();
  ended = await reload(ended);
  assert.deepEqual(standingEscalations(ended), []);
  const [settled] = await events(ended, 'escalation.auto-settled');
  assert.equal(settled.payload.details.cause, 'ended');
  assert.match(settled.payload.details.note, /no newer attempt holds the item/);

  // Superseded: a new attempt claimed the item; its lease is the evidence.
  let superseded = await lapsed('escalation-ready-superseded');
  superseded = await engine.execute(replacement, 'claim', superseded.id, {}, id());
  await backdate(superseded);
  await engine.reconcile();
  superseded = await reload(superseded);
  assert.deepEqual(standingEscalations(superseded), []);
  assert.match((await events(superseded, 'escalation.auto-settled'))[0].payload.details.note, new RegExp(`epoch ${superseded.epoch} is held by ${replacement.id}`));

  // Its own fence still stands: it waits for its containment to settle.
  let fenced = await lapsed('escalation-ready-fenced');
  fenced = await overwrite(fenced, document => { document.containmentQuarantine = { owner: worker.id, epoch: document.epoch, at: new Date().toISOString(), settlementHash: 'a'.repeat(64) }; });
  await backdate(fenced);
  await engine.reconcile();
  fenced = await reload(fenced);
  assert.deepEqual(standingEscalations(fenced).map(entry => entry.trigger), ['lease-loss']);

  const now = new Date().toISOString();
  for (const work of [ended, superseded]) {
    const { rows } = await readInterventionLedger(store.pool, { workId: work.id });
    assert.deepEqual(foldInterventions(rows, [work], now).interventions.filter(entry => entry.kind === 'escalation'), [], `${work.key}: an automatic settlement is no intervention`);
  }
});
