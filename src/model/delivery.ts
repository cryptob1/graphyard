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
 * Done = merged (GY-1981): a done item with a delivery is delivered, whatever its smoke policy and
 * whether or not a release observation was ever recorded on it. Production health is one
 * release-level reading, not a per-item state; `deployment` and `smoke` on older deliveries are
 * history that still loads and decides nothing.
 */
export type DeliveryState = 'delivered';
export function deliveryState(work: Work): DeliveryState | null {
  return work.stage === 'done' && work.delivery ? 'delivered' : null;
}
