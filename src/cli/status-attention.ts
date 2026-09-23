import { agentOwner, buildMasterStatus, humanOwner, type AttentionItem, type HerdrAgent, type WorkerProfile } from '../master.js';
import { orphanedSupervisors, type OrphanSupervisor } from '../master-daemon.js';
import type { Work } from '../model.js';
import { stallBoundMs, stalledItems, type ActionlessItem } from '../model/action-account.js';
import { elapsed } from '../model/sessions.js';
import { unansweredRequests, type RequestProgress, type UnansweredRequest } from '../model/dispatch.js';

/**
 * Who is told what, and with which command.
 *
 * `master status` is an assembler over ledgers and snapshots; this is the part of it that turns
 * one observed situation into one line addressed to somebody. Each builder answers the same three
 * questions — what is true, how long it has been true, and whose command changes it — and keeping
 * them together is what stops two readers of the same situation saying different things about it.
 * Nothing here decides anything: every situation below was already decided by the control plane.
 */

/**
 * One attention item per open worker scope request whose epoch still holds the lease: addressed
 * to the master, naming the requested paths and the worker's reason, with the one command that
 * approves it. A request from a lease that ended is never surfaced.
 */
export function scopeRequestAttention(snapshot: { work: Work[]; now: string }) {
  return snapshot.work.flatMap(work => {
    const request = work.scopeRequest;
    const live = request && work.lease && work.lease.epoch === request.epoch && Date.parse(work.lease.expiresAt) > Date.parse(snapshot.now);
    return live ? [{ subject: work.key, text: `${request.requestedBy} needs files outside plannedFiles: ${request.paths.join(', ')} — ${request.reason}`, ...agentOwner('master', `graphyard master scope ${work.key}`) }] : [];
  });
}

type MasterStatus = ReturnType<typeof buildMasterStatus>;

/** Who answers a request whose session settled unanswered, and with which command. */
export function unansweredRequestOwner(key: string, request: Pick<UnansweredRequest, 'kind'>) {
  return request.kind === 'review'
    ? agentOwner('master', `graphyard master review ${key} [PROFILE] forces the next attempt for the open request`)
    : agentOwner('master', `graphyard master decide ${key} rework REASON, approved by the approver agent, so the group's proofs are requested afresh on the next head`, 'approver');
}

/**
 * One attention item per live request whose session settled without satisfying its gate. Such a
 * request is the one state `master status` used to show as nothing at all: no session running, no
 * launch refused, no failure — just a `sinceMs` climbing past the hour while the gate goes on
 * refusing. It is named here with the verdict that settled the session, how long the request has
 * stood, and the command that gets it answered, and counted apart from the requests with a
 * session actually running (`counts.dispatchRunning`).
 */
export function unansweredRequestAttention(rows: { key: string; dispatch: { review: RequestProgress | null; producers: RequestProgress[] } | null }[]): AttentionItem[] {
  return rows.flatMap(row => unansweredRequests(row.dispatch).map(request => {
    const subject = request.kind === 'review' ? 'Review request' : `Producer request for ${request.group ?? 'its'} proofs`;
    const verdict = request.verdict ? `with verdict ${request.verdict}` : 'without a verdict';
    return { subject: row.key, text: `${subject} for ${row.key} has stood unanswered for ${elapsed(request.sinceMs)}: its session ${request.state} ${verdict} after attempt ${request.attempts} — ${request.resolution ?? 'no reason recorded'}; nothing is running for it and no further attempt is scheduled`,
      ...unansweredRequestOwner(row.key, request) };
  }));
}

/**
 * What an item with no action is missing, in one clause: the refusal its failing gate raised, or
 * the account itself when no gate said anything.
 */
const missingFrom = (entry: ActionlessItem) => entry.refusal ?? entry.detail;

/**
 * One attention item per open item the control plane names no action for and nothing is moving.
 *
 * This is the state with no other reporter. An item waiting on a dependency, on the entry ahead
 * of it in the merge queue, or on the session already building it has somewhere to be seen and
 * something that will move it; `actionlessItems` counts those separately and they raise nothing
 * here. What is left is an item holding a failing gate past the idle bound with no action, no
 * dependency and no recorded human need — which was, until this, exactly as visible as an item
 * that was fine. It is named with the gate, how long it has held it, what is missing, and who
 * answers: the operator for a decision the project reserves for a person, and the master for the
 * control-plane defect that a state produced no answer at all.
 */
export function stalledItemAttention(snapshot: { work: Work[]; now: string }, thresholdMs = stallBoundMs): AttentionItem[] {
  return stalledItems(snapshot.work, new Date(snapshot.now), thresholdMs).map(entry => {
    const held = `has held its ${entry.gate ?? 'unevaluated'} gate for ${elapsed(entry.heldMs)} with no action named and nothing moving it`;
    return entry.outcome === 'human'
      ? { subject: entry.key, text: `${entry.key} ${held}: ${missingFrom(entry)} — ${entry.detail}`, ...humanOwner('goals and priorities', entry.detail) }
      : { subject: entry.key, text: `${entry.key} ${held}: ${missingFrom(entry)} — the control plane computed neither an action, a dependency nor a human need for this state, which is a defect in the control plane rather than in the item (${entry.detail})`,
        ...agentOwner('master', `graphyard master create files the control-plane defect that left ${entry.key} without an action; until it is fixed, graphyard master status names no step for this item and nothing will claim it`) };
  });
}

/**
 * The command that reclaims an assignment from a watch supervisor that outlived its agent. The
 * coordination cycle does it on its own; this is how a master runs that cycle once when the loop
 * is stopped, which is the state the item is usually noticed in.
 */
export const supervisorReclaimCommand = 'graphyard master run --once';

/**
 * One attention line for an assignment whose watch supervisor has outlived its session.
 *
 * `Assigned worker session is done` reads as an item that finished, which is exactly what it is
 * not: the session is gone, the lease is still advancing, and the item cannot be dispatched to
 * anybody. This names the supervisor holding it, the process and scope it is held by, and the
 * command that reclaims it — an agent command, never a hand search for a pid.
 */
export function orphanSupervisorAttention(orphan: OrphanSupervisor, host: string | null): AttentionItem {
  return { subject: orphan.key,
    text: `Lease epoch ${orphan.epoch} of ${orphan.key} is still advancing (to ${orphan.leaseExpiresAt}) while Herdr no longer reports session ${orphan.agentName}: an orphaned watch supervisor (pid ${orphan.scope.pid}, containment scope ${orphan.scope.unit}) holds the item for a worker that cannot act`,
    ...agentOwner('master', `${supervisorReclaimCommand} stops that supervisor through its containment scope; on ${host ?? 'its registered host'}, systemctl --user kill --kill-whom=all --signal=SIGTERM ${orphan.scope.unit} does the same by hand`) };
}

/**
 * Rewrite the session attention of every assignment held by an orphaned supervisor, in the row
 * and in the attention list alike, so both say the same thing. A Herdr that could not be read
 * reports no sessions, and every live assignment would then look orphaned, so an unavailable
 * runtime changes nothing.
 */
export function nameOrphanSupervisors(status: MasterStatus, work: Work[], profiles: WorkerProfile[], runtime: { agents: HerdrAgent[]; available: boolean }, now: number): MasterStatus {
  if (!runtime.available) return status;
  const orphans = orphanedSupervisors(work, profiles, runtime.agents, now);
  if (!orphans.length) return status;
  const rewritten = new Map<string, { previous: string | null; item: AttentionItem }>();
  const rows = status.work.map(row => {
    const orphan = orphans.find(entry => entry.key === row.key);
    if (!orphan) return row;
    const item = orphanSupervisorAttention(orphan, work.find(candidate => candidate.id === orphan.id)?.workspaces.find(space => space.epoch === orphan.epoch)?.host ?? null);
    rewritten.set(row.key, { previous: row.attention, item });
    const { subject, text, ...owner } = item;
    return { ...row, attention: text, attentionOwner: owner };
  });
  const attentionItems = status.attentionItems.map(entry => {
    const rewrite = rewritten.get(entry.subject);
    return rewrite && entry.text === rewrite.previous ? rewrite.item : entry;
  });
  for (const [key, rewrite] of rewritten) if (!attentionItems.some(entry => entry.subject === key && entry.text === rewrite.item.text)) attentionItems.push(rewrite.item);
  return { ...status, work: rows, attentionItems };
}

