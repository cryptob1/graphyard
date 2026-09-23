import { z } from 'zod';
import { escalationTriggers, type Work } from './work.js';

/**
 * Typed agent requests.
 *
 * An agent that needs something from somebody else never blocks on a prose question: it records
 * a typed request and exits, giving up its lease in the same transaction. The request names its
 * decider, so nothing waits on a master session noticing it, and the item is free for the next
 * assignment rather than held by a session sitting at a prompt.
 *
 * Every type names exactly one decider, from the four the project allows (see AGENTS.md and
 * docs/glossary.md#who-decides):
 *
 * - **rule** — a deterministic rule the control plane applies; no judgment is involved.
 * - **approver** — an independent approver agent, through the two-party decision machinery.
 * - **follow-up** — a tracked follow-up work item; the cause is outside this item.
 * - **human** — one of the three human-only decisions: goals and priorities, spending money or
 *   opening third-party accounts, and issuing credentials to people.
 *
 * A session that ends waiting on input instead of recording one of these is recorded as failed
 * with that reason (master-daemon.ts); this is what it should have recorded.
 */

export const agentRequestTypes = ['scope-request', 'decision', 'blocker', 'note', 'escalation'] as const;
export type AgentRequestType = typeof agentRequestTypes[number];
export const deciderKinds = ['rule', 'approver', 'follow-up', 'human'] as const;
export type DeciderKind = typeof deciderKinds[number];
/** The three decisions no agent may make. A request may name one; nothing else routes to a human. */
export const humanDecisions = ['goals-and-priorities', 'spending-money-or-accounts', 'issuing-credentials'] as const;
export type HumanDecision = typeof humanDecisions[number];

export interface Decider { kind: DeciderKind; who: string; command: string | null }

export interface AgentRequest {
  id: string; type: AgentRequestType;
  /** The attempt that raised it; a request from a lease that ended is never acted on. */
  epoch: number | null;
  requestedBy: string; at: string; reason: string;
  /** scope-request: the paths outside plannedFiles the attempt needs. */
  paths?: string[];
  /** decision: the two-party decision action an approver agent must approve. */
  action?: string;
  /** escalation: which standing concern the request raises. */
  trigger?: string;
  /** Named only when the request is one of the three human-only decisions. */
  humanDecision?: HumanDecision;
  decider: Decider;
  /** Whether the requesting session gave up its lease when it recorded this. */
  releasedLease: boolean;
  state: 'open' | 'resolved';
  resolvedAt?: string; resolution?: string;
}

export const agentRequestSchema = z.object({
  type: z.enum(agentRequestTypes),
  reason: z.string().trim().min(1).max(2000),
  epoch: z.number().int().positive().optional(),
  paths: z.array(z.string().min(1).max(500)).max(50).optional(),
  action: z.string().trim().min(1).max(100).optional(),
  trigger: z.enum(escalationTriggers).optional(),
  humanDecision: z.enum(humanDecisions).optional(),
  /** Whether recording this ends the attempt. A note is a record, not a hand-off, so it defaults off. */
  release: z.boolean().optional(),
  /** Resolve an open request instead of raising one. */
  resolve: z.string().min(1).max(64).optional(),
}).strict();
export type AgentRequestInput = z.infer<typeof agentRequestSchema>;

const command = (key: string, type: AgentRequestType, action?: string) =>
  type === 'scope-request' ? `graphyard master scope ${key}`
    : type === 'decision' ? `graphyard master decide ${key} ${action ?? 'ACTION'} REASON, then graphyard master approver ${key} DECISION`
      : type === 'escalation' ? `graphyard master decide ${key} resolve-escalation REASON, then graphyard master approver ${key} DECISION`
        : type === 'blocker' ? `graphyard master create — a follow-up item naming ${key} and the external cause`
          : null;

/**
 * Who decides a request. Deterministic: the type decides, except that a request naming one of the
 * three human-only decisions routes to the operator whatever its type. Nothing else reaches a human.
 */
export function deciderFor(key: string, request: Pick<AgentRequest, 'type' | 'action' | 'humanDecision'>): Decider {
  if (request.humanDecision) return { kind: 'human', who: `the human operator (${request.humanDecision.replace(/-/g, ' ')})`, command: null };
  switch (request.type) {
    // Decided in the same transaction the request is recorded in (engine.ts), from the item's own
    // criteria and this repository's documentation rule; a refusal becomes the item's blocker.
    case 'scope-request': return { kind: 'rule', who: 'the additive planned-files widening rule', command: command(key, 'scope-request') };
    case 'decision': return { kind: 'approver', who: 'an independent approver agent', command: command(key, 'decision', request.action) };
    case 'escalation': return { kind: 'approver', who: 'an independent approver agent', command: command(key, 'escalation') };
    case 'blocker': return { kind: 'follow-up', who: 'a tracked follow-up work item', command: command(key, 'blocker') };
    case 'note': return { kind: 'rule', who: 'nobody; a note is recorded, not decided', command: null };
  }
}

export const agentRequestLimit = 50, agentRequestCeiling = 200;

/**
 * The bound on an item's recorded requests, which never drops an open ask a decider owes an
 * answer to.
 *
 * Trimming the oldest entries would be a way to remove somebody else's ask: a `note` needs no
 * lease, so any credential that reaches the item could push the open requests off the end by
 * writing fifty of them. A `decision`'s only durable effect *is* its record — `blocker`,
 * `escalation` and `scope-request` each project onto state that survives — so losing it loses
 * both the ask and the `escalate` action the control plane raises from it. Room is therefore made
 * from resolved entries first, oldest first, and then from notes, which name no decider and move
 * nothing anybody is waiting on; the request just recorded is never the one dropped to make room
 * for itself. This is the rule `sessions.ts::bounded` applies to handles, with the same ceiling
 * behind it so the document stays bounded whatever is outstanding.
 */
export function boundedAgentRequests(requests: AgentRequest[], recorded: AgentRequest): AgentRequest[] {
  if (requests.length <= agentRequestLimit) return requests;
  const excess = requests.length - agentRequestLimit;
  const retire = new Set<AgentRequest>();
  const disposable = [(request: AgentRequest) => request.state === 'resolved', (request: AgentRequest) => request.type === 'note'];
  for (const spends of disposable) for (const request of requests) {
    if (retire.size >= excess) break;
    if (request !== recorded && !retire.has(request) && spends(request)) retire.add(request);
  }
  const kept = requests.filter(request => !retire.has(request));
  // Only open asks with a named decider are left; the recorded one is last, so trimming to the
  // ceiling keeps it and drops the oldest.
  return kept.length <= agentRequestCeiling ? kept : kept.slice(kept.length - agentRequestCeiling);
}

/**
 * The types that move state a gate reads. Recording one is the same fact as the command it
 * replaces — `blocked` sets the blocker, an escalation fences the merge, a scope ask widens the
 * planned files — so it needs exactly the authority that command needs: the live lease on the
 * item, under the attempt that is asking. Without that rule any worker or producer credential
 * could block or fence any item in the graph, which is the opposite of what a typed request is
 * for. A `note` records nothing a gate reads, so it needs no lease.
 */
export const leaseHeldRequestTypes: readonly AgentRequestType[] = agentRequestTypes.filter(type => type !== 'note');

/**
 * Why this actor may not close that request, or null when it may.
 *
 * The decider the record names is the only party that closes it. Without this rule a session
 * could record a request whose decider is an independent approver or the human operator and then
 * resolve it itself, and master status would stop showing the very thing it exists to surface.
 * The asker never closes its own ask — a decision is somebody else's by construction — except for
 * a note, which decides nothing and is its author's own record.
 */
export function requestResolutionRefusal(request: Pick<AgentRequest, 'type' | 'requestedBy' | 'decider'>, actor: { id: string; role: string }): string | null {
  if (request.type === 'note') {
    return request.requestedBy === actor.id || ['coordinator', 'admin'].includes(actor.role) ? null
      : `A note is closed by its author (${request.requestedBy}), a coordinator or the operator`;
  }
  if (request.requestedBy === actor.id) return `${actor.id} recorded this ${request.type}; it is decided by ${request.decider.who}, never by the session that asked`;
  // A follow-up is tracked by whoever opens the item that carries it, which the loop does; every
  // other decider reaches the item through the two-party decision machinery or the operator, and
  // both apply under an operator identity.
  const allowed = request.decider.kind === 'follow-up' ? ['coordinator', 'admin'] : ['admin'];
  if (!allowed.includes(actor.role)) return `This ${request.type} is decided by ${request.decider.who}; a ${actor.role} credential cannot close it`;
  return null;
}

/** Open requests, oldest first, with how long each has waited. A request whose epoch lost the lease is closed, not reported. */
export function openAgentRequests(work: Work, now: Date) {
  return (work.agentRequests ?? []).filter(request => request.state === 'open')
    .map(request => ({ ...request, waitedMs: Math.max(0, now.getTime() - Date.parse(request.at)) }))
    .sort((a, b) => b.waitedMs - a.waitedMs);
}

/**
 * Close every open scope request whose paths the planned files now cover. Widening is the
 * deterministic rule that decides a scope ask, so applying it is the answer — the request must
 * not stay open naming files the item is already allowed to touch.
 */
export function resolveSatisfiedScopeRequests(work: Work, covered: (path: string) => boolean, now: Date) {
  for (const request of work.agentRequests ?? []) {
    if (request.state !== 'open' || request.type !== 'scope-request' || !request.paths?.every(covered)) continue;
    request.state = 'resolved'; request.resolvedAt = now.toISOString();
    request.resolution = `planned files now cover ${request.paths.join(', ')}`;
  }
}

/**
 * Close every open request raised by an attempt that no longer holds the item: a fresh attempt
 * asks afresh, exactly as a scope request does, and a stale ask must never look like a live one.
 */
export function expireAgentRequests(work: Work, now: Date, reason: string) {
  for (const request of work.agentRequests ?? []) {
    if (request.state !== 'open' || request.epoch === null || request.epoch === work.epoch) continue;
    request.state = 'resolved'; request.resolvedAt = now.toISOString(); request.resolution = reason;
  }
}
