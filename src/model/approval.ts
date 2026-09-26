import { z } from 'zod';
import { demand } from './refusal.js';
import { proofSchema } from './proof.js';
import { criterionSchema, resourcesSchema } from './policy.js';
import { implementerIdentities, proofExerciseSchema } from './evidence.js';
import { standingEscalations } from './escalation.js';
import { reconciliationRefusalPrefix } from '../merge-queue.js';
import { createSchema, escalationTriggers, operatorCapability, type OperatorCapability, type Principal, type Work } from './work.js';

/**
 * Two-party decisions: the calls the guides used to reserve for a human operator. An agent
 * identity holding the action's capability requests one; a second, independent agent identity
 * holding `decision:approve` approves it; only then does the control plane apply it. Every
 * step is appended to the events ledger with requester, approver and reason. What stays
 * human-only is not a decision here: goals and priorities, spending money or opening
 * third-party accounts, and issuing credentials to people.
 */
export const decisionActions = ['release', 'unblock', 'requirements', 'resolve', 'attest', 'merge', 'rework', 'recover', 'grant', 'repair-merge'] as const;
export type DecisionAction = typeof decisionActions[number];
export const decisionCapabilities: Record<DecisionAction, OperatorCapability> = {
  release: 'intent:ready', unblock: 'intent:unblock', requirements: 'policy:requirements', resolve: 'decision:resolve',
  attest: 'decision:attest', merge: 'decision:merge', rework: 'decision:rework', recover: 'decision:rework', grant: 'decision:grant',
  // The repair lane (GY-406): the App merges a merge-path fix past the stalled merge path.
  'repair-merge': 'decision:merge',
};
export const approveCapability: OperatorCapability = 'decision:approve';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const revision = z.number().int().positive();
const principalId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/);
/**
 * The bound on the grounds binding a situated request may name (the loop's rework binding): a
 * refusal bars a later request only when it names the same candidate head, the same base and the
 * same grounds (GY-407), so the binding travels in the request's input, which the refusal match
 * compares. The loop truncates what it sends to exactly this bound.
 */
export const decisionBindingMax = 2000;
const groundsBinding = z.string().trim().min(1).max(decisionBindingMax);
/** What each action binds. The engine re-validates every field when the decision is applied. */
export const decisionInputs = {
  release: z.object({ expectedRevision: revision }).strict(),
  unblock: z.object({ expectedRevision: revision }).strict(),
  // Rewrites and removals are exactly what an operator agent cannot do alone; approved, they
  // still raise the requirement-weakening escalation the engine records for any narrowing.
  // `answers` binds a widening to the worker scope request it answers (GY-176): the engine applies
  // it only while that request is open and its attempt holds the lease, in the same transaction.
  requirements: z.object({ expectedPolicyRevision: revision, criteria: z.array(criterionSchema).min(1).max(50), dependencies: z.array(z.string().uuid()).max(50), plannedFiles: createSchema.shape.plannedFiles, exclusiveResources: resourcesSchema, producerProofs: createSchema.shape.producerProofs,
    answers: z.object({ epoch: revision, at: z.iso.datetime(), sha: sha.nullable().optional() }).strict().optional() }).strict(),
  resolve: z.object({ trigger: z.enum(escalationTriggers), expectedRevision: revision }).strict(),
  attest: z.object({ proof: proofSchema.refine(proof => proof.startsWith('manual:'), 'Only manual: proofs are attested; automated proofs come from producers'), sha, baseSha: sha, policyRevision: revision, result: z.enum(['pass', 'fail']), executed: z.number().int().min(0), skipped: z.number().int().min(0), url: z.url().max(2000).optional(), exercise: proofExerciseSchema.optional() }).strict(),
  merge: z.object({ sha, baseSha: sha, policyRevision: revision }).strict(),
  // Both carry the requester's attestation that the previous worker is stopped, and the grounds
  // binding the request judges (GY-407): the refusal match compares inputs, so a refusal bars
  // only the same head, base and grounds, never another ground on the same head.
  rework: z.object({ previousWorkerStopped: z.literal(true), binding: groundsBinding.optional() }).strict(),
  recover: z.object({ previousWorkerStopped: z.literal(true), binding: groundsBinding.optional() }).strict(),
  grant: z.object({ principal: principalId, patterns: z.array(z.string().min(1).max(200)).min(1).max(50), expectedRevision: z.number().int().min(0).optional() }).strict(),
  // Head-bound: the repair lane merges exactly this head (expectedHeadOid) and nothing else.
  'repair-merge': z.object({ sha }).strict(),
} satisfies Record<DecisionAction, z.ZodType>;
const reason = z.string().trim().min(1).max(2000);
/**
 * A request may cite the precedent it follows and the fingerprint of the assembled escalation
 * context it judged from (model/escalation-context.ts). Both are recorded with the request so a
 * later handler can follow the same line; a second request that cites the same precedent while
 * the first still stands is recorded as a concurrence with it rather than refused as a duplicate.
 */
export const decisionPrecedentSchema = z.array(z.string().uuid()).max(20);
export const decisionContextSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const decisionRequestSchema = z.object({ action: z.enum(decisionActions), input: z.unknown(), reason, precedent: decisionPrecedentSchema.optional(), context: decisionContextSchema.optional() }).strict();
export const decisionApprovalSchema = z.object({ decision: z.string().uuid(), reason }).strict();
/** The approver's other answer: `{ action: 'refuse', decision, reason }` on the approve route. */
export const decisionRefusalSchema = z.object({ action: z.literal('refuse'), decision: z.string().uuid(), reason }).strict();

/**
 * `refused` is the approver's considered decline (`decision.declined`): terminal, carrying who
 * refused, why and when. It is distinct from `refusals`, the conflicted approvals the server
 * turned away, and from a decision still `requested` because no session ever judged it.
 */
export type DecisionState = 'requested' | 'approved' | 'applied' | 'failed' | 'refused';
export interface Decision {
  id: string; workId: string; action: DecisionAction; input: any; reason: string;
  requestedBy: string; requestedAt: string; state: DecisionState;
  approvedBy: string | null; approvedAt: string | null; approvalReason: string | null;
  outcome: string | null; refusals: { approver: string; conflict: string; at: string }[];
  /** The approver's recorded decline, when the decision ended `refused`. */
  refusal: { approver: string; reason: string; at: string } | null;
  /** The decisions the requester cited and the context fingerprint it judged from; empty and null for a request that named none. */
  precedent: string[]; context: string | null;
  /** For a request that cited nothing: whether any applied decision of its action (and trigger) was available to cite (GY-138). */
  noPrecedent: string | null;
  /** Later requesters that followed the same precedent while this decision stood. */
  concurrences: { requester: string; reason: string; precedent: string[]; context: string | null; at: string }[];
  /** For a rework or recover request, the candidate it was requested against (GY-229); null otherwise and for requests recorded before it was kept. */
  situation?: DecisionSituation | null;
}
/**
 * What a rework or recover request judged: the item's candidate head and the base it was built
 * on when the request was made; the grounds it judges travel in the request's `binding` input
 * (GY-407). The server records both with the request, and a refusal stands only against a request
 * made for the same pair and the same grounds (GY-229, GY-407): their input is otherwise the bare
 * attestation `{ previousWorkerStopped: true }`, identical for every request on the item.
 */
export interface DecisionSituation { sha: string | null; baseSha: string | null }
export const situatedDecisionActions: readonly DecisionAction[] = ['rework', 'recover'];
export const decisionSituation = (action: string, work: Pick<Work, 'candidate'>): DecisionSituation | null =>
  situatedDecisionActions.includes(action as DecisionAction) ? { sha: work.candidate?.sha ?? null, baseSha: work.candidate?.baseSha ?? null } : null;
const sameSituation = (recorded: DecisionSituation | null | undefined, current: DecisionSituation | null | undefined) =>
  !recorded || ((recorded.sha ?? null) === (current?.sha ?? null) && (recorded.baseSha ?? null) === (current?.baseSha ?? null));
/**
 * Whether a refused decision judged the same situation as a new request. Only rework and recover
 * are situated; any other action's input already names what it binds. For a situated action the
 * grounds binding is part of that input (GY-407), so a refusal on one ground never matches a
 * request whose binding differs, whatever the head. A refusal recorded before situations were
 * kept judged a candidate nobody can name any more, so it still stands against every request
 * whose input it shares — today, one that names no binding — until one cites it, as it always
 * did; the loop cites it with its new grounds.
 */
const judgedSame = (action: DecisionAction, decision: { situation?: DecisionSituation | null }, situation: DecisionSituation | null | undefined) =>
  !situatedDecisionActions.includes(action) || sameSituation(decision.situation, situation);
export interface DecisionEvent { kind: string; actor: string; at: string; payload: any }

/** Rebuild every decision on an item from its append-only ledger entries, oldest first. */
export function foldDecisions(workId: string, events: DecisionEvent[]): Decision[] {
  const decisions = new Map<string, Decision>();
  for (const event of events) {
    const details = event.payload ?? {};
    if (event.kind === 'decision.requested') {
      decisions.set(details.id, { id: details.id, workId, action: details.action, input: details.input, reason: details.reason, requestedBy: event.actor, requestedAt: event.at, state: 'requested',
        approvedBy: null, approvedAt: null, approvalReason: null, outcome: null, refusals: [], refusal: null,
        precedent: Array.isArray(details.precedent) ? [...details.precedent] : [], context: typeof details.context === 'string' ? details.context : null, noPrecedent: typeof details.noPrecedent === 'string' ? details.noPrecedent : null, concurrences: [],
        situation: details.situation && typeof details.situation === 'object' ? { sha: details.situation.sha ?? null, baseSha: details.situation.baseSha ?? null } : null });
      continue;
    }
    const decision = decisions.get(details.id);
    if (!decision) continue;
    if (event.kind === 'decision.concurred') decision.concurrences.push({ requester: event.actor, reason: details.reason, precedent: Array.isArray(details.precedent) ? [...details.precedent] : [], context: typeof details.context === 'string' ? details.context : null, at: event.at });
    if (event.kind === 'decision.refused') decision.refusals.push({ approver: event.actor, conflict: details.conflict, at: event.at });
    if (event.kind === 'decision.declined') Object.assign(decision, { state: 'refused', outcome: details.reason ?? null, refusal: { approver: event.actor, reason: details.reason, at: event.at } });
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
  if (decision.action === 'attest' || decision.action === 'merge' || decision.action === 'repair-merge') {
    const own = work.evidence.filter(item => item.producer === approver.id && (decision.action !== 'attest' || item.proof === decision.input.proof));
    if (own.length) return `Conflicted approval refused: ${approver.id} produced evidence ${[...new Set(own.map(item => item.proof))].join(', ')} on ${work.key} and may not approve its own evidence`;
  }
  if (decision.action === 'grant' && decision.input.principal === approver.id)
    return `Conflicted approval refused: ${approver.id} is the principal this grant would authorize`;
  return null;
}

/**
 * The refusal a new request would repeat, or null. A request of the same action and input as a
 * decision an approver refused is accepted only when it answers that refusal: its reason, or its
 * precedent list, names the refused decision's id, and its reason is not the one the refused
 * request already gave. Answering a refusal also answers every refusal that refused request itself
 * cited: it was accepted only by answering them, so a request cites the newest refusals and the
 * chain carries the rest — a history of refusals never outgrows the reason bound (GY-163). Anything
 * else is the same unjustified request retried, and it is refused naming the prior refusal.
 * A rework or recover refusal judged one candidate and base (`situation`, GY-229) and the grounds
 * binding its request named (`binding`, GY-407): a request made for another candidate or base is
 * a new request, not a retry, and one whose binding differs names grounds the refusal never
 * judged, so neither is barred by it whatever the rest of its input.
 */
export function unansweredRefusal(decisions: (Pick<Decision, 'id' | 'action' | 'input' | 'reason' | 'refusal'> & { state: string; precedent?: string[]; situation?: DecisionSituation | null })[], action: DecisionAction, input: unknown, reason: string, same: (a: unknown, b: unknown) => boolean, precedent: string[] = [], situation?: DecisionSituation | null): string | null {
  const refused = decisions.filter(decision => decision.state === 'refused' && decision.action === action && same(decision.input, input) && judgedSame(action, decision, situation));
  const bare = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const names = (text: string, cited: string[], id: string) => text.includes(id) || cited.includes(id);
  // Whatever else it cites, a request whose reason is a refused request's own reason repeats it.
  const repeats = (decision: { id: string; reason: string }) => bare(reason.split(decision.id).join(' ')) === bare(decision.reason);
  const answered = new Set(refused.filter(decision => names(reason, precedent, decision.id) && !repeats(decision)).map(decision => decision.id));
  for (let grew = true; grew;) {
    grew = false;
    for (const decision of refused) {
      if (answered.has(decision.id) || repeats(decision)) continue;
      if (refused.some(later => answered.has(later.id) && names(later.reason, later.precedent ?? [], decision.id))) { answered.add(decision.id); grew = true; }
    }
  }
  const standing = refused.find(decision => !answered.has(decision.id));
  return standing ? `Decision ${standing.id} (${action}) with this input${situation?.sha ? ` for candidate ${situation.sha.slice(0, 12)} on base ${String(situation.baseSha).slice(0, 12)}` : ''} was refused by ${standing.refusal?.approver ?? 'its approver'}: ${standing.refusal?.reason ?? standing.reason}. An identical request is refused; answer the refusal with a new request whose reason cites ${standing.id} and gives what the refused request lacked` : null;
}

/**
 * The refusals a new request must cite itself: those no other refused request of the same action
 * and input already cited. Citing these answers the rest through the chain `unansweredRefusal`
 * follows. Newest first, as the history lists them. Only refusals of the same situation count: one
 * judged for another candidate or base, or on other grounds than the request's binding names
 * (GY-407), does not stand against the request.
 */
export function uncitedRefusals(decisions: { id: string; action: string; input: unknown; reason: string; state: string; precedent?: string[]; situation?: DecisionSituation | null }[], action: DecisionAction, input: unknown, same: (a: unknown, b: unknown) => boolean, situation?: DecisionSituation | null): string[] {
  const refused = decisions.filter(decision => decision.state === 'refused' && decision.action === action && same(decision.input, input) && judgedSame(action, decision, situation));
  return refused.filter(decision => !refused.some(other => other.id !== decision.id && (other.reason.includes(decision.id) || (other.precedent ?? []).includes(decision.id)))).map(decision => decision.id);
}

/**
 * Every capability a request needs: the action's own, plus `policy:bootstrap` for a requirements
 * revision that declares or changes a bootstrap deferral, exactly as the direct command demands.
 */
export function requiredDecisionCapabilities(action: DecisionAction, input: any, work: Work): OperatorCapability[] {
  const capabilities = [decisionCapabilities[action]];
  if (action === 'requirements' && input.criteria.some((criterion: any) => criterion.bootstrap
    && JSON.stringify(work.criteria.find(existing => existing.id === criterion.id)?.bootstrap ?? null) !== JSON.stringify(criterion.bootstrap))) capabilities.push('policy:bootstrap');
  return capabilities;
}

/** The item must still be in the state the decision was requested against. */
export function decisionPrecondition(action: DecisionAction, input: any, work: Work): string | null {
  if (action === 'recover') return work.stage === 'done' && work.containmentQuarantine ? null : 'Containment recovery applies to delivered work that is still quarantined';
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
  if (action === 'repair-merge') {
    if (work.repair !== 'merge-path') return `${work.key} does not carry "repair": "merge-path"; only a merge-path repair item may use the repair lane`;
    if (!work.candidate || work.candidate.sha !== input.sha) return `The decision names ${String(input.sha).slice(0, 12)} but the current candidate is ${work.candidate?.sha.slice(0, 12) ?? 'none'}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Decisions no pair of agent identities can complete (GY-102).
//
// Almost every two-party decision above is settled by agents alone: one agent identity requests
// it, a second independent one approves it, and the control plane applies it. One is not. A
// post-merge `merge` decision whose reason cites a reconciliation the record refused is an
// override of the record itself, and the control plane delivers such a merge only when an admin
// credential — the operator's own, not the master's agent pair — stands on one side of the
// decision (engine.ts `operatorAuthorizing`). Approved by two agent identities it applies and
// then delivers nothing: the next observation records a second refusal naming exactly that.
//
// Stating the requirement here is what lets the human surface list such an approval as a request
// only the operator can answer (model/human-request.ts), instead of leaving it to be discovered
// by a delivery that refuses. tests/human-only-surface.test.ts pins this rule to the refusal the
// engine actually records, so the two cannot drift apart.
// ---------------------------------------------------------------------------

/** The role the operator's own credential carries; every agent identity the master runs is an `operator-agent`. */
export const operatorCredentialRole = 'admin';
/** One side of a decision, as the ledger recorded it: an identity and the role it held. */
export interface DecisionParty { id?: string; role?: string | null }
/** Why this identity cannot stand as the operator on a decision that needs one, or null when it can. */
export const operatorCredentialRefusal = (party: DecisionParty): string | null => party.role === operatorCredentialRole ? null
  : `an operator-authorized delivery needs an admin credential as requester or approver; ${party.id ?? 'this session'} is ${party.role ?? 'of unrecorded role'}`;

/**
 * The refused reconciliations an item carries, newest violation last, as the engine wrote them:
 * `<reconciliationRefusalPrefix><decision id> refused: <reasons>`.
 */
export const refusedReconciliations = (work: Pick<Work, 'violations'>) => work.violations
  .filter(entry => entry.startsWith(reconciliationRefusalPrefix))
  .map(entry => entry.slice(reconciliationRefusalPrefix.length).split(' ')[0]);

/**
 * The decision's own party requirement, or null when any independent agent identity may complete
 * it: a merge decision that cites one of this item's refused reconciliations needs the operator's
 * admin credential, and names the refusal it overrides.
 */
export function operatorOnlyDecision(decision: Pick<Decision, 'action' | 'reason'>, work: Pick<Work, 'key' | 'violations'>): { overrides: string; needed: string } | null {
  if (decision.action !== 'merge') return null;
  const overrides = refusedReconciliations(work).find(id => decision.reason.includes(id));
  return overrides ? { overrides, needed: `Authorize the delivery of ${work.key}, overriding refused reconciliation ${overrides}` } : null;
}
