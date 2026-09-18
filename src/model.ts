import { z } from 'zod';

export const stages = ['backlog', 'ready', 'build', 'review', 'test', 'acceptance', 'merge', 'done'] as const;
export type Stage = typeof stages[number];
export const proofSchema = z.string().regex(/^(unit|integration|e2e|manual):[a-zA-Z0-9._/-]+$/);
export const criterionSchema = z.object({ id: z.string().regex(/^AC-\d+$/), text: z.string().min(1).max(2000), proofs: z.array(proofSchema).min(1).max(20) }).strict();
export const policySchema = z.object({
  checks: z.array(z.string().min(1).max(200)).min(1).max(30).default(['test', 'typecheck']),
  review: z.boolean().default(true),
  reviewProvider: z.enum(['github', 'codex']).optional(),
}).strict();
export const resourcesSchema = z.array(z.string().regex(/^[a-z0-9][a-z0-9._:/-]*$/).max(200)).max(30).refine(v => new Set(v).size === v.length, 'Resource names must be unique');
export const sliceIds = ['product', 'infrastructure', 'docs-experience'] as const;
export type SliceId = typeof sliceIds[number];
export const escalationTriggers = ['lease-loss', 'evidence-policy-conflict', 'security-concern', 'requirement-weakening'] as const;
export type EscalationTrigger = typeof escalationTriggers[number];
export const createSchema = z.object({
  title: z.string().min(1).max(200), description: z.string().max(20000).default(''),
  type: z.enum(['feature', 'bug', 'chore']).default('feature'),
  priority: z.number().int().min(0).max(4).default(2),
  dependencies: z.array(z.string().uuid()).max(50).default([]),
  criteria: z.array(criterionSchema).min(1).max(50),
  policy: policySchema.default({ checks: ['test', 'typecheck'], review: true }),
  plannedFiles: z.array(z.string().min(1).max(500)).max(100).default([]),
  exclusiveResources: resourcesSchema.optional(),
  slice: z.enum(sliceIds).optional(),
}).strict();
export type Create = z.infer<typeof createSchema>;
export const operatorCapabilities = ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements', 'policy:review-provider'] as const;
export type OperatorCapability = typeof operatorCapabilities[number];
export const operatorCredentialHash = Symbol('operatorCredentialHash');
export interface Principal {
  id: string; role: 'admin' | 'operator-agent' | 'coordinator' | 'slice-lead' | 'worker' | 'producer' | 'reader';
  proofs?: string[]; displayName?: string; runtime?: string;
  slice?: SliceId; sessionKind?: 'human' | 'ai';
  capabilities?: OperatorCapability[];
  scope?: { repositories: string[]; workItems: string[] };
  [operatorCredentialHash]?: string;
}
export interface AssignmentIdentity { owner: string; epoch: number; displayName?: string; runtime?: string; claimedAt?: string }
export interface Lease { owner: string; epoch: number; expiresAt: string }
export interface Workspace { host: string; path: string; branch: string; epoch: number; owner: string }
export interface Candidate { sha: string; baseSha: string; pr: number; branch: string; author: string }
export interface Evidence {
  id: string; proof: string; sha: string; baseSha: string; policyRevision: number;
  producer: string; trusted: boolean; result: 'pass' | 'fail';
  executed: number; skipped: number; url?: string; at: string; expiresAt?: string;
  scenarioRevision?: number; environment?: string;
  validation?: { candidateId: string; requestId: string; attemptId: string };
}
export interface ReviewRequest { commentId: number; sha: string; baseSha: string; policyRevision: number; body: string; createdAt: string }
export interface AgentReview { provider: 'codex'; sha: string; approved: boolean; reason: string; summaryId?: number; resultId?: number; requestId?: number; reactionId?: number; completedAt?: string }
export interface Observation {
  clockOffset?: { min: number; max: number };
  reviewIds?: number[];
  agentReview?: AgentReview;
  prState?: 'open' | 'closed'; draft?: boolean;
  candidate: Candidate; checks: { name: string; result: string; appId: number }[];
  reviews: { reviewer: string; sha: string; state: string; id?: number; submittedAt?: string }[];
  merged: boolean; mergeSha: string | null; mergedAt?: string | null; mergeable: boolean;
  protected: boolean; files: string[]; at: string;
}
export interface Gate { name: string; passed: boolean; reasons: string[] }
export interface Escalation { trigger: EscalationTrigger; reason: string; at: string; actor: string }
export interface Work extends Create {
  validation?: Record<string, { candidateId: string; requestId?: string; attemptId?: string }>;
  retiredCriterionIds?: string[];
  formalReviewResetRequired?: boolean;
  formalReviewBaseline?: { pr: number; policyRevision: number; reviewIds: number[] };
  // Append-only identities that have held an assignment. Trusted proof producers
  // must stay independent of every one of them, not only the latest assignment.
  implementers?: string[];
  id: string; key: string; stage: Stage; revision: number; policyRevision: number;
  createdAt: string; updatedAt: string; stageEnteredAt: string; ready: boolean;
  epoch: number; lease: Lease | null; lastAssignment?: AssignmentIdentity; workspaces: Workspace[]; candidate: Candidate | null;
  containmentQuarantine?: { owner: string; epoch: number; at: string; settlementHash: string; launchAcknowledgedAt?: string; launchExpiresAt?: string } | null;
  submission: { epoch: number; pr: number } | null;
  reworkRequested: boolean;
  scenarioRequirements: { proof: string; revision: number; environment: string; hash: string }[];
  reviewRequest?: ReviewRequest | null;
  mergeAuthorization?: { sha: string; baseSha: string; policyRevision: number; at: string } | null;
  mergeExecution?: { id: string; owner: string; sha: string; baseSha: string; policyRevision: number; authorizationRevision: number; issuedAt: string; expiresAt: string; verifiedAt?: string; clockOffset?: { min: number; max: number }; fenced?: { reason: string; at: string } | null } | null;
  delivery?: { mergedAt: string; mergeSha: string; authorizationRevision: number };
  evidence: Evidence[]; observation: Observation | null; blocker: string | null;
  // `escalations` is the source of truth: every distinct unresolved trigger
  // stands until it is individually resolved. `escalation` mirrors the oldest
  // one so legacy documents and readers keep working.
  escalation?: Escalation | null;
  escalations?: Escalation[];
  // Durable state for a blocking lead ruling. History records the ruling; this
  // field is what the gate evaluator and the merge broker read independently.
  leadHold?: { action: BlockingRulingAction; rulingId: string; leadId: string; slice: SliceId; ruleId: string; reason: string; at: string } | null;
  gates: Gate[]; violations: string[];
}
export class Refusal extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
export class ReconciliationRetry extends Refusal {}
export class MergeExecutionInProgress extends ReconciliationRetry {}
export function requireCurrent(value: unknown, message: string): asserts value {
  if (!value) throw new ReconciliationRetry(message, 409);
}
export function demand(value: unknown, message: string, status = 409): asserts value {
  if (!value) throw new Refusal(message, status);
}
export function admin(actor: Principal) { demand(actor.role === 'admin', 'Operator permission required', 403); }
// One scope rule for every scoped read and mutation, so a route cannot answer
// with data its own authorization would have refused.
export function operatorScopeIncludes(actor: Principal, work: { id: string; key: string }) {
  if (actor.role !== 'operator-agent') return true;
  return !!actor.scope?.workItems.some(entry => entry === '*' || entry === work.id || entry === work.key);
}
export function operatorCapability(actor: Principal, capability: OperatorCapability, work?: Work, repository?: string) {
  if (actor.role === 'admin') return;
  demand(actor.role === 'operator-agent' && actor.capabilities?.includes(capability), `Capability ${capability} is required`, 403);
  demand(!!repository && actor.scope?.repositories.includes(repository), 'Repository is outside this operator-agent scope', 403);
  if (work) demand(operatorScopeIncludes(actor, work), 'Work item is outside this operator-agent scope', 403);
}
export function activeLease(work: Work, actor: Principal, epoch: number, now: Date) {
  demand(work.lease && work.lease.owner === actor.id && work.lease.epoch === epoch && Date.parse(work.lease.expiresAt) > now.getTime(), 'Lease missing, expired, or superseded; claim the task again');
}

// Every unresolved trigger stands on its own. A document written before
// `escalations` existed carries only the singular field, so it is read as a
// one-entry list rather than migrated in place.
export function standingEscalations(work: Work): Escalation[] {
  if (work.escalations) return work.escalations;
  return work.escalation ? [work.escalation] : [];
}
function setEscalations(work: Work, escalations: Escalation[]) {
  work.escalations = escalations;
  work.escalation = escalations[0] ?? null;
}
// An unresolved escalation refuses delivery. Only a human operator can resolve
// one, so no lead or automated path can deliver past it.
export function escalationRefusals(work: Work): string[] {
  return standingEscalations(work).map(entry => `Unresolved ${entry.trigger} escalation requires operator resolution: ${entry.reason}`);
}
export function escalationRefusal(work: Work): string | null { return escalationRefusals(work)[0] ?? null; }
// A standing escalation is never overwritten, and a later distinct trigger never
// disappears behind it: each trigger is kept until it is resolved on its own, so
// resolving one concern cannot silently drop another. Raising one refuses the
// merge gate, invalidates merge authorization, and fences any in-flight merge
// execution in the same transaction, so a candidate that was already merge-ready
// cannot be delivered while it stands.
export function raiseEscalation(work: Work, escalation: Escalation) {
  const standing = standingEscalations(work);
  // One entry per trigger: a repeat of a trigger that already stands is history,
  // not a second incident, and resolution names a trigger.
  if (standing.some(entry => entry.trigger === escalation.trigger)) return false;
  setEscalations(work, [...standing, escalation]);
  work.mergeAuthorization = null;
  fenceMergeExecution(work, `Unresolved ${escalation.trigger} escalation: ${escalation.reason}`, escalation.at);
  const merge = work.gates.find(gate => gate.name === 'merge');
  if (merge) for (const reason of escalationRefusals(work)) if (!merge.reasons.includes(reason)) { merge.reasons.push(reason); merge.passed = false; }
  return true;
}
// Resolving names one standing trigger and leaves every other one standing.
export function resolveEscalation(work: Work, trigger: EscalationTrigger) {
  const standing = standingEscalations(work);
  const remaining = standing.filter(entry => entry.trigger !== trigger);
  setEscalations(work, remaining);
  return standing.length - remaining.length;
}
// Fencing, not cancelling: the execution row stays so its owner can still cancel
// or observe it idempotently, but no verification and no provider call may
// proceed under it. The broker re-reads this between verification and the merge
// call, so a concern raised mid-flight still stops delivery.
export function fenceMergeExecution(work: Work, reason: string, at: string) {
  if (!work.mergeExecution || work.mergeExecution.fenced) return false;
  work.mergeExecution.fenced = { reason, at };
  return true;
}

// Rulings that stop delivery until an authorized recovery clears them. A plan
// rejection is superseded by a later approve-plan from the same slice lead; a
// send-back is cleared only by the operator rework lifecycle, which reopens
// implementation. Ranked so a later ruling can raise, but never weaken, a hold.
export const blockingRulingActions = ['reject-plan', 'send-back'] as const;
export type BlockingRulingAction = typeof blockingRulingActions[number];
export const blockingRulingRank: Record<BlockingRulingAction, number> = { 'reject-plan': 1, 'send-back': 2 };
export function leadHoldRefusal(work: Work): string | null {
  return work.leadHold
    ? `Slice lead ${work.leadHold.leadId} ruled ${work.leadHold.action} under rule ${work.leadHold.ruleId}; delivery is blocked until the authorized recovery: ${work.leadHold.reason}`
    : null;
}
// Applied inside the ruling transaction: the hold is recorded, merge
// authorization is invalidated, and the merge gate refuses in the same write.
export function holdDelivery(work: Work, hold: NonNullable<Work['leadHold']>) {
  const standing = work.leadHold;
  // A ruling may strengthen a standing hold, but it cannot replace an
  // equal-ranked hold and thereby transfer that hold's recovery authority to a
  // different lead. The later ruling remains in append-only history.
  if (standing && blockingRulingRank[standing.action] >= blockingRulingRank[hold.action]) return false;
  const superseded = leadHoldRefusal(work);
  work.leadHold = hold;
  work.mergeAuthorization = null;
  fenceMergeExecution(work, `Slice lead ${hold.leadId} ruled ${hold.action} under rule ${hold.ruleId}`, hold.at);
  const merge = work.gates.find(gate => gate.name === 'merge');
  const reason = leadHoldRefusal(work)!;
  if (merge) {
    merge.reasons = merge.reasons.filter(entry => entry !== superseded && entry !== reason);
    merge.reasons.push(reason);
    merge.passed = false;
  }
  return true;
}
// Clearing a hold removes its refusal from the merge gate. Merge authorization is
// not reissued here: only a full gate evaluation may mint it, so the recovery is
// fail-closed until the next evaluation confirms every other gate still passes.
export function releaseLeadHold(work: Work) {
  const reason = leadHoldRefusal(work);
  work.leadHold = null;
  const merge = work.gates.find(gate => gate.name === 'merge');
  if (!reason || !merge) return;
  merge.reasons = merge.reasons.filter(entry => entry !== reason);
  merge.passed = merge.reasons.length === 0;
}

// Every identity that has held an assignment on this item, including superseded
// epochs and legacy documents that predate the append-only list.
export function implementerIdentities(work: Work): string[] {
  return [...new Set([
    ...(work.implementers ?? []),
    ...work.workspaces.map(workspace => workspace.owner),
    ...(work.lastAssignment ? [work.lastAssignment.owner] : []),
    ...(work.lease ? [work.lease.owner] : []),
  ])];
}

// AC-4 independence is a standing property, not a submission-time check. The
// implementer set is append-only, so trusted evidence whose producer later takes
// an assignment stops being applicable, without any history being rewritten. The
// loss is reported only for proofs no still-independent producer has re-proved,
// so re-proving the same candidate remains possible.
export function evidenceIndependenceRefusals(work: Work, now = new Date()): string[] {
  const implementers = implementerIdentities(work);
  const refusals: string[] = [];
  for (const proof of new Set(work.criteria.flatMap(criterion => criterion.proofs))) {
    if (currentEvidence(work, proof, now)) continue;
    const superseded = work.evidence.filter(evidence => evidence.proof === proof && evidence.trusted && implementers.includes(evidence.producer)
      && !!work.candidate && evidence.sha === work.candidate.sha && evidence.baseSha === work.candidate.baseSha && evidence.policyRevision === work.policyRevision);
    for (const producer of new Set(superseded.map(evidence => evidence.producer)))
      refusals.push(`Trusted ${proof} evidence from ${producer} is no longer independent: ${producer} has since held an assignment on ${work.key}`);
  }
  return refusals;
}

// Shared by gates and human-facing proof previews.
export function currentEvidence(work: Work, proof: string, now = new Date()): Evidence | undefined {
  const scenario = work.scenarioRequirements?.find(s => s.proof === proof);
  const validation = work.validation?.[proof];
  const implementers = implementerIdentities(work);
  const latest = work.evidence.filter(e => e.proof === proof && e.trusted && !implementers.includes(e.producer) && e.sha === work.candidate?.sha && e.baseSha === work.candidate?.baseSha && e.policyRevision === work.policyRevision
    && (!validation || !!validation.attemptId && e.validation?.candidateId === validation.candidateId && e.validation?.requestId === validation.requestId && e.validation?.attemptId === validation.attemptId)
    && (!scenario || e.scenarioRevision === scenario.revision && e.environment === scenario.environment)).at(-1);
  return latest && (!latest.expiresAt || Date.parse(latest.expiresAt) > now.getTime()) ? latest : undefined;
}

// Pure evaluation: neither worker assertions nor UI state can authorize progression.
export function evaluate(work: Work, all: Work[], now: Date, ciAppIds: number[]): { stage: Stage; gates: Gate[]; violations: string[] } {
  const gates: Gate[] = [];
  const add = (name: string, reasons: string[]) => gates.push({ name, passed: reasons.length === 0, reasons });
  const dependencies = work.dependencies.filter(id => all.find(w => w.id === id)?.stage !== 'done');
  add('ready', [...(!work.ready ? ['Not released from backlog'] : []), ...dependencies.map(id => `Dependency ${all.find(w => w.id === id)?.key ?? id} is unfinished`), ...(work.blocker ? [work.blocker] : [])]);
  const candidate = work.candidate;
  const obs = work.observation;
  const current = !!candidate && !!obs && obs.candidate.sha === candidate.sha && obs.candidate.baseSha === candidate.baseSha;
  const fresh = current && now.getTime() - Date.parse(obs!.at) < 120_000;
  add('build', [...(!work.submission || work.reworkRequested ? ['Worker has not submitted implementation for this attempt'] : []), ...(!candidate ? ['Pull request has not been independently observed'] : []), ...(!work.workspaces.length ? ['No workspace registered'] : [])]);
  const reviews = current ? obs!.reviews : [];
  const changesRequested = reviews.some(r => r.state === 'CHANGES_REQUESTED');
  const agentReview = current ? obs!.agentReview : undefined;
  const reviewPassed = work.policy.reviewProvider === 'codex'
    ? !!candidate && !!agentReview?.approved && agentReview.provider === 'codex' && agentReview.sha === candidate.sha && work.reviewRequest?.commentId === agentReview.requestId && work.reviewRequest?.sha === candidate.sha && work.reviewRequest?.baseSha === candidate.baseSha && work.reviewRequest?.policyRevision === work.policyRevision
    : !!candidate && reviews.some(r => r.sha === candidate.sha && r.state === 'APPROVED' && r.reviewer !== candidate.author
      && (!work.formalReviewResetRequired || work.formalReviewBaseline?.pr === candidate.pr && work.formalReviewBaseline.policyRevision === work.policyRevision && Number.isSafeInteger(r.id) && r.id! > 0 && !work.formalReviewBaseline.reviewIds.includes(r.id!)));
  add('review', work.policy.review ? [
    ...(!reviewPassed ? [work.policy.reviewProvider === 'codex' ? agentReview?.reason ?? 'Verified clean Codex review of the current commit is required' : work.formalReviewResetRequired ? 'A new independent GitHub approval after the requirement-review baseline is required' : 'Independent approval of the current commit is required'] : []),
    ...(changesRequested ? ['Outstanding change requests must be resolved through a new review'] : []),
  ] : []);
  add('test', work.policy.checks.filter(name => {
    const checks = current ? obs!.checks.filter(c => c.name === name && ciAppIds.includes(c.appId)) : [];
    return !checks.length || checks.some(c => c.result !== 'success');
  }).map(name => `Required CI check ${name} has not passed on the current candidate`));
  const reasons: string[] = [];
  for (const ac of work.criteria) for (const proof of ac.proofs) {
    const scenario = work.scenarioRequirements?.find(s => s.proof === proof);
    const evidence = currentEvidence(work, proof, now);
    if (!evidence || evidence.result !== 'pass' || evidence.executed < 1 || evidence.skipped !== 0) reasons.push(`${ac.id}: ${proof} needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy${scenario ? `; scenario v${scenario.revision} in ${scenario.environment}` : ''}`);
  }
  // Independence is re-decided on every evaluation, so evidence minted before its
  // producer joined the implementer set refuses acceptance with a named reason.
  reasons.push(...evidenceIndependenceRefusals(work, now));
  add('acceptance', reasons);
  add('merge', [...(!fresh ? ['GitHub observation missing or older than two minutes'] : []), ...(!obs?.protected ? ['Required Graphyard check and strict branch protection have not been verified'] : []), ...(!obs?.mergeable && !obs?.merged ? ['Pull request is not mergeable against the current base'] : []), ...escalationRefusals(work), ...(leadHoldRefusal(work) ? [leadHoldRefusal(work)!] : [])]);
  const first = gates.find(g => !g.passed);
  const violations = [...work.violations];
  let stage: Stage = !work.ready ? 'backlog' : !work.submission ? (work.lease && Date.parse(work.lease.expiresAt) > now.getTime() ? 'build' : 'ready') : (first?.name === 'ready' ? 'build' : first?.name as Stage ?? 'merge');
  // Delivery history stays complete; later observations cannot rewrite it.
  if (work.stage === 'done') stage = 'done';
  return { stage, gates, violations };
}
