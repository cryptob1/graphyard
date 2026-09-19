import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, save, wakeJob } from './store.js';
import { authorizedForProof, unauthorizedProofs } from './proof-grants.js';
import { workspacePath, pathsOverlap, validBranch } from './workspace.js';
import { activeLease, admin, assertReviewerProfiles, operatorCapability, escalationTriggers, holdsMergeExecution, MergeExecutionInProgress, providerDelayAfterVerification, raiseEscalation, releaseLeadHold, resolveEscalation, standingEscalations, attestationFor, attestationKinds, attestationsFromLedger, leaseLapseCause, leaseLossEpoch, leaseLossReason, settleableLeaseLoss, submittedEpoch, type Attestation, requireCurrent, createSchema, criterionSchema, currentEvidence, decideCarry, deploySmokeProof, deploySmokeRequired, evidenceBindsCandidate, exactApproval, inheritedObligations, pathScopeContains, requiredProofs, resourcesSchema, demand, evaluate, exhaustedReviewerProfiles, proofSchema, reviewerProfileFor, reviewerProfileSchema, reviewProviders, reviewProviderOf, type Criterion, type Evidence, type Principal, type ReviewerApp, type ReviewFailover, type Work, type Observation, type ReviewRequest, type OperatorCapability } from './model.js';
import { resourceConflicts } from './coordination.js';
import { containmentAttestation, containmentSettlementRefusals, containmentVerificationSchema } from './quarantine.js';
import { activeEngineers, delegationLimits, implementerIdentities, leadMay, producerIndependenceRefusal, sessionKind } from './delegation.js';
import { queueHistoryLimit, queueSequencingReason, type QueueSpeculation } from './merge-queue.js';
import { githubFromEnv } from './github.js';
import { regressionRefusals } from './regression-guard.js';
import { ciFamilyAllows, ciProofFamilies, ciRunBindingSchema, ciRunRefusal, isCiProducer, refuseCiProducer, staleCiAttemptRefusal, type CiRunObservation } from './model/ci-proofs.js';
import { reconcileAutoDispatch, type DispatchTransition } from './model/dispatch.js';

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
} as const;
const mergeAcquireSchema = z.object({ expectedRevision: z.number().int().positive(), sha, baseSha: sha, policyRevision: z.number().int().positive() }).strict();
const mergeCancelSchema = z.object({ executionId: z.string().uuid(), reason: z.string().trim().min(1).max(2000) }).strict();
const mergeVerifySchema = z.object({ executionId: z.string().uuid() }).strict();
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
  submissionObserver: ((work: Work) => Promise<Observation>) | null | undefined = undefined;
  // Auto-dispatch transitions the last evaluation of a document produced, written to the ledger
  // by the transaction that persists it. Keyed by the object, so a probe clone records nothing.
  private dispatchTransitions = new WeakMap<Work, DispatchTransition[]>();
  // The launch fence is a deployment-independent safety default; only tests shorten it.
  constructor(public store: Store, public ciAppIds: number[] = [15368], public leaseSeconds = 120, public repository = process.env.GITHUB_REPOSITORY ?? '', public launchFence = launchFenceMs) {}
  private async observeSubmission(actor: Principal, id: string | null, data: { epoch: number; pr: number }, key: string): Promise<Observation | null> {
    if (this.submissionObserver === undefined) { const github = await githubFromEnv(); this.submissionObserver = github ? probe => github.observe(probe) : null; }
    if (!this.submissionObserver || !id) return null;
    // A replayed submission returns its receipt; it must not depend on the provider again.
    if ((await this.store.pool.query('SELECT 1 FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rowCount) return null;
    const work = (await this.store.list()).find(w => w.id === id || w.key === id);
    if (!work || work.stage === 'done' || !work.workspaces.some(w => w.epoch === data.epoch)) return null;
    return this.submissionObserver({ ...work, submission: { epoch: data.epoch, pr: data.pr } });
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
        demand(receipt.fingerprint === fingerprint, 'Idempotency key reused with different input');
        if (actor.role === 'operator-agent') authorizeOperatorCommand(actor, command, data, receipt.result as Work, this.repository);
        return receipt.result as Work;
      }
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document);
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
        demand(!work.containmentQuarantine, `Task is quarantined by unverified containment from epoch ${work.containmentQuarantine?.epoch}; requirements remain immutable until settlement or stopped-worker recovery`);
        demand(!work.lease || Date.parse(work.lease.expiresAt) <= now.getTime(), 'Stop and release the active worker before revising requirements');
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
        work.lease = null; work.observation = null; work.mergeAuthorization = null; work.reviewRequest = null;
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
        }
        work.epoch++;
        work.implementers = [...new Set([...implementerIdentities(work), actor.id])];
        work.lastAssignment = { owner: actor.id, epoch: work.epoch, claimedAt: now.toISOString(), ...(actor.displayName ? { displayName: actor.displayName } : {}), ...(actor.runtime ? { runtime: actor.runtime } : {}) };
        work.lease = { owner: actor.id, epoch: work.epoch, expiresAt: new Date(now.getTime() + this.leaseSeconds * 1000).toISOString() };
      }
      // The lease a worker submitted under ended at that submission. A supervisor that keeps
      // renewing it is told so, rather than left to read the loss as a superseded epoch.
      if ((command === 'heartbeat' || command === 'release') && !work.lease && submittedEpoch(work, data.epoch))
        demand(false, `Implementation lease for epoch ${data.epoch} ended when ${work.key} was submitted; stop heartbeating after complete`);
      if (['heartbeat', 'release', 'workspace', 'submit', 'blocked', 'quarantine', 'launch'].includes(command)) activeLease(work, actor, data.epoch, now);
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
      if (command === 'release') work.lease = null;
      if (command === 'blocked') work.blocker = data.reason;
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
      retainQuarantineFence(work);
      // Delivery is an immutable snapshot. A late containment cleanup or a post-deployment fact may
      // append its audit/revision metadata, but stale inputs must not re-evaluate it.
      if (!deliveredContainmentCleanup && !postDeployment) this.evaluate(work, all, now);
      await this.recordDispatch(db, work, now);
      await save(db, work, actor.id, command, now, command === 'settle' ? { epoch: data.epoch } : actor.role === 'operator-agent' ? { before, intent: data, reason: data.reason ?? null } : data);
      if (work.submission && !postDeployment && !['heartbeat', 'release', 'claim', 'workspace'].includes(command)) await wakeJob(db, work.id);
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(work)]);
      return work;
    });
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
        demand(receipt.fingerprint === fingerprint, 'Idempotency key reused with different input');
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
      const execution = { id: randomUUID(), owner: actor.id, sha: data.sha, baseSha: data.baseSha, policyRevision: data.policyRevision, authorizationRevision: work.revision, issuedAt: now.toISOString(), expiresAt: new Date(expiresAt).toISOString() };
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
      if (receipt) { demand(receipt.fingerprint === fingerprint, 'Idempotency key reused with different input'); return receipt.result; }
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(row => row.document);
      const work = all.find(item => item.id === id || item.key === id);
      demand(work, 'Work item not found', 404);
      demand(work.mergeExecution?.id === data.executionId && work.mergeExecution.owner === actor.id, 'Merge execution is missing, expired, superseded, or owned by another coordinator');
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
      demand(receipt.fingerprint === fingerprint, 'Idempotency key reused with different input');
      const work = (await db.query('SELECT document FROM work_items WHERE id::text=$1 OR document->>\'key\'=$1', [id])).rows[0]?.document as Work | undefined;
      demand(work?.mergeExecution?.id === data.executionId && work.mergeExecution.owner === actor.id && work.mergeExecution.verifiedAt === receipt.result.verifiedAt
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
        demand(receipt.fingerprint === fingerprint, 'Idempotency key reused with different input');
        const current = (await db.query('SELECT document FROM work_items WHERE id::text=$1 OR document->>\'key\'=$1', [id])).rows[0]?.document as Work | undefined;
        demand(current?.mergeExecution?.id === data.executionId && current.mergeExecution.owner === actor.id && current.mergeExecution.verifiedAt === receipt.result.verifiedAt
          && !current.mergeExecution.fenced && Date.parse(current.mergeExecution.expiresAt) > now.getTime(), 'Replayed merge verification is expired, cancelled, fenced, or superseded');
        return receipt.result;
      }
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(row => row.document);
      const work = all.find(item => item.id === id || item.key === id); demand(work, 'Work item not found', 404);
      const execution = work.mergeExecution;
      demand(execution?.id === data.executionId && execution.owner === actor.id && Date.parse(execution.expiresAt) > now.getTime(), 'Merge execution is missing, expired, superseded, or owned by another coordinator');
      demand(!execution.verifiedAt, 'Merge execution was already verified; retry with the original idempotency key');
      demand(!execution.fenced, `Merge execution was fenced and cannot be verified: ${execution.fenced?.reason}`);
      demand(!observation.merged && observation.prState === 'open' && observation.draft === false, 'Pull request is no longer open and ready for merge');
      demand(observation.candidate.sha === execution.sha && observation.candidate.baseSha === execution.baseSha && observation.candidate.pr === work.submission?.pr
        && work.workspaces.some(workspace => workspace.epoch === work.submission!.epoch && workspace.branch === observation.candidate.branch), 'GitHub candidate changed during merge execution');
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
        demand(receipt.fingerprint === fingerprint, 'Idempotency key reused with different input');
        const current = (await db.query('SELECT document FROM work_items WHERE id::text=$1 OR document->>\'key\'=$1', [id])).rows[0]?.document as Work | undefined;
        demand(current?.mergeExecution?.id === data.executionId && current.mergeExecution.owner === actor.id
          && current.mergeExecution.committingAt === receipt.result.committingAt && Date.parse(current.mergeExecution.expiresAt) > now.getTime(),
        'Replayed merge commit is expired, cancelled, or superseded');
        return receipt.result;
      }
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(row => row.document);
      const work = all.find(item => item.id === id || item.key === id); demand(work, 'Work item not found', 404);
      const execution = work.mergeExecution;
      demand(execution?.id === data.executionId && execution.owner === actor.id && Date.parse(execution.expiresAt) > now.getTime(), 'Merge execution is missing, expired, superseded, or owned by another coordinator');
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
      approval: exactApproval(work), proofs: requiredProofs(work, all).map(proof => ({ proof, evidence: currentEvidence(work, proof, now) })),
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
        this.evaluate(work, all, now);
        if (JSON.stringify(work) !== before) {
          for (const entry of ledger) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, 'graphyard', entry.kind, JSON.stringify({ details: { ...entry.details, at: now.toISOString() } })]);
          await this.recordDispatch(db, work, now);
          await save(db, work, 'graphyard', 'reconciled', now, ledger.length ? { ledger: ledger.map(entry => entry.kind) } : undefined);
          if (work.submission) await wakeJob(db, work.id);
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
        const past = authorizedSnapshot || !executionValid ? undefined : (await db.query("SELECT payload->'work' AS work FROM events WHERE work_id=$1 AND created_at<$2 AND payload ? 'work' ORDER BY seq DESC LIMIT 1", [id, new Date(cutoff)])).rows[0]?.work as Work | undefined;
        const authorization = past?.mergeAuthorization;
        // Exactly the acceptance gate's demand at the merge cutoff: a bootstrap criterion's
        // deferred proofs are excluded, and an inherited obligation is re-checked here too.
        const evidenceValid = past ? requiredProofs(past, all).every(proof => !!currentEvidence(past, proof, new Date(cutoff - 1))) : false;
        if (!authorizedSnapshot && past && authorization && authorization.sha === observation.candidate.sha && authorization.baseSha === observation.candidate.baseSha && authorization.policyRevision === past.policyRevision
          && past.submission?.pr === observation.candidate.pr && past.gates.every(g => g.passed) && !past.violations.length
          && evidenceValid && past.observation && cutoff - Date.parse(past.observation.at) < 120_000 && Date.parse(authorization.at) < mergedTime) {
          authorizedSnapshot = past; authorizationRevision = boundedExecution?.authorizationRevision ?? past.revision;
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
        const violation = 'Merge observed without a prior authorization for this candidate';
        if (authorizedSnapshot && observation.mergeSha) {
          if (work.gates.some(g => !g.passed)) work.violations.push('Post-merge checks differ from the recorded authorization; follow-up required');
          work.stage = 'done'; work.stageEnteredAt = now.toISOString();
          work.mergeExecution = null;
          work.delivery = { mergedAt: observation.mergedAt!, mergeSha: observation.mergeSha, authorizationRevision: authorizationRevision!, ...(evidenceAsOf ? { evidenceAsOf } : {}),
            ...(mergedAtRepository ? { mergedAtRepository, repositoryClockOffsetMs: repositoryClockOffsetMs! } : {}) };
          await db.query('DELETE FROM jobs WHERE work_id=$1', [work.id]);
          // The queue shifted: every entry behind this one has a new position and predicted base.
          for (const behind of all) if (behind.queue && behind.id !== work.id) await wakeJob(db, behind.id);
        } else {
          work.mergeExecution = null;
          if (!work.violations.includes(violation)) work.violations.push(violation);
        }
      } else if (execution && !activeExecution) {
        // GitHub answered for the lapsed authority: the pull request is still unmerged after it
        // expired, so the execution — committed or not — is reconciled and the record reopens.
        work.mergeExecution = null;
      }
      await this.recordDispatch(db, work, now);
      await save(db, work, 'github', 'github.observed', now);
      return work;
    });
  }
}
