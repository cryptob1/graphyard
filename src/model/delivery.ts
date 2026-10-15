import type { Work } from './work.js';

export interface ReleaseDelivery { environment: string; policyRevision: number; releaseId: string; releaseRevision: number; generation: number; verifiedAt: string; interval: { from: string; to: string } }
/** What the running release served when Graphyard's coordinator observed it covering this merge. */
export interface DeploymentObservation {
  sha: string; mergeSha: string; source: 'endpoint' | 'github-deployment'; observedAt: string;
  /** Exact when the release serves the merge commit itself; otherwise a descendant that contains it. */
  covers: 'exact' | 'descendant';
  at: string; observer: string;
}
/** The latest trusted post-deployment smoke result bound to the observed deployed commit. */
export interface SmokeOutcome { evidenceId: string; result: 'pass' | 'fail'; sha: string; mergeSha: string; producer: string; at: string; executed: number; skipped: number; url?: string }
/**
 * The delivery snapshot. Merge facts are frozen at observation; the post-deployment facts are
 * appended once each is independently observed and never rewrite the merge.
 */
// `mergedAt` is GitHub's own merge timestamp, kept exactly as the provider reported it.
// `evidenceAsOf` is the repository-clock instant at which the authorizing snapshot's
// evidence applicability was judged, preserved because the provider merge timestamp
// alone cannot reproduce it once the two clocks disagree. For the same reason
// `repositoryClockOffsetMs` preserves the lower bound of the GitHub-to-repository clock
// offset measured at merge verification, and `mergedAtRepository` is the merge instant
// carried onto the repository clock with it: the earliest repository instant the merge
// can have happened at. Every repository-clock comparison - window membership, weekly
// bucketing, and intent-to-merge duration - reads those rather than re-deriving them,
// because a reader has no way to recover the offset later.
/** `children`: a split parent's delivery (GY-1126, src/decomposition.ts) is its children's merges; its own merge fields name the last of them. */
export interface Delivery { mergedAt: string; mergeSha: string; authorizationRevision: number; evidenceAsOf?: string; mergedAtRepository?: string; repositoryClockOffsetMs?: number; deployment?: DeploymentObservation; smoke?: SmokeOutcome; children?: { key: string; mergeSha: string; mergedAt: string }[] }

/** True when the policy asks for the post-deployment smoke proof. Older documents carry no flag. */
export const deploySmokeRequired = (policy: Work['policy']) => !!policy.deploySmoke;

/**
 * GY-1824: how far back the unattended verify-deployment reach goes for a delivery whose serving
 * release is not recorded on it yet. Beyond this window an unrecorded delivery stays with the
 * master's hand (`master verify-deployment GY-N`), so the first evaluation after this ships raises
 * the deliveries the loop could have recorded recently, never the whole delivery history at once.
 */
export const deploymentRecordCutoffMs = 7 * 86_400_000;

/**
 * A done, unclosed delivery the unattended verify-deployment path still owes its record: no release
 * observation is bound to it yet, and its merge is inside `deploymentRecordCutoffMs` of `now`. The
 * smoke policy decides what follows a record (the post-deployment smoke proof), never whether the
 * record is owed, so this holds for non-smoke policies too — the gap GY-1824 closes.
 */
export function deploymentUnrecorded(work: Work, now: number, cutoffMs = deploymentRecordCutoffMs): boolean {
  if (work.stage !== 'done' || work.closure || !work.delivery || work.delivery.deployment) return false;
  const mergedAt = Date.parse(work.delivery.mergedAt);
  return Number.isFinite(mergedAt) && now - mergedAt <= cutoffMs;
}

/**
 * Post-delivery state, derived from the delivery snapshot alone. `delivered` is the terminal state
 * for work whose policy asks for no smoke proof; the others describe the second confidence layer.
 */
export type DeliveryState = 'delivered' | 'awaiting-deployment' | 'awaiting-smoke' | 'smoke-passed' | 'delivered-with-failure';
export function deliveryState(work: Work): DeliveryState | null {
  if (work.stage !== 'done' || !work.delivery) return null;
  if (!deploySmokeRequired(work.policy)) return 'delivered';
  const { deployment, smoke } = work.delivery;
  if (!deployment) return 'awaiting-deployment';
  // A smoke result only counts for the deployed commit Graphyard recorded for this delivery.
  if (!smoke || smoke.sha !== deployment.sha || smoke.mergeSha !== work.delivery.mergeSha) return 'awaiting-smoke';
  return smoke.result === 'pass' ? 'smoke-passed' : 'delivered-with-failure';
}

/**
 * What an operator does about a failed smoke proof. Graphyard v0.1 does not roll anything back
 * itself: the guidance names the exact commits involved so the person or agent acting on it
 * cannot confuse the failing release with the one to restore.
 */
export function rollbackGuidance(work: Work, baseBranch = 'main'): string | null {
  if (deliveryState(work) !== 'delivered-with-failure') return null;
  const { mergeSha, deployment, smoke } = work.delivery!;
  const serving = deployment!.covers === 'exact' ? `merge commit ${mergeSha}` : `${deployment!.sha}, which contains merge commit ${mergeSha}`;
  return `${work.key} is delivered with a failed post-deployment smoke proof: the live deployment served ${serving} when ${smoke!.producer} reported ${smoke!.executed} executed, ${smoke!.skipped} skipped at ${smoke!.at}. `
    + `Roll the deployment back to the last release whose smoke proof passed, or revert ${mergeSha} on ${baseBranch} through a new work item so the revert is reviewed and merged under the same gates. `
    + `Do not backfill passing evidence for this delivery; the failure stays on record, and the fix or revert is a follow-up item with its own proof.`;
}

/** Time from merge to the smoke verdict, or to `now` while the verdict is still outstanding. */
export function postDeployMs(work: Work, now: number): number | null {
  const state = deliveryState(work);
  if (!state || state === 'delivered') return null;
  const end = state === 'smoke-passed' || state === 'delivered-with-failure' ? Date.parse(work.delivery!.smoke!.at) : now;
  const value = end - Date.parse(work.delivery!.mergedAt);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Time from the item's creation to the observed deployment covering its merge: PR-to-production latency. */
export function productionLatencyMs(work: Work): number | null {
  const observedAt = work.delivery?.deployment?.observedAt;
  if (work.stage !== 'done' || !observedAt) return null;
  const value = Date.parse(observedAt) - Date.parse(work.createdAt);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
