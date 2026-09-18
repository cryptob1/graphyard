import { z } from 'zod';
import { ejectionReason, nextQueueSequence, queueHistoryLimit, queuePlacement } from './merge-queue.js';
import type { QueueEjection, QueueEntry, QueueHistoryEntry } from './merge-queue.js';

export const CHECK_NAME = 'Graphyard / merge';
export const stages = ['backlog', 'ready', 'build', 'review', 'test', 'acceptance', 'merge', 'done'] as const;
export type Stage = typeof stages[number];
export const proofSchema = z.string().regex(/^(unit|integration|e2e|manual):[a-zA-Z0-9._/-]+$/);
// Bootstrap mode: an operator may defer a criterion's proofs for the single change that
// introduces the harness those proofs depend on. The proof is never dropped. It becomes a
// standing obligation on the named contract paths, and the next change touching those paths
// inherits it as a required proof. Workers can never declare it.
export const bootstrapDeclarationSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
  contractPaths: z.array(z.string().trim().min(1).max(500)).min(1).max(20)
    .refine(paths => new Set(paths).size === paths.length, 'Bootstrap contract paths must be unique'),
}).strict();
export type BootstrapDeclaration = z.infer<typeof bootstrapDeclarationSchema>;
export const criterionSchema = z.object({ id: z.string().regex(/^AC-\d+$/), text: z.string().min(1).max(2000), proofs: z.array(proofSchema).min(1).max(20), bootstrap: bootstrapDeclarationSchema.optional() }).strict();
/** Stored declaration. The audit fields are stamped by the control plane, never by the client. */
export interface BootstrapMode extends BootstrapDeclaration { declaredBy: string; declaredAt: string; policyRevision: number }
export interface Criterion { id: string; text: string; proofs: string[]; bootstrap?: BootstrapMode }
export const reviewProviders = ['github', 'codex', 'agent'] as const;
export type ReviewProvider = typeof reviewProviders[number];
const identifier = z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
// A runtime label is descriptive provenance (which agent produced the review), never authority.
const runtimeName = z.string().trim().regex(/^[a-z0-9][a-z0-9.+_-]{0,39}$/);
export const reviewerProfileSchema = z.object({
  name: identifier, runtime: runtimeName, reviewerApp: identifier,
  mention: z.string().regex(/^@[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/).optional(),
  timeoutSeconds: z.number().int().min(60).max(86_400).default(1800),
}).strict();
export type ReviewerProfile = z.infer<typeof reviewerProfileSchema>;
// Registered reviewer identities are numeric GitHub App/bot identities, not display names.
export const reviewerAppSchema = z.object({
  id: identifier, runtime: runtimeName,
  appId: z.number().int().positive(), botUserId: z.number().int().positive(),
  displayName: z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
}).strict();
export type ReviewerApp = z.infer<typeof reviewerAppSchema>;
const distinct = (values: unknown[]) => new Set(values.map(value => JSON.stringify(value))).size === values.length;
export const reviewerAppsSchema = z.array(reviewerAppSchema).max(50)
  .refine(apps => distinct(apps.map(app => app.id)), 'Reviewer App identifiers must be unique')
  .refine(apps => distinct(apps.map(app => app.appId)), 'Reviewer GitHub App IDs must be unique')
  .refine(apps => distinct(apps.map(app => app.botUserId)), 'Reviewer bot user IDs must be unique');
export function parseReviewerApps(raw: string | undefined): ReviewerApp[] {
  return reviewerAppsSchema.parse(JSON.parse(raw?.trim() || '[]'));
}
export const policySchema = z.object({
  checks: z.array(z.string().min(1).max(200)).min(1).max(30).default(['test', 'typecheck']),
  review: z.boolean().default(true),
  reviewProvider: z.enum(reviewProviders).optional(),
  reviewerProfiles: z.array(reviewerProfileSchema).min(1).max(10).optional(),
}).strict().superRefine((policy, context) => {
  if (policy.reviewProvider !== 'agent') {
    if (policy.reviewerProfiles) context.addIssue({ code: 'custom', message: 'Reviewer profiles require reviewProvider "agent"', path: ['reviewerProfiles'] });
    return;
  }
  if (!policy.review) context.addIssue({ code: 'custom', message: 'Agent review requires review: true', path: ['review'] });
  const profiles = policy.reviewerProfiles ?? [];
  if (!profiles.length) context.addIssue({ code: 'custom', message: 'Agent review requires at least one reviewer profile', path: ['reviewerProfiles'] });
  if (!distinct(profiles.map(profile => profile.name))) context.addIssue({ code: 'custom', message: 'Reviewer profile names must be unique', path: ['reviewerProfiles'] });
  // One identity per profile keeps a verdict attributable to exactly one profile.
  if (!distinct(profiles.map(profile => profile.reviewerApp))) context.addIssue({ code: 'custom', message: 'Each reviewer profile must name a distinct registered reviewer App', path: ['reviewerProfiles'] });
});
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
export const operatorCapabilities = ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements', 'policy:review-provider', 'policy:bootstrap'] as const;
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
export interface ReviewRequest {
  commentId: number; sha: string; baseSha: string; policyRevision: number; body: string; createdAt: string;
  // Absent provider metadata identifies a legacy Codex request; agent requests name the
  // dispatched profile, its registered App identity, and the correlation marker.
  provider?: ReviewProvider; profile?: string; reviewerApp?: string; marker?: string;
}
export interface AgentReview {
  provider: 'codex' | 'agent'; sha: string; approved: boolean; reason: string;
  summaryId?: number; resultId?: number; requestId?: number; reactionId?: number; completedAt?: string;
  profile?: string; reviewerApp?: string; verdictId?: number;
  exhausted?: boolean; exhaustion?: 'usage-limit' | 'timeout';
}
export interface ReviewFailover {
  profile: string; reviewerApp: string; runtime: string; exhaustion: 'usage-limit' | 'timeout'; reason: string;
  at: string; sha: string; baseSha: string; policyRevision: number; requestCommentId: number; nextProfile: string | null;
}
export interface Observation {
  clockOffset?: { min: number; max: number };
  reviewIds?: number[];
  agentReview?: AgentReview;
  prState?: 'open' | 'closed'; draft?: boolean;
  candidate: Candidate; checks: { name: string; result: string; appId: number }[];
  reviews: { reviewer: string; sha: string; state: string; id?: number; submittedAt?: string }[];
  merged: boolean; mergeSha: string | null; mergedAt?: string | null; mergeable: boolean;
  // The real base-branch head and its tree, recorded separately from the candidate's bound
  // base so a speculative binding never hides where the managed branch actually points.
  baseTip?: string; baseTree?: string;
  protected: boolean; files: string[]; at: string;
}
export interface Gate { name: string; passed: boolean; reasons: string[] }
export interface ReleaseDelivery { environment: string; policyRevision: number; releaseId: string; releaseRevision: number; generation: number; verifiedAt: string; interval: { from: string; to: string } }
export interface Work extends Create {
  validation?: Record<string, { candidateId: string; requestId?: string; attemptId?: string }>;
  criteria: Criterion[];
  retiredCriterionIds?: string[];
  formalReviewResetRequired?: boolean;
  formalReviewBaseline?: { pr: number; policyRevision: number; reviewIds: number[] };
  id: string; key: string; stage: Stage; revision: number; policyRevision: number;
  createdAt: string; updatedAt: string; stageEnteredAt: string; ready: boolean;
  epoch: number; lease: Lease | null; lastAssignment?: AssignmentIdentity; workspaces: Workspace[]; candidate: Candidate | null;
  containmentQuarantine?: { owner: string; epoch: number; at: string; settlementHash: string; launchAcknowledgedAt?: string; launchExpiresAt?: string; leaseExpiresAt?: string } | null;
  submission: { epoch: number; pr: number } | null;
  queue?: QueueEntry | null; queueSequence?: number; queueEjection?: QueueEjection | null; queueHistory?: QueueHistoryEntry[];
  reworkRequested: boolean;
  scenarioRequirements: { proof: string; revision: number; environment: string; hash: string }[];
  reviewRequest?: ReviewRequest | null;
  reviewFailovers?: ReviewFailover[];
  mergeAuthorization?: { sha: string; baseSha: string; policyRevision: number; at: string } | null;
  mergeExecution?: { id: string; owner: string; sha: string; baseSha: string; policyRevision: number; authorizationRevision: number; issuedAt: string; expiresAt: string; verifiedAt?: string; clockOffset?: { min: number; max: number } } | null;
  delivery?: { mergedAt: string; mergeSha: string; authorizationRevision: number };
  /**
   * Independently observed production delivery, one record per environment: the first
   * release whose verified common interval covered the whole expected manifest while this
   * item was an included member. Merge completion above is a different fact and keeps its
   * meaning; a later release containing the same change records nothing here again.
   */
  releaseDeliveries?: ReleaseDelivery[];
  evidence: Evidence[]; observation: Observation | null; blocker: string | null;
  gates: Gate[]; violations: string[];
}
export class Refusal extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
export class ReconciliationRetry extends Refusal {}
export class SpeculativeConflict extends Refusal {}
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

// A task created before pluggable providers keeps requiring a formal GitHub approval.
export const reviewProviderOf = (policy: Work['policy']): ReviewProvider => policy.reviewProvider ?? 'github';
export const nativeReviewRequired = (policy: Work['policy']) => !!policy.review && reviewProviderOf(policy) === 'github';
// Failover is derived, never stored: the recorded exhaustion history for the exact
// candidate and policy selects the next untried reviewer profile in configured order.
export function exhaustedReviewerProfiles(work: Work): string[] {
  return (work.reviewFailovers ?? []).filter(failover => failover.sha === work.candidate?.sha
    && failover.baseSha === work.candidate?.baseSha && failover.policyRevision === work.policyRevision).map(failover => failover.profile);
}
export function reviewerProfileFor(work: Work): ReviewerProfile | null {
  if (reviewProviderOf(work.policy) !== 'agent') return null;
  const exhausted = new Set(exhaustedReviewerProfiles(work));
  return (work.policy.reviewerProfiles ?? []).find(profile => !exhausted.has(profile.name)) ?? null;
}

// Registration is the identity boundary: a policy may only name reviewer Apps whose
// numeric GitHub identities the control plane already knows, and never its own App.
export function assertReviewerProfiles(profiles: ReviewerProfile[] | undefined, registry: ReviewerApp[], controlPlaneAppId?: number) {
  demand(profiles?.length, 'Agent review requires at least one reviewer profile');
  for (const profile of profiles!) {
    const app = registry.find(entry => entry.id === profile.reviewerApp);
    demand(app, `Reviewer App ${profile.reviewerApp} is not registered in Graphyard`);
    demand(app!.runtime === profile.runtime, `Reviewer profile ${profile.name} must name its registered runtime ${app!.runtime}`);
    demand(!controlPlaneAppId || app!.appId !== controlPlaneAppId, 'The Graphyard control-plane App cannot act as a reviewer identity');
  }
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

// Deliberately bounded scope syntax: exact paths or directory prefixes ending /, /*, /**.
// Unsupported glob expressions are not interpreted as semantic dependency knowledge.
export function pathScope(value: string) {
  const path = value.replace(/^\.\//, '');
  const prefix = path.endsWith('/') || /\/\*{1,2}$/.test(path);
  return { path: prefix ? path.replace(/\*+$/, '') : path, prefix };
}
export function pathScopesOverlap(a: string, b: string) {
  const left = pathScope(a), right = pathScope(b);
  return left.path === right.path || left.prefix && right.path.startsWith(left.path) || right.prefix && left.path.startsWith(right.path);
}
/** True when `outer` covers every file `inner` can name. A file scope contains only itself. */
export function pathScopeContains(outer: string, inner: string) {
  const wide = pathScope(outer), narrow = pathScope(inner);
  return wide.path === narrow.path ? wide.prefix || !narrow.prefix : wide.prefix && narrow.path.startsWith(wide.path);
}

export interface BootstrapObligation extends BootstrapMode { key: string; workId: string; criterionId: string; proof: string }

/**
 * A deferred proof is discharged only by a delivered change that actually ran it: trusted
 * passing evidence bound to that change's merged candidate and policy. Nothing an operator
 * or worker asserts can retire an obligation.
 */
export function deliveredProof(work: Work, proof: string) {
  const candidate = work.candidate;
  return work.stage === 'done' && !!candidate && work.evidence.some(evidence => evidence.proof === proof && evidence.trusted
    && evidence.result === 'pass' && evidence.executed > 0 && evidence.skipped === 0
    && evidence.sha === candidate.sha && evidence.baseSha === candidate.baseSha && evidence.policyRevision === work.policyRevision);
}

/** Every bootstrap deferral no delivered change has proven yet. Derived, never asserted. */
export function bootstrapObligations(all: Work[]): BootstrapObligation[] {
  const declared = all.flatMap(item => item.criteria.flatMap(ac => ac.bootstrap
    ? ac.proofs.map(proof => ({ key: item.key, workId: item.id, criterionId: ac.id, proof, ...ac.bootstrap! }))
    : []));
  return declared.filter(obligation => !all.some(item => deliveredProof(item, obligation.proof)));
}

/**
 * Obligations another change deferred that this item's planned files now touch. A criterion
 * of this item cannot defer an inherited proof a second time: its own bootstrap declaration is
 * deliberately not consulted here, so the deferral can never be renewed by the change that
 * inherits it.
 */
export function inheritedObligations(work: Work, all: Work[]): BootstrapObligation[] {
  if (work.stage === 'done') return [];
  const alreadyRequired = new Set(work.criteria.flatMap(ac => ac.bootstrap ? [] : ac.proofs));
  const inherited: BootstrapObligation[] = [];
  for (const obligation of bootstrapObligations(all)) {
    if (obligation.workId === work.id || alreadyRequired.has(obligation.proof)) continue;
    if (inherited.some(seen => seen.proof === obligation.proof)) continue;
    if (work.plannedFiles.some(path => obligation.contractPaths.some(contract => pathScopesOverlap(path, contract)))) inherited.push(obligation);
  }
  return inherited;
}

/** Exactly the proofs the acceptance gate demands for the current candidate. */
export function requiredProofs(work: Work, all: Work[]): string[] {
  return [...new Set([...work.criteria.flatMap(ac => ac.bootstrap ? [] : ac.proofs), ...inheritedObligations(work, all).map(obligation => obligation.proof)])];
}

// Pure evaluation: neither worker assertions nor UI state can authorize progression.
export function evaluate(work: Work, all: Work[], now: Date, ciAppIds: number[]): { stage: Stage; gates: Gate[]; violations: string[]; queue: QueueEntry | null; queueSequence: number; queueEjection: QueueEjection | null; queueHistory: QueueHistoryEntry[] } {
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
  const provider = reviewProviderOf(work.policy);
  const selectedProfile = reviewerProfileFor(work);
  // A dispatched provider verdict counts only for the exact recorded request.
  const dispatchedApproval = (expected: 'codex' | 'agent') => !!candidate && !!agentReview?.approved && agentReview.provider === expected
    && agentReview.sha === candidate.sha && work.reviewRequest?.commentId === agentReview.requestId
    && work.reviewRequest?.sha === candidate.sha && work.reviewRequest?.baseSha === candidate.baseSha
    && work.reviewRequest?.policyRevision === work.policyRevision;
  const reviewPassed = provider === 'codex' ? dispatchedApproval('codex')
    : provider === 'agent' ? dispatchedApproval('agent')
      // The approving identity must be the profile Graphyard currently dispatched to,
      // and that profile must still be configured with the same registered App.
      && !!agentReview!.profile && !!agentReview!.reviewerApp
      && work.reviewRequest!.provider === 'agent' && work.reviewRequest!.profile === agentReview!.profile
      && work.reviewRequest!.reviewerApp === agentReview!.reviewerApp
      && selectedProfile?.name === agentReview!.profile && selectedProfile?.reviewerApp === agentReview!.reviewerApp
    : !!candidate && reviews.some(r => r.sha === candidate.sha && r.state === 'APPROVED' && r.reviewer !== candidate.author
      && (!work.formalReviewResetRequired || work.formalReviewBaseline?.pr === candidate.pr && work.formalReviewBaseline.policyRevision === work.policyRevision && Number.isSafeInteger(r.id) && r.id! > 0 && !work.formalReviewBaseline.reviewIds.includes(r.id!)));
  const reviewRefusal = provider === 'codex' ? agentReview?.reason ?? 'Verified clean Codex review of the current commit is required'
    : provider === 'agent' ? !selectedProfile
      ? `Every configured reviewer profile is exhausted for this candidate (${exhaustedReviewerProfiles(work).join(', ') || 'none configured'}); add reviewer capacity or select another review provider`
      : agentReview?.reason ?? `Verified approval from reviewer profile ${selectedProfile.name} is required for the current commit`
    : work.formalReviewResetRequired ? 'A new independent GitHub approval after the requirement-review baseline is required' : 'Independent approval of the current commit is required';
  add('review', work.policy.review ? [
    ...(!reviewPassed ? [reviewRefusal] : []),
    ...(changesRequested ? ['Outstanding change requests must be resolved through a new review'] : []),
  ] : []);
  add('test', work.policy.checks.filter(name => {
    const checks = current ? obs!.checks.filter(c => c.name === name && ciAppIds.includes(c.appId)) : [];
    return !checks.length || checks.some(c => c.result !== 'success');
  }).map(name => `Required CI check ${name} has not passed on the current candidate`));
  const reasons: string[] = [];
  const unproven = (proof: string) => {
    const evidence = currentEvidence(work, proof, now);
    return !evidence || evidence.result !== 'pass' || evidence.executed < 1 || evidence.skipped !== 0;
  };
  const demanded = (proof: string) => {
    const scenario = work.scenarioRequirements?.find(s => s.proof === proof);
    return `${proof} needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy${scenario ? `; scenario v${scenario.revision} in ${scenario.environment}` : ''}`;
  };
  // A bootstrap criterion's proofs are deferred here and required of the next change that
  // touches the same contract; review, CI and every other criterion still gate this one.
  for (const ac of work.criteria.filter(criterion => !criterion.bootstrap)) for (const proof of ac.proofs) {
    if (unproven(proof)) reasons.push(`${ac.id}: ${demanded(proof)}`);
  }
  for (const obligation of inheritedObligations(work, all)) {
    if (unproven(obligation.proof)) reasons.push(`Bootstrap obligation inherited from ${obligation.key} ${obligation.criterionId}: ${demanded(obligation.proof)}`);
  }
  add('acceptance', reasons);
  // The merge queue owns the last hop. A candidate that has proven itself enters the queue,
  // is validated against the speculative tip it will actually land, and merges in order.
  const queueState = placeInQueue(work, all, now, ciAppIds, gates.every(g => g.passed) && !work.violations.length && !!candidate && !obs?.merged);
  add('merge', [...(!fresh ? ['GitHub observation missing or older than two minutes'] : []), ...(!obs?.protected ? ['Required Graphyard check and merge-queue branch protection have not been verified'] : []), ...(!obs?.mergeable && !obs?.merged ? ['Pull request is not mergeable against the current base'] : []), ...queueState.reasons]);
  const first = gates.find(g => !g.passed);
  const violations = [...work.violations];
  let stage: Stage = !work.ready ? 'backlog' : !work.submission ? (work.lease && Date.parse(work.lease.expiresAt) > now.getTime() ? 'build' : 'ready') : (first?.name === 'ready' ? 'build' : first?.name as Stage ?? 'merge');
  // Delivery history stays complete; later observations cannot rewrite it.
  if (work.stage === 'done') stage = 'done';
  return { stage, gates, violations, queue: queueState.queue, queueSequence: queueState.queueSequence, queueEjection: queueState.ejection, queueHistory: queueState.history };
}

/**
 * Queue membership is derived, never asserted: no command, operator, or administrator can
 * place, reorder, or hold a position. An entry leaves only by merging or by an explicit,
 * observed validation failure, and a re-entry always starts a new sequence at the back.
 */
function placeInQueue(work: Work, all: Work[], now: Date, ciAppIds: number[], eligible: boolean) {
  const history = [...(work.queueHistory ?? [])];
  const candidate = work.candidate;
  let queue = work.queue ?? null, queueSequence = work.queueSequence ?? 0, ejection = work.queueEjection ?? null;
  const record = (event: QueueHistoryEntry['event'], reason?: string, tip?: string) => {
    history.push({ at: now.toISOString(), event, sequence: queueSequence, ...(reason ? { reason } : {}), ...(tip ? { tip } : {}) });
    if (history.length > queueHistoryLimit) history.splice(0, history.length - queueHistoryLimit);
  };
  const probe = { ...work, queue, queueSequence, gates: [], violations: work.violations } as Work;
  const reason = queue ? ejectionReason(probe, ciAppIds) : null;
  if (queue && reason) {
    ejection = { at: now.toISOString(), sequence: queue.sequence, reason, sha: candidate?.sha ?? null, policyRevision: work.policyRevision };
    record('ejected', reason, queue.speculation?.tip ?? candidate?.sha);
    queue = null;
  } else if (!queue && eligible && !(ejection && candidate && ejection.sha === candidate.sha && ejection.policyRevision === work.policyRevision)) {
    queueSequence = nextQueueSequence(all);
    queue = { sequence: queueSequence, enqueuedAt: now.toISOString(), policyRevision: work.policyRevision, speculation: null };
    ejection = null;
    record('enqueued');
  }
  const shadow = { ...work, queue, queueSequence } as Work;
  const placement = queue ? queuePlacement(shadow, all.map(item => item.id === work.id ? shadow : item), now.getTime()) : null;
  const reasons = placement ? placement.reasons
    : work.observation?.merged || work.stage === 'done' ? []
    : ejection ? [`Ejected from the merge queue: ${ejection.reason}; a new candidate re-enters at the back of the queue`]
    : eligible ? ['Candidate has not entered the merge queue'] : [];
  return { queue, queueSequence, ejection, history, reasons, placement };
}
