import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Principal, Work } from '../src/model.js';
import { classifyBlocker, itemBlockerClass, scopeAskPaths } from '../src/model/blocker-class.js';
import { blockedAttemptMarker } from '../src/model/capacity.js';
import { scopeRefusalBlocker } from '../src/model/scope.js';
import { blockerScopeDecision } from '../src/daemon/decisions.js';
import { foldInterventions, type InterventionLedgerRow } from '../src/interventions.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1396. Five scope widenings were counted at the ready stage in the week to 2026-10-07, every
 * one a coordinator's `requirements` revision of an item no attempt held:
 * - GY-1055: an interrupted attempt's refused scope request was closed, but its refusal stood as
 *   the item's blocker, so nothing routed it and the master widened the item hours later;
 * - GY-1113: the worker parked a plannedFiles widening as a goals-and-priorities decision;
 * - GY-845: the worker's blocker named the file it needed but no commit, so it read as genuine;
 * - GY-1376, GY-1005: the master revised the scope of an item it had just created, before any
 *   worker had started on it — planning, which nobody waited on.
 * Each shape is pinned here as the product now handles it.
 */
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const worker: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, worker].map(principal => ({ ...principal, token: `ready-scope-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_READY_SCOPE_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1396);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('ready-scope'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('ready_scope_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/ready_scope_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/ready-scope'); engine.submissionObserver = null;
  http = server(engine, credentials, null);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });

const id = () => randomUUID();
const post = async (principal: Principal, path: string, body: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': id() }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const reload = async (workId: string) => (await store.list()).find(item => item.id === workId)!;
let serial = 0;
async function claimed(title: string) {
  let work = await engine.execute(operator, 'create', null, { title: `${title} ${++serial}`, plannedFiles: ['src/a.ts'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:behaves'] }] }, id());
  work = await engine.execute(operator, 'ready', work.id, {}, id());
  return engine.execute(worker, 'claim', work.id, {}, id());
}

test('integration:interrupted-attempt-lifts-its-scope-refusal — an attempt the loop ends as interrupted closes its refused scope request on the record and lifts the refusal it left as the blocker, so the item is dispatched again rather than held at ready for a hand widening (GY-1055)', async () => {
  let work = await claimed('interrupted');
  await engine.execute(worker, 'scope', work.id, { epoch: work.epoch, paths: ['src/store/schema.ts'], reason: 'The registry lives under src/store/' }, id());
  work = await engine.execute(coordinator, 'autoscope', work.id, { epoch: work.epoch }, id());
  assert.ok(work.blocker?.startsWith(scopeRefusalBlocker), work.blocker ?? 'no blocker');
  const ended = await post(coordinator, `work/${work.id}/capacity`, { event: 'exhausted', cause: 'interrupted', role: 'worker', epoch: work.epoch, profile: 'alpha', account: null, runtime: 'claude',
    reason: 'the session vanished without submitting', resetsAt: null, partialWork: { state: 'clean', commit: 'a'.repeat(40) } });
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  const after = await reload(work.id);
  assert.equal(after.lease, null);
  assert.equal(after.scopeRequest, null);
  assert.equal(after.blocker, null, 'the ended attempt\'s refusal no longer holds the item');
  assert.equal(after.stage, 'ready');
  const closed = (await store.pool.query(`SELECT payload->'details' AS details FROM events WHERE work_id=$1 AND kind='scope.closed'`, [work.id])).rows;
  assert.deepEqual(closed.map(row => [row.details.by, row.details.decision, row.details.paths]), [['capacity.interrupted', 'refused', ['src/store/schema.ts']]]);

});

test('integration:scope-park-refused — a park whose decision is a plannedFiles widening is refused with the scope-request command that the loop and the approver answer, and the attempt keeps its lease; a human-only park still parks (GY-1113)', async () => {
  const work = await claimed('park');
  const needed = 'master scope to widen plannedFiles to include src/master/profiles.ts, src/master.ts, tests/role-concurrency.test.ts';
  const refused = await post(worker, `work/${work.key}/park`, { epoch: work.epoch, kind: 'goals-and-priorities', needed, reason: 'AC-1 requires removing the shared cause, which lives in these files' });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error, /not a human-only decision/);
  assert.match(refused.body.error, new RegExp(`graphyard scope-request ${work.key} ${work.epoch} src/master/profiles\\.ts src/master\\.ts tests/role-concurrency\\.test\\.ts -- REASON`));
  const still = await reload(work.id);
  assert.equal(still.lease?.epoch, work.epoch, 'the refused park ends nothing');
  assert.equal(still.humanRequest ?? null, null);
  // Files already planned are no scope ask; neither is a decision with no scope words.
  assert.deepEqual(scopeAskPaths('widen plannedFiles to include src/a.ts', ['src/a.ts']), []);
  assert.deepEqual(scopeAskPaths('a Railway team seat for src/deploy.ts', ['src/a.ts']), []);
  const parked = await post(worker, `work/${work.key}/park`, { epoch: work.epoch, kind: 'money-or-accounts', needed: 'a Railway team seat', reason: 'The deploy needs a second seat' });
  assert.equal(parked.status, 200, JSON.stringify(parked.body));
  assert.equal(parked.body.lease, null);
});

test('unit:named-scope-blocker-routes-with-attempt-commit — a blocker that names the file it needs but no commit is routed to the approver with the head its blocked attempt kept, and stays genuine without one (GY-845)', () => {
  const blocker = 'PR #470 contains a commit with out-of-scope changes to src/model/work.ts (pendingFollowUps field) which is not in the approved planned files. Requires operator approval to expand scope to src/model/work.ts.';
  assert.equal(classifyBlocker(blocker).class, 'genuine', 'the text alone names no commit');
  const commit = 'c'.repeat(40);
  const exhaustion = (epoch: number, reason: string, kept: string | undefined) => ({ role: 'worker', cause: 'interrupted', epoch, profile: 'p', account: null, runtime: 'claude', reason, resetsAt: null,
    partialWork: { state: 'committed', ...(kept ? { commit: kept } : {}) }, at: '2026-10-06T00:00:00.000Z', owner: 'p', recordedBy: 'p' });
  const item = (exhaustions: unknown[]) => ({ id: 'w-845', key: 'GY-845', stage: 'ready', epoch: 2, blocker, humanRequest: null, scopeRequest: null, blockerProbe: null,
    plannedFiles: ['src/server/followups.ts'], criteria: [{ id: 'AC-1', text: 'Follow-ups stay on their parent', proofs: ['unit:x'] }], capacity: { exhaustions, escalations: [] } }) as unknown as Work;

  const routed = item([exhaustion(2, `${blockedAttemptMarker}2: ${blocker}`.slice(0, 500), commit)]);
  assert.deepEqual({ ...itemBlockerClass(routed) }, { class: 'planned-file-scope', paths: ['src/model/work.ts'], commit, decision: null, path: null });
  const decision = blockerScopeDecision(routed);
  assert.equal(decision?.action, 'requirements');
  assert.deepEqual((decision!.input as { plannedFiles: string[] }).plannedFiles, ['src/server/followups.ts', 'src/model/work.ts']);

  // Without the blocked attempt's kept head — another epoch's, an attempt that did not block, or none kept — it stays genuine.
  for (const exhaustions of [[exhaustion(1, `${blockedAttemptMarker}1: ${blocker}`.slice(0, 500), commit)], [exhaustion(2, 'the session vanished', commit)], [exhaustion(2, `${blockedAttemptMarker}2: x`, undefined)], []])
    assert.equal(itemBlockerClass(item(exhaustions))?.class, 'genuine');
});

test('unit:ready-replan-is-no-intervention — a widening of an item no attempt holds, that nobody asked for and nothing blocks, is planning; one that answers a standing blocker at ready, or widens a live attempt, is still a scope-widening intervention (GY-1376, GY-1005)', () => {
  const at = (seconds: number) => new Date(Date.parse('2026-10-06T00:00:00.000Z') + seconds * 1000).toISOString();
  const widen = (workId: string, stage: string, blocker: string | null, live = false): InterventionLedgerRow[] => [
    { seq: 1, workId, actor: 'master-op', kind: 'requirements', at: at(1), details: { reason: 'first plan' }, work: { key: workId, stage, plannedFiles: ['src/a.ts'], blocker }, stageBefore: stage },
    { seq: 2, workId, actor: 'master-op', kind: 'requirements', at: at(2), details: { reason: 'widened', ...(live ? { liveScopeWidening: true } : {}) }, work: { key: workId, stage, plannedFiles: ['src/a.ts', 'src/b.ts'], blocker }, stageBefore: stage },
  ];
  const widenings = (rows: InterventionLedgerRow[]) => foldInterventions(rows, [], at(10)).interventions.filter(entry => entry.kind === 'scope-widening').map(entry => [entry.stage, entry.trigger]);
  assert.deepEqual(widenings(widen('GY-1376', 'ready', null)), [], 'a re-plan of a ready item');
  assert.deepEqual(widenings(widen('GY-1005', 'backlog', null)), [], 'a re-plan of a backlog item');
  assert.deepEqual(widenings(widen('GY-1113', 'ready', 'Waiting on a human-only decision (goals and priorities): widen plannedFiles')), [['ready', 'operator-widening']], 'answering a standing blocker by hand still counts');
  assert.deepEqual(widenings(widen('GY-1', 'build', null, true)), [['build', 'operator-widening']], 'widening a live attempt still counts');
});
