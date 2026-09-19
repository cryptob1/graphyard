import { z } from 'zod';
import { demand } from './refusal.js';
import { proofSchema } from './proof.js';
import { criterionSchema, resourcesSchema } from './policy.js';
import { implementerIdentities } from './evidence.js';
import { standingEscalations } from './escalation.js';
import { createSchema, escalationTriggers, operatorCapability, type OperatorCapability, type Principal, type Work } from './work.js';

/**
 * Two-party decisions: the calls the guides used to reserve for a human operator. An agent
 * identity holding the action's capability requests one; a second, independent agent identity
 * holding `decision:approve` approves it; only then does the control plane apply it. Every
 * step is appended to the events ledger with requester, approver and reason. What stays
 * human-only is not a decision here: goals and priorities, spending money or opening
 * third-party accounts, and issuing credentials to people.
 */
export const decisionActions = ['release', 'unblock', 'requirements', 'resolve', 'attest', 'merge', 'rework', 'grant'] as const;
export type DecisionAction = typeof decisionActions[number];
export const decisionCapabilities: Record<DecisionAction, OperatorCapability> = {
  release: 'intent:ready', unblock: 'intent:unblock', requirements: 'policy:requirements', resolve: 'decision:resolve',
  attest: 'decision:attest', merge: 'decision:merge', rework: 'decision:rework', grant: 'decision:grant',
};
export const approveCapability: OperatorCapability = 'decision:approve';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const revision = z.number().int().positive();
const principalId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/);
/** What each action binds. The engine re-validates every field when the decision is applied. */
export const decisionInputs = {
  release: z.object({ expectedRevision: revision }).strict(),
  unblock: z.object({ expectedRevision: revision }).strict(),
  // Rewrites and removals are exactly what an operator agent cannot do alone; approved, they
  // still raise the requirement-weakening escalation the engine records for any narrowing.
  requirements: z.object({ expectedPolicyRevision: revision, criteria: z.array(criterionSchema).min(1).max(50), dependencies: z.array(z.string().uuid()).max(50), plannedFiles: createSchema.shape.plannedFiles, exclusiveResources: resourcesSchema, producerProofs: createSchema.shape.producerProofs }).strict(),
  resolve: z.object({ trigger: z.enum(escalationTriggers), expectedRevision: revision }).strict(),
  attest: z.object({ proof: proofSchema.refine(proof => proof.startsWith('manual:'), 'Only manual: proofs are attested; automated proofs come from producers'), sha, baseSha: sha, policyRevision: revision, result: z.enum(['pass', 'fail']), executed: z.number().int().min(0), skipped: z.number().int().min(0), url: z.url().max(2000).optional() }).strict(),
  merge: z.object({ sha, baseSha: sha, policyRevision: revision }).strict(),
  rework: z.object({ previousWorkerStopped: z.literal(true) }).strict(),
  grant: z.object({ principal: principalId, patterns: z.array(z.string().min(1).max(200)).min(1).max(50), expectedRevision: z.number().int().min(0).optional() }).strict(),
} satisfies Record<DecisionAction, z.ZodType>;
const reason = z.string().trim().min(1).max(2000);
export const decisionRequestSchema = z.object({ action: z.enum(decisionActions), input: z.unknown(), reason }).strict();
export const decisionApprovalSchema = z.object({ decision: z.string().uuid(), reason }).strict();

export type DecisionState = 'requested' | 'approved' | 'applied' | 'failed';
export interface Decision {
  id: string; workId: string; action: DecisionAction; input: any; reason: string;
  requestedBy: string; requestedAt: string; state: DecisionState;
  approvedBy: string | null; approvedAt: string | null; approvalReason: string | null;
  outcome: string | null; refusals: { approver: string; conflict: string; at: string }[];
}
export interface DecisionEvent { kind: string; actor: string; at: string; payload: any }

/** Rebuild every decision on an item from its append-only ledger entries, oldest first. */
export function foldDecisions(workId: string, events: DecisionEvent[]): Decision[] {
  const decisions = new Map<string, Decision>();
  for (const event of events) {
    const details = event.payload ?? {};
    if (event.kind === 'decision.requested') {
      decisions.set(details.id, { id: details.id, workId, action: details.action, input: details.input, reason: details.reason, requestedBy: event.actor, requestedAt: event.at, state: 'requested',
        approvedBy: null, approvedAt: null, approvalReason: null, outcome: null, refusals: [] });
      continue;
    }
    const decision = decisions.get(details.id);
    if (!decision) continue;
    if (event.kind === 'decision.refused') decision.refusals.push({ approver: event.actor, conflict: details.conflict, at: event.at });
    if (event.kind === 'decision.approved') Object.assign(decision, { state: 'approved', approvedBy: event.actor, approvedAt: event.at, approvalReason: details.reason });
    if (event.kind === 'decision.applied') Object.assign(decision, { state: 'applied', outcome: details.outcome ?? null });
    if (event.kind === 'decision.failed') Object.assign(decision, { state: 'failed', outcome: details.error ?? null });
  }
  return [...decisions.values()];
}

/**
 * Requesters and approvers are agent identities: a scoped operator agent holding the
 * capability, or an `admin`. Coordinators, workers, producers, readers and slice leads never
 * decide; a coordinator in particular is the master's loop identity, and letting it approve the
 * master's own operator-agent requests would be one agent approving itself.
 */
export function assertDecisionAuthority(actor: Principal, capability: OperatorCapability, work: Work, repository: string) {
  demand(actor.role === 'admin' || actor.role === 'operator-agent', `Decisions are requested and approved by agent identities holding ${capability}; ${actor.id} is a ${actor.role}`, 403);
  operatorCapability(actor, capability, work, repository);
}

/**
 * Separation of duties for one approval, or null when the approver is independent. The approver
 * is never the requester, never anyone who has held an assignment on the item, never the
 * producer of evidence the decision rests on, and never the principal a grant would empower.
 */
export function approvalConflict(decision: Pick<Decision, 'id' | 'action' | 'input' | 'requestedBy'>, approver: Pick<Principal, 'id'>, work: Work): string | null {
  if (approver.id === decision.requestedBy)
    return `Self-approval refused: ${approver.id} requested decision ${decision.id}; a second, independent agent identity must approve it`;
  if (implementerIdentities(work).includes(approver.id))
    return `Conflicted approval refused: ${approver.id} has held an assignment on ${work.key}, so it cannot approve decisions about it`;
  if (decision.action === 'attest' || decision.action === 'merge') {
    const own = work.evidence.filter(item => item.producer === approver.id && (decision.action === 'merge' || item.proof === decision.input.proof));
    if (own.length) return `Conflicted approval refused: ${approver.id} produced evidence ${[...new Set(own.map(item => item.proof))].join(', ')} on ${work.key} and may not approve its own evidence`;
  }
  if (decision.action === 'grant' && decision.input.principal === approver.id)
    return `Conflicted approval refused: ${approver.id} is the principal this grant would authorize`;
  return null;
}

/** The item must still be in the state the decision was requested against. */
export function decisionPrecondition(action: DecisionAction, input: any, work: Work): string | null {
  if (work.stage === 'done') return 'Delivered work is immutable; create a follow-up task';
  if ((action === 'release' || action === 'unblock' || action === 'resolve') && input.expectedRevision !== work.revision) return `Task revision changed (now ${work.revision}); reload and request again`;
  if (action === 'release' && (work.stage !== 'backlog' || work.ready)) return 'Only unreleased backlog work can be released';
  if (action === 'unblock' && !work.blocker) return 'Task has no blocker to clear';
  if (action === 'resolve' && !standingEscalations(work).some(entry => entry.trigger === input.trigger)) return `No standing ${input.trigger} escalation; standing: ${standingEscalations(work).map(entry => entry.trigger).join(', ') || 'none'}`;
  if (action === 'requirements' && input.expectedPolicyRevision !== work.policyRevision) return `Policy revision changed (now ${work.policyRevision}); reload and request again`;
  if (action === 'attest' && !work.criteria.some(criterion => criterion.proofs.includes(input.proof))) return `${input.proof} is not required by any criterion of ${work.key}`;
  if (action === 'attest' || action === 'merge') {
    if (!work.candidate || work.candidate.sha !== input.sha || work.candidate.baseSha !== input.baseSha || work.policyRevision !== input.policyRevision)
      return `The decision names ${String(input.sha).slice(0, 12)} but the current candidate is ${work.candidate?.sha.slice(0, 12) ?? 'none'} at policy revision ${work.policyRevision}`;
  }
  if (action === 'rework' && !work.submission) return 'Rework applies to submitted work';
  return null;
}
