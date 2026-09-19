import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type pg from 'pg';
import { admin, demand, proofSchema, Refusal, type EvidenceArtifact, type Principal, type Work } from './model.js';
import { save, wakeJob } from './store.js';
import { authorizedForEveryProof, authorizedForProof } from './proof-grants.js';
import { Engine } from './engine.js';
import { producerIndependenceRefusal } from './delegation.js';
import type { Scenario } from './scenarios.js';
import { defaultReportFormat, reportFormats } from './report-adapters.js';
import { defaultArtifactCapacityBytes, type ArtifactBackend } from './artifacts.js';

const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/).max(150);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const revision = z.number().int().positive();
const base = { id: name, expectedRevision: z.number().int().min(0) };
const resourceNames = z.array(name).min(1).max(30).refine(a => new Set(a).size === a.length, 'Resources must be unique');
const artifacts = z.array(z.object({ service: name, digest }).strict()).min(1).max(30).refine(a => new Set(a.map(x => x.service)).size === a.length, 'Services must be unique');
const ref = z.object({ id: name, revision }).strict();
const safeHttpUrl = (value: string) => { try { const parsed = new URL(value); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { return false; } };
const externalUrl = z.url().max(2000).refine(safeHttpUrl, 'Artifact URL must be HTTP(S) without credentials');
export const definitionSchema = z.discriminatedUnion('kind', [
  // `delivery` is the environment's release policy: how recent a verified common interval
  // must be, and whether selecting an expected release needs a separate operator approval.
  // Absent, the defaults are the conservative ones.
  z.object({ ...base, kind: z.literal('environment'), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), url: z.url().max(2000).refine(s => { const u = new URL(s); return u.protocol === 'https:' && !u.username && !u.password && !u.hash && !u.search; }, 'Use HTTPS without credentials, query or fragment'), instance: name, immutable: z.literal(true), services: resourceNames, resources: resourceNames, delivery: z.object({ freshnessSeconds: z.number().int().min(30).max(86_400), approvalRequired: z.boolean(), automaticRollback: z.boolean().optional() }).strict().optional() }).strict(),
  // Observer and promoter registrations are D3's deployment identities: an observer reports
  // runtime facts for its named services only, a promoter may define and select the expected
  // release. `services` is required for both and refused for every other role.
  // A rollback registration is D4's executor identity: service-scoped like an observer, it
  // declares how its provider fences a mutation and whether it may act without an operator.
  // `queueLimit` is a runner's backpressure bound: queued requests beyond it refuse creation.
  z.object({ ...base, kind: z.literal('registration'), principalId: name, role: z.enum(['runner', 'collector', 'builder', 'observer', 'promoter', 'rollback']), environment: ref, adapterVersion: name, proofs: z.array(proofSchema).max(50), enabled: z.boolean(), executionHost: z.string().min(1).max(500).optional(), attestationPublicKey: z.string().min(32).max(4096).optional(), executionNetwork: z.string().min(1).max(60).optional(), testAccountDigest: digest.optional(), services: resourceNames.optional(), queueLimit: z.number().int().min(1).max(100).optional(), rollback: z.object({ fencing: z.enum(['provider', 'serialized', 'none']), automatic: z.boolean() }).strict().optional() }).strict(),
  z.object({ ...base, kind: z.literal('bundle'), scenario: name, scenarioRevision: revision, scenarioHash: z.string().regex(/^[a-f0-9]{64}$/), digest, runnerImageDigest: digest, reportFormat: z.enum(reportFormats).default(defaultReportFormat) }).strict(),
]);
type DefinitionInput = z.infer<typeof definitionSchema>;
export type Definition = DefinitionInput & { revision: number; createdAt: string; createdBy: string };
export type Environment = Definition & { kind: 'environment' };
export type Registration = Definition & { kind: 'registration' };
export const deliveryPolicy = (environment: Environment) => ({ freshnessSeconds: 300, approvalRequired: true, automaticRollback: false, ...environment.delivery });
export const defaultQueueLimit = 20;
export type RollbackFencing = 'provider' | 'serialized' | 'none';
type Bundle = Definition & { kind: 'bundle' };
const attestationSchema = z.object({ registration: ref, workId: z.uuid(), expectedWorkRevision: revision, sourceSha: sha, baseSha: sha, buildInputsDigest: digest, artifacts, provenanceUrl: z.url().max(2000) }).strict();
export type BuildAttestation = z.infer<typeof attestationSchema> & { id: string; producer: string; at: string; repository: string };
const candidateSchema = z.object({ workId: z.uuid(), expectedWorkRevision: revision, proof: proofSchema, environment: ref, bundle: ref, buildAttestationId: z.uuid(), requiredArtifacts: resourceNames, artifactStorage: z.enum(['external', 'postgres']).default('external') }).strict();
export type ValidationCandidate = z.infer<typeof candidateSchema> & { id: string; sourceSha: string; baseSha: string; policyRevision: number; scenario: { revision: number; hash: string; environment: string }; createdAt: string; createdBy: string };
const requestSchema = z.object({ candidateId: z.uuid(), expectedWorkRevision: revision, runner: ref, collector: ref, deadline: z.iso.datetime(), maxAttempts: z.number().int().min(1).max(5) }).strict();
export type Attempt = { id: string; epoch: number; dispatchedAt: string; expiresAt: string; acknowledgedAt?: string; lastHeartbeatAt?: string; finishedAt?: string; state: 'dispatched' | 'running' | 'completed' | 'expired' | 'cancelled' | 'superseded'; settled: boolean };
export type ValidationRequest = z.infer<typeof requestSchema> & { id: string; workId: string; proof: string; state: 'queued' | 'dispatched' | 'running' | 'collecting' | 'completed' | 'cancelled' | 'expired' | 'superseded'; attempts: Attempt[]; createdAt: string; createdBy: string; result?: { accepted: boolean; passed: boolean; reasons: string[] } };
const commandSchema = z.object({ requestId: z.uuid(), attemptId: z.uuid(), epoch: revision }).strict();
const reportSchema = commandSchema.extend({
  execution: z.enum(['completed', 'cancelled', 'timed_out']), behavior: z.enum(['passed', 'failed', 'blocked', 'unmeasured']),
  executed: z.number().int().min(0).max(1_000_000), skipped: z.number().int().min(0).max(1_000_000), inventoryComplete: z.boolean(),
  target: z.object({ instance: name, artifacts, measurement: z.enum(['provider', 'host-attestation', 'unknown']), coversEntireRun: z.boolean(), attribution: z.enum(['matched', 'mismatched', 'changed', 'unknown']) }).strict(),
  bundleDigest: digest, runnerImageDigest: digest,
  artifacts: z.array(z.object({ name, digest, url: z.union([externalUrl, z.string().regex(/^graphyard-artifact:\/\/[^?#]+\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/)]) }).strict()).max(30),
  artifactState: z.enum(['verified', 'missing', 'upload-failed', 'expired']), executionSettled: z.boolean(),
}).strict();
type Report = z.infer<typeof reportSchema>;
/** Stored artifact metadata. `state` is the retention state; bytes live in the row for the postgres backend and at `location` otherwise. */
type ArtifactRow = { id: string; name: string; digest: string; expires_at: Date; media_type: string; size: string | number | null; state: 'pending' | 'stored' | 'upload-failed' | 'expired'; backend: string; location: string | null; bytes: Buffer | null };
/** A runner's renewal interval; a running attempt quieter than this for longer is stalled. */
export const heartbeatIntervalMs = 20_000;
export type RequestCondition = 'queued-starved' | 'queued-waiting-for-slot' | 'queued-resource-held' | 'unacknowledged' | 'running' | 'heartbeat-missing' | 'collecting' | 'collection-stalled' | 'awaiting-settlement' | 'retryable' | 'settled';
export interface RequestDiagnosis { requestId: string; workId: string; proof: string; state: ValidationRequest['state']; runner: { id: string; revision: number }; attempt: { id: string; epoch: number; dispatchedAt: string; acknowledgedAt: string | null; lastHeartbeatAt: string | null; expiresAt: string; state: Attempt['state']; settled: boolean } | null; dwellSeconds: number; condition: RequestCondition; nextStep: string }
export interface RunnerCapacity { registration: { id: string; revision: number }; principalId: string; environment: string; enabled: boolean; lastPollAt: string | null; executing: string | null; queued: number; queueLimit: number; oldestQueuedSeconds: number | null }
export interface ArtifactCapacity { backend: string; capacityBytes: number; usedBytes: number; retained: number; pending: number; uploadFailed: number; expired: number; expiringWithin24h: number; awaitingDeletion: number }
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const same = isDeepStrictEqual;

/** No network I/O here. Collectors, build producers and operators are separate trust boundaries. */
export class Validation {
  /** External artifact bytes, when configured. Null keeps bytes in the Postgres row. */
  artifactBackend: ArtifactBackend | null = null;
  artifactCapacityBytes = defaultArtifactCapacityBytes;
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
  async definition(db: pg.PoolClient, kind: Definition['kind'], selected: { id: string; revision: number }, current = true): Promise<Definition> {
    const rows = (await db.query('SELECT document FROM validation_definitions WHERE kind=$1 AND id=$2 ORDER BY revision DESC', [kind, selected.id])).rows;
    const found = rows.find(r => r.document.revision === selected.revision)?.document as Definition | undefined;
    demand(found && (!current || rows[0].document.revision === selected.revision), 'Definition missing or authorization generation superseded');
    return found;
  }
  async registration(db: pg.PoolClient, selected: { id: string; revision: number }, role: Registration['role']): Promise<Registration> {
    const r = await this.definition(db, 'registration', selected) as Registration;
    const p = this.principals.find(p => p.id === r.principalId);
    demand(r.enabled && r.role === role && p && p.role === (role === 'runner' ? 'worker' : 'producer'), 'Registration revoked or principal role is not authorized');
    if (role === 'collector') demand(await authorizedForEveryProof(db, p, r.proofs), 'Collector proof authority was revoked');
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
        if (data.enabled && data.role === 'collector') demand(principal && await authorizedForEveryProof(db, principal, data.proofs), 'Collector cannot exceed its granted proof authority');
        if (data.enabled && data.role === 'runner') {
          // A local socket only. The attestor measures the approved bundle and the attempt
          // boundary on its own filesystem, while a remote daemon would resolve the same
          // mount pathnames on a different one — attesting bytes nobody measured.
          demand(data.executionHost && /^unix:\/\/\//.test(data.executionHost) && data.attestationPublicKey, 'Runner registration must pin a local unix:// Docker socket as its execution host, and a trusted attestor public key');
          // Docker resolves a network name against every network the daemon already has.
          // Left to runner configuration, it could attach the browser container to the
          // networks carrying databases and other internal services, so the approved
          // isolated network is operator-versioned authority like the host and key.
          demand(!!data.executionNetwork && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,59}$/.test(data.executionNetwork) && !['host', 'bridge', 'default', 'none'].includes(data.executionNetwork), 'Runner registration must pin a dedicated isolated Docker network');
          let keyType: string | undefined; try { keyType = createPublicKey(data.attestationPublicKey).asymmetricKeyType; } catch { /* invalid key */ }
          demand(keyType === 'ed25519', 'Runner host attestor must use a valid Ed25519 public key');
        }
        if (data.role !== 'runner') demand(!data.executionHost && !data.attestationPublicKey && !data.executionNetwork && !data.testAccountDigest && data.queueLimit === undefined, 'Only runner registrations may configure execution authority or a queue limit');
        if (data.role === 'observer' || data.role === 'promoter' || data.role === 'rollback') {
          const environment = await this.definition(db, 'environment', data.environment, false) as Environment;
          demand(!!data.services?.length && data.services.every(service => environment.services.includes(service)), 'Observer, promoter and rollback registrations must name services of their environment');
          demand(!data.proofs.length, 'Deployment identities carry no proof scope');
        } else demand(!data.services, 'Only observer, promoter and rollback registrations are service-scoped');
        if (data.role === 'rollback') {
          // An adapter that can neither fence the provider write nor observe its own operation
          // settle may still execute an operator-requested rollback behind the serialized
          // barrier; it can never be the one that decides to roll back.
          demand(!!data.rollback, 'Rollback registrations must declare their fencing and whether they may act automatically');
          demand(!data.rollback!.automatic || data.rollback!.fencing !== 'none', 'An unfenced rollback adapter cannot offer automatic rollback');
        } else demand(!data.rollback, 'Only rollback registrations declare rollback fencing');
      }
      if (data.kind === 'bundle') {
        const s = (await db.query('SELECT document FROM scenarios WHERE id=$1 AND revision=$2', [data.scenario, data.scenarioRevision])).rows[0]?.document as Scenario | undefined;
        demand(s?.hash === data.scenarioHash, 'Bundle approval must pin an existing scenario revision and hash');
        const prior: Bundle[] = (await db.query("SELECT document FROM validation_definitions WHERE kind='bundle' AND document->>'scenario'=$1 AND (document->>'scenarioRevision')::int=$2", [data.scenario, data.scenarioRevision])).rows.map(r => r.document);
        demand(prior.every(p => p.digest === data.digest && p.runnerImageDigest === data.runnerImageDigest && (p.reportFormat ?? defaultReportFormat) === data.reportFormat), 'Changed executable bundles require a new scenario revision and work pinned to it');
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
      // The collector mints trusted evidence, so it carries the same independence
      // requirement as any other proof producer.
      const dependent = producerIndependenceRefusal(this.principals.find(p => p.id === collector.principalId) ?? { id: collector.principalId, role: 'producer' }, w, this.principals);
      demand(!dependent, dependent ?? 'Result collector is not independent', 403);
      demand(same(runner.environment, c.environment) && same(collector.environment, c.environment) && collector.proofs.includes(c.proof), 'Runner/collector environment or proof scope differs');
      demand(Date.parse(data.deadline) > now.getTime() && Date.parse(data.deadline) <= now.getTime() + 3_600_000, 'Deadline must be within the next hour');
      // Backpressure: a runner's queue is bounded by its registration. A request the runner
      // could not reach for an hour is a deadline miss waiting to happen, not a plan.
      const queued = Number((await db.query("SELECT count(*) FROM validation_requests WHERE document->>'state'='queued' AND document->'runner'->>'id'=$1", [data.runner.id])).rows[0].count);
      const queueLimit = runner.queueLimit ?? defaultQueueLimit;
      demand(queued < queueLimit, `Runner ${data.runner.id} already has ${queued} queued requests, its queue limit; wait for dwell to drain, cancel stale requests or register more runners`, 429);
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
      // Every poll is recorded: a queue nobody has polled is starved, and that is a different
      // problem from a queue whose runner is busy or whose resources another attempt holds.
      const poll = async (granted: string | null) => db.query('INSERT INTO validation_runner_polls(registration_id,principal,polled_at,granted_request_id) VALUES($1,$2,$3,$4) ON CONFLICT(registration_id) DO UPDATE SET principal=EXCLUDED.principal,polled_at=EXCLUDED.polled_at,granted_request_id=EXCLUDED.granted_request_id', [registration.id, actor.id, now, granted]);
      await poll(null);
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
        await this.changed(db, w, actor.id, 'dispatched', now, { requestId: r.id, attempt, resources }); await poll(r.id);
        const build = (await db.query('SELECT document FROM validation_builds WHERE id=$1', [c.buildAttestationId])).rows[0].document as BuildAttestation;
        const bundle = await this.definition(db, 'bundle', c.bundle) as Bundle;
        return { request: r, candidate: c, build, environment, bundle: { ...bundle, reportFormat: bundle.reportFormat ?? defaultReportFormat }, attempt,
          // Which approved test-account material the attempt may run with travels with the
          // rest of the execution authority. Left to the runner, the choice of account —
          // and of the privileges its evidence would cover — would be the runner's.
          executionAuthority: { host: registration.executionHost!, attestationPublicKey: registration.attestationPublicKey!, network: registration.executionNetwork!, testAccountDigest: registration.testAccountDigest ?? null } };
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
      if (command === 'heartbeat') a.lastHeartbeatAt = now.toISOString();
      await this.persist(db, r); await this.event(db, actor.id, command, { requestId: r.id, attempt: a }, r.workId); return r;
    });
  }
  async collectionHeartbeat(actor: Principal, input: unknown, key: string) {
    demand(actor.role === 'producer', 'A separate trusted collector is required', 403); const data = commandSchema.parse(input);
    return this.withReceipt(actor, 'collection-heartbeat', data, key, async (db, now) => {
      await this.reconcileWithin(db, now);
      const r = await this.request(db, data.requestId), a = r.attempts.at(-1);
      const registration = await this.registration(db, r.collector, 'collector');
      demand(registration.principalId === actor.id && await authorizedForProof(db, actor, r.proof), 'Wrong collector principal or proof authority', 403);
      demand(a && a.id === data.attemptId && a.epoch === data.epoch && r.state === 'collecting' && Date.parse(a.expiresAt) > now.getTime(), 'Attempt lease expired, cancelled or superseded, or collection authority was never taken over');
      a.expiresAt = new Date(Math.min(now.getTime() + 60_000, Date.parse(r.deadline))).toISOString(); a.lastHeartbeatAt = now.toISOString();
      await this.persist(db, r); await this.event(db, actor.id, 'collection-heartbeat', { requestId: r.id, attempt: a }, r.workId); return r;
    });
  }
  /**
   * The collection handoff. Taking authority is what *ends* the runner's: `collecting`
   * refuses further ACKs and heartbeats, so the runner aborts instead of starting or
   * restarting a container after the collector has observed settlement.
   */
  async collectionAuthority(actor: Principal, input: unknown) {
    demand(actor.role === 'producer', 'A separate trusted collector is required', 403); const data = commandSchema.parse(input);
    return this.store.transaction(async (db, now) => {
      await this.reconcileWithin(db, now);
      const r = await this.request(db, data.requestId), a = r.attempts.at(-1), c = await this.candidate(db, r.candidateId);
      const collector = await this.registration(db, r.collector, 'collector');
      demand(collector.principalId === actor.id && await authorizedForProof(db, actor, r.proof), 'Wrong collector principal or proof authority', 403);
      demand(a && a.id === data.attemptId && a.epoch === data.epoch, 'Attempt authority differs', 403);
      demand(['running', 'collecting'].includes(r.state) && Date.parse(a.expiresAt) > now.getTime() && Date.parse(r.deadline) > now.getTime(), 'Attempt lease expired, cancelled or superseded');
      if (r.state !== 'collecting') {
        // Revoke execution authority first, then extend the lease for the collector.
        r.state = 'collecting'; a.expiresAt = new Date(Math.min(now.getTime() + 60_000, Date.parse(r.deadline))).toISOString();
        await this.persist(db, r); await this.event(db, actor.id, 'collecting', { requestId: r.id, attempt: a }, r.workId);
      }
      const runner = await this.definition(db, 'registration', r.runner, false) as Registration;
      const environment = await this.definition(db, 'environment', c.environment, false) as Environment;
      const bundle = await this.definition(db, 'bundle', c.bundle, false) as Bundle;
      return { requestId: r.id, attemptId: a.id, epoch: a.epoch, runner: r.runner,
        executionHost: runner.executionHost, attestationPublicKey: runner.attestationPublicKey, executionNetwork: runner.executionNetwork,
        bundleDigest: bundle.digest, runnerImageDigest: bundle.runnerImageDigest, reportFormat: bundle.reportFormat ?? defaultReportFormat, targetUrl: environment.url, deadline: r.deadline,
        testAccountDigest: runner.testAccountDigest ?? null };
    });
  }
  /**
   * What the host attestor reads for itself before it starts a container.
   *
   * The attestor is handed a plan by the runner over a pipe, and a caller that can invoke
   * it can say anything on that pipe — including `proceed` for an attempt Graphyard never
   * dispatched, never acknowledged, or has already taken back. So the attestor verifies
   * the authority here instead: this returns the attempt authority Graphyard currently
   * holds, with the lease state needed to decide whether it may still be executed.
   *
   * It is a read: no attempt state changes, and the credential that may call it is
   * read-only. An attestor that could also acknowledge, heartbeat or publish would be the
   * runner and the collector at once, which is the separation this whole path exists for.
   */
  async attemptAuthority(actor: Principal, requestId: string) {
    demand(actor.role === 'admin' || actor.role === 'reader', 'A read-only attestor credential is required', 403);
    z.uuid().parse(requestId);
    return this.store.transaction(async (db, now) => {
      const r = await this.request(db, requestId), a = r.attempts.at(-1);
      demand(a, 'No attempt has been dispatched for this request', 404);
      const c = await this.candidate(db, r.candidateId);
      const runner = await this.definition(db, 'registration', r.runner, false) as Registration;
      const environment = await this.definition(db, 'environment', c.environment, false) as Environment;
      const bundle = await this.definition(db, 'bundle', c.bundle, false) as Bundle;
      return {
        grant: { requestId: r.id, attemptId: a!.id, epoch: a!.epoch, runner: r.runner,
          executionHost: runner.executionHost, attestationPublicKey: runner.attestationPublicKey, executionNetwork: runner.executionNetwork,
          bundleDigest: bundle.digest, runnerImageDigest: bundle.runnerImageDigest, reportFormat: bundle.reportFormat ?? defaultReportFormat, targetUrl: environment.url, deadline: r.deadline,
          testAccountDigest: runner.testAccountDigest ?? null },
        // `running` is the only state in which an attempt may still start a container:
        // `dispatched` has not been acknowledged, and `collecting` means the collector has
        // already taken authority and observed settlement.
        state: r.state, acknowledged: !!a!.acknowledgedAt, expiresAt: a!.expiresAt, now: now.toISOString(),
      };
    });
  }
  async result(actor: Principal, input: unknown, key: string) {
    demand(actor.role === 'producer', 'A separate trusted collector is required', 403); const data = reportSchema.parse(input);
    return this.withReceipt(actor, 'result', data, key, async (db, now) => {
      const r = await this.request(db, data.requestId);
      const pinned = await this.definition(db, 'registration', r.collector, false) as Registration;
      demand(pinned.principalId === actor.id && await authorizedForProof(db, actor, r.proof), 'Wrong collector principal or proof authority', 403);
      await this.reconcileWithin(db, now);
      const current = await this.request(db, r.id), a = current.attempts.at(-1), c = await this.candidate(db, r.candidateId);
      const w = (await db.query('SELECT document FROM work_items WHERE id=$1', [r.workId])).rows[0]?.document as Work;
      const rejection: string[] = [];
      try { await this.registration(db, r.runner, 'runner'); await this.registration(db, r.collector, 'collector'); await this.valid(db, c, w); } catch { rejection.push('Candidate or registration authority was revoked or superseded'); }
      if (!a || a.id !== data.attemptId || a.epoch !== data.epoch || current.state !== 'collecting' || Date.parse(a.expiresAt) <= now.getTime() || Date.parse(r.deadline) <= now.getTime()) rejection.push('Result does not hold the current live acknowledged attempt under collection authority');
      if (w.validation?.[r.proof]?.candidateId !== c.id || w.validation?.[r.proof]?.requestId !== r.id || w.validation?.[r.proof]?.attemptId !== a?.id) rejection.push('A newer validation selection supersedes this result');
      const dependent = producerIndependenceRefusal(actor, w, this.principals);
      if (dependent) rejection.push(dependent);
      if (rejection.length) {
        const result = { accepted: false, passed: false, reasons: rejection };
        // Commit rejection + receipt. Throwing here would erase the audit.
        await this.event(db, actor.id, 'result-rejected', { requestId: r.id, attemptId: data.attemptId, epoch: data.epoch, reportHash: hash(data), result }, r.workId); return result;
      }
      const reasons = await this.reportReasons(db, c, data);
      let expiresAt: string | undefined;
      const evidenceArtifacts: EvidenceArtifact[] = [];
      if (c.artifactStorage === 'postgres') {
        const stored: ArtifactRow[] = (await db.query('SELECT id,name,digest,expires_at,media_type,size,state,backend,location FROM validation_artifacts WHERE request_id=$1 AND attempt_id=$2', [r.id, a!.id])).rows;
        for (const required of c.requiredArtifacts) {
          const supplied = data.artifacts.find(x => x.name === required);
          const actual = stored.find(x => x.name === required && supplied?.digest === x.digest && supplied?.url === this.artifactUrl(r.id, x.id));
          // Each refusal names its own state: an upload that failed, retention that lapsed and
          // bytes that never arrived call for different next steps.
          const availability = !actual ? 'missing' : actual.state === 'upload-failed' ? 'upload-failed' : actual.state === 'stored' && actual.expires_at > now ? 'available' : actual.state === 'pending' ? 'missing' : 'expired';
          if (availability === 'upload-failed') reasons.push(`Private artifact ${required} upload failed; the collector must retry the upload or the attempt is unverifiable`);
          else if (availability === 'expired') reasons.push(`Private artifact ${required} retention expired`);
          else if (availability !== 'available') reasons.push(`Private artifact ${required} is missing, expired or mismatched`);
          if (actual) {
            const artifactExpiry = actual.expires_at.toISOString();
            if (!expiresAt || artifactExpiry < expiresAt) expiresAt = artifactExpiry;
            evidenceArtifacts.push({ kind: this.artifactKind(actual.name, actual.media_type), label: actual.name, mediaType: actual.media_type, size: Number(actual.size ?? 0), digest: actual.digest, expiresAt: artifactExpiry,
              availability, reference: { requestId: r.id, artifactId: actual.id } });
          } else evidenceArtifacts.push({ kind: this.artifactKind(required), label: required, availability: 'missing' });
        }
      } else evidenceArtifacts.push(...data.artifacts.map(artifact => safeHttpUrl(artifact.url)
        ? { kind: this.artifactKind(artifact.name), label: artifact.name, digest: artifact.digest, availability: 'external' as const, url: artifact.url }
        : { kind: this.artifactKind(artifact.name), label: artifact.name, digest: artifact.digest, availability: 'missing' as const }));
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
    const backend = this.artifactBackend;
    if (!backend) return this.withReceipt(actor, 'artifact', { ...metadata, digest }, key, async (db, now) => {
      const { r, a } = await this.artifactAuthority(db, actor, data, bytes.length, now);
      demand(!(await db.query('SELECT id FROM validation_artifacts WHERE request_id=$1 AND attempt_id=$2 AND name=$3', [r.id, a.id, data.name])).rowCount, 'Artifact name already published; reuse the original idempotency key');
      const id = randomUUID(), expiresAt = new Date(now.getTime() + 7 * 86_400_000).toISOString();
      await db.query('INSERT INTO validation_artifacts(id,request_id,attempt_id,name,digest,created_at,expires_at,media_type,bytes,backend,location,state,size) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11,$12)', [id, r.id, a.id, data.name, digest, now, expiresAt, data.mediaType, bytes, 'postgres', 'stored', bytes.length]);
      const result = { id, requestId: r.id, attemptId: a.id, name: data.name, digest, size: bytes.length, expiresAt, url: this.artifactUrl(r.id, id), backend: 'postgres' };
      await this.event(db, actor.id, 'artifact-stored', { ...result, capturePolicy: data.capturePolicy }, r.workId); return result;
    });
    // An external backend: authorize and reserve the name under the coordination lock, move
    // the bytes with the lock released, then publish under the same authority re-checked.
    // A failed move is a visible `upload-failed` row, never a silent absence; the same key
    // resumes it, so a collector's retry of an ambiguous transport failure converges.
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const fingerprint = hash({ command: 'validation.artifact', data: { ...metadata, digest } });
    const receiptOf = async (db: pg.PoolClient) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) demand(receipt.fingerprint === fingerprint, 'Idempotency key reused with different input');
      return receipt?.result;
    };
    const reservation = await this.store.transaction(async (db, now) => {
      const done = await receiptOf(db); if (done) return { done };
      const { r, a } = await this.artifactAuthority(db, actor, data, bytes.length, now);
      const existing: ArtifactRow | undefined = (await db.query('SELECT id,digest,state,location,expires_at FROM validation_artifacts WHERE request_id=$1 AND attempt_id=$2 AND name=$3', [r.id, a.id, data.name])).rows[0];
      demand(!existing || existing.state !== 'stored' && existing.state !== 'expired', 'Artifact name already published; reuse the original idempotency key');
      demand(!existing || existing.digest === digest, 'A failed upload can only be resumed with the same bytes');
      if (existing) return { id: existing.id, location: existing.location!, expiresAt: existing.expires_at.toISOString(), requestId: r.id, attemptId: a.id, workId: r.workId };
      const id = randomUUID(), expiresAt = new Date(now.getTime() + 7 * 86_400_000).toISOString(), location = this.artifactLocation(r.id, a.id, id);
      await db.query('INSERT INTO validation_artifacts(id,request_id,attempt_id,name,digest,created_at,expires_at,media_type,bytes,backend,location,state,size) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10,$11,$12)', [id, r.id, a.id, data.name, digest, now, expiresAt, data.mediaType, backend.kind, location, 'pending', bytes.length]);
      await this.event(db, actor.id, 'artifact-reserved', { id, requestId: r.id, attemptId: a.id, name: data.name, digest, size: bytes.length, backend: backend.kind }, r.workId);
      return { id, location, expiresAt, requestId: r.id, attemptId: a.id, workId: r.workId };
    });
    if ('done' in reservation) return reservation.done;
    try { await backend.put(reservation.location, bytes, data.mediaType); }
    catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown';
      await this.store.transaction(async (db, now) => {
        await db.query("UPDATE validation_artifacts SET state='upload-failed' WHERE id=$1 AND state='pending'", [reservation.id]);
        await this.event(db, actor.id, 'artifact-upload-failed', { id: reservation.id, requestId: reservation.requestId, attemptId: reservation.attemptId, name: data.name, backend: backend.kind, reason, at: now.toISOString() }, reservation.workId);
      });
      throw new Refusal(`Artifact upload to ${backend.label} failed: ${reason}. Retry with the same idempotency key; the artifact is recorded as upload-failed until it succeeds`, 503);
    }
    try {
      return await this.store.transaction(async (db, now) => {
        const done = await receiptOf(db); if (done) return done;
        const { r, a } = await this.artifactAuthority(db, actor, data, 0, now);
        const row: ArtifactRow | undefined = (await db.query('SELECT id,state,digest FROM validation_artifacts WHERE id=$1', [reservation.id])).rows[0];
        demand(row && row.state !== 'expired' && row.digest === digest, 'Artifact reservation lapsed during the upload');
        await db.query("UPDATE validation_artifacts SET state='stored' WHERE id=$1", [reservation.id]);
        const result = { id: reservation.id, requestId: r.id, attemptId: a.id, name: data.name, digest, size: bytes.length, expiresAt: reservation.expiresAt, url: this.artifactUrl(r.id, reservation.id), backend: backend.kind };
        await this.event(db, actor.id, 'artifact-stored', { ...result, capturePolicy: data.capturePolicy }, r.workId);
        await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]); return result;
      });
    } catch (error) {
      // Authority ended while the bytes were in flight: nothing may publish them now, so the
      // row stays a visible failure and the sweep removes the object with verified deletion.
      await this.store.transaction(async (db, now) => {
        await db.query("UPDATE validation_artifacts SET state='upload-failed' WHERE id=$1 AND state='pending'", [reservation.id]);
        await this.event(db, actor.id, 'artifact-upload-failed', { id: reservation.id, requestId: reservation.requestId, attemptId: reservation.attemptId, name: data.name, backend: backend.kind, reason: error instanceof Error ? error.message : 'unknown', at: now.toISOString() }, reservation.workId);
      });
      throw error;
    }
  }
  /** The live collection authority an upload needs, and the retained-capacity check that precedes storing anything. */
  private async artifactAuthority(db: pg.PoolClient, actor: Principal, data: { requestId: string; attemptId: string; epoch: number; name: string }, incomingBytes: number, now: Date) {
    const r = await this.request(db, data.requestId), a = r.attempts.at(-1);
    const collector = await this.registration(db, r.collector, 'collector');
    demand(collector.principalId === actor.id && await authorizedForProof(db, actor, r.proof), 'Wrong collector principal or proof authority', 403);
    await this.registration(db, r.runner, 'runner');
    const c = await this.candidate(db, r.candidateId), w = await this.work(db, r.workId, now); await this.valid(db, c, w);
    demand(c.artifactStorage === 'postgres' && c.requiredArtifacts.includes(data.name), 'Artifact storage or name is not authorized');
    demand(a && a.id === data.attemptId && a.epoch === data.epoch && r.state === 'collecting' && Date.parse(a.expiresAt) > now.getTime() && Date.parse(r.deadline) > now.getTime() && w.validation?.[r.proof]?.requestId === r.id, 'Artifact attempt authority expired or superseded, or collection authority was never taken over');
    if (incomingBytes) {
      const used = Number((await db.query("SELECT COALESCE(SUM(size),0) AS used FROM validation_artifacts WHERE state IN ('stored','pending')")).rows[0].used);
      demand(used + incomingBytes <= this.artifactCapacityBytes, `Artifact capacity exhausted: ${used} of ${this.artifactCapacityBytes} bytes retained; expire or migrate artifacts, or raise GRAPHYARD_ARTIFACT_CAPACITY_BYTES`, 507);
    }
    return { r, a: a!, c, w };
  }
  private artifactLocation(requestId: string, attemptId: string, artifactId: string) { return `${this.repository.replace(/[^a-zA-Z0-9._-]/g, '_')}/${requestId}/${attemptId}/${artifactId}`; }
  async readArtifact(actor: Principal, requestId: string, artifactId: string) {
    z.uuid().parse(requestId); z.uuid().parse(artifactId);
    const authorized = await this.store.transaction(async (db, now) => {
      const r = await this.request(db, requestId);
      const w = (await db.query('SELECT document FROM work_items WHERE id=$1', [r.workId])).rows[0]?.document as Work | undefined;
      const collector = await this.definition(db, 'registration', r.collector, false) as Registration;
      const c = await this.candidate(db, r.candidateId), environment = await this.definition(db, 'environment', c.environment, false) as Environment;
      demand(environment.repository === this.repository, 'Artifact repository scope differs', 403);
      if (actor.role === 'producer') await this.registration(db, r.collector, 'collector');
      // This single-repository server grants readers repository-wide audit access.
      // Workers see only their assigned work; producers see only their collection request.
      const collecting = actor.role === 'producer' && collector.principalId === actor.id && await authorizedForProof(db, actor, r.proof);
      demand(actor.role === 'admin' || actor.role === 'reader' || actor.role === 'worker' && w?.lastAssignment?.owner === actor.id || collecting, 'Artifact access is not authorized for this request', 403);
      const row: ArtifactRow | undefined = (await db.query('SELECT id,name,digest,expires_at,media_type,size,state,backend,location,bytes FROM validation_artifacts WHERE id=$1 AND request_id=$2', [artifactId, requestId])).rows[0];
      demand(row, 'Artifact not found for this request', 404);
      demand(row!.state !== 'upload-failed' && row!.state !== 'pending', 'Artifact upload failed or never completed; no bytes were retained', 410);
      demand(row!.state === 'stored' && row!.expires_at > now, 'Artifact retention expired', 410);
      if (row!.backend === 'postgres') demand(row!.bytes, 'Artifact retention expired', 410);
      await this.event(db, actor.id, 'artifact-read', { requestId, artifactId, backend: row!.backend }, r.workId);
      return row!;
    });
    // The backend is read with the coordination lock released; the digest recorded at upload
    // is what makes the bytes it returns this artifact and not a substitute.
    let bytes: Buffer | null = authorized.bytes;
    if (authorized.backend !== 'postgres') {
      demand(this.artifactBackend && this.artifactBackend.kind === authorized.backend, `Artifact is stored in the ${authorized.backend} backend, which this server is not configured to read`, 503);
      bytes = await this.artifactBackend!.get(authorized.location!);
      demand(bytes, 'Artifact bytes are missing from the configured backend', 503);
    }
    demand(`sha256:${createHash('sha256').update(bytes!).digest('hex')}` === authorized.digest, 'Artifact integrity check failed', 503);
    return { bytes: bytes!, name: authorized.name, mediaType: authorized.media_type, digest: authorized.digest };
  }
  /**
   * Retention. Expiry is recorded first, under the lock, so reads refuse from that instant;
   * the bytes of an external backend are then removed with the lock released and the removal
   * is verified before the row records `deleted_at`. A deletion the store refused is retried
   * on the next sweep, never assumed.
   */
  async expireArtifacts() {
    const expired = await this.store.transaction(async (db, now) => {
      const rows = (await db.query("SELECT id,request_id,backend FROM validation_artifacts WHERE expires_at<=$1 AND state='stored' ORDER BY expires_at,id LIMIT 50", [now])).rows;
      for (const row of rows) {
        await db.query("UPDATE validation_artifacts SET bytes=NULL,state='expired',deleted_at=CASE WHEN backend='postgres' THEN $2 ELSE deleted_at END WHERE id=$1", [row.id, now]);
        const r = await this.request(db, row.request_id);
        await this.event(db, 'system', 'artifact-expired', { requestId: r.id, artifactId: row.id, backend: row.backend }, r.workId);
      }
      return rows.length;
    });
    await this.deleteExternalArtifacts();
    return expired;
  }
  /** Objects no row may serve any more: expired or failed uploads, and sources left behind by a migration into Postgres. */
  private async deleteExternalArtifacts() {
    const backend = this.artifactBackend;
    if (!backend) return 0;
    const pending: { id: string; request_id: string; location: string }[] = (await this.store.pool.query("SELECT id,request_id,location FROM validation_artifacts WHERE location IS NOT NULL AND deleted_at IS NULL AND backend<>'postgres' AND state IN ('expired','upload-failed') UNION ALL SELECT id,request_id,location FROM validation_artifacts WHERE location IS NOT NULL AND deleted_at IS NULL AND backend='postgres' LIMIT 50")).rows;
    let deleted = 0;
    for (const row of pending) {
      try { await backend.delete(row.location); demand(!(await backend.exists(row.location)), 'Artifact object still exists after deletion', 503); }
      catch (error) { console.error('artifact deletion pending retry', row.id, error instanceof Error ? error.message : 'unknown'); continue; }
      await this.store.transaction(async (db, now) => {
        await db.query('UPDATE validation_artifacts SET deleted_at=$2,location=CASE WHEN backend=$3 THEN NULL ELSE location END WHERE id=$1 AND deleted_at IS NULL', [row.id, now, 'postgres']);
        const r = await this.request(db, row.request_id);
        await this.event(db, 'system', 'artifact-deleted', { requestId: r.id, artifactId: row.id, backend: backend.kind, verified: true }, r.workId);
      });
      deleted++;
    }
    return deleted;
  }
  /**
   * Move retained artifacts between the Postgres row and the configured external backend.
   * Authorization, digest, retention and the request/attempt binding live on the row and
   * do not move; each artifact's bytes are copied, read back and compared with the recorded
   * digest before the row names the new backend, and the old copy is removed only afterwards.
   */
  async migrateArtifacts(actor: Principal, input: unknown) {
    admin(actor);
    const data = z.object({ target: z.enum(['postgres', 's3']), limit: z.number().int().min(1).max(100).default(20) }).strict().parse(input);
    const backend = this.artifactBackend;
    demand(backend, 'No external artifact backend is configured; set GRAPHYARD_ARTIFACT_BACKEND on this server first', 503);
    demand(data.target === 'postgres' || data.target === backend!.kind, `The configured backend is ${backend!.kind}`, 400);
    const candidates: string[] = (await this.store.pool.query("SELECT id FROM validation_artifacts WHERE state='stored' AND backend<>$1 AND expires_at>clock_timestamp() ORDER BY created_at,id LIMIT $2", [data.target, data.limit])).rows.map(r => r.id);
    const migrated: string[] = [], refused: { id: string; reason: string }[] = [];
    for (const id of candidates) {
      const source: ArtifactRow & { request_id: string } | undefined = (await this.store.pool.query("SELECT id,request_id,name,digest,expires_at,media_type,size,state,backend,location,bytes FROM validation_artifacts WHERE id=$1 AND state='stored'", [id])).rows[0];
      if (!source) continue;
      const verify = (bytes: Buffer | null) => bytes && `sha256:${createHash('sha256').update(bytes).digest('hex')}` === source.digest;
      try {
        let bytes: Buffer | null = null, location: string | null = null;
        if (data.target === 'postgres') {
          bytes = await backend!.get(source.location!);
          demand(verify(bytes), 'Source bytes are missing or fail their digest; the artifact stays where it is', 503);
        } else {
          demand(verify(source.bytes), 'Source bytes fail their digest; the artifact stays where it is', 503);
          location = this.artifactLocation(source.request_id, (await this.store.pool.query('SELECT attempt_id FROM validation_artifacts WHERE id=$1', [id])).rows[0].attempt_id, id);
          await backend!.put(location, source.bytes!, source.media_type);
          if (!verify(await backend!.get(location))) { await backend!.delete(location).catch(() => {}); demand(false, 'Copied bytes fail their digest on read-back; the copy was discarded and the artifact stays where it is', 503); }
        }
        await this.store.transaction(async (db, now) => {
          const current: ArtifactRow | undefined = (await db.query('SELECT id,state,digest,expires_at,request_id FROM validation_artifacts WHERE id=$1', [id])).rows[0];
          demand(current && current.state === 'stored' && current.digest === source.digest && current.expires_at > now, 'Artifact changed or expired during migration');
          if (data.target === 'postgres') await db.query("UPDATE validation_artifacts SET backend='postgres',bytes=$2 WHERE id=$1", [id, bytes]);
          else await db.query('UPDATE validation_artifacts SET backend=$2,location=$3,bytes=NULL,deleted_at=NULL WHERE id=$1', [id, backend!.kind, location]);
          await this.event(db, actor.id, 'artifact-migrated', { artifactId: id, requestId: source.request_id, from: source.backend, to: data.target, digest: source.digest, expiresAt: source.expires_at.toISOString() }, (await this.request(db, source.request_id)).workId);
        });
        migrated.push(id);
      } catch (error) { refused.push({ id, reason: error instanceof Error ? error.message : 'unknown' }); }
    }
    // Sources left in the external store after a move into Postgres are removed with verification.
    const deleted = await this.deleteExternalArtifacts();
    const remaining = Number((await this.store.pool.query("SELECT count(*) FROM validation_artifacts WHERE state='stored' AND backend<>$1 AND expires_at>clock_timestamp()", [data.target])).rows[0].count);
    return { target: data.target, migrated, refused, deleted, remaining };
  }
  /** Runner capacity, queue dwell, reserved resources and one diagnosed condition per live request, each with its own next step. */
  async capacity(): Promise<{ now: string; runners: RunnerCapacity[]; resources: { resource: string; requestId: string; attemptId: string | null; state: string; since: string; live: boolean }[]; requests: RequestDiagnosis[]; artifacts: ArtifactCapacity }> {
    const now = (await this.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
    const registrations: Registration[] = (await this.store.pool.query("SELECT DISTINCT ON (id) document FROM validation_definitions WHERE kind='registration' ORDER BY id,revision DESC")).rows.map(r => r.document).filter((d: Registration) => d.role === 'runner');
    const polls = new Map<string, { principal: string; polled_at: Date }>((await this.store.pool.query('SELECT registration_id,principal,polled_at FROM validation_runner_polls')).rows.map(r => [r.registration_id, r]));
    const reserved: { resource: string; request_id: string }[] = (await this.store.pool.query('SELECT resource,request_id FROM validation_resources ORDER BY resource')).rows;
    // Live requests, anything still holding a resource, and terminal attempts an operator could still retry before the deadline.
    const requests: ValidationRequest[] = (await this.store.pool.query(`SELECT document FROM validation_requests WHERE document->>'state' IN ('queued','dispatched','running','collecting') OR id=ANY($1::uuid[])
      OR (document->>'deadline' > $2 AND (document->>'state' IN ('expired','cancelled') OR document->>'state'='completed' AND (document->'result'->>'passed')='false')) ORDER BY document->>'createdAt',id`, [reserved.map(r => r.request_id), now.toISOString()])).rows.map(r => r.document);
    const byId = new Map(requests.map(r => [r.id, r]));
    const seconds = (from: string) => Math.max(0, Math.round((now.getTime() - Date.parse(from)) / 1000));
    const live = (r: ValidationRequest) => { const a = r.attempts.at(-1); return !!a && ['dispatched', 'running', 'collecting'].includes(r.state) && Date.parse(a.expiresAt) > now.getTime(); };
    const resources = reserved.map(row => { const r = byId.get(row.request_id); const a = r?.attempts.at(-1); return { resource: row.resource, requestId: row.request_id, attemptId: a?.id ?? null, state: r?.state ?? 'unknown', since: a?.dispatchedAt ?? r?.createdAt ?? now.toISOString(), live: !!r && live(r) }; });
    const runners: RunnerCapacity[] = registrations.map(reg => {
      const queued = requests.filter(r => r.state === 'queued' && r.runner.id === reg.id);
      const poll = polls.get(reg.id);
      return { registration: { id: reg.id, revision: reg.revision }, principalId: reg.principalId, environment: reg.environment.id, enabled: reg.enabled, lastPollAt: poll ? poll.polled_at.toISOString() : null,
        executing: reserved.find(row => row.resource === `runner:${reg.principalId}`)?.request_id ?? null, queued: queued.length, queueLimit: reg.queueLimit ?? defaultQueueLimit, oldestQueuedSeconds: queued.length ? Math.max(...queued.map(r => seconds(r.createdAt))) : null };
    });
    const diagnoses: RequestDiagnosis[] = [];
    for (const r of requests) {
      const a = r.attempts.at(-1);
      const attempt = a ? { id: a.id, epoch: a.epoch, dispatchedAt: a.dispatchedAt, acknowledgedAt: a.acknowledgedAt ?? null, lastHeartbeatAt: a.lastHeartbeatAt ?? null, expiresAt: a.expiresAt, state: a.state, settled: a.settled } : null;
      const held = reserved.filter(row => row.request_id === r.id);
      let condition: RequestCondition, nextStep: string;
      if (r.state === 'queued') {
        const registration = registrations.find(reg => reg.id === r.runner.id), poll = polls.get(r.runner.id);
        const candidate: ValidationCandidate | undefined = (await this.store.pool.query('SELECT document FROM validation_candidates WHERE id=$1', [r.candidateId])).rows[0]?.document;
        const environment = candidate ? (await this.store.pool.query("SELECT document FROM validation_definitions WHERE kind='environment' AND id=$1 AND revision=$2", [candidate.environment.id, candidate.environment.revision])).rows[0]?.document as Environment | undefined : undefined;
        const needed = registration && environment ? [`runner:${registration.principalId}`, `environment:${environment.id}`, ...environment.resources.map(x => `external:${x}`)] : [];
        const holders = reserved.filter(row => needed.includes(row.resource) && row.request_id !== r.id);
        // A holder still executing under a live lease is ordinary contention; one whose
        // attempt ended without verified settlement is a barrier only settlement can open.
        const executing = holders.find(row => { const holder = byId.get(row.request_id); return holder && live(holder); });
        if (!poll || poll.polled_at.getTime() < Date.parse(r.createdAt)) {
          condition = 'queued-starved';
          nextStep = `No dispatch poll from runner ${r.runner.id}${poll ? ` since ${poll.polled_at.toISOString()}` : ' ever'}; the queue is starved. ${registration?.enabled === false ? 'Its registration is disabled: enable a current revision or route the request to another runner.' : `Start or repair the runner process for registration ${r.runner.id}, or cancel the request and re-request it on a runner that polls.`}`;
        } else if (executing) {
          const holder = byId.get(executing.request_id)!;
          condition = 'queued-waiting-for-slot';
          nextStep = `Runner ${r.runner.id} polled at ${poll.polled_at.toISOString()}; ${executing.resource} is in use by request ${executing.request_id} (${holder.state}) under a live lease, and this request dispatches when that attempt settles. Queue dwell so far ${seconds(r.createdAt)}s; add a runner registration if dwell keeps growing.`;
        } else if (holders.length) {
          const first = byId.get(holders[0].request_id);
          condition = 'queued-resource-held';
          nextStep = `Protected resources ${[...new Set(holders.map(h => h.resource))].join(', ')} are reserved by request ${holders[0].request_id}${first ? ` (${first.state}${first.attempts.at(-1)?.settled === false ? ', settlement not verified' : ''})` : ''}. Wait for its collector to verify settlement, or verify termination yourself and run validation settle with evidence; never release a resource on a timer.`;
        } else {
          condition = 'queued-starved';
          nextStep = `Runner ${r.runner.id} last polled at ${poll.polled_at.toISOString()} but has not polled since this request was created; the queue is starved. Check that the runner process is still polling and that its registration revision ${r.runner.revision} is current.`;
        }
      } else if (r.state === 'dispatched') {
        condition = 'unacknowledged';
        nextStep = `Dispatched to runner ${r.runner.id} at ${a!.dispatchedAt} and not acknowledged; the ACK window ends ${a!.expiresAt}. No execution was authorized, so an expired window settles automatically and the request can be retried with validation retry; inspect the runner's attempt log for the refused or lost grant.`;
      } else if (r.state === 'running') {
        const last = a!.lastHeartbeatAt ?? a!.acknowledgedAt!;
        if (now.getTime() - Date.parse(last) > heartbeatIntervalMs) {
          condition = 'heartbeat-missing';
          nextStep = `Runner ${r.runner.id} acknowledged at ${a!.acknowledgedAt} and last renewed at ${last}, longer ago than the ${heartbeatIntervalMs / 1000}s renewal interval; the lease ends ${a!.expiresAt}. The runner is stalled or partitioned and its execution may still be running: leave its reserved resources alone until the collector observes settlement or an operator verifies termination and settles with evidence.`;
        } else { condition = 'running'; nextStep = `Executing under a live lease renewed at ${last}; nothing to do.`; }
      } else if (r.state === 'collecting') {
        const last = a!.lastHeartbeatAt ?? a!.acknowledgedAt!;
        if (now.getTime() - Date.parse(last) > heartbeatIntervalMs) { condition = 'collection-stalled'; nextStep = `Collector ${r.collector.id} holds authority but last renewed at ${last}; the lease ends ${a!.expiresAt}. Check the collector process; an expired collection keeps the resource barrier closed until settlement is verified.`; }
        else { condition = 'collecting'; nextStep = `Collector ${r.collector.id} is verifying and publishing under a live lease; nothing to do.`; }
      } else if (held.length && a && !a.settled) {
        condition = 'awaiting-settlement';
        nextStep = `Request is ${r.state} but its attempt ${a.epoch} was never verified settled, so ${held.map(h => h.resource).join(', ')} stay reserved. Verify the execution and its external operations have stopped, then run validation settle with settlement evidence.`;
      } else if (a?.settled && ['expired', 'cancelled', 'completed'].includes(r.state) && r.attempts.length < r.maxAttempts && Date.parse(r.deadline) > now.getTime()) {
        condition = 'retryable'; nextStep = `Attempt ${a.epoch} is settled; ${r.maxAttempts - r.attempts.length} attempts remain before ${r.deadline}. Run validation retry to queue another attempt.`;
      } else { condition = 'settled'; nextStep = 'Terminal and settled; nothing is reserved.'; }
      diagnoses.push({ requestId: r.id, workId: r.workId, proof: r.proof, state: r.state, runner: r.runner, attempt, dwellSeconds: seconds(r.createdAt), condition, nextStep });
    }
    const artifactRow = (await this.store.pool.query(`SELECT COALESCE(SUM(size) FILTER (WHERE state IN ('stored','pending')),0) AS used,
      count(*) FILTER (WHERE state='stored') AS retained, count(*) FILTER (WHERE state='pending') AS pending, count(*) FILTER (WHERE state='upload-failed') AS failed, count(*) FILTER (WHERE state='expired') AS expired,
      count(*) FILTER (WHERE state='stored' AND expires_at<=$1) AS expiring, count(*) FILTER (WHERE location IS NOT NULL AND deleted_at IS NULL AND (backend='postgres' OR state IN ('expired','upload-failed'))) AS awaiting FROM validation_artifacts`, [new Date(now.getTime() + 86_400_000)])).rows[0];
    const artifacts: ArtifactCapacity = { backend: this.artifactBackend?.label ?? 'postgres', capacityBytes: this.artifactCapacityBytes, usedBytes: Number(artifactRow.used), retained: Number(artifactRow.retained), pending: Number(artifactRow.pending), uploadFailed: Number(artifactRow.failed), expired: Number(artifactRow.expired), expiringWithin24h: Number(artifactRow.expiring), awaitingDeletion: Number(artifactRow.awaiting) };
    return { now: now.toISOString(), runners, resources, requests: diagnoses, artifacts };
  }
  private async reportReasons(db: pg.PoolClient, c: ValidationCandidate, data: Report) {
    const e = await this.definition(db, 'environment', c.environment) as Environment, b = await this.definition(db, 'bundle', c.bundle) as Bundle;
    const build = (await db.query('SELECT document AS attestation FROM validation_builds WHERE id=$1', [c.buildAttestationId])).rows[0].attestation as BuildAttestation;
    const reasons: string[] = [];
    if (data.execution !== 'completed' || data.behavior !== 'passed') reasons.push('Execution and behavior must both pass');
    if (!data.inventoryComplete || data.executed < 1 || data.skipped !== 0) reasons.push('Required inventory is missing, empty or skipped');
    if (data.target.attribution !== 'matched' || data.target.measurement === 'unknown' || !data.target.coversEntireRun || data.target.instance !== e.instance || !same([...data.target.artifacts].sort((a,b) => a.service.localeCompare(b.service)), [...build.artifacts].sort((a,b) => a.service.localeCompare(b.service)))) reasons.push('Independent whole-run target attribution is missing or mismatched');
    if (data.bundleDigest !== b.digest || data.runnerImageDigest !== b.runnerImageDigest) reasons.push('Executed oracle bundle or runner image differs from approval');
    if (data.artifactState !== 'verified' || new Set(data.artifacts.map(a => a.name)).size !== data.artifacts.length || c.requiredArtifacts.some(n => !data.artifacts.some(a => a.name === n))) reasons.push('Required execution artifacts are missing or ambiguous');
    // Private Graphyard routes exist only for Postgres-backed storage; external storage
    // must cite safe public locations, and Postgres binding is enforced by row matching.
    if (c.artifactStorage === 'external' && data.artifacts.some(a => !safeHttpUrl(a.url))) reasons.push('External-storage artifacts must reference safe HTTP(S) locations; private Graphyard artifact routes require Postgres storage');
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
        demand(a && !['dispatched', 'running', 'collecting'].includes(r.state) && data.settlementEvidence, 'Terminate/cancel first and provide independent settlement evidence');
        a.settled = true; await db.query('DELETE FROM validation_resources WHERE request_id=$1', [r.id]);
      } else if (command === 'retry') {
        demand(a && a.settled && ['expired', 'completed', 'cancelled'].includes(r.state) && r.attempts.length < r.maxAttempts && Date.parse(r.deadline) > now.getTime(), 'Retry needs settled prior execution, time and attempt budget');
        const c = await this.candidate(db, r.candidateId), w = await this.work(db, r.workId, now); await this.valid(db, c, w);
        demand(w.validation?.[r.proof]?.requestId === r.id, 'Newer request supersedes retry');
        await this.registration(db, r.runner, 'runner'); await this.registration(db, r.collector, 'collector');
        r.state = 'queued'; delete r.result;
      } else {
        demand(['queued', 'dispatched', 'running', 'collecting'].includes(r.state), 'Request is already terminal');
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
    if (!a || !['dispatched', 'running', 'collecting'].includes(r.state)) return;
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
      SELECT document FROM validation_requests WHERE document->>'state' IN ('queued','dispatched','running','collecting')
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
      } else if (r.state !== 'completed' && (Date.parse(r.deadline) <= now.getTime() || a && ['dispatched', 'running', 'collecting'].includes(r.state) && Date.parse(a.expiresAt) <= now.getTime())) {
        // Unacknowledged runners are prohibited from starting. Their expired ACK
        // cannot succeed; no execution was authorized, so those slots are reusable.
        await this.endActiveAttempt(db, r, 'expired', now); r.state = 'expired';
      } else continue;
      await this.persist(db, r); await this.event(db, 'graphyard', r.state, { request: r }, r.workId); await this.invalidateBinding(db, r, now, 'graphyard');
    }
  }
  async reconcile(includeCompleted = false) { await this.store.transaction((db, now) => this.reconcileWithin(db, now, includeCompleted)); }
}
