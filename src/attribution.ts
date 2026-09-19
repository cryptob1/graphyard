import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Store } from './store.js';
import type { BuildAttestation, ValidationRequest } from './validation.js';
import type { DeploymentObservation, Release } from './delivery.js';
import { distribution, flowWindows, type FlowWindow } from './flow-analytics.js';

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

export function releaseManifest(release: Release): ReleaseManifest {
  const services = release.manifest.map(a => ({ service: a.service, digest: a.digest, sourceSha: release.sourceSha }));
  return { hash: manifestHash(services, release.environment.revision), digestHash: digestHash(release.manifest), environment: release.environment, configurationRevision: release.environment.revision, services,
    source: { kind: 'release', releaseId: release.id, releaseRevision: release.revision, buildId: release.buildId, sourceSha: release.sourceSha, members: release.members.map(m => ({ workId: m.workId, key: m.key, mergeSha: m.mergeSha, included: m.included })), createdBy: release.createdBy, createdAt: release.createdAt } };
}
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
function rowToRecord(row: any): AttributionRecord {
  return { id: row.id, seq: Number(row.seq), workId: row.work_id, workKey: row.work_key, proof: row.proof, environmentId: row.environment_id, candidateId: row.candidate_id, requestId: row.request_id, attemptId: row.attempt_id, kind: row.kind, recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : row.recorded_at, dedupe: row.dedupe, details: row.details ?? {} };
}
/** One work item's attribution history, newest last, bounded. */
export async function attributionHistory(store: Store, workId: string, limit = 200): Promise<AttributionRecord[]> {
  return (await store.pool.query('SELECT * FROM attribution_records WHERE work_id=$1 ORDER BY seq DESC LIMIT $2', [workId, limit])).rows.map(rowToRecord).reverse();
}

// ---- Analytics ------------------------------------------------------------------------------

export const attributionWindows = flowWindows;
export const attributionLimits = { records: 20_000, requests: 5000, drilldown: 200, items: 25 };
const day = 86_400_000;
export interface AttributionQuery { days: FlowWindow; asOf?: string | null }
export interface AttributionDataset {
  observedAt: string; from: string; to: string; days: FlowWindow;
  records: AttributionRecord[]; recordsTruncated: boolean;
  /** Requests created or acknowledged in the window; the paid-run and preview-share denominators. */
  requests: ValidationRequest[]; requestsTruncated: boolean;
  /** Whether each environment named by a request is an immutable preview. */
  environments: Record<string, { immutable: boolean }>;
  /** Blocked re-anchors still standing at the observation instant, from the current work documents' bindings. */
  blockedNow: { workKey: string; workId: string; proof: string; environmentId: string; reasons: string[]; since: string; supersededRequestId: string }[];
}
function iso(value: Date | string) { return value instanceof Date ? value.toISOString() : value; }
export async function readAttribution(store: Store, query: AttributionQuery): Promise<AttributionDataset> {
  const clock = iso((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now);
  const asOf = query.asOf ? Date.parse(query.asOf) : NaN;
  const observedAt = Number.isFinite(asOf) && asOf <= Date.parse(clock) ? new Date(asOf).toISOString() : clock;
  const to = observedAt, from = new Date(Date.parse(observedAt) - query.days * day).toISOString();
  const recordRows = (await store.pool.query('SELECT * FROM attribution_records WHERE recorded_at>=$1 AND recorded_at<$2 ORDER BY recorded_at,seq LIMIT $3', [from, to, attributionLimits.records + 1])).rows;
  const requestRows = (await store.pool.query(`SELECT document FROM validation_requests WHERE (document->>'createdAt')>=$1 AND (document->>'createdAt')<$2 ORDER BY document->>'createdAt',id LIMIT $3`, [from, to, attributionLimits.requests + 1])).rows;
  const requests: ValidationRequest[] = requestRows.slice(0, attributionLimits.requests).map(r => r.document);
  const environmentIds = [...new Set([...requests.map(r => r.attribution?.environmentId).filter((id): id is string => !!id), ...recordRows.map(r => r.environment_id as string)])];
  const environmentRows = environmentIds.length ? (await store.pool.query("SELECT DISTINCT ON (id) id,document FROM validation_definitions WHERE kind='environment' AND id=ANY($1::text[]) ORDER BY id,revision DESC", [environmentIds])).rows : [];
  const environments = Object.fromEntries(environmentRows.map(r => [r.id, { immutable: r.document.immutable !== false }]));
  const blockedRows = (await store.pool.query(`SELECT w.document->>'id' AS id, w.document->>'key' AS key, v.key AS proof, v.value->'reanchor' AS reanchor, v.value->>'environmentId' AS environment
    FROM work_items w CROSS JOIN LATERAL jsonb_each(COALESCE(w.document->'validation','{}'::jsonb)) v WHERE v.value->'reanchor'->>'state'='blocked' AND w.document->>'stage'<>'done' ORDER BY w.number LIMIT 500`)).rows;
  const blockedNow = blockedRows.filter(r => r.reanchor.at <= to).map(r => ({ workKey: r.key, workId: r.id, proof: r.proof, environmentId: r.reanchor.environmentId ?? r.environment ?? '', reasons: r.reanchor.reasons ?? [], since: r.reanchor.at, supersededRequestId: r.reanchor.supersededRequestId }));
  return { observedAt, from, to, days: query.days, records: recordRows.slice(0, attributionLimits.records).map(rowToRecord), recordsTruncated: recordRows.length > attributionLimits.records,
    requests, requestsTruncated: requestRows.length > attributionLimits.requests, environments, blockedNow };
}

export type MetricState = 'measured' | 'unavailable' | 'blocked';
export interface Metric { id: string; label: string; state: MetricState; count: number | null; n: number; average: number | null; median: number | null; p90: number | null; unit: 'count' | 'ms' | 'services' | 'ratio'; reason: string | null; sparse: boolean }
export const attributionDefinitions: Record<string, { label: string; formula: string; sources: string[] }> = {
  targetMismatches: { label: 'Target mismatches', formula: 'Count of target checks in the window where the independently observed target identity of the request\'s environment measured a digest other than the candidate manifest for at least one service, at request creation, at dispatch, at result, or when a later observation arrived. Self-reported identities never count as a match or a mismatch.', sources: ['attribution_records:target-mismatch', 'attribution_records:target-changed', 'attribution_records:attribution-undermined'] },
  paidRunsAvoided: { label: 'Paid runs avoided', formula: 'Dispatch grants and request creations refused because the target was already known to mismatch, deduplicated per request and observation. Each avoided run saves one cost unit.', sources: ['attribution_records:paid-run-avoided'] },
  superseded: { label: 'Requests superseded', formula: 'Requests whose target moved while unstarted or whose accepted result was undermined by a later observation, and which were therefore superseded without editing the request, attempt, result or evidence record.', sources: ['attribution_records:superseded'] },
  rescheduled: { label: 'Requests rescheduled', formula: 'Fresh requests created by automatic re-anchoring after trusted release membership showed the moved target contains the intended change. Each requires fresh execution; a prior pass is never reused.', sources: ['attribution_records:rescheduled'] },
  reanchors: { label: 'Re-anchor count', formula: 'Automatic re-anchor decisions in the window: rescheduled plus blocked. A decision is recorded once per superseded request and observed target.', sources: ['attribution_records:rescheduled', 'attribution_records:reanchor-blocked'] },
  blocked: { label: 'Blocked re-anchors', formula: 'Re-anchor decisions that stayed blocked because release membership or target history was ambiguous, the moved target does not contain the intended change, or the request deadline had passed. The current count reads the standing blocked bindings at the observation instant.', sources: ['attribution_records:reanchor-blocked', 'work_items:validation.reanchor'] },
  convergenceWait: { label: 'Target-convergence wait', formula: 'Per rescheduled request, the interval from the target check that found the mismatch to the first later target check on the same work item and proof that found every service matched. Open waits are excluded and counted.', sources: ['attribution_records:target-mismatch', 'attribution_records:target-checked'] },
  multiServiceConvergence: { label: 'Multi-service convergence', formula: 'Per environment and manifest, the interval from the first target check where some but not all services matched the manifest to the first where all matched. Rollouts that never completed in the window are excluded and counted.', sources: ['attribution_records:target-checked', 'attribution_records:target-mismatch'] },
  candidateToReleaseDrift: { label: 'Candidate-to-release drift', formula: 'Per target mismatch, the number of services whose observed digest differed from the candidate manifest. Distribution over mismatches in the window.', sources: ['attribution_records:target-mismatch', 'attribution_records:target-changed'] },
  signatureRegenerations: { label: 'Signature regeneration', formula: 'Candidates whose compatibility signature differs from the previous candidate of the same work item and proof, by the component that changed: manifest, build inputs, test bundle, configuration, source, policy, artifacts.', sources: ['attribution_records:signature-regenerated'] },
  immutablePreviewShare: { label: 'Immutable-preview share', formula: 'Requests created in the window whose environment is an immutable preview, divided by all requests created in the window. Shared-staging requests are the remainder.', sources: ['validation_requests', 'validation_definitions:environment'] },
  unsupportedClaims: { label: 'Unsupported-success claims prevented', formula: 'Reports and submissions refused or failed because their success claim was not supported by independent measurement: a claimed match on a self-reported or unknown identity, a client-supplied SHA offered as target proof, a result whose target changed during execution, or a pass undermined by a later observation.', sources: ['attribution_records:unsupported-claim-refused', 'attribution_records:target-changed', 'attribution_records:attribution-undermined'] },
  cost: { label: 'Cost accounting', formula: 'One cost unit is one paid run: an attempt the runner acknowledged, which authorizes a container start. Spent units count acknowledged attempts in the window; wasted units are spent units whose result could not be attributed (target changed, undermined, or refused); saved units are paid runs avoided. Cost is never estimated from money; it is counted in runs.', sources: ['validation_requests:attempts', 'attribution_records:paid-run-avoided', 'attribution_records:target-changed', 'attribution_records:attribution-undermined'] },
};

function metric(id: string, unit: Metric['unit'], values: number[], count: number | null, available: boolean, reason: string | null, state: MetricState = available ? 'measured' : 'unavailable'): Metric {
  const spread = distribution(values);
  return { id, label: attributionDefinitions[id].label, state, count, n: spread.n, average: spread.averageMs, median: spread.medianMs, p90: spread.p90Ms, unit, reason: state === 'measured' ? null : reason, sparse: spread.sparse };
}
/** Pure aggregation over the bounded dataset; the same dataset always yields the same report. */
export function computeAttribution(dataset: AttributionDataset) {
  const { records } = dataset;
  const to = Date.parse(dataset.to);
  const excluded = new Map<string, Set<string>>();
  const exclude = (reason: string, key: string) => { (excluded.get(reason) ?? excluded.set(reason, new Set()).get(reason)!).add(key); };
  const ofKind = (...kinds: AttributionKind[]) => records.filter(r => kinds.includes(r.kind));
  const checks = ofKind('target-checked', 'target-mismatch');
  const observed = checks.length > 0;
  const noChecks = 'No target check was recorded in this window: no request was created, dispatched or collected against an observed environment. The value is unknown, not zero.';

  const mismatches = ofKind('target-mismatch', 'target-changed', 'attribution-undermined');
  const targetMismatches = metric('targetMismatches', 'count', [], observed ? mismatches.length : null, observed, noChecks);
  const avoided = ofKind('paid-run-avoided');
  const paidRunsAvoided = metric('paidRunsAvoided', 'count', [], observed ? avoided.length : null, observed, noChecks);
  const supersededRecords = ofKind('superseded'), rescheduledRecords = ofKind('rescheduled'), blockedRecords = ofKind('reanchor-blocked');
  const superseded = metric('superseded', 'count', [], observed ? supersededRecords.length : null, observed, noChecks);
  const rescheduled = metric('rescheduled', 'count', [], observed ? rescheduledRecords.length : null, observed, noChecks);
  const reanchors = metric('reanchors', 'count', [], observed ? rescheduledRecords.length + blockedRecords.length : null, observed, noChecks);
  const blocked = metric('blocked', 'count', [], dataset.blockedNow.length, true, null, dataset.blockedNow.length ? 'blocked' : 'measured');

  // Convergence wait: mismatch → first later all-matched check on the same work/proof.
  const waits: { key: string; ms: number; mismatch: AttributionRecord; matched: AttributionRecord }[] = [];
  let openWaits = 0;
  for (const mismatch of ofKind('target-mismatch')) {
    const matched = checks.find(r => r.kind === 'target-checked' && r.workId === mismatch.workId && r.proof === mismatch.proof && r.details.state === 'matched' && (r.seq ?? 0) > (mismatch.seq ?? 0));
    if (!matched) { openWaits++; exclude('convergence-wait-open', mismatch.workKey); continue; }
    const value = Date.parse(matched.recordedAt) - Date.parse(mismatch.recordedAt);
    if (value < 0) { exclude('clock-inverted-convergence', mismatch.workKey); continue; }
    waits.push({ key: mismatch.workKey, ms: value, mismatch, matched });
  }
  const convergenceWait = metric('convergenceWait', 'ms', waits.map(w => w.ms), null, observed && ofKind('target-mismatch').length > 0, observed ? 'No target mismatch was recorded in this window, so there was nothing to converge.' : noChecks);

  // Multi-service convergence: first partial check per environment+manifest → first all-matched check.
  const rollouts = new Map<string, { partial: AttributionRecord; matched?: AttributionRecord }>();
  for (const check of checks.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
    const key = `${check.environmentId}:${check.details.manifestHash ?? ''}`;
    const rollout = rollouts.get(key);
    if (check.details.partialConvergence && !rollout) rollouts.set(key, { partial: check });
    else if (rollout && !rollout.matched && check.details.state === 'matched') rollout.matched = check;
  }
  const rolloutValues: number[] = []; let openRollouts = 0;
  for (const [key, rollout] of rollouts) {
    if (!rollout.matched) { openRollouts++; exclude('rollout-not-converged', rollout.partial.workKey); continue; }
    rolloutValues.push(Math.max(0, Date.parse(rollout.matched.recordedAt) - Date.parse(rollout.partial.recordedAt)));
    void key;
  }
  const multiServiceConvergence = metric('multiServiceConvergence', 'ms', rolloutValues, null, rollouts.size > 0, observed ? 'No partial rollout (some services matched, others not) was observed in this window.' : noChecks);

  const drift = mismatches.map(r => Number(r.details.mismatchedServices ?? 0)).filter(v => Number.isFinite(v));
  const candidateToReleaseDrift = metric('candidateToReleaseDrift', 'services', drift, null, mismatches.length > 0, observed ? 'No target mismatch was recorded in this window.' : noChecks);

  const regenerations = ofKind('signature-regenerated');
  const byComponent: Record<string, number> = {};
  for (const r of regenerations) for (const component of r.details.changed ?? []) byComponent[component] = (byComponent[component] ?? 0) + 1;
  const candidatesCreated = records.filter(r => r.kind === 'signature-regenerated' || r.kind === 'target-checked' && r.details.phase === 'request').length;
  const signatureRegenerations = { ...metric('signatureRegenerations', 'count', [], candidatesCreated ? regenerations.length : null, candidatesCreated > 0, 'No validation candidate was created in this window.'), byComponent };

  const requestsWithKind = dataset.requests.filter(r => r.attribution?.environmentId);
  const previewRequests = requestsWithKind.filter(r => r.attribution!.targetKind === 'immutable-preview').length;
  const immutablePreviewShare = { ...metric('immutablePreviewShare', 'ratio', [], null, requestsWithKind.length > 0, 'No validation request was created in this window.'), ratio: requestsWithKind.length ? Number((previewRequests / requestsWithKind.length).toFixed(4)) : null, preview: previewRequests, sharedStaging: requestsWithKind.length - previewRequests, requests: requestsWithKind.length };

  const unsupported = ofKind('unsupported-claim-refused', 'target-changed', 'attribution-undermined');
  const unsupportedClaims = metric('unsupportedClaims', 'count', [], observed || unsupported.length ? unsupported.length : null, observed || unsupported.length > 0, noChecks);

  // Cost: paid runs are acknowledged attempts; wasted ones could not be attributed.
  const from = Date.parse(dataset.from);
  const paid = dataset.requests.flatMap(r => r.attempts.filter(a => a.acknowledgedAt && Date.parse(a.acknowledgedAt) >= from && Date.parse(a.acknowledgedAt) < to).map(a => ({ request: r, attempt: a })));
  const wastedAttempts = new Set(ofKind('target-changed', 'attribution-undermined').map(r => r.attemptId).filter(Boolean));
  const wasted = paid.filter(p => wastedAttempts.has(p.attempt.id)).length;
  const runDurations = paid.filter(p => p.attempt.finishedAt).map(p => Date.parse(p.attempt.finishedAt!) - Date.parse(p.attempt.acknowledgedAt!)).filter(v => v >= 0);
  const costAvailable = paid.length > 0 || avoided.length > 0;
  const cost = { ...metric('cost', 'ms', runDurations, paid.length, costAvailable, 'No attempt was acknowledged and no paid run was avoided in this window; cost is unknown, not zero.'),
    unit: 'ms' as const, spentUnits: costAvailable ? paid.length : null, wastedUnits: costAvailable ? wasted : null, savedUnits: costAvailable ? avoided.length : null,
    attributedUnits: costAvailable ? paid.length - wasted : null, model: 'One cost unit is one acknowledged attempt (a paid run). Units are counted, never priced.' };

  const exclusions = [...excluded].map(([reason, keys]) => ({ reason, count: keys.size, items: [...keys].sort().slice(0, attributionLimits.items) })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  const metrics = { targetMismatches, paidRunsAvoided, superseded, rescheduled, reanchors, blocked, convergenceWait, multiServiceConvergence, candidateToReleaseDrift, signatureRegenerations, immutablePreviewShare, unsupportedClaims, cost };
  const unavailable = Object.values(metrics).filter(m => m.state === 'unavailable').map(m => ({ metric: m.id, reason: m.reason! }));
  const environmentsObserved = [...new Set(checks.map(r => r.environmentId))].sort();
  return {
    generatedAt: dataset.observedAt, timezone: 'UTC',
    window: { days: dataset.days, from: dataset.from, to: dataset.to, boundaries: 'Half-open interval [from, to) in UTC over the record time of each attribution ledger entry.' },
    definitions: attributionDefinitions, limits: attributionLimits,
    trust: 'Every figure derives from the append-only attribution ledger, immutable validation records and authoritative observer reports. A worker, validation client, deployment self-report or client-supplied SHA cannot create, edit or relabel any record these metrics read.',
    coverage: {
      records: records.length, recordsTruncated: dataset.recordsTruncated, recordScanLimit: attributionLimits.records,
      requests: dataset.requests.length, requestsTruncated: dataset.requestsTruncated, requestScanLimit: attributionLimits.requests,
      targetChecks: checks.length, environmentsObserved, workItems: new Set(records.map(r => r.workId)).size,
      openConvergenceWaits: openWaits, openRollouts, blockedNow: dataset.blockedNow.length,
      sparse: records.length > 0 && records.length < 5, empty: records.length === 0 && dataset.requests.length === 0,
      complete: !dataset.recordsTruncated && !dataset.requestsTruncated,
    },
    exclusions, unavailable, blockedNow: dataset.blockedNow.slice(0, attributionLimits.items), metrics,
  };
}
export type AttributionReport = ReturnType<typeof computeAttribution>;

export const attributionDrilldownMetrics = ['targetMismatches', 'paidRunsAvoided', 'superseded', 'rescheduled', 'reanchors', 'blocked', 'convergenceWait', 'multiServiceConvergence', 'candidateToReleaseDrift', 'signatureRegenerations', 'immutablePreviewShare', 'unsupportedClaims', 'cost'] as const;
/**
 * The exact records behind an aggregate: work, release, validation request, attempt,
 * evidence and artifact identities per row. Identifiers beyond the work key require an
 * audit role; other readers still see the counts and the kind of each row.
 */
export function attributionDrilldown(dataset: AttributionDataset, request: { metric: string; key?: string | null; authorized?: boolean }) {
  const metric = request.metric, key = request.key ?? null, authorized = request.authorized === true;
  const columns = ['workKey', 'kind', 'recordedAt', 'environment', 'release', 'request', 'attempt', 'evidence', 'artifact', 'detail'] as const;
  const rows: Record<string, string | number | null>[] = [];
  const redact = (value: string | null | undefined) => authorized ? value ?? null : value ? 'requires audit role' : null;
  const row = (r: AttributionRecord, detail: string) => rows.push({ workKey: r.workKey, kind: r.kind, recordedAt: r.recordedAt, environment: r.environmentId,
    release: redact(r.details.release ? `${r.details.release.id} r${r.details.release.revision}` : r.details.manifestHash ? `manifest ${String(r.details.manifestHash).slice(0, 12)}` : null),
    request: redact(r.requestId), attempt: redact(r.attemptId), evidence: redact(r.details.evidenceId ?? null),
    artifact: redact(r.details.buildId ? `build ${r.details.buildId}` : r.details.observationIds?.length ? `observations ${r.details.observationIds.join(' ')}` : null), detail });
  const kinds: Record<string, AttributionKind[]> = {
    targetMismatches: ['target-mismatch', 'target-changed', 'attribution-undermined'], paidRunsAvoided: ['paid-run-avoided'], superseded: ['superseded'], rescheduled: ['rescheduled'],
    reanchors: ['rescheduled', 'reanchor-blocked'], blocked: ['reanchor-blocked'], convergenceWait: ['target-mismatch', 'target-checked'], multiServiceConvergence: ['target-checked', 'target-mismatch'],
    candidateToReleaseDrift: ['target-mismatch', 'target-changed'], signatureRegenerations: ['signature-regenerated'], unsupportedClaims: ['unsupported-claim-refused', 'target-changed', 'attribution-undermined'], cost: ['paid-run-avoided', 'target-changed', 'attribution-undermined', 'evidence-bound'],
  };
  if (metric === 'immutablePreviewShare') {
    for (const r of dataset.requests.filter(r => r.attribution?.environmentId && (!key || r.attribution.targetKind === key)))
      rows.push({ workKey: r.attribution!.workKey ?? r.workId, kind: r.attribution!.targetKind, recordedAt: r.createdAt, environment: r.attribution!.environmentId, release: redact(`manifest ${r.attribution!.manifestHash.slice(0, 12)}`), request: redact(r.id), attempt: redact(r.attempts.at(-1)?.id ?? null), evidence: null, artifact: null, detail: `${r.state}; ${r.attempts.length} attempt(s)` });
  } else if (kinds[metric]) {
    for (const r of dataset.records.filter(r => kinds[metric].includes(r.kind) && (!key || r.kind === key || r.details.state === key || (r.details.changed ?? []).includes(key))))
      row(r, metric === 'multiServiceConvergence' && r.kind === 'target-checked' && !r.details.partialConvergence && r.details.state !== 'matched' ? '' : String(r.details.reason ?? (r.details.reasons ?? []).join('; ') ?? r.details.state ?? ''));
    if (metric === 'multiServiceConvergence') { const kept = rows.filter(entry => entry.detail !== ''); rows.length = 0; rows.push(...kept); }
  } else return { metric, key, supported: attributionDrilldownMetrics, error: `Unknown drill-down metric; choose one of ${attributionDrilldownMetrics.join(', ')}`, columns, rows: [], total: 0, truncated: false, authorized };
  if (metric === 'blocked') for (const b of dataset.blockedNow) rows.push({ workKey: b.workKey, kind: 'blocked-now', recordedAt: b.since, environment: b.environmentId, release: null, request: redact(b.supersededRequestId), attempt: null, evidence: null, artifact: null, detail: b.reasons.join('; ') });
  const order = (value: Record<string, any>) => `${String(value.workKey).replace(/\d+/, match => match.padStart(8, '0'))}|${value.recordedAt ?? ''}|${value.kind}|${value.request ?? ''}|${value.detail}`;
  rows.sort((a, b) => order(a).localeCompare(order(b)));
  return { metric, key, supported: attributionDrilldownMetrics, columns, total: rows.length, truncated: rows.length > attributionLimits.drilldown, rows: rows.slice(0, attributionLimits.drilldown), authorized };
}
