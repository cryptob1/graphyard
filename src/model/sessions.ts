import { z } from 'zod';
import type { Work } from './work.js';

/**
 * Durable session handles.
 *
 * A launched agent session is otherwise invisible to everyone but the process that launched it:
 * its pane identifier lives in that launcher's local ledger, and watching a specific agent means
 * asking a master to relay it. A handle puts the same facts on the item, where Graphyard's own
 * readers already look — what runtime and host it runs on, the workspace, tab and pane it occupies
 * there, the transcript it writes, and the one command or link that attaches to it.
 *
 * The coordinates are the runtime's own, and so is the attach command: the control plane records
 * what the launcher tells it and never names a multiplexer of its own. The handle is a record of a
 * runtime fact, not authority: it never decides a gate, never grants a lease, and a session that
 * ends keeps its handle so its transcript stays reachable.
 */

export const sessionKinds = ['implementation', 'review', 'proof', 'coordination'] as const;
export type SessionKind = typeof sessionKinds[number];
export const sessionStates = ['running', 'finished'] as const;
export type SessionState = typeof sessionStates[number];

export interface SessionHandle {
  /** Stable per session: the dispatch request id, or `principal:epoch` for an assignment. */
  id: string; kind: SessionKind;
  principal: string;
  /** The attempt epoch the session works under, when it holds one. */
  epoch: number | null;
  runtime: string; host: string;
  /** The runtime's own coordinates, when it is a multiplexer that has them. */
  workspace: string | null; tab: string | null; pane: string | null;
  /** The runtime's own name for this session, when its launcher registered one; what the runtime's listing is matched against. */
  agentName: string | null;
  /** The slot this session occupies — its kind, plus the proof group for a proof session — so two sessions claiming one slot are recognisable as such. */
  role: string | null;
  /** The exact commit this session is bound to, when it is bound to one; a session for a head the item has moved past is superseded. */
  head: string | null;
  /** The command or link the launcher says attaches to this session while it runs. */
  attach: string | null;
  /** Where the session writes its transcript, so a finished session is still readable. */
  transcript: string | null;
  /** What it is working on, in one line. */
  subject: string;
  startedAt: string; updatedAt: string; endedAt: string | null;
  state: SessionState; outcome: string | null;
}

const line = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/);
export const sessionHandleSchema = z.object({
  id: line(120), kind: z.enum(sessionKinds),
  /**
   * Whose session this is, when a launcher records the handle of a session it started under
   * another credential. The session named here is the one that may later fill in the tab and
   * transcript only it knows, and the one that may end the handle; everybody else is refused.
   */
  principal: line(200).optional(),
  epoch: z.number().int().positive().optional(),
  runtime: line(80), host: line(200),
  agentName: line(120).optional(), role: line(120).optional(),
  head: z.string().trim().regex(/^[0-9a-f]{7,64}$/, 'A session is bound to a commit by its full or abbreviated SHA').optional(),
  workspace: line(120).optional(), tab: line(120).optional(), pane: line(120).optional(),
  attach: z.string().trim().min(1).max(500).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
  transcript: z.string().trim().min(1).max(1000).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
  subject: z.string().trim().min(1).max(300),
  state: z.enum(sessionStates).default('running'),
  outcome: z.string().trim().min(1).max(500).optional(),
}).strict();
export type SessionHandleInput = z.infer<typeof sessionHandleSchema>;

/**
 * How many handles an item keeps, and the ceiling the list never passes.
 *
 * A bound that simply dropped the oldest entries would be a way to remove somebody else's handle:
 * record enough new ones and the running session an operator is about to attach to falls off the
 * end. So the bound evicts finished handles first, oldest first, and never evicts a running one to
 * make room — a list of live sessions grows up to the ceiling instead, which only a launcher can
 * fill (`engine.ts`, `command === 'session'`) and which keeps the document bounded regardless.
 */
export const sessionHandleLimit = 40, sessionHandleCeiling = 200;

function bounded(handles: SessionHandle[], recorded: SessionHandle): SessionHandle[] {
  if (handles.length <= sessionHandleLimit) return handles;
  const excess = handles.length - sessionHandleLimit;
  const retire = new Set<SessionHandle>();
  for (const handle of handles) {
    if (retire.size >= excess) break;
    // The handle just written is never the one dropped to make room for itself: a session that
    // ends would otherwise lose the transcript link the moment it recorded it.
    if (handle.state === 'finished' && handle !== recorded) retire.add(handle);
  }
  const kept = handles.filter(handle => !retire.has(handle));
  // The recorded handle is last, so trimming to the ceiling keeps it and drops the oldest.
  return kept.length <= sessionHandleCeiling ? kept : kept.slice(kept.length - sessionHandleCeiling);
}

/**
 * The command or link that attaches to this session: the one its launcher recorded while it runs,
 * and otherwise — for a session that has finished, or one whose runtime offers nothing to attach
 * to — its transcript. A handle with neither says so rather than offering something that cannot work.
 */
export function attachCommand(handle: Pick<SessionHandle, 'state' | 'attach' | 'transcript' | 'host'>): string {
  if (handle.state === 'running' && handle.attach) return handle.attach;
  if (handle.transcript) return `${handle.host}:${handle.transcript}`;
  return 'no attach command and no transcript were recorded for this session';
}

/** Record or update one handle on the item, newest last, bounded. */
export function recordSession(work: Work, input: SessionHandleInput, principal: string, now: Date): SessionHandle {
  work.sessions ??= [];
  const at = now.toISOString();
  const existing = work.sessions.find(handle => handle.id === input.id);
  const handle: SessionHandle = {
    // The owner is fixed at the first record and never moves: a launcher names the session it
    // started, and an ordinary update cannot hand the handle to somebody else.
    id: input.id, kind: input.kind, principal: existing?.principal ?? input.principal ?? principal,
    epoch: input.epoch ?? existing?.epoch ?? null,
    runtime: input.runtime, host: input.host,
    // The coordinates a launcher registered are kept when a later write omits them: the session
    // itself fills in the tab and transcript only it knows, and must not blank the name and head
    // its launcher recorded — those are what liveness reconciliation matches the runtime against.
    agentName: input.agentName ?? existing?.agentName ?? null, role: input.role ?? existing?.role ?? null, head: input.head ?? existing?.head ?? null,
    workspace: input.workspace ?? existing?.workspace ?? null, tab: input.tab ?? existing?.tab ?? null, pane: input.pane ?? existing?.pane ?? null,
    attach: input.attach ?? existing?.attach ?? null,
    transcript: input.transcript ?? existing?.transcript ?? null,
    subject: input.subject,
    startedAt: existing?.startedAt ?? at, updatedAt: at,
    endedAt: input.state === 'finished' ? existing?.endedAt ?? at : null,
    // A running session may carry an outcome too — "waiting on input" is a fact about a session
    // that has not ended — so the note is kept rather than dropped for want of an end.
    state: input.state, outcome: input.outcome ?? existing?.outcome ?? null,
  };
  work.sessions = bounded([...work.sessions.filter(entry => entry.id !== input.id), handle], handle);
  return handle;
}

/** One line per session for a reader: what it is, what it works on, and how to watch or read it. */
export function sessionSummary(work: Work, now: Date) {
  return (work.sessions ?? []).map(handle => ({
    ...handle, key: work.key, attach: attachCommand(handle),
    runningMs: handle.state === 'running' ? Math.max(0, now.getTime() - Date.parse(handle.startedAt)) : Math.max(0, Date.parse(handle.endedAt ?? handle.updatedAt) - Date.parse(handle.startedAt)),
  }));
}

/** Every running session across the graph, longest-running first. */
export function runningSessions(all: Work[], now: Date) {
  return all.flatMap(work => sessionSummary(work, now).filter(handle => handle.state === 'running'))
    .sort((a, b) => b.runningMs - a.runningMs);
}


/**
 * Session liveness: the recorded state reconciled against the runtime, rather than trusted.
 *
 * A handle used to say `running` until a session, its launcher or an admin said otherwise, and
 * nothing ever contradicted it — so a session that crashed, lost its pane or was killed stayed
 * recorded as running for good, and every reader believed it, the launcher's own busy check
 * included. That is why a dead session held its role slot until somebody noticed by hand. So the
 * record is reconciled, by a sweep on a bounded interval (`auto-dispatch.ts`, every dispatch tick)
 * rather than a reaction to something reporting in — a session that died reports nothing, which is
 * the whole problem. Two further closures come from the item rather than the runtime: a review or
 * proof session bound to a head, a candidate or an item that has moved on is over, and two live
 * sessions for one role and head cannot both stand. None of it is authority — a closure decides no
 * gate, ends no lease and stops no process; the runtime already did, or the session is stalled
 * rather than gone, which `overlongSessions` surfaces instead of closing.
 *
 * What is here is the rule: what the runtime says about one handle, and what the item says about
 * one session. The sweep that applies it across the graph, and the closure it writes back, belong
 * to the interval that runs them (`auto-dispatch.ts`, `reconcileSessionLiveness`).
 */

/** What a runtime reports about one session it is running: its own name for it, the pane it holds, and its state. */
export interface RuntimeSession { name?: string; pane_id?: string; agent_status?: string }
/**
 * The reported states that mean a session has ended rather than one still holding its place. Any
 * other state is live — `idle`, `done` and `blocked` all included.
 *
 * `done` in particular is not an ending: a multiplexer reports it for a session that finished work
 * nobody has looked at yet, the same underlying at-prompt state as `idle` and differing only in
 * whether a human focused the tab, which in a headless fleet nobody ever does. It is how a live
 * session waiting for its next prompt is normally reported, which is why the rest of the codebase
 * groups it with `idle` as ready for input (`master-daemon.ts`'s `stoppedStates`) and closes such a
 * pane deliberately rather than believing it already gone. A session waiting at a prompt still
 * holds its pane, and that is the one moment somebody needs its attach command.
 *
 * A coding runtime that actually exited is *absent* from the listing, which the `vanished` rule
 * already covers; the states named here are the ones a listing may still report for a session that
 * is over, and a runtime with terminal states of its own extends them (`harness.ts`).
 */
export const endedRuntimeStates: readonly string[] = ['exited', 'exit', 'error', 'failed', 'killed', 'stopped', 'offline', 'gone'];
export type RuntimeStates = (runtime: string) => readonly string[];
/** Which runtime's vocabulary to judge a reported state by; the shared set answers when nothing is passed. */
export interface LivenessOptions { states?: RuntimeStates }
const defaultStates: RuntimeStates = () => endedRuntimeStates;
/**
 * How long a handle the runtime no longer reports is left alone, and the bound a vanished record
 * closes within: the grace plus one sweep. A listing is not instantaneous — a session recorded at
 * launch appears in its runtime's inventory a moment later — so a young handle is left be.
 */
export const sessionReconcileIntervalMs = 30_000, sessionVanishGraceMs = 60_000;
export const sessionClosureBoundMs = sessionVanishGraceMs + sessionReconcileIntervalMs;
/** The slot a session occupies: what its launcher registered, else its kind. One item holds one live session per slot and head. */
export const sessionRole = (handle: Pick<SessionHandle, 'kind' | 'role'>) => handle.role ?? handle.kind;
/** The runtime entry that is this session, matched on the coordinates its launcher recorded. */
export function runtimeSessionOf(handle: Pick<SessionHandle, 'pane' | 'agentName'>, runtime: RuntimeSession[]) {
  return runtime.find(entry => !!handle.pane && entry.pane_id === handle.pane) ?? runtime.find(entry => !!handle.agentName && entry.name === handle.agentName);
}

export type Liveness = 'live' | 'ended' | 'vanished' | 'unreconciled' | 'unknown';
/**
 * What the runtime says about a recorded session. `unknown` is a runtime that could not be read,
 * a handle another host launched — this runtime inventory was never asked about it, and every
 * other local-runtime judgment in the codebase is host-scoped the same way — and `unreconciled` a
 * handle with no coordinate to match on: none of the three is evidence that a session is gone, and
 * none closes a record, where an unreadable runtime would otherwise close the whole graph at once.
 */
export function sessionLiveness(handle: Pick<SessionHandle, 'pane' | 'agentName' | 'runtime' | 'host'>, runtime: RuntimeSession[] | null, states: RuntimeStates = defaultStates, hostId?: string | null): Liveness {
  if (!runtime) return 'unknown';
  if (hostId && handle.host !== hostId) return 'unknown';
  if (!handle.pane && !handle.agentName) return 'unreconciled';
  const entry = runtimeSessionOf(handle, runtime);
  if (!entry) return 'vanished';
  return states(handle.runtime).includes(entry.agent_status ?? '') ? 'ended' : 'live';
}

const short = (sha: string) => sha.slice(0, 12);
/** The heads this item still has a session's worth of work on: its candidate, and every head a dispatch request names. */
export function boundHeads(work: Pick<Work, 'candidate' | 'autoDispatch'>): string[] {
  const dispatch = work.autoDispatch;
  return [...new Set([work.candidate?.sha, dispatch?.review?.sha, ...(dispatch?.producers ?? []).map(request => request.sha)].filter((sha): sha is string => !!sha))];
}
/**
 * Why a review or proof session is bound to something the item has moved past, or null while it
 * still answers the head it was launched for. An implementation session is not judged here: its
 * lease decides what it may still do, and ending its handle would strand a worker being stopped.
 */
export function supersededSession(work: Work, handle: Pick<SessionHandle, 'kind' | 'head'>, now: Date): string | null {
  if (handle.kind !== 'review' && handle.kind !== 'proof') return null;
  if (work.stage === 'done') return `${work.key} was delivered, so nothing this session produces can bind a candidate`;
  if (work.observation?.merged) return `the candidate it was bound to merged${work.observation.mergeSha ? ` as ${short(work.observation.mergeSha)}` : ''}`;
  if (work.reworkRequested) return `${work.key} was returned to a worker for rework, so the next candidate is requested afresh`;
  if (work.lease && Date.parse(work.lease.expiresAt) > now.getTime()) return `${work.key} was returned to a worker (${work.lease.owner} holds epoch ${work.lease.epoch} until ${work.lease.expiresAt})`;
  if (!handle.head) return null;
  const heads = boundHeads(work);
  if (heads.includes(handle.head)) return null;
  return `head ${short(handle.head)} was superseded by ${heads.length ? heads.map(short).join(', ') : `a head ${work.key} no longer has`}`;
}

/**
 * The longest a session of each role may run before it is surfaced: a producer session's ceiling is
 * the loop's own `producerTimeoutMinutes` (default 120), when its request expires, and a
 * coordination session outlives the work it shepherds, so it gets a shift rather than an hour.
 */
export const roleSessionMaximumMs: Record<SessionKind, number> = { implementation: 4 * 3_600_000, review: 3_600_000, proof: 2 * 3_600_000, coordination: 12 * 3_600_000 };
/** A duration in the unit the reader thinks in: seconds while it is young, then minutes, then hours. */
export const elapsed = (ms: number) => ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)}h${Math.floor(ms % 3_600_000 / 60_000)}m` : ms >= 60_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 1000)}s`;
export interface OverlongSession {
  workId: string; key: string; id: string; kind: SessionKind; role: string; principal: string; runtime: string; host: string;
  ageMs: number; maximumMs: number; idleMs: number; lastActivityAt: string; liveness: Liveness; live: boolean | null;
  attach: string; subject: string; outcome: string | null;
}
/** One reader's line per overlong session, and what to do about it; `next` never names a command that ends a session. */
export interface OverlongSessionLine { subject: string; text: string; next: string }
export type OverlongOptions = LivenessOptions & { maximums?: Partial<Record<SessionKind, number>>;
  /** This host, when the reader has one: a session another host launched is not judged against this host's runtime listing. */
  hostId?: string | null };
/**
 * Every running session past its role's maximum, longest first, whether or not it is still live. A
 * session that died is caught by reconciliation; one running and making no progress is not, and is
 * the more expensive of the two — it holds its role slot, its provider seat and its item while
 * reporting nothing wrong. Nothing is closed here: a slow session may be working.
 */
export function overlongSessions(all: Work[], runtime: RuntimeSession[] | null, now: Date, options: OverlongOptions = {}): OverlongSession[] {
  const states = options.states ?? defaultStates, maximums = { ...roleSessionMaximumMs, ...options.maximums };
  return all.flatMap(work => (work.sessions ?? []).filter(handle => handle.state === 'running').flatMap(handle => {
    const maximumMs = maximums[handle.kind] ?? roleSessionMaximumMs[handle.kind];
    const startedAt = Date.parse(handle.startedAt), lastAt = Date.parse(handle.updatedAt);
    const ageMs = Number.isFinite(startedAt) ? Math.max(0, now.getTime() - startedAt) : 0;
    if (ageMs <= maximumMs) return [];
    const liveness = sessionLiveness(handle, runtime, states, options.hostId);
    return [{ workId: work.id, key: work.key, id: handle.id, kind: handle.kind, role: sessionRole(handle), principal: handle.principal,
      runtime: handle.runtime, host: handle.host, ageMs, maximumMs, lastActivityAt: handle.updatedAt,
      idleMs: Number.isFinite(lastAt) ? Math.max(0, now.getTime() - lastAt) : ageMs,
      liveness, live: liveness === 'live' ? true : liveness === 'ended' || liveness === 'vanished' ? false : null,
      attach: attachCommand(handle), subject: handle.subject, outcome: handle.outcome }];
  })).sort((a, b) => b.ageMs - a.ageMs);
}
/** Each of those as a line: its age against the maximum, its last observed activity, what the runtime says now, and what shows it. */
export function overlongSessionLines(all: Work[], runtime: RuntimeSession[] | null, now: Date, options: OverlongOptions = {}): OverlongSessionLine[] {
  const bound = `${Math.round(sessionClosureBoundMs / 1000)}s`;
  return overlongSessions(all, runtime, now, options).map(session => {
    const observed = session.live === true ? `the ${session.runtime} runtime on ${session.host} still reports it live`
      : session.live === false ? `the runtime no longer reports it live (${session.liveness}), so the liveness sweep closes its record within ${bound}`
      : options.hostId && session.host !== options.hostId
        ? `whether it is still live is unknown: it runs on ${session.host}, and this host's runtime inventory does not answer for it`
        : 'whether it is still live is unknown, because the runtime inventory could not be read';
    return { subject: session.key,
      text: `${session.role} session ${session.id} on ${session.key} (${session.principal}) has run ${elapsed(session.ageMs)}, past the ${elapsed(session.maximumMs)} maximum for its role; last observed activity ${elapsed(session.idleMs)} ago at ${session.lastActivityAt}, and ${observed}. It holds its role slot while it stands${session.outcome ? `; last recorded outcome: ${session.outcome}` : ''}`,
      next: session.live === false ? 'graphyard master run --once reconciles the record; no session has to be closed by hand'
        : `${session.attach} shows what it is doing; stop it there if it is stuck and the liveness sweep closes the record within ${bound}` };
  });
}

/**
 * The Workers tab (GY-116): every handle across the graph in one table, read for triage.
 *
 * What is here is the derivation — which handles are stale, what the remote attach form is, how
 * the rows are ordered and what each principal is currently on — so the page (web/pages/workers.tsx)
 * only draws it and a test asserts it without a browser. Every input is the handles the items
 * already carry; nothing here reads a runtime, and nothing here is authority.
 */

/**
 * How old a running handle's `updatedAt` may be before the tab stops presenting it as live. A
 * handle is written when its launcher records it, when the session fills in its own coordinates,
 * and when the liveness sweep or the session ends it — so a running handle nothing has touched for
 * a quarter of an hour is either working silently or gone, and the reader is told which is not
 * known rather than shown a live session. The sweep (GY-113) is what ends a dead one; this is only
 * the badge in the meantime. `docs/dashboard.md` states the threshold.
 */
export const sessionStaleThresholdMs = 15 * 60_000;

/** Why a running handle is stale, or null while it was seen inside the threshold or has finished. */
export function staleSession(handle: Pick<SessionHandle, 'state' | 'updatedAt'>, now: Date, thresholdMs = sessionStaleThresholdMs): { since: string; idleMs: number } | null {
  if (handle.state !== 'running') return null;
  const seen = Date.parse(handle.updatedAt);
  if (!Number.isFinite(seen)) return { since: handle.updatedAt, idleMs: 0 };
  const idleMs = now.getTime() - seen;
  return idleMs > thresholdMs ? { since: handle.updatedAt, idleMs } : null;
}

/**
 * The attach command as run from another machine, through Herdr's remote machinery. The
 * installed `herdr --help` documents `herdr --machine <label-or-id> <command>` as the way to run a
 * subcommand against a saved SSH machine (`--remote` attaches the whole TUI through SSH instead), so
 * the remote form is the recorded local command with the handle's host as the machine selector.
 * A command that is not Herdr's, or one that already names a machine, has no second form.
 */
export function remoteAttachCommand(handle: Pick<SessionHandle, 'state' | 'attach' | 'host'>): string | null {
  if (handle.state !== 'running' || !handle.attach) return null;
  const match = /^herdr\s+(.+)$/.exec(handle.attach.trim());
  if (!match || /^--(machine|remote)\b/.test(match[1])) return null;
  return `herdr --machine ${handle.host} ${match[1]}`;
}

/** The role a session plays, as an operator names it: worker, reviewer, producer, approver, escalation handler or master. */
export type SessionRoleKind = 'worker' | 'reviewer' | 'producer' | 'approver' | 'escalation handler' | 'master';
export function sessionRoleKind(handle: Pick<SessionHandle, 'kind' | 'role'>): SessionRoleKind {
  const role = (handle.role ?? '').toLowerCase();
  if (handle.kind === 'implementation') return 'worker';
  if (handle.kind === 'review') return 'reviewer';
  if (handle.kind === 'proof') return 'producer';
  if (role.includes('approv')) return 'approver';
  if (role.includes('escalat')) return 'escalation handler';
  return 'master';
}

/**
 * Whether a finished handle was ended by liveness reconciliation rather than by the session or its
 * launcher, and which rule closed it. The sweep writes its outcome in a fixed shape
 * (`auto-dispatch.ts`, `reconcileSessionLiveness`): `vanished: …`, `superseded: …`, or the runtime's
 * own report ending in `so the session is over`.
 */
export function reconciledClosure(handle: Pick<SessionHandle, 'state' | 'outcome'>): 'vanished' | 'superseded' | 'ended' | null {
  if (handle.state !== 'running' && handle.outcome) {
    if (/^vanished:/.test(handle.outcome)) return 'vanished';
    if (/^superseded:/.test(handle.outcome)) return 'superseded';
    if (/^the .+ runtime on .+ reports .+ so the session is over$/.test(handle.outcome)) return 'ended';
  }
  return null;
}

export interface WorkerRow extends SessionHandle {
  workId: string; key: string; roleKind: SessionRoleKind;
  /** Live for a running handle (now − startedAt) and fixed for a finished one (endedAt − startedAt). */
  spentMs: number;
  /** The local form the handle recorded, the remote form built from its host, and the transcript once it has finished. */
  local: string | null; remote: string | null;
  stale: { since: string; idleMs: number } | null;
  reconciled: 'vanished' | 'superseded' | 'ended' | null;
}
export interface PrincipalSummary {
  principal: string; roleKind: SessionRoleKind;
  /** What it holds now, or null while idle. A principal with two running handles is on the one it started last. */
  current: { key: string; workId: string; epoch: number | null; sinceMs: number } | null;
  /** Handles that were running at any point in the last 24 hours. */
  sessionsLast24h: number;
}
export interface WorkersView { running: WorkerRow[]; finished: WorkerRow[]; principals: PrincipalSummary[] }

const parsed = (iso: string | null) => { const at = Date.parse(iso ?? ''); return Number.isFinite(at) ? at : null; };
/** One handle as a tab row: how long it has spent, its two attach forms, and whether it is stale or was reconciled. */
export function workerRow(work: Pick<Work, 'id' | 'key'>, handle: SessionHandle, now: Date, thresholdMs = sessionStaleThresholdMs): WorkerRow {
  const startedAt = parsed(handle.startedAt) ?? now.getTime();
  const endedAt = handle.state === 'running' ? now.getTime() : parsed(handle.endedAt) ?? parsed(handle.updatedAt) ?? startedAt;
  return { ...handle, workId: work.id, key: work.key, roleKind: sessionRoleKind(handle), spentMs: Math.max(0, endedAt - startedAt),
    local: handle.state === 'running' ? handle.attach : null, remote: remoteAttachCommand(handle),
    stale: staleSession(handle, now, thresholdMs), reconciled: reconciledClosure(handle) };
}

/**
 * The tab, organised for triage: running rows first by time spent descending, finished rows after
 * by end time descending, and one summary per worker, reviewer or producer principal — approver,
 * escalation and master sessions belong to the loop, not to a seat that is either busy or idle.
 */
export function workersView(all: Pick<Work, 'id' | 'key' | 'sessions'>[], now: Date, thresholdMs = sessionStaleThresholdMs): WorkersView {
  const rows = all.flatMap(work => (work.sessions ?? []).map(handle => workerRow(work, handle, now, thresholdMs)));
  const running = rows.filter(row => row.state === 'running').sort((a, b) => b.spentMs - a.spentMs || a.key.localeCompare(b.key));
  const finished = rows.filter(row => row.state !== 'running').sort((a, b) => (parsed(b.endedAt) ?? 0) - (parsed(a.endedAt) ?? 0) || a.key.localeCompare(b.key));
  const dayAgo = now.getTime() - 24 * 3_600_000;
  const seats = new Map<string, WorkerRow[]>();
  for (const row of rows) if (['worker', 'reviewer', 'producer'].includes(row.roleKind)) seats.set(row.principal, [...seats.get(row.principal) ?? [], row]);
  const principals = [...seats].map(([principal, handles]): PrincipalSummary => {
    const live = handles.filter(row => row.state === 'running').sort((a, b) => (parsed(b.startedAt) ?? 0) - (parsed(a.startedAt) ?? 0))[0];
    const latest = handles.reduce((last, row) => (parsed(row.startedAt) ?? 0) >= (parsed(last.startedAt) ?? 0) ? row : last);
    return { principal, roleKind: (live ?? latest).roleKind,
      current: live ? { key: live.key, workId: live.workId, epoch: live.epoch, sinceMs: live.spentMs } : null,
      sessionsLast24h: handles.filter(row => row.state === 'running' || (parsed(row.endedAt) ?? parsed(row.updatedAt) ?? 0) >= dayAgo).length };
  }).sort((a, b) => (b.current?.sinceMs ?? -1) - (a.current?.sinceMs ?? -1) || a.principal.localeCompare(b.principal));
  return { running, finished, principals };
}
