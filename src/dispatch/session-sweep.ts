import { type Work } from '../model.js';
import { reportedHandle, type SessionReportEntry } from '../model/session-state.js';
import { runtimeSessionOf, sessionLiveness, sessionRole, sessionVanishGraceMs, supersededSession, type LivenessOptions, type SessionHandle, type SessionHandleInput, type SessionKind, type RuntimeSession } from '../model/sessions.js';
import { runtimeEndedStates } from '../harness.js';
import { type DispatchRequest } from '../model/dispatch.js';
import { orphanedRegistrySessions } from '../master/registry-slot.js';
import { bounded, closureFailureReasonLimit, type DispatchCursor } from './cursor.js';
import type { DispatchEffects } from './effects.js';
import type { DispatchTick } from './tick.js';
/**
 * The handle a launched reviewer or producer session gets on the item: the pane its launcher just
 * reported, the runtime and workspace this loop launched it into, and the command that attaches to
 * that exact pane. `id` is the dispatch request the session answers, so a relaunch updates the
 * handle rather than adding one.
 *
 * What the launcher cannot know — the tab the runtime opened under its own control, and the
 * transcript the agent writes — the session records for itself against
 * `POST /api/work/GY-N/session`, which is the only party that has them. A handle with no pane
 * carries no attach command rather than one that cannot work.
 *
 * It also records what liveness reconciliation needs of it (GY-113): the runtime's own name for the
 * session, so the handle can be matched against the runtime's listing even after its pane is gone;
 * the slot it occupies, which is its kind and, for a producer session, the one proof group it runs;
 * and the exact head it is bound to, so a session for a head the item has moved past is recognised
 * as superseded rather than left running against a candidate nobody is waiting for.
 */
export function launchedSessionHandle(kind: 'review' | 'proof', request: DispatchRequest, subject: string, host: string, launched: { pane?: string | null; agentName?: string | null } | undefined, runtime: string, workspace?: string, principal?: string): SessionHandleInput {
  return {
    id: request.id, kind, runtime, host,
    role: kind === 'proof' && request.group ? `proof:${request.group}` : kind, head: request.sha,
    ...(launched?.agentName ? { agentName: launched.agentName } : {}),
    // Whose session it is, when the launcher knows: a producer session runs under its own
    // credential, and naming it here is what lets that session — and nobody else — fill in the
    // tab and transcript the launcher cannot see.
    ...(principal ? { principal } : {}),
    ...(workspace ? { workspace } : {}),
    ...(launched?.pane ? { pane: launched.pane, attach: `herdr pane attach ${launched.pane}${workspace ? ` --workspace ${workspace}` : ''}` } : {}),
    subject: subject.slice(0, 300), state: 'running',
  };
}

/**
 * The liveness sweep this loop runs every tick (GY-113). The rules it applies are the model's —
 * `sessionLiveness` for what the runtime says, `supersededSession` for what the item says — and
 * the sweep over the graph, the closure it records and the write-back live here with the interval
 * that runs them. It is pure over the snapshot: the caller writes each closure back through the
 * coordinator mutation, so one sweep answers a status reader and this loop alike.
 */
export type ClosureCause = 'vanished' | 'ended' | 'superseded' | 'duplicate';
export interface SessionClosure { workId: string; key: string; id: string; kind: SessionKind; role: string; runtime: string; host: string; subject: string; cause: ClosureCause; outcome: string;
  /** The session report entry that closed it, when the runtime's observation did rather than the item. */
  report?: SessionReportEntry }
/** How one handle is named between ticks: the item it sits on, and its own id. */
export const sessionHandleKey = (workId: string, id: string) => `${workId}\u0000${id}`;
/** Whose vocabulary a reported state is judged by, whose runtime answers for a handle, and how long a handle the runtime has stopped reporting is left alone. */
export type ReconcileOptions = LivenessOptions & { graceMs?: number;
  /** This host: a handle another host launched is not judged against this host's runtime listing. */
  hostId?: string | null;
  /** When each handle the runtime had stopped reporting was first missed, as the previous sweep left it. */
  missing?: Record<string, string> };
export interface SessionSweep {
  /** Every running handle on the graph that is over, with the outcome it is closed with. */
  closures: SessionClosure[];
  /**
   * The handles this runtime did not report, each carrying when it was first missed — the next
   * sweep's `missing`. A vanished handle is closed only once the runtime has failed to report it
   * for the whole grace, so a single listing that comes back short closes nothing; an entry
   * survives its closure, so a write-back that failed is retried on the next tick rather than
   * starting the grace again.
   */
  missing: Record<string, string>;
}
export function reconcileSessionLiveness(all: Work[], runtime: RuntimeSession[] | null, now: Date, options: ReconcileOptions = {}): SessionSweep {
  const states = options.states ?? runtimeEndedStates, graceMs = options.graceMs ?? sessionVanishGraceMs;
  const previous = options.missing ?? {}, missing: Record<string, string> = {};
  const closures: SessionClosure[] = [];
  for (const work of all) {
    const running = (work.sessions ?? []).filter(handle => handle.state === 'running');
    const closed = new Set<string>();
    const close = (handle: SessionHandle, cause: ClosureCause, outcome: string) => {
      closed.add(handle.id);
      closures.push({ workId: work.id, key: work.key, id: handle.id, kind: handle.kind, role: sessionRole(handle), runtime: handle.runtime, host: handle.host, subject: handle.subject, cause, outcome: outcome.slice(0, 500) });
    };
    for (const handle of running) {
      // The item first: a session bound to a head that merged, was superseded or went back to a
      // worker is over whether or not its runtime still lists it, and why it is over is what is
      // worth recording — the runtime would only ever say it vanished.
      const superseded = supersededSession(work, handle, now);
      if (superseded) { close(handle, 'superseded', `superseded: ${superseded}`); continue; }
      const liveness = sessionLiveness(handle, runtime, states, options.hostId);
      if (liveness !== 'vanished' && liveness !== 'ended') continue;
      const since = Date.parse(handle.updatedAt), idleMs = Number.isFinite(since) ? now.getTime() - since : 0;
      const where = handle.pane ? `pane ${handle.pane}` : `session ${handle.agentName}`;
      if (liveness === 'ended') {
        // The runtime says so itself, in its own vocabulary; the grace still covers a handle
        // recorded moments ago against a stale listing.
        if (idleMs < graceMs) continue;
        close(handle, 'ended', `the ${handle.runtime} runtime on ${handle.host} reports ${where} as ${runtimeSessionOf(handle, runtime ?? [])?.agent_status ?? 'ended'}, so the session is over`);
        continue;
      }
      // Absence is weaker evidence than a reported state, so it must persist: the runtime has to
      // have failed to report the session for the whole grace, counted from the first sweep that
      // missed it, and the handle has to be older than the grace too — a session recorded at
      // launch appears in its runtime's inventory a moment later. One short listing closes nothing.
      const key = sessionHandleKey(work.id, handle.id);
      const first = Date.parse(previous[key] ?? '');
      const firstMissedAt = Number.isFinite(first) ? Math.min(first, now.getTime()) : now.getTime();
      missing[key] = new Date(firstMissedAt).toISOString();
      const missingMs = now.getTime() - firstMissedAt;
      if (idleMs < graceMs || missingMs < graceMs) continue;
      close(handle, 'vanished', `vanished: the ${handle.runtime} runtime on ${handle.host} has not reported ${where} for ${Math.round(missingMs / 1000)}s, ${Math.round(idleMs / 1000)}s after its last observed activity at ${handle.updatedAt}`);
    }
    // One slot, one live session: a second review or proof session for the same role and head
    // supersedes the ones before it, so a relaunch under a fresh id never leaves two standing. An
    // implementation session is not collapsed here any more than it is superseded above — its
    // lease is what says which attempt may still act, and two handles under one epoch are the
    // worker's own record of its sessions.
    const slots = new Map<string, SessionHandle[]>();
    for (const handle of running) {
      if (closed.has(handle.id) || !handle.head || (handle.kind !== 'review' && handle.kind !== 'proof')) continue;
      const slot = `${sessionRole(handle)}\u0000${handle.head}`;
      slots.set(slot, [...slots.get(slot) ?? [], handle]);
    }
    for (const [, slot] of slots) {
      if (slot.length < 2) continue;
      const newest = slot.reduce((latest, handle) => Date.parse(handle.startedAt) >= Date.parse(latest.startedAt) ? handle : latest);
      for (const handle of slot) if (handle !== newest)
        close(handle, 'duplicate', `superseded: session ${newest.id} holds the same role (${sessionRole(handle)}) on head ${handle.head!.slice(0, 12)}, and one item holds one live session per role and head`);
    }
  }
  return { closures, missing };
}
/** What a closure is written back as: the handle's own identity, ended, carrying why — and, for one the session report closed, the observation that closed it. */
export function closureHandle(closure: SessionClosure): SessionHandleInput {
  return { id: closure.id, kind: closure.kind, runtime: closure.runtime, host: closure.host, subject: closure.subject, state: 'finished', outcome: closure.outcome,
    ...(closure.report ? reportedHandle(closure.report) : {}) };
}
/**
 * A record the session report closed, as a closure: `ended` when the runtime reports the session
 * over or its pane holds no agent, and `vanished` — the report's `lost` — when it was absent from
 * consecutive reports.
 */
export function reportClosure(entry: SessionReportEntry): SessionClosure {
  return { workId: entry.workId, key: entry.key, id: entry.id, kind: entry.kind, role: entry.role, runtime: entry.runtime, host: entry.host, subject: entry.subject,
    cause: entry.closed === 'lost' ? 'vanished' : 'ended', outcome: (entry.outcome ?? '').slice(0, 500), report: entry };
}

/**
 * Herdr's listing as the session report reads it. Herdr names the agent it detects in each pane
 * and leaves the field out for a pane with none — a shell, where an agent that exited leaves its
 * named pane behind, still reported `idle`. That absence is the fact the report needs (a dead
 * worker otherwise stays "Builds code" for as long as its pane stays open), so it is made explicit.
 */
export const herdrSessionListing = (agents: RuntimeSession[]): RuntimeSession[] => agents.map(entry => ({ ...entry, agent: entry.agent || null }));

/**
 * GY-2945: the registry sessions of this host that no Herdr pane backs — a session a restarted
 * loop no longer tracks among its handles, whose ledger record is all that names its pane. The
 * control plane's own settlement keeps such a session live while its request stands, so the
 * finished review it belongs to pins its role at the concurrency limit. Judged here, where the
 * slot is spent: the first tick records the miss, the second ends the session with the missing
 * pane named, and the request the slot held back launches in this tick or the next. A completed
 * review ledger record needs only the first miss after launch grace. An unread
 * registry or an unread Herdr is a gap: nothing is judged and the misses stand as they were.
 */
export async function sweepRegistrySessions(hostId: string, cursor: DispatchCursor, effects: Pick<DispatchEffects, 'registry' | 'endRegistrySession'>, herdr: RuntimeSession[], records: Parameters<typeof orphanedRegistrySessions>[3], clock: number, work: Work[], tick: Pick<DispatchTick, 'registryClosed' | 'closeFailures'>) {
  if (!effects.registry || !effects.endRegistrySession) return;
  const document = await effects.registry();
  if (document) {
    const misses: Record<string, string> = {};
    tick.registryClosed = [];
    for (const orphan of orphanedRegistrySessions(document, hostId, herdr, records, clock, work)) {
      const first = Date.parse(cursor.registryMisses[orphan.id] ?? '');
      const firstMissedAt = Number.isFinite(first) ? Math.min(first, clock) : clock;
      misses[orphan.id] = new Date(firstMissedAt).toISOString();
      // The second consecutive miss is the end; an entry survives a failed end, so the next
      // tick retries it rather than starting the grace again.
      // A completed verdict already settled the ledger. Its item may be
      // absent from this snapshot, so the handle-based close step cannot release its slot.
      // Once its pane is gone it needs no second miss, including after a loop restart.
      // GY-3116: a closed review no watched pane backs has nothing to miss; it ends at once.
      if (!orphan.completedReview && !orphan.completedImplementation && !orphan.closedReview && !Number.isFinite(first)) continue;
      const reason = orphan.closedReview ? `its review record is ${orphan.closedReview} and no watched pane backs it (${orphan.agentName ?? 'no agent name recorded'}), so the review is over`
        : `${orphan.completedImplementation ? 'the submitted implementation is finished and ' : orphan.completedReview ? 'the review is completed and ' : ''}the Herdr inventory no longer reports pane ${orphan.pane} (${orphan.agentName ?? 'no agent name recorded'}), so its session is gone`;
      try { await effects.endRegistrySession(orphan, reason); tick.registryClosed.push({ work: orphan.work, id: orphan.id, role: orphan.role, pane: orphan.pane }); }
      catch (error) { tick.closeFailures.push({ work: orphan.work ?? '', id: orphan.id, reason: bounded(error instanceof Error ? error.message : String(error), closureFailureReasonLimit) }); }
    }
    cursor.registryMisses = misses;
  }
}
