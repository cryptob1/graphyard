// Concern: the stalled-yard alert (GY-3101) — plain, non-AI code in the loop that tells the operator directly when queued work can neither start nor merge, so a person hears about a stopped yard within minutes even when the master session is down.
import type { Work } from '../model.js';
import { formatAge } from '../model/duration.js';
import { plainStage, waitingReason } from '../model/plain-stage.js';
import { resumeExitWindowMs } from '../master/session-resume.js';
import type { Cycle } from './cycle.js';
import { record } from './effects.js';
import { message, type DaemonState } from './state.js';

/** How often a lasting stop is re-alerted while it lasts. */
export const alertRepeatMs = 3_600_000;
/** The stall window before the loop alerts, `run.alertMinutes` unset (GY-3101). */
export const defaultAlertMinutes = 20;
export const alertMinutesOf = (run: { alertMinutes?: number | null }) => run.alertMinutes ?? defaultAlertMinutes;
/** The cursor key of the yard alert's one action row: `failed` while the stop stands, `done` on the all-clear. */
export const yardAlertKey = 'yard:alert';

/**
 * Queued work (GY-3101): open items that are not blocked, not parked (a parked item is one with a
 * standing blocker), and are waiting for a worker launch — no lease and no running session at
 * backlog, ready or build — or for a merge — a head the merge writer's queue owes. Items in review
 * or under tests are waiting on other roles, not on a launch or a merge, so they never hold the
 * alert open on their own.
 */
export function queuedForStartOrMerge(state: DaemonState, work: Work[], now: number): Work[] {
  const mergeQueued = new Set(state.mergeWriter.queue.map(entry => entry.key));
  return work.filter(item => {
    if (item.stage === 'done' || item.blocker) return false;
    if (mergeQueued.has(item.key)) return true;
    const label = plainStage(item, now);
    return label === 'Not started' || label === 'Waiting';
  });
}

/**
 * The newest instant the yard was seen moving (GY-3101): a merge the writer delivered
 * (`mergeWriter.lastMergeAt`), a worker session still up past the early-exit window of
 * worker-launch-health.ts — a session that stays up that long is itself a successful launch — a
 * session's recorded worktree progress — the reading the attempt bound advances by, so a session
 * that made progress and then exited still counts as a successful launch — or a dispatch that
 * landed within that window and whose item has no newer early-exit incident (the grace that keeps
 * a seconds-old launch from reading as a stop before it can prove itself). Null when neither the
 * cursor nor the snapshot names any movement.
 */
export function lastYardMovement(state: DaemonState, work: Work[], now: number): number | null {
  const times: number[] = [];
  const lastMergeAt = state.mergeWriter.lastMergeAt ? Date.parse(state.mergeWriter.lastMergeAt) : null;
  if (lastMergeAt !== null && Number.isFinite(lastMergeAt)) times.push(lastMergeAt);
  for (const item of work) for (const session of item.sessions ?? []) {
    if (session.kind !== 'implementation') continue;
    const startedAt = Date.parse(session.startedAt ?? '');
    if (session.state === 'running' && Number.isFinite(startedAt) && now - startedAt >= resumeExitWindowMs) times.push(startedAt);
    const progress = session.workTree ? Date.parse(session.workTree.at) : Number.NaN;
    if (Number.isFinite(progress)) times.push(progress);
  }
  for (const [key, action] of Object.entries(state.actions)) {
    if (!key.startsWith('dispatch:') || action.state !== 'done') continue;
    const at = Date.parse(action.at);
    if (!Number.isFinite(at) || now - at >= resumeExitWindowMs) continue;
    const incident = state.actions[`early-exit:${key.split(':')[1]}`];
    if (incident && Date.parse(incident.at) >= at) continue;
    times.push(at);
  }
  return times.length ? Math.max(...times) : null;
}

/**
 * The stop the operator is told about (GY-3101): when it started, or null while work starts or
 * merges. A stop begins at the yard's last movement; with no movement recorded at all — a fresh or
 * archived cursor — it begins at this first stalled observation, so the first alert comes one
 * window after the loop first saw the stop, and `since` names exactly that.
 */
export function yardStop(state: DaemonState, work: Work[], now: number, alertMs: number): { since: number; queued: Work[] } | null {
  const queued = queuedForStartOrMerge(state, work, now);
  if (!queued.length) return null;
  const last = lastYardMovement(state, work, now);
  if (last !== null && now - last < alertMs) return null;
  return { since: last ?? now, queued };
}

/**
 * The top cause line (GY-3101, the item's own ranking): the newest failed launch the cursor names
 * among the queued items — a refused dispatch or an early-exit incident, the loop's own most recent
 * observation, either of which carries the error text — else the waiting line of the first queued
 * item that has one (waitingReason, the control plane's record of why nothing launched), else a
 * plain fallback.
 */
export function topCauseLine(state: DaemonState, queued: Work[]): string {
  const keys = new Set(queued.map(item => item.key));
  const failures = Object.values(state.actions)
    .filter(action => action.kind === 'dispatch' && action.state === 'failed' && action.work !== null && keys.has(action.work))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (failures.length) return failures[0].detail;
  const waiting = queued.find(item => waitingReason(item) !== null);
  return waiting ? `${waiting.key}: ${waitingReason(waiting)}` : 'no launch failure is recorded; nothing has started';
}

/** One short line (GY-3101): what stopped, since when, and the top cause line. */
export function yardAlertText(repository: string, since: number, now: number, queued: Work[], cause: string) {
  return `Graphyard ${repository}: the yard stopped — no worker launch and no merge for ${formatAge(since, now)} (since ${new Date(since).toISOString()}), while ${queued.length} item(s) wait to start or merge (${queued.map(item => item.key).slice(0, 5).join(', ')}). Cause: ${cause}`;
}

/** The one all-clear (GY-3101), sent when work moves again after an alert. */
export const yardAllClearText = (repository: string, since: string, now: number) =>
  `Graphyard ${repository}: the yard is moving again — work started or merged after ${formatAge(since, now)} stopped (since ${since})`;

/**
 * The alert step (GY-3101), run by the cycle's persist step on the install's own loop: with
 * `run.alertUrl` set, one alert when queued work has had no successful worker launch and no merge
 * for `run.alertMinutes`, repeated at most hourly while the stop lasts, and one all-clear when work
 * moves again. The stop start and the last alert time live on the cursor, so a restart neither
 * re-alerts at once nor loses the all-clear. With no URL the step is inert and nothing is recorded.
 */
export async function yardAlertStep(cycle: Cycle) {
  const { config, state, effects, snapshot, clock, now } = cycle;
  if (config.forPerson || !config.run.alertUrl || !effects.alertWebhook) return;
  const alertMs = alertMinutesOf(config.run) * 60_000, iso = (at: number) => new Date(at).toISOString();
  const stop = yardStop(state, snapshot.work, clock, alertMs);
  if (!stop) {
    const stoppedAt = state.alerts.stoppedAt;
    if (stoppedAt === null) return;
    // Work moved again: one all-clear is owed exactly when an alert was sent.
    if (state.alerts.lastAlertAt === null) { state.alerts = { stoppedAt: null, lastAlertAt: null }; return; }
    const text = yardAllClearText(config.repository, stoppedAt, clock);
    try {
      await effects.alertWebhook(text);
      state.alerts = { stoppedAt: null, lastAlertAt: null };
      await record(state, yardAlertKey, { kind: 'attention', work: null, principal: null, state: 'done', detail: `The yard moved again after ${formatAge(stoppedAt, clock)}; the all-clear was sent to the operator`, attempts: (state.actions[yardAlertKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
    } catch (error) {
      await record(state, yardAlertKey, { kind: 'attention', work: null, principal: null, state: 'failed', detail: `The yard moved again but the all-clear could not be sent: ${message(error)}`, attempts: (state.actions[yardAlertKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
    }
    return;
  }
  if (state.alerts.stoppedAt === null) state.alerts.stoppedAt = iso(stop.since);
  const since = Date.parse(state.alerts.stoppedAt);
  const lastAlertAt = state.alerts.lastAlertAt ? Date.parse(state.alerts.lastAlertAt) : null;
  if (clock - since < alertMs) return;
  if (lastAlertAt !== null && clock - lastAlertAt < alertRepeatMs) return;
  const text = yardAlertText(config.repository, since, clock, stop.queued, topCauseLine(state, stop.queued));
  try {
    await effects.alertWebhook(text);
    state.alerts.lastAlertAt = iso(clock);
    await record(state, yardAlertKey, { kind: 'attention', work: null, principal: null, state: 'failed', detail: text, attempts: (state.actions[yardAlertKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
  } catch (error) {
    // A webhook that cannot be reached is retried no more than hourly either.
    state.alerts.lastAlertAt = iso(clock);
    await record(state, yardAlertKey, { kind: 'attention', work: null, principal: null, state: 'failed', detail: `Could not alert the operator (${text}): ${message(error)}`, attempts: (state.actions[yardAlertKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
  }
}
