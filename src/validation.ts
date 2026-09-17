import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type pg from 'pg';
import { admin, demand, proofSchema, type EvidenceArtifact, type Principal, type Work } from './model.js';
import { save, wakeJob } from './store.js';
import { Engine } from './engine.js';
import type { Scenario } from './scenarios.js';

const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/).max(150);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const revision = z.number().int().positive();
const base = { id: name, expectedRevision: z.number().int().min(0) };
const resourceNames = z.array(name).min(1).max(30).refine(a => new Set(a).size === a.length, 'Resources must be unique');
const artifacts = z.array(z.object({ service: name, digest }).strict()).min(1).max(30).refine(a => new Set(a.map(x => x.service)).size === a.length, 'Services must be unique');
const ref = z.object({ id: name, revision }).strict();
const externalUrl = z.url().max(2000).refine(value => { const parsed = new URL(value); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password; }, 'Artifact URL must be HTTP(S) without credentials');
export const definitionSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('environment'), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), url: z.url().max(2000).refine(s => { const u = new URL(s); return u.protocol === 'https:' && !u.username && !u.password && !u.hash && !u.search; }, 'Use HTTPS without credentials, query or fragment'), instance: name, immutable: z.literal(true), services: resourceNames, resources: resourceNames }).strict(),
  z.object({ ...base, kind: z.literal('registration'), principalId: name, role: z.enum(['runner', 'collector', 'builder']), environment: ref, adapterVersion: name, proofs: z.array(proofSchema).max(50), enabled: z.boolean() }).strict(),
  z.object({ ...base, kind: z.literal('bundle'), scenario: name, scenarioRevision: revision, scenarioHash: z.string().regex(/^[a-f0-9]{64}$/), digest, runnerImageDigest: digest }).strict(),
]);
type DefinitionInput = z.infer<typeof definitionSchema>;
export type Definition = DefinitionInput & { revision: number; createdAt: string; createdBy: string };
type Environment = Definition & { kind: 'environment' };
type Registration = Definition & { kind: 'registration' };
type Bundle = Definition & { kind: 'bundle' };
const attestationSchema = z.object({ registration: ref, workId: z.uuid(), expectedWorkRevision: revision, sourceSha: sha, baseSha: sha, buildInputsDigest: digest, artifacts, provenanceUrl: z.url().max(2000) }).strict();
export type BuildAttestation = z.infer<typeof attestationSchema> & { id: string; producer: string; at: string; repository: string };
const candidateSchema = z.object({ workId: z.uuid(), expectedWorkRevision: revision, proof: proofSchema, environment: ref, bundle: ref, buildAttestationId: z.uuid(), requiredArtifacts: resourceNames, artifactStorage: z.enum(['external', 'postgres']).default('external') }).strict();
export type ValidationCandidate = z.infer<typeof candidateSchema> & { id: string; sourceSha: string; baseSha: string; policyRevision: number; scenario: { revision: number; hash: string; environment: string }; createdAt: string; createdBy: string };
const requestSchema = z.object({ candidateId: z.uuid(), expectedWorkRevision: revision, runner: ref, collector: ref, deadline: z.iso.datetime(), maxAttempts: z.number().int().min(1).max(5) }).strict();
export type Attempt = { id: string; epoch: number; dispatchedAt: string; expiresAt: string; acknowledgedAt?: string; finishedAt?: string; state: 'dispatched' | 'running' | 'completed' | 'expired' | 'cancelled' | 'superseded'; settled: boolean };
export type ValidationRequest = z.infer<typeof requestSchema> & { id: string; workId: string; proof: string; state: 'queued' | 'dispatched' | 'running' | 'completed' | 'cancelled' | 'expired' | 'superseded'; attempts: Attempt[]; createdAt: string; createdBy: string; result?: { accepted: boolean; passed: boolean; reasons: string[] } };
const commandSchema = z.object({ requestId: z.uuid(), attemptId: z.uuid(), epoch: revision }).strict();
const reportSchema = commandSchema.extend({
  execution: z.enum(['completed', 'cancelled', 'timed_out']), behavior: z.enum(['passed', 'failed', 'blocked', 'unmeasured']),
  executed: z.number().int().min(0).max(1_000_000), skipped: z.number().int().min(0).max(1_000_000), inventoryComplete: z.boolean(),
  target: z.object({ instance: name, artifacts, measurement: z.enum(['provider', 'host-attestation', 'unknown']), coversEntireRun: z.boolean() }).strict(),
  bundleDigest: digest, runnerImageDigest: digest,
  artifacts: z.array(z.object({ name, digest, url: z.union([externalUrl, z.string().regex(/^graphyard-artifact:\/\/[^?#]+\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/)]) }).strict()).max(30),
  executionSettled: z.boolean(),
}).strict();
type Report = z.infer<typeof reportSchema>;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const same = isDeepStrictEqual;

/** No network I/O here. Collectors, build producers and operators are separate trust boundaries. */
export class Validation {
  constructor(readonly engine: Engine, readonly principals: Principal[], readonly repository: string) {}
  get store() { return this.engine.store; }
  async list(cursor?: string) {
    let before: string | null = null;
    if (cursor) {
      z.uuid().parse(cursor);
      before = (await this.store.pool.query("SELECT document->>'createdAt' AS at FROM validation_requests WHERE id=$1", [cursor])).rows[0]?.at;
      demand(before, 'Request cursor not found', 404);
    }
    const rows: ValidationRequest[] = (await this.store.pool.query(`SELECT document FROM validation_requests
      WHERE $1::text IS NULL OR (document->>'createdAt',id)<($1::text,$2::uuid)
      ORDER BY document->>'createdAt' DESC,id DESC LIMIT 21`, [before, cursor ?? null])).rows.map(r => r.document);
    const requests = rows.slice(0,20);
    const candidates: ValidationCandidate[] = (await this.store.pool.query('SELECT document FROM validation_candidates WHERE id=ANY($1::uuid[])', [requests.map(r => r.candidateId)])).rows.map(r => r.document);
    return { requests, candidates, nextCursor: rows.length > 20 ? requests.at(-1)!.id : null };
  }
  async definitions(cursor?: string) {
    const position = cursor ? z.object({ at: z.iso.datetime(), kind: z.enum(['environment','registration','bundle']), id: name, revision }).strict().parse(JSON.parse(Buffer.from(z.string().max(1000).parse(cursor), 'base64url').toString('utf8'))) : null;
    const rows: Definition[] = (await this.store.pool.query(`SELECT document FROM validation_definitions
      WHERE $1::text IS NULL OR (document->>'createdAt',kind,id,revision)<($1::text,$2::text,$3::text,$4::int)
      ORDER BY document->>'createdAt' DESC,kind DESC,id DESC,revision DESC LIMIT 51`, [position?.at ?? null, position?.kind ?? null, position?.id ?? null, position?.revision ?? null])).rows.map(r => r.document);
    const definitions = rows.slice(0,50), last = definitions.at(-1);
    return { definitions, nextCursor: rows.length > 50 && last ? Buffer.from(JSON.stringify({ at: last.createdAt, kind: last.kind, id: last.id, revision: last.revision })).toString('base64url') : null };
  }
  async readCandidate(id: string) {
    z.uuid().parse(id);
    const candidate = (await this.store.pool.query('SELECT document FROM validation_candidates WHERE id=$1', [id])).rows[0]?.document as ValidationCandidate | undefined;
    demand(candidate, 'Candidate not found', 404);
    const build = (await this.store.pool.query('SELECT document FROM validation_builds WHERE id=$1', [candidate.buildAttestationId])).rows[0]?.document as BuildAttestation;
    return { ...candidate, build };
  }
  private async event(db: pg.PoolClient, actor: string, kind: string, payload: unknown, workId?: string) { await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [workId ?? null, actor, `validation.${kind}`, JSON.stringify(payload)]); }
  private async definition(db: pg.PoolClient, kind: Definition['kind'], selected: { id: string; revision: number }, current = true): Promise<Definition> {
    const rows = (await db.query('SELECT document FROM validation_definitions WHERE kind=$1 AND id=$2 ORDER BY revision DESC', [kind, selected.id])).rows;
    const found = rows.find(r => r.document.revision === selected.revision)?.document as Definition | undefined;
    demand(found && (!current || rows[0].document.revision === selected.revision), 'Definition missing or authorization generation superseded');
    return found;
  }
  private async registration(db: pg.PoolClient, selected: { id: string; revision: number }, role: Registration['role']): Promise<Registration> {
    const r = await this.definition(db, 'registration', selected) as Registration;
    const p = this.principals.find(p => p.id === r.principalId);
    demand(r.enabled && r.role === role && p && p.role === (role === 'runner' ? 'worker' : 'producer'), 'Registration revoked or principal role is not authorized');
    if (role === 'collector') demand(r.proofs.every(proof => p.proofs?.includes(proof)), 'Collector proof scope revoked');
    // Environment revisions revoke old dispatch authority too.
    await this.definition(db, 'environment', r.environment);
    return r;
  }
  private async work(db: pg.PoolClient, id: string, now: Date, expected?: number): Promise<Work> {
    const work = (await db.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0]?.document as Work | undefined;
    demand(work && work.stage !== 'done' && !work.observation?.merged, 'Work missing or already delivered');
    demand(!work.mergeExecution || Date.parse(work.mergeExecution.expiresAt) <= now.getTime(), 'A merge execution is active');
    demand(expected === undefined || work.revision === expected, 'Work changed; read current revision');
    return work;
  }
  private async candidate(db: pg.PoolClient, id: string) {
    const c = (await db.query('SELECT document FROM validation_candidates WHERE id=$1', [id])).rows[0]?.document as ValidationCandidate | undefined;
    demand(c, 'Validation candidate not found', 404); return c;
  }
  private async request(db: pg.PoolClient, id: string) {
    const r = (await db.query('SELECT document FROM validation_requests WHERE id=$1', [id])).rows[0]?.document as ValidationRequest | undefined;
    demand(r, 'Validation request not found', 404); return r;
  }
  private async persist(db: pg.PoolClient, r: ValidationRequest) { await db.query('UPDATE validation_requests SET document=$2 WHERE id=$1', [r.id, JSON.stringify(r)]); }
  private async changed(db: pg.PoolClient, w: Work, actor: string, kind: string, now: Date, details: unknown) {
    if (w.mergeExecution && Date.parse(w.mergeExecution.expiresAt) <= now.getTime()) w.mergeExecution = null;
    demand(!w.mergeExecution, 'A merge execution is active');
    const all: Work[] = (await db.query('SELECT document FROM work_items')).rows.map(r => r.document);
    this.engine.evaluate(w, all.map(x => x.id === w.id ? w : x), now);
    await save(db, w, actor, `validation.${kind}`, now, details); await wakeJob(db, w.id);
  }
  private compatible(w: Work, c: ValidationCandidate) { return w.stage !== 'done' && !w.observation?.merged && w.candidate?.sha === c.sourceSha && w.candidate.baseSha === c.baseSha && w.policyRevision === c.policyRevision && w.scenarioRequirements.some(s => s.proof === c.proof && s.revision === c.scenario.revision && s.hash === c.scenario.hash && s.environment === c.scenario.environment); }
  private async valid(db: pg.PoolClient, c: ValidationCandidate, w: Work) {
    demand(this.compatible(w, c), 'Candidate no longer matches current work or requirements');
    const environment = await this.definition(db, 'environment', c.environment) as Environment;
    demand(environment.repository === this.repository, 'Validation repository scope differs', 403);
    await this.definition(db, 'bundle', c.bundle);
    const build = (await db.query('SELECT document AS attestation FROM validation_builds WHERE id=$1', [c.buildAttestationId])).rows[0]?.attestation as BuildAttestation | undefined;
    demand(build, 'Missing trusted build provenance'); await this.registration(db, build.registration, 'builder');
  }
  private async withReceipt(actor: Principal, command: string, data: unknown, key: string, fn: (db: pg.PoolClient, now: Date) => Promise<unknown>) {
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const fingerprint = hash({ command: `validation.${command}`, data });
    return this.store.transaction(async (db, now) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) {
        demand(receipt.fingerprint === fingerprint, 'Idempotency key reused with different input');
        if (['dispatch', 'ack', 'heartbeat'].includes(command)) {
          const previous: ValidationRequest | undefined = command === 'dispatch' ? receipt.result.request : receipt.result;
          if (previous) {
            const r = await this.request(db, previous.id), a = r.attempts.at(-1), old = previous.attempts.at(-1);
            const registration = await this.registration(db, r.runner, 'runner');
            demand(registration.principalId === actor.id && a && old && a.id === old.id && ['dispatched', 'running'].includes(r.state) && Date.parse(a.expiresAt) > now.getTime() && Date.parse(old.expiresAt) > now.getTime(), 'Replayed execution grant is expired or superseded');
            const c = await this.candidate(db, r.candidateId), w = await this.work(db, r.workId, now);
            await this.valid(db, c, w); await this.registration(db, r.collector, 'collector');
            demand(w.validation?.[r.proof]?.requestId === r.id, 'Replayed request is superseded');
          }
        }
        return receipt.result;
      }
      const result = await fn(db, now);
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]); return result;
    });
  }
  async define(actor: Principal, input: unknown, key: string) {
    admin(actor); const data = definitionSchema.parse(input);
    return this.withReceipt(actor, 'define', data, key, async (db, now) => {
      const latest = (await db.query('SELECT revision FROM validation_definitions WHERE kind=$1 AND id=$2 ORDER BY revision DESC LIMIT 1', [data.kind, data.id])).rows[0]?.revision ?? 0;
      demand(latest === data.expectedRevision, 'Configuration generation changed');
      if (data.kind === 'environment') demand(data.repository === this.repository && !!this.repository, 'Environment repository is not managed');
      if (data.kind === 'registration') {
        await this.definition(db, 'environment', data.environment, data.enabled);
        const principal = this.principals.find(p => p.id === data.principalId);
        demand(!data.enabled || principal && principal.role === (data.role === 'runner' ? 'worker' : 'producer'), 'Registration principal must have the appropriate separate role');
        if (data.enabled && data.role === 'collector') demand(data.proofs.length && data.proofs.every(p => principal?.proofs?.includes(p)), 'Collector cannot exceed configured proof scope');
      }
      if (data.kind === 'bundle') {
        const s = (await db.query('SELECT document FROM scenarios WHERE id=$1 AND revision=$2', [data.scenario, data.scenarioRevision])).rows[0]?.document as Scenario | undefined;
        demand(s?.hash === data.scenarioHash, 'Bundle approval must pin an existing scenario revision and hash');
        const prior: Bundle[] = (await db.query("SELECT document FROM validation_definitions WHERE kind='bundle' AND document->>'scenario'=$1 AND (document->>'scenarioRevision')::int=$2", [data.scenario, data.scenarioRevision])).rows.map(r => r.document);
        demand(prior.every(p => p.digest === data.digest && p.runnerImageDigest === data.runnerImageDigest), 'Changed executable bundles require a new scenario revision and work pinned to it');
      }
      const definition: Definition = { ...data, revision: latest + 1, createdAt: now.toISOString(), createdBy: actor.id };
      await db.query('INSERT INTO validation_definitions VALUES($1,$2,$3,$4)', [data.kind, data.id, definition.revision, JSON.stringify(definition)]);
      await this.event(db, actor.id, 'defined', { definition });
      await this.reconcileWithin(db, now, true); return definition;
    });
  }
  async attestBuild(actor: Principal, input: unknown, key: string) {
    demand(actor.role === 'producer', 'A separately authorized build producer is required', 403);
    const data = attestationSchema.parse(input);
    return this.withReceipt(actor, 'build', data, key, async (db, now) => {
      const r = await this.registration(db, data.registration, 'builder'); demand(r.principalId === actor.id, 'Wrong build principal', 403);
      const e = await this.definition(db, 'environment', r.environment) as Environment;
      const w = await this.work(db, data.workId, now, data.expectedWorkRevision);
      demand(w.candidate?.sha === data.sourceSha && w.candidate.baseSha === data.baseSha, 'Build source differs from independently observed candidate');
      demand(same([...e.services].sort(), data.artifacts.map(a => a.service).sort()), 'Build must cover the complete service manifest');
      const attestation: BuildAttestation = { ...data, id: randomUUID(), producer: actor.id, at: now.toISOString(), repository: e.repository };
      await db.query('INSERT INTO validation_builds VALUES($1,$2)', [attestation.id, JSON.stringify(attestation)]);
      await this.event(db, actor.id, 'build', { attestation }, w.id); return attestation;
    });
  }
  async createCandidate(actor: Principal, input: unknown, key: string) {
    admin(actor); const data = candidateSchema.parse(input);
    return this.withReceipt(actor, 'candidate', data, key, async (db, now) => {
      const w = await this.work(db, data.workId, now, data.expectedWorkRevision);
      demand(w.candidate && w.observation && w.observation.candidate.sha === w.candidate.sha && w.observation.candidate.baseSha === w.candidate.baseSha, 'Independently observed source required');
      const s = w.scenarioRequirements.find(s => s.proof === data.proof);
      demand(s && w.criteria.some(ac => ac.proofs.includes(data.proof)), 'Proof must be required by current work and pin a registered scenario');
      const e = await this.definition(db, 'environment', data.environment) as Environment;
      const b = await this.definition(db, 'bundle', data.bundle) as Bundle;
      demand(e.id === s.environment && b.scenario === data.proof.replace(/^e2e:/, '') && b.scenarioRevision === s.revision && b.scenarioHash === s.hash, 'Environment or approved bundle differs from required scenario');
      const build = (await db.query('SELECT document AS attestation FROM validation_builds WHERE id=$1', [data.buildAttestationId])).rows[0]?.attestation as BuildAttestation | undefined;
      demand(build && build.workId === w.id && build.repository === this.repository && build.sourceSha === w.candidate.sha && build.baseSha === w.candidate.baseSha, 'Missing or mismatched trusted build provenance');
      const builder = await this.registration(db, build.registration, 'builder'); demand(same(builder.environment, data.environment), 'Build environment differs');
      const c: ValidationCandidate = { ...data, id: randomUUID(), sourceSha: w.candidate.sha, baseSha: w.candidate.baseSha, policyRevision: w.policyRevision, scenario: s, createdAt: now.toISOString(), createdBy: actor.id };
      await db.query('INSERT INTO validation_candidates VALUES($1,$2)', [c.id, JSON.stringify(c)]);
      (w.validation ??= {})[data.proof] = { candidateId: c.id };
      await this.changed(db, w, actor.id, 'candidate', now, { candidate: c });
      await this.reconcileWithin(db, now); return c;
    });
  }
  async createRequest(actor: Principal, input: unknown, key: string) {
    admin(actor); const data = requestSchema.parse(input);
    return this.withReceipt(actor, 'request', data, key, async (db, now) => {
      const c = await this.candidate(db, data.candidateId); const w = await this.work(db, c.workId, now, data.expectedWorkRevision); await this.valid(db, c, w);
      demand(w.validation?.[c.proof]?.candidateId === c.id, 'Candidate selection superseded');
      const runner = await this.registration(db, data.runner, 'runner'), collector = await this.registration(db, data.collector, 'collector');
      const build = (await db.query('SELECT document FROM validation_builds WHERE id=$1', [c.buildAttestationId])).rows[0]?.document as BuildAttestation;
      demand(build && collector.principalId !== build.producer, 'Build producer and result collector must be distinct principals');
      demand(same(runner.environment, c.environment) && same(collector.environment, c.environment) && collector.proofs.includes(c.proof), 'Runner/collector environment or proof scope differs');
      demand(Date.parse(data.deadline) > now.getTime() && Date.parse(data.deadline) <= now.getTime() + 3_600_000, 'Deadline must be within the next hour');
      const r: ValidationRequest = { ...data, id: randomUUID(), workId: w.id, proof: c.proof, state: 'queued', attempts: [], createdAt: now.toISOString(), createdBy: actor.id };
      await db.query('INSERT INTO validation_requests VALUES($1,$2)', [r.id, JSON.stringify(r)]);
      w.validation![c.proof] = { candidateId: c.id, requestId: r.id };
      await this.changed(db, w, actor.id, 'requested', now, { request: r }); await this.reconcileWithin(db, now); return r;
    });
  }
  async dispatch(actor: Principal, input: unknown, key: string) {
    demand(actor.role === 'worker', 'Runner credential required', 403);
    const data = z.object({ registration: ref }).strict().parse(input);
    return this.withReceipt(actor, 'dispatch', data, key, async (db, now) => {
      const registration = await this.registration(db, data.registration, 'runner'); demand(registration.principalId === actor.id, 'Wrong runner principal', 403);
      await this.reconcileWithin(db, now);
      const queued: ValidationRequest[] = (await db.query("SELECT document FROM validation_requests WHERE document->>'state'='queued' ORDER BY document->>'createdAt',id")).rows.map(r => r.document);
      for (const r of queued.filter(r => same(r.runner, data.registration))) {
        const c = await this.candidate(db, r.candidateId); const w = await this.work(db, r.workId, now);
        await this.valid(db, c, w); await this.registration(db, r.collector, 'collector');
        const environment = await this.definition(db, 'environment', c.environment) as Environment;
        // Resources are global names, not scoped by an environment version. Revisions
        // must not accidentally free physical resources held by an old attempt.
        const resources = [`runner:${registration.principalId}`, `environment:${environment.id}`, ...environment.resources.map(x => `external:${x}`)];
        const busy = (await db.query('SELECT resource FROM validation_resources WHERE resource=ANY($1::text[])', [resources])).rowCount;
        if (busy) continue;
        demand(r.attempts.length < r.maxAttempts, 'Attempt budget exhausted');
        const attempt: Attempt = { id: randomUUID(), epoch: r.attempts.length + 1, dispatchedAt: now.toISOString(), expiresAt: new Date(Math.min(now.getTime() + 30_000, Date.parse(r.deadline))).toISOString(), state: 'dispatched', settled: false };
        r.attempts.push(attempt); r.state = 'dispatched'; await this.persist(db, r);
        for (const resource of resources) await db.query('INSERT INTO validation_resources VALUES($1,$2)', [resource, r.id]);
        w.validation![c.proof] = { candidateId: c.id, requestId: r.id, attemptId: attempt.id };
        await this.changed(db, w, actor.id, 'dispatched', now, { requestId: r.id, attempt, resources });
        const build = (await db.query('SELECT document FROM validation_builds WHERE id=$1', [c.buildAttestationId])).rows[0].document as BuildAttestation;
        return { request: r, candidate: c, build, environment, bundle: await this.definition(db, 'bundle', c.bundle), attempt };
      }
      return { request: null, reason: 'No eligible request or protected resources are still reserved' };
    });
  }
  async runnerCommand(actor: Principal, command: 'ack' | 'heartbeat', input: unknown, key: string) {
    demand(actor.role === 'worker', 'Runner credential required', 403); const data = commandSchema.parse(input);
    return this.withReceipt(actor, command, data, key, async (db, now) => {
      await this.reconcileWithin(db, now);
      const r = await this.request(db, data.requestId), a = r.attempts.at(-1);
      const registration = await this.registration(db, r.runner, 'runner'); demand(registration.principalId === actor.id, 'Wrong runner principal', 403);
      demand(a && a.id === data.attemptId && a.epoch === data.epoch && Date.parse(a.expiresAt) > now.getTime() && ['dispatched', 'running'].includes(r.state), 'Attempt lease expired, cancelled or superseded');
      demand(command !== 'heartbeat' || r.state === 'running', 'ACK must precede execution and heartbeat');
      if (command === 'ack') demand(r.state === 'dispatched', 'Attempt already acknowledged');
      a.state = 'running'; a.acknowledgedAt ??= now.toISOString(); r.state = 'running'; a.expiresAt = new Date(Math.min(now.getTime() + 60_000, Date.parse(r.deadline))).toISOString();
      await this.persist(db, r); await this.event(db, actor.id, command, { requestId: r.id, attempt: a }, r.workId); return r;
    });
  }
  async result(actor: Principal, input: unknown, key: string) {
    demand(actor.role === 'producer', 'A separate trusted collector is required', 403); const data = reportSchema.parse(input);
    return this.withReceipt(actor, 'result', data, key, async (db, now) => {
      const r = await this.request(db, data.requestId);
      const pinned = await this.definition(db, 'registration', r.collector, false) as Registration;
      demand(pinned.principalId === actor.id && actor.proofs?.includes(r.proof), 'Wrong collector principal or proof scope', 403);
      await this.reconcileWithin(db, now);
      const current = await this.request(db, r.id), a = current.attempts.at(-1), c = await this.candidate(db, r.candidateId);
      const w = (await db.query('SELECT document FROM work_items WHERE id=$1', [r.workId])).rows[0]?.document as Work;
      const rejection: string[] = [];
      try { await this.registration(db, r.runner, 'runner'); await this.registration(db, r.collector, 'collector'); await this.valid(db, c, w); } catch { rejection.push('Candidate or registration authority was revoked or superseded'); }
      if (!a || a.id !== data.attemptId || a.epoch !== data.epoch || current.state !== 'running' || Date.parse(a.expiresAt) <= now.getTime() || Date.parse(r.deadline) <= now.getTime()) rejection.push('Result does not hold the current live acknowledged attempt');
      if (w.validation?.[r.proof]?.candidateId !== c.id || w.validation?.[r.proof]?.requestId !== r.id || w.validation?.[r.proof]?.attemptId !== a?.id) rejection.push('A newer validation selection supersedes this result');
      if (rejection.length) {
        const result = { accepted: false, passed: false, reasons: rejection };
        // Commit rejection + receipt. Throwing here would erase the audit.
        await this.event(db, actor.id, 'result-rejected', { requestId: r.id, attemptId: data.attemptId, epoch: data.epoch, reportHash: hash(data), result }, r.workId); return result;
      }
      const reasons = await this.reportReasons(db, c, data);
      let expiresAt: string | undefined;
      const evidenceArtifacts: EvidenceArtifact[] = [];
      if (c.artifactStorage === 'postgres') {
        const stored = (await db.query('SELECT id,name,digest,expires_at,media_type,octet_length(bytes) AS size,bytes IS NOT NULL AS retained FROM validation_artifacts WHERE request_id=$1 AND attempt_id=$2', [r.id, a!.id])).rows;
        for (const required of c.requiredArtifacts) {
          const supplied = data.artifacts.find(x => x.name === required);
          const actual = stored.find(x => x.name === required && supplied?.digest === x.digest && supplied?.url === this.artifactUrl(r.id, x.id));
          if (!actual || !actual.retained || actual.expires_at <= now) reasons.push(`Private artifact ${required} is missing, expired or mismatched`);
          if (actual) {
            const artifactExpiry = actual.expires_at.toISOString();
            if (!expiresAt || artifactExpiry < expiresAt) expiresAt = artifactExpiry;
            evidenceArtifacts.push({ kind: this.artifactKind(actual.name, actual.media_type), label: actual.name, mediaType: actual.media_type, size: Number(actual.size ?? 0), digest: actual.digest, expiresAt: artifactExpiry,
              availability: !actual.retained ? 'missing' : actual.expires_at <= now ? 'expired' : 'available', reference: { requestId: r.id, artifactId: actual.id } });
          } else evidenceArtifacts.push({ kind: this.artifactKind(required), label: required, availability: 'missing' });
        }
      } else evidenceArtifacts.push(...data.artifacts.map(artifact => ({ kind: this.artifactKind(artifact.name), label: artifact.name, digest: artifact.digest, availability: 'external' as const, url: artifact.url })));
      const result = { accepted: true, passed: reasons.length === 0, reasons };
      current.state = 'completed'; current.result = result; a!.state = 'completed'; a!.finishedAt = now.toISOString(); a!.settled = data.executionSettled;
      if (a!.settled) await db.query('DELETE FROM validation_resources WHERE request_id=$1', [r.id]);
      await this.persist(db, current);
      w.evidence.push({ id: randomUUID(), proof: c.proof, sha: c.sourceSha, baseSha: c.baseSha, policyRevision: c.policyRevision, producer: actor.id, trusted: true, result: result.passed ? 'pass' : 'fail', executed: data.executed, skipped: data.skipped, at: now.toISOString(), ...(expiresAt ? { expiresAt } : {}), artifacts: evidenceArtifacts, scenarioRevision: c.scenario.revision, environment: c.scenario.environment, validation: { candidateId: c.id, requestId: r.id, attemptId: a!.id } });
      await this.changed(db, w, actor.id, 'result', now, { requestId: r.id, attemptId: a!.id, report: data, result }); return result;
    });
  }
  private artifactUrl(requestId: string, artifactId: string) {
    // A route identifier, not a bearer URL: the HTTP API always requires authentication.
    return `graphyard-artifact://${this.repository}/${requestId}/${artifactId}`;
  }
  private artifactKind(label: string, mediaType?: string): EvidenceArtifact['kind'] {
    if (mediaType?.startsWith('image/')) return 'screenshot';
    const value = label.toLowerCase();
    if (value.includes('trace')) return 'trace';
    if (value.includes('log')) return 'log';
    if (value.includes('report')) return 'report';
    return 'other';
  }
  async uploadArtifact(actor: Principal, input: unknown, key: string) {
    demand(actor.role === 'producer', 'A separate trusted collector is required', 403);
    const data = commandSchema.extend({ name, mediaType: z.enum(['application/json', 'application/zip', 'image/png', 'text/plain']),
      bytes: z.string().min(4).max(11_184_812),
      capturePolicy: z.literal('approved-test-data-only') }).strict().parse(input);
    const bytes = Buffer.from(data.bytes, 'base64');
    demand(bytes.length > 0 && bytes.length <= 8_388_608, 'Artifact must be nonempty and at most 8 MiB', 413);
    demand(bytes.toString('base64') === data.bytes, 'Artifact bytes must use canonical base64', 400);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    // Never copy uploaded bytes into the immutable event ledger or an idempotency receipt.
    const { bytes: _encoded, ...metadata } = data;
    return this.withReceipt(actor, 'artifact', { ...metadata, digest }, key, async (db, now) => {
      const r = await this.request(db, data.requestId), a = r.attempts.at(-1);
      const collector = await this.registration(db, r.collector, 'collector');
      demand(collector.principalId === actor.id && actor.proofs?.includes(r.proof), 'Wrong collector principal or proof scope', 403);
      await this.registration(db, r.runner, 'runner');
      const c = await this.candidate(db, r.candidateId), w = await this.work(db, r.workId, now); await this.valid(db, c, w);
      demand(c.artifactStorage === 'postgres' && c.requiredArtifacts.includes(data.name), 'Artifact storage or name is not authorized');
      demand(a && a.id === data.attemptId && a.epoch === data.epoch && r.state === 'running' && Date.parse(a.expiresAt) > now.getTime() && Date.parse(r.deadline) > now.getTime() && w.validation?.[r.proof]?.requestId === r.id, 'Artifact attempt authority expired or superseded');
      demand(!(await db.query('SELECT id FROM validation_artifacts WHERE request_id=$1 AND attempt_id=$2 AND name=$3', [r.id, a.id, data.name])).rowCount, 'Artifact name already published; reuse the original idempotency key');
      const id = randomUUID(), expiresAt = new Date(now.getTime() + 7 * 86_400_000).toISOString();
      await db.query('INSERT INTO validation_artifacts(id,request_id,attempt_id,name,digest,created_at,expires_at,media_type,bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, r.id, a.id, data.name, digest, now, expiresAt, data.mediaType, bytes]);
      const result = { id, requestId: r.id, attemptId: a.id, name: data.name, digest, size: bytes.length, expiresAt, url: this.artifactUrl(r.id, id) };
      await this.event(db, actor.id, 'artifact-stored', { ...result, capturePolicy: data.capturePolicy }, r.workId); return result;
    });
  }
  async readArtifact(actor: Principal, requestId: string, artifactId: string) {
    z.uuid().parse(requestId); z.uuid().parse(artifactId);
    return this.store.transaction(async (db, now) => {
      const r = await this.request(db, requestId);
      const w = (await db.query('SELECT document FROM work_items WHERE id=$1', [r.workId])).rows[0]?.document as Work | undefined;
      const collector = await this.definition(db, 'registration', r.collector, false) as Registration;
      const c = await this.candidate(db, r.candidateId), environment = await this.definition(db, 'environment', c.environment, false) as Environment;
      demand(environment.repository === this.repository, 'Artifact repository scope differs', 403);
      if (actor.role === 'producer') await this.registration(db, r.collector, 'collector');
      // This single-repository server grants readers repository-wide audit access.
      // Workers see only their assigned work; producers see only their collection request.
      demand(actor.role === 'admin' || actor.role === 'reader' || actor.role === 'worker' && w?.lastAssignment?.owner === actor.id || actor.role === 'producer' && collector.principalId === actor.id && actor.proofs?.includes(r.proof), 'Artifact access is not authorized for this request', 403);
      const row = (await db.query('SELECT name,digest,expires_at,media_type,bytes FROM validation_artifacts WHERE id=$1 AND request_id=$2', [artifactId, requestId])).rows[0];
      demand(row, 'Artifact not found for this request', 404);
      demand(row.bytes && row.expires_at > now, 'Artifact retention expired', 410);
      demand(`sha256:${createHash('sha256').update(row.bytes).digest('hex')}` === row.digest, 'Artifact integrity check failed', 503);
      await this.event(db, actor.id, 'artifact-read', { requestId, artifactId }, r.workId);
      return { bytes: row.bytes as Buffer, name: row.name as string, mediaType: row.media_type as string, digest: row.digest as string };
    });
  }
  async expireArtifacts() {
    return this.store.transaction(async (db, now) => {
      const expired = (await db.query('SELECT id,request_id FROM validation_artifacts WHERE expires_at<=$1 AND bytes IS NOT NULL ORDER BY expires_at,id LIMIT 50', [now])).rows;
      for (const row of expired) {
        await db.query('UPDATE validation_artifacts SET bytes=NULL,deleted_at=$2 WHERE id=$1', [row.id, now]);
        const r = await this.request(db, row.request_id);
        await this.event(db, 'system', 'artifact-expired', { requestId: r.id, artifactId: row.id }, r.workId);
      }
      return expired.length;
    });
  }
  private async reportReasons(db: pg.PoolClient, c: ValidationCandidate, data: Report) {
    const e = await this.definition(db, 'environment', c.environment) as Environment, b = await this.definition(db, 'bundle', c.bundle) as Bundle;
    const build = (await db.query('SELECT document AS attestation FROM validation_builds WHERE id=$1', [c.buildAttestationId])).rows[0].attestation as BuildAttestation;
    const reasons: string[] = [];
    if (data.execution !== 'completed' || data.behavior !== 'passed') reasons.push('Execution and behavior must both pass');
    if (!data.inventoryComplete || data.executed < 1 || data.skipped !== 0) reasons.push('Required inventory is missing, empty or skipped');
    if (data.target.measurement === 'unknown' || !data.target.coversEntireRun || data.target.instance !== e.instance || !same([...data.target.artifacts].sort((a,b) => a.service.localeCompare(b.service)), [...build.artifacts].sort((a,b) => a.service.localeCompare(b.service)))) reasons.push('Independent whole-run target attribution is missing or mismatched');
    if (data.bundleDigest !== b.digest || data.runnerImageDigest !== b.runnerImageDigest) reasons.push('Executed oracle bundle or runner image differs from approval');
    if (new Set(data.artifacts.map(a => a.name)).size !== data.artifacts.length || c.requiredArtifacts.some(n => !data.artifacts.some(a => a.name === n))) reasons.push('Required execution artifacts are missing or ambiguous');
    if (!data.executionSettled) reasons.push('Execution settlement is unverified; resources remain reserved');
    return reasons;
  }
  async operatorCommand(actor: Principal, command: 'cancel' | 'settle' | 'retry', input: unknown, key: string) {
    admin(actor);
    const data = z.object({ requestId: z.uuid(), epoch: z.number().int().min(0), reason: z.string().min(1).max(2000), settlementEvidence: z.url().max(2000).optional() }).strict().parse(input);
    return this.withReceipt(actor, command, data, key, async (db, now) => {
      await this.reconcileWithin(db, now);
      const r = await this.request(db, data.requestId), a = r.attempts.at(-1);
      demand((a?.epoch ?? 0) === data.epoch, 'Attempt epoch changed');
      if (command === 'settle') {
        demand(a && !['dispatched', 'running'].includes(r.state) && data.settlementEvidence, 'Terminate/cancel first and provide independent settlement evidence');
        a.settled = true; await db.query('DELETE FROM validation_resources WHERE request_id=$1', [r.id]);
      } else if (command === 'retry') {
        demand(a && a.settled && ['expired', 'completed', 'cancelled'].includes(r.state) && r.attempts.length < r.maxAttempts && Date.parse(r.deadline) > now.getTime(), 'Retry needs settled prior execution, time and attempt budget');
        const c = await this.candidate(db, r.candidateId), w = await this.work(db, r.workId, now); await this.valid(db, c, w);
        demand(w.validation?.[r.proof]?.requestId === r.id, 'Newer request supersedes retry');
        await this.registration(db, r.runner, 'runner'); await this.registration(db, r.collector, 'collector');
        r.state = 'queued'; delete r.result;
      } else {
        demand(['queued', 'dispatched', 'running'].includes(r.state), 'Request is already terminal');
        await this.endActiveAttempt(db, r, 'cancelled', now);
        r.state = 'cancelled';
        // Running cancellation is not physical termination. Only never-ACKed
        // attempts can be settled here; prior retry history stays untouched.
      }
      await this.persist(db, r); await this.event(db, actor.id, command, { request: r, reason: data.reason, settlementEvidence: data.settlementEvidence }, r.workId);
      if (command !== 'settle') await this.invalidateBinding(db, r, now, actor.id);
      return r;
    });
  }
  private async endActiveAttempt(db: pg.PoolClient, r: ValidationRequest, state: 'cancelled' | 'expired' | 'superseded', now: Date) {
    const a = r.attempts.at(-1);
    if (!a || !['dispatched', 'running'].includes(r.state)) return;
    if (r.state === 'dispatched') {
      // ACK and revocation/termination serialize on the same coordination lock.
      // A later ACK cannot succeed, so this attempt never acquired execution authority.
      a.settled = true; await db.query('DELETE FROM validation_resources WHERE request_id=$1', [r.id]);
    }
    a.state = state; a.finishedAt = now.toISOString();
  }
  private async invalidateBinding(db: pg.PoolClient, r: ValidationRequest, now: Date, actor: string) {
    const w = (await db.query('SELECT document FROM work_items WHERE id=$1', [r.workId])).rows[0]?.document as Work;
    if (w && w.stage !== 'done' && w.validation?.[r.proof]?.requestId === r.id) {
      delete w.validation[r.proof].attemptId;
      await this.changed(db, w, actor, 'invalidated', now, { requestId: r.id });
    }
  }
  private async reconcileWithin(db: pg.PoolClient, now: Date, includeCompleted = false) {
    // Enumerate current proof selections first, then look up those request IDs.
    // Historical completed attempts never enter the authority verification loop.
    const requests: ValidationRequest[] = (await db.query(`
      WITH selected AS MATERIALIZED (
        SELECT w.document AS work, (v.value->>'requestId')::uuid AS request_id
        FROM work_items w CROSS JOIN LATERAL jsonb_each(COALESCE(w.document->'validation','{}'::jsonb)) v
        WHERE w.document->>'stage'<>'done' AND v.value ? 'requestId'
      )
      SELECT document FROM validation_requests WHERE document->>'state' IN ('queued','dispatched','running')
      UNION ALL
      SELECT r.document FROM selected s JOIN validation_requests r ON r.id=s.request_id
      JOIN validation_candidates c ON c.id=(r.document->>'candidateId')::uuid
      WHERE r.document->>'state'='completed' AND ($1::boolean
        OR c.document->>'policyRevision' IS DISTINCT FROM s.work->>'policyRevision'
        OR c.document->>'sourceSha' IS DISTINCT FROM s.work->'candidate'->>'sha'
        OR c.document->>'baseSha' IS DISTINCT FROM s.work->'candidate'->>'baseSha')
    `, [includeCompleted])).rows.map(r => r.document);
    for (const r of requests) {
      const c = await this.candidate(db, r.candidateId), w = (await db.query('SELECT document FROM work_items WHERE id=$1', [r.workId])).rows[0]?.document as Work;
      let invalid = !w || w.validation?.[r.proof]?.requestId !== r.id || w.validation[r.proof].candidateId !== c.id;
      try { await this.valid(db, c, w); await this.registration(db, r.runner, 'runner'); await this.registration(db, r.collector, 'collector'); } catch { invalid = true; }
      const a = r.attempts.at(-1);
      if (invalid) {
        await this.endActiveAttempt(db, r, 'superseded', now); r.state = 'superseded';
      } else if (r.state !== 'completed' && (Date.parse(r.deadline) <= now.getTime() || a && ['dispatched', 'running'].includes(r.state) && Date.parse(a.expiresAt) <= now.getTime())) {
        // Unacknowledged runners are prohibited from starting. Their expired ACK
        // cannot succeed; no execution was authorized, so those slots are reusable.
        await this.endActiveAttempt(db, r, 'expired', now); r.state = 'expired';
      } else continue;
      await this.persist(db, r); await this.event(db, 'graphyard', r.state, { request: r }, r.workId); await this.invalidateBinding(db, r, now, 'graphyard');
    }
  }
  async reconcile(includeCompleted = false) { await this.store.transaction((db, now) => this.reconcileWithin(db, now, includeCompleted)); }
}
