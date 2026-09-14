import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, save, wakeJob } from './store.js';
import { workspacePath, pathsOverlap, validBranch } from './workspace.js';
import { activeLease, admin, requireCurrent, createSchema, criterionSchema, resourcesSchema, demand, evaluate, proofSchema, type Principal, type Work, type Observation, type ReviewRequest } from './model.js';
import { resourceConflicts } from './coordination.js';

const epoch = z.number().int().positive();
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const commands = {
  create: createSchema,
  ready: z.object({}).strict(),
  requirements: z.object({ expectedPolicyRevision: z.number().int().positive(), reason: z.string().trim().min(1).max(2000), criteria: z.array(criterionSchema).min(1).max(50), dependencies: z.array(z.string().uuid()).max(50), plannedFiles: createSchema.shape.plannedFiles, exclusiveResources: resourcesSchema }).strict(),
  reviewpolicy: z.object({ provider: z.enum(['github', 'codex']), expectedPolicyRevision: z.number().int().positive(), reason: z.string().trim().min(1).max(2000) }).strict(),
  unblock: z.object({ reason: z.string().min(1).max(2000) }).strict(),
  rework: z.object({ reason: z.string().min(1).max(2000), previousWorkerStopped: z.literal(true) }).strict(),
  claim: z.object({}).strict(),
  rereview: z.object({ epoch: epoch.optional() }).strict(),
  heartbeat: z.object({ epoch }).strict(),
  release: z.object({ epoch }).strict(),
  workspace: z.object({ epoch, host: z.string().trim().min(1).max(200), path: z.string().startsWith('/').max(1000).refine(p => !/[\u0000-\u001f]/.test(p), 'Invalid path').transform(workspacePath), branch: z.string().max(200).refine(validBranch, 'Invalid Graphyard branch name') }).strict(),
  submit: z.object({ epoch, pr: z.number().int().positive() }).strict(),
  blocked: z.object({ epoch, reason: z.string().max(2000).nullable() }).strict(),
  evidence: z.object({ proof: proofSchema, sha, baseSha: sha, policyRevision: z.number().int().positive(), result: z.enum(['pass', 'fail']), executed: z.number().int().min(0), skipped: z.number().int().min(0), url: z.string().url().max(2000).optional(), scenarioRevision: z.number().int().positive().optional(), environment: z.string().min(1).max(100).optional() }).strict(),
} as const;
export type Command = keyof typeof commands;

// Old deployments did not persist assignment labels. Preserve the known owner/epoch
// before clearing a legacy lease; its original claim time is unknown.
function preserveAssignment(work: Work) {
  if (work.lease && (!work.lastAssignment || work.lastAssignment.epoch < work.lease.epoch))
    work.lastAssignment = { owner: work.lease.owner, epoch: work.lease.epoch };
}
export class Engine {
  constructor(public store: Store, public ciAppIds: number[] = [15368], public leaseSeconds = 120) {}
  async execute(actor: Principal, command: Command, id: string | null, input: unknown, key: string) {
    demand(Object.hasOwn(commands, command), 'Unknown command', 404);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const data: any = commands[command].parse(input);
    const fingerprint = createHash('sha256').update(JSON.stringify({ command, id, data })).digest('hex');
    return this.store.transaction(async (db, now) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) { demand(receipt.fingerprint === fingerprint, 'Idempotency key reused with different input'); return receipt.result as Work; }
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document);
      let work = all.find(w => w.id === id || w.key === id);
      if (command === 'create') {
        admin(actor);
        demand(data.dependencies.every((dep: string) => all.some(w => w.id === dep)), 'Unknown dependency');
        demand(new Set(data.criteria.map((ac: { id: string }) => ac.id)).size === data.criteria.length, 'Criterion IDs must be unique');
        const scenarioRequirements: Work['scenarioRequirements'] = [];
        const proofNames: string[] = [...new Set<string>(data.criteria.flatMap((ac: { proofs: string[] }) => ac.proofs))];
        for (const proof of proofNames.filter(p => p.startsWith('e2e:'))) {
          const scenario = (await db.query('SELECT document FROM scenarios WHERE id=$1 ORDER BY revision DESC LIMIT 1', [proof.slice(4)])).rows[0]?.document;
          demand(scenario, `Register E2E scenario ${proof.slice(4)} before creating work that requires it`);
          scenarioRequirements.push({ proof, revision: scenario.revision, environment: scenario.environment, hash: scenario.hash });
        }
        const created = now.toISOString();
        work = { ...data, id: randomUUID(), key: '', stage: 'backlog', revision: 0, policyRevision: 1, createdAt: created, updatedAt: created, stageEnteredAt: created,
          ready: false, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements, evidence: [], observation: null, blocker: null, gates: [], violations: [] };
        const inserted = await db.query('INSERT INTO work_items(id,document) VALUES($1,$2) RETURNING number', [work!.id, JSON.stringify(work)]);
        work!.key = `GY-${inserted.rows[0].number}`;
        all.push(work!);
      }
      demand(work, 'Work item not found', 404);
      preserveAssignment(work);
      if (command !== 'create') demand(work.stage !== 'done', 'Delivered work is immutable; create a follow-up task');
      if (command === 'rereview') {
        if (actor.role !== 'admin') { demand(actor.role === 'worker', 'Worker or operator required', 403); activeLease(work, actor, data.epoch, now); }
        demand(work.policy.review && work.policy.reviewProvider === 'codex' && work.submission && !work.observation?.merged, 'Open submitted work with Codex review policy required');
        work.reviewRequest = null; work.observation = null; work.mergeAuthorization = null;
      }
      if (command === 'reviewpolicy') {
        admin(actor);
        demand(!work.observation?.merged, 'Merged work requires a follow-up task');
        demand(work.policy.review, 'Task must already require review');
        demand(work.policyRevision === data.expectedPolicyRevision, 'Policy revision changed; reload before revising');
        demand((work.policy.reviewProvider ?? 'github') !== data.provider, 'Review provider is already selected');
        work.policy = { ...work.policy, reviewProvider: data.provider };
        work.policyRevision++;
        work.reviewNotBefore = now.toISOString();
        work.observation = null; work.mergeAuthorization = null; work.reviewRequest = null;
      }
      if (command === 'requirements') {
        admin(actor);
        demand(!work.observation?.merged, 'Merged work requires a follow-up task');
        demand(!work.lease || Date.parse(work.lease.expiresAt) <= now.getTime(), 'Stop and release the active worker before revising requirements');
        demand(data.expectedPolicyRevision === work.policyRevision, 'Policy revision changed; reload before revising');
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
        work.criteria = data.criteria; work.dependencies = data.dependencies; work.plannedFiles = data.plannedFiles; work.exclusiveResources = data.exclusiveResources;
        work.scenarioRequirements = pins; work.policyRevision++;
        work.reviewNotBefore = now.toISOString();
        work.lease = null; work.observation = null; work.mergeAuthorization = null; work.reviewRequest = null;
        // A submitted implementation must be explicitly reconsidered for changed intent.
        if (work.submission) work.reworkRequested = true;
      }
      if (command === 'ready') { admin(actor); work.ready = true; }
      if (command === 'unblock') { admin(actor); work.blocker = null; }
      if (command === 'rework') {
        admin(actor);
        demand(!work.observation?.merged, 'Merged work requires a follow-up task');
        work.reworkRequested = true;
        work.lease = null;
      }
      if (command === 'claim') {
        demand(actor.role === 'worker' || actor.role === 'admin', 'Worker permission required', 403);
        demand(work.ready && !work.blocker, 'Task is not ready or has a blocker');
        demand(work.dependencies.every(dep => all.find(w => w.id === dep)?.stage === 'done'), 'Unfinished dependencies');
        demand(!work.lease || Date.parse(work.lease.expiresAt) <= now.getTime(), 'Task already has an active owner');
        demand(!work.submission || work.reworkRequested, 'Implementation is submitted; an operator must request rework before reassignment');
        const resources = resourceConflicts(work, all, now.getTime());
        demand(!resources.length, `Exclusive resources held: ${resources.map(r => `${r.resource} by ${r.key}`).join(', ')}`);
        work.epoch++;
        work.lastAssignment = { owner: actor.id, epoch: work.epoch, claimedAt: now.toISOString(), ...(actor.displayName ? { displayName: actor.displayName } : {}), ...(actor.runtime ? { runtime: actor.runtime } : {}) };
        work.lease = { owner: actor.id, epoch: work.epoch, expiresAt: new Date(now.getTime() + this.leaseSeconds * 1000).toISOString() };
      }
      if (['heartbeat', 'release', 'workspace', 'submit', 'blocked'].includes(command)) activeLease(work, actor, data.epoch, now);
      if (command === 'heartbeat') work.lease!.expiresAt = new Date(now.getTime() + this.leaseSeconds * 1000).toISOString();
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
      if (command === 'evidence') {
        demand(actor.role === 'producer' || actor.role === 'worker' || actor.role === 'admin', 'Evidence submission is not permitted', 403);
        const trusted = actor.role === 'producer' && !!actor.proofs?.includes(data.proof) || actor.role === 'admin' && data.proof.startsWith('manual:');
        work.evidence.push({ ...data, id: randomUUID(), producer: actor.id, trusted, at: now.toISOString() });
      }
      this.evaluate(work, all, now);
      await save(db, work, actor.id, command, now, data);
      if (work.submission && !['heartbeat', 'release', 'claim', 'workspace'].includes(command)) await wakeJob(db, work.id);
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(work)]);
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
      demand(work.policy.review && work.policy.reviewProvider === 'codex' && request.sha === work.candidate?.sha && request.baseSha === work.candidate?.baseSha && request.policyRevision === work.policyRevision, 'Review request candidate or policy changed');
      work.reviewRequest = request;
      if (work.observation) work.observation.agentReview = { provider: 'codex', sha: request.sha, approved: false, reason: 'Waiting for dispatched Codex review' };
      this.evaluate(work, all, now); await save(db, work, 'github', 'review.requested', now); return work;
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
        preserveAssignment(work);
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
      demand(work.submission?.pr === observation.candidate.pr, 'Unassigned pull request');
      demand(work.workspaces.some(w => w.epoch === work.submission!.epoch && w.branch === observation.candidate.branch), 'PR branch does not match the assigned workspace');
      if (work.stage === 'done') return work;
      let authorizedSnapshot: Work | null = null;
      if (observation.merged && observation.mergedAt && Number.isFinite(Date.parse(observation.mergedAt))) {
        const mergedTime = Date.parse(observation.mergedAt);
        // Never allow evidence from after the earliest possible merge instant.
        // Whole-second timestamps can therefore conservatively refuse same-second authorization.
        const cutoff = mergedTime + (/\.\d+Z$/.test(observation.mergedAt) ? 1 : 1000);
        const past = (await db.query("SELECT payload->'work' AS work FROM events WHERE work_id=$1 AND created_at<$2 AND payload ? 'work' ORDER BY seq DESC LIMIT 1", [id, new Date(cutoff)])).rows[0]?.work as Work | undefined;
        const authorization = past?.mergeAuthorization;
        if (past && authorization && authorization.sha === observation.candidate.sha && authorization.baseSha === observation.candidate.baseSha && authorization.policyRevision === past.policyRevision
          && past.submission?.pr === observation.candidate.pr && past.gates.every(g => g.passed) && !past.violations.length
          && past.observation && cutoff - Date.parse(past.observation.at) < 120_000 && Date.parse(authorization.at) < mergedTime) authorizedSnapshot = past;
      }
      work.candidate = observation.candidate;
      work.observation = observation;
      this.evaluate(work, all, now);
      if (observation.merged) {
        const violation = 'Merge observed without a prior authorization for this candidate';
        if (authorizedSnapshot && observation.mergeSha) {
          if (work.gates.some(g => !g.passed)) work.violations.push('Post-merge checks differ from the recorded authorization; follow-up required');
          work.stage = 'done'; work.stageEnteredAt = now.toISOString();
          work.delivery = { mergedAt: observation.mergedAt!, mergeSha: observation.mergeSha, authorizationRevision: authorizedSnapshot.revision };
          await db.query('DELETE FROM jobs WHERE work_id=$1', [work.id]);
        } else if (!work.violations.includes(violation)) work.violations.push(violation);
      }
      await save(db, work, 'github', 'github.observed', now);
      return work;
    });
  }
}
