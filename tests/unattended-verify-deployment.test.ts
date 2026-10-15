import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Principal, Work } from '../src/model.js';
import { claimAction, openActions, reconcileActions } from '../src/model/actions.js';
import { nextAction } from '../src/model/next-action.js';
import { deliverySpeed } from '../src/flow-analytics.js';
import { controlPlaneHandlers } from '../src/executor.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import EmbeddedPostgres from 'embedded-postgres';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { MasterConfig } from '../src/master.js';

// GY-1824: a delivery whose policy asks for no post-deployment smoke proof used to stop at
// `delivered` the moment it merged, so nothing ever recorded the serving release on it: the loop's
// deployment step recorded deployments for smoke items only, and the only remaining path was a
// master session running `graphyard master verify-deployment GY-N` by hand — forever, one item at
// a time, while flow-analytics counted each of them pending. The unattended path now records the
// release for every served delivery, through the executor's verify-deployment handler, which files
// and releases any owed post-deploy follow-up before the record exactly as it does for a smoke
// item, however old its merge; a smoke item's raise is unchanged.
//
// Deliveries that already were done when this shipped hold no row and are re-evaluated by nothing
// else: a settled delivery is served as its summary and never visited. Each full reconciliation
// pass therefore takes in a few settled deliveries still owing their record, newest item first
// (`deploymentBackfillPerPass`), and settles each like one holding leftover rows: the backfill is
// bounded per pass, and no eligible delivery is excluded, whatever its age. The tests below run the
// real pass over a real Postgres ledger, the only harness that shows the row reaching the executor.

const day = 86_400_000;
const nowMs = Date.parse('2030-06-01T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const mergeSha = 'f'.repeat(40), release = 'a'.repeat(40);
const postDeployProof = 'manual:post-deploy/harness-drift-cleared';
const policy: Work['policy'] = { checks: ['test', 'typecheck'], review: true };
const smokePolicy: Work['policy'] = { ...policy, deploySmoke: true };

/** A done, unclosed delivery merged `ageMs` ago, its serving release unrecorded unless `deployment` says otherwise. */
const delivered = (key: string, ageMs: number, overrides: Partial<Work> = {}, itemPolicy: Work['policy'] = policy): Work => ({
  id: `id-${key}`, key, title: key, description: '', type: 'bug', priority: 1,
  dependencies: [], criteria: [{ id: 'AC-1', text: 'The harness contract applies on the serving release', proofs: [postDeployProof] }],
  policy: itemPolicy, plannedFiles: [],
  stage: 'done', revision: 40, policyRevision: 1, createdAt: iso(nowMs - ageMs - day), updatedAt: iso(nowMs - ageMs), stageEnteredAt: iso(nowMs - ageMs),
  ready: true, epoch: 1, lease: null, workspaces: [], candidate: null, submission: { epoch: 1, pr: 1110 }, reworkRequested: false,
  scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [],
  delivery: { mergeSha, mergedAt: iso(nowMs - ageMs), authorizationRevision: 33 }, ...overrides,
} as Work);

const record = (observedAt: number) => ({ sha: release, mergeSha, source: 'endpoint' as const, observedAt: iso(observedAt), covers: 'descendant' as const, at: iso(observedAt + 1000), observer: 'executor-1' });
const unusable = async (): Promise<never> => { throw new Error('not reached'); };

/** The handlers Graphyard ships, over one in-memory snapshot, with the observation and the calls recorded. */
function handlers(work: Work, all: Work[], calls: string[], fileWork?: (input: unknown, requestId: string) => Promise<{ key?: string }>) {
  return controlPlaneHandlers(() => ({}) as MasterConfig, {
    snapshot: async () => ({ work: all.some(item => item.id === work.id) ? all : [work], now: iso(nowMs) }),
    // The coordinator credential records the observation and never creates work.
    mutate: async (path: string) => { calls.push(path); return {}; },
    agents: () => [], workerCredentials: async () => ({}), producerCredentials: async () => ({}),
    dispatchWorker: unusable, launchReview: unusable, launchProducer: unusable,
    observeDeployment: async () => ({ source: 'endpoint', sha: release, at: iso(nowMs - 60_000), reason: null, deployed: [work.key], pending: [] }) as never,
    releaseWork: async (key: string) => { calls.push(`release ${key}`); },
    now: () => nowMs,
    ...(fileWork ? { fileWork } : {}),
  });
}
const verifyRow = (work: Work) => ({ id: 'row-1', work: work.id, key: work.key, kind: 'verify-deployment', inputs: { kind: 'verify-deployment', mergeSha, mergedAt: work.delivery!.mergedAt, state: 'delivered' } }) as never;

test('unit:unattended-verify-deployment — a served non-smoke delivery is recorded by the executor with no master session, filing and releasing the owed post-deploy follow-up first, and never recorded twice', async () => {
  const item = delivered('GY-1900', 2 * day);
  // The item is done, unclosed, asks for no smoke proof, and no release observation is recorded: it owes verify-deployment.
  const action = nextAction(item, [item], new Date(nowMs));
  assert.equal(action?.kind, 'verify-deployment');
  assert.deepEqual(action!.inputs, { kind: 'verify-deployment', mergeSha, mergedAt: item.delivery!.mergedAt, state: 'delivered' });
  // The raise is a claimable row a stateless executor is offered, exactly as a smoke item's is.
  assert.equal(reconcileActions(item, [item], new Date(nowMs)).filter(entry => entry.event === 'requested').length, 1);
  const offered = openActions([item], new Date(nowMs));
  assert.equal(offered.length, 1);
  assert.equal(offered[0].row.kind, 'verify-deployment');
  assert.equal(claimAction([item], { id: 'executor-1', host: 'host-1', principal: 'executor-1' }, new Date(nowMs))!.row.kind, 'verify-deployment');

  // The executor's handler records the observation only after it has filed and released the owed post-deploy follow-up.
  const calls: string[] = [];
  const filed: string[] = [];
  const result = await handlers(item, [item], calls, async (input: unknown, requestId: string) => {
    calls.push(`file ${requestId}`); filed.push(String((input as { title: string }).title)); return { key: 'GY-1901' };
  })['verify-deployment']!(verifyRow(item), { host: 'host-1', id: 'executor-1' }) as unknown as Promise<string>;
  assert.match(String(result), /AC-1 owes its post-deploy observation \(GY-1901\)/);
  assert.deepEqual(calls, [`file post-deploy:${item.id}:AC-1:manual:post-deploy/harness-drift-cleared:${release}`, 'release GY-1901', `work/${item.id}/deployment`]);
  assert.match(filed[0], /^Post-deploy verification of GY-1900 AC-1/);

  // Without an operator-agent identity to file with, nothing is recorded: the observation waits for the filing.
  const refused: string[] = [];
  await assert.rejects(handlers(item, [item], refused)['verify-deployment']!(verifyRow(item), { host: 'host-1', id: 'executor-1' }) as unknown as Promise<string>,
    /owes its post-deploy follow-up, and this executor has no operator-agent identity/);
  assert.deepEqual(refused, [], 'nothing is recorded while the follow-up is unfiled');

  // Once the record is on the delivery it is never raised again: the item is settled, not verified a second time.
  item.delivery!.deployment = record(nowMs - 60_000);
  assert.equal(nextAction(item, [item], new Date(nowMs)), null);
  assert.equal(reconcileActions(item, [item], new Date(nowMs)).length, 0);
  assert.equal(openActions([item], new Date(nowMs)).length, 0);
});

test('unit:unattended-verify-deployment — an unrecorded delivery is owed its record at any age, and a smoke item raises and waits exactly as before', async () => {
  // No age puts an unrecorded delivery beyond the unattended path: a merge a year old is raised as a fresh one is.
  for (const age of [8 * day, 365 * day]) {
    const old = delivered(`GY-19${age === 8 * day ? '02' : '03'}`, age);
    assert.equal(nextAction(old, [old], new Date(nowMs))?.kind, 'verify-deployment', `a delivery merged ${age / day} days ago is raised`);
  }
  // A closed delivery is settled whatever its age: closure, not the policy, ends the item.
  const closed = delivered('GY-1904', 2 * day, { closure: { kind: 'delivered-observation', reason: 'closed after its observation was read', ref: release, by: 'graphyard', at: iso(nowMs - 3_600_000), from: 'done' } as never });
  assert.equal(nextAction(closed, [closed], new Date(nowMs)), null);

  // A smoke item's behaviour is unchanged: the raise names the awaiting state...
  const smoke = delivered('GY-1905', 30 * day, {}, smokePolicy);
  const raised = nextAction(smoke, [smoke], new Date(nowMs));
  assert.equal(raised?.kind, 'verify-deployment');
  assert.deepEqual(raised!.inputs, { kind: 'verify-deployment', mergeSha, mergedAt: smoke.delivery!.mergedAt, state: 'awaiting-deployment' });
  // ...and once the deployment is recorded it waits for its smoke proof rather than settling: the loop requests that proof.
  smoke.delivery!.deployment = record(nowMs - 60_000);
  assert.equal(nextAction(smoke, [smoke], new Date(nowMs)), null);
});

test('unit:unattended-verify-deployment — deliverySpeed counts a recorded delivery merged-to-promoted instead of pending', async () => {
  const item = delivered('GY-1906', 2 * day);
  const mergedAt = nowMs - 2 * day;
  // Unrecorded, the item only hangs over the figure as pending.
  const before = deliverySpeed([item], { now: nowMs }).mergedToProduction['7d'];
  assert.equal(before.count, 0);
  assert.equal(before.pending, 1);
  assert.deepEqual(before.slowest.filter(entry => entry.pending).map(entry => entry.key), ['GY-1906']);
  // Recorded, it moves into the merged→promoted figure with its own span.
  item.delivery!.deployment = record(mergedAt + 3 * 3_600_000);
  const after = deliverySpeed([item], { now: nowMs }).mergedToProduction['7d'];
  assert.equal(after.count, 1);
  assert.equal(after.p90Ms, 3 * 3_600_000);
  assert.equal(after.pending, 0);
});

// ---- The reconciliation pass over a real ledger ---------------------------------------------

const operator: Principal = { id: 'unattended-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'unattended-coordinator', role: 'coordinator', sessionKind: 'ai' };
const executor: Principal = { id: 'unattended-executor', role: 'coordinator', sessionKind: 'ai' };

let database: InstanceType<typeof EmbeddedPostgres>, store: Store, engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1824;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('unattended-verify-deployment'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('unattended_verify_deployment_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/unattended_verify_deployment_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/unattended'); engine.submissionObserver = null;
  engine.principals = [operator, coordinator, executor];
});
after(async () => { await store?.close(); await database?.stop(); });

/** A delivered item planted as the pre-change ledger holds one: done, unclosed, no row, no next action. */
async function plantDelivered(key: string, mergedAt: number): Promise<Work> {
  const created = await engine.execute(operator, 'create', null, { title: key, plannedFiles: ['src/unattended/'], criteria: [{ id: 'AC-1', text: 'Served by the release', proofs: ['unit:unattended-verify-deployment'] }] }, randomUUID()) as Work;
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [created.id, JSON.stringify({
    ...created, stage: 'done', stageEnteredAt: iso(mergedAt), updatedAt: iso(mergedAt), ready: true, epoch: 1, lease: null,
    candidate: null, nextAction: null, actionQueue: { actions: [], history: [] }, sessions: [], observation: null, violations: [], gates: [],
    delivery: { mergeSha, mergedAt: iso(mergedAt), authorizationRevision: 1 },
  })]);
  return (await store.list()).find(item => item.id === created.id)!;
}
const settledOf = async (id: string) => !!(await store.pool.query('SELECT settled FROM work_index WHERE id=$1', [id])).rows[0]?.settled;

test('unit:unattended-verify-deployment — reconciliation gives a delivery that already was done its verify-deployment row, the executor records it, and the delivery settles again', { timeout: 120_000 }, async () => {
  const dbNow = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).getTime();
  const owed = await plantDelivered('GY-1907', dbNow - 2 * day);
  // Planted as the pre-change ledger holds it: settled, served as its summary until a full pass takes it in.
  assert.equal(await settledOf(owed.id), true, 'a rowless delivery is settled before the pass');

  engine.reconcileFullEvaluationMs = 0;
  await engine.reconcile();

  const raised = (await store.list()).find(item => item.id === owed.id)!;
  assert.equal(raised.nextAction?.kind, 'verify-deployment', 'the pass raised the verify-deployment action');
  assert.equal(raised.actionQueue?.actions.filter(row => row.kind === 'verify-deployment').length, 1, 'the pass left exactly the verify-deployment row');
  assert.deepEqual(raised.actionQueue?.actions.map(row => row.inputs), [{ kind: 'verify-deployment', mergeSha, mergedAt: iso(dbNow - 2 * day), state: 'delivered' }]);
  assert.equal(await settledOf(owed.id), false, 'a delivery holding its verify-deployment row is live until it is recorded');

  // The row is a claim an executor takes and runs: it observes the release and records the delivery.
  const claimed = await engine.claimNextAction(executor, { host: 'host-1', kinds: ['verify-deployment'], work: owed.key }, randomUUID());
  assert.equal(claimed.action?.kind, 'verify-deployment', 'the executor claims the raised row');
  await engine.execute(coordinator, 'deployment', owed.id, { sha: release, mergeSha, source: 'endpoint', observedAt: iso(dbNow - 60_000) }, randomUUID());
  const recorded = (await store.list()).find(item => item.id === owed.id)!;
  assert.equal(recorded.delivery?.deployment?.sha, release, 'the serving release is recorded with no master session');

  // Settled: the claim's own settlement retires the row, and the pass finds nothing to raise again.
  await engine.settleClaimedAction(executor, claimed.action!.id, { result: 'done', reason: `observed the release serving ${release.slice(0, 12)}` }, randomUUID());
  await engine.reconcile();
  const settled = (await store.list()).find(item => item.id === owed.id)!;
  assert.equal(settled.delivery?.deployment?.sha, release, 'a recorded delivery is not recorded again');
  assert.equal(settled.actionQueue?.actions.length ?? 0, 0, 'the settled delivery holds no row');
  assert.equal(await settledOf(owed.id), true, 'the recorded delivery is settled');
  assert.equal(await nextAction(settled, [settled], new Date(dbNow)), null, 'nothing is raised for a recorded delivery');
});

test('unit:unattended-verify-deployment — the backfill is bounded per full pass and reaches every unrecorded delivery in turn, however old', { timeout: 120_000 }, async () => {
  const dbNow = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).getTime();
  // Three deliveries done long before the unattended path shipped, the oldest a year back: none is ever excluded.
  const planted = [await plantDelivered('GY-1910', dbNow - 365 * day), await plantDelivered('GY-1911', dbNow - 40 * day), await plantDelivered('GY-1912', dbNow - 10 * day)];
  const raisedNow = async () => (await store.list()).filter(item => planted.some(entry => entry.id === item.id) && item.nextAction?.kind === 'verify-deployment').map(item => planted.findIndex(entry => entry.id === item.id)).sort();
  engine.reconcileFullEvaluationMs = 0; engine.reconcileDeploymentBackfill = 2;
  try {
    // One full pass raises at most the bound, newest item first; the rest stay settled for a later pass.
    await engine.reconcile();
    assert.deepEqual(await raisedNow(), [1, 2], 'the first pass raises two rows, newest item first');
    assert.equal(await settledOf(planted[0].id), true, 'the year-old delivery waits its turn, still settled');
    // The next full pass reaches the year-old delivery: the bound defers, it never excludes.
    await engine.reconcile();
    assert.deepEqual(await raisedNow(), [0, 1, 2], 'the next pass raises the remaining delivery');
    const oldest = (await store.list()).find(item => item.id === planted[0].id)!;
    assert.deepEqual(oldest.actionQueue?.actions.map(row => row.kind), ['verify-deployment'], 'the year-old delivery holds its row for an executor');
  } finally { engine.reconcileDeploymentBackfill = 5; }
});
