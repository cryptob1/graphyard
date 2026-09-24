import type { Work } from './work.js';
import { attachCommand, endedRuntimeStates, runtimeSessionOf, sessionRole, type LivenessOptions, type ObservedSessionState, type RuntimeSession, type RuntimeStates, type SessionHandle, type SessionHandleInput, type SessionKind } from './sessions.js';

/**
 * One session state for every reader (GY-172). `sessions.ts` holds the record; this module holds
 * what is observed of it — the loop's report on every dispatch tick, written to the record — the
 * one reading every reader shows it by, and the registration every launch makes before its
 * runtime starts, so there is nothing to observe that was never registered.
 */
const defaultStates: RuntimeStates = () => endedRuntimeStates;

/**
 * How a reader shows one session (GY-172). Every reader — the Workers page and its counts, the
 * Work page, `master status` — goes through this one reading, so no two of them can disagree about
 * whether an agent is alive. A session is shown running only while its record is open and its
 * latest observation is `working` or `idle` and no older than `sessionObservationFreshMs`; `seen`
 * is that observation's time. A handle nothing has observed yet reads its launcher's record as the
 * first sighting — the launcher watched it start — so a session registered a moment ago is not
 * shown dead, and one the loop never reports goes unseen once that sighting is stale.
 */
export const sessionObservationFreshMs = 15 * 60_000;
export interface SessionObservationReading { state: ObservedSessionState; at: string }
export function latestObservation(handle: Pick<SessionHandle, 'state' | 'updatedAt' | 'observed' | 'observedAt'>): SessionObservationReading | null {
  if (handle.observed && handle.observedAt) return { state: handle.observed, at: handle.observedAt };
  return handle.state === 'running' ? { state: 'working', at: handle.updatedAt } : null;
}
export interface SessionView {
  /** The latest observation's state, or null for an ended record nothing observed. */
  observed: ObservedSessionState | null;
  /** When the session was last seen: the latest observation's time. */
  seenAt: string | null;
  /** Shown as running: an open record whose latest observation is working or idle, and fresh. */
  live: boolean;
  /** For an open record not shown running, how long since it was last seen; null otherwise. */
  unseenMs: number | null;
}
export function sessionView(handle: Pick<SessionHandle, 'state' | 'updatedAt' | 'observed' | 'observedAt'>, now: Date, freshMs = sessionObservationFreshMs): SessionView {
  const latest = latestObservation(handle);
  const at = Date.parse(latest?.at ?? '');
  const ageMs = Number.isFinite(at) ? Math.max(0, now.getTime() - at) : null;
  const live = handle.state === 'running' && !!latest && (latest.state === 'working' || latest.state === 'idle') && ageMs !== null && ageMs <= freshMs;
  return { observed: latest?.state ?? null, seenAt: latest?.at ?? null, live, unseenMs: handle.state === 'running' && !live ? ageMs ?? 0 : null };
}

/** One line per session for a reader: what it is, what it works on, how to watch or read it, and how it is shown. */
export function sessionSummary(work: Work, now: Date) {
  return (work.sessions ?? []).map(handle => ({
    ...handle, key: work.key, attach: attachCommand(handle),
    runningMs: handle.state === 'running' ? Math.max(0, now.getTime() - Date.parse(handle.startedAt)) : Math.max(0, Date.parse(handle.endedAt ?? handle.updatedAt) - Date.parse(handle.startedAt)),
    ...sessionView(handle, now),
  }));
}

/** Every session shown running across the graph, longest-running first. */
export function runningSessions(all: Work[], now: Date) {
  return all.flatMap(work => sessionSummary(work, now).filter(handle => handle.live))
    .sort((a, b) => b.runningMs - a.runningMs);
}
/** Every open record not shown running — recorded open, but not seen working or idle lately — longest unseen first. */
export function unseenSessions(all: Work[], now: Date) {
  return all.flatMap(work => sessionSummary(work, now).filter(handle => handle.state === 'running' && !handle.live))
    .sort((a, b) => (b.unseenMs ?? 0) - (a.unseenMs ?? 0));
}

/**
 * The one session state (GY-172): what the loop observes of every Graphyard-launched session it
 * can see, on every dispatch tick, and writes to the handle as `observed` and `observedAt`.
 *
 * Liveness had no single owner. The loop read the runtime, the server read `updatedAt`, the dashboard
 * read a stale badge off it, and each concluded something different: a worker the loop saw
 * building was "not seen for 22m" on the Workers page, a worker whose agent had exited to a shell
 * stayed "Builds code" for hours because the runtime still listed its pane, and sessions no
 * launcher registered were never observed or closed at all. Now the loop is the one observer, the
 * handle is the one record, and `sessionView` is the one reading.
 *
 * The rules, per open handle on this host with a coordinate to match:
 * - listed with an agent in the pane: `working` when the runtime says so, `idle` for any at-prompt
 *   state (`idle`, `done`, `blocked`), and `ended` for a state the runtime reserves for an exit;
 * - listed with no agent in the pane (the agent exited to a shell): `ended`;
 * - not listed: one missed report; absent from `lostAfterReports` consecutive reports, `lost`.
 * `ended` and `lost` close the record with the reason. A runtime that could not be read is a gap,
 * not a report: nothing is counted against any session. A handle nothing has observed yet is left
 * alone through `sessionLaunchGraceMs`, because a session is registered before its runtime starts.
 *
 * The loop computes a report on every tick and writes a handle when its observation changes, a
 * report missed it, or its last observation is older than `sessionObservationRefreshMs` — so the
 * record stays fresh inside `sessionObservationFreshMs` while a steady session costs one write per
 * refresh interval rather than one per tick.
 */
export const lostAfterReports = 2, sessionLaunchGraceMs = 3 * 60_000, sessionObservationRefreshMs = 5 * 60_000;
/** What one listed runtime entry says about the session in it. */
export function observedRuntimeState(entry: RuntimeSession, runtime: string, states: RuntimeStates = defaultStates): 'working' | 'idle' | 'ended' {
  if (entry.agent === null || entry.agent === '') return 'ended';
  const status = entry.agent_status ?? '';
  if (states(runtime).includes(status)) return 'ended';
  return status === 'working' ? 'working' : 'idle';
}
export interface SessionReportEntry {
  workId: string; key: string; id: string; kind: SessionKind; role: string; runtime: string; host: string; subject: string;
  /** The observation to store: the new reading, or the last one carried while a report missed it. */
  observed: ObservedSessionState | null; observedAt: string | null; missedReports: number;
  /** Closed by this report (ended or lost), with the reason it is closed with. */
  closed: 'ended' | 'lost' | null; outcome: string | null;
  /** Whether the stored record must be written: the observation moved, a report missed it, or it is due a refresh. */
  changed: boolean;
}
export interface SessionReport {
  entries: SessionReportEntry[];
  /** When each handle this report missed was first missed, for the closing reason to say how long. */
  missing: Record<string, string>;
}
export type ObserveOptions = LivenessOptions & { hostId?: string | null; launchGraceMs?: number; refreshMs?: number;
  /** Handles already closed this tick by the item's own facts (superseded), keyed `workId\0id`. */
  settled?: ReadonlySet<string>;
  /** When each handle the previous report missed was first missed; a handle in it is missing for a second consecutive report. */
  firstMissed?: Record<string, string> };
const handleKey = (workId: string, id: string) => `${workId}\u0000${id}`;
export function observeSessions(all: Work[], runtime: RuntimeSession[] | null, now: Date, options: ObserveOptions = {}): SessionReport {
  const entries: SessionReportEntry[] = [], missing: Record<string, string> = {};
  // A runtime that could not be read is a gap in the reports, not a report of absence.
  if (!runtime) return { entries, missing };
  const states = options.states ?? defaultStates, grace = options.launchGraceMs ?? sessionLaunchGraceMs, refresh = options.refreshMs ?? sessionObservationRefreshMs;
  const at = now.toISOString(), clock = now.getTime();
  for (const work of all) for (const handle of work.sessions ?? []) {
    if (handle.state !== 'running' || options.settled?.has(handleKey(work.id, handle.id))) continue;
    // Another host's runtime answers for its own sessions; a handle with no coordinate cannot be seen.
    if (options.hostId && handle.host !== options.hostId) continue;
    if (!handle.pane && !handle.agentName) continue;
    const started = Date.parse(handle.startedAt);
    const young = !handle.observed && Number.isFinite(started) && clock - started < grace;
    const where = handle.pane ? `pane ${handle.pane}` : `session ${handle.agentName}`;
    const base = { workId: work.id, key: work.key, id: handle.id, kind: handle.kind, role: sessionRole(handle), runtime: handle.runtime, host: handle.host, subject: handle.subject };
    const entry = runtimeSessionOf(handle, runtime);
    if (entry) {
      const state = observedRuntimeState(entry, handle.runtime, states);
      // A pane whose agent has not started yet looks like one whose agent exited: registration
      // precedes the runtime, so an unobserved session is not ended by its own launch.
      if (state === 'ended' && young) continue;
      const due = !handle.observedAt || clock - Date.parse(handle.observedAt) >= refresh || !Number.isFinite(Date.parse(handle.observedAt));
      const changed = state !== handle.observed || !!handle.missedReports || state === 'ended' || due;
      const outcome = state !== 'ended' ? null : entry.agent === null || entry.agent === ''
        ? `the ${handle.runtime} runtime on ${handle.host} reports ${where} as exited to a shell (no agent in the pane), so the session is over`
        : `the ${handle.runtime} runtime on ${handle.host} reports ${where} as ${entry.agent_status ?? 'ended'}, so the session is over`;
      entries.push({ ...base, observed: state, observedAt: at, missedReports: 0, closed: state === 'ended' ? 'ended' : null, outcome, changed });
      continue;
    }
    if (young) continue;
    const key = handleKey(work.id, handle.id);
    const first = Date.parse(options.firstMissed?.[key] ?? '');
    const firstMissedAt = Number.isFinite(first) ? Math.min(first, clock) : clock;
    missing[key] = new Date(firstMissedAt).toISOString();
    // Consecutive misses as the record counts them, or as the previous report left them where the
    // record could not take the count (a write that failed).
    const missed = Math.max((handle.missedReports ?? 0) + 1, Number.isFinite(first) ? 2 : 1);
    const lastSeen = handle.observedAt ?? handle.updatedAt, lastAt = Date.parse(lastSeen);
    if (missed < lostAfterReports) {
      entries.push({ ...base, observed: handle.observed ?? null, observedAt: handle.observedAt ?? null, missedReports: missed, closed: null, outcome: null, changed: true });
      continue;
    }
    entries.push({ ...base, observed: 'lost', observedAt: handle.observedAt ?? null, missedReports: missed, closed: 'lost', changed: true,
      outcome: `vanished: the ${handle.runtime} runtime on ${handle.host} has not reported ${where} for ${Math.round((clock - firstMissedAt) / 1000)}s (absent from ${missed} consecutive session reports, so the session is lost), ${Number.isFinite(lastAt) ? Math.round(Math.max(0, clock - lastAt) / 1000) : 0}s after its last observed activity at ${lastSeen}` });
  }
  return { entries, missing };
}
/** What one report entry is written back as: the handle's own identity, with the observation, ended when the report closed it. */
export function reportedHandle(entry: SessionReportEntry): SessionHandleInput {
  return { id: entry.id, kind: entry.kind, runtime: entry.runtime, host: entry.host, subject: entry.subject,
    state: entry.closed ? 'finished' : 'running', ...(entry.outcome ? { outcome: entry.outcome.slice(0, 500) } : {}),
    ...(entry.observed ? { observed: entry.observed } : {}), ...(entry.observedAt ? { observedAt: entry.observedAt } : {}), missedReports: entry.missedReports };
}

/**
 * Every path that starts a session registers it first (GY-172 AC-2): the loop's worker dispatch,
 * the executors, `master approver`, `master review`, escalation handlers and every reviewer and
 * producer launch go through this one helper, so each session exists on the record before its
 * runtime does and is observed and closed by the report above like any other. The registration
 * names the session by the runtime name its launcher gives it; the coordinates the launch returns
 * (the pane, and the name when the launcher chose one) are written over it once the runtime has
 * started, and a launch that fails ends the registration with the reason rather than leaving an
 * open record for the report to lose.
 *
 * A registration that cannot be written does not refuse the launch, any more than a handle that
 * could not be written ever failed one: the coordinates are written again once it has started, and
 * a launch is never lost to a control plane that was briefly unreachable.
 */
export interface LaunchedCoordinates { pane?: string | null; agentName?: string | null }
export async function registeredLaunch<T>(record: ((handle: SessionHandleInput) => Promise<unknown>) | undefined, handle: SessionHandleInput,
  start: () => Promise<T>, coordinates: (launched: T) => LaunchedCoordinates | undefined = launched => launched as LaunchedCoordinates | undefined,
  attach?: (pane: string) => string): Promise<T> {
  if (!record) return start();
  const registered = await record({ ...handle, state: 'running' }).then(() => true, () => false);
  let launched: T;
  try { launched = await start(); }
  catch (error) {
    await record({ ...handle, state: 'finished', outcome: `the launch failed before the session started: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) }).catch(() => {});
    throw error;
  }
  const where = coordinates(launched);
  const pane = where?.pane ?? null, agentName = where?.agentName ?? null;
  if (!registered || pane || (agentName && agentName !== handle.agentName))
    await record({ ...handle, state: 'running', ...(agentName ? { agentName } : {}), ...(pane ? { pane, ...(attach ? { attach: attach(pane) } : {}) } : {}) }).catch(() => {});
  return launched;
}
