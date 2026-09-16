import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { runnerReport, verifyRunnerReport } from './runner-report.js';
import { attemptGrantSchema, executionRecordSchema, type AttemptGrant, type ExecutionRecord } from './runner-executor.js';

const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/).max(150);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const hash = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const serviceArtifacts = z.array(z.object({ service: name, digest }).strict()).max(30);
const order = <T extends { service: string }>(a: T[]) => [...a].sort((x, y) => x.service.localeCompare(y.service));

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
 */
export function attributeExecution(input: {
  expected: { instance: string; artifacts: { service: string; digest: string }[] };
  observations: unknown; startedAt: string; finishedAt: string; maxGapMs: number;
}) {
  const expected = z.object({ instance: name, artifacts: serviceArtifacts.min(1) }).strict().parse(input.expected);
  const maxGapMs = z.number().int().min(1_000).max(600_000).parse(input.maxGapMs);
  const startedAt = Date.parse(z.iso.datetime().parse(input.startedAt)), finishedAt = Date.parse(z.iso.datetime().parse(input.finishedAt));
  const observations = z.array(targetObservationSchema).max(5_000).parse(input.observations)
    .map(o => ({ ...o, time: Date.parse(o.at) })).sort((a, b) => a.time - b.time);
  const reasons: string[] = [];
  if (finishedAt < startedAt) throw new Error('Execution interval ends before it starts');
  const wanted = JSON.stringify(order(expected.artifacts));
  const matches = observations.map(o => o.instance === expected.instance && JSON.stringify(order(o.artifacts)) === wanted);
  const measurement: Measurement = observations.some(o => o.measurement === 'unknown') || !observations.length ? 'unknown'
    : observations.every(o => o.measurement === 'provider') ? 'provider' : 'host-attestation';
  const brackets = observations.length >= 2 && observations[0].time <= startedAt && observations.at(-1)!.time >= finishedAt;
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
    try { bytes = await readPrivateFile(root, kind.file, 8_388_608); } catch { reasons.push(`Required artifact ${required} is missing or unreadable at the execution boundary`); continue; }
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
  grant: unknown; execution: unknown;
  expected: { instance: string; artifacts: { service: string; digest: string }[] };
  observations: unknown; maxGapMs: number;
  collected: { artifacts: { name: string; digest: string; document: unknown }[]; reasons: string[] };
  uploaded: { name: string; digest: string; url: string }[];
  requiredArtifacts: string[];
  cancelled?: boolean;
}): CollectorResult {
  const grant: AttemptGrant = attemptGrantSchema.parse(input.grant);
  const execution: ExecutionRecord = executionRecordSchema.parse(input.execution);
  const refusals: string[] = [];
  if (!isDeepStrictEqual(grant, execution.grant)) return { report: null, refusals: ['The execution record does not hold the authority the collector independently re-read'] };
  // The runner's own refusals are recorded, but the collector re-derives the boundary
  // facts from the grant it read itself rather than trusting the record's conclusions.
  const boundary: string[] = [];
  if (execution.bundleDigestBefore !== grant.bundleDigest || execution.bundleDigestAfter !== grant.bundleDigest) boundary.push('Oracle bundle bytes measured at the execution boundary differ from the approved digest');
  if (execution.runnerImageDigest !== grant.runnerImageDigest) boundary.push('The executed runner image differs from the approved digest');
  if (!isDeepStrictEqual(execution.phases.map(p => p.phase), ['enumerate', 'execute'])) boundary.push('The attempt did not complete offline inventory enumeration followed by execution');
  refusals.push(...execution.refusals, ...boundary, ...input.collected.reasons);

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
  const blocked = execution.refusals.length > 0 || boundary.length > 0 || execution.outcome !== 'completed' || input.collected.reasons.length > 0;
  const behavior = blocked ? 'blocked' as const : !verified ? 'unmeasured' as const : verified.passed ? 'passed' as const : 'failed' as const;

  return {
    report: {
      requestId: grant.requestId, attemptId: grant.attemptId, epoch: grant.epoch,
      execution: executionState, behavior,
      executed: verified?.executed ?? 0, skipped: verified?.skipped ?? 0, inventoryComplete: verified?.inventoryComplete ?? false,
      target: attribution.target,
      bundleDigest: execution.bundleDigestAfter, runnerImageDigest: execution.runnerImageDigest,
      artifacts: required.filter(n => uploadedByName.has(n)).map(n => ({ name: n, digest: uploadedByName.get(n)!.digest, url: uploadedByName.get(n)!.url })),
      artifactState, executionSettled: execution.settlement.settled,
    },
    refusals,
  };
}
