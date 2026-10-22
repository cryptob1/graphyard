import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { jsonChanged, stableJson } from './model/stable-json.js';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { Store, save, rewriteDocument, lockItem, wakeJob, documentBefore, eventWorkSql } from './store.js';
import { commitLockWaitMs, reconcileCommitBlockingSql, reconcileRereadSql, reconcileRowLockSql, reconcileRowsSql, reconcileVersionsSql } from './store/coordination-sql.js';
import { advisoryLocks } from './store/locks.js';
import { leaseCommands } from './store/pools.js';
import { compactHeartbeatReceipt } from './store/receipts.js';
import { authorizedForProof, unauthorizedProofs } from './model/proof.js';
import { workspacePath, pathsOverlap, validBranch } from './workspace.js';
import { activeLease, dropRetiredQueueFields, dropRetiredScopeFields, admin, assertReviewerProfiles, operatorCapability, operatorScopeIncludes, releaseLeadHold, submittedEpoch, stallCovering, type PlaneStall, requireCurrent, createSchema, criteriaSchema, criterionSchema, bindingApproval, carriedApproval, currentCarry, refreshedCarriedApproval, currentEvidence, attachedCriteria, exerciseRefusal, proofExerciseSchema, decideCarry, exactApproval, type CarriedApproval, deploySmokeProof, deploySmokeRequired, inheritedObligations, pathScopeContains, pathScopesOverlap, requiredProofs, resourcesSchema, demand, evaluate, exhaustedReviewerProfiles, proofSchema, reviewerProfileFor, reviewerProfileSchema, reviewProviders, reviewProviderOf, type Criterion, type Evidence, type Lease, type Principal, type ReviewerApp, type ReviewFailover, type Work, type Observation, type ReviewRequest, type OperatorCapability, deferBoundMs, observationWindowHold, servingReleaseProof } from './model.js';
import { filedFollowUpWindow, followUpRequest } from './model/observation-window.js';
import { Refusal, demandWork } from './model/refusal.js';
import { resourceConflicts } from './coordination.js';
import { activeEngineers, delegationLimits, implementerIdentities, leadMay, producerIndependenceRefusal, sessionKind } from './delegation.js';
import { onto } from './model/base-refresh.js';
import { reconciliationRefusalPrefix, unauthorizedMergeViolation } from './model/merge-authorization.js';
import { gitRunnerFor, observeHead as observeLocalHead, type GitRunner } from './merge-writer/local-observation.js';
import { allocateChangeNumber } from './merge-writer/change-numbers.js';
import { buildIdentity } from './protocol-version.js';
import { liveDispatchHandleIds, reconcileAutoDispatch, type DispatchTransition } from './model/dispatch.js';
import { submittedBranchMoved } from './model/assignment.js';
import { reconcileReviewConflict, type ReviewConflictTransition } from './model/review-conflict.js';
import { actionAccount, nextActionKinds, sameAction } from './model/next-action.js';
import type { ActionAccount } from './model/action-account.js';
import { recordScenarioRun } from './test-runs.js';
import { resolveScenario } from './scenarios.js';
import { sameObservationInputs } from './model/observation-save.js';
import type { ObservationJobState } from './model/action-kinds.js';
import { claimCandidatesParams, claimCandidatesSql } from './model/action-candidates.js';
import { claimAction, openActions, reconcileActions, renewClaim, settleAction, settleDelivered, type ActionRow } from './model/actions.js';
import { livenessFallback, livenessOf, livenessRepairEntry, rowDueAt, stalledActionLifts, waitDueAt } from './model/liveness.js';
import { agentRequestSchema, boundedAgentRequests, deciderFor, expireAgentRequests, leaseHeldRequestTypes, requestResolutionRefusal, type AgentRequest } from './model/agent-requests.js';
import { recordSession, sessionHandleSchema, sessionObservationFields } from './model/sessions.js';
import { noSubmissionRenewalRefused, observeHead, workerNoSubmissionRefusalMs } from './model/attempt-bound.js';
import { observeBaseHold } from './model/behind-base.js';
import { blockedAttemptMarker, partialWorkSchema, retainedExhaustions, type ExhaustionRecord } from './model/capacity.js';
import { credentialBlockedReason, credentialFailure } from './worker-credential.js';
import { beginAttempt, endAttempt, endLapsedAttempt, pipelineTimeline, recordAssignmentStart, recordIntervention, recordRework, recordSubmission } from './pipeline-speed.js';
import { loopOwnedRefusal, ownerHoldRefusal } from './model/loop-owned.js';
import { loopObservationProofs } from './model/loop-observation.js';
import { coveringWindow, directMergeAuthorization, directMergeFromEnv, directMergeWindows, sweepDirectMerges, type DirectMergeWindow } from './direct-merge.js';
import { mechanicalHoldUntil } from './mechanical-findings.js';
import { isSettledSummary, isStandIn, lockedRows, lockedWork, rememberSaved, savedVersions, warmLockedReads, withWhole, workIdByRef, type Queryable, type SavedVersion } from './store/locked-read.js';

const epoch = z.number().int().positive();
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const publicArtifactUrl = z.url().max(2000).refine(value => {
  const parsed = new URL(value);
  return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
}, 'Artifact URLs must be HTTP(S) and contain no credentials');
const evidenceArtifact = z.object({
  kind: z.enum(['log', 'report', 'screenshot', 'trace', 'other']), label: z.string().trim().min(1).max(200),
  mediaType: z.string().trim().min(1).max(200).optional(), size: z.number().int().min(0).optional(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(), expiresAt: z.iso.datetime().optional(),
  availability: z.enum(['available', 'expired', 'redacted', 'missing', 'upload-failed', 'external']), url: publicArtifactUrl.optional(),
}).strict().refine(value => value.availability === 'external' ? !!value.url : !value.url, 'Only external artifacts may carry a public URL');
// GY-1992: plannedFiles and scope widening are retired. An intent or a held decision recorded before then may still name them; they are ignored.
const retiredField = z.unknown().transform(() => undefined).optional();
const commands = {
  create: createSchema.extend({ reason: z.string().trim().min(1).max(2000).optional(), plannedFiles: retiredField }),
  ready: z.object({ expectedRevision: z.number().int().positive().optional(), reason: z.string().trim().min(1).max(2000).optional() }).strict(),
  requirements: z.object({ expectedPolicyRevision: z.number().int().positive(), reason: z.string().trim().min(1).max(2000), criteria: criteriaSchema(50), dependencies: z.array(z.string().uuid()).max(50), plannedFiles: retiredField, answers: retiredField, rule: retiredField, exclusiveResources: resourcesSchema, producerProofs: createSchema.shape.producerProofs }).strict(),
  unblock: z.object({ reason: z.string().trim().min(1).max(2000), expectedRevision: z.number().int().positive().optional() }).strict(),
  rework: z.object({ reason: z.string().min(1).max(2000), previousWorkerStopped: z.literal(true), binding: z.string().min(1).max(500).optional() }).strict(),
  claim: z.object({}).strict(),
  // GY-1764: the loop reports the review ledger's planned mechanical-fix round for the item (or its absence), the one ground the review gate's hold reads.
  mechanicalplan: z.object({ reviewId: z.number().int().positive(), head: sha, planned: z.boolean() }).strict(),
  heartbeat: z.object({ epoch }).strict(),
  // GY-860 AC-2: `failure` releases a claim whose worktree the host could not create. The attempt
  // is undone — the epoch returns, the untouched reservation and timeline entry go, the lease is
  // released — and the ledger keeps the git message, so the failure is on the item without
  // consuming an attempt or cooling off the profile.
  // `cause` is why the attempt ended, for a release its watch supervisor makes after the session is
  // gone (GY-1008): it is kept on the release event and never stands as a blocker on the item.
  release: z.object({ epoch, cause: z.string().trim().min(1).max(2000).optional(), failure: z.object({ message: z.string().trim().min(1).max(2000) }).strict().optional() }).strict(),
  // GY-860: what this allocation released before it could create its worktree — an earlier
  // attempt's worktree that still held the branch, with the refs and uncommitted diff it carried.
  // The record is the item's preserved-attempt history, kept on the ledger.
  workspace: z.object({ epoch, host: z.string().trim().min(1).max(200), path: z.string().startsWith('/').max(1000).refine(p => !/[\u0000-\u001f]/.test(p), 'Invalid path').transform(workspacePath), branch: z.string().max(255).refine(validBranch, 'Invalid Graphyard branch name'),
    preserved: z.object({ path: z.string().min(1).max(1000), head: z.string().regex(/^[0-9a-f]{40}$/i), branchTip: z.string().regex(/^[0-9a-f]{40}$/i), op: z.enum(['rebase', 'merge', 'cherry-pick']).nullable(), refs: z.string().max(20000), diff: z.string().max(100000), at: z.iso.datetime() }).strict().optional() }).strict(),
  // GY-1523: exactly one of `pr` (accepted only where GitHub observed it) or `head` (the control plane's own observation).
  submit: z.object({ epoch, pr: z.number().int().positive().optional(), head: sha.optional() }).strict()
    .superRefine((data, ctx) => { if ((data.pr === undefined) === (data.head === undefined)) ctx.addIssue({ code: 'custom', message: 'A submission names exactly one of pr (a pull request number) or head (a 40-hex commit)' }); }),
  // `partialWork` is how the worker's CLI kept what the attempt had not committed before the
  // blocker ended it (GY-1008): the same record an interrupted attempt carries.
  blocked: z.object({ epoch, reason: z.string().max(2000).nullable(), partialWork: partialWorkSchema.optional() }).strict(),
  // GY-1726: a post-deploy follow-up whose reading cannot exist before `notBefore` ends its attempt
  // and waits for that instant, with no blocker and no intervention: the loop dispatches it then.
  defer: z.object({ epoch, notBefore: z.string().datetime({ offset: true }), reason: z.string().trim().min(1).max(2000) }).strict(),
  // GY-1740: the master's (or the loop's) hold of an unleased post-deploy follow-up on the instant its
  // reading can first exist: the observation window `defer` sets, with no lease, and the recorded blocker cleared.
  window: z.object({ notBefore: z.string().datetime({ offset: true }), reason: z.string().trim().min(1).max(2000), expectedRevision: z.number().int().positive() }).strict(),
  // `scopeFiles` is the producer's declaration of what the proof depends on, in the planned-files
  // scope syntax; a base refresh carries a proof across its own authored merge only inside it.
  evidence: z.object({ proof: proofSchema, sha, baseSha: sha, policyRevision: z.number().int().positive(), result: z.enum(['pass', 'fail']), executed: z.number().int().min(0), skipped: z.number().int().min(0), url: publicArtifactUrl.optional(), artifacts: z.array(evidenceArtifact).max(30).optional(), scenarioRevision: z.number().int().positive().optional(), environment: z.string().min(1).max(100).optional(),
    scopeFiles: z.array(z.string().min(1).max(500)).min(1).max(100).optional(), provenance: z.object({
    provider: z.literal('github-actions'), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), workflowCommit: sha,
    runId: z.string().regex(/^[1-9]\d*$/), runAttempt: z.number().int().positive(),
    artifact: z.object({ id: z.number().int().positive(), name: z.string().min(1).max(200), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), url: publicArtifactUrl, createdAt: z.iso.datetime() }).strict(),
  }).strict().optional(),
    // GY-135: the same proof run against a tree with its criterion's behaviour removed.
    exercise: proofExerciseSchema.optional() }).strict(),
  // GY-1779: the loop's own reading of a loop-owned observation item's proof on the serving release,
  // recorded through the coordinator by its deployment-verification step: `sha` is the release the
  // control plane observed serving the parent delivery's merge `baseSha`; `detail` names the measured values.
  reading: z.object({ proof: proofSchema, sha, baseSha: sha, policyRevision: z.number().int().positive(), result: z.enum(['pass', 'fail']), detail: z.string().trim().min(1).max(2000) }).strict(),
  revoke: z.object({ proof: proofSchema, sha, baseSha: sha, policyRevision: z.number().int().positive(), reason: z.string().trim().min(1).max(2000) }).strict(),
  // The durable handle a launched session records on the item: its runtime and host, the runtime's
  // own workspace, tab and pane, and the transcript it writes. A fact, never authority; see model/sessions.ts.
  session: sessionHandleSchema,
  // A typed ask recorded instead of blocking on a prose question. The decider is derived, the
  // attempt ends in the same transaction, and the item is free again; see model/agent-requests.ts.
  request: agentRequestSchema,
  // The coordinator — the master loop's operator-agent identity — asking the control plane to merge
  // the base tip it names into a candidate a repaired base failure held (GY-528). The reconciliation
  // job runs it and records it on `baseRefresh`, where the binding carry decides what the head keeps.
  // No `mergerefused`: GitHub merges on every passing gate (GY-1235) and Graphyard keeps no guarded
  // merge (GY-1236), so nothing reports a merge refusal and none sends a candidate back (GY-1391).
} as const;
const executorName = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/);
const actionClaimSchema = z.object({
  /** The identity the claim is recorded under; the credential's own principal by default. */
  executor: executorName.optional(),
  host: executorName,
  /** The action kinds this executor can actually run. A kind it cannot run is left for one that can. */
  kinds: z.array(z.enum(nextActionKinds)).min(1).max(nextActionKinds.length).optional(),
  /** Every kind this executor has a handler for, whatever a launch hold lets it claim this tick (GY-1539); presence records it. */
  serves: z.array(z.enum(nextActionKinds)).min(1).max(nextActionKinds.length).optional(),
  leaseSeconds: z.number().int().min(10).max(900).optional(),
  work: z.string().min(1).max(200).optional(),
}).strict();
/** A presence-only poll (GY-1288): who is asking, where, and what it runs — a claim's own fields, claiming nothing. */
const actionSettleSchema = z.object({ executor: executorName.optional(), result: z.enum(['done', 'failed']), reason: z.string().trim().min(1).max(2000) }).strict();
// A renewal carries no result: it says only that the executor named on the claim is still
// inside the handler, and asks for the lease it already holds to run on.
const actionRenewSchema = z.object({ executor: executorName.optional(), leaseSeconds: z.number().int().min(10).max(900).optional() }).strict();
// A resync names the instant its claim was made, so the answer says whether an observation saved
// since then satisfies it; `wake: false` only reads, for an executor waiting on the job it woke.
const resyncSchema = z.object({ since: z.string().datetime({ offset: true }).optional(), wake: z.boolean().optional(), prioritized: z.boolean().optional(), wait: z.boolean().optional() }).strict();
const pullAssignmentSchema = z.object({ host: executorName.optional(), work: z.string().min(1).max(200).optional() }).strict();
/** The refusal a replay of one idempotency key with different input earns; read back by the pull. */
export const idempotencyMismatch = 'Idempotency key reused with different input';
export type Command = keyof typeof commands;
/** What the master's operator-agent identity applies directly, at once, under its own name. */
const operatorCommands = new Set<Command>(['create', 'ready', 'unblock', 'window', 'requirements', 'rework', 'evidence']);

function authorizeOperatorCommand(actor: Principal, command: Command, data: any, work: Work | undefined, repository: string) {
  demand(operatorCommands.has(command), 'This operation is not available to operator agents', 403);
  demand(!!repository && actor.scope?.repositories.includes(repository), 'Repository is outside this operator-agent scope', 403);
  if (work) demand(operatorScopeIncludes(actor, work), 'Work item is outside this operator-agent scope', 403);
  demand(command === 'evidence' || data.reason, 'Operator-agent mutations require a reason', 400);
  if (command === 'create') demand(actor.scope?.workItems.includes('*'), 'Creating work requires wildcard work scope', 403);
}

/**
 * The observation window `defer` (a worker) and `window` (the master or the loop, GY-1740) record: only
 * on a post-deploy follow-up, for a future instant within `deferBoundMs`; a later recorded window is never shortened.
 */
function observationHold(work: Work, notBefore: string, now: Date, basis: NonNullable<Work['observationWindow']>['basis'], detail: string) {
  demand(work.criteria.some(criterion => criterion.proofs.some(servingReleaseProof)), `${work.key} owes no post-deploy observation (no manual:…-on-serving-release proof); only a follow-up whose reading cannot exist yet is deferred — record a blocker instead`, 409);
  const at = Date.parse(notBefore);
  demand(at > now.getTime(), `notBefore ${notBefore} has already passed; the reading can be taken now`, 422);
  demand(at - now.getTime() <= deferBoundMs, `notBefore ${notBefore} is more than ${deferBoundMs / 86_400_000} days away; a reading that far off is a requirements question — record a blocker instead`, 422);
  if (!work.observationWindow || Date.parse(work.observationWindow.notBefore) < at)
    work.observationWindow = { notBefore: new Date(at).toISOString(), basis, detail: detail.slice(0, 2000) };
}

// Old deployments did not persist assignment labels. Preserve the known owner/epoch
// before clearing a legacy lease; its original claim time is unknown.
function preserveAssignment(work: Work) {
  if (work.lease && (!work.lastAssignment || work.lastAssignment.epoch < work.lease.epoch))
    work.lastAssignment = { owner: work.lease.owner, epoch: work.lease.epoch };
}

/**
 * The plane stalls recorded around `fromMs`..`untilMs` (wall-clock ms): the gaps in the
 * reconciliation loop's own ticks (recordPlaneLiveness), each once in the ledger with no work of its
 * own. They are read beside the attestations wherever a lapse is classed, so a lease that ran out
 * while the plane itself was down is explained by the plane's record rather than counted as a
 * lost worker (GY-1791). The `created_at` index serves the read; the window is bounded by the
 * caller to the lapse it is classing.
 */
export async function readPlaneStalls(db: { query: (text: string, values: unknown[]) => Promise<{ rows: any[] }> }, fromMs: number, untilMs: number): Promise<PlaneStall[]> {
  const rows = (await db.query(`SELECT payload->'details' AS details FROM events WHERE kind = 'plane.stall' AND created_at >= to_timestamp($1 / 1000.0) AND created_at <= to_timestamp($2 / 1000.0) ORDER BY created_at`, [fromMs, untilMs])).rows;
  return rows.map(row => { const details = row.details ?? {}; return { from: String(details.from), to: String(details.to) }; }).filter(stall => Number.isFinite(Date.parse(stall.from)) && Number.isFinite(Date.parse(stall.to)));
}
/**
 * The lease a worker submitted under ended at that submission. A supervisor that keeps renewing it
 * (or releases it) is told so, rather than left to read the loss as a superseded epoch.
 */
function endedBySubmission(work: Work, epoch: number) {
  if (!work.lease && submittedEpoch(work, epoch))
    demand(false, `Implementation lease for epoch ${epoch} ended when ${work.key} was submitted; stop heartbeating after complete`);
}

/** The violation an observed merge records when its gates had not passed on the merged head. */
export { unauthorizedMergeViolation };
/**
}
/**
 * Whether two readings of one item differ only in action-queue bookkeeping (GY-607). Claiming,
 * renewing, completing or failing a row moves the item's rows, its revision and its `updatedAt`,
 * and nothing a gate reads; everything else is compared by its stable JSON, so any other change
 * still counts.
 */
export function sameBesideActions(read: Work, current: Work): boolean {
  const rest = ({ actionQueue: _queue, revision: _revision, updatedAt: _updated, ...others }: Work) => stableJson(others);
  return rest(read) === rest(current);
}
/**
 * Whether two readings of one item differ only in the loop's own bookkeeping (GY-1257): the action
 * queue (`sameBesideActions`), plus what each save re-derives or the loop records about the item
 * rather than the submitted work — its next action and gates, the sessions it
 * reports. None of it is what a GitHub observation
 * reads, and the observation's own save re-evaluates the gates, so it never stands on a stale one.
 */
export function sameBesideBookkeeping(read: Work, current: Work): boolean {
  const rest = ({ actionQueue: _queue, revision: _revision, updatedAt: _updated, nextAction: _next, gates: _gates,
    sessions: _sessions, ...others }: Work) => stableJson(others);
  return rest(read) === rest(current);
}
/** How many saves behind a reader may be and still have its read resolved from the ledger. */
export const actionOnlyLookback = 20;
/**
 * Whether the item as it stood at `revision` — every save appends the document it wrote to the
 * ledger — differs from `work` only in action-queue bookkeeping. A writer that read the item at
 * that revision may then still write: what it read is what it would read now.
 */
export async function onlyActionsMovedSince(db: { query: (text: string, values: unknown[]) => Promise<{ rows: any[] }> }, work: Work, revision: number, same = sameBesideActions): Promise<boolean> {
  const read = await revisionAt(db, work, revision, actionOnlyLookback);
  return !!read && same(read, work);
}
/** The item as its save at `revision` wrote it to the ledger, when that save is at most `lookback` saves behind `work`. */
async function revisionAt(db: { query: (text: string, values: unknown[]) => Promise<{ rows: any[] }> }, work: Work, revision: number, lookback: number): Promise<Work | null> {
  const behind = work.revision - revision;
  if (!Number.isInteger(behind) || behind <= 0 || behind > lookback) return null;
  const read = (await db.query(`SELECT ${eventWorkSql('saved')} AS work FROM (SELECT work_id, payload FROM events WHERE work_id=$1 AND (payload ? 'work' OR payload ? 'delta') ORDER BY seq DESC OFFSET $2 LIMIT 1) saved`, [work.id, behind])).rows[0]?.work as Work | undefined;
  return read && read.revision === revision ? read : null;
}

/**
 * Why the record as it stood before the merge cutoff does not deliver the observed merge, or
 * nothing when it does (GY-1235). GitHub merges; a merge is the delivery when the record showed the
 * merged head as its candidate on the merged pull request with every gate passed — build, review,
 * required checks — and no violation standing. GitHub's merge answers its own mergeability, so a
 * merge gate held only on GitHub computing or refusing mergeability does not refuse it. No merge
 * authorization, execution or observation age is read. Read for a delivery and for a reconciliation.
 */
export function historicalAuthorizationRefusals(past: Work, _all: Work[], observation: Observation, _cutoff: number, _mergedTime: number, options: { reconciling?: boolean } = {}): string[] {
  const refusals: string[] = [];
  if (past.candidate?.sha !== observation.candidate.sha)
    refusals.push(`the record named candidate ${past.candidate?.sha.slice(0, 12) ?? 'none'}, not the merged head ${observation.candidate.sha.slice(0, 12)}`);
  if (past.submission?.pr !== observation.candidate.pr) refusals.push(`the record named pull request #${past.submission?.pr ?? 'none'}, not #${observation.candidate.pr}`);
  // A reconciliation judges the merge that happened, so nothing that merge itself wrote can refuse
  // it (GY-94): the unauthorized-merge violation it exists to clear, and a refusal of an earlier
  // decision.
  const circular = (violation: string) => options.reconciling && (violation === unauthorizedMergeViolation || violation.startsWith(reconciliationRefusalPrefix));
  const githubAnswers = (reason: string) => reason === 'Pull request is not mergeable against the current base';
  for (const gate of past.gates) {
    const reasons = gate.name === 'merge' ? gate.reasons.filter(reason => !githubAnswers(reason)) : gate.reasons;
    if (!gate.passed && reasons.length) refusals.push(`gate ${gate.name} had not passed: ${reasons.join('; ')}`);
  }
  for (const violation of past.violations.filter(violation => !circular(violation))) refusals.push(`violation stood: ${violation}`);
  return refusals;
}
/** How a merge inside a direct-merge window (direct-merge.ts) was recorded as operator-authorized: `unmet` is what the record lacked. */
export interface OperatorAuthorizedDelivery {
  /** Who set the direct-merge window the merge fell inside, and why. */
  operator: string; reason: string; unmet: string[];
  cutoff: string; snapshotRevision: number; judgement: string; violation: string;
  /** Always null: the statement that no merge execution authorized this merge. */
  execution: null;
}
/** The ledger kind of a lease renewal that failed server-side (GY-558). */
export const renewalFaultEvent = 'lease.renewal-failed';
/** A lease carrying the server-side renewal fault that extended it (GY-558); cleared by the next renewal. */
type GracedLease = Lease & { renewalFault?: { at: string; error: string } };
/** A renewal that failed server-side: 503, with the grace its recorded fault earned, if any. */
export class RenewalFault extends Refusal {
  constructor(message: string, readonly grace: { at: string; graceUntil: string; now: string } | null) { super(message, 503); }
}
/** The SQLSTATE classes a failed renewal may blame on the server (GY-671): connection exceptions,
 * insufficient resources, program limits, operator intervention (statement timeouts among them),
 * system errors and internal errors. Client-caused classes — bad data, constraint violations,
 * syntax, privileges, serialization and deadlock — are the request's own and earn nothing. */
const renewalFaultSqlClasses = new Set(['08', '53', '54', '57', '58', 'XX']);
/** The connection-level failures a renewal may blame on the server, named by message or errno. */
const renewalFaultMessage = /connection|terminated|timed? ?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up/i;
/** The connection errnos a failed renewal may blame on the server, whatever its message says. */
const renewalFaultErrnos = /^ECONN(RESET|REFUSED|ABORTED)|^ETIMEDOUT$|^EPIPE$|^E(HOST|NET)UNREACH$|^EAI_AGAIN$/;
/**
 * What a failed renewal blames on the server, or null when it may not (GY-558, narrowed by
 * GY-671): only infrastructure trouble — lost or timed-out connections, statement timeouts and
 * the database's server-error classes — never a programming error. A TypeError in a heartbeat
 * must surface as the bug it is instead of silently extending the lease it broke, so anything
 * this cannot name as the server's fault is answered as a refusal, with no grace and no record.
 */
export function renewalFaultOf(error: unknown): string | null {
  if (error instanceof Refusal) return error.status >= 500 ? `HTTP ${error.status}: ${error.message}` : null;
  if (error instanceof z.ZodError) return null;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') {
    if (renewalFaultErrnos.test(code)) return `${code}: ${(error as Error).message}`;
    if (/^[0-9A-Z]{5}$/.test(code)) return renewalFaultSqlClasses.has(code.slice(0, 2)) ? `SQLSTATE ${code}: ${(error as Error).message}` : null;
  }
  const message = error instanceof Error ? error.message : String(error);
  return renewalFaultMessage.test(message) ? message : null;
}
/** How far back heartbeat health looks, and the p95 latency above which `master status` raises it (GY-558). */
export const leaseHealthWindowMs = 10 * 60_000, heartbeatLatencyAttentionMs = 5_000;
/**
 * Heartbeat latency and the renewals refused or failed server-side, over the last ten minutes in
 * this server process (GY-558), reported by GET /api/status as `leaseHealth`. The window is one
 * process's own, and the report says so (`scope` and `process`, GY-671): a multi-replica
 * deployment serves renewals from every replica and each reports separately, so fleet-wide p95
 * and failure counts are the per-replica reports compared, not one number. Aggregating them in
 * the server was declined there — it needs cross-replica state the store does not hold and would
 * put metric writes beside the coordination path — so the attention item repeats the caveat
 * whenever it is raised, naming the process that measured it.
 */
export class LeaseHealth {
  private samples: { at: number; ms: number; outcome: 'renewed' | 'refused' | 'failed' }[] = [];
  record(outcome: 'renewed' | 'refused' | 'failed', ms: number, at = Date.now()) {
    this.samples.push({ at, ms: Math.max(0, ms), outcome });
    this.prune(at);
    if (this.samples.length > 20_000) this.samples.splice(0, this.samples.length - 20_000);
  }
  private prune(now: number) {
    const since = now - leaseHealthWindowMs;
    const first = this.samples.findIndex(sample => sample.at >= since);
    this.samples.splice(0, first < 0 ? this.samples.length : first);
  }
  report(now = Date.now()) {
    this.prune(now);
    const sorted = this.samples.map(sample => sample.ms).sort((a, b) => a - b);
    const percentile = (p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] : null;
    const p50Ms = percentile(0.5), p95Ms = percentile(0.95);
    const refused = this.samples.filter(sample => sample.outcome === 'refused').length, failed = this.samples.filter(sample => sample.outcome === 'failed').length;
    const reportedBy = `${hostname()}/${process.pid}`;
    const attention = p95Ms !== null && p95Ms > heartbeatLatencyAttentionMs
      ? `Lease renewals are slow: heartbeat p95 ${p95Ms} ms (p50 ${p50Ms} ms) over the last 10 minutes exceeds ${heartbeatLatencyAttentionMs} ms across ${sorted.length} renewal(s), ${failed} failed server-side and ${refused} refused; a renewal slower than the lease loses it — find what holds the coordination lock or the lease pool in the server logs. This window is one server process's own (${reportedBy}); a multi-replica deployment reports each replica separately, so slow renewals served by other replicas are missing here.`
      : null;
    return { windowMs: leaseHealthWindowMs, renewals: sorted.length, p50Ms, p95Ms, refused, failed, thresholdMs: heartbeatLatencyAttentionMs, attention, scope: 'process' as const, process: reportedBy };
  }
}

/** A reconciliation batch that found the coordination lock held past its wait before it wrote (GY-727, GY-1290): it runs again. */
class ReconcileContended extends Error {}
/**
 * One reconciliation tick's outcome (GY-1115, GY-1290): every candidate is evaluated or deferred.
 * `writes` counts the items its batches wrote, and `lockWaitMs` is the longest a batch waited in
 * line for the coordination lock before writing them: the one place a tick waits on other writers.
 * `full` says why the tick evaluated every live item, or is null when it evaluated only the items
 * whose inputs moved, and `lagMs` is the event-loop lag sampled over the tick's window (GY-1777),
 * null when the window held no sample. `due` counts the items a non-full tick evaluated because
 * their recorded due instant had passed (GY-1873), not because an input moved. `faces` lists the
 * fleet faces a writer outside the pass moved that the tick decided on (GY-1898) — also on a full
 * tick, where `full.moved` names them again — and `readers` counts the live items those faces made
 * evaluated: the moved ones and the ones whose evaluation reads them.
 */
export interface ReconcileTick { at: string; candidates: number; evaluated: number; deferred: number; maxAttempts: number; ms: number; writes: number; lockWaitMs: number; due: number; full: ReconcileFull | null; faces: FaceMove[]; readers: number; lagMs: { p50: number; max: number } | null }
/** How long the reconciliation loop may go between passes before the gap is recorded as a plane stall (GY-1791): the loop is driven every couple of seconds, so a minute is dozens of missed passes. */
export const planeStallMs = 60_000;
/**
 * How long past a recorded stall's end a lease the stall kept may stand (GY-1801): the window a
 * still-retrying supervisor needs to land the renewal the stall ate. A supervisor's renewals wait
 * under its lease window and retry within a doubling backoff capped at ten seconds (`supervisor.ts`),
 * so one that was mid-renewal when the plane stopped answering lands a fresh one well inside thirty
 * seconds of its recovery — a full lease period keeps a lease nobody renews standing instead, and a
 * pane closed under a lease only the stall keeps is exactly the live-lease close the soak's
 * invariant forbids (GY-1801). The window therefore ends far inside the loop's own exited-pane
 * sighting (`cycle-sessions.ts` sights a pane whose runtime left twice, `launchAppearanceMs` apart),
 * and well past the retry the grace exists for.
 */
export const stallRenewalWindowMs = 30_000;
/** One item whose fleet face moved (GY-1777): which face fields, or `new` for an item the view first read and `gone` for one deleted. */
export interface FaceMove { id: string; key: string; fields: string[] }
/**
 * Why a tick evaluated every live item (GY-1777, GY-1898): the kept view was empty (`view`: the
 * first pass of a process, or one after a reset), the merge configuration changed, or the
 * full-evaluation interval elapsed — since GY-1898 these are the only full passes, for a fleet
 * face a writer moved is decided the way the pass's own moved faces are (GY-1777), on the tick's
 * `faces`. `moved` lists the faces other writers moved that the full pass also decided on.
 */
export interface ReconcileFull { cause: 'view' | 'configuration' | 'interval'; moved: FaceMove[] }

/**
 * One item in the reconciliation view kept between passes (GY-1124). `due` is what the item's last
 * evaluation read as the earliest instant at which its outcome could change with no write
 * (GY-1873): null until an evaluation of the document as it stands has run, and stale the moment
 * the document moves — every reread and every write re-records it from the evaluation of what
 * stands then.
 */
interface ReconcileEntry { number: number; work: Work; version: string; settled: boolean; face: string; due: number | null }
/** A write a reconciliation batch planned (GY-1290): its evaluation of the item, on a copy, at the row version and the clock it read, with the due instant that evaluation read (GY-1873). */
interface ReconcilePlan { id: string; work: Work; version: string; now: Date; due: number | null }
/** One planned write, committed: whether it wrote, whether later planned items must be evaluated again, and what to keep of it once committed. */
interface ReconcileWritten { wrote: boolean; stale: boolean; faceMoved: OwnFaceMove | null; saved: SavedVersion[]; apply: () => void }
/** The running pass's kept view and its readers, as one planned write needs them. */
interface ReconcilePass {
  fleet: Map<string, ReconcileEntry>; all: () => Work[]; view: () => void; lockWait: (ms: number) => void;
  versionsOf: (db: PoolClient) => Promise<Map<string, string>>; moved: (versions: Map<string, string>) => string[]; reread: (db: PoolClient, ids: string[]) => Promise<FaceMove[]>;
}
/**
 * What other items' evaluations can read of an item (GY-1124): its document without the fields a
 * renewal moves — the revision, the update time, the lease's expiry, and an action claim's expiry
 * and renewal count (GY-1276), and the assignment's session start the first renewal stamps
 * (GY-1499). A heartbeat or an executor's claim renewal leaves the face unchanged, so the pass
 * after it evaluates only the renewed item; any other write changes it, and
 * the pass evaluates every live item against it, unless the write was a reconciliation pass's own
 * (GY-1777): that pass evaluated against it as planned, so the next evaluates only the items whose
 * evaluation reads it (`readsFace`: by reference, as a split sibling, through a shared exclusive
 * resource or an overlapping path scope). A claim expiring is a move of the clock alone, which the
 * bounded full evaluation (`reconcileFullEvaluationMs`) catches up.
 */
function fleetFace(work: Work) {
  const { revision: _revision, updatedAt: _updatedAt, lease, actionQueue, lastAssignment, ...rest } = work;
  const assignment = lastAssignment && (({ startedAt: _startedAt, ...identity }) => identity)(lastAssignment);
  const actions = actionQueue && {
    ...actionQueue,
    actions: actionQueue.actions.map(row => {
      if (!row.claim) return row;
      const { expiresAt: _expiresAt, renewedAt: _renewedAt, renewals: _renewals, ...claim } = row.claim;
      return { ...row, claim };
    }),
  };
  return stableJson({ ...rest, lastAssignment: assignment, actionQueue: actions, lease: lease ? { owner: lease.owner, epoch: lease.epoch } : null });
}
/**
 * The face fields that differ between two fleet faces (GY-1777), as the slow-tick warning names
 * them: `new` when the view held no face before, `gone` when it holds none after.
 */
function faceFields(before: string, after: string): string[] {
  if (!before) return ['new'];
  if (!after) return ['gone'];
  const a = JSON.parse(before) as Record<string, unknown>, b = JSON.parse(after) as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(field => JSON.stringify(a[field]) !== JSON.stringify(b[field])).sort();
}
/** The moves merged by item (GY-1777): one entry per item in the order first seen, its fields the union of every move's. */
function mergeFaceMoves(moves: Iterable<FaceMove>): FaceMove[] {
  const merged = new Map<string, FaceMove>();
  for (const move of moves) {
    const known = merged.get(move.id);
    merged.set(move.id, known ? { ...known, fields: [...new Set([...known.fields, ...move.fields])].sort() } : move);
  }
  return [...merged.values()];
}
/**
 * The earliest instant at which this evaluated document's outcome could change with no write
 * (GY-1873): the minimum over the time-bounded inputs its evaluation read — the lease's expiry,
 * every open row's due (its claim, its retry, its settle window, the idle bound), the bound the
 * named wait runs to, the observation window's opening, every evidence record's expiry, the review
 * gate's mechanical hold and a running split's dispatch hold, and the
 * widest backoff a stalled action's escalation lifts at. Instants already past are ignored: what they guarded has flipped already
 * (or needs a write, or the full evaluation), and a past due would wake the item every pass. Null
 * when the document holds none — then only a write or the full evaluation can change the outcome,
 * and the item is never evaluated as due. A wait on another item is deliberately absent: nothing
 * on this document flips when that instant passes — the other item's own due and the face its
 * evaluation writes reach the waiter through `readsFace`.
 */
function reconcileDueAt(work: Work, all: Work[], now: Date, account: ActionAccount): number | null {
  const nowMs = now.getTime();
  let due: number | null = null;
  const consider = (at: number | null | undefined) => { if (at != null && Number.isFinite(at) && at > nowMs && (due === null || at < due)) due = at; };
  const considerIso = (value: string | null | undefined) => { if (value) consider(Date.parse(value)); };
  considerIso(work.lease?.expiresAt);
  for (const row of work.actionQueue?.actions ?? []) considerIso(rowDueAt(row, now));
  if (!account.action && account.wait && account.wait.kind !== 'dependency') considerIso(waitDueAt(work, account.wait, all, now));
  considerIso(work.observationWindow?.notBefore);
  // Accepted evidence stops counting once its expiry passes (currentEvidence), so a gate can fail by the clock alone.
  for (const evidence of work.evidence ?? []) considerIso(evidence.expiresAt);
  // The review gate's mechanical hold lapses at its round window, and dispatch's wait on a running split at its limit and grace.
  consider(mechanicalHoldUntil(work, nowMs));
  for (const lift of stalledActionLifts(work)) consider(lift);
  return due;
}
/** A fleet face the pass's own planned write moved (GY-1777): the move, and the item's document before and after it. */
interface OwnFaceMove { move: FaceMove; before: Work; after: Work }
/**
 * The document a moved face's readers last saw (GY-1898): the recorded face parsed back. A fleet
 * face keeps every field of the document another item's evaluation reads (`fleetFace` strips only
 * the fields no evaluation reads of another item), so the face the view held stands in for the
 * document the move left wherever the whole document is no longer kept.
 */
function faceDocument(face: string): Work | null { return face ? JSON.parse(face) as Work : null; }
/**
 * What a moved face reaches (GY-1777, GY-1898): every way one item's evaluation reads another's face. By
 * reference, as a dependency, a wait on it or a follow-up of its delivery: its id or key stands in
 * the reader's own face (`mention`). Through an exclusive resource both name (`resourceConflicts`). Through path
 * scope (`fileConflicts`, `inheritedObligations`): the reader's observed and landing-check files
 * against the moved item's observed files, the
 * contract paths of a bootstrap deferral it declares, and those of any deferral whose proof its
 * evidence may have delivered. Built from the document before and after the move — whole where the
 * view keeps it, the recorded face where it does not (`faceDocument`) — and every document a
 * repeated move passed through between them (`between`), so a reader of any of them is reached.
 * Either end is null when the move created or deleted the item.
 */
interface FaceReach { id: string; mention: RegExp; resources: Set<string>; paths: string[] }
interface FaceMoveSides { move: FaceMove; before: Work | null; after: Work | null; between?: Work[] }
function faceReach({ move, before, after, between = [] }: FaceMoveSides, all: Work[]): FaceReach {
  const sides = [before, ...between, after].filter((work): work is Work => !!work);
  const proofs = new Set(sides.flatMap(work => work.evidence ?? []).map(evidence => evidence.proof));
  const paths = new Set<string>();
  for (const work of sides) {
    for (const path of work.observation?.files ?? []) paths.add(path);
    for (const criterion of work.criteria ?? []) for (const path of criterion.bootstrap?.contractPaths ?? []) paths.add(path);
  }
  for (const work of all) {
    if (work.id === move.id) continue;
    for (const criterion of work.criteria ?? []) if (criterion.bootstrap && criterion.proofs.some(proof => proofs.has(proof))) for (const path of criterion.bootstrap.contractPaths) paths.add(path);
  }
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { id: move.id, mention: new RegExp(`${escaped(move.id)}|(^|[^A-Za-z0-9])${escaped(move.key)}(?![A-Za-z0-9])`),
    resources: new Set(sides.flatMap(work => work.exclusiveResources ?? [])), paths: [...paths] };
}
/** The paths other items' evaluations read an item on (GY-1777): the files its candidate was observed to change, and the ones its landing check compared. */
function readerPaths(work: Work): string[] {
  return [...work.observation?.files ?? [], ...(work.observation?.scopeFiles ?? []).map(file => file.path), ...(work.observation?.landing?.files ?? []).map(file => file.path)];
}
/** Whether `entry`'s evaluation reads the moved face `reach` describes (GY-1777). */
function readsFace(entry: ReconcileEntry, reach: FaceReach) {
  const work = entry.work;
  if (work.id === reach.id) return false;
  if (reach.mention.test(entry.face)) return true;
  if ((work.exclusiveResources ?? []).some(resource => reach.resources.has(resource))) return true;
  return readerPaths(work).some(path => reach.paths.some(other => pathScopesOverlap(path, other)));
}
/** The moved faces as the slow-tick warning names them (GY-1777): each by key and the fields that changed on it. */
function describeFaceMoves(moves: FaceMove[]) {
  return `the fleet face of ${moves.map(move => `${move.key} (${move.fields.join(', ')})`).join(', ')} moved`;
}
/** The slow-tick warning's account of a full pass (GY-1777, GY-1898): its cause, and every face another writer moved beside it. */
function describeFull(full: ReconcileFull) {
  const moved = full.moved.length ? describeFaceMoves(full.moved) : '';
  const cause = { view: 'the kept view was empty (the first pass of this process, or one after a reset)', configuration: 'the merge configuration changed', interval: 'the full-evaluation interval elapsed' }[full.cause];
  return moved ? `${cause}, and ${moved}` : cause;
}
/** The event-loop lag sampler's timer interval (GY-1777); a sample is that timer's overrun past it. */
const eventLoopLagResolutionMs = 10;
/** The most samples one window keeps (GY-1777): ten minutes at the resolution; a longer window keeps its first ten minutes. */
const eventLoopLagSamples = 60_000;
/**
 * The event-loop lag over one reconciliation tick's window (GY-1777): a timer due every
 * `eventLoopLagResolutionMs` records how far past due it ran, the reading
 * `perf_hooks.monitorEventLoopDelay` gives, kept here because that histogram cannot be windowed
 * per tick (on Node 24 `reset()` stops it recording, and a histogram enabled after one was disabled
 * never fires). The timer holds the process open for nothing.
 */
export class EventLoopLag {
  private samples: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  private due = 0;
  /** Open a window: samples from now on belong to it. */
  start() {
    this.stop();
    this.due = performance.now() + eventLoopLagResolutionMs;
    this.timer = setInterval(() => {
      const now = performance.now();
      if (this.samples.length < eventLoopLagSamples) this.samples.push(Math.max(0, now - this.due));
      this.due = now + eventLoopLagResolutionMs;
    }, eventLoopLagResolutionMs);
    this.timer.unref();
  }
  /**
   * The window's lag so far: p50 and max in ms, or null when the window holds no observation yet.
   * A sample exists only once its timer callback has run, so a hold of the loop that ended just
   * before this read — the callback that elapsed during it still queued behind the caller's own
   * work — would go unrecorded and the tick would read no lag at all (GY-1886). The overrun the
   * next callback is still owed counts beside the recorded samples, so a block is seen however the
   * event loop orders its read against the timers phase; when nothing is owed and no callback has
   * run, nothing has been observed and the read says so. Nothing owed is no observation, so it adds
   * no 0 ms sample to pull p50 below what the recorded callbacks saw.
   */
  read(): { p50: number; max: number } | null {
    const pending = this.timer ? Math.max(0, performance.now() - this.due) : 0;
    const sorted = (pending > 0 ? [...this.samples, pending] : [...this.samples]).sort((a, b) => a - b);
    if (!sorted.length) return null;
    return { p50: Math.round(sorted[Math.ceil(sorted.length / 2) - 1]), max: Math.round(sorted[sorted.length - 1]) };
  }
  /** Close the window and forget its samples. */
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.samples = []; }
}
/**
 * The floor on how long reconciliation goes between full evaluations (GY-1867 stretches it past a
 * longer full pass): `GRAPHYARD_RECONCILE_FULL_MS`, 2000..300000 ms, default 300000 (GY-1873 — it
 * was 10000 under GY-1124, when nothing recorded when each item was next due; the per-item due
 * instants wake the clock-driven changes now, and the full evaluation is the rare safety net).
 */
export function configuredReconcileFullMs(value = process.env.GRAPHYARD_RECONCILE_FULL_MS, fallback = 300_000): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 2_000 && parsed <= 300_000 ? parsed : fallback;
}

/**
 * GY-1735: a post-deploy follow-up filed without its observation window takes the one its filing owed
 * it; one already recorded stands. The delivered item is read as its document: a settled stand-in
 * need not carry its criteria or deployment.
 */
async function adoptFollowUpWindow(db: Queryable, work: Work) {
  const request = work.observationWindow ? null : followUpRequest(work);
  const delivered: Work | undefined = request ? (await db.query('SELECT document FROM work_items WHERE id=$1', [request.work])).rows[0]?.document : undefined;
  const window = delivered ? filedFollowUpWindow(work, [delivered]) : undefined;
  if (window) work.observationWindow = window;
}
export class Engine {
  operatorAuthorizer?: (db: any, now: Date, actor: Principal) => Promise<Principal>;
  /** The direct-merge window the deployment environment declares (direct-merge.ts), read once at construction. */
  directMergeEnvironment: DirectMergeWindow | null = directMergeFromEnv();
  // The configured credential registry, used to report which required proof names
  // currently have an authorized producer. Authority itself lives in the grant store.
  principals: Principal[] = [];
  // Reviewer identities and the control-plane App are deployment facts, not client input.
  reviewerApps: ReviewerApp[] = [];
  controlPlaneAppId?: number;
  /**
  }
  /**
   * Observes the pull request a worker submits before the submission is recorded, so a candidate
   * that reverts shipped code outside its planned files is refused at `complete` instead of after
   * review. Left undefined, the deployment's GitHub App (from the environment) observes; null
   * disables the pre-check, and every later observation still re-derives the refusal.
   */
  submissionObserver: ((work: Work, peers?: Work[]) => Promise<Observation>) | null | undefined = undefined;
  /**
   * Reads a submitted head from the control plane's checkout (GY-1523) while the control plane is
   * the merge writer. Left undefined, `git -C` GRAPHYARD_REPOSITORY_ROOT (else the working
   * directory); null means no checkout, and every head submission is refused as unreadable.
   */
  gitRunner: GitRunner | null | undefined = undefined;
  /**
  /** The base branch a submitted head is observed against (GY-1523): the deployment's GITHUB_BASE_BRANCH, else `main`. */
  baseBranch = process.env.GITHUB_BASE_BRANCH ?? 'main';
  // Auto-dispatch transitions the last evaluation of a document produced, written to the ledger
  // by the transaction that persists it. Keyed by the object, so a probe clone records nothing.
  private dispatchTransitions = new WeakMap<Work, DispatchTransition[]>();
  private conflictTransitions = new WeakMap<Work, ReviewConflictTransition[]>();
  constructor(public store: Store, public leaseSeconds = 120, public repository = process.env.GITHUB_REPOSITORY ?? '') {}
  /** The commit this process first recorded itself serving (recordPlaneLiveness); undefined until its first tick named one (GY-2177). */
  private servedCommit: string | null | undefined;
  private async observeSubmission(actor: Principal, id: string | null, data: { epoch: number; pr?: number; head?: string }, key: string): Promise<Observation | null> {
    if (data.head !== undefined) return this.observeSubmittedHead(actor, id, { epoch: data.epoch, head: data.head }, key);
    if (this.submissionObserver === undefined) this.submissionObserver = null;
    if (!this.submissionObserver || !id) return null;
    // A replayed submission returns its receipt; it must not depend on the provider again.
    // `complete` is a lease command (GY-558): its reads take the lease pool, like its transaction.
    if ((await this.store.leasePool.query('SELECT 1 FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rowCount) return null;
    // Without a GitHub App there is nothing to read, and the transaction refuses the pull request.
    // The landing check reads each open submitted peer's observation scope, which a projection leaves
    // out (GY-1042): those peers are read whole. This read holds no coordination lock.
    const all = await withWhole(this.store.leasePool, await lockedWork(this.store.leasePool, [id]), peer => peer.stage !== 'done' && !!peer.submission && !!peer.candidate);
    const work = all.find(w => w.id === id || w.key === id);
    if (!work || work.stage === 'done' || !work.workspaces.some(w => w.epoch === data.epoch)) return null;
    // Every item goes with it: the landing check reads other items' unlanded candidates (GY-97).
    const observation = await this.submissionObserver({ ...work, submission: { epoch: data.epoch, pr: data.pr! } }, all);
    await this.reconcileLanded(observation, all);
    return observation;
  }
  /**
   * GY-1523: the control plane's own observation of a head submitted with `complete --head`, read
   * from the shared object store before the transaction, as GitHub is read for a pull request.
   * Receipt first, so a replayed `complete` runs no git. The candidate's change number is
   * allocated inside the transaction, which binds it to this observation.
   */
  private async observeSubmittedHead(actor: Principal, id: string | null, data: { epoch: number; head: string }, key: string): Promise<Observation | null> {
    if (!id) return null;
    if ((await this.store.leasePool.query('SELECT 1 FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rowCount) return null;
    // `complete` is a lease command (GY-558): its reads take the lease pool, like its transaction.
    const work = (await lockedWork(this.store.leasePool, [id])).find(w => w.id === id || w.key === id);
    const workspace = work?.workspaces.find(w => w.epoch === data.epoch);
    // GY-2010: an item a stored adoption (GY-1849) still names completes as a head like any other:
    // its replacement commit is read from the shared object store, never from the pull request.
    if (!work || work.stage === 'done' || !workspace) return null;
    if (this.gitRunner === undefined) this.gitRunner = gitRunnerFor(process.env.GRAPHYARD_REPOSITORY_ROOT ?? process.cwd());
    demand(this.gitRunner, 'The control plane has no checkout to read a submitted head from; a head submission needs the merge writer checkout', 503);
    return observeLocalHead(this.gitRunner, { head: data.head, base: this.baseBranch, branch: workspace.branch, author: actor.id });
  }
  /**
   * Observe a candidate head from the local Git repository checkout in control-plane mode.
   */
  async observeControlPlaneCandidate(work: Work): Promise<Observation | null> {
    if (!work.candidate) return null;
    if (this.gitRunner === undefined) this.gitRunner = gitRunnerFor(process.env.GRAPHYARD_REPOSITORY_ROOT ?? process.cwd());
    if (!this.gitRunner) return null;
    const observation = await observeLocalHead(this.gitRunner, {
      head: work.candidate.sha,
      base: this.baseBranch,
      branch: work.candidate.branch,
      author: work.candidate.author,
    });
    const recorded = work.observation?.reviews ?? [];
    observation.reviews = [...recorded];
    observation.reviewIds = observation.reviews.map(r => r.id).filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0);
    if (work.candidate.pr) observation.candidate.pr = work.candidate.pr;
    return observation;
  }
  /**
   * GY-744. Reconcile at once the merge of every peer an observation's landing check found already
   * on the base branch tip while its item still records it unlanded: the peer's pull request is
   * observed and that observation saved, so the ordinary delivery path records it merged, with its
   * merge commit, now rather than whenever its own observation comes round — and the stale state
   * that named it unlanded does not recur. A failure is logged and left to that later observation.
   *
   * GY-756. The peer is re-read before it is observed, so several observations in one round that
   * name the same peer do not each observe it from their own stale snapshot: once one has saved, the
   * rest find it delivered, or already observed at this head against this base tip, and skip it.
   * A peer that is not merged (its commits reached the branch while its pull request closed
   * unmerged) has that observation saved all the same, so it is not re-observed on every cycle
   * until the base branch moves.
   */
  async reconcileLanded(observation: Observation | null, all: Work[], observer = this.submissionObserver) {
    const reconciled: Work[] = [];
    if (!observer) return reconciled;
    for (const entry of observation?.landing?.landed ?? []) {
      const known = all.find(item => item.key === entry.key);
      if (!known) continue;
      try {
        const peer: Work | undefined = (await this.store.pool.query('SELECT document FROM work_items WHERE id=$1', [known.id])).rows[0]?.document;
        if (!peer || peer.stage === 'done' || peer.submission?.pr !== entry.pr) continue;
        if (peer.observation && peer.observation.candidate.sha === entry.head && observation!.baseTip && peer.observation.baseTip === observation!.baseTip) continue;
        const seen = await observer(peer, all);
        reconciled.push(await this.observe(peer.id, peer.revision, seen));
      } catch (error) {
        console.error(`[landing] reconciling ${entry.key}'s landed pull request #${entry.pr} failed: ${(error as Error).message}`);
      }
    }
    return reconciled;
  }
  /**
   * Bootstrap deferral is an operator act. It requires the explicit policy:bootstrap capability,
   * a reason and a contract scope. The audit fields are
   * stamped from the authenticated actor and the server clock, never taken from the request, and
   * an unchanged declaration keeps its original attribution across later revisions.
   */
  private declareBootstrap(actor: Principal, data: any, previous: Criterion[], policyRevision: number, now: Date, work?: Work): Criterion[] {
    return data.criteria.map((ac: any): Criterion => {
      if (!ac.bootstrap) return { id: ac.id, text: ac.text, proofs: ac.proofs };
      const prior = previous.find(existing => existing.id === ac.id)?.bootstrap;
      const unchanged = !!prior && prior.reason === ac.bootstrap.reason && JSON.stringify(prior.contractPaths) === JSON.stringify(ac.bootstrap.contractPaths);
      if (!unchanged) operatorCapability(actor, 'policy:bootstrap', work, this.repository);
      // An E2E proof pins a scenario revision, environment and hash on its own work item. An
      // inherited obligation carries no pin, so deferring one would let the heir satisfy it
      // against an unbound scenario version. Sequence those through the scenario registry.
      demand(!ac.proofs.some((proof: string) => proof.startsWith('e2e:')),
        `Criterion ${ac.id} cannot use bootstrap mode: an E2E proof pins a scenario version that an inherited obligation cannot carry forward`);
      return { id: ac.id, text: ac.text, proofs: ac.proofs, bootstrap: unchanged ? prior! : { ...ac.bootstrap, declaredBy: actor.id, declaredAt: now.toISOString(), policyRevision } };
    });
  }
  /** A deferral can never be renewed by the very change that inherited the obligation. */
  private refuseRenewedDeferral(work: Work, all: Work[]) {
    for (const obligation of inheritedObligations(work, all)) {
      const renewed = work.criteria.find(ac => ac.bootstrap && ac.proofs.includes(obligation.proof));
      demand(!renewed, `${renewed?.id}: ${obligation.proof} is already a bootstrap obligation inherited from ${obligation.key} ${obligation.criterionId} and cannot be deferred again`);
    }
  }
  /**
   * Run one command. A renewal is timed and counted in `leaseHealth` (GY-558), and one that fails
   * server-side — what `renewalFaultOf` blames on the server: a connection or statement timeout,
   * a lost connection, the database's server-error classes — is recorded against its lease
   * (`recordRenewalFault`) and answered 503 with the grace that record earns. Any other failure,
   * a programming error included, is refused without a grace, so bugs surface instead of
   * extending the lease they broke (GY-671).
   */
  async execute(actor: Principal, command: Command, id: string | null, input: unknown, key: string, context: { observation?: Observation } = {}) {
    if (command !== 'heartbeat') return this.executeCommand(actor, command, id, input, key, context);
    const started = new Date();
    this.renewing++;
    try {
      const work = await this.executeCommand(actor, command, id, input, key, context);
      this.leaseHealth.record('renewed', Date.now() - started.getTime());
      return work;
    } catch (error) {
      const fault = renewalFaultOf(error) !== null;
      this.leaseHealth.record(fault ? 'failed' : 'refused', Date.now() - started.getTime());
      if (!fault || !id) throw error;
      throw await this.recordRenewalFault(actor, id, Number((input as { epoch?: unknown } | null)?.epoch), started, error);
    } finally {
      if (--this.renewing === 0) for (const resume of this.renewalsDone.splice(0)) resume();
    }
  }
  /** Heartbeat latency and the renewals refused or failed server-side, in this server process (GY-558). */
  readonly leaseHealth = new LeaseHealth();
  /** Lease renewals in flight in this process, and the reconciliation steps waiting for them to finish (GY-1290). */
  private renewing = 0;
  private readonly renewalsDone: (() => void)[] = [];
  /**
   * The longest one reconciliation step waits for the renewals in flight (GY-1290). A renewal takes
   * no lock a waiting step holds, so the wait ends when they do; the bound only keeps a stream of
   * overlapping renewals from holding reconciliation back indefinitely.
   */
  reconcileYieldMs = 1_000;
  /**
   * Let a lease renewal run before reconciliation's next evaluation or write (GY-1290). Evaluation is
   * CPU work on the one event loop every request shares: a renewal's every query round trip would
   * otherwise resume only after the evaluation then running, so a renewal of a few round trips waited
   * through as many evaluations. Reconciliation first lets the event loop run — a due timer, an
   * arriving request included — then waits until no renewal is in flight, so a renewal waits on at
   * most the one evaluation it arrived during.
   */
  private async yieldToRenewals() {
    // A timer's yield (GY-1867), not `setImmediate`: a chain of immediate continuations keeps the
    // loop in the check phase, so timers scheduled while a long evaluation runs — the event-loop
    // sampler's included — fire only once it ends, and a tick reads as starved when it was itself.
    await new Promise(resolve => setTimeout(resolve, 0));
    if (!this.renewing) return;
    let timer: NodeJS.Timeout | undefined;
    await new Promise<void>(resolve => { this.renewalsDone.push(resolve); timer = setTimeout(resolve, this.reconcileYieldMs); });
    clearTimeout(timer);
  }
  /**
   * Record a renewal that failed server-side inside its lease's expiry window (GY-558): a
   * `lease.renewal-failed` event naming the owner, epoch and the time the renewal arrived,
   * written without the coordination lock. `renewalGrace` then keeps the lease valid until the
   * next successful renewal or one further lease period from that time, whichever comes first.
   * The record is written on the main pool, not the lease pool (GY-671): the lease pool is
   * reserved for the lease commands, and the very exhaustion that failed the renewal must not
   * also fail the record of it. A record the database refuses is retried in the background until
   * that period has passed. The refusal carries the grace the record earns even before it has
   * landed (GY-671) — the same one period from the renewal's arrival `renewalGrace` will grant
   * once it does — so the worker's supervisor extends its local deadline as far as the server
   * will hold the lease, instead of stopping at the old deadline while the server still keeps it.
   */
  private async recordRenewalFault(actor: Principal, id: string, epoch: number, at: Date, error: unknown) {
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    console.error(`[lease] renewal of ${id} epoch ${epoch} by ${actor.id} failed server-side: ${reason}`);
    const payload = JSON.stringify({ owner: actor.id, epoch, at: at.toISOString(), error: reason });
    const until = at.getTime() + this.leaseSeconds * 1000;
    // Only a live lease of this owner and epoch earns a grace; the refusal says what it earned.
    const write = async () => (await this.store.pool.query(`WITH live AS (
        SELECT id, CASE WHEN document->'lease' ? 'renewalFault' THEN (document->'lease'->>'expiresAt')::timestamptz
          ELSE GREATEST((document->'lease'->>'expiresAt')::timestamptz, $7::timestamptz) END AS grace_until
        FROM work_items WHERE id = ${workIdByRef('$1')} AND document->'lease'->>'owner'=$2
          AND (document->'lease'->>'epoch')::int=$5 AND (document->'lease'->>'expiresAt')::timestamptz>=$6::timestamptz LIMIT 1),
      recorded AS (INSERT INTO events(work_id,actor,kind,payload) SELECT id, $2, $3, $4::jsonb FROM live RETURNING work_id)
      SELECT live.grace_until, clock_timestamp() AS now FROM live JOIN recorded ON recorded.work_id=live.id`,
    [id, actor.id, renewalFaultEvent, payload, Number.isSafeInteger(epoch) ? epoch : -1, at.toISOString(), new Date(until).toISOString()])).rows[0] as { grace_until: Date; now: Date } | undefined;
    let recorded: { grace_until: Date; now: Date } | undefined, unrecorded: string | null = null;
    try { recorded = await write(); } catch (failure) {
      unrecorded = (failure as Error).message;
      const retry = () => setTimeout(() => { if (Date.now() < until) write().catch(retry); }, 1000).unref();
      retry();
    }
    const grace = recorded ? { at: at.toISOString(), graceUntil: recorded.grace_until.toISOString(), now: recorded.now.toISOString() }
      : unrecorded !== null ? { at: at.toISOString(), graceUntil: new Date(until).toISOString(), now: new Date().toISOString() } : null;
    return new RenewalFault(grace
      ? `Lease renewal failed server-side (${reason}); ${unrecorded === null ? 'the failure is recorded and the lease stays valid' : 'the record is being retried and the lease is kept'} until ${grace.graceUntil} or the next successful renewal`
      : `Lease renewal failed server-side (${reason}); no live lease of this owner and epoch was found to keep`, grace);
  }
  /**
   * A lease past its expiry that a recorded server-side renewal fault still covers (GY-558): the
   * first fault after its last renewal and inside its expiry window extends it to one lease period
   * after that fault, once — a later fault before a successful renewal extends nothing. A lease
   * whose worker stopped renewing has no such record and expires as before. A gap in the plane's
   * own ticks (recordPlaneLiveness) that covers the expiry is the same server-side fault in the plane
   * itself (GY-1791): renewals could not land while no tick ran, so a supervisor still retrying
   * finds the lease live and renews, where the base lapsed it and raised a lease loss. That stall
   * keeps the lease only for `stallRenewalWindowMs` past the stall — the window a still-retrying
   * supervisor needs to land the renewal the stall ate — never a full lease period (GY-1801): a
   * lease the stall alone keeps, with nobody renewing it, must lapse inside the loop's own
   * exited-pane sighting window (launchAppearanceMs), so no step closes the attempt's pane while
   * the stall alone holds the lease live.
   */
  private async renewalGrace(db: PoolClient, work: Work, now: Date) {
    const lease = work.lease as GracedLease | null;
    if (!lease || lease.renewalFault || Date.parse(lease.expiresAt) > now.getTime()) return false;
    const leaseMs = this.leaseSeconds * 1000, expires = Date.parse(lease.expiresAt);
    const fault = (await db.query(`SELECT payload->>'at' AS at, payload->>'error' AS error FROM events WHERE kind=$1 AND created_at>$2::timestamptz AND work_id=$3
      AND payload->>'owner'=$4 AND (payload->>'epoch')::int=$5 AND (payload->>'at')::timestamptz>$2::timestamptz AND (payload->>'at')::timestamptz<=$6::timestamptz
      ORDER BY (payload->>'at')::timestamptz LIMIT 1`, [renewalFaultEvent, new Date(expires - leaseMs).toISOString(), work.id, lease.owner, lease.epoch, lease.expiresAt])).rows[0] as { at: string; error: string } | undefined;
    if (fault) {
      lease.renewalFault = { at: new Date(fault.at).toISOString(), error: fault.error };
      lease.expiresAt = new Date(Math.max(expires, Date.parse(fault.at) + leaseMs)).toISOString();
      return true;
    }
    // The stall covers the expiry itself, so the read reaches back one window before it; the
    // recovery tick wrote the stall at its own `to`, which is the newest row the window can hold.
    const stall = stallCovering(await readPlaneStalls(db, expires - leaseMs, now.getTime()), expires);
    if (!stall) return false;
    lease.renewalFault = { at: stall.from, error: `the control plane was not answering between ${stall.from} and ${stall.to}` };
    lease.expiresAt = new Date(Math.max(expires, Date.parse(stall.to) + stallRenewalWindowMs)).toISOString();
    return true;
  }
  private async executeCommand(actor: Principal, command: Command, id: string | null, input: unknown, key: string, context: { observation?: Observation } = {}) {
    demand(Object.hasOwn(commands, command), 'Unknown command', 404);
    // Leads coordinate through rulings; no lifecycle command is lead-permitted.
    demand(actor.role !== 'slice-lead' || leadMay(command), 'Slice leads cannot perform lifecycle mutations', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const data: any = commands[command].parse(input);
    const fingerprint = createHash('sha256').update(JSON.stringify({ command, id, data })).digest('hex');
    // Provider I/O stays outside the coordination transaction.
    // A renewal changes one item's lease and reads nothing else of the fleet (GY-1124): it takes that
    // item's lock alone, so renewals of different items never wait for each other or for a fleet
    // command. It neither evaluates the item nor records a dispatch: both are left to the next
    // reconciliation pass, which sees the row move, so a gate change that waited on this renewal
    // lands one reconcile tick after it rather than in the renewal's own response.
    if (command === 'heartbeat' && actor.role !== 'operator-agent') return this.store.transaction(async (db, now) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) {
        demand(receipt.fingerprint === fingerprint, idempotencyMismatch);
        return receipt.result as Work;
      }
      const work: Work | undefined = (await db.query(`SELECT document FROM work_items WHERE id = ${workIdByRef('$1')}`, [id])).rows[0]?.document;
      demandWork(work);
      // A lease past its expiry that a recorded server-side renewal fault still covers stays live (GY-558).
      await this.renewalGrace(db, work, now);
      preserveAssignment(work);
      demand(work.stage !== 'done', 'Delivered work is immutable; create a follow-up task');
      this.renewLease(work, actor, data.epoch, now);
      await save(db, work, actor.id, command, now, data);
      // A renewal's replay needs only the lease, not a whole document per renewal.
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(compactHeartbeatReceipt(work))]);
      return work;
    }, { lane: 'lease', fleetLock: false, itemLock: id });
    const observation = command === 'submit' ? context.observation ?? await this.observeSubmission(actor, id, data, key) : null;
    // GY-1735: a claim the observation window refuses rolls its transaction back, so the window a legacy follow-up
    // derives is recorded first, on its own: coordination then holds the item instead of dispatching refused claims.
    // Only a claim the main transaction would judge writes it: a caller without claim authority, or a key that
    // already has a receipt (a replay or a mismatched reuse), leaves the item and its history untouched.
    if (command === 'claim' && (actor.role === 'worker' || actor.role === 'admin')) await this.store.transaction(async (db, now) => {
      if ((await db.query('SELECT 1 FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows.length) return;
      const all = await lockedWork(db, [id]);
      const work = all.find(w => w.id === id || w.key === id);
      if (!work || work.stage === 'done' || work.observationWindow) return;
      await adoptFollowUpWindow(db, work);
      if (!work.observationWindow) return;
      this.evaluate(work, all, now);
      await this.recordDispatch(db, work, now);
      await save(db, work, 'graphyard', 'observation-window', now, { observationWindow: work.observationWindow });
    // It is part of the claim, so it takes the claim's lease pool (GY-274): a busy request pool never stalls a claim.
    }, { lane: 'lease', itemLock: id });
    // The transaction reruns this closure on a stale write: each run authorizes the principal as the
    // caller presented it, never the one an earlier run already resolved (GY-1276).
    const caller = actor;
    return this.store.transaction(async (db, now) => {
      actor = caller;
      if (actor.role === 'operator-agent') {
        demand(this.operatorAuthorizer, 'Operator-agent authorization is unavailable', 503);
        actor = await this.operatorAuthorizer(db, now, caller);
      }
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) {
        demand(receipt.fingerprint === fingerprint, idempotencyMismatch);
        if (actor.role === 'operator-agent') authorizeOperatorCommand(actor, command, data, receipt.result as Work, this.repository);
        return receipt.result as Work;
      }
      const all = await lockedWork(db, [id]);
      let work = all.find(w => w.id === id || w.key === id);
      const before = work ? structuredClone(work) : null;
      if (command === 'create') {
        if (actor.role === 'operator-agent') {
          authorizeOperatorCommand(actor, command, data, undefined, this.repository);
        } else admin(actor);
        if (reviewProviderOf(data.policy) === 'agent') assertReviewerProfiles(data.policy.reviewerProfiles, this.reviewerApps, this.controlPlaneAppId);
        demand(data.dependencies.every((dep: string) => all.some(w => w.id === dep)), 'Unknown dependency');
        demand(new Set(data.criteria.map((ac: { id: string }) => ac.id)).size === data.criteria.length, 'Criterion IDs must be unique');
        const criteria = this.declareBootstrap(actor, data, [], 1, now);
        const scenarioRequirements: Work['scenarioRequirements'] = [];
        const proofNames: string[] = [...new Set<string>(data.criteria.flatMap((ac: { proofs: string[] }) => ac.proofs))];
        for (const proof of proofNames.filter(p => p.startsWith('e2e:'))) {
          // GY-1708: resolveScenario persists a shipped revision (capacity-limit-redispatch) so create
          // accepts e2e: proofs without a separate e2e sync.
          const scenario = await resolveScenario(db, proof.slice(4), { at: now, by: actor.id });
          demand(scenario, `Register E2E scenario ${proof.slice(4)} before creating work that requires it`);
          scenarioRequirements.push({ proof, revision: scenario.revision, environment: scenario.environment, hash: scenario.hash });
        }
        const created = now.toISOString();
        const { reason: _reason, ...intent } = data;
        work = { ...intent, criteria, id: randomUUID(), key: '', stage: 'backlog', revision: 0, policyRevision: 1, createdAt: created, updatedAt: created, stageEnteredAt: created,
          ready: false, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements, evidence: [], observation: null, blocker: null, gates: [], violations: [] };
        // A policy-required post-deployment proof needs an authorized producer as much as a criterion proof does.
        work!.proofGaps = unauthorizedProofs(this.principals, [...proofNames, ...(deploySmokeRequired(data.policy) ? [deploySmokeProof] : [])], data.producerProofs);
        await adoptFollowUpWindow(db, work!);
        const inserted = await db.query('INSERT INTO work_items(id,document) VALUES($1,$2) RETURNING number', [work!.id, JSON.stringify(work)]);
        work!.key = `GY-${inserted.rows[0].number}`;
        all.push(work!);
        this.refuseRenewedDeferral(work!, all);
      }
      demandWork(work);
      // GY-1760: an item only the master side can satisfy — the loop's own measurement, or a
      // master-role session's observation of the master checkout — is never released to a worker, whoever asks.
      // GY-2605: nor is an owner-held item, unless the owner's own human admin session asks or the owner answered on the item (GY-2606).
      if (command === 'ready') { const owned = loopOwnedRefusal(work!) ?? ownerHoldRefusal(work!, actor); demand(!owned, owned!, 409); }
      // A lease past its expiry that a recorded server-side renewal fault still covers stays live (GY-558).
      await this.renewalGrace(db, work, now);
      if (actor.role === 'operator-agent') {
        authorizeOperatorCommand(actor, command, data, work, this.repository);
        if (command === 'ready' || command === 'unblock') demand(data.expectedRevision === work.revision, 'Task revision changed; reload before mutating');
        if (command === 'ready') demand(work.stage === 'backlog' && !work.ready, 'Only unreleased backlog work can be released');
        if (command === 'unblock') demand(work.blocker, 'Task has no blocker to clear');
      }
      // The only command a delivered item still accepts: the post-deployment smoke fact that
      // extends the delivery snapshot without reopening the merge.
      const postDeployment = command === 'evidence' && data.proof === deploySmokeProof;
      // Ending a session handle an item still carries is the other thing a delivered item accepts,
      // and only that: a review or proof session is often still running when its candidate merges,
      // and the liveness sweep must be able to close its record (GY-113). A closure is a record of
      // a runtime fact, never a decision — it decides no gate, ends no lease and binds no
      // candidate — and this one may only finish a handle the item already carries, so nothing new
      // is recorded on a delivered item and nothing it holds is reopened.
      // The loop's observation of a session still open on it is the same kind of runtime fact
      // (GY-172): a session that outlives its item's delivery is still observed, or every reader
      // would show a live session as unseen until it closed. It keeps the handle open, never reopens one.
      const deliveredSessionClosure = work.stage === 'done' && command === 'session'
        && (work.sessions ?? []).some(handle => handle.id === data.id
          && (data.state === 'finished' || handle.state === 'running' && data.observed !== undefined && ['coordinator', 'admin'].includes(actor.role)));
      preserveAssignment(work);
      if (command !== 'create' && !postDeployment && !deliveredSessionClosure) demand(work.stage !== 'done', 'Delivered work is immutable; create a follow-up task');
      if (command === 'mechanicalplan') {
        demand(['coordinator', 'admin'].includes(actor.role), 'Coordinator permission required', 403);
        // `at` is the control plane's own instant of the report: the review gate holds only while the loop
        // confirmed the plan this recently, so a report whose write or ledger read keeps failing cannot
        // keep holding a head the ledger no longer plans a round for (GY-1764).
        work.mechanicalPlan = data.planned ? { reviewId: data.reviewId, head: data.head, at: now.toISOString() } : null;
        work.mechanicalAnswered = data.planned ? null : { reviewId: data.reviewId, head: data.head };
      }
      if (command === 'requirements') await this.reviseRequirements(db, actor, work, all, data, now);
      if (command === 'ready') { if (actor.role !== 'operator-agent') admin(actor); work.ready = true; await adoptFollowUpWindow(db, work); }
      if (command === 'unblock') { if (actor.role !== 'operator-agent') admin(actor); work.blocker = null; await adoptFollowUpWindow(db, work); }
      if (command === 'rework') {
        if (actor.role !== 'operator-agent') admin(actor);
        demand(!work.observation?.merged, 'Merged work requires a follow-up task');
        work.reworkRequested = true;
        // The round's brief: the next worker's request carries this reason (master/rework-brief.ts).
        work.lastRework = { reason: data.reason, binding: data.binding ?? null, at: now.toISOString() };
        // Reassignment discards whatever assignment still stood: its end is recorded here, the
        // last moment it is visible, and the item is claimable again.
        preserveAssignment(work);
        if (work.lease) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', 'lease.expired',
          JSON.stringify({ details: { owner: work.lease.owner, epoch: work.lease.epoch, expiresAt: work.lease.expiresAt, submission: work.submission, cause: 'rework', at: now.toISOString() } })]);
        recordRework(work, now);
        work.lease = null;
        // Reopening implementation is the authorized recovery for send-back.
        // A plan rejection remains owned by its originating lead and can only
        // be superseded by that lead's later approve-plan ruling.
        if (work.leadHold?.action === 'send-back') releaseLeadHold(work);
      }
      if (command === 'claim') {
        demand(actor.role === 'worker' || actor.role === 'admin', 'Worker permission required', 403);
        demand(!work.lease || Date.parse(work.lease.expiresAt) <= now.getTime(), 'Task already has an active owner');
        demand(!work.submission || work.reworkRequested, 'Implementation is submitted; an operator must request rework before reassignment');
        // A replacement claim over a lapsed lease records how that assignment ended, exactly as reconciliation would have.
        if (work.lease) {
          await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', 'lease.expired',
            JSON.stringify({ details: { owner: work.lease.owner, epoch: work.lease.epoch, expiresAt: work.lease.expiresAt, submission: work.submission, at: now.toISOString() } })]);
          endLapsedAttempt(work, work.lease, now);
          work.lease = null;
        }
        // Eligibility against the requirements: ready, dependencies, exclusive
        // resources and slice capacity are all derived from the document the new attempt will hold.
        demand(work.ready && !work.blocker, 'Task is not ready or has a blocker');
        // GY-1735: the observation window holds the claim itself, so no loop or launcher that predates it (GY-1722, GY-1725) can start an attempt that can only escalate.
        await adoptFollowUpWindow(db, work);
        const window = observationWindowHold(work, now);
        demand(!window, `${work.key} waits for its observation window: the reading it owes can first exist at ${window?.notBefore} (${window?.detail})`, 409);
        demand(work.dependencies.every(dep => all.find(w => w.id === dep)?.stage === 'done'), 'Unfinished dependencies');
        const resources = resourceConflicts(work, all, now.getTime());
        demand(!resources.length, `Exclusive resources held: ${resources.map(r => `${r.resource} by ${r.key}`).join(', ')}`);
        if (work.slice) {
          // Capacity is a count of engineers, not of leases: one engineer holding
          // two items in the slice still occupies one of the lead's seats.
          const engineers = activeEngineers(all.filter(item => item.id !== work!.id), work.slice, now.getTime());
          engineers.delete(actor.id);
          const limit = delegationLimits().maxEngineersPerLead;
          demand(engineers.size < limit, `Engineer limit for ${work.slice} exceeded: ${engineers.size}/${limit}`);
        }
        work.epoch++;
        expireAgentRequests(work, now, `epoch ${work.epoch} claimed the item; a request from an attempt that ended is asked afresh`);
        work.implementers = [...new Set([...implementerIdentities(work), actor.id])];
        work.lastAssignment = { owner: actor.id, epoch: work.epoch, claimedAt: now.toISOString(), ...(actor.displayName ? { displayName: actor.displayName } : {}), ...(actor.runtime ? { runtime: actor.runtime } : {}) };
        work.lease = { owner: actor.id, epoch: work.epoch, expiresAt: new Date(now.getTime() + this.leaseSeconds * 1000).toISOString() };
        beginAttempt(work, work.lease, now);
      }
      if (command === 'heartbeat') this.renewLease(work, actor, data.epoch, now);
      else {
        if (command === 'release') endedBySubmission(work, data.epoch);
        if (['release', 'workspace', 'submit', 'blocked', 'defer'].includes(command)) activeLease(work, actor, data.epoch, now);
      }

      if (command === 'release') {
        // GY-860 AC-2: a release carrying a workspace failure keeps the git message on the item and,
        // while the attempt is still the untouched claim it released, undoes it: the timeline entry
        // and the reservation go, the epoch returns, and the next dispatch claims it afresh. An
        // attempt that already did work is only ended — its release is an ordinary attempt end.
        // Untouched means nothing but the worktree command ever held this epoch: the lease was never
        // renewed, no session was launched under it and nothing was submitted, so no delayed
        // command from another holder can reach the epoch number when it is claimed again.
        const timeline = pipelineTimeline(work);
        const open = data.failure ? timeline.attempts.find(entry => entry.epoch === data.epoch && entry.endedAt === null) : undefined;
        const untouched = open && work.lease && Date.parse(work.lease.expiresAt) === Date.parse(open.claimedAt) + this.leaseSeconds * 1000
          && work.submission?.epoch !== data.epoch ? open : undefined;
        if (data.failure) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, actor.id, 'workspace.failed', JSON.stringify({ details: { epoch: data.epoch, message: data.failure.message, at: now.toISOString() } })]);
        // GY-1286: a rework workspace refused because the PR branch moved past the observed head can
        // only be built once that head is observed, so the release wakes the observation, prioritized.
        if (data.failure?.message.startsWith(submittedBranchMoved) && work.submission) await wakeJob(db, work.id, true);
        if (untouched && work.epoch === data.epoch) {
          timeline.attempts.splice(timeline.attempts.indexOf(untouched), 1);
          work.workspaces = work.workspaces.filter(w => w.epoch !== data.epoch);
          work.epoch = data.epoch - 1;
        } else endAttempt(work, data.epoch, 'released', now);
        work.lease = null;
      }
      // A blocked report is a hand-off to the master or operator; the item's timeline counts it.
      if (command === 'blocked') {
        work.blocker = data.reason;
        if (data.reason) {
          recordIntervention(work, 'blocked');
          // GY-1008: recording a blocker ends the attempt in this same transaction, so a blocked
          // item holds no worker slot while the loop re-checks its cause. The work it had is kept
          // (committed on its branch, and what it had not committed as the CLI's WIP commit), and
          // the next attempt's request names that commit, as for any interrupted attempt.
          const partialWork = data.partialWork ?? { state: 'not-applicable' as const, detail: 'the blocked attempt reported no partial work; its commits stay on its branch' };
          const record: ExhaustionRecord = { role: 'worker', cause: 'interrupted', epoch: data.epoch, profile: actor.id.slice(0, 80), account: null, runtime: actor.runtime?.slice(0, 40) ?? null,
            // A GitHub credential failure's end carries GY-999's marker, so it counts on the retry
            // ladder: a failure no freshly minted credential cures is relaunched after a backoff
            // and held at the cap for the master, never ended and relaunched for ever.
            reason: (credentialFailure(data.reason) ? credentialBlockedReason(work, data.epoch, data.reason) : `${blockedAttemptMarker}${data.epoch}: ${data.reason}`).slice(0, 500),
            resetsAt: null, partialWork, at: now.toISOString(), owner: actor.id, recordedBy: actor.id };
          const capacity = work.capacity ?? { exhaustions: [], spent: [] };
          work.capacity = { ...capacity, exhaustions: [...capacity.exhaustions, record].slice(-retainedExhaustions) };
          endAttempt(work, data.epoch, 'released', now);
          work.lease = null;
        }
      }
      if (command === 'defer') {
        // GY-1726: a reading that cannot exist yet is a wait the product holds, not an escalation
        // (GY-1689, GY-1721, GY-1724 each blocked for one). Only a post-deploy follow-up owes such a
        // reading; anything else blocks as before. A later recorded window is never shortened.
        observationHold(work, data.notBefore, now, 'worker-reading', `${actor.id} found the reading cannot exist before then: ${data.reason}`);
        endAttempt(work, data.epoch, 'released', now);
        work.lease = null;
      }
      if (command === 'window') {
        // GY-1740: a post-deploy follow-up blocked for a reading that cannot exist yet (GY-1689, GY-1721,
        // GY-1724) is moved to its wait without a worker launch spent only to call `defer`.
        if (actor.role !== 'operator-agent') demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
        // Every writer names the revision it read: a hold derived from a blocker since cleared or changed is refused.
        demand(data.expectedRevision === work.revision, 'Task revision changed; reload before mutating');
        demand(!work.lease || Date.parse(work.lease.expiresAt) <= now.getTime(), `${work.key} is held by ${work.lease?.owner} under epoch ${work.lease?.epoch}; its worker defers it with defer GY-N EPOCH NOT-BEFORE REASON`, 409);
        observationHold(work, data.notBefore, now, 'operator-hold', `${actor.id} held it until then: ${data.reason}`);
        work.blocker = null;
      }
      if (command === 'session') {
        demand(['worker', 'producer', 'coordinator', 'admin'].includes(actor.role), 'Worker, producer or coordinator permission required', 403);
        const existing = (work.sessions ?? []).find(handle => handle.id === data.id);
        // A launcher records the handle of a session it started under somebody else's credential,
        // and names whose: that is what lets the session itself fill in the tab and transcript
        // only it has. Naming another principal is the launch authority a coordinator already
        // holds, so nobody below it may claim a handle on another session's behalf.
        demand(!data.principal || data.principal === actor.id || actor.role === 'coordinator' || actor.role === 'admin',
          'Only a coordinator or an admin records a handle on behalf of the session it launched', 403);
        // An implementation session names the attempt it runs under and must hold that lease; a
        // reviewer or producer session holds none, and records its handle under its own identity.
        if (data.epoch !== undefined) activeLease(work, actor, data.epoch, now);
        else {
          demand(actor.role !== 'worker', 'An implementation session records its handle under its assignment epoch');
          // Creating a lease-less handle is the launch authority: a coordinator or an admin
          // records what it launched, and a session the control plane itself asked for records
          // the handle of that request. Anything else would let a credential that merely reaches
          // this item mint handles — enough of them to push a running session off a bounded list,
          // or to squat the predictable id of a session about to be launched and so take the
          // ownership its own launcher needs.
          const requested = liveDispatchHandleIds(work);
          demand(existing || ['coordinator', 'admin'].includes(actor.role) || requested.includes(data.id),
            requested.length ? `A handle without an attempt epoch is recorded by its launcher or by the session of a live dispatch request on ${work.key} (${requested.join(', ')})`
              : `A handle without an attempt epoch is recorded by its launcher; ${work.key} has no live dispatch request whose session could record one`, 403);
        }
        // An existing handle is the attach command master status and the dashboard show an
        // operator. Overwriting one — marking a running worker finished, or replacing the command
        // somebody is about to run — belongs to that session, its launcher, or an admin, never to
        // any credential that happens to reach this item.
        demand(!existing || existing.principal === actor.id || actor.role === 'coordinator' || actor.role === 'admin',
          `Session handle ${data.id} belongs to ${existing?.principal}; only that session, its launcher or an admin may update it`, 403);
        // What the loop observed of a session is the one state every reader shows (GY-172): only
        // the observer writes it, never the session it describes, and never ahead of the clock.
        demand(!sessionObservationFields.some(field => data[field] !== undefined) || actor.role === 'coordinator' || actor.role === 'admin',
          'Only the coordinator that observes sessions, or an admin, records what was observed of one', 403);
        // A running handle belongs to the launch attempt that registered it (GY-172): two launches
        // for one request racing from the same snapshot both reach this point, and the one the
        // launcher then refuses must neither close nor re-coordinate the session the other started.
        // So a launch writes only a handle no other live attempt holds; an attempt whose runtime did
        // start after its registration was refused supersedes the record, since the launcher let it run.
        demand(!data.launch || data.supersede || existing?.state !== 'running' || !existing.launch || existing.launch === data.launch,
          `Session handle ${data.id} is held by another launch attempt that is still recorded running`, 409);
        // An observation dated ahead of this clock would read fresh for good, so it is stored as of now.
        const observedAt = data.observedAt && Date.parse(data.observedAt) > now.getTime() ? now.toISOString() : data.observedAt;
        const { supersede: _supersede, ...handle } = data;
        // One worker principal runs one implementation session on an item at a time, so a launcher
        // recording that principal's session running under a new id moves it: the running record
        // the same principal held under another id — the one registered before the claim under the
        // epoch the snapshot guessed (cycle-dispatch.ts rekeyLaunchedSession, GY-1791) — is closed in
        // this same transaction, naming where the session now is. One write moves the handle, so
        // no failure between two can leave the attempt with two running handles or with none.
        if (handle.kind === 'implementation' && handle.state === 'running' && ['coordinator', 'admin'].includes(actor.role)) {
          const owner = handle.principal ?? existing?.principal ?? actor.id;
          for (const other of (work.sessions ?? []).filter(entry => entry.id !== handle.id && entry.kind === 'implementation' && entry.state === 'running' && entry.principal === owner))
            recordSession(work, { id: other.id, kind: other.kind, runtime: other.runtime, host: other.host, subject: other.subject, state: 'finished',
              outcome: `superseded: ${owner} runs one implementation session on ${work.key} at a time, and its launcher recorded that session as ${handle.id}`.slice(0, 500) }, actor.id, now);
        }
        recordSession(work, { ...handle, ...(observedAt ? { observedAt } : {}) }, actor.id, now);
      }
      if (command === 'request') {
        demand(['worker', 'producer', 'coordinator', 'admin'].includes(actor.role), 'Worker, producer or coordinator permission required', 403);
        work.agentRequests ??= [];
        if (data.resolve) {
          const open = work.agentRequests.find(entry => entry.id === data.resolve && entry.state === 'open');
          demand(open, 'No open request with that id', 404);
          // The decider the record names is the only party that may close it; otherwise a session
          // could record a request for an approver or the operator and answer it itself.
          const refusal = requestResolutionRefusal(open!, actor);
          demand(!refusal, refusal ?? '', 403);
          open!.state = 'resolved'; open!.resolvedAt = now.toISOString(); open!.resolution = data.reason;
        } else {
          // Recording a typed request is the same write as the command it replaces, so it needs
          // the same authority: the live lease of the attempt that is asking. Only a note, which
          // moves nothing a gate reads, may be recorded without one.
          if (leaseHeldRequestTypes.includes(data.type)) {
            demand(data.epoch !== undefined, `A ${data.type} names the attempt epoch that is asking; it is recorded by the session holding the item`);
            activeLease(work, actor, data.epoch, now);
          } else if (data.epoch !== undefined) activeLease(work, actor, data.epoch, now);
          const request: AgentRequest = { id: randomUUID(), type: data.type, epoch: data.epoch ?? null, requestedBy: actor.id, at: now.toISOString(), reason: data.reason,
            ...(data.humanDecision ? { humanDecision: data.humanDecision } : {}),
            decider: deciderFor(work.key, data), releasedLease: false, state: 'open' };
          // Each type projects onto the state the gates and the existing machinery already read,
          // so a typed request is the same fact as the command it replaces, with a decider named.
          if (data.type === 'blocker') { work.blocker = data.reason; recordIntervention(work, 'blocked'); }
          // A note is a record; every other type is a hand-off, so the attempt ends here rather
          // than holding the item while its session waits for an answer.
          const release = data.release ?? data.type !== 'note';
          if (release && data.epoch !== undefined && work.lease?.epoch === data.epoch) {
            endAttempt(work, data.epoch, 'released', now); work.lease = null; request.releasedLease = true;
          }
          work.agentRequests = boundedAgentRequests([...work.agentRequests, request], request);
        }
      }
      if (command === 'workspace') {
        demand(validBranch(data.branch), 'Only a Graphyard branch can be reserved');
        demand(!work.workspaces.some(w => w.epoch === data.epoch), 'This assignment already has a workspace');
        demand(!all.some(w => w.workspaces.some(s => (s.branch === data.branch && (w.id !== work!.id || !work!.reworkRequested)) || s.host === data.host && pathsOverlap(s.path, data.path))), 'Branch or host/path is already reserved or overlaps a reservation; use a fresh workspace');
        if (work.submission) demand(data.branch === work.workspaces.find(w => w.epoch === work!.submission!.epoch)?.branch, 'Rework must use the already linked PR branch in a fresh workspace');
        const { preserved, ...workspace } = data;
        work.workspaces.push({ ...workspace, owner: actor.id });
        // The preserved-attempt record (GY-860): what the released holder of this branch carried —
        // its refs and uncommitted diff — is kept on the item's ledger, never discarded silently.
        if (data.preserved) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, actor.id, 'workspace.preserved', JSON.stringify({ details: { epoch: data.epoch, branch: data.branch, ...data.preserved } })]);
      }
      if (command === 'submit') {
        const workspace = work.workspaces.find(w => w.epoch === data.epoch);
        demand(workspace, 'Register the assignment workspace first');
        // GY-1523: the control plane is the only merge writer, so a submission is a head it observed
        // (`complete --head`). A pull request (an attempt launched before the cutover) is still
        // recorded; the observation job then reads its head from the shared object store, which
        // hands it to the merge writer.
        let observed = observation, number: number;
        if (data.head !== undefined) {
          demand(observation?.source === 'control-plane' && observation.candidate.sha === data.head, `${data.head.slice(0, 12)} was not observed by the control plane; complete ${work.key} ${data.epoch} --head again`, 409);
          // One change number per (item, head), allocated under the item lock this transaction holds:
          // the candidate, the submission and the number commit together, and a retried or repeated
          // submission of the same head reads the same number back.
          number = await allocateChangeNumber(db, work.id, data.head);
          observed = { ...observation!, candidate: { sha: data.head, baseSha: observation!.baseTip!, pr: number, branch: workspace!.branch, author: actor.id } };
        } else {
          number = data.pr;
          demand(!all.some(w => w.id !== work!.id && w.submission?.pr === number), 'Pull request is already linked to another task');
          demand(!work.submission || work.submission.pr === number, 'A submitted task cannot switch pull requests');
        }
        if (observed) {
          demand(observed.candidate.pr === number, 'Observed pull request does not match the submission');
          demand(work.workspaces.some(w => w.epoch === data.epoch && w.branch === observed!.candidate.branch), 'PR branch does not match the assigned workspace');
        }
        work.submission = { epoch: data.epoch, pr: number };
        if (data.head !== undefined) {
          // The control plane's reading is the candidate's observation from this instant (GY-1523): the
          // minimal save `observe` makes for a provider reading, with nothing of GitHub's to carry.
          observeHead(work, observed!.candidate, observed!.at);
          work.candidate = observed!.candidate;
          work.observation = observed!;
          observeBaseHold(work, observed!.at);
        }
        work.reworkRequested = false;
        recordSubmission(work, data.epoch, now);
        // Binding the candidate ends the implementation lease in the same transaction: submitted
        // work continues through the gates without one, and a lease left to lapse afterwards
        // would otherwise read as an abandoned assignment. The workspace and `lastAssignment`
        // keep the attempt attributable, and rework still needs the stopped-worker attestation.
        work.lease = null;
      }
      if (command === 'reading') {
        demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
        // The one record of this kind: the loop's reading of a proof only it records (GY-1762), bound as loopObservation reads it.
        const proofs = loopObservationProofs(work);
        demand(!!proofs?.includes(data.proof), `${work.key} is not a loop-owned observation item owing ${data.proof}; a reading is recorded only on an item whose every criterion is a post-deploy observation the loop takes`, 409);
        demand(data.policyRevision === work.policyRevision, `The reading names policy revision ${data.policyRevision}; ${work.key} is at ${work.policyRevision}`, 409);
        const request = followUpRequest(work), parent = request ? all.find(item => item.id === request.work) : null;
        if (request) {
          demand(!!parent?.delivery, `${work.key}'s follow-up request names ${request.work}, which is not a delivered item; its reading has no merge to bind to`, 409);
          demand(data.baseSha === parent!.delivery!.mergeSha, `The reading's base ${data.baseSha.slice(0, 12)} is not ${parent!.key}'s merge ${parent!.delivery!.mergeSha.slice(0, 12)}: a reading is bound to the parent delivery's merge`, 409);
        } else demand(data.sha === data.baseSha, 'A reading of an item that follows no delivery is bound to the serving release alone: sha and baseSha name it', 409);
        demand(!work.observationWindow || Date.parse(work.observationWindow.notBefore) <= now.getTime(), `${work.key}'s reading can first exist at ${work.observationWindow?.notBefore}; one taken before then is not recorded`, 409);
        const evidence: Evidence = { id: randomUUID(), proof: data.proof, sha: data.sha, baseSha: data.baseSha, policyRevision: data.policyRevision, producer: actor.id, trusted: true, result: data.result, executed: 1, skipped: 0, at: now.toISOString(), reading: { detail: data.detail } };
        work.evidence.push(evidence);
      }
      if (command === 'evidence') {
        demand(actor.role === 'producer' || actor.role === 'worker' || actor.role === 'admin', 'Evidence submission is not permitted', 403);
        // Workers may still record their own untrusted assertions; every identity
        // that could mint trust must be independent of the implementation and the lead.
        const dependent = actor.role === 'worker' ? null : producerIndependenceRefusal(actor, work, this.principals);
        demand(!dependent, dependent ?? 'Evidence producer is not independent', 403);
        // Trust is decided by the live grant set, never by the deployment environment.
        const trusted = authorizedForProof(actor, data.proof);
        if (data.proof === deploySmokeProof) {
          // Post-deployment proof is a trust boundary with no untrusted tier: it is accepted only
          // from a producer granted the proof, only once Graphyard has observed the deployment,
          // and only bound to that observed serving commit and this item's merge commit.
          demand(trusted, `${deploySmokeProof} evidence is accepted only from a producer authorized for that proof`, 403);
          demand(deploySmokeRequired(work.policy), `Work policy does not require ${deploySmokeProof}`);
          demand(work.stage === 'done' && !!work.delivery, `${deploySmokeProof} evidence is accepted only after delivery`);
          demand(!!work.delivery!.deployment, 'Graphyard has not observed a deployment covering this delivery');
          demand(data.sha === work.delivery!.deployment!.sha && data.baseSha === work.delivery!.mergeSha,
            `${deploySmokeProof} evidence must name the observed deployed commit ${work.delivery!.deployment!.sha} as sha and merge commit ${work.delivery!.mergeSha} as baseSha`);
          demand(data.policyRevision === work.policyRevision, 'Policy revision does not match this delivery');
        }
        // GY-135: a pass is trusted only beside a recorded run that fails with the criterion's
        // behaviour removed; otherwise it is kept, untrusted, as not exercising its criterion.
        const unexercised = trusted && data.proof !== deploySmokeProof ? exerciseRefusal(work, all, data) : null;
        const evidence: Evidence = { ...data, id: randomUUID(), producer: actor.id, trusted: trusted && !unexercised, at: now.toISOString(), ...(unexercised ? { unexercised } : {}) };
        if (unexercised) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, actor.id, 'evidence.exercise.refused',
          JSON.stringify({ details: { proof: data.proof, criteria: attachedCriteria(work, all, data.proof), behaviour: data.exercise?.behaviour ?? null, sha: data.sha, reason: unexercised } })]);
        work.evidence.push(evidence);
        // GY-162: a trusted e2e: record is also a run of its test case, appended to the case's history.
        await recordScenarioRun(db, work, evidence);
        if (data.proof === deploySmokeProof) work.delivery!.smoke = { evidenceId: evidence.id, result: data.result, sha: data.sha, mergeSha: data.baseSha, producer: actor.id, at: evidence.at, executed: data.executed, skipped: data.skipped, ...(data.url ? { url: data.url } : {}) };
      }
      if (command === 'revoke') {
        // Producer authority is the same live grant set that decides trust at submission.
        demand(actor.role === 'admin' || actor.role === 'producer' && authorizedForProof(actor, data.proof),
          'Evidence revocation requires an operator or the trusted producer authorized for this proof', 403);
        // Revoke every applicable record for the tuple, not merely the newest: leaving an older
        // accepted run behind would silently re-authorize the same candidate.
        const direct = work.evidence.filter(item => item.trusted && !item.revocation && item.proof === data.proof
          && item.sha === data.sha && item.baseSha === data.baseSha && item.policyRevision === data.policyRevision);
        demand(direct.length, 'No trusted evidence matches this proof and candidate; reload before revoking', 404);
        // A reused record (D6) stands on the executed one it names, so withdrawing the executed
        // pass withdraws every record derived from it, for whichever later heads they cover.
        const directIds = new Set(direct.map(item => item.id));
        const withdrawn = work.evidence.filter(item => directIds.has(item.id) || item.trusted && !item.revocation && !!item.reuse && directIds.has(item.reuse.evidenceId));
        for (const item of withdrawn) item.revocation = { at: now.toISOString(), actor: actor.id, reason: data.reason };
        // No execution is recalled: the revocation withdraws the authorization, and the next
        // observation fails the 'Graphyard / merge' check and dequeues the pull request (GY-258).
      }
      // Delivery is an immutable snapshot. A post-deployment fact may append its audit/revision
      // metadata, but stale inputs must not re-evaluate it.
      if (!postDeployment && !deliveredSessionClosure) this.evaluate(work, all, now);
      // A delivered item's gates are an immutable snapshot; its queue is settled without re-evaluating the delivery.
      else settleDelivered(work, all, now);
      await this.recordDispatch(db, work, now);
      await save(db, work, actor.id, command, now, actor.role === 'operator-agent' ? { before, intent: data, reason: data.reason ?? null }
        : data);
      if (work.submission && !postDeployment && !deliveredSessionClosure && !['heartbeat', 'release', 'claim', 'workspace'].includes(command)) await wakeJob(db, work.id);
      // A renewal's replay needs only the lease, not a whole document per renewal.
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(command === 'heartbeat' ? compactHeartbeatReceipt(work) : work)]);
      return work;
    // Lease commands take the lease pool (GY-274, GY-558): however busy every other pool is, a live
    // worker is never stopped because its renewal, claim, completion or blocker could not reach the database.
    }, { lane: leaseCommands.has(command) ? 'lease' : 'request', itemLock: id ?? undefined });
  }

  /** The `requirements` command: a revision of the item's criteria, dependencies, resources and producer proofs, applied inside the caller's transaction. */
  private async reviseRequirements(db: PoolClient, actor: Principal, work: Work, all: Work[], data: any, now: Date): Promise<void> {
    if (actor.role !== 'operator-agent') admin(actor);
    demand(!work.observation?.merged, 'Merged work requires a follow-up task');
    // A revision read before the item's last one is refused as exactly that, first (GY-1293).
    demand(data.expectedPolicyRevision === work.policyRevision, 'Policy revision changed; reload before revising');
    demand(!work.lease || Date.parse(work.lease.expiresAt) <= now.getTime(), 'Stop and release the active worker before revising requirements');
    demand(new Set(data.criteria.map((ac: { id: string }) => ac.id)).size === data.criteria.length, 'Criterion IDs must be unique');
    demand(data.criteria.every((ac: { id: string }) => !work!.retiredCriterionIds?.includes(ac.id)), 'Retired criterion IDs cannot be reused');
    demand(new Set(data.dependencies).size === data.dependencies.length && data.dependencies.every((dep: string) => all.some(w => w.id === dep)), 'Unknown or duplicate dependency');
    const reachesWork = (id: string, visited = new Set<string>()): boolean => {
      if (id === work!.id) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      return all.find(w => w.id === id)!.dependencies.some(dep => reachesWork(dep, visited));
    };
    demand(!data.dependencies.some((dep: string) => reachesWork(dep)), 'Dependencies would create a cycle');
    const revised = this.declareBootstrap(actor, data, work.criteria, work.policyRevision + 1, now, work);
    const pins: Work['scenarioRequirements'] = [];
    const proofs = [...new Set<string>(data.criteria.flatMap((ac: { proofs: string[] }) => ac.proofs))];
    for (const proof of proofs.filter(p => p.startsWith('e2e:'))) {
      const pinned = work.scenarioRequirements.find(s => s.proof === proof);
      if (pinned) { pins.push(pinned); continue; }
      const scenario = await resolveScenario(db, proof.slice(4), { at: now, by: actor.id });
      demand(scenario, `Register E2E scenario ${proof.slice(4)} first`);
      pins.push({ proof, revision: scenario.revision, environment: scenario.environment, hash: scenario.hash });
    }
    work.retiredCriterionIds = [...(work.retiredCriterionIds ?? []), ...work.criteria.filter(ac => !data.criteria.some((next: { id: string }) => next.id === ac.id)).map(ac => ac.id)];
    work.criteria = revised;
    work.dependencies = data.dependencies; work.exclusiveResources = data.exclusiveResources; work.producerProofs = data.producerProofs;
    work.scenarioRequirements = pins; work.policyRevision++;
    this.refuseRenewedDeferral(work, all);
    work.proofGaps = unauthorizedProofs(this.principals, [...proofs, ...(deploySmokeRequired(work.policy) ? [deploySmokeProof] : [])], work.producerProofs);
    work.formalReviewResetRequired = true; work.formalReviewBaseline = undefined;
    // A revision is a hand-off for an item already under way: its timeline counts it, and the
    // lapsed lease it discards (a live one was refused above) ends that attempt at its deadline.
    if (work.lease) endLapsedAttempt(work, work.lease, now);
    recordIntervention(work, 'requirements');
    work.lease = null;
    work.observation = null; work.mergeAuthorization = null; work.reviewRequest = null;
    // A submitted implementation must be explicitly reconsidered for changed intent.
    if (work.submission) work.reworkRequested = true;

  }

  /**
   * The one item holding action row `id`, found by containment rather than by loading every document.
   * `retired` also finds an item that has moved the row to its queue's history (GY-1586).
   */
  private async actionOwner(db: { query: (text: string, values: unknown[]) => Promise<{ rows: { document: Work }[] }> }, id: string, item?: string, retired = false): Promise<Work | undefined> {
    // Given the owning item's id, the owner is read again by its primary key instead of found by a scan (GY-1276).
    const scope = item === undefined ? 'w.id IN (SELECT id FROM work_index WHERE NOT settled)' : 'w.id=$2::uuid AND w.id IN (SELECT id FROM work_index WHERE NOT settled)';
    const holds = (list: string) => `document->'actionQueue'->'${list}' @> jsonb_build_array(jsonb_build_object('id', $1::text))`;
    return (await db.query(`SELECT document FROM work_items w WHERE ${scope} AND (${retired ? `${holds('actions')} OR ${holds('history')}` : holds('actions')}) ORDER BY number LIMIT 1`, item === undefined ? [id] : [id, item])).rows[0]?.document;
  }
  /**
   * Claim the next action for a stateless executor.
   *
   * The executor names itself and its host, and the kinds it can actually run; the control plane
   * hands back the first open row it can take in claim order, leased for a bounded time. Two
   * executors on two hosts calling this at the same instant are serialized by the coordination lock, so the first
   * gets the row and the second gets the next one. Neither is configured with the other, and
   * neither reports to a master: the queue is the whole of their coordination.
   */
  async claimNextAction(actor: Principal, input: unknown, key: string) {
    demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const data = actionClaimSchema.parse(input);
    const fingerprint = createHash('sha256').update(JSON.stringify({ command: 'action.claim', data })).digest('hex');
    // An idle poll takes no lock and loads no document (GY-185). A replayed key answers from its
    // receipt, and the rows an executor could take are found in SQL; only when there are some is
    // the lock taken, and then only their items are loaded, and claimed again under it.
    const replayed = (await this.store.pool.query('SELECT fingerprint, result FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
    if (replayed) { demand(replayed.fingerprint === fingerprint, idempotencyMismatch); return replayed.result as { action: ActionRow | null }; }
    const candidates: string[] = (await this.store.pool.query(claimCandidatesSql, claimCandidatesParams(data.work, data.kinds))).rows.map(row => row.id);
    if (!candidates.length) {
      const at = (await this.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      return { action: null, open: 0, at: at.toISOString() };
    }
    return this.store.transaction(async (db, now) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) { demand(receipt.fingerprint === fingerprint, idempotencyMismatch); return receipt.result as { action: ActionRow | null }; }
      const all: Work[] = (await db.query('SELECT document FROM work_items WHERE id = ANY($1::uuid[]) ORDER BY number', [candidates])).rows.map(r => r.document);
      const claimed = claimAction(all, { id: data.executor ?? actor.id, host: data.host, principal: actor.id }, now, { kinds: data.kinds, leaseMs: data.leaseSeconds ? data.leaseSeconds * 1000 : undefined, work: data.work });
      const result = { action: claimed?.row ?? null, open: openActions(all, now, data.kinds).length, at: now.toISOString() };
      // A poll that claims nothing changed nothing, so it leaves no receipt: an idle executor
      // asking every few seconds must not write a row per question it asked.
      if (claimed) {
        await save(db, claimed.work, actor.id, 'action.claimed', now, { id: claimed.row.id, kind: claimed.row.kind, executor: claimed.row.claim!.executor, host: claimed.row.claim!.host, principal: actor.id, attempt: claimed.row.attempts });
        // A row this executor last failed on stepped aside for this claim; its mark makes that once (GY-1132).
        for (const work of claimed.yielded) await save(db, work, actor.id, 'action.claimed', now, { id: claimed.row.id, kind: claimed.row.kind, executor: claimed.row.claim!.executor, yielded: work.actionQueue!.actions.filter(row => row.yielded === claimed.row.claim!.executor).map(row => row.id) });
        await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
      }
      return result;
    });
  }
  /**
   * Record what an executor's attempt did. Only the executor holding the live claim may settle its
   * row: a claim that expired and was taken by another executor can no longer report a result, so
   * an executor that comes back from the dead never double-counts the action that replaced it.
   */
  async settleClaimedAction(actor: Principal, id: string, input: unknown, key: string) {
    demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const data = actionSettleSchema.parse(input);
    const fingerprint = createHash('sha256').update(JSON.stringify({ command: 'action.settle', id, data })).digest('hex');
    return this.store.transaction(async (db, now) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) { demand(receipt.fingerprint === fingerprint, idempotencyMismatch); return receipt.result as { action: ActionRow }; }
      const work = await this.actionOwner(db, id);
      demand(work, 'Action is not open on any work item', 404);
      const transition = settleAction(work!, id, { executor: data.executor ?? actor.id, principal: actor.id }, data.result, data.reason, now);
      // A row settled on a delivered item was the last claim holding it open: it is retired with
      // the rest of what the delivery no longer needs, rather than offered again (GY-185).
      if (work!.stage === 'done') settleDelivered(work!, (await lockedWork(db, [work!.id])).map(item => item.id === work!.id ? work! : item), now);
      await save(db, work!, actor.id, `action.${transition.event}`, now, { id, kind: transition.action.kind, executor: data.executor ?? actor.id, result: data.result, reason: data.reason, attempt: transition.action.attempts });
      if (work!.submission) await wakeJob(db, work!.id);
      const result = { action: transition.action, work: { id: work!.id, key: work!.key } };
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
      return result;
    });
  }
  /**
   * Hold a claim while the handler is still running.
   *
   * A claim is a short lease so that a dead executor's row is offered again quickly, but the
   * handlers are not short: a dispatch prepares a worktree and waits on a runtime, and a guarded
   * merge chains provider calls that each have their own timeout. Without this a handler that
   * outlives its lease is run a second time by another executor while the first is still inside
   * it — the double execution AC-2 forbids. The executor that holds the claim says here that it
   * is still running; anybody else, and an expired claim, is refused.
   */
  async renewClaimedAction(actor: Principal, id: string, input: unknown) {
    demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
    const data = actionRenewSchema.parse(input);
    return this.store.transaction(async (db, now) => {
      const owner = await this.actionOwner(db, id);
      demand(owner, 'Action is not open on any work item', 404);
      // The item's lock, which a heartbeat takes alone (GY-1124), then the item as it stands under it,
      // read again by its id: the action can only have left it, never moved to another item.
      await lockItem(db, owner!.id);
      const work = await this.actionOwner(db, id, owner!.id);
      demand(work, 'Action is not open on any work item', 404);
      const row = renewClaim(work!, id, { executor: data.executor ?? actor.id, principal: actor.id }, now, data.leaseSeconds ? data.leaseSeconds * 1000 : undefined);
      // A renewal is a fact about a claim, not a decision: it is persisted without re-evaluating
      // the item and without an event or revision of its own, so a long handler costs one update
      // per interval and a reader's ledger lookback still counts saves exactly.
      await rewriteDocument(db, work!);
      return { action: row, work: { id: work!.id, key: work!.key } };
    }, { lane: 'lease' });
  }
  /**
   * The pull model: a free worker session asks for its next assignment instead of waiting for a
   * dispatcher to inject one.
   *
   * The control plane already names which items need a worker (`nextAction` kind `dispatch`,
   * target `implementation`), in the order the dispatcher would have offered them. The worker
   * claims under its own identity through the ordinary claim command, so every claim rule — ready,
   * dependencies, quarantine, exclusive resources, engineer limits — still decides. An item that
   * refuses is skipped rather than returned as an error, so one worker racing another for the head
   * of the queue simply takes the next item instead of going back to sleep.
   */
  async pullAssignment(actor: Principal, input: unknown, key: string) {
    demand(actor.role === 'worker' || actor.role === 'admin', 'Worker permission required', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const data = pullAssignmentSchema.parse(input);
    // Every offer this pull tries claims under one key derived from the pull's own, so the claim
    // receipt records which item this pull took — and, because a receipt is written in the same
    // transaction as the claim it belongs to, one pull key can never claim two items. A pull that
    // timed out after its claim committed replays that receipt instead of walking the offers
    // again; without it the retry would take a second item and leave the first held by a worker
    // that was never told it holds it. The race is decided the same way: a concurrent retry that
    // reaches a different offer first is refused for reusing the key with different input, and
    // replays the assignment the winner made rather than claiming beside it.
    const derived = `pull/${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
    const replay = async () => (await this.store.pool.query('SELECT result FROM receipts WHERE actor=$1 AND key=$2', [actor.id, derived])).rows[0]?.result as Work | undefined;
    const prior = await replay();
    if (prior) return { assigned: prior, offered: 1, refused: [] as { key: string; reason: string }[], replayed: true };
    // Open items whole, settled deliveries as the work index's summary (GY-1376): no settled item has a dispatch to offer.
    const all = await this.store.fleet();
    const now = new Date((await this.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now);
    const offers = openActions(all, now, ['dispatch'])
      .filter(entry => entry.row.inputs.kind === 'dispatch' && entry.row.inputs.target === 'implementation')
      .filter(entry => !data.work || entry.work.id === data.work || entry.work.key === data.work);
    const refused: { key: string; reason: string }[] = [];
    for (const offer of offers) {
      try { return { assigned: await this.execute(actor, 'claim', offer.work.id, {}, derived), offered: offers.length, refused }; }
      catch (error) {
        if (!(error instanceof Refusal)) throw error;
        if (error.message === idempotencyMismatch) {
          // This pull already claimed a different item — a concurrent retry of the same call got
          // there first. The claim it made is this pull's assignment; taking another is exactly
          // the double claim the key exists to prevent.
          const claimed = await replay();
          if (claimed) return { assigned: claimed, offered: offers.length, refused, replayed: true };
        }
        refused.push({ key: offer.work.key, reason: error.message });
      }
    }
    return { assigned: null, offered: offers.length, refused, at: now.toISOString() };
  }
  /**
   * Re-read an item: wake the durable provider observation for it and reconcile the graph.
   *
   * This is what the `resync` and `reclaim` actions run. Both say the record is behind the world
   * — a pull request nobody has observed since the base moved, a lease that expired with nobody
   * holding the item — and both are answered the same mechanical way: ask the control plane to
   * look again. It decides nothing itself; it schedules the observation the server already knows
   * how to make and runs the reconciliation that clears a lapsed lease, then returns the item as
   * it now stands, so the executor reports what its attempt actually achieved.
   *
   * A re-read that saves nothing satisfies no `resync` (GY-607): the executor passes `since`, the
   * instant its claim was made, and the answer says whether an observation newer than that has been
   * saved (`observed`) and what the item's observation job is doing (`job`), which is what the
   * executor waits on — reading again with `wake: false` — and what it names when none arrives.
   */
  async resyncWork(actor: Principal, id: string, input: unknown = {}) {
    demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
    const data = resyncSchema.parse(input ?? {});
    const before = await this.store.workDocument(id);
    demand(before, `Unknown work item ${id}`, 404);
    const wake = data.wake !== false;
    // The observation job only exists for an item with a candidate to observe; waking it for one
    // without a submission would schedule a read of nothing.
    // `prioritized` claims the job ahead of the polled backlog, as a webhook wake is (GY-1099).
    // A control-plane candidate is observed here; any other (a pull request GitHub observed) wakes its job, which reads it from the checkout.
    if (wake && before!.observation?.source === 'control-plane' && before!.submission && before!.candidate) {
      try {
        const observation = await this.observeControlPlaneCandidate(before!);
        if (observation) {
          await this.observe(before!.id, before!.revision, observation);
        }
      } catch (error) {
        console.warn(`control-plane observation during resync of ${before!.key} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (wake && before!.submission) {
      await this.store.transaction(async db => { await wakeJob(db, before!.id, data.prioritized === true); });
    }
    // A resync waits for the running tick and then the trailing one that serves it (GY-1115), at most two
    // bounded ticks; reconciling only its own item instead would run a second writer against the tick's
    // batches, the contention GY-1115 removed (GY-1212). A failed tick is a server fault, not this item's:
    // every resync waiting on it would share the rejection, so the resync logs it and answers with the
    // item as it stands, whose `changed`, `observed` and `job` say what the attempt achieved (GY-1212).
    // `wait: false` is a wake alone (GY-1286): the master loop reads the observation it woke on its
    // next cycle, so it waits on no tick; waiting held its decisions step up to the request's 30s
    // timeout per wake, one wake after another.
    if (wake && data.wait !== false) await this.reconcile().catch(error => { console.warn(`reconciliation tick failed during the resync of ${before!.key}: ${error instanceof Error ? error.message : String(error)}`); });
    const work = (await this.store.workItem(before!.id))!;
    // Without `since`, the claim of the item's own `resync` row is the instant a reading must beat.
    const since = data.since ?? work.actionQueue?.actions.find(row => row.kind === 'resync' && row.state === 'claimed')?.claim?.claimedAt ?? null;
    const observedAt = work.observation?.at ?? null;
    const observed = !!since && !!observedAt && Date.parse(observedAt) > Date.parse(since);
    return { work, observationScheduled: wake && !!before!.submission, revision: work.revision, changed: work.revision !== before!.revision,
      since, observedAt, observed, job: await this.observationJob(work.id) };
  }
  /** The item's durable observation job as the queue holds it, or null when it has none. */
  async observationJob(id: string): Promise<ObservationJobState | null> {
    const row = (await this.store.pool.query('SELECT available_at, locked_until, attempts, error, held_until, held_reason FROM jobs WHERE work_id=$1', [id])).rows[0];
    if (!row) return null;
    const iso = (value: Date | null) => value ? new Date(value).toISOString() : null;
    return { availableAt: iso(row.available_at), lockedUntil: iso(row.locked_until), attempts: Number(row.attempts), error: row.error ?? null, heldUntil: iso(row.held_until), heldReason: row.held_reason ?? null };
  }
  async bindReviewRequest(id: string, expectedRevision: number, request: ReviewRequest, jobToken: string) {
    return this.store.transaction(async (db, now) => {
      const job = (await db.query('SELECT 1 FROM jobs WHERE work_id=$1 AND token=$2 AND locked_until>$3', [id, jobToken, now])).rows[0];
      requireCurrent(job, 'Integration job lease expired or superseded');
      const all = await lockedWork(db, [id]);
      const work = all.find(w => w.id === id);
      requireCurrent(work && work.revision === expectedRevision && work.stage !== 'done' && !work.observation?.merged, 'Task changed during review dispatch');
      const provider = reviewProviderOf(work.policy);
      demand((request.provider ?? 'codex') === provider && ['codex', 'agent'].includes(provider)
        && request.sha === work.candidate?.sha && request.baseSha === work.candidate?.baseSha && request.policyRevision === work.policyRevision, 'Review request candidate or policy changed');
      if (provider === 'agent') {
        const selected = reviewerProfileFor(work);
        demand(!!selected && selected.name === request.profile && selected.reviewerApp === request.reviewerApp && !!request.marker,
          'Review request does not name the currently selected reviewer profile');
      }
      work.reviewRequest = request;
      if (work.observation) work.observation.agentReview = provider === 'agent'
        ? { provider: 'agent', sha: request.sha, approved: false, profile: request.profile, reviewerApp: request.reviewerApp, reason: `Waiting for reviewer profile ${request.profile} to post a verdict through its registered App` }
        : { provider: 'codex', sha: request.sha, approved: false, reason: 'Waiting for dispatched Codex review' };
      this.evaluate(work, all, now); await this.recordDispatch(db, work, now); await save(db, work, 'github', 'review.requested', now); return work;
    });
  }
  /**
  }
  /**
   * Record provider exhaustion for the dispatched reviewer profile and release the request so
   * the next configured profile is selected. Failing over never approves anything: when no
   * profile remains, the review gate stays closed with the exhaustion recorded in history.
   */
  async failoverReviewRequest(id: string, expectedRevision: number, input: { exhaustion: 'usage-limit' | 'timeout'; reason: string }, jobToken: string) {
    return this.store.transaction(async (db, now) => {
      const job = (await db.query('SELECT 1 FROM jobs WHERE work_id=$1 AND token=$2 AND locked_until>$3', [id, jobToken, now])).rows[0];
      requireCurrent(job, 'Integration job lease expired or superseded');
      const all = await lockedWork(db, [id]);
      const work = all.find(w => w.id === id);
      requireCurrent(work && work.revision === expectedRevision && work.stage !== 'done' && !work.observation?.merged, 'Task changed during review failover');
      const request = work.reviewRequest;
      demand(work.policy.review && reviewProviderOf(work.policy) === 'agent' && request?.provider === 'agent'
        && request.sha === work.candidate?.sha && request.baseSha === work.candidate?.baseSha && request.policyRevision === work.policyRevision,
      'Review failover requires a current agent review request');
      const dispatched = reviewerProfileFor(work);
      demand(dispatched && dispatched.name === request!.profile && dispatched.reviewerApp === request!.reviewerApp, 'Review failover must name the currently dispatched reviewer profile');
      const exhausted = new Set([...exhaustedReviewerProfiles(work), dispatched!.name]);
      const next = (work.policy.reviewerProfiles ?? []).find(profile => !exhausted.has(profile.name)) ?? null;
      const failover: ReviewFailover = { profile: dispatched!.name, reviewerApp: dispatched!.reviewerApp, runtime: dispatched!.runtime,
        exhaustion: input.exhaustion, reason: input.reason.slice(0, 500), at: now.toISOString(), sha: request!.sha, baseSha: request!.baseSha,
        policyRevision: request!.policyRevision, requestCommentId: request!.commentId, nextProfile: next?.name ?? null };
      // The complete sequence stays in the append-only ledger; the document keeps recent entries.
      work.reviewFailovers = [...(work.reviewFailovers ?? []), failover].slice(-100);
      work.reviewRequest = null;
      if (work.observation) work.observation.agentReview = { provider: 'agent', sha: failover.sha, approved: false,
        profile: next?.name, reviewerApp: next?.reviewerApp,
        reason: next ? `Reviewer profile ${failover.profile} is exhausted (${failover.exhaustion}); Graphyard failed over to ${next.name}`
          : `Every configured reviewer profile is exhausted for this candidate; the last was ${failover.profile} (${failover.exhaustion})` };
      this.evaluate(work, all, now);
      await this.recordDispatch(db, work, now);
      await save(db, work, 'github', 'review.failover', now, failover);
      return work;
    });
  }
  /**
   * Evaluate one item and return the earliest instant at which its outcome could change with no
   * write (GY-1873): the minimum over the time-bounded inputs the evaluation read, which the
   * reconciliation keeps in its view so a pass wakes the item when that instant passes. The
   * derivation runs once and answers both — the account it computes names the action and the wait,
   * and the due reads the bounds beside them.
   */
  evaluate(work: Work, all: Work[], now: Date): number | null {
    // One request, one verdict (GY-124): two verdicts from one identity on one head for one request
    // are recorded as a conflict and withheld from the observation before any gate reads it.
    this.conflictTransitions.set(work, [...(this.conflictTransitions.get(work) ?? []), ...reconcileReviewConflict(work, now)]);
    // Graphyard keeps no merge queue (GY-1236) and no planned-file scope (GY-1992): a document stored
    // before then drops their fields, and a scope refusal it carried, before any gate reads them.
    dropRetiredQueueFields(work); dropRetiredScopeFields(work);
    const result = evaluate(work, all, now);
    if (work.stage !== result.stage) work.stageEnteredAt = now.toISOString();
    Object.assign(work, result);
    // GitHub merges on every passing gate (GY-1235): no merge authorization is recorded, and one a
    // record carried from before is cleared.
    if (work.mergeAuthorization) work.mergeAuthorization = null;
    // What the exact head still needs from a launched reviewer or producer, decided from the
    // gates just evaluated; the transitions reach the ledger with the document (recordDispatch).
    this.dispatchTransitions.set(work, reconcileAutoDispatch(work, all, now));
    // The typed instruction the inverted loop runs on: what this item needs next, named from the
    // gates just evaluated, and the durable row that says whether an executor has it.
    // The queue's own transitions are recorded on each row's history and travel to the ledger
    // with the document every save appends, so they need no second event of their own; the
    // executor's claim and settlement write their own named events.
    // One computation answers both: the queue reconciles against it and the item carries it, so
    // two readers of the same evaluation cannot disagree about what this item needs — and the
    // same account names the wait, whose bound is part of the due instant (GY-1873).
    const account = actionAccount(work, all, now);
    const computed = account.action;
    // An open item the derivation names nothing for and nothing moves is owned by an escalation (GY-201).
    reconcileActions(work, all, now, { next: computed ?? livenessFallback(work, all, now, account) });
    // Only a different decision is written: an identical action rebuilt in source order would
    // differ from the stored one by key order alone, and the reconciliation tick would rewrite
    // every item on every pass.
    if (work.nextAction === undefined || !sameAction(work.nextAction, computed)) work.nextAction = computed;
    // After the queue reconciled: the rows it leaves are the ones whose dues are read (GY-1873).
    return reconcileDueAt(work, all, now, account);
  }
  /** Append the auto-dispatch transitions of the last evaluation to the ledger, once, beside the document save. */
  private async recordDispatch(db: { query: (text: string, values: unknown[]) => Promise<unknown> }, work: Work, now: Date) {
    const transitions = this.dispatchTransitions.get(work) ?? [];
    this.dispatchTransitions.delete(work);
    for (const transition of transitions) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', transition.event, JSON.stringify({ details: { ...transition.request, at: now.toISOString() } })]);
    const conflicts = this.conflictTransitions.get(work) ?? [];
    this.conflictTransitions.delete(work);
    for (const transition of conflicts) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', transition.event, JSON.stringify({ details: { ...transition.conflict, at: now.toISOString() } })]);
  }
  /**
   * How long one reconciliation batch may hold its items' row locks before it yields (GY-274).
   * The first tick after a deploy re-evaluated every item under one lock for 65 s, and every
   * heartbeat queued behind it until the workers' supervisors gave up.
   */
  reconcileBatchMs = 250;
  /**
   * A reconciliation tick slower than this logs a warning with its item count and duration
   * (GY-727): a tick over the bound is the symptom that preceded GY-727's 30 s passes. The
   * production bound; only tests shorten it, as they shorten `reconcileBatchMs`.
   */
  reconcileSlowWarnMs = 5_000;
  /**
   * The most writes one batch plans (GY-1290): each runs in its own transaction under the
   * coordination lock, and every later item in the batch is evaluated against the earlier ones as
   * planned, so the count bounds how much one surprise at write time sends back for evaluation.
   */
  reconcileBatchWrites = 8;
  /**
   * How long a batch with writes waits in line for the coordination lock (GY-1115, GY-1290), never
   * more than half the server's `deadlock_timeout` (`coordinationLockWithin`); it holds no row while
   * it waits. A write that could not take it tries again, `reconcileRetryBackoffMs` later per
   * attempt, and after `reconcileMaxAttempts` attempts the batch's unwritten items are deferred to the next pass.
   */
  reconcileCommitLockWaitMs = 500;
  reconcileMaxAttempts = 3;
  reconcileRetryBackoffMs = 25;
  /** The last reconciliation ticks, newest last (GY-1115): what each evaluated, deferred and wrote, and its longest wait for the coordination lock. */
  readonly reconcileTicks: ReconcileTick[] = [];
  /**
   * How long reconciliation may go without evaluating every live item (GY-1124). Between full
   * passes a pass evaluates only the items whose inputs it can see moving; this bound catches up
   * what only the clock moves — an observation going stale, a settle window closing. It is the
   * floor: the next full pass is due no sooner than `fullEvaluationIntervalMs` (GY-1867).
   */
  reconcileFullEvaluationMs = configuredReconcileFullMs();
  /** The measured duration (ms, rounded) of the last full pass, recorded when that pass ends (GY-1867). */
  private reconcileFullMs = 0;
  /**
   * When the next full pass is due, measured from when the last one began (GY-1867): the configured
   * interval stretched past a pass that ran longer than a third of it — `max(I, 3 × its duration)` —
   * so a full pass is never due again the moment it ends and full passes take at most about a
   * quarter of the server's time whatever the fleet grows to; the configured value stays the floor.
   * An interval of 0 — unreachable through `GRAPHYARD_RECONCILE_FULL_MS`, which clamps to
   * 2000..300000 — keeps the meaning the stress suites give it: the clock brings every pass.
   */
  private fullEvaluationIntervalMs() {
    return this.reconcileFullEvaluationMs > 0 ? Math.max(this.reconcileFullEvaluationMs, 3 * this.reconcileFullMs) : 0;
  }
  /**
   * The fleet as the last pass left it (GY-1124): every item's document — a settled delivery's
   * work-index summary — with the row version (`xmin`) it was read at, whether the index called
   * it settled, and its fleet face (`fleetFace`). Kept between passes, so a pass reads again only
   * the documents whose row moved; cleared whenever a pass fails in a way that could leave it
   * holding a document the database rolled back.
   */
  private readonly reconcileView = new Map<string, ReconcileEntry>();
  /** Items a pass chose to evaluate that no committed batch evaluated (a deferred batch, a row a writer held): the next pass owes them. */
  private readonly reconcileOwed = new Set<string>();
  /** When the last full evaluation began (the database clock, ms), and the configuration it evaluated under. */
  private reconcileFullAt = -Infinity;
  private reconcileConfig = '';
  /**
   * Fleet faces a writer outside the running pass moved since the last pass decided what to
   * evaluate, by item, each with the face the view held before the move and the document read
   * after it (GY-1124, GY-1898): the next pass evaluates the moved item and the items whose
   * evaluation reads the face (`readsFace`) — not every live item, since GY-1898 — and a slow tick
   * names the faces and how many items they made evaluated.
   */
  private readonly reconcileFaceMoves = new Map<string, FaceMoveSides>();
  /**
   * Fleet faces the pass's own planned writes moved (GY-1777): the pass evaluated against them as
   * planned, so they do not make the next pass full; it evaluates the items whose evaluation reads
   * them (`readsFace`), and the bounded full evaluation catches up the rest.
   */
  private readonly reconcileOwnMoves = new Map<string, OwnFaceMove>();
  /** The event-loop lag sampler (GY-1777), open over each tick's window and read into the tick. */
  private readonly eventLoopLag = new EventLoopLag();
  /** What the last pass read and evaluated: the documents it fetched, the items it evaluated, and whether it was full. */
  lastReconcile = { documentsRead: 0, evaluated: 0, live: 0, full: false };
  /** Forget the kept view, so the next pass reads the whole fleet again (GY-1124). */
  resetReconcileView() { this.reconcileView.clear(); this.reconcileOwed.clear(); this.reconcileFullAt = -Infinity; this.reconcileFaceMoves.clear(); this.reconcileOwnMoves.clear(); }
  /**
   * Note a face another writer moved, merging the fields of one noted already, the before face of
   * the first and the after document of the last (GY-1777, GY-1898). The documents in between are
   * kept too: a pass may have evaluated another item against one of them, so its readers are owed.
   */
  private noteFaceMove(move: FaceMove, before: string, after: Work | null) {
    const known = this.reconcileFaceMoves.get(move.id);
    const noted = { move, before: faceDocument(before), after };
    this.reconcileFaceMoves.set(move.id, known ? { move: mergeFaceMoves([known.move, move])[0], before: known.before ?? noted.before, after: noted.after ?? known.after,
      between: [...known.between ?? [], ...[known.after, noted.before].filter((work): work is Work => !!work)] } : noted);
  }
  /** Note a face the pass's own planned write moved (GY-1777): the document before its first write of the pass and after its last, the fields merged. */
  private noteOwnMove(own: OwnFaceMove) {
    const known = this.reconcileOwnMoves.get(own.move.id);
    this.reconcileOwnMoves.set(own.move.id, known ? { move: mergeFaceMoves([known.move, own.move])[0], before: known.before, after: own.after } : own);
  }
  private reconcileRunning: Promise<void> | null = null;
  private reconcileTrailing: Promise<void> | null = null;
  /**
   * Reconcile every item whose inputs moved, one tick at a time per server (GY-1115, GY-1124): a
   * call made while a tick runs waits for the next tick, which starts once the running one ends and
   * serves every call that arrived meanwhile, so a request that reconciles after its own write
   * (`resyncWork`) still sees it. Each resync used to start a tick of its own, and concurrent ticks
   * held a connection each and kept moving each other's items, so every one of their batches was
   * contended. A tick therefore holds at most one pool connection. Ticks must not overlap for the
   * kept view's sake too: it is shared engine state, and a batch mutates its documents before it
   * commits, so a second tick must neither evaluate against that uncommitted state nor have its
   * view cleared by the first tick's failure.
   */
  reconcile(): Promise<void> {
    if (!this.reconcileRunning) {
      const run: Promise<void> = this.reconcileTick().finally(() => { if (this.reconcileRunning === run) this.reconcileRunning = null; });
      return this.reconcileRunning = run;
    }
    return this.reconcileTrailing ??= this.reconcileRunning.catch(() => {}).then(() => { this.reconcileTrailing = null; return this.reconcile(); });
  }
  /**
   * Renew `work`'s lease for `epoch` (GY-1124): the lease checks every heartbeat passes, shared by
   * the item-locked fast path and the operator-agent heartbeat through `executeCommand`, so a lease
   * check added for renewals is added once and reaches both.
   */
  private renewLease(work: Work, actor: Principal, epoch: number, now: Date) {
    endedBySubmission(work, epoch);
    activeLease(work, actor, epoch, now);
    // GY-1462: the backstop to the loop's end past the reclaim bound (GY-1460): an attempt held
    // unsubmitted past workerNoSubmissionRefusalMs is not renewed, so its lease lapses into containment and reclaim.
    demand(!noSubmissionRenewalRefused(work, now.getTime()),
      `Implementation lease for epoch ${epoch} of ${work.key} is not renewed: no submission in ${workerNoSubmissionRefusalMs / 60_000} minutes, past the worker no-submission bound; the attempt ends and its branch is kept for the next`);
    work.lease!.expiresAt = new Date(now.getTime() + this.leaseSeconds * 1000).toISOString();
    delete (work.lease as GracedLease).renewalFault;
    recordAssignmentStart(work, epoch, now);
  }

  /**
   * One reconciliation tick, in batches. The pass opens with one short coordination transaction
   * that reads every row's version (`xmin`) and settled flag — never a document — and compares
   * them with the view the previous pass kept (GY-1124): only the rows that moved since are read
   * again, under the lock as their compact stand-ins from the in-process cache (`lockedRows`,
   * GY-1027: an open item's coordination projection, a settled delivery's work-index summary), so
   * the lock hold grows with neither the history nor the open items' histories. The first pass of
   * a process reads every live document once. The opening also sweeps direct merges.
   *
   * The pass then evaluates the items whose own row moved, plus those whose inputs elsewhere
   * did: a fleet face any writer moved (anything beyond a lease renewal: stage, queue,
   * dependencies, resources, candidate…) brings the moved item and the items whose evaluation
   * reads it (`readsFace`: by reference, as a split sibling, through a shared exclusive resource
   * or an overlapping path scope) — since GY-1898 whatever the writer, so a routine session or
   * observation write no longer makes every pass full; the kept view's emptiness, a merge
   * configuration change and the full-evaluation interval are the only full passes. An item whose
   * lease has lapsed or whose standing escalations read the
   * ledger is evaluated, and the items an earlier pass deferred. No sooner than
   * `max(reconcileFullEvaluationMs, 3 × the last full pass's duration)` (GY-1867) after the last full
   * pass began, the pass evaluates every live item, for the inputs only the clock moves, so a full
   * pass is never due again the moment it ends. A pass after a heartbeat therefore reads one document
   * and evaluates one item. A
   * face the pass's own writes moved does not make the next pass full either (GY-1777): the next pass
   * evaluates the items whose evaluation reads it (`readsFace`), and a tick over
   * `reconcileSlowWarnMs` names what made it full — or, when a moved face drove it, the faces and
   * how many items they made evaluated — and the event-loop lag it ran under.
   *
   * Each batch evaluates on the background lane (a bounded share of the pool) holding no lock at
   * all (GY-1290): one short transaction compares every row's version with the view, re-reads only
   * the items that moved, and evaluates each item on a copy, against the whole fleet as the batch's
   * earlier planned writes will leave it, writing nothing (`reconcileItem`'s dry run), until
   * `reconcileBatchMs` has passed (GY-274's per-batch bound retained) or `reconcileBatchWrites`
   * writes are planned. A heartbeat, an observation save or any request on any item, the batch's
   * own included, commits while it evaluates. Each planned write then runs in a transaction of its
   * own (`reconcileWrite`): it waits in line for the coordination lock like every fleet command,
   * holding no row, then takes the item's row lock, writes the evaluation — again only if the item
   * or another item's face moved since — and commits. A row is therefore held for one item's write,
   * never across the batch, so a renewal never waits on the batch's evaluations or on its later
   * writes; and nothing rolls back because another item moved: the race GY-1115 bounded — a batch
   * holding its rows while it raced every fleet command for the coordination lock at commit with a
   * 200 ms wait, and rolling back whenever any item moved, which observation saves did every few
   * seconds (GY-1290) — is gone. Only a lock still held past `reconcileCommitLockWaitMs` on each of
   * `reconcileMaxAttempts` attempts defers the batch's unwritten items, and nothing else of it, to
   * the next pass. Between batches the event loop runs. Every batch evaluates at least one item.
   */
  private async reconcileTick() {
    const tickStarted = performance.now();
    // The event-loop lag over the tick's window (GY-1777): a timer's overrun past its 10 ms
    // resolution, so a tick slowed by a starved loop is told apart from one waiting on I/O.
    this.eventLoopLag.start();
    // The plane's liveness is read before this pass classes any lapse (GY-1791): the pass that meets
    // a lease the stall let run out must already find the stall on the record. The independent beat
    // (startPlaneBeat) keeps the tick moving through a long pass, so a pass's own length is no gap.
    await this.recordPlaneLiveness();
    try { await this.reconcilePass(tickStarted); }
    finally { this.eventLoopLag.stop(); }
  }
  /**
   * Record the plane's own liveness (GY-1791): the process beating on its own timer (startPlaneBeat),
   * before it answers requests (the server's startup), and at the start of every pass all call this.
   * A gap past `planeStallMs` since the previous record is one `plane.stall` ledger row, read, appended
   * and moved forward in one transaction under the row's lock, so a failed write leaves the old tick
   * and a concurrent process sees the gap once. That row is what lets the plane explain its own
   * outages: a lease lapsing inside a recorded stall is history with its cause, never a lease loss
   * (leaseLapseCause), and renewal grace keeps the lease live for a supervisor still retrying
   * (GY-558's rule). Best effort beside the pass — liveness bookkeeping never fails reconciliation.
   *
   * The tick runs on the lease pool, the connections heartbeats run on (pools.ts `leaseCommands`),
   * and on nothing else: a stall is "renewals could not land", so the tick must measure the path
   * that serves them. The request pool exhausted behind slow queries while heartbeats still land is
   * no stall — a tick there would have recorded one and explained away a worker that truly vanished
   * — and a lease pool that cannot take this tick's connection could not take a renewal either.
   *
   * The time recorded is read once the lease pool has answered (the connection taken and the
   * transaction open), never when the beat was sent: a beat held behind a black-holed connection
   * records when it landed, so beats that waited out an outage cannot replay the times they were
   * sent at over the gap and move the tick past a stall nothing recorded. A caller measuring a
   * simulated clock passes `at`.
   */
  async recordPlaneLiveness(at?: Date) {
    let db: PoolClient | null = null;
    try {
      db = await this.store.leasePool.connect();
      await db.query('BEGIN');
      at ??= new Date();
      await db.query('INSERT INTO plane_liveness(id,tick_at) VALUES(true,$1) ON CONFLICT (id) DO NOTHING', [at]);
      const previous = (await db.query('SELECT tick_at FROM plane_liveness WHERE id = true FOR UPDATE')).rows[0].tick_at as Date;
      let served: string | null | undefined;
      if (at.getTime() > previous.getTime()) {
        if (at.getTime() - previous.getTime() > planeStallMs)
          await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)',
            ['graphyard', 'plane.stall', JSON.stringify({ details: { from: previous.toISOString(), to: at.toISOString() } })]);
        // GY-2177: the first tick that moves also records what this process serves, against what the
        // tick named before it: a change is a deploy, recorded once with the window it names — from
        // the replaced release's last tick, when its renewals started landing nowhere, to this
        // process's first answer, from which the release before it refuses every renewal client-side
        // with the version skew until the loop realigns. That row is what lets the plane explain the
        // lapses its own deploy causes (leaseLapseCause), the way a stall row explains its outage.
        // The read is one indexed query per process, and the commit comparison makes a retried tick
        // (a failed transaction leaves the field unset) idempotent.
        if (this.servedCommit === undefined) {
          served = buildIdentity().commit;
          const last = await db.query(`SELECT payload->>'commit' AS commit FROM events WHERE kind = 'plane.deploy' ORDER BY created_at DESC LIMIT 1`);
          if (served && last.rows[0]?.commit !== served)
            await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)',
              ['graphyard', 'plane.deploy', JSON.stringify({ details: { commit: served, from: previous.toISOString(), to: at.toISOString() } })]);
        }
        await db.query('UPDATE plane_liveness SET tick_at = $1 WHERE id = true', [at]);
      }
      await db.query('COMMIT');
      // The field moves once the row is on the ledger: a failed transaction left it unset, and the
      // next tick's commit comparison retries the whole check without recording anything twice.
      if (served !== undefined) this.servedCommit = served;
    } catch {
      await db?.query('ROLLBACK').catch(() => {}); // the next beat records it
    } finally { db?.release(); }
  }
  /**
   * Beat the plane's liveness on a timer of its own, so slow serial work between passes is never
   * read as an outage. The first beat lands before this resolves, so a server starts answering
   * heartbeats with the gap since its previous process already on the record. One beat is in flight
   * at a time: a beat the lease pool has not answered is not joined by the next interval's, so an
   * outage queues no pile of beats to land together when the pool answers again.
   */
  async startPlaneBeat(intervalMs = planeStallMs / 6): Promise<() => void> {
    await this.recordPlaneLiveness();
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void this.recordPlaneLiveness().finally(() => { inFlight = false; });
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
  private async reconcilePass(tickStarted: number) {
    // A pass would otherwise open on a cold stand-in cache and project, under the coordination lock,
    // every row it has not cached — every open document on a process's first pass (GY-1042), and on
    // each later pass every row another process wrote since (GY-1939): warm it, outside the lock.
    await warmLockedReads(this.store.pool);
    const fleet = this.reconcileView;
    let all: Work[] = [], candidates: string[] = [], next = 0, documentsRead = 0, full = false;
    const tick: ReconcileTick = { at: new Date().toISOString(), candidates: 0, evaluated: 0, deferred: 0, maxAttempts: 0, ms: 0, writes: 0, lockWaitMs: 0, due: 0, full: null, faces: [], readers: 0, lagMs: null };
    const view = () => { all = [...fleet.values()].sort((a, b) => a.number - b.number).map(entry => entry.work); };
    // Only the pass's candidates and the rows not settled now are versioned: a settled delivery that stays settled is never visited.
    const versionsOf = async (db: PoolClient) => new Map<string, string>((await db.query(reconcileVersionsSql, [candidates])).rows.map(row => [row.id, row.version]));
    const moved = (versions: Map<string, string>) => [...versions].filter(([id, version]) => fleet.get(id)?.version !== version).map(([id]) => id);
    // Read moved rows again into the view. Every face the read finds moved is noted for the next
    // decision with the face the view held and the document read (GY-1898), whichever writer moved it.
    const reread = async (db: PoolClient, ids: string[]): Promise<FaceMove[]> => {
      if (!ids.length) return [];
      const rows = (await db.query(reconcileRereadSql, [ids])).rows as { id: string; number: string; version: string; document: Work }[];
      documentsRead += rows.length;
      const moves: FaceMove[] = [];
      for (const row of rows) {
        const face = fleetFace(row.document), before = fleet.get(row.id)?.face ?? '';
        if (before !== face) { const move = { id: row.id, key: row.document.key, fields: faceFields(before, face) }; moves.push(move); this.noteFaceMove(move, before, row.document); }
        // The document moved, so whatever due its last evaluation read is stale; the item is a candidate
        // this pass (a moved row is changed), and its next evaluation records the fresh instant (GY-1873).
        fleet.set(row.id, { number: Number(row.number), work: row.document, version: row.version, settled: false, face, due: null });
      }
      view();
      return moves;
    };
    let opened = false, decided = false, changed: string[] = [], config = '', fullCause: ReconcileFull['cause'] | null = null, openedAt = 0;
    // The live items whose recorded due instant has passed (GY-1873), kept beside the pass's other
    // candidate sets so the batches can say what an evaluation was woken by.
    let clockDue = new Set<string>();
    const pass: ReconcilePass = { fleet, all: () => all, view, versionsOf, moved, reread, lockWait: ms => { tick.lockWaitMs = Math.max(tick.lockWaitMs, Math.round(ms)); } };
    try {
      for (;;) {
        const opening = !opened, evaluating: string[] = [], plans: ReconcilePlan[] = [];
        let gone = 0;
        const finished = await this.store.transaction(async (db, now) => {
          if (opening) {
            // Versions first: a row that moves after them reads as moved, so the first batch reads it again.
            const listed = (await db.query(reconcileRowsSql)).rows as { id: string; number: string; version: string; settled: boolean }[];
            config = stableJson({});
            // Measured on the clock evaluation reads, so time the gates see pass is what brings the catch-up.
            // GY-1867: the interval stretches past the last full pass, so the tick after a long full
            // pass is not full again at once; a face a writer moved no longer makes it full either
            // (GY-1898): the moved item and its readers are evaluated instead.
            fullCause = !fleet.size ? 'view' : config !== this.reconcileConfig ? 'configuration' : !(now.getTime() - this.reconcileFullAt < this.fullEvaluationIntervalMs()) ? 'interval' : null;
            full = fullCause !== null;
            openedAt = now.getTime();
            if (full) this.reconcileFullAt = openedAt;
            const versions = new Map(listed.map(row => [row.id, row]));
            for (const id of [...fleet.keys()]) if (!versions.has(id)) { const entry = fleet.get(id)!; this.noteFaceMove({ id, key: entry.work.key, fields: ['gone'] }, entry.face, null); fleet.delete(id); }
            changed = listed.filter(row => { const entry = fleet.get(row.id); return !entry || entry.version !== row.version || entry.settled !== row.settled; }).map(row => row.id);
            // Under the lock the pass reads no document whole (GY-1027): a row that moved is held as its
            // stand-in — a settled delivery's summary, an open item's projection, served from the
            // in-process cache — and the first batch reads the open ones whole, outside the lock.
            const rows = await lockedRows(db, []);
            for (const { number, document } of rows) {
              const row = versions.get(document.id), entry = fleet.get(document.id);
              if (!row || entry && entry.version === row.version && entry.settled === row.settled) continue;
              const settled = isSettledSummary(document);
              if (!settled) { fleet.set(document.id, { number, work: document, version: row.version, settled, face: entry?.face ?? '', due: null }); continue; }
              const face = fleetFace(document);
              if (entry?.face !== face) this.noteFaceMove({ id: document.id, key: document.key, fields: faceFields(entry?.face ?? '', face) }, entry?.face ?? '', document);
              fleet.set(document.id, { number, work: document, version: row.version, settled, face, due: null });
            }
            view();
            // Items held for a merge inside a direct-merge window are delivered before anything else reads them.
            const swept = await sweepDirectMerges(db, all, await directMergeWindows(db, this.directMergeEnvironment), now);
            if (swept.length) {
              const after = await versionsOf(db);
              for (const work of swept) {
                const entry = fleet.get(work.id);
                if (!entry) continue;
                const face = fleetFace(work), fields = faceFields(entry.face, face);
                this.noteFaceMove({ id: work.id, key: work.key, fields: fields.length ? fields : ['swept'] }, entry.face, work);
                Object.assign(entry, { work, version: after.get(work.id) ?? '', face, due: null });
              }
              view();
            }
            opened = true;
            return false;
          }
          if (!decided) {
            // The rows the opening held as stand-ins, read whole outside the coordination lock — their
            // moves are noted like any other writer's, and consumed here — then the pass decides what
            // it evaluates: the items whose own row moved, the moved item and the readers of a face any
            // writer moved (GY-1898), the lapsed, escalated and owed ones, and the dues. An item moved
            // twice (once noted mid-pass, once held as a stand-in here) is one move with the fields of both.
            await reread(db, [...fleet].filter(([, entry]) => !entry.settled && isStandIn(entry.work)).map(([id]) => id));
            const external = [...this.reconcileFaceMoves.values()];
            this.reconcileFaceMoves.clear();
            // A face any writer moved is decided the way the pass's own moved faces are (GY-1777):
            // only the moved item and the items whose evaluation reads it are due. Only the kept
            // view, the merge configuration and the full-evaluation interval make the pass full.
            const faceReaches = external.map(note => faceReach(note, all));
            const ownReaches = [...this.reconcileOwnMoves.values()].map(own => faceReach(own, all));
            this.reconcileOwnMoves.clear();
            const reaches = [...faceReaches, ...ownReaches];
            const live = [...fleet].filter(([, entry]) => !entry.settled).sort(([, a], [, b]) => a.number - b.number).map(([id]) => id);
            const moved = external.map(({ move }) => move).sort((a, b) => (fleet.get(a.id)?.number ?? Infinity) - (fleet.get(b.id)?.number ?? Infinity) || a.key.localeCompare(b.key));
            if (full) tick.full = { cause: fullCause!, moved };
            tick.faces = moved;
            // What only the clock can change (GY-1873): every evaluated item left the earliest instant
            // its outcome could change with no write in the view, and the pass wakes the ones whose
            // instant has passed, beside the items whose inputs moved as before. The full evaluation
            // stays as the safety net over both.
            clockDue = full ? new Set<string>() : new Set(live.filter(id => { const entry = fleet.get(id)!; return entry.due !== null && entry.due <= now.getTime(); }));
            const due = full ? new Set(live) : new Set([
              ...changed,
              // The moved items themselves: one noted mid-pass had its row read into the view since,
              // so `changed` no longer names it, and one noted here as a stand-in never left it.
              ...moved.map(move => move.id),
              ...this.reconcileOwed,
              ...live.filter(id => { const work = fleet.get(id)!.work; return !!work.lease && Date.parse(work.lease.expiresAt) <= now.getTime() || reaches.some(reach => readsFace(fleet.get(id)!, reach)); }),
              ...clockDue,
            ]);
            // How many items the moved faces made evaluated (GY-1898), for the slow-tick warning.
            if (!full) tick.readers = live.filter(id => due.has(id) && (moved.some(move => move.id === id) || faceReaches.some(reach => readsFace(fleet.get(id)!, reach)))).length;
            if (full) this.reconcileConfig = config;
            candidates = live.filter(id => due.has(id)); tick.candidates = candidates.length;
            this.reconcileOwed.clear();
            for (const id of candidates) this.reconcileOwed.add(id);
            decided = true;
          }
          // Evaluation, holding no lock: each item on a copy of its current document, writing nothing.
          await reread(db, moved(await versionsOf(db)));
          const started = performance.now(), batch = next;
          // Each item is evaluated against the fleet as the batch's earlier writes will leave it, as if each had been written in turn.
          const planned = new Map<string, Work>();
          while (next < candidates.length) {
            if (next > batch && (plans.length >= this.reconcileBatchWrites || performance.now() - started >= this.reconcileBatchMs)) return false;
            // The dry run awaits no I/O: between evaluations a renewal runs first (`yieldToRenewals`).
            await this.yieldToRenewals();
            const id = candidates[next++];
            // Deleted since the pass opened, nothing is left to evaluate; a stand-in from the opening
            // read is read whole as the batch reaches it (GY-1027).
            if (!fleet.has(id)) { gone++; continue; } else if (isStandIn(fleet.get(id)!.work)) await reread(db, [id]);
            evaluating.push(id);
            const entry = fleet.get(id)!, copy = structuredClone(entry.work);
            const outcome = await this.reconcileItem(db, copy, planned.size ? all.map(work => planned.get(work.id) ?? work) : all, now, { dryRun: true });
            // The evaluation read the document as it stands: its due instant stands whatever it wrote (GY-1873).
            entry.due = outcome.due;
            if (!tick.full && clockDue.has(id)) tick.due++;
            if (outcome.wrote) {
              planned.set(id, copy); plans.push({ id, work: copy, version: entry.version, now, due: outcome.due });
            }
          }
          return true;
        }, { lane: 'background', coordinationLock: opening, retryStaleWrites: false });
        if (opening) continue;
        // What the batch found nothing to write for is settled; each planned item is settled by its own write.
        for (const id of evaluating) if (!plans.some(plan => plan.id === id)) this.reconcileOwed.delete(id);
        tick.evaluated += evaluating.length - plans.length; tick.deferred += gone; tick.maxAttempts = Math.max(tick.maxAttempts, 1);
        // Writing, each item in a transaction of its own (`reconcileWrite`), so no row is held past its own write.
        let stale = false, attempts = 0;
        for (let index = 0; index < plans.length;) {
          let written: ReconcileWritten;
          try { written = await this.reconcileWrite(plans[index], stale, pass); }
          catch (error) {
            // Nothing was written: the coordination lock stayed held past the wait, so the write is tried again.
            if (!(error instanceof ReconcileContended)) throw error;
            tick.maxAttempts = Math.max(tick.maxAttempts, ++attempts);
            if (attempts < this.reconcileMaxAttempts) { await new Promise(resolve => setTimeout(resolve, this.reconcileRetryBackoffMs * attempts)); continue; }
            // Out of attempts: the batch's unwritten items stay owed to the next pass, and the pass goes on.
            console.warn(`reconciliation deferred ${plans.length - index} item(s) after ${attempts} attempts found the coordination lock held past ${this.reconcileCommitLockWaitMs} ms; retrying next tick`);
            tick.deferred += plans.length - index;
            break;
          }
          // Committed: what the write saved stands in for its row in the next locked read (GY-1027), and a
          // face it moved is owed to the rest of the fleet.
          written.apply(); rememberSaved(written.saved);
          this.reconcileOwed.delete(plans[index].id);
          if (written.faceMoved) this.noteOwnMove(written.faceMoved);
          tick.maxAttempts = Math.max(tick.maxAttempts, attempts + 1); tick.evaluated++; if (written.wrote) tick.writes++;
          stale = written.stale; attempts = 0; index++;
        }
        if (finished) break;
        await new Promise(resolve => setImmediate(resolve));
      }
    } catch (error) {
      // A failure that rolled back a transaction may leave the kept view holding a document the database never stored.
      this.resetReconcileView();
      throw error;
    }
    this.lastReconcile = { documentsRead, evaluated: tick.evaluated, live: [...fleet.values()].filter(entry => !entry.settled).length, full };
    const elapsedMs = performance.now() - tickStarted;
    tick.ms = Math.round(elapsedMs);
    // The next full pass is spaced past this one's own length, whatever made it full (GY-1867).
    if (tick.full) this.reconcileFullMs = tick.ms;
    tick.lagMs = this.eventLoopLag.read();
    this.reconcileTicks.push(tick);
    if (this.reconcileTicks.length > 20) this.reconcileTicks.shift();
    if (elapsedMs >= this.reconcileSlowWarnMs) {
      // GY-1777: the warning says what made the pass full and the loop's lag, so a starved process is told from a held lock.
      const why = tick.full ? `every live item evaluated because ${describeFull(tick.full)}`
        : `${tick.candidates} candidate(s) whose inputs moved${tick.faces.length ? `, ${describeFaceMoves(tick.faces)} and made ${tick.readers} evaluated` : ''}${tick.due ? `, ${tick.due} of them due by the clock` : ''}`;
      const lag = tick.lagMs ? `event-loop lag p50 ${tick.lagMs.p50} ms, max ${tick.lagMs.max} ms over the tick` : 'no event-loop lag sample over the tick';
      console.warn(`reconciliation tick took ${Math.round(elapsedMs)} ms for ${this.lastReconcile.live} item(s) (${tick.evaluated} evaluated, ${tick.writes} written, longest wait for the coordination lock ${tick.lockWaitMs} ms; ${why}; ${lag}), over the ${this.reconcileSlowWarnMs} ms bound; a high lag is this process starved of CPU, otherwise find what held the coordination lock in the server logs`);
    }
  }
  /**
   * Write one item a reconciliation batch planned, in a transaction of its own (GY-1290). It waits
   * in line for the coordination lock holding no row, so no fleet command can move what the item
   * reads while it writes; reads again whatever moved since the batch evaluated; and only then
   * takes the item's row lock, which nothing but a lease renewal can hold now, for its own write.
   * When neither the item's row nor any item's face moved since the evaluation (`stale` carries an
   * earlier write that came out other than evaluated), the evaluation stands and is written as it
   * is; otherwise the item is evaluated again, on its current document against the current fleet.
   * Committing per item means a renewal waits on reconciliation for at most its own item's write:
   * never on the batch's evaluation of other items, nor on a later write that waits for its turn.
   */
  private async reconcileWrite(plan: ReconcilePlan, stale: boolean, pass: ReconcilePass): Promise<ReconcileWritten> {
    // Before its transaction, so the write holds no lock while a renewal runs.
    await this.yieldToRenewals();
    return this.store.transaction(async (db, now) => {
      const waitStarted = performance.now(), locked = await this.coordinationLockWithin(db, this.reconcileCommitLockWaitMs);
      pass.lockWait(performance.now() - waitStarted);
      if (!locked) throw new ReconcileContended();
      if ((await pass.reread(db, pass.moved(await pass.versionsOf(db)))).length) stale = true;
      const row = (await db.query(reconcileRowLockSql, [plan.id])).rows[0] as { version: string } | undefined;
      if (!row || !pass.fleet.has(plan.id)) return { wrote: false, stale, faceMoved: null, saved: [], apply: () => {} };
      if (row.version !== pass.fleet.get(plan.id)!.version) await pass.reread(db, [plan.id]);
      const entry = pass.fleet.get(plan.id)!;
      let work = plan.work, before = entry.work, due = plan.due;
      if (!stale && entry.version === plan.version) await this.writeReconciled(db, work, pass.all(), plan.now);
      else {
        // In place: a failure from here on clears the kept view, as every rolled-back write does. The
        // document as it stood is kept apart (GY-1777), so a reader of a relationship the write
        // removes (a path, a resource) is reached through it rather than left to the full pass.
        before = structuredClone(entry.work);
        work = entry.work;
        const outcome = await this.reconcileItem(db, work, pass.all(), now);
        // The re-evaluation read the document as it now stands: its due instant replaces the planned one (GY-1873),
        // here and in what the committed write keeps.
        entry.due = due = outcome.due;
        // Items the batch evaluated after this one read it as evaluated: if it came out otherwise, they are evaluated again too.
        if (fleetFace(work) !== fleetFace(plan.work)) stale = true;
        if (!outcome.wrote) return { wrote: false, stale, faceMoved: null, saved: [], apply: () => {} };
      }
      const version = ((await db.query('SELECT xmin::text AS version FROM work_items WHERE id = $1', [plan.id])).rows[0] as { version: string }).version, face = fleetFace(work);
      const saved = await savedVersions(db, [work]);
      const faceMoved = face !== entry.face ? { move: { id: plan.id, key: work.key, fields: faceFields(entry.face, face) }, before, after: work } : null;
      return { wrote: true, stale, faceMoved, saved, apply: () => { Object.assign(entry, { work, version, face, due }); pass.view(); } };
    }, { lane: 'background', coordinationLock: false, retryStaleWrites: false });
  }
  /**
   * Take the coordination lock for one planned write, waiting in line for at most `ms` (GY-1115,
   * GY-1290). The write's transaction holds no row lock when it asks, so no holder can be waiting
   * on it; the check that none is (`reconcileCommitBlockingSql`) and the wait's cap at half the
   * session's `deadlock_timeout` keep that guarantee enforced rather than assumed, should a write
   * ever take a lock before it. A wait past `ms`, or a holder blocked on the write, is contention:
   * the write is tried again.
   */
  private async coordinationLockWithin(db: PoolClient, ms: number) {
    const { blocking, deadlock_ms: deadlockMs } = (await db.query(reconcileCommitBlockingSql, [advisoryLocks.coordination])).rows[0];
    if (blocking) return false;
    await db.query(`SET LOCAL lock_timeout = '${commitLockWaitMs(ms, Number(deadlockMs))}ms'`);
    try { await db.query('SELECT pg_advisory_xact_lock($1)', [advisoryLocks.coordination]); }
    catch (error) { if (['55P03', '40P01'].includes((error as { code?: string }).code ?? '')) return false; throw error; }
    await db.query('SET LOCAL lock_timeout TO DEFAULT');
    return true;
  }
  /**
   * One item's reconciliation inside a batch, holding the item's row lock; `wrote` says whether it
   * wrote the item, and `due` is the earliest instant at which the evaluated document's outcome
   * could change with no write (GY-1873), read whether or not anything was written — that instant
   * is what wakes the item later. A `dryRun` (GY-1290) evaluates `work` — a copy — with no lock and
   * writes nothing: `wrote` says the evaluation would write, which is all the batch's lock-free
   * phase asks.
   */
  private async reconcileItem(db: PoolClient, work: Work, all: Work[], now: Date, { dryRun = false }: { dryRun?: boolean } = {}): Promise<{ wrote: boolean; due: number | null }> {
    // A delivered item is not re-evaluated, but one still holding rows, a merge-queue entry (stored
    // before GY-1236) or an action from before its delivery — every item delivered before GY-185 —
    // is settled here once, and the check that finds nothing to settle costs no evaluation. A
    // verify-deployment row or action left from before done-at-merge (GY-1981) is such a leftover.
    if (work.stage === 'done') {
      const leftover = !!(work as Work & { queue?: unknown }).queue || !!work.actionQueue?.actions.length || !!work.nextAction;
      if (!leftover || !settleDelivered(work, all, now)) return { wrote: false, due: null };
      this.reconcileWrites.set(work, { delivered: true });
      if (!dryRun) await this.writeReconciled(db, work, all, now);
      return { wrote: true, due: null };
    }
    const before = JSON.stringify(work);
    // The liveness invariant (GY-201) is judged on the record as it stood, before this tick
    // touched it, so a violation the tick repairs is recorded rather than silently absorbed.
    const stranded = livenessOf(work, all, now).violation;
    preserveAssignment(work);
    // A recorded server-side renewal fault keeps the lease for one more period (GY-558).
    await this.renewalGrace(db, work, now);
    const leaseLost = !!work.lease && Date.parse(work.lease.expiresAt) <= now.getTime();
    // GitHub executes merges (GY-258): a merge execution recorded before that stays in the
    // ledger, where delivery attribution reads it, and no longer holds the record.
    if (work.mergeExecution) work.mergeExecution = null;
    const ledger: { kind: string; details: Record<string, unknown> }[] = [];
    // A lapsed lease ends the attempt and the item is claimable again: nothing is escalated.
    const lost = leaseLost ? work.lease! : null;
    if (lost) {
      work.lease = null;
      ledger.push({ kind: 'lease.expired', details: { owner: lost.owner, epoch: lost.epoch, expiresAt: lost.expiresAt, submission: work.submission } });
      endLapsedAttempt(work, lost, now);
    }
    const due = this.evaluate(work, all, now);
    // Every violation found at the start of the tick is repaired by the evaluation above — the
    // derivation names its successor and the queue opens its row — and the ledger says so.
    if (stranded) ledger.push(livenessRepairEntry(stranded, work, all, now));
    if (!jsonChanged(before, work)) return { wrote: false, due };
    this.reconcileWrites.set(work, { ledger });
    if (!dryRun) await this.writeReconciled(db, work, all, now);
    return { wrote: true, due };
  }
  /** What `reconcileItem`'s evaluation of a document decided to write, kept until it is written (GY-1290). */
  private readonly reconcileWrites = new WeakMap<Work, { delivered: true } | { ledger: { kind: string; details: Record<string, unknown> }[] }>();
  /** Write `work` as `reconcileItem` evaluated it at `now`: its ledger entries, its dispatch transitions, the document and its wakes. */
  private async writeReconciled(db: PoolClient, work: Work, all: Work[], now: Date) {
    const write = this.reconcileWrites.get(work)!;
    this.reconcileWrites.delete(work);
    if ('delivered' in write) { await save(db, work, 'graphyard', 'delivery.settled', now); return; }
    const { ledger } = write;
    for (const entry of ledger) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', entry.kind, JSON.stringify({ details: { ...entry.details, at: now.toISOString() } })]);
    await this.recordDispatch(db, work, now);
    await save(db, work, 'graphyard', 'reconciled', now, ledger.length ? { ledger: ledger.map(entry => entry.kind) } : undefined);
    if (work.submission) await wakeJob(db, work.id);
  }
  /**
   * Save a provider observation of the item, read at `expectedRevision`.
   *
   * An item that moved since that read refuses the observation, except where every move was
   * action-queue bookkeeping (`onlyActionsMovedSince`): an executor claiming or settling the item's
   * `resync` row saves the item, and refusing the observation over that write discarded the very
   * reading the row was waiting for, so the item stayed stale and the row was claimed again,
   * forever (GY-607). The loop's own bookkeeping counts the same way (`sameBesideBookkeeping`,
   * GY-1257): its per-cycle writes refused the very observation it had woken for a rework decision.
   * Any other move that left everything the observation was derived from unchanged counts the same
   * (`sameObservationInputs`, GY-1310): a session, lease, evidence or dispatch write raced every poll,
   * so gate claims waited minutes for an observation that was taken and then discarded.
   */
  async observe(id: string, expectedRevision: number, observation: Observation, jobToken?: string) {
    return this.store.transaction(async (db, now) => {
      if (jobToken) {
        // The item row before the job row (GY-1115): the order every transaction takes them in, so this never deadlocks a reconciliation batch.
        // This job row is locked mid-transaction and the queue's wakes at COMMIT lock theirs after it, out of work-id order:
        // the one exception to the job rows' stable order (GY-1212). Wakes never wait on a row out of order themselves, so a
        // cycle needs two observations each holding its own job and each waking the other's, which only two deliveries of
        // queued items observed at the same instant do (each still sees the other queued). Postgres then aborts one as a
        // deadlock; its observation is refused, nothing is saved, and its job is claimed again once its lease lapses.
        await db.query('SELECT 1 FROM work_items WHERE id=$1 FOR UPDATE', [id]);
        const owned = await db.query('SELECT 1 FROM jobs WHERE work_id=$1 AND token=$2 AND locked_until>clock_timestamp() FOR UPDATE', [id, jobToken]);
        requireCurrent(owned.rowCount, 'Integration job lease expired or superseded; retry');
      }
      const all = await lockedWork(db, [id]);
      const work = all.find(w => w.id === id);
      requireCurrent(work && (work.revision === expectedRevision || await onlyActionsMovedSince(db, work, expectedRevision, sameObservationInputs)), 'Task changed while GitHub was being observed; retry');
      demand(work.submission?.pr === observation.candidate.pr, 'Unassigned pull request');
      demand(work.workspaces.some(w => w.epoch === work.submission!.epoch && w.branch === observation.candidate.branch), 'PR branch does not match the assigned workspace');
      if (work.stage === 'done') return work;
      // GY-1523: a candidate the control plane observed itself carries a change number, not a pull
      // request number; a GitHub reading of the pull request that happens to bear it is not this candidate.
      if (work.observation?.source === 'control-plane' && observation.source === undefined) return work;
      let authorizedSnapshot: Work | null = null; let authorizationRevision: number | null = null;
      // The instant the delivery was judged at: the last instant before the merge cutoff.
      let evidenceAsOf: string | null = null;
      let operatorAuthorization: OperatorAuthorizedDelivery | null = null;
      if (observation.merged && observation.mergedAt && Number.isFinite(Date.parse(observation.mergedAt))) {
        const providerMergedTime = Date.parse(observation.mergedAt);
        // GitHub merges (GY-1235): no execution or clock offset is issued, so the merge instant is
        // GitHub's own and the cutoff the first instant after it.
        const mergedTime = providerMergedTime;
        const cutoff = providerMergedTime + (/\.\d+Z$/.test(observation.mergedAt) ? 1 : 1000);
        evidenceAsOf = new Date(cutoff - 1).toISOString();
        // The record as it stood immediately before the merge: what the delivery judgement reads,
        // and what a direct-merge window delivers. A snapshot whose own observation
        // already reports this pull request merged was written after the merge, whatever its
        // timestamp, and carries the merge's consequences, so it is never read (GY-94).
        // A row stored as a delta (store/snapshot-delta.ts) is read as the document it stands for.
        const past = await documentBefore(db, id, new Date(cutoff),
          record => !(record.observation?.merged && record.observation.candidate?.pr === observation.candidate.pr));
        const historical = past ? historicalAuthorizationRefusals(past, all, observation, cutoff, mergedTime) : ['No record of the item precedes the merge cutoff'];
        // GitHub's merge of a head whose every gate passed on that head is the delivery.
        if (past && !historical.length) { authorizedSnapshot = past; authorizationRevision = past.revision; }
        // An observed merge of a head whose gates had not passed is a recorded violation that every
        // later observation re-derives from immutable history. Inside a direct-merge window the
        // operator owns every merge into the base branch: it is delivered as operator-authorized,
        // naming the setting and who set it (direct-merge.ts).
        const directMerge = !authorizedSnapshot && observation.mergeSha ? coveringWindow(await directMergeWindows(db, this.directMergeEnvironment), providerMergedTime) : null;
        if (directMerge) {
          const snapshot = past ?? structuredClone(work);
          authorizedSnapshot = snapshot; authorizationRevision = snapshot.revision;
          operatorAuthorization = directMergeAuthorization(directMerge, { sha: observation.mergeSha!, at: observation.mergedAt }, snapshot.revision, new Date(cutoff).toISOString(), historical);
        }
      }
      const previousObservation = work.observation;
      // When this pull request's head was first observed (GY-1460): the worker bound reads a push from it, never a poll.
      observeHead(work, observation.candidate, observation.at);
      work.candidate = observation.candidate;
      work.observation = observation;
      // When the hold on this head was first sighted (GY-1557): the actorless bound runs from it, never from a poll that reads it again.
      observeBaseHold(work, observation.at);
      // A newer approval of the head a base refresh was built from replaces the carried binding
      // (GY-831), so the binding names a review the pull request still holds.
      const refreshed = observation.merged ? null : refreshedCarriedApproval(work);
      const carrying = refreshed ? currentCarry(work) : null;
      if (refreshed && carrying) {
        const replaced = carrying.approval as CarriedApproval;
        carrying.approval = refreshed;
        await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', 'review.carry-refreshed',
          JSON.stringify({ details: { reviewer: refreshed.reviewer, reviewId: refreshed.reviewId, sha: refreshed.originalSha, replaced: { reviewId: replaced.reviewId ?? null, sha: replaced.originalSha }, candidate: work.candidate!.sha } })]);
      }
      this.evaluate(work, all, now);
      if (observation.merged) {
        const violation = unauthorizedMergeViolation;
        if (authorizedSnapshot && observation.mergeSha) {
          // An operator-authorized delivery is judged by the operator, not the gates: what the
          // record lacked is on the delivery, and the violation it owns leaves the record the same way.
          if (operatorAuthorization) work.violations = work.violations.filter(entry => entry !== violation && !entry.startsWith(reconciliationRefusalPrefix));
          else if (work.gates.some(g => !g.passed)) work.violations.push('Post-merge checks differ from the recorded authorization; follow-up required');
          work.stage = 'done'; work.stageEnteredAt = now.toISOString();
          const delivery: Work['delivery'] = { mergedAt: observation.mergedAt!, mergeSha: observation.mergeSha, authorizationRevision: authorizationRevision!, ...(evidenceAsOf ? { evidenceAsOf } : {}) };
          work.delivery = operatorAuthorization ? Object.assign(delivery, { operatorAuthorization }) : delivery;
          if (operatorAuthorization) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, operatorAuthorization.operator, 'merge.operator-authorized',
            JSON.stringify({ details: { ...operatorAuthorization, mergeSha: observation.mergeSha, mergedAt: observation.mergedAt, authorizationRevision, evidenceAsOf, gatesNow: work.gates.filter(gate => !gate.passed).map(gate => ({ name: gate.name, reasons: gate.reasons })), at: now.toISOString() } })]);
          await db.query('DELETE FROM jobs WHERE work_id=$1', [work.id]);
          // Delivered in this transaction: what it still owes is recomputed now and its leftover rows
          // retired, so nothing retries against the delivery (GY-185).
          settleDelivered(work, all, now);
        } else {
          if (!work.violations.includes(violation)) work.violations.push(violation);
        }
      }
      await this.recordDispatch(db, work, now);
      await save(db, work, 'github', 'github.observed', now);
      return work;
    });
  }
}
