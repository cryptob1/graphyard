import type { Work } from '../src/model';
import type { SessionHandle } from '../src/model/sessions';

/**
 * The Workers tab (GY-116): every handle across the graph in one table, read for triage.
 *
 * What is here is the derivation — which handles are stale, what the two attach forms are, how
 * the rows are ordered and what each principal is currently on — so the page (web/pages/workers.tsx)
 * only draws it and a test asserts it without a browser. Every input is the handles the items
 * already carry; nothing here reads a runtime, and nothing here is authority. It lives beside the
 * page rather than in src/model because the attach forms are Herdr's syntax, and the control
 * plane's own model never names a runtime.
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
 * How long a running handle on a delivered or closed item may go unseen before the tab files it
 * with the ended sessions (GY-168). Its item is finished, so nothing will end the session's work;
 * a handle nobody has touched for an hour is left over from a dead session, not one still working.
 */
export const endedItemIdleMs = 60 * 60_000;

/**
 * The pane a recorded Herdr attach command names. The launchers record
 * `herdr pane attach PANE [--workspace W]`; the installed Herdr (0.9.1) has no `pane attach` and
 * exits 2 on it, so that form is read for its pane and never copied as it stands. A command that
 * is not Herdr's names no pane here and is offered verbatim.
 */
export function recordedHerdrPane(attach: string | null): string | null {
  const match = /^herdr\s+(?:pane|agent)\s+attach\s+(\S+)(?:\s+--workspace\s+\S+)?\s*$/.exec(attach?.trim() ?? '');
  return match && !match[1].startsWith('-') ? match[1] : null;
}

/**
 * The local attach command: run on the host that launched the session. For a Herdr pane it is
 * Herdr's direct terminal attach, `herdr agent attach PANE` — `agent attach` takes a pane ID as its
 * target and opens that one terminal (detach with ctrl+b q). Pane IDs are workspace-qualified
 * (`w1V:pJD`), so no workspace flag is needed. Anything else is the recorded command as it stands.
 */
export function localAttachCommand(handle: Pick<SessionHandle, 'state' | 'attach'>): string | null {
  if (handle.state !== 'running' || !handle.attach) return null;
  const pane = recordedHerdrPane(handle.attach);
  return pane ? `herdr agent attach ${pane}` : handle.attach.trim();
}

/**
 * The attach command as run from another machine, through Herdr's remote machinery, built from the
 * handle's recorded host. The installed `herdr --help` documents two remote paths:
 * `herdr --machine <label-or-id> <command>` runs an API command on a saved SSH machine, and
 * `herdr --remote <ssh-target>` attaches the remote server's whole UI through SSH. Interactive
 * attachment is not forwarded by `--machine` (`herdr --skill`), so `--machine … agent attach` does
 * not work; the remote form therefore focuses the pane on its host with an API command and then
 * attaches that host's UI, which opens on the focused pane:
 * `herdr --machine HOST agent focus PANE && herdr --remote HOST`.
 * A command that is not Herdr's, or a handle with no host, has no second form.
 */
export function remoteAttachCommand(handle: Pick<SessionHandle, 'state' | 'attach' | 'host'>): string | null {
  if (handle.state !== 'running' || !handle.host || /\s/.test(handle.host)) return null;
  const pane = recordedHerdrPane(handle.attach);
  return pane ? `herdr --machine ${handle.host} agent focus ${pane} && herdr --remote ${handle.host}` : null;
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
  /** The local and remote attach forms while it runs; a finished row offers its transcript instead. */
  local: string | null; remote: string | null;
  stale: { since: string; idleMs: number } | null;
  reconciled: 'vanished' | 'superseded' | 'ended' | null;
  /**
   * Recorded running, but not seen for more than `endedItemIdleMs` on an item that is delivered
   * ('delivered') or closed ('closed'): listed with the ended sessions, never as open.
   */
  leftOn: 'delivered' | 'closed' | null;
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
export function workerRow(work: Pick<Work, 'id' | 'key'> & Partial<Pick<Work, 'stage' | 'closure'>>, handle: SessionHandle, now: Date, thresholdMs = sessionStaleThresholdMs): WorkerRow {
  const startedAt = parsed(handle.startedAt) ?? now.getTime();
  const endedAt = handle.state === 'running' ? now.getTime() : parsed(handle.endedAt) ?? parsed(handle.updatedAt) ?? startedAt;
  const stale = staleSession(handle, now, thresholdMs);
  const leftOn = stale && stale.idleMs > endedItemIdleMs && work.stage === 'done' ? work.closure ? 'closed' : 'delivered' : null;
  return { ...handle, workId: work.id, key: work.key, roleKind: sessionRoleKind(handle), spentMs: Math.max(0, endedAt - startedAt),
    local: localAttachCommand(handle), remote: remoteAttachCommand(handle),
    stale, reconciled: reconciledClosure(handle), leftOn };
}

/**
 * The tab, organised for triage: running rows first by time spent descending, finished rows after
 * by end time descending, and one summary per worker, reviewer or producer principal — approver,
 * escalation and master sessions belong to the loop, not to a seat that is either busy or idle.
 * A running handle left on a finished item (`leftOn`) is filed with the finished rows, dated from
 * when it was last seen.
 */
export function workersView(all: (Pick<Work, 'id' | 'key' | 'sessions'> & Partial<Pick<Work, 'stage' | 'closure'>>)[], now: Date, thresholdMs = sessionStaleThresholdMs): WorkersView {
  const rows = all.flatMap(work => (work.sessions ?? []).map(handle => workerRow(work, handle, now, thresholdMs)));
  const open = (row: WorkerRow) => row.state === 'running' && !row.leftOn;
  const endedAt = (row: WorkerRow) => parsed(row.leftOn ? row.updatedAt : row.endedAt) ?? 0;
  const running = rows.filter(open).sort((a, b) => b.spentMs - a.spentMs || a.key.localeCompare(b.key));
  const finished = rows.filter(row => !open(row)).sort((a, b) => endedAt(b) - endedAt(a) || a.key.localeCompare(b.key));
  const dayAgo = now.getTime() - 24 * 3_600_000;
  const seats = new Map<string, WorkerRow[]>();
  for (const row of rows) if (['worker', 'reviewer', 'producer'].includes(row.roleKind)) seats.set(row.principal, [...seats.get(row.principal) ?? [], row]);
  const principals = [...seats].map(([principal, handles]): PrincipalSummary => {
    const live = handles.filter(open).sort((a, b) => (parsed(b.startedAt) ?? 0) - (parsed(a.startedAt) ?? 0))[0];
    const latest = handles.reduce((last, row) => (parsed(row.startedAt) ?? 0) >= (parsed(last.startedAt) ?? 0) ? row : last);
    return { principal, roleKind: (live ?? latest).roleKind,
      current: live ? { key: live.key, workId: live.workId, epoch: live.epoch, sinceMs: live.spentMs } : null,
      sessionsLast24h: handles.filter(row => open(row) || (parsed(row.leftOn ? row.updatedAt : row.endedAt) ?? parsed(row.updatedAt) ?? 0) >= dayAgo).length };
  }).sort((a, b) => (b.current?.sinceMs ?? -1) - (a.current?.sinceMs ?? -1) || a.principal.localeCompare(b.principal));
  return { running, finished, principals };
}
