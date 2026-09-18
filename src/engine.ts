import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, save, wakeJob } from './store.js';
import { authorizedForProof, unauthorizedProofs } from './proof-grants.js';
import { workspacePath, pathsOverlap, validBranch } from './workspace.js';
import { activeLease, admin, assertReviewerProfiles, operatorCapability, MergeExecutionInProgress, requireCurrent, createSchema, criterionSchema, currentEvidence, deploySmokeProof, deploySmokeRequired, inheritedObligations, pathScopeContains, requiredProofs, resourcesSchema, demand, evaluate, exhaustedReviewerProfiles, proofSchema, reviewerProfileFor, reviewerProfileSchema, reviewProviders, reviewProviderOf, type Criterion, type Principal, type ReviewerApp, type ReviewFailover, type Work, type Observation, type ReviewRequest, type OperatorCapability } from './model.js';
import { resourceConflicts } from './coordination.js';
import { containmentAttestation, containmentSettlementRefusals, containmentVerificationSchema } from './quarantine.js';
import { queueHistoryLimit, type QueueSpeculation } from './merge-queue.js';

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
  availability: z.enum(['available', 'expired', 'redacted', 'missing', 'external']), url: publicArtifactUrl.optional(),
}).strict().refine(value => value.availability === 'external' ? !!value.url : !value.url, 'Only external artifacts may carry a public URL');
// Longer than acknowledgeContainment's three 30-second HTTP attempts plus retry delays.
export const launchFenceMs = 120_000;
const commands = {
  create: createSchema.extend({ reason: z.string().trim().min(1).max(2000).optional() }),
  ready: z.object({ expectedRevision: z.number().int().positive().optional(), reason: z.string().trim().min(1).max(2000).optional() }).strict(),
  requirements: z.object({ expectedPolicyRevision: z.number().int().positive(), reason: z.string().trim().min(1).max(2000), criteria: z.array(criterionSchema).min(1).max(50), dependencies: z.array(z.string().uuid()).max(50), plannedFiles: createSchema.shape.plannedFiles, exclusiveResources: resourcesSchema }).strict(),
  reviewpolicy: z.object({ provider: z.enum(reviewProviders), reviewerProfiles: z.array(reviewerProfileSchema).min(1).max(10).optional(), expectedPolicyRevision: z.number().int().positive(), reason: z.string().trim().min(1).max(2000) }).strict(),
  unblock: z.object({ reason: z.string().trim().min(1).max(2000), expectedRevision: z.number().int().positive().optional() }).strict(),
  rework: z.object({ reason: z.string().min(1).max(2000), previousWorkerStopped: z.literal(true) }).strict(),
  recover: z.object({ reason: z.string().min(1).max(2000), previousWorkerStopped: z.literal(true) }).strict(),
  claim: z.object({}).strict(),
  rereview: z.object({ epoch: epoch.optional() }).strict(),
  heartbeat: z.object({ epoch }).strict(),
  quarantine: z.object({ epoch, settlementHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  launch: z.object({ epoch, settlementHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  settle: z.object({ epoch, settlementToken: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  autosettle: z.object({ epoch, settlementHash: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().trim().min(1).max(2000), verification: containmentVerificationSchema }).strict(),
  release: z.object({ epoch }).strict(),
  workspace: z.object({ epoch, host: z.string().trim().min(1).max(200), path: z.string().startsWith('/').max(1000).refine(p => !/[\u0000-\u001f]/.test(p), 'Invalid path').transform(workspacePath), branch: z.string().max(200).refine(validBranch, 'Invalid Graphyard branch name') }).strict(),
  submit: z.object({ epoch, pr: z.number().int().positive() }).strict(),
  blocked: z.object({ epoch, reason: z.string().max(2000).nullable() }).strict(),
  evidence: z.object({ proof: proofSchema, sha, baseSha: sha, policyRevision: z.number().int().positive(), result: z.enum(['pass', 'fail']), executed: z.number().int().min(0), skipped: z.number().int().min(0), url: publicArtifactUrl.optional(), artifacts: z.array(evidenceArtifact).max(30).optional(), scenarioRevision: z.number().int().positive().optional(), environment: z.string().min(1).max(100).optional() }).strict(),
  // The coordinator's observation of the running release covering a delivered merge. It names the
  // serving commit and where it was read; whether it is exact is derived, never asserted.
  deployment: z.object({ sha, mergeSha: sha, source: z.enum(['endpoint', 'github-deployment']), observedAt: z.iso.datetime() }).strict(),
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
export class Engine {
  operatorAuthorizer?: (db: any, now: Date, actor: Principal) => Promise<Principal>;
  // The configured credential registry, used to report which required proof names
  // currently have an authorized producer. Authority itself lives in the grant store.
  principals: Principal[] = [];
  // Reviewer identities and the control-plane App are deployment facts, not client input.
  reviewerApps: ReviewerApp[] = [];
  controlPlaneAppId?: number;
  constructor(public store: Store, public ciAppIds: number[] = [15368], public leaseSeconds = 120, public repository = process.env.GITHUB_REPOSITORY ?? '') {}
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
  async execute(actor: Principal, command: Command, id: string | null, input: unknown, key: string) {
    demand(Object.hasOwn(commands, command), 'Unknown command', 404);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const data: any = commands[command].parse(input);
    const fingerprint = createHash('sha256').update(JSON.stringify({ command, id, data })).digest('hex');
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
        work!.proofGaps = await unauthorizedProofs(db, this.principals, proofNames);
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
      if (!containmentCleanup.includes(command) && !postDeployment && work.mergeExecution && Date.parse(work.mergeExecution.expiresAt) <= now.getTime()) work.mergeExecution = null;
      demand(!work.mergeExecution || command === 'heartbeat' || containmentCleanup.includes(command) || postDeployment, 'A merge execution is active; retry after it completes or expires');
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
        work.retiredCriterionIds = [...(work.retiredCriterionIds ?? []), ...work.criteria.filter(ac => !data.criteria.some((next: { id: string }) => next.id === ac.id)).map(ac => ac.id)];
        work.criteria = revised;
        work.dependencies = data.dependencies; work.plannedFiles = data.plannedFiles; work.exclusiveResources = data.exclusiveResources;
        work.scenarioRequirements = pins; work.policyRevision++;
        this.refuseRenewedDeferral(work, all);
        work.proofGaps = await unauthorizedProofs(db, this.principals, proofs);
        work.formalReviewResetRequired = true; work.formalReviewBaseline = undefined;
        work.lease = null; work.observation = null; work.mergeAuthorization = null; work.reviewRequest = null;
        // A submitted implementation must be explicitly reconsidered for changed intent.
        if (work.submission) work.reworkRequested = true;
      }
      if (command === 'ready') { if (actor.role !== 'operator-agent') admin(actor); work.ready = true; }
      if (command === 'unblock') { if (actor.role !== 'operator-agent') admin(actor); work.blocker = null; }
      if (command === 'rework') {
        admin(actor);
        demand(!work.observation?.merged, 'Merged work requires a follow-up task');
        demand(!work.containmentQuarantine || (!work.lease || Date.parse(work.lease.expiresAt) <= now.getTime())
          && (!work.containmentQuarantine.launchExpiresAt || Date.parse(work.containmentQuarantine.launchExpiresAt) <= now.getTime()),
        `Worker startup for epoch ${work.containmentQuarantine?.epoch} remains fenced; stop its supervisor and wait for both lease and launch authority expiry before recovery`);
        work.reworkRequested = true;
        work.containmentQuarantine = null;
        work.lease = null;
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
        work.epoch++;
        work.lastAssignment = { owner: actor.id, epoch: work.epoch, claimedAt: now.toISOString(), ...(actor.displayName ? { displayName: actor.displayName } : {}), ...(actor.runtime ? { runtime: actor.runtime } : {}) };
        work.lease = { owner: actor.id, epoch: work.epoch, expiresAt: new Date(now.getTime() + this.leaseSeconds * 1000).toISOString() };
      }
      if (['heartbeat', 'release', 'workspace', 'submit', 'blocked', 'quarantine', 'launch'].includes(command)) activeLease(work, actor, data.epoch, now);
      if (command === 'heartbeat') work.lease!.expiresAt = new Date(now.getTime() + this.leaseSeconds * 1000).toISOString();
      if (command === 'quarantine') {
        demand(!work.containmentQuarantine || work.containmentQuarantine.owner === actor.id && work.containmentQuarantine.epoch === data.epoch
          && work.containmentQuarantine.settlementHash === data.settlementHash, 'Containment quarantine already exists and cannot be replaced');
        work.containmentQuarantine ??= { owner: actor.id, epoch: data.epoch, at: now.toISOString(), settlementHash: data.settlementHash };
      }
      if (command === 'launch') {
        demand(work.containmentQuarantine?.owner === actor.id && work.containmentQuarantine.epoch === data.epoch
          && work.containmentQuarantine.settlementHash === data.settlementHash,
        'Containment quarantine is missing, superseded, or does not match this launch');
        work.containmentQuarantine.launchAcknowledgedAt ??= now.toISOString();
        work.containmentQuarantine.launchExpiresAt ??= new Date(now.getTime() + launchFenceMs).toISOString();
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
        work.submission = { epoch: data.epoch, pr: data.pr };
        work.reworkRequested = false;
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
        // Trust is decided by the live grant set, never by the deployment environment.
        const trusted = await authorizedForProof(db, actor, data.proof);
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
        const evidence = { ...data, id: randomUUID(), producer: actor.id, trusted, at: now.toISOString() };
        work.evidence.push(evidence);
        if (data.proof === deploySmokeProof) work.delivery!.smoke = { evidenceId: evidence.id, result: data.result, sha: data.sha, mergeSha: data.baseSha, producer: actor.id, at: evidence.at, executed: data.executed, skipped: data.skipped, ...(data.url ? { url: data.url } : {}) };
      }
      retainQuarantineFence(work);
      // Delivery is an immutable snapshot. A late containment cleanup or a post-deployment fact may
      // append its audit/revision metadata, but stale inputs must not re-evaluate it.
      if (!deliveredContainmentCleanup && !postDeployment) this.evaluate(work, all, now);
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
        demand(execution && work.mergeExecution?.id === execution.id
          && Date.parse(execution.expiresAt) > now.getTime() && work.stage === 'merge' && work.gates.every(gate => gate.passed)
          && !work.violations.length && work.candidate?.sha === execution.sha && work.candidate?.baseSha === execution.baseSha
          && work.policyRevision === execution.policyRevision, 'Replayed merge execution is expired, cancelled, or superseded');
        return receipt.result;
      }
      demand(work.revision === data.expectedRevision, 'Task changed before merge execution; retry');
      if (work.mergeExecution && Date.parse(work.mergeExecution.expiresAt) <= now.getTime()) work.mergeExecution = null;
      demand(!work.mergeExecution, 'A merge execution is already active');
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
          && Date.parse(current.mergeExecution.expiresAt) > now.getTime(), 'Replayed merge verification is expired, cancelled, or superseded');
        return receipt.result;
      }
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(row => row.document);
      const work = all.find(item => item.id === id || item.key === id); demand(work, 'Work item not found', 404);
      const execution = work.mergeExecution;
      demand(execution?.id === data.executionId && execution.owner === actor.id && Date.parse(execution.expiresAt) > now.getTime(), 'Merge execution is missing, expired, superseded, or owned by another coordinator');
      demand(!execution.verifiedAt, 'Merge execution was already verified; retry with the original idempotency key');
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
      const providerDelayMs = Math.ceil((now.getTime() + 1) / 1000) * 1000 - now.getTime() + Math.ceil(offset.max - offset.min);
      const result = { key: work.key, executionId: execution.id, sha: execution.sha, verifiedAt: execution.verifiedAt, providerDelayMs, revision: work.revision };
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
      demand(!work.mergeExecution || Date.parse(work.mergeExecution.expiresAt) <= now.getTime(), 'Merge execution is active');
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
      this.evaluate(work, all, now); await save(db, work, 'github', 'review.requested', now); return work;
    });
  }
  /** Records the Graphyard-published speculative tip this candidate must now be validated on. */
  async bindSpeculativeTip(id: string, expectedRevision: number, speculation: QueueSpeculation, jobToken: string) {
    return this.store.transaction(async (db, now) => {
      const job = (await db.query('SELECT 1 FROM jobs WHERE work_id=$1 AND token=$2 AND locked_until>$3', [id, jobToken, now])).rows[0];
      requireCurrent(job, 'Integration job lease expired or superseded');
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document);
      const work = all.find(w => w.id === id);
      requireCurrent(work && work.revision === expectedRevision && work.stage !== 'done' && !work.observation?.merged, 'Task changed while the speculative tip was built');
      demand(!work.mergeExecution || Date.parse(work.mergeExecution.expiresAt) <= now.getTime(), 'Merge execution is active');
      requireCurrent(work.queue && speculation.policyRevision === work.policyRevision, 'Queue entry or policy changed while the speculative tip was built');
      work.queue!.speculation = speculation;
      work.queueHistory = [...(work.queueHistory ?? []), { at: now.toISOString(), event: 'predicted' as const, sequence: work.queue!.sequence, tip: speculation.tip }].slice(-queueHistoryLimit);
      this.evaluate(work, all, now);
      await save(db, work, 'graphyard', 'queue.predicted', now, { tip: speculation.tip, base: speculation.base, ref: speculation.ref, predecessors: speculation.predecessors });
      await wakeJob(db, work.id);
      return work;
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
      demand(!work.mergeExecution || Date.parse(work.mergeExecution.expiresAt) <= now.getTime(), 'Merge execution is active');
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
  }
  async reconcile() {
    await this.store.transaction(async (db, now) => {
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document);
      for (const work of all) {
        if (work.stage === 'done') continue;
        const before = JSON.stringify(work);
        preserveAssignment(work); retainQuarantineFence(work);
        if (work.mergeExecution && Date.parse(work.mergeExecution.expiresAt) > now.getTime()) continue;
        if (work.mergeExecution) work.mergeExecution = null;
        if (work.lease && Date.parse(work.lease.expiresAt) <= now.getTime()) work.lease = null;
        this.evaluate(work, all, now);
        if (JSON.stringify(work) !== before) {
          await save(db, work, 'graphyard', 'reconciled', now);
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
      const activeExecution = work.mergeExecution && Date.parse(work.mergeExecution.expiresAt) > now.getTime() ? work.mergeExecution : null;
      if (activeExecution && (!observation.merged || observation.candidate.sha !== activeExecution.sha || observation.candidate.baseSha !== activeExecution.baseSha)) throw new MergeExecutionInProgress('Merge execution is active; reconciliation is deferred unless GitHub observes its matching merge');
      demand(work.submission?.pr === observation.candidate.pr, 'Unassigned pull request');
      demand(work.workspaces.some(w => w.epoch === work.submission!.epoch && w.branch === observation.candidate.branch), 'PR branch does not match the assigned workspace');
      if (work.stage === 'done') return work;
      let authorizedSnapshot: Work | null = null; let authorizationRevision: number | null = null;
      if (observation.merged && observation.mergedAt && Number.isFinite(Date.parse(observation.mergedAt))) {
        const providerMergedTime = Date.parse(observation.mergedAt);
        // Never allow evidence from after the earliest possible merge instant.
        // Whole-second timestamps can therefore conservatively refuse same-second authorization.
        const acquired = (await db.query("SELECT payload->'work'->'mergeExecution' AS execution FROM events WHERE work_id=$1 AND kind IN ('merge.execution.acquired','merge.execution.verified') ORDER BY seq DESC LIMIT 1", [id])).rows[0]?.execution as Work['mergeExecution'] | undefined;
        const boundedExecution = activeExecution ?? acquired ?? null;
        const offset = boundedExecution?.clockOffset;
        const mergedTime = providerMergedTime + (offset?.min ?? 0);
        const cutoff = providerMergedTime + (/\.\d+Z$/.test(observation.mergedAt) ? 1 : 1000) + (offset?.max ?? 0);
        let cancelledExecution = false;
        if (boundedExecution) {
          const cancellation = (await db.query("SELECT created_at FROM events WHERE work_id=$1 AND kind='merge.execution.cancelled' AND payload->'details'->>'executionId'=$2 AND created_at<$3 ORDER BY seq DESC LIMIT 1", [id, boundedExecution.id, new Date(cutoff)])).rows[0]?.created_at as Date | undefined;
          cancelledExecution = !!cancellation && cancellation.getTime() < cutoff;
        }
        const executionValid = !!boundedExecution && !!offset && !cancelledExecution && boundedExecution.sha === observation.candidate.sha && boundedExecution.baseSha === observation.candidate.baseSha
          && !!boundedExecution.verifiedAt && Date.parse(boundedExecution.issuedAt) <= Date.parse(boundedExecution.verifiedAt)
          && Date.parse(boundedExecution.verifiedAt) < mergedTime && cutoff <= Date.parse(boundedExecution.expiresAt);
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
      if (observation.merged) {
        const violation = 'Merge observed without a prior authorization for this candidate';
        if (authorizedSnapshot && observation.mergeSha) {
          if (work.gates.some(g => !g.passed)) work.violations.push('Post-merge checks differ from the recorded authorization; follow-up required');
          work.stage = 'done'; work.stageEnteredAt = now.toISOString();
          work.mergeExecution = null;
          work.delivery = { mergedAt: observation.mergedAt!, mergeSha: observation.mergeSha, authorizationRevision: authorizationRevision! };
          await db.query('DELETE FROM jobs WHERE work_id=$1', [work.id]);
          // The queue shifted: every entry behind this one has a new position and predicted base.
          for (const behind of all) if (behind.queue && behind.id !== work.id) await wakeJob(db, behind.id);
        } else {
          work.mergeExecution = null;
          if (!work.violations.includes(violation)) work.violations.push(violation);
        }
      }
      await save(db, work, 'github', 'github.observed', now);
      return work;
    });
  }
}
