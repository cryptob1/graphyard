import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import type { Principal, Work } from '../src/model.js';
import { deliveryState } from '../src/model/delivery.js';
import { actionAccount, nextActionKinds } from '../src/model/next-action.js';
import { openActions } from '../src/model/actions.js';
import { groupOf, nextCommand } from '../src/model/board.js';
import { prSteps } from '../src/model/pr-steps.js';
import { leftFlowAt, noRelease, type ReleaseView } from '../src/model/release.js';
import { operationsCommand } from '../src/cli/master/operations.js';
import { unhandled, type MasterSession } from '../src/cli/master/session.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1981: done = merged. An item reaches stage done in the transaction that records its merge, and
// nothing per-item follows it any more: no awaiting-deployment or awaiting-smoke state, no
// verify-deployment action, no deployment command. Production health is one release-level reading.

const day = 86_400_000;
const nowMs = Date.parse('2030-06-01T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const mergeSha = 'f'.repeat(40), release = 'a'.repeat(40);
const policy: Work['policy'] = { checks: ['test', 'typecheck'], review: true };
const smokePolicy: Work['policy'] = { ...policy, deploySmoke: true };
const recorded = { sha: release, mergeSha, source: 'endpoint' as const, observedAt: iso(nowMs - day + 60_000), covers: 'descendant' as const, at: iso(nowMs - day + 61_000), observer: 'executor-1' };
/** A verify-deployment row and action as an executor left them before GY-1981. */
const legacyRow = (work: Work) => ({ id: 'legacy-row', kind: 'verify-deployment', work: work.id, key: work.key, gate: null, refusal: null, reason: `${work.key} merged`, binding: `delivery:${mergeSha}`,
  inputs: { kind: 'verify-deployment', mergeSha, mergedAt: work.delivery!.mergedAt, state: 'awaiting-deployment' }, state: 'pending', claim: null, attempts: 0, requestedAt: iso(nowMs - day), requestedBy: 'graphyard', history: [] });

/** A done, unclosed delivery merged a day ago. */
const delivered = (key: string, itemPolicy: Work['policy'], overrides: Partial<Work> = {}): Work => ({
  id: `id-${key}`, key, title: key, description: '', type: 'bug', priority: 1,
  dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:done-at-merge-settles'] }],
  policy: itemPolicy, 
  stage: 'done', revision: 40, policyRevision: 1, createdAt: iso(nowMs - 2 * day), updatedAt: iso(nowMs - day), stageEnteredAt: iso(nowMs - day),
  ready: true, epoch: 1, lease: null, workspaces: [], candidate: null, submission: { epoch: 1, pr: 1110 }, reworkRequested: false,
  scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [],
  delivery: { mergeSha, mergedAt: iso(nowMs - day), authorizationRevision: 33 }, ...overrides,
} as Work);
/** Every policy and deployment-record combination a merged item can carry. */
const variants = () => [
  delivered('GY-1', policy), delivered('GY-2', smokePolicy),
  delivered('GY-3', policy, { delivery: { mergeSha, mergedAt: iso(nowMs - day), authorizationRevision: 33, deployment: recorded } }),
  delivered('GY-4', smokePolicy, { delivery: { mergeSha, mergedAt: iso(nowMs - day), authorizationRevision: 33, deployment: recorded } }),
];

test('unit:done-at-merge-settles — a merged item is delivered with a settled next action whatever its smoke policy or deployment record, and raises no verify-deployment row', () => {
  for (const item of variants()) {
    assert.equal(deliveryState(item), 'delivered', `${item.key} is delivered at its merge`);
    const account = actionAccount(item, [item], new Date(nowMs));
    assert.equal(account.action, null, `${item.key} owes no action`);
    assert.equal(account.wait?.kind, 'settled', `${item.key}'s next action is the settled wait`);
    assert.equal(openActions([{ ...item, actionQueue: { actions: [legacyRow(item) as never], history: [] } }], new Date(nowMs)).length, 0, `no executor is offered a row on ${item.key}`);
  }
});

test('unit:done-at-merge-board-and-goal — the board groups a merged item as shipped with no next command, it is Done at its merge, flow exit is its merge, and a goal of merged items is deliverable', () => {
  // Production observed not serving the merge yet: none of it holds the item any more.
  const watching: ReleaseView = { ...noRelease, unserved: new Set(['GY-1', 'GY-2']), failed: new Set(['GY-2']), observedAt: nowMs - 2 * day };
  for (const item of variants()) for (const view of [noRelease, watching]) {
    assert.equal(groupOf(item, nowMs, undefined, undefined, view), 'shipped', `${item.key} is shipped`);
    assert.equal(nextCommand(item, 'shipped', 'master'), null, `${item.key} has no next command`);
    const steps = prSteps(item, nowMs, view);
    assert.equal(steps.current, 'done', `${item.key} is Done at its merge (GY-1979)`);
    assert.equal(steps.steps.at(-1)!.id, 'done', `${item.key} shows no Deploy step`);
    assert.ok(steps.steps.every(step => step.state === 'done'));
    assert.equal(leftFlowAt(item, view), item.delivery!.mergedAt, `${item.key} leaves the flow at its merge`);
  }
});

// ---- The deleted surface, and what older rows still carry -----------------------------------

const operator: Principal = { id: 'done-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'done-coordinator', role: 'coordinator', sessionKind: 'ai' };
let database: InstanceType<typeof EmbeddedPostgres>, store: Store, engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1981;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('done-at-merge'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('done_at_merge_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/done_at_merge_test`); await store.init();
  engine = new Engine(store, 120, 'owner/done-at-merge'); engine.submissionObserver = null;
  engine.principals = [operator, coordinator];
});
after(async () => { await store?.close(); await database?.stop(); });

test('unit:verify-deployment-removed-history-loads — the kind, deployment command and master verify-deployment are gone, and a verify-deployment row, action or deployment event written earlier loads and settles', { timeout: 120_000 }, async () => {
  assert.ok(!(nextActionKinds as readonly string[]).includes('verify-deployment'), 'no verify-deployment action kind');
  assert.equal(await operationsCommand({ id: 'verify-deployment', args: ['GY-1'] } as unknown as MasterSession), unhandled, 'master verify-deployment is no subcommand');

  const created = await engine.execute(operator, 'create', null, { title: 'Delivered before GY-1981', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:verify-deployment-removed-history-loads'] }] }, randomUUID()) as Work;
  const dbNow = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).getTime();
  const legacy = { ...created, stage: 'done', stageEnteredAt: iso(dbNow - day), updatedAt: iso(dbNow - day), ready: true, epoch: 1, lease: null, candidate: null, sessions: [], observation: null, violations: [], gates: [], policy: smokePolicy,
    delivery: { mergeSha, mergedAt: iso(dbNow - day), authorizationRevision: 1, deployment: { ...recorded, observedAt: iso(dbNow - day + 60_000), at: iso(dbNow - day + 61_000) } } } as Work;
  const row = legacyRow(legacy);
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [created.id, JSON.stringify({ ...legacy, nextAction: { kind: 'verify-deployment', work: created.id, key: created.key, gate: null, refusal: null, reason: row.reason, inputs: row.inputs, llmRole: null, binding: row.binding }, actionQueue: { actions: [row], history: [] } })]);
  await store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [created.id, coordinator.id, 'deployment', JSON.stringify({ details: { deployment: legacy.delivery!.deployment } })]);

  // The deployment command is gone: an executor's old record call is refused as unknown.
  await assert.rejects(engine.execute(coordinator, 'deployment' as never, created.id, { sha: release, mergeSha, source: 'endpoint', observedAt: iso(dbNow) }, randomUUID()), /Unknown command/);

  // Older rows still load: the document with its row and action, and the deployment event.
  const loaded = (await store.list()).find(item => item.id === created.id)!;
  assert.equal(loaded.actionQueue?.actions[0].kind as string, 'verify-deployment');
  assert.equal(loaded.delivery?.deployment?.sha, release);
  assert.equal(deliveryState(loaded), 'delivered');
  assert.ok((await store.events(created.id)).some(event => event.kind === 'deployment'), 'the deployment event reads back');

  // The next reconciliation pass settles the queued row: nothing is offered, and the delivery is settled.
  engine.reconcileFullEvaluationMs = 0;
  await engine.reconcile();
  const settled = (await store.list()).find(item => item.id === created.id)!;
  assert.equal(settled.actionQueue?.actions.length ?? 0, 0, 'the verify-deployment row is retired');
  assert.equal(settled.nextAction ?? null, null, 'the delivered item owes nothing');
  assert.equal((await store.pool.query('SELECT settled FROM work_index WHERE id=$1', [created.id])).rows[0].settled, true, 'the delivery is settled');
});
