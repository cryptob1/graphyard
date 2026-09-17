import { sign as signBytes } from 'node:crypto';
import { z } from 'zod';
import { boundaryUnchanged, executeAttempt, executionPlanSchema, preflightAttempt, type ExecutionRecord, type Runner, type Settler } from './runner-executor.js';
import { artifactKinds, attestationBytes, collectArtifacts, executionAttestationPayload, type ExecutionAttestation } from './runner-collector.js';

/**
 * What the host attestor accepts from the runner. Only the *plan* — where to run and
 * under which authority — crosses this boundary. No execution fact does: an interval,
 * an exit code, a measured digest or a container state supplied by the worker would be
 * exactly the fabrication a signature is supposed to exclude.
 */
export const supervisionRequestSchema = z.object({ plan: executionPlanSchema }).strict();
export type SupervisionRequest = z.infer<typeof supervisionRequestSchema>;
export type SupervisionResult = { record: ExecutionRecord; attestation: ExecutionAttestation; collection: { artifacts: { name: string; digest: string }[]; reasons: string[] } };

/**
 * Supervise one authorized attempt and attest what this process observed.
 *
 * The attestor, not the runner, starts the containers, measures the approved bytes
 * before and after, settles the containers and reads the output boundary. The record it
 * signs is the value its own `executeAttempt` call returned; nothing in the signed
 * payload is copied from the caller. A compromised runner can therefore still fabricate
 * an `ExecutionRecord` and a passing report, but it cannot obtain a signature over them,
 * and the collector publishes nothing without one.
 *
 * `ready` runs after preflight and before the first container starts. The runner
 * acknowledges the attempt there, so a preflight refusal leaves the attempt
 * unacknowledged and its protected reservations expire instead of being held.
 *
 * The attestor's private key is supplied by its own environment. It is never read from
 * the request, so a runner cannot choose which key signs its attempt.
 *
 * `callerUid` is the OS identity that asked for supervision, when the deployment makes it
 * knowable — `SUDO_UID` under the documented `sudo` rule. The container user must not be
 * that identity: the output boundary is private to the container user, so a runner
 * sharing it could replace the report between the last phase and the measurement below,
 * and the attestation would then cover bytes the container never wrote.
 */
export async function superviseAttempt(input: unknown, options: {
  privateKey: string; ready?: () => Promise<void>; signal?: AbortSignal; callerUid?: number;
  run?: Runner; settle?: Settler; now?: () => Date; uid?: number;
}): Promise<SupervisionResult> {
  const { plan } = supervisionRequestSchema.parse(input);
  if (options.callerUid !== undefined && Number(plan.runAsUser.split(':')[0]) === options.callerUid) {
    throw new Error('The runner container must run as a dedicated account, not as the identity that requested supervision');
  }
  const preflight = await preflightAttempt(plan, { uid: options.uid });
  await options.ready?.();
  const record = await executeAttempt(plan, { preflight, signal: options.signal, run: options.run, settle: options.settle, now: options.now, uid: options.uid });
  // Every kind the boundary may hold is measured, so the attestation does not depend on
  // how the separate collector happens to be configured. The collector publishes its own
  // required subset and each of those digests must match one measured here.
  const collected = await collectArtifacts(record.outputPath, Object.keys(artifactKinds));
  // Measuring by pathname is only meaningful while the pathname still leads to the
  // boundary preflight approved. Nothing is signed otherwise: an attestation over an
  // older attempt's output would be a valid signature on someone else's execution.
  if (!await boundaryUnchanged(preflight.outputPath, preflight.outputBoundary)) {
    throw new Error('The collection boundary was replaced before its bytes were measured; this attempt was not attested');
  }
  const artifacts = collected.artifacts.map(({ name, digest }) => ({ name, digest }));
  const payload = executionAttestationPayload({ grant: plan.grant, execution: record, artifacts });
  return { record, attestation: { payload, signature: signBytes(null, attestationBytes(payload), options.privateKey).toString('base64') },
    collection: { artifacts, reasons: collected.reasons } };
}
