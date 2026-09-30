import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Observation, Principal, Work } from '../src/model.js';
import {
  attachCommand, boundHeads, endedRuntimeStates, overlongSessions, roleSessionMaximumMs, sessionClosureBoundMs,
  sessionLiveness, sessionReconcileIntervalMs, sessionRole, sessionVanishGraceMs, supersededSession,
  type RuntimeSession, type SessionHandle,
} from '../src/model/sessions.js';
import { runtimeEndedSessionStates, runtimeEndedStates } from '../src/harness.js';
import { closureHandle, dispatchEffects, emptyDispatchCursor, launchedSessionHandle, reconcileSessionLiveness, runDispatchTick, sessionHandleKey, type DispatchEffects } from '../src/auto-dispatch.js';
import { stoppedStates } from '../src/master-daemon.js';
import { queueRef, type QueueSpeculation } from '../src/merge-queue.js';
import { masterConfigSchema, profileSessions } from '../src/master.js';
import { sessionReport } from '../src/cli/master-status.js';
import { overlongSessionAttention } from '../src/cli/overlong-sessions.js';
import { lostAfterReports, sessionLaunchGraceMs } from '../src/model/session-state.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-113: a session was recorded as running until something ended it, so a session that crashed,
 * was killed, or whose runtime dropped it stayed recorded as running for good — and every reader
 * believed the record, including the launcher's own busy check, which is why a dead session held
 * its role slot until a person noticed.
 *
 * Each test that produces a proof is named for it, so acceptance evidence maps to one executed case
 * per proof: integration:dead-session-reconciled, integration:slot-released-on-death,
 * integration:superseded-session-closed, unit:overlong-session-surfaced and
 * manual:session-liveness-docs-review.
 *
 * The dispatcher under test is the one `master run` builds; only the launchers and the runtime
 * inventory each tick reads are stubbed, because a runtime that no longer reports a session is
 * exactly the input the sweep exists to read.
 */

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'agent-a', role: 'worker', runtime: 'claude' };
const coordinator: Principal = { id: 'executor-a', role: 'coordinator' };
const producer: Principal = { id: 'ci-runner', role: 'producer', proofs: ['integration:session-liveness'] };
const PROOF = 'integration:session-liveness';
const head = 'a'.repeat(40), base = 'b'.repeat(40), nextHead = 'd'.repeat(40), mergeSha = 'c'.repeat(40);
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);

let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  // An offset no other test file takes: two files sharing a port fail whichever starts its
  // Postgres second, in its `before` hook, with no reason given.
  const port = Number(process.env.GRAPHYARD_SESSION_LIVENESS_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 73);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('session-liveness'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [operator, worker, coordinator, producer];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const reload = async (item: Work | string) => (await store.list()).find(entry => entry.id === (typeof item === 'string' ? item : item.id))!;
let sequence = 0;
async function created(overrides: Record<string, unknown> = {}) {
  return engine.execute(operator, 'create', null, { title: `Session liveness ${++sequence}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }], ...overrides }, randomUUID());
}
/** An item whose only proof is a manual one no producer may run, so its candidate raises a review request and no producer request. */
const reviewOnly = { criteria: [{ id: 'AC-1', text: 'Read it', proofs: ['manual:by-hand'] }] };
async function submitted(overrides: Record<string, unknown> = {}) {
  let item = await engine.execute(operator, 'ready', (await created(overrides)).id, {}, randomUUID());
  item = await engine.execute(worker, 'claim', item.id, {}, randomUUID());
  item = await engine.execute(worker, 'workspace', item.id, { epoch: item.epoch, host: 'machine-a', path: `/tmp/liveness/${item.id}`, branch: `graphyard/${item.key.toLowerCase()}-${item.epoch}` }, randomUUID());
  return engine.execute(worker, 'submit', item.id, { epoch: item.epoch, pr: Number(item.key.slice(3)) }, randomUUID());
}
function observation(item: Work, overrides: Partial<Observation> = {}): Observation {
  return {
    clockOffset: { min: 0, max: 0 },
    candidate: { sha: head, baseSha: base, pr: item.submission!.pr, branch: item.workspaces.at(-1)!.branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [], protected: true, mergeable: true,
    merged: false, mergeSha: null, files: ['src/loop.ts'], scopeFiles: [], at: new Date().toISOString(),
    prState: 'open', draft: false, baseTip: base, baseTree: sha40('7e'), baseTipContained: true, ...overrides,
  };
}

const fleetConfig = masterConfigSchema.parse({
  version: 1, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: '/outside/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 15368, hostId: 'host-1', masterAgentName: 'm', herdrWorkspace: 'wF',
  workers: [{ name: 'claude-worker', principal: worker.id, agentName: 'work-claude', mode: 'launch', kind: 'claude', credentialFile: '/outside/worker.token', approvals: 'auto' }],
  reviewer: { appId: 4242, installationId: 99, slug: 'graphyard-reviewer', credentialFile: '/outside/reviewer.json', boundAt: '2026-09-01T00:00:00.000Z' },
  reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude', kind: 'claude', approvals: 'auto' }],
  producers: [{ name: 'claude-producer', principal: producer.id, agentName: 'proof-claude', kind: 'claude', credentialFile: '/outside/producer.token', approvals: 'auto' }],
  run: { reviewerProfile: 'claude-reviewer' },
});

/**
 * The dispatcher `master run` builds, reached through the coordinator mutation the loop passes it,
 * with only the outside world stubbed: the runtime inventory, the ledger reconciliations and the
 * two launchers. `agents` is a live closure, so a test kills a session by taking it out of the list.
 */
function dispatcher(items: () => Promise<Work[]>, runtime: () => RuntimeSession[] | null, now: () => number = Date.now, overrides: Partial<DispatchEffects> = {}): DispatchEffects {
  const production = dispatchEffects('/outside', () => fleetConfig, {
    // The tick reads its clock from the snapshot the control plane answered with, so a test that
    // moves time past the grace moves it here.
    snapshot: async () => ({ work: await items(), now: new Date(now()).toISOString() }),
    mutate: async (path: string, body: unknown) => {
      const [, id, command] = path.split('/');
      return engine.execute(coordinator, command as any, id, body, randomUUID());
    },
    run: () => { throw new Error('this test reaches no launcher of its own'); },
  });
  return {
    ...production,
    agents: () => runtime() as any,
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    reconcileReviews: async () => ({ reviews: [] }),
    reconcileProducers: async () => ({ producers: [] }),
    launchReview: async () => ({ pane: 'pane-review' }),
    launchProducer: async () => ({ pane: 'pane-proof' }),
    persist: async () => {},
    ...overrides,
  };
}

/**
 * Work delivered the way production reaches it — an authorized, verified, independently observed
 * merge — while a review session it launched is still running. The handle is recorded before the
 * merge, because a delivered item accepts no new one: what is under test is that the record of a
 * session the item outran can still be closed.
 */
async function delivered(sessionId: string) {
  let item = await submitted();
  const approved = (overrides: Partial<Observation> = {}): Observation => ({ ...observation(item, overrides), reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }] });
  item = await engine.observe(item.id, (await reload(item)).revision, approved());
  await engine.execute(coordinator, 'session', item.id, { id: sessionId, kind: 'review', runtime: 'claude', host: 'host-1', agentName: 'review-claude',
    pane: `pane-${sessionId}`, role: 'review', head, subject: `${item.key}: review ${head.slice(0, 12)}`, state: 'running' }, randomUUID());
  item = await engine.execute(producer, 'evidence', item.id, { proof: PROOF, sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 5, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } }, randomUUID());
  // One candidate is in the queue at a time; nothing else in this file is waiting behind it.
  await store.pool.query("UPDATE work_items SET document=document-'queue' WHERE id<>$1 AND document->>'stage'<>'done'", [item.id]);
  const speculation: QueueSpeculation = { ref: queueRef(item.key), tip: head, base, baseTree: sha40('7e'), predecessors: [], policyRevision: item.policyRevision, publishedAt: new Date().toISOString() };
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{queue,speculation}',$2::jsonb) WHERE id=$1", [item.id, JSON.stringify(speculation)]);
  item = await engine.observe(item.id, (await reload(item)).revision, approved());
  const committed = await engine.requestEnqueue(coordinator, item.id, { enqueue: true, expectedRevision: item.revision, sha: head, baseSha: base, policyRevision: item.policyRevision }, randomUUID());
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  return engine.observe(item.id, committed.revision, approved({ merged: true, mergeSha: sha40('de11'), mergedAt }));
}

const running = async (item: Work) => (await reload(item)).sessions!.filter(handle => handle.state === 'running');
const handleOf = async (item: Work, id: string) => (await reload(item)).sessions!.find(handle => handle.id === id)!;

// ---- AC-1: the record is reconciled against the runtime ---------------------------------------

test('integration:dead-session-reconciled — a session the runtime no longer reports is closed with an outcome naming that it vanished, by a sweep on a bounded interval rather than by anything reporting in', async () => {
  const item = await submitted();
  // A coordination session, so nothing but liveness decides it: recorded running, with the runtime
  // coordinates its launcher registered — the pane it holds and the runtime's own name for it.
  const handle = { id: 'coordination-1', kind: 'coordination' as const, runtime: 'claude', host: 'host-1', workspace: 'wF',
    agentName: 'watch-claude', pane: 'pane-77', attach: 'herdr pane attach pane-77 --workspace wF',
    transcript: '/home/agent/.claude/coordination.jsonl', subject: `${item.key}: shepherding the candidate`, state: 'running' as const };
  await engine.execute(coordinator, 'session', item.id, handle, randomUUID());
  assert.equal((await handleOf(item, handle.id)).state, 'running');
  assert.equal((await handleOf(item, handle.id)).agentName, 'watch-claude', 'the launcher registered the name the runtime listing is matched against');

  // One cursor across the ticks, as the loop keeps one: what a sweep observed about the runtime is
  // what the next sweep measures its grace against.
  const cursor = emptyDispatchCursor(fleetConfig);
  const snapshot = async () => [await reload(item)];
  const key = sessionHandleKey(item.id, handle.id);

  // While the runtime reports the pane, the record is believed: the sweep closes nothing.
  const listed: RuntimeSession[] = [{ name: 'watch-claude', pane_id: 'pane-77', agent_status: 'working' }];
  const effects = dispatcher(snapshot, () => listed);
  const before = await runDispatchTick(fleetConfig, cursor, effects);

  assert.deepEqual(before.closed, [], 'a live session is not touched');
  assert.deepEqual(cursor.sessionMisses, {}, 'and the runtime reported it, so nothing is missing');
  assert.equal((await handleOf(item, handle.id)).state, 'running');

  // A session sitting at its prompt is live, whatever Herdr calls it. `done` is the at-prompt state
  // a headless fleet sees most — the same underlying state as `idle`, differing only in whether
  // somebody focused the tab — and closing its handle would take the attach command away at the
  // one moment somebody needs it.
  for (const state of ['done', 'idle', 'blocked']) {
    const at = () => Date.now() + 86_400_000;
    listed[0] = { name: 'watch-claude', pane_id: 'pane-77', agent_status: state };
    const tick = await runDispatchTick(fleetConfig, cursor, dispatcher(snapshot, () => listed, at), at);
    assert.deepEqual(tick.closed, [], `a session reported ${state} is waiting at its prompt, however long it has waited`);
  }
  listed[0] = { name: 'watch-claude', pane_id: 'pane-77', agent_status: 'working' };

  // The session dies: its pane is gone from the runtime's listing. Nothing reports that — a session
  // that died reports nothing, which is the whole reason this is a sweep — and the record stands
  // until the sweep contradicts it.
  listed.length = 0;
  const young = await runDispatchTick(fleetConfig, cursor, effects);
  assert.deepEqual(young.closed, [], 'a handle younger than the grace is left alone; its runtime may simply not have listed it yet');
  assert.deepEqual(Object.keys(cursor.sessionMisses), [key], 'the sweep records the first tick that missed it');

  // One listing that comes back short is not a death: the runtime reports the pane again, the
  // grace starts over, and a sweep a day later still finds a live session.
  listed.push({ name: 'watch-claude', pane_id: 'pane-77', agent_status: 'working' });
  const tomorrow = () => Date.now() + 86_400_000;
  const recovered = await runDispatchTick(fleetConfig, cursor, dispatcher(snapshot, () => listed, tomorrow), tomorrow);
  assert.deepEqual(recovered.closed, [], 'a session the runtime reports again is not gone, whatever the last tick missed');
  assert.deepEqual(cursor.sessionMisses, {}, 'and it is no longer missing, so the grace is counted afresh');

  // Gone for good this time. Past the grace, on the next sweep, and within the bound the loop
  // declares: the record closes.
  listed.length = 0;
  const missedAt = Date.parse((await handleOf(item, handle.id)).updatedAt) + 1000;
  const missed = await runDispatchTick(fleetConfig, cursor, dispatcher(snapshot, () => listed, () => missedAt), () => missedAt);
  assert.deepEqual(missed.closed, [], 'the sweep that first misses it closes nothing');
  const late = new Date(missedAt + sessionVanishGraceMs + 1000);
  assert.ok(late.getTime() - missedAt <= sessionClosureBoundMs, `the closure lands inside the ${sessionClosureBoundMs}ms bound`);
  const swept = await runDispatchTick(fleetConfig, cursor, dispatcher(snapshot, () => listed, () => late.getTime()), () => late.getTime());
  assert.equal(swept.closed.length, 1, `the sweep closed one record; it closed ${JSON.stringify(swept.closed)}`);
  assert.deepEqual([swept.closed[0].key, swept.closed[0].id, swept.closed[0].cause], [item.key, handle.id, 'vanished']);
  assert.deepEqual(swept.closeFailures, []);

  const closed = await handleOf(item, handle.id);
  assert.equal(closed.state, 'finished', 'the record no longer says running');
  assert.ok(closed.endedAt, 'and it carries when it ended');
  assert.match(closed.outcome!, /^vanished: the claude runtime on host-1 has not reported pane pane-77 for \d+s/, 'the outcome names that it vanished');
  assert.match(closed.outcome!, /after its last observed activity at/);
  assert.equal(attachCommand(closed), 'host-1:/home/agent/.claude/coordination.jsonl', 'and a closed session still links its transcript');
  const report = sessionReport({ work: await store.list(), now: late.toISOString() });
  assert.ok(!report.running.some(entry => entry.id === handle.id), 'no reader shows it running any more');
  assert.ok(report.finished.some(entry => entry.id === handle.id));

  // The sweep is idempotent and the bound is the dispatch interval it runs on, not a timer of its own.
  const againAt = () => late.getTime() + 60_000;
  const again = await runDispatchTick(fleetConfig, cursor, dispatcher(snapshot, () => listed, againAt), againAt);
  assert.deepEqual(again.closed, [], 'a record already closed is not closed twice');
  assert.deepEqual(cursor.sessionMisses, {}, 'and a closed handle is no longer tracked as missing');
  assert.equal(sessionClosureBoundMs, sessionVanishGraceMs + sessionReconcileIntervalMs);
  assert.ok(fleetConfig.run.dispatchIntervalSeconds * 1000 <= sessionReconcileIntervalMs, 'the sweep runs at least as often as the bound it declares');

  // The rule, directly: an unreadable runtime is never evidence that a session is gone, a handle
  // with no coordinate has nothing to be reconciled against, and neither is a handle this host's
  // runtime was never asked about.
  const live = { pane: 'pane-77', agentName: 'watch-claude', runtime: 'claude', host: 'host-1' };
  assert.equal(sessionLiveness(live, null), 'unknown');
  assert.equal(sessionLiveness({ pane: null, agentName: null, runtime: 'claude', host: 'host-1' }, []), 'unreconciled');
  assert.equal(sessionLiveness(live, []), 'vanished');
  assert.equal(sessionLiveness(live, [], runtimeEndedStates, 'host-1'), 'vanished');
  assert.equal(sessionLiveness(live, [], runtimeEndedStates, 'host-2'), 'unknown', 'this loop never asked the runtime on the host that launched it');
  assert.equal(sessionLiveness(live, [{ pane_id: 'pane-77', agent_status: 'killed' }]), 'ended');
  assert.equal(sessionLiveness(live, [{ pane_id: 'pane-77', agent_status: 'done' }]), 'live', 'a session waiting at a prompt still holds its pane');
  assert.equal(sessionLiveness(live, [{ pane_id: 'pane-77', agent_status: 'blocked' }]), 'live');
  assert.equal(sessionLiveness(live, [{ pane_id: 'pane-77', agent_status: 'idle' }]), 'live');
  const unreadable = reconcileSessionLiveness(await store.list(), null, new Date(late.getTime() + 86_400_000));
  assert.deepEqual(unreadable.closures.filter(closure => closure.cause === 'vanished'), [], 'an unreadable runtime would otherwise close every session on the graph at once');
  // The terminal vocabulary is the runtime's own, none of the at-prompt states are in it, and
  // Muse's names are not Claude's.
  for (const state of stoppedStates) assert.ok(!runtimeEndedStates('claude').includes(state), `${state} is a live session ready for input, not an ended one`);
  assert.deepEqual([...runtimeEndedStates('unknown-runtime')], [...endedRuntimeStates]);
  assert.ok(runtimeEndedStates('muse').includes('terminated') && !endedRuntimeStates.includes('terminated'));
  assert.ok(Object.keys(runtimeEndedSessionStates).includes('muse'));

  // A handle another host launched is left to that host's loop, however long this one has not
  // reported it: the slot it holds is that host's to free.
  await engine.execute(coordinator, 'session', item.id, { ...handle, id: 'coordination-elsewhere', host: 'host-2', pane: 'pane-99' }, randomUUID());
  const day = new Date(late.getTime() + 86_400_000);
  const foreignMisses = { [sessionHandleKey(item.id, 'coordination-elsewhere')]: late.toISOString() };
  const foreign = reconcileSessionLiveness([await reload(item)], [], day, { states: runtimeEndedStates, hostId: 'host-1', missing: foreignMisses });
  assert.deepEqual(foreign.closures, [], 'host-1 never asked the runtime on host-2');
  assert.deepEqual(foreign.missing, {}, 'and does not track a handle it cannot judge');
  const owner = reconcileSessionLiveness([await reload(item)], [], day, { states: runtimeEndedStates, hostId: 'host-2', missing: foreignMisses });
  assert.deepEqual(owner.closures.map(closure => [closure.id, closure.cause]), [['coordination-elsewhere', 'vanished']], 'the host that launched it closes it');
  await engine.execute(coordinator, 'session', item.id, { ...handle, id: 'coordination-elsewhere', host: 'host-2', pane: 'pane-99', state: 'finished', outcome: 'closed by its own host' }, randomUUID());

  // A runtime that still lists the session but reports it over is the same closure, said
  // differently — and only a runtime that reports exits at all has such a state to report.
  await engine.execute(coordinator, 'session', item.id, { ...handle, id: 'coordination-2', runtime: 'muse', pane: 'pane-78' }, randomUUID());
  const over = new Date(Date.now() + sessionVanishGraceMs + 1000);
  const listing = [{ name: 'watch-claude', pane_id: 'pane-78', agent_status: 'terminated' }];
  const ended = reconcileSessionLiveness([await reload(item)], listing, over, { states: runtimeEndedStates, hostId: 'host-1' });
  assert.deepEqual(ended.closures.map(closure => [closure.id, closure.cause]), [['coordination-2', 'ended']]);
  assert.match(ended.closures[0].outcome, /reports pane pane-78 as terminated, so the session is over/);
  assert.deepEqual(closureHandle(ended.closures[0]), { id: 'coordination-2', kind: 'coordination', runtime: 'muse', host: 'host-1', subject: handle.subject, state: 'finished', outcome: ended.closures[0].outcome });
  const atPrompt = reconcileSessionLiveness([await reload(item)], [{ name: 'watch-claude', pane_id: 'pane-78', agent_status: 'done' }], over, { states: runtimeEndedStates, hostId: 'host-1' });
  assert.deepEqual(atPrompt.closures, [], 'and a session the runtime still lists at its prompt is closed by nothing');
});

// ---- AC-2: a role slot is never held by a session that is not live ----------------------------

test('integration:slot-released-on-death — the launcher\'s busy check counts reconciled liveness, so a request refused for a busy name launches once the session holding it dies', async () => {
  // An item whose candidate needs a review and no producer session, so this test is about one slot.
  const held = await submitted(reviewOnly);
  await engine.observe(held.id, (await reload(held)).revision, observation(await reload(held)));
  const item = await reload(held);
  const review = item.autoDispatch!.review!;
  assert.equal(review.state, 'requested', 'the control plane asked for a review of this head');
  assert.deepEqual(item.autoDispatch!.producers, [], 'and asked for no producer session, so one slot is the whole story');

  // One reviewer profile, concurrency 1. A session it launched is recorded on another item, whose
  // own candidate asks for nothing, and is still reported by the runtime: the one slot is taken.
  const other = await submitted({ ...reviewOnly, policy: { checks: ['test'], review: false } });
  await engine.observe(other.id, (await reload(other)).revision, observation(await reload(other)));
  assert.equal((await reload(other)).autoDispatch?.review ?? null, null, 'nothing is requested for the item the busy session sits on');
  const busy = launchedSessionHandle('review', { ...review, id: 'review-elsewhere' }, `${other.key}: review elsewhere`, 'host-1', { pane: 'pane-90', agentName: 'review-claude' }, 'claude', 'wF');
  await engine.execute(coordinator, 'session', other.id, busy, randomUUID());
  assert.equal((await handleOf(other, 'review-elsewhere')).agentName, 'review-claude', 'the handle carries the runtime name its slot is counted under');

  const listed: RuntimeSession[] = [{ name: 'review-claude', pane_id: 'pane-90', agent_status: 'working' }];
  const snapshot = async () => [await reload(item), await reload(other)];
  // One cursor across the ticks, as the loop keeps one.
  const cursor = emptyDispatchCursor(fleetConfig);
  const refused = await runDispatchTick(fleetConfig, cursor, dispatcher(snapshot, () => listed));
  assert.deepEqual(refused.launched, [], 'nothing launched while a live session holds the name');
  const wait = refused.waiting.find(entry => entry.kind === 'review' && entry.work === item.key);
  assert.match(wait!.reason, /every reviewer profile is busy/, `the request waits on the limit; it waited on ${JSON.stringify(refused.waiting)}`);

  // The record alone holds the slot, even when this host's runtime has not listed the session: a
  // handle is the durable record of a live session, and it outlives a restart of the loop.
  const unlisted = await runDispatchTick(fleetConfig, cursor, dispatcher(snapshot, () => []));
  assert.deepEqual(unlisted.launched, [], 'a session the runtime has not listed yet still holds its slot inside the grace');
  assert.deepEqual(unlisted.closed, [], 'and is not judged dead for it');
  assert.deepEqual(Object.keys(cursor.sessionMisses), [sessionHandleKey(other.id, 'review-elsewhere')],
    'the sweep only notes that the runtime did not report it, for the next sweep to measure the grace against');

  // The session is killed. Past the grace the sweep closes its record, and the same tick launches
  // the request that was refused for that name — no hand-closed handle, no operator in between.
  const after = new Date(Date.parse((await handleOf(other, 'review-elsewhere')).updatedAt) + sessionVanishGraceMs + 1000);
  const launched = await runDispatchTick(fleetConfig, cursor, dispatcher(snapshot, () => [], () => after.getTime()), () => after.getTime());
  assert.deepEqual(launched.closed.map(closure => [closure.key, closure.id, closure.cause]), [[other.key, 'review-elsewhere', 'vanished']]);
  assert.deepEqual(launched.launched.map(entry => [entry.kind, entry.work, entry.profile]), [['review', item.key, 'claude-reviewer']],
    `the next request for that role launched rather than being refused; the tick waited on ${JSON.stringify(launched.waiting)}`);
  assert.equal((await handleOf(other, 'review-elsewhere')).state, 'finished');
  assert.match((await handleOf(other, 'review-elsewhere')).outcome!, /vanished/);

  // And the freshly launched session now holds the slot itself, under the name the launcher gave it.
  const fresh = (await running(item)).find(handle => handle.kind === 'review')!;
  assert.deepEqual([fresh.agentName, fresh.role, fresh.head], ['review-claude', 'review', review.sha]);
  assert.equal(profileSessions(fleetConfig.reviewers[0], [], [{ profile: 'claude-reviewer', agentName: fresh.agentName!, state: 'pending' }]).free, 1,
    'the ledger alone frees the slot when nothing lists the session, exactly as it did before; the handle is what now holds it');
  const againAt = () => after.getTime() + 1000;
  const busyAgain = await runDispatchTick(fleetConfig, cursor, dispatcher(snapshot, () => [{ name: 'review-claude', pane_id: 'pane-review', agent_status: 'working' }], againAt), againAt);
  assert.deepEqual(busyAgain.launched, [], 'and a second launch for the same profile waits on it');
});

// ---- AC-3: a session bound to something that moved on is ended --------------------------------

test('integration:superseded-session-closed — a review or proof session for a candidate that merged, a superseded head, or an item returned to a worker is closed with the reason, and one item never holds two live sessions for the same role and head', async () => {
  const at = new Date('2026-09-21T12:00:00.000Z');
  const sessionOn = async (item: Work, id: string, kind: 'review' | 'proof', sha: string, group?: 'integration') =>
    engine.execute(coordinator, 'session', item.id, {
      id, kind, runtime: 'claude', host: 'host-1', agentName: `${kind}-claude`, pane: `pane-${id}`,
      role: group ? `proof:${group}` : kind, head: sha, subject: `${item.key}: ${kind} ${sha.slice(0, 12)}`, state: 'running' as const,
    }, randomUUID());
  // The runtime still reports every one of these panes: supersession is the item's judgment, not
  // the runtime's, so a session that is alive and well is closed all the same.
  const alive = (item: Work) => (item.sessions ?? []).filter(handle => handle.state === 'running')
    .map(handle => ({ name: handle.agentName!, pane_id: handle.pane!, agent_status: 'working' }));

  // 1. The candidate merged. Nothing the session produces can bind a candidate any more.
  let merged = await submitted();
  await engine.observe(merged.id, (await reload(merged)).revision, observation(await reload(merged)));
  await sessionOn(await reload(merged), 'review-merged', 'review', head);
  merged = await reload(merged);
  await engine.observe(merged.id, merged.revision, { ...observation(merged), merged: true, mergeSha, mergedAt: at.toISOString() });
  merged = await reload(merged);
  const mergedClosures = reconcileSessionLiveness([merged], alive(merged), at, { states: runtimeEndedStates, hostId: 'host-1' }).closures;
  assert.equal(mergedClosures.length, 1, `exactly one closure; got ${JSON.stringify(mergedClosures)}`);
  assert.equal(mergedClosures[0].cause, 'superseded');
  assert.match(mergedClosures[0].outcome, new RegExp(`^superseded: the candidate it was bound to merged as ${mergeSha.slice(0, 12)}$`));

  // 2. A superseded head. The item observed a new candidate, so the session reads a commit nobody
  //    is waiting for; the reason names the head it held and the head that replaced it.
  let moved = await submitted();
  await engine.observe(moved.id, (await reload(moved)).revision, observation(await reload(moved)));
  await sessionOn(await reload(moved), 'proof-old-head', 'proof', head, 'integration');
  moved = await reload(moved);
  await engine.observe(moved.id, moved.revision, { ...observation(moved), candidate: { ...observation(moved).candidate, sha: nextHead } });
  moved = await reload(moved);
  assert.deepEqual(boundHeads(moved), [nextHead], 'the item holds one head, and it is not the one the session was launched for');
  const movedClosures = reconcileSessionLiveness([moved], alive(moved), at, { states: runtimeEndedStates, hostId: 'host-1' }).closures;
  assert.equal(movedClosures.length, 1, `exactly one closure; got ${JSON.stringify(movedClosures)}`);
  assert.deepEqual([movedClosures[0].cause, movedClosures[0].role], ['superseded', 'proof:integration']);
  assert.equal(movedClosures[0].outcome, `superseded: head ${head.slice(0, 12)} was superseded by ${nextHead.slice(0, 12)}`);

  // 3. The item went back to a worker. A session reading the old head is over whatever it is doing.
  let returned = await submitted();
  await engine.observe(returned.id, (await reload(returned)).revision, observation(await reload(returned)));
  await sessionOn(await reload(returned), 'review-returned', 'review', head);
  returned = await engine.execute(operator, 'rework', (await reload(returned)).id, { reason: 'the finding needs a new head', previousWorkerStopped: true }, randomUUID());
  returned = await engine.execute(worker, 'claim', returned.id, {}, randomUUID());
  assert.ok(returned.lease && returned.reworkRequested, 'the item is held by a worker again');
  const returnedClosures = reconcileSessionLiveness([returned], alive(returned), at, { states: runtimeEndedStates, hostId: 'host-1' }).closures;
  assert.equal(returnedClosures.length, 1, `exactly one closure; got ${JSON.stringify(returnedClosures)}`);
  assert.equal(returnedClosures[0].cause, 'superseded');
  assert.equal(returnedClosures[0].outcome, `superseded: ${returned.key} was returned to a worker for rework, so the next candidate is requested afresh`);
  // A live worker lease says the same thing once the rework flag is cleared by the next submission.
  const reclaimed = { ...structuredClone(returned), reworkRequested: false } as Work;
  assert.match(supersededSession(reclaimed, { kind: 'proof', head }, at)!, new RegExp(`^${returned.key} was returned to a worker \\(${worker.id} holds epoch ${returned.lease!.epoch}`));
  // An implementation session is never superseded here: its lease decides what it may still do,
  // and ending its handle would take the attach command away from a worker being stopped.
  assert.equal(supersededSession(returned, { kind: 'implementation', head }, at), null);

  // The loop writes each of those back through the coordinator mutation it already holds.
  const items = [merged, moved, returned].map(item => item.id);
  const tick = await runDispatchTick(fleetConfig, emptyDispatchCursor(fleetConfig),
    dispatcher(async () => Promise.all(items.map(id => reload(id))), () => [...alive(merged), ...alive(moved), ...alive(returned)], () => at.getTime()), () => at.getTime());
  assert.deepEqual(tick.closed.map(closure => closure.id).sort(), ['proof-old-head', 'review-merged', 'review-returned']);
  assert.ok(tick.closed.every(closure => closure.cause === 'superseded'));
  for (const id of items) assert.deepEqual(await running(await reload(id)), [], `nothing is left running on ${id}`);
  const stored = await handleOf(await reload(items[0]), 'review-merged');
  assert.deepEqual([stored.state, stored.role, stored.head], ['finished', 'review', head]);
  assert.match(stored.outcome!, /^superseded: the candidate it was bound to merged/);

  // And one item holds one live session per role and head: a second review of the same head
  // supersedes the first, while a second proof *group* on that head is its own slot and stands.
  let doubled = await submitted();
  await engine.observe(doubled.id, (await reload(doubled)).revision, observation(await reload(doubled)));
  await sessionOn(await reload(doubled), 'review-first', 'review', head);
  await sessionOn(await reload(doubled), 'proof-integration', 'proof', head, 'integration');
  await sessionOn(await reload(doubled), 'review-second', 'review', head);
  doubled = await reload(doubled);
  const duplicates = reconcileSessionLiveness([doubled], alive(doubled), at, { states: runtimeEndedStates, hostId: 'host-1' }).closures;
  assert.deepEqual(duplicates.map(closure => [closure.id, closure.cause]), [['review-first', 'duplicate']],
    `only the older session for the doubled slot closes; got ${JSON.stringify(duplicates)}`);
  assert.equal(duplicates[0].outcome, `superseded: session review-second holds the same role (review) on head ${head.slice(0, 12)}, and one item holds one live session per role and head`);
  assert.equal(sessionRole({ kind: 'proof', role: 'proof:integration' }), 'proof:integration');
  assert.equal(sessionRole({ kind: 'review', role: null }), 'review', 'a handle with no registered slot occupies the one its kind names');
  // Two implementation handles under one attempt are the worker's own record of its sessions, not
  // a doubled slot: an implementation session is no more collapsed here than it is superseded
  // above, because its lease is what says which attempt may still act.
  const attempt = (id: string): SessionHandle => ({ ...structuredClone(doubled.sessions!.find(handle => handle.id === 'review-first')!), id, kind: 'implementation', role: null, state: 'running' });
  const attempts = { ...structuredClone(doubled), sessions: [attempt('impl-first'), attempt('impl-second')] } as Work;
  assert.deepEqual(reconcileSessionLiveness([attempts], alive(attempts), at, { states: runtimeEndedStates, hostId: 'host-1' }).closures, [],
    'an implementation handle is never closed as a duplicate of another attempt session');

  // A delivered item is the largest population of stale `running` records there is: a review or a
  // proof session is usually still running when its candidate merges. Delivery makes an item's
  // decisions immutable, and closing a handle is not a decision — it binds no candidate, decides
  // no gate and ends no lease — so the sweep's closure is written back like any other. A refusal
  // here would leave the record running for good and retry every tick, which is the exact
  // condition GY-113 exists to end.
  const landed = await delivered('review-delivered');
  assert.equal(landed.stage, 'done', `the item is delivered; it is ${landed.stage}`);
  assert.equal((await handleOf(landed, 'review-delivered')).state, 'running', 'and it carried a running review session across the merge');
  const deliveredSweep = reconcileSessionLiveness([landed], alive(landed), at, { states: runtimeEndedStates, hostId: 'host-1' });
  assert.deepEqual(deliveredSweep.closures.map(closure => [closure.id, closure.cause]), [['review-delivered', 'superseded']]);
  assert.equal(deliveredSweep.closures[0].outcome, `superseded: ${landed.key} was delivered, so nothing this session produces can bind a candidate`);
  const deliveredTick = await runDispatchTick(fleetConfig, emptyDispatchCursor(fleetConfig),
    dispatcher(async () => [await reload(landed)], () => alive(landed), () => at.getTime()), () => at.getTime());
  assert.deepEqual(deliveredTick.closeFailures, [], 'the closure is written back, not refused as a mutation of delivered work');
  assert.deepEqual(deliveredTick.closed.map(closure => closure.id), ['review-delivered']);
  const settled = await handleOf(landed, 'review-delivered');
  assert.equal(settled.state, 'finished', 'the record on the delivered item is closed, which is what AC-3 asks for');
  assert.match(settled.outcome!, /was delivered, so nothing this session produces can bind a candidate$/);
  assert.equal((await reload(landed)).stage, 'done', 'and the delivery itself is untouched');
  assert.deepEqual((await reload(landed)).violations, [], 'no gate was re-judged by the closure');
  const quiet = await runDispatchTick(fleetConfig, emptyDispatchCursor(fleetConfig),
    dispatcher(async () => [await reload(landed)], () => alive(landed), () => at.getTime()), () => at.getTime());
  assert.deepEqual([quiet.closed, quiet.closeFailures], [[], []], 'and the next tick has nothing left to say about it');
  // Every other write a delivered item refuses is refused as before: only the closure of a handle
  // it already carries passes, and only as a closure.
  await assert.rejects(engine.execute(coordinator, 'session', landed.id, { id: 'review-after-delivery', kind: 'review', runtime: 'claude', host: 'host-1', subject: 'a new session on delivered work', state: 'running' }, randomUUID()),
    /Delivered work is immutable/, 'no new session may be recorded on a delivered item');
  await assert.rejects(engine.execute(coordinator, 'session', landed.id, { id: 'review-delivered', kind: 'review', runtime: 'claude', host: 'host-1', subject: 'reopened', state: 'running' }, randomUUID()),
    /Delivered work is immutable/, 'and a closed handle cannot be reopened to hold a slot again');
});


// ---- AC-4: a session that outlives its role's maximum is surfaced -----------------------------

test('unit:overlong-session-surfaced — a session past its role\'s maximum is surfaced as an attention item naming the item, the role, its age and its last observed activity, whether or not it is live', () => {
  const now = new Date('2026-09-21T12:00:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const handle = (over: Partial<SessionHandle>): SessionHandle => ({
    id: 'session-1', kind: 'review', principal: 'reviewer-1', epoch: null, runtime: 'claude', host: 'vishrog',
    workspace: 'wF', tab: null, pane: 'pane-11', agentName: 'review-claude', role: 'review', head: 'a'.repeat(40),
    attach: 'herdr pane attach pane-11 --workspace wF', transcript: null, subject: 'GY-113: review aaaaaaaaaaaa',
    startedAt: ago(2 * 3_600_000), updatedAt: ago(41 * 60_000), endedAt: null, state: 'running', outcome: null, ...over,
  });
  const item = (sessions: SessionHandle[], key = 'GY-113') => ({ id: `work-${key}`, key, sessions, candidate: null, autoDispatch: null, stage: 'review', lease: null, reworkRequested: false, observation: null } as unknown as Work);
  const listed: RuntimeSession[] = [{ name: 'review-claude', pane_id: 'pane-11', agent_status: 'working' }];

  // A review session that has run two hours, past the one-hour maximum for its role, and is still
  // reported live: the expensive case, because nothing else catches a session making no progress.
  const live = overlongSessions([item([handle({})])], listed, now);
  assert.equal(live.length, 1);
  assert.deepEqual([live[0].key, live[0].role, live[0].kind, live[0].live, live[0].liveness], ['GY-113', 'review', 'review', true, 'live']);
  assert.deepEqual([live[0].runtime, live[0].host, live[0].principal], ['claude', 'vishrog', 'reviewer-1']);
  assert.equal(live[0].ageMs, 2 * 3_600_000);
  assert.equal(live[0].maximumMs, roleSessionMaximumMs.review);
  assert.equal(live[0].idleMs, 41 * 60_000);
  assert.equal(live[0].lastActivityAt, ago(41 * 60_000));
  assert.equal(live[0].attach, 'herdr pane attach pane-11 --workspace wF');

  const attention = overlongSessionAttention({ work: [item([handle({})])], now: now.toISOString() }, { agents: listed as any, available: true });
  assert.equal(attention.length, 1);
  assert.equal(attention[0].subject, 'GY-113');
  assert.match(attention[0].text, /^review session session-1 on GY-113 \(reviewer-1\) has run 2h0m, past the 1h0m maximum for its role/);
  assert.match(attention[0].text, /last observed activity 41m ago at 2026-09-21T11:19:00.000Z/);
  assert.match(attention[0].text, /the claude runtime on vishrog still reports it live/);
  assert.match(attention[0].text, /holds its role slot while it stands/);
  assert.equal(attention[0].role, 'master');
  assert.equal(attention[0].human, false, 'nothing here is a human decision');
  assert.match(attention[0].next, /^herdr pane attach pane-11 --workspace wF shows what it is doing/, 'the line names what shows the session, never a command that kills it');

  // A session that is *not* live is surfaced just the same, because age is the subject here; the
  // sweep is what closes it, and the line says so rather than asking anybody to close it by hand.
  const dead = overlongSessionAttention({ work: [item([handle({})])], now: now.toISOString() }, { agents: [], available: true });
  assert.equal(dead.length, 1);
  assert.match(dead[0].text, /the runtime no longer reports it live \(vanished\), so the liveness sweep closes its record within 90s/);
  assert.match(dead[0].next, /^graphyard master run --once reconciles the record; no session has to be closed by hand$/);
  const unknown = overlongSessionAttention({ work: [item([handle({})])], now: now.toISOString() }, { agents: [], available: false });
  assert.match(unknown[0].text, /whether it is still live is unknown, because the runtime inventory could not be read/);
  // A session another host launched is surfaced by its age all the same, and the line says plainly
  // that this host's inventory does not answer for it rather than calling it dead.
  const elsewhere = overlongSessionAttention({ work: [item([handle({})])], now: now.toISOString() }, { agents: [], available: true, hostId: 'host-1' });
  assert.equal(elsewhere.length, 1);
  assert.match(elsewhere[0].text, /whether it is still live is unknown: it runs on vishrog, and this host's runtime inventory does not answer for it/);
  assert.equal(overlongSessions([item([handle({})])], [], now, { hostId: 'vishrog' })[0].liveness, 'vanished', 'the host that launched it does judge it');

  // Each role is judged against its own maximum, and a session inside it is not surfaced at all.
  assert.deepEqual(overlongSessions([item([handle({ startedAt: ago(59 * 60_000) })])], listed, now), [], 'a review inside the hour is nobody\'s attention item');
  const roles = item([
    handle({ id: 'impl', kind: 'implementation', role: null, startedAt: ago(5 * 3_600_000), updatedAt: ago(10_000) }),
    handle({ id: 'proof', kind: 'proof', role: 'proof:integration', startedAt: ago(3 * 3_600_000), updatedAt: ago(20_000) }),
    handle({ id: 'coord', kind: 'coordination', role: null, startedAt: ago(6 * 3_600_000), updatedAt: ago(30_000) }),
  ]);
  const byRole = overlongSessions([roles], listed, now);
  assert.deepEqual(byRole.map(session => session.id), ['impl', 'proof'], 'longest first, and a coordination session is meant to outlive the work it shepherds');
  assert.deepEqual(byRole.map(session => session.maximumMs), [roleSessionMaximumMs.implementation, roleSessionMaximumMs.proof]);
  assert.deepEqual(byRole.map(session => session.role), ['implementation', 'proof:integration'], 'the role the reader is given is the slot, group and all');
  // The producer maximum follows the loop's own configured request timeout rather than a constant.
  const configured = overlongSessions([roles], listed, now, { maximums: { proof: 30 * 60_000, implementation: 24 * 3_600_000 } });
  assert.deepEqual(configured.map(session => [session.id, session.maximumMs]), [['proof', 30 * 60_000]]);
  assert.equal(roleSessionMaximumMs.proof, fleetConfig.run.producerTimeoutMinutes * 60_000, 'the default matches run.producerTimeoutMinutes, which is when a producer request expires');

  // A finished session is never overlong: it ran however long it ran, and nothing holds its slot.
  assert.deepEqual(overlongSessions([item([handle({ state: 'finished', endedAt: ago(60_000), outcome: 'posted its verdict' })])], listed, now), []);
  // And the outcome a stalled session recorded for itself is carried onto the line, since it is
  // usually the only thing that says why it stopped making progress.
  const stalled = overlongSessionAttention({ work: [item([handle({ outcome: 'waiting on input instead of recording a typed request' })])], now: now.toISOString() }, { agents: listed as any, available: true });
  assert.match(stalled[0].text, /last recorded outcome: waiting on input instead of recording a typed request$/);
});

// ---- AC-5: the guide says the control plane does this, and what to do instead -----------------

const guide = await readFile(new URL('../docs/master-agent.md', import.meta.url), 'utf8');

test('manual:session-liveness-docs-review — docs/master-agent.md states that the control plane reconciles session liveness, on what interval, and what an operator or master does instead of closing sessions by hand', () => {
  const section = guide.slice(guide.indexOf('### Session liveness is reconciled, not trusted'), guide.indexOf('## Automatic dispatch at submit'));
  assert.ok(section.length > 1000, 'the guide carries the session-liveness section');

  // That the control plane does it, and that it is not the master's manual duty.
  assert.match(section, /control plane reconciles session liveness/);
  assert.match(section, /not the master's\s+manual duty/);

  // On what interval, with the numbers the code declares.
  assert.match(section, /every automatic-dispatch tick/);
  assert.match(section, /run\.dispatchIntervalSeconds/);
  assert.match(section, new RegExp(`${sessionReconcileIntervalMs / 1000} at most`));
  // The session report's rule (GY-172): lost at the second consecutive miss, and a young handle left alone.
  assert.equal(lostAfterReports, 2);
  assert.match(section, /closes at the second consecutive sweep\s+that misses it/);
  assert.match(section, new RegExp(`left alone for its first ${sessionLaunchGraceMs / 60_000} minutes`));
  assert.match(section, /A handle another host launched is left to\s+that host's loop/);

  // Every closure the sweep makes, named with the reason it records.
  for (const cause of ['Vanished', 'Ended', 'Superseded', 'Duplicate']) assert.match(section, new RegExp(`\\*\\*${cause}\\*\\*`), `${cause} is documented`);
  assert.match(section, /`idle`, `done` and\s+`blocked` are deliberately not terminal/);
  assert.match(section, /a delivered item is closed the same\s+way as any other/i);
  assert.match(section, /decides no gate, ends no lease, and stops no process/);

  // That the slot follows the reconciled record, which is the thing a reader would otherwise
  // work around by closing a handle by hand.
  assert.match(section, /counted against live\s+sessions only/);
  assert.match(section, /busy only while a live session has it/);

  // What to do instead of closing sessions by hand — for a dead session, and for a live one that
  // is making no progress.
  assert.match(section, /what an operator or a master does instead of closing sessions by hand/);
  assert.match(section, /nothing, for a session\s+that finished or died/);
  assert.match(section, /graphyard master run --once/);
  assert.match(section, /attach to it with the command on the handle/);
  assert.match(section, /Never mark\s+another session's handle finished to free a slot/);

  // The maximum each role is judged against, so the attention item's numbers are documented too.
  assert.match(section, new RegExp(`${roleSessionMaximumMs.implementation / 3_600_000}h implementation`));
  assert.match(section, new RegExp(`${roleSessionMaximumMs.review / 3_600_000}h review`));
  assert.match(section, /run\.producerTimeoutMinutes` for a producer/);
  assert.match(section, new RegExp(`${roleSessionMaximumMs.coordination / 3_600_000}h coordination`));
});
