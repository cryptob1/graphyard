import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';
import { claimAction, reconcileActions, settleAction, type ActionRow } from '../src/model/actions.js';
import { actionIdleMs, actionRetryDelay, actionRetryMaxMs, actionRetryMinMs, actionStall, actionStallLatencyMs, actionStallRecheckMs, actionStallThreshold, claimable, queueSnapshot, stalledActions } from '../src/model/action-progress.js';
import { assertDispatchable } from '../src/master.js';
import { actionReport, stalledActionAttention } from '../src/cli/master-status.js';
import { plainStatus, stalledStep } from '../web/plain-status.js';
import WorkCard from '../web/components/work-card.js';

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
  engine.principals = [operator, worker, executor];
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

  // A stall is a recheck, never a widening penalty: the row is offered again inside the fixed
  // interval however many attempts it has made against the same condition.
  assert.equal(waited(stalled), Math.min(actionRetryDelay(actionStallThreshold), actionStallRecheckMs));
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
  assert.match(card, /handing it to a builder has failed 3 times for the same reason/, 'the item\'s own card says so');
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
  assert.match(raised[0].text, new RegExp(`^${item.key}'s dispatch action is stalled, not retrying`), 'naming the item and the action kind');
  assert.ok(raised[0].text.includes(busy), 'and the unchanged reason it keeps failing with');
  assert.match(raised[0].text, new RegExp(`${actionStallThreshold} attempts in a row`));
  assert.match(raised[0].text, /and it has been open \d+s over 3 attempt\(s\)/);
  assert.equal(raised[0].role, 'master', 'resolved by an agent, never left to a human to notice');
  assert.equal(raised[0].human, false);
  assert.match(raised[0].next, /Clear what that reason names/);
  assert.match(raised[0].next, /claimed a minute after the condition clears/);

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
  assert.equal(waited(last!), actionStallRecheckMs, 'the row it earned against an impossibility waits a recheck instead');

  // The resource is freed. Nothing touches the starved row: the condition it failed on has simply
  // stopped standing, and its dispatch would now succeed.
  await engine.execute(worker, 'release', holder.id, { epoch: held.epoch }, randomUUID());
  assert.equal(dispatchRefusal(await reload(starved), await store.list()), null, 'the condition has cleared');

  // One recheck interval later the row is claimed. The delay computed from attempts made while it
  // could not have succeeded — still more than eight minutes of it left to run — never applies.
  await elapse(starved, actionStallRecheckMs + 1000);
  const claimed = await engine.claimNextAction(executor, { host: identity.host, kinds: ['dispatch'], work: starved.key }, randomUUID());
  assert.ok(claimed.action, 'claimed a recheck after the resource was freed');
  assert.equal(claimed.action!.attempts, 7);
  assert.ok(actionRetryMaxMs > actionStallRecheckMs + 1000, 'while the attempt-count schedule would still have been holding it');
  assert.equal(claimed.action!.stall!.reason, refusal, 'and the attempt is still recorded as one made against a standing stall');
});

// ---- AC-5: the docs say it ------------------------------------------------------------------

test('manual:stall-visibility-docs-review — docs state that a repeated identical failure is a stall rather than a retry, what the threshold is, where an operator sees one, and that it is the signal for a fleet that looks idle but is not', async () => {
  // Read as prose, not as source: emphasis and line wrapping are the author's, and an assertion
  // about either would fail on a reflow that changed no statement.
  const prose = async (page: string) => (await readFile(new URL(`../docs/${page}`, import.meta.url), 'utf8')).replace(/[*`_]/g, '').replace(/\s+/g, ' ');
  const architecture = await prose('architecture.md'), master = await prose('master-loop.md');
  const numbers: Record<number, string> = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five' };
  const threshold = new RegExp(`(${actionStallThreshold}|${numbers[actionStallThreshold]}) (consecutive )?(failures|identical failures)`, 'i');
  for (const [name, text] of [['architecture.md', architecture], ['master-loop.md', master]] as const) {
    assert.match(text, /stalled rather than retrying|stall, not a retry/i, `${name} states that a repeated identical failure is a stall rather than a retry`);
    assert.match(text, /unchanged reason/i, `${name} says what makes it one`);
    assert.match(text, threshold, `${name} states the threshold`);
    assert.match(text, /does not outlive it|never outlives it/i, `${name} states what the classification does to the backoff`);
  }
  assert.match(master, /actions\.stalled/, 'master-loop.md says where an operator sees one');
  assert.match(master, /on the item's own card/i, 'and on the dashboard');
  assert.match(master, /reads as idle and is not|looks idle/i, 'and that it is the signal for a fleet that looks idle but is not');
  assert.match(architecture, /read exactly like an item with nothing to do|no count and no list/i);
});
