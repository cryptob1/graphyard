import { agentOwner, humanOwner, type AttentionItem } from '../master.js';
import type { Work } from '../model.js';
import { idleActionable, queueSnapshot } from '../model/actions.js';
import { openAgentRequests } from '../model/agent-requests.js';
import { runningSessions, sessionSummary, unseenSessions } from '../model/sessions.js';

/**
 * What `master status` reports about the inverted loop (GY-87): the typed action each open item
 * needs, the rows executors are claiming, the typed requests agents recorded instead of asking a
 * prose question, and the sessions a human or an executor can watch. Reporting only — every
 * decision shown here was already made by the control plane.
 */

const minutes = (ms: number) => `${Math.round(ms / 6000) / 10} min`;

/**
 * One line per open typed agent request: who asked, what for, who decides it, and how long it has
 * waited. Nothing here is a prose question left hanging — a session that needed something recorded
 * it and exited, so the item is free and the ask is addressed to a named decider. A human-only
 * decision is owned by the operator; every other kind is an agent's to make.
 */
export function agentRequestAttention(snapshot: { work: Work[]; now: string }): AttentionItem[] {
  const now = new Date(snapshot.now);
  return snapshot.work.flatMap(work => openAgentRequests(work, now).map(request => {
    const text = `${request.requestedBy} recorded a ${request.type} on ${work.key} ${minutes(request.waitedMs)} ago and released its lease: ${request.reason} — decided by ${request.decider.who}`;
    return { subject: work.key, text,
      ...(request.decider.kind === 'human'
        ? humanOwner(request.humanDecision === 'spending-money-or-accounts' ? 'spending money or opening third-party accounts' : request.humanDecision === 'issuing-credentials' ? 'issuing credentials to people' : 'goals and priorities', request.reason)
        : agentOwner('master', request.decider.command ?? `graphyard master status names ${work.key}'s next action`, request.decider.kind === 'approver' ? 'approver' : undefined)) };
  }));
}

/**
 * The executor view of the fleet: the typed action each open item needs next, the durable rows
 * the executors are claiming, and every row that has waited longer than the idle bound. This is
 * what replaces a master reading a status report and deciding what to do about each item — the
 * decisions are already made here, and `master status` only reports them.
 */
export function actionReport(snapshot: { work: Work[]; now: string }) {
  const now = new Date(snapshot.now);
  const queue = queueSnapshot(snapshot.work, now);
  return {
    ...queue,
    next: snapshot.work.filter(work => work.nextAction).map(work => ({ key: work.key, kind: work.nextAction!.kind, reason: work.nextAction!.reason, gate: work.nextAction!.gate, llmRole: work.nextAction!.llmRole })),
    idle: idleActionable(snapshot.work, now),
  };
}

/** Every open typed request, item by item, with the decider each names and how long it has waited. */
export function agentRequestReport(snapshot: { work: Work[]; now: string }) {
  const now = new Date(snapshot.now);
  return snapshot.work.flatMap(work => openAgentRequests(work, now).map(request => ({ key: work.key, work: work.id, ...request })));
}

/**
 * Every session Graphyard knows is running, with what it is working on and the command or link
 * that attaches to it, plus the finished sessions whose transcripts are still linked. A human or
 * an executor watches a specific agent from this; no master relays a pane identifier. A session
 * recorded open whose observation went stale is neither running nor finished, so it is listed as
 * `unseen` (GY-172) rather than vanishing while the Workers page still shows it.
 */
export function sessionReport(snapshot: { work: Work[]; now: string }) {
  const now = new Date(snapshot.now);
  const all = snapshot.work.flatMap(work => sessionSummary(work, now));
  return { running: runningSessions(snapshot.work, now), unseen: unseenSessions(snapshot.work, now), finished: all.filter(handle => handle.state === 'finished').slice(-20) };
}
