import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import { createHash, verify as verifySignature } from 'node:crypto';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { runnerReport, verifyRunnerReport } from './runner-report.js';
import { attemptGrantSchema, containerNames, executionRecordSchema, type AttemptGrant, type ContainerState, type ExecutionRecord } from './runner-executor.js';

const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/).max(150);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const hash = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const serviceArtifacts = z.array(z.object({ service: name, digest }).strict()).max(30);
const order = <T extends { service: string }>(a: T[]) => [...a].sort((x, y) => x.service.localeCompare(y.service));

/**
 * The conclusions `assembleResult` acts on. They are signed with the rest of the payload,
 * so a worker cannot obtain a valid attestation and then turn `timed_out` into
 * `completed`, drop the runner's refusals, or replace measured digests with the approved
 * ones: the record would no longer match what the host attested.
 */
const conclusionsSchema = z.object({
  outcome: executionRecordSchema.shape.outcome, refusals: executionRecordSchema.shape.refusals, phases: executionRecordSchema.shape.phases,
  bundleDigestBefore: digest, bundleDigestAfter: digest, runnerImageDigest: digest,
}).strict();
type Conclusions = z.infer<typeof conclusionsSchema>;
const conclusions = (source: Conclusions): Conclusions => ({ outcome: source.outcome, refusals: source.refusals, phases: source.phases,
  bundleDigestBefore: source.bundleDigestBefore, bundleDigestAfter: source.bundleDigestAfter, runnerImageDigest: source.runnerImageDigest });
const executionAttestationPayloadSchema = z.object({
  requestId: z.uuid(), attemptId: z.uuid(), epoch: z.number().int().positive(),
  executionHost: z.string().min(1).max(500), outputPath: z.string().min(1).max(4096),
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(),
  ...conclusionsSchema.shape,
  artifacts: z.array(z.object({ name, digest }).strict()).max(30),
  containers: z.array(z.object({ name: z.string().min(1).max(200), state: z.enum(['absent', 'present', 'unknown']) }).strict()).max(8),
}).strict();
export const executionAttestationSchema = z.object({ payload: executionAttestationPayloadSchema, signature: z.string().min(1).max(4096) }).strict();
export type ExecutionAttestation = z.infer<typeof executionAttestationSchema>;
export type ExecutionAttestationPayload = z.infer<typeof executionAttestationPayloadSchema>;
export const attestationBytes = (payload: ExecutionAttestationPayload) => Buffer.from(JSON.stringify(payload));
/**
 * The bytes an attestor signs. This only shapes an observation into a payload; there is
 * deliberately no exported function that signs a *submitted* execution record, because a
 * signature over worker-supplied facts authenticates nothing. `superviseAttempt` in
 * `runner-attestor.ts` is the only producer of an attestation, and it passes the record
 * its own `executeAttempt` call returned.
 */
export function executionAttestationPayload(input: { grant: AttemptGrant; execution: ExecutionRecord; artifacts: { name: string; digest: string }[] }): ExecutionAttestationPayload {
  const { grant, execution } = input;
  return executionAttestationPayloadSchema.parse({ requestId: grant.requestId, attemptId: grant.attemptId, epoch: grant.epoch,
    executionHost: grant.executionHost, outputPath: execution.outputPath, startedAt: execution.startedAt, finishedAt: execution.finishedAt,
    ...conclusions(execution),
    artifacts: input.artifacts.map(({ name, digest }) => ({ name, digest })).sort((a, b) => a.name.localeCompare(b.name)),
    containers: [...execution.settlement.containers].sort((a, b) => a.name.localeCompare(b.name)) });
}

/** Verify facts signed by the operator-controlled host attestor. The worker can write its
 * output directory, but it cannot turn those bytes into trusted evidence without this
 * signature from the pinned execution authority. */
export function verifyExecutionAttestation(grantInput: unknown, executionInput: unknown, collected: { artifacts: { name: string; digest: string }[] }, input: unknown) {
  const grant = attemptGrantSchema.parse(grantInput), execution = executionRecordSchema.parse(executionInput);
  const attestation = executionAttestationSchema.parse(input), p = attestation.payload;
  const reasons: string[] = [];
  if (p.requestId !== grant.requestId || p.attemptId !== grant.attemptId || p.epoch !== grant.epoch) reasons.push('Host attestation is not bound to this attempt authority');
  if (p.executionHost !== grant.executionHost) reasons.push('Host attestation did not come from the execution host pinned by the runner registration');
  if (resolve(p.outputPath) !== execution.outputPath || p.startedAt !== execution.startedAt || p.finishedAt !== execution.finishedAt) reasons.push('Host attestation is not bound to this execution interval and output boundary');
  if (!isDeepStrictEqual(conclusions(p), conclusions(execution))) reasons.push('Host attestation does not bind the execution outcome, refusals, phase results and measured digests this record claims');
  // The attestor measures every artifact kind the boundary held; this collector may be
  // configured to publish a subset. Every byte it does publish must be one the attestor
  // saw, with the same digest, so a file rewritten after attestation cannot be uploaded.
  const attested = new Map(p.artifacts.map(a => [a.name, a.digest]));
  if (collected.artifacts.some(a => attested.get(a.name) !== a.digest)) reasons.push('Collected artifact bytes differ from the host-attested boundary');
  if (!isDeepStrictEqual([...p.containers].sort((a, b) => a.name.localeCompare(b.name)), [...execution.settlement.containers].sort((a, b) => a.name.localeCompare(b.name)))) reasons.push('Host attestation does not bind the execution container set');
  let valid = false;
  try { valid = verifySignature(null, attestationBytes(p), grant.attestationPublicKey, Buffer.from(attestation.signature, 'base64')); } catch { /* invalid key/signature */ }
  if (!valid) reasons.push('Execution boundary attestation signature is invalid');
  return { attestation, reasons };
}

export type Attribution = 'matched' | 'mismatched' | 'changed' | 'unknown';
export type Measurement = 'provider' | 'host-attestation' | 'unknown';
/** One independent measurement of which bytes a concrete instance was running at a moment. */
export const targetObservationSchema = z.object({
  at: z.iso.datetime(), measurement: z.enum(['provider', 'host-attestation', 'unknown']),
  instance: name, artifacts: serviceArtifacts,
}).strict();
export type TargetObservation = z.infer<typeof targetObservationSchema>;
/**
 * A version endpoint, header or build label served by the application under test is
 * candidate-controlled. Record it as a diagnostic with `unknown` measurement; it can
 * never raise attribution above `unknown`.
 */
export const selfReportedObservation = (at: string, instance: string): TargetObservation => ({ at, instance, artifacts: [], measurement: 'unknown' });

/**
 * Attribute an execution interval to an artifact identity. Boundary probes alone are
 * explicitly insufficient: coverage requires measurements that bracket the whole run
 * with no gap longer than `maxGapMs`, so an A -> B -> A rollout inside the interval is
 * either observed (`changed`) or left as uncovered `unknown`. Both refuse acceptance.
 *
 * Only the execution interval is judged. A provider history commonly reaches further
 * back and further forward than the run; the nearest measurement at or before the start
 * and the nearest at or after the finish are its boundaries, and anything outside them
 * is neither coverage nor evidence of a change during this attempt.
 */
export function attributeExecution(input: {
  expected: { instance: string; artifacts: { service: string; digest: string }[] };
  observations: unknown; startedAt: string; finishedAt: string; maxGapMs: number;
}) {
  const expected = z.object({ instance: name, artifacts: serviceArtifacts.min(1) }).strict().parse(input.expected);
  const maxGapMs = z.number().int().min(1_000).max(600_000).parse(input.maxGapMs);
  const startedAt = Date.parse(z.iso.datetime().parse(input.startedAt)), finishedAt = Date.parse(z.iso.datetime().parse(input.finishedAt));
  const supplied = z.array(targetObservationSchema).max(5_000).parse(input.observations)
    .map(o => ({ ...o, time: Date.parse(o.at) })).sort((a, b) => a.time - b.time);
  const reasons: string[] = [];
  if (finishedAt < startedAt) throw new Error('Execution interval ends before it starts');
  const opening = supplied.filter(o => o.time <= startedAt).at(-1);
  // A zero-length interval cannot be bracketed by one measurement counted twice.
  const closing = supplied.find(o => o.time >= finishedAt && o !== opening);
  const observations = [...(opening ? [opening] : []), ...supplied.filter(o => o.time > startedAt && o.time < finishedAt), ...(closing ? [closing] : [])];
  const wanted = JSON.stringify(order(expected.artifacts));
  const matches = observations.map(o => o.instance === expected.instance && JSON.stringify(order(o.artifacts)) === wanted);
  const measurement: Measurement = observations.some(o => o.measurement === 'unknown') || !observations.length ? 'unknown'
    : observations.every(o => o.measurement === 'provider') ? 'provider' : 'host-attestation';
  const brackets = !!opening && !!closing;
  const gap = observations.findIndex((o, i) => i > 0 && o.time - observations[i - 1].time > maxGapMs);
  const coversEntireRun = brackets && gap === -1 && measurement !== 'unknown';
  if (observations.length < 2) reasons.push('Attribution needs independent measurements before and after the execution interval');
  else if (!brackets) reasons.push('Independent measurements do not bracket the whole execution interval');
  if (gap !== -1) reasons.push(`Independent measurement gap exceeds ${maxGapMs}ms; the interval is not continuously covered`);
  if (measurement === 'unknown') reasons.push('Runtime artifact identity was not independently measured; application self-reports do not count');
  const attribution: Attribution = measurement === 'unknown' || !coversEntireRun ? 'unknown'
    : matches.every(Boolean) ? 'matched' : !matches.at(-1) ? 'mismatched' : 'changed';
  if (attribution === 'changed') reasons.push('The target ran different artifacts during the execution interval');
  if (attribution === 'mismatched') reasons.push('The target did not run the expected artifact identity');
  const observed = observations.at(-1);
  return { attribution, coversEntireRun, measurement, reasons,
    boundary: { before: observations[0] ?? null, after: observed ?? null },
    target: { instance: observed?.instance ?? expected.instance, artifacts: observed?.artifacts.length ? order(observed.artifacts) : order(expected.artifacts), measurement, coversEntireRun, attribution } };
}

/**
 * Artifact kinds this collector can capture within the configured protection policy.
 * Rich Playwright captures (traces, screenshots, videos) can embed credentials and
 * customer data; until redaction for them is implemented and tested they are refused
 * rather than uploaded, and a candidate that requires one cannot be accepted.
 */
export const artifactKinds: Record<string, { file: string; mediaType: 'application/json' }> = {
  inventory: { file: 'inventory.json', mediaType: 'application/json' },
  report: { file: 'report.json', mediaType: 'application/json' },
};
/**
 * Which artifacts a collector must read, given the names it is configured to publish.
 * Verification always needs every approved kind the boundary holds: an execution report
 * means nothing without the inventory enumerated offline, and a kind left unread would
 * additionally look like output the approved reporter never wrote. `requiredArtifacts`
 * is an upload configuration, so it decides what is published, not what is verified. An
 * unsupported name stays in the list, so it still refuses explicitly instead of silently
 * dropping out of the boundary check.
 */
export const collectionInputs = (required: string[]) =>
  [...new Set([...Object.keys(artifactKinds), ...z.array(name).min(1).max(30).parse(required)])].sort();

async function readPrivateFile(root: string, file: string, limit: number) {
  const handle = await open(resolve(root, file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Collected artifacts must be regular files');
    if (info.size === 0 || info.size > limit) throw new Error('Collected artifact is empty or exceeds the supported size');
    const bytes = Buffer.alloc(info.size);
    let count = 0;
    while (count < bytes.length) { const read = await handle.read(bytes, count, bytes.length - count, count); if (!read.bytesRead) throw new Error('Collected artifact changed during collection'); count += read.bytesRead; }
    return bytes;
  } finally { await handle.close(); }
}
/**
 * Read the attempt's output boundary. Only the approved reporter's structure is accepted,
 * so arbitrary candidate-authored JSON is not proof that a command ran. Missing or
 * unprotectable required artifacts refuse collection instead of uploading unsafe evidence.
 */
export async function collectArtifacts(outputDirectory: string, required: string[]) {
  const names = z.array(name).min(1).max(30).parse(required);
  const root = await realpath(outputDirectory);
  const artifacts: { name: string; mediaType: 'application/json'; digest: string; bytes: Buffer; document: unknown }[] = [];
  const reasons: string[] = [];
  for (const required of [...new Set(names)].sort()) {
    const kind = artifactKinds[required];
    if (!kind) { reasons.push(`Artifact ${required} has no collector implementation meeting the capture policy; disable it rather than uploading unprotected evidence`); continue; }
    let bytes: Buffer;
    // The container writes as its own identity, so the trusted readers reach its output
    // through the boundary group. A permission failure is reported as exactly that: it is
    // a deployment fault to fix, not a missing artifact or a candidate behaviour signal.
    try { bytes = await readPrivateFile(root, kind.file, 8_388_608); }
    catch (error: any) {
      reasons.push(error?.code === 'EACCES'
        ? `Required artifact ${required} is not readable by this trusted identity; the runner container must write it readable to the boundary group (a default ACL on the collection root, or a umask no stricter than 027)`
        : `Required artifact ${required} is missing or unreadable at the execution boundary`);
      continue;
    }
    let document: unknown;
    try { document = runnerReport.parse(JSON.parse(bytes.toString('utf8'))); }
    catch { reasons.push(`Required artifact ${required} is not an approved data-minimised report`); continue; }
    artifacts.push({ name: required, mediaType: kind.mediaType, digest: hash(bytes), bytes, document });
  }
  const expectedFiles = new Set([...new Set(names)].filter(n => artifactKinds[n]).map(n => artifactKinds[n].file));
  const unexpected = (await readdir(root)).filter(entry => !expectedFiles.has(entry));
  if (unexpected.length) reasons.push('The collection boundary contains output the approved reporter did not write');
  return { artifacts, reasons, complete: reasons.length === 0 && artifacts.length === new Set(names).size };
}

/**
 * The authority the collector re-read, the record it was handed and the directory it is
 * about to read must describe one attempt. A record copied from an older successful
 * attempt, or a configuration pointing at that attempt's leftover output, is refused
 * here — before anything is read or published — rather than being uploaded as this
 * attempt's behaviour.
 */
export function collectionBinding(input: { grant: unknown; execution: unknown; collectedFrom: string }) {
  const grant: AttemptGrant = attemptGrantSchema.parse(input.grant);
  const execution: ExecutionRecord = executionRecordSchema.parse(input.execution);
  const collectedFrom = z.string().min(1).max(4096).parse(input.collectedFrom);
  const reasons: string[] = [];
  if (!isDeepStrictEqual(grant, execution.grant)) reasons.push('The execution record does not hold the authority the collector independently re-read');
  if (resolve(collectedFrom) !== execution.outputPath) reasons.push('The collected directory is not the output boundary this execution recorded');
  return { grant, execution, reasons };
}

/**
 * Settlement the collector observed itself. The record's own `settled` boolean is a
 * worker assertion and can never release a protected resource: the collector names the
 * containers this attempt was allowed to start, from the grant, and only its own
 * `absent` observation of every one of them settles the attempt.
 */
export function deriveSettlement(attemptId: string, observations: unknown) {
  const observed = z.array(z.object({ name: z.string().min(1).max(200), state: z.enum(['absent', 'present', 'unknown']) }).strict()).max(8).parse(observations);
  const expected = containerNames(attemptId);
  const state = new Map<string, ContainerState>(observed.map(o => [o.name, o.state]));
  const settled = expected.every(name => state.get(name) === 'absent') && observed.every(o => expected.includes(o.name));
  return { settled, expected, observed };
}

/** Exactly what `runner collect` reads from its configuration file. The authority itself
 * is re-read from the control plane; this is the collector's own local wiring. */
export const collectorInputSchema = z.object({
  grant: attemptGrantSchema, record: executionRecordSchema, outputPath: z.string(), requiredArtifacts: z.array(z.string()).min(1).max(30),
  expected: z.object({ instance: z.string(), artifacts: z.array(z.object({ service: z.string(), digest: z.string() }).strict()).min(1) }).strict(),
  observations: z.array(targetObservationSchema).max(5_000), maxGapMs: z.number().int().min(1_000).max(600_000).default(30_000), cancelled: z.boolean().default(false),
  executionAttestation: z.unknown(),
}).strict();

export type ArtifactState = 'verified' | 'missing' | 'upload-failed' | 'expired';
export type CollectorResult = {
  report: {
    requestId: string; attemptId: string; epoch: number;
    execution: 'completed' | 'cancelled' | 'timed_out'; behavior: 'passed' | 'failed' | 'blocked' | 'unmeasured';
    executed: number; skipped: number; inventoryComplete: boolean;
    target: { instance: string; artifacts: { service: string; digest: string }[]; measurement: Measurement; coversEntireRun: boolean; attribution: Attribution };
    bundleDigest: string; runnerImageDigest: string;
    artifacts: { name: string; digest: string; url: string }[];
    artifactState: ArtifactState; executionSettled: boolean;
  } | null;
  refusals: string[];
};

/**
 * Turn one attempt's independently gathered facts into the result a trusted collector may
 * publish. Nothing here comes from the candidate: the authority is the collector's own
 * re-read of the dispatch grant, the bytes are the ones measured at the execution
 * boundary, and the target identity comes from independent measurement. A binding
 * mismatch yields no report at all, so a stray attempt cannot advance any work.
 */
export function assembleResult(input: {
  grant: unknown; execution: unknown; collectedFrom: string;
  expected: { instance: string; artifacts: { service: string; digest: string }[] };
  observations: unknown; maxGapMs: number;
  collected: { artifacts: { name: string; digest: string; document: unknown }[]; reasons: string[] };
  uploaded: { name: string; digest: string; url: string }[];
  settlementObservations: unknown;
  executionAttestation: unknown;
  requiredArtifacts: string[];
  cancelled?: boolean;
}): CollectorResult {
  const binding = collectionBinding({ grant: input.grant, execution: input.execution, collectedFrom: input.collectedFrom });
  const grant: AttemptGrant = binding.grant, execution: ExecutionRecord = binding.execution;
  const refusals: string[] = [];
  if (binding.reasons.length) return { report: null, refusals: binding.reasons };
  const attested = verifyExecutionAttestation(grant, execution, input.collected, input.executionAttestation);
  // The runner's own refusals are recorded, but the collector re-derives the boundary
  // facts from the grant it read itself rather than trusting the record's conclusions.
  const boundary: string[] = [];
  if (execution.bundleDigestBefore !== grant.bundleDigest || execution.bundleDigestAfter !== grant.bundleDigest) boundary.push('Oracle bundle bytes measured at the execution boundary differ from the approved digest');
  if (execution.runnerImageDigest !== grant.runnerImageDigest) boundary.push('The executed runner image differs from the approved digest');
  if (!isDeepStrictEqual(execution.phases.map(p => p.phase), ['enumerate', 'execute'])) boundary.push('The attempt did not complete offline inventory enumeration followed by execution');
  const settlement = deriveSettlement(grant.attemptId, input.settlementObservations);
  if (!isDeepStrictEqual([...execution.settlement.containers].map(c => c.name).sort(), [...settlement.expected].sort())) boundary.push('The execution record does not account for exactly the containers this attempt was allowed to start');
  if (!settlement.settled) boundary.push('The collector did not independently observe every container of this attempt removed; the execution-resource barrier stays closed');
  refusals.push(...execution.refusals, ...boundary, ...attested.reasons, ...input.collected.reasons);

  const attribution = attributeExecution({ expected: input.expected, observations: input.observations, startedAt: execution.startedAt, finishedAt: execution.finishedAt, maxGapMs: input.maxGapMs });
  refusals.push(...attribution.reasons);

  const inventory = input.collected.artifacts.find(a => a.name === 'inventory')?.document;
  const report = input.collected.artifacts.find(a => a.name === 'report')?.document;
  let verified: ReturnType<typeof verifyRunnerReport> | null = null;
  if (inventory !== undefined && report !== undefined) {
    try { verified = verifyRunnerReport(inventory, report); } catch { refusals.push('The approved reporter output could not be verified against the enumerated inventory'); }
  } else refusals.push('The enumerated inventory or its execution report was not collected');
  if (verified) refusals.push(...verified.reasons);

  const required = [...new Set(z.array(name).min(1).max(30).parse(input.requiredArtifacts))].sort();
  const collectedNames = new Set(input.collected.artifacts.map(a => a.name));
  const uploadedByName = new Map(input.uploaded.map(a => [a.name, a]));
  const artifactState: ArtifactState = required.some(n => !collectedNames.has(n)) ? 'missing'
    : required.some(n => uploadedByName.get(n)?.digest !== input.collected.artifacts.find(a => a.name === n)!.digest) ? 'upload-failed' : 'verified';
  if (artifactState !== 'verified') refusals.push(`Required execution artifacts are ${artifactState === 'missing' ? 'missing at the execution boundary' : 'not durably stored with the collected digest'}`);

  const executionState: 'completed' | 'cancelled' | 'timed_out' = input.cancelled ? 'cancelled' : execution.outcome === 'timed_out' ? 'timed_out' : 'completed';
  // Infrastructure problems are never reported as a product failure, and never as a pass.
  const blocked = execution.refusals.length > 0 || boundary.length > 0 || attested.reasons.length > 0 || execution.outcome !== 'completed' || input.collected.reasons.length > 0;
  const behavior = blocked ? 'blocked' as const : !verified ? 'unmeasured' as const : verified.passed ? 'passed' as const : 'failed' as const;

  return {
    report: {
      requestId: grant.requestId, attemptId: grant.attemptId, epoch: grant.epoch,
      execution: executionState, behavior,
      executed: verified?.executed ?? 0, skipped: verified?.skipped ?? 0, inventoryComplete: verified?.inventoryComplete ?? false,
      target: attribution.target,
      bundleDigest: execution.bundleDigestAfter, runnerImageDigest: execution.runnerImageDigest,
      artifacts: required.filter(n => uploadedByName.has(n)).map(n => ({ name: n, digest: uploadedByName.get(n)!.digest, url: uploadedByName.get(n)!.url })),
      // Derived from the collector's own observation. Releasing a protected resource is
      // never a worker assertion, so the record's boolean cannot reach the control plane.
      artifactState, executionSettled: settlement.settled,
    },
    refusals,
  };
}
