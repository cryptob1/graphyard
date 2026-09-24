import { z } from 'zod';
import type { BaseRefresh, LandingCheck, QueueEjection, QueueEntry, QueueHistoryEntry, RevertedDelivery } from '../merge-queue.js';
import { criterionSchema, policySchema, resourcesSchema, type Criterion } from './policy.js';
import type { Evidence } from './evidence.js';
import type { AgentReview, ReviewFailover, ReviewRequest } from './review.js';
import type { Delivery, ReleaseDelivery } from './delivery.js';
import type { BlockingRulingAction } from './delegation.js';
import type { AutoDispatch } from './dispatch.js';
import type { NextAction } from './next-action.js';
import type { ActionQueue } from './actions.js';
import type { AgentRequest } from './agent-requests.js';
import type { SessionHandle } from './sessions.js';
import { namedPaths, pathScope, pathScopeContains, type ScopeDecision, type ScopeRequestState } from './scope.js';
import type { CapacityState } from './capacity.js';
import type { HumanRequest } from './human-request.js';
import type { Closure } from './closure.js';
import { proofSchema } from './proof.js';
import { closedQuestionsSchema } from './closed-question.js';
import { workOriginSchema } from './interventions.js';
import { demand } from './refusal.js';

export const CHECK_NAME = 'Graphyard / merge';
export const stages = ['backlog', 'ready', 'build', 'review', 'test', 'acceptance', 'merge', 'done'] as const;
export type Stage = typeof stages[number];
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
  // Manual proofs a launched producer session may run on the item's behalf. Unit and
  // integration proofs are always producer-runnable; every other manual proof stays with
  // the human operator. See model/dispatch.ts.
  producerProofs: z.array(proofSchema).max(50).optional().refine(proofs => !proofs || proofs.every(proof => proof.startsWith('manual:')), 'producerProofs names only manual: proofs; unit and integration proofs are producer-runnable already')
    .refine(proofs => !proofs || new Set(proofs).size === proofs.length, 'producerProofs must be unique'),
  // Proofs a criterion declares answerable as a closed question: Graphyard asks the configured
  // responder against the bound candidate state instead of launching a producer session, and
  // records the answer as evidence. See model/closed-question.ts.
  closedQuestions: closedQuestionsSchema.optional(),
  // Where Graphyard itself opened the item from feedback (GY-98): a recurring intervention
  // pattern with its linked instances, or an operator's judgement about delivered work.
  origin: z.lazy(() => workOriginSchema).optional(),
}).strict();
export type Create = z.infer<typeof createSchema>;
// The `decision:*` capabilities request a two-party decision (see model/approval.ts); an agent
// holding one still needs a second, independent agent holding `decision:approve` to apply it.
export const operatorCapabilities = ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements', 'policy:review-provider', 'policy:bootstrap',
  'decision:resolve', 'decision:attest', 'decision:merge', 'decision:rework', 'decision:grant', 'decision:approve'] as const;
export type OperatorCapability = typeof operatorCapabilities[number];
export const operatorCredentialHash = Symbol('operatorCredentialHash');
export interface Principal {
  id: string; role: 'admin' | 'operator-agent' | 'coordinator' | 'slice-lead' | 'worker' | 'producer' | 'reader';
  proofs?: string[]; displayName?: string; runtime?: string;
  // Deployment observation is a separate lane from acceptance-proof collection. A
  // producer's `proofs` allowlist grants no authority here and is never widened to
  // cover it: recording provider deployments requires this explicit per-provider
  // scope, so a build or test collector cannot forge production-delivery history.
  deploymentProviders?: string[];
  slice?: SliceId; sessionKind?: 'human' | 'ai';
  capabilities?: OperatorCapability[];
  scope?: { repositories: string[]; workItems: string[] };
  [operatorCredentialHash]?: string;
}
export interface AssignmentIdentity { owner: string; epoch: number; displayName?: string; runtime?: string; claimedAt?: string }
export interface Lease { owner: string; epoch: number; expiresAt: string }
export interface ContainmentScope { unit: string; pid: number }
export interface Workspace { host: string; path: string; branch: string; epoch: number; owner: string }
// createdAt is the provider's pull-request creation time; older observations predate it.
export interface Candidate { sha: string; baseSha: string; pr: number; branch: string; author: string; createdAt?: string }
/**
 * One file the candidate changes, as the provider reports it against the merge base, together
 * with the blob the candidate's bound base (the base branch tip, or a speculative tip's predicted
 * base) holds at the same path. `baseSha` is null when that base has no such file and undefined
 * when the observation never compared it (a file inside the planned scope, or an observation
 * recorded before the regression guard existed).
 */
export interface ScopeFile {
  path: string; status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  previousPath?: string; sha: string | null; additions: number; deletions: number; binary: boolean;
  baseSha?: string | null; previousBaseSha?: string | null;
}
export interface Observation {
  clockOffset?: { min: number; max: number };
  reviewIds?: number[];
  agentReview?: AgentReview;
  prState?: 'open' | 'closed'; draft?: boolean; prCreatedAt?: string;
  candidate: Candidate; checks: { name: string; result: string; appId: number; id?: number; attempt?: number }[];
  reviews: { reviewer: string; sha: string; state: string; id?: number; submittedAt?: string }[];
  merged: boolean; mergeSha: string | null; mergedAt?: string | null; mergeable: boolean;
  // The real base-branch head and its tree, read from refs/heads/<base> (never from the pull
  // request's cached base) and recorded separately from the candidate's bound base so a
  // speculative binding never hides where the managed branch actually points.
  baseTip?: string; baseTree?: string;
  // The head contains that base tip: by ancestry, or as a published queue tip whose bound base
  // is tree-identical to it. A review is only requested for a head that does.
  baseTipContained?: boolean;
  protected: boolean; files: string[]; at: string;
  /** The candidate diff compared against its bound base; see regression-guard.ts. */
  scopeFiles?: ScopeFile[];
  /** The same judgement against the commit the candidate would land on, and the unlanded work its head carries; see merge-queue.ts LandingCheck. */
  landing?: LandingCheck;
  /** Set for a merged pull request whose content the base branch does not hold; see merge-queue.ts RevertedDelivery. */
  revertedDelivery?: RevertedDelivery;
}
export interface Gate { name: string; passed: boolean; reasons: string[] }
export interface Escalation { trigger: EscalationTrigger; reason: string; at: string; actor: string }
export interface Work extends Create {
  /**
   * The current validation selection per proof. `reanchor` is set when the selected request's
   * target moved and automatic re-anchoring could not create a fresh request yet; the
   * authoritative history is the attribution ledger, this is the standing binding.
   */
  validation?: Record<string, { candidateId: string; requestId?: string; attemptId?: string; reanchor?: { state: 'blocked'; reasons: string[]; supersededRequestId: string; environmentId: string; at: string } }>;
  criteria: Criterion[];
  retiredCriterionIds?: string[];
  formalReviewResetRequired?: boolean;
  formalReviewBaseline?: { pr: number; policyRevision: number; reviewIds: number[] };
  // Append-only identities that have held an assignment. Trusted proof producers
  // must stay independent of every one of them, not only the latest assignment.
  implementers?: string[];
  id: string; key: string; stage: Stage; revision: number; policyRevision: number;
  createdAt: string; updatedAt: string; stageEnteredAt: string; ready: boolean;
  epoch: number; lease: Lease | null; lastAssignment?: AssignmentIdentity; workspaces: Workspace[]; candidate: Candidate | null;
  // `scope` is the exact systemd scope unit the supervisor launched the session in and that
  // supervisor's pid, so settlement can attribute a live scope to this assignment or another.
  containmentQuarantine?: { owner: string; epoch: number; at: string; settlementHash: string; launchAcknowledgedAt?: string; launchExpiresAt?: string; leaseExpiresAt?: string; scope?: ContainmentScope } | null;
  submission: { epoch: number; pr: number } | null;
  /**
   * A worker's open ask to widen plannedFiles, bound to the lease epoch that raised it. It is
   * structured state, not free text: the master loop asks the control plane to decide it on the
   * cycle it appears, and the decision it carries — applied, or refused with the reason — is the
   * audit of that. The attempt keeps its lease either way; `master scope` remains the operator's
   * override for what the item does not already imply (see model/scope.ts).
   */
  scopeRequest?: ScopeRequestState | null;
  /**
   * The last scope decision the control plane took for this item, applied or refused, with the
   * request it answered and how long that request waited. An approved request is applied and
   * cleared; a refused one stays open, carrying the same decision, for the operator to decide.
   */
  scopeDecision?: ScopeDecision | null;
  /**
   * The open decision only a human may make, recorded by the attempt that reached it. Recording it
   * ended that attempt's lease and parked the item; the answer clears it, and answered requests
   * are kept in `humanRequests` (see model/human-request.ts).
   */
  humanRequest?: HumanRequest | null;
  humanRequests?: HumanRequest[];
  /** Set when the item was closed without delivery (model/closure.ts); a closed item is `done` but never delivered. */
  closure?: Closure | null;
  /** Sessions of this item that ran out of provider quota, and any role with no account left (model/capacity.ts). */
  capacity?: CapacityState | null;
  queue?: QueueEntry | null; queueSequence?: number; queueEjection?: QueueEjection | null; queueHistory?: QueueHistoryEntry[];
  /**
   * The last time the control plane brought this candidate onto a base branch that had moved
   * under it, or refused to because the merge conflicts. Decided and written by Graphyard
   * alone; see merge-queue.ts for the rule and model/carry.ts for what the refresh carries.
   */
  baseRefresh?: BaseRefresh | null;
  reworkRequested: boolean;
  scenarioRequirements: { proof: string; revision: number; environment: string; hash: string }[];
  reviewRequest?: ReviewRequest | null;
  reviewFailovers?: ReviewFailover[];
  mergeAuthorization?: { sha: string; baseSha: string; policyRevision: number; at: string } | null;
  /** What the exact head still needs from a launched reviewer or producer; see model/dispatch.ts. */
  autoDispatch?: AutoDispatch | null;
  /**
   * The typed action the control plane computed for this item at the last evaluation, and the
   * durable queue rows that say whether anybody is running it. See model/next-action.ts and
   * model/actions.ts; neither authorizes progression.
   */
  nextAction?: NextAction | null;
  actionQueue?: ActionQueue;
  /** Typed asks an agent recorded instead of blocking on a prose question; see model/agent-requests.ts. */
  agentRequests?: AgentRequest[];
  /** Durable handles for the sessions launched on this item; see model/sessions.ts. */
  sessions?: SessionHandle[];
  mergeExecution?: { id: string; owner: string; sha: string; baseSha: string; policyRevision: number; authorizationRevision: number; issuedAt: string; expiresAt: string; verifiedAt?: string; committingAt?: string; clockOffset?: { min: number; max: number }; fenced?: { reason: string; at: string } | null } | null;
  delivery?: Delivery;
  /**
   * Independently observed production delivery, one record per environment: the first
   * release whose verified common interval covered the whole expected manifest while this
   * item was an included member. Merge completion above is a different fact and keeps its
   * meaning; a later release containing the same change records nothing here again.
   */
  releaseDeliveries?: ReleaseDelivery[];
  /** Required proof names that had no authorized producer when intent was last recorded. */
  proofGaps?: string[];
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

// ---- plannedFiles derived from the criteria (GY-140) ---------------------------------------------

interface CriterionText { id: string; text: string }
const creationWords = /\b(new|creat\w*|add(?:s|ed|ing)?|introduc\w*)\b/i;
const testPath = /(^|\/)tests?\/|\.test\.[A-Za-z]+$/;
const sentences = (text: string) => text.split(/(?<=[.!?;])\s+/);
/** True when the tree holds the planned scope: the file itself, or any file under a directory scope. */
export function scopeExists(path: string, tree: ReadonlySet<string>) {
  const scope = pathScope(path);
  if (!scope.prefix && tree.has(scope.path)) return true;
  const directory = scope.path.endsWith('/') ? scope.path : `${scope.path}/`;
  for (const file of tree) if (file.startsWith(directory)) return true;
  return false;
}
/**
 * The criterion that describes creating `path`, or null: a sentence naming the path beside a
 * creation word (new, create, add, introduce), or — for a test file — a criterion that requires a
 * test, since "a test asserts …" is a criterion describing the test it will be written in.
 */
export function describedAsNew(path: string, criteria: readonly CriterionText[]) {
  return criteria.find(criterion => sentences(criterion.text).some(sentence => creationWords.test(sentence) && namedPaths(sentence).some(named => pathScopeContains(named, path)))
    || testPath.test(path) && /\btests?\b/i.test(criterion.text))?.id ?? null;
}
export interface PlannedFilesDerivation {
  plannedFiles: string[];
  /** Files a criterion names that resolve in the tree and were not planned, with the criterion that named each. */
  added: { path: string; criterion: string }[];
  /** Planned paths the tree does not hold and no criterion describes creating: the item is refused naming them. */
  missing: string[];
}
/**
 * plannedFiles as `master create` and `master requirements` record it: every planned path is
 * resolved against the tree of the base branch the item will be worked on, and every file a
 * criterion names that the tree holds is carried in. Only criteria are read — a path the
 * description mentions in prose is not a requirement and adds nothing — and only exact files
 * are carried: a criterion naming a directory widens nothing on its own.
 */
export function derivePlannedFiles(item: { plannedFiles?: readonly string[]; criteria: readonly CriterionText[] }, tree: ReadonlySet<string>): PlannedFilesDerivation {
  const planned = [...new Set(item.plannedFiles ?? [])];
  const missing = planned.filter(path => !scopeExists(path, tree) && !describedAsNew(path, item.criteria));
  const added: PlannedFilesDerivation['added'] = [];
  for (const criterion of item.criteria) for (const path of namedPaths(criterion.text)) {
    if (!tree.has(path) || planned.some(entry => pathScopeContains(entry, path)) || added.some(entry => entry.path === path)) continue;
    added.push({ path, criterion: criterion.id });
  }
  return { plannedFiles: [...planned, ...added.map(entry => entry.path)], added, missing };
}
export function plannedFilesRefusal(missing: readonly string[], base: string) {
  return `plannedFiles names ${missing.length === 1 ? 'a path' : 'paths'} that ${base} does not hold and no criterion describes creating: ${missing.join(', ')}. Correct the path, or state in a criterion that the item creates it`;
}

/**
 * GY-140 AC-3: per open item, every scope request — open, or the last one decided — whose paths a
 * criterion already names. Such a request should never have been needed: the file belonged in
 * plannedFiles at authoring time. Counted, so the authoring fault is measured rather than recalled.
 */
export function impliedScopeRequests(work: readonly Pick<Work, 'key' | 'stage' | 'criteria' | 'scopeRequest' | 'scopeDecision'>[]) {
  const items = work.filter(item => item.stage !== 'done').flatMap(item => {
    const requests = [
      ...(item.scopeRequest ? [{ state: 'open' as const, paths: item.scopeRequest.paths, requestedBy: item.scopeRequest.requestedBy, requestedAt: item.scopeRequest.at }] : []),
      ...(item.scopeDecision && !(item.scopeRequest && item.scopeRequest.at === item.scopeDecision.requestedAt) ? [{ state: item.scopeDecision.state, paths: item.scopeDecision.paths, requestedBy: item.scopeDecision.requestedBy, requestedAt: item.scopeDecision.requestedAt }] : []),
    ];
    return requests.flatMap(request => {
      const named = request.paths.flatMap(path => {
        const criterion = item.criteria.find(entry => namedPaths(entry.text).some(scope => pathScopeContains(scope, path)));
        return criterion ? [{ path, criterion: criterion.id }] : [];
      });
      return named.length ? [{ key: item.key, ...request, named }] : [];
    });
  });
  return { count: items.length, items };
}
