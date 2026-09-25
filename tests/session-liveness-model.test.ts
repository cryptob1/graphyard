import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';
import { recordSession, type RuntimeSession, type SessionHandle } from '../src/model/sessions.js';
import { lostAfterReports, observeSessions, observedRuntimeState, reportedHandle, sessionObservationFreshMs, sessionObservationRefreshMs, sessionView, runningSessions } from '../src/model/session-state.js';
import { dispatchEffects, emptyDispatchCursor, herdrSessionListing, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { runtimeEndedStates } from '../src/harness.js';
import { masterConfigSchema } from '../src/master.js';
import { sessionReport } from '../src/cli/master-status.js';

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
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-session-model-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
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
  const work = (sessions: SessionHandle[]) => [{ id: 'w', key: 'GY-1', sessions } as unknown as Work];
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
