import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type pg from 'pg';
import { admin, demand, type Principal, type ReleaseDelivery, type Work } from './model.js';
import { save } from './store.js';
import { deliveryPolicy, type Environment, type Registration, type RollbackFencing, type Validation } from './validation.js';

const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/).max(150);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const revision = z.number().int().positive();
const generation = z.number().int().min(0);
const ref = z.object({ id: name, revision }).strict();
const manifestSchema = z.array(z.object({ service: name, digest }).strict()).min(1).max(30).refine(a => new Set(a.map(x => x.service)).size === a.length, 'Services must be unique');
/** A promoter acts through its registration and the lease epoch it currently holds. */
const delegateSchema = z.object({ registration: ref, epoch: revision }).strict();
export const buildSchema = z.object({ registration: ref, sourceSha: sha, buildInputsDigest: digest, artifacts: manifestSchema, provenanceUrl: z.url().max(2000) }).strict();
export type ReleaseBuild = z.infer<typeof buildSchema> & { id: string; producer: string; at: string; repository: string; environment: { id: string; revision: number } };
const memberSchema = z.object({ workId: z.uuid(), mergeSha: sha, included: z.boolean(), note: z.string().trim().min(1).max(500).optional() }).strict();
export const releaseSchema = z.object({ id: name, expectedRevision: generation, environment: ref, sourceSha: sha, buildId: z.uuid(), manifest: manifestSchema,
  members: z.array(memberSchema).max(100).refine(m => new Set(m.map(x => x.workId)).size === m.length, 'Members must be unique'), delegate: delegateSchema.optional() }).strict();
export type ReleaseMember = z.infer<typeof memberSchema> & { key: string };
export type Release = Omit<z.infer<typeof releaseSchema>, 'expectedRevision' | 'delegate' | 'members'> & { revision: number; manifestHash: string; members: ReleaseMember[]; createdAt: string; createdBy: string };
export const approvalSchema = z.object({ release: ref, environment: ref }).strict();
export type ReleaseApproval = { id: string; releaseId: string; releaseRevision: number; environment: { id: string; revision: number }; manifestHash: string; buildId: string; policyRevision: number; approvedBy: string; at: string };
export const selectSchema = z.object({ environment: ref, release: ref, expectedGeneration: generation, approvalId: z.uuid().optional(), delegate: delegateSchema.optional() }).strict();
export const leaseSchema = z.object({ registration: ref, epoch: revision.optional() }).strict();
export const measurements = ['provider', 'host-attestation', 'self-report', 'unknown'] as const;
const instanceSchema = z.object({ instance: name, digest: digest.nullable(), measurement: z.enum(measurements), healthy: z.boolean() }).strict();
const serviceSnapshotSchema = z.object({ service: name, complete: z.boolean(), instances: z.array(instanceSchema).max(100).refine(i => new Set(i.map(x => x.instance)).size === i.length, 'Instances must be unique'),
  deployment: z.object({ id: z.string().min(1).max(200), status: z.enum(['success', 'failed', 'building', 'unknown']), deployedAt: z.iso.datetime().nullable() }).strict().optional() }).strict();
export const observationSchema = z.object({ registration: ref, epoch: revision, environment: ref, expectedGeneration: generation, snapshotId: z.string().min(1).max(200),
  observedAt: z.iso.datetime(), validFrom: z.iso.datetime(), validTo: z.iso.datetime(),
  services: z.array(serviceSnapshotSchema).min(1).max(30).refine(s => new Set(s.map(x => x.service)).size === s.length, 'Services must be unique') }).strict()
  .refine(o => Date.parse(o.validFrom) <= Date.parse(o.observedAt) && Date.parse(o.observedAt) <= Date.parse(o.validTo), 'observedAt must lie within [validFrom, validTo]');
type ObservationInput = z.infer<typeof observationSchema>;
export type ServiceState = 'matched' | 'mismatched' | 'unknown' | 'unhealthy' | 'incomplete';
export type DeploymentObservation = ObservationInput & { id: string; observer: string; generation: number; authoritative: boolean; rejection: string[]; receivedAt: string; states: Record<string, ServiceState> };
const notificationSchema = z.object({ environment: name, provider: z.string().trim().min(1).max(60), payload: z.unknown().optional() }).strict();
export type VerificationStatus = 'unselected' | 'unobserved' | 'incomplete' | 'unknown' | 'mismatched' | 'unhealthy' | 'no-common-interval' | 'stale' | 'verified' | 'degraded';
export interface Interval { from: string; to: string }
export interface ReleaseSelection { generation: number; releaseId: string; releaseRevision: number; policyRevision: number; selectedAt: string; selectedBy: string; outcome: 'selected' | 'verified' | 'skipped'; verifiedAt?: string; interval?: Interval; supersededAt?: string }
export interface Incident { id: string; generation: number; releaseId: string; releaseRevision: number; at: string; observationId: string; reasons: string[] }
/**
 * D4 rollback. A rollback is a selection of a previously verified release plus one external
 * operation with a durable identity. It is requested, claimed by a registered executor,
 * settled with the executor's outcome, and complete only once the target is observed running
 * and the environment verifies — `applied` is the provider's word, `verified` is Graphyard's.
 */
export type RollbackState = 'requested' | 'in-flight' | 'applied' | 'failed' | 'unknown' | 'verified' | 'cancelled' | 'superseded';
export interface RollbackReport { at: string; actor: string; outcome: 'applied' | 'failed' | 'unknown'; providerOperationId: string | null; detail: string | null; authoritative: boolean; reasons: string[] }
export interface RollbackOperation {
  id: string; registration: { id: string; revision: number }; principal: string; epoch: number; fencing: RollbackFencing; claimedAt: string;
  /** What the provider write must be conditioned on: the manifest that should still be running, and the generation this operation acts for. */
  precondition: { environment: string; generation: number; expectedRunning: string; token: string };
  outcome: 'applied' | 'failed' | 'unknown' | 'cancelled' | null; settledAt: string | null; providerOperationId: string | null; detail: string | null;
  resolvedBy: string | null; evidence: string | null; reports: RollbackReport[];
}
export interface RollbackRequest {
  id: string; environmentId: string; environmentRevision: number; generation: number;
  failed: { releaseId: string; releaseRevision: number; generation: number; manifestHash: string; incidentIds: string[] };
  target: { releaseId: string; releaseRevision: number; manifestHash: string; approvalId: string | null; verifiedAt: string };
  reason: string; automatic: boolean; requestedBy: string; requestedAt: string; repairWorkId: string | null;
  state: RollbackState; operation: RollbackOperation | null; verifiedAt: string | null; interval: Interval | null;
  history: { at: string; state: RollbackState; actor: string; note: string }[];
}
export const rollbackSchema = z.object({ environment: ref, target: ref, expectedGeneration: generation, reason: z.string().trim().min(1).max(2000), repairWorkId: z.uuid().optional(), delegate: delegateSchema.optional() }).strict();
export const rollbackClaimSchema = z.object({ rollbackId: z.uuid(), registration: ref, epoch: revision }).strict();
export const rollbackSettleSchema = z.object({ rollbackId: z.uuid(), operationId: z.uuid(), registration: ref, epoch: revision, outcome: z.enum(['applied', 'failed', 'unknown']), providerOperationId: z.string().trim().min(1).max(200).optional(), detail: z.string().trim().max(2000).optional() }).strict();
export const rollbackResolveSchema = z.object({ rollbackId: z.uuid(), operationId: z.uuid().optional(), outcome: z.enum(['applied', 'failed', 'cancelled']), reason: z.string().trim().min(1).max(2000), evidence: z.url().max(2000).optional() }).strict();
export interface EnvironmentDelivery {
  environmentId: string; generation: number;
  expected: { releaseId: string; releaseRevision: number; manifestHash: string; buildId: string; policyRevision: number; approvalId: string | null; selectedAt: string; selectedBy: string } | null;
  history: ReleaseSelection[];
  /** Folded from the current generation's authoritative observations only. `segments` is matched history; `latest` is the most recently observed state. */
  coverage: Record<string, { segments: Interval[]; latest: { observationId: string; observedAt: string; validTo: string; state: ServiceState; reasons: string[] } | null }>;
  verification: { generation: number; status: VerificationStatus; reasons: string[]; interval: Interval | null; evaluatedAt: string | null; verifiedAt: string | null };
  incidents: Incident[];
  /** The last observation sequence applied. Sweeps resume from here. */
  cursor: number;
  lastNotification?: { at: string; provider: string; payloadHash: string };
  /** Why the sweep last declined to roll back automatically, so the refusal is visible without an event per tick. */
  automaticRollbackRefusal?: { at: string; generation: number; reasons: string[] };
}
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const same = isDeepStrictEqual;
// Canonical: jsonb reorders object keys, so hash ordered tuples rather than stored objects.
const manifestHash = (manifest: { service: string; digest: string }[]) => hash([...manifest].sort((a, b) => a.service.localeCompare(b.service)).map(a => [a.service, a.digest]));
export const historyLimit = 100, incidentLimit = 100, segmentLimit = 200, leaseMs = 60_000;

/** Union of intervals: merge every pair that overlaps or touches, keep the newest when bounded. */
const ms = Date.parse;
export function mergeSegments(segments: Interval[], limit = segmentLimit): Interval[] {
  const sorted = [...segments].sort((a, b) => ms(a.from) - ms(b.from) || ms(a.to) - ms(b.to));
  const merged: Interval[] = [];
  for (const segment of sorted) {
    const last = merged.at(-1);
    if (last && ms(segment.from) <= ms(last.to)) { if (ms(segment.to) > ms(last.to)) last.to = segment.to; } else merged.push({ ...segment });
  }
  return merged.slice(-limit);
}
/** Intersection of two unions; both inputs are merged and sorted. */
function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of a) for (const y of b) {
    const from = ms(x.from) > ms(y.from) ? x.from : y.from, to = ms(x.to) < ms(y.to) ? x.to : y.to;
    if (ms(from) <= ms(to)) out.push({ from, to });
  }
  return mergeSegments(out, Infinity);
}
/** The latest instant range during which every listed coverage was matching at once. */
export function commonInterval(coverages: Interval[][]): Interval | null {
  if (!coverages.length) return null;
  let common = mergeSegments(coverages[0], Infinity);
  for (const coverage of coverages.slice(1)) common = intersect(common, coverage);
  return common.at(-1) ?? null;
}
/** How one service snapshot compares with the expected digest. Only measured identity can mismatch; a self-report is unknown even when it agrees. */
export function serviceState(snapshot: z.infer<typeof serviceSnapshotSchema>, expected: string): { state: ServiceState; reasons: string[] } {
  const reasons: string[] = [];
  if (!snapshot.complete) reasons.push(`Instance listing for ${snapshot.service} is incomplete`);
  if (!snapshot.instances.length) reasons.push(`No running instance observed for ${snapshot.service}`);
  if (snapshot.deployment?.status === 'building') reasons.push(`Deployment ${snapshot.deployment.id} of ${snapshot.service} is still building`);
  if (reasons.length) return { state: 'incomplete', reasons };
  if (snapshot.deployment?.status === 'failed') reasons.push(`Deployment ${snapshot.deployment.id} of ${snapshot.service} failed`);
  for (const instance of snapshot.instances.filter(i => !i.healthy)) reasons.push(`Instance ${instance.instance} of ${snapshot.service} is unhealthy`);
  if (reasons.length) return { state: 'unhealthy', reasons };
  const measured = (i: z.infer<typeof instanceSchema>) => (i.measurement === 'provider' || i.measurement === 'host-attestation') && !!i.digest;
  for (const instance of snapshot.instances.filter(i => measured(i) && i.digest !== expected)) reasons.push(`Instance ${instance.instance} of ${snapshot.service} runs ${instance.digest} instead of ${expected}`);
  if (reasons.length) return { state: 'mismatched', reasons };
  for (const instance of snapshot.instances.filter(i => !measured(i))) reasons.push(`Runtime identity of instance ${instance.instance} of ${snapshot.service} is ${instance.measurement === 'self-report' ? 'only self-reported' : 'unknown'}${instance.measurement === 'self-report' && instance.digest === expected ? ' (the claimed digest matches, which proves nothing)' : ''}`);
  if (reasons.length) return { state: 'unknown', reasons };
  return { state: 'matched', reasons: [] };
}

/** Apply one authoritative observation of the current generation to the environment's coverage. */
export function fold(state: EnvironmentDelivery, observation: DeploymentObservation, manifest: Record<string, string>) {
  if (!observation.authoritative || observation.generation !== state.generation) return;
  for (const snapshot of observation.services) {
    if (!manifest[snapshot.service]) continue;
    const result = state.coverage[snapshot.service] ??= { segments: [], latest: null };
    const { state: serviceStatus, reasons } = serviceState(snapshot, manifest[snapshot.service]);
    if (serviceStatus === 'matched') result.segments = mergeSegments([...result.segments, { from: observation.validFrom, to: observation.validTo }]);
    // Current health is what was observed most recently, by trusted observation time: a later failure whose validity
    // ends before an earlier long match still supersedes it. Matched segments above are history and stay untouched.
    if (!result.latest || ms(observation.observedAt) >= ms(result.latest.observedAt)) result.latest = { observationId: observation.id, observedAt: observation.observedAt, validTo: observation.validTo, state: serviceStatus, reasons };
  }
}

/**
 * Releases, expected-release selection and append-only deployment observations. Desired
 * state changes only through an authenticated promotion principal; runtime state changes
 * only through authenticated, service-scoped observers; and production verification is
 * derived by bounded sweeps over what those observers actually reported. No provider I/O
 * happens here: adapters read providers outside these transactions and every result is
 * fenced again — registration generation, lease epoch, selection generation — when applied.
 */
export class Delivery {
  constructor(readonly validation: Validation) {}
  get store() { return this.validation.store; }
  get engine() { return this.validation.engine; }
  get repository() { return this.validation.repository; }
  private async event(db: pg.PoolClient, actor: string, kind: string, payload: unknown, workId?: string) { await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [workId ?? null, actor, `delivery.${kind}`, JSON.stringify(payload)]); }
  private async withReceipt<T>(actor: Principal, command: string, data: unknown, key: string, fn: (db: pg.PoolClient, now: Date) => Promise<T>): Promise<T> {
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const fingerprint = hash({ command: `delivery.${command}`, data });
    return this.store.transaction(async (db, now) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) { demand(receipt.fingerprint === fingerprint, 'Idempotency key reused with different input'); return receipt.result as T; }
      const result = await fn(db, now);
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]); return result;
    });
  }
  private async environment(db: pg.PoolClient, selected: { id: string; revision: number }, current = true) {
    const environment = await this.validation.definition(db, 'environment', selected, current) as Environment;
    demand(environment.repository === this.repository, 'Environment repository scope differs', 403);
    return environment;
  }
  private async state(db: pg.PoolClient, environmentId: string): Promise<EnvironmentDelivery> {
    const found = (await db.query('SELECT document FROM delivery_environments WHERE environment_id=$1', [environmentId])).rows[0]?.document as EnvironmentDelivery | undefined;
    return found ?? { environmentId, generation: 0, expected: null, history: [], coverage: {}, verification: { generation: 0, status: 'unselected', reasons: ['No expected release is selected'], interval: null, evaluatedAt: null, verifiedAt: null }, incidents: [], cursor: 0 };
  }
  private async persist(db: pg.PoolClient, state: EnvironmentDelivery) {
    await db.query('INSERT INTO delivery_environments(environment_id,document) VALUES($1,$2) ON CONFLICT(environment_id) DO UPDATE SET document=EXCLUDED.document', [state.environmentId, JSON.stringify(state)]);
  }
  private async release(db: pg.PoolClient, selected: { id: string; revision: number }) {
    const release = (await db.query('SELECT document FROM releases WHERE id=$1 AND revision=$2', [selected.id, selected.revision])).rows[0]?.document as Release | undefined;
    demand(release, 'Release revision not found', 404); return release;
  }
  /**
   * Who may change desired state: the operator, or a promoter registration whose principal
   * is the caller, whose scope covers the whole environment, and whose lease epoch is current.
   * Observer registrations, workers and every other credential are refused here.
   */
  private async promoter(db: pg.PoolClient, actor: Principal, environment: Environment, delegate: z.infer<typeof delegateSchema> | undefined, now: Date) {
    if (actor.role === 'admin') { demand(!delegate, 'Operators act directly, not through a delegate lease'); return null; }
    demand(actor.role === 'producer' && !!delegate, 'A promotion principal with a promoter registration and lease is required', 403);
    const registration = await this.validation.registration(db, delegate!.registration, 'promoter');
    demand(registration.principalId === actor.id, 'Wrong promotion principal', 403);
    demand(registration.environment.id === environment.id && same([...registration.services!].sort(), [...environment.services].sort()), 'Promoter registration must cover the whole environment', 403);
    await this.assertLease(db, registration, actor, delegate!.epoch, now, 'Promoter lease epoch is expired or superseded; acquire the lease again');
    return { registration: delegate!.registration, epoch: delegate!.epoch };
  }
  private async assertLease(db: pg.PoolClient, registration: Registration, actor: Principal, epoch: number, now: Date, message: string) {
    const lease = (await db.query('SELECT principal,epoch,expires_at FROM delivery_leases WHERE registration_id=$1', [registration.id])).rows[0];
    demand(lease && lease.principal === actor.id && lease.epoch === epoch && lease.expires_at > now, message);
  }
  async lease(actor: Principal, input: unknown) {
    demand(actor.role === 'producer', 'A deployment identity credential is required', 403);
    const data = leaseSchema.parse(input);
    return this.store.transaction(async (db, now) => {
      const registration = await this.validation.definition(db, 'registration', data.registration) as Registration;
      demand(registration.enabled && ['observer', 'promoter', 'rollback'].includes(registration.role) && registration.principalId === actor.id, 'Registration is not an enabled deployment identity of this principal', 403);
      await this.environment(db, registration.environment);
      const current = (await db.query('SELECT principal,epoch,expires_at FROM delivery_leases WHERE registration_id=$1', [registration.id])).rows[0];
      // Renewal keeps the epoch; anything else — first acquisition, expiry, a stale renewal — is a new epoch that supersedes outstanding authority.
      const renew = !!current && current.principal === actor.id && data.epoch === current.epoch && current.expires_at > now;
      const epoch = renew ? current.epoch : (current?.epoch ?? 0) + 1;
      const expiresAt = new Date(now.getTime() + leaseMs);
      await db.query('INSERT INTO delivery_leases(registration_id,principal,epoch,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(registration_id) DO UPDATE SET principal=EXCLUDED.principal,epoch=EXCLUDED.epoch,expires_at=EXCLUDED.expires_at', [registration.id, actor.id, epoch, expiresAt]);
      if (!renew) await this.event(db, actor.id, 'lease', { registration: data.registration, epoch });
      return { registration: data.registration, epoch, expiresAt: expiresAt.toISOString(), renewed: renew };
    });
  }
  async attestBuild(actor: Principal, input: unknown, key: string) {
    demand(actor.role === 'producer', 'A separately authorized build producer is required', 403);
    const data = buildSchema.parse(input);
    return this.withReceipt(actor, 'build', data, key, async (db, now) => {
      const registration = await this.validation.registration(db, data.registration, 'builder'); demand(registration.principalId === actor.id, 'Wrong build principal', 403);
      const environment = await this.environment(db, registration.environment);
      demand(same([...environment.services].sort(), data.artifacts.map(a => a.service).sort()), 'Build must cover the complete service manifest');
      const build: ReleaseBuild = { ...data, id: randomUUID(), producer: actor.id, at: now.toISOString(), repository: environment.repository, environment: registration.environment };
      await db.query('INSERT INTO release_builds VALUES($1,$2)', [build.id, JSON.stringify(build)]);
      await this.event(db, actor.id, 'build', { build }); return build;
    });
  }
  /**
   * Membership is explicit and checked against independently observed delivery: each member
   * cites the merge SHA GitHub reported for delivered work. Ancestry is never inferred, and a
   * reverted change stays listed with `included: false` so the revert is visible.
   */
  async createRelease(actor: Principal, input: unknown, key: string) {
    const data = releaseSchema.parse(input);
    return this.withReceipt(actor, 'release', data, key, async (db, now) => {
      const environment = await this.environment(db, data.environment);
      await this.promoter(db, actor, environment, data.delegate, now);
      const latest = (await db.query('SELECT revision FROM releases WHERE id=$1 ORDER BY revision DESC LIMIT 1', [data.id])).rows[0]?.revision ?? 0;
      demand(latest === data.expectedRevision, 'Release revision changed; read the latest revision');
      const build = (await db.query('SELECT document FROM release_builds WHERE id=$1', [data.buildId])).rows[0]?.document as ReleaseBuild | undefined;
      demand(build && build.repository === this.repository && build.environment.id === environment.id && build.sourceSha === data.sourceSha, 'Missing or mismatched trusted build provenance for this source and environment');
      await this.validation.registration(db, build.registration, 'builder');
      demand(manifestHash(build.artifacts) === manifestHash(data.manifest), 'Manifest differs from the attested build artifacts');
      demand(same([...environment.services].sort(), data.manifest.map(a => a.service).sort()), 'Manifest must cover exactly the environment services');
      const members: ReleaseMember[] = [];
      for (const member of data.members) {
        const work = (await db.query('SELECT document FROM work_items WHERE id=$1', [member.workId])).rows[0]?.document as Work | undefined;
        demand(work && work.stage === 'done' && work.delivery?.mergeSha === member.mergeSha, `Member ${member.workId} must be delivered work whose independently observed merge is ${member.mergeSha}`);
        members.push({ ...member, key: work.key });
      }
      const { expectedRevision: _expected, delegate: _delegate, members: _members, ...definition } = data;
      const release: Release = { ...definition, revision: latest + 1, manifestHash: manifestHash(data.manifest), members, createdAt: now.toISOString(), createdBy: actor.id };
      await db.query('INSERT INTO releases(id,revision,document) VALUES($1,$2,$3)', [release.id, release.revision, JSON.stringify(release)]);
      await this.event(db, actor.id, 'release', { release });
      for (const member of members) await this.event(db, actor.id, 'release-member', { releaseId: release.id, releaseRevision: release.revision, environment: release.environment, included: member.included, mergeSha: member.mergeSha }, member.workId);
      return release;
    });
  }
  /** An approval binds the exact manifest, provenance and policy revision; any change needs a new one. */
  async approve(actor: Principal, input: unknown, key: string) {
    admin(actor); const data = approvalSchema.parse(input);
    return this.withReceipt(actor, 'approve', data, key, async (db, now) => {
      const environment = await this.environment(db, data.environment);
      const release = await this.release(db, data.release);
      demand(release.environment.id === environment.id, 'Release belongs to a different environment');
      const approval: ReleaseApproval = { id: randomUUID(), releaseId: release.id, releaseRevision: release.revision, environment: data.environment, manifestHash: release.manifestHash, buildId: release.buildId, policyRevision: environment.revision, approvedBy: actor.id, at: now.toISOString() };
      await db.query('INSERT INTO release_approvals VALUES($1,$2)', [approval.id, JSON.stringify(approval)]);
      await this.event(db, actor.id, 'approved', { approval }); return approval;
    });
  }
  /**
   * Selecting the expected release advances the environment's generation. The expected
   * generation fences concurrent promotions; the environment revision is the policy revision
   * the selection pins; and where the policy requires approval, the approval must bind this
   * exact release revision, manifest, provenance and policy revision.
   */
  async select(actor: Principal, input: unknown, key: string) {
    const data = selectSchema.parse(input);
    return this.withReceipt(actor, 'select', data, key, async (db, now) => {
      const environment = await this.environment(db, data.environment);
      await this.promoter(db, actor, environment, data.delegate, now);
      const state = await this.state(db, environment.id);
      demand(state.generation === data.expectedGeneration, 'Release generation changed; read the current selection');
      const release = await this.release(db, data.release);
      const approval = await this.approvalFor(db, environment, release, data.approvalId);
      await this.applySelection(db, state, environment, release, approval, actor.id, now, 'Selected as the expected release');
      await this.event(db, actor.id, 'selected', { environment: environment.id, generation: state.generation, release: data.release, approvalId: approval?.id ?? null, delegate: data.delegate ?? null });
      return state;
    });
  }
  /** The approval a selection needs: one that binds this exact release revision, manifest, build and policy revision, when the policy asks for one. */
  private async approvalFor(db: pg.PoolClient, environment: Environment, release: Release, approvalId?: string) {
    demand(release.environment.id === environment.id && release.environment.revision === environment.revision, 'Release was defined for a different environment or policy revision');
    const policy = deliveryPolicy(environment);
    if (!policy.approvalRequired && !approvalId) return null;
    demand(approvalId, 'This environment requires an operator approval of the release');
    const approval = (await db.query('SELECT document FROM release_approvals WHERE id=$1', [approvalId])).rows[0]?.document as ReleaseApproval | undefined ?? null;
    demand(approval && this.approvalBinds(approval, environment, release), 'Approval does not bind this exact release revision, manifest, provenance and policy revision');
    return approval;
  }
  private approvalBinds(approval: ReleaseApproval, environment: Environment, release: Release) {
    return approval.releaseId === release.id && approval.releaseRevision === release.revision && approval.manifestHash === release.manifestHash && approval.buildId === release.buildId && approval.environment.id === environment.id && approval.policyRevision === environment.revision;
  }
  /**
   * Advance the generation to a new expected release. Refused while a serialized rollback
   * operation is unresolved: without a provider-side fence, only a settled or cancelled
   * operation makes it safe to authorize a successor mutation or supersede its target.
   */
  private async applySelection(db: pg.PoolClient, state: EnvironmentDelivery, environment: Environment, release: Release, approval: ReleaseApproval | null, actor: string, now: Date, note: string) {
    await this.assertNoSerializedOperation(db, environment.id);
    const at = now.toISOString();
    for (const previous of state.history.filter(h => h.generation === state.generation && !h.supersededAt)) {
      previous.supersededAt = at;
      // Superseded is not unhealthy: a release that was never verified is skipped, one that was keeps its verification.
      if (previous.outcome === 'selected') previous.outcome = 'skipped';
    }
    // Rollbacks of the superseded generation that never completed lose their target; the
    // operation records stay, so a late outcome from a partitioned executor is history only.
    for (const rollback of await this.rollbacks(db, environment.id, state.generation)) {
      if (['requested', 'in-flight', 'unknown', 'applied'].includes(rollback.state)) {
        await this.transition(db, rollback, 'superseded', actor, `Generation ${state.generation} superseded by a newer selection`, now);
      }
    }
    state.generation += 1;
    state.expected = { releaseId: release.id, releaseRevision: release.revision, manifestHash: release.manifestHash, buildId: release.buildId, policyRevision: environment.revision, approvalId: approval?.id ?? null, selectedAt: at, selectedBy: actor };
    state.history.push({ generation: state.generation, releaseId: release.id, releaseRevision: release.revision, policyRevision: environment.revision, selectedAt: at, selectedBy: actor, outcome: 'selected' });
    if (state.history.length > historyLimit) state.history.splice(0, state.history.length - historyLimit);
    state.coverage = {};
    state.verification = { generation: state.generation, status: 'unobserved', reasons: [`No authoritative observation for generation ${state.generation} yet`, note], interval: null, evaluatedAt: at, verifiedAt: null };
    delete state.automaticRollbackRefusal;
    await this.persist(db, state);
  }
  private async rollbacks(db: pg.PoolClient, environmentId: string, generation?: number): Promise<RollbackRequest[]> {
    return (await db.query('SELECT document FROM delivery_rollbacks WHERE environment_id=$1 AND ($2::int IS NULL OR generation=$2) ORDER BY created_at,id', [environmentId, generation ?? null])).rows.map(r => r.document);
  }
  private async rollback(db: pg.PoolClient, id: string): Promise<RollbackRequest> {
    const found = (await db.query('SELECT document FROM delivery_rollbacks WHERE id=$1', [id])).rows[0]?.document as RollbackRequest | undefined;
    demand(found, 'Rollback not found', 404); return found!;
  }
  private async persistRollback(db: pg.PoolClient, rollback: RollbackRequest) {
    await db.query('INSERT INTO delivery_rollbacks(id,environment_id,generation,document) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET document=EXCLUDED.document', [rollback.id, rollback.environmentId, rollback.generation, JSON.stringify(rollback)]);
  }
  private async transition(db: pg.PoolClient, rollback: RollbackRequest, state: RollbackState, actor: string, note: string, now: Date) {
    rollback.state = state; rollback.history.push({ at: now.toISOString(), state, actor, note });
    await this.persistRollback(db, rollback);
    await this.event(db, actor, `rollback-${state}`, { rollbackId: rollback.id, environment: rollback.environmentId, generation: rollback.generation, operationId: rollback.operation?.id ?? null, note });
  }
  /**
   * The serialized in-flight barrier: an operation whose provider cannot fence writes blocks
   * every successor until it is proven settled or cancelled. An unknown outcome blocks
   * whatever the fencing — nobody knows what the provider did, so nothing may build on it.
   */
  private async assertNoSerializedOperation(db: pg.PoolClient, environmentId: string) {
    for (const rollback of await this.rollbacks(db, environmentId)) {
      if (!['in-flight', 'unknown'].includes(rollback.state) || rollback.state === 'in-flight' && rollback.operation?.fencing === 'provider') continue;
      demand(false, `Rollback ${rollback.id} has an unresolved ${rollback.operation?.fencing ?? 'serialized'} operation ${rollback.operation?.id} (${rollback.state}); no successor mutation or selection is authorized until it is settled by its executor or resolved by an operator with evidence`, 409);
    }
  }
  /**
   * Request a rollback: select a previously verified release of this environment as the
   * expected one and open the operation record an executor will claim. The target is an
   * approved, tested reversible action — a release revision that verified here before, with
   * an approval that still binds it where the policy requires one. A rollback never claims
   * that migrations or external side effects are undone; the record links the repair work.
   */
  async requestRollback(actor: Principal, input: unknown, key: string) {
    const data = rollbackSchema.parse(input);
    return this.withReceipt(actor, 'rollback', data, key, async (db, now) => {
      const environment = await this.environment(db, data.environment);
      await this.promoter(db, actor, environment, data.delegate, now);
      const state = await this.state(db, environment.id);
      demand(state.generation === data.expectedGeneration, 'Release generation changed; read the current selection');
      demand(state.expected, 'No expected release is selected; there is nothing to roll back from');
      const target = await this.release(db, data.target);
      demand(target.environment.id === environment.id && target.environment.revision === environment.revision, 'Rollback target was defined for a different environment or policy revision');
      const verified = state.history.filter(h => h.releaseId === target.id && h.releaseRevision === target.revision && h.outcome === 'verified').at(-1);
      demand(verified, 'A rollback target must be a release revision that was verified in this environment before', 409);
      demand(!(state.expected!.releaseId === target.id && state.expected!.releaseRevision === target.revision), 'The target is already the expected release');
      const approval = await this.approvalForTarget(db, environment, target);
      if (data.repairWorkId) demand((await db.query('SELECT 1 FROM work_items WHERE id=$1', [data.repairWorkId])).rowCount, 'Repair work item not found', 404);
      return this.openRollback(db, state, environment, target, approval, verified!.verifiedAt!, actor.id, data.reason, false, data.repairWorkId ?? null, now);
    });
  }
  private async approvalForTarget(db: pg.PoolClient, environment: Environment, target: Release) {
    if (!deliveryPolicy(environment).approvalRequired) return null;
    const approvals: ReleaseApproval[] = (await db.query("SELECT document FROM release_approvals WHERE document->>'releaseId'=$1 ORDER BY document->>'at' DESC", [target.id])).rows.map(r => r.document);
    const approval = approvals.find(a => this.approvalBinds(a, environment, target));
    demand(approval, 'The rollback target has no approval binding the current policy revision; approve it again first', 409);
    return approval!;
  }
  private async openRollback(db: pg.PoolClient, state: EnvironmentDelivery, environment: Environment, target: Release, approval: ReleaseApproval | null, verifiedAt: string, actor: string, reason: string, automatic: boolean, repairWorkId: string | null, now: Date) {
    const failed = { releaseId: state.expected!.releaseId, releaseRevision: state.expected!.releaseRevision, generation: state.generation, manifestHash: state.expected!.manifestHash, incidentIds: state.incidents.filter(i => i.generation === state.generation).map(i => i.id) };
    await this.applySelection(db, state, environment, target, approval, actor, now, `Rollback to ${target.id} r${target.revision} requested; awaiting an executor and then observation of the target`);
    const at = now.toISOString();
    const rollback: RollbackRequest = { id: randomUUID(), environmentId: environment.id, environmentRevision: environment.revision, generation: state.generation, failed,
      target: { releaseId: target.id, releaseRevision: target.revision, manifestHash: target.manifestHash, approvalId: approval?.id ?? null, verifiedAt }, reason, automatic, requestedBy: actor, requestedAt: at, repairWorkId,
      state: 'requested', operation: null, verifiedAt: null, interval: null, history: [{ at, state: 'requested', actor, note: reason }] };
    await this.persistRollback(db, rollback);
    await this.event(db, actor, 'rollback-requested', { rollbackId: rollback.id, environment: environment.id, generation: rollback.generation, failed, target: rollback.target, automatic, repairWorkId }, repairWorkId ?? undefined);
    return rollback;
  }
  /** The executor registration the caller acts through: enabled, current, the caller's own, covering the whole environment, with a live lease. */
  private async executor(db: pg.PoolClient, actor: Principal, selected: { id: string; revision: number }, environmentId: string, epoch: number, now: Date) {
    demand(actor.role === 'producer', 'A rollback executor credential is required', 403);
    const registration = await this.validation.registration(db, selected, 'rollback');
    demand(registration.principalId === actor.id, 'Wrong rollback executor principal', 403);
    const environment = await this.environment(db, registration.environment);
    demand(environment.id === environmentId && same([...registration.services!].sort(), [...environment.services].sort()), 'Rollback executor must be registered for the whole environment', 403);
    await this.assertLease(db, registration, actor, epoch, now, 'Executor lease epoch is expired or superseded; acquire the lease again');
    return registration;
  }
  /**
   * Claim the operation. One executor holds it; a retry from the same executor — after a
   * restart, with a fresh idempotency key — gets the same operation identity back rather than
   * a second one, so the provider sees one operation however many times the claim is sent.
   */
  async claimRollback(actor: Principal, input: unknown, key: string) {
    const data = rollbackClaimSchema.parse(input);
    return this.withReceipt(actor, 'rollback-claim', data, key, async (db, now) => {
      const rollback = await this.rollback(db, data.rollbackId);
      const registration = await this.executor(db, actor, data.registration, rollback.environmentId, data.epoch, now);
      const target = await this.release(db, { id: rollback.target.releaseId, revision: rollback.target.releaseRevision });
      const grant = (operation: RollbackOperation) => ({ rollback, operation, target: { release: { id: target.id, revision: target.revision }, sourceSha: target.sourceSha, manifest: target.manifest } });
      if (rollback.state === 'in-flight' && rollback.operation?.principal === actor.id && rollback.operation.registration.id === data.registration.id) return grant(rollback.operation);
      const state = await this.state(db, rollback.environmentId);
      demand(state.generation === rollback.generation && rollback.state !== 'superseded', 'Rollback target was superseded by a newer selection; nothing may apply it', 409);
      demand(rollback.state === 'requested', `Rollback is ${rollback.state}${rollback.operation ? ` under operation ${rollback.operation.id} held by ${rollback.operation.principal}` : ''}`, 409);
      demand(!rollback.automatic || registration.rollback!.automatic && registration.rollback!.fencing !== 'none', 'An automatic rollback may only be executed by a fenced adapter registered for automatic rollback', 403);
      for (const other of await this.rollbacks(db, rollback.environmentId)) demand(other.id === rollback.id || !['in-flight', 'unknown'].includes(other.state), `Rollback ${other.id} has an unresolved operation ${other.operation?.id} (${other.state}); one operation at a time per environment`, 409);
      const id = randomUUID();
      const operation: RollbackOperation = { id, registration: data.registration, principal: actor.id, epoch: data.epoch, fencing: registration.rollback!.fencing, claimedAt: now.toISOString(),
        precondition: { environment: rollback.environmentId, generation: rollback.generation, expectedRunning: rollback.failed.manifestHash, token: hash([rollback.environmentId, rollback.generation, id]) },
        outcome: null, settledAt: null, providerOperationId: null, detail: null, resolvedBy: null, evidence: null, reports: [] };
      rollback.operation = operation;
      await this.transition(db, rollback, 'in-flight', actor.id, `Claimed by ${data.registration.id} with ${operation.fencing} fencing`, now);
      return grant(operation);
    });
  }
  /**
   * The executor's outcome. It is accepted only for the operation that was claimed, from the
   * executor that claimed it, under a lease that is current now: a partitioned executor
   * re-acquires its lease and reports against the same operation identity. A report for a
   * superseded target is kept as non-authoritative history — the provider fence is what
   * stopped the write, and Graphyard records what the executor says happened either way.
   */
  async settleRollback(actor: Principal, input: unknown, key: string) {
    const data = rollbackSettleSchema.parse(input);
    return this.withReceipt(actor, 'rollback-settle', data, key, async (db, now) => {
      const rollback = await this.rollback(db, data.rollbackId), operation = rollback.operation;
      demand(operation && operation.id === data.operationId, 'Operation identity differs from the claimed operation', 403);
      demand(operation!.principal === actor.id && operation!.registration.id === data.registration.id, 'Wrong rollback executor for this operation', 403);
      await this.executor(db, actor, data.registration, rollback.environmentId, data.epoch, now);
      const state = await this.state(db, rollback.environmentId);
      const reasons: string[] = [];
      if (rollback.state === 'superseded' || state.generation !== rollback.generation) reasons.push('Rollback target was superseded by a newer selection; the outcome is recorded but authorizes nothing');
      else if (!['in-flight', 'unknown'].includes(rollback.state)) reasons.push(`Rollback is already ${rollback.state}; the report is recorded as history only`);
      const report: RollbackReport = { at: now.toISOString(), actor: actor.id, outcome: data.outcome, providerOperationId: data.providerOperationId ?? null, detail: data.detail ?? null, authoritative: !reasons.length, reasons };
      operation!.reports.push(report);
      if (report.authoritative) {
        Object.assign(operation!, { outcome: data.outcome, settledAt: report.at, providerOperationId: report.providerOperationId, detail: report.detail });
        await this.transition(db, rollback, data.outcome, actor.id, data.outcome === 'applied' ? 'Provider reports the target applied; awaiting observation of the target' : data.outcome === 'failed' ? 'Provider operation failed; the barrier is released' : 'Outcome unknown; further mutations are blocked pending reconciliation', now);
      } else { await this.persistRollback(db, rollback); await this.event(db, actor.id, 'rollback-report-rejected', { rollbackId: rollback.id, operationId: operation!.id, report }); }
      return { accepted: report.authoritative, state: rollback.state, reasons };
    });
  }
  /** Operator resolution of an operation whose executor is gone or whose outcome is ambiguous; settlement evidence is required to declare an outcome. */
  async resolveRollback(actor: Principal, input: unknown, key: string) {
    admin(actor); const data = rollbackResolveSchema.parse(input);
    return this.withReceipt(actor, 'rollback-resolve', data, key, async (db, now) => {
      const rollback = await this.rollback(db, data.rollbackId);
      if (rollback.state === 'requested') {
        demand(data.outcome === 'cancelled', 'An unclaimed rollback can only be cancelled', 409);
        await this.transition(db, rollback, 'cancelled', actor.id, data.reason, now); return rollback;
      }
      demand(['in-flight', 'unknown'].includes(rollback.state), `Rollback is ${rollback.state}; only an in-flight or unknown operation can be resolved`, 409);
      demand(rollback.operation && (!data.operationId || rollback.operation.id === data.operationId), 'Operation identity differs', 409);
      demand(data.evidence, 'Resolving an operation requires settlement evidence: a URL to the independent provider record that proves its outcome', 400);
      Object.assign(rollback.operation!, { outcome: data.outcome, settledAt: now.toISOString(), resolvedBy: actor.id, evidence: data.evidence, detail: data.reason });
      await this.transition(db, rollback, data.outcome, actor.id, `Resolved by operator with evidence ${data.evidence}: ${data.reason}`, now);
      return rollback;
    });
  }
  /**
   * Automatic rollback, opt-in per environment: when a verified generation degrades, select
   * the most recent release that verified here before — with its approval still binding —
   * and open the operation for a registered automatic, fenced executor. Anything missing is
   * a visible refusal on the environment, never a guess.
   */
  private async automaticRollback(db: pg.PoolClient, state: EnvironmentDelivery, now: Date) {
    const environment = await this.validation.definition(db, 'environment', { id: state.environmentId, revision: state.expected!.policyRevision }, false) as Environment;
    if (!deliveryPolicy(environment).automaticRollback) return;
    if ((await this.rollbacks(db, environment.id, state.generation)).length) return;
    const reasons: string[] = [];
    const registrations: Registration[] = (await db.query("SELECT DISTINCT ON (id) document FROM validation_definitions WHERE kind='registration' ORDER BY id,revision DESC")).rows.map(r => r.document);
    const executors = registrations.filter(r => r.role === 'rollback' && r.enabled && r.environment.id === environment.id && r.environment.revision === environment.revision && r.rollback?.automatic && r.rollback.fencing !== 'none' && same([...r.services!].sort(), [...environment.services].sort()));
    if (!executors.length) reasons.push('Automatic rollback refused: no enabled rollback adapter with provider or serialized fencing is registered for automatic rollback across this environment');
    const previous = [...state.history].reverse().find(h => h.outcome === 'verified' && !(h.releaseId === state.expected!.releaseId && h.releaseRevision === state.expected!.releaseRevision));
    if (!previous) reasons.push('Automatic rollback refused: no earlier release verified in this environment to roll back to');
    let target: Release | null = null, approval: ReleaseApproval | null = null;
    if (previous) {
      target = (await db.query('SELECT document FROM releases WHERE id=$1 AND revision=$2', [previous.releaseId, previous.releaseRevision])).rows[0]?.document ?? null;
      if (!target || target.environment.revision !== environment.revision) reasons.push('Automatic rollback refused: the previously verified release is not defined for the current policy revision');
      else try { approval = await this.approvalForTarget(db, environment, target); } catch (error) { reasons.push(`Automatic rollback refused: ${(error as Error).message}`); }
    }
    try { await this.assertNoSerializedOperation(db, environment.id); } catch (error) { reasons.push(`Automatic rollback refused: ${(error as Error).message}`); }
    if (reasons.length) {
      if (!same(state.automaticRollbackRefusal?.reasons, reasons) || state.automaticRollbackRefusal?.generation !== state.generation) await this.event(db, 'graphyard', 'rollback-refused', { environment: environment.id, generation: state.generation, reasons });
      state.automaticRollbackRefusal = { at: now.toISOString(), generation: state.generation, reasons };
      state.verification.reasons.push(...reasons); return;
    }
    await this.openRollback(db, state, environment, target!, approval, previous!.verifiedAt!, 'graphyard', `Automatic rollback: generation ${state.generation - 1} degraded after verification`, true, null, now);
  }
  /** A rollback completes only when Graphyard verifies the generation it selected: the target observed running across the manifest, healthy, with measured identity and a fresh common interval. */
  private async completeRollbacks(db: pg.PoolClient, state: EnvironmentDelivery, now: Date) {
    for (const rollback of await this.rollbacks(db, state.environmentId, state.generation)) {
      if (rollback.state !== 'applied') continue;
      rollback.verifiedAt = state.verification.verifiedAt; rollback.interval = state.verification.interval;
      await this.transition(db, rollback, 'verified', 'graphyard', `Target ${rollback.target.releaseId} r${rollback.target.releaseRevision} observed running and verified over ${state.verification.interval?.from} → ${state.verification.interval?.to}`, now);
    }
  }
  /**
   * Ingest one observation from a service-scoped observer. Everything about who observed
   * and under which authority is derived here, not from the payload: the registration must
   * be the caller's, the lease epoch current, the environment revision and the selection
   * generation the ones the adapter read. A stale one is retained as explicitly
   * non-authoritative history; it never touches coverage. A repeated snapshot returns the
   * original receipt, so a duplicate cannot refresh observation time.
   */
  async observe(actor: Principal, input: unknown, key: string) {
    demand(actor.role === 'producer', 'A deployment observer credential is required', 403);
    const parsed = observationSchema.parse(input);
    // Canonical timestamps: the interval arithmetic below compares instants, and stored history should read one way.
    const data = { ...parsed, observedAt: new Date(parsed.observedAt).toISOString(), validFrom: new Date(parsed.validFrom).toISOString(), validTo: new Date(parsed.validTo).toISOString() };
    return this.withReceipt(actor, 'observe', data, key, async (db, now) => {
      const registration = await this.validation.definition(db, 'registration', data.registration, false) as Registration;
      demand(registration.role === 'observer' && registration.principalId === actor.id, 'Wrong observer principal or registration role', 403);
      const duplicate = (await db.query('SELECT document FROM delivery_observations WHERE registration_id=$1 AND snapshot_id=$2', [registration.id, data.snapshotId])).rows[0]?.document as DeploymentObservation | undefined;
      if (duplicate) return { id: duplicate.id, authoritative: duplicate.authoritative, rejection: duplicate.rejection, duplicate: true, receivedAt: duplicate.receivedAt };
      const rejection: string[] = [];
      let environment: Environment | null = null;
      try { await this.validation.registration(db, data.registration, 'observer'); } catch (error) { rejection.push(`Observer registration authority is revoked or superseded: ${(error as Error).message}`); }
      try { environment = await this.environment(db, data.environment); } catch (error) { rejection.push(`Environment revision is not current: ${(error as Error).message}`); }
      demand(data.environment.id === registration.environment.id, 'Observer is registered for a different environment', 403);
      const outside = data.services.map(s => s.service).filter(service => !registration.services?.includes(service));
      if (outside.length) rejection.push(`Services outside this observer's scope: ${outside.join(', ')}`);
      try { await this.assertLease(db, registration, actor, data.epoch, now, 'Observer lease epoch is expired or superseded'); } catch (error) { rejection.push((error as Error).message); }
      const state = await this.state(db, data.environment.id);
      if (state.generation !== data.expectedGeneration) rejection.push(`Release generation ${data.expectedGeneration} is superseded by ${state.generation}`);
      const expected = state.expected ? Object.fromEntries((await this.release(db, { id: state.expected.releaseId, revision: state.expected.releaseRevision })).manifest.map(a => [a.service, a.digest])) : {};
      const states = Object.fromEntries(data.services.map(s => [s.service, expected[s.service] ? serviceState(s, expected[s.service]).state : 'unknown']));
      const observation: DeploymentObservation = { ...data, id: randomUUID(), observer: actor.id, generation: state.generation, authoritative: !rejection.length, rejection, receivedAt: now.toISOString(), states };
      await db.query('INSERT INTO delivery_observations(id,environment_id,registration_id,snapshot_id,document,received_at) VALUES($1,$2,$3,$4,$5,$6)', [observation.id, data.environment.id, registration.id, data.snapshotId, JSON.stringify(observation), now]);
      await this.event(db, actor.id, rejection.length ? 'observation-rejected' : 'observed', { observationId: observation.id, environment: data.environment.id, generation: state.generation, snapshotId: data.snapshotId, rejection, states });
      return { id: observation.id, authoritative: observation.authoritative, rejection, duplicate: false, receivedAt: observation.receivedAt };
    });
  }
  /** A provider webhook is a hint to observe again. It is recorded, and it changes nothing. */
  async notify(actor: Principal, input: unknown) {
    demand(['admin', 'producer', 'reader', 'coordinator'].includes(actor.role), 'Notifications require an authenticated non-worker credential', 403);
    const data = notificationSchema.parse(input);
    return this.store.transaction(async (db, now) => {
      demand((await db.query("SELECT 1 FROM validation_definitions WHERE kind='environment' AND id=$1 LIMIT 1", [data.environment])).rowCount, 'Environment is not defined', 404);
      const state = await this.state(db, data.environment);
      state.lastNotification = { at: now.toISOString(), provider: data.provider, payloadHash: hash(data.payload ?? null) };
      await this.persist(db, state);
      await this.event(db, actor.id, 'notified', { environment: data.environment, ...state.lastNotification });
      return { accepted: true, authoritative: false, environment: data.environment, at: state.lastNotification.at };
    });
  }
  /**
   * Fold at most `bound` new observations per environment into coverage, then re-evaluate.
   * The cursor persists with the state, so an interrupted or restarted sweep resumes exactly
   * where it stopped and no observation is skipped or applied twice.
   */
  async sweep(bound = 50) {
    return this.store.transaction(async (db, now) => {
      const states: EnvironmentDelivery[] = (await db.query('SELECT document FROM delivery_environments ORDER BY environment_id')).rows.map(r => r.document);
      let applied = 0, complete = true;
      for (const state of states) {
        const before = JSON.stringify(state);
        const rows = (await db.query('SELECT seq,document FROM delivery_observations WHERE environment_id=$1 AND seq>$2 ORDER BY seq LIMIT $3', [state.environmentId, state.cursor, bound + 1])).rows;
        const batch = rows.slice(0, bound);
        if (rows.length > bound) complete = false;
        const manifest = await this.manifest(db, state);
        for (const row of batch) { if (manifest) fold(state, row.document as DeploymentObservation, manifest); state.cursor = Number(row.seq); applied++; }
        await this.evaluate(db, state, manifest, now);
        if (state.verification.verifiedAt && state.verification.generation === state.generation && ['verified', 'stale'].includes(state.verification.status)) await this.completeRollbacks(db, state, now);
        if (state.verification.status === 'degraded') await this.automaticRollback(db, state, now);
        if (JSON.stringify(state) !== before) await this.persist(db, state);
      }
      return { environments: states.length, applied, complete };
    });
  }
  /** Expected digests come from the immutable release revision the selection names. */
  private async manifest(db: pg.PoolClient, state: EnvironmentDelivery) {
    if (!state.expected) return null;
    return Object.fromEntries((await this.release(db, { id: state.expected.releaseId, revision: state.expected.releaseRevision })).manifest.map(a => [a.service, a.digest]));
  }
  private async evaluate(db: pg.PoolClient, state: EnvironmentDelivery, manifest: Record<string, string> | null, now: Date) {
    const at = now.toISOString();
    const verification = state.verification;
    if (!state.expected || !manifest) { Object.assign(verification, { status: 'unselected', reasons: ['No expected release is selected'], interval: null, evaluatedAt: at }); return; }
    const environment = await this.validation.definition(db, 'environment', { id: state.environmentId, revision: state.expected.policyRevision }, false) as Environment;
    const reasons: string[] = []; let status: VerificationStatus = 'verified'; let interval: Interval | null = null;
    const worst = (candidate: VerificationStatus) => { const order: VerificationStatus[] = ['verified', 'stale', 'no-common-interval', 'incomplete', 'unhealthy', 'unknown', 'mismatched', 'unobserved']; if (order.indexOf(candidate) > order.indexOf(status)) status = candidate; };
    for (const service of Object.keys(manifest)) {
      const latest = state.coverage[service]?.latest;
      if (!latest) { worst('unobserved'); reasons.push(`Service ${service} has no authoritative observation for generation ${state.generation}`); continue; }
      if (latest.state !== 'matched') { worst(latest.state); reasons.push(...latest.reasons); }
    }
    if (status === 'verified') {
      interval = commonInterval(Object.keys(manifest).map(service => state.coverage[service].segments));
      if (!interval) { status = 'no-common-interval'; reasons.push('Matching observations of the required services never cover a common instant; independently sampled observations cannot prove simultaneity'); }
      else if (now.getTime() - Date.parse(interval.to) > deliveryPolicy(environment).freshnessSeconds * 1000) { status = 'stale'; reasons.push(`The latest common verified interval ended ${interval.to}, older than the ${deliveryPolicy(environment).freshnessSeconds}s freshness bound`); }
    }
    const previouslyVerified = !!verification.verifiedAt && verification.generation === state.generation;
    if (previouslyVerified && !['verified', 'stale'].includes(status)) {
      status = 'degraded';
      const observationIds = [...new Set(Object.values(state.coverage).filter(c => c.latest && c.latest.state !== 'matched').map(c => c.latest!.observationId))];
      for (const observationId of observationIds) if (!state.incidents.some(i => i.observationId === observationId)) {
        state.incidents.push({ id: randomUUID(), generation: state.generation, releaseId: state.expected.releaseId, releaseRevision: state.expected.releaseRevision, at, observationId, reasons: [...reasons] });
        await this.event(db, 'graphyard', 'incident', { environment: state.environmentId, generation: state.generation, observationId, reasons });
      }
      if (state.incidents.length > incidentLimit) state.incidents.splice(0, state.incidents.length - incidentLimit);
    }
    Object.assign(verification, { generation: state.generation, status, reasons, evaluatedAt: at, interval: status === 'verified' || status === 'stale' ? interval : previouslyVerified ? verification.interval : null });
    if (status === 'verified' && !previouslyVerified) {
      verification.verifiedAt = at;
      const selection = state.history.find(h => h.generation === state.generation);
      if (selection) { selection.outcome = 'verified'; selection.verifiedAt = at; selection.interval = interval!; }
      await this.event(db, 'graphyard', 'verified', { environment: state.environmentId, generation: state.generation, release: { id: state.expected.releaseId, revision: state.expected.releaseRevision }, interval });
      await this.attribute(db, state, interval!, now);
    }
  }
  /** Every included member of a newly verified release records the delivery once per environment. */
  private async attribute(db: pg.PoolClient, state: EnvironmentDelivery, interval: Interval, now: Date) {
    const release = await this.release(db, { id: state.expected!.releaseId, revision: state.expected!.releaseRevision });
    for (const member of release.members.filter(m => m.included)) {
      const work = (await db.query('SELECT document FROM work_items WHERE id=$1', [member.workId])).rows[0]?.document as Work | undefined;
      if (!work || work.releaseDeliveries?.some(d => d.environment === state.environmentId)) continue;
      const delivery: ReleaseDelivery = { environment: state.environmentId, policyRevision: state.expected!.policyRevision, releaseId: release.id, releaseRevision: release.revision, generation: state.generation, verifiedAt: now.toISOString(), interval };
      (work.releaseDeliveries ??= []).push(delivery);
      await save(db, work, 'graphyard', 'delivery.verified', now, { delivery, mergeSha: member.mergeSha });
    }
  }
  async status() {
    const environments: EnvironmentDelivery[] = (await this.store.pool.query('SELECT document FROM delivery_environments ORDER BY environment_id')).rows.map(r => r.document);
    const releases: Release[] = (await this.store.pool.query('SELECT document FROM releases ORDER BY id,revision DESC')).rows.map(r => r.document);
    const rollbacks: RollbackRequest[] = (await this.store.pool.query('SELECT document FROM delivery_rollbacks ORDER BY created_at DESC,id DESC LIMIT 200')).rows.map(r => r.document);
    const now = (await this.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
    return { environments, releases: releases.slice(0, 200), rollbacks, now: now.toISOString() };
  }
  async observations(environmentId: string, cursor?: string) {
    name.parse(environmentId);
    const before = cursor ? z.coerce.number().int().positive().parse(cursor) : null;
    const rows = (await this.store.pool.query('SELECT seq,document FROM delivery_observations WHERE environment_id=$1 AND ($2::bigint IS NULL OR seq<$2) ORDER BY seq DESC LIMIT 51', [environmentId, before])).rows;
    const observations = rows.slice(0, 50).map(r => ({ seq: Number(r.seq), ...r.document as DeploymentObservation }));
    return { observations, nextCursor: rows.length > 50 ? String(observations.at(-1)!.seq) : null };
  }
}
