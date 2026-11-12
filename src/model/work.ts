import type { z } from 'zod';
import type { observationWindowSchema, createSchema } from '../model-boundary/work.js';
import type { LandingCheck, RevertedDelivery } from './landing-check.js';
import type { EvaluationAttempt, Evidence } from './evidence.js';
import type { Criterion } from './policy.js';
import type { HumanRequest } from './human-request.js';
import type { Closure } from './closure.js';
import type { CapacityState } from './capacity.js';
import type { BaseRefresh, BaseRefreshRequest } from './base-refresh.js';
import type { MergeRefusal } from './merge-authorization.js';
import type { AutoDispatch } from './dispatch.js';
import type { NextAction } from './action-kinds.js';
import type { ActionQueue } from './actions.js';
import type { AgentRequest } from './agent-requests.js';
import type { SessionHandle } from './sessions.js';
import type { Delivery, ReleaseDelivery } from './delivery.js';
import type { BlockingRulingAction } from './delegation.js';
import { demand } from './refusal.js';
export const CHECK_NAME = 'Graphyard / merge', LANDABLE_CHECK = 'graphyard/landable'; // GY-887: both are Graphyard's own, never CI inputs to the verdict
export const stages = ['backlog', 'ready', 'build', 'review', 'test', 'acceptance', 'merge', 'done'] as const;
export type Stage = typeof stages[number];
export const sliceIds = ['product', 'infrastructure', 'docs-experience'] as const; export type SliceId = typeof sliceIds[number];
/** The shipped setting: every new item is system-driven unless its intent says `"systemDriven": false`. */
export const systemDrivenDefault = true;
export { declaredPostDeploy, liveObservationPhrase, postDeployCriterionRefusal, postDeployOnlyRefusal, postDeployProof, postDeployProofPrefix, postDeployProofs } from './post-merge-proofs.js';
export type ObservationWindow = z.infer<typeof observationWindowSchema>;
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
// The master's operator-agent identity applies intent with no capability (engine.ts `operatorCommands`); these name the rest.
// `e2e:record` (GY-1614) admits only the scenario registry and its run route: a candidate's UAT case runs.
export const operatorCapabilities = ['policy:requirements', 'policy:review-provider', 'policy:bootstrap', 'e2e:record'] as const;
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
  /** GY-3215: an invited teammate's role (server/principals.ts `teamRoles`); set only by an invite, on a reader human. */
  team?: 'viewer' | 'maintainer';
  scope?: { repositories: string[]; workItems: string[] };
  [operatorCredentialHash]?: string;
}
export interface AssignmentIdentity { owner: string; epoch: number; displayName?: string; runtime?: string; claimedAt?: string }
export interface Lease { owner: string; epoch: number; expiresAt: string }
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
  /** Pull-request-era fields (GY-2010): a document observed before the control plane became the merge writer still loads; the control plane writes neither. */
  prState?: 'open' | 'closed'; draft?: boolean; prCreatedAt?: string;
  /** Pull-request-era check runs; the control plane records none (`checks: []`) and no gate reads them. */
  candidate: Candidate; checks: { name: string; result: string; appId: number; id?: number; attempt?: number; source?: 'status' }[];
  reviews: { reviewer: string; sha: string; state: string; id?: number; submittedAt?: string; body?: string; blocking?: string[]; source?: string; baseSha?: string }[]; // body: a change request's text, read past the review-round cap; blocking: its BLOCKING: findings, read from the whole body (GY-1118); baseSha: the base a control-plane verdict judged against, its launch's baseTip (GY-2948 AC-2)
  merged: boolean; mergeSha: string | null; mergedAt?: string | null; mergeable: boolean;
  /** A pull-request-era conflict reading; the control plane's own test merge decides conflicts (model/base-refresh.ts). */
  conflicting?: boolean;
  // The real base-branch head and its tree, recorded separately from the candidate's bound base
  // so a held binding never hides where the managed branch actually points.
  baseTip?: string; baseTree?: string;
  /** The head's merge base with that tip: the base both the scope diff (GY-2082) and the review that judges the head (GY-2948) diff against. Absent on observations recorded before it was kept. */
  mergeBase?: string;
  // The head contains that base tip by ancestry. A review is only requested for a head that does.
  baseTipContained?: boolean;
  protected: boolean; files: string[]; at: string;
  /** The candidate diff compared against its bound base; see regression-guard.ts. */
  scopeFiles?: ScopeFile[];
  /** The same judgement against the commit the candidate would land on, and the unlanded work its head carries; see model/landing-check.ts. */
  landing?: LandingCheck;
  revertedDelivery?: RevertedDelivery; // a merged change whose content the base branch does not hold; see model/landing-check.ts
}
/**
 * GY-3266: the requirements revision an attempt's live lease has not synced yet. A revision under
 * a live lease is recorded at once and the lease stays; this marker is what the worker reads at
 * its next sync or status (the revised criteria with what changed), what `complete` refuses on
 * until that sync acknowledges it (a heartbeat naming the policy revision), and what a fresh
 * claim clears, since a new attempt starts under the current criteria.
 */
export interface UnsyncedRevision { policyRevision: number; at: string; by: string; changed: string[] }
/** GY-3266: what one requirements revision changed, one line per criterion — added, changed or removed. */
export function criteriaChanges(previous: readonly Criterion[], revised: readonly Criterion[]): string[] {
  const before = new Map(previous.map(ac => [ac.id, ac.text])), after = new Map(revised.map(ac => [ac.id, ac.text]));
  const lines = [...after].map(([id, text]) => before.has(id) ? before.get(id) === text ? null : `${id} changed: ${text}` : `${id} added: ${text}`);
  const removed = [...before].filter(([id]) => !after.has(id)).map(([id, text]) => `${id} removed: ${text}`);
  return [...lines, ...removed].filter((line): line is string => line !== null).map(line => line.slice(0, 500));
}
export interface Gate { name: string; passed: boolean; reasons: string[] }
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
  /** GY-3266: set while a revision recorded under the attempt's live lease awaits the worker's sync; see UnsyncedRevision. */
  unsyncedRevision?: UnsyncedRevision | null;
  /** GY-2975: one warning per criterion whose text pins exactly one case, computed at create and requirements revision; absent when no criterion does. */
  warnings?: string[];
  retiredCriterionIds?: string[];
  formalReviewResetRequired?: boolean;
  formalReviewBaseline?: { pr: number; policyRevision: number; reviewIds: number[] };
  // Append-only identities that have held an assignment. Trusted proof producers
  // must stay independent of every one of them, not only the latest assignment.
  implementers?: string[];
  id: string; key: string; stage: Stage; revision: number; policyRevision: number;
  createdAt: string; updatedAt: string; stageEnteredAt: string; ready: boolean;
  epoch: number; lease: Lease | null; lastAssignment?: AssignmentIdentity; workspaces: Workspace[]; candidate: Candidate | null;
  submission: { epoch: number; pr: number } | null;
  /**
   * The open decision only a human may make, recorded by the attempt that reached it. Recording it
   * ended that attempt's lease and parked the item; the answer clears it, and answered requests
   * are kept in `humanRequests` (see model/human-request.ts).
   */
  humanRequest?: HumanRequest | null; humanRequests?: HumanRequest[];
  /** Set when the item was closed without delivery (model/closure.ts); a closed item is `done` but never delivered. */
  closure?: Closure | null;
  /** Sessions of this item that ran out of provider quota, and any role with no account left (model/capacity.ts). */
  capacity?: CapacityState | null;
  /**
   * The last time the control plane brought this candidate onto a base branch that had moved
   * under it, or refused to because the merge conflicts. Decided and written by Graphyard
   * alone; see model/base-refresh.ts for the rule and model/carry.ts for what the refresh carries.
   */
  baseRefresh?: BaseRefresh | null; baseRefreshRequest?: BaseRefreshRequest | null; mergeRefusal?: MergeRefusal | null; // baseRefreshRequest: the standing request to merge a repaired base in (GY-528); mergeRefusal: the guarded merge's refusal (GY-831)
  reworkRequested: boolean;
  /** The last rework applied: its reason, the binding the loop sent it back on, and when (GY-1569's brief). */
  lastRework?: { reason: string; binding: string | null; at: string } | null;
  scenarioRequirements: { proof: string; revision: number; environment: string; hash: string }[];
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
  /** A yard repair (GY-3102): released past the pipeline cap, dispatched first, merged first. */
  yardRepair?: boolean;
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
