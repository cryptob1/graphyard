// Concern: the stall alarm (GY-3432) — one check per cycle over readings the loop already has. Free
// worker slots and ready work with no launch for 10 minutes, or an open item nobody has acted on
// for an hour, raise one line naming the cause: it stands first in `master status`, on the Master
// page, and wakes the master once (masterCauses). It clears on its own the cycle it no longer holds.
import type { Work } from '../model.js';
import type { AgentRegistry } from '../model/registry.js';
import { exhaustionEvidence } from '../model/account-quota.js';
import { parkedOnHuman } from '../model/human-request.js';
import { actionDetailMax, storeAction, type DaemonState } from './state.js';

export const stallAlarmKey = 'stall-alarm';
/** Free capacity and ready work with no launch this long raise the alarm. */
export const stallIdleMs = 10 * 60_000;
/** An open item with no change and no actor this long raises it too. */
export const noActorMs = 60 * 60_000;

export interface StallReadings {
  now: number;
  /** Open items in scope; `ready` are the ones dispatch could launch now. */
  open: readonly Work[]; ready: readonly Work[];
  freeSlots: number;
  /** GY-3473: what holds every implementation launch this cycle — disk, CPU pressure, an untrusted checkout, a running batch gate — as dispatch itself decided it. */
  holds?: readonly string[];
  /** GY-3502: the dispatch gate refusing each ready item this cycle, by key, as `KEY waits: why`. */
  gates?: ReadonlyMap<string, string>;
  state: Pick<DaemonState, 'actions' | 'stepFailures' | 'launchBackoff' | 'cpuPressure' | 'release' | 'lock' | 'mergeWriter'>;
  registry: Pick<AgentRegistry, 'accounts' | 'roles'> | null;
  /** The commit the deploy unit serves, null when none is recorded. */
  serving: string | null;
}

const iso = (at: number) => new Date(at).toISOString();
const live = (item: Work, now: number) => (!!item.lease && Date.parse(item.lease.expiresAt) > now) || (item.sessions ?? []).some(session => session.state === 'running');

/**
 * The newest worker launch that took: a session still running, a session's recorded worktree
 * progress, or a dispatch the loop recorded done; else the loop's own start. A launch that failed
 * and exited is not one.
 */
export function lastLaunchAt(state: StallReadings['state'], work: readonly Work[]): number | null {
  const times: number[] = [];
  for (const item of work) for (const session of item.sessions ?? []) {
    if (session.kind !== 'implementation') continue;
    if (session.state === 'running') times.push(Date.parse(session.startedAt ?? ''));
    if (session.workTree) times.push(Date.parse(session.workTree.at));
  }
  for (const [key, action] of Object.entries(state.actions)) if (key.startsWith('dispatch:') && action.state === 'done') times.push(Date.parse(action.at));
  const seen = times.filter(Number.isFinite);
  return seen.length ? Math.max(...seen) : state.lock ? Date.parse(state.lock.startedAt) : null;
}

/**
 * Why nothing launches now, from what the loop already read, most direct first: dispatch's own
 * holds this cycle, then a failing dispatch step or a launch refusal still backing off — an expired
 * backoff, or one for a done item, is history, not a cause (GY-3473, GY-3502). Else the dispatch gate
 * refusing each of the first five ready items; an item with no actor only when no gate explains it.
 */
export function stallCauses({ now, open, ready, holds = [], gates, state, registry, serving }: StallReadings): string[] {
  const causes = [...holds];
  // GY-3502: a launch failure counts only while its back-off runs and its item is open.
  const openIds = new Set(open.map(item => item.id));
  const launchFailure = Object.entries(state.launchBackoff).filter(([key, entry]) => Date.parse(entry.until) > now && openIds.has(key.slice(key.indexOf(':') + 1))).map(([, entry]) => entry).sort((a, b) => Date.parse(b.until) - Date.parse(a.until))[0];
  const dispatchError = state.stepFailures.dispatch?.reason ?? (launchFailure && `${launchFailure.reason} (launches back off until ${launchFailure.until})`);
  if (dispatchError) causes.push(`last dispatch error: ${dispatchError}`);
  const names = registry?.roles.find(role => role.name === 'worker')?.accounts ?? [];
  const accounts = (registry?.accounts ?? []).filter(account => account.enabled && names.includes(account.name));
  const spent = accounts.map(account => [account.name, exhaustionEvidence(account.quota, now)] as const);
  if (spent.length && spent.every(([, evidence]) => evidence)) causes.push(`every worker account is out of quota: ${spent.map(([name, evidence]) => `${name} (${evidence})`).join(', ')}`);
  const loaded = state.release?.commit ?? null;
  if (serving && loaded && serving !== loaded) causes.push(`the loop runs ${loaded.slice(0, 12)}, older than the served ${serving.slice(0, 12)}; restart it with graphyard master restart`);
  if (!causes.length) causes.push(...ready.slice(0, 5).map(item => gates?.get(item.key) ?? `${item.key} has no actor: ready, with no lease and no session`));
  return causes;
}

/** The one alarm line, or null while work moves. Stable while the stall lasts, so it wakes the master once. */
export function stallAlarm(readings: StallReadings): string | null {
  const { now, open, ready, freeSlots, state } = readings;
  const lines: string[] = [];
  // Idle since the last launch, or since the longest-waiting ready item last changed, whichever is later.
  const last = lastLaunchAt(state, open), waiting = Math.min(...ready.map(item => Date.parse(item.updatedAt)).filter(Number.isFinite));
  const since = last === null ? waiting : Math.max(last, waiting);
  const stalled = ready.length > 0 && freeSlots > 0 && Number.isFinite(since) && now - since >= stallIdleMs;
  if (stalled)
    lines.push(`${ready.length} ready item(s) (${ready.slice(0, 5).map(item => item.key).join(', ')}) and ${freeSlots} free worker slot(s), but no launch since ${iso(since)}. Cause: ${stallCauses(readings).join('; ')}`);
  const merging = new Set([...state.mergeWriter.queue.map(entry => entry.key), ...(state.mergeWriter.inFlights ?? []).map(entry => entry.key), ...(state.mergeWriter.inFlight ? [state.mergeWriter.inFlight.key] : [])]);
  const idle = open.filter(item => item.ready && item.stage !== 'done' && !item.blocker && !item.hold && !parkedOnHuman(item) && !item.dependencies.some(id => open.some(other => other.id === id)) && !live(item, now) && !merging.has(item.key)
    && !(stalled && ready.includes(item)) && now - Date.parse(item.updatedAt) >= noActorMs);
  for (const item of idle.slice(0, 5)) lines.push(item.stage === 'ready' && readings.gates?.get(item.key) || `${item.key} has no actor: at ${item.stage} with no lease and no session, unchanged since ${item.updatedAt}`);
  return lines.length ? `Stall: ${lines.join(' ')}` : null;
}

/** Raises, updates or clears the alarm's one cursor entry; the master is woken by masterCauses. */
export function recordStallAlarm(state: DaemonState, text: string | null, now: number) {
  const standing = state.actions[stallAlarmKey];
  if (!text) { if (standing) delete state.actions[stallAlarmKey]; return !!standing; }
  const detail = text.slice(0, actionDetailMax);
  if (standing?.detail === detail) return false;
  storeAction(state, stallAlarmKey, { kind: 'attention', work: null, principal: null, state: 'failed', detail, attempts: 1, epoch: null, cycle: state.cycle, at: iso(now) });
  return true;
}
