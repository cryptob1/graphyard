import type { Work } from './work.js';
import type { PipelineTimeline } from '../pipeline-speed.js';
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
 * shown dead, and one the loop never reports goes unseen once that sighting is stale. A report
 * that misses such a handle keeps that sighting's time rather than the time of its own write.
 */
export const sessionObservationFreshMs = 15 * 60_000;
export interface SessionObservationReading { state: ObservedSessionState; at: string }
export function latestObservation(handle: Pick<SessionHandle, 'state' | 'updatedAt' | 'observed' | 'observedAt'>): SessionObservationReading | null {
  if (handle.observed && handle.observedAt) return { state: handle.observed, at: handle.observedAt };
  // A report that missed an unobserved handle carries that first sighting as `observedAt`, so the
  // write that says the session is absent does not make it read as freshly seen.
  return handle.state === 'running' ? { state: 'working', at: handle.observedAt ?? handle.updatedAt } : null;
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
export function sessionView(handle: Pick<SessionHandle, 'state' | 'updatedAt' | 'observed' | 'observedAt'> & Partial<Pick<SessionHandle, 'missedReports'>>, now: Date, freshMs = sessionObservationFreshMs): SessionView {
  const latest = latestObservation(handle);
  const at = Date.parse(latest?.at ?? '');
  const ageMs = Number.isFinite(at) ? Math.max(0, now.getTime() - at) : null;
  // A handle `lostAfterReports` consecutive reports have missed is not shown running either
  // (GY-1532): its record is held open until the item's own facts end it, but no reader counts a
  // session nobody can see, and it was last seen at its last observation.
  const live = handle.state === 'running' && !!latest && (latest.state === 'working' || latest.state === 'idle') && ageMs !== null && ageMs <= freshMs && (handle.missedReports ?? 0) < lostAfterReports;
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
 * The rules, per open handle on this host:
 * - listed with an agent in the pane: `working` when the runtime says so, `idle` for any at-prompt
 *   state (`idle`, `done`, `blocked`), and `ended` for a state the runtime reserves for an exit;
 * - listed with no agent in the pane (the agent exited to a shell): `ended`;
 * - not listed, and its purpose over by the item's own facts (`settledPurpose`): `ended` at once,
 *   with that fact as the reason;
 * - not listed while its purpose stands, and ended by the item's facts in time (`endedByFact`: a
 *   worker handle with an epoch, a reviewer's or producer's that a dispatch request names): one
 *   missed report, counted and held, never `lost` (GY-1532). What ends it is the fact — the watch
 *   supervisor releases the lease once the runtime drops its pane or its agent exits, the loop
 *   keeps the work of a worker whose supervisor died with it, the lease lapses, the reviewer or
 *   producer reconcile fails and relaunches an unanswered request — and the next report records
 *   that end.
 *   From `lostAfterReports` misses on, no reader shows it running;
 * - not listed, and ended by no fact (a coordination handle, a review session no request names):
 *   one missed report; absent from `lostAfterReports` consecutive reports, `lost`;
 * - no coordinate to match (its launcher never wrote the pane or name): missed like one not listed.
 * `ended` and `lost` close the record with the reason. A runtime that could not be read is a gap,
 * not a report: nothing is counted against any session. A handle nothing has observed yet is left
 * alone through `sessionLaunchGraceMs`, because a session is registered before its runtime starts,
 * and so is a worker handle with no coordinate yet whose attempt's lease stands (`launchHeldByLease`).
 *
 * The loop computes a report on every tick and writes a handle when its observation changes, a
 * report missed it (each miss up to `lostAfterReports`; a held handle is not rewritten after), or
 * its last observation is older than `sessionObservationRefreshMs` — so the record stays fresh
 * inside `sessionObservationFreshMs` while a steady session costs one write per refresh interval
 * rather than one per tick.
 */
export const lostAfterReports = 2, sessionLaunchGraceMs = 3 * 60_000, sessionObservationRefreshMs = 5 * 60_000;
/** The most misses a record counts: the handle schema's ceiling on `missedReports`. */
export const missedReportsCeiling = 1000;
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
/** The epoch a worker handle was registered for: its own, or the `PRINCIPAL:EPOCH` its id names. */
const handleEpoch = (handle: Pick<SessionHandle, 'id' | 'epoch'>) => handle.epoch ?? Number(/:(\d+)$/.exec(handle.id)?.[1]);
/**
 * GY-1287: a worker handle its launcher has not yet given a pane or name, whose attempt's lease
 * stands under the handle's principal, is a launch still preparing — the launch renews that lease
 * until its supervisor's first heartbeat, and the supervisor after — never a vanished session.
 * On 5 October 2026 GY-1235's launch took longer than the launch grace, and the report closed its
 * handle as lost while the worker it was starting went on to hold and renew the lease.
 */
export function launchHeldByLease(work: Pick<Work, 'lease'>, handle: Pick<SessionHandle, 'id' | 'kind' | 'principal' | 'epoch' | 'pane' | 'agentName' | 'state' | 'observed'>, clock: number) {
  const lease = work.lease;
  return handle.kind === 'implementation' && handle.state === 'running' && !handle.observed && !handle.pane && !handle.agentName
    && !!lease && !!handle.principal && lease.owner === handle.principal && handleEpoch(handle) === lease.epoch && Date.parse(lease.expiresAt) > clock;
}
/** A handle nothing has observed yet whose launch is still under way: inside the launch grace, or held by its attempt's lease. */
export function launchingSession(work: Pick<Work, 'lease'>, handle: Pick<SessionHandle, 'id' | 'kind' | 'principal' | 'epoch' | 'pane' | 'agentName' | 'state' | 'observed' | 'startedAt'>, clock: number, grace = sessionLaunchGraceMs) {
  if (handle.state !== 'running' || handle.observed) return false;
  const started = Date.parse(handle.startedAt);
  return (Number.isFinite(started) && clock - started < grace) || launchHeldByLease(work, handle, clock);
}
/**
 * GY-1532. Why the item's own facts say a session's purpose is over, or null while it stands: an
 * implementation session whose attempt has ended — submitted, released (by its worker, by its
 * watch supervisor once the runtime dropped its pane or its agent exited, or by the loop keeping
 * the work of a worker whose supervisor died with it), lapsed or reworked, so the lease it ran
 * under is gone or a later epoch's — or a review or proof session whose dispatch request was
 * satisfied or cancelled. On 8 October 2026 every worker and reviewer session on vishrog closed as "vanished
 * … so the session is lost" within a minute of its work landing: the loop had closed the pane
 * itself once the attempt was submitted or the verdict read, and the report, judging absence
 * alone, counted two missed reports and lost it — six losses in forty minutes, each a deliberate
 * close. A session whose purpose is over is ended on the first report that no longer lists it,
 * with that fact as the reason, so a close never reads as a loss; one the runtime still lists is
 * observed as before, since its supervisor may still be stopping it. The fact names the attempt's
 * recorded end (its pipeline timeline), the cause the loop kept its interrupted work for, and the
 * fresh lease a later attempt runs under — the relaunch a genuine disappearance ends in.
 */
export function settledPurpose(work: Pick<Work, 'key' | 'lease' | 'submission' | 'autoDispatch' | 'capacity'> & { pipeline?: PipelineTimeline; candidate?: { sha: string } | null; reviewVerdicts?: { sha: string; verdicts: unknown[] } | null }, handle: Pick<SessionHandle, 'id' | 'kind' | 'epoch'> & { head?: string | null; observedAt?: string | null; updatedAt?: string | null; startedAt?: string | null }, clock: number): string | null {
  if (handle.kind === 'implementation') {
    const epoch = handleEpoch(handle), lease = work.lease;
    if (!Number.isFinite(epoch) || (lease && lease.epoch === epoch && Date.parse(lease.expiresAt) > clock)) return null;
    const attempt = [...(work.pipeline?.attempts ?? [])].reverse().find(entry => entry.epoch === epoch && entry.endedAt && entry.end);
    const kept = work.capacity?.exhaustions.find(entry => entry.role === 'worker' && entry.epoch === epoch);
    const fresh = lease && lease.epoch !== epoch && Date.parse(lease.expiresAt) > clock ? `; attempt ${lease.epoch} runs under a fresh lease held by ${lease.owner}` : '';
    const end = work.submission?.epoch === epoch ? `was submitted as pull request #${work.submission.pr}`
      : attempt?.end === 'released' ? `was released at ${attempt.endedAt}${kept ? ` (${kept.reason.slice(0, 200)})` : ''}`
      : attempt?.end === 'expired' ? `ended when its lease lapsed at ${attempt.endedAt}`
      : attempt?.end === 'reworked' ? `was returned for rework at ${attempt.endedAt}`
      : lease && lease.epoch !== epoch ? (fresh ? 'ended' : `ended, and attempt ${lease.epoch}'s lease lapsed at ${lease.expiresAt}`)
      : lease ? `ended with its lease expired at ${lease.expiresAt}` : `ended (released, blocked, parked or lapsed) and ${work.key} holds no lease`;
    return `attempt ${epoch} of ${work.key} ${end}${fresh}`;
  }
  const request = dispatchRequestOf(work, handle);
  if (!request) return handByHandPurpose(work, handle, clock);
  if (request.state === 'requested') return null;
  return `its ${request.kind} request was ${request.state}${request.resolvedAt ? ` at ${request.resolvedAt}` : ''}${request.resolution ? ` (${request.resolution.slice(0, 160)})` : ''}`;
}
/**
 * A review session no request names (`master review` by hand, under `review:SHA`) is over when the
 * head it reviews is no longer the candidate, when a request for that head was answered or
 * cancelled, or when the head's verdict is recorded; unlisted past the grace it is lost like any session no fact will end.
 */
const reviewedHead = (handle: Pick<SessionHandle, 'id'> & { head?: string | null }) => handle.head ?? (handle.id.startsWith('review:') ? handle.id.slice(7) : null);
function handByHandPurpose(work: Parameters<typeof settledPurpose>[0], handle: Pick<SessionHandle, 'id' | 'kind'> & { head?: string | null; observedAt?: string | null; updatedAt?: string | null; startedAt?: string | null }, clock: number): string | null {
  if (handle.kind !== 'review') return null;
  const head = reviewedHead(handle);
  if (!head) return null;
  const dispatch = work.autoDispatch;
  const answered = [dispatch?.review, ...(dispatch?.history ?? [])].find(entry => entry?.kind === 'review' && entry.sha === head && entry.state !== 'requested');
  if (answered) return `its review request for ${head.slice(0, 12)} was ${answered.state}${answered.resolvedAt ? ` at ${answered.resolvedAt}` : ''}`;
  if (work.reviewVerdicts?.sha === head && work.reviewVerdicts.verdicts.length) return `a review verdict for ${head.slice(0, 12)} is recorded`;
  if (work.candidate?.sha !== head) return `the candidate no longer is ${head.slice(0, 12)}${work.candidate ? ` (it is ${work.candidate.sha.slice(0, 12)})` : ''}`;
  return null;
}
/** The dispatch request a review or proof session was launched for: the one its handle's id names. */
function dispatchRequestOf(work: Pick<Work, 'autoDispatch'>, handle: Pick<SessionHandle, 'id' | 'kind'>) {
  if (handle.kind !== 'review' && handle.kind !== 'proof') return undefined;
  const dispatch = work.autoDispatch;
  return [dispatch?.review, ...(dispatch?.producers ?? []), ...(dispatch?.history ?? [])].find(entry => entry?.id === handle.id);
}
/**
 * Whether the item's own facts end this handle in time, so absence alone never has to (GY-1532): a
 * worker handle with an epoch ends with its attempt — every lease lapses, and every attempt ends on
 * the record — and a reviewer's or producer's that a dispatch request names ends with that request.
 * A coordination handle, or a review session no request names (`master review` by hand), answers to the runtime alone and is lost when absent.
 */
export const endedByFact = (work: Pick<Work, 'autoDispatch'>, handle: Pick<SessionHandle, 'id' | 'kind' | 'epoch'> & { head?: string | null }) =>
  handle.kind === 'implementation' ? Number.isFinite(handleEpoch(handle)) : !!dispatchRequestOf(work, handle);
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
    const started = Date.parse(handle.startedAt);
    const young = !handle.observed && Number.isFinite(started) && clock - started < grace;
    // A handle whose launcher never wrote the pane or name it started cannot be matched to anything
    // the runtime lists: past the launch grace it is missed like a vanished pane, so it is lost and
    // closed rather than left open, unseen, where no report could ever end it.
    const where = handle.pane ? `pane ${handle.pane}` : handle.agentName ? `session ${handle.agentName}` : `session ${handle.id} (registered with no pane or name to match)`;
    const base = { workId: work.id, key: work.key, id: handle.id, kind: handle.kind, role: sessionRole(handle), runtime: handle.runtime, host: handle.host, subject: handle.subject };
    const entry = handle.pane || handle.agentName ? runtimeSessionOf(handle, runtime) : undefined;
    const over = settledPurpose(work, handle, clock);
    if (entry) {
      const state = observedRuntimeState(entry, handle.runtime, states);
      // A pane whose agent has not started yet looks like one whose agent exited: registration
      // precedes the runtime, so an unobserved session is not ended by its own launch.
      if (state === 'ended' && young) continue;
      const due = !handle.observedAt || clock - Date.parse(handle.observedAt) >= refresh || !Number.isFinite(Date.parse(handle.observedAt));
      const changed = state !== handle.observed || !!handle.missedReports || state === 'ended' || due;
      const after = over ? ` after ${over}` : '';
      const outcome = state !== 'ended' ? null : entry.agent === null || entry.agent === ''
        ? `the ${handle.runtime} runtime on ${handle.host} reports ${where} as exited to a shell (no agent in the pane)${after}, so the session is over`
        : `the ${handle.runtime} runtime on ${handle.host} reports ${where} as ${entry.agent_status ?? 'ended'}${after}, so the session is over`;
      entries.push({ ...base, observed: state, observedAt: at, missedReports: 0, closed: state === 'ended' ? 'ended' : null, outcome, changed });
      continue;
    }
    const key = handleKey(work.id, handle.id);
    const first = Date.parse(options.firstMissed?.[key] ?? '');
    // GY-1532: a session the runtime no longer lists whose purpose the item says is over ended
    // deliberately — the loop closed its pane, its supervisor stopped it, or the loss already ended
    // its attempt or request — so this report ends it with that fact, launch grace or not, and
    // counts nothing towards a loss. One held through earlier misses says for how long.
    if (over) {
      const held = Number.isFinite(first) ? ` (unlisted for ${Math.round((clock - Math.min(first, clock)) / 1000)}s)` : handle.missedReports ? ` (unlisted for ${handle.missedReports} session reports)` : '';
      entries.push({ ...base, observed: 'ended', observedAt: at, missedReports: 0, closed: 'ended', changed: true,
        outcome: `the ${handle.runtime} runtime on ${handle.host} no longer reports ${where}${held}: ${over}, so the session is over` });
      continue;
    }
    if (young || launchHeldByLease(work, handle, clock)) continue;
    const firstMissedAt = Number.isFinite(first) ? Math.min(first, clock) : clock;
    missing[key] = new Date(firstMissedAt).toISOString();
    // Consecutive misses as the record counts them, or as the previous report left them where the
    // record could not take the count (a write that failed).
    const missed = Math.max((handle.missedReports ?? 0) + 1, Number.isFinite(first) ? 2 : 1);
    const lastSeen = handle.observedAt ?? handle.updatedAt, lastAt = Date.parse(lastSeen);
    if (missed < lostAfterReports || endedByFact(work, handle)) {
      // The last sighting is carried as it was: for a handle nothing has observed yet that is its
      // launcher's record, which the write of this miss would otherwise move to now. A handle the
      // item's facts will end is held here, miss after miss, until they do: the count is written
      // up to `lostAfterReports`, from which no reader shows it running, and not again after.
      entries.push({ ...base, observed: handle.observed ?? null, observedAt: handle.observedAt ?? lastSeen, missedReports: Math.min(missed, missedReportsCeiling), closed: null, outcome: null, changed: missed <= lostAfterReports });
      continue;
    }
    entries.push({ ...base, observed: 'lost', observedAt: handle.observedAt ?? lastSeen, missedReports: missed, closed: 'lost', changed: true,
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

export { coordinateAttempts, coordinateRetryMs, registeredLaunch, type LaunchedCoordinates } from './session-launch.js';
