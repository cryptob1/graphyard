import { createHash, randomUUID } from 'node:crypto';
import { stableJson } from './model/stable-json.js';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { Store, save, wakeJob, documentBefore, eventWorkSql } from './store.js';
import { compactHeartbeatReceipt } from './store/receipts.js';
import { authorizedForProof, unauthorizedProofs } from './proof-grants.js';
import { workspacePath, pathsOverlap, validBranch } from './workspace.js';
import { activeLease, admin, assertReviewerProfiles, operatorCapability, escalationTriggers, raiseEscalation, releaseLeadHold, resolveEscalation, standingEscalations, attestationFor, attestationKinds, attestationsFromLedger, leaseLapseCause, leaseLossEpoch, leaseLossReason, settleableLeaseLoss, submittedEpoch, type Attestation, requireCurrent, createSchema, criterionSchema, bindingApproval, carriedApproval, currentEvidence, attachedCriteria, exerciseRefusal, proofExerciseSchema, decideCarry, exactApproval, type ApprovalIdentity, type CarriedApproval, deploySmokeProof, deploySmokeRequired, inheritedObligations, pathScopeContains, requiredProofs, resourcesSchema, demand, evaluate, exhaustedReviewerProfiles, proofSchema, reviewerProfileFor, reviewerProfileSchema, reviewProviders, reviewProviderOf, type Criterion, type Evidence, type Principal, type ReviewerApp, type ReviewFailover, type Work, type Observation, type ReviewRequest, type OperatorCapability } from './model.js';
import { Refusal } from './model/refusal.js';
import { resourceConflicts } from './coordination.js';
import { containmentAttestation, containmentSettlementRefusals, containmentVerificationSchema } from './quarantine.js';
import { activeEngineers, delegationLimits, implementerIdentities, leadMay, producerIndependenceRefusal, sessionKind } from './delegation.js';
import { branchContamination, nextQueueEntries, disprovedConflict, currentRestore, decideIdentityCarry, defaultMergeBatchSize, mergeBatchSizeEvent, dismissedApproval, keptTipCarry, onto, pendingRestore, reviewedFilesOf, queueHistoryLimit, queueSequencingReason, reconciliationRefusalPrefix, tipReplacesHead, type BaseRefresh, type GitHubMergeQueueState, type MergeEnqueueRequest, type MergeQueueAction, type QueueSpeculation, type RestoredApproval } from './merge-queue.js';
import { queueEjectionRecord } from './model/queue.js';
import { githubFromEnv, mergeBandQueueDepth } from './github.js';
import { regressionRefusals } from './regression-guard.js';
import { ciFamilyAllows, ciProofFamilies, ciRunBindingSchema, ciRunRefusal, isCiProducer, refuseCiProducer, staleCiAttemptRefusal, type CiRunObservation } from './model/ci-proofs.js';
import { decideScopeRequest, liveScopeWidening, scopeRefusalBlocker, type ScopeDecision } from './model/scope.js';
import { configuredDocumentation, documentationObligation, recordDocumentationSubmission, type DocumentationPolicy } from './model/documentation.js';
import { liveDispatchHandleIds, reconcileAutoDispatch, type DispatchTransition } from './model/dispatch.js';
import { reconcileReviewConflict, type ReviewConflictTransition } from './model/review-conflict.js';
import { nextAction, nextActionKinds, sameAction } from './model/next-action.js';
import { claimCandidatesParams, claimCandidatesSql } from './model/action-candidates.js';
import { claimAction, openActions, reconcileActions, renewClaim, settleAction, settleDelivered, type ActionRow } from './model/actions.js';
import { livenessFallback, livenessOf, livenessRepairEntry } from './model/liveness.js';
import { agentRequestSchema, boundedAgentRequests, deciderFor, expireAgentRequests, leaseHeldRequestTypes, requestResolutionRefusal, resolveSatisfiedScopeRequests, type AgentRequest } from './model/agent-requests.js';
import { recordSession, sessionHandleSchema, sessionObservationFields } from './model/sessions.js';
import { beginAttempt, endAttempt, endLapsedAttempt, recordIntervention, recordRework, recordSubmission } from './pipeline-speed.js';
import { foldDecisions, type Decision } from './model/approval.js';
import { coveringWindow, directMergeAuthorization, directMergeFromEnv, directMergeWindows, sweepDirectMerges, type DirectMergeWindow } from './direct-merge.js';
import { repairAuditEvent, repairScopeRefusal, type RepairAudit } from './master/repair-lane.js';

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
// Longer than acknowledgeContainment's three 30-second HTTP attempts plus retry delays.
export const launchFenceMs = 120_000;
export const containmentScopeSchema = z.object({ unit: z.string().trim().min(1).max(200), pid: z.number().int().positive() }).strict();
const commands = {
  create: createSchema.extend({ reason: z.string().trim().min(1).max(2000).optional() }),
  ready: z.object({ expectedRevision: z.number().int().positive().optional(), reason: z.string().trim().min(1).max(2000).optional() }).strict(),
  requirements: z.object({ expectedPolicyRevision: z.number().int().positive(), reason: z.string().trim().min(1).max(2000), criteria: z.array(criterionSchema).min(1).max(50), dependencies: z.array(z.string().uuid()).max(50), plannedFiles: createSchema.shape.plannedFiles, exclusiveResources: resourcesSchema, producerProofs: createSchema.shape.producerProofs,
    answers: z.object({ epoch: z.number().int().positive(), at: z.string().datetime(), sha: z.string().regex(/^[0-9a-f]{40}$/).nullable().optional() }).strict().optional() }).strict(),
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
  autosettle: z.object({ epoch, settlementHash: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().trim().min(1).max(2000), verification: containmentVerificationSchema }).strict(),
  release: z.object({ epoch }).strict(),
  workspace: z.object({ epoch, host: z.string().trim().min(1).max(200), path: z.string().startsWith('/').max(1000).refine(p => !/[\u0000-\u001f]/.test(p), 'Invalid path').transform(workspacePath), branch: z.string().max(200).refine(validBranch, 'Invalid Graphyard branch name') }).strict(),
  // `documentation` is the worker's explicit statement that the change alters no documented
  // behaviour: the other way the standard documentation criterion is met (model/documentation.ts).
  submit: z.object({ epoch, pr: z.number().int().positive(), documentation: z.string().trim().min(1).max(1000).optional() }).strict(),
  blocked: z.object({ epoch, reason: z.string().max(2000).nullable() }).strict(),
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
  // `scopeFiles` is the producer's declaration of what the proof depends on, in the planned-files
  // scope syntax; the merge queue carries a proof across its own authored tip only inside it.
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
  // The coordinator asking the control plane to restore a branch found carrying another item's
  // unlanded commits (GY-127). It carries no head: the restore is decided from the record and the
  // observation, run by the reconciliation job, and recorded on `baseRefresh.restore`.
  repair: z.object({ reason: z.string().trim().min(1).max(2000) }).strict(),
} as const;
const executorName = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/);
const actionClaimSchema = z.object({
  /** The identity the claim is recorded under; the credential's own principal by default. */
  executor: executorName.optional(),
  host: executorName,
  /** The action kinds this executor can actually run. A kind it cannot run is left for one that can. */
  kinds: z.array(z.enum(nextActionKinds)).min(1).max(nextActionKinds.length).optional(),
  leaseSeconds: z.number().int().min(10).max(900).optional(),
  work: z.string().min(1).max(200).optional(),
}).strict();
const actionSettleSchema = z.object({ executor: executorName.optional(), result: z.enum(['done', 'failed']), reason: z.string().trim().min(1).max(2000) }).strict();
// A renewal carries no result: it says only that the executor named on the claim is still
// inside the handler, and asks for the lease it already holds to run on.
const actionRenewSchema = z.object({ executor: executorName.optional(), leaseSeconds: z.number().int().min(10).max(900).optional() }).strict();
const pullAssignmentSchema = z.object({ host: executorName.optional(), work: z.string().min(1).max(200).optional() }).strict();
// The merge request names the executor instance that recorded it — one daemon process or one
// interactive `master merge` request — bound here to the principal that authenticates it (GY-92).
const executorInstance = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
/** The coordinator's request that GitHub merge exactly this candidate (GY-258): the merge step's whole authority now. */
const mergeEnqueueSchema = z.object({ enqueue: z.literal(true), expectedRevision: z.number().int().positive(), sha, baseSha: sha, policyRevision: z.number().int().positive(), queueTip: sha.optional(), executor: executorInstance.optional() }).strict();
/** Who recorded a merge request: `principal#instance` for an executor that names its instance, else the bare principal. */
export const mergeExecutionOwner = (actor: Pick<Principal, 'id'>, executor?: string | null) => executor ? `${actor.id}#${executor}` : actor.id;
/** The refusal a replay of one idempotency key with different input earns; read back by the pull. */
export const idempotencyMismatch = 'Idempotency key reused with different input';
export type Command = keyof typeof commands;
const operatorCapabilitiesByCommand: Partial<Record<Command, OperatorCapability>> = { create: 'intent:create', ready: 'intent:ready', unblock: 'intent:unblock', requirements: 'policy:requirements', reviewpolicy: 'policy:review-provider' };

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
  if (!request || work.lease?.epoch === request.epoch) return null;
  work.scopeRequest = null;
  if (work.blocker?.startsWith(scopeRefusalBlocker)) work.blocker = null;
  return { epoch: request.epoch, paths: request.paths, requestedBy: request.requestedBy, requestedAt: request.at, decision: request.decision?.state ?? null,
    refusal: request.decision?.state === 'refused' ? request.decision.reason : null, reason: scopeRequestEndedReason, by, at: now.toISOString() };
}
/** The commands that end an attempt, or clear what an ended one left behind, and so close its scope request. */
const attemptEndingCommands = new Set<string>(['submit', 'release', 'rework', 'requirements', 'unblock']);
function applyScopeDecision(work: Work, request: NonNullable<Work['scopeRequest']>, now: Date): ScopeDecision {
  const verdict = decideScopeRequest(work, request);
  const decision: ScopeDecision = { state: verdict.state, reason: verdict.reason, at: now.toISOString(), decidedBy: 'graphyard',
    waitedMs: Math.max(0, now.getTime() - Date.parse(request.at)), paths: verdict.paths, requestedBy: request.requestedBy, requestedAt: request.at, epoch: request.epoch };
  work.scopeDecision = decision;
  // An applied request is answered and cleared, exactly as an operator widening clears it;
  // a refused one stays open, carrying its refusal, because someone still has to decide it.
  work.scopeRequest = verdict.state === 'approved' ? null : { ...request, decision };
  if (verdict.state === 'approved') {
    // Non-weakening intent the item already carried: applied to the live attempt, which
    // keeps its lease and its containment fence exactly as an operator widening would.
    work.plannedFiles = [...new Set([...(work.plannedFiles ?? []), ...verdict.paths])];
    work.policyRevision++;
    work.formalReviewResetRequired = true; work.formalReviewBaseline = undefined;
    work.observation = null; work.mergeAuthorization = null; work.reviewRequest = null;
    if (work.blocker?.startsWith(scopeRefusalBlocker)) work.blocker = null;
  } else {
    // Refused and escalated: the reason is the item's blocker, so the ready gate holds it
    // until an operator decides the scope the item does not already imply.
    work.blocker = `${scopeRefusalBlocker}: ${verdict.reason}`;
    recordIntervention(work, 'blocked');
  }
  return decision;
}

/** The violation an observed merge records when no valid execution covered it. */
export const unauthorizedMergeViolation = 'Merge observed without a prior authorization for this candidate';
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
 * Why the record as it stood before the merge cutoff does not authorize the observed merge, or
 * nothing when it does: exactly the acceptance gate's demand at the cutoff — a bootstrap
 * criterion's deferred proofs excluded, an inherited obligation re-checked — plus the
 * authorization itself, the submitted pull request, every gate, a fresh observation and an
 * authorization that predates the merge. Read for the authorized path and for a reconciliation.
 */
export function historicalAuthorizationRefusals(past: Work, all: Work[], observation: Observation, cutoff: number, mergedTime: number, options: { reconciling?: boolean } = {}): string[] {
  const authorization = past.mergeAuthorization;
  const refusals: string[] = [];
  if (!authorization || authorization.sha !== observation.candidate.sha || authorization.baseSha !== observation.candidate.baseSha || authorization.policyRevision !== past.policyRevision)
    refusals.push(`no merge authorization for ${observation.candidate.sha.slice(0, 12)} on ${observation.candidate.baseSha.slice(0, 12)} at policy revision ${past.policyRevision} stood at the merge cutoff`);
  else if (!(Date.parse(authorization.at) < mergedTime)) refusals.push(`the merge authorization was recorded at ${authorization.at}, not before the merge`);
  if (past.submission?.pr !== observation.candidate.pr) refusals.push(`the record named pull request #${past.submission?.pr ?? 'none'}, not #${observation.candidate.pr}`);
  // A reconciliation judges the merge that happened, so nothing that merge itself wrote can refuse
  // it (GY-94): the unauthorized-merge violation it exists to clear, a refusal of an earlier
  // decision, and a merge gate that only reports the queue position the merge left behind.
  const circular = (violation: string) => options.reconciling && (violation === unauthorizedMergeViolation || violation.startsWith(reconciliationRefusalPrefix));
  const sequencingOnly = (gate: Work['gates'][number]) => options.reconciling && gate.name === 'merge' && gate.reasons.length > 0 && gate.reasons.every(queueSequencingReason);
  for (const gate of past.gates.filter(gate => !gate.passed && !sequencingOnly(gate))) refusals.push(`gate ${gate.name} had not passed: ${gate.reasons.join('; ')}`);
  for (const violation of past.violations.filter(violation => !circular(violation))) refusals.push(`violation stood: ${violation}`);
  const asOf = new Date(cutoff - 1);
  for (const proof of requiredProofs(past, all)) if (!currentEvidence(past, proof, asOf)) refusals.push(`required proof ${proof} had no live trusted evidence at ${asOf.toISOString()}`);
  if (!past.observation || !(cutoff - Date.parse(past.observation.at) < 120_000)) refusals.push('the last GitHub observation before the merge was older than two minutes');
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
  // Auto-dispatch transitions the last evaluation of a document produced, written to the ledger
  // by the transaction that persists it. Keyed by the object, so a probe clone records nothing.
  private dispatchTransitions = new WeakMap<Work, DispatchTransition[]>();
  private conflictTransitions = new WeakMap<Work, ReviewConflictTransition[]>();
  /** This repository's documentation policy (GY-215): the deployed GRAPHYARD_DOCUMENTATION, or the default. */
  documentation: DocumentationPolicy = configuredDocumentation();
  /**
   * How many consecutive queue entries one combined tip validates (GY-330): the master's
   * `mergeQueue.batchSize` as it last published it (POST /api/merge-queue), read back from the
   * installation ledger by `loadMergeBatchSize`, else the default.
   */
  mergeBatchSize = defaultMergeBatchSize;
  /** Reads the batch size the master last published from the installation ledger. */
  async loadMergeBatchSize() {
    const row = (await this.store.pool.query('SELECT (payload->>\'batchSize\')::int AS size FROM events WHERE work_id IS NULL AND kind=$1 ORDER BY seq DESC LIMIT 1', [mergeBatchSizeEvent])).rows[0];
    this.mergeBatchSize = Number.isSafeInteger(row?.size) && row.size >= 1 ? row.size : defaultMergeBatchSize;
    return this.mergeBatchSize;
  }
  // The launch fence is a deployment-independent safety default; only tests shorten it.
  constructor(public store: Store, public ciAppIds: number[] = [15368], public leaseSeconds = 120, public repository = process.env.GITHUB_REPOSITORY ?? '', public launchFence = launchFenceMs) {}
  private async observeSubmission(actor: Principal, id: string | null, data: { epoch: number; pr: number }, key: string): Promise<Observation | null> {
    if (this.submissionObserver === undefined) { const github = await githubFromEnv(); this.submissionObserver = github ? (probe, peers) => github.observe(probe, peers) : null; }
    if (!this.submissionObserver || !id) return null;
    // A replayed submission returns its receipt; it must not depend on the provider again.
    if ((await this.store.pool.query('SELECT 1 FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rowCount) return null;
    const all = await this.store.list();
    const work = all.find(w => w.id === id || w.key === id);
    if (!work || work.stage === 'done' || !work.workspaces.some(w => w.epoch === data.epoch)) return null;
    // Every item goes with it: the landing check reads other items' unlanded candidates (GY-97).
    return this.submissionObserver({ ...work, submission: { epoch: data.epoch, pr: data.pr } }, all);
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
  async execute(actor: Principal, command: Command, id: string | null, input: unknown, key: string, context: { observation?: Observation; ciRun?: CiRunObservation | null } = {}) {
    demand(Object.hasOwn(commands, command), 'Unknown command', 404);
    // Leads coordinate through rulings; no lifecycle command is lead-permitted.
    demand(actor.role !== 'slice-lead' || leadMay(command), 'Slice leads cannot perform lifecycle mutations', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const data: any = commands[command].parse(input);
    const fingerprint = createHash('sha256').update(JSON.stringify({ command, id, data })).digest('hex');
    // Provider I/O stays outside the coordination transaction.
    const observation = command === 'submit' ? context.observation ?? await this.observeSubmission(actor, id, data, key) : null;
    return this.store.transaction(async (db, now) => {
      if (actor.role === 'operator-agent') {
        demand(this.operatorAuthorizer, 'Operator-agent authorization is unavailable', 503);
        actor = await this.operatorAuthorizer(db, now, actor);
      }
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) {
        demand(receipt.fingerprint === fingerprint, idempotencyMismatch);
        if (actor.role === 'operator-agent') authorizeOperatorCommand(actor, command, data, receipt.result as Work, this.repository);
        return receipt.result as Work;
      }
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document);
      let work = all.find(w => w.id === id || w.key === id);
      const before = work ? structuredClone(work) : null;
      // Set by the requirements command: the revision was a purely additive planned-files
      // widening applied to a live attempt, recorded in history beside the intent.
      let widening = false;
      // Set by the autoscope command: how the control plane decided the open scope request.
      let decision: ScopeDecision | null = null;
      if (command === 'create') {
        if (actor.role === 'operator-agent') {
          authorizeOperatorCommand(actor, command, data, undefined, this.repository);
        } else admin(actor);
        if (reviewProviderOf(data.policy) === 'agent') assertReviewerProfiles(data.policy.reviewerProfiles, this.reviewerApps, this.controlPlaneAppId);
        demand(data.dependencies.every((dep: string) => all.some(w => w.id === dep)), 'Unknown dependency');
        demand(new Set(data.criteria.map((ac: { id: string }) => ac.id)).size === data.criteria.length, 'Criterion IDs must be unique');
        // A merge-path repair (GY-406) plans only files within the merge path.
        const repairScope = repairScopeRefusal(data); demand(!repairScope, repairScope!, 422);
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
      demand(work, 'Work item not found', 404);
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
      if (command === 'repair') {
        demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
        demand(work.submission && !work.observation?.merged && work.stage !== 'done', 'Open submitted work is required');
        demand(work.observation?.candidate.sha === work.candidate?.sha && work.observation?.prState === 'open' && work.observation.draft === false, 'An open pull request observed at the current head is required');
        demand(!work.queue, `${work.key} is a live merge-queue entry; its tip is rebuilt from its own reviewed head when the queue changes, and is not repaired by hand`);
        // Decided from the record and the observation alone; the command asserts nothing.
        const contamination = branchContamination(work, all);
        demand(contamination, `${work.key} head ${work.candidate!.sha.slice(0, 12)} carries no other item's unlanded commits; there is nothing to repair`);
        demand(!pendingRestore(work), `A repair of ${work.key} head ${work.candidate!.sha.slice(0, 12)} is already requested; the reconciliation job runs it`);
        const performed = currentRestore(work);
        demand(!performed || performed.restore!.contaminated !== work.candidate!.sha || performed.restore!.outcome !== 'unrepairable',
          `${work.key} head ${work.candidate!.sha.slice(0, 12)} was found unrepairable: the foreign commits sit under something the record cannot move; request rework instead`);
        const candidate = work.candidate!, observation = work.observation!;
        work.baseRefresh = { from: { sha: candidate.sha, baseSha: candidate.baseSha }, base: observation.baseTip ?? candidate.baseSha, baseTree: observation.baseTree ?? '', policyRevision: work.policyRevision, at: now.toISOString(),
          head: null, conflict: null, merge: null, carry: null,
          restore: { contaminated: candidate.sha, foreign: contamination!.foreign, own: contamination!.own, cause: 'repair', requested: { by: actor.id, at: now.toISOString(), reason: data.reason },
            reason: `head ${candidate.sha.slice(0, 12)} carries the unlanded commits of ${contamination!.foreign.join(', ')} (${contamination!.source.join(' and ')})`, performedAt: null, outcome: null } };
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
        if (actor.role !== 'operator-agent') admin(actor);
        demand(!work.observation?.merged, 'Merged work requires a follow-up task');
        // A purely additive planned-files widening is non-weakening intent: applied to a live
        // attempt it keeps the lease (and any containment fence) so the worker never hands the
        // item back. Every other revision under a live lease or quarantine is refused exactly
        // as before.
        const leaseLive = !!work.lease && Date.parse(work.lease.expiresAt) > now.getTime();
        widening = liveScopeWidening({ criteria: work.criteria, dependencies: work.dependencies, plannedFiles: work.plannedFiles ?? [], exclusiveResources: work.exclusiveResources, producerProofs: work.producerProofs }, data);
        if (!widening) {
          demand(!work.containmentQuarantine, `Task is quarantined by unverified containment from epoch ${work.containmentQuarantine?.epoch}; requirements remain immutable until settlement or stopped-worker recovery`);
          demand(!leaseLive, 'Stop and release the active worker before revising requirements');
        }
        demand(data.expectedPolicyRevision === work.policyRevision, 'Policy revision changed; reload before revising');
        // A widening that answers one attempt's scope request (the loop's, on a review finding)
        // holds only while that request is open, its attempt holds a live lease and the head the
        // findings were read for is still the candidate: a claim, a lease end or a push changes
        // one of those without a new policy revision, so a widening decided on reads made before
        // that is moot and refused here, in the same transaction.
        if (data.answers) {
          demand(widening, 'Only an additive planned-files widening answers a scope request');
          demand(work.scopeRequest?.epoch === data.answers.epoch && work.scopeRequest?.at === data.answers.at, 'The scope request this widening answers is no longer open');
          demand(leaseLive && work.lease!.epoch === data.answers.epoch, `Epoch ${data.answers.epoch}, which asked for this scope, no longer holds the lease`);
          // Grounds read against one head (review findings) are another head's after a push; an
          // approver's judgement of the worker's reason and the criteria (GY-176) names no head.
          if (data.answers.sha !== undefined) demand((work.candidate?.sha ?? null) === data.answers.sha, `The findings this widening rests on were read for ${data.answers.sha?.slice(0, 12) ?? 'no head'}, which is no longer the item's head`);
        }
        demand(new Set(data.criteria.map((ac: { id: string }) => ac.id)).size === data.criteria.length, 'Criterion IDs must be unique');
        if (actor.role === 'operator-agent') {
          demand(work.criteria.every(previous => data.criteria.some((next: typeof previous) => next.id === previous.id && next.text === previous.text && JSON.stringify(next.proofs) === JSON.stringify(previous.proofs))), 'Operator agents may add requirements but cannot weaken or rewrite existing criteria');
          demand(work.dependencies.every(dependency => data.dependencies.includes(dependency)), 'Operator agents cannot remove dependencies');
          demand(work.plannedFiles.every(path => data.plannedFiles.includes(path)), 'Operator agents cannot remove planned-file containment');
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
        if (retired.length || narrowed.length) raiseEscalation(work, { trigger: 'requirement-weakening', reason: `Requirement revision retires ${retired.map(ac => ac.id).join(', ') || 'no criterion'} and narrows proofs for ${narrowed.map(ac => ac.id).join(', ') || 'no criterion'}`, at: now.toISOString(), actor: actor.id });
        work.retiredCriterionIds = [...(work.retiredCriterionIds ?? []), ...work.criteria.filter(ac => !data.criteria.some((next: { id: string }) => next.id === ac.id)).map(ac => ac.id)];
        work.criteria = revised;
        work.dependencies = data.dependencies; work.plannedFiles = data.plannedFiles; work.exclusiveResources = data.exclusiveResources; work.producerProofs = data.producerProofs;
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
        }
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
        work.scopeRequest = null;
        expireAgentRequests(work, now, `epoch ${work.epoch} claimed the item; a request from an attempt that ended is asked afresh`);
        work.implementers = [...new Set([...implementerIdentities(work), actor.id])];
        work.lastAssignment = { owner: actor.id, epoch: work.epoch, claimedAt: now.toISOString(), ...(actor.displayName ? { displayName: actor.displayName } : {}), ...(actor.runtime ? { runtime: actor.runtime } : {}) };
        work.lease = { owner: actor.id, epoch: work.epoch, expiresAt: new Date(now.getTime() + this.leaseSeconds * 1000).toISOString() };
        beginAttempt(work, work.lease, now);
      }
      // The lease a worker submitted under ended at that submission. A supervisor that keeps
      // renewing it is told so, rather than left to read the loss as a superseded epoch.
      if ((command === 'heartbeat' || command === 'release') && !work.lease && submittedEpoch(work, data.epoch))
        demand(false, `Implementation lease for epoch ${data.epoch} ended when ${work.key} was submitted; stop heartbeating after complete`);
      if (['heartbeat', 'release', 'workspace', 'submit', 'blocked', 'scope', 'quarantine', 'launch'].includes(command)) activeLease(work, actor, data.epoch, now);
      if (command === 'heartbeat') work.lease!.expiresAt = new Date(now.getTime() + this.leaseSeconds * 1000).toISOString();
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
      if (command === 'release') { endAttempt(work, data.epoch, 'released', now); work.lease = null; }
      // A blocked report is a hand-off to the master or operator; the item's timeline counts it.
      if (command === 'blocked') { work.blocker = data.reason; if (data.reason) recordIntervention(work, 'blocked'); }
      if (command === 'scope') {
        const asks = data.paths.length || data.remove?.length || data.criteria?.length;
        if (!asks) {
          demand(work.scopeRequest, 'No scope request is open for this attempt');
          work.scopeRequest = null;
          // Withdrawing the ask withdraws the refusal it earned; the item is no longer blocked on scope.
          if (work.blocker?.startsWith(scopeRefusalBlocker)) work.blocker = null;
        } else {
          const outside = data.paths.filter((path: string) => !(work.plannedFiles ?? []).some(planned => pathScopeContains(planned, path)));
          demand(outside.length || data.remove?.length || data.criteria?.length, 'Every named path is already inside plannedFiles; no scope request is needed');
          // A fresh ask is undecided by construction: the loop decides it on its next cycle, and
          // a standing refusal keeps blocking the item until that decision replaces it.
          work.scopeRequest = { epoch: data.epoch, paths: data.paths, reason: data.reason, requestedBy: actor.id, at: now.toISOString(),
            ...(data.remove?.length ? { remove: data.remove } : {}), ...(data.criteria?.length ? { criteria: data.criteria } : {}) };
        }
      }
      if (command === 'autoscope') {
        // The loop asks, the control plane decides. The verdict is recomputed here from the item's
        // own criteria and this repository's documentation rule, so no caller — not even the
        // coordinator that asked — can assert a widening the item does not already imply.
        demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
        const request = work.scopeRequest;
        demand(request, 'No scope request is open for this item', 404);
        demand(request!.epoch === data.epoch, 'Scope request belongs to another attempt; reload before deciding');
        // A refusal may be decided again when the rules as they stand now would approve it; an
        // approval never is, and a refusal the current rules still give is not rewritten.
        demand(!request!.decision || request!.decision.state === 'refused', 'This scope request was already decided');
        demand(!request!.decision || decideScopeRequest(work, request!).state === 'approved', 'The current rules still refuse this scope request');
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
            work.scopeRequest = { epoch: data.epoch, paths: data.paths, reason: data.reason, requestedBy: actor.id, at: now.toISOString() };
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
        work.workspaces.push({ ...data, owner: actor.id });
      }
      if (command === 'submit') {
        demand(work.workspaces.some(w => w.epoch === data.epoch), 'Register the assignment workspace first');
        demand(!all.some(w => w.id !== work!.id && w.submission?.pr === data.pr), 'Pull request is already linked to another task');
        demand(!work.submission || work.submission.pr === data.pr, 'A submitted task cannot switch pull requests');
        if (observation) {
          demand(observation.candidate.pr === data.pr, 'Observed pull request does not match the submission');
          demand(work.workspaces.some(w => w.epoch === data.epoch && w.branch === observation.candidate.branch), 'PR branch does not match the assigned workspace');
          const regressions = regressionRefusals(work, observation, all);
          demand(!regressions.length, `Submission refused for ${work.key}: ${regressions.join('; ')}`);
        }
        work.submission = { epoch: data.epoch, pr: data.pr };
        if (work.documentation) work.documentation = { ...work.documentation, submission: recordDocumentationSubmission(work.documentation, work.submission, observation?.files ?? null, data.documentation, now) };
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
        const evidence: Evidence = { ...data, id: randomUUID(), producer: actor.id, trusted: trusted && !unexercised, at: now.toISOString(), ...(ciRun ? { ciRun } : {}), ...(unexercised ? { unexercised } : {}) };
        if (unexercised) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, actor.id, 'evidence.exercise.refused',
          JSON.stringify({ details: { proof: data.proof, criteria: attachedCriteria(work, all, data.proof), behaviour: data.exercise?.behaviour ?? null, sha: data.sha, reason: unexercised } })]);
        work.evidence.push(evidence);
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
        : command === 'autoscope' ? { ...data, decision, before: { plannedFiles: before?.plannedFiles ?? [], blocker: before?.blocker ?? null } }
        : actor.role === 'operator-agent' ? { before, intent: data, reason: data.reason ?? null, ...(command === 'requirements' ? { liveScopeWidening: widening } : {}), ...(closedScope ? { closedScopeRequest: closedScope } : {}) }
        : closedScope ? { ...data, closedScopeRequest: closedScope } : data);
      if (work.submission && !postDeployment && !deliveredSessionClosure && !['heartbeat', 'release', 'claim', 'workspace'].includes(command)) await wakeJob(db, work.id);
      // A renewal's replay needs only the lease, not a whole document per renewal.
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(command === 'heartbeat' ? compactHeartbeatReceipt(work) : work)]);
      return work;
    // A worker's lease renewal takes the reserved connection (GY-274): however busy the pool is, a
    // live worker is never stopped because its heartbeat could not reach the database.
    }, command === 'heartbeat' ? { lane: 'lease' } : undefined);
  }

  /** The one item holding action row `id`, found by containment rather than by loading every document. */
  private async actionOwner(db: { query: (text: string, values: unknown[]) => Promise<{ rows: { document: Work }[] }> }, id: string): Promise<Work | undefined> {
    return (await db.query(`SELECT document FROM work_items WHERE document->'actionQueue'->'actions' @> jsonb_build_array(jsonb_build_object('id', $1::text)) ORDER BY number LIMIT 1`, [id])).rows[0]?.document;
  }
  /**
   * Claim the next action for a stateless executor.
   *
   * The executor names itself and its host, and the kinds it can actually run; the control plane
   * hands back the oldest open row it can take, leased for a bounded time. Two executors on two
   * hosts calling this at the same instant are serialized by the coordination lock, so the first
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
      if (work!.stage === 'done') settleDelivered(work!, (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document.id === work!.id ? work! : r.document as Work), now);
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
      const work = await this.actionOwner(db, id);
      demand(work, 'Action is not open on any work item', 404);
      const row = renewClaim(work!, id, { executor: data.executor ?? actor.id, principal: actor.id }, now, data.leaseSeconds ? data.leaseSeconds * 1000 : undefined);
      // A renewal is a fact about a claim, not a decision: it is persisted without re-evaluating
      // the item and without an event of its own, so a long handler costs one update per interval.
      await db.query('UPDATE work_items SET document=$2 WHERE id=$1', [work!.id, JSON.stringify(work)]);
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
    const all = await this.store.list();
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
   */
  async resyncWork(actor: Principal, id: string) {
    demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
    const before = (await this.store.list()).find(item => item.id === id || item.key === id);
    demand(before, `Unknown work item ${id}`, 404);
    // The observation job only exists for an item with a candidate to observe; waking it for one
    // without a submission would schedule a read of nothing.
    if (before!.submission) await this.store.transaction(async db => { await wakeJob(db, before!.id); });
    await this.reconcile();
    const work = (await this.store.list()).find(item => item.id === before!.id)!;
    return { work, observationScheduled: !!before!.submission, revision: work.revision, changed: work.revision !== before!.revision };
  }
  /**
   * GitHub executes merges; Graphyard only gates them (GY-258). The coordinator's merge step records
   * a request that GitHub merge exactly this candidate — refused unless every gate passes for it
   * now — and wakes the item's observation job, whose control-plane App publishes the check and
   * enqueues the pull request. No execution, window or clock wait is issued: GitHub merges only a
   * head whose required check the control plane published as passed, and dequeues on withdrawal.
   */
  async requestEnqueue(actor: Principal, id: string, input: unknown, key: string) {
    demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    demand((input as { enqueue?: unknown } | null)?.enqueue === true, 'Graphyard grants no merge executions: GitHub executes merges, and the merge step requests one with enqueue: true (merge protocol 3)', 400);
    const data = mergeEnqueueSchema.parse(input);
    const fingerprint = createHash('sha256').update(JSON.stringify({ command: 'merge.enqueue', id, data })).digest('hex');
    return this.store.transaction(async (db, now) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) { demand(receipt.fingerprint === fingerprint, idempotencyMismatch); return receipt.result; }
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document);
      const work = all.find(item => item.id === id || item.key === id);
      demand(work, 'Work item not found', 404);
      demand(data.expectedRevision <= work.revision, 'Task changed before the merge was requested; retry');
      demand(data.queueTip === undefined || work.queue?.speculation?.tip === data.queueTip && work.queue.speculation.base === data.baseSha, 'Task changed before the merge was requested; retry');
      this.evaluate(work, all, now);
      const authorization = work.mergeAuthorization;
      const age = work.observation ? now.getTime() - Date.parse(work.observation.at) : NaN;
      demand(work.stage === 'merge' && work.gates.every(gate => gate.passed) && !work.violations.length && authorization
        && authorization.sha === data.sha && authorization.baseSha === data.baseSha && authorization.policyRevision === data.policyRevision
        && work.candidate?.sha === data.sha && work.candidate.baseSha === data.baseSha && Number.isFinite(age) && age >= 0 && age < 120_000,
      'Merge authorization is no longer current');
      const request: MergeEnqueueRequest = { sha: data.sha, baseSha: data.baseSha, policyRevision: data.policyRevision, requestedBy: mergeExecutionOwner(actor, data.executor), at: now.toISOString() };
      const standing = await this.enqueueRequest(work.id, db);
      if (!standing || standing.sha !== request.sha || standing.baseSha !== request.baseSha || standing.policyRevision !== request.policyRevision)
        await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, actor.id, 'merge.enqueue.requested', JSON.stringify({ details: request })]);
      await wakeJob(db, work.id);
      const result = { key: work.key, revision: work.revision, enqueue: standing && standing.sha === request.sha && standing.baseSha === request.baseSha && standing.policyRevision === request.policyRevision ? standing : request };
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
      return result;
    });
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
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document);
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
   * Records the Graphyard-published speculative tip this candidate must now be validated on, and
   * decides — once, from the record as it stands and GitHub's account of the tip — which of the
   * replaced head's bindings carry to it. A carried binding and a re-required one are both
   * written to the ledger with the reason, so the audit trail says why no fresh round was needed.
   */
  async bindSpeculativeTip(id: string, expectedRevision: number, speculation: QueueSpeculation, jobToken: string) {
    return this.store.transaction(async (db, now) => {
      const job = (await db.query('SELECT 1 FROM jobs WHERE work_id=$1 AND token=$2 AND locked_until>$3', [id, jobToken, now])).rows[0];
      requireCurrent(job, 'Integration job lease expired or superseded');
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document);
      const work = all.find(w => w.id === id);
      requireCurrent(work && work.revision === expectedRevision && work.stage !== 'done' && !work.observation?.merged, 'Task changed while the speculative tip was built');
      requireCurrent(work.queue && speculation.policyRevision === work.policyRevision, 'Queue entry or policy changed while the speculative tip was built');
      // A tip re-bound to a tree-identical prediction keeps the carry it was first bound with (GY-100).
      const kept = keptTipCarry(work, speculation);
      const carry = kept === undefined ? this.decideTipCarry(work, all, speculation, now) : kept;
      work.queue!.speculation = { ...speculation, carry };
      // The prediction names what the tip was built behind and from, so the restore an ejection
      // owes (see merge-queue.ts ejectedTipRestore) reads it from the record alone.
      work.queueHistory = [...(work.queueHistory ?? []), { at: now.toISOString(), event: 'predicted' as const, sequence: work.queue!.sequence, tip: speculation.tip,
        predecessors: speculation.predecessors, from: speculation.reviewedHead ?? speculation.merge?.from ?? speculation.tip }].slice(-queueHistoryLimit);
      this.evaluate(work, all, now);
      if (carry && kept === undefined) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', 'queue.carry', JSON.stringify({ details: { ...carry, merge: speculation.merge ?? null } })]);
      await this.recordDispatch(db, work, now);
      await save(db, work, 'graphyard', 'queue.predicted', now, { tip: speculation.tip, base: speculation.base, ref: speculation.ref, predecessors: speculation.predecessors, trigger: speculation.trigger ?? null,
        ...(kept !== undefined && speculation.carriedBase ? { carriedBase: speculation.carriedBase } : {}),
        ...(carry ? { carry: { approval: carry.approval.carried ? 'carried' : 'required', evidence: Object.fromEntries(carry.evidence.map(entry => [entry.proof, entry.carried ? 'carried' : 'required'])) } } : {}) });
      await wakeJob(db, work.id);
      return work;
    });
  }
  /** The carry decision for a tip that replaced the candidate's head; see model/carry.ts for the rule. */
  private decideTipCarry(work: Work, all: Work[], speculation: QueueSpeculation, now: Date) {
    const candidate = work.candidate!;
    const aheadKey = speculation.predecessors.at(-1) ?? null;
    const ahead = aheadKey ? all.find(item => item.key === aheadKey) : undefined;
    // The base branch is validated by definition. A queue entry is validated when every gate
    // passes on exactly the tip predicted here, the merge gate refusing only for its turn.
    const validated = !aheadKey ? true : !!ahead && ahead.stage === 'merge' && ahead.candidate?.sha === speculation.base && !ahead.violations.length
      && ahead.gates.every(gate => gate.passed || gate.name === 'merge' && gate.reasons.every(queueSequencingReason));
    // A tip is built from the item's own reviewed head (GY-127): the replaced head when the worker
    // pushed it, or the head under the tip it replaces. The bindings carried are the ones that
    // bind the replaced head now — exact on it, or already carried onto it. `from` is that
    // reviewed head in every case; a record that predates `reviewedHead` names the merge's own.
    const from = { sha: speculation.reviewedHead ?? speculation.merge?.from ?? candidate.sha, baseSha: candidate.baseSha };
    // The record's own binding first; the publisher's fresh read of the replaced tip's approval
    // (GY-519) fills in when the stored observation predates it — a republication must never drop
    // an approval of the patch it re-shows just because the observation had not caught up.
    const approval = bindingApproval(work) ?? this.publicationApproval(work, speculation);
    // What the reviewer read is the reviewed head's own change, never the replaced tip's pull
    // request diff: GitHub lists that against the base branch, so a tip built behind an entry that
    // has not landed lists the entry's files too, and a rebuild after the entry is ejected would
    // then be refused for files nobody reviewed. An approval read off the replaced tip itself
    // (GY-519) was given on that tip's diff, so the tip's own recorded files are what it read.
    const reviewedFiles = reviewedFilesOf(work, from.sha)
      ?? (approval?.sha === candidate.sha ? reviewedFilesOf(work, candidate.sha) : null);
    const input = {
      from, to: { sha: speculation.tip, baseSha: speculation.base }, policyRevision: work.policyRevision, at: now.toISOString(),
      predecessor: { key: aheadKey, validated }, reviewedFiles: reviewedFiles ?? [],
      approval, proofs: requiredProofs(work, all).map(proof => ({ proof, evidence: currentEvidence(work, proof, now) })),
    };
    // A tip that is the reviewed head itself — no merge, because the head already contained its
    // predicted base — is decided as an identity carry on the files the predicted base changed,
    // never refused for lacking a merge (see merge-queue.ts decideIdentityCarry).
    const carry = !speculation.merge && speculation.tip === from.sha ? decideIdentityCarry({ ...input, baseChanges: speculation.baseChanges })
      : decideCarry({ ...input, merge: speculation.merge, app: this.controlPlaneAppId ? `control-plane (App ${this.controlPlaneAppId})` : 'control-plane' });
    // A binding carries only from the head the tip was built from. One given on another commit
    // binds it anyway when a recorded decision already carried it onto that head — or, for an
    // approval of the tip being replaced (GY-519), when the replaced tip was itself the control
    // plane's own Graphyard-authored publication over the same author head with the same patch:
    // the reviewer judged exactly the change this tip re-shows.
    const reaches = onto(work, from.sha);
    const bound = !!approval && approval.sha !== from.sha && (reaches.some(entry => entry.approval.carried && entry.approval.originalSha === approval.sha)
      || this.replacedTipOfAuthor(work, from.sha) && (approval.sha === candidate.sha
        || onto(work, candidate.sha).some(entry => entry.approval.carried && entry.approval.originalSha === approval.sha)));
    if (carry.approval.carried && approval && approval.sha !== from.sha && !bound) {
      carry.approval = { carried: false, reason: `the approval by ${approval.reviewer} was given on ${approval.sha.slice(0, 12)}, not on the reviewed head ${from.sha.slice(0, 12)} tip ${speculation.tip.slice(0, 12)} was built from, and no recorded decision carried it there; a fresh independent approval of ${speculation.tip.slice(0, 12)} is required` };
    }
    if (carry.approval.carried && reviewedFiles === null) {
      carry.approval = { carried: false, reason: `the files the reviewed head ${from.sha.slice(0, 12)} changed are not recorded, so its independence from what the predicted base changed cannot be shown; a fresh independent approval of ${speculation.tip.slice(0, 12)} is required` };
    }
    carry.evidence = carry.evidence.map(entry => {
      const evidence = entry.carried ? work.evidence.find(item => item.id === entry.evidenceId) : undefined;
      if (!evidence || evidence.sha === from.sha || reaches.some(decision => decision.evidence.some(carried => carried.carried && carried.evidenceId === evidence.id))) return entry;
      return { ...entry, carried: false, reason: `evidence ${evidence.id} was produced on ${evidence.sha.slice(0, 12)}, not on the reviewed head ${from.sha.slice(0, 12)} tip ${speculation.tip.slice(0, 12)} was built from, and no recorded decision carried it there; fresh evidence for ${speculation.tip.slice(0, 12)} is required` };
    });
    return carry;
  }
  /**
   * The approval of the tip being replaced that the publisher read from GitHub immediately before
   * the force-push (GY-519), as the binding the carry decides from when the record has none of its
   * own: the stored observation can predate the approval, and without it a republication would
   * re-require a review of the patch being republished. Only a GitHub review provider binds it.
   */
  private publicationApproval(work: Work, speculation: QueueSpeculation): ApprovalIdentity | null {
    const observed = speculation.observedApproval;
    if (!observed || !work.policy.review || reviewProviderOf(work.policy) !== 'github') return null;
    return { provider: 'github', reviewer: observed.reviewer, sha: observed.sha, ...(observed.reviewId !== undefined ? { reviewId: observed.reviewId } : {}) };
  }
  /**
   * Whether the head this tip replaces (the candidate as the record still binds it) was itself the
   * control plane's own Graphyard-authored tip over `authorHead` (GY-519): the record names the
   * same author head under it, GitHub's account recorded at its publication shows the App authored
   * it over exactly that head and its predicted base without a conflict, and the patch-id it was
   * approved under is the one on record wherever both sides could be read.
   */
  private replacedTipOfAuthor(work: Work, authorHead: string): boolean {
    const candidate = work.candidate!, previous = work.queue?.speculation;
    if (!previous || previous.tip !== candidate.sha || candidate.sha === authorHead || previous.policyRevision !== work.policyRevision) return false;
    if ((previous.reviewedHead ?? previous.merge?.from ?? null) !== authorHead) return false;
    const merge = previous.merge;
    if (!merge || merge.from !== authorHead || !merge.authoredByApp || merge.conflicts) return false;
    const parents = new Set(merge.parents);
    if (parents.size !== 2 || !parents.has(authorHead) || !parents.has(previous.base)) return false;
    return !merge.diff?.reviewed || !merge.diff?.tip || merge.diff.reviewed === merge.diff.tip;
  }
  /**
   * Records what the control plane did about a base branch that moved under an in-flight
   * candidate: the head it republished on the new base, or the conflict that stopped it. The
   * carry is decided here, once, from the record as it stands and GitHub's account of the merge —
   * the same rule the merge queue uses for its own tip — so a clean advance costs no rework round
   * and a conflicting one carries nothing. The worker asserts none of it and never pushes for it.
   */
  async bindBaseRefresh(id: string, expectedRevision: number, refresh: BaseRefresh, jobToken: string) {
    return this.store.transaction(async (db, now) => {
      const job = (await db.query('SELECT 1 FROM jobs WHERE work_id=$1 AND token=$2 AND locked_until>$3', [id, jobToken, now])).rows[0];
      requireCurrent(job, 'Integration job lease expired or superseded');
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document);
      const work = all.find(w => w.id === id);
      requireCurrent(work && work.revision === expectedRevision && work.stage !== 'done' && !work.observation?.merged, 'Task changed while the base was refreshed');
      requireCurrent(!work.queue && refresh.policyRevision === work.policyRevision
        && work.candidate?.sha === refresh.from.sha && work.candidate.baseSha === refresh.from.baseSha, 'Candidate, queue entry or policy changed while the base was refreshed');
      if (refresh.stale) {
        // GitHub's conflict reading was stale (GY-375): the test merge was clean and nothing was
        // written. The reading replaces the refresh record for this head, keeping what it carried
        // onto the head, and the stored observation has its conflict disproved.
        const kept = work.baseRefresh?.head === refresh.from.sha ? work.baseRefresh : null;
        work.baseRefresh = { ...(kept ?? {}), ...refresh, merge: kept?.merge ?? null, carry: kept?.carry ?? null, ...(kept?.restoredApproval ? { restoredApproval: kept.restoredApproval } : {}) };
        if (work.observation?.conflicting && disprovedConflict(work, work.observation)) work.observation = { ...work.observation, conflicting: false, mergeable: true };
        this.evaluate(work, all, now);
        await this.recordDispatch(db, work, now);
        await save(db, work, 'graphyard', 'base.stale-mergeability', now, { head: refresh.from.sha, base: refresh.base, reading: refresh.stale.reading });
        await wakeJob(db, work.id);
        return work;
      }
      const carry = refresh.head && refresh.head !== refresh.from.sha ? this.decideBaseRefreshCarry(work, all, refresh, now) : null;
      work.baseRefresh = { ...refresh, carry };
      this.evaluate(work, all, now);
      if (carry) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', 'base.carry', JSON.stringify({ details: { ...carry, merge: refresh.merge ?? null } })]);
      await this.recordDispatch(db, work, now);
      await save(db, work, 'graphyard', refresh.conflict ? 'base.conflict' : 'base.refreshed', now, { from: refresh.from, base: refresh.base, head: refresh.head, trigger: refresh.trigger ?? null,
        ...(refresh.conflict ? { conflict: refresh.conflict } : {}),
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
   * Records what the control plane did about a branch found carrying another item's unlanded
   * commits (GY-127): the head it restored — the item's own reviewed head merged onto the base —
   * or the conflict or the missing own head that stopped it. Nothing carries across a restore:
   * the contaminated head's bindings were bindings of foreign content, and the restored head is
   * observed, checked, reviewed and proved as any new head is.
   */
  async bindBranchRestore(id: string, expectedRevision: number, refresh: BaseRefresh, jobToken: string) {
    return this.store.transaction(async (db, now) => {
      const job = (await db.query('SELECT 1 FROM jobs WHERE work_id=$1 AND token=$2 AND locked_until>$3', [id, jobToken, now])).rows[0];
      requireCurrent(job, 'Integration job lease expired or superseded');
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document);
      const work = all.find(w => w.id === id);
      requireCurrent(work && work.revision === expectedRevision && work.stage !== 'done' && !work.observation?.merged, 'Task changed while the branch was restored');
      const restore = refresh.restore;
      requireCurrent(!work.queue && !!restore && restore.contaminated === work.candidate?.sha && refresh.policyRevision === work.policyRevision, 'Candidate, queue entry or policy changed while the branch was restored');
      work.baseRefresh = { ...refresh, carry: null };
      this.evaluate(work, all, now);
      await this.recordDispatch(db, work, now);
      await save(db, work, 'graphyard', restore!.outcome === 'restored' ? 'branch.restored' : restore!.outcome === 'conflict' ? 'branch.restore-conflict' : 'branch.unrepairable', now,
        { contaminated: restore!.contaminated, foreign: restore!.foreign, own: restore!.own, head: refresh.head, base: refresh.base, trigger: refresh.trigger ?? null, cause: restore!.cause, requested: restore!.requested, reason: restore!.reason, ...(refresh.conflict ? { conflict: refresh.conflict } : {}) });
      await wakeJob(db, work.id);
      return work;
    });
  }
  /**
   * Restores an approval GitHub dismissed for a merge-base change as the binding one, carried from
   * the head it was given on to the current candidate: unchanged heads (GY-127) and replaced tips
   * whose dismissal was the control plane's own republication (GY-519, see `dismissedApproval`).
   * The reviewed content is exactly what the reviewer approved, so no review round and no reviewer
   * attempt is spent on it, and the merge broker re-posts it through the reviewer App before the
   * merge as it re-posts any carried approval. Decided before the gates are evaluated, so no
   * review request is ever opened for it.
   */
  private restoreDismissedApproval(work: Work, now: Date): RestoredApproval | null {
    if (exactApproval(work) || carriedApproval(work)) return null;
    const dismissed = dismissedApproval(work);
    if (!dismissed) return null;
    const candidate = work.candidate!, observation = work.observation!, at = now.toISOString();
    const short = candidate.sha.slice(0, 12);
    const review = dismissed.reviewId !== undefined ? ` (review ${dismissed.reviewId})` : '';
    // A replaced tip's approval names both tips: the one it was given on, and the one it binds now.
    const originalSha = dismissed.originalSha !== undefined && dismissed.originalSha !== candidate.sha ? dismissed.originalSha : null;
    const replaced = originalSha !== null;
    const approval: CarriedApproval = { provider: 'github', reviewer: dismissed.reviewer, sha: candidate.sha, ...(dismissed.reviewId !== undefined ? { reviewId: dismissed.reviewId } : {}), carried: true, originalSha: originalSha ?? candidate.sha,
      reason: replaced
        ? `approval of ${originalSha!.slice(0, 12)} by ${dismissed.reviewer}${review} restored and carried to tip ${short}: GitHub dismissed it for the control plane's own force-push of ${short} over the unchanged author head (patch-id unchanged), so the reviewed content is exactly what was approved; the reviewer App re-posts it before the merge`
        : `approval of ${short} by ${dismissed.reviewer}${review} restored: GitHub dismissed it with "${dismissed.dismissal.reason}" while the head was unchanged, so the reviewed content is exactly what was approved; the reviewer App re-posts it before the merge` };
    const restored: RestoredApproval = { reviewer: dismissed.reviewer, ...(dismissed.reviewId !== undefined ? { reviewId: dismissed.reviewId } : {}), sha: candidate.sha, ...(replaced ? { originalSha } : {}), dismissal: dismissed.dismissal, at };
    const same = { sha: candidate.sha, baseSha: candidate.baseSha };
    const from = replaced ? { sha: originalSha!, baseSha: candidate.baseSha } : same;
    const carry = (existing: BaseRefresh['carry'] | undefined) => existing && existing.to.sha === candidate.sha && existing.to.baseSha === candidate.baseSha && existing.policyRevision === work.policyRevision
      ? { ...existing, approval }
      : { from, to: same, policyRevision: work.policyRevision, at, predecessor: 'base branch', changedFiles: [], reviewedFiles: observation.files, approval, evidence: [] };
    const speculation = work.queue?.speculation;
    if (speculation && speculation.tip === candidate.sha && speculation.policyRevision === work.policyRevision) {
      speculation.carry = carry(speculation.carry);
      if (!replaced) speculation.restoredApproval = restored;
    } else if (work.baseRefresh && work.baseRefresh.head === candidate.sha && work.baseRefresh.policyRevision === work.policyRevision && !replaced) {
      work.baseRefresh.carry = carry(work.baseRefresh.carry); work.baseRefresh.restoredApproval = restored;
    } else if (work.baseRefresh && work.baseRefresh.head === null && work.baseRefresh.from.sha === candidate.sha && work.baseRefresh.policyRevision === work.policyRevision) {
      // A record of this very head that republished nothing — a refresh whose merge conflicted, or
      // a repair the coordinator requested that has not run yet — is left as it says, and nothing
      // is restored: such a head is replaced before it could land (the worker resolves the
      // conflict, the repair moves the branch), and replacing the record would drop the conflict
      // the worker owes or the pending repair, and have the refresh retried for a conflict already
      // recorded. No review is asked for it meanwhile: the head does not contain the base tip.
      return null;
    } else if (replaced) {
      // A replaced tip's approval is restored only onto the queue tip that replaced it; anything
      // else has no record to carry it through, and the review stays required.
      return null;
    } else {
      // The head is neither a queue tip nor a refreshed head: the restored binding is recorded as
      // a refresh of the head onto the base it is bound to, which republished nothing.
      work.baseRefresh = { from: same, base: candidate.baseSha, baseTree: observation.baseTip === candidate.baseSha ? observation.baseTree ?? '' : '', policyRevision: work.policyRevision, at,
        head: candidate.sha, conflict: null, merge: null, carry: carry(undefined), restoredApproval: restored };
    }
    return restored;
  }
  /**
   * Removes an entry whose speculative validation cannot succeed, with the reason on the record.
   * `conflict` says the speculative merge conflicted; the record carries it as a typed flag (GY-252).
   */
  async ejectFromQueue(id: string, expectedRevision: number, reason: string, jobToken: string, conflict = false) {
    return this.store.transaction(async (db, now) => {
      const job = (await db.query('SELECT 1 FROM jobs WHERE work_id=$1 AND token=$2 AND locked_until>$3', [id, jobToken, now])).rows[0];
      requireCurrent(job, 'Integration job lease expired or superseded');
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document);
      const work = all.find(w => w.id === id);
      requireCurrent(work && work.revision === expectedRevision && work.stage !== 'done', 'Task changed before the queue ejection');
      requireCurrent(work.queue, 'Queue entry already left the merge queue');
      const sequence = work.queue!.sequence;
      // A speculative conflict records the predecessors its prediction held (GY-321, model/queue.ts).
      const ejected = queueEjectionRecord(work, all, reason, now, conflict);
      work.queueEjection = ejected.ejection;
      work.queueHistory = ejected.history;
      work.queue = null;
      this.evaluate(work, all, now);
      await this.recordDispatch(db, work, now);
      await save(db, work, 'graphyard', 'queue.ejected', now, { sequence, reason, conflict: ejected.ejection.conflict ?? null });
      for (const behind of all) if (behind.queue && behind.id !== work.id) await wakeJob(db, behind.id);
      return work;
    });
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
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document);
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
    const result = evaluate(work, all, now, this.ciAppIds, this.mergeBatchSize);
    if (work.stage !== result.stage) work.stageEnteredAt = now.toISOString();
    Object.assign(work, result);
    if (work.gates.some(g => !g.passed) || work.violations.length) work.mergeAuthorization = null;
    else if (work.candidate && !work.observation?.merged && (!work.mergeAuthorization || work.mergeAuthorization.sha !== work.candidate.sha || work.mergeAuthorization.baseSha !== work.candidate.baseSha)) {
      work.mergeAuthorization = { sha: work.candidate.sha, baseSha: work.candidate.baseSha, policyRevision: work.policyRevision, at: now.toISOString() };
    }
    // What the exact head still needs from a launched reviewer or producer, decided from the
    // gates just evaluated; the transitions reach the ledger with the document (recordDispatch).
    // A queued entry whose published tip is not this head is being replaced by it (GY-127): the
    // tip is observed and bound on the next reconciliation, and a request opened for the replaced
    // head now would be cancelled as stale then — after a session had been launched for it.
    this.dispatchTransitions.set(work, tipReplacesHead(work) ? [] : reconcileAutoDispatch(work, all, now));
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
   * How long one reconciliation batch may hold the coordination lock before it yields (GY-274).
   * The first tick after a deploy re-evaluated every item under one lock for 65 s, and every
   * heartbeat queued behind it until the workers' supervisors gave up.
   */
  reconcileBatchMs = 250;
  /**
   * Reconcile every item, in batches. Each batch is its own short coordination transaction on the
   * background lane (a bounded share of the pool): it re-reads the items, so nothing a heartbeat
   * or a request wrote while it yielded is overwritten, and resumes after the last item it
   * finished. Between batches the lock is released and the event loop runs, so a renewal waits
   * at most one batch however long the whole pass takes. One item always completes per batch.
   *
   * A pass therefore reads every document once per batch, O(batches x items) (GY-392), and that
   * is kept deliberately: every item is evaluated against `all`, the whole fleet as it stands
   * (dependencies, the merge queue, fleet capacity), so each batch needs the full snapshot, not
   * just the rows it reconciles. A keyset read of the batch's own rows saves nothing while `all`
   * must still be read, and a snapshot carried across batches would evaluate items against state
   * that the heartbeats and requests admitted between batches have already changed. The number
   * of batches is bounded by the pass's duration over reconcileBatchMs, not by the backlog.
   */
  async reconcile() {
    let cursor = 0, first = true;
    for (;;) {
      const finished = await this.store.transaction(async (db, now) => {
        const rows = (await db.query('SELECT number, document FROM work_items ORDER BY number')).rows;
        const all: Work[] = rows.map(row => row.document);
        // Items held for a merge inside a direct-merge window are delivered before anything else reads them.
        if (first) { await sweepDirectMerges(db, all, await directMergeWindows(db, this.directMergeEnvironment), now); first = false; }
        const started = performance.now();
        let reconciled = 0;
        for (const [index, row] of rows.entries()) {
          const number = Number(row.number);
          if (number <= cursor) continue;
          if (reconciled && performance.now() - started >= this.reconcileBatchMs) return false;
          await this.reconcileItem(db, all[index], all, now);
          cursor = number; reconciled++;
        }
        return true;
      }, { lane: 'background' });
      if (finished) return;
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  /** One item's reconciliation inside a batch's coordination transaction. */
  private async reconcileItem(db: PoolClient, work: Work, all: Work[], now: Date) {
    // A delivered item is not re-evaluated, but one still holding rows, a queue entry or an
    // action from before its delivery — every item delivered before GY-185 — is settled here
    // once, and the check that finds nothing to settle costs no evaluation.
    if (work.stage === 'done') {
      const leftover = !!work.queue || (work.actionQueue?.actions ?? []).some(row => row.kind !== 'verify-deployment') || (!!work.nextAction && work.nextAction.kind !== 'verify-deployment');
      if (leftover && settleDelivered(work, all, now)) await save(db, work, 'graphyard', 'delivery.settled', now);
      return;
    }
    const before = stableJson(work);
    // The liveness invariant (GY-201) is judged on the record as it stood, before this tick
    // touched it, so a violation the tick repairs is recorded rather than silently absorbed.
    const stranded = livenessOf(work, all, now).violation;
    preserveAssignment(work); retainQuarantineFence(work);
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
    // backlog does not wait on one click per item.
    for (const settled of settleableLeaseLoss(work, attestations)) {
      resolveEscalation(work, settled.escalation.trigger);
      ledger.push({ kind: 'escalation.auto-settled', details: { trigger: settled.escalation.trigger, epoch: settled.epoch, escalation: settled.escalation, note: settled.note, cause: settled.cause, attestation: settled.attestation, submission: work.submission } });
    }
    const queuedBefore = work.queue?.sequence ?? null;
    this.evaluate(work, all, now);
    // A queue entry the evaluation derived out — here, a merged entry whose reconciliation a
    // standing refusal already answered (GY-94) — is recorded as an ejection, and the entries
    // behind it are woken to predict against the real base.
    const ejected = queuedBefore !== null && !work.queue && work.queueEjection?.sequence === queuedBefore;
    if (ejected) ledger.push({ kind: 'queue.ejected', details: { sequence: queuedBefore, reason: work.queueEjection!.reason } });
    // Every violation found at the start of the tick is repaired by the evaluation above — the
    // derivation names its successor and the queue opens its row — and the ledger says so.
    if (stranded) ledger.push(livenessRepairEntry(stranded, work, all, now));
    if (stableJson(work) !== before) {
      for (const entry of ledger) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', entry.kind, JSON.stringify({ details: { ...entry.details, at: now.toISOString() } })]);
      await this.recordDispatch(db, work, now);
      await save(db, work, 'graphyard', 'reconciled', now, ledger.length ? { ledger: ledger.map(entry => entry.kind) } : undefined);
      if (work.submission) await wakeJob(db, work.id);
      if (ejected) for (const behind of all) if (behind.queue && behind.id !== work.id) await wakeJob(db, behind.id);
    }
  }
  async observe(id: string, expectedRevision: number, observation: Observation, jobToken?: string) {
    return this.store.transaction(async (db, now) => {
      if (jobToken) {
        const owned = await db.query('SELECT 1 FROM jobs WHERE work_id=$1 AND token=$2 AND locked_until>clock_timestamp() FOR UPDATE', [id, jobToken]);
        requireCurrent(owned.rowCount, 'Integration job lease expired or superseded; retry');
      }
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document);
      const work = all.find(w => w.id === id);
      requireCurrent(work && work.revision === expectedRevision, 'Task changed while GitHub was being observed; retry');
      demand(work.submission?.pr === observation.candidate.pr, 'Unassigned pull request');
      demand(work.workspaces.some(w => w.epoch === work.submission!.epoch && w.branch === observation.candidate.branch), 'PR branch does not match the assigned workspace');
      if (work.stage === 'done') return work;
      const queuedBefore = work.queue?.sequence ?? null;
      let authorizedSnapshot: Work | null = null; let authorizationRevision: number | null = null;
      // The repository-clock instant at which this authorization's evidence was judged
      // applicable. The provider merge timestamp cannot stand in for it: the two clocks
      // are only related through the recorded offset bound, so a reader that re-checks
      // expiry at the raw provider instant can call evidence expired that was live when
      // the merge was authorized. Recorded with the delivery so the judgement is exact.
      let evidenceAsOf: string | null = null;
      // The same two clocks make the raw provider merge timestamp unusable for any
      // repository-clock comparison a reader makes later: window membership, weekly
      // bucketing, and the interval from the append-only intent event are all measured on
      // the database clock. Carry the merge onto that clock here, while the bounded offset
      // is still in hand, and record the offset itself so other provider timestamps on the
      // same observation (the pull request's creation time) can be carried with it.
      let mergedAtRepository: string | null = null; let repositoryClockOffsetMs: number | null = null;
      let reconciliation: MergeReconciliation | null = null; let refusedReconciliation: { decision: string; reasons: string[] } | null = null;
      let operatorAuthorization: OperatorAuthorizedDelivery | null = null;
      let repairLane: RepairAudit | null = null;
      if (observation.merged && observation.mergedAt && Number.isFinite(Date.parse(observation.mergedAt))) {
        const providerMergedTime = Date.parse(observation.mergedAt);
        // Never allow evidence from after the earliest possible merge instant.
        // Whole-second timestamps can therefore conservatively refuse same-second authorization.
        const acquired = (await db.query(`SELECT ${eventWorkSql()}->'mergeExecution' AS execution FROM events WHERE work_id=$1 AND kind IN ('merge.execution.acquired','merge.execution.verified','merge.execution.committed') ORDER BY seq DESC LIMIT 1`, [id])).rows[0]?.execution as Work['mergeExecution'] | undefined;
        // A merge execution recorded before GY-258, when Graphyard called the provider itself, still
        // attributes the merge it committed; GitHub-executed merges stand on the enqueue request below.
        // The execution that called the provider for this head is the one that bounds its merge: a
        // later execution acquired on a lagging read that still showed the pull request open never
        // committed, and binding the merge to it would record a merge its predecessor authorized as
        // unauthorized (GY-202). So the latest committed execution for the observed head is preferred.
        const commits = (candidate: Work['mergeExecution'] | undefined) => !!candidate?.committingAt && candidate.sha === observation.candidate.sha && candidate.baseSha === observation.candidate.baseSha;
        const committed = (await db.query(`SELECT ${eventWorkSql()}->'mergeExecution' AS execution FROM events WHERE work_id=$1 AND kind='merge.execution.committed' AND ${eventWorkSql()}->'mergeExecution'->>'sha'=$2 AND ${eventWorkSql()}->'mergeExecution'->>'baseSha'=$3 ORDER BY seq DESC LIMIT 1`,
          [id, observation.candidate.sha, observation.candidate.baseSha])).rows[0]?.execution as Work['mergeExecution'] | undefined;
        const boundedExecution = (commits(committed) ? committed : null) ?? acquired ?? null;
        const offset = boundedExecution?.clockOffset;
        const mergedTime = providerMergedTime + (offset?.min ?? 0);
        // The lower bound of the offset, so the recorded instant is the earliest the merge
        // can have happened on the repository clock and a derived duration is never
        // inflated by skew. The bound is narrow: the recorded verification refused an offset
        // observation wider than 20 seconds, so the true instant is at most that far later.
        if (offset) { repositoryClockOffsetMs = offset.min; mergedAtRepository = new Date(mergedTime).toISOString(); }
        const cutoff = providerMergedTime + (/\.\d+Z$/.test(observation.mergedAt) ? 1 : 1000) + (offset?.max ?? 0);
        // Evidence is judged live at `cutoff - 1`, the instant the historical check uses: a recorded
        // execution's expiry was bounded by the earliest required-evidence expiry, and the enqueue
        // path re-checks every required proof on the record before the cutoff.
        evidenceAsOf = new Date(cutoff - 1).toISOString();
        let cancelledExecution = false;
        if (boundedExecution) {
          const cancellation = (await db.query("SELECT created_at FROM events WHERE work_id=$1 AND kind='merge.execution.cancelled' AND payload->'details'->>'executionId'=$2 AND created_at<$3 ORDER BY seq DESC LIMIT 1", [id, boundedExecution.id, new Date(cutoff)])).rows[0]?.created_at as Date | undefined;
          cancelledExecution = !!cancellation && cancellation.getTime() < cutoff;
        }
        const executionValid = !!boundedExecution && !!offset && !cancelledExecution && boundedExecution.sha === observation.candidate.sha && boundedExecution.baseSha === observation.candidate.baseSha
          && !!boundedExecution.verifiedAt && !!boundedExecution.committingAt
          && Date.parse(boundedExecution.issuedAt) <= Date.parse(boundedExecution.verifiedAt)
          && Date.parse(boundedExecution.verifiedAt) <= Date.parse(boundedExecution.committingAt)
          && Date.parse(boundedExecution.committingAt) < mergedTime && cutoff <= Date.parse(boundedExecution.expiresAt);
        // The record as it stood immediately before the merge: what the historical authorization
        // check reads, and what a two-party reconciliation re-checks (GY-92). The cutoff carries
        // the clock-offset allowance so an authorization recorded up to the merge instant on the
        // repository clock still counts, but that allowance admits no post-merge record (GY-94):
        // a snapshot whose own observation already reports this pull request merged was written
        // after the merge, whatever its timestamp, and carries the merge's consequences.
        // A row stored as a delta (store/snapshot-delta.ts) is read as the document it stands for.
        const past = await documentBefore(db, id, new Date(cutoff),
          record => !(record.observation?.merged && record.observation.candidate?.pr === observation.candidate.pr));
        const historical = past ? historicalAuthorizationRefusals(past, all, observation, cutoff, mergedTime) : ['No record of the item precedes the merge cutoff'];
        // GitHub executes the merge (GY-258): the coordinator's request that GitHub merge exactly
        // this head, recorded before the merge, stands where an execution stood. The record before
        // the cutoff must still show every gate passed and the authorization binding this head.
        const requested = !executionValid && past ? (await db.query(`SELECT 1 FROM events WHERE work_id=$1 AND kind='merge.enqueue.requested' AND payload->'details'->>'sha'=$2 AND payload->'details'->>'baseSha'=$3
          AND (payload->'details'->>'policyRevision')::int=$4 AND created_at<$5 LIMIT 1`, [id, observation.candidate.sha, observation.candidate.baseSha, past.policyRevision, new Date(cutoff)])).rowCount! > 0 : false;
        if (!authorizedSnapshot && past && (executionValid || requested) && !historical.length) {
          authorizedSnapshot = past; authorizationRevision = boundedExecution?.authorizationRevision ?? past.revision;
        }
        // An observed merge whose execution was cancelled or never valid is a recorded violation
        // that every later observation re-derives from immutable history. It is recoverable by
        // exactly one path: a two-party merge decision for this candidate, requested after the
        // merge, applied by an independent approver. The decision does not decide delivery by
        // itself — the record before the cutoff must still show every gate passed and every
        // required proof live, the same judgement an authorized merge is held to — and the
        // delivery then cites that snapshot and the decision. A decision the history refuses
        // is recorded on the item with the reasons, once, so the item says why it cannot be;
        // that refusal is also the exit of a queue entry that can never publish (merge-queue.ts).
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
        // A merge the repair lane made (GY-406) is delivered on its audit entry, which the lane
        // appended for exactly this head before it asked GitHub to merge (github.ts repairLaneStep).
        const repaired = !authorizedSnapshot && observation.mergeSha ? (await db.query(`SELECT payload->'details' AS audit FROM events WHERE work_id=$1 AND kind=$2 AND payload->'details'->>'head'=$3 AND created_at<$4 ORDER BY seq DESC LIMIT 1`,
          [id, repairAuditEvent, observation.candidate.sha, new Date(cutoff)])).rows[0]?.audit as RepairAudit | undefined : undefined;
        if (repaired) {
          const snapshot = past ?? structuredClone(work);
          authorizedSnapshot = snapshot; authorizationRevision = snapshot.revision; repairLane = repaired;
        }
        if (!authorizedSnapshot && past && observation.mergeSha) {
          const decisions = await postMergeDecisions(db, work, observation, past.policyRevision, cutoff);
          const refused = new Set<string>((await db.query("SELECT payload->'details'->>'decision' AS decision FROM events WHERE work_id=$1 AND kind='merge.reconciliation.refused'", [id])).rows.map(row => row.decision as string));
          const decision = decisions.filter(entry => !refused.has(entry.id)).at(-1) ?? null;
          const reconcilable = decision ? historicalAuthorizationRefusals(past, all, observation, cutoff, mergedTime, { reconciling: true }) : historical;
          if (decision && !reconcilable.length) {
            authorizedSnapshot = past; authorizationRevision = boundedExecution?.sha === observation.candidate.sha && boundedExecution.baseSha === observation.candidate.baseSha ? boundedExecution.authorizationRevision : past.revision;
            reconciliation = { decision: decision.id, requestedBy: decision.requestedBy, requestedAt: decision.requestedAt, approvedBy: decision.approvedBy!, approvedAt: decision.approvedAt!,
              reason: decision.reason, approvalReason: decision.approvalReason ?? '', cutoff: new Date(cutoff).toISOString(), snapshotRevision: past.revision,
              judgement: `Every gate passed and every required proof was live at ${new Date(cutoff - 1).toISOString()}, the recorded merge cutoff; the merge was observed without a valid execution and is delivered on the approved decision`,
              proofs: requiredProofs(past, all), violation: unauthorizedMergeViolation };
          } else if (decision) {
            const operator = operatorAuthorizing(decision, refused);
            if ('operator' in operator) {
              authorizedSnapshot = past; authorizationRevision = past.revision;
              operatorAuthorization = { decision: decision.id, requestedBy: decision.requestedBy, requestedAt: decision.requestedAt, approvedBy: decision.approvedBy!, approvedAt: decision.approvedAt!,
                reason: decision.reason, approvalReason: decision.approvalReason ?? '', operator: operator.operator, refusedDecision: operator.refusedDecision, unmet: reconcilable,
                cutoff: new Date(cutoff).toISOString(), snapshotRevision: past.revision, execution: null, violation: unauthorizedMergeViolation,
                judgement: `No merge execution authorized merge ${observation.mergeSha.slice(0, 12)} and the record at ${new Date(cutoff - 1).toISOString()}, the recorded merge cutoff, did not either (${reconcilable.join('; ')}); operator ${operator.operator} authorized it outside the guarded path by decision ${decision.id}, citing refused reconciliation ${operator.refusedDecision}` };
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
      work.candidate = observation.candidate;
      // A conflict the control plane's own test merge of this head onto this tip found clean is
      // GitHub's stale reading (GY-375): it is stored disproved — the head merges cleanly, which is
      // all GitHub's `mergeable: false` withheld from an open, non-draft pull request — so nothing
      // refreshes, holds or reworks it for that reading again.
      work.observation = observation.conflicting && disprovedConflict(work, observation) ? { ...observation, conflicting: false, mergeable: true } : observation;
      // A submission recorded without an observation has no files (GY-293): the first observation
      // of that pull request records what its diff changes inside the documentation paths, so a
      // docs diff reads as satisfied rather than waiting for the reviewer to judge it.
      const recorded = work.documentation?.submission;
      if (recorded && recorded.files === null && work.submission?.pr === recorded.pr && observation.candidate.pr === recorded.pr && Array.isArray(observation.files))
        work.documentation = { ...work.documentation!, submission: recordDocumentationSubmission(work.documentation!, recorded, observation.files, recorded.statement, new Date(recorded.at)) };
      // Snapshot all provider review identities after the revision. Approvals in this
      // first observation never count, regardless of clock skew or future reevaluation.
      if (work.formalReviewResetRequired && reviewProviderOf(work.policy) === 'github' && !work.formalReviewBaseline && observation.reviewIds
        && observation.reviewIds.every(id => Number.isSafeInteger(id) && id > 0)
        && observation.reviews.every(r => Number.isSafeInteger(r.id) && observation.reviewIds!.includes(r.id!))) {
        work.formalReviewBaseline = { pr: observation.candidate.pr, policyRevision: work.policyRevision, reviewIds: [...observation.reviewIds] };
      }
      // An approval GitHub withdrew for a merge-base change on this unchanged head binds again
      // before the gates read the record, so no review request is opened for it (GY-127).
      const restoredApproval = observation.merged ? null : this.restoreDismissedApproval(work, now);
      this.evaluate(work, all, now);
      if (restoredApproval) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', 'review.restored',
        JSON.stringify({ details: { ...restoredApproval, baseSha: observation.candidate.baseSha, policyRevision: work.policyRevision } })]);
      // A head found carrying another item's unlanded commits is named on the ledger once per head
      // and per set of items, with what restores it; master status reads the same record.
      const contamination = observation.merged ? null : branchContamination(work, all);
      const previouslyNamed = previousObservation && previousObservation.candidate.sha === observation.candidate.sha
        ? branchContamination({ ...work, observation: previousObservation }, all) : null;
      if (contamination && JSON.stringify(previouslyNamed?.foreign ?? null) !== JSON.stringify(contamination.foreign)) {
        await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', 'branch.contaminated',
          JSON.stringify({ details: { ...contamination, ejected: work.queueEjection?.sha === contamination.head, at: now.toISOString() } })]);
      }
      // The base branch advanced to a commit whose tree is the bound base's tree — an earlier
      // queue merge — so the published tip and every binding on it stand. The advance is written
      // to the record and the ledger with both shas and the tree, and nothing is republished.
      const speculation = work.queue?.speculation;
      if (speculation && !observation.merged && observation.baseTip && observation.baseTree && speculation.tip === observation.candidate.sha && speculation.base === observation.candidate.baseSha
        && speculation.base !== observation.baseTip && speculation.baseTree === observation.baseTree && speculation.carriedBase?.sha !== observation.baseTip) {
        speculation.carriedBase = { sha: observation.baseTip, tree: observation.baseTree, at: now.toISOString() };
        await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', 'queue.base-carried',
          JSON.stringify({ details: { tip: speculation.tip, boundBase: speculation.base, baseTree: speculation.baseTree, baseTip: observation.baseTip, at: now.toISOString() } })]);
      }
      if (observation.merged) {
        const violation = unauthorizedMergeViolation;
        if (authorizedSnapshot && observation.mergeSha) {
          // A reconciled delivery is judged at the cutoff, not now: the violation it recovers from
          // leaves the record (the ledger keeps it), and gates that moved since — evidence that
          // expired while the item sat at the merge stage — are reported with the judgement, not
          // recorded as a second violation.
          // An operator-authorized delivery is judged by the operator, not the gates: what the
          // record lacked is on the delivery, and the violation it owns leaves the record the same way.
          if (reconciliation || operatorAuthorization || repairLane) work.violations = work.violations.filter(entry => entry !== violation && !entry.startsWith(reconciliationRefusalPrefix));
          else if (work.gates.some(g => !g.passed)) work.violations.push('Post-merge checks differ from the recorded authorization; follow-up required');
          work.stage = 'done'; work.stageEnteredAt = now.toISOString();
          const delivery: Work['delivery'] = { mergedAt: observation.mergedAt!, mergeSha: observation.mergeSha, authorizationRevision: authorizationRevision!, ...(evidenceAsOf ? { evidenceAsOf } : {}),
            ...(mergedAtRepository ? { mergedAtRepository, repositoryClockOffsetMs: repositoryClockOffsetMs! } : {}) };
          work.delivery = reconciliation ? Object.assign(delivery, { reconciliation }) : operatorAuthorization ? Object.assign(delivery, { operatorAuthorization }) : delivery;
          if (repairLane) work.repairLane = repairLane;
          if (reconciliation) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, reconciliation.requestedBy, 'merge.reconciled',
            JSON.stringify({ details: { ...reconciliation, mergeSha: observation.mergeSha, mergedAt: observation.mergedAt, authorizationRevision, evidenceAsOf, gatesNow: work.gates.filter(gate => !gate.passed).map(gate => ({ name: gate.name, reasons: gate.reasons })), at: now.toISOString() } })]);
          if (operatorAuthorization) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, operatorAuthorization.operator, 'merge.operator-authorized',
            JSON.stringify({ details: { ...operatorAuthorization, mergeSha: observation.mergeSha, mergedAt: observation.mergedAt, authorizationRevision, evidenceAsOf, gatesNow: work.gates.filter(gate => !gate.passed).map(gate => ({ name: gate.name, reasons: gate.reasons })), at: now.toISOString() } })]);
          await db.query('DELETE FROM jobs WHERE work_id=$1', [work.id]);
          // Delivered in this transaction: what it still owes is recomputed now, its leftover rows
          // retired and its queue entry cleared, so nothing retries against the delivery (GY-185).
          settleDelivered(work, all, now);
          // The queue shifted. The entries that can land next (the head and its batch) are woken now; the rest are observed on
          // their own schedule and re-predict their base when they near the head.
          for (const behind of nextQueueEntries(all, work.id, Math.max(mergeBandQueueDepth, this.mergeBatchSize))) await wakeJob(db, behind.id);
        } else {
          if (!work.violations.includes(violation)) work.violations.push(violation);
          if (refusedReconciliation) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', 'merge.reconciliation.refused',
            JSON.stringify({ details: { ...refusedReconciliation, mergeSha: observation.mergeSha, mergedAt: observation.mergedAt, at: now.toISOString() } })]);
        }
      }
      // A queue entry the evaluation derived out is recorded as an ejection, and every entry behind
      // it is woken to predict against the real base. For a merged entry that could never publish
      // a speculative tip, the ejection is its refused reconciliation (GY-94): nothing is delivered,
      // and the ledger keeps the refusal and the exit side by side.
      if (queuedBefore !== null && !work.queue && work.queueEjection?.sequence === queuedBefore) {
        await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', 'queue.ejected',
          JSON.stringify({ details: { sequence: queuedBefore, reason: work.queueEjection.reason, ...(refusedReconciliation ? { decision: refusedReconciliation.decision, mergeSha: observation.mergeSha } : {}), at: now.toISOString() } })]);
        for (const behind of nextQueueEntries(all, work.id, Math.max(mergeBandQueueDepth, this.mergeBatchSize))) await wakeJob(db, behind.id);
      }
      await this.recordDispatch(db, work, now);
      await save(db, work, 'github', 'github.observed', now);
      return work;
    });
  }
}
