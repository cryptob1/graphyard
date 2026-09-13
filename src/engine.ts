import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, save } from './store.js';
import { activeLease, admin, createSchema, demand, evaluate, proofSchema, type Principal, type Work, type Observation } from './model.js';

const epoch = z.number().int().positive();
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const commands = {
  create: createSchema,
  ready: z.object({}).strict(),
  unblock: z.object({ reason: z.string().min(1).max(2000) }).strict(),
  rework: z.object({ reason: z.string().min(1).max(2000), previousWorkerStopped: z.literal(true) }).strict(),
  claim: z.object({}).strict(),
  heartbeat: z.object({ epoch }).strict(),
  release: z.object({ epoch }).strict(),
  workspace: z.object({ epoch, host: z.string().min(1).max(200), path: z.string().startsWith('/').max(1000), branch: z.string().regex(/^graphyard\/[a-zA-Z0-9/_-]+$/).max(200) }).strict(),
  submit: z.object({ epoch, pr: z.number().int().positive() }).strict(),
  blocked: z.object({ epoch, reason: z.string().max(2000).nullable() }).strict(),
  evidence: z.object({ proof: proofSchema, sha, baseSha: sha, policyRevision: z.number().int().positive(), result: z.enum(['pass', 'fail']), executed: z.number().int().min(0), skipped: z.number().int().min(0), url: z.string().url().max(2000).optional(), scenarioRevision: z.number().int().positive().optional(), environment: z.string().min(1).max(100).optional() }).strict(),
} as const;
export type Command = keyof typeof commands;

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
      if (command !== 'create') demand(work.stage !== 'done', 'Delivered work is immutable; create a follow-up task');
      if (command === 'ready') { admin(actor); work.ready = true; }
      if (command === 'unblock') { admin(actor); work.blocker = null; }
      if (command === 'rework') {
        admin(actor);
        demand(!work.observation?.merged, 'Merged work requires a follow-up task');
        work.reworkRequested = true;
        work.lease = null;
        await db.query('UPDATE jobs SET available_at=now() WHERE work_id=$1', [work.id]);
      }
      if (command === 'claim') {
        demand(actor.role === 'worker' || actor.role === 'admin', 'Worker permission required', 403);
        demand(work.ready && !work.blocker, 'Task is not ready or has a blocker');
        demand(work.dependencies.every(dep => all.find(w => w.id === dep)?.stage === 'done'), 'Unfinished dependencies');
        demand(!work.lease || Date.parse(work.lease.expiresAt) <= now.getTime(), 'Task already has an active owner');
        demand(!work.submission || work.reworkRequested, 'Implementation is submitted; an operator must request rework before reassignment');
        work.epoch++;
        work.lease = { owner: actor.id, epoch: work.epoch, expiresAt: new Date(now.getTime() + this.leaseSeconds * 1000).toISOString() };
      }
      if (['heartbeat', 'release', 'workspace', 'submit', 'blocked'].includes(command)) activeLease(work, actor, data.epoch, now);
      if (command === 'heartbeat') work.lease!.expiresAt = new Date(now.getTime() + this.leaseSeconds * 1000).toISOString();
      if (command === 'release') work.lease = null;
      if (command === 'blocked') work.blocker = data.reason;
      if (command === 'workspace') {
        demand(!work.workspaces.some(w => w.epoch === data.epoch), 'This assignment already has a workspace');
        demand(!all.some(w => w.workspaces.some(s => (s.branch === data.branch && (w.id !== work!.id || !work!.reworkRequested)) || s.host === data.host && s.path === data.path)), 'Branch or host/path is already reserved; use a fresh workspace');
        if (work.submission) demand(data.branch === work.workspaces.find(w => w.epoch === work!.submission!.epoch)?.branch, 'Rework must use the already linked PR branch in a fresh workspace');
        work.workspaces.push({ ...data, owner: actor.id });
      }
      if (command === 'submit') {
        demand(work.workspaces.some(w => w.epoch === data.epoch), 'Register the assignment workspace first');
        demand(!all.some(w => w.id !== work!.id && w.submission?.pr === data.pr), 'Pull request is already linked to another task');
        demand(!work.submission || work.submission.pr === data.pr, 'A submitted task cannot switch pull requests');
        work.submission = { epoch: data.epoch, pr: data.pr };
        work.reworkRequested = false;
        await db.query('INSERT INTO jobs(work_id) VALUES($1) ON CONFLICT(work_id) DO UPDATE SET available_at=now()', [work.id]);
      }
      if (command === 'evidence') {
        demand(actor.role === 'producer' || actor.role === 'worker' || actor.role === 'admin', 'Evidence submission is not permitted', 403);
        const trusted = actor.role === 'producer' && !!actor.proofs?.includes(data.proof) || actor.role === 'admin' && data.proof.startsWith('manual:');
        work.evidence.push({ ...data, id: randomUUID(), producer: actor.id, trusted, at: now.toISOString() });
      }
      this.evaluate(work, all, now);
      await save(db, work, actor.id, command, now, data);
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(work)]);
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
        if (work.lease && Date.parse(work.lease.expiresAt) <= now.getTime()) work.lease = null;
        this.evaluate(work, all, now);
        if (JSON.stringify(work) !== before) await save(db, work, 'graphyard', 'reconciled', now);
      }
    });
  }
  async observe(id: string, expectedRevision: number, observation: Observation) {
    return this.store.transaction(async (db, now) => {
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document);
      const work = all.find(w => w.id === id);
      demand(work && work.revision === expectedRevision, 'Task changed while GitHub was being observed; retry');
      demand(work.submission?.pr === observation.candidate.pr, 'Unassigned pull request');
      demand(work.workspaces.some(w => w.epoch === work.submission!.epoch && w.branch === observation.candidate.branch), 'PR branch does not match the assigned workspace');
      if (work.stage === 'done') return work;
      if (observation.merged) {
        const authorization = work.mergeAuthorization;
        const authorized = authorization && authorization.sha === observation.candidate.sha && authorization.baseSha === observation.candidate.baseSha && authorization.policyRevision === work.policyRevision
          // GitHub reports merge times at whole-second precision.
          && observation.mergedAt && Math.floor(Date.parse(authorization.at) / 1000) <= Math.floor(Date.parse(observation.mergedAt) / 1000);
        const violation = 'Merge observed without a prior authorization for this candidate';
        if (!authorized && !work.violations.includes(violation)) work.violations.push(violation);
      }
      work.candidate = observation.candidate;
      work.observation = observation;
      this.evaluate(work, all, now);
      await save(db, work, 'github', 'github.observed', now);
      return work;
    });
  }
}
