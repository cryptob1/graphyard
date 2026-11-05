import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Launcher, runCycle } from '../src/daemon/cycle.js';
import type { Cycle } from '../src/daemon/cycle.js';
import { emptyDaemonState, type DaemonState } from '../src/daemon/state.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { alertRepeatMs, lastYardMovement, queuedForStartOrMerge, topCauseLine, yardAlertStep, yardAlertText, yardStop } from '../src/daemon/yard-alerts.js';
import { loopAlerts, loopRegistry } from '../src/model/loop-presence.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { SessionHandle } from '../src/model/sessions.js';
import type { Work } from '../src/model.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { AlertsLine } from '../web/pages/setup.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3101: the loop alerts the operator directly when queued work cannot start or merge —
// one alert after the window (run.alertMinutes, default 20), repeated at most hourly, one
// all-clear when work moves again, the stop start and last-alert times on the cursor so a
// restart neither re-alerts at once nor loses the all-clear, and master status plus the
// dashboard saying alerts are off with no run.alertUrl.

const start = Date.parse('2030-04-01T00:00:00Z');
const minute = 60_000, iso = (at: number) => new Date(at).toISOString();
const alertMinutes = 20, alertMs = alertMinutes * 60_000;

const base = { version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] };
const config = (run: Record<string, unknown> = {}) => masterConfigSchema.parse({ ...base, run: { alertUrl: 'https://ntfy.example/yard', ...run } }) as MasterConfig;
const offConfig = masterConfigSchema.parse({ ...base }) as MasterConfig;

const item = (fields: Record<string, unknown>) => ({
  description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:yard'] }],
  policy: { checks: ['test'], review: true }, revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(start),
  ready: true, epoch: 0, lease: null, workspaces: [], submission: null, candidate: null, reworkRequested: false, scenarioRequirements: [], evidence: [],
  observation: null, blocker: null, violations: [], sessions: [], stage: 'ready', ...fields }) as unknown as Work;

/** A session handle: `running` implementation sessions are the movement the alert reads. */
const session = (fields: Partial<SessionHandle> = {}) => ({ id: 'worker-a:1', kind: 'implementation', principal: 'worker-a', epoch: 1, runtime: 'claude', host: 'machine-a',
  pane: 'p1', agentName: 'agent-a', state: 'running', startedAt: iso(start - 5 * minute), updatedAt: iso(start - 5 * minute), ...fields }) as SessionHandle;

/** A dispatch action row with a failed launch in its history: what `waitingReason` reads. */
const failedDispatch = (at: number, reason: string) => ({ id: 'row-1', kind: 'dispatch', work: 'w1', key: 'GY-1', inputs: { kind: 'dispatch', epoch: 0, target: 'implementation', priority: 1 },
  gate: 'build', refusal: null, reason: 'GY-1 is ready and unassigned', binding: 'dispatch:0', requestedBy: 'graphyard', requestedAt: iso(at), state: 'pending', claim: null, attempts: 3,
  history: [{ at: iso(at), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: 'GY-1 is ready and unassigned' },
    { at: iso(at + minute), event: 'failed', requester: 'graphyard', executor: 'loop', result: 'failed', reason }] });

function cycle(config: MasterConfig, state: DaemonState, work: Work[], clock: number, posts: string[], webhook: (text: string) => Promise<void> = async text => { posts.push(text); }): Cycle {
  const effects = { alertWebhook: webhook, persist: async () => {} } as unknown as DaemonEffects;
  return { config, state, effects, now: () => clock, snapshot: { work, now: iso(clock) }, clock, herdr: { agents: [], available: true },
    credentials: {}, performed: [], launcher: new Launcher(1), reservedProfiles: new Set() };
}

const stateWith = (fields: Record<string, unknown> = {}) => {
  const state = emptyDaemonState(config());
  return Object.assign(state, fields) as DaemonState;
};

test('unit:stalled-yard-alerts-operator — queued work with no launch and no merge past the window posts one alert naming the stop, since when and the top cause, repeats at most hourly, and sends one all-clear when work moves again', async () => {
  const posts: string[] = [], at = start;
  const lastMerge = at - 25 * minute;
  const state = stateWith();
  state.mergeWriter.lastMergeAt = iso(lastMerge);
  // GY-1 waits for a launch with a recorded launch failure; GY-2 is parked (a standing blocker); GY-3 is in review; GY-4 waits for its merge.
  state.mergeWriter.queue = [{ key: 'GY-4', id: 'w4', head: 'a'.repeat(40), submittedAt: iso(lastMerge), waitingMs: 0 }];
  const work = [
    item({ id: 'w1', key: 'GY-1', title: 'Waiting', actionQueue: { actions: [failedDispatch(lastMerge, 'mise shim not found in PATH')], history: [] } }),
    item({ id: 'w2', key: 'GY-2', title: 'Parked', blocker: 'waits on the owner' }),
    item({ id: 'w3', key: 'GY-3', title: 'In review', stage: 'review' }),
    item({ id: 'w4', key: 'GY-4', title: 'Merge owed', stage: 'merge' }),
  ];
  // The cursor also holds a newer early-exit incident on a queued item: that is the top cause line.
  state.actions['early-exit:w4'] = { kind: 'dispatch', work: 'GY-4', principal: 'worker-a', state: 'failed', detail: 'GY-4 epoch 1: worker exited unsuccessfully (code 1) within 60s without submitting or committing', attempts: 1, epoch: 1, cycle: 3, at: iso(at - 3 * minute) };
  assert.deepEqual(queuedForStartOrMerge(state, work, at).map(entry => entry.key), ['GY-1', 'GY-4'], 'open, unblocked items waiting for a launch or a merge are the queued work; parked and in-review items are not');
  assert.equal(topCauseLine(state, queuedForStartOrMerge(state, work, at)), state.actions['early-exit:w4'].detail, 'the newest failed launch the cursor names among the queued items is the top cause line');

  // One minute later the window has passed: one alert, at once, because the last movement is 26 minutes old.
  const first = at + minute;
  await yardAlertStep(cycle(config(), state, work, first, posts));
  assert.equal(posts.length, 1, 'one alert is posted');
  assert.ok(posts[0].includes('no worker launch and no merge'), 'the alert names what stopped');
  assert.ok(posts[0].includes(`since ${iso(lastMerge)}`), 'the alert names since when: the yard last moved');
  assert.ok(posts[0].includes('2 item(s) wait to start or merge (GY-1, GY-4)'), 'the alert names the queued work');
  assert.ok(posts[0].includes(`Cause: ${state.actions['early-exit:w4'].detail}`), 'the alert carries the top cause line');
  assert.equal(state.alerts.stoppedAt, iso(lastMerge), 'the stop start is kept on the cursor');
  assert.equal(state.alerts.lastAlertAt, iso(first), 'the last alert time is kept on the cursor');

  // Half an hour on, still stopped: no second alert inside the hour.
  await yardAlertStep(cycle(config(), state, work, first + 30 * minute, posts));
  assert.equal(posts.length, 1, 'the alert repeats at most hourly');

  // Past the hour, still stopped: exactly one repeat.
  await yardAlertStep(cycle(config(), state, work, first + alertRepeatMs + minute, posts));
  assert.equal(posts.length, 2, 'a lasting stop is re-alerted hourly');

  // A worker session that stayed up past the early-exit window is work moving again: one all-clear, and the stop is closed.
  const moving = [...work, item({ id: 'w5', key: 'GY-5', title: 'Building', stage: 'build', lease: { owner: 'worker-a', epoch: 1, expiresAt: iso(first + 2 * alertRepeatMs) }, sessions: [session({ startedAt: iso(first + alertRepeatMs) })] })];
  await yardAlertStep(cycle(config(), state, moving, first + alertRepeatMs + 6 * minute, posts));
  assert.equal(posts.length, 3, 'one all-clear is posted when work moves again');
  assert.ok(posts[2].includes('the yard is moving again'), 'the all-clear says work moved');
  assert.deepEqual(state.alerts, { stoppedAt: null, lastAlertAt: null }, 'the stop and its alert record are cleared by the all-clear');
  assert.equal(state.actions['yard:alert'].state, 'done', 'the cursor action row closes with the all-clear');
});

test('unit:stalled-yard-alerts-operator — no stop while work moves: a session up past the early-exit window, a merge inside the window and a seconds-old landed dispatch each hold the alert, and a dispatch followed by a newer early-exit incident does not', async () => {
  const posts: string[] = [], at = start;
  const queued = [item({ id: 'w1', key: 'GY-1', title: 'Waiting' })];
  // A worker session up past the 60s early-exit window is a successful launch: no stop.
  const building = [item({ id: 'w2', key: 'GY-2', title: 'Building', stage: 'build', lease: { owner: 'worker-a', epoch: 1, expiresAt: iso(at + minute) }, sessions: [session()] })];
  assert.equal(lastYardMovement(stateWith(), building, at), start - 5 * minute, 'a session up past the early-exit window is movement');
  let state = stateWith();
  assert.equal(yardStop(state, [...queued, ...building], at, alertMs), null, 'a running worker holds the alert even with a stale merge');
  await yardAlertStep(cycle(config(), state, [...queued, ...building], at, posts));
  assert.equal(posts.length, 0, 'nothing is posted while a worker is up');

  // A merge inside the window is movement: no stop.
  state = stateWith();
  state.mergeWriter.lastMergeAt = iso(at - 5 * minute);
  assert.equal(yardStop(state, queued, at, alertMs), null, 'a merge inside the window holds the alert');
  await yardAlertStep(cycle(config(), state, queued, at, posts));
  assert.equal(posts.length, 0);

  // A dispatch that landed seconds ago, with no newer early-exit incident, is movement.
  state = stateWith();
  state.actions['dispatch:w1:1'] = { kind: 'dispatch', work: 'GY-1', principal: 'worker-a', state: 'done', detail: 'Launched GY-1', attempts: 1, epoch: 1, cycle: 2, at: iso(at - 30_000) };
  assert.equal(lastYardMovement(state, queued, at), at - 30_000, 'a landed dispatch inside the early-exit window is movement');
  await yardAlertStep(cycle(config(), state, queued, at, posts));
  assert.equal(posts.length, 0, 'a launch that just landed holds the alert before it can prove itself');

  // The same dispatch with a newer early-exit incident is no movement: the alert is owed.
  state.actions['early-exit:w1'] = { kind: 'dispatch', work: 'GY-1', principal: 'worker-a', state: 'failed', detail: 'GY-1 epoch 1: worker exited unsuccessfully (SIGKILL) within 60s without submitting or committing', attempts: 1, epoch: 1, cycle: 2, at: iso(at - 10_000) };
  assert.equal(lastYardMovement(state, queued, at), null, 'a launch whose session early-exited is not movement');
  const stopped = yardStop(state, queued, at, alertMs);
  assert.ok(stopped, 'queued work with no movement at all is a stop');
  assert.equal(stopped!.since, at, 'with no movement ever recorded, the stop starts at this first observation');

  // A session that made progress and exited — its worktree reading is recent — is a successful launch: no stop.
  const progressed = [item({ id: 'w6', key: 'GY-6', title: 'Progressed', stage: 'build', sessions: [session({ state: 'finished', startedAt: iso(at - 30 * minute), workTree: { head: 'b'.repeat(40), dirty: null, at: iso(at - 5 * minute) } })] })];
  assert.equal(lastYardMovement(stateWith(), progressed, at), at - 5 * minute, 'a session that made progress counts as movement');
  assert.equal(yardStop(stateWith(), [...queued, ...progressed], at, alertMs), null, 'progress inside the window holds the alert');
  await yardAlertStep(cycle(config(), stateWith(), [...queued, ...progressed], at, posts));
  assert.equal(posts.length, 0, 'nothing is posted while an attempt progressed inside the window');
});

test('unit:stalled-yard-alerts-operator — a restart neither re-alerts at once nor loses the all-clear, and a stop that ends inside the window sends no all-clear', async () => {
  const posts: string[] = [], at = start;
  const queued = [item({ id: 'w1', key: 'GY-1', title: 'Waiting' })];
  // A cursor a previous loop left: a stop 25 minutes old, alerted 5 minutes ago.
  const state = stateWith();
  state.alerts = { stoppedAt: iso(at - 25 * minute), lastAlertAt: iso(at - 5 * minute) };
  await yardAlertStep(cycle(config(), state, queued, at, posts));
  assert.equal(posts.length, 0, 'a restarted loop does not re-alert at once');
  assert.equal(state.alerts.stoppedAt, iso(at - 25 * minute), 'the recorded stop start survives the restart');

  // Work moves again: the all-clear the earlier loop owed is still sent.
  const moving = [item({ id: 'w2', key: 'GY-2', title: 'Building', stage: 'build', lease: { owner: 'worker-a', epoch: 1, expiresAt: iso(at + minute) }, sessions: [session()] })];
  await yardAlertStep(cycle(config(), state, moving, at + minute, posts));
  assert.equal(posts.length, 1);
  assert.ok(posts[0].includes('the yard is moving again'), 'the all-clear is not lost across the restart');
  assert.deepEqual(state.alerts, { stoppedAt: null, lastAlertAt: null });

  // A stop that ends inside the window, before any alert, sends nothing at all.
  const ended = stateWith();
  ended.alerts = { stoppedAt: iso(at - 5 * minute), lastAlertAt: null };
  await yardAlertStep(cycle(config(), ended, moving, at + minute, posts));
  assert.equal(posts.length, 1, 'no all-clear is sent when no alert was');
  assert.deepEqual(ended.alerts, { stoppedAt: null, lastAlertAt: null }, 'the unalerted stop is simply closed');

  // A fresh cursor, no movement recorded at all: the stop starts at the first observation and the first alert waits out the window.
  const fresh = stateWith();
  await yardAlertStep(cycle(config(), fresh, queued, at, posts));
  assert.equal(posts.length, 1, 'no alert before the window has passed since the first observation');
  assert.equal(fresh.alerts.stoppedAt, iso(at), 'the first stalled observation is recorded as the stop start');
  await yardAlertStep(cycle(config(), fresh, queued, at + alertMs, posts));
  assert.equal(posts.length, 2, 'the first alert comes one window after the first observation');
  assert.ok(posts[1].includes(`since ${iso(at)}`), 'the alert names the observed stop start');
});

test('unit:stalled-yard-alerts-operator — with no run.alertUrl the step is inert and master status and the dashboard say alerts are off; with it, status carries the stop and the dashboard reads the loop\'s own on/off', async () => {
  const posts: string[] = [];
  const queued = [item({ id: 'w1', key: 'GY-1', title: 'Waiting' })];
  const state = stateWith();
  state.mergeWriter.lastMergeAt = iso(start - 25 * minute);
  await yardAlertStep(cycle(offConfig, state, queued, start, posts));
  assert.equal(posts.length, 0, 'no webhook is called with no alertUrl');
  assert.deepEqual(state.alerts, { stoppedAt: null, lastAlertAt: null }, 'nothing is recorded with no alertUrl');

  // Master status says alerts are off, and on with the URL, naming the recorded stop.
  const root = await temporaryDirectory('yard-alerts-status');
  const off = await masterStatusReport(root, offConfig, async () => ({ work: [], now: iso(start) }), async () => { throw new Error('no git in the fixture'); });
  assert.deepEqual(off.alerts, { on: false }, 'master status says alerts are off with no run.alertUrl');
  const on = await masterStatusReport(root, config(), async () => ({ work: queued, now: iso(start) }), async () => { throw new Error('no git in the fixture'); });
  assert.deepEqual(on.alerts, { on: true, url: 'https://ntfy.example/yard', minutes: 20, stoppedAt: null, lastAlertAt: null }, 'master status names the alert URL, window and recorded stop');

  // The dashboard reads the loop's own on/off naming: the coordination-read header, kept beside the loop's presence.
  assert.equal(loopAlerts('on'), true);
  assert.equal(loopAlerts('off'), false);
  assert.equal(loopAlerts(undefined), null, 'an older loop names nothing');
  const registry = loopRegistry({});
  registry.observe({ principal: 'loop', intervalSeconds: 20, alerts: loopAlerts('off') }, new Date(start));
  assert.equal(registry.live(new Date(start))?.alerts, false, 'the control plane keeps the loop\'s alerts naming beside its presence');
  assert.ok(renderToStaticMarkup(createElement(AlertsLine, { status: { setup: { alerts: false } } })).includes('Alerts are off'), 'the dashboard says alerts are off');
  assert.ok(renderToStaticMarkup(createElement(AlertsLine, { status: { setup: { alerts: true } } })).includes('Alerts are on'), 'the dashboard says alerts are on when the loop names them');
});

test('unit:stalled-yard-alerts-operator — the alert runs inside the cycle\'s persist step, which stays the fifth of five steps', async () => {
  const posts: string[] = [], at = start;
  const state = stateWith();
  state.mergeWriter.lastMergeAt = iso(at - alertMinutes * minute - 5 * minute);
  const work = [item({ id: 'w1', key: 'GY-1', title: 'Waiting' })];
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: iso(at) }),
    agents: () => [], herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({}),
    closeSession: () => {},
    dispatch: async () => { throw new Error('no worker profiles'); },
    alertWebhook: async text => { posts.push(text); },
    persist: async () => {},
  };
  const result = await runCycle(config(), state, effects, () => at);
  assert.deepEqual(result.metrics.steps, ['snapshot', 'close', 'dispatch', 'merge writer', 'persist'], 'the cycle keeps exactly its five steps');
  assert.equal(posts.length, 1, 'the alert is posted by the cycle itself once the window has passed');
  assert.ok(posts[0].startsWith('Graphyard owner/project: the yard stopped'));
  assert.equal(state.alerts.lastAlertAt, iso(at));
});

test('unit:stalled-yard-alerts-operator — the alert text stays one bounded line: what stopped, since when, the queued keys and the cause', () => {
  const since = start - 47 * minute;
  const text = yardAlertText('owner/project', since, start, [item({ key: 'GY-1' }), item({ key: 'GY-2' })], 'mise shim not found in PATH');
  assert.ok(text.includes('for 47m') && text.includes(`since ${iso(since)}`) && text.includes('(GY-1, GY-2)') && text.includes('Cause: mise shim not found in PATH'), 'what stopped, since when, the queued keys and the cause');
  assert.ok(!text.includes('\n'), 'the alert is one line');
});
