import { z } from 'zod';
import type { Principal } from './work.js';
import type { Evidence } from './evidence.js';
import { demand } from './refusal.js';

/**
 * CI-produced evidence. A GitHub Actions job run from the protected acceptance workflow executes
 * a registered contract against the exact candidate head and publishes the result through one
 * dedicated producer principal. That principal is a trust boundary of its own: its evidence is
 * accepted only for the automatable proof families, only with the job it came from named, and
 * only for this repository. Since GY-2010 the control plane reads nothing back from GitHub: the
 * principal is the trust boundary, and its run binding is recorded as Graphyard's own record of
 * the job (`boundCiRun`). Manual proofs and the post-deployment smoke proof never travel this
 * lane, whatever the principal's grants say.
 */
export const ciProducerRuntime = 'github-actions';
export const ciProofFamilies = ['unit', 'integration'] as const;
/** GitHub Actions' own App: the identity every workflow job's check run is published under. */
export const githubActionsAppId = 15368;
/** The events whose workflow definition is taken from the protected default branch, never from the candidate. */
export const ciRunEvents = ['pull_request_target', 'workflow_dispatch'] as const;

/** The CI producer is the producer principal whose runtime is GitHub Actions; deployment configuration names it, never a request. */
export const isCiProducer = (actor: Principal) => actor.role === 'producer' && actor.runtime === ciProducerRuntime;
/** The CI producer publishes CI evidence and nothing else: no validation lane, no deployment observation, no revocation. */
export function refuseCiProducer(actor: Principal, action: string) {
  demand(!isCiProducer(actor), `The CI producer publishes CI-produced evidence only; ${action} is not one of its capabilities`, 403);
}
export const proofFamily = (proof: string) => proof.slice(0, Math.max(0, proof.indexOf(':')));
export const ciFamilyAllows = (proof: string) => (ciProofFamilies as readonly string[]).includes(proofFamily(proof));
/** The grant patterns the CI producer may hold: whole families or names inside them, never manual:* or e2e:*. */
export const ciPatternAllowed = (pattern: string) => ciFamilyAllows(pattern);

const runId = z.string().regex(/^[1-9]\d*$/);
/** What the reporter names: the workflow job that produced the evidence. */
export const ciRunBindingSchema = z.object({
  provider: z.literal('github-actions'), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  runId, runAttempt: z.number().int().positive(), jobId: z.number().int().positive(),
}).strict();
export type CiRunBinding = z.infer<typeof ciRunBindingSchema>;

/** The job a CI binding names, as the control plane records it from the CI producer's own binding (`boundCiRun`). */
export interface CiRunObservation {
  repository: string; jobId: number; headSha: string; appId: number | null; detailsUrl: string | null;
  status: string | null; conclusion: string | null; name: string | null; observedAt: string;
}
/** The verified binding stored on the evidence record. */
export interface CiRun extends CiRunBinding { headSha: string; job: string | null; conclusion: string; verifiedAt: string }

/** A GitHub check-run document reduced to the fields trust is decided on (pull-request-era records). */
export function observeCiCheckRun(repository: string, checkRun: any, now = new Date()): CiRunObservation {
  return {
    repository, jobId: Number(checkRun?.id), headSha: String(checkRun?.head_sha ?? ''),
    appId: Number.isSafeInteger(checkRun?.app?.id) ? checkRun.app.id : null, detailsUrl: typeof checkRun?.details_url === 'string' ? checkRun.details_url : null,
    status: checkRun?.status ?? null, conclusion: checkRun?.conclusion ?? null, name: typeof checkRun?.name === 'string' ? checkRun.name : null, observedAt: now.toISOString(),
  };
}

/**
 * The CI producer's binding recorded as Graphyard's own record of its job (GY-2010): the job ran
 * the evidence's proof on the evidence commit and concluded as its result says. Nothing is read
 * from GitHub; the principal, its grants and the families are the trust boundary.
 */
export function boundCiRun(binding: CiRunBinding, evidence: { proof: string; sha: string; result: 'pass' | 'fail' }, now = new Date()): CiRunObservation {
  return {
    repository: binding.repository, jobId: binding.jobId, headSha: evidence.sha, appId: githubActionsAppId,
    detailsUrl: `https://github.com/${binding.repository}/actions/runs/${binding.runId}/job/${binding.jobId}`,
    status: 'completed', conclusion: evidence.result === 'pass' ? 'success' : 'failure', name: evidence.proof, observedAt: now.toISOString(),
  };
}

/**
 * Why a CI binding does not certify this evidence, or null. The job must be the one named, be
 * GitHub Actions' own check run on the evidence commit for this repository, belong to the named
 * workflow run, have completed, and have concluded as the result claims: a pass is accepted only
 * from a job that succeeded, so a report rewritten after the harness judged it cannot be published.
 */
export function ciRunRefusal(binding: CiRunBinding, observed: CiRunObservation | null | undefined, evidence: { sha: string; result: 'pass' | 'fail' }, repository: string, ciAppIds: readonly number[] = [githubActionsAppId]): string | null {
  if (!observed) return 'The CI job could not be read from the evidence; CI evidence must name the workflow job that produced it';
  if (!repository || binding.repository.toLowerCase() !== repository.toLowerCase() || observed.repository.toLowerCase() !== repository.toLowerCase()) return `CI evidence names repository ${binding.repository}; this control plane coordinates ${repository || 'no repository'}`;
  if (observed.jobId !== binding.jobId) return `GitHub reported job ${observed.jobId}, not the job ${binding.jobId} the evidence names`;
  if (observed.appId === null || !ciAppIds.includes(observed.appId)) return `Job ${binding.jobId} was not published by GitHub Actions (App ${observed.appId ?? 'unknown'})`;
  const run = observed.detailsUrl?.match(/\/actions\/runs\/(\d+)(?:\/|$)/)?.[1] ?? null;
  if (run !== binding.runId) return `Job ${binding.jobId} belongs to workflow run ${run ?? 'unknown'}, not run ${binding.runId}`;
  if (observed.headSha !== evidence.sha) return `Workflow run ${binding.runId} job ${binding.jobId} ran on ${observed.headSha || 'an unknown commit'}, not on the evidence commit ${evidence.sha}`;
  if (observed.status !== 'completed') return `Job ${binding.jobId} has not completed (${observed.status ?? 'unknown'})`;
  if ((evidence.result === 'pass') !== (observed.conclusion === 'success')) return `Job ${binding.jobId} concluded ${observed.conclusion ?? 'unknown'}; a ${evidence.result} result cannot be published from it`;
  return null;
}

/** Orders two run attempts: a later run, or a later attempt of the same run, is newer. */
export function compareCiAttempts(a: { runId: string; runAttempt: number }, b: { runId: string; runAttempt: number }): number {
  const runs = BigInt(a.runId) - BigInt(b.runId);
  return runs === 0n ? a.runAttempt - b.runAttempt : runs < 0n ? -1 : 1;
}

/**
 * A re-run of an older attempt can never overwrite what a newer attempt already recorded for
 * the same proof and candidate: evidence selection prefers the latest record, so the older
 * attempt is refused outright instead of being stored where it would win.
 */
export function staleCiAttemptRefusal(existing: readonly Evidence[], data: { proof: string; sha: string; baseSha: string; policyRevision: number; ciRun: { runId: string; runAttempt: number } }): string | null {
  const newest = existing.filter(item => item.ciRun && item.proof === data.proof && item.sha === data.sha && item.baseSha === data.baseSha && item.policyRevision === data.policyRevision)
    .map(item => item.ciRun!).sort(compareCiAttempts).at(-1);
  if (!newest) return null;
  const order = compareCiAttempts(data.ciRun, newest);
  if (order > 0) return null;
  return order === 0
    ? `Workflow run ${newest.runId} attempt ${newest.runAttempt} already recorded ${data.proof} for this candidate`
    : `Workflow run ${data.ciRun.runId} attempt ${data.ciRun.runAttempt} is older than the recorded run ${newest.runId} attempt ${newest.runAttempt} for ${data.proof}; an older attempt cannot overwrite a newer result`;
}
