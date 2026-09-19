import { sign as signBytes, verify as verifySignature } from 'node:crypto';
import { z } from 'zod';
import { boundaryUnchanged, executeAttempt, executionPlanSchema, preflightAttempt, type AttestorIdentity, type ExecutionRecord, type Runner, type Settler } from './runner-executor.js';
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
 * The bytes a signing probe covers. They say what the probe is for and carry no attempt
 * fact, so a signature over them can never be replayed as an attestation: `attestationBytes`
 * covers a JSON payload, which this is not.
 */
const signingProbe = Buffer.from('graphyard-attestor-signing-probe');
/**
 * Establish, before anything is acknowledged, that this process can actually produce the
 * signature the collector will require.
 *
 * The private key is otherwise first used after both containers have run. A malformed,
 * encrypted, wrong-type or simply unrelated key would then be discovered at the end of an
 * attempt that had already been acknowledged and had already exercised the target, leaving
 * an acknowledged attempt whose reservations only an operator can release and whose
 * execution can never be attested. Signing a probe and verifying it against the public key
 * this attempt authority pins establishes both usability and correspondence while a refusal
 * still costs nothing: the attempt stays unacknowledged and expires.
 */
export function assertAttestationKeyCorresponds(privateKey: string, attestationPublicKey: string) {
  let probe: Buffer;
  try { probe = signBytes(null, signingProbe, privateKey); }
  catch { throw new Error('The host attestor private key cannot produce an Ed25519 signature; no attempt was acknowledged'); }
  let corresponds = false;
  try { corresponds = verifySignature(null, signingProbe, attestationPublicKey, probe); } catch { corresponds = false; }
  if (!corresponds) throw new Error('The host attestor private key does not correspond to the attestation public key this attempt authority pins; no attempt was acknowledged');
}

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
 * knowable — `SUDO_UID` under the documented `sudo` rule. The container user must share
 * neither that identity nor this attestor process's effective UID: the attempt boundary
 * is writable by the container user, so either overlap collapses the three-party boundary
 * and lets execution-capable code replace bytes that will later be signed. The runner
 * account must likewise not be a member of the boundary group, which is a deployment
 * rule this process cannot check for another account.
 *
 * Preflight provisions this attempt's own boundary under the configured collection root
 * and refuses unless this process can read through the boundary group, so the bytes
 * measured below are reachable before any container is started.
 */
export async function superviseAttempt(input: unknown, options: AttestorIdentity & {
  privateKey: string; ready?: () => Promise<void>; signal?: AbortSignal; callerUid?: number;
  run?: Runner; settle?: Settler; now?: () => Date;
}): Promise<SupervisionResult> {
  const { plan } = supervisionRequestSchema.parse(input);
  const containerUid = Number(plan.runAsUser.split(':')[0]);
  const attestorUid = options.uid ?? process.getuid?.() ?? 0;
  if (containerUid === attestorUid) {
    throw new Error('The runner container must run as a dedicated account, not as the supervising attestor identity');
  }
  if (options.callerUid !== undefined && containerUid === options.callerUid) {
    throw new Error('The runner container must run as a dedicated account, not as the identity that requested supervision');
  }
  // Before the boundary is provisioned, and well before the ACK: a key that cannot sign
  // what this attempt's authority pins is a local refusal, not a failed execution.
  assertAttestationKeyCorresponds(options.privateKey, plan.grant.attestationPublicKey);
  const preflight = await preflightAttempt(plan, { uid: options.uid, gids: options.gids });
  await options.ready?.();
  const record = await executeAttempt(plan, { preflight, signal: options.signal, run: options.run, settle: options.settle, now: options.now, uid: options.uid, gids: options.gids });
  // Every kind the boundary may hold is measured, so the attestation does not depend on
  // how the separate collector happens to be configured. The collector publishes its own
  // required subset and each of those digests must match one measured here.
  const collected = await collectArtifacts(record.outputPath, Object.keys(artifactKinds), plan.grant.reportFormat);
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
