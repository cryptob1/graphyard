import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { BuildAttestation } from './validation.js';
import type { DeploymentObservation } from './delivery.js';

// Candidate-to-deployment attribution.
//
// Three questions are answered here, each from trusted records only. What *is* a target
// (a manifest: every service of an environment mapped to an artifact digest and a source
// SHA, at one configuration revision); what a validation result *may be attributed to* (the
// exact manifest, the test bundle and the target an independent observer saw running for
// the whole execution window); and what happened when the two diverged (the append-only
// attribution ledger the analytics read). Nothing here trusts a client-supplied SHA, a
// deployment's self-report, or a mutable work snapshot as proof of what ran where.

const sha256 = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
/** Canonical JSON: sorted keys, so jsonb key reordering never changes a hash. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}

// ---- Manifests ------------------------------------------------------------------------------

export interface ManifestService { service: string; digest: string; sourceSha: string }
/**
 * A release manifest. `digestHash` is the content address of what runs (service → artifact
 * digest) and is what an observed target is matched against; `hash` also binds each
 * service's source SHA and the configuration revision, so two manifests that run the same
 * bytes under different configuration are different manifests. Both are derived from
 * append-only records — a release revision or a build attestation — never supplied.
 */
export interface ReleaseManifest {
  hash: string; digestHash: string;
  environment: { id: string; revision: number }; configurationRevision: number;
  services: ManifestService[];
  source: { kind: 'release'; releaseId: string; releaseRevision: number; buildId: string; sourceSha: string; members: { workId: string; key: string; mergeSha: string; included: boolean }[]; createdBy: string; createdAt: string }
    | { kind: 'build-attestation'; buildId: string; workId: string; sourceSha: string; baseSha: string; producer: string; at: string };
}
/** The content address of what runs: identical to the release registry's `manifestHash`, so observed targets match releases directly. */
export const digestHash = (artifacts: { service: string; digest: string }[]) => sha256([...artifacts].sort((a, b) => a.service.localeCompare(b.service)).map(a => [a.service, a.digest]));
export const manifestHash = (services: ManifestService[], configurationRevision: number) => sha256({ v: 1, configurationRevision, services: [...services].sort((a, b) => a.service.localeCompare(b.service)).map(s => [s.service, s.digest, s.sourceSha]) });

export function candidateManifest(build: BuildAttestation, environment: { id: string; revision: number }): ReleaseManifest {
  const services = build.artifacts.map(a => ({ service: a.service, digest: a.digest, sourceSha: build.sourceSha }));
  return { hash: manifestHash(services, environment.revision), digestHash: digestHash(build.artifacts), environment, configurationRevision: environment.revision, services,
    source: { kind: 'build-attestation', buildId: build.id, workId: build.workId, sourceSha: build.sourceSha, baseSha: build.baseSha, producer: build.producer, at: build.at } };
}

// ---- Compatibility signatures ---------------------------------------------------------------

/**
 * What a validation pass is compatible with. Each component is hashed on its own so a
 * regenerated signature can say which one moved: the manifest (artifacts, sources,
 * configuration revision), the build inputs (dependencies, migrations, helpers — whatever the
 * attested build digested), the test bundle and runner image, the scenario, the candidate
 * source, the policy revision and the artifact requirements.
 */
export interface SignatureInput {
  manifestHash: string; sourceSha: string; baseSha: string; policyRevision: number; buildInputsDigest: string;
  bundle: { digest: string; runnerImageDigest: string; scenarioHash: string; scenarioRevision: number };
  environment: { id: string; revision: number }; requiredArtifacts: string[]; proof: string;
}
export const signatureComponents = ['manifest', 'build-inputs', 'test-bundle', 'configuration', 'source', 'policy', 'artifacts'] as const;
export type SignatureComponent = typeof signatureComponents[number];
export function compatibilitySignature(input: SignatureInput): { signature: string; components: Record<SignatureComponent, string> } {
  const components: Record<SignatureComponent, string> = {
    manifest: sha256(input.manifestHash), 'build-inputs': sha256(input.buildInputsDigest), 'test-bundle': sha256([input.bundle.digest, input.bundle.runnerImageDigest, input.bundle.scenarioHash, input.bundle.scenarioRevision, input.proof]),
    configuration: sha256([input.environment.id, input.environment.revision]), source: sha256([input.sourceSha, input.baseSha]), policy: sha256(input.policyRevision), artifacts: sha256([...input.requiredArtifacts].sort()),
  };
  return { signature: sha256({ v: 1, ...components }), components };
}
/** Which components differ between two signatures; empty when they are the same signature. */
export function signatureDifferences(previous: Record<string, string> | undefined, next: Record<string, string>): SignatureComponent[] {
  return signatureComponents.filter(component => previous?.[component] !== next[component]);
}

// ---- Independently observed target identity ---------------------------------------------------

export type TargetServiceState = 'matched' | 'mismatched' | 'unknown' | 'incomplete' | 'unobserved';
export type TargetState = 'unobserved' | 'matched' | 'mismatched' | 'unknown';
export interface TargetService { state: TargetServiceState; digest: string | null; measurement: string | null; observationId: string | null; observedAt: string | null; validFrom: string | null; validTo: string | null }
/**
 * What an environment is running, as its service-scoped observers reported it. Only a
 * measured identity (provider or host attestation) can match or mismatch; a self-report is
 * `unknown` even when it agrees, because agreement proves nothing. `digestHash` is the
 * content address of the observed target and exists only once every service is measured.
 * `ambiguous` says two authoritative observations of one service overlapped in validity and
 * disagreed — a target that cannot be attributed to until observations converge.
 */
export interface TargetIdentity {
  state: TargetState; services: Record<string, TargetService>; digestHash: string | null;
  observationIds: string[]; observedAt: string | null; ambiguous: boolean;
  /** Some services already run the expected digest while others do not: a rollout in progress. */
  partialConvergence: boolean; matchedServices: number; mismatchedServices: number; reasons: string[];
}
type ServiceSnapshot = DeploymentObservation['services'][number];
const measured = (instance: ServiceSnapshot['instances'][number]) => (instance.measurement === 'provider' || instance.measurement === 'host-attestation') && !!instance.digest;
/** One snapshot's measured identity: a single measured digest, or why there is none. */
export function measuredIdentity(snapshot: ServiceSnapshot): { digest: string | null; measurement: string | null; kind: 'measured' | 'self-report' | 'unknown' | 'incomplete' | 'divergent' } {
  if (!snapshot.complete || !snapshot.instances.length) return { digest: null, measurement: null, kind: 'incomplete' };
  const digests = [...new Set(snapshot.instances.filter(measured).map(i => i.digest!))];
  if (digests.length > 1) return { digest: null, measurement: 'provider', kind: 'divergent' };
  if (digests.length === 1 && snapshot.instances.every(measured)) return { digest: digests[0], measurement: snapshot.instances[0].measurement, kind: 'measured' };
  if (digests.length === 1) return { digest: null, measurement: null, kind: 'incomplete' };
  return { digest: null, measurement: snapshot.instances[0].measurement, kind: snapshot.instances.some(i => i.measurement === 'self-report') ? 'self-report' : 'unknown' };
}
const ms = Date.parse;
/**
 * Authoritative observations with each observer's validity clipped to its own series: a
 * sample speaks for the time between the observer's previous and next samples, so an
 * observer that later measures something else has withdrawn the earlier claim from that
 * instant on, and cannot contradict what it itself measured earlier. Two observers who
 * disagree over the same instant remain ambiguous.
 */
export function effectiveObservations(observations: DeploymentObservation[]): DeploymentObservation[] {
  const byRegistration = new Map<string, DeploymentObservation[]>();
  for (const o of observations.filter(o => o.authoritative)) (byRegistration.get(o.registration.id) ?? byRegistration.set(o.registration.id, []).get(o.registration.id)!).push(o);
  const clipped: DeploymentObservation[] = [];
  for (const [, series] of byRegistration) {
    series.sort((a, b) => ms(a.observedAt) - ms(b.observedAt) || ms(a.receivedAt) - ms(b.receivedAt));
    series.forEach((o, index) => {
      const previous = series[index - 1], next = series[index + 1];
      // Consecutive samples meet at the later sample's observation instant: the earlier one ends there, the later one begins there.
      const validFrom = previous && ms(previous.validTo) > ms(o.validFrom) ? o.observedAt : o.validFrom;
      const validTo = next && ms(next.observedAt) < ms(o.validTo) && ms(next.observedAt) >= ms(o.observedAt) ? next.observedAt : o.validTo;
      clipped.push(validFrom === o.validFrom && validTo === o.validTo ? o : { ...o, validFrom, validTo });
    });
  }
  return clipped;
}
/**
 * The current target identity of an environment against an expected manifest, from the
 * latest authoritative observation of each service. Observations are ordered by their own
 * observation time, so a delayed report of an older state never overrides a newer one; it
 * does, however, count toward ambiguity when its validity overlaps a contradicting report.
 */
export function targetIdentity(observations: DeploymentObservation[], expected: Record<string, string>): TargetIdentity {
  const services: Record<string, TargetService> = {}; const reasons: string[] = []; let ambiguous = false;
  const authoritative = effectiveObservations(observations);
  for (const service of Object.keys(expected).sort()) {
    const seen = authoritative.flatMap(o => o.services.filter(s => s.service === service).map(snapshot => ({ observation: o, identity: measuredIdentity(snapshot) })))
      .sort((a, b) => ms(b.observation.observedAt) - ms(a.observation.observedAt) || ms(b.observation.receivedAt) - ms(a.observation.receivedAt));
    const latest = seen[0];
    if (!latest) { services[service] = { state: 'unobserved', digest: null, measurement: null, observationId: null, observedAt: null, validFrom: null, validTo: null }; reasons.push(`Service ${service} has no authoritative observation`); continue; }
    const { identity, observation } = latest;
    const state: TargetServiceState = identity.kind === 'measured' ? (identity.digest === expected[service] ? 'matched' : 'mismatched') : identity.kind === 'incomplete' ? 'incomplete' : 'unknown';
    services[service] = { state, digest: identity.digest, measurement: identity.measurement, observationId: observation.id, observedAt: observation.observedAt, validFrom: observation.validFrom, validTo: observation.validTo };
    if (state === 'mismatched') reasons.push(`Service ${service} runs ${identity.digest} instead of ${expected[service]}`);
    if (state === 'unknown') reasons.push(`Runtime identity of ${service} is ${identity.kind === 'self-report' ? 'only self-reported' : identity.kind === 'divergent' ? 'divergent across instances' : 'unknown'}${identity.kind === 'self-report' ? ' (a claimed digest proves nothing)' : ''}`);
    if (state === 'incomplete') reasons.push(`Instance listing for ${service} is incomplete`);
    // Two overlapping measured observations that disagree: nobody knows which one is the target.
    for (const other of seen.slice(1)) {
      if (other.identity.kind !== 'measured' || identity.kind !== 'measured' || other.identity.digest === identity.digest) continue;
      if (ms(other.observation.validFrom) < ms(observation.validTo) && ms(observation.validFrom) < ms(other.observation.validTo)) { ambiguous = true; reasons.push(`Overlapping observations ${observation.id} and ${other.observation.id} disagree about ${service}`); break; }
    }
  }
  const states = Object.values(services).map(s => s.state);
  const matchedServices = states.filter(s => s === 'matched').length, mismatchedServices = states.filter(s => s === 'mismatched').length;
  const state: TargetState = states.every(s => s === 'unobserved') ? 'unobserved' : states.every(s => s === 'matched') ? 'matched' : mismatchedServices ? 'mismatched' : 'unknown';
  const fullyMeasured = states.length > 0 && states.every(s => s === 'matched' || s === 'mismatched');
  const observed = Object.values(services).filter(s => s.observationId);
  return { state, services, digestHash: fullyMeasured ? digestHash(Object.entries(services).map(([service, s]) => ({ service, digest: s.digest! }))) : null,
    observationIds: [...new Set(observed.map(s => s.observationId!))].sort(), observedAt: observed.length ? observed.map(s => s.observedAt!).sort().at(-1)! : null,
    ambiguous, partialConvergence: matchedServices > 0 && matchedServices < states.length, matchedServices, mismatchedServices, reasons };
}
/**
 * Whether the target held the expected manifest across an execution window: every
 * authoritative observation whose validity overlaps [from, to] must measure the expected
 * digest for the services it reports. A delayed observation is judged the same way when it
 * arrives, which is how a pass recorded earlier can be found unsupported later.
 */
export function windowIdentity(observations: DeploymentObservation[], expected: Record<string, string>, from: string, to: string): { state: 'unobserved' | 'matched' | 'mismatched' | 'unknown'; observationIds: string[]; reasons: string[] } {
  const overlapping = effectiveObservations(observations).filter(o => ms(o.validFrom) <= ms(to) && ms(o.validTo) >= ms(from));
  const reasons: string[] = []; const ids = new Set<string>(); let unknown = false, matched = false;
  for (const observation of overlapping) for (const snapshot of observation.services) {
    if (!expected[snapshot.service]) continue;
    ids.add(observation.id);
    const identity = measuredIdentity(snapshot);
    if (identity.kind === 'measured' && identity.digest !== expected[snapshot.service]) reasons.push(`Observation ${observation.id} (${observation.validFrom} → ${observation.validTo}) measured ${snapshot.service} at ${identity.digest} instead of ${expected[snapshot.service]}`);
    else if (identity.kind === 'measured') matched = true; else unknown = true;
  }
  return { state: reasons.length ? 'mismatched' : !ids.size ? 'unobserved' : unknown && !matched ? 'unknown' : 'matched', observationIds: [...ids].sort(), reasons };
}

// ---- The attribution ledger ------------------------------------------------------------------

export const attributionKinds = ['target-checked', 'target-mismatch', 'target-changed', 'paid-run-avoided', 'superseded', 'rescheduled', 'reanchor-blocked', 'signature-regenerated', 'unsupported-claim-refused', 'attribution-undermined', 'evidence-bound'] as const;
export type AttributionKind = typeof attributionKinds[number];
export interface AttributionRecord {
  id: string; seq?: number; workId: string; workKey: string; proof: string; environmentId: string;
  candidateId: string | null; requestId: string | null; attemptId: string | null;
  kind: AttributionKind; recordedAt: string; dedupe: string | null; details: Record<string, any>;
}
export type AttributionEntry = Omit<AttributionRecord, 'id' | 'seq' | 'recordedAt'>;
/** Append one record. A record with a dedupe key is written once however many times its cause is observed. */
export async function appendAttribution(db: pg.PoolClient, now: Date, entry: AttributionEntry) {
  const row = (await db.query(`INSERT INTO attribution_records(work_id,work_key,proof,environment_id,candidate_id,request_id,attempt_id,kind,recorded_at,dedupe,details)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (dedupe) DO NOTHING RETURNING id`, [entry.workId, entry.workKey, entry.proof, entry.environmentId, entry.candidateId, entry.requestId, entry.attemptId, entry.kind, now, entry.dedupe, JSON.stringify(entry.details)])).rows[0];
  return row ? { id: row.id as string, appended: true } : { id: null, appended: false };
}
