import { z } from 'zod';
import type { BaseRefresh, BaseRefreshRequest } from './base-refresh.js';
import type { LandingCheck, RevertedDelivery } from './landing-check.js';
import type { MergeRefusal } from './merge-authorization.js';
import { criteriaSchema, policySchema, resourcesSchema, type Criterion, type Lane } from './policy.js';
import type { EvaluationAttempt, Evidence } from './evidence.js';
import type { AgentReview, ReviewFailover, ReviewRequest } from './review.js';
import type { Delivery, ReleaseDelivery } from './delivery.js';
import type { BlockingRulingAction } from './delegation.js';
import type { AutoDispatch } from './dispatch.js';
import type { NextAction } from './next-action.js';
import type { ActionQueue } from './actions.js';
import type { AgentRequest } from './agent-requests.js';
import type { SessionHandle } from './sessions.js';
import type { CapacityState } from './capacity.js';
import type { HumanRequest } from './human-request.js';
import type { ResearchRecord } from '../research.js';
import type { DecompositionRecord } from '../decomposition.js';
import type { Closure } from './closure.js';
import type { PendingFollowUps, TriageRecord } from './machine-backlog.js';
import { proofSchema } from './proof.js';
import { closedQuestionsSchema } from './closed-question.js';
import { workOriginSchema } from './machine-backlog.js';
import { demand } from './refusal.js';

export const CHECK_NAME = 'Graphyard / merge', LANDABLE_CHECK = 'graphyard/landable'; // GY-887: both are Graphyard's own, never CI inputs to the verdict
export const stages = ['backlog', 'ready', 'build', 'review', 'test', 'acceptance', 'merge', 'done'] as const;
export type Stage = typeof stages[number];
export const sliceIds = ['product', 'infrastructure', 'docs-experience'] as const; export type SliceId = typeof sliceIds[number];
export const escalationTriggers = ['lease-loss', 'evidence-policy-conflict', 'security-concern', 'requirement-weakening'] as const;
export type EscalationTrigger = typeof escalationTriggers[number];
/** The shipped setting: every new item is system-driven unless its intent says `"systemDriven": false`. */
export const systemDrivenDefault = true;
export { declaredPostDeploy, liveObservationPhrase, postDeployCriterionRefusal, postDeployOnlyRefusal, postDeployProof, postDeployProofPrefix, postDeployProofs } from './post-merge-proofs.js';
/**
 * GY-1698: a post-deploy follow-up whose criterion is a rolling-window reading — an intervention
 * rate below a threshold per N days, a hold for N consecutive days — can produce nothing before
 * the window has run: GY-1689, filed at 03:36Z for a 03:11Z merge, was released at 06:39Z and
 * spent two worker attempts, a review and two approver sessions on a reading the intervention
 * report itself projected no earlier than 2026-10-17T14:31Z. The product computes that instant
 * already; the follow-up now carries it, as one fact in one place: `notBefore` is the earliest
 * instant the reading can exist, taken from the report's projection for the pattern
 * (`intervention-report`) or from the delivered item's merge time plus the window the criterion
 * states (`criterion-window`), whichever is later. A master release before it stays operator
 * intent — the item may be released — but `nextAction` holds the dispatch on the instant and the
 * loop dispatches it once the instant passes, without a master session.
 */
export const observationWindowSchema = z.object({
  notBefore: z.string().datetime({ offset: true }),
  basis: z.enum(['intervention-report', 'criterion-window', 'worker-reading', 'operator-hold']),
  detail: z.string().max(2000),
}).strict();
export type ObservationWindow = z.infer<typeof observationWindowSchema>;
export const createSchema = z.object({
  title: z.string().min(1).max(200), description: z.string().max(20000).default(''),
  /** One plain sentence a person can read first on the item page (GY-2011); optional on master create, set from a plan item's `plain` at release. */
  summary: z.string().trim().min(1).max(400).optional(),
  type: z.enum(['feature', 'bug', 'chore']).default('feature'),
  priority: z.number().int().min(0).max(4).default(2),
  dependencies: z.array(z.string().uuid()).max(50).default([]),
  criteria: criteriaSchema(50),
  policy: policySchema.default({ checks: ['test', 'typecheck'], review: true }),
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
  // Where Graphyard itself opened the item: the parent a review follow-up collects findings for.
  origin: z.lazy(() => workOriginSchema).optional(),
  // A system-driven item moves only through the loop: the master CLI refuses the hand actions the
  // loop owns for it (src/cli/hand-actions.ts). New items take the shipped default; an item
  // created before the field existed carries none and is not system-driven.
  systemDriven: z.preprocess(value => value === undefined ? systemDrivenDefault : value, z.boolean().optional()),
  // `research` (GY-259, src/research.ts): false skips a feature's research, true researches any item. `split` (GY-1126, src/decomposition.ts): false never splits it before first dispatch, true splits it even within the size bounds.
  research: z.boolean().optional(), split: z.boolean().optional(),
  // The earliest instant the observation this item owes can exist (GY-1698): a post-deploy
  // follow-up for a windowed reading carries it; released, the item is not dispatched before it.
  observationWindow: observationWindowSchema.optional(),
}).strict();
export type Create = z.infer<typeof createSchema>;
/**
 * GY-1726: a post-deploy follow-up's proof (`manual:…-on-serving-release`, master-verification.ts
 * files it so): the one kind of criterion whose reading can lie in the future. A worker that finds
 * the reading cannot exist yet defers the item to that instant (`defer`) instead of escalating.
 */
export const servingReleaseProof = (proof: string) => /^manual:.+-on-serving-release$/.test(proof);
/** The longest a worker may defer an item: past it the reading is a requirements question, not a wait. */
export const deferBoundMs = 30 * 24 * 3_600_000;
/** The item's observation window while it still holds: `notBefore` is after `now`. Null for an item without one, or past it. */
export function observationWindowHold(work: { observationWindow?: ObservationWindow | null }, now: Date): ObservationWindow | null {
  const window = work.observationWindow;
  return window && Date.parse(window.notBefore) > now.getTime() ? window : null;
}
export { loopObservationProofs, loopObservation } from './loop-observation.js';
// The `decision:*` capabilities request a two-party decision (see model/approval.ts); an agent
// holding one still needs a second, independent agent holding `decision:approve` to apply it.
// `e2e:record` (GY-1614) admits only the scenario registry and its run route: a candidate's UAT case runs.
export const operatorCapabilities = ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements', 'policy:review-provider', 'policy:bootstrap',
  'decision:resolve', 'decision:attest', 'decision:merge', 'decision:rework', 'decision:grant', 'decision:approve', 'e2e:record'] as const;
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
  slice?: SliceId; sessionKind?: 'human' | 'ai'; grants?: string[]; // GY-1879: lane grants (server/principals.ts), never proof authority
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
 * with the blob the candidate's bound base holds at the same path. `baseSha` is null when that base has no such file and undefined
 * when the observation never compared it (a file inside the planned scope, or an observation
 * recorded before the regression guard existed).
 */
export interface ScopeFile {
  path: string; status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  previousPath?: string; sha: string | null; additions: number; deletions: number; binary: boolean;
  baseSha?: string | null; previousBaseSha?: string | null; /** Timing-baseline companion verdict (GY-1023), from both versions' contents. */ companion?: { allowed: boolean; detail: string };
}
export interface Observation {
  clockOffset?: { min: number; max: number };
  /** The ids of the reviews recorded on this head (server/review-verdict.ts appends each verdict's), and those withdrawn. */
  reviewIds?: number[]; dismissedReviewIds?: number[];
  agentReview?: AgentReview;
  /** Pull-request-era fields (GY-2010): a document observed before the control plane became the merge writer still loads; the control plane writes neither. */
  prState?: 'open' | 'closed'; draft?: boolean; prCreatedAt?: string;
  /** Pull-request-era check runs; the control plane records none (`checks: []`) and no gate reads them. */
  candidate: Candidate; checks: { name: string; result: string; appId: number; id?: number; attempt?: number; source?: 'status' }[];
  reviews: { reviewer: string; sha: string; state: string; id?: number; submittedAt?: string; body?: string; blocking?: string[]; mechanical?: number; source?: string }[]; // body: a change request's text, read past the review-round cap; blocking: its BLOCKING: findings, read from the whole body (GY-1118); mechanical: an approval's nits classified mechanical, which hold the review gate for their bot round (GY-971)
  merged: boolean; mergeSha: string | null; mergedAt?: string | null; mergeable: boolean;
  /** A pull-request-era conflict reading; the control plane's own test merge decides conflicts (model/base-refresh.ts). */
  conflicting?: boolean;
  // The real base-branch head and its tree, recorded separately from the candidate's bound base
  // so a held binding never hides where the managed branch actually points.
  baseTip?: string; baseTree?: string;
  // The head contains that base tip by ancestry. A review is only requested for a head that does.
  baseTipContained?: boolean;
  protected: boolean; files: string[]; at: string;
  /** The candidate diff compared against its bound base; see regression-guard.ts. */
  scopeFiles?: ScopeFile[];
  /** The e2e/contract.json outcome bindings the head changes or drops against the base tip, read by the control plane's own observation when the head touches the contract (GY-2602); unset when no contents were read. */
  contractMoved?: string[] | null;
  /** The same judgement against the commit the candidate would land on, and the unlanded work its head carries; see model/landing-check.ts. */
  landing?: LandingCheck;
  revertedDelivery?: RevertedDelivery; // a merged change whose content the base branch does not hold; see model/landing-check.ts
}
export interface Gate { name: string; passed: boolean; reasons: string[] }
/** `decision`: the approved two-party decision whose application raised it, when the item's ledger records it approved (GY-1347). */
export interface Escalation { trigger: EscalationTrigger; reason: string; at: string; actor: string; decision?: string }
export interface Work extends Create {
  /**
   * The current validation selection per proof. `reanchor` is set when the selected request's
   * target moved and automatic re-anchoring could not create a fresh request yet; the
   * authoritative history is the attribution ledger, this is the standing binding. `fault` (GY-1841)
   * is set when the selected result's evaluation exhausted its evaluator-error retries: the
   * evaluator errors and every attempt, a fault of the evaluation, never a failed proof.
   */
  validation?: Record<string, { candidateId: string; requestId?: string; attemptId?: string; reanchor?: { state: 'blocked'; reasons: string[]; supersededRequestId: string; environmentId: string; at: string };
    fault?: { kind: 'evaluator-error'; errors: string[]; attempts: EvaluationAttempt[]; requestId: string; attemptId: string; at: string } }>;
  criteria: Criterion[];
  retiredCriterionIds?: string[];
  formalReviewResetRequired?: boolean;
  /** The planned mechanical-fix round the review ledger holds for the current candidate (GY-1764): the only ground that holds an approved head for its bot round. `at` is the instant the control plane accepted the loop's last report of it, so a hold never outlives a ledger the loop can still confirm. */
  mechanicalPlan?: { reviewId: number; head: string; at: string } | null;
  /** The approval the loop's last clear of `mechanicalPlan` answered (GY-1814): a clear releases the review gate's hold over that approval only, never over a later approval of a later head. */
  mechanicalAnswered?: { reviewId: number; head: string } | null;
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
   * The open decision only a human may make, recorded by the attempt that reached it. Recording it
   * ended that attempt's lease and parked the item; the answer clears it, and answered requests
   * are kept in `humanRequests` (see model/human-request.ts).
   */
  humanRequest?: HumanRequest | null; humanRequests?: HumanRequest[]; /** The loop's last probe of the blocker's cause (GY-1008). */ blockerProbe?: import('./blocker-class.js').BlockerProbe | null;
  /** What the research step found before build, and the product questions it asked (src/research.ts); the decomposition run before first dispatch and the split relation it recorded, set only by the control plane (src/decomposition.ts). */
  researchBrief?: ResearchRecord | null; decomposition?: DecompositionRecord | null; parent?: string | null; children?: string[];
  /** Set when the item was closed without delivery (model/closure.ts); a closed item is `done` but never delivered. */
  closure?: Closure | null; triage?: TriageRecord | null; pendingFollowUps?: PendingFollowUps | null; // triage: a machine-filed item's judgement (GY-402); pendingFollowUps: follow-ups held until it shipped (GY-845), stored before GY-1249 and never written now, model/machine-backlog.ts
  /** Sessions of this item that ran out of provider quota, and any role with no account left (model/capacity.ts). */
  capacity?: CapacityState | null;
  /**
   * The last time the control plane brought this candidate onto a base branch that had moved
   * under it, or refused to because the merge conflicts. Decided and written by Graphyard
   * alone; see model/base-refresh.ts for the rule and model/carry.ts for what the refresh carries.
   */
  baseRefresh?: BaseRefresh | null; baseRefreshRequest?: BaseRefreshRequest | null; mergeRefusal?: MergeRefusal | null; // baseRefreshRequest: the standing request to merge a repaired base in (GY-528); mergeRefusal: the guarded merge's refusal (GY-831)
  /** GY-1927: the automatic-merging hold over the item's candidate, as the coordination view serves it (merger-mode.ts `mergeHolds`); absent when nothing holds it. */
  mergeHold?: string | null;
  reworkRequested: boolean;
  scenarioRequirements: { proof: string; revision: number; environment: string; hash: string }[];
  reviewRequest?: ReviewRequest | null;
  reviewFailovers?: ReviewFailover[];
  /** Recorded before GY-1235 and only cleared since: GitHub merges on every passing gate, with no separate authorization. */
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
  /** Recorded before GY-258 and only cleared since: Graphyard issues no merge executions. */
  mergeExecution?: { id: string; owner: string; sha: string; baseSha: string; policyRevision: number; authorizationRevision: number; issuedAt: string; expiresAt: string; verifiedAt?: string; committingAt?: string; clockOffset?: { min: number; max: number }; fenced?: { reason: string; at: string } | null } | null;
  delivery?: Delivery;
  /** Retired repair lane (GY-406, removed by GY-1234): stored items keep loading; nothing reads these. */
  repair?: 'merge-path';
  repairLane?: Record<string, unknown> | null;
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
  gates: Gate[]; violations: string[]; lane?: Lane; speedTarget?: number; // risk lane and its speed target (GY-883, model/policy.ts), stamped by the last evaluation
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
