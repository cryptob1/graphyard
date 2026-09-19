import { z } from 'zod';
import type { QueueEjection, QueueEntry, QueueHistoryEntry } from '../merge-queue.js';
import { criterionSchema, policySchema, resourcesSchema, type Criterion } from './policy.js';
import type { Evidence } from './evidence.js';
import type { AgentReview, ReviewFailover, ReviewRequest } from './review.js';
import type { Delivery, ReleaseDelivery } from './delivery.js';
import type { BlockingRulingAction } from './delegation.js';
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
}).strict();
export type Create = z.infer<typeof createSchema>;
export const operatorCapabilities = ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements', 'policy:review-provider', 'policy:bootstrap'] as const;
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
  // The real base-branch head and its tree, recorded separately from the candidate's bound
  // base so a speculative binding never hides where the managed branch actually points.
  baseTip?: string; baseTree?: string;
  protected: boolean; files: string[]; at: string;
  /** The candidate diff compared against its bound base; see regression-guard.ts. */
  scopeFiles?: ScopeFile[];
}
export interface Gate { name: string; passed: boolean; reasons: string[] }
export interface Escalation { trigger: EscalationTrigger; reason: string; at: string; actor: string }
export interface Work extends Create {
  validation?: Record<string, { candidateId: string; requestId?: string; attemptId?: string }>;
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
  queue?: QueueEntry | null; queueSequence?: number; queueEjection?: QueueEjection | null; queueHistory?: QueueHistoryEntry[];
  reworkRequested: boolean;
  scenarioRequirements: { proof: string; revision: number; environment: string; hash: string }[];
  reviewRequest?: ReviewRequest | null;
  reviewFailovers?: ReviewFailover[];
  mergeAuthorization?: { sha: string; baseSha: string; policyRevision: number; at: string } | null;
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
