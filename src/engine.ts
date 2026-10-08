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
import { authorizedForProof, unauthorizedProofs } from './proof-grants.js';
import { workspacePath, pathsOverlap, validBranch } from './workspace.js';
import { activeLease, dropRetiredQueueFields, admin, assertReviewerProfiles, operatorCapability, escalationTriggers, raiseEscalation, releaseLeadHold, resolveEscalation, standingEscalations, attestationFor, attestationKinds, attestationsFromLedger, leaseLapseCause, leaseLossEpoch, leaseLossReason, settleableLeaseLoss, submittedEpoch, type Attestation, requireCurrent, createSchema, criterionSchema, bindingApproval, carriedApproval, currentCarry, refreshedCarriedApproval, currentEvidence, attachedCriteria, exerciseRefusal, proofExerciseSchema, decideCarry, exactApproval, type CarriedApproval, deploySmokeProof, deploySmokeRequired, inheritedObligations, pathScopeContains, requiredProofs, resourcesSchema, demand, evaluate, mergeabilityComputingRefusal, exhaustedReviewerProfiles, proofSchema, reviewerProfileFor, reviewerProfileSchema, reviewProviders, reviewProviderOf, type Criterion, type Evidence, type EvidenceAttestation, type Lease, type Principal, type ReviewerApp, type ReviewFailover, type Work, type Observation, type ReviewRequest, type OperatorCapability } from './model.js';
import { Refusal, demandWork } from './model/refusal.js';
import { resourceConflicts } from './coordination.js';
import { containmentAttestation, containmentSettlementRefusals, containmentVerificationSchema } from './quarantine.js';
import { containmentPhase } from './model/containment.js';
import { activeEngineers, delegationLimits, implementerIdentities, leadMay, producerIndependenceRefusal, sessionKind } from './delegation.js';
import { unauthorizedMergeViolation } from './merge-queue.js';
import { conflictSince, requestedBaseRefresh, disprovedConflict, withDisprovedConflict, dismissedApproval, onto, reconciliationRefusalPrefix, reconcileCheckReruns, rerunFailedChecksEvent, checkRerunLimit, owedRerunAfter, type BaseRefresh, type CheckRerun, type OwedRerunOutcome, type GitHubMergeQueueState, type MergeEnqueueRequest, type MergeQueueAction, type RestoredApproval } from './merge-queue.js';
import { docsSyncCarry } from './model/docs-sync.js';
import { githubFromEnv } from './github.js';
import { recordedMergerMode } from './merger-mode.js';
import { gitRunnerFor, observeHead as observeLocalHead, type GitRunner } from './merge-writer/local-observation.js';
import { allocateChangeNumber } from './merge-writer/change-numbers.js';
import { regressionRefusals } from './regression-guard.js';
import { protectedCasePrefix, protectedCaseRefusals, readProtectingGoals } from './model/goal.js';
import { retroCheckRefusals } from './model/retro-synthesis.js';
import { readAppliedRetroChecks } from './retro-synthesis.js';
import { ciFamilyAllows, ciProofFamilies, ciRunBindingSchema, ciRunRefusal, isCiProducer, refuseCiProducer, staleCiAttemptRefusal, type CiRunObservation } from './model/ci-proofs.js';
import { decideScopeRequest, liveScopeWidening, scopeRefusalBlocker, unplannedPaths, type ScopeDecision, type ScopeRequestState } from './model/scope.js';
import { mergedScopeRequest, plannedFilesCovered, widenedPlannedFiles } from './model/scope-collapse.js';
import { handScopeWideningRefusal, routedScopeAsk } from './model/scope-provenance.js';
import { routedScopeDecisions } from './server/scope-holds.js';
import { configuredDocumentation, documentationObligation, recordDocumentationSubmission, type DocumentationPolicy } from './model/documentation.js';
import { liveDispatchHandleIds, reconcileAutoDispatch, type DispatchTransition } from './model/dispatch.js';
import { submittedBranchMoved } from './model/assignment.js';
import { reconcileReviewConflict, type ReviewConflictTransition } from './model/review-conflict.js';
import { nextAction, nextActionKinds, sameAction } from './model/next-action.js';
import { recordScenarioRun } from './test-runs.js';
import { sameObservationInputs } from './model/observation-save.js';
import type { ObservationJobState } from './model/action-kinds.js';
import { claimCandidatesParams, claimCandidatesSql } from './model/action-candidates.js';
import { recordStallRemedy, remedyFlows, remedyOutcomes, stallRemedyKinds } from './stall-remedies.js';
import { claimAction, openActions, reconcileActions, renewClaim, settleAction, settleDelivered, type ActionRow } from './model/actions.js';
import { livenessFallback, livenessOf, livenessRepairEntry } from './model/liveness.js';
import { agentRequestSchema, boundedAgentRequests, deciderFor, expireAgentRequests, leaseHeldRequestTypes, requestResolutionRefusal, resolveSatisfiedScopeRequests, type AgentRequest } from './model/agent-requests.js';
import { recordSession, sessionHandleSchema, sessionObservationFields } from './model/sessions.js';
import { noSubmissionRenewalRefused, observeHead, workerNoSubmissionRefusalMs } from './model/attempt-bound.js';
import { blockedAttemptMarker, partialWorkSchema, retainedExhaustions, type ExhaustionRecord } from './model/capacity.js';
import { credentialBlockedReason, credentialFailure } from './worker-credential.js';
import { beginAttempt, endAttempt, endLapsedAttempt, pipelineTimeline, recordAssignmentStart, recordIntervention, recordRework, recordSubmission } from './pipeline-speed.js';
import { dispatchFailureBlockAfter } from './daemon/dispatch-failures.js';
import { foldDecisions, type Decision } from './model/approval.js';
import { coveringWindow, directMergeAuthorization, directMergeFromEnv, directMergeWindows, sweepDirectMerges, type DirectMergeWindow } from './direct-merge.js';
import { deliverSplitParent, splitChildRevisionRefusal } from './decomposition.js';
import { defaultRerunFailedChecks, maxRerunFailedChecks } from './master/profiles.js';
import { isSettledSummary, isStandIn, lockedRows, lockedWork, rememberSaved, savedVersions, warmLockedReads, withWhole, workIdByRef, type SavedVersion } from './store/locked-read.js';

/** When a containment fence's authority lapsed, read from the record before it was lowered; null while its lease is live or it records no deadline. */
const fenceLapsedAt = (work: Work | null, now: number) => { const phase = work ? containmentPhase(work, now) : null; return phase && phase.state !== 'live' ? phase.lapsedAt : null; };

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
/**
 * A planned or requested path never begins with '-' (GY-522): such an entry is a command-line flag
 * a client failed to parse, such as `--wait` after the paths of `scope-request`, and recording it
 * would put a flag in plannedFiles, which any decision built from it is then refused for. The
 * refusal names the entry so the asker sees what was mistaken for a path.
 */
export function flagPathRefusal(paths: readonly string[] | undefined, field: string) {
  const flag = paths?.find(path => path.startsWith('-'));
  return flag === undefined ? null : `${field} entry '${flag}' begins with '-': it is a command-line flag, not a repository path`;
}
// Longer than acknowledgeContainment's three 30-second HTTP attempts plus retry delays.
export const launchFenceMs = 120_000;
export const containmentScopeSchema = z.object({ unit: z.string().trim().min(1).max(200), pid: z.number().int().positive() }).strict();
const commands = {
  create: createSchema.extend({ reason: z.string().trim().min(1).max(2000).optional() }),
  ready: z.object({ expectedRevision: z.number().int().positive().optional(), reason: z.string().trim().min(1).max(2000).optional() }).strict(),
  requirements: z.object({ expectedPolicyRevision: z.number().int().positive(), reason: z.string().trim().min(1).max(2000), criteria: z.array(criterionSchema).min(1).max(50), dependencies: z.array(z.string().uuid()).max(50), plannedFiles: createSchema.shape.plannedFiles, exclusiveResources: resourcesSchema, producerProofs: createSchema.shape.producerProofs, split: createSchema.shape.split,
    answers: z.object({ epoch: z.number().int().positive(), at: z.string().datetime(), sha: z.string().regex(/^[0-9a-f]{40}$/).nullable().optional() }).strict().optional(), rule: z.literal('successor').optional() }).strict(),
  reviewpolicy: z.object({ provider: z.enum(reviewProviders), reviewerProfiles: z.array(reviewerProfileSchema).min(1).max(10).optional(), expectedPolicyRevision: z.number().int().positive(), reason: z.string().trim().min(1).max(2000) }).strict(),
  unblock: z.object({ reason: z.string().trim().min(1).max(2000), expectedRevision: z.number().int().positive().optional() }).strict(),
  rework: z.object({ reason: z.string().min(1).max(2000), previousWorkerStopped: z.literal(true) }).strict(),
  // Only a human operator resolves an escalation, and only the one it has read:
  // the trigger names which standing concern is cleared, and the revision binds
  // the request to the incident the operator actually read, so a stale client
  // cannot clear a later incident that happens to share a trigger.
  // A reconcile-raised lease-loss may instead be settled by any admin session that cites the
  // ledger attestation explaining the lapse; the citation is verified against the ledger.
  resolve: z.object({ trigger: z.enum(escalationTriggers), reason: z.string().trim().min(1).max(2000), expectedRevision: z.number().int().positive(),
    attestation: z.object({ kind: z.enum(attestationKinds), epoch: z.number().int().positive() }).strict().optional() }).strict(),
  recover: z.object({ reason: z.string().min(1).max(2000), previousWorkerStopped: z.literal(true) }).strict(),
  claim: z.object({}).strict(),
  rereview: z.object({ epoch: epoch.optional() }).strict(),
  heartbeat: z.object({ epoch }).strict(),
  // The supervisor names the exact systemd scope it launches the session in, and its own pid,
  // so settlement can tell this assignment's containment from a neighbour's.
  quarantine: z.object({ epoch, settlementHash: z.string().regex(/^[a-f0-9]{64}$/), scope: containmentScopeSchema.optional() }).strict(),
  launch: z.object({ epoch, settlementHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  settle: z.object({ epoch, settlementToken: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  // `origin: 'loop'` marks the loop's own settlement of a verified-dead fence, which the intervention
  // report counts only when it came past the settle bound (GY-1392); a hand `master settle-containment` sends none.
  autosettle: z.object({ epoch, settlementHash: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().trim().min(1).max(2000), verification: containmentVerificationSchema, origin: z.literal('loop').optional() }).strict(),
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
  workspace: z.object({ epoch, host: z.string().trim().min(1).max(200), path: z.string().startsWith('/').max(1000).refine(p => !/[\u0000-\u001f]/.test(p), 'Invalid path').transform(workspacePath), branch: z.string().max(200).refine(validBranch, 'Invalid Graphyard branch name'),
    preserved: z.object({ path: z.string().min(1).max(1000), head: z.string().regex(/^[0-9a-f]{40}$/i), branchTip: z.string().regex(/^[0-9a-f]{40}$/i), op: z.enum(['rebase', 'merge', 'cherry-pick']).nullable(), refs: z.string().max(20000), diff: z.string().max(100000), at: z.iso.datetime() }).strict().optional() }).strict(),
  // `documentation` is the worker's explicit statement that the change alters no documented
  // behaviour: the other way the standard documentation criterion is met (model/documentation.ts).
  // GY-1523: exactly one of `pr` (GitHub is the merge writer) or `head` (the control plane is); the
  // transaction reads the recorded merger and refuses the other.
  submit: z.object({ epoch, pr: z.number().int().positive().optional(), head: sha.optional(), documentation: z.string().trim().min(1).max(1000).optional() }).strict()
    .superRefine((data, ctx) => { if ((data.pr === undefined) === (data.head === undefined)) ctx.addIssue({ code: 'custom', message: 'A submission names exactly one of pr (a pull request number) or head (a 40-hex commit)' }); }),
  // `partialWork` is how the worker's CLI kept what the attempt had not committed before the
  // blocker ended it (GY-1008): the same record an interrupted attempt carries.
  blocked: z.object({ epoch, reason: z.string().max(2000).nullable(), partialWork: partialWorkSchema.optional() }).strict(),
  // An empty request clears this attempt's open one; otherwise it must ask for something the
  // planned scope does not already carry. `paths` widens, and the two fields the loop never
  // decides are stated as plainly as the widening is: `remove` drops planned containment and
  // `criteria` rewrites requirements, so a request carrying either is refused with that reason
  // rather than being impossible to say (see model/scope.ts).
  scope: z.object({ epoch, paths: z.array(z.string().min(1).max(500)).max(50), reason: z.string().trim().min(1).max(2000),
    remove: z.array(z.string().min(1).max(500)).max(50).optional(), criteria: z.array(criterionSchema).max(50).optional() }).strict(),
  // The master loop asking the control plane to decide the open scope request now. It carries no
  // verdict: the decision is recomputed here from the item's own criteria and the repository's
  // documentation rule, exactly as `autosettle` recomputes containment death.
  autoscope: z.object({ epoch }).strict(),
  // The master loop recording that dispatching the item keeps failing for one unchanged cause
  // (GY-1078): the cause becomes the item's blocker, so nothing dispatches it again until an
  // operator clears it. It needs no lease — no attempt is running — and is refused while one is.
  dispatchblock: z.object({ reason: z.string().trim().min(1).max(2000) }).strict(),
  // `scopeFiles` is the producer's declaration of what the proof depends on, in the planned-files
  // scope syntax; a base refresh carries a proof across its own authored merge only inside it.
  evidence: z.object({ proof: proofSchema, sha, baseSha: sha, policyRevision: z.number().int().positive(), result: z.enum(['pass', 'fail']), executed: z.number().int().min(0), skipped: z.number().int().min(0), url: publicArtifactUrl.optional(), artifacts: z.array(evidenceArtifact).max(30).optional(), scenarioRevision: z.number().int().positive().optional(), environment: z.string().min(1).max(100).optional(),
    scopeFiles: z.array(z.string().min(1).max(500)).min(1).max(100).optional(), provenance: z.object({
    provider: z.literal('github-actions'), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), workflowCommit: sha,
    runId: z.string().regex(/^[1-9]\d*$/), runAttempt: z.number().int().positive(),
    artifact: z.object({ id: z.number().int().positive(), name: z.string().min(1).max(200), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), url: publicArtifactUrl, createdAt: z.iso.datetime() }).strict(),
  }).strict().optional(),
    // The CI producer names the workflow job that ran the contract; the control plane reads that
    // job back from GitHub and accepts the record only when it completed on this commit.
    ciRun: ciRunBindingSchema.optional(),
    // GY-135: the same proof run against a tree with its criterion's behaviour removed.
    exercise: proofExerciseSchema.optional() }).strict(),
  // The coordinator's observation of the running release covering a delivered merge. It names the
  // serving commit and where it was read; whether it is exact is derived, never asserted.
  deployment: z.object({ sha, mergeSha: sha, source: z.enum(['endpoint', 'github-deployment']), observedAt: z.iso.datetime() }).strict(),
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
  refresh: z.object({ reason: z.string().trim().min(1).max(2000), base: sha }).strict(),
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
export const executorPresenceSchema = actionClaimSchema.pick({ executor: true, host: true, kinds: true, serves: true }).strict();
const actionSettleSchema = z.object({ executor: executorName.optional(), result: z.enum(['done', 'failed']), reason: z.string().trim().min(1).max(2000) }).strict();
// A renewal carries no result: it says only that the executor named on the claim is still
// inside the handler, and asks for the lease it already holds to run on.
// A remedy record names the remedy, the unchanged reason it was applied for and what it did (GY-949).
const actionRemedySchema = z.object({
  remedy: z.enum(stallRemedyKinds), reason: z.string().trim().min(1).max(2000), outcome: z.enum(remedyOutcomes),
  detail: z.string().trim().min(1).max(2000), flows: z.array(z.enum(remedyFlows)).min(1).max(3),
}).strict();
const actionRenewSchema = z.object({ executor: executorName.optional(), leaseSeconds: z.number().int().min(10).max(900).optional() }).strict();
// A resync names the instant its claim was made, so the answer says whether an observation saved
// since then satisfies it; `wake: false` only reads, for an executor waiting on the job it woke.
const resyncSchema = z.object({ since: z.string().datetime({ offset: true }).optional(), wake: z.boolean().optional(), prioritized: z.boolean().optional(), wait: z.boolean().optional() }).strict();
const pullAssignmentSchema = z.object({ host: executorName.optional(), work: z.string().min(1).max(200).optional() }).strict();
/** The refusal a replay of one idempotency key with different input earns; read back by the pull. */
export const idempotencyMismatch = 'Idempotency key reused with different input';
export type Command = keyof typeof commands;
const operatorCapabilitiesByCommand: Partial<Record<Command, OperatorCapability>> = { create: 'intent:create', ready: 'intent:ready', unblock: 'intent:unblock', refresh: 'intent:unblock', requirements: 'policy:requirements', reviewpolicy: 'policy:review-provider' };

function authorizeOperatorCommand(actor: Principal, command: Command, data: any, work: Work | undefined, repository: string) {
  const capability = operatorCapabilitiesByCommand[command];
  demand(capability, 'This operation is not available to operator agents', 403);
  operatorCapability(actor, capability, work, repository);
  demand(data.reason, 'Operator-agent mutations require a reason', 400);
  if (command === 'create') {
    demand(actor.scope?.workItems.includes('*'), 'Creating work requires wildcard work scope', 403);
    demand(data.policy.review, 'Operator-created work must require independent review');
    if (data.policy.reviewProvider !== undefined) operatorCapability(actor, 'policy:review-provider', undefined, repository);
  }
}

// Old deployments did not persist assignment labels. Preserve the known owner/epoch
// before clearing a legacy lease; its original claim time is unknown.
function preserveAssignment(work: Work) {
  if (work.lease && (!work.lastAssignment || work.lastAssignment.epoch < work.lease.epoch))
    work.lastAssignment = { owner: work.lease.owner, epoch: work.lease.epoch };
}

// A quarantine outlives the lease that raised it: reconciliation clears an expired lease,
// and release, rework and changed requirements clear a live one. The deadline automatic
// settlement measures its grace window from is therefore retained on the quarantine, which
// only proof removes. It only ever moves forward, and only for the quarantined epoch.
function retainQuarantineFence(work: Work) {
  const quarantine = work.containmentQuarantine;
  if (!quarantine || !work.lease || work.lease.epoch !== quarantine.epoch) return;
  const retained = quarantine.leaseExpiresAt ? Date.parse(quarantine.leaseExpiresAt) : -Infinity;
  const live = Date.parse(work.lease.expiresAt);
  if (Number.isFinite(live) && !(live <= retained)) quarantine.leaseExpiresAt = work.lease.expiresAt;
}
// The attestations that explain a lease's end live in the append-only events ledger, written by
// the very commands that caused it: the worker's `blocked` report and the admin's
// `--previous-worker-stopped` rework or recovery. They are read back from there, never from a
// client, so the classification rests on what was recorded when it happened.
export async function readAttestations(db: { query: (text: string, values: unknown[]) => Promise<{ rows: any[] }> }, workId: string): Promise<Attestation[]> {
  const rows = (await db.query(`SELECT seq, actor, kind, payload->'details' AS details, ${eventWorkSql()}->'epoch' AS work_epoch, created_at FROM events WHERE work_id=$1 AND kind IN ('blocked','rework','recover') ORDER BY seq`, [workId])).rows;
  return attestationsFromLedger(rows.map(row => ({ seq: Number(row.seq), actor: row.actor, kind: row.kind, at: new Date(row.created_at).toISOString(), details: row.details ?? undefined, workEpoch: row.work_epoch ?? undefined })));
}
/**
 * Apply this repository's scope rule to an open request and record what it decided (GY-85).
 *
 * The verdict is recomputed from the item's own criteria and the documentation rule, never taken
 * from a caller, so it grants no authority to whoever asked. An approved widening is applied to
 * the item exactly as an operator widening would be; a refusal becomes the item's blocker, so the
 * ready gate holds it until somebody decides the scope the item does not already carry.
 */
/**
 * A scope request belongs to the attempt that filed it (GY-597). Once that attempt has ended —
 * submitted, released, lapsed, reworked or revised away — nobody is left to act on its answer,
 * and a refusal it earned would hold every later attempt at the ready gate. Closing it lifts the
 * refusal it wrote as the item's blocker, so the next attempt is dispatched and asks afresh if it
 * still needs the files. Returns what the history records of the closed request, or null when
 * there was none to close or its attempt still holds the lease.
 */
export const scopeRequestEndedReason = 'attempt ended';
export function closeEndedScopeRequest(work: Work, now: Date, by: string) {
  const request = work.scopeRequest;
  // An operator's unblock also closes an ask an earlier ended attempt carried (GY-1484): the next claim inherits nothing.
  const dropped = by === 'unblock' ? work.carriedScopeRequest ?? null : null;
  if (dropped) work.carriedScopeRequest = null;
  if (!request || work.lease?.epoch === request.epoch) return dropped && endedScopeRecord(dropped, by, now);
  work.scopeRequest = null;
  // A blocker the worker has just reported is its own, whatever its words: only a refusal left standing is cleared.
  if (by !== 'blocked' && work.blocker?.startsWith(scopeRefusalBlocker)) work.blocker = null;
  // GY-1484: an ask still with the independent approver is carried to the item, not dropped: the next attempt inherits it.
  // An operator's unblock closes it on purpose, so nothing is carried then.
  const carried = by === 'unblock' ? null : carriedScopeRequest(work, request);
  if (carried) work.carriedScopeRequest = carried;
  return { ...endedScopeRecord(request, by, now), ...(carried ? { carried: true } : {}) };
}
const endedScopeRecord = (request: ScopeRequestState, by: string, now: Date) => ({ epoch: request.epoch, paths: request.paths, requestedBy: request.requestedBy, requestedAt: request.at,
  decision: request.decision?.state ?? null, refusal: request.decision?.state === 'refused' ? request.decision.reason : null, reason: scopeRequestEndedReason, by, at: now.toISOString() });
/**
 * The ask an ended attempt leaves pending with the independent approver (GY-1484): a purely additive
 * request the widening rule refused, so the loop put it (or is putting it) to the approver, whose
 * judgement routinely lands after the attempt that asked has ended. Carried to the item, it is the
 * next attempt's own open request, and an approval applied meanwhile records its decision against
 * it. A request no decider has seen yet (the next attempt asks afresh, GY-597), one a person or the
 * approver refused, or one that drops paths or rewrites criteria is closed as before; so is one
 * plannedFiles already cover.
 */
export function carriedScopeRequest(work: Pick<Work, 'plannedFiles'>, request: ScopeRequestState): ScopeRequestState | null {
  if (request.decision?.state !== 'refused' || request.decision.decidedBy !== 'graphyard' || request.remove?.length || request.criteria?.length) return null;
  const paths = unplannedPaths(work.plannedFiles, request.paths);
  return paths.length ? { ...request, paths } : null;
}
/** Whether an approved requirements decision's recorded request is exactly the late widening applied under its key (GY-1484). */
export function sameApprovedWidening(approval: { requester: string; input: Record<string, any> | null }, actor: string, data: { plannedFiles?: readonly string[]; answers?: { epoch: number; at: string; sha?: string | null } }): boolean {
  const input = approval.input, asked = input?.answers, answers = data.answers;
  if (approval.requester !== actor || !asked || !answers || !Array.isArray(input?.plannedFiles) || !data.plannedFiles) return false;
  const files = (list: readonly string[]) => JSON.stringify([...new Set(list)].sort());
  return asked.epoch === answers.epoch && Date.parse(asked.at) === Date.parse(answers.at) && JSON.stringify(asked.sha) === JSON.stringify(answers.sha) && files(input.plannedFiles) === files(data.plannedFiles);
}
/** The carried ask a fresh attempt inherits as its own open request, or null (GY-1484). */
export function inheritedScopeRequest(work: Pick<Work, 'plannedFiles' | 'carriedScopeRequest'>, epoch: number): ScopeRequestState | null {
  const carried = work.carriedScopeRequest;
  if (!carried) return null;
  const paths = unplannedPaths(work.plannedFiles, carried.paths);
  return paths.length ? { ...carried, paths, epoch, decision: carried.decision ? { ...carried.decision, epoch } : carried.decision } : null;
}
/** The commands that end an attempt, or clear what an ended one left behind, and so close its scope request. */
// A blocker ends its attempt (GY-1008); a cleared one (`blocked GY-N EPOCH -`) keeps the lease, so its request stays open.
const attemptEndingCommands = new Set<string>(['submit', 'release', 'rework', 'requirements', 'unblock', 'blocked']);
export function applyScopeDecision(work: Work, request: NonNullable<Work['scopeRequest']>, now: Date): ScopeDecision {
  const verdict = decideScopeRequest(work, request);
  const decision: ScopeDecision = { state: verdict.state, reason: verdict.reason, at: now.toISOString(), decidedBy: 'graphyard',
    waitedMs: Math.max(0, now.getTime() - Date.parse(request.at)), paths: verdict.paths, requestedBy: request.requestedBy, requestedAt: request.at, epoch: request.epoch };
  work.scopeDecision = decision;
  // An applied request is answered and cleared, exactly as an operator widening clears it;
  // a refused one stays open, carrying its refusal, because someone still has to decide it.
  work.scopeRequest = verdict.state === 'approved' ? null : { ...request, decision };
  // The timing baseline granted as a companion stays outside plannedFiles: only its own test files' lines pass (GY-1023).
  const widening = verdict.paths.filter(path => !verdict.companions?.includes(path));
  if (verdict.state === 'approved') {
    // Non-weakening intent the item already carried: applied to the live attempt, which
    // keeps its lease and its containment fence exactly as an operator widening would. A wide
    // ask is folded into directory entries, as a routed one is, rather than overrun the cap;
    // an ask no fold represents was refused by the rule above, never applied past the cap.
    if (widening.length) {
      work.plannedFiles = widenedPlannedFiles(work, widening).plannedFiles;
      work.policyRevision++;
      work.formalReviewResetRequired = true; work.formalReviewBaseline = undefined;
      work.observation = null; work.mergeAuthorization = null; work.reviewRequest = null;
    }
    if (work.blocker?.startsWith(scopeRefusalBlocker)) work.blocker = null;
  } else {
    // Refused and escalated: the reason is the item's blocker, so the ready gate holds it
    // until an operator decides the scope the item does not already imply.
    work.blocker = `${scopeRefusalBlocker}: ${verdict.reason}`;
    recordIntervention(work, 'blocked');
  }
  return decision;
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
 * The refresh record a stale mergeability reading (GY-375) leaves for its head: the reading over
 * whatever the record for that same head carried onto it. `conflictSince` and `conflictPaths` are
 * kept only beside a conflict (GY-1230), so what an earlier conflict on the head recorded never
 * survives on a record whose conflict the stale reading cleared.
 */
export function staleRefreshRecord(previous: BaseRefresh | null | undefined, refresh: BaseRefresh): BaseRefresh {
  const kept = previous?.head === refresh.from.sha ? previous : null;
  const record: BaseRefresh = { ...(kept ?? {}), ...refresh, merge: kept?.merge ?? null, carry: kept?.carry ?? null, ...(kept?.restoredApproval ? { restoredApproval: kept.restoredApproval } : {}) };
  if (!record.conflict) { delete record.conflictSince; delete record.conflictPaths; }
  return record;
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
 * rather than the submitted work — its next action, gates and the lane they stamp, the sessions it
 * reports, and the escalations it raises for attention. None of it is what a GitHub observation
 * reads, and the observation's own save re-evaluates the gates, so it never stands on a stale one.
 */
export function sameBesideBookkeeping(read: Work, current: Work): boolean {
  const rest = ({ actionQueue: _queue, revision: _revision, updatedAt: _updated, nextAction: _next, gates: _gates, lane: _lane, speedTarget: _target,
    sessions: _sessions, escalation: _escalation, escalations: _escalations, ...others }: Work) => stableJson(others);
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
 * How many saves a requested decision's revision may fall behind and still have its grounds
 * re-checked (GY-1463): a worker renews its lease about every 12 s, so this covers an approver's
 * judgement of over three hours on a leased item.
 */
export const decisionGroundsLookback = 1000;
/**
 * What moved a requested decision's grounds between the item as it was requested (`read`) and as
 * it stands, named, or null when nothing that could affect them did (GY-1463). The loop's
 * bookkeeping (`sameBesideBookkeeping`), a lease renewal (the lease's expiry and the quarantine's
 * copy of it), the liveness of the launch, a GitHub observation and the sessions and workspaces
 * an attempt records cannot; a new submission or head, a stage move, a requirements or policy
 * revision, a lease epoch change or any other change to the item can. A resolve judged without a
 * pin rests on the escalation it names, so for it (`escalations`) a change to the standing
 * escalations moves its grounds too.
 */
export function decisionGroundsChange(read: Work, current: Work, options: { escalations?: boolean } = {}): string | null {
  const lease = (work: Work) => work.lease ? { owner: work.lease.owner, epoch: work.lease.epoch } : null;
  const quarantine = (work: Work) => {
    if (!work.containmentQuarantine) return null;
    const { leaseExpiresAt: _lease, launchExpiresAt: _launch, launchAcknowledgedAt: _acknowledged, ...fence } = work.containmentQuarantine;
    return fence;
  };
  const changed = (pick: (work: Work) => unknown) => stableJson(pick(read) ?? null) !== stableJson(pick(current) ?? null);
  if (changed(work => work.submission)) return `a new submission (${current.submission ? `pull request #${current.submission.pr}, epoch ${current.submission.epoch}` : 'withdrawn'})`;
  if (changed(work => work.candidate?.sha)) return `a new head (${current.candidate?.sha.slice(0, 12) ?? 'none'})`;
  if (changed(work => [work.stage, work.ready])) return `a stage move (${read.stage} to ${current.stage}${current.ready === read.ready ? '' : current.ready ? ', released' : ', unreleased'})`;
  if (changed(work => [work.policyRevision, work.policy, work.criteria, work.plannedFiles]))
    return `a requirements or policy revision (policy revision ${read.policyRevision} to ${current.policyRevision})`;
  if (options.escalations && changed(work => [work.escalation, work.escalations])) return 'a change to its escalations';
  if (changed(work => [work.epoch, lease(work)])) return `a lease epoch change (${lease(read) ? `epoch ${read.lease!.epoch}` : 'no lease'} to ${lease(current) ? `epoch ${current.lease!.epoch}` : 'no lease'})`;
  const rest = (work: Work) => {
    const { actionQueue: _queue, revision: _revision, updatedAt: _updated, nextAction: _next, gates: _gates, lane: _lane, speedTarget: _target, sessions: _sessions,
      escalation: _escalation, escalations: _escalations, lease: _lease, lastAssignment: _assignment, containmentQuarantine: _quarantine, observation: _observation,
      workspaces: _workspaces, ...others } = work as Work & Record<string, unknown>;
    return { ...others, containmentQuarantine: quarantine(work) } as Record<string, unknown>;
  };
  const before = rest(read), after = rest(current);
  const field = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().find(key => stableJson(before[key] ?? null) !== stableJson(after[key] ?? null));
  return field ? `a change to its ${field}` : null;
}
/**
 * What moved a decision's grounds since `revision`, read from the ledger (`decisionGroundsChange`),
 * or null when nothing that could affect them did. A revision past the lookback cannot be re-checked.
 */
export async function decisionGroundsMovedSince(db: { query: (text: string, values: unknown[]) => Promise<{ rows: any[] }> }, work: Work, revision: number, options: { escalations?: boolean } = {}): Promise<string | null> {
  if (revision === work.revision) return null;
  const read = await revisionAt(db, work, revision, decisionGroundsLookback);
  return read ? decisionGroundsChange(read, work, options) : `more saves than its grounds can be re-checked across (revision ${revision}, now ${work.revision})`;
}

/**
 * The decision as its approval judges and applies it (GY-1296, GY-1463): a release, an unblock, a
 * diagnostician's closure or a resolve without a pin is bound to the item revision it was requested
 * at. When the revision moved only in changes that cannot affect its grounds — the loop's
 * bookkeeping, lease renewals, liveness, observations, session records — it is rebased to the
 * current revision; when another decision was applied since, or anything else moved
 * (`decisionGroundsChange`), `change` names it and the decision is returned as it is. A resumption
 * applies the same (GY-1300).
 */
export async function revisionRebase<D extends Pick<Decision, 'id' | 'action' | 'input'> & { pin: unknown }>(db: { query: (text: string, values: unknown[]) => Promise<{ rows: any[] }> }, decision: D, work: Work): Promise<{ judged: D; change: string | null }> {
  const revisionPinned = decision.action === 'release' || decision.action === 'unblock' || (decision.action === 'resolve' && !decision.pin)
    || (decision.action === 'close' && decision.input.triageAt === undefined && decision.input.expectedRevision !== undefined);
  if (!revisionPinned || decision.input.expectedRevision === work.revision) return { judged: decision, change: null };
  const change = await decisionAppliedSince(db, work, decision.id) ?? await decisionGroundsMovedSince(db, work, decision.input.expectedRevision, { escalations: decision.action === 'resolve' });
  return change ? { judged: decision, change } : { judged: { ...decision, input: { ...decision.input, expectedRevision: work.revision } }, change: null };
}
/** Another decision on the item applied after this one was requested, named, or null. */
async function decisionAppliedSince(db: { query: (text: string, values: unknown[]) => Promise<{ rows: any[] }> }, work: Work, id: string): Promise<string | null> {
  const row = (await db.query(`SELECT applied.payload->>'id' AS id, requested.payload->>'action' AS action FROM events applied
    JOIN events requested ON requested.work_id=applied.work_id AND requested.kind='decision.requested' AND requested.payload->>'id'=applied.payload->>'id'
    WHERE applied.work_id=$1 AND applied.kind='decision.applied' AND applied.payload->>'id'<>$2
      AND applied.seq > (SELECT seq FROM events WHERE work_id=$1 AND kind='decision.requested' AND payload->>'id'=$2 ORDER BY seq LIMIT 1)
    ORDER BY applied.seq LIMIT 1`, [work.id, id])).rows[0];
  return row ? `another applied decision (${row.action} ${row.id})` : null;
}

/**
 * How a delivery that recovered from that violation was judged (GY-92): the two-party merge
 * decision it rests on, the cutoff the history was re-checked at, and the judgement itself.
 * Recorded on the delivery beside the snapshot revision and evidence instant it cites.
 */
export interface MergeReconciliation {
  decision: string; requestedBy: string; requestedAt: string; approvedBy: string; approvedAt: string; reason: string; approvalReason: string;
  cutoff: string; snapshotRevision: number; judgement: string; proofs: string[]; violation: string;
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
  const githubAnswers = (reason: string) => reason === mergeabilityComputingRefusal || reason === 'Pull request is not mergeable against the current base';
  for (const gate of past.gates) {
    const reasons = gate.name === 'merge' ? gate.reasons.filter(reason => !githubAnswers(reason)) : gate.reasons;
    if (!gate.passed && reasons.length) refusals.push(`gate ${gate.name} had not passed: ${reasons.join('; ')}`);
  }
  for (const violation of past.violations.filter(violation => !circular(violation))) refusals.push(`violation stood: ${violation}`);
  return refusals;
}
/**
 * How a delivery an operator authorized outside the guarded path was recorded (GY-94). No merge
 * execution authorized the merge and the record at the cutoff did not either — `unmet` is what it
 * lacked — so an admin credential on one side of a post-merge two-party merge decision took
 * responsibility, citing the refused reconciliation it overrides. Distinct from a reconciliation,
 * which delivers only when the record at the cutoff satisfied every gate on its own.
 */
export interface OperatorAuthorizedDelivery {
  decision: string; requestedBy: string; requestedAt: string; approvedBy: string; approvedAt: string; reason: string; approvalReason: string;
  /** The admin credential that authorized the merge, and the refused reconciliation its decision cites. */
  operator: string; refusedDecision: string; unmet: string[];
  cutoff: string; snapshotRevision: number; judgement: string; violation: string;
  /** Always null: the statement that no merge execution authorized this merge. */
  execution: null;
}
/** A post-merge merge decision with the roles its two parties held, read from the ledger. */
interface PostMergeDecision extends Decision { requesterRole: string | null; approverRole: string | null }
/**
 * The two-party merge decisions that judge an observed, unauthorized merge: applied — so
 * requested by one agent identity and approved by an independent one — for exactly the observed
 * candidate at the policy revision the pre-cutoff record carried, and requested after the merge
 * cutoff, so each is a judgement of the merge that happened rather than a pre-merge approval.
 * Oldest first; the caller judges the latest one the record has not already answered.
 */
async function postMergeDecisions(db: { query: (text: string, values: unknown[]) => Promise<{ rows: any[] }> }, work: Work, observation: Observation, policyRevision: number, cutoff: number): Promise<PostMergeDecision[]> {
  const rows = (await db.query("SELECT actor, kind, payload, created_at FROM events WHERE work_id=$1 AND kind IN ('decision.requested','decision.approved','decision.applied','decision.failed') ORDER BY seq", [work.id])).rows;
  const decisions = foldDecisions(work.id, rows.map(row => ({ kind: row.kind as string, actor: row.actor as string, at: new Date(row.created_at).toISOString(), payload: row.payload })));
  const role = (kind: string, id: string, party: 'requester' | 'approver') => rows.find(row => row.kind === kind && row.payload?.id === id)?.payload?.[party]?.role ?? null;
  return decisions.filter(decision => decision.action === 'merge' && decision.state === 'applied' && !!decision.approvedBy && decision.approvedBy !== decision.requestedBy
    && decision.input?.sha === observation.candidate.sha && decision.input?.baseSha === observation.candidate.baseSha && decision.input?.policyRevision === policyRevision
    && Date.parse(decision.requestedAt) >= cutoff)
    .map(decision => ({ ...decision, requesterRole: role('decision.requested', decision.id, 'requester'), approverRole: role('decision.approved', decision.id, 'approver') }));
}
/**
 * The operator authorizing a merge outside the guarded path, or the reason the decision is not
 * that: an operator-authorized delivery needs an admin credential — the operator, not the
 * master's agent pair — on one side of the decision, and a reason that cites a refused
 * reconciliation of this merge, so the override names exactly what the record lacked.
 */
function operatorAuthorizing(decision: PostMergeDecision, refused: Set<string>): { operator: string; refusedDecision: string } | { refusal: string | null } {
  const cited = [...refused].find(id => decision.reason.includes(id));
  if (!cited) return { refusal: null };
  const operator = decision.requesterRole === 'admin' ? decision.requestedBy : decision.approverRole === 'admin' ? decision.approvedBy! : null;
  return operator ? { operator, refusedDecision: cited }
    : { refusal: `an operator-authorized delivery needs an admin credential as requester or approver; ${decision.requestedBy} is ${decision.requesterRole ?? 'of unrecorded role'} and ${decision.approvedBy} is ${decision.approverRole ?? 'of unrecorded role'}` };
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
 */
export interface ReconcileTick { at: string; candidates: number; evaluated: number; deferred: number; maxAttempts: number; ms: number; writes: number; lockWaitMs: number }

/** One item in the reconciliation view kept between passes (GY-1124). */
interface ReconcileEntry { number: number; work: Work; version: string; settled: boolean; face: string }
/** A write a reconciliation batch planned (GY-1290): its evaluation of the item, on a copy, at the row version and the clock it read. */
interface ReconcilePlan { id: string; work: Work; version: string; now: Date }
/** One planned write, committed: whether it wrote, whether later planned items must be evaluated again, and what to keep of it once committed. */
interface ReconcileWritten { wrote: boolean; stale: boolean; faceMoved: boolean; saved: SavedVersion[]; apply: () => void }
/** The running pass's kept view and its readers, as one planned write needs them. */
interface ReconcilePass {
  fleet: Map<string, ReconcileEntry>; all: () => Work[]; view: () => void; lockWait: (ms: number) => void;
  versionsOf: (db: PoolClient) => Promise<Map<string, string>>; moved: (versions: Map<string, string>) => string[]; reread: (db: PoolClient, ids: string[]) => Promise<boolean>;
}
/**
 * What other items' evaluations can read of an item (GY-1124): its document without the fields a
 * renewal moves — the revision, the update time, the lease's expiry, and an action claim's expiry
 * and renewal count (GY-1276), and the assignment's session start the first renewal stamps
 * (GY-1499). A heartbeat or an executor's claim renewal leaves the face unchanged, so the pass
 * after it evaluates only the renewed item; any other write changes it, and
 * the pass evaluates every live item against it. A claim expiring is a move of the clock alone,
 * which the bounded full evaluation (`reconcileFullEvaluationMs`) catches up.
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
/** The longest reconciliation goes between full evaluations: `GRAPHYARD_RECONCILE_FULL_MS`, 2000..300000 ms, default 10000 (GY-1124). */
export function configuredReconcileFullMs(value = process.env.GRAPHYARD_RECONCILE_FULL_MS, fallback = 10_000): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 2_000 && parsed <= 300_000 ? parsed : fallback;
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
  /** The base branch a submitted head is observed against (GY-1523): the deployment's GITHUB_BASE_BRANCH, else `main`. */
  baseBranch = process.env.GITHUB_BASE_BRANCH ?? 'main';
  /** Whether this process has warmed the locked read's stand-in cache (`warmLockedReads`). */
  private lockedReadsWarm = false;
  // Auto-dispatch transitions the last evaluation of a document produced, written to the ledger
  // by the transaction that persists it. Keyed by the object, so a probe clone records nothing.
  private dispatchTransitions = new WeakMap<Work, DispatchTransition[]>();
  private conflictTransitions = new WeakMap<Work, ReviewConflictTransition[]>();
  /** This repository's documentation policy (GY-215): the deployed GRAPHYARD_DOCUMENTATION, or the default. */
  documentation: DocumentationPolicy = configuredDocumentation();
  /**
   * How many times a required check that failed on a candidate sha is rerun before the failure
   * counts (GY-516): `mergeQueue.rerunFailedChecks` as the master publishes it, else the product
   * default (src/master/profiles.ts); 0 disables.
   */
  rerunFailedChecks = defaultRerunFailedChecks;
  /** `mergeQueue.rerunFailedChecks` as the master last published it (POST /api/merge-queue), read back from the installation ledger, else the default. */
  async loadRerunFailedChecks() {
    const row = (await this.store.pool.query('SELECT (payload->>\'rerunFailedChecks\')::int AS reruns FROM events WHERE work_id IS NULL AND kind=$1 ORDER BY seq DESC LIMIT 1', [rerunFailedChecksEvent])).rows[0];
    this.rerunFailedChecks = Number.isSafeInteger(row?.reruns) && row.reruns >= 0 && row.reruns <= maxRerunFailedChecks ? row.reruns : defaultRerunFailedChecks;
    return this.rerunFailedChecks;
  }
  /**
   * Records the outcome of asking GitHub to rerun an owed check (GY-516), made by the integration
   * job outside any transaction: `requested` holds the failure until the rerun concludes,
   * `refused` lets it stand, and the item is re-evaluated at once either way. `waiting` (GY-1329)
   * keeps the rerun owed while its workflow run is unfinished; an unchanged wait adds no ledger entry.
   */
  async recordCheckRerun(id: string, jobToken: string, owed: Pick<CheckRerun, 'sha' | 'check' | 'failedRunId'>, outcome: OwedRerunOutcome) {
    return this.store.transaction(async (db, now) => {
      const job = (await db.query('SELECT 1 FROM jobs WHERE work_id=$1 AND token=$2 AND locked_until>$3', [id, jobToken, now])).rows[0];
      requireCurrent(job, 'Integration job lease expired or superseded');
      const all = await lockedWork(db, [id]);
      const work = all.find(w => w.id === id);
      demand(work, 'Work item not found', 404);
      const index = (work.checkReruns ?? []).findIndex(entry => entry.sha === owed.sha && entry.check === owed.check && entry.failedRunId === owed.failedRunId);
      if (index < 0 || work.checkReruns![index].state !== 'owed') return work;
      const current = work.checkReruns![index], rerun = owedRerunAfter(current, outcome, now.toISOString());
      work.checkReruns = work.checkReruns!.map((entry, at) => at === index ? rerun : entry).slice(-checkRerunLimit);
      if (outcome.state === 'waiting' && current.waiting?.status === outcome.status) { await rewriteDocument(db, work); return work; }
      this.evaluate(work, all, now);
      await this.recordDispatch(db, work, now);
      await save(db, work, 'github', `check.rerun.${outcome.state}`, now, rerun);
      return work;
    });
  }
  /**
   * Records what GitHub said of an accepted rerun's workflow run once no new check run appeared
   * within the visibility bound (GY-1096), read by the integration job outside any transaction:
   * `waiting` (queued or running) keeps holding the failure and names the runner-queue wait,
   * `failed` is the rerun concluding failing, `rerequested` is the one further request made for a
   * rerun not found at all, and `refused` or `expired` let the failure stand. `recancelled` is a
   * rerun asked again after GitHub cancelled its attempt (GY-1109), spending the cancelled allowance
   * named in `detail`; it is written like every other outcome, under the item's lock and over the
   * revision it read, so a heartbeat that committed meanwhile is never overwritten (GY-1124).
   */
  async recordCheckRerunProbe(id: string, jobToken: string, rerun: Pick<CheckRerun, 'sha' | 'check' | 'failedRunId'>, outcome:
    { kind: 'waiting'; status: string } | { kind: 'failed'; conclusion: string } | { kind: 'rerequested'; runId: number; attempt?: number } | { kind: 'recancelled'; runId: number; attempt?: number; detail: string } | { kind: 'refused' | 'expired'; detail: string }) {
    return this.store.transaction(async (db, now) => {
      const job = (await db.query('SELECT 1 FROM jobs WHERE work_id=$1 AND token=$2 AND locked_until>$3', [id, jobToken, now])).rows[0];
      requireCurrent(job, 'Integration job lease expired or superseded');
      const all = await lockedWork(db, [id]);
      const work = all.find(w => w.id === id);
      demand(work, 'Work item not found', 404);
      const index = (work.checkReruns ?? []).findIndex(entry => entry.sha === rerun.sha && entry.check === rerun.check && entry.failedRunId === rerun.failedRunId);
      if (index < 0 || work.checkReruns![index].state !== 'requested') return work;
      const at = now.toISOString(), current = work.checkReruns![index];
      const next: CheckRerun = outcome.kind === 'waiting' ? { ...current, probedAt: at, waiting: current.waiting?.status === outcome.status ? current.waiting : { status: outcome.status, at } }
        : outcome.kind === 'failed' ? { ...current, state: 'failed', probedAt: at, detail: `its workflow run concluded ${outcome.conclusion}`, resolvedAt: at }
        : outcome.kind === 'rerequested' ? { ...current, runId: outcome.runId, ...(outcome.attempt !== undefined ? { attempt: outcome.attempt } : {}), probedAt: at, rerequestedAt: at, waiting: undefined }
        : outcome.kind === 'recancelled' ? { ...current, runId: outcome.runId, ...(outcome.attempt !== undefined ? { attempt: outcome.attempt } : {}), detail: outcome.detail, probedAt: at, waiting: undefined }
        : { ...current, state: outcome.kind, probedAt: at, detail: outcome.detail, resolvedAt: at };
      work.checkReruns = work.checkReruns!.map((entry, position) => position === index ? next : entry).slice(-checkRerunLimit);
      // A wait whose status is unchanged is not a new fact: it refreshes the probe without a ledger entry.
      // Written in place under the item's lock, so a concurrent renewal of the item is never lost (GY-1124).
      if (outcome.kind === 'waiting' && current.waiting?.status === outcome.status) {
        await rewriteDocument(db, work);
        return work;
      }
      this.evaluate(work, all, now);
      await this.recordDispatch(db, work, now);
      await save(db, work, 'github', `check.rerun.${outcome.kind === 'recancelled' ? 'requested' : outcome.kind}`, now, next);
      return work;
    }, { itemLock: id });
  }
  // The launch fence is a deployment-independent safety default; only tests shorten it.
  constructor(public store: Store, public ciAppIds: number[] = [15368], public leaseSeconds = 120, public repository = process.env.GITHUB_REPOSITORY ?? '', public launchFence = launchFenceMs) {}
  private async observeSubmission(actor: Principal, id: string | null, data: { epoch: number; pr?: number; head?: string }, key: string): Promise<Observation | null> {
    if (data.head !== undefined) return this.observeSubmittedHead(actor, id, { epoch: data.epoch, head: data.head }, key);
    if (this.submissionObserver === undefined) { const github = await githubFromEnv(); this.submissionObserver = github ? (probe, peers) => github.observe(probe, peers) : null; }
    if (!this.submissionObserver || !id) return null;
    // A replayed submission returns its receipt; it must not depend on the provider again.
    // `complete` is a lease command (GY-558): its reads take the lease pool, like its transaction.
    if ((await this.store.leasePool.query('SELECT 1 FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rowCount) return null;
    // While the control plane is the merge writer the transaction refuses a pull request (GY-1523): GitHub is not asked about it.
    if ((await recordedMergerMode(this.store.leasePool)).merger === 'control-plane') return null;
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
   * Receipt first, so a replayed `complete` runs no git; nothing is read while GitHub is the merge
   * writer, since the transaction refuses the head then. The candidate's change number is
   * allocated inside the transaction, which binds it to this observation.
   */
  private async observeSubmittedHead(actor: Principal, id: string | null, data: { epoch: number; head: string }, key: string): Promise<Observation | null> {
    if (!id) return null;
    if ((await this.store.leasePool.query('SELECT 1 FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rowCount) return null;
    if ((await recordedMergerMode(this.store.leasePool)).merger !== 'control-plane') return null;
    // `complete` is a lease command (GY-558): its reads take the lease pool, like its transaction.
    const work = (await lockedWork(this.store.leasePool, [id])).find(w => w.id === id || w.key === id);
    const workspace = work?.workspaces.find(w => w.epoch === data.epoch);
    if (!work || work.stage === 'done' || !workspace) return null;
    if (this.gitRunner === undefined) this.gitRunner = gitRunnerFor(process.env.GRAPHYARD_REPOSITORY_ROOT ?? process.cwd());
    demand(this.gitRunner, 'The control plane has no checkout to read a submitted head from; a head submission needs the merge writer checkout', 503);
    return observeLocalHead(this.gitRunner, { head: data.head, base: this.baseBranch, branch: workspace.branch, author: actor.id });
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
   * a reason, and a contract scope inside the task's own planned files. The audit fields are
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
      demand(ac.bootstrap.contractPaths.every((path: string) => data.plannedFiles.some((planned: string) => pathScopeContains(planned, path))),
        `Bootstrap contract paths for ${ac.id} must lie inside the task's planned files`);
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
  async execute(actor: Principal, command: Command, id: string | null, input: unknown, key: string, context: { observation?: Observation; ciRun?: CiRunObservation | null; attestation?: EvidenceAttestation } = {}) {
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
   * through as many evaluations. Reconciliation first lets pending I/O — an arriving request
   * included — run, then waits until no renewal is in flight, so a renewal waits on at most the one
   * evaluation it arrived during.
   */
  private async yieldToRenewals() {
    await new Promise(resolve => setImmediate(resolve));
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
   * whose worker stopped renewing has no such record and expires as before.
   */
  private async renewalGrace(db: PoolClient, work: Work, now: Date) {
    const lease = work.lease as GracedLease | null;
    if (!lease || lease.renewalFault || Date.parse(lease.expiresAt) > now.getTime()) return false;
    const leaseMs = this.leaseSeconds * 1000, expires = Date.parse(lease.expiresAt);
    const fault = (await db.query(`SELECT payload->>'at' AS at, payload->>'error' AS error FROM events WHERE kind=$1 AND created_at>$2::timestamptz AND work_id=$3
      AND payload->>'owner'=$4 AND (payload->>'epoch')::int=$5 AND (payload->>'at')::timestamptz>$2::timestamptz AND (payload->>'at')::timestamptz<=$6::timestamptz
      ORDER BY (payload->>'at')::timestamptz LIMIT 1`, [renewalFaultEvent, new Date(expires - leaseMs).toISOString(), work.id, lease.owner, lease.epoch, lease.expiresAt])).rows[0] as { at: string; error: string } | undefined;
    if (!fault) return false;
    lease.renewalFault = { at: new Date(fault.at).toISOString(), error: fault.error };
    lease.expiresAt = new Date(Math.max(expires, Date.parse(fault.at) + leaseMs)).toISOString();
    return true;
  }
  private async executeCommand(actor: Principal, command: Command, id: string | null, input: unknown, key: string, context: { observation?: Observation; ciRun?: CiRunObservation | null; attestation?: EvidenceAttestation } = {}) {
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
      preserveAssignment(work); retainQuarantineFence(work);
      demand(work.stage !== 'done', 'Delivered work is immutable; create a follow-up task');
      this.renewLease(work, actor, data.epoch, now);
      await save(db, work, actor.id, command, now, data);
      // A renewal's replay needs only the lease, not a whole document per renewal.
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(compactHeartbeatReceipt(work))]);
      return work;
    }, { lane: 'lease', fleetLock: false, itemLock: id });
    const observation = command === 'submit' ? context.observation ?? await this.observeSubmission(actor, id, data, key) : null;
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
      // Set by the requirements command: the revision was a purely additive planned-files
      // widening applied to a live attempt, recorded in history beside the intent.
      let widening = false;
      // Set by the autoscope command: how the control plane decided the open scope request.
      let decision: ScopeDecision | null = null;
      // Set by the requirements command (GY-1484): an approved decision's widening applied though the
      // scope request it answers closed between the approval and its application.
      let lateAnswer: { approver: string; reason: string | null } | null = null;
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
          const scenario = (await db.query('SELECT document FROM scenarios WHERE id=$1 ORDER BY revision DESC LIMIT 1', [proof.slice(4)])).rows[0]?.document;
          demand(scenario, `Register E2E scenario ${proof.slice(4)} before creating work that requires it`);
          scenarioRequirements.push({ proof, revision: scenario.revision, environment: scenario.environment, hash: scenario.hash });
        }
        const created = now.toISOString();
        const { reason: _reason, ...intent } = data;
        work = { ...intent, criteria, id: randomUUID(), key: '', stage: 'backlog', revision: 0, policyRevision: 1, createdAt: created, updatedAt: created, stageEnteredAt: created,
          ready: false, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements, evidence: [], observation: null, blocker: null, gates: [], violations: [] };
        // A policy-required post-deployment proof needs an authorized producer as much as a criterion proof does.
        work!.proofGaps = await unauthorizedProofs(db, this.principals, [...proofNames, ...(deploySmokeRequired(data.policy) ? [deploySmokeProof] : [])], data.producerProofs);
        // Every feature and bug carries the standard documentation criterion, naming the paths this
        // repository configures (GY-215); nobody writes it into the ticket.
        const documentation = documentationObligation(data.type, this.documentation);
        if (documentation) work!.documentation = documentation;
        const inserted = await db.query('INSERT INTO work_items(id,document) VALUES($1,$2) RETURNING number', [work!.id, JSON.stringify(work)]);
        work!.key = `GY-${inserted.rows[0].number}`;
        all.push(work!);
        this.refuseRenewedDeferral(work!, all);
      }
      demandWork(work);
      // A lease past its expiry that a recorded server-side renewal fault still covers stays live (GY-558).
      await this.renewalGrace(db, work, now);
      if (actor.role === 'operator-agent') {
        authorizeOperatorCommand(actor, command, data, work, this.repository);
        if (command === 'ready' || command === 'unblock') demand(data.expectedRevision === work.revision, 'Task revision changed; reload before mutating');
        if (command === 'ready') demand(work.stage === 'backlog' && !work.ready, 'Only unreleased backlog work can be released');
        if (command === 'unblock') demand(work.blocker, 'Task has no blocker to clear');
      }
      // The only commands a delivered item still accepts: containment cleanup, and the two
      // post-deployment facts that extend the delivery snapshot without reopening the merge.
      const postDeployment = command === 'deployment' || command === 'evidence' && data.proof === deploySmokeProof;
      const containmentCleanup = ['settle', 'recover', 'autosettle'];
      const deliveredContainmentCleanup = work.stage === 'done' && containmentCleanup.includes(command);
      // Ending a session handle an item still carries is the third thing a delivered item accepts,
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
      preserveAssignment(work); retainQuarantineFence(work);
      if (command !== 'create' && !containmentCleanup.includes(command) && !postDeployment && !deliveredSessionClosure) demand(work.stage !== 'done', 'Delivered work is immutable; create a follow-up task');
      if (command === 'rereview') {
        if (actor.role !== 'admin') { demand(actor.role === 'worker', 'Worker or operator required', 403); activeLease(work, actor, data.epoch, now); }
        demand(work.policy.review && ['codex', 'agent'].includes(reviewProviderOf(work.policy)) && work.submission && !work.observation?.merged, 'Open submitted work with a dispatched review provider is required');
        work.reviewRequest = null; work.observation = null; work.mergeAuthorization = null;
        // Re-review restarts failover at the first configured profile; the event ledger keeps
        // every superseded exhaustion record for this candidate.
        work.reviewFailovers = (work.reviewFailovers ?? []).filter(failover => failover.sha !== work.candidate?.sha
          || failover.baseSha !== work.candidate?.baseSha || failover.policyRevision !== work.policyRevision);
      }
      if (command === 'refresh') {
        if (actor.role !== 'operator-agent') demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
        demand(work.submission && !work.observation?.merged && work.stage !== 'done' && !work.reworkRequested, 'Open submitted work is required');
        const candidate = work.candidate, observation = work.observation;
        demand(candidate && observation?.candidate.sha === candidate.sha && observation.prState === 'open' && observation.draft === false, 'An open pull request observed at the current head is required');
        demand(observation!.baseTip === data.base, `The base branch tip last observed for ${work.key} is ${observation!.baseTip?.slice(0, 12) ?? 'unknown'}, not ${data.base.slice(0, 12)}; retry once it is observed`, 409);
        demand(observation!.baseTipContained === false, `${work.key} head ${candidate!.sha.slice(0, 12)} already contains base branch tip ${data.base.slice(0, 12)}; there is nothing to merge in`);
        const refresh = work.baseRefresh;
        demand(!(refresh && refresh.from.sha === candidate!.sha && refresh.base === data.base && refresh.policyRevision === work.policyRevision),
          `A refresh of ${work.key} head ${candidate!.sha.slice(0, 12)} onto ${data.base.slice(0, 12)} is already recorded`);
        demand(!requestedBaseRefresh(work), `A refresh of ${work.key} head ${candidate!.sha.slice(0, 12)} is already requested; the reconciliation job runs it`);
        // Beside `baseRefresh`, not in it: an approval an earlier refresh carried onto this head still binds until the merge runs.
        work.baseRefreshRequest = { head: candidate!.sha, base: data.base, policyRevision: work.policyRevision, by: actor.id, at: now.toISOString(), reason: data.reason };
      }
      if (command === 'reviewpolicy') {
        if (actor.role !== 'operator-agent') admin(actor);
        demand(!work.observation?.merged, 'Merged work requires a follow-up task');
        demand(work.policy.review, 'Task must already require review');
        demand(work.policyRevision === data.expectedPolicyRevision, 'Policy revision changed; reload before revising');
        demand(data.provider === 'agent' ? !!data.reviewerProfiles : !data.reviewerProfiles, 'Reviewer profiles are required for agent review and rejected for every other provider');
        demand(reviewProviderOf(work.policy) !== data.provider || JSON.stringify(work.policy.reviewerProfiles ?? null) !== JSON.stringify(data.reviewerProfiles ?? null), 'Review provider and reviewer profiles are already selected');
        if (data.provider === 'agent') {
          assertReviewerProfiles(data.reviewerProfiles, this.reviewerApps, this.controlPlaneAppId);
          demand(new Set(data.reviewerProfiles.map((profile: { name: string }) => profile.name)).size === data.reviewerProfiles.length
            && new Set(data.reviewerProfiles.map((profile: { reviewerApp: string }) => profile.reviewerApp)).size === data.reviewerProfiles.length,
          'Reviewer profile names and reviewer Apps must be unique');
        }
        const { reviewerProfiles: _previousProfiles, ...rest } = work.policy;
        work.policy = { ...rest, reviewProvider: data.provider, ...(data.provider === 'agent' ? { reviewerProfiles: data.reviewerProfiles } : {}) };
        work.policyRevision++;
        work.formalReviewResetRequired = true; work.formalReviewBaseline = undefined;
        work.observation = null; work.mergeAuthorization = null; work.reviewRequest = null;
      }
      if (command === 'requirements') {
        demand(!work.children?.length, `${work.key} was split into child items; revise the child items directly rather than the parent`);
        if (actor.role !== 'operator-agent') admin(actor);
        const flag = flagPathRefusal(data.plannedFiles, 'plannedFiles'); demand(!flag, flag!, 422);
        demand(!work.observation?.merged, 'Merged work requires a follow-up task');
        // A purely additive planned-files widening is non-weakening intent: applied to a live
        // attempt it keeps the lease (and any containment fence) so the worker never hands the
        // item back. Every other revision under a live lease or quarantine is refused exactly
        // as before.
        const leaseLive = !!work.lease && Date.parse(work.lease.expiresAt) > now.getTime();
        // A revision read before the item's last one is refused as exactly that, first: judged
        // against requirements it never saw, an additive widening reads as a narrowing and would be
        // refused as a quarantine or lease breach it is not (GY-1293).
        demand(data.expectedPolicyRevision === work.policyRevision, 'Policy revision changed; reload before revising');
        widening = liveScopeWidening({ criteria: work.criteria, dependencies: work.dependencies, plannedFiles: work.plannedFiles ?? [], exclusiveResources: work.exclusiveResources, producerProofs: work.producerProofs }, data);
        if (!widening) {
          demand(!work.containmentQuarantine, `Task is quarantined by unverified containment from epoch ${work.containmentQuarantine?.epoch}; requirements remain immutable until settlement or stopped-worker recovery`);
          demand(!leaseLive, 'Stop and release the active worker before revising requirements');
        }
        // A widening that answers one attempt's scope request (the loop's, on a review finding)
        // holds only while that request is open, its attempt holds a live lease and the head the
        // findings were read for is still the candidate: a claim, a lease end or a push changes
        // one of those without a new policy revision, so a widening decided on reads made before
        // that is moot and refused here, in the same transaction.
        if (data.answers) {
          demand(widening, 'Only an additive planned-files widening answers a scope request');
          const open = work.scopeRequest?.epoch === data.answers.epoch && work.scopeRequest?.at === data.answers.at;
          const held = leaseLive && work.lease!.epoch === data.answers.epoch;
          // GY-1484: the independent approver's verified judgement of the worker's reason and the
          // criteria (no head named) does not evaporate with the request: the approval routinely lands
          // minutes after the ask, when the wait window or the asking attempt may already have ended.
          // Applied through its approved decision, the additive widening stands for the item and
          // whichever attempt holds it next. The client's Idempotency-Key alone proves nothing (GY-1347):
          // the ledger must hold an approved `requirements` decision of that id, requested by this actor,
          // whose recorded input answers the same request with the same plannedFiles, so no other
          // approval (a resolve, or an earlier widening of other paths) can authorize it. A
          // finding-grounded widening (it names a head) and any other one are refused exactly as before.
          if ((!open || !held) && data.answers.sha === undefined && key.startsWith('decision:')) {
            const approval = (await db.query(`SELECT a.actor, a.payload->>'reason' AS reason, r.actor AS requester, r.payload->'input' AS input FROM events a
              JOIN events r ON r.work_id=a.work_id AND r.kind='decision.requested' AND r.payload->>'id'=a.payload->>'id' AND r.payload->>'action'='requirements'
              WHERE a.work_id=$1 AND a.kind='decision.approved' AND a.payload->>'id'=$2 ORDER BY a.seq DESC LIMIT 1`, [work.id, key.slice('decision:'.length)])).rows[0] as { actor: string; reason: string | null; requester: string; input: Record<string, any> | null } | undefined;
            if (approval && sameApprovedWidening(approval, actor.id, data)) lateAnswer = { approver: approval.actor, reason: approval.reason };
          }
          demand(open || lateAnswer, 'The scope request this widening answers is no longer open');
          demand(held || lateAnswer, `Epoch ${data.answers.epoch}, which asked for this scope, no longer holds the lease`);
          // Grounds read against one head (review findings) are another head's after a push; an
          // approver's judgement of the worker's reason and the criteria (GY-176) names no head.
          if (data.answers.sha !== undefined) demand((work.candidate?.sha ?? null) === data.answers.sha, `The findings this widening rests on were read for ${data.answers.sha?.slice(0, 12) ?? 'no head'}, which is no longer the item's head`);
        }
        // The loop's own re-plan onto a planned file's successors (GY-1397): only the operator agent
        // names that rule, and only for a purely additive widening, so the record tells it apart
        // from a widening a person or a coordinator made.
        if (data.rule) demand(actor.role === 'operator-agent' && widening, 'Only the operator agent\'s purely additive planned-files widening is a rule-grounded re-plan');
        // A hand widening of an ask the loop is putting to the independent approver pre-empts that
        // judgement (GY-1388): a master or the doctor ran `master scope` minutes before the routed
        // decision arrived, and each was an intervention the product had already taken on. While that
        // decision is pending, or not yet requested within the bound the loop settles a scope ask in,
        // only the loop's own answer (`answers`) or an applied decision (run as admin) widens for that
        // ask. The Idempotency-Key is the client's to choose, so it exempts nothing.
        const routedAsk = actor.role === 'operator-agent' && widening && !data.answers && !data.rule ? routedScopeAsk(work, data.plannedFiles, now.getTime()) : null;
        if (routedAsk) {
          const refusal = handScopeWideningRefusal(work.key, routedAsk, (await routedScopeDecisions(db, [work])).get(work.id) ?? [], now.getTime());
          demand(!refusal, refusal!, 409);
        }
        demand(new Set(data.criteria.map((ac: { id: string }) => ac.id)).size === data.criteria.length, 'Criterion IDs must be unique');
        if (work.parent) {
          const parent: Work | undefined = (await db.query(`SELECT document FROM work_items WHERE id = ${workIdByRef('$1')}`, [work.parent])).rows[0]?.document;
          const refusal = parent ? splitChildRevisionRefusal(work, parent, data.criteria) : null;
          demand(!refusal, refusal!);
        }
        if (actor.role === 'operator-agent') {
          demand(work.criteria.every(previous => data.criteria.some((next: typeof previous) => next.id === previous.id && next.text === previous.text && JSON.stringify(next.proofs) === JSON.stringify(previous.proofs))), 'Operator agents may add requirements but cannot weaken or rewrite existing criteria');
          demand(work.dependencies.every(dependency => data.dependencies.includes(dependency)), 'Operator agents cannot remove dependencies');
          // Folding planned files into a directory that contains them keeps their containment (GY-549).
          demand(plannedFilesCovered(work.plannedFiles, data.plannedFiles), 'Operator agents cannot remove planned-file containment');
          demand((work.exclusiveResources ?? []).every(resource => data.exclusiveResources.includes(resource)), 'Operator agents cannot remove exclusive-resource containment');
        }
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
          const scenario = (await db.query('SELECT document FROM scenarios WHERE id=$1 ORDER BY revision DESC LIMIT 1', [proof.slice(4)])).rows[0]?.document;
          demand(scenario, `Register E2E scenario ${proof.slice(4)} first`);
          pins.push({ proof, revision: scenario.revision, environment: scenario.environment, hash: scenario.hash });
        }
        const retired = work.criteria.filter(ac => !data.criteria.some((next: { id: string }) => next.id === ac.id));
        const narrowed = work.criteria.filter(ac => { const next = data.criteria.find((n: { id: string }) => n.id === ac.id); return next && ac.proofs.some(proof => !next.proofs.includes(proof)); });
        if (retired.length || narrowed.length) {
          // The idempotency key is the caller's to choose, so a `decision:` key alone proves nothing: the
          // escalation names a decision only when this item's ledger records it approved (GY-1347).
          const decision = key.startsWith('decision:') ? key.slice('decision:'.length) : null;
          const approved = decision && (await db.query(`SELECT 1 FROM events WHERE work_id=$1 AND kind='decision.approved' AND payload->>'id'=$2 LIMIT 1`, [work.id, decision])).rowCount;
          raiseEscalation(work, { trigger: 'requirement-weakening', reason: `Requirement revision retires ${retired.map(ac => ac.id).join(', ') || 'no criterion'} and narrows proofs for ${narrowed.map(ac => ac.id).join(', ') || 'no criterion'}`, at: now.toISOString(), actor: actor.id, ...(approved ? { decision: decision! } : {}) });
        }
        work.retiredCriterionIds = [...(work.retiredCriterionIds ?? []), ...work.criteria.filter(ac => !data.criteria.some((next: { id: string }) => next.id === ac.id)).map(ac => ac.id)];
        work.criteria = revised;
        work.dependencies = data.dependencies; work.plannedFiles = data.plannedFiles; work.exclusiveResources = data.exclusiveResources; work.producerProofs = data.producerProofs;
        // Opting in or out of splitting before first dispatch (GY-1126); a revision that omits it keeps the item's setting.
        if (data.split !== undefined) work.split = data.split;
        work.scenarioRequirements = pins; work.policyRevision++;
        this.refuseRenewedDeferral(work, all);
        work.proofGaps = await unauthorizedProofs(db, this.principals, [...proofs, ...(deploySmokeRequired(work.policy) ? [deploySmokeProof] : [])], work.producerProofs);
        work.formalReviewResetRequired = true; work.formalReviewBaseline = undefined;
        // A request the widened scope fully covers is answered; a partial one stays open for the
        // master. Answering it also lifts the refusal that was blocking the item on scope.
        if (work.scopeRequest && work.scopeRequest.paths.every(path => data.plannedFiles.some((scope: string) => pathScopeContains(scope, path)))) {
          // A widening that answers the request is its decision, kept where the asking worker's own
          // `status` and `scope-request --wait` read it (GY-176): approved, and by whom and why,
          // whether the loop routed it or a master widened by hand (`master scope`), since either
          // clears the request the wait would otherwise read. A routed decision is applied as its
          // requester, so the approver and their own reason come from the decision's approval entry.
          const approval = data.answers && key.startsWith('decision:')
            ? (await db.query(`SELECT actor, payload->>'reason' AS reason FROM events WHERE work_id=$1 AND kind='decision.approved' AND payload->>'id'=$2 ORDER BY seq DESC LIMIT 1`, [work.id, key.slice('decision:'.length)])).rows[0] as { actor: string; reason: string | null } | undefined
            : undefined;
          work.scopeDecision = { state: 'approved', reason: approval?.reason ?? data.reason, at: now.toISOString(), decidedBy: approval?.actor ?? actor.id, waitedMs: Math.max(0, now.getTime() - Date.parse(work.scopeRequest.at)),
            paths: work.scopeRequest.paths, requestedBy: work.scopeRequest.requestedBy, requestedAt: work.scopeRequest.at, epoch: work.scopeRequest.epoch };
          work.scopeRequest = null;
          if (work.blocker?.startsWith(scopeRefusalBlocker)) work.blocker = null;
        } else if (lateAnswer) {
          // GY-1484: the approved widening is still the decision of the request it answers, though that
          // request closed: recorded where `status` and the next attempt read it — the ask carried to the
          // item when its attempt ended, or else the paths this widening added.
          const asked = work.carriedScopeRequest?.at === data.answers.at ? work.carriedScopeRequest : null;
          work.scopeDecision = { state: 'approved', reason: lateAnswer.reason ?? data.reason, at: now.toISOString(), decidedBy: lateAnswer.approver, waitedMs: Math.max(0, now.getTime() - Date.parse(data.answers.at)),
            paths: asked?.paths ?? unplannedPaths(before!.plannedFiles, data.plannedFiles), requestedBy: asked?.requestedBy ?? actor.id, requestedAt: data.answers.at, epoch: data.answers.epoch };
        }
        // A carried request (GY-1484) the widened scope now covers is answered: nothing is left to inherit.
        if (work.carriedScopeRequest && !unplannedPaths(work.plannedFiles, work.carriedScopeRequest.paths).length) work.carriedScopeRequest = null;
        // A revision other than a live-scope widening is a hand-off for an item already under way:
        // its timeline counts it, and the lapsed lease it discards (a live one was refused above)
        // ends that attempt at its deadline. A widening keeps the attempt, so it counts neither.
        if (!widening) {
          if (work.lease) endLapsedAttempt(work, work.lease, now);
          recordIntervention(work, 'requirements');
          work.lease = null;
        }
        work.observation = null; work.mergeAuthorization = null; work.reviewRequest = null;
        // A submitted implementation must be explicitly reconsidered for changed intent.
        if (work.submission) work.reworkRequested = true;
      }
      if (command === 'ready') { if (actor.role !== 'operator-agent') admin(actor); work.ready = true; }
      if (command === 'unblock') { if (actor.role !== 'operator-agent') admin(actor); work.blocker = null; }
      if (command === 'resolve') {
        // Resolution is a human judgement: no lead, worker, producer, or scoped
        // operator agent may clear the escalation that refuses its own delivery.
        // An admin credential that declares `ai`, or declares nothing, is not a
        // human operator, exactly as for human-only intake. The one exception is a
        // lease-loss the control plane itself raised (actor `graphyard`) for a lapse
        // the ledger already explains: any admin session may settle that by citing the
        // blocked report or stopped-worker attestation, which is verified here, never
        // taken from the request. Lead-raised, security and requirement concerns stay human-only.
        admin(actor);
        const standing = standingEscalations(work);
        demand(standing.length, 'Task has no escalation to resolve');
        const target = standing.find(entry => entry.trigger === data.trigger);
        demand(target, `Standing escalations are ${standing.map(entry => entry.trigger).join(', ')}; reload before resolving`);
        demand(data.expectedRevision === work.revision, 'Task revision changed; reload before resolving');
        let cited: Attestation | null = null;
        if (data.attestation) {
          demand(target!.trigger === 'lease-loss' && target!.actor === 'graphyard', `Only a lease-loss raised by the control plane is settled by citing an attestation; the standing ${target!.trigger} was raised by ${target!.actor}`);
          const epoch = leaseLossEpoch(target!);
          demand(epoch !== null && data.attestation.epoch === epoch, `The standing lease-loss belongs to epoch ${epoch ?? 'unknown'}; cite that epoch's attestation`);
          cited = attestationFor(await readAttestations(db, work.id), epoch!, data.attestation.kind);
          demand(cited, `The ledger holds no ${data.attestation.kind} ${data.attestation.kind === 'blocked' ? 'report' : 'attestation'} for epoch ${epoch}; a lapse nothing explains needs a declared human session`);
        }
        if (sessionKind(actor) !== 'human') demand(cited, `Escalation resolution requires a declared human session; ${actor.id} is ${sessionKind(actor)}. An admin session of any kind may settle only a control-plane-raised lease-loss, by citing the blocked report or stopped-worker attestation that explains it`, 403);
        // Every other standing trigger survives: one resolution clears one concern.
        resolveEscalation(work, data.trigger);
        await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, actor.id, 'escalation.resolved',
          JSON.stringify({ details: { trigger: data.trigger, epoch: leaseLossEpoch(target!), escalation: target, resolvedBy: actor.id, sessionKind: sessionKind(actor), reason: data.reason, attestation: cited, at: now.toISOString() } })]);
      }
      if (command === 'rework') {
        admin(actor);
        demand(!work.observation?.merged, 'Merged work requires a follow-up task');
        demand(!work.containmentQuarantine || (!work.lease || Date.parse(work.lease.expiresAt) <= now.getTime())
          && (!work.containmentQuarantine.launchExpiresAt || Date.parse(work.containmentQuarantine.launchExpiresAt) <= now.getTime()),
        `Worker startup for epoch ${work.containmentQuarantine?.epoch} remains fenced; stop its supervisor and wait for both lease and launch authority expiry before recovery`);
        work.reworkRequested = true;
        work.containmentQuarantine = null;
        // Reassignment discards whatever assignment still stood. A lease dropped
        // here was never released by its worker, and clearing it is the last
        // moment its end is visible: reconcile only ever sees an expired lease,
        // and the replacement claim guards on `work.lease`, which is now null.
        // So the end is recorded here. The operator's stopped-worker attestation
        // is itself the explanation: the admin stopped the worker and says so in
        // this same audited command, so the discarded lease is `lease.expired`
        // with cause `stopped-by-attestation`, never a silently vanished worker.
        preserveAssignment(work);
        if (work.lease) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', 'lease.expired',
          JSON.stringify({ details: { owner: work.lease.owner, epoch: work.lease.epoch, expiresAt: work.lease.expiresAt, submission: work.submission, cause: 'stopped-by-attestation',
            attestation: { kind: 'stopped-worker', source: 'rework', epoch: work.epoch, actor: actor.id, at: now.toISOString(), reason: data.reason }, at: now.toISOString() } })]);
        recordRework(work, now);
        work.lease = null;
        // Reopening implementation is the authorized recovery for send-back.
        // A plan rejection remains owned by its originating lead and can only
        // be superseded by that lead's later approve-plan ruling.
        if (work.leadHold?.action === 'send-back') releaseLeadHold(work);
      }
      if (command === 'recover') {
        admin(actor);
        demand(work.stage === 'done', 'Containment recovery is only available for delivered work');
        demand(work.containmentQuarantine, 'Delivered work has no containment quarantine');
        work.containmentQuarantine = null;
      }
      if (command === 'claim') {
        demand(actor.role === 'worker' || actor.role === 'admin', 'Worker permission required', 403);
        demand(!work.children?.length, `${work.key} was split into ${work.children?.join(', ')} before dispatch; it is delivered when they are and is never claimed directly`);
        demand(work.ready && !work.blocker, 'Task is not ready or has a blocker');
        demand(!work.containmentQuarantine, `Task is quarantined by unverified containment from epoch ${work.containmentQuarantine?.epoch}`);
        demand(work.dependencies.every(dep => all.find(w => w.id === dep)?.stage === 'done'), 'Unfinished dependencies');
        demand(!work.lease || Date.parse(work.lease.expiresAt) <= now.getTime(), 'Task already has an active owner');
        demand(!work.submission || work.reworkRequested, 'Implementation is submitted; an operator must request rework before reassignment');
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
        // A replacement claim over a lapsed lease is the last chance to record how that
        // assignment ended, exactly as reconciliation would have: explained lapses are
        // history, a silently vanished worker is an escalation the overwrite cannot erase.
        if (work.lease) {
          const explained = leaseLapseCause(work, work.lease, await readAttestations(db, work.id));
          if (explained) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', 'lease.expired',
            JSON.stringify({ details: { owner: work.lease.owner, epoch: work.lease.epoch, expiresAt: work.lease.expiresAt, submission: work.submission, ...explained, at: now.toISOString() } })]);
          else raiseEscalation(work, { trigger: 'lease-loss', reason: leaseLossReason(work.lease), at: now.toISOString(), actor: 'graphyard' });
          endLapsedAttempt(work, work.lease, now);
        }
        work.epoch++;
        // A fresh attempt asks afresh: the previous attempt's scope request belongs to a lease that no longer exists.
        // An ask carried from an attempt that ended while the approver judged it (GY-1484) is this attempt's own.
        // A lapsed lease no reconciliation closed yet leaves its ask open: it is carried the same way.
        const lapsedAsk = work.scopeRequest ? carriedScopeRequest(work, work.scopeRequest) : null;
        work.scopeRequest = inheritedScopeRequest({ plannedFiles: work.plannedFiles, carriedScopeRequest: lapsedAsk ?? work.carriedScopeRequest }, work.epoch);
        work.carriedScopeRequest = null;
        expireAgentRequests(work, now, `epoch ${work.epoch} claimed the item; a request from an attempt that ended is asked afresh`);
        work.implementers = [...new Set([...implementerIdentities(work), actor.id])];
        work.lastAssignment = { owner: actor.id, epoch: work.epoch, claimedAt: now.toISOString(), ...(actor.displayName ? { displayName: actor.displayName } : {}), ...(actor.runtime ? { runtime: actor.runtime } : {}) };
        work.lease = { owner: actor.id, epoch: work.epoch, expiresAt: new Date(now.getTime() + this.leaseSeconds * 1000).toISOString() };
        beginAttempt(work, work.lease, now);
      }
      if (command === 'heartbeat') this.renewLease(work, actor, data.epoch, now);
      else {
        if (command === 'release') endedBySubmission(work, data.epoch);
        if (['release', 'workspace', 'submit', 'blocked', 'scope', 'quarantine', 'launch'].includes(command)) activeLease(work, actor, data.epoch, now);
      }
      if (command === 'quarantine') {
        demand(!work.containmentQuarantine || work.containmentQuarantine.owner === actor.id && work.containmentQuarantine.epoch === data.epoch
          && work.containmentQuarantine.settlementHash === data.settlementHash, 'Containment quarantine already exists and cannot be replaced');
        work.containmentQuarantine ??= { owner: actor.id, epoch: data.epoch, at: now.toISOString(), settlementHash: data.settlementHash, ...(data.scope ? { scope: data.scope } : {}) };
      }
      if (command === 'launch') {
        demand(work.containmentQuarantine?.owner === actor.id && work.containmentQuarantine.epoch === data.epoch
          && work.containmentQuarantine.settlementHash === data.settlementHash,
        'Containment quarantine is missing, superseded, or does not match this launch');
        work.containmentQuarantine.launchAcknowledgedAt ??= now.toISOString();
        work.containmentQuarantine.launchExpiresAt ??= new Date(now.getTime() + this.launchFence).toISOString();
      }
      if (command === 'settle') {
        demand(actor.role === 'worker' && work.containmentQuarantine?.owner === actor.id && work.containmentQuarantine.epoch === data.epoch,
          'Containment quarantine is missing, superseded, or owned by another worker');
        demand(createHash('sha256').update(data.settlementToken).digest('hex') === work.containmentQuarantine.settlementHash,
          'Containment settlement capability is invalid');
        work.containmentQuarantine = null;
      }
      if (command === 'autosettle') {
        // Verified death is proof, not an assertion: the control plane re-checks the fence
        // deadlines and the reported verification itself before lowering a containment fence.
        demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
        demand(work.containmentQuarantine?.epoch === data.epoch && work.containmentQuarantine?.settlementHash === data.settlementHash,
          'Containment quarantine is missing, superseded, or does not match this verification');
        const refusals = containmentSettlementRefusals(work, data.verification, { now: now.getTime() });
        demand(!refusals.length, `Automatic containment settlement refused: ${refusals.join('; ')}. ${containmentAttestation(work.key)}`);
        work.containmentQuarantine = null;
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
          && work.containmentQuarantine?.epoch !== data.epoch && work.submission?.epoch !== data.epoch ? open : undefined;
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
            // and held at the cap for an approver, never ended and relaunched for ever.
            reason: (credentialFailure(data.reason) ? credentialBlockedReason(work, data.epoch, data.reason) : `${blockedAttemptMarker}${data.epoch}: ${data.reason}`).slice(0, 500),
            resetsAt: null, partialWork, at: now.toISOString(), owner: actor.id, recordedBy: actor.id };
          const capacity = work.capacity ?? { exhaustions: [], escalations: [] };
          work.capacity = { ...capacity, exhaustions: [...capacity.exhaustions, record].slice(-retainedExhaustions) };
          endAttempt(work, data.epoch, 'released', now);
          work.lease = null;
        }
      }
      if (command === 'scope') {
        const asks = data.paths.length || data.remove?.length || data.criteria?.length;
        if (!asks) {
          demand(work.scopeRequest, 'No scope request is open for this attempt');
          // GY-1472: the withdrawal ends the attempt's wait on its request, so the worker bound runs from it.
          work.scopeWithdrawn = { epoch: work.scopeRequest.epoch, at: now.toISOString() };
          work.scopeRequest = null;
          // Withdrawing the ask withdraws the refusal it earned; the item is no longer blocked on scope.
          if (work.blocker?.startsWith(scopeRefusalBlocker)) work.blocker = null;
        } else {
          const flag = flagPathRefusal(data.paths, 'Requested path') ?? flagPathRefusal(data.remove, 'Removed path'); demand(!flag, flag!, 422);
          const outside = data.paths.filter((path: string) => !(work.plannedFiles ?? []).some(planned => pathScopeContains(planned, path)));
          demand(outside.length || data.remove?.length || data.criteria?.length, 'Every named path is already inside plannedFiles; no scope request is needed');
          // A fresh ask is undecided by construction: the loop decides it on its next cycle, and
          // a standing refusal keeps blocking the item until that decision replaces it. An ask while
          // this attempt's earlier one is still pending is merged into it, so one decision covers both.
          work.scopeRequest = mergedScopeRequest(work.scopeRequest, { epoch: data.epoch, paths: data.paths, reason: data.reason, requestedBy: actor.id, at: now.toISOString(),
            ...(data.remove?.length ? { remove: data.remove } : {}), ...(data.criteria?.length ? { criteria: data.criteria } : {}) }, work.plannedFiles);
        }
      }
      if (command === 'dispatchblock') {
        demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
        demand(!work.lease || Date.parse(work.lease.expiresAt) <= now.getTime(), `${work.key} is held by ${work.lease?.owner} under epoch ${work.lease?.epoch}; a dispatch failure is recorded only while no attempt holds the item`, 409);
        // GY-1082: only an item awaiting a dispatch can fail one, and a standing blocker is never
        // overwritten. The failures are not taken on the caller's word: the item's own attempt
        // record must show its last `dispatchFailureBlockAfter` attempts each claimed and ended
        // without a submission. The loop supplies only the cause in git's words, which no other
        // record holds; the blocker names the attempts the control plane verified.
        demand(work.ready && (!work.submission || work.reworkRequested), `${work.key} is not awaiting a dispatch; a dispatch failure is recorded only on ready work with no submission or with rework requested`, 409);
        demand(!work.blocker, `${work.key} already carries a blocker; clear it before recording a dispatch failure`, 409);
        const failed = pipelineTimeline(work).attempts.slice(-dispatchFailureBlockAfter);
        demand(failed.length === dispatchFailureBlockAfter && failed.every(attempt => attempt.endedAt && (attempt.end === 'released' || attempt.end === 'expired')),
          `${work.key}'s last ${dispatchFailureBlockAfter} attempts did not each end without a submission; a dispatch failure is recorded only after that many failed attempts in a row`, 409);
        const verified = ` [attempts ${failed.map(attempt => attempt.epoch).join(', ')} each ended without a submission]`;
        work.blocker = `${data.reason.slice(0, 2000 - verified.length)}${verified}`; recordIntervention(work, 'blocked');
      }
      if (command === 'autoscope') {
        // The loop asks, the control plane decides. The verdict is recomputed here from the item's
        // own criteria and this repository's documentation rule, so no caller — not even the
        // coordinator that asked — can assert a widening the item does not already imply.
        demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
        const request = work.scopeRequest;
        // One request is decided once (GY-955): the loop's scope step and an executor's approve-scope
        // can both ask for one undecided request, and whichever lands second is answered, not failed.
        // A request no longer open answers with the item and the decision it recorded; one already
        // decided answers with its standing decision. Neither is rewritten. A refusal is decided
        // again only when the rules as they stand now would approve it.
        if (!request && work.scopeDecision && (work.scopeDecision.epoch ?? data.epoch) === data.epoch) return work;
        demand(request, 'No scope request is open for this item', 404);
        demand(request!.epoch === data.epoch, 'Scope request belongs to another attempt; reload before deciding');
        if (request!.decision && (request!.decision.state !== 'refused' || decideScopeRequest(work, request!).state !== 'approved')) return work;
        demand(work.lease && work.lease.epoch === request!.epoch && Date.parse(work.lease.expiresAt) > now.getTime(),
          'The requesting attempt no longer holds the lease; a fresh attempt asks afresh');
        decision = applyScopeDecision(work, request!, now);
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
          demand(data.type !== 'scope-request' || data.paths?.length, 'A scope request names its attempt epoch and the paths it needs');
          const flag = flagPathRefusal(data.paths, 'Requested path'); demand(!flag, flag!, 422);
          demand(data.type !== 'decision' || data.action, 'A decision request names the action an independent approver must approve');
          demand(data.type !== 'escalation' || data.trigger, 'An escalation request names the trigger it raises');
          const request: AgentRequest = { id: randomUUID(), type: data.type, epoch: data.epoch ?? null, requestedBy: actor.id, at: now.toISOString(), reason: data.reason,
            ...(data.paths ? { paths: data.paths } : {}), ...(data.action ? { action: data.action } : {}), ...(data.trigger ? { trigger: data.trigger } : {}), ...(data.humanDecision ? { humanDecision: data.humanDecision } : {}),
            decider: deciderFor(work.key, data), releasedLease: false, state: 'open' };
          // Each type projects onto the state the gates and the existing machinery already read,
          // so a typed request is the same fact as the command it replaces, with a decider named.
          if (data.type === 'scope-request') {
            const outside = data.paths!.filter((path: string) => !(work!.plannedFiles ?? []).some(planned => pathScopeContains(planned, path)));
            demand(outside.length, 'Every named path is already inside plannedFiles; no scope request is needed');
            work.scopeRequest = mergedScopeRequest(work.scopeRequest, { epoch: data.epoch, paths: data.paths, reason: data.reason, requestedBy: actor.id, at: now.toISOString() }, work.plannedFiles);
            // A scope ask names a deterministic rule as its decider, and the session is about to
            // exit: applying that rule here answers it before anybody waits on it. The verdict is
            // the same one the loop's `autoscope` computes — recomputed from the item's own
            // criteria — so asking and answering in one transaction grants the asker nothing.
            // The `scope` command stays the path for a session that keeps working while it waits.
            decision = applyScopeDecision(work, work.scopeRequest, now);
            request.state = 'resolved'; request.resolvedAt = now.toISOString();
            request.resolution = `${decision.state}: ${decision.reason}`;
          }
          if (data.type === 'blocker') { work.blocker = data.reason; recordIntervention(work, 'blocked'); }
          if (data.type === 'escalation') raiseEscalation(work, { trigger: data.trigger, reason: data.reason, at: now.toISOString(), actor: actor.id });
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
        // A submission ends the run of blockers the loop cleared in a row (GY-1008).
        if (work.blockerProbe) work.blockerProbe = { ...work.blockerProbe, clears: 0 };
        // GY-1523: the recorded merger decides, inside this transaction, which form a submission
        // takes. A head is accepted only while the control plane is the merge writer; a pull request
        // only while GitHub is. The mode read before the transaction chose what was observed, so a
        // head whose observation is missing (the merger flipped between the two reads) is refused.
        const merger = (await recordedMergerMode(db)).merger;
        if (data.head !== undefined) demand(merger === 'control-plane', `A head is submitted only while the control plane is the merge writer; this install's merger is ${merger}, so push the branch and complete ${work.key} ${data.epoch} with its pull request number, or switch the writer with graphyard master merger`, 409);
        else demand(merger !== 'control-plane', `A pull request is submitted only while GitHub is the merge writer; this install's merger is ${merger}, so complete ${work.key} ${data.epoch} --head instead`, 409);
        let observed = observation, number: number;
        if (data.head !== undefined) {
          demand(observation?.source === 'control-plane' && observation.candidate.sha === data.head, `${data.head.slice(0, 12)} was not observed by the control plane (the merger changed while it was read); complete ${work.key} ${data.epoch} --head again`, 409);
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
          const regressions = regressionRefusals(work, observed, all);
          demand(!regressions.length, `Submission refused for ${work.key}: ${regressions.join('; ')}`);
          // Checks registered by approved retro artefacts (GY-970) run against the observed candidate.
          const retroChecks = retroCheckRefusals(work, observed, await readAppliedRetroChecks(db));
          demand(!retroChecks.length, `Submission refused for ${work.key}: ${retroChecks.join('; ')}`);
          // The required cases and contract bindings a merged acceptance pull request protects (GY-1417).
          const protectedCases = protectedCaseRefusals(work, observed, await readProtectingGoals(db));
          demand(!protectedCases.length, `Submission refused for ${work.key}: ${protectedCases.join('; ')}`);
        }
        work.submission = { epoch: data.epoch, pr: number };
        if (data.head !== undefined) {
          // The control plane's reading is the candidate's observation from this instant (GY-1523): the
          // minimal save `observe` makes for a provider reading, with nothing of GitHub's to carry.
          observeHead(work, observed!.candidate, observed!.at);
          work.candidate = observed!.candidate;
          work.observation = observed!;
        }
        if (work.documentation) work.documentation = { ...work.documentation, submission: recordDocumentationSubmission(work.documentation, work.submission, observed?.files ?? null, data.documentation, now) };
        work.reworkRequested = false;
        recordSubmission(work, data.epoch, now);
        // Binding the candidate ends the implementation lease in the same transaction: submitted
        // work continues through the gates without one, and a lease left to lapse afterwards
        // would otherwise read as an abandoned assignment. The workspace and `lastAssignment`
        // keep the attempt attributable, and rework still needs the stopped-worker attestation.
        work.lease = null;
      }
      if (command === 'deployment') {
        demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
        demand(work.stage === 'done' && !!work.delivery, 'A deployment observation is recorded only for delivered work');
        demand(data.mergeSha === work.delivery!.mergeSha, 'Deployment observation names another merge commit');
        // One observation per delivery: the smoke proof binds to exactly this serving commit, so a
        // later rollout cannot quietly move the target the proof was made against.
        demand(!work.delivery!.deployment, 'Delivery already has a recorded deployment observation');
        demand(Date.parse(data.observedAt) <= now.getTime() + 60_000 && Date.parse(data.observedAt) >= Date.parse(work.delivery!.mergedAt) - 60_000, 'Deployment observation time must fall between the merge and now');
        work.delivery!.deployment = { sha: data.sha, mergeSha: data.mergeSha, source: data.source, observedAt: data.observedAt,
          covers: data.sha === data.mergeSha ? 'exact' : 'descendant', at: now.toISOString(), observer: actor.id };
      }
      if (command === 'evidence') {
        demand(actor.role === 'producer' || actor.role === 'worker' || actor.role === 'admin', 'Evidence submission is not permitted', 403);
        // Workers may still record their own untrusted assertions; every identity
        // that could mint trust must be independent of the implementation and the lead.
        const dependent = actor.role === 'worker' ? null : producerIndependenceRefusal(actor, work, this.principals);
        demand(!dependent, dependent ?? 'Evidence producer is not independent', 403);
        // Trust is decided by the live grant set, never by the deployment environment. The CI
        // producer's authority is additionally clipped to the automatable families: a grant it
        // holds outside them is inert, so manual proofs and deploy smoke never arrive from CI.
        const ciProducer = isCiProducer(actor);
        const trusted = await authorizedForProof(db, actor, data.proof) && (!ciProducer || ciFamilyAllows(data.proof));
        let ciRun: Evidence['ciRun'] | undefined;
        if (ciProducer || data.ciRun) {
          // The CI lane refuses instead of storing an untrusted record: every refusal here is a
          // configuration or provenance fault the operator must see, not an assertion to keep.
          demand(ciProducer, 'A CI run binding is accepted only from the CI producer principal', 403);
          demand(data.ciRun, 'CI producer evidence must name the workflow job that produced it', 400);
          demand(ciFamilyAllows(data.proof), `CI evidence is accepted only for ${ciProofFamilies.map(family => `${family}:*`).join(' and ')} proofs; ${data.proof} needs a producer session`, 403);
          demand(trusted, `The CI producer ${actor.id} is not granted ${data.proof}`, 403);
          const refusal = ciRunRefusal(data.ciRun, context.ciRun, data, this.repository, this.ciAppIds);
          demand(!refusal, refusal ?? 'CI run binding refused', context.ciRun ? 403 : 503);
          const stale = staleCiAttemptRefusal(work.evidence, data);
          demand(!stale, stale ?? 'Stale CI attempt');
          ciRun = { ...data.ciRun, headSha: context.ciRun!.headSha, job: context.ciRun!.name, conclusion: context.ciRun!.conclusion!, verifiedAt: context.ciRun!.observedAt };
        }
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
        // An approved attest decision names itself on the record it applies (GY-615), which is what
        // lets a Graphyard-authored refresh of the same patch carry it; see model/carry.ts.
        const evidence: Evidence = { ...data, id: randomUUID(), producer: actor.id, trusted: trusted && !unexercised, at: now.toISOString(), ...(ciRun ? { ciRun } : {}), ...(unexercised ? { unexercised } : {}), ...(context.attestation ? { attestation: context.attestation } : {}) };
        if (unexercised) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, actor.id, 'evidence.exercise.refused',
          JSON.stringify({ details: { proof: data.proof, criteria: attachedCriteria(work, all, data.proof), behaviour: data.exercise?.behaviour ?? null, sha: data.sha, reason: unexercised } })]);
        work.evidence.push(evidence);
        // GY-162: a trusted e2e: record is also a run of its test case, appended to the case's history.
        await recordScenarioRun(db, work, evidence);
        if (data.proof === deploySmokeProof) work.delivery!.smoke = { evidenceId: evidence.id, result: data.result, sha: data.sha, mergeSha: data.baseSha, producer: actor.id, at: evidence.at, executed: data.executed, skipped: data.skipped, ...(data.url ? { url: data.url } : {}) };
        if (trusted && data.policyRevision !== work.policyRevision) raiseEscalation(work, { trigger: 'evidence-policy-conflict', reason: `Evidence policy v${data.policyRevision} conflicts with current policy v${work.policyRevision}`, at: now.toISOString(), actor: actor.id });
      }
      if (command === 'revoke') {
        refuseCiProducer(actor, 'revocation');
        // Producer authority is the same live grant set that decides trust at submission.
        demand(actor.role === 'admin' || actor.role === 'producer' && await authorizedForProof(db, actor, data.proof),
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
      // A widening that covers an open scope ask is the answer to it: the deterministic rule the
      // request named has been applied, so the request closes rather than waiting on nobody.
      // A scope request belongs to the attempt that filed it (GY-597): a command that ended that
      // attempt, or an operator unblocking the item after it ended, closes it with the reason, so
      // its refusal no longer holds the next attempt at the ready gate. The worker's own typed
      // request is the exception: its release is the hand-off that puts the refusal to a decider.
      const closedScope = attemptEndingCommands.has(command) ? closeEndedScopeRequest(work, now, command) : null;
      if (closedScope) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', 'scope.closed', JSON.stringify({ details: closedScope })]);
      if (command === 'requirements') resolveSatisfiedScopeRequests(work, path => (work!.plannedFiles ?? []).some(planned => pathScopeContains(planned, path)), now);
      retainQuarantineFence(work);
      // Delivery is an immutable snapshot. A late containment cleanup or a post-deployment fact may
      // append its audit/revision metadata, but stale inputs must not re-evaluate it.
      if (!deliveredContainmentCleanup && !postDeployment && !deliveredSessionClosure) this.evaluate(work, all, now);
      // A delivered item's gates are an immutable snapshot, but what it still owes — a deployment
      // carrying the merge — is not; its queue is reconciled without re-evaluating the delivery.
      else settleDelivered(work, all, now);
      await this.recordDispatch(db, work, now);
      await save(db, work, actor.id, command, now, command === 'settle' ? { epoch: data.epoch }
        // The instant the fence's authority lapsed, from the record it lowered, so the report can date the settlement against it (GY-1392).
        : command === 'autosettle' ? { ...data, lapsedAt: fenceLapsedAt(before, now.getTime()) }
        : command === 'autoscope' ? { ...data, decision, before: { plannedFiles: before?.plannedFiles ?? [], blocker: before?.blocker ?? null } }
        : actor.role === 'operator-agent' ? { before, intent: data, reason: data.reason ?? null, ...(command === 'requirements' ? { liveScopeWidening: widening } : {}), ...(closedScope ? { closedScopeRequest: closedScope } : {}) }
        // A requirements revision an approved decision applies records whether it was a live widening too (GY-549).
        : command === 'requirements' ? { ...data, liveScopeWidening: widening, before: { plannedFiles: before?.plannedFiles ?? [] }, ...(closedScope ? { closedScopeRequest: closedScope } : {}), ...(lateAnswer ? { answeredClosedRequest: { ...data.answers, approver: lateAnswer.approver } } : {}) }
        : closedScope ? { ...data, closedScopeRequest: closedScope } : data);
      if (work.submission && !postDeployment && !deliveredSessionClosure && !['heartbeat', 'release', 'claim', 'workspace'].includes(command)) await wakeJob(db, work.id);
      // A renewal's replay needs only the lease, not a whole document per renewal.
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(command === 'heartbeat' ? compactHeartbeatReceipt(work) : work)]);
      return work;
    // Lease commands take the lease pool (GY-274, GY-558): however busy every other pool is, a live
    // worker is never stopped because its renewal, claim, completion or blocker could not reach the database.
    }, { lane: leaseCommands.has(command) ? 'lease' : 'request', itemLock: id ?? undefined });
  }

  /** The one item holding action row `id`, found by containment rather than by loading every document. */
  private async actionOwner(db: { query: (text: string, values: unknown[]) => Promise<{ rows: { document: Work }[] }> }, id: string, item?: string): Promise<Work | undefined> {
    // Given the owning item's id, the owner is read again by its primary key instead of found by a scan (GY-1276).
    const scope = item === undefined ? 'w.id IN (SELECT id FROM work_index WHERE NOT settled)' : 'w.id=$2::uuid AND w.id IN (SELECT id FROM work_index WHERE NOT settled)';
    return (await db.query(`SELECT document FROM work_items w WHERE ${scope} AND document->'actionQueue'->'actions' @> jsonb_build_array(jsonb_build_object('id', $1::text)) ORDER BY number LIMIT 1`, item === undefined ? [id] : [id, item])).rows[0]?.document;
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
   * Record the loop's attempt of the remedy a stalled row's reason binds to (GY-949). The row keeps
   * one record per unchanged run (`recordStallRemedy` refuses a second), so the loop applies a
   * remedy at most once for a run however many of its cycles see the row, and the attention and the
   * escalation read what it did from the row itself. The item is evaluated with the record, so a
   * refused remedy's escalation is queued in the same transaction rather than whenever the item is
   * next evaluated — for an item no reconciliation job wakes, never.
   */
  async recordActionRemedy(actor: Principal, id: string, input: unknown) {
    demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
    const data = actionRemedySchema.parse(input);
    return this.store.transaction(async (db, now) => {
      const work = await this.actionOwner(db, id);
      demand(work, 'Action is not open on any work item', 404);
      const row = recordStallRemedy(work!, id, data, actor.id, now);
      const all = (await lockedWork(db, [work!.id])).map(item => item.id === work!.id ? work! : item);
      this.evaluate(work!, all, now);
      await this.recordDispatch(db, work!, now);
      await save(db, work!, actor.id, 'action.remedied', now, { id, kind: row.kind, remedy: data.remedy, outcome: data.outcome, flows: data.flows, detail: data.detail, reason: data.reason });
      if (work!.submission) await wakeJob(db, work!.id);
      return { action: row, work: { id: work!.id, key: work!.key } };
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
    if (wake && before!.submission) await this.store.transaction(async db => { await wakeJob(db, before!.id, data.prioritized === true); });
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
  /** The latest merge request the coordinator recorded for the item, or null (GY-258). */
  async enqueueRequest(id: string, db: { query: (text: string, values: unknown[]) => Promise<{ rows: any[] }> } = this.store.pool): Promise<MergeEnqueueRequest | null> {
    return (await db.query("SELECT payload->'details' AS request FROM events WHERE work_id=$1 AND kind='merge.enqueue.requested' ORDER BY seq DESC LIMIT 1", [id])).rows[0]?.request ?? null;
  }
  /**
   * What GitHub's queue holds for the item, written onto its observation when it changed, and every
   * enqueue and dequeue the control plane performed appended to the ledger with its reason.
   */
  async recordGitHubQueue(id: string, state: GitHubMergeQueueState, action: MergeQueueAction): Promise<Work> {
    return this.store.transaction(async (db, now) => {
      const work: Work = (await db.query('SELECT document FROM work_items WHERE id=$1 FOR UPDATE', [id])).rows[0]?.document;
      demand(work, 'Work item not found', 404);
      if (action.kind !== 'hold') await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'github', action.kind === 'enqueue' ? 'merge.enqueued' : 'merge.dequeued',
        JSON.stringify({ details: { reason: action.reason, pr: work.candidate?.pr ?? null, sha: work.candidate?.sha ?? null, head: state.head, queue: state.queue, mode: state.mode, at: now.toISOString() } })]);
      // A refused enqueue or dequeue is a hold for the queue, never silent (all merges stalled when
      // GitHub refused auto-merge on clean pull requests): one `merge.enqueue.refused` per reason and
      // head, however many observations repeat it, and the latest kept on the observation for master status.
      let refused: GitHubMergeQueueState['refused'] = null;
      if (action.kind === 'hold' && action.reason.startsWith('GitHub refused to')) {
        const seen = (await db.query("SELECT created_at FROM events WHERE work_id=$1 AND kind='merge.enqueue.refused' AND payload->'details'->>'reason'=$2 AND payload->'details'->>'head'=$3 ORDER BY seq DESC LIMIT 1", [work.id, action.reason, state.head])).rows[0];
        const at = seen ? new Date(seen.created_at).toISOString() : now.toISOString();
        if (!seen) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'github', 'merge.enqueue.refused',
          JSON.stringify({ details: { reason: action.reason, head: state.head, mode: state.mode, pr: work.candidate?.pr ?? null, sha: work.candidate?.sha ?? null, queue: state.queue, mergeStateStatus: state.mergeStateStatus ?? null, at } })]);
        refused = { reason: action.reason, head: state.head, mode: state.mode, at };
      }
      // What the queue holds once the action took effect: GitHub answered the mutation, not a re-read.
      const recorded: GitHubMergeQueueState = { ...state, mode: action.kind === 'enqueue' ? state.queue ? 'queued' : 'auto-merge' : action.kind === 'dequeue' ? 'none' : state.mode, refused };
      const comparable = (value: GitHubMergeQueueState | null | undefined) => value ? JSON.stringify({ ...value, at: null }) : null;
      if (!work.observation || work.observation.merged || comparable(work.observation.githubQueue) === comparable(recorded)) return work;
      work.observation.githubQueue = recorded;
      await save(db, work, 'github', 'github.queue', now, { mode: recorded.mode, entryState: recorded.entryState, position: recorded.position });
      return work;
    });
  }
  async bindReviewRequest(id: string, expectedRevision: number, request: ReviewRequest, jobToken: string) {
    return this.store.transaction(async (db, now) => {
      const job = (await db.query('SELECT 1 FROM jobs WHERE work_id=$1 AND token=$2 AND locked_until>$3', [id, jobToken, now])).rows[0];
      requireCurrent(job, 'Integration job lease expired or superseded');
      const all = await lockedWork(db, [id]);
      const work = all.find(w => w.id === id);
      requireCurrent(work && work.revision === expectedRevision && work.stage !== 'done' && !work.observation?.merged, 'Task changed during review dispatch');
      const provider = reviewProviderOf(work.policy);
      demand(work.policy.review && (request.provider ?? 'codex') === provider && ['codex', 'agent'].includes(provider)
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
   * Records what the control plane did about a base branch that moved under an in-flight
   * candidate: the head it republished on the new base, or the conflict that stopped it. The
   * carry is decided here, once, from the record as it stands and GitHub's account of the merge
   * (model/carry.ts), so a clean advance costs no rework round and a conflicting one carries nothing. The worker asserts none of it and never pushes for it.
   */
  async bindBaseRefresh(id: string, expectedRevision: number, refresh: BaseRefresh, jobToken: string) {
    return this.store.transaction(async (db, now) => {
      const job = (await db.query('SELECT 1 FROM jobs WHERE work_id=$1 AND token=$2 AND locked_until>$3', [id, jobToken, now])).rows[0];
      requireCurrent(job, 'Integration job lease expired or superseded');
      const all = await lockedWork(db, [id]);
      const work = all.find(w => w.id === id);
      requireCurrent(work && work.revision === expectedRevision && work.stage !== 'done' && !work.observation?.merged, 'Task changed while the base was refreshed');
      requireCurrent(refresh.policyRevision === work.policyRevision
        && work.candidate?.sha === refresh.from.sha && work.candidate.baseSha === refresh.from.baseSha, 'Candidate or policy changed while the base was refreshed');
      if (refresh.stale) {
        // GitHub's conflict reading was stale (GY-375): the test merge was clean and nothing was
        // written. The reading replaces the refresh record for this head, keeping what it carried
        // onto the head, and the stored observation has its conflict disproved.
        work.baseRefresh = staleRefreshRecord(work.baseRefresh, refresh);
        const disproved = work.observation?.conflicting ? disprovedConflict(work, work.observation) : null;
        if (disproved) work.observation = withDisprovedConflict(work.observation!, disproved);
        this.evaluate(work, all, now);
        await this.recordDispatch(db, work, now);
        await save(db, work, 'graphyard', 'base.stale-mergeability', now, { head: refresh.from.sha, base: refresh.base, reading: refresh.stale.reading });
        await wakeJob(db, work.id);
        return work;
      }
      // A docs-sync head (GY-566) resolved a conflict, which the refresh rule never carries across;
      // its own rule keeps the approval when the diff outside docs/ is unchanged.
      const carry = refresh.docsSync && refresh.head ? docsSyncCarry({ from: refresh.from, base: refresh.base, at: now.toISOString(), policyRevision: work.policyRevision, merge: refresh.merge ?? null, docsSync: refresh.docsSync,
        reviewedFiles: work.observation?.candidate.sha === refresh.from.sha ? work.observation.files : [], approval: bindingApproval(work), proofs: requiredProofs(work, all).map(proof => ({ proof, evidence: currentEvidence(work, proof, now) })) })
        : refresh.head && refresh.head !== refresh.from.sha ? this.decideBaseRefreshCarry(work, all, refresh, now) : null;
      // A conflict re-recorded on a moved base keeps when it was first found on this head (GY-1200).
      work.baseRefresh = { ...refresh, carry, ...(refresh.conflict ? { conflictSince: conflictSince(work.baseRefresh, refresh) } : {}) };
      // A requested refresh (GY-528) is answered by the refresh of the head it named, merged or conflicting.
      if (work.baseRefreshRequest?.head === refresh.from.sha) work.baseRefreshRequest = null;
      this.evaluate(work, all, now);
      if (carry) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', 'base.carry', JSON.stringify({ details: { ...carry, merge: refresh.merge ?? null } })]);
      await this.recordDispatch(db, work, now);
      await save(db, work, 'graphyard', refresh.conflict ? 'base.conflict' : 'base.refreshed', now, { from: refresh.from, base: refresh.base, head: refresh.head, trigger: refresh.trigger ?? null,
        ...(refresh.conflict ? { conflict: refresh.conflict, conflictPaths: refresh.conflictPaths ?? null } : {}),
        ...(refresh.docsSync ? { docsSync: { paths: refresh.docsSync.paths, reviewed: refresh.docsSync.reviewed, synced: refresh.docsSync.synced } } : {}),
        ...(carry ? { carry: { approval: carry.approval.carried ? 'carried' : 'required', evidence: Object.fromEntries(carry.evidence.map(entry => [entry.proof, entry.carried ? 'carried' : 'required'])) } } : {}) });
      await wakeJob(db, work.id);
      return work;
    });
  }
  /** The carry decision for a head Graphyard republished on a moved base; see model/carry.ts for the rule. */
  private decideBaseRefreshCarry(work: Work, all: Work[], refresh: BaseRefresh, now: Date) {
    const candidate = work.candidate!, observation = work.observation;
    const observed = !!observation && observation.candidate.sha === candidate.sha && observation.candidate.baseSha === candidate.baseSha;
    // The base branch is validated by definition: every commit on it already landed through the
    // gates, so the predecessor of a base refresh is the branch itself and nothing else.
    return decideCarry({
      from: refresh.from, to: { sha: refresh.head!, baseSha: refresh.base }, policyRevision: work.policyRevision, at: now.toISOString(),
      merge: refresh.merge, predecessor: { key: null, validated: true }, reviewedFiles: observed ? observation!.files : [],
      approval: bindingApproval(work), proofs: requiredProofs(work, all).map(proof => ({ proof, evidence: currentEvidence(work, proof, now) })),
      app: this.controlPlaneAppId ? `control-plane (App ${this.controlPlaneAppId})` : 'control-plane',
    });
  }
  /**
   * Restores an approval GitHub dismissed for a merge-base change of the unchanged head as the
   * binding one (GY-127, see `dismissedApproval`). The reviewed content is exactly what the
   * reviewer approved, so no review round and no reviewer attempt is spent on it. Decided before
   * the gates are evaluated, so no review request is ever opened for it.
   */
  private restoreDismissedApproval(work: Work, now: Date): RestoredApproval | null {
    if (exactApproval(work) || carriedApproval(work)) return null;
    const dismissed = dismissedApproval(work);
    if (!dismissed) return null;
    // A carried approval the guarded merge could not re-post (GY-831) is not restored from the
    // same dismissed review: the refusal re-required the review, and only a new approval answers it.
    const standing = currentCarry(work)?.approval, refusal = work.mergeRefusal;
    const refused = standing && !standing.carried && standing.refused ? standing.refused : refusal?.sha === work.candidate?.sha ? refusal?.approval : undefined;
    if (refused && refused.reviewer.toLowerCase() === dismissed.reviewer.toLowerCase() && refused.reviewId === dismissed.reviewId) return null;
    const candidate = work.candidate!, observation = work.observation!, at = now.toISOString();
    const short = candidate.sha.slice(0, 12);
    const review = dismissed.reviewId !== undefined ? ` (review ${dismissed.reviewId})` : '';
    const approval: CarriedApproval = { provider: 'github', reviewer: dismissed.reviewer, sha: candidate.sha, ...(dismissed.reviewId !== undefined ? { reviewId: dismissed.reviewId } : {}), carried: true, originalSha: candidate.sha,
      reason: `approval of ${short} by ${dismissed.reviewer}${review} restored: GitHub dismissed it with "${dismissed.dismissal.reason}" while the head was unchanged, so the reviewed content is exactly what was approved` };
    const restored: RestoredApproval = { reviewer: dismissed.reviewer, ...(dismissed.reviewId !== undefined ? { reviewId: dismissed.reviewId } : {}), sha: candidate.sha, dismissal: dismissed.dismissal, at };
    const same = { sha: candidate.sha, baseSha: candidate.baseSha };
    const carry = (existing: BaseRefresh['carry'] | undefined) => existing && existing.to.sha === candidate.sha && existing.to.baseSha === candidate.baseSha && existing.policyRevision === work.policyRevision
      ? { ...existing, approval }
      : { from: same, to: same, policyRevision: work.policyRevision, at, predecessor: 'base branch', changedFiles: [], reviewedFiles: observation.files, approval, evidence: [] };
    if (work.baseRefresh && work.baseRefresh.head === candidate.sha && work.baseRefresh.policyRevision === work.policyRevision) {
      work.baseRefresh.carry = carry(work.baseRefresh.carry); work.baseRefresh.restoredApproval = restored;
    } else if (work.baseRefresh && work.baseRefresh.head === null && work.baseRefresh.from.sha === candidate.sha && work.baseRefresh.policyRevision === work.policyRevision) {
      // A record of this very head that republished nothing — a refresh whose merge conflicted —
      // is left as it says, and nothing is restored: such a head is replaced before it could land
      // (the worker resolves the conflict), and replacing the record would drop the conflict the
      // worker owes and have the refresh retried for a conflict already recorded. No review is
      // asked for it meanwhile: the head does not contain the base tip.
      return null;
    } else {
      // The head is not a refreshed head: the restored binding is recorded as a refresh of the
      // head onto the base it is bound to, which republished nothing.
      work.baseRefresh = { from: same, base: candidate.baseSha, baseTree: observation.baseTip === candidate.baseSha ? observation.baseTree ?? '' : '', policyRevision: work.policyRevision, at,
        head: candidate.sha, conflict: null, merge: null, carry: carry(undefined), restoredApproval: restored };
    }
    return restored;
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
  evaluate(work: Work, all: Work[], now: Date) {
    // One request, one verdict (GY-124): two verdicts from one identity on one head for one request
    // are recorded as a conflict and withheld from the observation before any gate reads it.
    this.conflictTransitions.set(work, [...(this.conflictTransitions.get(work) ?? []), ...reconcileReviewConflict(work, now)]);
    const result = evaluate(work, all, now, this.ciAppIds);
    if (work.stage !== result.stage) work.stageEnteredAt = now.toISOString();
    Object.assign(work, result);
    // Graphyard keeps no merge queue (GY-1236): a document stored before then drops its fields here.
    dropRetiredQueueFields(work);
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
    // two readers of the same evaluation cannot disagree about what this item needs.
    const computed = nextAction(work, all, now);
    // An open item the derivation names nothing for and nothing moves is owned by an escalation (GY-201).
    reconcileActions(work, all, now, { next: computed ?? livenessFallback(work, all, now) });
    // Only a different decision is written: an identical action rebuilt in source order would
    // differ from the stored one by key order alone, and the reconciliation tick would rewrite
    // every item on every pass.
    if (work.nextAction === undefined || !sameAction(work.nextAction, computed)) work.nextAction = computed;
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
   * what only the clock moves — an observation going stale, a settle window closing.
   */
  reconcileFullEvaluationMs = configuredReconcileFullMs();
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
  /** A committed reconciliation write changed what other items read of it: the next pass evaluates every live item. */
  private reconcileFaceMoved = false;
  /** What the last pass read and evaluated: the documents it fetched, the items it evaluated, and whether it was full. */
  lastReconcile = { documentsRead: 0, evaluated: 0, live: 0, full: false };
  /** Forget the kept view, so the next pass reads the whole fleet again (GY-1124). */
  resetReconcileView() { this.reconcileView.clear(); this.reconcileOwed.clear(); this.reconcileFullAt = -Infinity; this.reconcileFaceMoved = false; }
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
   * did: every live item when another item's fleet face changed (anything beyond a lease
   * renewal: stage, queue, dependencies, resources, candidate…) or the engine's merge
   * configuration did; an item whose lease has lapsed or whose standing escalations read the
   * ledger; and the items an earlier pass deferred. Every
   * `reconcileFullEvaluationMs` the pass evaluates every live item, for the inputs only the
   * clock moves. A pass after a heartbeat therefore reads one document and evaluates one item.
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
    // A process's first pass would otherwise open on a cold stand-in cache and project every open
    // document while it holds the coordination lock: warm it first, outside the lock (GY-1042).
    if (!this.lockedReadsWarm) { await warmLockedReads(this.store.pool); this.lockedReadsWarm = true; }
    const fleet = this.reconcileView;
    let all: Work[] = [], candidates: string[] = [], next = 0, documentsRead = 0, full = false;
    const tick: ReconcileTick = { at: new Date().toISOString(), candidates: 0, evaluated: 0, deferred: 0, maxAttempts: 0, ms: 0, writes: 0, lockWaitMs: 0 };
    const view = () => { all = [...fleet.values()].sort((a, b) => a.number - b.number).map(entry => entry.work); };
    // Only the pass's candidates and the rows not settled now are versioned: a settled delivery that stays settled is never visited.
    const versionsOf = async (db: PoolClient) => new Map<string, string>((await db.query(reconcileVersionsSql, [candidates])).rows.map(row => [row.id, row.version]));
    const moved = (versions: Map<string, string>) => [...versions].filter(([id, version]) => fleet.get(id)?.version !== version).map(([id]) => id);
    // Read moved rows again into the view. Read mid-pass, a row another writer moved in a way other items
    // read is owed to them on the next pass; read for the pass's own decision (`owe` false), whether any
    // face moved is returned instead.
    const reread = async (db: PoolClient, ids: string[], { owe = true }: { owe?: boolean } = {}) => {
      if (!ids.length) return false;
      const rows = (await db.query(reconcileRereadSql, [ids])).rows as { id: string; number: string; version: string; document: Work }[];
      documentsRead += rows.length;
      let faceMoved = false;
      for (const row of rows) {
        const face = fleetFace(row.document), before = fleet.get(row.id)?.face;
        if (before !== face) { faceMoved = true; if (owe) this.reconcileFaceMoved = true; }
        fleet.set(row.id, { number: Number(row.number), work: row.document, version: row.version, settled: false, face });
      }
      view();
      return faceMoved;
    };
    let opened = false, decided = false, changed: string[] = [], config = '';
    const pass: ReconcilePass = { fleet, all: () => all, view, versionsOf, moved, reread, lockWait: ms => { tick.lockWaitMs = Math.max(tick.lockWaitMs, Math.round(ms)); } };
    try {
      for (;;) {
        const opening = !opened, evaluating: string[] = [], plans: ReconcilePlan[] = [];
        let gone = 0;
        const finished = await this.store.transaction(async (db, now) => {
          if (opening) {
            // Versions first: a row that moves after them reads as moved, so the first batch reads it again.
            const listed = (await db.query(reconcileRowsSql)).rows as { id: string; number: string; version: string; settled: boolean }[];
            config = stableJson({ ciAppIds: this.ciAppIds });
            // Measured on the clock evaluation reads, so time the gates see pass is what brings the catch-up.
            full = !fleet.size || config !== this.reconcileConfig || !(now.getTime() - this.reconcileFullAt < this.reconcileFullEvaluationMs);
            if (full) this.reconcileFullAt = now.getTime();
            const versions = new Map(listed.map(row => [row.id, row]));
            for (const id of [...fleet.keys()]) if (!versions.has(id)) { fleet.delete(id); this.reconcileFaceMoved = true; }
            changed = listed.filter(row => { const entry = fleet.get(row.id); return !entry || entry.version !== row.version || entry.settled !== row.settled; }).map(row => row.id);
            // Under the lock the pass reads no document whole (GY-1027): a row that moved is held as its
            // stand-in — a settled delivery's summary, an open item's projection, served from the
            // in-process cache — and the first batch reads the open ones whole, outside the lock.
            const rows = await lockedRows(db, []);
            for (const { number, document } of rows) {
              const row = versions.get(document.id), entry = fleet.get(document.id);
              if (!row || entry && entry.version === row.version && entry.settled === row.settled) continue;
              const settled = isSettledSummary(document);
              if (!settled) { fleet.set(document.id, { number, work: document, version: row.version, settled, face: entry?.face ?? '' }); continue; }
              const face = fleetFace(document);
              if (entry?.face !== face) this.reconcileFaceMoved = true;
              fleet.set(document.id, { number, work: document, version: row.version, settled, face });
            }
            view();
            // Items held for a merge inside a direct-merge window are delivered before anything else reads them.
            const swept = await sweepDirectMerges(db, all, await directMergeWindows(db, this.directMergeEnvironment), now);
            if (swept.length) {
              const after = await versionsOf(db);
              for (const work of swept) { const entry = fleet.get(work.id); if (entry) { entry.work = work; entry.version = after.get(work.id) ?? ''; } }
              this.reconcileFaceMoved = true;
              view();
            }
            opened = true;
            return false;
          }
          if (!decided) {
            // The rows the opening held as stand-ins, read whole outside the coordination lock; then the
            // pass decides what it evaluates: the items whose own row moved, plus every live item when
            // another's fleet face moved, and the lapsed, escalated and owed ones.
            const faceMoved = (await reread(db, [...fleet].filter(([, entry]) => !entry.settled && isStandIn(entry.work)).map(([id]) => id), { owe: false })) || this.reconcileFaceMoved;
            this.reconcileFaceMoved = false;
            const live = [...fleet].filter(([, entry]) => !entry.settled).sort(([, a], [, b]) => a.number - b.number).map(([id]) => id);
            const due = full || faceMoved ? new Set(live) : new Set([
              ...changed, ...this.reconcileOwed,
              ...live.filter(id => { const work = fleet.get(id)!.work; return !!work.lease && Date.parse(work.lease.expiresAt) <= now.getTime() || standingEscalations(work).length > 0; }),
            ]);
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
            if (await this.reconcileItem(db, copy, planned.size ? all.map(work => planned.get(work.id) ?? work) : all, now, { dryRun: true })) {
              planned.set(id, copy); plans.push({ id, work: copy, version: entry.version, now });
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
          if (written.faceMoved) this.reconcileFaceMoved = true;
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
    this.reconcileTicks.push(tick);
    if (this.reconcileTicks.length > 20) this.reconcileTicks.shift();
    if (elapsedMs >= this.reconcileSlowWarnMs) console.warn(`reconciliation tick took ${Math.round(elapsedMs)} ms for ${this.lastReconcile.live} item(s) (${tick.evaluated} evaluated, ${tick.writes} written, longest wait for the coordination lock ${tick.lockWaitMs} ms), over the ${this.reconcileSlowWarnMs} ms bound; find what held the coordination lock in the server logs`);
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
      if (await pass.reread(db, pass.moved(await pass.versionsOf(db)))) stale = true;
      const row = (await db.query(reconcileRowLockSql, [plan.id])).rows[0] as { version: string } | undefined;
      if (!row || !pass.fleet.has(plan.id)) return { wrote: false, stale, faceMoved: false, saved: [], apply: () => {} };
      if (row.version !== pass.fleet.get(plan.id)!.version) await pass.reread(db, [plan.id]);
      const entry = pass.fleet.get(plan.id)!;
      let work = plan.work;
      if (!stale && entry.version === plan.version) await this.writeReconciled(db, work, pass.all(), plan.now);
      else {
        // In place: a failure from here on clears the kept view, as every rolled-back write does.
        work = entry.work;
        const wrote = await this.reconcileItem(db, work, pass.all(), now);
        // Items the batch evaluated after this one read it as evaluated: if it came out otherwise, they are evaluated again too.
        if (fleetFace(work) !== fleetFace(plan.work)) stale = true;
        if (!wrote) return { wrote: false, stale, faceMoved: false, saved: [], apply: () => {} };
      }
      const version = ((await db.query('SELECT xmin::text AS version FROM work_items WHERE id = $1', [plan.id])).rows[0] as { version: string }).version, face = fleetFace(work);
      const saved = await savedVersions(db, [work]);
      return { wrote: true, stale, faceMoved: face !== entry.face, saved, apply: () => { Object.assign(entry, { work, version, face }); pass.view(); } };
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
   * One item's reconciliation inside a batch, holding the item's row lock; true when it wrote the
   * item. A `dryRun` (GY-1290) evaluates `work` — a copy — with no lock and writes nothing: true
   * when the evaluation would write, which is all the batch's lock-free phase asks.
   */
  private async reconcileItem(db: PoolClient, work: Work, all: Work[], now: Date, { dryRun = false }: { dryRun?: boolean } = {}): Promise<boolean> {
    // A delivered item is not re-evaluated, but one still holding rows, a merge-queue entry (stored
    // before GY-1236) or an action from before its delivery — every item delivered before GY-185 —
    // is settled here once, and the check that finds nothing to settle costs no evaluation.
    if (work.stage === 'done') {
      const leftover = !!(work as Work & { queue?: unknown }).queue || (work.actionQueue?.actions ?? []).some(row => row.kind !== 'verify-deployment') || (!!work.nextAction && work.nextAction.kind !== 'verify-deployment');
      if (!leftover || !settleDelivered(work, all, now)) return false;
      this.reconcileWrites.set(work, { delivered: true });
      if (!dryRun) await this.writeReconciled(db, work, all, now);
      return true;
    }
    const before = JSON.stringify(work);
    // The liveness invariant (GY-201) is judged on the record as it stood, before this tick
    // touched it, so a violation the tick repairs is recorded rather than silently absorbed.
    const stranded = livenessOf(work, all, now).violation;
    preserveAssignment(work); retainQuarantineFence(work);
    // A recorded server-side renewal fault keeps the lease for one more period (GY-558).
    await this.renewalGrace(db, work, now);
    const leaseLost = !!work.lease && Date.parse(work.lease.expiresAt) <= now.getTime();
    // GitHub executes merges (GY-258): a merge execution recorded before that stays in the
    // ledger, where delivery attribution reads it, and no longer holds the record.
    if (work.mergeExecution) work.mergeExecution = null;
    const ledger: { kind: string; details: Record<string, unknown> }[] = [];
    // The ledger explains a lapse: the epoch's own blocked report or the admin's stopped-worker
    // attestation. It is read only where a lapse or a standing lease-loss makes it relevant.
    const standingLoss = standingEscalations(work).some(entry => entry.trigger === 'lease-loss');
    const attestations = leaseLost || standingLoss ? await readAttestations(db, work.id) : [];
    if (leaseLost) {
      const lost = work.lease!; work.lease = null;
      // A lease that lapses under the epoch it submitted is the expected end of an attempt
      // whose candidate is already bound, and one that lapses under a carried blocked report
      // or after a stopped-worker attestation for its epoch ended because the control plane
      // acted — recorded as history with its cause, never as an incident. Only an epoch with
      // no submission, no blocked report and no attestation vanished, and that still escalates.
      const explained = leaseLapseCause(work, lost, attestations);
      if (explained) ledger.push({ kind: 'lease.expired', details: { owner: lost.owner, epoch: lost.epoch, expiresAt: lost.expiresAt, submission: work.submission, ...explained } });
      else raiseEscalation(work, { trigger: 'lease-loss', reason: leaseLossReason(lost), at: now.toISOString(), actor: 'graphyard' });
      endLapsedAttempt(work, lost, now);
    }
    // The lapse ended the attempt that filed any open scope request: close it, rather than let it refuse the next one (GY-597).
    const closedScope = leaseLost ? closeEndedScopeRequest(work, now, 'lease.expired') : null;
    if (closedScope) ledger.push({ kind: 'scope.closed', details: closedScope });
    // A standing lease-loss for an epoch whose candidate was already bound predates that
    // rule, and one the control plane raised for an epoch whose blocked report or stopped-worker
    // attestation is in the ledger never needed a human either. Settle both here, on deploy and
    // on every later tick, with the note that says why and the attestation it rests on, so the
    // backlog does not wait on one click per item. A control-plane lease-loss whose lost attempt the
    // record shows can no longer act is settled here too, not by an approver round: at once when a
    // newer attempt superseded it (GY-1390), and once it has stood its bound when every attempt has
    // ended with no lease and no fence (GY-1393).
    for (const settled of settleableLeaseLoss(work, attestations, now.getTime())) {
      resolveEscalation(work, settled.escalation.trigger);
      ledger.push({ kind: 'escalation.auto-settled', details: { trigger: settled.escalation.trigger, epoch: settled.epoch, escalation: settled.escalation, note: settled.note, cause: settled.cause, attestation: settled.attestation, submission: work.submission } });
    }
    this.evaluate(work, all, now);
    // Every violation found at the start of the tick is repaired by the evaluation above — the
    // derivation names its successor and the queue opens its row — and the ledger says so.
    if (stranded) ledger.push(livenessRepairEntry(stranded, work, all, now));
    if (!jsonChanged(before, work)) return false;
    this.reconcileWrites.set(work, { ledger });
    if (!dryRun) await this.writeReconciled(db, work, all, now);
    return true;
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
      let reconciliation: MergeReconciliation | null = null; let refusedReconciliation: { decision: string; reasons: string[] } | null = null;
      let operatorAuthorization: OperatorAuthorizedDelivery | null = null;
      if (observation.merged && observation.mergedAt && Number.isFinite(Date.parse(observation.mergedAt))) {
        const providerMergedTime = Date.parse(observation.mergedAt);
        // GitHub merges (GY-1235): no execution or clock offset is issued, so the merge instant is
        // GitHub's own and the cutoff the first instant after it.
        const mergedTime = providerMergedTime;
        const cutoff = providerMergedTime + (/\.\d+Z$/.test(observation.mergedAt) ? 1 : 1000);
        evidenceAsOf = new Date(cutoff - 1).toISOString();
        // The record as it stood immediately before the merge: what the delivery judgement reads,
        // and what a two-party reconciliation re-checks (GY-92). A snapshot whose own observation
        // already reports this pull request merged was written after the merge, whatever its
        // timestamp, and carries the merge's consequences, so it is never read (GY-94).
        // A row stored as a delta (store/snapshot-delta.ts) is read as the document it stands for.
        const past = await documentBefore(db, id, new Date(cutoff),
          record => !(record.observation?.merged && record.observation.candidate?.pr === observation.candidate.pr));
        const historical = past ? historicalAuthorizationRefusals(past, all, observation, cutoff, mergedTime) : ['No record of the item precedes the merge cutoff'];
        // GitHub's merge of a head whose every gate passed on that head is the delivery.
        if (past && !historical.length) { authorizedSnapshot = past; authorizationRevision = past.revision; }
        // An observed merge of a head whose gates had not passed is a recorded violation that every
        // later observation re-derives from immutable history. It is recoverable by a two-party
        // merge decision for this candidate, requested after the merge, applied by an independent
        // approver. The decision does not decide delivery by itself — the record before the cutoff
        // must still show every gate passed for the merged head, apart from what the merge itself
        // wrote — and the delivery then cites that snapshot and the decision. A decision the history refuses
        // is recorded on the item with the reasons, once, so the item says why it cannot be.
        // What the history refuses, an operator may still own (GY-94): a later decision with an
        // admin credential on one side, citing the refusal, delivers the merge as operator-
        // authorized — stating that no execution authorized it and what the record lacked.
        // Inside a direct-merge window the operator owns every merge into the base branch: it is
        // delivered as operator-authorized, naming the setting and who set it (direct-merge.ts).
        const directMerge = !authorizedSnapshot && observation.mergeSha ? coveringWindow(await directMergeWindows(db, this.directMergeEnvironment), providerMergedTime) : null;
        if (directMerge) {
          const snapshot = past ?? structuredClone(work);
          authorizedSnapshot = snapshot; authorizationRevision = snapshot.revision;
          operatorAuthorization = directMergeAuthorization(directMerge, { sha: observation.mergeSha!, at: observation.mergedAt }, snapshot.revision, new Date(cutoff).toISOString(), historical);
        }
        if (!authorizedSnapshot && past && observation.mergeSha) {
          const decisions = await postMergeDecisions(db, work, observation, past.policyRevision, cutoff);
          const refused = new Set<string>((await db.query("SELECT payload->'details'->>'decision' AS decision FROM events WHERE work_id=$1 AND kind='merge.reconciliation.refused'", [id])).rows.map(row => row.decision as string));
          const decision = decisions.filter(entry => !refused.has(entry.id)).at(-1) ?? null;
          const reconcilable = decision ? historicalAuthorizationRefusals(past, all, observation, cutoff, mergedTime, { reconciling: true }) : historical;
          if (decision && !reconcilable.length) {
            authorizedSnapshot = past; authorizationRevision = past.revision;
            reconciliation = { decision: decision.id, requestedBy: decision.requestedBy, requestedAt: decision.requestedAt, approvedBy: decision.approvedBy!, approvedAt: decision.approvedAt!,
              reason: decision.reason, approvalReason: decision.approvalReason ?? '', cutoff: new Date(cutoff).toISOString(), snapshotRevision: past.revision,
              judgement: `Every gate passed for the merged head at ${new Date(cutoff - 1).toISOString()}, the recorded merge cutoff; the merge was held as a violation and is delivered on the approved decision`,
              proofs: [], violation: unauthorizedMergeViolation };
          } else if (decision) {
            const operator = operatorAuthorizing(decision, refused);
            if ('operator' in operator) {
              authorizedSnapshot = past; authorizationRevision = past.revision;
              operatorAuthorization = { decision: decision.id, requestedBy: decision.requestedBy, requestedAt: decision.requestedAt, approvedBy: decision.approvedBy!, approvedAt: decision.approvedAt!,
                reason: decision.reason, approvalReason: decision.approvalReason ?? '', operator: operator.operator, refusedDecision: operator.refusedDecision, unmet: reconcilable,
                cutoff: new Date(cutoff).toISOString(), snapshotRevision: past.revision, execution: null, violation: unauthorizedMergeViolation,
                judgement: `The gates did not pass for merge ${observation.mergeSha.slice(0, 12)}: the record at ${new Date(cutoff - 1).toISOString()}, the recorded merge cutoff, lacked ${reconcilable.join('; ')}; operator ${operator.operator} authorized it by decision ${decision.id}, citing refused reconciliation ${operator.refusedDecision}` };
            } else {
              const reasons = operator.refusal ? [...reconcilable, operator.refusal] : reconcilable;
              const refusal = `${reconciliationRefusalPrefix}${decision.id} refused: ${reasons.join('; ')}`;
              if (!work.violations.includes(refusal)) { work.violations.push(refusal); refusedReconciliation = { decision: decision.id, reasons }; }
            }
          }
        }
      }
      const previousObservation = work.observation;
      // GitHub's queue state is read after the observation, by the check publication; it is kept
      // across observations of the same pull request until that read replaces it.
      if (observation.githubQueue === undefined && previousObservation?.githubQueue && previousObservation.candidate?.pr === observation.candidate.pr) observation.githubQueue = previousObservation.githubQueue;
      // When this pull request's head was first observed (GY-1460): the worker bound reads a push from it, never a poll.
      observeHead(work, observation.candidate, observation.at);
      work.candidate = observation.candidate;
      // A conflict the control plane's own test merge of this head onto this tip found clean is
      // GitHub's stale reading (GY-375): it is stored disproved — the head merges cleanly, which is
      // all GitHub's `mergeable: false` withheld from an open, non-draft pull request — so nothing
      // refreshes, holds or reworks it for that reading again. GitHub's raw reading is kept beside
      // it under `disproved` (GY-390), so the stored observation `graphyard status` prints still
      // carries what GitHub reported.
      const disproved = observation.conflicting ? disprovedConflict(work, observation) : null;
      work.observation = disproved ? withDisprovedConflict(observation, disproved) : observation;
      // A submission recorded without an observation has no files (GY-293): the first observation
      // of that pull request records what its diff changes inside the documentation paths, so a
      // docs diff reads as satisfied rather than waiting for the reviewer to judge it.
      const recorded = work.documentation?.submission;
      if (recorded && recorded.files === null && work.submission?.pr === recorded.pr && observation.candidate.pr === recorded.pr && Array.isArray(observation.files))
        work.documentation = { ...work.documentation!, submission: recordDocumentationSubmission(work.documentation!, recorded, observation.files, recorded.statement, new Date(recorded.at)) };
      // Snapshot all provider review identities after the revision. Approvals in this
      // first observation never count, regardless of clock skew or future reevaluation. A baseline
      // names one pull request: when the candidate moves to another (a reland after a revert), the
      // first observation of the new one is captured again, or no approval there could count (GY-1425).
      if (work.formalReviewResetRequired && reviewProviderOf(work.policy) === 'github' && work.formalReviewBaseline?.pr !== observation.candidate.pr && observation.reviewIds
        && observation.reviewIds.every(id => Number.isSafeInteger(id) && id > 0)
        && observation.reviews.every(r => Number.isSafeInteger(r.id) && observation.reviewIds!.includes(r.id!))) {
        work.formalReviewBaseline = { pr: observation.candidate.pr, policyRevision: work.policyRevision, reviewIds: [...observation.reviewIds] };
      }
      // An approval GitHub withdrew for a merge-base change on this unchanged head binds again
      // before the gates read the record, so no review request is opened for it (GY-127).
      const restoredApproval = observation.merged ? null : this.restoreDismissedApproval(work, now);
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
      // A required check that just failed on this candidate is owed one rerun before it counts, and
      // a rerun that concluded is resolved with its own conclusion (GY-516), before the gates read it.
      const reruns = reconcileCheckReruns(work, this.ciAppIds, this.rerunFailedChecks, now);
      if (reruns.transitions.length || work.checkReruns) work.checkReruns = reruns.reruns;
      for (const transition of reruns.transitions) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', transition.kind,
        JSON.stringify({ details: { ...transition.rerun, at: now.toISOString() } })]);
      // Protected cases (GY-1417) are judged on every observed head, not only at complete: a head pushed
      // since that changes one holds a violation, which no merge passes, until a later head or grant clears it.
      const e2e = [...(Array.isArray(observation.files) ? observation.files : []), ...(observation.scopeFiles ?? []).map(file => file.previousPath ?? '')].some(path => path.startsWith('e2e/'));
      if (!observation.merged) work.violations = [...work.violations.filter(entry => !entry.startsWith(protectedCasePrefix)), ...(e2e ? protectedCaseRefusals(work, observation, await readProtectingGoals(db)) : [])];
      this.evaluate(work, all, now);
      if (restoredApproval) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', 'review.restored',
        JSON.stringify({ details: { ...restoredApproval, baseSha: observation.candidate.baseSha, policyRevision: work.policyRevision } })]);
      if (observation.merged) {
        const violation = unauthorizedMergeViolation;
        if (authorizedSnapshot && observation.mergeSha) {
          // A reconciled delivery is judged at the cutoff, not now: the violation it recovers from
          // leaves the record (the ledger keeps it), and gates that moved since — evidence that
          // expired while the item sat at the merge stage — are reported with the judgement, not
          // recorded as a second violation.
          // An operator-authorized delivery is judged by the operator, not the gates: what the
          // record lacked is on the delivery, and the violation it owns leaves the record the same way.
          if (reconciliation || operatorAuthorization) work.violations = work.violations.filter(entry => entry !== violation && !entry.startsWith(reconciliationRefusalPrefix));
          else if (work.gates.some(g => !g.passed)) work.violations.push('Post-merge checks differ from the recorded authorization; follow-up required');
          work.stage = 'done'; work.stageEnteredAt = now.toISOString();
          const delivery: Work['delivery'] = { mergedAt: observation.mergedAt!, mergeSha: observation.mergeSha, authorizationRevision: authorizationRevision!, ...(evidenceAsOf ? { evidenceAsOf } : {}) };
          work.delivery = reconciliation ? Object.assign(delivery, { reconciliation }) : operatorAuthorization ? Object.assign(delivery, { operatorAuthorization }) : delivery;
          if (reconciliation) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, reconciliation.requestedBy, 'merge.reconciled',
            JSON.stringify({ details: { ...reconciliation, mergeSha: observation.mergeSha, mergedAt: observation.mergedAt, authorizationRevision, evidenceAsOf, gatesNow: work.gates.filter(gate => !gate.passed).map(gate => ({ name: gate.name, reasons: gate.reasons })), at: now.toISOString() } })]);
          if (operatorAuthorization) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, operatorAuthorization.operator, 'merge.operator-authorized',
            JSON.stringify({ details: { ...operatorAuthorization, mergeSha: observation.mergeSha, mergedAt: observation.mergedAt, authorizationRevision, evidenceAsOf, gatesNow: work.gates.filter(gate => !gate.passed).map(gate => ({ name: gate.name, reasons: gate.reasons })), at: now.toISOString() } })]);
          await db.query('DELETE FROM jobs WHERE work_id=$1', [work.id]);
          // Delivered in this transaction: what it still owes is recomputed now and its leftover rows
          // retired, so nothing retries against the delivery (GY-185).
          settleDelivered(work, all, now);
          // The last child of a split parent delivers the parent in the same transaction (GY-1126).
          await deliverSplitParent(db, work, all, now);
        } else {
          if (!work.violations.includes(violation)) work.violations.push(violation);
          if (refusedReconciliation) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', 'merge.reconciliation.refused',
            JSON.stringify({ details: { ...refusedReconciliation, mergeSha: observation.mergeSha, mergedAt: observation.mergedAt, at: now.toISOString() } })]);
        }
      }
      await this.recordDispatch(db, work, now);
      await save(db, work, 'github', 'github.observed', now);
      return work;
    });
  }
}
