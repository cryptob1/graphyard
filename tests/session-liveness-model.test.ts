import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';
import { recordSession, type RuntimeSession, type SessionHandle, type SessionHandleInput } from '../src/model/sessions.js';
import { endedByFact, lostAfterReports, observeSessions, observedRuntimeState, registeredLaunch, reportedHandle, sessionObservationFreshMs, sessionObservationRefreshMs, sessionView, settledPurpose, runningSessions } from '../src/model/session-state.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { reconciledClosure } from '../web/workers-view.js';
import { dispatchEffects, emptyDispatchCursor, herdrSessionListing, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { runtimeEndedStates } from '../src/harness.js';
import { masterConfigSchema } from '../src/master.js';
import { sessionReport } from '../src/cli/master-status.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-172 AC-1: one session state. The loop reports, on every dispatch tick, what it observes of
 * every Graphyard-launched session it can see — working, idle, ended, lost — and the control plane
 * stores it on the session record with the observation time. A pane whose agent exited to a shell
 * is `ended`; a session absent from two consecutive reports is `lost`; both are closed with their
 * reason. A tick whose runtime listing could not be read is a gap, not a report.
 *
 * Driven through the dispatcher `master run` builds and the real engine: the only stubs are the
 * runtime inventory and the ledgers the tick reconciles beside it.
 */

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'executor-a', role: 'coordinator' };
const producer: Principal = { id: 'producer-a', role: 'producer' };
const worker: Principal = { id: 'agent-a', role: 'worker', runtime: 'claude' };

let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_SESSION_MODEL_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 191);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('session-model'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [operator, coordinator, worker, producer];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const config = masterConfigSchema.parse({
  version: 1, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: '/outside/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 15368, hostId: 'host-1', masterAgentName: 'm', herdrWorkspace: 'wF',
  workers: [{ name: 'claude-worker', principal: worker.id, agentName: 'work-claude', mode: 'launch', kind: 'claude', credentialFile: '/outside/worker.token', approvals: 'auto' }],
});

const reload = async (id: string) => (await store.list()).find(entry => entry.id === id)!;
const handleOf = async (id: string, session: string) => (await reload(id)).sessions!.find(handle => handle.id === session)!;

/** The dispatcher the loop builds, writing through the coordinator mutation to the engine; the runtime listing and the clock are the test's. */
function dispatcher(items: () => Promise<Work[]>, runtime: () => RuntimeSession[] | null, clock: () => number): DispatchEffects {
  const production = dispatchEffects('/outside', () => config, {
    snapshot: async () => ({ work: await items(), now: new Date(clock()).toISOString() }),
    mutate: async (path: string, body: unknown) => { const [, id, command] = path.split('/'); return engine.execute(coordinator, command as any, id, body, randomUUID()); },
    run: () => { throw new Error('nothing is launched here'); },
  });
  return { ...production, agents: () => runtime() as any, credentials: async () => ({}), reconcileReviews: async () => ({ reviews: [] }), reconcileProducers: async () => ({ producers: [] }),
    launchReview: async () => { throw new Error('no launch'); }, launchProducer: async () => { throw new Error('no launch'); }, persist: async () => {} };
}

test('unit:session-liveness-model — the loop reports every session it sees on each dispatch tick and the control plane stores it with the observation time: a working session, an agent exited to a shell (ended), a vanished pane (lost after two consecutive reports) and a report gap', async () => {
  let item = await engine.execute(operator, 'create', null, { title: 'Session state', plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Observed', proofs: ['unit:observed'] }] }, randomUUID());
  item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
  // Four sessions a launcher registered on this host, each with the pane it holds and its name.
  const register = (id: string, pane: string) => engine.execute(coordinator, 'session', item.id, { id, kind: 'coordination', role: 'approver', runtime: 'claude', host: 'host-1', workspace: 'wF',
    agentName: `agent-${id}`, pane, attach: `herdr pane attach ${pane} --workspace wF`, subject: `${item.key}: ${id}`, state: 'running' }, randomUUID());
  for (const [id, pane] of [['working', 'wF:p1'], ['shell', 'wF:p2'], ['vanished', 'wF:p3'], ['gap', 'wF:p4']]) await register(id, pane);
  // One on another host: this host's runtime is never asked about it, so nothing is concluded.
  await engine.execute(coordinator, 'session', item.id, { id: 'elsewhere', kind: 'coordination', runtime: 'claude', host: 'host-2', pane: 'wX:p9', subject: `${item.key}: elsewhere`, state: 'running' }, randomUUID());

  // The simulated clock runs in the past, so every observation it writes is one the control plane's clock has reached.
  const start = Date.now() - 2 * 3_600_000;
  let clock = start;
  let listing: RuntimeSession[] | null = null;
  const cursor = emptyDispatchCursor(config);
  const tick = () => runDispatchTick(config, cursor, dispatcher(async () => [await reload(item.id)], () => listing, () => clock), () => clock);
  const entry = (pane: string, state: string, agent: string | null = 'claude'): RuntimeSession => ({ name: `agent-${pane}`, pane_id: pane, agent_status: state, agent });

  // ---- Tick 1: every session is listed with an agent in its pane. -------------------------------
  listing = [entry('wF:p1', 'working'), entry('wF:p2', 'done'), entry('wF:p3', 'working'), entry('wF:p4', 'blocked')];
  const first = await tick();
  const at1 = new Date(start).toISOString();
  assert.deepEqual(first.closed, [], 'nothing is over');
  assert.equal(first.sessions?.observed, 4, 'the report covers every session this host can see, and not the one on host-2');
  assert.equal(first.sessions?.written, 4, 'each first observation is stored');
  const working = await handleOf(item.id, 'working');
  assert.deepEqual([working.observed, working.observedAt, working.state], ['working', at1, 'running'], 'a working session is stored working, with the observation time');
  assert.deepEqual([(await handleOf(item.id, 'shell')).observed, (await handleOf(item.id, 'gap')).observed], ['idle', 'idle'], 'a session at its prompt (done, blocked) is idle, not ended');
  assert.equal((await handleOf(item.id, 'elsewhere')).observed, undefined, 'another host\'s session is not judged by this host\'s listing');
  assert.equal(sessionView(working, new Date(start)).live, true, 'and every reader shows it running');

  // ---- Tick 2: the shell pane's agent exited; the vanished pane is gone. -------------------------
  clock = start + 30_000;
  // The Herdr adapter is what says a listed pane holds no agent: Herdr leaves the field out.
  assert.deepEqual(herdrSessionListing([{ name: 'agent-wF:p2', pane_id: 'wF:p2', agent_status: 'idle' }]), [{ name: 'agent-wF:p2', pane_id: 'wF:p2', agent_status: 'idle', agent: null }]);
  listing = [entry('wF:p1', 'working'), ...herdrSessionListing([{ name: 'agent-wF:p2', pane_id: 'wF:p2', agent_status: 'idle' }]), entry('wF:p4', 'idle')];
  const second = await tick();
  assert.deepEqual(second.closed.map(closure => [closure.id, closure.cause]), [['shell', 'ended']], 'an agent exited to a shell is ended at once, even though its pane is still listed idle');
  const shell = await handleOf(item.id, 'shell');
  assert.deepEqual([shell.state, shell.observed, shell.observedAt], ['finished', 'ended', new Date(clock).toISOString()]);
  assert.ok(shell.endedAt, 'and closed');
  assert.match(shell.outcome!, /reports pane wF:p2 as exited to a shell \(no agent in the pane\), so the session is over$/, 'with its reason');
  const missed = await handleOf(item.id, 'vanished');
  assert.deepEqual([missed.state, missed.observed, missed.observedAt, missed.missedReports], ['running', 'working', at1, 1],
    'one report without it is not a death: it is still open, its last observation kept, the miss counted');
  assert.equal(second.sessions?.written, 1 + 0, 'the steady working session is not rewritten inside the refresh interval; only the miss is');

  // ---- Tick 3: a gap — the runtime could not be read. --------------------------------------------
  clock = start + 60_000;
  listing = null;
  const gap = await tick();
  assert.deepEqual(gap.closed, [], 'an unreadable runtime closes nothing');
  assert.equal(gap.sessions?.observed, 0, 'and reports nothing');
  assert.equal((await handleOf(item.id, 'vanished')).missedReports, 1, 'a gap is not a report: the vanished session is not a second miss closer to lost');

  // ---- Tick 4: absent from a second consecutive report — lost. -----------------------------------
  clock = start + 90_000;
  listing = [entry('wF:p1', 'working'), entry('wF:p4', 'idle')];
  const fourth = await tick();
  assert.deepEqual(fourth.closed.map(closure => [closure.id, closure.cause]), [['vanished', 'vanished']]);
  const lost = await handleOf(item.id, 'vanished');
  assert.deepEqual([lost.state, lost.observed, lost.missedReports], ['finished', 'lost', lostAfterReports], 'absent from two consecutive reports: lost, and closed');
  assert.equal(lost.observedAt, at1, 'seen last at its last observation, not at the report that missed it');
  assert.match(lost.outcome!, new RegExp(`^vanished: the claude runtime on host-1 has not reported pane wF:p3 for \\d+s \\(absent from ${lostAfterReports} consecutive session reports, so the session is lost\\)`));
  assert.ok(!sessionReport({ work: await store.list(), now: new Date(clock).toISOString() }).running.some(row => row.id === 'vanished'), 'master status no longer lists it running');

  // ---- The record is refreshed while the session keeps working, and goes stale when reports stop. -
  clock = start + sessionObservationRefreshMs + 1_000;
  const refreshed = await tick();
  assert.deepEqual(refreshed.closed, []);
  assert.equal((await handleOf(item.id, 'working')).observedAt, new Date(clock).toISOString(), 'a session observed across the refresh interval is stored with the new observation time');
  const seen = await handleOf(item.id, 'working');
  // No further report — the loop stopped. Nothing is written, and past the freshness bound no reader shows it running.
  const quiet = new Date(clock + sessionObservationFreshMs + 1_000);
  assert.deepEqual([sessionView(seen, quiet).live, sessionView(seen, quiet).seenAt], [false, seen.observedAt]);
  assert.ok(!runningSessions([await reload(item.id)], quiet).some(row => row.id === 'working'), 'a session not observed inside the bound is not shown running');
  assert.ok(runningSessions([await reload(item.id)], new Date(clock)).some(row => row.id === 'working'), 'while one observed just now is');
});

test('unit:session-liveness-model — the rule itself: what a listed entry says, the launch grace, and one reading for every reader', () => {
  const states = runtimeEndedStates;
  assert.equal(observedRuntimeState({ agent: 'claude', agent_status: 'working' }, 'claude', states), 'working');
  for (const state of ['idle', 'done', 'blocked', 'unknown']) assert.equal(observedRuntimeState({ agent: 'claude', agent_status: state }, 'claude', states), 'idle', state);
  assert.equal(observedRuntimeState({ agent: null, agent_status: 'idle' }, 'claude', states), 'ended', 'no agent in the pane: exited to a shell');
  assert.equal(observedRuntimeState({ agent: 'claude', agent_status: 'killed' }, 'claude', states), 'ended');
  assert.equal(observedRuntimeState({ agent_status: 'working' }, 'claude', states), 'working', 'a runtime that does not name agents is judged on its state alone');

  const now = new Date('2026-09-24T12:00:00.000Z');
  const handle = (fields: Partial<SessionHandle>): SessionHandle => ({ id: 's', kind: 'implementation', principal: 'p', epoch: 1, runtime: 'claude', host: 'host-1', workspace: null, tab: null,
    pane: 'wF:p1', agentName: null, role: null, head: null, attach: null, transcript: null, subject: 'GY-1: s', startedAt: now.toISOString(), updatedAt: now.toISOString(), endedAt: null,
    state: 'running', outcome: null, ...fields });
  // The attempt the handle names holds its lease, as a launching worker's does (the claim precedes the handle).
  const work = (sessions: SessionHandle[]) => [{ id: 'w', key: 'GY-1', lease: { owner: 'p', epoch: 1, expiresAt: new Date(now.getTime() + 90_000).toISOString() }, sessions } as unknown as Work];
  // Registered a moment ago, before its runtime started: a pane without an agent yet, or no pane
  // listed at all, is a session starting, not one that ended or vanished.
  const young = handle({});
  assert.deepEqual(observeSessions(work([young]), [{ pane_id: 'wF:p1', agent: null, agent_status: 'unknown' }], now, { hostId: 'host-1' }).entries, []);
  assert.deepEqual(observeSessions(work([young]), [], now, { hostId: 'host-1' }).entries, []);
  const settled = observeSessions(work([handle({ startedAt: new Date(now.getTime() - 10 * 60_000).toISOString() })]), [{ pane_id: 'wF:p1', agent: null, agent_status: 'unknown' }], now, { hostId: 'host-1' });
  assert.equal(settled.entries[0].closed, 'ended', 'past the launch grace the same listing is an agent that exited');
  // Seen: the latest observation. A handle nothing observed yet reads its launcher's record.
  assert.deepEqual(sessionView(handle({ observed: 'idle', observedAt: new Date(now.getTime() - 60_000).toISOString(), updatedAt: new Date(now.getTime() - 30 * 60_000).toISOString() }), now),
    { observed: 'idle', seenAt: new Date(now.getTime() - 60_000).toISOString(), live: true, unseenMs: null });
  assert.equal(sessionView(handle({ observed: 'working', observedAt: new Date(now.getTime() - sessionObservationFreshMs - 1).toISOString() }), now).live, false, 'stale: not running');
  assert.equal(sessionView(handle({ observed: 'lost', observedAt: now.toISOString() }), now).live, false, 'lost is never running');
  assert.equal(sessionView(handle({ observed: 'working', observedAt: now.toISOString(), missedReports: lostAfterReports }), now).live, false, 'a handle the reports keep missing is not running either, however fresh its last sighting (GY-1532)');
  assert.equal(sessionView(handle({ state: 'finished', observed: 'working', observedAt: now.toISOString() }), now).live, false, 'a closed record is never running');
});

test('unit:session-liveness-model — a missed report keeps the last sighting, and a handle with no coordinate to match is lost rather than left open', () => {
  const now = new Date('2026-09-24T12:00:00.000Z'), ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const handle = (fields: Partial<SessionHandle>): SessionHandle => ({ id: 's', kind: 'review', principal: 'p', epoch: null, runtime: 'claude', host: 'host-1', workspace: null, tab: null,
    pane: 'wF:p1', agentName: null, role: 'review', head: null, attach: null, transcript: null, subject: 'GY-1: s', startedAt: ago(10 * 60_000), updatedAt: ago(10 * 60_000), endedAt: null,
    state: 'running', outcome: null, ...fields });
  const work = (sessions: SessionHandle[]) => ({ id: 'w', key: 'GY-1', sessions } as unknown as Work);

  // Nothing observed this session yet and the report misses it: the write of that miss must not
  // make it read as seen just now. The launcher's record stays its last sighting.
  const unobserved = work([handle({})]);
  const [miss] = observeSessions([unobserved], [], now, { hostId: 'host-1' }).entries;
  assert.deepEqual([miss.missedReports, miss.closed, miss.observedAt], [1, null, ago(10 * 60_000)]);
  recordSession(unobserved, reportedHandle(miss), 'executor-a', now);
  const written = unobserved.sessions![0];
  assert.equal(written.updatedAt, now.toISOString(), 'the record was written now');
  assert.deepEqual(sessionView(written, now), { observed: 'working', seenAt: ago(10 * 60_000), live: true, unseenMs: null }, 'yet it is seen when its launcher last saw it');
  assert.equal(sessionView(written, new Date(now.getTime() + 6 * 60_000)).live, false, 'and goes unseen once that sighting is stale, not 15 minutes after the miss');

  // A launcher that never wrote the pane or name it started: nothing the runtime lists can match it.
  const bare = handle({ pane: null, agentName: null });
  assert.deepEqual(observeSessions([work([handle({ pane: null, agentName: null, startedAt: now.toISOString(), updatedAt: now.toISOString() })])], [], now, { hostId: 'host-1' }).entries, [], 'still inside the launch grace: its coordinates may yet be written');
  const [first] = observeSessions([work([bare])], [{ name: 'someone-else', pane_id: 'wF:p9', agent: 'claude', agent_status: 'working' }], now, { hostId: 'host-1' }).entries;
  assert.deepEqual([first.missedReports, first.closed], [1, null], 'past the grace it is missed like a vanished pane');
  const [second] = observeSessions([work([{ ...bare, missedReports: 1 }])], [], now, { hostId: 'host-1' }).entries;
  assert.equal(second.closed, 'lost', 'and lost at the second consecutive report, so it is closed rather than left open and unseen');
  assert.match(second.outcome!, /has not reported session s \(registered with no pane or name to match\)/);
});

test('unit:session-liveness-model — only the observer writes the observation, a delivered item keeps it fresh, and a reopened record carries none of the previous runtime session', async () => {
  let item = await engine.execute(operator, 'create', null, { title: 'Observation writes', plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Observed', proofs: ['unit:observed'] }] }, randomUUID());
  item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
  const handle = { id: 'owned', kind: 'coordination', role: 'approver', runtime: 'claude', host: 'host-1', principal: producer.id, agentName: 'agent-owned', pane: 'wF:p7',
    attach: 'herdr pane attach wF:p7 --workspace wF', transcript: '/logs/owned-1.jsonl', subject: `${item.key}: owned`, state: 'running' } as const;
  await engine.execute(coordinator, 'session', item.id, handle, randomUUID());

  // The session the handle names may fill in its own coordinates, but never what was observed of it.
  const { principal: _, ...own } = handle;
  for (const field of [{ observed: 'working' }, { observedAt: new Date().toISOString() }, { missedReports: 0 }])
    await assert.rejects(engine.execute(producer, 'session', item.id, { ...own, ...field }, randomUUID()), /Only the coordinator that observes sessions, or an admin, records what was observed of one/, JSON.stringify(field));
  // Not even the observer dates an observation ahead of the control plane's clock, where it would read fresh for good.
  const before = Date.now();
  await engine.execute(coordinator, 'session', item.id, { ...handle, observed: 'working', observedAt: new Date(before + 3_600_000).toISOString() }, randomUUID());
  const clamped = Date.parse((await handleOf(item.id, 'owned')).observedAt!);
  assert.ok(clamped >= before && clamped <= Date.now(), 'an observation from ahead of the clock is stored as of now');
  await engine.execute(producer, 'session', item.id, { ...own, tab: 'approver' }, randomUUID());
  assert.deepEqual([(await handleOf(item.id, 'owned')).observed, (await handleOf(item.id, 'owned')).observedAt], ['working', new Date(clamped).toISOString()], 'its own update keeps the loop\'s observation');

  // Delivered while its session still runs: the report keeps observing it, so no reader shows a live session as unseen.
  await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{stage}', '"done"') WHERE id = $1`, [item.id]);
  // The observation is due a refresh, so the tick writes it.
  await engine.execute(coordinator, 'session', item.id, { ...handle, observed: 'working', observedAt: new Date(Date.now() - sessionObservationRefreshMs - 1_000).toISOString() }, randomUUID());
  const later = Date.now();
  const cursor = emptyDispatchCursor(config);
  const tick = await runDispatchTick(config, cursor, dispatcher(async () => [await reload(item.id)], () => [{ name: 'agent-owned', pane_id: 'wF:p7', agent_status: 'working', agent: 'claude' }], () => later), () => later);
  assert.equal(tick.sessions?.written, 1, `the observation of a session on a delivered item is written: ${JSON.stringify(tick.sessions?.failures)}`);
  const observed = await handleOf(item.id, 'owned');
  assert.deepEqual([observed.state, observed.observed, observed.observedAt], ['running', 'working', new Date(later).toISOString()]);
  assert.equal(sessionView(observed, new Date(later + sessionObservationFreshMs - 1_000)).live, true, 'and it reads running for as long as the loop sees it');
  await assert.rejects(engine.execute(coordinator, 'session', item.id, { ...handle, id: 'new-on-delivered' }, randomUUID()), /Delivered work is immutable/, 'a delivered item still takes no new handle');
  await assert.rejects(engine.execute(producer, 'session', item.id, { ...own, tab: 'other' }, randomUUID()), /Delivered work is immutable/, 'nor an update that is not an observation');
  await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{stage}', '"ready"') WHERE id = $1`, [item.id]);

  // Closed, then launched again under the same id without its pane yet: nothing of the previous runtime session stands.
  await engine.execute(coordinator, 'session', item.id, { ...handle, state: 'finished', outcome: 'the approver decided' }, randomUUID());
  const { agentName: _n, pane: _p, attach: _a, transcript: _t, ...registration } = handle;
  await engine.execute(coordinator, 'session', item.id, registration, randomUUID());
  const reopened = await handleOf(item.id, 'owned');
  assert.deepEqual([reopened.state, reopened.agentName, reopened.pane, reopened.tab, reopened.attach, reopened.transcript, reopened.observed, reopened.outcome],
    ['running', null, null, null, null, null, undefined, null], 'the retry is not pointed at the previous attempt\'s pane, attach command or transcript');
  assert.equal(reopened.role, 'approver', 'while the slot it occupies is the same one');
});

/**
 * GY-1532. On 8 October 2026 every worker and reviewer session on vishrog closed as "vanished …
 * so the session is lost" within a minute of its work landing — the loop had closed the pane
 * itself once the attempt was submitted or the verdict read, and the report, judging absence
 * alone, counted two missed reports and lost it. A session whose purpose the item says is over
 * (attempt ended, request answered) is ended on the first report that no longer lists it, with
 * that fact as its terminal reason. One whose purpose stands is held — missed, counted, not shown
 * running — never lost: every attempt ends on the record (its supervisor releases the lease once
 * Herdr drops the pane, the loop keeps a dead worker's work, the lease lapses) and the item is
 * dispatched again under a fresh lease, and the next report ends the handle with that fact.
 */
test('unit:session-liveness-model — GY-1532: a session whose attempt or request is over is ended with that fact on the first report that no longer lists it, and one whose attempt stands is held until it ends, never lost', () => {
  const now = new Date('2026-10-08T04:20:35.000Z'), ago = (ms: number) => new Date(now.getTime() - ms).toISOString(), ahead = (ms: number) => new Date(now.getTime() + ms).toISOString();
  const handle = (fields: Partial<SessionHandle>): SessionHandle => ({ id: 'agent-a:1', kind: 'implementation', principal: 'agent-a', epoch: 1, runtime: 'claude', host: 'host-1', workspace: 'wF', tab: null,
    pane: 'wF:p1', agentName: 'work-claude', role: null, head: null, attach: null, transcript: null, subject: 'GY-1513: implement', startedAt: ago(10 * 60_000), updatedAt: ago(30_000), endedAt: null,
    state: 'running', outcome: null, observed: 'working', observedAt: ago(30_000), ...fields });
  const item = (fields: Partial<Work>): Work => ({ id: 'w', key: 'GY-1513', lease: null, submission: null, autoDispatch: { review: null, producers: [], history: [] }, ...fields } as unknown as Work);
  const report = (work: Work, listing: RuntimeSession[]) => observeSessions([work], listing, now, { hostId: 'host-1' }).entries;

  // The attempt still holds its lease and the runtime stops listing the pane: the handle is held,
  // never lost. Each miss is counted and written up to the second, from which no reader shows it
  // running; later misses are held without a write, and the record waits for the item's fact.
  const live = item({ lease: { owner: 'agent-a', epoch: 1, expiresAt: ahead(90_000) }, sessions: [handle({})] });
  assert.equal(settledPurpose(live, live.sessions![0], now.getTime()), null);
  assert.equal(endedByFact(live, live.sessions![0]), true, 'a worker handle ends with its attempt');
  const [miss] = report(live, []);
  assert.deepEqual([miss.missedReports, miss.closed, miss.observed, miss.changed], [1, null, 'working', true]);
  const [second] = report(item({ ...live, sessions: [handle({ missedReports: 1 })] }), []);
  assert.deepEqual([second.missedReports, second.closed, second.changed], [2, null, true], 'a live attempt whose pane stays unlisted is held, not lost');
  const unseen = handle({ missedReports: 2 });
  assert.equal(sessionView(unseen, now).live, false, 'and from the second miss no reader shows it running');
  const [third] = report(item({ ...live, sessions: [unseen] }), []);
  assert.deepEqual([third.missedReports, third.closed, third.changed], [3, null, false], 'held on, without a write');
  // The loss ends the attempt — its supervisor surrendered the lease once Herdr dropped the pane,
  // or the loop kept the interrupted work of a worker whose supervisor died with it — and the item
  // was dispatched again under a fresh lease. The next report ends the handle with that fact: the
  // terminal event names the release, its cause and the relaunch, never a loss.
  const gone = 'ended without submitting: its agent session work-claude is gone from Herdr and its supervisor has exited without releasing the lease';
  const relaunched = item({ lease: { owner: 'agent-b', epoch: 2, expiresAt: ahead(90_000) }, sessions: [unseen],
    pipeline: { attempts: [{ epoch: 1, owner: 'agent-a', claimedAt: ago(600_000), endedAt: ago(40_000), end: 'released' }, { epoch: 2, owner: 'agent-b', claimedAt: ago(10_000), endedAt: null, end: null }] },
    capacity: { exhaustions: [{ role: 'worker', epoch: 1, cause: 'interrupted', reason: gone }], escalations: [] } } as unknown as Partial<Work>);
  const [recovered] = observeSessions([relaunched], [], now, { hostId: 'host-1', firstMissed: { 'w\u0000agent-a:1': ago(25_000) } }).entries;
  assert.deepEqual([recovered.closed, recovered.observed, recovered.missedReports], ['ended', 'ended', 0]);
  assert.equal(recovered.outcome, `the claude runtime on host-1 no longer reports pane wF:p1 (unlisted for 25s): attempt 1 of GY-1513 was released at ${ago(40_000)} (${gone}); attempt 2 runs under a fresh lease held by agent-b, so the session is over`);
  recordSession(relaunched, reportedHandle(recovered), 'executor-a', now);
  assert.equal(reconciledClosure(relaunched.sessions![0]), 'ended', 'the Workers page reads it as ended by its runtime');
  // A lapse ends it the same way, and so does a lease that lapsed under a later attempt.
  assert.match(report(item({ lease: { owner: 'agent-a', epoch: 1, expiresAt: ago(1_000) }, sessions: [unseen], pipeline: { attempts: [{ epoch: 1, owner: 'agent-a', claimedAt: ago(600_000), endedAt: ago(1_000), end: 'expired' }] } } as unknown as Partial<Work>), [])[0].outcome!,
    /\(unlisted for 2 session reports\): attempt 1 of GY-1513 ended when its lease lapsed at .*, so the session is over$/);
  assert.match(report(item({ lease: { owner: 'agent-b', epoch: 2, expiresAt: ago(1_000) }, sessions: [handle({})] }), [])[0].outcome!, /attempt 1 of GY-1513 ended, and attempt 2's lease lapsed at .*, so the session is over$/);

  // Submitted: the loop closed the pane once the lease ended. The first report that no longer
  // lists it ends the record with the submission as the reason — a terminal event, not a loss.
  const submitted = item({ submission: { epoch: 1, pr: 989 }, sessions: [handle({})] });
  const [ended] = report(submitted, []);
  assert.deepEqual([ended.closed, ended.observed, ended.observedAt, ended.missedReports], ['ended', 'ended', now.toISOString(), 0]);
  assert.equal(ended.outcome, 'the claude runtime on host-1 no longer reports pane wF:p1: attempt 1 of GY-1513 was submitted as pull request #989, so the session is over');
  recordSession(submitted, reportedHandle(ended), 'executor-a', now);
  const stored = submitted.sessions![0];
  assert.deepEqual([stored.state, stored.observed, stored.endedAt], ['finished', 'ended', now.toISOString()]);
  assert.equal(reconciledClosure(stored), 'ended', 'the Workers page shows it ended by its runtime, not as one that stopped responding');
  // While the runtime still lists it — the supervisor is stopping the agent — it is observed as before, not closed.
  const [stopping] = report(item({ submission: { epoch: 1, pr: 989 }, sessions: [handle({})] }), [{ name: 'work-claude', pane_id: 'wF:p1', agent: 'claude', agent_status: 'working' }]);
  assert.deepEqual([stopping.observed, stopping.closed], ['working', null]);
  // Its agent exited to a shell: ended by the listing, with the attempt's end named too.
  const [shell] = report(item({ submission: { epoch: 1, pr: 989 }, sessions: [handle({})] }), [{ name: 'work-claude', pane_id: 'wF:p1', agent: null, agent_status: 'idle' }]);
  assert.equal(shell.outcome, 'the claude runtime on host-1 reports pane wF:p1 as exited to a shell (no agent in the pane) after attempt 1 of GY-1513 was submitted as pull request #989, so the session is over');

  // A lapsed attempt, even inside the launch grace with no coordinate yet: the lease that would
  // have held it (`launchHeldByLease`) is gone, so the record ends with the lapse rather than
  // waiting out the grace to be lost (GY-1493 epoch 2 on 8 October 2026).
  const lapsed = item({ lease: { owner: 'agent-a', epoch: 1, expiresAt: ago(1_000) }, sessions: [handle({ pane: null, agentName: null, observed: undefined, observedAt: undefined, startedAt: ago(60_000) })] });
  const [expired] = report(lapsed, []);
  assert.equal(expired.closed, 'ended');
  assert.equal(expired.outcome, `the claude runtime on host-1 no longer reports session agent-a:1 (registered with no pane or name to match): attempt 1 of GY-1513 ended with its lease expired at ${ago(1_000)}, so the session is over`);
  // A later attempt holds the item: the earlier session's attempt is over.
  const [superseded] = report(item({ lease: { owner: 'agent-b', epoch: 2, expiresAt: ahead(90_000) }, sessions: [handle({})] }), []);
  assert.match(superseded.outcome!, /attempt 1 of GY-1513 ended; attempt 2 runs under a fresh lease held by agent-b, so the session is over$/);
  // No lease and no submission for the epoch: released, blocked, parked or reconciled — over either way.
  assert.match(report(item({ sessions: [handle({})] }), [])[0].outcome!, /attempt 1 of GY-1513 ended \(released, blocked, parked or lapsed\) and GY-1513 holds no lease, so the session is over$/);

  // A reviewer: its handle is its request's id. Answered (satisfied) or cancelled, the first
  // report without its pane ends it with the request's resolution; still requested, it is missed
  // and held — the reconcile fails and relaunches an unanswered session, and a head change cancels
  // the request — never lost.
  const request = { id: 'ddf7e329', kind: 'review' as const, sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 1, pr: 989, requestedAt: ago(120_000), reason: 'review requested', state: 'requested' as const };
  const reviewer = (fields: Partial<SessionHandle>) => handle({ id: request.id, kind: 'review', principal: 'reviewer-a', epoch: null, runtime: 'codex', pane: 'wF:p2', agentName: 'review-codex', role: 'review', head: request.sha, ...fields });
  const asked = item({ autoDispatch: { review: request, producers: [], history: [] }, sessions: [reviewer({})] });
  assert.deepEqual([report(asked, [])[0].missedReports, report(asked, [])[0].closed], [1, null], 'a standing request: the miss is counted as before');
  assert.equal(endedByFact(asked, asked.sessions![0]), true, 'a reviewer handle ends with its request');
  assert.deepEqual(report(item({ ...asked, sessions: [reviewer({ missedReports: 1 })] }), []).map(entry => [entry.missedReports, entry.closed]), [[2, null]], 'and the second miss holds it rather than losing it');
  // A review session no request names (`master review` by hand, under `review:SHA`) answers to
  // the runtime alone while its head stands: unlisted past two reports it is lost, so its slot frees.
  const byHand = item({ candidate: { sha: request.sha }, sessions: [reviewer({ id: `review:${request.sha}`, missedReports: 1 })] } as Partial<Work>);
  assert.equal(endedByFact(byHand, byHand.sessions![0]), false);
  assert.equal(report(byHand, [])[0].closed, 'lost');
  // Once the candidate moves on, the head is over and it is ended with that fact.
  const moved = item({ candidate: { sha: 'c'.repeat(40) }, sessions: [reviewer({ id: `review:${request.sha}`, missedReports: 1 })] } as Partial<Work>);
  assert.match(report(moved, [])[0].outcome!, /the candidate no longer is aaaaaaaaaaaa \(it is cccccccccccc\), so the session is over$/);
  assert.equal(report(moved, [])[0].closed, 'ended');
  const answered = item({ autoDispatch: { review: null, producers: [], history: [{ ...request, state: 'satisfied', resolvedAt: ago(20_000), resolution: 'approved by graphyard-reviewer[bot]' }] }, sessions: [reviewer({})] });
  const [verdict] = report(answered, []);
  assert.equal(verdict.closed, 'ended');
  assert.equal(verdict.outcome, `the codex runtime on host-1 no longer reports pane wF:p2: its review request was satisfied at ${ago(20_000)} (approved by graphyard-reviewer[bot]), so the session is over`);
  // A producer's request lives in `producers` until it resolves; cancelled, the proof session is over too.
  const proof = item({ autoDispatch: { review: null, producers: [{ ...request, id: 'p1', kind: 'producer', state: 'cancelled', resolvedAt: ago(5_000), resolution: 'head moved' }], history: [] },
    sessions: [reviewer({ id: 'p1', kind: 'proof', role: 'proof:integration' })] });
  assert.match(report(proof, [])[0].outcome!, /its producer request was cancelled at .* \(head moved\), so the session is over$/);
  // A coordination session answers to no attempt or request here: the loop closes it itself.
  assert.equal(settledPurpose(item({}), { id: 'approver:1', kind: 'coordination', epoch: null }, now.getTime()), null);
  assert.equal(endedByFact(item({}), { id: 'approver:1', kind: 'coordination', epoch: null }), false);
});

/**
 * GY-1532. A request relaunched while its earlier session's handle is held — unlisted, counted,
 * waiting for the request to end — registers under that request's id, over a record still
 * running under another launch's token. Taken over as it was, the record kept the held session's
 * observation, so the new pane, listed before its agent started, read as an agent that exited.
 * The takeover closes the held record as superseded first and registers the new session afresh.
 */
test('unit:session-liveness-model — GY-1532: a launch registered over a held record closes it as superseded and registers afresh, so the new session starts with no observation of the old', async () => {
  const writes: SessionHandleInput[] = [];
  let held = true;
  const record = async (handle: SessionHandleInput) => {
    writes.push(handle);
    if (handle.state === 'running' && !handle.supersede && held) throw new Error('Session handle r1 is held by another launch attempt that is still recorded running');
    if (handle.state === 'finished') held = false;
  };
  const handle: SessionHandleInput = { id: 'r1', kind: 'review', runtime: 'claude', host: 'host-1', subject: 'GY-1513: review', state: 'running' };
  assert.deepEqual(await registeredLaunch(record, handle, async () => ({ pane: 'wF:p3', agentName: 'review-claude' })), { pane: 'wF:p3', agentName: 'review-claude' });
  assert.deepEqual(writes.map(write => [write.state, write.supersede ?? false, write.pane ?? null, write.outcome ?? null]),
    [['running', false, null, null], ['finished', true, null, 'superseded: a later launch for GY-1513: review started its runtime, so this record describes the session before it'], ['running', true, 'wF:p3', null]],
    'refused, then the held record closed as superseded, then registered with its coordinates');
  assert.ok(writes[1].launch && writes[1].launch === writes[2].launch, 'both carry this launch\'s token');

  // Through the control plane: the held record, observed working and missed twice under another
  // launch's token, is closed and reopened; the new session carries none of that observation.
  let item = await engine.execute(operator, 'create', null, { title: 'Relaunch over a held record', plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Fresh', proofs: ['unit:fresh'] }] }, randomUUID());
  item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
  const earlier = { id: 'req-1', kind: 'review', role: 'review', runtime: 'claude', host: 'host-1', pane: 'wF:p8', agentName: 'review-claude', subject: `${item.key}: review`, state: 'running', launch: 'a'.repeat(32) } as const;
  await engine.execute(coordinator, 'session', item.id, earlier, randomUUID());
  await engine.execute(coordinator, 'session', item.id, { ...earlier, observed: 'working', observedAt: new Date(Date.now() - 120_000).toISOString(), missedReports: 2 }, randomUUID());
  const plane = (write: SessionHandleInput) => engine.execute(coordinator, 'session', item.id, write, randomUUID());
  const before = Date.now();
  await registeredLaunch(plane, { ...earlier, pane: undefined, agentName: undefined, launch: undefined }, async () => ({ pane: 'wF:p9', agentName: 'review-claude' }));
  const fresh = await handleOf(item.id, 'req-1');
  assert.deepEqual([fresh.state, fresh.pane, fresh.observed, fresh.missedReports, fresh.outcome], ['running', 'wF:p9', undefined, undefined, null], 'the record describes the new session alone');
  assert.ok(Date.parse(fresh.startedAt) >= before, 'and started now, so its pane is young until its agent appears');
  const [listed] = observeSessions([await reload(item.id)], [{ pane_id: 'wF:p9', agent: null, agent_status: 'unknown' }], new Date(), { hostId: 'host-1' }).entries.filter(entry => entry.id === 'req-1');
  assert.equal(listed, undefined, 'the new pane, listed before its agent starts, does not end the session');
});
