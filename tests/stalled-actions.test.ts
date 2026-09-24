import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { Observation, Principal, Work } from '../src/model.js';
import { actionId, claimAction, openActions, reconcileActions, settleAction, type ActionRow } from '../src/model/actions.js';
import { actionIdleMs, actionRetryDelay, actionRetryMaxMs, actionRetryMinMs, actionStall, actionStallDelay, actionStallLatencyMs, actionStallMaxMs, actionStallRecheckMs, actionStallThreshold, claimable, queueSnapshot, stalledActions } from '../src/model/action-progress.js';
import { sweepDirectMerges, type DirectMergeWindow } from '../src/direct-merge.js';
import { queueRef, type QueueSpeculation } from '../src/merge-queue.js';
import { assertDispatchable } from '../src/master.js';
import { actionReport, stalledActionAttention } from '../src/cli/master-status.js';
import { plainStatus, stalledStep } from '../web/plain-status.js';
import WorkCard from '../web/components/work-card.js';
import { readMasterGuide } from './helpers/master-guide.js';

/**
 * GY-110: an action that keeps failing for the same reason is a stall, not a retry.
 *
 * A typed action that fails is retried with a widening backoff, and `claimable()` excludes a row
 * inside that backoff — so a row that can never succeed used to be indistinguishable, in every
 * view Graphyard offers, from an item with nothing to do. Three reviews that could never be
 * launched sat behind one reviewer name for ninety-seven minutes while `master status` reported
 * eight pending actions, none of them those three.
 *
 * One case per proof: unit:stalled-action-classified, integration:stalled-action-visible,
 * integration:stall-raises-attention and integration:cleared-condition-retries-promptly, with the
 * docs case behind manual:stall-visibility-docs-review beside them.
 */

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'agent-a', role: 'worker', runtime: 'claude' };
const executor: Principal = { id: 'executor-a', role: 'coordinator' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const ci: Principal = { id: 'ci', role: 'producer', proofs: ['integration:claim-safety'] };
const PROOF = 'integration:stalled-action-visible';
const identity = { id: executor.id, host: 'host-1', principal: executor.id };

let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  // An offset no other test file takes: two files sharing a port fail whichever starts its
  // Postgres second, in its `before` hook, with no reason given.
  const port = Number(process.env.GRAPHYARD_STALLED_ACTIONS_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 72);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-stalled-actions-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [operator, worker, executor, coordinator, ci];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

let sequence = 0;
const created = (overrides: Record<string, unknown> = {}) => engine.execute(operator, 'create', null,
  { title: `Stalled actions ${++sequence}`, plannedFiles: [`src/stall-${sequence}.ts`], criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }], ...overrides }, randomUUID());
const release = (item: Work) => engine.execute(operator, 'ready', item.id, {}, randomUUID());
const reload = async (item: Work) => (await store.list()).find(entry => entry.id === item.id)!;
const dispatchRow = (item: Work) => (item.actionQueue?.actions ?? []).find(row => row.kind === 'dispatch')!;
const snapshotOf = async () => ({ work: await store.list(), now: new Date().toISOString() });

/** Why an executor's dispatch handler would refuse this item right now, or null when it would not. */
function dispatchRefusal(item: Work, all: Work[]): string | null {
  try { assertDispatchable(item, all, new Date().toISOString()); return null; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}

/** The wait a failed row earned, as the record itself states it. */
const waited = (row: ActionRow) => Date.parse(row.retryAt!) - Date.parse(row.resolvedAt!);

/**
 * Bring a row's backoff forward by `ms`, which is what the passage of that much time does to it.
 * The row's own recorded wait is left where it is, so the assertions can still read what the
 * control plane decided to wait rather than what the test did to reach it.
 */
async function elapse(item: Work, ms: number) {
  const current = await reload(item);
  const queue = { ...current.actionQueue!, actions: current.actionQueue!.actions.map(row => ({ ...row, ...(row.retryAt ? { retryAt: new Date(Date.parse(row.retryAt) - ms).toISOString() } : {}) })) };
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{actionQueue}',$2::jsonb) WHERE id=$1", [current.id, JSON.stringify(queue)]);
}

/** One whole attempt through the control plane: claim the row, run into the condition, report it. */
async function attempt(item: Work, reason: () => Promise<string>) {
  const claimed = await engine.claimNextAction(executor, { host: identity.host, kinds: ['dispatch'], work: item.key }, randomUUID());
  assert.ok(claimed.action, `${item.key} offered its dispatch row`);
  const settled = await engine.settleClaimedAction(executor, claimed.action!.id, { result: 'failed', reason: await reason() }, randomUUID());
  return settled.action as ActionRow;
}

// ---- AC-1: the classification ---------------------------------------------------------------

test('unit:stalled-action-classified — a row whose failures stop changing is classified as stalled with its reason, attempts and age, from one threshold; a row whose reason keeps changing never is', () => {
  const at = '2026-09-21T09:00:00.000Z', clock = Date.parse(at);
  const item = {
    id: 'work-1', key: 'GY-1', title: 'Stall', description: '', type: 'bug', priority: 1, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }], policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null,
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [],
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }],
  } as unknown as Work;

  const unchanged = structuredClone(item);
  reconcileActions(unchanged, [unchanged], new Date(clock));
  const row = dispatchRow(unchanged);
  const busy = 'reviewer agent review-claude-1 is busy in Herdr';
  // Each attempt is claimed the instant its backoff runs out, so the clock the row is judged on is
  // the record's own: the wait the control plane decided, attempt after attempt.
  let now = clock;
  const fail = (target: Work, reason: string) => {
    const claimed = claimAction([target], identity, new Date(now))!;
    assert.ok(claimed, 'the row was offered');
    const settled = settleAction(target, claimed.row.id, { executor: identity.id, principal: identity.principal }, 'failed', reason, new Date(now += 1000));
    now = Date.parse(settled.action.retryAt!);
    return settled.action;
  };

  // Below the threshold the row is retrying: a fault that may pass, on a widening backoff.
  for (let failure = 1; failure < actionStallThreshold; failure++) {
    const failed = fail(unchanged, busy);
    assert.equal(actionStall(failed), null, `${failure} identical failure(s) is a retry, not yet a stall`);
    assert.equal(failed.stall, undefined, 'and the row carries no classification it has not earned');
    assert.equal(waited(failed), actionRetryDelay(failure), 'the wait widens with the attempt count');
    assert.equal(claimable(failed, new Date(Date.parse(failed.resolvedAt!) + 1)), false);
  }

  // The threshold failure turns the same reason into a classification the row carries: what it
  // keeps failing with, how many attempts in a row said so, how many it has made in all, and —
  // through the row's own request time — how long it has been open.
  const stalled = fail(unchanged, busy);
  const stall = actionStall(stalled);
  assert.ok(stall, 'an unchanged reason at the threshold is a stall');
  assert.deepEqual(stalled.stall, stall, 'and the row carries exactly what the classification says');
  assert.equal(stall!.reason, busy);
  assert.equal(stall!.failures, actionStallThreshold);
  assert.equal(stall!.attempts, actionStallThreshold);
  assert.equal(stall!.since, stalled.history.find(entry => entry.event === 'failed')!.at, 'measured from the first failure of the unchanged run');
  const open = stalledActions(unchanged, new Date(now));
  assert.deepEqual(open.map(entry => [entry.kind, entry.stall.reason, entry.stall.failures]), [['dispatch', busy, actionStallThreshold]]);
  assert.equal(open[0].openMs, now - clock, 'and how long the row has been open, from the request that opened it');

  // A stall starts from the recheck, not from the attempt count: the row is offered again inside
  // the recheck interval however many attempts it made before it stalled.
  assert.equal(waited(stalled), Math.min(actionRetryDelay(actionStallThreshold), actionStallRecheckMs));
  assert.equal(waited(stalled), actionStallDelay(actionStallThreshold));
  assert.ok(waited(stalled) <= actionStallRecheckMs);
  assert.equal(claimable(stalled, new Date(Date.parse(stalled.resolvedAt!) + actionStallRecheckMs + 1)), true);

  // It is reached quickly enough to be told to somebody inside the bound the fleet applies to a
  // row nobody is acting on at all: a row being attempted and getting nowhere is never the quieter
  // of the two failures.
  assert.equal(actionStallLatencyMs, actionRetryMinMs + actionRetryDelay(2));
  assert.ok(actionStallLatencyMs < actionIdleMs, 'a stall is classified inside the idle bound');

  // One reason that differs ends the run: something moved, so the row is retrying again and the
  // widening backoff — the right answer to a changing fault — comes back with it.
  const moved = fail(unchanged, 'reviewer agent review-claude-2 is busy in Herdr');
  assert.equal(actionStall(moved), null);
  assert.equal(moved.stall, undefined, 'and the row stops carrying a classification that no longer holds');
  assert.equal(waited(moved), actionRetryDelay(moved.attempts));

  // A row whose reason never repeats never stalls, however many attempts it makes: retrying is
  // exactly the right answer to a fault that keeps changing.
  const changing = structuredClone(item);
  reconcileActions(changing, [changing], new Date(clock));
  now = clock;
  for (let failure = 1; failure <= actionStallThreshold + 2; failure++) {
    const failed = fail(changing, `the launch failed for reason ${failure}`);
    assert.equal(actionStall(failed), null, 'a reason that changes between attempts is not a stall');
    assert.equal(waited(failed), actionRetryDelay(failure), 'and it keeps backing off on the widening interval');
  }
  assert.deepEqual(stalledActions(changing, new Date(now)), []);
  assert.equal(row.id, dispatchRow(unchanged).id, 'all of it on the one row the situation asked for');
});

// ---- AC-2: visible everywhere an actionable row is ------------------------------------------

test('integration:stalled-action-visible — master status names a stalled row with its reason and attempts instead of omitting it for being inside a backoff, the counts account for every open row, and the dashboard shows it on the item\'s own card', async () => {
  const item = await release(await created());
  const busy = 'reviewer agent review-claude-1 is busy in Herdr';
  for (let failure = 0; failure < actionStallThreshold; failure++) {
    await attempt(item, async () => busy);
    if (failure < actionStallThreshold - 1) await elapse(item, actionRetryMaxMs);
  }
  const stalled = await reload(item);
  const row = dispatchRow(stalled);
  assert.ok(row.stall, 'the row the control plane holds carries the classification');
  assert.equal(claimable(row, new Date()), false, 'and it is inside its backoff, so nothing can claim it now');

  // What `master status` prints under `actions`. The row is named with the reason it keeps failing
  // and the attempts it has made — the state that used to appear in no list and no count.
  const report = actionReport(await snapshotOf());
  assert.deepEqual(report.waiting.filter(entry => entry.key === stalled.key), [], 'a row inside a backoff is claimable by nobody, so it is not offered');
  const named = report.stalled.find(entry => entry.key === stalled.key)!;
  assert.ok(named, 'and it is named as stalled rather than omitted');
  assert.equal(named.kind, 'dispatch');
  assert.equal(named.stall!.reason, busy);
  assert.equal(named.stall!.failures, actionStallThreshold);
  assert.equal(named.attempts, actionStallThreshold);
  assert.equal(named.lastFailure, busy);
  assert.ok(Date.parse(named.retryAt!) > Date.now(), 'with the instant it is offered again');
  assert.ok(report.backoff.some(entry => entry.id === row.id), 'and it is counted among the rows waiting out a backoff');

  // Every open row is accounted for: the four states partition the queue, and a row backing off is
  // one of them rather than nothing at all.
  const queue = queueSnapshot(await store.list(), new Date());
  assert.equal(queue.backingOff, queue.backoff.length);
  assert.equal(queue.open, queue.pending + queue.claimed + queue.settling + queue.backingOff, 'the count a reader sees accounts for every open row');
  assert.ok(queue.open >= 1);
  assert.equal(queue.stalled.length, 1, 'and the stalled rows are named out of that whole, not counted beside it');

  // The dashboard. The card is drawn from the item's own document, so the classification on the row
  // is what it reads: the step that keeps failing, how often, and for how long.
  const now = Date.now();
  const status = plainStatus(stalled, now);
  assert.equal(status.tone, 'stuck', 'an item whose next step keeps failing is not quietly waiting');
  assert.match(status.sentence, /handing it to a builder has failed 3 times for the same reason/);
  assert.equal(status.blocking, stalledStep(stalled, now));
  const card = renderToStaticMarkup(createElement(WorkCard, { item: stalled, now, onOpen: () => {} }));
  assert.match(card, /handing it to a builder has failed 3 times for the same reason/i, 'the item\'s own card says so');
  assert.match(card, /tone-stuck/);
  // Nothing internal leaks into that copy: the reason itself is written for master status.
  assert.ok(!card.includes(busy));
});

// ---- AC-3: it reaches somebody --------------------------------------------------------------

test('integration:stall-raises-attention — a stalled row is raised as an attention item naming the item, the action kind, the unchanged reason and who resolves it, inside the idle bound a row nobody is acting on has', async () => {
  const item = await release(await created());
  const busy = 'every independent producer profile is busy or unavailable (ci-proofs: busy)';
  let last: ActionRow | undefined;
  for (let failure = 0; failure < actionStallThreshold; failure++) {
    last = await attempt(item, async () => busy);
    if (failure < actionStallThreshold - 1) await elapse(item, actionRetryMaxMs);
  }
  const snapshot = await snapshotOf();
  const raised = stalledActionAttention(snapshot).filter(entry => entry.subject === item.key);
  assert.equal(raised.length, 1, 'the stall reaches somebody, once');
  assert.match(raised[0].text, new RegExp(`^${item.key}'s dispatch action is stalled, retried only on a widening backoff`), 'naming the item and the action kind');
  assert.doesNotMatch(raised[0].text, /not retrying/, 'never claiming a row is not retried while it is claimed again (GY-185)');
  assert.ok(raised[0].text.includes(busy), 'and the unchanged reason it keeps failing with');
  assert.match(raised[0].text, new RegExp(`${actionStallThreshold} attempts in a row`));
  assert.match(raised[0].text, /and it has been open \d+s over 3 attempt\(s\)/);
  assert.equal(raised[0].role, 'master', 'resolved by an agent, never left to a human to notice');
  assert.equal(raised[0].human, false);
  assert.match(raised[0].next, /Clear what that reason names/);
  assert.match(raised[0].next, /claimed within one such interval of the condition clearing/);
  assert.match(raised[0].next, new RegExp(`up to ${actionStallMaxMs / 60_000} minutes`));

  // The bound. The row has not waited anything like the idle bound — it has been attempted three
  // times — and it is already in front of somebody: a fleet that cannot make progress is
  // diagnosable without reading action rows by hand.
  const openMs = Date.parse(snapshot.now) - Date.parse(last!.requestedAt);
  assert.ok(openMs < actionIdleMs, 'raised well inside the bound applied to a row nobody is acting on');
  assert.deepEqual(actionReport(snapshot).idle.filter(entry => entry.key === item.key), [], 'which the idle report alone would never have said: it can only see claimable rows');
  assert.ok(actionStallLatencyMs < actionIdleMs);
});

// ---- AC-4: backoff does not outlive the condition it was earned against ----------------------

test('integration:cleared-condition-retries-promptly — a row starved against a busy exclusive resource is claimed a recheck after the resource is freed, not at the ceiling its attempts against the impossibility had earned', async () => {
  const resource = `runner-${randomUUID()}`;
  const holder = await release(await created({ exclusiveResources: [resource] }));
  const held = await engine.execute(worker, 'claim', holder.id, {}, randomUUID());
  const starved = await release(await created({ exclusiveResources: [resource] }));

  // The condition: one exclusive resource, held by a live assignment. Every attempt on the starved
  // item runs into the control plane's own refusal, which is what its dispatch handler reports.
  const refusal = dispatchRefusal(starved, await store.list())!;
  assert.match(refusal, new RegExp(`^Dispatch blocked by exclusive resources: ${resource} held by ${holder.key}$`));

  // Six attempts against it, each one the same impossibility. Under the attempt count alone the
  // row has earned the ten-minute ceiling.
  let last: ActionRow | undefined;
  for (let failure = 0; failure < 6; failure++) {
    last = await attempt(starved, async () => dispatchRefusal(await reload(starved), await store.list())!);
    assert.equal(last.resolution, refusal, 'the same reason, attempt after attempt');
    if (failure < 5) await elapse(starved, actionRetryMaxMs);
  }
  assert.equal(last!.attempts, 6);
  assert.equal(actionStall(last!)!.reason, refusal);
  assert.equal(actionRetryDelay(last!.attempts), actionRetryMaxMs, 'the attempt count alone would hold it for ten minutes');
  // GY-185: the stall's own schedule, which grows with the unchanged run from the recheck — so a
  // condition that never clears is attempted less and less often — and is still shorter here than
  // the attempt count would have made it.
  assert.equal(waited(last!), actionStallDelay(6), 'the row waits on the stall schedule instead');
  assert.ok(waited(last!) < actionRetryMaxMs);

  // The resource is freed. Nothing touches the starved row: the condition it failed on has simply
  // stopped standing, and its dispatch would now succeed.
  await engine.execute(worker, 'release', holder.id, { epoch: held.epoch }, randomUUID());
  assert.equal(dispatchRefusal(await reload(starved), await store.list()), null, 'the condition has cleared');

  // Once the stall's wait runs out the row is claimed; the delay computed from attempts made while
  // it could not have succeeded never applies.
  await elapse(starved, waited(last!) + 1000);
  const claimed = await engine.claimNextAction(executor, { host: identity.host, kinds: ['dispatch'], work: starved.key }, randomUUID());
  assert.ok(claimed.action, 'claimed a recheck after the resource was freed');
  assert.equal(claimed.action!.attempts, 7);
  assert.ok(actionRetryMaxMs > waited(last!) + 1000, 'while the attempt-count schedule would still have been holding it');
  assert.equal(claimed.action!.stall!.reason, refusal, 'and the attempt is still recorded as one made against a standing stall');
});

// ---- AC-5: the docs say it ------------------------------------------------------------------

test('manual:stall-visibility-docs-review — docs state that a repeated identical failure is a stall rather than a retry, what the threshold is, where an operator sees one, and that it is the signal for a fleet that looks idle but is not', async () => {
  // Read as prose, not as source: emphasis and line wrapping are the author's, and an assertion
  // about either would fail on a reflow that changed no statement.
  const master = (await readMasterGuide()).replace(/[*`_]/g, '').replace(/\s+/g, ' ');
  const numbers: Record<number, string> = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five' };
  const threshold = new RegExp(`(${actionStallThreshold}|${numbers[actionStallThreshold]}) (consecutive )?(failures|identical failures)`, 'i');
  for (const [name, text] of [['master-agent.md', master]] as const) {
    assert.match(text, /stalled rather than retrying|stall, not a retry/i, `${name} states that a repeated identical failure is a stall rather than a retry`);
    assert.match(text, /unchanged reason/i, `${name} says what makes it one`);
    assert.match(text, threshold, `${name} states the threshold`);
    assert.match(text, /does not outlive it|never outlives it/i, `${name} states what the classification does to the backoff`);
  }
  assert.match(master, /actions\.stalled/, 'master-agent.md says where an operator sees one');
  assert.match(master, /on the item's own card/i, 'and on the dashboard');
  assert.match(master, /reads as idle and is not|looks idle/i, 'and that it is the signal for a fleet that looks idle but is not');
  assert.match(master, /read exactly like an item with nothing to do|no count and no list/i);
});

// ---- GY-185: delivered items owe nothing to retry, and an idle poll costs no lock ------------

const head = 'a'.repeat(40), base = 'b'.repeat(40);
let deliveries = 0;

/** A pending row the item does not need, as production's delivered items still held them. */
function leftover(item: Work, kind: 'dispatch' | 'merge', binding: string): ActionRow {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return { id: actionId(kind, item.id, binding), kind, work: item.id, key: item.key, binding, gate: kind === 'merge' ? 'merge' : 'build', refusal: null,
    inputs: kind === 'merge' ? { kind: 'merge', sha: head, baseSha: base, policyRevision: 1 } as any : { kind: 'dispatch', target: 'implementation', epoch: 1, priority: 0, plannedFiles: ['src/'] },
    reason: `${item.key} left over from before its delivery`, requestedBy: 'graphyard', requestedAt: at, state: 'pending', claim: null, attempts: 957,
    history: [{ at, event: 'requested', requester: 'graphyard', executor: null, result: null, reason: 'left over' }] };
}
/** Write rows (and optionally a queue entry and a stale next action) onto a stored item without touching its revision. */
async function seed(item: Work, rows: ActionRow[], extra: Record<string, unknown> = {}) {
  const current = await reload(item);
  const queue = { actions: [...(current.actionQueue?.actions ?? []), ...rows], history: current.actionQueue?.history ?? [] };
  await store.pool.query("UPDATE work_items SET document=(jsonb_set(document,'{actionQueue}',$2::jsonb) || $3::jsonb) WHERE id=$1", [item.id, JSON.stringify(queue), JSON.stringify(extra)]);
}
const pendingRows = (item: Work) => (item.actionQueue?.actions ?? []).filter(row => row.state === 'pending');
const queueEntry = (sequence: number) => ({ sequence, enqueuedAt: new Date().toISOString(), policyRevision: 1, speculation: null });

/** A submitted item with a passing CI, an approval and trusted evidence: queued for the merge it is about to get. */
async function queuedCandidate() {
  const n = ++deliveries;
  let w = await engine.execute(operator, 'create', null, { title: `Delivered ${n}`, plannedFiles: [`src/delivered-${n}.ts`], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, randomUUID());
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID()); w = await engine.execute(worker, 'claim', w.id, {}, randomUUID());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/stalled-delivery-${n}`, branch: `graphyard/stalled-delivery-${n}` }, randomUUID());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: 900 + n }, randomUUID());
  // Only this candidate is in the queue, so it is at its head.
  await store.pool.query("UPDATE work_items SET document=document-'queue' WHERE id<>$1 AND document->>'stage'<>'done'", [w.id]);
  const observation = (): Observation => ({ clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: 900 + n, branch: `graphyard/stalled-delivery-${n}`, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }],
    protected: true, mergeable: true, merged: false, mergeSha: null, files: [], scopeFiles: [], at: new Date().toISOString() });
  w = await engine.observe(w.id, w.revision, observation());
  w = await engine.execute(ci, 'evidence', w.id, { proof: 'integration:claim-safety', sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 5, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } }, randomUUID());
  const speculation: QueueSpeculation = { ref: queueRef(w.key), tip: head, base, baseTree: '7e'.repeat(20), predecessors: [], policyRevision: w.policyRevision, publishedAt: new Date().toISOString() };
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{queue,speculation}',$2::jsonb) WHERE id=$1", [w.id, JSON.stringify(speculation)]);
  w = await engine.observe(w.id, (await reload(w)).revision, observation());
  return { work: w, observation };
}

/** What a delivered item must look like after any path delivered it: nothing left to retry. */
function assertSettled(item: Work, path: string) {
  assert.equal(item.stage, 'done', `${path}: delivered`);
  assert.ok(item.nextAction === null || item.nextAction?.kind === 'verify-deployment', `${path}: the next action is the deployment it owes or nothing, not ${item.nextAction?.kind}`);
  assert.deepEqual(pendingRows(item).map(row => row.kind), [], `${path}: no pending row is left to retry`);
  assert.ok(item.actionQueue!.history.some(row => row.kind === 'dispatch' && /no longer needs this action|now needs/.test(row.resolution ?? '')), `${path}: the leftover row was retired with a reason`);
  assert.equal(item.queue ?? null, null, `${path}: the merge-queue entry is cleared`);
}

test('integration:done-retires-actions — an item delivered by the gated merge observation or by the direct-merge sweep has its next action recomputed, its pending rows retired and its queue entry cleared in the same transaction', async () => {
  // The gated path: an authorized, verified, committed merge, observed.
  const { work: queued, observation } = await queuedCandidate();
  assert.ok(queued.queue, 'the candidate holds a merge-queue entry');
  assert.equal(queued.nextAction?.kind, 'merge', 'and its next action is the merge');
  await seed(queued, [leftover(queued, 'dispatch', 'dispatch:0')]);
  const granted = await engine.acquireMerge(coordinator, queued.id, { expectedRevision: (await reload(queued)).revision, sha: head, baseSha: base, policyRevision: queued.policyRevision }, randomUUID());
  await engine.verifyMerge(coordinator, queued.id, { executionId: granted.execution.id }, { ...observation(), prState: 'open', draft: false }, randomUUID());
  const committed = await engine.commitMerge(coordinator, queued.id, { executionId: granted.execution.id }, randomUUID());
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  const merged = await engine.observe(queued.id, committed.revision, { ...observation(), merged: true, mergedAt, mergeSha: 'e'.repeat(40) });
  assertSettled(merged, 'gated merge observation');
  assertSettled(await reload(queued), 'gated merge observation, as stored');

  // The direct-merge sweep: an item held for a merge no execution authorized, with a queue entry,
  // a merge row and a dispatch row, delivered because the merge fell inside a window.
  const { work: held, observation: heldObservation } = await queuedCandidate();
  const heldMerge = await engine.observe(held.id, (await reload(held)).revision, { ...heldObservation(), merged: true, mergedAt: '2026-02-01T10:00:00Z', mergeSha: 'f'.repeat(40), prState: 'closed' });
  assert.notEqual(heldMerge.stage, 'done', 'held with the unauthorized-merge violation');
  await seed(held, [leftover(held, 'dispatch', 'dispatch:0'), leftover(held, 'merge', 'merge:stale')], { queue: queueEntry(9000) });
  const window: DirectMergeWindow = { since: '2026-01-01T00:00:00.000Z', until: null, reason: 'merges straight into main', setBy: operator.id, enabledAt: new Date().toISOString(), source: 'setting', event: null };
  const swept = await store.transaction(async (db, now) => sweepDirectMerges(db, (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(row => row.document), [window], now));
  assert.deepEqual(swept.map(item => item.key), [held.key]);
  assertSettled(await reload(held), 'direct-merge sweep');
  assert.ok((await reload(held)).actionQueue!.history.some(row => row.kind === 'merge' && row.id === actionId('merge', held.id, 'merge:stale')), 'the leftover merge row too');
});

test('integration:done-rows-never-claimed — a done item\'s pending dispatch and merge rows are never offered, reconcile retires them and its queue entry, and a row failing for one unchanged reason is not claimed again before a backoff that grows with each failure', async () => {
  // A delivered item as production held 44 of them: a pending dispatch and a pending merge, a
  // queue entry, and a next action from before its delivery.
  const { work: queued, observation } = await queuedCandidate();
  const granted = await engine.acquireMerge(coordinator, queued.id, { expectedRevision: (await reload(queued)).revision, sha: head, baseSha: base, policyRevision: queued.policyRevision }, randomUUID());
  await engine.verifyMerge(coordinator, queued.id, { executionId: granted.execution.id }, { ...observation(), prState: 'open', draft: false }, randomUUID());
  const committed = await engine.commitMerge(coordinator, queued.id, { executionId: granted.execution.id }, randomUUID());
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  const done = await engine.observe(queued.id, committed.revision, { ...observation(), merged: true, mergedAt, mergeSha: 'c'.repeat(40) });
  assert.equal(done.stage, 'done');
  const dispatch = leftover(done, 'dispatch', 'dispatch:0'), merge = leftover(done, 'merge', 'merge:stale');
  await seed(done, [dispatch, merge], { queue: queueEntry(9001), nextAction: { kind: 'merge', work: done.id, key: done.key, gate: 'merge', refusal: null, reason: 'stale', inputs: merge.inputs, llmRole: null, binding: 'merge:stale' } });

  // Never claimable: not through the model, not through the control plane, whoever asks.
  const stored = await reload(done);
  assert.deepEqual(pendingRows(stored).map(row => row.kind).sort(), ['dispatch', 'merge'], 'the rows are there to be offered');
  assert.deepEqual(openActions(await store.list(), new Date()).filter(entry => entry.work.id === done.id), [], 'openActions offers none of them');
  assert.equal(claimAction(await store.list(), identity, new Date(), { work: done.key }), null, 'claimAction takes none of them');
  const polled = await engine.claimNextAction(executor, { host: identity.host, kinds: ['dispatch', 'merge'], work: done.key }, randomUUID());
  assert.equal(polled.action, null, 'and an executor polling for them is given nothing');

  // Reconcile retires them, and the queue entry and stale action with them.
  await engine.reconcile();
  const settled = await reload(done);
  assert.deepEqual(pendingRows(settled), [], 'no pending row remains');
  assert.equal(settled.actionQueue!.actions.length, 0);
  for (const row of [dispatch, merge]) {
    const retired = settled.actionQueue!.history.find(entry => entry.id === row.id);
    assert.ok(retired, `the ${row.kind} row is retired to history`);
    assert.equal(retired!.history.at(-1)!.event, 'cancelled');
  }
  assert.equal(settled.queue, null, 'the queue entry is cleared');
  assert.equal(settled.nextAction, null, 'the next action is recomputed');
  const revision = settled.revision;
  await engine.reconcile();
  assert.equal((await reload(done)).revision, revision, 'a settled delivery is not rewritten on every tick');

  // A row on an open item that keeps failing for one unchanged reason: never claimed inside its
  // backoff, and each identical failure past the threshold waits longer than the one before.
  const item = await release(await created());
  const reason = 'Dispatch blocked: the same condition every time';
  const waits: number[] = [];
  for (let failure = 1; failure <= actionStallThreshold + 3; failure++) {
    const failed = await attempt(item, async () => reason);
    waits.push(waited(failed));
    const early = await engine.claimNextAction(executor, { host: identity.host, kinds: ['dispatch'], work: item.key }, randomUUID());
    assert.equal(early.action, null, `failure ${failure}: not claimed again inside its backoff`);
    await elapse(item, waited(failed) - 5_000);
    assert.equal((await engine.claimNextAction(executor, { host: identity.host, kinds: ['dispatch'], work: item.key }, randomUUID())).action, null, `failure ${failure}: nor just before it runs out`);
    await elapse(item, 5_000 + 1_000);
  }
  const stalledWaits = waits.slice(actionStallThreshold - 1);
  assert.equal(stalledWaits[0], actionStallRecheckMs, 'a stall starts from the recheck');
  for (let index = 1; index < stalledWaits.length; index++) assert.ok(stalledWaits[index] > stalledWaits[index - 1], `the wait grows with each identical failure: ${stalledWaits.join(', ')}`);
  assert.deepEqual(stalledWaits, stalledWaits.map((_wait, index) => actionStallDelay(actionStallThreshold + index)));
  assert.equal(actionStallDelay(1000), actionStallMaxMs, 'up to a ceiling, so a condition that clears is still answered');
  assert.ok((await engine.claimNextAction(executor, { host: identity.host, kinds: ['dispatch'], work: item.key }, randomUUID())).action, 'and claimed once its backoff has run out');
});

/** Every statement the store runs while `run` does, from the pool and from every client it hands out. */
async function spyQueries<T>(run: () => Promise<T>) {
  const seen: { text: string; rows: any[] }[] = [];
  const pool = store.pool as any, query = pool.query, connect = pool.connect;
  const wrap = (target: any, original: any) => async (...args: any[]) => {
    const result = await original.apply(target, args);
    seen.push({ text: typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '', rows: result?.rows ?? [] });
    return result;
  };
  pool.query = wrap(pool, query);
  const clients: [any, any][] = [];
  // The pool's own query() checks a client out through connect() with a callback; those
  // statements are already seen through the pool's query, so only checked-out clients are wrapped.
  pool.connect = (...args: any[]) => {
    if (typeof args[0] === 'function') return connect.apply(pool, args);
    return connect.apply(pool, args).then((client: any) => { clients.push([client, client.query]); client.query = wrap(client, client.query); return client; });
  };
  try { return { result: await run(), seen }; }
  finally { pool.query = query; pool.connect = connect; for (const [client, original] of clients) client.query = original; }
}

test('integration:idle-claim-lock-free — a claim poll with nothing claimable takes no advisory lock and reads no work_items document; one with a claimable row takes the lock and claims it', async () => {
  const item = await release(await created());
  await attempt(item, async () => 'the handler refused');
  // Its only row is inside a backoff: nothing is claimable for this poll.
  const { result: idle, seen } = await spyQueries(() => engine.claimNextAction(executor, { host: identity.host, kinds: ['dispatch'], work: item.key }, randomUUID()));
  assert.equal(idle.action, null);
  assert.ok(seen.length > 0, 'the poll was observed');
  assert.deepEqual(seen.filter(entry => /pg_advisory/i.test(entry.text)).map(entry => entry.text), [], 'no advisory lock was taken');
  assert.deepEqual(seen.filter(entry => /\bBEGIN\b/i.test(entry.text)).map(entry => entry.text), [], 'no coordination transaction was opened');
  for (const entry of seen) {
    assert.doesNotMatch(entry.text, /SELECT\s+(w\.)?document\b/i, `no statement selected a document: ${entry.text.slice(0, 80)}`);
    for (const row of entry.rows) assert.equal(row.document, undefined, 'and no row carried one');
  }
  // With nothing narrowing it to one item, an idle fleet-wide poll for a kind nobody holds is the same.
  const fleet = await spyQueries(() => engine.claimNextAction(executor, { host: identity.host, kinds: ['reclaim'] }, randomUUID()));
  assert.equal(fleet.result.action, null);
  assert.equal(fleet.seen.some(entry => /pg_advisory|SELECT\s+(w\.)?document\b/i.test(entry.text)), false);

  // Once the backoff runs out the same poll finds the row, and only then takes the lock to claim it.
  await elapse(item, actionRetryMaxMs);
  const { result: busy, seen: claiming } = await spyQueries(() => engine.claimNextAction(executor, { host: identity.host, kinds: ['dispatch'], work: item.key }, randomUUID()));
  assert.ok(busy.action, 'the claimable row is claimed');
  assert.ok(claiming.some(entry => /pg_advisory_xact_lock/.test(entry.text)), 'under the coordination lock');
  const loaded = claiming.filter(entry => /SELECT document FROM work_items/.test(entry.text)).flatMap(entry => entry.rows);
  assert.deepEqual(loaded.map(row => row.document.id), [item.id], 'loading only the item that holds it');
});
