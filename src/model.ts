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
export const createSchema = z.object({
  title: z.string().min(1).max(200), description: z.string().max(20000).default(''),
  type: z.enum(['feature', 'bug', 'chore']).default('feature'),
  priority: z.number().int().min(0).max(4).default(2),
  dependencies: z.array(z.string().uuid()).max(50).default([]),
  criteria: z.array(criterionSchema).min(1).max(50),
  policy: policySchema.default({ checks: ['test', 'typecheck'], review: true }),
  plannedFiles: z.array(z.string().min(1).max(500)).max(100).default([]),
  exclusiveResources: resourcesSchema.optional(),
}).strict();
export type Create = z.infer<typeof createSchema>;
export const operatorCapabilities = ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements', 'policy:review-provider'] as const;
export type OperatorCapability = typeof operatorCapabilities[number];
export const operatorCredentialHash = Symbol('operatorCredentialHash');
export interface Principal {
  id: string; role: 'admin' | 'operator-agent' | 'coordinator' | 'worker' | 'producer' | 'reader';
  proofs?: string[]; displayName?: string; runtime?: string;
  capabilities?: OperatorCapability[];
  scope?: { repositories: string[]; workItems: string[] };
  [operatorCredentialHash]?: string;
}
export interface AssignmentIdentity { owner: string; epoch: number; displayName?: string; runtime?: string; claimedAt?: string }
export interface Lease { owner: string; epoch: number; expiresAt: string }
export interface Workspace { host: string; path: string; branch: string; epoch: number; owner: string }
export interface Candidate { sha: string; baseSha: string; pr: number; branch: string; author: string }
export type ArtifactKind = 'log' | 'report' | 'screenshot' | 'trace' | 'other';
export type ArtifactAvailability = 'available' | 'expired' | 'redacted' | 'missing' | 'external';
export interface EvidenceArtifact {
  kind: ArtifactKind; label: string; mediaType?: string; size?: number; digest?: string;
  expiresAt?: string; availability: ArtifactAvailability;
  /** Public location. External locations are never treated as trusted proof. */
  url?: string;
  /** Authenticated Graphyard route components; never contains a bearer credential. */
  reference?: { requestId: string; artifactId: string };
}
export interface Evidence {
  id: string; proof: string; sha: string; baseSha: string; policyRevision: number;
  producer: string; trusted: boolean; result: 'pass' | 'fail';
  executed: number; skipped: number; url?: string; at: string; expiresAt?: string;
  artifacts?: EvidenceArtifact[];
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
export interface Work extends Create {
  validation?: Record<string, { candidateId: string; requestId?: string; attemptId?: string }>;
  retiredCriterionIds?: string[];
  formalReviewResetRequired?: boolean;
  formalReviewBaseline?: { pr: number; policyRevision: number; reviewIds: number[] };
  id: string; key: string; stage: Stage; revision: number; policyRevision: number;
  createdAt: string; updatedAt: string; stageEnteredAt: string; ready: boolean;
  epoch: number; lease: Lease | null; lastAssignment?: AssignmentIdentity; workspaces: Workspace[]; candidate: Candidate | null;
  containmentQuarantine?: { owner: string; epoch: number; at: string; settlementHash: string; launchAcknowledgedAt?: string; launchExpiresAt?: string } | null;
  submission: { epoch: number; pr: number } | null;
  reworkRequested: boolean;
  scenarioRequirements: { proof: string; revision: number; environment: string; hash: string }[];
  reviewRequest?: ReviewRequest | null;
  mergeAuthorization?: { sha: string; baseSha: string; policyRevision: number; at: string } | null;
  mergeExecution?: { id: string; owner: string; sha: string; baseSha: string; policyRevision: number; authorizationRevision: number; issuedAt: string; expiresAt: string; verifiedAt?: string; clockOffset?: { min: number; max: number } } | null;
  delivery?: { mergedAt: string; mergeSha: string; authorizationRevision: number };
  evidence: Evidence[]; observation: Observation | null; blocker: string | null;
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
export function operatorCapability(actor: Principal, capability: OperatorCapability, work?: Work, repository?: string) {
  if (actor.role === 'admin') return;
  demand(actor.role === 'operator-agent' && actor.capabilities?.includes(capability), `Capability ${capability} is required`, 403);
  demand(!!repository && actor.scope?.repositories.includes(repository), 'Repository is outside this operator-agent scope', 403);
  if (work) demand(actor.scope?.workItems.includes('*') || actor.scope?.workItems.includes(work.id) || actor.scope?.workItems.includes(work.key), 'Work item is outside this operator-agent scope', 403);
}
export function activeLease(work: Work, actor: Principal, epoch: number, now: Date) {
  demand(work.lease && work.lease.owner === actor.id && work.lease.epoch === epoch && Date.parse(work.lease.expiresAt) > now.getTime(), 'Lease missing, expired, or superseded; claim the task again');
}

// Shared by gates and human-facing proof previews.
export function currentEvidence(work: Work, proof: string, now = new Date()): Evidence | undefined {
  const scenario = work.scenarioRequirements?.find(s => s.proof === proof);
  const validation = work.validation?.[proof];
  const latest = work.evidence.filter(e => e.proof === proof && e.trusted && e.sha === work.candidate?.sha && e.baseSha === work.candidate?.baseSha && e.policyRevision === work.policyRevision
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
  add('acceptance', reasons);
  add('merge', [...(!fresh ? ['GitHub observation missing or older than two minutes'] : []), ...(!obs?.protected ? ['Required Graphyard check and strict branch protection have not been verified'] : []), ...(!obs?.mergeable && !obs?.merged ? ['Pull request is not mergeable against the current base'] : [])]);
  const first = gates.find(g => !g.passed);
  const violations = [...work.violations];
  let stage: Stage = !work.ready ? 'backlog' : !work.submission ? (work.lease && Date.parse(work.lease.expiresAt) > now.getTime() ? 'build' : 'ready') : (first?.name === 'ready' ? 'build' : first?.name as Stage ?? 'merge');
  // Delivery history stays complete; later observations cannot rewrite it.
  if (work.stage === 'done') stage = 'done';
  return { stage, gates, violations };
}
