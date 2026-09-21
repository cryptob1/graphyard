import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, save, wakeJob } from './store.js';
import { authorizedForProof, unauthorizedProofs } from './proof-grants.js';
import { workspacePath, pathsOverlap, validBranch } from './workspace.js';
import { activeLease, admin, assertReviewerProfiles, operatorCapability, escalationTriggers, holdsMergeExecution, MergeExecutionInProgress, providerDelayAfterVerification, raiseEscalation, releaseLeadHold, resolveEscalation, standingEscalations, attestationFor, attestationKinds, attestationsFromLedger, leaseLapseCause, leaseLossEpoch, leaseLossReason, settleableLeaseLoss, submittedEpoch, type Attestation, requireCurrent, createSchema, criterionSchema, bindingApproval, currentEvidence, decideCarry, deploySmokeProof, deploySmokeRequired, evidenceBindsCandidate, inheritedObligations, pathScopeContains, requiredProofs, resourcesSchema, demand, evaluate, exhaustedReviewerProfiles, proofSchema, reviewerProfileFor, reviewerProfileSchema, reviewProviders, reviewProviderOf, type Criterion, type Evidence, type Principal, type ReviewerApp, type ReviewFailover, type Work, type Observation, type ReviewRequest, type OperatorCapability } from './model.js';
import { Refusal } from './model/refusal.js';
import { resourceConflicts } from './coordination.js';
import { containmentAttestation, containmentSettlementRefusals, containmentVerificationSchema } from './quarantine.js';
import { activeEngineers, delegationLimits, implementerIdentities, leadMay, producerIndependenceRefusal, sessionKind } from './delegation.js';
import { queueHistoryLimit, queueSequencingReason, reconciliationRefusalPrefix, type BaseRefresh, type QueueSpeculation } from './merge-queue.js';
import { githubFromEnv } from './github.js';
import { regressionRefusals } from './regression-guard.js';
import { ciFamilyAllows, ciProofFamilies, ciRunBindingSchema, ciRunRefusal, isCiProducer, refuseCiProducer, staleCiAttemptRefusal, type CiRunObservation } from './model/ci-proofs.js';
import { decideScopeRequest, liveScopeWidening, scopeRefusalBlocker, type ScopeDecision } from './model/scope.js';
import { liveDispatchHandleIds, reconcileAutoDispatch, type DispatchTransition } from './model/dispatch.js';
import { nextAction, nextActionKinds, sameAction } from './model/next-action.js';
import { claimAction, openActions, reconcileActions, renewClaim, settleAction, type ActionRow } from './model/actions.js';
import { agentRequestSchema, boundedAgentRequests, deciderFor, expireAgentRequests, leaseHeldRequestTypes, requestResolutionRefusal, resolveSatisfiedScopeRequests, type AgentRequest } from './model/agent-requests.js';
import { recordSession, sessionHandleSchema } from './model/sessions.js';
import { beginAttempt, endAttempt, endLapsedAttempt, recordIntervention, recordRework, recordSubmission } from './pipeline-speed.js';
import { foldDecisions, type Decision } from './model/approval.js';

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
  requirements: z.object({ expectedPolicyRevision: z.number().int().positive(), reason: z.string().trim().min(1).max(2000), criteria: z.array(criterionSchema).min(1).max(50), dependencies: z.array(z.string().uuid()).max(50), plannedFiles: createSchema.shape.plannedFiles, exclusiveResources: resourcesSchema, producerProofs: createSchema.shape.producerProofs }).strict(),
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
  submit: z.object({ epoch, pr: z.number().int().positive() }).strict(),
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
    ciRun: ciRunBindingSchema.optional() }).strict(),
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
// A merge execution is owned by the executor instance that acquired it — one daemon process or
// one interactive `master merge` request — never by the coordinator principal alone (GY-92). Two
// executors sharing one credential otherwise each read the other's in-flight execution as their
// own to resume, re-verify it under a new idempotency key, and cancel it on the refusal, before the
// provider merge the first one already committed. The instance is minted by the executor and
// bound here to the principal that authenticates it, so no instance can name another principal's.
const executorInstance = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const mergeAcquireSchema = z.object({ expectedRevision: z.number().int().positive(), sha, baseSha: sha, policyRevision: z.number().int().positive(), executor: executorInstance.optional() }).strict();
const mergeCancelSchema = z.object({ executionId: z.string().uuid(), reason: z.string().trim().min(1).max(2000), executor: executorInstance.optional() }).strict();
const mergeVerifySchema = z.object({ executionId: z.string().uuid(), executor: executorInstance.optional() }).strict();
/**
 * The recorded owner of a merge execution: `principal#instance` for an executor that names its
 * instance, the bare principal for a caller that names none. Every later step must present the
 * same instance; the executor side derives the same string (mergeExecutionOwner in master.ts).
 */
export const mergeExecutionOwner = (actor: Pick<Principal, 'id'>, executor?: string | null) => executor ? `${actor.id}#${executor}` : actor.id;
const ownedByAnother = 'Merge execution is missing, expired, superseded, or owned by another coordinator executor instance';
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
  const rows = (await db.query("SELECT seq, actor, kind, payload, created_at FROM events WHERE work_id=$1 AND kind IN ('blocked','rework','recover') ORDER BY seq", [workId])).rows;
  return attestationsFromLedger(rows.map(row => ({ seq: Number(row.seq), actor: row.actor, kind: row.kind, at: new Date(row.created_at).toISOString(), details: row.payload?.details, workEpoch: row.payload?.work?.epoch })));
}
/**
 * Apply this repository's scope rule to an open request and record what it decided (GY-85).
 *
 * The verdict is recomputed from the item's own criteria and the documentation rule, never taken
 * from a caller, so it grants no authority to whoever asked. An approved widening is applied to
 * the item exactly as an operator widening would be; a refusal becomes the item's blocker, so the
 * ready gate holds it until somebody decides the scope the item does not already carry.
 */
function applyScopeDecision(work: Work, request: NonNullable<Work['scopeRequest']>, now: Date): ScopeDecision {
  const verdict = decideScopeRequest(work, request);
  const decision: ScopeDecision = { state: verdict.state, reason: verdict.reason, at: now.toISOString(), decidedBy: 'graphyard',
    waitedMs: Math.max(0, now.getTime() - Date.parse(request.at)), paths: verdict.paths, requestedBy: request.requestedBy, requestedAt: request.at };
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
        work!.proofGaps = await unauthorizedProofs(db, this.principals, [...proofNames, ...(deploySmokeRequired(data.policy) ? [deploySmokeProof] : [])]);
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
      preserveAssignment(work); retainQuarantineFence(work);
      if (!containmentCleanup.includes(command) && !postDeployment && work.mergeExecution && !holdsMergeExecution(work, now.getTime())) work.mergeExecution = null;
      // Revocation is the one mutation an in-flight merge execution cannot outrun: freezing it
      // for the execution's lifetime would leave a withdrawn proof merging against a published
      // GitHub success check. Every other command still waits for the bounded execution — and a
      // committed one outlives its expiry here until GitHub has answered for the provider call.
      demand(!work.mergeExecution || command === 'heartbeat' || command === 'revoke' || containmentCleanup.includes(command) || postDeployment,
        work.mergeExecution?.committingAt ? 'The merge broker committed this candidate to the provider; retry after GitHub reconciliation' : 'A merge execution is active; retry after it completes or expires');
      if (command !== 'create' && !containmentCleanup.includes(command) && !postDeployment) demand(work.stage !== 'done', 'Delivered work is immutable; create a follow-up task');
      if (command === 'rereview') {
        if (actor.role !== 'admin') { demand(actor.role === 'worker', 'Worker or operator required', 403); activeLease(work, actor, data.epoch, now); }
        demand(work.policy.review && ['codex', 'agent'].includes(reviewProviderOf(work.policy)) && work.submission && !work.observation?.merged, 'Open submitted work with a dispatched review provider is required');
        work.reviewRequest = null; work.observation = null; work.mergeAuthorization = null;
        // Re-review restarts failover at the first configured profile; the event ledger keeps
        // every superseded exhaustion record for this candidate.
        work.reviewFailovers = (work.reviewFailovers ?? []).filter(failover => failover.sha !== work.candidate?.sha
          || failover.baseSha !== work.candidate?.baseSha || failover.policyRevision !== work.policyRevision);
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
        work.proofGaps = await unauthorizedProofs(db, this.principals, [...proofs, ...(deploySmokeRequired(work.policy) ? [deploySmokeProof] : [])]);
        work.formalReviewResetRequired = true; work.formalReviewBaseline = undefined;
        // A request the widened scope fully covers is answered; a partial one stays open for the
        // master. Answering it also lifts the refusal that was blocking the item on scope.
        if (work.scopeRequest && work.scopeRequest.paths.every(path => data.plannedFiles.some((scope: string) => pathScopeContains(scope, path)))) {
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
        demand(!request!.decision, 'This scope request was already decided');
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
        recordSession(work, data, actor.id, now);
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
        const evidence: Evidence = { ...data, id: randomUUID(), producer: actor.id, trusted, at: now.toISOString(), ...(ciRun ? { ciRun } : {}) };
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
        // The execution is recalled when a withdrawn record — executed or derived — bound its
        // candidate, exactly or carried across a Graphyard-authored tip, for a proof the
        // candidate's criteria require.
        const execution = work.mergeExecution && work.candidate
          && work.mergeExecution.sha === work.candidate.sha
          && work.mergeExecution.baseSha === work.candidate.baseSha
          && work.mergeExecution.policyRevision === data.policyRevision
          && withdrawn.some(item => evidenceBindsCandidate(work!, item))
          && work.criteria.some(criterion => criterion.proofs.includes(data.proof))
          ? work.mergeExecution : null;
        // mergeCommit is the serialization point immediately before the provider mutation.
        // Once it wins the row lock, a withdrawal that contributed to that execution must
        // refuse rather than falsely claim it recalled the candidate — and keeps refusing past
        // the execution's expiry, because the committed record is retained until a GitHub
        // observation settles the provider outcome. Historical/unrelated evidence can still be
        // withdrawn without disturbing the current execution.
        demand(!execution?.committingAt, 'The merge broker already committed this candidate to the provider; wait for reconciliation before revoking');
        for (const item of withdrawn) item.revocation = { at: now.toISOString(), actor: actor.id, reason: data.reason };
        if (execution) work.mergeExecution = null;
        // Reuse the cancellation ledger the merge broker and delivery attribution already read,
        // so an observed merge that lands after this instant refuses instead of completing.
        if (execution) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)',
          [work.id, actor.id, 'merge.execution.cancelled', JSON.stringify({ details: { executionId: execution.id, reason: `Evidence ${data.proof} revoked: ${data.reason}` } })]);
      }
      // A widening that covers an open scope ask is the answer to it: the deterministic rule the
      // request named has been applied, so the request closes rather than waiting on nobody.
      if (command === 'requirements') resolveSatisfiedScopeRequests(work, path => (work!.plannedFiles ?? []).some(planned => pathScopeContains(planned, path)), now);
      retainQuarantineFence(work);
      // Delivery is an immutable snapshot. A late containment cleanup or a post-deployment fact may
      // append its audit/revision metadata, but stale inputs must not re-evaluate it.
      if (!deliveredContainmentCleanup && !postDeployment) this.evaluate(work, all, now);
      // A delivered item's gates are an immutable snapshot, but what it still owes — a deployment
      // carrying the merge — is not; its queue is reconciled without re-evaluating the delivery.
      else {
        const computed = nextAction(work, all, now);
        reconcileActions(work, all, now, { next: computed });
        if (work.nextAction === undefined || !sameAction(work.nextAction, computed)) work.nextAction = computed;
      }
      await this.recordDispatch(db, work, now);
      await save(db, work, actor.id, command, now, command === 'settle' ? { epoch: data.epoch }
        : command === 'autoscope' ? { ...data, decision, before: { plannedFiles: before?.plannedFiles ?? [], blocker: before?.blocker ?? null } }
        : actor.role === 'operator-agent' ? { before, intent: data, reason: data.reason ?? null, ...(command === 'requirements' ? { liveScopeWidening: widening } : {}) } : data);
      if (work.submission && !postDeployment && !['heartbeat', 'release', 'claim', 'workspace'].includes(command)) await wakeJob(db, work.id);
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(work)]);
      return work;
    });
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
    return this.store.transaction(async (db, now) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) { demand(receipt.fingerprint === fingerprint, idempotencyMismatch); return receipt.result as { action: ActionRow | null }; }
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document);
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
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document);
      const work = all.find(item => item.actionQueue?.actions.some(row => row.id === id));
      demand(work, 'Action is not open on any work item', 404);
      const transition = settleAction(work!, id, { executor: data.executor ?? actor.id, principal: actor.id }, data.result, data.reason, now);
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
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document);
      const work = all.find(item => item.actionQueue?.actions.some(row => row.id === id));
      demand(work, 'Action is not open on any work item', 404);
      const row = renewClaim(work!, id, { executor: data.executor ?? actor.id, principal: actor.id }, now, data.leaseSeconds ? data.leaseSeconds * 1000 : undefined);
      // A renewal is a fact about a claim, not a decision: it is persisted without re-evaluating
      // the item and without an event of its own, so a long handler costs one update per interval.
      await db.query('UPDATE work_items SET document=$2 WHERE id=$1', [work!.id, JSON.stringify(work)]);
      return { action: row, work: { id: work!.id, key: work!.key } };
    });
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
  async acquireMerge(actor: Principal, id: string, input: unknown, key: string) {
    demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const data = mergeAcquireSchema.parse(input);
    const fingerprint = createHash('sha256').update(JSON.stringify({ command: 'merge.acquire', id, data })).digest('hex');
    return this.store.transaction(async (db, now) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document);
      const work = all.find(item => item.id === id || item.key === id);
      demand(work, 'Work item not found', 404);
      if (receipt) {
        demand(receipt.fingerprint === fingerprint, idempotencyMismatch);
        this.evaluate(work, all, now);
        const execution = receipt.result?.execution;
        demand(execution && work.mergeExecution?.id === execution.id && !work.mergeExecution?.fenced
          && Date.parse(execution.expiresAt) > now.getTime() && work.stage === 'merge' && work.gates.every(gate => gate.passed)
          && !work.violations.length && work.candidate?.sha === execution.sha && work.candidate?.baseSha === execution.baseSha
          && work.policyRevision === execution.policyRevision, 'Replayed merge execution is expired, cancelled, fenced, or superseded');
        return receipt.result;
      }
      demand(work.revision === data.expectedRevision, 'Task changed before merge execution; retry');
      if (work.mergeExecution && !holdsMergeExecution(work, now.getTime())) work.mergeExecution = null;
      demand(!work.mergeExecution, work.mergeExecution?.committingAt ? 'A committed merge execution awaits GitHub reconciliation; no new execution can be granted until it is observed' : 'A merge execution is already active');
      this.evaluate(work, all, now);
      const authorization = work.mergeAuthorization;
      const age = work.observation ? now.getTime() - Date.parse(work.observation.at) : NaN;
      demand(work.stage === 'merge' && work.gates.every(gate => gate.passed) && !work.violations.length && authorization
        && authorization.sha === data.sha && authorization.baseSha === data.baseSha && authorization.policyRevision === data.policyRevision
        && work.candidate?.sha === data.sha && work.candidate.baseSha === data.baseSha && Number.isFinite(age) && age >= 0 && age < 120_000,
      'Merge authorization is no longer current');
      const requiredEvidence = requiredProofs(work, all).map(proof => currentEvidence(work, proof, now));
      const validityDeadlines = [now.getTime() + 120_000, Date.parse(work.observation!.at) + 120_000,
        ...requiredEvidence.flatMap(evidence => evidence?.expiresAt ? [Date.parse(evidence.expiresAt)] : [])];
      const expiresAt = Math.min(...validityDeadlines);
      demand(Number.isFinite(expiresAt) && expiresAt - now.getTime() > 95_000, 'Required gate inputs expire too soon for a bounded merge execution; refresh them and retry');
      const execution = { id: randomUUID(), owner: mergeExecutionOwner(actor, data.executor), sha: data.sha, baseSha: data.baseSha, policyRevision: data.policyRevision, authorizationRevision: work.revision, issuedAt: now.toISOString(), expiresAt: new Date(expiresAt).toISOString() };
      work.mergeExecution = execution;
      await this.recordDispatch(db, work, now);
      await save(db, work, actor.id, 'merge.execution.acquired', now, { executionId: execution.id, owner: execution.owner, sha: execution.sha, baseSha: execution.baseSha, policyRevision: execution.policyRevision });
      const result = { key: work.key, revision: work.revision, execution };
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
      return result;
    });
  }
  async cancelMerge(actor: Principal, id: string, input: unknown, key: string) {
    demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const data = mergeCancelSchema.parse(input);
    const fingerprint = createHash('sha256').update(JSON.stringify({ command: 'merge.cancel', id, data })).digest('hex');
    return this.store.transaction(async (db, now) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) { demand(receipt.fingerprint === fingerprint, idempotencyMismatch); return receipt.result; }
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(row => row.document);
      const work = all.find(item => item.id === id || item.key === id);
      demand(work, 'Work item not found', 404);
      // Only the instance that acquired the execution may cancel it: a second executor under the
      // same credential that lost the race stands down instead (GY-92).
      demand(work.mergeExecution?.id === data.executionId && work.mergeExecution.owner === mergeExecutionOwner(actor, data.executor), ownedByAnother);
      work.mergeExecution = null; this.evaluate(work, all, now);
      await this.recordDispatch(db, work, now);
      await save(db, work, actor.id, 'merge.execution.cancelled', now, { executionId: data.executionId, reason: data.reason });
      await wakeJob(db, work.id);
      const result = { key: work.key, revision: work.revision, cancelled: data.executionId };
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
      return result;
    });
  }
  async replayMergeVerification(actor: Principal, id: string, input: unknown, key: string) {
    demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const data = mergeVerifySchema.parse(input); const fingerprint = createHash('sha256').update(JSON.stringify({ command: 'merge.verify', id, data })).digest('hex');
    return this.store.transaction(async (db, now) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (!receipt) return null;
      demand(receipt.fingerprint === fingerprint, idempotencyMismatch);
      const work = (await db.query('SELECT document FROM work_items WHERE id::text=$1 OR document->>\'key\'=$1', [id])).rows[0]?.document as Work | undefined;
      demand(work?.mergeExecution?.id === data.executionId && work.mergeExecution.owner === mergeExecutionOwner(actor, data.executor) && work.mergeExecution.verifiedAt === receipt.result.verifiedAt
        && Date.parse(work.mergeExecution.expiresAt) > now.getTime(), 'Replayed merge verification is expired, cancelled, or superseded');
      return receipt.result;
    });
  }
  async verifyMerge(actor: Principal, id: string, input: unknown, observation: Observation, key: string) {
    demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const data = mergeVerifySchema.parse(input); const fingerprint = createHash('sha256').update(JSON.stringify({ command: 'merge.verify', id, data })).digest('hex');
    return this.store.transaction(async (db, now) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) {
        demand(receipt.fingerprint === fingerprint, idempotencyMismatch);
        const current = (await db.query('SELECT document FROM work_items WHERE id::text=$1 OR document->>\'key\'=$1', [id])).rows[0]?.document as Work | undefined;
        demand(current?.mergeExecution?.id === data.executionId && current.mergeExecution.owner === mergeExecutionOwner(actor, data.executor) && current.mergeExecution.verifiedAt === receipt.result.verifiedAt
          && !current.mergeExecution.fenced && Date.parse(current.mergeExecution.expiresAt) > now.getTime(), 'Replayed merge verification is expired, cancelled, fenced, or superseded');
        return receipt.result;
      }
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(row => row.document);
      const work = all.find(item => item.id === id || item.key === id); demand(work, 'Work item not found', 404);
      const execution = work.mergeExecution;
      demand(execution?.id === data.executionId && execution.owner === mergeExecutionOwner(actor, data.executor) && Date.parse(execution.expiresAt) > now.getTime(), ownedByAnother);
      demand(!execution.verifiedAt, 'Merge execution was already verified; retry with the original idempotency key');
      demand(!execution.fenced, `Merge execution was fenced and cannot be verified: ${execution.fenced?.reason}`);
      demand(!observation.merged && observation.prState === 'open' && observation.draft === false, 'Pull request is no longer open and ready for merge');
      demand(observation.candidate.sha === execution.sha && observation.candidate.baseSha === execution.baseSha && observation.candidate.pr === work.submission?.pr
        && work.workspaces.some(workspace => workspace.epoch === work.submission!.epoch && workspace.branch === observation.candidate.branch), 'GitHub candidate changed during merge execution');
      // The final verification re-runs the landing check against the branch head as it is now
      // (GY-97). It is taken without the other items, so what the recorded observation of this
      // exact head found carried in its history stands beside it rather than being dropped.
      const recorded = work.observation && work.observation.candidate.sha === observation.candidate.sha ? work.observation.landing?.carried : undefined;
      if (observation.landing && observation.landing.carried === undefined && recorded) observation.landing = { ...observation.landing, carried: recorded };
      const probe = structuredClone(work); probe.candidate = observation.candidate; probe.observation = observation;
      this.evaluate(probe, all.map(item => item.id === probe.id ? probe : item), now);
      demand(probe.stage === 'merge' && probe.gates.every(gate => gate.passed) && !probe.violations.length, `GitHub gates changed during merge execution: ${probe.gates.flatMap(gate => gate.reasons).concat(probe.violations).join('; ')}`);
      execution.verifiedAt = now.toISOString();
      const offset = observation.clockOffset;
      demand(offset && Number.isFinite(offset.min) && Number.isFinite(offset.max) && offset.min <= offset.max && offset.max - offset.min <= 20_000, 'A bounded GitHub/database clock observation is required');
      execution.clockOffset = offset;
      await save(db, work, actor.id, 'merge.execution.verified', now, { executionId: execution.id, sha: execution.sha, verifiedAt: execution.verifiedAt });
      const providerDelayMs = providerDelayAfterVerification(now.getTime(), offset);
      const result = { key: work.key, executionId: execution.id, sha: execution.sha, verifiedAt: execution.verifiedAt, providerDelayMs, clockOffset: offset, revision: work.revision };
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
      return result;
    });
  }
  async commitMerge(actor: Principal, id: string, input: unknown, key: string) {
    demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const data = mergeVerifySchema.parse(input); const fingerprint = createHash('sha256').update(JSON.stringify({ command: 'merge.commit', id, data })).digest('hex');
    return this.store.transaction(async (db, now) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) {
        demand(receipt.fingerprint === fingerprint, idempotencyMismatch);
        const current = (await db.query('SELECT document FROM work_items WHERE id::text=$1 OR document->>\'key\'=$1', [id])).rows[0]?.document as Work | undefined;
        demand(current?.mergeExecution?.id === data.executionId && current.mergeExecution.owner === mergeExecutionOwner(actor, data.executor)
          && current.mergeExecution.committingAt === receipt.result.committingAt && Date.parse(current.mergeExecution.expiresAt) > now.getTime(),
        'Replayed merge commit is expired, cancelled, or superseded');
        return receipt.result;
      }
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(row => row.document);
      const work = all.find(item => item.id === id || item.key === id); demand(work, 'Work item not found', 404);
      const execution = work.mergeExecution;
      demand(execution?.id === data.executionId && execution.owner === mergeExecutionOwner(actor, data.executor) && Date.parse(execution.expiresAt) > now.getTime(), ownedByAnother);
      demand(execution.verifiedAt, 'Merge execution has not passed final verification');
      demand(!execution.committingAt, 'Merge execution was already committed; retry with the original idempotency key');
      this.evaluate(work, all, now);
      demand(work.stage === 'merge' && work.gates.every(gate => gate.passed) && !work.violations.length && work.mergeAuthorization
        && work.mergeAuthorization.sha === execution.sha && work.mergeAuthorization.baseSha === execution.baseSha
        && work.mergeAuthorization.policyRevision === execution.policyRevision,
      'Merge authorization changed after final verification; provider merge refused');
      execution.committingAt = now.toISOString();
      await this.recordDispatch(db, work, now);
      await save(db, work, actor.id, 'merge.execution.committed', now, { executionId: execution.id, sha: execution.sha, committingAt: execution.committingAt });
      const result = { key: work.key, executionId: execution.id, sha: execution.sha, committingAt: execution.committingAt, revision: work.revision };
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
      return result;
    });
  }
  async bindReviewRequest(id: string, expectedRevision: number, request: ReviewRequest, jobToken: string) {
    return this.store.transaction(async (db, now) => {
      const job = (await db.query('SELECT 1 FROM jobs WHERE work_id=$1 AND token=$2 AND locked_until>$3', [id, jobToken, now])).rows[0];
      requireCurrent(job, 'Integration job lease expired or superseded');
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document);
      const work = all.find(w => w.id === id);
      requireCurrent(work && work.revision === expectedRevision && work.stage !== 'done' && !work.observation?.merged, 'Task changed during review dispatch');
      demand(!holdsMergeExecution(work, now.getTime()), 'Merge execution is active');
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
      demand(!holdsMergeExecution(work, now.getTime()), 'Merge execution is active');
      requireCurrent(work.queue && speculation.policyRevision === work.policyRevision, 'Queue entry or policy changed while the speculative tip was built');
      const carry = work.candidate && speculation.tip !== work.candidate.sha ? this.decideTipCarry(work, all, speculation, now) : null;
      work.queue!.speculation = { ...speculation, carry };
      work.queueHistory = [...(work.queueHistory ?? []), { at: now.toISOString(), event: 'predicted' as const, sequence: work.queue!.sequence, tip: speculation.tip }].slice(-queueHistoryLimit);
      this.evaluate(work, all, now);
      if (carry) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', 'queue.carry', JSON.stringify({ details: { ...carry, merge: speculation.merge ?? null } })]);
      await this.recordDispatch(db, work, now);
      await save(db, work, 'graphyard', 'queue.predicted', now, { tip: speculation.tip, base: speculation.base, ref: speculation.ref, predecessors: speculation.predecessors,
        ...(carry ? { carry: { approval: carry.approval.carried ? 'carried' : 'required', evidence: Object.fromEntries(carry.evidence.map(entry => [entry.proof, entry.carried ? 'carried' : 'required'])) } } : {}) });
      await wakeJob(db, work.id);
      return work;
    });
  }
  /** The carry decision for a tip that replaced the candidate's head; see model/carry.ts for the rule. */
  private decideTipCarry(work: Work, all: Work[], speculation: QueueSpeculation, now: Date) {
    const candidate = work.candidate!, observation = work.observation;
    const aheadKey = speculation.predecessors.at(-1) ?? null;
    const ahead = aheadKey ? all.find(item => item.key === aheadKey) : undefined;
    // The base branch is validated by definition. A queue entry is validated when every gate
    // passes on exactly the tip predicted here, the merge gate refusing only for its turn.
    const validated = !aheadKey ? true : !!ahead && ahead.stage === 'merge' && ahead.candidate?.sha === speculation.base && !ahead.violations.length
      && ahead.gates.every(gate => gate.passed || gate.name === 'merge' && gate.reasons.every(queueSequencingReason));
    const observed = !!observation && observation.candidate.sha === candidate.sha && observation.candidate.baseSha === candidate.baseSha;
    return decideCarry({
      from: { sha: candidate.sha, baseSha: candidate.baseSha }, to: { sha: speculation.tip, baseSha: speculation.base }, policyRevision: work.policyRevision, at: now.toISOString(),
      merge: speculation.merge, predecessor: { key: aheadKey, validated }, reviewedFiles: observed ? observation!.files : [],
      approval: bindingApproval(work), proofs: requiredProofs(work, all).map(proof => ({ proof, evidence: currentEvidence(work, proof, now) })),
      app: this.controlPlaneAppId ? `control-plane (App ${this.controlPlaneAppId})` : 'control-plane',
    });
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
      demand(!holdsMergeExecution(work, now.getTime()), 'Merge execution is active');
      requireCurrent(!work.queue && refresh.policyRevision === work.policyRevision
        && work.candidate?.sha === refresh.from.sha && work.candidate.baseSha === refresh.from.baseSha, 'Candidate, queue entry or policy changed while the base was refreshed');
      const carry = refresh.head && refresh.head !== refresh.from.sha ? this.decideBaseRefreshCarry(work, all, refresh, now) : null;
      work.baseRefresh = { ...refresh, carry };
      this.evaluate(work, all, now);
      if (carry) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', 'base.carry', JSON.stringify({ details: { ...carry, merge: refresh.merge ?? null } })]);
      await this.recordDispatch(db, work, now);
      await save(db, work, 'graphyard', refresh.conflict ? 'base.conflict' : 'base.refreshed', now, { from: refresh.from, base: refresh.base, head: refresh.head,
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
  /** Removes an entry whose speculative validation cannot succeed, with the reason on the record. */
  async ejectFromQueue(id: string, expectedRevision: number, reason: string, jobToken: string) {
    return this.store.transaction(async (db, now) => {
      const job = (await db.query('SELECT 1 FROM jobs WHERE work_id=$1 AND token=$2 AND locked_until>$3', [id, jobToken, now])).rows[0];
      requireCurrent(job, 'Integration job lease expired or superseded');
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document);
      const work = all.find(w => w.id === id);
      requireCurrent(work && work.revision === expectedRevision && work.stage !== 'done', 'Task changed before the queue ejection');
      requireCurrent(work.queue, 'Queue entry already left the merge queue');
      const sequence = work.queue!.sequence;
      work.queueEjection = { at: now.toISOString(), sequence, reason, sha: work.candidate?.sha ?? null, policyRevision: work.policyRevision };
      work.queueHistory = [...(work.queueHistory ?? []), { at: now.toISOString(), event: 'ejected' as const, sequence, reason, ...(work.queue!.speculation ? { tip: work.queue!.speculation.tip } : {}) }].slice(-queueHistoryLimit);
      work.queue = null;
      this.evaluate(work, all, now);
      await this.recordDispatch(db, work, now);
      await save(db, work, 'graphyard', 'queue.ejected', now, { sequence, reason });
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
      demand(!holdsMergeExecution(work, now.getTime()), 'Merge execution is active');
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
    const result = evaluate(work, all, now, this.ciAppIds);
    if (work.stage !== result.stage) work.stageEnteredAt = now.toISOString();
    Object.assign(work, result);
    if (work.gates.some(g => !g.passed) || work.violations.length) work.mergeAuthorization = null;
    else if (work.candidate && !work.observation?.merged && (!work.mergeAuthorization || work.mergeAuthorization.sha !== work.candidate.sha || work.mergeAuthorization.baseSha !== work.candidate.baseSha)) {
      work.mergeAuthorization = { sha: work.candidate.sha, baseSha: work.candidate.baseSha, policyRevision: work.policyRevision, at: now.toISOString() };
    }
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
    reconcileActions(work, all, now, { next: computed });
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
  }
  async reconcile() {
    await this.store.transaction(async (db, now) => {
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document);
      for (const work of all) {
        if (work.stage === 'done') continue;
        const before = JSON.stringify(work);
        preserveAssignment(work); retainQuarantineFence(work);
        const executing = holdsMergeExecution(work, now.getTime());
        const leaseLost = !!work.lease && Date.parse(work.lease.expiresAt) <= now.getTime();
        // An in-flight merge execution defers reconciliation, but never a lease
        // loss: that escalation must reach the record and fence the execution
        // rather than wait for it, so delivery cannot outrun the concern. A
        // committed execution is retired only by the GitHub observation that
        // settles its provider outcome, never by reconciliation.
        if (executing && !leaseLost) continue;
        if (!executing && work.mergeExecution) work.mergeExecution = null;
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
        if (JSON.stringify(work) !== before) {
          for (const entry of ledger) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', entry.kind, JSON.stringify({ details: { ...entry.details, at: now.toISOString() } })]);
          await this.recordDispatch(db, work, now);
          await save(db, work, 'graphyard', 'reconciled', now, ledger.length ? { ledger: ledger.map(entry => entry.kind) } : undefined);
          if (work.submission) await wakeJob(db, work.id);
          if (ejected) for (const behind of all) if (behind.queue && behind.id !== work.id) await wakeJob(db, behind.id);
        }
      }
    });
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
      const execution = work.mergeExecution ?? null;
      const activeExecution = execution && Date.parse(execution.expiresAt) > now.getTime() ? execution : null;
      if (activeExecution && (!observation.merged || observation.candidate.sha !== activeExecution.sha || observation.candidate.baseSha !== activeExecution.baseSha)) throw new MergeExecutionInProgress('Merge execution is active; reconciliation is deferred unless GitHub observes its matching merge');
      // A committed execution outlives its expiry on the record. Only an observation taken after
      // the authority lapsed can rule the provider merge out: an earlier unmerged reading leaves
      // the in-flight call unresolved, so the record stays frozen and revocation stays refused.
      if (execution?.committingAt && !activeExecution && !observation.merged && !(Date.parse(observation.at) >= Date.parse(execution.expiresAt)))
        throw new MergeExecutionInProgress('Committed merge execution awaits an observation taken after its authority expired; reconciliation is deferred');
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
      if (observation.merged && observation.mergedAt && Number.isFinite(Date.parse(observation.mergedAt))) {
        const providerMergedTime = Date.parse(observation.mergedAt);
        // Never allow evidence from after the earliest possible merge instant.
        // Whole-second timestamps can therefore conservatively refuse same-second authorization.
        const acquired = (await db.query("SELECT payload->'work'->'mergeExecution' AS execution FROM events WHERE work_id=$1 AND kind IN ('merge.execution.acquired','merge.execution.verified','merge.execution.committed') ORDER BY seq DESC LIMIT 1", [id])).rows[0]?.execution as Work['mergeExecution'] | undefined;
        const boundedExecution = activeExecution ?? acquired ?? null;
        const offset = boundedExecution?.clockOffset;
        const mergedTime = providerMergedTime + (offset?.min ?? 0);
        // The lower bound of the offset, so the recorded instant is the earliest the merge
        // can have happened on the repository clock and a derived duration is never
        // inflated by skew. The bound is narrow: `verifyMerge` refuses an offset
        // observation wider than 20 seconds, so the true instant is at most that far later.
        if (offset) { repositoryClockOffsetMs = offset.min; mergedAtRepository = new Date(mergedTime).toISOString(); }
        const cutoff = providerMergedTime + (/\.\d+Z$/.test(observation.mergedAt) ? 1 : 1000) + (offset?.max ?? 0);
        // Every authorization path below requires `executionValid`, which bounds
        // `cutoff` by the execution expiry, and `acquireMerge` bounds that expiry by the
        // earliest required-evidence expiry. So evidence live at authorization is still
        // live at `cutoff - 1`, the same instant the historical check uses.
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
        if (activeExecution && executionValid && work.mergeAuthorization
          && activeExecution.sha === observation.candidate.sha && activeExecution.baseSha === observation.candidate.baseSha
          && activeExecution.policyRevision === work.policyRevision && work.mergeAuthorization.sha === activeExecution.sha
          && work.mergeAuthorization.baseSha === activeExecution.baseSha && work.mergeAuthorization.policyRevision === activeExecution.policyRevision
          && work.gates.every(gate => gate.passed) && !work.violations.length) {
          authorizedSnapshot = structuredClone(work); authorizationRevision = activeExecution.authorizationRevision;
        }
        // The record as it stood immediately before the merge: what the historical authorization
        // check reads, and what a two-party reconciliation re-checks (GY-92). The cutoff carries
        // the clock-offset allowance so an authorization recorded up to the merge instant on the
        // repository clock still counts, but that allowance admits no post-merge record (GY-94):
        // a snapshot whose own observation already reports this pull request merged was written
        // after the merge, whatever its timestamp, and carries the merge's consequences.
        const past = authorizedSnapshot ? undefined : (await db.query(`SELECT payload->'work' AS work FROM events WHERE work_id=$1 AND created_at<$2 AND payload ? 'work'
          AND NOT COALESCE((payload->'work'->'observation'->>'merged')::boolean AND (payload->'work'->'observation'->'candidate'->>'pr')::int=$3, false) ORDER BY seq DESC LIMIT 1`, [id, new Date(cutoff), observation.candidate.pr])).rows[0]?.work as Work | undefined;
        const historical = past ? historicalAuthorizationRefusals(past, all, observation, cutoff, mergedTime) : ['No record of the item precedes the merge cutoff'];
        if (!authorizedSnapshot && past && executionValid && !historical.length) {
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
      work.candidate = observation.candidate;
      work.observation = observation;
      // Snapshot all provider review identities after the revision. Approvals in this
      // first observation never count, regardless of clock skew or future reevaluation.
      if (work.formalReviewResetRequired && reviewProviderOf(work.policy) === 'github' && !work.formalReviewBaseline && observation.reviewIds
        && observation.reviewIds.every(id => Number.isSafeInteger(id) && id > 0)
        && observation.reviews.every(r => Number.isSafeInteger(r.id) && observation.reviewIds!.includes(r.id!))) {
        work.formalReviewBaseline = { pr: observation.candidate.pr, policyRevision: work.policyRevision, reviewIds: [...observation.reviewIds] };
      }
      this.evaluate(work, all, now);
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
          if (reconciliation || operatorAuthorization) work.violations = work.violations.filter(entry => entry !== violation && !entry.startsWith(reconciliationRefusalPrefix));
          else if (work.gates.some(g => !g.passed)) work.violations.push('Post-merge checks differ from the recorded authorization; follow-up required');
          work.stage = 'done'; work.stageEnteredAt = now.toISOString();
          work.mergeExecution = null;
          const delivery: Work['delivery'] = { mergedAt: observation.mergedAt!, mergeSha: observation.mergeSha, authorizationRevision: authorizationRevision!, ...(evidenceAsOf ? { evidenceAsOf } : {}),
            ...(mergedAtRepository ? { mergedAtRepository, repositoryClockOffsetMs: repositoryClockOffsetMs! } : {}) };
          work.delivery = reconciliation ? Object.assign(delivery, { reconciliation }) : operatorAuthorization ? Object.assign(delivery, { operatorAuthorization }) : delivery;
          if (reconciliation) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, reconciliation.requestedBy, 'merge.reconciled',
            JSON.stringify({ details: { ...reconciliation, mergeSha: observation.mergeSha, mergedAt: observation.mergedAt, authorizationRevision, evidenceAsOf, gatesNow: work.gates.filter(gate => !gate.passed).map(gate => ({ name: gate.name, reasons: gate.reasons })), at: now.toISOString() } })]);
          if (operatorAuthorization) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, operatorAuthorization.operator, 'merge.operator-authorized',
            JSON.stringify({ details: { ...operatorAuthorization, mergeSha: observation.mergeSha, mergedAt: observation.mergedAt, authorizationRevision, evidenceAsOf, gatesNow: work.gates.filter(gate => !gate.passed).map(gate => ({ name: gate.name, reasons: gate.reasons })), at: now.toISOString() } })]);
          await db.query('DELETE FROM jobs WHERE work_id=$1', [work.id]);
          // The queue shifted: every entry behind this one has a new position and predicted base.
          for (const behind of all) if (behind.queue && behind.id !== work.id) await wakeJob(db, behind.id);
        } else {
          work.mergeExecution = null;
          if (!work.violations.includes(violation)) work.violations.push(violation);
          if (refusedReconciliation) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', 'merge.reconciliation.refused',
            JSON.stringify({ details: { ...refusedReconciliation, mergeSha: observation.mergeSha, mergedAt: observation.mergedAt, at: now.toISOString() } })]);
        }
      } else if (execution && !activeExecution) {
        // GitHub answered for the lapsed authority: the pull request is still unmerged after it
        // expired, so the execution — committed or not — is reconciled and the record reopens.
        work.mergeExecution = null;
      }
      // A queue entry the evaluation derived out is recorded as an ejection, and every entry behind
      // it is woken to predict against the real base. For a merged entry that could never publish
      // a speculative tip, the ejection is its refused reconciliation (GY-94): nothing is delivered,
      // and the ledger keeps the refusal and the exit side by side.
      if (queuedBefore !== null && !work.queue && work.queueEjection?.sequence === queuedBefore) {
        await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', 'queue.ejected',
          JSON.stringify({ details: { sequence: queuedBefore, reason: work.queueEjection.reason, ...(refusedReconciliation ? { decision: refusedReconciliation.decision, mergeSha: observation.mergeSha } : {}), at: now.toISOString() } })]);
        for (const behind of all) if (behind.queue && behind.id !== work.id) await wakeJob(db, behind.id);
      }
      await this.recordDispatch(db, work, now);
      await save(db, work, 'github', 'github.observed', now);
      return work;
    });
  }
}
