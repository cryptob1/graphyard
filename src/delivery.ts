import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type pg from 'pg';
import { admin, demand, type Principal, type ReleaseDelivery, type Work } from './model.js';
import { save } from './store.js';
import { deliveryPolicy, type Environment, type Registration, type Validation } from './validation.js';

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
export interface EnvironmentDelivery {
  environmentId: string; generation: number;
  expected: { releaseId: string; releaseRevision: number; manifestHash: string; buildId: string; policyRevision: number; approvalId: string | null; selectedAt: string; selectedBy: string } | null;
  history: ReleaseSelection[];
  /** Folded from the current generation's authoritative observations only. */
  coverage: Record<string, { segments: Interval[]; latest: { observationId: string; observedAt: string; validTo: string; state: ServiceState; reasons: string[] } | null }>;
  verification: { generation: number; status: VerificationStatus; reasons: string[]; interval: Interval | null; evaluatedAt: string | null; verifiedAt: string | null };
  incidents: Incident[];
  /** The last observation sequence applied. Sweeps resume from here. */
  cursor: number;
  lastNotification?: { at: string; provider: string; payloadHash: string };
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
    if (!result.latest || ms(observation.validTo) >= ms(result.latest.validTo)) result.latest = { observationId: observation.id, observedAt: observation.observedAt, validTo: observation.validTo, state: serviceStatus, reasons };
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
      demand(registration.enabled && (registration.role === 'observer' || registration.role === 'promoter') && registration.principalId === actor.id, 'Registration is not an enabled deployment identity of this principal', 403);
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
      demand(release.environment.id === environment.id && release.environment.revision === environment.revision, 'Release was defined for a different environment or policy revision');
      const policy = deliveryPolicy(environment);
      let approval: ReleaseApproval | null = null;
      if (policy.approvalRequired || data.approvalId) {
        demand(data.approvalId, 'This environment requires an operator approval of the release');
        approval = (await db.query('SELECT document FROM release_approvals WHERE id=$1', [data.approvalId])).rows[0]?.document as ReleaseApproval | undefined ?? null;
        demand(approval && approval.releaseId === release.id && approval.releaseRevision === release.revision && approval.manifestHash === release.manifestHash && approval.buildId === release.buildId
          && approval.environment.id === environment.id && approval.policyRevision === environment.revision, 'Approval does not bind this exact release revision, manifest, provenance and policy revision');
      }
      const at = now.toISOString();
      for (const previous of state.history.filter(h => h.generation === state.generation && !h.supersededAt)) {
        previous.supersededAt = at;
        // Superseded is not unhealthy: a release that was never verified is skipped, one that was keeps its verification.
        if (previous.outcome === 'selected') previous.outcome = 'skipped';
      }
      state.generation += 1;
      state.expected = { releaseId: release.id, releaseRevision: release.revision, manifestHash: release.manifestHash, buildId: release.buildId, policyRevision: environment.revision, approvalId: approval?.id ?? null, selectedAt: at, selectedBy: actor.id };
      state.history.push({ generation: state.generation, releaseId: release.id, releaseRevision: release.revision, policyRevision: environment.revision, selectedAt: at, selectedBy: actor.id, outcome: 'selected' });
      if (state.history.length > historyLimit) state.history.splice(0, state.history.length - historyLimit);
      state.coverage = {};
      state.verification = { generation: state.generation, status: 'unobserved', reasons: [`No authoritative observation for generation ${state.generation} yet`], interval: null, evaluatedAt: at, verifiedAt: null };
      await this.persist(db, state);
      await this.event(db, actor.id, 'selected', { environment: environment.id, generation: state.generation, release: data.release, approvalId: approval?.id ?? null, delegate: data.delegate ?? null });
      return state;
    });
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
    const now = (await this.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
    return { environments, releases: releases.slice(0, 200), now: now.toISOString() };
  }
  async observations(environmentId: string, cursor?: string) {
    name.parse(environmentId);
    const before = cursor ? z.coerce.number().int().positive().parse(cursor) : null;
    const rows = (await this.store.pool.query('SELECT seq,document FROM delivery_observations WHERE environment_id=$1 AND ($2::bigint IS NULL OR seq<$2) ORDER BY seq DESC LIMIT 51', [environmentId, before])).rows;
    const observations = rows.slice(0, 50).map(r => ({ seq: Number(r.seq), ...r.document as DeploymentObservation }));
    return { observations, nextCursor: rows.length > 50 ? String(observations.at(-1)!.seq) : null };
  }
}
